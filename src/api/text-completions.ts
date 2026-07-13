// Text-completions adapter (OpenAI-compatible `/v1/completions`).
//
// Used for llama-server's protocol='text' path. We prerender the branch
// to a single `prompt` string (see `core/text-templates.ts`), POST it to
// `/v1/completions`, and translate the streaming response into
// `ChatStreamChunk` so the rest of the pipeline (reducer, UI, error
// handling) stays identical to the chat-completions path.
//
// Response shape per OpenAI completion spec:
//   data: { id, choices: [{ text: "...", finish_reason: null | "stop", index: 0 }] }
// We lift `choices[i].text` into `choices[i].delta.content` so downstream
// reducers can keep their one shape.

import type { ConnectionProfile } from '../core/types'
import {
  logStreamDebug,
  type StreamDebugTrace,
  snapshotStreamDebugRequest,
  startStreamDebug,
} from '../lib/debug-streams'
import { errorFromUnknown } from '../lib/error'
import {
  type ApiKeyDispatchContext,
  buildHeaders,
  fetchWithApiKeyFallback,
  hasExplicitAuthHeaderOverride,
  readErrorResponseJson,
} from './client'
import { deferAdapterRequest } from './deferred-request'
import { normalizeError } from './errors'
import { decodeProviderJson, malformedJsonFrameReport, parseSSE } from './sse'
import type {
  CallOpts,
  ChatCompletionChunkWire,
  ChatCompletionResultWire,
  ChatStreamChunk,
} from './types'

interface TextCompletionsContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
}

export interface TextCompletionRequestWire {
  model: string
  prompt: string
  stream?: boolean
  [extra: string]: unknown
}

function textCompletionsUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  return `${base}/completions`
}

interface DispatchResult {
  response: Response
  debugTrace: StreamDebugTrace | null
}

function dispatch(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts,
): Promise<DispatchResult> {
  return dispatchSerialized(
    ctx,
    JSON.stringify(req),
    snapshotStreamDebugRequest(ctx.profile, req),
    opts,
  )
}

function dispatchSerialized(
  ctx: TextCompletionsContext,
  body: string,
  debugRequest: unknown,
  opts: CallOpts,
): Promise<DispatchResult> {
  const url = textCompletionsUrl(ctx.profile)
  let debugTrace: StreamDebugTrace | null = null
  const fetchOpts: { signal?: AbortSignal; timeoutMs?: number } = {}
  if (opts.signal) fetchOpts.signal = opts.signal
  if (opts.timeoutMs !== undefined) fetchOpts.timeoutMs = opts.timeoutMs
  const authCtx = hasExplicitAuthHeaderOverride(ctx.profile, opts.overrideHeaders, 'Authorization')
    ? { apiKey: ctx.apiKey }
    : ctx
  const fetched = fetchWithApiKeyFallback(
    authCtx,
    (apiKey) => {
      const headers = buildHeaders(ctx.profile, apiKey, {
        method: 'POST',
        ...(opts.overrideHeaders ? { overrideHeaders: opts.overrideHeaders } : {}),
      })
      if (debugRequest !== null) {
        debugTrace ??= startStreamDebug({
          adapter: 'text-completions',
          profile: ctx.profile,
          url,
          request: debugRequest,
          headers,
        })
      }
      return { url, init: { method: 'POST', headers, body } }
    },
    fetchOpts,
  )
  return finishDispatch(fetched, () => debugTrace)
}

async function finishDispatch(
  fetched: ReturnType<typeof fetchWithApiKeyFallback>,
  getDebugTrace: () => StreamDebugTrace | null,
): Promise<DispatchResult> {
  const { response } = await fetched
  return { response, debugTrace: getDebugTrace() }
}

async function requireSuccessfulDispatch(
  dispatched: Promise<DispatchResult>,
): Promise<DispatchResult> {
  const result = await dispatched
  const { response, debugTrace } = result
  if (!response.ok) {
    const errorBody = await readErrorResponseJson(response)
    throw normalizeError(errorBody, { midStream: false, httpStatus: response.status })
  }
  logStreamDebug(debugTrace, 'response.head', {
    status: response.status,
    contentType: response.headers.get('content-type'),
    generationId: response.headers.get('x-generation-id') ?? undefined,
  })
  return result
}

interface TextCompletionChoiceWire {
  index?: number
  text?: string
  finish_reason?: string | null
  [extra: string]: unknown
}

interface TextCompletionChunkWire {
  id?: string
  model?: string
  choices?: TextCompletionChoiceWire[]
  usage?: unknown
  [extra: string]: unknown
}

function liftTextToDelta(chunk: TextCompletionChunkWire): ChatCompletionChunkWire {
  const liftedChoices = (chunk.choices ?? []).map((c) => {
    const base: Record<string, unknown> = { index: c.index ?? 0 }
    if (typeof c.text === 'string') base.delta = { content: c.text }
    if (c.finish_reason !== undefined && c.finish_reason !== null) {
      base.finish_reason = c.finish_reason
    }
    return base
  })
  const { usage: _usage, choices: _choices, ...rest } = chunk
  return { ...rest, choices: liftedChoices }
}

function liftBufferedToChat(result: TextCompletionChunkWire): ChatCompletionResultWire {
  const liftedChoices = (result.choices ?? []).map((c) => {
    const base: Record<string, unknown> = { index: c.index ?? 0 }
    if (typeof c.text === 'string') base.message = { role: 'assistant', content: c.text }
    if (c.finish_reason !== undefined && c.finish_reason !== null) {
      base.finish_reason = c.finish_reason
    }
    return base
  })
  return { ...result, choices: liftedChoices } as ChatCompletionResultWire
}

export function textCompletions(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) => {
    if (request.stream !== true) {
      throw new Error(
        'textCompletions: request body must have stream:true — use textCompletionsOnce for non-streaming',
      )
    }
    return consumeTextCompletions(dispatch(ctx, request, opts), opts.signal)
  })
}

async function* consumeTextCompletions(
  dispatched: Promise<DispatchResult>,
  signal: AbortSignal | undefined,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  const { response, debugTrace } = await requireSuccessfulDispatch(dispatched)
  const generationId = response.headers.get('x-generation-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  if (!/text\/event-stream/i.test(contentType)) {
    const body = await decodeProviderJson<TextCompletionChunkWire>(response)
    logStreamDebug(debugTrace, 'buffered_result', body)
    const lifted = liftBufferedToChat(body)
    const chunk: ChatStreamChunk = generationId
      ? { type: 'buffered_result', result: lifted, generationId }
      : { type: 'buffered_result', result: lifted }
    yield chunk
    return
  }

  for await (const ev of parseSSE(response, signal ? { signal } : {})) {
    if (ev.kind === 'done') {
      yield { type: 'transport_terminal', evidence: 'done-sentinel' }
      continue
    }
    if (ev.kind === 'keepalive') {
      yield { type: 'keepalive', comment: ev.comment }
      continue
    }
    try {
      logStreamDebug(debugTrace, 'sse.raw', { event: ev.event, data: ev.data })
      const parsed = JSON.parse(ev.data) as TextCompletionChunkWire
      if (generationId && parsed.id === undefined) parsed.id = generationId
      logStreamDebug(debugTrace, 'sse.parsed', parsed)
      const lifted = liftTextToDelta(parsed)
      const chunk: ChatStreamChunk = generationId
        ? { type: 'delta', chunk: lifted, generationId }
        : { type: 'delta', chunk: lifted }
      yield chunk
    } catch (err) {
      const report = malformedJsonFrameReport({
        adapter: 'text-completions',
        eventType: ev.event,
        data: ev.data,
        error: err,
      })
      console.warn('textCompletions: malformed SSE chunk skipped', report.diagnostic)
      yield { type: 'integrity', integrity: report.integrity }
    }
  }
}

export function textCompletionsOnce(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts = {},
): Promise<ChatCompletionResultWire> {
  try {
    const body: TextCompletionRequestWire = { ...req, stream: false }
    return consumeTextCompletionsOnce(dispatch(ctx, body, opts))
  } catch (error) {
    return Promise.reject(errorFromUnknown(error))
  }
}

async function consumeTextCompletionsOnce(
  dispatched: Promise<DispatchResult>,
): Promise<ChatCompletionResultWire> {
  const { response, debugTrace } = await requireSuccessfulDispatch(dispatched)
  const result = await decodeProviderJson<TextCompletionChunkWire>(response)
  logStreamDebug(debugTrace, 'once.result', result)
  return liftBufferedToChat(result)
}

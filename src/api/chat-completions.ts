// Two entry points:
//
// - `chatCompletions()` is the streaming path. It yields `ChatStreamChunk`s —
//   one per SSE data event, plus `keepalive` for `: ...` comments, plus a
//   synthetic `buffered_result` when the upstream answers with JSON despite
//   `stream: true`. Malformed JSON in a data line is skipped and
//   logged, not fatal — streams should be resilient to single-chunk corruption.
// - `chatCompletionsOnce()` is the non-streaming path. It forces `stream: false`
//   and returns a single `ChatCompletionResultWire`.
//
// Headers are bound at dispatch time: changing the profile or key in another
// tab cannot mutate a request already in flight.

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
  ChatCompletionRequestWire,
  ChatCompletionResultWire,
  ChatStreamChunk,
} from './types'

export interface ChatCompletionsContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
}

function chatCompletionsUrl(profile: ConnectionProfile): string {
  const base = normalizedBaseUrl(profile)
  return `${base}/chat/completions`
}

function normalizedBaseUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  if (profile.kind === 'google' && !/\/openai$/i.test(base)) {
    return `${base}/openai`
  }
  return base
}

interface DispatchResult {
  response: Response
  debugTrace: StreamDebugTrace | null
}

function dispatch(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
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
  ctx: ChatCompletionsContext,
  body: string,
  debugRequest: unknown,
  opts: CallOpts,
): Promise<DispatchResult> {
  const url = chatCompletionsUrl(ctx.profile)
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
          adapter: 'chat-completions',
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
    throw normalizeError(errorBody, {
      midStream: false,
      httpStatus: response.status,
    })
  }
  logStreamDebug(debugTrace, 'response.head', {
    status: response.status,
    contentType: response.headers.get('content-type'),
    generationId: response.headers.get('x-generation-id') ?? undefined,
  })
  return result
}

export function chatCompletions(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) => {
    if (request.stream !== true) {
      throw new Error(
        'chatCompletions: request body must have stream:true — use chatCompletionsOnce for non-streaming',
      )
    }
    return consumeChatCompletions(dispatch(ctx, request, opts), opts.signal)
  })
}

async function* consumeChatCompletions(
  dispatched: Promise<DispatchResult>,
  signal: AbortSignal | undefined,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  const { response, debugTrace } = await requireSuccessfulDispatch(dispatched)
  const generationId = response.headers.get('x-generation-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  // Buffered fallback: the upstream (or a caching proxy) answered with
  // JSON even though SSE was requested. Normalize into a single terminal
  // chunk so the rest of the app can keep one consumer shape.
  if (!/text\/event-stream/i.test(contentType)) {
    const result = await decodeProviderJson<ChatCompletionResultWire>(response)
    logStreamDebug(debugTrace, 'buffered_result', result)
    const chunk: ChatStreamChunk = generationId
      ? { type: 'buffered_result', result, generationId }
      : { type: 'buffered_result', result }
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
      const parsed = JSON.parse(ev.data) as Record<string, unknown>
      if (generationId && parsed.id === undefined) parsed.id = generationId
      logStreamDebug(debugTrace, 'sse.parsed', parsed)
      const chunk: ChatStreamChunk = generationId
        ? { type: 'delta', chunk: parsed, generationId }
        : { type: 'delta', chunk: parsed }
      yield chunk
    } catch (err) {
      // Malformed SSE JSON — skip and log. Streams survive single-chunk
      // corruption; one bad frame is not a reason to abort the whole turn.
      const report = malformedJsonFrameReport({
        adapter: 'chat-completions',
        eventType: ev.event,
        data: ev.data,
        error: err,
      })
      console.warn('chatCompletions: malformed SSE chunk skipped', report.diagnostic)
      yield { type: 'integrity', integrity: report.integrity }
    }
  }
}

export function chatCompletionsOnce(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
  opts: CallOpts = {},
): Promise<ChatCompletionResultWire> {
  try {
    const body: ChatCompletionRequestWire = { ...req, stream: false }
    return consumeChatCompletionsOnce(dispatch(ctx, body, opts))
  } catch (error) {
    return Promise.reject(errorFromUnknown(error))
  }
}

async function consumeChatCompletionsOnce(
  dispatched: Promise<DispatchResult>,
): Promise<ChatCompletionResultWire> {
  const { response, debugTrace } = await requireSuccessfulDispatch(dispatched)
  const result = await decodeProviderJson<ChatCompletionResultWire>(response)
  logStreamDebug(debugTrace, 'once.result', result)
  return result
}

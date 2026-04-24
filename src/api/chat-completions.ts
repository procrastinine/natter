// Chat-completions adapter. See `plan/04-api-client.md §4.6`.
//
// Two entry points:
//
// - `chatCompletions()` is the streaming path. It yields `ChatStreamChunk`s —
//   one per SSE data event, plus `keepalive` for `: ...` comments, plus a
//   synthetic `buffered_result` when the upstream answers with JSON despite
//   `stream: true` (§4.6). Malformed JSON in a data line is skipped and
//   logged, not fatal — streams should be resilient to single-chunk corruption.
// - `chatCompletionsOnce()` is the non-streaming path. It forces `stream: false`
//   and returns a single `ChatCompletionResultWire`.
//
// Headers are bound at dispatch time (§4.2 in-flight stability): if the
// profile or key changes in another tab while a stream is in flight, the
// already-sent headers are not mutated.

import type { ConnectionProfile } from '../core/types'
import { logStreamDebug, startStreamDebug, type StreamDebugTrace } from '../lib/debug-streams'
import { buildHeaders, fetchWithTimeout } from './client'
import { normalizeError } from './errors'
import { parseSSE } from './sse'
import type {
  CallOpts,
  ChatCompletionRequestWire,
  ChatCompletionResultWire,
  ChatStreamChunk,
} from './types'

export interface ChatCompletionsContext {
  profile: ConnectionProfile
  apiKey: string
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

async function dispatch(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
  opts: CallOpts,
): Promise<{ response: Response; debugTrace: StreamDebugTrace | null }> {
  const url = chatCompletionsUrl(ctx.profile)
  const headers = buildHeaders(ctx.profile, ctx.apiKey, {
    method: 'POST',
    ...(opts.overrideHeaders ? { overrideHeaders: opts.overrideHeaders } : {}),
  })
  const debugTrace = startStreamDebug({
    adapter: 'chat-completions',
    profile: ctx.profile,
    url,
    request: req,
    headers,
  })
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  }
  const fetchOpts: { signal?: AbortSignal; timeoutMs?: number } = {}
  if (opts.signal) fetchOpts.signal = opts.signal
  if (opts.timeoutMs !== undefined) fetchOpts.timeoutMs = opts.timeoutMs
  const response = await fetchWithTimeout(url, init, fetchOpts)
  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: { code: response.status, message: response.statusText },
    }))
    throw normalizeError(body, {
      midStream: false,
      httpStatus: response.status,
    })
  }
  logStreamDebug(debugTrace, 'response.head', {
    status: response.status,
    contentType: response.headers.get('content-type'),
    generationId: response.headers.get('x-generation-id') ?? undefined,
  })
  return { response, debugTrace }
}

export async function* chatCompletions(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk> {
  if (req.stream !== true) {
    throw new Error(
      'chatCompletions: request body must have stream:true — use chatCompletionsOnce for non-streaming',
    )
  }
  const { response, debugTrace } = await dispatch(ctx, req, opts)
  const generationId = response.headers.get('x-generation-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  // Buffered fallback: the upstream (or a caching proxy) answered with
  // JSON even though we asked for SSE. Normalize into a single terminal
  // chunk so the rest of the app can keep one consumer shape.
  if (!/text\/event-stream/i.test(contentType)) {
    const result = (await response.json()) as ChatCompletionResultWire
    logStreamDebug(debugTrace, 'buffered_result', result)
    const chunk: ChatStreamChunk = generationId
      ? { type: 'buffered_result', result, generationId }
      : { type: 'buffered_result', result }
    yield chunk
    return
  }

  for await (const ev of parseSSE(response, opts.signal ? { signal: opts.signal } : {})) {
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
      console.warn('chatCompletions: malformed SSE chunk skipped', {
        data: ev.data,
        error: err,
      })
    }
  }
}

export async function chatCompletionsOnce(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
  opts: CallOpts = {},
): Promise<ChatCompletionResultWire> {
  const body: ChatCompletionRequestWire = { ...req, stream: false }
  const { response, debugTrace } = await dispatch(ctx, body, opts)
  const result = (await response.json()) as ChatCompletionResultWire
  logStreamDebug(debugTrace, 'once.result', result)
  return result
}

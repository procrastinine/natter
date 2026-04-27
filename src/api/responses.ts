// OpenAI Responses API adapter (+ OpenRouter `/responses` beta proxy).
// Structural twin of `chat-completions.ts`, differing in:
//
//   - URL construction (`/responses`)
//   - SSE event shape: instead of raw `data:` JSON frames with delta/message
//     choices, OpenAI emits `event: response.<type>\ndata: {…}` pairs keyed by
//     typed event names. The adapter parses those into `ResponsesEventWire` envelopes.
//   - Buffered fallback: like chat, the adapter handles a JSON response when
//     the server ignores `stream:true` (happens on some structured-output calls
//     through OpenRouter).
//
// Stream-consumer contract:
//   - `{type: 'event', event}` — one per SSE `data:` frame, typed.
//   - `{type: 'keepalive', comment}` — SSE `:` lines (hang detection).
//   - `{type: 'buffered_result', result}` — the server answered with a single
//     JSON body despite `stream:true`. The lane splitter turns this into a
//     `buffered` lane event, same as chat.
//
// Phase 11 reads this adapter from two paths:
//   1. The UI send pipeline, via the api-choice router.
//   2. Live integration tests that reuse captured SSE fixtures from
//      `plan/phase11-probes/`.

import type { ConnectionProfile } from '../core/types'
import { logStreamDebug, startStreamDebug, type StreamDebugTrace } from '../lib/debug-streams'
import { buildHeaders, fetchWithTimeout } from './client'
import { normalizeError } from './errors'
import { parseSSE } from './sse'
import type {
  CallOpts,
  ResponsesEventWire,
  ResponsesRequestWire,
  ResponsesResultWire,
  ResponsesStreamChunk,
} from './types'

export interface ResponsesContext {
  profile: ConnectionProfile
  apiKey: string
}

function responsesUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  return `${base}/responses`
}

async function dispatch(
  ctx: ResponsesContext,
  req: ResponsesRequestWire,
  opts: CallOpts,
): Promise<{ response: Response; debugTrace: StreamDebugTrace | null }> {
  const url = responsesUrl(ctx.profile)
  const headers = buildHeaders(ctx.profile, ctx.apiKey, {
    method: 'POST',
    ...(opts.overrideHeaders ? { overrideHeaders: opts.overrideHeaders } : {}),
  })
  const debugTrace = startStreamDebug({
    adapter: 'responses',
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

export async function* responses(
  ctx: ResponsesContext,
  req: ResponsesRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ResponsesStreamChunk> {
  if (req.stream !== true) {
    throw new Error(
      'responses: request body must have stream:true — use responsesOnce for non-streaming',
    )
  }
  const { response, debugTrace } = await dispatch(ctx, req, opts)
  const generationId = response.headers.get('x-generation-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  if (!/text\/event-stream/i.test(contentType)) {
    const result = (await response.json()) as ResponsesResultWire
    logStreamDebug(debugTrace, 'buffered_result', result)
    yield generationId
      ? { type: 'buffered_result', result, generationId }
      : { type: 'buffered_result', result }
    return
  }

  for await (const ev of parseSSE(response, opts.signal ? { signal: opts.signal } : {})) {
    if (ev.kind === 'keepalive') {
      yield { type: 'keepalive', comment: ev.comment }
      continue
    }
    try {
      logStreamDebug(debugTrace, 'sse.raw', { event: ev.event, data: ev.data })
      const raw = JSON.parse(ev.data) as Record<string, unknown>
      // Accept either the inline `type` field (canonical — OpenAI and
      // OpenRouter both include it) or the SSE `event:` name as a fallback.
      if (typeof raw.type !== 'string' && typeof ev.event === 'string') {
        raw.type = ev.event
      }
      logStreamDebug(debugTrace, 'sse.parsed', raw)
      yield generationId
        ? { type: 'event', event: raw as ResponsesEventWire, generationId }
        : { type: 'event', event: raw as ResponsesEventWire }
    } catch (err) {
      console.warn('responses: malformed SSE chunk skipped', {
        data: ev.data,
        error: err,
      })
    }
  }
}

export async function responsesOnce(
  ctx: ResponsesContext,
  req: ResponsesRequestWire,
  opts: CallOpts = {},
): Promise<ResponsesResultWire> {
  const body: ResponsesRequestWire = { ...req, stream: false }
  const { response, debugTrace } = await dispatch(ctx, body, opts)
  const result = (await response.json()) as ResponsesResultWire
  logStreamDebug(debugTrace, 'once.result', result)
  return result
}

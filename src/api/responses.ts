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
import { validateResponsesEvent, validateResponsesResult } from './provider-json-boundary'
import { decodeProviderStreamFrame, decodeValidatedProviderJson, parseSSE } from './sse'
import type {
  CallOpts,
  ResponsesRequestWire,
  ResponsesResultWire,
  ResponsesStreamChunk,
} from './types'

export interface ResponsesContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
}

function responsesUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  return `${base}/responses`
}

interface DispatchResult {
  response: Response
  debugTrace: StreamDebugTrace | null
}

function dispatch(
  ctx: ResponsesContext,
  req: ResponsesRequestWire,
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
  ctx: ResponsesContext,
  body: string,
  debugRequest: unknown,
  opts: CallOpts,
): Promise<DispatchResult> {
  const url = responsesUrl(ctx.profile)
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
          adapter: 'responses',
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

export function responses(
  ctx: ResponsesContext,
  req: ResponsesRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ResponsesStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) => {
    if (request.stream !== true) {
      throw new Error(
        'responses: request body must have stream:true — use responsesOnce for non-streaming',
      )
    }
    return consumeResponses(dispatch(ctx, request, opts), opts.signal)
  })
}

async function* consumeResponses(
  dispatched: Promise<DispatchResult>,
  signal: AbortSignal | undefined,
): AsyncGenerator<ResponsesStreamChunk, void, unknown> {
  const { response, debugTrace } = await requireSuccessfulDispatch(dispatched)
  const generationId = response.headers.get('x-generation-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  if (!/text\/event-stream/i.test(contentType)) {
    const result = await decodeValidatedProviderJson(response, validateResponsesResult)
    logStreamDebug(debugTrace, 'buffered_result', result)
    yield generationId
      ? { type: 'buffered_result', result, generationId }
      : { type: 'buffered_result', result }
    return
  }

  for await (const ev of parseSSE(response, signal ? { signal } : {})) {
    if (ev.kind === 'done') continue
    if (ev.kind === 'keepalive') {
      yield { type: 'keepalive', comment: ev.comment }
      continue
    }
    logStreamDebug(debugTrace, 'sse.raw', { event: ev.event, data: ev.data })
    const decoded = decodeProviderStreamFrame({
      adapter: 'responses',
      eventType: ev.event,
      data: ev.data,
      validate: validateResponsesEvent,
    })
    if (!decoded.ok) {
      console.warn('responses: invalid SSE frame skipped', decoded.diagnostic)
      yield { type: 'integrity', integrity: decoded.integrity }
      continue
    }
    logStreamDebug(debugTrace, 'sse.parsed', decoded.value)
    yield generationId
      ? { type: 'event', event: decoded.value, generationId }
      : { type: 'event', event: decoded.value }
  }
}

export function responsesOnce(
  ctx: ResponsesContext,
  req: ResponsesRequestWire,
  opts: CallOpts = {},
): Promise<ResponsesResultWire> {
  try {
    const body: ResponsesRequestWire = { ...req, stream: false }
    return consumeResponsesOnce(dispatch(ctx, body, opts))
  } catch (error) {
    return Promise.reject(errorFromUnknown(error))
  }
}

async function consumeResponsesOnce(
  dispatched: Promise<DispatchResult>,
): Promise<ResponsesResultWire> {
  const { response, debugTrace } = await requireSuccessfulDispatch(dispatched)
  const result = await decodeValidatedProviderJson(response, validateResponsesResult)
  logStreamDebug(debugTrace, 'once.result', result)
  return result
}

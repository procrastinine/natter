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
import { errorFromUnknown } from '../lib/error'
import {
  type ApiKeyDispatchContext,
  dispatchProviderJsonRequest,
  type ProviderDispatchResult,
} from './client'
import { deferAdapterRequest } from './deferred-request'
import { validateResponsesEvent, validateResponsesResult } from './provider-json-boundary'
import { consumeProviderOnce, consumeProviderStream } from './provider-stream-runtime'
import type {
  CallOpts,
  ResponsesEventWire,
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

function dispatch(
  ctx: ResponsesContext,
  req: ResponsesRequestWire,
  opts: CallOpts,
): Promise<ProviderDispatchResult> {
  return dispatchProviderJsonRequest({
    adapter: 'responses',
    context: ctx,
    url: responsesUrl(ctx.profile),
    request: req,
    opts,
    authHeaderName: 'Authorization',
  })
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

function consumeResponses(
  dispatched: Promise<ProviderDispatchResult>,
  signal: AbortSignal | undefined,
): AsyncGenerator<ResponsesStreamChunk, void, unknown> {
  return consumeProviderStream<ResponsesEventWire, ResponsesResultWire, ResponsesStreamChunk>({
    adapter: 'responses',
    dispatched,
    ...(signal ? { signal } : {}),
    generationId: (response) => response.headers.get('x-generation-id') ?? undefined,
    validateBuffered: validateResponsesResult,
    validateFrame: validateResponsesEvent,
    bufferedChunk: (result, generationId) =>
      generationId
        ? { type: 'buffered_result', result, generationId }
        : { type: 'buffered_result', result },
    frameChunk: (event, generationId) =>
      generationId ? { type: 'event', event, generationId } : { type: 'event', event },
    integrityChunk: (integrity) => ({ type: 'integrity', integrity }),
    keepaliveChunk: (comment) => ({ type: 'keepalive', comment }),
  })
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
  dispatched: Promise<ProviderDispatchResult>,
): Promise<ResponsesResultWire> {
  return consumeProviderOnce(dispatched, validateResponsesResult)
}

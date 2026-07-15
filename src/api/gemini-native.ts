// Dispatches to `{baseUrl}/models/{model}:streamGenerateContent?alt=sse`
// for streaming, `:generateContent` for buffered. Uses `x-goog-api-key`
// (NOT `Authorization: Bearer`).
//
// The stream is NDJSON-as-SSE when `?alt=sse`: each frame is a single JSON
// object carrying the same top-level shape as `:generateContent` (candidates,
// usageMetadata, modelVersion). We parse each data frame into a
// `GenerateContentResponseWire`.
//
// Phase 11 scope: text + tool-call + thought_signature round-trip. Attachments
// and full multi-modal come in Phase 12.

import type { ConnectionProfile } from '../core/types'
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
import type {
  GeminiStreamChunk,
  GenerateContentRequestWire,
  GenerateContentResponseWire,
} from './gemini-types'
import { validateGeminiResponse } from './provider-json-boundary'
import { decodeProviderStreamFrame, decodeValidatedProviderJson, parseSSE } from './sse'
import type { CallOpts } from './types'

export interface GeminiContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
}

// "models/{model}" is the Gemini URL pattern. Model ids sometimes arrive
// with a slug prefix ("google/gemini-3.1-flash-lite-preview") from
// OpenRouter-shaped settings; the prefix is stripped.
function normalizeModelId(raw: string): string {
  const slash = raw.indexOf('/')
  return slash >= 0 ? raw.slice(slash + 1) : raw
}

function geminiUrl(profile: ConnectionProfile, model: string, stream: boolean): string {
  const base = profile.baseUrl.replace(/\/+$/, '').replace(/\/openai$/u, '')
  const modelId = normalizeModelId(model)
  const method = stream ? ':streamGenerateContent?alt=sse' : ':generateContent'
  return `${base}/models/${modelId}${method}`
}

function dispatch(
  ctx: GeminiContext,
  req: GenerateContentRequestWire,
  modelId: string,
  stream: boolean,
  opts: CallOpts,
): Promise<Response> {
  return dispatchSerialized(ctx, JSON.stringify(req), modelId, stream, opts)
}

function dispatchSerialized(
  ctx: GeminiContext,
  body: string,
  modelId: string,
  stream: boolean,
  opts: CallOpts,
): Promise<Response> {
  const url = geminiUrl(ctx.profile, modelId, stream)
  const fetchOpts: { signal?: AbortSignal; timeoutMs?: number } = {}
  if (opts.signal) fetchOpts.signal = opts.signal
  if (opts.timeoutMs !== undefined) fetchOpts.timeoutMs = opts.timeoutMs
  const authCtx = hasExplicitAuthHeaderOverride(ctx.profile, opts.overrideHeaders, 'x-goog-api-key')
    ? { apiKey: ctx.apiKey }
    : ctx
  const fetched = fetchWithApiKeyFallback(
    authCtx,
    (apiKey) => {
      const headers = buildHeaders(ctx.profile, apiKey, {
        method: 'POST',
        authScheme: 'gemini-native',
        ...(opts.overrideHeaders ? { overrideHeaders: opts.overrideHeaders } : {}),
      })
      return { url, init: { method: 'POST', headers, body } }
    },
    fetchOpts,
  )
  return requireSuccessfulResponse(fetched)
}

async function requireSuccessfulResponse(
  fetched: ReturnType<typeof fetchWithApiKeyFallback>,
): Promise<Response> {
  const { response } = await fetched
  if (!response.ok) {
    const errorBody = await readErrorResponseJson(response)
    throw normalizeError(errorBody, { midStream: false, httpStatus: response.status })
  }
  return response
}

export function geminiStream(
  ctx: GeminiContext,
  req: GenerateContentRequestWire,
  modelId: string,
  opts: CallOpts = {},
): AsyncGenerator<GeminiStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) =>
    consumeGeminiStream(dispatch(ctx, request, modelId, true, opts), opts.signal),
  )
}

async function* consumeGeminiStream(
  dispatched: Promise<Response>,
  signal: AbortSignal | undefined,
): AsyncGenerator<GeminiStreamChunk, void, unknown> {
  const response = await dispatched
  const generationId = response.headers.get('x-request-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  // Buffered fallback — if the server answers with a single JSON object
  // despite `?alt=sse`, yield a buffered_result chunk so downstream code
  // can unify the consumer path.
  if (!/text\/event-stream/i.test(contentType)) {
    const result = await decodeValidatedProviderJson(response, validateGeminiResponse)
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
    const decoded = decodeProviderStreamFrame({
      adapter: 'gemini-native',
      eventType: ev.event,
      data: ev.data,
      validate: validateGeminiResponse,
    })
    if (!decoded.ok) {
      console.warn('geminiStream: invalid SSE frame skipped', decoded.diagnostic)
      yield { type: 'integrity', integrity: decoded.integrity }
      continue
    }
    yield generationId
      ? { type: 'chunk', chunk: decoded.value, generationId }
      : { type: 'chunk', chunk: decoded.value }
  }
}

export function geminiOnce(
  ctx: GeminiContext,
  req: GenerateContentRequestWire,
  modelId: string,
  opts: CallOpts = {},
): Promise<GenerateContentResponseWire> {
  try {
    return consumeGeminiOnce(dispatch(ctx, req, modelId, false, opts))
  } catch (error) {
    return Promise.reject(errorFromUnknown(error))
  }
}

async function consumeGeminiOnce(
  dispatched: Promise<Response>,
): Promise<GenerateContentResponseWire> {
  const response = await dispatched
  return decodeValidatedProviderJson(response, validateGeminiResponse)
}

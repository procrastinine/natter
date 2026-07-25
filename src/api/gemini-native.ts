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
  dispatchProviderJsonRequest,
  type ProviderDispatchResult,
} from './client'
import { deferAdapterRequest } from './deferred-request'
import type {
  GeminiStreamChunk,
  GenerateContentRequestWire,
  GenerateContentResponseWire,
} from './gemini-types'
import { validateGeminiResponse } from './provider-json-boundary'
import { consumeProviderOnce, consumeProviderStream } from './provider-stream-runtime'
import type { CallOpts } from './types'

export interface GeminiContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
}

// "models/{model}" is the Gemini URL pattern. Model ids sometimes arrive
// with a provider slug prefix (for example, "google/gemini-3.5-flash") from
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
): Promise<ProviderDispatchResult> {
  return dispatchProviderJsonRequest({
    adapter: 'gemini-native',
    context: ctx,
    url: geminiUrl(ctx.profile, modelId, stream),
    request: req,
    opts,
    authHeaderName: 'x-goog-api-key',
    authScheme: 'gemini-native',
  })
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

function consumeGeminiStream(
  dispatched: Promise<ProviderDispatchResult>,
  signal: AbortSignal | undefined,
): AsyncGenerator<GeminiStreamChunk, void, unknown> {
  return consumeProviderStream<
    GenerateContentResponseWire,
    GenerateContentResponseWire,
    GeminiStreamChunk
  >({
    adapter: 'gemini-native',
    dispatched,
    ...(signal ? { signal } : {}),
    generationId: (response) => response.headers.get('x-request-id') ?? undefined,
    validateBuffered: validateGeminiResponse,
    validateFrame: validateGeminiResponse,
    bufferedChunk: (result, generationId) =>
      generationId
        ? { type: 'buffered_result', result, generationId }
        : { type: 'buffered_result', result },
    frameChunk: (chunk, generationId) =>
      generationId ? { type: 'chunk', chunk, generationId } : { type: 'chunk', chunk },
    integrityChunk: (integrity) => ({ type: 'integrity', integrity }),
    keepaliveChunk: (comment) => ({ type: 'keepalive', comment }),
  })
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
  dispatched: Promise<ProviderDispatchResult>,
): Promise<GenerateContentResponseWire> {
  return consumeProviderOnce(dispatched, validateGeminiResponse)
}

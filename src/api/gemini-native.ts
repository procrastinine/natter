// Google Gemini native API adapter. See `plan/phase11-implementation.md §4.4`
// and `gemini_docs/guides/`.
//
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
import { buildHeaders, fetchWithTimeout } from './client'
import { normalizeError } from './errors'
import type {
  GeminiStreamChunk,
  GenerateContentRequestWire,
  GenerateContentResponseWire,
} from './gemini-types'
import { parseSSE } from './sse'
import type { CallOpts } from './types'

export interface GeminiContext {
  profile: ConnectionProfile
  apiKey: string
}

// "models/{model}" is the Gemini URL pattern. Model ids sometimes arrive
// with a slug prefix ("google/gemini-3.1-flash-lite-preview") from
// OpenRouter-shaped settings; we strip it.
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

async function dispatch(
  ctx: GeminiContext,
  req: GenerateContentRequestWire,
  modelId: string,
  stream: boolean,
  opts: CallOpts,
): Promise<Response> {
  const url = geminiUrl(ctx.profile, modelId, stream)
  const headers = buildHeaders(ctx.profile, ctx.apiKey, {
    method: 'POST',
    authScheme: 'gemini-native',
    ...(opts.overrideHeaders ? { overrideHeaders: opts.overrideHeaders } : {}),
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
    throw normalizeError(body, { midStream: false, httpStatus: response.status })
  }
  return response
}

export async function* geminiStream(
  ctx: GeminiContext,
  req: GenerateContentRequestWire,
  modelId: string,
  opts: CallOpts = {},
): AsyncGenerator<GeminiStreamChunk> {
  const response = await dispatch(ctx, req, modelId, true, opts)
  const generationId = response.headers.get('x-request-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  // Buffered fallback — if the server answers with a single JSON object
  // despite `?alt=sse`, yield a buffered_result chunk so downstream code
  // can unify the consumer path.
  if (!/text\/event-stream/i.test(contentType)) {
    const result = (await response.json()) as GenerateContentResponseWire
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
      const parsed = JSON.parse(ev.data) as GenerateContentResponseWire
      yield generationId
        ? { type: 'chunk', chunk: parsed, generationId }
        : { type: 'chunk', chunk: parsed }
    } catch (err) {
      console.warn('geminiStream: malformed SSE chunk skipped', {
        data: ev.data,
        error: err,
      })
    }
  }
}

export async function geminiOnce(
  ctx: GeminiContext,
  req: GenerateContentRequestWire,
  modelId: string,
  opts: CallOpts = {},
): Promise<GenerateContentResponseWire> {
  const response = await dispatch(ctx, req, modelId, false, opts)
  return (await response.json()) as GenerateContentResponseWire
}

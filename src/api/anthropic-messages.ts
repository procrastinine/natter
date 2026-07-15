// Anthropic Messages API adapter.

import type { ConnectionProfile } from '../core/types'
import { errorFromUnknown } from '../lib/error'
import type {
  AnthropicMessagesRequestWire,
  AnthropicMessagesResultWire,
  AnthropicStreamChunk,
} from './anthropic-types'
import {
  type ApiKeyDispatchContext,
  buildHeaders,
  fetchWithApiKeyFallback,
  hasExplicitAuthHeaderOverride,
  readErrorResponseJson,
} from './client'
import { deferAdapterRequest } from './deferred-request'
import { normalizeError } from './errors'
import { validateAnthropicEvent, validateAnthropicResult } from './provider-json-boundary'
import { decodeProviderStreamFrame, decodeValidatedProviderJson, parseSSE } from './sse'
import type { CallOpts } from './types'

export interface AnthropicContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
}

function anthropicUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/u, '')
  return base.endsWith('/messages') ? base : `${base}/messages`
}

function betaHeaderForRequest(req: AnthropicMessagesRequestWire): string | undefined {
  const betas = new Set<string>()
  for (const tool of req.tools ?? []) {
    if (!tool || typeof tool !== 'object') continue
    const type = (tool as { type?: unknown }).type
    if (type === 'code_execution_20250825') betas.add('code-execution-2025-08-25')
    if (type === 'advisor_20260301') betas.add('advisor-tool-2026-03-01')
    if (type === 'web_fetch_20250910') betas.add('web-fetch-2025-09-10')
  }
  return betas.size > 0 ? [...betas].join(',') : undefined
}

function dispatch(
  ctx: AnthropicContext,
  req: AnthropicMessagesRequestWire,
  stream: boolean,
  opts: CallOpts,
): Promise<Response> {
  const body: AnthropicMessagesRequestWire = { ...req, stream }
  return dispatchSerialized(ctx, JSON.stringify(body), betaHeaderForRequest(req), opts)
}

function dispatchSerialized(
  ctx: AnthropicContext,
  serializedBody: string,
  betaHeader: string | undefined,
  opts: CallOpts,
): Promise<Response> {
  const url = anthropicUrl(ctx.profile)
  const authCtx = hasExplicitAuthHeaderOverride(ctx.profile, opts.overrideHeaders, 'x-api-key')
    ? { apiKey: ctx.apiKey }
    : ctx
  const fetched = fetchWithApiKeyFallback(
    authCtx,
    (apiKey) => {
      const headers = buildHeaders(ctx.profile, apiKey, {
        method: 'POST',
        authScheme: 'anthropic-native',
        overrideHeaders: {
          'anthropic-version': '2023-06-01',
          ...(betaHeader ? { 'anthropic-beta': betaHeader } : {}),
          ...(opts.overrideHeaders ?? {}),
        },
      })
      return { url, init: { method: 'POST', headers, body: serializedBody } }
    },
    {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
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

export function anthropicStream(
  ctx: AnthropicContext,
  req: AnthropicMessagesRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<AnthropicStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) =>
    consumeAnthropicStream(dispatch(ctx, request, true, opts), opts.signal),
  )
}

async function* consumeAnthropicStream(
  dispatched: Promise<Response>,
  signal: AbortSignal | undefined,
): AsyncGenerator<AnthropicStreamChunk, void, unknown> {
  const response = await dispatched
  const generationId = response.headers.get('anthropic-request-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  if (!/text\/event-stream/i.test(contentType)) {
    const result = await decodeValidatedProviderJson(response, validateAnthropicResult)
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
      adapter: 'anthropic-messages',
      eventType: ev.event,
      data: ev.data,
      validate: validateAnthropicEvent,
    })
    if (!decoded.ok) {
      console.warn('anthropicStream: invalid SSE frame skipped', decoded.diagnostic)
      yield { type: 'integrity', integrity: decoded.integrity }
      continue
    }
    yield generationId
      ? { type: 'anthropic_event', event: decoded.value, generationId }
      : { type: 'anthropic_event', event: decoded.value }
  }
}

export function anthropicOnce(
  ctx: AnthropicContext,
  req: AnthropicMessagesRequestWire,
  opts: CallOpts = {},
): Promise<AnthropicMessagesResultWire> {
  try {
    return consumeAnthropicOnce(dispatch(ctx, req, false, opts))
  } catch (error) {
    return Promise.reject(errorFromUnknown(error))
  }
}

async function consumeAnthropicOnce(
  dispatched: Promise<Response>,
): Promise<AnthropicMessagesResultWire> {
  const response = await dispatched
  return decodeValidatedProviderJson(response, validateAnthropicResult)
}

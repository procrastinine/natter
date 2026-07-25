// Anthropic Messages API adapter.

import type { ConnectionProfile } from '../core/types'
import { errorFromUnknown } from '../lib/error'
import type {
  AnthropicEventWire,
  AnthropicMessagesRequestWire,
  AnthropicMessagesResultWire,
  AnthropicStreamChunk,
} from './anthropic-types'
import {
  type ApiKeyDispatchContext,
  dispatchProviderJsonRequest,
  type ProviderDispatchResult,
} from './client'
import { deferAdapterRequest } from './deferred-request'
import { validateAnthropicEvent, validateAnthropicResult } from './provider-json-boundary'
import { consumeProviderOnce, consumeProviderStream } from './provider-stream-runtime'
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
): Promise<ProviderDispatchResult> {
  const request: AnthropicMessagesRequestWire = { ...req, stream }
  const betaHeader = betaHeaderForRequest(req)
  return dispatchProviderJsonRequest({
    adapter: 'anthropic-messages',
    context: ctx,
    url: anthropicUrl(ctx.profile),
    request,
    opts,
    authHeaderName: 'x-api-key',
    authScheme: 'anthropic-native',
    fixedHeaders: {
      'anthropic-version': '2023-06-01',
      ...(betaHeader ? { 'anthropic-beta': betaHeader } : {}),
    },
  })
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

function consumeAnthropicStream(
  dispatched: Promise<ProviderDispatchResult>,
  signal: AbortSignal | undefined,
): AsyncGenerator<AnthropicStreamChunk, void, unknown> {
  return consumeProviderStream<
    AnthropicEventWire,
    AnthropicMessagesResultWire,
    AnthropicStreamChunk
  >({
    adapter: 'anthropic-messages',
    dispatched,
    ...(signal ? { signal } : {}),
    generationId: (response) => response.headers.get('anthropic-request-id') ?? undefined,
    validateBuffered: validateAnthropicResult,
    validateFrame: validateAnthropicEvent,
    bufferedChunk: (result, generationId) =>
      generationId
        ? { type: 'buffered_result', result, generationId }
        : { type: 'buffered_result', result },
    frameChunk: (event, generationId) =>
      generationId
        ? { type: 'anthropic_event', event, generationId }
        : { type: 'anthropic_event', event },
    integrityChunk: (integrity) => ({ type: 'integrity', integrity }),
    keepaliveChunk: (comment) => ({ type: 'keepalive', comment }),
  })
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
  dispatched: Promise<ProviderDispatchResult>,
): Promise<AnthropicMessagesResultWire> {
  return consumeProviderOnce(dispatched, validateAnthropicResult)
}

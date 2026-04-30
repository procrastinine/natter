// Anthropic Messages API adapter.

import type { ConnectionProfile } from '../core/types'
import { buildHeaders, fetchWithTimeout } from './client'
import { normalizeError } from './errors'
import { parseSSE } from './sse'
import type {
  AnthropicMessagesRequestWire,
  AnthropicMessagesResultWire,
  AnthropicStreamChunk,
} from './anthropic-types'
import type { CallOpts } from './types'

export interface AnthropicContext {
  profile: ConnectionProfile
  apiKey: string
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

async function dispatch(
  ctx: AnthropicContext,
  req: AnthropicMessagesRequestWire,
  stream: boolean,
  opts: CallOpts,
): Promise<Response> {
  const headers = buildHeaders(ctx.profile, ctx.apiKey, {
    method: 'POST',
    authScheme: 'anthropic-native',
    overrideHeaders: {
      'anthropic-version': '2023-06-01',
      ...(betaHeaderForRequest(req) ? { 'anthropic-beta': betaHeaderForRequest(req) as string } : {}),
      ...(opts.overrideHeaders ?? {}),
    },
  })
  const body: AnthropicMessagesRequestWire = { ...req, stream }
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }
  const response = await fetchWithTimeout(anthropicUrl(ctx.profile), init, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: { type: String(response.status), message: response.statusText },
    }))
    throw normalizeError(body, { midStream: false, httpStatus: response.status })
  }
  return response
}

export async function* anthropicStream(
  ctx: AnthropicContext,
  req: AnthropicMessagesRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<AnthropicStreamChunk> {
  const response = await dispatch(ctx, req, true, opts)
  const generationId = response.headers.get('anthropic-request-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  if (!/text\/event-stream/i.test(contentType)) {
    const result = (await response.json()) as AnthropicMessagesResultWire
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
      const parsed = JSON.parse(ev.data) as AnthropicStreamChunk extends {
        type: 'anthropic_event'
        event: infer E
      }
        ? E
        : never
      yield generationId
        ? { type: 'anthropic_event', event: parsed, generationId }
        : { type: 'anthropic_event', event: parsed }
    } catch (err) {
      console.warn('anthropicStream: malformed SSE chunk skipped', {
        data: ev.data,
        error: err,
      })
    }
  }
}

export async function anthropicOnce(
  ctx: AnthropicContext,
  req: AnthropicMessagesRequestWire,
  opts: CallOpts = {},
): Promise<AnthropicMessagesResultWire> {
  const response = await dispatch(ctx, req, false, opts)
  return (await response.json()) as AnthropicMessagesResultWire
}

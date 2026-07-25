// OpenRouter returns full capability data (supported_parameters, pricing,
// caps, uptime/latency/throughput). Non-OpenRouter providers expose at most
// a bare model list via `GET /v1/models`; capability data for those comes
// from bundled tables (see `src/capabilities/`). Custom connections get a
// permissive default. Per user directive, every control is enabled so the
// user can try whatever the endpoint actually accepts.
//
// Fetchers here are environment-neutral (no Dexie, no React). Hooks layer
// in caching + reactivity.

import type { ConnectionHttpProfile } from '../core/types'
import { buildHeaders, fetchWithTimeout, readErrorResponseJson, readResponseJson } from './client'
import { normalizeError } from './errors'

interface DiscoveryContext {
  profile: ConnectionHttpProfile
  apiKey: string
}

function modelsUrl(profile: ConnectionHttpProfile, query: ModelsQueryString): string {
  const base = normalizedBaseUrl(profile)
  const search = stringifyQuery(query)
  return search ? `${base}/models?${search}` : `${base}/models`
}

function endpointsUrl(profile: ConnectionHttpProfile, modelId: string): string {
  const base = normalizedBaseUrl(profile)
  return `${base}/models/${modelId}/endpoints`
}

function normalizedBaseUrl(profile: ConnectionHttpProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  if (profile.kind === 'google' && !/\/openai$/i.test(base)) {
    return `${base}/openai`
  }
  return base
}

export interface ModelsQueryString {
  output_modalities?: string
  supported_parameters?: string
}

function stringifyQuery(q: ModelsQueryString): string {
  const parts: string[] = []
  if (q.output_modalities)
    parts.push(`output_modalities=${encodeURIComponent(q.output_modalities)}`)
  if (q.supported_parameters)
    parts.push(`supported_parameters=${encodeURIComponent(q.supported_parameters)}`)
  return parts.join('&')
}

async function fetchJson(
  url: string,
  ctx: DiscoveryContext,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  const headers = buildHeaders(ctx.profile, ctx.apiKey, {
    method: 'GET',
    ...(ctx.profile.kind === 'anthropic'
      ? {
          authScheme: 'anthropic-native' as const,
          overrideHeaders: { 'anthropic-version': '2023-06-01' },
        }
      : {}),
  })
  const init: RequestInit = { method: 'GET', headers }
  const response = await fetchWithTimeout(url, init, opts)
  if (!response.ok) {
    const body = await readErrorResponseJson(response)
    throw normalizeError(body, {
      midStream: false,
      httpStatus: response.status,
    })
  }
  return readResponseJson<unknown>(response)
}

export async function fetchModels(
  ctx: DiscoveryContext,
  query: ModelsQueryString = {},
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  return fetchJson(modelsUrl(ctx.profile, query), ctx, opts)
}

export async function fetchEndpoints(
  ctx: DiscoveryContext,
  modelId: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  return fetchJson(endpointsUrl(ctx.profile, modelId), ctx, opts)
}

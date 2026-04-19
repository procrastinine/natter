// /models + /endpoints fetchers. See `plan/04-api-client.md §4.6` (for the
// header/fetch pattern) and `plan/07-discovery.md §7.2–§7.4`.
//
// OpenRouter returns full capability data (supported_parameters, pricing,
// caps, uptime/latency/throughput). Non-OpenRouter providers expose at most
// a bare model list via `GET /v1/models`; capability data for those comes
// from bundled tables (see `src/capabilities/`). Custom connections get a
// permissive default — the user asked us to enable every control so they
// can try whatever the endpoint actually accepts.
//
// Fetchers here are environment-neutral (no Dexie, no React). Hooks layer
// in caching + reactivity.

import type { ConnectionProfile } from '../core/types'
import { buildHeaders, fetchWithTimeout } from './client'
import { normalizeError } from './errors'

export interface DiscoveryContext {
  profile: ConnectionProfile
  apiKey: string
}

function modelsUrl(profile: ConnectionProfile, query: ModelsQueryString): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  const search = stringifyQuery(query)
  return search ? `${base}/models?${search}` : `${base}/models`
}

function endpointsUrl(profile: ConnectionProfile, modelId: string): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  return `${base}/models/${modelId}/endpoints`
}

function providersUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  return `${base}/providers`
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
  const headers = buildHeaders(ctx.profile, ctx.apiKey, { method: 'GET' })
  const init: RequestInit = { method: 'GET', headers }
  const response = await fetchWithTimeout(url, init, opts)
  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: { code: response.status, message: response.statusText },
    }))
    throw normalizeError(body, {
      midStream: false,
      httpStatus: response.status,
    })
  }
  return response.json()
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

export async function fetchProviders(
  ctx: DiscoveryContext,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<unknown> {
  return fetchJson(providersUrl(ctx.profile), ctx, opts)
}

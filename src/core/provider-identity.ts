import type { ModelEndpoint } from './types'

function cleanRef(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function normalizeRef(value: string): string {
  return value.trim().toLowerCase()
}

function unique(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const cleaned = cleanRef(value ?? undefined)
    if (!cleaned) continue
    const key = normalizeRef(cleaned)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
  }
  return out
}

function uniqueExact(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const cleaned = cleanRef(value ?? undefined)
    if (!cleaned || seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
  }
  return out
}

export function providerDisplayName(endpoint: ModelEndpoint): string {
  return cleanRef(endpoint.provider_display_name) ?? endpoint.provider_name
}

export function providerRoutingRef(endpoint: ModelEndpoint): string {
  return cleanRef(endpoint.provider_slug) ?? endpoint.provider_name
}

export function providerEndpointKey(endpoint: ModelEndpoint): string {
  return (
    cleanRef(endpoint.provider_slug) ??
    cleanRef(endpoint.id) ??
    cleanRef(endpoint.provider_model_id) ??
    endpoint.provider_name
  )
}

export function providerRefCandidates(endpoint: ModelEndpoint): string[] {
  return unique([
    endpoint.provider_slug,
    endpoint.provider_name,
    endpoint.provider_display_name,
    endpoint.provider_model_id,
    endpoint.id,
  ])
}

export function endpointMatchesAnyProviderRef(
  endpoint: ModelEndpoint,
  refs: readonly string[] | undefined,
  allEndpoints: readonly ModelEndpoint[] = [],
): boolean {
  if (!refs || refs.length === 0) return false
  return refs.some((ref) => endpointMatchesProviderRef(endpoint, ref, allEndpoints))
}

export function endpointMatchesProviderRef(
  endpoint: ModelEndpoint,
  ref: string,
  allEndpoints: readonly ModelEndpoint[] = [],
): boolean {
  const cleaned = cleanRef(ref)
  if (!cleaned) return false
  const exactSlugExists = allEndpoints.some((candidate) => candidate.provider_slug === cleaned)
  if (exactSlugExists) return endpoint.provider_slug === cleaned
  const target = normalizeRef(cleaned)
  return providerRefCandidates(endpoint).some((candidate) => normalizeRef(candidate) === target)
}

export function providerPolicyLookupKeys(endpoint: ModelEndpoint): string[] {
  const baseDisplay = providerDisplayName(endpoint)
  const slugSuffix = endpoint.provider_slug?.split('/').at(1)
  const numberedDisplay =
    slugSuffix && /^\d+$/.test(slugSuffix) ? `${baseDisplay} ${slugSuffix}` : null
  return uniqueExact([
    endpoint.provider_slug,
    numberedDisplay,
    endpoint.provider_display_name,
    endpoint.provider_name,
    endpoint.provider_model_id,
    endpoint.id,
  ])
}

export function resolveProviderRefsToRoutingRefs(
  endpoints: readonly ModelEndpoint[],
  refs: readonly string[] | undefined,
  opts: { preserveUnknown?: boolean } = {},
): string[] {
  if (!refs || refs.length === 0) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const ref of refs) {
    const cleaned = cleanRef(ref)
    const exactSlugHits = cleaned
      ? endpoints.filter((endpoint) => endpoint.provider_slug === cleaned)
      : []
    const hits =
      exactSlugHits.length > 0
        ? exactSlugHits
        : endpoints.filter((endpoint) => endpointMatchesProviderRef(endpoint, ref, endpoints))
    if (hits.length === 0) {
      const cleaned = cleanRef(ref)
      if (opts.preserveUnknown && cleaned) pushUnique(out, seen, cleaned)
      continue
    }
    for (const endpoint of hits) pushUnique(out, seen, providerRoutingRef(endpoint))
  }
  return out
}

export function providerDisplayLabel(
  endpoint: ModelEndpoint,
  allEndpoints: readonly ModelEndpoint[] = [],
): string {
  const display = providerDisplayName(endpoint)
  const key = providerEndpointKey(endpoint)
  const duplicateDisplay =
    allEndpoints.filter((other) => providerDisplayName(other) === display).length > 1
  return duplicateDisplay && key !== display ? `${display} (${key})` : display
}

function pushUnique(out: string[], seen: Set<string>, value: string): void {
  const key = normalizeRef(value)
  if (seen.has(key)) return
  seen.add(key)
  out.push(value)
}

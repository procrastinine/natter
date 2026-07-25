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

export class ProviderEndpointIndex {
  readonly endpoints: readonly ModelEndpoint[]
  private readonly exactSlug = new Map<string, ModelEndpoint[]>()
  private readonly normalizedCandidate = new Map<string, ModelEndpoint[]>()
  private readonly displayCounts = new Map<string, number>()

  constructor(endpoints: readonly ModelEndpoint[], visit?: (endpoint: ModelEndpoint) => void) {
    this.endpoints = endpoints
    for (const endpoint of endpoints) {
      visit?.(endpoint)
      const slug = cleanRef(endpoint.provider_slug)
      if (slug) appendEndpoint(this.exactSlug, slug, endpoint)
      for (const candidate of providerRefCandidates(endpoint)) {
        appendEndpoint(this.normalizedCandidate, normalizeRef(candidate), endpoint)
      }
      const display = providerDisplayName(endpoint)
      this.displayCounts.set(display, (this.displayCounts.get(display) ?? 0) + 1)
    }
  }

  matches(endpoint: ModelEndpoint, ref: string): boolean {
    const cleaned = cleanRef(ref)
    if (!cleaned) return false
    if (this.exactSlug.has(cleaned)) return endpoint.provider_slug === cleaned
    const target = normalizeRef(cleaned)
    return providerRefCandidates(endpoint).some((candidate) => normalizeRef(candidate) === target)
  }

  endpointsForRefs(refs: readonly string[] | undefined): ReadonlySet<ModelEndpoint> {
    const matched = new Set<ModelEndpoint>()
    for (const ref of refs ?? []) {
      for (const endpoint of this.endpointsForRef(ref)) matched.add(endpoint)
    }
    return matched
  }

  resolveRoutingRefs(
    refs: readonly string[] | undefined,
    opts: { preserveUnknown?: boolean } = {},
  ): string[] {
    if (!refs || refs.length === 0) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const ref of refs) {
      const hits = this.endpointsForRef(ref)
      if (hits.length === 0) {
        const cleaned = cleanRef(ref)
        if (opts.preserveUnknown && cleaned) pushUnique(out, seen, cleaned)
        continue
      }
      for (const endpoint of hits) pushUnique(out, seen, providerRoutingRef(endpoint))
    }
    return out
  }

  displayLabel(endpoint: ModelEndpoint): string {
    const display = providerDisplayName(endpoint)
    const key = providerEndpointKey(endpoint)
    return (this.displayCounts.get(display) ?? 0) > 1 && key !== display
      ? `${display} (${key})`
      : display
  }

  orderByRefs(refs: readonly string[] | undefined): ModelEndpoint[] {
    const out: ModelEndpoint[] = []
    const seen = new Set<string>()
    for (const ref of refs ?? []) {
      for (const endpoint of this.endpointsForRef(ref)) {
        const key = providerEndpointKey(endpoint)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(endpoint)
      }
    }
    for (const endpoint of this.endpoints) {
      if (!seen.has(providerEndpointKey(endpoint))) out.push(endpoint)
    }
    return out
  }

  private endpointsForRef(ref: string): readonly ModelEndpoint[] {
    const cleaned = cleanRef(ref)
    if (!cleaned) return []
    return this.exactSlug.get(cleaned) ?? this.normalizedCandidate.get(normalizeRef(cleaned)) ?? []
  }
}

function appendEndpoint(
  index: Map<string, ModelEndpoint[]>,
  key: string,
  endpoint: ModelEndpoint,
): void {
  const rows = index.get(key)
  if (rows) rows.push(endpoint)
  else index.set(key, [endpoint])
}

function endpointIndex(
  endpoints: readonly ModelEndpoint[] | ProviderEndpointIndex,
): ProviderEndpointIndex {
  return endpoints instanceof ProviderEndpointIndex
    ? endpoints
    : new ProviderEndpointIndex(endpoints)
}

export function endpointMatchesAnyProviderRef(
  endpoint: ModelEndpoint,
  refs: readonly string[] | undefined,
  allEndpoints: readonly ModelEndpoint[] | ProviderEndpointIndex = [],
): boolean {
  if (!refs || refs.length === 0) return false
  const index = endpointIndex(allEndpoints)
  return refs.some((ref) => index.matches(endpoint, ref))
}

export function endpointMatchesProviderRef(
  endpoint: ModelEndpoint,
  ref: string,
  allEndpoints: readonly ModelEndpoint[] | ProviderEndpointIndex = [],
): boolean {
  return endpointIndex(allEndpoints).matches(endpoint, ref)
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
  endpoints: readonly ModelEndpoint[] | ProviderEndpointIndex,
  refs: readonly string[] | undefined,
  opts: { preserveUnknown?: boolean } = {},
): string[] {
  return endpointIndex(endpoints).resolveRoutingRefs(refs, opts)
}

export function providerDisplayLabel(
  endpoint: ModelEndpoint,
  allEndpoints: readonly ModelEndpoint[] | ProviderEndpointIndex = [],
): string {
  return endpointIndex(allEndpoints).displayLabel(endpoint)
}

function pushUnique(out: string[], seen: Set<string>, value: string): void {
  const key = normalizeRef(value)
  if (seen.has(key)) return
  seen.add(key)
  out.push(value)
}

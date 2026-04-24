import { filterEndpointsByPrivacy, type PrivacyFilterResult } from './privacy-filter'
import {
  endpointMatchesAnyProviderRef,
  providerEndpointKey,
  providerPolicyLookupKeys,
  providerRoutingRef,
  resolveProviderRefsToRoutingRefs,
} from './provider-identity'
import type { ChatSettings, DataPolicy, ModelEndpoint, ProviderPreferences } from './types'

export interface ProviderSettingsMigrationContext {
  model?: string
  endpoints?: readonly ModelEndpoint[]
  policies?: Readonly<Record<string, DataPolicy | undefined>>
}

export interface ProviderSettingsMigrationResult {
  settings: ChatSettings
  changed: boolean
}

export function migrateLegacyProviderSettings(
  settings: ChatSettings,
  context: ProviderSettingsMigrationContext = {},
): ProviderSettingsMigrationResult {
  const originalPrivacy = settings.privacy
  const legacyIgnore = originalPrivacy.ignoreProviders
  const legacyOnly = originalPrivacy.onlyProviders
  const endpoints = context.endpoints ?? []
  const hasLegacyPrivacyRefs = legacyIgnore.length > 0 || legacyOnly.length > 0
  const normalizedPrefs = normalizeProviderPrefs(settings.providerPrefs, endpoints)
  let providerPrefs: ProviderPreferences = normalizedPrefs.prefs ?? {}
  let privacy = applyProviderPrefPrivacyPatch(settings.privacy, normalizedPrefs.privacyPatch)
  let changed = normalizedPrefs.changed || privacy !== settings.privacy

  if (!hasLegacyPrivacyRefs) {
    return changed
      ? { settings: withProviderPrefs(settings, normalizedPrefs.prefs, privacy), changed: true }
      : { settings, changed: false }
  }

  if (endpoints.length > 0 && context.model && hasPolicyCoverage(endpoints, context.policies ?? {})) {
    const oldFilter = filterEndpointsByPrivacy({
      model: context.model,
      endpoints,
      policies: context.policies ?? {},
      privacy,
    })
    providerPrefs = {
      ...providerPrefs,
      ignore: effectiveIgnoredRoutingRefs(oldFilter, privacy, providerPrefs, endpoints),
      ignoreOverridesFilter: true,
    }
    delete providerPrefs.only
  } else if (endpoints.length > 0) {
    const migratedIgnore = normalizeRefs([...normalizeArray(providerPrefs.ignore), ...legacyIgnore], endpoints)
    const ignoredOutsideOnly = ignoredOutsideOnlyRefs(legacyOnly, endpoints)
    const mergedIgnore = uniqueStrings([...migratedIgnore, ...ignoredOutsideOnly])
    providerPrefs = { ...providerPrefs }
    if (mergedIgnore.length > 0) {
      providerPrefs.ignore = mergedIgnore
      providerPrefs.ignoreOverridesFilter = true
    } else {
      delete providerPrefs.ignore
    }
    delete providerPrefs.only
  } else {
    const migratedIgnore = normalizeRefs([...normalizeArray(providerPrefs.ignore), ...legacyIgnore], endpoints)
    const migratedOnly = normalizeRefs([...normalizeArray(providerPrefs.only), ...legacyOnly], endpoints)
    providerPrefs = { ...providerPrefs }
    if (migratedIgnore.length > 0) {
      providerPrefs.ignore = migratedIgnore
      providerPrefs.ignoreOverridesFilter = true
    } else {
      delete providerPrefs.ignore
    }
    if (migratedOnly.length > 0) providerPrefs.only = migratedOnly
    else delete providerPrefs.only
  }

  privacy = {
    ...privacy,
    ignoreProviders: [],
    onlyProviders: [],
  }
  return {
    settings: withProviderPrefs(settings, providerPrefs, privacy),
    changed: true,
  }
}

function withProviderPrefs(
  settings: ChatSettings,
  providerPrefs: ProviderPreferences | undefined,
  privacy: ChatSettings['privacy'],
): ChatSettings {
  const compacted = compactProviderPrefs(providerPrefs)
  const next: ChatSettings = { ...settings, privacy }
  if (compacted !== undefined) next.providerPrefs = compacted
  else delete next.providerPrefs
  return next
}

function normalizeProviderPrefs(
  prefs: ProviderPreferences | undefined,
  endpoints: readonly ModelEndpoint[],
): {
  prefs: ProviderPreferences | undefined
  changed: boolean
  privacyPatch: { denyDataCollection?: true; zdrOnly?: true }
} {
  if (!prefs) return { prefs, changed: false, privacyPatch: {} }
  let changed = false
  const next: ProviderPreferences = { ...prefs }
  const privacyPatch: { denyDataCollection?: true; zdrOnly?: true } = {}
  if (prefs.dataCollection === 'deny') privacyPatch.denyDataCollection = true
  if (prefs.zdr === true) privacyPatch.zdrOnly = true
  if ('dataCollection' in next) {
    delete next.dataCollection
    changed = true
  }
  if ('zdr' in next) {
    delete next.zdr
    changed = true
  }
  for (const key of ['ignore', 'order'] as const) {
    const current = normalizeArray(prefs[key])
    if (current.length === 0) continue
    const normalized = normalizeRefs(current, endpoints)
    if (JSON.stringify(current) !== JSON.stringify(normalized)) {
      changed = true
      next[key] = normalized
    }
  }
  const currentOnly = normalizeArray(prefs.only)
  if (currentOnly.length > 0) {
    const normalizedOnly = normalizeRefs(currentOnly, endpoints)
    if (endpoints.length > 0) {
      const ignoredOutsideOnly = ignoredOutsideOnlyRefs(normalizedOnly, endpoints)
      const mergedIgnore = uniqueStrings([
        ...normalizeArray(next.ignore),
        ...ignoredOutsideOnly,
      ])
      if (mergedIgnore.length > 0) next.ignore = mergedIgnore
      else delete next.ignore
      next.ignoreOverridesFilter = true
      delete next.only
      changed = true
    } else if (JSON.stringify(currentOnly) !== JSON.stringify(normalizedOnly)) {
      next.only = normalizedOnly
      changed = true
    }
  }
  return { prefs: changed ? compactProviderPrefs(next) : prefs, changed, privacyPatch }
}

function effectiveIgnoredRoutingRefs(
  oldFilter: PrivacyFilterResult,
  privacy: ChatSettings['privacy'],
  providerPrefs: ProviderPreferences | undefined,
  endpoints: readonly ModelEndpoint[],
): string[] {
  const userTouchedPicker = providerPrefs?.ignoreOverridesFilter === true
  const excludedByKey = new Map<string, (typeof oldFilter.excluded)[number]>()
  for (const row of oldFilter.excluded) excludedByKey.set(providerEndpointKey(row.endpoint), row)

  const out: string[] = []
  for (const endpoint of endpoints) {
    const excluded = excludedByKey.get(providerEndpointKey(endpoint))
    let ignored = excluded !== undefined
    if (userTouchedPicker) {
      const reasons = new Set(excluded?.reasons ?? [])
      const outsidePinnedSet =
        reasons.has('not-in-only-list') ||
        (privacy.onlyProviders.length > 0 &&
          !endpointMatchesAnyProviderRef(endpoint, privacy.onlyProviders, endpoints))
      ignored =
        outsidePinnedSet ||
        endpointMatchesAnyProviderRef(endpoint, privacy.ignoreProviders, endpoints) ||
        endpointMatchesAnyProviderRef(endpoint, providerPrefs?.ignore, endpoints)
    }
    if (ignored) out.push(providerRoutingRef(endpoint))
  }
  return uniqueStrings(out)
}

function normalizeRefs(
  refs: readonly string[],
  endpoints: readonly ModelEndpoint[],
): string[] {
  if (refs.length === 0) return []
  if (endpoints.length > 0) {
    return resolveProviderRefsToRoutingRefs(endpoints, refs, { preserveUnknown: true })
  }
  return uniqueStrings(refs.map((ref) => ref.trim()).filter(Boolean))
}

function ignoredOutsideOnlyRefs(
  onlyRefs: readonly string[],
  endpoints: readonly ModelEndpoint[],
): string[] {
  if (onlyRefs.length === 0 || endpoints.length === 0) return []
  const normalizedOnly = normalizeRefs(onlyRefs, endpoints)
  return endpoints
    .filter((endpoint) => !endpointMatchesAnyProviderRef(endpoint, normalizedOnly, endpoints))
    .map((endpoint) => providerRoutingRef(endpoint))
}

function applyProviderPrefPrivacyPatch(
  privacy: ChatSettings['privacy'],
  patch: { denyDataCollection?: true; zdrOnly?: true },
): ChatSettings['privacy'] {
  const denyDataCollection = patch.denyDataCollection === true ? true : privacy.denyDataCollection
  const zdrOnly = patch.zdrOnly === true ? true : privacy.zdrOnly
  if (denyDataCollection === privacy.denyDataCollection && zdrOnly === privacy.zdrOnly) {
    return privacy
  }
  return { ...privacy, denyDataCollection, zdrOnly }
}

function compactProviderPrefs(
  prefs: ProviderPreferences | undefined,
): ProviderPreferences | undefined {
  if (!prefs) return undefined
  return Object.keys(prefs).length > 0 ? prefs : undefined
}

function hasPolicyCoverage(
  endpoints: readonly ModelEndpoint[],
  policies: Readonly<Record<string, DataPolicy | undefined>>,
): boolean {
  return endpoints.every((endpoint) => {
    if (endpoint.data_policy) return true
    return providerPolicyLookupKeys(endpoint).some((key) => policies[key])
  })
}

function normalizeArray(value: readonly string[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((ref) => ref.trim().length > 0) : []
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

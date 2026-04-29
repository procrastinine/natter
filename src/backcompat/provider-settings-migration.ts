import { readCachedPrivacyPayload } from '../api/privacy-scrape'
import { normalizeEndpointsResponse } from '../api/providers'
import { filterEndpointsByPrivacy, type PrivacyFilterResult } from '../core/privacy-filter'
import { DEFAULT_OPENROUTER_PROVIDER_SORT } from '../core/provider-defaults'
import { migrateLegacyChatSettings } from './chat-settings'
import {
  endpointMatchesAnyProviderRef,
  providerEndpointKey,
  providerPolicyLookupKeys,
  providerRoutingRef,
  resolveProviderRefsToRoutingRefs,
} from '../core/provider-identity'
import type {
  ChatSettings,
  ConnectionProfile,
  DataPolicy,
  ModelEndpoint,
  ProviderPreferences,
  SortBy,
} from '../core/types'
import type { CachedEndpointsRow, CachedPrivacyPolicyRow } from '../store/db'

type LegacyPrivacyPrefs = ChatSettings['privacy'] & {
  ignoreProviders?: string[]
  onlyProviders?: string[]
}

interface LegacyProviderPreferences extends ProviderPreferences {
  dataCollection?: 'allow' | 'deny'
  zdr?: boolean
}

interface ProviderSettingsMigrationContext {
  model?: string
  endpoints?: readonly ModelEndpoint[]
  policies?: Readonly<Record<string, DataPolicy | undefined>>
  defaultSort?: SortBy
}

interface ProviderSettingsMigrationResult {
  settings: ChatSettings
  changed: boolean
}

interface ProviderSettingsRowMigrationCaches {
  endpointsByKey: ReadonlyMap<string, CachedEndpointsRow>
  privacyByKey: ReadonlyMap<string, CachedPrivacyPolicyRow>
  profilesById?: ReadonlyMap<string, ConnectionProfile>
}

export function providerCacheKey(profileId: string, modelId: string): string {
  return `${profileId}\u0000${modelId}`
}

export function migrateProviderSettingsRow(
  settings: ChatSettings,
  profileId: string,
  modelId: string,
  caches: ProviderSettingsRowMigrationCaches,
): ProviderSettingsMigrationResult {
  const key = providerCacheKey(profileId, modelId)
  const endpoints = normalizeEndpointsResponse(caches.endpointsByKey.get(key)?.payload)?.endpoints
  const policies = readCachedPrivacyPayload(caches.privacyByKey.get(key)?.payload)?.policies
  const context: ProviderSettingsMigrationContext = { model: modelId }
  if (endpoints) context.endpoints = endpoints
  if (policies) context.policies = policies
  if (caches.profilesById?.get(profileId)?.kind === 'openrouter') {
    context.defaultSort = DEFAULT_OPENROUTER_PROVIDER_SORT
  }
  return migrateLegacyProviderSettings(settings, context)
}

export function migrateLegacyProviderSettings(
  rawSettings: ChatSettings,
  context: ProviderSettingsMigrationContext = {},
): ProviderSettingsMigrationResult {
  const settingsResult = migrateLegacyChatSettings(rawSettings)
  const settings = settingsResult.settings
  const originalPrivacy = settings.privacy as LegacyPrivacyPrefs
  const legacyIgnore = normalizeArray(originalPrivacy.ignoreProviders)
  const legacyOnly = normalizeArray(originalPrivacy.onlyProviders)
  const endpoints = context.endpoints ?? []
  const hasLegacyPrivacyRefs = legacyIgnore.length > 0 || legacyOnly.length > 0
  const normalizedPrefs = normalizeProviderPrefs(
    settings.providerPrefs,
    endpoints,
    context.defaultSort ? { defaultSort: context.defaultSort } : {},
  )
  let providerPrefs: ProviderPreferences = normalizedPrefs.prefs ?? {}
  const privacyResult = stripLegacyPrivacyProviderRefs(
    applyProviderPrefPrivacyPatch(settings.privacy, normalizedPrefs.privacyPatch),
  )
  let privacy = privacyResult.privacy
  const changed =
    settingsResult.changed ||
    normalizedPrefs.changed ||
    privacyResult.changed ||
    privacy !== settings.privacy

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
      ignore: effectiveIgnoredRoutingRefs(
        oldFilter,
        { ignore: legacyIgnore, only: legacyOnly },
        providerPrefs,
        endpoints,
      ),
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
  opts: { defaultSort?: SortBy } = {},
): {
  prefs: ProviderPreferences | undefined
  changed: boolean
  privacyPatch: { denyDataCollection?: true; zdrOnly?: true }
} {
  if (!prefs) {
    return opts.defaultSort
      ? { prefs: { sort: opts.defaultSort }, changed: true, privacyPatch: {} }
      : { prefs, changed: false, privacyPatch: {} }
  }
  let changed = false
  const legacyPrefs = prefs as LegacyProviderPreferences
  const next: ProviderPreferences & Partial<LegacyProviderPreferences> = { ...prefs }
  const privacyPatch: { denyDataCollection?: true; zdrOnly?: true } = {}
  if (legacyPrefs.dataCollection === 'deny') privacyPatch.denyDataCollection = true
  if (legacyPrefs.zdr === true) privacyPatch.zdrOnly = true
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
    if (JSON.stringify(currentOnly) !== JSON.stringify(normalizedOnly)) {
      next.only = normalizedOnly
      changed = true
    }
  }
  const sortResult = normalizeProviderSort((prefs as { sort?: unknown }).sort, opts.defaultSort)
  if (sortResult.changed) {
    changed = true
    if (sortResult.sort === undefined) delete next.sort
    else next.sort = sortResult.sort
  }
  return { prefs: changed ? compactProviderPrefs(next) : prefs, changed, privacyPatch }
}

function normalizeProviderSort(
  value: unknown,
  defaultSort: SortBy | undefined,
): { sort: ProviderPreferences['sort'] | undefined; changed: boolean } {
  if (value === undefined) {
    return defaultSort
      ? { sort: defaultSort, changed: true }
      : { sort: undefined, changed: false }
  }
  const fallback = defaultSort ?? undefined
  if (typeof value === 'string') {
    const sort = normalizeSortBy(value)
    if (sort) return { sort, changed: sort !== value }
    return { sort: fallback, changed: true }
  }
  if (!value || typeof value !== 'object') {
    return { sort: fallback, changed: true }
  }
  const raw = value as { by?: unknown; partition?: unknown }
  const by = typeof raw.by === 'string' ? normalizeSortBy(raw.by) : undefined
  if (!by) return { sort: fallback, changed: true }
  const partition = raw.partition === 'none' ? 'none' : 'model'
  if (partition === 'none') {
    return {
      sort: { by, partition },
      changed: raw.by !== by || raw.partition !== partition || Object.keys(raw).length !== 2,
    }
  }
  return { sort: by, changed: true }
}

function normalizeSortBy(value: string): SortBy | undefined {
  const lowered = value.trim().toLowerCase()
  if (lowered === 'price' || lowered === 'throughput' || lowered === 'latency') return lowered
  if (lowered === 'nitro' || lowered === ':nitro') return 'throughput'
  if (lowered === 'floor' || lowered === ':floor') return 'price'
  return undefined
}

function effectiveIgnoredRoutingRefs(
  oldFilter: PrivacyFilterResult,
  legacyRefs: { ignore: readonly string[]; only: readonly string[] },
  providerPrefs: ProviderPreferences | undefined,
  endpoints: readonly ModelEndpoint[],
): string[] {
  const userTouchedPicker = providerPrefs?.ignoreOverridesFilter === true
  const excludedByKey = new Map<string, (typeof oldFilter.excluded)[number]>()
  for (const row of oldFilter.excluded) excludedByKey.set(providerEndpointKey(row.endpoint), row)

  const out: string[] = []
  for (const endpoint of endpoints) {
    const excluded = excludedByKey.get(providerEndpointKey(endpoint))
    const legacyIgnored = endpointMatchesAnyProviderRef(endpoint, legacyRefs.ignore, endpoints)
    const pickerIgnored = endpointMatchesAnyProviderRef(endpoint, providerPrefs?.ignore, endpoints)
    const outsidePinnedSet =
      legacyRefs.only.length > 0 &&
      !endpointMatchesAnyProviderRef(endpoint, legacyRefs.only, endpoints)
    const ignored =
      legacyRefs.only.length > 0
        ? outsidePinnedSet || legacyIgnored || pickerIgnored
        : excluded !== undefined || legacyIgnored || (userTouchedPicker && pickerIgnored)
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

function stripLegacyPrivacyProviderRefs(privacy: ChatSettings['privacy']): {
  privacy: ChatSettings['privacy']
  changed: boolean
} {
  const next = { ...privacy } as ChatSettings['privacy'] & Partial<LegacyPrivacyPrefs>
  let changed = false
  if ('ignoreProviders' in next) {
    delete next.ignoreProviders
    changed = true
  }
  if ('onlyProviders' in next) {
    delete next.onlyProviders
    changed = true
  }
  return changed ? { privacy: next, changed: true } : { privacy, changed: false }
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

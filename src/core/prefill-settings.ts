import {
  providerRefCandidates,
  providerRoutingRef,
  resolveProviderRefsToRoutingRefs,
} from './provider-identity'
import { prefillClassFor, reasoningToggleableFor } from './quirks'
import type { ChatSettings, ModelEndpoint, ProviderPreferences } from './types'

export const PREFILL_PREFERRED_PROVIDERS = ['deepinfra', 'nebius'] as const

export interface PrefillSettingsRecommendation {
  issues: string[]
  patch: Partial<ChatSettings>
}

export function prefillSettingsRecommendation(
  settings: ChatSettings,
  endpoints: readonly ModelEndpoint[] = [],
): PrefillSettingsRecommendation | null {
  if (!settings.model) return null
  if (prefillClassFor(settings.model) !== 'oss-toggleable') return null

  const issues: string[] = []
  const patch: Partial<ChatSettings> = {}
  const preferredProviderRefs = availablePrefillProviderRefs(endpoints)
  if (endpoints.length > 0 && preferredProviderRefs.length === 0) return null

  if (reasoningToggleableFor(settings.model) && settings.reasoning.mode !== 'off') {
    issues.push('turn reasoning off')
    patch.reasoning = { ...settings.reasoning, mode: 'off' }
  }

  if (
    preferredProviderRefs.length > 0 &&
    !onlyPreferredPrefillProviders(settings.providerPrefs, endpoints)
  ) {
    const onlyPreferredRef = preferredProviderRefs[0]
    issues.push(
      preferredProviderRefs.length === 1 && onlyPreferredRef
        ? `use ${preferredProviderLabel(onlyPreferredRef)}`
        : 'use DeepInfra or Nebius providers',
    )
    patch.providerPrefs = preferredProviderPrefs(settings.providerPrefs, preferredProviderRefs)
  }

  return issues.length > 0 ? { issues, patch } : null
}

export function availablePrefillProviderRefs(endpoints: readonly ModelEndpoint[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const endpoint of endpoints) {
    if (!isPreferredPrefillEndpoint(endpoint)) continue
    const ref = providerRoutingRef(endpoint)
    const key = ref.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ref)
  }
  return out
}

function isPreferredPrefillEndpoint(endpoint: ModelEndpoint): boolean {
  return providerRefCandidates(endpoint).some((candidate) => {
    const normalized = candidate.trim().toLowerCase()
    return PREFILL_PREFERRED_PROVIDERS.some(
      (preferred) => normalized === preferred || normalized.startsWith(`${preferred}/`),
    )
  })
}

function onlyPreferredPrefillProviders(
  prefs: ProviderPreferences | undefined,
  endpoints: readonly ModelEndpoint[],
): boolean {
  const only = prefs?.only
  if (!only || only.length === 0) return false
  const normalizedOnly =
    endpoints.length > 0
      ? resolveProviderRefsToRoutingRefs(endpoints, only, { preserveUnknown: true })
      : only
  return normalizedOnly.every((provider) => isPreferredProviderRef(provider))
}

function preferredProviderPrefs(
  prefs: ProviderPreferences | undefined,
  preferredProviderRefs: readonly string[],
): ProviderPreferences {
  return {
    ...(prefs ?? {}),
    ignore: [],
    ignoreOverridesFilter: true,
    only: [...preferredProviderRefs],
  }
}

function isPreferredProviderRef(provider: string): boolean {
  const normalized = provider.trim().toLowerCase()
  return PREFILL_PREFERRED_PROVIDERS.some(
    (preferred) => normalized === preferred || normalized.startsWith(`${preferred}/`),
  )
}

function preferredProviderLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase()
  if (normalized === 'nebius' || normalized.startsWith('nebius/')) return 'Nebius'
  return 'DeepInfra'
}

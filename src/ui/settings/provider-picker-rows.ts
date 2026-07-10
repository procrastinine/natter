// Provider-picker row model. Pure data layer so the UI component stays
// thin and the mapping stays testable without mounting React.
//
// Each endpoint becomes exactly one `PickerRow`, tagged with its kept /
// auto-excluded / no-filter status, the resolved `DataPolicy` (or
// undefined when none could be resolved), the privacy tier, and any
// exclusion reasons. The picker renders directly from this list — the
// order matches `endpoints` (the caller decides how to sort upstream).

import {
  type ExclusionReason,
  type PrivacyFilterResult,
  type PrivacyTier,
  privacyTierForPolicy,
} from '../../core/privacy-filter'
import {
  endpointMatchesAnyProviderRef,
  providerEndpointKey,
  providerRoutingRef,
  resolveProviderRefsToRoutingRefs,
} from '../../core/provider-identity'
import type { DataPolicy, ModelEndpoint, PrivacyPrefs, ProviderPreferences } from '../../core/types'

type PickerRowState = 'kept' | 'auto-excluded' | 'no-filter'

export interface PickerRow {
  endpoint: ModelEndpoint
  state: PickerRowState
  policy: DataPolicy | undefined
  tier: PrivacyTier
  reasons: readonly ExclusionReason[]
  policySynthesized: boolean
}

interface BuildPickerRowsOptions {
  providerPrefs?: ProviderPreferences | undefined
  privacy?: PrivacyPrefs | undefined
}

export function buildPickerRows(
  endpoints: readonly ModelEndpoint[],
  filter: PrivacyFilterResult | null,
  opts: BuildPickerRowsOptions = {},
): PickerRow[] {
  // Index the filter result by endpoint identity so duplicate display
  // names (for example two Anthropic endpoints) stay distinct.
  // `excluded` wins over `kept` on collision (a name shouldn't appear in
  // both, but if it did the exclusion state is the one that matters — it
  // would mean the send is blocked, not the row kept).
  if (!filter) {
    return endpoints.map((ep) => ({
      endpoint: ep,
      state: 'no-filter',
      policy: undefined,
      tier: 'open',
      reasons: [],
      policySynthesized: false,
    }))
  }
  const kept = new Map<string, (typeof filter.kept)[number]>()
  for (const k of filter.kept) kept.set(providerEndpointKey(k.endpoint), k)
  const excluded = new Map<string, (typeof filter.excluded)[number]>()
  for (const e of filter.excluded) excluded.set(providerEndpointKey(e.endpoint), e)

  return endpoints.map((ep) => {
    const key = providerEndpointKey(ep)
    const ex = excluded.get(key)
    if (ex) {
      const row: PickerRow = {
        endpoint: ep,
        state: 'auto-excluded',
        policy: ex.policy,
        tier: privacyTierForPolicy(ex.policy, { synthesized: ex.policySynthesized }),
        reasons: ex.reasons,
        policySynthesized: ex.policySynthesized,
      }
      return applyManualPickerState(row, opts, endpoints)
    }
    const k = kept.get(key)
    if (k) {
      const row: PickerRow = {
        endpoint: ep,
        state: 'kept',
        policy: k.policy,
        tier: privacyTierForPolicy(k.policy, { synthesized: k.policySynthesized }),
        reasons: [],
        policySynthesized: k.policySynthesized,
      }
      return applyManualPickerState(row, opts, endpoints)
    }
    // An endpoint that made it into `endpoints` but not into `kept` or
    // `excluded` means the filter skipped it — shouldn't happen, but
    // render it as unavailable rather than crashing.
    const row: PickerRow = {
      endpoint: ep,
      state: 'auto-excluded',
      policy: undefined,
      tier: 'unavailable',
      reasons: ['unknown-policy'],
      policySynthesized: false,
    }
    return applyManualPickerState(row, opts, endpoints)
  })
}

function applyManualPickerState(
  row: PickerRow,
  opts: BuildPickerRowsOptions,
  endpoints: readonly ModelEndpoint[],
): PickerRow {
  const providerPrefs = opts.providerPrefs
  const userTouchedPicker = providerPrefs?.ignoreOverridesFilter === true
  const hasOnly = (providerPrefs?.only?.length ?? 0) > 0
  if (!userTouchedPicker && !hasOnly) return row

  const ignoredByPicker =
    userTouchedPicker &&
    endpointMatchesAnyProviderRef(row.endpoint, providerPrefs?.ignore, endpoints)
  if (ignoredByPicker) {
    return { ...row, state: 'auto-excluded', reasons: ['user-ignored'] }
  }
  if (hasOnly && !endpointMatchesAnyProviderRef(row.endpoint, providerPrefs?.only, endpoints)) {
    return { ...row, state: 'auto-excluded', reasons: ['not-in-only-list'] }
  }

  return userTouchedPicker ? { ...row, state: 'kept', reasons: [] } : row
}

// One-line reason label for the picker row. Full tooltip text comes from
// `reasonsToTooltip` which concatenates these with any finite retention
// info. Keep each phrase short — they render in a small muted line
// directly under the provider name.
export function reasonLabel(reason: ExclusionReason): string {
  switch (reason) {
    case 'training':
      return 'Trains on prompts'
    case 'training-openrouter':
      return 'Trains on OpenRouter traffic'
    case 'dominated':
      return 'A stricter provider exists'
    case 'unknown-policy':
      return 'No privacy data available'
    case 'user-ignored':
      return 'Provider is ignored'
    case 'not-in-only-list':
      return 'Outside the pinned set'
  }
}

export function reasonsToTooltip(
  reasons: readonly ExclusionReason[],
  policy: DataPolicy | undefined,
): string {
  const lines = reasons.map(reasonLabel)
  // Retention details are useful on dominated / unknown-policy rows so the
  // user can see WHY Pareto dropped them (e.g. "retains for unknown period").
  if (policy) {
    if (policy.retainsPrompts && policy.retentionDays === undefined) {
      lines.push('Retains prompts for an unknown period')
    } else if (policy.retainsPrompts && typeof policy.retentionDays === 'number') {
      lines.push(`Retains prompts ${policy.retentionDays}d`)
    }
    if (policy.requiresUserIDs) lines.push('Requires user IDs')
  }
  return lines.join('\n')
}

export function tierToLockLabel(tier: PrivacyTier): string {
  // Copy aligned with `privacyTierForPolicy` (2026-04-19 spec):
  //   red    = trains on prompts
  //   orange = retains indefinitely OR requires user IDs
  //   yellow = retains for a finite set period (no user IDs)
  //   green  = no retention, no user IDs
  //   open   = privacy filter doesn't apply (free model / direct provider)
  //   unavailable = no policy data at all
  switch (tier) {
    case 'green':
      return 'Private — no retention, no user IDs'
    case 'yellow':
      return 'Retains prompts for a finite period'
    case 'orange':
      return 'Retains indefinitely or requires user IDs'
    case 'red':
      return 'Trains on prompts'
    case 'open':
      return 'No privacy filter (free model or direct provider)'
    case 'unavailable':
      return 'Privacy data unavailable'
  }
}

export function isLowQuantization(quantization: string | undefined): boolean {
  const q = quantization?.trim().toLowerCase()
  if (!q || q === 'unknown') return false
  return /(^|[^a-z0-9])(?:int[1-4]|uint[1-4]|fp[1-4]|nf[1-4]|q[1-4]|[1-4]\s*[-_ ]?bit|[1-4]b|nvfp4|mxfp4)([^a-z0-9]|$)/u.test(
    q,
  )
}

export function isUnknownQuantization(quantization: string | undefined): boolean {
  const q = quantization?.trim().toLowerCase()
  return !q || q === 'unknown'
}

export function ignoredProviderRefsAfterBulkDeselect(
  rows: readonly PickerRow[],
  endpoints: readonly ModelEndpoint[],
  providerPrefs: ProviderPreferences | undefined,
  shouldDeselect: (endpoint: ModelEndpoint) => boolean,
): string[] {
  const ignored = new Set<string>()
  for (const row of rows) {
    if (row.state !== 'kept') ignored.add(providerRoutingRef(row.endpoint))
  }
  for (const ref of resolveProviderRefsToRoutingRefs(endpoints, providerPrefs?.ignore, {
    preserveUnknown: true,
  })) {
    ignored.add(ref)
  }
  for (const row of rows) {
    if (row.state === 'kept' && shouldDeselect(row.endpoint)) {
      ignored.add(providerRoutingRef(row.endpoint))
    }
  }
  return [...ignored]
}

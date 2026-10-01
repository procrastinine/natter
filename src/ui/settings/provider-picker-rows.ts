// Provider-picker row model. Pure data layer so the UI component stays
// thin and the mapping stays testable without mounting React.
//
// Each routing identity becomes exactly one `PickerRow`, tagged with its kept /
// auto-excluded / no-filter status, the resolved `DataPolicy` (or
// undefined when none could be resolved), the privacy tier, and any
// exclusion reasons. The picker renders directly from this list — the
// Raw observations remain available for alias resolution and privacy aggregation.

import {
  type ExclusionReason,
  hasHardPrivacyExclusion,
  type PrivacyFilterResult,
  type PrivacyTier,
  privacyTierForPolicy,
} from '../../core/privacy-filter'
import {
  ProviderEndpointIndex,
  providerEndpointKey,
  providerRoutingRef,
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

export function pickerRowIsHardDenied(row: PickerRow): boolean {
  return hasHardPrivacyExclusion(row.reasons)
}

interface BuildPickerRowsOptions {
  providerPrefs?: ProviderPreferences | undefined
  privacy?: PrivacyPrefs | undefined
}

export function buildPickerRows(
  endpoints: readonly ModelEndpoint[] | ProviderEndpointIndex,
  filter: PrivacyFilterResult | null,
  opts: BuildPickerRowsOptions = {},
): PickerRow[] {
  const endpointIndex =
    endpoints instanceof ProviderEndpointIndex ? endpoints : new ProviderEndpointIndex(endpoints)
  const representatives = endpointIndex.orderByRefs(opts.providerPrefs?.order)
  if (!filter) {
    return representatives.map((ep) => ({
      endpoint: ep,
      state: 'no-filter',
      policy: undefined,
      tier: 'open',
      reasons: [],
      policySynthesized: false,
    }))
  }
  const grouped = new Map<string, PickerRow>()
  const addObservation = (
    observation: (typeof filter.kept)[number],
    reasons: readonly ExclusionReason[],
  ): void => {
    const row: PickerRow = {
      endpoint: observation.endpoint,
      state: reasons.length > 0 ? 'auto-excluded' : 'kept',
      policy: observation.policy,
      tier: privacyTierForPolicy(observation.policy, {
        synthesized: observation.policySynthesized,
      }),
      reasons,
      policySynthesized: observation.policySynthesized,
    }
    const key = providerEndpointKey(observation.endpoint)
    const previous = grouped.get(key)
    if (!previous) {
      grouped.set(key, row)
      return
    }
    const worst = worstPickerPrivacyRow([previous, row]) ?? row
    grouped.set(key, {
      ...worst,
      state:
        previous.state === 'auto-excluded' || row.state === 'auto-excluded'
          ? 'auto-excluded'
          : 'kept',
      reasons: [...new Set([...previous.reasons, ...row.reasons])],
    })
  }
  for (const observation of filter.kept) addObservation(observation, [])
  for (const observation of filter.excluded) addObservation(observation, observation.reasons)
  const ignoredEndpoints = endpointIndex.endpointsForRefs(
    endpointIndex.resolveRoutingRefs(opts.providerPrefs?.ignore),
  )
  const onlyEndpoints = endpointIndex.endpointsForRefs(
    endpointIndex.resolveRoutingRefs(opts.providerPrefs?.only),
  )

  return representatives.map((ep) => {
    const group = grouped.get(providerEndpointKey(ep))
    if (group)
      return applyManualPickerState(
        { ...group, endpoint: ep },
        opts,
        ignoredEndpoints,
        onlyEndpoints,
      )
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
    return applyManualPickerState(row, opts, ignoredEndpoints, onlyEndpoints)
  })
}

const PRIVACY_TIER_RANK: Record<PrivacyTier, number> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
  open: -1,
  unavailable: 4,
}

export function worstPickerPrivacyRow(rows: readonly PickerRow[]): PickerRow | undefined {
  return rows.reduce<PickerRow | undefined>((worst, row) => {
    if (!worst || PRIVACY_TIER_RANK[row.tier] > PRIVACY_TIER_RANK[worst.tier]) return row
    if (
      row.tier === worst.tier &&
      (row.policy?.retentionDays ?? 0) > (worst.policy?.retentionDays ?? 0)
    )
      return row
    return worst
  }, undefined)
}

function applyManualPickerState(
  row: PickerRow,
  opts: BuildPickerRowsOptions,
  ignoredEndpoints: ReadonlySet<ModelEndpoint>,
  onlyEndpoints: ReadonlySet<ModelEndpoint>,
): PickerRow {
  const providerPrefs = opts.providerPrefs
  const userTouchedPicker = providerPrefs?.ignoreOverridesFilter === true
  const hasOnly =
    (providerPrefs?.only?.length ?? 0) > 0 ||
    (userTouchedPicker && providerPrefs.only !== undefined)
  if (pickerRowIsHardDenied(row)) return row
  if (!userTouchedPicker && !hasOnly) return row

  const ignoredByPicker = userTouchedPicker && ignoredEndpoints.has(row.endpoint)
  if (ignoredByPicker) {
    return { ...row, state: 'auto-excluded', reasons: ['user-ignored'] }
  }
  if (hasOnly && !onlyEndpoints.has(row.endpoint)) {
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
  const endpointIndex = new ProviderEndpointIndex(endpoints)
  const ignored = new Set<string>()
  for (const row of rows) {
    if (row.state !== 'kept') ignored.add(providerRoutingRef(row.endpoint))
  }
  for (const ref of endpointIndex.resolveRoutingRefs(providerPrefs?.ignore, {
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

// Provider-picker row model. Pure data layer so the UI component stays
// thin and the mapping stays testable without mounting React.
//
// Each endpoint becomes exactly one `PickerRow`, tagged with its kept /
// auto-excluded / no-filter status, the resolved `DataPolicy` (or
// undefined when we couldn't resolve one), the privacy tier, and any
// exclusion reasons. The picker renders directly from this list — the
// order matches `endpoints` (the caller decides how to sort upstream).

import {
  privacyTierForPolicy,
  type ExclusionReason,
  type PrivacyFilterResult,
  type PrivacyTier,
} from '../../core/privacy-filter'
import type { DataPolicy, ModelEndpoint } from '../../core/types'

export type PickerRowState = 'kept' | 'auto-excluded' | 'no-filter'

export interface PickerRow {
  endpoint: ModelEndpoint
  state: PickerRowState
  policy: DataPolicy | undefined
  tier: PrivacyTier
  reasons: readonly ExclusionReason[]
  policySynthesized: boolean
}

export function buildPickerRows(
  endpoints: readonly ModelEndpoint[],
  filter: PrivacyFilterResult | null,
): PickerRow[] {
  // Index the filter result by provider_name so row assembly is O(n).
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
  for (const k of filter.kept) kept.set(k.endpoint.provider_name, k)
  const excluded = new Map<string, (typeof filter.excluded)[number]>()
  for (const e of filter.excluded) excluded.set(e.endpoint.provider_name, e)

  return endpoints.map((ep) => {
    const ex = excluded.get(ep.provider_name)
    if (ex) {
      return {
        endpoint: ep,
        state: 'auto-excluded',
        policy: ex.policy,
        tier: privacyTierForPolicy(ex.policy, { synthesized: ex.policySynthesized }),
        reasons: ex.reasons,
        policySynthesized: ex.policySynthesized,
      }
    }
    const k = kept.get(ep.provider_name)
    if (k) {
      return {
        endpoint: ep,
        state: 'kept',
        policy: k.policy,
        tier: privacyTierForPolicy(k.policy, { synthesized: k.policySynthesized }),
        reasons: [],
        policySynthesized: k.policySynthesized,
      }
    }
    // An endpoint that made it into `endpoints` but not into `kept` or
    // `excluded` means the filter skipped it — shouldn't happen, but
    // render it as unavailable rather than crashing.
    return {
      endpoint: ep,
      state: 'auto-excluded',
      policy: undefined,
      tier: 'unavailable',
      reasons: ['unknown-policy'],
      policySynthesized: true,
    }
  })
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
      return 'You ignored this provider'
    case 'not-in-only-list':
      return 'Outside your pinned set'
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
      return 'Trains on prompts or privacy data missing'
    case 'open':
      return 'No privacy filter (free model or direct provider)'
    case 'unavailable':
      return 'Privacy data unavailable'
  }
}

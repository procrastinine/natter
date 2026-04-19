// Privacy filter. See `plan/09-privacy.md §9.6 and §9.9`.
//
// Given the live `/endpoints` rows + scraped `data_policy` map for a model,
// produce the final routing decision for a request:
//
//   1. Synthesize a worst-case policy for any endpoint missing data_policy.
//   2. Hard-deny — drop endpoints with training: true OR trainingOpenRouter: true.
//   3. Apply user `onlyProviders` (scoped to the survivors of step 2).
//   4. Pareto-dominance exclusion, IF `privacy.paretoFilter`.
//   5. Apply user `ignoreProviders` (always adds, never removes from "kept").
//   6. Preferred-ordering tiebreaker, IF `privacy.usePreferredOrdering` AND >1 kept.
//
// The result exposes both `kept` and `excluded` with per-endpoint reasons
// so the provider picker can render "auto-excluded: Requires user IDs"
// tooltips without recomputing the filter itself.
//
// This function is pure. It takes endpoints + policies + privacy prefs
// and produces a decision. The scraper and hook layers feed it; the
// request composer consumes `buildWireProviderPrefs`.

import { curatedPolicyFor } from './data-policies-fallback'
import { synthesizeDataPolicy } from './privacy'
import { applyPreferredOrdering } from './preferred-providers'
import type { DataPolicy, ModelEndpoint, PrivacyPrefs } from './types'
import { dominates } from './privacy'

export type ExclusionReason =
  | 'training'
  | 'training-openrouter'
  | 'dominated'
  | 'unknown-policy'
  | 'user-ignored'
  | 'not-in-only-list'

export interface FilteredEndpoint {
  endpoint: ModelEndpoint
  policy: DataPolicy
  // True when the raw policy map didn't have an entry and we synthesized
  // a worst-case. The UI flags these with "privacy data unavailable."
  policySynthesized: boolean
}

export interface ExcludedEndpoint extends FilteredEndpoint {
  reasons: ExclusionReason[]
}

export interface PrivacyFilterResult {
  kept: FilteredEndpoint[]
  excluded: ExcludedEndpoint[]
  // The kept set ordered by the preferred-ordering rule for the model,
  // with rule-named providers first. Use this for `provider.order` on the wire.
  orderedKeptNames: string[]
  // True when hard-deny + onlyProviders + Pareto leaves zero providers.
  // The UI renders a zero-eligible modal; the request is blocked.
  zeroEligible: boolean
}

export interface PrivacyFilterInput {
  model: string
  endpoints: readonly ModelEndpoint[]
  policies: Readonly<Record<string, DataPolicy | undefined>>
  privacy: PrivacyPrefs
}

export function filterEndpointsByPrivacy(input: PrivacyFilterInput): PrivacyFilterResult {
  const { endpoints, policies, privacy } = input

  // Step 1 — resolve the per-endpoint policy. Order of sources:
  //   1. Live scrape (keyed by `provider_name` — which equals the HTML
  //      `provider_display_name` when it matches the JSON API value)
  //   2. Hand-curated fallback in `data_policies.json` (keyed by the
  //      same `provider_name`), so regional variants like
  //      "Google Vertex (Global)" in the scrape that collapse to "Google"
  //      in `/endpoints` still resolve cleanly.
  //   3. Worst-case synthetic — gets tagged `unknown-policy` and
  //      hard-denied as `training`, so the endpoint is excluded by
  //      default until live data arrives.
  type AugmentedEndpoint = FilteredEndpoint
  const augmented: AugmentedEndpoint[] = endpoints.map((ep) => {
    const raw = policies[ep.provider_name] ?? curatedPolicyFor(ep.provider_name)
    return {
      endpoint: ep,
      policy: synthesizeDataPolicy(raw),
      policySynthesized: !raw,
    }
  })

  const reasons = new Map<AugmentedEndpoint, ExclusionReason[]>()
  const excludeWith = (aug: AugmentedEndpoint, reason: ExclusionReason) => {
    const list = reasons.get(aug) ?? []
    if (!list.includes(reason)) list.push(reason)
    reasons.set(aug, list)
  }

  // Step 2 — hard-deny. Trainer endpoints are always excluded, whether or
  // not Pareto is enabled. A synthesized worst-case policy gets both
  // `unknown-policy` (so the UI can call it out) AND `training` (the fact
  // that the filter acts on), so the tooltip stays accurate.
  for (const aug of augmented) {
    if (aug.policySynthesized) excludeWith(aug, 'unknown-policy')
    if (aug.policy.training) excludeWith(aug, 'training')
    if (aug.policy.trainingOpenRouter) excludeWith(aug, 'training-openrouter')
  }
  const afterDeny = augmented.filter((aug) => !reasons.has(aug))

  // Step 3 — `onlyProviders` narrows the denied-survivor set. Anything
  // outside the list gets flagged as `not-in-only-list`. The picker shows
  // these rows as "excluded by your pin."
  const onlySet =
    privacy.onlyProviders.length > 0 ? new Set(privacy.onlyProviders) : null
  const scoped = afterDeny.filter((aug) => {
    if (!onlySet) return true
    if (onlySet.has(aug.endpoint.provider_name)) return true
    excludeWith(aug, 'not-in-only-list')
    return false
  })

  // Step 4 — Pareto exclusion, opt-out via `paretoFilter: false`. An
  // endpoint is dominated iff some OTHER scoped endpoint dominates it.
  let kept = scoped
  if (privacy.paretoFilter) {
    const undominated = scoped.filter((aug) => {
      for (const other of scoped) {
        if (other === aug) continue
        if (dominates(other.policy, aug.policy)) return false
      }
      return true
    })
    for (const aug of scoped) {
      if (!undominated.includes(aug)) excludeWith(aug, 'dominated')
    }
    kept = undominated
  }

  // Step 5 — user-driven ignore list runs after Pareto. It's *additive*
  // to `autoIgnore` at request time but it also changes what the picker
  // shows as "kept" (user's explicit veto wins visually too).
  const ignoreSet =
    privacy.ignoreProviders.length > 0 ? new Set(privacy.ignoreProviders) : null
  if (ignoreSet) {
    kept = kept.filter((aug) => {
      if (ignoreSet.has(aug.endpoint.provider_name)) {
        excludeWith(aug, 'user-ignored')
        return false
      }
      return true
    })
  }

  // Step 6 — preferred ordering over the kept set. Never adds/removes.
  const keptNames = kept.map((aug) => aug.endpoint.provider_name)
  const orderedKeptNames = privacy.usePreferredOrdering
    ? applyPreferredOrdering(input.model, keptNames)
    : [...keptNames]

  const excluded: ExcludedEndpoint[] = []
  for (const aug of augmented) {
    const rs = reasons.get(aug)
    if (!rs || rs.length === 0) continue
    excluded.push({ ...aug, reasons: [...rs] })
  }

  return {
    kept,
    excluded,
    orderedKeptNames,
    zeroEligible: kept.length === 0 && endpoints.length > 0,
  }
}

// Privacy-lock tier. See `plan/09-privacy.md §9.11`. Computed from the
// most-preferred kept endpoint's policy (first element of
// `orderedKeptNames`). `open` means "privacy filter doesn't apply" (free
// model); `unavailable` means we have kept endpoints but no data_policy
// survives through to describe them.
export type PrivacyTier =
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'open'
  | 'unavailable'

export function privacyTierForPolicy(
  policy: DataPolicy | undefined,
  opts: { synthesized?: boolean } = {},
): PrivacyTier {
  // Tier mapping (per user spec 2026-04-19):
  //   red    = trains on prompts (hard-denied, but we still render the
  //            row + lock so the user can see why)
  //   orange = retains indefinitely OR requires user IDs
  //   yellow = retains prompts for a finite set period (no user IDs)
  //   green  = no retention, no user IDs
  //   red (synthesized) = we couldn't resolve a policy at all, so assume
  //            the worst
  //   unavailable = genuinely no policy data provided (direct-provider
  //            rows)
  if (opts.synthesized) return 'red'
  if (!policy) return 'unavailable'
  if (policy.training || policy.trainingOpenRouter) return 'red'
  const userIds = policy.requiresUserIDs === true
  const retainsUnknownPeriod =
    policy.retainsPrompts && policy.retentionDays === undefined
  if (retainsUnknownPeriod) return 'orange'
  if (userIds) return 'orange'
  if (policy.retainsPrompts) return 'yellow'
  return 'green'
}

// Wire-shape output: the `provider` block fragments that derive from the
// filter result. The request composer merges these with the user's manual
// `providerPrefs` (order / sort / quantizations / etc.) per §9.9.
export interface WireProviderPrivacy {
  ignore?: string[]
  only?: string[]
  order?: string[]
  data_collection?: 'deny'
  zdr?: true
  // True when the caller should block the request and show the
  // zero-eligible modal instead of firing.
  zeroEligible: boolean
}

export function buildWireProviderPrivacy(
  result: PrivacyFilterResult,
  privacy: PrivacyPrefs,
  opts: {
    existingIgnore?: readonly string[]
    userTouchedPicker?: boolean
  } = {},
): WireProviderPrivacy {
  // Unified "allowed vs disallowed" model: if the user has touched the
  // picker, `existingIgnore` is the authoritative set of disallowed
  // providers — the wire does NOT re-layer the filter's auto-exclusion
  // on top. When the user hasn't touched (default), fall back to
  // `autoIgnore` so the request matches what the picker shows.
  const userTookOver = opts.userTouchedPicker === true
  const autoIgnore = result.excluded.map((e) => e.endpoint.provider_name)
  const mergedIgnore = userTookOver
    ? uniqueStrings([...(opts.existingIgnore ?? []), ...privacy.ignoreProviders])
    : uniqueStrings([...autoIgnore, ...privacy.ignoreProviders])
  const wire: WireProviderPrivacy = {
    zeroEligible: result.zeroEligible,
  }
  if (mergedIgnore.length > 0) wire.ignore = mergedIgnore
  if (privacy.onlyProviders.length > 0) {
    // When the user pins a set, echo the kept survivors (post-Pareto) so
    // the request matches what the UI shows. Using `onlyProviders`
    // verbatim would send providers that Pareto / hard-deny already
    // excluded, which would be surprising.
    wire.only = result.kept.map((k) => k.endpoint.provider_name)
  }
  if (result.orderedKeptNames.length > 1) {
    wire.order = [...result.orderedKeptNames]
  }
  if (privacy.denyDataCollection) wire.data_collection = 'deny'
  if (privacy.zdrOnly) wire.zdr = true
  return wire
}

function uniqueStrings(arr: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of arr) {
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

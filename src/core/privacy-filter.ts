// Privacy filter. See `plan/09-privacy.md §9.6 and §9.9`.
//
// Given the live `/endpoints` rows + scraped `data_policy` map for a model,
// produce the final routing decision for a request:
//
//   1. Resolve live per-endpoint policy from /endpoints or the OpenRouter
//      providers scrape. Missing online policy is "unavailable", not guessed.
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

import { synthesizeDataPolicy } from './privacy'
import { findPreferredRule } from './preferred-providers'
import {
  endpointMatchesAnyProviderRef,
  endpointMatchesProviderRef,
  providerPolicyLookupKeys,
  providerRoutingRef,
  resolveProviderRefsToRoutingRefs,
} from './provider-identity'
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
  policy: DataPolicy | undefined
  // True only when the caller explicitly requested the offline safety
  // fallback. Online misses remain `policy: undefined` so the UI doesn't
  // claim a live policy says the provider trains.
  policySynthesized: boolean
}

export interface ExcludedEndpoint extends FilteredEndpoint {
  reasons: ExclusionReason[]
}

export interface PrivacyFilterResult {
  kept: FilteredEndpoint[]
  excluded: ExcludedEndpoint[]
  // The kept set ordered by the preferred-ordering rule for the model,
  // with rule-named providers first. Values are provider routing refs
  // (OpenRouter slugs when available). The legacy property name is kept
  // so older call sites/tests don't need a schema migration.
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
  missingPolicyMode?: 'unavailable' | 'offline-worst-case'
}

export function filterEndpointsByPrivacy(input: PrivacyFilterInput): PrivacyFilterResult {
  const { endpoints, policies, privacy } = input

  // Step 1 — resolve the per-endpoint policy. Prefer policy data embedded
  // in the endpoint row, then lookup by every known identity (slug,
  // display name, provider_name, provider_model_id, row id). This keeps
  // duplicate display names distinct while preserving old name-keyed
  // caches/settings. Do not use hardcoded provider policy guesses here:
  // OpenRouter live data is authoritative when reachable.
  type AugmentedEndpoint = FilteredEndpoint
  const augmented: AugmentedEndpoint[] = endpoints.map((ep) => {
    const raw = resolveEndpointPolicy(ep, policies)
    if (!raw && input.missingPolicyMode === 'offline-worst-case') {
      return {
        endpoint: ep,
        policy: synthesizeDataPolicy(raw),
        policySynthesized: true,
      }
    }
    return {
      endpoint: ep,
      policy: raw,
      policySynthesized: false,
    }
  })

  const reasons = new Map<AugmentedEndpoint, ExclusionReason[]>()
  const excludeWith = (aug: AugmentedEndpoint, reason: ExclusionReason) => {
    const list = reasons.get(aug) ?? []
    if (!list.includes(reason)) list.push(reason)
    reasons.set(aug, list)
  }

  // Step 2 — hard-deny. Trainer endpoints are always excluded, whether or
  // not Pareto is enabled. Missing online policy is excluded as unknown
  // policy, not as training. Only the explicit offline fallback gets a
  // synthesized worst-case policy.
  for (const aug of augmented) {
    if (!aug.policy) {
      excludeWith(aug, 'unknown-policy')
      continue
    }
    if (aug.policySynthesized) excludeWith(aug, 'unknown-policy')
    if (aug.policy.training) excludeWith(aug, 'training')
    if (aug.policy.trainingOpenRouter) excludeWith(aug, 'training-openrouter')
  }
  const afterDeny = augmented.filter((aug) => !reasons.has(aug))

  // Step 3 — `onlyProviders` narrows the denied-survivor set. Anything
  // outside the list gets flagged as `not-in-only-list`. The picker shows
  // these rows as "excluded by the user's pin."
  const onlyRefs = privacy.onlyProviders
  const scoped = afterDeny.filter((aug) => {
    if (onlyRefs.length === 0) return true
    if (endpointMatchesAnyProviderRef(aug.endpoint, onlyRefs, endpoints)) return true
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
        if (!other.policy || !aug.policy) continue
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
  // shows as "kept" (the user's explicit veto wins visually too).
  const ignoreRefs = privacy.ignoreProviders
  if (ignoreRefs.length > 0) {
    kept = kept.filter((aug) => {
      if (endpointMatchesAnyProviderRef(aug.endpoint, ignoreRefs, endpoints)) {
        excludeWith(aug, 'user-ignored')
        return false
      }
      return true
    })
  }

  // Step 6 — preferred ordering over the kept set. Never adds/removes.
  const orderedKeptNames = privacy.usePreferredOrdering
    ? orderKeptRoutingRefs(input.model, kept)
    : kept.map((aug) => providerRoutingRef(aug.endpoint))

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

function resolveEndpointPolicy(
  endpoint: ModelEndpoint,
  policies: Readonly<Record<string, DataPolicy | undefined>>,
): DataPolicy | undefined {
  if (endpoint.data_policy) return endpoint.data_policy
  for (const key of providerPolicyLookupKeys(endpoint)) {
    const policy = policies[key]
    if (policy) return policy
  }
  return undefined
}

function orderKeptRoutingRefs(model: string, kept: readonly FilteredEndpoint[]): string[] {
  const rule = findPreferredRule(model)
  if (!rule || kept.length <= 1) return kept.map((aug) => providerRoutingRef(aug.endpoint))
  const keptEndpoints = kept.map((row) => row.endpoint)
  const out: FilteredEndpoint[] = []
  const used = new Set<FilteredEndpoint>()
  for (const ref of rule.order) {
    for (const aug of kept) {
      if (used.has(aug)) continue
      if (!endpointMatchesProviderRef(aug.endpoint, ref, keptEndpoints)) continue
      used.add(aug)
      out.push(aug)
    }
  }
  for (const aug of kept) {
    if (used.has(aug)) continue
    out.push(aug)
  }
  return out.map((aug) => providerRoutingRef(aug.endpoint))
}

// Privacy-lock tier. See `plan/09-privacy.md §9.11`. Computed from the
// most-preferred kept endpoint's policy (first element of
// `orderedKeptNames`). `open` means "privacy filter doesn't apply" (free
// model); `unavailable` means kept endpoints exist but no data_policy
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
  //   red    = trains on prompts (hard-denied, but the row + lock still
  //            render so the user can see why)
  //   orange = retains indefinitely OR requires user IDs
  //   yellow = retains prompts for a finite set period (no user IDs)
  //   green  = no retention, no user IDs
  //   red (synthesized) = no policy could be resolved, so assume the worst
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
    existingOnly?: readonly string[]
    existingOrder?: readonly string[]
    userTouchedPicker?: boolean
  } = {},
): WireProviderPrivacy {
  // Unified "allowed vs disallowed" model: if the user has touched the
  // picker, `existingIgnore` is the authoritative set of disallowed
  // providers. The wire does NOT re-layer Pareto/dominated/training/
  // unknown-policy auto-exclusion on top. When the user hasn't touched
  // (default), fall back to `autoIgnore` so the request matches what the
  // picker shows.
  const userTookOver = opts.userTouchedPicker === true
  const allEndpoints = [
    ...result.kept.map((row) => row.endpoint),
    ...result.excluded.map((row) => row.endpoint),
  ]
  const autoIgnore = result.excluded.map((e) => providerRoutingRef(e.endpoint))
  const existingIgnore = resolveProviderRefsToRoutingRefs(allEndpoints, opts.existingIgnore, {
    preserveUnknown: true,
  })
  const existingOnly = resolveProviderRefsToRoutingRefs(allEndpoints, opts.existingOnly, {
    preserveUnknown: true,
  })
  const existingOrder = resolveProviderRefsToRoutingRefs(allEndpoints, opts.existingOrder, {
    preserveUnknown: true,
  })
  const privacyIgnore = userTookOver
    ? []
    : resolveProviderRefsToRoutingRefs(allEndpoints, privacy.ignoreProviders, {
        preserveUnknown: true,
      })
  const mergedIgnore = userTookOver
    ? uniqueStrings([...existingIgnore])
    : uniqueStrings([...autoIgnore, ...privacyIgnore])
  const allowedAfterManualOverride = userTookOver
    ? allEndpoints.some((endpoint) => !endpointMatchesAnyProviderRef(endpoint, mergedIgnore, allEndpoints))
    : false
  const wire: WireProviderPrivacy = {
    zeroEligible: userTookOver && allowedAfterManualOverride ? false : result.zeroEligible,
  }
  if (mergedIgnore.length > 0) wire.ignore = mergedIgnore
  if (!userTookOver && privacy.onlyProviders.length > 0) {
    // When the user pins a set, echo the kept survivors (post-Pareto) so
    // the request matches what the UI shows. Using `onlyProviders`
    // verbatim would send providers that Pareto / hard-deny already
    // excluded, which would surprise the user.
    wire.only = result.kept.map((k) => providerRoutingRef(k.endpoint))
  } else if (existingOnly.length > 0) {
    wire.only = existingOnly
  }
  if (existingOrder.length > 0) {
    wire.order = existingOrder
  } else if (result.orderedKeptNames.length > 1) {
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

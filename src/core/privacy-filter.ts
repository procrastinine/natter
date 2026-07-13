// Given the live `/endpoints` rows + scraped `data_policy` map for a model,
// produce the final routing decision for a request:
//
//   1. Resolve live per-endpoint policy from /endpoints or the OpenRouter
//      providers scrape. Missing online policy is "unavailable", not guessed.
//   2. Hard-deny — drop endpoints with training: true OR trainingOpenRouter: true.
//   3. Pareto-dominance exclusion, IF `privacy.paretoFilter`.
//   4. Preserve the filtered endpoint order for UI rendering. Request-time provider
//      order comes only from visible `providerPrefs.sort` / `providerPrefs.order`.
//
// The result exposes both `kept` and `excluded` with per-endpoint reasons
// so the provider picker can render "auto-excluded: Requires user IDs"
// tooltips without recomputing the filter itself.
//
// This function is pure. It takes endpoints + policies + privacy prefs
// and produces a decision. The scraper and hook layers feed it; the
// request composer consumes `buildWireProviderPrivacy`.

import { dominates, synthesizeDataPolicy } from './privacy'
import { fallbackDataPolicyForEndpoint } from './privacy-fallbacks'
import {
  endpointMatchesAnyProviderRef,
  providerPolicyLookupKeys,
  providerRoutingRef,
  resolveProviderRefsToRoutingRefs,
} from './provider-identity'
import type { DataPolicy, ModelEndpoint, PrivacyPrefs } from './types'

export type ExclusionReason =
  | 'training'
  | 'training-openrouter'
  | 'dominated'
  | 'unknown-policy'
  | 'user-ignored'
  | 'not-in-only-list'

interface FilteredEndpoint {
  endpoint: ModelEndpoint
  policy: DataPolicy | undefined
  // True only when the caller explicitly requested the offline safety
  // fallback. Online misses remain `policy: undefined` so the UI doesn't
  // claim a live policy says the provider trains.
  policySynthesized: boolean
}

interface ExcludedEndpoint extends FilteredEndpoint {
  reasons: ExclusionReason[]
}

export interface PrivacyFilterResult {
  kept: FilteredEndpoint[]
  excluded: ExcludedEndpoint[]
  // True when hard-deny + Pareto leaves zero providers.
  // The UI renders a zero-eligible modal; the request is blocked.
  zeroEligible: boolean
}

interface PrivacyFilterInput {
  model: string
  endpoints: readonly ModelEndpoint[]
  policies: Readonly<Record<string, DataPolicy | undefined>>
  privacy: PrivacyPrefs
  missingPolicyMode?: 'unavailable' | 'offline-worst-case'
}

export function filterEndpointsByPrivacy(input: PrivacyFilterInput): PrivacyFilterResult {
  const { endpoints, policies, privacy } = input

  // Step 1 — resolve the per-endpoint policy. Prefer scraped/cached policy
  // data over policy data embedded in the endpoint row, then use curated
  // fallback policies only for the documented hosts that need an offline
  // default. Lookups use every known identity (slug, display name,
  // provider_name, provider_model_id, row id), so duplicate display names
  // stay distinct while old name-keyed caches/settings still resolve.
  type AugmentedEndpoint = FilteredEndpoint
  const augmented: AugmentedEndpoint[] = endpoints.map((ep) => {
    const raw = resolveEndpointPolicy(input.model, ep, policies)
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

  // Step 3 — Pareto exclusion, opt-out via `paretoFilter: false`. An
  // endpoint is dominated iff some OTHER scoped endpoint dominates it.
  let kept = afterDeny
  if (privacy.paretoFilter) {
    const undominated = afterDeny.filter((aug) => {
      for (const other of afterDeny) {
        if (other === aug) continue
        if (!other.policy || !aug.policy) continue
        if (dominates(other.policy, aug.policy)) return false
      }
      return true
    })
    for (const aug of afterDeny) {
      if (!undominated.includes(aug)) excludeWith(aug, 'dominated')
    }
    kept = undominated
  }

  const excluded: ExcludedEndpoint[] = []
  for (const aug of augmented) {
    const rs = reasons.get(aug)
    if (!rs || rs.length === 0) continue
    excluded.push({ ...aug, reasons: [...rs] })
  }

  return {
    kept,
    excluded,
    zeroEligible: kept.length === 0 && endpoints.length > 0,
  }
}

function resolveEndpointPolicy(
  model: string,
  endpoint: ModelEndpoint,
  policies: Readonly<Record<string, DataPolicy | undefined>>,
): DataPolicy | undefined {
  for (const key of providerPolicyLookupKeys(endpoint)) {
    const policy = policies[key]
    if (policy) return policy
  }
  if (endpoint.data_policy) return endpoint.data_policy
  const fallback = fallbackDataPolicyForEndpoint(model, endpoint)
  if (fallback) return fallback
  return undefined
}

// Privacy-lock tier computed from the kept endpoints' policies. `open` means
// the privacy filter does not apply (free model); `unavailable` means kept
// data_policy survives through to describe them.
export type PrivacyTier = 'green' | 'yellow' | 'orange' | 'red' | 'open' | 'unavailable'

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
  const retainsUnknownPeriod = policy.retainsPrompts && policy.retentionDays === undefined
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
  const mergedIgnore = userTookOver
    ? uniqueStrings([...existingIgnore])
    : uniqueStrings([...autoIgnore])
  const allowedAfterManualOverride = userTookOver
    ? allEndpoints.some(
        (endpoint) => !endpointMatchesAnyProviderRef(endpoint, mergedIgnore, allEndpoints),
      )
    : false
  const wire: WireProviderPrivacy = {
    zeroEligible: userTookOver && allowedAfterManualOverride ? false : result.zeroEligible,
  }
  if (mergedIgnore.length > 0) wire.ignore = mergedIgnore
  if (existingOnly.length > 0) {
    wire.only = existingOnly
  }
  if (existingOrder.length > 0) {
    wire.order = existingOrder
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

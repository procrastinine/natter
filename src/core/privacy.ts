// Privacy policy helpers. See `plan/09-privacy.md §9.5–§9.6`.

import { UNKNOWN_POLICY } from './defaults'
import type { DataPolicy } from './types'

// Accepts a possibly-missing policy (endpoint that wasn't in the scrape, or a fresh
// provider) and returns a concrete `DataPolicy`. Missing data is treated as worst-case
// so the hard-deny and Pareto-dominance filters exclude the endpoint by default.
// Always returns a deep copy of the synthetic policy so callers can mutate freely.
export function synthesizeDataPolicy(raw: DataPolicy | null | undefined): DataPolicy {
  if (raw) return raw
  return structuredClone(UNKNOWN_POLICY)
}

// Tier-based dominance (per user spec 2026-04-19). `a` dominates `b` iff
// `a` sits in a strictly better tier than `b` (green < yellow < orange <
// red). Same-tier pairs don't dominate; the visible provider sort/manual
// order decides request order. This replaces the old 4-dimensional check;
// the tier computation already folds
// training/retention/user-IDs into a single axis, and the user wants the
// filter to auto-exclude the worse tier by default (e.g. Google Vertex
// orange drops out when Google AI Studio yellow is present).
export function dominates(a: DataPolicy | undefined, b: DataPolicy | undefined): boolean {
  if (!a || !b) return false
  return tierRank(a) < tierRank(b)
}

// Mirrors `privacyTierForPolicy` in `privacy-filter.ts`. Lower rank =
// more private; `dominates` returns true when the caller has a lower
// rank than the comparison target.
function tierRank(p: DataPolicy): number {
  if (p.training || p.trainingOpenRouter) return 3
  const userIds = p.requiresUserIDs === true
  const retainsUnknownPeriod = p.retainsPrompts && p.retentionDays === undefined
  if (retainsUnknownPeriod) return 2
  if (userIds) return 2
  if (p.retainsPrompts) return 1
  return 0
}

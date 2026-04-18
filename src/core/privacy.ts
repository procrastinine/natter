// Privacy policy helpers. See `plan/09-privacy.md §9.5–§9.6`.

import { UNKNOWN_POLICY } from './defaults'
import type { DataPolicy } from './types'

// Accepts a possibly-missing policy (endpoint that wasn't in the scrape, or a fresh
// provider) and returns a concrete `DataPolicy`. Missing data is treated as worst-case
// so the hard-deny and Pareto-dominance filters exclude the endpoint by default.
// Always returns a deep copy of the synthetic policy so callers can mutate freely.
export function synthesizeDataPolicy(raw: DataPolicy | null | undefined): DataPolicy {
  if (raw) return raw
  return structuredClone(UNKNOWN_POLICY) as DataPolicy
}

// Four-dimensional dominance used by the privacy filter. `a` dominates `b` iff
// `a` is weakly better on every dimension AND strictly better on at least one.
// Mirrors the helpers in `plan/09-privacy.md §9.6`.
export function dominates(a: DataPolicy | undefined, b: DataPolicy | undefined): boolean {
  if (!a || !b) return false
  const dims: Array<[number, number]> = [
    [trainingRank(a), trainingRank(b)],
    [trainingOrRank(a), trainingOrRank(b)],
    [retentionRank(a), retentionRank(b)],
    [userIdRank(a), userIdRank(b)],
  ]
  return dims.every(([x, y]) => x <= y) && dims.some(([x, y]) => x < y)
}

function trainingRank(p: DataPolicy): 0 | 1 {
  return p.training ? 1 : 0
}

function trainingOrRank(p: DataPolicy): 0 | 1 {
  return p.trainingOpenRouter ? 1 : 0
}

function retentionRank(p: DataPolicy): number {
  if (!p.retainsPrompts) return 0
  if (p.retentionDays === undefined) return Number.POSITIVE_INFINITY
  return p.retentionDays
}

function userIdRank(p: DataPolicy): 0 | 1 {
  return p.requiresUserIDs ? 1 : 0
}

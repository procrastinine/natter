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

export function dominates(a: DataPolicy | undefined, b: DataPolicy | undefined): boolean {
  if (!a || !b) return false
  const leftTier = privacyPolicyTierRank(a)
  const rightTier = privacyPolicyTierRank(b)
  if (leftTier !== rightTier) return leftTier < rightTier
  const left = [
    Number(a.training),
    Number(a.trainingOpenRouter),
    retentionRank(a),
    Number(a.requiresUserIDs === true),
  ]
  const right = [
    Number(b.training),
    Number(b.trainingOpenRouter),
    retentionRank(b),
    Number(b.requiresUserIDs === true),
  ]
  return (
    left.every((value, index) => value <= (right[index] as number)) &&
    left.some((value, index) => value < (right[index] as number))
  )
}

function privacyPolicyTierRank(policy: DataPolicy): number {
  if (policy.training || policy.trainingOpenRouter) return 3
  if (
    policy.requiresUserIDs === true ||
    (policy.retainsPrompts && policy.retentionDays === undefined)
  ) {
    return 2
  }
  return policy.retainsPrompts ? 1 : 0
}

function retentionRank(policy: DataPolicy): number {
  if (!policy.retainsPrompts) return 0
  return policy.retentionDays === undefined
    ? Number.POSITIVE_INFINITY
    : 1 + Math.max(0, policy.retentionDays)
}

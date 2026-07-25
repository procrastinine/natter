import type { InteractionCapabilityInventory } from './interaction-capability-inventory.mjs'

export interface InteractionCapabilityAuditCounts {
  readonly sites: number
  readonly sources: number
  readonly reviewedClassifications: number
  readonly derivedClassifications: number
  readonly exactOutcomeProofSites: number
  readonly sourceContractLifecycleSites: number
  readonly sourceLevelCandidateSites: number
  readonly inheritedAggregateGateSites: number
  readonly localGateSites: number
  readonly asyncSites: number
  readonly unresolvedAsyncErrorOwnerSites: number
  readonly structuralFallbackIdentitySites: number
  readonly classificationGapSites: number
  readonly architectureGapSites: number
  readonly behavioralOutcomeGapSites: number
  readonly gapSites: number
}

export interface InteractionCapabilityAuditResult {
  readonly structurallyValid: boolean
  readonly classificationClosed: boolean
  readonly behavioralOutcomesClosed: boolean
  readonly counts: InteractionCapabilityAuditCounts
  readonly classificationGapReasons: Readonly<Record<string, number>>
  readonly architectureGapReasons: Readonly<Record<string, number>>
  readonly behavioralOutcomeGapReasons: Readonly<Record<string, number>>
  readonly problems: readonly string[]
  readonly inventory: InteractionCapabilityInventory
}

export function auditInteractionCapabilities(options?: {
  readonly root?: string
  readonly inventory?: InteractionCapabilityInventory
}): InteractionCapabilityAuditResult

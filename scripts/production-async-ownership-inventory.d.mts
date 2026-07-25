import type { ReviewedCandidateDisposition } from './reviewed-candidate-dispositions.mjs'

export interface ProductionModuleClassification {
  readonly domain: string
  readonly layer: string
}

export interface ProductionAsyncFunction {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly column: number
  readonly siteText: string
  readonly owner: string
  readonly errorStrategy: string
  readonly cancellationAware: boolean
  readonly awaitInLoopCount: number
  readonly awaitSites: readonly unknown[]
  readonly hasFinally: boolean
  readonly domain: string
}

export interface ProductionDetachedPromiseSite {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly column: number
  readonly siteText: string
  readonly kind: string
  readonly failureOwnership: 'syntactic-handler' | 'unproved'
}

export interface ProductionAsyncOwnershipInventory {
  readonly functions: readonly ProductionAsyncFunction[]
  readonly detached: readonly ProductionDetachedPromiseSite[]
  readonly syntacticGaps: readonly { readonly id: string; readonly path: string; readonly line: number }[]
  readonly reviews: readonly ReviewedCandidateDisposition[]
  readonly reviewProblems: readonly string[]
  readonly dispositionCounts: Readonly<Record<ReviewedCandidateDisposition['disposition'], number>>
  readonly gaps: readonly { readonly id: string; readonly path: string; readonly line: number }[]
  readonly disposition: string
  readonly counts: {
    readonly functions: number
    readonly awaitSites: number
    readonly functionsWithCatch: number
    readonly functionsWithFinally: number
    readonly cancellationAwareFunctions: number
    readonly awaitInLoopSites: number
    readonly detachedSites: number
    readonly unprovedDetachedFailures: number
    readonly reviewedArchitectureGaps: number
  }
  readonly errorStrategyCounts: Readonly<Record<string, number>>
  readonly detachedKindCounts: Readonly<Record<string, number>>
  readonly domainCounts: Readonly<Record<string, number>>
}

export function buildProductionAsyncOwnershipInventory(
  root?: string,
): ProductionAsyncOwnershipInventory

export function inventoryAsyncOwnershipInSource(
  path: string,
  sourceText: string,
  classification: ProductionModuleClassification,
): {
  readonly functions: readonly ProductionAsyncFunction[]
  readonly detached: readonly ProductionDetachedPromiseSite[]
}

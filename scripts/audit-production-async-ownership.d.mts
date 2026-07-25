import type { ProductionAsyncOwnershipInventory } from './production-async-ownership-inventory.mjs'

export type ProductionAsyncOwnershipAuditMode = 'enforce' | 'inventory'

export interface ProductionAsyncOwnershipAuditReport {
  readonly mode: ProductionAsyncOwnershipAuditMode
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly inventoryComplete: boolean
  readonly manifestFresh: boolean
  readonly guaranteeClosed: boolean
  readonly runtimeProved: null
  readonly functions: number
  readonly awaitSites: number
  readonly functionsWithCatch: number
  readonly functionsWithFinally: number
  readonly cancellationAwareFunctions: number
  readonly awaitInLoopSites: number
  readonly detachedSites: number
  readonly unprovedDetachedFailures: number
  readonly reviewedArchitectureGaps: number
  readonly errorStrategyCounts: Readonly<Record<string, number>>
  readonly detachedKindCounts: Readonly<Record<string, number>>
  readonly domainCount: number
  readonly syntacticGapCount: number
  readonly dispositionCounts: Readonly<Record<string, number>>
  readonly structuralProblemCount: number
  readonly gapCount: number
  readonly gaps: ProductionAsyncOwnershipInventory['gaps']
  readonly problems: readonly string[]
}

export function evaluateProductionAsyncOwnership(
  inventory: ProductionAsyncOwnershipInventory,
  mode?: ProductionAsyncOwnershipAuditMode,
): ProductionAsyncOwnershipAuditReport

export function formatProductionAsyncOwnershipReport(
  report: ProductionAsyncOwnershipAuditReport,
  summaryOnly?: boolean,
): string

export function parseProductionAsyncOwnershipArguments(args: readonly string[]): {
  readonly mode: ProductionAsyncOwnershipAuditMode
  readonly summaryOnly: boolean
}

export function validateProductionAsyncOwnershipInventory(
  inventory: ProductionAsyncOwnershipInventory,
): string[]

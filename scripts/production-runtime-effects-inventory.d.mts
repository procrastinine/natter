import type { ReviewedCandidateDisposition } from './reviewed-candidate-dispositions.mjs'

export interface ProductionRuntimeEffectSite {
  readonly id: string
  readonly path: string
  readonly line: number
  readonly column: number
  readonly siteText: string
  readonly domain: string
  readonly layer: string
  readonly capability: string
  readonly locality: string
  readonly owner: string
  readonly effectKind: string
  readonly action: string
  readonly requiresRelease: boolean
  readonly releaseEvidence: string
}

export interface ProductionRuntimeEffectInventory {
  readonly sites: readonly ProductionRuntimeEffectSite[]
  readonly syntacticGaps: readonly { readonly id: string; readonly path: string; readonly line: number }[]
  readonly reviews: readonly ReviewedCandidateDisposition[]
  readonly reviewProblems: readonly string[]
  readonly dispositionCounts: Readonly<Record<ReviewedCandidateDisposition['disposition'], number>>
  readonly gaps: readonly { readonly id: string; readonly path: string; readonly line: number }[]
  readonly disposition: string
  readonly counts: {
    readonly sites: number
    readonly missingReleaseEvidence: number
    readonly reviewedArchitectureGaps: number
  }
}

export function buildProductionRuntimeEffectInventory(
  root?: string,
): ProductionRuntimeEffectInventory

export function inventoryRuntimeEffectsInSource(
  path: string,
  sourceText: string,
  classification: { readonly domain: string; readonly layer: string },
): readonly ProductionRuntimeEffectSite[]

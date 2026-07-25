import type {
  ArchitectureAuditMechanism,
  ArchitectureDimensionClosure,
  ArchitectureVerificationStageClassification,
} from './architecture-inventory-closure-manifest.mjs'

export interface ArchitectureInventoryClosureManifest {
  readonly ARCHITECTURE_INVENTORY_CLOSURE_SCHEMA_VERSION: number
  readonly VERIFICATION_STAGE_CLASSIFICATIONS: readonly ArchitectureVerificationStageClassification[]
  readonly ARCHITECTURE_AUDIT_MECHANISMS: readonly ArchitectureAuditMechanism[]
  readonly ARCHITECTURE_DIMENSION_CLOSURE: readonly ArchitectureDimensionClosure[]
}

export interface ArchitectureInventoryClosureReport {
  readonly mode: 'inventory' | 'enforce'
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly actualStageCount: number
  readonly classifiedStageCount: number
  readonly integratedClassifiedStageCount: number
  readonly requiredIntegrationCount: number
  readonly missingIntegrationCount: number
  readonly orientationCounts: Readonly<Record<string, number>>
  readonly mechanismCount: number
  readonly dimensionCount: number
  readonly openDimensionCount: number
  readonly openGapCount: number
  readonly mechanismIds: readonly string[]
  readonly dimensions: readonly ArchitectureDimensionClosure[]
  readonly integrationGaps: readonly ArchitectureInventoryClosureGap[]
  readonly gaps: readonly ArchitectureInventoryClosureGap[]
  readonly problems: readonly string[]
}

export interface ArchitectureInventoryClosureGap {
  readonly kind: string
  readonly id: string
  readonly detail: string
}

export function auditArchitectureInventoryClosure(options?: {
  readonly root?: string
  readonly mode?: 'inventory' | 'enforce'
  readonly manifestPath?: string
  readonly manifest?: ArchitectureInventoryClosureManifest
  readonly stages?: readonly unknown[]
  readonly dimensions?: readonly unknown[]
}): Promise<ArchitectureInventoryClosureReport>

export function validateArchitectureInventoryClosure(options: {
  readonly root: string
  readonly stages: readonly unknown[]
  readonly dimensions: readonly unknown[]
  readonly manifest: ArchitectureInventoryClosureManifest | null
  readonly initialProblems?: readonly string[]
}): Readonly<Record<string, unknown>>

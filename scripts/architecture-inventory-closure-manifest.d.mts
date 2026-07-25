export interface ArchitectureVerificationStageClassification {
  readonly id: string
  readonly label: string
  readonly policy: string
  readonly argv: readonly string[]
  readonly orientation: string
  readonly rationale: string
  readonly requiredIntegration: boolean
  readonly mechanismIds: readonly string[]
}

export interface ArchitectureAuditMechanism {
  readonly id: string
  readonly stageId: string
  readonly orientation: string
  readonly contribution: string
  readonly scannerLimitation: string
}

export interface ArchitectureClosureEvidence {
  readonly id: string
  readonly stageId: string
  readonly path: string
  readonly locator: string
  readonly claim: string
}

export interface ArchitectureDimensionClosure {
  readonly id: string
  readonly additiveMechanisms: readonly string[]
  readonly subtractiveMechanisms: readonly string[]
  readonly supportingStages: readonly string[]
  readonly scannerLimitation: string
  readonly closureCriterion: string
  readonly status: string
  readonly gap: string | null
  readonly closureEvidence: readonly ArchitectureClosureEvidence[]
}

export const ARCHITECTURE_INVENTORY_CLOSURE_SCHEMA_VERSION: 1
export const VERIFICATION_STAGE_CLASSIFICATIONS: readonly ArchitectureVerificationStageClassification[]
export const ARCHITECTURE_AUDIT_MECHANISMS: readonly ArchitectureAuditMechanism[]
export const ARCHITECTURE_DIMENSION_CLOSURE: readonly ArchitectureDimensionClosure[]

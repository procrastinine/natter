export interface ProductionRuntimeEffectsAuditOptions {
  readonly root?: string
  readonly mode?: 'inventory' | 'enforce'
}

export interface ProductionRuntimeEffectsAuditReport {
  readonly mode: 'inventory' | 'enforce'
  readonly ok: boolean
  readonly structurallyValid: boolean
  readonly structuralProblemCount: number
  readonly gapCount: number
  readonly gaps: readonly { readonly id: string }[]
  readonly problems: readonly string[]
  readonly [key: string]: unknown
}

export function auditProductionRuntimeEffects(
  options?: ProductionRuntimeEffectsAuditOptions,
): ProductionRuntimeEffectsAuditReport

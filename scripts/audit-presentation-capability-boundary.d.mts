export interface PresentationCapabilityBoundaryAuditResult {
  readonly ok: boolean
  readonly requiredConsumers: number
  readonly violations: readonly string[]
}

export function auditPresentationCapabilityBoundary(
  root?: string,
): PresentationCapabilityBoundaryAuditResult

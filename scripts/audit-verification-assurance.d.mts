import type { VerificationStage } from './run-verification.mjs'

export interface VerificationAssuranceAuditReport {
  readonly ok: boolean
  readonly inventoryStageCount: number
  readonly problems: readonly string[]
}

export function auditVerificationAssurance(
  root?: string,
  stages?: readonly VerificationStage[],
): VerificationAssuranceAuditReport

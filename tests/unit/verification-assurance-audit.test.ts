import { describe, expect, it } from 'vitest'
import { auditVerificationAssurance } from '../../scripts/audit-verification-assurance.mjs'
import { VERIFICATION_STAGES } from '../../scripts/run-verification.mjs'

describe('verification assurance meta-audit', () => {
  it('requires every inventory-only stage to expose closure separately from structural freshness', () => {
    const report = auditVerificationAssurance()

    expect(report).toEqual({
      ok: true,
      inventoryStageCount: VERIFICATION_STAGES.filter((stage) => stage.argv.includes('inventory'))
        .length,
      problems: [],
    })
  })
})

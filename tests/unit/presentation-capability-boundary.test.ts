import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditPresentationCapabilityBoundary } from '../../scripts/audit-presentation-capability-boundary.mjs'

describe('presentation capability boundary', () => {
  it('rejects boolean capability props and transient capability copy', () => {
    const result = auditPresentationCapabilityBoundary(resolve(__dirname, '../..'))
    expect(result.violations, result.violations.join('\n')).toEqual([])
    expect(result.requiredConsumers).toBeGreaterThan(0)
  })
})

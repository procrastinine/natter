import { describe, expect, it } from 'vitest'
import { staticAuditState } from '../../scripts/audit-result-state.mjs'

describe('architecture audit result state', () => {
  it('does not promote a fresh inventory with open gaps to a closed guarantee', () => {
    expect(staticAuditState({ structurallyValid: true, gaps: [{ id: 'open' }] })).toEqual({
      inventoryComplete: true,
      manifestFresh: true,
      guaranteeClosed: false,
      runtimeProved: null,
    })
  })

  it('keeps structural drift distinct from runtime proof', () => {
    expect(staticAuditState({ structurallyValid: false })).toEqual({
      inventoryComplete: false,
      manifestFresh: false,
      guaranteeClosed: false,
      runtimeProved: null,
    })
  })
})

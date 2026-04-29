import { describe, expect, it } from 'vitest'
import { UNKNOWN_POLICY } from '../../src/core/defaults'
import { dominates, synthesizeDataPolicy } from '../../src/core/privacy'
import type { DataPolicy } from '../../src/core/types'

const clean: DataPolicy = {
  training: false,
  trainingOpenRouter: false,
  retainsPrompts: false,
  canPublish: false,
  termsOfServiceURL: 'https://example.com/tos',
  privacyPolicyURL: 'https://example.com/privacy',
}

const shortRetention: DataPolicy = {
  ...clean,
  retainsPrompts: true,
  retentionDays: 30,
  requiresUserIDs: true,
}

const unknownRetention: DataPolicy = {
  ...clean,
  retainsPrompts: true,
  requiresUserIDs: true,
}

describe('synthesizeDataPolicy', () => {
  it('returns the worst-case policy for missing input', () => {
    expect(synthesizeDataPolicy(undefined)).toEqual(UNKNOWN_POLICY)
    expect(synthesizeDataPolicy(null)).toEqual(UNKNOWN_POLICY)
  })

  it('returns a fresh object so callers can mutate', () => {
    const a = synthesizeDataPolicy(undefined)
    const b = synthesizeDataPolicy(undefined)
    expect(a).not.toBe(b)
    a.training = false
    expect(UNKNOWN_POLICY.training).toBe(true)
  })

  it('passes a present policy through unchanged', () => {
    expect(synthesizeDataPolicy(clean)).toBe(clean)
  })
})

describe('dominates', () => {
  it('clean dominates short retention (Bedrock vs Anthropic case)', () => {
    expect(dominates(clean, shortRetention)).toBe(true)
    expect(dominates(shortRetention, clean)).toBe(false)
  })

  it('clean dominates unknown-period retention (Azure vs OpenAI case)', () => {
    expect(dominates(clean, unknownRetention)).toBe(true)
  })

  it('same-tier policies do not dominate (e.g. both orange — userIDs+any retention)', () => {
    // Per the 2026-04-19 tier-based dominance rule, two policies in the
    // same tier don't dominate each other. `shortRetention` (30d +
    // userIDs) and `unknownRetention` (indefinite + userIDs) are both
    // orange — neither drops the other; the visible provider sort/manual
    // order decides request order.
    expect(dominates(shortRetention, unknownRetention)).toBe(false)
    expect(dominates(unknownRetention, shortRetention)).toBe(false)
  })

  it('AI Studio dominates Vertex (yellow vs orange for Gemini)', () => {
    // Per user spec 2026-04-19: when Pareto sees Google Vertex (orange,
    // requires user IDs) next to Google AI Studio (yellow, 55d retention
    // without user IDs), only AI Studio is kept by default. Users can
    // re-enable Vertex via the picker.
    const aiStudio: DataPolicy = {
      ...clean,
      retainsPrompts: true,
      retentionDays: 55,
      requiresUserIDs: false,
    }
    const vertex: DataPolicy = {
      ...clean,
      requiresUserIDs: true,
    }
    expect(dominates(aiStudio, vertex)).toBe(true)
    expect(dominates(vertex, aiStudio)).toBe(false)
  })

  it('missing policies cannot be compared', () => {
    expect(dominates(undefined, clean)).toBe(false)
    expect(dominates(clean, undefined)).toBe(false)
  })
})

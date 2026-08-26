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

  it('finite retention dominates unknown retention when the other dimensions match', () => {
    expect(dominates(shortRetention, unknownRetention)).toBe(true)
    expect(dominates(unknownRetention, shortRetention)).toBe(false)
  })

  it('the better category wins before within-category Pareto comparison', () => {
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

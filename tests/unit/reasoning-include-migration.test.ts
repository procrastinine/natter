// Phase 11: legacy `reasoning.carryForward` → `reasoning.include` migrator.

import { describe, expect, it } from 'vitest'
import {
  defaultReasoningInclude,
  migrateCarryForwardToInclude,
} from '../../src/core/reasoning'

describe('migrateCarryForwardToInclude', () => {
  it("'off' → all false", () => {
    expect(migrateCarryForwardToInclude('off', 'openai-responses-v1')).toEqual({
      encrypted: false,
      summary: false,
      text: false,
    })
  })

  it("'plaintext' → summary+text", () => {
    expect(migrateCarryForwardToInclude('plaintext', 'anthropic-claude-v1')).toEqual({
      encrypted: false,
      summary: true,
      text: true,
    })
  })

  it("'encrypted' → encrypted only", () => {
    expect(migrateCarryForwardToInclude('encrypted', 'openai-responses-v1')).toEqual({
      encrypted: true,
      summary: false,
      text: false,
    })
  })

  it("'auto' → encrypted-only default (summary requested for UI, not echoed)", () => {
    for (const fmt of [
      'openai-responses-v1',
      'azure-openai-responses-v1',
      'anthropic-claude-v1',
      'google-gemini-v1',
      'xai-responses-v1',
      'unknown',
      undefined,
    ] as const) {
      expect(migrateCarryForwardToInclude('auto', fmt)).toEqual({
        encrypted: true,
        summary: false,
        text: false,
      })
    }
  })

  it('undefined legacy also falls through to the default', () => {
    expect(migrateCarryForwardToInclude(undefined, 'openai-responses-v1')).toEqual({
      encrypted: true,
      summary: false,
      text: false,
    })
  })
})

describe('defaultReasoningInclude', () => {
  it('encrypted-only for every format — visible summary is for UI, not context', () => {
    for (const fmt of [
      'openai-responses-v1',
      'azure-openai-responses-v1',
      'anthropic-claude-v1',
      'google-gemini-v1',
      'xai-responses-v1',
      'unknown',
      undefined,
    ] as const) {
      expect(defaultReasoningInclude(fmt)).toEqual({
        encrypted: true,
        summary: false,
        text: false,
      })
    }
  })
})

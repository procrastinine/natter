import { describe, expect, it } from 'vitest'
import {
  AVAILABLE_GENERATION_CAPABILITY,
  connectionAvailabilityFromProfileCount,
  failedGenerationCapability,
  generationCapabilityAvailable,
  generationUnavailableReason,
  pendingGenerationCapability,
  unavailableGenerationCapability,
} from '../../src/core/interaction-capability'

describe('interaction capability', () => {
  it.each([
    [undefined, 'unknown'],
    [0, 'missing'],
    [1, 'available'],
    [100, 'available'],
  ] as const)('maps exact profile count %s to %s', (count, expected) => {
    expect(connectionAvailabilityFromProfileCount(count)).toBe(expected)
  })

  it('keeps the owner and terminal reason in one discriminated capability algebra', () => {
    expect(pendingGenerationCapability('workspace')).toEqual({
      state: 'pending',
      owner: 'workspace',
    })
    expect(failedGenerationCapability('configuration')).toEqual({
      state: 'failed',
      owner: 'configuration',
    })
    expect(unavailableGenerationCapability('target-unavailable')).toEqual({
      state: 'unavailable',
      reason: 'target-unavailable',
    })
    expect(generationCapabilityAvailable(AVAILABLE_GENERATION_CAPABILITY)).toBe(true)
  })

  it('publishes user-facing copy only for exact absence', () => {
    expect(
      generationUnavailableReason(pendingGenerationCapability('configuration'), 'send'),
    ).toBeUndefined()
    expect(generationUnavailableReason(AVAILABLE_GENERATION_CAPABILITY, 'send')).toBeUndefined()
    expect(
      generationUnavailableReason(unavailableGenerationCapability('connection-missing'), 'send'),
    ).toBe('Add a connection to send messages.')
  })

  it('reuses bounded capability values instead of allocating per visible message', () => {
    expect(pendingGenerationCapability('prompt-path')).toBe(
      pendingGenerationCapability('prompt-path'),
    )
    expect(unavailableGenerationCapability('configuration-missing')).toBe(
      unavailableGenerationCapability('configuration-missing'),
    )
  })
})

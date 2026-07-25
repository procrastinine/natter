import { describe, expect, it } from 'vitest'
import {
  type AttemptAvailabilityInput,
  type AttemptStopIntent,
  type LocalAttemptAuthority,
  reduceAttemptAvailability,
  seedRecoveryPendingStreamLease,
} from '../../src/store/attempt-availability'
import type { StreamLeaseRow, WorkspaceFence } from '../../src/store/repository'
import {
  testGenerationLease,
  testRecoveryPendingLease,
  testStreamLeaseAdmission,
} from '../helpers/stream-leases'

const workspace: WorkspaceFence = { workspaceId: 'workspace', replacementEpoch: 3 }

describe('attempt availability', () => {
  it('requires exact runtime authority before presenting a local stream', () => {
    const lease = testGenerationLease({
      streamId: 'stream',
      chatId: 'chat',
      messageId: 'message',
      replacementEpoch: 3,
      admissionSequence: 7,
      ownerClientId: 'local',
      fenceToken: 'fence',
      heartbeatAt: 100,
    })
    const falseLocal = reduce(lease, {
      localAuthority: { kind: 'none' },
      localExecutionPhase: 'streaming',
      ownershipLock: { kind: 'unobserved' },
    })
    expect(falseLocal.presentation).toBe('none')
    expect(falseLocal.state).toBe('provisional')
    expect(falseLocal.recovery.kind).toBe('probe-lock')

    const localAuthority: LocalAttemptAuthority = {
      kind: 'writer',
      workspaceId: workspace.workspaceId,
      lease,
    }
    const exactLocal = reduce(lease, {
      localAuthority,
      localExecutionPhase: 'streaming',
      ownershipLock: { kind: 'unobserved' },
    })
    expect(exactLocal.presentation).toBe('local-streaming')
    expect(exactLocal.state).toBe('local-executing')
    expect(exactLocal.recovery).toEqual({ kind: 'none' })
  })

  it('presents remote streaming only from an active writer plus held lock evidence', () => {
    const lease = testGenerationLease({
      streamId: 'stream',
      replacementEpoch: 3,
      heartbeatAt: 100,
    })
    for (const ownershipLock of [
      { kind: 'unobserved' } as const,
      { kind: 'unsupported' } as const,
      { kind: 'acquired-for-recovery', streamId: lease.streamId } as const,
    ]) {
      expect(reduce(lease, { ownershipLock }).presentation).toBe('none')
    }
    expect(
      reduce(lease, {
        ownershipLock: { kind: 'held-by-other', streamId: lease.streamId, observedAt: 10 },
      }),
    ).toMatchObject({
      state: 'remote-executing',
      presentation: 'remote-streaming',
      recovery: { kind: 'wait-owner-release' },
    })

    const reserved = testGenerationLease({
      streamId: 'reserved',
      replacementEpoch: 3,
      phase: 'reserved',
    })
    expect(
      reduce(reserved, {
        ownershipLock: { kind: 'held-by-other', streamId: reserved.streamId, observedAt: 10 },
      }).presentation,
    ).toBe('none')
  })

  it('uses freshness only to schedule recovery when Web Locks are unsupported', () => {
    const fresh = testGenerationLease({
      streamId: 'fresh',
      replacementEpoch: 3,
      heartbeatAt: 100,
    })
    expect(
      reduce(fresh, {
        wallNow: 100,
        schedulerNow: 1_000,
        ownershipLock: { kind: 'unsupported' },
      }).recovery,
    ).toMatchObject({ kind: 'wait-owner-release', deadline: 16_000 })
    const stale = testGenerationLease({
      streamId: 'stale',
      replacementEpoch: 3,
      heartbeatAt: 1,
    })
    expect(
      reduce(stale, {
        wallNow: 20_000,
        schedulerNow: 1_000,
        ownershipLock: { kind: 'unsupported' },
      }).recovery,
    ).toMatchObject({ kind: 'claim' })
    expect(
      reduce(testRecoveryPendingLease({ streamId: 'pending', replacementEpoch: 3 }), {
        ownershipLock: { kind: 'unsupported' },
      }).recovery,
    ).toMatchObject({ kind: 'claim' })
  })

  it('keeps Stop level-triggered through unknown evidence and settles only terminal facts', () => {
    const lease = testGenerationLease({
      streamId: 'stream',
      chatId: 'chat',
      messageId: 'message',
      replacementEpoch: 3,
      admissionSequence: 7,
    })
    const intent: AttemptStopIntent = {
      workspaceId: 'workspace',
      replacementEpoch: 3,
      streamId: 'stream',
      chatId: 'chat',
      messageId: 'message',
      attemptKind: 'generation',
      admissionSequence: 7,
      requestId: 'stop',
      requestedAt: 10,
    }
    const requesting = reduce(lease, { stopIntent: intent })
    expect(requesting.stop.kind).toBe('reconcile')
    const unknown = reduceAttemptAvailability(requesting, {
      ...baseInput(),
      lease: { kind: 'unknown' },
      stopIntent: intent,
    })
    expect(unknown.stop.kind).toBe('reconcile')
    expect(unknown.presentation).toBe(requesting.presentation)

    const terminalizing = testGenerationLease({
      streamId: 'stream',
      chatId: 'chat',
      messageId: 'message',
      replacementEpoch: 3,
      admissionSequence: 7,
      phase: 'terminal-decided',
    })
    expect(reduce(terminalizing)).toMatchObject({
      state: 'terminalizing',
      stop: { kind: 'requestable' },
      targetAdmission: 'occupied',
    })
    expect(reduce(terminalizing, { stopIntent: intent })).toMatchObject({
      state: 'terminalizing',
      stop: { kind: 'reconcile', intent: { requestId: 'stop' } },
    })

    const terminal = testGenerationLease({
      streamId: 'stream',
      chatId: 'chat',
      messageId: 'message',
      replacementEpoch: 3,
      admissionSequence: 7,
      phase: 'canonical',
    })
    expect(reduce(terminal, { stopIntent: intent })).toMatchObject({
      state: 'settled',
      stop: { kind: 'settled' },
      recovery: { kind: 'probe-lock' },
      targetAdmission: 'available',
      blocksReplacement: false,
    })
    expect(
      reduce(terminal, {
        stopIntent: intent,
        ownershipLock: { kind: 'acquired-for-recovery', streamId: terminal.streamId },
      }),
    ).toMatchObject({
      state: 'settled',
      recovery: { kind: 'claim' },
      targetAdmission: 'available',
      blocksReplacement: false,
    })
    expect(
      reduceAttemptAvailability(requesting, {
        ...baseInput(),
        lease: { kind: 'absent' },
        stopIntent: intent,
      }),
    ).toMatchObject({ state: 'settled', stop: { kind: 'settled' } })
  })

  it('keeps a pre-commit reservation provisional without fabricating an admission sequence', () => {
    const admission = testStreamLeaseAdmission({
      streamId: 'reserved',
      chatId: 'chat',
      messageId: 'message',
      replacementEpoch: 3,
    })
    const availability = reduceAttemptAvailability(undefined, {
      ...baseInput(),
      lease: { kind: 'absent' },
      localAuthority: { kind: 'reservation', workspaceId: 'workspace', admission },
    })
    expect(availability).toMatchObject({
      state: 'reserved',
      presentation: 'none',
      blocksReplacement: true,
      identity: { streamId: 'reserved' },
    })
    expect(availability.identity).not.toHaveProperty('admissionSequence')
  })

  it('seeds old live custody into one deterministic recovery-pending state', () => {
    const lease = testGenerationLease({
      streamId: 'stream',
      replacementEpoch: 2,
      admissionSequence: 9,
      revision: 4,
      controlRevision: 1,
      stopControl: {
        requestId: 'old-stop',
        requestedBy: 'old-owner',
        requestedAt: 1,
        reason: 'user',
      },
    })
    const seeded = seedRecoveryPendingStreamLease({
      lease,
      replacementEpoch: 3,
      handedOffAt: 100,
    })
    expect(seeded).toMatchObject({
      streamId: 'stream',
      replacementEpoch: 3,
      admissionSequence: 9,
      revision: 5,
      custody: 'recovery-pending',
      handoffId: 'migration:3:stream:9',
      handedOffAt: 100,
      handoffReason: 'owner-unavailable',
      controlRevision: 0,
    })
    expect(seeded).not.toHaveProperty('ownerClientId')
    expect(seeded).not.toHaveProperty('fenceToken')
    expect(seeded).not.toHaveProperty('heartbeatAt')
    expect(seeded).not.toHaveProperty('stopControl')
    expect(
      seedRecoveryPendingStreamLease({
        lease: seeded,
        replacementEpoch: 3,
        handedOffAt: 100,
      }),
    ).toBe(seeded)
  })
})

function reduce(lease: StreamLeaseRow, overrides: Partial<AttemptAvailabilityInput> = {}) {
  return reduceAttemptAvailability(undefined, {
    ...baseInput(),
    lease: { kind: 'present', lease },
    ...overrides,
  })
}

function baseInput(): AttemptAvailabilityInput {
  return {
    workspace,
    lease: { kind: 'unknown' },
    localAuthority: { kind: 'none' },
    ownershipLock: { kind: 'unobserved' },
    wallNow: 100,
    schedulerNow: 1_000,
  }
}

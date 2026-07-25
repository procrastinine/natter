import { describe, expect, it, vi } from 'vitest'
import { attemptController } from '../../src/store/attempt-controller'
import {
  type AttemptTerminalPreparation,
  type AttemptTerminalReceipt,
  advanceAttemptTerminalCustody,
  createAttemptTerminalLeaseApplications,
  createAttemptTerminalOwner,
  createWriterAttemptTerminalOwner,
} from '../../src/store/attempt-terminalization'
import type {
  FencedStreamLeaseRow,
  StreamLeaseHandoffReason,
  TerminalDecidedStreamLeaseRow,
} from '../../src/store/repository'
import type { StreamLeaseHandle } from '../../src/store/stream-leases'
import type {
  AttemptTerminalProjection,
  CommitEnvelope,
  GenerationPostCommitMetadataResult,
  StreamFinishCleanupResult,
} from '../../src/store/workspace-protocol'
import type { WorkspaceWritePermit } from '../../src/store/workspace-runtime'
import { testGenerationLease, testRecoveryPendingLease } from '../helpers/stream-leases'

const PROJECTION = {} as AttemptTerminalProjection
const PREPARATION: AttemptTerminalPreparation = {
  finishedAt: 2,
  decision: { outcome: 'done' },
  project: (receipt) => {
    expect(receipt).toEqual(
      expect.objectContaining({ finishedAt: 2, decision: { outcome: 'done' } }),
    )
    return PROJECTION
  },
}

describe('attempt terminal custody', () => {
  it('keeps exact target admission released when cleanup deletes the terminal lease', () => {
    const workspaceId = 'terminal-cleanup-workspace'
    const replacementEpoch = 41
    const chatId = 'terminal-cleanup-chat'
    const streamId = 'terminal-cleanup-stream'
    const messageId = 'terminal-cleanup-message'
    const fence = { workspaceId, replacementEpoch }
    const active = testGenerationLease({
      streamId,
      chatId,
      messageId,
      replacementEpoch,
      revision: 1,
    })
    const canonical = testGenerationLease({
      streamId,
      chatId,
      messageId,
      replacementEpoch,
      phase: 'canonical',
      revision: 3,
      postCommitFinal: { completionAllowed: true, expectedBodyVersion: 2 },
    })
    attemptController.replaceWorkspace(fence)
    const stop = attemptController.subscribeChat(chatId, () => {})
    try {
      attemptController.reconcileChatLeases(fence, chatId, [active])
      attemptController.applyLocalCommittedTransition(
        [{ kind: 'observe-lease', lease: canonical, options: { workspaceId } }],
        () => undefined,
      )
      attemptController.publishExactTargetPresentations([
        { ...fence, streamId, chatId, messageId, bodyVersion: 2 },
      ])
      expect(attemptController.getTargetAdmissionFrame(chatId).admission(messageId)).toBe(
        'available',
      )

      const applications = createAttemptTerminalLeaseApplications({
        chatId,
        streamId,
        workspaceId,
      })
      expect(
        applications.cleanup(
          cleanupCommit(fence, { deletedLease: true, deletedFrames: 1, done: true }),
        ),
      ).toBe('applied')
      expect(attemptController.getTargetAdmissionFrame(chatId).admission(messageId)).toBe(
        'available',
      )
    } finally {
      stop()
    }
  })

  it('releases durable admission at canonical commit while retaining presentation handoff', () => {
    const workspaceId = 'terminal-metadata-workspace'
    const replacementEpoch = 42
    const chatId = 'terminal-metadata-chat'
    const streamId = 'terminal-metadata-stream'
    const messageId = 'terminal-metadata-message'
    const fence = { workspaceId, replacementEpoch }
    const active = testGenerationLease({
      streamId,
      chatId,
      messageId,
      replacementEpoch,
      revision: 1,
    })
    const canonical = testGenerationLease({
      streamId,
      chatId,
      messageId,
      replacementEpoch,
      phase: 'canonical',
      revision: 3,
      postCommitFinal: { completionAllowed: true, expectedBodyVersion: 2 },
    })
    const metadata = testGenerationLease({
      streamId,
      chatId,
      messageId,
      replacementEpoch,
      phase: 'metadata-committed',
      revision: 4,
      postCommitFinal: { completionAllowed: true, expectedBodyVersion: 2 },
    })
    attemptController.replaceWorkspace(fence)
    const stop = attemptController.subscribeTarget(chatId, messageId, () => {})
    try {
      attemptController.reconcileChatLeases(fence, chatId, [active])
      attemptController.observeLease(active, { workspaceId })
      attemptController.applyLocalCommittedTransition(
        [{ kind: 'observe-lease', lease: canonical, options: { workspaceId } }],
        () => undefined,
      )
      expect(attemptController.getTargetAdmissionFrame(chatId).admission(messageId)).toBe(
        'available',
      )
      expect(attemptController.getTargetSnapshot(chatId, messageId).presentation).toMatchObject({
        streamId,
        targetCommitHandoff: { bodyVersion: 2 },
      })

      const applications = createAttemptTerminalLeaseApplications({
        chatId,
        streamId,
        workspaceId,
      })
      expect(
        applications.postCommitMetadata(
          metadataCommit(fence, { outcome: 'already-applied', lease: metadata }),
        ),
      ).toBe('applied')
      expect(attemptController.getTargetAdmissionFrame(chatId).admission(messageId)).toBe(
        'available',
      )
      expect(attemptController.getTargetSnapshot(chatId, messageId).presentation).toMatchObject({
        streamId,
        phase: 'awaiting-presentation',
      })
    } finally {
      stop()
    }
  })

  it('owns the complete seal, canonical, metadata, and retirement sequence', async () => {
    const order: string[] = []
    const active = testGenerationLease({ streamId: 'stream', phase: 'active' })
    const decided = testGenerationLease({
      streamId: 'stream',
      phase: 'terminal-decided',
      revision: 2,
      terminal: terminalReceipt(),
    })
    const canonical = testGenerationLease({ streamId: 'stream', phase: 'canonical', revision: 3 })
    const metadata = testGenerationLease({
      streamId: 'stream',
      phase: 'metadata-committed',
      revision: 4,
    })
    const port = custodyPort(active, {
      seal: async () => {
        order.push('seal')
        return decided
      },
      canonicalize: async (projection) => {
        order.push('canonical')
        expect(projection).toBe(PROJECTION)
        return { outcome: 'committed', lease: canonical }
      },
      commitMetadata: async () => {
        order.push('metadata')
        return { outcome: 'already-applied', lease: metadata }
      },
      retire: async () => {
        order.push('retire')
        return {
          kind: 'retired',
          cleanup: { deletedLease: true, deletedFrames: 4, done: true },
        }
      },
    })

    await expect(
      advanceAttemptTerminalCustody({
        port,
        prepareTerminal: async () => {
          order.push('prepare')
          return PREPARATION
        },
      }),
    ).resolves.toEqual({
      kind: 'retired',
      receipt: terminalReceipt(),
      canonical: { outcome: 'committed', lease: canonical },
      cleanup: { deletedLease: true, deletedFrames: 4, done: true },
    })
    expect(order).toEqual(['prepare', 'seal', 'canonical', 'metadata', 'retire'])
    expect(port.handoff).not.toHaveBeenCalled()
  })

  it('hands off every projection failure before sealing terminal state', async () => {
    const failure = new Error('projection failed')
    const port = custodyPort(testGenerationLease({ phase: 'active' }))

    await expect(
      advanceAttemptTerminalCustody({
        port,
        prepareTerminal: async () => {
          throw failure
        },
      }),
    ).rejects.toBe(failure)
    expect(port.seal).not.toHaveBeenCalled()
    expect(port.canonicalize).not.toHaveBeenCalled()
    expect(port.handoff).toHaveBeenCalledWith('finalize-failed')
  })

  it('keeps a canonical write failure primary when handoff also fails', async () => {
    const failure = new Error('canonical write failed')
    const port = custodyPort(testGenerationLease({ phase: 'active' }), {
      canonicalize: async () => {
        throw failure
      },
      handoff: async () => {
        throw new Error('handoff failed')
      },
    })

    await expect(
      advanceAttemptTerminalCustody({
        port,
        prepareTerminal: async () => PREPARATION,
      }),
    ).rejects.toBe(failure)
    expect(port.handoff).toHaveBeenCalledWith('finalize-failed')
  })

  it('reprojects once from the sealed receipt when durable Stop wins the terminal race', async () => {
    const active = testGenerationLease({ streamId: 'stop-race', phase: 'active' })
    const stoppedReceipt = {
      version: 1 as const,
      finishedAt: 4,
      journalMaxSeq: -1,
      journalCompleteness: 'settled' as const,
      decision: { outcome: 'abort' as const, abortReason: 'user' as const },
    }
    const canonical = testGenerationLease({
      streamId: active.streamId,
      phase: 'canonical',
      revision: 3,
    })
    const port = custodyPort(active, {
      seal: async () =>
        testGenerationLease({
          streamId: active.streamId,
          phase: 'terminal-decided',
          revision: 2,
          terminal: stoppedReceipt,
        }),
      canonicalize: async (projection) => {
        expect(projection).toBe(PROJECTION)
        return { outcome: 'committed', lease: canonical }
      },
    })
    const prepareTerminal = vi.fn(
      async (receipt?: AttemptTerminalReceipt): Promise<AttemptTerminalPreparation> => {
        if (!receipt) return PREPARATION
        expect(receipt).toEqual(stoppedReceipt)
        return {
          finishedAt: stoppedReceipt.finishedAt,
          decision: stoppedReceipt.decision,
          project: (sealed) => {
            expect(sealed).toEqual(stoppedReceipt)
            return PROJECTION
          },
        }
      },
    )

    await expect(advanceAttemptTerminalCustody({ port, prepareTerminal })).resolves.toMatchObject({
      kind: 'retired',
      receipt: stoppedReceipt,
      canonical: { outcome: 'committed', lease: canonical },
    })
    expect(prepareTerminal).toHaveBeenCalledTimes(2)
    expect(prepareTerminal.mock.calls[0]?.[0]).toBeUndefined()
    expect(prepareTerminal.mock.calls[1]?.[0]).toEqual(stoppedReceipt)
    expect(port.seal).toHaveBeenCalledOnce()
    expect(port.canonicalize).toHaveBeenCalledOnce()
  })

  it('never seals when journal settlement fails and hands recovery the original lease', async () => {
    const failure = new Error('journal settlement failed')
    const active = testGenerationLease({ phase: 'active' })
    const sealTerminal = vi.fn<StreamLeaseHandle['sealTerminal']>()
    const retire = vi.fn<StreamLeaseHandle['retire']>(async () => ({
      mode: 'handoff',
      lease: testRecoveryPendingLease({
        streamId: active.streamId,
        phase: 'active',
        handoffReason: 'journal-settle-failed',
      }),
    }))
    const handle = {
      streamId: active.streamId,
      fence: {
        ownerClientId: active.ownerClientId,
        fenceToken: active.fenceToken,
        replacementEpoch: active.replacementEpoch,
        admissionSequence: active.admissionSequence,
      },
      lease: active,
      adoptTargetCommit: vi.fn(),
      noteSelectedKey: vi.fn(),
      sealTerminal,
      commitPostCommitMetadata: vi.fn(),
      retire,
    } as unknown as StreamLeaseHandle
    const owner = createWriterAttemptTerminalOwner({
      repository: () => {
        throw new Error('repository must remain cold')
      },
      permit: {} as WorkspaceWritePermit,
      handle,
      journal: () => ({ settle: async () => Promise.reject(failure) }),
    })

    await expect(owner.complete({ prepareTerminal: async () => PREPARATION })).rejects.toBe(failure)
    expect(sealTerminal).not.toHaveBeenCalled()
    expect(retire).toHaveBeenCalledWith({
      mode: 'handoff',
      reason: 'journal-settle-failed',
    })
  })

  it('contains metadata and retirement failures after canonical persistence', async () => {
    const metadataFailurePort = custodyPort(testGenerationLease({ phase: 'canonical' }), {
      commitMetadata: async () => {
        throw new Error('metadata failed')
      },
    })
    await expect(
      advanceAttemptTerminalCustody({
        port: metadataFailurePort,
        prepareTerminal: async () => PREPARATION,
      }),
    ).resolves.toEqual({ kind: 'recovery-pending', reason: 'cleanup-failed' })
    expect(metadataFailurePort.handoff).toHaveBeenCalledWith('cleanup-failed')

    const retirementFailurePort = custodyPort(
      testGenerationLease({ phase: 'metadata-committed' }),
      {
        retire: async () => {
          throw new Error('retirement failed')
        },
      },
    )
    await expect(
      advanceAttemptTerminalCustody({
        port: retirementFailurePort,
        prepareTerminal: async () => PREPARATION,
      }),
    ).resolves.toEqual({ kind: 'recovery-pending', reason: 'cleanup-failed' })
    expect(retirementFailurePort.handoff).toHaveBeenCalledWith('cleanup-failed')
  })

  it('preserves an explicit retirement handoff without attempting it twice', async () => {
    const disposition = { kind: 'recovery-pending', reason: 'cleanup-failed' } as const
    const port = custodyPort(testGenerationLease({ phase: 'metadata-committed' }), {
      retire: async () => disposition,
    })

    await expect(
      advanceAttemptTerminalCustody({
        port,
        prepareTerminal: async () => PREPARATION,
      }),
    ).resolves.toEqual(disposition)
    expect(port.handoff).not.toHaveBeenCalled()
  })

  it('single-flights every terminal stage across concurrent completion callers', async () => {
    const port = custodyPort(testGenerationLease({ phase: 'active' }))
    const owner = createAttemptTerminalOwner(port)
    const firstPreparation = vi.fn(async () => PREPARATION)
    const secondPreparation = vi.fn(async () => {
      throw new Error('second terminal proposal must remain cold')
    })

    const first = owner.complete({ prepareTerminal: firstPreparation })
    const second = owner.complete({ prepareTerminal: secondPreparation })

    expect(second).toBe(first)
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(firstPreparation).toHaveBeenCalledOnce()
    expect(secondPreparation).not.toHaveBeenCalled()
    expect(port.seal).toHaveBeenCalledOnce()
    expect(port.canonicalize).toHaveBeenCalledOnce()
    expect(port.commitMetadata).toHaveBeenCalledOnce()
    expect(port.retire).toHaveBeenCalledOnce()
  })

  it('makes the first complete-or-handoff caller the terminal owner', async () => {
    const handoffFirstPort = custodyPort(testGenerationLease({ phase: 'active' }))
    const handoffFirstOwner = createAttemptTerminalOwner(handoffFirstPort)
    const handoff = handoffFirstOwner.handoffIfOpen('finalize-failed')
    const blockedCompletion = handoffFirstOwner.complete({
      prepareTerminal: async () => {
        throw new Error('handoff already owns settlement')
      },
    })

    await expect(handoff).resolves.toBeUndefined()
    await expect(blockedCompletion).resolves.toEqual({
      kind: 'recovery-pending',
      reason: 'finalize-failed',
    })
    expect(handoffFirstPort.handoff).toHaveBeenCalledOnce()
    expect(handoffFirstPort.seal).not.toHaveBeenCalled()

    const completeFirstPort = custodyPort(testGenerationLease({ phase: 'active' }))
    const completeFirstOwner = createAttemptTerminalOwner(completeFirstPort)
    const completion = completeFirstOwner.complete({ prepareTerminal: async () => PREPARATION })
    const ignoredHandoff = completeFirstOwner.handoffIfOpen('cleanup-failed')

    await expect(completion).resolves.toMatchObject({ kind: 'retired' })
    await expect(ignoredHandoff).resolves.toBeUndefined()
    expect(completeFirstPort.handoff).not.toHaveBeenCalled()
  })
})

function terminalReceipt() {
  return {
    version: 1 as const,
    finishedAt: 2,
    journalMaxSeq: -1,
    journalCompleteness: 'settled' as const,
    decision: { outcome: 'done' as const },
  }
}

function cleanupCommit(
  fence: { workspaceId: string; replacementEpoch: number },
  value: StreamFinishCleanupResult,
): CommitEnvelope<StreamFinishCleanupResult> {
  return {
    ...fence,
    commitId: 'terminal-cleanup-commit',
    effectScope: 'workspace',
    value,
    receipt: { chats: [], constructions: [], messageRevisions: [], childSlots: [] },
    delta: { facts: [], invalidations: [] },
  }
}

function metadataCommit(
  fence: { workspaceId: string; replacementEpoch: number },
  value: GenerationPostCommitMetadataResult,
): CommitEnvelope<GenerationPostCommitMetadataResult> {
  return {
    ...fence,
    commitId: 'terminal-metadata-commit',
    effectScope: 'workspace',
    value,
    receipt: { chats: [], constructions: [], messageRevisions: [], childSlots: [] },
    delta: { facts: [], invalidations: [] },
  }
}

function custodyPort(
  lease: FencedStreamLeaseRow,
  overrides: Partial<{
    seal: (input: {
      finishedAt: number
      decision: AttemptTerminalPreparation['decision']
    }) => Promise<TerminalDecidedStreamLeaseRow>
    canonicalize: (projection: AttemptTerminalProjection) => Promise<{
      outcome: 'committed'
      lease: FencedStreamLeaseRow
    }>
    commitMetadata: () => Promise<
      { outcome: 'stale' } | { outcome: 'already-applied'; lease: FencedStreamLeaseRow }
    >
    retire: () => Promise<
      | {
          kind: 'retired'
          cleanup: { deletedLease: boolean; deletedFrames: number; done: boolean }
        }
      | { kind: 'recovery-pending'; reason: StreamLeaseHandoffReason }
    >
    handoff: (reason: StreamLeaseHandoffReason) => Promise<void>
  }> = {},
) {
  return {
    get lease() {
      return lease
    },
    seal: vi.fn(
      overrides.seal ??
        (async () =>
          testGenerationLease({
            streamId: lease.streamId,
            phase: 'terminal-decided',
            revision: lease.revision + 1,
            terminal: terminalReceipt(),
          })),
    ),
    canonicalize: vi.fn(
      overrides.canonicalize ??
        (async () => ({
          outcome: 'committed' as const,
          lease: testGenerationLease({ phase: 'canonical' }),
        })),
    ),
    commitMetadata: vi.fn(
      overrides.commitMetadata ??
        (async () => ({
          outcome: 'already-applied' as const,
          lease: testGenerationLease({ phase: 'metadata-committed' }),
        })),
    ),
    retire: vi.fn(
      overrides.retire ??
        (async () => ({
          kind: 'retired' as const,
          cleanup: { deletedLease: true, deletedFrames: 0, done: true },
        })),
    ),
    handoff: vi.fn(overrides.handoff ?? (async () => undefined)),
  }
}

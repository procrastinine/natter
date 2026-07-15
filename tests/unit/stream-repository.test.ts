import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'
import type { StreamChunkRow, StreamLeaseRow } from '../../src/store/repository'

const DB_NAME = 'natter'

async function resetAll(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await getBrowserRepository().createChat(testChat('chat-1'))
})
afterEach(resetAll)

describe('browser stream repository', () => {
  it('admits an absent reserved target only in an existing chat and rejects cross-chat targets', async () => {
    const repo = getBrowserRepository()
    await expect(
      repo.upsertStreamLease({
        streamId: 'reserved-target',
        chatId: 'chat-1',
        messageId: 'future-assistant',
        ownerClientId: 'tab-1',
        startedAt: 1,
        heartbeatAt: 1,
      }),
    ).resolves.toMatchObject({ chatId: 'chat-1', messageId: 'future-assistant' })

    await expect(
      repo.upsertStreamLease({
        streamId: 'missing-chat-reservation',
        chatId: 'missing-chat',
        messageId: 'future-assistant-2',
        ownerClientId: 'tab-1',
        startedAt: 1,
        heartbeatAt: 1,
      }),
    ).rejects.toMatchObject({ name: 'ChatMissingError', chatId: 'missing-chat' })

    await repo.createChat(testChat('chat-2'))
    const crossChatTarget = splitMessageForStorage({
      ...finalizedAssistant('other-chat-target'),
      chatId: 'chat-2',
    })
    await getDb().messages.put(crossChatTarget.header)
    await getDb().messageBodies.put(crossChatTarget.body)
    await expect(
      repo.upsertStreamLease({
        streamId: 'cross-chat-target',
        chatId: 'chat-1',
        messageId: 'other-chat-target',
        ownerClientId: 'tab-1',
        startedAt: 1,
        heartbeatAt: 1,
      }),
    ).rejects.toThrow(
      'StreamLeaseTargetChatMismatch:cross-chat-target:other-chat-target:chat-1:chat-2',
    )
    const retargetedReservation = await repo.upsertStreamLease({
      streamId: 'cross-chat-renewal',
      chatId: 'chat-1',
      ownerClientId: 'tab-1',
      startedAt: 1,
      heartbeatAt: 1,
    })
    await expect(
      repo.renewStreamLease(
        { ...retargetedReservation, messageId: 'other-chat-target', heartbeatAt: 2 },
        { targetChanged: true },
      ),
    ).rejects.toThrow(
      'StreamLeaseTargetChatMismatch:cross-chat-renewal:other-chat-target:chat-1:chat-2',
    )
    expect(await repo.getStreamLease('missing-chat-reservation')).toBeUndefined()
    expect(await repo.getStreamLease('cross-chat-target')).toBeUndefined()
    const unchangedRenewal = await repo.getStreamLease('cross-chat-renewal')
    expect(unchangedRenewal?.chatId).toBe('chat-1')
    expect(unchangedRenewal?.messageId).toBeUndefined()
  })

  it('lists one stream through the compound stream-and-sequence index', async () => {
    const repo = getBrowserRepository()
    const streamA = await repo.upsertStreamLease({
      streamId: 'stream-a',
      chatId: 'chat-1',
      ownerClientId: 'tab-1',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const streamB = await repo.upsertStreamLease({
      streamId: 'stream-b',
      chatId: 'chat-1',
      ownerClientId: 'tab-1',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const fenceByStreamId = new Map([
      [
        streamA.streamId,
        { fenceToken: streamA.fenceToken, replacementEpoch: streamA.replacementEpoch },
      ],
      [
        streamB.streamId,
        { fenceToken: streamB.fenceToken, replacementEpoch: streamB.replacementEpoch },
      ],
    ])
    const chunks: StreamChunkRow[] = [
      {
        id: 'stream-a:2',
        streamId: 'stream-a',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 2,
        createdAt: 3,
        event: { delta: { text: 'c' } },
      },
      {
        id: 'stream-b:0',
        streamId: 'stream-b',
        chatId: 'chat-1',
        messageId: 'message-2',
        seq: 0,
        createdAt: 1,
        event: { delta: { text: 'other' } },
      },
      {
        id: 'stream-a:0',
        streamId: 'stream-a',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 0,
        createdAt: 1,
        event: { delta: { text: 'a' } },
      },
      {
        id: 'stream-a:1',
        streamId: 'stream-a',
        chatId: 'chat-1',
        messageId: 'message-1',
        seq: 1,
        createdAt: 2,
        event: { delta: { text: 'b' } },
      },
    ].map((chunk) => ({ ...chunk, ...fenceByStreamId.get(chunk.streamId) }))
    await repo.appendStreamChunks(chunks)

    const firstRead = await repo.listStreamChunks('stream-a')
    expect(firstRead.map(({ id, seq }) => ({ id, seq }))).toEqual([
      { id: 'stream-a:0', seq: 0 },
      { id: 'stream-a:1', seq: 1 },
      { id: 'stream-a:2', seq: 2 },
    ])
    const firstEvent = firstRead[0]?.event as { delta: { text: string } } | undefined
    if (!firstEvent) throw new Error('expected first stream chunk')
    firstEvent.delta.text = 'mutated'

    const secondRead = await repo.listStreamChunks('stream-a')
    expect(secondRead[0]?.event).toEqual({ delta: { text: 'a' } })
    expect(await repo.listStreamChunks('missing-stream')).toEqual([])
  })

  it('keeps legacy leases valid while preserving continuation recovery metadata', async () => {
    const repo = getBrowserRepository()
    const legacyLease: StreamLeaseRow = {
      streamId: 'legacy-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'tab-1',
      startedAt: 1,
      heartbeatAt: 2,
    }
    const continuationLease: StreamLeaseRow = {
      streamId: 'continue-stream',
      chatId: 'chat-1',
      messageId: 'message-2',
      ownerClientId: 'tab-2',
      startedAt: 3,
      heartbeatAt: 4,
      attemptKind: 'continuation',
      continuationStrategy: 'prefill',
      baseBodyVersion: 7,
      requestedModel: 'model-a',
      apiUsed: 'responses',
    }
    const storedLegacyLease = await repo.upsertStreamLease(legacyLease)
    const storedContinuationLease = await repo.upsertStreamLease(continuationLease)
    await getDb().streamLeases.put({
      ...storedContinuationLease,
      streamId: 'invalid-kind-stream',
      attemptKind: 'invalid',
    } as never)
    await getDb().streamLeases.put({
      ...storedContinuationLease,
      streamId: 'invalid-api-stream',
      apiUsed: 'invalid',
    } as never)
    await getDb().streamLeases.put({
      ...storedContinuationLease,
      streamId: 'invalid-model-stream',
      requestedModel: 42,
    } as never)
    await getDb().streamLeases.put({
      ...storedContinuationLease,
      streamId: 'invalid-strategy-stream',
      continuationStrategy: 'unknown',
    } as never)

    const leases = (await repo.listStreamLeases('chat-1')).sort((a, b) =>
      a.streamId.localeCompare(b.streamId),
    )
    expect(leases).toEqual(
      [storedContinuationLease, storedLegacyLease].sort((a, b) =>
        a.streamId.localeCompare(b.streamId),
      ),
    )
  })

  it('rejects a suspended stale owner after recovery installs a new fence', async () => {
    const repo = getBrowserRepository()
    const oldLease = await repo.upsertStreamLease({
      streamId: 'reused-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'suspended-tab',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const oldFence = leaseFence(oldLease)
    const replacement = await repo.claimStreamLeaseForRecovery(oldLease, 20_000)
    expect(replacement).toBeDefined()
    if (!replacement) throw new Error('expected recovery claim')

    await expect(repo.renewStreamLease({ ...oldLease, heartbeatAt: 20_001 })).rejects.toThrow(
      'StreamFenceLost:reused-stream',
    )
    await expect(
      repo.appendStreamChunks([
        {
          id: 'reused-stream:0',
          streamId: 'reused-stream',
          chatId: 'chat-1',
          messageId: 'message-1',
          seq: 0,
          createdAt: 20_001,
          event: { lane: 'text', text: 'stale' },
          fenceToken: oldFence.fenceToken,
          replacementEpoch: oldFence.replacementEpoch,
        },
      ]),
    ).rejects.toThrow('StreamFenceLost:reused-stream')
    await expect(repo.deleteOwnedStreamLease(oldLease.streamId, oldFence)).rejects.toThrow(
      'StreamFenceLost:reused-stream',
    )

    expect(await repo.listStreamLeases()).toEqual([replacement])
    expect(await repo.listStreamChunks(oldLease.streamId)).toEqual([])
  })

  it('admits distinct stream targets and rejects a second lease for the same message', async () => {
    const repo = getBrowserRepository()
    await repo.upsertStreamLease({
      streamId: 'stream-a',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'tab-a',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const distinct = await repo.upsertStreamLease({
      streamId: 'stream-b',
      chatId: 'chat-1',
      messageId: 'message-2',
      ownerClientId: 'tab-b',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const messageLess = await repo.upsertStreamLease({
      streamId: 'stream-c',
      chatId: 'chat-1',
      ownerClientId: 'tab-c',
      startedAt: 1,
      heartbeatAt: 20_000,
    })

    await expect(
      repo.renewStreamLease({ ...messageLess, messageId: 'message-1', heartbeatAt: 20_001 }),
    ).rejects.toThrow('StreamTargetBusy:message-1')
    await expect(
      repo.renewStreamLease({ ...messageLess, messageId: 'message-3', heartbeatAt: 20_002 }),
    ).resolves.toMatchObject({ messageId: 'message-3' })
    expect(distinct.messageId).toBe('message-2')
  })

  it('allows exactly one of two concurrent leases for the same target', async () => {
    const repo = getBrowserRepository()
    const settled = await Promise.allSettled([
      repo.upsertStreamLease({
        streamId: 'target-race-a',
        chatId: 'chat-1',
        messageId: 'shared-message',
        ownerClientId: 'tab-a',
        startedAt: 1,
        heartbeatAt: 1,
      }),
      repo.upsertStreamLease({
        streamId: 'target-race-b',
        chatId: 'chat-1',
        messageId: 'shared-message',
        ownerClientId: 'tab-b',
        startedAt: 1,
        heartbeatAt: 1,
      }),
    ])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({
      name: 'StreamTargetBusyError',
      messageId: 'shared-message',
    })
  })

  it('admits independent message-less lifecycles in one chat while keeping targets exclusive', async () => {
    const repo = getBrowserRepository()
    const first = await repo.upsertStreamLease({
      streamId: 'first-send',
      chatId: 'chat-1',
      ownerClientId: 'tab-a',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const second = await repo.upsertStreamLease({
      streamId: 'second-send',
      chatId: 'chat-1',
      ownerClientId: 'tab-b',
      startedAt: 2,
      heartbeatAt: 2,
    })

    await repo.renewStreamLease(
      { ...first, messageId: 'message-1', heartbeatAt: 3 },
      { targetChanged: true },
    )
    await expect(
      repo.renewStreamLease(
        { ...second, messageId: 'message-2', heartbeatAt: 3 },
        { targetChanged: true },
      ),
    ).resolves.toMatchObject({ messageId: 'message-2' })
    await expect(
      repo.upsertStreamLease({
        streamId: 'duplicate-target',
        chatId: 'chat-1',
        messageId: 'message-1',
        ownerClientId: 'tab-c',
        startedAt: 4,
        heartbeatAt: 4,
      }),
    ).rejects.toThrow('StreamTargetBusy:message-1')
  })

  it('assigns a monotonic durable admission order and prunes finalized target predecessors', async () => {
    const repo = getBrowserRepository()
    const finalized = splitMessageForStorage(finalizedAssistant('shared-final-target'))
    await getDb().messages.put(finalized.header)
    await getDb().messageBodies.put(finalized.body)
    const first = await repo.upsertStreamLease({
      streamId: 'finalized-predecessor',
      chatId: 'chat-1',
      messageId: 'shared-final-target',
      ownerClientId: 'tab-a',
      startedAt: 1,
      heartbeatAt: 1,
      attemptKind: 'generation',
    })
    const firstFence = leaseFence(first)
    await repo.appendStreamChunks([
      {
        id: 'finalized-predecessor:0',
        streamId: first.streamId,
        chatId: first.chatId,
        messageId: first.messageId as string,
        seq: 0,
        createdAt: 2,
        event: { lane: 'text', text: 'already committed' },
        ...firstFence,
      },
    ])

    const second = await repo.upsertStreamLease({
      streamId: 'replacement-after-final',
      chatId: 'chat-1',
      messageId: 'shared-final-target',
      ownerClientId: 'tab-b',
      startedAt: 3,
      heartbeatAt: 3,
      attemptKind: 'generation',
    })

    expect(first.admissionSequence).toBeTypeOf('number')
    expect(second.admissionSequence).toBe((first.admissionSequence as number) + 1)
    expect((await repo.listStreamLeases()).map((lease) => lease.streamId)).toEqual([
      'replacement-after-final',
    ])
    expect(await repo.listStreamChunks(first.streamId)).toEqual([])
  })

  it('keeps repeated finalized admissions bounded to one target lease', async () => {
    const repo = getBrowserRepository()
    const finalized = splitMessageForStorage(finalizedAssistant('bounded-final-target'))
    await getDb().messages.put(finalized.header)
    await getDb().messageBodies.put(finalized.body)
    let previousSequence = 0
    for (let index = 0; index < 100; index += 1) {
      const lease = await repo.upsertStreamLease({
        streamId: `bounded-final-stream-${index}`,
        chatId: 'chat-1',
        messageId: 'bounded-final-target',
        ownerClientId: `tab-${index}`,
        startedAt: index,
        heartbeatAt: index,
        attemptKind: 'generation',
      })
      expect(lease.admissionSequence).toBeGreaterThan(previousSequence)
      previousSequence = lease.admissionSequence as number
    }

    expect(await getDb().streamLeases.count()).toBe(1)
    expect((await repo.listStreamLeases())[0]?.streamId).toBe('bounded-final-stream-99')
    expect(await getDb().streamChunks.count()).toBe(0)
  })

  it('checks a stream fence inside the authoritative mutation transaction', async () => {
    const repo = getBrowserRepository()
    const oldLease = await repo.upsertStreamLease({
      streamId: 'finalize-race',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'suspended-tab',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const oldFence = leaseFence(oldLease)
    const replacement = await repo.claimStreamLeaseForRecovery(oldLease, 20_000)
    expect(replacement).toBeDefined()

    const mutation = vi.fn()
    await expect(
      repo.runMutation([], mutation, {
        streamFence: { streamId: oldLease.streamId, fence: oldFence },
      }),
    ).rejects.toThrow('StreamFenceLost:finalize-race')
    expect(mutation).not.toHaveBeenCalled()
  })

  it('rejects finalization from before a workspace replacement epoch', async () => {
    const repo = getBrowserRepository()
    const lease = await repo.upsertStreamLease({
      streamId: 'pre-replacement-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'old-workspace-tab',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const fence = leaseFence(lease)
    const meta = await repo.getWorkspaceMeta()
    await getDb().settings.put({
      key: 'workspace-meta',
      value: { ...meta, replacementEpoch: meta.replacementEpoch + 1 },
    })

    const mutation = vi.fn()
    await expect(
      repo.runMutation([], mutation, {
        streamFence: { streamId: lease.streamId, fence },
      }),
    ).rejects.toThrow('StreamFenceLost:pre-replacement-stream')
    expect(mutation).not.toHaveBeenCalled()
  })

  it('keeps journal maintenance out of workspace mutation accounting', async () => {
    const repo = getBrowserRepository()
    const before = await repo.getWorkspaceMeta()
    const lease = await repo.upsertStreamLease({
      streamId: 'maintenance-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'tab-1',
      startedAt: 1,
      heartbeatAt: 1,
    })
    const fence = leaseFence(lease)
    await repo.renewStreamLease({ ...lease, heartbeatAt: 2 })
    await repo.appendStreamChunks([
      {
        id: 'maintenance-stream:0',
        streamId: lease.streamId,
        chatId: lease.chatId,
        messageId: 'message-1',
        seq: 0,
        createdAt: 2,
        event: { lane: 'text', text: 'kept' },
        fenceToken: fence.fenceToken,
        replacementEpoch: fence.replacementEpoch,
      },
    ])
    await repo.deleteStreamChunks(lease.streamId, fence)
    await repo.deleteOwnedStreamLease(lease.streamId, fence)

    expect(await repo.getWorkspaceMeta()).toEqual(before)
  })

  it('piggybacks lease freshness on persisted chunks', async () => {
    const repo = getBrowserRepository()
    const lease = await repo.upsertStreamLease({
      streamId: 'chunk-freshness-stream',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'timer-throttled-tab',
      startedAt: 1,
      heartbeatAt: 5,
    })
    const fence = leaseFence(lease)

    await repo.appendStreamChunks([
      {
        id: 'chunk-freshness-stream:0',
        streamId: lease.streamId,
        chatId: lease.chatId,
        messageId: 'message-1',
        seq: 0,
        createdAt: 20_000,
        event: { lane: 'text', text: 'still active' },
        fenceToken: fence.fenceToken,
        replacementEpoch: fence.replacementEpoch,
      },
      {
        id: 'chunk-freshness-stream:1',
        streamId: lease.streamId,
        chatId: lease.chatId,
        messageId: 'message-1',
        seq: 1,
        createdAt: 19_000,
        event: { lane: 'text', text: 'ordered by sequence, not clock' },
        fenceToken: fence.fenceToken,
        replacementEpoch: fence.replacementEpoch,
      },
    ])

    expect((await repo.listStreamLeases())[0]?.heartbeatAt).toBe(20_000)
    await expect(repo.claimStreamLeaseForRecovery(lease, 30_000)).resolves.toBeUndefined()
  })

  it('cannot delete a reused stream journal across a workspace replacement epoch', async () => {
    const repo = getBrowserRepository()
    const oldLease = await repo.upsertStreamLease({
      streamId: 'reused-recovery-stream',
      chatId: 'chat-1',
      ownerClientId: 'old-workspace-tab',
      startedAt: 1,
      heartbeatAt: 1,
      attemptKind: 'generation',
    })
    const oldFence = leaseFence(oldLease)
    const db = getDb()
    const meta = await repo.getWorkspaceMeta()
    const replacementEpoch = meta.replacementEpoch + 1
    const replacementLease: StreamLeaseRow = {
      ...oldLease,
      ownerClientId: 'new-workspace-tab',
      fenceToken: 'new-workspace-fence',
      replacementEpoch,
      heartbeatAt: 2,
    }
    const replacementChunk: StreamChunkRow = {
      id: 'reused-recovery-stream:0',
      streamId: replacementLease.streamId,
      chatId: replacementLease.chatId,
      messageId: 'new-workspace-message',
      seq: 0,
      createdAt: 2,
      event: { lane: 'text', text: 'new workspace data' },
      fenceToken: 'new-workspace-fence',
      replacementEpoch,
    }
    await db.transaction('rw', db.settings, db.streamLeases, db.streamChunks, async () => {
      await db.settings.put({
        key: 'workspace-meta',
        value: { ...meta, replacementEpoch },
      })
      await db.streamLeases.put(replacementLease)
      await db.streamChunks.put(replacementChunk)
    })

    await expect(
      repo.deleteStreamJournal(oldLease.streamId, {
        replacementEpoch: oldFence.replacementEpoch,
        streamFence: oldFence,
      }),
    ).rejects.toMatchObject({ name: 'WorkspaceReplacementFenceError' })
    expect(await db.streamLeases.get(oldLease.streamId)).toEqual(replacementLease)
    expect(await db.streamChunks.get(replacementChunk.id)).toEqual(replacementChunk)
  })

  it('does not use a missing-lease cleanup claim to delete a newly admitted lease', async () => {
    const repo = getBrowserRepository()
    const lease = await repo.upsertStreamLease({
      streamId: 'appeared-before-cleanup',
      chatId: 'chat-1',
      ownerClientId: 'current-tab',
      startedAt: 1,
      heartbeatAt: 1,
    })

    await expect(
      repo.deleteStreamJournal(lease.streamId, {
        replacementEpoch: lease.replacementEpoch as number,
        expectedLeaseMissing: true,
      }),
    ).rejects.toThrow(`StreamFenceLost:${lease.streamId}`)
    expect(await repo.getStreamLease(lease.streamId)).toEqual(lease)
  })
})

function leaseFence(lease: StreamLeaseRow) {
  if (typeof lease.fenceToken !== 'string' || lease.replacementEpoch === undefined) {
    throw new Error('expected fenced lease')
  }
  return {
    ownerClientId: lease.ownerClientId,
    fenceToken: lease.fenceToken,
    replacementEpoch: lease.replacementEpoch,
  }
}

function finalizedAssistant(id: string): Message {
  return {
    id,
    chatId: 'chat-1',
    parentId: null,
    siblingIndex: 0,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'committed' }],
    nodeVersion: 1,
    deleted: false,
    generation: {
      id: `generation-${id}`,
      model: 'vendor/model',
      requestedModel: 'vendor/model',
      apiUsed: 'chat',
      delivery: 'streaming',
      status: 'done',
      costSource: 'stream',
      startedAt: 1,
      finishedAt: 2,
    },
  }
}

function testChat(id: string): Chat {
  return {
    id,
    title: id,
    titleStatus: 'untitled',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

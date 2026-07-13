import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { __resetDbForTests, getDb } from '../../src/store/db'
import type { StreamChunkRow, StreamLeaseRow } from '../../src/store/repository'
import { StreamChatBusyError } from '../../src/store/repository'

const DB_NAME = 'natter'

async function resetAll(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(resetAll)
afterEach(resetAll)

describe('browser stream repository', () => {
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
      baseNodeVersion: 7,
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

  it('admits an exclusive composer stream atomically across a chat', async () => {
    const repo = getBrowserRepository()
    const exclusive = await repo.upsertStreamLease({
      streamId: 'exclusive-send',
      chatId: 'chat-1',
      ownerClientId: 'tab-a',
      startedAt: 1,
      heartbeatAt: 1,
      exclusiveChat: true,
    })
    const { exclusiveChat: ignoredExclusiveChat, ...leaseWithoutAdmission } = exclusive
    void ignoredExclusiveChat
    const bound = await repo.renewStreamLease(
      { ...leaseWithoutAdmission, messageId: 'message-1', heartbeatAt: 2 },
      { targetChanged: true },
    )
    expect(bound.exclusiveChat).toBe(true)

    await expect(
      repo.upsertStreamLease({
        streamId: 'competing-send',
        chatId: 'chat-1',
        ownerClientId: 'tab-b',
        startedAt: 2,
        heartbeatAt: 2,
        exclusiveChat: true,
      }),
    ).rejects.toBeInstanceOf(StreamChatBusyError)
    await expect(
      repo.upsertStreamLease({
        streamId: 'competing-target',
        chatId: 'chat-1',
        messageId: 'message-2',
        ownerClientId: 'tab-b',
        startedAt: 2,
        heartbeatAt: 2,
      }),
    ).rejects.toBeInstanceOf(StreamChatBusyError)
    await expect(
      repo.upsertStreamLease({
        streamId: 'other-chat',
        chatId: 'chat-2',
        ownerClientId: 'tab-b',
        startedAt: 2,
        heartbeatAt: 2,
        exclusiveChat: true,
      }),
    ).resolves.toMatchObject({ chatId: 'chat-2' })

    await repo.deleteOwnedStreamLease(bound.streamId, leaseFence(bound))
    await expect(
      repo.upsertStreamLease({
        streamId: 'after-release',
        chatId: 'chat-1',
        ownerClientId: 'tab-b',
        startedAt: 3,
        heartbeatAt: 3,
        exclusiveChat: true,
      }),
    ).resolves.toMatchObject({ chatId: 'chat-1' })
  })

  it('does not let an exclusive composer stream overtake an existing target stream', async () => {
    const repo = getBrowserRepository()
    await repo.upsertStreamLease({
      streamId: 'existing-target',
      chatId: 'chat-1',
      messageId: 'message-1',
      ownerClientId: 'tab-a',
      startedAt: 1,
      heartbeatAt: 1,
    })

    await expect(
      repo.upsertStreamLease({
        streamId: 'exclusive-send',
        chatId: 'chat-1',
        ownerClientId: 'tab-b',
        startedAt: 2,
        heartbeatAt: 2,
        exclusiveChat: true,
      }),
    ).rejects.toBeInstanceOf(StreamChatBusyError)
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

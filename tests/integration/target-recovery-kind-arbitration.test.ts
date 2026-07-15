import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, Message } from '../../src/core/types'
import { recoverOrphans, recoverStreamOrphan } from '../../src/hooks/useChat'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { recoverStaleContinuationAttempts } from '../../src/store/continuation-recovery'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import type { StreamLeaseRow } from '../../src/store/repository'
import { __resetStreamLeasesForTests } from '../../src/store/stream-leases'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'

const DB_NAME = 'natter'

function settings(): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: 'target-recovery-profile',
    model: 'test/recovery-model',
  }
}

async function reset(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openDb()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

describe('target recovery kind arbitration', () => {
  it('replays only the newest owning continuation after a finished generation', async () => {
    const { chatId, target } = await seedAssistant('finished-target', true)
    const repo = getBrowserRepository()
    const baseline = required(await repo.getMessageHeader(target.id), 'target header')
    const older = await repo.upsertStreamLease({
      streamId: 'continuation-older',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-continuation-older',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseBodyVersion: baseline.bodyVersion,
    })
    const durable = durableLeaseFields(older)
    const newer: StreamLeaseRow = {
      ...older,
      streamId: 'continuation-newer',
      ownerClientId: 'closed-continuation-newer',
      fenceToken: 'continuation-newer-fence',
      admissionSequence: durable.admissionSequence + 1,
    }
    const planning: StreamLeaseRow = {
      streamId: 'continuation-planning',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-continuation-planning',
      fenceToken: 'continuation-planning-fence',
      replacementEpoch: durable.replacementEpoch,
      admissionSequence: durable.admissionSequence + 2,
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
    }
    const incompatibleGeneration: StreamLeaseRow = {
      streamId: 'finished-target-generation',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-finished-generation',
      fenceToken: 'finished-target-generation-fence',
      replacementEpoch: durable.replacementEpoch,
      admissionSequence: durable.admissionSequence + 3,
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'generation',
    }
    await getDb().streamLeases.bulkPut([newer, planning, incompatibleGeneration])
    await repo.appendStreamChunks([
      streamTextRow(older, target.id, '-older-should-not-apply'),
      streamTextRow(newer, target.id, '-newer'),
      streamTextRow(incompatibleGeneration, target.id, '-generation-should-not-apply'),
    ])
    const events: BroadcastEvent[] = []
    const stop = onEvent((event) => events.push(event))

    await expect(
      recoverStaleContinuationAttempts({
        repo,
        leases: [older, newer, planning, incompatibleGeneration],
        now: 100_000,
        isTargetActive: () => false,
      }),
    ).resolves.toBe(1)
    stop()

    const recovered = required(await repo.getMessage(target.id), 'recovered target')
    expect(recovered.content).toEqual([{ type: 'output_text', text: 'original-newer' }])
    expect(recovered.continuationAttempts).toHaveLength(1)
    expect(recovered.continuationAttempts?.[0]).toMatchObject({
      streamId: newer.streamId,
      status: 'interrupted',
      abortReason: 'tab-close',
    })
    expect(await repo.listStreamLeasesForMessage(target.id)).toEqual([])
    expect(await repo.listStreamChunksForMessage(target.id)).toEqual([])
    expect(endedStreamIds(events)).toEqual(
      [older.streamId, newer.streamId, planning.streamId, incompatibleGeneration.streamId].sort(),
    )
  })

  it('keeps an unfinished generation authoritative over a newer continuation journal', async () => {
    const { chatId, target } = await seedAssistant('unfinished-target', false)
    const repo = getBrowserRepository()
    const generation = await repo.upsertStreamLease({
      streamId: 'unfinished-generation',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-generation',
      startedAt: 100,
      heartbeatAt: 200,
    })
    const durable = durableLeaseFields(generation)
    const continuation: StreamLeaseRow = {
      streamId: 'newer-incompatible-continuation',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-continuation',
      fenceToken: 'newer-incompatible-continuation-fence',
      replacementEpoch: durable.replacementEpoch,
      admissionSequence: durable.admissionSequence + 1,
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseBodyVersion: required(await repo.getMessageHeader(target.id), 'target header')
        .bodyVersion,
    }
    await getDb().streamLeases.put(continuation)
    await repo.appendStreamChunks([
      streamTextRow(generation, target.id, '-generation'),
      streamTextRow(continuation, target.id, '-continuation-should-not-apply'),
    ])
    const events: BroadcastEvent[] = []
    const stop = onEvent((event) => events.push(event))

    await expect(recoverOrphans(100_000, chatId)).resolves.toBe(1)
    stop()

    const recovered = required(await repo.getMessage(target.id), 'recovered target')
    expect(recovered.content).toEqual([{ type: 'output_text', text: 'original-generation' }])
    expect(recovered.generation).toMatchObject({
      status: 'interrupted',
      abortReason: 'tab-close',
      finishedAt: 100_000,
    })
    expect(recovered.continuationAttempts).toBeUndefined()
    expect(await repo.listStreamLeasesForMessage(target.id)).toEqual([])
    expect(await repo.listStreamChunksForMessage(target.id)).toEqual([])
    expect(endedStreamIds(events)).toEqual([generation.streamId, continuation.streamId].sort())
  })

  it('retains the generation anchor until every secondary journal survives cleanup', async () => {
    const { chatId, target } = await seedAssistant('generation-cleanup-retry', false)
    const repo = getBrowserRepository()
    const older = await repo.upsertStreamLease({
      streamId: 'generation-cleanup-secondary',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-generation-secondary',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'generation',
    })
    const durable = durableLeaseFields(older)
    const primary: StreamLeaseRow = {
      ...older,
      streamId: 'generation-cleanup-anchor',
      ownerClientId: 'closed-generation-anchor',
      fenceToken: 'generation-cleanup-anchor-fence',
      admissionSequence: durable.admissionSequence + 1,
    }
    const incompatible: StreamLeaseRow = {
      streamId: 'generation-cleanup-continuation',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-generation-cleanup-continuation',
      fenceToken: 'generation-cleanup-continuation-fence',
      replacementEpoch: durable.replacementEpoch,
      admissionSequence: durable.admissionSequence + 2,
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseBodyVersion: required(await repo.getMessageHeader(target.id), 'target header')
        .bodyVersion,
    }
    await getDb().streamLeases.bulkPut([primary, incompatible])
    await repo.appendStreamChunks([
      streamTextRow(older, target.id, '-secondary-should-not-apply'),
      streamTextRow(primary, target.id, '-primary'),
      streamTextRow(incompatible, target.id, '-continuation-should-not-apply'),
    ])
    const originalDelete = repo.deleteStreamJournal.bind(repo)
    let cleanupCalls = 0
    let failed = false
    vi.spyOn(repo, 'deleteStreamJournal').mockImplementation(async (...args) => {
      cleanupCalls += 1
      if (!failed && cleanupCalls === 2) {
        failed = true
        throw new Error('injected secondary cleanup failure')
      }
      return originalDelete(...args)
    })

    await expect(recoverOrphans(100_000, chatId)).rejects.toThrow(
      'injected secondary cleanup failure',
    )
    expect((await repo.getMessage(target.id))?.content).toEqual([
      { type: 'output_text', text: 'original-primary' },
    ])
    expect((await repo.getMessageHeader(target.id))?.generation?.finishedAt).toBe(100_000)
    expect(
      (await repo.listStreamLeasesForMessage(target.id)).map((lease) => lease.streamId),
    ).toEqual([primary.streamId])
    expect(
      (await repo.listStreamChunksForMessage(target.id)).some(
        (chunk) => chunk.streamId === primary.streamId,
      ),
    ).toBe(true)

    await expect(recoverOrphans(100_001, chatId)).resolves.toBe(1)
    expect((await repo.getMessage(target.id))?.content).toEqual([
      { type: 'output_text', text: 'original-primary' },
    ])
    expect(await repo.listStreamLeasesForMessage(target.id)).toEqual([])
    expect(await repo.listStreamChunksForMessage(target.id)).toEqual([])
  })

  it('retains the continuation anchor and never appends twice after secondary cleanup fails', async () => {
    const { chatId, target } = await seedAssistant('continuation-cleanup-retry', true)
    const repo = getBrowserRepository()
    const baseline = required(await repo.getMessageHeader(target.id), 'target header')
    const older = await repo.upsertStreamLease({
      streamId: 'continuation-cleanup-secondary',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-continuation-secondary',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseBodyVersion: baseline.bodyVersion,
    })
    const durable = durableLeaseFields(older)
    const primary: StreamLeaseRow = {
      ...older,
      streamId: 'continuation-cleanup-anchor',
      ownerClientId: 'closed-continuation-anchor',
      fenceToken: 'continuation-cleanup-anchor-fence',
      admissionSequence: durable.admissionSequence + 1,
    }
    const incompatible: StreamLeaseRow = {
      streamId: 'continuation-cleanup-generation',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-continuation-cleanup-generation',
      fenceToken: 'continuation-cleanup-generation-fence',
      replacementEpoch: durable.replacementEpoch,
      admissionSequence: durable.admissionSequence + 2,
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'generation',
    }
    await getDb().streamLeases.bulkPut([primary, incompatible])
    await repo.appendStreamChunks([
      streamTextRow(older, target.id, '-secondary-should-not-apply'),
      streamTextRow(primary, target.id, '-primary'),
      streamTextRow(incompatible, target.id, '-generation-should-not-apply'),
    ])
    const originalDelete = repo.deleteStreamJournal.bind(repo)
    let cleanupCalls = 0
    let failed = false
    vi.spyOn(repo, 'deleteStreamJournal').mockImplementation(async (...args) => {
      cleanupCalls += 1
      if (!failed && cleanupCalls === 2) {
        failed = true
        throw new Error('injected continuation secondary cleanup failure')
      }
      return originalDelete(...args)
    })

    await expect(recoverOrphans(100_000, chatId)).rejects.toThrow(
      'injected continuation secondary cleanup failure',
    )
    const firstRecovery = required(await repo.getMessage(target.id), 'first recovery target')
    expect(firstRecovery.content).toEqual([{ type: 'output_text', text: 'original-primary' }])
    expect(firstRecovery.continuationAttempts).toHaveLength(1)
    expect(firstRecovery.continuationAttempts?.[0]?.streamId).toBe(primary.streamId)
    expect(
      (await repo.listStreamLeasesForMessage(target.id)).map((lease) => lease.streamId),
    ).toEqual([primary.streamId])

    await expect(recoverOrphans(100_001, chatId)).resolves.toBe(1)
    const retried = required(await repo.getMessage(target.id), 'retried recovery target')
    expect(retried.content).toEqual([{ type: 'output_text', text: 'original-primary' }])
    expect(retried.continuationAttempts).toHaveLength(1)
    expect(await repo.listStreamLeasesForMessage(target.id)).toEqual([])
    expect(await repo.listStreamChunksForMessage(target.id)).toEqual([])
  })

  it('cleans incompatible journals before terminalizing a generation with no primary', async () => {
    const { chatId, target } = await seedAssistant('generation-no-primary-retry', false)
    const repo = getBrowserRepository()
    const continuation = await repo.upsertStreamLease({
      streamId: 'generation-no-primary-continuation',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-no-primary-continuation',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseBodyVersion: required(await repo.getMessageHeader(target.id), 'target header')
        .bodyVersion,
    })
    await repo.appendStreamChunks([
      streamTextRow(continuation, target.id, '-continuation-should-not-apply'),
    ])
    const originalDelete = repo.deleteStreamJournal.bind(repo)
    let failed = false
    vi.spyOn(repo, 'deleteStreamJournal').mockImplementation(async (...args) => {
      if (!failed) {
        failed = true
        throw new Error('injected pre-commit cleanup failure')
      }
      return originalDelete(...args)
    })

    await expect(recoverOrphans(100_000, chatId)).rejects.toThrow(
      'injected pre-commit cleanup failure',
    )
    expect((await repo.getMessageHeader(target.id))?.generation?.finishedAt).toBeUndefined()
    expect(await repo.listStreamLeasesForMessage(target.id)).toEqual([])
    expect(await repo.listStreamChunksForMessage(target.id)).toHaveLength(1)

    await expect(recoverOrphans(100_001, chatId)).resolves.toBe(1)
    expect((await repo.getMessage(target.id))?.content).toEqual(target.content)
    expect((await repo.getMessageHeader(target.id))?.generation).toMatchObject({
      finishedAt: 100_001,
      status: 'interrupted',
      abortReason: 'tab-close',
    })
    expect(await repo.listStreamLeasesForMessage(target.id)).toEqual([])
    expect(await repo.listStreamChunksForMessage(target.id)).toEqual([])
  })

  it('new target admission removes lease-less debris from a finalized recovery group', async () => {
    const { chatId, target } = await seedAssistant('admission-cleans-target-debris', true)
    const repo = getBrowserRepository()
    const anchor = await repo.upsertStreamLease({
      streamId: 'finalized-generation-anchor',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-finalized-generation',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'generation',
    })
    const debris: StreamLeaseRow = {
      ...anchor,
      streamId: 'lease-less-secondary-debris',
      ownerClientId: 'missing-secondary-owner',
      fenceToken: 'lease-less-secondary-fence',
    }
    await repo.appendStreamChunks([streamTextRow(anchor, target.id, '-anchor')])
    await getDb().streamChunks.put(streamTextRow(debris, target.id, '-debris'))

    const incoming = await repo.upsertStreamLease({
      streamId: 'incoming-continuation',
      chatId,
      messageId: target.id,
      ownerClientId: 'incoming-owner',
      startedAt: 300,
      heartbeatAt: 300,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
      baseBodyVersion: required(await repo.getMessageHeader(target.id), 'target header')
        .bodyVersion,
    })

    expect(
      (await repo.listStreamLeasesForMessage(target.id)).map((lease) => lease.streamId),
    ).toEqual([incoming.streamId])
    expect(await repo.listStreamChunksForMessage(target.id)).toEqual([])
  })

  it('retries missing-target cleanup as one group without stranding lease-less sibling chunks', async () => {
    const { chatId, target } = await seedAssistant('missing-target-cleanup-retry', false)
    const repo = getBrowserRepository()
    const anchor = await repo.upsertStreamLease({
      streamId: 'missing-target-cleanup-anchor',
      chatId,
      messageId: target.id,
      ownerClientId: 'closed-missing-target-owner',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'generation',
    })
    const debris: StreamLeaseRow = {
      ...anchor,
      streamId: 'missing-target-lease-less-debris',
      ownerClientId: 'missing-target-debris-owner',
      fenceToken: 'missing-target-debris-fence',
    }
    const durable = durableLeaseFields(anchor)
    const newerSibling: StreamLeaseRow = {
      ...anchor,
      streamId: 'missing-target-newer-sibling',
      ownerClientId: 'missing-target-newer-owner',
      fenceToken: 'missing-target-newer-fence',
      admissionSequence: durable.admissionSequence + 1,
    }
    await getDb().streamLeases.put(newerSibling)
    await repo.appendStreamChunks([
      streamTextRow(anchor, target.id, '-anchor'),
      streamTextRow(newerSibling, target.id, '-newer'),
    ])
    await getDb().streamChunks.put(streamTextRow(debris, target.id, '-debris'))
    await getDb().transaction('rw', getDb().messages, getDb().messageBodies, async () => {
      await getDb().messages.delete(target.id)
      await getDb().messageBodies.delete(target.id)
    })
    const originalDelete = repo.deleteStreamJournal.bind(repo)
    let failed = false
    vi.spyOn(repo, 'deleteStreamJournal').mockImplementation(async (...args) => {
      if (!failed && args[0] === newerSibling.streamId) {
        failed = true
        throw new Error('injected missing-target group cleanup failure')
      }
      return originalDelete(...args)
    })
    const replacementEpoch = durableLeaseFields(anchor).replacementEpoch
    const point = {
      chatId,
      streamId: anchor.streamId,
      messageId: target.id,
      attemptKind: 'generation' as const,
      replacementEpoch,
    }

    await expect(recoverStreamOrphan(point, 100_000)).rejects.toThrow(
      'injected missing-target group cleanup failure',
    )
    expect(await repo.getStreamLease(anchor.streamId)).toBeDefined()
    expect(await repo.listStreamChunksForMessage(target.id)).toHaveLength(2)

    await expect(recoverStreamOrphan(point, 100_001)).resolves.toBe('recovered')
    expect(await repo.listStreamLeasesForMessage(target.id)).toEqual([])
    expect(await repo.listStreamChunksForMessage(target.id)).toEqual([])
  })

  it("never cleans another chat's target when a corrupt point reuses its message id", async () => {
    const pointChat = await createChat({ settings: settings() })
    const { chatId: ownerChatId, target } = await seedAssistant(
      'cross-chat-missing-target-safety',
      false,
    )
    const repo = getBrowserRepository()
    const ownerLease = await repo.upsertStreamLease({
      streamId: 'cross-chat-owner-stream',
      chatId: ownerChatId,
      messageId: target.id,
      ownerClientId: 'cross-chat-owner',
      startedAt: 100,
      heartbeatAt: 200,
      attemptKind: 'generation',
    })
    await repo.appendStreamChunks([streamTextRow(ownerLease, target.id, '-owner-data')])
    const replacementEpoch = durableLeaseFields(ownerLease).replacementEpoch

    await expect(
      recoverStreamOrphan(
        {
          chatId: pointChat.id,
          streamId: 'cross-chat-corrupt-point',
          messageId: target.id,
          attemptKind: 'generation',
          replacementEpoch,
        },
        100_000,
      ),
    ).resolves.toBe('recovered')

    expect(await repo.getStreamLease(ownerLease.streamId)).toMatchObject({
      streamId: ownerLease.streamId,
      chatId: ownerChatId,
      messageId: target.id,
      ownerClientId: ownerLease.ownerClientId,
      fenceToken: ownerLease.fenceToken,
      replacementEpoch: ownerLease.replacementEpoch,
    })
    expect(await repo.listStreamChunks(ownerLease.streamId)).toHaveLength(1)
    expect(await repo.getMessageHeader(target.id)).toMatchObject({ chatId: ownerChatId })
  })
})

async function seedAssistant(
  suffix: string,
  finished: boolean,
): Promise<{ chatId: string; target: Message }> {
  const chat = await createChat({ settings: settings() })
  const repo = getBrowserRepository()
  const user: Message = {
    id: `user-${suffix}`,
    chatId: chat.id,
    parentId: null,
    siblingIndex: 0,
    turnId: `user-turn-${suffix}`,
    turnIndex: 0,
    createdAt: 10,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'question' }],
    nodeVersion: 0,
    deleted: false,
  }
  const target: Message = {
    id: `assistant-${suffix}`,
    chatId: chat.id,
    parentId: user.id,
    siblingIndex: 0,
    turnId: `assistant-turn-${suffix}`,
    turnIndex: 0,
    createdAt: 20,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'original' }],
    generation: {
      id: `generation-${suffix}`,
      model: 'test/recovery-model',
      requestedModel: 'test/recovery-model',
      apiUsed: 'chat',
      delivery: 'streaming',
      costSource: 'stream',
      startedAt: 11,
      ...(finished ? { finishedAt: 19, status: 'done' as const, integrity: 'clean' as const } : {}),
    },
    nodeVersion: 0,
    deleted: false,
  }
  await repo.runMutation(
    [
      { kind: 'message', messageId: user.id },
      { kind: 'message', messageId: target.id },
      { kind: 'children', chatId: chat.id, parentId: null },
      { kind: 'children', chatId: chat.id, parentId: user.id },
    ],
    async (ctx) => {
      await ctx.putMessage(user)
      await ctx.putMessage(target)
    },
  )
  return { chatId: chat.id, target }
}

function streamTextRow(lease: StreamLeaseRow, messageId: string, text: string) {
  const durable = durableLeaseFields(lease)
  return {
    id: `${lease.streamId}:0`,
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId,
    seq: 0,
    createdAt: 300,
    event: { lane: 'text' as const, text },
    fenceToken: durable.fenceToken,
    replacementEpoch: durable.replacementEpoch,
  }
}

function durableLeaseFields(lease: StreamLeaseRow): {
  fenceToken: string
  replacementEpoch: number
  admissionSequence: number
} {
  if (
    !lease.fenceToken ||
    lease.replacementEpoch === undefined ||
    lease.admissionSequence === undefined
  ) {
    throw new Error(`expected durable lease fields for ${lease.streamId}`)
  }
  return {
    fenceToken: lease.fenceToken,
    replacementEpoch: lease.replacementEpoch,
    admissionSequence: lease.admissionSequence,
  }
}

function endedStreamIds(events: readonly BroadcastEvent[]): string[] {
  return events
    .filter((event) => event.kind === 'stream-ended')
    .map((event) => event.streamId)
    .sort()
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

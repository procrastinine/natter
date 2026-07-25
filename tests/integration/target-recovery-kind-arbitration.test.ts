import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, Message, MessageId } from '../../src/core/types'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { importMessagesOp } from '../../src/store/conversation-command-client'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { persistStreamEventV2 } from '../../src/store/persisted-stream-event'
import { type StreamLeaseRow, streamLeaseHasWriteFence } from '../../src/store/repository'
import type { CanonicalStreamJournalFrameRow } from '../../src/store/stream-journal-codec'
import { recoverStreamOrphan, streamRecoveryRuntimeSnapshot } from '../../src/store/stream-recovery'
import type { WorkspaceRepository } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
  readWorkspaceMeta,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'
import { createChat } from '../helpers/chats'
import { readTestMessageHeader } from '../helpers/message-storage'
import { encodeTestStreamJournalEntries } from '../helpers/stream-journal'
import {
  type TestContinuationLeaseInput,
  type TestGenerationLeaseInput,
  testContinuationLease,
  testGenerationLease,
} from '../helpers/stream-leases'

const DB_NAME = 'natter'
const STARTED_AT = Date.now()
const RECOVERY_AT = STARTED_AT + 60_000

function settings(): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: 'target-recovery-profile',
    model: 'test/recovery-model',
  }
}

async function reset(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openBrowserWorkspace()
})

afterEach(async () => {
  vi.restoreAllMocks()
  __resetWorkspaceRepositoryForTests()
  await shutdownBrowserWorkspace()
  await reset()
})

describe('target recovery kind arbitration', () => {
  it('recovers a committed continuation once and records its durable provenance', async () => {
    const { chatId, target } = await seedAssistant('continuation')
    const header = required(await messageHeader(target.id), 'target header')
    const lease = await insertLease({
      streamId: 'continuation-recovery',
      chatId,
      messageId: target.id,
      attemptKind: 'continuation',
      targetCommittedAt: STARTED_AT + 1,
      continuationStrategy: 'prompt',
      baseNodeVersion: header.nodeVersion,
      baseBodyVersion: header.bodyVersion,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    await appendStreamText(lease, ['-continued'])

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT)).resolves.toBe(
      'recovered',
    )

    const recovered = required(await message(target.id), 'recovered target')
    expect(recovered.content).toEqual([{ type: 'output_text', text: 'original-continued' }])
    expect(recovered.continuationAttempts).toEqual([
      expect.objectContaining({
        streamId: lease.streamId,
        status: 'interrupted',
        abortReason: 'tab-close',
        requestedModel: settings().model,
        apiUsed: 'chat',
        startedAt: STARTED_AT,
        finishedAt: RECOVERY_AT,
      }),
    ])
    expect(await streamLease(lease.streamId)).toBeUndefined()
    expect(await streamFrames(lease.streamId)).toEqual([])

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT + 1)).resolves.toBe(
      'resolved',
    )
    expect((await message(target.id))?.content).toEqual([
      { type: 'output_text', text: 'original-continued' },
    ])
    expect((await message(target.id))?.continuationAttempts).toHaveLength(1)
  })

  it('recovers a committed generation according to its immutable lease kind', async () => {
    const { chatId, target } = await seedAssistant('generation')
    const lease = await insertLease({
      streamId: 'generation-recovery',
      chatId,
      messageId: target.id,
      attemptKind: 'generation',
      targetCommittedAt: STARTED_AT + 1,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    await appendStreamText(lease, ['-generated'])

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT)).resolves.toBe(
      'recovered',
    )

    const recovered = required(await message(target.id), 'recovered target')
    expect(recovered.content).toEqual([{ type: 'output_text', text: 'original-generated' }])
    expect(recovered.generation).toMatchObject({
      model: settings().model,
      requestedModel: settings().model,
      apiUsed: 'chat',
      status: 'interrupted',
      abortReason: 'tab-close',
      startedAt: STARTED_AT,
      finishedAt: RECOVERY_AT,
    })
    expect(recovered.continuationAttempts).toBeUndefined()
    expect(await streamLease(lease.streamId)).toBeUndefined()
    expect(await streamFrames(lease.streamId)).toEqual([])
  })

  it('terminalizes a corrupt current journal once instead of leaving phantom stream ownership', async () => {
    const { chatId, target } = await seedAssistant('corrupt-current-journal')
    const lease = await insertLease({
      streamId: 'corrupt-current-journal-recovery',
      chatId,
      messageId: target.id,
      attemptKind: 'generation',
      targetCommittedAt: STARTED_AT + 1,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    const frames = await encodeTestStreamJournalEntries({
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      fence: leaseFence(lease),
      entries: [
        {
          createdAt: STARTED_AT + 2,
          event: persistStreamEventV2({ lane: 'text', text: '-valid-prefix' }),
        },
        {
          createdAt: STARTED_AT + 3,
          event: { version: 1, event: { lane: 'text' } },
        },
      ],
    })
    await runWorkspaceAction('stream-recovery', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'stream.append-journal-frames',
        frames,
      }),
    )

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT)).resolves.toBe(
      'recovered',
    )

    expect(await message(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'original-valid-prefix' }],
      generation: {
        status: 'error',
        error: {
          category: 'integrity',
          code: 'STREAM_JOURNAL_EVENT_INVALID',
          retryable: false,
        },
      },
    })
    expect(await streamLease(lease.streamId)).toBeUndefined()
    expect(await streamFrames(lease.streamId)).toEqual([])
    expect(streamRecoveryRuntimeSnapshot().queuedCount).toBe(0)

    const recovered = await message(target.id)
    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT + 1)).resolves.toBe(
      'resolved',
    )
    expect(await message(target.id)).toEqual(recovered)
  })

  it('recovers a stopped generation as the durable user Stop after its owner disappears', async () => {
    const { chatId, target } = await seedAssistant('stopped-generation')
    const requestedAt = STARTED_AT + 10
    const lease = await insertLease({
      streamId: 'stopped-generation-recovery',
      chatId,
      messageId: target.id,
      attemptKind: 'generation',
      targetCommittedAt: STARTED_AT + 1,
      requestedModel: settings().model,
      apiUsed: 'chat',
      stopControl: {
        requestId: 'stop:stopped-generation-recovery',
        requestedBy: 'departed-tab',
        requestedAt,
        reason: 'user',
      },
    })
    await appendStreamText(lease, ['-partial'])

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT)).resolves.toBe(
      'recovered',
    )

    const recovered = required(await message(target.id), 'recovered stopped target')
    expect(recovered.content).toEqual([{ type: 'output_text', text: 'original-partial' }])
    expect(recovered.generation).toMatchObject({
      status: 'abort',
      abortReason: 'user',
      startedAt: STARTED_AT,
      finishedAt: RECOVERY_AT,
    })
    expect(await streamLease(lease.streamId)).toBeUndefined()
    expect(await streamFrames(lease.streamId)).toEqual([])
  })

  it.each([
    'generation',
    'continuation',
  ] as const)('reuses a sealed %s decision and ignores journal rows beyond its receipt', async (attemptKind) => {
    const { chatId, target } = await seedAssistant(`sealed-${attemptKind}`)
    const header = required(await messageHeader(target.id), 'target header')
    const finishedAt = STARTED_AT + 10
    const terminal = {
      version: 1 as const,
      finishedAt,
      journalMaxSeq: 0,
      journalCompleteness: 'settled' as const,
      decision: { outcome: 'done' as const, finishReason: 'stop' },
    }
    const lease = await insertLease(
      attemptKind === 'generation'
        ? {
            streamId: 'sealed-generation-recovery',
            chatId,
            messageId: target.id,
            attemptKind,
            phase: 'terminal-decided',
            journalMaxSeq: 0,
            terminal,
            stopControl: {
              requestId: `stop-sealed-${attemptKind}`,
              requestedBy: 'stranded-tab',
              requestedAt: finishedAt + 1,
              reason: 'user',
            },
            controlRevision: 1,
            targetCommittedAt: STARTED_AT + 1,
            requestedModel: settings().model,
            apiUsed: 'chat',
          }
        : {
            streamId: 'sealed-continuation-recovery',
            chatId,
            messageId: target.id,
            attemptKind,
            phase: 'terminal-decided',
            journalMaxSeq: 0,
            terminal,
            stopControl: {
              requestId: `stop-sealed-${attemptKind}`,
              requestedBy: 'stranded-tab',
              requestedAt: finishedAt + 1,
              reason: 'user',
            },
            controlRevision: 1,
            targetCommittedAt: STARTED_AT + 1,
            continuationStrategy: 'prompt',
            baseNodeVersion: header.nodeVersion,
            baseBodyVersion: header.bodyVersion,
            requestedModel: settings().model,
            apiUsed: 'chat',
          },
    )
    await putStreamTextFrames(lease, ['-sealed', '-must-not-replay'])

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT)).resolves.toBe(
      'recovered',
    )

    const recovered = required(await message(target.id), 'recovered target')
    expect(recovered.content).toEqual([{ type: 'output_text', text: 'original-sealed' }])
    if (attemptKind === 'generation') {
      expect(recovered.generation).toMatchObject({ status: 'done', finishedAt })
    } else {
      expect(recovered.continuationAttempts).toEqual([
        expect.objectContaining({ status: 'done', finishedAt }),
      ])
    }
    expect(await streamLease(lease.streamId)).toBeUndefined()
    expect(await streamFrames(lease.streamId)).toEqual([])
  })

  it('enforces one durable attempt per target before recovery has to arbitrate kinds', async () => {
    const { chatId, target } = await seedAssistant('unique-target')
    const first = leaseRow({
      streamId: 'unique-generation',
      chatId,
      messageId: target.id,
      attemptKind: 'generation',
      targetCommittedAt: STARTED_AT + 1,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    const second = leaseRow({
      streamId: 'unique-continuation',
      chatId,
      messageId: target.id,
      attemptKind: 'continuation',
      targetCommittedAt: STARTED_AT + 2,
      continuationStrategy: 'prompt',
      baseNodeVersion: 0,
      baseBodyVersion: 0,
      requestedModel: settings().model,
      apiUsed: 'chat',
      admissionSequence: 2,
    })

    await getDb().streamLeases.put(first)
    await expect(getDb().streamLeases.put(second)).rejects.toMatchObject({
      name: 'ConstraintError',
    })
    expect(await streamLease(first.streamId)).toEqual(first)
    expect(await streamLease(second.streamId)).toBeUndefined()
  })

  it('retains a canonical recovery until cleanup succeeds without applying it twice', async () => {
    const { chatId, target } = await seedAssistant('cleanup-retry')
    const header = required(await messageHeader(target.id), 'target header')
    const lease = await insertLease({
      streamId: 'continuation-cleanup-retry',
      chatId,
      messageId: target.id,
      attemptKind: 'continuation',
      targetCommittedAt: STARTED_AT + 1,
      continuationStrategy: 'prompt',
      baseNodeVersion: header.nodeVersion,
      baseBodyVersion: header.bodyVersion,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    await appendStreamText(lease, ['-once'])
    const targetRepository = getBrowserRepository()
    let failCleanup = true
    const wrapped = repositoryProxy(targetRepository, async (permit, command) => {
      if (command.kind === 'stream.finish-cleanup' && failCleanup) {
        failCleanup = false
        throw new Error('injected cleanup failure')
      }
      return targetRepository.execute(permit, command)
    })
    __setWorkspaceRepositoryForTests(wrapped)

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT)).resolves.toBe(
      'retry',
    )
    expect((await message(target.id))?.content).toEqual([
      { type: 'output_text', text: 'original-once' },
    ])
    expect((await message(target.id))?.continuationAttempts).toHaveLength(1)
    expect(await streamLease(lease.streamId)).toMatchObject({ canonicalAt: RECOVERY_AT })

    await expect(
      recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT + 60_001),
    ).resolves.toMatch(/^(?:recovered|resolved)$/u)
    expect((await message(target.id))?.content).toEqual([
      { type: 'output_text', text: 'original-once' },
    ])
    expect((await message(target.id))?.continuationAttempts).toHaveLength(1)
    expect(await streamLease(lease.streamId)).toBeUndefined()
    expect(await streamFrames(lease.streamId)).toEqual([])
  })

  it('single-flights simultaneous recovery callers through one durable claim', async () => {
    const { chatId, target } = await seedAssistant('single-flight')
    const header = required(await messageHeader(target.id), 'target header')
    const lease = await insertLease({
      streamId: 'continuation-single-flight',
      chatId,
      messageId: target.id,
      attemptKind: 'continuation',
      targetCommittedAt: STARTED_AT + 1,
      continuationStrategy: 'prompt',
      baseNodeVersion: header.nodeVersion,
      baseBodyVersion: header.bodyVersion,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    await appendStreamText(lease, ['-once'])
    const targetRepository = getBrowserRepository()
    let claimCount = 0
    __setWorkspaceRepositoryForTests(
      repositoryProxy(targetRepository, async (permit, command) => {
        if (command.kind === 'stream.claim-recovery') claimCount += 1
        return targetRepository.execute(permit, command)
      }),
    )

    await expect(
      Promise.all([
        recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT),
        recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT),
      ]),
    ).resolves.toEqual(['recovered', 'recovered'])
    expect(claimCount).toBe(1)
    expect((await message(target.id))?.content).toEqual([
      { type: 'output_text', text: 'original-once' },
    ])
    expect((await message(target.id))?.continuationAttempts).toHaveLength(1)
    expect(await streamLease(lease.streamId)).toBeUndefined()
  })

  it('leaves current coordinator evidence queued behind a stale fenced caller', async () => {
    const { chatId, target } = await seedAssistant('stale-point-overlap')
    const header = required(await messageHeader(target.id), 'target header')
    const lease = await insertLease({
      streamId: 'continuation-stale-point-overlap',
      chatId,
      messageId: target.id,
      attemptKind: 'continuation',
      targetCommittedAt: STARTED_AT + 1,
      continuationStrategy: 'prompt',
      baseNodeVersion: header.nodeVersion,
      baseBodyVersion: header.bodyVersion,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    await appendStreamText(lease, ['-once'])
    const targetRepository = getBrowserRepository()
    let failCleanup = true
    __setWorkspaceRepositoryForTests(
      repositoryProxy(targetRepository, async (permit, command) => {
        if (command.kind === 'stream.finish-cleanup' && failCleanup) {
          failCleanup = false
          throw new Error('injected stale-overlap cleanup failure')
        }
        return targetRepository.execute(permit, command)
      }),
    )
    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT)).resolves.toBe(
      'retry',
    )
    const canonical = required(await streamLease(lease.streamId), 'canonical lease')
    const workspace = await readWorkspaceMeta()

    let releaseWorkspaceRead = () => {}
    const workspaceReadGate = new Promise<void>((resolve) => {
      releaseWorkspaceRead = resolve
    })
    let enteredWorkspaceRead = () => {}
    const workspaceReadEntered = new Promise<void>((resolve) => {
      enteredWorkspaceRead = resolve
    })
    let blockFirstWorkspaceRead = true
    __setWorkspaceRepositoryForTests(
      repositoryProxy(
        targetRepository,
        targetRepository.execute.bind(targetRepository),
        async (kind) => {
          if (!blockFirstWorkspaceRead || kind !== 'workspace.meta') return
          blockFirstWorkspaceRead = false
          enteredWorkspaceRead()
          await workspaceReadGate
        },
      ),
    )
    const stale = recoverStreamOrphan(
      {
        streamId: lease.streamId,
        workspaceId: `${workspace.workspaceId}-stale`,
        replacementEpoch: workspace.replacementEpoch,
      },
      RECOVERY_AT + 1,
    )
    await workspaceReadEntered
    await runWorkspaceAction('stream-recovery', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'stream.claim-recovery',
        expected: canonical,
        now: RECOVERY_AT + 2,
      }),
    )
    await Promise.resolve()
    releaseWorkspaceRead()

    await expect(stale).resolves.toBe('resolved')
    await vi.waitFor(async () => {
      expect(await streamLease(lease.streamId)).toBeUndefined()
    })
    expect((await message(target.id))?.content).toEqual([
      { type: 'output_text', text: 'original-once' },
    ])
    expect((await message(target.id))?.continuationAttempts).toHaveLength(1)
  })

  it('does not let stale same-workspace freshness evidence absorb a current recovery', async () => {
    const { chatId, target } = await seedAssistant('stale-freshness-overlap')
    const header = required(await messageHeader(target.id), 'target header')
    const lease = await insertLease({
      streamId: 'continuation-stale-freshness-overlap',
      chatId,
      messageId: target.id,
      attemptKind: 'continuation',
      targetCommittedAt: STARTED_AT + 1,
      continuationStrategy: 'prompt',
      baseNodeVersion: header.nodeVersion,
      baseBodyVersion: header.bodyVersion,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    await appendStreamText(lease, ['-once'])
    const current = required(await streamLease(lease.streamId), 'current recovery lease')
    const targetRepository = getBrowserRepository()
    const workspace = await readWorkspaceMeta()

    let releaseWorkspaceRead = () => {}
    const workspaceReadGate = new Promise<void>((resolve) => {
      releaseWorkspaceRead = resolve
    })
    let enteredWorkspaceRead = () => {}
    const workspaceReadEntered = new Promise<void>((resolve) => {
      enteredWorkspaceRead = resolve
    })
    let blockFirstWorkspaceRead = true
    __setWorkspaceRepositoryForTests(
      repositoryProxy(
        targetRepository,
        targetRepository.execute.bind(targetRepository),
        async (kind) => {
          if (!blockFirstWorkspaceRead || kind !== 'workspace.meta') return
          blockFirstWorkspaceRead = false
          enteredWorkspaceRead()
          await workspaceReadGate
        },
      ),
    )
    const controller = new AbortController()
    const stale = recoverStreamOrphan(
      {
        streamId: lease.streamId,
        workspaceId: workspace.workspaceId,
        replacementEpoch: workspace.replacementEpoch,
        freshnessEpoch: 'stale-freshness-evidence',
        freshnessDeadline: 0,
      },
      RECOVERY_AT + 1,
      controller.signal,
    )
    await workspaceReadEntered
    await runWorkspaceAction('stream-recovery', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'stream.claim-recovery',
        expected: current,
        now: STARTED_AT - 120_000,
      }),
    )
    await vi.waitFor(() => {
      expect(streamRecoveryRuntimeSnapshot().queuedCount).toBe(1)
    })

    controller.abort(new Error('stale freshness caller aborted'))
    releaseWorkspaceRead()

    await expect(stale).rejects.toThrow('stale freshness caller aborted')
    await vi.waitFor(async () => {
      expect(await streamLease(lease.streamId)).toBeUndefined()
    })
    expect(streamRecoveryRuntimeSnapshot().queuedCount).toBe(0)
    expect((await message(target.id))?.content).toEqual([
      { type: 'output_text', text: 'original-once' },
    ])
    expect((await message(target.id))?.continuationAttempts).toHaveLength(1)
  })

  it('cleans a missing target through the same canonical recovery protocol', async () => {
    const { chatId, target } = await seedAssistant('missing-target')
    const lease = await insertLease({
      streamId: 'missing-target-recovery',
      chatId,
      messageId: target.id,
      attemptKind: 'generation',
      targetCommittedAt: STARTED_AT + 1,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    await appendStreamText(lease, ['-orphan'])
    await getDb().transaction('rw', getDb().messages, getDb().messageBodies, async () => {
      await getDb().messages.delete(target.id)
      await getDb().messageBodies.delete(target.id)
    })

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, RECOVERY_AT)).resolves.toBe(
      'recovered',
    )
    expect(await message(target.id)).toBeUndefined()
    expect(await streamLease(lease.streamId)).toBeUndefined()
    expect(await streamFrames(lease.streamId)).toEqual([])
  })

  it('fences recovery points from another workspace incarnation without touching the lease', async () => {
    const { chatId, target } = await seedAssistant('workspace-fence')
    const lease = await insertLease({
      streamId: 'workspace-fenced-recovery',
      chatId,
      messageId: target.id,
      attemptKind: 'generation',
      targetCommittedAt: STARTED_AT + 1,
      requestedModel: settings().model,
      apiUsed: 'chat',
    })
    await appendStreamText(lease, ['-must-remain'])
    const retained = required(await streamLease(lease.streamId), 'retained workspace-fenced lease')
    const workspace = await readWorkspaceMeta()

    await expect(
      recoverStreamOrphan(
        {
          streamId: lease.streamId,
          workspaceId: `${workspace.workspaceId}-stale`,
          replacementEpoch: workspace.replacementEpoch,
        },
        RECOVERY_AT,
      ),
    ).resolves.toBe('resolved')
    expect(await streamLease(lease.streamId)).toEqual(retained)
    expect(await streamFrames(lease.streamId)).toHaveLength(1)
  })
})

async function seedAssistant(suffix: string): Promise<{ chatId: string; target: Message }> {
  const chat = await createChat({ settings: settings() })
  const imported = await importMessagesOp({
    chatId: chat.id,
    slot: { kind: 'at-end' },
    activeLeafId: null,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'original' }] },
    ],
    now: STARTED_AT - 100,
  })
  const target = required(imported.presentations[1]?.message, `assistant ${suffix}`)
  return { chatId: chat.id, target }
}

type LeaseInput =
  | (TestGenerationLeaseInput & { attemptKind: 'generation' })
  | (TestContinuationLeaseInput & { attemptKind: 'continuation' })

function leaseRow(input: LeaseInput): StreamLeaseRow {
  const common = {
    ...input,
    ownerClientId: `owner:${input.streamId}`,
    fenceToken: `fence:${input.streamId}`,
    replacementEpoch: 0,
    startedAt: STARTED_AT,
    heartbeatAt: STARTED_AT,
    admissionSequence: input.admissionSequence ?? 1,
    revision: 0,
    postCommit: input.postCommit ?? {
      usedAt: STARTED_AT,
      profileId: settings().profileId,
    },
  }
  return input.attemptKind === 'continuation'
    ? testContinuationLease(common)
    : testGenerationLease(common)
}

async function insertLease(input: LeaseInput): Promise<StreamLeaseRow> {
  const lease = leaseRow(input)
  await getDb().streamLeases.put(lease)
  return lease
}

function leaseFence(lease: StreamLeaseRow) {
  if (!streamLeaseHasWriteFence(lease)) throw new Error('ExpectedFencedTestLease')
  return {
    ownerClientId: lease.ownerClientId,
    fenceToken: lease.fenceToken,
    replacementEpoch: lease.replacementEpoch,
    admissionSequence: lease.admissionSequence,
  }
}

async function streamTextFrames(
  lease: StreamLeaseRow,
  texts: readonly string[],
): Promise<readonly CanonicalStreamJournalFrameRow[]> {
  return encodeTestStreamJournalEntries({
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    fence: leaseFence(lease),
    entries: texts.map((text, index) => ({
      createdAt: STARTED_AT + 2 + index,
      event: persistStreamEventV2({ lane: 'text', text }),
    })),
  })
}

async function appendStreamText(lease: StreamLeaseRow, texts: readonly string[]): Promise<void> {
  const frames = await streamTextFrames(lease, texts)
  await runWorkspaceAction('stream-recovery', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'stream.append-journal-frames',
      frames,
    }),
  )
}

async function putStreamTextFrames(lease: StreamLeaseRow, texts: readonly string[]): Promise<void> {
  await getDb().streamChunks.bulkPut([...(await streamTextFrames(lease, texts))])
}

async function message(messageId: MessageId): Promise<Message | undefined> {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'message.presentation', messageId },
        { signal: permit.signal },
      )
    ).value?.message
  })
}

async function messageHeader(messageId: MessageId) {
  return readTestMessageHeader(messageId)
}

async function streamLease(streamId: string): Promise<StreamLeaseRow | undefined> {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'stream.lease', streamId },
        { signal: permit.signal },
      )
    ).value
  })
}

async function streamFrames(streamId: string): Promise<readonly CanonicalStreamJournalFrameRow[]> {
  return runWorkspaceRead('repository-query', async (permit) => {
    const frames: CanonicalStreamJournalFrameRow[] = []
    let afterSeq = -1
    for (;;) {
      const page = (
        await getWorkspaceRepository().query(
          permit,
          {
            kind: 'stream.journal-frame-page',
            streamId,
            afterSeq,
            throughSeq: Number.MAX_SAFE_INTEGER,
          },
          { signal: permit.signal },
        )
      ).value
      frames.push(...page.frames)
      if (page.done) return frames
      if (page.nextAfterSeq <= afterSeq) {
        throw new Error(`StreamJournalPageMadeNoProgress:${streamId}`)
      }
      afterSeq = page.nextAfterSeq
    }
  })
}

function repositoryProxy(
  target: WorkspaceRepository,
  execute: WorkspaceRepository['execute'],
  beforeQuery?: (kind: string) => Promise<void>,
): WorkspaceRepository {
  return {
    async query(permit, query, options) {
      await beforeQuery?.(query.kind)
      return target.query(permit, query, options)
    },
    execute,
    replace: target.replace.bind(target),
    subscribeChanges: target.subscribeChanges.bind(target),
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

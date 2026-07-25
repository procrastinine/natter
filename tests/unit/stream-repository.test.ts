import Dexie, { type Transaction } from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttemptTerminalReceipt } from '../../src/core/attempt-outcome'
import { connectionDispatchProfileProof } from '../../src/core/connection-dispatch-proof'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  ChatSettings,
  ConnectionProfile,
  ContinuationAttemptDraft,
  DispatchedGenerationMeta,
  Message,
  MessageId,
} from '../../src/core/types'
import { HEADER_READ_PAGE_SIZE } from '../../src/store/browser-query-pages'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { importMessagesOp } from '../../src/store/conversation-command-client'
import { __resetDbForTests, getDb } from '../../src/store/db'
import type { MessageHeaderRow } from '../../src/store/message-storage'
import type {
  CanonicalStreamJournalFrameRow,
  StreamLeaseAdmission,
  StreamLeaseRow,
  StreamWriteFence,
  WorkspaceMeta,
} from '../../src/store/repository'
import {
  streamJournalFrameId,
  streamLeaseDispatchEvidence,
  streamLeaseHasWriteFence,
} from '../../src/store/repository'
import { STREAM_LEASE_TTL_MS } from '../../src/store/stream-lease-policy'
import { getStreamClientId } from '../../src/store/stream-leases'
import type {
  AttemptDispatchResult,
  AttemptPrepareResult,
  CommitEnvelope,
  WorkspaceCommand,
  WorkspaceCommandResult,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'
import { createChat } from '../helpers/chats'
import { installGenerationProfile } from '../helpers/generation-engine'
import {
  decodeTestStreamJournalFrames,
  encodeTestStreamJournalEntries,
} from '../helpers/stream-journal'
import { testStreamLeaseAdmission } from '../helpers/stream-leases'

const DB_NAME = 'natter'
const MODEL = 'test/stream-model'
let STARTED_AT = Date.now()

function profile(): ConnectionProfile {
  return {
    id: 'stream-repository-profile',
    name: 'Stream repository profile',
    kind: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost:5173',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

function settings(): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: profile().id,
    model: MODEL,
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
  await installGenerationProfile(profile())
  STARTED_AT = Date.now()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await shutdownBrowserWorkspace()
  await reset()
})

describe('browser stream repository protocol', () => {
  it('assigns local message and chat recency inside the transaction across wall-clock rollback', async () => {
    let clock = 50_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    await createChat({ id: 'future-chat', settings: settings(), now: clock })
    const chat = await createChat({ id: 'rollback-chat', settings: settings(), now: 100 })

    const first = await importMessagesOp({
      chatId: chat.id,
      slot: { kind: 'at-end' },
      activeLeafId: null,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }],
      now: 1,
    })
    const firstMessage = required(first.presentations[0]?.message, 'first message')
    const firstChat = required(await getDb().chats.get(chat.id), 'first chat state')

    clock = 1_000
    const second = await importMessagesOp({
      chatId: chat.id,
      slot: { kind: 'at-end' },
      activeLeafId: firstMessage.id,
      messages: [{ role: 'assistant', content: [{ type: 'output_text', text: 'second' }] }],
      now: 2,
    })
    const secondMessage = required(second.presentations[0]?.message, 'second message')
    const secondChat = required(await getDb().chats.get(chat.id), 'second chat state')

    expect(firstMessage.createdAt).toBe(50_000)
    expect(secondMessage.createdAt).toBeGreaterThan(firstMessage.createdAt)
    expect(firstChat.updatedAt).toBeGreaterThan(50_000)
    expect(secondChat.updatedAt).toBeGreaterThan(firstChat.updatedAt)
    expect(secondChat.lastUpdatedLeafId).toBe(secondMessage.id)
  })

  it('admits leases only through an atomic attempt target and rejects missing or cross-chat targets', async () => {
    const first = await seedTargets(1)
    const second = await seedTargets(1)
    const firstTarget = required(first.targets[0], 'first target')
    const secondTarget = required(second.targets[0], 'second target')

    await expect(
      prepareContinuation({
        streamId: 'missing-chat',
        chatId: 'missing-chat',
        targetAssistantId: firstTarget.id,
      }),
    ).rejects.toMatchObject({ name: 'ChatMissingError', chatId: 'missing-chat' })
    await expect(
      prepareContinuation({
        streamId: 'missing-target',
        chatId: first.chatId,
        targetAssistantId: 'missing-target',
      }),
    ).rejects.toThrow('ContinuationStreamTargetInvalid:missing-target:missing-target')
    await expect(
      prepareContinuation({
        streamId: 'cross-chat-target',
        chatId: first.chatId,
        targetAssistantId: secondTarget.id,
      }),
    ).rejects.toThrow(`ContinuationStreamTargetInvalid:cross-chat-target:${secondTarget.id}`)

    const prepared = await prepareContinuation({
      streamId: 'valid-target',
      chatId: first.chatId,
      targetAssistantId: firstTarget.id,
    })

    expect(prepared.assistant.id).toBe(firstTarget.id)
    expect(prepared.lease).toMatchObject({
      streamId: 'valid-target',
      chatId: first.chatId,
      messageId: firstTarget.id,
      attemptKind: 'continuation',
    })
    expect(await streamLease('missing-chat')).toBeUndefined()
    expect(await streamLease('missing-target')).toBeUndefined()
    expect(await streamLease('cross-chat-target')).toBeUndefined()
    expect(await streamLease('valid-target')).toEqual(prepared.lease)
  })

  it('lists one stream through the compound stream-and-sequence index and returns value clones', async () => {
    const seeded = await seedTargets(2)
    const first = await activeContinuation('stream-a', seeded.chatId, requiredTarget(seeded, 0))
    const second = await activeContinuation('stream-b', seeded.chatId, requiredTarget(seeded, 1))
    await Promise.all([
      appendStreamText(first.lease, [
        { text: 'a', createdAt: 1 },
        { text: 'b', createdAt: 2 },
        { text: 'c', createdAt: 3 },
      ]),
      appendStreamText(second.lease, [{ text: 'other', createdAt: 1 }]),
    ])

    const firstRead = await streamFrames(first.lease.streamId, 2)
    expect(firstRead.map(({ id, seq }) => ({ id, seq }))).toEqual([
      { id: streamJournalFrameId('stream-a', 0), seq: 0 },
      { id: streamJournalFrameId('stream-a', 1), seq: 1 },
      { id: streamJournalFrameId('stream-a', 2), seq: 2 },
    ])
    const secondRead = await streamFrames(first.lease.streamId, 2)
    expect(secondRead[0]).not.toBe(firstRead[0])
    expect(await streamEvents(first.lease.streamId, 2)).toEqual([
      { lane: 'text', text: 'a' },
      { lane: 'text', text: 'b' },
      { lane: 'text', text: 'c' },
    ])
    expect(await streamFrames('missing-stream', -1)).toEqual([])
  })

  it('filters malformed persisted leases while preserving the current continuation recovery contract', async () => {
    const seeded = await seedTargets(1)
    const active = await activeContinuation(
      'continue-stream',
      seeded.chatId,
      requiredTarget(seeded, 0),
    )
    const valid = active.lease
    await getDb().streamLeases.bulkPut([
      {
        ...valid,
        streamId: 'invalid-kind-stream',
        messageId: 'invalid-kind-target',
        targetOwnerKey: 'invalid-kind-target',
        attemptKind: 'invalid',
      } as never,
      {
        ...valid,
        streamId: 'invalid-api-stream',
        messageId: 'invalid-api-target',
        targetOwnerKey: 'invalid-api-target',
        dispatch: { ...valid.dispatch, apiUsed: 'invalid' },
      } as never,
      {
        ...valid,
        streamId: 'invalid-model-stream',
        messageId: 'invalid-model-target',
        targetOwnerKey: 'invalid-model-target',
        dispatch: { ...valid.dispatch, requestedModel: 42 },
      } as never,
      {
        ...valid,
        streamId: 'invalid-strategy-stream',
        messageId: 'invalid-strategy-target',
        targetOwnerKey: 'invalid-strategy-target',
        dispatch: { ...valid.dispatch, continuationStrategy: 'unknown' },
      } as never,
      {
        ...valid,
        streamId: 'invalid-fence-stream',
        messageId: 'invalid-fence-target',
        targetOwnerKey: 'invalid-fence-target',
        admissionSequence: -1,
      },
    ])

    expect(await streamLeases(seeded.chatId)).toEqual([valid])
    expect(valid.attemptKind).toBe('continuation')
    if (valid.attemptKind !== 'continuation') throw new Error('ExpectedContinuationLease')
    expect(valid.dispatch.continuationStrategy).toBe('prompt')
    expect(valid.dispatch.requestedModel).toBe(MODEL)
    expect(valid.dispatch.apiUsed).toBe('chat')
    expect(typeof valid.dispatch.baseNodeVersion).toBe('number')
    expect(typeof valid.dispatch.baseBodyVersion).toBe('number')
  })

  it('installs a new recovery fence and rejects every suspended-owner journal command', async () => {
    const seeded = await seedTargets(1)
    const active = await activeContinuation(
      'reused-stream',
      seeded.chatId,
      requiredTarget(seeded, 0),
    )
    const stale = active.lease
    const replacement = await execute({
      kind: 'stream.claim-recovery',
      expected: stale,
      now: STARTED_AT + 20_000,
    })
    expect(replacement).toBeDefined()

    await expect(
      execute({
        kind: 'stream.renew',
        heartbeat: {
          streamId: stale.streamId,
          fence: leaseFence(stale),
          heartbeatAt: STARTED_AT + 20_001,
        },
      }),
    ).rejects.toThrow('StreamFenceLost:reused-stream')
    await expect(
      appendStreamText(stale, [{ text: 'stale', createdAt: STARTED_AT + 20_001 }]),
    ).rejects.toThrow('StreamFenceLost:reused-stream')
    await expect(
      execute({
        kind: 'stream.finish-cleanup',
        chatId: stale.chatId,
        streamId: stale.streamId,
        fence: leaseFence(stale),
      }),
    ).rejects.toThrow('StreamFenceLost:reused-stream')

    expect(await streamLeases(seeded.chatId)).toEqual([replacement])
    expect(await streamFrames(stale.streamId, -1)).toEqual([])
  })

  it('hands writer custody to recovery immediately and permanently invalidates the writer fence', async () => {
    const seeded = await seedTargets(1)
    const active = await activeContinuation(
      'handoff-stream',
      seeded.chatId,
      requiredTarget(seeded, 0),
    )
    const writer = active.lease
    const handedOffAt = STARTED_AT + 1
    const handedOff = await execute({
      kind: 'stream.handoff-recovery',
      input: {
        streamId: writer.streamId,
        fence: leaseFence(writer),
        handedOffAt,
        reason: 'finalize-failed',
      },
    })

    expect(handedOff).toMatchObject({
      streamId: writer.streamId,
      phase: 'active',
      custody: 'recovery-pending',
      handedOffAt,
      handoffReason: 'finalize-failed',
      admissionSequence: writer.admissionSequence,
      revision: writer.revision + 1,
    })
    expect(streamLeaseHasWriteFence(handedOff)).toBe(false)
    await expect(
      execute({
        kind: 'stream.renew',
        heartbeat: {
          streamId: writer.streamId,
          fence: leaseFence(writer),
          heartbeatAt: handedOffAt + 1,
        },
      }),
    ).rejects.toThrow(`StreamFenceLost:${writer.streamId}`)
    await expect(
      appendStreamText(writer, [{ text: 'stale writer', createdAt: handedOffAt + 1 }]),
    ).rejects.toThrow(`StreamFenceLost:${writer.streamId}`)

    const explicitClaim = await execute({
      kind: 'stream.claim-recovery',
      expected: handedOff,
      now: handedOffAt,
    })
    const claimed = required(
      explicitClaim ?? (await streamLease(writer.streamId)),
      'single-flight recovery claim',
    )
    expect(claimed).toMatchObject({
      streamId: writer.streamId,
      custody: 'recovery',
      admissionSequence: writer.admissionSequence,
    })
    expect(claimed.heartbeatAt).toBeGreaterThanOrEqual(handedOffAt)
    expect(claimed.revision).toBeGreaterThan(handedOff.revision)
    expect(streamLeaseHasWriteFence(claimed)).toBe(true)
    await expect(
      execute({ kind: 'stream.claim-recovery', expected: handedOff, now: handedOffAt }),
    ).resolves.toBeUndefined()
  })

  it('admits distinct same-chat targets and keeps each active target exclusive', async () => {
    const seeded = await seedTargets(2)
    const firstTarget = requiredTarget(seeded, 0)
    const secondTarget = requiredTarget(seeded, 1)
    const first = await prepareContinuation({
      streamId: 'stream-a',
      chatId: seeded.chatId,
      targetAssistantId: firstTarget.id,
      ownerClientId: 'tab-a',
    })
    const second = await prepareContinuation({
      streamId: 'stream-b',
      chatId: seeded.chatId,
      targetAssistantId: secondTarget.id,
      ownerClientId: 'tab-b',
    })

    await expect(
      prepareContinuation({
        streamId: 'duplicate-target',
        chatId: seeded.chatId,
        targetAssistantId: firstTarget.id,
        ownerClientId: 'tab-c',
      }),
    ).rejects.toMatchObject({ name: 'StreamTargetBusyError', messageId: firstTarget.id })
    expect(await streamLeases(seeded.chatId)).toEqual([first.lease, second.lease])
  })

  it('allows exactly one of two concurrent admissions for the same target', async () => {
    const seeded = await seedTargets(1)
    const target = requiredTarget(seeded, 0)
    const settled = await Promise.allSettled([
      prepareContinuation({
        streamId: 'target-race-a',
        chatId: seeded.chatId,
        targetAssistantId: target.id,
        ownerClientId: 'tab-a',
      }),
      prepareContinuation({
        streamId: 'target-race-b',
        chatId: seeded.chatId,
        targetAssistantId: target.id,
        ownerClientId: 'tab-b',
      }),
    ])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({
      name: 'StreamTargetBusyError',
      messageId: target.id,
    })
    expect(await streamLeases(seeded.chatId)).toHaveLength(1)
  })

  it('retries one attempt identity without allocating another lease or admission sequence', async () => {
    const seeded = await seedTargets(1)
    const target = requiredTarget(seeded, 0)
    const input = await continuationPrepareInput({
      streamId: 'retried-attempt',
      chatId: seeded.chatId,
      targetAssistantId: target.id,
      ownerClientId: 'tab-a',
      startedAt: STARTED_AT + 10,
    })

    const first = await execute({ kind: 'attempt.prepare', input })
    const second = await execute({ kind: 'attempt.prepare', input })

    expect(second.lease.admissionSequence).toBe(first.lease.admissionSequence)
    expect(second.lease.revision).toBe(first.lease.revision + 1)
    expect(await streamLeases(seeded.chatId)).toEqual([second.lease])
    expect(await getDb().streamLeases.count()).toBe(1)
  })

  it('prepares a 4,096-header path in one transaction with deterministic linear page work', async () => {
    const seeded = await seedTargets(2_048)
    const target = requiredTarget(seeded, 2_047)
    const input = await continuationPrepareInput({
      streamId: 'deep-linear-prepare',
      chatId: seeded.chatId,
      targetAssistantId: target.id,
    })
    const claimedIds = new Set(input.promptPath.claim.headers.map((header) => header.messageId))
    expect(claimedIds.size).toBe(4_096)

    const db = getDb()
    const messageTablePrototype = Object.getPrototypeOf(db.messages) as typeof db.messages
    const bulkGet = vi.spyOn(messageTablePrototype, 'bulkGet')
    const readTransactions = new Set<Transaction>()
    const claimedHeaderReads: MessageId[] = []
    const reading = (header: MessageHeaderRow | undefined): MessageHeaderRow | undefined => {
      if (!header || !claimedIds.has(header.id)) return header
      const transaction = Dexie.currentTransaction
      readTransactions.add(transaction)
      claimedHeaderReads.push(header.id)
      return header
    }
    db.messages.hook('reading', reading)
    let prepared: AttemptPrepareResult
    try {
      prepared = await execute({ kind: 'attempt.prepare', input })
    } finally {
      db.messages.hook('reading').unsubscribe(reading)
    }

    const claimPages = bulkGet.mock.calls
      .map(([ids]) => [...ids])
      .filter((ids) => ids.length > 0 && ids.every((id) => claimedIds.has(id)))
    const pagedIds = claimPages.flat()
    expect(HEADER_READ_PAGE_SIZE).toBe(256)
    expect(claimPages).toHaveLength(4_096 / HEADER_READ_PAGE_SIZE)
    expect(claimPages.every((page) => page.length <= HEADER_READ_PAGE_SIZE)).toBe(true)
    expect(pagedIds).toHaveLength(4_096)
    expect(new Set(pagedIds)).toEqual(claimedIds)
    expect(readTransactions.size).toBe(1)
    expect(claimedHeaderReads.length).toBeGreaterThanOrEqual(4_096)
    expect(claimedHeaderReads.length).toBeLessThanOrEqual(4_098)
    expect(new Set(claimedHeaderReads)).toEqual(claimedIds)
    const readCounts = new Map<MessageId, number>()
    for (const messageId of claimedHeaderReads) {
      readCounts.set(messageId, (readCounts.get(messageId) ?? 0) + 1)
    }
    expect(
      [...readCounts]
        .filter(([, count]) => count > 1)
        .every(([id, count]) => {
          return id === target.id && count <= 3
        }),
    ).toBe(true)
    expect(prepared.prompt.headers).toHaveLength(4_096)
    expect(new Set(prepared.prompt.headers.map((header) => header.id))).toEqual(claimedIds)
  }, 30_000)

  it('rejects a cyclic prompt claim through persisted parent validation', async () => {
    const seeded = await seedTargets(1)
    const target = requiredTarget(seeded, 0)
    const input = await continuationPrepareInput({
      streamId: 'cyclic-prompt-claim',
      chatId: seeded.chatId,
      targetAssistantId: target.id,
    })
    const [root, leaf] = input.promptPath.claim.headers
    if (!root || !leaf) throw new Error('CyclicPromptClaimFixtureMissing')
    const claim = {
      ...input.promptPath.claim,
      headers: [
        root,
        leaf,
        { ...root, parentId: leaf.messageId },
        { ...leaf, parentId: root.messageId },
      ],
    }

    await expect(
      execute({
        kind: 'attempt.prepare',
        input: {
          ...input,
          promptPath: { ...input.promptPath, claim },
        },
      }),
    ).rejects.toThrow(`GenerationPlanningSeedChanged:${seeded.chatId}`)
  })

  it('seals one exact settled journal boundary and rejects every later contradiction', async () => {
    const seeded = await seedTargets(1)
    const active = await activeContinuation(
      'sealed-terminal-boundary',
      seeded.chatId,
      requiredTarget(seeded, 0),
    )
    await appendStreamText(active.lease, [
      { text: 'a', createdAt: STARTED_AT + 2 },
      { text: 'b', createdAt: STARTED_AT + 3 },
    ])
    const current = required(await streamLease(active.lease.streamId), 'current lease')
    const input = terminalSealInput(current, STARTED_AT + 4)
    const first = await execute({ kind: 'attempt.seal-terminal', input })
    const second = await execute({ kind: 'attempt.seal-terminal', input })

    expect(first).toEqual(second)
    expect(first.revision).toBe(current.revision + 1)
    expect(first.terminal).toEqual({
      version: 1,
      finishedAt: STARTED_AT + 4,
      journalMaxSeq: 1,
      journalCompleteness: 'settled',
      decision: { outcome: 'done' },
    })
    await expect(
      execute({
        kind: 'attempt.seal-terminal',
        input: { ...input, decision: { outcome: 'abort', abortReason: 'user' } },
      }),
    ).rejects.toThrow(`AttemptTerminalDecisionConflict:${first.streamId}`)
    await expect(
      appendStreamText(first, [{ text: 'late', createdAt: STARTED_AT + 5 }], 2),
    ).rejects.toThrow(`StreamFenceLost:${first.streamId}`)
  })

  it('owns Stop as one exact idempotent lease command and makes it terminal-authoritative', async () => {
    const seeded = await seedTargets(2)
    const prepared = await prepareContinuation({
      streamId: 'durable-stop',
      chatId: seeded.chatId,
      targetAssistantId: requiredTarget(seeded, 0).id,
    })
    const input = stopRequestInput(prepared.lease, { requestedAt: STARTED_AT + 4 })
    const accepted = await executeCommit({ kind: 'attempt.request-stop', input })

    expect(accepted.value).toMatchObject({
      outcome: 'accepted',
      lease: {
        streamId: prepared.lease.streamId,
        revision: prepared.lease.revision + 1,
        controlRevision: 1,
        stopControl: {
          requestId: input.requestId,
          requestedBy: input.requestedBy,
          requestedAt: input.requestedAt,
          reason: 'user',
        },
      },
    })
    expect(accepted.delta.facts).toEqual([
      {
        kind: 'attempt-stop-requested',
        streamId: prepared.lease.streamId,
        chatId: prepared.lease.chatId,
        messageId: prepared.lease.messageId,
        attemptKind: prepared.lease.attemptKind,
        admissionSequence: prepared.lease.admissionSequence,
        controlRevision: 1,
        requestId: input.requestId,
        requestedBy: input.requestedBy,
        requestedAt: input.requestedAt,
        reason: 'user',
      },
    ])

    const repeated = await executeCommit({ kind: 'attempt.request-stop', input })
    expect(repeated.value).toMatchObject({ outcome: 'already-requested' })
    expect(repeated.delta.facts).toEqual([])

    const stale = await execute({
      kind: 'attempt.request-stop',
      input: { ...input, admissionSequence: input.admissionSequence + 1 },
    })
    expect(stale).toMatchObject({ outcome: 'stale', lease: { streamId: 'durable-stop' } })
    await expect(
      execute({
        kind: 'attempt.request-stop',
        input: { ...input, streamId: 'missing-stop' },
      }),
    ).resolves.toEqual({ outcome: 'missing' })
    await expect(dispatchContinuation(prepared, prepared.lease.startedAt + 1)).rejects.toThrow(
      `AttemptDispatchStopped:${prepared.lease.streamId}`,
    )

    if (accepted.value.outcome !== 'accepted') throw new Error('StopAcceptanceFixtureInvalid')
    const stoppedLease = accepted.value.lease
    const decided = await execute({
      kind: 'attempt.seal-terminal',
      input: terminalSealInput(stoppedLease, STARTED_AT + 2),
    })
    expect(decided.terminal).toMatchObject({
      finishedAt: input.requestedAt,
      decision: { outcome: 'abort', abortReason: 'user' },
    })
    await expect(execute({ kind: 'attempt.request-stop', input })).resolves.toMatchObject({
      outcome: 'already-requested',
    })

    const terminalOnly = await prepareContinuation({
      streamId: 'durable-stop-after-terminal-decision',
      chatId: seeded.chatId,
      targetAssistantId: requiredTarget(seeded, 1).id,
    })
    const terminalOnlyDecided = await execute({
      kind: 'attempt.seal-terminal',
      input: terminalSealInput(terminalOnly.lease, STARTED_AT + 5),
    })
    const terminalStopInput = stopRequestInput(terminalOnlyDecided, {
      requestedAt: STARTED_AT + 6,
    })
    await expect(
      executeCommit({ kind: 'attempt.request-stop', input: terminalStopInput }),
    ).resolves.toMatchObject({
      value: {
        outcome: 'accepted',
        lease: {
          phase: 'terminal-decided',
          terminal: terminalOnlyDecided.terminal,
          stopControl: {
            requestId: terminalStopInput.requestId,
            reason: 'user',
          },
        },
      },
    })
  })

  it('requires the sealed receipt before canonicalization and rejects a mismatched receipt', async () => {
    const seeded = await seedTargets(1)
    const prepared = await prepareContinuation({
      streamId: 'terminal-before-canonical',
      chatId: seeded.chatId,
      targetAssistantId: requiredTarget(seeded, 0).id,
    })
    const current = (await dispatchContinuation(prepared, prepared.lease.startedAt + 1)).lease
    const finishedAt = current.startedAt + 2
    const unsealedReceipt = terminalReceipt(current, finishedAt)
    await expect(
      execute({
        kind: 'attempt.finalize',
        input: continuationTerminal(current, unsealedReceipt),
      }),
    ).rejects.toThrow(`AttemptFinalizeBeforeTerminalDecision:${current.streamId}`)

    const decided = await execute({
      kind: 'attempt.seal-terminal',
      input: terminalSealInput(current, finishedAt),
    })
    await expect(
      execute({
        kind: 'attempt.finalize',
        input: continuationTerminal(decided, {
          ...decided.terminal,
          finishedAt: decided.terminal.finishedAt + 1,
        }),
      }),
    ).rejects.toThrow(`AttemptTerminalDecisionConflict:${current.streamId}`)
    expect(await message(current.messageId)).toEqual(prepared.assistant)
    expect(await streamLease(current.streamId)).toEqual(decided)
  })

  it('releases target occupancy before explicitly retiring the metadata cleanup anchor', async () => {
    const seeded = await seedTargets(1)
    const target = requiredTarget(seeded, 0)
    const first = await activeContinuation('finalized-predecessor', seeded.chatId, target)
    await appendStreamText(first.lease, [{ text: 'already committed', createdAt: STARTED_AT + 2 }])
    const canonical = await canonicalizeContinuation(first.prepared, STARTED_AT + 3)
    await execute({
      kind: 'generation.post-commit-metadata',
      input: { streamId: canonical.streamId, fence: leaseFence(canonical) },
    })

    const second = await prepareContinuation({
      streamId: 'replacement-after-final',
      chatId: seeded.chatId,
      targetAssistantId: target.id,
      ownerClientId: 'tab-b',
      startedAt: STARTED_AT + 4,
    })

    expect(second.lease.admissionSequence).toBe(first.lease.admissionSequence + 1)
    const cleanupAnchor = required(
      await streamLease(first.lease.streamId),
      'metadata cleanup anchor',
    )
    expect(cleanupAnchor).toMatchObject({ phase: 'metadata-committed' })
    expect(await streamEvents(first.lease.streamId, 0)).toEqual([
      { lane: 'text', text: 'already committed' },
    ])
    expect(await streamLease(second.lease.streamId)).toEqual(second.lease)
    await finishStream(cleanupAnchor)
    expect(await streamLease(first.lease.streamId)).toBeUndefined()
    expect(await streamFrames(first.lease.streamId, 0)).toEqual([])
  })

  it('keeps one target lease across one hundred canonical continuation admissions', async () => {
    const seeded = await seedTargets(1)
    const target = requiredTarget(seeded, 0)
    let previousSequence = 0
    for (let index = 0; index < 100; index += 1) {
      const prepared = await prepareContinuation({
        streamId: `bounded-final-stream-${index}`,
        chatId: seeded.chatId,
        targetAssistantId: target.id,
        ownerClientId: `tab-${index}`,
        startedAt: STARTED_AT + 100 + index * 2,
      })
      expect(prepared.lease.admissionSequence).toBeGreaterThan(previousSequence)
      previousSequence = prepared.lease.admissionSequence
      if (index < 99) {
        const canonical = await canonicalizeContinuation(prepared, STARTED_AT + 101 + index * 2)
        await execute({
          kind: 'generation.post-commit-metadata',
          input: { streamId: canonical.streamId, fence: leaseFence(canonical) },
        })
        const cleanupAnchor = required(
          await streamLease(canonical.streamId),
          'metadata cleanup anchor',
        )
        await finishStream(cleanupAnchor)
      }
    }

    expect(await getDb().streamLeases.count()).toBe(1)
    expect((await streamLeases(seeded.chatId))[0]?.streamId).toBe('bounded-final-stream-99')
    expect(await getDb().streamChunks.count()).toBe(0)
  }, 15_000)

  it('releases a canonical target while retaining its metadata-pending lease', async () => {
    const seeded = await seedTargets(1)
    const target = requiredTarget(seeded, 0)
    const first = await prepareContinuation({
      streamId: 'metadata-pending-predecessor',
      chatId: seeded.chatId,
      targetAssistantId: target.id,
    })
    const canonical = await canonicalizeContinuation(first, first.lease.startedAt + 1)

    const next = await prepareContinuation({
      streamId: 'admitted-before-metadata',
      chatId: seeded.chatId,
      targetAssistantId: target.id,
      startedAt: canonical.startedAt + 2,
    })
    expect(next.lease).toMatchObject({
      streamId: 'admitted-before-metadata',
      messageId: target.id,
      phase: 'reserved',
      targetOwnerKey: target.id,
    })
    const retained = required(await streamLease(canonical.streamId), 'canonical metadata anchor')
    expect(retained).toMatchObject({
      streamId: canonical.streamId,
      chatId: canonical.chatId,
      messageId: canonical.messageId,
      replacementEpoch: canonical.replacementEpoch,
      startedAt: canonical.startedAt,
      admissionSequence: canonical.admissionSequence,
      attemptKind: canonical.attemptKind,
      phase: 'canonical',
      dispatch: canonical.dispatch,
      canonicalAt: canonical.canonicalAt,
      postCommit: canonical.postCommit,
    })
    expect(retained).not.toHaveProperty('targetOwnerKey')
  })

  it('rejects journal appends after canonicalization without mutating the retained journal', async () => {
    const seeded = await seedTargets(1)
    const active = await activeContinuation(
      'canonical-append-stream',
      seeded.chatId,
      requiredTarget(seeded, 0),
    )
    await appendStreamText(active.lease, [{ text: 'committed prefix', createdAt: STARTED_AT + 1 }])
    const canonical = await canonicalizeContinuation(active.prepared, STARTED_AT + 2)

    await expect(
      appendStreamText(canonical, [{ text: 'late suffix', createdAt: STARTED_AT + 3 }], 1),
    ).rejects.toThrow(`StreamFenceLost:${canonical.streamId}`)
    expect((await streamFrames(canonical.streamId, 0)).map((row) => row.seq)).toEqual([0])
    expect(await streamLease(canonical.streamId)).toEqual(canonical)
  })

  it('checks the stream fence inside the authoritative finalization transaction', async () => {
    const seeded = await seedTargets(1)
    const target = requiredTarget(seeded, 0)
    const prepared = await prepareContinuation({
      streamId: 'finalize-race',
      chatId: seeded.chatId,
      targetAssistantId: target.id,
    })
    const before = await message(target.id)
    const claimAt = prepared.lease.heartbeatAt + STREAM_LEASE_TTL_MS + 1
    const replacement = required(
      await execute({
        kind: 'stream.claim-recovery',
        expected: prepared.lease,
        now: claimAt,
      }),
      'recovery replacement',
    )
    expect(replacement).toMatchObject({
      streamId: prepared.lease.streamId,
      messageId: prepared.lease.messageId,
      custody: 'recovery',
      admissionSequence: prepared.lease.admissionSequence,
      revision: prepared.lease.revision + 1,
    })
    expect(leaseFence(replacement)).not.toEqual(leaseFence(prepared.lease))

    await expect(
      execute({
        kind: 'attempt.seal-terminal',
        input: terminalSealInput(prepared.lease, claimAt + 1),
      }),
    ).rejects.toThrow('StreamFenceLost:finalize-race')
    expect(await message(target.id)).toEqual(before)
  })

  it('keeps lease and journal maintenance outside workspace replacement accounting', async () => {
    const seeded = await seedTargets(1)
    const active = await activeContinuation(
      'maintenance-stream',
      seeded.chatId,
      requiredTarget(seeded, 0),
    )
    const beforeJournal = await workspaceMeta()
    const renewCommit = await executeCommit({
      kind: 'stream.renew',
      heartbeat: {
        streamId: active.lease.streamId,
        fence: leaseFence(active.lease),
        heartbeatAt: active.lease.heartbeatAt + 20_000,
      },
    })
    const currentLease = renewCommit.value
    const appendCommit = await appendStreamTextCommit(currentLease, [
      { text: 'kept', createdAt: STARTED_AT + 30_000 },
    ])
    expect(await workspaceMeta()).toEqual(beforeJournal)
    expect(renewCommit.receipt.chats).toEqual([])
    expect(renewCommit.receipt.messageRevisions).toEqual([])
    expect(renewCommit.receipt.childSlots).toEqual([])
    expect(appendCommit.receipt.chats).toEqual([])
    expect(appendCommit.receipt.messageRevisions).toEqual([])
    expect(appendCommit.receipt.childSlots).toEqual([])

    const canonical = await canonicalizeContinuation(active.prepared, STARTED_AT + 40_000)
    const metadata = await execute({
      kind: 'generation.post-commit-metadata',
      input: { streamId: canonical.streamId, fence: leaseFence(canonical) },
    })
    expect(metadata.outcome).toBe('applied')
    const cleanupLease = required(await streamLease(canonical.streamId), 'cleanup lease')
    const beforeCleanup = await workspaceMeta()
    const finishCommit = await executeCommit({
      kind: 'stream.finish-cleanup',
      chatId: cleanupLease.chatId,
      streamId: cleanupLease.streamId,
      fence: leaseFence(cleanupLease),
    })

    expect(finishCommit.value).toEqual({ deletedLease: true, deletedFrames: 1, done: true })
    expect(await workspaceMeta()).toEqual(beforeCleanup)
    expect(finishCommit.receipt.chats).toEqual([])
  })

  it('accepts an owned heartbeat after wall-clock rollback and advances its revision', async () => {
    const seeded = await seedTargets(1)
    const active = await activeContinuation(
      'rollback-renewal-stream',
      seeded.chatId,
      requiredTarget(seeded, 0),
    )
    const before = required(await streamLease(active.lease.streamId), 'lease before rollback')
    if (!streamLeaseHasWriteFence(before)) throw new Error('ExpectedFencedTestLease')
    const heartbeatAt = before.heartbeatAt - 10_000

    const renewed = await execute({
      kind: 'stream.renew',
      heartbeat: {
        streamId: before.streamId,
        fence: leaseFence(before),
        heartbeatAt,
      },
    })

    expect(renewed.heartbeatAt).toBe(heartbeatAt)
    expect(renewed.revision).toBe(before.revision + 1)
  })

  it('piggybacks lease freshness on chunk persistence and invalidates a stale recovery snapshot', async () => {
    const seeded = await seedTargets(1)
    const active = await activeContinuation(
      'chunk-freshness-stream',
      seeded.chatId,
      requiredTarget(seeded, 0),
    )
    const beforeAppend = required(await streamLease(active.lease.streamId), 'pre-append lease')
    vi.spyOn(Date, 'now').mockReturnValue(STARTED_AT + 50_000)

    await appendStreamText(beforeAppend, [
      { text: 'still active', createdAt: STARTED_AT + 60_000 },
      { text: 'sequence owns ordering', createdAt: STARTED_AT + 40_000 },
    ])

    const refreshed = required(await streamLease(active.lease.streamId), 'refreshed lease')
    expect(refreshed.heartbeatAt).toBe(STARTED_AT + 50_000)
    expect(refreshed.revision).toBe(beforeAppend.revision + 1)
    await expect(
      execute({
        kind: 'stream.claim-recovery',
        expected: beforeAppend,
        now: STARTED_AT + 70_000,
      }),
    ).resolves.toBeUndefined()
    expect((await streamFrames(active.lease.streamId, 1)).map((row) => row.seq)).toEqual([0, 1])
  })

  it('cannot use a completed cleanup fence to delete a newly admitted reuse of the stream id', async () => {
    const seeded = await seedTargets(1)
    const target = requiredTarget(seeded, 0)
    const first = await prepareContinuation({
      streamId: 'reused-cleanup-stream',
      chatId: seeded.chatId,
      targetAssistantId: target.id,
      ownerClientId: 'old-owner',
      startedAt: STARTED_AT + 1,
    })
    const canonical = await canonicalizeContinuation(first, STARTED_AT + 2)
    await execute({
      kind: 'generation.post-commit-metadata',
      input: { streamId: canonical.streamId, fence: leaseFence(canonical) },
    })
    const cleanupLease = required(await streamLease(canonical.streamId), 'first cleanup lease')
    const oldFence = leaseFence(cleanupLease)
    await execute({
      kind: 'stream.finish-cleanup',
      chatId: cleanupLease.chatId,
      streamId: cleanupLease.streamId,
      fence: oldFence,
    })

    const replacement = await prepareContinuation({
      streamId: first.lease.streamId,
      chatId: seeded.chatId,
      targetAssistantId: target.id,
      ownerClientId: 'new-owner',
      fenceToken: 'new-fence',
      startedAt: STARTED_AT + 3,
    })
    await expect(
      execute({
        kind: 'stream.finish-cleanup',
        chatId: replacement.lease.chatId,
        streamId: replacement.lease.streamId,
        fence: oldFence,
      }),
    ).rejects.toThrow(`StreamFenceLost:${replacement.lease.streamId}`)
    expect(await streamLease(replacement.lease.streamId)).toEqual(replacement.lease)
  })
})

async function seedTargets(count: number): Promise<{ chatId: string; targets: Message[] }> {
  const chat = await createChat({ settings: settings() })
  const messages = Array.from({ length: count }, (_, index) => [
    { role: 'user' as const, content: [{ type: 'text' as const, text: `question-${index}` }] },
    {
      role: 'assistant' as const,
      content: [{ type: 'output_text' as const, text: `answer-${index}` }],
    },
  ]).flat()
  const imported = await importMessagesOp({
    chatId: chat.id,
    slot: { kind: 'at-end' },
    activeLeafId: null,
    messages,
    now: 1,
  })
  return {
    chatId: chat.id,
    targets: imported.presentations
      .map((presentation) => presentation.message)
      .filter((message) => message.role === 'assistant'),
  }
}

function requiredTarget(seeded: { targets: Message[] }, index: number): Message {
  return required(seeded.targets[index], `target ${index}`)
}

async function continuationPrepareInput(input: {
  streamId: string
  chatId: string
  targetAssistantId: MessageId
  ownerClientId?: string
  fenceToken?: string
  startedAt?: number
}): Promise<Extract<WorkspaceCommand, { kind: 'attempt.prepare' }>['input']> {
  const startedAt = input.startedAt ?? STARTED_AT
  const workspace = await workspaceMeta()
  const lease: StreamLeaseAdmission = testStreamLeaseAdmission({
    streamId: input.streamId,
    chatId: input.chatId,
    messageId: input.targetAssistantId,
    ownerClientId: input.ownerClientId ?? getStreamClientId(),
    fenceToken: input.fenceToken ?? `fence:${input.streamId}`,
    replacementEpoch: workspace.replacementEpoch,
    startedAt,
    heartbeatAt: startedAt,
    attemptKind: 'continuation',
  })
  const chat = await getDb().chats.get(input.chatId)
  const promptHeaders = await promptPathHeaderClaims(input.targetAssistantId)
  const selectedProfile = profile()
  return {
    strategy: 'continue',
    lease,
    promptPath: {
      requirement: {
        kind: 'continue',
        surface: 'chat',
        chatId: input.chatId,
        target: {
          kind: 'include',
          messageId: input.targetAssistantId,
          role: 'assistant',
        },
        childSlot: 'none',
      },
      claim: {
        chatId: input.chatId,
        leafId: input.targetAssistantId,
        headers: promptHeaders,
      },
    },
    configurationClaim: {
      configurationVersion: chat?.configurationVersion ?? 0,
      settings: chat?.settings ?? settings(),
      presetId: chat?.presetId ?? null,
      profile: connectionDispatchProfileProof(selectedProfile, MODEL),
      requestRevision: {
        profileId: selectedProfile.id,
        requestRevision: selectedProfile.requestRevision ?? 0,
        key: { kind: 'missing' },
      },
      dispatchKeyRevisions: [],
      preferredDispatchKeyId: null,
      workspaceSettingOverrides: [],
    },
  }
}

async function promptPathHeaderClaims(messageId: MessageId) {
  const reversed: Array<{
    messageId: MessageId
    parentId: MessageId | null
    requestContextVersion: number
  }> = []
  const seen = new Set<MessageId>()
  let cursor: MessageId | null = messageId
  while (cursor !== null) {
    if (seen.has(cursor)) throw new Error(`TestPromptPathCycle:${cursor}`)
    seen.add(cursor)
    const row: MessageHeaderRow | undefined = await getDb().messages.get(cursor)
    if (!row) {
      return [{ messageId, parentId: null, requestContextVersion: 0 }]
    }
    reversed.push({
      messageId: row.id,
      parentId: row.parentId,
      requestContextVersion: row.requestContextVersion,
    })
    cursor = row.parentId
  }
  return reversed.reverse()
}

async function prepareContinuation(input: {
  streamId: string
  chatId: string
  targetAssistantId: MessageId
  ownerClientId?: string
  fenceToken?: string
  startedAt?: number
}): Promise<AttemptPrepareResult> {
  return execute({ kind: 'attempt.prepare', input: await continuationPrepareInput(input) })
}

async function activeContinuation(
  streamId: string,
  chatId: string,
  target: Message,
): Promise<{ prepared: AttemptPrepareResult; lease: AttemptDispatchResult['lease'] }> {
  const prepared = await prepareContinuation({ streamId, chatId, targetAssistantId: target.id })
  const dispatched = await dispatchContinuation(prepared, prepared.lease.startedAt + 1)
  return { prepared, lease: dispatched.lease }
}

async function dispatchContinuation(
  prepared: AttemptPrepareResult,
  dispatchedAt: number,
): Promise<AttemptDispatchResult> {
  if (prepared.strategy !== 'continue') throw new Error('expected continuation preparation')
  const generation: DispatchedGenerationMeta = {
    model: MODEL,
    requestedModel: MODEL,
    apiUsed: 'chat',
    delivery: 'streaming',
    status: 'streaming',
    integrity: 'clean',
    costSource: 'stream',
    startedAt: prepared.lease.startedAt,
    reasoningCarryForward: 'none',
    reasoningVisibility: {
      disclosure: 'absent',
      unexpectedVisibleKind: 'text',
      reason: 'disabled',
    },
  }
  const command: Extract<WorkspaceCommand, { kind: 'attempt.dispatch' }> = {
    kind: 'attempt.dispatch',
    input: {
      streamId: prepared.lease.streamId,
      fence: leaseFence(prepared.lease),
      readSet: {
        chatId: prepared.lease.chatId,
        messages: prepared.prompt.messageProofs,
        attachments: [],
      },
      generation,
      dispatchedAt,
      continuation: {
        strategy: 'prompt',
        prepareProof: prepared.continuationBase,
      },
    },
  }
  return execute(command)
}

async function canonicalizeContinuation(
  prepared: AttemptPrepareResult,
  finishedAt: number,
): Promise<StreamLeaseRow> {
  if (prepared.strategy !== 'continue') throw new Error('expected continuation preparation')
  const retained = required(await streamLease(prepared.lease.streamId), 'current lease')
  const current =
    retained.phase === 'reserved'
      ? (await dispatchContinuation(prepared, retained.startedAt + 1)).lease
      : retained
  const decided = await execute({
    kind: 'attempt.seal-terminal',
    input: terminalSealInput(current, finishedAt),
  })
  const result = await execute({
    kind: 'attempt.finalize',
    input: continuationTerminal(decided, decided.terminal),
  })
  return result.lease
}

function continuationTerminal(
  lease: StreamLeaseRow,
  terminal: AttemptTerminalReceipt,
): Extract<WorkspaceCommand, { kind: 'attempt.finalize' }>['input'] {
  const finishedAt = terminal.finishedAt
  const dispatch = continuationDispatch(lease)
  const attempt: ContinuationAttemptDraft = {
    streamId: lease.streamId,
    strategy: dispatch.continuationStrategy,
    status: 'done',
    integrity: 'clean',
    requestedModel: MODEL,
    model: MODEL,
    apiUsed: 'chat',
    startedAt: lease.startedAt,
    finishedAt,
    costSource: 'stream',
    reasoningCarryForward: dispatch.reasoningCarryForward,
    reasoningVisibility: dispatch.reasoningVisibility,
  }
  return {
    kind: 'continuation',
    streamId: lease.streamId,
    fence: leaseFence(lease),
    messageId: lease.messageId,
    terminal,
    continuationText: '',
    continuationAnnotations: [],
    attempt,
    postCommit: { completionAllowed: false },
  }
}

function terminalSealInput(
  lease: StreamLeaseRow,
  finishedAt: number,
): Extract<WorkspaceCommand, { kind: 'attempt.seal-terminal' }>['input'] {
  return {
    streamId: lease.streamId,
    fence: leaseFence(lease),
    finishedAt,
    journalCompleteness: 'settled',
    decision: { outcome: 'done' },
  }
}

function stopRequestInput(
  lease: StreamLeaseRow,
  overrides: { requestedAt?: number } = {},
): Extract<WorkspaceCommand, { kind: 'attempt.request-stop' }>['input'] {
  return {
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    attemptKind: lease.attemptKind,
    replacementEpoch: lease.replacementEpoch,
    admissionSequence: lease.admissionSequence,
    requestId: `request:${lease.streamId}`,
    requestedBy: 'tab-b',
    requestedAt: overrides.requestedAt ?? lease.startedAt + 1,
    reason: 'user',
  }
}

function terminalReceipt(lease: StreamLeaseRow, finishedAt: number): AttemptTerminalReceipt {
  return {
    version: 1,
    finishedAt,
    journalMaxSeq: lease.journalMaxSeq ?? -1,
    journalCompleteness: 'settled',
    decision: { outcome: 'done' },
  }
}

interface StreamTextInput {
  readonly text: string
  readonly createdAt: number
}

async function appendStreamText(
  lease: StreamLeaseRow,
  entries: readonly StreamTextInput[],
  startSeq = 0,
): Promise<void> {
  await appendStreamTextCommit(lease, entries, startSeq)
}

async function appendStreamTextCommit(
  lease: StreamLeaseRow,
  entries: readonly StreamTextInput[],
  startSeq = 0,
): Promise<CommitEnvelope<undefined>> {
  const frames = await encodeTestStreamJournalEntries({
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    fence: leaseFence(lease),
    entries: entries.map((entry) => ({
      createdAt: entry.createdAt,
      event: { lane: 'text', text: entry.text },
    })),
    startPhysicalSeq: startSeq,
    startLogicalSeq: startSeq,
  })
  return executeCommit({ kind: 'stream.append-journal-frames', frames })
}

async function finishStream(lease: StreamLeaseRow): Promise<void> {
  for (;;) {
    const result = await execute({
      kind: 'stream.finish-cleanup',
      chatId: lease.chatId,
      streamId: lease.streamId,
      fence: leaseFence(lease),
    })
    if (result.done) return
    if (result.deletedFrames === 0) {
      throw new Error(`StreamCleanupMadeNoProgress:${lease.streamId}`)
    }
  }
}

function leaseFence(lease: StreamLeaseRow): StreamWriteFence {
  if (!streamLeaseHasWriteFence(lease)) throw new Error('ExpectedFencedTestLease')
  return {
    ownerClientId: lease.ownerClientId,
    fenceToken: lease.fenceToken,
    replacementEpoch: lease.replacementEpoch,
    admissionSequence: lease.admissionSequence,
  }
}

function continuationDispatch(lease: StreamLeaseRow) {
  const dispatch = streamLeaseDispatchEvidence(lease)
  if (lease.attemptKind !== 'continuation') throw new Error('ExpectedContinuationLease')
  if (!dispatch || !('continuationStrategy' in dispatch)) {
    throw new Error('ExpectedContinuationDispatchEvidence')
  }
  return dispatch
}

async function executeCommit<C extends WorkspaceCommand>(
  command: C,
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
  return runWorkspaceAction('conversation-generation', (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
}

async function execute<C extends WorkspaceCommand>(command: C): Promise<WorkspaceCommandResult<C>> {
  return (await executeCommit(command)).value
}

async function workspaceMeta(): Promise<WorkspaceMeta> {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'workspace.meta' },
        { signal: permit.signal },
      )
    ).value
  })
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

async function streamLeases(chatId: string): Promise<StreamLeaseRow[]> {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'stream.leases', chatId },
        { signal: permit.signal },
      )
    ).value
  })
}

async function streamFrames(
  streamId: string,
  throughSeq: number,
): Promise<CanonicalStreamJournalFrameRow[]> {
  return runWorkspaceRead('repository-query', async (permit) => {
    const frames: CanonicalStreamJournalFrameRow[] = []
    let afterSeq = -1
    for (;;) {
      const page = (
        await getWorkspaceRepository().query(
          permit,
          { kind: 'stream.journal-frame-page', streamId, afterSeq, throughSeq },
          { signal: permit.signal },
        )
      ).value
      frames.push(...page.frames)
      if (page.done) return frames
      if (page.nextAfterSeq <= afterSeq)
        throw new Error(`StreamJournalPageMadeNoProgress:${streamId}`)
      afterSeq = page.nextAfterSeq
    }
  })
}

async function streamEvents(streamId: string, throughSeq: number): Promise<unknown[]> {
  const entries = await decodeTestStreamJournalFrames(await streamFrames(streamId, throughSeq))
  return entries.map((entry) => entry.event)
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { ApiError } from '../../src/api/errors'
import { layoutBranchTree } from '../../src/core/branch-tree-layout'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { createMessageTopologyIndex } from '../../src/core/message-topology'
import type {
  ChatSettings,
  ConnectionProfile,
  ContentItem,
  Message,
  MessageId,
} from '../../src/core/types'
import {
  addExistingAttachmentRef,
  buildAttachment,
  putAttachment,
} from '../../src/store/attachments'
import { attemptController } from '../../src/store/attempt-controller'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { importMessagesOp } from '../../src/store/conversation-command-client'
import {
  type ConversationPresentationResourcePort,
  conversationController,
} from '../../src/store/conversation-controller'
import { __resetDbForTests, getDb } from '../../src/store/db'
import {
  createGenerationEngine,
  type GenerationHandle,
  type GenerationIntent,
  type GenerationTransportInput,
} from '../../src/store/generation-engine'
import {
  type MessageBodyRow,
  sameMessageHeaderStructure,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import type { StreamLeaseRow } from '../../src/store/repository'
import { recoverStreamOrphan } from '../../src/store/stream-recovery'
import { closeStreamRecoveryCapability } from '../../src/store/stream-recovery-capability'
import type {
  WorkspaceCommand,
  WorkspaceRepository,
  WorkspaceWriteAuthority,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'
import { useAnnouncementStore } from '../../src/store/zustand/announcementStore'
import { createChat } from '../helpers/chats'
import { putCachedEndpoints, putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import {
  installGenerationProfile,
  prepareControlledGenerationSurface,
  requestGenerationStop,
  requireStartedGeneration,
  startControlledGeneration,
  startGenerationForIntent,
} from '../helpers/generation-engine'
import { executeMessageCommand } from '../helpers/message-commands'
import { readTestMessages } from '../helpers/message-storage'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'
import {
  appendTestStreamJournalEvents,
  readTestStreamJournalFrames,
} from '../helpers/stream-journal'
import { testContinuationLease } from '../helpers/stream-leases'

const DB_NAME = 'natter'
const MODEL = 'openai/gpt-4o'

function profile(): ConnectionProfile {
  return {
    id: 'lifecycle-profile',
    name: 'Lifecycle profile',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'lifecycle-key',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost:5173',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: profile().id,
    model: MODEL,
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
    ...overrides,
  }
}

type ExecuteInterceptor = (
  permit: WorkspaceWriteAuthority,
  command: WorkspaceCommand,
  next: WorkspaceRepository['execute'],
) => Promise<unknown>

let executeInterceptor: ExecuteInterceptor | undefined
let releasePresentationResources: () => void = () => undefined

const READY_PRESENTATION_RESOURCES: ConversationPresentationResourcePort = Object.freeze({
  get: () => Object.freeze({ kind: 'ready' }),
  request: () => undefined,
  subscribe: () => () => undefined,
})

async function reset(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  useAnnouncementStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openBrowserWorkspace()
  releasePresentationResources = conversationController.installPresentationResourcePort(
    READY_PRESENTATION_RESOURCES,
  )
  const target = getBrowserRepository()
  const next = target.execute.bind(target)
  __setWorkspaceRepositoryForTests(
    repositoryProxy(target, (async (permit, command) => {
      const interceptor = executeInterceptor
      return interceptor ? interceptor(permit, command, next) : next(permit, command)
    }) as WorkspaceRepository['execute']),
  )
  await installGenerationProfile(profile(), { 'lifecycle-key': 'sk-test' })
  await putCachedEndpoints(profile().id, MODEL, {
    id: MODEL,
    endpoints: [
      {
        provider_name: 'Lifecycle provider',
        provider_slug: 'lifecycle-provider',
        supported_parameters: ['temperature'],
        context_length: 200_000,
        pricing: {},
        data_policy: {
          training: false,
          training_openrouter: false,
          retains_prompts: false,
          can_publish: false,
        },
      },
    ],
  })
  await putCachedPrivacyPolicy(profile().id, MODEL, {
    policies: {
      'Lifecycle provider': {
        training: false,
        trainingOpenRouter: false,
        retainsPrompts: false,
        canPublish: false,
        termsOfServiceURL: '',
        privacyPolicyURL: '',
      },
    },
    fetchedAt: Date.now(),
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  executeInterceptor = undefined
  releasePresentationResources()
  releasePresentationResources = () => undefined
  __resetWorkspaceRepositoryForTests()
  await shutdownBrowserWorkspace()
  await reset()
})

describe('generation lifecycle contract', () => {
  it('publishes send and regenerate rows only after durable preparation owns their ids', async () => {
    const chat = await createChat({ settings: settings() })
    let releasePrepare: () => void = () => undefined
    let prepareStarted: () => void = () => undefined
    let prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    let prepareObserved = new Promise<void>((resolve) => {
      prepareStarted = resolve
    })
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'attempt.prepare') {
        prepareStarted()
        await prepareGate
      }
      return next(permit, command)
    }

    const send = await start(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'intent-owned prompt' }],
      },
      () => finiteStream(completionChunk('intent-owned answer')),
    )
    await prepareObserved
    try {
      expect(await messages(chat.id)).toEqual([])
    } finally {
      releasePrepare()
    }
    const sendPrepared = await send.prepared
    expect(new Set((await messages(chat.id)).map((message) => message.id))).toEqual(
      new Set([sendPrepared.userMessageId, sendPrepared.assistantMessageId]),
    )
    await send.completed

    prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve
    })
    prepareObserved = new Promise<void>((resolve) => {
      prepareStarted = resolve
    })
    const regenerate = await start(
      {
        kind: 'regenerate',
        chatId: chat.id,
        targetAssistantId: sendPrepared.assistantMessageId,
      },
      () => finiteStream(completionChunk('regenerated answer')),
    )
    await prepareObserved
    try {
      const durable = await messages(chat.id)
      expect(durable).toHaveLength(2)
      expect(
        durable.find((message) => message.id === sendPrepared.assistantMessageId)?.content,
      ).toEqual([{ type: 'output_text', text: 'intent-owned answer' }])
    } finally {
      releasePrepare()
    }
    const regeneratePrepared = await regenerate.prepared
    expect(regeneratePrepared.assistantMessageId).not.toBe(sendPrepared.assistantMessageId)
    expect((await messages(chat.id)).map((message) => message.id)).toContain(
      regeneratePrepared.assistantMessageId,
    )
    await regenerate.completed
  })

  it('rolls back the whole admission when attempt.prepare fails before publication', async () => {
    const chat = await createChat({ settings: settings() })
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'attempt.prepare') throw new Error('injected prepare failure')
      return next(permit, command)
    }
    const openStream = vi.fn(() => finiteStream(completionChunk()))
    const handle = await start(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'prepare failure' }],
      },
      openStream,
    )

    await expect(handle.prepared).rejects.toThrow('injected prepare failure')
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })
    expect(openStream).not.toHaveBeenCalled()
    expect(await messages(chat.id)).toEqual([])
    expect(await streamLeases(chat.id)).toEqual([])
  })

  it('publishes one exact send target before provider open and settles lease and journal', async () => {
    const chat = await createChat({ settings: settings() })
    const largeText = 's'.repeat(132 * 1024)
    let sawLease = false
    let sawDurableChunk = false
    let sawLive = false
    let targetId = ''
    const openStream = vi.fn((input: GenerationTransportInput) =>
      (async function* () {
        const attempt = attemptController.get(input.diagnosticId)
        expect(attempt).toMatchObject({
          chatId: chat.id,
          kind: 'generation',
          phase: 'streaming',
        })
        targetId = required(attempt?.messageId, 'send target')
        expect(await streamLease(input.diagnosticId)).toMatchObject({
          messageId: targetId,
          attemptKind: 'generation',
        })
        sawLease = true
        yield {
          type: 'delta',
          chunk: { choices: [{ delta: { content: largeText } }] },
        } satisfies AssistantStreamChunk
        await eventually(async () => {
          expect((await readTestStreamJournalFrames(input.diagnosticId)).length).toBeGreaterThan(0)
          expect(
            attemptController.getTargetSnapshot(chat.id, targetId).liveProjection,
          ).toBeDefined()
        })
        sawDurableChunk = true
        sawLive = true
        yield completionChunk(' after the durable flush')
      })(),
    )
    const handle = await start(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'hello' }],
      },
      openStream,
    )
    const prepared = await handle.prepared
    const stopDemand = attemptController.subscribeTarget(
      chat.id,
      prepared.assistantMessageId,
      () => undefined,
    )
    const result = await handle.completed
    stopDemand()

    expect(result).toMatchObject({ outcome: 'done', assistantMessageId: targetId })
    expect(sawLease).toBe(true)
    expect(sawDurableChunk).toBe(true)
    expect(sawLive).toBe(true)
    expect(await message(targetId)).toMatchObject({
      content: [{ type: 'output_text', text: `${largeText} after the durable flush` }],
      generation: { status: 'done' },
    })
    expect(await streamLease(handle.streamId)).toBeUndefined()
    expect(await readTestStreamJournalFrames(handle.streamId)).toEqual([])
    expect(attemptController.get(handle.streamId)).toBeUndefined()
    expect(useAnnouncementStore.getState().polite.map((event) => event.text)).toContain(
      'Assistant is responding.',
    )
  })

  it('reads the generated assistant body at most once across finalization and calibration', async () => {
    const chat = await createChat({ settings: settings() })
    const answer = 'b'.repeat(200)
    let providerClosed = false
    let activeSource: 'attempt.finalize' | 'generation.post-commit-metadata' | undefined
    const reachedSources = new Set<NonNullable<typeof activeSource>>()
    const bodyReads: Array<{
      messageId: MessageId
      source: NonNullable<typeof activeSource>
      storeNames: readonly string[]
    }> = []
    const reading = (row: MessageBodyRow | undefined): MessageBodyRow | undefined => {
      if (row && activeSource) {
        bodyReads.push({
          messageId: row.id,
          source: activeSource,
          storeNames: Object.freeze([...Dexie.currentTransaction.storeNames]),
        })
      }
      return row
    }
    getDb().messageBodies.hook('reading', reading)
    executeInterceptor = async (permit, command, next) => {
      if (
        command.kind !== 'attempt.finalize' &&
        command.kind !== 'generation.post-commit-metadata'
      ) {
        return next(permit, command)
      }
      expect(providerClosed).toBe(true)
      activeSource = command.kind
      reachedSources.add(command.kind)
      try {
        return await next(permit, command)
      } finally {
        activeSource = undefined
      }
    }

    let handle: GenerationHandle | undefined
    try {
      handle = await start(
        {
          kind: 'send',
          chatId: chat.id,
          target: { kind: 'fixed', messageId: null },
          content: [{ type: 'text', text: 'a'.repeat(400) }],
        },
        () =>
          (async function* () {
            yield {
              type: 'delta',
              chunk: {
                id: 'lifecycle-generation',
                choices: [{ delta: { content: answer }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
              },
            } satisfies AssistantStreamChunk
            providerClosed = true
          })(),
      )
      const prepared = await handle.prepared
      await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })

      expect(reachedSources).toEqual(
        new Set(['attempt.finalize', 'generation.post-commit-metadata']),
      )
      const assistantBodyReads = bodyReads.filter(
        (read) => read.messageId === prepared.assistantMessageId,
      )
      expect(
        assistantBodyReads.length,
        `generated assistant body reads: ${JSON.stringify(assistantBodyReads)}`,
      ).toBeLessThanOrEqual(1)
    } finally {
      getDb().messageBodies.hook('reading').unsubscribe(reading)
    }

    const completed = required(handle, 'generation handle')
    const prepared = await completed.prepared
    expect(await message(prepared.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: answer }],
      originalCharCount: answer.length,
      originalModelId: MODEL,
      generation: {
        status: 'done',
        tokenCalibration: {
          promptSample: true,
          completionSample: true,
          sampleCount: 2,
        },
      },
    })
  })

  it('admits Continue at canonical commit while predecessor metadata advances only the header', async () => {
    const chat = await createChat({ settings: settings() })
    let releaseMetadata: () => void = () => {}
    let releaseDispatch: () => void = () => {}
    let markMetadataReached: () => void = () => {}
    let markDispatchReached: () => void = () => {}
    let metadataPending = false
    const metadataReached = new Promise<void>((resolve) => {
      markMetadataReached = resolve
    })
    const dispatchReached = new Promise<void>((resolve) => {
      markDispatchReached = resolve
    })
    const metadataRelease = new Promise<void>((resolve) => {
      releaseMetadata = resolve
    })
    const dispatchRelease = new Promise<void>((resolve) => {
      releaseDispatch = resolve
    })
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'generation.post-commit-metadata' && !metadataPending) {
        metadataPending = true
        markMetadataReached()
        await metadataRelease
        return next(permit, command)
      }
      if (command.kind === 'attempt.dispatch' && metadataPending) {
        markDispatchReached()
        await dispatchRelease
        return next(permit, command)
      }
      return next(permit, command)
    }

    let first: GenerationHandle | undefined
    let continuation: GenerationHandle | undefined
    try {
      first = await start(
        {
          kind: 'send',
          chatId: chat.id,
          target: { kind: 'fixed', messageId: null },
          content: [{ type: 'text', text: 'a'.repeat(400) }],
        },
        () => finiteStream(completionChunk('b'.repeat(200))),
      )
      const firstPrepared = await first.prepared
      await metadataReached
      expect(await streamLease(first.streamId)).toMatchObject({
        messageId: firstPrepared.assistantMessageId,
        phase: 'canonical',
      })

      continuation = await start(
        {
          kind: 'continue',
          chatId: chat.id,
          targetAssistantId: firstPrepared.assistantMessageId,
        },
        () => finiteStream(completionChunk('-continued')),
      )
      await continuation.prepared
      await dispatchReached
      const beforeMetadata = required(
        await presentationFor(firstPrepared.assistantMessageId),
        'before predecessor metadata',
      )

      releaseMetadata()
      await expect(first.completed).resolves.toMatchObject({ outcome: 'done' })
      const afterMetadata = required(
        await presentationFor(firstPrepared.assistantMessageId),
        'after predecessor metadata',
      )
      expect(afterMetadata.header.nodeVersion).toBeGreaterThan(beforeMetadata.header.nodeVersion)
      expect(afterMetadata.bodyVersion).toBe(beforeMetadata.bodyVersion)

      releaseDispatch()
      await expect(continuation.completed).resolves.toMatchObject({ outcome: 'done' })
      expect(await message(firstPrepared.assistantMessageId)).toMatchObject({
        content: [{ type: 'output_text', text: `${'b'.repeat(200)}-continued` }],
        continuationAttempts: [expect.objectContaining({ application: { kind: 'applied' } })],
      })
    } finally {
      releaseMetadata()
      releaseDispatch()
      await Promise.allSettled([
        ...(first ? [first.completed] : []),
        ...(continuation ? [continuation.completed] : []),
      ])
    }
  })

  it('recovers canonical generation metadata after writer loss without rereading the assistant body', async () => {
    closeStreamRecoveryCapability()
    const chat = await createChat({ settings: settings() })
    const answer = 'r'.repeat(200)
    let metadataAttempts = 0
    let recoveryActive = false
    const recoveryBodyReads: MessageId[] = []
    const reading = (row: MessageBodyRow | undefined): MessageBodyRow | undefined => {
      if (row && recoveryActive) recoveryBodyReads.push(row.id)
      return row
    }
    getDb().messageBodies.hook('reading', reading)
    executeInterceptor = async (permit, command, next) => {
      if (command.kind !== 'generation.post-commit-metadata') {
        return next(permit, command)
      }
      metadataAttempts += 1
      if (metadataAttempts === 1) throw new Error('injected post-commit writer loss')
      return next(permit, command)
    }

    let handle: GenerationHandle | undefined
    try {
      handle = await start(
        {
          kind: 'send',
          chatId: chat.id,
          target: { kind: 'fixed', messageId: null },
          content: [{ type: 'text', text: 'p'.repeat(400) }],
        },
        () =>
          finiteStream({
            type: 'delta',
            chunk: {
              id: 'recovered-metadata-generation',
              choices: [{ delta: { content: answer }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
            },
          }),
      )
      const prepared = await handle.prepared
      await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
      expect(await streamLease(handle.streamId)).toMatchObject({
        messageId: prepared.assistantMessageId,
        attemptKind: 'generation',
        phase: 'canonical',
        custody: 'recovery-pending',
        handoffReason: 'cleanup-failed',
      })

      recoveryActive = true
      await expect(
        recoverStreamOrphan({ streamId: handle.streamId }, Date.now() + 60_000),
      ).resolves.toBe('recovered')
      recoveryActive = false

      expect(metadataAttempts).toBe(2)
      expect(
        recoveryBodyReads.filter((messageId) => messageId === prepared.assistantMessageId),
      ).toEqual([])
      await expectSettled(handle.streamId)
      expect(await message(prepared.assistantMessageId)).toMatchObject({
        content: [{ type: 'output_text', text: answer }],
        originalCharCount: answer.length,
        originalModelId: MODEL,
        generation: {
          status: 'done',
          tokenCalibration: {
            promptSample: true,
            completionSample: true,
            sampleCount: 2,
          },
        },
      })
    } finally {
      recoveryActive = false
      getDb().messageBodies.hook('reading').unsubscribe(reading)
    }
  })

  it.each([
    { name: 'empty SSE', chunks: [] as AssistantStreamChunk[], expectedText: '' },
    {
      name: 'content followed by ordinary EOF',
      chunks: [
        { type: 'delta', chunk: { choices: [{ delta: { content: 'partial response' } }] } },
      ] as AssistantStreamChunk[],
      expectedText: 'partial response',
    },
  ])('persists $name as a retryable truncated-stream error', async ({ chunks, expectedText }) => {
    const chat = await createChat({ settings: settings() })
    const result = await run(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'terminal evidence' }],
      },
      () => finiteStream(...chunks),
    )

    expect(result).toMatchObject({
      outcome: 'error',
      error: { kind: 'protocol', code: 'STREAM_TRUNCATED', midStream: true, retryable: true },
    })
    expect(await message(result.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: expectedText }],
      generation: {
        status: 'error',
        error: {
          category: 'protocol',
          code: 'STREAM_TRUNCATED',
          retryable: true,
          midStream: true,
        },
      },
    })
    await expectSettled(result.streamId)
  })

  it('finalizes a silent-stream timeout and leaves topology and presentation readable', async () => {
    const chat = await createChat({ settings: settings() })
    const timeout = new ApiError({
      kind: 'timeout',
      code: 'TIMEOUT',
      message: 'Request timed out',
      midStream: true,
      retryable: true,
    })
    const result = await run(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'silent stream' }],
      },
      () => throwingStream(timeout),
    )

    expect(result).toMatchObject({ outcome: 'error', error: timeout })
    expect(await message(result.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: '' }],
      generation: {
        status: 'error',
        error: { category: 'network', code: 'TIMEOUT', retryable: true, midStream: true },
      },
    })
    const headers = await messageHeaders(chat.id)
    expect(
      layoutBranchTree(
        createMessageTopologyIndex(headers, { sameStructure: sameMessageHeaderStructure }),
      ).byId.has(result.assistantMessageId),
    ).toBe(true)
    expect(await presentationFor(result.assistantMessageId)).toBeDefined()
  })

  it('accepts a chat [DONE] sentinel as clean terminal evidence through the default transport', async () => {
    const chat = await createChat({ settings: settings({ api: 'chat' }) })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: {"choices":[{"delta":{"content":"sentinel complete"}}]}\n\ndata: [DONE]\n\n',
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
      ),
    )
    const result = await runDefault({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'sentinel' }],
    })

    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ outcome: 'done' })
    expect(await message(result.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: 'sentinel complete' }],
      generation: { status: 'done', integrity: 'clean' },
    })
  })

  it('finalizes a delayed malformed Responses frame before topology and body reads', async () => {
    const chat = await createChat({ settings: settings({ api: 'responses' }) })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => delayedMalformedResponsesStream()),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await runDefault({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'malformed frame lifecycle' }],
    })

    expect(result).toMatchObject({ outcome: 'done', finishReason: 'stop' })
    const assistant = required(await message(result.assistantMessageId), 'assistant')
    expect(assistant).toMatchObject({
      content: [{ type: 'output_text', text: '' }],
      generation: {
        apiUsed: 'responses',
        status: 'done',
        integrity: 'degraded',
        integritySummary: {
          count: 1,
          entries: [
            {
              category: 'malformed-event-shape',
              adapter: 'responses',
              eventType: 'response.output_text.delta',
              count: 1,
            },
          ],
        },
      },
    })
    const headers = await messageHeaders(chat.id)
    expect(
      layoutBranchTree(
        createMessageTopologyIndex(headers, { sameStructure: sameMessageHeaderStructure }),
      ).byId.has(result.assistantMessageId),
    ).toBe(true)
    expect((await presentationFor(result.assistantMessageId))?.message).toEqual(assistant)
  })

  it('Continue uses the same durable lease, live projection, cleanup, and attempt history', async () => {
    const { chatId, target } = await seedAssistant('continue-success')
    const largeText = 'c'.repeat(132 * 1024)
    const snapshots: number[] = []
    const stopDemand = attemptController.subscribeTarget(chatId, target.id, () => {
      const live = attemptController.getTargetSnapshot(chatId, target.id).liveProjection
      if (live) snapshots.push(live.textLength)
    })
    let sawDurable = false
    const handle = await start(
      { kind: 'continue', chatId, targetAssistantId: target.id },
      (input) =>
        (async function* () {
          expect(attemptController.get(input.diagnosticId)).toMatchObject({
            messageId: target.id,
            kind: 'continuation',
            phase: 'streaming',
          })
          yield { type: 'delta', chunk: { choices: [{ delta: { content: largeText } }] } }
          await eventually(async () => {
            expect((await readTestStreamJournalFrames(input.diagnosticId)).length).toBeGreaterThan(
              0,
            )
          })
          sawDurable = true
          yield completionChunk()
        })(),
    )
    await handle.prepared
    const result = await handle.completed
    stopDemand()

    expect(result.outcome).toBe('done')
    expect(sawDurable).toBe(true)
    expect(snapshots.length).toBeGreaterThan(0)
    expect(await message(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: `original${largeText}` }],
      generation: target.generation,
      continuationAttempts: [
        expect.objectContaining({
          streamId: handle.streamId,
          strategy: 'prompt',
          status: 'done',
          requestedModel: MODEL,
          apiUsed: 'chat',
        }),
      ],
    })
    await expectSettled(handle.streamId)
  })

  it('Continue preserves structured content order and original failure provenance', async () => {
    const { chatId, target } = await seedAssistant('structured')
    const image = await buildAttachment({
      blob: new Blob(['image']),
      filename: 'image.png',
      mime: 'image/png',
      kind: 'image',
      origin: 'generated-output',
    })
    const audio = await buildAttachment({
      blob: new Blob(['audio']),
      filename: 'audio.wav',
      mime: 'audio/wav',
      kind: 'audio',
      origin: 'generated-output',
    })
    await putAttachment(image)
    await putAttachment(audio)
    await addExistingAttachmentRef({
      messageId: target.id,
      attachmentId: image.id,
      includeInContext: false,
    })
    await addExistingAttachmentRef({
      messageId: target.id,
      attachmentId: audio.id,
      includeInContext: false,
    })
    const originalContent: ContentItem[] = [
      {
        type: 'output_text',
        text: 'cited opening',
        annotations: [
          {
            type: 'url_citation',
            url: 'https://example.invalid/source',
            startIndex: 0,
            endIndex: 13,
            source: 'imported',
            providerPayload: {
              type: 'url_citation',
              url: 'https://example.invalid/source',
            },
          },
        ],
      },
      { type: 'output_image', attachmentId: image.id, prompt: 'chart' },
      { type: 'output_text', text: 'middle' },
      { type: 'audio_output', attachmentId: audio.id, format: 'wav' },
      {
        type: 'output_text',
        text: 'cited ending',
        annotations: [
          {
            type: 'file_citation',
            filename: 'evidence.txt',
            file: { kind: 'unresolved', provider: 'imported' },
            startIndex: 12,
            endIndex: 12,
            source: 'imported',
            providerPayload: { type: 'file_citation', filename: 'evidence.txt' },
          },
        ],
      },
    ]
    const originalGeneration = {
      ...required(target.generation, 'generation'),
      status: 'interrupted' as const,
      abortReason: 'network' as const,
      error: { category: 'network' as const, code: 'NETWORK', message: 'original ended' },
    }
    await executeMessageCommand({
      kind: 'message.edit-body',
      input: { chatId, messageId: target.id, content: originalContent },
    })
    await patchMessageFixture(target.id, { generation: originalGeneration })

    const result = await run({ kind: 'continue', chatId, targetAssistantId: target.id }, () =>
      finiteStream(chatCitationChunk(' continued')),
    )
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ outcome: 'done' })
    const continued = required(await message(target.id), 'continued target')
    expect(continued.continuationAttempts).toEqual([expect.objectContaining({ status: 'done' })])
    expect(continued.continuationAttempts?.[0]).not.toHaveProperty('unappliedText')
    expect(continued.continuationAttempts?.[0]).not.toHaveProperty('unappliedAnnotations')
    expect(continued.content).toEqual([
      ...originalContent,
      {
        type: 'output_text',
        text: ' continued',
        annotations: [
          expect.objectContaining({
            type: 'url_citation',
            source: 'openai-chat',
            startIndex: 1,
            endIndex: 10,
            url: 'https://example.invalid/continued',
          }),
        ],
      },
    ])
    expect(continued.generation).toEqual(originalGeneration)
  })

  it('Continue stores returned tool calls on its attempt without changing original tool calls', async () => {
    const { chatId, target } = await seedAssistant('tool-call')
    const originalToolCalls = [
      {
        id: 'original-call',
        type: 'function' as const,
        function: { name: 'original_tool', arguments: '{"original":true}' },
      },
    ]
    await patchMessageFixture(target.id, { toolCalls: originalToolCalls })

    await run({ kind: 'continue', chatId, targetAssistantId: target.id }, () =>
      finiteStream(
        {
          type: 'delta',
          chunk: {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'continued-call',
                      type: 'function',
                      function: { name: 'continued_tool', arguments: '{"continued":' },
                    },
                  ],
                },
              },
            ],
          },
        },
        {
          type: 'delta',
          chunk: {
            choices: [
              {
                delta: { tool_calls: [{ index: 0, function: { arguments: 'true}' } }] },
                finish_reason: 'tool_calls',
              },
            ],
          },
        },
      ),
    )
    const continued = required(await message(target.id), 'continued target')
    expect(continued.toolCalls).toEqual(originalToolCalls)
    expect(continued.continuationAttempts?.[0]?.toolCalls).toEqual([
      {
        id: 'continued-call',
        type: 'function',
        function: { name: 'continued_tool', arguments: '{"continued":true}' },
      },
    ])
  })

  it('send and Continue both canonicalize one user abort without overwriting original provenance', async () => {
    const sendChat = await createChat({ settings: settings() })
    const sendHandle = await start(
      {
        kind: 'send',
        chatId: sendChat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'abort send' }],
      },
      (input) => abortableStream(input.signal),
    )
    const sendPrepared = await sendHandle.prepared
    await eventually(() =>
      expect(attemptController.get(sendHandle.streamId)?.phase).toBe('streaming'),
    )
    const sendStop = await requestGenerationStop(sendHandle)
    await expect(sendStop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    await expect(sendHandle.completed).resolves.toMatchObject({ outcome: 'abort' })
    expect(await message(sendPrepared.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: 'partial' }],
      generation: { status: 'abort', abortReason: 'user' },
    })

    const { chatId, target } = await seedAssistant('continue-abort')
    const continueHandle = await start(
      { kind: 'continue', chatId, targetAssistantId: target.id },
      (input) => abortableStream(input.signal),
    )
    await continueHandle.prepared
    await eventually(() =>
      expect(attemptController.get(continueHandle.streamId)?.phase).toBe('streaming'),
    )
    const continueStop = await requestGenerationStop(continueHandle)
    await expect(continueStop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    await expect(continueHandle.completed).resolves.toMatchObject({ outcome: 'abort' })
    expect(await message(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'originalpartial' }],
      generation: target.generation,
      continuationAttempts: [
        expect.objectContaining({
          streamId: continueHandle.streamId,
          status: 'abort',
          abortReason: 'user',
        }),
      ],
    })
  })

  it('normalizes API and unknown stream failures for send and Continue', async () => {
    const apiError = new ApiError({
      kind: 'bad_request',
      code: 400,
      message: 'injected API error',
      midStream: true,
      retryable: false,
    })
    for (const error of [apiError, new Error('injected unknown send error')]) {
      const chat = await createChat({ settings: settings() })
      const result = await run(
        {
          kind: 'send',
          chatId: chat.id,
          target: { kind: 'fixed', messageId: null },
          content: [{ type: 'text', text: 'send failure' }],
        },
        () => throwingStream(error),
      )
      expect(result.outcome).toBe('error')
      expect(result.error?.message).toBe(error.message)
      expect((await message(result.assistantMessageId))?.generation?.status).toBe('error')
    }

    for (const error of [apiError, new Error('injected unknown Continue error')]) {
      const { chatId, target } = await seedAssistant(`continue-${error.message}`)
      const result = await run({ kind: 'continue', chatId, targetAssistantId: target.id }, () =>
        throwingStream(error),
      )
      expect(result).toMatchObject({ outcome: 'error', error: { message: error.message } })
      expect((await message(target.id))?.continuationAttempts).toEqual([
        expect.objectContaining({ status: 'error' }),
      ])
    }
    expect(
      useAnnouncementStore
        .getState()
        .assertive.filter((event) => event.text.includes('Response failed')).length,
    ).toBeGreaterThan(0)
  })

  it('keeps the durable live projection while finalization and immediate recovery both fail', async () => {
    const chat = await createChat({ settings: settings() })
    let finalizeFailures = 2
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'attempt.finalize' && finalizeFailures > 0) {
        finalizeFailures -= 1
        throw new Error('injected final write failure')
      }
      return next(permit, command)
    }
    const largeText = 'x'.repeat(132 * 1024)
    const handle = await start(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'fail final write' }],
      },
      () => finiteStream(completionChunk(largeText)),
    )
    const prepared = await handle.prepared
    const stopDemand = attemptController.subscribeTarget(
      chat.id,
      prepared.assistantMessageId,
      () => undefined,
    )
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })
    await expect(
      recoverStreamOrphan({ streamId: handle.streamId }, Date.now() + 60_000),
    ).rejects.toThrow('injected final write failure')

    expect(finalizeFailures).toBe(0)
    expect(attemptController.get(handle.streamId)).toMatchObject({ phase: 'recovery-pending' })
    expect(
      attemptController.getTargetSnapshot(chat.id, prepared.assistantMessageId).liveProjection,
    ).toMatchObject({ textLength: largeText.length })
    expect(await streamLease(handle.streamId)).toBeDefined()
    expect((await readTestStreamJournalFrames(handle.streamId)).length).toBeGreaterThan(0)

    await expect(
      recoverStreamOrphan({ streamId: handle.streamId }, Date.now() + 120_000),
    ).resolves.toMatch(/^(?:recovered|resolved)$/u)
    stopDemand()
    await eventually(() => expect(attemptController.get(handle.streamId)).toBeUndefined())
    expect(await message(prepared.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: largeText }],
      generation: { status: 'done' },
    })
  })

  it.each([
    { name: 'empty truncation', chunks: [] as AssistantStreamChunk[], expectedText: '' },
    {
      name: 'partial truncation',
      chunks: [
        { type: 'delta', chunk: { choices: [{ delta: { content: 'durable partial' } }] } },
      ] as AssistantStreamChunk[],
      expectedText: 'durable partial',
    },
  ])('recovers $name after a canonical write failure', async ({ chunks, expectedText }) => {
    const chat = await createChat({ settings: settings() })
    const result = await runWithFailedFinalize(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'recover truncation' }],
      },
      () => finiteStream(...chunks),
    )
    await recoverStreamOrphan({ streamId: result.streamId }, Date.now() + 60_000)
    expect(await message(result.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: expectedText }],
      generation: {
        status: 'error',
        error: { category: 'protocol', code: 'STREAM_TRUNCATED', retryable: true },
      },
    })
    await expectSettled(result.streamId)
  })

  it('recovers durable partial output and the sealed network abort after finalization fails', async () => {
    const chat = await createChat({ settings: settings() })
    const networkError = new ApiError({
      kind: 'network',
      code: 'NETWORK',
      message: 'stream reader disconnected',
      midStream: true,
      retryable: true,
    })
    const result = await runWithFailedFinalize(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'recover network failure' }],
      },
      () =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'durable network partial' } }] },
          }
          throw networkError
        })(),
    )
    await recoverStreamOrphan({ streamId: result.streamId }, Date.now() + 60_000)
    expect(await message(result.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: 'durable network partial' }],
      generation: {
        status: 'abort',
        error: { category: 'network', code: 'NETWORK', retryable: true, midStream: true },
      },
    })
  })

  it('prevents a recovered send from being overwritten by a stale terminal command', async () => {
    const chat = await createChat({ settings: settings() })
    let captured: Extract<WorkspaceCommand, { kind: 'attempt.finalize' }> | undefined
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'attempt.finalize' && !captured) {
        captured = structuredClone(command)
        throw new Error('hold stale send finalizer')
      }
      return next(permit, command)
    }
    const durable = 'race-safe send'.repeat(12_000)
    const handle = await start(
      {
        kind: 'send',
        chatId: chat.id,
        target: { kind: 'fixed', messageId: null },
        content: [{ type: 'text', text: 'stale send race' }],
      },
      () => finiteStream(completionChunk(durable)),
    )
    const prepared = await handle.prepared
    await handle.completed
    await recoverStreamOrphan({ streamId: handle.streamId }, Date.now() + 60_000)
    const recovered = await message(prepared.assistantMessageId)

    await expect(executeWorkspace(required(captured, 'captured finalizer'))).rejects.toThrow(
      `StreamFenceLost:${handle.streamId}`,
    )
    expect(await message(prepared.assistantMessageId)).toEqual(recovered)
  })

  it('recovers interrupted Continue text, reasoning, and tool calls separately from provenance', async () => {
    const { chatId, target } = await seedAssistant('stale-continue')
    const baseline = required(await presentationFor(target.id), 'baseline')
    const lease = await insertContinuationLease({
      streamId: 'stale-continue-stream',
      chatId,
      messageId: target.id,
      baseNodeVersion: baseline.header.nodeVersion,
      baseBodyVersion: baseline.bodyVersion,
      continuationStrategy: 'prefill',
    })
    await appendTestStreamJournalEvents(lease, [
      { lane: 'text', text: '-recovered' },
      {
        lane: 'text-annotations',
        ownerTextLength: 10,
        annotations: [
          {
            type: 'url_citation',
            source: 'openai-chat',
            startIndex: 1,
            endIndex: 10,
            url: 'https://example.invalid/recovered',
            providerPayload: {
              type: 'url_citation',
              url: 'https://example.invalid/recovered',
            },
          },
        ],
      },
      {
        lane: 'reasoning',
        mutations: [
          {
            kind: 'replace',
            envelope: reasoningEnvelopeFromDetailsForTest(
              [{ type: 'reasoning.text', text: 'continuation reasoning' }],
              'openrouter-chat',
            ),
          },
        ],
      },
      {
        lane: 'tool-call',
        index: 0,
        id: 'recovered-call',
        type: 'function',
        name: 'recover_tool',
        argumentsDelta: '{"recovered":',
      },
      { lane: 'tool-call', index: 0, argumentsDelta: 'true}' },
    ])

    await expect(
      recoverStreamOrphan({ streamId: lease.streamId }, Date.now() + 60_000),
    ).resolves.toBe('recovered')
    const recovered = await message(target.id)
    expect(recovered).toMatchObject({
      content: [
        {
          type: 'output_text',
          text: 'original-recovered',
          annotations: [
            expect.objectContaining({
              startIndex: 9,
              endIndex: 18,
              url: 'https://example.invalid/recovered',
            }),
          ],
        },
      ],
      generation: target.generation,
    })
    const recoveredAttempt = recovered?.continuationAttempts?.[0]
    expect(recoveredAttempt?.streamId).toBe(lease.streamId)
    expect(recoveredAttempt?.strategy).toBe('prefill')
    expect(recoveredAttempt?.status).toBe('interrupted')
    expect(recoveredAttempt?.abortReason).toBe('tab-close')
    expect(recoveredAttempt?.reasoningEnvelope?.visible[0]?.text).toBe('continuation reasoning')
    expect(recoveredAttempt?.toolCalls).toEqual([
      {
        id: 'recovered-call',
        type: 'function',
        function: { name: 'recover_tool', arguments: '{"recovered":true}' },
      },
    ])
  })

  it('keeps a canonical Continue lease as cleanup anchor and never appends twice', async () => {
    const { chatId, target } = await seedAssistant('cleanup-retry')
    let failCleanup = true
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'stream.finish-cleanup' && failCleanup) {
        failCleanup = false
        throw new Error('injected cleanup failure')
      }
      return next(permit, command)
    }
    const result = await run({ kind: 'continue', chatId, targetAssistantId: target.id }, () =>
      finiteStream(chatCitationChunk('-once')),
    )
    expect(result).toMatchObject({ outcome: 'done' })
    expect(typeof (await streamLease(result.streamId))?.canonicalAt).toBe('number')
    const canonicalContent = (await message(target.id))?.content
    expect(canonicalContent).toEqual([
      {
        type: 'output_text',
        text: 'original-once',
        annotations: [
          expect.objectContaining({
            startIndex: 8,
            endIndex: 13,
            url: 'https://example.invalid/continued',
          }),
        ],
      },
    ])

    await recoverStreamOrphan({ streamId: result.streamId }, Date.now() + 60_000)
    expect((await message(target.id))?.content).toEqual(canonicalContent)
    expect((await message(target.id))?.continuationAttempts).toHaveLength(1)
    await expectSettled(result.streamId)
  })

  it('applies a recovered Continue tail across an independent context-visibility revision', async () => {
    const { chatId, target } = await seedAssistant('context-visibility-revision')
    const baseline = required(await presentationFor(target.id), 'baseline')
    await executeMessageCommand({
      kind: 'message.toggle-context',
      chatId,
      messageId: target.id,
    })
    const revised = required(await presentationFor(target.id), 'revised')
    expect(revised.header.nodeVersion).toBeGreaterThan(baseline.header.nodeVersion)
    expect(revised.bodyVersion).toBe(baseline.bodyVersion)
    expect(revised.message.hiddenFromContext).toBe(true)
    const lease = await insertContinuationLease({
      streamId: 'context-visibility-revision-stream',
      chatId,
      messageId: target.id,
      baseNodeVersion: baseline.header.nodeVersion,
      baseBodyVersion: baseline.bodyVersion,
    })
    await appendTestStreamJournalEvents(lease, [
      { lane: 'text', text: '-recovered-after-context-toggle' },
      {
        lane: 'text-annotations',
        ownerTextLength: 31,
        annotations: [
          {
            type: 'url_citation',
            source: 'openai-chat',
            startIndex: 1,
            endIndex: 31,
            url: 'https://example.invalid/recovered',
            providerPayload: {
              type: 'url_citation',
              url: 'https://example.invalid/recovered',
            },
          },
        ],
      },
    ])

    await recoverStreamOrphan({ streamId: lease.streamId }, Date.now() + 60_000)
    expect(await message(target.id)).toMatchObject({
      hiddenFromContext: true,
      content: [
        {
          type: 'output_text',
          text: 'original-recovered-after-context-toggle',
          annotations: [
            expect.objectContaining({
              startIndex: 9,
              endIndex: 39,
              url: 'https://example.invalid/recovered',
            }),
          ],
        },
      ],
      continuationAttempts: [
        expect.objectContaining({
          application: { kind: 'applied' },
        }),
      ],
    })
  })

  it('does not overwrite a newer edit while recovering a stale Continue tail', async () => {
    const { chatId, target } = await seedAssistant('edit-race')
    const baseline = required(await presentationFor(target.id), 'baseline')
    await executeMessageCommand({
      kind: 'message.edit-body',
      input: {
        chatId,
        messageId: target.id,
        content: [{ type: 'output_text', text: 'newer user edit' }],
      },
    })
    const lease = await insertContinuationLease({
      streamId: 'edit-race-stream',
      chatId,
      messageId: target.id,
      baseNodeVersion: baseline.header.nodeVersion,
      baseBodyVersion: baseline.bodyVersion,
    })
    await appendTestStreamJournalEvents(lease, [{ lane: 'text', text: '-stale-tail' }])

    await recoverStreamOrphan({ streamId: lease.streamId }, Date.now() + 60_000)
    expect(await message(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'newer user edit' }],
      continuationAttempts: [expect.objectContaining({ unappliedText: '-stale-tail' })],
    })
  })

  it('recovers Continue text and attempt provenance after a canonical write failure', async () => {
    const { chatId, target } = await seedAssistant('continue-finalize-failure')
    const originalGeneration = target.generation
    const result = await runWithFailedFinalize(
      { kind: 'continue', chatId, targetAssistantId: target.id },
      () => finiteStream(completionChunk('-recovered-tail')),
    )
    await recoverStreamOrphan({ streamId: result.streamId }, Date.now() + 60_000)
    expect(await message(target.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'original-recovered-tail' }],
      generation: originalGeneration,
      continuationAttempts: [
        expect.objectContaining({ streamId: result.streamId, status: 'done' }),
      ],
    })
  })

  it('prevents recovered Continue output from being appended again by a stale terminal command', async () => {
    const { chatId, target } = await seedAssistant('continue-stale-finalizer')
    let captured: Extract<WorkspaceCommand, { kind: 'attempt.finalize' }> | undefined
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'attempt.finalize' && !captured) {
        captured = structuredClone(command)
        throw new Error('hold stale Continue finalizer')
      }
      return next(permit, command)
    }
    const handle = await start({ kind: 'continue', chatId, targetAssistantId: target.id }, () =>
      finiteStream(completionChunk('-tail')),
    )
    await handle.prepared
    await handle.completed
    await recoverStreamOrphan({ streamId: handle.streamId }, Date.now() + 60_000)
    const recovered = await message(target.id)

    await expect(executeWorkspace(required(captured, 'captured finalizer'))).rejects.toThrow(
      `StreamFenceLost:${handle.streamId}`,
    )
    expect(await message(target.id)).toEqual(recovered)
    expect((await message(target.id))?.continuationAttempts).toHaveLength(1)
  })
})

async function start(
  intent: GenerationIntent,
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>,
): Promise<GenerationHandle> {
  return startControlledGeneration(intent, {
    profile: profile(),
    keyMaterial: { 'lifecycle-key': 'sk-test' },
    openStream,
  })
}

async function run(
  intent: GenerationIntent,
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>,
) {
  const handle = await start(intent, openStream)
  void handle.prepared.catch(() => {})
  return handle.completed
}

async function runDefault(intent: GenerationIntent) {
  const releaseSurface = await prepareControlledGenerationSurface(intent, { profile: profile() })
  let handle: GenerationHandle
  try {
    handle = requireStartedGeneration(startGenerationForIntent(createGenerationEngine(), intent))
  } finally {
    releaseSurface()
  }
  void handle.prepared.catch(() => {})
  return handle.completed
}

async function runWithFailedFinalize(
  intent: GenerationIntent,
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>,
) {
  let failed = false
  executeInterceptor = async (permit, command, next) => {
    if (command.kind === 'attempt.finalize' && !failed) {
      failed = true
      throw new Error('injected canonical write failure')
    }
    return next(permit, command)
  }
  const handle = await start(intent, openStream)
  const prepared = await handle.prepared
  await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })
  expect(failed).toBe(true)
  return { ...prepared, streamId: handle.streamId }
}

function completionChunk(text = ''): AssistantStreamChunk {
  return {
    type: 'delta',
    chunk: {
      id: 'lifecycle-generation',
      choices: [{ delta: text ? { content: text } : {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  }
}

function chatCitationChunk(text: string): AssistantStreamChunk {
  return {
    type: 'buffered_result',
    result: {
      id: 'lifecycle-generation',
      model: MODEL,
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: text,
            annotations: [
              {
                type: 'url_citation',
                start_index: text.startsWith(' ') ? 1 : 0,
                end_index: text.length,
                url: 'https://example.invalid/continued',
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  }
}

async function* finiteStream(
  ...chunks: AssistantStreamChunk[]
): AsyncGenerator<AssistantStreamChunk> {
  for (const chunk of chunks) yield chunk
}

function throwingStream(error: unknown): AsyncIterable<AssistantStreamChunk> {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => Promise.reject(error) }
    },
  }
}

function abortableStream(signal: AbortSignal): AsyncIterable<AssistantStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'delta', chunk: { choices: [{ delta: { content: 'partial' } }] } }
      await new Promise<never>((_, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
  }
}

function delayedMalformedResponsesStream(): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': upstream still working\n\n'))
      queueMicrotask(() => {
        controller.enqueue(
          encoder.encode(
            [
              'event: response.output_text.delta',
              'data: {"type":"response.output_text.delta","delta":{"text":"wrong-shape"},"output_index":0,"content_index":0}',
              '',
              'event: response.completed',
              'data: {"type":"response.completed","response":{"status":"completed"}}',
              '',
              '',
            ].join('\n'),
          ),
        )
        controller.close()
      })
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function seedAssistant(suffix: string): Promise<{
  chatId: string
  user: Message
  target: Message
}> {
  const chat = await createChat({ settings: settings() })
  const imported = await importMessagesOp({
    chatId: chat.id,
    slot: { kind: 'at-end' },
    activeLeafId: null,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'original' }] },
    ],
  })
  const user = required(imported.presentations[0]?.message, `${suffix} user`)
  const target = await patchMessageFixture(
    required(imported.presentations[1]?.message, `${suffix} assistant`).id,
    {
      generation: {
        id: `generation-${suffix}`,
        model: MODEL,
        requestedModel: MODEL,
        apiUsed: 'chat',
        delivery: 'streaming',
        status: 'done',
        integrity: 'clean',
        costSource: 'stream',
        startedAt: 1,
        finishedAt: 2,
        reasoningCarryForward: 'unknown',
        reasoningVisibility: { disclosure: 'unknown' },
      },
    },
  )
  return { chatId: chat.id, user, target }
}

async function patchMessageFixture(
  messageId: MessageId,
  patch: Partial<Message>,
): Promise<Message> {
  const presentation = required(await presentationFor(messageId), 'fixture presentation')
  const next = { ...presentation.message, ...structuredClone(patch) }
  const split = splitMessageForStorage(next, {
    bodyVersion: presentation.bodyVersion + 1,
    requestContextVersion: presentation.header.requestContextVersion + 1,
  })
  await getDb().transaction(
    'rw',
    getDb().messages,
    getDb().messageBodies,
    getDb().messagePreviews,
    async () => {
      await getDb().messages.put(split.header)
      await getDb().messageBodies.put(split.body)
      await getDb().messagePreviews.put(split.preview)
    },
  )
  return next
}

async function insertContinuationLease(input: {
  streamId: string
  chatId: string
  messageId: MessageId
  baseNodeVersion: number
  baseBodyVersion: number
  continuationStrategy?: 'prompt' | 'prefill'
}): Promise<StreamLeaseRow> {
  const now = Date.now()
  const lease = testContinuationLease({
    streamId: input.streamId,
    chatId: input.chatId,
    messageId: input.messageId,
    ownerClientId: `closed:${input.streamId}`,
    fenceToken: `fence:${input.streamId}`,
    replacementEpoch: 0,
    startedAt: now,
    heartbeatAt: now,
    admissionSequence: 1,
    revision: 0,
    targetCommittedAt: now + 1,
    continuationStrategy: input.continuationStrategy ?? 'prompt',
    baseNodeVersion: input.baseNodeVersion,
    baseBodyVersion: input.baseBodyVersion,
    requestedModel: MODEL,
    apiUsed: 'chat',
    postCommit: { usedAt: now, profileId: profile().id },
  })
  await getDb().streamLeases.put(lease)
  return lease
}

async function executeWorkspace(command: WorkspaceCommand): Promise<unknown> {
  return runWorkspaceAction('conversation-generation', (permit) =>
    getWorkspaceRepository().execute(permit, command),
  )
}

async function expectSettled(streamId: string): Promise<void> {
  await eventually(async () => {
    expect(await streamLease(streamId)).toBeUndefined()
    expect(await readTestStreamJournalFrames(streamId)).toEqual([])
    expect(attemptController.get(streamId)).toBeUndefined()
  })
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  throw lastError
}

async function messages(chatId: string): Promise<Message[]> {
  return readTestMessages(chatId)
}

async function message(messageId: MessageId): Promise<Message | undefined> {
  return (await presentationFor(messageId))?.message
}

async function presentationFor(messageId: MessageId) {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'message.presentation', messageId },
        { signal: permit.signal },
      )
    ).value
  })
}

async function messageHeaders(chatId: string) {
  return runWorkspaceRead('repository-query', async (permit) => {
    const topology = (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'message.headers-by-chat', chatId },
        { signal: permit.signal },
      )
    ).value
    if (topology.kind !== 'ready') {
      throw new Error(`LifecycleTopologyUnavailable:${chatId}:${topology.kind}`)
    }
    return topology.headers
  })
}

async function streamLease(streamId: string) {
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

async function streamLeases(chatId: string) {
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

function repositoryProxy(
  target: WorkspaceRepository,
  execute: WorkspaceRepository['execute'],
): WorkspaceRepository {
  return {
    query: target.query.bind(target),
    execute,
    replace: target.replace.bind(target),
    subscribeChanges: target.subscribeChanges.bind(target),
  }
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

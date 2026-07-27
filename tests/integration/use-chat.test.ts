import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { ApiError } from '../../src/api/errors'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../../src/api/types'
import { beginRouteIntent } from '../../src/app/router'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID } from '../../src/core/generated-output-localization'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
import { navigateConversationMessage } from '../../src/hooks/useConversationCursor'
import { attemptController } from '../../src/store/attempt-controller'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { getChat } from '../../src/store/chats'
import { importMessagesOp } from '../../src/store/conversation-command-client'
import { __resetDbForTests, getDb } from '../../src/store/db'
import {
  abortGeneratedOutputLocalizationCapability,
  awaitGeneratedOutputLocalizationCapabilityIdle,
} from '../../src/store/generated-output-localization-capability'
import type {
  CompletedGeneration,
  GenerationHandle,
  GenerationTransportInput,
} from '../../src/store/generation-engine'
import {
  __setLockBackendForTests,
  type AuthoritativeCommandLockSession,
  type LockBackend,
  type LockGrant,
} from '../../src/store/locks'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { requirePersistedStreamEventV2 } from '../../src/store/persisted-stream-event'
import {
  type FencedStreamLeaseRow,
  type StreamLeaseRow,
  streamLeaseHasWriteFence,
} from '../../src/store/repository'
import {
  __resetStreamLeasesForTests,
  __setStreamLockManagerForTests,
  streamWriteFenceForLease,
  waitForStreamOwnershipRelease,
} from '../../src/store/stream-leases'
import { closeStreamRecoveryRuntime, recoverStreamOrphan } from '../../src/store/stream-recovery'
import type { WorkspaceQuery, WorkspaceRepository } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
  readWorkspaceMeta,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'
import { CONVERSATION_SESSION_PREFIX } from '../../src/store/workspace-tab-session'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { createChat } from '../helpers/chats'
import { putCachedEndpoints, putCachedPrivacyPolicy } from '../helpers/discovery-cache'
import {
  installGenerationProfile,
  requestGenerationStop,
  startControlledGeneration,
} from '../helpers/generation-engine'
import { executeMessageCommand } from '../helpers/message-commands'
import { readTestMessageHeader, readTestMessages } from '../helpers/message-storage'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'
import {
  appendTestStreamJournalEvents,
  decodeTestStreamJournalFrames,
  readTestStreamJournalFrames,
  seedTestStreamJournalEvents,
} from '../helpers/stream-journal'
import { testContinuationLease, testGenerationLease } from '../helpers/stream-leases'

const DB_NAME = 'natter'

class TestExclusiveLockManager {
  private readonly held = new Set<string>()
  private readonly queues = new Map<string, Array<() => void>>()

  request<T>(
    name: string,
    optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
    maybeCallback?: (lock: Lock | null) => T | PromiseLike<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback
    const callback =
      typeof optionsOrCallback === 'function'
        ? optionsOrCallback
        : (maybeCallback as NonNullable<typeof maybeCallback>)
    if (options.ifAvailable && this.held.has(name)) return Promise.resolve(callback(null))
    return new Promise<T>((resolve, reject) => {
      const acquire = () => {
        if (this.held.has(name)) {
          const queue = this.queues.get(name) ?? []
          queue.push(acquire)
          this.queues.set(name, queue)
          return
        }
        this.held.add(name)
        const release = () => {
          this.held.delete(name)
          this.queues.get(name)?.shift()?.()
        }
        void Promise.resolve(callback({ name, mode: options.mode ?? 'exclusive' })).then(
          (value) => {
            release()
            resolve(value)
          },
          (error) => {
            release()
            reject(error)
          },
        )
      }
      acquire()
    })
  }

  hold(name: string): () => void {
    this.held.add(name)
    let released = false
    return () => {
      if (released) return
      released = true
      this.held.delete(name)
      this.queues.get(name)?.shift()?.()
    }
  }

  queuedCount(name: string): number {
    return this.queues.get(name)?.length ?? 0
  }
}

class LogicalTestLockBackend implements LockBackend {
  readonly kind = 'web-locks' as const
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(
    logicalNames: readonly string[],
    fn: (grant: LockGrant) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const releases: Array<() => void> = []
    for (const name of [...new Set(logicalNames)].sort()) {
      if (options.signal?.aborted) throw options.signal.reason
      const prior = this.tails.get(name) ?? Promise.resolve()
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      this.tails.set(
        name,
        prior.then(() => held),
      )
      await prior
      releases.push(release)
    }
    const grant: LockGrant = {
      kind: this.kind,
      logicalNames,
      runTransaction: (db, tables, transactionFn) =>
        db.transaction(
          'rw',
          tables.map((table) => db.table(typeof table === 'string' ? table : table.name)),
          transactionFn,
        ),
    }
    try {
      return await fn(grant)
    } finally {
      for (const release of releases.reverse()) release()
    }
  }

  async runAuthoritativeCommandSession<T>(
    _database: Dexie,
    operation: (session: AuthoritativeCommandLockSession) => Promise<T> | T,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (options.signal?.aborted) throw options.signal.reason
    const runResourceLocks = <Result>(
      resourceNames: readonly string[],
      child: (grant: LockGrant) => Promise<Result> | Result,
    ) => this.run(resourceNames, child, options)
    let resourceScopeActive = false
    const session: AuthoritativeCommandLockSession = Object.freeze({
      kind: this.kind,
      async withResourceLocks<Result>(
        resourceNames: readonly string[],
        child: (grant: LockGrant) => Promise<Result> | Result,
      ): Promise<Result> {
        if (resourceScopeActive) throw new Error('AuthoritativeCommandNestedResourceLocks')
        if (options.signal?.aborted) throw options.signal.reason
        const normalized = [...new Set(resourceNames)].sort((left, right) =>
          left.localeCompare(right),
        )
        if (normalized.includes('workspace:authoritative') || normalized.includes('db:global')) {
          throw new Error('AuthoritativeCommandGlobalResourceForbidden')
        }
        resourceScopeActive = true
        try {
          return await runResourceLocks(normalized, child)
        } finally {
          resourceScopeActive = false
        }
      },
    })
    return operation(session)
  }
}

function makeProfile(): ConnectionProfile {
  return {
    id: 'prof',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-a',
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

function makeOpenAiProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function makeGoogleNativeProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-google',
    name: 'Google',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function makeLlamaServerProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-llama',
    name: 'llama-server',
    kind: 'llama-server',
    baseUrl: 'http://llama.test/v1',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function requireDefined<T>(value: T | undefined, label: string): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

function chatSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const base = cloneDefaultChatSettings()
  return {
    ...base,
    profileId: 'prof',
    model: 'google/gemini-3.1-flash-lite-preview',
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
    ...overrides,
  }
}

async function reset() {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  useUiStore.getState().reset()
  sessionStorage.clear()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  __setLockBackendForTests(new LogicalTestLockBackend())
  await openBrowserWorkspace()
  closeStreamRecoveryRuntime()
  await installGenerationProfile(makeProfile(), { 'key-a': 'sk-test' })
  await installGenerationProfile(makeOpenAiProfile(), { 'key-a': 'sk-test' })
  await installGenerationProfile(makeGoogleNativeProfile(), { 'key-a': 'sk-test' })
  await installGenerationProfile(makeLlamaServerProfile(), { 'key-a': 'sk-test' })
  await seedOpenRouterDiscovery('prof', [
    'google/gemini-3.1-flash-lite-preview',
    'anthropic/claude-sonnet-4.6',
    'openai/gpt-5.4',
    'openai/gpt-4o',
    'black-forest-labs/flux.2-klein-4b',
  ])
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await shutdownBrowserWorkspace()
  __setLockBackendForTests(null)
  await reset()
})

async function messagesFor(chatId: string): Promise<Message[]> {
  return readTestMessages(chatId)
}

async function message(messageId: string): Promise<Message | undefined> {
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

async function presentationFor(messageId: string) {
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

async function messageHeader(messageId: string) {
  return readTestMessageHeader(messageId)
}

async function streamLeases(chatId?: string) {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'stream.leases', ...(chatId ? { chatId } : {}) },
        { signal: permit.signal },
      )
    ).value
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

async function insertRecoveryLease(input: {
  streamId: string
  chatId: string
  messageId: string
  attemptKind?: 'generation' | 'continuation'
  startedAt?: number
  heartbeatAt?: number
  targetCommittedAt?: number
  canonicalAt?: number
  metadataCommittedAt?: number
  admissionSequence?: number
  continuationStrategy?: 'prompt' | 'prefill'
  baseNodeVersion?: number
  baseBodyVersion?: number
}): Promise<FencedStreamLeaseRow> {
  const startedAt = input.startedAt ?? 100
  const phase: StreamLeaseRow['phase'] =
    input.metadataCommittedAt !== undefined
      ? 'metadata-committed'
      : input.canonicalAt !== undefined
        ? 'canonical'
        : input.targetCommittedAt !== undefined
          ? 'active'
          : 'reserved'
  const common = {
    streamId: input.streamId,
    chatId: input.chatId,
    messageId: input.messageId,
    ownerClientId: `closed:${input.streamId}`,
    fenceToken: `fence:${input.streamId}`,
    replacementEpoch: 0,
    startedAt,
    heartbeatAt: input.heartbeatAt ?? startedAt,
    admissionSequence: input.admissionSequence ?? 1,
    revision: 0,
    phase,
    ...(input.targetCommittedAt === undefined
      ? {}
      : { targetCommittedAt: input.targetCommittedAt }),
    ...(input.canonicalAt === undefined ? {} : { canonicalAt: input.canonicalAt }),
    ...(input.metadataCommittedAt === undefined
      ? {}
      : { metadataCommittedAt: input.metadataCommittedAt }),
    dispatched: input.targetCommittedAt !== undefined,
    continuationStrategy: input.continuationStrategy ?? 'prompt',
    baseNodeVersion: input.baseNodeVersion ?? 1,
    baseBodyVersion: input.baseBodyVersion ?? 1,
    requestedModel: 'openai/gpt-4o',
    apiUsed: 'chat' as const,
    postCommit: { usedAt: startedAt, profileId: makeProfile().id },
  }
  const lease: FencedStreamLeaseRow =
    input.attemptKind === 'continuation'
      ? testContinuationLease(common)
      : testGenerationLease(common)
  await getDb().streamLeases.put(lease)
  return lease
}

async function attachmentBundle(attachmentId: string) {
  return runWorkspaceRead('repository-query', async (permit) => {
    return (
      await getWorkspaceRepository().query(
        permit,
        { kind: 'attachment.bundle', attachmentId },
        { signal: permit.signal },
      )
    ).value
  })
}

async function patchMessageFixture(messageId: string, patch: Partial<Message>): Promise<Message> {
  const presentation = requireDefined(await presentationFor(messageId), 'fixture presentation')
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

async function seedUnfinishedAssistant(chatId: string, startedAt = 100): Promise<string> {
  const existingRoot = (await messagesFor(chatId)).find(
    (candidate) => candidate.parentId === null && !candidate.deleted,
  )
  const target = existingRoot
    ? (
        await executeMessageCommand({
          kind: 'message.insert-sibling',
          input: {
            chatId,
            targetId: existingRoot.id,
            role: 'assistant',
            content: [{ type: 'output_text', text: 'partial' }],
          },
        })
      ).message
    : requireDefined(
        (
          await importMessagesOp({
            chatId,
            slot: { kind: 'at-end' },
            activeLeafId: null,
            messages: [{ role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }],
          })
        ).presentations[0]?.message,
        'unfinished assistant',
      )
  await patchMessageFixture(target.id, {
    generation: {
      id: '',
      model: 'm',
      requestedModel: 'm',
      apiUsed: 'chat',
      delivery: 'streaming',
      costSource: 'stream',
      startedAt,
      reasoningCarryForward: 'unknown',
      reasoningVisibility: { disclosure: 'unknown' },
    },
  })
  return target.id
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < 40; i += 1) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

function repositoryWithQueryLog(
  target: WorkspaceRepository,
  queries: WorkspaceQuery[],
): WorkspaceRepository {
  return {
    query: (permit, query, options) => {
      queries.push(query)
      return target.query(permit, query, options)
    },
    execute: target.execute.bind(target),
    replace: target.replace.bind(target),
    subscribeChanges: target.subscribeChanges.bind(target),
  }
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 500)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function liveMessagesSortedByCreated(messages: Message[]): Message[] {
  return messages.filter((m) => !m.deleted).sort((a, b) => a.createdAt - b.createdAt)
}

async function* stream<T>(...chunks: T[]): AsyncGenerator<T> {
  for (const c of chunks) yield c
}

interface LegacySendInput {
  chatId: string
  connection: ConnectionProfile
  apiKey: string
  content: Message['content']
  prefillContent?: Message['content']
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>
  now?: () => number
  navigationIntent?: unknown
  capabilities?: unknown
}

async function startSendText(input: LegacySendInput): Promise<GenerationHandle> {
  const chat = requireDefined(await getChat(input.chatId), 'send chat')
  const selection = storedSelection(input.chatId)
  const expectedLeafId =
    selection.kind === 'tip' || selection.kind === 'message'
      ? selection.messageId
      : chat.lastUpdatedLeafId
  return startControlledGeneration(
    {
      kind: 'send',
      chatId: input.chatId,
      expectedLeafId,
      content: input.content,
      ...(input.prefillContent ? { prefillContent: input.prefillContent } : {}),
    },
    {
      profile: input.connection,
      keyMaterial:
        input.connection.apiKeyRef && input.apiKey
          ? { [input.connection.apiKeyRef]: input.apiKey }
          : {},
      openStream: input.openStream,
      ...(input.now ? { now: input.now } : {}),
    },
  )
}

async function sendText(input: LegacySendInput): Promise<CompletedGeneration> {
  const handle = await startSendText(input)
  void handle.prepared.catch(() => {})
  return handle.completed
}

function storedSelection(
  chatId: string,
):
  | { kind: 'default' }
  | { kind: 'tip'; messageId: string }
  | { kind: 'message'; messageId: string; observedTipId?: string } {
  const raw = sessionStorage.getItem(`${CONVERSATION_SESSION_PREFIX}${encodeURIComponent(chatId)}`)
  if (!raw) return { kind: 'default' }
  const selection = (JSON.parse(raw) as { selection?: unknown }).selection
  if (
    selection &&
    typeof selection === 'object' &&
    ((selection as { kind?: unknown }).kind === 'tip' ||
      (selection as { kind?: unknown }).kind === 'message') &&
    typeof (selection as { messageId?: unknown }).messageId === 'string'
  ) {
    return selection as
      | { kind: 'tip'; messageId: string }
      | { kind: 'message'; messageId: string; observedTipId?: string }
  }
  return { kind: 'default' }
}

async function __flushPostCommitCalibrationForTests(): Promise<void> {}

function patternedChunks(prefix: string, length: number, chunkChars: number): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < length; offset += chunkChars) {
    const size = Math.min(chunkChars, length - offset)
    const marker = `<${prefix}:${offset}>`
    chunks.push(`${marker}${prefix.repeat(size)}`.slice(0, size))
  }
  return chunks
}

async function seedOpenRouterDiscovery(
  profileId: string,
  models: readonly string[],
): Promise<void> {
  for (const modelId of models) {
    await putCachedEndpoints(profileId, modelId, {
      id: modelId,
      endpoints: [
        {
          provider_name: 'Test Clean',
          provider_slug: 'test-clean',
          supported_parameters: ['temperature', 'reasoning'],
          context_length: 200000,
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
    await putCachedPrivacyPolicy(profileId, modelId, {
      policies: {
        'Test Clean': {
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
  }
}

describe('sendText — chat-completions streaming', () => {
  it('keeps an explicitly detached background send from reclaiming tab navigation', async () => {
    const backgroundChat = await createChat({ settings: chatSettings() })
    const visibleChat = await createChat({ settings: chatSettings() })
    const visibleSeed = await importMessagesOp({
      chatId: visibleChat.id,
      slot: { kind: 'at-end' },
      activeLeafId: null,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'visible message' }] }],
    })
    const visibleMessageId = requireDefined(
      visibleSeed.insertedTailId ?? undefined,
      'visible message',
    )
    navigateConversationMessage(visibleChat.id, visibleMessageId)
    const visibleSelection = storedSelection(visibleChat.id)

    const result = await sendText({
      chatId: backgroundChat.id,
      navigationIntent: null,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'finish in the background' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'detached-generation',
            choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
          },
        } satisfies ChatStreamChunk),
    })

    expect(result.outcome).toBe('done')
    expect(await messagesFor(backgroundChat.id)).toHaveLength(2)
    expect(storedSelection(visibleChat.id)).toEqual(visibleSelection)
    expect(storedSelection(backgroundChat.id)).toEqual({
      kind: 'tip',
      messageId: result.assistantMessageId,
    })
  })

  it('persists the user row while Stop can still abort template preflight before the stream opens', async () => {
    const chat = await createChat({
      settings: chatSettings({
        profileId: 'prof-llama',
        model: 'local-model',
        protocol: 'text',
        textTemplate: 'default',
      }),
    })
    let markTemplateStarted!: () => void
    const templateStarted = new Promise<void>((resolve) => {
      markTemplateStarted = resolve
    })
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      markTemplateStarted()
      const signal = init?.signal
      return new Promise<Response>((resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted) {
          rejectAbort()
          return
        }
        signal?.addEventListener('abort', rejectAbort, { once: true })
        void resolve
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const notOpenedChunk: ChatStreamChunk = {
      type: 'delta',
      chunk: {
        id: 'should-not-open',
        choices: [{ delta: { content: 'nope' }, finish_reason: 'stop' }],
      },
    }
    const openStream = vi.fn(() => stream(notOpenedChunk))

    const handle = await startSendText({
      chatId: chat.id,
      connection: makeLlamaServerProfile(),
      apiKey: '',
      content: [{ type: 'text', text: 'hello' }],
      openStream,
    })
    await templateStarted

    const active = attemptController.listChatExecutions(chat.id)
    expect(active).toHaveLength(1)
    expect(active[0]?.messageId).toBeTypeOf('string')
    expect(active[0]).toMatchObject({
      kind: 'generation',
    })
    const midMessages = liveMessagesSortedByCreated(await messagesFor(chat.id))
    expect(midMessages).toHaveLength(2)
    expect(midMessages.find((message) => message.role === 'user')).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
    expect(midMessages.find((message) => message.role === 'assistant')).toMatchObject({
      role: 'assistant',
      content: [],
    })
    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'abort' })
    expect(openStream).not.toHaveBeenCalled()
    expect(attemptController.listChatExecutions(chat.id)).toEqual([])
    expect(liveMessagesSortedByCreated(await messagesFor(chat.id))).toHaveLength(2)
  })

  it('persists a huge OpenRouter user row before cold provider discovery resolves', async () => {
    const profile: ConnectionProfile = {
      ...makeProfile(),
      id: 'prof-cold',
      apiKeyRef: 'key-cold',
    }
    const chat = await createChat({
      settings: chatSettings({
        profileId: profile.id,
        model: 'openai/gpt-4o',
      }),
    })
    const hugeText = `long-start ${'x'.repeat(512 * 1024)} long-end`
    let markDiscoveryStarted!: () => void
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve
    })
    let discoverySawUser = false
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      discoverySawUser = liveMessagesSortedByCreated(await messagesFor(chat.id)).some((message) => {
        const item = message.content[0]
        return (
          message.role === 'user' &&
          item?.type === 'text' &&
          item.text.length === hugeText.length &&
          item.text.startsWith('long-start') &&
          item.text.endsWith('long-end')
        )
      })
      markDiscoveryStarted()
      const signal = init?.signal ?? (url instanceof Request ? url.signal : undefined)
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted) {
          rejectAbort()
          return
        }
        signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const openStream = vi.fn(() =>
      stream<ChatStreamChunk>({
        type: 'delta',
        chunk: {
          id: 'should-not-open',
          choices: [{ delta: { content: 'nope' }, finish_reason: 'stop' }],
        },
      }),
    )

    const handle = await startSendText({
      chatId: chat.id,
      connection: profile,
      apiKey: 'sk-test',
      content: [{ type: 'text', text: hugeText }],
      openStream,
    })
    await discoveryStarted

    expect(discoverySawUser).toBe(true)
    const midMessages = liveMessagesSortedByCreated(await messagesFor(chat.id))
    expect(midMessages).toHaveLength(2)
    const pendingUser = midMessages.find((message) => message.role === 'user')
    expect(pendingUser?.role).toBe('user')
    const item = pendingUser?.content[0]
    expect(item?.type).toBe('text')
    expect(item?.type === 'text' ? item.text.length : 0).toBe(hugeText.length)
    expect(openStream).not.toHaveBeenCalled()

    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'abort' })
  })

  it('creates the assistant placeholder before a slow stream yields its first chunk', async () => {
    const chat = await createChat({ settings: chatSettings() })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markOpened!: () => void
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve
    })

    const handle = await startSendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'slow start' }],
      openStream: () =>
        (async function* () {
          markOpened()
          await gate
          const chunk: ChatStreamChunk = {
            type: 'delta',
            chunk: {
              id: 'gen-slow-start',
              choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }],
            },
          }
          yield chunk
        })(),
    })
    await opened

    const midMessages = liveMessagesSortedByCreated(await messagesFor(chat.id))
    expect(new Set(midMessages.map((message) => message.role))).toEqual(
      new Set(['user', 'assistant']),
    )
    const user = requireDefined(
      midMessages.find((message) => message.role === 'user'),
      'user row',
    )
    const assistant = requireDefined(
      midMessages.find((message) => message.role === 'assistant'),
      'assistant row',
    )
    expect(user.content).toEqual([{ type: 'text', text: 'slow start' }])
    expect(assistant.parentId).toBe(user.id)
    expect(assistant.content).toEqual([])
    expect(attemptController.getTargetSnapshot(chat.id, assistant.id).execution?.messageId).toBe(
      assistant.id,
    )
    expect(storedSelection(chat.id)).toEqual({ kind: 'tip', messageId: assistant.id })

    release()
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
  })

  it('persists user message + assistant text; writes generation metadata', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              id: 'gen-x',
              model: 'google/gemini-3.1-flash-lite-preview',
              choices: [{ delta: { content: 'Hi ' } }],
            },
          },
          { type: 'delta', chunk: { choices: [{ delta: { content: 'there' } }] } },
          {
            type: 'delta',
            chunk: {
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.0001 },
            },
          },
        ),
      now: () => 1000,
    })
    expect(result.outcome).toBe('done')
    const all = liveMessagesSortedByCreated(await messagesFor(chat.id))
    expect(all).toHaveLength(2)
    const user = requireDefined(
      all.find((row) => row.role === 'user'),
      'user',
    )
    const assistant = requireDefined(
      all.find((row) => row.role === 'assistant'),
      'assistant',
    )
    expect(user.role).toBe('user')
    expect(user.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(assistant.role).toBe('assistant')
    expect(assistant.parentId).toBe(user.id)
    expect(assistant.content).toEqual([{ type: 'output_text', text: 'Hi there' }])
    expect(assistant.generation?.id).toBe('gen-x')
    expect(assistant.generation?.model).toBe('google/gemini-3.1-flash-lite-preview')
    expect(assistant.generation?.usage?.total_tokens).toBe(5)
    expect(assistant.generation?.cost).toBeCloseTo(0.0001)
    expect(assistant.generation?.finishReason).toBe('stop')
    expect(assistant.generation?.finishedAt).toBe(1000)
    expect(assistant.generation?.abortReason).toBeUndefined()
  })

  it('persists streamed tool-call metadata and all argument chunks on the assistant row', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'look it up' }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call-streamed',
                        type: 'function',
                        function: { name: 'lookup', arguments: '{"query":' },
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
                  delta: {
                    tool_calls: [{ index: 0, function: { arguments: '"natter"}' } }],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          },
        ),
      now: () => 1_000,
    })

    const assistant = requireDefined(await message(result.assistantMessageId), 'assistant message')
    expect(assistant.toolCalls).toEqual([
      {
        id: 'call-streamed',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"natter"}' },
      },
    ])
  })

  it('computes assistant sibling indices from headers including tombstones', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const seeded = await importMessagesOp({
      chatId: chat.id,
      slot: { kind: 'at-end' },
      activeLeafId: null,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'parent' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'sibling 0' }] },
      ],
    })
    requireDefined(seeded.presentations[0]?.message, 'parent')
    const firstSibling = requireDefined(seeded.presentations[1]?.message, 'first sibling')
    const siblingIds = new Set([firstSibling.id])
    let highestSiblingId = firstSibling.id
    for (let index = 1; index <= 7; index += 1) {
      const inserted = await executeMessageCommand({
        kind: 'message.insert-sibling',
        input: {
          chatId: chat.id,
          targetId: firstSibling.id,
          role: 'assistant',
          content: [{ type: 'output_text', text: `sibling ${index}` }],
        },
      })
      siblingIds.add(inserted.messageId)
      highestSiblingId = inserted.messageId
    }
    await executeMessageCommand({
      kind: 'message.delete',
      mode: 'single',
      input: {
        chatId: chat.id,
        messageId: highestSiblingId,
        activeLeafId: highestSiblingId,
      },
    })

    const bodyReads = vi.spyOn(getDb().messageBodies, 'bulkGet')
    const handle = await startControlledGeneration(
      {
        kind: 'regenerate',
        chatId: chat.id,
        targetAssistantId: firstSibling.id,
      },
      {
        profile: makeProfile(),
        keyMaterial: { 'key-a': 'sk-test' },
        openStream: (open) => {
          expect(attemptController.get(open.diagnosticId)).toMatchObject({
            kind: 'generation',
            chatId: chat.id,
          })
          return stream({
            type: 'delta',
            chunk: {
              id: 'gen-header-only-siblings',
              choices: [{ delta: { content: 'new sibling' }, finish_reason: 'stop' }],
            },
          })
        },
        now: () => 1000,
      },
    )
    void handle.prepared.catch(() => {})
    const result = await handle.completed

    expect(
      bodyReads.mock.calls.some(
        ([ids]) => ids.length === siblingIds.size && ids.every((id) => siblingIds.has(String(id))),
      ),
    ).toBe(false)
    bodyReads.mockRestore()

    const assistant = await message(result.assistantMessageId)
    expect(assistant?.siblingIndex).toBe(8)
  })

  it('streams 100k reasoning and 100k completion in small chunks without per-chunk body rewrites', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const targetChars = 100_000
    const reasoningChars = 100_000
    const chunkChars = 128
    const textChunks = patternedChunks('t', targetChars, chunkChars)
    const reasoningChunks = patternedChunks('r', reasoningChars, chunkChars)
    const expectedText = textChunks.join('')
    const expectedReasoning = reasoningChunks.join('')
    let clock = 1000
    async function* longStream(): AsyncGenerator<ChatStreamChunk> {
      for (let index = 0; index < reasoningChunks.length; index += 1) {
        const offset = index * chunkChars
        yield {
          type: 'delta',
          chunk: {
            id: `reason-${offset}`,
            model: 'google/gemini-3.1-flash-lite-preview',
            choices: [{ delta: { reasoning: reasoningChunks[index] ?? '' } }],
          },
        }
      }
      for (let index = 0; index < textChunks.length; index += 1) {
        const offset = index * chunkChars
        yield {
          type: 'delta',
          chunk: {
            id: `text-${offset}`,
            model: 'google/gemini-3.1-flash-lite-preview',
            choices: [{ delta: { content: textChunks[index] ?? '' } }],
          },
        }
      }
      yield {
        type: 'delta',
        chunk: {
          id: 'done',
          model: 'google/gemini-3.1-flash-lite-preview',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 4,
            completion_tokens: Math.ceil(targetChars / 4),
            completion_tokens_details: { reasoning_tokens: Math.ceil(reasoningChars / 4) },
            total_tokens: 4 + Math.ceil((targetChars + reasoningChars) / 4),
          },
        },
      }
    }

    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'stress stream' }],
      openStream: longStream,
      now: () => ++clock,
    })

    expect(result.outcome).toBe('done')
    expect(attemptController.get(result.streamId)).toBeUndefined()
    const assistant = requireDefined(await message(result.assistantMessageId), 'assistant message')
    expect(assistant.content).toEqual([{ type: 'output_text', text: expectedText }])
    expect(assistant.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'summary', text: expectedReasoning }),
    ])
    const header = requireDefined(
      await messageHeader(result.assistantMessageId),
      'assistant header',
    )
    expect(header.nodeVersion).toBeLessThanOrEqual(6)
  }, 15_000)

  it('publishes large live text as bounded sections and stores one final text item', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const first = 'a'.repeat(20_000)
    const second = 'b'.repeat(5_000)
    let clock = 1000
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let pause!: () => void
    const paused = new Promise<void>((resolve) => {
      pause = resolve
    })
    async function* longStream(): AsyncGenerator<ChatStreamChunk> {
      yield {
        type: 'delta',
        chunk: {
          id: 'large-live-1',
          model: 'google/gemini-3.1-flash-lite-preview',
          choices: [{ delta: { content: first } }],
        },
      }
      yield {
        type: 'delta',
        chunk: {
          id: 'large-live-2',
          model: 'google/gemini-3.1-flash-lite-preview',
          choices: [{ delta: { content: second } }],
        },
      }
      pause()
      await blocked
      yield {
        type: 'delta',
        chunk: {
          id: 'large-live-done',
          model: 'google/gemini-3.1-flash-lite-preview',
          choices: [{ delta: {}, finish_reason: 'stop' }],
        },
      }
    }
    const handle = await startSendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'large live sections' }],
      openStream: longStream,
      now: () => ++clock,
    })
    const prepared = await handle.prepared
    await paused
    const stopDemand = attemptController.subscribeTarget(
      chat.id,
      prepared.assistantMessageId,
      () => undefined,
    )
    await eventually(() => {
      const live = attemptController.getTargetSnapshot(
        chat.id,
        prepared.assistantMessageId,
      ).liveProjection
      expect(live?.content).toEqual([
        { type: 'output_text', text: first },
        { type: 'output_text', text: second },
      ])
    })
    release()
    const result = await handle.completed
    stopDemand()
    const assistant = requireDefined(await message(result.assistantMessageId), 'assistant message')
    expect(assistant.content).toEqual([{ type: 'output_text', text: `${first}${second}` }])
  })

  it('sends assistant prefill through the unified request plan and stores the continuation below it', async () => {
    const chat = await createChat({
      settings: chatSettings({
        reasoning: {
          mode: 'default',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
    })
    let seenWire: Record<string, unknown> | undefined
    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'write the opener' }],
      prefillContent: [{ type: 'text', text: 'Chapter' }],
      capabilities: { supportedParameters: ['reasoning'], streaming: 'supported' },
      openStream: (open) => {
        seenWire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'gen-prefill',
            model: 'google/gemini-3.1-flash-lite-preview',
            choices: [{ delta: { content: ' One' }, finish_reason: 'stop' }],
          },
        })
      },
      now: () => 1000,
    })

    expect(result.outcome).toBe('done')
    expect(seenWire?.messages).toEqual([
      { role: 'user', content: 'write the opener' },
      { role: 'assistant', content: 'Chapter' },
    ])
    expect(seenWire?.reasoning).toBeUndefined()
    const all = await messagesFor(chat.id)
    const user = requireDefined(
      all.find((m) => m.role === 'user' && m.origin === 'user'),
      'user message',
    )
    const assistant = requireDefined(
      all.find((m) => m.role === 'assistant' && m.origin === 'generated'),
      'assistant continuation',
    )
    expect(all.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(assistant.parentId).toBe(user.id)
    expect(assistant.content).toEqual([{ type: 'output_text', text: 'Chapter One' }])
    expect((await getChat(chat.id))?.settings.reasoning.mode).toBe('default')
  })

  it('does not auto-configure toggleable OSS prefill during request planning', async () => {
    await seedOpenRouterDiscovery('prof', ['z-ai/glm-5.1'])
    const chat = await createChat({
      settings: chatSettings({
        model: 'z-ai/glm-5.1',
        reasoning: {
          mode: 'default',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
    })
    let seenWire: Record<string, unknown> | undefined
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'write the opener' }],
      prefillContent: [{ type: 'text', text: 'Chapter' }],
      openStream: (open) => {
        seenWire = open.requestPlan.wire
        return stream({
          type: 'delta',
          chunk: {
            id: 'gen-prefill-oss',
            model: 'z-ai/glm-5.1',
            choices: [{ delta: { content: ' One' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire?.messages).toEqual([
      { role: 'user', content: 'write the opener' },
      { role: 'assistant', content: 'Chapter' },
    ])
    expect(seenWire?.reasoning).toBeUndefined()
    expect(
      (seenWire as { provider?: { only?: string[] } } | undefined)?.provider?.only,
    ).toBeUndefined()
    const storedChat = await getChat(chat.id)
    expect(storedChat?.settings.reasoning.mode).toBe('default')
    expect(storedChat?.settings.providerPrefs?.only).toBeUndefined()
    const all = await messagesFor(chat.id)
    expect(all.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(all.find((m) => m.role === 'assistant')?.content).toEqual([
      { type: 'output_text', text: 'Chapter One' },
    ])
  })

  it('keeps a failed prefill request on the single generated assistant row', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'write the opener' }],
      prefillContent: [{ type: 'text', text: 'Chapter' }],
      openStream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new ApiError({
              kind: 'bad_request',
              httpStatus: 400,
              code: 400,
              message: 'Reasoning is mandatory for this endpoint and cannot be disabled',
              midStream: false,
              retryable: false,
            })
          },
        }),
      }),
    })

    expect(result.outcome).toBe('error')
    const all = await messagesFor(chat.id)
    const assistantRows = all.filter((m) => m.role === 'assistant')
    expect(assistantRows).toHaveLength(1)
    expect(assistantRows[0]?.origin).toBe('generated')
    expect(assistantRows[0]?.content).toEqual([{ type: 'output_text', text: 'Chapter' }])
    expect(assistantRows[0]?.generation?.error?.message).toBe(
      'Reasoning is mandatory for this endpoint and cannot be disabled',
    )
  })

  it('honors a user-pinned Responses route instead of silently using chat-completions', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'openai/gpt-5.4', api: 'responses' }),
    })
    let seenWire: Record<string, unknown> | undefined
    let seenRouteKind: string | undefined
    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: (open) => {
        seenWire = open.requestPlan.wire
        seenRouteKind = open.requestPlan.kind
        return stream(
          {
            type: 'event',
            event: {
              type: 'response.created',
              response: { id: 'resp_1', model: 'openai/gpt-5.4', status: 'in_progress' },
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: 'Hi there',
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.completed',
              response: {
                id: 'resp_1',
                model: 'openai/gpt-5.4',
                status: 'completed',
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              },
            },
          },
        )
      },
      now: () => 1000,
    })
    expect(result.outcome).toBe('done')
    expect(seenRouteKind).toBe('responses')
    expect(seenWire).toMatchObject({
      model: 'openai/gpt-5.4',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    })
    expect(seenWire).not.toHaveProperty('messages')
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'Hi there' }])
    expect(assistant?.generation?.apiUsed).toBe('responses')
    expect(assistant?.generation?.id).toBe('resp_1')
  })

  it('uses Responses on OpenAI direct when chat settings select Responses', async () => {
    const chat = await createChat({
      settings: chatSettings({
        profileId: makeOpenAiProfile().id,
        model: 'gpt-4o',
        api: 'responses',
      }),
    })
    let seenRouteKind: string | undefined
    let seenWire: Record<string, unknown> | undefined
    const result = await sendText({
      chatId: chat.id,
      connection: makeOpenAiProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: (open) => {
        seenRouteKind = open.requestPlan.kind
        seenWire = open.requestPlan.wire
        return stream(
          {
            type: 'event',
            event: {
              type: 'response.created',
              response: { id: 'resp_oa', model: 'gpt-4o', status: 'in_progress' },
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: 'hi',
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.completed',
              response: {
                id: 'resp_oa',
                model: 'gpt-4o',
                status: 'completed',
                usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
              },
            },
          },
        )
      },
    })
    expect(result.outcome).toBe('done')
    expect(seenRouteKind).toBe('responses')
    expect(seenWire).toHaveProperty('input')
    expect(seenWire).not.toHaveProperty('messages')
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.generation?.apiUsed).toBe('responses')
  })

  it('uses Gemini native on official Google profiles instead of chat-completions', async () => {
    const chat = await createChat({
      settings: chatSettings({
        profileId: makeGoogleNativeProfile().id,
        model: 'google/gemini-3.1-flash-lite-preview',
        api: 'auto',
      }),
    })
    let seenRouteKind: string | undefined
    let seenWire: Record<string, unknown> | undefined
    let seenGeminiModelId: string | undefined
    const result = await sendText({
      chatId: chat.id,
      connection: makeGoogleNativeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: (open) => {
        seenRouteKind = open.requestPlan.kind
        seenWire = open.requestPlan.wire
        seenGeminiModelId = open.requestPlan.geminiModelId
        return stream({
          type: 'chunk',
          chunk: {
            responseId: 'gem_1',
            modelVersion: 'gemini-3.1-flash-lite-preview',
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'hi' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 2,
              candidatesTokenCount: 1,
              totalTokenCount: 3,
            },
          },
        })
      },
    })
    expect(result.outcome).toBe('done')
    expect(seenRouteKind).toBe('gemini-generate')
    expect(seenGeminiModelId).toBe('gemini-3.1-flash-lite-preview')
    expect(seenWire).toHaveProperty('contents')
    expect(seenWire).not.toHaveProperty('messages')
    expect(seenWire).not.toHaveProperty('input')
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.generation?.apiUsed).toBe('gemini-native')
    expect(assistant?.generation?.model).toBe('gemini-3.1-flash-lite-preview')
  })

  it('mid-stream error preserves received tokens and writes error metadata', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'test' }],
      openStream: () =>
        stream(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'Partial ' } }] } },
          { type: 'delta', chunk: { choices: [{ delta: { content: 'answer' } }] } },
          {
            type: 'delta',
            chunk: {
              error: { code: 429, message: 'rate limited' },
              choices: [{ finish_reason: 'error' }],
            },
          },
        ),
    })
    expect(result.outcome).toBe('error')
    expect(result.error).toBeInstanceOf(ApiError)
    expect(result.error?.kind).toBe('rate_limited')
    const messages = liveMessagesSortedByCreated(await messagesFor(chat.id))
    const assistant = requireDefined(
      messages.find((row) => row.role === 'assistant'),
      'assistant',
    )
    expect(assistant.content).toEqual([{ type: 'output_text', text: 'Partial answer' }])
    expect(assistant.generation?.error?.code).toBe('429')
    expect(assistant.generation?.error?.message).toBe('rate limited')
    expect(assistant.generation?.finishedAt).toBeDefined()
  })

  it('user abort persists partial content with abortReason="user"', async () => {
    const chat = await createChat({ settings: chatSettings() })
    let producedChunks = 0
    let markPaused!: () => void
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve
    })
    const handle = await startSendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'slow please' }],
      openStream: ({ signal }) =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'slow ' } }] },
          }
          producedChunks += 1
          markPaused()
          await new Promise<void>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
            signal.addEventListener('abort', onAbort, { once: true })
            if (signal.aborted) onAbort()
          })
        })(),
    })
    await paused
    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    const result = await handle.completed
    expect(producedChunks).toBe(1)
    expect(result.outcome).toBe('abort')
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'slow ' }])
    expect(assistant?.generation?.abortReason).toBe('user')
    expect(assistant?.generation?.finishedAt).toBeDefined()
  })

  it('keeps user abort classified as user when the transport throws a generic network error', async () => {
    const chat = await createChat({ settings: chatSettings() })
    let markPaused!: () => void
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve
    })
    let releaseNetworkError!: () => void
    const networkError = new Promise<void>((resolve) => {
      releaseNetworkError = resolve
    })
    const handle = await startSendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'slow please' }],
      openStream: () =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { id: 'gen-live-shape', choices: [{ delta: { content: 'slow ' } }] },
          }
          markPaused()
          await networkError
          throw new ApiError({
            kind: 'network',
            code: 'NETWORK',
            message: 'terminated',
            midStream: false,
            retryable: true,
          })
        })(),
    })
    await paused
    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    releaseNetworkError()
    const result = await handle.completed
    expect(result.outcome).toBe('abort')
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.generation?.id).toBe('gen-live-shape')
    expect(assistant?.generation?.abortReason).toBe('user')
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'slow ' }])
  })

  it('keeps chat summary frozen until the stream finishes', async () => {
    const chat = await createChat({ settings: chatSettings() })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let markPaused!: () => void
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve
    })
    let tick = 0

    const sendPromise = sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello world' }],
      openStream: () =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'Partial ' } }] },
          }
          markPaused()
          await gate
          yield {
            type: 'delta',
            chunk: {
              choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.0002 },
            },
          }
        })(),
      now: () => {
        tick += 250
        return tick
      },
    })

    await paused

    const midChat = await getChat(chat.id)
    const midAssistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(midAssistant?.content).toEqual([])
    expect(midChat?.wordCount).toBe(2)
    expect(midChat?.totalCostUsd).toBe(0)

    release()

    const result = await sendPromise
    expect(result.outcome).toBe('done')

    const afterChat = await getChat(chat.id)
    const afterAssistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(afterAssistant?.content).toEqual([{ type: 'output_text', text: 'Partial answer' }])
    expect(afterChat?.summaryVersion).toBe((midChat?.summaryVersion ?? 0) + 1)
    expect(afterChat?.wordCount).toBe(4)
    expect(afterChat?.totalCostUsd).toBeCloseTo(0.0002)
  })

  it('continues streaming when this tab or another tab views a different branch', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const seeded = await importMessagesOp({
      chatId: chat.id,
      slot: { kind: 'at-end' },
      activeLeafId: null,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'root' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'left' }] },
      ],
    })
    requireDefined(seeded.presentations[0]?.message, 'root')
    const left = requireDefined(seeded.presentations[1]?.message, 'left')
    const right = await executeMessageCommand({
      kind: 'message.insert-sibling',
      input: {
        chatId: chat.id,
        targetId: left.id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'right' }],
      },
    })
    navigateConversationMessage(chat.id, left.id)

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let releaseCompletion!: () => void
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve
    })
    let markPaused!: () => void
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve
    })
    let markOffBranchDeltaProcessed!: () => void
    const offBranchDeltaProcessed = new Promise<void>((resolve) => {
      markOffBranchDeltaProcessed = resolve
    })
    let tick = 0
    const handle = await startSendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'continue left' }],
      openStream: () =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'Partial ' } }] },
          }
          markPaused()
          await gate
          yield {
            type: 'delta',
            chunk: {
              choices: [{ delta: { content: 'answer' } }],
            },
          }
          markOffBranchDeltaProcessed()
          await completionGate
          yield {
            type: 'delta',
            chunk: {
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            },
          }
        })(),
      now: () => {
        tick += 250
        return tick
      },
    })
    const prepared = await handle.prepared
    await paused
    const stopDemand = attemptController.subscribeTarget(
      chat.id,
      prepared.assistantMessageId,
      () => undefined,
    )
    await eventually(() => {
      expect(
        attemptController.getTargetSnapshot(chat.id, prepared.assistantMessageId).liveProjection,
      ).toBeDefined()
    })
    const retainedBeforeBranchChange = attemptController.getTargetSnapshot(
      chat.id,
      prepared.assistantMessageId,
    ).liveProjection
    expect(retainedBeforeBranchChange?.content).toEqual([{ type: 'output_text', text: 'Partial ' }])

    navigateConversationMessage(chat.id, right.messageId)
    stopDemand()
    expect(attemptController.get(handle.streamId)).toBeDefined()
    expect(storedSelection(chat.id)).toMatchObject({ messageId: right.messageId })

    release()
    await offBranchDeltaProcessed
    expect(
      attemptController.getTargetSnapshot(chat.id, prepared.assistantMessageId).liveProjection,
    ).toBeUndefined()
    releaseCompletion()
    const result = await handle.completed
    expect(result.outcome).toBe('done')
    const assistant = await message(result.assistantMessageId)
    expect(assistant?.parentId).toBe(result.userMessageId)
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'Partial answer' }])
    expect(storedSelection(chat.id)).toMatchObject({ messageId: right.messageId })
  })

  it('keeps live projection visible while an unrelated delayed route action is pending', async () => {
    const chat = await createChat({ settings: chatSettings() })
    let releaseSecond!: () => void
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    let releaseDone!: () => void
    const doneGate = new Promise<void>((resolve) => {
      releaseDone = resolve
    })
    let markFirst!: () => void
    const firstPublished = new Promise<void>((resolve) => {
      markFirst = resolve
    })
    let markSecond!: () => void
    const secondPublished = new Promise<void>((resolve) => {
      markSecond = resolve
    })
    const handle = await startSendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'keep showing this stream' }],
      openStream: () =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'still ' } }] },
          }
          markFirst()
          await secondGate
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'visible' } }] },
          }
          markSecond()
          await doneGate
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] },
          }
        })(),
    })
    const prepared = await handle.prepared
    await firstPublished
    const stopDemand = attemptController.subscribeTarget(
      chat.id,
      prepared.assistantMessageId,
      () => undefined,
    )
    await eventually(() => {
      expect(
        attemptController.getTargetSnapshot(chat.id, prepared.assistantMessageId).liveProjection
          ?.content,
      ).toEqual([{ type: 'output_text', text: 'still ' }])
    })

    beginRouteIntent()
    releaseSecond()
    await secondPublished
    await eventually(() => {
      expect(
        attemptController.getTargetSnapshot(chat.id, prepared.assistantMessageId).liveProjection
          ?.content,
      ).toEqual([{ type: 'output_text', text: 'still visible' }])
    })

    releaseDone()
    expect((await handle.completed).outcome).toBe('done')
    stopDemand()
  })

  it('releases the stream store entry on completion', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const before = attemptController.listRecords().length
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hi' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'g',
            choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
          },
        }),
    })
    const after = attemptController.listRecords().length
    expect(after).toBe(before)
    expect(await streamLeases(chat.id)).toEqual([])
  })

  it('dedupes mirrored reasoning payloads and stores separate reasoning timing', async () => {
    const chat = await createChat({ settings: chatSettings() })
    let tick = 1_000
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'reason carefully' }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning: 'Let',
                    reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'Let' }],
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
                  delta: {
                    reasoning: ' me',
                    reasoning_details: [{ type: 'reasoning.text', index: 0, text: ' me' }],
                    content: 'answer',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
            },
          },
        ),
      now: () => {
        tick += 10
        return tick
      },
    })
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'summary', text: 'Let me' }),
    ])
    expect(assistant?.generation?.reasoningStartedAt).toBeDefined()
    expect(assistant?.generation?.firstTextAt).toBeDefined()
    expect(assistant?.generation?.finishedAt).toBeDefined()
    expect(
      (assistant?.generation?.firstTextAt ?? 0) > (assistant?.generation?.reasoningStartedAt ?? 0),
    ).toBe(true)
    expect(
      (assistant?.generation?.finishedAt ?? 0) >= (assistant?.generation?.firstTextAt ?? 0),
    ).toBe(true)
  })

  it('preserves both reasoning.summary (relabeled from text) and reasoning.encrypted at same index (Gemini via OpenRouter)', async () => {
    // Regression: OpenRouter's Gemini chat-completions stream emits BOTH
    // `reasoning.text` (actually a summary — Gemini 3 never emits raw CoT)
    // AND `reasoning.encrypted` (the thoughtSignature carrier) at `index: 0`
    // in the SAME stream. The on-ingest normalizer relabels the `.text`
    // entry with format `google-gemini-v1` (and no `.signature`) to
    // `.summary` so downstream Include-controls gate correctly. Live-probed
    // 2026-04-20.
    const chat = await createChat({ settings: chatSettings() })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'think carefully' }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning: '**Planning**\nI will solve step by step.',
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        index: 0,
                        format: 'google-gemini-v1',
                        text: '**Planning**\nI will solve step by step.',
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
                  delta: {
                    content: 'The answer is 9 + 10 + 11 = 30.',
                    reasoning_details: [
                      {
                        type: 'reasoning.encrypted',
                        index: 0,
                        format: 'google-gemini-v1',
                        data: 'sig-b64-blob',
                      },
                    ],
                  },
                  finish_reason: 'stop',
                },
              ],
            },
          },
        ),
    })
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({
        kind: 'summary',
        text: '**Planning**\nI will solve step by step.',
      }),
    ])
    expect(assistant?.reasoningEnvelope?.carriers).toEqual([
      expect.objectContaining({
        kind: 'gemini-thought-signature',
        data: 'sig-b64-blob',
      }),
    ])
  })

  it('coalesces multiple Gemini summary parts into one row with a separator', async () => {
    // Regression: OR repackages Gemini 3's multi-part thought summaries as
    // `reasoning.text` entries all pinned at `index: 0`. Before the fix,
    // `shareIdentity` matched them by index and the second summary merged
    // into (and effectively overwrote) the first — the user watched later
    // reasoning blocks replace earlier ones as the stream progressed.
    const chat = await createChat({ settings: chatSettings() })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'think' }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        index: 0,
                        format: 'google-gemini-v1',
                        text: 'First thought: enumerate options.',
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
                  delta: {
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        index: 0,
                        format: 'google-gemini-v1',
                        text: 'Second thought: pick the best.',
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
              choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }],
            },
          },
        ),
    })
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    const summaries = (assistant?.reasoningEnvelope?.visible ?? []).filter(
      (part) => part.kind === 'summary',
    )
    // Coalesce: both Gemini-family summary parts merge into ONE row with a
    // `\n\n` separator. The UI renders one continuous Summary block instead
    // of one block per section. See `findMergeTargetIndex` + `mergeReasoningDetail`
    // in `core/reasoning.ts`.
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.text).toBe(
      'First thought: enumerate options.\n\nSecond thought: pick the best.',
    )
  })

  it('uses cumulative structured reasoning instead of re-appending its scalar mirror', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'anthropic/claude-sonnet-4.6' }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'reason carefully' }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning: 'A ratio',
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        index: 0,
                        format: 'anthropic-claude-v1',
                        text: 'A ratio',
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
                  delta: {
                    reasoning: ' of Gaussians',
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        index: 0,
                        format: 'anthropic-claude-v1',
                        text: 'A ratio of Gaussians',
                      },
                    ],
                  },
                  finish_reason: 'stop',
                },
              ],
            },
          },
        ),
    })
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'text', text: 'A ratio of Gaussians' }),
    ])
  })

  it('keeps one Claude reasoning path when legacy deltas mirror cumulative signed details', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'anthropic/claude-sonnet-4.6' }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'reason carefully' }],
      openStream: () =>
        stream(
          ...['1 ', '2 ', '3 ', '4'].map((reasoning, index, parts) => ({
            type: 'delta' as const,
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning,
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        index: 0,
                        format: 'anthropic-claude-v1',
                        text: parts.slice(0, index + 1).join(''),
                        signature: `sig-${index}`,
                      },
                    ],
                  },
                  ...(index === parts.length - 1 ? { finish_reason: 'stop' } : {}),
                },
              ],
            },
          })),
        ),
    })

    const assistant = (await messagesFor(chat.id)).find((message) => message.role === 'assistant')
    expect(assistant?.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'text', text: '1 2 3 4' }),
    ])
    expect(assistant?.reasoningEnvelope?.carriers).toEqual([
      expect.objectContaining({
        kind: 'anthropic-signature',
        signature: 'sig-3',
      }),
    ])
  })

  it('collapses copied OpenRouter GPT-5.4-style summary fragments into one summary row on chat-completions', async () => {
    const chat = await createChat({
      settings: chatSettings({
        model: 'openai/gpt-5.4',
        api: 'chat',
        reasoning: {
          mode: 'effort',
          effort: 'xhigh',
          exclude: false,
          summary: 'auto',
          include: { encrypted: true, summary: false, text: false },
        },
      }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'Are most CJK characters 1 token in tokenizers?' }],
      openStream: (open) => {
        expect(open.requestPlan.kind).toBe('chat-completions')
        expect(open.requestPlan.reasoning.inboundVisibility).toEqual({
          disclosure: 'visible',
          visibleKind: 'summary',
        })
        expect(open.requestPlan.wire).toMatchObject({
          model: 'openai/gpt-5.4',
          reasoning: { enabled: true, effort: 'xhigh', summary: 'auto' },
        })
        return stream(
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning: '**Explaining**\n\nI',
                    reasoning_details: [
                      {
                        type: 'reasoning.summary',
                        index: 0,
                        format: 'azure-openai-responses-v1',
                        summary: '**Explaining**\n\nI',
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
                  delta: {
                    reasoning: ' need',
                    reasoning_details: [
                      {
                        type: 'reasoning.summary',
                        index: 0,
                        format: 'azure-openai-responses-v1',
                        summary: ' need',
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
                  delta: {
                    reasoning: ' tokenizer',
                    reasoning_details: [
                      {
                        type: 'reasoning.summary',
                        index: 0,
                        format: 'azure-openai-responses-v1',
                        summary: ' tokenizer',
                      },
                    ],
                    content: 'Short answer: often, but not always.',
                  },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
            },
          },
        )
      },
    })
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({
        kind: 'summary',
        text: '**Explaining**\n\nI need tokenizer',
      }),
    ])
  })
})

describe('sendText — token calibration sample ingest', () => {
  it('writes a family-aware chat.tokenCalibration sample on successful stream', async () => {
    // 600-char user message so the prompt char count clears MIN_SAMPLE_CHARS.
    const userText = 'a'.repeat(600)
    const chat = await createChat({
      settings: chatSettings({ model: 'openai/gpt-4o', systemPrompt: '' }),
    })
    // 600 chars → ~190 tokens at 3.15 c/t; choose prompt_tokens that land
    // inside GPT family bounds [2.5, 5.0]. 600/180 = 3.33 → accepted.
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: userText }],
      openStream: () =>
        stream(
          { type: 'delta', chunk: { id: 'g', choices: [{ delta: { content: 'X'.repeat(300) } }] } },
          {
            type: 'delta',
            chunk: {
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 180,
                completion_tokens: 90,
                total_tokens: 270,
              },
            },
          },
        ),
    })
    await __flushPostCommitCalibrationForTests()
    const chatRow = await getChat(chat.id)
    expect(chatRow?.tokenCalibration).toBeDefined()
    const sample = chatRow?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-4o')]
    expect(sample).toBeDefined()
    expect(sample?.sampleCount).toBeGreaterThanOrEqual(1)
    expect(sample?.totalTextTokens).toBeGreaterThan(0)
    // Within-bounds ratio.
    const ratio = (sample?.totalTextChars ?? 0) / (sample?.totalTextTokens ?? 1)
    expect(ratio).toBeGreaterThanOrEqual(2.5)
    expect(ratio).toBeLessThanOrEqual(5.0)
  })

  it('persists hosted-tool outputs and skips all token calibration for tool-enabled sends', async () => {
    await putCachedEndpoints('prof', 'openai/gpt-5.4', {
      id: 'openai/gpt-5.4',
      endpoints: [
        {
          provider_name: 'Test Clean',
          provider_slug: 'test-clean',
          supported_parameters: ['tools', 'provider', 'max_completion_tokens'],
          context_length: 200000,
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
    const chat = await createChat({
      settings: chatSettings({
        model: 'openai/gpt-5.4',
        api: 'responses',
        systemPrompt: '',
        tools: {
          ...cloneDefaultChatSettings().tools,
          openrouter: {
            ...cloneDefaultChatSettings().tools.openrouter,
            enabledServerToolIds: ['web-fetch'],
          },
        },
      }),
    })
    const text = 'X'.repeat(300)
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'a'.repeat(600) }],
      openStream: () =>
        stream({
          type: 'buffered_result',
          result: {
            id: 'resp-tools-1',
            status: 'completed',
            model: 'openai/gpt-5.4',
            output: [
              {
                id: 'wf_1',
                type: 'openrouter:web_fetch',
                status: 'completed',
                url: 'https://openrouter.ai/',
                title: 'OpenRouter',
                content: 'The Unified Interface For LLMs',
              },
              {
                id: 'msg_1',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text }],
              },
            ],
            usage: { input_tokens: 180, output_tokens: 90, total_tokens: 270 },
          },
        } as ResponsesStreamChunk),
    })
    const all = liveMessagesSortedByCreated(await messagesFor(chat.id))
    const assistant = requireDefined(
      all.find((message) => message.role === 'assistant'),
      'assistant',
    )
    expect(assistant.generation?.serverTools).toHaveLength(1)
    expect(assistant.generation?.serverTools?.[0]).toMatchObject({
      type: 'openrouter:web_fetch',
      source: 'responses-output',
      id: 'wf_1',
      status: 'completed',
      outputIndex: 0,
    })
    expect(assistant.providerOutputItems).toHaveLength(1)
    const providerOutput = assistant.providerOutputItems?.[0]
    expect(providerOutput?.dialect).toBe('openrouter-responses')
    expect(providerOutput?.type).toBe('openrouter:web_fetch')
    expect(providerOutput?.outputIndex).toBe(0)
    expect(providerOutput?.item).toMatchObject({
      id: 'wf_1',
      url: 'https://openrouter.ai/',
      content: 'The Unified Interface For LLMs',
    })

    const user = requireDefined(
      all.find((message) => message.role === 'user'),
      'user',
    )
    expect(user.originalCalibrationKey).toBeUndefined()
    expect(assistant.originalCalibrationKey).toBe(tokenCalibrationKey('openai/gpt-5.4'))
    expect(assistant.cachedTokenEstimate).toBeGreaterThan(0)
    const chatRow = await getChat(chat.id)
    expect(chatRow?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-5.4')]).toBeUndefined()
  })

  it('stores streamed Responses provider output items for later context replay', async () => {
    const chat = await createChat({
      settings: chatSettings({
        profileId: 'prof-openai',
        model: 'gpt-5.4-nano',
        api: 'responses',
        systemPrompt: '',
      }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeOpenAiProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'Search once.' }],
      openStream: () =>
        stream(
          {
            type: 'event',
            event: {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'ws_stream_1',
                type: 'web_search_call',
                status: 'completed',
                query: 'streamed provider output marker',
              },
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.output_text.delta',
              output_index: 1,
              content_index: 0,
              delta: 'streamed answer',
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.output_item.done',
              output_index: 1,
              item: {
                id: 'msg_stream_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'streamed answer' }],
              },
            },
          },
          {
            type: 'event',
            event: {
              type: 'response.completed',
              response: {
                id: 'resp_stream_1',
                model: 'gpt-5.4-nano',
                status: 'completed',
                usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
              },
            },
          },
        ),
    })

    const assistant = requireDefined(
      liveMessagesSortedByCreated(await messagesFor(chat.id)).find(
        (message) => message.role === 'assistant',
      ),
      'assistant',
    )
    expect(assistant.generation?.serverTools?.map((tool) => tool.type)).toEqual(['web_search_call'])
    expect(assistant.providerOutputItems).toEqual([
      {
        dialect: 'openai-responses',
        type: 'web_search_call',
        outputIndex: 0,
        item: {
          id: 'ws_stream_1',
          type: 'web_search_call',
          status: 'completed',
          query: 'streamed provider output marker',
        },
      },
    ])
  })

  it('does not calibrate on an errored stream (no usage / bad signal)', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'openai/gpt-4o', systemPrompt: '' }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'a'.repeat(600) }],
      openStream: () =>
        stream(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'partial' } }] } },
          {
            type: 'delta',
            chunk: { error: { code: 429, message: 'rate limited' } },
          },
        ),
    })
    await __flushPostCommitCalibrationForTests()
    const chatRow = await getChat(chat.id)
    // Calibration is skipped on non-done outcome.
    expect(chatRow?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-4o')]).toBeUndefined()
  })

  it('calibrates only completion when the sent path includes non-text input', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'openai/gpt-4o', systemPrompt: '' }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [
        { type: 'text', text: 'a'.repeat(600) },
        { type: 'image_url', url: 'data:image/png;base64,abc123' },
      ],
      openStream: () =>
        stream(
          { type: 'delta', chunk: { id: 'g', choices: [{ delta: { content: 'X'.repeat(300) } }] } },
          {
            type: 'delta',
            chunk: {
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 180,
                completion_tokens: 90,
                total_tokens: 270,
              },
            },
          },
        ),
    })
    await __flushPostCommitCalibrationForTests()
    const chatRow = await getChat(chat.id)
    expect(chatRow?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-4o')]?.sampleCount).toBe(1)
    const rows = liveMessagesSortedByCreated(await messagesFor(chat.id))
    const user = rows.find((row) => row.role === 'user')
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(user?.originalCalibrationKey).toBeUndefined()
    expect(assistant?.originalCalibrationKey).toBe(tokenCalibrationKey('openai/gpt-4o'))
    expect(assistant?.generation?.tokenCalibration).toMatchObject({
      promptSample: false,
      completionSample: true,
      sampleCount: 1,
    })
  })

  it('does not calibrate completion when the assistant output includes a generated image', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'black-forest-labs/flux.2-klein-4b', systemPrompt: '' }),
    })
    const imageUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'a'.repeat(600) }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              id: 'g',
              choices: [
                {
                  delta: {
                    role: 'assistant',
                    content: '',
                    images: [{ type: 'image_url', image_url: { url: imageUrl } }],
                  },
                },
              ],
            },
          },
          {
            type: 'delta',
            chunk: {
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens: 180,
                completion_tokens: 0,
                total_tokens: 180,
              },
            },
          },
        ),
    })
    await __flushPostCommitCalibrationForTests()
    const chatRow = await getChat(chat.id)
    expect(
      chatRow?.tokenCalibration?.[tokenCalibrationKey('black-forest-labs/flux.2-klein-4b')]
        ?.sampleCount,
    ).toBe(1)
    const assistant = liveMessagesSortedByCreated(await messagesFor(chat.id)).find(
      (message) => message.role === 'assistant',
    )
    const output = assistant?.content.find((item) => item.type === 'output_image')
    expect(output).toMatchObject({ type: 'output_image' })
    expect(output && 'url' in output ? output.url : undefined).toBeUndefined()
    const attachmentId = output?.type === 'output_image' ? output.attachmentId : undefined
    expect(attachmentId).toBeTruthy()
    expect(assistant?.attachmentRefs).toHaveLength(1)
    expect(assistant?.attachmentRefs?.[0]).toMatchObject({
      attachmentId,
      includeInContext: true,
    })
    const bundle = attachmentId ? await attachmentBundle(attachmentId) : undefined
    expect(bundle?.attachment).toMatchObject({
      id: attachmentId,
      kind: 'image',
      mime: 'image/png',
      origin: 'generated-output',
      storage: { kind: 'local-blob' },
      refCount: 1,
    })
    expect(bundle?.blobs.some((blob) => blob.role === 'original')).toBe(true)
    expect(assistant?.generation?.tokenCalibration).toMatchObject({
      promptSample: true,
      completionSample: false,
      sampleCount: 1,
    })
    expect((await message(assistant?.id ?? ''))?.content).toContainEqual({
      type: 'output_image',
      attachmentId,
    })
  })

  it('commits canonical generated output before a stalled localization and aborts the optional fetch', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'black-forest-labs/flux.2-klein-4b', systemPrompt: '' }),
    })
    const imageUrl = 'https://cdn.example/generated.png'
    let markDownloadStarted!: () => void
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve
    })
    let downloadSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      markDownloadStarted()
      downloadSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'))
        if (init?.signal?.aborted) {
          rejectAbort()
          return
        }
        init?.signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const sendPromise = sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'draw it' }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              id: 'g',
              choices: [
                {
                  delta: {
                    role: 'assistant',
                    content: '',
                    images: [{ type: 'image_url', image_url: { url: imageUrl } }],
                  },
                },
              ],
            },
          },
          {
            type: 'delta',
            chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] },
          },
        ),
    })
    await within(downloadStarted, 'generated-output download start')
    const result = await within(sendPromise, 'canonical generated-output commit')
    expect(result.outcome).toBe('done')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(downloadSignal).toBeDefined()

    const assistant = liveMessagesSortedByCreated(await messagesFor(chat.id)).find(
      (message) => message.role === 'assistant',
    )
    expect(assistant?.generation?.status).toBe('done')
    const output = assistant?.content.find((item) => item.type === 'output_image')
    expect(output?.type).toBe('output_image')
    if (!output) throw new Error('ExpectedOutputImage')
    expect(typeof output.attachmentId).toBe('string')
    const attachmentId = requireDefined(output.attachmentId, 'generated output attachment')
    expect(assistant?.attachmentRefs).toEqual([
      expect.objectContaining({ attachmentId, includeInContext: true }),
    ])
    expect(await attachmentBundle(attachmentId)).toMatchObject({
      attachment: {
        id: attachmentId,
        origin: 'generated-output',
        storage: { kind: 'remote-url', url: imageUrl },
      },
    })

    abortGeneratedOutputLocalizationCapability()
    await within(awaitGeneratedOutputLocalizationCapabilityIdle(), 'generated-output cancellation')
    expect(downloadSignal?.aborted).toBe(true)
    expect(
      await getDb().attachmentJobs.where('attachmentId').equals(attachmentId).first(),
    ).toMatchObject({
      status: 'pending',
      error: { code: 'workspace-transition' },
    })
    expect((await message(assistant?.id ?? ''))?.content).toContainEqual(
      expect.objectContaining({ type: 'output_image', attachmentId }),
    )

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(new Blob(['png'], { type: 'image/png' }), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
        ),
      ),
    )
    await shutdownBrowserWorkspace()
    await openBrowserWorkspace()
    closeStreamRecoveryRuntime()
    await within(
      awaitGeneratedOutputLocalizationCapabilityIdle(),
      'pre-existing generated-output localization',
    )
    expect(
      await getDb().attachmentJobs.where('attachmentId').equals(attachmentId).first(),
    ).toMatchObject({ status: 'succeeded' })
    expect(await attachmentBundle(attachmentId)).toMatchObject({
      attachment: { storage: { kind: 'local-blob' } },
    })
  })

  it('does not let delayed generated-output localization overwrite an assistant edit', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'black-forest-labs/flux.2-klein-4b', systemPrompt: '' }),
    })
    const imageUrl = 'https://cdn.example/generated.png'
    let markDownloadStarted!: () => void
    const downloadStarted = new Promise<void>((resolve) => {
      markDownloadStarted = resolve
    })
    let finishDownload!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        markDownloadStarted()
        return new Promise<Response>((resolve, reject) => {
          finishDownload = resolve
          const rejectAbort = () => reject(new DOMException('aborted', 'AbortError'))
          if (init?.signal?.aborted) rejectAbort()
          else init?.signal?.addEventListener('abort', rejectAbort, { once: true })
        })
      }),
    )

    const resultPromise = sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'draw it' }],
      openStream: () =>
        stream(
          {
            type: 'delta',
            chunk: {
              id: 'g',
              choices: [
                {
                  delta: {
                    role: 'assistant',
                    content: '',
                    images: [{ type: 'image_url', image_url: { url: imageUrl } }],
                  },
                },
              ],
            },
          },
          {
            type: 'delta',
            chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] },
          },
        ),
    })

    await downloadStarted
    const result = await resultPromise
    const assistant = await message(result.assistantMessageId)
    const output = assistant?.content.find((item) => item.type === 'output_image')
    expect(output?.type).toBe('output_image')
    if (!output) throw new Error('ExpectedOutputImage')
    expect(typeof output.attachmentId).toBe('string')
    await executeMessageCommand({
      kind: 'message.edit-content',
      input: {
        chatId: chat.id,
        messageId: result.assistantMessageId,
        content: [{ type: 'output_text', text: 'edited while media was downloading' }],
      },
    })

    finishDownload(
      new Response(new Blob(['png'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    )
    await awaitGeneratedOutputLocalizationCapabilityIdle()

    expect(await message(result.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: 'edited while media was downloading' }],
    })
    expect(await getDb().attachments.count()).toBe(1)
  })

  it('drains generated-output jobs beyond its concurrency window to a fixed point', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'black-forest-labs/flux.2-klein-4b', systemPrompt: '' }),
    })
    const pendingDownloads: Array<(response: Response) => void> = []
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          if (pendingDownloads.length >= 2) {
            resolve(
              new Response(new Blob(['png'], { type: 'image/png' }), {
                status: 200,
                headers: { 'content-type': 'image/png' },
              }),
            )
            return
          }
          pendingDownloads.push(resolve)
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    for (let index = 0; index < 3; index += 1) {
      await sendText({
        chatId: chat.id,
        connection: makeProfile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: `draw it ${index}` }],
        openStream: () =>
          stream(
            {
              type: 'delta',
              chunk: {
                id: `generated-${index}`,
                choices: [
                  {
                    delta: {
                      role: 'assistant',
                      content: '',
                      images: [
                        {
                          type: 'image_url',
                          image_url: { url: `https://cdn.example/generated-${index}.png` },
                        },
                      ],
                    },
                  },
                ],
              },
            },
            {
              type: 'delta',
              chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] },
            },
          ),
      })
    }

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    for (const resolve of pendingDownloads) {
      resolve(
        new Response(new Blob(['png'], { type: 'image/png' }), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      )
    }
    await within(awaitGeneratedOutputLocalizationCapabilityIdle(), 'generated-output fixed point')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(
      (await getDb().attachmentJobs.where('status').equals('succeeded').toArray()).filter(
        (job) => job.processorId === GENERATED_OUTPUT_LOCALIZATION_PROCESSOR_ID,
      ),
    ).toHaveLength(3)
  })

  it('populates per-message calibration fields only for accepted lanes', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'openai/gpt-4o', systemPrompt: '' }),
    })
    const userText = 'a'.repeat(60)
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: userText }],
      openStream: () =>
        stream(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'X'.repeat(100) } }] } },
          {
            type: 'delta',
            chunk: {
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 30, completion_tokens: 30, total_tokens: 60 },
            },
          },
        ),
    })
    await __flushPostCommitCalibrationForTests()
    const all = liveMessagesSortedByCreated(await messagesFor(chat.id))
    const user = requireDefined(
      all.find((row) => row.role === 'user'),
      'user',
    )
    const assistant = requireDefined(
      all.find((row) => row.role === 'assistant'),
      'assistant',
    )
    expect(user.originalCharCount).toBeUndefined()
    expect(user.originalModelId).toBeUndefined()
    expect(user.originalCalibrationKey).toBeUndefined()
    expect(user.cachedTokenEstimate).toBeUndefined()
    expect(assistant.originalCharCount).toBe(100)
    expect(assistant.originalModelId).toBe('openai/gpt-4o')
    expect(assistant.originalCalibrationKey).toBe(tokenCalibrationKey('openai/gpt-4o'))
    expect(assistant.cachedTokenEstimate).toBeGreaterThan(0)
  })

  it('keeps partial stream text out of messageBodies while appending recovery chunks', async () => {
    const chat = await createChat({ settings: chatSettings({ model: 'openai/gpt-4o' }) })
    let releaseStream!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    let now = 1_000
    const sendPromise = sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hi' }],
      now: () => {
        now += 250
        return now
      },
      openStream: async function* () {
        yield {
          type: 'delta',
          chunk: { choices: [{ delta: { content: 'partial text' } }] },
        }
        await blocked
      },
    })

    await eventually(async () => {
      expect(await getDb().streamChunks.count()).toBeGreaterThan(0)
    })
    const assistant = liveMessagesSortedByCreated(await messagesFor(chat.id)).find(
      (message) => message.role === 'assistant',
    )
    expect(assistant).toBeDefined()
    expect(assistant?.content).toEqual([])

    releaseStream()
    await sendPromise
    expect(await getDb().streamChunks.count()).toBe(0)
  })

  it('honors the unified attempt abort request and finalizes the owner accumulator once', async () => {
    const chat = await createChat({ settings: chatSettings({ model: 'openai/gpt-4o' }) })
    let markPaused!: () => void
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve
    })
    let now = 1_000
    const handle = await startSendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hi' }],
      now: () => {
        now += 250
        return now
      },
      openStream: ({ signal }) =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'remote-stop partial' } }] },
          }
          markPaused()
          await new Promise<void>((_, reject) => {
            if (signal.aborted) {
              reject(new DOMException('aborted', 'AbortError'))
              return
            }
            const onAbort = () => {
              signal.removeEventListener('abort', onAbort)
              reject(new DOMException('aborted', 'AbortError'))
            }
            signal.addEventListener('abort', onAbort, { once: true })
          })
        })(),
    })

    await paused
    await eventually(async () => {
      expect(await getDb().streamChunks.count()).toBeGreaterThan(0)
    })
    expect(attemptController.getExecution(handle.streamId)?.messageId).toBeTypeOf('string')

    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    const result = await handle.completed
    expect(result.outcome).toBe('abort')
    const assistant = await message(result.assistantMessageId)
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'remote-stop partial' }])
    expect(assistant?.generation?.abortReason).toBe('user')
    expect(await getDb().streamChunks.count()).toBe(0)
    expect(await streamLeases(chat.id)).toEqual([])
  })

  it('persists Responses phase deltas without logging full message output-item snapshots', async () => {
    const chat = await createChat({
      settings: chatSettings({
        profileId: 'prof-openai',
        model: 'openai/gpt-5.4',
        api: 'responses',
      }),
    })
    let releaseStream!: () => void
    const blocked = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    let markPaused!: () => void
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve
    })
    let now = 1_000
    const handle = await startSendText({
      chatId: chat.id,
      connection: makeOpenAiProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'phase please' }],
      now: () => {
        now += 250
        return now
      },
      openStream: async function* () {
        yield {
          type: 'event',
          event: {
            type: 'response.output_text.delta',
            output_index: 0,
            content_index: 0,
            item_id: 'msg_1',
            delta: 'phase text',
          },
        }
        yield {
          type: 'event',
          event: {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg_1',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              phase: 'final_answer',
              content: [{ type: 'output_text', text: 'phase text'.repeat(500) }],
            },
          },
        }
        markPaused()
        await blocked
        yield {
          type: 'event',
          event: {
            type: 'response.completed',
            response: {
              id: 'resp_1',
              status: 'completed',
              model: 'openai/gpt-5.4',
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        }
      },
    })

    await paused
    await eventually(async () => {
      const entries = await decodeTestStreamJournalFrames(
        await readTestStreamJournalFrames(handle.streamId),
      )
      expect(
        entries.some((entry) => requirePersistedStreamEventV2(entry.event).event.lane === 'phase'),
      ).toBe(true)
    })
    const entries = await decodeTestStreamJournalFrames(
      await readTestStreamJournalFrames(handle.streamId),
    )
    expect(
      entries.some((entry) => {
        const event = requirePersistedStreamEventV2(entry.event).event
        return event.lane === 'output-item-done' && event.item.type === 'message'
      }),
    ).toBe(false)

    releaseStream()
    const result = await handle.completed
    expect(result.outcome).toBe('done')
    const assistant = await message(result.assistantMessageId)
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'phase text' }])
    expect(assistant?.phase).toBe('final_answer')
    expect(await getDb().streamChunks.count()).toBe(0)
  })

  it('skips the sample when the implied ratio is outside family bounds', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'openai/gpt-4o', systemPrompt: '' }),
    })
    // 100 chars / 10 prompt_tokens = ratio 10 — way above GPT hi (5.0).
    // Rejected at ingest time; nothing persisted to tokenCalibration.
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'a'.repeat(100) }],
      openStream: () =>
        stream(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'ok' } }] } },
          {
            type: 'delta',
            chunk: {
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
            },
          },
        ),
    })
    await __flushPostCommitCalibrationForTests()
    const chatRow = await getChat(chat.id)
    // Neither prompt nor completion sample should land: both too short /
    // ratio out of bounds (completion 2 chars / 1 token is also outside).
    const s = chatRow?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-4o')]
    // If nothing is accepted, the field either stays undefined OR sampleCount=0.
    expect(s?.sampleCount ?? 0).toBe(0)
  })
})

describe('recoverOrphans', () => {
  it('marks messages with startedAt-but-no-finishedAt as tab-close aborts', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const orphanId = await seedUnfinishedAssistant(chat.id)
    const lease = await insertRecoveryLease({
      streamId: 'unfinished-generation',
      chatId: chat.id,
      messageId: orphanId,
      targetCommittedAt: 101,
    })
    await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_000)).resolves.toBe(
      'recovered',
    )
    const after = await message(orphanId)
    expect(after?.generation?.abortReason).toBe('tab-close')
    expect(after?.generation?.finishedAt).toBe(20_000)
  })

  it('does not mark a message that has a fresh cross-tab stream lease', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const leasedId = await seedUnfinishedAssistant(chat.id)
    const lease = await insertRecoveryLease({
      streamId: 'stream-other-tab',
      chatId: chat.id,
      messageId: leasedId,
      startedAt: 100,
      heartbeatAt: 19_000,
      targetCommittedAt: 101,
    })
    const release = manager.hold(`stream-owner:${lease.streamId}`)

    try {
      await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_000)).resolves.toBe(
        'deferred',
      )
      expect((await message(leasedId))?.generation?.abortReason).toBeUndefined()
    } finally {
      release()
    }
  })

  it('recovers a fresh persisted lease immediately when its Web Lock owner is gone', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    const recoveryNow = Date.now()
    const lease = await insertRecoveryLease({
      streamId: 'fresh-dead-owner',
      chatId: chat.id,
      messageId,
      startedAt: 100,
      heartbeatAt: recoveryNow,
      attemptKind: 'generation',
      targetCommittedAt: 101,
    })

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, recoveryNow)).resolves.toBe(
      'recovered',
    )
    expect(await streamLeases(chat.id)).toEqual([])
    expect(await message(messageId)).toMatchObject({
      generation: {
        status: 'interrupted',
        abortReason: 'tab-close',
        finishedAt: recoveryNow,
      },
    })
  })

  it('deletes a targeted generation admission when its reserved row never committed', async () => {
    __setStreamLockManagerForTests(new TestExclusiveLockManager())
    const chat = await createChat({ settings: chatSettings() })
    const recoveryNow = Date.now()
    const lease = await insertRecoveryLease({
      streamId: 'reserved-target-without-row',
      chatId: chat.id,
      messageId: 'assistant-id-reserved-before-placeholder',
      startedAt: recoveryNow,
      heartbeatAt: recoveryNow,
      attemptKind: 'generation',
    })

    expect(await message('assistant-id-reserved-before-placeholder')).toBeUndefined()
    await expect(recoverStreamOrphan({ streamId: lease.streamId }, recoveryNow)).resolves.toBe(
      'recovered',
    )
    expect(await streamLeases(chat.id)).toEqual([])
    expect(await message('assistant-id-reserved-before-placeholder')).toBeUndefined()
  })

  it('discards a continuation admission whose reserved target never committed', async () => {
    __setStreamLockManagerForTests(new TestExclusiveLockManager())
    const chat = await createChat({ settings: chatSettings() })
    const recoveryNow = Date.now()
    const lease = await insertRecoveryLease({
      streamId: 'continuation-target-without-row',
      chatId: chat.id,
      messageId: 'missing-continuation-target',
      startedAt: recoveryNow,
      heartbeatAt: recoveryNow,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
    })

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, recoveryNow)).resolves.toBe(
      'recovered',
    )
    expect(await streamLeases(chat.id)).toEqual([])
    expect(await readTestStreamJournalFrames(lease.streamId)).toEqual([])
  })

  it('settles a lease-less local recovery point when its reserved target is absent', async () => {
    await expect(recoverStreamOrphan({ streamId: 'lease-less-missing-target' })).resolves.toBe(
      'resolved',
    )
    expect(attemptController.get('lease-less-missing-target')).toBeUndefined()
  })

  it('prevents duplicate target leases before recovery can see ambiguous journals', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    const first = await insertRecoveryLease({
      streamId: 'duplicate-recovery-a',
      chatId: chat.id,
      messageId,
      startedAt: 100,
      heartbeatAt: 20_000,
      attemptKind: 'generation',
      targetCommittedAt: 101,
    })
    const second = testGenerationLease({
      streamId: 'duplicate-recovery-b',
      chatId: chat.id,
      messageId,
      ownerClientId: 'closed:duplicate-recovery-b',
      fenceToken: 'fence:duplicate-recovery-b',
      startedAt: 100,
      heartbeatAt: 20_000,
      admissionSequence: 2,
      revision: 0,
      targetCommittedAt: 101,
      requestedModel: 'openai/gpt-4o',
      apiUsed: 'chat',
      postCommit: { usedAt: 100, profileId: makeProfile().id },
    })
    await expect(getDb().streamLeases.put(second)).rejects.toMatchObject({
      name: 'ConstraintError',
    })
    expect(await streamLeases(chat.id)).toEqual([first])
  })

  it.each([
    'generation',
    'continuation',
  ] as const)('recovers a fresh uncommitted-target %s admission immediately when its owner is gone', async (attemptKind) => {
    __setStreamLockManagerForTests(new TestExclusiveLockManager())
    const chat = await createChat({ settings: chatSettings() })
    const lease = await insertRecoveryLease({
      streamId: `uncommitted-target-${attemptKind}`,
      chatId: chat.id,
      messageId: `missing-${attemptKind}`,
      startedAt: 100,
      heartbeatAt: 19_000,
      attemptKind,
      ...(attemptKind === 'continuation' ? { continuationStrategy: 'prompt' as const } : {}),
    })

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_000)).resolves.toBe(
      'recovered',
    )
    expect(await streamLeases(chat.id)).toEqual([])
  })

  it.each([
    'generation',
    'continuation',
  ] as const)('waits for the no-Web-Locks TTL before recovering an uncommitted-target %s admission', async (attemptKind) => {
    __setStreamLockManagerForTests(null)
    const chat = await createChat({ settings: chatSettings() })
    const lease = await insertRecoveryLease({
      streamId: `fallback-uncommitted-${attemptKind}`,
      chatId: chat.id,
      messageId: `fallback-missing-${attemptKind}`,
      startedAt: 100,
      heartbeatAt: 19_000,
      attemptKind,
      ...(attemptKind === 'continuation' ? { continuationStrategy: 'prompt' as const } : {}),
    })

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_000)).resolves.toBe(
      'deferred',
    )
    expect(await streamLeases(chat.id)).toHaveLength(1)
    await expect(recoverStreamOrphan({ streamId: lease.streamId }, 34_001)).resolves.toBe(
      'recovered',
    )
    expect(await streamLeases(chat.id)).toEqual([])
  })

  it('does not invent live recovery state for an unfinished header without a lease', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id, 19_000)

    await expect(recoverStreamOrphan({ streamId: 'no-durable-lease' }, 34_001)).resolves.toBe(
      'resolved',
    )
    expect(await message(messageId)).toMatchObject({
      generation: { startedAt: 19_000 },
    })
    expect((await message(messageId))?.generation?.finishedAt).toBeUndefined()
  })

  it('does not recover a fresh lease until its Web Lock owner releases it', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    const lease = await insertRecoveryLease({
      streamId: 'fresh-live-owner',
      chatId: chat.id,
      messageId,
      startedAt: 100,
      heartbeatAt: 19_000,
      attemptKind: 'generation',
      targetCommittedAt: 101,
    })
    const release = manager.hold('stream-owner:fresh-live-owner')

    await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_000)).resolves.toBe(
      'deferred',
    )
    expect((await message(messageId))?.generation?.finishedAt).toBeUndefined()

    release()
    await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_001)).resolves.toBe(
      'recovered',
    )
    expect((await message(messageId))?.generation?.abortReason).toBe('tab-close')
  })

  it('wakes recovery when a reloaded page releases fresh stream ownership', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    const lease = await insertRecoveryLease({
      streamId: 'reload-release',
      chatId: chat.id,
      messageId,
      startedAt: 100,
      heartbeatAt: 20_000,
      attemptKind: 'generation',
      targetCommittedAt: 101,
    })
    const release = manager.hold('stream-owner:reload-release')
    const ownershipReleased = waitForStreamOwnershipRelease(
      lease.streamId,
      new AbortController().signal,
    )

    try {
      await eventually(() => {
        expect(manager.queuedCount('stream-owner:reload-release')).toBe(1)
      })
      expect((await message(messageId))?.generation?.finishedAt).toBeUndefined()

      release()
      await expect(ownershipReleased).resolves.toBe(true)
      await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_000)).resolves.toBe(
        'recovered',
      )
      expect(await streamLeases(chat.id)).toEqual([])
      expect(await message(messageId)).toMatchObject({
        generation: {
          status: 'interrupted',
          abortReason: 'tab-close',
          finishedAt: 20_000,
        },
      })
    } finally {
      release()
    }
  })

  it('does not recover another placeholder while an uncommitted generation owner is retargeting', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    const lease = await insertRecoveryLease({
      streamId: 'placeholder-retarget-window',
      chatId: chat.id,
      messageId: 'retarget-reserved-id',
      startedAt: 100,
      heartbeatAt: 20_000,
      attemptKind: 'generation',
    })
    const release = manager.hold('stream-owner:placeholder-retarget-window')

    try {
      await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_000)).resolves.toBe(
        'deferred',
      )
      expect((await message(messageId))?.generation?.finishedAt).toBeUndefined()
    } finally {
      release()
    }
  })

  it('revalidates a durable lease that appears after an earlier point read', async () => {
    __setStreamLockManagerForTests(new TestExclusiveLockManager())
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    await expect(recoverStreamOrphan({ streamId: 'late-durable-lease' }, 20_000)).resolves.toBe(
      'resolved',
    )
    const lease = await insertRecoveryLease({
      streamId: 'late-durable-lease',
      chatId: chat.id,
      messageId,
      startedAt: 100,
      heartbeatAt: 20_000,
      targetCommittedAt: 101,
    })
    await expect(recoverStreamOrphan({ streamId: lease.streamId }, 20_000)).resolves.toBe(
      'recovered',
    )
    expect((await message(messageId))?.generation?.finishedAt).toBe(20_000)
  })

  it('revalidates many orphan targets with point and indexed lease reads', async () => {
    __setStreamLockManagerForTests(new TestExclusiveLockManager())
    const chat = await createChat({ settings: chatSettings() })
    const targetCount = 24
    const streamIds: string[] = []
    for (let index = 0; index < targetCount; index += 1) {
      const messageId = await seedUnfinishedAssistant(chat.id)
      const lease = await insertRecoveryLease({
        streamId: `linear-recovery-${index}`,
        chatId: chat.id,
        messageId,
        startedAt: 100,
        heartbeatAt: 20_000,
        attemptKind: 'generation',
        targetCommittedAt: 101,
      })
      streamIds.push(lease.streamId)
    }
    const queries: WorkspaceQuery[] = []
    __setWorkspaceRepositoryForTests(repositoryWithQueryLog(getBrowserRepository(), queries))

    await expect(
      Promise.all(streamIds.map((streamId) => recoverStreamOrphan({ streamId }, 20_000))),
    ).resolves.toEqual(Array.from({ length: targetCount }, () => 'recovered'))
    expect(await streamLeases(chat.id)).toEqual([])
    expect(queries.some((query) => query.kind === 'message.headers-by-chat')).toBe(false)
    expect(queries.length).toBeLessThanOrEqual(targetCount * 8 + 1)
  })

  it('does not let a metadata-committed cleanup anchor block later target edits', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    const current = requireDefined(await message(messageId), 'finished target')
    await patchMessageFixture(messageId, {
      generation: {
        ...requireDefined(current.generation, 'generation'),
        status: 'done',
        finishedAt: 500,
        finishReason: 'stop',
      },
    })
    await insertRecoveryLease({
      streamId: 'finished-generation-cleanup-pending',
      chatId: chat.id,
      messageId,
      startedAt: 100,
      heartbeatAt: 500,
      attemptKind: 'generation',
      targetCommittedAt: 101,
      canonicalAt: 500,
      metadataCommittedAt: 501,
    })

    await expect(
      executeMessageCommand({
        kind: 'message.edit-content',
        input: {
          chatId: chat.id,
          messageId,
          content: [{ type: 'output_text', text: 'edited after terminal commit' }],
        },
      }),
    ).resolves.toBeDefined()
    expect(await message(messageId)).toMatchObject({
      content: [{ type: 'output_text', text: 'edited after terminal commit' }],
    })

    await expect(
      executeMessageCommand({
        kind: 'message.edit-content',
        input: {
          chatId: chat.id,
          messageId,
          content: [{ type: 'output_text', text: 'second terminal edit' }],
        },
      }),
    ).resolves.toBeDefined()
  })

  it('admits new work without coupling it to metadata-only cleanup on the same target', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    const current = requireDefined(await message(messageId), 'finished target')
    await patchMessageFixture(messageId, {
      generation: {
        ...requireDefined(current.generation, 'generation'),
        status: 'done',
        finishedAt: 500,
        finishReason: 'stop',
      },
    })
    const predecessor = await insertRecoveryLease({
      streamId: 'metadata-committed-predecessor',
      chatId: chat.id,
      messageId,
      startedAt: 100,
      heartbeatAt: 500,
      attemptKind: 'generation',
      targetCommittedAt: 101,
      canonicalAt: 500,
      metadataCommittedAt: 501,
    })
    await seedTestStreamJournalEvents(getDb(), predecessor, [{ lane: 'text', text: 'old journal' }])
    const workspace = await readWorkspaceMeta()
    attemptController.observeLease(predecessor, { workspaceId: workspace.workspaceId })
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const handle = await startControlledGeneration(
      { kind: 'continue', chatId: chat.id, targetAssistantId: messageId },
      {
        profile: makeProfile(),
        keyMaterial: { 'key-a': 'sk-test' },
        openStream: async function* () {
          await paused
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: '-next' }, finish_reason: 'stop' }] },
          }
        },
      },
    )
    let completed: unknown
    try {
      await handle.prepared
      if (!streamLeaseHasWriteFence(predecessor)) throw new Error('ExpectedFencedTestLease')

      expect(await streamLease(predecessor.streamId)).toMatchObject({
        streamId: predecessor.streamId,
        phase: 'metadata-committed',
      })
      expect((await streamLease(predecessor.streamId))?.targetOwnerKey).toBeUndefined()
      expect(await readTestStreamJournalFrames(predecessor.streamId)).not.toEqual([])
      await expect(
        runWorkspaceAction('conversation-generation', (permit) =>
          getWorkspaceRepository().execute(permit, {
            kind: 'stream.finish-cleanup',
            streamId: predecessor.streamId,
            fence: streamWriteFenceForLease(predecessor),
          }),
        ),
      ).resolves.toMatchObject({
        value: { deletedLease: true, deletedFrames: 1, done: true },
      })
      await eventually(() => {
        expect(attemptController.get(predecessor.streamId)).toBeUndefined()
      })
      expect(await streamLease(handle.streamId)).toMatchObject({
        streamId: handle.streamId,
        messageId,
        attemptKind: 'continuation',
      })
      expect(await readTestStreamJournalFrames(predecessor.streamId)).toEqual([])
    } finally {
      release()
      completed = await handle.completed
    }
    expect(completed).toMatchObject({ outcome: 'done' })
  })

  it('keeps metadata cleanup independent and idempotent after same-target replacement', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id)
    const current = requireDefined(await message(messageId), 'finished target')
    await patchMessageFixture(messageId, {
      generation: {
        ...requireDefined(current.generation, 'generation'),
        status: 'done',
        finishedAt: 500,
        finishReason: 'stop',
      },
    })
    const predecessor = await insertRecoveryLease({
      streamId: 'cleanup-race-predecessor',
      chatId: chat.id,
      messageId,
      startedAt: 100,
      heartbeatAt: 500,
      attemptKind: 'generation',
      targetCommittedAt: 101,
      canonicalAt: 500,
      metadataCommittedAt: 501,
    })
    await seedTestStreamJournalEvents(getDb(), predecessor, [{ lane: 'text', text: 'old journal' }])
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const handle = await startControlledGeneration(
      { kind: 'continue', chatId: chat.id, targetAssistantId: messageId },
      {
        profile: makeProfile(),
        keyMaterial: { 'key-a': 'sk-test' },
        openStream: async function* () {
          await paused
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: '-next' }, finish_reason: 'stop' }] },
          }
        },
      },
    )
    let completed: unknown
    try {
      await handle.prepared

      await expect(
        runWorkspaceAction('conversation-generation', (permit) =>
          getWorkspaceRepository().execute(permit, {
            kind: 'stream.finish-cleanup',
            streamId: predecessor.streamId,
            fence: streamWriteFenceForLease(predecessor),
          }),
        ),
      ).resolves.toMatchObject({
        value: { deletedLease: true, deletedFrames: 1, done: true },
      })
      await expect(
        runWorkspaceAction('conversation-generation', (permit) =>
          getWorkspaceRepository().execute(permit, {
            kind: 'stream.finish-cleanup',
            streamId: predecessor.streamId,
            fence: streamWriteFenceForLease(predecessor),
          }),
        ),
      ).resolves.toMatchObject({
        value: { deletedLease: false, deletedFrames: 0, done: true },
      })
      expect(await streamLease(handle.streamId)).toMatchObject({
        streamId: handle.streamId,
        messageId,
      })
      expect(await readTestStreamJournalFrames(predecessor.streamId)).toEqual([])
    } finally {
      release()
      completed = await handle.completed
    }
    expect(completed).toMatchObject({ outcome: 'done' })
  })

  it('does not compact chunks while a fresh owner lease exists', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const leasedId = await seedUnfinishedAssistant(chat.id)
    const activeLease = await insertRecoveryLease({
      streamId: 'active-stream',
      chatId: chat.id,
      messageId: leasedId,
      startedAt: 100,
      heartbeatAt: 19_000,
      targetCommittedAt: 101,
    })
    await appendTestStreamJournalEvents(activeLease, [{ lane: 'text', text: 'owned elsewhere' }])
    const release = manager.hold(`stream-owner:${activeLease.streamId}`)

    try {
      await expect(recoverStreamOrphan({ streamId: activeLease.streamId }, 20_000)).resolves.toBe(
        'deferred',
      )
      const after = await message(leasedId)
      expect(after?.content).toEqual([{ type: 'output_text', text: 'partial' }])
      expect(after?.generation?.abortReason).toBeUndefined()
      expect(await readTestStreamJournalFrames(activeLease.streamId)).toHaveLength(1)
    } finally {
      release()
    }
  })

  it('compacts stale stream chunks once and deletes the recovery log', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const orphanId = await seedUnfinishedAssistant(chat.id)
    await executeMessageCommand({
      kind: 'message.edit-content',
      input: { chatId: chat.id, messageId: orphanId, content: [] },
    })
    const staleLease = await insertRecoveryLease({
      streamId: 'stale-stream',
      chatId: chat.id,
      messageId: orphanId,
      startedAt: 100,
      heartbeatAt: 1_000,
      targetCommittedAt: 101,
    })
    await seedTestStreamJournalEvents(getDb(), staleLease, [
      {
        lane: 'reasoning',
        mutations: [
          {
            kind: 'replace',
            envelope: reasoningEnvelopeFromDetailsForTest(
              [{ type: 'reasoning.text', text: 'thinking' }],
              'openrouter-chat',
            ),
          },
        ],
      },
      { lane: 'text', text: 'hello ' },
      { lane: 'text', text: 'world' },
      {
        lane: 'tool-call',
        index: 0,
        id: 'call-recovered',
        type: 'function',
        name: 'lookup',
        argumentsDelta: '{"query":',
      },
      { lane: 'tool-call', index: 0, argumentsDelta: '"natter"}' },
      { lane: 'phase', phase: 'final_answer', outputIndex: 0 },
    ])

    await expect(recoverStreamOrphan({ streamId: staleLease.streamId }, 20_000)).resolves.toBe(
      'recovered',
    )
    const after = await message(orphanId)
    expect(after?.content).toEqual([{ type: 'output_text', text: 'hello world' }])
    expect(after?.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'text', text: 'thinking' }),
    ])
    expect(after?.generation?.abortReason).toBe('tab-close')
    expect(after?.phase).toBe('final_answer')
    expect(after?.toolCalls).toEqual([
      {
        id: 'call-recovered',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"natter"}' },
      },
    ])
    expect(await readTestStreamJournalFrames(staleLease.streamId)).toEqual([])
    expect(await streamLeases(chat.id)).toEqual([])

    await expect(recoverStreamOrphan({ streamId: staleLease.streamId }, 21_000)).resolves.toBe(
      'resolved',
    )
  })

  it('graces very recent placeholders until their durable lease is visible', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const freshId = await seedUnfinishedAssistant(chat.id, 10_000)

    await expect(recoverStreamOrphan({ streamId: 'not-visible-yet' }, 20_000)).resolves.toBe(
      'resolved',
    )
    expect((await message(freshId))?.generation?.abortReason).toBeUndefined()
  })

  it('does not touch messages that already finished', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const id = await seedUnfinishedAssistant(chat.id)
    const current = requireDefined(await message(id), 'finished message')
    await patchMessageFixture(id, {
      generation: {
        ...requireDefined(current.generation, 'generation'),
        id: 'ok',
        status: 'done',
        finishedAt: 500,
        finishReason: 'stop',
      },
    })
    await expect(recoverStreamOrphan({ streamId: 'already-finished' }, 20_000)).resolves.toBe(
      'resolved',
    )
    const after = await message(id)
    expect(after?.generation?.abortReason).toBeUndefined()
  })
})

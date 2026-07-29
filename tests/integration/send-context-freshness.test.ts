import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, Message, MessageId } from '../../src/core/types'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
  tryExecuteBrowserWorkspaceCommandWithinFanoutBudget,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { setManualTitle, touchLastViewed } from '../../src/store/chats'
import { configurationApplication } from '../../src/store/configuration-application'
import { importMessagesOp } from '../../src/store/conversation-command-client'
import { __resetDbForTests, getDb } from '../../src/store/db'
import type {
  GenerationHandle,
  GenerationIntent,
  GenerationTransportInput,
} from '../../src/store/generation-engine'
import {
  __setLockBackendForTests,
  type AuthoritativeCommandLockSession,
  type LockBackend,
  type LockGrant,
} from '../../src/store/locks'
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
import { createChat } from '../helpers/chats'
import { clearEndpointsCacheForProfile, putCachedEndpoints } from '../helpers/discovery-cache'
import {
  installGenerationProfile,
  requestGenerationStop,
  startControlledGeneration,
} from '../helpers/generation-engine'
import { executeMessageCommand } from '../helpers/message-commands'
import { readTestMessageHeader } from '../helpers/message-storage'

const DB_NAME = 'natter'
const MODEL = 'google/gemini-3.1-flash-lite-preview'

function profile(): ConnectionProfile {
  return {
    id: 'freshness-profile',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'freshness-key',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost:5173',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: false,
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

const endpointsPayload = {
  id: MODEL,
  endpoints: [
    {
      provider_name: 'Freshness Test Provider',
      provider_slug: 'freshness-test-provider',
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
}

interface DiscoveryGate {
  started: Promise<void>
  release(): void
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
      const tail = prior.then(() => held)
      this.tails.set(name, tail)
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
    let resourceScopeActive = false
    return operation({
      kind: this.kind,
      withResourceLocks: async (resourceNames, child) => {
        if (resourceScopeActive) throw new Error('AuthoritativeCommandNestedResourceLocks')
        resourceScopeActive = true
        try {
          return await this.run(resourceNames, child, options)
        } finally {
          resourceScopeActive = false
        }
      },
    })
  }
}

function delayEndpointDiscovery(): DiscoveryGate {
  let markStarted!: () => void
  let releaseFetch!: (response: Response) => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const response = new Promise<Response>((resolve) => {
    releaseFetch = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request) => {
      const href = url instanceof Request ? url.url : String(url)
      if (!href.includes('/endpoints')) throw new Error(`Unexpected fetch during test: ${href}`)
      markStarted()
      return response
    }),
  )
  return {
    started,
    release() {
      releaseFetch(
        new Response(JSON.stringify(endpointsPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    },
  }
}

async function* completedStream(text = 'done'): AsyncGenerator<AssistantStreamChunk> {
  yield {
    type: 'delta',
    chunk: {
      id: 'freshness-generation',
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
    },
  }
}

async function reset(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

type ExecuteInterceptor = (
  permit: WorkspaceWriteAuthority,
  command: WorkspaceCommand,
  next: WorkspaceRepository['execute'],
) => Promise<unknown>

let executeInterceptor: ExecuteInterceptor | undefined

beforeEach(async () => {
  await reset()
  __setLockBackendForTests(new LogicalTestLockBackend())
  await openBrowserWorkspace()
  const target = getBrowserRepository()
  const next = target.execute.bind(target)
  __setWorkspaceRepositoryForTests(
    repositoryProxy(target, (async (permit, command) => {
      const interceptor = executeInterceptor
      return interceptor ? interceptor(permit, command, next) : next(permit, command)
    }) as WorkspaceRepository['execute']),
  )
  await installGenerationProfile(profile(), { 'freshness-key': 'sk-test' })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  executeInterceptor = undefined
  __resetWorkspaceRepositoryForTests()
  await shutdownBrowserWorkspace()
  __setLockBackendForTests(null)
  await reset()
})

describe('send-context freshness', () => {
  it('allows an off-path sibling during delayed send planning', async () => {
    const chat = await createChat({ settings: settings() })
    const { handle, discovery, openStream } = await delayedGeneration({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'original question' }],
    })
    const prepared = await within(handle.prepared, 'prepared admission')
    await within(discovery.started, 'endpoint discovery')
    const userId = required(prepared.userMessageId, 'prepared user')

    await within(
      executeMessageCommand({
        kind: 'message.insert-sibling',
        input: {
          chatId: chat.id,
          targetId: userId,
          content: [{ type: 'text', text: 'concurrent sibling' }],
        },
      }),
      'off-path sibling insertion',
    )
    discovery.release()

    await expect(within(handle.completed, 'generation completion')).resolves.toMatchObject({
      outcome: 'done',
    })
    expect(openStream).toHaveBeenCalledOnce()
    expect((await message(prepared.assistantMessageId))?.parentId).toBe(userId)
  })

  it('canonicalizes an on-path edit as an error without removing the painted placeholder', async () => {
    const chat = await createChat({ settings: settings() })
    const { handle, discovery, openStream } = await delayedGeneration({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'before edit' }],
    })
    const prepared = await handle.prepared
    await discovery.started
    const userId = required(prepared.userMessageId, 'prepared user')

    await executeMessageCommand({
      kind: 'message.edit-content',
      input: {
        chatId: chat.id,
        messageId: userId,
        content: [{ type: 'text', text: 'after edit' }],
      },
    })
    discovery.release()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })
    expect(openStream).not.toHaveBeenCalled()
    expect(await message(prepared.assistantMessageId)).toMatchObject({
      id: prepared.assistantMessageId,
      role: 'assistant',
      generation: { status: 'error' },
    })
  })

  it('rejects a parent edit during delayed reply planning through the same dispatch guard', async () => {
    const chat = await createChat({ settings: settings() })
    const user = await seedUser(chat.id, 'before edit')
    const { handle, discovery, openStream } = await delayedGeneration({
      kind: 'reply',
      chatId: chat.id,
      parentUserId: user.id,
    })
    const prepared = await handle.prepared
    await discovery.started

    await executeMessageCommand({
      kind: 'message.edit-content',
      input: {
        chatId: chat.id,
        messageId: user.id,
        content: [{ type: 'text', text: 'after edit' }],
      },
    })
    discovery.release()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })
    expect(openStream).not.toHaveBeenCalled()
    expect(await message(prepared.assistantMessageId)).toMatchObject({
      role: 'assistant',
      generation: { status: 'error' },
    })
  })

  it('keeps an admitted regenerate on its frozen slot when the old target later moves', async () => {
    const { chatId, user, assistant } = await seedAssistantBranch()
    const { handle, discovery, openStream } = await delayedGeneration({
      kind: 'regenerate',
      chatId,
      targetAssistantId: assistant.id,
    })
    const prepared = await handle.prepared
    await discovery.started

    const inserted = await (async () => {
      try {
        return await executeMessageCommand({
          kind: 'message.insert-between',
          input: {
            chatId,
            parentId: user.id,
            childId: assistant.id,
            content: [{ type: 'text', text: 'concurrent structural change' }],
            role: 'system',
          },
        })
      } finally {
        discovery.release()
      }
    })()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledOnce()
    expect((await messageHeader(assistant.id))?.parentId).toBe(inserted.messageId)
    expect(await message(prepared.assistantMessageId)).toMatchObject({
      parentId: user.id,
      generation: { status: 'done' },
    })
  })

  it('routes public insert-between and delete-splice through the complete mutation adapter', async () => {
    const { chatId, user, assistant } = await seedAssistantBranch()
    const inserted = await executeMessageCommand({
      kind: 'message.insert-between',
      input: {
        chatId,
        parentId: user.id,
        childId: assistant.id,
        content: [{ type: 'text', text: 'temporary middle' }],
        role: 'system',
      },
    })
    expect((await messageHeader(assistant.id))?.parentId).toBe(inserted.messageId)

    const deleted = await executeMessageCommand({
      kind: 'message.delete',
      mode: 'single',
      input: {
        chatId,
        messageId: inserted.messageId,
        activeLeafId: assistant.id,
      },
    })

    expect(deleted.effects.tombstoned).toEqual([inserted.messageId])
    expect(deleted.effects.reparented).toContainEqual({
      id: assistant.id,
      previousParentId: inserted.messageId,
      newParentId: user.id,
    })
    expect(await messageHeader(inserted.messageId)).toMatchObject({ deleted: true })
    expect(await messageHeader(assistant.id)).toMatchObject({ parentId: user.id })
  })

  it('deletes an imported intermediate node on a branch deeper than the direct fanout budget', async () => {
    const chat = await createChat({ settings: settings() })
    const imported = await importMessagesOp({
      chatId: chat.id,
      slot: { kind: 'at-end' },
      activeLeafId: null,
      messages: Array.from({ length: 70 }, (_unused, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content:
          index % 2 === 0
            ? [{ type: 'text' as const, text: `imported user ${index}` }]
            : [{ type: 'output_text' as const, text: `imported assistant ${index}` }],
      })),
    })
    const parent = required(imported.presentations[0]?.message, 'deep imported parent')
    const target = required(imported.presentations[1]?.message, 'deep imported target')
    const child = required(imported.presentations[2]?.message, 'deep imported child')
    const leaf = required(imported.presentations.at(-1)?.message, 'deep imported leaf')

    const admission = await runWorkspaceAction('message-structure', (permit) =>
      tryExecuteBrowserWorkspaceCommandWithinFanoutBudget(permit, {
        kind: 'message.delete',
        mode: 'single',
        input: {
          chatId: chat.id,
          messageId: target.id,
          activeLeafId: leaf.id,
        },
      }),
    )

    if (admission.kind === 'staging-required') {
      throw new Error(`DeepDeleteUnexpectedStaging:${JSON.stringify(admission.reason)}`)
    }
    expect(await messageHeader(target.id)).toMatchObject({ deleted: true })
    expect(await messageHeader(child.id)).toMatchObject({ parentId: parent.id })
  })

  it('keeps click-time prompt settings frozen when the chat changes after admission', async () => {
    const chat = await createChat({ settings: settings({ sampling: { temperature: 0.8 } }) })
    const { handle, discovery, openStream, wires } = await delayedGeneration({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'question' }],
    })
    const prepared = await handle.prepared
    await discovery.started

    await configurationApplication.patchChatSettings(chat.id, {
      sampling: { temperature: 0.25 },
    })
    discovery.release()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledOnce()
    expect(wires[0]).toMatchObject({ temperature: 0.8 })
    expect(await message(prepared.assistantMessageId)).toMatchObject({
      generation: { status: 'done' },
    })
  })

  it('does not invalidate for another chat or same-chat catalog metadata', async () => {
    const chat = await createChat({ settings: settings() })
    const unrelated = await createChat({ settings: settings() })
    const { handle, discovery, openStream } = await delayedGeneration({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'question' }],
    })
    await handle.prepared
    await discovery.started

    await configurationApplication.patchChatSettings(unrelated.id, {
      sampling: { temperature: 0.5 },
    })
    await touchLastViewed(chat.id, Date.now() + 10_000)
    await setManualTitle(chat.id, 'renamed while planning')
    discovery.release()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledOnce()
  })

  it('does not confuse calibration bookkeeping with an outbound-context change', async () => {
    const chat = await createChat({ settings: settings() })
    const { handle, discovery, openStream } = await delayedGeneration({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'question' }],
    })
    await handle.prepared
    await discovery.started

    await runWorkspaceAction('message-edit', (permit) =>
      getWorkspaceRepository().execute(permit, {
        kind: 'chat.calibration.clear-all',
        now: Date.now(),
      }),
    )
    discovery.release()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledOnce()
  })

  it('dispatches with compact scalar prompt proofs rather than body snapshots', async () => {
    const chat = await createChat({ settings: settings() })
    await warmEndpointCache()
    let dispatch: Extract<WorkspaceCommand, { kind: 'attempt.dispatch' }> | undefined
    executeInterceptor = async (permit, command, next) => {
      if (command.kind === 'attempt.dispatch') dispatch = structuredClone(command)
      return next(permit, command)
    }

    const handle = await start({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'proof shape' }],
    })
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    const proofs = required(dispatch, 'dispatch command').input.readSet.messages
    expect(proofs.length).toBeGreaterThan(0)
    for (const proof of proofs) {
      expect(Object.keys(proof).sort()).toEqual(
        ['messageId', 'parentId', 'requestContextVersion'].sort(),
      )
      expect(proof).not.toHaveProperty('deleted')
      expect(proof).not.toHaveProperty('bodyVersion')
      expect(proof).not.toHaveProperty('content')
      expect(proof).not.toHaveProperty('generation')
    }
  })

  it('validates dispatch proofs without re-reading cold message bodies', async () => {
    const chat = await createChat({ settings: settings() })
    await warmEndpointCache()
    const bodyGet = vi.spyOn(getDb().messageBodies, 'get')
    const bodyBulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')
    let validationBodyReads: { get: number; bulkGet: number } | undefined
    executeInterceptor = async (permit, command, next) => {
      if (command.kind !== 'attempt.dispatch') return next(permit, command)
      bodyGet.mockClear()
      bodyBulkGet.mockClear()
      const result = await next(permit, command)
      validationBodyReads = {
        get: bodyGet.mock.calls.length,
        bulkGet: bodyBulkGet.mock.calls.length,
      }
      return result
    }

    const handle = await start({
      kind: 'send',
      chatId: chat.id,
      target: { kind: 'fixed', messageId: null },
      content: [{ type: 'text', text: 'bodyless validation' }],
    })
    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(validationBodyReads).toEqual({ get: 0, bulkGet: 0 })
  })

  it.each([
    'target',
    'ancestor',
  ] as const)('keeps delayed Continue coherent when a %s edit races planning', async (changedMessage) => {
    const { chatId, user, assistant } = await seedAssistantBranch()
    const { handle, discovery, openStream } = await delayedGeneration({
      kind: 'continue',
      chatId,
      targetAssistantId: assistant.id,
    })
    await handle.prepared
    await discovery.started
    const messageId = changedMessage === 'target' ? assistant.id : user.id

    const edit = executeMessageCommand({
      kind: 'message.edit-content',
      input: {
        chatId,
        messageId,
        content: [
          {
            type: changedMessage === 'target' ? 'output_text' : 'text',
            text: `${changedMessage} changed`,
          },
        ],
      },
    })

    if (changedMessage === 'target') {
      await expect(edit).rejects.toThrow(`StreamTargetBusy:${assistant.id}`)
      discovery.release()

      await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
      expect(openStream).toHaveBeenCalledOnce()
      const target = required(await message(assistant.id), 'continuation target')
      expect(target.continuationAttempts).toEqual([
        expect.objectContaining({ streamId: handle.streamId, status: 'done' }),
      ])
      expect(target.content).toEqual([{ type: 'output_text', text: 'partialdone' }])
      return
    }

    await edit
    discovery.release()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'error' })
    expect(openStream).not.toHaveBeenCalled()
    const target = required(await message(assistant.id), 'continuation target')
    expect(target.continuationAttempts).toEqual([
      expect.objectContaining({ streamId: handle.streamId, status: 'error' }),
    ])
    expect(target.content).toEqual([
      {
        type: 'output_text',
        text: 'partial',
      },
    ])
  })

  it('records a pre-dispatch Continue abort and never opens the transport', async () => {
    const { chatId, assistant } = await seedAssistantBranch()
    const { handle, discovery, openStream } = await delayedGeneration({
      kind: 'continue',
      chatId,
      targetAssistantId: assistant.id,
    })
    await handle.prepared
    await discovery.started

    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    discovery.release()

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'abort' })
    expect(openStream).not.toHaveBeenCalled()
    const target = required(await message(assistant.id), 'continuation target')
    expect(target.content).toEqual(assistant.content)
    expect(target.continuationAttempts).toEqual([
      expect.objectContaining({
        streamId: handle.streamId,
        status: 'abort',
        abortReason: 'user',
      }),
    ])
    expect(await streamLeases(chatId)).toEqual([])
  })
})

async function delayedGeneration(intent: GenerationIntent): Promise<{
  handle: GenerationHandle
  discovery: DiscoveryGate
  openStream: ReturnType<
    typeof vi.fn<(input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>>
  >
  wires: Record<string, unknown>[]
}> {
  await clearEndpointsCacheForProfile(profile().id)
  const discovery = delayEndpointDiscovery()
  const wires: Record<string, unknown>[] = []
  const openStream = vi.fn((input: GenerationTransportInput) => {
    wires.push(structuredClone(input.requestPlan.wire))
    return completedStream()
  })
  const handle = await startControlledGeneration(intent, {
    profile: profile(),
    keyMaterial: { 'freshness-key': 'sk-test' },
    openStream,
  })
  return { handle, discovery, openStream, wires }
}

async function start(intent: GenerationIntent): Promise<GenerationHandle> {
  return startControlledGeneration(intent, {
    profile: profile(),
    keyMaterial: { 'freshness-key': 'sk-test' },
    openStream: () => completedStream(),
  })
}

async function warmEndpointCache(): Promise<void> {
  await putCachedEndpoints(profile().id, MODEL, endpointsPayload)
}

async function seedUser(chatId: string, text: string): Promise<Message> {
  const imported = await importMessagesOp({
    chatId,
    slot: { kind: 'at-end' },
    activeLeafId: null,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  })
  return required(imported.presentations[0]?.message, 'seed user')
}

async function seedAssistantBranch(): Promise<{
  chatId: string
  user: Message
  assistant: Message
}> {
  const chat = await createChat({ settings: settings() })
  const imported = await importMessagesOp({
    chatId: chat.id,
    slot: { kind: 'at-end' },
    activeLeafId: null,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] },
    ],
  })
  return {
    chatId: chat.id,
    user: required(imported.presentations[0]?.message, 'seed user'),
    assistant: required(imported.presentations[1]?.message, 'seed assistant'),
  }
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

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), 1_000),
    ),
  ])
}

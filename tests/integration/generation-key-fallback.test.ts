import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
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
import { __resetDbForTests } from '../../src/store/db'
import {
  createGenerationEngine,
  type GenerationHandle,
  type GenerationIntent,
} from '../../src/store/generation-engine'
import { getKey } from '../../src/store/keys'
import { recoverStreamOrphan } from '../../src/store/stream-recovery'
import type { WorkspaceRepository } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'
import { useUiStore } from '../../src/store/zustand/uiStore'
import { createChat } from '../helpers/chats'
import { putCachedEndpoints } from '../helpers/discovery-cache'
import {
  installGenerationProfile,
  prepareControlledGenerationSurface,
  requestGenerationStop,
  requireStartedGeneration,
  startGenerationForIntent,
} from '../helpers/generation-engine'
import { readTestMessages } from '../helpers/message-storage'

const DB_NAME = 'natter'
const MODEL = 'google/gemini-3.1-flash-lite-preview'
const PRIMARY_KEY = 'primary-secret'
const FALLBACK_KEY = 'fallback-secret'
let testEpoch: number | undefined
const activeHandles = new Set<GenerationHandle>()

function testNow(offset = 0): number {
  testEpoch ??= Date.now()
  return testEpoch + offset
}

function profile(): ConnectionProfile {
  return {
    id: 'prof',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-primary',
    apiKeyFallbackRefs: ['key-fallback'],
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
    profileId: 'prof',
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

function authError(status = 401): Response {
  return new Response(JSON.stringify({ error: { code: status, message: 'rejected key' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ordinaryRateLimit(): Response {
  return new Response(JSON.stringify({ error: { code: 429, message: 'slow down' } }), {
    status: 429,
    headers: { 'content-type': 'application/json' },
  })
}

function successSse(text: string, imageUrl?: string): Response {
  const delta: Record<string, unknown> = { role: 'assistant', content: text }
  if (imageUrl) delta.images = [{ type: 'image_url', image_url: { url: imageUrl } }]
  const chunk = {
    id: 'generation-fallback',
    model: 'provider/fallback-model',
    choices: [{ delta, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      cost: 0.01,
    },
  }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'x-generation-id': 'generation-fallback',
    },
  })
}

function requestHeaders(call: unknown[]): Headers {
  const init = call[1] as RequestInit | undefined
  return new Headers(init?.headers)
}

function requestBody(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined
  return typeof init?.body === 'string' ? init.body : undefined
}

function postCalls(fetchMock: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined
    return init?.method === 'POST'
  })
}

function expectTwoIdenticalCandidatePosts(fetchMock: ReturnType<typeof vi.fn>): void {
  const posts = postCalls(fetchMock)
  expect(posts).toHaveLength(2)
  expect(posts.map((call) => String(call[0]))).toEqual([
    'https://openrouter.ai/api/v1/chat/completions',
    'https://openrouter.ai/api/v1/chat/completions',
  ])
  expect(posts.map(requestBody)).toEqual([requestBody(posts[0] ?? []), requestBody(posts[0] ?? [])])
  expect(requestBody(posts[0] ?? [])).toBeTruthy()
  expect(posts.map((call) => requestHeaders(call).get('Authorization'))).toEqual([
    `Bearer ${PRIMARY_KEY}`,
    `Bearer ${FALLBACK_KEY}`,
  ])
}

type TextContentItem = Extract<Message['content'][number], { type: 'text' | 'output_text' }>

function messageText(message: Message | undefined): string {
  if (!message) return ''
  return message.content
    .filter((item): item is TextContentItem => item.type === 'text' || item.type === 'output_text')
    .map((item) => item.text)
    .join('')
}

async function messagesFor(chatId: string): Promise<Message[]> {
  return readTestMessages(chatId)
}

async function messageFor(messageId: string): Promise<Message | undefined> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'message.presentation', messageId })
      .then((envelope) => envelope.value?.message),
  )
}

async function leasesFor(chatId: string) {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'stream.leases', chatId })
      .then((envelope) => envelope.value),
  )
}

async function framesFor(streamId: string) {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, {
        kind: 'stream.journal-frame-page',
        streamId,
        afterSeq: -1,
        throughSeq: Number.MAX_SAFE_INTEGER,
      })
      .then((envelope) => envelope.value.frames),
  )
}

async function start(intent: GenerationIntent, now: number): Promise<GenerationHandle> {
  const releaseSurface = await prepareControlledGenerationSurface(intent, { profile: profile() })
  try {
    const handle = requireStartedGeneration(
      startGenerationForIntent(createGenerationEngine({ now: () => now }), intent),
    )
    activeHandles.add(handle)
    void handle.completed.finally(() => activeHandles.delete(handle))
    return handle
  } finally {
    releaseSurface()
  }
}

async function startSend(chatId: string, text: string, now: number): Promise<GenerationHandle> {
  const chat = await getChat(chatId)
  if (!chat) throw new Error(`chat ${chatId} missing`)
  return start(
    {
      kind: 'send',
      chatId,
      expectedLeafId: chat.lastUpdatedLeafId,
      content: [{ type: 'text', text }],
    },
    now,
  )
}

async function send(chatId: string, text: string, now: number) {
  return (await startSend(chatId, text, now)).completed
}

async function completedTurn(chatId: string, now: number): Promise<Message> {
  const fetchMock = vi.fn().mockResolvedValue(successSse('partial'))
  vi.stubGlobal('fetch', fetchMock)
  const result = await send(chatId, 'write a sentence', now)
  expect(result.outcome).toBe('done')
  const assistant = await messageFor(result.assistantMessageId)
  if (!assistant) throw new Error('seed assistant missing')
  return assistant
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 80; attempt += 1) {
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

async function reset(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  useUiStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  testEpoch = undefined
  await reset()
  await openBrowserWorkspace()
  await installGenerationProfile(profile(), {
    'key-primary': PRIMARY_KEY,
    'key-fallback': FALLBACK_KEY,
  })
  await putCachedEndpoints('prof', MODEL, {
    id: MODEL,
    endpoints: [
      {
        provider_name: 'Test Clean',
        provider_slug: 'test-clean',
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
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.allSettled(
    [...activeHandles].map(async (handle) => {
      const stop = await requestGenerationStop(handle)
      await stop.completed
      await handle.completed
    }),
  )
  activeHandles.clear()
  await shutdownBrowserWorkspace()
  await reset()
})

describe('production generation key fallback', () => {
  it('ordinary send rotates before SSE consumption and uses the accepted key for generated output', async () => {
    const chat = await createChat({ settings: settings() })
    const imageUrl = 'https://openrouter.ai/api/v1/videos/generated/fallback-image.png'
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authError())
      .mockResolvedValueOnce(successSse('ordinary answer', imageUrl))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await send(chat.id, 'ordinary question', testNow(100))

    expect(result.outcome).toBe('done')
    expectTwoIdenticalCandidatePosts(fetchMock)
    await eventually(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const downloadCall = fetchMock.mock.calls[2] ?? []
    expect(String(downloadCall[0])).toBe(imageUrl)
    expect(requestHeaders(downloadCall).get('Authorization')).toBe(`Bearer ${FALLBACK_KEY}`)
    expect((await getKey('key-fallback'))?.lastUsedAt).toBeDefined()
    expect((await getKey('key-primary'))?.lastUsedAt).toBeUndefined()
    const rows = await messagesFor(chat.id)
    expect(rows).toHaveLength(2)
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(messageText(assistant)).toBe('ordinary answer')
    expect(assistant?.content.filter((item) => item.type === 'output_image')).toHaveLength(1)
    expect(assistant?.attachmentRefs).toHaveLength(1)
  })

  it('prefers the accepted fallback only for later attempts in the same tab and chat', async () => {
    const preferredChat = await createChat({ settings: settings() })
    const configuredOrderChat = await createChat({ settings: settings() })
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(authError())
      .mockResolvedValueOnce(successSse('first answer'))
    vi.stubGlobal('fetch', firstFetch)

    expect((await send(preferredChat.id, 'first question', testNow(120))).outcome).toBe('done')
    expectTwoIdenticalCandidatePosts(firstFetch)

    const preferredFetch = vi.fn().mockResolvedValue(successSse('second answer'))
    vi.stubGlobal('fetch', preferredFetch)
    expect((await send(preferredChat.id, 'second question', testNow(130))).outcome).toBe('done')
    expect(postCalls(preferredFetch)).toHaveLength(1)
    expect(requestHeaders(postCalls(preferredFetch)[0] ?? []).get('Authorization')).toBe(
      `Bearer ${FALLBACK_KEY}`,
    )

    const independentFetch = vi.fn().mockResolvedValue(successSse('independent answer'))
    vi.stubGlobal('fetch', independentFetch)
    expect((await send(configuredOrderChat.id, 'independent question', testNow(140))).outcome).toBe(
      'done',
    )
    expect(postCalls(independentFetch)).toHaveLength(1)
    expect(requestHeaders(postCalls(independentFetch)[0] ?? []).get('Authorization')).toBe(
      `Bearer ${PRIMARY_KEY}`,
    )
  })

  it('recovers accepted-key metadata from the lease after post-commit interruption', async () => {
    const chat = await createChat({ settings: settings() })
    const repository = getBrowserRepository()
    let prepareCalls = 0
    let interrupted = false
    const wrapped = new Proxy({} as WorkspaceRepository, {
      get(_target, property) {
        if (property !== 'execute') {
          const member = Reflect.get(repository, property) as unknown
          return typeof member === 'function'
            ? (...args: unknown[]): unknown => Reflect.apply(member, repository, args) as unknown
            : member
        }
        return async (
          permit: Parameters<WorkspaceRepository['execute']>[0],
          command: Parameters<WorkspaceRepository['execute']>[1],
          options: Parameters<WorkspaceRepository['execute']>[2],
        ) => {
          if (command.kind === 'attempt.prepare') prepareCalls += 1
          if (command.kind === 'generation.post-commit-metadata' && !interrupted) {
            interrupted = true
            throw new Error('post-commit interrupted')
          }
          return repository.execute(permit, command, options)
        }
      },
    })
    __setWorkspaceRepositoryForTests(wrapped)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authError())
      .mockResolvedValueOnce(successSse('recoverable answer'))
    vi.stubGlobal('fetch', fetchMock)
    const handle = await startSend(chat.id, 'recover key metadata', testNow())

    await expect(handle.completed).resolves.toMatchObject({ outcome: 'done' })
    expect(prepareCalls).toBe(1)
    expect(interrupted).toBe(true)
    expect((await getKey('key-fallback'))?.lastUsedAt).toBeUndefined()
    const interruptedLeases = await leasesFor(chat.id)
    expect(interruptedLeases).toHaveLength(1)
    expect(interruptedLeases[0]?.streamId).toBe(handle.streamId)
    expect(typeof interruptedLeases[0]?.canonicalAt).toBe('number')
    expect(interruptedLeases[0]?.postCommit.selectedKeyId).toBe('key-fallback')

    __resetWorkspaceRepositoryForTests()
    __setWorkspaceRepositoryForTests(wrapped)
    let recovery: Awaited<ReturnType<typeof recoverStreamOrphan>> = 'deferred'
    await eventually(async () => {
      recovery = await recoverStreamOrphan({ streamId: handle.streamId }, testNow(60_000))
      expect(recovery).not.toBe('deferred')
    })
    expect(['recovered', 'resolved']).toContain(recovery)
    expect(prepareCalls).toBe(1)
    expect((await getKey('key-fallback'))?.lastUsedAt).toBeDefined()
    expect(await leasesFor(chat.id)).toEqual([])
  })

  it('explicit regenerate rotates once and commits one new assistant sibling', async () => {
    const chat = await createChat({ settings: settings() })
    const original = await completedTurn(chat.id, testNow(150))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authError())
      .mockResolvedValueOnce(successSse('regenerated answer'))
    vi.stubGlobal('fetch', fetchMock)

    const handle = await start(
      { kind: 'regenerate', chatId: chat.id, targetAssistantId: original.id },
      testNow(200),
    )
    const result = await handle.completed

    expect(result.outcome).toBe('done')
    expectTwoIdenticalCandidatePosts(fetchMock)
    const rows = await messagesFor(chat.id)
    expect(rows).toHaveLength(3)
    const assistants = rows.filter((row) => row.role === 'assistant')
    expect(assistants).toHaveLength(2)
    expect(assistants.map((row) => row.parentId)).toEqual([original.parentId, original.parentId])
    expect(messageText(assistants.find((row) => row.id === original.id))).toBe('partial')
    expect(messageText(assistants.find((row) => row.id === result.assistantMessageId))).toBe(
      'regenerated answer',
    )
  })

  it('Continue rotates once and appends one continuation to the existing assistant', async () => {
    const chat = await createChat({
      settings: settings({
        continuePrefill: false,
        continueSystemPrompt: 'Continue the assistant response.',
        continueUserPrompt: 'Continue from the exact next token.',
      }),
    })
    const assistant = await completedTurn(chat.id, testNow(250))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authError())
      .mockResolvedValueOnce(successSse(' continued'))
    vi.stubGlobal('fetch', fetchMock)

    const handle = await start(
      { kind: 'continue', chatId: chat.id, targetAssistantId: assistant.id },
      testNow(300),
    )
    const result = await handle.completed

    expect(result.outcome).toBe('done')
    expectTwoIdenticalCandidatePosts(fetchMock)
    const rows = await messagesFor(chat.id)
    expect(rows).toHaveLength(2)
    const stored = rows.find((row) => row.id === assistant.id)
    expect(messageText(stored)).toBe('partial continued')
    expect(stored?.continuationAttempts).toHaveLength(1)
    expect(stored?.continuationAttempts?.[0]).toMatchObject({
      status: 'done',
      generationId: 'generation-fallback',
    })
  })

  it('ordinary 429 makes one POST and never selects the fallback', async () => {
    const chat = await createChat({ settings: settings() })
    const fetchMock = vi.fn().mockResolvedValue(ordinaryRateLimit())
    vi.stubGlobal('fetch', fetchMock)

    const result = await send(chat.id, 'rate limited question', testNow(400))

    expect(result.outcome).toBe('error')
    expect(postCalls(fetchMock)).toHaveLength(1)
    expect(requestHeaders(fetchMock.mock.calls[0] ?? []).get('Authorization')).toBe(
      `Bearer ${PRIMARY_KEY}`,
    )
    expect((await getKey('key-fallback'))?.lastUsedAt).toBeUndefined()
    const rows = await messagesFor(chat.id)
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.role === 'assistant')).toHaveLength(1)
  })

  it('aborts a never-settling primary key resolution with the prepared turn still visible', async () => {
    const chat = await createChat({ settings: settings() })
    vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockImplementation(
      () => new Promise<ArrayBuffer>(() => {}),
    )
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handle = await startSend(chat.id, 'stop before credentials resolve', testNow(500))
    const prepared = await handle.prepared
    expect(attemptController.get(handle.streamId)).toMatchObject({
      chatId: chat.id,
      messageId: prepared.assistantMessageId,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await messagesFor(chat.id)).map((row) => row.role).sort()).toEqual([
      'assistant',
      'user',
    ])

    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    const result = await handle.completed

    expect(result.outcome).toBe('abort')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(attemptController.get(handle.streamId)).toBeUndefined()
    expect(await leasesFor(chat.id)).toEqual([])
    expect(await framesFor(handle.streamId)).toEqual([])
    expect(await messageFor(prepared.assistantMessageId)).toMatchObject({
      generation: { status: 'abort', abortReason: 'user' },
    })
  })

  it('aborts and finalizes while lazy fallback key resolution never settles', async () => {
    const chat = await createChat({ settings: settings() })
    const originalDecrypt = globalThis.crypto.subtle.decrypt.bind(globalThis.crypto.subtle)
    let decryptCalls = 0
    vi.spyOn(globalThis.crypto.subtle, 'decrypt').mockImplementation((...args) => {
      decryptCalls += 1
      if (decryptCalls === 2) return new Promise<ArrayBuffer>(() => {})
      return originalDecrypt(...args)
    })
    const fetchMock = vi.fn().mockResolvedValueOnce(authError())
    vi.stubGlobal('fetch', fetchMock)

    const handle = await startSend(chat.id, 'stop during fallback resolution', testNow(600))
    const prepared = await handle.prepared
    await eventually(() => {
      expect(decryptCalls).toBe(2)
      expect(postCalls(fetchMock)).toHaveLength(1)
    })

    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    const result = await handle.completed

    expect(result.outcome).toBe('abort')
    expect(result.assistantMessageId).toBe(prepared.assistantMessageId)
    expect(postCalls(fetchMock)).toHaveLength(1)
    expect(attemptController.get(handle.streamId)).toBeUndefined()
    expect(await leasesFor(chat.id)).toEqual([])
    expect(await framesFor(handle.streamId)).toEqual([])
    expect(await messageFor(result.assistantMessageId)).toMatchObject({
      generation: { status: 'abort', abortReason: 'user' },
    })
  })

  it('aborts Continue while the atomic dispatch freshness command is stalled', async () => {
    const chat = await createChat({
      settings: settings({
        continuePrefill: false,
        continueSystemPrompt: 'Continue the assistant response.',
        continueUserPrompt: 'Continue from the exact next token.',
      }),
    })
    const assistant = await completedTurn(chat.id, testNow(650))
    await shutdownBrowserWorkspace()
    let dispatchCalls = 0
    let markDispatchStarted!: () => void
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve
    })
    const wrapped = new Proxy({} as WorkspaceRepository, {
      get(_target, property) {
        if (property !== 'execute') {
          const current = getBrowserRepository()
          const member = Reflect.get(current, property) as unknown
          return typeof member === 'function'
            ? (...args: unknown[]): unknown => Reflect.apply(member, current, args) as unknown
            : member
        }
        return async (
          permit: Parameters<WorkspaceRepository['execute']>[0],
          command: Parameters<WorkspaceRepository['execute']>[1],
          options: Parameters<WorkspaceRepository['execute']>[2],
        ) => {
          if (command.kind !== 'attempt.dispatch') {
            return getBrowserRepository().execute(permit, command, options)
          }
          dispatchCalls += 1
          markDispatchStarted()
          return new Promise<never>((_resolve, reject) => {
            const abort = () =>
              reject(permit.signal.reason ?? new DOMException('aborted', 'AbortError'))
            permit.signal.addEventListener('abort', abort, { once: true })
            if (permit.signal.aborted) abort()
          })
        }
      },
    })
    __setWorkspaceRepositoryForTests(wrapped)
    await openBrowserWorkspace()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const handle = await start(
      { kind: 'continue', chatId: chat.id, targetAssistantId: assistant.id },
      testNow(700),
    )
    await handle.prepared
    await dispatchStarted
    expect(fetchMock).not.toHaveBeenCalled()
    expect(attemptController.get(handle.streamId)?.messageId).toBe(assistant.id)

    const stop = await requestGenerationStop(handle)
    await expect(stop.completed).resolves.toMatchObject({ outcome: 'accepted' })
    const result = await handle.completed

    expect(result.outcome).toBe('abort')
    expect(dispatchCalls).toBe(1)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(attemptController.get(handle.streamId)).toBeUndefined()
    expect(await leasesFor(chat.id)).toEqual([])
    expect(await messageFor(assistant.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'partial' }],
      continuationAttempts: [
        expect.objectContaining({
          streamId: handle.streamId,
          status: 'abort',
          abortReason: 'user',
        }),
      ],
    })
  })
})

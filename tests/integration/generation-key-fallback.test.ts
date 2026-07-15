import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
import { sendFromMessage, sendText } from '../../src/hooks/useChat'
import { continueAssistantInPlace } from '../../src/hooks/useContinue'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetConnectionRuntimeForTests } from '../../src/store/connection-runtime'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { putCachedEndpoints } from '../../src/store/models-cache'
import { __resetPrivacyInFlightForTests } from '../../src/store/privacy-cache'
import { __resetStreamLeasesForTests } from '../../src/store/stream-leases'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { type ActiveStream, useStreamStore } from '../../src/store/zustand/streamStore'
import { useUiStore } from '../../src/store/zustand/uiStore'

const DB_NAME = 'natter'
const MODEL = 'google/gemini-3.1-flash-lite-preview'
const PRIMARY_KEY = 'primary-secret'
const FALLBACK_KEY = 'fallback-secret'

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

function runtimeCandidate(ref: string, index: number, secret: string) {
  const resolve = vi.fn(async () => secret)
  const markUsed = vi.fn(async () => {})
  return {
    candidate: { ref, index, resolve, markUsed },
    resolve,
    markUsed,
  }
}

function candidates() {
  const primary = runtimeCandidate('key-primary', 0, PRIMARY_KEY)
  const fallback = runtimeCandidate('key-fallback', 1, FALLBACK_KEY)
  return { primary, fallback, values: [primary.candidate, fallback.candidate] }
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
  if (imageUrl) {
    delta.images = [{ type: 'image_url', image_url: { url: imageUrl } }]
  }
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

function expectFallbackSelected(runtime: ReturnType<typeof candidates>): void {
  expect(runtime.primary.resolve).toHaveBeenCalledTimes(1)
  expect(runtime.fallback.resolve).toHaveBeenCalledTimes(1)
  expect(runtime.primary.markUsed).not.toHaveBeenCalled()
  expect(runtime.fallback.markUsed).toHaveBeenCalledTimes(1)
}

type TextContentItem = Extract<Message['content'][number], { type: 'text' | 'output_text' }>

function messageText(message: Message | undefined): string {
  if (!message) return ''
  return message.content
    .filter((item): item is TextContentItem => item.type === 'text' || item.type === 'output_text')
    .map((item) => item.text)
    .join('')
}

async function putMessage(message: Message): Promise<void> {
  await getBrowserRepository().runMutation(
    [
      { kind: 'message', messageId: message.id },
      { kind: 'children', chatId: message.chatId, parentId: message.parentId },
    ],
    async (ctx) => {
      await ctx.putMessage(message)
    },
  )
}

function seededMessage(
  chatId: string,
  id: string,
  role: Message['role'],
  text: string,
  overrides: Partial<Message> = {},
): Message {
  return {
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: `${id}:turn`,
    turnIndex: 0,
    createdAt: 1,
    role,
    origin: role === 'assistant' ? 'generated' : 'user',
    content: [{ type: role === 'assistant' ? 'output_text' : 'text', text }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

async function reset(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetConnectionRuntimeForTests()
  __resetPrivacyInFlightForTests()
  __resetStreamLeasesForTests()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  useUiStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openDb()
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
  vi.unstubAllGlobals()
  await reset()
})

describe('production generation key fallback', () => {
  it('ordinary send rotates before SSE consumption and uses the accepted key for generated output', async () => {
    const chat = await createChat({ settings: settings() })
    const runtime = candidates()
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

    const result = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'legacy-key-must-not-be-used',
      apiKeyCandidates: runtime.values,
      content: [{ type: 'text', text: 'ordinary question' }],
      now: () => 100,
    })

    expect(result.outcome).toBe('done')
    expectTwoIdenticalCandidatePosts(fetchMock)
    expectFallbackSelected(runtime)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const downloadCall = fetchMock.mock.calls[2] ?? []
    expect(String(downloadCall[0])).toBe(imageUrl)
    expect(requestHeaders(downloadCall).get('Authorization')).toBe(`Bearer ${FALLBACK_KEY}`)
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(2)
    const assistant = rows.find((row) => row.role === 'assistant')
    expect(messageText(assistant)).toBe('ordinary answer')
    expect(assistant?.content.filter((item) => item.type === 'output_image')).toHaveLength(1)
    expect(assistant?.attachmentRefs).toHaveLength(1)
  })

  it('sendFromMessage/regenerate rotates once and commits one assistant sibling', async () => {
    const chat = await createChat({ settings: settings() })
    const parent = seededMessage(chat.id, 'existing-user', 'user', 'regenerate this')
    await putMessage(parent)
    const runtime = candidates()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authError())
      .mockResolvedValueOnce(successSse('regenerated answer'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendFromMessage({
      chatId: chat.id,
      parentMessageId: parent.id,
      connection: profile(),
      apiKey: 'legacy-key-must-not-be-used',
      apiKeyCandidates: runtime.values,
      now: () => 200,
    })

    expect(result.outcome).toBe('done')
    expectTwoIdenticalCandidatePosts(fetchMock)
    expectFallbackSelected(runtime)
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(2)
    const assistants = rows.filter((row) => row.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.parentId).toBe(parent.id)
    expect(messageText(assistants[0])).toBe('regenerated answer')
  })

  it('Continue rotates once and appends one continuation to the existing assistant', async () => {
    const chat = await createChat({
      settings: settings({
        continuePrefill: false,
        continueSystemPrompt: 'Continue the assistant response.',
        continueUserPrompt: 'Continue from the exact next token.',
      }),
    })
    const user = seededMessage(chat.id, 'continue-user', 'user', 'write a sentence')
    const assistant = seededMessage(chat.id, 'continue-assistant', 'assistant', 'partial', {
      parentId: user.id,
      turnIndex: 1,
      generation: {
        id: 'original-generation',
        model: 'original-model',
        requestedModel: MODEL,
        apiUsed: 'chat',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
        finishReason: 'length',
      },
    })
    await putMessage(user)
    await putMessage(assistant)
    const runtime = candidates()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authError())
      .mockResolvedValueOnce(successSse(' continued'))
    vi.stubGlobal('fetch', fetchMock)

    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: profile(),
      apiKey: 'legacy-key-must-not-be-used',
      apiKeyCandidates: runtime.values,
      now: () => 300,
    })

    expectTwoIdenticalCandidatePosts(fetchMock)
    expectFallbackSelected(runtime)
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(2)
    const stored = rows.find((row) => row.id === assistant.id)
    expect(messageText(stored)).toBe('partial continued')
    expect(stored?.continuationAttempts).toHaveLength(1)
    expect(stored?.continuationAttempts?.[0]).toMatchObject({
      status: 'done',
      generationId: 'generation-fallback',
    })
  })

  it('ordinary 429 makes one POST and never selects or resolves the fallback', async () => {
    const chat = await createChat({ settings: settings() })
    const runtime = candidates()
    const fetchMock = vi.fn().mockResolvedValue(ordinaryRateLimit())
    vi.stubGlobal('fetch', fetchMock)

    const result = await sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'legacy-key-must-not-be-used',
      apiKeyCandidates: runtime.values,
      content: [{ type: 'text', text: 'rate limited question' }],
      now: () => 400,
    })

    expect(result.outcome).toBe('error')
    expect(postCalls(fetchMock)).toHaveLength(1)
    expect(requestHeaders(fetchMock.mock.calls[0] ?? []).get('Authorization')).toBe(
      `Bearer ${PRIMARY_KEY}`,
    )
    expect(runtime.primary.resolve).toHaveBeenCalledTimes(1)
    expect(runtime.fallback.resolve).not.toHaveBeenCalled()
    expect(runtime.primary.markUsed).not.toHaveBeenCalled()
    expect(runtime.fallback.markUsed).not.toHaveBeenCalled()
    const rows = await getBrowserRepository().listMessages(chat.id)
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.role === 'assistant')).toHaveLength(1)
  })

  it('stops a never-settling primary resolution before creating the assistant placeholder', async () => {
    const chat = await createChat({ settings: settings() })
    const primaryResolve = vi.fn(() => new Promise<string>(() => {}))
    const primaryMarkUsed = vi.fn(async () => {})
    const fallback = runtimeCandidate('key-fallback', 1, FALLBACK_KEY)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const sending = sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'legacy-key-must-not-be-used',
      apiKeyCandidates: [
        { ref: 'key-primary', index: 0, resolve: primaryResolve, markUsed: primaryMarkUsed },
        fallback.candidate,
      ],
      content: [{ type: 'text', text: 'stop before credentials resolve' }],
      now: () => 500,
    })

    let active: ActiveStream | undefined
    await eventually(() => {
      expect(primaryResolve).toHaveBeenCalledOnce()
      active = useStreamStore.getState().listByChat(chat.id)[0]
      expect(active).toBeDefined()
    })
    if (!active) throw new Error('primary-resolution stream was not admitted')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(
      (await getBrowserRepository().listMessages(chat.id)).filter(
        (row) => row.role === 'assistant',
      ),
    ).toEqual([])

    expect(useStreamStore.getState().abortStream(active.streamId, active.replacementEpoch)).toBe(
      true,
    )
    await expect(sending).rejects.toMatchObject({ name: 'AbortError' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(fallback.resolve).not.toHaveBeenCalled()
    expect(primaryMarkUsed).not.toHaveBeenCalled()
    expect(useStreamStore.getState().listByChat(chat.id)).toEqual([])
    expect(await getBrowserRepository().listStreamLeases(chat.id)).toEqual([])
    expect(
      (await getBrowserRepository().listMessages(chat.id)).filter(
        (row) => row.role === 'assistant',
      ),
    ).toEqual([])
  })

  it('stops and finalizes while a lazy fallback resolution never settles after a rejected key', async () => {
    const chat = await createChat({ settings: settings() })
    const primary = runtimeCandidate('key-primary', 0, PRIMARY_KEY)
    const fallbackResolve = vi.fn(() => new Promise<string>(() => {}))
    const fallbackMarkUsed = vi.fn(async () => {})
    const fetchMock = vi.fn().mockResolvedValueOnce(authError())
    vi.stubGlobal('fetch', fetchMock)

    const sending = sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'legacy-key-must-not-be-used',
      apiKeyCandidates: [
        primary.candidate,
        {
          ref: 'key-fallback',
          index: 1,
          resolve: fallbackResolve,
          markUsed: fallbackMarkUsed,
        },
      ],
      content: [{ type: 'text', text: 'stop during fallback resolution' }],
      now: () => 600,
    })

    let active: ActiveStream | undefined
    await eventually(() => {
      expect(fallbackResolve).toHaveBeenCalledOnce()
      active = useStreamStore.getState().listByChat(chat.id)[0]
      expect(active).toBeDefined()
    })
    if (!active) throw new Error('fallback-resolution stream was not active')
    expect(postCalls(fetchMock)).toHaveLength(1)

    expect(useStreamStore.getState().abortStream(active.streamId, active.replacementEpoch)).toBe(
      true,
    )
    const result = await sending

    expect(result.outcome).toBe('abort')
    expect(result.assistantMessageId).toBe(active.messageId)
    expect(primary.resolve).toHaveBeenCalledOnce()
    expect(fallbackResolve).toHaveBeenCalledOnce()
    expect(primary.markUsed).not.toHaveBeenCalled()
    expect(fallbackMarkUsed).not.toHaveBeenCalled()
    expect(postCalls(fetchMock)).toHaveLength(1)
    expect(useStreamStore.getState().listByChat(chat.id)).toEqual([])
    expect(await getBrowserRepository().listStreamLeases(chat.id)).toEqual([])
    expect(await getBrowserRepository().listStreamChunksForChat(chat.id)).toEqual([])
    expect(await getBrowserRepository().getMessage(result.assistantMessageId)).toMatchObject({
      generation: { status: 'abort', abortReason: 'user' },
    })
  })

  it('stops Continue while its final freshness guard never settles', async () => {
    const chat = await createChat({
      settings: settings({
        continuePrefill: false,
        continueSystemPrompt: 'Continue the assistant response.',
        continueUserPrompt: 'Continue from the exact next token.',
      }),
    })
    const user = seededMessage(chat.id, 'guard-user', 'user', 'write a sentence')
    const assistant = seededMessage(chat.id, 'guard-assistant', 'assistant', 'partial', {
      parentId: user.id,
      generation: {
        id: 'guard-generation',
        model: MODEL,
        requestedModel: MODEL,
        apiUsed: 'chat',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
      },
    })
    await putMessage(user)
    await putMessage(assistant)
    const runtime = candidates()
    const repository = getBrowserRepository()
    let freshnessReads = 0
    let finalGuardWrites = 0
    let markFinalGuardStarted: (() => void) | undefined
    const finalGuardStarted = new Promise<void>((resolve) => {
      markFinalGuardStarted = resolve
    })
    const neverSettlingFinalGuard = new Promise<never>(() => {})
    __setWorkspaceRepositoryForTests(
      new Proxy(repository, {
        get(target, property, receiver) {
          if (property === 'getSendContextRevisionSnapshot') {
            return (...args: Parameters<typeof repository.getSendContextRevisionSnapshot>) => {
              freshnessReads += 1
              return repository.getSendContextRevisionSnapshot(...args)
            }
          }
          if (property === 'runMutation') {
            return (...args: Parameters<typeof repository.runMutation>) => {
              if (args[2]?.streamFence && finalGuardWrites === 0) {
                finalGuardWrites += 1
                markFinalGuardStarted?.()
                return neverSettlingFinalGuard
              }
              return repository.runMutation(...args)
            }
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      }),
    )
    const openStream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'delta' as const,
          chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] },
        }
      },
    }))

    const continuing = continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: profile(),
      apiKey: 'legacy-key-must-not-be-used',
      apiKeyCandidates: runtime.values,
      openStream,
      now: () => 700,
    })

    await finalGuardStarted
    const active = useStreamStore
      .getState()
      .listByChat(chat.id)
      .find((stream) => stream.messageId === assistant.id)
    expect(active).toBeDefined()
    if (!active) throw new Error('Continue freshness-guard stream was not active')
    expect(openStream).not.toHaveBeenCalled()

    expect(useStreamStore.getState().abortStream(active.streamId, active.replacementEpoch)).toBe(
      true,
    )
    await continuing

    expect(freshnessReads).toBe(1)
    expect(finalGuardWrites).toBe(1)
    expect(openStream).not.toHaveBeenCalled()
    expect(runtime.primary.resolve).toHaveBeenCalledOnce()
    expect(runtime.fallback.resolve).not.toHaveBeenCalled()
    expect(useStreamStore.getState().listByChat(chat.id)).toEqual([])
    expect(await repository.listStreamLeases(chat.id)).toEqual([])
    expect(await repository.getMessage(assistant.id)).toMatchObject({
      content: [{ type: 'output_text', text: 'partial' }],
      continuationAttempts: [
        expect.objectContaining({
          streamId: active.streamId,
          status: 'abort',
          abortReason: 'user',
        }),
      ],
    })
  })
})

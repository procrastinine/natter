import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/api/errors'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../../src/api/types'
import { beginRouteIntent } from '../../src/app/router'
import { cursorKeyOf } from '../../src/core/active-path'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import { invalidatePostCommitTasks } from '../../src/core/post-commit-task'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
import {
  __flushPostCommitCalibrationForTests,
  nextOrphanRecoveryAt,
  recoverOrphans,
  sendFromMessage,
  sendText,
} from '../../src/hooks/useChat'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, postEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { putCachedEndpoints } from '../../src/store/models-cache'
import {
  __resetStreamLeasesForTests,
  __setStreamLockManagerForTests,
  getStreamClientId,
  installStreamLeaseListener,
  onRemoteStreamOwnershipReleased,
  streamWriteFenceForLease,
} from '../../src/store/stream-leases'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { useUiStore } from '../../src/store/zustand/uiStore'

const DB_NAME = 'natter'

function chunkFence(lease: { streamId: string; fenceToken?: string; replacementEpoch?: number }) {
  if (typeof lease.fenceToken !== 'string' || lease.replacementEpoch === undefined) {
    throw new Error(`expected fenced lease ${lease.streamId}`)
  }
  return { fenceToken: lease.fenceToken, replacementEpoch: lease.replacementEpoch }
}

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
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  useUiStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openDb()
  await seedOpenRouterDiscovery('prof', [
    'google/gemini-3.1-flash-lite-preview',
    'openai/gpt-5.4',
    'openai/gpt-4o',
    'black-forest-labs/flux.2-klein-4b',
  ])
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await reset()
})

async function messagesFor(chatId: string): Promise<Message[]> {
  return getBrowserRepository().listMessages(chatId)
}

async function seedUnfinishedAssistant(chatId: string, startedAt = 100): Promise<string> {
  const id = newId()
  await getBrowserRepository().runMutation(
    [
      { kind: 'message', messageId: id },
      { kind: 'children', chatId, parentId: null },
    ],
    async (ctx) => {
      await ctx.putMessage({
        id,
        chatId,
        parentId: null,
        siblingIndex: 0,
        turnId: newId(),
        turnIndex: 0,
        createdAt: 1,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'partial' }],
        nodeVersion: 0,
        deleted: false,
        generation: {
          id: '',
          model: 'm',
          requestedModel: 'm',
          apiUsed: 'chat',
          delivery: 'streaming',
          costSource: 'stream',
          startedAt,
        },
      })
    },
  )
  return id
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
          supported_parameters: ['temperature'],
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
  }
}

describe('sendText — chat-completions streaming', () => {
  it('keeps an explicitly detached background send from reclaiming tab navigation', async () => {
    const backgroundChat = await createChat({ settings: chatSettings() })
    const visibleChat = await createChat({ settings: chatSettings() })
    useUiStore.getState().setActiveChatId(visibleChat.id)
    const visibleIntent = useChatStore
      .getState()
      .navigateToCursor(visibleChat.id, { __root__: 'visible-message' })

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
    expect(useChatStore.getState().getCursor(backgroundChat.id)).toBeUndefined()
    expect(useChatStore.getState().isNavigationIntentCurrent(visibleIntent)).toBe(true)
    expect(window.location.hash).not.toContain(backgroundChat.id)
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

    const sendPromise = sendText({
      chatId: chat.id,
      connection: makeLlamaServerProfile(),
      apiKey: '',
      content: [{ type: 'text', text: 'hello' }],
      openStream,
    })
    await templateStarted

    const active = useStreamStore.getState().listByChat(chat.id)
    expect(active).toHaveLength(1)
    expect(active[0]?.messageId).toBeTypeOf('string')
    expect(active[0]).toMatchObject({
      attemptKind: 'generation',
      originNavigationRevision: useChatStore.getState().getNavigationRevision(chat.id),
    })
    expect(await getBrowserRepository().getMessage(active[0]?.messageId as string)).toBeUndefined()
    const midMessages = liveMessagesSortedByCreated(await messagesFor(chat.id))
    expect(midMessages).toHaveLength(1)
    expect(midMessages[0]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    })
    expect(useStreamStore.getState().abortChat(chat.id)).toBe(1)
    await expect(sendPromise).rejects.toMatchObject({ kind: 'abort' })
    expect(openStream).not.toHaveBeenCalled()
    expect(useStreamStore.getState().hasStreamForChat(chat.id)).toBe(false)
    expect(liveMessagesSortedByCreated(await messagesFor(chat.id))).toHaveLength(1)
  })

  it('persists a huge OpenRouter user row before cold provider discovery resolves', async () => {
    const controller = new AbortController()
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

    const sendPromise = sendText({
      chatId: chat.id,
      connection: profile,
      apiKey: 'sk-test',
      content: [{ type: 'text', text: hugeText }],
      openStream,
      signal: controller.signal,
    })
    await discoveryStarted

    expect(discoverySawUser).toBe(true)
    const midMessages = liveMessagesSortedByCreated(await messagesFor(chat.id))
    expect(midMessages).toHaveLength(1)
    expect(midMessages[0]?.role).toBe('user')
    const item = midMessages[0]?.content[0]
    expect(item?.type).toBe('text')
    expect(item?.type === 'text' ? item.text.length : 0).toBe(hugeText.length)
    expect(openStream).not.toHaveBeenCalled()

    controller.abort()
    await expect(sendPromise).rejects.toMatchObject({ cause: { kind: 'abort' } })
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

    const sendPromise = sendText({
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
    expect(midMessages.map((message) => message.role)).toEqual(['user', 'assistant'])
    const user = requireDefined(midMessages[0], 'user row')
    const assistant = requireDefined(midMessages[1], 'assistant row')
    expect(user.content).toEqual([{ type: 'text', text: 'slow start' }])
    expect(assistant.parentId).toBe(user.id)
    expect(assistant.content).toEqual([{ type: 'output_text', text: '' }])
    expect(useStreamStore.getState().listByChat(chat.id)[0]?.messageId).toBe(assistant.id)
    expect(useChatStore.getState().getCursor(chat.id)).toEqual({
      [cursorKeyOf(null)]: user.id,
      [cursorKeyOf(user.id)]: assistant.id,
    })
    const active = await getBrowserRepository().getActiveBranchSnapshot(chat.id, {})
    expect(active.branch.map((message) => message.id)).toEqual([user.id, assistant.id])

    release()
    await expect(sendPromise).resolves.toMatchObject({ outcome: 'done' })
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
    const [user, assistant] = all as [Message, Message]
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

    const assistant = requireDefined(
      await getBrowserRepository().getMessage(result.assistantMessageId),
      'assistant message',
    )
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
    const repo = getBrowserRepository()
    const parent: Message = {
      id: 'header-parent',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'header-parent-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'parent' }],
      nodeVersion: 0,
      deleted: false,
    }
    const liveSibling: Message = {
      id: 'header-live-sibling',
      chatId: chat.id,
      parentId: parent.id,
      siblingIndex: 2,
      turnId: 'header-live-turn',
      turnIndex: 0,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'live sibling body' }],
      nodeVersion: 0,
      deleted: false,
    }
    const tombstonedSibling: Message = {
      ...liveSibling,
      id: 'header-tombstoned-sibling',
      siblingIndex: 7,
      turnId: 'header-tombstoned-turn',
      createdAt: 3,
      content: [{ type: 'output_text', text: 'tombstoned sibling body' }],
      deleted: true,
    }
    await repo.runMutation(
      [
        { kind: 'message', messageId: parent.id },
        { kind: 'message', messageId: liveSibling.id },
        { kind: 'message', messageId: tombstonedSibling.id },
        { kind: 'children', chatId: chat.id, parentId: null },
        { kind: 'children', chatId: chat.id, parentId: parent.id },
      ],
      async (ctx) => {
        await ctx.putMessage(parent)
        await ctx.putMessage(liveSibling)
        await ctx.putMessage(tombstonedSibling)
      },
    )

    const bodyReads = vi.spyOn(getDb().messageBodies, 'bulkGet')
    const result = await sendFromMessage({
      chatId: chat.id,
      parentMessageId: parent.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: () => {
        expect(useStreamStore.getState().listByChat(chat.id)[0]).toMatchObject({
          attemptKind: 'generation',
          originNavigationRevision: useChatStore.getState().getNavigationRevision(chat.id),
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
    })

    const siblingIds = new Set([liveSibling.id, tombstonedSibling.id])
    expect(bodyReads).toHaveBeenCalled()
    expect(
      bodyReads.mock.calls.some(
        ([ids]) => ids.length === siblingIds.size && ids.every((id) => siblingIds.has(String(id))),
      ),
    ).toBe(false)
    bodyReads.mockRestore()

    const assistant = await repo.getMessage(result.assistantMessageId)
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
    expect(
      useStreamStore.getState().getLiveSnapshot(chat.id, result.assistantMessageId),
    ).toBeUndefined()
    const assistant = requireDefined(
      await getBrowserRepository().getMessage(result.assistantMessageId),
      'assistant message',
    )
    expect(assistant.content).toEqual([{ type: 'output_text', text: expectedText }])
    expect(assistant.reasoningDetails).toHaveLength(1)
    expect(assistant.reasoningDetails?.[0]).toMatchObject({
      type: 'reasoning.text',
      id: 'text#default',
      text: expectedReasoning,
    })
    const header = requireDefined(
      await getBrowserRepository().getMessageHeader(result.assistantMessageId),
      'assistant header',
    )
    expect(header.nodeVersion).toBeLessThanOrEqual(6)
  }, 15_000)

  it('publishes large live text as bounded sections and stores one final text item', async () => {
    const chat = await createChat({ settings: chatSettings() })
    useUiStore.getState().setActiveChatId(chat.id)
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
    const sendPromise = sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'large live sections' }],
      openStream: longStream,
      now: () => ++clock,
    })
    await paused
    await eventually(() => {
      const live = useStreamStore.getState().listLiveSnapshots()[0]
      expect(live?.content).toEqual([
        { type: 'output_text', text: first },
        { type: 'output_text', text: second },
      ])
    })
    release()
    const result = await sendPromise
    const assistant = requireDefined(
      await getBrowserRepository().getMessage(result.assistantMessageId),
      'assistant message',
    )
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
        seenWire = open.wireBody
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
    expect((await getBrowserRepository().getChat(chat.id))?.settings.reasoning.mode).toBe('default')
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
        seenWire = open.wireBody
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
    const storedChat = await getBrowserRepository().getChat(chat.id)
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
        seenWire = open.wireBody
        seenRouteKind = open.route?.kind
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
      settings: chatSettings({ model: 'gpt-4o', api: 'responses' }),
    })
    let seenRouteKind: string | undefined
    let seenWire: Record<string, unknown> | undefined
    const result = await sendText({
      chatId: chat.id,
      connection: makeOpenAiProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: (open) => {
        seenRouteKind = open.route?.kind
        seenWire = open.wireBody
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
      settings: chatSettings({ model: 'google/gemini-3.1-flash-lite-preview', api: 'auto' }),
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
        seenRouteKind = open.route?.kind
        seenWire = open.wireBody
        seenGeminiModelId = open.geminiModelId
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
    const assistant = messages[1] as Message
    expect(assistant.content).toEqual([{ type: 'output_text', text: 'Partial answer' }])
    expect(assistant.generation?.error?.code).toBe('429')
    expect(assistant.generation?.error?.message).toBe('rate limited')
    expect(assistant.generation?.finishedAt).toBeDefined()
  })

  it('user abort persists partial content with abortReason="user"', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const abort = new AbortController()
    let producedChunks = 0
    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'slow please' }],
      signal: abort.signal,
      // Slow async source so the abort can fire mid-stream deterministically.
      openStream: () =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'slow ' } }] },
          }
          producedChunks += 1
          // Hand the event loop back so the microtask queue can run the
          // abort() call scheduled below.
          await Promise.resolve()
          abort.abort()
          // Simulate the fetch throwing AbortError via the reader.
          throw new DOMException('aborted', 'AbortError')
        })(),
    })
    expect(producedChunks).toBe(1)
    expect(result.outcome).toBe('abort')
    const assistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'slow ' }])
    expect(assistant?.generation?.abortReason).toBe('user')
    expect(assistant?.generation?.finishedAt).toBeDefined()
  })

  it('keeps user abort classified as user when the transport throws a generic network error', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const abort = new AbortController()
    const result = await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'slow please' }],
      signal: abort.signal,
      openStream: () =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { id: 'gen-live-shape', choices: [{ delta: { content: 'slow ' } }] },
          }
          await Promise.resolve()
          abort.abort()
          throw new ApiError({
            kind: 'network',
            code: 'NETWORK',
            message: 'terminated',
            midStream: false,
            retryable: true,
          })
        })(),
    })
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

    const midChat = await getBrowserRepository().getChat(chat.id)
    const midAssistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(midAssistant?.content).toEqual([{ type: 'output_text', text: '' }])
    expect(midChat?.wordCount).toBe(2)
    expect(midChat?.totalCostUsd).toBe(0)

    release()

    const result = await sendPromise
    expect(result.outcome).toBe('done')

    const afterChat = await getBrowserRepository().getChat(chat.id)
    const afterAssistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(afterAssistant?.content).toEqual([{ type: 'output_text', text: 'Partial answer' }])
    expect(afterChat?.summaryVersion).toBe((midChat?.summaryVersion ?? 0) + 1)
    expect(afterChat?.wordCount).toBe(4)
    expect(afterChat?.totalCostUsd).toBeCloseTo(0.0002)
  })

  it('continues streaming when this tab or another tab views a different branch', async () => {
    const chat = await createChat({ settings: chatSettings() })
    useUiStore.getState().setActiveChatId(chat.id)
    const repo = getBrowserRepository()
    const root: Message = {
      id: 'root-user',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'root' }],
      nodeVersion: 0,
      deleted: false,
    }
    const left: Message = {
      id: 'left-assistant',
      chatId: chat.id,
      parentId: root.id,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'left' }],
      nodeVersion: 0,
      deleted: false,
    }
    const right: Message = {
      ...left,
      id: 'right-assistant',
      siblingIndex: 1,
      createdAt: 3,
      content: [{ type: 'output_text', text: 'right' }],
    }
    await repo.runMutation(
      [
        { kind: 'message', messageId: root.id },
        { kind: 'message', messageId: left.id },
        { kind: 'message', messageId: right.id },
        { kind: 'children', chatId: chat.id, parentId: null },
        { kind: 'children', chatId: chat.id, parentId: root.id },
      ],
      async (ctx) => {
        await ctx.putMessage(root)
        await ctx.putMessage(left)
        await ctx.putMessage(right)
      },
    )
    useChatStore.getState().navigateToCursor(chat.id, {
      [cursorKeyOf(null)]: root.id,
      [cursorKeyOf(root.id)]: left.id,
    })

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
    const sendPromise = sendText({
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
    await paused
    expect(useStreamStore.getState().hasStreamForChat(chat.id)).toBe(true)
    const liveMessageId = useStreamStore.getState().listLiveSnapshots()[0]?.messageId
    expect(liveMessageId).toBeDefined()
    const retainedBeforeBranchChange = useStreamStore
      .getState()
      .getLiveSnapshot(chat.id, liveMessageId as string)
    expect(retainedBeforeBranchChange?.content).toEqual([{ type: 'output_text', text: 'Partial ' }])

    const rightBranchCursor = {
      [cursorKeyOf(null)]: root.id,
      [cursorKeyOf(root.id)]: right.id,
    }
    useChatStore.getState().navigateToCursor(chat.id, rightBranchCursor)
    const rightBranch = await repo.getActiveBranchSnapshot(chat.id, rightBranchCursor)
    expect(rightBranch.branch.map((message) => message.id)).toEqual([root.id, right.id])
    expect(useStreamStore.getState().hasStreamForChat(chat.id)).toBe(true)

    release()
    await offBranchDeltaProcessed
    expect(useStreamStore.getState().getLiveSnapshot(chat.id, liveMessageId as string)).toBe(
      retainedBeforeBranchChange,
    )
    releaseCompletion()
    const result = await sendPromise
    expect(result.outcome).toBe('done')
    const assistant = await repo.getMessage(result.assistantMessageId)
    expect(assistant?.parentId).toBe(result.userMessageId)
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'Partial answer' }])
    expect(useChatStore.getState().getCursor(chat.id)?.[cursorKeyOf(root.id)]).toBe(right.id)
  })

  it('keeps live projection visible while an unrelated delayed route action is pending', async () => {
    const chat = await createChat({ settings: chatSettings() })
    useUiStore.getState().setActiveChatId(chat.id)
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
    const sendPromise = sendText({
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
    await firstPublished
    await eventually(() => {
      expect(useStreamStore.getState().listLiveSnapshots()[0]?.content).toEqual([
        { type: 'output_text', text: 'still ' },
      ])
    })

    beginRouteIntent()
    releaseSecond()
    await secondPublished
    await eventually(() => {
      expect(useStreamStore.getState().listLiveSnapshots()[0]?.content).toEqual([
        { type: 'output_text', text: 'still visible' },
      ])
    })

    releaseDone()
    expect((await sendPromise).outcome).toBe('done')
  })

  it('releases the stream store entry on completion', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const before = useStreamStore.getState().listActive().length
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
    const after = useStreamStore.getState().listActive().length
    expect(after).toBe(before)
    expect(await getBrowserRepository().listStreamLeases(chat.id)).toEqual([])
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
    expect(assistant?.reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        text: 'Let me',
      },
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
    const details = assistant?.reasoningDetails ?? []
    // Normalizer should have rewritten `.text` → `.summary` because format
    // is google-gemini-v1 and there's no `.signature` (Claude's signed text
    // is the counter-example that keeps the .text label).
    const summaryDetail = details.find((d) => d.type === 'reasoning.summary')
    const encryptedDetail = details.find((d) => d.type === 'reasoning.encrypted')
    expect(details.find((d) => d.type === 'reasoning.text')).toBeUndefined()
    expect(summaryDetail?.summary).toBe('**Planning**\nI will solve step by step.')
    expect(encryptedDetail?.data).toBe('sig-b64-blob')
    expect(encryptedDetail?.format).toBe('google-gemini-v1')
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
    const summaries = (assistant?.reasoningDetails ?? []).filter(
      (d) => d.type === 'reasoning.summary',
    )
    // Coalesce: both Gemini-family summary parts merge into ONE row with a
    // `\n\n` separator. The UI renders one continuous Summary block instead
    // of one block per section. See `findMergeTargetIndex` + `mergeReasoningDetail`
    // in `core/reasoning.ts`.
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.type === 'reasoning.summary' && summaries[0].summary).toBe(
      'First thought: enumerate options.\n\nSecond thought: pick the best.',
    )
  })

  it('uses cumulative structured reasoning instead of re-appending its scalar mirror', async () => {
    const chat = await createChat({ settings: chatSettings() })
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
    expect(assistant?.reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'anthropic-claude-v1',
        text: 'A ratio of Gaussians',
      },
    ])
  })

  it('keeps one Claude reasoning path when legacy deltas mirror cumulative signed details', async () => {
    const chat = await createChat({ settings: chatSettings() })
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
    expect(assistant?.reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'anthropic-claude-v1',
        text: '1 2 3 4',
        signature: 'sig-3',
      },
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
        expect(open.route?.kind).toBe('chat-completions')
        expect(open.wireBody).toMatchObject({
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
    expect(assistant?.reasoningDetails).toEqual([
      {
        type: 'reasoning.summary',
        index: 0,
        format: 'azure-openai-responses-v1',
        summary: '**Explaining**\n\nI need tokenizer',
      },
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
    const chatRow = await getBrowserRepository().getChat(chat.id)
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
      output: {
        type: 'openrouter:web_fetch',
        url: 'https://openrouter.ai/',
        content: 'The Unified Interface For LLMs',
      },
    })

    const user = requireDefined(
      all.find((message) => message.role === 'user'),
      'user',
    )
    expect(user.originalCalibrationKey).toBeUndefined()
    expect(assistant.originalCalibrationKey).toBeUndefined()
    expect(assistant.cachedTokenEstimate).toBeUndefined()
    const chatRow = await getBrowserRepository().getChat(chat.id)
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
    const chatRow = await getBrowserRepository().getChat(chat.id)
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
    const chatRow = await getBrowserRepository().getChat(chat.id)
    expect(chatRow?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-4o')]?.sampleCount).toBe(1)
    const [user, assistant] = liveMessagesSortedByCreated(await messagesFor(chat.id))
    expect(user?.originalCalibrationKey).toBeUndefined()
    expect(assistant?.originalCalibrationKey).toBe(tokenCalibrationKey('openai/gpt-4o'))
    expect(assistant?.generation?.tokenCalibration).toMatchObject({
      promptSample: false,
      completionSample: true,
      sampleCount: 1,
    })
  })

  it('does not calibrate when the assistant output includes a generated image', async () => {
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
    const chatRow = await getBrowserRepository().getChat(chat.id)
    expect(
      chatRow?.tokenCalibration?.[tokenCalibrationKey('black-forest-labs/flux.2-klein-4b')],
    ).toBeUndefined()
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
    const bundle = attachmentId
      ? await getBrowserRepository().getAttachmentBundle(attachmentId)
      : undefined
    expect(bundle?.attachment).toMatchObject({
      id: attachmentId,
      kind: 'image',
      mime: 'image/png',
      origin: 'generated-output',
      storage: { kind: 'local-blob' },
      refCount: 1,
    })
    expect(bundle?.blobs.some((blob) => blob.role === 'original')).toBe(true)
    expect(assistant?.originalCalibrationKey).toBeUndefined()
    const receiptPresentation = useChatStore
      .getState()
      .getCommittedPathPresentation(chat.id)
      ?.presentations.find((presentation) => presentation.message.id === assistant?.id)
    expect(receiptPresentation?.message.content).toContainEqual({
      type: 'output_image',
      attachmentId,
    })
  })

  it('commits raw generated output before a stalled localization and aborts the optional fetch', async () => {
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
    expect(output).toEqual({ type: 'output_image', url: imageUrl })
    expect(assistant?.attachmentRefs).toHaveLength(0)

    invalidatePostCommitTasks()
    await within(__flushPostCommitCalibrationForTests(), 'generated-output cancellation')
    expect(downloadSignal?.aborted).toBe(true)
    expect((await getBrowserRepository().getMessage(assistant?.id ?? ''))?.content).toContainEqual({
      type: 'output_image',
      url: imageUrl,
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
    const assistant = await getBrowserRepository().getMessage(result.assistantMessageId)
    expect(assistant?.content).toContainEqual({ type: 'output_image', url: imageUrl })
    await getBrowserRepository().runMutation(
      [{ kind: 'message', messageId: result.assistantMessageId }],
      (ctx) =>
        ctx.patchMessageBody(result.assistantMessageId, {
          content: [{ type: 'output_text', text: 'edited while media was downloading' }],
        }),
    )

    finishDownload(
      new Response(new Blob(['png'], { type: 'image/png' }), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    )
    await __flushPostCommitCalibrationForTests()

    expect(await getBrowserRepository().getMessage(result.assistantMessageId)).toMatchObject({
      content: [{ type: 'output_text', text: 'edited while media was downloading' }],
    })
    expect(await getDb().attachments.count()).toBe(0)
  })

  it('populates per-message calibration fields on user + assistant messages', async () => {
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
    const [user, assistant] = all as [Message, Message]
    // User message fields
    expect(user.originalCharCount).toBe(60)
    expect(user.originalModelId).toBe('openai/gpt-4o')
    expect(user.originalCalibrationKey).toBe(tokenCalibrationKey('openai/gpt-4o'))
    expect(user.charCountDelta).toBe(0)
    expect(user.cachedTokenEstimate).toBeGreaterThan(0)
    // Assistant message fields (populated on finalize for a successful done)
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
    const ctl = new AbortController()
    let now = 1_000
    const sendPromise = sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hi' }],
      signal: ctl.signal,
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
      const db = await openDb()
      expect(await db.streamChunks.count()).toBeGreaterThan(0)
    })
    const assistant = liveMessagesSortedByCreated(await messagesFor(chat.id)).find(
      (message) => message.role === 'assistant',
    )
    expect(assistant).toBeDefined()
    expect(assistant?.content).toEqual([{ type: 'output_text', text: '' }])

    ctl.abort()
    releaseStream()
    await sendPromise
    const db = await openDb()
    expect(await db.streamChunks.count()).toBe(0)
  })

  it('honors a cross-tab abort request and finalizes the owner accumulator once', async () => {
    installStreamLeaseListener()
    const chat = await createChat({ settings: chatSettings({ model: 'openai/gpt-4o' }) })
    let markPaused!: () => void
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve
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
      const db = await openDb()
      expect(await db.streamChunks.count()).toBeGreaterThan(0)
    })
    const ownerStream = useStreamStore
      .getState()
      .listActive()
      .find((stream) => stream.chatId === chat.id && stream.messageId !== undefined)
    expect(ownerStream).toBeDefined()

    postEvent({
      kind: 'stream-abort-requested',
      replacementEpoch: 0,
      chatId: chat.id,
      streamId: ownerStream?.streamId ?? '',
      ownerClientId: getStreamClientId(),
    })

    const result = await sendPromise
    expect(result.outcome).toBe('abort')
    const assistant = await getBrowserRepository().getMessage(result.assistantMessageId)
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'remote-stop partial' }])
    expect(assistant?.generation?.abortReason).toBe('user')
    const db = await openDb()
    expect(await db.streamChunks.count()).toBe(0)
    expect(await getBrowserRepository().listStreamLeases(chat.id)).toEqual([])
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
    const sendPromise = sendText({
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
      const db = await openDb()
      const rows = await db.streamChunks.toArray()
      expect(rows.some((row) => (row.event as { lane?: string }).lane === 'phase')).toBe(true)
    })
    const db = await openDb()
    const rows = await db.streamChunks.toArray()
    expect(
      rows.some((row) => {
        const event = row.event as { lane?: string; item?: { type?: string } }
        return event.lane === 'output-item-done' && event.item?.type === 'message'
      }),
    ).toBe(false)

    releaseStream()
    const result = await sendPromise
    expect(result.outcome).toBe('done')
    const assistant = await getBrowserRepository().getMessage(result.assistantMessageId)
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'phase text' }])
    expect(assistant?.phase).toBe('final_answer')
    expect(await db.streamChunks.count()).toBe(0)
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
    const chatRow = await getBrowserRepository().getChat(chat.id)
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
    const repo = getBrowserRepository()
    const orphanId = newId()
    await repo.runMutation(
      [
        { kind: 'message', messageId: orphanId },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage({
          id: orphanId,
          chatId: chat.id,
          parentId: null,
          siblingIndex: 0,
          turnId: newId(),
          turnIndex: 0,
          createdAt: 1,
          role: 'assistant',
          origin: 'generated',
          content: [],
          nodeVersion: 0,
          deleted: false,
          generation: {
            id: '',
            model: 'm',
            requestedModel: 'm',
            apiUsed: 'chat',
            delivery: 'streaming',
            costSource: 'stream',
            startedAt: 100,
          },
        })
      },
    )
    const recovered = await recoverOrphans(20_000)
    expect(recovered).toBe(1)
    const after = await repo.getMessage(orphanId)
    expect(after?.generation?.abortReason).toBe('tab-close')
    expect(after?.generation?.finishedAt).toBe(20_000)
  })

  it('does not mark a message that has a fresh cross-tab stream lease', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const leasedId = newId()
    await repo.runMutation(
      [
        { kind: 'message', messageId: leasedId },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage({
          id: leasedId,
          chatId: chat.id,
          parentId: null,
          siblingIndex: 0,
          turnId: newId(),
          turnIndex: 0,
          createdAt: 1,
          role: 'assistant',
          origin: 'generated',
          content: [{ type: 'output_text', text: 'partial' }],
          nodeVersion: 0,
          deleted: false,
          generation: {
            id: '',
            model: 'm',
            requestedModel: 'm',
            apiUsed: 'chat',
            delivery: 'streaming',
            costSource: 'stream',
            startedAt: 100,
          },
        })
      },
    )
    await repo.upsertStreamLease({
      streamId: 'stream-other-tab',
      chatId: chat.id,
      messageId: leasedId,
      ownerClientId: 'other-tab',
      startedAt: 100,
      heartbeatAt: 19_000,
    })

    expect(await recoverOrphans(20_000)).toBe(0)
    expect((await repo.getMessage(leasedId))?.generation?.abortReason).toBeUndefined()
  })

  it('recovers a fresh persisted lease immediately when its Web Lock owner is gone', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    installStreamLeaseListener()
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const messageId = await seedUnfinishedAssistant(chat.id)
    const recoveryNow = Date.now()
    await repo.upsertStreamLease({
      streamId: 'fresh-dead-owner',
      chatId: chat.id,
      messageId,
      ownerClientId: 'reloaded-tab',
      startedAt: 100,
      heartbeatAt: recoveryNow,
      attemptKind: 'generation',
    })
    expect(useStreamStore.getState().isTargetActive(chat.id, messageId)).toBe(true)

    expect(await recoverOrphans(recoveryNow)).toBe(1)
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await repo.getMessage(messageId)).toMatchObject({
      generation: {
        status: 'interrupted',
        abortReason: 'tab-close',
        finishedAt: recoveryNow,
      },
    })
  })

  it('deletes a targeted generation admission when its reserved row never committed', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const recoveryNow = Date.now()
    await repo.upsertStreamLease({
      streamId: 'reserved-target-without-row',
      chatId: chat.id,
      messageId: 'assistant-id-reserved-before-placeholder',
      ownerClientId: 'closed-tab',
      startedAt: recoveryNow,
      heartbeatAt: recoveryNow,
      attemptKind: 'generation',
    })

    expect(await repo.getMessage('assistant-id-reserved-before-placeholder')).toBeUndefined()
    expect(await recoverOrphans(recoveryNow, chat.id)).toBe(1)
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await repo.getMessage('assistant-id-reserved-before-placeholder')).toBeUndefined()
  })

  it.each([
    'generation',
    'continuation',
  ] as const)('recovers a fresh message-less %s admission immediately when its Web Lock owner is gone', async (attemptKind) => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    await repo.upsertStreamLease({
      streamId: `message-less-${attemptKind}`,
      chatId: chat.id,
      ownerClientId: 'closed-tab',
      startedAt: 100,
      heartbeatAt: 19_000,
      attemptKind,
    })

    expect(await recoverOrphans(20_000)).toBe(1)
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
  })

  it.each([
    'generation',
    'continuation',
  ] as const)('waits for the no-Web-Locks TTL before recovering a message-less %s admission', async (attemptKind) => {
    __setStreamLockManagerForTests(null)
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    await repo.upsertStreamLease({
      streamId: `fallback-message-less-${attemptKind}`,
      chatId: chat.id,
      ownerClientId: 'closed-tab',
      startedAt: 100,
      heartbeatAt: 19_000,
      attemptKind,
    })

    expect(await recoverOrphans(20_000)).toBe(0)
    expect(await repo.listStreamLeases(chat.id)).toHaveLength(1)
    expect(await nextOrphanRecoveryAt(chat.id, 20_000)).toBe(34_001)
    expect(await recoverOrphans(34_001)).toBe(1)
    expect(await repo.listStreamLeases(chat.id)).toEqual([])
    expect(await nextOrphanRecoveryAt(chat.id, 34_001)).toBeNull()
  })

  it('schedules no-Web-Locks recovery for an unfinished header without a lease', async () => {
    __setStreamLockManagerForTests(null)
    const chat = await createChat({ settings: chatSettings() })
    const messageId = await seedUnfinishedAssistant(chat.id, 19_000)

    expect(await recoverOrphans(20_000, chat.id)).toBe(0)
    expect(await nextOrphanRecoveryAt(chat.id, 20_000)).toBe(34_001)
    expect(await recoverOrphans(34_001, chat.id)).toBe(1)
    expect(await getBrowserRepository().getMessage(messageId)).toMatchObject({
      generation: {
        status: 'interrupted',
        abortReason: 'tab-close',
        finishedAt: 34_001,
      },
    })
    expect(await nextOrphanRecoveryAt(chat.id, 34_001)).toBeNull()
  })

  it('does not recover a fresh lease until its Web Lock owner releases it', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const messageId = await seedUnfinishedAssistant(chat.id)
    await repo.upsertStreamLease({
      streamId: 'fresh-live-owner',
      chatId: chat.id,
      messageId,
      ownerClientId: 'other-tab',
      startedAt: 100,
      heartbeatAt: 19_000,
      attemptKind: 'generation',
    })
    const release = manager.hold('stream-owner:fresh-live-owner')

    expect(await recoverOrphans(20_000)).toBe(0)
    expect((await repo.getMessage(messageId))?.generation?.finishedAt).toBeUndefined()

    release()
    expect(await recoverOrphans(20_001)).toBe(1)
    expect((await repo.getMessage(messageId))?.generation?.abortReason).toBe('tab-close')
  })

  it('wakes recovery when a reloaded page releases fresh stream ownership', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const messageId = await seedUnfinishedAssistant(chat.id)
    await repo.upsertStreamLease({
      streamId: 'reload-release',
      chatId: chat.id,
      messageId,
      ownerClientId: 'old-page',
      startedAt: 100,
      heartbeatAt: 20_000,
      attemptKind: 'generation',
    })
    const release = manager.hold('stream-owner:reload-release')
    let resolveRecovery!: (count: number) => void
    let rejectRecovery!: (error: unknown) => void
    const recovered = new Promise<number>((resolve, reject) => {
      resolveRecovery = resolve
      rejectRecovery = reject
    })
    const stopObserving = onRemoteStreamOwnershipReleased(chat.id, () => {
      void recoverOrphans(20_000, chat.id).then(resolveRecovery, rejectRecovery)
    })

    try {
      await eventually(() => {
        expect(manager.queuedCount('stream-owner:reload-release')).toBe(1)
      })
      expect(await recoverOrphans(20_000, chat.id)).toBe(0)
      expect((await repo.getMessage(messageId))?.generation?.finishedAt).toBeUndefined()

      release()
      expect(await recovered).toBe(1)
      expect(await repo.listStreamLeases(chat.id)).toEqual([])
      expect(await repo.getMessage(messageId)).toMatchObject({
        generation: {
          status: 'interrupted',
          abortReason: 'tab-close',
          finishedAt: 20_000,
        },
      })
    } finally {
      release()
      stopObserving()
    }
  })

  it('does not recover a placeholder while its message-less generation owner is retargeting', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const messageId = await seedUnfinishedAssistant(chat.id)
    await repo.upsertStreamLease({
      streamId: 'placeholder-retarget-window',
      chatId: chat.id,
      ownerClientId: 'live-tab',
      startedAt: 100,
      heartbeatAt: 20_000,
      attemptKind: 'generation',
    })
    const release = manager.hold('stream-owner:placeholder-retarget-window')

    try {
      expect(await recoverOrphans(20_000, chat.id)).toBe(0)
      expect((await repo.getMessage(messageId))?.generation?.finishedAt).toBeUndefined()
    } finally {
      release()
    }
  })

  it('defers placeholder recovery when a message-less generation lease appears inside the lock', async () => {
    const manager = new TestExclusiveLockManager()
    __setStreamLockManagerForTests(manager)
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const messageId = await seedUnfinishedAssistant(chat.id)
    const listStreamLeases = repo.listStreamLeases.bind(repo)
    let listCalls = 0
    const listSpy = vi.spyOn(repo, 'listStreamLeases').mockImplementation(async (scopeChatId) => {
      listCalls += 1
      if (listCalls === 2) {
        await repo.upsertStreamLease({
          streamId: 'late-placeholder-retarget',
          chatId: chat.id,
          ownerClientId: 'live-tab',
          startedAt: 100,
          heartbeatAt: 20_000,
          attemptKind: 'generation',
        })
      }
      return listStreamLeases(scopeChatId)
    })

    expect(await recoverOrphans(20_000, chat.id)).toBe(0)
    expect(listCalls).toBeGreaterThanOrEqual(2)
    expect((await repo.getMessage(messageId))?.generation?.finishedAt).toBeUndefined()
    expect(await listStreamLeases(chat.id)).toHaveLength(1)
    listSpy.mockRestore()
  })

  it('does not let a finalized generation lease block later target work', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const messageId = await seedUnfinishedAssistant(chat.id)
    await repo.runMutation([{ kind: 'message', messageId }], async (ctx) => {
      const current = requireDefined(await ctx.getMessage(messageId), 'finished target')
      await ctx.putMessage({
        ...current,
        generation: {
          ...requireDefined(current.generation, 'generation'),
          status: 'done',
          finishedAt: 500,
          finishReason: 'stop',
        },
      })
    })
    await repo.upsertStreamLease({
      streamId: 'finished-generation-cleanup-pending',
      chatId: chat.id,
      messageId,
      ownerClientId: 'completed-tab',
      startedAt: 100,
      heartbeatAt: 500,
      attemptKind: 'generation',
    })

    const continuationLease = await repo.upsertStreamLease({
      streamId: 'next-continuation',
      chatId: chat.id,
      messageId,
      ownerClientId: 'current-tab',
      startedAt: 600,
      heartbeatAt: 600,
      attemptKind: 'continuation',
      continuationStrategy: 'prompt',
    })
    await expect(
      repo.runMutation([{ kind: 'message', messageId }], async (ctx) => {
        const current = requireDefined(await ctx.getMessage(messageId), 'busy target')
        await ctx.putMessage({ ...current, editedAt: 700 })
      }),
    ).rejects.toThrow(`StreamTargetBusy:${messageId}`)

    await repo.deleteOwnedStreamLease(
      continuationLease.streamId,
      streamWriteFenceForLease(continuationLease),
    )
    await expect(
      repo.runMutation([{ kind: 'message', messageId }], async (ctx) => {
        const current = requireDefined(await ctx.getMessage(messageId), 'editable target')
        await ctx.putMessage({ ...current, editedAt: 800 })
      }),
    ).resolves.toBeDefined()
    expect((await repo.getMessage(messageId))?.editedAt).toBe(800)
  })

  it('does not compact chunks while a fresh owner lease exists', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const leasedId = newId()
    await repo.runMutation(
      [
        { kind: 'message', messageId: leasedId },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage({
          id: leasedId,
          chatId: chat.id,
          parentId: null,
          siblingIndex: 0,
          turnId: newId(),
          turnIndex: 0,
          createdAt: 1,
          role: 'assistant',
          origin: 'generated',
          content: [{ type: 'output_text', text: '' }],
          nodeVersion: 0,
          deleted: false,
          generation: {
            id: '',
            model: 'm',
            requestedModel: 'm',
            apiUsed: 'chat',
            delivery: 'streaming',
            costSource: 'stream',
            startedAt: 100,
          },
        })
      },
    )
    const activeLease = await repo.upsertStreamLease({
      streamId: 'active-stream',
      chatId: chat.id,
      messageId: leasedId,
      ownerClientId: 'other-tab',
      startedAt: 100,
      heartbeatAt: 19_000,
    })
    const activeFence = chunkFence(activeLease)
    await repo.appendStreamChunks([
      {
        id: 'active-stream:0',
        streamId: 'active-stream',
        chatId: chat.id,
        messageId: leasedId,
        seq: 0,
        createdAt: 200,
        event: { lane: 'text', text: 'owned elsewhere' },
        ...activeFence,
      },
    ])

    expect(await recoverOrphans(20_000)).toBe(0)
    const after = await repo.getMessage(leasedId)
    expect(after?.content).toEqual([{ type: 'output_text', text: '' }])
    expect(after?.generation?.abortReason).toBeUndefined()
    expect(await repo.listStreamChunksForMessage(leasedId)).toHaveLength(1)
  })

  it('compacts stale stream chunks once and deletes the recovery log', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const orphanId = newId()
    await repo.runMutation(
      [
        { kind: 'message', messageId: orphanId },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage({
          id: orphanId,
          chatId: chat.id,
          parentId: null,
          siblingIndex: 0,
          turnId: newId(),
          turnIndex: 0,
          createdAt: 1,
          role: 'assistant',
          origin: 'generated',
          content: [{ type: 'output_text', text: '' }],
          nodeVersion: 0,
          deleted: false,
          generation: {
            id: '',
            model: 'm',
            requestedModel: 'm',
            apiUsed: 'chat',
            delivery: 'streaming',
            costSource: 'stream',
            startedAt: 100,
          },
        })
      },
    )
    const staleLease = await repo.upsertStreamLease({
      streamId: 'stale-stream',
      chatId: chat.id,
      messageId: orphanId,
      ownerClientId: 'dead-tab',
      startedAt: 100,
      heartbeatAt: 1_000,
    })
    const staleFence = chunkFence(staleLease)
    await repo.appendStreamChunks([
      {
        id: 'stale-stream:0',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 0,
        createdAt: 200,
        event: { lane: 'reasoning', textDelta: 'thinking', outputIndex: 0 },
        ...staleFence,
      },
      {
        id: 'stale-stream:1',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 1,
        createdAt: 300,
        event: { lane: 'text', text: 'hello ' },
        ...staleFence,
      },
      {
        id: 'stale-stream:2',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 2,
        createdAt: 400,
        event: { lane: 'text', text: 'world' },
        ...staleFence,
      },
      {
        id: 'stale-stream:3',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 3,
        createdAt: 500,
        event: {
          lane: 'tool-call',
          index: 0,
          id: 'call-recovered',
          type: 'function',
          name: 'lookup',
          argumentsDelta: '{"query":',
        },
        ...staleFence,
      },
      {
        id: 'stale-stream:4',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 4,
        createdAt: 600,
        event: { lane: 'tool-call', index: 0, argumentsDelta: '"natter"}' },
        ...staleFence,
      },
      {
        id: 'stale-stream:5',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 5,
        createdAt: 700,
        event: { lane: 'phase', phase: 'final_answer', outputIndex: 0 },
        ...staleFence,
      },
    ])

    expect(await recoverOrphans(20_000)).toBe(1)
    const after = await repo.getMessage(orphanId)
    expect(after?.content).toEqual([{ type: 'output_text', text: 'hello world' }])
    expect(after?.reasoningDetails?.[0]).toMatchObject({
      type: 'reasoning.text',
      text: 'thinking',
    })
    expect(after?.generation?.abortReason).toBe('tab-close')
    expect(after?.phase).toBe('final_answer')
    expect(after?.toolCalls).toEqual([
      {
        id: 'call-recovered',
        type: 'function',
        function: { name: 'lookup', arguments: '{"query":"natter"}' },
      },
    ])
    expect(await repo.listStreamChunksForMessage(orphanId)).toEqual([])
    expect(await repo.listStreamLeases(chat.id)).toEqual([])

    expect(await recoverOrphans(21_000)).toBe(0)
  })

  it('graces very recent placeholders before a lease heartbeat is visible', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const freshId = newId()
    await repo.runMutation(
      [
        { kind: 'message', messageId: freshId },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage({
          id: freshId,
          chatId: chat.id,
          parentId: null,
          siblingIndex: 0,
          turnId: newId(),
          turnIndex: 0,
          createdAt: 1,
          role: 'assistant',
          origin: 'generated',
          content: [{ type: 'output_text', text: 'partial' }],
          nodeVersion: 0,
          deleted: false,
          generation: {
            id: '',
            model: 'm',
            requestedModel: 'm',
            apiUsed: 'chat',
            delivery: 'streaming',
            costSource: 'stream',
            startedAt: 10_000,
          },
        })
      },
    )

    expect(await recoverOrphans(20_000)).toBe(0)
    expect((await repo.getMessage(freshId))?.generation?.abortReason).toBeUndefined()
  })

  it('does not touch messages that already finished', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const repo = getBrowserRepository()
    const id = newId()
    await repo.runMutation(
      [
        { kind: 'message', messageId: id },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (ctx) => {
        await ctx.putMessage({
          id,
          chatId: chat.id,
          parentId: null,
          siblingIndex: 0,
          turnId: newId(),
          turnIndex: 0,
          createdAt: 1,
          role: 'assistant',
          origin: 'generated',
          content: [],
          nodeVersion: 0,
          deleted: false,
          generation: {
            id: 'ok',
            model: 'm',
            requestedModel: 'm',
            apiUsed: 'chat',
            delivery: 'streaming',
            costSource: 'stream',
            startedAt: 100,
            finishedAt: 500,
            finishReason: 'stop',
          },
        })
      },
    )
    const recovered = await recoverOrphans(20_000)
    expect(recovered).toBe(0)
    const after = await repo.getMessage(id)
    expect(after?.generation?.abortReason).toBeUndefined()
  })
})

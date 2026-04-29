import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/api/errors'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../../src/api/types'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { cursorKeyOf } from '../../src/core/active-path'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
import { recoverOrphans, sendText } from '../../src/hooks/useChat'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, postEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { putCachedEndpoints } from '../../src/store/models-cache'
import {
  __resetStreamLeasesForTests,
  getStreamClientId,
  installStreamLeaseListener,
} from '../../src/store/stream-leases'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'

const DB_NAME = 'natter'

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
    usesResponsesApiByDefault: false,
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
    usesResponsesApiByDefault: true,
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
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    geminiMode: 'native',
  }
}

function makeLlamaServerProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-llama',
    name: 'llama-server',
    kind: 'llama-server',
    baseUrl: 'http://llama.test/v1',
    usesResponsesApiByDefault: false,
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
  it('registers a pre-stream lifecycle so Stop can abort template preflight before rows are written', async () => {
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
    expect(active[0]?.messageId).toBeUndefined()
    expect(await messagesFor(chat.id)).toEqual([])
    expect(useStreamStore.getState().abortChat(chat.id)).toBe(1)
    await expect(sendPromise).rejects.toMatchObject({ kind: 'abort' })
    expect(openStream).not.toHaveBeenCalled()
    expect(useStreamStore.getState().hasStreamForChat(chat.id)).toBe(false)
    expect(await messagesFor(chat.id)).toEqual([])
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

  it(
    'streams 100k reasoning and 100k completion in small chunks without per-chunk body rewrites',
    async () => {
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
      expect(useStreamStore.getState().liveByMessageId[result.assistantMessageId]).toBeUndefined()
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
    },
    15_000,
  )

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

  it('uses Responses on OpenAI direct when the profile default says Responses', async () => {
    const chat = await createChat({
      settings: chatSettings({ model: 'gpt-4o', api: 'auto' }),
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
    useChatStore.getState().setCursor(chat.id, {
      [cursorKeyOf(null)]: root.id,
      [cursorKeyOf(root.id)]: left.id,
    })

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
              choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
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

    const rightBranchCursor = {
      [cursorKeyOf(null)]: root.id,
      [cursorKeyOf(root.id)]: right.id,
    }
    useChatStore.getState().setCursor(chat.id, rightBranchCursor)
    const rightBranch = await repo.getActiveBranchSnapshot(chat.id, rightBranchCursor)
    expect(rightBranch.branch.map((message) => message.id)).toEqual([root.id, right.id])
    expect(useStreamStore.getState().hasStreamForChat(chat.id)).toBe(true)

    release()
    const result = await sendPromise
    expect(result.outcome).toBe('done')
    const assistant = await repo.getMessage(result.assistantMessageId)
    expect(assistant?.parentId).toBe(result.userMessageId)
    expect(assistant?.content).toEqual([{ type: 'output_text', text: 'Partial answer' }])
    expect(useChatStore.getState().getCursor(chat.id)?.[cursorKeyOf(root.id)]).toBe(right.id)
  })

  it('releases the stream store entry on completion', async () => {
    const chat = await createChat({ settings: chatSettings() })
    const before = Object.keys(useStreamStore.getState().activeByStreamId).length
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
    const after = Object.keys(useStreamStore.getState().activeByStreamId).length
    expect(after).toBe(before)
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
                    reasoning: 'Let me',
                    reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'Let me' }],
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

  it('merges overlapped mirrored reasoning fragments instead of re-appending them', async () => {
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
                    reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'A ratio' }],
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
                    reasoning: ' ratio of Gaussians',
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
        id: 'text#default',
        index: 0,
        text: 'A ratio of Gaussians',
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
        enabledServerToolIds: ['web-fetch'],
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
    const chatRow = await getBrowserRepository().getChat(chat.id)
    // Calibration is skipped on non-done outcome.
    expect(chatRow?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-4o')]).toBeUndefined()
  })

  it('does not calibrate when the sent path includes non-text input', async () => {
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
    const chatRow = await getBrowserRepository().getChat(chat.id)
    expect(chatRow?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-4o')]).toBeUndefined()
    const [user, assistant] = liveMessagesSortedByCreated(await messagesFor(chat.id))
    expect(user?.originalCalibrationKey).toBeUndefined()
    expect(assistant?.originalCalibrationKey).toBeUndefined()
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
    const ownerStream = Object.values(useStreamStore.getState().activeByStreamId).find(
      (stream) => stream.chatId === chat.id && stream.messageId !== undefined,
    )
    expect(ownerStream).toBeDefined()

    postEvent({
      kind: 'stream-abort-requested',
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
    await repo.appendStreamChunks([
      {
        id: 'active-stream:0',
        streamId: 'active-stream',
        chatId: chat.id,
        messageId: leasedId,
        seq: 0,
        createdAt: 200,
        event: { lane: 'text', text: 'owned elsewhere' },
      },
    ])
    await repo.upsertStreamLease({
      streamId: 'active-stream',
      chatId: chat.id,
      messageId: leasedId,
      ownerClientId: 'other-tab',
      startedAt: 100,
      heartbeatAt: 19_000,
    })

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
    await repo.appendStreamChunks([
      {
        id: 'stale-stream:0',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 0,
        createdAt: 200,
        event: { lane: 'reasoning', textDelta: 'thinking', outputIndex: 0 },
      },
      {
        id: 'stale-stream:1',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 1,
        createdAt: 300,
        event: { lane: 'text', text: 'hello ' },
      },
      {
        id: 'stale-stream:2',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 2,
        createdAt: 400,
        event: { lane: 'text', text: 'world' },
      },
      {
        id: 'stale-stream:3',
        streamId: 'stale-stream',
        chatId: chat.id,
        messageId: orphanId,
        seq: 3,
        createdAt: 500,
        event: { lane: 'phase', phase: 'final_answer', outputIndex: 0 },
      },
    ])
    await repo.upsertStreamLease({
      streamId: 'stale-stream',
      chatId: chat.id,
      messageId: orphanId,
      ownerClientId: 'dead-tab',
      startedAt: 100,
      heartbeatAt: 1_000,
    })

    expect(await recoverOrphans(20_000)).toBe(1)
    const after = await repo.getMessage(orphanId)
    expect(after?.content).toEqual([{ type: 'output_text', text: 'hello world' }])
    expect(after?.reasoningDetails?.[0]).toMatchObject({
      type: 'reasoning.text',
      text: 'thinking',
    })
    expect(after?.generation?.abortReason).toBe('tab-close')
    expect(after?.phase).toBe('final_answer')
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

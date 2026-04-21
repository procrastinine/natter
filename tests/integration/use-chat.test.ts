import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api/errors'
import type { ChatStreamChunk } from '../../src/api/types'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
import { recoverOrphans, sendText } from '../../src/hooks/useChat'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
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

function chatSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const base = cloneDefaultChatSettings()
  return {
    ...base,
    profileId: 'prof',
    model: 'google/gemini-3.1-flash-lite-preview',
    reasoning: { mode: 'off', exclude: false, summary: 'off', carryForward: 'off', include: { encrypted: false, summary: false, text: false } },
    ...overrides,
  }
}

async function reset() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openDb()
})

afterEach(async () => {
  await reset()
})

async function messagesFor(chatId: string): Promise<Message[]> {
  return getBrowserRepository().listMessages(chatId)
}

function liveMessagesSortedByCreated(messages: Message[]): Message[] {
  return messages.filter((m) => !m.deleted).sort((a, b) => a.createdAt - b.createdAt)
}

async function* stream(...chunks: ChatStreamChunk[]): AsyncGenerator<ChatStreamChunk> {
  for (const c of chunks) yield c
}

describe('sendText — chat-completions streaming', () => {
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
      // Slow async source so we can abort mid-stream deterministically.
      openStream: () =>
        (async function* () {
          yield {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'slow ' } }] },
          } as ChatStreamChunk
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
          } as ChatStreamChunk
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
          } as ChatStreamChunk
          markPaused()
          await gate
          yield {
            type: 'delta',
            chunk: {
              choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.0002 },
            },
          } as ChatStreamChunk
        })(),
      now: () => {
        tick += 250
        return tick
      },
    })

    await paused

    const midChat = await getBrowserRepository().getChat(chat.id)
    const midAssistant = (await messagesFor(chat.id)).find((m) => m.role === 'assistant')
    expect(midAssistant?.content).toEqual([{ type: 'output_text', text: 'Partial ' }])
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
    expect((assistant?.generation?.firstTextAt ?? 0) > (assistant?.generation?.reasoningStartedAt ?? 0)).toBe(true)
    expect((assistant?.generation?.finishedAt ?? 0) >= (assistant?.generation?.firstTextAt ?? 0)).toBe(true)
  })

  it('preserves both reasoning.summary (relabeled from text) and reasoning.encrypted at same index (Gemini via OpenRouter)', async () => {
    // Regression: OpenRouter's Gemini chat-completions stream emits BOTH
    // `reasoning.text` (actually a summary — Gemini 3 never emits raw CoT)
    // AND `reasoning.encrypted` (the thoughtSignature carrier) at `index: 0`
    // in the SAME stream. Our on-ingest normalizer relabels the `.text`
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

  it('preserves multiple distinct Gemini summary parts arriving at same index', async () => {
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
    expect(summaries).toHaveLength(2)
    expect(summaries.map((s) => s.type === 'reasoning.summary' && s.summary)).toEqual([
      'First thought: enumerate options.',
      'Second thought: pick the best.',
    ])
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
        index: 0,
        text: 'A ratio of Gaussians',
      },
    ])
  })
})

describe('sendText — token calibration sample ingest', () => {
  it('writes a per-model chat.tokenCalibration sample on successful stream', async () => {
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
    const sample = chatRow?.tokenCalibration?.['openai/gpt-4o']
    expect(sample).toBeDefined()
    expect(sample?.sampleCount).toBeGreaterThanOrEqual(1)
    expect(sample?.totalTextTokens).toBeGreaterThan(0)
    // Within-bounds ratio.
    const ratio = (sample?.totalTextChars ?? 0) / (sample?.totalTextTokens ?? 1)
    expect(ratio).toBeGreaterThanOrEqual(2.5)
    expect(ratio).toBeLessThanOrEqual(5.0)
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
    expect(chatRow?.tokenCalibration?.['openai/gpt-4o']).toBeUndefined()
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
    expect(user.charCountDelta).toBe(0)
    expect(user.cachedTokenEstimate).toBeGreaterThan(0)
    // Assistant message fields (populated on finalize for a successful done)
    expect(assistant.originalCharCount).toBe(100)
    expect(assistant.originalModelId).toBe('openai/gpt-4o')
    expect(assistant.cachedTokenEstimate).toBeGreaterThan(0)
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
    const s = chatRow?.tokenCalibration?.['openai/gpt-4o']
    // If we accept nothing, field either stays undefined OR sampleCount=0.
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
    const recovered = await recoverOrphans(2000)
    expect(recovered).toBe(1)
    const after = await repo.getMessage(orphanId)
    expect(after?.generation?.abortReason).toBe('tab-close')
    expect(after?.generation?.finishedAt).toBe(2000)
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
    const recovered = await recoverOrphans(2000)
    expect(recovered).toBe(0)
    const after = await repo.getMessage(id)
    expect(after?.generation?.abortReason).toBeUndefined()
  })
})

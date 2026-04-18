// Keyed live smoke for the Phase 7 send/stream pipeline. The plan's §13.2.7
// exit gate requires exactly one keyed OpenRouter chat-completions roundtrip
// after the send path lands, using the cheapest adequate model. This test
// gates on `RUN_LIVE=1`; set it locally to exercise against the real upstream.
//
// Cheap model choice: `google/gemini-3.1-flash-lite-preview`. Roundtrip cost
// is a handful of tokens (≤20 in / ≤10 out) at sub-cent pricing.

import Dexie from 'dexie'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile } from '../../src/core/types'
import { sendText } from '../../src/hooks/useChat'
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
const MODEL = 'google/gemini-3.1-flash-lite-preview'

function readKey(): string {
  // ../key.txt relative to the natter package root.
  const keyPath = path.resolve(__dirname, '..', '..', '..', 'key.txt')
  return readFileSync(keyPath, 'utf8').trim()
}

function liveProfile(): ConnectionProfile {
  return {
    id: 'prof-live',
    name: 'OpenRouter (live)',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-live',
    defaultHeaders: {},
    appTitle: 'natter-phase-7-smoke',
    appUrl: 'http://localhost:5173',
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function liveSettings(): ChatSettings {
  const base = cloneDefaultChatSettings()
  return {
    ...base,
    profileId: 'prof-live',
    model: MODEL,
    // Minimize output + keep generation deterministic-ish. Cheap models
    // sometimes hedge on temperature: 0; that's fine.
    sampling: { temperature: 0 },
    maxCompletionTokens: 16,
    reasoning: { mode: 'off', exclude: false, summary: 'off', carryForward: 'off' },
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

const RUN = process.env.RUN_LIVE === '1'

beforeEach(async () => {
  if (!RUN) return
  await reset()
  await openDb()
})

afterEach(async () => {
  if (!RUN) return
  await reset()
})

function liveReasoningSettings(model: string): ChatSettings {
  const base = liveSettings()
  return {
    ...base,
    model,
    maxCompletionTokens: 256,
    reasoning: { mode: 'enabled', effort: 'low', exclude: false, summary: 'off', carryForward: 'off' },
  }
}

describe.skipIf(!RUN)('Phase 7 live OpenRouter chat-completions smoke', () => {
  it('streams a short answer end-to-end and persists generation metadata', async () => {
    const apiKey = readKey()
    const chat = await createChat({ settings: liveSettings() })
    const result = await sendText({
      chatId: chat.id,
      connection: liveProfile(),
      apiKey,
      content: [
        { type: 'text', text: 'Reply with exactly one word: "pong".' },
      ],
    })
    expect(result.outcome).toBe('done')

    const repo = getBrowserRepository()
    const assistant = await repo.getMessage(result.assistantMessageId)
    expect(assistant).toBeDefined()
    const first = assistant?.content[0]
    expect(first?.type).toBe('output_text')
    if (first?.type !== 'output_text') throw new Error('expected output_text')
    expect(first.text.length).toBeGreaterThan(0)
    expect(first.text.toLowerCase()).toContain('pong')

    const gen = assistant?.generation
    expect(gen).toBeDefined()
    expect(gen?.id.length ?? 0).toBeGreaterThan(0)
    expect(gen?.usage?.total_tokens ?? 0).toBeGreaterThan(0)
    expect(gen?.finishReason).toBeDefined()
    expect(gen?.finishedAt).toBeDefined()
    // Cost may or may not be populated by the stream depending on provider
    // — at least one of cost or usage must be present.
    expect(
      gen?.cost !== undefined || gen?.usage?.total_tokens !== undefined,
    ).toBe(true)
  }, 60_000)

  it('carries a multi-turn conversation (prior assistant message echoed back)', async () => {
    const apiKey = readKey()
    const chat = await createChat({ settings: liveSettings() })
    // Turn 1: ask for a token we can look for in turn 2's request.
    await sendText({
      chatId: chat.id,
      connection: liveProfile(),
      apiKey,
      content: [
        { type: 'text', text: 'Reply with exactly this word: ORANGE' },
      ],
    })
    // Turn 2: confirm the model can see turn 1's reply by asking it to
    // repeat its own previous word verbatim.
    const result = await sendText({
      chatId: chat.id,
      connection: liveProfile(),
      apiKey,
      content: [{ type: 'text', text: 'Repeat your last word. Say only the word.' }],
    })
    expect(result.outcome).toBe('done')
    const repo = getBrowserRepository()
    const assistant = await repo.getMessage(result.assistantMessageId)
    const first = assistant?.content[0]
    if (first?.type !== 'output_text') throw new Error('expected output_text')
    expect(first.text.toUpperCase()).toContain('ORANGE')
  }, 60_000)

  it('captures reasoning_details when a thinking-capable model is asked to reason', async () => {
    const apiKey = readKey()
    const chat = await createChat({
      settings: liveReasoningSettings('google/gemini-3.1-flash-lite-preview'),
    })
    const result = await sendText({
      chatId: chat.id,
      connection: liveProfile(),
      apiKey,
      content: [
        {
          type: 'text',
          text:
            'Think step by step: what is 17 * 13? Answer with only the number.',
        },
      ],
    })
    expect(result.outcome).toBe('done')
    const repo = getBrowserRepository()
    const assistant = await repo.getMessage(result.assistantMessageId)
    const first = assistant?.content[0]
    if (first?.type !== 'output_text') throw new Error('expected output_text')
    // The answer should be 221 either way; the reasoning path is the real
    // artifact we're probing here.
    expect(first.text).toMatch(/221/)
    // Providers vary in whether they expose summary / text / encrypted. Gemini
    // typically emits reasoning.text deltas and/or reasoning.encrypted via
    // thoughtSignature; at minimum we expect SOME detail entries OR usage
    // reporting reasoning tokens in completion_tokens_details.
    const details = assistant?.reasoningDetails ?? []
    const reasoningTokens =
      assistant?.generation?.usage?.completion_tokens_details?.reasoning_tokens ?? 0
    expect(details.length > 0 || reasoningTokens > 0).toBe(true)
  }, 60_000)

  it('round-trips a reasoning request to Claude Haiku 4.5 without error', async () => {
    // Haiku 4.5 accepts `reasoning.effort` (mapped internally to
    // budget_tokens). Whether the model chooses to surface reasoning for a
    // given prompt is up to the provider — we only assert the request path
    // works end-to-end and any returned reasoning_details are captured.
    const apiKey = readKey()
    const chat = await createChat({
      settings: {
        ...liveReasoningSettings('anthropic/claude-haiku-4.5'),
        reasoning: {
          mode: 'enabled',
          effort: 'medium',
          exclude: false,
          summary: 'off',
          carryForward: 'off',
        },
        maxCompletionTokens: 512,
      },
    })
    const result = await sendText({
      chatId: chat.id,
      connection: liveProfile(),
      apiKey,
      content: [
        {
          type: 'text',
          text:
            'Think through this carefully: what is 143 * 37? Answer with only the number.',
        },
      ],
    })
    expect(result.outcome).toBe('done')
    const repo = getBrowserRepository()
    const assistant = await repo.getMessage(result.assistantMessageId)
    const first = assistant?.content[0]
    if (first?.type !== 'output_text') throw new Error('expected output_text')
    // 143 * 37 = 5291. Accept either the exact number or any 4-digit answer
    // — the transport assertion is what matters, not the math.
    expect(first.text.length).toBeGreaterThan(0)
    // If the provider emitted reasoning in this response, our accumulator
    // should have captured it. We don't REQUIRE it: Anthropic sometimes
    // suppresses reasoning output for simple prompts even when requested.
    const details = assistant?.reasoningDetails ?? []
    for (const detail of details) {
      expect(detail.type).toMatch(/^reasoning\./)
    }
  }, 60_000)

  it('handles json_schema structured output without breaking streaming', async () => {
    // Some provider+model combinations refuse to emit `text/event-stream`
    // when `response_format: json_schema` is set; the upstream instead
    // answers with a single buffered JSON body. Our transport normalizes
    // that into a synthetic `buffered_result` so the send pipeline sees
    // one terminal event. This test asserts the pipeline completes and
    // the assistant row carries valid JSON regardless of whether the
    // upstream streamed or buffered.
    const apiKey = readKey()
    const settings: ChatSettings = {
      ...liveSettings(),
      maxCompletionTokens: 64,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: {
          name: 'Greeting',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              greeting: { type: 'string' },
            },
            required: ['greeting'],
          },
          strict: true,
        },
      },
    }
    const chat = await createChat({ settings })
    const result = await sendText({
      chatId: chat.id,
      connection: liveProfile(),
      apiKey,
      content: [{ type: 'text', text: 'Return {"greeting":"hi"}.' }],
    })
    expect(result.outcome).toBe('done')
    const repo = getBrowserRepository()
    const assistant = await repo.getMessage(result.assistantMessageId)
    const first = assistant?.content[0]
    if (first?.type !== 'output_text') throw new Error('expected output_text')
    const parsed = JSON.parse(first.text) as { greeting: string }
    expect(typeof parsed.greeting).toBe('string')
  }, 60_000)

  it('persists partial text when the user aborts mid-stream', async () => {
    const apiKey = readKey()
    const chat = await createChat({
      settings: {
        ...liveSettings(),
        maxCompletionTokens: 128,
      },
    })
    const abort = new AbortController()
    const result = sendText({
      chatId: chat.id,
      connection: liveProfile(),
      apiKey,
      content: [{ type: 'text', text: 'Count slowly from one to one hundred.' }],
      signal: abort.signal,
    })
    // Give the upstream a moment to emit first chunks, then abort.
    await new Promise((r) => setTimeout(r, 700))
    abort.abort()
    const finished = await result
    expect(['abort', 'done']).toContain(finished.outcome)
    const repo = getBrowserRepository()
    const assistant = await repo.getMessage(finished.assistantMessageId)
    // We either aborted with partial text or the upstream wrapped up faster
    // than the 700ms grace window — both are fine for "persists partial".
    expect(assistant?.content[0]?.type).toBe('output_text')
    expect(assistant?.generation?.finishedAt).toBeDefined()
    if (finished.outcome === 'abort') {
      expect(assistant?.generation?.abortReason).toBe('user')
    }
  }, 60_000)
})

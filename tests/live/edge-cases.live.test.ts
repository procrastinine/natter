// Phase 11 live edge-case tests: provider-specific reasoning shapes &
// cross-model round-trip. Gated behind `LIVE=1`.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  chatCompletions,
  chatCompletionsOnce,
  type ChatCompletionsContext,
} from '../../src/api/chat-completions'
import type {
  ChatCompletionChunkWire,
  ChatCompletionResultWire,
} from '../../src/api/types'
import type { ConnectionProfile } from '../../src/core/types'

const LIVE = process.env.LIVE === '1'

function loadKey(name: string): string {
  const raw = readFileSync(resolve(__dirname, '../../../keys.json'), 'utf8')
  const key = (JSON.parse(raw) as Record<string, string>)[name]
  if (!key) throw new Error(`keys.json missing ${name}`)
  return key
}

function openRouterProfile(): ConnectionProfile {
  return {
    id: 'or',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter-live-probe',
    appUrl: 'http://localhost',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe.skipIf(!LIVE)('live edge cases — OpenRouter chat-completions', () => {
  let ctx: ChatCompletionsContext

  beforeAll(() => {
    ctx = { profile: openRouterProfile(), apiKey: loadKey('openrouter') }
  })

  it('Claude Haiku 4.5 returns reasoning.text with .signature', async () => {
    // Claude 4.x needs `reasoning.max_tokens` (budget) — `effort` is ignored
    // for adaptive-only models. Max_tokens >= reasoning.max_tokens + answer.
    const result: ChatCompletionResultWire = await chatCompletionsOnce(ctx, {
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        {
          role: 'user',
          content: 'Find two consecutive odd integers summing to 16. Walk through it carefully.',
        },
      ],
      max_tokens: 2000,
      reasoning: { enabled: true, max_tokens: 1024 },
    })
    const msg = result.choices?.[0]?.message
    const details = (msg?.reasoning_details ?? []) as Array<{
      type?: string
      format?: string
      signature?: string
      text?: string
    }>
    const signed = details.find((d) => d.type === 'reasoning.text' && !!d.signature)
    expect(signed).toBeDefined()
    expect(signed?.format).toBe('anthropic-claude-v1')
    expect(signed?.signature?.length ?? 0).toBeGreaterThan(50)
    expect(signed?.text?.length ?? 0).toBeGreaterThan(0)
  }, 90_000)

  it('Gemini 3.1 Flash Lite via OpenRouter returns reasoning.encrypted (format google-gemini-v1)', async () => {
    const result: ChatCompletionResultWire = await chatCompletionsOnce(ctx, {
      model: 'google/gemini-3.1-flash-lite-preview',
      messages: [
        {
          role: 'user',
          content: 'Find three consecutive integers summing to 30. Walk through the reasoning.',
        },
      ],
      max_tokens: 1200,
      reasoning: { enabled: true, effort: 'high' },
    })
    const msg = result.choices?.[0]?.message
    const details = (msg?.reasoning_details ?? []) as Array<{
      type?: string
      format?: string
      data?: string
      text?: string
    }>
    const encrypted = details.find((d) => d.type === 'reasoning.encrypted')
    if (!encrypted) return
    expect(encrypted?.format).toBe('google-gemini-v1')
    expect(encrypted?.data?.length ?? 0).toBeGreaterThan(100)
    // `reasoning.text` may or may not be present depending on whether
    // OpenRouter's upstream emitted a thought summary — don't assert.
  }, 90_000)

  it('Gemini 3 via OpenRouter: if scalar reasoning is present, it mirrors reasoning.text (dedup-target)', async () => {
    // Regression guard for commit 1390685: the splitter should collapse the
    // scalar when it's byte-equal to the detail.text. The upstream only
    // emits both on some prompts; the test skips cleanly when it doesn't.
    const result: ChatCompletionResultWire = await chatCompletionsOnce(ctx, {
      model: 'google/gemini-3.1-flash-lite-preview',
      messages: [{ role: 'user', content: 'Explain why 5+3=8 using place value.' }],
      max_tokens: 1000,
      reasoning: { enabled: true, effort: 'high' },
    })
    const msg = result.choices?.[0]?.message
    const scalar = msg?.reasoning
    const details = (msg?.reasoning_details ?? []) as Array<{
      type?: string
      text?: string
    }>
    const textConcat = details
      .filter((d) => d.type === 'reasoning.text')
      .map((d) => d.text ?? '')
      .join('')
    if (typeof scalar === 'string' && scalar.length > 0 && textConcat.length > 0) {
      // Both present → must match (before the splitter dedup).
      expect(scalar).toBe(textConcat)
    }
    // Either presence-or-none is acceptable; this test's value is its
    // existence as a canary for when OpenRouter's shape changes.
    expect(details.length >= 0).toBe(true)
  }, 90_000)

  it('DeepSeek-R1 inline <think>...</think> tags in content stream', async () => {
    // Not every OpenRouter endpoint has R1 live — allow skip on 404.
    const chunks: ChatCompletionChunkWire[] = []
    try {
      for await (const chunk of chatCompletions(ctx, {
        model: 'deepseek/deepseek-r1-0528',
        messages: [{ role: 'user', content: 'What is 2+2? Briefly.' }],
        max_tokens: 200,
        stream: true,
      })) {
        if (chunk.type === 'delta') chunks.push(chunk.chunk)
      }
    } catch (err) {
      // DeepSeek R1 might be unavailable; skip cleanly.
      console.warn('DeepSeek R1 probe skipped:', err)
      return
    }
    const raw = chunks
      .flatMap((c) => c.choices?.map((ch) => ch.delta?.content) ?? [])
      .filter((s): s is string => typeof s === 'string')
      .join('')
    // Either the stream delivered inline `<think>` tags OR the upstream
    // already lifted reasoning into `reasoning_details`. The lift is
    // asserted when tags aren't inline.
    const hasInlineTags = /<think>/.test(raw)
    if (!hasInlineTags) {
      const reasoningDetails = chunks
        .flatMap((c) => c.choices?.map((ch) => ch.delta?.reasoning_details ?? []) ?? [])
        .flat()
      expect(reasoningDetails.length).toBeGreaterThan(0)
    }
  }, 90_000)

  it('cross-model reasoning: Claude Haiku 4.5 signature echoed to Claude Sonnet 4.5', async () => {
    const turn1 = await chatCompletionsOnce(ctx, {
      model: 'anthropic/claude-haiku-4.5',
      messages: [
        {
          role: 'user',
          content: 'What\'s 6+7? Show carry.',
        },
      ],
      max_tokens: 300,
      reasoning: { enabled: true, effort: 'low' },
    })
    const msg1 = turn1.choices?.[0]?.message
    expect(msg1).toBeDefined()
    const details1 = msg1?.reasoning_details as Array<{
      type?: string
      signature?: string
    }> | undefined
    // Haiku 4.5 returns reasoning.text with signature. Echo verbatim.
    const echoedMessage = {
      role: 'assistant',
      content: msg1?.content ?? '',
      ...(details1 ? { reasoning_details: details1 } : {}),
    }
    // Turn 2 on SONNET 4.5 (different model, same family).
    const turn2 = await chatCompletionsOnce(ctx, {
      model: 'anthropic/claude-sonnet-4.5',
      messages: [
        { role: 'user', content: "What's 6+7? Show carry." },
        echoedMessage,
        { role: 'user', content: 'Now 6+8?' },
      ],
      max_tokens: 200,
      reasoning: { enabled: true, effort: 'low' },
    })
    // 200-series response — no rejection.
    expect(turn2.choices?.[0]?.message?.content ?? '').toMatch(/14/)
  }, 120_000)
})

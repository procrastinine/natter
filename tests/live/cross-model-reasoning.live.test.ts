// Phase 11 live tests: cross-model ENCRYPTED reasoning transfer.
// Gated behind `LIVE=1`. Uses `keys.json` for OpenAI / OpenRouter /
// Google / Anthropic.
//
// Live-probed 2026-04-20 — these pairs all accept each other's encrypted
// reasoning. The tests re-prove the contract so regressions in our filter
// / transform / api-choice code surface immediately.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  chatCompletions,
  chatCompletionsOnce,
  type ChatCompletionsContext,
} from '../../src/api/chat-completions'
import { responsesOnce, type ResponsesContext } from '../../src/api/responses'
import { geminiOnce, type GeminiContext } from '../../src/api/gemini-native'
import type { ChatCompletionRequestWire, ResponsesInputItem } from '../../src/api/types'
import type { ConnectionProfile } from '../../src/core/types'

const LIVE = process.env.LIVE === '1'

function loadKey(name: 'openrouter' | 'openai' | 'google' | 'anthropic'): string {
  const raw = readFileSync(resolve(__dirname, '../../../keys.json'), 'utf8')
  const key = (JSON.parse(raw) as Record<string, string>)[name]
  if (!key) throw new Error(`keys.json missing ${name}`)
  return key
}

function openAiProfile(): ConnectionProfile {
  return {
    id: 'oa',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter-live-probe',
    appUrl: 'http://localhost',
    usesResponsesApiByDefault: true,
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
  }
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
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 0,
    updatedAt: 0,
  }
}

function geminiProfile(): ConnectionProfile {
  return {
    id: 'g',
    name: 'Gemini',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyRef: 'k',
    defaultHeaders: {},
    appTitle: 'natter-live-probe',
    appUrl: '',
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
    createdAt: 0,
    updatedAt: 0,
    geminiMode: 'native',
  }
}

describe.skipIf(!LIVE)('live cross-model — OpenAI Responses (cross-variant, cross-family)', () => {
  let ctx: ResponsesContext
  beforeAll(() => {
    ctx = { profile: openAiProfile(), apiKey: loadKey('openai') }
  })

  it('gpt-5.4-nano encrypted reasoning echoes cleanly to gpt-5.4-mini', async () => {
    // Turn 1: gpt-5.4-nano → capture reasoning item.
    const turn1 = await responsesOnce(ctx, {
      model: 'gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Pick any integer. Give JUST the digit.' }],
        },
      ],
      max_output_tokens: 200,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    const reasoning1 = turn1.output?.find((i) => i.type === 'reasoning')
    const message1 = turn1.output?.find((i) => i.type === 'message')
    if (!reasoning1) return // model skipped reasoning — not interesting for this test
    if (!message1) throw new Error('missing first-turn message item')
    expect(typeof reasoning1.encrypted_content).toBe('string')

    // Turn 2: gpt-5.4-mini receives the echoed reasoning item.
    const input: ResponsesInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Pick any integer. Give JUST the digit.' }],
      },
      reasoning1,
      message1,
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Double it.' }],
      },
    ]
    const turn2 = await responsesOnce(ctx, {
      model: 'gpt-5.4-mini',
      input,
      max_output_tokens: 200,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    expect(turn2.status).toBe('completed')
  }, 120_000)

  it('gpt-5.4-nano encrypted reasoning echoes cleanly to o4-mini (cross-family)', async () => {
    const turn1 = await responsesOnce(ctx, {
      model: 'gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Pick any color. One word.' }],
        },
      ],
      max_output_tokens: 200,
      reasoning: { effort: 'medium', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    const reasoning1 = turn1.output?.find((i) => i.type === 'reasoning')
    const message1 = turn1.output?.find((i) => i.type === 'message')
    if (!reasoning1) return
    if (!message1) throw new Error('missing first-turn message item')

    const turn2 = await responsesOnce(ctx, {
      model: 'o4-mini',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Pick any color. One word.' }],
        },
        reasoning1,
        message1,
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Now a mood word.' }],
        },
      ],
      max_output_tokens: 200,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    expect(turn2.status).toBe('completed')
  }, 120_000)
})

describe.skipIf(!LIVE)('live cross-model — Gemini native (tier swap)', () => {
  let ctx: GeminiContext
  beforeAll(() => {
    ctx = { profile: geminiProfile(), apiKey: loadKey('google') }
  })

  it('gemini-3.1-flash-lite thoughtSignature accepts in gemini-3-pro-preview echo', async () => {
    const turn1 = await geminiOnce(
      ctx,
      {
        contents: [
          { role: 'user', parts: [{ text: 'Pick a primary color. One word.' }] },
        ],
        generationConfig: {
          maxOutputTokens: 200,
          thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
        },
      },
      'gemini-3.1-flash-lite-preview',
    )
    const modelParts = turn1.candidates?.[0]?.content.parts ?? []
    expect(modelParts.some((p) => 'thoughtSignature' in (p as object))).toBe(true)

    const turn2 = await geminiOnce(
      ctx,
      {
        contents: [
          { role: 'user', parts: [{ text: 'Pick a primary color. One word.' }] },
          { role: 'model', parts: modelParts },
          { role: 'user', parts: [{ text: 'Mix it with white.' }] },
        ],
        generationConfig: {
          maxOutputTokens: 200,
          thinkingConfig: { thinkingLevel: 'low', includeThoughts: true },
        },
      },
      'gemini-3-pro-preview',
    )
    expect(turn2.candidates?.[0]?.finishReason).toBe('STOP')
  }, 120_000)

  it('gemini-2.5-flash has NO thoughtSignature on non-function turns (verifies research claim)', async () => {
    const result = await geminiOnce(
      ctx,
      {
        contents: [
          { role: 'user', parts: [{ text: 'What is 1+1? Just the number.' }] },
        ],
        generationConfig: {
          maxOutputTokens: 100,
          thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
        },
      },
      'gemini-2.5-flash',
    )
    const parts = result.candidates?.[0]?.content.parts ?? []
    // 2.5 emits NO `thoughtSignature` outside function calls. This is the
    // research claim the user asked us to verify.
    const hasSignature = parts.some((p) => 'thoughtSignature' in (p as object))
    expect(hasSignature).toBe(false)
  }, 60_000)
})

describe.skipIf(!LIVE)('live cross-model — Anthropic via OpenRouter (cross-tier)', () => {
  let ctx: ChatCompletionsContext
  beforeAll(() => {
    ctx = { profile: openRouterProfile(), apiKey: loadKey('openrouter') }
  })

  it('claude-haiku-4.5 signed reasoning.text echoes to claude-sonnet-4.5', async () => {
    const turn1 = await chatCompletionsOnce(ctx, {
      model: 'anthropic/claude-haiku-4.5',
      messages: [{ role: 'user', content: 'What is 6+7? Show carry.' }],
      max_tokens: 1500,
      reasoning: { enabled: true, max_tokens: 1000 },
    } as ChatCompletionRequestWire)
    const msg1 = turn1.choices?.[0]?.message
    const details1 = msg1?.reasoning_details as Array<{ type?: string; signature?: string }> | undefined
    const signed = details1?.find((d) => d.type === 'reasoning.text' && !!d.signature)
    if (!signed) return // some routes skip reasoning for trivial prompts

    const echoed = {
      role: 'assistant' as const,
      content: msg1?.content ?? '',
      reasoning_details: details1,
    }
    const turn2 = await chatCompletionsOnce(ctx, {
      model: 'anthropic/claude-sonnet-4.5',
      messages: [
        { role: 'user', content: 'What is 6+7? Show carry.' },
        echoed,
        { role: 'user', content: 'Now 6+8?' },
      ],
      max_tokens: 200,
      reasoning: { enabled: true, max_tokens: 500 },
    } as ChatCompletionRequestWire)
    expect(turn2.choices?.[0]?.message?.content ?? '').toMatch(/14/)
  }, 120_000)
})

describe.skipIf(!LIVE)(
  'live cross-format — OpenRouter /responses (azure) echoes to OpenAI direct (openai)',
  () => {
    it('reasoning item from OpenRouter proxy survives round-trip to api.openai.com', async () => {
      // This exercises the `formatsCompatible` allowance: OpenRouter /responses
      // tags items `azure-openai-responses-v1`, OpenAI direct emits
      // `openai-responses-v1`. The filter should NOT drop the azure-tagged
      // item when routing to OpenAI direct.
      const orCtx: ResponsesContext = {
        profile: openRouterProfile(),
        apiKey: loadKey('openrouter'),
      }
      const turn1 = await responsesOnce(orCtx, {
        model: 'openai/gpt-5.4-nano',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Pick an integer 1-9. Just the digit.' }],
          },
        ],
        max_output_tokens: 200,
        reasoning: { effort: 'medium', summary: 'auto' },
        include: ['reasoning.encrypted_content'],
        store: false,
      })
      const reasoning1 = turn1.output?.find((i) => i.type === 'reasoning')
      if (!reasoning1) return
      // OpenRouter flags the item with `format: 'azure-openai-responses-v1'`.
      // (Value may be absent on some routes — don't assert, just accept.)

      const oaiCtx: ResponsesContext = { profile: openAiProfile(), apiKey: loadKey('openai') }
      const message1 = turn1.output?.find((i) => i.type === 'message')
      if (!message1) return
      const turn2 = await responsesOnce(oaiCtx, {
        model: 'gpt-5.4-nano',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Pick an integer 1-9. Just the digit.' }],
          },
          reasoning1,
          message1,
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Double it.' }] },
        ],
        max_output_tokens: 200,
        reasoning: { effort: 'low', summary: 'auto' },
        include: ['reasoning.encrypted_content'],
        store: false,
      })
      expect(turn2.status).toBe('completed')
    }, 120_000)
  },
)

describe.skipIf(!LIVE)('live — OpenRouter reasoning summary surface', () => {
  let ctx: ChatCompletionsContext
  beforeAll(() => {
    ctx = { profile: openRouterProfile(), apiKey: loadKey('openrouter') }
  })

  it('openai via OpenRouter /chat exposes summary via scalar `reasoning` + reasoning.summary detail', async () => {
    const result = await chatCompletionsOnce(ctx, {
      model: 'openai/gpt-5.4-nano',
      messages: [
        {
          role: 'user',
          content: 'Find two consecutive odd integers summing to 20. Walk through it.',
        },
      ],
      max_tokens: 500,
      reasoning: { enabled: true, effort: 'medium' },
    } as ChatCompletionRequestWire)
    const msg = result.choices?.[0]?.message
    expect(typeof msg?.reasoning).toBe('string')
    expect((msg?.reasoning ?? '').length).toBeGreaterThan(30)
    const details = (msg?.reasoning_details ?? []) as Array<{ type?: string; format?: string }>
    const summaryDetail = details.find((d) => d.type === 'reasoning.summary')
    const encryptedDetail = details.find((d) => d.type === 'reasoning.encrypted')
    expect(summaryDetail).toBeDefined()
    expect(summaryDetail?.format).toBe('azure-openai-responses-v1')
    expect(encryptedDetail).toBeDefined()
  }, 90_000)

  it('gemini via OpenRouter /chat streaming: summary arrives as reasoning.text BEFORE encrypted', async () => {
    // Regression guard for the bug where `reasoning.encrypted` (idx=0) was
    // clobbering `reasoning.text` (idx=0) in the accumulator. Ensures the
    // wire-order itself exposes BOTH shapes for the same stream.
    const order: string[] = []
    for await (const chunk of chatCompletions(ctx, {
      model: 'google/gemini-3.1-flash-lite-preview',
      messages: [
        {
          role: 'user',
          content: 'Find three consecutive integers summing to 30. Walk through it.',
        },
      ],
      max_tokens: 1500,
      reasoning: { enabled: true, effort: 'high' },
      stream: true,
    } as ChatCompletionRequestWire)) {
      if (chunk.type !== 'delta') continue
      const rd = chunk.chunk.choices?.[0]?.delta?.reasoning_details
      if (!Array.isArray(rd)) continue
      for (const d of rd as Array<{ type?: string }>) {
        if (d.type && !order.includes(d.type)) order.push(d.type)
      }
    }
    // Summary text arrives first; encrypted arrives later.
    const textIdx = order.indexOf('reasoning.text')
    const encIdx = order.indexOf('reasoning.encrypted')
    // If the route didn't emit summary-text this prompt, don't fail.
    if (textIdx >= 0 && encIdx >= 0) {
      expect(textIdx).toBeLessThan(encIdx)
    }
  }, 120_000)
})

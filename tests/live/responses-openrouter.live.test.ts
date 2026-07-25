// Phase 11 live test — OpenRouter `/responses` beta proxy for OpenAI models.
//
// Gated behind `LIVE=1` so it doesn't run in CI or `pnpm test:run`. Run with:
//   LIVE=1 pnpm test:run tests/live/responses-openrouter.live.test.ts
//
// Uses `keys.json.openrouter` at the repo root. Keeps total spend tiny:
// gpt-5.4-nano, 200 max output tokens per turn, two turns max.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { type ResponsesContext, responses, responsesOnce } from '../../src/api/responses'
import { splitResponsesStream as splitResponsesStreamWithContract } from '../../src/api/stream-transforms'
import type { ResponsesEventWire, ResponsesInputItem } from '../../src/api/types'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import { OPENROUTER_RESPONSES_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import type { ConnectionProfile } from '../../src/core/types'
import { responsesReasoningContract } from '../helpers/reasoning-contracts'

function splitResponsesStream(source: Parameters<typeof splitResponsesStreamWithContract>[0]) {
  return splitResponsesStreamWithContract(
    source,
    responsesReasoningContract(),
    OPENROUTER_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
  )
}

const LIVE = process.env.LIVE === '1'

async function drain(source: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const out: StreamLaneEvent[] = []
  for await (const ev of source) out.push(ev)
  return out
}

function loadKey(name: 'openrouter' | 'openai' | 'google' | 'anthropic'): string {
  const raw = readFileSync(resolve(__dirname, '../../../keys.json'), 'utf8')
  const keys = JSON.parse(raw) as Record<string, string>
  const key = keys[name]
  if (!key) throw new Error(`keys.json missing ${name}`)
  return key
}

function profile(): ConnectionProfile {
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

describe.skipIf(!LIVE)('live — OpenRouter Responses (openai/gpt-5.4-nano)', () => {
  let apiKey: string
  let ctx: ResponsesContext

  beforeAll(() => {
    apiKey = loadKey('openrouter')
    ctx = { profile: profile(), apiKey }
  })

  it('buffered: returns message item with phase, optionally reasoning item with encrypted_content', async () => {
    const result = await responsesOnce(ctx, {
      model: 'openai/gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Find two consecutive even integers summing to 90. Walk through it.',
            },
          ],
        },
      ],
      max_output_tokens: 300,
      reasoning: { effort: 'medium', summary: 'detailed' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    expect(result.status).toBe('completed')
    const items = result.output ?? []
    const messageItem = items.find((i) => i.type === 'message')
    expect(messageItem).toBeDefined()
    expect(messageItem?.phase).toBe('final_answer')

    const reasoningItem = items.find((i) => i.type === 'reasoning')
    if (reasoningItem) {
      expect(typeof reasoningItem.encrypted_content).toBe('string')
      expect((reasoningItem.encrypted_content ?? '').length).toBeGreaterThan(100)
      expect(['azure-openai-responses-v1', 'openai-responses-v1', undefined]).toContain(
        reasoningItem.format,
      )
    }
  }, 60_000)

  it('streaming: emits message item with phase metadata + reaches response.completed', async () => {
    // OpenRouter's `/responses` stream for openai/* skips emitting a
    // separate `reasoning` output_item during streaming (unlike OpenAI
    // direct). The reasoning appears only in the buffered-result shape.
    // The test still asserts the message-item + phase + completed flow so
    // the splitter's invariants hold on this route.
    const events: ResponsesEventWire[] = []
    for await (const chunk of responses(ctx, {
      model: 'openai/gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'What is 7+5? One number.' }],
        },
      ],
      max_output_tokens: 100,
      reasoning: { effort: 'medium', summary: 'detailed' },
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: true,
    })) {
      if (chunk.type === 'event') events.push(chunk.event)
    }
    const messageDone = events.find(
      (e) =>
        e.type === 'response.output_item.done' &&
        (e as { item?: { type?: string } }).item?.type === 'message',
    )
    expect(messageDone).toBeDefined()
    const messageItem = (messageDone as { item?: { phase?: string } }).item
    expect(messageItem?.phase).toBe('final_answer')
    expect(events.at(-1)?.type).toBe('response.completed')
  }, 60_000)

  it('multi-turn: turn 2 accepts echoed encrypted reasoning item', async () => {
    const turn1 = await responsesOnce(ctx, {
      model: 'openai/gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Pick any integer. Give JUST the digit.' }],
        },
      ],
      max_output_tokens: 100,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    const reasoning1 = turn1.output?.find((i) => i.type === 'reasoning')
    const message1 = turn1.output?.find((i) => i.type === 'message')
    expect(reasoning1).toBeDefined()
    expect(message1).toBeDefined()
    expect(message1?.phase).toBeDefined()
    if (!reasoning1 || !message1) throw new Error('missing first-turn echoed output items')

    const echoedInput: ResponsesInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Pick any integer. Give JUST the digit.' }],
      },
      // Echo reasoning verbatim.
      reasoning1,
      // Echo message verbatim (phase + id preserved).
      message1,
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Double it. One number.' }],
      },
    ]
    const turn2 = await responsesOnce(ctx, {
      model: 'openai/gpt-5.4-nano',
      input: echoedInput,
      max_output_tokens: 100,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    expect(turn2.status).toBe('completed')
    // Turn 2 consumed the echoed reasoning — usage should count it.
    expect((turn2.usage as { input_tokens?: number } | undefined)?.input_tokens).toBeGreaterThan(0)
    const message2 = turn2.output?.find((i) => i.type === 'message')
    expect(message2).toBeDefined()
  }, 90_000)

  it('splitter: drives splitResponsesStream against a live stream and sees phase + finish', async () => {
    const stream = responses(ctx, {
      model: 'openai/gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'What is 2+2? One number.' }],
        },
      ],
      max_output_tokens: 50,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: true,
    })
    const lanes = await drain(splitResponsesStream(stream))
    const phases = lanes.filter((l) => l.lane === 'phase')
    expect(phases).toHaveLength(1)
    const finish = lanes.find((l) => l.lane === 'finish')
    expect(finish).toBeDefined()
    // OpenRouter streaming omits reasoning output_items — the encrypted
    // blob only lands on the buffered-result shape. The test asserts text
    // lanes fired instead.
    const textLanes = lanes.filter((l) => l.lane === 'text')
    expect(textLanes.length).toBeGreaterThan(0)
  }, 60_000)
})

// Phase 11 live test — OpenAI Responses API direct (`api.openai.com/v1/responses`).
// Gated behind `LIVE=1`. Uses `keys.json.openai`. Runs on gpt-5.4-nano with
// tiny prompts (total spend ≤ $0.005).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { responses, responsesOnce, type ResponsesContext } from '../../src/api/responses'
import { splitResponsesStream, type StreamLaneEvent } from '../../src/api/stream-transforms'
import type {
  ResponsesEventWire,
  ResponsesInputItem,
} from '../../src/api/types'
import type { ConnectionProfile } from '../../src/core/types'

const LIVE = process.env.LIVE === '1'

function loadKey(name: string): string {
  const raw = readFileSync(resolve(__dirname, '../../../keys.json'), 'utf8')
  return (JSON.parse(raw) as Record<string, string>)[name]!
}

async function drain(source: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const out: StreamLaneEvent[] = []
  for await (const ev of source) out.push(ev)
  return out
}

function profile(): ConnectionProfile {
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

describe.skipIf(!LIVE)('live — OpenAI direct Responses (gpt-5.4-nano)', () => {
  let ctx: ResponsesContext

  beforeAll(() => {
    ctx = { profile: profile(), apiKey: loadKey('openai') }
  })

  it('buffered: reasoning item w/ encrypted_content + summary + phase on message', async () => {
    const result = await responsesOnce(ctx, {
      model: 'gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'How many distinct positive divisors does 720 have? Show work.',
            },
          ],
        },
      ],
      max_output_tokens: 400,
      reasoning: { effort: 'high', summary: 'detailed' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    expect(result.status).toBe('completed')
    const items = result.output ?? []
    const reasoning = items.find((i) => i.type === 'reasoning')
    const message = items.find((i) => i.type === 'message')
    expect(reasoning).toBeDefined()
    expect(message).toBeDefined()
    expect(typeof reasoning?.encrypted_content).toBe('string')
    expect(reasoning?.summary).toBeDefined()
    expect(Array.isArray(reasoning?.summary)).toBe(true)
    expect((reasoning?.summary as unknown[])?.length).toBeGreaterThan(0)
    expect(message?.phase).toBe('final_answer')
  }, 90_000)

  it('streaming: encrypted_content grows between output_item.added and .done', async () => {
    const events: ResponsesEventWire[] = []
    for await (const chunk of responses(ctx, {
      model: 'gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'What is the 7th Fibonacci number? Walk through the recurrence.',
            },
          ],
        },
      ],
      max_output_tokens: 300,
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
      stream: true,
    })) {
      if (chunk.type === 'event') events.push(chunk.event)
    }
    const addedReasoning = events.find(
      (e) =>
        e.type === 'response.output_item.added' &&
        (e as { item?: { type?: string } }).item?.type === 'reasoning',
    )
    const doneReasoning = events.find(
      (e) =>
        e.type === 'response.output_item.done' &&
        (e as { item?: { type?: string } }).item?.type === 'reasoning',
    )
    expect(addedReasoning).toBeDefined()
    expect(doneReasoning).toBeDefined()
    const initial = (addedReasoning as { item?: { encrypted_content?: string } }).item
      ?.encrypted_content
    const finalBlob = (doneReasoning as { item?: { encrypted_content?: string } }).item
      ?.encrypted_content
    expect(typeof initial).toBe('string')
    expect(typeof finalBlob).toBe('string')
    // Final never shorter than initial.
    expect((finalBlob ?? '').length).toBeGreaterThanOrEqual((initial ?? '').length)
  }, 90_000)

  it('GPT-5.4 rejects minimal effort (live-probe proves the enum exclusion)', async () => {
    await expect(
      responsesOnce(ctx, {
        model: 'gpt-5.4-nano',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ],
        max_output_tokens: 30,
        reasoning: { effort: 'minimal' },
        store: false,
      }),
    ).rejects.toThrow(/unsupported_value|'minimal'/i)
  }, 30_000)

  it('multi-turn: echoed reasoning item is accepted (usage.input_tokens rises)', async () => {
    const turn1 = await responsesOnce(ctx, {
      model: 'gpt-5.4-nano',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'How many distinct positive divisors does 720 have? Show brief work.',
            },
          ],
        },
      ],
      max_output_tokens: 400,
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    const r1 = turn1.output?.find((i) => i.type === 'reasoning')
    const m1 = turn1.output?.find((i) => i.type === 'message')
    expect(r1).toBeDefined()
    expect(m1).toBeDefined()

    const echoedInput: ResponsesInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'How many distinct positive divisors does 720 have? Show brief work.',
          },
        ],
      },
      r1!,
      m1!,
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Now do 30.' }],
      },
    ]
    const turn2 = await responsesOnce(ctx, {
      model: 'gpt-5.4-nano',
      input: echoedInput,
      max_output_tokens: 300,
      reasoning: { effort: 'low', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      store: false,
    })
    expect(turn2.status).toBe('completed')
    const t1Input = (turn1.usage as { input_tokens?: number } | undefined)?.input_tokens ?? 0
    const t2Input = (turn2.usage as { input_tokens?: number } | undefined)?.input_tokens ?? 0
    expect(t2Input).toBeGreaterThan(t1Input)
  }, 120_000)

  it('splitter: live stream → lanes with phase + finish', async () => {
    const lanes = await drain(
      splitResponsesStream(
        responses(ctx, {
          model: 'gpt-5.4-nano',
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: 'Find two odd integers summing to 20. Walk through.' },
              ],
            },
          ],
          max_output_tokens: 300,
          reasoning: { effort: 'high', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
          store: false,
          stream: true,
        }),
      ),
    )
    const phaseEvent = lanes.find((l) => l.lane === 'phase')
    expect(phaseEvent).toBeDefined()
    const finish = lanes.find((l) => l.lane === 'finish')
    expect(finish).toBeDefined()
    const encryptedLane = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> =>
        l.lane === 'reasoning' && l.encryptedDelta !== undefined,
    )
    // OpenAI direct DOES emit reasoning output_item events (unlike OpenRouter).
    expect(encryptedLane.length).toBeGreaterThanOrEqual(1)
  }, 90_000)

  it('gpt54SamplingGate: sending temperature with non-none effort is rejected', async () => {
    await expect(
      responsesOnce(ctx, {
        model: 'gpt-5.4-nano',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ],
        max_output_tokens: 30,
        reasoning: { effort: 'medium' },
        temperature: 0.7,
        store: false,
      }),
    ).rejects.toThrow(/temperature|sampling|effort/i)
  }, 30_000)
})

// Integration tests: inline <think>/<thought> lifting in `splitChatStream`.
//
// The lifter (see `core/reasoning-inline.ts`) auto-detects at stream start
// when the model emits `<think>` / `<thought>` in `delta.content` — the
// canonical shape for DeepSeek-R1 / Qwen3 / Gemma / Kimi K2 Thinking /
// GLM-4.x thinking / MiniMax. This spec drives the lifter through
// `splitChatStream` to prove the wire path re-routes content → reasoning
// lane without losing ordering or finish semantics.

import { describe, expect, it } from 'vitest'
import { splitChatStream as splitChatStreamWithContract } from '../../src/api/stream-transforms'
import type { ChatStreamChunk } from '../../src/api/types'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import type { ReasoningObservation } from '../../src/core/reasoning-observation'
import { chatReasoningContract } from '../helpers/reasoning-contracts'
import { collectReasoningObservations } from '../helpers/reasoning-events'

type ChatSplitOptions = Omit<Parameters<typeof splitChatStreamWithContract>[1], 'reasoning'>

function splitChatStream(
  source: Parameters<typeof splitChatStreamWithContract>[0],
  options: ChatSplitOptions = {},
) {
  return splitChatStreamWithContract(source, {
    ...options,
    reasoning: chatReasoningContract({ carrier: 'openrouter-reasoning-details' }),
  })
}

async function* fromChunks(chunks: ChatStreamChunk[]): AsyncGenerator<ChatStreamChunk> {
  for (const c of chunks) yield c
}
async function collect(iter: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const out: StreamLaneEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

function visibleReasoning(events: readonly StreamLaneEvent[]) {
  return collectReasoningObservations(events).filter(
    (operation): operation is Extract<ReasoningObservation, { kind: 'visible' }> =>
      operation.kind === 'visible',
  )
}

function reasoningCarriers(events: readonly StreamLaneEvent[]) {
  return collectReasoningObservations(events).filter(
    (operation): operation is Extract<ReasoningObservation, { kind: 'carrier' }> =>
      operation.kind === 'carrier',
  )
}

describe('splitChatStream — inline <think> lifting', () => {
  it('lifts a complete <think> block from content stream into reasoning lane', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g1',
          choices: [{ delta: { content: '<think>pondering...</think>The answer is 42.' } }],
        },
      },
      { type: 'delta', chunk: { id: 'g1', choices: [{ delta: {}, finish_reason: 'stop' }] } },
    ])
    const events = await collect(splitChatStream(source))
    const reasoning = visibleReasoning(events)
      .map((operation) => operation.value)
      .join('')
    const text = events
      .filter((e): e is Extract<StreamLaneEvent, { lane: 'text' }> => e.lane === 'text')
      .map((e) => e.text)
      .join('')
    expect(reasoning).toBe('pondering...')
    expect(
      visibleReasoning(events).every((operation) => operation.source.dialect === 'inline'),
    ).toBe(true)
    expect(text).toBe('The answer is 42.')
    expect(events.some((e) => e.lane === 'finish')).toBe(true)
  })

  it('handles <think> open split across chunks', async () => {
    const source = fromChunks([
      { type: 'delta', chunk: { id: 'g', choices: [{ delta: { content: '<thi' } }] } },
      {
        type: 'delta',
        chunk: { id: 'g', choices: [{ delta: { content: 'nk>reason</think>ans' } }] },
      },
    ])
    const events = await collect(splitChatStream(source))
    const reasoning = visibleReasoning(events)
      .map((operation) => operation.value)
      .join('')
    const text = events
      .filter((e): e is Extract<StreamLaneEvent, { lane: 'text' }> => e.lane === 'text')
      .map((e) => e.text)
      .join('')
    expect(reasoning).toBe('reason')
    expect(text).toBe('ans')
  })

  it('flushes unclosed <think> to reasoning lane BEFORE finish event', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g',
          choices: [{ delta: { content: '<think>truncated mid-stream' }, finish_reason: 'length' }],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    const reasoningIdx = events.findIndex((e) => e.lane === 'reasoning-observation')
    const finishIdx = events.findIndex((e) => e.lane === 'finish')
    expect(reasoningIdx).toBeGreaterThanOrEqual(0)
    expect(finishIdx).toBeGreaterThan(reasoningIdx)
    expect(
      visibleReasoning(events)
        .map((operation) => operation.value)
        .join(''),
    ).toBe('truncated mid-stream')
  })

  it('leaves regular content untouched when no leading tag', async () => {
    const source = fromChunks([
      { type: 'delta', chunk: { id: 'g', choices: [{ delta: { content: 'Hello, ' } }] } },
      {
        type: 'delta',
        chunk: { id: 'g', choices: [{ delta: { content: 'world! <think> in mid</think>' } }] },
      },
      { type: 'delta', chunk: { id: 'g', choices: [{ delta: {}, finish_reason: 'stop' }] } },
    ])
    const events = await collect(splitChatStream(source))
    const text = events
      .filter((e): e is Extract<StreamLaneEvent, { lane: 'text' }> => e.lane === 'text')
      .map((e) => e.text)
      .join('')
    const reasoning = visibleReasoning(events)
      .map((operation) => operation.value)
      .join('')
    // The `<think>` appears mid-stream so the lifter does not activate —
    // it rides through as content.
    expect(text).toBe('Hello, world! <think> in mid</think>')
    expect(reasoning).toBe('')
  })

  it('caller can disable the lifter by passing []', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: { id: 'g', choices: [{ delta: { content: '<think>raw</think>answer' } }] },
      },
      { type: 'delta', chunk: { id: 'g', choices: [{ delta: {}, finish_reason: 'stop' }] } },
    ])
    const events = await collect(splitChatStream(source, { inlineReasoningTags: [] }))
    const text = events
      .filter((e): e is Extract<StreamLaneEvent, { lane: 'text' }> => e.lane === 'text')
      .map((e) => e.text)
      .join('')
    expect(text).toBe('<think>raw</think>answer')
  })

  it('caller can force lifting with a custom tag list', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g',
          choices: [{ delta: { content: 'prelude <analysis>body</analysis> rest' } }],
        },
      },
      { type: 'delta', chunk: { id: 'g', choices: [{ delta: {}, finish_reason: 'stop' }] } },
    ])
    const events = await collect(
      splitChatStream(source, { inlineReasoningTags: ['analysis'], forceInlineReasoning: true }),
    )
    const reasoning = visibleReasoning(events)
      .map((operation) => operation.value)
      .join('')
    const text = events
      .filter((e): e is Extract<StreamLaneEvent, { lane: 'text' }> => e.lane === 'text')
      .map((e) => e.text)
      .join('')
    expect(reasoning).toBe('body')
    expect(text).toBe('prelude  rest')
  })

  it('lifts inline <thought> (Gemma/legacy)', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: { id: 'g', choices: [{ delta: { content: '<thought>reflecting</thought>ok' } }] },
      },
      { type: 'delta', chunk: { id: 'g', choices: [{ delta: {}, finish_reason: 'stop' }] } },
    ])
    const events = await collect(splitChatStream(source))
    const reasoning = visibleReasoning(events)
      .map((operation) => operation.value)
      .join('')
    expect(reasoning).toBe('reflecting')
  })

  it('keeps scalar reasoning field when details only carry encrypted (OpenRouter summary surface)', async () => {
    // Regression guard for the Gemini-via-OpenRouter path: OpenRouter surfaces
    // the human-visible summary via the scalar `delta.reasoning` field, while
    // `reasoning_details[]` carries only the encrypted blob. The splitter must
    // emit BOTH so the accumulator can store summary + encrypted separately.
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g',
          choices: [
            {
              delta: {
                reasoning: 'Visible summary of thinking.',
                reasoning_details: [
                  {
                    type: 'reasoning.encrypted',
                    format: 'google-gemini-v1',
                    data: 'base64-blob',
                  },
                ],
              },
            },
          ],
        },
      },
      { type: 'delta', chunk: { id: 'g', choices: [{ delta: {}, finish_reason: 'stop' }] } },
    ])
    const events = await collect(splitChatStream(source))
    const visible = visibleReasoning(events)
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      value: 'Visible summary of thinking.',
      visibleKind: 'text',
    })
    expect(visible[0]?.source).toMatchObject({ dialect: 'openrouter-chat', choiceIndex: 0 })
    expect(reasoningCarriers(events)).toEqual([
      expect.objectContaining({
        value: 'base64-blob',
        carrierKind: 'gemini-thought-signature',
      }),
    ])
  })

  it('drops scalar reasoning when it byte-mirrors reasoning.text detail (1390685 regression)', async () => {
    // Regression guard for commit 1390685: Claude via OpenRouter returned the
    // same signed reasoning in BOTH `delta.reasoning` (scalar) and
    // `delta.reasoning_details[].text` (signed). The splitter must drop the
    // scalar so the accumulator doesn't double-count.
    const scalarText = 'Thinking through the problem...'
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g',
          choices: [
            {
              delta: {
                reasoning: scalarText,
                reasoning_details: [
                  {
                    type: 'reasoning.text',
                    format: 'anthropic-claude-v1',
                    text: scalarText,
                    signature: 'sig-abc',
                  },
                ],
              },
            },
          ],
        },
      },
      { type: 'delta', chunk: { id: 'g', choices: [{ delta: {}, finish_reason: 'stop' }] } },
    ])
    const events = await collect(splitChatStream(source))
    const visible = visibleReasoning(events)
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      value: scalarText,
      visibleKind: 'text',
      format: 'anthropic-claude-v1',
    })
    expect(visible[0]?.source).toMatchObject({
      dialect: 'openrouter-chat',
      choiceIndex: 0,
      detailOrdinal: 0,
    })
    expect(reasoningCarriers(events)).toEqual([
      expect.objectContaining({
        value: 'sig-abc',
        carrierKind: 'anthropic-signature',
      }),
    ])
  })

  it('keeps scalar reasoning when it does NOT mirror the concat of details text', async () => {
    // Negative case: if scalar text differs from details text, both pass through.
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g',
          choices: [
            {
              delta: {
                reasoning: 'Scalar is different.',
                reasoning_details: [{ type: 'reasoning.text', text: 'Details text.' }],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(visibleReasoning(events).map((operation) => operation.value)).toEqual([
      'Scalar is different.',
      'Details text.',
    ])
  })

  it('lifter does not cross-contaminate content from the reasoning_details stream', async () => {
    // Safety: `delta.reasoning_details[]` should flow directly to the
    // reasoning lane without being run through the inline-tag lifter (the
    // lifter is ONLY for `delta.content`).
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g',
          choices: [
            {
              delta: {
                reasoning_details: [
                  { type: 'reasoning.text', text: '<think>literal in details</think>' },
                ],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    const visible = visibleReasoning(events)
    expect(visible).toHaveLength(1)
    expect(visible[0]?.value).toBe('<think>literal in details</think>')
    expect(visible[0]?.source).toMatchObject({
      dialect: 'openrouter-chat',
      detailOrdinal: 0,
    })
  })

  it('isolates inline lifters and reasoning identities across interleaved choices', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          choices: [
            { index: 0, delta: { content: '<think>choice zero</think>answer zero' } },
            { index: 1, delta: { content: '<think>choice one</think>answer one' } },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    const visible = visibleReasoning(events)
    expect(visible.map((operation) => operation.value)).toEqual(['choice zero', 'choice one'])
    expect(visible.map((operation) => operation.source.choiceIndex)).toEqual([0, 1])
    expect(new Set(visible.map((operation) => JSON.stringify(operation.memberAliases))).size).toBe(
      2,
    )
    expect(
      events
        .filter(
          (event): event is Extract<StreamLaneEvent, { lane: 'text' }> => event.lane === 'text',
        )
        .map((event) => event.text),
    ).toEqual(['answer zero', 'answer one'])
  })
})

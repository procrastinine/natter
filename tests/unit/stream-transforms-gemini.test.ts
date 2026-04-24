// Phase 11: `splitGeminiStream` unit tests. Fixture-driven using probe 8
// (streaming) and probe 3 (buffered), plus synthetic multi-part streams to
// exercise the `thought:true` + `thoughtSignature` multi-part contract
// confirmed by live probes:
//
//   - Gemini 3 with `includeThoughts:true` + `thinkingLevel:high` emits a
//     `{text, thought:true}` summary part AND a `{text, thoughtSignature}`
//     final part in the same response.
//   - At low thinking the summary part may be skipped; only the signature part arrives.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  GeminiStreamChunk,
  GenerateContentResponseWire,
} from '../../src/api/gemini-types'
import { splitGeminiStream, type StreamLaneEvent } from '../../src/api/stream-transforms'

const PROBE8 = resolve(__dirname, '../../../plan/phase11-probes/08-gemini-native-stream.sse')
const PROBE3 = resolve(__dirname, '../../../plan/phase11-probes/03-gemini-native.json')

async function* asAsync<T>(it: Iterable<T>): AsyncIterable<T> {
  for (const value of it) yield value
}

async function collect(source: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const out: StreamLaneEvent[] = []
  for await (const ev of source) out.push(ev)
  return out
}

function sseToChunks(body: string): GeminiStreamChunk[] {
  const blocks = body.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0)
  const out: GeminiStreamChunk[] = []
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
    if (dataLines.length === 0) continue
    const json = dataLines.join('\n')
    const parsed = JSON.parse(json) as GenerateContentResponseWire
    out.push({ type: 'chunk', chunk: parsed })
  }
  return out
}

describe('splitGeminiStream — probe 8 (native stream w/ thoughtSignature)', () => {
  it('emits meta + text + one replaceEncrypted reasoning event + finish', async () => {
    const body = readFileSync(PROBE8, 'utf8')
    const lanes = await collect(splitGeminiStream(asAsync(sseToChunks(body))))

    const firstMeta = lanes.find((l) => l.lane === 'meta') as
      | Extract<StreamLaneEvent, { lane: 'meta' }>
      | undefined
    expect(firstMeta?.model).toBe('gemini-3.1-flash-lite-preview')
    expect(firstMeta?.generationId).toBeDefined()

    const texts = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'text' }> => l.lane === 'text',
    )
    expect(texts.length).toBeGreaterThan(0)

    const reasoning = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> => l.lane === 'reasoning',
    )
    const encrypted = reasoning.filter((r) => r.encryptedDelta !== undefined)
    expect(encrypted.length).toBe(1)
    expect(encrypted[0]?.replaceEncrypted).toBe(true)
    expect(encrypted[0]?.encryptedDelta?.length).toBeGreaterThan(100)

    expect(lanes.some((l) => l.lane === 'usage')).toBe(true)
    const finish = lanes.find((l) => l.lane === 'finish') as
      | Extract<StreamLaneEvent, { lane: 'finish' }>
      | undefined
    expect(finish?.finishReason).toBe('stop')
  })
})

describe('splitGeminiStream — coalesces thought:true parts into one summary row', () => {
  it('all thought:true parts share summaryIndex: 0 with `\\n\\n` separators', async () => {
    // Gemini emits each thinking section as its own atomic `thought: true`
    // part. Earlier behavior assigned each a unique summaryIndex, which
    // produced one reasoning.summary row per section in storage and one
    // visual block per section in the UI. The user-facing complaint:
    // separate paragraphs of the same logical reasoning got rendered as
    // distinct blocks. Fix: coalesce to ONE row by sharing summaryIndex
    // across all parts; the accumulator's mergeReasoningText concatenates
    // them (with the `\n\n` we prepend on non-first parts) into a single
    // continuous summary.
    const frames: GenerateContentResponseWire[] = [
      {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Thought A', thought: true }] } },
        ],
      },
      {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Thought B', thought: true }] } },
        ],
      },
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'Thought C', thought: true }] },
            finishReason: 'STOP',
          },
        ],
      },
    ]
    const chunks: GeminiStreamChunk[] = frames.map((f) => ({ type: 'chunk', chunk: f }))
    const lanes = await collect(splitGeminiStream(asAsync(chunks)))
    const summaries = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> =>
        l.lane === 'reasoning' && l.summaryDelta !== undefined,
    )
    // All parts coalesce into summaryIndex: 0.
    expect(summaries.map((s) => s.summaryIndex)).toEqual([0, 0, 0])
    // First emits as-is; subsequent prepend `\n\n` so the merged row has
    // section breaks even when the wire text didn't include trailing
    // newlines (real Gemini sections often end with `\n\n\n` already, in
    // which case the result is just extra blank lines — fine in markdown).
    expect(summaries.map((s) => s.summaryDelta)).toEqual([
      'Thought A',
      '\n\nThought B',
      '\n\nThought C',
    ])
  })
})

describe('splitGeminiStream — both summary + signature in one stream', () => {
  it('emits summaryDelta for thought:true parts AND encryptedDelta for thoughtSignature', async () => {
    // Synthetic: mimics the live-probed Gemini 3 high-thinking response.
    const frames: GenerateContentResponseWire[] = [
      {
        candidates: [
          { content: { role: 'model', parts: [{ text: '**Thinking step 1**', thought: true }] } },
        ],
      },
      {
        candidates: [
          { content: { role: 'model', parts: [{ text: '**Thinking step 2**', thought: true }] } },
        ],
      },
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'The answer is 10. ' }] } }],
      },
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: '', thoughtSignature: 'SIG_FINAL_BLOB' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 20,
          totalTokenCount: 30,
          thoughtsTokenCount: 15,
        },
      },
    ]
    const chunks: GeminiStreamChunk[] = frames.map((f) => ({ type: 'chunk', chunk: f }))
    const lanes = await collect(splitGeminiStream(asAsync(chunks)))

    // 2 thought summaries + 1 visible text + 1 signature
    const summaries = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> =>
        l.lane === 'reasoning' && l.summaryDelta !== undefined,
    )
    expect(summaries).toHaveLength(2)
    expect(summaries.map((s) => s.summaryDelta)).toEqual([
      '**Thinking step 1**',
      '\n\n**Thinking step 2**',
    ])
    expect(summaries.every((s) => s.summaryIndex === 0)).toBe(true)

    const texts = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'text' }> => l.lane === 'text',
    )
    expect(texts).toHaveLength(1)
    expect(texts[0]?.text).toBe('The answer is 10. ')

    const encryptedEvents = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'reasoning' }> =>
        l.lane === 'reasoning' && l.encryptedDelta !== undefined,
    )
    expect(encryptedEvents).toHaveLength(1)
    expect(encryptedEvents[0]?.encryptedDelta).toBe('SIG_FINAL_BLOB')
    expect(encryptedEvents[0]?.replaceEncrypted).toBe(true)

    // usage maps thoughtsTokenCount → completion_tokens_details.reasoning_tokens
    const usage = lanes.find((l) => l.lane === 'usage') as
      | Extract<StreamLaneEvent, { lane: 'usage' }>
      | undefined
    expect(usage?.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 15 },
    })

    const finish = lanes.find((l) => l.lane === 'finish')
    expect(finish).toEqual({ lane: 'finish', finishReason: 'stop' })
  })
})

describe('splitGeminiStream — finishReason mapping', () => {
  it('maps MAX_TOKENS → length, SAFETY → content_filter, RECITATION → content_filter', async () => {
    for (const [raw, mapped] of [
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content_filter'],
      ['RECITATION', 'content_filter'],
      ['OTHER', 'error'],
    ] as const) {
      const chunks: GeminiStreamChunk[] = [
        {
          type: 'chunk',
          chunk: {
            candidates: [{ content: { role: 'model', parts: [] }, finishReason: raw }],
          },
        },
      ]
      const lanes = await collect(splitGeminiStream(asAsync(chunks)))
      const f = lanes.find((l) => l.lane === 'finish') as
        | Extract<StreamLaneEvent, { lane: 'finish' }>
        | undefined
      expect(f?.finishReason).toBe(mapped)
    }
  })
})

describe('splitGeminiStream — buffered result', () => {
  it('works on probe 3 buffered JSON', async () => {
    const buffered = JSON.parse(readFileSync(PROBE3, 'utf8')) as GenerateContentResponseWire
    const chunks: GeminiStreamChunk[] = [
      { type: 'buffered_result', result: buffered, generationId: 'gen-probe-3' },
    ]
    const lanes = await collect(splitGeminiStream(asAsync(chunks)))
    // At minimum should emit text + usage + finish.
    expect(lanes.some((l) => l.lane === 'text')).toBe(true)
    expect(lanes.some((l) => l.lane === 'finish')).toBe(true)
  })
})

describe('splitGeminiStream — error payload', () => {
  it('emits an error lane event when the response body carries an `error`', async () => {
    const chunks: GeminiStreamChunk[] = [
      {
        type: 'chunk',
        chunk: {
          error: {
            code: 400,
            message: 'Function call … is missing a thought_signature.',
            status: 'INVALID_ARGUMENT',
          },
        },
      },
    ]
    const lanes = await collect(splitGeminiStream(asAsync(chunks)))
    expect(lanes.some((l) => l.lane === 'error')).toBe(true)
  })
})

describe('splitGeminiStream — functionCall', () => {
  it('emits a tool-call lane with stringified args', async () => {
    const chunks: GeminiStreamChunk[] = [
      {
        type: 'chunk',
        chunk: {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'search', args: { query: 'consecutive integers' } },
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      },
    ]
    const lanes = await collect(splitGeminiStream(asAsync(chunks)))
    const toolCalls = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'tool-call' }> => l.lane === 'tool-call',
    )
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.name).toBe('search')
    expect(toolCalls[0]?.argumentsDelta).toBe('{"query":"consecutive integers"}')
  })
})

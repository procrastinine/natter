// Phase 11: `splitGeminiStream` unit tests. Fixture-driven using probe 8
// (streaming) and probe 3 (buffered), plus synthetic multi-part streams to
// exercise the `thought:true` + `thoughtSignature` multi-part contract
// confirmed by live probes:
//
//   - Gemini 3 with `includeThoughts:true` + `thinkingLevel:high` emits a
//     `{text, thought:true}` summary part AND a `{text, thoughtSignature}`
//     final part in the same response.
//   - At low thinking the summary part may be skipped; only the signature part arrives.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GeminiStreamChunk, GenerateContentResponseWire } from '../../src/api/gemini-types'
import { splitGeminiStream as splitGeminiStreamWithContract } from '../../src/api/stream-transforms'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import { GOOGLE_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import { geminiBufferedResult, geminiStreamSse } from '../helpers/protocol-fixtures'
import { geminiReasoningContract } from '../helpers/reasoning-contracts'
import { collectReasoningObservations, foldStreamLaneEvents } from '../helpers/reasoning-events'

function splitGeminiStream(source: Parameters<typeof splitGeminiStreamWithContract>[0]) {
  return splitGeminiStreamWithContract(
    source,
    geminiReasoningContract(),
    GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  )
}

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

describe('splitGeminiStream — representative native stream', () => {
  it('emits meta, text, one source-stable thought-signature carrier, and finish', async () => {
    const lanes = await collect(splitGeminiStream(asAsync(sseToChunks(geminiStreamSse))))

    const firstMeta = lanes.find((l) => l.lane === 'meta')
    expect(firstMeta?.model).toBe('gemini-3.1-flash-lite-preview')
    expect(firstMeta?.generationId).toBeDefined()

    const texts = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'text' }> => l.lane === 'text',
    )
    expect(texts.length).toBeGreaterThan(0)

    const encrypted = collectReasoningObservations(lanes).filter(
      (operation) =>
        operation.kind === 'carrier' && operation.carrierKind === 'gemini-thought-signature',
    )
    expect(encrypted.length).toBe(1)
    expect(encrypted[0]?.update).toBe('set')
    expect(encrypted[0]?.value.length).toBeGreaterThan(100)
    expect(encrypted[0]?.source).toMatchObject({
      dialect: 'gemini-native',
      candidateIndex: 0,
    })
    expect(typeof encrypted[0]?.source.frameIndex).toBe('number')
    expect(typeof encrypted[0]?.source.partIndex).toBe('number')

    expect(lanes.some((l) => l.lane === 'usage')).toBe(true)
    const finish = lanes.find((l) => l.lane === 'finish')
    expect(finish?.finishReason).toBe('stop')
  })
})

describe('splitGeminiStream — preserves atomic thought:true provider parts', () => {
  it('retains every thought part with exact candidate/frame/part coordinates', async () => {
    const frames: GenerateContentResponseWire[] = [
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Thought A', thought: true }] } }],
      },
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'Thought B', thought: true }] } }],
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
    const summaries = collectReasoningObservations(lanes).filter(
      (operation) => operation.kind === 'visible' && operation.visibleKind === 'summary',
    )
    expect(summaries.map((operation) => operation.value)).toEqual([
      'Thought A',
      'Thought B',
      'Thought C',
    ])
    expect(summaries.map((operation) => operation.source)).toEqual([
      {
        dialect: 'gemini-native',
        bridge: 'google-direct',
        candidateIndex: 0,
        frameIndex: 0,
        partIndex: 0,
      },
      {
        dialect: 'gemini-native',
        bridge: 'google-direct',
        candidateIndex: 0,
        frameIndex: 1,
        partIndex: 0,
      },
      {
        dialect: 'gemini-native',
        bridge: 'google-direct',
        candidateIndex: 0,
        frameIndex: 2,
        partIndex: 0,
      },
    ])
    expect(
      new Set(summaries.map((operation) => JSON.stringify(operation.memberAliases))).size,
    ).toBe(3)
    expect(
      foldStreamLaneEvents(lanes).final.reasoningEnvelope?.visible.map((part) => part.text),
    ).toEqual(['Thought A', 'Thought B', 'Thought C'])
  })
  it('preserves two identical thinking sections', async () => {
    const chunks: GeminiStreamChunk[] = [
      {
        type: 'chunk',
        chunk: { candidates: [{ content: { parts: [{ text: 'ha', thought: true }] } }] },
      },
      {
        type: 'chunk',
        chunk: { candidates: [{ content: { parts: [{ text: 'ha', thought: true }] } }] },
      },
    ]
    const lanes = await collect(splitGeminiStream(asAsync(chunks)))
    expect(foldStreamLaneEvents(lanes).final.reasoningEnvelope?.visible).toEqual([
      expect.objectContaining({ kind: 'summary', text: 'ha' }),
      expect.objectContaining({ kind: 'summary', text: 'ha' }),
    ])
  })

  it('keeps same-position summaries and signatures isolated across candidates', async () => {
    const lanes = await collect(
      splitGeminiStream(
        asAsync([
          {
            type: 'chunk',
            chunk: {
              candidates: [
                {
                  index: 3,
                  content: {
                    parts: [
                      { text: 'candidate three', thought: true, thoughtSignature: 'sig-three' },
                    ],
                  },
                },
                {
                  index: 7,
                  content: {
                    parts: [
                      { text: 'candidate seven', thought: true, thoughtSignature: 'sig-seven' },
                    ],
                  },
                },
              ],
            },
          },
        ]),
      ),
    )
    const envelope = foldStreamLaneEvents(lanes).final.reasoningEnvelope
    expect(envelope?.visible.map((part) => [part.source.candidateIndex, part.text])).toEqual([
      [3, 'candidate three'],
      [7, 'candidate seven'],
    ])
    expect(
      envelope?.carriers.map((carrier) => [
        carrier.source.candidateIndex,
        carrier.kind === 'anthropic-signature' ? carrier.signature : carrier.data,
      ]),
    ).toEqual([
      [3, 'sig-three'],
      [7, 'sig-seven'],
    ])
    expect(new Set(envelope?.visible.map((part) => part.id)).size).toBe(2)
    expect(new Set(envelope?.carriers.map((carrier) => carrier.id)).size).toBe(2)
  })
})

describe('splitGeminiStream — both summary + signature in one stream', () => {
  it('preserves visible summary parts and the opaque thought-signature independently', async () => {
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
    const operations = collectReasoningObservations(lanes)
    const summaries = operations.filter(
      (operation) => operation.kind === 'visible' && operation.visibleKind === 'summary',
    )
    expect(summaries).toHaveLength(2)
    expect(summaries.map((operation) => operation.value)).toEqual([
      '**Thinking step 1**',
      '**Thinking step 2**',
    ])
    expect(summaries.every((operation) => operation.source.dialect === 'gemini-native')).toBe(true)

    const texts = lanes.filter(
      (l): l is Extract<StreamLaneEvent, { lane: 'text' }> => l.lane === 'text',
    )
    expect(texts).toHaveLength(1)
    expect(texts[0]?.text).toBe('The answer is 10. ')

    const encryptedEvents = operations.filter(
      (operation) =>
        operation.kind === 'carrier' && operation.carrierKind === 'gemini-thought-signature',
    )
    expect(encryptedEvents).toHaveLength(1)
    expect(encryptedEvents[0]?.value).toBe('SIG_FINAL_BLOB')
    expect(encryptedEvents[0]?.update).toBe('set')

    const envelope = foldStreamLaneEvents(lanes).final.reasoningEnvelope
    expect(envelope?.visible.map((part) => part.text)).toEqual([
      '**Thinking step 1**',
      '**Thinking step 2**',
    ])
    expect(envelope?.carriers).toEqual([
      expect.objectContaining({
        kind: 'gemini-thought-signature',
        data: 'SIG_FINAL_BLOB',
      }),
    ])

    // usage maps thoughtsTokenCount → completion_tokens_details.reasoning_tokens
    const usage = lanes.find((l) => l.lane === 'usage')
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

describe('splitGeminiStream — one owner for Gemini thoughtSignature', () => {
  it('keeps the signature in reasoning and removes it from code-execution provider output', async () => {
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
                    executableCode: { language: 'PYTHON', code: 'print(42)' },
                    thoughtSignature: 'CODE_SIGNATURE',
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

    expect(collectReasoningObservations(lanes)).toEqual([
      expect.objectContaining({
        kind: 'carrier',
        update: 'set',
        value: 'CODE_SIGNATURE',
        carrierKind: 'gemini-thought-signature',
        format: 'google-gemini-v1',
      }),
    ])
    expect(foldStreamLaneEvents(lanes).final.providerOutputItems).toEqual([
      expect.objectContaining({
        dialect: 'google-gemini',
        type: 'google:code_execution',
        item: {
          executableCode: { language: 'PYTHON', code: 'print(42)' },
        },
      }),
    ])
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
      const f = lanes.find((l) => l.lane === 'finish')
      expect(f?.finishReason).toBe(mapped)
    }
  })
})

describe('splitGeminiStream — buffered result', () => {
  it('works on a representative buffered JSON response', async () => {
    const buffered = geminiBufferedResult
    const chunks: GeminiStreamChunk[] = [
      { type: 'buffered_result', result: buffered, generationId: 'gen-probe-3' },
    ]
    const lanes = await collect(splitGeminiStream(asAsync(chunks)))
    // At minimum should emit text + usage + finish.
    expect(lanes.some((l) => l.lane === 'text')).toBe(true)
    expect(lanes.some((l) => l.lane === 'finish')).toBe(true)
  })

  it('projects the same native response identically from streaming and buffered transports', async () => {
    const result: GenerateContentResponseWire = {
      candidates: [
        {
          index: 0,
          content: {
            parts: [
              { text: 'same summary', thought: true },
              { text: '', thoughtSignature: 'same-signature' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    }
    const streamed = await collect(splitGeminiStream(asAsync([{ type: 'chunk', chunk: result }])))
    const buffered = await collect(
      splitGeminiStream(asAsync([{ type: 'buffered_result', result }])),
    )
    expect(foldStreamLaneEvents(streamed).final.reasoningEnvelope).toEqual(
      foldStreamLaneEvents(buffered).final.reasoningEnvelope,
    )
  })
})

if (existsSync(PROBE8)) {
  describe('splitGeminiStream — full local stream capture', () => {
    it('normalizes the complete capture without losing its signature', async () => {
      const lanes = await collect(
        splitGeminiStream(asAsync(sseToChunks(readFileSync(PROBE8, 'utf8')))),
      )
      expect(lanes.some((lane) => lane.lane === 'text')).toBe(true)
      expect(
        collectReasoningObservations(lanes).some(
          (operation) =>
            operation.kind === 'carrier' &&
            operation.carrierKind === 'gemini-thought-signature' &&
            operation.value.length > 0,
        ),
      ).toBe(true)
      expect(lanes.some((lane) => lane.lane === 'finish')).toBe(true)
    })
  })
}

if (existsSync(PROBE3)) {
  describe('splitGeminiStream — full local buffered capture', () => {
    it('normalizes the complete captured response', async () => {
      const buffered = JSON.parse(readFileSync(PROBE3, 'utf8')) as GenerateContentResponseWire
      const lanes = await collect(
        splitGeminiStream(
          asAsync([{ type: 'buffered_result', result: buffered, generationId: 'local-capture' }]),
        ),
      )
      expect(lanes.some((lane) => lane.lane === 'text')).toBe(true)
      expect(lanes.some((lane) => lane.lane === 'finish')).toBe(true)
    })
  })
}

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
    expect(toolCalls).toEqual([
      {
        lane: 'tool-call',
        index: 0,
        id: 'google-gemini:function-call:0',
        type: 'function',
        name: 'search',
        argumentsSnapshot: '{"query":"consecutive integers"}',
      },
    ])
  })
})

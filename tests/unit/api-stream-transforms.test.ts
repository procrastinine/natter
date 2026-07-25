import { describe, expect, it } from 'vitest'
import { splitChatStream as splitChatStreamWithContract } from '../../src/api/stream-transforms'
import type { ChatStreamChunk } from '../../src/api/types'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import type { ReasoningObservation } from '../../src/core/reasoning-observation'
import { chatReasoningContract } from '../helpers/reasoning-contracts'
import { collectReasoningObservations, foldStreamLaneEvents } from '../helpers/reasoning-events'

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

function visibleReasoningIngress(events: readonly StreamLaneEvent[]) {
  return visibleReasoning(events)
}

function projectedReasoningText(events: readonly StreamLaneEvent[]): string {
  return (
    foldStreamLaneEvents(events)
      .final.reasoningEnvelope?.visible.map((part) => part.text)
      .join('') ?? ''
  )
}

describe('splitChatStream', () => {
  it('tags content deltas as text lane events in order', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: { id: 'g1', choices: [{ delta: { content: 'he' } }] },
      },
      {
        type: 'delta',
        chunk: { id: 'g1', choices: [{ delta: { content: 'llo' } }] },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events).toMatchObject([
      { lane: 'meta', generationId: 'g1' },
      { lane: 'text', text: 'he' },
      { lane: 'meta', generationId: 'g1' },
      { lane: 'text', text: 'llo' },
    ])
  })

  it('passes provider and model meta on the first carrying chunk', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g1',
          model: 'x',
          provider: 'y',
          choices: [{ delta: { content: 'hi' } }],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events[0]).toEqual({
      lane: 'meta',
      generationId: 'g1',
      model: 'x',
      provider: 'y',
    })
  })

  it('forwards keepalive comments on their own lane', async () => {
    const source = fromChunks([
      { type: 'keepalive', comment: 'OPENROUTER PROCESSING' },
      { type: 'delta', chunk: { choices: [{ delta: { content: 'x' } }] } },
    ])
    const events = await collect(splitChatStream(source))
    expect(events[0]).toEqual({ lane: 'keepalive', comment: 'OPENROUTER PROCESSING' })
  })

  it('emits chat [DONE] terminal evidence after pending content is flushed', async () => {
    const source = fromChunks([
      { type: 'delta', chunk: { choices: [{ delta: { content: 'answer' } }] } },
      { type: 'transport_terminal', evidence: 'done-sentinel' },
    ])

    expect(await collect(splitChatStream(source))).toEqual([
      { lane: 'text', text: 'answer' },
      { lane: 'terminal', evidence: 'done-sentinel' },
    ])
  })

  it('emits usage and finish on the final chunk', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g1',
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events).toMatchObject([
      { lane: 'meta', generationId: 'g1' },
      { lane: 'finish', finishReason: 'stop' },
      { lane: 'usage', usage: { prompt_tokens: 5, completion_tokens: 3 } },
    ])
  })

  it('reduces tool-call deltas by index with concatenating arguments', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_0',
                    function: { name: 'get_weather', arguments: '{"lat":' },
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
                tool_calls: [{ index: 0, function: { arguments: '42}' } }],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events.filter((e) => e.lane === 'tool-call')).toEqual([
      {
        lane: 'tool-call',
        index: 0,
        id: 'call_0',
        type: 'function',
        name: 'get_weather',
        argumentsDelta: '{"lat":',
      },
      { lane: 'tool-call', index: 0, type: 'function', argumentsDelta: '42}' },
    ])
  })

  it('emits OpenRouter chat image deltas as persistable content items', async () => {
    const imageUrl = 'data:image/png;base64,abc123'
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g1',
          choices: [
            {
              delta: {
                content: '',
                images: [{ type: 'image_url', image_url: { url: imageUrl } }],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events.find((e) => e.lane === 'content-item')).toMatchObject({
      lane: 'content-item',
      chunkId: 'g1',
      item: { type: 'output_image', url: imageUrl },
    })
  })

  it('emits OpenRouter chat audio deltas onto the audio-output lane', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g1',
          choices: [
            {
              delta: {
                audio: { data: 'abc', transcript: 'Hi' },
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events.find((e) => e.lane === 'audio-output')).toMatchObject({
      lane: 'audio-output',
      chunkId: 'g1',
      dataDelta: 'abc',
      transcriptDelta: 'Hi',
    })
  })

  it('emits OpenRouter video URLs as output video content items', async () => {
    const videoUrl = 'https://openrouter.ai/api/v1/videos/job/content?index=0'
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          id: 'g1',
          choices: [
            {
              delta: {
                videos: [{ url: videoUrl, prompt: 'black screen' }],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events.find((e) => e.lane === 'content-item')).toMatchObject({
      lane: 'content-item',
      chunkId: 'g1',
      item: { type: 'output_video', url: videoUrl, prompt: 'black screen' },
    })
  })

  it('drops mirrored reasoning text when reasoning_details already carry the same delta', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning: 'thinking…',
                reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'thinking…' }],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    const ingress = visibleReasoningIngress(events)
    expect(ingress).toHaveLength(1)
    expect(ingress[0]).toMatchObject({
      kind: 'visible',
      update: 'append',
      value: 'thinking…',
      visibleKind: 'text',
    })
    expect(ingress[0]?.source).toMatchObject({
      dialect: 'openrouter-chat',
      choiceIndex: 0,
      detailIndex: 0,
    })
  })

  it('keeps scalar reasoning when only a tool-prefixed detail mirrors it', async () => {
    const details = [{ id: 'tool_call-1', type: 'reasoning.text', index: 0, text: 'thinking…' }]
    const events = await collect(
      splitChatStream(
        fromChunks([
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning: 'thinking…',
                    reasoning_details: details,
                  },
                },
              ],
            },
          },
        ]),
      ),
    )

    const visible = visibleReasoning(events)
    expect(visible).toHaveLength(1)
    expect(visible[0]).toMatchObject({
      update: 'append',
      value: 'thinking…',
      visibleKind: 'text',
    })
    expect(visible[0]?.source).toMatchObject({ dialect: 'openrouter-chat', choiceIndex: 0 })
    expect(projectedReasoningText(events)).toBe('thinking…')
  })

  it('drops a legacy Claude reasoning delta covered by a cumulative structured snapshot', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning: '2 ',
                reasoning_details: [
                  {
                    type: 'reasoning.text',
                    index: 0,
                    format: 'anthropic-claude-v1',
                    text: '1 2 ',
                    signature: 'sig',
                  },
                ],
              },
            },
          ],
        },
      },
    ])

    const events = await collect(splitChatStream(source))
    expect(visibleReasoningIngress(events)).toEqual([
      expect.objectContaining({
        kind: 'visible',
        update: 'append-overlap',
        value: '1 2 ',
        visibleKind: 'text',
        format: 'anthropic-claude-v1',
      }),
    ])
    expect(
      collectReasoningObservations(events).filter((operation) => operation.kind === 'carrier'),
    ).toEqual([
      expect.objectContaining({
        update: 'set',
        value: 'sig',
        carrierKind: 'anthropic-signature',
      }),
    ])
  })

  it('stores mixed Claude delta and cumulative reasoning paths exactly once across chunks', async () => {
    const pieces = ['1 ', '2 ', '3 ', '4 ']
    let cumulative = ''
    const chunks: ChatStreamChunk[] = pieces.map((reasoning) => {
      cumulative += reasoning
      return {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning,
                reasoning_details: [
                  {
                    type: 'reasoning.text',
                    index: 0,
                    format: 'anthropic-claude-v1',
                    text: JSON.parse(JSON.stringify(cumulative)) as string,
                  },
                ],
              },
            },
          ],
        },
      }
    })
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(visibleReasoningIngress(events).map((operation) => operation.update)).toEqual([
      'append',
      'append-overlap',
      'append-overlap',
      'append-overlap',
    ])
    expect(projectedReasoningText(events)).toBe('1 2 3 4 ')
  })

  it('concatenates details-only Claude reasoning deltas instead of replacing them', async () => {
    const chunks: ChatStreamChunk[] = ['1 ', '2 ', '3 ', '4 '].map((text) => ({
      type: 'delta',
      chunk: {
        choices: [
          {
            delta: {
              reasoning_details: [
                { type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text },
              ],
            },
          },
        ],
      },
    }))
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(visibleReasoningIngress(events).map((operation) => operation.update)).toEqual([
      'append',
      'append',
      'append',
      'append',
    ])
    expect(visibleReasoning(events).map((operation) => operation.value)).toEqual([
      '1 ',
      '2 ',
      '3 ',
      '4 ',
    ])
    expect(projectedReasoningText(events)).toBe('1 2 3 4 ')
  })

  it('keeps distinct same-kind detail members separate across detail-only chunks', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning_details: [
                  {
                    type: 'reasoning.text',
                    id: 'detail-a',
                    index: 0,
                    format: 'anthropic-claude-v1',
                    text: 'A',
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
                    id: 'detail-b',
                    index: 0,
                    format: 'anthropic-claude-v1',
                    text: 'B',
                  },
                ],
              },
            },
          ],
        },
      },
    ]
    const events = await collect(splitChatStream(fromChunks(chunks)))

    expect(visibleReasoning(events)).toHaveLength(2)
    expect(projectedReasoningText(events)).toBe('AB')
  })

  it('keeps a non-mirroring scalar and structured member as distinct observations', async () => {
    const events = await collect(
      splitChatStream(
        fromChunks([
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning: 'scalar',
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        id: 'structured-detail',
                        index: 0,
                        format: 'anthropic-claude-v1',
                        text: 'detail',
                      },
                    ],
                  },
                },
              ],
            },
          },
        ]),
      ),
    )

    expect(visibleReasoning(events).map((operation) => operation.value)).toEqual([
      'scalar',
      'detail',
    ])
    expect(projectedReasoningText(events)).toBe('scalardetail')
  })

  it('appends an unmatched scalar delta exactly after structured reasoning', async () => {
    const events = await collect(
      splitChatStream(
        fromChunks([
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
                        format: 'anthropic-claude-v1',
                        text: 'hel',
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: 'delta',
            chunk: { choices: [{ delta: { reasoning: 'lo' } }] },
          },
        ]),
      ),
    )
    expect(visibleReasoning(events).map((operation) => operation.value)).toEqual(['hel', 'lo'])
    expect(projectedReasoningText(events)).toBe('hello')
  })

  it('does not trim a valid scalar continuation after an earlier exact mirror', async () => {
    const events = await collect(
      splitChatStream(
        fromChunks([
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning: 'hel',
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        index: 0,
                        format: 'anthropic-claude-v1',
                        text: 'hel',
                      },
                    ],
                  },
                },
              ],
            },
          },
          {
            type: 'delta',
            chunk: { choices: [{ delta: { reasoning: 'lo' } }] },
          },
        ]),
      ),
    )
    expect(projectedReasoningText(events)).toBe('hello')
  })

  it('preserves a long overlap-looking scalar delta after an exact mirror', async () => {
    const events = await collect(
      splitChatStream(
        fromChunks([
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    reasoning: 'abcd',
                    reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'abcd' }],
                  },
                },
              ],
            },
          },
          {
            type: 'delta',
            chunk: { choices: [{ delta: { reasoning: 'abcdX' } }] },
          },
        ]),
      ),
    )
    expect(projectedReasoningText(events)).toBe('abcdabcdX')
  })

  it('keeps prefix-growing details-only Claude chunks as deltas', async () => {
    const pieces = ['a', 'ab', 'abc']
    const chunks: ChatStreamChunk[] = pieces.map((text) => ({
      type: 'delta',
      chunk: {
        choices: [
          {
            delta: {
              reasoning_details: [
                { type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text },
              ],
            },
          },
        ],
      },
    }))
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(visibleReasoningIngress(events).map((operation) => operation.update)).toEqual([
      'append',
      'append',
      'append',
    ])
    expect(projectedReasoningText(events)).toBe(pieces.join(''))
  })

  it('preserves prefix-growing scalar and structured mirrors as exact deltas', async () => {
    const pieces = ['Let', 'Let me', 'Let me think']
    const chunks: ChatStreamChunk[] = pieces.map((text) => ({
      type: 'delta',
      chunk: {
        choices: [
          {
            delta: {
              reasoning: text,
              reasoning_details: [{ type: 'reasoning.text', index: 0, text }],
            },
          },
        ],
      },
    }))
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(visibleReasoningIngress(events).map((operation) => operation.update)).toEqual([
      'append',
      'append',
      'append',
    ])
    expect(projectedReasoningText(events)).toBe(pieces.join(''))
  })

  it('does not discard earlier Claude reasoning for a suffix-mirrored structured delta', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning: 'EARLY ',
                reasoning_details: [
                  {
                    type: 'reasoning.text',
                    index: 0,
                    format: 'anthropic-claude-v1',
                    text: 'EARLY ',
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
                reasoning: 'tail',
                reasoning_details: [
                  {
                    type: 'reasoning.text',
                    index: 0,
                    format: 'anthropic-claude-v1',
                    text: 'LATER tail',
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
                reasoning: ' END',
                reasoning_details: [
                  {
                    type: 'reasoning.text',
                    index: 0,
                    format: 'anthropic-claude-v1',
                    text: ' END',
                  },
                ],
              },
            },
          ],
        },
      },
    ]
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(projectedReasoningText(events)).toBe('EARLY LATER tail END')
  })

  it('does not duplicate an equal cumulative mirror after a scalar-only delta', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning: 'a',
                reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'a' }],
              },
            },
          ],
        },
      },
      { type: 'delta', chunk: { choices: [{ delta: { reasoning: 'b' } }] } },
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning: 'b',
                reasoning_details: [
                  {
                    type: 'reasoning.text',
                    index: 0,
                    format: 'anthropic-claude-v1',
                    text: 'ab',
                  },
                ],
              },
            },
          ],
        },
      },
    ]
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(projectedReasoningText(events)).toBe('ab')
  })

  it('deduplicates equal scalar and structured Claude deltas while keeping repeated chunks', async () => {
    const chunks: ChatStreamChunk[] = ['ha', 'ha', ' ho'].map((text) => ({
      type: 'delta',
      chunk: {
        choices: [
          {
            delta: {
              reasoning: text,
              reasoning_details: [
                { type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text },
              ],
            },
          },
        ],
      },
    }))
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(visibleReasoningIngress(events).map((operation) => operation.update)).toEqual([
      'append',
      'append',
      'append',
    ])
    expect(projectedReasoningText(events)).toBe('haha ho')
  })

  it('preserves a repeated scalar reasoning delta after structured reasoning', async () => {
    const chunks: ChatStreamChunk[] = [
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
                    format: 'anthropic-claude-v1',
                    text: 'ha',
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: 'delta',
        chunk: { choices: [{ delta: { reasoning: 'ha' } }] },
      },
    ]
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(projectedReasoningText(events)).toBe('haha')
  })

  it('appends repeated and overlap-looking structured reasoning deltas exactly', async () => {
    const pieces = ['ha', 'ha', 'prefix-tail', 'tail-next']
    const chunks: ChatStreamChunk[] = pieces.map((text) => ({
      type: 'delta',
      chunk: {
        choices: [
          {
            delta: {
              reasoning_details: [{ type: 'reasoning.text', index: 0, format: 'unknown', text }],
            },
          },
        ],
      },
    }))
    const events = await collect(splitChatStream(fromChunks(chunks)))
    expect(projectedReasoningText(events)).toBe(pieces.join(''))
  })

  it('does not discard generic prefix or suffix matches as mirrors', async () => {
    const source = fromChunks([
      {
        type: 'delta' as const,
        chunk: {
          choices: [
            {
              delta: {
                reasoning: 'prefix-suffix',
                reasoning_details: [
                  { type: 'reasoning.text', index: 0, format: 'unknown', text: 'prefix' },
                ],
              },
            },
          ],
        },
      },
    ])

    const events = await collect(splitChatStream(source))
    expect(visibleReasoning(events).map((operation) => operation.value)).toEqual([
      'prefix-suffix',
      'prefix',
    ])
    expect(projectedReasoningText(events)).toBe('prefix-suffixprefix')
  })

  it('drops mirrored reasoning text when OpenAI-family reasoning.summary already carries the same delta', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning: 'thinking…',
                reasoning_details: [
                  {
                    type: 'reasoning.summary',
                    index: 0,
                    format: 'azure-openai-responses-v1',
                    summary: 'thinking…',
                  },
                ],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(visibleReasoningIngress(events)).toEqual([
      expect.objectContaining({
        kind: 'visible',
        update: 'append',
        value: 'thinking…',
        visibleKind: 'summary',
        format: 'azure-openai-responses-v1',
      }),
    ])
  })

  it('preserves distinct reasoning text when details do not mirror it', async () => {
    const source = fromChunks([
      {
        type: 'delta',
        chunk: {
          choices: [
            {
              delta: {
                reasoning: 'thinking…',
                reasoning_details: [{ type: 'reasoning.summary', summary: 'brief' }],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(
      visibleReasoning(events).map((operation) => ({
        kind: operation.visibleKind,
        value: operation.value,
      })),
    ).toEqual([
      { kind: 'text', value: 'thinking…' },
      { kind: 'summary', value: 'brief' },
    ])
  })

  it('normalizes a synthetic buffered_result into meta + text + finish + usage lanes', async () => {
    const source = fromChunks([
      {
        type: 'buffered_result',
        result: {
          id: 'g1',
          model: 'm',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: 'hello',
                reasoning: 'thinking',
                reasoning_details: [{ type: 'reasoning.text', text: 'thinking', index: 0 }],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events.map((event) => event.lane)).toEqual([
      'meta',
      'reasoning-observation',
      'text',
      'finish',
      'usage',
    ])
    expect(events[0]).toMatchObject({ lane: 'meta', generationId: 'g1', model: 'm' })
    expect(visibleReasoning(events)).toEqual([
      expect.objectContaining({ update: 'set', value: 'thinking' }),
    ])
    expect(events[2]).toMatchObject({ lane: 'text', text: 'hello' })
    expect(events[3]).toMatchObject({ lane: 'finish', finishReason: 'stop' })
    expect(events[4]).toMatchObject({
      lane: 'usage',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  })

  it('retains streamed Claude text when the terminal message carries only its signature', async () => {
    const events = await collect(
      splitChatStream(
        fromChunks([
          {
            type: 'delta',
            chunk: {
              choices: [{ index: 0, delta: { reasoning: 'visible thought' } }],
            },
          },
          {
            type: 'buffered_result',
            result: {
              id: 'claude-terminal-signature',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    content: 'answer',
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        index: 0,
                        format: 'anthropic-claude-v1',
                        signature: 'terminal-signature',
                      },
                    ],
                  },
                },
              ],
            },
          },
        ]),
      ),
    )

    const envelope = foldStreamLaneEvents(events).final.reasoningEnvelope
    expect(envelope?.visible).toHaveLength(1)
    expect(envelope?.visible[0]).toMatchObject({ kind: 'text', text: 'visible thought' })
    expect(envelope?.carriers).toHaveLength(1)
    if (!envelope) throw new Error('BufferedReasoningEnvelopeMissing')
    expect(envelope.carriers[0]).toMatchObject({
      kind: 'anthropic-signature',
      signature: 'terminal-signature',
      bindsVisiblePartId: envelope.visible[0]?.id,
    })
  })

  it('normalizes buffered chat tool calls into authoritative tool-call lanes', async () => {
    const events = await collect(
      splitChatStream(
        fromChunks([
          {
            type: 'buffered_result',
            result: {
              id: 'buffered-tools',
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: '',
                    tool_calls: [
                      {
                        id: 'call-buffered',
                        type: 'function',
                        function: { name: 'lookup', arguments: '{"query":"natter"}' },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ]),
      ),
    )

    expect(events.filter((event) => event.lane === 'tool-call')).toEqual([
      {
        lane: 'tool-call',
        index: 0,
        id: 'call-buffered',
        type: 'function',
        name: 'lookup',
        argumentsSnapshot: '{"query":"natter"}',
        chunkId: 'buffered-tools',
      },
    ])
  })

  it('emits OpenRouter buffered message images as persistable content items', async () => {
    const imageUrl = 'data:image/png;base64,abc123'
    const source = fromChunks([
      {
        type: 'buffered_result',
        result: {
          id: 'g1',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: '',
                images: [{ type: 'image_url', image_url: { url: imageUrl } }],
              },
            },
          ],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    expect(events.find((e) => e.lane === 'content-item')).toMatchObject({
      lane: 'content-item',
      chunkId: 'g1',
      item: { type: 'output_image', url: imageUrl },
    })
  })

  it('raises mid-stream error frames onto the error lane as ApiError', async () => {
    const source = fromChunks([
      { type: 'delta', chunk: { choices: [{ delta: { content: 'part' } }] } },
      {
        type: 'delta',
        chunk: {
          error: { code: 429, message: 'slow down' },
          choices: [{ finish_reason: 'error' }],
        },
      },
    ])
    const events = await collect(splitChatStream(source))
    const error = events.find((e) => e.lane === 'error')
    if (error?.lane !== 'error') throw new Error('expected error lane event')
    expect(error.error.kind).toBe('rate_limited')
    expect(error.error.midStream).toBe(true)
    expect(error.error.retryable).toBe(true)
  })
})

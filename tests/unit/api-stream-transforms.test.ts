import { describe, expect, it } from 'vitest'
import { type StreamLaneEvent, splitChatStream } from '../../src/api/stream-transforms'
import type { ChatStreamChunk } from '../../src/api/types'
import {
  applyStreamAccumulatorEvent,
  createStreamAccumulator,
  projectStreamAccumulatorFinal,
} from '../../src/core/stream-accumulator'

async function* fromChunks(chunks: ChatStreamChunk[]): AsyncGenerator<ChatStreamChunk> {
  for (const c of chunks) yield c
}

async function collect(iter: AsyncIterable<StreamLaneEvent>): Promise<StreamLaneEvent[]> {
  const out: StreamLaneEvent[] = []
  for await (const e of iter) out.push(e)
  return out
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
    expect(events.find((e) => e.lane === 'reasoning')).toEqual({
      lane: 'reasoning',
      detailsMode: 'delta',
      details: [{ type: 'reasoning.text', index: 0, text: 'thinking…' }],
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

    expect(events.find((event) => event.lane === 'reasoning')).toEqual({
      lane: 'reasoning',
      textDelta: 'thinking…',
      detailsMode: 'delta',
      details,
    })
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of events.entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      expect.objectContaining({ type: 'reasoning.text', text: 'thinking…' }),
    ])
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
    expect(events.find((event) => event.lane === 'reasoning')).toEqual({
      lane: 'reasoning',
      detailsMode: 'cumulative',
      details: [
        {
          type: 'reasoning.text',
          index: 0,
          format: 'anthropic-claude-v1',
          text: '1 2 ',
          signature: 'sig',
        },
      ],
    })
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
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of (await collect(splitChatStream(fromChunks(chunks)))).entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'anthropic-claude-v1',
        text: '1 2 3 4 ',
      },
    ])
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
    expect(events.filter((event) => event.lane === 'reasoning')).toEqual(
      chunks.map((_, index) => ({
        lane: 'reasoning',
        detailsMode: 'delta',
        details: [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            text: `${index + 1} `,
          },
        ],
      })),
    )
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of events.entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: '1 2 3 4 ',
    })
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
    expect(events.filter((event) => event.lane === 'reasoning')).toEqual([
      {
        lane: 'reasoning',
        detailsMode: 'delta',
        details: [
          {
            type: 'reasoning.text',
            index: 0,
            format: 'anthropic-claude-v1',
            text: 'hel',
          },
        ],
      },
      { lane: 'reasoning', textDelta: 'lo' },
    ])

    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of events.entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: 'hello',
    })
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
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of events.entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: 'hello',
    })
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
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of events.entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: 'abcdabcdX',
    })
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
    expect(
      events.filter((event) => event.lane === 'reasoning').map((event) => event.detailsMode),
    ).toEqual(['delta', 'delta', 'delta'])

    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of events.entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: pieces.join(''),
    })
  })

  it('collapses prefix-growing scalar and structured mirrors into one cumulative path', async () => {
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
    expect(
      events.filter((event) => event.lane === 'reasoning').map((event) => event.detailsMode),
    ).toEqual(['delta', 'cumulative', 'cumulative'])

    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of events.entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: 'Let me think',
    })
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
                reasoning: 'ab',
                reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'ab' }],
              },
            },
          ],
        },
      },
    ]
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of (await collect(splitChatStream(fromChunks(chunks)))).entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: 'ab',
    })
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
    expect(
      events.filter((event) => event.lane === 'reasoning').map((event) => event.detailsMode),
    ).toEqual(['delta', 'delta', 'delta'])
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of events.entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }
    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails?.[0]).toMatchObject({
      text: 'haha ho',
    })
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
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of (await collect(splitChatStream(fromChunks(chunks)))).entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'anthropic-claude-v1',
        text: 'haha',
        id: 'text#default',
      },
    ])
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
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    for (const [index, event] of (await collect(splitChatStream(fromChunks(chunks)))).entries()) {
      applyStreamAccumulatorEvent(accumulator, event, index + 1)
    }

    expect(projectStreamAccumulatorFinal(accumulator).reasoningDetails).toEqual([
      {
        type: 'reasoning.text',
        index: 0,
        format: 'unknown',
        text: pieces.join(''),
      },
    ])
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

    expect(
      (await collect(splitChatStream(source))).find((event) => event.lane === 'reasoning'),
    ).toMatchObject({
      lane: 'reasoning',
      textDelta: 'prefix-suffix',
      details: [{ type: 'reasoning.text', text: 'prefix' }],
    })
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
    expect(events.find((e) => e.lane === 'reasoning')).toEqual({
      lane: 'reasoning',
      detailsMode: 'delta',
      details: [
        {
          type: 'reasoning.summary',
          index: 0,
          format: 'azure-openai-responses-v1',
          summary: 'thinking…',
        },
      ],
    })
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
    expect(events.find((e) => e.lane === 'reasoning')).toEqual({
      lane: 'reasoning',
      textDelta: 'thinking…',
      detailsMode: 'delta',
      details: [{ type: 'reasoning.summary', summary: 'brief' }],
    })
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
    expect(events).toMatchObject([
      { lane: 'meta', generationId: 'g1', model: 'm' },
      { lane: 'buffered' },
      { lane: 'reasoning', details: [{ type: 'reasoning.text', text: 'thinking', index: 0 }] },
      { lane: 'text', text: 'hello' },
      { lane: 'finish', finishReason: 'stop' },
      { lane: 'usage', usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ])
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

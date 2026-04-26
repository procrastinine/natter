import { describe, expect, it } from 'vitest'
import { type StreamLaneEvent, splitChatStream } from '../../src/api/stream-transforms'
import type { ChatStreamChunk } from '../../src/api/types'

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
        name: 'get_weather',
        argumentsDelta: '{"lat":',
      },
      { lane: 'tool-call', index: 0, argumentsDelta: '42}' },
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
      details: [{ type: 'reasoning.text', index: 0, text: 'thinking…' }],
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

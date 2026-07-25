import { describe, expect, it } from 'vitest'
import type { AnthropicStreamChunk } from '../../src/api/anthropic-types'
import type { GeminiStreamChunk } from '../../src/api/gemini-types'
import {
  splitAnthropicStream as splitAnthropicStreamWithContract,
  splitChatStream as splitChatStreamWithContract,
  splitGeminiStream as splitGeminiStreamWithContract,
  splitResponsesStream as splitResponsesStreamWithContract,
} from '../../src/api/stream-transforms'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../../src/api/types'
import type { StreamLaneEvent } from '../../src/core/generation-stream-live-events'
import {
  ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
  GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
} from '../../src/core/provider-tool-context'
import {
  createStreamAccumulator,
  foldStreamAccumulatorEvent,
  projectStreamAccumulatorFinal,
  replayStreamAccumulator,
} from '../../src/core/stream-accumulator'
import {
  anthropicReasoningContract,
  chatReasoningContract,
  geminiReasoningContract,
  responsesReasoningContract,
} from '../helpers/reasoning-contracts'

function splitResponsesStream(source: Parameters<typeof splitResponsesStreamWithContract>[0]) {
  return splitResponsesStreamWithContract(
    source,
    responsesReasoningContract(),
    OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
  )
}

function splitGeminiStream(source: Parameters<typeof splitGeminiStreamWithContract>[0]) {
  return splitGeminiStreamWithContract(
    source,
    geminiReasoningContract(),
    GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  )
}

function splitAnthropicStream(source: Parameters<typeof splitAnthropicStreamWithContract>[0]) {
  return splitAnthropicStreamWithContract(
    source,
    anthropicReasoningContract(),
    ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
  )
}

function splitChatStream(source: Parameters<typeof splitChatStreamWithContract>[0]) {
  return splitChatStreamWithContract(source, { reasoning: chatReasoningContract() })
}

async function* asAsync<T>(values: Iterable<T>): AsyncIterable<T> {
  for (const value of values) yield value
}

async function accumulated(source: AsyncIterable<StreamLaneEvent>) {
  const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
  let now = 1
  for await (const event of source) foldStreamAccumulatorEvent(accumulator, event, now++)
  return projectStreamAccumulatorFinal(accumulator).content
}

describe('structured citation pipeline', () => {
  it('attaches streamed Responses annotations to their exact output text item without replaying text', async () => {
    const chunks: ResponsesStreamChunk[] = [
      {
        type: 'event',
        event: {
          type: 'response.output_text.delta',
          output_index: 0,
          content_index: 0,
          item_id: 'message-1',
          delta: 'Alpha source',
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'message-1',
                role: 'assistant',
                content: [
                  {
                    type: 'output_text',
                    text: 'Alpha source',
                    annotations: [
                      {
                        type: 'url_citation',
                        start_index: 6,
                        end_index: 12,
                        url: 'https://example.com/source',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        type: 'event',
        event: {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'message-1',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Alpha source',
                annotations: [
                  {
                    type: 'url_citation',
                    start_index: 6,
                    end_index: 12,
                    url: 'https://example.com/source',
                  },
                ],
              },
            ],
          },
        },
      },
    ]

    expect(await accumulated(splitResponsesStream(asAsync(chunks)))).toEqual([
      {
        type: 'output_text',
        text: 'Alpha source',
        annotations: [
          expect.objectContaining({
            type: 'url_citation',
            startIndex: 6,
            endIndex: 12,
            url: 'https://example.com/source',
          }),
        ],
      },
    ])
  })

  it('attaches buffered Responses annotations to their exact output text item', async () => {
    const content = await accumulated(
      splitResponsesStream(
        asAsync<ResponsesStreamChunk>([
          {
            type: 'buffered_result',
            result: {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text: 'Alpha source',
                      annotations: [
                        {
                          type: 'url_citation',
                          start_index: 6,
                          end_index: 12,
                          url: 'https://responses.example/source',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ]),
      ),
    )

    expect(content).toEqual([
      {
        type: 'output_text',
        text: 'Alpha source',
        annotations: [
          expect.objectContaining({
            source: 'openai-responses',
            url: 'https://responses.example/source',
          }),
        ],
      },
    ])
  })

  it('replays persisted annotation events without duplicating or losing their owner range', () => {
    const annotation = {
      type: 'url_citation' as const,
      source: 'openai-responses' as const,
      startIndex: 0,
      endIndex: 5,
      url: 'https://example.com/replay',
      providerPayload: { type: 'url_citation', url: 'https://example.com/replay' },
    }
    const replayed = replayStreamAccumulator({
      initialContent: [],
      now: 0,
      entries: [
        { event: { lane: 'text', text: 'Alpha', outputIndex: 0, contentIndex: 0 }, createdAt: 1 },
        {
          event: {
            lane: 'text-annotations',
            annotations: [annotation],
            ownerTextLength: 5,
            outputIndex: 0,
            contentIndex: 0,
          },
          createdAt: 2,
        },
      ],
    })
    expect(replayed.final.content).toEqual([
      { type: 'output_text', text: 'Alpha', annotations: [annotation] },
    ])
  })

  it('normalizes buffered Chat Completions annotations', async () => {
    const chunks: ChatStreamChunk[] = [
      {
        type: 'buffered_result',
        result: {
          choices: [
            {
              message: {
                content: 'Alpha',
                annotations: [
                  {
                    type: 'url_citation',
                    start_index: 0,
                    end_index: 5,
                    url: 'https://chat.example/source',
                  },
                ],
              },
            },
          ],
        },
      },
    ]
    const content = await accumulated(splitChatStream(asAsync(chunks)))
    expect(content[0]).toMatchObject({
      type: 'output_text',
      text: 'Alpha',
      annotations: [
        expect.objectContaining({ source: 'openai-chat', url: 'https://chat.example/source' }),
      ],
    })
  })

  it('normalizes streaming Chat Completions annotations without replaying text', async () => {
    const content = await accumulated(
      splitChatStream(
        asAsync<ChatStreamChunk>([
          {
            type: 'delta',
            chunk: { choices: [{ delta: { content: 'Alpha source' } }] },
          },
          {
            type: 'delta',
            chunk: {
              choices: [
                {
                  delta: {
                    annotations: [
                      {
                        type: 'url_citation',
                        start_index: 6,
                        end_index: 12,
                        url: 'https://chat.example/streamed',
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

    expect(content).toEqual([
      {
        type: 'output_text',
        text: 'Alpha source',
        annotations: [
          expect.objectContaining({
            source: 'openai-chat',
            url: 'https://chat.example/streamed',
          }),
        ],
      },
    ])
  })

  it('normalizes Anthropic citation deltas against their text block', async () => {
    const chunks: AnthropicStreamChunk[] = [
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      },
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Alpha source' },
        },
      },
      {
        type: 'anthropic_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: {
            type: 'citations_delta',
            citation: {
              type: 'web_search_result_location',
              cited_text: 'source',
              url: 'https://anthropic.example/source',
              encrypted_index: 'opaque',
            },
          },
        },
      },
      { type: 'anthropic_event', event: { type: 'content_block_stop', index: 0 } },
    ]
    const content = await accumulated(splitAnthropicStream(asAsync(chunks)))
    expect(content[0]).toMatchObject({
      type: 'output_text',
      text: 'Alpha source',
      annotations: [
        expect.objectContaining({
          source: 'anthropic-messages',
          startIndex: 6,
          endIndex: 12,
          url: 'https://anthropic.example/source',
        }),
      ],
    })
  })

  it('normalizes buffered Anthropic citations against their text block', async () => {
    const content = await accumulated(
      splitAnthropicStream(
        asAsync<AnthropicStreamChunk>([
          {
            type: 'buffered_result',
            result: {
              content: [
                {
                  type: 'text',
                  text: 'Alpha source',
                  citations: [
                    {
                      type: 'web_search_result_location',
                      cited_text: 'source',
                      url: 'https://anthropic.example/buffered',
                    },
                  ],
                },
              ],
              stop_reason: 'end_turn',
            },
          },
        ]),
      ),
    )

    expect(content).toEqual([
      {
        type: 'output_text',
        text: 'Alpha source',
        annotations: [
          expect.objectContaining({
            source: 'anthropic-messages',
            url: 'https://anthropic.example/buffered',
          }),
        ],
      },
    ])
  })

  it('normalizes Gemini grounding metadata from the candidate without discarding raw evidence', async () => {
    const chunks: GeminiStreamChunk[] = [
      {
        type: 'chunk',
        chunk: {
          candidates: [
            {
              index: 0,
              content: { role: 'model', parts: [{ text: 'Alpha source' }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: 'https://gemini.example/source', title: 'Gemini source' } },
                ],
                groundingSupports: [
                  { segment: { startIndex: 6, endIndex: 12 }, groundingChunkIndices: [0] },
                ],
              },
            },
          ],
        },
      },
    ]
    const content = await accumulated(splitGeminiStream(asAsync(chunks)))
    expect(content[0]).toMatchObject({
      type: 'output_text',
      text: 'Alpha source',
      annotations: [
        expect.objectContaining({
          source: 'gemini-native',
          startIndex: 6,
          endIndex: 12,
          url: 'https://gemini.example/source',
        }),
      ],
    })
  })

  it('normalizes buffered Gemini grounding metadata through the same candidate path', async () => {
    const content = await accumulated(
      splitGeminiStream(
        asAsync<GeminiStreamChunk>([
          {
            type: 'buffered_result',
            result: {
              candidates: [
                {
                  index: 0,
                  content: { role: 'model', parts: [{ text: 'Alpha source' }] },
                  groundingMetadata: {
                    groundingChunks: [
                      { web: { uri: 'https://gemini.example/buffered', title: 'Source' } },
                    ],
                    groundingSupports: [
                      { segment: { startIndex: 6, endIndex: 12 }, groundingChunkIndices: [0] },
                    ],
                  },
                },
              ],
            },
          },
        ]),
      ),
    )

    expect(content).toEqual([
      {
        type: 'output_text',
        text: 'Alpha source',
        annotations: [
          expect.objectContaining({
            source: 'gemini-native',
            url: 'https://gemini.example/buffered',
          }),
        ],
      },
    ])
  })
})

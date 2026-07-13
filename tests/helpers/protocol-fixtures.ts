import type { GenerateContentResponseWire } from '../../src/api/gemini-types'
import type { ResponsesEventWire, ResponsesResultWire } from '../../src/api/types'

const responsesStreamEvents: ResponsesEventWire[] = [
  {
    type: 'response.created',
    response: {
      id: 'resp_fixture',
      model: 'gpt-5.4-nano',
      status: 'in_progress',
    },
  },
  {
    type: 'response.in_progress',
    response: {
      id: 'resp_fixture',
      model: 'gpt-5.4-nano',
      status: 'in_progress',
    },
  },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: {
      id: 'rs_fixture',
      type: 'reasoning',
      status: 'in_progress',
      encrypted_content: 'gAAA-initial-fixture',
      summary: [],
    },
  },
  {
    type: 'response.reasoning_summary_text.delta',
    output_index: 0,
    item_id: 'rs_fixture',
    summary_index: 0,
    delta: 'Find two consecutive ',
  },
  {
    type: 'response.reasoning_summary_text.delta',
    output_index: 0,
    item_id: 'rs_fixture',
    summary_index: 0,
    delta: 'even integers.',
  },
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      id: 'rs_fixture',
      type: 'reasoning',
      status: 'completed',
      encrypted_content: 'gAAA-final-fixture',
      summary: [{ type: 'summary_text', text: 'Find two consecutive even integers.' }],
    },
  },
  {
    type: 'response.output_item.added',
    output_index: 1,
    item: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      status: 'in_progress',
      content: [],
    },
  },
  {
    type: 'response.content_part.added',
    output_index: 1,
    content_index: 0,
    item_id: 'msg_fixture',
    part: { type: 'output_text', text: '' },
  },
  {
    type: 'response.output_text.delta',
    output_index: 1,
    content_index: 0,
    item_id: 'msg_fixture',
    delta: '44 and ',
  },
  {
    type: 'response.output_text.delta',
    output_index: 1,
    content_index: 0,
    item_id: 'msg_fixture',
    delta: '46.',
  },
  {
    type: 'response.content_part.done',
    output_index: 1,
    content_index: 0,
    item_id: 'msg_fixture',
    part: { type: 'output_text', text: '44 and 46.' },
  },
  {
    type: 'response.output_item.done',
    output_index: 1,
    item: {
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: '44 and 46.' }],
    },
  },
  {
    type: 'response.completed',
    response: {
      id: 'resp_fixture',
      model: 'gpt-5.4-nano',
      status: 'completed',
      usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
    },
  },
]

export const responsesStreamSse = responsesStreamEvents
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`)
  .join('\n')

export const responsesBufferedResult: ResponsesResultWire = {
  id: 'resp_buffered_fixture',
  model: 'gpt-5.4-nano',
  status: 'completed',
  output: [
    {
      id: 'rs_buffered_fixture',
      type: 'reasoning',
      status: 'completed',
      encrypted_content: 'gAAA-buffered-fixture',
      summary: [{ type: 'summary_text', text: 'Find consecutive even integers.' }],
    },
    {
      id: 'msg_buffered_fixture',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: '44 and 46 are consecutive even integers.' }],
    },
  ],
  usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
}

const geminiStreamFrames: GenerateContentResponseWire[] = [
  {
    responseId: 'gemini_fixture',
    modelVersion: 'gemini-3.1-flash-lite-preview',
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'Check the consecutive values.', thought: true }],
        },
      },
    ],
  },
  {
    responseId: 'gemini_fixture',
    modelVersion: 'gemini-3.1-flash-lite-preview',
    candidates: [{ content: { role: 'model', parts: [{ text: '44 and 46.' }] } }],
  },
  {
    responseId: 'gemini_fixture',
    modelVersion: 'gemini-3.1-flash-lite-preview',
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: '', thoughtSignature: `fixture-${'s'.repeat(128)}` }],
        },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: {
      promptTokenCount: 5,
      candidatesTokenCount: 7,
      thoughtsTokenCount: 3,
      totalTokenCount: 12,
    },
  },
]

export const geminiStreamSse = geminiStreamFrames
  .map((frame) => `data: ${JSON.stringify(frame)}\n`)
  .join('\n')

export const geminiBufferedResult: GenerateContentResponseWire = {
  responseId: 'gemini_buffered_fixture',
  modelVersion: 'gemini-3.1-flash-lite-preview',
  candidates: [
    {
      content: {
        role: 'model',
        parts: [
          { text: 'Check the values.', thought: true },
          { text: '44 and 46.', thoughtSignature: `fixture-${'b'.repeat(128)}` },
        ],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 5,
    candidatesTokenCount: 7,
    thoughtsTokenCount: 3,
    totalTokenCount: 12,
  },
}

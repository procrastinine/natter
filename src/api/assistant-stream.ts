import type { AssistantRequestPlan } from '../core/send-planning'
import type { ConnectionProfile } from '../core/types'
import { type AnthropicContext, anthropicOnce, anthropicStream } from './anthropic-messages'
import type { AnthropicMessagesResultWire, AnthropicStreamChunk } from './anthropic-types'
import { chatCompletions, chatCompletionsOnce } from './chat-completions'
import { type GeminiContext, geminiOnce, geminiStream } from './gemini-native'
import type { GeminiStreamChunk, GenerateContentResponseWire } from './gemini-types'
import { responses, responsesOnce } from './responses'
import { textCompletions, textCompletionsOnce } from './text-completions'
import type {
  ChatCompletionResultWire,
  ChatStreamChunk,
  ResponsesResultWire,
  ResponsesStreamChunk,
} from './types'
import { videoGeneration } from './video-generation'

export type AssistantStreamChunk =
  | ChatStreamChunk
  | ResponsesStreamChunk
  | GeminiStreamChunk
  | AnthropicStreamChunk

type AssistantOnceResult =
  | ChatCompletionResultWire
  | ResponsesResultWire
  | GenerateContentResponseWire
  | AnthropicMessagesResultWire

interface AssistantDispatchInput {
  connection: ConnectionProfile
  apiKey: string
  requestPlan: AssistantRequestPlan
  signal?: AbortSignal
}

export function openAssistantRequestStream(
  input: AssistantDispatchInput,
): AsyncIterable<AssistantStreamChunk> {
  const { connection, apiKey, requestPlan, signal } = input
  const ctx = { profile: connection, apiKey }
  if (requestPlan.route?.transport === 'openai-responses' && requestPlan.wire.stream !== true) {
    return bufferedAssistantRequest(input)
  }
  if (requestPlan.useTextProtocol) {
    return textCompletions(ctx, requestPlan.wire as Parameters<typeof textCompletions>[1], {
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.route?.transport === 'openai-responses') {
    return responses(ctx, requestPlan.wire as Parameters<typeof responses>[1], {
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.route?.transport === 'gemini-native') {
    const geminiCtx: GeminiContext = ctx
    return geminiStream(
      geminiCtx,
      requestPlan.wire as Parameters<typeof geminiStream>[1],
      requestPlan.geminiModelId ?? requestPlan.requestedModel,
      { ...(signal ? { signal } : {}) },
    )
  }
  if (requestPlan.route?.transport === 'anthropic') {
    const anthropicCtx: AnthropicContext = ctx
    return anthropicStream(
      anthropicCtx,
      requestPlan.wire as Parameters<typeof anthropicStream>[1],
      { ...(signal ? { signal } : {}) },
    )
  }
  if (requestPlan.route?.transport === 'openrouter-video') {
    return videoGeneration(ctx, requestPlan.wire as Parameters<typeof videoGeneration>[1], {
      ...(signal ? { signal } : {}),
    })
  }
  return chatCompletions(ctx, requestPlan.wire as Parameters<typeof chatCompletions>[1], {
    ...(signal ? { signal } : {}),
  })
}

async function* bufferedAssistantRequest(
  input: AssistantDispatchInput,
): AsyncGenerator<AssistantStreamChunk> {
  const result = await runAssistantRequestOnce(input)
  yield { type: 'buffered_result', result } as AssistantStreamChunk
}

export async function runAssistantRequestOnce(
  input: AssistantDispatchInput,
): Promise<AssistantOnceResult> {
  const { connection, apiKey, requestPlan, signal } = input
  const ctx = { profile: connection, apiKey }
  if (requestPlan.useTextProtocol) {
    return textCompletionsOnce(ctx, requestPlan.wire as Parameters<typeof textCompletionsOnce>[1], {
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.route?.transport === 'openai-responses') {
    return responsesOnce(ctx, requestPlan.wire as Parameters<typeof responsesOnce>[1], {
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.route?.transport === 'gemini-native') {
    const geminiCtx: GeminiContext = ctx
    return geminiOnce(
      geminiCtx,
      requestPlan.wire as Parameters<typeof geminiOnce>[1],
      requestPlan.geminiModelId ?? requestPlan.requestedModel,
      { ...(signal ? { signal } : {}) },
    )
  }
  if (requestPlan.route?.transport === 'anthropic') {
    const anthropicCtx: AnthropicContext = ctx
    return anthropicOnce(anthropicCtx, requestPlan.wire as Parameters<typeof anthropicOnce>[1], {
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.route?.transport === 'openrouter-video') {
    throw new Error('runAssistantRequestOnce: video generation is an asynchronous streaming route')
  }
  return chatCompletionsOnce(ctx, requestPlan.wire as Parameters<typeof chatCompletionsOnce>[1], {
    ...(signal ? { signal } : {}),
  })
}

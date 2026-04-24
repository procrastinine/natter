import type { AssistantRequestPlan } from '../core/send-planning'
import type { ConnectionProfile } from '../core/types'
import { chatCompletions, chatCompletionsOnce } from './chat-completions'
import { geminiOnce, geminiStream, type GeminiContext } from './gemini-native'
import type { GenerateContentResponseWire } from './gemini-types'
import { responses, responsesOnce } from './responses'
import { textCompletions, textCompletionsOnce } from './text-completions'
import type {
  ChatCompletionResultWire,
  ChatStreamChunk,
  ResponsesResultWire,
  ResponsesStreamChunk,
} from './types'
import type { GeminiStreamChunk } from './gemini-types'

export type AssistantStreamChunk =
  | ChatStreamChunk
  | ResponsesStreamChunk
  | GeminiStreamChunk

export type AssistantOnceResult =
  | ChatCompletionResultWire
  | ResponsesResultWire
  | GenerateContentResponseWire

export interface AssistantDispatchInput {
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
  return chatCompletions(ctx, requestPlan.wire as Parameters<typeof chatCompletions>[1], {
    ...(signal ? { signal } : {}),
  })
}

export async function runAssistantRequestOnce(
  input: AssistantDispatchInput,
): Promise<AssistantOnceResult> {
  const { connection, apiKey, requestPlan, signal } = input
  const ctx = { profile: connection, apiKey }
  if (requestPlan.useTextProtocol) {
    return textCompletionsOnce(
      ctx,
      requestPlan.wire as Parameters<typeof textCompletionsOnce>[1],
      { ...(signal ? { signal } : {}) },
    )
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
  return chatCompletionsOnce(
    ctx,
    requestPlan.wire as Parameters<typeof chatCompletionsOnce>[1],
    { ...(signal ? { signal } : {}) },
  )
}

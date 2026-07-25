import type { AssistantAttemptContract } from '../core/api-choice'
import type { ConnectionProfile } from '../core/types'
import { errorFromUnknown } from '../lib/error'
import { type AnthropicContext, anthropicOnce, anthropicStream } from './anthropic-messages'
import type { AnthropicMessagesResultWire, AnthropicStreamChunk } from './anthropic-types'
import { chatCompletions, chatCompletionsOnce } from './chat-completions'
import type { ApiKeyCandidate } from './client'
import { deferAdapterRequest } from './deferred-request'
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

export type AssistantDispatchPlan = AssistantAttemptContract & {
  requestedModel: string
  geminiModelId?: string
  wire: Record<string, unknown>
}

export function createAssistantDispatchPlan(
  input: AssistantAttemptContract & {
    requestedModel: string
    geminiModelId?: string
    wire: Record<string, unknown>
  },
): AssistantDispatchPlan {
  return {
    kind: input.kind,
    transport: input.transport,
    reason: input.reason,
    reasoning: input.reasoning,
    providerOutput: input.providerOutput,
    requestedModel: input.requestedModel,
    ...(input.geminiModelId ? { geminiModelId: input.geminiModelId } : {}),
    wire: input.wire,
  } as AssistantDispatchPlan
}

interface AssistantDispatchInput {
  connection: ConnectionProfile
  apiKey: string
  apiKeyCandidates?: readonly ApiKeyCandidate[]
  onKeyCandidateSelected?: (
    candidate: ApiKeyCandidate,
    candidateIndex: number,
    apiKey: string,
  ) => void | Promise<void>
  requestPlan: AssistantDispatchPlan
  diagnosticId?: string
  signal?: AbortSignal
}

export function openAssistantRequestStream(
  input: AssistantDispatchInput,
): AsyncIterable<AssistantStreamChunk> {
  const {
    connection,
    apiKey,
    apiKeyCandidates,
    onKeyCandidateSelected,
    requestPlan,
    diagnosticId,
    signal,
  } = input
  const ctx = {
    profile: connection,
    apiKey,
    ...(apiKeyCandidates ? { apiKeyCandidates } : {}),
    ...(onKeyCandidateSelected ? { onKeyCandidateSelected } : {}),
  }
  if (requestPlan.transport === 'openai-responses' && requestPlan.wire.stream !== true) {
    return deferAdapterRequest(requestPlan.wire, (wire) =>
      bufferedAssistantRequest(
        responsesOnce(ctx, wire as Parameters<typeof responsesOnce>[1], {
          ...(diagnosticId ? { diagnosticId } : {}),
          ...(signal ? { signal } : {}),
        }),
      ),
    )
  }
  if (requestPlan.transport === 'openai-text') {
    return textCompletions(ctx, requestPlan.wire as Parameters<typeof textCompletions>[1], {
      ...(diagnosticId ? { diagnosticId } : {}),
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.transport === 'openai-responses') {
    return responses(ctx, requestPlan.wire as Parameters<typeof responses>[1], {
      ...(diagnosticId ? { diagnosticId } : {}),
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.transport === 'gemini-native') {
    const geminiCtx: GeminiContext = ctx
    return geminiStream(
      geminiCtx,
      requestPlan.wire as Parameters<typeof geminiStream>[1],
      requestPlan.geminiModelId ?? requestPlan.requestedModel,
      {
        ...(diagnosticId ? { diagnosticId } : {}),
        ...(signal ? { signal } : {}),
      },
    )
  }
  if (requestPlan.transport === 'anthropic') {
    const anthropicCtx: AnthropicContext = ctx
    return anthropicStream(
      anthropicCtx,
      requestPlan.wire as Parameters<typeof anthropicStream>[1],
      {
        ...(diagnosticId ? { diagnosticId } : {}),
        ...(signal ? { signal } : {}),
      },
    )
  }
  if (requestPlan.transport === 'openrouter-video') {
    return videoGeneration(ctx, requestPlan.wire as Parameters<typeof videoGeneration>[1], {
      ...(diagnosticId ? { diagnosticId } : {}),
      ...(signal ? { signal } : {}),
    })
  }
  return chatCompletions(ctx, requestPlan.wire as Parameters<typeof chatCompletions>[1], {
    ...(diagnosticId ? { diagnosticId } : {}),
    ...(signal ? { signal } : {}),
  })
}

async function* bufferedAssistantRequest(
  requested: Promise<AssistantOnceResult>,
): AsyncGenerator<AssistantStreamChunk, void, unknown> {
  const result = await requested
  yield { type: 'buffered_result', result }
}

export function runAssistantRequestOnce(
  input: AssistantDispatchInput,
): Promise<AssistantOnceResult> {
  try {
    return dispatchAssistantRequestOnce(input)
  } catch (error) {
    return Promise.reject(errorFromUnknown(error))
  }
}

function dispatchAssistantRequestOnce(input: AssistantDispatchInput): Promise<AssistantOnceResult> {
  const {
    connection,
    apiKey,
    apiKeyCandidates,
    onKeyCandidateSelected,
    requestPlan,
    diagnosticId,
    signal,
  } = input
  const ctx = {
    profile: connection,
    apiKey,
    ...(apiKeyCandidates ? { apiKeyCandidates } : {}),
    ...(onKeyCandidateSelected ? { onKeyCandidateSelected } : {}),
  }
  if (requestPlan.transport === 'openai-text') {
    return textCompletionsOnce(ctx, requestPlan.wire as Parameters<typeof textCompletionsOnce>[1], {
      ...(diagnosticId ? { diagnosticId } : {}),
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.transport === 'openai-responses') {
    return responsesOnce(ctx, requestPlan.wire as Parameters<typeof responsesOnce>[1], {
      ...(diagnosticId ? { diagnosticId } : {}),
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.transport === 'gemini-native') {
    const geminiCtx: GeminiContext = ctx
    return geminiOnce(
      geminiCtx,
      requestPlan.wire as Parameters<typeof geminiOnce>[1],
      requestPlan.geminiModelId ?? requestPlan.requestedModel,
      {
        ...(diagnosticId ? { diagnosticId } : {}),
        ...(signal ? { signal } : {}),
      },
    )
  }
  if (requestPlan.transport === 'anthropic') {
    const anthropicCtx: AnthropicContext = ctx
    return anthropicOnce(anthropicCtx, requestPlan.wire as Parameters<typeof anthropicOnce>[1], {
      ...(diagnosticId ? { diagnosticId } : {}),
      ...(signal ? { signal } : {}),
    })
  }
  if (requestPlan.transport === 'openrouter-video') {
    throw new Error('runAssistantRequestOnce: video generation is an asynchronous streaming route')
  }
  return chatCompletionsOnce(ctx, requestPlan.wire as Parameters<typeof chatCompletionsOnce>[1], {
    ...(diagnosticId ? { diagnosticId } : {}),
    ...(signal ? { signal } : {}),
  })
}

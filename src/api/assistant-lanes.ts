import type { AssistantAttemptContract } from '../core/api-choice'
import type { StreamLaneEvent } from '../core/generation-stream-live-events'
import type { AnthropicStreamChunk } from './anthropic-types'
import type { AssistantStreamChunk } from './assistant-stream'
import type { GeminiStreamChunk } from './gemini-types'
import {
  splitAnthropicStream,
  splitChatStream,
  splitGeminiStream,
  splitResponsesStream,
} from './stream-transforms'
import type { ChatStreamChunk, ResponsesStreamChunk } from './types'

type LaneTransport = 'openai-chat' | 'openai-responses' | 'gemini-native' | 'anthropic'

export async function* splitAssistantStream(
  source: AsyncIterable<AssistantStreamChunk>,
  contract: AssistantAttemptContract | null,
): AsyncGenerator<StreamLaneEvent> {
  const iterator = source[Symbol.asyncIterator]()
  let sourceClosed = false
  let hasPrimaryError = false
  try {
    let first: IteratorResult<AssistantStreamChunk>
    try {
      first = await iterator.next()
    } catch (error) {
      sourceClosed = true
      throw error
    }
    if (first.done) {
      sourceClosed = true
      return
    }
    const replay = {
      async *[Symbol.asyncIterator]() {
        yield first.value
        for (;;) {
          let next: IteratorResult<AssistantStreamChunk>
          try {
            next = await iterator.next()
          } catch (error) {
            sourceClosed = true
            throw error
          }
          if (next.done) {
            sourceClosed = true
            return
          }
          yield next.value
        }
      },
    }

    if (!contract) throw new Error('AssistantStreamContractMissing')
    const observed = observedAssistantStreamTransport(first.value)
    const transport = laneTransportForContract(contract)
    if (observed && transport !== observed) {
      throw new Error(`AssistantStreamTransportMismatch:${transport}:${observed}`)
    }
    let lanes: AsyncIterable<StreamLaneEvent>
    if (contract.transport === 'openai-responses') {
      lanes = splitResponsesStream(
        replay as AsyncIterable<ResponsesStreamChunk>,
        contract.reasoning,
        contract.providerOutput,
      )
    } else if (contract.transport === 'gemini-native') {
      lanes = splitGeminiStream(
        replay as AsyncIterable<GeminiStreamChunk>,
        contract.reasoning,
        contract.providerOutput,
      )
    } else if (contract.transport === 'anthropic') {
      lanes = splitAnthropicStream(
        replay as AsyncIterable<AnthropicStreamChunk>,
        contract.reasoning,
        contract.providerOutput,
      )
    } else {
      lanes = splitChatStream(replay as AsyncIterable<ChatStreamChunk>, {
        reasoning: contract.reasoning,
      })
    }
    yield* preserveUnexpectedVisibleReasoning(lanes, contract)
  } catch (error) {
    hasPrimaryError = true
    throw error
  } finally {
    if (!sourceClosed) {
      await closeSourceIterator(iterator, hasPrimaryError)
    }
  }
}

async function* preserveUnexpectedVisibleReasoning(
  source: AsyncIterable<StreamLaneEvent>,
  contract: AssistantAttemptContract,
): AsyncGenerator<StreamLaneEvent> {
  let mismatchReported = false
  for await (const event of source) {
    if (!mismatchReported && contract.reasoning.inboundVisibility.disclosure === 'absent') {
      const visible = visibleReasoningObservation(event)
      if (visible) {
        mismatchReported = true
        const adapter = integrityAdapterForContract(contract)
        yield {
          lane: 'integrity',
          integrity: {
            category: 'malformed-event-shape',
            adapter,
            eventType: 'unexpected-visible-reasoning',
            count: 1,
            fingerprint: `visibility-contract:${adapter}:${visible.visibleKind}`,
            characterCount: visible.characterCount,
          },
        }
      }
    }
    yield event
  }
}

function visibleReasoningObservation(
  event: StreamLaneEvent,
): { visibleKind: 'text' | 'summary'; characterCount: number } | null {
  const observations =
    event.lane === 'reasoning-observation'
      ? event.batch.observations
      : event.lane === 'result-snapshot' && event.payload.kind === 'replace'
        ? event.payload.reasoning.observations
        : []
  let visibleKind: 'text' | 'summary' | undefined
  let characterCount = 0
  for (const observation of observations) {
    if (observation.kind !== 'visible' || observation.value.length === 0) continue
    visibleKind ??= observation.visibleKind
    characterCount += observation.value.length
  }
  return visibleKind ? { visibleKind, characterCount } : null
}

function integrityAdapterForContract(
  contract: AssistantAttemptContract,
): Extract<StreamLaneEvent, { lane: 'integrity' }>['integrity']['adapter'] {
  if (contract.transport === 'openai-responses') return 'responses'
  if (contract.transport === 'gemini-native') return 'gemini-native'
  if (contract.transport === 'anthropic') return 'anthropic-messages'
  if (contract.transport === 'openai-text') return 'text-completions'
  return 'chat-completions'
}

async function closeSourceIterator(
  iterator: AsyncIterator<AssistantStreamChunk>,
  suppressError: boolean,
): Promise<void> {
  try {
    await iterator.return?.(undefined)
  } catch (error) {
    if (!suppressError) throw error
  }
}

function observedAssistantStreamTransport(chunk: AssistantStreamChunk): LaneTransport | null {
  if (chunk.type === 'integrity') {
    if (chunk.integrity.adapter === 'responses') return 'openai-responses'
    if (chunk.integrity.adapter === 'gemini-native') return 'gemini-native'
    if (chunk.integrity.adapter === 'anthropic-messages') return 'anthropic'
    return 'openai-chat'
  }
  if (chunk.type === 'event') return 'openai-responses'
  if (chunk.type === 'chunk') return 'gemini-native'
  if (chunk.type === 'anthropic_event') return 'anthropic'
  if (chunk.type === 'delta') return 'openai-chat'
  if (chunk.type === 'buffered_result') {
    const result = chunk.result as Record<string, unknown>
    if (Array.isArray(result.content) && 'stop_reason' in result) return 'anthropic'
    if (Array.isArray(result.output) || 'status' in result) return 'openai-responses'
    if (Array.isArray(result.candidates)) return 'gemini-native'
    if (Array.isArray(result.choices)) return 'openai-chat'
  }
  return null
}

function laneTransportForContract(contract: AssistantAttemptContract): LaneTransport {
  if (contract.transport === 'openai-responses') return 'openai-responses'
  if (contract.transport === 'gemini-native') return 'gemini-native'
  if (contract.transport === 'anthropic') return 'anthropic'
  return 'openai-chat'
}

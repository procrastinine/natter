import type { ApiRoute } from '../core/api-choice'
import type { AnthropicStreamChunk } from './anthropic-types'
import type { AssistantStreamChunk } from './assistant-stream'
import type { GeminiStreamChunk } from './gemini-types'
import {
  type StreamLaneEvent,
  splitAnthropicStream,
  splitChatStream,
  splitGeminiStream,
  splitResponsesStream,
} from './stream-transforms'
import type { ChatStreamChunk, ResponsesStreamChunk } from './types'

type LaneTransport = 'openai-chat' | 'openai-responses' | 'gemini-native' | 'anthropic'

export async function* splitAssistantStream(
  source: AsyncIterable<AssistantStreamChunk>,
  transportHint?: ApiRoute['transport'],
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

    const transport = detectAssistantStreamTransport(first.value, transportHint)
    if (transport === 'openai-responses') {
      yield* splitResponsesStream(replay as AsyncIterable<ResponsesStreamChunk>)
      return
    }
    if (transport === 'gemini-native') {
      yield* splitGeminiStream(replay as AsyncIterable<GeminiStreamChunk>)
      return
    }
    if (transport === 'anthropic') {
      yield* splitAnthropicStream(replay as AsyncIterable<AnthropicStreamChunk>)
      return
    }
    yield* splitChatStream(replay as AsyncIterable<ChatStreamChunk>)
  } catch (error) {
    hasPrimaryError = true
    throw error
  } finally {
    if (!sourceClosed) {
      await closeSourceIterator(iterator, hasPrimaryError)
    }
  }
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

function detectAssistantStreamTransport(
  chunk: AssistantStreamChunk,
  transportHint: ApiRoute['transport'] | undefined,
): LaneTransport {
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
  if (transportHint === 'openai-responses') return 'openai-responses'
  if (transportHint === 'gemini-native') return 'gemini-native'
  if (transportHint === 'anthropic') return 'anthropic'
  return 'openai-chat'
}

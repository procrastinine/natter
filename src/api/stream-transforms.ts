// Chat-completions lane splitters. See `plan/04-api-client.md §4.7` and
// `plan/05-transforms-and-quirks.md §5.3`.
//
// A single stream produces multiple independent lanes. Rather than force every
// caller to re-parse the tagged union, we expose lane-tagged events that the
// send-pipeline accumulator folds into the message. Events match the lane
// contract sketched in `plan/06-streaming.md §6.1a "StreamDelta"`:
//
//   { lane: 'text'      | 'reasoning' | 'tool-call' | 'usage' | 'keepalive'
//              | 'error' | 'meta'       | 'finish'
//     payload: lane-specific
//   }
//
// Phase 7 text chat uses the text / usage / finish / keepalive / error / meta
// lanes. Reasoning + tool-call lanes are emitted for forward compatibility
// (and exercised by unit tests) but not consumed by `useChat` until later
// phases.

import type {
  ChatCompletionChoiceWire,
  ChatCompletionChunkWire,
  ChatCompletionResultWire,
  ChatCompletionUsageWire,
  ChatStreamChunk,
} from './types'
import { type ApiError, normalizeError } from './errors'

export type StreamLaneEvent =
  | { lane: 'text'; text: string; chunkId?: string }
  | {
      lane: 'reasoning'
      textDelta?: string
      details?: unknown[]
      chunkId?: string
    }
  | {
      lane: 'tool-call'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
      chunkId?: string
    }
  | { lane: 'usage'; usage: ChatCompletionUsageWire; chunkId?: string }
  | { lane: 'finish'; finishReason: string; chunkId?: string }
  | { lane: 'meta'; model?: string; provider?: string; generationId?: string }
  | { lane: 'keepalive'; comment: string }
  | { lane: 'error'; error: ApiError }
  | { lane: 'buffered'; result: ChatCompletionResultWire; generationId?: string }

// Splits a source iterable of `ChatStreamChunk`s into lane-tagged events.
// The output order is preserved per chunk; within a chunk, meta events come
// first (so accumulators see the generationId before their first text chunk),
// then the content lanes, then usage/finish.
export async function* splitChatStream(
  source: AsyncIterable<ChatStreamChunk>,
): AsyncGenerator<StreamLaneEvent> {
  for await (const chunk of source) {
    if (chunk.type === 'keepalive') {
      yield { lane: 'keepalive', comment: chunk.comment }
      continue
    }
    if (chunk.type === 'buffered_result') {
      yield* splitBufferedResult(chunk.result, chunk.generationId)
      continue
    }
    yield* splitDelta(chunk.chunk, chunk.generationId)
  }
}

function* splitDelta(
  chunk: ChatCompletionChunkWire,
  generationId: string | undefined,
): Generator<StreamLaneEvent> {
  // Mid-stream error frame — §4.5: top-level `error` on a 200 response body.
  if (chunk.error) {
    yield {
      lane: 'error',
      error: normalizeError(chunk, {
        midStream: true,
        ...(chunk.error.code !== undefined && typeof chunk.error.code === 'number'
          ? { httpStatus: chunk.error.code }
          : {}),
      }),
    }
    return
  }

  const meta: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
  let metaDirty = false
  const effectiveGenId = generationId ?? (typeof chunk.id === 'string' ? chunk.id : undefined)
  if (effectiveGenId !== undefined) {
    meta.generationId = effectiveGenId
    metaDirty = true
  }
  if (typeof chunk.model === 'string') {
    meta.model = chunk.model
    metaDirty = true
  }
  if (typeof chunk.provider === 'string') {
    meta.provider = chunk.provider
    metaDirty = true
  }
  if (metaDirty) yield meta

  for (const choice of chunk.choices ?? []) {
    yield* splitChoiceDelta(choice, typeof chunk.id === 'string' ? chunk.id : undefined)
  }

  if (chunk.usage) {
    yield {
      lane: 'usage',
      usage: chunk.usage,
      ...(typeof chunk.id === 'string' ? { chunkId: chunk.id } : {}),
    }
  }
}

function* splitChoiceDelta(
  choice: ChatCompletionChoiceWire,
  chunkId: string | undefined,
): Generator<StreamLaneEvent> {
  const delta = choice.delta
  if (delta) {
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield {
        lane: 'text',
        text: delta.content,
        ...(chunkId !== undefined ? { chunkId } : {}),
      }
    }
    const reasoningText =
      typeof delta.reasoning === 'string' && delta.reasoning.length > 0
        ? delta.reasoning
        : undefined
    const reasoningDetails = Array.isArray(delta.reasoning_details)
      ? delta.reasoning_details
      : undefined
    if (reasoningText !== undefined || reasoningDetails !== undefined) {
      const event: StreamLaneEvent & { lane: 'reasoning' } = { lane: 'reasoning' }
      if (reasoningText !== undefined) event.textDelta = reasoningText
      if (reasoningDetails !== undefined) event.details = reasoningDetails
      if (chunkId !== undefined) event.chunkId = chunkId
      yield event
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        const event = toToolCallEvent(raw, chunkId)
        if (event) yield event
      }
    }
  }
  if (
    choice.finish_reason !== undefined &&
    choice.finish_reason !== null &&
    choice.finish_reason !== ''
  ) {
    yield {
      lane: 'finish',
      finishReason: choice.finish_reason,
      ...(chunkId !== undefined ? { chunkId } : {}),
    }
  }
}

function toToolCallEvent(
  raw: unknown,
  chunkId: string | undefined,
): (StreamLaneEvent & { lane: 'tool-call' }) | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as {
    index?: number
    id?: string
    function?: { name?: string; arguments?: string }
  }
  if (typeof value.index !== 'number') return null
  const event: StreamLaneEvent & { lane: 'tool-call' } = {
    lane: 'tool-call',
    index: value.index,
  }
  if (typeof value.id === 'string') event.id = value.id
  if (typeof value.function?.name === 'string') event.name = value.function.name
  if (typeof value.function?.arguments === 'string') {
    event.argumentsDelta = value.function.arguments
  }
  if (chunkId !== undefined) event.chunkId = chunkId
  return event
}

function* splitBufferedResult(
  result: ChatCompletionResultWire,
  generationId: string | undefined,
): Generator<StreamLaneEvent> {
  if (result.error) {
    yield {
      lane: 'error',
      error: normalizeError(result, {
        midStream: true,
        ...(result.error.code !== undefined && typeof result.error.code === 'number'
          ? { httpStatus: result.error.code }
          : {}),
      }),
    }
    return
  }
  const effectiveGenId = generationId ?? (typeof result.id === 'string' ? result.id : undefined)
  const meta: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
  let metaDirty = false
  if (effectiveGenId !== undefined) {
    meta.generationId = effectiveGenId
    metaDirty = true
  }
  if (typeof result.model === 'string') {
    meta.model = result.model
    metaDirty = true
  }
  if (typeof result.provider === 'string') {
    meta.provider = result.provider
    metaDirty = true
  }
  if (metaDirty) yield meta

  yield { lane: 'buffered', result, ...(generationId !== undefined ? { generationId } : {}) }

  // Synthesize one text event so downstream accumulators don't need a
  // separate "buffered" code path for the text lane. Reasoning / tool-calls
  // in the buffered shape are round-tripped via the raw `buffered` event
  // payload so Phase-8+ consumers can parse the full message shape.
  const choice = result.choices?.[0]
  const messageText = typeof choice?.message?.content === 'string' ? choice.message.content : ''
  if (messageText.length > 0) {
    yield {
      lane: 'text',
      text: messageText,
      ...(typeof result.id === 'string' ? { chunkId: result.id } : {}),
    }
  }
  if (choice?.finish_reason) {
    yield {
      lane: 'finish',
      finishReason: choice.finish_reason,
      ...(typeof result.id === 'string' ? { chunkId: result.id } : {}),
    }
  }
  if (result.usage) {
    yield {
      lane: 'usage',
      usage: result.usage,
      ...(typeof result.id === 'string' ? { chunkId: result.id } : {}),
    }
  }
}

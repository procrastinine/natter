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

import { type ApiError, normalizeError } from './errors'
import type {
  GeminiContent,
  GeminiPart,
  GeminiStreamChunk,
  GenerateContentResponseWire,
} from './gemini-types'
import type {
  ChatCompletionChoiceWire,
  ChatCompletionChunkWire,
  ChatCompletionResultWire,
  ChatCompletionUsageWire,
  ChatStreamChunk,
  ResponsesEventWire,
  ResponsesInputItem,
  ResponsesResultWire,
  ResponsesStreamChunk,
  ResponsesUsageWire,
} from './types'
import {
  createInlineReasoningLifter,
  type InlineReasoningLifter,
} from '../core/reasoning-inline'
import type { MessagePhase } from '../core/types'

// Lane-tagged events consumed by the message accumulator. Phase 7 defined the
// chat-completions lanes (text / reasoning / tool-call / usage / finish / meta
// / keepalive / error / buffered). Phase 11 adds:
//   - `output-item-added` / `output-item-done` — one per Responses output item
//     (reasoning | message | function_call | server-tool). The accumulator
//     commits one `Message` row per item.
//   - `server-tool` — typed status events for web_search_call et al.
//   - `phase` — emitted on `output_item.done` when the item carries a `phase`
//     field; accumulator pins it on the corresponding `Message`.
//   - `reasoning` gains `summaryDelta`, `encryptedDelta`, `outputIndex`.
//   - `text` gains `outputIndex` + `contentIndex`.
export type StreamLaneEvent =
  | { lane: 'text'; text: string; chunkId?: string; outputIndex?: number; contentIndex?: number }
  | {
      lane: 'reasoning'
      textDelta?: string
      summaryDelta?: string
      encryptedDelta?: string
      // When `replaceEncrypted` is true the accumulator overwrites the
      // stored encrypted field instead of appending. Emitted on
      // `output_item.done` — the final encrypted_content is authoritative
      // (see `plan/phase11-implementation.md §5`).
      replaceEncrypted?: boolean
      details?: unknown[]
      chunkId?: string
      outputIndex?: number
      // `summaryIndex` identifies which summary PART within a reasoning
      // item a `summaryDelta` belongs to. Responses wire exposes this as
      // `summary_index` on `reasoning_summary_text.delta`; Gemini native
      // assigns a per-response counter to each `thought:true` part. The
      // accumulator keys summary rows by (outputIndex, summaryIndex) so
      // multiple distinct summary parts in one item stay separate.
      summaryIndex?: number
    }
  | {
      lane: 'tool-call'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
      chunkId?: string
      outputIndex?: number
    }
  | {
      lane: 'server-tool'
      itemType:
        | 'web_search_call'
        | 'file_search_call'
        | 'image_generation_call'
        | 'code_interpreter_call'
        | 'computer_call'
        | 'mcp_tool_call'
      status: 'in_progress' | 'searching' | 'completed'
      itemId: string
      outputIndex: number
      partialImageB64?: string
    }
  | {
      lane: 'output-item-added'
      outputIndex: number
      item: ResponsesInputItem
    }
  | {
      lane: 'output-item-done'
      outputIndex: number
      item: ResponsesInputItem
    }
  | {
      lane: 'phase'
      phase: MessagePhase | null
      outputIndex: number
    }
  | {
      lane: 'usage'
      usage: ChatCompletionUsageWire | ResponsesUsageWire
      chunkId?: string
    }
  | { lane: 'finish'; finishReason: string; chunkId?: string }
  | { lane: 'meta'; model?: string; provider?: string; generationId?: string }
  | { lane: 'keepalive'; comment: string }
  | { lane: 'error'; error: ApiError }
  | {
      lane: 'buffered'
      result: ChatCompletionResultWire | ResponsesResultWire
      generationId?: string
    }

export interface SplitChatStreamOptions {
  // Tag set the inline-reasoning lifter should look for. Pass `[]` to
  // disable (useful when callers know the model returns reasoning only
  // via `reasoning_details[]`). When `undefined`, the lifter auto-detects
  // `<think>` / `<thought>` at stream start — the generic case that
  // covers DeepSeek-R1 / Qwen3 / Kimi K2 / GLM / MiniMax / etc.
  inlineReasoningTags?: readonly string[]
  // When `true`, the lifter is always active (doesn't require a leading
  // open tag to arm). Caller opts in when a quirks entry explicitly flags
  // the model as emitting inline tags.
  forceInlineReasoning?: boolean
}

// Splits a source iterable of `ChatStreamChunk`s into lane-tagged events.
// The output order is preserved per chunk; within a chunk, meta events come
// first (so accumulators see the generationId before their first text chunk),
// then the content lanes, then usage/finish.
//
// `delta.content` runs through an inline-reasoning lifter so thinking models
// that embed `<think>…</think>` / `<thought>…</thought>` in the content
// stream (DeepSeek-R1, Qwen3, Gemma-3, Kimi K2 Thinking, GLM-4.x thinking,
// MiniMax, and any other generic thinking model) route their chain-of-thought
// onto the reasoning lane rather than the visible-text lane. The lifter auto-
// detects by watching the first chunk for a leading open tag; this is a
// no-op for non-thinking models.
export async function* splitChatStream(
  source: AsyncIterable<ChatStreamChunk>,
  opts: SplitChatStreamOptions = {},
): AsyncGenerator<StreamLaneEvent> {
  const lifter = createInlineReasoningLifter({
    ...(opts.inlineReasoningTags !== undefined ? { tags: opts.inlineReasoningTags } : {}),
    ...(opts.forceInlineReasoning === true ? { autoDetect: false } : {}),
  })

  for await (const chunk of source) {
    if (chunk.type === 'keepalive') {
      yield { lane: 'keepalive', comment: chunk.comment }
      continue
    }
    if (chunk.type === 'buffered_result') {
      yield* splitBufferedResult(chunk.result, chunk.generationId, lifter)
      continue
    }
    yield* splitDelta(chunk.chunk, chunk.generationId, lifter)
  }

  // End-of-stream: flush any pending content buffered by the lifter.
  for (const flushed of lifter.finish()) {
    if (flushed.kind === 'text') {
      yield { lane: 'text', text: flushed.text }
    } else {
      yield { lane: 'reasoning', textDelta: flushed.text }
    }
  }
}

function* splitDelta(
  chunk: ChatCompletionChunkWire,
  generationId: string | undefined,
  lifter: InlineReasoningLifter,
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
    yield* splitChoiceDelta(choice, typeof chunk.id === 'string' ? chunk.id : undefined, lifter)
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
  lifter: InlineReasoningLifter,
): Generator<StreamLaneEvent> {
  const delta = choice.delta
  if (delta) {
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      for (const ev of lifter.feed(delta.content)) {
        if (ev.kind === 'text') {
          yield {
            lane: 'text',
            text: ev.text,
            ...(chunkId !== undefined ? { chunkId } : {}),
          }
        } else {
          yield {
            lane: 'reasoning',
            textDelta: ev.text,
            ...(chunkId !== undefined ? { chunkId } : {}),
          }
        }
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
      if (
        reasoningText !== undefined &&
        !reasoningDetailsMirrorText(reasoningText, reasoningDetails)
      ) {
        event.textDelta = reasoningText
      }
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
    // Flush any partial tag the lifter is still holding back BEFORE the
    // finish event. This matters when the model truncates mid-tag (e.g.
    // `<thi` without `nk>`) or aborts with an unclosed `<think>` block —
    // without the flush, buffered text would emit after `finish` and be
    // dropped by most accumulators.
    for (const flushed of lifter.finish()) {
      if (flushed.kind === 'text') {
        yield {
          lane: 'text',
          text: flushed.text,
          ...(chunkId !== undefined ? { chunkId } : {}),
        }
      } else {
        yield {
          lane: 'reasoning',
          textDelta: flushed.text,
          ...(chunkId !== undefined ? { chunkId } : {}),
        }
      }
    }
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
  lifter: InlineReasoningLifter,
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
  const reasoningText =
    typeof choice?.message?.reasoning === 'string' && choice.message.reasoning.length > 0
      ? choice.message.reasoning
      : undefined
  const reasoningDetails = Array.isArray(choice?.message?.reasoning_details)
    ? choice.message.reasoning_details
    : undefined
  if (reasoningText !== undefined || reasoningDetails !== undefined) {
    const event: StreamLaneEvent & { lane: 'reasoning' } = { lane: 'reasoning' }
    if (
      reasoningText !== undefined &&
      !reasoningDetailsMirrorText(reasoningText, reasoningDetails)
    ) {
      event.textDelta = reasoningText
    }
    if (reasoningDetails !== undefined) event.details = reasoningDetails
    if (typeof result.id === 'string') event.chunkId = result.id
    yield event
  }
  if (messageText.length > 0) {
    for (const ev of lifter.feed(messageText)) {
      if (ev.kind === 'text') {
        yield {
          lane: 'text',
          text: ev.text,
          ...(typeof result.id === 'string' ? { chunkId: result.id } : {}),
        }
      } else {
        yield {
          lane: 'reasoning',
          textDelta: ev.text,
          ...(typeof result.id === 'string' ? { chunkId: result.id } : {}),
        }
      }
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

function reasoningDetailsMirrorText(reasoningText: string, details: unknown[] | undefined): boolean {
  if (!details || details.length === 0) return false
  let merged = ''
  let sawText = false
  for (const raw of details) {
    if (!raw || typeof raw !== 'object') continue
    const detail = raw as { type?: unknown; text?: unknown }
    if (detail.type !== 'reasoning.text' || typeof detail.text !== 'string') continue
    merged += detail.text
    sawText = true
  }
  return sawText && merged === reasoningText
}

// ---------------------------------------------------------------------------
// Phase 11: Responses-API splitter.
// ---------------------------------------------------------------------------

const SERVER_TOOL_ITEM_TYPES = new Set<string>([
  'web_search_call',
  'file_search_call',
  'image_generation_call',
  'code_interpreter_call',
  'computer_call',
  'mcp_tool_call',
])

export async function* splitResponsesStream(
  source: AsyncIterable<ResponsesStreamChunk>,
): AsyncGenerator<StreamLaneEvent> {
  let metaEmittedModel: string | undefined
  let metaEmittedGenerationId: string | undefined

  for await (const chunk of source) {
    if (chunk.type === 'keepalive') {
      yield { lane: 'keepalive', comment: chunk.comment }
      continue
    }
    if (chunk.type === 'buffered_result') {
      yield* splitBufferedResponsesResult(chunk.result, chunk.generationId)
      continue
    }
    const ev = chunk.event
    const maybeMeta = metaFromEvent(
      ev,
      chunk.generationId,
      metaEmittedModel,
      metaEmittedGenerationId,
    )
    if (maybeMeta) {
      metaEmittedModel = maybeMeta.model ?? metaEmittedModel
      metaEmittedGenerationId = maybeMeta.generationId ?? metaEmittedGenerationId
      yield maybeMeta
    }
    yield* splitResponsesEvent(ev)
  }
}

function metaFromEvent(
  ev: ResponsesEventWire,
  generationId: string | undefined,
  previouslyEmittedModel: string | undefined,
  previouslyEmittedGenerationId: string | undefined,
): (StreamLaneEvent & { lane: 'meta' }) | null {
  // Only `response.created` and `response.in_progress` carry a full
  // `response` payload we can pull metadata from. We emit at most one
  // additional `meta` event when a new field appears.
  const response = (ev as { response?: ResponsesResultWire }).response
  if (!response) {
    if (generationId && generationId !== previouslyEmittedGenerationId) {
      return { lane: 'meta', generationId }
    }
    return null
  }
  const model = typeof response.model === 'string' ? response.model : undefined
  const effectiveGenId = generationId ?? response.id
  if (model === previouslyEmittedModel && effectiveGenId === previouslyEmittedGenerationId) {
    return null
  }
  const event: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
  if (model !== undefined && model !== previouslyEmittedModel) event.model = model
  if (effectiveGenId !== undefined && effectiveGenId !== previouslyEmittedGenerationId) {
    event.generationId = effectiveGenId
  }
  return event.model !== undefined || event.generationId !== undefined ? event : null
}

function* splitResponsesEvent(ev: ResponsesEventWire): Generator<StreamLaneEvent> {
  // Forward-compat: unknown event types are dropped silently (don't crash).
  const t = (ev as { type?: unknown }).type
  if (typeof t !== 'string') return

  switch (t) {
    case 'response.created':
    case 'response.in_progress':
      return

    case 'response.output_item.added': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.output_item.added' }>
      yield { lane: 'output-item-added', outputIndex: e.output_index, item: e.item }
      // Auto-expand the reasoning lane when an encrypted reasoning item shows
      // up. We emit a reasoning event with the INITIAL encrypted_content so
      // UI shows a blob-sized hint immediately; `output_item.done` later
      // REPLACES the value with the final one.
      if (e.item.type === 'reasoning' && typeof e.item.encrypted_content === 'string') {
        yield {
          lane: 'reasoning',
          encryptedDelta: e.item.encrypted_content,
          replaceEncrypted: true,
          outputIndex: e.output_index,
        }
      }
      // Server-tool items get a `server-tool` event on add too.
      if (SERVER_TOOL_ITEM_TYPES.has(e.item.type)) {
        yield {
          lane: 'server-tool',
          itemType: e.item.type as StreamLaneEvent & { lane: 'server-tool' } extends {
            itemType: infer U
          }
            ? U
            : never,
          status: 'in_progress',
          itemId: e.item.id ?? '',
          outputIndex: e.output_index,
        }
      }
      return
    }

    case 'response.output_item.done': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.output_item.done' }>
      yield { lane: 'output-item-done', outputIndex: e.output_index, item: e.item }
      // Reasoning item: emit the FINAL encrypted_content as a replacing
      // reasoning event so the accumulator overwrites the partial from
      // `added` (see §5 of phase11-implementation).
      if (e.item.type === 'reasoning' && typeof e.item.encrypted_content === 'string') {
        yield {
          lane: 'reasoning',
          encryptedDelta: e.item.encrypted_content,
          replaceEncrypted: true,
          outputIndex: e.output_index,
        }
      }
      // Phase metadata rides on message items. GPT-5.4 family REQUIRES
      // this field to round-trip verbatim.
      if (e.item.type === 'message' && e.item.phase !== undefined) {
        yield {
          lane: 'phase',
          phase: (e.item.phase as MessagePhase | null) ?? null,
          outputIndex: e.output_index,
        }
      }
      return
    }

    case 'response.output_text.delta': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.output_text.delta' }>
      if (e.delta.length === 0) return
      yield {
        lane: 'text',
        text: e.delta,
        outputIndex: e.output_index,
        contentIndex: e.content_index,
      }
      return
    }

    case 'response.reasoning.delta': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.reasoning.delta' }>
      yield {
        lane: 'reasoning',
        textDelta: e.delta,
        outputIndex: e.output_index,
      }
      return
    }

    case 'response.reasoning_summary_text.delta': {
      const e = ev as Extract<
        ResponsesEventWire,
        { type: 'response.reasoning_summary_text.delta' }
      >
      yield {
        lane: 'reasoning',
        summaryDelta: e.delta,
        outputIndex: e.output_index,
        summaryIndex: e.summary_index,
      }
      return
    }

    case 'response.function_call_arguments.delta': {
      const e = ev as Extract<
        ResponsesEventWire,
        { type: 'response.function_call_arguments.delta' }
      >
      yield {
        lane: 'tool-call',
        index: e.output_index,
        argumentsDelta: e.delta,
        outputIndex: e.output_index,
      }
      return
    }

    case 'response.web_search_call.in_progress':
    case 'response.web_search_call.searching':
    case 'response.web_search_call.completed':
    case 'response.file_search_call.in_progress':
    case 'response.file_search_call.searching':
    case 'response.file_search_call.completed':
    case 'response.code_interpreter_call.in_progress':
    case 'response.code_interpreter_call.completed': {
      const e = ev as {
        type: string
        output_index: number
        item_id: string
      }
      const status = t.endsWith('.completed')
        ? 'completed'
        : t.endsWith('.searching')
          ? 'searching'
          : 'in_progress'
      const itemType = t.split('.')[1] as StreamLaneEvent & { lane: 'server-tool' } extends {
        itemType: infer U
      }
        ? U
        : never
      yield {
        lane: 'server-tool',
        itemType,
        status,
        itemId: e.item_id,
        outputIndex: e.output_index,
      }
      return
    }

    case 'response.image_generation_call.partial_image': {
      const e = ev as Extract<
        ResponsesEventWire,
        { type: 'response.image_generation_call.partial_image' }
      >
      yield {
        lane: 'server-tool',
        itemType: 'image_generation_call',
        status: 'in_progress',
        itemId: e.item_id,
        outputIndex: e.output_index,
        partialImageB64: e.partial_image_b64,
      }
      return
    }

    case 'response.image_generation_call.completed': {
      const e = ev as Extract<
        ResponsesEventWire,
        { type: 'response.image_generation_call.completed' }
      >
      yield {
        lane: 'server-tool',
        itemType: 'image_generation_call',
        status: 'completed',
        itemId: e.item_id,
        outputIndex: e.output_index,
      }
      return
    }

    case 'response.completed': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.completed' }>
      const resp = e.response
      if (resp.usage) yield { lane: 'usage', usage: normalizeResponsesUsage(resp.usage) }
      const finishReason =
        resp.status === 'completed'
          ? 'stop'
          : resp.status === 'incomplete'
            ? (resp.incomplete_details?.reason ?? 'length')
            : (resp.status ?? 'stop')
      yield { lane: 'finish', finishReason }
      return
    }

    case 'response.failed': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.failed' }>
      const errorPayload = (e.response as { error?: { code?: unknown; message?: string } } | undefined)
        ?.error ?? { message: 'Responses API reported failure' }
      yield {
        lane: 'error',
        error: normalizeError(
          { error: errorPayload },
          {
            midStream: true,
            ...(typeof errorPayload.code === 'number' ? { httpStatus: errorPayload.code } : {}),
          },
        ),
      }
      if (e.response?.usage) {
        yield { lane: 'usage', usage: normalizeResponsesUsage(e.response.usage) }
      }
      return
    }

    case 'response.error':
    case 'error': {
      const e = ev as { error: { code?: unknown; message?: string } }
      yield {
        lane: 'error',
        error: normalizeError(
          { error: e.error ?? { message: 'unknown Responses error' } },
          {
            midStream: true,
            ...(typeof e.error?.code === 'number' ? { httpStatus: e.error.code } : {}),
          },
        ),
      }
      return
    }

    // The non-delta events we deliberately drop — the lane model tracks
    // the `text.delta` / `output_item.done` flow; part-level events
    // are redundant for our accumulator.
    case 'response.content_part.added':
    case 'response.content_part.done':
    case 'response.output_text.done':
    case 'response.reasoning_summary_part.added':
    case 'response.reasoning_summary_part.done':
    case 'response.reasoning_summary_text.done':
    case 'response.reasoning.done':
    case 'response.function_call_arguments.done':
      return

    default:
      // Forward-compat: silently drop unknown event types so future OpenAI
      // additions don't crash our pipeline.
      return
  }
}

function* splitBufferedResponsesResult(
  result: ResponsesResultWire,
  generationId: string | undefined,
): Generator<StreamLaneEvent> {
  if (result.error) {
    yield {
      lane: 'error',
      error: normalizeError(
        { error: result.error },
        {
          midStream: true,
          ...(typeof result.error.code === 'number' ? { httpStatus: result.error.code } : {}),
        },
      ),
    }
    return
  }
  const effectiveGenId = generationId ?? result.id
  if (result.model !== undefined || effectiveGenId !== undefined) {
    const meta: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
    if (typeof result.model === 'string') meta.model = result.model
    if (effectiveGenId !== undefined) meta.generationId = effectiveGenId
    yield meta
  }
  yield {
    lane: 'buffered',
    result,
    ...(generationId !== undefined ? { generationId } : {}),
  }

  // Walk the output[] in order; synthesize lane events so downstream
  // accumulators don't need a separate buffered code path.
  for (const [idx, item] of (result.output ?? []).entries()) {
    yield { lane: 'output-item-added', outputIndex: idx, item }
    if (item.type === 'reasoning') {
      if (typeof item.encrypted_content === 'string') {
        yield {
          lane: 'reasoning',
          encryptedDelta: item.encrypted_content,
          replaceEncrypted: true,
          outputIndex: idx,
        }
      }
      if (Array.isArray(item.summary)) {
        for (const s of item.summary) {
          if (s && typeof s === 'object' && typeof (s as { text?: unknown }).text === 'string') {
            yield {
              lane: 'reasoning',
              summaryDelta: (s as { text: string }).text,
              outputIndex: idx,
            }
          }
        }
      }
    }
    if (item.type === 'message') {
      const textContent = (item.content ?? [])
        .filter((c): c is { type: string; text?: unknown } => !!c && typeof c === 'object')
        .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('')
      if (textContent.length > 0) {
        yield { lane: 'text', text: textContent, outputIndex: idx }
      }
      if (item.phase !== undefined) {
        yield { lane: 'phase', phase: (item.phase as MessagePhase | null) ?? null, outputIndex: idx }
      }
    }
    yield { lane: 'output-item-done', outputIndex: idx, item }
  }

  if (result.usage) yield { lane: 'usage', usage: normalizeResponsesUsage(result.usage) }
  const finishReason =
    result.status === 'completed'
      ? 'stop'
      : result.status === 'incomplete'
        ? (result.incomplete_details?.reason ?? 'length')
        : (result.status ?? 'stop')
  yield { lane: 'finish', finishReason }
}

// OpenAI Responses uses `input_tokens` / `output_tokens` / `output_tokens_details`,
// while chat-completions and our internal UI use `prompt_tokens` /
// `completion_tokens` / `completion_tokens_details`. Normalize so the
// accumulator and UI don't need a dedicated Responses branch. The
// pass-through of `cost` / `cost_details` lets OpenRouter-specific numbers
// ride alongside the normalized OpenAI fields.
function normalizeResponsesUsage(u: ResponsesUsageWire): ChatCompletionUsageWire {
  const out: ChatCompletionUsageWire = {}
  if (typeof u.input_tokens === 'number') out.prompt_tokens = u.input_tokens
  if (typeof u.output_tokens === 'number') out.completion_tokens = u.output_tokens
  if (typeof u.total_tokens === 'number') out.total_tokens = u.total_tokens
  const cachedTokens = u.input_tokens_details?.cached_tokens
  if (typeof cachedTokens === 'number') {
    ;(out as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details = {
      cached_tokens: cachedTokens,
    }
  }
  const reasoningTokens = u.output_tokens_details?.reasoning_tokens
  if (typeof reasoningTokens === 'number') {
    ;(out as { completion_tokens_details?: { reasoning_tokens?: number } }).completion_tokens_details = {
      reasoning_tokens: reasoningTokens,
    }
  }
  if (typeof u.cost === 'number') (out as { cost?: number }).cost = u.cost
  if (u.cost_details) (out as { cost_details?: Record<string, unknown> }).cost_details = u.cost_details
  return out
}

// ---------------------------------------------------------------------------
// Phase 11: Gemini native splitter.
// ---------------------------------------------------------------------------
//
// Gemini `streamGenerateContent?alt=sse` emits ONE JSON object per SSE frame
// carrying the same shape as `:generateContent`. Per frame we may see:
//   - text parts (with optional `thought: true` flag — when thoughts are
//     summarized, the `thought: true` parts carry the visible summary)
//   - a `thoughtSignature` on a part (Gemini 3: last part of a non-function
//     turn OR first part of a functionCall; 2.5 only on functionCall)
//   - `functionCall` parts (tool calls)
//   - `usageMetadata` (final chunk typically) with reasoning/thought token counts
//   - `finishReason` (STOP / MAX_TOKENS / SAFETY / …)
//
// Splitter contract: we emit one `reasoning` event per `thought: true` text
// part with `summaryDelta`; we emit one `reasoning { encryptedDelta,
// replaceEncrypted: true }` for any part carrying a `thoughtSignature` —
// "last wins" because the signature on the final part is the authoritative
// one per `gemini_docs/guides/thought-signatures.md`. We emit one `text`
// event per `thought:false` text part. `usageMetadata` → `usage`,
// `finishReason` → `finish`.

export async function* splitGeminiStream(
  source: AsyncIterable<GeminiStreamChunk>,
): AsyncGenerator<StreamLaneEvent> {
  let metaEmittedModel: string | undefined
  let metaEmittedGenerationId: string | undefined
  // Gemini native has no wire-level `summary_index`; each `thought:true`
  // part is a distinct summary. Assign a monotonically increasing counter
  // so the accumulator can key each part into its own reasoning.summary
  // row. Scoped to the whole stream (not per-frame) because Gemini may
  // split a single response across multiple SSE frames.
  const counter = { summary: 0 }

  for await (const chunk of source) {
    if (chunk.type === 'keepalive') {
      yield { lane: 'keepalive', comment: chunk.comment }
      continue
    }
    if (chunk.type === 'buffered_result') {
      for (const ev of splitGeminiResponse(chunk.result, counter)) yield ev
      continue
    }
    // streaming `chunk` type
    const resp = chunk.chunk
    const meta = metaFromGemini(
      resp,
      chunk.generationId,
      metaEmittedModel,
      metaEmittedGenerationId,
    )
    if (meta) {
      metaEmittedModel = meta.model ?? metaEmittedModel
      metaEmittedGenerationId = meta.generationId ?? metaEmittedGenerationId
      yield meta
    }
    for (const ev of splitGeminiResponse(resp, counter)) yield ev
  }
}

function metaFromGemini(
  resp: GenerateContentResponseWire,
  generationId: string | undefined,
  previouslyEmittedModel: string | undefined,
  previouslyEmittedGenerationId: string | undefined,
): (StreamLaneEvent & { lane: 'meta' }) | null {
  const model = typeof resp.modelVersion === 'string' ? resp.modelVersion : undefined
  const effectiveGenId = generationId ?? (typeof resp.responseId === 'string' ? resp.responseId : undefined)
  const event: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
  let dirty = false
  if (model !== undefined && model !== previouslyEmittedModel) {
    event.model = model
    dirty = true
  }
  if (effectiveGenId !== undefined && effectiveGenId !== previouslyEmittedGenerationId) {
    event.generationId = effectiveGenId
    dirty = true
  }
  return dirty ? event : null
}

// One Gemini response body → lane events. We treat buffered and streaming
// identically here: each frame carries candidates[0].content.parts that we
// map to lane events, plus usageMetadata + finishReason.
function* splitGeminiResponse(
  resp: GenerateContentResponseWire,
  counter: { summary: number },
): Generator<StreamLaneEvent> {
  if (resp.error) {
    yield {
      lane: 'error',
      error: normalizeError(
        { error: resp.error },
        {
          midStream: true,
          ...(typeof resp.error.code === 'number' ? { httpStatus: resp.error.code } : {}),
        },
      ),
    }
    return
  }
  const candidate = resp.candidates?.[0]
  const content: GeminiContent | undefined = candidate?.content
  const parts: GeminiPart[] = content?.parts ?? []

  for (const part of parts) {
    yield* splitGeminiPart(part, counter)
  }

  if (resp.usageMetadata) {
    yield {
      lane: 'usage',
      usage: remapGeminiUsage(resp.usageMetadata),
    }
  }

  if (candidate?.finishReason) {
    yield { lane: 'finish', finishReason: mapGeminiFinishReason(candidate.finishReason) }
  }
}

function* splitGeminiPart(
  part: GeminiPart,
  counter: { summary: number },
): Generator<StreamLaneEvent> {
  // `thoughtSignature` can attach to ANY part type. Emit a reasoning event
  // with replaceEncrypted:true so the accumulator overwrites (last-wins).
  const sig = (part as { thoughtSignature?: string }).thoughtSignature
  if (typeof sig === 'string' && sig.length > 0) {
    yield {
      lane: 'reasoning',
      encryptedDelta: sig,
      replaceEncrypted: true,
    }
  }

  if ('text' in part && typeof part.text === 'string') {
    if (part.text.length === 0) return
    if ((part as { thought?: boolean }).thought === true) {
      yield {
        lane: 'reasoning',
        summaryDelta: part.text,
        summaryIndex: counter.summary++,
      }
    } else {
      yield { lane: 'text', text: part.text }
    }
    return
  }

  const fnCall = (part as { functionCall?: { name: string; args?: Record<string, unknown>; id?: string } }).functionCall
  if (fnCall) {
    const event: StreamLaneEvent & { lane: 'tool-call' } = {
      lane: 'tool-call',
      index: 0,
      name: fnCall.name,
      argumentsDelta: JSON.stringify(fnCall.args ?? {}),
    }
    if (fnCall.id !== undefined) event.id = fnCall.id
    yield event
    return
  }

  // inlineData / fileData / functionResponse — Phase 12+ attachments. For
  // Phase 11 we don't surface them on a lane; the buffered `chunk` still
  // carries the raw object for downstream code that inspects it.
}

// Map Gemini's usageMetadata into our ChatCompletionUsageWire shape so the
// accumulator speaks one usage type. `thoughtsTokenCount` becomes the
// reasoning-tokens subfield on completion_tokens_details. promptTokensDetails
// pass through for modality breakdowns.
function remapGeminiUsage(
  u: NonNullable<GenerateContentResponseWire['usageMetadata']>,
): ChatCompletionUsageWire {
  const out: ChatCompletionUsageWire = {}
  if (typeof u.promptTokenCount === 'number') out.prompt_tokens = u.promptTokenCount
  if (typeof u.candidatesTokenCount === 'number') out.completion_tokens = u.candidatesTokenCount
  if (typeof u.totalTokenCount === 'number') out.total_tokens = u.totalTokenCount
  if (typeof u.thoughtsTokenCount === 'number') {
    ;(out as { completion_tokens_details?: { reasoning_tokens?: number } }).completion_tokens_details = {
      reasoning_tokens: u.thoughtsTokenCount,
    }
  }
  if (typeof u.cachedContentTokenCount === 'number') {
    ;(out as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details = {
      cached_tokens: u.cachedContentTokenCount,
    }
  }
  return out
}

function mapGeminiFinishReason(raw: string): string {
  // Preserve the Gemini-native name in the wire field; callers that need a
  // normalized enum can do it downstream (plan §2 FinishReason mapping).
  // We lowercase "STOP" → "stop" to match chat-completions convention.
  switch (raw.toUpperCase()) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
      return 'content_filter'
    case 'RECITATION':
      return 'content_filter'
    case 'OTHER':
      return 'error'
    default:
      return raw
  }
}

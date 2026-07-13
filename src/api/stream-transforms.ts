// A single stream produces multiple independent lanes. Rather than force every
// caller to re-parse the tagged union, the splitter exposes lane-tagged events that the
// send-pipeline accumulator folds into the message:
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

import { isOpenAiResponsesFamilyFormat } from '../core/reasoning'
import { createInlineReasoningLifter, type InlineReasoningLifter } from '../core/reasoning-inline'
import type { ContentItem, MessagePhase, ReasoningFormat } from '../core/types'
import type {
  AnthropicContentBlock,
  AnthropicEventWire,
  AnthropicMessagesResultWire,
  AnthropicStreamChunk,
  AnthropicUsageWire,
} from './anthropic-types'
import { type ApiError, normalizeError } from './errors'
import type {
  GeminiContent,
  GeminiPart,
  GeminiStreamChunk,
  GenerateContentResponseWire,
} from './gemini-types'
import type { StreamIntegrityEvent } from './stream-integrity'
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

// Lane-tagged events consumed by the message accumulator. Phase 7 defined the
// chat-completions lanes (text / reasoning / tool-call / usage / finish / meta
// / keepalive / error / buffered). Phase 11 adds:
//   - `output-item-added` / `output-item-done` — one per Responses output item
//     (reasoning | message | function_call | server-tool). The accumulator
//     commits one `Message` row per item.
//   - `server-tool` — typed status events for web_search_call et al.
//   - `phase` — emitted on `output_item.done` when the item carries a `phase`
//     field; accumulator pins it on the corresponding `Message`.
//   - `reasoning` gains `summaryDelta`, `encryptedDelta`, `outputIndex`,
//     and provider `itemId` when the upstream exposes one.
//   - `text` gains `outputIndex` + `contentIndex`.
export type StreamLaneEvent =
  | { lane: 'text'; text: string; chunkId?: string; outputIndex?: number; contentIndex?: number }
  | {
      lane: 'reasoning'
      textDelta?: string
      summaryDelta?: string
      encryptedDelta?: string
      format?: ReasoningFormat
      // When `replaceEncrypted` is true the accumulator overwrites the
      // stored encrypted field instead of appending. Emitted on
      // `output_item.done` because the final encrypted_content is authoritative.
      replaceEncrypted?: boolean
      details?: unknown[]
      detailsMode?: 'delta' | 'snapshot' | 'cumulative'
      chunkId?: string
      outputIndex?: number
      itemId?: string
      // `summaryIndex` identifies which summary PART within a reasoning
      // item a `summaryDelta` belongs to. Responses wire exposes this as
      // `summary_index` on `reasoning_summary_text.delta`; Gemini native
      // assigns a per-response counter to each `thought:true` part. The
      // accumulator uses `(itemId, summaryIndex)` when available so
      // incremental deltas and buffered-result fallbacks all converge on the
      // same summary row.
      summaryIndex?: number
    }
  | {
      lane: 'tool-call'
      index: number
      id?: string
      type?: 'function'
      name?: string
      argumentsDelta?: string
      argumentsSnapshot?: string
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
        | 'shell_call'
        | 'shell_call_output'
        | 'computer_call'
        | 'mcp_tool_call'
        | 'mcp_call'
        | 'google:google_search'
        | 'google:url_context'
        | 'google:code_execution'
        | 'google:google_maps'
        | 'openrouter:datetime'
        | 'openrouter:web_fetch'
        | 'openrouter:web_search'
        | 'server_tool_use'
        | 'web_search_tool_result'
        | 'web_fetch_tool_result'
        | 'code_execution_tool_result'
        | 'bash_code_execution_tool_result'
        | 'text_editor_code_execution_tool_result'
        | 'advisor_tool_result'
      status: 'in_progress' | 'searching' | 'completed'
      itemId: string
      outputIndex: number
      partialImageB64?: string
    }
  | {
      lane: 'server-tool-output'
      itemType: string
      itemId: string
      outputIndex: number
      output: unknown
      status?: string
    }
  | {
      lane: 'content-item'
      item: ContentItem
      chunkId?: string
      outputIndex?: number
      itemId?: string
    }
  | {
      lane: 'audio-output'
      dataDelta?: string
      transcriptDelta?: string
      format?: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
      chunkId?: string
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
  | { lane: 'terminal'; evidence: 'done-sentinel' }
  | { lane: 'meta'; model?: string; provider?: string; generationId?: string }
  | { lane: 'keepalive'; comment: string }
  | { lane: 'integrity'; integrity: StreamIntegrityEvent }
  | { lane: 'error'; error: ApiError }
  | {
      lane: 'buffered'
      result: ChatCompletionResultWire | ResponsesResultWire | AnthropicMessagesResultWire
      generationId?: string
    }

interface SplitChatStreamOptions {
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
  let transportTerminal: Extract<StreamLaneEvent, { lane: 'terminal' }> | undefined
  for await (const chunk of source) {
    if (chunk.type === 'integrity') {
      yield { lane: 'integrity', integrity: chunk.integrity }
      continue
    }
    if (chunk.type === 'keepalive') {
      yield { lane: 'keepalive', comment: chunk.comment }
      continue
    }
    if (chunk.type === 'transport_terminal') {
      transportTerminal = { lane: 'terminal', evidence: chunk.evidence }
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
  if (transportTerminal) yield transportTerminal
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
        ...(typeof chunk.error.code === 'number' ? { httpStatus: chunk.error.code } : {}),
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
      const mirror =
        reasoningText !== undefined
          ? reasoningDetailsMirrorInfo(reasoningText, reasoningDetails)
          : { kind: 'none' as const }
      const detailsMirrorScalar = mirror.kind !== 'none'
      if (reasoningText !== undefined && !detailsMirrorScalar) {
        event.textDelta = reasoningText
      }
      if (reasoningDetails !== undefined) {
        event.details = reasoningDetails
        event.detailsMode = mirror.kind === 'cumulative' ? 'cumulative' : 'delta'
      }
      if (chunkId !== undefined) event.chunkId = chunkId
      yield event
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const raw of delta.tool_calls) {
        const event = toToolCallEvent(raw, chunkId)
        if (event) yield event
      }
    }
    if (Array.isArray(delta.images)) {
      for (const item of contentItemsFromChatImages(delta.images)) {
        yield { lane: 'content-item', item, ...(chunkId !== undefined ? { chunkId } : {}) }
      }
    }
    if (Array.isArray(delta.videos)) {
      for (const item of contentItemsFromChatVideos(delta.videos)) {
        yield { lane: 'content-item', item, ...(chunkId !== undefined ? { chunkId } : {}) }
      }
    }
    const audio = audioOutputFromChatAudio(delta.audio)
    if (audio) {
      yield {
        lane: 'audio-output',
        ...(audio.dataDelta !== undefined ? { dataDelta: audio.dataDelta } : {}),
        ...(audio.transcriptDelta !== undefined ? { transcriptDelta: audio.transcriptDelta } : {}),
        ...(audio.format !== undefined ? { format: audio.format } : {}),
        ...(chunkId !== undefined ? { chunkId } : {}),
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
  fallbackIndex?: number,
  snapshot = false,
): (StreamLaneEvent & { lane: 'tool-call' }) | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as {
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
  }
  const index = typeof value.index === 'number' ? value.index : fallbackIndex
  if (index === undefined) return null
  const event: StreamLaneEvent & { lane: 'tool-call' } = {
    lane: 'tool-call',
    index,
  }
  if (typeof value.id === 'string') event.id = value.id
  if (value.type === undefined || value.type === 'function') event.type = 'function'
  if (typeof value.function?.name === 'string') event.name = value.function.name
  if (typeof value.function?.arguments === 'string') {
    if (snapshot) event.argumentsSnapshot = value.function.arguments
    else event.argumentsDelta = value.function.arguments
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
        ...(typeof result.error.code === 'number' ? { httpStatus: result.error.code } : {}),
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

  // Synthesize the same lanes as the streaming path so downstream consumers
  // have one accumulation contract for buffered and incremental responses.
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
    if (reasoningDetails !== undefined) {
      event.details = reasoningDetails
      event.detailsMode = 'snapshot'
    }
    if (typeof result.id === 'string') event.chunkId = result.id
    yield event
  }
  if (Array.isArray(choice?.message?.tool_calls)) {
    for (const [index, raw] of choice.message.tool_calls.entries()) {
      const event = toToolCallEvent(raw, result.id, index, true)
      if (event) yield event
    }
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
  if (Array.isArray(choice?.message?.images)) {
    for (const item of contentItemsFromChatImages(choice.message.images)) {
      yield {
        lane: 'content-item',
        item,
        ...(typeof result.id === 'string' ? { chunkId: result.id } : {}),
      }
    }
  }
  if (Array.isArray(choice?.message?.videos)) {
    for (const item of contentItemsFromChatVideos(choice.message.videos)) {
      yield {
        lane: 'content-item',
        item,
        ...(typeof result.id === 'string' ? { chunkId: result.id } : {}),
      }
    }
  }
  const audio = audioOutputFromChatAudio(choice?.message?.audio)
  if (audio) {
    yield {
      lane: 'audio-output',
      ...(audio.dataDelta !== undefined ? { dataDelta: audio.dataDelta } : {}),
      ...(audio.transcriptDelta !== undefined ? { transcriptDelta: audio.transcriptDelta } : {}),
      ...(audio.format !== undefined ? { format: audio.format } : {}),
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

function reasoningDetailsMirrorText(
  reasoningText: string,
  details: unknown[] | undefined,
): boolean {
  return reasoningDetailsMirrorInfo(reasoningText, details).kind !== 'none'
}

function reasoningDetailsMirrorInfo(
  reasoningText: string,
  details: unknown[] | undefined,
): { kind: 'none' | 'exact' | 'cumulative'; value?: string } {
  if (!details || details.length === 0) return { kind: 'none' }
  let merged = ''
  let sawText = false
  let anthropicTextOnly = true
  let mergedSummary = ''
  let sawOpenAiSummary = false
  for (const raw of details) {
    if (!raw || typeof raw !== 'object') continue
    const detail = raw as {
      id?: unknown
      type?: unknown
      text?: unknown
      summary?: unknown
      format?: unknown
    }
    if (typeof detail.id === 'string' && detail.id.startsWith('tool_')) continue
    if (detail.type === 'reasoning.text' && typeof detail.text === 'string') {
      merged += detail.text
      sawText = true
      anthropicTextOnly &&= detail.format === 'anthropic-claude-v1'
      continue
    }
    if (
      detail.type === 'reasoning.summary' &&
      typeof detail.summary === 'string' &&
      typeof detail.format === 'string' &&
      isOpenAiResponsesFamilyFormat(detail.format as ReasoningFormat)
    ) {
      mergedSummary += detail.summary
      sawOpenAiSummary = true
    }
  }
  if (sawText && merged === reasoningText) return { kind: 'exact', value: merged }
  if (sawText && anthropicTextOnly && merged.endsWith(reasoningText)) {
    return { kind: 'cumulative', value: merged }
  }
  if (sawOpenAiSummary && mergedSummary === reasoningText) {
    return { kind: 'exact', value: mergedSummary }
  }
  return {
    kind: 'none',
    ...(sawText ? { value: merged } : sawOpenAiSummary ? { value: mergedSummary } : {}),
  }
}

function contentItemsFromChatImages(images: readonly unknown[]): ContentItem[] {
  const out: ContentItem[] = []
  for (const image of images) {
    const url = imageUrlFromChatImage(image)
    if (!url) continue
    out.push({ type: 'output_image', url })
  }
  return out
}

function contentItemsFromChatVideos(videos: readonly unknown[]): ContentItem[] {
  const out: ContentItem[] = []
  for (const video of videos) {
    const url = videoUrlFromChatVideo(video)
    if (!url) continue
    const item: ContentItem = { type: 'output_video', url }
    const prompt = videoPromptFromChatVideo(video)
    if (prompt) item.prompt = prompt
    out.push(item)
  }
  return out
}

function imageUrlFromChatImage(image: unknown): string | null {
  if (typeof image === 'string') return normalizeImageUrlOrBase64(image)
  if (!image || typeof image !== 'object') return null
  const record = image as {
    url?: unknown
    image_url?: unknown
    b64_json?: unknown
  }
  if (typeof record.url === 'string') return normalizeImageUrlOrBase64(record.url)
  if (record.image_url && typeof record.image_url === 'object') {
    const nestedUrl = (record.image_url as { url?: unknown }).url
    if (typeof nestedUrl === 'string' && nestedUrl.length > 0) {
      return normalizeImageUrlOrBase64(nestedUrl)
    }
  }
  if (typeof record.b64_json === 'string' && record.b64_json.length > 0) {
    return `data:image/png;base64,${record.b64_json}`
  }
  return null
}

function videoUrlFromChatVideo(video: unknown): string | null {
  if (typeof video === 'string') return normalizeMediaUrl(video)
  if (!video || typeof video !== 'object') return null
  const record = video as {
    url?: unknown
    video_url?: unknown
    content_url?: unknown
  }
  if (typeof record.url === 'string') return normalizeMediaUrl(record.url)
  if (typeof record.content_url === 'string') return normalizeMediaUrl(record.content_url)
  if (
    record.video_url &&
    typeof record.video_url === 'object' &&
    typeof (record.video_url as { url?: unknown }).url === 'string'
  ) {
    return normalizeMediaUrl((record.video_url as { url: string }).url)
  }
  return null
}

function videoPromptFromChatVideo(video: unknown): string | undefined {
  if (!video || typeof video !== 'object') return undefined
  const prompt = (video as { prompt?: unknown }).prompt
  return typeof prompt === 'string' && prompt.length > 0 ? prompt : undefined
}

function audioOutputFromChatAudio(audio: unknown): {
  dataDelta?: string
  transcriptDelta?: string
  format?: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
} | null {
  if (!audio || typeof audio !== 'object') return null
  const record = audio as { data?: unknown; transcript?: unknown; format?: unknown }
  const dataDelta =
    typeof record.data === 'string' && record.data.length > 0 ? record.data : undefined
  const transcriptDelta =
    typeof record.transcript === 'string' && record.transcript.length > 0
      ? record.transcript
      : undefined
  const format = audioFormatFromString(record.format)
  if (dataDelta === undefined && transcriptDelta === undefined) return null
  return {
    ...(dataDelta !== undefined ? { dataDelta } : {}),
    ...(transcriptDelta !== undefined ? { transcriptDelta } : {}),
    ...(format !== undefined ? { format } : {}),
  }
}

function audioFormatFromString(
  value: unknown,
): 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16' | undefined {
  if (typeof value !== 'string') return undefined
  const lower = value.toLowerCase()
  if (
    lower === 'wav' ||
    lower === 'mp3' ||
    lower === 'flac' ||
    lower === 'ogg' ||
    lower === 'm4a' ||
    lower === 'pcm16'
  ) {
    return lower
  }
  return undefined
}

function normalizeImageUrlOrBase64(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (/^(data:|https?:|blob:)/i.test(trimmed)) return trimmed
  return `data:image/png;base64,${trimmed}`
}

function normalizeMediaUrl(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (/^(data:|https?:|blob:)/i.test(trimmed)) return trimmed
  return null
}

// ---------------------------------------------------------------------------
// Phase 11: Responses-API splitter.
// ---------------------------------------------------------------------------

const SERVER_TOOL_ITEM_TYPES = new Set<string>([
  'web_search_call',
  'file_search_call',
  'image_generation_call',
  'code_interpreter_call',
  'shell_call',
  'shell_call_output',
  'computer_call',
  'mcp_tool_call',
  'mcp_call',
  'openrouter:datetime',
  'openrouter:web_fetch',
  'openrouter:web_search',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'advisor_tool_result',
])

export async function* splitResponsesStream(
  source: AsyncIterable<ResponsesStreamChunk>,
): AsyncGenerator<StreamLaneEvent> {
  let metaEmittedModel: string | undefined
  let metaEmittedGenerationId: string | undefined

  for await (const chunk of source) {
    if (chunk.type === 'integrity') {
      yield { lane: 'integrity', integrity: chunk.integrity }
      continue
    }
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
  // `response` payload metadata can be pulled from. At most one
  // additional `meta` event is emitted when a new field appears.
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
      const functionCall = toolCallEventFromResponsesItem(e.item, e.output_index, false)
      if (functionCall) yield functionCall
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
          ...(typeof e.item.id === 'string' ? { itemId: e.item.id } : {}),
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
      const functionCall = toolCallEventFromResponsesItem(e.item, e.output_index, true)
      if (functionCall) yield functionCall
      // Reasoning item: emit the FINAL encrypted_content as a replacing
      // reasoning event so the accumulator overwrites the partial from
      // `added` (see §5 of phase11-implementation).
      if (e.item.type === 'reasoning' && typeof e.item.encrypted_content === 'string') {
        yield {
          lane: 'reasoning',
          encryptedDelta: e.item.encrypted_content,
          replaceEncrypted: true,
          outputIndex: e.output_index,
          ...(typeof e.item.id === 'string' ? { itemId: e.item.id } : {}),
        }
      }
      // Phase metadata rides on message items. GPT-5.4 family REQUIRES
      // this field to round-trip verbatim.
      if (e.item.type === 'message' && e.item.phase !== undefined) {
        yield {
          lane: 'phase',
          phase: e.item.phase ?? null,
          outputIndex: e.output_index,
        }
      }
      const contentItem = contentItemFromResponsesOutputItem(e.item)
      if (contentItem) {
        yield {
          lane: 'content-item',
          item: contentItem,
          outputIndex: e.output_index,
          ...(typeof e.item.id === 'string' ? { itemId: e.item.id } : {}),
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
        itemId: e.item_id,
      }
      return
    }

    case 'response.reasoning_summary_text.delta': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.reasoning_summary_text.delta' }>
      yield {
        lane: 'reasoning',
        summaryDelta: e.delta,
        outputIndex: e.output_index,
        itemId: e.item_id,
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
        type: 'function',
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
    case 'response.code_interpreter_call.completed':
    case 'response.shell_call.in_progress':
    case 'response.shell_call.completed':
    case 'response.shell_call_output.completed': {
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
      const response = (e as { response?: ResponsesResultWire }).response
      const errorPayload = response?.error ?? { message: 'Responses API reported failure' }
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
      if (response?.usage) {
        yield { lane: 'usage', usage: normalizeResponsesUsage(response.usage) }
      }
      return
    }

    case 'response.error':
    case 'error': {
      const e = ev as { error?: { code?: unknown; message?: string } }
      const errorPayload = e.error ?? { message: 'unknown Responses error' }
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
      return
    }

    // These non-delta events are deliberately dropped. The lane model
    // tracks the `text.delta` / `output_item.done` flow; part-level events
    // are redundant for the accumulator.
    case 'response.content_part.added':
    case 'response.content_part.done':
    case 'response.output_text.done':
    case 'response.reasoning_summary_part.added':
    case 'response.reasoning_summary_part.done':
    case 'response.reasoning_summary_text.done':
    case 'response.reasoning.done':
      return

    case 'response.function_call_arguments.done': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.function_call_arguments.done' }>
      yield {
        lane: 'tool-call',
        index: e.output_index,
        type: 'function',
        argumentsSnapshot: e.arguments,
        outputIndex: e.output_index,
      }
      return
    }

    default:
      // Forward-compat: silently drop unknown event types so future OpenAI
      // additions don't crash the pipeline.
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
          ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
        }
      }
      if (Array.isArray(item.summary)) {
        for (const [summaryIndex, s] of item.summary.entries()) {
          if (
            typeof s === 'object' &&
            s !== null &&
            typeof (s as { text?: unknown }).text === 'string'
          ) {
            yield {
              lane: 'reasoning',
              summaryDelta: (s as { text: string }).text,
              outputIndex: idx,
              ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
              summaryIndex,
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
        yield { lane: 'phase', phase: item.phase ?? null, outputIndex: idx }
      }
    }
    const contentItem = contentItemFromResponsesOutputItem(item)
    if (contentItem) {
      yield {
        lane: 'content-item',
        item: contentItem,
        outputIndex: idx,
        ...(typeof item.id === 'string' ? { itemId: item.id } : {}),
      }
    }
    yield { lane: 'output-item-done', outputIndex: idx, item }
    const functionCall = toolCallEventFromResponsesItem(item, idx, true)
    if (functionCall) yield functionCall
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

function toolCallEventFromResponsesItem(
  item: ResponsesInputItem,
  outputIndex: number,
  includeArguments: boolean,
): (StreamLaneEvent & { lane: 'tool-call' }) | null {
  if (item.type !== 'function_call') return null
  const event: StreamLaneEvent & { lane: 'tool-call' } = {
    lane: 'tool-call',
    index: outputIndex,
    type: 'function',
    outputIndex,
  }
  if (typeof item.call_id === 'string') event.id = item.call_id
  if (typeof item.name === 'string') event.name = item.name
  if (includeArguments && typeof item.arguments === 'string') {
    event.argumentsSnapshot = item.arguments
  }
  return event
}

function contentItemFromResponsesOutputItem(item: ResponsesInputItem): ContentItem | null {
  if (item.type !== 'image_generation_call') return null
  const result = (item as { result?: unknown }).result
  if (typeof result !== 'string') return null
  const url = normalizeImageUrlOrBase64(result)
  if (!url) return null
  const output: ContentItem = { type: 'output_image', url }
  const prompt = (item as { prompt?: unknown }).prompt
  if (typeof prompt === 'string' && prompt.length > 0) output.prompt = prompt
  return output
}

// OpenAI Responses uses `input_tokens` / `output_tokens` / `output_tokens_details`,
// while chat-completions and the internal UI use `prompt_tokens` /
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
    ;(
      out as { completion_tokens_details?: { reasoning_tokens?: number } }
    ).completion_tokens_details = {
      reasoning_tokens: reasoningTokens,
    }
  }
  if (typeof u.cost === 'number') (out as { cost?: number }).cost = u.cost
  if (u.cost_details)
    (out as { cost_details?: Record<string, unknown> }).cost_details = u.cost_details
  return out
}

// ---------------------------------------------------------------------------
// Anthropic Messages splitter.
// ---------------------------------------------------------------------------

interface AnthropicBlockState {
  index: number
  block: AnthropicContentBlock
  signatureParts: string[]
  inputJsonParts: string[]
  citations: unknown[]
}

export async function* splitAnthropicStream(
  source: AsyncIterable<AnthropicStreamChunk>,
): AsyncGenerator<StreamLaneEvent> {
  const blocks = new Map<number, AnthropicBlockState>()
  let finishReason: string | undefined
  let metaEmittedGenerationId: string | undefined
  let metaEmittedModel: string | undefined

  for await (const chunk of source) {
    if (chunk.type === 'integrity') {
      yield { lane: 'integrity', integrity: chunk.integrity }
      continue
    }
    if (chunk.type === 'keepalive') {
      yield { lane: 'keepalive', comment: chunk.comment }
      continue
    }
    if (chunk.type === 'buffered_result') {
      yield* splitBufferedAnthropicResult(chunk.result, chunk.generationId)
      continue
    }

    const ev = chunk.event
    if (chunk.generationId && chunk.generationId !== metaEmittedGenerationId) {
      metaEmittedGenerationId = chunk.generationId
      yield { lane: 'meta', generationId: chunk.generationId }
    }
    switch (ev.type) {
      case 'message_start': {
        const e = ev as { message?: AnthropicMessagesResultWire }
        const meta: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
        let dirty = false
        if (typeof e.message?.model === 'string' && e.message.model !== metaEmittedModel) {
          meta.model = e.message.model
          metaEmittedModel = e.message.model
          dirty = true
        }
        const generationId = e.message?.id ?? chunk.generationId
        if (generationId && generationId !== metaEmittedGenerationId) {
          meta.generationId = generationId
          metaEmittedGenerationId = generationId
          dirty = true
        }
        if (dirty) yield meta
        if (e.message?.usage) yield { lane: 'usage', usage: remapAnthropicUsage(e.message.usage) }
        break
      }

      case 'content_block_start': {
        const e = ev as Extract<AnthropicEventWire, { type: 'content_block_start' }>
        const state = createAnthropicBlockState(e.index, e.content_block)
        blocks.set(e.index, state)
        yield* emitAnthropicBlockStart(state)
        break
      }

      case 'content_block_delta': {
        const e = ev as Extract<AnthropicEventWire, { type: 'content_block_delta' }>
        const state = blocks.get(e.index) ?? createAnthropicBlockState(e.index, { type: 'unknown' })
        blocks.set(e.index, state)
        yield* applyAnthropicBlockDelta(state, e.delta)
        break
      }

      case 'content_block_stop': {
        const e = ev as Extract<AnthropicEventWire, { type: 'content_block_stop' }>
        const state = blocks.get(e.index)
        if (state) {
          yield* emitAnthropicBlockDone(state)
          blocks.delete(e.index)
        }
        break
      }

      case 'message_delta': {
        const e = ev as Extract<AnthropicEventWire, { type: 'message_delta' }>
        if (e.usage) yield { lane: 'usage', usage: remapAnthropicUsage(e.usage) }
        if (typeof e.delta?.stop_reason === 'string') {
          finishReason = mapAnthropicFinishReason(e.delta.stop_reason)
          yield { lane: 'finish', finishReason }
        }
        break
      }

      case 'message_stop':
        if (!finishReason) yield { lane: 'finish', finishReason: 'stop' }
        break

      case 'ping':
        break

      case 'error': {
        const e = ev as {
          error?: { type?: unknown; message?: unknown }
        }
        const code = typeof e.error?.type === 'string' ? e.error.type : undefined
        const message =
          typeof e.error?.message === 'string' ? e.error.message : 'Anthropic stream error'
        yield {
          lane: 'error',
          error: normalizeError(
            {
              error: { code, message },
            },
            { midStream: true },
          ),
        }
        break
      }

      default:
        break
    }
  }
}

function createAnthropicBlockState(
  index: number,
  block: AnthropicContentBlock,
): AnthropicBlockState {
  return {
    index,
    block: structuredClone(block),
    signatureParts: typeof block.signature === 'string' ? [block.signature] : [],
    inputJsonParts: [],
    citations: Array.isArray(block.citations) ? structuredClone(block.citations) : [],
  }
}

function* emitAnthropicBlockStart(state: AnthropicBlockState): Generator<StreamLaneEvent> {
  const type = state.block.type
  const initialText = typeof state.block.text === 'string' ? state.block.text : ''
  const initialThinking = typeof state.block.thinking === 'string' ? state.block.thinking : ''
  if (type === 'text' && initialText.length > 0) {
    yield { lane: 'text', text: initialText, outputIndex: state.index, contentIndex: state.index }
  } else if (type === 'thinking' && initialThinking.length > 0) {
    yield {
      lane: 'reasoning',
      textDelta: initialThinking,
      format: 'anthropic-claude-v1',
      outputIndex: state.index,
      itemId: anthropicReasoningId(state),
    }
  } else if (type === 'redacted_thinking' && typeof state.block.data === 'string') {
    yield {
      lane: 'reasoning',
      encryptedDelta: state.block.data,
      format: 'anthropic-claude-v1',
      replaceEncrypted: true,
      outputIndex: state.index,
      itemId: anthropicReasoningId(state),
    }
  } else if (type === 'tool_use') {
    const event: StreamLaneEvent & { lane: 'tool-call' } = {
      lane: 'tool-call',
      index: state.index,
      id: anthropicBlockId(state),
      type: 'function',
      outputIndex: state.index,
    }
    if (typeof state.block.name === 'string') event.name = state.block.name
    yield event
  } else if (isAnthropicToolBlockType(type)) {
    const id = anthropicBlockId(state)
    if (type === 'server_tool_use') {
      yield {
        lane: 'server-tool',
        itemType: 'server_tool_use',
        status: 'in_progress',
        itemId: id,
        outputIndex: state.index,
      }
    }
  }
}

function* applyAnthropicBlockDelta(
  state: AnthropicBlockState,
  delta: AnthropicContentBlock,
): Generator<StreamLaneEvent> {
  const deltaType = delta.type
  if (deltaType === 'text_delta' && typeof delta.text === 'string') {
    yield { lane: 'text', text: delta.text, outputIndex: state.index, contentIndex: state.index }
    return
  }
  if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
    yield {
      lane: 'reasoning',
      textDelta: delta.thinking,
      format: 'anthropic-claude-v1',
      outputIndex: state.index,
      itemId: anthropicReasoningId(state),
    }
    return
  }
  if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
    state.signatureParts.push(delta.signature)
    return
  }
  if (deltaType === 'input_json_delta' && typeof delta.partial_json === 'string') {
    state.inputJsonParts.push(delta.partial_json)
    yield {
      lane: 'tool-call',
      index: state.index,
      type: 'function',
      argumentsDelta: delta.partial_json,
      outputIndex: state.index,
    }
    return
  }
  if (deltaType === 'citations_delta' && delta.citation !== undefined) {
    state.citations.push(structuredClone(delta.citation))
  }
}

function* emitAnthropicBlockDone(state: AnthropicBlockState): Generator<StreamLaneEvent> {
  const type = state.block.type
  if (type === 'thinking') {
    const signature = state.signatureParts.join('')
    yield {
      lane: 'reasoning',
      details: [
        {
          type: 'reasoning.text',
          id: `text#${anthropicReasoningId(state)}`,
          index: state.index,
          format: 'anthropic-claude-v1',
          ...(signature.length > 0 ? { signature } : {}),
        },
      ],
      outputIndex: state.index,
      itemId: anthropicReasoningId(state),
    }
    return
  }
  if (type === 'redacted_thinking' && typeof state.block.data === 'string') {
    yield {
      lane: 'reasoning',
      details: [
        {
          type: 'reasoning.encrypted',
          id: anthropicReasoningId(state),
          index: state.index,
          format: 'anthropic-claude-v1',
          data: state.block.data,
        },
      ],
      outputIndex: state.index,
      itemId: anthropicReasoningId(state),
    }
    return
  }
  if (type === 'tool_use') {
    const streamedArguments = state.inputJsonParts.join('')
    const event: StreamLaneEvent & { lane: 'tool-call' } = {
      lane: 'tool-call',
      index: state.index,
      id: anthropicBlockId(state),
      type: 'function',
      argumentsSnapshot:
        streamedArguments.length > 0 ? streamedArguments : JSON.stringify(state.block.input ?? {}),
      outputIndex: state.index,
    }
    if (typeof state.block.name === 'string') event.name = state.block.name
    yield event
    return
  }
  if (!isAnthropicToolBlockType(type)) return
  const output = finalizeAnthropicToolBlock(state)
  const itemId = anthropicBlockId(state)
  if (type === 'server_tool_use') {
    yield {
      lane: 'server-tool',
      itemType: 'server_tool_use',
      status: 'completed',
      itemId,
      outputIndex: state.index,
    }
  }
  yield {
    lane: 'server-tool-output',
    itemType: type,
    itemId,
    outputIndex: state.index,
    ...(type === 'server_tool_use' ? { status: 'completed' } : {}),
    output,
  }
}

function* splitBufferedAnthropicResult(
  result: AnthropicMessagesResultWire,
  generationId: string | undefined,
): Generator<StreamLaneEvent> {
  if (result.error) {
    yield {
      lane: 'error',
      error: normalizeError(
        { error: { code: result.error.type, message: result.error.message ?? 'Anthropic error' } },
        { midStream: true },
      ),
    }
    return
  }
  const effectiveGenId = generationId ?? result.id
  if (typeof result.model === 'string' || effectiveGenId) {
    const meta: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
    if (typeof result.model === 'string') meta.model = result.model
    if (effectiveGenId) meta.generationId = effectiveGenId
    yield meta
  }
  yield { lane: 'buffered', result, ...(generationId !== undefined ? { generationId } : {}) }

  for (const [index, block] of (result.content ?? []).entries()) {
    const state = createAnthropicBlockState(index, block)
    yield* emitAnthropicBlockStart(state)
    yield* emitAnthropicBlockDone(state)
  }
  if (result.usage) yield { lane: 'usage', usage: remapAnthropicUsage(result.usage) }
  if (result.stop_reason) {
    yield { lane: 'finish', finishReason: mapAnthropicFinishReason(result.stop_reason) }
  }
}

function finalizeAnthropicToolBlock(state: AnthropicBlockState): AnthropicContentBlock {
  const output = structuredClone(state.block)
  const inputJson = state.inputJsonParts.join('')
  if (inputJson.length > 0 && output.input === undefined) {
    try {
      output.input = JSON.parse(inputJson)
    } catch {
      output.input = inputJson
    }
  }
  if (state.citations.length > 0 && output.citations === undefined) {
    output.citations = structuredClone(state.citations)
  }
  return output
}

function isAnthropicToolBlockType(type: string): boolean {
  return (
    type === 'server_tool_use' ||
    type === 'web_search_tool_result' ||
    type === 'web_fetch_tool_result' ||
    type === 'code_execution_tool_result' ||
    type === 'bash_code_execution_tool_result' ||
    type === 'text_editor_code_execution_tool_result' ||
    type === 'advisor_tool_result'
  )
}

function anthropicBlockId(state: AnthropicBlockState): string {
  const id = state.block.id ?? state.block.tool_use_id
  return typeof id === 'string' ? id : `anthropic-${state.block.type}-${state.index}`
}

function anthropicReasoningId(state: AnthropicBlockState): string {
  return `anthropic-reasoning-${state.index}`
}

function remapAnthropicUsage(u: AnthropicUsageWire): ChatCompletionUsageWire {
  const out: ChatCompletionUsageWire = {}
  if (typeof u.input_tokens === 'number') out.prompt_tokens = u.input_tokens
  if (typeof u.output_tokens === 'number') out.completion_tokens = u.output_tokens
  if (typeof u.input_tokens === 'number' && typeof u.output_tokens === 'number') {
    out.total_tokens = u.input_tokens + u.output_tokens
  }
  if (
    typeof u.cache_read_input_tokens === 'number' ||
    typeof u.cache_creation_input_tokens === 'number'
  ) {
    out.prompt_tokens_details = {
      cached_tokens:
        (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0) +
        (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0),
    }
  }
  if (u.server_tool_use) out.server_tool_use = { ...u.server_tool_use }
  if (typeof u.cache_creation_input_tokens === 'number') {
    out.cache_creation_input_tokens = u.cache_creation_input_tokens
  }
  return out
}

function mapAnthropicFinishReason(raw: string): string {
  if (raw === 'end_turn') return 'stop'
  if (raw === 'max_tokens') return 'length'
  return raw
}

// ---------------------------------------------------------------------------
// Phase 11: Gemini native splitter.
// ---------------------------------------------------------------------------
//
// Gemini `streamGenerateContent?alt=sse` emits ONE JSON object per SSE frame
// carrying the same shape as `:generateContent`. Per frame:
//   - text parts (with optional `thought: true` flag — when thoughts are
//     summarized, the `thought: true` parts carry the visible summary)
//   - a `thoughtSignature` on a part (Gemini 3: last part of a non-function
//     turn OR first part of a functionCall; 2.5 only on functionCall)
//   - `functionCall` parts (tool calls)
//   - `usageMetadata` (final chunk typically) with reasoning/thought token counts
//   - `finishReason` (STOP / MAX_TOKENS / SAFETY / …)
//
// Splitter contract: emit one `reasoning` event per `thought: true` text
// part with `summaryDelta`; emit one `reasoning { encryptedDelta,
// replaceEncrypted: true }` for any part carrying a `thoughtSignature`,
// "last wins" because the signature on the final part is the authoritative
// one per `gemini_docs/guides/thought-signatures.md`. Emit one `text`
// event per `thought:false` text part. `usageMetadata` → `usage`,
// `finishReason` → `finish`.

export async function* splitGeminiStream(
  source: AsyncIterable<GeminiStreamChunk>,
): AsyncGenerator<StreamLaneEvent> {
  let metaEmittedModel: string | undefined
  let metaEmittedGenerationId: string | undefined
  // Gemini emits each thinking section as its own atomic `thought: true`
  // part (one per SSE frame; verified against gemini-3-pro-preview live
  // streams — sections like "**Defining the Core Idea**…" and
  // "**Confirming the Transformation**…" arrive as separate parts).
  //
  // The splitter coalesces them into a SINGLE `reasoning.summary` row so the
  // UI shows one continuous Summary block, not one row per section. The shared
  // `summaryIndex: 0` makes the accumulator (`putReasoningDetail` + the
  // synthetic id `summary#0`) merge each part into the same row via
  // `mergeReasoningText`. Section count is tracked to prepend a `\n\n`
  // separator on non-first parts so the joined text has clean breaks
  // even on synthetic / probe inputs that don't already end with newlines.
  const counter = { summary: 0, toolCalls: 0 }

  for await (const chunk of source) {
    if (chunk.type === 'integrity') {
      yield { lane: 'integrity', integrity: chunk.integrity }
      continue
    }
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
    const meta = metaFromGemini(resp, chunk.generationId, metaEmittedModel, metaEmittedGenerationId)
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
  const effectiveGenId =
    generationId ?? (typeof resp.responseId === 'string' ? resp.responseId : undefined)
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

// One Gemini response body → lane events. Buffered and streaming are treated
// identically here: each frame carries candidates[0].content.parts that map
// to lane events, plus usageMetadata + finishReason.
function* splitGeminiResponse(
  resp: GenerateContentResponseWire,
  counter: { summary: number; toolCalls: number },
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
  yield* splitGeminiProviderToolMetadata(resp, candidate?.index ?? 0)

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

function* splitGeminiProviderToolMetadata(
  resp: GenerateContentResponseWire,
  outputIndex: number,
): Generator<StreamLaneEvent> {
  const record = resp as Record<string, unknown>
  if (record.groundingMetadata !== undefined) {
    yield {
      lane: 'server-tool-output',
      itemType: 'google:google_search',
      itemId: `google-search-${outputIndex}`,
      outputIndex,
      status: 'completed',
      output: structuredClone(record.groundingMetadata),
    }
  }
  if (record.urlContextMetadata !== undefined) {
    yield {
      lane: 'server-tool-output',
      itemType: 'google:url_context',
      itemId: `google-url-context-${outputIndex}`,
      outputIndex,
      status: 'completed',
      output: structuredClone(record.urlContextMetadata),
    }
  }
  if (record.googleMapsMetadata !== undefined) {
    yield {
      lane: 'server-tool-output',
      itemType: 'google:google_maps',
      itemId: `google-maps-${outputIndex}`,
      outputIndex,
      status: 'completed',
      output: structuredClone(record.googleMapsMetadata),
    }
  }
}

function* splitGeminiPart(
  part: GeminiPart,
  counter: { summary: number; toolCalls: number },
): Generator<StreamLaneEvent> {
  // `thoughtSignature` can attach to ANY part type. Emit a reasoning event
  // with replaceEncrypted:true so the accumulator overwrites (last-wins).
  const sig = (part as { thoughtSignature?: string }).thoughtSignature
  if (typeof sig === 'string' && sig.length > 0) {
    yield {
      lane: 'reasoning',
      encryptedDelta: sig,
      replaceEncrypted: true,
      format: 'google-gemini-v1',
    }
  }

  if ('text' in part && typeof part.text === 'string') {
    if (part.text.length === 0) return
    if ((part as { thought?: boolean }).thought === true) {
      // Coalesce all sections into one summary row (summaryIndex: 0). For
      // sections after the first, prepend `\n\n` so the merged text has
      // visible section breaks regardless of what the wire emitted.
      const isFirst = counter.summary === 0
      yield {
        lane: 'reasoning',
        summaryDelta: isFirst ? part.text : `\n\n${part.text}`,
        summaryIndex: 0,
        format: 'google-gemini-v1',
      }
      counter.summary += 1
    } else {
      yield { lane: 'text', text: part.text }
    }
    return
  }

  const fnCall = (
    part as { functionCall?: { name: string; args?: Record<string, unknown>; id?: string } }
  ).functionCall
  if (fnCall) {
    const index = counter.toolCalls
    counter.toolCalls += 1
    const event: StreamLaneEvent & { lane: 'tool-call' } = {
      lane: 'tool-call',
      index,
      id: fnCall.id ?? `google-gemini:function-call:${index}`,
      type: 'function',
      name: fnCall.name,
      argumentsSnapshot: JSON.stringify(fnCall.args ?? {}),
    }
    yield event
    return
  }

  if ('executableCode' in part) {
    yield {
      lane: 'server-tool-output',
      itemType: 'google:code_execution',
      itemId: 'google-code-executable',
      outputIndex: 0,
      status: 'in_progress',
      output: structuredClone(part),
    }
    return
  }

  if ('codeExecutionResult' in part) {
    yield {
      lane: 'server-tool-output',
      itemType: 'google:code_execution',
      itemId: 'google-code-result',
      outputIndex: 0,
      status: 'completed',
      output: structuredClone(part),
    }
    return
  }

  // inlineData / fileData / functionResponse — Phase 12+ attachments. In
  // Phase 11 they're not surfaced on a lane; the buffered `chunk` still
  // carries the raw object for downstream code that inspects it.
}

// Map Gemini's usageMetadata into the ChatCompletionUsageWire shape so the
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
    ;(
      out as { completion_tokens_details?: { reasoning_tokens?: number } }
    ).completion_tokens_details = {
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

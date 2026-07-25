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
// (and exercised by unit tests) but not consumed by the generation engine until later
// phases.

import {
  normalizeContentAnnotations,
  normalizeGeminiGroundingAnnotations,
} from '../core/content-annotations'
import type { StreamLaneEvent } from '../core/generation-stream-live-events'
import {
  type AttemptProviderOutputContract,
  isKnownProviderToolOutputType,
  providerOutputItemFromResponsesItem,
  providerOutputItemIdentity,
} from '../core/provider-tool-context'
import {
  type AttemptAnthropicReasoningContract,
  type AttemptChatReasoningContract,
  type AttemptGeminiReasoningContract,
  type AttemptResponsesReasoningContract,
  type AttemptTextReasoningContract,
  isReasoningFormat,
  visibleKindForInboundReasoning,
} from '../core/reasoning'
import { createInlineReasoningLifter, type InlineReasoningLifter } from '../core/reasoning-inline'
import {
  type ReasoningMemberAlias,
  type ReasoningObservation,
  type ReasoningVisibleBindingObservation,
  reasoningObservationsFromDetails,
} from '../core/reasoning-observation'
import type {
  ContentItem,
  GenerationServerToolCall,
  MessagePhase,
  ProviderOutputItem,
  ReasoningFormat,
} from '../core/types'
import type {
  AnthropicContentBlock,
  AnthropicEventWire,
  AnthropicMessagesResultWire,
  AnthropicStreamChunk,
  AnthropicUsageWire,
} from './anthropic-types'
import { normalizeError } from './errors'
import type {
  GeminiContent,
  GeminiPart,
  GeminiStreamChunk,
  GenerateContentResponseWire,
} from './gemini-types'
import { decodeProviderReasoningDetails } from './provider-json-boundary'
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

type AttemptChatStreamReasoningContract =
  | AttemptChatReasoningContract
  | AttemptTextReasoningContract

interface SplitChatStreamOptions {
  reasoning: AttemptChatStreamReasoningContract
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

interface ChatChoiceStreamState {
  lifter: InlineReasoningLifter
  annotationState: { text: string }
}

function createChatChoiceStreamState(opts: SplitChatStreamOptions): ChatChoiceStreamState {
  return {
    lifter: createInlineReasoningLifter({
      ...(opts.inlineReasoningTags !== undefined ? { tags: opts.inlineReasoningTags } : {}),
      ...(opts.forceInlineReasoning === true ? { autoDetect: false } : {}),
    }),
    annotationState: { text: '' },
  }
}

function chatChoiceStreamState(
  states: Map<number, ChatChoiceStreamState>,
  choiceIndex: number,
  opts: SplitChatStreamOptions,
): ChatChoiceStreamState {
  const current = states.get(choiceIndex)
  if (current) return current
  const created = createChatChoiceStreamState(opts)
  states.set(choiceIndex, created)
  return created
}

function inlineReasoningObservation(text: string, choiceIndex: number): ReasoningObservation {
  return {
    kind: 'visible',
    visibleKind: 'text',
    update: 'append',
    value: text,
    format: 'unknown',
    source: { dialect: 'inline', bridge: 'inline', choiceIndex },
    groupAliases: [{ kind: 'inline-choice', choiceIndex }],
    memberAliases: [{ kind: 'inline', choiceIndex }],
  }
}

function chatScalarReasoningObservation(
  text: string,
  choiceIndex: number,
  reasoning: AttemptChatStreamReasoningContract,
  update: 'append' | 'set' = 'append',
): Extract<ReasoningObservation, { kind: 'visible' }> {
  const visibleKind = visibleKindForInboundReasoning(reasoning.inboundVisibility)
  return {
    kind: 'visible',
    visibleKind,
    update,
    value: text,
    format: reasoning.targetFormat ?? 'unknown',
    source: {
      dialect: reasoning.originDialect,
      bridge: reasoning.producerBridge,
      choiceIndex,
    },
    groupAliases: [{ kind: 'chat-choice', choiceIndex, memberKind: visibleKind }],
    memberAliases: [{ kind: 'chat-scalar', choiceIndex, visibleKind }],
  }
}

function reasoningObservationEvent(
  observations: readonly ReasoningObservation[],
  chunkId?: string,
): Extract<StreamLaneEvent, { lane: 'reasoning-observation' }> {
  return {
    lane: 'reasoning-observation',
    batch: { observations },
    ...(chunkId === undefined ? {} : { chunkId }),
  }
}

function reasoningLaneIntegrity(
  issues: readonly string[],
): StreamLaneEvent & { lane: 'integrity' } {
  const value = issues.join('|')
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return {
    lane: 'integrity',
    integrity: {
      category: 'malformed-event-shape',
      adapter: 'chat-completions',
      eventType: 'reasoning_details',
      count: issues.length,
      fingerprint: `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`,
      characterCount: value.length,
    },
  }
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
  opts: SplitChatStreamOptions,
): AsyncGenerator<StreamLaneEvent> {
  const choiceStates = new Map<number, ChatChoiceStreamState>()
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
      yield* splitBufferedResult(chunk.result, chunk.generationId, choiceStates, opts)
      continue
    }
    yield* splitDelta(chunk.chunk, chunk.generationId, choiceStates, opts)
  }

  for (const [choiceIndex, state] of choiceStates) {
    for (const flushed of state.lifter.finish()) {
      if (flushed.kind === 'text') {
        yield { lane: 'text', text: flushed.text }
      } else {
        yield reasoningObservationEvent([inlineReasoningObservation(flushed.text, choiceIndex)])
      }
    }
  }
  if (transportTerminal) yield transportTerminal
}

function* splitDelta(
  chunk: ChatCompletionChunkWire,
  generationId: string | undefined,
  choiceStates: Map<number, ChatChoiceStreamState>,
  opts: SplitChatStreamOptions,
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

  for (const [choiceOrdinal, choice] of (chunk.choices ?? []).entries()) {
    const choiceIndex = choice.index ?? choiceOrdinal
    const state = chatChoiceStreamState(choiceStates, choiceIndex, opts)
    yield* splitChoiceDelta(
      choice,
      choiceIndex,
      typeof chunk.id === 'string' ? chunk.id : undefined,
      state,
      opts.reasoning,
    )
  }

  const firstAnnotationState = choiceStates.values().next().value?.annotationState
  const rootAnnotations = normalizeContentAnnotations(annotationValues(chunk.citations), {
    source: 'openai-chat',
    text: firstAnnotationState?.text ?? '',
  })
  if (rootAnnotations.length > 0) {
    yield {
      lane: 'text-annotations',
      annotations: rootAnnotations,
      ownerTextLength: firstAnnotationState?.text.length ?? 0,
    }
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
  choiceIndex: number,
  chunkId: string | undefined,
  state: ChatChoiceStreamState,
  reasoning: AttemptChatStreamReasoningContract,
): Generator<StreamLaneEvent> {
  const { lifter, annotationState } = state
  const delta = choice.delta
  if (delta) {
    if (typeof delta.content === 'string') annotationState.text += delta.content
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
            ...reasoningObservationEvent(
              [inlineReasoningObservation(ev.text, choiceIndex)],
              chunkId,
            ),
          }
        }
      }
    }
    const annotations = normalizeContentAnnotations(
      annotationValues(delta.annotations, delta.citations),
      { source: 'openai-chat', text: annotationState.text },
    )
    if (annotations.length > 0) {
      yield {
        lane: 'text-annotations',
        annotations,
        ownerTextLength: annotationState.text.length,
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
      let detailObservations: ReasoningObservation[] = []
      if (reasoningDetails !== undefined) {
        const decoded = decodeProviderReasoningDetails(reasoningDetails, reasoning.targetFormat)
        if (decoded.issues.length > 0) yield reasoningLaneIntegrity(decoded.issues)
        if (decoded.details.length > 0) {
          detailObservations = reasoningObservationsFromDetails({
            details: decoded.details,
            mode: 'delta',
            dialect: reasoning.originDialect,
            bridge: reasoning.producerBridge,
            untypedVisibleKind: visibleKindForInboundReasoning(reasoning.inboundVisibility),
            separateGeminiVisibleSections: reasoningText === undefined,
            source: { choiceIndex },
          })
        }
      }
      const observations = reconcileChatReasoningObservations(
        reasoningText,
        detailObservations,
        choiceIndex,
        reasoning,
        'append',
      )
      if (observations.length > 0) yield reasoningObservationEvent(observations, chunkId)
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
          ...reasoningObservationEvent(
            [inlineReasoningObservation(flushed.text, choiceIndex)],
            chunkId,
          ),
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
  choiceStates: Map<number, ChatChoiceStreamState>,
  opts: SplitChatStreamOptions,
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

  // Synthesize the same lanes as the streaming path so downstream consumers
  // have one accumulation contract for buffered and incremental responses.
  const choice = result.choices?.[0]
  const choiceIndex = choice?.index ?? 0
  const state = chatChoiceStreamState(choiceStates, choiceIndex, opts)
  const messageText = typeof choice?.message?.content === 'string' ? choice.message.content : ''
  state.annotationState.text = messageText
  const reasoningText =
    typeof choice?.message?.reasoning === 'string' && choice.message.reasoning.length > 0
      ? choice.message.reasoning
      : undefined
  const reasoningDetails = Array.isArray(choice?.message?.reasoning_details)
    ? choice.message.reasoning_details
    : undefined
  if (reasoningText !== undefined || reasoningDetails !== undefined) {
    let detailObservations: ReasoningObservation[] = []
    if (reasoningDetails !== undefined) {
      const decoded = decodeProviderReasoningDetails(reasoningDetails, opts.reasoning.targetFormat)
      if (decoded.issues.length > 0) yield reasoningLaneIntegrity(decoded.issues)
      if (decoded.details.length > 0) {
        detailObservations = reasoningObservationsFromDetails({
          details: decoded.details,
          mode: 'snapshot',
          dialect: opts.reasoning.originDialect,
          bridge: opts.reasoning.producerBridge,
          untypedVisibleKind: visibleKindForInboundReasoning(opts.reasoning.inboundVisibility),
          source: { choiceIndex },
        })
      }
    }
    const observations = reconcileChatReasoningObservations(
      reasoningText,
      detailObservations,
      choiceIndex,
      opts.reasoning,
      'set',
    )
    if (observations.length > 0) {
      yield reasoningObservationEvent(observations, result.id)
    }
  }
  if (Array.isArray(choice?.message?.tool_calls)) {
    for (const [index, raw] of choice.message.tool_calls.entries()) {
      const event = toToolCallEvent(raw, result.id, index, true)
      if (event) yield event
    }
  }
  if (messageText.length > 0) {
    for (const ev of state.lifter.feed(messageText)) {
      if (ev.kind === 'text') {
        yield {
          lane: 'text',
          text: ev.text,
          ...(typeof result.id === 'string' ? { chunkId: result.id } : {}),
        }
      } else {
        yield reasoningObservationEvent(
          [inlineReasoningObservation(ev.text, choiceIndex)],
          result.id,
        )
      }
    }
  }
  const annotations = normalizeContentAnnotations(
    annotationValues(choice?.message?.annotations, choice?.message?.citations, result.citations),
    { source: 'openai-chat', text: messageText },
  )
  if (annotations.length > 0) {
    yield {
      lane: 'text-annotations',
      annotations,
      ownerTextLength: messageText.length,
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

function reconcileChatReasoningObservations(
  scalar: string | undefined,
  observations: readonly ReasoningObservation[],
  choiceIndex: number,
  reasoning: AttemptChatStreamReasoningContract,
  scalarUpdate: 'append' | 'set',
): ReasoningObservation[] {
  const reconciled = [...observations]
  const visible = reconciled.filter(
    (observation): observation is Extract<ReasoningObservation, { kind: 'visible' }> =>
      observation.kind === 'visible',
  )
  const sameKindVisible = visible.filter(
    (observation): observation is Extract<ReasoningObservation, { kind: 'visible' }> =>
      observation.visibleKind === visibleKindForInboundReasoning(reasoning.inboundVisibility),
  )
  if (scalar === undefined) {
    const terminalBindings = reconciled.filter(
      (
        observation,
      ): observation is Extract<ReasoningObservation, { kind: 'carrier' }> & {
        binding: NonNullable<Extract<ReasoningObservation, { kind: 'carrier' }>['binding']>
      } =>
        observation.kind === 'carrier' &&
        observation.carrierKind === 'anthropic-signature' &&
        observation.binding?.visibleKind ===
          visibleKindForInboundReasoning(reasoning.inboundVisibility),
    )
    if (visible.length === 0 && terminalBindings.length === 1) {
      return attachUnambiguousChatScalarAlias(
        reconciled,
        choiceIndex,
        visibleKindForInboundReasoning(reasoning.inboundVisibility),
      )
    }
    return reconciled
  }
  if (visible.length === 0) {
    return [
      chatScalarReasoningObservation(scalar, choiceIndex, reasoning, scalarUpdate),
      ...reconciled,
    ]
  }
  let scalarOffset = 0
  let exactFrameMirror = true
  for (const observation of visible) {
    if (!scalar.startsWith(observation.value, scalarOffset)) exactFrameMirror = false
    scalarOffset += observation.value.length
  }
  if (exactFrameMirror && scalarOffset === scalar.length) {
    return attachUnambiguousChatScalarAlias(
      reconciled,
      choiceIndex,
      visibleKindForInboundReasoning(reasoning.inboundVisibility),
    )
  }
  const target = sameKindVisible.length === 1 ? sameKindVisible[0] : undefined
  if (target?.format === 'anthropic-claude-v1' && target.value.endsWith(scalar)) {
    const targetIndex = reconciled.indexOf(target)
    return attachUnambiguousChatScalarAlias(
      reconciled,
      choiceIndex,
      visibleKindForInboundReasoning(reasoning.inboundVisibility),
    ).map((observation, index) =>
      index === targetIndex && observation.kind === 'visible'
        ? {
            ...observation,
            update: scalarUpdate === 'append' ? 'append-overlap' : 'set',
          }
        : observation,
    )
  }
  return [
    chatScalarReasoningObservation(scalar, choiceIndex, reasoning, scalarUpdate),
    ...reconciled,
  ]
}

function attachUnambiguousChatScalarAlias(
  observations: readonly ReasoningObservation[],
  choiceIndex: number,
  visibleKind: 'text' | 'summary',
): ReasoningObservation[] {
  const matchingGroups = new Set<string>()
  for (const observation of observations) {
    const binding = observation.kind === 'visible' ? observation : observation.binding
    if (binding?.visibleKind === visibleKind) {
      matchingGroups.add(JSON.stringify(binding.groupAliases))
    }
  }
  if (matchingGroups.size !== 1) return [...observations]
  const [matchingGroup] = matchingGroups
  return observations.map((observation) => {
    if (observation.kind === 'visible') {
      return observation.visibleKind === visibleKind &&
        JSON.stringify(observation.groupAliases) === matchingGroup
        ? withChatScalarAlias(observation, choiceIndex, visibleKind)
        : observation
    }
    const binding = observation.binding
    if (
      binding?.visibleKind !== visibleKind ||
      JSON.stringify(binding.groupAliases) !== matchingGroup
    ) {
      return observation
    }
    return {
      ...observation,
      groupAliases: [
        { kind: 'chat-choice', choiceIndex, memberKind: visibleKind },
        ...observation.groupAliases,
      ],
      binding: withChatScalarAlias(binding, choiceIndex, visibleKind),
    }
  })
}

function withChatScalarAlias<Observation extends ReasoningVisibleBindingObservation>(
  observation: Observation,
  choiceIndex: number,
  visibleKind: 'text' | 'summary',
): Observation {
  const scalarAlias: ReasoningMemberAlias = { kind: 'chat-scalar', choiceIndex, visibleKind }
  return {
    ...observation,
    groupAliases: [
      { kind: 'chat-choice', choiceIndex, memberKind: visibleKind },
      ...observation.groupAliases,
    ],
    memberAliases: [scalarAlias, ...observation.memberAliases],
  }
}

function annotationValues(...values: unknown[]): unknown[] {
  const annotations: unknown[] = []
  for (const value of values) {
    if (!Array.isArray(value)) continue
    for (const annotation of value) {
      annotations.push(
        typeof annotation === 'string' ? { type: 'url_citation', url: annotation } : annotation,
      )
    }
  }
  return annotations
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

export async function* splitResponsesStream(
  source: AsyncIterable<ResponsesStreamChunk>,
  reasoning: AttemptResponsesReasoningContract,
  providerOutput: Extract<
    AttemptProviderOutputContract,
    { captureDialect: 'openai-responses' | 'openrouter-responses' }
  >,
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
      yield* splitBufferedResponsesResult(
        chunk.result,
        chunk.generationId,
        reasoning,
        providerOutput.captureDialect,
      )
      return
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
    yield* splitResponsesEvent(ev, reasoning, providerOutput.captureDialect)
    if (ev.type === 'response.completed' || ev.type === 'response.failed') return
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

function encryptedReasoningEventFromResponsesItem(
  item: ResponsesInputItem,
  outputIndex: number,
  reasoning: AttemptResponsesReasoningContract,
): StreamLaneEvent | null {
  if (item.type !== 'reasoning' || typeof item.encrypted_content !== 'string') return null
  const itemId = typeof item.id === 'string' ? item.id : undefined
  return reasoningObservationEvent([
    {
      kind: 'carrier',
      carrierKind: 'responses-encrypted',
      update: 'set',
      value: item.encrypted_content,
      format: reasoning.targetFormat,
      source: {
        dialect: reasoning.originDialect,
        bridge: reasoning.producerBridge,
        outputIndex,
        ...(itemId ? { itemId } : {}),
      },
      groupAliases: responsesReasoningGroupAliases(itemId, outputIndex),
      memberAliases: responsesReasoningMemberAliases(itemId, outputIndex, 'encrypted'),
    },
  ])
}

function responsesReasoningGroupAliases(
  itemId: string | undefined,
  outputIndex: number,
): ReasoningObservation['groupAliases'] {
  return [
    { kind: 'responses-output', outputIndex },
    ...(itemId ? ([{ kind: 'responses-item', itemId }] as const) : []),
  ]
}

function responsesReasoningMemberAliases(
  itemId: string | undefined,
  outputIndex: number,
  member: Extract<ReasoningMemberAlias, { kind: 'responses-member' }>['member'],
): ReasoningMemberAlias[] {
  return [
    { kind: 'responses-member', outputIndex, member },
    ...(itemId ? ([{ kind: 'responses-member', outputIndex, itemId, member }] as const) : []),
  ]
}

function* splitResponsesEvent(
  ev: ResponsesEventWire,
  reasoning: AttemptResponsesReasoningContract,
  providerOutputDialect: 'openai-responses' | 'openrouter-responses',
): Generator<StreamLaneEvent> {
  // Forward-compat: unknown event types are dropped silently (don't crash).
  const t = (ev as { type?: unknown }).type
  if (typeof t !== 'string') return

  switch (t) {
    case 'response.created':
    case 'response.in_progress':
      return

    case 'response.output_item.added': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.output_item.added' }>
      yield {
        lane: 'output-item-added',
        dialect: providerOutputDialect,
        outputIndex: e.output_index,
        item: e.item,
      }
      const functionCall = toolCallEventFromResponsesItem(e.item, e.output_index, false)
      if (functionCall) yield functionCall
      // Auto-expand the reasoning lane when an encrypted reasoning item shows
      // up. We emit a reasoning event with the INITIAL encrypted_content so
      // UI shows a blob-sized hint immediately; `output_item.done` later
      // REPLACES the value with the final one.
      const encryptedReasoning = encryptedReasoningEventFromResponsesItem(
        e.item,
        e.output_index,
        reasoning,
      )
      if (encryptedReasoning) yield encryptedReasoning
      // Server-tool items get a `server-tool` event on add too.
      if (isKnownProviderToolOutputType(e.item.type)) {
        yield {
          lane: 'server-tool',
          itemType: e.item.type,
          status: 'in_progress',
          itemId: e.item.id ?? '',
          outputIndex: e.output_index,
        }
      }
      return
    }

    case 'response.output_item.done': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.output_item.done' }>
      yield {
        lane: 'output-item-done',
        dialect: providerOutputDialect,
        outputIndex: e.output_index,
        item: e.item,
      }
      const functionCall = toolCallEventFromResponsesItem(e.item, e.output_index, true)
      if (functionCall) yield functionCall
      // Reasoning item: emit the FINAL encrypted_content as a replacing
      // reasoning event so the accumulator overwrites the partial from
      // `added` (see §5 of phase11-implementation).
      const encryptedReasoning = encryptedReasoningEventFromResponsesItem(
        e.item,
        e.output_index,
        reasoning,
      )
      if (encryptedReasoning) yield encryptedReasoning
      // Phase metadata rides on message items. GPT-5.4 family REQUIRES
      // this field to round-trip verbatim.
      if (e.item.type === 'message' && e.item.phase !== undefined) {
        yield {
          lane: 'phase',
          phase: e.item.phase ?? null,
          outputIndex: e.output_index,
        }
      }
      yield* responsesTextAnnotationEvents(e.item, e.output_index)
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
      yield reasoningObservationEvent([
        {
          kind: 'visible',
          visibleKind: 'text',
          update: 'append',
          value: e.delta,
          format: reasoning.targetFormat,
          source: {
            dialect: reasoning.originDialect,
            bridge: reasoning.producerBridge,
            itemId: e.item_id,
            outputIndex: e.output_index,
          },
          groupAliases: responsesReasoningGroupAliases(e.item_id, e.output_index),
          memberAliases: responsesReasoningMemberAliases(e.item_id, e.output_index, 'text'),
        },
      ])
      return
    }

    case 'response.reasoning_summary_text.delta': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.reasoning_summary_text.delta' }>
      yield reasoningObservationEvent([
        {
          kind: 'visible',
          visibleKind: 'summary',
          update: 'append',
          value: e.delta,
          format: reasoning.targetFormat,
          source: {
            dialect: reasoning.originDialect,
            bridge: reasoning.producerBridge,
            itemId: e.item_id,
            outputIndex: e.output_index,
            summaryIndex: e.summary_index,
          },
          groupAliases: responsesReasoningGroupAliases(e.item_id, e.output_index),
          memberAliases: responsesReasoningMemberAliases(
            e.item_id,
            e.output_index,
            `summary:${e.summary_index}`,
          ),
        },
      ])
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
      yield projectResponsesResultSnapshot(e.response, undefined, reasoning, providerOutputDialect)
      return
    }

    case 'response.failed': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.failed' }>
      yield projectResponsesResultSnapshot(e.response, undefined, reasoning, providerOutputDialect)
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

    case 'response.content_part.added':
      return
    case 'response.content_part.done': {
      const e = ev as Extract<ResponsesEventWire, { type: 'response.content_part.done' }>
      yield* responsePartAnnotationEvents(e.part, e.output_index, e.content_index)
      return
    }
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
  reasoning: AttemptResponsesReasoningContract,
  providerOutputDialect: 'openai-responses' | 'openrouter-responses',
): Generator<StreamLaneEvent> {
  yield projectResponsesResultSnapshot(result, generationId, reasoning, providerOutputDialect)
}

function projectResponsesResultSnapshot(
  result: ResponsesResultWire,
  generationId: string | undefined,
  reasoning: AttemptResponsesReasoningContract,
  providerOutputDialect: 'openai-responses' | 'openrouter-responses',
): Extract<StreamLaneEvent, { lane: 'result-snapshot' }> {
  const issues: string[] = []
  const outcome = responsesResultOutcome(result)
  const payload =
    result.output === undefined
      ? ({ kind: 'retain' } as const)
      : projectResponsesResultPayload(result.output, reasoning, providerOutputDialect, issues)
  const effectiveGenerationId = generationId ?? result.id
  return {
    lane: 'result-snapshot',
    payload,
    outcome,
    ...(typeof result.model === 'string' ? { model: result.model } : {}),
    ...(effectiveGenerationId !== undefined ? { generationId: effectiveGenerationId } : {}),
    ...(result.usage ? { usage: normalizeResponsesUsage(result.usage) } : {}),
    ...(issues.length > 0 ? { integrity: [responsesResultIntegrity(issues)] } : {}),
  }
}

function projectResponsesResultPayload(
  output: readonly ResponsesInputItem[],
  reasoning: AttemptResponsesReasoningContract,
  providerOutputDialect: 'openai-responses' | 'openrouter-responses',
  issues: string[],
): Extract<Extract<StreamLaneEvent, { lane: 'result-snapshot' }>['payload'], { kind: 'replace' }> {
  const textParts: Array<{
    text: string
    outputIndex: number
    contentIndex: number
    annotations: ReturnType<typeof normalizeContentAnnotations>
  }> = []
  const reasoningObservations: ReasoningObservation[] = []
  const toolCalls: Array<{
    index: number
    id?: string
    type?: 'function'
    name?: string
    arguments: string
  }> = []
  const generatedContent: ContentItem[] = []
  const serverTools: GenerationServerToolCall[] = []
  const providerOutputItems: ProviderOutputItem[] = []
  const providerOutputIdentities = new Set<string>()
  let phase: MessagePhase | null = null

  for (const [outputIndex, item] of output.entries()) {
    if (item.type === 'message') {
      if (item.phase !== undefined) phase = item.phase ?? null
      for (const [contentIndex, rawPart] of (item.content ?? []).entries()) {
        if (!rawPart || typeof rawPart !== 'object') continue
        const part = rawPart as { type?: unknown; text?: unknown; annotations?: unknown }
        if (part.type !== 'output_text' || typeof part.text !== 'string') continue
        textParts.push({
          text: part.text,
          outputIndex,
          contentIndex,
          annotations: normalizeContentAnnotations(
            Array.isArray(part.annotations) ? part.annotations : [],
            { source: 'openai-responses', text: part.text },
          ),
        })
      }
    } else if (item.type === 'reasoning') {
      appendResponsesReasoningSnapshot(reasoningObservations, item, outputIndex, reasoning, issues)
    } else if (item.type === 'function_call') {
      toolCalls.push({
        index: outputIndex,
        ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}),
        type: 'function',
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
        arguments: typeof item.arguments === 'string' ? item.arguments : '',
      })
    }

    const contentItem = contentItemFromResponsesOutputItem(item)
    if (contentItem) generatedContent.push(contentItem)

    const providerItem = providerOutputItemFromResponsesItem(
      item,
      providerOutputDialect,
      outputIndex,
    )
    if (providerItem) {
      const identity = providerOutputItemIdentity(providerItem, providerOutputItems.length)
      if (!providerOutputIdentities.has(identity)) {
        providerOutputIdentities.add(identity)
        providerOutputItems.push(providerItem)
      }
      if (isKnownProviderToolOutputType(providerItem.type)) {
        serverTools.push({
          type: providerItem.type,
          source: 'responses-output',
          ...(typeof item.id === 'string' ? { id: item.id } : {}),
          ...(typeof item.status === 'string' ? { status: item.status } : {}),
          outputIndex,
        })
      }
    }
  }

  return {
    kind: 'replace',
    textParts,
    reasoning: {
      observations: reasoningObservations,
    },
    toolCalls,
    generatedContent,
    serverTools,
    providerOutputItems,
    phase,
  }
}

function appendResponsesReasoningSnapshot(
  target: ReasoningObservation[],
  item: ResponsesInputItem,
  outputIndex: number,
  reasoning: AttemptResponsesReasoningContract,
  issues: string[],
): void {
  const providerItemId = typeof item.id === 'string' ? item.id : undefined
  const itemFormat = responsesReasoningFormat(item.format, reasoning.targetFormat, issues)
  const source = {
    dialect: reasoning.originDialect,
    bridge: reasoning.producerBridge,
    outputIndex,
    ...(providerItemId ? { itemId: providerItemId } : {}),
  } as const
  if (typeof item.encrypted_content === 'string') {
    target.push({
      kind: 'carrier',
      carrierKind: 'responses-encrypted',
      update: 'set',
      value: item.encrypted_content,
      format: itemFormat,
      source,
      groupAliases: responsesReasoningGroupAliases(providerItemId, outputIndex),
      memberAliases: responsesReasoningMemberAliases(providerItemId, outputIndex, 'encrypted'),
    })
  }
  for (const [summaryIndex, rawSummary] of (item.summary ?? []).entries()) {
    if (!rawSummary || typeof rawSummary !== 'object') continue
    const summary = rawSummary as { text?: unknown; format?: unknown }
    if (typeof summary.text !== 'string') continue
    const format = responsesReasoningFormat(summary.format, itemFormat, issues)
    target.push({
      kind: 'visible',
      visibleKind: 'summary',
      update: 'set',
      value: summary.text,
      format,
      source: { ...source, summaryIndex },
      groupAliases: responsesReasoningGroupAliases(providerItemId, outputIndex),
      memberAliases: responsesReasoningMemberAliases(
        providerItemId,
        outputIndex,
        `summary:${summaryIndex}`,
      ),
    })
  }

  for (const [contentIndex, rawPart] of (item.content ?? []).entries()) {
    if (!rawPart || typeof rawPart !== 'object') continue
    const part = rawPart as { type?: unknown; text?: unknown; format?: unknown }
    if (part.type !== 'reasoning_text' || typeof part.text !== 'string') continue
    const format = responsesReasoningFormat(part.format, itemFormat, issues)
    target.push({
      kind: 'visible',
      visibleKind: 'text',
      update: 'set',
      value: (part as { text: string }).text,
      format,
      source: { ...source, contentIndex },
      groupAliases: responsesReasoningGroupAliases(providerItemId, outputIndex),
      memberAliases: responsesReasoningMemberAliases(
        providerItemId,
        outputIndex,
        `content:${contentIndex}`,
      ),
    })
  }

  const rawDetails = (item as { reasoning_details?: unknown }).reasoning_details
  if (Array.isArray(rawDetails)) {
    const decoded = decodeProviderReasoningDetails(
      rawDetails,
      itemFormat === 'unknown' ? null : itemFormat,
    )
    issues.push(...decoded.issues)
    if (decoded.details.length > 0) {
      target.push(
        ...reasoningObservationsFromDetails({
          details: decoded.details,
          mode: 'snapshot',
          dialect: reasoning.originDialect,
          bridge: reasoning.producerBridge,
          untypedVisibleKind: visibleKindForInboundReasoning(reasoning.inboundVisibility),
          source: {
            outputIndex,
            ...(providerItemId ? { itemId: providerItemId } : {}),
          },
        }),
      )
    }
  }
}

function responsesReasoningFormat(
  raw: unknown,
  fallback: ReasoningFormat,
  issues: string[],
): ReasoningFormat {
  if (raw === undefined) return fallback
  if (isReasoningFormat(raw)) return raw
  issues.push('responses-reasoning-format-unknown')
  return 'unknown'
}

function responsesResultOutcome(
  result: ResponsesResultWire,
): Extract<StreamLaneEvent, { lane: 'result-snapshot' }>['outcome'] {
  if (result.error || result.status === 'failed') {
    const errorPayload = result.error ?? { message: 'Responses API reported failure' }
    return {
      kind: 'error',
      error: normalizeError(
        { error: errorPayload },
        {
          midStream: true,
          ...(typeof errorPayload.code === 'number' ? { httpStatus: errorPayload.code } : {}),
        },
      ),
    }
  }
  return {
    kind: 'finish',
    finishReason:
      result.status === 'completed'
        ? 'stop'
        : result.status === 'incomplete'
          ? (result.incomplete_details?.reason ?? 'length')
          : (result.status ?? 'stop'),
  }
}

function responsesResultIntegrity(
  issues: readonly string[],
): Extract<StreamLaneEvent, { lane: 'integrity' }>['integrity'] {
  const value = issues.join('|')
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return {
    category: 'malformed-event-shape',
    adapter: 'responses',
    eventType: 'response.result',
    count: issues.length,
    fingerprint: `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`,
    characterCount: value.length,
  }
}

function* responsesTextAnnotationEvents(
  item: ResponsesInputItem,
  outputIndex: number,
): Generator<StreamLaneEvent> {
  if (item.type !== 'message') return
  for (const [contentIndex, part] of (item.content ?? []).entries()) {
    yield* responsePartAnnotationEvents(part, outputIndex, contentIndex)
  }
}

function* responsePartAnnotationEvents(
  value: unknown,
  outputIndex: number,
  contentIndex: number,
): Generator<StreamLaneEvent> {
  if (!value || typeof value !== 'object') return
  const part = value as { type?: unknown; text?: unknown; annotations?: unknown }
  if (part.type !== 'output_text' || typeof part.text !== 'string') return
  const annotations = normalizeContentAnnotations(
    Array.isArray(part.annotations) ? part.annotations : [],
    { source: 'openai-responses', text: part.text },
  )
  if (annotations.length === 0) return
  yield {
    lane: 'text-annotations',
    annotations,
    ownerTextLength: part.text.length,
    outputIndex,
    contentIndex,
  }
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
  textParts: string[]
}

export async function* splitAnthropicStream(
  source: AsyncIterable<AnthropicStreamChunk>,
  reasoning: AttemptAnthropicReasoningContract,
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: 'anthropic-claude' }>,
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
      yield* splitBufferedAnthropicResult(
        chunk.result,
        chunk.generationId,
        reasoning,
        providerOutput.captureDialect,
      )
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
        yield* emitAnthropicBlockStart(state, reasoning)
        break
      }

      case 'content_block_delta': {
        const e = ev as Extract<AnthropicEventWire, { type: 'content_block_delta' }>
        const state = blocks.get(e.index) ?? createAnthropicBlockState(e.index, { type: 'unknown' })
        blocks.set(e.index, state)
        yield* applyAnthropicBlockDelta(state, e.delta, reasoning)
        break
      }

      case 'content_block_stop': {
        const e = ev as Extract<AnthropicEventWire, { type: 'content_block_stop' }>
        const state = blocks.get(e.index)
        if (state) {
          yield* emitAnthropicBlockDone(state, reasoning, providerOutput.captureDialect)
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
    textParts: typeof block.text === 'string' ? [block.text] : [],
  }
}

function anthropicThinkingObservation(
  state: AnthropicBlockState,
  value: string,
  reasoning: AttemptAnthropicReasoningContract,
  update: 'append' | 'set' = 'append',
): Extract<ReasoningObservation, { kind: 'visible' }> {
  return {
    kind: 'visible',
    visibleKind: visibleKindForInboundReasoning(reasoning.inboundVisibility),
    update,
    value,
    format: reasoning.targetFormat,
    source: {
      dialect: 'anthropic-messages',
      bridge: reasoning.producerBridge,
      blockIndex: state.index,
      outputIndex: state.index,
    },
    groupAliases: [{ kind: 'anthropic-block', blockIndex: state.index }],
    memberAliases: [{ kind: 'anthropic-member', blockIndex: state.index, member: 'thinking' }],
  }
}

function anthropicSignatureObservation(
  state: AnthropicBlockState,
  value: string,
  reasoning: AttemptAnthropicReasoningContract,
  update: 'append' | 'set',
): Extract<ReasoningObservation, { kind: 'carrier' }> {
  const visible = anthropicThinkingObservation(state, '', reasoning)
  return {
    kind: 'carrier',
    carrierKind: 'anthropic-signature',
    update,
    value,
    format: reasoning.targetFormat,
    source: {
      dialect: 'anthropic-messages',
      bridge: reasoning.producerBridge,
      blockIndex: state.index,
      outputIndex: state.index,
    },
    groupAliases: [{ kind: 'anthropic-block', blockIndex: state.index }],
    memberAliases: [{ kind: 'anthropic-member', blockIndex: state.index, member: 'signature' }],
    binding: {
      visibleKind: visible.visibleKind,
      format: visible.format,
      source: visible.source,
      groupAliases: visible.groupAliases,
      memberAliases: visible.memberAliases,
    },
  }
}

function anthropicRedactedObservation(
  state: AnthropicBlockState,
  value: string,
  reasoning: AttemptAnthropicReasoningContract,
): Extract<ReasoningObservation, { kind: 'carrier' }> {
  return {
    kind: 'carrier',
    carrierKind: 'anthropic-redacted',
    update: 'set',
    value,
    format: reasoning.targetFormat,
    source: {
      dialect: 'anthropic-messages',
      bridge: reasoning.producerBridge,
      blockIndex: state.index,
      outputIndex: state.index,
    },
    groupAliases: [{ kind: 'anthropic-block', blockIndex: state.index }],
    memberAliases: [{ kind: 'anthropic-member', blockIndex: state.index, member: 'redacted' }],
  }
}

function* emitAnthropicBlockStart(
  state: AnthropicBlockState,
  reasoning: AttemptAnthropicReasoningContract,
): Generator<StreamLaneEvent> {
  const type = state.block.type
  const initialText = typeof state.block.text === 'string' ? state.block.text : ''
  const initialThinking = typeof state.block.thinking === 'string' ? state.block.thinking : ''
  if (type === 'text' && initialText.length > 0) {
    yield { lane: 'text', text: initialText, outputIndex: state.index, contentIndex: state.index }
  } else if (type === 'thinking') {
    const observations: ReasoningObservation[] = []
    if (initialThinking.length > 0) {
      observations.push(anthropicThinkingObservation(state, initialThinking, reasoning))
    }
    const signature = state.signatureParts.join('')
    if (signature.length > 0) {
      observations.push(anthropicSignatureObservation(state, signature, reasoning, 'set'))
    }
    if (observations.length > 0) yield reasoningObservationEvent(observations)
  } else if (type === 'redacted_thinking' && typeof state.block.data === 'string') {
    yield reasoningObservationEvent([
      anthropicRedactedObservation(state, state.block.data, reasoning),
    ])
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
  reasoning: AttemptAnthropicReasoningContract,
): Generator<StreamLaneEvent> {
  const deltaType = delta.type
  if (deltaType === 'text_delta' && typeof delta.text === 'string') {
    state.textParts.push(delta.text)
    yield { lane: 'text', text: delta.text, outputIndex: state.index, contentIndex: state.index }
    return
  }
  if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
    yield reasoningObservationEvent([
      anthropicThinkingObservation(state, delta.thinking, reasoning),
    ])
    return
  }
  if (deltaType === 'signature_delta' && typeof delta.signature === 'string') {
    state.signatureParts.push(delta.signature)
    yield reasoningObservationEvent([
      anthropicSignatureObservation(state, delta.signature, reasoning, 'append'),
    ])
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

function* emitAnthropicBlockDone(
  state: AnthropicBlockState,
  reasoning: AttemptAnthropicReasoningContract,
  providerOutputDialect: 'anthropic-claude',
): Generator<StreamLaneEvent> {
  const type = state.block.type
  if (type === 'text') {
    const text = state.textParts.join('')
    const annotations = normalizeContentAnnotations(state.citations, {
      source: 'anthropic-messages',
      text,
    })
    if (annotations.length > 0) {
      yield {
        lane: 'text-annotations',
        annotations,
        ownerTextLength: text.length,
        outputIndex: state.index,
        contentIndex: state.index,
      }
    }
    return
  }
  if (type === 'thinking') {
    const signature = state.signatureParts.join('')
    if (signature.length > 0) {
      yield reasoningObservationEvent([
        anthropicSignatureObservation(state, signature, reasoning, 'set'),
      ])
    }
    return
  }
  if (type === 'redacted_thinking' && typeof state.block.data === 'string') {
    yield reasoningObservationEvent([
      anthropicRedactedObservation(state, state.block.data, reasoning),
    ])
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
    dialect: providerOutputDialect,
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
  reasoning: AttemptAnthropicReasoningContract,
  providerOutputDialect: 'anthropic-claude',
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
  for (const [index, block] of (result.content ?? []).entries()) {
    const state = createAnthropicBlockState(index, block)
    yield* emitAnthropicBlockStart(state, reasoning)
    yield* emitAnthropicBlockDone(state, reasoning, providerOutputDialect)
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
// Each provider part keeps its candidate/frame/part coordinates. Visible
// thought summaries and opaque thought signatures share a group without
// changing one another's display classification.

export async function* splitGeminiStream(
  source: AsyncIterable<GeminiStreamChunk>,
  reasoning: AttemptGeminiReasoningContract,
  providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: 'google-gemini' }>,
): AsyncGenerator<StreamLaneEvent> {
  let metaEmittedModel: string | undefined
  let metaEmittedGenerationId: string | undefined
  const counter = { frame: 0, toolCalls: 0 }
  const textByOutputIndex = new Map<number, string>()

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
      const frameIndex = counter.frame
      counter.frame += 1
      for (const ev of splitGeminiResponse(
        chunk.result,
        counter,
        frameIndex,
        textByOutputIndex,
        reasoning,
        providerOutput.captureDialect,
      )) {
        yield ev
      }
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
    const frameIndex = counter.frame
    counter.frame += 1
    for (const ev of splitGeminiResponse(
      resp,
      counter,
      frameIndex,
      textByOutputIndex,
      reasoning,
      providerOutput.captureDialect,
    )) {
      yield ev
    }
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

// One Gemini response body → lane events for every candidate and part.
function* splitGeminiResponse(
  resp: GenerateContentResponseWire,
  counter: { frame: number; toolCalls: number },
  frameIndex: number,
  textByOutputIndex: Map<number, string>,
  reasoning: AttemptGeminiReasoningContract,
  providerOutputDialect: 'google-gemini',
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
  for (const [candidateOrdinal, candidate] of (resp.candidates ?? []).entries()) {
    const content: GeminiContent = candidate.content
    const parts: GeminiPart[] = content.parts
    const outputIndex = candidate.index ?? candidateOrdinal

    for (const [contentIndex, part] of parts.entries()) {
      if ('text' in part && typeof part.text === 'string' && part.thought !== true) {
        textByOutputIndex.set(
          outputIndex,
          `${textByOutputIndex.get(outputIndex) ?? ''}${part.text}`,
        )
      }
      yield* splitGeminiPart(
        part,
        counter,
        outputIndex,
        frameIndex,
        contentIndex,
        reasoning,
        providerOutputDialect,
      )
    }
    yield* splitGeminiProviderToolMetadata(
      resp,
      candidate,
      outputIndex,
      textByOutputIndex.get(outputIndex) ?? '',
      providerOutputDialect,
    )

    if (candidate.finishReason) {
      yield { lane: 'finish', finishReason: mapGeminiFinishReason(candidate.finishReason) }
    }
  }

  if (resp.usageMetadata) {
    yield {
      lane: 'usage',
      usage: remapGeminiUsage(resp.usageMetadata),
    }
  }
}

function* splitGeminiProviderToolMetadata(
  resp: GenerateContentResponseWire,
  candidate: Record<string, unknown> | undefined,
  outputIndex: number,
  text: string,
  providerOutputDialect: 'google-gemini',
): Generator<StreamLaneEvent> {
  const record = resp as Record<string, unknown>
  const groundingMetadata = candidate?.groundingMetadata ?? record.groundingMetadata
  if (groundingMetadata !== undefined) {
    yield {
      lane: 'server-tool-output',
      dialect: providerOutputDialect,
      itemType: 'google:google_search',
      itemId: `google-search-${outputIndex}`,
      outputIndex,
      status: 'completed',
      output: structuredClone(groundingMetadata),
    }
    const annotations = normalizeGeminiGroundingAnnotations(groundingMetadata, text)
    if (annotations.length > 0) {
      yield {
        lane: 'text-annotations',
        annotations,
        ownerTextLength: text.length,
        outputIndex,
      }
    }
  }
  const urlContextMetadata = candidate?.urlContextMetadata ?? record.urlContextMetadata
  if (urlContextMetadata !== undefined) {
    yield {
      lane: 'server-tool-output',
      dialect: providerOutputDialect,
      itemType: 'google:url_context',
      itemId: `google-url-context-${outputIndex}`,
      outputIndex,
      status: 'completed',
      output: structuredClone(urlContextMetadata),
    }
  }
  const googleMapsMetadata = candidate?.googleMapsMetadata ?? record.googleMapsMetadata
  if (googleMapsMetadata !== undefined) {
    yield {
      lane: 'server-tool-output',
      dialect: providerOutputDialect,
      itemType: 'google:google_maps',
      itemId: `google-maps-${outputIndex}`,
      outputIndex,
      status: 'completed',
      output: structuredClone(googleMapsMetadata),
    }
  }
}

function* splitGeminiPart(
  part: GeminiPart,
  counter: { frame: number; toolCalls: number },
  outputIndex: number,
  frameIndex: number,
  contentIndex: number,
  reasoning: AttemptGeminiReasoningContract,
  providerOutputDialect: 'google-gemini',
): Generator<StreamLaneEvent> {
  const source = {
    dialect: 'gemini-native' as const,
    bridge: reasoning.producerBridge,
    candidateIndex: outputIndex,
    frameIndex,
    partIndex: contentIndex,
  }
  const groupAliases = [
    {
      kind: 'gemini-part' as const,
      candidateIndex: outputIndex,
      frameIndex,
      partIndex: contentIndex,
    },
  ]
  const observations: ReasoningObservation[] = []
  const isThoughtText = 'text' in part && typeof part.text === 'string' && part.thought === true
  const visible = isThoughtText
    ? {
        kind: 'visible' as const,
        visibleKind: 'summary' as const,
        update: 'set' as const,
        value: (part as { text: string }).text,
        format: reasoning.targetFormat,
        source,
        groupAliases,
        memberAliases: [
          {
            kind: 'gemini-member' as const,
            candidateIndex: outputIndex,
            frameIndex,
            partIndex: contentIndex,
            member: 'summary' as const,
          },
        ],
      }
    : undefined
  if (visible) observations.push(visible)
  const sig = (part as { thoughtSignature?: string }).thoughtSignature
  if (typeof sig === 'string' && sig.length > 0) {
    observations.push({
      kind: 'carrier',
      carrierKind: 'gemini-thought-signature',
      update: 'set',
      value: sig,
      format: reasoning.targetFormat,
      source,
      groupAliases,
      memberAliases: [
        {
          kind: 'gemini-member',
          candidateIndex: outputIndex,
          frameIndex,
          partIndex: contentIndex,
          member: 'signature',
        },
      ],
      ...(visible
        ? {
            binding: {
              visibleKind: visible.visibleKind,
              format: visible.format,
              source: visible.source,
              groupAliases: visible.groupAliases,
              memberAliases: visible.memberAliases,
            },
          }
        : {}),
    })
  }
  if (observations.length > 0) yield reasoningObservationEvent(observations)

  if ('text' in part && typeof part.text === 'string') {
    if (part.text.length === 0 || part.thought === true) return
    yield { lane: 'text', text: part.text, outputIndex, contentIndex }
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
      dialect: providerOutputDialect,
      itemType: 'google:code_execution',
      itemId: 'google-code-executable',
      outputIndex: 0,
      status: 'in_progress',
      output: part,
    }
    return
  }

  if ('codeExecutionResult' in part) {
    yield {
      lane: 'server-tool-output',
      dialect: providerOutputDialect,
      itemType: 'google:code_execution',
      itemId: 'google-code-result',
      outputIndex: 0,
      status: 'completed',
      output: part,
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

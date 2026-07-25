import { sameValue } from '../lib/same-value'
import { createAppliedMessageView } from './continuation-content'
import type {
  CanonicalStreamEventV2,
  GenerationStreamFailureV2,
  GenerationStreamIntegrityV2,
  ResultSnapshotReplacementV2,
} from './generation-stream-events'
import type { StreamLaneEvent } from './generation-stream-live-events'
import {
  isKnownProviderToolOutputType,
  providerOutputItemFromGeminiPart,
  providerOutputItemFromResponsesItem,
  providerOutputItemIdentity,
} from './provider-tool-context'
import {
  inspectReasoningEnvelopeState,
  projectReasoningEnvelope,
  projectReasoningEnvelopeLive,
  type ReasoningEnvelopeLiveProjection,
  reasoningEnvelopeIsEmpty,
} from './reasoning-envelope'
import {
  applyCanonicalReasoningMutation,
  applyReasoningObservationBatch,
  createReasoningObservationCodecState,
  type ReasoningObservationCodecState,
  releaseReasoningObservationCodecState,
} from './reasoning-observation'
import type {
  AttemptIntegritySummary,
  ChatUsage,
  ContentAnnotation,
  ContentItem,
  FinishReason,
  GenerationMeta,
  GenerationServerToolCall,
  Message,
  MessagePhase,
  ProviderOutputItem,
  ReasoningEnvelopeV2,
  ToolCall,
} from './types'

export const STREAM_LIVE_UPDATE_INTERVAL_MS = 125
export const STREAM_DURABLE_BATCH_TEXT_CHARS = 128 * 1024
const STREAM_LIVE_TEXT_SECTION_CHARS = 20_000
const STREAM_INTEGRITY_ENTRY_LIMIT = 16

export interface StreamAccumulator {
  initialContent: ContentItem[]
  initialTextPrefix: string
  initialNonTextContent: ContentItem[]
  initialAnnotations: ContentAnnotation[]
  textSections: string[]
  textPendingParts: string[]
  textPendingLength: number
  textLength: number
  textSpansByWirePart: Map<string, { start: number; length: number }>
  annotations: ContentAnnotation[]
  annotationIdentities: Set<string>
  reasoning: ReasoningObservationCodecState
  toolCallRows: ToolCallAccumulatorRow[]
  toolCallRowByIndex: Map<number, number>
  toolCallRowById: Map<string, number>
  toolCallArgumentsByRow: Map<number, ToolCallArgumentBuffer>
  toolCallArgumentsLength: number
  generationId?: string
  model?: string
  provider?: string
  phase?: MessagePhase
  finishReason?: string
  usage?: ChatUsage
  generatedContent: ContentItem[]
  audioOutput?: {
    chunks: string[]
    transcriptSections: string[]
    transcriptPendingParts: string[]
    transcriptPendingLength: number
    transcriptLength: number
    format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
  }
  serverTools: GenerationServerToolCall[]
  serverToolRowByKey: Map<string, number>
  serverToolsRevision: number
  serverToolsProjectionRevision: number
  serverToolsProjection: GenerationServerToolCall[]
  providerOutputItems: ProviderOutputItem[]
  providerOutputRowByKey: Map<string, number>
  firstTextAt?: number
  reasoningStartedAt?: number
  reasoningFinishedAt?: number
  dirtySinceLastLivePublish: boolean
  liveMutationRevision: number
  lastLivePublishedAt: number
  lastLivePublishedTextLen: number
  lastLivePublishedReasoningLen: number
  lastLivePublishedToolCallArgumentsLen: number
  midStreamError?: GenerationStreamFailureV2
  integritySummary: AttemptIntegritySummary
}

export interface StreamAccumulatorLiveProjection {
  content: ContentItem[]
  reasoning?: ReasoningEnvelopeLiveProjection
  toolCallRows?: StreamAccumulatorLiveToolCallRow[]
  generation: GenerationMeta
  textLength: number
  reasoningLength: number
  updatedAt: number
}

export interface StreamAccumulatorLiveAttemptArtifacts {
  reasoning?: ReasoningEnvelopeLiveProjection
  toolCallRows?: StreamAccumulatorLiveToolCallRow[]
  reasoningLength: number
}

export interface StreamAccumulatorLiveToolCallRow {
  index: number
  id?: string
  type?: 'function'
  name?: string
  argumentSections: readonly string[]
  pendingArguments?: string
  argumentLength: number
}

export interface StreamAccumulatorFinalProjection {
  content: ContentItem[]
  reasoningEnvelope?: ReasoningEnvelopeV2
  toolCalls?: ToolCall[]
  phase?: MessagePhase
  providerOutputItems?: ProviderOutputItem[]
}

export type StreamAccumulatorFinalMetadataProjection = Omit<
  StreamAccumulatorFinalProjection,
  'content'
>

export interface StreamAccumulatorReplayEntry {
  event: CanonicalStreamEventV2
  createdAt: number
}

export interface StreamAccumulatorReplayResult {
  accumulator: StreamAccumulator
  final: StreamAccumulatorFinalProjection
  finishedCleanly: boolean
}

interface ToolCallAccumulatorRow {
  index: number
  id?: string
  type?: 'function'
  name?: string
}

interface ToolCallArgumentBuffer {
  sections: string[]
  pendingParts: string[]
  pendingLength: number
  length: number
}

export function createStreamAccumulator(input: {
  initialContent: ContentItem[]
  now: number
}): StreamAccumulator {
  const initialTextPrefix = input.initialContent
    .filter(
      (item): item is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
        item.type === 'text' || item.type === 'output_text',
    )
    .map((item) => item.text)
    .join('')
  const initialNonTextContent = input.initialContent.filter(
    (item) => item.type !== 'text' && item.type !== 'output_text',
  )
  const initialAnnotations = collectInitialContentAnnotations(input.initialContent)
  return {
    initialContent: input.initialContent,
    initialTextPrefix,
    initialNonTextContent,
    initialAnnotations,
    textSections: [],
    textPendingParts: [],
    textPendingLength: 0,
    textLength: 0,
    textSpansByWirePart: new Map(),
    annotations: initialAnnotations,
    annotationIdentities: new Set(initialAnnotations.map(streamAnnotationIdentity)),
    reasoning: createReasoningObservationCodecState(),
    toolCallRows: [],
    toolCallRowByIndex: new Map(),
    toolCallRowById: new Map(),
    toolCallArgumentsByRow: new Map(),
    toolCallArgumentsLength: 0,
    generatedContent: [],
    serverTools: [],
    serverToolRowByKey: new Map(),
    serverToolsRevision: 0,
    serverToolsProjectionRevision: -1,
    serverToolsProjection: [],
    providerOutputItems: [],
    providerOutputRowByKey: new Map(),
    integritySummary: { count: 0, characterCount: 0, entries: [] },
    dirtySinceLastLivePublish: false,
    liveMutationRevision: 0,
    lastLivePublishedAt: input.now,
    lastLivePublishedTextLen: 0,
    lastLivePublishedReasoningLen: 0,
    lastLivePublishedToolCallArgumentsLen: 0,
  }
}

export function foldStreamAccumulatorEvent(
  acc: StreamAccumulator,
  event: StreamLaneEvent,
  nowMs: number,
): CanonicalStreamEventV2 {
  if (event.lane === 'reasoning-observation') {
    const mutations = applyReasoningObservationBatch(acc.reasoning, event.batch)
    if (mutations.length > 0) noteReasoningMutation(acc, nowMs)
    return { lane: 'reasoning', mutations, observed: { firstAt: nowMs, lastAt: nowMs } }
  }
  if (event.lane === 'result-snapshot' && event.payload.kind === 'replace') {
    const mutations = applyReasoningObservationBatch(acc.reasoning, event.payload.reasoning)
    if (mutations.length > 0) noteReasoningMutation(acc, nowMs)
    const { reasoning: _reasoning, ...payload } = event.payload
    const canonical: CanonicalStreamEventV2 = {
      ...event,
      payload: {
        ...payload,
        reasoningEnvelope: projectReasoningEnvelope(acc.reasoning.envelope),
      },
    }
    applyStreamAccumulatorEvent(acc, canonical, nowMs)
    return canonical
  }
  if (event.lane === 'result-snapshot') {
    const canonical: CanonicalStreamEventV2 = {
      ...event,
      payload: { kind: 'retain' },
    }
    applyStreamAccumulatorEvent(acc, canonical, nowMs)
    return canonical
  }
  applyStreamAccumulatorEvent(acc, event, nowMs)
  return event
}

export function applyStreamAccumulatorEvent(
  acc: StreamAccumulator,
  event: CanonicalStreamEventV2,
  nowMs: number,
): void {
  switch (event.lane) {
    case 'text':
      if (acc.firstTextAt === undefined) acc.firstTextAt = nowMs
      recordTextSpan(acc, event)
      appendStreamText(acc, event.text)
      markLiveProjectionDirty(acc)
      return
    case 'text-annotations':
      if (putTextAnnotations(acc, event)) markLiveProjectionDirty(acc)
      return
    case 'reasoning': {
      for (const mutation of event.mutations) {
        applyCanonicalReasoningMutation(acc.reasoning, mutation)
      }
      noteReasoningMutation(acc, event.observed?.firstAt ?? nowMs, event.observed?.lastAt ?? nowMs)
      return
    }
    case 'tool-call':
      putToolCallEvent(acc, event)
      markLiveProjectionDirty(acc)
      return
    case 'usage':
      acc.usage = event.usage as ChatUsage
      acc.serverToolsRevision += 1
      return
    case 'finish':
      acc.finishReason = event.finishReason
      return
    case 'meta':
      if (event.generationId) acc.generationId = event.generationId
      if (event.model) acc.model = event.model
      if (event.provider) acc.provider = event.provider
      return
    case 'content-item':
      acc.generatedContent.push(structuredClone(event.item))
      markLiveProjectionDirty(acc)
      return
    case 'audio-output':
      if (!acc.audioOutput) {
        acc.audioOutput = {
          chunks: [],
          transcriptSections: [],
          transcriptPendingParts: [],
          transcriptPendingLength: 0,
          transcriptLength: 0,
          format: event.format ?? 'pcm16',
        }
      }
      if (event.format) acc.audioOutput.format = event.format
      if (event.dataDelta) acc.audioOutput.chunks.push(event.dataDelta)
      if (event.transcriptDelta) {
        acc.audioOutput.transcriptPendingLength = appendTextToSections(
          acc.audioOutput.transcriptSections,
          acc.audioOutput.transcriptPendingParts,
          acc.audioOutput.transcriptPendingLength,
          event.transcriptDelta,
        )
        acc.audioOutput.transcriptLength += event.transcriptDelta.length
      }
      markLiveProjectionDirty(acc)
      return
    case 'server-tool':
      recordServerToolStatus(acc, event)
      return
    case 'server-tool-output':
      putServerTool(acc, {
        type: event.itemType,
        source: 'provider-output',
        id: event.itemId,
        ...(event.status ? { status: event.status } : {}),
        outputIndex: event.outputIndex,
      })
      recordProviderOutputItem(
        acc,
        event.dialect,
        event.itemType,
        event.itemId,
        event.output,
        event.outputIndex,
      )
      return
    case 'output-item-added':
      recordServerToolOutputItem(acc, event.item, event.outputIndex, 'stream-status')
      return
    case 'output-item-done':
      recordServerToolOutputItem(acc, event.item, event.outputIndex, 'responses-output')
      recordResponsesOutputItem(acc, event.dialect, event.item, event.outputIndex)
      return
    case 'phase':
      if (event.phase === null) delete acc.phase
      else acc.phase = event.phase
      return
    case 'result-snapshot':
      applyResultSnapshot(acc, event, nowMs)
      return
    case 'integrity':
      recordStreamIntegrity(acc.integritySummary, event.integrity)
      return
    case 'error':
      acc.midStreamError = event.error
      return
    case 'keepalive':
    case 'terminal':
      return
  }
}

function noteReasoningMutation(acc: StreamAccumulator, firstAt: number, lastAt = firstAt): void {
  if (acc.reasoningStartedAt === undefined) acc.reasoningStartedAt = firstAt
  acc.reasoningFinishedAt = lastAt
  markLiveProjectionDirty(acc)
}

export function shouldPublishStreamAccumulatorLive(acc: StreamAccumulator, nowMs: number): boolean {
  if (!acc.dirtySinceLastLivePublish) return false
  const reasoningLength = streamAccumulatorReasoningLength(acc)
  if (
    acc.lastLivePublishedTextLen === 0 &&
    acc.lastLivePublishedReasoningLen === 0 &&
    acc.lastLivePublishedToolCallArgumentsLen === 0 &&
    (acc.textLength > 0 || reasoningLength > 0 || acc.toolCallRows.length > 0)
  ) {
    return true
  }
  if (nowMs - acc.lastLivePublishedAt >= STREAM_LIVE_UPDATE_INTERVAL_MS) return true
  if (acc.textLength - acc.lastLivePublishedTextLen >= STREAM_DURABLE_BATCH_TEXT_CHARS) return true
  if (reasoningLength - acc.lastLivePublishedReasoningLen >= STREAM_DURABLE_BATCH_TEXT_CHARS) {
    return true
  }
  if (
    acc.toolCallArgumentsLength - acc.lastLivePublishedToolCallArgumentsLen >=
    STREAM_DURABLE_BATCH_TEXT_CHARS
  ) {
    return true
  }
  return false
}

export function projectStreamAccumulatorLive(
  acc: StreamAccumulator,
  input: {
    requestedModel: string
    apiUsed: GenerationMeta['apiUsed']
    now: number
    generationStartedAt?: number
    reasoningCarryForward?: GenerationMeta['reasoningCarryForward']
    reasoningVisibility?: GenerationMeta['reasoningVisibility']
  },
): StreamAccumulatorLiveProjection {
  const artifacts = projectStreamAccumulatorLiveAttemptArtifacts(acc)
  return {
    content: projectStreamAccumulatorLiveContent(acc),
    ...artifacts,
    generation: projectStreamGeneration(undefined, acc, input.requestedModel, {
      apiUsed: input.apiUsed,
      ...(input.generationStartedAt !== undefined ? { startedAt: input.generationStartedAt } : {}),
      ...(input.reasoningCarryForward !== undefined
        ? { reasoningCarryForward: input.reasoningCarryForward }
        : {}),
      ...(input.reasoningVisibility !== undefined
        ? { reasoningVisibility: input.reasoningVisibility }
        : {}),
    }),
    textLength: acc.textLength,
    updatedAt: input.now,
  }
}

export function projectStreamAccumulatorLiveAttemptArtifacts(
  acc: StreamAccumulator,
): StreamAccumulatorLiveAttemptArtifacts {
  const reasoning = projectReasoningEnvelopeLive(acc.reasoning.envelope)
  const toolCallRows = collectLiveToolCallRows(acc)
  return {
    ...(reasoning.visible.length > 0 || reasoning.carriers.length > 0 ? { reasoning } : {}),
    ...(toolCallRows.length > 0 ? { toolCallRows } : {}),
    reasoningLength: streamAccumulatorReasoningLength(acc),
  }
}

export function markStreamAccumulatorPublished(
  acc: StreamAccumulator,
  nowMs: number,
  expectedRevision = acc.liveMutationRevision,
): void {
  if (acc.liveMutationRevision !== expectedRevision) return
  acc.lastLivePublishedAt = nowMs
  acc.lastLivePublishedTextLen = acc.textLength
  acc.lastLivePublishedReasoningLen = streamAccumulatorReasoningLength(acc)
  acc.lastLivePublishedToolCallArgumentsLen = acc.toolCallArgumentsLength
  acc.dirtySinceLastLivePublish = false
}

function markLiveProjectionDirty(acc: StreamAccumulator): void {
  acc.dirtySinceLastLivePublish = true
  acc.liveMutationRevision += 1
}

export function projectStreamAccumulatorFinal(
  acc: StreamAccumulator,
): StreamAccumulatorFinalProjection {
  const metadata = projectStreamAccumulatorFinalMetadata(acc)
  return {
    content: assistantContentWithStreamPrefix(
      acc.initialTextPrefix,
      acc.initialNonTextContent,
      streamAccumulatorText(acc),
      [...acc.generatedContent, ...audioOutputContent(acc)],
      acc.annotations,
    ),
    ...metadata,
  }
}

export function projectStreamAccumulatorFinalMetadata(
  acc: StreamAccumulator,
): StreamAccumulatorFinalMetadataProjection {
  const reasoningEnvelope = projectReasoningEnvelope(acc.reasoning.envelope)
  const toolCalls = collectToolCalls(acc)
  const providerOutputItems = [
    ...acc.providerOutputItems,
    ...collectIncompleteToolCallOutputItems(acc),
  ]
  return {
    ...(!reasoningEnvelopeIsEmpty(reasoningEnvelope) ? { reasoningEnvelope } : {}),
    ...(toolCalls.length > 0 ? { toolCalls: structuredClone(toolCalls) } : {}),
    ...(acc.phase !== undefined ? { phase: acc.phase } : {}),
    ...(providerOutputItems.length > 0
      ? { providerOutputItems: structuredClone(providerOutputItems) }
      : {}),
  }
}

export function projectStreamGeneration(
  existing: GenerationMeta | undefined,
  acc: StreamAccumulator,
  requestedModel: string,
  opts: {
    apiUsed?: GenerationMeta['apiUsed']
    finishedAt?: number
    startedAt?: number
    reasoningCarryForward?: GenerationMeta['reasoningCarryForward']
    reasoningVisibility?: GenerationMeta['reasoningVisibility']
  } = {},
): GenerationMeta {
  const base: GenerationMeta = existing
    ? { ...existing }
    : {
        id: '',
        model: requestedModel,
        requestedModel,
        apiUsed: 'chat',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: opts.startedAt ?? Date.now(),
        reasoningCarryForward: opts.reasoningCarryForward ?? 'none',
        reasoningVisibility: opts.reasoningVisibility ?? { disclosure: 'unknown' },
      }
  if (opts.apiUsed !== undefined) base.apiUsed = opts.apiUsed
  if (opts.reasoningCarryForward !== undefined) {
    base.reasoningCarryForward = opts.reasoningCarryForward
  }
  if (opts.reasoningVisibility !== undefined) {
    base.reasoningVisibility = opts.reasoningVisibility
  }
  if (acc.generationId) base.id = acc.generationId
  if (acc.model) base.model = acc.model
  if (acc.provider) base.provider = acc.provider
  if (acc.usage) base.usage = acc.usage
  if (acc.usage?.cost !== undefined) base.cost = acc.usage.cost
  const serverTools = projectServerTools(acc)
  if (serverTools.length > 0) base.serverTools = serverTools
  else delete base.serverTools
  if (acc.firstTextAt !== undefined) base.firstTextAt = acc.firstTextAt
  if (acc.reasoningStartedAt !== undefined) base.reasoningStartedAt = acc.reasoningStartedAt
  if (acc.reasoningFinishedAt !== undefined) base.reasoningFinishedAt = acc.reasoningFinishedAt
  if (acc.finishReason) base.finishReason = acc.finishReason as FinishReason
  base.integrity = acc.integritySummary.count > 0 ? 'degraded' : 'clean'
  if (acc.integritySummary.count > 0) {
    base.integritySummary = structuredClone(acc.integritySummary)
  } else {
    delete base.integritySummary
  }
  if (opts.finishedAt !== undefined) {
    base.finishedAt = opts.finishedAt
  } else {
    base.status = 'streaming'
  }
  return base
}

export function replayStreamAccumulator(input: {
  initialContent: readonly ContentItem[]
  now: number
  entries: readonly StreamAccumulatorReplayEntry[]
}): StreamAccumulatorReplayResult {
  const replayed = replayStreamAccumulatorState(input)
  return {
    ...replayed,
    final: projectStreamAccumulatorFinal(replayed.accumulator),
  }
}

export function replayStreamAccumulatorState(input: {
  initialContent: readonly ContentItem[]
  now: number
  entries: readonly StreamAccumulatorReplayEntry[]
}): Pick<StreamAccumulatorReplayResult, 'accumulator' | 'finishedCleanly'> {
  const accumulator = createStreamAccumulator({
    initialContent: structuredClone([...input.initialContent]),
    now: input.now,
  })
  let finishedCleanly = false
  for (const entry of input.entries) {
    if (applyStreamAccumulatorReplayEntry(accumulator, entry)) finishedCleanly = true
  }
  return {
    accumulator,
    finishedCleanly,
  }
}

export function applyStreamAccumulatorReplayEntry(
  accumulator: StreamAccumulator,
  entry: StreamAccumulatorReplayEntry,
): boolean {
  const event = entry.event
  applyStreamAccumulatorEvent(accumulator, event, entry.createdAt)
  return (
    event.lane === 'finish' ||
    event.lane === 'terminal' ||
    (event.lane === 'result-snapshot' && event.outcome.kind === 'finish')
  )
}

export function releaseStreamAccumulatorBuffers(acc: StreamAccumulator): void {
  acc.initialContent = []
  acc.initialTextPrefix = ''
  acc.initialNonTextContent = []
  acc.initialAnnotations = []
  acc.textSections = []
  acc.textPendingParts = []
  acc.textPendingLength = 0
  acc.textLength = 0
  acc.textSpansByWirePart.clear()
  acc.annotations = []
  acc.annotationIdentities.clear()
  releaseReasoningObservationCodecState(acc.reasoning)
  acc.toolCallRows = []
  acc.toolCallRowByIndex.clear()
  acc.toolCallRowById.clear()
  acc.toolCallArgumentsByRow.clear()
  acc.toolCallArgumentsLength = 0
  acc.generatedContent = []
  acc.serverTools = []
  acc.serverToolRowByKey.clear()
  acc.serverToolsRevision += 1
  acc.serverToolsProjectionRevision = -1
  acc.serverToolsProjection = []
  acc.providerOutputItems = []
  acc.providerOutputRowByKey.clear()
  acc.integritySummary = { count: 0, characterCount: 0, entries: [] }
  delete acc.audioOutput
}

function applyResultSnapshot(
  acc: StreamAccumulator,
  event: Extract<CanonicalStreamEventV2, { lane: 'result-snapshot' }>,
  nowMs: number,
): void {
  if (event.generationId !== undefined) acc.generationId = event.generationId
  if (event.model !== undefined) acc.model = event.model
  if (event.usage !== undefined) acc.usage = event.usage as ChatUsage
  for (const integrity of event.integrity ?? []) {
    recordStreamIntegrity(acc.integritySummary, integrity)
  }
  if (event.payload.kind === 'replace') {
    const changed = resultSnapshotChangesAccumulator(acc, event.payload)
    replaceAccumulatorPayload(acc, event.payload, nowMs)
    if (changed) markLiveProjectionDirty(acc)
  }
  if (event.outcome.kind === 'finish') {
    acc.finishReason = event.outcome.finishReason
    delete acc.midStreamError
  } else {
    delete acc.finishReason
    acc.midStreamError = event.outcome.error
  }
}

function resultSnapshotChangesAccumulator(
  acc: StreamAccumulator,
  snapshot: ResultSnapshotReplacementV2,
): boolean {
  const snapshotText = snapshot.textParts.map((part) => part.text).join('')
  const snapshotAnnotations = resultSnapshotAnnotations(
    acc.initialAnnotations,
    acc.initialTextPrefix.length,
    snapshot.textParts,
  )
  return (
    streamAccumulatorText(acc) !== snapshotText ||
    !sameValue(acc.annotations, snapshotAnnotations) ||
    !sameValue(projectReasoningEnvelope(acc.reasoning.envelope), snapshot.reasoningEnvelope) ||
    !sameValue(collectSnapshotToolCalls(acc), snapshot.toolCalls) ||
    !sameValue(acc.generatedContent, snapshot.generatedContent) ||
    !sameValue(acc.serverTools, snapshot.serverTools) ||
    !sameValue(acc.providerOutputItems, snapshot.providerOutputItems) ||
    acc.audioOutput !== undefined ||
    (acc.phase ?? null) !== snapshot.phase
  )
}

function replaceAccumulatorPayload(
  acc: StreamAccumulator,
  snapshot: ResultSnapshotReplacementV2,
  nowMs: number,
): void {
  acc.textSections = []
  acc.textPendingParts = []
  acc.textPendingLength = 0
  acc.textLength = 0
  acc.textSpansByWirePart.clear()
  for (const part of snapshot.textParts) {
    const key = streamTextPartKey(part)
    const existing = acc.textSpansByWirePart.get(key)
    if (existing) existing.length += part.text.length
    else acc.textSpansByWirePart.set(key, { start: acc.textLength, length: part.text.length })
    appendStreamText(acc, part.text)
  }
  if (acc.textLength > 0 && acc.firstTextAt === undefined) acc.firstTextAt = nowMs
  acc.annotations = resultSnapshotAnnotations(
    acc.initialAnnotations,
    acc.initialTextPrefix.length,
    snapshot.textParts,
  )
  acc.annotationIdentities = new Set(acc.annotations.map(streamAnnotationIdentity))

  const reasoningChanged = applyCanonicalReasoningMutation(acc.reasoning, {
    kind: 'replace',
    envelope: snapshot.reasoningEnvelope,
  })
  if (reasoningChanged && !reasoningEnvelopeIsEmpty(snapshot.reasoningEnvelope)) {
    if (acc.reasoningStartedAt === undefined) acc.reasoningStartedAt = nowMs
    acc.reasoningFinishedAt = nowMs
  }

  acc.toolCallRows = []
  acc.toolCallRowByIndex.clear()
  acc.toolCallRowById.clear()
  acc.toolCallArgumentsByRow.clear()
  acc.toolCallArgumentsLength = 0
  for (const call of snapshot.toolCalls) {
    putToolCallEvent(acc, {
      lane: 'tool-call',
      index: call.index,
      ...(call.id !== undefined ? { id: call.id } : {}),
      ...(call.type !== undefined ? { type: call.type } : {}),
      ...(call.name !== undefined ? { name: call.name } : {}),
      argumentsSnapshot: call.arguments,
      outputIndex: call.index,
    })
  }

  acc.generatedContent = structuredClone([...snapshot.generatedContent])
  delete acc.audioOutput
  acc.serverTools = structuredClone([...snapshot.serverTools])
  rebuildServerToolIndex(acc)
  acc.serverToolsRevision += 1
  acc.providerOutputItems = structuredClone([...snapshot.providerOutputItems])
  rebuildProviderOutputIndex(acc)
  if (snapshot.phase === null) delete acc.phase
  else acc.phase = snapshot.phase
}

function collectSnapshotToolCalls(acc: StreamAccumulator): Array<{
  index: number
  id?: string
  type?: 'function'
  name?: string
  arguments: string
}> {
  return acc.toolCallRows.map((row, index) => ({
    ...row,
    arguments: toolCallArgumentsAt(acc, index),
  }))
}

function resultSnapshotAnnotations(
  initial: readonly ContentAnnotation[],
  initialTextLength: number,
  parts: ResultSnapshotReplacementV2['textParts'],
): ContentAnnotation[] {
  const annotations = structuredClone([...initial])
  let textOffset = initialTextLength
  for (const part of parts) {
    for (const annotation of part.annotations) {
      annotations.push({
        ...structuredClone(annotation),
        startIndex: textOffset + Math.max(0, Math.min(part.text.length, annotation.startIndex)),
        endIndex: textOffset + Math.max(0, Math.min(part.text.length, annotation.endIndex)),
      })
    }
    textOffset += part.text.length
  }
  return annotations
}

export function streamAccumulatorText(acc: StreamAccumulator): string {
  return joinTextSections(acc.textSections, acc.textPendingParts)
}

export function streamAccumulatorAnnotations(acc: StreamAccumulator): ContentAnnotation[] {
  return structuredClone(acc.annotations)
}

export function projectStreamAccumulatorLiveContent(acc: StreamAccumulator): ContentItem[] {
  return assistantContentWithStreamSections(
    acc.initialTextPrefix,
    acc.initialNonTextContent,
    materializedTextSections(acc.textSections, acc.textPendingParts, acc.textPendingLength),
    streamPreviewGeneratedContent(acc.generatedContent),
    acc.annotations,
  )
}

export function streamAccumulatorReasoningLength(acc: StreamAccumulator): number {
  const inspected = inspectReasoningEnvelopeState(acc.reasoning.envelope)
  return inspected.visibleTextLength + inspected.carrierByteLength
}

export function streamAccumulatorHasCompletionCalibrationBlockers(acc: StreamAccumulator): boolean {
  return (
    acc.finishReason === 'tool_calls' ||
    acc.toolCallRows.length > 0 ||
    acc.generatedContent.some(isNonTextContentItem) ||
    hasAudioOutput(acc) ||
    acc.serverTools.length > 0 ||
    hasServerToolUsage(acc.usage) ||
    acc.providerOutputItems.some(providerOutputItemHasToolArtifact)
  )
}

export function messageHasToolArtifacts(message: Message): boolean {
  if (message.role === 'tool' || (message.generation?.serverTools?.length ?? 0) > 0) return true
  for (const attempt of createAppliedMessageView(message).attempts) {
    if ((attempt.toolCalls?.length ?? 0) > 0) return true
    if (attempt.providerOutputItems?.some(providerOutputItemHasToolArtifact) === true) return true
  }
  return false
}

function appendStreamText(acc: StreamAccumulator, text: string): void {
  if (text.length === 0) return
  acc.textPendingLength = appendTextToSections(
    acc.textSections,
    acc.textPendingParts,
    acc.textPendingLength,
    text,
  )
  acc.textLength += text.length
}

function recordTextSpan(
  acc: StreamAccumulator,
  event: Extract<StreamLaneEvent, { lane: 'text' }>,
): void {
  const key = streamTextPartKey(event)
  const current = acc.textSpansByWirePart.get(key)
  if (current) {
    current.length += event.text.length
    return
  }
  acc.textSpansByWirePart.set(key, { start: acc.textLength, length: event.text.length })
}

function putTextAnnotations(
  acc: StreamAccumulator,
  event: Extract<StreamLaneEvent, { lane: 'text-annotations' }>,
): boolean {
  const span = acc.textSpansByWirePart.get(streamTextPartKey(event))
  const fallbackStart = Math.max(0, acc.textLength - event.ownerTextLength)
  const base = acc.initialTextPrefix.length + (span?.start ?? fallbackStart)
  const ownerLength = span?.length ?? event.ownerTextLength
  let changed = false
  for (const annotation of event.annotations) {
    const shifted = structuredClone(annotation)
    shifted.startIndex = base + Math.max(0, Math.min(ownerLength, annotation.startIndex))
    shifted.endIndex = base + Math.max(0, Math.min(ownerLength, annotation.endIndex))
    const identity = streamAnnotationIdentity(shifted)
    if (acc.annotationIdentities.has(identity)) continue
    acc.annotationIdentities.add(identity)
    acc.annotations.push(shifted)
    changed = true
  }
  return changed
}

function streamTextPartKey(
  event: Pick<
    Extract<StreamLaneEvent, { lane: 'text' | 'text-annotations' }>,
    'outputIndex' | 'contentIndex'
  >,
): string {
  return `${event.outputIndex ?? 'default'}:${event.contentIndex ?? 'all'}`
}

function collectInitialContentAnnotations(content: readonly ContentItem[]): ContentAnnotation[] {
  const annotations: ContentAnnotation[] = []
  let textOffset = 0
  for (const item of content) {
    if (item.type !== 'text' && item.type !== 'output_text') continue
    if (item.type === 'output_text') {
      for (const annotation of item.annotations ?? []) {
        annotations.push({
          ...structuredClone(annotation),
          startIndex: textOffset + annotation.startIndex,
          endIndex: textOffset + annotation.endIndex,
        })
      }
    }
    textOffset += item.text.length
  }
  return annotations
}

function streamAnnotationIdentity(annotation: ContentAnnotation): string {
  const target =
    annotation.type === 'url_citation'
      ? annotation.url
      : annotation.type === 'file_citation'
        ? JSON.stringify(annotation.file)
        : `${annotation.annotationType}:${JSON.stringify(annotation.providerPayload)}`
  return `${annotation.source}:${annotation.type}:${annotation.startIndex}:${annotation.endIndex}:${target}`
}

function recordStreamIntegrity(
  summary: AttemptIntegritySummary,
  event: GenerationStreamIntegrityV2,
): void {
  summary.count += event.count
  summary.characterCount += event.characterCount
  const existing = summary.entries.find(
    (entry) =>
      entry.adapter === event.adapter &&
      entry.eventType === event.eventType &&
      entry.fingerprint === event.fingerprint,
  )
  if (existing) {
    existing.count += event.count
    existing.characterCount += event.characterCount
    return
  }
  if (summary.entries.length < STREAM_INTEGRITY_ENTRY_LIMIT) {
    summary.entries.push({ ...event })
  }
}

function appendTextToSections(
  sections: string[],
  pendingParts: string[],
  initialPendingLength: number,
  text: string,
): number {
  let offset = 0
  let pendingLength = initialPendingLength
  while (offset < text.length) {
    const room = STREAM_LIVE_TEXT_SECTION_CHARS - pendingLength
    const nextOffset = Math.min(text.length, offset + room)
    const part = text.slice(offset, nextOffset)
    pendingParts.push(part)
    pendingLength += part.length
    offset = nextOffset
    if (pendingLength === STREAM_LIVE_TEXT_SECTION_CHARS) {
      appendGeometricTextSection(
        sections,
        pendingParts.length === 1 ? (pendingParts[0] as string) : pendingParts.join(''),
      )
      pendingParts.length = 0
      pendingLength = 0
    }
  }
  return pendingLength
}

function appendGeometricTextSection(sections: string[], section: string): void {
  let next = section
  while (sections.length > 0 && sections.at(-1)?.length === next.length) {
    next = `${sections.pop() as string}${next}`
  }
  sections.push(next)
}

function materializedTextSections(
  sections: readonly string[],
  pendingParts: readonly string[],
  pendingLength: number,
): string[] {
  if (pendingLength === 0) return [...sections]
  return [
    ...sections,
    pendingParts.length === 1 ? (pendingParts[0] as string) : pendingParts.join(''),
  ]
}

function joinTextSections(sections: readonly string[], pendingParts: readonly string[]): string {
  if (pendingParts.length === 0) return sections.join('')
  return [...sections, ...pendingParts].join('')
}

function putToolCallEvent(
  acc: StreamAccumulator,
  event: Extract<StreamLaneEvent, { lane: 'tool-call' }>,
): void {
  let rowIndex = findToolCallRow(acc, event)
  if (rowIndex === undefined) {
    rowIndex = acc.toolCallRows.length
    acc.toolCallRows.push({
      index: event.index,
      ...(event.id !== undefined ? { id: event.id } : {}),
      ...(event.type !== undefined ? { type: event.type } : {}),
      ...(event.name !== undefined ? { name: event.name } : {}),
    })
  } else {
    const row = acc.toolCallRows[rowIndex]
    if (!row) return
    if (event.id !== undefined) row.id = event.id
    if (event.type !== undefined) row.type = event.type
    if (event.name !== undefined) row.name = event.name
  }
  acc.toolCallRowByIndex.set(event.index, rowIndex)
  if (event.id !== undefined) acc.toolCallRowById.set(event.id, rowIndex)
  if (event.argumentsSnapshot !== undefined) {
    replaceToolCallArguments(acc, rowIndex, event.argumentsSnapshot)
  } else if (event.argumentsDelta !== undefined) {
    appendToolCallArguments(acc, rowIndex, event.argumentsDelta)
  }
}

function findToolCallRow(
  acc: StreamAccumulator,
  event: Extract<StreamLaneEvent, { lane: 'tool-call' }>,
): number | undefined {
  if (event.id !== undefined) {
    const byId = acc.toolCallRowById.get(event.id)
    if (byId !== undefined) return byId
  }
  const byIndex = acc.toolCallRowByIndex.get(event.index)
  if (byIndex === undefined) return undefined
  const row = acc.toolCallRows[byIndex]
  if (event.id !== undefined && row?.id !== undefined && row.id !== event.id) return undefined
  return byIndex
}

function appendToolCallArguments(acc: StreamAccumulator, rowIndex: number, value: string): void {
  if (value.length === 0) return
  const buffer = toolCallArgumentBuffer(acc, rowIndex)
  buffer.pendingLength = appendTextToSections(
    buffer.sections,
    buffer.pendingParts,
    buffer.pendingLength,
    value,
  )
  buffer.length += value.length
  acc.toolCallArgumentsLength += value.length
}

function replaceToolCallArguments(acc: StreamAccumulator, rowIndex: number, value: string): void {
  const buffer = toolCallArgumentBuffer(acc, rowIndex)
  acc.toolCallArgumentsLength -= buffer.length
  buffer.sections = []
  buffer.pendingParts = []
  buffer.pendingLength = 0
  buffer.length = 0
  appendToolCallArguments(acc, rowIndex, value)
}

function toolCallArgumentBuffer(acc: StreamAccumulator, rowIndex: number): ToolCallArgumentBuffer {
  const existing = acc.toolCallArgumentsByRow.get(rowIndex)
  if (existing) return existing
  const created: ToolCallArgumentBuffer = {
    sections: [],
    pendingParts: [],
    pendingLength: 0,
    length: 0,
  }
  acc.toolCallArgumentsByRow.set(rowIndex, created)
  return created
}

function collectLiveToolCallRows(acc: StreamAccumulator): StreamAccumulatorLiveToolCallRow[] {
  return acc.toolCallRows.map((row, index) => {
    const buffer = acc.toolCallArgumentsByRow.get(index)
    const pendingArguments = buffer ? joinTextSections([], buffer.pendingParts) : undefined
    return {
      ...row,
      argumentSections: buffer ? [...buffer.sections] : [],
      ...(pendingArguments ? { pendingArguments } : {}),
      argumentLength: buffer?.length ?? 0,
    }
  })
}

function collectToolCalls(acc: StreamAccumulator): ToolCall[] {
  const calls: ToolCall[] = []
  const orderedRows = acc.toolCallRows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => left.row.index - right.row.index || left.index - right.index)
  for (const { row, index } of orderedRows) {
    if (row.type !== 'function' || !row.id || !row.name) continue
    calls.push({
      id: row.id,
      type: 'function',
      function: {
        name: row.name,
        arguments: toolCallArgumentsAt(acc, index),
      },
    })
  }
  return calls
}

function collectIncompleteToolCallOutputItems(acc: StreamAccumulator): ProviderOutputItem[] {
  const items: ProviderOutputItem[] = []
  for (const [index, row] of acc.toolCallRows.entries()) {
    if (row.type === 'function' && row.id && row.name) continue
    items.push({
      dialect: 'unknown',
      type: 'incomplete_function_call',
      outputIndex: row.index,
      hidden: true,
      item: {
        type: 'incomplete_function_call',
        index: row.index,
        ...(row.id !== undefined ? { id: row.id } : {}),
        ...(row.type !== undefined ? { callType: row.type } : {}),
        ...(row.name !== undefined ? { name: row.name } : {}),
        arguments: toolCallArgumentsAt(acc, index),
      },
    })
  }
  return items
}

function toolCallArgumentsAt(acc: StreamAccumulator, rowIndex: number): string {
  const buffer = acc.toolCallArgumentsByRow.get(rowIndex)
  return buffer ? joinTextSections(buffer.sections, buffer.pendingParts) : ''
}

function assistantContentWithStreamPrefix(
  initialTextPrefix: string,
  initialNonTextContent: readonly ContentItem[],
  streamedText: string,
  generatedContent: readonly ContentItem[] = [],
  annotations: readonly ContentAnnotation[] = [],
): ContentItem[] {
  const text = initialTextPrefix.length > 0 ? `${initialTextPrefix}${streamedText}` : streamedText
  return [
    {
      type: 'output_text',
      text,
      ...(annotations.length > 0 ? { annotations: structuredClone([...annotations]) } : {}),
    },
    ...structuredClone(initialNonTextContent),
    ...structuredClone(generatedContent),
  ]
}

function assistantContentWithStreamSections(
  initialTextPrefix: string,
  initialNonTextContent: readonly ContentItem[],
  streamedSections: readonly string[],
  generatedContent: readonly ContentItem[] = [],
  annotations: readonly ContentAnnotation[] = [],
): ContentItem[] {
  const textItems: ContentItem[] = []
  if (initialTextPrefix.length > 0) {
    textItems.push({ type: 'output_text', text: initialTextPrefix })
  }
  for (const section of streamedSections) {
    if (section.length > 0) textItems.push({ type: 'output_text', text: section })
  }
  if (textItems.length === 0) textItems.push({ type: 'output_text', text: '' })
  return [
    ...attachAnnotationsToTextItems(textItems, annotations),
    ...initialNonTextContent,
    ...generatedContent,
  ]
}

function attachAnnotationsToTextItems(
  textItems: readonly ContentItem[],
  annotations: readonly ContentAnnotation[],
): ContentItem[] {
  if (annotations.length === 0) return [...textItems]
  const result = structuredClone([...textItems])
  const textRows = result
    .map((item, index) => ({ item, index }))
    .filter(
      (
        row,
      ): row is {
        item: Extract<ContentItem, { type: 'text' | 'output_text' }>
        index: number
      } => row.item.type === 'text' || row.item.type === 'output_text',
    )
  const boundaries: number[] = []
  let totalTextLength = 0
  for (const row of textRows) {
    totalTextLength += row.item.text.length
    boundaries.push(totalTextLength)
  }
  const ownedByRow = textRows.map(() => [] as ContentAnnotation[])
  for (const annotation of annotations) {
    const rowIndex = lowerBound(boundaries, annotation.endIndex)
    if (rowIndex >= textRows.length) continue
    const textOffset = rowIndex === 0 ? 0 : (boundaries[rowIndex - 1] ?? 0)
    if (annotation.endIndex <= textOffset && !(textOffset === 0 && annotation.endIndex === 0)) {
      continue
    }
    ownedByRow[rowIndex]?.push({
      ...structuredClone(annotation),
      startIndex: Math.max(0, annotation.startIndex - textOffset),
      endIndex: Math.max(0, annotation.endIndex - textOffset),
    })
  }
  for (const [rowIndex, row] of textRows.entries()) {
    const owned = ownedByRow[rowIndex] ?? []
    if (owned.length > 0) {
      result[row.index] = {
        type: 'output_text',
        text: row.item.text,
        annotations: owned,
      }
    }
  }
  return result
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1
    else high = middle
  }
  return low
}

function streamPreviewGeneratedContent(generatedContent: readonly ContentItem[]): ContentItem[] {
  return generatedContent.filter(
    (item) => item.type !== 'audio_output' && item.type !== 'output_video',
  )
}

function isNonTextContentItem(item: ContentItem): boolean {
  return item.type !== 'text' && item.type !== 'output_text'
}

function hasAudioOutput(acc: StreamAccumulator): boolean {
  return Boolean(
    acc.audioOutput && (acc.audioOutput.chunks.length > 0 || acc.audioOutput.transcriptLength > 0),
  )
}

function audioOutputContent(acc: StreamAccumulator): ContentItem[] {
  if (!hasAudioOutput(acc) || !acc.audioOutput) return []
  const format = acc.audioOutput.format
  const joined = acc.audioOutput.chunks.join('')
  const transcript = joinTextSections(
    acc.audioOutput.transcriptSections,
    acc.audioOutput.transcriptPendingParts,
  )
  const base = {
    type: 'audio_output',
    format,
    ...(transcript.length > 0 ? { transcript } : {}),
  } as const
  if (joined.length === 0) return [base]
  const url =
    format === 'pcm16'
      ? pcm16DataUrlToWav(joined, { sampleRate: 24_000, channels: 1 })
      : `data:audio/${format};base64,${joined}`
  return [{ ...base, url }]
}

function pcm16DataUrlToWav(
  base64Pcm: string,
  opts: { sampleRate: number; channels: number },
): string {
  const pcm = decodeBase64Bytes(base64Pcm)
  const header = wavHeader(pcm.byteLength, opts.sampleRate, opts.channels)
  const bytes = new Uint8Array(header.byteLength + pcm.byteLength)
  bytes.set(header, 0)
  bytes.set(pcm, header.byteLength)
  return `data:audio/wav;base64,${encodeBase64Bytes(bytes)}`
}

function decodeBase64Bytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/gu, '').replace(/-/gu, '+').replace(/_/gu, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function wavHeader(dataBytes: number, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return new Uint8Array(header)
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}

function providerOutputItemHasToolArtifact(item: ProviderOutputItem): boolean {
  return isKnownProviderToolOutputType(item.type) || item.type.endsWith('_tool_result')
}

function hasServerToolUsage(usage: ChatUsage | undefined): boolean {
  if (!usage?.server_tool_use || typeof usage.server_tool_use !== 'object') return false
  return Object.values(usage.server_tool_use).some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  )
}

function recordServerToolStatus(
  acc: StreamAccumulator,
  event: Extract<StreamLaneEvent, { lane: 'server-tool' }>,
): void {
  putServerTool(acc, {
    type: event.itemType,
    source: 'stream-status',
    id: event.itemId,
    status: event.status,
    outputIndex: event.outputIndex,
  })
}

function recordServerToolOutputItem(
  acc: StreamAccumulator,
  item: unknown,
  outputIndex: number,
  fallbackSource: GenerationServerToolCall['source'],
): void {
  if (!item || typeof item !== 'object') return
  const record = item as { type?: unknown; id?: unknown; status?: unknown }
  if (typeof record.type !== 'string' || !isKnownProviderToolOutputType(record.type)) return
  putServerTool(acc, {
    type: record.type,
    source: fallbackSource,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    outputIndex,
  })
}

function recordResponsesOutputItem(
  acc: StreamAccumulator,
  dialect: 'openai-responses' | 'openrouter-responses',
  item: unknown,
  outputIndex: number,
): void {
  const providerItem = providerOutputItemFromResponsesItem(item, dialect, outputIndex)
  if (!providerItem) return
  putProviderOutputItem(acc, providerItem)
}

function recordProviderOutputItem(
  acc: StreamAccumulator,
  dialect: 'google-gemini' | 'anthropic-claude',
  type: string,
  captureId: string,
  output: unknown,
  outputIndex: number,
): void {
  const providerItem =
    dialect === 'google-gemini'
      ? providerOutputItemFromGeminiPart(type, output, outputIndex)
      : {
          dialect,
          type,
          captureId,
          outputIndex,
          item: structuredClone(output),
        }
  if (!providerItem) return
  providerItem.captureId = captureId
  putProviderOutputItem(acc, providerItem)
}

function serverToolRecordsFromUsage(usage: ChatUsage | undefined): GenerationServerToolCall[] {
  const raw = usage?.server_tool_use
  if (!raw || typeof raw !== 'object') return []
  const records: GenerationServerToolCall[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    records.push({
      type: serverToolUsageKeyToType(key),
      source: 'usage',
      status: 'completed',
      requestCount: value,
    })
  }
  return records
}

function serverToolUsageKeyToType(key: string): string {
  if (key === 'web_search_requests') return 'openrouter:web_search'
  if (key === 'web_fetch_requests') return 'openrouter:web_fetch'
  if (key === 'datetime_requests') return 'openrouter:datetime'
  return key
}

function mergeServerToolRecords(
  records: readonly GenerationServerToolCall[],
): GenerationServerToolCall[] {
  const merged: GenerationServerToolCall[] = []
  const rowByKey = new Map<string, number>()
  for (const record of records) putServerToolRecord(merged, rowByKey, record)
  return merged
}

function putServerTool(acc: StreamAccumulator, incoming: GenerationServerToolCall): void {
  if (putServerToolRecord(acc.serverTools, acc.serverToolRowByKey, incoming)) {
    acc.serverToolsRevision += 1
  }
}

function putServerToolRecord(
  records: GenerationServerToolCall[],
  rowByKey: Map<string, number>,
  incoming: GenerationServerToolCall,
): boolean {
  const incomingAliases = serverToolRecordAliases(incoming)
  const index = incomingAliases
    .map((alias) => rowByKey.get(alias))
    .find((candidate): candidate is number => candidate !== undefined)
  if (index === undefined) {
    for (const alias of incomingAliases) rowByKey.set(alias, records.length)
    records.push(structuredClone(incoming))
    return true
  }
  const existing = records[index]
  if (!existing) return false
  const next = {
    ...existing,
    ...structuredClone(incoming),
    source:
      incoming.source === 'responses-output' || existing.source !== 'responses-output'
        ? incoming.source
        : existing.source,
  }
  if (sameValue(existing, next)) return false
  records[index] = next
  for (const alias of serverToolRecordAliases(next)) rowByKey.set(alias, index)
  return true
}

function projectServerTools(acc: StreamAccumulator): GenerationServerToolCall[] {
  if (acc.serverToolsProjectionRevision === acc.serverToolsRevision) {
    return acc.serverToolsProjection
  }
  acc.serverToolsProjection = mergeServerToolRecords([
    ...acc.serverTools,
    ...(acc.serverTools.length === 0 ? serverToolRecordsFromUsage(acc.usage) : []),
  ])
  acc.serverToolsProjectionRevision = acc.serverToolsRevision
  return acc.serverToolsProjection
}

function putProviderOutputItem(acc: StreamAccumulator, incoming: ProviderOutputItem): void {
  const key = providerOutputItemIdentity(incoming, acc.providerOutputItems.length)
  const index = acc.providerOutputRowByKey.get(key)
  if (index === undefined) {
    acc.providerOutputRowByKey.set(key, acc.providerOutputItems.length)
    acc.providerOutputItems.push(structuredClone(incoming))
    return
  }
  acc.providerOutputItems[index] = structuredClone(incoming)
}

function rebuildServerToolIndex(acc: StreamAccumulator): void {
  acc.serverToolRowByKey.clear()
  for (let index = 0; index < acc.serverTools.length; index += 1) {
    const record = acc.serverTools[index]
    if (record) {
      for (const alias of serverToolRecordAliases(record)) {
        acc.serverToolRowByKey.set(alias, index)
      }
    }
  }
}

function rebuildProviderOutputIndex(acc: StreamAccumulator): void {
  acc.providerOutputRowByKey.clear()
  for (let index = 0; index < acc.providerOutputItems.length; index += 1) {
    const record = acc.providerOutputItems[index]
    if (record) {
      acc.providerOutputRowByKey.set(providerOutputItemIdentity(record, index), index)
    }
  }
}

function serverToolRecordAliases(record: GenerationServerToolCall): string[] {
  const aliases: string[] = []
  if (record.id) aliases.push(`id:${record.id}:${record.type}`)
  if (record.outputIndex !== undefined) {
    aliases.push(`idx:${record.outputIndex}:${record.type}`)
  }
  if (aliases.length === 0) aliases.push(`usage:${record.type}`)
  return aliases
}

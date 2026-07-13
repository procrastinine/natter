import type { ApiError } from '../api/errors'
import type { StreamIntegrityEvent } from '../api/sse'
import type { StreamLaneEvent } from '../api/stream-transforms'
import {
  providerOutputItemFromGeminiPart,
  providerOutputItemFromResponsesItem,
} from './provider-tool-context'
import {
  findMergeTargetIndex,
  mergeReasoningDetail,
  normalizeIncomingReasoningDetail,
} from './reasoning'
import type {
  AttemptIntegritySummary,
  ChatUsage,
  ContentItem,
  FinishReason,
  GenerationMeta,
  GenerationServerToolCall,
  MessagePhase,
  ProviderOutputItem,
  ReasoningDetail,
  ToolCall,
} from './types'

export const STREAM_LIVE_UPDATE_INTERVAL_MS = 125
export const STREAM_DURABLE_BATCH_TEXT_CHARS = 128 * 1024
const STREAM_LIVE_TEXT_SECTION_CHARS = 20_000
const STREAM_INTEGRITY_ENTRY_LIMIT = 16

const HOSTED_SERVER_TOOL_ITEM_TYPES = new Set<string>([
  'web_search_call',
  'file_search_call',
  'image_generation_call',
  'code_interpreter_call',
  'shell_call',
  'shell_call_output',
  'computer_call',
  'mcp_tool_call',
  'mcp_call',
  'google:google_search',
  'google:url_context',
  'google:code_execution',
  'google:google_maps',
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

export interface StreamAccumulator {
  initialContent: ContentItem[]
  textSections: string[]
  textPendingParts: string[]
  textPendingLength: number
  textLength: number
  reasoningList: ReasoningDetail[]
  reasoningRowById: Map<string, number>
  reasoningSegmentsByRow: Map<number, ReasoningSegmentBuffer>
  reasoningCumulativeValueByRow: Map<number, string>
  reasoningLength: number
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
  providerOutputItems: ProviderOutputItem[]
  firstTextAt?: number
  reasoningStartedAt?: number
  reasoningFinishedAt?: number
  dirtySinceLastLivePublish: boolean
  liveMutationRevision: number
  lastLivePublishedAt: number
  lastLivePublishedTextLen: number
  lastLivePublishedReasoningLen: number
  lastLivePublishedToolCallArgumentsLen: number
  midStreamError?: ApiError
  integritySummary: AttemptIntegritySummary
}

export interface StreamAccumulatorLiveProjection {
  content: ContentItem[]
  reasoningRows?: StreamAccumulatorLiveReasoningRow[]
  toolCallRows?: StreamAccumulatorLiveToolCallRow[]
  generation: GenerationMeta
  textLength: number
  reasoningLength: number
  updatedAt: number
}

export interface StreamAccumulatorLiveReasoningRow {
  detail: ReasoningDetail
  valueSections?: string[]
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
  reasoningDetails?: ReasoningDetail[]
  toolCalls?: ToolCall[]
  phase?: MessagePhase
  providerOutputItems?: ProviderOutputItem[]
}

export type StreamAccumulatorFinalMetadataProjection = Omit<
  StreamAccumulatorFinalProjection,
  'content'
>

export interface StreamAccumulatorReplayEntry {
  event: unknown
  createdAt: number
}

export interface StreamAccumulatorReplayResult {
  accumulator: StreamAccumulator
  final: StreamAccumulatorFinalProjection
  finishedCleanly: boolean
}

type ReasoningSegmentField = 'text' | 'summary' | 'data'

interface ReasoningSegmentBuffer {
  field: ReasoningSegmentField
  sections: string[]
  pendingParts: string[]
  pendingLength: number
  length: number
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
  return {
    initialContent: input.initialContent,
    textSections: [],
    textPendingParts: [],
    textPendingLength: 0,
    textLength: 0,
    reasoningList: [],
    reasoningRowById: new Map(),
    reasoningSegmentsByRow: new Map(),
    reasoningCumulativeValueByRow: new Map(),
    reasoningLength: 0,
    toolCallRows: [],
    toolCallRowByIndex: new Map(),
    toolCallRowById: new Map(),
    toolCallArgumentsByRow: new Map(),
    toolCallArgumentsLength: 0,
    generatedContent: [],
    serverTools: [],
    providerOutputItems: [],
    integritySummary: { count: 0, characterCount: 0, entries: [] },
    dirtySinceLastLivePublish: false,
    liveMutationRevision: 0,
    lastLivePublishedAt: input.now,
    lastLivePublishedTextLen: 0,
    lastLivePublishedReasoningLen: 0,
    lastLivePublishedToolCallArgumentsLen: 0,
  }
}

export function applyStreamAccumulatorEvent(
  acc: StreamAccumulator,
  event: StreamLaneEvent,
  nowMs: number,
): void {
  switch (event.lane) {
    case 'text':
      if (acc.firstTextAt === undefined) acc.firstTextAt = nowMs
      appendStreamText(acc, event.text)
      markLiveProjectionDirty(acc)
      return
    case 'reasoning': {
      if (acc.reasoningStartedAt === undefined) acc.reasoningStartedAt = nowMs
      acc.reasoningFinishedAt = nowMs
      const outputIndex = event.outputIndex ?? 0
      if (Array.isArray(event.details)) {
        for (const raw of event.details) {
          if (!raw || typeof raw !== 'object') continue
          const detail = normalizeIncomingReasoningDetail(
            raw as ReasoningDetail & { index?: number },
          )
          if (detail.id?.startsWith('tool_')) continue
          putReasoningDetail(acc, detail, event.detailsMode ?? 'snapshot')
          markLiveProjectionDirty(acc)
        }
      }
      if (event.textDelta !== undefined) {
        const id = syntheticReasoningDetailId('reasoning.text', event)
        const detail: ReasoningDetail = {
          type: 'reasoning.text',
          ...(id ? { id } : {}),
          index: outputIndex,
          ...(event.format ? { format: event.format } : {}),
          text: event.textDelta,
        }
        putReasoningDelta(acc, detail, false)
        markLiveProjectionDirty(acc)
      }
      if (event.summaryDelta !== undefined) {
        const id = syntheticReasoningDetailId('reasoning.summary', event)
        putReasoningDelta(
          acc,
          {
            type: 'reasoning.summary',
            ...(id ? { id } : {}),
            index: outputIndex,
            ...(event.format ? { format: event.format } : {}),
            summary: event.summaryDelta,
          },
          false,
        )
        markLiveProjectionDirty(acc)
      }
      if (event.encryptedDelta !== undefined) {
        const id = syntheticReasoningDetailId('reasoning.encrypted', event)
        putReasoningDelta(
          acc,
          {
            type: 'reasoning.encrypted',
            ...(id ? { id } : {}),
            index: outputIndex,
            ...(event.format ? { format: event.format } : {}),
            data: event.encryptedDelta,
          },
          event.replaceEncrypted === true,
        )
        markLiveProjectionDirty(acc)
      }
      return
    }
    case 'tool-call':
      putToolCallEvent(acc, event)
      markLiveProjectionDirty(acc)
      return
    case 'usage':
      acc.usage = event.usage as ChatUsage
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
      upsertServerTool(acc.serverTools, {
        type: event.itemType,
        source: 'provider-output',
        id: event.itemId,
        ...(event.status ? { status: event.status } : {}),
        outputIndex: event.outputIndex,
        output: structuredClone(event.output),
      })
      recordProviderOutputItem(acc, event.itemType, event.output, event.outputIndex)
      return
    case 'output-item-added':
      recordServerToolOutputItem(acc, event.item, event.outputIndex, 'stream-status')
      return
    case 'output-item-done':
      recordServerToolOutputItem(acc, event.item, event.outputIndex, 'responses-output')
      recordResponsesOutputItem(acc, event.item, event.outputIndex)
      return
    case 'phase':
      if (event.phase === null) delete acc.phase
      else acc.phase = event.phase
      return
    case 'integrity':
      recordStreamIntegrity(acc.integritySummary, event.integrity)
      return
    case 'error':
      acc.midStreamError = event.error
      return
    case 'buffered':
    case 'keepalive':
    case 'terminal':
      return
  }
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
  },
): StreamAccumulatorLiveProjection {
  const reasoningRows = collectLiveReasoningRows(acc)
  const toolCallRows = collectLiveToolCallRows(acc)
  return {
    content: assistantContentWithStreamSections(
      acc.initialContent,
      materializedTextSections(acc.textSections, acc.textPendingParts, acc.textPendingLength),
      streamPreviewGeneratedContent(acc.generatedContent),
    ),
    ...(reasoningRows.length > 0 ? { reasoningRows } : {}),
    ...(toolCallRows.length > 0 ? { toolCallRows } : {}),
    generation: projectStreamGeneration(undefined, acc, input.requestedModel, {
      apiUsed: input.apiUsed,
      ...(input.generationStartedAt !== undefined ? { startedAt: input.generationStartedAt } : {}),
    }),
    textLength: acc.textLength,
    reasoningLength: acc.reasoningLength,
    updatedAt: input.now,
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
    content: assistantContentWithStreamPrefix(acc.initialContent, streamAccumulatorText(acc), [
      ...acc.generatedContent,
      ...audioOutputContent(acc),
    ]),
    ...metadata,
  }
}

export function projectStreamAccumulatorFinalMetadata(
  acc: StreamAccumulator,
): StreamAccumulatorFinalMetadataProjection {
  const reasoning = collectReasoning(acc)
  const toolCalls = collectToolCalls(acc)
  const providerOutputItems = [
    ...acc.providerOutputItems,
    ...collectIncompleteToolCallOutputItems(acc),
  ]
  return {
    ...(reasoning.length > 0 ? { reasoningDetails: reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
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
      }
  if (opts.apiUsed !== undefined) base.apiUsed = opts.apiUsed
  if (acc.generationId) base.id = acc.generationId
  if (acc.model) base.model = acc.model
  if (acc.provider) base.provider = acc.provider
  if (acc.usage) base.usage = acc.usage
  if (acc.usage?.cost !== undefined) base.cost = acc.usage.cost
  const serverTools = mergeServerToolRecords([
    ...acc.serverTools,
    ...(acc.serverTools.length === 0 ? serverToolRecordsFromUsage(acc.usage) : []),
  ])
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
  const accumulator = createStreamAccumulator({
    initialContent: structuredClone([...input.initialContent]),
    now: input.now,
  })
  let finishedCleanly = false
  for (const entry of input.entries) {
    const event = replayableStreamEvent(entry.event)
    if (!event) continue
    applyStreamAccumulatorEvent(accumulator, event, entry.createdAt)
    if (event.lane === 'finish' || event.lane === 'terminal') finishedCleanly = true
  }
  return {
    accumulator,
    final: projectStreamAccumulatorFinal(accumulator),
    finishedCleanly,
  }
}

export function releaseStreamAccumulatorBuffers(acc: StreamAccumulator): void {
  acc.initialContent = []
  acc.textSections = []
  acc.textPendingParts = []
  acc.textPendingLength = 0
  acc.textLength = 0
  acc.reasoningList = []
  acc.reasoningRowById.clear()
  acc.reasoningSegmentsByRow.clear()
  acc.reasoningCumulativeValueByRow.clear()
  acc.reasoningLength = 0
  acc.toolCallRows = []
  acc.toolCallRowByIndex.clear()
  acc.toolCallRowById.clear()
  acc.toolCallArgumentsByRow.clear()
  acc.toolCallArgumentsLength = 0
  acc.generatedContent = []
  acc.serverTools = []
  acc.providerOutputItems = []
  acc.integritySummary = { count: 0, characterCount: 0, entries: [] }
  delete acc.audioOutput
}

export function streamAccumulatorText(acc: StreamAccumulator): string {
  return joinTextSections(acc.textSections, acc.textPendingParts)
}

export function streamAccumulatorTextSections(acc: StreamAccumulator): string[] {
  return materializedTextSections(acc.textSections, acc.textPendingParts, acc.textPendingLength)
}

export function streamAccumulatorReasoningLength(acc: StreamAccumulator): number {
  return acc.reasoningLength
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

function recordStreamIntegrity(
  summary: AttemptIntegritySummary,
  event: StreamIntegrityEvent,
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
      sections.push(pendingParts.length === 1 ? (pendingParts[0] as string) : pendingParts.join(''))
      pendingParts.length = 0
      pendingLength = 0
    }
  }
  return pendingLength
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

function collectReasoning(acc: StreamAccumulator): ReasoningDetail[] {
  return acc.reasoningList.map((detail, index) => materializedReasoningDetail(acc, index, detail))
}

function collectLiveReasoningRows(acc: StreamAccumulator): StreamAccumulatorLiveReasoningRow[] {
  return acc.reasoningList.map((detail, index) => {
    const buffer = acc.reasoningSegmentsByRow.get(index)
    if (!buffer) return { detail }
    return {
      detail,
      valueSections: materializedTextSections(
        buffer.sections,
        buffer.pendingParts,
        buffer.pendingLength,
      ),
    }
  })
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
      argumentSections: buffer?.sections ?? [],
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

function putReasoningDetail(
  acc: StreamAccumulator,
  incoming: ReasoningDetail,
  mode: 'delta' | 'snapshot' | 'cumulative' = 'snapshot',
): void {
  if (mode === 'snapshot' && isAnthropicReasoningSnapshot(incoming)) {
    const target = findAnthropicReasoningSnapshotTarget(acc, incoming)
    if (target !== undefined) {
      replaceAnthropicReasoningSnapshot(acc, target, incoming)
      return
    }
    pushReasoningRow(acc, incoming)
    return
  }
  if (mode === 'delta') {
    putStructuredReasoningDetailDelta(acc, incoming)
    return
  }
  if (mode === 'cumulative') {
    putCumulativeReasoningDetail(acc, incoming)
    return
  }
  if (incoming.id) {
    const existing = acc.reasoningRowById.get(incoming.id)
    if (existing !== undefined) {
      mergeReasoningRow(acc, existing, incoming)
      return
    }
  }
  let target = findMergeTargetIndex(acc.reasoningList, incoming)
  if (target < 0 && acc.reasoningSegmentsByRow.size > 0) {
    target = findMergeTargetIndex(collectReasoning(acc), incoming)
  }
  if (target >= 0) {
    mergeReasoningRow(acc, target, incoming)
    if (incoming.id) acc.reasoningRowById.set(incoming.id, target)
    return
  }
  pushReasoningRow(acc, incoming)
}

function putStructuredReasoningDetailDelta(
  acc: StreamAccumulator,
  incoming: ReasoningDetail,
): void {
  const target = findStructuredReasoningDetailTarget(acc, incoming)
  if (target === undefined) {
    pushReasoningDeltaRow(acc, incoming)
    return
  }
  if (incoming.id) acc.reasoningRowById.set(incoming.id, target)
  const existing = acc.reasoningList[target]
  if (existing?.type === incoming.type) {
    acc.reasoningCumulativeValueByRow.delete(target)
    appendReasoningDelta(acc, target, geminiSummarySectionDelta(acc, target, incoming), false)
    return
  }
  replaceReasoningRow(acc, target, incoming)
}

function putCumulativeReasoningDetail(acc: StreamAccumulator, incoming: ReasoningDetail): void {
  const target = findStructuredReasoningDetailTarget(acc, incoming)
  if (target === undefined) {
    pushReasoningDeltaRow(acc, incoming)
    return
  }
  if (incoming.id) acc.reasoningRowById.set(incoming.id, target)
  if (acc.reasoningList[target]?.type !== incoming.type) {
    replaceReasoningRow(acc, target, incoming)
    acc.reasoningCumulativeValueByRow.set(target, reasoningDetailValue(incoming))
    return
  }
  const incomingValue = reasoningDetailValue(incoming)
  const previousCumulativeValue = acc.reasoningCumulativeValueByRow.get(target)
  if (
    incomingValue.length === reasoningRowLength(acc, target) &&
    reasoningRowMatchesPrefixOf(acc, target, incomingValue)
  ) {
    const existing = acc.reasoningList[target]
    acc.reasoningList[target] = acc.reasoningSegmentsByRow.has(target)
      ? withReasoningDetailValue({ ...existing, ...incoming }, '')
      : { ...existing, ...incoming }
    acc.reasoningCumulativeValueByRow.set(target, incomingValue)
    return
  }
  if (
    previousCumulativeValue !== undefined &&
    incomingValue.length > previousCumulativeValue.length &&
    incomingValue.startsWith(previousCumulativeValue)
  ) {
    const existing = acc.reasoningList[target]
    replaceReasoningRow(acc, target, { ...existing, ...incoming })
    acc.reasoningCumulativeValueByRow.set(target, incomingValue)
    return
  }
  if (
    incomingValue.length > reasoningRowLength(acc, target) &&
    reasoningRowMatchesPrefixOf(acc, target, incomingValue)
  ) {
    appendReasoningDelta(acc, target, incoming, true)
    acc.reasoningCumulativeValueByRow.set(target, incomingValue)
    return
  }
  appendReasoningDelta(acc, target, incoming, false)
  acc.reasoningCumulativeValueByRow.delete(target)
}

function reasoningRowMatchesPrefixOf(
  acc: StreamAccumulator,
  index: number,
  incomingValue: string,
): boolean {
  const buffer = acc.reasoningSegmentsByRow.get(index)
  if (!buffer) {
    const detail = acc.reasoningList[index]
    return detail ? incomingValue.startsWith(reasoningDetailValue(detail)) : true
  }
  let offset = 0
  for (const fragment of buffer.sections) {
    if (!incomingValue.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  for (const fragment of buffer.pendingParts) {
    if (!incomingValue.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  return true
}

function findStructuredReasoningDetailTarget(
  acc: StreamAccumulator,
  incoming: ReasoningDetail,
): number | undefined {
  const byId = incoming.id ? acc.reasoningRowById.get(incoming.id) : undefined
  if (byId !== undefined) return byId
  for (let index = acc.reasoningList.length - 1; index >= 0; index -= 1) {
    const existing = acc.reasoningList[index]
    if (!existing || existing.type !== incoming.type) continue
    if (existing.id && incoming.id && existing.id !== incoming.id) continue
    if (existing.index === incoming.index) return index
  }
  return undefined
}

function geminiSummarySectionDelta(
  acc: StreamAccumulator,
  index: number,
  incoming: ReasoningDetail,
): ReasoningDetail {
  if (
    incoming.type !== 'reasoning.summary' ||
    incoming.format !== 'google-gemini-v1' ||
    incoming.summary.length === 0 ||
    reasoningRowLength(acc, index) === 0 ||
    reasoningRowEndsWithBlankLine(acc, index) ||
    /^\s*\n/u.test(incoming.summary)
  ) {
    return incoming
  }
  return { ...incoming, summary: `\n\n${incoming.summary}` }
}

function reasoningRowEndsWithBlankLine(acc: StreamAccumulator, index: number): boolean {
  const buffer = acc.reasoningSegmentsByRow.get(index)
  const fragments = buffer
    ? [...buffer.sections, ...buffer.pendingParts]
    : [reasoningDetailValue(acc.reasoningList[index] as ReasoningDetail)]
  for (let fragmentIndex = fragments.length - 1; fragmentIndex >= 0; fragmentIndex -= 1) {
    const fragment = fragments[fragmentIndex] as string
    for (let charIndex = fragment.length - 1; charIndex >= 0; charIndex -= 1) {
      const char = fragment[charIndex]
      if (char === '\n') return true
      if (char !== ' ' && char !== '\t' && char !== '\r') return false
    }
  }
  return false
}

function isAnthropicReasoningSnapshot(
  detail: ReasoningDetail,
): detail is Extract<ReasoningDetail, { type: 'reasoning.text' }> {
  return detail.type === 'reasoning.text' && detail.format === 'anthropic-claude-v1'
}

function findAnthropicReasoningSnapshotTarget(
  acc: StreamAccumulator,
  incoming: Extract<ReasoningDetail, { type: 'reasoning.text' }>,
): number | undefined {
  if (incoming.id) {
    const byId = acc.reasoningRowById.get(incoming.id)
    if (byId !== undefined) return byId
  }
  if (incoming.index === undefined) return undefined
  for (let index = acc.reasoningList.length - 1; index >= 0; index -= 1) {
    const existing = acc.reasoningList[index]
    if (
      existing?.type === 'reasoning.text' &&
      existing.index === incoming.index &&
      (existing.format === undefined || existing.format === 'anthropic-claude-v1') &&
      (!existing.id || !incoming.id || existing.id === incoming.id)
    ) {
      return index
    }
  }
  return undefined
}

function replaceAnthropicReasoningSnapshot(
  acc: StreamAccumulator,
  index: number,
  incoming: Extract<ReasoningDetail, { type: 'reasoning.text' }>,
): void {
  const existing = acc.reasoningList[index]
  if (existing?.type !== 'reasoning.text') {
    replaceReasoningRow(acc, index, incoming)
    return
  }
  const next = {
    ...existing,
    ...incoming,
    ...(incoming.text === undefined
      ? { text: reasoningDetailValueAt(acc, index) }
      : { text: incoming.text }),
  } satisfies ReasoningDetail
  replaceReasoningRow(acc, index, next)
}

function putReasoningDelta(
  acc: StreamAccumulator,
  incoming: ReasoningDetail,
  replace: boolean,
): void {
  if (!incoming.id) {
    putReasoningDetail(acc, incoming)
    return
  }
  const existingIndex =
    acc.reasoningRowById.get(incoming.id) ?? findUnidentifiedReasoningDeltaTarget(acc, incoming)
  if (existingIndex === undefined) {
    pushReasoningDeltaRow(acc, incoming)
    return
  }
  acc.reasoningRowById.set(incoming.id, existingIndex)
  const existing = acc.reasoningList[existingIndex]
  if (existing?.type === incoming.type) {
    acc.reasoningCumulativeValueByRow.delete(existingIndex)
    appendReasoningDelta(acc, existingIndex, incoming, replace)
    return
  }
  replaceReasoningRow(acc, existingIndex, incoming)
}

function pushReasoningRow(acc: StreamAccumulator, incoming: ReasoningDetail): void {
  const index = acc.reasoningList.length
  acc.reasoningList.push(incoming)
  acc.reasoningLength += reasoningDetailLength(incoming)
  if (incoming.id) acc.reasoningRowById.set(incoming.id, index)
}

function pushReasoningDeltaRow(acc: StreamAccumulator, incoming: ReasoningDetail): void {
  const index = acc.reasoningList.length
  const field = reasoningSegmentField(incoming)
  const value = reasoningDetailValue(incoming)
  const sections: string[] = []
  const pendingParts: string[] = []
  const pendingLength = appendTextToSections(sections, pendingParts, 0, value)
  acc.reasoningList.push(withReasoningDetailValue(incoming, ''))
  acc.reasoningSegmentsByRow.set(index, {
    field,
    sections,
    pendingParts,
    pendingLength,
    length: value.length,
  })
  acc.reasoningLength += value.length
  if (incoming.id) acc.reasoningRowById.set(incoming.id, index)
}

function appendReasoningDelta(
  acc: StreamAccumulator,
  index: number,
  incoming: ReasoningDetail,
  replace: boolean,
): void {
  const field = reasoningSegmentField(incoming)
  const incomingValue = reasoningDetailValue(incoming)
  let buffer = acc.reasoningSegmentsByRow.get(index)
  const existing = acc.reasoningList[index]
  if (!existing || existing.type !== incoming.type || (buffer && buffer.field !== field)) {
    replaceReasoningRow(acc, index, incoming)
    return
  }
  if (!buffer) {
    const existingValue = reasoningDetailValue(existing)
    const sections: string[] = []
    const pendingParts: string[] = []
    const pendingLength = appendTextToSections(sections, pendingParts, 0, existingValue)
    buffer = { field, sections, pendingParts, pendingLength, length: existingValue.length }
    acc.reasoningSegmentsByRow.set(index, buffer)
  }
  acc.reasoningList[index] = withReasoningDetailValue({ ...existing, ...incoming }, '')
  if (replace) {
    acc.reasoningLength -= buffer.length
    buffer.sections = []
    buffer.pendingParts = []
    buffer.pendingLength = 0
    buffer.length = 0
  }
  buffer.pendingLength = appendTextToSections(
    buffer.sections,
    buffer.pendingParts,
    buffer.pendingLength,
    incomingValue,
  )
  buffer.length += incomingValue.length
  acc.reasoningLength += incomingValue.length
}

function mergeReasoningRow(acc: StreamAccumulator, index: number, incoming: ReasoningDetail): void {
  const existing = materializeReasoningRow(acc, index)
  replaceReasoningRow(acc, index, mergeReasoningDetail(existing, incoming))
}

function replaceReasoningRow(
  acc: StreamAccumulator,
  index: number,
  incoming: ReasoningDetail,
): void {
  const existingLength = reasoningRowLength(acc, index)
  acc.reasoningSegmentsByRow.delete(index)
  acc.reasoningCumulativeValueByRow.delete(index)
  acc.reasoningList[index] = incoming
  acc.reasoningLength += reasoningDetailLength(incoming) - existingLength
  if (incoming.id) acc.reasoningRowById.set(incoming.id, index)
}

function materializeReasoningRow(
  acc: StreamAccumulator,
  index: number,
): ReasoningDetail | undefined {
  const detail = acc.reasoningList[index]
  if (!detail) return undefined
  const buffer = acc.reasoningSegmentsByRow.get(index)
  if (!buffer) return detail
  const materialized = withReasoningDetailValue(
    detail,
    joinTextSections(buffer.sections, buffer.pendingParts),
  )
  acc.reasoningList[index] = materialized
  acc.reasoningSegmentsByRow.delete(index)
  return materialized
}

function materializedReasoningDetail(
  acc: StreamAccumulator,
  index: number,
  detail: ReasoningDetail,
): ReasoningDetail {
  const buffer = acc.reasoningSegmentsByRow.get(index)
  return buffer
    ? withReasoningDetailValue(detail, joinTextSections(buffer.sections, buffer.pendingParts))
    : detail
}

function reasoningRowLength(acc: StreamAccumulator, index: number): number {
  return (
    acc.reasoningSegmentsByRow.get(index)?.length ?? reasoningDetailLength(acc.reasoningList[index])
  )
}

function reasoningDetailValueAt(acc: StreamAccumulator, index: number): string {
  const buffer = acc.reasoningSegmentsByRow.get(index)
  if (buffer) return joinTextSections(buffer.sections, buffer.pendingParts)
  const detail = acc.reasoningList[index]
  return detail ? reasoningDetailValue(detail) : ''
}

function reasoningDetailLength(detail: ReasoningDetail | undefined): number {
  return detail ? reasoningDetailValue(detail).length : 0
}

function reasoningSegmentField(detail: ReasoningDetail): ReasoningSegmentField {
  if (detail.type === 'reasoning.text') return 'text'
  if (detail.type === 'reasoning.summary') return 'summary'
  return 'data'
}

function reasoningDetailValue(detail: ReasoningDetail): string {
  if (detail.type === 'reasoning.text') return detail.text ?? ''
  if (detail.type === 'reasoning.summary') return detail.summary
  return detail.data
}

function withReasoningDetailValue(detail: ReasoningDetail, value: string): ReasoningDetail {
  if (detail.type === 'reasoning.text') return { ...detail, text: value }
  if (detail.type === 'reasoning.summary') return { ...detail, summary: value }
  return { ...detail, data: value }
}

function findUnidentifiedReasoningDeltaTarget(
  acc: StreamAccumulator,
  incoming: ReasoningDetail,
): number | undefined {
  for (let index = acc.reasoningList.length - 1; index >= 0; index -= 1) {
    const existing = acc.reasoningList[index]
    if (!existing || existing.id !== undefined || existing.type !== incoming.type) continue
    if (existing.index === incoming.index) return index
  }
  return undefined
}

function syntheticReasoningDetailId(
  type: ReasoningDetail['type'],
  event: Extract<StreamLaneEvent, { lane: 'reasoning' }>,
): string | undefined {
  if (type === 'reasoning.summary') {
    if (event.itemId) return `summary#${event.itemId}#${event.summaryIndex ?? 0}`
    if (event.summaryIndex !== undefined) {
      return event.outputIndex !== undefined
        ? `summary#${event.outputIndex}#${event.summaryIndex}`
        : `summary#${event.summaryIndex}`
    }
    return event.outputIndex !== undefined ? `summary#${event.outputIndex}` : 'summary#default'
  }
  if (event.itemId) {
    return type === 'reasoning.text' ? `text#${event.itemId}` : `encrypted#${event.itemId}`
  }
  if (event.outputIndex !== undefined) {
    return type === 'reasoning.text'
      ? `text#${event.outputIndex}`
      : `encrypted#${event.outputIndex}`
  }
  if (type === 'reasoning.text') return 'text#default'
  return 'encrypted#default'
}

function assistantContentWithStreamPrefix(
  initialContent: readonly ContentItem[],
  streamedText: string,
  generatedContent: readonly ContentItem[] = [],
): ContentItem[] {
  const prefix = initialContent
    .filter(
      (item): item is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
        item.type === 'text' || item.type === 'output_text',
    )
    .map((item) => item.text)
    .join('')
  const nonText = initialContent.filter(
    (item) => item.type !== 'text' && item.type !== 'output_text',
  )
  const text = prefix.length > 0 ? `${prefix}${streamedText}` : streamedText
  return [
    { type: 'output_text', text },
    ...structuredClone(nonText),
    ...structuredClone(generatedContent),
  ]
}

function assistantContentWithStreamSections(
  initialContent: readonly ContentItem[],
  streamedSections: readonly string[],
  generatedContent: readonly ContentItem[] = [],
): ContentItem[] {
  const prefix = initialContent
    .filter(
      (item): item is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
        item.type === 'text' || item.type === 'output_text',
    )
    .map((item) => item.text)
    .join('')
  const nonText = initialContent.filter(
    (item) => item.type !== 'text' && item.type !== 'output_text',
  )
  const textItems: ContentItem[] = []
  if (prefix.length > 0) {
    const first = streamedSections[0]
    if (first !== undefined) {
      textItems.push({ type: 'output_text', text: `${prefix}${first}` })
      for (let index = 1; index < streamedSections.length; index += 1) {
        const section = streamedSections[index]
        if (section) textItems.push({ type: 'output_text', text: section })
      }
    } else {
      textItems.push({ type: 'output_text', text: prefix })
    }
  } else {
    for (const section of streamedSections) {
      if (section.length > 0) textItems.push({ type: 'output_text', text: section })
    }
  }
  if (textItems.length === 0) textItems.push({ type: 'output_text', text: '' })
  return [...textItems, ...structuredClone(nonText), ...structuredClone(generatedContent)]
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
  const item: ContentItem = {
    type: 'audio_output',
    format,
    ...(transcript.length > 0 ? { transcript } : {}),
  }
  if (joined.length > 0) {
    item.url =
      format === 'pcm16'
        ? pcm16DataUrlToWav(joined, { sampleRate: 24_000, channels: 1 })
        : `data:audio/${format};base64,${joined}`
  }
  return [item]
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
  return HOSTED_SERVER_TOOL_ITEM_TYPES.has(item.type) || item.type.endsWith('_tool_result')
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
  upsertServerTool(acc.serverTools, {
    type: event.itemType,
    source: 'stream-status',
    id: event.itemId,
    status: event.status,
    outputIndex: event.outputIndex,
    ...(event.partialImageB64 ? { output: { partialImageB64: event.partialImageB64 } } : {}),
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
  if (typeof record.type !== 'string' || !HOSTED_SERVER_TOOL_ITEM_TYPES.has(record.type)) return
  upsertServerTool(acc.serverTools, {
    type: record.type,
    source: fallbackSource,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    outputIndex,
    output: structuredClone(item),
  })
}

function recordResponsesOutputItem(
  acc: StreamAccumulator,
  item: unknown,
  outputIndex: number,
): void {
  const providerItem = providerOutputItemFromResponsesItem(item, outputIndex)
  if (!providerItem) return
  upsertProviderOutputItem(acc.providerOutputItems, providerItem)
}

function recordProviderOutputItem(
  acc: StreamAccumulator,
  type: string,
  output: unknown,
  outputIndex: number,
): void {
  const providerItem = type.startsWith('google:')
    ? providerOutputItemFromGeminiPart(type, output, outputIndex)
    : type === 'server_tool_use' || type.endsWith('_tool_result')
      ? providerOutputItemFromResponsesItem(output, outputIndex)
      : null
  if (!providerItem) return
  upsertProviderOutputItem(acc.providerOutputItems, providerItem)
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
      output: { [key]: value },
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
  for (const record of records) upsertServerTool(merged, record)
  return merged
}

function upsertServerTool(
  records: GenerationServerToolCall[],
  incoming: GenerationServerToolCall,
): void {
  const key = serverToolRecordKey(incoming)
  const index = records.findIndex((record) => serverToolRecordKey(record) === key)
  if (index < 0) {
    records.push(structuredClone(incoming))
    return
  }
  const existing = records[index]
  if (!existing) return
  records[index] = {
    ...existing,
    ...structuredClone(incoming),
    source:
      incoming.source === 'responses-output' || existing.source !== 'responses-output'
        ? incoming.source
        : existing.source,
  }
}

function upsertProviderOutputItem(
  records: ProviderOutputItem[],
  incoming: ProviderOutputItem,
): void {
  const key = providerOutputItemKey(incoming)
  const index = records.findIndex((record) => providerOutputItemKey(record) === key)
  if (index < 0) {
    records.push(structuredClone(incoming))
    return
  }
  records[index] = structuredClone(incoming)
}

function providerOutputItemKey(record: ProviderOutputItem): string {
  const rawItem = record.item
  const item =
    rawItem !== null && typeof rawItem === 'object'
      ? (rawItem as {
          id?: unknown
          call_id?: unknown
          executableCode?: { id?: unknown }
          codeExecutionResult?: { id?: unknown }
        })
      : undefined
  if (typeof item?.id === 'string') return `id:${item.id}`
  if (typeof item?.call_id === 'string') return `call:${record.type}:${item.call_id}`
  if (typeof item?.executableCode?.id === 'string') {
    return `gemini-code:${item.executableCode.id}:exec`
  }
  if (typeof item?.codeExecutionResult?.id === 'string') {
    return `gemini-code:${item.codeExecutionResult.id}:result`
  }
  if (record.outputIndex !== undefined) {
    return `idx:${record.outputIndex}:${record.type}:${Object.keys(item ?? {}).join(',')}`
  }
  return `${record.dialect}:${record.type}:${JSON.stringify(record.item).slice(0, 128)}`
}

function serverToolRecordKey(record: GenerationServerToolCall): string {
  if (record.id) return `id:${record.id}:${record.type}`
  if (record.outputIndex !== undefined) return `idx:${record.outputIndex}:${record.type}`
  return `usage:${record.type}`
}

function replayableStreamEvent(event: unknown): StreamLaneEvent | null {
  if (!event || typeof event !== 'object') return null
  const lane = (event as { lane?: unknown }).lane
  if (typeof lane !== 'string') return null
  switch (lane) {
    case 'text':
    case 'reasoning':
    case 'usage':
    case 'finish':
    case 'terminal':
    case 'meta':
    case 'content-item':
    case 'audio-output':
    case 'server-tool':
    case 'server-tool-output':
    case 'output-item-added':
    case 'output-item-done':
    case 'phase':
    case 'integrity':
    case 'error':
    case 'buffered':
    case 'keepalive':
    case 'tool-call':
      return event as StreamLaneEvent
    default:
      return null
  }
}

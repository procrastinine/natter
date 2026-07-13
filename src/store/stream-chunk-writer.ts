import type { StreamLaneEvent } from '../api/stream-transforms'
import { toPersistedAttemptFailure } from '../core/attempt-outcome'
import {
  findMergeTargetIndex,
  mergeReasoningDetail,
  normalizeIncomingReasoningDetail,
} from '../core/reasoning'
import { STREAM_DURABLE_BATCH_TEXT_CHARS } from '../core/stream-accumulator'
import type { ChatId, MessageId, ReasoningDetail } from '../core/types'
import { errorFromUnknown } from '../lib/error'
import type { StreamChunkRow, StreamWriteFence } from './repository'

const STREAM_CHUNK_FLUSH_INTERVAL_MS = 150
const STREAM_CHUNK_FLUSH_MAX_ROWS = 256
const STREAM_CHUNK_FLUSH_MAX_TEXT_CHARS = STREAM_DURABLE_BATCH_TEXT_CHARS
const STREAM_CHUNK_BACKPRESSURE_MAX_ROWS = 512
const STREAM_CHUNK_BACKPRESSURE_MAX_BYTES = 256 * 1024
const STREAM_CHUNK_RECOVERY_MAX_ROWS = 2_048
const STREAM_CHUNK_RECOVERY_MAX_BYTES = 4 * 1024 * 1024
const SHARED_APPEND_MAX_ROWS = 2_048
const SHARED_APPEND_MAX_BYTES = 4 * 1024 * 1024

const RECOVERABLE_OUTPUT_ITEM_TYPES = new Set<string>([
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

export interface StreamChunkAppendPort {
  appendStreamChunks(chunks: readonly StreamChunkRow[]): Promise<void>
}

interface SharedStreamChunkAppendRequest {
  rows: readonly StreamChunkRow[]
  resolve: () => void
  reject: (error: unknown) => void
}

interface SharedStreamChunkAppendQueue {
  requests: SharedStreamChunkAppendRequest[]
  draining: boolean
  scheduled: boolean
}

const sharedStreamChunkAppendQueues = new WeakMap<
  StreamChunkAppendPort,
  SharedStreamChunkAppendQueue
>()

type StreamChunkWriterStatus = 'open' | 'flushing' | 'degraded' | 'failed' | 'closed'

interface StreamChunkWriterSnapshot {
  status: StreamChunkWriterStatus
  bufferedRows: number
  bufferedBytes: number
  failure?: unknown
}

export interface StreamChunkWriter {
  append(event: StreamLaneEvent, now: number): void
  flush(request: { mode: 'scheduled'; now: number }): void
  flush(request?: { mode: 'immediate' }): Promise<void>
  backpressure(): Promise<void> | undefined
  settle(): Promise<void>
  release(): void
  inspect(): StreamChunkWriterSnapshot
}

interface StreamChunkWriterInput {
  port: StreamChunkAppendPort
  chatId: ChatId
  streamId: string
  messageId: MessageId
  now: number
  fence: StreamWriteFence
}

export function createStreamChunkWriter(input: StreamChunkWriterInput): StreamChunkWriter {
  return new BufferedStreamChunkWriter(input)
}

type TextStreamEvent = Extract<StreamLaneEvent, { lane: 'text' }>
type ReasoningStreamEvent = Extract<StreamLaneEvent, { lane: 'reasoning' }>
type ToolCallStreamEvent = Extract<StreamLaneEvent, { lane: 'tool-call' }>

type BufferedStreamEvent =
  | { kind: 'plain'; event: StreamLaneEvent }
  | { kind: 'text'; template: TextStreamEvent; sections: string[] }
  | {
      kind: 'reasoning-append'
      field: 'textDelta' | 'summaryDelta'
      template: ReasoningStreamEvent
      sections: string[]
    }
  | {
      kind: 'reasoning-detail-append'
      field: 'text' | 'summary' | 'data'
      template: ReasoningStreamEvent
      detailTemplate: Record<string, unknown>
      sections: string[]
    }
  | { kind: 'tool-call-append'; template: ToolCallStreamEvent; sections: string[] }

interface BufferedStreamChunk {
  event: BufferedStreamEvent
  firstCreatedAt: number
  lastCreatedAt: number
  logicalRows: number
  logicalBytes: number
  textLength: number
  persistedRows?: StreamChunkRow[]
}

interface ExactStructuredReasoningDetail {
  detail: ReasoningDetail
  rawDetail: Record<string, unknown>
  rawField: 'text' | 'summary' | 'data'
  mode: 'delta' | 'snapshot' | 'cumulative'
}

interface TrackedStructuredReasoningRow {
  detail: ReasoningDetail
  ids: Set<string>
  valueSections: string[]
  pendingValueParts: string[]
  pendingValueLength: number
  valueLength: number
}

class BufferedStreamChunkWriter implements StreamChunkWriter {
  private readonly port: StreamChunkAppendPort
  private readonly chatId: ChatId
  private readonly streamId: string
  private readonly messageId: MessageId
  private readonly fence: StreamWriteFence
  private buffer: BufferedStreamChunk[] = []
  private nextSeq = 0
  private nextLogicalSeq = 0
  private pendingFlush?: Promise<void>
  private flushTimer?: ReturnType<typeof setTimeout>
  private lastFlushAt: number
  private bufferedLogicalRows = 0
  private bufferedTextLength = 0
  private bufferedBytes = 0
  private persistedGenerationId?: string
  private persistedModel?: string
  private persistedProvider?: string
  private structuredReasoningRows: TrackedStructuredReasoningRow[] = []
  private structuredReasoningTrackingReliable = true
  private lastChunkReceivedAt: number
  private status: StreamChunkWriterStatus = 'open'
  private failure?: unknown
  private consecutiveFailures = 0

  constructor(input: StreamChunkWriterInput) {
    this.port = input.port
    this.chatId = input.chatId
    this.streamId = input.streamId
    this.messageId = input.messageId
    this.fence = input.fence
    this.lastFlushAt = input.now
    this.lastChunkReceivedAt = input.now
  }

  append(event: StreamLaneEvent, now: number): void {
    this.assertAccepting()
    this.lastChunkReceivedAt = now
    if (!shouldPersistStreamEvent(event)) return
    const serialized = this.serialize(event)
    if (!serialized) return
    const logicalRow: StreamChunkRow = {
      id: `${this.streamId}:${this.nextLogicalSeq}`,
      streamId: this.streamId,
      chatId: this.chatId,
      messageId: this.messageId,
      seq: this.nextLogicalSeq,
      createdAt: now,
      event: serialized,
      fenceToken: this.fence.fenceToken,
      replacementEpoch: this.fence.replacementEpoch,
    }
    const textLength = streamEventTextLength(serialized)
    const bytes = estimateStreamChunkBytes(logicalRow)
    if (this.consecutiveFailures > 0) {
      this.assertRecoveryCapacity(this.bufferedLogicalRows + 1, this.bufferedBytes + bytes)
    }
    const tail = this.buffer.at(-1)
    if (!tail || !coalesceStreamEvent(tail, serialized, now, bytes, textLength)) {
      this.buffer.push(createBufferedStreamChunk(serialized, now, bytes, textLength))
    }
    this.nextLogicalSeq += 1
    this.bufferedLogicalRows += 1
    this.bufferedTextLength += textLength
    this.bufferedBytes += bytes
  }

  flush(request: { mode: 'scheduled'; now: number }): void
  flush(request?: { mode: 'immediate' }): Promise<void>
  flush(
    request?: { mode: 'scheduled'; now: number } | { mode: 'immediate' },
  ): void | Promise<void> {
    if (request?.mode === 'scheduled') {
      this.scheduleFlush(request.now)
      return
    }
    return this.flushNow('immediate')
  }

  backpressure(): Promise<void> | undefined {
    this.assertAccepting()
    if (!this.backpressureThresholdReached()) return
    return this.drainBackpressure()
  }

  async settle(): Promise<void> {
    this.clearFlushTimer()
    try {
      while (this.pendingFlush || this.buffer.length > 0) {
        try {
          if (this.pendingFlush) {
            await this.pendingFlush
          } else {
            await this.flushNow('immediate')
          }
        } catch (error) {
          if (this.status !== 'degraded') throw error
        }
      }
      this.throwIfUnresolvedFailure()
    } finally {
      this.clearFlushTimer()
    }
  }

  release(): void {
    if (this.status === 'closed') return
    this.status = 'closed'
    this.buffer = []
    this.bufferedLogicalRows = 0
    this.bufferedTextLength = 0
    this.bufferedBytes = 0
    this.structuredReasoningRows = []
    this.structuredReasoningTrackingReliable = false
    this.clearFlushTimer()
  }

  inspect(): StreamChunkWriterSnapshot {
    return {
      status: this.status,
      bufferedRows: this.bufferedLogicalRows,
      bufferedBytes: this.bufferedBytes,
      ...(this.failure !== undefined ? { failure: this.failure } : {}),
    }
  }

  private serialize(event: StreamLaneEvent): StreamLaneEvent | null {
    if (event.lane === 'meta') {
      const meta: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
      let dirty = false
      if (event.generationId !== undefined && this.persistedGenerationId === undefined) {
        meta.generationId = event.generationId
        this.persistedGenerationId = event.generationId
        dirty = true
      }
      if (event.model !== undefined && event.model !== this.persistedModel) {
        meta.model = event.model
        this.persistedModel = event.model
        dirty = true
      }
      if (event.provider !== undefined && event.provider !== this.persistedProvider) {
        meta.provider = event.provider
        this.persistedProvider = event.provider
        dirty = true
      }
      return dirty ? meta : null
    }
    if (event.lane === 'output-item-added' || event.lane === 'output-item-done') {
      if (!isRecoverableOutputItem(event.item)) return null
    }
    if (event.lane === 'error') {
      const failure = toPersistedAttemptFailure(event.error, 'provider')
      return {
        lane: 'error',
        error: {
          kind: event.error.kind,
          code: failure.code,
          message: failure.message,
          ...(failure.statusCode !== undefined ? { httpStatus: failure.statusCode } : {}),
          midStream: failure.midStream ?? true,
          retryable: failure.retryable ?? false,
        },
      } as StreamLaneEvent
    }
    if (event.lane === 'reasoning') {
      return structuredClone(this.compactStructuredReasoningEvent(event))
    }
    return structuredClone(event)
  }

  private compactStructuredReasoningEvent(event: ReasoningStreamEvent): ReasoningStreamEvent {
    const exact = exactStructuredReasoningDetail(event)
    if (!exact) {
      if (reasoningEventMutatesReasoning(event)) {
        this.structuredReasoningRows = []
        this.structuredReasoningTrackingReliable = false
      }
      return event
    }
    if (exact.detail.id?.startsWith('tool_') || !this.structuredReasoningTrackingReliable) {
      return event
    }

    const target = this.findStructuredReasoningTarget(exact.detail, exact.mode)
    if (
      exact.mode === 'cumulative' &&
      target !== undefined &&
      cumulativeDetailCanBecomeDelta(this.structuredReasoningRows[target], exact.detail)
    ) {
      const tracked = this.structuredReasoningRows[target] as TrackedStructuredReasoningRow
      const incomingValue = reasoningDetailValue(exact.detail)
      const suffix = incomingValue.slice(tracked.valueLength)
      if (exact.detail.id) tracked.ids.add(exact.detail.id)
      replaceTrackedReasoningValue(
        tracked,
        withReasoningDetailValue({ ...tracked.detail, ...exact.detail }, incomingValue),
      )
      return {
        ...event,
        detailsMode: 'delta',
        details: [{ ...exact.rawDetail, [exact.rawField]: suffix }],
      }
    }

    this.learnStructuredReasoningDetail(target, exact.detail, exact.mode)
    return event
  }

  private findStructuredReasoningTarget(
    incoming: ReasoningDetail,
    mode: 'delta' | 'snapshot' | 'cumulative',
  ): number | undefined {
    if (incoming.id) {
      const byId = this.structuredReasoningRows.findIndex((row) =>
        row.ids.has(incoming.id as string),
      )
      if (byId >= 0) return byId
    }
    if (mode === 'snapshot') {
      if (isAnthropicReasoningText(incoming)) {
        for (let index = this.structuredReasoningRows.length - 1; index >= 0; index -= 1) {
          const existing = this.structuredReasoningRows[index]?.detail
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
      const target = findMergeTargetIndex(
        this.structuredReasoningRows.map(materializeTrackedReasoningDetail),
        incoming,
      )
      return target >= 0 ? target : undefined
    }
    for (let index = this.structuredReasoningRows.length - 1; index >= 0; index -= 1) {
      const existing = this.structuredReasoningRows[index]?.detail
      if (!existing || existing.type !== incoming.type) continue
      if (existing.id && incoming.id && existing.id !== incoming.id) continue
      if (existing.index === incoming.index) return index
    }
    return undefined
  }

  private learnStructuredReasoningDetail(
    target: number | undefined,
    incoming: ReasoningDetail,
    mode: 'delta' | 'snapshot' | 'cumulative',
  ): void {
    if (target === undefined) {
      this.structuredReasoningRows.push(createTrackedReasoningRow(incoming))
      return
    }
    const tracked = this.structuredReasoningRows[target]
    if (!tracked) return
    if (incoming.id) tracked.ids.add(incoming.id)
    if (tracked.detail.type !== incoming.type) {
      replaceTrackedReasoningValue(tracked, incoming)
      return
    }
    if (mode === 'delta') {
      appendTrackedReasoningDelta(tracked, incoming)
      return
    }
    if (mode === 'snapshot') {
      const next = isAnthropicReasoningText(incoming)
        ? ({ ...materializeTrackedReasoningDetail(tracked), ...incoming } as ReasoningDetail)
        : mergeReasoningDetail(materializeTrackedReasoningDetail(tracked), incoming)
      replaceTrackedReasoningValue(tracked, next)
      return
    }

    const incomingValue = reasoningDetailValue(incoming)
    if (
      incomingValue.length === tracked.valueLength &&
      incomingStartsWithTrackedReasoningValue(incomingValue, tracked)
    ) {
      replaceTrackedReasoningValue(
        tracked,
        withReasoningDetailValue({ ...tracked.detail, ...incoming }, incomingValue),
      )
      return
    }
    const replacesValue =
      incomingValue.length > tracked.valueLength &&
      incomingStartsWithTrackedReasoningValue(incomingValue, tracked)
    if (replacesValue) {
      replaceTrackedReasoningValue(
        tracked,
        withReasoningDetailValue({ ...tracked.detail, ...incoming }, incomingValue),
      )
    } else {
      appendTrackedReasoningDelta(tracked, incoming)
    }
  }

  private scheduleFlush(now: number): void {
    if (
      this.status === 'failed' ||
      this.status === 'closed' ||
      this.buffer.length === 0 ||
      this.pendingFlush
    ) {
      return
    }
    const dueIn = Math.max(0, STREAM_CHUNK_FLUSH_INTERVAL_MS - (now - this.lastFlushAt))
    const dueNow =
      this.bufferedLogicalRows >= STREAM_CHUNK_FLUSH_MAX_ROWS ||
      this.bufferedTextLength >= STREAM_CHUNK_FLUSH_MAX_TEXT_CHARS ||
      dueIn === 0
    if (!dueNow) {
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          delete this.flushTimer
          void this.runScheduledFlush()
        }, dueIn)
      }
      return
    }
    void this.runScheduledFlush()
  }

  private async runScheduledFlush(): Promise<void> {
    try {
      await this.flushNow('scheduled')
    } catch {
      // flushNow records the durability failure before a fire-and-forget schedule can observe it.
    }
  }

  private async flushNow(mode: 'scheduled' | 'immediate'): Promise<void> {
    if (this.status === 'closed') throw new Error('Stream chunk writer is closed')
    if (this.status === 'failed') throw this.failure
    this.clearFlushTimer()
    if (this.pendingFlush) {
      await this.pendingFlush
      if (mode === 'scheduled') return
    }
    this.throwIfTerminal()
    if (this.buffer.length === 0) return
    const batch = this.buffer
    const rows = batch.flatMap((entry) => this.materializeRows(entry))
    this.buffer = []
    this.bufferedLogicalRows = 0
    this.bufferedTextLength = 0
    this.bufferedBytes = 0
    this.status = 'flushing'
    let write: Promise<void>
    try {
      write = appendSharedStreamChunks(this.port, rows)
    } catch (error) {
      write = Promise.reject(errorFromUnknown(error))
    }
    const flush: Promise<void> = write
      .then(() => {
        if (this.status === 'closed') return
        this.consecutiveFailures = 0
        delete this.failure
        this.status = 'open'
      })
      .catch((error) => {
        if (this.status === 'closed') throw error
        this.buffer = [...batch, ...this.buffer]
        this.bufferedLogicalRows += batch.reduce((sum, entry) => sum + entry.logicalRows, 0)
        this.bufferedTextLength += batch.reduce((sum, entry) => sum + entry.textLength, 0)
        this.bufferedBytes += batch.reduce((sum, entry) => sum + entry.logicalBytes, 0)
        this.consecutiveFailures += 1
        this.failure = error
        if (
          this.consecutiveFailures >= 2 ||
          this.recoveryCapacityExceeded(this.bufferedLogicalRows, this.bufferedBytes)
        ) {
          this.status = 'failed'
          this.clearFlushTimer()
        } else {
          this.status = 'degraded'
        }
        throw error
      })
      .finally(() => {
        if (this.pendingFlush === flush) {
          delete this.pendingFlush
          this.lastFlushAt = this.lastChunkReceivedAt
          if (this.status !== 'failed' && this.status !== 'closed' && this.buffer.length > 0) {
            this.scheduleFlush(this.lastFlushAt)
          }
        }
      })
    this.pendingFlush = flush
    await flush
  }

  private materializeRows(chunk: BufferedStreamChunk): StreamChunkRow[] {
    if (chunk.persistedRows) return chunk.persistedRows
    const events = materializeBufferedEvents(chunk)
    const rows = events.map(({ event, createdAt }) => {
      const seq = this.nextSeq
      this.nextSeq += 1
      return {
        id: `${this.streamId}:${seq}`,
        streamId: this.streamId,
        chatId: this.chatId,
        messageId: this.messageId,
        seq,
        createdAt,
        event,
        fenceToken: this.fence.fenceToken,
        replacementEpoch: this.fence.replacementEpoch,
      }
    })
    chunk.persistedRows = rows
    return rows
  }

  private assertAccepting(): void {
    if (this.status === 'closed') throw new Error('Stream chunk writer is closed')
    this.throwIfTerminal()
  }

  private assertRecoveryCapacity(rows: number, bytes: number): void {
    if (!this.recoveryCapacityExceeded(rows, bytes)) return
    const failure = new Error(
      `Stream chunk recovery buffer exceeded ${STREAM_CHUNK_RECOVERY_MAX_ROWS} rows or ${STREAM_CHUNK_RECOVERY_MAX_BYTES} bytes`,
      this.failure !== undefined ? { cause: this.failure } : undefined,
    )
    failure.name = 'StreamChunkRecoveryCapacityError'
    this.failure = failure
    this.status = 'failed'
    this.clearFlushTimer()
    throw failure
  }

  private recoveryCapacityExceeded(rows: number, bytes: number): boolean {
    return rows > STREAM_CHUNK_RECOVERY_MAX_ROWS || bytes > STREAM_CHUNK_RECOVERY_MAX_BYTES
  }

  private backpressureThresholdReached(): boolean {
    return (
      this.bufferedLogicalRows >= STREAM_CHUNK_BACKPRESSURE_MAX_ROWS ||
      this.bufferedBytes >= STREAM_CHUNK_BACKPRESSURE_MAX_BYTES
    )
  }

  private async drainBackpressure(): Promise<void> {
    while (this.backpressureThresholdReached()) {
      try {
        await this.flushNow('immediate')
      } catch (error) {
        if (this.status === 'failed' || this.status === 'closed') throw error
        await this.flushNow('immediate')
      }
    }
  }

  private throwIfTerminal(): void {
    if (this.status === 'failed') throw this.failure
  }

  private throwIfUnresolvedFailure(): void {
    if (this.status === 'degraded' || this.status === 'failed') throw this.failure
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    delete this.flushTimer
  }
}

function appendSharedStreamChunks(
  port: StreamChunkAppendPort,
  rows: readonly StreamChunkRow[],
): Promise<void> {
  let queue = sharedStreamChunkAppendQueues.get(port)
  if (!queue) {
    queue = { requests: [], draining: false, scheduled: false }
    sharedStreamChunkAppendQueues.set(port, queue)
  }
  const promise = new Promise<void>((resolve, reject) => {
    queue.requests.push({ rows, resolve, reject })
  })
  if (!queue.draining && !queue.scheduled) {
    queue.scheduled = true
    queueMicrotask(() => {
      queue.scheduled = false
      void drainSharedStreamChunkAppends(port, queue)
    })
  }
  return promise
}

async function drainSharedStreamChunkAppends(
  port: StreamChunkAppendPort,
  queue: SharedStreamChunkAppendQueue,
): Promise<void> {
  if (queue.draining) return
  queue.draining = true
  try {
    while (queue.requests.length > 0) {
      const requests = takeSharedAppendBatch(queue.requests)
      await appendSharedRequestBatch(port, requests)
    }
  } finally {
    queue.draining = false
    if (queue.requests.length > 0 && !queue.scheduled) {
      queue.scheduled = true
      queueMicrotask(() => {
        queue.scheduled = false
        void drainSharedStreamChunkAppends(port, queue)
      })
    }
  }
}

function takeSharedAppendBatch(
  pending: SharedStreamChunkAppendRequest[],
): SharedStreamChunkAppendRequest[] {
  let requestCount = 0
  let rowCount = 0
  let bytes = 0
  for (const request of pending) {
    let requestBytes = 0
    for (const row of request.rows) requestBytes += estimateStreamChunkBytes(row)
    const exceedsBudget =
      requestCount > 0 &&
      (rowCount + request.rows.length > SHARED_APPEND_MAX_ROWS ||
        bytes + requestBytes > SHARED_APPEND_MAX_BYTES)
    if (exceedsBudget) break
    requestCount += 1
    rowCount += request.rows.length
    bytes += requestBytes
  }
  return pending.splice(0, Math.max(1, requestCount))
}

async function appendSharedRequestBatch(
  port: StreamChunkAppendPort,
  requests: readonly SharedStreamChunkAppendRequest[],
): Promise<void> {
  try {
    await port.appendStreamChunks(requests.flatMap((request) => request.rows))
    for (const request of requests) request.resolve()
  } catch (error) {
    const isolated = isStreamFenceFailure(error) ? groupRequestsByFence(requests) : []
    if (isolated.length <= 1) {
      for (const request of requests) request.reject(error)
      return
    }
    for (const group of isolated) await appendSharedRequestBatch(port, group)
  }
}

function groupRequestsByFence(
  requests: readonly SharedStreamChunkAppendRequest[],
): SharedStreamChunkAppendRequest[][] {
  const groups = new Map<string, SharedStreamChunkAppendRequest[]>()
  for (const request of requests) {
    const row = request.rows[0]
    const key = row
      ? `${row.streamId}\u0000${row.fenceToken ?? ''}\u0000${row.replacementEpoch ?? ''}`
      : ''
    const group = groups.get(key)
    if (group) group.push(request)
    else groups.set(key, [request])
  }
  return [...groups.values()]
}

function isStreamFenceFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('StreamFenceLost:') ||
      error.message.startsWith('StreamFenceMissing:'))
  )
}

function createBufferedStreamChunk(
  event: StreamLaneEvent,
  now: number,
  bytes: number,
  textLength: number,
): BufferedStreamChunk {
  return {
    event: bufferableStreamEvent(event),
    firstCreatedAt: now,
    lastCreatedAt: now,
    logicalRows: 1,
    logicalBytes: bytes,
    textLength,
  }
}

function bufferableStreamEvent(event: StreamLaneEvent): BufferedStreamEvent {
  if (event.lane === 'text') {
    return { kind: 'text', template: event, sections: [event.text] }
  }
  if (event.lane === 'reasoning') {
    const detailAppend = exactReasoningDetailAppend(event)
    if (detailAppend) {
      return {
        kind: 'reasoning-detail-append',
        field: detailAppend.field,
        template: event,
        detailTemplate: detailAppend.detail,
        sections: [detailAppend.value],
      }
    }
    const reasoningField = exactReasoningAppendField(event)
    if (reasoningField) {
      return {
        kind: 'reasoning-append',
        field: reasoningField,
        template: event,
        sections: [event[reasoningField] ?? ''],
      }
    }
  }
  if (event.lane === 'tool-call' && exactToolCallAppend(event)) {
    return { kind: 'tool-call-append', template: event, sections: [event.argumentsDelta] }
  }
  return { kind: 'plain', event }
}

function coalesceStreamEvent(
  chunk: BufferedStreamChunk,
  incoming: StreamLaneEvent,
  now: number,
  bytes: number,
  textLength: number,
): boolean {
  if (
    chunk.persistedRows ||
    chunk.logicalRows >= STREAM_CHUNK_FLUSH_MAX_ROWS ||
    chunk.textLength + textLength > STREAM_CHUNK_FLUSH_MAX_TEXT_CHARS
  ) {
    return false
  }
  const buffered = chunk.event
  if (buffered.kind === 'text') {
    if (incoming.lane !== 'text' || !sameTextTarget(buffered.template, incoming)) return false
    buffered.sections.push(incoming.text)
  } else if (buffered.kind === 'reasoning-append') {
    if (
      incoming.lane !== 'reasoning' ||
      exactReasoningAppendField(incoming) !== buffered.field ||
      !sameReasoningTarget(buffered.template, incoming)
    ) {
      return false
    }
    buffered.sections.push(incoming[buffered.field] ?? '')
  } else if (buffered.kind === 'reasoning-detail-append') {
    if (incoming.lane !== 'reasoning') return false
    const detailAppend = exactReasoningDetailAppend(incoming)
    if (
      !detailAppend ||
      detailAppend.field !== buffered.field ||
      !sameReasoningTarget(buffered.template, incoming) ||
      !sameReasoningDetailMetadata(buffered.detailTemplate, detailAppend.detail, buffered.field)
    ) {
      return false
    }
    buffered.sections.push(detailAppend.value)
  } else if (buffered.kind === 'tool-call-append') {
    if (
      incoming.lane !== 'tool-call' ||
      !exactToolCallAppend(incoming) ||
      !sameToolCallTarget(buffered.template, incoming)
    ) {
      return false
    }
    mergeToolCallMetadata(buffered.template, incoming)
    buffered.sections.push(incoming.argumentsDelta)
  } else {
    return false
  }
  chunk.lastCreatedAt = now
  chunk.logicalRows += 1
  chunk.logicalBytes += bytes
  chunk.textLength += textLength
  return true
}

function materializeBufferedEvents(
  chunk: BufferedStreamChunk,
): Array<{ event: StreamLaneEvent; createdAt: number }> {
  const buffered = chunk.event
  if (buffered.kind === 'plain') {
    return [{ event: buffered.event, createdAt: chunk.firstCreatedAt }]
  }
  if (buffered.kind === 'text') {
    const event: TextStreamEvent = {
      ...buffered.template,
      text: buffered.sections.join(''),
    }
    if (chunk.logicalRows > 1) delete event.chunkId
    return [{ event, createdAt: chunk.firstCreatedAt }]
  }
  if (buffered.kind === 'tool-call-append') {
    const event: ToolCallStreamEvent = {
      ...buffered.template,
      argumentsDelta: buffered.sections.join(''),
    }
    if (chunk.logicalRows > 1) delete event.chunkId
    return [{ event, createdAt: chunk.firstCreatedAt }]
  }
  if (buffered.kind === 'reasoning-detail-append') {
    const event: ReasoningStreamEvent = {
      ...buffered.template,
      details: [
        {
          ...buffered.detailTemplate,
          [buffered.field]: buffered.sections.join(''),
        },
      ],
    }
    if (chunk.logicalRows > 1) delete event.chunkId
    const events: Array<{ event: StreamLaneEvent; createdAt: number }> = [
      { event, createdAt: chunk.firstCreatedAt },
    ]
    if (chunk.logicalRows > 1 && chunk.lastCreatedAt !== chunk.firstCreatedAt) {
      events.push({ event: { lane: 'reasoning' }, createdAt: chunk.lastCreatedAt })
    }
    return events
  }
  const event: ReasoningStreamEvent = {
    ...buffered.template,
    [buffered.field]: buffered.sections.join(''),
  }
  if (chunk.logicalRows > 1) delete event.chunkId
  const events: Array<{ event: StreamLaneEvent; createdAt: number }> = [
    { event, createdAt: chunk.firstCreatedAt },
  ]
  if (chunk.logicalRows > 1 && chunk.lastCreatedAt !== chunk.firstCreatedAt) {
    events.push({ event: { lane: 'reasoning' }, createdAt: chunk.lastCreatedAt })
  }
  return events
}

function exactReasoningAppendField(
  event: ReasoningStreamEvent,
): 'textDelta' | 'summaryDelta' | undefined {
  if (
    event.details !== undefined ||
    event.encryptedDelta !== undefined ||
    event.replaceEncrypted !== undefined
  ) {
    return undefined
  }
  if (typeof event.textDelta === 'string' && event.summaryDelta === undefined) {
    return 'textDelta'
  }
  if (typeof event.summaryDelta === 'string' && event.textDelta === undefined) {
    return 'summaryDelta'
  }
  return undefined
}

function exactStructuredReasoningDetail(
  event: ReasoningStreamEvent,
): ExactStructuredReasoningDetail | null {
  if (
    event.details?.length !== 1 ||
    event.textDelta !== undefined ||
    event.summaryDelta !== undefined ||
    event.encryptedDelta !== undefined ||
    event.replaceEncrypted !== undefined
  ) {
    return null
  }
  const raw = event.details[0]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const rawDetail = raw as Record<string, unknown>
  if (
    (rawDetail.id !== undefined && typeof rawDetail.id !== 'string') ||
    (rawDetail.index !== undefined && typeof rawDetail.index !== 'number')
  ) {
    return null
  }
  const rawField =
    rawDetail.type === 'reasoning.text'
      ? 'text'
      : rawDetail.type === 'reasoning.summary'
        ? 'summary'
        : rawDetail.type === 'reasoning.encrypted'
          ? 'data'
          : undefined
  if (rawField === undefined || typeof rawDetail[rawField] !== 'string') return null
  const detail = normalizeIncomingReasoningDetail(rawDetail as unknown as ReasoningDetail)
  return {
    detail,
    rawDetail,
    rawField,
    mode: event.detailsMode ?? 'snapshot',
  }
}

function reasoningEventMutatesReasoning(event: ReasoningStreamEvent): boolean {
  return (
    (event.details?.length ?? 0) > 0 ||
    event.textDelta !== undefined ||
    event.summaryDelta !== undefined ||
    event.encryptedDelta !== undefined
  )
}

function cumulativeDetailCanBecomeDelta(
  tracked: TrackedStructuredReasoningRow | undefined,
  incoming: ReasoningDetail,
): boolean {
  if (!tracked || tracked.detail.type !== incoming.type) return false
  const incomingValue = reasoningDetailValue(incoming)
  if (
    incomingValue.length <= tracked.valueLength ||
    !incomingStartsWithTrackedReasoningValue(incomingValue, tracked)
  ) {
    return false
  }
  if (incoming.type !== 'reasoning.summary' || incoming.format !== 'google-gemini-v1') {
    return true
  }
  const suffix = incomingValue.slice(tracked.valueLength)
  return (
    tracked.valueLength === 0 ||
    trackedReasoningValueEndsWithBlankLine(tracked) ||
    /^\s*\n/u.test(suffix)
  )
}

function createTrackedReasoningRow(incoming: ReasoningDetail): TrackedStructuredReasoningRow {
  const tracked: TrackedStructuredReasoningRow = {
    detail: withoutReasoningDetailValue({ ...incoming }),
    ids: new Set(incoming.id ? [incoming.id] : []),
    valueSections: [],
    pendingValueParts: [],
    pendingValueLength: 0,
    valueLength: 0,
  }
  setTrackedReasoningValue(tracked, reasoningDetailValue(incoming))
  return tracked
}

function replaceTrackedReasoningValue(
  tracked: TrackedStructuredReasoningRow,
  incoming: ReasoningDetail,
): void {
  tracked.detail = withoutReasoningDetailValue({ ...incoming })
  setTrackedReasoningValue(tracked, reasoningDetailValue(incoming))
}

function setTrackedReasoningValue(tracked: TrackedStructuredReasoningRow, value: string): void {
  tracked.valueSections = value.length > 0 ? [value] : []
  tracked.pendingValueParts = []
  tracked.pendingValueLength = 0
  tracked.valueLength = value.length
}

function appendTrackedReasoningDelta(
  tracked: TrackedStructuredReasoningRow,
  incoming: ReasoningDetail,
): void {
  const incomingValue = reasoningDetailValue(incoming)
  if (
    tracked.detail.type === 'reasoning.summary' &&
    incoming.type === 'reasoning.summary' &&
    incoming.format === 'google-gemini-v1' &&
    incomingValue.length > 0 &&
    tracked.valueLength > 0 &&
    !trackedReasoningValueEndsWithBlankLine(tracked) &&
    !/^\s*\n/u.test(incomingValue)
  ) {
    appendTrackedReasoningValue(tracked, '\n\n')
  }
  appendTrackedReasoningValue(tracked, incomingValue)
  tracked.detail = withoutReasoningDetailValue({
    ...tracked.detail,
    ...incoming,
  })
}

function appendTrackedReasoningValue(tracked: TrackedStructuredReasoningRow, value: string): void {
  if (value.length === 0) return
  tracked.pendingValueParts.push(value)
  tracked.pendingValueLength += value.length
  tracked.valueLength += value.length
  if (tracked.pendingValueParts.length < 256 && tracked.pendingValueLength < 16 * 1024) return
  tracked.valueSections.push(
    tracked.pendingValueParts.length === 1
      ? (tracked.pendingValueParts[0] as string)
      : tracked.pendingValueParts.join(''),
  )
  tracked.pendingValueParts = []
  tracked.pendingValueLength = 0
}

function incomingStartsWithTrackedReasoningValue(
  incoming: string,
  tracked: TrackedStructuredReasoningRow,
): boolean {
  let offset = 0
  for (const fragment of tracked.valueSections) {
    if (!incoming.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  for (const fragment of tracked.pendingValueParts) {
    if (!incoming.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  return offset === tracked.valueLength
}

function trackedReasoningValueEndsWithBlankLine(tracked: TrackedStructuredReasoningRow): boolean {
  for (let index = tracked.pendingValueParts.length - 1; index >= 0; index -= 1) {
    const result = reasoningFragmentEndsWithBlankLine(tracked.pendingValueParts[index] as string)
    if (result !== undefined) return result
  }
  for (let index = tracked.valueSections.length - 1; index >= 0; index -= 1) {
    const result = reasoningFragmentEndsWithBlankLine(tracked.valueSections[index] as string)
    if (result !== undefined) return result
  }
  return false
}

function reasoningFragmentEndsWithBlankLine(fragment: string): boolean | undefined {
  for (let index = fragment.length - 1; index >= 0; index -= 1) {
    const char = fragment[index]
    if (char === '\n') return true
    if (char !== ' ' && char !== '\t' && char !== '\r') return false
  }
  return undefined
}

function materializeTrackedReasoningDetail(
  tracked: TrackedStructuredReasoningRow,
): ReasoningDetail {
  let value: string
  if (tracked.pendingValueParts.length === 0 && tracked.valueSections.length === 1) {
    value = tracked.valueSections[0] as string
  } else {
    const fragments = [...tracked.valueSections, ...tracked.pendingValueParts]
    value = fragments.length === 1 ? (fragments[0] as string) : fragments.join('')
  }
  return withReasoningDetailValue(tracked.detail, value)
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

function withoutReasoningDetailValue(detail: ReasoningDetail): ReasoningDetail {
  return withReasoningDetailValue(detail, '')
}

function isAnthropicReasoningText(
  detail: ReasoningDetail,
): detail is Extract<ReasoningDetail, { type: 'reasoning.text' }> {
  return detail.type === 'reasoning.text' && detail.format === 'anthropic-claude-v1'
}

function exactReasoningDetailAppend(event: ReasoningStreamEvent): {
  field: 'text' | 'summary' | 'data'
  detail: Record<string, unknown>
  value: string
} | null {
  if (
    event.detailsMode !== 'delta' ||
    event.details?.length !== 1 ||
    event.textDelta !== undefined ||
    event.summaryDelta !== undefined ||
    event.encryptedDelta !== undefined ||
    event.replaceEncrypted !== undefined
  ) {
    return null
  }
  const raw = event.details[0]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const detail = raw as Record<string, unknown>
  const type = detail.type
  const field =
    type === 'reasoning.text'
      ? 'text'
      : type === 'reasoning.summary'
        ? 'summary'
        : type === 'reasoning.encrypted'
          ? 'data'
          : undefined
  if (field === undefined || typeof detail[field] !== 'string') return null
  return { field, detail, value: detail[field] }
}

function sameReasoningDetailMetadata(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  valueField: 'text' | 'summary' | 'data',
): boolean {
  const leftKeys = Object.keys(left).filter((key) => key !== valueField)
  const rightKeys = Object.keys(right).filter((key) => key !== valueField)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || left[key] !== right[key]) return false
  }
  return true
}

function sameTextTarget(left: TextStreamEvent, right: TextStreamEvent): boolean {
  return left.outputIndex === right.outputIndex && left.contentIndex === right.contentIndex
}

function sameReasoningTarget(left: ReasoningStreamEvent, right: ReasoningStreamEvent): boolean {
  return (
    left.outputIndex === right.outputIndex &&
    left.itemId === right.itemId &&
    left.summaryIndex === right.summaryIndex
  )
}

function exactToolCallAppend(event: ToolCallStreamEvent): event is ToolCallStreamEvent & {
  argumentsDelta: string
} {
  return typeof event.argumentsDelta === 'string' && event.argumentsSnapshot === undefined
}

function sameToolCallTarget(left: ToolCallStreamEvent, right: ToolCallStreamEvent): boolean {
  return (
    left.index === right.index &&
    left.outputIndex === right.outputIndex &&
    (left.id === undefined || right.id === undefined || left.id === right.id) &&
    (left.name === undefined || right.name === undefined || left.name === right.name)
  )
}

function mergeToolCallMetadata(target: ToolCallStreamEvent, incoming: ToolCallStreamEvent): void {
  if (target.id === undefined && incoming.id !== undefined) target.id = incoming.id
  if (target.type === undefined && incoming.type !== undefined) target.type = incoming.type
  if (target.name === undefined && incoming.name !== undefined) target.name = incoming.name
}

function shouldPersistStreamEvent(event: StreamLaneEvent): boolean {
  switch (event.lane) {
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
    case 'error':
    case 'phase':
    case 'integrity':
    case 'tool-call':
      return true
    case 'buffered':
    case 'keepalive':
      return false
  }
}

function estimateStreamChunkBytes(row: StreamChunkRow): number {
  return (
    128 +
    2 * (row.id.length + row.streamId.length + row.chatId.length + row.messageId.length) +
    estimateValueBytes(row.event)
  )
}

function estimateValueBytes(root: unknown): number {
  const stack: unknown[] = [root]
  const seen = new Set<object>()
  let bytes = 0
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || value === undefined) {
      bytes += 4
    } else if (typeof value === 'string') {
      bytes += 2 * value.length
    } else if (typeof value === 'number' || typeof value === 'bigint') {
      bytes += 8
    } else if (typeof value === 'boolean') {
      bytes += 4
    } else if (typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      if (ArrayBuffer.isView(value)) {
        bytes += value.byteLength
      } else if (value instanceof ArrayBuffer) {
        bytes += value.byteLength
      } else if (Array.isArray(value)) {
        bytes += 16 + value.length * 8
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index])
      } else {
        bytes += 32
        for (const [key, nested] of Object.entries(value)) {
          bytes += 2 * key.length + 8
          stack.push(nested)
        }
      }
    }
    if (bytes > STREAM_CHUNK_RECOVERY_MAX_BYTES) return bytes
  }
  return bytes
}

function isRecoverableOutputItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const type = (item as { type?: unknown }).type
  return typeof type === 'string' && RECOVERABLE_OUTPUT_ITEM_TYPES.has(type)
}

function streamEventTextLength(event: StreamLaneEvent): number {
  if (event.lane === 'text') return event.text.length
  if (event.lane === 'reasoning') {
    return (
      (event.textDelta?.length ?? 0) +
      (event.summaryDelta?.length ?? 0) +
      (event.encryptedDelta?.length ?? 0) +
      reasoningDetailsTextLength(event.details)
    )
  }
  if (event.lane === 'audio-output') {
    return (event.dataDelta?.length ?? 0) + (event.transcriptDelta?.length ?? 0)
  }
  if (event.lane === 'tool-call') {
    return (event.argumentsDelta?.length ?? 0) + (event.argumentsSnapshot?.length ?? 0)
  }
  return 0
}

function reasoningDetailsTextLength(details: readonly unknown[] | undefined): number {
  if (!details) return 0
  let length = 0
  for (const raw of details) {
    if (!raw || typeof raw !== 'object') continue
    const detail = raw as { text?: unknown; summary?: unknown; data?: unknown }
    if (typeof detail.text === 'string') length += detail.text.length
    if (typeof detail.summary === 'string') length += detail.summary.length
    if (typeof detail.data === 'string') length += detail.data.length
  }
  return length
}

import { toPersistedAttemptFailure } from '../core/attempt-outcome'
import type { CanonicalStreamEventV2 } from '../core/generation-stream-events'
import { isResponsesProviderOutputItem } from '../core/provider-tool-context'
import { reasoningMutationPayloadLength } from '../core/reasoning-envelope'
import { STREAM_DURABLE_BATCH_TEXT_CHARS } from '../core/stream-accumulator'
import type { ChatId, MessageId, ReasoningEnvelopeMutationV2 } from '../core/types'
import { errorFromUnknown } from '../lib/error'
import { persistStreamEventV2 } from './persisted-stream-event'
import type { CanonicalStreamJournalFrameRow, StreamWriteFence } from './repository'
import {
  estimateStoredValueBytes,
  estimateStreamJournalFrameStorageBytes,
} from './storage-size-estimate'
import {
  type CanonicalStreamJournalFrameBatch,
  canonicalStreamJournalFrameBatch,
  createStreamJournalFrameCursor,
  STREAM_JOURNAL_APPEND_MAX_BYTES,
  STREAM_JOURNAL_APPEND_MAX_ROWS,
  type StreamJournalFrameCursor,
  type StreamJournalSemanticEntry,
} from './stream-journal-codec'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspacePhase, type WorkspaceReservedPermit } from './workspace-runtime'

const STREAM_JOURNAL_FLUSH_INTERVAL_MS = 150
const STREAM_JOURNAL_FLUSH_MAX_ROWS = 256
const STREAM_JOURNAL_FLUSH_MAX_TEXT_CHARS = STREAM_DURABLE_BATCH_TEXT_CHARS
const STREAM_JOURNAL_BACKPRESSURE_MAX_ROWS = 512
const STREAM_JOURNAL_BACKPRESSURE_MAX_BYTES = 256 * 1024
const STREAM_JOURNAL_RECOVERY_MAX_ROWS = 2_048
const STREAM_JOURNAL_RECOVERY_MAX_BYTES = 4 * 1024 * 1024
const SHARED_APPEND_MAX_ROWS = STREAM_JOURNAL_APPEND_MAX_ROWS
const SHARED_APPEND_MAX_BYTES = STREAM_JOURNAL_APPEND_MAX_BYTES
export const SHARED_APPEND_MAX_CONCURRENT_OWNERS = 8

export interface StreamJournalFrameAppendPort {
  appendStreamJournalFrames(
    permit: WorkspaceReservedPermit,
    frames: CanonicalStreamJournalFrameBatch,
  ): Promise<void>
}

export const workspaceStreamJournalFrameAppendPort: StreamJournalFrameAppendPort = Object.freeze({
  async appendStreamJournalFrames(
    permit: WorkspaceReservedPermit,
    frames: CanonicalStreamJournalFrameBatch,
  ): Promise<void> {
    if (frames.length === 0) return
    await getWorkspaceRepository().execute(permit, {
      kind: 'stream.append-journal-frames',
      frames,
      observedAt: Date.now(),
    })
  },
})

interface SharedStreamJournalAppendRequest {
  permit: WorkspaceReservedPermit
  cursor: StreamJournalFrameCursor
  resolve: () => void
  reject: (error: unknown) => void
  previous?: SharedStreamJournalAppendRequest
  next?: SharedStreamJournalAppendRequest
  queued: boolean
}

interface SharedStreamJournalAppendQueue {
  head?: SharedStreamJournalAppendRequest
  size: number
  draining: boolean
  scheduled: boolean
}

const sharedStreamJournalAppendQueues = new WeakMap<
  StreamJournalFrameAppendPort,
  SharedStreamJournalAppendQueue
>()

type StreamJournalWriterStatus = 'open' | 'flushing' | 'degraded' | 'failed' | 'closed'

interface StreamJournalWriterSnapshot {
  status: StreamJournalWriterStatus
  bufferedRows: number
  bufferedBytes: number
  failure?: unknown
}

export interface StreamJournalWriter {
  append(event: CanonicalStreamEventV2, now: number): void
  flush(request: { mode: 'scheduled'; now: number }): void
  flush(request?: { mode: 'immediate' }): Promise<void>
  checkpoint(): Promise<void>
  backpressure(): Promise<void> | undefined
  settle(): Promise<void>
  release(): void
  inspect(): StreamJournalWriterSnapshot
}

interface StreamJournalWriterInput {
  permit: WorkspaceReservedPermit
  port: StreamJournalFrameAppendPort
  chatId: ChatId
  streamId: string
  messageId: MessageId
  now: number
  fence: StreamWriteFence
}

export function createStreamJournalWriter(input: StreamJournalWriterInput): StreamJournalWriter {
  let resolveLifetime!: () => void
  const lifetime = new Promise<void>((resolve) => {
    resolveLifetime = resolve
  })
  const phase = runWorkspacePhase(input.permit, () => lifetime)
  void phase.catch(() => {})
  try {
    return new BufferedStreamJournalWriter(input, resolveLifetime)
  } catch (error) {
    resolveLifetime()
    throw error
  }
}

type TextStreamEvent = Extract<CanonicalStreamEventV2, { lane: 'text' }>
type ReasoningStreamEvent = Extract<CanonicalStreamEventV2, { lane: 'reasoning' }>
type ToolCallStreamEvent = Extract<CanonicalStreamEventV2, { lane: 'tool-call' }>

type BufferedStreamEvent =
  | { kind: 'plain'; event: CanonicalStreamEventV2 }
  | { kind: 'text'; template: TextStreamEvent; sections: string[] }
  | {
      kind: 'reasoning-append'
      template: ReasoningStreamEvent
      mutationTemplate: Extract<
        ReasoningEnvelopeMutationV2,
        { kind: 'visible-append' | 'carrier-append' }
      >
      sections: string[]
    }
  | { kind: 'tool-call-append'; template: ToolCallStreamEvent; sections: string[] }

interface BufferedJournalEntryBatch {
  event: BufferedStreamEvent
  firstCreatedAt: number
  lastCreatedAt: number
  logicalRows: number
  logicalBytes: number
  textLength: number
}

interface PendingStreamJournalBatch {
  readonly cursor: StreamJournalFrameCursor
  readonly logicalRows: number
  readonly logicalBytes: number
  readonly textLength: number
}

class BufferedStreamJournalWriter implements StreamJournalWriter {
  private readonly permit: WorkspaceReservedPermit
  private readonly port: StreamJournalFrameAppendPort
  private readonly chatId: ChatId
  private readonly streamId: string
  private readonly messageId: MessageId
  private readonly fence: StreamWriteFence
  private buffer: BufferedJournalEntryBatch[] = []
  private nextPhysicalSeq = 0
  private nextLogicalSeq = 0
  private retryBatch?: PendingStreamJournalBatch
  private pendingFlush?: Promise<void>
  private flushTimer?: ReturnType<typeof setTimeout>
  private lastFlushAt: number
  private bufferedLogicalRows = 0
  private bufferedTextLength = 0
  private bufferedBytes = 0
  private persistedGenerationId?: string
  private persistedModel?: string
  private persistedProvider?: string
  private lastChunkReceivedAt: number
  private status: StreamJournalWriterStatus = 'open'
  private failure?: unknown
  private consecutiveFailures = 0
  private readonly onRelease: () => void

  constructor(input: StreamJournalWriterInput, onRelease: () => void) {
    this.permit = input.permit
    this.port = input.port
    this.chatId = input.chatId
    this.streamId = input.streamId
    this.messageId = input.messageId
    this.fence = input.fence
    this.lastFlushAt = input.now
    this.lastChunkReceivedAt = input.now
    this.onRelease = onRelease
  }

  append(event: CanonicalStreamEventV2, now: number): void {
    this.assertAccepting()
    this.lastChunkReceivedAt = now
    if (!shouldPersistStreamEvent(event)) return
    const serialized = this.serialize(event)
    if (!serialized) return
    const textLength = streamEventTextLength(serialized)
    const bytes = estimateStoredValueBytes(serialized) + 128
    if (this.consecutiveFailures > 0) {
      this.assertRecoveryCapacity(this.bufferedLogicalRows + 1, this.bufferedBytes + bytes)
    }
    const tail = this.buffer.at(-1)
    if (!tail || !coalesceStreamEvent(tail, serialized, now, bytes, textLength)) {
      this.buffer.push(createBufferedJournalEntryBatch(serialized, now, bytes, textLength))
    }
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

  async checkpoint(): Promise<void> {
    try {
      await this.flushNow('immediate')
    } catch (error) {
      if (this.status !== 'degraded') throw error
      await this.flushNow('immediate')
    }
  }

  backpressure(): Promise<void> | undefined {
    this.assertAccepting()
    if (!this.backpressureThresholdReached()) return
    return this.drainBackpressure()
  }

  async settle(): Promise<void> {
    this.clearFlushTimer()
    try {
      while (this.pendingFlush || this.retryBatch || this.buffer.length > 0) {
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
    const pending = this.pendingFlush
    this.status = 'closed'
    this.buffer = []
    delete this.retryBatch
    this.bufferedLogicalRows = 0
    this.bufferedTextLength = 0
    this.bufferedBytes = 0
    this.clearFlushTimer()
    if (pending) void pending.then(this.onRelease, this.onRelease)
    else this.onRelease()
  }

  inspect(): StreamJournalWriterSnapshot {
    return {
      status: this.status,
      bufferedRows: this.bufferedLogicalRows,
      bufferedBytes: this.bufferedBytes,
      ...(this.failure !== undefined ? { failure: this.failure } : {}),
    }
  }

  private serialize(event: CanonicalStreamEventV2): CanonicalStreamEventV2 | null {
    if (event.lane === 'meta') {
      const meta: Extract<CanonicalStreamEventV2, { lane: 'meta' }> = { lane: 'meta' }
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
      const serialized = {
        lane: 'error',
        error: {
          kind: event.error.kind,
          code: failure.code,
          message: failure.message,
          ...(failure.statusCode !== undefined ? { httpStatus: failure.statusCode } : {}),
          midStream: failure.midStream ?? true,
          retryable: failure.retryable ?? false,
        },
      } satisfies Extract<CanonicalStreamEventV2, { lane: 'error' }>
      return serialized
    }
    const owned = structuredClone(event)
    if (owned.lane === 'result-snapshot') {
      if (owned.outcome.kind === 'error') {
        const failure = toPersistedAttemptFailure(owned.outcome.error, 'provider')
        const serialized = {
          ...owned,
          outcome: {
            kind: 'error',
            error: {
              kind: owned.outcome.error.kind,
              code: failure.code,
              message: failure.message,
              ...(failure.statusCode !== undefined ? { httpStatus: failure.statusCode } : {}),
              midStream: failure.midStream ?? true,
              retryable: failure.retryable ?? false,
            },
          },
        } satisfies Extract<CanonicalStreamEventV2, { lane: 'result-snapshot' }>
        return serialized
      }
      return owned
    }
    return owned
  }

  private scheduleFlush(now: number): void {
    if (
      this.status === 'failed' ||
      this.status === 'closed' ||
      (!this.retryBatch && this.buffer.length === 0) ||
      this.pendingFlush
    ) {
      return
    }
    const elapsed = Math.max(0, now - this.lastFlushAt)
    const dueIn = Math.max(0, STREAM_JOURNAL_FLUSH_INTERVAL_MS - elapsed)
    const dueNow =
      this.bufferedLogicalRows >= STREAM_JOURNAL_FLUSH_MAX_ROWS ||
      this.bufferedTextLength >= STREAM_JOURNAL_FLUSH_MAX_TEXT_CHARS ||
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
    if (this.status === 'closed') throw new Error('Stream journal writer is closed')
    if (this.status === 'failed') throw this.failure
    this.clearFlushTimer()
    if (this.pendingFlush) {
      await this.pendingFlush
      if (mode === 'scheduled') return
    }
    this.throwIfTerminal()
    if (!this.retryBatch && this.buffer.length === 0) return
    const pending = this.retryBatch ?? this.createPendingBatch()
    this.status = 'flushing'
    let write: Promise<void>
    try {
      write = appendSharedStreamFrames(this.port, this.permit, pending.cursor)
    } catch (error) {
      write = Promise.reject(errorFromUnknown(error))
    }
    const flush: Promise<void> = write
      .then(() => {
        if (this.status === 'closed') return
        this.consecutiveFailures = 0
        delete this.failure
        if (this.retryBatch === pending) delete this.retryBatch
        this.nextPhysicalSeq = pending.cursor.nextPhysicalSeq
        this.nextLogicalSeq = pending.cursor.nextLogicalSeq
        this.bufferedLogicalRows -= pending.logicalRows
        this.bufferedTextLength -= pending.textLength
        this.bufferedBytes -= pending.logicalBytes
        this.status = 'open'
      })
      .catch((error) => {
        if (this.status === 'closed') throw error
        this.retryBatch = pending
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
          if (
            this.status !== 'failed' &&
            this.status !== 'closed' &&
            (this.retryBatch || this.buffer.length > 0)
          ) {
            this.scheduleFlush(this.lastFlushAt)
          }
        }
      })
    this.pendingFlush = flush
    await flush
  }

  private createPendingBatch(): PendingStreamJournalBatch {
    const batches = this.buffer
    this.buffer = []
    const entries: StreamJournalSemanticEntry[] = []
    let logicalRows = 0
    let logicalBytes = 0
    let textLength = 0
    for (const batch of batches) {
      entries.push(...materializeBufferedJournalEntries(batch))
      logicalRows += batch.logicalRows
      logicalBytes += batch.logicalBytes
      textLength += batch.textLength
    }
    return {
      logicalRows,
      logicalBytes,
      textLength,
      cursor: createStreamJournalFrameCursor({
        streamId: this.streamId,
        chatId: this.chatId,
        messageId: this.messageId,
        fence: this.fence,
        entries,
        startPhysicalSeq: this.nextPhysicalSeq,
        startLogicalSeq: this.nextLogicalSeq,
      }),
    }
  }

  private assertAccepting(): void {
    if (this.status === 'closed') throw new Error('Stream journal writer is closed')
    this.throwIfTerminal()
  }

  private assertRecoveryCapacity(rows: number, bytes: number): void {
    if (!this.recoveryCapacityExceeded(rows, bytes)) return
    const failure = new Error(
      `Stream journal recovery buffer exceeded ${STREAM_JOURNAL_RECOVERY_MAX_ROWS} rows or ${STREAM_JOURNAL_RECOVERY_MAX_BYTES} bytes`,
      this.failure !== undefined ? { cause: this.failure } : undefined,
    )
    failure.name = 'StreamJournalRecoveryCapacityError'
    this.failure = failure
    this.status = 'failed'
    this.clearFlushTimer()
    throw failure
  }

  private recoveryCapacityExceeded(rows: number, bytes: number): boolean {
    return rows > STREAM_JOURNAL_RECOVERY_MAX_ROWS || bytes > STREAM_JOURNAL_RECOVERY_MAX_BYTES
  }

  private backpressureThresholdReached(): boolean {
    return (
      this.bufferedLogicalRows >= STREAM_JOURNAL_BACKPRESSURE_MAX_ROWS ||
      this.bufferedBytes >= STREAM_JOURNAL_BACKPRESSURE_MAX_BYTES
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

function appendSharedStreamFrames(
  port: StreamJournalFrameAppendPort,
  permit: WorkspaceReservedPermit,
  cursor: StreamJournalFrameCursor,
): Promise<void> {
  let queue = sharedStreamJournalAppendQueues.get(port)
  if (!queue) {
    queue = { size: 0, draining: false, scheduled: false }
    sharedStreamJournalAppendQueues.set(port, queue)
  }
  const promise = new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (publish: () => void) => {
      if (settled) return
      settled = true
      publish()
    }
    enqueueSharedAppendRequest(queue, {
      permit,
      cursor,
      resolve: () => settle(resolve),
      reject: (error) => settle(() => reject(errorFromUnknown(error))),
      queued: false,
    })
  })
  if (!queue.draining && !queue.scheduled) {
    queue.scheduled = true
    queueMicrotask(() => {
      queue.scheduled = false
      void drainSharedStreamJournalAppends(port, queue)
    })
  }
  return promise
}

async function drainSharedStreamJournalAppends(
  port: StreamJournalFrameAppendPort,
  queue: SharedStreamJournalAppendQueue,
): Promise<void> {
  if (queue.draining) return
  queue.draining = true
  try {
    while (queue.size > 0) {
      const frames = await takeSharedAppendRound(queue)
      if (frames.length > 0) await appendSharedFrameBatch(port, queue, frames)
    }
  } finally {
    queue.draining = false
    if (queue.size > 0 && !queue.scheduled) {
      queue.scheduled = true
      queueMicrotask(() => {
        queue.scheduled = false
        void drainSharedStreamJournalAppends(port, queue)
      })
    }
  }
}

interface SharedStreamJournalAppendFrame {
  readonly request: SharedStreamJournalAppendRequest
  readonly frame: CanonicalStreamJournalFrameRow
}

async function takeSharedAppendRound(
  queue: SharedStreamJournalAppendQueue,
): Promise<SharedStreamJournalAppendFrame[]> {
  const selected: SharedStreamJournalAppendFrame[] = []
  const offsets = new Map<SharedStreamJournalAppendRequest, number>()
  let bytes = 0
  let stop = false
  while (!stop && queue.size > 0 && selected.length < SHARED_APPEND_MAX_ROWS) {
    let current = queue.head
    const visitLimit = queue.size
    let visited = 0
    let added = 0
    while (current && visited < visitLimit && selected.length < SHARED_APPEND_MAX_ROWS) {
      const request = current
      const next = request.next
      visited += 1
      if (request.permit.signal.aborted) {
        removeSharedAppendRequest(queue, request)
        request.reject(request.permit.signal.reason)
        current = next?.queued ? next : queue.head
        continue
      }
      const offset = offsets.get(request) ?? 0
      let frame: CanonicalStreamJournalFrameRow | undefined
      try {
        frame = await request.cursor.frameAt(offset)
      } catch (error) {
        if (offset > 0) {
          queue.head = request
          stop = true
          break
        }
        removeSharedAppendRequest(queue, request)
        request.reject(error)
        current = next?.queued ? next : queue.head
        continue
      }
      if (!frame) {
        if (offset === 0) {
          removeSharedAppendRequest(queue, request)
          request.resolve()
        }
        current = next?.queued ? next : queue.head
        continue
      }
      const frameBytes = estimateStreamJournalFrameStorageBytes(frame)
      if (frameBytes > SHARED_APPEND_MAX_BYTES) {
        if (offset > 0) {
          queue.head = request
          stop = true
          break
        }
        removeSharedAppendRequest(queue, request)
        request.reject(new Error(`StreamJournalFrameBatchBudgetExceeded:${frame.id}`))
        current = next?.queued ? next : queue.head
        continue
      }
      if (selected.length > 0 && bytes + frameBytes > SHARED_APPEND_MAX_BYTES) {
        queue.head = request
        stop = true
        break
      }
      selected.push({ request, frame })
      offsets.set(request, offset + 1)
      bytes += frameBytes
      added += 1
      current = next?.queued ? next : queue.head
    }
    if (current?.queued && !stop) queue.head = current
    if (added === 0) break
  }
  return selected
}

async function appendSharedFrameBatch(
  port: StreamJournalFrameAppendPort,
  queue: SharedStreamJournalAppendQueue,
  selected: readonly SharedStreamJournalAppendFrame[],
): Promise<void> {
  const owners = groupFramesByAppendOwner(selected)
  if (owners.length > 1) {
    let nextOwner = 0
    const workers = Array.from(
      { length: Math.min(SHARED_APPEND_MAX_CONCURRENT_OWNERS, owners.length) },
      async () => {
        for (;;) {
          const ownerIndex = nextOwner
          nextOwner += 1
          const group = owners[ownerIndex]
          if (!group) return
          await appendSharedFrameBatch(port, queue, group)
        }
      },
    )
    await Promise.all(workers)
    return
  }
  const permit = selected.find((entry) => !entry.request.permit.signal.aborted)?.request.permit
  if (!permit) {
    for (const request of new Set(selected.map((entry) => entry.request))) {
      removeSharedAppendRequest(queue, request)
      request.reject(request.permit.signal.reason)
    }
    return
  }
  try {
    await port.appendStreamJournalFrames(
      permit,
      canonicalStreamJournalFrameBatch(selected.map((entry) => entry.frame)),
    )
    for (const { request, frame } of selected) {
      request.cursor.acknowledge(frame)
    }
  } catch (error) {
    for (const request of new Set(selected.map((entry) => entry.request))) {
      removeSharedAppendRequest(queue, request)
      request.reject(error)
    }
  }
}

function groupFramesByAppendOwner(
  selected: readonly SharedStreamJournalAppendFrame[],
): SharedStreamJournalAppendFrame[][] {
  const groups = new Map<string, SharedStreamJournalAppendFrame[]>()
  for (const entry of selected) {
    const permit = entry.request.permit
    const key = `${permit.workspaceId}\u0000${permit.replacementEpoch}\u0000${permit.runtimeGeneration}\u0000${entry.frame.streamId}`
    const group = groups.get(key)
    if (group) group.push(entry)
    else groups.set(key, [entry])
  }
  return [...groups.values()]
}

function enqueueSharedAppendRequest(
  queue: SharedStreamJournalAppendQueue,
  request: SharedStreamJournalAppendRequest,
): void {
  if (request.queued) throw new Error('StreamJournalAppendRequestAlreadyQueued')
  const head = queue.head
  if (!head) {
    request.previous = request
    request.next = request
    queue.head = request
  } else {
    const tail = head.previous as SharedStreamJournalAppendRequest
    request.previous = tail
    request.next = head
    tail.next = request
    head.previous = request
  }
  request.queued = true
  queue.size += 1
}

function removeSharedAppendRequest(
  queue: SharedStreamJournalAppendQueue,
  request: SharedStreamJournalAppendRequest,
): void {
  if (!request.queued) return
  if (queue.size === 1) {
    delete queue.head
  } else {
    const previous = request.previous as SharedStreamJournalAppendRequest
    const next = request.next as SharedStreamJournalAppendRequest
    previous.next = next
    next.previous = previous
    if (queue.head === request) queue.head = next
  }
  delete request.previous
  delete request.next
  request.queued = false
  queue.size -= 1
}

function createBufferedJournalEntryBatch(
  event: CanonicalStreamEventV2,
  now: number,
  bytes: number,
  textLength: number,
): BufferedJournalEntryBatch {
  return {
    event: bufferableStreamEvent(event),
    firstCreatedAt: now,
    lastCreatedAt: now,
    logicalRows: 1,
    logicalBytes: bytes,
    textLength,
  }
}

function bufferableStreamEvent(event: CanonicalStreamEventV2): BufferedStreamEvent {
  if (event.lane === 'text') {
    return { kind: 'text', template: event, sections: [event.text] }
  }
  if (event.lane === 'reasoning') {
    const mutation = exactReasoningAppend(event)
    if (mutation) {
      return {
        kind: 'reasoning-append',
        template: event,
        mutationTemplate: mutation,
        sections: [mutation.delta],
      }
    }
  }
  if (event.lane === 'tool-call' && exactToolCallAppend(event)) {
    return { kind: 'tool-call-append', template: event, sections: [event.argumentsDelta] }
  }
  return { kind: 'plain', event }
}

function coalesceStreamEvent(
  batch: BufferedJournalEntryBatch,
  incoming: CanonicalStreamEventV2,
  now: number,
  bytes: number,
  textLength: number,
): boolean {
  if (
    batch.logicalRows >= STREAM_JOURNAL_FLUSH_MAX_ROWS ||
    batch.textLength + textLength > STREAM_JOURNAL_FLUSH_MAX_TEXT_CHARS
  ) {
    return false
  }
  const buffered = batch.event
  if (buffered.kind === 'text') {
    if (incoming.lane !== 'text' || !sameTextTarget(buffered.template, incoming)) return false
    buffered.sections.push(incoming.text)
  } else if (buffered.kind === 'reasoning-append') {
    if (incoming.lane !== 'reasoning') return false
    const mutation = exactReasoningAppend(incoming)
    if (!mutation || !sameReasoningAppendTarget(buffered.mutationTemplate, mutation)) return false
    buffered.sections.push(mutation.delta)
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
  batch.lastCreatedAt = now
  batch.logicalRows += 1
  batch.logicalBytes += bytes
  batch.textLength += textLength
  return true
}

function materializeBufferedJournalEntries(
  batch: BufferedJournalEntryBatch,
): StreamJournalSemanticEntry[] {
  const buffered = batch.event
  if (buffered.kind === 'plain') {
    return [{ event: persistStreamEventV2(buffered.event), createdAt: batch.firstCreatedAt }]
  }
  if (buffered.kind === 'text') {
    const event: TextStreamEvent = {
      ...buffered.template,
      text: buffered.sections.join(''),
    }
    if (batch.logicalRows > 1) delete event.chunkId
    return [{ event: persistStreamEventV2(event), createdAt: batch.firstCreatedAt }]
  }
  if (buffered.kind === 'tool-call-append') {
    const event: ToolCallStreamEvent = {
      ...buffered.template,
      argumentsDelta: buffered.sections.join(''),
    }
    if (batch.logicalRows > 1) delete event.chunkId
    return [{ event: persistStreamEventV2(event), createdAt: batch.firstCreatedAt }]
  }
  const mutation = {
    ...buffered.mutationTemplate,
    delta: buffered.sections.join(''),
  } as Extract<ReasoningEnvelopeMutationV2, { kind: 'visible-append' | 'carrier-append' }>
  const firstObservedAt = buffered.template.observed?.firstAt ?? batch.firstCreatedAt
  const event: ReasoningStreamEvent = {
    lane: 'reasoning',
    mutations: [mutation],
    observed: {
      firstAt: firstObservedAt,
      lastAt: buffered.template.observed?.lastAt ?? batch.firstCreatedAt,
    },
  }
  const events: StreamJournalSemanticEntry[] = [
    { event: persistStreamEventV2(event), createdAt: batch.firstCreatedAt },
  ]
  if (batch.logicalRows > 1 && batch.lastCreatedAt !== batch.firstCreatedAt) {
    events.push({
      event: persistStreamEventV2({
        lane: 'reasoning',
        mutations: [],
        observed: { firstAt: batch.lastCreatedAt, lastAt: batch.lastCreatedAt },
      }),
      createdAt: batch.lastCreatedAt,
    })
  }
  return events
}

function exactReasoningAppend(
  event: ReasoningStreamEvent,
): Extract<ReasoningEnvelopeMutationV2, { kind: 'visible-append' | 'carrier-append' }> | null {
  if (event.mutations.length !== 1) return null
  const mutation = event.mutations[0]
  return mutation?.kind === 'visible-append' || mutation?.kind === 'carrier-append'
    ? mutation
    : null
}

function sameReasoningAppendTarget(
  left: Extract<ReasoningEnvelopeMutationV2, { kind: 'visible-append' | 'carrier-append' }>,
  right: Extract<ReasoningEnvelopeMutationV2, { kind: 'visible-append' | 'carrier-append' }>,
): boolean {
  if (left.kind !== right.kind) return false
  const leftTarget = left.kind === 'visible-append' ? left.part : left.carrier
  const rightTarget = right.kind === 'visible-append' ? right.part : right.carrier
  return JSON.stringify(leftTarget) === JSON.stringify(rightTarget)
}

function sameTextTarget(left: TextStreamEvent, right: TextStreamEvent): boolean {
  return left.outputIndex === right.outputIndex && left.contentIndex === right.contentIndex
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

function shouldPersistStreamEvent(event: CanonicalStreamEventV2): boolean {
  switch (event.lane) {
    case 'text':
    case 'text-annotations':
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
    case 'result-snapshot':
    case 'integrity':
    case 'tool-call':
      return true
    case 'keepalive':
      return false
  }
}

function isRecoverableOutputItem(item: unknown): boolean {
  return isResponsesProviderOutputItem(item)
}

function streamEventTextLength(event: CanonicalStreamEventV2): number {
  if (event.lane === 'text') return event.text.length
  if (event.lane === 'reasoning') {
    let length = 0
    for (const mutation of event.mutations) length += reasoningMutationPayloadLength(mutation)
    return length
  }
  if (event.lane === 'audio-output') {
    return (event.dataDelta?.length ?? 0) + (event.transcriptDelta?.length ?? 0)
  }
  if (event.lane === 'tool-call') {
    return (event.argumentsDelta?.length ?? 0) + (event.argumentsSnapshot?.length ?? 0)
  }
  if (event.lane === 'result-snapshot' && event.payload.kind === 'replace') {
    let length = 0
    for (const part of event.payload.textParts) length += part.text.length
    length += reasoningMutationPayloadLength({
      kind: 'replace',
      envelope: event.payload.reasoningEnvelope,
    })
    for (const call of event.payload.toolCalls) length += call.arguments.length
    return length
  }
  return 0
}

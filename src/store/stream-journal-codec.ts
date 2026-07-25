type ChatId = string
type MessageId = string

export const STREAM_JOURNAL_INLINE_MAX_ESTIMATED_BYTES = 24 * 1024
export const STREAM_JOURNAL_PAGE_MAX_BYTES = 64 * 1024
export const STREAM_JOURNAL_READ_MAX_ROWS = 4
export const STREAM_JOURNAL_READ_MAX_BYTES = 256 * 1024
export const STREAM_JOURNAL_APPEND_MAX_ROWS = 2_048
export const STREAM_JOURNAL_APPEND_MAX_BYTES = 4 * 1024 * 1024
export const STREAM_JOURNAL_CURSOR_MAX_LOOKAHEAD_FRAMES = 2_048

const STREAM_JOURNAL_STRING_TOKEN_CHARS = 4 * 1024
const STREAM_JOURNAL_ZERO_DIGEST = '0'.repeat(64)
const STREAM_JOURNAL_ESTIMATED_ROW_OVERHEAD_BYTES = 128
const STREAM_JOURNAL_FRAME_ID_PREFIX = 'sjf:'
const textEncoder = new TextEncoder()
const canonicalFrameInstances = new WeakSet<object>()
const canonicalFrameStorageBytes = new WeakMap<object, number>()

interface StreamJournalFrameBase {
  readonly id: string
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly seq: number
  readonly logicalSeq: number
  readonly createdAt: number
  readonly ownerClientId: string
  readonly fenceToken: string
  readonly replacementEpoch: number
  readonly admissionSequence: number
}

export type StreamJournalValueToken =
  | readonly ['null']
  | readonly ['boolean', boolean]
  | readonly ['number', number]
  | readonly ['string', string]
  | readonly ['string-start', string]
  | readonly ['string-chunk', string]
  | readonly ['string-end', string]
  | readonly ['array-start']
  | readonly ['array-end']
  | readonly ['object-start']
  | readonly ['object-key', string]
  | readonly ['object-key-start', string]
  | readonly ['object-key-chunk', string]
  | readonly ['object-key-end', string]
  | readonly ['object-end']

export type StreamJournalFrameRow =
  | (StreamJournalFrameBase & {
      readonly frameKind: 'inline'
      readonly event: unknown
    })
  | (StreamJournalFrameBase & {
      readonly frameKind: 'page'
      readonly pageIndex: number
      readonly payloadByteLength: number
      readonly cumulativePayloadByteLength: number
      readonly previousDigest: string
      readonly digest: string
      readonly payload: readonly StreamJournalValueToken[]
    })
  | (StreamJournalFrameBase & {
      readonly frameKind: 'commit'
      readonly pageCount: number
      readonly payloadByteLength: number
      readonly digest: string
    })

declare const canonicalStreamJournalFrameBrand: unique symbol

export type CanonicalStreamJournalFrameRow = StreamJournalFrameRow & {
  readonly [canonicalStreamJournalFrameBrand]: true
}

declare const canonicalStreamJournalFrameBatchBrand: unique symbol

export type CanonicalStreamJournalFrameBatch = readonly CanonicalStreamJournalFrameRow[] & {
  readonly [canonicalStreamJournalFrameBatchBrand]: true
}

interface StreamJournalWriteFence {
  readonly ownerClientId: string
  readonly fenceToken: string
  readonly replacementEpoch: number
  readonly admissionSequence: number
}

const STREAM_JOURNAL_FRAME_BASE_KEYS = [
  'id',
  'streamId',
  'chatId',
  'messageId',
  'seq',
  'logicalSeq',
  'createdAt',
  'ownerClientId',
  'fenceToken',
  'replacementEpoch',
  'admissionSequence',
  'frameKind',
] as const

const STREAM_JOURNAL_INLINE_FRAME_KEYS = new Set([...STREAM_JOURNAL_FRAME_BASE_KEYS, 'event'])
const STREAM_JOURNAL_PAGE_FRAME_KEYS = new Set([
  ...STREAM_JOURNAL_FRAME_BASE_KEYS,
  'pageIndex',
  'payloadByteLength',
  'cumulativePayloadByteLength',
  'previousDigest',
  'digest',
  'payload',
])
const STREAM_JOURNAL_COMMIT_FRAME_KEYS = new Set([
  ...STREAM_JOURNAL_FRAME_BASE_KEYS,
  'pageCount',
  'payloadByteLength',
  'digest',
])

export function streamJournalFrameId(streamId: string, seq: number): string {
  if (streamId.length === 0 || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error('StreamJournalFrameIdentityInvalid')
  }
  return `${STREAM_JOURNAL_FRAME_ID_PREFIX}${streamId.length}:${streamId}:${seq}`
}

export function streamJournalFrameStreamId(id: string): string | undefined {
  if (!id.startsWith(STREAM_JOURNAL_FRAME_ID_PREFIX)) return undefined
  const lengthSeparator = id.indexOf(':', STREAM_JOURNAL_FRAME_ID_PREFIX.length)
  if (lengthSeparator < 0) return undefined
  const length = Number(id.slice(STREAM_JOURNAL_FRAME_ID_PREFIX.length, lengthSeparator))
  if (!Number.isSafeInteger(length) || length <= 0) return undefined
  const streamStart = lengthSeparator + 1
  const streamEnd = streamStart + length
  if (id[streamEnd] !== ':') return undefined
  const seq = Number(id.slice(streamEnd + 1))
  if (!Number.isSafeInteger(seq) || seq < 0) return undefined
  return id.slice(streamStart, streamEnd)
}

export function isStreamJournalFrameRow(value: unknown): value is StreamJournalFrameRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Partial<StreamJournalFrameRow> & Record<string, unknown>
  const baseValid =
    isNonEmptyString(row.id) &&
    isNonEmptyString(row.streamId) &&
    isNonEmptyString(row.chatId) &&
    isNonEmptyString(row.messageId) &&
    isNonNegativeSafeInteger(row.seq) &&
    isNonNegativeSafeInteger(row.logicalSeq) &&
    isNonNegativeSafeInteger(row.createdAt) &&
    isNonEmptyString(row.ownerClientId) &&
    isNonEmptyString(row.fenceToken) &&
    isNonNegativeSafeInteger(row.replacementEpoch) &&
    isNonNegativeSafeInteger(row.admissionSequence)
  if (!baseValid) return false
  if (row.id !== streamJournalFrameId(row.streamId, row.seq)) return false
  if (row.frameKind === 'inline') {
    return hasExactEnumerableKeys(row, STREAM_JOURNAL_INLINE_FRAME_KEYS)
  }
  if (row.frameKind === 'page') {
    return (
      hasExactEnumerableKeys(row, STREAM_JOURNAL_PAGE_FRAME_KEYS) &&
      isNonNegativeSafeInteger(row.pageIndex) &&
      isNonNegativeSafeInteger(row.payloadByteLength) &&
      row.payloadByteLength > 0 &&
      row.payloadByteLength <= STREAM_JOURNAL_PAGE_MAX_BYTES &&
      isNonNegativeSafeInteger(row.cumulativePayloadByteLength) &&
      row.cumulativePayloadByteLength >= row.payloadByteLength &&
      isStreamJournalDigest(row.previousDigest) &&
      isStreamJournalDigest(row.digest) &&
      Array.isArray(row.payload) &&
      isStreamJournalTokenPage(row.payload)
    )
  }
  if (row.frameKind === 'commit') {
    return (
      hasExactEnumerableKeys(row, STREAM_JOURNAL_COMMIT_FRAME_KEYS) &&
      isNonNegativeSafeInteger(row.pageCount) &&
      row.pageCount > 0 &&
      isNonNegativeSafeInteger(row.payloadByteLength) &&
      row.payloadByteLength > 0 &&
      isStreamJournalDigest(row.digest)
    )
  }
  return false
}

export function canonicalStreamJournalFrameBatch(
  values: readonly StreamJournalFrameRow[],
): CanonicalStreamJournalFrameBatch {
  if (values.length === 0 || values.length > STREAM_JOURNAL_APPEND_MAX_ROWS) {
    throw new Error(`StreamJournalAppendBatchRowBudgetExceeded:${values.length}`)
  }
  const frames: CanonicalStreamJournalFrameRow[] = []
  let streamId: string | undefined
  let bytes = 0
  for (const value of values) {
    const frame = requireCanonicalStreamJournalFrame(value)
    streamId ??= frame.streamId
    if (frame.streamId !== streamId) throw new Error('StreamJournalAppendBatchMixedStreams')
    bytes = saturatingAdd(bytes, estimateStreamJournalV83FrameStorageBytes(frame))
    if (bytes > STREAM_JOURNAL_APPEND_MAX_BYTES) {
      throw new Error(`StreamJournalAppendBatchByteBudgetExceeded:${bytes}`)
    }
    frames.push(frame)
  }
  return Object.freeze(frames) as CanonicalStreamJournalFrameBatch
}

export interface StreamJournalStableIdentity {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly replacementEpoch: number
  readonly admissionSequence: number
}

export interface StreamJournalWriterAuthority extends StreamJournalStableIdentity {
  readonly ownerClientId: string
  readonly fenceToken: string
}

export function streamJournalStableIdentity(
  value: StreamJournalStableIdentity,
): StreamJournalStableIdentity {
  return Object.freeze({
    streamId: value.streamId,
    chatId: value.chatId,
    messageId: value.messageId,
    replacementEpoch: value.replacementEpoch,
    admissionSequence: value.admissionSequence,
  })
}

export function streamJournalWriterAuthority(
  value: StreamJournalWriterAuthority,
): StreamJournalWriterAuthority {
  return Object.freeze({
    ...streamJournalStableIdentity(value),
    ownerClientId: value.ownerClientId,
    fenceToken: value.fenceToken,
  })
}

export function sameStreamJournalStableIdentity(
  left: StreamJournalStableIdentity,
  right: StreamJournalStableIdentity,
): boolean {
  return (
    left.streamId === right.streamId &&
    left.chatId === right.chatId &&
    left.messageId === right.messageId &&
    left.replacementEpoch === right.replacementEpoch &&
    left.admissionSequence === right.admissionSequence
  )
}

export function sameStreamJournalWriterAuthority(
  left: StreamJournalWriterAuthority,
  right: StreamJournalWriterAuthority,
): boolean {
  return (
    sameStreamJournalStableIdentity(left, right) &&
    left.ownerClientId === right.ownerClientId &&
    left.fenceToken === right.fenceToken
  )
}

export interface StreamJournalSemanticEntry {
  readonly createdAt: number
  readonly event: unknown
}

export interface StreamJournalDecodedEntry extends StreamJournalSemanticEntry {
  readonly logicalSeq: number
  readonly terminalPhysicalSeq: number
}

export interface StreamJournalFrameCursor {
  current(): Promise<CanonicalStreamJournalFrameRow | undefined>
  frameAt(offset: number): Promise<CanonicalStreamJournalFrameRow | undefined>
  acknowledge(frame: CanonicalStreamJournalFrameRow): void
  readonly nextPhysicalSeq: number
  readonly nextLogicalSeq: number
}

interface StreamJournalFrameCursorInput {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly fence: StreamJournalWriteFence
  readonly entries: readonly StreamJournalSemanticEntry[]
  readonly startPhysicalSeq?: number
  readonly startLogicalSeq?: number
}

export function createStreamJournalFrameCursor(
  input: StreamJournalFrameCursorInput,
): StreamJournalFrameCursor {
  return new CanonicalStreamJournalFrameCursor(input)
}

class CanonicalStreamJournalFrameCursor implements StreamJournalFrameCursor {
  private readonly input: StreamJournalFrameCursorInput
  private entryIndex = 0
  private physicalSeq: number
  private logicalSeq: number
  private frames: AsyncGenerator<CanonicalStreamJournalFrameRow, void> | undefined
  private readonly pending: CanonicalStreamJournalFrameRow[] = []
  private pendingHead = 0
  private failure?: unknown

  constructor(input: StreamJournalFrameCursorInput) {
    assertStreamJournalWriterAuthority({
      streamId: input.streamId,
      chatId: input.chatId,
      messageId: input.messageId,
      replacementEpoch: input.fence.replacementEpoch,
      admissionSequence: input.fence.admissionSequence,
      ownerClientId: input.fence.ownerClientId,
      fenceToken: input.fence.fenceToken,
    })
    assertNonNegativeSafeInteger(input.startPhysicalSeq ?? 0, 'start-physical-sequence')
    assertNonNegativeSafeInteger(input.startLogicalSeq ?? 0, 'start-logical-sequence')
    this.input = input
    this.physicalSeq = input.startPhysicalSeq ?? 0
    this.logicalSeq = input.startLogicalSeq ?? 0
  }

  get nextPhysicalSeq(): number {
    return this.physicalSeq
  }

  get nextLogicalSeq(): number {
    return this.logicalSeq
  }

  async current(): Promise<CanonicalStreamJournalFrameRow | undefined> {
    return this.frameAt(0)
  }

  async frameAt(offset: number): Promise<CanonicalStreamJournalFrameRow | undefined> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('StreamJournalCursorOffsetInvalid')
    }
    if (offset >= STREAM_JOURNAL_CURSOR_MAX_LOOKAHEAD_FRAMES) {
      throw new RangeError('StreamJournalCursorLookaheadExceeded')
    }
    if (this.failure !== undefined) throw streamJournalError(this.failure)
    while (
      this.pending.length - this.pendingHead <= offset &&
      this.entryIndex < this.input.entries.length
    ) {
      if (!this.frames) {
        const entry = this.input.entries[this.entryIndex]
        if (!entry) throw new Error('StreamJournalCursorEntryMissing')
        const logicalSeq = this.logicalSeq
        this.logicalSeq += 1
        this.frames = this.framesForEntry(entry, logicalSeq)
      }
      let next: IteratorResult<CanonicalStreamJournalFrameRow, void>
      try {
        next = await this.frames.next()
      } catch (error) {
        this.failure = error
        throw error
      }
      if (next.done) {
        this.frames = undefined
        this.entryIndex += 1
        continue
      }
      this.pending.push(next.value)
    }
    return this.pending[this.pendingHead + offset]
  }

  acknowledge(frame: CanonicalStreamJournalFrameRow): void {
    const pending = this.pending[this.pendingHead]
    if (!pending || pending.id !== frame.id) {
      throw new Error(`StreamJournalFrameAcknowledgeMismatch:${frame.id}`)
    }
    this.pendingHead += 1
    if (this.pendingHead === this.pending.length) {
      this.pending.length = 0
      this.pendingHead = 0
    }
  }

  private async *framesForEntry(
    entry: StreamJournalSemanticEntry,
    logicalSeq: number,
  ): AsyncGenerator<CanonicalStreamJournalFrameRow, void> {
    assertNonNegativeSafeInteger(entry.createdAt, 'entry-created-at')
    if (
      estimateStreamJournalV83StoredValueBytes(entry.event) <=
      STREAM_JOURNAL_INLINE_MAX_ESTIMATED_BYTES
    ) {
      const event = freezeStreamJournalSemanticValue(structuredClone(entry.event))
      yield this.frameBase(entry, logicalSeq, { frameKind: 'inline', event })
      return
    }
    let previousDigest = STREAM_JOURNAL_ZERO_DIGEST
    let pageIndex = 0
    let cumulativePayloadByteLength = 0
    for (const payload of streamJournalTokenPages(entry.event)) {
      const encoded = encodeTokenPage(payload)
      const payloadByteLength = encoded.byteLength
      cumulativePayloadByteLength += payloadByteLength
      const digest = await streamJournalPageDigest(
        previousDigest,
        pageIndex,
        payloadByteLength,
        encoded,
      )
      yield this.frameBase(entry, logicalSeq, {
        frameKind: 'page',
        pageIndex,
        payloadByteLength,
        cumulativePayloadByteLength,
        previousDigest,
        digest,
        payload,
      })
      previousDigest = digest
      pageIndex += 1
    }
    if (pageIndex === 0) throw new Error('StreamJournalEventEncodingEmpty')
    yield this.frameBase(entry, logicalSeq, {
      frameKind: 'commit',
      pageCount: pageIndex,
      payloadByteLength: cumulativePayloadByteLength,
      digest: previousDigest,
    })
  }

  private frameBase(
    entry: StreamJournalSemanticEntry,
    logicalSeq: number,
    frame: StreamJournalFramePayload,
  ): CanonicalStreamJournalFrameRow {
    const seq = this.physicalSeq
    this.physicalSeq += 1
    return markCanonicalStreamJournalFrame({
      id: streamJournalFrameId(this.input.streamId, seq),
      streamId: this.input.streamId,
      chatId: this.input.chatId,
      messageId: this.input.messageId,
      seq,
      logicalSeq,
      createdAt: entry.createdAt,
      ownerClientId: this.input.fence.ownerClientId,
      fenceToken: this.input.fence.fenceToken,
      replacementEpoch: this.input.fence.replacementEpoch,
      admissionSequence: this.input.fence.admissionSequence,
      ...frame,
    })
  }
}

type StreamJournalFramePayload =
  | { readonly frameKind: 'inline'; readonly event: unknown }
  | {
      readonly frameKind: 'page'
      readonly pageIndex: number
      readonly payloadByteLength: number
      readonly cumulativePayloadByteLength: number
      readonly previousDigest: string
      readonly digest: string
      readonly payload: readonly StreamJournalValueToken[]
    }
  | {
      readonly frameKind: 'commit'
      readonly pageCount: number
      readonly payloadByteLength: number
      readonly digest: string
    }

export function requireCanonicalStreamJournalFrame(value: unknown): CanonicalStreamJournalFrameRow {
  if (value && typeof value === 'object' && canonicalFrameInstances.has(value)) {
    return value as CanonicalStreamJournalFrameRow
  }
  if (!isStreamJournalFrameRow(value)) throw new Error('StreamJournalFrameRowInvalid')
  const base = {
    id: value.id,
    streamId: value.streamId,
    chatId: value.chatId,
    messageId: value.messageId,
    seq: value.seq,
    logicalSeq: value.logicalSeq,
    createdAt: value.createdAt,
    ownerClientId: value.ownerClientId,
    fenceToken: value.fenceToken,
    replacementEpoch: value.replacementEpoch,
    admissionSequence: value.admissionSequence,
  }
  if (value.frameKind === 'inline') {
    if (
      estimateStreamJournalV83StoredValueBytes(value.event) >
      STREAM_JOURNAL_INLINE_MAX_ESTIMATED_BYTES
    ) {
      throw new Error(`StreamJournalInlineBudgetExceeded:${value.id}`)
    }
    const event = freezeStreamJournalSemanticValue(structuredClone(value.event))
    return markCanonicalStreamJournalFrame({ ...base, frameKind: 'inline', event })
  }
  if (value.frameKind === 'page') {
    const payload = Object.freeze(
      value.payload.map((token) => Object.freeze([...token]) as unknown as StreamJournalValueToken),
    )
    const payloadByteLength = encodeTokenPage(payload).byteLength
    if (payloadByteLength !== value.payloadByteLength) {
      throw new Error(`StreamJournalPageByteLengthInvalid:${value.id}`)
    }
    return markCanonicalStreamJournalFrame({
      ...base,
      frameKind: 'page',
      pageIndex: value.pageIndex,
      payloadByteLength,
      cumulativePayloadByteLength: value.cumulativePayloadByteLength,
      previousDigest: value.previousDigest,
      digest: value.digest,
      payload,
    })
  }
  return markCanonicalStreamJournalFrame({
    ...base,
    frameKind: 'commit',
    pageCount: value.pageCount,
    payloadByteLength: value.payloadByteLength,
    digest: value.digest,
  })
}

export function assertStreamJournalFrameTransition(
  previous: CanonicalStreamJournalFrameRow | undefined,
  next: CanonicalStreamJournalFrameRow,
): void {
  const expectedPhysicalSeq = (previous?.seq ?? -1) + 1
  if (
    next.seq !== expectedPhysicalSeq ||
    next.id !== streamJournalFrameId(next.streamId, next.seq)
  ) {
    throw streamJournalFrameError(next.streamId, 'physical-sequence')
  }
  if (
    previous &&
    !sameStreamJournalWriterAuthority(
      streamJournalWriterAuthority(previous),
      streamJournalWriterAuthority(next),
    )
  ) {
    throw streamJournalFrameError(next.streamId, 'identity')
  }
  if (!previous || previous.frameKind === 'inline' || previous.frameKind === 'commit') {
    const expectedLogicalSeq = (previous?.logicalSeq ?? -1) + 1
    if (next.logicalSeq !== expectedLogicalSeq) {
      throw streamJournalFrameError(next.streamId, 'logical-sequence')
    }
    if (next.frameKind === 'commit') {
      throw streamJournalFrameError(next.streamId, 'commit-without-pages')
    }
    if (
      next.frameKind === 'page' &&
      (next.pageIndex !== 0 ||
        next.previousDigest !== STREAM_JOURNAL_ZERO_DIGEST ||
        next.cumulativePayloadByteLength !== next.payloadByteLength)
    ) {
      throw streamJournalFrameError(next.streamId, 'first-page')
    }
    return
  }
  if (next.logicalSeq !== previous.logicalSeq) {
    throw streamJournalFrameError(next.streamId, 'paged-logical-sequence')
  }
  if (next.frameKind === 'inline') {
    throw streamJournalFrameError(next.streamId, 'inline-after-page')
  }
  if (next.createdAt !== previous.createdAt) {
    throw streamJournalFrameError(next.streamId, 'paged-created-at')
  }
  if (next.frameKind === 'page') {
    if (
      next.pageIndex !== previous.pageIndex + 1 ||
      next.previousDigest !== previous.digest ||
      next.cumulativePayloadByteLength !==
        previous.cumulativePayloadByteLength + next.payloadByteLength
    ) {
      throw streamJournalFrameError(next.streamId, 'page-chain')
    }
    return
  }
  if (
    next.pageCount !== previous.pageIndex + 1 ||
    next.payloadByteLength !== previous.cumulativePayloadByteLength ||
    next.digest !== previous.digest
  ) {
    throw streamJournalFrameError(next.streamId, 'commit-chain')
  }
}

export class StreamJournalFrameDecoder {
  private readonly expected: StreamJournalStableIdentity | undefined
  private expectedPhysicalSeq = 0
  private expectedLogicalSeq = 0
  private previous?: CanonicalStreamJournalFrameRow
  private pending?: {
    logicalSeq: number
    createdAt: number
    nextPageIndex: number
    payloadByteLength: number
    digest: string
    builder: StreamJournalValueBuilder
  }

  constructor(expected?: StreamJournalStableIdentity) {
    if (expected) assertStreamJournalStableIdentity(expected)
    this.expected = expected ? streamJournalStableIdentity(expected) : undefined
  }

  async accept(
    frame: CanonicalStreamJournalFrameRow,
  ): Promise<StreamJournalDecodedEntry | undefined> {
    if (
      this.expected &&
      !sameStreamJournalStableIdentity(this.expected, streamJournalStableIdentity(frame))
    ) {
      throw streamJournalDecodeError(frame.streamId, 'lease-identity')
    }
    assertStreamJournalFrameTransition(this.previous, frame)
    if (frame.seq !== this.expectedPhysicalSeq) {
      throw streamJournalDecodeError(frame.streamId, 'physical-sequence')
    }
    this.expectedPhysicalSeq += 1
    if (frame.frameKind === 'inline') {
      if (this.pending || frame.logicalSeq !== this.expectedLogicalSeq) {
        throw streamJournalDecodeError(frame.streamId, 'inline-sequence')
      }
      assertStreamJournalSemanticValue(frame.event)
      if (
        estimateStreamJournalV83StoredValueBytes(frame.event) >
        STREAM_JOURNAL_INLINE_MAX_ESTIMATED_BYTES
      ) {
        throw streamJournalDecodeError(frame.streamId, 'inline-byte-length')
      }
      this.expectedLogicalSeq += 1
      this.previous = frame
      return {
        logicalSeq: frame.logicalSeq,
        terminalPhysicalSeq: frame.seq,
        createdAt: frame.createdAt,
        event: frame.event,
      }
    }
    if (frame.frameKind === 'page') {
      const encoded = encodeTokenPage(frame.payload)
      if (encoded.byteLength !== frame.payloadByteLength) {
        throw streamJournalDecodeError(frame.streamId, 'page-byte-length')
      }
      if (!this.pending) {
        if (
          frame.logicalSeq !== this.expectedLogicalSeq ||
          frame.pageIndex !== 0 ||
          frame.previousDigest !== STREAM_JOURNAL_ZERO_DIGEST ||
          frame.cumulativePayloadByteLength !== frame.payloadByteLength
        ) {
          throw streamJournalDecodeError(frame.streamId, 'first-page')
        }
        this.pending = {
          logicalSeq: frame.logicalSeq,
          createdAt: frame.createdAt,
          nextPageIndex: 0,
          payloadByteLength: 0,
          digest: STREAM_JOURNAL_ZERO_DIGEST,
          builder: new StreamJournalValueBuilder(),
        }
      }
      const pending = this.pending
      if (
        frame.logicalSeq !== pending.logicalSeq ||
        frame.createdAt !== pending.createdAt ||
        frame.pageIndex !== pending.nextPageIndex ||
        frame.previousDigest !== pending.digest
      ) {
        throw streamJournalDecodeError(frame.streamId, 'page-sequence')
      }
      const digest = await streamJournalPageDigest(
        pending.digest,
        frame.pageIndex,
        frame.payloadByteLength,
        encoded,
      )
      if (digest !== frame.digest) {
        throw streamJournalDecodeError(frame.streamId, 'page-digest')
      }
      pending.builder.accept(frame.payload)
      pending.nextPageIndex += 1
      pending.payloadByteLength += frame.payloadByteLength
      pending.digest = frame.digest
      if (pending.payloadByteLength !== frame.cumulativePayloadByteLength) {
        throw streamJournalDecodeError(frame.streamId, 'page-cumulative-byte-length')
      }
      this.previous = frame
      return undefined
    }
    const pending = this.pending
    if (
      !pending ||
      frame.logicalSeq !== pending.logicalSeq ||
      frame.createdAt !== pending.createdAt ||
      frame.pageCount !== pending.nextPageIndex ||
      frame.payloadByteLength !== pending.payloadByteLength ||
      frame.digest !== pending.digest
    ) {
      throw streamJournalDecodeError(frame.streamId, 'commit')
    }
    const event = pending.builder.finish()
    delete this.pending
    this.expectedLogicalSeq += 1
    this.previous = frame
    return {
      logicalSeq: frame.logicalSeq,
      terminalPhysicalSeq: frame.seq,
      createdAt: frame.createdAt,
      event,
    }
  }

  finish(options: { allowTruncatedTail: boolean; expectedFinalPhysicalSeq: number }): {
    truncated: boolean
  } {
    if (this.expectedPhysicalSeq !== options.expectedFinalPhysicalSeq + 1) {
      throw new Error('StreamJournalPhysicalTailMissing')
    }
    const truncated = this.pending !== undefined
    if (truncated && !options.allowTruncatedTail) throw new Error('StreamJournalTruncated')
    delete this.pending
    return { truncated }
  }
}

function* streamJournalTokenPages(value: unknown): Generator<readonly StreamJournalValueToken[]> {
  let page: StreamJournalValueToken[] = []
  let upperBound = 2
  for (const token of streamJournalValueTokens(value, new Set<object>())) {
    const tokenBytes = streamJournalTokenEncodedByteLength(token)
    const separatorBytes = page.length === 0 ? 0 : 1
    if (
      page.length > 0 &&
      upperBound + separatorBytes + tokenBytes > STREAM_JOURNAL_PAGE_MAX_BYTES
    ) {
      yield Object.freeze(page)
      page = []
      upperBound = 2
    }
    if (upperBound + (page.length === 0 ? 0 : 1) + tokenBytes > STREAM_JOURNAL_PAGE_MAX_BYTES) {
      throw new Error(`StreamJournalTokenBudgetExceeded:${tokenBytes}`)
    }
    page.push(Object.freeze([...token]))
    upperBound += (page.length === 1 ? 0 : 1) + tokenBytes
  }
  if (page.length > 0) yield Object.freeze(page)
}

function assertStreamJournalSemanticValue(value: unknown): void {
  for (const _token of streamJournalValueTokens(value, new Set<object>())) {
    // Exhausting the canonical tokenizer applies the same value contract as paged frames.
  }
}

function freezeStreamJournalSemanticValue(value: unknown): unknown {
  assertStreamJournalSemanticValue(value)
  if (!value || typeof value !== 'object') return value
  const stack: object[] = [value]
  const seen = new Set<object>()
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const nestedValues: readonly unknown[] = Array.isArray(current)
      ? (current as readonly unknown[])
      : Object.values(current as Record<string, unknown>)
    for (const nested of nestedValues) {
      if (nested && typeof nested === 'object') stack.push(nested)
    }
    Object.freeze(current)
  }
  return value
}

function* streamJournalValueTokens(
  value: unknown,
  ancestors: Set<object>,
): Generator<StreamJournalValueToken> {
  if (value === null) {
    yield ['null']
    return
  }
  if (typeof value === 'boolean') {
    yield ['boolean', value]
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('StreamJournalNumberUnsupported')
    yield ['number', Object.is(value, -0) ? 0 : value]
    return
  }
  if (typeof value === 'string') {
    yield* streamJournalStringTokens(value, 'string')
    return
  }
  if (typeof value === 'bigint') throw new TypeError('StreamJournalBigIntUnsupported')
  if (typeof value !== 'object') throw new TypeError('StreamJournalValueUnsupported')
  if (ancestors.has(value)) throw new TypeError('StreamJournalCyclicValue')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      yield ['array-start']
      for (const item of value) {
        if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
          throw new TypeError('StreamJournalArrayValueUnsupported')
        }
        yield* streamJournalValueTokens(item, ancestors)
      }
      yield ['array-end']
      return
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('StreamJournalObjectPrototypeUnsupported')
    }
    yield ['object-start']
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key]
      if (child === undefined || typeof child === 'function' || typeof child === 'symbol') {
        throw new TypeError('StreamJournalObjectValueUnsupported')
      }
      yield* streamJournalStringTokens(key, 'object-key')
      yield* streamJournalValueTokens(child, ancestors)
    }
    yield ['object-end']
  } finally {
    ancestors.delete(value)
  }
}

function streamJournalError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('StreamJournalFailed', { cause: reason })
}

function* streamJournalStringTokens(
  value: string,
  kind: 'string' | 'object-key',
): Generator<StreamJournalValueToken> {
  if (value.length <= STREAM_JOURNAL_STRING_TOKEN_CHARS) {
    yield [kind, value]
    return
  }
  let offset = 0
  let partIndex = 0
  while (offset < value.length) {
    const end = Math.min(value.length, offset + STREAM_JOURNAL_STRING_TOKEN_CHARS)
    const fragment = value.slice(offset, end)
    const final = end === value.length
    yield [
      final ? `${kind}-end` : partIndex === 0 ? `${kind}-start` : `${kind}-chunk`,
      fragment,
    ] as StreamJournalValueToken
    offset = end
    partIndex += 1
  }
}

function streamJournalTokenEncodedByteLength(token: StreamJournalValueToken): number {
  return textEncoder.encode(JSON.stringify(token)).byteLength
}

function encodeTokenPage(payload: readonly StreamJournalValueToken[]): Uint8Array {
  const encoded = textEncoder.encode(JSON.stringify(payload))
  if (encoded.byteLength > STREAM_JOURNAL_PAGE_MAX_BYTES) {
    throw new Error(`StreamJournalPageBudgetExceeded:${encoded.byteLength}`)
  }
  return encoded
}

export function estimateStreamJournalV83FrameStorageBytes(
  row: CanonicalStreamJournalFrameRow,
): number {
  const cached = canonicalFrameStorageBytes.get(row)
  if (cached !== undefined) return cached
  const identityBytes =
    STREAM_JOURNAL_ESTIMATED_ROW_OVERHEAD_BYTES +
    2 *
      (row.id.length +
        row.streamId.length +
        row.chatId.length +
        row.messageId.length +
        row.ownerClientId.length +
        row.fenceToken.length) +
    8 * 6
  if (row.frameKind === 'inline') {
    const bytes = saturatingSum([
      identityBytes,
      32,
      estimateStreamJournalV83StoredValueBytes(row.event),
    ])
    canonicalFrameStorageBytes.set(row, bytes)
    return bytes
  }
  if (row.frameKind === 'page') {
    const bytes = saturatingSum([
      identityBytes,
      192,
      row.payloadByteLength,
      row.payload.length * 24,
    ])
    canonicalFrameStorageBytes.set(row, bytes)
    return bytes
  }
  const bytes = saturatingSum([identityBytes, 192])
  canonicalFrameStorageBytes.set(row, bytes)
  return bytes
}

function estimateStreamJournalV83StoredValueBytes(root: unknown): number {
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
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        bytes += value.size
      } else if (ArrayBuffer.isView(value)) {
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
  }
  return bytes
}

async function streamJournalPageDigest(
  previousDigest: string,
  pageIndex: number,
  byteLength: number,
  payload: Uint8Array,
): Promise<string> {
  const metadata = textEncoder.encode(`${pageIndex}:${byteLength}:`)
  const previous = digestBytes(previousDigest)
  const input = new Uint8Array(previous.byteLength + metadata.byteLength + payload.byteLength)
  input.set(previous, 0)
  input.set(metadata, previous.byteLength)
  input.set(payload, previous.byteLength + metadata.byteLength)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function digestBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('StreamJournalDigestInvalid')
  const bytes = new Uint8Array(32)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

type StreamJournalContainer =
  | { kind: 'array'; value: unknown[] }
  | { kind: 'object'; value: Record<string, unknown>; pendingKey?: string }

class StreamJournalValueBuilder {
  private readonly stack: StreamJournalContainer[] = []
  private root: unknown
  private hasRoot = false
  private scalar?: {
    kind: 'string' | 'object-key'
    parts: string[]
  }

  accept(tokens: readonly StreamJournalValueToken[]): void {
    for (const token of tokens) this.acceptToken(token)
  }

  finish(): unknown {
    if (!this.hasRoot || this.stack.length > 0 || this.scalar) {
      throw new Error('StreamJournalValueIncomplete')
    }
    return this.root
  }

  private acceptToken(token: StreamJournalValueToken): void {
    switch (token[0]) {
      case 'null':
        this.acceptValue(null)
        return
      case 'boolean':
      case 'number':
      case 'string':
        this.acceptValue(token[1])
        return
      case 'string-start':
        this.beginScalar('string', token[1])
        return
      case 'string-chunk':
        this.appendScalar('string', token[1])
        return
      case 'string-end':
        this.finishScalar('string', token[1])
        return
      case 'array-start': {
        const value: unknown[] = []
        this.acceptValue(value)
        this.stack.push({ kind: 'array', value })
        return
      }
      case 'array-end':
        this.endContainer('array')
        return
      case 'object-start': {
        const value: Record<string, unknown> = {}
        this.acceptValue(value)
        this.stack.push({ kind: 'object', value })
        return
      }
      case 'object-key':
        this.acceptObjectKey(token[1])
        return
      case 'object-key-start':
        this.beginScalar('object-key', token[1])
        return
      case 'object-key-chunk':
        this.appendScalar('object-key', token[1])
        return
      case 'object-key-end':
        this.finishScalar('object-key', token[1])
        return
      case 'object-end':
        this.endContainer('object')
    }
  }

  private beginScalar(kind: 'string' | 'object-key', value: string): void {
    if (this.scalar) throw new Error('StreamJournalScalarNested')
    this.scalar = { kind, parts: [value] }
  }

  private appendScalar(kind: 'string' | 'object-key', value: string): void {
    if (this.scalar?.kind !== kind) throw new Error('StreamJournalScalarSequenceInvalid')
    this.scalar.parts.push(value)
  }

  private finishScalar(kind: 'string' | 'object-key', value: string): void {
    if (this.scalar?.kind !== kind) throw new Error('StreamJournalScalarSequenceInvalid')
    this.scalar.parts.push(value)
    const result = this.scalar.parts.join('')
    delete this.scalar
    if (kind === 'string') this.acceptValue(result)
    else this.acceptObjectKey(result)
  }

  private acceptObjectKey(key: string): void {
    const target = this.stack.at(-1)
    if (target?.kind !== 'object' || target.pendingKey !== undefined || this.scalar) {
      throw new Error('StreamJournalObjectKeyInvalid')
    }
    target.pendingKey = key
  }

  private acceptValue(value: unknown): void {
    if (this.scalar) throw new Error('StreamJournalScalarIncomplete')
    const target = this.stack.at(-1)
    if (!target) {
      if (this.hasRoot) throw new Error('StreamJournalMultipleRoots')
      this.root = value
      this.hasRoot = true
      return
    }
    if (target.kind === 'array') {
      target.value.push(value)
      return
    }
    const key = target.pendingKey
    if (key === undefined) throw new Error('StreamJournalObjectValueWithoutKey')
    Object.defineProperty(target.value, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    delete target.pendingKey
  }

  private endContainer(kind: StreamJournalContainer['kind']): void {
    if (this.scalar) throw new Error('StreamJournalScalarIncomplete')
    const target = this.stack.at(-1)
    if (!target || target.kind !== kind) throw new Error('StreamJournalContainerMismatch')
    if (target.kind === 'object' && target.pendingKey !== undefined) {
      throw new Error('StreamJournalObjectValueMissing')
    }
    this.stack.pop()
  }
}

function assertStreamJournalStableIdentity(value: StreamJournalStableIdentity): void {
  if (
    typeof value.streamId !== 'string' ||
    value.streamId.length === 0 ||
    typeof value.chatId !== 'string' ||
    value.chatId.length === 0 ||
    typeof value.messageId !== 'string' ||
    value.messageId.length === 0
  ) {
    throw new Error('StreamJournalStableIdentityInvalid')
  }
  assertNonNegativeSafeInteger(value.replacementEpoch, 'replacement-epoch')
  assertNonNegativeSafeInteger(value.admissionSequence, 'admission-sequence')
}

function assertStreamJournalWriterAuthority(value: StreamJournalWriterAuthority): void {
  assertStreamJournalStableIdentity(value)
  if (
    typeof value.ownerClientId !== 'string' ||
    value.ownerClientId.length === 0 ||
    typeof value.fenceToken !== 'string' ||
    value.fenceToken.length === 0
  ) {
    throw new Error('StreamJournalWriterAuthorityInvalid')
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`StreamJournalIntegerInvalid:${field}`)
  }
}

function markCanonicalStreamJournalFrame(
  value: StreamJournalFrameRow,
): CanonicalStreamJournalFrameRow {
  const frame = Object.freeze(value) as CanonicalStreamJournalFrameRow
  canonicalFrameInstances.add(frame)
  return frame
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStreamJournalDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function hasExactEnumerableKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.size && keys.every((key) => expected.has(key))
}

function isStreamJournalValueToken(value: unknown): value is StreamJournalValueToken {
  if (!Array.isArray(value) || typeof value[0] !== 'string') return false
  switch (value[0]) {
    case 'null':
    case 'array-start':
    case 'array-end':
    case 'object-start':
    case 'object-end':
      return value.length === 1
    case 'boolean':
      return value.length === 2 && typeof value[1] === 'boolean'
    case 'number':
      return value.length === 2 && typeof value[1] === 'number' && Number.isFinite(value[1])
    case 'string':
    case 'string-start':
    case 'string-chunk':
    case 'string-end':
    case 'object-key':
    case 'object-key-start':
    case 'object-key-chunk':
    case 'object-key-end':
      return (
        value.length === 2 &&
        typeof value[1] === 'string' &&
        value[1].length <= STREAM_JOURNAL_STRING_TOKEN_CHARS
      )
    default:
      return false
  }
}

function isStreamJournalTokenPage(
  value: readonly unknown[],
): value is readonly StreamJournalValueToken[] {
  if (value.length === 0) return false
  let bytes = 2
  for (let index = 0; index < value.length; index += 1) {
    const token = value[index]
    if (!isStreamJournalValueToken(token)) return false
    bytes = saturatingAdd(bytes, (index === 0 ? 0 : 1) + streamJournalTokenEncodedByteLength(token))
    if (bytes > STREAM_JOURNAL_PAGE_MAX_BYTES) return false
  }
  return true
}

function saturatingSum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total = Math.min(Number.MAX_SAFE_INTEGER, total + value)
  return total
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function streamJournalFrameError(streamId: string, detail: string): Error {
  return new Error(`StreamJournalFrameTransitionInvalid:${streamId}:${detail}`)
}

function streamJournalDecodeError(streamId: string, detail: string): Error {
  return new Error(`StreamJournalFrameDecodeInvalid:${streamId}:${detail}`)
}

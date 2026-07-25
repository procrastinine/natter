import type { Transaction } from 'dexie'
import {
  normalizeAttemptIntegritySummary,
  toPersistedAttemptFailure,
} from '../core/attempt-outcome'
import type {
  AttemptFailureCategory,
  AttemptIntegrityState,
  AttemptIntegritySummary,
  ContinuationAttempt,
  GenerationMeta,
  PersistedAttemptFailure,
} from '../core/types'
import type { MessageBodyRow, MessageHeaderRow } from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

const GENERATION_STATUSES = new Set<NonNullable<GenerationMeta['status']>>([
  'preparing',
  'streaming',
  'done',
  'error',
  'abort',
  'interrupted',
])

const INTEGRITY_STATES = new Set<AttemptIntegrityState>(['clean', 'degraded', 'failed'])

const INTEGRITY_SUMMARY_KEYS = ['count', 'characterCount', 'entries'] as const
const INTEGRITY_ENTRY_KEYS = [
  'category',
  'adapter',
  'eventType',
  'count',
  'fingerprint',
  'characterCount',
] as const
const PERSISTED_FAILURE_KEYS = [
  'category',
  'code',
  'message',
  'statusCode',
  'provider',
  'retryable',
  'midStream',
] as const

export async function migrateGenerationAttemptOutcomes(tx: Transaction): Promise<void> {
  const messages = tx.table<LegacyContinuationHeaderRow, string>('messages')
  const messageBodies = tx.table<MessageBodyRow, string>('messageBodies')
  await forEachTableBatch(messages, async (rows) => {
    const legacyAttemptRows = rows.filter(
      (row) => hasOwn(row, 'continuationAttempts') && row.continuationAttempts !== undefined,
    )
    const bodies = await messageBodies.bulkGet(legacyAttemptRows.map((row) => row.id))
    const bodiesById = new Map<string, MessageBodyRow>()
    for (const body of bodies) {
      if (body) bodiesById.set(body.id, body)
    }
    const changedHeaders: LegacyContinuationHeaderRow[] = []
    const changedBodies: MessageBodyRow[] = []

    for (const row of rows) {
      let changed = false
      if (row.generation) {
        const generation = normalizeGenerationMetaOutcome(row.generation)
        if (generation !== row.generation) {
          row.generation = generation
          changed = true
        }
      }
      if (hasOwn(row, 'continuationAttempts')) {
        const legacyAttempts = row.continuationAttempts
        if (legacyAttempts !== undefined) {
          if (!Array.isArray(legacyAttempts)) {
            throw new Error(`LegacyContinuationAttemptsInvalid:${row.id}`)
          }
          const body = bodiesById.get(row.id)
          if (!body) throw new Error(`MessageBodyMissing:${row.id}`)
          if (body.chatId !== row.chatId) {
            throw new Error(`MessageBodyChatMismatch:${row.id}:${row.chatId}:${body.chatId}`)
          }
          body.continuationAttempts = mergeContinuationAttempts(
            body.continuationAttempts,
            legacyAttempts,
          )
          changedBodies.push(body)
        }
        delete row.continuationAttempts
        changed = true
      }
      if (changed) changedHeaders.push(row)
    }

    if (changedBodies.length > 0) await messageBodies.bulkPut(changedBodies)
    if (changedHeaders.length > 0) await messages.bulkPut(changedHeaders)
  })

  await messageBodies.toCollection().modify((row) => {
    if (!row.continuationAttempts) return
    row.continuationAttempts = mapChanged(
      row.continuationAttempts,
      normalizeContinuationAttemptOutcome,
    )
  })

  await tx
    .table<LegacyStreamChunkEventRow, string>('streamChunks')
    .toCollection()
    .modify((row) => {
      row.event = normalizeStreamChunkEvent(row.event)
    })
}

interface LegacyStreamChunkEventRow {
  event: unknown
}

type LegacyContinuationHeaderRow = MessageHeaderRow & {
  continuationAttempts?: ContinuationAttempt[]
}

function mergeContinuationAttempts(
  bodyAttempts: readonly ContinuationAttempt[] | undefined,
  headerAttempts: readonly ContinuationAttempt[],
): ContinuationAttempt[] {
  const merged = [...(bodyAttempts ?? [])]
  const bodyIndexByStreamId = new Map<string, number>()
  for (let index = 0; index < merged.length; index += 1) {
    const streamId = merged[index]?.streamId
    if (streamId !== undefined && !bodyIndexByStreamId.has(streamId)) {
      bodyIndexByStreamId.set(streamId, index)
    }
  }
  for (const legacyAttempt of headerAttempts) {
    const bodyIndex = bodyIndexByStreamId.get(legacyAttempt.streamId)
    if (bodyIndex === undefined) {
      bodyIndexByStreamId.set(legacyAttempt.streamId, merged.length)
      merged.push(legacyAttempt)
      continue
    }
    const bodyAttempt = merged[bodyIndex]
    if (bodyAttempt) merged[bodyIndex] = mergeDefinedAttemptFields(legacyAttempt, bodyAttempt)
  }
  return merged.map(normalizeContinuationAttemptOutcome)
}

function mergeDefinedAttemptFields(
  fallback: ContinuationAttempt,
  preferred: ContinuationAttempt,
): ContinuationAttempt {
  const merged = { ...fallback } as ContinuationAttempt & Record<string, unknown>
  for (const [key, value] of Object.entries(preferred)) {
    if (value !== undefined) merged[key] = value
  }
  return merged
}

export function normalizeGenerationMetaOutcome(input: GenerationMeta): GenerationMeta {
  const normalizedSummary = normalizeAttemptIntegritySummary(input.integritySummary)
  const summary = sameIntegritySummary(input.integritySummary, normalizedSummary)
    ? input.integritySummary
    : normalizedSummary
  const status = validGenerationStatus(input.status) ?? deriveGenerationStatus(input)
  const integrity = validIntegrityState(input.integrity) ?? (summary ? 'degraded' : 'clean')
  const normalizedError =
    input.error === undefined ? undefined : toPersistedAttemptFailure(input.error, 'provider')
  const error = samePersistedFailure(input.error, normalizedError) ? input.error : normalizedError
  if (
    status === input.status &&
    integrity === input.integrity &&
    summary === input.integritySummary &&
    error === input.error
  ) {
    return input
  }
  const generation: GenerationMeta = { ...input, status, integrity }
  if (summary !== undefined) generation.integritySummary = summary
  else delete generation.integritySummary
  if (error !== undefined) generation.error = error
  else delete generation.error
  return generation
}

export function normalizeContinuationAttemptOutcome(
  input: ContinuationAttempt,
): ContinuationAttempt {
  const normalizedSummary = normalizeAttemptIntegritySummary(input.integritySummary)
  const summary = sameIntegritySummary(input.integritySummary, normalizedSummary)
    ? input.integritySummary
    : normalizedSummary
  const integrity = validIntegrityState(input.integrity) ?? (summary ? 'degraded' : 'clean')
  const normalizedError =
    input.error === undefined ? undefined : toPersistedAttemptFailure(input.error, 'provider')
  const error = samePersistedFailure(input.error, normalizedError) ? input.error : normalizedError
  if (
    integrity === input.integrity &&
    summary === input.integritySummary &&
    error === input.error
  ) {
    return input
  }
  const attempt: ContinuationAttempt = { ...input, integrity }
  if (summary !== undefined) attempt.integritySummary = summary
  else delete attempt.integritySummary
  if (error !== undefined) attempt.error = error
  else delete attempt.error
  return attempt
}

function normalizeStreamChunkEvent(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const event = input as Record<string, unknown>
  if (event.lane !== 'error') return input
  const failure = toPersistedAttemptFailure(event.error, 'provider')
  return {
    lane: 'error',
    error: {
      kind: runtimeKindForFailure(failure.category),
      code: failure.code,
      message: failure.message,
      midStream: failure.midStream ?? true,
      retryable: failure.retryable ?? false,
      ...(failure.statusCode !== undefined ? { httpStatus: failure.statusCode } : {}),
    },
  }
}

function sameIntegritySummary(
  input: unknown,
  normalized: AttemptIntegritySummary | undefined,
): boolean {
  if (input === undefined || normalized === undefined) return input === normalized
  if (!isRecord(input) || !Array.isArray(input.entries)) return false
  if (
    !hasOnlyKeys(input, INTEGRITY_SUMMARY_KEYS) ||
    input.count !== normalized.count ||
    input.characterCount !== normalized.characterCount ||
    input.entries.length !== normalized.entries.length
  ) {
    return false
  }
  return input.entries.every((entry: unknown, index: number) => {
    const next = normalized.entries[index]
    return (
      next !== undefined &&
      isRecord(entry) &&
      hasOnlyKeys(entry, INTEGRITY_ENTRY_KEYS) &&
      entry.category === next.category &&
      entry.adapter === next.adapter &&
      entry.eventType === next.eventType &&
      entry.count === next.count &&
      entry.fingerprint === next.fingerprint &&
      entry.characterCount === next.characterCount
    )
  })
}

function samePersistedFailure(
  input: unknown,
  normalized: PersistedAttemptFailure | undefined,
): boolean {
  if (input === undefined || normalized === undefined) return input === normalized
  if (!isRecord(input)) return false
  return (
    hasOnlyKeys(input, PERSISTED_FAILURE_KEYS) &&
    input.category === normalized.category &&
    input.code === normalized.code &&
    input.message === normalized.message &&
    input.statusCode === normalized.statusCode &&
    input.provider === normalized.provider &&
    input.retryable === normalized.retryable &&
    input.midStream === normalized.midStream
  )
}

function hasOnlyKeys(input: object, keys: readonly string[]): boolean {
  return Object.keys(input).every((key) => keys.includes(key))
}

function hasOwn(input: object, key: string): boolean {
  return Object.hasOwn(input, key)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === 'object' && !Array.isArray(input)
}

function mapChanged<T>(values: readonly T[], map: (value: T) => T): T[] {
  let result: T[] | undefined
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index] as T
    const next = map(current)
    if (result) result.push(next)
    else if (next !== current) result = [...values.slice(0, index), next]
  }
  return result ?? (values as T[])
}

function deriveGenerationStatus(generation: GenerationMeta): NonNullable<GenerationMeta['status']> {
  if (generation.finishedAt === undefined) return 'streaming'
  if (generation.error !== undefined) return 'error'
  if (generation.abortReason === 'tab-close') return 'interrupted'
  if (generation.abortReason !== undefined) return 'abort'
  return 'done'
}

function validGenerationStatus(input: unknown): NonNullable<GenerationMeta['status']> | undefined {
  return GENERATION_STATUSES.has(input as NonNullable<GenerationMeta['status']>)
    ? (input as NonNullable<GenerationMeta['status']>)
    : undefined
}

function validIntegrityState(input: unknown): AttemptIntegrityState | undefined {
  return INTEGRITY_STATES.has(input as AttemptIntegrityState)
    ? (input as AttemptIntegrityState)
    : undefined
}

function runtimeKindForFailure(category: AttemptFailureCategory): string {
  switch (category) {
    case 'abort':
      return 'abort'
    case 'network':
      return 'network'
    case 'protocol':
      return 'protocol'
    case 'provider':
      return 'provider_error'
    case 'storage':
      return 'storage'
    case 'integrity':
      return 'integrity'
    case 'internal':
      return 'internal'
  }
}

import type { GenerationFailureKindV2 } from './generation-stream-events'
import type {
  AbortReason,
  AttemptFailureCategory,
  AttemptIntegrityEntry,
  AttemptIntegritySummary,
  PersistedAttemptFailure,
} from './types'

const MAX_FAILURE_CODE_CHARS = 80
const MAX_FAILURE_MESSAGE_CHARS = 240
const MAX_PROVIDER_CHARS = 80
const MAX_INTEGRITY_ENTRIES = 16
const TERMINAL_RECEIPT_KEYS = new Set([
  'version',
  'finishedAt',
  'journalMaxSeq',
  'journalCompleteness',
  'decision',
])
const TERMINAL_DECISION_KEYS = new Set(['outcome', 'finishReason', 'error', 'abortReason'])
const TERMINAL_FAILURE_KEYS = new Set([
  'kind',
  'category',
  'code',
  'message',
  'statusCode',
  'provider',
  'retryable',
  'midStream',
])

export interface AttemptTerminalFailure extends PersistedAttemptFailure {
  readonly kind: GenerationFailureKindV2
}

interface AttemptTerminalDecisionBase {
  readonly finishReason?: string
}

export type AttemptTerminalDecision =
  | (AttemptTerminalDecisionBase & {
      readonly outcome: 'done'
      readonly error?: never
      readonly abortReason?: never
    })
  | (AttemptTerminalDecisionBase & {
      readonly outcome: 'error'
      readonly error: AttemptTerminalFailure
      readonly abortReason?: never
    })
  | (AttemptTerminalDecisionBase & {
      readonly outcome: 'abort'
      readonly abortReason: AbortReason
      readonly error?: never
    })

export interface AttemptTerminalReceipt {
  readonly version: 1
  readonly finishedAt: number
  readonly journalMaxSeq: number
  readonly journalCompleteness: 'settled'
  readonly decision: AttemptTerminalDecision
}

export type AttemptTerminalDecisionInput =
  | {
      readonly outcome: 'done'
      readonly finishReason?: string
      readonly error?: never
      readonly abortReason?: never
    }
  | {
      readonly outcome: 'error'
      readonly error: unknown
      readonly finishReason?: string
      readonly abortReason?: never
    }
  | {
      readonly outcome: 'abort'
      readonly abortReason: AbortReason
      readonly finishReason?: string
      readonly error?: never
    }

export function normalizeAttemptTerminalDecision(
  input: AttemptTerminalDecisionInput,
): AttemptTerminalDecision {
  const finishReason = boundedPlainString(input.finishReason, 80)
  if (input.outcome === 'done') {
    return { outcome: 'done', ...(finishReason ? { finishReason } : {}) }
  }
  if (input.outcome === 'abort') {
    return {
      outcome: 'abort',
      abortReason: input.abortReason,
      ...(finishReason ? { finishReason } : {}),
    }
  }
  const failure = toPersistedAttemptFailure(input.error)
  return {
    outcome: 'error',
    error: {
      ...failure,
      kind: generationFailureKind(input.error, failure.category),
    },
    ...(finishReason ? { finishReason } : {}),
  }
}

export function isAttemptTerminalReceipt(value: unknown): value is AttemptTerminalReceipt {
  const receipt = objectRecord(value)
  if (
    !hasOnlyKeys(receipt, TERMINAL_RECEIPT_KEYS) ||
    receipt.version !== 1 ||
    !isNonNegativeSafeInteger(receipt.finishedAt) ||
    !isSafeIntegerAtLeast(receipt.journalMaxSeq, -1) ||
    receipt.journalCompleteness !== 'settled'
  ) {
    return false
  }
  return isAttemptTerminalDecision(receipt.decision)
}

const FAILURE_CATEGORIES = new Set<AttemptFailureCategory>([
  'abort',
  'network',
  'protocol',
  'provider',
  'storage',
  'integrity',
  'internal',
])
const GENERATION_FAILURE_KINDS = new Set<GenerationFailureKindV2>([
  'network',
  'timeout',
  'abort',
  'bad_request',
  'unauthorized',
  'payment_required',
  'moderation',
  'rate_limited',
  'provider_error',
  'no_provider_available',
  'validation',
  'protocol',
  'storage',
  'integrity',
  'internal',
])

const INTEGRITY_ADAPTERS = new Set<AttemptIntegrityEntry['adapter']>([
  'chat-completions',
  'responses',
  'gemini-native',
  'anthropic-messages',
  'text-completions',
])
const INTEGRITY_CATEGORIES = new Set<AttemptIntegrityEntry['category']>([
  'malformed-json-frame',
  'malformed-event-shape',
])

export function toPersistedAttemptFailure(
  input: unknown,
  fallbackCategory: AttemptFailureCategory = 'internal',
): PersistedAttemptFailure {
  const record = objectRecord(input)
  const nested = objectRecord(record?.raw)
  const category =
    readFailureCategory(record?.category) ?? categoryForKind(record?.kind ?? nested?.kind)
  const resolvedCategory = category ?? fallbackCategory
  const statusCode = finiteStatus(record?.statusCode ?? record?.httpStatus ?? nested?.httpStatus)
  const code = safeFailureCode(record?.code ?? nested?.code, resolvedCategory, statusCode)
  const message = safeFailureMessage(
    record?.message ?? nested?.message,
    resolvedCategory,
    statusCode,
  )
  const provider = safeProvider(record?.provider ?? nested?.provider)
  const retryable = booleanField(record?.retryable ?? nested?.retryable)
  const midStream = booleanField(record?.midStream ?? nested?.midStream)

  return {
    category: resolvedCategory,
    code,
    message,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(midStream !== undefined ? { midStream } : {}),
  }
}

export function normalizeAttemptIntegritySummary(
  input: unknown,
): AttemptIntegritySummary | undefined {
  const record = objectRecord(input)
  if (!record) return undefined
  const count = nonNegativeInteger(record.count)
  const characterCount = nonNegativeInteger(record.characterCount)
  const rawEntries = Array.isArray(record.entries) ? record.entries : []
  const entries: AttemptIntegrityEntry[] = []
  for (const rawEntry of rawEntries.slice(0, MAX_INTEGRITY_ENTRIES)) {
    const entry = normalizeIntegrityEntry(rawEntry)
    if (entry) entries.push(entry)
  }
  if (count === 0 && characterCount === 0 && entries.length === 0) return undefined
  return { count, characterCount, entries }
}

function normalizeIntegrityEntry(input: unknown): AttemptIntegrityEntry | undefined {
  const record = objectRecord(input)
  if (!record) return undefined
  if (!INTEGRITY_CATEGORIES.has(record.category as AttemptIntegrityEntry['category'])) {
    return undefined
  }
  if (!INTEGRITY_ADAPTERS.has(record.adapter as AttemptIntegrityEntry['adapter'])) return undefined
  const fingerprint = boundedPlainString(record.fingerprint, 32)
  if (!fingerprint || !/^fnv1a32:[0-9a-f]{8}$/u.test(fingerprint)) return undefined
  return {
    category: record.category as AttemptIntegrityEntry['category'],
    adapter: record.adapter as AttemptIntegrityEntry['adapter'],
    eventType: boundedPlainString(record.eventType, 80) ?? 'unknown',
    count: nonNegativeInteger(record.count),
    fingerprint,
    characterCount: nonNegativeInteger(record.characterCount),
  }
}

function categoryForKind(input: unknown): AttemptFailureCategory | undefined {
  if (typeof input !== 'string') return undefined
  switch (input) {
    case 'abort':
      return 'abort'
    case 'network':
    case 'timeout':
      return 'network'
    case 'protocol':
    case 'validation':
      return 'protocol'
    case 'bad_request':
    case 'unauthorized':
    case 'payment_required':
    case 'moderation':
    case 'rate_limited':
    case 'provider_error':
    case 'no_provider_available':
      return 'provider'
    case 'storage':
      return 'storage'
    case 'integrity':
      return 'integrity'
    case 'internal':
    case 'unknown':
      return 'internal'
    default:
      return undefined
  }
}

function generationFailureKind(
  input: unknown,
  fallback: AttemptFailureCategory,
): GenerationFailureKindV2 {
  const kind = objectRecord(input)?.kind
  if (typeof kind === 'string' && GENERATION_FAILURE_KINDS.has(kind as GenerationFailureKindV2)) {
    return kind as GenerationFailureKindV2
  }
  switch (fallback) {
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

function isAttemptTerminalDecision(value: unknown): value is AttemptTerminalDecision {
  const decision = objectRecord(value)
  if (!hasOnlyKeys(decision, TERMINAL_DECISION_KEYS)) return false
  if (decision.finishReason !== undefined && typeof decision.finishReason !== 'string') return false
  if (decision.outcome === 'done') {
    return decision.error === undefined && decision.abortReason === undefined
  }
  if (decision.outcome === 'abort') {
    return isAbortReason(decision.abortReason) && decision.error === undefined
  }
  if (decision.outcome !== 'error' || decision.abortReason !== undefined) return false
  const error = objectRecord(decision.error)
  return (
    hasOnlyKeys(error, TERMINAL_FAILURE_KEYS) &&
    typeof error.kind === 'string' &&
    GENERATION_FAILURE_KINDS.has(error.kind as GenerationFailureKindV2) &&
    typeof error.category === 'string' &&
    FAILURE_CATEGORIES.has(error.category as AttemptFailureCategory) &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    (error.statusCode === undefined || finiteStatus(error.statusCode) !== undefined) &&
    (error.provider === undefined || typeof error.provider === 'string') &&
    (error.retryable === undefined || typeof error.retryable === 'boolean') &&
    (error.midStream === undefined || typeof error.midStream === 'boolean')
  )
}

function isAbortReason(value: unknown): value is AbortReason {
  return (
    value === 'user' ||
    value === 'tab-close' ||
    value === 'error' ||
    value === 'network' ||
    value === 'quota'
  )
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return isSafeIntegerAtLeast(value, 0)
}

function readFailureCategory(input: unknown): AttemptFailureCategory | undefined {
  return typeof input === 'string' && FAILURE_CATEGORIES.has(input as AttemptFailureCategory)
    ? (input as AttemptFailureCategory)
    : undefined
}

function safeFailureCode(
  input: unknown,
  category: AttemptFailureCategory,
  statusCode: number | undefined,
): string {
  const fallback = statusCode === undefined ? category.toUpperCase() : String(statusCode)
  if (typeof input !== 'string' && typeof input !== 'number') return fallback
  const compact = String(input).trim().slice(0, MAX_FAILURE_CODE_CHARS)
  return /^[A-Za-z0-9_.:/-]+$/u.test(compact) ? compact : fallback
}

function safeFailureMessage(
  input: unknown,
  category: AttemptFailureCategory,
  statusCode: number | undefined,
): string {
  const fallback = defaultFailureMessage(category, statusCode)
  if (typeof input !== 'string') return fallback
  const compact = input.replace(/\s+/gu, ' ').trim()
  if (!compact || looksPayloadBearing(compact)) return fallback
  return redactKnownCredentials(compact).slice(0, MAX_FAILURE_MESSAGE_CHARS) || fallback
}

function looksPayloadBearing(value: string): boolean {
  if (value.includes('\n') || value.includes('\r')) return true
  if (/^[[{]/u.test(value) || /(?:request|response)\s+(?:body|payload)/iu.test(value)) return true
  if (/(?:prompt|completion|output)\s*[:=]/iu.test(value)) return true
  return false
}

function redactKnownCredentials(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer <redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '<redacted>')
    .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, '<redacted>')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '<redacted>')
}

function defaultFailureMessage(
  category: AttemptFailureCategory,
  statusCode: number | undefined,
): string {
  switch (category) {
    case 'abort':
      return 'Request aborted'
    case 'network':
      return 'Network request failed'
    case 'protocol':
      return 'Provider response could not be decoded'
    case 'provider':
      return statusCode === undefined
        ? 'Provider request failed'
        : `Provider request failed (${statusCode})`
    case 'storage':
      return 'Local persistence failed'
    case 'integrity':
      return 'Response integrity could not be verified'
    case 'internal':
      return 'Internal generation failure'
  }
}

function safeProvider(input: unknown): string | undefined {
  const value = boundedPlainString(input, MAX_PROVIDER_CHARS)
  return value && /^[\p{L}\p{N} ._:/()-]+$/u.test(value) ? value : undefined
}

function boundedPlainString(input: unknown, maxChars: number): string | undefined {
  if (typeof input !== 'string') return undefined
  const value = input.replace(/\s+/gu, ' ').trim()
  return value ? value.slice(0, maxChars) : undefined
}

function finiteStatus(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 100 && input <= 599
    ? input
    : undefined
}

function nonNegativeInteger(input: unknown): number {
  return typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : 0
}

function booleanField(input: unknown): boolean | undefined {
  return typeof input === 'boolean' ? input : undefined
}

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === 'object'
    ? (input as Record<string, unknown>)
    : undefined
}

function hasOnlyKeys(
  value: Record<string, unknown> | undefined,
  allowed: ReadonlySet<string>,
): value is Record<string, unknown> {
  if (!value) return false
  return Object.keys(value).every((key) => allowed.has(key))
}

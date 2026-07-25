import { canonicalStreamEventV1FromUnknown } from './canonical-stream-event-v1'
import type {
  CanonicalStreamEventV1,
  ReasoningOriginDialectV1,
} from './generation-stream-events-v1'
import { persistedStreamEventV1FromUnknown } from './persisted-stream-event-v1'
import { inferLegacyReasoningFormat } from './reasoning-carriers-v80'
import {
  applyReasoningEnvelopeIngress,
  applyReasoningEnvelopeMutation,
  createReasoningEnvelopeState,
  isReasoningFormatV1,
  type ReasoningEnvelopeState,
  reasoningIngressFromDetails,
} from './reasoning-envelope-v1'
import {
  legacyReasoningDetailsForV89,
  normalizeReasoningEnvelopeFields,
} from './reasoning-envelope-v89'
import type { V88StreamLeaseRow } from './stream-lease-schema-versions'

type ReasoningOriginDialect = ReasoningOriginDialectV1

export interface V89ProfileIdentity {
  readonly kind?: unknown
}

export interface V88JournalEventConverter {
  readonly reasoning: ReasoningEnvelopeState
  readonly originDialect: ReasoningOriginDialect
  readonly generation: Readonly<{
    apiUsed?:
      | 'chat'
      | 'responses'
      | 'gemini-native'
      | 'anthropic-messages'
      | 'completion'
      | 'video-generation'
    model?: string
    requestedModel?: string
  }>
  readonly responsesDialect?: 'openai-responses' | 'openrouter-responses'
  readonly serverToolDialect?: 'google-gemini' | 'anthropic-claude'
  readonly adapter:
    | 'chat-completions'
    | 'responses'
    | 'gemini-native'
    | 'anthropic-messages'
    | 'text-completions'
}

export function convertV88JournalEvent(
  value: unknown,
  createdAt: number,
  context: V88JournalEventConverter,
): CanonicalStreamEventV1 {
  const persisted = persistedStreamEventV1FromUnknown(value)
  if (persisted) {
    applyCanonicalReasoningEvent(persisted.event, context.reasoning)
    return persisted.event
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('StreamJournalV89SemanticEventInvalid')
  }
  const raw = value as Record<string, unknown>
  if (raw.lane === 'reasoning') return convertLegacyReasoningEvent(raw, createdAt, context)
  const normalized = normalizeLegacyResultSnapshot(normalizeProviderDialect(raw, context), context)
  const event = canonicalStreamEventV1FromUnknown(normalized)
  if (!event) throw new Error('StreamJournalV89SemanticEventInvalid')
  applyCanonicalReasoningEvent(event, context.reasoning)
  return event
}

function normalizeLegacyResultSnapshot(
  raw: Record<string, unknown>,
  context: V88JournalEventConverter,
): Record<string, unknown> {
  if (raw.lane !== 'result-snapshot' || !raw.payload || typeof raw.payload !== 'object') {
    return raw
  }
  const payload = raw.payload as Record<string, unknown>
  if (payload.kind !== 'replace' || !Object.hasOwn(payload, 'reasoningDetails')) return raw
  const reasoning: Record<string, unknown> = {
    reasoningDetails: payload.reasoningDetails,
  }
  normalizeReasoningEnvelopeFields(reasoning, context.generation)
  const { reasoningDetails: _reasoningDetails, ...base } = payload
  return {
    ...raw,
    payload: {
      ...base,
      reasoningEnvelope: reasoning.reasoningEnvelope ?? {
        schemaVersion: 1,
        visible: [],
        carriers: [],
      },
    },
  }
}

function convertLegacyReasoningEvent(
  raw: Record<string, unknown>,
  createdAt: number,
  context: V88JournalEventConverter,
): CanonicalStreamEventV1 {
  const current = canonicalStreamEventV1FromUnknown(raw)
  if (current) {
    applyCanonicalReasoningEvent(current, context.reasoning)
    return current
  }
  const operations = []
  if (Array.isArray(raw.details)) {
    const details = legacyReasoningDetailsForV89(raw.details, context.generation)
    operations.push(
      ...reasoningIngressFromDetails({
        details,
        mode:
          raw.detailsMode === 'delta' || raw.detailsMode === 'cumulative'
            ? raw.detailsMode
            : 'snapshot',
        dialect: context.originDialect,
      }),
    )
  }
  const format = isReasoningFormatV1(raw.format)
    ? raw.format
    : inferLegacyReasoningFormat(context.generation)
  const outputIndex = nonNegativeSafeInteger(raw.outputIndex) ?? 0
  const itemId = nonEmptyString(raw.itemId)
  const common = {
    index: outputIndex,
    ...(itemId ? { providerItemId: itemId } : {}),
    providerOutputIndex: outputIndex,
  }
  if (typeof raw.textDelta === 'string') {
    operations.push(
      ...reasoningIngressFromDetails({
        details: [
          {
            type: 'reasoning.text',
            format,
            text: raw.textDelta,
            id: legacyScalarReasoningId('text', itemId, outputIndex),
            ...common,
          },
        ],
        mode: 'delta',
        dialect: context.originDialect,
      }),
    )
  }
  if (typeof raw.summaryDelta === 'string') {
    const summaryIndex = nonNegativeSafeInteger(raw.summaryIndex) ?? 0
    operations.push(
      ...reasoningIngressFromDetails({
        details: [
          {
            type: 'reasoning.summary',
            format,
            summary: raw.summaryDelta,
            id: legacyScalarReasoningId('summary', itemId, outputIndex, summaryIndex),
            providerSummaryIndex: summaryIndex,
            ...common,
          },
        ],
        mode: 'delta',
        dialect: context.originDialect,
      }),
    )
  }
  if (typeof raw.encryptedDelta === 'string') {
    operations.push(
      ...reasoningIngressFromDetails({
        details: [
          {
            type: 'reasoning.encrypted',
            format,
            data: raw.encryptedDelta,
            id: legacyScalarReasoningId('encrypted', itemId, outputIndex),
            ...common,
          },
        ],
        mode: raw.replaceEncrypted === true ? 'snapshot' : 'delta',
        dialect: context.originDialect,
      }),
    )
  }
  const mutations = operations.flatMap((operation) =>
    applyReasoningEnvelopeIngress(context.reasoning, operation),
  )
  return {
    lane: 'reasoning',
    mutations,
    observed: { firstAt: createdAt, lastAt: createdAt },
  }
}

function applyCanonicalReasoningEvent(
  event: CanonicalStreamEventV1,
  state: ReasoningEnvelopeState,
): void {
  if (event.lane === 'reasoning') {
    for (const mutation of event.mutations) applyReasoningEnvelopeMutation(state, mutation)
    return
  }
  if (event.lane === 'result-snapshot' && event.payload.kind === 'replace') {
    applyReasoningEnvelopeMutation(state, {
      kind: 'replace',
      envelope: event.payload.reasoningEnvelope,
    })
  }
}

function normalizeProviderDialect(
  raw: Record<string, unknown>,
  context: V88JournalEventConverter,
): Record<string, unknown> {
  if (raw.lane === 'output-item-added' || raw.lane === 'output-item-done') {
    if (raw.dialect === 'openai-responses' || raw.dialect === 'openrouter-responses') return raw
    if (!context.responsesDialect) throw new Error('StreamJournalV89ResponsesDialectMissing')
    return { ...raw, dialect: context.responsesDialect }
  }
  if (raw.lane === 'server-tool-output') {
    if (raw.dialect === 'google-gemini' || raw.dialect === 'anthropic-claude') return raw
    if (!context.serverToolDialect) throw new Error('StreamJournalV89ServerToolDialectMissing')
    return { ...raw, dialect: context.serverToolDialect }
  }
  return raw
}

export function createV88JournalEventConverter(
  lease: V88StreamLeaseRow,
  profile: V89ProfileIdentity | undefined,
): V88JournalEventConverter {
  const dispatch = lease.phase === 'reserved' ? undefined : (lease.dispatch ?? undefined)
  const apiUsed = dispatch?.apiUsed
  const generation = {
    ...(apiUsed ? { apiUsed } : {}),
    ...(dispatch?.requestedModel
      ? {
          model: dispatch.requestedModel,
          requestedModel: dispatch.requestedModel,
        }
      : {}),
  }
  return {
    reasoning: createReasoningEnvelopeState(),
    originDialect: reasoningOriginDialect(apiUsed, profile),
    generation,
    ...(apiUsed === 'responses' && profile
      ? {
          responsesDialect:
            profile.kind === 'openrouter' ? 'openrouter-responses' : 'openai-responses',
        }
      : {}),
    ...(apiUsed === 'gemini-native'
      ? { serverToolDialect: 'google-gemini' as const }
      : apiUsed === 'anthropic-messages'
        ? { serverToolDialect: 'anthropic-claude' as const }
        : {}),
    adapter:
      apiUsed === 'responses'
        ? 'responses'
        : apiUsed === 'gemini-native'
          ? 'gemini-native'
          : apiUsed === 'anthropic-messages'
            ? 'anthropic-messages'
            : apiUsed === 'completion'
              ? 'text-completions'
              : 'chat-completions',
  }
}

function reasoningOriginDialect(
  apiUsed: V88JournalEventConverter['generation']['apiUsed'],
  profile: V89ProfileIdentity | undefined,
): ReasoningOriginDialect {
  if (apiUsed === 'responses') {
    if (!profile) return 'unknown'
    return profile.kind === 'openrouter' ? 'openrouter-responses' : 'openai-responses'
  }
  if (apiUsed === 'gemini-native') return 'gemini-native'
  if (apiUsed === 'anthropic-messages') return 'anthropic-messages'
  if (apiUsed === 'chat') {
    if (!profile) return 'unknown'
    return profile.kind === 'openrouter' ? 'openrouter-chat' : 'openai-chat'
  }
  if (apiUsed === 'completion') return 'inline'
  return 'unknown'
}

export function v88JournalIntegrityEvent(
  context: V88JournalEventConverter,
  streamId: string,
): CanonicalStreamEventV1 {
  const value = `stream-journal-v89:${streamId}`
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return {
    lane: 'integrity',
    integrity: {
      category: 'malformed-event-shape',
      adapter: context.adapter,
      eventType: 'stream-journal-v89',
      count: 1,
      fingerprint: `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`,
      characterCount: value.length,
    },
  }
}

function legacyScalarReasoningId(
  kind: 'text' | 'summary' | 'encrypted',
  itemId: string | undefined,
  outputIndex: number,
  memberIndex = 0,
): string {
  return `legacy-journal:${JSON.stringify([kind, itemId ?? null, outputIndex, memberIndex])}`
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

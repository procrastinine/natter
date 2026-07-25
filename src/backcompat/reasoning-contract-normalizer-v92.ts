import type {
  OpaqueReasoningCarrierV1,
  ReasoningEnvelopeV1Schema,
  ReasoningFormatV1,
  ReasoningSourceRefV1,
  ReasoningVisiblePartV1,
} from './generation-stream-events-v1'
import type { LegacyReasoningGenerationIdentity } from './reasoning-carriers-v80'
import { isReasoningEnvelopeV1 } from './reasoning-envelope-v1'
import {
  type LegacyReasoningEnvelopeFields,
  normalizeReasoningEnvelopeFields,
} from './reasoning-envelope-v89'

export type ReasoningFormatV92 = ReasoningFormatV1
export type ReasoningOriginDialectV92 = ReasoningSourceRefV1['dialect']
export type ReasoningProducerBridgeV92 =
  | 'inline'
  | 'openrouter'
  | 'openai-direct'
  | 'azure-openai'
  | 'anthropic-direct'
  | 'google-direct'
  | 'custom'
  | 'unknown'

export type ReasoningSourceRefV92 = ReasoningSourceRefV1 & {
  readonly bridge: ReasoningProducerBridgeV92
}

export type ReasoningVisiblePartV92 = Omit<ReasoningVisiblePartV1, 'source'> & {
  readonly source: ReasoningSourceRefV92
}

export type OpaqueReasoningCarrierV92 = OpaqueReasoningCarrierV1 extends infer Carrier
  ? Carrier extends OpaqueReasoningCarrierV1
    ? Omit<Carrier, 'source'> & { readonly source: ReasoningSourceRefV92 }
    : never
  : never

export interface ReasoningEnvelopeV92 {
  readonly schemaVersion: 2
  readonly visible: ReasoningVisiblePartV92[]
  readonly carriers: OpaqueReasoningCarrierV92[]
}

export type PersistedReasoningVisibilityV92 =
  | Readonly<{ disclosure: 'unknown' }>
  | Readonly<{ disclosure: 'visible'; visibleKind: 'text' | 'summary' }>
  | Readonly<{
      disclosure: 'absent'
      unexpectedVisibleKind: 'text' | 'summary'
      reason: 'api-mode' | 'request-display' | 'provider-default' | 'disabled'
    }>

export type PersistedReasoningCarryForwardV92 = 'none' | 'visible-only' | 'carrier' | 'unknown'

export interface ReasoningAttemptV92Context {
  readonly apiUsed?: string
  readonly profile?: Readonly<{ kind?: unknown; baseUrl?: unknown }>
}

const UNKNOWN_VISIBILITY = Object.freeze({ disclosure: 'unknown' } as const)
const REASONING_FORMATS = new Set<ReasoningFormatV92>([
  'unknown',
  'openai-responses-v1',
  'azure-openai-responses-v1',
  'xai-responses-v1',
  'anthropic-claude-v1',
  'google-gemini-v1',
])
const REASONING_DIALECTS = new Set<ReasoningOriginDialectV92>([
  'inline',
  'openai-chat',
  'openrouter-chat',
  'openai-responses',
  'openrouter-responses',
  'anthropic-messages',
  'gemini-native',
  'unknown',
])
const REASONING_BRIDGES = new Set<ReasoningProducerBridgeV92>([
  'inline',
  'openrouter',
  'openai-direct',
  'azure-openai',
  'anthropic-direct',
  'google-direct',
  'custom',
  'unknown',
])
const SOURCE_STRING_KEYS = ['itemId', 'detailId'] as const
const SOURCE_GROUP_STRING_KEYS = ['itemId'] as const
const SOURCE_INDEX_KEYS = [
  'choiceIndex',
  'outputIndex',
  'contentIndex',
  'summaryIndex',
  'detailIndex',
  'detailOrdinal',
  'candidateIndex',
  'frameIndex',
  'partIndex',
  'blockIndex',
] as const
const SOURCE_GROUP_INDEX_KEYS = ['choiceIndex', 'outputIndex', 'candidateIndex'] as const

export function normalizeReasoningVisibilityV92(value: unknown): PersistedReasoningVisibilityV92 {
  const row = record(value)
  if (!row) return UNKNOWN_VISIBILITY
  if (row.disclosure === 'unknown' && Object.keys(row).length === 1) {
    return value as PersistedReasoningVisibilityV92
  }
  if (
    row.disclosure === 'visible' &&
    (row.visibleKind === 'text' || row.visibleKind === 'summary') &&
    Object.keys(row).length === 2
  ) {
    return value as PersistedReasoningVisibilityV92
  }
  if (
    row.disclosure === 'absent' &&
    (row.unexpectedVisibleKind === 'text' || row.unexpectedVisibleKind === 'summary') &&
    (row.reason === 'api-mode' ||
      row.reason === 'request-display' ||
      row.reason === 'provider-default' ||
      row.reason === 'disabled') &&
    Object.keys(row).length === 3
  ) {
    return value as PersistedReasoningVisibilityV92
  }
  return UNKNOWN_VISIBILITY
}

export function normalizeReasoningCarryForwardV92(
  value: unknown,
): PersistedReasoningCarryForwardV92 {
  return value === 'none' || value === 'visible-only' || value === 'carrier' || value === 'unknown'
    ? value
    : 'unknown'
}

export function normalizeGenerationReasoningContractV92<T extends object>(value: T): T {
  const raw = value as T & Record<string, unknown>
  const reasoningCarryForward = normalizeReasoningCarryForwardV92(raw.reasoningCarryForward)
  const reasoningVisibility = normalizeReasoningVisibilityV92(raw.reasoningVisibility)
  return reasoningCarryForward === raw.reasoningCarryForward &&
    reasoningVisibility === raw.reasoningVisibility
    ? value
    : { ...raw, reasoningCarryForward, reasoningVisibility }
}

export function normalizeContinuationAttemptContractV92<T extends object>(
  value: T,
  context: ReasoningAttemptV92Context = {},
): T {
  const reasoning = normalizeReasoningAttemptFieldsV92(
    value,
    value as LegacyReasoningGenerationIdentity,
    context,
  )
  const raw = reasoning as T & Record<string, unknown>
  const application = normalizeContinuationApplication(raw)
  const reasoningCarryForward = normalizeReasoningCarryForwardV92(raw.reasoningCarryForward)
  const reasoningVisibility = normalizeReasoningVisibilityV92(raw.reasoningVisibility)
  const reasoningEnvelope = normalizeReasoningEnvelopeV92(raw.reasoningEnvelope, context)
  const applied = application.kind === 'applied'
  const hasForbiddenAppliedPayload =
    applied && (Object.hasOwn(raw, 'unappliedText') || Object.hasOwn(raw, 'unappliedAnnotations'))
  if (
    application === raw.application &&
    reasoningCarryForward === raw.reasoningCarryForward &&
    reasoningVisibility === raw.reasoningVisibility &&
    reasoningEnvelope === raw.reasoningEnvelope &&
    !hasForbiddenAppliedPayload
  ) {
    return reasoning
  }
  const next: Record<string, unknown> = {
    ...raw,
    application,
    reasoningCarryForward,
    reasoningVisibility,
  }
  if (reasoningEnvelope) next.reasoningEnvelope = reasoningEnvelope
  else delete next.reasoningEnvelope
  if (applied) {
    delete next.unappliedText
    delete next.unappliedAnnotations
  } else {
    if (typeof next.unappliedText !== 'string') delete next.unappliedText
    if (!Array.isArray(next.unappliedAnnotations)) delete next.unappliedAnnotations
  }
  return next as T
}

export function normalizeMessageReasoningContractV92<T extends object>(
  value: T,
  generation: LegacyReasoningGenerationIdentity | undefined,
  context: ReasoningAttemptV92Context = {},
): T {
  const reasoning = normalizeReasoningAttemptFieldsV92(value, generation, context)
  const raw = reasoning as T & Record<string, unknown>
  const continuationAttempts = normalizeContinuationAttemptsV92(raw.continuationAttempts, context)
  if (continuationAttempts === raw.continuationAttempts) return reasoning
  const next: Record<string, unknown> = { ...raw }
  if (continuationAttempts) next.continuationAttempts = continuationAttempts
  else delete next.continuationAttempts
  return next as T
}

export function normalizeReasoningAttemptFieldsV92<T extends object>(
  value: T,
  generation: LegacyReasoningGenerationIdentity | undefined,
  context: ReasoningAttemptV92Context = {},
): T {
  const raw = value as T & LegacyReasoningEnvelopeFields & Record<string, unknown>
  const originalEnvelope = raw.reasoningEnvelope
  const next = { ...raw }
  delete next.reasoningEnvelope
  const legacyChanged = normalizeReasoningEnvelopeFields(next, generation)
  const reasoningEnvelope = mergeNormalizedReasoningEnvelopesV92(
    originalEnvelope,
    next.reasoningEnvelope,
    context,
  )
  if (reasoningEnvelope) next.reasoningEnvelope = reasoningEnvelope
  else delete next.reasoningEnvelope
  return !legacyChanged && reasoningEnvelope === originalEnvelope ? value : next
}

export function normalizeContinuationAttemptsV92(
  value: unknown,
  context: ReasoningAttemptV92Context = {},
): readonly object[] | undefined {
  if (!Array.isArray(value)) return undefined
  const candidates = value as readonly unknown[]
  let changed = false
  const seen = new Set<string>()
  const reversed: object[] = []
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate: unknown = candidates[index]
    const row = record(candidate)
    if (!row || typeof row.streamId !== 'string' || row.streamId.length === 0) {
      changed = true
      continue
    }
    if (seen.has(row.streamId)) {
      changed = true
      continue
    }
    seen.add(row.streamId)
    const normalized = normalizeContinuationAttemptContractV92(row, {
      ...context,
      ...(typeof row.apiUsed === 'string' ? { apiUsed: row.apiUsed } : {}),
    })
    changed ||= normalized !== candidate
    reversed.push(normalized)
  }
  reversed.reverse()
  return changed ? reversed : (value as object[])
}

export function upgradeReasoningEnvelopeV1ToV2Frozen(
  value: unknown,
  context: ReasoningAttemptV92Context = {},
): ReasoningEnvelopeV92 | undefined {
  const envelope = salvageReasoningEnvelopeV1(value)
  if (!envelope) return undefined
  return {
    schemaVersion: 2,
    visible: envelope.visible.map((part) => upcastVisiblePart(part, context)),
    carriers: envelope.carriers.map((carrier) => upcastCarrier(carrier, context)),
  }
}

export function normalizeReasoningEnvelopeV92(
  value: unknown,
  context: ReasoningAttemptV92Context = {},
): ReasoningEnvelopeV92 | undefined {
  if (isReasoningEnvelopeV92(value)) {
    return normalizeBoundBridgeContradictions(reconcileUnknownBridges(value, context))
  }
  const raw = record(value)
  if (!raw) return undefined
  if (raw.schemaVersion !== 2) {
    const upgraded = upgradeReasoningEnvelopeV1ToV2Frozen(value, context)
    return upgraded ? normalizeBoundBridgeContradictions(upgraded) : undefined
  }
  if (!Array.isArray(raw.visible) || !Array.isArray(raw.carriers)) return undefined

  const visible: ReasoningVisiblePartV92[] = []
  const visibleIds = new Set<string>()
  for (const candidate of raw.visible) {
    const part = normalizeVisiblePart(candidate, context)
    if (!part || visibleIds.has(part.id)) continue
    visibleIds.add(part.id)
    visible.push(part)
  }
  const visibleById = new Map(visible.map((part) => [part.id, part]))
  const carriers: OpaqueReasoningCarrierV92[] = []
  const carrierIds = new Set<string>()
  for (const candidate of raw.carriers) {
    const carrier = normalizeCarrier(candidate, context)
    if (!carrier || carrierIds.has(carrier.id)) continue
    const boundId = boundVisiblePartId(carrier)
    const boundVisible = boundId ? visibleById.get(boundId) : undefined
    if (boundId && (!boundVisible || !reasoningCarrierBindingIsValid(carrier, boundVisible))) {
      continue
    }
    carrierIds.add(carrier.id)
    carriers.push(carrier)
  }
  return normalizeBoundBridgeContradictions(
    reconcileUnknownBridges({ schemaVersion: 2, visible, carriers }, context),
  )
}

export function mergeNormalizedReasoningEnvelopesV92(
  primary: unknown,
  fallback: unknown,
  context: ReasoningAttemptV92Context = {},
): ReasoningEnvelopeV92 | undefined {
  const first = normalizeReasoningEnvelopeV92(primary, context)
  const second = normalizeReasoningEnvelopeV92(fallback, context)
  if (!first) return second
  if (!second) return first
  if (second.visible.length === 0 && second.carriers.length === 0) return first
  return normalizeReasoningEnvelopeV92(
    {
      schemaVersion: 2,
      visible: [...first.visible, ...second.visible],
      carriers: [...first.carriers, ...second.carriers],
    },
    context,
  )
}

export function isReasoningEnvelopeV92(value: unknown): value is ReasoningEnvelopeV92 {
  const raw = record(value)
  if (
    !raw ||
    !hasOnlyKeys(raw, ['schemaVersion', 'visible', 'carriers']) ||
    raw.schemaVersion !== 2 ||
    !Array.isArray(raw.visible) ||
    !Array.isArray(raw.carriers) ||
    !raw.visible.every(isVisiblePart) ||
    !raw.carriers.every(isCarrier) ||
    !hasUniqueIds(raw.visible) ||
    !hasUniqueIds(raw.carriers)
  ) {
    return false
  }
  const envelope = raw as unknown as ReasoningEnvelopeV92
  const visibleById = new Map(envelope.visible.map((part) => [part.id, part]))
  for (const carrier of envelope.carriers) {
    const boundId = boundVisiblePartId(carrier)
    if (!boundId) continue
    const visible = visibleById.get(boundId)
    if (!visible || !reasoningCarrierBindingIsValid(carrier, visible)) return false
  }
  return true
}

function normalizeContinuationApplication(value: Record<string, unknown>):
  | Readonly<{ kind: 'applied' }>
  | Readonly<{
      kind: 'unapplied'
      reason: 'base-version-changed'
    }> {
  const application = record(value.application)
  if (application?.kind === 'applied' && Object.keys(application).length === 1) {
    return value.application as Readonly<{ kind: 'applied' }>
  }
  if (
    application?.kind === 'unapplied' &&
    application.reason === 'base-version-changed' &&
    Object.keys(application).length === 2
  ) {
    return value.application as Readonly<{
      kind: 'unapplied'
      reason: 'base-version-changed'
    }>
  }
  const hasUnappliedPayload =
    (typeof value.unappliedText === 'string' && value.unappliedText.length > 0) ||
    (Array.isArray(value.unappliedAnnotations) && value.unappliedAnnotations.length > 0)
  return hasUnappliedPayload
    ? Object.freeze({ kind: 'unapplied', reason: 'base-version-changed' })
    : Object.freeze({ kind: 'applied' })
}

function normalizeVisiblePart(
  value: unknown,
  context: ReasoningAttemptV92Context,
): ReasoningVisiblePartV92 | undefined {
  const row = record(value)
  if (
    !row ||
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.groupId !== 'string' ||
    row.groupId.length === 0 ||
    (row.kind !== 'text' && row.kind !== 'summary') ||
    typeof row.text !== 'string'
  ) {
    return undefined
  }
  const format = reasoningFormat(row.format)
  return {
    id: row.id,
    groupId: row.groupId,
    kind: row.kind,
    text: row.text,
    format,
    source: normalizeSource(row.source, format, context),
    ...(typeof row.hidden === 'boolean' ? { hidden: row.hidden } : {}),
  }
}

function normalizeCarrier(
  value: unknown,
  context: ReasoningAttemptV92Context,
): OpaqueReasoningCarrierV92 | undefined {
  const row = record(value)
  if (
    !row ||
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.groupId !== 'string' ||
    row.groupId.length === 0
  ) {
    return undefined
  }
  const format = reasoningFormat(row.format)
  const base = {
    id: row.id,
    groupId: row.groupId,
    format,
    source: normalizeSource(row.source, format, context),
    ...(typeof row.hidden === 'boolean' ? { hidden: row.hidden } : {}),
  }
  if (
    row.kind === 'responses-encrypted' &&
    typeof row.data === 'string' &&
    row.data.length > 0 &&
    (format === 'openai-responses-v1' ||
      format === 'azure-openai-responses-v1' ||
      format === 'xai-responses-v1')
  ) {
    return { ...base, kind: row.kind, data: row.data }
  }
  if (
    row.kind === 'anthropic-signature' &&
    format === 'anthropic-claude-v1' &&
    typeof row.signature === 'string' &&
    row.signature.length > 0 &&
    typeof row.bindsVisiblePartId === 'string' &&
    row.bindsVisiblePartId.length > 0
  ) {
    return {
      ...base,
      kind: row.kind,
      signature: row.signature,
      bindsVisiblePartId: row.bindsVisiblePartId,
    }
  }
  if (
    row.kind === 'anthropic-redacted' &&
    format === 'anthropic-claude-v1' &&
    typeof row.data === 'string' &&
    row.data.length > 0
  ) {
    return { ...base, kind: row.kind, data: row.data }
  }
  if (
    row.kind === 'gemini-thought-signature' &&
    format === 'google-gemini-v1' &&
    typeof row.data === 'string' &&
    row.data.length > 0 &&
    (row.bindsVisiblePartId === undefined ||
      (typeof row.bindsVisiblePartId === 'string' && row.bindsVisiblePartId.length > 0))
  ) {
    return {
      ...base,
      kind: row.kind,
      data: row.data,
      ...(typeof row.bindsVisiblePartId === 'string'
        ? { bindsVisiblePartId: row.bindsVisiblePartId }
        : {}),
    }
  }
  if (row.kind === 'unknown' && typeof row.data === 'string' && row.data.length > 0) {
    return { ...base, kind: row.kind, data: row.data }
  }
  const inertPayload =
    typeof row.data === 'string' && row.data.length > 0
      ? row.data
      : typeof row.signature === 'string' && row.signature.length > 0
        ? row.signature
        : undefined
  if (inertPayload !== undefined) {
    const source = normalizeSource(row.source, 'unknown', context)
    return {
      id: row.id,
      groupId: row.groupId,
      kind: 'unknown',
      data: inertPayload,
      format: 'unknown',
      source: { ...source, dialect: 'unknown', bridge: 'unknown' },
      ...(typeof row.hidden === 'boolean' ? { hidden: row.hidden } : {}),
    }
  }
  return undefined
}

function normalizeSource(
  value: unknown,
  format: ReasoningFormatV92,
  context: ReasoningAttemptV92Context,
): ReasoningSourceRefV92 {
  const row = record(value)
  const dialect =
    typeof row?.dialect === 'string' &&
    REASONING_DIALECTS.has(row.dialect as ReasoningOriginDialectV92)
      ? (row.dialect as ReasoningOriginDialectV92)
      : 'unknown'
  const bridge =
    typeof row?.bridge === 'string' &&
    REASONING_BRIDGES.has(row.bridge as ReasoningProducerBridgeV92)
      ? (row.bridge as ReasoningProducerBridgeV92)
      : inferBridge(dialect, format, context)
  const source: Record<string, unknown> = { dialect, bridge }
  for (const key of SOURCE_STRING_KEYS) {
    const item = row?.[key]
    if (typeof item === 'string' && item.length > 0) source[key] = item
  }
  for (const key of SOURCE_INDEX_KEYS) {
    const item = row?.[key]
    if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) source[key] = item
  }
  return source as unknown as ReasoningSourceRefV92
}

function normalizeBoundBridgeContradictions(envelope: ReasoningEnvelopeV92): ReasoningEnvelopeV92 {
  const visibleById = new Map(envelope.visible.map((part, index) => [part.id, { part, index }]))
  const ambiguousVisible = new Set<number>()
  const ambiguousCarriers = new Set<number>()
  for (const [carrierIndex, carrier] of envelope.carriers.entries()) {
    const boundId = boundVisiblePartId(carrier)
    if (!boundId) continue
    const visible = visibleById.get(boundId)
    if (!visible) continue
    const bridges = new Set(
      [visible.part.source.bridge, carrier.source.bridge].filter((bridge) => bridge !== 'unknown'),
    )
    if (bridges.size < 2) continue
    ambiguousVisible.add(visible.index)
    ambiguousCarriers.add(carrierIndex)
  }
  if (ambiguousVisible.size === 0 && ambiguousCarriers.size === 0) return envelope
  return {
    schemaVersion: 2,
    visible: envelope.visible.map((part, index) =>
      ambiguousVisible.has(index)
        ? { ...part, source: { ...part.source, bridge: 'unknown' } }
        : part,
    ),
    carriers: envelope.carriers.map((carrier, index) =>
      ambiguousCarriers.has(index)
        ? {
            ...carrier,
            source: { ...carrier.source, bridge: 'unknown' },
          }
        : carrier,
    ),
  }
}

function reconcileUnknownBridges(
  envelope: ReasoningEnvelopeV92,
  context: ReasoningAttemptV92Context,
): ReasoningEnvelopeV92 {
  const state = { changed: false }
  const visible = envelope.visible.map((part) => {
    if (part.source.bridge !== 'unknown') return part
    const bridge = inferBridge(part.source.dialect, part.format, context)
    if (bridge === 'unknown') return part
    state.changed = true
    return { ...part, source: { ...part.source, bridge } }
  })
  const carriers = envelope.carriers.map((carrier) => {
    if (carrier.kind === 'unknown' || carrier.source.bridge !== 'unknown') return carrier
    const bridge = inferBridge(carrier.source.dialect, carrier.format, context)
    if (bridge === 'unknown') return carrier
    state.changed = true
    return {
      ...carrier,
      source: { ...carrier.source, bridge },
    }
  })
  return state.changed ? { schemaVersion: 2, visible, carriers } : envelope
}

function salvageReasoningEnvelopeV1(value: unknown): ReasoningEnvelopeV1Schema | undefined {
  if (isReasoningEnvelopeV1(value)) return value
  const raw = record(value)
  if (
    !raw ||
    raw.schemaVersion === 2 ||
    !Array.isArray(raw.visible) ||
    !Array.isArray(raw.carriers)
  ) {
    return undefined
  }
  const visible: ReasoningVisiblePartV1[] = []
  const visibleIds = new Set<string>()
  const rawVisible = raw.visible as readonly unknown[]
  for (const candidate of rawVisible) {
    const envelope = { schemaVersion: 1, visible: [candidate], carriers: [] }
    if (!isReasoningEnvelopeV1(envelope)) continue
    const part = envelope.visible[0] as ReasoningVisiblePartV1
    if (visibleIds.has(part.id)) continue
    visibleIds.add(part.id)
    visible.push(part)
  }
  const carriers: OpaqueReasoningCarrierV1[] = []
  const carrierIds = new Set<string>()
  const visibleById = new Map(visible.map((part) => [part.id, part] as const))
  for (const candidate of raw.carriers) {
    const boundId = record(candidate)?.bindsVisiblePartId
    const boundVisible = typeof boundId === 'string' ? visibleById.get(boundId) : undefined
    const envelope = {
      schemaVersion: 1,
      visible: boundVisible ? [boundVisible] : [],
      carriers: [candidate],
    }
    if (!isReasoningEnvelopeV1(envelope)) continue
    const carrier = envelope.carriers[0]
    if (!carrier || carrierIds.has(carrier.id)) continue
    carrierIds.add(carrier.id)
    carriers.push(carrier)
  }
  return { schemaVersion: 1, visible, carriers }
}

function upcastVisiblePart(
  part: ReasoningVisiblePartV1,
  context: ReasoningAttemptV92Context,
): ReasoningVisiblePartV92 {
  return { ...part, source: upcastSource(part.source, part.format, context) }
}

function upcastCarrier(
  carrier: OpaqueReasoningCarrierV1,
  context: ReasoningAttemptV92Context,
): OpaqueReasoningCarrierV92 {
  return {
    ...carrier,
    source: upcastSource(carrier.source, carrier.format, context),
  }
}

function upcastSource(
  source: ReasoningSourceRefV1,
  format: ReasoningFormatV1,
  context: ReasoningAttemptV92Context,
): ReasoningSourceRefV92 {
  return { ...source, bridge: inferBridge(source.dialect, format, context) }
}

function inferBridge(
  dialect: ReasoningOriginDialectV92,
  format: ReasoningFormatV92,
  context: ReasoningAttemptV92Context,
): ReasoningProducerBridgeV92 {
  if (dialect === 'inline') return 'inline'
  if (dialect === 'openrouter-chat' || dialect === 'openrouter-responses') return 'openrouter'
  if (dialect === 'anthropic-messages') return 'anthropic-direct'
  if (dialect === 'gemini-native') return 'google-direct'
  if (format === 'azure-openai-responses-v1') return 'azure-openai'
  if (dialect === 'openai-chat' || dialect === 'openai-responses') {
    if (isOfficialOpenAiProfile(context.profile)) return 'openai-direct'
    return context.profile ? 'custom' : 'unknown'
  }
  if (context.profile?.kind === 'openrouter') return 'openrouter'
  if (context.apiUsed === 'gemini-native') return 'google-direct'
  if (context.apiUsed === 'anthropic-messages') return 'anthropic-direct'
  if (context.apiUsed === 'completion') return 'inline'
  return context.profile ? 'custom' : 'unknown'
}

function isOfficialOpenAiProfile(profile: ReasoningAttemptV92Context['profile']): boolean {
  if (!profile || profile.kind !== 'openai-compatible' || typeof profile.baseUrl !== 'string') {
    return false
  }
  try {
    return new URL(profile.baseUrl).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

function reasoningCarrierBindingIsValid(
  carrier: OpaqueReasoningCarrierV92,
  visible: ReasoningVisiblePartV92,
): boolean {
  return (
    visible.groupId === carrier.groupId &&
    visible.format === carrier.format &&
    (carrier.kind !== 'gemini-thought-signature' || visible.kind === 'summary') &&
    compatibleReasoningSources(visible.source, carrier.source)
  )
}

function compatibleReasoningSources(
  left: ReasoningSourceRefV92,
  right: ReasoningSourceRefV92,
): boolean {
  if (left.dialect !== right.dialect) return false
  for (const key of SOURCE_GROUP_STRING_KEYS) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
      return false
    }
  }
  for (const key of SOURCE_GROUP_INDEX_KEYS) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
      return false
    }
  }
  return true
}

function isVisiblePart(value: unknown): value is ReasoningVisiblePartV92 {
  const row = record(value)
  return Boolean(
    row &&
      hasNoExtraKeys(row, ['id', 'groupId', 'kind', 'text', 'format', 'source', 'hidden']) &&
      typeof row.id === 'string' &&
      row.id.length > 0 &&
      typeof row.groupId === 'string' &&
      row.groupId.length > 0 &&
      (row.kind === 'text' || row.kind === 'summary') &&
      typeof row.text === 'string' &&
      isReasoningFormat(row.format) &&
      isSource(row.source) &&
      (row.hidden === undefined || typeof row.hidden === 'boolean'),
  )
}

function isCarrier(value: unknown): value is OpaqueReasoningCarrierV92 {
  const row = record(value)
  if (!row) return false
  const payloadKey = row.kind === 'anthropic-signature' ? 'signature' : 'data'
  if (
    !hasNoExtraKeys(row, [
      'id',
      'groupId',
      'kind',
      'format',
      'source',
      'hidden',
      'bindsVisiblePartId',
      payloadKey,
    ]) ||
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.groupId !== 'string' ||
    row.groupId.length === 0 ||
    !isReasoningFormat(row.format) ||
    !isSource(row.source) ||
    (row.hidden !== undefined && typeof row.hidden !== 'boolean') ||
    typeof row[payloadKey] !== 'string' ||
    row[payloadKey].length === 0
  ) {
    return false
  }
  if (row.kind === 'anthropic-signature') {
    return (
      row.format === 'anthropic-claude-v1' &&
      typeof row.bindsVisiblePartId === 'string' &&
      row.bindsVisiblePartId.length > 0
    )
  }
  if (row.kind === 'gemini-thought-signature') {
    return (
      row.format === 'google-gemini-v1' &&
      (row.bindsVisiblePartId === undefined ||
        (typeof row.bindsVisiblePartId === 'string' && row.bindsVisiblePartId.length > 0))
    )
  }
  if (row.kind === 'responses-encrypted') {
    return (
      row.format === 'openai-responses-v1' ||
      row.format === 'azure-openai-responses-v1' ||
      row.format === 'xai-responses-v1'
    )
  }
  if (row.kind === 'anthropic-redacted') return row.format === 'anthropic-claude-v1'
  return row.kind === 'unknown'
}

function isSource(value: unknown): value is ReasoningSourceRefV92 {
  const row = record(value)
  if (
    !row ||
    !hasNoExtraKeys(row, ['dialect', 'bridge', ...SOURCE_STRING_KEYS, ...SOURCE_INDEX_KEYS]) ||
    typeof row.dialect !== 'string' ||
    !REASONING_DIALECTS.has(row.dialect as ReasoningOriginDialectV92) ||
    typeof row.bridge !== 'string' ||
    !REASONING_BRIDGES.has(row.bridge as ReasoningProducerBridgeV92)
  ) {
    return false
  }
  for (const key of SOURCE_STRING_KEYS) {
    const item = row[key]
    if (item !== undefined && (typeof item !== 'string' || item.length === 0)) return false
  }
  for (const key of SOURCE_INDEX_KEYS) {
    const item = row[key]
    if (
      item !== undefined &&
      (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)
    ) {
      return false
    }
  }
  return true
}

function boundVisiblePartId(carrier: OpaqueReasoningCarrierV92): string | undefined {
  return carrier.kind === 'anthropic-signature' || carrier.kind === 'gemini-thought-signature'
    ? carrier.bindsVisiblePartId
    : undefined
}

function reasoningFormat(value: unknown): ReasoningFormatV92 {
  return typeof value === 'string' && REASONING_FORMATS.has(value as ReasoningFormatV92)
    ? (value as ReasoningFormatV92)
    : 'unknown'
}

function isReasoningFormat(value: unknown): value is ReasoningFormatV92 {
  return typeof value === 'string' && REASONING_FORMATS.has(value as ReasoningFormatV92)
}

function hasUniqueIds(values: readonly { id: string }[]): boolean {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) return false
    ids.add(value.id)
  }
  return true
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key))
}

function hasNoExtraKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

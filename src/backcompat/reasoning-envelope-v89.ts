import { sameValue } from '../lib/same-value'
import type {
  OpaqueReasoningCarrierV1,
  ReasoningEnvelopeV1Schema,
  ReasoningFormatV1,
  ReasoningOriginDialectV1,
  ReasoningSourceRefV1,
  ReasoningVisiblePartV1,
} from './generation-stream-events-v1'
import {
  inferLegacyReasoningFormat,
  type LegacyReasoningCarrierFields,
  type LegacyReasoningGenerationIdentity,
  normalizeLegacyReasoningCarrierFields,
} from './reasoning-carriers-v80'
import {
  applyReasoningEnvelopeIngress,
  createReasoningEnvelopeState,
  isReasoningEnvelopeV1,
  isReasoningFormatV1,
  projectReasoningEnvelope,
  type ReasoningDetailV1,
  reasoningIngressFromDetails,
} from './reasoning-envelope-v1'

type OpaqueReasoningCarrier = OpaqueReasoningCarrierV1
type ReasoningDetail = ReasoningDetailV1
type ReasoningEnvelopeV1 = ReasoningEnvelopeV1Schema
type ReasoningFormat = ReasoningFormatV1
type ReasoningOriginDialect = ReasoningOriginDialectV1
type ReasoningSourceRef = ReasoningSourceRefV1
type ReasoningVisiblePart = ReasoningVisiblePartV1

const ORIGIN_DIALECTS: ReadonlySet<ReasoningOriginDialect> = new Set([
  'inline',
  'openai-chat',
  'openrouter-chat',
  'openai-responses',
  'openrouter-responses',
  'anthropic-messages',
  'gemini-native',
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

export interface LegacyReasoningEnvelopeFields extends Record<string, unknown> {
  reasoningEnvelope?: unknown
  reasoningDetails?: unknown
  responsesEchoItem?: unknown
  continuationAttempts?: unknown
  providerOutputItems?: unknown
  phase?: unknown
}

export function normalizeReasoningEnvelopeFields(
  input: LegacyReasoningEnvelopeFields,
  generation: LegacyReasoningGenerationIdentity | undefined,
): boolean {
  const current = repairReasoningEnvelope(input.reasoningEnvelope, generation)
  const legacyDetails = tolerantLegacyReasoningDetails(input.reasoningDetails, generation)
  const temporary: LegacyReasoningCarrierFields = {
    ...(legacyDetails.length > 0 ? { reasoningDetails: legacyDetails } : {}),
    ...(isRecord(input.responsesEchoItem) ? { responsesEchoItem: input.responsesEchoItem } : {}),
    ...(Array.isArray(input.providerOutputItems)
      ? { providerOutputItems: input.providerOutputItems as never[] }
      : {}),
    ...(input.phase === 'commentary' || input.phase === 'final_answer'
      ? { phase: input.phase }
      : {}),
  }
  normalizeLegacyReasoningCarrierFields(temporary, generation)
  const converted = envelopeFromLegacyDetails(
    temporary.reasoningDetails as readonly ReasoningDetail[] | undefined,
    inferLegacyOriginDialect(generation, temporary.providerOutputItems),
  )
  const envelope = mergeReasoningEnvelopes(current, converted)

  let changed = !sameValue(input.reasoningEnvelope, envelope)
  if (envelope) input.reasoningEnvelope = envelope
  else if (Object.hasOwn(input, 'reasoningEnvelope')) delete input.reasoningEnvelope
  if (Object.hasOwn(input, 'reasoningDetails')) {
    delete input.reasoningDetails
    changed = true
  }
  if (Object.hasOwn(input, 'responsesEchoItem')) {
    delete input.responsesEchoItem
    changed = true
  }
  if (!sameValue(input.providerOutputItems, temporary.providerOutputItems)) {
    if (temporary.providerOutputItems) input.providerOutputItems = temporary.providerOutputItems
    else delete input.providerOutputItems
    changed = true
  }
  if (input.phase !== temporary.phase) {
    if (temporary.phase) input.phase = temporary.phase
    else delete input.phase
    changed = true
  }
  return changed
}

export function repairReasoningEnvelope(
  value: unknown,
  generation?: LegacyReasoningGenerationIdentity,
): ReasoningEnvelopeV1 | undefined {
  if (value === undefined) return undefined
  if (isReasoningEnvelopeV1(value)) return value
  if (!isRecord(value)) return undefined

  const fallbackDialect = inferLegacyOriginDialect(generation)
  const visible: ReasoningVisiblePart[] = []
  const visibleById = new Map<string, ReasoningVisiblePart>()
  const visibleIdByLegacyId = new Map<string, string | null>()
  const visibleIds = new LinearIdAllocator('visible')
  for (const [index, candidate] of arrayOrEmpty(value.visible).entries()) {
    if (!isRecord(candidate) || typeof candidate.text !== 'string') continue
    const id = visibleIds.claim(nonEmptyString(candidate.id) ?? `legacy-visible:${index}`)
    const groupId = nonEmptyString(candidate.groupId) ?? `legacy-group:${index}`
    const format = reasoningFormat(candidate.format)
    const part: ReasoningVisiblePart = {
      id,
      groupId,
      kind: candidate.kind === 'summary' ? 'summary' : 'text',
      text: candidate.text,
      format,
      source: tolerantSource(candidate.source, fallbackDialect),
      ...(typeof candidate.hidden === 'boolean' ? { hidden: candidate.hidden } : {}),
    }
    visible.push(part)
    visibleById.set(part.id, part)
    const legacyId = nonEmptyString(candidate.id)
    if (legacyId) {
      const existing = visibleIdByLegacyId.get(legacyId)
      visibleIdByLegacyId.set(legacyId, existing === undefined || existing === id ? id : null)
    }
  }

  const carriers: OpaqueReasoningCarrier[] = []
  const carrierIds = new LinearIdAllocator('carrier')
  for (const [index, candidate] of arrayOrEmpty(value.carriers).entries()) {
    if (!isRecord(candidate)) continue
    const repaired = tolerantCarrier(candidate, {
      index,
      fallbackDialect,
      visible,
      visibleById,
      visibleIdByLegacyId,
      visibleIds,
      carrierIds,
    })
    if (repaired) carriers.push(repaired)
  }
  const envelope: ReasoningEnvelopeV1 = {
    schemaVersion: 1,
    visible,
    carriers: validBoundCarriers(visibleById, carriers),
  }
  return isReasoningEnvelopeV1(envelope) && (visible.length > 0 || carriers.length > 0)
    ? envelope
    : undefined
}

function tolerantLegacyReasoningDetails(
  value: unknown,
  generation: LegacyReasoningGenerationIdentity | undefined,
): ReasoningDetail[] {
  if (!Array.isArray(value)) return []
  const details: ReasoningDetail[] = []
  const ids = new LinearIdAllocator('legacy-detail')
  for (const [index, candidate] of value.entries()) {
    if (!isRecord(candidate)) continue
    const signed = typeof candidate.signature === 'string'
    const format = isReasoningFormatV1(candidate.format)
      ? candidate.format
      : inferLegacyReasoningFormat(generation, signed)
    const common = legacyDetailMetadata(candidate, index, ids)
    if (typeof candidate.summary === 'string') {
      details.push({ type: 'reasoning.summary', format, summary: candidate.summary, ...common })
      continue
    }
    if (typeof candidate.signature === 'string') {
      details.push({
        type: 'reasoning.text',
        format: 'anthropic-claude-v1',
        ...(typeof candidate.text === 'string' ? { text: candidate.text } : {}),
        signature: candidate.signature,
        ...common,
      })
      continue
    }
    if (typeof candidate.data === 'string') {
      details.push({ type: 'reasoning.encrypted', format, data: candidate.data, ...common })
      continue
    }
    if (typeof candidate.text === 'string') {
      details.push({ type: 'reasoning.text', format, text: candidate.text, ...common })
    }
  }
  return details
}

export function legacyReasoningDetailsForV89(
  value: unknown,
  generation: LegacyReasoningGenerationIdentity | undefined,
): ReasoningDetail[] {
  return tolerantLegacyReasoningDetails(value, generation)
}

function legacyDetailMetadata(
  candidate: Record<string, unknown>,
  ordinal: number,
  ids: LinearIdAllocator,
): {
  id: string
  index?: number
  hidden?: boolean
  providerItemId?: string
  providerOutputIndex?: number
  providerSummaryIndex?: number
} {
  const index = nonNegativeInteger(candidate.index)
  const providerItemId = nonEmptyString(candidate.providerItemId)
  const providerOutputIndex = nonNegativeInteger(candidate.providerOutputIndex)
  const providerSummaryIndex = nonNegativeInteger(candidate.providerSummaryIndex)
  return {
    id: ids.claim(nonEmptyString(candidate.id) ?? `legacy-detail:${ordinal}`),
    ...(index === undefined ? {} : { index }),
    ...(typeof candidate.hidden === 'boolean' ? { hidden: candidate.hidden } : {}),
    ...(providerItemId ? { providerItemId } : {}),
    ...(providerOutputIndex === undefined ? {} : { providerOutputIndex }),
    ...(providerSummaryIndex === undefined ? {} : { providerSummaryIndex }),
  }
}

function envelopeFromLegacyDetails(
  details: readonly ReasoningDetail[] | undefined,
  dialect: ReasoningOriginDialect,
): ReasoningEnvelopeV1 | undefined {
  if (!details || details.length === 0) return undefined
  const state = createReasoningEnvelopeState()
  for (const operation of reasoningIngressFromDetails({
    details,
    mode: 'snapshot',
    dialect,
  })) {
    applyReasoningEnvelopeIngress(state, operation)
  }
  const envelope = projectReasoningEnvelope(state)
  return envelope.visible.length > 0 || envelope.carriers.length > 0 ? envelope : undefined
}

function mergeReasoningEnvelopes(
  current: ReasoningEnvelopeV1 | undefined,
  legacy: ReasoningEnvelopeV1 | undefined,
): ReasoningEnvelopeV1 | undefined {
  if (!current) return legacy
  if (!legacy) return current
  const visible = [...current.visible]
  const visibleById = new Map(visible.map((part) => [part.id, part]))
  const visibleIds = new LinearIdAllocator('merged-visible', visibleById.keys())
  const visibleIdMap = new Map<string, string>()
  for (const part of legacy.visible) {
    const existing = visibleById.get(part.id)
    if (existing && sameValue(existing, part)) {
      visibleIdMap.set(part.id, existing.id)
      continue
    }
    const id = visibleIds.claim(part.id)
    visibleIdMap.set(part.id, id)
    const next = id === part.id ? part : { ...part, id }
    visible.push(next)
    visibleById.set(id, next)
  }
  const carriers = [...current.carriers]
  const carrierById = new Map(carriers.map((carrier) => [carrier.id, carrier]))
  const carrierIds = new LinearIdAllocator('merged-carrier', carrierById.keys())
  for (const carrier of legacy.carriers) {
    const remapped = remapCarrierBinding(carrier, visibleIdMap)
    const existing = carrierById.get(remapped.id)
    if (existing && sameValue(existing, remapped)) continue
    const id = carrierIds.claim(remapped.id)
    const next = id === remapped.id ? remapped : { ...remapped, id }
    carriers.push(next)
    carrierById.set(id, next)
  }
  const envelope: ReasoningEnvelopeV1 = {
    schemaVersion: 1,
    visible,
    carriers: validBoundCarriers(visibleById, carriers),
  }
  return isReasoningEnvelopeV1(envelope) ? envelope : current
}

function remapCarrierBinding(
  carrier: OpaqueReasoningCarrier,
  visibleIdMap: ReadonlyMap<string, string>,
): OpaqueReasoningCarrier {
  if (carrier.kind !== 'anthropic-signature' && carrier.kind !== 'gemini-thought-signature') {
    return carrier
  }
  const current = carrier.bindsVisiblePartId
  if (!current) return carrier
  const next = visibleIdMap.get(current)
  return !next || next === current ? carrier : { ...carrier, bindsVisiblePartId: next }
}

function validBoundCarriers(
  visibleById: ReadonlyMap<string, ReasoningVisiblePart>,
  carriers: readonly OpaqueReasoningCarrier[],
): OpaqueReasoningCarrier[] {
  return carriers.filter((carrier) => {
    if (carrier.kind !== 'anthropic-signature' && carrier.kind !== 'gemini-thought-signature') {
      return true
    }
    const boundId = carrier.bindsVisiblePartId
    if (boundId === undefined) return carrier.kind === 'gemini-thought-signature'
    const visible = visibleById.get(boundId)
    if (!visible || visible.groupId !== carrier.groupId || visible.format !== carrier.format) {
      return false
    }
    if (carrier.kind === 'anthropic-signature' && visible.kind !== 'text') return false
    if (carrier.kind === 'gemini-thought-signature' && visible.kind !== 'summary') return false
    return compatibleSources(visible.source, carrier.source)
  })
}

function compatibleSources(left: ReasoningSourceRef, right: ReasoningSourceRef): boolean {
  if (left.dialect !== right.dialect) return false
  for (const key of SOURCE_GROUP_STRING_KEYS) {
    if (left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]) {
      return false
    }
  }
  for (const key of SOURCE_GROUP_INDEX_KEYS) {
    if (left[key] !== undefined && right[key] !== undefined && left[key] !== right[key]) {
      return false
    }
  }
  return true
}

function tolerantCarrier(
  candidate: Record<string, unknown>,
  context: {
    index: number
    fallbackDialect: ReasoningOriginDialect
    visible: ReasoningVisiblePart[]
    visibleById: Map<string, ReasoningVisiblePart>
    visibleIdByLegacyId: Map<string, string | null>
    visibleIds: LinearIdAllocator
    carrierIds: LinearIdAllocator
  },
): OpaqueReasoningCarrier | undefined {
  const signature = typeof candidate.signature === 'string' ? candidate.signature : undefined
  const data = typeof candidate.data === 'string' ? candidate.data : undefined
  const value = signature ?? data
  if (value === undefined) return undefined
  const id = context.carrierIds.claim(
    nonEmptyString(candidate.id) ?? `legacy-carrier:${context.index}`,
  )
  const source = tolerantSource(candidate.source, context.fallbackDialect)
  const groupId = nonEmptyString(candidate.groupId) ?? `legacy-group:${context.index}`
  const hidden = typeof candidate.hidden === 'boolean' ? candidate.hidden : undefined
  const common = { id, groupId, source, ...(hidden === undefined ? {} : { hidden }) }

  if (signature !== undefined || candidate.kind === 'anthropic-signature') {
    let boundId =
      nonEmptyString(candidate.bindsVisiblePartId) === undefined
        ? undefined
        : context.visibleIdByLegacyId.get(nonEmptyString(candidate.bindsVisiblePartId) as string)
    let bound = boundId ? context.visibleById.get(boundId) : undefined
    if (!bound || bound.kind !== 'text' || bound.format !== 'anthropic-claude-v1') {
      boundId = context.visibleIds.claim(`legacy-visible-for-signature:${context.index}`)
      bound = {
        id: boundId,
        groupId,
        kind: 'text',
        text: '',
        format: 'anthropic-claude-v1',
        source,
      }
      context.visible.push(bound)
      context.visibleById.set(bound.id, bound)
    }
    return {
      ...common,
      groupId: bound.groupId,
      source: bound.source,
      kind: 'anthropic-signature',
      format: 'anthropic-claude-v1',
      signature: value,
      bindsVisiblePartId: bound.id,
    }
  }

  const format = reasoningFormat(candidate.format)
  if (candidate.kind === 'gemini-thought-signature' && format === 'google-gemini-v1') {
    const legacyBinding = nonEmptyString(candidate.bindsVisiblePartId)
    const boundId = legacyBinding ? context.visibleIdByLegacyId.get(legacyBinding) : undefined
    const candidateBound = boundId ? context.visibleById.get(boundId) : undefined
    const bound =
      candidateBound?.kind === 'summary' && candidateBound.format === 'google-gemini-v1'
        ? candidateBound
        : undefined
    return {
      ...common,
      ...(bound ? { groupId: bound.groupId, source: bound.source } : {}),
      kind: 'gemini-thought-signature',
      format,
      data: value,
      ...(bound ? { bindsVisiblePartId: bound.id } : {}),
    }
  }
  if (
    candidate.kind === 'responses-encrypted' &&
    (format === 'openai-responses-v1' ||
      format === 'azure-openai-responses-v1' ||
      format === 'xai-responses-v1')
  ) {
    return { ...common, kind: 'responses-encrypted', format, data: value }
  }
  if (candidate.kind === 'anthropic-redacted' && format === 'anthropic-claude-v1') {
    return { ...common, kind: 'anthropic-redacted', format, data: value }
  }
  return { ...common, kind: 'unknown', format: 'unknown', data: value }
}

function inferLegacyOriginDialect(
  generation: LegacyReasoningGenerationIdentity | undefined,
  providerOutputItems?: unknown,
): ReasoningOriginDialect {
  if (
    Array.isArray(providerOutputItems) &&
    providerOutputItems.some((item) => isRecord(item) && item.dialect === 'openrouter-responses')
  ) {
    return 'openrouter-responses'
  }
  if (generation?.apiUsed === 'gemini-native') return 'gemini-native'
  if (generation?.apiUsed === 'anthropic-messages') return 'anthropic-messages'
  if (generation?.apiUsed === 'responses') return 'openai-responses'
  if (generation?.apiUsed === 'chat') return 'unknown'
  return 'unknown'
}

function tolerantSource(value: unknown, fallback: ReasoningOriginDialect): ReasoningSourceRef {
  const source = isRecord(value) ? value : {}
  const dialect =
    typeof source.dialect === 'string' &&
    ORIGIN_DIALECTS.has(source.dialect as ReasoningOriginDialect)
      ? (source.dialect as ReasoningOriginDialect)
      : fallback
  const result: { -readonly [Key in keyof ReasoningSourceRef]: ReasoningSourceRef[Key] } = {
    dialect,
  }
  for (const key of SOURCE_STRING_KEYS) {
    const item = nonEmptyString(source[key])
    if (item) result[key] = item
  }
  for (const key of SOURCE_INDEX_KEYS) {
    const item = nonNegativeInteger(source[key])
    if (item !== undefined) result[key] = item
  }
  return result
}

function reasoningFormat(value: unknown): ReasoningFormat {
  return isReasoningFormatV1(value) ? value : 'unknown'
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

class LinearIdAllocator {
  private readonly used: Set<string>
  private readonly namespace: string
  private nextSyntheticId = 0

  constructor(namespace: string, initial: Iterable<string> = []) {
    this.namespace = namespace
    this.used = new Set(initial)
  }

  claim(preferred: string): string {
    if (!this.used.has(preferred)) {
      this.used.add(preferred)
      return preferred
    }
    for (;;) {
      const candidate = `reasoning-v89:${this.namespace}:${this.nextSyntheticId}`
      this.nextSyntheticId += 1
      if (this.used.has(candidate)) continue
      this.used.add(candidate)
      return candidate
    }
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

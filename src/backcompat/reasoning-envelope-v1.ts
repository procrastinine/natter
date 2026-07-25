import type {
  OpaqueReasoningCarrierDescriptorV1,
  OpaqueReasoningCarrierV1,
  ReasoningEnvelopeIngressV1,
  ReasoningEnvelopeMutationV1,
  ReasoningEnvelopeV1Schema,
  ReasoningFormatV1,
  ReasoningOriginDialectV1,
  ReasoningSourceRefV1,
  ReasoningVisiblePartV1,
} from './generation-stream-events-v1'

type OpaqueReasoningCarrier = OpaqueReasoningCarrierV1
type OpaqueReasoningCarrierDescriptor = OpaqueReasoningCarrierDescriptorV1
type ReasoningEnvelopeIngress = ReasoningEnvelopeIngressV1
type ReasoningEnvelopeMutation = ReasoningEnvelopeMutationV1
type ReasoningEnvelopeV1 = ReasoningEnvelopeV1Schema
type ReasoningSourceRef = ReasoningSourceRefV1
type ReasoningVisiblePart = ReasoningVisiblePartV1
type ReasoningOriginDialect = ReasoningOriginDialectV1

interface ReasoningDetailMetadataV1 {
  readonly id?: string
  readonly index?: number
  readonly hidden?: boolean
  readonly providerItemId?: string
  readonly providerOutputIndex?: number
  readonly providerSummaryIndex?: number
}

export type ReasoningDetailV1 = (
  | Readonly<{
      type: 'reasoning.text'
      format: ReasoningFormatV1
      text?: string
      signature?: string
    }>
  | Readonly<{
      type: 'reasoning.summary'
      format: ReasoningFormatV1
      summary: string
    }>
  | Readonly<{
      type: 'reasoning.encrypted'
      format: ReasoningFormatV1
      data: string
    }>
) &
  ReasoningDetailMetadataV1

type ReasoningDetail = ReasoningDetailV1

const REASONING_SEGMENT_CHARS = 4_096

const REASONING_ORIGIN_DIALECTS: ReadonlySet<ReasoningOriginDialect> = new Set([
  'inline',
  'openai-chat',
  'openrouter-chat',
  'openai-responses',
  'openrouter-responses',
  'anthropic-messages',
  'gemini-native',
  'unknown',
])
const REASONING_FORMATS: ReadonlySet<ReasoningFormatV1> = new Set([
  'unknown',
  'openai-responses-v1',
  'azure-openai-responses-v1',
  'xai-responses-v1',
  'anthropic-claude-v1',
  'google-gemini-v1',
])
const REASONING_SOURCE_STRING_KEYS = ['itemId', 'detailId'] as const
const REASONING_SOURCE_GROUP_STRING_KEYS = ['itemId'] as const
const REASONING_SOURCE_INDEX_KEYS = [
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
const REASONING_SOURCE_GROUP_INDEX_KEYS = ['choiceIndex', 'outputIndex', 'candidateIndex'] as const

export function isReasoningFormatV1(value: unknown): value is ReasoningFormatV1 {
  return typeof value === 'string' && REASONING_FORMATS.has(value as ReasoningFormatV1)
}

interface VisiblePartState {
  part: Omit<ReasoningVisiblePart, 'text'>
  sections: string[]
  pendingParts: string[]
  pendingLength: number
  textLength: number
}

interface CarrierState {
  carrier: OpaqueReasoningCarrierDescriptor
  sections: string[]
  pendingParts: string[]
  pendingLength: number
  valueLength: number
}

export interface ReasoningEnvelopeState {
  visible: VisiblePartState[]
  visibleById: Map<string, number>
  carriers: CarrierState[]
  carrierById: Map<string, number>
  visibleTextLength: number
  carrierByteLength: number
}

export function createReasoningEnvelopeState(
  envelope?: ReasoningEnvelopeV1,
): ReasoningEnvelopeState {
  const state: ReasoningEnvelopeState = {
    visible: [],
    visibleById: new Map(),
    carriers: [],
    carrierById: new Map(),
    visibleTextLength: 0,
    carrierByteLength: 0,
  }
  if (envelope) replaceReasoningEnvelope(state, envelope)
  return state
}

export function applyReasoningEnvelopeMutation(
  state: ReasoningEnvelopeState,
  mutation: ReasoningEnvelopeMutation,
): boolean {
  if (mutation.kind === 'replace') return replaceReasoningEnvelope(state, mutation.envelope)
  if (mutation.kind === 'carrier-set') return setCarrier(state, mutation.carrier)
  if (mutation.kind === 'carrier-append') {
    return appendCarrier(state, mutation.carrier, mutation.delta)
  }
  if (mutation.kind === 'visible-set') return setVisiblePart(state, mutation.part)
  return appendVisiblePart(state, mutation.part, mutation.delta)
}

export function applyReasoningEnvelopeIngress(
  state: ReasoningEnvelopeState,
  ingress: ReasoningEnvelopeIngress,
): readonly ReasoningEnvelopeMutation[] {
  if (ingress.kind === 'carrier-update') {
    const rowIndex = state.carrierById.get(ingress.carrier.id)
    const row = rowIndex === undefined ? undefined : state.carriers[rowIndex]
    if (ingress.mode === 'append') {
      const mutation = {
        kind: 'carrier-append',
        carrier: ingress.carrier,
        delta: ingress.value,
      } as const
      return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
    }
    if (ingress.mode === 'cumulative') {
      if (
        row &&
        ingress.value.length >= row.valueLength &&
        carrierValueIsPrefixOf(row, ingress.value)
      ) {
        const mutation = {
          kind: 'carrier-append',
          carrier: ingress.carrier,
          delta: ingress.value.slice(row.valueLength),
        } as const
        return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
      }
      const mutation = {
        kind: 'carrier-set',
        carrier: withCarrierValue(ingress.carrier, ingress.value),
      } as const
      return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
    }
    const mutation = {
      kind: 'carrier-set',
      carrier: withCarrierValue(ingress.carrier, ingress.value),
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (ingress.kind === 'carrier-set') {
    const mutation = { kind: 'carrier-set', carrier: ingress.carrier } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (ingress.kind === 'replace') {
    const mutation = { kind: 'replace', envelope: ingress.envelope } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (ingress.kind === 'visible-ensure') {
    if (state.visibleById.has(ingress.part.id)) return []
    const mutation = {
      kind: 'visible-set',
      part: { ...ingress.part, text: '' },
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (ingress.kind === 'visible-observation') {
    const rowIndex = state.visibleById.get(ingress.part.id)
    const row = rowIndex === undefined ? undefined : state.visible[rowIndex]
    const overlap =
      ingress.relationship === 'anthropic-suffix-mirror' && row
        ? visibleTextSuffixOverlap(row, ingress.value)
        : 0
    const mutation = {
      kind: 'visible-append',
      part: ingress.part,
      delta: ingress.value.slice(overlap),
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  const rowIndex = state.visibleById.get(ingress.part.id)
  const row = rowIndex === undefined ? undefined : state.visible[rowIndex]
  if (ingress.mode === 'append') {
    const mutation = {
      kind: 'visible-append',
      part: ingress.part,
      delta: ingress.value,
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (ingress.mode === 'append-section') {
    const mutation = {
      kind: 'visible-append',
      part: ingress.part,
      delta:
        row && row.textLength > 0 && ingress.value.length > 0
          ? `\n\n${ingress.value}`
          : ingress.value,
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (ingress.mode === 'cumulative' && row) {
    if (ingress.value.length >= row.textLength && visibleTextIsPrefixOf(row, ingress.value)) {
      const suffix = ingress.value.slice(row.textLength)
      const mutation = {
        kind: 'visible-append',
        part: ingress.part,
        delta: suffix,
      } as const
      return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
    }
    const mutation = {
      kind: 'visible-set',
      part: { ...ingress.part, text: ingress.value },
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  const mutation = {
    kind: 'visible-set',
    part: { ...ingress.part, text: ingress.value },
  } as const
  return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
}

export function projectReasoningEnvelope(state: ReasoningEnvelopeState): ReasoningEnvelopeV1 {
  const boundVisibleIds = new Set<string>()
  const carriers: OpaqueReasoningCarrier[] = []
  for (const row of state.carriers) {
    if (row.valueLength === 0) continue
    const carrier = withCarrierValue(structuredClone(row.carrier), materializeCarrierValue(row))
    carriers.push(carrier)
    const boundId = boundVisiblePartId(carrier)
    if (boundId) boundVisibleIds.add(boundId)
  }
  const visible: ReasoningVisiblePart[] = []
  for (const row of state.visible) {
    if (row.textLength === 0 && !boundVisibleIds.has(row.part.id)) continue
    visible.push({
      ...structuredClone(row.part),
      text: materializeVisibleText(row),
    })
  }
  return {
    schemaVersion: 1,
    visible,
    carriers,
  }
}

export function releaseReasoningEnvelopeState(state: ReasoningEnvelopeState): void {
  state.visible = []
  state.visibleById.clear()
  state.carriers = []
  state.carrierById.clear()
  state.visibleTextLength = 0
  state.carrierByteLength = 0
}

export function isReasoningEnvelopeV1(value: unknown): value is ReasoningEnvelopeV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['schemaVersion', 'visible', 'carriers']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.visible) ||
    !Array.isArray(value.carriers) ||
    !value.visible.every(isVisiblePart) ||
    !value.carriers.every(isCarrier)
  ) {
    return false
  }
  if (!hasUniqueIds(value.visible) || !hasUniqueIds(value.carriers)) return false
  const visibleById = new Map(value.visible.map((part) => [part.id, part]))
  for (const carrier of value.carriers) {
    const boundId = boundVisiblePartId(carrier)
    if (!boundId) continue
    const visible = visibleById.get(boundId)
    if (
      !visible ||
      visible.groupId !== carrier.groupId ||
      visible.format !== carrier.format ||
      (carrier.kind === 'anthropic-signature' && visible.kind !== 'text') ||
      (carrier.kind === 'gemini-thought-signature' && visible.kind !== 'summary') ||
      !compatibleReasoningSources(visible.source, carrier.source)
    ) {
      return false
    }
  }
  return true
}

export function reasoningVisibleIngress(input: {
  kind: ReasoningVisiblePart['kind']
  mode: Extract<ReasoningEnvelopeIngress, { kind: 'visible-update' }>['mode']
  value: string
  format: ReasoningVisiblePart['format']
  source: ReasoningSourceRef
  groupKey: string
  memberKey: string
  hidden?: boolean
}): Extract<ReasoningEnvelopeIngress, { kind: 'visible-update' }> {
  const groupId = reasoningGroupId(input.source.dialect, input.groupKey)
  return {
    kind: 'visible-update',
    mode: input.mode,
    part: {
      id: reasoningMemberId('visible', input.source.dialect, input.groupKey, input.memberKey),
      groupId,
      kind: input.kind,
      format: input.format,
      source: structuredClone(input.source),
      ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
    },
    value: input.value,
  }
}

export function reasoningVisibleEnsure(
  part: Omit<ReasoningVisiblePart, 'text'>,
): Extract<ReasoningEnvelopeIngress, { kind: 'visible-ensure' }> {
  return { kind: 'visible-ensure', part }
}

export function reasoningCarrierIngress(input: {
  kind: OpaqueReasoningCarrier['kind']
  value: string
  format: OpaqueReasoningCarrier['format']
  source: ReasoningSourceRef
  groupKey: string
  memberKey: string
  mode?: 'append' | 'set' | 'cumulative'
  hidden?: boolean
  bindsVisiblePartId?: string
}): Extract<ReasoningEnvelopeIngress, { kind: 'carrier-update' }> {
  const common = {
    id: reasoningMemberId('carrier', input.source.dialect, input.groupKey, input.memberKey),
    groupId: reasoningGroupId(input.source.dialect, input.groupKey),
    kind: input.kind,
    format: input.format,
    source: structuredClone(input.source),
    ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
  } as const
  if (input.kind === 'anthropic-signature') {
    if (!input.bindsVisiblePartId) throw new Error('AnthropicSignatureVisibleBindingMissing')
    return {
      kind: 'carrier-update',
      mode: input.mode ?? 'set',
      carrier: {
        ...common,
        kind: input.kind,
        bindsVisiblePartId: input.bindsVisiblePartId,
      },
      value: input.value,
    }
  }
  if (input.kind === 'gemini-thought-signature') {
    return {
      kind: 'carrier-update',
      mode: input.mode ?? 'set',
      carrier: {
        ...common,
        kind: input.kind,
        ...(input.bindsVisiblePartId ? { bindsVisiblePartId: input.bindsVisiblePartId } : {}),
      },
      value: input.value,
    }
  }
  return {
    kind: 'carrier-update',
    mode: input.mode ?? 'set',
    carrier: { ...common, kind: input.kind },
    value: input.value,
  }
}

export function reasoningIngressFromDetails(input: {
  details: readonly ReasoningDetail[]
  mode: 'delta' | 'snapshot' | 'cumulative'
  dialect: ReasoningOriginDialect
  source?: Omit<ReasoningSourceRef, 'dialect'>
}): ReasoningEnvelopeIngress[] {
  const decodedRows = input.details.flatMap((detail, detailOrdinal) => {
    if (detail.id?.startsWith('tool_')) return []
    return [reasoningDetailIngressRow(input, detail, detailOrdinal)]
  })
  const rows =
    input.mode === 'snapshot' ? disambiguateSnapshotMemberCoordinates(decodedRows) : decodedRows
  const geminiMembersByGroup = new Map<
    string,
    { visibleIds: Set<string>; carrierIds: Set<string> }
  >()
  for (const row of rows) {
    if (row.detail.format !== 'google-gemini-v1') continue
    const members = geminiMembersByGroup.get(row.groupKey) ?? {
      visibleIds: new Set<string>(),
      carrierIds: new Set<string>(),
    }
    if (row.detail.type === 'reasoning.summary') {
      members.visibleIds.add(
        reasoningMemberId(
          'visible',
          input.dialect,
          row.groupKey,
          `summary:${row.memberCoordinate}`,
        ),
      )
    } else if (row.detail.type === 'reasoning.encrypted') {
      members.carrierIds.add(
        reasoningMemberId(
          'carrier',
          input.dialect,
          row.groupKey,
          `encrypted:${row.memberCoordinate}`,
        ),
      )
    }
    geminiMembersByGroup.set(row.groupKey, members)
  }

  const operations: ReasoningEnvelopeIngress[] = []
  for (const row of rows) {
    const { detail, source, groupKey, memberCoordinate } = row
    const mode =
      input.mode === 'delta' ? 'append' : input.mode === 'cumulative' ? 'cumulative' : 'set'
    if (detail.type === 'reasoning.summary') {
      operations.push(
        reasoningVisibleIngress({
          kind: 'summary',
          mode,
          value: detail.summary,
          format: detail.format,
          source,
          groupKey,
          memberKey: `summary:${memberCoordinate}`,
          ...(detail.hidden === undefined ? {} : { hidden: detail.hidden }),
        }),
      )
      continue
    }
    if (detail.type === 'reasoning.text') {
      const visible = reasoningVisibleIngress({
        kind: 'text',
        mode,
        value: detail.text ?? '',
        format: detail.format,
        source,
        groupKey,
        memberKey: `text:${memberCoordinate}`,
        ...(detail.hidden === undefined ? {} : { hidden: detail.hidden }),
      })
      if ((detail.text?.length ?? 0) > 0 || !detail.signature) operations.push(visible)
      else operations.push(reasoningVisibleEnsure(visible.part))
      if (detail.signature) {
        operations.push(
          reasoningCarrierIngress({
            kind: 'anthropic-signature',
            value: detail.signature,
            format: detail.format,
            source,
            groupKey,
            memberKey: `signature:${memberCoordinate}`,
            bindsVisiblePartId: visible.part.id,
          }),
        )
      }
      continue
    }
    operations.push(
      reasoningCarrierIngress({
        kind: carrierKindForDetail(detail),
        value: detail.data,
        format: detail.format,
        source,
        groupKey,
        memberKey: `encrypted:${memberCoordinate}`,
        mode,
        ...(detail.hidden === undefined ? {} : { hidden: detail.hidden }),
        ...geminiVisibleBinding(geminiMembersByGroup.get(groupKey)),
      }),
    )
  }
  return operations
}

function geminiVisibleBinding(
  members:
    | { readonly visibleIds: ReadonlySet<string>; readonly carrierIds: ReadonlySet<string> }
    | undefined,
): { readonly bindsVisiblePartId?: string } {
  if (!members || members.visibleIds.size !== 1 || members.carrierIds.size !== 1) return {}
  const bindsVisiblePartId = members.visibleIds.values().next().value
  return bindsVisiblePartId === undefined ? {} : { bindsVisiblePartId }
}

interface ReasoningDetailIngressRow {
  readonly detail: ReasoningDetail
  readonly source: ReasoningSourceRef
  readonly groupKey: string
  readonly memberCoordinate: string | number
  readonly detailOrdinal: number
}

function disambiguateSnapshotMemberCoordinates(
  rows: readonly ReasoningDetailIngressRow[],
): ReasoningDetailIngressRow[] {
  const occurrences = new Map<string, number>()
  return rows.map((row) => {
    const identity = JSON.stringify([row.groupKey, row.detail.type, row.memberCoordinate])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    if (occurrence === 0) return row
    return {
      ...row,
      source: { ...row.source, detailOrdinal: row.detailOrdinal },
      memberCoordinate: `${row.memberCoordinate}:duplicate:${occurrence}`,
    }
  })
}

function reasoningDetailIngressRow(
  input: {
    readonly dialect: ReasoningOriginDialect
    readonly source?: Omit<ReasoningSourceRef, 'dialect'>
  },
  detail: ReasoningDetail,
  detailOrdinal: number,
): ReasoningDetailIngressRow {
  const itemId = input.source?.itemId ?? detail.providerItemId
  const outputIndex = input.source?.outputIndex ?? detail.providerOutputIndex
  const hasStableMemberCoordinate =
    detail.id !== undefined ||
    detail.providerSummaryIndex !== undefined ||
    detail.index !== undefined
  const source: ReasoningSourceRef = {
    dialect: input.dialect,
    ...input.source,
    ...(itemId ? { itemId } : {}),
    ...(detail.id ? { detailId: detail.id } : {}),
    ...(outputIndex !== undefined ? { outputIndex } : {}),
    ...(detail.providerSummaryIndex !== undefined
      ? { summaryIndex: detail.providerSummaryIndex }
      : {}),
    ...(detail.index !== undefined ? { detailIndex: detail.index } : {}),
    ...(hasStableMemberCoordinate ? {} : { detailOrdinal }),
  }
  const groupCoordinate =
    input.source?.itemId !== undefined
      ? `item:${input.source.itemId}`
      : input.source?.outputIndex !== undefined
        ? `output:${input.source.outputIndex}`
        : detail.providerItemId !== undefined
          ? `item:${detail.providerItemId}`
          : detail.providerOutputIndex !== undefined
            ? `output:${detail.providerOutputIndex}`
            : detail.index !== undefined
              ? `index:${detail.index}`
              : detail.id !== undefined
                ? `id:${detail.id}`
                : `ordinal:${detailOrdinal}`
  const memberCoordinate =
    detail.type === 'reasoning.summary' && detail.providerSummaryIndex !== undefined
      ? `summary-index:${detail.providerSummaryIndex}`
      : detail.id !== undefined
        ? `id:${detail.id}`
        : detail.index !== undefined
          ? `index:${detail.index}`
          : `ordinal:${detailOrdinal}`
  return {
    detail,
    source,
    groupKey: `detail:${groupCoordinate}`,
    memberCoordinate,
    detailOrdinal,
  }
}

function appendVisiblePart(
  state: ReasoningEnvelopeState,
  incoming: Omit<ReasoningVisiblePart, 'text'>,
  delta: string,
): boolean {
  const rowIndex = state.visibleById.get(incoming.id)
  if (rowIndex === undefined) {
    if (delta.length === 0) return false
    const row = createVisiblePartState(incoming, delta)
    state.visibleById.set(incoming.id, state.visible.length)
    state.visible.push(row)
    state.visibleTextLength += delta.length
    return true
  }
  const row = state.visible[rowIndex]
  if (!row) throw new Error(`ReasoningVisiblePartMissing:${incoming.id}`)
  const nextPart = mergeVisiblePartMetadata(row.part, incoming)
  const metadataChanged = !sameVisibleMetadata(row.part, nextPart)
  row.part = nextPart
  if (delta.length === 0) return metadataChanged
  appendVisibleText(row, delta)
  state.visibleTextLength += delta.length
  return true
}

function setVisiblePart(state: ReasoningEnvelopeState, incoming: ReasoningVisiblePart): boolean {
  const rowIndex = state.visibleById.get(incoming.id)
  if (rowIndex === undefined) {
    const { text, ...part } = incoming
    state.visibleById.set(incoming.id, state.visible.length)
    state.visible.push(createVisiblePartState(part, text))
    state.visibleTextLength += text.length
    return true
  }
  const row = state.visible[rowIndex]
  if (!row) throw new Error(`ReasoningVisiblePartMissing:${incoming.id}`)
  const nextPart = mergeVisiblePartMetadata(row.part, withoutVisibleText(incoming))
  const textChanged =
    incoming.text.length !== row.textLength || !visibleTextIsPrefixOf(row, incoming.text)
  const metadataChanged = !sameVisibleMetadata(row.part, nextPart)
  if (!textChanged && !metadataChanged) return false
  row.part = nextPart
  if (!textChanged) return true
  state.visibleTextLength += incoming.text.length - row.textLength
  replaceVisibleText(row, incoming.text)
  return true
}

function setCarrier(state: ReasoningEnvelopeState, incoming: OpaqueReasoningCarrier): boolean {
  const descriptor = withoutCarrierValue(incoming)
  const value = reasoningCarrierValue(incoming)
  const rowIndex = state.carrierById.get(incoming.id)
  if (rowIndex === undefined) {
    if (value.length === 0) return false
    state.carrierById.set(incoming.id, state.carriers.length)
    state.carriers.push(createCarrierState(descriptor, value))
    state.carrierByteLength += value.length
    return true
  }
  const row = state.carriers[rowIndex]
  if (!row) throw new Error(`ReasoningCarrierMissing:${incoming.id}`)
  const nextDescriptor = mergeCarrierMetadata(row.carrier, descriptor)
  const valueChanged = value.length !== row.valueLength || !carrierValueIsPrefixOf(row, value)
  const metadataChanged = !sameCarrierDescriptor(row.carrier, nextDescriptor)
  if (!valueChanged && !metadataChanged) return false
  row.carrier = nextDescriptor
  if (!valueChanged) return true
  state.carrierByteLength += value.length - row.valueLength
  replaceCarrierValue(row, value)
  return true
}

function appendCarrier(
  state: ReasoningEnvelopeState,
  incoming: OpaqueReasoningCarrierDescriptor,
  delta: string,
): boolean {
  const rowIndex = state.carrierById.get(incoming.id)
  if (rowIndex === undefined) {
    if (delta.length === 0) return false
    state.carrierById.set(incoming.id, state.carriers.length)
    state.carriers.push(createCarrierState(incoming, delta))
    state.carrierByteLength += delta.length
    return true
  }
  const row = state.carriers[rowIndex]
  if (!row) throw new Error(`ReasoningCarrierMissing:${incoming.id}`)
  const nextDescriptor = mergeCarrierMetadata(row.carrier, incoming)
  const metadataChanged = !sameCarrierDescriptor(row.carrier, nextDescriptor)
  row.carrier = nextDescriptor
  if (delta.length === 0) return metadataChanged
  appendCarrierValue(row, delta)
  state.carrierByteLength += delta.length
  return true
}

function replaceReasoningEnvelope(
  state: ReasoningEnvelopeState,
  envelope: ReasoningEnvelopeV1,
): boolean {
  if (!isReasoningEnvelopeV1(envelope)) throw new Error('ReasoningEnvelopeInvalid')
  const current = projectReasoningEnvelope(state)
  if (sameEnvelope(current, envelope)) return false
  releaseReasoningEnvelopeState(state)
  for (const visible of envelope.visible) {
    if (state.visibleById.has(visible.id)) {
      throw new Error(`ReasoningEnvelopeDuplicateVisibleId:${visible.id}`)
    }
    const { text, ...part } = visible
    state.visibleById.set(visible.id, state.visible.length)
    state.visible.push(createVisiblePartState(part, text))
    state.visibleTextLength += text.length
  }
  for (const carrier of envelope.carriers) {
    if (state.carrierById.has(carrier.id)) {
      throw new Error(`ReasoningEnvelopeDuplicateCarrierId:${carrier.id}`)
    }
    state.carrierById.set(carrier.id, state.carriers.length)
    const value = reasoningCarrierValue(carrier)
    state.carriers.push(createCarrierState(withoutCarrierValue(carrier), value))
    state.carrierByteLength += value.length
  }
  return true
}

function createVisiblePartState(
  part: Omit<ReasoningVisiblePart, 'text'>,
  text: string,
): VisiblePartState {
  const row: VisiblePartState = {
    part: structuredClone(part),
    sections: [],
    pendingParts: [],
    pendingLength: 0,
    textLength: 0,
  }
  appendVisibleText(row, text)
  return row
}

function appendVisibleText(row: VisiblePartState, text: string): void {
  let offset = 0
  while (offset < text.length) {
    const room = REASONING_SEGMENT_CHARS - row.pendingLength
    const nextOffset = Math.min(text.length, offset + room)
    const part = text.slice(offset, nextOffset)
    row.pendingParts.push(part)
    row.pendingLength += part.length
    row.textLength += part.length
    offset = nextOffset
    if (row.pendingLength === REASONING_SEGMENT_CHARS) {
      appendGeometricSection(
        row.sections,
        row.pendingParts.length === 1 ? (row.pendingParts[0] as string) : row.pendingParts.join(''),
      )
      row.pendingParts = []
      row.pendingLength = 0
    }
  }
}

function replaceVisibleText(row: VisiblePartState, text: string): void {
  row.sections = []
  row.pendingParts = []
  row.pendingLength = 0
  row.textLength = 0
  appendVisibleText(row, text)
}

function createCarrierState(
  carrier: OpaqueReasoningCarrierDescriptor,
  value: string,
): CarrierState {
  const row: CarrierState = {
    carrier: structuredClone(carrier),
    sections: [],
    pendingParts: [],
    pendingLength: 0,
    valueLength: 0,
  }
  appendCarrierValue(row, value)
  return row
}

function appendCarrierValue(row: CarrierState, value: string): void {
  let offset = 0
  while (offset < value.length) {
    const room = REASONING_SEGMENT_CHARS - row.pendingLength
    const nextOffset = Math.min(value.length, offset + room)
    const part = value.slice(offset, nextOffset)
    row.pendingParts.push(part)
    row.pendingLength += part.length
    row.valueLength += part.length
    offset = nextOffset
    if (row.pendingLength === REASONING_SEGMENT_CHARS) {
      appendGeometricSection(
        row.sections,
        row.pendingParts.length === 1 ? (row.pendingParts[0] as string) : row.pendingParts.join(''),
      )
      row.pendingParts = []
      row.pendingLength = 0
    }
  }
}

function replaceCarrierValue(row: CarrierState, value: string): void {
  row.sections = []
  row.pendingParts = []
  row.pendingLength = 0
  row.valueLength = 0
  appendCarrierValue(row, value)
}

function appendGeometricSection(sections: string[], section: string): void {
  let next = section
  while (sections.length > 0 && sections.at(-1)?.length === next.length) {
    next = `${sections.pop() as string}${next}`
  }
  sections.push(next)
}

function materializeVisibleText(row: VisiblePartState): string {
  if (row.pendingParts.length === 0) return row.sections.join('')
  return [...row.sections, ...row.pendingParts].join('')
}

function materializeCarrierValue(row: CarrierState): string {
  if (row.pendingParts.length === 0) return row.sections.join('')
  return [...row.sections, ...row.pendingParts].join('')
}

function visibleTextIsPrefixOf(row: VisiblePartState, incoming: string): boolean {
  let offset = 0
  for (const fragment of row.sections) {
    if (!incoming.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  for (const fragment of row.pendingParts) {
    if (!incoming.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  return true
}

function visibleTextSuffixOverlap(row: VisiblePartState, incoming: string): number {
  if (incoming.length === 0 || row.textLength === 0) return 0
  const suffix = materializeVisibleSuffix(row, Math.min(row.textLength, incoming.length))
  const prefix = new Uint32Array(incoming.length)
  for (let index = 1, matched = 0; index < incoming.length; index += 1) {
    while (matched > 0 && incoming[index] !== incoming[matched]) {
      matched = prefix[matched - 1] ?? 0
    }
    if (incoming[index] === incoming[matched]) matched += 1
    prefix[index] = matched
  }
  let matched = 0
  for (let index = 0; index < suffix.length; index += 1) {
    while (matched > 0 && suffix[index] !== incoming[matched]) {
      matched = prefix[matched - 1] ?? 0
    }
    if (suffix[index] === incoming[matched]) matched += 1
  }
  return matched
}

function materializeVisibleSuffix(row: VisiblePartState, length: number): string {
  const fragments: string[] = []
  let remaining = length
  for (let index = row.pendingParts.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const fragment = row.pendingParts[index]
    if (fragment === undefined) continue
    const take = Math.min(fragment.length, remaining)
    fragments.push(fragment.slice(fragment.length - take))
    remaining -= take
  }
  for (let index = row.sections.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const fragment = row.sections[index]
    if (fragment === undefined) continue
    const take = Math.min(fragment.length, remaining)
    fragments.push(fragment.slice(fragment.length - take))
    remaining -= take
  }
  fragments.reverse()
  return fragments.join('')
}

function carrierValueIsPrefixOf(row: CarrierState, incoming: string): boolean {
  let offset = 0
  for (const fragment of row.sections) {
    if (!incoming.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  for (const fragment of row.pendingParts) {
    if (!incoming.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  return true
}

function mergeVisiblePartMetadata(
  current: Omit<ReasoningVisiblePart, 'text'>,
  incoming: Omit<ReasoningVisiblePart, 'text'>,
): Omit<ReasoningVisiblePart, 'text'> {
  if (current.kind !== incoming.kind || current.groupId !== incoming.groupId) {
    throw new Error(`ReasoningVisiblePartIdentityConflict:${incoming.id}`)
  }
  return {
    ...current,
    ...incoming,
    format: mergeReasoningFormat(current.format, incoming.format, incoming.id),
    source: mergeReasoningSource(current.source, incoming.source, incoming.id),
  }
}

function mergeCarrierMetadata(
  current: OpaqueReasoningCarrierDescriptor,
  incoming: OpaqueReasoningCarrierDescriptor,
): OpaqueReasoningCarrierDescriptor {
  if (current.kind !== incoming.kind) {
    throw new Error(`ReasoningCarrierKindConflict:${incoming.id}:${current.kind}:${incoming.kind}`)
  }
  if (current.groupId !== incoming.groupId) {
    throw new Error(`ReasoningCarrierIdentityConflict:${incoming.id}`)
  }
  if (boundVisiblePartId(current) !== boundVisiblePartId(incoming)) {
    throw new Error(`ReasoningCarrierMetadataConflict:${incoming.id}`)
  }
  return {
    ...current,
    ...incoming,
    format: mergeReasoningFormat(current.format, incoming.format, incoming.id),
    source: mergeReasoningSource(current.source, incoming.source, incoming.id),
  }
}

function mergeReasoningFormat(
  current: ReasoningVisiblePart['format'],
  incoming: ReasoningVisiblePart['format'],
  id: string,
): ReasoningVisiblePart['format'] {
  if (current === incoming || incoming === 'unknown') return current
  if (current === 'unknown') return incoming
  throw new Error(`ReasoningFormatConflict:${id}:${current}:${incoming}`)
}

function mergeReasoningSource(
  current: ReasoningSourceRef,
  incoming: ReasoningSourceRef,
  id: string,
): ReasoningSourceRef {
  if (current.dialect !== incoming.dialect) {
    throw new Error(`ReasoningSourceDialectConflict:${id}`)
  }
  for (const key of [...REASONING_SOURCE_STRING_KEYS, ...REASONING_SOURCE_INDEX_KEYS]) {
    const existing = current[key]
    const value = incoming[key]
    if (existing !== undefined && value !== undefined && existing !== value) {
      throw new Error(`ReasoningSourceCoordinateConflict:${id}:${key}`)
    }
  }
  return { ...current, ...incoming }
}

function withoutVisibleText(part: ReasoningVisiblePart): Omit<ReasoningVisiblePart, 'text'> {
  const { text: _text, ...metadata } = part
  return metadata
}

function withoutCarrierValue(carrier: OpaqueReasoningCarrier): OpaqueReasoningCarrierDescriptor {
  if (carrier.kind === 'anthropic-signature') {
    const { signature: _signature, ...descriptor } = carrier
    return descriptor
  }
  const { data: _data, ...descriptor } = carrier
  return descriptor
}

function reasoningCarrierValue(carrier: OpaqueReasoningCarrier): string {
  return carrier.kind === 'anthropic-signature' ? carrier.signature : carrier.data
}

function withCarrierValue(
  carrier: OpaqueReasoningCarrierDescriptor,
  value: string,
): OpaqueReasoningCarrier {
  if (carrier.kind === 'anthropic-signature') return { ...carrier, signature: value }
  return { ...carrier, data: value }
}

function sameVisibleMetadata(
  left: Omit<ReasoningVisiblePart, 'text'>,
  right: Omit<ReasoningVisiblePart, 'text'>,
): boolean {
  return (
    left.id === right.id &&
    left.groupId === right.groupId &&
    left.kind === right.kind &&
    left.format === right.format &&
    left.hidden === right.hidden &&
    sameReasoningSource(left.source, right.source)
  )
}

function sameCarrierDescriptor(
  left: OpaqueReasoningCarrierDescriptor,
  right: OpaqueReasoningCarrierDescriptor,
): boolean {
  return (
    left.id === right.id &&
    left.groupId === right.groupId &&
    left.kind === right.kind &&
    left.format === right.format &&
    left.hidden === right.hidden &&
    boundVisiblePartId(left) === boundVisiblePartId(right) &&
    sameReasoningSource(left.source, right.source)
  )
}

function sameEnvelope(left: ReasoningEnvelopeV1, right: ReasoningEnvelopeV1): boolean {
  if (
    left.visible.length !== right.visible.length ||
    left.carriers.length !== right.carriers.length
  ) {
    return false
  }
  for (let index = 0; index < left.visible.length; index += 1) {
    const leftPart = left.visible[index]
    const rightPart = right.visible[index]
    if (
      !leftPart ||
      !rightPart ||
      leftPart.text !== rightPart.text ||
      !sameVisibleMetadata(withoutVisibleText(leftPart), withoutVisibleText(rightPart))
    ) {
      return false
    }
  }
  for (let index = 0; index < left.carriers.length; index += 1) {
    const leftCarrier = left.carriers[index]
    const rightCarrier = right.carriers[index]
    if (
      !leftCarrier ||
      !rightCarrier ||
      reasoningCarrierValue(leftCarrier) !== reasoningCarrierValue(rightCarrier) ||
      !sameCarrierDescriptor(withoutCarrierValue(leftCarrier), withoutCarrierValue(rightCarrier))
    ) {
      return false
    }
  }
  return true
}

function carrierKindForDetail(
  detail: Extract<ReasoningDetail, { type: 'reasoning.encrypted' }>,
): OpaqueReasoningCarrier['kind'] {
  if (detail.format === 'anthropic-claude-v1') return 'anthropic-redacted'
  if (detail.format === 'google-gemini-v1') return 'gemini-thought-signature'
  if (
    detail.format === 'openai-responses-v1' ||
    detail.format === 'azure-openai-responses-v1' ||
    detail.format === 'xai-responses-v1'
  ) {
    return 'responses-encrypted'
  }
  return 'unknown'
}

function reasoningGroupId(dialect: ReasoningOriginDialect, groupKey: string): string {
  return `reasoning-group:${JSON.stringify([dialect, groupKey])}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isSource(value: unknown): value is ReasoningSourceRef {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'dialect',
      ...REASONING_SOURCE_STRING_KEYS,
      ...REASONING_SOURCE_INDEX_KEYS,
    ]) ||
    typeof value.dialect !== 'string' ||
    !REASONING_ORIGIN_DIALECTS.has(value.dialect as ReasoningOriginDialect)
  ) {
    return false
  }
  for (const key of REASONING_SOURCE_STRING_KEYS) {
    const item = value[key]
    if (item !== undefined && (typeof item !== 'string' || item.length === 0)) return false
  }
  for (const key of REASONING_SOURCE_INDEX_KEYS) {
    const item = value[key]
    if (
      item !== undefined &&
      (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)
    ) {
      return false
    }
  }
  return true
}

function isVisiblePartDescriptor(value: unknown): value is Omit<ReasoningVisiblePart, 'text'> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'groupId', 'kind', 'format', 'source', 'hidden']) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.groupId === 'string' &&
    value.groupId.length > 0 &&
    (value.kind === 'text' || value.kind === 'summary') &&
    isReasoningFormatV1(value.format) &&
    isSource(value.source) &&
    (value.hidden === undefined || typeof value.hidden === 'boolean')
  )
}

function isVisiblePart(value: unknown): value is ReasoningVisiblePart {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'groupId', 'kind', 'text', 'format', 'source', 'hidden'])
  ) {
    return false
  }
  const { text, ...descriptor } = value
  return isVisiblePartDescriptor(descriptor) && typeof text === 'string'
}

function isCarrierDescriptor(value: unknown): value is OpaqueReasoningCarrierDescriptor {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'groupId',
      'kind',
      'format',
      'source',
      'hidden',
      'bindsVisiblePartId',
    ]) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.groupId !== 'string' ||
    value.groupId.length === 0 ||
    !isReasoningFormatV1(value.format) ||
    !isSource(value.source) ||
    (value.hidden !== undefined && typeof value.hidden !== 'boolean')
  ) {
    return false
  }
  if (value.kind === 'anthropic-signature') {
    return (
      value.format === 'anthropic-claude-v1' &&
      typeof value.bindsVisiblePartId === 'string' &&
      value.bindsVisiblePartId.length > 0
    )
  }
  if (value.kind === 'gemini-thought-signature') {
    return (
      value.format === 'google-gemini-v1' &&
      (value.bindsVisiblePartId === undefined ||
        (typeof value.bindsVisiblePartId === 'string' && value.bindsVisiblePartId.length > 0))
    )
  }
  if (value.kind === 'responses-encrypted') {
    return (
      value.format === 'openai-responses-v1' ||
      value.format === 'azure-openai-responses-v1' ||
      value.format === 'xai-responses-v1'
    )
  }
  if (value.kind === 'anthropic-redacted') return value.format === 'anthropic-claude-v1'
  return value.kind === 'unknown'
}

function isCarrier(value: unknown): value is OpaqueReasoningCarrier {
  if (!isRecord(value)) return false
  const payloadKey = value.kind === 'anthropic-signature' ? 'signature' : 'data'
  if (
    !hasOnlyKeys(value, [
      'id',
      'groupId',
      'kind',
      'format',
      'source',
      'hidden',
      'bindsVisiblePartId',
      payloadKey,
    ])
  ) {
    return false
  }
  const { data: _data, signature: _signature, ...descriptor } = value
  if (!isCarrierDescriptor(descriptor)) return false
  const payload = value[payloadKey]
  return typeof payload === 'string' && payload.length > 0
}

function hasUniqueIds(values: readonly { id: string }[]): boolean {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) return false
    ids.add(value.id)
  }
  return true
}

function boundVisiblePartId(
  carrier: OpaqueReasoningCarrier | OpaqueReasoningCarrierDescriptor,
): string | undefined {
  return carrier.kind === 'anthropic-signature' || carrier.kind === 'gemini-thought-signature'
    ? carrier.bindsVisiblePartId
    : undefined
}

function sameReasoningSource(left: ReasoningSourceRef, right: ReasoningSourceRef): boolean {
  if (left.dialect !== right.dialect) return false
  for (const key of REASONING_SOURCE_STRING_KEYS) {
    if (left[key] !== right[key]) return false
  }
  for (const key of REASONING_SOURCE_INDEX_KEYS) {
    if (left[key] !== right[key]) return false
  }
  return true
}

function compatibleReasoningSources(left: ReasoningSourceRef, right: ReasoningSourceRef): boolean {
  if (left.dialect !== right.dialect) return false
  for (const key of REASONING_SOURCE_GROUP_STRING_KEYS) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue)
      return false
  }
  for (const key of REASONING_SOURCE_GROUP_INDEX_KEYS) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue)
      return false
  }
  return true
}

function reasoningMemberId(
  namespace: 'visible' | 'carrier',
  dialect: ReasoningOriginDialect,
  groupKey: string,
  memberKey: string,
): string {
  return `reasoning-${namespace}:${JSON.stringify([dialect, groupKey, memberKey])}`
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

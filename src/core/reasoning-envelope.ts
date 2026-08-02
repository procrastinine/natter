import type {
  MessageAttemptOwner,
  OpaqueReasoningCarrierV2,
  OpaqueReasoningCarrierV2Descriptor,
  ReasoningEnvelopeMutationV2,
  ReasoningEnvelopeV2,
  ReasoningFormat,
  ReasoningOriginDialect,
  ReasoningProducerBridge,
  ReasoningSourceRefV2,
  ReasoningVisiblePartV2,
} from './types'

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

const REASONING_FORMATS: ReadonlySet<ReasoningFormat> = new Set([
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

const REASONING_PRODUCER_BRIDGES: ReadonlySet<ReasoningProducerBridge> = new Set([
  'inline',
  'openrouter',
  'openai-direct',
  'azure-openai',
  'anthropic-direct',
  'google-direct',
  'custom',
  'unknown',
])

export interface ReasoningEnvelopeState {
  visible: VisiblePartState[]
  readonly visibleById: Map<string, number>
  carriers: CarrierState[]
  readonly carrierById: Map<string, number>
  readonly groupIds: Set<string>
  visibleTextLength: number
  carrierByteLength: number
}

export interface ReasoningEnvelopeStateInspection {
  visibleParts: number
  carriers: number
  visibleTextLength: number
  carrierByteLength: number
  retainedTextSegments: number
  retainedCarrierSegments: number
}

interface VisiblePartState {
  part: Omit<ReasoningVisiblePartV2, 'text'>
  sections: string[]
  pendingParts: string[]
  pendingLength: number
  textLength: number
}

interface CarrierState {
  carrier: OpaqueReasoningCarrierV2Descriptor
  sections: string[]
  pendingParts: string[]
  pendingLength: number
  valueLength: number
}

export interface ReasoningEnvelopeLiveVisiblePart {
  readonly part: Omit<ReasoningVisiblePartV2, 'text'>
  readonly valueSections: readonly string[]
  readonly pendingValue?: string
  readonly valueLength: number
}

export interface ReasoningEnvelopeLiveProjection {
  readonly visible: readonly ReasoningEnvelopeLiveVisiblePart[]
  readonly carriers: readonly Readonly<{
    carrier: OpaqueReasoningCarrierV2Descriptor
    valueLength: number
  }>[]
}

export interface ReasoningPresentationVisibleEntry {
  readonly owner: MessageAttemptOwner
  readonly part: Omit<ReasoningVisiblePartV2, 'text'>
  readonly text?: string
  readonly valueSections?: readonly string[]
  readonly pendingValue?: string
  readonly valueLength: number
}

export interface ReasoningPresentationCarrierEntry {
  readonly owner: MessageAttemptOwner
  readonly carrier: OpaqueReasoningCarrierV2Descriptor
  readonly valueLength: number
}

export interface ReasoningPresentation {
  readonly text: readonly ReasoningPresentationVisibleEntry[]
  readonly summary: readonly ReasoningPresentationVisibleEntry[]
  readonly opaque: readonly ReasoningPresentationCarrierEntry[]
  readonly authentication: readonly ReasoningPresentationCarrierEntry[]
  readonly kind: 'plaintext' | 'summary' | 'encrypted'
  readonly hasReasoning: boolean
  readonly rowCount: number
  readonly textCharCount: number
  readonly summaryCharCount: number
  readonly visibleCharCount: number
  readonly opaqueCarrierBytes: number
  readonly authenticationCarrierBytes: number
  readonly preservedCarrierBytes: number
}

export type ReasoningPresentationSource =
  | Readonly<{
      kind: 'durable'
      owner: MessageAttemptOwner
      envelope?: ReasoningEnvelopeV2
    }>
  | Readonly<{
      kind: 'live'
      owner: MessageAttemptOwner
      projection: ReasoningEnvelopeLiveProjection
    }>

export function createReasoningEnvelopeState(
  envelope?: ReasoningEnvelopeV2,
): ReasoningEnvelopeState {
  const state: ReasoningEnvelopeState = {
    visible: [],
    visibleById: new Map(),
    carriers: [],
    carrierById: new Map(),
    groupIds: new Set(),
    visibleTextLength: 0,
    carrierByteLength: 0,
  }
  if (envelope) replaceReasoningEnvelope(state, envelope)
  return state
}

export function applyReasoningEnvelopeMutation(
  state: ReasoningEnvelopeState,
  mutation: ReasoningEnvelopeMutationV2,
): boolean {
  if (mutation.kind === 'replace') return replaceReasoningEnvelope(state, mutation.envelope)
  if (mutation.kind === 'carrier-set') return setCarrier(state, mutation.carrier)
  if (mutation.kind === 'carrier-append') {
    return appendCarrier(state, mutation.carrier, mutation.delta)
  }
  if (mutation.kind === 'visible-set') return setVisiblePart(state, mutation.part)
  return appendVisiblePart(state, mutation.part, mutation.delta)
}

export function applyReasoningVisibleUpdate(
  state: ReasoningEnvelopeState,
  input: Readonly<{
    part: Omit<ReasoningVisiblePartV2, 'text'>
    mode: 'append' | 'append-overlap' | 'append-section' | 'set' | 'cumulative'
    value: string
  }>,
): readonly ReasoningEnvelopeMutationV2[] {
  const rowIndex = state.visibleById.get(input.part.id)
  const row = rowIndex === undefined ? undefined : state.visible[rowIndex]
  if (input.mode === 'append' || input.mode === 'append-section') {
    const delta =
      input.mode === 'append-section' && row && row.textLength > 0 && input.value.length > 0
        ? `\n\n${input.value}`
        : input.value
    const mutation = { kind: 'visible-append', part: input.part, delta } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (input.mode === 'append-overlap') {
    const overlap = row ? visibleTextSuffixOverlap(row, input.value) : 0
    const mutation = {
      kind: 'visible-append',
      part: input.part,
      delta: input.value.slice(overlap),
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (
    input.mode === 'cumulative' &&
    row &&
    input.value.length >= row.textLength &&
    visibleTextIsPrefixOf(row, input.value)
  ) {
    const mutation = {
      kind: 'visible-append',
      part: input.part,
      delta: input.value.slice(row.textLength),
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  const mutation = {
    kind: 'visible-set',
    part: { ...input.part, text: input.value },
  } as const
  return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
}

export function ensureReasoningVisiblePart(
  state: ReasoningEnvelopeState,
  part: Omit<ReasoningVisiblePartV2, 'text'>,
): readonly ReasoningEnvelopeMutationV2[] {
  const mutation = state.visibleById.has(part.id)
    ? ({ kind: 'visible-append', part, delta: '' } as const)
    : ({ kind: 'visible-set', part: { ...part, text: '' } } as const)
  return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
}

export function applyReasoningCarrierUpdate(
  state: ReasoningEnvelopeState,
  input: Readonly<{
    carrier: OpaqueReasoningCarrierV2Descriptor
    mode: 'append' | 'set' | 'cumulative'
    value: string
  }>,
): readonly ReasoningEnvelopeMutationV2[] {
  const rowIndex = state.carrierById.get(input.carrier.id)
  const row = rowIndex === undefined ? undefined : state.carriers[rowIndex]
  if (input.value.length === 0 || (row && carrierValueEquals(row, input.value))) {
    if (!row) return []
    const mutation = {
      kind: 'carrier-append',
      carrier: input.carrier,
      delta: '',
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (input.mode === 'append') {
    const mutation = {
      kind: 'carrier-append',
      carrier: input.carrier,
      delta: input.value,
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  if (
    input.mode === 'cumulative' &&
    row &&
    input.value.length >= row.valueLength &&
    carrierValueIsPrefixOf(row, input.value)
  ) {
    const mutation = {
      kind: 'carrier-append',
      carrier: input.carrier,
      delta: input.value.slice(row.valueLength),
    } as const
    return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
  }
  const mutation = {
    kind: 'carrier-set',
    carrier: withCarrierValue(input.carrier, input.value),
  } as const
  return applyReasoningEnvelopeMutation(state, mutation) ? [mutation] : []
}

export function projectReasoningEnvelope(state: ReasoningEnvelopeState): ReasoningEnvelopeV2 {
  const boundVisibleIds = new Set<string>()
  const carriers: OpaqueReasoningCarrierV2[] = []
  for (const row of state.carriers) {
    if (row.valueLength === 0) continue
    const carrier = withCarrierValue(
      cloneCarrierDescriptor(row.carrier),
      materializeCarrierValue(row),
    )
    carriers.push(carrier)
    const boundId = boundVisiblePartId(carrier)
    if (boundId) boundVisibleIds.add(boundId)
  }
  const visible: ReasoningVisiblePartV2[] = []
  for (const row of state.visible) {
    if (row.textLength === 0 && !boundVisibleIds.has(row.part.id)) continue
    visible.push({ ...cloneVisibleDescriptor(row.part), text: materializeVisibleText(row) })
  }
  return {
    schemaVersion: 2,
    visible,
    carriers,
  }
}

export function projectReasoningEnvelopeLive(
  state: ReasoningEnvelopeState,
): ReasoningEnvelopeLiveProjection {
  return {
    visible: state.visible.map((row) => {
      const pendingValue =
        row.pendingParts.length === 0
          ? undefined
          : row.pendingParts.length === 1
            ? row.pendingParts[0]
            : row.pendingParts.join('')
      return {
        part: cloneVisibleDescriptor(row.part),
        valueSections: [...row.sections],
        ...(pendingValue ? { pendingValue } : {}),
        valueLength: row.textLength,
      }
    }),
    carriers: state.carriers.map((row) => ({
      carrier: cloneCarrierDescriptor(row.carrier),
      valueLength: row.valueLength,
    })),
  }
}

export function projectReasoningPresentation(
  source: ReasoningPresentationSource,
): ReasoningPresentation {
  const visibleRows: ReasoningPresentationVisibleEntry[] = []
  const carrierRows: ReasoningPresentationCarrierEntry[] = []
  if (source.kind === 'live') {
    for (const row of source.projection.visible) visibleRows.push({ ...row, owner: source.owner })
    for (const row of source.projection.carriers) {
      if (row.valueLength > 0) carrierRows.push({ ...row, owner: source.owner })
    }
  } else {
    for (const part of source.envelope?.visible ?? []) {
      const { text, ...descriptor } = part
      visibleRows.push({ owner: source.owner, part: descriptor, text, valueLength: text.length })
    }
    for (const carrier of source.envelope?.carriers ?? []) {
      const valueLength = reasoningCarrierPayloadLength(carrier)
      if (valueLength === 0) continue
      carrierRows.push({
        owner: source.owner,
        carrier: withoutCarrierValue(carrier),
        valueLength,
      })
    }
  }

  const visibleIds = new Set(
    visibleRows.filter((row) => row.valueLength > 0).map((row) => row.part.id),
  )
  const text: ReasoningPresentationVisibleEntry[] = []
  const summary: ReasoningPresentationVisibleEntry[] = []
  let textCharCount = 0
  let summaryCharCount = 0
  for (const row of visibleRows) {
    if (row.valueLength === 0) continue
    if (row.part.kind === 'summary') {
      summary.push(row)
      summaryCharCount += row.valueLength
    } else {
      text.push(row)
      textCharCount += row.valueLength
    }
  }

  const opaque: ReasoningPresentationCarrierEntry[] = []
  const authentication: ReasoningPresentationCarrierEntry[] = []
  let opaqueCarrierBytes = 0
  let authenticationCarrierBytes = 0
  for (const row of carrierRows) {
    if (
      row.carrier.kind === 'anthropic-signature' &&
      visibleIds.has(row.carrier.bindsVisiblePartId)
    ) {
      authentication.push(row)
      authenticationCarrierBytes += row.valueLength
    } else {
      opaque.push(row)
      opaqueCarrierBytes += row.valueLength
    }
  }

  const rowCount = text.length + summary.length + opaque.length
  const kind = text.length > 0 ? 'plaintext' : summary.length > 0 ? 'summary' : 'encrypted'
  return {
    text,
    summary,
    opaque,
    authentication,
    kind,
    hasReasoning: rowCount > 0 || authentication.length > 0,
    rowCount,
    textCharCount,
    summaryCharCount,
    visibleCharCount: textCharCount + summaryCharCount,
    opaqueCarrierBytes,
    authenticationCarrierBytes,
    preservedCarrierBytes: opaqueCarrierBytes + authenticationCarrierBytes,
  }
}

export function combineReasoningPresentations(
  presentations: readonly ReasoningPresentation[],
): ReasoningPresentation {
  if (presentations.length === 1 && presentations[0]) return presentations[0]
  const text = presentations.flatMap((presentation) => presentation.text)
  const summary = presentations.flatMap((presentation) => presentation.summary)
  const opaque = presentations.flatMap((presentation) => presentation.opaque)
  const authentication = presentations.flatMap((presentation) => presentation.authentication)
  const textCharCount = presentations.reduce(
    (total, presentation) => total + presentation.textCharCount,
    0,
  )
  const summaryCharCount = presentations.reduce(
    (total, presentation) => total + presentation.summaryCharCount,
    0,
  )
  const opaqueCarrierBytes = presentations.reduce(
    (total, presentation) => total + presentation.opaqueCarrierBytes,
    0,
  )
  const authenticationCarrierBytes = presentations.reduce(
    (total, presentation) => total + presentation.authenticationCarrierBytes,
    0,
  )
  const rowCount = text.length + summary.length + opaque.length
  return {
    text,
    summary,
    opaque,
    authentication,
    kind: text.length > 0 ? 'plaintext' : summary.length > 0 ? 'summary' : 'encrypted',
    hasReasoning: rowCount > 0 || authentication.length > 0,
    rowCount,
    textCharCount,
    summaryCharCount,
    visibleCharCount: textCharCount + summaryCharCount,
    opaqueCarrierBytes,
    authenticationCarrierBytes,
    preservedCarrierBytes: opaqueCarrierBytes + authenticationCarrierBytes,
  }
}

export function reasoningEnvelopeHasPresentation(
  envelope: ReasoningEnvelopeV2 | undefined,
): boolean {
  if (!envelope) return false
  for (const part of envelope.visible) if (part.text.length > 0) return true
  for (const carrier of envelope.carriers) {
    if (reasoningCarrierPayloadLength(carrier) > 0) return true
  }
  return false
}

export function inspectReasoningEnvelopeState(
  state: ReasoningEnvelopeState,
): ReasoningEnvelopeStateInspection {
  let retainedTextSegments = 0
  for (const row of state.visible) {
    retainedTextSegments += row.sections.length + row.pendingParts.length
  }
  let retainedCarrierSegments = 0
  for (const row of state.carriers) {
    retainedCarrierSegments += row.sections.length + row.pendingParts.length
  }
  return {
    visibleParts: state.visible.length,
    carriers: state.carriers.length,
    visibleTextLength: state.visibleTextLength,
    carrierByteLength: state.carrierByteLength,
    retainedTextSegments,
    retainedCarrierSegments,
  }
}

export function releaseReasoningEnvelopeState(state: ReasoningEnvelopeState): void {
  state.visible = []
  state.visibleById.clear()
  state.carriers = []
  state.carrierById.clear()
  state.groupIds.clear()
  state.visibleTextLength = 0
  state.carrierByteLength = 0
}

export function reasoningEnvelopeIsEmpty(envelope: ReasoningEnvelopeV2 | undefined): boolean {
  return !envelope || (envelope.visible.length === 0 && envelope.carriers.length === 0)
}

export function isReasoningEnvelopeMutation(value: unknown): value is ReasoningEnvelopeMutationV2 {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'visible-append') {
    return (
      hasOnlyKeys(value, ['kind', 'part', 'delta']) &&
      isVisiblePartDescriptor(value.part) &&
      typeof value.delta === 'string'
    )
  }
  if (value.kind === 'visible-set') {
    return hasOnlyKeys(value, ['kind', 'part']) && isVisiblePart(value.part)
  }
  if (value.kind === 'carrier-append') {
    return (
      hasOnlyKeys(value, ['kind', 'carrier', 'delta']) &&
      isCarrierDescriptor(value.carrier) &&
      typeof value.delta === 'string'
    )
  }
  if (value.kind === 'carrier-set') {
    return hasOnlyKeys(value, ['kind', 'carrier']) && isCarrier(value.carrier)
  }
  return (
    value.kind === 'replace' &&
    hasOnlyKeys(value, ['kind', 'envelope']) &&
    isReasoningEnvelope(value.envelope)
  )
}

export function isReasoningEnvelope(value: unknown): value is ReasoningEnvelopeV2 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['schemaVersion', 'visible', 'carriers']) ||
    value.schemaVersion !== 2 ||
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
    if (!visible || !reasoningCarrierBindingIsValid(carrier, visible)) {
      return false
    }
  }
  return true
}

export function assertReasoningCarrierBinding(
  carrier: OpaqueReasoningCarrierV2Descriptor,
  visible: Omit<ReasoningVisiblePartV2, 'text'>,
): void {
  if (!reasoningCarrierBindingIsValid(carrier, visible)) {
    throw new Error(`ReasoningCarrierVisibleBindingInvalid:${carrier.id}:${visible.id}`)
  }
}

export function reasoningVisiblePartDescriptor(
  state: ReasoningEnvelopeState,
  id: string,
): Omit<ReasoningVisiblePartV2, 'text'> | undefined {
  const index = state.visibleById.get(id)
  const row = index === undefined ? undefined : state.visible[index]
  return row ? cloneVisibleDescriptor(row.part) : undefined
}

export function reasoningCarrierDescriptor(
  state: ReasoningEnvelopeState,
  id: string,
): OpaqueReasoningCarrierV2Descriptor | undefined {
  const index = state.carrierById.get(id)
  const row = index === undefined ? undefined : state.carriers[index]
  return row ? cloneCarrierDescriptor(row.carrier) : undefined
}

function reasoningCarrierBindingIsValid(
  carrier: OpaqueReasoningCarrierV2Descriptor,
  visible: Omit<ReasoningVisiblePartV2, 'text'>,
): boolean {
  return (
    visible.groupId === carrier.groupId &&
    visible.format === carrier.format &&
    (carrier.kind !== 'gemini-thought-signature' || visible.kind === 'summary') &&
    compatibleReasoningSources(visible.source, carrier.source)
  )
}

export function reasoningCarrierPayloadLength(carrier: OpaqueReasoningCarrierV2): number {
  return reasoningCarrierValue(carrier).length
}

export function reasoningMutationPayloadLength(mutation: ReasoningEnvelopeMutationV2): number {
  if (mutation.kind === 'visible-append') return mutation.delta.length
  if (mutation.kind === 'visible-set') return mutation.part.text.length
  if (mutation.kind === 'carrier-append') return mutation.delta.length
  if (mutation.kind === 'carrier-set') return reasoningCarrierPayloadLength(mutation.carrier)
  let length = 0
  for (const part of mutation.envelope.visible) length += part.text.length
  for (const carrier of mutation.envelope.carriers) length += reasoningCarrierPayloadLength(carrier)
  return length
}

function appendVisiblePart(
  state: ReasoningEnvelopeState,
  incoming: Omit<ReasoningVisiblePartV2, 'text'>,
  delta: string,
): boolean {
  const rowIndex = state.visibleById.get(incoming.id)
  if (rowIndex === undefined) {
    if (delta.length === 0) return false
    const row = createVisiblePartState(incoming)
    appendVisibleText(row, delta)
    state.visibleById.set(incoming.id, state.visible.length)
    state.visible.push(row)
    state.groupIds.add(incoming.groupId)
    state.visibleTextLength += delta.length
    return true
  }
  const row = state.visible[rowIndex]
  if (!row) throw new Error(`ReasoningVisiblePartMissing:${incoming.id}`)
  const nextPart = mergeReasoningVisiblePartDescriptor(row.part, incoming)
  const metadataChanged = !sameVisibleMetadata(row.part, nextPart)
  row.part = nextPart
  if (delta.length === 0) return metadataChanged
  appendVisibleText(row, delta)
  state.visibleTextLength += delta.length
  return true
}

function setVisiblePart(state: ReasoningEnvelopeState, incoming: ReasoningVisiblePartV2): boolean {
  const rowIndex = state.visibleById.get(incoming.id)
  if (rowIndex === undefined) {
    const { text, ...part } = incoming
    const row = createVisiblePartState(part)
    replaceVisibleText(row, text)
    state.visibleById.set(incoming.id, state.visible.length)
    state.visible.push(row)
    state.groupIds.add(incoming.groupId)
    state.visibleTextLength += text.length
    return true
  }
  const row = state.visible[rowIndex]
  if (!row) throw new Error(`ReasoningVisiblePartMissing:${incoming.id}`)
  const nextPart = mergeReasoningVisiblePartDescriptor(row.part, withoutVisibleText(incoming))
  const textChanged = !visibleTextEquals(row, incoming.text)
  const metadataChanged = !sameVisibleMetadata(row.part, nextPart)
  if (!textChanged && !metadataChanged) return false
  row.part = nextPart
  if (!textChanged) return true
  state.visibleTextLength += incoming.text.length - row.textLength
  replaceVisibleText(row, incoming.text)
  return true
}

function appendCarrier(
  state: ReasoningEnvelopeState,
  incoming: OpaqueReasoningCarrierV2Descriptor,
  delta: string,
): boolean {
  const rowIndex = state.carrierById.get(incoming.id)
  if (rowIndex === undefined) {
    if (delta.length === 0) return false
    const row = createCarrierState(incoming)
    appendCarrierValue(row, delta)
    state.carrierById.set(incoming.id, state.carriers.length)
    state.carriers.push(row)
    state.groupIds.add(incoming.groupId)
    state.carrierByteLength += delta.length
    return true
  }
  const row = state.carriers[rowIndex]
  if (!row) throw new Error(`ReasoningCarrierMissing:${incoming.id}`)
  const nextCarrier = mergeReasoningCarrierDescriptor(row.carrier, incoming)
  const metadataChanged = !sameCarrierDescriptor(row.carrier, nextCarrier)
  row.carrier = nextCarrier
  if (delta.length === 0) return metadataChanged
  appendCarrierValue(row, delta)
  state.carrierByteLength += delta.length
  return true
}

function setCarrier(state: ReasoningEnvelopeState, incoming: OpaqueReasoningCarrierV2): boolean {
  const descriptor = withoutCarrierValue(incoming)
  const value = reasoningCarrierValue(incoming)
  const rowIndex = state.carrierById.get(incoming.id)
  if (rowIndex === undefined) {
    if (value.length === 0) return false
    const row = createCarrierState(descriptor)
    replaceCarrierValue(row, value)
    state.carrierById.set(incoming.id, state.carriers.length)
    state.carriers.push(row)
    state.groupIds.add(incoming.groupId)
    state.carrierByteLength += value.length
    return true
  }
  const row = state.carriers[rowIndex]
  if (!row) throw new Error(`ReasoningCarrierMissing:${incoming.id}`)
  const nextCarrier = mergeReasoningCarrierDescriptor(row.carrier, descriptor)
  const valueChanged = !carrierValueEquals(row, value)
  const metadataChanged = !sameCarrierDescriptor(row.carrier, nextCarrier)
  if (!valueChanged && !metadataChanged) return false
  row.carrier = nextCarrier
  if (!valueChanged) return true
  state.carrierByteLength += value.length - row.valueLength
  replaceCarrierValue(row, value)
  return true
}

function replaceReasoningEnvelope(
  state: ReasoningEnvelopeState,
  envelope: ReasoningEnvelopeV2,
): boolean {
  if (!isReasoningEnvelope(envelope)) throw new Error('ReasoningEnvelopeInvalid')
  if (stateMatchesEnvelope(state, envelope)) return false
  releaseReasoningEnvelopeState(state)
  for (const visible of envelope.visible) {
    const { text, ...part } = visible
    const row = createVisiblePartState(part)
    replaceVisibleText(row, text)
    state.visibleById.set(visible.id, state.visible.length)
    state.visible.push(row)
    state.groupIds.add(visible.groupId)
    state.visibleTextLength += text.length
  }
  for (const carrier of envelope.carriers) {
    const descriptor = withoutCarrierValue(carrier)
    const value = reasoningCarrierValue(carrier)
    const row = createCarrierState(descriptor)
    replaceCarrierValue(row, value)
    state.carrierById.set(carrier.id, state.carriers.length)
    state.carriers.push(row)
    state.groupIds.add(carrier.groupId)
    state.carrierByteLength += value.length
  }
  return true
}

function stateMatchesEnvelope(
  state: ReasoningEnvelopeState,
  envelope: ReasoningEnvelopeV2,
): boolean {
  if (
    state.visible.length !== envelope.visible.length ||
    state.carriers.length !== envelope.carriers.length
  ) {
    return false
  }
  for (let index = 0; index < state.visible.length; index += 1) {
    const row = state.visible[index]
    const part = envelope.visible[index]
    if (
      !row ||
      !part ||
      !sameVisibleMetadata(row.part, withoutVisibleText(part)) ||
      !visibleTextEquals(row, part.text)
    ) {
      return false
    }
  }
  for (let index = 0; index < state.carriers.length; index += 1) {
    const row = state.carriers[index]
    const carrier = envelope.carriers[index]
    if (
      !row ||
      !carrier ||
      !sameCarrierDescriptor(row.carrier, withoutCarrierValue(carrier)) ||
      !carrierValueEquals(row, reasoningCarrierValue(carrier))
    ) {
      return false
    }
  }
  return true
}

function createVisiblePartState(part: Omit<ReasoningVisiblePartV2, 'text'>): VisiblePartState {
  return {
    part: cloneVisibleDescriptor(part),
    sections: [],
    pendingParts: [],
    pendingLength: 0,
    textLength: 0,
  }
}

function createCarrierState(carrier: OpaqueReasoningCarrierV2Descriptor): CarrierState {
  return {
    carrier: cloneCarrierDescriptor(carrier),
    sections: [],
    pendingParts: [],
    pendingLength: 0,
    valueLength: 0,
  }
}

function appendVisibleText(row: VisiblePartState, text: string): void {
  row.pendingLength = appendSegmentedValue(row.sections, row.pendingParts, row.pendingLength, text)
  row.textLength += text.length
}

function appendCarrierValue(row: CarrierState, value: string): void {
  row.pendingLength = appendSegmentedValue(row.sections, row.pendingParts, row.pendingLength, value)
  row.valueLength += value.length
}

function appendSegmentedValue(
  sections: string[],
  pendingParts: string[],
  pendingLength: number,
  value: string,
): number {
  let offset = 0
  let nextPendingLength = pendingLength
  while (offset < value.length) {
    const room = REASONING_SEGMENT_CHARS - nextPendingLength
    const nextOffset = Math.min(value.length, offset + room)
    const part = value.slice(offset, nextOffset)
    pendingParts.push(part)
    nextPendingLength += part.length
    offset = nextOffset
    if (nextPendingLength === REASONING_SEGMENT_CHARS) {
      appendGeometricSection(
        sections,
        pendingParts.length === 1 ? (pendingParts[0] as string) : pendingParts.join(''),
      )
      pendingParts.length = 0
      nextPendingLength = 0
    }
  }
  return nextPendingLength
}

function replaceVisibleText(row: VisiblePartState, text: string): void {
  row.sections = text.length === 0 ? [] : [text]
  row.pendingParts = []
  row.pendingLength = 0
  row.textLength = text.length
}

function replaceCarrierValue(row: CarrierState, value: string): void {
  row.sections = value.length === 0 ? [] : [value]
  row.pendingParts = []
  row.pendingLength = 0
  row.valueLength = value.length
}

function appendGeometricSection(sections: string[], section: string): void {
  let next = section
  while (sections.length > 0 && sections.at(-1)?.length === next.length) {
    next = `${sections.pop() as string}${next}`
  }
  sections.push(next)
}

function materializeVisibleText(row: VisiblePartState): string {
  return materializeValue(row.sections, row.pendingParts)
}

function materializeCarrierValue(row: CarrierState): string {
  return materializeValue(row.sections, row.pendingParts)
}

function materializeValue(sections: readonly string[], pendingParts: readonly string[]): string {
  if (pendingParts.length === 0) {
    if (sections.length === 0) return ''
    if (sections.length === 1) return sections[0] as string
    return sections.join('')
  }
  if (sections.length === 0) {
    return pendingParts.length === 1 ? (pendingParts[0] as string) : pendingParts.join('')
  }
  return [...sections, ...pendingParts].join('')
}

function visibleTextEquals(row: VisiblePartState, value: string): boolean {
  return row.textLength === value.length && visibleTextIsPrefixOf(row, value)
}

function carrierValueEquals(row: CarrierState, value: string): boolean {
  return row.valueLength === value.length && carrierValueIsPrefixOf(row, value)
}

function visibleTextIsPrefixOf(row: VisiblePartState, value: string): boolean {
  return segmentedValueIsPrefixOf(row.sections, row.pendingParts, value)
}

function carrierValueIsPrefixOf(row: CarrierState, value: string): boolean {
  return segmentedValueIsPrefixOf(row.sections, row.pendingParts, value)
}

function segmentedValueIsPrefixOf(
  sections: readonly string[],
  pendingParts: readonly string[],
  value: string,
): boolean {
  let offset = 0
  for (const fragment of sections) {
    if (!value.startsWith(fragment, offset)) return false
    offset += fragment.length
  }
  for (const fragment of pendingParts) {
    if (!value.startsWith(fragment, offset)) return false
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

export function mergeReasoningVisiblePartDescriptor(
  current: Omit<ReasoningVisiblePartV2, 'text'>,
  incoming: Omit<ReasoningVisiblePartV2, 'text'>,
): Omit<ReasoningVisiblePartV2, 'text'> {
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

export function mergeReasoningCarrierDescriptor(
  current: OpaqueReasoningCarrierV2Descriptor,
  incoming: OpaqueReasoningCarrierV2Descriptor,
): OpaqueReasoningCarrierV2Descriptor {
  if (current.kind !== incoming.kind) {
    throw new Error(`ReasoningCarrierKindConflict:${incoming.id}:${current.kind}:${incoming.kind}`)
  }
  if (current.groupId !== incoming.groupId) {
    throw new Error(`ReasoningCarrierMetadataConflict:${incoming.id}`)
  }
  const bindsVisiblePartId = mergeReasoningCarrierBinding(current, incoming)
  return {
    ...current,
    ...incoming,
    ...(bindsVisiblePartId === undefined ? {} : { bindsVisiblePartId }),
    format: mergeReasoningFormat(current.format, incoming.format, incoming.id),
    source: mergeReasoningSource(current.source, incoming.source, incoming.id),
  }
}

function mergeReasoningCarrierBinding(
  current: OpaqueReasoningCarrierV2Descriptor,
  incoming: OpaqueReasoningCarrierV2Descriptor,
): string | undefined {
  const currentBinding = boundVisiblePartId(current)
  const incomingBinding = boundVisiblePartId(incoming)
  if (currentBinding === undefined) return incomingBinding
  if (incomingBinding === undefined || incomingBinding === currentBinding) return currentBinding
  throw new Error(`ReasoningCarrierBindingConflict:${incoming.id}`)
}

function mergeReasoningFormat(
  current: ReasoningFormat,
  incoming: ReasoningFormat,
  id: string,
): ReasoningFormat {
  if (current === incoming || incoming === 'unknown') return current
  if (current === 'unknown') return incoming
  throw new Error(`ReasoningFormatConflict:${id}:${current}:${incoming}`)
}

function mergeReasoningSource(
  current: ReasoningSourceRefV2,
  incoming: ReasoningSourceRefV2,
  id: string,
): ReasoningSourceRefV2 {
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
  return {
    ...current,
    ...incoming,
    bridge: mergeReasoningBridge(current.bridge, incoming.bridge),
  }
}

function mergeReasoningBridge(
  current: ReasoningProducerBridge,
  incoming: ReasoningProducerBridge,
): ReasoningProducerBridge {
  if (current === incoming || incoming === 'unknown') return current
  if (current === 'unknown') return incoming
  return 'unknown'
}

function cloneVisibleDescriptor(
  part: Omit<ReasoningVisiblePartV2, 'text'>,
): Omit<ReasoningVisiblePartV2, 'text'> {
  return { ...part, source: { ...part.source } }
}

function cloneCarrierDescriptor(
  carrier: OpaqueReasoningCarrierV2Descriptor,
): OpaqueReasoningCarrierV2Descriptor {
  return { ...carrier, source: { ...carrier.source } }
}

function withoutVisibleText(part: ReasoningVisiblePartV2): Omit<ReasoningVisiblePartV2, 'text'> {
  const { text: _text, ...descriptor } = part
  return descriptor
}

function reasoningCarrierValue(carrier: OpaqueReasoningCarrierV2): string {
  return carrier.kind === 'anthropic-signature' ? carrier.signature : carrier.data
}

function withCarrierValue(
  carrier: OpaqueReasoningCarrierV2Descriptor,
  value: string,
): OpaqueReasoningCarrierV2 {
  if (carrier.kind === 'anthropic-signature') return { ...carrier, signature: value }
  return { ...carrier, data: value }
}

function sameVisibleMetadata(
  left: Omit<ReasoningVisiblePartV2, 'text'>,
  right: Omit<ReasoningVisiblePartV2, 'text'>,
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

export function reasoningVisiblePartEquals(
  left: ReasoningVisiblePartV2,
  right: ReasoningVisiblePartV2,
): boolean {
  return left.text === right.text && sameVisibleMetadata(left, right)
}

function sameCarrierDescriptor(
  left: OpaqueReasoningCarrierV2Descriptor,
  right: OpaqueReasoningCarrierV2Descriptor,
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

export function reasoningCarrierDescriptorEquals(
  left: OpaqueReasoningCarrierV2Descriptor,
  right: OpaqueReasoningCarrierV2Descriptor,
): boolean {
  return sameCarrierDescriptor(left, right)
}

function sameReasoningSource(left: ReasoningSourceRefV2, right: ReasoningSourceRefV2): boolean {
  if (left.dialect !== right.dialect || left.bridge !== right.bridge) return false
  for (const key of REASONING_SOURCE_STRING_KEYS) {
    if (left[key] !== right[key]) return false
  }
  for (const key of REASONING_SOURCE_INDEX_KEYS) {
    if (left[key] !== right[key]) return false
  }
  return true
}

function withoutCarrierValue(
  carrier: OpaqueReasoningCarrierV2,
): OpaqueReasoningCarrierV2Descriptor {
  if (carrier.kind === 'anthropic-signature') {
    const { signature: _signature, ...descriptor } = carrier
    return descriptor
  }
  const { data: _data, ...descriptor } = carrier
  return descriptor
}

export function reasoningCarrierDescriptorFromCarrier(
  carrier: OpaqueReasoningCarrierV2,
): OpaqueReasoningCarrierV2Descriptor {
  return cloneCarrierDescriptor(withoutCarrierValue(carrier))
}

function isReasoningProducerBridge(value: unknown): value is ReasoningProducerBridge {
  return (
    typeof value === 'string' && REASONING_PRODUCER_BRIDGES.has(value as ReasoningProducerBridge)
  )
}

function isReasoningFormat(value: unknown): value is ReasoningFormat {
  return typeof value === 'string' && REASONING_FORMATS.has(value as ReasoningFormat)
}

function isSource(value: unknown): value is ReasoningSourceRefV2 {
  if (
    !isRecord(value) ||
    !hasNoExtraKeys(value, [
      'dialect',
      'bridge',
      ...REASONING_SOURCE_STRING_KEYS,
      ...REASONING_SOURCE_INDEX_KEYS,
    ]) ||
    typeof value.dialect !== 'string' ||
    !REASONING_ORIGIN_DIALECTS.has(value.dialect as ReasoningOriginDialect) ||
    !isReasoningProducerBridge(value.bridge)
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

function isVisiblePartDescriptor(value: unknown): value is Omit<ReasoningVisiblePartV2, 'text'> {
  return (
    isRecord(value) &&
    hasNoExtraKeys(value, ['id', 'groupId', 'kind', 'format', 'source', 'hidden']) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.groupId === 'string' &&
    value.groupId.length > 0 &&
    (value.kind === 'text' || value.kind === 'summary') &&
    isReasoningFormat(value.format) &&
    isSource(value.source) &&
    (value.hidden === undefined || typeof value.hidden === 'boolean')
  )
}

function isVisiblePart(value: unknown): value is ReasoningVisiblePartV2 {
  if (
    !isRecord(value) ||
    !hasNoExtraKeys(value, ['id', 'groupId', 'kind', 'text', 'format', 'source', 'hidden'])
  ) {
    return false
  }
  const { text, ...descriptor } = value
  return isVisiblePartDescriptor(descriptor) && typeof text === 'string'
}

function isCarrierDescriptor(value: unknown): value is OpaqueReasoningCarrierV2Descriptor {
  if (
    !isRecord(value) ||
    !hasNoExtraKeys(value, [
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
    !isReasoningFormat(value.format) ||
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

function isCarrier(value: unknown): value is OpaqueReasoningCarrierV2 {
  if (!isRecord(value)) return false
  const payloadKey = value.kind === 'anthropic-signature' ? 'signature' : 'data'
  if (
    !hasNoExtraKeys(value, [
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
  carrier: OpaqueReasoningCarrierV2 | OpaqueReasoningCarrierV2Descriptor,
): string | undefined {
  return carrier.kind === 'anthropic-signature' || carrier.kind === 'gemini-thought-signature'
    ? carrier.bindsVisiblePartId
    : undefined
}

function compatibleReasoningSources(
  left: ReasoningSourceRefV2,
  right: ReasoningSourceRefV2,
): boolean {
  if (left.dialect !== right.dialect) return false
  for (const key of REASONING_SOURCE_GROUP_STRING_KEYS) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
      return false
    }
  }
  for (const key of REASONING_SOURCE_GROUP_INDEX_KEYS) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
      return false
    }
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key))
}

function hasNoExtraKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

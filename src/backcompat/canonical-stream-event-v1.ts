import type {
  CanonicalStreamEventV1,
  ChatUsageV1,
  CitationFileIdentityV1,
  ContentAnnotationSourceV1,
  ContentAnnotationV1,
  ContentItemV1,
  GenerationServerToolCallV1,
  GenerationStreamFailureV1,
  GenerationStreamIntegrityV1,
  OpaqueReasoningCarrierDescriptorV1,
  OpaqueReasoningCarrierV1,
  ProviderOutputItemV1,
  ReasoningEnvelopeMutationV1,
  ReasoningEnvelopeV1Schema,
  ReasoningSourceRefV1,
  ReasoningVisiblePartV1,
  ResponsesOutputItemV1,
  ResultSnapshotOutcomeV1,
  ResultSnapshotPayloadV1,
  ResultSnapshotTextPartV1,
  ResultSnapshotToolCallV1,
} from './generation-stream-events-v1'

type CanonicalLane = CanonicalStreamEventV1['lane']
type CanonicalEventFor<Lane extends CanonicalLane> = Extract<CanonicalStreamEventV1, { lane: Lane }>
type CanonicalEventValidator<Lane extends CanonicalLane> = (
  value: Record<string, unknown>,
) => value is CanonicalEventFor<Lane> & Record<string, unknown>

const EVENT_VALIDATORS = {
  reasoning: isReasoningEvent,
  text: isTextEvent,
  'text-annotations': isTextAnnotationsEvent,
  'tool-call': isToolCallEvent,
  'server-tool': isServerToolEvent,
  'server-tool-output': isServerToolOutputEvent,
  'content-item': isContentItemEvent,
  'audio-output': isAudioOutputEvent,
  'output-item-added': isOutputItemAddedEvent,
  'output-item-done': isOutputItemDoneEvent,
  phase: isPhaseEvent,
  'result-snapshot': isResultSnapshotEvent,
  usage: isUsageEvent,
  finish: isFinishEvent,
  terminal: isTerminalEvent,
  meta: isMetaEvent,
  keepalive: isKeepaliveEvent,
  integrity: isIntegrityEvent,
  error: isErrorEvent,
} satisfies { [Lane in CanonicalLane]: CanonicalEventValidator<Lane> }

export function canonicalStreamEventV1FromUnknown(value: unknown): CanonicalStreamEventV1 | null {
  if (
    !isRecord(value) ||
    typeof value.lane !== 'string' ||
    !Object.hasOwn(EVENT_VALIDATORS, value.lane)
  ) {
    return null
  }
  const validate = EVENT_VALIDATORS[value.lane as CanonicalLane] as (
    candidate: Record<string, unknown>,
  ) => boolean
  return validate(value) ? (value as CanonicalStreamEventV1) : null
}

function isReasoningEnvelopeMutationV1(value: unknown): value is ReasoningEnvelopeMutationV1 {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'visible-append') {
    return (
      hasOnlyKeys(value, ['kind', 'part', 'delta']) &&
      isReasoningVisiblePartDescriptorV1(value.part) &&
      typeof value.delta === 'string'
    )
  }
  if (value.kind === 'visible-set') {
    return hasOnlyKeys(value, ['kind', 'part']) && isReasoningVisiblePartV1(value.part)
  }
  if (value.kind === 'carrier-append') {
    return (
      hasOnlyKeys(value, ['kind', 'carrier', 'delta']) &&
      isReasoningCarrierDescriptorV1(value.carrier) &&
      typeof value.delta === 'string'
    )
  }
  if (value.kind === 'carrier-set') {
    return hasOnlyKeys(value, ['kind', 'carrier']) && isReasoningCarrierV1(value.carrier)
  }
  return (
    value.kind === 'replace' &&
    hasOnlyKeys(value, ['kind', 'envelope']) &&
    isReasoningEnvelopeV1(value.envelope)
  )
}

function isReasoningEnvelopeV1(value: unknown): value is ReasoningEnvelopeV1Schema {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['schemaVersion', 'visible', 'carriers']) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.visible) ||
    !Array.isArray(value.carriers) ||
    !value.visible.every(isReasoningVisiblePartV1) ||
    !value.carriers.every(isReasoningCarrierV1) ||
    !hasUniqueReasoningIds(value.visible) ||
    !hasUniqueReasoningIds(value.carriers)
  ) {
    return false
  }
  const visibleById = new Map(value.visible.map((part) => [part.id, part]))
  for (const carrier of value.carriers) {
    const boundId = boundReasoningVisiblePartIdV1(carrier)
    if (!boundId) continue
    const visible = visibleById.get(boundId)
    if (
      !visible ||
      visible.groupId !== carrier.groupId ||
      visible.format !== carrier.format ||
      (carrier.kind === 'anthropic-signature' && visible.kind !== 'text') ||
      (carrier.kind === 'gemini-thought-signature' && visible.kind !== 'summary') ||
      !compatibleReasoningSourcesV1(visible.source, carrier.source)
    ) {
      return false
    }
  }
  return true
}

function isReasoningSourceV1(value: unknown): value is ReasoningSourceRefV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'dialect',
      ...REASONING_SOURCE_STRING_KEYS_V1,
      ...REASONING_SOURCE_INDEX_KEYS_V1,
    ]) ||
    typeof value.dialect !== 'string' ||
    !REASONING_ORIGIN_DIALECTS_V1.has(value.dialect)
  ) {
    return false
  }
  for (const key of REASONING_SOURCE_STRING_KEYS_V1) {
    const item = value[key]
    if (item !== undefined && (typeof item !== 'string' || item.length === 0)) return false
  }
  for (const key of REASONING_SOURCE_INDEX_KEYS_V1) {
    if (!isOptionalIndex(value[key])) return false
  }
  return true
}

function isReasoningVisiblePartDescriptorV1(
  value: unknown,
): value is Omit<ReasoningVisiblePartV1, 'text'> {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['id', 'groupId', 'kind', 'format', 'source', 'hidden']) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.groupId === 'string' &&
    value.groupId.length > 0 &&
    (value.kind === 'text' || value.kind === 'summary') &&
    typeof value.format === 'string' &&
    REASONING_FORMATS_V1.has(value.format) &&
    isReasoningSourceV1(value.source) &&
    isOptionalBoolean(value.hidden)
  )
}

function isReasoningVisiblePartV1(value: unknown): value is ReasoningVisiblePartV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['id', 'groupId', 'kind', 'text', 'format', 'source', 'hidden'])
  ) {
    return false
  }
  const { text, ...descriptor } = value
  return isReasoningVisiblePartDescriptorV1(descriptor) && typeof text === 'string'
}

function isReasoningCarrierDescriptorV1(
  value: unknown,
): value is OpaqueReasoningCarrierDescriptorV1 {
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
    typeof value.format !== 'string' ||
    !REASONING_FORMATS_V1.has(value.format) ||
    !isReasoningSourceV1(value.source) ||
    !isOptionalBoolean(value.hidden)
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

function isReasoningCarrierV1(value: unknown): value is OpaqueReasoningCarrierV1 {
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
  if (!isReasoningCarrierDescriptorV1(descriptor)) return false
  const payload = value[payloadKey]
  return typeof payload === 'string' && payload.length > 0
}

function hasUniqueReasoningIds(values: readonly { id: string }[]): boolean {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) return false
    ids.add(value.id)
  }
  return true
}

function boundReasoningVisiblePartIdV1(
  carrier: OpaqueReasoningCarrierV1 | OpaqueReasoningCarrierDescriptorV1,
): string | undefined {
  return carrier.kind === 'anthropic-signature' || carrier.kind === 'gemini-thought-signature'
    ? carrier.bindsVisiblePartId
    : undefined
}

function compatibleReasoningSourcesV1(
  left: ReasoningSourceRefV1,
  right: ReasoningSourceRefV1,
): boolean {
  if (left.dialect !== right.dialect) return false
  for (const key of REASONING_SOURCE_GROUP_STRING_KEYS_V1) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
      return false
    }
  }
  for (const key of REASONING_SOURCE_GROUP_INDEX_KEYS_V1) {
    const leftValue = left[key]
    const rightValue = right[key]
    if (leftValue !== undefined && rightValue !== undefined && leftValue !== rightValue) {
      return false
    }
  }
  return true
}

function isReasoningEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'reasoning'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'mutations', 'observed']) &&
    value.lane === 'reasoning' &&
    Array.isArray(value.mutations) &&
    value.mutations.every(isReasoningEnvelopeMutationV1) &&
    (value.observed === undefined || isReasoningObservation(value.observed))
  )
}

function isReasoningObservation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['firstAt', 'lastAt']) &&
    isTimestamp(value.firstAt) &&
    isTimestamp(value.lastAt) &&
    value.firstAt <= value.lastAt
  )
}

function isTextEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'text'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'text', 'chunkId', 'outputIndex', 'contentIndex']) &&
    value.lane === 'text' &&
    typeof value.text === 'string' &&
    isOptionalString(value.chunkId) &&
    isOptionalIndex(value.outputIndex) &&
    isOptionalIndex(value.contentIndex)
  )
}

function isTextAnnotationsEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'text-annotations'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'annotations', 'ownerTextLength', 'outputIndex', 'contentIndex']) &&
    value.lane === 'text-annotations' &&
    Array.isArray(value.annotations) &&
    isIndex(value.ownerTextLength) &&
    value.annotations.every((annotation) =>
      isContentAnnotation(annotation, value.ownerTextLength as number),
    ) &&
    isOptionalIndex(value.outputIndex) &&
    isOptionalIndex(value.contentIndex)
  )
}

function isToolCallEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'tool-call'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, [
      'lane',
      'index',
      'id',
      'type',
      'name',
      'argumentsDelta',
      'argumentsSnapshot',
      'chunkId',
      'outputIndex',
    ]) &&
    value.lane === 'tool-call' &&
    isIndex(value.index) &&
    isOptionalString(value.id) &&
    (value.type === undefined || value.type === 'function') &&
    isOptionalString(value.name) &&
    isOptionalString(value.argumentsDelta) &&
    isOptionalString(value.argumentsSnapshot) &&
    isOptionalString(value.chunkId) &&
    isOptionalIndex(value.outputIndex)
  )
}

function isServerToolEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'server-tool'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, [
      'lane',
      'itemType',
      'status',
      'itemId',
      'outputIndex',
      'partialImageB64',
    ]) &&
    value.lane === 'server-tool' &&
    typeof value.itemType === 'string' &&
    (value.status === 'in_progress' ||
      value.status === 'searching' ||
      value.status === 'completed') &&
    typeof value.itemId === 'string' &&
    isIndex(value.outputIndex) &&
    isOptionalString(value.partialImageB64)
  )
}

function isServerToolOutputEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'server-tool-output'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, [
      'lane',
      'dialect',
      'itemType',
      'itemId',
      'outputIndex',
      'output',
      'status',
    ]) &&
    value.lane === 'server-tool-output' &&
    (value.dialect === 'google-gemini' || value.dialect === 'anthropic-claude') &&
    typeof value.itemType === 'string' &&
    typeof value.itemId === 'string' &&
    isIndex(value.outputIndex) &&
    Object.hasOwn(value, 'output') &&
    value.output !== undefined &&
    isOptionalString(value.status)
  )
}

function isContentItemEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'content-item'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'item', 'chunkId', 'outputIndex', 'itemId']) &&
    value.lane === 'content-item' &&
    isContentItem(value.item) &&
    isOptionalString(value.chunkId) &&
    isOptionalIndex(value.outputIndex) &&
    isOptionalString(value.itemId)
  )
}

function isAudioOutputEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'audio-output'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'dataDelta', 'transcriptDelta', 'format', 'chunkId']) &&
    value.lane === 'audio-output' &&
    isOptionalString(value.dataDelta) &&
    isOptionalString(value.transcriptDelta) &&
    (value.format === undefined || AUDIO_FORMATS.has(value.format as string)) &&
    isOptionalString(value.chunkId)
  )
}

function isOutputItemAddedEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'output-item-added'> & Record<string, unknown> {
  return isOutputItemEvent(value, 'output-item-added')
}

function isOutputItemDoneEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'output-item-done'> & Record<string, unknown> {
  return isOutputItemEvent(value, 'output-item-done')
}

function isOutputItemEvent<Lane extends 'output-item-added' | 'output-item-done'>(
  value: Record<string, unknown>,
  lane: Lane,
): value is CanonicalEventFor<Lane> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'dialect', 'outputIndex', 'item']) &&
    value.lane === lane &&
    (value.dialect === 'openai-responses' || value.dialect === 'openrouter-responses') &&
    isIndex(value.outputIndex) &&
    isResponsesOutputItem(value.item)
  )
}

function isPhaseEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'phase'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'phase', 'outputIndex']) &&
    value.lane === 'phase' &&
    (value.phase === null || value.phase === 'commentary' || value.phase === 'final_answer') &&
    isIndex(value.outputIndex)
  )
}

function isResultSnapshotEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'result-snapshot'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, [
      'lane',
      'payload',
      'outcome',
      'model',
      'generationId',
      'usage',
      'integrity',
    ]) &&
    value.lane === 'result-snapshot' &&
    isResultSnapshotPayload(value.payload) &&
    isResultSnapshotOutcome(value.outcome) &&
    isOptionalString(value.model) &&
    isOptionalString(value.generationId) &&
    (value.usage === undefined || isUsage(value.usage)) &&
    (value.integrity === undefined ||
      (Array.isArray(value.integrity) && value.integrity.every(isIntegrity)))
  )
}

function isUsageEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'usage'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'usage', 'chunkId']) &&
    value.lane === 'usage' &&
    isUsage(value.usage) &&
    isOptionalString(value.chunkId)
  )
}

function isFinishEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'finish'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'finishReason', 'chunkId']) &&
    value.lane === 'finish' &&
    typeof value.finishReason === 'string' &&
    isOptionalString(value.chunkId)
  )
}

function isTerminalEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'terminal'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'evidence']) &&
    value.lane === 'terminal' &&
    value.evidence === 'done-sentinel'
  )
}

function isMetaEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'meta'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'model', 'provider', 'generationId']) &&
    value.lane === 'meta' &&
    isOptionalString(value.model) &&
    isOptionalString(value.provider) &&
    isOptionalString(value.generationId)
  )
}

function isKeepaliveEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'keepalive'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'comment']) &&
    value.lane === 'keepalive' &&
    typeof value.comment === 'string'
  )
}

function isIntegrityEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'integrity'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'integrity']) &&
    value.lane === 'integrity' &&
    isIntegrity(value.integrity)
  )
}

function isErrorEvent(
  value: Record<string, unknown>,
): value is CanonicalEventFor<'error'> & Record<string, unknown> {
  return (
    hasOnlyKeys(value, ['lane', 'error']) &&
    value.lane === 'error' &&
    isGenerationFailure(value.error)
  )
}

function isResultSnapshotPayload(value: unknown): value is ResultSnapshotPayloadV1 {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'retain') return hasOnlyKeys(value, ['kind'])
  return (
    value.kind === 'replace' &&
    hasOnlyKeys(value, [
      'kind',
      'textParts',
      'reasoningEnvelope',
      'toolCalls',
      'generatedContent',
      'serverTools',
      'providerOutputItems',
      'phase',
    ]) &&
    Array.isArray(value.textParts) &&
    value.textParts.every(isResultSnapshotTextPart) &&
    isReasoningEnvelopeV1(value.reasoningEnvelope) &&
    Array.isArray(value.toolCalls) &&
    value.toolCalls.every(isResultSnapshotToolCall) &&
    Array.isArray(value.generatedContent) &&
    value.generatedContent.every(isContentItem) &&
    Array.isArray(value.serverTools) &&
    value.serverTools.every(isServerToolRecord) &&
    Array.isArray(value.providerOutputItems) &&
    value.providerOutputItems.every(isProviderOutputItem) &&
    (value.phase === null || value.phase === 'commentary' || value.phase === 'final_answer')
  )
}

function isResultSnapshotTextPart(value: unknown): value is ResultSnapshotTextPartV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['text', 'outputIndex', 'contentIndex', 'annotations']) &&
    typeof value.text === 'string' &&
    isIndex(value.outputIndex) &&
    isIndex(value.contentIndex) &&
    Array.isArray(value.annotations) &&
    value.annotations.every((annotation) =>
      isContentAnnotation(annotation, (value.text as string).length),
    )
  )
}

function isResultSnapshotToolCall(value: unknown): value is ResultSnapshotToolCallV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['index', 'id', 'type', 'name', 'arguments']) &&
    isIndex(value.index) &&
    isOptionalString(value.id) &&
    (value.type === undefined || value.type === 'function') &&
    isOptionalString(value.name) &&
    typeof value.arguments === 'string'
  )
}

function isResultSnapshotOutcome(value: unknown): value is ResultSnapshotOutcomeV1 {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'finish') {
    return hasOnlyKeys(value, ['kind', 'finishReason']) && typeof value.finishReason === 'string'
  }
  return (
    value.kind === 'error' &&
    hasOnlyKeys(value, ['kind', 'error']) &&
    isGenerationFailure(value.error)
  )
}

function isGenerationFailure(value: unknown): value is GenerationStreamFailureV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'name',
      'kind',
      'httpStatus',
      'code',
      'message',
      'metadata',
      'midStream',
      'retryable',
    ]) &&
    (value.name === undefined || typeof value.name === 'string') &&
    GENERATION_FAILURE_KINDS.has(value.kind as string) &&
    (typeof value.code === 'string' || isFiniteNumber(value.code)) &&
    typeof value.message === 'string' &&
    (value.httpStatus === undefined || isHttpStatus(value.httpStatus)) &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    typeof value.midStream === 'boolean' &&
    typeof value.retryable === 'boolean'
  )
}

function isIntegrity(value: unknown): value is GenerationStreamIntegrityV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'category',
      'adapter',
      'eventType',
      'count',
      'fingerprint',
      'characterCount',
    ]) &&
    (value.category === 'malformed-json-frame' || value.category === 'malformed-event-shape') &&
    INTEGRITY_ADAPTERS.has(value.adapter as string) &&
    typeof value.eventType === 'string' &&
    isIndex(value.count) &&
    typeof value.fingerprint === 'string' &&
    isIndex(value.characterCount)
  )
}

function isServerToolRecord(value: unknown): value is GenerationServerToolCallV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'source', 'id', 'status', 'outputIndex', 'requestCount']) &&
    typeof value.type === 'string' &&
    SERVER_TOOL_SOURCES.has(value.source as string) &&
    isOptionalString(value.id) &&
    isOptionalString(value.status) &&
    isOptionalIndex(value.outputIndex) &&
    isOptionalIndex(value.requestCount)
  )
}

function isProviderOutputItem(value: unknown): value is ProviderOutputItemV1 {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      'dialect',
      'type',
      'captureId',
      'outputIndex',
      'hidden',
      'edited',
      'item',
    ]) &&
    PROVIDER_OUTPUT_DIALECTS.has(value.dialect as string) &&
    typeof value.type === 'string' &&
    isOptionalString(value.captureId) &&
    isOptionalIndex(value.outputIndex) &&
    isOptionalBoolean(value.hidden) &&
    isOptionalBoolean(value.edited) &&
    Object.hasOwn(value, 'item') &&
    value.item !== undefined
  )
}

function isResponsesOutputItem(value: unknown): value is ResponsesOutputItemV1 {
  return isRecord(value) && typeof value.type === 'string'
}

function isContentItem(value: unknown): value is ContentItemV1 {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'text':
      return (
        hasOnlyKeys(value, ['type', 'text', 'cacheControl']) &&
        typeof value.text === 'string' &&
        (value.cacheControl === undefined || isCacheControl(value.cacheControl))
      )
    case 'image_url':
      return (
        hasOnlyKeys(value, ['type', 'attachmentId', 'url', 'detail']) &&
        isOptionalString(value.attachmentId) &&
        isOptionalString(value.url) &&
        (value.detail === undefined ||
          value.detail === 'low' ||
          value.detail === 'high' ||
          value.detail === 'auto')
      )
    case 'input_audio':
      return (
        hasOnlyKeys(value, ['type', 'attachmentId', 'format']) &&
        isOptionalString(value.attachmentId) &&
        INPUT_AUDIO_FORMATS.has(value.format as string)
      )
    case 'file':
      return (
        hasOnlyKeys(value, ['type', 'filename', 'mime', 'attachmentId', 'url']) &&
        typeof value.filename === 'string' &&
        typeof value.mime === 'string' &&
        isOptionalLocator(value.attachmentId, value.url)
      )
    case 'video_url':
      return (
        hasOnlyKeys(value, ['type', 'attachmentId', 'url']) &&
        isOptionalString(value.attachmentId) &&
        isOptionalString(value.url)
      )
    case 'output_text':
      return (
        hasOnlyKeys(value, ['type', 'text', 'annotations']) &&
        typeof value.text === 'string' &&
        (value.annotations === undefined ||
          (Array.isArray(value.annotations) &&
            value.annotations.every((annotation) =>
              isContentAnnotation(annotation, (value.text as string).length),
            )))
      )
    case 'output_image':
    case 'output_video':
      return (
        hasOnlyKeys(value, ['type', 'prompt', 'attachmentId', 'url']) &&
        isOptionalString(value.prompt) &&
        exactlyOneString(value.attachmentId, value.url)
      )
    case 'audio_output':
      return (
        hasOnlyKeys(value, ['type', 'transcript', 'durationMs', 'format', 'attachmentId', 'url']) &&
        isOptionalString(value.transcript) &&
        (value.durationMs === undefined ||
          (isFiniteNumber(value.durationMs) && value.durationMs >= 0)) &&
        (value.format === undefined || AUDIO_FORMATS.has(value.format as string)) &&
        isOptionalLocator(value.attachmentId, value.url)
      )
    default:
      return false
  }
}

function isCacheControl(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['type', 'ttl']) &&
    value.type === 'ephemeral' &&
    (value.ttl === undefined || value.ttl === '1h')
  )
}

function isContentAnnotation(
  value: unknown,
  ownerTextLength?: number,
): value is ContentAnnotationV1 {
  if (
    !isRecord(value) ||
    !isIndex(value.startIndex) ||
    !isIndex(value.endIndex) ||
    value.startIndex > value.endIndex ||
    (ownerTextLength !== undefined && value.endIndex > ownerTextLength) ||
    !isContentAnnotationSource(value.source) ||
    !isRecord(value.providerPayload)
  ) {
    return false
  }
  if (value.type === 'url_citation') {
    return (
      hasOnlyKeys(value, [
        'type',
        'startIndex',
        'endIndex',
        'source',
        'providerPayload',
        'url',
        'title',
      ]) &&
      typeof value.url === 'string' &&
      isOptionalString(value.title)
    )
  }
  if (value.type === 'file_citation') {
    return (
      hasOnlyKeys(value, [
        'type',
        'startIndex',
        'endIndex',
        'source',
        'providerPayload',
        'file',
        'filename',
        'title',
        'citedText',
      ]) &&
      isCitationFileIdentity(value.file) &&
      isOptionalString(value.filename) &&
      isOptionalString(value.title) &&
      isOptionalString(value.citedText)
    )
  }
  return (
    value.type === 'unknown' &&
    hasOnlyKeys(value, [
      'type',
      'startIndex',
      'endIndex',
      'source',
      'providerPayload',
      'annotationType',
    ]) &&
    typeof value.annotationType === 'string'
  )
}

function isCitationFileIdentity(value: unknown): value is CitationFileIdentityV1 {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'attachment') {
    return hasOnlyKeys(value, ['kind', 'attachmentId']) && typeof value.attachmentId === 'string'
  }
  if (value.kind === 'provider-file') {
    return (
      hasOnlyKeys(value, ['kind', 'provider', 'fileId', 'containerId']) &&
      isContentAnnotationSource(value.provider) &&
      typeof value.fileId === 'string' &&
      isOptionalString(value.containerId)
    )
  }
  if (value.kind === 'document') {
    return (
      hasOnlyKeys(value, ['kind', 'provider', 'documentIndex']) &&
      isContentAnnotationSource(value.provider) &&
      isIndex(value.documentIndex)
    )
  }
  return (
    value.kind === 'unresolved' &&
    hasOnlyKeys(value, ['kind', 'provider']) &&
    isContentAnnotationSource(value.provider)
  )
}

function isContentAnnotationSource(value: unknown): value is ContentAnnotationSourceV1 {
  return CONTENT_ANNOTATION_SOURCES.has(value as string)
}

function isUsage(value: unknown): value is Partial<ChatUsageV1> & Record<string, unknown> {
  if (!isRecord(value)) return false
  for (const key of USAGE_COUNT_KEYS) {
    const count = value[key]
    if (count !== undefined && !isNonnegativeFiniteNumber(count)) return false
  }
  if (value.cost !== undefined && !isNonnegativeFiniteNumber(value.cost)) return false
  if (value.server_tool_use !== undefined && !isNumberRecord(value.server_tool_use)) return false
  if (
    value.prompt_tokens_details !== undefined &&
    !isUsageDetailRecord(value.prompt_tokens_details, PROMPT_TOKEN_DETAIL_KEYS)
  ) {
    return false
  }
  if (
    value.completion_tokens_details !== undefined &&
    !isUsageDetailRecord(value.completion_tokens_details, COMPLETION_TOKEN_DETAIL_KEYS)
  ) {
    return false
  }
  return (
    value.cost_details === undefined || isUsageDetailRecord(value.cost_details, COST_DETAIL_KEYS)
  )
}

function isUsageDetailRecord(
  value: unknown,
  knownKeys: readonly string[],
  validate: (value: unknown) => boolean = isNonnegativeFiniteNumber,
): boolean {
  if (!isRecord(value)) return false
  for (const key of knownKeys) {
    const item = value[key]
    if (item !== undefined && !validate(item)) return false
  }
  return true
}

function isNumberRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  for (const item of Object.values(value)) {
    if (!isNonnegativeFiniteNumber(item)) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTimestamp(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isHttpStatus(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 100 && (value as number) <= 599
}

function isOptionalIndex(value: unknown): boolean {
  return value === undefined || isIndex(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function exactlyOneString(left: unknown, right: unknown): boolean {
  return (typeof left === 'string') !== (typeof right === 'string')
}

function isOptionalLocator(left: unknown, right: unknown): boolean {
  return (
    isOptionalString(left) &&
    isOptionalString(right) &&
    !(typeof left === 'string' && typeof right === 'string')
  )
}

const GENERATION_FAILURE_KINDS = new Set<string>([
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
const INTEGRITY_ADAPTERS = new Set<string>([
  'chat-completions',
  'responses',
  'gemini-native',
  'anthropic-messages',
  'text-completions',
])
const SERVER_TOOL_SOURCES = new Set<string>([
  'responses-output',
  'stream-status',
  'usage',
  'provider-output',
])
const PROVIDER_OUTPUT_DIALECTS = new Set<string>([
  'openai-responses',
  'openrouter-responses',
  'google-gemini',
  'anthropic-claude',
  'unknown',
])
const REASONING_ORIGIN_DIALECTS_V1 = new Set<string>([
  'inline',
  'openai-chat',
  'openrouter-chat',
  'openai-responses',
  'openrouter-responses',
  'anthropic-messages',
  'gemini-native',
  'unknown',
])
const REASONING_FORMATS_V1 = new Set<string>([
  'unknown',
  'openai-responses-v1',
  'azure-openai-responses-v1',
  'xai-responses-v1',
  'anthropic-claude-v1',
  'google-gemini-v1',
])
const REASONING_SOURCE_STRING_KEYS_V1 = ['itemId', 'detailId'] as const
const REASONING_SOURCE_GROUP_STRING_KEYS_V1 = ['itemId'] as const
const REASONING_SOURCE_INDEX_KEYS_V1 = [
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
const REASONING_SOURCE_GROUP_INDEX_KEYS_V1 = [
  'choiceIndex',
  'outputIndex',
  'candidateIndex',
] as const
const CONTENT_ANNOTATION_SOURCES = new Set<string>([
  'openai-responses',
  'openai-chat',
  'anthropic-messages',
  'gemini-native',
  'imported',
  'unknown',
])
const INPUT_AUDIO_FORMATS = new Set<string>(['wav', 'mp3', 'flac', 'ogg', 'm4a'])
const AUDIO_FORMATS = new Set<string>(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'pcm16'])
const USAGE_COUNT_KEYS = [
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'cache_creation_input_tokens',
] as const
const PROMPT_TOKEN_DETAIL_KEYS = ['cached_tokens', 'audio_tokens', 'image_tokens'] as const
const COMPLETION_TOKEN_DETAIL_KEYS = [
  'reasoning_tokens',
  'audio_tokens',
  'accepted_prediction_tokens',
  'rejected_prediction_tokens',
] as const
const COST_DETAIL_KEYS = [
  'upstream_inference_cost',
  'upstream_inference_prompt_cost',
  'upstream_inference_completions_cost',
] as const

import {
  applyReasoningCarrierUpdate,
  applyReasoningEnvelopeMutation,
  applyReasoningVisibleUpdate,
  assertReasoningCarrierBinding,
  createReasoningEnvelopeState,
  ensureReasoningVisiblePart,
  mergeReasoningCarrierDescriptor,
  mergeReasoningVisiblePartDescriptor,
  type ReasoningEnvelopeState,
  reasoningCarrierDescriptor,
  reasoningVisiblePartDescriptor,
  releaseReasoningEnvelopeState,
} from './reasoning-envelope'
import type {
  OpaqueReasoningCarrierV2,
  OpaqueReasoningCarrierV2Descriptor,
  ReasoningDetail,
  ReasoningEnvelopeMutationV2,
  ReasoningFormat,
  ReasoningOriginDialect,
  ReasoningProducerBridge,
  ReasoningSourceRefV2,
  ReasoningVisiblePartV2,
} from './types'

export type ReasoningGroupAlias =
  | Readonly<{ kind: 'inline-choice'; choiceIndex: number }>
  | Readonly<{ kind: 'chat-choice'; choiceIndex: number; memberKind: 'text' | 'summary' }>
  | Readonly<{
      kind: 'detail-group'
      choiceIndex?: number
      detailIndex?: number
      detailOrdinal?: number
    }>
  | Readonly<{ kind: 'responses-output'; outputIndex: number }>
  | Readonly<{ kind: 'responses-item'; itemId: string }>
  | Readonly<{ kind: 'anthropic-block'; blockIndex: number }>
  | Readonly<{
      kind: 'gemini-part'
      candidateIndex: number
      frameIndex: number
      partIndex: number
    }>

export type ReasoningMemberAlias =
  | Readonly<{ kind: 'inline'; choiceIndex: number }>
  | Readonly<{
      kind: 'chat-scalar'
      choiceIndex: number
      visibleKind: 'text' | 'summary'
    }>
  | Readonly<{
      kind: 'detail-id'
      memberKind: 'text' | 'summary' | 'encrypted'
      id: string
      choiceIndex?: number
    }>
  | Readonly<{
      kind: 'detail-index'
      memberKind: 'text' | 'summary' | 'encrypted'
      index: number
      choiceIndex?: number
    }>
  | Readonly<{
      kind: 'detail-ordinal'
      memberKind: 'text' | 'summary' | 'encrypted'
      ordinal: number
      choiceIndex?: number
    }>
  | Readonly<{
      kind: 'responses-member'
      outputIndex: number
      itemId?: string
      member: 'text' | 'encrypted' | `summary:${number}` | `content:${number}`
    }>
  | Readonly<{
      kind: 'anthropic-member'
      blockIndex: number
      member: 'thinking' | 'signature' | 'redacted'
    }>
  | Readonly<{
      kind: 'gemini-member'
      candidateIndex: number
      frameIndex: number
      partIndex: number
      member: 'summary' | 'signature'
    }>

export interface ReasoningVisibleBindingObservation {
  readonly visibleKind: 'text' | 'summary'
  readonly format: ReasoningFormat
  readonly source: ReasoningSourceRefV2
  readonly groupAliases: readonly ReasoningGroupAlias[]
  readonly memberAliases: readonly ReasoningMemberAlias[]
  readonly hidden?: boolean
}

export type ReasoningObservation =
  | Readonly<{
      kind: 'visible'
      visibleKind: 'text' | 'summary'
      update: 'append' | 'append-overlap' | 'append-section' | 'set' | 'cumulative'
      value: string
      format: ReasoningFormat
      source: ReasoningSourceRefV2
      groupAliases: readonly ReasoningGroupAlias[]
      memberAliases: readonly ReasoningMemberAlias[]
      hidden?: boolean
    }>
  | Readonly<{
      kind: 'carrier'
      carrierKind: OpaqueReasoningCarrierV2['kind']
      update: 'append' | 'set' | 'cumulative'
      value: string
      format: ReasoningFormat
      source: ReasoningSourceRefV2
      groupAliases: readonly ReasoningGroupAlias[]
      memberAliases: readonly ReasoningMemberAlias[]
      binding?: ReasoningVisibleBindingObservation
      hidden?: boolean
    }>

export interface ReasoningObservationBatch {
  readonly observations: readonly ReasoningObservation[]
}

export interface ReasoningObservationCodecState {
  readonly envelope: ReasoningEnvelopeState
  readonly groupAliases: ReasoningAliasRegistry<'group'>
  readonly visibleAliases: ReasoningAliasRegistry<'visible'>
  readonly carrierAliases: ReasoningAliasRegistry<'carrier'>
}

type ReasoningAliasNamespace = 'group' | 'visible' | 'carrier'

type ReasoningAliasForNamespace<Namespace extends ReasoningAliasNamespace> =
  Namespace extends 'group' ? ReasoningGroupAlias : ReasoningMemberAlias

interface ReasoningAliasRegistry<Namespace extends ReasoningAliasNamespace> {
  readonly namespace: Namespace
  readonly idByKey: Map<string, string>
  readonly ambiguousKeys: Set<string>
  readonly strongIds: Set<string>
  nextAnonymousOrdinal: number
}

interface ReasoningAliasResolution {
  readonly id: string
  readonly claims: readonly Readonly<{ key: string; strength: 'strong' | 'weak' }>[]
  readonly ambiguities: readonly string[]
  readonly anonymousOrdinal?: number
}

export function createReasoningObservationCodecState(): ReasoningObservationCodecState {
  return {
    envelope: createReasoningEnvelopeState(),
    groupAliases: createReasoningAliasRegistry('group'),
    visibleAliases: createReasoningAliasRegistry('visible'),
    carrierAliases: createReasoningAliasRegistry('carrier'),
  }
}

export function releaseReasoningObservationCodecState(state: ReasoningObservationCodecState): void {
  releaseReasoningEnvelopeState(state.envelope)
  releaseReasoningAliasRegistry(state.groupAliases)
  releaseReasoningAliasRegistry(state.visibleAliases)
  releaseReasoningAliasRegistry(state.carrierAliases)
}

export function applyReasoningObservationBatch(
  state: ReasoningObservationCodecState,
  batch: ReasoningObservationBatch,
): readonly ReasoningEnvelopeMutationV2[] {
  const mutations: ReasoningEnvelopeMutationV2[] = []
  for (const observation of batch.observations) {
    const groupResolution = resolveAliasId(
      state.groupAliases,
      observation.groupAliases,
      state.envelope.groupIds,
    )
    if (observation.kind === 'visible') {
      const visibleResolution = resolveAliasId(
        state.visibleAliases,
        observation.memberAliases,
        state.envelope.visibleById,
      )
      const part = resolveVisiblePart(state, observation, groupResolution.id, visibleResolution.id)
      const nextMutations = applyReasoningVisibleUpdate(state.envelope, {
        part,
        mode: observation.update,
        value: observation.value,
      })
      commitAliasResolution(state.groupAliases, groupResolution)
      commitAliasResolution(state.visibleAliases, visibleResolution)
      mutations.push(...nextMutations)
      continue
    }
    let bindsVisiblePartId: string | undefined
    let bindingGroupResolution: ReasoningAliasResolution | undefined
    let bindingMemberResolution: ReasoningAliasResolution | undefined
    let binding: Omit<ReasoningVisiblePartV2, 'text'> | undefined
    if (observation.binding) {
      if (
        observation.carrierKind !== 'anthropic-signature' &&
        observation.carrierKind !== 'gemini-thought-signature'
      ) {
        throw new Error(`ReasoningObservationBindingForbidden:${observation.carrierKind}`)
      }
      if (
        observation.carrierKind === 'gemini-thought-signature' &&
        observation.binding.visibleKind !== 'summary'
      ) {
        throw new Error(`ReasoningObservationBindingKindInvalid:${observation.carrierKind}`)
      }
      bindingGroupResolution = resolveAliasId(
        state.groupAliases,
        observation.binding.groupAliases,
        state.envelope.groupIds,
      )
      bindingMemberResolution = resolveAliasId(
        state.visibleAliases,
        observation.binding.memberAliases,
        state.envelope.visibleById,
      )
      binding = resolveVisiblePart(
        state,
        observation.binding,
        bindingGroupResolution.id,
        bindingMemberResolution.id,
      )
      bindsVisiblePartId = binding.id
    }
    const carrierResolution = resolveAliasId(
      state.carrierAliases,
      observation.memberAliases,
      state.envelope.carrierById,
    )
    const carrier = resolveCarrier(
      state,
      observation,
      groupResolution.id,
      bindsVisiblePartId,
      carrierResolution.id,
    )
    if (binding) assertReasoningCarrierBinding(carrier, binding)
    const bindingMutations = binding ? ensureReasoningVisiblePart(state.envelope, binding) : []
    const carrierMutations = applyReasoningCarrierUpdate(state.envelope, {
      carrier,
      mode: observation.update,
      value: observation.value,
    })
    commitAliasResolution(state.groupAliases, groupResolution)
    if (bindingGroupResolution) {
      commitAliasResolution(state.groupAliases, bindingGroupResolution)
    }
    if (bindingMemberResolution) {
      commitAliasResolution(state.visibleAliases, bindingMemberResolution)
    }
    commitAliasResolution(state.carrierAliases, carrierResolution)
    mutations.push(...bindingMutations, ...carrierMutations)
  }
  return mutations
}

export function applyCanonicalReasoningMutation(
  state: ReasoningObservationCodecState,
  mutation: ReasoningEnvelopeMutationV2,
): boolean {
  const changed = applyReasoningEnvelopeMutation(state.envelope, mutation)
  if (mutation.kind === 'replace') {
    releaseReasoningAliasRegistry(state.groupAliases)
    releaseReasoningAliasRegistry(state.visibleAliases)
    releaseReasoningAliasRegistry(state.carrierAliases)
    for (const part of mutation.envelope.visible) seedCanonicalVisiblePart(state, part)
    for (const carrier of mutation.envelope.carriers) seedCanonicalCarrier(state, carrier)
    return changed
  }
  if (mutation.kind === 'visible-append' || mutation.kind === 'visible-set') {
    const id = mutation.part.id
    const part = reasoningVisiblePartDescriptor(state.envelope, id)
    if (part) seedCanonicalVisiblePart(state, part)
    return changed
  }
  const id = mutation.carrier.id
  const carrier = reasoningCarrierDescriptor(state.envelope, id)
  if (carrier) seedCanonicalCarrier(state, carrier)
  return changed
}

export function reasoningObservationsFromDetails(input: {
  readonly details: readonly ReasoningDetail[]
  readonly mode: 'delta' | 'snapshot' | 'cumulative'
  readonly dialect: ReasoningOriginDialect
  readonly bridge: ReasoningProducerBridge
  readonly untypedVisibleKind: 'text' | 'summary'
  readonly separateGeminiVisibleSections?: boolean
  readonly source?: Omit<ReasoningSourceRefV2, 'dialect' | 'bridge'>
}): ReasoningObservation[] {
  const rows = input.details.flatMap((detail, detailOrdinal) => {
    if (detail.id?.startsWith('tool_')) return []
    return [detailObservationRow(input, detail, detailOrdinal)]
  })
  const seenAliases = new Set<string>()
  for (const row of rows) {
    const unclaimedAliases = row.memberAliases.filter((alias) => {
      const key = JSON.stringify([row.groupAliases, alias])
      if (seenAliases.has(key)) return false
      seenAliases.add(key)
      return true
    })
    if (unclaimedAliases.length === 0) {
      row.memberAliases = [detailOrdinalAlias(row.detail, row.source, row.detailOrdinal)]
      row.source = { ...row.source, detailOrdinal: row.detailOrdinal }
    } else {
      row.memberAliases = unclaimedAliases
    }
  }

  const onlyVisibleByGroup = new Map<string, ReasoningVisibleBindingObservation | null>()
  const carrierCountByGroup = new Map<string, number>()
  for (const row of rows) {
    const key = correlationGroupKey(row.groupAliases)
    if (row.detail.type === 'reasoning.summary' || row.detail.type === 'reasoning.text') {
      const binding = visibleBindingFromDetailRow(row, input.untypedVisibleKind)
      onlyVisibleByGroup.set(key, onlyVisibleByGroup.has(key) ? null : binding)
    } else if (row.detail.format === 'google-gemini-v1') {
      carrierCountByGroup.set(key, (carrierCountByGroup.get(key) ?? 0) + 1)
    }
  }

  const observations: ReasoningObservation[] = []
  for (const row of rows) {
    const update =
      input.mode === 'delta' ? 'append' : input.mode === 'cumulative' ? 'cumulative' : 'set'
    const visibleUpdate =
      input.mode === 'delta' &&
      input.separateGeminiVisibleSections === true &&
      row.detail.format === 'google-gemini-v1'
        ? 'append-section'
        : update
    if (row.detail.type === 'reasoning.summary') {
      observations.push({
        kind: 'visible',
        visibleKind: 'summary',
        update: visibleUpdate,
        value: row.detail.summary,
        format: row.detail.format,
        source: row.source,
        groupAliases: row.groupAliases,
        memberAliases: row.memberAliases,
        ...(row.detail.hidden === undefined ? {} : { hidden: row.detail.hidden }),
      })
      continue
    }
    if (row.detail.type === 'reasoning.text') {
      const binding = visibleBindingFromDetailRow(row, input.untypedVisibleKind)
      if ((row.detail.text?.length ?? 0) > 0 || !row.detail.signature) {
        observations.push({
          kind: 'visible',
          ...binding,
          update: visibleUpdate,
          value: row.detail.text ?? '',
        })
      }
      if (row.detail.signature) {
        observations.push({
          kind: 'carrier',
          carrierKind: 'anthropic-signature',
          update: input.mode === 'delta' ? 'set' : update,
          value: row.detail.signature,
          format: row.detail.format,
          source: row.source,
          groupAliases: row.groupAliases,
          memberAliases: signatureAliases(row),
          binding,
          ...(row.detail.hidden === undefined ? {} : { hidden: row.detail.hidden }),
        })
      }
      continue
    }
    const groupKey = correlationGroupKey(row.groupAliases)
    const binding =
      row.detail.format === 'google-gemini-v1' && carrierCountByGroup.get(groupKey) === 1
        ? (onlyVisibleByGroup.get(groupKey) ?? undefined)
        : undefined
    observations.push({
      kind: 'carrier',
      carrierKind: carrierKindForDetail(row.detail),
      update,
      value: row.detail.data,
      format: row.detail.format,
      source: row.source,
      groupAliases: row.groupAliases,
      memberAliases: row.memberAliases,
      ...(binding ? { binding } : {}),
      ...(row.detail.hidden === undefined ? {} : { hidden: row.detail.hidden }),
    })
  }
  return observations
}

interface DetailObservationRow {
  readonly detail: ReasoningDetail
  source: ReasoningSourceRefV2
  readonly groupAliases: ReasoningGroupAlias[]
  memberAliases: ReasoningMemberAlias[]
  readonly detailOrdinal: number
}

function detailObservationRow(
  input: {
    readonly dialect: ReasoningOriginDialect
    readonly bridge: ReasoningProducerBridge
    readonly source?: Omit<ReasoningSourceRefV2, 'dialect' | 'bridge'>
  },
  detail: ReasoningDetail,
  detailOrdinal: number,
): DetailObservationRow {
  const itemId = input.source?.itemId ?? detail.providerItemId
  const outputIndex = input.source?.outputIndex ?? detail.providerOutputIndex
  const source: ReasoningSourceRefV2 = {
    dialect: input.dialect,
    bridge: input.bridge,
    ...input.source,
    ...(itemId ? { itemId } : {}),
    ...(detail.id ? { detailId: detail.id } : {}),
    ...(outputIndex !== undefined ? { outputIndex } : {}),
    ...(detail.providerSummaryIndex !== undefined
      ? { summaryIndex: detail.providerSummaryIndex }
      : {}),
    ...(detail.index !== undefined ? { detailIndex: detail.index } : {}),
    ...(detail.index === undefined ? { detailOrdinal } : {}),
  }
  const groupAliases: ReasoningGroupAlias[] = [
    {
      kind: 'detail-group',
      ...(input.source?.choiceIndex !== undefined ? { choiceIndex: input.source.choiceIndex } : {}),
      ...(detail.index !== undefined ? { detailIndex: detail.index } : { detailOrdinal }),
    },
    ...(outputIndex !== undefined ? ([{ kind: 'responses-output', outputIndex }] as const) : []),
    ...(itemId ? ([{ kind: 'responses-item', itemId }] as const) : []),
  ]
  const memberKind =
    detail.type === 'reasoning.summary'
      ? 'summary'
      : detail.type === 'reasoning.text'
        ? 'text'
        : 'encrypted'
  const memberAliases: ReasoningMemberAlias[] = []
  if (detail.id) {
    memberAliases.push({
      kind: 'detail-id',
      memberKind,
      id: detail.id,
      ...(input.source?.choiceIndex !== undefined ? { choiceIndex: input.source.choiceIndex } : {}),
    })
  }
  if (detail.index !== undefined) {
    memberAliases.push({
      kind: 'detail-index',
      memberKind,
      index: detail.index,
      ...(input.source?.choiceIndex !== undefined ? { choiceIndex: input.source.choiceIndex } : {}),
    })
  }
  if (outputIndex !== undefined) {
    const member =
      detail.type === 'reasoning.summary' && detail.providerSummaryIndex !== undefined
        ? (`summary:${detail.providerSummaryIndex}` as const)
        : detail.type === 'reasoning.encrypted'
          ? ('encrypted' as const)
          : undefined
    if (member) {
      memberAliases.push(
        { kind: 'responses-member', outputIndex, member },
        ...(itemId ? ([{ kind: 'responses-member', outputIndex, itemId, member }] as const) : []),
      )
    }
  }
  if (memberAliases.length === 0) {
    memberAliases.push(detailOrdinalAlias(detail, source, detailOrdinal))
  }
  return { detail, source, groupAliases, memberAliases, detailOrdinal }
}

function detailOrdinalAlias(
  detail: ReasoningDetail,
  source: ReasoningSourceRefV2,
  ordinal: number,
): ReasoningMemberAlias {
  return {
    kind: 'detail-ordinal',
    memberKind:
      detail.type === 'reasoning.summary'
        ? 'summary'
        : detail.type === 'reasoning.text'
          ? 'text'
          : 'encrypted',
    ordinal,
    ...(source.choiceIndex !== undefined ? { choiceIndex: source.choiceIndex } : {}),
  }
}

function visibleBindingFromDetailRow(
  row: DetailObservationRow,
  untypedVisibleKind: 'text' | 'summary',
): ReasoningVisibleBindingObservation {
  return {
    visibleKind: row.detail.type === 'reasoning.summary' ? 'summary' : untypedVisibleKind,
    format: row.detail.format,
    source: row.source,
    groupAliases: row.groupAliases,
    memberAliases: row.memberAliases,
    ...(row.detail.hidden === undefined ? {} : { hidden: row.detail.hidden }),
  }
}

function signatureAliases(row: DetailObservationRow): ReasoningMemberAlias[] {
  return row.memberAliases.map((alias) => {
    if (
      alias.kind === 'detail-id' ||
      alias.kind === 'detail-index' ||
      alias.kind === 'detail-ordinal'
    ) {
      return { ...alias, memberKind: 'encrypted' as const }
    }
    return alias
  })
}

function correlationGroupKey(aliases: readonly ReasoningGroupAlias[]): string {
  const strong = aliases.filter((alias) => reasoningAliasStrength(alias) === 'strong')
  return JSON.stringify(strong.length > 0 ? strong : aliases)
}

function carrierKindForDetail(
  detail: Extract<ReasoningDetail, { type: 'reasoning.encrypted' }>,
): OpaqueReasoningCarrierV2['kind'] {
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

function seedCanonicalVisiblePart(
  state: ReasoningObservationCodecState,
  part: Omit<ReasoningVisiblePartV2, 'text'>,
): void {
  seedCanonicalAliases(
    state.groupAliases,
    canonicalGroupAliases(part.source, part.kind, part.groupId),
    part.groupId,
  )
  seedCanonicalAliases(state.visibleAliases, canonicalVisibleMemberAliases(part), part.id)
}

function seedCanonicalCarrier(
  state: ReasoningObservationCodecState,
  carrier: OpaqueReasoningCarrierV2Descriptor,
): void {
  const visibleKind =
    carrier.kind === 'anthropic-signature'
      ? 'text'
      : carrier.kind === 'gemini-thought-signature'
        ? 'summary'
        : undefined
  seedCanonicalAliases(
    state.groupAliases,
    canonicalGroupAliases(carrier.source, visibleKind, carrier.groupId),
    carrier.groupId,
  )
  seedCanonicalAliases(state.carrierAliases, canonicalCarrierMemberAliases(carrier), carrier.id)
  if (
    (carrier.kind === 'anthropic-signature' || carrier.kind === 'gemini-thought-signature') &&
    carrier.bindsVisiblePartId
  ) {
    const bound = reasoningVisiblePartDescriptor(state.envelope, carrier.bindsVisiblePartId)
    if (bound) seedCanonicalVisiblePart(state, bound)
  }
}

function canonicalGroupAliases(
  source: ReasoningSourceRefV2,
  visibleKind: 'text' | 'summary' | undefined,
  id: string,
): ReasoningGroupAlias[] {
  if (source.dialect === 'inline' && source.choiceIndex !== undefined) {
    return [{ kind: 'inline-choice', choiceIndex: source.choiceIndex }]
  }
  if (source.dialect === 'anthropic-messages' && source.blockIndex !== undefined) {
    return [{ kind: 'anthropic-block', blockIndex: source.blockIndex }]
  }
  if (
    source.dialect === 'gemini-native' &&
    source.candidateIndex !== undefined &&
    source.frameIndex !== undefined &&
    source.partIndex !== undefined
  ) {
    return [
      {
        kind: 'gemini-part',
        candidateIndex: source.candidateIndex,
        frameIndex: source.frameIndex,
        partIndex: source.partIndex,
      },
    ]
  }
  const aliases = detailGroupAliasesFromSource(source)
  if (source.choiceIndex !== undefined && visibleKind !== undefined) {
    const chatAlias = {
      kind: 'chat-choice' as const,
      choiceIndex: source.choiceIndex,
      memberKind: visibleKind,
    }
    if (aliases.length === 0 || id === aliasIdentity('group', JSON.stringify(chatAlias))) {
      aliases.unshift(chatAlias)
    }
  }
  return aliases.length > 0
    ? aliases
    : [{ kind: 'detail-group', detailOrdinal: source.detailOrdinal ?? 0 }]
}

function detailGroupAliasesFromSource(source: ReasoningSourceRefV2): ReasoningGroupAlias[] {
  const aliases: ReasoningGroupAlias[] = []
  if (source.detailIndex !== undefined || source.detailOrdinal !== undefined) {
    aliases.push({
      kind: 'detail-group',
      ...(source.choiceIndex !== undefined ? { choiceIndex: source.choiceIndex } : {}),
      ...(source.detailIndex !== undefined
        ? { detailIndex: source.detailIndex }
        : { detailOrdinal: source.detailOrdinal as number }),
    })
  }
  if (source.outputIndex !== undefined) {
    aliases.push({ kind: 'responses-output', outputIndex: source.outputIndex })
  }
  if (source.itemId) aliases.push({ kind: 'responses-item', itemId: source.itemId })
  return aliases
}

function canonicalVisibleMemberAliases(
  part: Omit<ReasoningVisiblePartV2, 'text'>,
): ReasoningMemberAlias[] {
  const { source } = part
  if (source.dialect === 'inline' && source.choiceIndex !== undefined) {
    return [{ kind: 'inline', choiceIndex: source.choiceIndex }]
  }
  if (source.dialect === 'anthropic-messages' && source.blockIndex !== undefined) {
    return [{ kind: 'anthropic-member', blockIndex: source.blockIndex, member: 'thinking' }]
  }
  if (
    source.dialect === 'gemini-native' &&
    source.candidateIndex !== undefined &&
    source.frameIndex !== undefined &&
    source.partIndex !== undefined
  ) {
    return [
      {
        kind: 'gemini-member',
        candidateIndex: source.candidateIndex,
        frameIndex: source.frameIndex,
        partIndex: source.partIndex,
        member: 'summary',
      },
    ]
  }
  const aliases = detailMemberAliasesFromSource(source, part.kind)
  if (source.choiceIndex !== undefined) {
    const chatAlias = {
      kind: 'chat-scalar' as const,
      choiceIndex: source.choiceIndex,
      visibleKind: part.kind,
    }
    if (aliases.length === 0 || part.id === aliasIdentity('visible', JSON.stringify(chatAlias))) {
      aliases.unshift(chatAlias)
    }
  }
  return aliases.length > 0
    ? aliases
    : [{ kind: 'detail-ordinal', memberKind: part.kind, ordinal: source.detailOrdinal ?? 0 }]
}

function canonicalCarrierMemberAliases(
  carrier: OpaqueReasoningCarrierV2Descriptor,
): ReasoningMemberAlias[] {
  const { source } = carrier
  if (source.dialect === 'anthropic-messages' && source.blockIndex !== undefined) {
    return [
      {
        kind: 'anthropic-member',
        blockIndex: source.blockIndex,
        member: carrier.kind === 'anthropic-signature' ? 'signature' : 'redacted',
      },
    ]
  }
  if (
    source.dialect === 'gemini-native' &&
    source.candidateIndex !== undefined &&
    source.frameIndex !== undefined &&
    source.partIndex !== undefined
  ) {
    return [
      {
        kind: 'gemini-member',
        candidateIndex: source.candidateIndex,
        frameIndex: source.frameIndex,
        partIndex: source.partIndex,
        member: 'signature',
      },
    ]
  }
  return detailMemberAliasesFromSource(source, 'encrypted')
}

function detailMemberAliasesFromSource(
  source: ReasoningSourceRefV2,
  memberKind: 'text' | 'summary' | 'encrypted',
): ReasoningMemberAlias[] {
  const aliases: ReasoningMemberAlias[] = []
  if (source.detailId) {
    aliases.push({
      kind: 'detail-id',
      memberKind,
      id: source.detailId,
      ...(source.choiceIndex !== undefined ? { choiceIndex: source.choiceIndex } : {}),
    })
  }
  if (source.detailIndex !== undefined) {
    aliases.push({
      kind: 'detail-index',
      memberKind,
      index: source.detailIndex,
      ...(source.choiceIndex !== undefined ? { choiceIndex: source.choiceIndex } : {}),
    })
  } else if (source.detailOrdinal !== undefined) {
    aliases.push({
      kind: 'detail-ordinal',
      memberKind,
      ordinal: source.detailOrdinal,
      ...(source.choiceIndex !== undefined ? { choiceIndex: source.choiceIndex } : {}),
    })
  }
  if (source.outputIndex !== undefined) {
    const responseMember =
      memberKind === 'encrypted'
        ? ('encrypted' as const)
        : memberKind === 'summary' && source.summaryIndex !== undefined
          ? (`summary:${source.summaryIndex}` as const)
          : memberKind === 'text' && source.contentIndex !== undefined
            ? (`content:${source.contentIndex}` as const)
            : (source.dialect === 'openai-responses' ||
                  source.dialect === 'openrouter-responses') &&
                memberKind === 'text'
              ? ('text' as const)
              : undefined
    if (responseMember) {
      aliases.push(
        { kind: 'responses-member', outputIndex: source.outputIndex, member: responseMember },
        ...(source.itemId
          ? ([
              {
                kind: 'responses-member',
                outputIndex: source.outputIndex,
                itemId: source.itemId,
                member: responseMember,
              },
            ] as const)
          : []),
      )
    }
  }
  return aliases
}

function seedCanonicalAliases<Namespace extends ReasoningAliasNamespace>(
  registry: ReasoningAliasRegistry<Namespace>,
  aliases: readonly ReasoningAliasForNamespace<Namespace>[],
  id: string,
): void {
  for (const alias of aliases) {
    const key = JSON.stringify(alias)
    const strength = reasoningAliasStrength(alias)
    const existing = registry.idByKey.get(key)
    if (existing === undefined && !registry.ambiguousKeys.has(key)) {
      registry.idByKey.set(key, id)
    } else if (existing !== undefined && existing !== id) {
      registry.idByKey.delete(key)
      registry.ambiguousKeys.add(key)
    }
    if (strength === 'strong') registry.strongIds.add(id)
  }
}

function resolveVisiblePart(
  state: ReasoningObservationCodecState,
  observation:
    | ReasoningVisibleBindingObservation
    | Extract<ReasoningObservation, { kind: 'visible' }>,
  groupId: string,
  id: string,
): Omit<ReasoningVisiblePartV2, 'text'> {
  const current = reasoningVisiblePartDescriptor(state.envelope, id)
  if (current) {
    return mergeReasoningVisiblePartDescriptor(current, {
      id,
      groupId,
      kind: observation.visibleKind,
      format: observation.format,
      source: { ...observation.source },
      ...(observation.hidden === undefined ? {} : { hidden: observation.hidden }),
    })
  }
  return {
    id,
    groupId,
    kind: observation.visibleKind,
    format: observation.format,
    source: { ...observation.source },
    ...(observation.hidden === undefined ? {} : { hidden: observation.hidden }),
  } satisfies Omit<ReasoningVisiblePartV2, 'text'>
}

function resolveCarrier(
  state: ReasoningObservationCodecState,
  observation: Extract<ReasoningObservation, { kind: 'carrier' }>,
  groupId: string,
  bindsVisiblePartId: string | undefined,
  id: string,
): OpaqueReasoningCarrierV2Descriptor {
  const common = {
    id,
    groupId,
    format: observation.format,
    source: { ...observation.source },
    ...(observation.hidden === undefined ? {} : { hidden: observation.hidden }),
  }
  let created: OpaqueReasoningCarrierV2Descriptor
  if (observation.carrierKind === 'anthropic-signature') {
    if (!bindsVisiblePartId) throw new Error('ReasoningObservationBindingMissing')
    created = { ...common, kind: observation.carrierKind, bindsVisiblePartId }
  } else if (observation.carrierKind === 'gemini-thought-signature') {
    created = {
      ...common,
      kind: observation.carrierKind,
      ...(bindsVisiblePartId ? { bindsVisiblePartId } : {}),
    }
  } else {
    created = { ...common, kind: observation.carrierKind }
  }
  const current = reasoningCarrierDescriptor(state.envelope, id)
  return current ? mergeReasoningCarrierDescriptor(current, created) : created
}

function resolveAliasId<Namespace extends ReasoningAliasNamespace>(
  registry: ReasoningAliasRegistry<Namespace>,
  aliases: readonly ReasoningAliasForNamespace<Namespace>[],
  existingIds: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): ReasoningAliasResolution {
  const { namespace } = registry
  if (aliases.length === 0) throw new Error(`ReasoningObservationAliasMissing:${namespace}`)
  const claims = aliases.map((alias) => ({
    key: JSON.stringify(alias),
    strength: reasoningAliasStrength(alias),
  }))
  const strongClaims = claims.filter((claim) => claim.strength === 'strong')
  const mappedStrongIds = uniqueMappedAliasIds(registry, strongClaims, existingIds)
  if (mappedStrongIds.length > 1) {
    throw new Error(`ReasoningObservationStrongAliasConflict:${namespace}`)
  }

  let id = mappedStrongIds[0]
  if (id === undefined && strongClaims.length > 0) {
    const weakCandidates = uniqueMappedAliasIds(
      registry,
      claims.filter((claim) => claim.strength === 'weak'),
      existingIds,
    )
    const weakCandidate = weakCandidates.length === 1 ? weakCandidates[0] : undefined
    id =
      weakCandidate !== undefined && !registry.strongIds.has(weakCandidate)
        ? weakCandidate
        : aliasIdentity(namespace, strongClaims[0]?.key as string)
  }
  if (id === undefined) {
    const weakCandidates = uniqueMappedAliasIds(registry, claims, existingIds)
    if (
      weakCandidates.length > 1 ||
      claims.every((claim) => registry.ambiguousKeys.has(claim.key))
    ) {
      return {
        id: `reasoning-${namespace}-v2:anonymous:${registry.nextAnonymousOrdinal}`,
        claims,
        ambiguities: claims.map((claim) => claim.key),
        anonymousOrdinal: registry.nextAnonymousOrdinal,
      }
    }
    id = weakCandidates[0] ?? aliasIdentity(namespace, claims[0]?.key as string)
  }

  const ambiguities: string[] = []
  for (const claim of claims) {
    if (claim.strength === 'weak') {
      const existing = registry.idByKey.get(claim.key)
      if (existing !== undefined && existing !== id) ambiguities.push(claim.key)
    }
  }
  return { id, claims, ambiguities }
}

function createReasoningAliasRegistry<Namespace extends ReasoningAliasNamespace>(
  namespace: Namespace,
): ReasoningAliasRegistry<Namespace> {
  return {
    namespace,
    idByKey: new Map(),
    ambiguousKeys: new Set(),
    strongIds: new Set(),
    nextAnonymousOrdinal: 0,
  }
}

function releaseReasoningAliasRegistry(
  registry: ReasoningAliasRegistry<ReasoningAliasNamespace>,
): void {
  registry.idByKey.clear()
  registry.ambiguousKeys.clear()
  registry.strongIds.clear()
  registry.nextAnonymousOrdinal = 0
}

function uniqueMappedAliasIds(
  registry: ReasoningAliasRegistry<ReasoningAliasNamespace>,
  claims: readonly Readonly<{ key: string }>[],
  existingIds: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): string[] {
  const ids = new Set<string>()
  for (const claim of claims) {
    if (registry.ambiguousKeys.has(claim.key)) continue
    const mapped = registry.idByKey.get(claim.key)
    const deterministic = aliasIdentity(registry.namespace, claim.key)
    const id = mapped ?? (existingIds.has(deterministic) ? deterministic : undefined)
    if (id !== undefined) ids.add(id)
  }
  return [...ids]
}

function commitAliasResolution(
  registry: ReasoningAliasRegistry<ReasoningAliasNamespace>,
  resolution: ReasoningAliasResolution,
): void {
  for (const key of resolution.ambiguities) registry.ambiguousKeys.add(key)
  for (const claim of resolution.claims) {
    if (registry.ambiguousKeys.has(claim.key)) continue
    const existing = registry.idByKey.get(claim.key)
    if (existing === undefined) {
      registry.idByKey.set(claim.key, resolution.id)
    } else if (existing !== resolution.id && claim.strength === 'strong') {
      throw new Error('ReasoningObservationStrongAliasCommitConflict')
    }
  }
  if (resolution.claims.some((claim) => claim.strength === 'strong')) {
    registry.strongIds.add(resolution.id)
  }
  if (resolution.anonymousOrdinal !== undefined) {
    if (resolution.anonymousOrdinal !== registry.nextAnonymousOrdinal) {
      throw new Error('ReasoningObservationAnonymousAliasCommitConflict')
    }
    registry.nextAnonymousOrdinal += 1
  }
}

function aliasIdentity(namespace: ReasoningAliasNamespace, key: string): string {
  return `reasoning-${namespace}-v2:${key}`
}

function reasoningAliasStrength(
  alias: ReasoningGroupAlias | ReasoningMemberAlias,
): 'strong' | 'weak' {
  if (alias.kind === 'detail-index' || alias.kind === 'detail-ordinal') return 'weak'
  if (alias.kind === 'detail-group') return 'weak'
  return 'strong'
}

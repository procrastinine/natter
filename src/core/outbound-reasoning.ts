import type { AssistantRouteContract } from './api-choice'
import type { AppliedMessageAttempt, AppliedMessageView } from './continuation-content'
import { createAppliedMessageView } from './continuation-content'
import {
  type AnthropicReasoningContract,
  analyzeReasoningEnvelopeReplayTopology,
  type ChatReasoningContract,
  type GeminiReasoningContract,
  mergeSealedReasoningCarryForward,
  type ReasoningEnvelopeReplayTopology,
  type ReasoningReplayContract,
  type ResponsesReasoningContract,
  reasoningCarrierReplayDecision,
  reasoningCarrierReplayFact,
  reasoningCarrierTopologyOmission,
  type TextReasoningContract,
} from './reasoning'
import { normalizeInlineReasoningPayload } from './reasoning-inline'
import type {
  Message,
  MessageAttemptOwner,
  OpaqueReasoningCarrierV2,
  ReasoningDetail,
  ReasoningVisiblePartV2,
  SealedReasoningCarryForward,
} from './types'

export type OutboundReasoningRoute =
  | Readonly<{ kind: 'text'; contract: TextReasoningContract }>
  | Readonly<{ kind: 'chat'; contract: ChatReasoningContract }>
  | Readonly<{ kind: 'responses'; contract: ResponsesReasoningContract }>
  | Readonly<{ kind: 'anthropic'; contract: AnthropicReasoningContract }>
  | Readonly<{ kind: 'gemini'; contract: GeminiReasoningContract }>

export interface CompiledReasoningAttempt<Unit> {
  readonly owner: MessageAttemptOwner
  readonly units: readonly Unit[]
  readonly reportedReasoningTokens?: number
}

export interface CompiledResponsesReasoningUnit {
  readonly providerItemId?: string
  readonly encryptedContent?: string
  readonly summaries: readonly Readonly<{ index: number; text: string }>[]
}

export type CompiledAnthropicReasoningUnit =
  | Readonly<{ kind: 'thinking-authenticated'; text: string; signature: string }>
  | Readonly<{ kind: 'redacted-thinking'; data: string }>

export type CompiledGeminiReasoningUnit =
  | Readonly<{ kind: 'bound-thought'; text: string; signature: string }>
  | Readonly<{ kind: 'visible-thought'; text: string }>
  | Readonly<{ kind: 'unbound-signature'; signature: string }>

interface OutboundReasoningCompilationBase<Kind extends OutboundReasoningRoute['kind'], Unit> {
  readonly kind: Kind
  readonly attempts: readonly CompiledReasoningAttempt<Unit>[]
  readonly inline: string | null
  readonly reasoningCarryForward: SealedReasoningCarryForward
}

export type TextReasoningCompilation = OutboundReasoningCompilationBase<'text', never>
export type ChatReasoningCompilation = OutboundReasoningCompilationBase<'chat', ReasoningDetail>
export type ResponsesReasoningCompilation = OutboundReasoningCompilationBase<
  'responses',
  CompiledResponsesReasoningUnit
>
export type AnthropicReasoningCompilation = OutboundReasoningCompilationBase<
  'anthropic',
  CompiledAnthropicReasoningUnit
>
export type GeminiReasoningCompilation = OutboundReasoningCompilationBase<
  'gemini',
  CompiledGeminiReasoningUnit
>

export type OutboundReasoningCompilation =
  | TextReasoningCompilation
  | ChatReasoningCompilation
  | ResponsesReasoningCompilation
  | AnthropicReasoningCompilation
  | GeminiReasoningCompilation

export interface OutboundReasoningResolver {
  readonly route: OutboundReasoningRoute
  readonly routeKey: string
  compilationFor(message: Message): OutboundReasoningCompilation
}

export interface OutboundReasoningCompiler extends OutboundReasoningResolver {
  retain(messages: readonly Message[]): OutboundReasoningResolver
}

interface AttemptCompilationState<Unit> {
  readonly owner: MessageAttemptOwner
  readonly units: Unit[]
  readonly inlineParts: string[]
  reasoningCarryForward: SealedReasoningCarryForward
}

export function outboundReasoningRouteForAssistantRoute(
  route: AssistantRouteContract,
): OutboundReasoningRoute {
  switch (route.transport) {
    case 'openai-text':
    case 'openrouter-video':
      return Object.freeze({ kind: 'text', contract: route.reasoning })
    case 'openai-chat':
      return Object.freeze({ kind: 'chat', contract: route.reasoning })
    case 'openai-responses':
      return Object.freeze({ kind: 'responses', contract: route.reasoning })
    case 'anthropic':
      return Object.freeze({ kind: 'anthropic', contract: route.reasoning })
    case 'gemini-native':
      return Object.freeze({ kind: 'gemini', contract: route.reasoning })
  }
}

export function outboundReasoningRouteForReplayContract(
  contract: ReasoningReplayContract,
): OutboundReasoningRoute {
  switch (contract.carrier) {
    case 'plaintext-only':
      return Object.freeze({ kind: 'text', contract: contract as TextReasoningContract })
    case 'openrouter-reasoning-details':
      return Object.freeze({ kind: 'chat', contract: contract as ChatReasoningContract })
    case 'responses-items':
      return Object.freeze({
        kind: 'responses',
        contract: contract as ResponsesReasoningContract,
      })
    case 'anthropic-blocks':
      return Object.freeze({
        kind: 'anthropic',
        contract: contract as AnthropicReasoningContract,
      })
    case 'gemini-parts':
      return Object.freeze({ kind: 'gemini', contract: contract as GeminiReasoningContract })
  }
}

export function createOutboundReasoningCompiler(
  route: OutboundReasoningRoute,
): OutboundReasoningCompiler {
  const routeKey = outboundReasoningRouteKey(route)
  const candidates = new Map<Message, OutboundReasoningCompilation>()
  const compilationFor = (message: Message): OutboundReasoningCompilation => {
    if (message.role !== 'assistant') throw new Error(`ReasoningCompilerNonAssistant:${message.id}`)
    const retained = candidates.get(message)
    if (retained) return retained
    const compiled = compileAppliedMessageReasoning(createAppliedMessageView(message), route)
    candidates.set(message, compiled)
    return compiled
  }
  return Object.freeze({
    route,
    routeKey,
    compilationFor,
    retain(messages: readonly Message[]): OutboundReasoningResolver {
      const selected = new Map<
        Message['id'],
        Readonly<{
          compilation: OutboundReasoningCompilation
          reasoningEnvelope: Message['reasoningEnvelope']
          continuationAttempts: Message['continuationAttempts']
        }>
      >()
      for (const message of messages) {
        if (message.role !== 'assistant' || message.deleted || message.hiddenFromContext) continue
        selected.set(message.id, {
          compilation: compilationFor(message),
          reasoningEnvelope: message.reasoningEnvelope,
          continuationAttempts: message.continuationAttempts,
        })
      }
      candidates.clear()
      return Object.freeze({
        route,
        routeKey,
        compilationFor(message: Message): OutboundReasoningCompilation {
          if (message.role !== 'assistant') {
            throw new Error(`ReasoningSnapshotNonAssistant:${message.id}`)
          }
          const selectedMessage = selected.get(message.id)
          if (!selectedMessage) throw new Error(`ReasoningSnapshotMessageMissing:${message.id}`)
          if (
            selectedMessage.reasoningEnvelope !== message.reasoningEnvelope ||
            selectedMessage.continuationAttempts !== message.continuationAttempts
          ) {
            throw new Error(`ReasoningSnapshotSemanticMismatch:${message.id}`)
          }
          return selectedMessage.compilation
        },
      })
    },
  })
}

export function assertOutboundReasoningResolverRoute(
  resolver: OutboundReasoningResolver,
  route: OutboundReasoningRoute,
): void {
  const expected = outboundReasoningRouteKey(route)
  if (resolver.routeKey !== expected) {
    throw new Error(`OutboundReasoningRouteMismatch:${expected}:${resolver.routeKey}`)
  }
}

export function resolveOutboundReasoningResolver(
  route: OutboundReasoningRoute,
  resolver?: OutboundReasoningResolver,
): OutboundReasoningResolver {
  const resolved = resolver ?? createOutboundReasoningCompiler(route)
  assertOutboundReasoningResolverRoute(resolved, route)
  return resolved
}

function outboundReasoningRouteKey(route: OutboundReasoningRoute): string {
  const contract = route.contract
  return [
    route.kind,
    contract.carrier,
    contract.targetFormat ?? '',
    contract.producerBridge,
    Number(contract.include.encrypted),
    Number(contract.include.summary),
    Number(contract.include.text),
    Number(contract.echoAsThinkTags),
    Number(contract.acceptsAnthropicRedactedThinking),
  ].join('\u0000')
}

export function compileAppliedMessageReasoning(
  view: AppliedMessageView,
  route: Extract<OutboundReasoningRoute, { kind: 'text' }>,
): TextReasoningCompilation
export function compileAppliedMessageReasoning(
  view: AppliedMessageView,
  route: Extract<OutboundReasoningRoute, { kind: 'chat' }>,
): ChatReasoningCompilation
export function compileAppliedMessageReasoning(
  view: AppliedMessageView,
  route: Extract<OutboundReasoningRoute, { kind: 'responses' }>,
): ResponsesReasoningCompilation
export function compileAppliedMessageReasoning(
  view: AppliedMessageView,
  route: Extract<OutboundReasoningRoute, { kind: 'anthropic' }>,
): AnthropicReasoningCompilation
export function compileAppliedMessageReasoning(
  view: AppliedMessageView,
  route: Extract<OutboundReasoningRoute, { kind: 'gemini' }>,
): GeminiReasoningCompilation
export function compileAppliedMessageReasoning(
  view: AppliedMessageView,
  route: OutboundReasoningRoute,
): OutboundReasoningCompilation
export function compileAppliedMessageReasoning(
  view: AppliedMessageView,
  route: OutboundReasoningRoute,
): OutboundReasoningCompilation {
  const attempts: CompiledReasoningAttempt<unknown>[] = []
  const inlineParts: string[] = []
  let reasoningCarryForward: SealedReasoningCarryForward = 'none'
  for (const attempt of view.attempts) {
    const state = compileAttempt(attempt, route)
    if (state.units.length > 0) {
      const reportedReasoningTokens =
        attempt.metadata?.usage?.completion_tokens_details?.reasoning_tokens
      attempts.push({
        owner: attempt.owner,
        units: state.units,
        ...(reportedReasoningTokens !== undefined ? { reportedReasoningTokens } : {}),
      })
    }
    inlineParts.push(...state.inlineParts)
    reasoningCarryForward = mergeSealedReasoningCarryForward(
      reasoningCarryForward,
      state.reasoningCarryForward,
    )
  }
  const inline = renderInlineReasoning(inlineParts)
  if (inline !== null) {
    reasoningCarryForward = mergeSealedReasoningCarryForward(reasoningCarryForward, 'visible-only')
  }
  const common = {
    attempts,
    inline,
    reasoningCarryForward,
  }
  switch (route.kind) {
    case 'text':
      return { kind: 'text', ...common, attempts: [] }
    case 'chat':
      return { kind: 'chat', ...common } as ChatReasoningCompilation
    case 'responses':
      return { kind: 'responses', ...common } as ResponsesReasoningCompilation
    case 'anthropic':
      return { kind: 'anthropic', ...common } as AnthropicReasoningCompilation
    case 'gemini':
      return { kind: 'gemini', ...common } as GeminiReasoningCompilation
  }
}

function compileAttempt(
  attempt: AppliedMessageAttempt,
  route: OutboundReasoningRoute,
): AttemptCompilationState<unknown> {
  const state: AttemptCompilationState<unknown> = {
    owner: attempt.owner,
    units: [],
    inlineParts: [],
    reasoningCarryForward: 'none',
  }
  const envelope = attempt.reasoningEnvelope
  if (!envelope) return state
  const analysis = analyzeReasoningEnvelopeReplayTopology(envelope)
  const consumedVisibleIds = new Set<string>()
  for (const carrier of envelope.carriers) {
    if (carrier.kind === 'anthropic-signature') {
      consumedVisibleIds.add(carrier.bindsVisiblePartId)
    }
    const topologyOmission = reasoningCarrierTopologyOmission(carrier, analysis)
    if (topologyOmission !== null) continue
    const decision = reasoningCarrierReplayDecision(
      reasoningCarrierReplayFact(carrier, analysis.visibleById),
      route.contract,
    )
    if (decision.kind === 'omit') continue
    emitCarrier(state, route, carrier, analysis, consumedVisibleIds)
  }

  for (const part of envelope.visible) {
    if (
      part.hidden === true ||
      part.text.length === 0 ||
      consumedVisibleIds.has(part.id) ||
      analysis.ambiguousVisiblePartIds.has(part.id)
    ) {
      continue
    }
    if (part.kind === 'summary' ? !route.contract.include.summary : !route.contract.include.text) {
      continue
    }
    emitVisible(state, route, part)
  }
  if (route.kind === 'responses') finalizeResponsesGroups(state)
  return state
}

function emitCarrier(
  state: AttemptCompilationState<unknown>,
  route: OutboundReasoningRoute,
  carrier: OpaqueReasoningCarrierV2,
  analysis: ReasoningEnvelopeReplayTopology,
  consumedVisibleIds: Set<string>,
): void {
  if (carrier.kind === 'anthropic-signature') {
    const visible = analysis.visibleById.get(carrier.bindsVisiblePartId)
    if (!visible || visible.hidden === true || visible.text.length === 0) return
    if (route.kind === 'anthropic') {
      state.units.push({
        kind: 'thinking-authenticated',
        text: visible.text,
        signature: carrier.signature,
      } satisfies CompiledAnthropicReasoningUnit)
    } else if (route.kind === 'chat') {
      state.units.push({
        type: 'reasoning.text',
        format: carrier.format,
        text: visible.text,
        signature: carrier.signature,
        ...reasoningWireMetadata(visible),
      } satisfies ReasoningDetail)
    } else {
      return
    }
    consumedVisibleIds.add(visible.id)
    state.reasoningCarryForward = 'carrier'
    return
  }
  if (carrier.kind === 'gemini-thought-signature') {
    if (route.kind === 'gemini') {
      const candidates = carrier.bindsVisiblePartId
        ? [analysis.visibleById.get(carrier.bindsVisiblePartId)].filter(
            (part): part is ReasoningVisiblePartV2 => Boolean(part),
          )
        : (analysis.visibleByGroup.get(carrier.groupId) ?? [])
      const eligible = candidates.filter(
        (part) => part.hidden !== true && part.text.length > 0 && !consumedVisibleIds.has(part.id),
      )
      const visible = eligible[0]
      if (carrier.bindsVisiblePartId && !visible) return
      if (visible) {
        state.units.push({
          kind: 'bound-thought',
          text: visible.text,
          signature: carrier.data,
        } satisfies CompiledGeminiReasoningUnit)
        consumedVisibleIds.add(visible.id)
      } else {
        state.units.push({
          kind: 'unbound-signature',
          signature: carrier.data,
        } satisfies CompiledGeminiReasoningUnit)
      }
      state.reasoningCarryForward = 'carrier'
      return
    }
    if (route.kind === 'chat') {
      state.units.push({
        type: 'reasoning.encrypted',
        format: carrier.format,
        data: carrier.data,
        ...carrierWireMetadata(carrier),
      } satisfies ReasoningDetail)
      state.reasoningCarryForward = 'carrier'
      if (carrier.bindsVisiblePartId) {
        const visible = analysis.visibleById.get(carrier.bindsVisiblePartId)
        if (visible && visible.hidden !== true && visible.text.length > 0) {
          state.units.push(visiblePartToDetail(visible))
          consumedVisibleIds.add(visible.id)
        }
      }
    }
    return
  }
  if (carrier.kind === 'responses-encrypted') {
    if (route.kind === 'responses') {
      state.units.push({
        kind: 'responses-candidate',
        key: responsesGroupKey(carrier.source, carrier.id),
        ...(carrier.source.itemId ? { providerItemId: carrier.source.itemId } : {}),
        encryptedContent: carrier.data,
        summaries: [],
      } satisfies ResponsesCandidate)
    } else if (route.kind === 'chat') {
      state.units.push({
        type: 'reasoning.encrypted',
        format: carrier.format,
        data: carrier.data,
        ...carrierWireMetadata(carrier),
      } satisfies ReasoningDetail)
    } else {
      return
    }
    state.reasoningCarryForward = 'carrier'
    return
  }
  if (carrier.kind === 'anthropic-redacted') {
    if (route.kind === 'anthropic') {
      state.units.push({
        kind: 'redacted-thinking',
        data: carrier.data,
      } satisfies CompiledAnthropicReasoningUnit)
    } else if (route.kind === 'chat') {
      state.units.push({
        type: 'reasoning.encrypted',
        format: carrier.format,
        data: carrier.data,
        ...carrierWireMetadata(carrier),
      } satisfies ReasoningDetail)
    } else {
      return
    }
    state.reasoningCarryForward = 'carrier'
  }
}

function emitVisible(
  state: AttemptCompilationState<unknown>,
  route: OutboundReasoningRoute,
  part: ReasoningVisiblePartV2,
): void {
  if (route.kind === 'chat') {
    if (
      route.contract.carrier === 'openrouter-reasoning-details' &&
      route.contract.targetFormat !== null &&
      !route.contract.echoAsThinkTags
    ) {
      state.units.push(visiblePartToDetail(part))
      state.reasoningCarryForward = mergeSealedReasoningCarryForward(
        state.reasoningCarryForward,
        'visible-only',
      )
    } else {
      appendInlinePart(state.inlineParts, part)
    }
    return
  }
  if (route.kind === 'responses') {
    if (part.kind === 'summary') {
      state.units.push({
        kind: 'responses-candidate',
        key: responsesGroupKey(part.source, part.id),
        ...(part.source.itemId ? { providerItemId: part.source.itemId } : {}),
        summaries: [
          { index: part.source.summaryIndex ?? part.source.detailIndex ?? 0, text: part.text },
        ],
      } satisfies ResponsesCandidate)
      state.reasoningCarryForward = mergeSealedReasoningCarryForward(
        state.reasoningCarryForward,
        'visible-only',
      )
    } else {
      appendInlinePart(state.inlineParts, part)
    }
    return
  }
  if (route.kind === 'gemini') {
    state.units.push({
      kind: 'visible-thought',
      text: part.text,
    } satisfies CompiledGeminiReasoningUnit)
    state.reasoningCarryForward = mergeSealedReasoningCarryForward(
      state.reasoningCarryForward,
      'visible-only',
    )
    return
  }
  appendInlinePart(state.inlineParts, part)
}

interface ResponsesCandidate {
  readonly kind: 'responses-candidate'
  readonly key: string
  readonly providerItemId?: string
  readonly encryptedContent?: string
  readonly summaries: readonly Readonly<{ index: number; text: string }>[]
}

function finalizeResponsesGroups(state: AttemptCompilationState<unknown>): void {
  const groups = new Map<
    string,
    {
      providerItemId?: string
      encryptedContent?: string
      summaries: Array<{ index: number; text: string }>
    }
  >()
  const order: string[] = []
  for (const raw of state.units) {
    const candidate = raw as ResponsesCandidate
    let group = groups.get(candidate.key)
    if (!group) {
      group = { summaries: [] }
      groups.set(candidate.key, group)
      order.push(candidate.key)
    }
    if (candidate.providerItemId) group.providerItemId ??= candidate.providerItemId
    if (candidate.encryptedContent !== undefined) {
      group.encryptedContent ??= candidate.encryptedContent
    }
    group.summaries.push(...candidate.summaries)
  }
  state.units.length = 0
  state.reasoningCarryForward = 'none'
  for (const key of order) {
    const group = groups.get(key)
    if (!group) continue
    group.summaries.sort((left, right) => left.index - right.index)
    const encryptedContent = group.encryptedContent
    if (encryptedContent === undefined && group.summaries.length === 0) continue
    state.units.push({
      ...(encryptedContent !== undefined && group.providerItemId
        ? { providerItemId: group.providerItemId }
        : {}),
      ...(encryptedContent !== undefined ? { encryptedContent } : {}),
      summaries: group.summaries,
    } satisfies CompiledResponsesReasoningUnit)
    if (encryptedContent !== undefined) state.reasoningCarryForward = 'carrier'
    else if (group.summaries.length > 0) {
      state.reasoningCarryForward = mergeSealedReasoningCarryForward(
        state.reasoningCarryForward,
        'visible-only',
      )
    }
  }
}

function appendInlinePart(parts: string[], part: ReasoningVisiblePartV2): void {
  const normalized = normalizeInlineReasoningPayload(part.text)
  if (normalized.length === 0) return
  parts.push(part.kind === 'summary' ? `Summary: ${normalized}` : normalized)
}

function renderInlineReasoning(parts: readonly string[]): string | null {
  if (parts.length === 0) return null
  return `<think>\n${parts.join('\n\n')}\n</think>`
}

function visiblePartToDetail(part: ReasoningVisiblePartV2): ReasoningDetail {
  const metadata = reasoningWireMetadata(part)
  return part.kind === 'summary'
    ? { type: 'reasoning.summary', format: part.format, summary: part.text, ...metadata }
    : { type: 'reasoning.text', format: part.format, text: part.text, ...metadata }
}

function reasoningWireMetadata(
  part: ReasoningVisiblePartV2,
): Pick<
  ReasoningDetail,
  'id' | 'index' | 'providerItemId' | 'providerOutputIndex' | 'providerSummaryIndex'
> {
  return {
    id: part.source.detailId ?? part.id,
    ...(part.source.detailIndex !== undefined ? { index: part.source.detailIndex } : {}),
    ...(part.source.itemId !== undefined ? { providerItemId: part.source.itemId } : {}),
    ...(part.source.outputIndex !== undefined
      ? { providerOutputIndex: part.source.outputIndex }
      : {}),
    ...(part.source.summaryIndex !== undefined
      ? { providerSummaryIndex: part.source.summaryIndex }
      : {}),
  }
}

function carrierWireMetadata(
  carrier: OpaqueReasoningCarrierV2,
): Pick<
  ReasoningDetail,
  'id' | 'index' | 'providerItemId' | 'providerOutputIndex' | 'providerSummaryIndex'
> {
  return {
    id: carrier.source.detailId ?? carrier.id,
    ...(carrier.source.detailIndex !== undefined ? { index: carrier.source.detailIndex } : {}),
    ...(carrier.source.itemId !== undefined ? { providerItemId: carrier.source.itemId } : {}),
    ...(carrier.source.outputIndex !== undefined
      ? { providerOutputIndex: carrier.source.outputIndex }
      : {}),
    ...(carrier.source.summaryIndex !== undefined
      ? { providerSummaryIndex: carrier.source.summaryIndex }
      : {}),
  }
}

function responsesGroupKey(source: ReasoningVisiblePartV2['source'], fallback: string): string {
  if (source.itemId) return `id:${source.itemId}`
  const outputIndex = source.outputIndex ?? source.detailIndex
  return outputIndex !== undefined ? `output:${outputIndex}` : `detail:${fallback}`
}

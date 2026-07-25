import type {
  ChatSettings,
  InboundReasoningVisibility,
  KnownReasoningFormat,
  Message,
  OpaqueReasoningCarrierV2,
  PersistedInboundReasoningVisibility,
  PersistedReasoningCarryForward,
  ProviderOutputItem,
  ReasoningCarryForwardEvidence,
  ReasoningEnvelopeV2,
  ReasoningFormat,
  ReasoningInclude,
  ReasoningOriginDialect,
  ReasoningProducerBridge,
  ReasoningSettings,
  ReasoningVisibleKind,
  SealedReasoningCarryForward,
} from './types'

export type { InboundReasoningVisibility } from './types'

import { type AppliedMessageView, createAppliedMessageView } from './continuation-content'

type ReasoningSettingsInput = Omit<Partial<ReasoningSettings>, 'include'> & {
  include?: Partial<ReasoningInclude> | null
}

export interface ReasoningPolicy {
  readonly include: Readonly<ReasoningInclude>
  readonly echoAsThinkTags: boolean
  readonly acceptsAnthropicRedactedThinking: boolean
}

export type ReasoningVisibilityPolicy =
  | Readonly<{ kind: 'uniform'; visibleKind: ReasoningVisibleKind }>
  | Readonly<{
      kind: 'hidden-on-chat'
      otherwise: ReasoningVisibleKind
    }>
  | Readonly<{
      kind: 'anthropic-summary'
      directDefault: 'summarized' | 'omitted'
    }>

export type ReasoningCarrier =
  | 'plaintext-only'
  | 'openrouter-reasoning-details'
  | 'responses-items'
  | 'anthropic-blocks'
  | 'gemini-parts'

export interface ReasoningReplayContract<
  TargetFormat extends KnownReasoningFormat | null = KnownReasoningFormat | null,
  Carrier extends ReasoningCarrier = ReasoningCarrier,
> extends ReasoningPolicy {
  readonly targetFormat: TargetFormat
  readonly carrier: Carrier
  readonly producerBridge: ReasoningProducerBridge
}

export interface RoutedReasoningContract<
  TargetFormat extends KnownReasoningFormat | null = KnownReasoningFormat | null,
  Carrier extends ReasoningCarrier = ReasoningCarrier,
  OriginDialect extends ReasoningOriginDialect = ReasoningOriginDialect,
> extends ReasoningReplayContract<TargetFormat, Carrier> {
  readonly originDialect: OriginDialect
  readonly visibilityPolicy: ReasoningVisibilityPolicy
}

export interface AttemptReasoningContract<
  TargetFormat extends KnownReasoningFormat | null = KnownReasoningFormat | null,
  Carrier extends ReasoningCarrier = ReasoningCarrier,
  OriginDialect extends ReasoningOriginDialect = ReasoningOriginDialect,
> extends RoutedReasoningContract<TargetFormat, Carrier, OriginDialect> {
  readonly inboundVisibility: InboundReasoningVisibility
}

export type TextReasoningContract = ReasoningReplayContract<null, 'plaintext-only'>
export type ChatReasoningContract = ReasoningReplayContract<
  KnownReasoningFormat | null,
  'plaintext-only' | 'openrouter-reasoning-details'
>
export type ResponsesReasoningContract = ReasoningReplayContract<
  'openai-responses-v1' | 'azure-openai-responses-v1' | 'xai-responses-v1',
  'responses-items'
>
export type AnthropicReasoningContract = ReasoningReplayContract<
  'anthropic-claude-v1',
  'anthropic-blocks'
>
export type GeminiReasoningContract = ReasoningReplayContract<'google-gemini-v1', 'gemini-parts'>

export type AttemptTextReasoningContract = AttemptReasoningContract<
  null,
  'plaintext-only',
  'inline'
>
export type AttemptChatReasoningContract =
  | AttemptReasoningContract<KnownReasoningFormat | null, 'plaintext-only', 'openai-chat'>
  | AttemptReasoningContract<
      KnownReasoningFormat | null,
      'openrouter-reasoning-details',
      'openrouter-chat'
    >
export type AttemptResponsesReasoningContract = AttemptReasoningContract<
  'openai-responses-v1' | 'azure-openai-responses-v1' | 'xai-responses-v1',
  'responses-items',
  'openai-responses' | 'openrouter-responses'
>
export type AttemptAnthropicReasoningContract = AttemptReasoningContract<
  'anthropic-claude-v1',
  'anthropic-blocks',
  'anthropic-messages'
>
export type AttemptGeminiReasoningContract = AttemptReasoningContract<
  'google-gemini-v1',
  'gemini-parts',
  'gemini-native'
>

export const UNKNOWN_INBOUND_REASONING_VISIBILITY = Object.freeze({
  disclosure: 'unknown',
} as const)

export function isInboundReasoningVisibility(value: unknown): value is InboundReasoningVisibility {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const visibility = value as Record<string, unknown>
  if (visibility.disclosure === 'visible') {
    return visibility.visibleKind === 'text' || visibility.visibleKind === 'summary'
  }
  return (
    visibility.disclosure === 'absent' &&
    (visibility.unexpectedVisibleKind === 'text' ||
      visibility.unexpectedVisibleKind === 'summary') &&
    (visibility.reason === 'api-mode' ||
      visibility.reason === 'request-display' ||
      visibility.reason === 'provider-default' ||
      visibility.reason === 'disabled')
  )
}

export function isPersistedInboundReasoningVisibility(
  value: unknown,
): value is PersistedInboundReasoningVisibility {
  return (
    isInboundReasoningVisibility(value) ||
    (value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { disclosure?: unknown }).disclosure === 'unknown')
  )
}

export function messageReasoningVisibility(
  view: AppliedMessageView,
): PersistedInboundReasoningVisibility {
  return view.latestAttempt.reasoningVisibility
}

const REASONING_FORMATS: ReadonlySet<ReasoningFormat> = new Set([
  'unknown',
  'openai-responses-v1',
  'azure-openai-responses-v1',
  'xai-responses-v1',
  'anthropic-claude-v1',
  'google-gemini-v1',
])

export function isReasoningFormat(value: unknown): value is ReasoningFormat {
  return typeof value === 'string' && REASONING_FORMATS.has(value as ReasoningFormat)
}

export interface MessageContextRouteFacts {
  readonly reasoningCarriers: readonly ReasoningCarrierRouteFact[]
  readonly hasOpenAiResponsesProviderOutput: boolean
}

export interface ReasoningCarrierRouteFact {
  readonly kind: OpaqueReasoningCarrierV2['kind']
  readonly format: ReasoningFormat
  readonly originDialect: ReasoningOriginDialect
  readonly producerBridge: ReasoningProducerBridge
  readonly binding: 'not-required' | 'unbound' | 'resolved' | 'missing'
}

export interface ReasoningEnvelopeReplayTopology {
  readonly visibleById: ReadonlyMap<string, ReasoningEnvelopeV2['visible'][number]>
  readonly visibleByGroup: ReadonlyMap<string, readonly ReasoningEnvelopeV2['visible'][number][]>
  readonly duplicateCarrierIds: ReadonlySet<string>
  readonly ambiguousCarrierIds: ReadonlySet<string>
  readonly ambiguousVisiblePartIds: ReadonlySet<string>
}

export type ReasoningCarrierTopologyOmissionReason =
  | 'duplicate'
  | 'hidden'
  | 'empty-payload'
  | 'ambiguous-binding'

export const EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS: MessageContextRouteFacts = Object.freeze({
  reasoningCarriers: Object.freeze([]),
  hasOpenAiResponsesProviderOutput: false,
})

export function reasoningPolicyForSettings(
  settings: Pick<ChatSettings, 'reasoning'>,
  options: { acceptsAnthropicRedactedThinking?: boolean } = {},
): ReasoningPolicy {
  const reasoning = normalizeReasoningSettings(settings.reasoning)
  return Object.freeze({
    include: Object.freeze({ ...reasoning.include }),
    echoAsThinkTags: reasoning.echoAsThinkTags === true,
    acceptsAnthropicRedactedThinking: options.acceptsAnthropicRedactedThinking === true,
  })
}

export function sealAttemptReasoningContract<
  TargetFormat extends KnownReasoningFormat | null,
  Carrier extends ReasoningCarrier,
  OriginDialect extends ReasoningOriginDialect,
>(
  routed: RoutedReasoningContract<TargetFormat, Carrier, OriginDialect>,
  inboundVisibility: InboundReasoningVisibility,
): AttemptReasoningContract<TargetFormat, Carrier, OriginDialect> {
  return Object.freeze({
    ...routed,
    inboundVisibility,
  })
}

export function visibleKindForInboundReasoning(
  visibility: InboundReasoningVisibility,
): 'text' | 'summary' {
  return visibility.disclosure === 'visible'
    ? visibility.visibleKind
    : visibility.unexpectedVisibleKind
}

export function sealReasoningReplayContract(
  policy: ReasoningPolicy,
  targetFormat: ReasoningFormat | null | undefined,
  carrier: ReasoningCarrier,
  producerBridge: ReasoningProducerBridge,
): ReasoningReplayContract {
  return Object.freeze({
    ...policy,
    targetFormat:
      targetFormat === undefined || targetFormat === null || targetFormat === 'unknown'
        ? null
        : targetFormat,
    carrier,
    producerBridge,
  })
}

export type ReasoningVisibilityEvidence =
  | (Readonly<{
      kind: 'openai-family'
      dialect: 'openai-chat' | 'openrouter-chat' | 'openai-responses' | 'openrouter-responses'
    }> &
      (
        | Readonly<{
            activation: 'active'
            display: 'available' | 'request-omitted' | 'provider-default-omitted'
          }>
        | Readonly<{ activation: 'disabled' }>
        | Readonly<{ activation: 'excluded' }>
      ))
  | Readonly<{
      kind: 'anthropic'
      display: 'summarized' | 'omitted' | 'provider-default' | 'disabled'
    }>
  | Readonly<{
      kind: 'gemini'
      thoughts: 'included' | 'omitted'
      omittedReason: 'request-display' | 'provider-default' | 'disabled'
    }>
  | Readonly<{ kind: 'inline'; activation: 'active' | 'disabled' | 'excluded' }>
  | Readonly<{ kind: 'unavailable' }>

export function resolveAttemptInboundReasoningVisibility(
  policy: ReasoningVisibilityPolicy,
  evidence: ReasoningVisibilityEvidence,
): InboundReasoningVisibility {
  if (evidence.kind === 'inline') {
    if (evidence.activation === 'disabled') return absentReasoning('text', 'disabled')
    if (evidence.activation === 'excluded') return absentReasoning('text', 'request-display')
    return visibleReasoning('text')
  }
  if (evidence.kind === 'unavailable') return absentReasoning('text', 'api-mode')
  if (evidence.kind === 'gemini') {
    return evidence.thoughts === 'included'
      ? visibleReasoning('summary')
      : absentReasoning('summary', evidence.omittedReason)
  }
  if (evidence.kind === 'anthropic') {
    if (evidence.display === 'disabled') return absentReasoning('summary', 'disabled')
    if (evidence.display === 'summarized') return visibleReasoning('summary')
    if (evidence.display === 'omitted') {
      return absentReasoning('summary', 'request-display')
    }
    if (policy.kind === 'anthropic-summary' && policy.directDefault === 'omitted') {
      return absentReasoning('summary', 'provider-default')
    }
    return visibleReasoning(reasoningVisibleKindForPolicy(policy))
  }
  if (evidence.activation === 'disabled') {
    return absentReasoning(reasoningVisibleKindForPolicy(policy), 'disabled')
  }
  if (evidence.activation === 'excluded') {
    return absentReasoning(reasoningVisibleKindForPolicy(policy), 'request-display')
  }
  const expectedVisibleKind = reasoningVisibleKindForPolicy(policy)
  if (
    evidence.dialect === 'openai-chat' &&
    (policy.kind === 'hidden-on-chat' || expectedVisibleKind === 'summary')
  ) {
    return absentReasoning(expectedVisibleKind, 'api-mode')
  }
  if (expectedVisibleKind === 'summary' && evidence.display === 'request-omitted') {
    return absentReasoning(expectedVisibleKind, 'request-display')
  }
  if (expectedVisibleKind === 'summary' && evidence.display === 'provider-default-omitted') {
    return absentReasoning(expectedVisibleKind, 'provider-default')
  }
  return visibleReasoning(expectedVisibleKind)
}

function reasoningVisibleKindForPolicy(policy: ReasoningVisibilityPolicy): ReasoningVisibleKind {
  if (policy.kind === 'uniform') return policy.visibleKind
  if (policy.kind === 'hidden-on-chat') return policy.otherwise
  return 'summary'
}

function visibleReasoning(visibleKind: ReasoningVisibleKind): InboundReasoningVisibility {
  return Object.freeze({ disclosure: 'visible', visibleKind })
}

function absentReasoning(
  unexpectedVisibleKind: ReasoningVisibleKind,
  reason: Extract<InboundReasoningVisibility, { disclosure: 'absent' }>['reason'],
): InboundReasoningVisibility {
  return Object.freeze({ disclosure: 'absent', unexpectedVisibleKind, reason })
}

export function messageContextRouteFacts(input: {
  content: Message['content']
  generation?: Message['generation']
  reasoningEnvelope?: ReasoningEnvelopeV2
  providerOutputItems?: readonly ProviderOutputItem[]
  toolCalls?: Message['toolCalls']
  phase?: Message['phase']
  continuationAttempts?: Message['continuationAttempts']
}): MessageContextRouteFacts {
  return messageContextRouteFactsFromView(createAppliedMessageView(input))
}

export function messageContextRouteFactsFromView(
  view: AppliedMessageView,
): MessageContextRouteFacts {
  return collectMessageContextRouteFacts(view.attempts)
}

function collectMessageContextRouteFacts(
  inputs: Iterable<{
    reasoningEnvelope?: ReasoningEnvelopeV2
    providerOutputItems?: readonly ProviderOutputItem[]
  }>,
): MessageContextRouteFacts {
  const carriers = new Map<string, ReasoningCarrierRouteFact>()
  let hasOpenAiResponsesProviderOutput = false
  for (const input of inputs) {
    const envelope = input.reasoningEnvelope
    if (envelope) {
      const topology = analyzeReasoningEnvelopeReplayTopology(envelope)
      for (const carrier of envelope.carriers) {
        if (reasoningCarrierTopologyOmission(carrier, topology) !== null) continue
        const fact = Object.freeze(reasoningCarrierReplayFact(carrier, topology.visibleById))
        carriers.set(reasoningCarrierRouteFactKey(fact), fact)
      }
    }
    for (const item of input.providerOutputItems ?? []) {
      if (item.hidden !== true && item.dialect === 'openai-responses') {
        hasOpenAiResponsesProviderOutput = true
      }
    }
  }
  if (carriers.size === 0 && !hasOpenAiResponsesProviderOutput) {
    return EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS
  }
  return Object.freeze({
    reasoningCarriers: Object.freeze(
      [...carriers.values()].sort((left, right) =>
        reasoningCarrierRouteFactKey(left).localeCompare(reasoningCarrierRouteFactKey(right)),
      ),
    ),
    hasOpenAiResponsesProviderOutput,
  })
}

export function mergeMessageContextRouteFacts(
  values: readonly MessageContextRouteFacts[],
): MessageContextRouteFacts {
  if (values.length === 0) return EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS
  const carriers = new Map<string, ReasoningCarrierRouteFact>()
  let hasOpenAiResponsesProviderOutput = false
  for (const value of values) {
    for (const fact of value.reasoningCarriers) {
      carriers.set(reasoningCarrierRouteFactKey(fact), fact)
    }
    hasOpenAiResponsesProviderOutput ||= value.hasOpenAiResponsesProviderOutput
  }
  if (carriers.size === 0 && !hasOpenAiResponsesProviderOutput) {
    return EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS
  }
  return Object.freeze({
    reasoningCarriers: Object.freeze(
      [...carriers.values()].sort((left, right) =>
        reasoningCarrierRouteFactKey(left).localeCompare(reasoningCarrierRouteFactKey(right)),
      ),
    ),
    hasOpenAiResponsesProviderOutput,
  })
}

function reasoningCarrierRouteFactKey(fact: ReasoningCarrierRouteFact): string {
  return `${fact.kind}\u0000${fact.format}\u0000${fact.originDialect}\u0000${fact.producerBridge}\u0000${fact.binding}`
}

export function contextRouteFactsFromMessages(
  messages: readonly Pick<
    Message,
    | 'content'
    | 'generation'
    | 'reasoningEnvelope'
    | 'providerOutputItems'
    | 'toolCalls'
    | 'phase'
    | 'continuationAttempts'
  >[],
): MessageContextRouteFacts {
  return collectMessageContextRouteFacts(appliedAttemptsFromMessages(messages))
}

function* appliedAttemptsFromMessages(
  messages: Parameters<typeof contextRouteFactsFromMessages>[0],
) {
  for (const message of messages) {
    yield* createAppliedMessageView(message).attempts
  }
}

// Three-checkbox `ReasoningInclude` policy.
//
// Default policy:
//   - **`encrypted: true`** — round-trip the opaque carry-forward carrier for
//     whatever provider is being talked to. The filter treats `reasoning.text`
//     entries that carry a `.signature` (Anthropic) as encrypted-gated too.
//   - **`summary: false`** — don't echo the human-readable summary. The summary
//     is still REQUESTED (`settings.reasoning.summary = 'auto'`) so the UI
//     can display it, but the next turn doesn't need it in context.
//   - **`text: false`** — don't echo plaintext reasoning (DeepSeek/Qwen/Gemma
//     inline `<think>`, or OpenRouter's repackaged-Gemini summary which
//     arrives as a `reasoning.text` detail). Users flip this on to carry it.
//
// Per-provider inventory (verified via live probes Apr 2026):
//   - OpenAI Responses / Azure Responses / xAI: reasoning.encrypted + reasoning.summary
//   - Anthropic: reasoning.text w/ `.signature` (the text IS the carrier)
//   - Gemini native: reasoning.encrypted (thoughtSignature) + reasoning.summary (thought:true text)
//   - Gemini via OpenRouter: reasoning.encrypted + reasoning.text (OpenRouter repackages summary)
//   - DeepSeek/Qwen/Gemma: reasoning.text only (inline <think>)
export function defaultReasoningInclude(
  _preservationFormat: ReasoningFormat | undefined,
): ReasoningInclude {
  return { encrypted: true, summary: false, text: false }
}

// Defensive normalizer: ensure `ReasoningSettings` always has `mode`,
// `exclude`, and `include` present. Current callers sometimes replace the
// full reasoning object with a partial UI patch; normalize that boundary
// before readers assume the nested fields exist. Return the input verbatim
// when already well-formed so downstream memoization holds. Never mutates.
export function normalizeReasoningSettings(
  input: ReasoningSettingsInput | undefined,
): ReasoningSettings {
  if (!input) {
    return {
      mode: 'default',
      exclude: false,
      summary: 'auto',
      include: defaultReasoningInclude(undefined),
    }
  }
  const defaults = defaultReasoningInclude(undefined)
  const needsInclude =
    input.include === undefined ||
    input.include === null ||
    typeof input.include.encrypted !== 'boolean' ||
    typeof input.include.summary !== 'boolean' ||
    typeof input.include.text !== 'boolean'
  const needsMode = input.mode === undefined
  const needsExclude = input.exclude === undefined
  if (!needsInclude && !needsMode && !needsExclude) {
    return input as ReasoningSettings
  }
  const next: ReasoningSettings = {
    ...(input as ReasoningSettings),
    mode: input.mode ?? 'default',
    exclude: input.exclude ?? false,
    include: needsInclude
      ? {
          encrypted:
            typeof input.include?.encrypted === 'boolean'
              ? input.include.encrypted
              : defaults.encrypted,
          summary:
            typeof input.include?.summary === 'boolean' ? input.include.summary : defaults.summary,
          text: typeof input.include?.text === 'boolean' ? input.include.text : defaults.text,
        }
      : (input.include as ReasoningInclude),
  }
  return next
}

// OpenAI direct emits `openai-responses-v1`; OpenRouter's `/responses` proxy
// rewrites it to `azure-openai-responses-v1`. Both are accepted on either
// target. xAI Grok uses `xai-responses-v1`, which OpenAI and Azure reject due
// to its different upstream signing key, so it stays distinct.
const OPENAI_RESPONSES_FAMILY: ReadonlySet<ReasoningFormat> = new Set<ReasoningFormat>([
  'openai-responses-v1',
  'azure-openai-responses-v1',
])

export function isOpenAiResponsesFamilyFormat(
  fmt: ReasoningFormat | undefined,
): fmt is ReasoningFormat {
  return fmt !== undefined && OPENAI_RESPONSES_FAMILY.has(fmt)
}

function formatsCompatible(stored: ReasoningFormat, target: ReasoningFormat): boolean {
  if (stored === target) return true
  if (isOpenAiResponsesFamilyFormat(stored) && isOpenAiResponsesFamilyFormat(target)) return true
  return false
}

export function mergeSealedReasoningCarryForward(
  left: SealedReasoningCarryForward,
  right: SealedReasoningCarryForward,
): SealedReasoningCarryForward {
  if (left === 'carrier' || right === 'carrier') return 'carrier'
  if (left === 'visible-only' || right === 'visible-only') return 'visible-only'
  return 'none'
}

export function sealedReasoningCarryForwardEvidence(
  value: SealedReasoningCarryForward,
): ReasoningCarryForwardEvidence {
  return { certainty: 'sealed', value }
}

export function persistedReasoningCarryForwardFromEvidence(
  evidence: ReasoningCarryForwardEvidence,
): PersistedReasoningCarryForward {
  return evidence.certainty === 'sealed' ? evidence.value : 'unknown'
}

export function isPersistedReasoningCarryForward(
  value: unknown,
): value is PersistedReasoningCarryForward {
  return value === 'none' || value === 'visible-only' || value === 'carrier' || value === 'unknown'
}

export type ReasoningCarrierReplayOmissionReason =
  | 'encrypted-disabled'
  | 'target-format-absent'
  | 'format-incompatible'
  | 'producer-bridge-incompatible'
  | 'binding-missing'
  | 'carrier-unsupported'

export type ReasoningCarrierReplayDecision =
  | Readonly<{ kind: 'replay' }>
  | Readonly<{ kind: 'omit'; reason: ReasoningCarrierReplayOmissionReason }>

const REPLAY_REASONING_CARRIER = Object.freeze({ kind: 'replay' } as const)

export function reasoningCarrierReplayDecision(
  fact: ReasoningCarrierRouteFact,
  contract: ReasoningReplayContract,
): ReasoningCarrierReplayDecision {
  if (!contract.include.encrypted) return { kind: 'omit', reason: 'encrypted-disabled' }
  if (contract.targetFormat === null) return { kind: 'omit', reason: 'target-format-absent' }
  if (!formatsCompatible(fact.format, contract.targetFormat)) {
    return { kind: 'omit', reason: 'format-incompatible' }
  }
  if (!producerBridgeCanReplay(fact, contract.producerBridge)) {
    return { kind: 'omit', reason: 'producer-bridge-incompatible' }
  }
  if (fact.binding === 'missing') return { kind: 'omit', reason: 'binding-missing' }
  switch (contract.carrier) {
    case 'plaintext-only':
      return { kind: 'omit', reason: 'carrier-unsupported' }
    case 'responses-items':
      return fact.kind === 'responses-encrypted'
        ? REPLAY_REASONING_CARRIER
        : { kind: 'omit', reason: 'carrier-unsupported' }
    case 'anthropic-blocks':
      if (fact.kind === 'anthropic-signature') {
        return fact.binding === 'resolved'
          ? REPLAY_REASONING_CARRIER
          : { kind: 'omit', reason: 'binding-missing' }
      }
      return fact.kind === 'anthropic-redacted' && contract.acceptsAnthropicRedactedThinking
        ? REPLAY_REASONING_CARRIER
        : { kind: 'omit', reason: 'carrier-unsupported' }
    case 'gemini-parts':
      return fact.kind === 'gemini-thought-signature'
        ? REPLAY_REASONING_CARRIER
        : { kind: 'omit', reason: 'carrier-unsupported' }
    case 'openrouter-reasoning-details':
      switch (fact.kind) {
        case 'responses-encrypted':
        case 'gemini-thought-signature':
          return REPLAY_REASONING_CARRIER
        case 'anthropic-signature':
          return fact.binding === 'resolved'
            ? REPLAY_REASONING_CARRIER
            : { kind: 'omit', reason: 'binding-missing' }
        case 'anthropic-redacted':
          return contract.acceptsAnthropicRedactedThinking
            ? REPLAY_REASONING_CARRIER
            : { kind: 'omit', reason: 'carrier-unsupported' }
        case 'unknown':
          return { kind: 'omit', reason: 'carrier-unsupported' }
        default: {
          const unreachable: never = fact.kind
          return unreachable
        }
      }
    default: {
      const unreachable: never = contract.carrier
      return unreachable
    }
  }
}

function reasoningCarrierIsIndependentlyHidden(carrier: OpaqueReasoningCarrierV2): boolean {
  return carrier.kind !== 'anthropic-signature' && carrier.hidden === true
}

export function reasoningCarrierReplayFact(
  carrier: OpaqueReasoningCarrierV2,
  visibleById: ReadonlyMap<string, ReasoningEnvelopeV2['visible'][number]>,
): ReasoningCarrierRouteFact {
  return {
    kind: carrier.kind,
    format: carrier.format,
    originDialect: carrier.source.dialect,
    producerBridge: carrier.source.bridge,
    binding: reasoningCarrierBinding(carrier, visibleById),
  }
}

export function analyzeReasoningEnvelopeReplayTopology(
  envelope: ReasoningEnvelopeV2,
): ReasoningEnvelopeReplayTopology {
  const visibleById = new Map(envelope.visible.map((part) => [part.id, part] as const))
  const visibleByGroup = new Map<string, ReasoningEnvelopeV2['visible'][number][]>()
  for (const part of envelope.visible) {
    const group = visibleByGroup.get(part.groupId)
    if (group) group.push(part)
    else visibleByGroup.set(part.groupId, [part])
  }
  const duplicateCarrierIds = new Set<string>()
  const ambiguousCarrierIds = new Set<string>()
  const ambiguousVisiblePartIds = new Set<string>()
  const bindingGroups = new Map<string, OpaqueReasoningCarrierV2[]>()
  for (const carrier of envelope.carriers) {
    const key = carrierTopologyGroupKey(carrier)
    if (key === null) continue
    const group = bindingGroups.get(key)
    if (group) group.push(carrier)
    else bindingGroups.set(key, [carrier])
  }
  for (const [key, groupedCarriers] of bindingGroups) {
    const first = groupedCarriers[0]
    if (!first) continue
    if (
      first.kind === 'gemini-thought-signature' &&
      first.bindsVisiblePartId === undefined &&
      eligibleVisibleParts(visibleByGroup.get(first.groupId) ?? []).length > 1
    ) {
      for (const carrier of groupedCarriers) ambiguousCarrierIds.add(carrier.id)
      continue
    }
    if (groupedCarriers.length < 2) continue
    const firstIdentity = replayCarrierIdentity(first)
    if (groupedCarriers.every((carrier) => replayCarrierIdentity(carrier) === firstIdentity)) {
      for (const carrier of groupedCarriers.slice(1)) duplicateCarrierIds.add(carrier.id)
      continue
    }
    for (const carrier of groupedCarriers) ambiguousCarrierIds.add(carrier.id)
    if (key.startsWith('anthropic:') && first.kind === 'anthropic-signature') {
      ambiguousVisiblePartIds.add(first.bindsVisiblePartId)
    }
  }
  return {
    visibleById,
    visibleByGroup,
    duplicateCarrierIds,
    ambiguousCarrierIds,
    ambiguousVisiblePartIds,
  }
}

export function reasoningCarrierTopologyOmission(
  carrier: OpaqueReasoningCarrierV2,
  topology: ReasoningEnvelopeReplayTopology,
): ReasoningCarrierTopologyOmissionReason | null {
  if (topology.duplicateCarrierIds.has(carrier.id)) return 'duplicate'
  if (topology.ambiguousCarrierIds.has(carrier.id)) return 'ambiguous-binding'
  if (reasoningCarrierIsIndependentlyHidden(carrier)) return 'hidden'
  return reasoningCarrierPayload(carrier).length === 0 ? 'empty-payload' : null
}

function carrierTopologyGroupKey(carrier: OpaqueReasoningCarrierV2): string | null {
  if (carrier.kind === 'anthropic-signature') {
    return `anthropic:${carrier.bindsVisiblePartId}`
  }
  if (carrier.kind === 'gemini-thought-signature') {
    return `gemini:${carrier.bindsVisiblePartId ?? `group:${carrier.groupId}`}`
  }
  if (carrier.kind === 'responses-encrypted') {
    if (carrier.source.itemId) return `responses:item:${carrier.source.itemId}`
    const outputIndex = carrier.source.outputIndex ?? carrier.source.detailIndex
    return outputIndex === undefined ? null : `responses:output:${outputIndex}`
  }
  return null
}

function eligibleVisibleParts(
  parts: readonly ReasoningEnvelopeV2['visible'][number][],
): readonly ReasoningEnvelopeV2['visible'][number][] {
  return parts.filter((part) => part.hidden !== true && part.text.length > 0)
}

function replayCarrierIdentity(carrier: OpaqueReasoningCarrierV2): string {
  const binding =
    carrier.kind === 'anthropic-signature' || carrier.kind === 'gemini-thought-signature'
      ? (carrier.bindsVisiblePartId ?? '')
      : ''
  return [
    carrier.kind,
    carrier.format,
    carrier.groupId,
    carrier.source.dialect,
    carrier.source.bridge,
    binding,
    reasoningCarrierPayload(carrier),
  ].join('\u0000')
}

function reasoningCarrierPayload(carrier: OpaqueReasoningCarrierV2): string {
  return carrier.kind === 'anthropic-signature' ? carrier.signature : carrier.data
}

function producerBridgeCanReplay(
  fact: ReasoningCarrierRouteFact,
  target: ReasoningProducerBridge,
): boolean {
  if (
    fact.producerBridge === target &&
    (target === 'openrouter' ||
      target === 'openai-direct' ||
      target === 'anthropic-direct' ||
      target === 'google-direct')
  ) {
    return true
  }
  return (
    fact.producerBridge === 'google-direct' &&
    target === 'openrouter' &&
    fact.kind === 'gemini-thought-signature' &&
    fact.format === 'google-gemini-v1'
  )
}

function reasoningCarrierBinding(
  carrier: OpaqueReasoningCarrierV2,
  visibleById: ReadonlyMap<string, ReasoningEnvelopeV2['visible'][number]>,
): ReasoningCarrierRouteFact['binding'] {
  if (carrier.kind === 'anthropic-signature') {
    const visible = visibleById.get(carrier.bindsVisiblePartId)
    return visible && visible.hidden !== true && visible.text.length > 0 ? 'resolved' : 'missing'
  }
  if (carrier.kind === 'gemini-thought-signature') {
    if (carrier.bindsVisiblePartId === undefined) return 'unbound'
    const visible = visibleById.get(carrier.bindsVisiblePartId)
    return visible && visible.hidden !== true && visible.text.length > 0 ? 'resolved' : 'missing'
  }
  return 'not-required'
}

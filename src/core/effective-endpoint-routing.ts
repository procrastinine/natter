import { type AssistantRouteContract, resolveAssistantRouteContract } from './api-choice'
import {
  createEffectiveCapabilityAccumulator,
  type EffectiveCapability,
  effectiveCapabilityFromDescriptor,
} from './capabilities'
import { compatModelIdsMatch } from './model-ids'
import {
  hasHardPrivacyExclusion,
  type PrivacyFilterResult,
  type WireProviderPrivacy,
} from './privacy-filter'
import { ProviderEndpointIndex, providerEndpointKey, providerRoutingRef } from './provider-identity'
import { prefillClassFor, quirksFor, reasoningToggleableFor } from './quirks'
import type { MessageContextRouteFacts } from './reasoning'
import type {
  CapabilityDescriptor,
  ChatSettings,
  ConnectionProfile,
  EndpointPrefillCapability,
  EndpointsDescriptor,
  ModelEndpoint,
} from './types'

export interface PrefillRecommendation {
  readonly issues: readonly string[]
  readonly patch: Partial<ChatSettings>
}

export type PrefillPlan =
  | Readonly<{
      availability: 'unsupported'
      continueStrategy: 'prompt'
      request: 'reject'
      semanticRetry: 'never'
      serialization: Extract<EndpointPrefillCapability, { kind: 'unsupported' }>
      basis: 'configuration' | 'model-quirk' | 'transport' | 'endpoint-capability'
      reason: string
    }>
  | Readonly<{
      availability: 'supported' | 'warned-attempt'
      continueStrategy: 'prefill'
      request: 'send-once'
      semanticRetry: 'never'
      serialization: Exclude<EndpointPrefillCapability, { kind: 'unsupported' }>
      basis: 'transport' | 'endpoint-capability' | 'unknown-endpoint'
      warning?: string
      recommendation?: PrefillRecommendation
    }>

export type EndpointAvailability =
  | 'not-applicable'
  | 'available'
  | 'catalog-empty'
  | 'filtered-empty'

export interface EffectiveEndpointRouting {
  readonly route: AssistantRouteContract
  readonly requestCapability?: CapabilityDescriptor
  readonly capability: EffectiveCapability | null
  readonly catalogCapability: EffectiveCapability | null
  readonly selectedEndpoints: readonly ModelEndpoint[]
  readonly providerWire: WireProviderPrivacy | null
  readonly endpointAvailability: EndpointAvailability
  readonly prefillPlan: PrefillPlan
}

export const PREFILL_UNAVAILABLE_PLAN: PrefillPlan = Object.freeze({
  availability: 'unsupported',
  continueStrategy: 'prompt',
  request: 'reject',
  semanticRetry: 'never',
  serialization: Object.freeze({ kind: 'unsupported' as const }),
  basis: 'configuration',
  reason: 'A resolved connection and model are required for assistant prefill.',
})

export interface ResolveEffectiveEndpointRoutingInput {
  readonly profile: ConnectionProfile
  readonly settings: ChatSettings
  readonly contextFacts: MessageContextRouteFacts
  readonly capability?: CapabilityDescriptor
  readonly descriptor?: EndpointsDescriptor | null
  readonly filter?: PrivacyFilterResult | null
  readonly providerWire?: WireProviderPrivacy | null
  readonly workProbe?: EndpointRoutingWorkProbe
}

export interface EndpointRoutingWorkProbe {
  indexedEndpoint(endpoint: ModelEndpoint): void
  selectedEndpoint(endpoint: ModelEndpoint): void
}

const ROUTING_SOURCES = new WeakMap<
  EffectiveEndpointRouting,
  Readonly<{ profile: ConnectionProfile; settings: ChatSettings }>
>()

export function resolveEffectiveEndpointRouting(
  input: ResolveEffectiveEndpointRoutingInput,
): EffectiveEndpointRouting {
  const openRouter = input.profile.kind === 'openrouter' ? resolveOpenRouterEndpoints(input) : null
  const selectedEndpoints = openRouter?.selectedEndpoints ?? Object.freeze([] as ModelEndpoint[])
  const capability =
    input.profile.kind === 'openrouter'
      ? (openRouter?.capability ?? null)
      : input.capability
        ? effectiveCapabilityFromDescriptor(input.settings.model, input.capability)
        : null
  const catalogCapability = openRouter?.catalogCapability ?? capability
  const requestCapability =
    input.profile.kind === 'openrouter'
      ? capability
        ? requestCapabilityFromEffectiveOpenRouter(capability)
        : undefined
      : input.capability
  const providerWire = openRouter?.providerWire ?? input.providerWire ?? null
  const route = resolveAssistantRouteContract(
    input.profile,
    input.settings,
    input.contextFacts,
    capability ?? {
      quirks: quirksFor(input.settings.model),
      ...(requestCapability?.architecture?.outputModalities
        ? { outputModalities: new Set(requestCapability.architecture.outputModalities) }
        : {}),
    },
  )
  const routing = Object.freeze({
    route,
    ...(requestCapability ? { requestCapability } : {}),
    capability,
    catalogCapability,
    selectedEndpoints,
    providerWire,
    endpointAvailability: openRouter?.endpointAvailability ?? 'not-applicable',
    prefillPlan: prefillPlanForRoute(input.profile, input.settings, route, requestCapability),
  })
  ROUTING_SOURCES.set(routing, { profile: input.profile, settings: input.settings })
  return routing
}

export function rebaseEffectiveEndpointRouting(
  routing: EffectiveEndpointRouting,
  contextFacts: MessageContextRouteFacts,
): EffectiveEndpointRouting {
  const source = ROUTING_SOURCES.get(routing)
  if (!source) throw new Error('EffectiveEndpointRoutingSourceMissing')
  const { profile, settings } = source
  const route = resolveAssistantRouteContract(
    profile,
    settings,
    contextFacts,
    routing.capability ?? {
      quirks: quirksFor(settings.model),
      ...(routing.requestCapability?.architecture?.outputModalities
        ? { outputModalities: new Set(routing.requestCapability.architecture.outputModalities) }
        : {}),
    },
  )
  const rebased = Object.freeze({
    ...routing,
    route,
    prefillPlan: prefillPlanForRoute(profile, settings, route, routing.requestCapability),
  })
  ROUTING_SOURCES.set(rebased, source)
  return rebased
}

function resolveOpenRouterEndpoints(input: ResolveEffectiveEndpointRoutingInput): Readonly<{
  selectedEndpoints: readonly ModelEndpoint[]
  capability: EffectiveCapability | null
  catalogCapability: EffectiveCapability | null
  providerWire: WireProviderPrivacy
  endpointAvailability: Exclude<EndpointAvailability, 'not-applicable'>
}> {
  const endpoints =
    input.descriptor && compatModelIdsMatch(input.descriptor.modelId, input.settings.model)
      ? input.descriptor.endpoints
      : []
  if (endpoints.length === 0) {
    return Object.freeze({
      selectedEndpoints: Object.freeze([]),
      capability: null,
      catalogCapability: null,
      providerWire: canonicalOpenRouterWire(input.providerWire, [], [], false),
      endpointAvailability: 'catalog-empty',
    })
  }
  const endpointIndex = new ProviderEndpointIndex(endpoints, (endpoint) =>
    input.workProbe?.indexedEndpoint(endpoint),
  )
  const resolvedOnly = endpointIndex.resolveRoutingRefs(input.providerWire?.only, {
    preserveUnknown: true,
  })
  const resolvedIgnore = endpointIndex.resolveRoutingRefs(input.providerWire?.ignore, {
    preserveUnknown: true,
  })
  const resolvedOrder = endpointIndex.resolveRoutingRefs(input.providerWire?.order, {
    preserveUnknown: true,
  })
  const only = endpointIndex.endpointsForRefs(resolvedOnly)
  const ignore = endpointIndex.endpointsForRefs(resolvedIgnore)
  const hasOnly = (input.providerWire?.only?.length ?? 0) > 0
  const userOwnsSelection = input.settings.providerPrefs?.ignoreOverridesFilter === true
  const filterMatchesTarget =
    input.filter === null ||
    input.filter === undefined ||
    compatModelIdsMatch(input.filter.model, input.settings.model)
  const privacyKept = new Set(
    filterMatchesTarget
      ? (input.filter?.kept.map((row) => providerEndpointKey(row.endpoint)) ?? [])
      : [],
  )
  const hardDenied = new Set(
    filterMatchesTarget
      ? (input.filter?.excluded
          .filter((row) => hasHardPrivacyExclusion(row.reasons))
          .map((row) => providerEndpointKey(row.endpoint)) ?? [])
      : [],
  )
  const selected: ModelEndpoint[] = []
  const catalogAccumulator = createEffectiveCapabilityAccumulator(input.settings.model, {
    strict: input.settings.strictProviderRouting === true,
    ...(input.descriptor?.architecture ? { architecture: input.descriptor.architecture } : {}),
  })
  const accumulator = createEffectiveCapabilityAccumulator(input.settings.model, {
    strict: input.settings.strictProviderRouting === true,
    ...(input.descriptor?.architecture ? { architecture: input.descriptor.architecture } : {}),
  })
  for (const endpoint of endpoints) {
    catalogAccumulator.add(endpoint)
    if (input.filter && !filterMatchesTarget) continue
    const endpointKey = providerEndpointKey(endpoint)
    if (hardDenied.has(endpointKey)) continue
    if (!userOwnsSelection && input.filter && !privacyKept.has(endpointKey)) continue
    if (ignore.has(endpoint)) continue
    if (hasOnly && !only.has(endpoint)) continue
    selected.push(endpoint)
    input.workProbe?.selectedEndpoint(endpoint)
    accumulator.add(endpoint)
  }
  return Object.freeze({
    selectedEndpoints: Object.freeze(selected),
    capability: selected.length > 0 ? accumulator.finish() : null,
    catalogCapability: catalogAccumulator.finish(),
    providerWire: canonicalOpenRouterWire(
      input.providerWire,
      selected,
      endpoints.filter((endpoint) => hardDenied.has(providerEndpointKey(endpoint))),
      selected.length === 0,
      {
        only: resolvedOnly,
        ignore: resolvedIgnore,
        order: resolvedOrder,
      },
    ),
    endpointAvailability: selected.length === 0 ? 'filtered-empty' : 'available',
  })
}

function canonicalOpenRouterWire(
  wire: WireProviderPrivacy | null | undefined,
  selected: readonly ModelEndpoint[],
  hardDenied: readonly ModelEndpoint[],
  filteredEmpty: boolean,
  resolved: Readonly<{
    only?: readonly string[]
    ignore?: readonly string[]
    order?: readonly string[]
  }> = {},
): WireProviderPrivacy {
  const selectedRefs = new Set(selected.map(providerRoutingRef))
  const only = resolved.only?.filter((ref) => selectedRefs.has(ref))
  const order = resolved.order?.filter((ref) => selectedRefs.has(ref))
  const ignore = uniqueStrings([
    ...(resolved.ignore ?? wire?.ignore ?? []),
    ...hardDenied.map(providerRoutingRef),
  ])
  return Object.freeze({
    ...(ignore.length > 0 ? { ignore } : {}),
    ...(only && only.length > 0 ? { only } : {}),
    ...(order && order.length > 0 ? { order } : {}),
    ...(wire?.data_collection ? { data_collection: wire.data_collection } : {}),
    ...(wire?.zdr ? { zdr: wire.zdr } : {}),
    zeroEligible: filteredEmpty,
  })
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function requestCapabilityFromEffectiveOpenRouter(
  capability: EffectiveCapability,
): CapabilityDescriptor {
  const descriptor: CapabilityDescriptor = {
    supportedParameters: [...capability.supportedParameters],
    streaming: 'supported',
    architecture: {
      inputModalities: requestInputModalities(capability.inputModalities),
      outputModalities: requestOutputModalities(capability.outputModalities),
    },
  }
  if (capability.contextLength !== undefined) descriptor.contextLength = capability.contextLength
  if (capability.maxPromptTokens !== undefined) {
    descriptor.maxPromptTokens = capability.maxPromptTokens
  }
  if (capability.maxCompletionTokens !== undefined) {
    descriptor.maxCompletionTokens = capability.maxCompletionTokens
  }
  return descriptor
}

function requestInputModalities(
  modalities: ReadonlySet<string>,
): NonNullable<NonNullable<CapabilityDescriptor['architecture']>['inputModalities']> {
  const out: NonNullable<NonNullable<CapabilityDescriptor['architecture']>['inputModalities']> = []
  for (const modality of modalities) {
    if (
      modality === 'text' ||
      modality === 'image' ||
      modality === 'audio' ||
      modality === 'video' ||
      modality === 'file'
    ) {
      out.push(modality)
    }
  }
  return out.length > 0 ? out : ['text']
}

function requestOutputModalities(
  modalities: ReadonlySet<string>,
): NonNullable<NonNullable<CapabilityDescriptor['architecture']>['outputModalities']> {
  const out: NonNullable<NonNullable<CapabilityDescriptor['architecture']>['outputModalities']> = []
  for (const modality of modalities) {
    if (
      modality === 'text' ||
      modality === 'image' ||
      modality === 'audio' ||
      modality === 'video'
    ) {
      out.push(modality)
    }
  }
  return out.length > 0 ? out : ['text']
}

function prefillPlanForRoute(
  profile: ConnectionProfile,
  settings: ChatSettings,
  route: AssistantRouteContract,
  capability: CapabilityDescriptor | undefined,
): PrefillPlan {
  const modelClass = settings.model ? prefillClassFor(settings.model) : 'unsupported'
  if (modelClass === 'unsupported') {
    return unsupportedPrefillPlan(
      'model-quirk',
      'The selected model does not support assistant prefill.',
    )
  }
  const resolved = prefillSerializationForRoute(profile, route, capability)
  if (!resolved) {
    const recommendation = prefillRecommendation(settings, modelClass)
    return Object.freeze({
      availability: 'warned-attempt',
      continueStrategy: 'prefill',
      request: 'send-once',
      semanticRetry: 'never',
      serialization: Object.freeze({ kind: 'assistant-tail' as const, marker: 'none' as const }),
      basis: 'unknown-endpoint',
      warning:
        'This endpoint does not advertise prefill support; the request will be attempted once.',
      ...(recommendation ? { recommendation } : {}),
    })
  }
  if (resolved.capability.kind === 'unsupported') {
    return unsupportedPrefillPlan(
      resolved.basis,
      'The selected API route does not support assistant prefill.',
    )
  }
  const recommendation = prefillRecommendation(settings, modelClass)
  return Object.freeze({
    availability: 'supported',
    continueStrategy: 'prefill',
    request: 'send-once',
    semanticRetry: 'never',
    serialization: resolved.capability,
    basis: resolved.basis,
    ...(recommendation ? { recommendation } : {}),
  })
}

function unsupportedPrefillPlan(
  basis: Extract<PrefillPlan, { availability: 'unsupported' }>['basis'],
  reason: string,
): PrefillPlan {
  return Object.freeze({
    availability: 'unsupported',
    continueStrategy: 'prompt',
    request: 'reject',
    semanticRetry: 'never',
    serialization: Object.freeze({ kind: 'unsupported' as const }),
    basis,
    reason,
  })
}

function prefillSerializationForRoute(
  profile: ConnectionProfile,
  route: AssistantRouteContract,
  capability: CapabilityDescriptor | undefined,
): Readonly<{
  capability: EndpointPrefillCapability
  basis: 'transport' | 'endpoint-capability'
}> | null {
  if (capability?.prefill?.kind === 'unsupported') {
    return { capability: capability.prefill, basis: 'endpoint-capability' }
  }
  if (route.transport === 'openai-responses' || route.transport === 'openrouter-video') {
    return { capability: { kind: 'unsupported' }, basis: 'transport' }
  }
  if (route.transport === 'openai-text') {
    return { capability: { kind: 'text-prefix' }, basis: 'transport' }
  }
  if (route.transport === 'gemini-native') {
    return { capability: { kind: 'native-model-tail' }, basis: 'transport' }
  }
  if (route.transport === 'anthropic') {
    return { capability: { kind: 'assistant-tail', marker: 'none' }, basis: 'transport' }
  }
  if (profile.kind === 'openrouter') {
    return { capability: { kind: 'assistant-tail', marker: 'none' }, basis: 'transport' }
  }
  return capability?.prefill
    ? { capability: capability.prefill, basis: 'endpoint-capability' }
    : null
}

function prefillRecommendation(
  settings: ChatSettings,
  modelClass: ReturnType<typeof prefillClassFor>,
): PrefillRecommendation | undefined {
  if (modelClass !== 'oss-toggleable' || !reasoningToggleableFor(settings.model)) return undefined
  if (settings.reasoning.mode === 'off') return undefined
  return Object.freeze({
    issues: Object.freeze(['turn reasoning off']),
    patch: { reasoning: { ...settings.reasoning, mode: 'off' as const } },
  })
}

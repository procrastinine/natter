// API router. Callers:
//   - the send-pipeline (picks transport + wire shape)
//   - the UI (surfaces the resolved route in the API-mode hint)
//
// The route is a discriminated union carrying both a kind (for UI / logging)
// and a transport (for the send pipeline). Multi-step reasoning about the
// route is fully pure — no I/O, no live capability fetch — so the same
// function is safe to call from memoized selectors.
//
// Inputs
//   - `profile`: a ConnectionProfile; it supplies endpoint identity only.
//   - `settings`: the effective ChatSettings for this turn. The user's
//     explicit `settings.api` pin owns direct-provider transport modes.
//   - `path`: the active branch (root → leaf). Checked for prior Responses-
//     API artifacts (e.g. encrypted reasoning, server-tool outputs) that
//     would be lost on chat-completions.
//   - `caps`: the resolved capability descriptor, carrying the quirks entry
//     (`reasoningPreservationFormat`, `preferApi`, `requiresResponsesApi`).

import { hasEnabledHostedTools, isOpenAiDirectProfile } from './provider-hosted-tools'
import {
  ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
  type AttemptProviderOutputContract,
  GOOGLE_PROVIDER_OUTPUT_CONTRACT,
  OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
  OPENROUTER_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
  TEXT_PROVIDER_OUTPUT_CONTRACT,
} from './provider-tool-context'
import {
  isTextCompletionsSelectableFor,
  reasoningVisibilityPolicyFromQuirks,
  responsesSupportFor,
} from './quirks'
import {
  type AttemptReasoningContract,
  type InboundReasoningVisibility,
  type MessageContextRouteFacts,
  type ReasoningPolicy,
  type ReasoningVisibilityPolicy,
  type RoutedReasoningContract,
  reasoningCarrierReplayDecision,
  reasoningPolicyForSettings,
  sealAttemptReasoningContract,
} from './reasoning'
import type {
  ApiVariant,
  ChatSettings,
  ConnectionProfile,
  GenerationMeta,
  KnownReasoningFormat,
  ReasoningFormat,
  ReasoningProducerBridge,
} from './types'

export type ApiRoute =
  | { kind: 'chat-completions'; transport: 'openai-chat'; reason: string }
  | { kind: 'text-completions'; transport: 'openai-text'; reason: string }
  | { kind: 'responses'; transport: 'openai-responses'; reason: string }
  | { kind: 'gemini-generate'; transport: 'gemini-native'; reason: string }
  | { kind: 'anthropic-messages'; transport: 'anthropic'; reason: string }
  | { kind: 'video-generation'; transport: 'openrouter-video'; reason: string }

type ReasoningContractFor<
  Target extends KnownReasoningFormat | null,
  Carrier extends RoutedReasoningContract['carrier'],
  Origin extends RoutedReasoningContract['originDialect'],
> = RoutedReasoningContract<Target, Carrier, Origin>

type OpenAiReasoningFormat =
  | 'openai-responses-v1'
  | 'azure-openai-responses-v1'
  | 'xai-responses-v1'

export type ResponsesReasoningContract =
  | ReasoningContractFor<OpenAiReasoningFormat, 'responses-items', 'openrouter-responses'>
  | ReasoningContractFor<OpenAiReasoningFormat, 'responses-items', 'openai-responses'>

export type AssistantRouteContract =
  | (Extract<ApiRoute, { transport: 'openai-text' | 'openrouter-video' }> & {
      readonly reasoning: ReasoningContractFor<null, 'plaintext-only', 'inline'>
      readonly providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: null }>
    })
  | (Extract<ApiRoute, { transport: 'gemini-native' }> & {
      readonly reasoning: ReasoningContractFor<'google-gemini-v1', 'gemini-parts', 'gemini-native'>
      readonly providerOutput: Extract<
        AttemptProviderOutputContract,
        { captureDialect: 'google-gemini' }
      >
    })
  | (Extract<ApiRoute, { transport: 'anthropic' }> & {
      readonly reasoning: ReasoningContractFor<
        'anthropic-claude-v1',
        'anthropic-blocks',
        'anthropic-messages'
      >
      readonly providerOutput: Extract<
        AttemptProviderOutputContract,
        { captureDialect: 'anthropic-claude' }
      >
    })
  | (Extract<ApiRoute, { transport: 'openai-responses' }> & {
      readonly reasoning: ReasoningContractFor<
        OpenAiReasoningFormat,
        'responses-items',
        'openai-responses'
      >
      readonly providerOutput: Extract<
        AttemptProviderOutputContract,
        { captureDialect: 'openai-responses' }
      >
    })
  | (Extract<ApiRoute, { transport: 'openai-chat' }> & {
      readonly reasoning: ReasoningContractFor<
        KnownReasoningFormat | null,
        'plaintext-only',
        'openai-chat'
      >
      readonly providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: null }>
    })
  | (Extract<ApiRoute, { transport: 'openai-responses' }> & {
      readonly reasoning: ReasoningContractFor<
        OpenAiReasoningFormat,
        'responses-items',
        'openrouter-responses'
      >
      readonly providerOutput: Extract<
        AttemptProviderOutputContract,
        { captureDialect: 'openrouter-responses' }
      >
    })
  | (Extract<ApiRoute, { transport: 'openai-chat' }> & {
      readonly reasoning: ReasoningContractFor<
        KnownReasoningFormat | null,
        'openrouter-reasoning-details',
        'openrouter-chat'
      >
      readonly providerOutput: Extract<AttemptProviderOutputContract, { captureDialect: null }>
    })

type SealAssistantRouteAttempt<Route extends AssistantRouteContract> =
  Route extends AssistantRouteContract
    ? Route['reasoning'] extends RoutedReasoningContract<infer Target, infer Carrier, infer Origin>
      ? Omit<Route, 'reasoning'> & {
          readonly reasoning: AttemptReasoningContract<Target, Carrier, Origin>
        }
      : never
    : never

export type AssistantAttemptContract = SealAssistantRouteAttempt<AssistantRouteContract>

export function assistantRouteContractKey(route: AssistantRouteContract): string {
  return JSON.stringify(route)
}

export function sealAssistantAttemptContract<Route extends AssistantRouteContract>(
  route: Route,
  inboundVisibility: InboundReasoningVisibility,
): SealAssistantRouteAttempt<Route> {
  return Object.freeze({
    ...route,
    reasoning: sealAttemptReasoningContract(route.reasoning, inboundVisibility),
  }) as SealAssistantRouteAttempt<Route>
}

export function apiUsedForRoute(route: ApiRoute): NonNullable<GenerationMeta['apiUsed']> {
  if (route.kind === 'text-completions') return 'completion'
  if (route.kind === 'responses') return 'responses'
  if (route.kind === 'gemini-generate') return 'gemini-native'
  if (route.kind === 'anthropic-messages') return 'anthropic-messages'
  if (route.kind === 'video-generation') return 'video-generation'
  return 'chat'
}

// Minimal capability surface the router needs. Real callers pass
// `EffectiveCapability` which satisfies this shape via structural typing.
export interface RouterCapabilities {
  quirks: {
    requiresResponsesApi?: boolean
    preferApi?: 'chat' | 'responses'
    reasoningPreservationFormat?: ReasoningFormat
    reasoningVisibility?: ReasoningVisibilityPolicy
    acceptsAnthropicRedactedThinking?: boolean
  }
  outputModalities?: ReadonlySet<string>
}

export function resolveAssistantRouteContract(
  profile: ConnectionProfile,
  settings: ChatSettings,
  contextFacts: MessageContextRouteFacts,
  caps: RouterCapabilities,
): AssistantRouteContract {
  const policy = reasoningPolicyForSettings(settings, {
    ...(caps.quirks.acceptsAnthropicRedactedThinking !== undefined
      ? {
          acceptsAnthropicRedactedThinking: caps.quirks.acceptsAnthropicRedactedThinking,
        }
      : {}),
  })
  const responsesReasoning = responsesReasoningContractFor(profile, caps, policy)
  const route =
    settings.protocol === 'text' && profile.kind === 'llama-server'
      ? openAiText('llama-server text protocol')
      : chooseApi(profile, settings, contextFacts, caps, policy, responsesReasoning)
  if (route.transport === 'openai-text' || route.transport === 'openrouter-video') {
    return Object.freeze({
      ...route,
      reasoning: reasoningContractForTarget(policy, null, 'plaintext-only', 'inline', 'inline', {
        kind: 'uniform',
        visibleKind: 'text',
      }),
      providerOutput: TEXT_PROVIDER_OUTPUT_CONTRACT,
    })
  }
  if (route.transport === 'gemini-native') {
    return Object.freeze({
      ...route,
      reasoning: reasoningContractForTarget(
        policy,
        'google-gemini-v1',
        'gemini-parts',
        'gemini-native',
        'google-direct',
        reasoningVisibilityPolicyFromQuirks(caps.quirks),
      ),
      providerOutput: GOOGLE_PROVIDER_OUTPUT_CONTRACT,
    })
  }
  if (route.transport === 'anthropic') {
    return Object.freeze({
      ...route,
      reasoning: reasoningContractForTarget(
        policy,
        'anthropic-claude-v1',
        'anthropic-blocks',
        'anthropic-messages',
        'anthropic-direct',
        reasoningVisibilityPolicyFromQuirks(caps.quirks),
      ),
      providerOutput: ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
    })
  }
  if (route.transport === 'openai-responses') {
    if (responsesReasoning.originDialect === 'openrouter-responses') {
      return Object.freeze({
        ...route,
        reasoning: responsesReasoning,
        providerOutput: OPENROUTER_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
      })
    }
    return Object.freeze({
      ...route,
      reasoning: responsesReasoning,
      providerOutput: OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
    })
  }
  if (profile.kind === 'openrouter') {
    return Object.freeze({
      ...route,
      reasoning: reasoningContractForTarget(
        policy,
        knownReasoningFormat(caps.quirks.reasoningPreservationFormat),
        'openrouter-reasoning-details',
        'openrouter-chat',
        'openrouter',
        reasoningVisibilityPolicyFromQuirks(caps.quirks),
      ),
      providerOutput: TEXT_PROVIDER_OUTPUT_CONTRACT,
    })
  }
  return Object.freeze({
    ...route,
    reasoning: reasoningContractForTarget(
      policy,
      knownReasoningFormat(caps.quirks.reasoningPreservationFormat),
      'plaintext-only',
      'openai-chat',
      producerBridgeForProfile(profile),
      reasoningVisibilityPolicyFromQuirks(caps.quirks),
    ),
    providerOutput: TEXT_PROVIDER_OUTPUT_CONTRACT,
  })
}

export function responsesReasoningContractFor(
  profile: ConnectionProfile,
  caps: RouterCapabilities,
  policy: ReasoningPolicy,
): ResponsesReasoningContract {
  const targetFormat = responsesReasoningFormat(profile, caps.quirks.reasoningPreservationFormat)
  return profile.kind === 'openrouter'
    ? reasoningContractForTarget(
        policy,
        targetFormat,
        'responses-items',
        'openrouter-responses',
        'openrouter',
        reasoningVisibilityPolicyFromQuirks(caps.quirks),
      )
    : reasoningContractForTarget(
        policy,
        targetFormat,
        'responses-items',
        'openai-responses',
        producerBridgeForProfile(profile),
        reasoningVisibilityPolicyFromQuirks(caps.quirks),
      )
}

function reasoningContractForTarget<
  Target extends KnownReasoningFormat | null,
  Carrier extends RoutedReasoningContract['carrier'],
  Origin extends RoutedReasoningContract['originDialect'],
>(
  policy: ReasoningPolicy,
  targetFormat: Target,
  carrier: Carrier,
  originDialect: Origin,
  producerBridge: ReasoningProducerBridge,
  visibilityPolicy: ReasoningVisibilityPolicy,
): RoutedReasoningContract<Target, Carrier, Origin> {
  return Object.freeze({
    ...policy,
    targetFormat,
    carrier,
    originDialect,
    producerBridge,
    visibilityPolicy: Object.freeze({ ...visibilityPolicy }),
  })
}

function producerBridgeForProfile(profile: ConnectionProfile): ReasoningProducerBridge {
  if (profile.kind === 'openrouter') return 'openrouter'
  if (profile.kind === 'google') return 'google-direct'
  if (profile.kind === 'anthropic') return 'anthropic-direct'
  if (isAzureOpenAiConnection(profile)) return 'azure-openai'
  if (isOpenAiDirectProfile(profile)) return 'openai-direct'
  return profile.kind === 'custom' || profile.kind === 'openai-compatible' ? 'custom' : 'unknown'
}

function responsesReasoningFormat(
  profile: ConnectionProfile,
  modelFormat: ReasoningFormat | undefined,
): OpenAiReasoningFormat {
  if (modelFormat === 'xai-responses-v1') return modelFormat
  if (profile.kind === 'openrouter' || isAzureOpenAiConnection(profile)) {
    return 'azure-openai-responses-v1'
  }
  return 'openai-responses-v1'
}

function knownReasoningFormat(value: ReasoningFormat | undefined): KnownReasoningFormat | null {
  return value && value !== 'unknown' ? value : null
}

function isAzureOpenAiConnection(profile: ConnectionProfile): boolean {
  if (profile.kind !== 'openai-compatible' && profile.kind !== 'custom') return false
  try {
    return new URL(profile.baseUrl).hostname.toLowerCase().endsWith('.openai.azure.com')
  } catch {
    return false
  }
}

export function chooseApi(
  profile: ConnectionProfile,
  settings: ChatSettings,
  contextFacts: MessageContextRouteFacts,
  caps: RouterCapabilities,
  reasoning: ReasoningPolicy,
  responsesReasoning: ResponsesReasoningContract,
): ApiRoute {
  const pin: ApiVariant = settings.api
  const support = responsesSupportFor(settings.model)

  if (profile.kind === 'openrouter' && caps.outputModalities?.has('video')) {
    return openRouterVideo('video output uses OpenRouter Video Generation API')
  }
  if (profile.kind === 'openrouter' && caps.outputModalities?.has('audio')) {
    return openAiChat('audio output requires chat-completions streaming')
  }
  if (isOpenAiDirectProfile(profile) && hasEnabledHostedTools(settings, 'openai')) {
    return openAiResponses('OpenAI hosted tools require Responses API')
  }
  if (
    profile.kind === 'google' &&
    settings.api !== 'chat' &&
    hasEnabledHostedTools(settings, 'google')
  ) {
    return geminiNative('Gemini native required for Google hosted tools')
  }
  if (profile.kind === 'google') {
    if (pin === 'chat') return openAiChat('user pinned Gemini OpenAI-compat')
    return geminiNative(
      pin === 'gemini-native' ? 'user pinned Gemini native' : 'Gemini native (generateContent)',
    )
  }
  if (profile.kind === 'anthropic') {
    if (pin === 'chat') return openAiChat('user pinned Anthropic OpenAI-compat')
    return anthropicMessages(
      pin === 'anthropic-messages' ? 'user pinned Anthropic Messages' : 'Anthropic Messages API',
    )
  }

  // Step 1 — user-pinned chat completions. Wins over everything EXCEPT a
  // model that 404s on chat-completions (`responsesSupport: 'responses-only'`
  // or a registry `requiresResponsesApi` flag).
  const responsesOnly = support === 'responses-only' || caps.quirks.requiresResponsesApi === true
  if (pin === 'text' && canRunTextCompletions(profile, settings.model) && !responsesOnly) {
    return openAiText('user pinned Text completions')
  }
  if (pin === 'chat' && !responsesOnly) {
    return openAiChat('user pinned chat completions')
  }

  // Step 2 — user-pinned responses. Wins over everything except connection
  // kinds that have no Responses surface.
  if (pin === 'responses' && canRunResponses(profile)) {
    return openAiResponses('user pinned Responses')
  }

  // Step 3 — model requires Responses (supports ONLY /responses).
  if (responsesOnly && canRunResponses(profile)) {
    return openAiResponses('model requires Responses API')
  }

  // Step 4 — model quirk prefers Responses. Still switchable by pinning chat
  // (step 1 handles that above).
  if (caps.quirks.preferApi === 'responses' && canRunResponses(profile)) {
    return openAiResponses('model prefers Responses for encrypted reasoning')
  }

  // Step 5 — prior server-tool output on the path (web_search_call, etc.).
  // Chat completions can't round-trip those items, so the route must stay
  // on Responses for continuity.
  if (contextFacts.hasOpenAiResponsesProviderOutput && canRunResponses(profile)) {
    return openAiResponses('prior server-tool output requires Responses for round-trip')
  }

  // Step 6 — prior encrypted reasoning on the path in an OpenAI-family format
  // AND the user wants to include it. Only meaningful on OpenAI-compatible
  // endpoints; Gemini's encrypted carrier rides on native, not Responses.
  if (
    reasoning.include.encrypted &&
    canRunResponses(profile) &&
    contextFacts.reasoningCarriers.some(
      (fact) => reasoningCarrierReplayDecision(fact, responsesReasoning).kind === 'replay',
    )
  ) {
    return openAiResponses('prior encrypted reasoning requires Responses to round-trip')
  }

  // Step 9 — default. OpenRouter stays on Chat Completions unless an explicit
  // pin, model requirement, hosted-tool output, or compatible encrypted
  // reasoning carrier selected Responses above.
  return openAiChat('default (chat completions)')
}

// "Responses capable" covers OpenRouter (beta `/responses` proxy),
// OpenAI-compatible endpoints (OpenAI direct, Azure OpenAI, GMI, etc.),
// and any `custom` kind that the user opted into. Gemini native and
// Anthropic's dedicated APIs are excluded; their Responses-equivalents
// are their own transports.
function canRunResponses(profile: ConnectionProfile): boolean {
  return (
    profile.kind === 'openrouter' ||
    profile.kind === 'openai-compatible' ||
    profile.kind === 'custom'
  )
}

function canRunTextCompletions(profile: ConnectionProfile, modelId: string): boolean {
  return profile.kind === 'openrouter' && isTextCompletionsSelectableFor(modelId)
}

function openAiChat(reason: string): ApiRoute {
  return { kind: 'chat-completions', transport: 'openai-chat', reason }
}

function openAiText(reason: string): ApiRoute {
  return { kind: 'text-completions', transport: 'openai-text', reason }
}

function openAiResponses(reason: string): ApiRoute {
  return { kind: 'responses', transport: 'openai-responses', reason }
}

function geminiNative(reason: string): ApiRoute {
  return { kind: 'gemini-generate', transport: 'gemini-native', reason }
}

function anthropicMessages(reason: string): ApiRoute {
  return { kind: 'anthropic-messages', transport: 'anthropic', reason }
}

function openRouterVideo(reason: string): ApiRoute {
  return { kind: 'video-generation', transport: 'openrouter-video', reason }
}

// Convenience predicates used by the UI to decide whether to enable the
// "API mode" segmented control's Responses button.
export function isResponsesCapable(profile: ConnectionProfile): boolean {
  return canRunResponses(profile)
}

export function isTextCompletionsCapable(profile: ConnectionProfile, modelId: string): boolean {
  return canRunTextCompletions(profile, modelId)
}

export function isGeminiNative(profile: ConnectionProfile, settings: ChatSettings): boolean {
  return profile.kind === 'google' && settings.api !== 'chat'
}

// Short explanation suitable for a UI tooltip.
export function responsesExplanationFor(
  route: ApiRoute,
  profile: ConnectionProfile,
  caps: RouterCapabilities,
): string {
  if (caps.quirks.requiresResponsesApi) {
    return 'Responses API is required by this model to preserve phase metadata and chain-of-thought.'
  }
  if (caps.quirks.preferApi === 'responses') {
    return 'Responses API is recommended: it preserves encrypted reasoning across turns.'
  }
  if (profile.kind === 'openrouter' && route.kind === 'responses') {
    return 'OpenRouter’s /responses beta proxy. Item ids are rewritten; keep a chat on this route for best results.'
  }
  return 'Responses API: preserves encrypted reasoning and multi-item output (phase, server tools).'
}

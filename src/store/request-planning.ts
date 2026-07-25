import { applyServerTemplate } from '../api/probe'
import type {
  AnthropicMessagesTransformOptions,
  ChatCompletionsTransformOptions,
  GeminiNativeTransformOptions,
  ResponsesTransformOptions,
} from '../api/request-transforms'
import {
  preparePrefillPathForWire,
  toAnthropicMessages,
  toChatCompletions,
  toGeminiNative,
  toResponses,
  toTextCompletions,
} from '../api/request-transforms'
import { resolveBundledCapability } from '../capabilities'
import {
  type AssistantAttemptContract,
  type AssistantRouteContract,
  apiUsedForRoute,
  assistantRouteContractKey,
  resolveAssistantRouteContract,
  sealAssistantAttemptContract,
} from '../core/api-choice'
import type { AssistantPlanningResources } from '../core/assistant-planning-resources'
import {
  attachmentContextHasRefs,
  attachmentContextIds,
  attachmentContextPolicyForSettings,
  resolveAttachmentContextRefs,
} from '../core/attachments/context'
import { buildStoredOpenRouterAttachmentWire } from '../core/attachments/stored-openrouter'
import { effectiveCapabilityFromDescriptor, validateChatSettings } from '../core/capabilities'
import { sameChatSettings } from '../core/chat-metadata'
import { applyContextCutoff } from '../core/context-cutoff'
import {
  type EffectiveEndpointRouting,
  type PrefillPlan,
  resolveEffectiveEndpointRouting,
} from '../core/effective-endpoint-routing'
import { pickEquivalentModelId } from '../core/model-selection'
import {
  assertOutboundReasoningResolverRoute,
  createOutboundReasoningCompiler,
  type OutboundReasoningResolver,
  outboundReasoningRouteForAssistantRoute,
} from '../core/outbound-reasoning'
import { projectOutboundContextRewrites } from '../core/prompt-context'
import {
  type AttachmentResolver,
  estimateSettingsPromptSize,
  tokenizerFromSettings,
  UNLIMITED_CONTEXT,
} from '../core/prompt-size'
import {
  type HostedToolProvider,
  hasEnabledHostedTools,
  isOpenAiDirectProfile,
} from '../core/provider-hosted-tools'
import { providerEndpointKey } from '../core/provider-identity'
import { quirksFor } from '../core/quirks'
import {
  contextRouteFactsFromMessages,
  EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
  type MessageContextRouteFacts,
  type ReasoningVisibilityEvidence,
  resolveAttemptInboundReasoningVisibility,
  sealedReasoningCarryForwardEvidence,
} from '../core/reasoning'
import {
  projectTextPromptMessagesProjection,
  renderedTextPromptFromOpaqueServer,
} from '../core/text-templates'
import { charsPerToken } from '../core/token-calibration'
import type { PromptEstimateOptions } from '../core/tokens'
import type {
  Attachment,
  AttachmentId,
  CapabilityDescriptor,
  Chat,
  ChatSettings,
  ConnectionProfile,
  ContentItem,
  GenerationMeta,
  Message,
  ReasoningCarryForwardEvidence,
  SealedReasoningCarryForward,
} from '../core/types'
import { stableStringify } from '../lib/same-value'
import { NoEligibleProvidersError, ProviderCatalogEmptyError } from './repository'
import {
  buildPrivacyForSendResult,
  type ResolvedPrivacyFacts,
  type ResolvePrivacyForSendResult,
  resolvePrivacyFactsForSend,
  resolvePrivacyForSend,
} from './request-privacy-planning'
import type { SelectedPromptContext } from './send-context'

function rewriteCompatibleModelId(connection: ConnectionProfile, modelId: string): string {
  if (connection.kind === 'anthropic') {
    return modelId.replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
  }
  return modelId
}

const DIRECT_CAPABILITY_LOOKUP_QUERY = {} as const

interface ResolveRequestCapabilityInput {
  profile: ConnectionProfile
  modelId: string
  resources: AssistantPlanningResources
}

export interface AssistantRequestFacts {
  readonly settings: ChatSettings
  readonly capability?: CapabilityDescriptor
  readonly contextFacts: MessageContextRouteFacts
  readonly privacyFacts: ResolvedPrivacyFacts
  readonly preflightPrivacy: ResolvePrivacyForSendResult
  readonly preflightRouting: EffectiveEndpointRouting
}

interface ResolveAssistantRequestFactsInput {
  chat: Chat
  connection: ConnectionProfile
  settings?: ChatSettings
  capabilities?: CapabilityDescriptor
  contextFacts?: MessageContextRouteFacts
  signal?: AbortSignal
  resources: AssistantPlanningResources
}

function readPlanningGlobals(resources: AssistantPlanningResources) {
  return {
    globalCalibration: resources.globalCalibration(),
    calibrationMode: resources.calibrationMode(),
  }
}

async function resolveRequestCapability(
  input: ResolveRequestCapabilityInput,
): Promise<CapabilityDescriptor | undefined> {
  const { profile, modelId } = input
  if (!modelId) return undefined
  if (profile.kind === 'openrouter') {
    return undefined
  }
  const bundled = resolveBundledCapability(profile, modelId)
  const liveModels = await input.resources.readModels(DIRECT_CAPABILITY_LOOKUP_QUERY)
  if (!liveModels) return bundled
  const equivalentModelId = pickEquivalentModelId(modelId, liveModels)
  const liveEntry = liveModels.find((row) => row.id === equivalentModelId) ?? null
  if (!liveEntry) return bundled
  const merged: CapabilityDescriptor = { ...bundled }
  if (liveEntry.contextLength !== undefined) {
    merged.contextLength = liveEntry.contextLength
    if (
      merged.maxCompletionTokens === undefined ||
      merged.maxCompletionTokens < liveEntry.contextLength
    ) {
      merged.maxCompletionTokens = Math.min(
        liveEntry.contextLength,
        Math.max(merged.maxCompletionTokens ?? 0, 4096),
      )
    }
  }
  return merged
}

interface RequestPrivacyPlanInput {
  chat: Chat
  profile: ConnectionProfile
  activePathMessages: Message[]
  draftText: string
  settings?: ChatSettings
  facts?: AssistantRequestFacts
  preCutAttachmentIds?: readonly AttachmentId[]
  signal?: AbortSignal
  resources: AssistantPlanningResources
  routing: AssistantRoutingPlan
  contextAlreadySelected?: boolean
  reasoningResolver?: OutboundReasoningResolver
  capacityExcludedProviders?: readonly string[]
}

interface RequestPrivacyPlan {
  neededTokens?: number
  privacy: ResolvePrivacyForSendResult
}

export async function resolveRequestPrivacyPlan(
  input: RequestPrivacyPlanInput,
): Promise<RequestPrivacyPlan> {
  const settings = input.facts?.settings ?? input.settings ?? input.chat.settings
  let neededTokens: number | undefined
  const planningGlobals = readPlanningGlobals(input.resources)
  try {
    const attachmentContext = await loadAttachmentEstimateContext(
      input.activePathMessages,
      settings,
      input.preCutAttachmentIds,
      input.resources,
    )
    const est = estimateSettingsPromptSize(
      settings,
      input.activePathMessages,
      input.draftText,
      null,
      null,
      attachmentContext.resolver,
      {
        chatTokenCalibration: input.chat.tokenCalibration,
        globalCalibration: planningGlobals.globalCalibration,
        mode: planningGlobals.calibrationMode,
      },
      undefined,
      input.preCutAttachmentIds,
      input.routing,
      {
        contextAlreadySelected: input.contextAlreadySelected === true,
        ...(input.reasoningResolver ? { reasoningResolver: input.reasoningResolver } : {}),
      },
    )
    const reserveRaw = settings.maxCompletionTokens
    const reserve = reserveRaw === UNLIMITED_CONTEXT ? 0 : (reserveRaw ?? 0)
    neededTokens = est.total + reserve
  } catch {
    // Privacy routing can proceed without an advisory token estimate.
  }
  const chatForRequest = settings === input.chat.settings ? input.chat : { ...input.chat, settings }
  const privacy = input.facts
    ? buildPrivacyForSendResult({
        chat: chatForRequest,
        profile: input.profile,
        facts: input.facts.privacyFacts,
        ...(neededTokens !== undefined ? { neededTokens } : {}),
        ...(input.capacityExcludedProviders
          ? { capacityExcludedProviders: input.capacityExcludedProviders }
          : {}),
      })
    : await resolvePrivacyForSend({
        chat: chatForRequest,
        profile: input.profile,
        resources: input.resources,
        ...(neededTokens !== undefined ? { neededTokens } : {}),
        ...(input.capacityExcludedProviders
          ? { capacityExcludedProviders: input.capacityExcludedProviders }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      })
  return neededTokens !== undefined ? { neededTokens, privacy } : { privacy }
}

type AssistantRequestTransform = Partial<ChatCompletionsTransformOptions>

interface AssistantRequestPlanInput {
  chat: Chat
  connection: ConnectionProfile
  pathMessages: Message[]
  capabilities?: CapabilityDescriptor
  facts?: AssistantRequestFacts
  transform?: AssistantRequestTransform
  signal?: AbortSignal
  settings?: ChatSettings
  stream?: boolean
  preCutAttachmentIds?: readonly AttachmentId[]
  resources: AssistantPlanningResources
  contextAlreadySelected?: boolean
  routing?: AssistantRoutingPlan
  effectiveRouting?: EffectiveEndpointRouting
  reasoningCarryForwardByMessageId?: ReadonlyMap<string, SealedReasoningCarryForward>
  reasoningResolver?: OutboundReasoningResolver
}

export interface AssistantContextSelectionFrame {
  readonly settings: ChatSettings
  readonly capability?: CapabilityDescriptor
  readonly routing: EffectiveEndpointRouting
}

export interface AssistantContextSelectionResult {
  readonly selectedContext: SelectedPromptContext
  readonly settings: ChatSettings
}

export interface SelectedAssistantRequestPlanInput {
  chat: Chat
  connection: ConnectionProfile
  facts: AssistantRequestFacts
  selectContext: (frame: AssistantContextSelectionFrame) => Promise<AssistantContextSelectionResult>
  transform?: AssistantRequestTransform
  signal?: AbortSignal
  stream?: boolean
  resources: AssistantPlanningResources
}

export type AssistantRoutingPlan = AssistantRouteContract

export type AssistantRequestPlan = AssistantAttemptContract & {
  settings: ChatSettings
  apiUsed: NonNullable<GenerationMeta['apiUsed']>
  requestedModel: string
  geminiModelId?: string
  anthropicModelId?: string
  wire: Record<string, unknown>
  outboundPath: Message[]
  outboundTokenizer: ReturnType<typeof tokenizerFromSettings>
  outboundReasoningOpts: PromptEstimateOptions
  hasAttachmentContext: boolean
  reasoningCarryForwardEvidence: ReasoningCarryForwardEvidence
  effectiveRouting: EffectiveEndpointRouting
  prefillPlan: PrefillPlan
}

interface PreparedAssistantRequestPlan {
  requestPlan: AssistantRequestPlan
  privacyPlan: RequestPrivacyPlan
}

export interface PreparedSelectedAssistantRequestPlan extends PreparedAssistantRequestPlan {
  selectedContext: SelectedPromptContext
}

function mergePrivacyTransform(
  transform: Partial<ChatCompletionsTransformOptions> | undefined,
  privacy: ResolvePrivacyForSendResult,
): Partial<ChatCompletionsTransformOptions> | undefined {
  if (!privacy.wire) return transform
  return { ...(transform ?? {}), privacy: privacy.wire }
}

export async function resolveAssistantRequestFacts(
  input: ResolveAssistantRequestFactsInput,
): Promise<AssistantRequestFacts> {
  const storedSettings = input.settings ?? input.chat.settings
  const contextFacts = input.contextFacts ?? EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS
  const chatForRequest =
    storedSettings === input.chat.settings
      ? input.chat
      : { ...input.chat, settings: storedSettings }
  const [privacyFacts, directCapability] = await Promise.all([
    resolvePrivacyFactsForSend({
      chat: chatForRequest,
      profile: input.connection,
      resources: input.resources,
      ...(input.signal ? { signal: input.signal } : {}),
    }),
    input.capabilities || !storedSettings.model || input.connection.kind === 'openrouter'
      ? Promise.resolve(input.capabilities)
      : resolveRequestCapability({
          profile: input.connection,
          modelId: storedSettings.model,
          resources: input.resources,
        }),
  ])
  const preflightPrivacy = buildPrivacyForSendResult({
    chat: chatForRequest,
    profile: input.connection,
    facts: privacyFacts,
  })
  const suppliedCapability = input.capabilities ?? directCapability
  const initialRouting = resolveEffectiveEndpointRouting({
    profile: input.connection,
    settings: storedSettings,
    contextFacts,
    ...(suppliedCapability ? { capability: suppliedCapability } : {}),
    descriptor: preflightPrivacy.descriptor ?? privacyFacts.descriptor,
    filter: preflightPrivacy.filter,
    providerWire: preflightPrivacy.wire,
  })
  const capability = suppliedCapability ?? initialRouting.requestCapability
  const settings = capability
    ? validateChatSettings(
        storedSettings,
        effectiveCapabilityFromDescriptor(storedSettings.model, capability),
      ).settings
    : storedSettings
  const preflightRouting =
    settings === storedSettings
      ? initialRouting
      : resolveEffectiveEndpointRouting({
          profile: input.connection,
          settings,
          contextFacts,
          ...(capability ? { capability } : {}),
          descriptor: preflightPrivacy.descriptor ?? privacyFacts.descriptor,
          filter: preflightPrivacy.filter,
          providerWire: preflightPrivacy.wire,
        })
  assertEndpointAvailability(preflightRouting)
  return {
    settings,
    ...(capability ? { capability } : {}),
    contextFacts,
    privacyFacts,
    preflightPrivacy,
    preflightRouting,
  }
}

function hostedToolsProviderForConnection(
  connection: ConnectionProfile,
  settings: ChatSettings,
): HostedToolProvider | undefined {
  if (connection.kind === 'openrouter' && hasEnabledHostedTools(settings, 'openrouter')) {
    return 'openrouter'
  }
  if (isOpenAiDirectProfile(connection) && hasEnabledHostedTools(settings, 'openai')) {
    return 'openai'
  }
  if (
    connection.kind === 'google' &&
    settings.api !== 'chat' &&
    hasEnabledHostedTools(settings, 'google')
  ) {
    return 'google'
  }
  if (
    connection.kind === 'anthropic' &&
    settings.api !== 'chat' &&
    hasEnabledHostedTools(settings, 'anthropic')
  ) {
    return 'anthropic'
  }
  return undefined
}

export async function prepareAssistantRequestPlan(
  input: AssistantRequestPlanInput & { draftText?: string },
): Promise<PreparedAssistantRequestPlan> {
  return prepareAssistantRequestPlanInternal(input)
}

export async function prepareAssistantRequestPlanFromContextSelection(
  input: SelectedAssistantRequestPlanInput,
): Promise<PreparedSelectedAssistantRequestPlan> {
  let facts = input.facts
  let capacityExcludedProviders: readonly string[] = Object.freeze([])
  for (;;) {
    const selection = await input.selectContext({
      settings: facts.settings,
      ...(facts.capability ? { capability: facts.capability } : {}),
      routing: facts.preflightRouting,
    })
    const requestFacts =
      selection.settings === facts.settings ? facts : { ...facts, settings: selection.settings }
    const routing = facts.preflightRouting.route
    const privacyPlan = await resolveRequestPrivacyPlan({
      chat: input.chat,
      profile: input.connection,
      activePathMessages: selection.selectedContext.pathMessages,
      draftText: '',
      settings: selection.settings,
      facts: requestFacts,
      routing,
      contextAlreadySelected: true,
      reasoningResolver: selection.selectedContext.reasoningResolver,
      preCutAttachmentIds: selection.selectedContext.preCutAttachmentIds,
      ...(capacityExcludedProviders.length > 0 ? { capacityExcludedProviders } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      resources: input.resources,
    })
    const nextFacts = refineAssistantRequestFacts({
      chat: input.chat,
      connection: input.connection,
      facts,
      privacy: privacyPlan.privacy,
    })
    if (assistantRequestFactsSelectionKey(nextFacts) === assistantRequestFactsSelectionKey(facts)) {
      const stableFacts =
        selection.settings === nextFacts.settings
          ? nextFacts
          : { ...nextFacts, settings: selection.settings }
      const prepared = await prepareAssistantRequestPlanInternal(
        {
          ...input,
          pathMessages: selection.selectedContext.pathMessages,
          preCutAttachmentIds: selection.selectedContext.preCutAttachmentIds,
          reasoningCarryForwardByMessageId:
            selection.selectedContext.reasoningCarryForwardByMessageId,
          reasoningResolver: selection.selectedContext.reasoningResolver,
          contextAlreadySelected: true,
          settings: selection.settings,
          facts: stableFacts,
          routing: nextFacts.preflightRouting.route,
        },
        {
          privacyPlan,
          effectiveRouting: nextFacts.preflightRouting,
        },
      )
      return { ...prepared, selectedContext: selection.selectedContext }
    }
    assertMonotoneEndpointReduction(facts.preflightRouting, nextFacts.preflightRouting)
    capacityExcludedProviders = Object.freeze([...privacyPlan.privacy.contextIgnoredProviders])
    facts = nextFacts
  }
}

async function prepareAssistantRequestPlanInternal(
  input: AssistantRequestPlanInput & { draftText?: string },
  resolved?: Readonly<{
    privacyPlan: RequestPrivacyPlan
    effectiveRouting: EffectiveEndpointRouting
  }>,
): Promise<PreparedAssistantRequestPlan> {
  const facts =
    input.facts ??
    (await resolveAssistantRequestFacts({
      chat: input.chat,
      connection: input.connection,
      ...(input.settings ? { settings: input.settings } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      resources: input.resources,
    }))
  const settings = facts.settings
  const requestCapability = facts.capability
  const routing =
    input.routing ??
    resolveAssistantRoutingPlanFromMessages({
      connection: input.connection,
      settings,
      ...(requestCapability ? { capabilities: requestCapability } : {}),
      pathMessages: input.pathMessages,
    })
  const privacyPlan =
    resolved?.privacyPlan ??
    (await resolveRequestPrivacyPlan({
      chat: input.chat,
      profile: input.connection,
      activePathMessages: input.pathMessages,
      draftText: input.draftText ?? '',
      settings,
      facts,
      routing,
      contextAlreadySelected: input.contextAlreadySelected === true,
      ...(input.reasoningResolver ? { reasoningResolver: input.reasoningResolver } : {}),
      ...(input.preCutAttachmentIds ? { preCutAttachmentIds: input.preCutAttachmentIds } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      resources: input.resources,
    }))
  const finalDescriptor = privacyPlan.privacy.descriptor ?? facts.privacyFacts.descriptor
  const effectiveRouting =
    resolved?.effectiveRouting ??
    resolveEffectiveEndpointRouting({
      profile: input.connection,
      settings,
      contextFacts: facts.contextFacts,
      ...(requestCapability ? { capability: requestCapability } : {}),
      descriptor: finalDescriptor,
      filter: privacyPlan.privacy.filter,
      providerWire: privacyPlan.privacy.wire,
    })
  assertEndpointAvailability(effectiveRouting)
  const finalPrivacyPlan: RequestPrivacyPlan = {
    ...privacyPlan,
    privacy: {
      ...privacyPlan.privacy,
      descriptor: finalDescriptor,
      wire: effectiveRouting.providerWire,
    },
  }
  const mergedTransform = mergePrivacyTransform(input.transform, finalPrivacyPlan.privacy)
  const effectiveCapability = effectiveRouting.requestCapability ?? requestCapability
  const streamsByDefault = effectiveCapability?.streaming !== 'buffered-only'
  const stream = input.stream ?? streamsByDefault
  const requestPlan = await buildAssistantRequestPlan({
    ...input,
    settings,
    stream,
    ...(effectiveCapability ? { capabilities: effectiveCapability } : {}),
    ...(mergedTransform ? { transform: mergedTransform } : {}),
    routing: effectiveRouting.route,
    effectiveRouting,
  })
  return { requestPlan, privacyPlan: finalPrivacyPlan }
}

function assertEndpointAvailability(routing: EffectiveEndpointRouting): void {
  if (routing.endpointAvailability === 'catalog-empty') throw new ProviderCatalogEmptyError()
  if (routing.endpointAvailability === 'filtered-empty') throw new NoEligibleProvidersError()
}

function refineAssistantRequestFacts(input: {
  chat: Chat
  connection: ConnectionProfile
  facts: AssistantRequestFacts
  privacy: ResolvePrivacyForSendResult
}): AssistantRequestFacts {
  const sourceSettings = input.chat.settings
  const descriptor = input.privacy.descriptor ?? input.facts.privacyFacts.descriptor
  const initialRouting = resolveEffectiveEndpointRouting({
    profile: input.connection,
    settings: sourceSettings,
    contextFacts: input.facts.contextFacts,
    ...(input.facts.capability ? { capability: input.facts.capability } : {}),
    descriptor,
    filter: input.privacy.filter,
    providerWire: input.privacy.wire,
  })
  assertEndpointAvailability(initialRouting)
  const capability =
    input.connection.kind === 'openrouter'
      ? initialRouting.requestCapability
      : input.facts.capability
  const settings = capability
    ? validateChatSettings(
        sourceSettings,
        effectiveCapabilityFromDescriptor(sourceSettings.model, capability),
      ).settings
    : sourceSettings
  const preflightRouting = sameChatSettings(settings, sourceSettings)
    ? initialRouting
    : resolveEffectiveEndpointRouting({
        profile: input.connection,
        settings,
        contextFacts: input.facts.contextFacts,
        ...(capability ? { capability } : {}),
        descriptor,
        filter: input.privacy.filter,
        providerWire: input.privacy.wire,
      })
  assertEndpointAvailability(preflightRouting)
  return {
    settings,
    ...(capability ? { capability } : {}),
    contextFacts: input.facts.contextFacts,
    privacyFacts: input.facts.privacyFacts,
    preflightPrivacy: {
      ...input.privacy,
      descriptor,
      wire: preflightRouting.providerWire,
    },
    preflightRouting,
  }
}

function assistantRequestFactsSelectionKey(facts: AssistantRequestFacts): string {
  return stableStringify({
    settings: facts.settings,
    capability: facts.capability ?? null,
    route: assistantRouteContractKey(facts.preflightRouting.route),
    prefillPlan: facts.preflightRouting.prefillPlan,
    endpoints: facts.preflightRouting.selectedEndpoints.map(providerEndpointKey),
    providerWire: facts.preflightRouting.providerWire,
  })
}

function assertMonotoneEndpointReduction(
  previous: EffectiveEndpointRouting,
  next: EffectiveEndpointRouting,
): void {
  const previousKeys = previous.selectedEndpoints.map(providerEndpointKey)
  const nextKeys = next.selectedEndpoints.map(providerEndpointKey)
  const previousSet = new Set(previousKeys)
  if (
    nextKeys.length >= previousKeys.length ||
    nextKeys.some((endpointKey) => !previousSet.has(endpointKey))
  ) {
    throw new Error('AssistantRequestPlanningDidNotConverge')
  }
}

function outputModalitiesForRoute(
  capabilities: CapabilityDescriptor | undefined,
): ReadonlySet<string> | undefined {
  const modalities = capabilities?.architecture?.outputModalities
  return modalities && modalities.length > 0 ? new Set(modalities) : undefined
}

function resolveAssistantRoutingPlanFromMessages(input: {
  connection: ConnectionProfile
  settings: ChatSettings
  capabilities?: CapabilityDescriptor
  pathMessages: readonly Message[]
}): AssistantRoutingPlan {
  return resolveAssistantRoutingPlanFromFacts({
    connection: input.connection,
    settings: input.settings,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    contextFacts: contextRouteFactsFromMessages(input.pathMessages),
  })
}

function resolveAssistantRoutingPlanFromFacts(input: {
  connection: ConnectionProfile
  settings: ChatSettings
  capabilities?: CapabilityDescriptor
  contextFacts: MessageContextRouteFacts
}): AssistantRoutingPlan {
  const quirks = quirksFor(input.settings.model)
  const outputModalities = outputModalitiesForRoute(input.capabilities)
  return resolveAssistantRouteContract(
    input.connection,
    input.settings,
    input.contextFacts,
    outputModalities ? { quirks, outputModalities } : { quirks },
  )
}

async function loadAttachmentEstimateContext(
  messages: readonly Message[],
  settings: ChatSettings,
  preCutAttachmentIds: readonly AttachmentId[] = [],
  resources: AssistantPlanningResources,
): Promise<{ resolver?: AttachmentResolver; hasAttachments: boolean }> {
  const ids = new Set<AttachmentId>(
    attachmentContextIds({
      messages,
      policy: attachmentContextPolicyForSettings(settings),
    }),
  )
  for (const id of preCutAttachmentIds) ids.add(id)
  if (ids.size === 0) return { hasAttachments: false }
  const byId = new Map<AttachmentId, Attachment>()
  await Promise.all(
    [...ids].map(async (id) => {
      const attachment = await resources.getAttachment(id)
      if (attachment) byId.set(id, attachment)
    }),
  )
  return {
    hasAttachments: true,
    resolver: (id) => byId.get(id),
  }
}

async function prepareOpenRouterAttachmentTransform(
  path: readonly Message[],
  settings: ChatSettings,
  resources: AssistantPlanningResources,
): Promise<Pick<ChatCompletionsTransformOptions, 'attachmentPartsByMessageId' | 'extraPlugins'>> {
  const partsByMessageId = new Map<string, unknown[]>()
  const pluginByKey = new Map<string, unknown>()
  const refsByMessageId = resolveAttachmentContextRefs({
    messages: path,
    policy: attachmentContextPolicyForSettings(settings),
  })
  for (const message of path) {
    const refs = refsByMessageId.get(message.id) ?? []
    if (refs.length === 0) continue
    const parts: unknown[] = []
    for (const ref of refs) {
      const bundle = await resources.getAttachmentBundle(ref.attachmentId)
      if (!bundle) continue
      if (bundle.attachment.storage.kind === 'missing') continue
      const wire = await buildStoredOpenRouterAttachmentWire(bundle, {
        ...(ref.presentation.imageDetail ? { imageDetail: ref.presentation.imageDetail } : {}),
      })
      parts.push(...wire.parts)
      for (const plugin of wire.plugins) {
        pluginByKey.set(JSON.stringify(plugin), plugin)
      }
    }
    if (parts.length > 0) partsByMessageId.set(message.id, parts)
  }
  return {
    ...(partsByMessageId.size > 0 ? { attachmentPartsByMessageId: partsByMessageId } : {}),
    ...(pluginByKey.size > 0 ? { extraPlugins: [...pluginByKey.values()] } : {}),
  }
}

function toOpenRouterVideoGeneration(
  settings: ChatSettings,
  path: readonly Message[],
  opts: { privacy?: ChatCompletionsTransformOptions['privacy'] } = {},
): { wire: Record<string, unknown>; requestedModel: string } {
  const prompt = videoPromptFromPath(path)
  const wire: Record<string, unknown> = {
    model: settings.model,
    prompt,
  }
  if (settings.sampling.seed !== undefined) wire.seed = settings.sampling.seed
  if (settings.sampling.temperature !== undefined) wire.temperature = settings.sampling.temperature
  if (settings.sampling.top_p !== undefined) wire.top_p = settings.sampling.top_p
  if (opts.privacy) wire.provider = opts.privacy
  return { wire, requestedModel: settings.model }
}

function videoPromptFromPath(path: readonly Message[]): string {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const message = path[i]
    if (message?.role !== 'user') continue
    const text = contentText(message.content).trim()
    if (text.length > 0) return text
  }
  return path
    .map((message) => contentText(message.content).trim())
    .filter(Boolean)
    .join('\n\n')
}

function contentText(content: readonly ContentItem[]): string {
  return content
    .map((item) => {
      if (item.type === 'text' || item.type === 'output_text') return item.text
      return ''
    })
    .join('')
}

async function buildAssistantRequestPlan(
  input: AssistantRequestPlanInput,
): Promise<AssistantRequestPlan> {
  const storedSettings = input.settings ?? input.chat.settings
  const settings = input.capabilities
    ? validateChatSettings(
        storedSettings,
        effectiveCapabilityFromDescriptor(storedSettings.model, input.capabilities),
      ).settings
    : storedSettings
  const contextProjection = input.contextAlreadySelected
    ? {
        messages: input.pathMessages,
        reasoningCarryForwardByMessageId: input.reasoningCarryForwardByMessageId ?? new Map(),
      }
    : projectOutboundContextRewrites(input.pathMessages, settings)
  const contextPathMessages = contextProjection.messages
  const stream = input.stream ?? true
  const routing =
    input.routing ??
    resolveAssistantRoutingPlanFromMessages({
      connection: input.connection,
      settings,
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      pathMessages: contextPathMessages,
    })
  const effectiveRouting =
    input.effectiveRouting ??
    resolveEffectiveEndpointRouting({
      profile: input.connection,
      settings,
      contextFacts: contextRouteFactsFromMessages(contextPathMessages),
      ...(input.capabilities ? { capability: input.capabilities } : {}),
    })

  const outboundCapCandidate =
    input.capabilities?.maxPromptTokens ?? input.capabilities?.contextLength
  const outboundTokenizer = tokenizerFromSettings(settings, null)
  const reasoningRoute = outboundReasoningRouteForAssistantRoute(routing)
  const reasoningCompiler = input.reasoningResolver
    ? null
    : createOutboundReasoningCompiler(reasoningRoute)
  let reasoningResolver = input.reasoningResolver ?? reasoningCompiler
  if (!reasoningResolver) throw new Error('OutboundReasoningResolverMissing')
  assertOutboundReasoningResolverRoute(reasoningResolver, reasoningRoute)
  const planningGlobals = readPlanningGlobals(input.resources)
  const preCutAttachmentContext = await loadAttachmentEstimateContext(
    contextPathMessages,
    settings,
    input.preCutAttachmentIds,
    input.resources,
  )
  const disableTextCalibration = preCutAttachmentContext.hasAttachments
  const currentTextCharsPerToken =
    settings.model && !disableTextCalibration
      ? charsPerToken(
          settings.model,
          input.chat,
          planningGlobals.globalCalibration,
          planningGlobals.calibrationMode,
        )
      : undefined
  const outboundReasoningOpts: PromptEstimateOptions = {
    family: outboundTokenizer,
    reasoningResolver,
    providerOutput: routing.providerOutput,
    includeToolCalls: settings.toolCallContext.include,
  }
  const cutoffPath = input.contextAlreadySelected
    ? contextPathMessages
    : applyContextCutoff({
        messages: contextPathMessages,
        settings,
        tokenizer: outboundTokenizer,
        providerCap: outboundCapCandidate ?? null,
        reasoningOpts: outboundReasoningOpts,
        disableTextCalibration,
        ...(preCutAttachmentContext.resolver
          ? { attachmentResolver: preCutAttachmentContext.resolver }
          : {}),
        currentModelId: settings.model,
        ...(currentTextCharsPerToken !== undefined ? { currentTextCharsPerToken } : {}),
      })
  const outboundPath = cutoffPath
  if (reasoningCompiler) {
    reasoningResolver = reasoningCompiler.retain(outboundPath)
    outboundReasoningOpts.reasoningResolver = reasoningResolver
  }
  const hasAttachmentContext = attachmentContextHasRefs({
    messages: outboundPath,
    policy: attachmentContextPolicyForSettings(settings),
  })

  let wire: Record<string, unknown>
  let requestedModel: string
  let geminiModelId: string | undefined
  let anthropicModelId: string | undefined
  let reasoningCarryForwardEvidence: ReasoningCarryForwardEvidence
  let reasoningVisibilityEvidence: ReasoningVisibilityEvidence

  if (routing.transport === 'openai-text') {
    const requestedTemplateId = settings.textTemplate ?? 'chatml'
    const templateId =
      requestedTemplateId === 'default' && input.connection.kind !== 'llama-server'
        ? 'chatml'
        : requestedTemplateId
    const template = await input.resources.resolveTextTemplate(
      templateId,
      settings.customTextTemplate,
    )
    let promptSource: Parameters<typeof toTextCompletions>[2]['promptSource']
    if (templateId === 'default' && input.connection.kind === 'llama-server') {
      const projected = projectTextPromptMessagesProjection(
        settings,
        preparePrefillPathForWire(outboundPath, effectiveRouting.prefillPlan),
        routing.reasoning,
        routing.providerOutput,
        {
          reasoningCarryForwardByMessageId: contextProjection.reasoningCarryForwardByMessageId,
          reasoningResolver,
        },
      )
      const serverRendered = await applyServerTemplate(
        input.connection,
        projected.messages.map(({ role, content }) => ({ role, content })),
        input.signal ? { signal: input.signal } : {},
      )
      promptSource = {
        kind: 'server-template',
        rendered: renderedTextPromptFromOpaqueServer(
          serverRendered,
          projected.reasoningCarryForward,
        ),
      }
    } else {
      if (!template) throw new Error(`TextTemplateUnavailable:${templateId}`)
      promptSource = { kind: 'client-template', template }
    }
    const textOpts: Parameters<typeof toTextCompletions>[2] = {
      stream,
      prefillPlan: effectiveRouting.prefillPlan,
      promptSource,
      reasoning: routing.reasoning,
      reasoningResolver,
      providerOutput: routing.providerOutput,
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      allowProviderRouting: input.connection.kind === 'openrouter',
      reasoningDialect:
        input.connection.kind === 'openrouter' ? 'openrouter-text' : 'generic-inline',
      ...(input.transform?.privacy ? { privacy: input.transform.privacy } : {}),
      reasoningCarryForwardByMessageId: contextProjection.reasoningCarryForwardByMessageId,
    }
    const result = toTextCompletions(settings, outboundPath, textOpts)
    wire = result.wire
    requestedModel = result.requestedModel
    reasoningCarryForwardEvidence = result.reasoningCarryForwardEvidence
    reasoningVisibilityEvidence = result.reasoningVisibilityEvidence
  } else {
    const hostedToolsProvider = hostedToolsProviderForConnection(input.connection, settings)
    const rewriteSlug = (slug: string) => rewriteCompatibleModelId(input.connection, slug)
    const openRouterAttachmentTransform =
      input.connection.kind === 'openrouter'
        ? await prepareOpenRouterAttachmentTransform(outboundPath, settings, input.resources)
        : {}
    if (routing.transport === 'openrouter-video') {
      const result = toOpenRouterVideoGeneration(settings, outboundPath, {
        ...(input.transform?.privacy ? { privacy: input.transform.privacy } : {}),
      })
      wire = result.wire
      requestedModel = result.requestedModel
      reasoningCarryForwardEvidence = sealedReasoningCarryForwardEvidence('none')
      reasoningVisibilityEvidence = { kind: 'unavailable' }
    } else if (routing.transport === 'openai-responses') {
      const transformOpts: ResponsesTransformOptions & {
        privacy?: ChatCompletionsTransformOptions['privacy']
      } = {
        stream,
        prefillPlan: effectiveRouting.prefillPlan,
        rewriteSlug,
        reasoning: routing.reasoning,
        reasoningResolver,
        providerOutput: routing.providerOutput,
        allowProviderRouting: input.connection.kind === 'openrouter',
        allowOpenRouterExtensions: input.connection.kind === 'openrouter',
        ...(hostedToolsProvider === 'openrouter' || hostedToolsProvider === 'openai'
          ? { hostedToolsProvider }
          : {}),
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        reasoningCarryForwardByMessageId: contextProjection.reasoningCarryForwardByMessageId,
        ...(input.transform?.privacy ? { privacy: input.transform.privacy } : {}),
      }
      const result = toResponses(settings, outboundPath, transformOpts)
      wire = result.wire
      requestedModel = result.requestedModel
      reasoningCarryForwardEvidence = sealedReasoningCarryForwardEvidence(
        result.reasoningCarryForward,
      )
      reasoningVisibilityEvidence = result.reasoningVisibilityEvidence
    } else if (routing.transport === 'gemini-native') {
      const transformOpts: GeminiNativeTransformOptions = {
        prefillPlan: effectiveRouting.prefillPlan,
        rewriteSlug,
        reasoning: routing.reasoning,
        reasoningResolver,
        providerOutput: routing.providerOutput,
        ...(hostedToolsProvider === 'google' ? { hostedToolsProvider } : {}),
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        reasoningCarryForwardByMessageId: contextProjection.reasoningCarryForwardByMessageId,
      }
      const result = toGeminiNative(settings, outboundPath, transformOpts)
      wire = result.wire
      requestedModel = result.requestedModel
      geminiModelId = result.modelId
      reasoningCarryForwardEvidence = sealedReasoningCarryForwardEvidence(
        result.reasoningCarryForward,
      )
      reasoningVisibilityEvidence = result.reasoningVisibilityEvidence
    } else if (routing.transport === 'anthropic') {
      const transformOpts: AnthropicMessagesTransformOptions = {
        stream,
        prefillPlan: effectiveRouting.prefillPlan,
        rewriteSlug,
        reasoning: routing.reasoning,
        reasoningResolver,
        providerOutput: routing.providerOutput,
        ...(hostedToolsProvider === 'anthropic' ? { hostedToolsProvider } : {}),
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        reasoningCarryForwardByMessageId: contextProjection.reasoningCarryForwardByMessageId,
      }
      const result = toAnthropicMessages(settings, outboundPath, transformOpts)
      wire = result.wire
      requestedModel = result.requestedModel
      anthropicModelId = result.modelId
      reasoningCarryForwardEvidence = sealedReasoningCarryForwardEvidence(
        result.reasoningCarryForward,
      )
      reasoningVisibilityEvidence = result.reasoningVisibilityEvidence
    } else {
      const transformOpts: ChatCompletionsTransformOptions = {
        stream,
        prefillPlan: effectiveRouting.prefillPlan,
        rewriteSlug,
        reasoning: routing.reasoning,
        reasoningResolver,
        providerOutput: routing.providerOutput,
        allowProviderRouting: input.connection.kind === 'openrouter',
        ...(hostedToolsProvider === 'openrouter' ? { hostedToolsProvider } : {}),
        ...openRouterAttachmentTransform,
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(input.transform ?? {}),
        reasoningCarryForwardByMessageId: contextProjection.reasoningCarryForwardByMessageId,
      }
      const result = toChatCompletions(settings, outboundPath, transformOpts)
      wire = result.wire
      requestedModel = result.requestedModel
      reasoningCarryForwardEvidence = sealedReasoningCarryForwardEvidence(
        result.reasoningCarryForward,
      )
      reasoningVisibilityEvidence = result.reasoningVisibilityEvidence
    }
  }

  const attemptRouting = sealAssistantAttemptContract(
    routing,
    resolveAttemptInboundReasoningVisibility(
      routing.reasoning.visibilityPolicy,
      reasoningVisibilityEvidence,
    ),
  )

  return {
    settings,
    ...attemptRouting,
    apiUsed: apiUsedForRoute(attemptRouting),
    requestedModel,
    ...(geminiModelId ? { geminiModelId } : {}),
    ...(anthropicModelId ? { anthropicModelId } : {}),
    wire,
    outboundPath,
    outboundTokenizer,
    outboundReasoningOpts,
    hasAttachmentContext,
    reasoningCarryForwardEvidence,
    effectiveRouting,
    prefillPlan: effectiveRouting.prefillPlan,
  }
}

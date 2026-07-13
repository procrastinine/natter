import { applyServerTemplate } from '../api/probe'
import { normalizeModelsResponse } from '../api/providers'
import { resolveBundledCapability } from '../capabilities'
import { logRequestPlanDebug } from '../lib/debug-streams'
import { getCachedModels } from '../store/models-cache'
import { getWorkspaceRepository } from '../store/workspace-repository'
import { type ApiRoute, apiUsedForRoute, chooseApi } from './api-choice'
import {
  attachmentContextHasRefs,
  attachmentContextIds,
  attachmentContextPolicyForSettings,
  resolveAttachmentContextRefs,
} from './attachments/context'
import { buildStoredOpenRouterAttachmentWire } from './attachments/stored-openrouter'
import { applyContextCutoff } from './context-cutoff'
import { corsProxyConfigFromPrefs, readGlobalPreferences } from './global-settings'
import { pickEquivalentModelId } from './model-selection'
import { type ResolvePrivacyForSendResult, resolvePrivacyForSend } from './privacy-request'
import { applyOutboundContextRewrites } from './prompt-context'
import {
  type AttachmentResolver,
  estimateSettingsPromptSize,
  tokenizerFromSettings,
  UNLIMITED_CONTEXT,
} from './prompt-size'
import {
  type HostedToolProvider,
  hasEnabledHostedTools,
  isOpenAiDirectProfile,
} from './provider-hosted-tools'
import { providerDisplayName, providerRoutingRef } from './provider-identity'
import { isTextCompletionsSelectableFor, quirksFor } from './quirks'
import { resolveTextTemplateFromLibrary } from './text-templates'
import { charsPerToken, readTokenCalibrationGlobal } from './token-calibration'
import type { PromptEstimateOptions } from './tokens'
import type {
  AnthropicMessagesTransformOptions,
  ChatCompletionsTransformOptions,
  GeminiNativeTransformOptions,
  ResponsesTransformOptions,
} from './transforms'
import {
  toAnthropicMessages,
  toChatCompletions,
  toGeminiNative,
  toResponses,
  toTextCompletions,
} from './transforms'
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
} from './types'

function rewriteCompatibleModelId(connection: ConnectionProfile, modelId: string): string {
  if (connection.kind === 'anthropic') {
    return modelId.replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
  }
  return modelId
}

const DIRECT_CAPABILITY_LOOKUP_QUERY = {} as const
// OpenRouter send behavior historically used an ungated superset and let OR
// drop unsupported optional fields. Request-time discovery is used here for
// media routing/caps; it must not narrow normal text/reasoning sends.
// `max_tokens` / `max_completion_tokens` are excluded from the superset because
// they are mutually exclusive aliases whose spelling must come from endpoint
// metadata.
const OPENROUTER_SEND_PARAMETER_SUPERSET = [
  'temperature',
  'top_p',
  'top_k',
  'min_p',
  'top_a',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'seed',
  'logprobs',
  'top_logprobs',
  'stop',
  'logit_bias',
  'cache_prompt',
  'modalities',
  'audio',
  'response_format',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'service_tier',
  'reasoning',
  'verbosity',
  'provider',
  'plugins',
] as const

interface ResolveRequestCapabilityInput {
  profile: ConnectionProfile
  modelId: string
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
  const cachedModels = await getCachedModels(profile.id, DIRECT_CAPABILITY_LOOKUP_QUERY)
  if (!cachedModels) return bundled
  const liveModels = normalizeModelsResponse(cachedModels.payload)
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
  preCutAttachmentIds?: readonly AttachmentId[]
  signal?: AbortSignal
}

interface RequestPrivacyPlan {
  neededTokens?: number
  privacy: ResolvePrivacyForSendResult
}

export async function resolveRequestPrivacyPlan(
  input: RequestPrivacyPlanInput,
): Promise<RequestPrivacyPlan> {
  const settings = input.settings ?? input.chat.settings
  let neededTokens: number | undefined
  const globalPrefs = await readGlobalPreferences()
  try {
    const globalCalibration = await readTokenCalibrationGlobal()
    const attachmentContext = await loadAttachmentEstimateContext(
      input.activePathMessages,
      settings,
      input.preCutAttachmentIds,
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
        globalCalibration,
        mode: globalPrefs.tokenCalibrationMode,
      },
      undefined,
      input.preCutAttachmentIds,
    )
    const reserveRaw = settings.maxCompletionTokens
    const reserve = reserveRaw === UNLIMITED_CONTEXT ? 0 : (reserveRaw ?? 0)
    neededTokens = est.total + reserve
  } catch (err) {
    console.error('resolveRequestPrivacyPlan: failed to estimate prompt size', err)
  }
  const chatForRequest = settings === input.chat.settings ? input.chat : { ...input.chat, settings }
  const privacy = await resolvePrivacyForSend({
    chat: chatForRequest,
    profile: input.profile,
    proxy: corsProxyConfigFromPrefs(globalPrefs),
    ...(neededTokens !== undefined ? { neededTokens } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return neededTokens !== undefined ? { neededTokens, privacy } : { privacy }
}

export type AssistantRequestTransform = Partial<ChatCompletionsTransformOptions>

interface AssistantRequestPlanInput {
  chat: Chat
  connection: ConnectionProfile
  pathMessages: Message[]
  capabilities?: CapabilityDescriptor
  transform?: AssistantRequestTransform
  signal?: AbortSignal
  settings?: ChatSettings
  stream?: boolean
  debugSource?: string
  preCutAttachmentIds?: readonly AttachmentId[]
}

export interface AssistantRequestPlan {
  settings: ChatSettings
  useTextProtocol: boolean
  route: ApiRoute | null
  apiUsed: GenerationMeta['apiUsed']
  requestedModel: string
  geminiModelId?: string
  anthropicModelId?: string
  wire: Record<string, unknown>
  outboundPath: Message[]
  outboundTokenizer: ReturnType<typeof tokenizerFromSettings>
  outboundReasoningOpts: PromptEstimateOptions
  hasAttachmentContext: boolean
}

export class NoEligibleProvidersError extends Error {
  constructor() {
    super('No eligible providers can serve this request.')
    this.name = 'NoEligibleProvidersError'
  }
}

interface PreparedAssistantRequestPlan {
  requestPlan: AssistantRequestPlan
  privacyPlan: RequestPrivacyPlan
}

function mergePrivacyTransform(
  transform: Partial<ChatCompletionsTransformOptions> | undefined,
  privacy: ResolvePrivacyForSendResult,
): Partial<ChatCompletionsTransformOptions> | undefined {
  if (!privacy.wire) return transform
  return { ...(transform ?? {}), privacy: privacy.wire }
}

function requestCapabilityFromPrivacy(
  privacy: ResolvePrivacyForSendResult,
): CapabilityDescriptor | undefined {
  const endpoints = privacy.filter?.kept.map((row) => row.endpoint) ?? []
  if (endpoints.length === 0) return undefined
  const supported = new Set<string>(OPENROUTER_SEND_PARAMETER_SUPERSET)
  const inputModalities = new Set<'text' | 'image' | 'audio' | 'video' | 'file'>()
  const outputModalities = new Set<'text' | 'image' | 'audio' | 'video'>()
  for (const modality of privacy.descriptor?.architecture?.input_modalities ?? []) {
    if (
      modality === 'text' ||
      modality === 'image' ||
      modality === 'audio' ||
      modality === 'video' ||
      modality === 'file'
    ) {
      inputModalities.add(modality)
    }
  }
  for (const modality of privacy.descriptor?.architecture?.output_modalities ?? []) {
    if (
      modality === 'text' ||
      modality === 'image' ||
      modality === 'audio' ||
      modality === 'video'
    ) {
      outputModalities.add(modality)
    }
  }
  let contextLength = privacy.descriptor?.contextLength
  let maxPromptTokens: number | undefined
  let maxCompletionTokens: number | undefined
  for (const endpoint of endpoints) {
    for (const param of endpoint.supported_parameters) supported.add(param)
    for (const modality of endpoint.architecture?.input_modalities ?? []) {
      if (
        modality === 'text' ||
        modality === 'image' ||
        modality === 'audio' ||
        modality === 'video' ||
        modality === 'file'
      ) {
        inputModalities.add(modality)
      }
    }
    for (const modality of endpoint.architecture?.output_modalities ?? []) {
      if (
        modality === 'text' ||
        modality === 'image' ||
        modality === 'audio' ||
        modality === 'video'
      ) {
        outputModalities.add(modality)
      }
    }
    if (endpoint.context_length > 0) {
      contextLength = Math.max(contextLength ?? 0, endpoint.context_length)
    }
    if (endpoint.max_prompt_tokens !== undefined && endpoint.max_prompt_tokens > 0) {
      maxPromptTokens = Math.max(maxPromptTokens ?? 0, endpoint.max_prompt_tokens)
    }
    if (endpoint.max_completion_tokens !== undefined && endpoint.max_completion_tokens > 0) {
      maxCompletionTokens = Math.max(maxCompletionTokens ?? 0, endpoint.max_completion_tokens)
    }
  }
  const descriptor: CapabilityDescriptor = {
    supportedParameters: [...supported],
    streaming: 'supported',
    architecture: {
      inputModalities: inputModalities.size > 0 ? [...inputModalities] : ['text'],
      outputModalities: outputModalities.size > 0 ? [...outputModalities] : ['text'],
    },
  }
  if (contextLength !== undefined) descriptor.contextLength = contextLength
  if (maxPromptTokens !== undefined) descriptor.maxPromptTokens = maxPromptTokens
  if (maxCompletionTokens !== undefined) descriptor.maxCompletionTokens = maxCompletionTokens
  return descriptor
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
  const settings = input.settings ?? input.chat.settings
  const [privacyPlan, resolvedCapability] = await Promise.all([
    resolveRequestPrivacyPlan({
      chat: input.chat,
      profile: input.connection,
      activePathMessages: input.pathMessages,
      draftText: input.draftText ?? '',
      settings,
      ...(input.preCutAttachmentIds ? { preCutAttachmentIds: input.preCutAttachmentIds } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }),
    input.capabilities || !settings.model
      ? Promise.resolve(input.capabilities)
      : resolveRequestCapability({
          profile: input.connection,
          modelId: settings.model,
        }),
  ])
  if (privacyPlan.privacy.wire?.zeroEligible ?? privacyPlan.privacy.filter?.zeroEligible) {
    throw new NoEligibleProvidersError()
  }
  const mergedTransform = mergePrivacyTransform(input.transform, privacyPlan.privacy)
  const requestCapability = resolvedCapability ?? requestCapabilityFromPrivacy(privacyPlan.privacy)
  const streamsByDefault = requestCapability?.streaming !== 'buffered-only'
  const stream = input.stream ?? streamsByDefault
  const requestPlan = await buildAssistantRequestPlan({
    ...input,
    settings,
    stream,
    ...(requestCapability ? { capabilities: requestCapability } : {}),
    ...(mergedTransform ? { transform: mergedTransform } : {}),
  })
  logPreparedPlan(input.debugSource ?? 'unknown', input, requestPlan, privacyPlan)
  return { requestPlan, privacyPlan }
}

function logPreparedPlan(
  source: string,
  input: AssistantRequestPlanInput & { draftText?: string },
  requestPlan: AssistantRequestPlan,
  privacyPlan: RequestPrivacyPlan,
): void {
  logRequestPlanDebug('prepared', {
    source,
    chatId: input.chat.id,
    profile: {
      id: input.connection.id,
      name: input.connection.name,
      kind: input.connection.kind,
      baseUrl: input.connection.baseUrl,
    },
    model: {
      settings: requestPlan.settings.model,
      requested: requestPlan.requestedModel,
      wire: typeof requestPlan.wire.model === 'string' ? requestPlan.wire.model : undefined,
    },
    route: requestPlan.route,
    useTextProtocol: requestPlan.useTextProtocol,
    tokens: {
      needed: privacyPlan.neededTokens,
      inputMessages: input.pathMessages.length,
      outboundMessages: requestPlan.outboundPath.length,
      removedByContext: Math.max(0, input.pathMessages.length - requestPlan.outboundPath.length),
      customMaxContext: requestPlan.settings.customMaxContext,
      maxCompletionTokens: requestPlan.settings.maxCompletionTokens,
    },
    provider: {
      prefs: summarizeProviderPrefs(requestPlan.settings.providerPrefs),
      wire: summarizeWireProvider(requestPlan.wire.provider),
      contextIgnored: privacyPlan.privacy.contextIgnoredProviders,
      privacy: summarizePrivacy(privacyPlan.privacy),
    },
    request: requestPlan.wire,
    wireShape: summarizeWireShape(requestPlan.wire),
  })
}

function summarizeProviderPrefs(prefs: ChatSettings['providerPrefs']): unknown {
  if (!prefs) return null
  return {
    sort: prefs.sort,
    only: prefs.only,
    ignore: prefs.ignore,
    order: prefs.order,
    ignoreOverridesFilter: prefs.ignoreOverridesFilter,
    requireParameters: prefs.requireParameters,
  }
}

function summarizeWireProvider(provider: unknown): unknown {
  if (!provider || typeof provider !== 'object') return null
  const value = provider as Record<string, unknown>
  return {
    allow_fallbacks: value.allow_fallbacks,
    data_collection: value.data_collection,
    zdr: value.zdr,
    sort: value.sort,
    only: value.only,
    ignore: value.ignore,
    order: value.order,
    require_parameters: value.require_parameters,
  }
}

function summarizePrivacy(privacy: ResolvePrivacyForSendResult): unknown {
  const filter = privacy.filter
  return {
    applicable: privacy.applicable,
    zeroEligible: filter?.zeroEligible ?? false,
    kept:
      filter?.kept.map((row) => ({
        provider: providerDisplayName(row.endpoint),
        ref: providerRoutingRef(row.endpoint),
      })) ?? [],
    excluded:
      filter?.excluded.map((row) => ({
        provider: providerDisplayName(row.endpoint),
        ref: providerRoutingRef(row.endpoint),
        reasons: row.reasons,
      })) ?? [],
  }
}

function summarizeWireShape(wire: Record<string, unknown>): unknown {
  const prompt = textPreview(wire.prompt)
  const instructions = textPreview(wire.instructions)
  return {
    hasProvider: wire.provider !== undefined,
    hasMessages: Array.isArray(wire.messages),
    messages: Array.isArray(wire.messages) ? wire.messages.length : undefined,
    hasInput: Array.isArray(wire.input),
    input: Array.isArray(wire.input) ? wire.input.length : undefined,
    hasPrompt: typeof wire.prompt === 'string',
    ...(prompt ? { prompt } : {}),
    hasInstructions: typeof wire.instructions === 'string',
    ...(instructions ? { instructions } : {}),
    hasSystemInstruction: wire.systemInstruction !== undefined,
    stream: wire.stream,
  }
}

function textPreview(value: unknown): { length: number; preview: string } | undefined {
  if (typeof value !== 'string') return undefined
  const limit = 240
  if (value.length <= limit) return { length: value.length, preview: value }
  return {
    length: value.length,
    preview: `${value.slice(0, limit - 1)}…`,
  }
}

function outputModalitiesForRoute(
  capabilities: CapabilityDescriptor | undefined,
): ReadonlySet<string> | undefined {
  const modalities = capabilities?.architecture?.outputModalities
  return modalities && modalities.length > 0 ? new Set(modalities) : undefined
}

async function loadAttachmentEstimateContext(
  messages: readonly Message[],
  settings: ChatSettings,
  preCutAttachmentIds: readonly AttachmentId[] = [],
): Promise<{ resolver?: AttachmentResolver; hasAttachments: boolean }> {
  const ids = new Set<AttachmentId>(
    attachmentContextIds({
      messages,
      policy: attachmentContextPolicyForSettings(settings),
    }),
  )
  for (const id of preCutAttachmentIds) ids.add(id)
  if (ids.size === 0) return { hasAttachments: false }
  const repo = getWorkspaceRepository()
  const byId = new Map<AttachmentId, Attachment>()
  await Promise.all(
    [...ids].map(async (id) => {
      const attachment = await repo.getAttachment(id)
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
): Promise<Pick<ChatCompletionsTransformOptions, 'attachmentPartsByMessageId' | 'extraPlugins'>> {
  const repo = getWorkspaceRepository()
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
      const bundle = await repo.getAttachmentBundle(ref.attachmentId)
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
  const settings = input.settings ?? input.chat.settings
  const contextPathMessages = applyOutboundContextRewrites(input.pathMessages, settings)
  const stream = input.stream ?? true
  const useOpenRouterTextProtocol =
    settings.api === 'text' &&
    input.connection.kind === 'openrouter' &&
    isTextCompletionsSelectableFor(settings.model)
  const useTextProtocol =
    (settings.protocol === 'text' && input.connection.kind === 'llama-server') ||
    useOpenRouterTextProtocol

  const outboundCapCandidate =
    input.capabilities?.maxPromptTokens ?? input.capabilities?.contextLength
  const outboundQuirks = quirksFor(settings.model)
  const outboundTokenizer = tokenizerFromSettings(settings, null)
  const [globalCalibration, globalPrefs] = await Promise.all([
    readTokenCalibrationGlobal(),
    readGlobalPreferences(),
  ])
  const preCutAttachmentContext = await loadAttachmentEstimateContext(
    contextPathMessages,
    settings,
    input.preCutAttachmentIds,
  )
  const disableTextCalibration = preCutAttachmentContext.hasAttachments
  const currentTextCharsPerToken =
    settings.model && !disableTextCalibration
      ? charsPerToken(
          settings.model,
          input.chat,
          globalCalibration,
          globalPrefs.tokenCalibrationMode,
        )
      : undefined
  const outboundReasoningOpts: PromptEstimateOptions = {
    family: outboundTokenizer,
    reasoningInclude: settings.reasoning.include,
    reasoningExcluded: settings.reasoning.exclude === true,
    includeToolCalls: settings.toolCallContext.include,
  }
  if (outboundQuirks.reasoningPreservationFormat !== undefined) {
    outboundReasoningOpts.reasoningPreservationFormat = outboundQuirks.reasoningPreservationFormat
  }
  const cutoffPath = applyContextCutoff({
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
  const hasAttachmentContext = attachmentContextHasRefs({
    messages: outboundPath,
    policy: attachmentContextPolicyForSettings(settings),
  })

  let wire: Record<string, unknown>
  let requestedModel: string
  let route: ApiRoute | null = null
  let geminiModelId: string | undefined
  let anthropicModelId: string | undefined

  if (useTextProtocol) {
    const requestedTemplateId = settings.textTemplate ?? 'chatml'
    const templateId =
      requestedTemplateId === 'default' && input.connection.kind !== 'llama-server'
        ? 'chatml'
        : requestedTemplateId
    const template = await resolveTextTemplateFromLibrary(templateId, settings.customTextTemplate)
    let prerenderedPrompt: string | undefined
    if (templateId === 'default' && input.connection.kind === 'llama-server') {
      const messages: Array<{ role: string; content: string }> = []
      if (settings.systemPrompt.length > 0) {
        messages.push({ role: 'system', content: settings.systemPrompt })
      }
      for (const m of outboundPath) {
        const text = m.content
          .filter((c) => c.type === 'text' || c.type === 'output_text')
          .map((c) => ('text' in c ? c.text : ''))
          .join('')
        messages.push({ role: m.role, content: text })
      }
      prerenderedPrompt = await applyServerTemplate(
        input.connection,
        messages,
        input.signal ? { signal: input.signal } : {},
      )
    }
    const textOpts: Parameters<typeof toTextCompletions>[2] = {
      stream,
      template,
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      allowProviderRouting: input.connection.kind === 'openrouter',
      ...(input.transform?.privacy ? { privacy: input.transform.privacy } : {}),
      ...(prerenderedPrompt !== undefined ? { prerenderedPrompt } : {}),
    }
    const result = toTextCompletions(settings, outboundPath, textOpts)
    wire = result.wire
    requestedModel = result.requestedModel
    if (useOpenRouterTextProtocol) {
      route = {
        kind: 'text-completions',
        transport: 'openai-text',
        reason: 'user pinned Text completions',
      }
    }
  } else {
    const hostedToolsProvider = hostedToolsProviderForConnection(input.connection, settings)
    const outputModalities = outputModalitiesForRoute(input.capabilities)
    const routeCaps = outputModalities
      ? { quirks: quirksFor(settings.model), outputModalities }
      : { quirks: quirksFor(settings.model) }
    route = chooseApi(input.connection, settings, outboundPath, routeCaps)
    const rewriteSlug = (slug: string) => rewriteCompatibleModelId(input.connection, slug)
    const routeFormat = quirksFor(settings.model).reasoningPreservationFormat
    const openRouterAttachmentTransform =
      input.connection.kind === 'openrouter'
        ? await prepareOpenRouterAttachmentTransform(outboundPath, settings)
        : {}
    if (route.transport === 'openrouter-video') {
      const result = toOpenRouterVideoGeneration(settings, outboundPath, {
        ...(input.transform?.privacy ? { privacy: input.transform.privacy } : {}),
      })
      wire = result.wire
      requestedModel = result.requestedModel
    } else if (route.transport === 'openai-responses') {
      const transformOpts: ResponsesTransformOptions & {
        privacy?: ChatCompletionsTransformOptions['privacy']
      } = {
        stream,
        rewriteSlug,
        allowProviderRouting: input.connection.kind === 'openrouter',
        allowOpenRouterExtensions: input.connection.kind === 'openrouter',
        ...(hostedToolsProvider === 'openrouter' || hostedToolsProvider === 'openai'
          ? { hostedToolsProvider }
          : {}),
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(routeFormat !== undefined ? { reasoningPreservationFormat: routeFormat } : {}),
        ...(input.transform?.privacy ? { privacy: input.transform.privacy } : {}),
      }
      const result = toResponses(settings, outboundPath, transformOpts)
      wire = result.wire
      requestedModel = result.requestedModel
    } else if (route.transport === 'gemini-native') {
      const transformOpts: GeminiNativeTransformOptions = {
        stream,
        rewriteSlug,
        ...(hostedToolsProvider === 'google' ? { hostedToolsProvider } : {}),
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(routeFormat !== undefined ? { reasoningPreservationFormat: routeFormat } : {}),
      }
      const result = toGeminiNative(settings, outboundPath, transformOpts)
      wire = result.wire
      requestedModel = result.requestedModel
      geminiModelId = result.modelId
    } else if (route.transport === 'anthropic') {
      const transformOpts: AnthropicMessagesTransformOptions = {
        stream,
        rewriteSlug,
        ...(hostedToolsProvider === 'anthropic' ? { hostedToolsProvider } : {}),
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(routeFormat !== undefined ? { reasoningPreservationFormat: routeFormat } : {}),
      }
      const result = toAnthropicMessages(settings, outboundPath, transformOpts)
      wire = result.wire
      requestedModel = result.requestedModel
      anthropicModelId = result.modelId
    } else {
      const transformOpts: ChatCompletionsTransformOptions = {
        stream,
        rewriteSlug,
        allowProviderRouting: input.connection.kind === 'openrouter',
        ...(hostedToolsProvider === 'openrouter' ? { hostedToolsProvider } : {}),
        ...openRouterAttachmentTransform,
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(input.transform ?? {}),
      }
      const result = toChatCompletions(settings, outboundPath, transformOpts)
      wire = result.wire
      requestedModel = result.requestedModel
    }
  }

  return {
    settings,
    useTextProtocol,
    route,
    apiUsed: apiUsedForRoute(route, useTextProtocol),
    requestedModel,
    ...(geminiModelId ? { geminiModelId } : {}),
    ...(anthropicModelId ? { anthropicModelId } : {}),
    wire,
    outboundPath,
    outboundTokenizer,
    outboundReasoningOpts,
    hasAttachmentContext,
  }
}

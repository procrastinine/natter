import { applyServerTemplate } from '../api/probe'
import { chooseApi, type ApiRoute } from './api-choice'
import { resolveBundledCapability } from '../capabilities'
import { readGlobalPreferences } from './global-settings'
import { estimateSettingsPromptSize, tokenizerFromSettings, UNLIMITED_CONTEXT } from './prompt-size'
import { resolvePrivacyForSend, type ResolvePrivacyForSendResult } from './privacy-request'
import { providerDisplayName, providerRoutingRef } from './provider-identity'
import { isTextCompletionsSelectableFor, quirksFor } from './quirks'
import { charsPerToken, readTokenCalibrationGlobal } from './token-calibration'
import type { PromptEstimateOptions } from './tokens'
import type { CapabilityDescriptor, Chat, ChatSettings, ConnectionProfile, Message } from './types'
import type {
  ChatCompletionsTransformOptions,
  GeminiNativeTransformOptions,
  ResponsesTransformOptions,
} from './transforms'
import { toChatCompletions, toGeminiNative, toResponses, toTextCompletions } from './transforms'
import { applyContextCutoff } from './context-cutoff'
import { resolveTextTemplateFromLibrary } from './text-templates'
import { getCachedModels } from '../store/models-cache'
import { normalizeModelsResponse } from '../api/providers'
import { logRequestPlanDebug } from '../lib/debug-streams'

function rewriteCompatibleModelId(connection: ConnectionProfile, modelId: string): string {
  if (connection.kind === 'anthropic') {
    return modelId.replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
  }
  return modelId
}

const DIRECT_CAPABILITY_LOOKUP_QUERY = {} as const

function idsEquivalent(left: string, right: string): boolean {
  return (
    left.replace(/(\d)[.-](\d)(?=-|$)/g, '$1:$2') === right.replace(/(\d)[.-](\d)(?=-|$)/g, '$1:$2')
  )
}

export interface ResolveRequestCapabilityInput {
  profile: ConnectionProfile
  modelId: string
}

export async function resolveRequestCapability(
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
  const liveEntry =
    normalizeModelsResponse(cachedModels.payload).find((row) => idsEquivalent(row.id, modelId)) ??
    null
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

export interface RequestPrivacyPlanInput {
  chat: Chat
  profile: ConnectionProfile
  activePathMessages: Message[]
  draftText: string
  settings?: ChatSettings
  signal?: AbortSignal
}

export interface RequestPrivacyPlan {
  neededTokens?: number
  privacy: ResolvePrivacyForSendResult
}

export async function resolveRequestPrivacyPlan(
  input: RequestPrivacyPlanInput,
): Promise<RequestPrivacyPlan> {
  const settings = input.settings ?? input.chat.settings
  let neededTokens: number | undefined
  try {
    const [globalPrefs, globalCalibration] = await Promise.all([
      readGlobalPreferences(),
      readTokenCalibrationGlobal(),
    ])
    const est = estimateSettingsPromptSize(
      settings,
      input.activePathMessages,
      input.draftText,
      null,
      null,
      undefined,
      {
        chatTokenCalibration: input.chat.tokenCalibration,
        globalCalibration,
        mode: globalPrefs.tokenCalibrationMode,
      },
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
    ...(neededTokens !== undefined ? { neededTokens } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return neededTokens !== undefined ? { neededTokens, privacy } : { privacy }
}

export interface AssistantRequestPlanInput {
  chat: Chat
  connection: ConnectionProfile
  pathMessages: Message[]
  capabilities?: CapabilityDescriptor
  transform?: Partial<ChatCompletionsTransformOptions>
  signal?: AbortSignal
  settings?: ChatSettings
  stream?: boolean
  debugSource?: string
}

export interface AssistantRequestPlan {
  settings: ChatSettings
  useTextProtocol: boolean
  route: ApiRoute | null
  requestedModel: string
  geminiModelId?: string
  wire: Record<string, unknown>
  outboundPath: Message[]
  outboundTokenizer: ReturnType<typeof tokenizerFromSettings>
  outboundReasoningOpts: PromptEstimateOptions
}

export class NoEligibleProvidersError extends Error {
  constructor() {
    super('No eligible providers can serve this request.')
    this.name = 'NoEligibleProvidersError'
  }
}

export interface PreparedAssistantRequestPlan {
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
  const requestPlan = await buildAssistantRequestPlan({
    ...input,
    settings,
    ...(resolvedCapability ? { capabilities: resolvedCapability } : {}),
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

export async function buildAssistantRequestPlan(
  input: AssistantRequestPlanInput,
): Promise<AssistantRequestPlan> {
  const settings = input.settings ?? input.chat.settings
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
  const currentTextCharsPerToken = settings.model
    ? charsPerToken(settings.model, input.chat, globalCalibration, globalPrefs.tokenCalibrationMode)
    : undefined
  const outboundReasoningOpts: PromptEstimateOptions = {
    family: outboundTokenizer,
    reasoningInclude: settings.reasoning.include,
    reasoningExcluded: settings.reasoning.exclude === true,
  }
  if (outboundQuirks.reasoningPreservationFormat !== undefined) {
    outboundReasoningOpts.reasoningPreservationFormat = outboundQuirks.reasoningPreservationFormat
  }
  const outboundPath = applyContextCutoff({
    messages: input.pathMessages,
    settings,
    tokenizer: outboundTokenizer,
    providerCap: outboundCapCandidate ?? null,
    reasoningOpts: outboundReasoningOpts,
    currentModelId: settings.model,
    ...(currentTextCharsPerToken !== undefined ? { currentTextCharsPerToken } : {}),
  })

  let wire: Record<string, unknown>
  let requestedModel: string
  let route: ApiRoute | null = null
  let geminiModelId: string | undefined

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
    wire = result.wire as unknown as Record<string, unknown>
    requestedModel = result.requestedModel
    if (useOpenRouterTextProtocol) {
      route = {
        kind: 'text-completions',
        transport: 'openai-text',
        reason: 'user pinned Text completions',
      }
    }
  } else {
    route = chooseApi(input.connection, settings, outboundPath, {
      quirks: quirksFor(settings.model),
    })
    const rewriteSlug = (slug: string) => rewriteCompatibleModelId(input.connection, slug)
    const routeFormat = quirksFor(settings.model).reasoningPreservationFormat
    if (route.transport === 'openai-responses') {
      const transformOpts: ResponsesTransformOptions & {
        privacy?: ChatCompletionsTransformOptions['privacy']
      } = {
        stream,
        rewriteSlug,
        allowProviderRouting: input.connection.kind === 'openrouter',
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(routeFormat !== undefined ? { reasoningPreservationFormat: routeFormat } : {}),
        ...(input.transform?.privacy ? { privacy: input.transform.privacy } : {}),
      }
      const result = toResponses(settings, outboundPath, transformOpts)
      wire = result.wire as unknown as Record<string, unknown>
      requestedModel = result.requestedModel
    } else if (route.transport === 'gemini-native') {
      const transformOpts: GeminiNativeTransformOptions = {
        stream,
        rewriteSlug,
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(routeFormat !== undefined ? { reasoningPreservationFormat: routeFormat } : {}),
      }
      const result = toGeminiNative(settings, outboundPath, transformOpts)
      wire = result.wire as unknown as Record<string, unknown>
      requestedModel = result.requestedModel
      geminiModelId = result.modelId
    } else {
      const transformOpts: ChatCompletionsTransformOptions = {
        stream,
        rewriteSlug,
        allowProviderRouting: input.connection.kind === 'openrouter',
        ...(input.capabilities ? { capabilities: input.capabilities } : {}),
        ...(input.transform ?? {}),
      }
      const result = toChatCompletions(settings, outboundPath, transformOpts)
      wire = result.wire as unknown as Record<string, unknown>
      requestedModel = result.requestedModel
    }
  }

  return {
    settings,
    useTextProtocol,
    route,
    requestedModel,
    ...(geminiModelId ? { geminiModelId } : {}),
    wire,
    outboundPath,
    outboundTokenizer,
    outboundReasoningOpts,
  }
}

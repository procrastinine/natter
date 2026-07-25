// The model's tokenizer isn't available; the estimator approximates with a
// family-keyed char/token ratio. The number is ONLY used for UI context
// gauges and for the truncation preview; the authoritative token count comes
// from the stream's `usage.prompt_tokens`.
//
// The estimate covers the active path, the system prompt, and the composer
// draft. Attachments flow through `./media-context-tokens.ts`, which wraps
// the shared LibreChat/OpenRouter media heuristics in `./media-tokens.ts`.
// Callers that have an attachment table pass `attachmentResolver` to unlock
// dimensions / page-count / bytes aware estimates; without it the estimator
// falls back to conservative family-specific constants.
//
// Reasoning echo projects each assistant envelope through the selected route's
// replay contract. The estimator consumes that same projection, including its
// visibility and compatibility decisions, so the gauge and final wire agree.

import type { AssistantRouteContract } from './api-choice'
import {
  attachmentContextHasRefs,
  attachmentContextPolicyForSettings,
  DRAFT_ATTACHMENT_CONTEXT_ID,
  resolveAttachmentContextRefs,
} from './attachments/context'

export { UNLIMITED_CONTEXT } from './context-budget'

import { computeCutoffPlan } from './context-cutoff'
import {
  type AttachmentResolver,
  mediaTokensForMessage,
  mediaTokensForRefs,
} from './media-context-tokens'
import {
  assertOutboundReasoningResolverRoute,
  createOutboundReasoningCompiler,
  type OutboundReasoningResolver,
  type OutboundReasoningRoute,
  outboundReasoningRouteForAssistantRoute,
  outboundReasoningRouteForReplayContract,
  resolveOutboundReasoningResolver,
} from './outbound-reasoning'
import { applyOutboundContextRewrites } from './prompt-context'
import {
  type AttemptProviderOutputContract,
  TEXT_PROVIDER_OUTPUT_CONTRACT,
} from './provider-tool-context'
import { quirksFor } from './quirks'
import {
  type ReasoningReplayContract,
  reasoningPolicyForSettings,
  sealReasoningReplayContract,
} from './reasoning'
import { type CalibrationMode, charsPerToken, readPathTextTokenEstimate } from './token-calibration'
import { clampTokens, safeContent, safeServerTokens } from './token-guards'
import {
  estimateReasoningEchoTokens,
  estimateTokens,
  estimateToolCallContextTokens,
  type PromptEstimateOptions,
  type TokenizerFamily,
  tokenizerFamily,
} from './tokens'
import type {
  AttachmentId,
  AttachmentRef,
  ChatSettings,
  GlobalTokenCalibration,
  MediaContextStrategy,
  Message,
  TokenCalibrationSample,
} from './types'

export type { AttachmentResolver } from './media-context-tokens'

export interface PromptSizeEstimateInput {
  systemPrompt: string
  activePathMessages: Message[]
  draftText: string
  tokenizer: TokenizerFamily
  // The generation path passes its sealed route contract. UI-only estimates
  // use the same shape, projected from settings before a request exists.
  // When omitted, reasoning contributes zero.
  reasoning?: ReasoningReplayContract
  reasoningRoute?: OutboundReasoningRoute
  reasoningResolver?: OutboundReasoningResolver
  providerOutput?: AttemptProviderOutputContract
  includeToolCalls?: boolean
  // Optional — unlocks attachment-aware image / PDF heuristics. Callers
  // without the attachment table fall through to the fallback values.
  attachmentResolver?: AttachmentResolver
  draftAttachmentRefs?: readonly AttachmentRef[]
  mediaContextStrategy?: MediaContextStrategy
  mediaEchoN?: number
  disablePromptUsageBaseline?: boolean
  // Optional — the chat's CURRENT model ID. When present, per-message
  // token estimates can choose between same-bucket delta tracking and
  // cross-model fresh recompute. When absent, the read path falls back
  // to the cached estimate when it exists.
  currentModelId?: string
  // Optional — resolved chars/token ratio for the CURRENT model under the
  // caller's chosen calibration mode (per-chat → global → family anchor).
  // When present, same-bucket rows use original-token + edit-delta math and
  // other-model rows recompute fresh under this model. When absent, the
  // estimator falls back to the message cache or to the family anchor.
  currentTextCharsPerToken?: number
  disableTextCalibration?: boolean
  contextRewriteKey?: string
}

interface TokenEstimateCalibrationContext {
  chatTokenCalibration?: Record<string, TokenCalibrationSample> | undefined
  globalCalibration?: GlobalTokenCalibration | null | undefined
  mode?: CalibrationMode | undefined
}

export interface PromptSizeContextReuse {
  readonly contextAlreadySelected?: boolean
  readonly reasoningResolver?: OutboundReasoningResolver
}

export interface PromptSizeEstimate {
  systemTokens: number
  historyTokens: number
  draftTokens: number
  mediaTokens: number
  reasoningTokens: number
  toolCallTokens: number
  total: number
}

function messageHasMediaContext(message: Message): boolean {
  if ((message.attachmentRefs?.length ?? 0) > 0) return true
  return safeContent(message.content).some(
    (item) =>
      item.type === 'image_url' ||
      item.type === 'output_image' ||
      item.type === 'file' ||
      item.type === 'input_audio' ||
      item.type === 'video_url' ||
      item.type === 'output_video' ||
      item.type === 'audio_output',
  )
}

function calibratedBaselineUsable(messages: readonly Message[], baselineIdx: number): boolean {
  for (let i = 0; i < baselineIdx; i += 1) {
    const message = messages[i]
    if (!message) continue
    if (message.deleted || message.hiddenFromContext) return false
    if (messageHasMediaContext(message)) return false
  }
  return true
}

// Whether a cached per-message media estimate can be trusted. We keep this
// exact-model keyed: media cost is cheap to recompute and the raw model id
// still matters for the rest of the send path.
function cacheEligibleFor(m: Message, currentModelId: string | undefined): boolean {
  if (currentModelId === undefined) return true
  if (m.originalModelId === undefined) return true
  return m.originalModelId === currentModelId
}

// Per-message text-token estimate. Prefers `cachedTokenEstimate` when
// model/family matches; falls back to fresh char-based estimate.
function textTokensForMessage(
  m: Message,
  family: TokenizerFamily,
  currentModelId: string | undefined,
  currentTextCharsPerToken: number | undefined,
  disableTextCalibration: boolean | undefined,
): number {
  return readPathTextTokenEstimate({
    message: m,
    family,
    currentModelId,
    currentTextCharsPerToken,
    disableCalibration: disableTextCalibration,
  })
}

// Per-message media-token estimate. Prefers `cachedMediaTokens` when
// model/family matches; falls back to attachment-aware / fallback heuristic.
function estimatedMediaTokensForMessage(
  m: Message,
  family: TokenizerFamily,
  currentModelId: string | undefined,
  resolver: AttachmentResolver | undefined,
  contextRefs: readonly AttachmentRef[] | undefined,
): number {
  if (
    contextRefs === undefined &&
    cacheEligibleFor(m, currentModelId) &&
    typeof m.cachedMediaTokens === 'number' &&
    Number.isFinite(m.cachedMediaTokens)
  ) {
    return m.cachedMediaTokens
  }
  return mediaTokensForMessage(m, family, resolver, contextRefs, {
    ...(currentModelId !== undefined ? { modelId: currentModelId } : {}),
  })
}

function contextRefsForMessage(
  refsByOwner: ReadonlyMap<string, readonly AttachmentRef[]>,
  messageId: string,
): readonly AttachmentRef[] {
  return refsByOwner.get(messageId) ?? []
}

function pathHasVisibilityExclusions(messages: readonly Message[]): boolean {
  return messages.some((message) => message.deleted || message.hiddenFromContext)
}

export function estimatePromptSize(input: PromptSizeEstimateInput): PromptSizeEstimate {
  const family = input.tokenizer
  const reasoningResolver = input.reasoning
    ? resolveOutboundReasoningResolver(
        input.reasoningRoute ?? outboundReasoningRouteForReplayContract(input.reasoning),
        input.reasoningResolver,
      )
    : undefined
  const systemTokens = estimateTokens(input.systemPrompt, family)
  const attachmentRefsByOwner = resolveAttachmentContextRefs({
    messages: input.activePathMessages,
    policy: {
      mediaContextStrategy: input.mediaContextStrategy ?? 'echo-all',
      ...(input.mediaEchoN !== undefined ? { mediaEchoN: input.mediaEchoN } : {}),
    },
    ...(input.draftAttachmentRefs
      ? { draft: { refs: input.draftAttachmentRefs, role: 'user' } }
      : {}),
  })

  // A character-based fallback estimate always runs so edits,
  // deletions, and inserts between sends are reflected immediately;
  // the provider-reported `prompt_tokens` on older assistant messages
  // is frozen at the time of that request and can lie about current
  // path content. The final number is max(fallback, calibrated) to
  // stay honest even when either side is stale.
  let fallbackHistory = 0
  let fallbackMedia = 0
  const visiblePath: Message[] = []
  for (const m of input.activePathMessages) {
    if (m.deleted || m.hiddenFromContext) continue
    visiblePath.push(m)
    fallbackHistory += textTokensForMessage(
      m,
      family,
      input.currentModelId,
      input.currentTextCharsPerToken,
      input.disableTextCalibration,
    )
    fallbackMedia += estimatedMediaTokensForMessage(
      m,
      family,
      input.currentModelId,
      input.attachmentResolver,
      contextRefsForMessage(attachmentRefsByOwner, m.id),
    )
  }
  const draftMediaTokens = mediaTokensForRefs(
    attachmentRefsByOwner.get(DRAFT_ATTACHMENT_CONTEXT_ID),
    family,
    input.attachmentResolver,
    { ...(input.currentModelId !== undefined ? { modelId: input.currentModelId } : {}) },
  )

  // Provider-calibrated estimate: use the LATEST reported usage on the
  // active path as a baseline, then estimate only the deltas after it.
  // `safeServerTokens` rejects negatives / NaN / non-number so a malicious
  // or buggy server can't poison the baseline.
  let baselineIdx = -1
  let baselinePromptTokens: number | undefined
  for (let i = input.activePathMessages.length - 1; i >= 0; i -= 1) {
    const m = input.activePathMessages[i]
    if (!m || m.deleted || m.hiddenFromContext) continue
    if (m.role !== 'assistant') continue
    const validated = safeServerTokens(m.generation?.usage?.prompt_tokens)
    if (validated !== undefined && validated > 0) {
      baselineIdx = i
      baselinePromptTokens = validated
      break
    }
  }

  let calibratedHistory = fallbackHistory
  let calibratedMedia = fallbackMedia
  if (
    input.disablePromptUsageBaseline !== true &&
    baselinePromptTokens !== undefined &&
    baselineIdx >= 0 &&
    calibratedBaselineUsable(input.activePathMessages, baselineIdx)
  ) {
    let preBaselineMedia = 0
    const preBaselineVisible: Message[] = []
    for (let i = 0; i < baselineIdx; i += 1) {
      const m = input.activePathMessages[i]
      if (!m || m.deleted || m.hiddenFromContext) continue
      preBaselineVisible.push(m)
      preBaselineMedia += estimatedMediaTokensForMessage(
        m,
        family,
        input.currentModelId,
        input.attachmentResolver,
        contextRefsForMessage(attachmentRefsByOwner, m.id),
      )
    }
    let preBaselineReasoning = 0
    let preBaselineToolCalls = 0
    if (reasoningResolver && input.providerOutput) {
      const opts: PromptEstimateOptions = {
        family,
        reasoningResolver,
        providerOutput: input.providerOutput,
        includeToolCalls: input.includeToolCalls === true,
      }
      preBaselineReasoning = estimateReasoningEchoTokens(preBaselineVisible, opts)
      preBaselineToolCalls = estimateToolCallContextTokens(preBaselineVisible, opts)
    }
    let h = Math.max(
      0,
      baselinePromptTokens -
        systemTokens -
        preBaselineMedia -
        preBaselineReasoning -
        preBaselineToolCalls,
    )
    let media = 0
    const baseline = input.activePathMessages[baselineIdx]
    if (baseline && !baseline.deleted && !baseline.hiddenFromContext) {
      h += textTokensForMessage(
        baseline,
        family,
        input.currentModelId,
        input.currentTextCharsPerToken,
        input.disableTextCalibration,
      )
      media += estimatedMediaTokensForMessage(
        baseline,
        family,
        input.currentModelId,
        input.attachmentResolver,
        contextRefsForMessage(attachmentRefsByOwner, baseline.id),
      )
    }
    for (let i = baselineIdx + 1; i < input.activePathMessages.length; i += 1) {
      const m = input.activePathMessages[i]
      if (!m || m.deleted || m.hiddenFromContext) continue
      h += textTokensForMessage(
        m,
        family,
        input.currentModelId,
        input.currentTextCharsPerToken,
        input.disableTextCalibration,
      )
      media += estimatedMediaTokensForMessage(
        m,
        family,
        input.currentModelId,
        input.attachmentResolver,
        contextRefsForMessage(attachmentRefsByOwner, m.id),
      )
    }
    calibratedHistory = h
    calibratedMedia = media
  }
  // Conservative: never report below the char-based estimate so edits
  // that grew a pre-baseline message are still reflected.
  const historyTokens = Math.max(calibratedHistory, fallbackHistory)
  const mediaTokens = Math.max(calibratedMedia, fallbackMedia) + draftMediaTokens
  const draftTokens = estimateTokens(input.draftText, family)

  // Reasoning echo is computed from visible path only (hiddenFromContext +
  // deleted have already been filtered). Each assistant message with
  // `reasoningDetails[]` contributes the tokens whose `ReasoningInclude`
  // flag is on AND whose `hidden` flag is off, gated further by
  // preservation-format match for encrypted carriers.
  let reasoningTokens = 0
  let toolCallTokens = 0
  if (reasoningResolver && input.providerOutput) {
    const opts: PromptEstimateOptions = {
      family,
      reasoningResolver,
      providerOutput: input.providerOutput,
      includeToolCalls: input.includeToolCalls === true,
    }
    reasoningTokens = estimateReasoningEchoTokens(visiblePath, opts)
    toolCallTokens = estimateToolCallContextTokens(visiblePath, opts)
  }

  return {
    systemTokens: clampTokens(systemTokens),
    historyTokens: clampTokens(historyTokens),
    draftTokens: clampTokens(draftTokens),
    mediaTokens: clampTokens(mediaTokens),
    reasoningTokens: clampTokens(reasoningTokens),
    toolCallTokens: clampTokens(toolCallTokens),
    total: clampTokens(
      systemTokens + historyTokens + draftTokens + mediaTokens + reasoningTokens + toolCallTokens,
    ),
  }
}

const EMPTY_FROZEN_MESSAGE_IDS = new Set<string>()

function attachmentRefSignature(refs: readonly AttachmentRef[] | undefined): unknown[] {
  if (!refs) return []
  return refs.map((ref) => ({
    refId: ref.refId,
    attachmentId: ref.attachmentId,
    includeInContext: ref.includeInContext !== false,
    pdfTier: ref.presentation.pdfTier ?? null,
    deletedAt: ref.deletedAt ?? null,
  }))
}

function attachmentEvidenceSignature(
  input: PromptSizeEstimateInput,
  frozenMessageIds: ReadonlySet<string>,
): unknown[] {
  if (!input.attachmentResolver) return []
  const refsByOwner = resolveAttachmentContextRefs({
    messages: input.activePathMessages,
    policy: {
      mediaContextStrategy: input.mediaContextStrategy ?? 'echo-all',
      ...(input.mediaEchoN !== undefined ? { mediaEchoN: input.mediaEchoN } : {}),
    },
    ...(input.draftAttachmentRefs
      ? { draft: { refs: input.draftAttachmentRefs, role: 'user' as const } }
      : {}),
  })
  const ids = new Set<AttachmentId>()
  for (const message of input.activePathMessages) {
    if (message.deleted || message.hiddenFromContext) continue
    if (frozenMessageIds.has(message.id)) continue
    const refs = contextRefsForMessage(refsByOwner, message.id)
    const visibleIds =
      message.attachmentRefs === undefined ? null : new Set(refs.map((ref) => ref.attachmentId))
    for (const item of safeContent(message.content)) {
      const id = 'attachmentId' in item ? item.attachmentId : undefined
      if (id && (visibleIds === null || visibleIds.has(id))) ids.add(id)
    }
    for (const ref of refs) ids.add(ref.attachmentId)
  }
  for (const ref of refsByOwner.get(DRAFT_ATTACHMENT_CONTEXT_ID) ?? []) {
    ids.add(ref.attachmentId)
  }
  return [...ids].sort().map((id) => [id, attachmentTokenEvidence(input.attachmentResolver?.(id))])
}

function attachmentTokenEvidence(attachment: ReturnType<AttachmentResolver>): unknown {
  if (!attachment) return null
  if (attachment.storage.kind === 'missing') return ['missing']
  if (attachment.kind === 'image') {
    return [
      'image',
      attachment.dimensions?.width ?? null,
      attachment.dimensions?.height ?? null,
      attachment.sizeBytes ?? null,
    ]
  }
  if (attachment.kind === 'pdf') {
    return ['pdf', attachment.pageCount ?? null, attachment.sizeBytes ?? null]
  }
  return ['available', attachment.kind]
}

export function promptEstimateInputSignature(
  input: PromptSizeEstimateInput,
  frozenMessageIds: ReadonlySet<string> = EMPTY_FROZEN_MESSAGE_IDS,
): string {
  return JSON.stringify({
    systemPrompt: input.systemPrompt,
    contextRewriteKey: input.contextRewriteKey ?? '',
    draftText: input.draftText,
    draftAttachmentRefs: attachmentRefSignature(input.draftAttachmentRefs),
    tokenizer: input.tokenizer,
    mediaContextStrategy: input.mediaContextStrategy ?? 'echo-all',
    mediaEchoN: input.mediaEchoN ?? null,
    disablePromptUsageBaseline: input.disablePromptUsageBaseline === true,
    disableTextCalibration: input.disableTextCalibration === true,
    currentModelId: input.currentModelId ?? null,
    currentTextCharsPerToken: input.currentTextCharsPerToken ?? null,
    reasoning: input.reasoning ?? null,
    reasoningRouteKind: input.reasoningRoute?.kind ?? null,
    providerOutput: input.providerOutput ?? null,
    includeToolCalls: input.includeToolCalls === true,
    activePathMessages: input.activePathMessages.map((message) =>
      frozenMessageIds.has(message.id)
        ? {
            id: message.id,
            frozen: true,
            editedAt: message.editedAt ?? null,
            hiddenFromContext: message.hiddenFromContext === true,
            deleted: message.deleted,
            parentId: message.parentId,
          }
        : { id: message.id, nodeVersion: message.nodeVersion },
    ),
    attachmentEvidence: attachmentEvidenceSignature(input, frozenMessageIds),
  })
}

export function buildSettingsPromptSizeEstimateInput(
  settings: ChatSettings,
  activePathMessages: readonly Message[],
  draftText: string,
  endpointTokenizer: string | null | undefined,
  // Provider/model cap. When provided AND the user hasn't set an explicit
  // `customMaxContext`, this becomes the cutoff used by the head+tail trim.
  // Pass `null` to skip cutoff entirely unless the user set `customMaxContext`
  // themselves (e.g. the send pipeline when capability hasn't loaded).
  providerCap: number | null = null,
  attachmentResolver?: AttachmentResolver,
  calibration?: TokenEstimateCalibrationContext,
  draftAttachmentRefs?: readonly AttachmentRef[],
  preCutAttachmentIds?: readonly AttachmentId[],
  routing?: AssistantRouteContract,
  contextReuse?: PromptSizeContextReuse,
): PromptSizeEstimateInput {
  const reasoning = routing?.reasoning ?? estimateReasoningContractForSettings(settings)
  const providerOutput = routing?.providerOutput ?? TEXT_PROVIDER_OUTPUT_CONTRACT
  const tokenizer = tokenizerFromSettings(settings, endpointTokenizer ?? null)
  const contextPathMessages = contextReuse?.contextAlreadySelected
    ? [...activePathMessages]
    : applyOutboundContextRewrites(activePathMessages, settings)
  const attachmentPolicy = attachmentContextPolicyForSettings(settings)
  const preCutHasAttachments = (preCutAttachmentIds?.length ?? 0) > 0
  const contextHasAttachments =
    preCutHasAttachments ||
    attachmentContextHasRefs({
      messages: contextPathMessages,
      policy: attachmentPolicy,
      ...(draftAttachmentRefs ? { draft: { refs: draftAttachmentRefs, role: 'user' } } : {}),
    })
  const currentTextCharsPerToken =
    calibration && settings.model && !contextHasAttachments
      ? charsPerToken(
          settings.model,
          { tokenCalibration: calibration.chatTokenCalibration },
          calibration.globalCalibration ?? null,
          calibration.mode,
        )
      : undefined

  const reasoningRoute = routing
    ? outboundReasoningRouteForAssistantRoute(routing)
    : outboundReasoningRouteForReplayContract(reasoning)
  const reasoningCompiler = contextReuse?.reasoningResolver
    ? null
    : createOutboundReasoningCompiler(reasoningRoute)
  let reasoningResolver = contextReuse?.reasoningResolver ?? reasoningCompiler
  if (!reasoningResolver) throw new Error('PromptSizeReasoningResolverMissing')
  assertOutboundReasoningResolverRoute(reasoningResolver, reasoningRoute)
  const reasoningOpts: PromptEstimateOptions = {
    family: tokenizer,
    reasoningResolver,
    providerOutput,
    includeToolCalls: settings.toolCallContext.include,
  }

  const plan = contextReuse?.contextAlreadySelected
    ? { kept: contextPathMessages, applied: false }
    : computeCutoffPlan({
        messages: contextPathMessages,
        settings,
        tokenizer,
        providerCap,
        draftText,
        ...(draftAttachmentRefs ? { draftAttachmentRefs } : {}),
        reasoningOpts,
        ...(attachmentResolver !== undefined ? { attachmentResolver } : {}),
        currentModelId: settings.model,
        ...(contextHasAttachments ? { disableTextCalibration: true } : {}),
        ...(currentTextCharsPerToken !== undefined ? { currentTextCharsPerToken } : {}),
      })
  if (reasoningCompiler) reasoningResolver = reasoningCompiler.retain(plan.kept)
  const baselineInvalidated =
    plan.applied || contextHasAttachments || pathHasVisibilityExclusions(contextPathMessages)

  const input: PromptSizeEstimateInput = {
    systemPrompt: settings.systemPrompt,
    activePathMessages: plan.kept,
    draftText,
    ...(draftAttachmentRefs ? { draftAttachmentRefs } : {}),
    tokenizer,
    ...(attachmentPolicy.mediaContextStrategy !== undefined
      ? { mediaContextStrategy: attachmentPolicy.mediaContextStrategy }
      : {}),
    ...(attachmentPolicy.mediaEchoN !== undefined
      ? { mediaEchoN: attachmentPolicy.mediaEchoN }
      : {}),
    ...(baselineInvalidated ? { disablePromptUsageBaseline: true } : {}),
    reasoning,
    reasoningRoute,
    reasoningResolver,
    providerOutput,
    includeToolCalls: settings.toolCallContext.include,
    ...(attachmentResolver !== undefined ? { attachmentResolver } : {}),
    currentModelId: settings.model,
    ...(settings.appendPrompt.length > 0 ? { contextRewriteKey: settings.appendPrompt } : {}),
    ...(contextHasAttachments ? { disableTextCalibration: true } : {}),
    ...(currentTextCharsPerToken !== undefined ? { currentTextCharsPerToken } : {}),
  }
  return input
}

export function estimateReasoningContractForSettings(
  settings: ChatSettings,
): ReasoningReplayContract {
  const quirks = quirksFor(settings.model)
  return sealReasoningReplayContract(
    reasoningPolicyForSettings(settings, {
      ...(quirks.acceptsAnthropicRedactedThinking !== undefined
        ? { acceptsAnthropicRedactedThinking: quirks.acceptsAnthropicRedactedThinking }
        : {}),
    }),
    quirks.reasoningPreservationFormat,
    'plaintext-only',
    'unknown',
  )
}

export function estimateSettingsPromptSize(
  settings: ChatSettings,
  activePathMessages: readonly Message[],
  draftText: string,
  endpointTokenizer: string | null | undefined,
  // Provider/model cap. When provided AND the user hasn't set an explicit
  // `customMaxContext`, this becomes the cutoff used by the head+tail trim.
  // Pass `null` to skip cutoff entirely unless the user set `customMaxContext`
  // themselves (e.g. the send pipeline when capability hasn't loaded).
  providerCap: number | null = null,
  attachmentResolver?: AttachmentResolver,
  calibration?: TokenEstimateCalibrationContext,
  draftAttachmentRefs?: readonly AttachmentRef[],
  preCutAttachmentIds?: readonly AttachmentId[],
  routing?: AssistantRouteContract,
  contextReuse?: PromptSizeContextReuse,
): PromptSizeEstimate {
  return estimatePromptSize(
    buildSettingsPromptSizeEstimateInput(
      settings,
      activePathMessages,
      draftText,
      endpointTokenizer,
      providerCap,
      attachmentResolver,
      calibration,
      draftAttachmentRefs,
      preCutAttachmentIds,
      routing,
      contextReuse,
    ),
  )
}

export function tokenizerFromSettings(
  settings: ChatSettings,
  endpointTokenizer: string | null | undefined,
): TokenizerFamily {
  if (endpointTokenizer) return tokenizerFamily(endpointTokenizer)
  const model = settings.model.toLowerCase()
  if (model.includes('claude')) return 'claude'
  if (model.includes('gpt') || model.includes('openai')) return 'gpt'
  if (model.includes('gemini')) return 'gemini'
  if (model.includes('llama')) return 'llama'
  if (model.includes('mistral')) return 'mistral'
  if (model.includes('deepseek')) return 'deepseek'
  if (model.includes('qwen')) return 'qwen'
  return 'unknown'
}

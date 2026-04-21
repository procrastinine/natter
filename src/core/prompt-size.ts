// Rough pre-send prompt-size estimate. See `plan/14-details.md §14.15` for
// the tokenization ratio; `plan/10-ui.md §10.9` for the gauge this feeds.
//
// We do not have the model's tokenizer; we approximate with a family-keyed
// char/token ratio. The number is ONLY used for UI context gauges and for
// the truncation preview — the authoritative token count comes from the
// stream's `usage.prompt_tokens`.
//
// The estimate covers the active path, the system prompt, and the composer
// draft. Attachments flow through LibreChat-style per-family heuristics in
// `./media-tokens.ts` (image: `(w*h)/512 + 85` OpenAI, `(w*h)/750` Claude;
// PDF: pages × per-family rate; all × 1.05 safety margin). Callers that
// have an attachment table pass `attachmentResolver` to unlock
// dimensions / page-count / bytes aware estimates; without it we fall
// back to conservative family-specific constants.
//
// Reasoning echo: when an assistant message carries `reasoningDetails[]`,
// the next turn echoes the subset allowed by the chat's `ReasoningInclude`
// flags (`encrypted` / `summary` / `text`) back in the wire. That costs
// prompt tokens — `filterReasoningForInclude` + `estimateReasoningEchoTokens`
// live in `core/tokens.ts` and `core/reasoning.ts` respectively. Per-block
// `hidden: true` is honored inside the filter, so toggling the eye on a
// reasoning row drops its contribution from the gauge.

import { activePath } from './active-path'
import { computeCutoffPlan } from './context-cutoff'
import {
  GENERIC_FILE_TOKEN_FALLBACK,
  imageTokenEstimate,
  type PdfMeta,
  pdfTokenEstimate,
} from './media-tokens'
import { quirksFor } from './quirks'
import { clampTokens, safeContent, safeServerTokens } from './token-guards'
import {
  estimateReasoningEchoTokens,
  estimateTokens,
  type PromptEstimateOptions,
  type TokenizerFamily,
  tokenizerFamily,
} from './tokens'
import type {
  Attachment,
  AttachmentId,
  ChatSettings,
  Message,
  ReasoningFormat,
  ReasoningInclude,
} from './types'

// Optional attachment resolver — when the caller can look up attachments
// (e.g. the Context panel in a page that has the attachment table loaded),
// pass this so image/PDF estimates use real dimensions / byte counts /
// page counts. Callers that don't have an attachment table (e.g. the
// compose-time check) fall through to the fallback heuristics.
export type AttachmentResolver = (id: AttachmentId) => Attachment | undefined

export interface PromptSizeEstimateInput {
  systemPrompt: string
  activePathMessages: Message[]
  draftText: string
  tokenizer: TokenizerFamily
  // Caller opts in by passing these; when omitted, reasoning contributes
  // zero to the total (backcompat with pre-Phase-11 callers). The Context
  // panel and composer gauge always pass them so toggling the three
  // Include checkboxes updates the number live.
  reasoningInclude?: ReasoningInclude
  reasoningPreservationFormat?: ReasoningFormat
  reasoningExcluded?: boolean
  // Optional — unlocks attachment-aware image / PDF heuristics. Callers
  // without the attachment table fall through to the fallback values.
  attachmentResolver?: AttachmentResolver
  // Optional — the chat's CURRENT model ID. When present, per-message
  // `cachedTokenEstimate` / `cachedMediaTokens` are trusted only when
  // the message's `originalModelId` matches (or is undefined, for
  // pre-Phase-B rows). When absent, the cache is used whenever present.
  currentModelId?: string
}

export interface PromptSizeEstimate {
  systemTokens: number
  historyTokens: number
  draftTokens: number
  mediaTokens: number
  reasoningTokens: number
  total: number
}

function mediaTokenCountFor(
  content: unknown,
  family: TokenizerFamily,
  resolver?: AttachmentResolver,
): number {
  let tokens = 0
  for (const item of safeContent(content)) {
    if (item.type === 'image_url' || item.type === 'output_image') {
      const att = item.attachmentId ? resolver?.(item.attachmentId) : undefined
      tokens += imageTokenEstimate(family, {
        ...(att?.dimensions?.width !== undefined ? { width: att.dimensions.width } : {}),
        ...(att?.dimensions?.height !== undefined ? { height: att.dimensions.height } : {}),
      })
    }
    if (item.type === 'file') {
      const att = item.attachmentId ? resolver?.(item.attachmentId) : undefined
      if (att?.kind === 'pdf') {
        const meta: PdfMeta = {}
        if (att.pageCount !== undefined) meta.pageCount = att.pageCount
        if (att.sizeBytes !== undefined) meta.sizeBytes = att.sizeBytes
        tokens += pdfTokenEstimate(family, meta)
      } else if (item.mime === 'application/pdf') {
        // We don't have the attachment resolved but the ContentItem
        // itself tells us it's a PDF. Use the fallback heuristic.
        tokens += pdfTokenEstimate(family, {})
      } else {
        tokens += GENERIC_FILE_TOKEN_FALLBACK
      }
    }
  }
  return tokens
}

function plainTextOf(content: unknown): string {
  let out = ''
  for (const item of safeContent(content)) {
    if (item.type === 'text' || item.type === 'output_text') {
      if (typeof item.text === 'string') out += item.text
    }
  }
  return out
}

// Whether a cached per-message estimate can be trusted. When the caller
// knows the chat's `currentModelId`, cache is valid only if the message's
// `originalModelId` matches (or is undefined — Phase B backcompat).
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
): number {
  if (
    cacheEligibleFor(m, currentModelId) &&
    typeof m.cachedTokenEstimate === 'number' &&
    Number.isFinite(m.cachedTokenEstimate)
  ) {
    return m.cachedTokenEstimate
  }
  return estimateTokens(plainTextOf(m.content), family)
}

// Per-message media-token estimate. Prefers `cachedMediaTokens` when
// model/family matches; falls back to attachment-aware / fallback heuristic.
function mediaTokensForMessage(
  m: Message,
  family: TokenizerFamily,
  currentModelId: string | undefined,
  resolver: AttachmentResolver | undefined,
): number {
  if (
    cacheEligibleFor(m, currentModelId) &&
    typeof m.cachedMediaTokens === 'number' &&
    Number.isFinite(m.cachedMediaTokens)
  ) {
    return m.cachedMediaTokens
  }
  return mediaTokenCountFor(m.content, family, resolver)
}

export function estimatePromptSize(input: PromptSizeEstimateInput): PromptSizeEstimate {
  const family = input.tokenizer
  const systemTokens = estimateTokens(input.systemPrompt, family)

  // We always compute a character-based fallback estimate so edits,
  // deletions, and inserts between sends are reflected immediately —
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
    fallbackHistory += textTokensForMessage(m, family, input.currentModelId)
    fallbackMedia += mediaTokensForMessage(
      m,
      family,
      input.currentModelId,
      input.attachmentResolver,
    )
  }

  // Provider-calibrated estimate — use the LATEST reported usage on the
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
  if (baselinePromptTokens !== undefined && baselineIdx >= 0) {
    let h = Math.max(0, baselinePromptTokens - systemTokens)
    let media = 0
    const baseline = input.activePathMessages[baselineIdx]
    if (baseline && !baseline.deleted && !baseline.hiddenFromContext) {
      h += textTokensForMessage(baseline, family, input.currentModelId)
      media += mediaTokensForMessage(
        baseline,
        family,
        input.currentModelId,
        input.attachmentResolver,
      )
    }
    for (let i = baselineIdx + 1; i < input.activePathMessages.length; i += 1) {
      const m = input.activePathMessages[i]
      if (!m || m.deleted || m.hiddenFromContext) continue
      h += textTokensForMessage(m, family, input.currentModelId)
      media += mediaTokensForMessage(m, family, input.currentModelId, input.attachmentResolver)
    }
    calibratedHistory = h
    calibratedMedia = media
  }
  // Conservative: never report below the char-based estimate so edits
  // that grew a pre-baseline message are still reflected.
  const historyTokens = Math.max(calibratedHistory, fallbackHistory)
  const mediaTokens = Math.max(calibratedMedia, fallbackMedia)
  const draftTokens = estimateTokens(input.draftText, family)

  // Reasoning echo is computed from visible path only (we already
  // filtered hiddenFromContext + deleted). Each assistant message with
  // `reasoningDetails[]` contributes the tokens whose `ReasoningInclude`
  // flag is on AND whose `hidden` flag is off, gated further by
  // preservation-format match for encrypted carriers.
  let reasoningTokens = 0
  if (input.reasoningInclude) {
    const opts: PromptEstimateOptions = {
      family,
      reasoningInclude: input.reasoningInclude,
      reasoningExcluded: input.reasoningExcluded ?? false,
    }
    if (input.reasoningPreservationFormat !== undefined) {
      opts.reasoningPreservationFormat = input.reasoningPreservationFormat
    }
    reasoningTokens = estimateReasoningEchoTokens(visiblePath, opts)
  }

  return {
    systemTokens: clampTokens(systemTokens),
    historyTokens: clampTokens(historyTokens),
    draftTokens: clampTokens(draftTokens),
    mediaTokens: clampTokens(mediaTokens),
    reasoningTokens: clampTokens(reasoningTokens),
    total: clampTokens(systemTokens + historyTokens + draftTokens + mediaTokens + reasoningTokens),
  }
}

const EMPTY_FROZEN_MESSAGE_IDS = new Set<string>()

export function promptEstimateInputSignature(
  input: PromptSizeEstimateInput,
  frozenMessageIds: ReadonlySet<string> = EMPTY_FROZEN_MESSAGE_IDS,
): string {
  return JSON.stringify({
    systemPrompt: input.systemPrompt,
    draftText: input.draftText,
    tokenizer: input.tokenizer,
    reasoningInclude: input.reasoningInclude ?? null,
    reasoningPreservationFormat: input.reasoningPreservationFormat ?? null,
    reasoningExcluded: input.reasoningExcluded ?? false,
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
  })
}

export function estimateSettingsPromptSize(
  settings: ChatSettings,
  activePathMessages: Message[],
  draftText: string,
  endpointTokenizer: string | null | undefined,
  // Provider/model cap — when provided AND the user hasn't set an explicit
  // `customMaxContext`, this becomes the cutoff used by the head+tail trim.
  // Pass `null` to skip cutoff entirely unless the user set `customMaxContext`
  // themselves (e.g. the send pipeline when capability hasn't loaded).
  providerCap: number | null = null,
  attachmentResolver?: AttachmentResolver,
): PromptSizeEstimate {
  const quirks = quirksFor(settings.model)
  const tokenizer = tokenizerFromSettings(settings, endpointTokenizer ?? null)

  const reasoningOpts: PromptEstimateOptions = {
    family: tokenizer,
    reasoningInclude: settings.reasoning.include,
    reasoningExcluded: settings.reasoning.exclude === true,
  }
  if (quirks.reasoningPreservationFormat !== undefined) {
    reasoningOpts.reasoningPreservationFormat = quirks.reasoningPreservationFormat
  }

  const plan = computeCutoffPlan({
    messages: activePathMessages,
    settings,
    tokenizer,
    providerCap,
    draftText,
    reasoningOpts,
    ...(attachmentResolver !== undefined ? { attachmentResolver } : {}),
    currentModelId: settings.model,
  })

  // When cutoff excluded any message, the calibrated trick (which subtracts
  // baseline `prompt_tokens` − systemTokens to get history tokens) is no
  // longer valid — that baseline was measured against a superset path.
  // Return the plan's char-based numbers directly.
  if (plan.applied) {
    return {
      systemTokens: plan.systemTokens,
      historyTokens: plan.historyTextTokens,
      draftTokens: plan.draftTokens,
      mediaTokens: plan.historyMediaTokens,
      reasoningTokens: plan.historyReasoningTokens,
      total: plan.total,
    }
  }

  // Nothing was trimmed → the kept path equals the visible path, so the
  // old calibrated estimator is still valid and more accurate for models
  // whose char-ratio is a poor fit.
  const input: PromptSizeEstimateInput = {
    systemPrompt: settings.systemPrompt,
    activePathMessages: plan.kept,
    draftText,
    tokenizer,
    reasoningInclude: settings.reasoning.include,
    reasoningExcluded: settings.reasoning.exclude === true,
    ...(attachmentResolver !== undefined ? { attachmentResolver } : {}),
    currentModelId: settings.model,
  }
  if (quirks.reasoningPreservationFormat !== undefined) {
    input.reasoningPreservationFormat = quirks.reasoningPreservationFormat
  }
  return estimatePromptSize(input)
}

// Sentinel value for `customMaxContext` / `maxCompletionTokens` meaning
// "no cap — rely on provider limits or OpenRouter middle-out compression."
// The user types `-1` into the numeric input; we keep the stored value as
// -1 so preset/chat round-tripping preserves intent, but budget math
// treats it as `Infinity`.
export const UNLIMITED_CONTEXT = -1

export function resolveContextCap(stored: number | undefined, providerCap: number): number {
  if (stored === UNLIMITED_CONTEXT) return Number.POSITIVE_INFINITY
  return stored ?? providerCap
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

export { activePath }

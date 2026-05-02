// Head+tail message cutoff applied to the active path at send time (and,
// for live feedback, at gauge time). A "pair" is user-anchored: one user
// message plus every non-user message (assistant / tool / mid-chat system)
// between that user message and the next one. Any messages before the
// first user message form the "preamble" (system prompts, orphan leading
// assistants imported from transcripts) and always ride along.
//
// Budget math:
//   available = cutoff − systemPromptTokens − preambleTokens − draftTokens
//              − reserveForCompletion
//
// where `cutoff` is `customMaxContext` (resolving `-1` → Infinity,
// `undefined` → providerCap when known), and `reserveForCompletion` is
// `maxCompletionTokens` (`-1` / undefined → 0).
//
// Algorithm:
//   1. Group the visible path into preamble + user-anchored pairs.
//   2. Start with the first N pairs as head (`keepFirstPairs`); if their
//      cumulative cost already exceeds `available`, shrink N until it fits.
//   3. Walk pairs backward from the end (skipping head indices),
//      accumulating tokens. Stop at the first pair that doesn't fit. That
//      contiguous suffix is the tail.
//
// Complexity: O(|path|) across two linear sweeps. Per-message cost
// computation (text + media + reasoning echo + tool-call context) runs exactly once, then is
// summed into the pair/preamble buckets.
//
// `estimateSingleMessageReasoningEchoTokens` in `./tokens.ts` is the only
// non-trivial part of per-message cost; the cutoff calls it directly so the
// number matches what the wire/echo layer actually sends on the NEXT turn.
//
// Applied only when `settings.contextStrategy.kind === 'sliding_window'`.
// `'off'` and `'middle_out_plugin'` both short-circuit with "send all";
// the former because the user opted out, the latter because OpenRouter's
// server-side plugin compresses what remains.

import {
  attachmentContextPolicyForSettings,
  DRAFT_ATTACHMENT_CONTEXT_ID,
  resolveAttachmentContextRefs,
} from './attachments/context'
import {
  type AttachmentResolver,
  mediaTokensForMessage,
  mediaTokensForRefs,
} from './media-context-tokens'
import { resolveContextCap, UNLIMITED_CONTEXT } from './prompt-size'
import { readPathTextTokenEstimate } from './token-calibration'
import { clampTokens } from './token-guards'
import {
  estimateReasoningEchoTokensForMessage,
  estimateTokens,
  estimateToolCallContextTokensForMessage,
  type PromptEstimateOptions,
  type TokenizerFamily,
} from './tokens'
import type { AttachmentRef, ChatSettings, Message, MessageId } from './types'

export interface MessageCostOptions {
  family: TokenizerFamily
  // Optional — when omitted, reasoning contributes 0 (same policy as
  // `estimatePromptSize` when `reasoningInclude` is absent).
  reasoningOpts?: PromptEstimateOptions
  // Optional — unlocks attachment-aware image / PDF heuristics. Without
  // it, media tokens fall back to constant values (see media-tokens.ts).
  attachmentResolver?: AttachmentResolver
  attachmentRefsByMessageId?: ReadonlyMap<MessageId, readonly AttachmentRef[]>
  // Optional — the chat's CURRENT model ID. Text-token estimation uses it to
  // decide whether a message stays in the same calibration bucket; when
  // omitted, the read path falls back to cache/fresh heuristics.
  currentModelId?: string
  // Optional — resolved chars/token ratio for the CURRENT model. When
  // present, same-bucket rows use original-token + edit-delta math and
  // other-model rows recompute under this model.
  currentTextCharsPerToken?: number
  disableTextCalibration?: boolean
}

interface MessageCost {
  text: number
  media: number
  reasoning: number
  toolCalls: number
  total: number
}

function cacheEligible(m: Message, currentModelId: string | undefined): boolean {
  if (currentModelId === undefined) return true
  if (m.originalModelId === undefined) return true
  return m.originalModelId === currentModelId
}

export function messageCost(m: Message, opts: MessageCostOptions): MessageCost {
  const eligible = cacheEligible(m, opts.currentModelId)
  const text = readPathTextTokenEstimate({
    message: m,
    family: opts.family,
    currentModelId: opts.currentModelId,
    currentTextCharsPerToken: opts.currentTextCharsPerToken,
    disableCalibration: opts.disableTextCalibration,
  })
  const contextRefs =
    opts.attachmentRefsByMessageId === undefined
      ? undefined
      : (opts.attachmentRefsByMessageId.get(m.id) ?? [])
  const media =
    contextRefs === undefined &&
    eligible &&
    typeof m.cachedMediaTokens === 'number' &&
    Number.isFinite(m.cachedMediaTokens)
      ? m.cachedMediaTokens
      : mediaTokensForMessage(m, opts.family, opts.attachmentResolver, contextRefs, {
          ...(opts.currentModelId !== undefined ? { modelId: opts.currentModelId } : {}),
        })
  const reasoning = opts.reasoningOpts
    ? estimateReasoningEchoTokensForMessage(m, opts.reasoningOpts)
    : 0
  const toolCalls = opts.reasoningOpts
    ? estimateToolCallContextTokensForMessage(m, opts.reasoningOpts)
    : 0
  return { text, media, reasoning, toolCalls, total: text + media + reasoning + toolCalls }
}

interface PairBucket {
  messages: Message[]
  textTokens: number
  mediaTokens: number
  reasoningTokens: number
  toolCallTokens: number
  tokens: number
}

interface GroupedPath {
  preamble: PairBucket
  pairs: PairBucket[]
}

function emptyBucket(): PairBucket {
  return {
    messages: [],
    textTokens: 0,
    mediaTokens: 0,
    reasoningTokens: 0,
    toolCallTokens: 0,
    tokens: 0,
  }
}

function addToBucket(bucket: PairBucket, m: Message, c: MessageCost): void {
  bucket.messages.push(m)
  bucket.textTokens += c.text
  bucket.mediaTokens += c.media
  bucket.reasoningTokens += c.reasoning
  bucket.toolCallTokens += c.toolCalls
  bucket.tokens += c.total
}

function groupPath(visible: readonly Message[], opts: MessageCostOptions): GroupedPath {
  const preamble = emptyBucket()
  const pairs: PairBucket[] = []
  let current: PairBucket | null = null
  for (const m of visible) {
    const c = messageCost(m, opts)
    if (m.role === 'user') {
      if (current) pairs.push(current)
      current = emptyBucket()
      addToBucket(current, m, c)
    } else if (current) {
      addToBucket(current, m, c)
    } else {
      addToBucket(preamble, m, c)
    }
  }
  if (current) pairs.push(current)
  return { preamble, pairs }
}

interface CutoffPlanInput {
  messages: readonly Message[]
  settings: ChatSettings
  tokenizer: TokenizerFamily
  // Provider/model cap used to resolve `customMaxContext === undefined`. When
  // `null`, an undefined `customMaxContext` falls back to Infinity (i.e. no
  // local trim). `-1` still means unlimited regardless.
  providerCap: number | null
  // Upcoming user prompt tokens NOT yet persisted in `messages`. Used at
  // gauge time; the send pipeline passes 0 because the draft is already in
  // the path by the time the wire is composed.
  draftText?: string
  draftAttachmentRefs?: readonly AttachmentRef[]
  // Precomputed system-prompt token count to avoid re-estimating when the
  // caller already has it. Falls back to estimating `settings.systemPrompt`.
  systemPromptTokensOverride?: number
  reasoningOpts?: PromptEstimateOptions
  attachmentResolver?: AttachmentResolver
  // Optional — gates per-message cache trust. Threaded into messageCost
  // via MessageCostOptions.
  currentModelId?: string
  currentTextCharsPerToken?: number
  disableTextCalibration?: boolean
}

interface CutoffPlan {
  // Visible-filtered, cutoff-applied path (preamble + head + tail, in path
  // order). Transforms receive this as `path`. Always returned even when
  // nothing was excluded, so callers can pass it directly without checking
  // `applied`.
  kept: Message[]
  keptIds: Set<MessageId>
  excludedIds: Set<MessageId>

  headPairCount: number
  tailPairCount: number
  totalPairCount: number

  systemTokens: number
  draftTokens: number
  draftMediaTokens: number
  preambleTokens: number
  historyTextTokens: number
  historyMediaTokens: number
  historyReasoningTokens: number
  historyToolCallTokens: number
  // history = preamble + head + tail buckets combined (text + media + reasoning + tools).
  historyTokens: number
  // total = system + history + draft text + draft media. Does NOT include `reserveTokens`;
  // that's part of the BUDGET side, not what gets sent.
  total: number
  reserveTokens: number
  cutoff: number
  // `available` = cutoff − system − preamble − draft − reserve. Negative
  // when fixed costs already overflow; in that case head is reduced to 0
  // and the tail walk finds nothing that fits.
  available: number
  applied: boolean
}

function buildPlan(
  visible: readonly Message[],
  grouped: GroupedPath,
  keptPairs: PairBucket[],
  systemTokens: number,
  draftTokens: number,
  draftMediaTokens: number,
  reserveTokens: number,
  cutoff: number,
  available: number,
  headPairCount: number,
  tailPairCount: number,
): CutoffPlan {
  const kept: Message[] = [...grouped.preamble.messages]
  for (const p of keptPairs) kept.push(...p.messages)
  const keptIds = new Set<MessageId>()
  for (const m of kept) keptIds.add(m.id)
  const excludedIds = new Set<MessageId>()
  for (const m of visible) if (!keptIds.has(m.id)) excludedIds.add(m.id)

  let historyText = grouped.preamble.textTokens
  let historyMedia = grouped.preamble.mediaTokens
  let historyReasoning = grouped.preamble.reasoningTokens
  let historyToolCalls = grouped.preamble.toolCallTokens
  for (const p of keptPairs) {
    historyText += p.textTokens
    historyMedia += p.mediaTokens
    historyReasoning += p.reasoningTokens
    historyToolCalls += p.toolCallTokens
  }
  const historyTokens = historyText + historyMedia + historyReasoning + historyToolCalls

  return {
    kept,
    keptIds,
    excludedIds,
    headPairCount,
    tailPairCount,
    totalPairCount: grouped.pairs.length,
    systemTokens: clampTokens(systemTokens),
    draftTokens: clampTokens(draftTokens),
    draftMediaTokens: clampTokens(draftMediaTokens),
    preambleTokens: clampTokens(grouped.preamble.tokens),
    historyTextTokens: clampTokens(historyText),
    historyMediaTokens: clampTokens(historyMedia),
    historyReasoningTokens: clampTokens(historyReasoning),
    historyToolCallTokens: clampTokens(historyToolCalls),
    historyTokens: clampTokens(historyTokens),
    total: clampTokens(historyTokens + systemTokens + draftTokens + draftMediaTokens),
    reserveTokens: clampTokens(reserveTokens),
    cutoff,
    available,
    applied: excludedIds.size > 0,
  }
}

export function resolveCutoff(settings: ChatSettings, providerCap: number | null): number {
  if (providerCap !== null) return resolveContextCap(settings.customMaxContext, providerCap)
  if (settings.customMaxContext === UNLIMITED_CONTEXT) return Number.POSITIVE_INFINITY
  if (typeof settings.customMaxContext === 'number' && settings.customMaxContext > 0) {
    return settings.customMaxContext
  }
  return Number.POSITIVE_INFINITY
}

export function computeCutoffPlan(input: CutoffPlanInput): CutoffPlan {
  const { settings, tokenizer, providerCap } = input
  const visible = input.messages.filter((m) => m.hiddenFromContext !== true && !m.deleted)
  const attachmentRefsByOwner = resolveAttachmentContextRefs({
    messages: visible,
    policy: attachmentContextPolicyForSettings(settings),
    ...(input.draftAttachmentRefs
      ? { draft: { refs: input.draftAttachmentRefs, role: 'user' } }
      : {}),
  })

  const costOpts: MessageCostOptions = { family: tokenizer }
  if (input.reasoningOpts) costOpts.reasoningOpts = input.reasoningOpts
  if (input.attachmentResolver) costOpts.attachmentResolver = input.attachmentResolver
  costOpts.attachmentRefsByMessageId = attachmentRefsByOwner
  if (input.currentModelId !== undefined) costOpts.currentModelId = input.currentModelId
  if (input.currentTextCharsPerToken !== undefined) {
    costOpts.currentTextCharsPerToken = input.currentTextCharsPerToken
  }
  if (input.disableTextCalibration === true) costOpts.disableTextCalibration = true
  const grouped = groupPath(visible, costOpts)

  const systemTokens =
    input.systemPromptTokensOverride ??
    (settings.systemPrompt.length > 0 ? estimateTokens(settings.systemPrompt, tokenizer) : 0)
  const draftText = input.draftText ?? ''
  const draftTokens = draftText.length > 0 ? estimateTokens(draftText, tokenizer) : 0
  const draftMediaTokens = mediaTokensForRefs(
    attachmentRefsByOwner.get(DRAFT_ATTACHMENT_CONTEXT_ID),
    tokenizer,
    input.attachmentResolver,
    { ...(input.currentModelId !== undefined ? { modelId: input.currentModelId } : {}) },
  )

  // Clamp the reserve to non-negative so a buggy/stored `maxCompletionTokens
  // = -999` can't backdoor-expand the available budget. `-1` means unlimited
  // (reserve = 0, provider handles the cap); any other negative collapses to 0.
  const reserveRaw = settings.maxCompletionTokens
  const reserveTokens = reserveRaw === UNLIMITED_CONTEXT ? 0 : Math.max(0, reserveRaw ?? 0)
  const cutoff = resolveCutoff(settings, providerCap)

  const totalPairs = grouped.pairs.length
  const keepFirstPairs = Math.max(0, settings.contextStrategy.keepFirstPairs ?? 0)

  // Skip local trim when the user opted out, chose server-side middle-out,
  // or when the cutoff is effectively unlimited. Returns the full visible
  // path verbatim so `kept` is a safe default.
  const strategyKind = settings.contextStrategy.kind
  if (strategyKind !== 'sliding_window' || !Number.isFinite(cutoff)) {
    return buildPlan(
      visible,
      grouped,
      grouped.pairs,
      systemTokens,
      draftTokens,
      draftMediaTokens,
      reserveTokens,
      cutoff,
      Number.POSITIVE_INFINITY,
      Math.min(keepFirstPairs, totalPairs),
      Math.max(0, totalPairs - Math.min(keepFirstPairs, totalPairs)),
    )
  }

  const available =
    cutoff - systemTokens - grouped.preamble.tokens - draftTokens - draftMediaTokens - reserveTokens

  let N = Math.min(keepFirstPairs, totalPairs)
  let headTokens = 0
  for (let i = 0; i < N; i += 1) {
    const bucket = grouped.pairs[i]
    if (bucket) headTokens += bucket.tokens
  }
  while (N > 0 && headTokens > available) {
    N -= 1
    const dropped = grouped.pairs[N]
    if (dropped) headTokens -= dropped.tokens
  }

  const remaining = Math.max(0, available - headTokens)
  let tailStart = totalPairs
  let tailTokens = 0
  for (let i = totalPairs - 1; i >= N; i -= 1) {
    const bucket = grouped.pairs[i]
    if (!bucket) continue
    if (tailTokens + bucket.tokens > remaining) break
    tailTokens += bucket.tokens
    tailStart = i
  }

  const keptPairs: PairBucket[] = []
  for (let i = 0; i < N; i += 1) {
    const b = grouped.pairs[i]
    if (b) keptPairs.push(b)
  }
  for (let i = tailStart; i < totalPairs; i += 1) {
    const b = grouped.pairs[i]
    if (b) keptPairs.push(b)
  }

  return buildPlan(
    visible,
    grouped,
    keptPairs,
    systemTokens,
    draftTokens,
    draftMediaTokens,
    reserveTokens,
    cutoff,
    available,
    N,
    totalPairs - tailStart,
  )
}

// Convenience wrapper for the send pipeline: pass the active path, return
// the cutoff-applied path ready for transforms. Keeps callers from having
// to unpack the plan when they only want the filtered messages.
export function applyContextCutoff(input: CutoffPlanInput): Message[] {
  return computeCutoffPlan(input).kept
}

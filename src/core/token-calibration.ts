// Per-chat per-bucket chars-per-token calibration. See
// `plan/token-counting-audit.md §Phase B` for the full design.
//
// Core insight: every successful send yields two (charCount, promptTokens)
// pairs — one for the prompt, one for the completion. Running-summing these
// per calibration bucket yields an empirically-calibrated ratio that adapts
// to the subject matter of each chat (code vs prose, English vs other
// languages, etc.). When a shared-tokenizer family is known, the bucket is
// the family key; otherwise it is the canonicalized structural model key.
// Four tiers cascade when the higher tier is missing or has insufficient
// samples:
//
//   Tier 1: per-chat per-bucket running sums
//   Tier 2: global per-bucket running sums
//   Tier 3: hardcoded per-family anchor (RATIO_BOUNDS)
//   Tier 4: family-bounds-aware generic fallback (3.8 for unknown)
//
// Defense in depth:
//   - safeServerTokens() gates wire-supplied token counts (no NaN / negatives
//     / absurd values poison the running sum).
//   - MIN_RATIO / MAX_RATIO + family bounds reject any sample that implies a
//     chars/token outside the plausible range (e.g. 20 chars/token for Claude
//     — something is broken).
//   - OUTLIER_FACTOR rejects samples that diverge from the existing ratio
//     by more than 3× — catches drift within a family.
//   - charsPerToken() clamps the FINAL consumed ratio into family bounds
//     even if the stored average has drifted. The underlying sample retains
//     the true running average for diagnostics.
//
// Storage is backed by `store/settings.ts` (key `global:token-calibration`).
// Per-chat samples ride on `chat.tokenCalibration` and are persisted as
// part of the chat row. Chat-level persistence goes through the workspace
// repository; the global rollup goes through the settings-store boundary,
// which can map to the daemon settings bag unchanged.

import { getSetting, updateSetting } from '../store/settings'
import {
  bestGuessTokenizerFamilyKey,
  structuralModelSlug,
  tokenCalibrationKey,
  tokenCalibrationKeyForStoredRecordKey,
} from './model-ids'
import { estimateReasoningEchoTokensForMessage } from './tokens'
import { clampTokens, safeContent, safeLen, safeServerTokens } from './token-guards'
import type { PromptEstimateOptions, TokenizerFamily } from './tokens'
import { charPerToken, tokenizerFamily } from './tokens'
import type { ChatUsage, GlobalTokenCalibration, Message, TokenCalibrationSample } from './types'

// Physical bounds on a plausible chars/token ratio. Anything outside this
// is almost certainly a broken sample (miscounted chars, server returned
// corrupted usage, etc.); rejected at ingest time.
export const MIN_RATIO = 1
export const MAX_RATIO = 20

// Minimum character count per sample. Short samples (e.g. a 5-character
// user "yes") are too noisy to be useful. The completion pair is usually
// well above this, so skipping short prompts doesn't lose much signal.
export const MIN_SAMPLE_CHARS = 50

// Samples with chars/token outside `currentRatio × [1/OUTLIER_FACTOR,
// OUTLIER_FACTOR]` are rejected once the chat has enough baseline to
// establish "normal". 3× is generous enough to allow a chat that legitimately
// switches subject matter (English → code) without losing the new ratio.
export const OUTLIER_FACTOR = 3
export const OUTLIER_GATE_MIN_SAMPLES = 3

// Tier-1 (per-chat) minimum samples before the tier is trusted. 1 = trust
// the first sample; can be raised to 3 if instability shows up.
export const MIN_SAMPLES_CHAT = 1
// Tier-2 (global) minimum. New chats need this many global samples for
// the same calibration bucket before they skip past the hardcoded tier.
export const MIN_SAMPLES_GLOBAL = 3

// ---------------------------------------------------------------------------
// Family-specific anchor + bounds.
//
// Anchor: the hardcoded chars/token when calibration hasn't kicked in yet.
// Bounds: lo/hi for ingest rejection AND resolve-time clamp.
//
// Numbers cribbed from LibreChat's `ai-tokenizer` behavior at
// `packages/api/src/utils/tokenizer.ts` plus per-family observation of
// typical English-prose ratios. See the plan for tuning notes.
// ---------------------------------------------------------------------------

export interface FamilyRatioBounds {
  anchor: number
  lo: number
  hi: number
}

export const RATIO_BOUNDS: Readonly<Record<TokenizerFamily, FamilyRatioBounds>> = Object.freeze({
  claude: { anchor: 3.0, lo: 2.0, hi: 4.5 },
  gpt: { anchor: 3.5, lo: 2.5, hi: 5.0 },
  gemini: { anchor: 4.0, lo: 3.0, hi: 5.5 },
  llama: { anchor: 3.5, lo: 2.5, hi: 5.0 },
  mistral: { anchor: 3.5, lo: 2.5, hi: 5.0 },
  deepseek: { anchor: 3.5, lo: 2.5, hi: 5.0 },
  qwen: { anchor: 3.5, lo: 2.5, hi: 5.0 },
  unknown: { anchor: 3.8, lo: 2.0, hi: 6.0 },
})

// Per-family token overhead per message (wrapper tokens the server adds
// to each message). Used to subtract framing from `prompt_tokens` before
// calibrating — otherwise the ratio absorbs framing and future pure-text
// estimates would over/under-count.
export const FRAMING_PER_MESSAGE: Readonly<Record<TokenizerFamily, number>> = Object.freeze({
  gpt: 4,
  claude: 0, // wrapper is request-level, not per-message
  gemini: 0, // Content[] has no per-item framing in prompt tokens
  llama: 0,
  mistral: 0,
  deepseek: 0,
  qwen: 0,
  unknown: 0,
})

// ---------------------------------------------------------------------------
// Resolver — tiered chars/token lookup with family-bounds clamp.
// ---------------------------------------------------------------------------

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sampleNumber(value: unknown): number {
  return finiteNumber(value) ? value : 0
}

function normalizeStoredSample(
  sample: TokenCalibrationSample | undefined,
): TokenCalibrationSample | undefined {
  if (!sample || typeof sample !== 'object') return undefined
  return {
    totalTextChars: sampleNumber(sample.totalTextChars),
    totalTextTokens: sampleNumber(sample.totalTextTokens),
    sampleCount: sampleNumber(sample.sampleCount),
    ...(finiteNumber(sample.lastRatio) ? { lastRatio: sample.lastRatio } : {}),
    updatedAt: sampleNumber(sample.updatedAt),
  }
}

function emptyAggregatedSample(): TokenCalibrationSample {
  return { totalTextChars: 0, totalTextTokens: 0, sampleCount: 0, updatedAt: 0 }
}

function aggregateSamplesForCalibrationKey(
  samples: Record<string, TokenCalibrationSample> | undefined,
  calibrationKey: string,
): TokenCalibrationSample | undefined {
  if (!samples) return undefined
  let aggregate: TokenCalibrationSample | undefined
  for (const [storedKey, storedSample] of Object.entries(samples)) {
    if (tokenCalibrationKeyForStoredRecordKey(storedKey) !== calibrationKey) continue
    const normalized = normalizeStoredSample(storedSample)
    if (!normalized) continue
    if (!aggregate) aggregate = emptyAggregatedSample()
    aggregate.totalTextChars += normalized.totalTextChars
    aggregate.totalTextTokens += normalized.totalTextTokens
    aggregate.sampleCount += normalized.sampleCount
    if (normalized.updatedAt >= aggregate.updatedAt) {
      aggregate.updatedAt = normalized.updatedAt
      if (finiteNumber(normalized.lastRatio)) aggregate.lastRatio = normalized.lastRatio
      else delete aggregate.lastRatio
    }
  }
  return aggregate
}

export function aggregateCalibrationSamples(
  samples: Record<string, TokenCalibrationSample> | undefined,
): Record<string, TokenCalibrationSample> {
  if (!samples) return {}
  const aggregated: Record<string, TokenCalibrationSample> = {}
  for (const [storedKey, storedSample] of Object.entries(samples)) {
    const bucketKey = tokenCalibrationKeyForStoredRecordKey(storedKey)
    const normalized = normalizeStoredSample(storedSample)
    if (!normalized) continue
    let aggregate = aggregated[bucketKey]
    if (!aggregate) {
      aggregate = emptyAggregatedSample()
      aggregated[bucketKey] = aggregate
    }
    aggregate.totalTextChars += normalized.totalTextChars
    aggregate.totalTextTokens += normalized.totalTextTokens
    aggregate.sampleCount += normalized.sampleCount
    if (normalized.updatedAt >= aggregate.updatedAt) {
      aggregate.updatedAt = normalized.updatedAt
      if (finiteNumber(normalized.lastRatio)) aggregate.lastRatio = normalized.lastRatio
      else delete aggregate.lastRatio
    }
  }
  return aggregated
}

export function normalizedCalibrationSamples(
  samples: Record<string, TokenCalibrationSample> | undefined,
): Record<string, TokenCalibrationSample> | undefined {
  if (!samples) return undefined
  return aggregateCalibrationSamples(samples)
}

function ratioFromSample(
  sample: TokenCalibrationSample | undefined,
  minSamples: number,
): number | undefined {
  if (!sample) return undefined
  if (sample.sampleCount < minSamples) return undefined
  if (sample.totalTextTokens <= 0) return undefined
  const r = sample.totalTextChars / sample.totalTextTokens
  if (!Number.isFinite(r) || r <= 0) return undefined
  return r
}

function clampToFamily(ratio: number, bounds: FamilyRatioBounds): number {
  if (ratio < bounds.lo) return bounds.lo
  if (ratio > bounds.hi) return bounds.hi
  return ratio
}

// User-controlled calibration consumption mode — mirrors the type in
// `core/global-settings.ts`. Exposed here so the resolver can be pure
// without importing the preferences module.
export type CalibrationMode = 'adaptive' | 'global-only' | 'family-defaults-only'

// Resolve the current chars/token ratio for a (model, chat) pair. Never
// throws. Always returns a number in [family.lo, family.hi] — the FINAL
// consumed ratio is family-clamped even if stored sums have drifted.
//
// `mode` controls tier skipping:
//   - 'adaptive' (default): per-chat → global → family anchor.
//   - 'global-only': skip per-chat even when samples exist.
//   - 'family-defaults-only': always use the family anchor.
//
// `mode === undefined` behaves as 'adaptive' for backcompat.
export function charsPerToken(
  modelId: string,
  chat:
    | { tokenCalibration?: Record<string, TokenCalibrationSample> | undefined }
    | null
    | undefined,
  global: GlobalTokenCalibration | null | undefined,
  mode: CalibrationMode | undefined = 'adaptive',
): number {
  const family = tokenizerFamilyForModel(modelId)
  const calibrationKey = tokenCalibrationKey(modelId)
  const bounds = RATIO_BOUNDS[family]

  if (mode === 'family-defaults-only') return bounds.anchor

  // Tier 1: per-chat — skipped in 'global-only' mode.
  if (mode === 'adaptive') {
    const chatRatio = ratioFromSample(
      aggregateSamplesForCalibrationKey(chat?.tokenCalibration, calibrationKey),
      MIN_SAMPLES_CHAT,
    )
    if (chatRatio !== undefined) return clampToFamily(chatRatio, bounds)
  }

  // Tier 2: global.
  const globalRatio = ratioFromSample(
    aggregateSamplesForCalibrationKey(global?.byModel, calibrationKey),
    MIN_SAMPLES_GLOBAL,
  )
  if (globalRatio !== undefined) return clampToFamily(globalRatio, bounds)

  // Tier 3: hardcoded anchor.
  return bounds.anchor
}

// Pick the tokenizer family from a full model ID. Centralized so both the
// ratio table lookup and the framing table lookup agree.
export function tokenizerFamilyForModel(modelId: string): TokenizerFamily {
  const familyKey = bestGuessTokenizerFamilyKey(modelId)
  if (familyKey) {
    if (familyKey.startsWith('openai:')) return 'gpt'
    if (familyKey.startsWith('google:')) return 'gemini'
    if (familyKey.startsWith('oss:deepseek')) return 'deepseek'
    if (familyKey.startsWith('oss:qwen')) return 'qwen'
    if (familyKey.startsWith('oss:mistral')) return 'mistral'
    if (familyKey.startsWith('oss:llama')) return 'llama'
  }
  const structural = structuralModelSlug(modelId).toLowerCase()
  // Fallback path is intentionally strict for proprietary families:
  // bare exact OpenAI models should come through `bestGuessTokenizerFamilyKey`,
  // while lookalike fine-tunes like `GPT-5-Distill-Qwen...` should land on
  // their underlying open-weights family instead of collapsing to GPT.
  if (structural.startsWith('claude')) return 'claude'
  if (
    structural.startsWith('gemini') ||
    structural.startsWith('gemma') ||
    structural.startsWith('deep-research-pro-preview')
  ) {
    return 'gemini'
  }
  if (structural.includes('deepseek')) return 'deepseek'
  if (structural.includes('qwen') || structural.includes('qwq')) return 'qwen'
  if (structural.includes('llama')) return 'llama'
  if (
    structural.includes('mistral') ||
    structural.includes('mixtral') ||
    structural.includes('ministral') ||
    structural.includes('codestral') ||
    structural.includes('devstral') ||
    structural.includes('pixtral')
  ) {
    return 'mistral'
  }
  return tokenizerFamily(structural) // last-chance match on raw keywords
}

// ---------------------------------------------------------------------------
// Sample ingest — validates, outlier-gates, updates per-chat sample,
// incrementally rolls up into global.
// ---------------------------------------------------------------------------

function emptySample(): TokenCalibrationSample {
  return { totalTextChars: 0, totalTextTokens: 0, sampleCount: 0, updatedAt: 0 }
}

// Outcome of an attempted sample ingest. `skipReason` is informational
// (dev tools / tests) so callers can surface WHY a sample was rejected.
export type SampleIngestOutcome =
  | { accepted: true }
  | {
      accepted: false
      skipReason: 'too-short' | 'bad-ratio-physical' | 'bad-ratio-family' | 'outlier' | 'bad-input'
    }

// Validate a single (chars, tokens) observation and return whether it
// passed the ingest gates. Does NOT mutate any sample — that's the
// responsibility of `addSample*()` below so the validation step decides
// first whether the IDB write is worth doing.
export function validateSample(
  modelId: string,
  chars: unknown,
  tokens: unknown,
  sample: TokenCalibrationSample | undefined,
): SampleIngestOutcome {
  if (typeof chars !== 'number' || !Number.isFinite(chars)) {
    return { accepted: false, skipReason: 'bad-input' }
  }
  const validatedTokens = safeServerTokens(tokens)
  if (validatedTokens === undefined || validatedTokens <= 0) {
    return { accepted: false, skipReason: 'bad-input' }
  }
  if (chars < MIN_SAMPLE_CHARS) {
    return { accepted: false, skipReason: 'too-short' }
  }

  const newRatio = chars / validatedTokens
  if (!Number.isFinite(newRatio) || newRatio < MIN_RATIO || newRatio > MAX_RATIO) {
    return { accepted: false, skipReason: 'bad-ratio-physical' }
  }

  const bounds = RATIO_BOUNDS[tokenizerFamilyForModel(modelId)]
  if (newRatio < bounds.lo || newRatio > bounds.hi) {
    return { accepted: false, skipReason: 'bad-ratio-family' }
  }

  // Outlier gate — only active once a baseline has been built. Guards
  // against the mid-chat case where one bad sample would otherwise swing
  // a stable calibration.
  if (sample && sample.sampleCount >= OUTLIER_GATE_MIN_SAMPLES && sample.totalTextTokens > 0) {
    const currentRatio = sample.totalTextChars / sample.totalTextTokens
    if (Number.isFinite(currentRatio) && currentRatio > 0) {
      if (newRatio > currentRatio * OUTLIER_FACTOR) {
        return { accepted: false, skipReason: 'outlier' }
      }
      if (newRatio < currentRatio / OUTLIER_FACTOR) {
        return { accepted: false, skipReason: 'outlier' }
      }
    }
  }

  return { accepted: true }
}

// Apply an accepted sample to a TokenCalibrationSample (mutating in place
// for convenience; callers typically own the lifetime of the sample). The
// caller is responsible for validating the sample first with
// `validateSample()`; passing unchecked input here will corrupt the
// running sum.
export function applyValidatedSample(
  sample: TokenCalibrationSample,
  chars: number,
  tokens: number,
  now: number,
): void {
  sample.totalTextChars += chars
  sample.totalTextTokens += tokens
  sample.sampleCount += 1
  sample.lastRatio = chars / tokens
  sample.updatedAt = now
}

// Apply a sample to the per-chat map in memory. Pure (no IO). Mutates
// `chat.tokenCalibration` in place. Caller is responsible for persisting
// the chat row.
export function addSampleToChat(
  chat: { tokenCalibration?: Record<string, TokenCalibrationSample> | undefined },
  modelId: string,
  chars: number,
  tokens: number,
  now: number = Date.now(),
): SampleIngestOutcome {
  chat.tokenCalibration = normalizedCalibrationSamples(chat.tokenCalibration) ?? {}
  const calibrationKey = tokenCalibrationKey(modelId)
  let sample = chat.tokenCalibration[calibrationKey]
  if (!sample) {
    sample = emptySample()
    chat.tokenCalibration[calibrationKey] = sample
  }

  const currentSample =
    aggregateSamplesForCalibrationKey(chat.tokenCalibration, calibrationKey) ?? sample
  const outcome = validateSample(modelId, chars, tokens, currentSample)
  if (!outcome.accepted) return outcome

  applyValidatedSample(sample, chars, tokens, now)
  return { accepted: true }
}

// Apply a sample to the global rollup. Reads + writes the settings key.
// Must be called OUTSIDE any active Dexie transaction on a different
// table. Swallows errors so calibration failure never escapes.
export async function addSampleToGlobal(
  modelId: string,
  chars: number,
  tokens: number,
  now: number = Date.now(),
): Promise<void> {
  try {
    const calibrationKey = tokenCalibrationKey(modelId)
    await updateSetting<GlobalTokenCalibration>(GLOBAL_KEY, (stored) => {
      const global =
        stored && typeof stored === 'object' && stored.version === 1
          ? {
              version: 1 as const,
              updatedAt: finiteNumber(stored.updatedAt) ? stored.updatedAt : 0,
              byModel:
                stored.byModel && typeof stored.byModel === 'object'
                  ? (normalizedCalibrationSamples(stored.byModel) ?? {})
                  : {},
            }
          : emptyGlobal()
      let globalSample = global.byModel[calibrationKey]
      if (!globalSample) {
        globalSample = emptySample()
        global.byModel[calibrationKey] = globalSample
      }
      // Reuse the same validation as per-chat so bad samples don't
      // infiltrate the global rollup either. The existing sample is
      // passed for outlier-gate context.
      const currentSample =
        aggregateSamplesForCalibrationKey(global.byModel, calibrationKey) ?? globalSample
      const outcome = validateSample(modelId, chars, tokens, currentSample)
      if (!outcome.accepted) return global
      applyValidatedSample(globalSample, chars, tokens, now)
      global.updatedAt = now
      return global
    })
  } catch {
    // Non-fatal: per-chat sample still lands even if global rollup fails.
  }
}

// Convenience: apply a sample to both the per-chat map AND the global
// rollup. The per-chat apply is synchronous (in-memory); the global
// rollup is awaited. Caller is responsible for persisting the chat row.
export async function addSampleToChatAndGlobal(
  chat: { tokenCalibration?: Record<string, TokenCalibrationSample> | undefined },
  modelId: string,
  chars: number,
  tokens: number,
  now: number = Date.now(),
): Promise<SampleIngestOutcome> {
  const outcome = addSampleToChat(chat, modelId, chars, tokens, now)
  if (outcome.accepted) {
    await addSampleToGlobal(modelId, chars, tokens, now)
  }
  return outcome
}

// ---------------------------------------------------------------------------
// Global-storage helpers (settings table, key `global:token-calibration`).
// ---------------------------------------------------------------------------

const GLOBAL_KEY = 'global:token-calibration'

function emptyGlobal(): GlobalTokenCalibration {
  return { version: 1, updatedAt: 0, byModel: {} }
}

export async function readTokenCalibrationGlobal(): Promise<GlobalTokenCalibration> {
  const raw = await getSetting<GlobalTokenCalibration>(GLOBAL_KEY)
  if (!raw || typeof raw !== 'object') return emptyGlobal()
  // Minimal validation — version check only; individual samples are
  // consumed through `ratioFromSample` which already guards against bad
  // values.
  if (raw.version !== 1) return emptyGlobal()
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
    byModel:
      raw.byModel && typeof raw.byModel === 'object'
        ? (normalizedCalibrationSamples(raw.byModel) ?? {})
        : {},
  }
}

export async function writeTokenCalibrationGlobal(value: GlobalTokenCalibration): Promise<void> {
  await updateSetting<GlobalTokenCalibration>(GLOBAL_KEY, () => ({
    ...value,
    byModel: normalizedCalibrationSamples(value.byModel) ?? {},
  }))
}

// ---------------------------------------------------------------------------
// Per-message estimate — the read-path used by gauges and send-time cutoff.
// Prefers same-bucket delta math, recomputes explicit cross-model rows under
// the current model ratio, and uses cached/family fallbacks for legacy or
// missing-data rows. Never throws.
// ---------------------------------------------------------------------------

// Fresh char-based estimate for a message's current text content. Used
// when the cache is missing (old row) or has been invalidated. Always
// clamped through the physical bounds.
export function freshTokenEstimate(charCount: number, ratio: number): number {
  if (charCount <= 0) return 0
  if (!Number.isFinite(ratio) || ratio <= 0) return 0
  return clampTokens(Math.ceil(charCount / ratio))
}

// Sum of text-char lengths across a message's current `content` array.
// Only `text` / `output_text` items contribute — media is counted via a
// separate media heuristic.
export function messageTextCharCount(content: unknown): number {
  let total = 0
  for (const item of safeContent(content)) {
    if (item.type === 'text' || item.type === 'output_text') {
      total += safeLen(item.text)
    }
  }
  return total
}

export function currentMessageTextCharCount(
  message: Pick<Message, 'content' | 'originalCharCount' | 'charCountDelta'>,
): number {
  if (finiteNumber(message.originalCharCount)) {
    const delta = finiteNumber(message.charCountDelta) ? message.charCountDelta : 0
    return Math.max(0, message.originalCharCount + delta)
  }
  return messageTextCharCount(message.content)
}

export interface ReadPathTextTokenEstimateInput {
  message: Pick<
    Message,
    | 'content'
    | 'originalCharCount'
    | 'originalCalibrationKey'
    | 'originalModelId'
    | 'originalTokenEstimate'
    | 'charCountDelta'
    | 'cachedTokenEstimate'
  >
  family: TokenizerFamily
  currentModelId?: string | undefined
  currentTextCharsPerToken?: number | undefined
  disableCalibration?: boolean | undefined
}

function calibrationKeyForMessageEstimate(
  message: Pick<Message, 'originalCalibrationKey' | 'originalModelId'>,
): string | undefined {
  if (
    typeof message.originalCalibrationKey === 'string' &&
    message.originalCalibrationKey.length > 0
  ) {
    return message.originalCalibrationKey
  }
  if (typeof message.originalModelId === 'string' && message.originalModelId.length > 0) {
    return tokenCalibrationKey(message.originalModelId)
  }
  return undefined
}

function sameCalibrationBucketForEstimate(
  message: Pick<Message, 'originalCalibrationKey' | 'originalModelId'>,
  currentCalibrationKey: string | undefined,
): boolean {
  return (
    currentCalibrationKey !== undefined &&
    calibrationKeyForMessageEstimate(message) === currentCalibrationKey
  )
}

function cacheFallbackEligible(
  message: Pick<Message, 'originalCalibrationKey' | 'originalModelId'>,
  currentCalibrationKey: string | undefined,
): boolean {
  if (currentCalibrationKey === undefined) return true
  const messageCalibrationKey = calibrationKeyForMessageEstimate(message)
  if (messageCalibrationKey === undefined) return true
  return messageCalibrationKey === currentCalibrationKey
}

function saneCachedTokenEstimate(value: unknown): value is number {
  return finiteNumber(value) && value >= 0
}

function divergesTooFar(left: number, right: number): boolean {
  if (left <= 0 || right <= 0) return false
  return left > right * OUTLIER_FACTOR || right > left * OUTLIER_FACTOR
}

export function readPathTextTokenEstimate(input: ReadPathTextTokenEstimateInput): number {
  const { message, family, currentModelId, currentTextCharsPerToken } = input
  const currentChars = currentMessageTextCharCount(message)
  if (input.disableCalibration === true) {
    return freshTokenEstimate(currentChars, charPerToken(family))
  }
  const currentCalibrationKey = currentModelId ? tokenCalibrationKey(currentModelId) : undefined
  if (
    currentTextCharsPerToken !== undefined &&
    Number.isFinite(currentTextCharsPerToken) &&
    currentTextCharsPerToken > 0
  ) {
    const fresh = freshTokenEstimate(currentChars, currentTextCharsPerToken)
    if (
      sameCalibrationBucketForEstimate(message, currentCalibrationKey) &&
      finiteNumber(message.originalTokenEstimate)
    ) {
      const delta = finiteNumber(message.charCountDelta) ? message.charCountDelta : 0
      const deltaAdjusted = clampTokens(
        message.originalTokenEstimate + Math.ceil(delta / currentTextCharsPerToken),
      )
      return divergesTooFar(deltaAdjusted, fresh) ? fresh : deltaAdjusted
    }
    return fresh
  }

  if (
    cacheFallbackEligible(message, currentCalibrationKey) &&
    saneCachedTokenEstimate(message.cachedTokenEstimate)
  ) {
    return message.cachedTokenEstimate
  }

  return freshTokenEstimate(currentChars, charPerToken(family))
}

// ---------------------------------------------------------------------------
// Per-message calibration-field helpers. Called at create and edit time to
// populate `originalCharCount`, `originalTokenEstimate`, `originalModelId`,
// `originalCalibrationKey`, `charCountDelta`, `cachedTokenEstimate`. The caller computes
// `cachedMediaTokens` via the media-tokens module directly (it depends on
// attachment metadata the calibration module doesn't have).
//
// All fields are OPTIONAL on Message (Phase B backcompat). Callers that
// don't populate them have their messages fall through to fresh-estimate
// paths without crashing.
// ---------------------------------------------------------------------------

export interface CalibrationFieldsForCreate {
  originalCharCount: number
  originalTokenEstimate: number
  originalModelId: string
  originalCalibrationKey: string
  charCountDelta: 0
  cachedTokenEstimate: number
}

// Build calibration fields for a brand-new message with `content`. Uses
// the current tiered chars/token ratio at creation time.
export function calibrationFieldsForCreate(
  content: unknown,
  modelId: string,
  chat:
    | { tokenCalibration?: Record<string, TokenCalibrationSample> | undefined }
    | null
    | undefined,
  global: GlobalTokenCalibration | null | undefined,
  mode: CalibrationMode | undefined = 'adaptive',
): CalibrationFieldsForCreate {
  const chars = messageTextCharCount(content)
  const ratio = charsPerToken(modelId, chat, global, mode)
  const tokens = freshTokenEstimate(chars, ratio)
  return {
    originalCharCount: chars,
    originalTokenEstimate: tokens,
    originalModelId: modelId,
    originalCalibrationKey: tokenCalibrationKey(modelId),
    charCountDelta: 0,
    cachedTokenEstimate: tokens,
  }
}

export interface CalibrationFieldsForEdit {
  originalCalibrationKey?: string
  charCountDelta: number
  cachedTokenEstimate: number
}

// Refresh calibration fields for an EDIT on an existing message. Updates
// `charCountDelta` (relative to `originalCharCount` if present) and
// recomputes `cachedTokenEstimate` using the CURRENT chat model's ratio.
// `originalCharCount` / `originalTokenEstimate` / `originalModelId` /
// `originalCalibrationKey` stay immutable per the Phase B design.
//
// For old messages without `originalCharCount`, the fresh path runs and
// `charCountDelta` stays 0; the next gauge tick will self-heal via
// back-write.
export function calibrationFieldsForEdit(
  currentContent: unknown,
  existingOriginalCharCount: number | undefined,
  existingOriginalModelId: string | undefined,
  existingOriginalCalibrationKey: string | undefined,
  currentChatModelId: string,
  chat:
    | { tokenCalibration?: Record<string, TokenCalibrationSample> | undefined }
    | null
    | undefined,
  global: GlobalTokenCalibration | null | undefined,
  mode: CalibrationMode | undefined = 'adaptive',
): CalibrationFieldsForEdit {
  const chars = messageTextCharCount(currentContent)
  const ratio = charsPerToken(currentChatModelId, chat, global, mode)
  const tokens = freshTokenEstimate(chars, ratio)
  const delta =
    typeof existingOriginalCharCount === 'number' && Number.isFinite(existingOriginalCharCount)
      ? chars - existingOriginalCharCount
      : 0
  return {
    ...(!existingOriginalCalibrationKey && existingOriginalModelId
      ? { originalCalibrationKey: tokenCalibrationKey(existingOriginalModelId) }
      : {}),
    charCountDelta: delta,
    cachedTokenEstimate: tokens,
  }
}

// ---------------------------------------------------------------------------
// Sample derivation — turn a successful stream's state into calibration
// samples for ingestion. Two samples per stream: prompt + completion. Both
// subtract heuristic overhead (media, reasoning echo, framing) so the
// divided ratio reflects pure text. When heuristics are off, the ingest
// gates (family bounds, outlier factor) reject the sample.
// ---------------------------------------------------------------------------

// Text char count of a message's content. Only 'text' / 'output_text' items
// contribute; media is accounted separately.
function messageTextChars(content: unknown): number {
  let total = 0
  for (const item of safeContent(content)) {
    if (item.type === 'text' || item.type === 'output_text') {
      total += safeLen(item.text)
    }
  }
  return total
}

function hasNonTextContent(content: unknown): boolean {
  for (const item of safeContent(content)) {
    if (item.type !== 'text' && item.type !== 'output_text') return true
  }
  return false
}

// Total char count across `reasoningDetails[]` EXCLUDING encrypted blobs.
// See plan §`<think>`-tag models — inline reasoning chars ride with
// completion chars when billed as completion_tokens.
function reasoningDetailsChars(message: Message): number {
  const details = message.reasoningDetails
  if (!details || details.length === 0) return 0
  let total = 0
  for (const d of details) {
    if (d.type === 'reasoning.text') total += safeLen(d.text)
    else if (d.type === 'reasoning.summary') total += safeLen(d.summary)
    // reasoning.encrypted is opaque bytes — never contributes to char count.
  }
  return total
}

export interface DerivePromptSampleInput {
  sentPath: readonly Message[]
  systemPrompt: string
  usage: ChatUsage
  family: TokenizerFamily
  modelId: string
  // Any nonzero media estimate means the turn is not text-only and cannot
  // contribute a chars-per-token calibration sample.
  mediaTokens: number
  reasoningEchoOpts?: PromptEstimateOptions
}

export interface SamplePair {
  chars: number
  tokens: number
}

// Build the prompt sample (chars sent vs prompt_tokens minus text-only
// overhead). Returns `null` when inputs are insufficient to form a useful
// sample, or when the sent path contains any non-text/file/image input.
export function derivePromptSample(input: DerivePromptSampleInput): SamplePair | null {
  if (input.mediaTokens > 0 || input.sentPath.some((m) => hasNonTextContent(m.content))) {
    return null
  }
  const promptTokens = safeServerTokens(input.usage.prompt_tokens)
  if (promptTokens === undefined || promptTokens <= 0) return null

  let sentTextChars = safeLen(input.systemPrompt)
  let reasoningEchoHeuristic = 0
  for (const m of input.sentPath) {
    sentTextChars += messageTextChars(m.content)
    if (input.reasoningEchoOpts) {
      reasoningEchoHeuristic += estimateReasoningEchoTokensForMessage(m, input.reasoningEchoOpts)
    }
  }

  // Per-family framing per message. For OpenAI chat-completions the server
  // adds ~4 tokens of wrapper overhead per message; other families put
  // wrapper at the request level.
  const framingOverhead = FRAMING_PER_MESSAGE[input.family] * input.sentPath.length

  const calibratedTextTokens = promptTokens - reasoningEchoHeuristic - framingOverhead
  if (calibratedTextTokens <= 0) return null

  return { chars: sentTextChars, tokens: calibratedTextTokens }
}

export interface DeriveCompletionSampleInput {
  assistantMessage: Message
  usage: ChatUsage
  family: TokenizerFamily
}

// Build the completion sample. Three-branch logic per the `<think>`-tag
// edge case:
//
//   - `reasoning_tokens > 0` → out-of-band reasoning. Exclude both chars
//     (content only) and tokens (completion − reasoning_tokens).
//   - Otherwise, if the assistant message has reasoningDetails[] chars,
//     reasoning was billed inline. Include reasoning chars; don't subtract
//     from tokens.
//   - No reasoning at all → straight text completion.
//
// Encrypted reasoning chars are never added to assistantChars (base64
// bytes aren't tokenizable text).
export function deriveCompletionSample(input: DeriveCompletionSampleInput): SamplePair | null {
  if (hasNonTextContent(input.assistantMessage.content)) return null
  const completionTokens = safeServerTokens(input.usage.completion_tokens)
  if (completionTokens === undefined || completionTokens <= 0) return null

  const contentChars = messageTextChars(input.assistantMessage.content)
  const reasonChars = reasoningDetailsChars(input.assistantMessage)
  const reasoningTokensOfThisTurn =
    safeServerTokens(input.usage.completion_tokens_details?.reasoning_tokens) ?? 0

  let assistantChars: number
  let calibratedCompletionTextTokens: number

  if (reasoningTokensOfThisTurn > 0) {
    // Out-of-band: OpenAI Responses encrypted / Claude signed-text / Gemini
    // thoughtSignature. Exclude both chars and tokens.
    assistantChars = contentChars
    calibratedCompletionTextTokens = completionTokens - reasoningTokensOfThisTurn
  } else if (reasonChars > 0) {
    // Inline-think: DeepSeek-R1 / Qwen3 / Gemma. Reasoning was billed as
    // completion_tokens; include its chars so the ratio reflects reality.
    assistantChars = contentChars + reasonChars
    calibratedCompletionTextTokens = completionTokens
  } else {
    // Straight text.
    assistantChars = contentChars
    calibratedCompletionTextTokens = completionTokens
  }

  if (calibratedCompletionTextTokens <= 0) return null

  return { chars: assistantChars, tokens: calibratedCompletionTextTokens }
}

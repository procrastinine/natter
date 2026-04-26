// Per-family media (image / PDF / file) token heuristics. Cribbed from
// LibreChat's `packages/api/src/agents/client.ts:59-140` and grounded in
// per-provider docs / observed OpenRouter billing:
//
//   - Images: OpenRouter/providers do not bill the raw uploaded bitmap
//     dimensions forever. They normalize the image before vision token
//     accounting. We estimate against that normalized wire shape, then
//     apply family formulas (`(w*h)/512 + 85` OpenAI-style, `(w*h)/750`
//     Claude-style, midpoint for unknown OSS models).
//   - Gemini vision: per-page non-dimensional billing; `258` is the
//     conservative single-tile cost and matches what the OpenAI-compat
//     shim charges. We use it as the fixed per-image estimate.
//   - PDFs: pages × per-page cost. Page count is either provided
//     (`attachment.pageCount`) or derived from `max(1, bytes / 75000)` —
//     ~1 base64-encoded page per ~75KB is the LibreChat heuristic.
//
// All estimates get a 1.05 safety margin (LibreChat's default). Image
// estimates are additionally capped at the observed OpenRouter/provider
// normalized billing shape; other media is clamped to
// [0, MAX_PLAUSIBLE_TOKENS/10] per-message so a single attachment never
// claims more than 10M tokens.
//
// These are DEFAULTS for when calibration hasn't kicked in yet. Per-chat
// per-model calibration (Phase B) adjusts the pure-text ratio but NOT
// these media numbers — server-side image/PDF billing is deterministic
// per input shape and doesn't drift with subject matter.

import { MAX_PLAUSIBLE_TOKENS } from './token-guards'
import type { TokenizerFamily } from './tokens'

const SAFETY_MARGIN = 1.05

// Upper bound on any single attachment's contribution. Keeps a single
// corrupt/malicious attachment from dominating the whole estimate.
const MAX_PER_ATTACHMENT_TOKENS = MAX_PLAUSIBLE_TOKENS / 10

// Fallback when the attachment dims aren't known (remote URL we haven't
// fetched yet, or the attachment table hasn't been threaded into the
// estimator yet). LibreChat's fallback; slightly above the typical
// dimensioned estimate for common sizes (512x512 → ~600 tokens on GPT).
const IMAGE_FALLBACK_TOKENS = 1024

// OpenRouter/providers normalize large images before billing/vision
// accounting. Observed billing for a 3500×3500 image is usually around
// 1k tokens or less, with Kimi/Moonshot as an outlier around 4k. V1 still
// sends original local bytes and lets the provider resize; these constants
// model the effective provider-normalized shape so UI gauges, cutoff, and
// send planning all agree.
const OPENROUTER_IMAGE_NORMALIZED_MAX_EDGE = 1400
const OPENROUTER_DEFAULT_IMAGE_TOKEN_CAP = 1000
const OPENROUTER_KIMI_IMAGE_TOKEN_CAP = 4000

// Fallback when PDF bytes / pageCount are both unknown — treat as one page.
const PDF_FALLBACK_PAGES = 1

export interface ImageMeta {
  width?: number
  height?: number
  sizeBytes?: number
}

export interface PdfMeta {
  // Preferred: explicit page count (from Attachment.pageCount).
  pageCount?: number
  // Fallback: derive pageCount ≈ max(1, bytes / 75000).
  sizeBytes?: number
  // Tier resolved at upload/extraction time (see
  // `plan/15-non-text-in-context.md §15.12`). Drives which per-page cost
  // table applies. When unset, assumes Tier 1 (native passthrough).
  tier?: 'native' | 'server-parser' | 'client-extract'
  // Tier 3 only: the extracted text that will flow through calibration
  // instead of a per-page heuristic. When present AND tier === 'client-extract',
  // callers should count chars through the text ratio and skip the PDF
  // heuristic. This helper returns 0 in that case.
  extractedText?: string
}

export interface MediaTokenEstimateOptions {
  modelId?: string
}

const IMAGE_PER_FAMILY: Record<TokenizerFamily, (meta: ImageMeta) => number> = {
  // OpenAI-style vision over the normalized wire shape.
  gpt: (meta) => {
    const dims = normalizedImageDimensions(meta)
    return dims
      ? Math.ceil((dims.width * dims.height) / 512) + 85
      : imageFallbackFromBytes(meta.sizeBytes)
  },
  // Claude-style vision over the normalized wire shape.
  claude: (meta) => {
    const dims = normalizedImageDimensions(meta)
    return dims
      ? Math.ceil((dims.width * dims.height) / 750)
      : imageFallbackFromBytes(meta.sizeBytes)
  },
  // Gemini bills per-tile at a near-fixed rate; 258 matches the
  // low-detail single-tile cost we were using previously.
  gemini: () => 258,
  // OSS families — use a midpoint formula. Tokenizer-dependent, so
  // call this advisory.
  llama: (meta) => midpointImageEstimate(meta),
  mistral: (meta) => midpointImageEstimate(meta),
  deepseek: (meta) => midpointImageEstimate(meta),
  qwen: (meta) => midpointImageEstimate(meta),
  unknown: (meta) => midpointImageEstimate(meta),
}

function midpointImageEstimate(meta: ImageMeta): number {
  const dims = normalizedImageDimensions(meta)
  return dims ? Math.ceil((dims.width * dims.height) / 600) : imageFallbackFromBytes(meta.sizeBytes)
}

function kimiImageEstimate(meta: ImageMeta): number {
  const dims = normalizedImageDimensions(meta)
  return dims
    ? Math.ceil((dims.width * dims.height) / 512) + 85
    : imageFallbackFromBytes(meta.sizeBytes)
}

function normalizedImageDimensions(meta: ImageMeta): { width: number; height: number } | undefined {
  const width = positiveFiniteDimension(meta.width)
  const height = positiveFiniteDimension(meta.height)
  if (width === undefined || height === undefined) return undefined
  const maxEdge = Math.max(width, height)
  if (maxEdge <= OPENROUTER_IMAGE_NORMALIZED_MAX_EDGE) return { width, height }
  const scale = OPENROUTER_IMAGE_NORMALIZED_MAX_EDGE / maxEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

function positiveFiniteDimension(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(1, Math.round(value))
}

function imageFallbackFromBytes(sizeBytes: number | undefined): number {
  if (!sizeBytes || sizeBytes <= 0) return IMAGE_FALLBACK_TOKENS
  return Math.max(IMAGE_FALLBACK_TOKENS, Math.ceil(sizeBytes / 768))
}

function isKimiModel(modelId: string | undefined): boolean {
  if (!modelId) return false
  const normalized = modelId.toLowerCase().replace(/:(free|thinking)$/i, '')
  return /(^|[/:])kimi([_.:-]|$)/.test(normalized)
}

function imageTokenCap(options: MediaTokenEstimateOptions | undefined): number {
  return isKimiModel(options?.modelId)
    ? OPENROUTER_KIMI_IMAGE_TOKEN_CAP
    : OPENROUTER_DEFAULT_IMAGE_TOKEN_CAP
}

// Per-page cost (Tier 1 native passthrough — server renders each page as
// image + text). LibreChat uses these numbers.
const PDF_PER_PAGE_TIER1: Record<TokenizerFamily, number> = {
  gpt: 1500,
  claude: 2000,
  gemini: 1500,
  llama: 1700,
  mistral: 1700,
  deepseek: 1700,
  qwen: 1700,
  unknown: 1700,
}

// Per-page cost (Tier 2 server-side parser — extracted text, no image).
// Lower than Tier 1 because layout overhead is dropped; higher than Tier 3
// because server-side extraction sometimes preserves tables the local
// pass would skip.
const PDF_PER_PAGE_TIER2 = 500

export function imageTokenEstimate(
  family: TokenizerFamily,
  meta: ImageMeta = {},
  options?: MediaTokenEstimateOptions,
): number {
  const base = isKimiModel(options?.modelId)
    ? kimiImageEstimate(meta)
    : IMAGE_PER_FAMILY[family](meta)
  const raw = base * SAFETY_MARGIN
  return Math.min(Math.max(0, Math.ceil(raw)), imageTokenCap(options), MAX_PER_ATTACHMENT_TOKENS)
}

export function pdfTokenEstimate(family: TokenizerFamily, meta: PdfMeta = {}): number {
  const tier = meta.tier ?? 'native'
  // Tier 3: extracted text flows through the text ratio; no PDF heuristic here.
  if (tier === 'client-extract') return 0

  const pages =
    meta.pageCount && meta.pageCount > 0
      ? meta.pageCount
      : meta.sizeBytes && meta.sizeBytes > 0
        ? Math.max(1, Math.ceil(meta.sizeBytes / 75_000))
        : PDF_FALLBACK_PAGES

  const perPage = tier === 'server-parser' ? PDF_PER_PAGE_TIER2 : PDF_PER_PAGE_TIER1[family]
  const raw = pages * perPage * SAFETY_MARGIN
  return Math.min(Math.max(0, Math.ceil(raw)), MAX_PER_ATTACHMENT_TOKENS)
}

// Flat fallback for other file types (non-PDF) until we know their mime
// shape and have a tokenizer path. Matches the previous constant used
// throughout the codebase.
export const GENERIC_FILE_TOKEN_FALLBACK = 1000

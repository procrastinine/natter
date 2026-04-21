// Per-family media (image / PDF / file) token heuristics. Cribbed from
// LibreChat's `packages/api/src/agents/client.ts:59-140` and grounded in
// per-provider docs:
//
//   - OpenAI vision: ~`(w*h)/512 + 85` tokens per image (documented in
//     the vision guide; matches observed usage within a few percent).
//   - Claude vision: ~`(w*h)/750` tokens per image (documented in the
//     Claude vision guide).
//   - Gemini vision: per-page non-dimensional billing; `258` is the
//     conservative single-tile cost and matches what the OpenAI-compat
//     shim charges. We use it as the fixed per-image estimate.
//   - PDFs: pages × per-page cost. Page count is either provided
//     (`attachment.pageCount`) or derived from `max(1, bytes / 75000)` —
//     ~1 base64-encoded page per ~75KB is the LibreChat heuristic.
//
// All estimates get a 1.05 safety margin (LibreChat's default). Outputs
// are clamped to [0, MAX_PLAUSIBLE_TOKENS/10] per-message — a single
// attachment should never claim more than 10M tokens, even for absurd
// dimensions.
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

// Fallback when PDF bytes / pageCount are both unknown — treat as one page.
const PDF_FALLBACK_PAGES = 1

export interface ImageMeta {
  width?: number
  height?: number
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

const IMAGE_PER_FAMILY: Record<TokenizerFamily, (meta: ImageMeta) => number> = {
  // OpenAI vision: LibreChat `(w*h)/512 + 85`.
  gpt: ({ width, height }) =>
    width && height ? Math.ceil((width * height) / 512) + 85 : IMAGE_FALLBACK_TOKENS,
  // Claude vision: `(w*h)/750`.
  claude: ({ width, height }) =>
    width && height ? Math.ceil((width * height) / 750) : IMAGE_FALLBACK_TOKENS,
  // Gemini bills per-tile at a near-fixed rate; 258 matches the
  // low-detail single-tile cost we were using previously.
  gemini: () => 258,
  // OSS families — use a midpoint formula. Tokenizer-dependent, so
  // call this advisory.
  llama: ({ width, height }) =>
    width && height ? Math.ceil((width * height) / 600) : IMAGE_FALLBACK_TOKENS,
  mistral: ({ width, height }) =>
    width && height ? Math.ceil((width * height) / 600) : IMAGE_FALLBACK_TOKENS,
  deepseek: ({ width, height }) =>
    width && height ? Math.ceil((width * height) / 600) : IMAGE_FALLBACK_TOKENS,
  qwen: ({ width, height }) =>
    width && height ? Math.ceil((width * height) / 600) : IMAGE_FALLBACK_TOKENS,
  unknown: ({ width, height }) =>
    width && height ? Math.ceil((width * height) / 600) : IMAGE_FALLBACK_TOKENS,
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

export function imageTokenEstimate(family: TokenizerFamily, meta: ImageMeta = {}): number {
  const raw = IMAGE_PER_FAMILY[family](meta) * SAFETY_MARGIN
  return Math.min(Math.max(0, Math.ceil(raw)), MAX_PER_ATTACHMENT_TOKENS)
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

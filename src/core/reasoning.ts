import type {
  ReasoningCarryForward,
  ReasoningDetail,
  ReasoningFormat,
  ReasoningInclude,
  ReasoningSettings,
} from './types'

// Phase 11: the three-checkbox `ReasoningInclude` replaces the legacy
// `ReasoningCarryForward` enum. See `plan/phase11-implementation.md §2`.
//
// Default policy:
//   - **`encrypted: true`** — round-trip the opaque carry-forward carrier for
//     whatever provider is being talked to. The filter treats `reasoning.text`
//     entries that carry a `.signature` (Anthropic) as encrypted-gated too.
//   - **`summary: false`** — don't echo the human-readable summary. The summary
//     is still REQUESTED (`settings.reasoning.summary = 'auto'`) so the UI
//     can display it, but the next turn doesn't need it in context.
//   - **`text: false`** — don't echo plaintext reasoning (DeepSeek/Qwen/Gemma
//     inline `<think>`, or OpenRouter's repackaged-Gemini summary which
//     arrives as a `reasoning.text` detail). Users flip this on to carry it.
//
// Per-provider inventory (verified via live probes Apr 2026):
//   - OpenAI Responses / Azure Responses / xAI: reasoning.encrypted + reasoning.summary
//   - Anthropic: reasoning.text w/ `.signature` (the text IS the carrier)
//   - Gemini native: reasoning.encrypted (thoughtSignature) + reasoning.summary (thought:true text)
//   - Gemini via OpenRouter: reasoning.encrypted + reasoning.text (OpenRouter repackages summary)
//   - DeepSeek/Qwen/Gemma: reasoning.text only (inline <think>)
export function defaultReasoningInclude(
  _preservationFormat: ReasoningFormat | undefined,
): ReasoningInclude {
  return { encrypted: true, summary: false, text: false }
}

// One-shot migrator: translate a legacy `carryForward` enum value into the
// new `include` object. Used when loading existing chats after the Phase 11
// ship; deletes `carryForward` in the caller once the translation lands.
export function migrateCarryForwardToInclude(
  legacy: ReasoningCarryForward | undefined,
  preservationFormat: ReasoningFormat | undefined,
): ReasoningInclude {
  switch (legacy) {
    case 'off':
      return { encrypted: false, summary: false, text: false }
    case 'plaintext':
      return { encrypted: false, summary: true, text: true }
    case 'encrypted':
      return { encrypted: true, summary: false, text: false }
    default:
      // `'auto'` and `undefined` both defer to the capability-aware default.
      return defaultReasoningInclude(preservationFormat)
  }
}

// Defensive normalizer: ensure `ReasoningSettings` always has `mode`,
// `exclude`, and `include` present. Imported chats, rows written by older
// builds, or partial patches that bypassed updateChatSettings can leave any
// of these undefined; callers (chooseApi, transforms, UI gates) assume they
// exist. Return the input verbatim when already well-formed so downstream
// memoization holds. Never mutates.
export function normalizeReasoningSettings(
  input: Partial<ReasoningSettings> | undefined,
): ReasoningSettings {
  if (!input) {
    return {
      mode: 'default',
      exclude: false,
      summary: 'auto',
      include: defaultReasoningInclude(undefined),
    }
  }
  const needsInclude =
    input.include === undefined ||
    input.include === null ||
    typeof (input.include as Partial<ReasoningInclude>).encrypted !== 'boolean'
  const needsMode = input.mode === undefined
  const needsExclude = input.exclude === undefined
  const hasLegacyCarryForward = input.carryForward !== undefined
  if (!needsInclude && !needsMode && !needsExclude && !hasLegacyCarryForward) {
    return input as ReasoningSettings
  }
  // Strip the legacy `carryForward` field once the migration lands so the
  // deprecated key doesn't linger in preset exports and keep confusing
  // future readers.
  const { carryForward: _legacy, ...rest } = input
  const next: ReasoningSettings = {
    ...(rest as ReasoningSettings),
    mode: input.mode ?? 'default',
    exclude: input.exclude ?? false,
    include: needsInclude
      ? input.carryForward
        ? migrateCarryForwardToInclude(input.carryForward, undefined)
        : defaultReasoningInclude(undefined)
      : (input.include as ReasoningInclude),
  }
  return next
}

// Per-turn filter. Drops:
//   1. `id?.startsWith('tool_')` entries (OpenRouter mixes tool-call signatures
//      into `reasoning_details` — they are NOT reasoning carriers).
//   2. `reasoning.encrypted` entries when `include.encrypted === false` OR the
//      current route can't round-trip the carrier (`preservationFormat` is
//      undefined / `'unknown'` / mismatched against the stored `format`).
//      Extra Anthropic scope: `reasoning.encrypted + format anthropic-claude-v1`
//      is an Anthropic `redacted_thinking` block. Only Claude 3.7 Sonnet
//      accepts these; when the target model's `acceptsAnthropicRedactedThinking`
//      flag is false, drop them so Claude-3.7 safety-redactions are not
//      leaked to Claude 4+.
//   3. `reasoning.summary` entries when `include.summary === false`.
//   4. `reasoning.text` entries:
//      - When they carry a `.signature` (Anthropic's carrier lives here),
//        they're encrypted-gated: kept iff `include.encrypted === true` AND
//        the stored `format` matches the current route's preservation format.
//      - Otherwise plaintext reasoning (DeepSeek inline `<think>` / OpenRouter-
//        repackaged Gemini summary): kept iff `include.text === true`.
// Returns the kept subset; never mutates the input.
interface FilterReasoningOptions {
  // Only meaningful when the target route is Anthropic. When `true`, the
  // filter keeps `reasoning.encrypted` entries with
  // `format: 'anthropic-claude-v1'` (Claude 3.7 Sonnet redacted_thinking).
  // When `false`/`undefined`, it drops them — Claude 4+ doesn't produce or
  // reliably accept redacted blocks.
  acceptsAnthropicRedactedThinking?: boolean
}

// OpenAI direct emits `openai-responses-v1`; OpenRouter's `/responses` proxy
// rewrites to `azure-openai-responses-v1` (confirmed by live probe 6 in
// `plan/phase11-research.md`). Both are accepted on either target — treat as
// interchangeable. xAI Grok uses `xai-responses-v1`, which is NOT accepted
// by OpenAI / Azure (different upstream signing key); kept distinct.
const OPENAI_RESPONSES_FAMILY: ReadonlySet<ReasoningFormat> = new Set<ReasoningFormat>([
  'openai-responses-v1',
  'azure-openai-responses-v1',
])

export function isOpenAiResponsesFamilyFormat(
  fmt: ReasoningFormat | undefined,
): fmt is ReasoningFormat {
  return fmt !== undefined && OPENAI_RESPONSES_FAMILY.has(fmt)
}

function formatsCompatible(stored: ReasoningFormat, target: ReasoningFormat): boolean {
  if (stored === target) return true
  if (isOpenAiResponsesFamilyFormat(stored) && isOpenAiResponsesFamilyFormat(target)) return true
  return false
}

export function filterReasoningForInclude(
  details: readonly ReasoningDetail[],
  include: ReasoningInclude,
  preservationFormat: ReasoningFormat | undefined,
  opts: FilterReasoningOptions = {},
): ReasoningDetail[] {
  // `tool_`-prefixed ids are tool-call signatures mixed into
  // `reasoning_details` by OR, not carriers. Drop before gating.
  // `hidden: true` entries are user-soft-hidden from echo (eye icon in
  // InlineEditor); preserved on disk, never sent back.
  const clean = details.filter((d) => !d.id?.startsWith('tool_') && d.hidden !== true)
  return clean.filter((d) => {
    if (d.type === 'reasoning.encrypted') {
      if (!include.encrypted) return false
      if (!preservationFormat || preservationFormat === 'unknown') return false
      if (d.format && !formatsCompatible(d.format, preservationFormat)) {
        warnIncompatibleFormat(d.format, preservationFormat)
        return false
      }
      // Anthropic redacted_thinking block — gate on the target model flag.
      if (preservationFormat === 'anthropic-claude-v1' && !opts.acceptsAnthropicRedactedThinking) {
        return false
      }
      return true
    }
    if (d.type === 'reasoning.summary') return include.summary
    if (d.type === 'reasoning.text') {
      // Anthropic case: `reasoning.text` with a `.signature` IS the
      // encrypted carrier. Gate by `include.encrypted` + format check.
      if (typeof d.signature === 'string' && d.signature.length > 0) {
        if (!include.encrypted) return false
        if (!preservationFormat || preservationFormat === 'unknown') return false
        if (d.format && !formatsCompatible(d.format, preservationFormat)) {
          warnIncompatibleFormat(d.format, preservationFormat)
          return false
        }
        return true
      }
      return include.text
    }
    return false
  })
}

// Console-only surface for "an encrypted reasoning blob was dropped because
// the target route doesn't accept its family tag." No UI banner — the drop
// is silent per user directive. Gated on dev so prod consoles stay quiet.
function warnIncompatibleFormat(stored: ReasoningFormat, target: ReasoningFormat): void {
  if (typeof console === 'undefined') return

  console.warn(
    `[reasoning] dropping encrypted reasoning — stored format ${stored} is not compatible with target ${target}. Switching providers / bridges mid-chat invalidates opaque carriers.`,
  )
}

function endsWithBlankLine(s: string | null | undefined): boolean {
  return typeof s === 'string' && /\n\s*$/.test(s)
}

function startsWithBlankLine(s: string | null | undefined): boolean {
  return typeof s === 'string' && /^\s*\n/.test(s)
}

const MAX_REASONING_OVERLAP_CHARS = 4096

export function mergeReasoningText(
  existingRaw: string | null | undefined,
  incomingRaw: string | null | undefined,
): string {
  const existing = existingRaw ?? ''
  const incoming = incomingRaw ?? ''
  if (incoming.length === 0) return existing
  if (existing.length === 0) return incoming
  if (incoming === existing) return existing
  if (incoming.startsWith(existing)) return incoming
  if (existing.startsWith(incoming) || existing.endsWith(incoming)) return existing
  for (
    let overlap = Math.min(existing.length, incoming.length, MAX_REASONING_OVERLAP_CHARS);
    overlap > 0;
    overlap -= 1
  ) {
    if (existing.slice(-overlap) === incoming.slice(0, overlap)) {
      return existing + incoming.slice(overlap)
    }
  }
  return existing + incoming
}

export function mergeReasoningDetail(
  existing: ReasoningDetail | undefined,
  incoming: ReasoningDetail,
): ReasoningDetail {
  if (!existing) return incoming
  if (existing.type === 'reasoning.text' && incoming.type === 'reasoning.text') {
    return {
      ...existing,
      ...incoming,
      text: mergeReasoningText(existing.text, incoming.text),
    }
  }
  if (existing.type === 'reasoning.summary' && incoming.type === 'reasoning.summary') {
    // Incremental: Responses API sends `summary_text.delta` events that
    // append to a single summary row. Overlap-dedup via `mergeReasoningText`
    // so the merge is idempotent if the same chunk arrives twice.
    //
    // Gemini-family summaries: each thinking section arrives as its own
    // entry (one per OpenRouter `reasoning_details[]` element OR one per
    // native `thought:true` part), and they coalesce into a single
    // continuous Summary block. Inject a `\n\n` separator when both sides
    // have content and neither already provides one — keeps section breaks
    // visible even when the wire didn't include trailing newlines.
    const isGeminiCoalesce =
      existing.format === 'google-gemini-v1' && incoming.format === 'google-gemini-v1'
    let mergedSummary = mergeReasoningText(existing.summary, incoming.summary)
    if (
      isGeminiCoalesce &&
      mergedSummary === `${existing.summary ?? ''}${incoming.summary ?? ''}` &&
      (existing.summary?.length ?? 0) > 0 &&
      (incoming.summary?.length ?? 0) > 0 &&
      !endsWithBlankLine(existing.summary) &&
      !startsWithBlankLine(incoming.summary)
    ) {
      mergedSummary = `${existing.summary}\n\n${incoming.summary}`
    }
    return {
      ...existing,
      ...incoming,
      summary: mergedSummary,
    }
  }
  if (existing.type === 'reasoning.encrypted' && incoming.type === 'reasoning.encrypted') {
    return { ...existing, ...incoming }
  }
  return incoming
}

export function normalizeReasoningDetails(details: ReasoningDetail[]): ReasoningDetail[] {
  const normalized: ReasoningDetail[] = []
  for (const raw of details) {
    if (raw.id?.startsWith('tool_')) continue
    const detail = normalizeIncomingReasoningDetail(raw)
    const target = findMergeTargetIndex(normalized, detail)
    if (target >= 0) {
      normalized[target] = mergeReasoningDetail(normalized[target], detail)
      continue
    }
    normalized.push(detail)
  }
  return dropMirroredOpenAiSummaryText(normalized)
}

// On-ingest relabel: OpenRouter returns Gemini 3 thought SUMMARIES tagged
// `type: "reasoning.text"` (format `google-gemini-v1`). Gemini 3 never emits
// raw chain-of-thought, only summaries, so the `.text` label is misleading
// and makes the Include-controls inconsistent (gating on `include.text`
// instead of `include.summary`). Re-tag on the way in.
//
// Guards:
//   - Only when format is `google-gemini-v1` (Anthropic signed reasoning.text
//     also uses `.text` and MUST be preserved verbatim — the `.signature`
//     IS the encrypted carrier).
//   - Skip entries that carry a `.signature` for the same reason.
export function normalizeIncomingReasoningDetail(detail: ReasoningDetail): ReasoningDetail {
  if (
    detail.type === 'reasoning.text' &&
    detail.format === 'google-gemini-v1' &&
    !detail.signature
  ) {
    const { text, ...rest } = detail
    return {
      ...rest,
      type: 'reasoning.summary',
      summary: text ?? '',
    }
  }
  return detail
}

export function findMergeTargetIndex(
  details: ReasoningDetail[],
  incoming: ReasoningDetail,
): number {
  for (let index = details.length - 1; index >= 0; index -= 1) {
    const existing = details[index]
    if (!existing || existing.type !== incoming.type) continue
    if (shareIdentity(existing, incoming)) return index
    if (incoming.type === 'reasoning.text' && existing.type === 'reasoning.text') {
      const merged = mergeReasoningText(existing.text, incoming.text)
      const appended = `${existing.text ?? ''}${incoming.text ?? ''}`
      if (merged !== appended) return index
      continue
    }
    if (incoming.type === 'reasoning.summary' && existing.type === 'reasoning.summary') {
      // Two Gemini-family summaries belong to the same logical reasoning
      // row regardless of index: Gemini emits each thinking section as its
      // own atomic part, and the UI wants one continuous Summary, not
      // one block per section. OpenRouter's Gemini path reuses index=0
      // across all thought summaries; native-Gemini's path also keys
      // everything under summaryIndex=0 (see splitGeminiPart). Either way
      // these all coalesce.
      if (existing.format === 'google-gemini-v1' && incoming.format === 'google-gemini-v1') {
        return index
      }
      // Backcompat: some older streams persisted successive snapshots of the
      // SAME OpenAI/OpenRouter summary as separate rows without a stable id.
      // Collapse obvious prefix/overlap growth when both rows sit on the same
      // index.
      if (
        existing.index !== undefined &&
        incoming.index !== undefined &&
        existing.index === incoming.index
      ) {
        if (
          isOpenAiResponsesFamilyFormat(existing.format) &&
          isOpenAiResponsesFamilyFormat(incoming.format)
        ) {
          return index
        }
        const merged = mergeReasoningText(existing.summary, incoming.summary)
        const appended = `${existing.summary}${incoming.summary}`
        if (merged !== appended) return index
      }
      continue
    }
    if (incoming.type === 'reasoning.encrypted' && existing.type === 'reasoning.encrypted') {
      if (existing.data === incoming.data) return index
    }
  }
  return -1
}

function shareIdentity(existing: ReasoningDetail, incoming: ReasoningDetail): boolean {
  if (existing.type !== incoming.type) return false
  if (existing.id && incoming.id) return existing.id === incoming.id
  // Summaries are content-addressed: each summary part is its own row.
  // Two summaries that happen to carry the same `index` (OpenRouter's
  // Gemini path reuses index=0 across all thought summaries) are NOT the
  // same block. `findMergeTargetIndex` falls through to a content-equality
  // check below, and distinct summaries end up as distinct rows.
  if (existing.type === 'reasoning.summary') return false
  return (
    existing.index !== undefined &&
    incoming.index !== undefined &&
    existing.index === incoming.index
  )
}

function dropMirroredOpenAiSummaryText(details: ReasoningDetail[]): ReasoningDetail[] {
  const openAiSummaries = details.filter(
    (detail): detail is Extract<ReasoningDetail, { type: 'reasoning.summary' }> =>
      detail.type === 'reasoning.summary' && isOpenAiResponsesFamilyFormat(detail.format),
  )
  if (openAiSummaries.length === 0) return details
  return details.filter((detail) => {
    if (detail.type !== 'reasoning.text') return true
    if (typeof detail.signature === 'string' && detail.signature.length > 0) return true
    return !openAiSummaries.some(
      (summary) =>
        summary.summary === detail.text &&
        summary.index !== undefined &&
        detail.index !== undefined &&
        summary.index === detail.index,
    )
  })
}

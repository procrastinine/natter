// Per-model behavioral quirks that /endpoints cannot express. See
// `plan/05-transforms-and-quirks.md` and `CLAUDE.md` "Per-model quirks
// to honor."
//
// /endpoints reports which top-level params exist for a model + provider.
// What it CAN'T report:
// - which enum values inside `reasoning.effort` / `verbosity` are actually
//   honored (vs silently remapped down)
// - adaptive reasoning (Claude 4.6/4.7 ignore reasoning.effort; 4.7 also
//   ignores/removes manual budgets)
// - Responses-API-required models (GPT-5.3-Codex / 5.4+ Pro)
// - cache min-token floors per Anthropic variant
// - `cache_control` top-level vs per-block requirement per endpoint (Bedrock
//   / Vertex need per-block)
//
// This registry narrows the capability set after it comes off the wire. It is
// fallback-only: OpenRouter model discovery, endpoint routing, and provider
// privacy must still work if this table has no row for a new model. Model
// identity comes from the shared cross-provider resolver in `model-ids.ts`, so
// OpenRouter aliases and direct-provider ids do not drift apart.

import { canonicalCompatModelId, canonicalModelSlug } from './model-ids'
import type { EffortLevel, ReasoningFormat, VerbosityLevel } from './types'

// Assistant-prefill classification. See `plan/prefill-research.md §P.8.1`.
// `native`  — prefill works transparently (Claude < 4.6, Gemini).
// `unsupported` — provider or model rejects prefill (Claude ≥ 4.6,
//                 openai/gpt-oss-*, OpenAI GPT family).
// `oss-toggleable` — default for hybrid thinking-capable OSS models;
//                    prefill works when reasoning is disabled on the wire.
// `oss-reasoning-required` — model can't toggle reasoning off; prefill lands
//                            in the <think> block rather than content.
type PrefillClass = 'native' | 'unsupported' | 'oss-toggleable' | 'oss-reasoning-required'

type TextCompletionsSupport =
  | 'visible'
  | 'accepted-reasoning-only'
  | 'disabled-chat-native'
  | 'unknown'

// Effort ordered low → high for left-to-right UI rendering. Validation /
// transform code doesn't care about order (it just filters by set
// membership), but UI controls read the array verbatim so the visual
// progression matches the user's mental model.
export const FULL_EFFORT: readonly EffortLevel[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]

export const FULL_VERBOSITY: readonly VerbosityLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

interface QuirksEntry {
  // Empty array means "reasoning.effort is ignored" (adaptive-only).
  // undefined means "no narrowing; use the full superset".
  allowedEffort?: readonly EffortLevel[]
  allowedVerbosity?: readonly VerbosityLevel[]
  // Some models refuse chat-completions and require /responses (GPT-5.4+ pro family).
  requiresResponsesApi?: boolean
  // Soft preference. The api-choice matrix flips to Responses unless the
  // user pinned `chat`. Less aggressive than `requiresResponsesApi` (which
  // forces the switch). Used for models where Responses is strictly better
  // (preserves encrypted reasoning, phase, etc.) but chat completions still
  // works (e.g. GPT-5 / o-series).
  preferApi?: 'chat' | 'responses'
  // Which `ReasoningFormat` the model's encrypted carrier uses. Drives the
  // carry-forward matrix in `core/transforms.ts`:
  //  - `openai-responses-v1` / `azure-openai-responses-v1` — OpenAI direct
  //    or via OpenRouter (proxied; format flips to `azure-openai-responses-v1`
  //    per live probe 6).
  //  - `anthropic-claude-v1` — Claude (any tier).
  //  - `google-gemini-v1` — Gemini native thoughtSignature, and Gemini via
  //    OpenRouter repackaged as `reasoning.encrypted`.
  //  - `xai-responses-v1` — xAI Grok.
  //  - `unknown` (DeepSeek-R1 / Qwen3 / Gemma): no opaque round-trip exists;
  //    plaintext `<think>` tags only.
  reasoningPreservationFormat?: ReasoningFormat
  // Claude 4.7 uses adaptive-only reasoning: `reasoning` is in
  // supported_parameters but `effort` and `max_tokens` are silently ignored.
  adaptiveReasoningOnly?: boolean
  // Anthropic cache floor: "cache_control" below this token count is
  // not honored. One floor per variant per CLAUDE.md.
  cacheMinTokens?: number
  // `phase` field must be persisted verbatim across Responses-API turns
  // (GPT-5.4+ family; dropping phase causes early stopping).
  persistsResponsesPhase?: boolean
  // Same as `persistsResponsesPhase`; Phase 11 introduces the preferred
  // spelling. Kept as a separate field so callers can assert on the
  // intent (the Responses transform reads both).
  requiresPhaseEcho?: boolean
  // Some models emit `<think>…</think>` inline in content; the stream
  // parser needs to lift that into the reasoning lane. Values are the tag
  // names (without brackets) the model uses: DeepSeek-R1 / Qwen3 use
  // `think`; Gemma historically used `thought`. When unset, the chat
  // splitter's auto-detect covers generic thinking models (Kimi K2
  // Thinking, GLM-4.x thinking, etc.) by scanning the first chunk for a
  // leading `<think>` / `<thought>` tag.
  reasoningInlineTags?: readonly string[]
  // Reasoning happens but isn't returned (OpenAI o-series on chat-
  // completions; some preview Gemini). The UI hides the reasoning panel
  // on these.
  reasoningHidden?: boolean
  // Phase 11 preferred spelling — scoped to the chat-completions API so
  // the UI can keep rendering the reasoning panel on `responses` (where
  // the same model DOES return reasoning).
  hiddenReasoningOnChatApi?: boolean
  // GPT-5.3-codex / GPT-5.4+ family:
  // `temperature`, `top_p`, `logprobs`, `top_k` are ONLY accepted when
  // `reasoning.effort === 'none'`. With any other effort the API rejects
  // the request. The transform strips them at wire time.
  gpt54SamplingGate?: boolean
  // Phase 11: Claude 3.7 Sonnet returns `redacted_thinking` blocks when
  // its internal reasoning is flagged by the safety filter. Stored
  // as `reasoning.encrypted` with `format: 'anthropic-claude-v1'`. Only 3.7
  // accepts these blocks on round-trip; Claude 4+ doesn't produce them
  // and their acceptance is unverified. Guard the echo by setting this
  // flag `true` ONLY on `claude-sonnet-3.7`. The filter drops
  // `reasoning.encrypted + format anthropic-claude-v1` entries when the
  // target model doesn't have this flag.
  acceptsAnthropicRedactedThinking?: boolean
  // Which wire APIs this model accepts. Drives UI toggle visibility and
  // chooseApi's auto-route. Mirrors OpenAI's per-model support list (for
  // OpenRouter the same table applies. OR accepts /responses on any model
  // via translation, but /responses gives no benefit on non-OpenAI models,
  // so they are treated as chat-only).
  //   'responses-only' — model 404s on chat-completions (gpt-5.5-pro, 5.4-pro, 5.3-codex,
  //                      5.2-codex, 5.2-pro, 5.1-codex, 5.1-codex-max, 5-codex,
  //                      5-pro, o1-pro, o3-pro, *-deep-research).
  //   'chat-only'      — `*-chat-latest`, gpt-3.5-turbo-instruct, and every
  //                      non-OpenAI-family model (Claude, Gemini, DeepSeek,
  //                      Qwen, Grok, GLM, Kimi, MiniMax, Gemma).
  //   'both'           — gpt-5.5, 5.4, 5.4-mini, 5.4-nano, 5.3, 5.2, 5.1, 5,
  //                      5-mini/nano, 4.1, 4o, 4, 4-turbo, 3.5-turbo,
  //                      o1, o3, o3-mini, o4-mini.
  // Unset defaults to 'chat-only'.
  responsesSupport?: 'responses-only' | 'chat-only' | 'both'
  // Assistant-prefill classification. Unset defaults to `oss-toggleable`
  // (the permissive case for any model not explicitly listed). The three
  // buckets that DO need an entry: `unsupported` for Claude ≥ 4.6 / gpt-oss /
  // plain OpenAI GPT; `native` for Claude < 4.6 / Gemini; and
  // `oss-reasoning-required` for the P.7 list (models whose reasoning can't
  // be toggled off).
  prefillClass?: PrefillClass
  // True when the model's reasoning CANNOT be toggled off on the wire,
  // either because the endpoint rejects `reasoning.enabled: false` or
  // accepts it silently while still emitting reasoning tokens. Drives UI
  // validation independently of prefill.
  reasoningToggleable?: boolean
  // Whether the model emits an opaque encrypted-reasoning carrier that
  // can be echoed on the next turn. Drives the "Encrypted reasoning"
  // include checkbox visibility.
  //   'always'     — emits on every reasoning turn (GPT-5.x, Gemini 3+,
  //                  Claude 4.x via signed reasoning.text, Claude 3.7
  //                  redacted_thinking, xAI Grok).
  //   'tools-only' — only emits when tools are in the turn (Gemini 2.5).
  //                  Treated as 'never' for UI purposes; a checkbox that
  //                  only works in tool flows is not surfaced.
  //   'never'      — no opaque carrier (DeepSeek R1, Qwen3, Gemma, Kimi,
  //                  GLM, MiniMax, and anything with
  //                  `reasoningPreservationFormat: 'unknown'`).
  // Unset defaults to 'always' when `reasoningPreservationFormat` is set
  // and not 'unknown', 'never' otherwise.
  emitsEncryptedReasoning?: 'always' | 'tools-only' | 'never'
}

// Match order: longest prefix wins so "claude-opus-4.7" doesn't accidentally
// pick up a rule for "claude-opus". Map is iterated by descending key length.
const REGISTRY: Record<string, QuirksEntry> = {
  // Anthropic 4.7 — no temperature/top_p/top_k (already filtered by the
  // API). Reasoning is adaptive-only. Supports BOTH xhigh (4.7-exclusive)
  // and max (inherited from 4.6+) verbosity, per OpenRouter's 4.7
  // migration doc (llms-full.txt line 18451): both 4.6 and 4.7 rows
  // list `verbosity: 'max'` as Supported.
  'claude-opus-4.7': {
    adaptiveReasoningOnly: true,
    allowedEffort: [],
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh', 'max'],
    cacheMinTokens: 4096,
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  // Anthropic 4.6 — adaptive reasoning is recommended and
  // `reasoning.effort` is ignored, but manual budget reasoning is still
  // accepted when `reasoning.max_tokens` is set. Verbosity `max` is new on
  // 4.6; `xhigh` falls back to `high` so it is dropped from the allowed
  // set to avoid rendering a button that silently no-ops.
  'claude-opus-4.6': {
    allowedEffort: [],
    allowedVerbosity: ['low', 'medium', 'high', 'max'],
    cacheMinTokens: 4096,
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  'claude-sonnet-4.6': {
    allowedEffort: [],
    allowedVerbosity: ['low', 'medium', 'high', 'max'],
    cacheMinTokens: 2048,
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  // 4.5-series Claude supports effort-based reasoning (low/med/high +
  // budget). Verbosity is NOT supported; /endpoints confirms.
  'claude-haiku-4.5': {
    cacheMinTokens: 4096,
    allowedEffort: ['low', 'medium', 'high'],
    allowedVerbosity: [],
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  'claude-opus-4.5': {
    cacheMinTokens: 4096,
    allowedEffort: ['low', 'medium', 'high'],
    allowedVerbosity: [],
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  'claude-sonnet-4.5': {
    cacheMinTokens: 1024,
    allowedEffort: ['low', 'medium', 'high'],
    allowedVerbosity: [],
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  'claude-opus-4.1': {
    cacheMinTokens: 1024,
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  'claude-opus-4': {
    cacheMinTokens: 1024,
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  'claude-haiku-3.5': { cacheMinTokens: 2048 },
  'claude-sonnet-3.7': {
    cacheMinTokens: 1024,
    reasoningPreservationFormat: 'anthropic-claude-v1',
    // Only model that emits `redacted_thinking` + is verified to accept it
    // on round-trip (per AWS Bedrock docs: "Claude 4 models … do not produce
    // redacted thinking blocks"). Acts as the echo gate.
    acceptsAnthropicRedactedThinking: true,
  },

  // OpenAI GPT-5.3 / older GPT-5 entries that are not covered by the
  // shared GPT-5.4+ fallback below.
  // Effort enum authoritative from `openai_docs/pages/docs/guides/latest-model.md`
  // + live probe 4: `none (default) | low | medium | high | xhigh`, NO
  // `minimal`. Verbosity: low/medium/high/xhigh (no max; max is Claude-only).
  'gpt-5.3-codex': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    gpt54SamplingGate: true,
    allowedEffort: ['low', 'medium', 'high', 'xhigh'],
    // Codex variant typically has no verbosity parameter exposed.
    allowedVerbosity: [],
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  'gpt-5.3': {
    // 5.3 is chat-completions-capable but Responses is strictly better.
    preferApi: 'responses',
    persistsResponsesPhase: true,
    allowedEffort: ['none', 'low', 'medium', 'high', 'xhigh'],
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
  'gpt-5.2': {
    preferApi: 'responses',
    allowedEffort: ['none', 'low', 'medium', 'high'],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
  'gpt-5': {
    preferApi: 'responses',
    allowedEffort: ['minimal', 'low', 'medium', 'high'],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
  // Responses-only OpenAI models that aren't yet in the UI model list but
  // exist on OpenAI and OpenRouter. Kept so that if a user types the slug
  // in by hand (or OR exposes them in /models), the toggle correctly hides.
  'gpt-5-pro': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  'gpt-5-codex': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  'gpt-5.1-codex': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  'gpt-5.1-codex-max': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  'gpt-5.2-codex': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  'gpt-5.2-pro': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  'o1-pro': {
    requiresResponsesApi: true,
    hiddenReasoningOnChatApi: true,
    reasoningHidden: true,
    allowedVerbosity: [],
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  'o3-pro': {
    requiresResponsesApi: true,
    hiddenReasoningOnChatApi: true,
    reasoningHidden: true,
    allowedVerbosity: [],
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },

  // OpenAI o-series: reasoning runs but is NOT returned over chat-
  // completions (Responses API is needed to see it). `preferApi: 'responses'`
  // + `hiddenReasoningOnChatApi: true` means the UI hides the panel on chat
  // but shows it when the route is upgraded.
  o1: {
    hiddenReasoningOnChatApi: true,
    reasoningHidden: true,
    preferApi: 'responses',
    allowedVerbosity: [],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
  'o1-mini': {
    reasoningHidden: true,
    hiddenReasoningOnChatApi: true,
    allowedVerbosity: [],
  },
  'o3-mini': {
    hiddenReasoningOnChatApi: true,
    reasoningHidden: true,
    preferApi: 'responses',
    allowedVerbosity: [],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
  o3: {
    hiddenReasoningOnChatApi: true,
    reasoningHidden: true,
    preferApi: 'responses',
    allowedVerbosity: [],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
  'o4-mini': {
    hiddenReasoningOnChatApi: true,
    reasoningHidden: true,
    preferApi: 'responses',
    allowedVerbosity: [],
    reasoningPreservationFormat: 'openai-responses-v1',
  },

  // Gemini 3 / 3.1 — per Google's thinking docs:
  //   - Pro tier: `thinkingLevel` enum is low/medium/high (NO `minimal`;
  //     cannot be disabled).
  //   - Flash / Flash-Lite tier: `thinkingLevel` enum adds `minimal` (soft
  //     disable; still no hard-disable path).
  // Split keys so the UI renders the right effort buttons per-family. The
  // transform in `core/transforms.ts` independently clamps invalid effort
  // values for Pro. Canonicalization maps `3.1` → `3:1` so the 3.1 key
  // doesn't accidentally match `gemini-3-…` and vice versa.
  'gemini-3.1-pro': {
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'google-gemini-v1',
  },
  'gemini-3.1-flash': {
    allowedEffort: ['minimal', 'low', 'medium', 'high'],
    reasoningPreservationFormat: 'google-gemini-v1',
  },
  'gemini-3-pro': {
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'google-gemini-v1',
  },
  'gemini-3-flash': {
    allowedEffort: ['minimal', 'low', 'medium', 'high'],
    reasoningPreservationFormat: 'google-gemini-v1',
  },
  // Fallback catch-alls for any unknown Gemini 3.x variant: take the
  // conservative (Flash-style) enum that includes minimal.
  'gemini-3.1': {
    allowedEffort: ['minimal', 'low', 'medium', 'high'],
    reasoningPreservationFormat: 'google-gemini-v1',
  },
  'gemini-3': {
    allowedEffort: ['minimal', 'low', 'medium', 'high'],
    reasoningPreservationFormat: 'google-gemini-v1',
  },
  // Gemini 2.5: thoughtSignature is emitted ONLY on tool turns (verified via
  // native probes; plain conversational turns return no signature). User
  // directive: treat as 'never'. Only Gemini 3+ is expected to round-trip
  // encrypted reasoning. The explicit override flips the format-derived
  // 'always' default to 'never' so the include-encrypted checkbox hides.
  // Single prefix key covers pro / flash / flash-lite / dated-preview
  // variants.
  'gemini-2.5': {
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'google-gemini-v1',
    emitsEncryptedReasoning: 'never',
  },

  // OSS / Chinese-lab thinking-model families fall through to a shared
  // pattern below the registry; one entry per family was just six copies
  // of the same fields. See `OSS_THINKING_FAMILIES` + the pattern fallback
  // in `quirksFor`. Override individually here only when a slug deviates
  // from the family default (e.g. a model that narrows effort differently).

  // xAI Grok 4.1 / 4.20 — real encrypted-reasoning carrier (`format:
  // xai-responses-v1`) with both `reasoning.summary` and
  // `reasoning.encrypted` entries per live probe. Earlier grok-3 / grok-4
  // plain slugs dropped (superseded on OR).
  'grok-4.1': {
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'xai-responses-v1',
  },
  'grok-4.20': {
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'xai-responses-v1',
  },

  // OpenAI chat-only slugs. These don't accept /v1/responses. Registered so
  // the UI can hide the API-mode toggle instead of offering a broken option.
  'gpt-5-chat-latest': { responsesSupport: 'chat-only' },
  'gpt-5.1-chat-latest': { responsesSupport: 'chat-only' },
  'gpt-5.2-chat-latest': { responsesSupport: 'chat-only' },
  'gpt-5.3-chat-latest': { responsesSupport: 'chat-only' },
  'gpt-5.4-chat-latest': { responsesSupport: 'chat-only' },
  'gpt-3.5-turbo-instruct': { responsesSupport: 'chat-only' },
}

const REGISTRY_KEYS_BY_LENGTH = Object.keys(REGISTRY).sort((a, b) => b.length - a.length)

// OSS / Chinese-lab thinking-model FAMILIES — match by family root only so
// future versions (`gemma-5`, `kimi-k3`, `qwen-4`, `deepseek-v5`, …) get the
// same treatment the day they release without anyone touching this file.
//
// Behavior these models share:
//   - emit `<think>…</think>` (or `<thought>…</thought>` for Gemma) inline in
//     `delta.content` when accessed directly; OpenRouter pre-packages the
//     same content into `reasoning_details[]` with `format: 'unknown'`.
//   - no encrypted carry-forward carrier (carry-forward matrix drops
//     `reasoning.encrypted` entries silently for `format: 'unknown'`).
//   - effort enum honors low / medium / high; minimal / xhigh / none either
//     no-op or fall through to high, so the UI is narrowed to avoid no-op
//     buttons. (FULL_EFFORT remains the safe default; this is a UX trim.)
//
// The lifter's auto-detect default already covers any *unknown* model that
// happens to emit `<think>`. Listing a family here only narrows the
// effort UI and pins the inline-tag set explicitly. New families would
// only need to be added if their tag name differs (Gemma's `<thought>`).
// Pattern accepts the family name followed by either a separator (`-`, `_`),
// a version digit / dot (`qwen3.6`, `qwen3`), or end-of-string. Catches every
// versioning convention these labs ship under one expression.
const OSS_THINKING_FAMILIES = ['deepseek', 'qwen', 'kimi', 'glm', 'minimax'] as const
const OSS_THINKING_PATTERN = new RegExp(`^(?:${OSS_THINKING_FAMILIES.join('|')})(?:[-_\\d.]|$)`)

const OSS_THINKING_DEFAULT: QuirksEntry = {
  reasoningInlineTags: ['think'],
  allowedEffort: ['low', 'medium', 'high'],
  reasoningPreservationFormat: 'unknown',
}

// Gemma uses `<thought>` historically but accept both for safety against
// post-Gemma-4 variants that may switch.
const GEMMA_DEFAULT: QuirksEntry = {
  ...OSS_THINKING_DEFAULT,
  reasoningInlineTags: ['thought', 'think'],
}
const GEMMA_PATTERN = /^gemma(?:[-_\d.]|$)/

// Shared OpenAI GPT-5.4+ family behavior: non-pro models prefer Responses
// for encrypted reasoning + `phase`; pro models require Responses.
const GPT_54_PLUS_PATTERN =
  /^gpt-5[:.](?:[4-9]|\d{2,})(?:$|-(?:pro|mini|nano|chat-latest|\d{8}|\d{4}-\d{2}-\d{2})(?:$|-))/
const GPT_54_PLUS_BASE: QuirksEntry = {
  persistsResponsesPhase: true,
  requiresPhaseEcho: true,
  gpt54SamplingGate: true,
  allowedEffort: ['none', 'low', 'medium', 'high', 'xhigh'],
  allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
  reasoningPreservationFormat: 'openai-responses-v1',
}

function openAiGpt54PlusFamilyQuirks(normalized: string): QuirksEntry | null {
  if (!GPT_54_PLUS_PATTERN.test(normalized)) return null
  if (normalized.endsWith('-chat-latest')) return { responsesSupport: 'chat-only' }
  if (/-pro(?:$|-)/.test(normalized)) {
    return { ...GPT_54_PLUS_BASE, requiresResponsesApi: true, responsesSupport: 'responses-only' }
  }
  return { ...GPT_54_PLUS_BASE, preferApi: 'responses' }
}

export function quirksFor(modelId: string): QuirksEntry {
  const normalized = canonicalCompatModelId(modelId)
  for (const key of REGISTRY_KEYS_BY_LENGTH) {
    const normalizedKey = canonicalCompatModelId(key)
    if (normalized === normalizedKey || normalized.startsWith(`${normalizedKey}-`)) {
      const entry = REGISTRY[key]
      if (entry) return entry
    }
  }
  const openAiGpt54Plus = openAiGpt54PlusFamilyQuirks(normalized)
  if (openAiGpt54Plus) return openAiGpt54Plus
  if (GEMMA_PATTERN.test(normalized)) return GEMMA_DEFAULT
  if (OSS_THINKING_PATTERN.test(normalized)) return OSS_THINKING_DEFAULT
  return {}
}

export function allowedEffortFor(modelId: string): readonly EffortLevel[] {
  const q = quirksFor(modelId)
  return q.allowedEffort ?? FULL_EFFORT
}

export function allowedVerbosityFor(modelId: string): readonly VerbosityLevel[] {
  const q = quirksFor(modelId)
  return q.allowedVerbosity ?? FULL_VERBOSITY
}

export function cacheMinTokensFor(modelId: string): number | undefined {
  return quirksFor(modelId).cacheMinTokens
}

export function reasoningPreservationFormatFor(modelId: string): ReasoningFormat | undefined {
  return quirksFor(modelId).reasoningPreservationFormat
}

// True for OpenAI-family slugs that support the Responses API (gpt-*, o1/o3/o4
// series minus chat-latest aliases and gpt-3.5-turbo-instruct). Used as a
// fallback when the model isn't in the registry so OpenAI models on
// OpenRouter still route to Responses by default.
function slugIsOpenAiResponsesFamily(stripped: string): boolean {
  if (!stripped) return false
  if (stripped.endsWith('-chat-latest')) return false
  if (stripped === 'gpt-3.5-turbo-instruct') return false
  if (stripped.startsWith('gpt-')) return true
  if (stripped.startsWith('chatgpt-')) return true
  if (stripped === 'o1' || stripped.startsWith('o1-')) return true
  if (stripped === 'o3' || stripped.startsWith('o3-')) return true
  if (stripped === 'o4' || stripped.startsWith('o4-')) return true
  return false
}

// Effective `responsesSupport`. Registry wins; otherwise slug-heuristic for
// OpenAI-family; otherwise `'chat-only'` (safest: don't show a toggle for
// a model whose /responses support is unconfirmed).
export function responsesSupportFor(modelId: string): 'responses-only' | 'chat-only' | 'both' {
  const q = quirksFor(modelId)
  if (q.responsesSupport) return q.responsesSupport
  if (slugIsOpenAiResponsesFamily(canonicalModelSlug(modelId).toLowerCase())) return 'both'
  return 'chat-only'
}

// Effective `emitsEncryptedReasoning`. Registry wins; otherwise derive from
// `reasoningPreservationFormat`: anything with a known carrier emits 'always';
// 'unknown' or missing emits 'never'.
export function emitsEncryptedReasoningFor(modelId: string): 'always' | 'tools-only' | 'never' {
  const q = quirksFor(modelId)
  if (q.emitsEncryptedReasoning) return q.emitsEncryptedReasoning
  const fmt = q.reasoningPreservationFormat
  if (!fmt || fmt === 'unknown') return 'never'
  return 'always'
}

// ---------------------------------------------------------------------------
// Prefill classification + reasoning-toggleable gate. See
// `plan/prefill-research.md §P.7` and §P.8.1.
// ---------------------------------------------------------------------------

// Claude ≥ 4.6 dropped assistant-prefill on Anthropic direct AND via
// OpenRouter (per live probe). Matches any family (`opus` / `sonnet` /
// `haiku` / future) at version 4.6 or higher. Using >= 4.6 as a blanket
// rule so new Claude releases inherit the right classification without
// someone touching this file. The version separator is either `.` (raw)
// or `:` (compat-normalized by `canonicalCompatModelId`), both accepted.
const CLAUDE_NO_PREFILL_PATTERN =
  /^claude-(?:opus|sonnet|haiku)-(?:[5-9](?:$|[-.:])|4[.:](?:[6-9]|\d{2,}))/

// OpenAI GPT / o-series / chatgpt / gpt-oss all ignore assistant prefill —
// `openai/gpt-oss-*` is harmony-blocked (every provider), and everything else
// in the family returns a fresh answer (probe r1/r2). Safest blanket rule:
// all OpenAI-family slugs. If a future OpenAI-family model starts honoring
// prefill, add a registry entry for that slug with `prefillClass: 'native'`.
const OPENAI_PREFILL_UNSUPPORTED_PATTERN = /^(?:gpt-|chatgpt-|o\d|gpt-oss)/

// Models that reject `reasoning.enabled: false` outright OR accept it
// silently while still emitting reasoning tokens (per the r12/r13 probe
// sweep). Generic default is "toggleable"; only these are reasoning-locked.
// Prefill would land in the <think> block, and the reasoning "off" UI
// option would be a no-op that trips HTTP 400 on the wire. Keys are the
// slug form produced by `canonicalCompatModelId` (provider prefix stripped,
// dots in versions normalized to `:`).
const REASONING_REQUIRED_MODELS: ReadonlySet<string> = new Set([
  'kimi-k2-thinking',
  'deepseek-r1',
  'deepseek-r1-0528',
  'deepseek-r1-distill-llama-70b',
  'deepseek-v3:2-speciale',
  'minimax-m2',
  'minimax-m2:1',
  'minimax-m2:5',
  'minimax-m2:7',
  'qwen3-14b',
  'qwen3-32b',
  'qwen3-30b-a3b',
  'qwen3-next-80b-a3b-thinking',
  'qwen3-30b-a3b-thinking-2507',
  'qwen3-235b-a22b-thinking-2507',
])

// Effective prefill classification. Registry wins; otherwise pattern rules
// decide. Order matters: Claude + OpenAI unsupported comes before the
// reasoning-required check since those probes only apply to OSS models.
// `canonicalCompatModelId` returns the slug (provider prefix stripped),
// with dots in version numbers normalized to `:`.
export function prefillClassFor(modelId: string): PrefillClass {
  const q = quirksFor(modelId)
  if (q.prefillClass) return q.prefillClass
  const slug = canonicalCompatModelId(modelId)
  if (CLAUDE_NO_PREFILL_PATTERN.test(slug)) return 'unsupported'
  if (OPENAI_PREFILL_UNSUPPORTED_PATTERN.test(slug)) return 'unsupported'
  if (slug.startsWith('claude-')) return 'native'
  if (slug.startsWith('gemini-')) return 'native'
  if (REASONING_REQUIRED_MODELS.has(slug)) return 'oss-reasoning-required'
  return 'oss-toggleable'
}

// Whether reasoning can be toggled off on the wire. Most models default
// toggleable; Gemini and the P.7 reasoning-required list hide the "off"
// mode because those endpoints reject or ignore disabled reasoning.
export function reasoningToggleableFor(modelId: string): boolean {
  const q = quirksFor(modelId)
  if (q.reasoningToggleable !== undefined) return q.reasoningToggleable
  const slug = canonicalCompatModelId(modelId)
  if (slug.startsWith('gemini-')) return false
  if (REASONING_REQUIRED_MODELS.has(slug)) return false
  return true
}

// OpenRouter prompt/text mode support. Transport acceptance is not enough:
// closed-source chat-native families often answer as chat models or refuse the
// ChatML scaffold, and DeepSeek R1 text mode returns reasoning-only output.
// Keep those disabled in the API-mode UI while letting open-weight and unknown
// OSS-like families opt in.
function textCompletionsSupportFor(modelId: string): TextCompletionsSupport {
  const slug = canonicalCompatModelId(modelId).toLowerCase()
  if (!slug) return 'unknown'
  if (/^deepseek-r1(?:$|-0528$)/u.test(slug)) return 'accepted-reasoning-only'
  if (isClosedSourceChatNativeForTextCompletions(slug)) return 'disabled-chat-native'
  if (isKnownOpenWeightTextFamily(slug)) return 'visible'
  return 'unknown'
}

export function isTextCompletionsSelectableFor(modelId: string): boolean {
  const support = textCompletionsSupportFor(modelId)
  return support === 'visible' || support === 'unknown'
}

export function textCompletionsNeedsReasoningOffFor(modelId: string): boolean {
  const slug = canonicalCompatModelId(modelId).toLowerCase()
  if (!reasoningToggleableFor(modelId)) return false
  return (
    slug.startsWith('kimi-k2') ||
    slug.startsWith('glm-5') ||
    slug.startsWith('glm-4:7') ||
    slug.startsWith('qwen3') ||
    slug.startsWith('minimax-m2')
  )
}

function isClosedSourceChatNativeForTextCompletions(slug: string): boolean {
  if (slug.startsWith('claude-')) return true
  if (slug.startsWith('gemini-')) return true
  if (slug.startsWith('grok-')) return true
  if (slug.startsWith('chatgpt-')) return true
  if (/^o\d(?:$|-)/u.test(slug)) return true
  if (slug.startsWith('gpt-') && !slug.startsWith('gpt-oss')) return true
  return false
}

function isKnownOpenWeightTextFamily(slug: string): boolean {
  return (
    slug.startsWith('gpt-oss') ||
    slug.startsWith('llama-') ||
    slug.startsWith('gemma-') ||
    slug.startsWith('deepseek-') ||
    slug.startsWith('qwen') ||
    slug.startsWith('qwq') ||
    slug.startsWith('qvq') ||
    slug.startsWith('glm-') ||
    slug.startsWith('chatglm') ||
    slug.startsWith('kimi-') ||
    slug.startsWith('minimax-') ||
    slug.startsWith('mistral-') ||
    slug.startsWith('mixtral-') ||
    slug.startsWith('ministral-') ||
    slug.startsWith('codestral-') ||
    slug.startsWith('devstral-') ||
    slug.startsWith('pixtral-') ||
    slug.startsWith('command-') ||
    slug.startsWith('phi-')
  )
}

// Strip sampling params that are gated behind `reasoning.effort === 'none'` on
// GPT-5.3-codex / GPT-5.4+ family. Call this BEFORE dispatching. Mutates the request.
//
// Gate contract per `plan/phase11-implementation.md §4.6`:
//   `gpt-5.5{,-pro}`, `gpt-5.4{,-pro,-mini,-nano}`, `gpt-5.3-codex` accept `temperature`,
//   `top_p`, `logprobs`, `top_k` ONLY when `reasoning.effort === 'none'`.
//   Any other effort value makes the API return HTTP 400.
export function adjustGpt54SamplingGate(
  req: Record<string, unknown>,
  modelOrEntry: string | QuirksEntry,
): void {
  const entry = typeof modelOrEntry === 'string' ? quirksFor(modelOrEntry) : modelOrEntry
  if (!entry.gpt54SamplingGate) return
  const reasoning = req.reasoning as { effort?: string } | undefined
  const effort = reasoning?.effort ?? 'none'
  if (effort === 'none') return
  delete req.temperature
  delete req.top_p
  delete req.logprobs
  // `top_k` isn't in the OpenAI spec but appears on Azure passthroughs; strip
  // to keep requests clean.
  delete req.top_k
}

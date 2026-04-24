// Per-model behavioral quirks that /endpoints cannot express. See
// `plan/05-transforms-and-quirks.md` and `CLAUDE.md` "Per-model quirks we
// must honor."
//
// /endpoints tells us which top-level params exist for a model + provider.
// What it CAN'T tell us:
// - which enum values inside `reasoning.effort` / `verbosity` are actually
//   honored (vs silently remapped down)
// - adaptive-only reasoning (Claude 4.6/4.7 ignore effort)
// - Responses-API-required models (GPT-5.3-Codex / 5.4 / 5.4-Pro)
// - cache min-token floors per Anthropic variant
// - `cache_control` top-level vs per-block requirement per endpoint (Bedrock
//   / Vertex need per-block)
//
// This registry narrows the capability set after it comes off the wire. It is
// fallback-only: OpenRouter model discovery, endpoint routing, and provider
// privacy must still work if this table has no row for a new model. Model
// identity comes from the shared cross-provider resolver in `model-ids.ts`, so
// OpenRouter aliases and direct-provider ids do not drift apart.

import type { EffortLevel, ReasoningFormat, VerbosityLevel } from './types'
import { canonicalCompatModelId, canonicalModelSlug } from './model-ids'

// Effort ordered low → high for left-to-right UI rendering. Validation /
// transform code doesn't care about order — it just filters by set
// membership — but UI controls read the array verbatim so the visual
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

export interface QuirksEntry {
  // Empty array means "reasoning.effort is ignored" (adaptive-only).
  // undefined means "no narrowing — use the full superset".
  allowedEffort?: readonly EffortLevel[]
  allowedVerbosity?: readonly VerbosityLevel[]
  // Some models refuse chat-completions and require /responses (GPT-5.4 family).
  requiresResponsesApi?: boolean
  // Soft preference — the api-choice matrix flips to Responses unless the
  // user pinned `chat`. Less aggressive than `requiresResponsesApi` (which
  // forces the switch). Used for models where Responses is strictly better
  // (preserves encrypted reasoning, phase, etc.) but chat completions still
  // works — e.g. GPT-5 / o-series.
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
  //  - `unknown` (DeepSeek-R1 / Qwen3 / Gemma) — no opaque round-trip exists;
  //    plaintext `<think>` tags only.
  reasoningPreservationFormat?: ReasoningFormat
  // Claude 4.6 / 4.7 use adaptive reasoning: `reasoning` is in
  // supported_parameters but `effort` is silently ignored.
  adaptiveReasoningOnly?: boolean
  // Anthropic cache floor — "cache_control" below this token count is
  // not honored. One floor per variant per CLAUDE.md.
  cacheMinTokens?: number
  // `phase` field must be persisted verbatim across Responses-API turns
  // (GPT-5.4 family — dropping phase causes early stopping).
  persistsResponsesPhase?: boolean
  // Same as `persistsResponsesPhase`; Phase 11 introduces the preferred
  // spelling. Kept as a separate field so callers can assert on the
  // intent (the Responses transform reads both).
  requiresPhaseEcho?: boolean
  // Some models emit `<think>…</think>` inline in content; the stream
  // parser needs to lift that into the reasoning lane. Values are the tag
  // names (without brackets) the model uses — DeepSeek-R1 / Qwen3 use
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
  // GPT-5.4 family (including 5.3-codex, 5.4, 5.4-pro, 5.4-mini, 5.4-nano):
  // `temperature`, `top_p`, `logprobs`, `top_k` are ONLY accepted when
  // `reasoning.effort === 'none'`. With any other effort the API rejects
  // the request. The transform strips these at wire time.
  gpt54SamplingGate?: boolean
  // Phase 11: Claude 3.7 Sonnet returns `redacted_thinking` blocks when
  // its internal reasoning is flagged by the safety filter. We store those
  // as `reasoning.encrypted` with `format: 'anthropic-claude-v1'`. Only 3.7
  // accepts these blocks on round-trip; Claude 4+ doesn't produce them
  // and their acceptance is unverified. Guard the echo by setting this
  // flag `true` ONLY on `claude-sonnet-3.7` — the filter drops
  // `reasoning.encrypted + format anthropic-claude-v1` entries when the
  // target model doesn't have this flag.
  acceptsAnthropicRedactedThinking?: boolean
  // Which wire APIs this model accepts. Drives UI toggle visibility and
  // chooseApi's auto-route. Mirrors OpenAI's per-model support list (for
  // OpenRouter we apply the same table — OR accepts /responses on any model
  // via translation, but /responses gives no benefit on non-OpenAI models,
  // so we treat them as chat-only).
  //   'responses-only' — model 404s on chat-completions (gpt-5.4-pro, 5.3-codex,
  //                      5.2-codex, 5.2-pro, 5.1-codex, 5.1-codex-max, 5-codex,
  //                      5-pro, o1-pro, o3-pro, *-deep-research).
  //   'chat-only'      — `*-chat-latest`, gpt-3.5-turbo-instruct, and every
  //                      non-OpenAI-family model (Claude, Gemini, DeepSeek,
  //                      Qwen, Grok, GLM, Kimi, MiniMax, Gemma).
  //   'both'           — gpt-5.4, 5.4-mini, 5.4-nano, 5.3, 5.2, 5.1, 5,
  //                      5-mini/nano, 4.1, 4o, 4, 4-turbo, 3.5-turbo,
  //                      o1, o3, o3-mini, o4-mini.
  // Unset defaults to 'chat-only'.
  responsesSupport?: 'responses-only' | 'chat-only' | 'both'
  // Whether the model emits an opaque encrypted-reasoning carrier that we
  // can echo on the next turn. Drives the "Encrypted reasoning" include
  // checkbox visibility.
  //   'always'     — emits on every reasoning turn (GPT-5.x, Gemini 3+,
  //                  Claude 4.x via signed reasoning.text, Claude 3.7
  //                  redacted_thinking, xAI Grok).
  //   'tools-only' — only emits when tools are in the turn (Gemini 2.5).
  //                  Treated as 'never' for UI purposes — we don't surface
  //                  a checkbox that only works in tool flows.
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
  // Anthropic 4.6 — adaptive-only reasoning. Verbosity `max` is new on
  // 4.6; `xhigh` falls back to `high` so we drop it from the allowed set
  // to avoid rendering a button that silently no-ops.
  'claude-opus-4.6': {
    adaptiveReasoningOnly: true,
    allowedEffort: [],
    allowedVerbosity: ['low', 'medium', 'high', 'max'],
    cacheMinTokens: 4096,
    reasoningPreservationFormat: 'anthropic-claude-v1',
  },
  'claude-sonnet-4.6': {
    adaptiveReasoningOnly: true,
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

  // OpenAI GPT-5.x family — Responses API required, persist phase, strict
  // `gpt54SamplingGate` (temperature/top_p/logprobs only when effort:'none').
  // Effort enum authoritative from `openai_docs/pages/docs/guides/latest-model.md`
  // + live probe 4: `none (default) | low | medium | high | xhigh` — NO
  // `minimal`. Verbosity: low/medium/high/xhigh (no max — max is Claude-only).
  'gpt-5.4-pro': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    gpt54SamplingGate: true,
    allowedEffort: ['none', 'low', 'medium', 'high', 'xhigh'],
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
    reasoningPreservationFormat: 'openai-responses-v1',
    responsesSupport: 'responses-only',
  },
  // gpt-5.4 family (non-pro): chat-completions accepts the model but drops
  // `phase` — slug heuristic gives 'both' (toggle shown); `preferApi:
  // 'responses'` + `persistsResponsesPhase: true` make the auto-route
  // default to Responses. Users who pin chat explicitly trip the
  // confirmation dialog in `ApiModeSection`.
  'gpt-5.4-nano': {
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    gpt54SamplingGate: true,
    preferApi: 'responses',
    allowedEffort: ['none', 'low', 'medium', 'high', 'xhigh'],
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
  'gpt-5.4-mini': {
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    gpt54SamplingGate: true,
    preferApi: 'responses',
    allowedEffort: ['none', 'low', 'medium', 'high', 'xhigh'],
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
  'gpt-5.4': {
    persistsResponsesPhase: true,
    requiresPhaseEcho: true,
    gpt54SamplingGate: true,
    preferApi: 'responses',
    allowedEffort: ['none', 'low', 'medium', 'high', 'xhigh'],
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
    reasoningPreservationFormat: 'openai-responses-v1',
  },
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
  // Responses-only OpenAI models that aren't yet in our UI model list but
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
  //     disable — still no hard-disable path).
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
  // Fallback catch-alls for any unknown Gemini 3.x variant — take the
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
  // native probes — plain conversational turns return no signature). User
  // directive: treat as 'never' — only Gemini 3+ is expected to round-trip
  // encrypted reasoning. The explicit override flips the format-derived
  // 'always' default to 'never' so the include-encrypted checkbox hides.
  // Single prefix key covers pro / flash / flash-lite / dated-preview
  // variants.
  'gemini-2.5': {
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'google-gemini-v1',
    emitsEncryptedReasoning: 'never',
  },

  // Inline-tag reasoning (DeepSeek-R1, Qwen3, Gemma) — the stream parser
  // lifts <think>…</think> into the reasoning lane. These models expose
  // low/medium/high effort per plan §5.5; the rest of the FULL_EFFORT
  // superset (none/minimal/xhigh) falls through to high server-side on
  // most of their endpoints, so we hide those buttons rather than let
  // users pick a no-op value. No encrypted carrier exists — `unknown` format
  // means the carry-forward matrix drops encrypted entries silently.
  // Current open-source / Chinese-lab thinking models (all emit
  // `reasoning_details[]` with `format: "unknown"` on OpenRouter — no
  // encrypted carrier). Entries key on the current flagship slug; legacy
  // siblings (deepseek-r1, deepseek-v3.x, qwen3-next, gemma-3, kimi-k2 plain, glm-4.x,
  // minimax-m1/m2/m2.5) are intentionally dropped since they're superseded.
  'deepseek-v4': {
    reasoningInlineTags: ['think'],
    allowedEffort: ['high', 'xhigh'],
    reasoningPreservationFormat: 'unknown',
  },
  'qwen3.6': {
    reasoningInlineTags: ['think'],
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'unknown',
  },
  'gemma-4': {
    reasoningInlineTags: ['thought', 'think'],
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'unknown',
  },
  'kimi-k2.6': {
    reasoningInlineTags: ['think'],
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'unknown',
  },
  'glm-5.1': {
    reasoningInlineTags: ['think'],
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'unknown',
  },
  'glm-5': {
    reasoningInlineTags: ['think'],
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'unknown',
  },
  'minimax-m2.7': {
    reasoningInlineTags: ['think'],
    allowedEffort: ['low', 'medium', 'high'],
    reasoningPreservationFormat: 'unknown',
  },

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

export function quirksFor(modelId: string): QuirksEntry {
  const normalized = canonicalCompatModelId(modelId)
  for (const key of REGISTRY_KEYS_BY_LENGTH) {
    const normalizedKey = canonicalCompatModelId(key)
    if (normalized === normalizedKey || normalized.startsWith(`${normalizedKey}-`)) {
      const entry = REGISTRY[key]
      if (entry) return entry
    }
  }
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
// fallback when the model isn't in the registry so we still route OpenAI
// models on OpenRouter to Responses by default.
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
// OpenAI-family; otherwise `'chat-only'` (safest — don't show a toggle for
// a model we don't know supports /responses).
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

// Tag set for inline-reasoning lifting. Registry entries narrow this; unset
// means "auto-detect generically". The stream splitter reads this via
// `inlineReasoningTagsFor` and passes it to `createInlineReasoningLifter`.
export function inlineReasoningTagsFor(modelId: string): readonly string[] | undefined {
  return quirksFor(modelId).reasoningInlineTags
}

// Strip sampling params that are gated behind `reasoning.effort === 'none'` on
// the GPT-5.4 family. Call this BEFORE dispatching. Mutates the request.
//
// Gate contract per `plan/phase11-implementation.md §4.6`:
//   `gpt-5.4{,-pro,-mini,-nano}`, `gpt-5.3-codex` accept `temperature`,
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

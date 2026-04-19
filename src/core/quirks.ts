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
// This registry narrows the capability set after it comes off the wire. It
// is a lookup by model id prefix — the OpenRouter id ("anthropic/claude-
// opus-4.7") and the bundled id ("claude-opus-4.7") both match.

import type { EffortLevel, VerbosityLevel } from './types'

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
  // Claude 4.6 / 4.7 use adaptive reasoning: `reasoning` is in
  // supported_parameters but `effort` is silently ignored.
  adaptiveReasoningOnly?: boolean
  // Anthropic cache floor — "cache_control" below this token count is
  // not honored. One floor per variant per CLAUDE.md.
  cacheMinTokens?: number
  // `phase` field must be persisted verbatim across Responses-API turns
  // (GPT-5.4 family — dropping phase causes early stopping).
  persistsResponsesPhase?: boolean
  // Some models emit `<think>…</think>` inline in content; the stream
  // parser needs to lift that into the reasoning lane.
  reasoningInlineTags?: boolean
  // Reasoning happens but isn't returned (OpenAI o-series on chat-
  // completions; some preview Gemini). The UI hides the reasoning panel
  // on these.
  reasoningHidden?: boolean
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
  },
  // Anthropic 4.6 — adaptive-only reasoning. Verbosity `max` is new on
  // 4.6; `xhigh` falls back to `high` so we drop it from the allowed set
  // to avoid rendering a button that silently no-ops.
  'claude-opus-4.6': {
    adaptiveReasoningOnly: true,
    allowedEffort: [],
    allowedVerbosity: ['low', 'medium', 'high', 'max'],
    cacheMinTokens: 4096,
  },
  'claude-sonnet-4.6': {
    adaptiveReasoningOnly: true,
    allowedEffort: [],
    allowedVerbosity: ['low', 'medium', 'high', 'max'],
    cacheMinTokens: 2048,
  },
  // 4.5-series Claude supports effort-based reasoning (low/med/high +
  // budget). Verbosity is NOT supported; /endpoints confirms.
  'claude-haiku-4.5': {
    cacheMinTokens: 4096,
    allowedEffort: ['low', 'medium', 'high'],
    allowedVerbosity: [],
  },
  'claude-opus-4.5': {
    cacheMinTokens: 4096,
    allowedEffort: ['low', 'medium', 'high'],
    allowedVerbosity: [],
  },
  'claude-sonnet-4.5': {
    cacheMinTokens: 1024,
    allowedEffort: ['low', 'medium', 'high'],
    allowedVerbosity: [],
  },
  'claude-opus-4.1': { cacheMinTokens: 1024 },
  'claude-opus-4': { cacheMinTokens: 1024 },
  'claude-haiku-3.5': { cacheMinTokens: 2048 },
  'claude-sonnet-3.7': { cacheMinTokens: 1024 },

  // OpenAI GPT-5.x family — Responses API required, persist phase. Full
  // effort superset honored. Verbosity: low/medium/high/xhigh (no max —
  // per OpenRouter docs line 23135 and subagent audit).
  'gpt-5.4-pro': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
  },
  'gpt-5.4': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
  },
  'gpt-5.3-codex': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    // Codex variant typically has no verbosity parameter exposed.
    allowedVerbosity: [],
  },
  'gpt-5.3': {
    requiresResponsesApi: true,
    persistsResponsesPhase: true,
    allowedVerbosity: ['low', 'medium', 'high', 'xhigh'],
  },

  // OpenAI o-series: reasoning runs but is NOT returned over chat-
  // completions (Responses API is needed to see it). Effort controls
  // token allocation; verbosity isn't surfaced on o-series.
  o1: { reasoningHidden: true, allowedVerbosity: [] },
  'o1-mini': { reasoningHidden: true, allowedVerbosity: [] },
  'o1-pro': { reasoningHidden: true, allowedVerbosity: [] },
  'o3-mini': { reasoningHidden: true, allowedVerbosity: [] },
  o3: { reasoningHidden: true, allowedVerbosity: [] },
  'o4-mini': { reasoningHidden: true, allowedVerbosity: [] },

  // Gemini 3: thinking-config effort supports min/low/med/high; xhigh maps down.
  'gemini-3.1-pro': { allowedEffort: ['minimal', 'low', 'medium', 'high'] },
  'gemini-3.1-flash': { allowedEffort: ['minimal', 'low', 'medium', 'high'] },
  'gemini-3.1-flash-lite-preview': { allowedEffort: ['minimal', 'low', 'medium', 'high'] },

  // Inline-tag reasoning (DeepSeek-R1, Qwen3, Gemma) — the stream parser
  // lifts <think>…</think> into the reasoning lane. These models expose
  // low/medium/high effort per plan §5.5; the rest of the FULL_EFFORT
  // superset (none/minimal/xhigh) falls through to high server-side on
  // most of their endpoints, so we hide those buttons rather than let
  // users pick a no-op value.
  'deepseek-r1': { reasoningInlineTags: true, allowedEffort: ['low', 'medium', 'high'] },
  qwen3: { reasoningInlineTags: true, allowedEffort: ['low', 'medium', 'high'] },
  'gemma-3': { reasoningInlineTags: true },

  // xAI Grok 3/4 — per plan §5.5 and jan's provider matrix. Effort
  // surfaces as low/medium/high only; full superset values clamp.
  'grok-3': { allowedEffort: ['low', 'medium', 'high'] },
  'grok-4': { allowedEffort: ['low', 'medium', 'high'] },
}

const REGISTRY_KEYS_BY_LENGTH = Object.keys(REGISTRY).sort((a, b) => b.length - a.length)

// Strip the provider prefix ("anthropic/claude-opus-4.7" → "claude-opus-4.7")
// and then scan the registry for the longest matching key.
function normalizeModelId(modelId: string): string {
  const slash = modelId.indexOf('/')
  return slash >= 0 ? modelId.slice(slash + 1) : modelId
}

export function quirksFor(modelId: string): QuirksEntry {
  const normalized = normalizeModelId(modelId)
  for (const key of REGISTRY_KEYS_BY_LENGTH) {
    if (normalized === key || normalized.startsWith(`${key}-`)) {
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

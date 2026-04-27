// Defensive guards for all token math. Every field read from a wire `usage.*`,
// every char-count cast through `.length`, every content iteration: any of
// these can blow up on NaN / undefined / corrupt rows / pathological inputs.
// This module funnels all of that into a handful of small helpers so the
// counting core (tokens.ts / prompt-size.ts / context-cutoff.ts / cost.ts)
// never has to think about it. See `plan/token-counting-audit.md` for the
// full rationale and the audit findings each helper addresses.
//
// Discipline:
//   - Non-string inputs always return 0 (not throw).
//   - Non-finite / negative numeric inputs always return 0 or undefined.
//   - Upper bound is MAX_PLAUSIBLE_TOKENS; anything above is either a DoS
//     attempt (e.g. 10MB encrypted blob → 3.3M token estimate) or a bug
//     that must not propagate into the UI gauge / budget math.

import type { ContentItem } from './types'

// 100M, an order of magnitude above any real model's context window (current
// peak is ~2M on Gemini 1.5 Pro). Any counter that exceeds this is broken.
export const MAX_PLAUSIBLE_TOKENS = 100_000_000

export function safeLen(text: unknown): number {
  return typeof text === 'string' ? text.length : 0
}

export function isFiniteNonNegNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

// Validate a server-provided token count. Returns the number (floored) if
// it's finite, non-negative, below MAX_PLAUSIBLE_TOKENS. Negative / NaN /
// Infinity / non-number → undefined so the caller's `?? 0` fallback fires
// instead of storing garbage. Caps absurdly huge values at MAX_PLAUSIBLE_TOKENS
// rather than returning undefined so genuinely-large-but-broken usage still
// flows through the math without breaking budgets downstream.
export function safeServerTokens(n: unknown): number | undefined {
  if (!isFiniteNonNegNumber(n)) return undefined
  if (n > MAX_PLAUSIBLE_TOKENS) return MAX_PLAUSIBLE_TOKENS
  return Math.floor(n)
}

// Clamp a local heuristic estimate into [0, MAX_PLAUSIBLE_TOKENS]. Handles
// NaN / Infinity / negatives by returning 0; they would otherwise poison sums.
export function clampTokens(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0
  if (n > MAX_PLAUSIBLE_TOKENS) return MAX_PLAUSIBLE_TOKENS
  return n
}

// Defensive content iteration. A message row rehydrated from a corrupt DB
// might have `content: null` / `content: undefined` / `content: "string"`.
// All of those iterate as empty.
export function safeContent(content: unknown): readonly ContentItem[] {
  return Array.isArray(content) ? (content as ContentItem[]) : []
}

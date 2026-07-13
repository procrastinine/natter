// Two wire shapes flow in:
//
//   Chat completions `usage`: `{prompt_tokens, completion_tokens, total_tokens,
//                              prompt_tokens_details?, completion_tokens_details?,
//                              cost?, cost_details?, cache_creation_input_tokens?}`
//
//   Responses API `usage`:    `{input_tokens, output_tokens, total_tokens,
//                              input_tokens_details?, output_tokens_details?, cost?}`
//
// We normalize both into `NormalizedUsage` so downstream (display, context gauge,
// metrics) has one shape to deal with. `cost` is authoritative whenever the
// stream/response returns it (OpenRouter adds `cost` even on chat-completions,
// though it's optional on vanilla OpenAI — treat missing cost as 0 for sums).

import { safeServerTokens } from './token-guards'
import type { ChatUsage, Message } from './types'

interface NormalizedUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  reasoningTokens: number
  cachedTokens: number
  cacheCreationTokens: number
  cost: number
}

// Responses API usage shape. Kept local since `ChatUsage` in `types.ts` holds the
// chat-completions shape verbatim; Responses usage is normalized on ingest before
// being stored.
export interface ResponsesUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens?: number
  }
  cost?: number
}

const ZERO_USAGE: NormalizedUsage = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  cost: 0,
})

export function emptyUsage(): NormalizedUsage {
  return { ...ZERO_USAGE }
}

// `safeServerTokens` rejects negatives / NaN / Infinity / non-number and caps
// implausibly large values at MAX_PLAUSIBLE_TOKENS. `?? 0` converts those
// back to zero so `NormalizedUsage` fields are always finite non-negative.
// `cost` stays raw but is gated on `Number.isFinite` so NaN can't poison sums.
function safeCost(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0
}

export function normalizeChatUsage(usage: ChatUsage | null | undefined): NormalizedUsage {
  if (!usage) return emptyUsage()
  return {
    promptTokens: safeServerTokens(usage.prompt_tokens) ?? 0,
    completionTokens: safeServerTokens(usage.completion_tokens) ?? 0,
    totalTokens: safeServerTokens(usage.total_tokens) ?? 0,
    reasoningTokens: safeServerTokens(usage.completion_tokens_details?.reasoning_tokens) ?? 0,
    cachedTokens: safeServerTokens(usage.prompt_tokens_details?.cached_tokens) ?? 0,
    cacheCreationTokens: safeServerTokens(usage.cache_creation_input_tokens) ?? 0,
    cost: safeCost(usage.cost),
  }
}

export function normalizeResponsesUsage(usage: ResponsesUsage | null | undefined): NormalizedUsage {
  if (!usage) return emptyUsage()
  return {
    promptTokens: safeServerTokens(usage.input_tokens) ?? 0,
    completionTokens: safeServerTokens(usage.output_tokens) ?? 0,
    totalTokens: safeServerTokens(usage.total_tokens) ?? 0,
    reasoningTokens: safeServerTokens(usage.output_tokens_details?.reasoning_tokens) ?? 0,
    cachedTokens: safeServerTokens(usage.input_tokens_details?.cached_tokens) ?? 0,
    cacheCreationTokens: 0,
    cost: safeCost(usage.cost),
  }
}

// Sum `generation.cost` across all non-deleted messages on every branch.
// Messages without a generation cost contribute zero.
export function aggregateChatCost(messages: readonly Message[]): number {
  let total = 0
  for (const m of messages) {
    if (m.deleted) continue
    const c = m.generation?.cost
    if (typeof c === 'number' && Number.isFinite(c)) total += c
  }
  return total
}

// Cost + token extraction and aggregation. See `plan/02-data-model.md §2.1`
// (`chat.totalCostUsd`) and `plan/13-delivery.md §13.2` (phase 2).
//
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

import type { ChatUsage, Message } from './types'

export interface NormalizedUsage {
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

export function normalizeChatUsage(usage: ChatUsage | null | undefined): NormalizedUsage {
  if (!usage) return emptyUsage()
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cost: usage.cost ?? 0,
  }
}

export function normalizeResponsesUsage(
  usage: ResponsesUsage | null | undefined,
): NormalizedUsage {
  if (!usage) return emptyUsage()
  return {
    promptTokens: usage.input_tokens ?? 0,
    completionTokens: usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    cachedTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheCreationTokens: 0,
    cost: usage.cost ?? 0,
  }
}

// Sum `generation.cost` across all non-deleted messages (all branches). Mirrors
// the `chat.totalCostUsd` recompute rule in `plan/02-data-model.md §2.1` + §13.5.
// Messages without a `generation.cost` field contribute 0.
export function aggregateChatCost(messages: readonly Message[]): number {
  let total = 0
  for (const m of messages) {
    if (m.deleted) continue
    const c = m.generation?.cost
    if (typeof c === 'number' && Number.isFinite(c)) total += c
  }
  return total
}

// Real tokenization needs the model's tokenizer binary and is out of scope for V1.
// These char/token ratios are deliberately conservative (they over-report slightly)
// so the UI context gauge is safer to under-fill. `usage.*_tokens` in the response
// is authoritative and always wins during reconciliation.

import {
  providerOutputItemsIncludedInContext,
  renderProviderOutputItemsAsText,
} from './provider-tool-context'
import { clampTokens, safeContent, safeLen, safeServerTokens } from './token-guards'

export type TokenizerFamily =
  | 'claude'
  | 'gpt'
  | 'gemini'
  | 'llama'
  | 'mistral'
  | 'deepseek'
  | 'qwen'
  | 'unknown'

// Family → characters per token. Lower = more tokens per char = more conservative.
// `gpt` covers both `cl100k_base` and `o200k_base` per the table in §14.15; other
// OSS families share the `llama/mistral/deepseek/qwen = 3.5` bucket.
const CHAR_PER_TOKEN: Readonly<Record<TokenizerFamily, number>> = Object.freeze({
  claude: 3.8,
  gpt: 3.5,
  gemini: 4.0,
  llama: 3.5,
  mistral: 3.5,
  deepseek: 3.5,
  qwen: 3.5,
  unknown: 4.0,
})

// Normalize a tokenizer string from `/endpoints` `architecture.tokenizer` into
// the coarse family bucket. Accepts the canonical names observed across
// OpenRouter (`Claude`, `GPT`, `cl100k_base`, `o200k_base`, `Gemini`, `Llama`,
// `Llama3`, `Mistral`, `DeepSeek`, `Qwen`) and is defensively case-insensitive
// because the field shape isn't formally contracted.
export function tokenizerFamily(name: string | null | undefined): TokenizerFamily {
  if (!name) return 'unknown'
  const s = name.toLowerCase()
  if (s.includes('claude')) return 'claude'
  if (s.includes('gpt') || s.includes('cl100k') || s.includes('o200k')) return 'gpt'
  if (s.includes('gemini')) return 'gemini'
  if (s.includes('llama')) return 'llama'
  if (s.includes('mistral')) return 'mistral'
  if (s.includes('deepseek')) return 'deepseek'
  if (s.includes('qwen')) return 'qwen'
  return 'unknown'
}

export function charPerToken(family: TokenizerFamily): number {
  return CHAR_PER_TOKEN[family]
}

// Rough token count for a text blob. Uses `Math.ceil` so the trailing partial
// token is counted, matching the "slightly over-report" discipline in §14.15.
// Defensive against null/undefined/non-string input via `safeLen`.
export function estimateTokens(text: unknown, family: TokenizerFamily): number {
  const len = safeLen(text)
  if (len === 0) return 0
  return clampTokens(Math.ceil(len / CHAR_PER_TOKEN[family]))
}

// Convenience: estimate using a raw `architecture.tokenizer` string directly.
export function estimateTokensByTokenizer(
  text: string,
  tokenizerName: string | null | undefined,
): number {
  return estimateTokens(text, tokenizerFamily(tokenizerName))
}

// ---------------------------------------------------------------------------
// Phase 11: reasoning-echo token accounting.
// ---------------------------------------------------------------------------

import { filterReasoningForInclude, normalizeReasoningDetails } from './reasoning'
import type { Message, ReasoningFormat, ReasoningInclude } from './types'

export interface PromptEstimateOptions {
  family: TokenizerFamily
  reasoningInclude: ReasoningInclude
  reasoningPreservationFormat?: ReasoningFormat
  // When `true`, the server won't return reasoning on the *current* turn
  // (so there's nothing to echo on the *next* one). Forces visible-summary
  // / visible-text echo cost to 0 regardless of include flags.
  reasoningExcluded: boolean
  includeToolCalls?: boolean
}

// Rough token cost of the reasoning fragments echoed on the NEXT turn for
// a given list of assistant messages. Call AFTER filtering the path for
// `hiddenFromContext` / `deleted`:
//
//   - reasoning.text.text (+ small signature overhead when present) → char-heuristic
//   - reasoning.summary.summary → char-heuristic
//   - reasoning.encrypted.data → upper bound ≈ bytes/3 (OpenAI encrypted_content
//     tokens are accounted as prompt_tokens on the next call; exact ratio is
//     model-dependent, this is a safe over-estimate)
//
// The estimate NEVER double-counts: only `reasoningDetails[]` is iterated
// (storage never carries the scalar `reasoning` field; it was suppressed
// by the splitter's de-dup fix in commit 1390685).
// `normalizeReasoningDetails` applies per-row provider relabeling without
// guessing that overlap-looking persisted rows are duplicates.
const SIGNATURE_TOKEN_GUARD = 16

export function estimateReasoningEchoTokensForMessage(
  message: Message,
  opts: PromptEstimateOptions,
): number {
  if (message.role !== 'assistant') return 0
  if (!message.reasoningDetails || message.reasoningDetails.length === 0) return 0

  // Whole body wrapped: a corrupt rehydrated row with `reasoningDetails`
  // items of unexpected shape would otherwise crash the gauge. A
  // conservative 0 estimate is preferred over a UI-wide break.
  try {
    const normalized = normalizeReasoningDetails(message.reasoningDetails)

    // Apply the include matrix: if the user excluded reasoning entirely on
    // THIS turn, visible summary/text don't count (nothing was returned).
    const includeForEcho: ReasoningInclude = opts.reasoningExcluded
      ? { encrypted: opts.reasoningInclude.encrypted, summary: false, text: false }
      : opts.reasoningInclude
    const kept = filterReasoningForInclude(
      normalized,
      includeForEcho,
      opts.reasoningPreservationFormat,
    )

    // When the assistant message has `reasoning_tokens` from the provider,
    // that number is the authoritative upper bound for the round-trip cost
    // of echoing the ENCRYPTED blob (OpenAI's encrypted_content, xAI's
    // encrypted reasoning, Anthropic's signed text; all tokenize back at
    // roughly the same count as they were emitted). Without it the
    // estimator falls back to the conservative `data.length / 3` byte-cap
    // estimate, which over-reports by ~1.8x for base64-ish blobs.
    const providerReasoningTokens = safeServerTokens(
      message.generation?.usage?.completion_tokens_details?.reasoning_tokens,
    )

    let encryptedCharCost = 0
    let visibleCost = 0
    for (const d of kept) {
      if (d.type === 'reasoning.text') {
        if (typeof d.text === 'string') {
          if (typeof d.signature === 'string' && d.signature.length > 0) {
            // Anthropic signed text is the encrypted carrier; count it as
            // encrypted-like so the `reasoning_tokens` clamp applies.
            encryptedCharCost += estimateTokens(d.text, opts.family) + SIGNATURE_TOKEN_GUARD
          } else {
            visibleCost += estimateTokens(d.text, opts.family)
          }
        }
      } else if (d.type === 'reasoning.summary') {
        visibleCost += estimateTokens(d.summary, opts.family)
      } else {
        // Cap raw byte-length contribution; a 10MB blob would otherwise
        // balloon to ~3.3M tokens and poison both the gauge and budget math.
        encryptedCharCost += clampTokens(Math.ceil(safeLen(d.data) / 3))
      }
    }

    if (encryptedCharCost > 0 && providerReasoningTokens !== undefined) {
      // Authoritative clamp: echoing encrypted reasoning costs AT MOST
      // what the provider charged as reasoning_tokens on the original
      // turn. Usually lands within a few percent of the true echo cost.
      return clampTokens(Math.min(encryptedCharCost, providerReasoningTokens) + visibleCost)
    }
    return clampTokens(encryptedCharCost + visibleCost)
  } catch {
    return 0
  }
}

export function estimateReasoningEchoTokens(
  messages: readonly Message[],
  opts: PromptEstimateOptions,
): number {
  let total = 0
  for (const message of messages) {
    total += estimateReasoningEchoTokensForMessage(message, opts)
  }
  return total
}

export function estimateToolCallContextTokensForMessage(
  message: Message,
  opts: Pick<PromptEstimateOptions, 'family' | 'includeToolCalls'>,
): number {
  if (message.role !== 'assistant') return 0
  if (opts.includeToolCalls !== true) return 0
  const items = providerOutputItemsIncludedInContext(message, {
    includeToolCalls: opts.includeToolCalls,
  })
  if (items.length === 0) return 0
  return estimateTokens(renderProviderOutputItemsAsText(items), opts.family)
}

export function estimateToolCallContextTokens(
  messages: readonly Message[],
  opts: Pick<PromptEstimateOptions, 'family' | 'includeToolCalls'>,
): number {
  let total = 0
  for (const message of messages) total += estimateToolCallContextTokensForMessage(message, opts)
  return total
}

// Convenience: estimate prompt-token cost of an entire path including
// reasoning echo. Visible content + system prompt use the existing
// `estimateTokens`; reasoning echo uses `estimateReasoningEchoTokens`.
export function estimatePromptTokens(
  messages: readonly Message[],
  systemPrompt: string,
  opts: PromptEstimateOptions,
): number {
  let total = 0
  if (safeLen(systemPrompt) > 0) total += estimateTokens(systemPrompt, opts.family)
  for (const message of messages) {
    if (message.hiddenFromContext === true || message.deleted) continue
    for (const item of safeContent(message.content)) {
      if (item.type === 'text' || item.type === 'output_text') {
        total += estimateTokens(item.text, opts.family)
      }
    }
  }
  total += estimateReasoningEchoTokens(messages, opts)
  total += estimateToolCallContextTokens(messages, opts)
  return clampTokens(total)
}

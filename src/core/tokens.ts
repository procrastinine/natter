// Real tokenization needs the model's tokenizer binary and is out of scope for V1.
// These char/token ratios are deliberately conservative (they over-report slightly)
// so the UI context gauge is safer to under-fill. `usage.*_tokens` in the response
// is authoritative and always wins during reconciliation.

import { createAppliedMessageView } from './continuation-content'
import type {
  AnthropicReasoningCompilation,
  ChatReasoningCompilation,
  GeminiReasoningCompilation,
  OutboundReasoningCompilation,
  OutboundReasoningResolver,
  ResponsesReasoningCompilation,
} from './outbound-reasoning'
import {
  type AttemptProviderOutputContract,
  estimateNativeProviderOutputCharacters,
  projectProviderOutputForContext,
  renderProviderOutputContextFallback,
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

import type { Message } from './types'

export interface PromptEstimateOptions {
  family: TokenizerFamily
  reasoningResolver: OutboundReasoningResolver
  providerOutput: AttemptProviderOutputContract
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
const SIGNATURE_TOKEN_GUARD = 16

export function estimateReasoningEchoTokensForMessage(
  message: Message,
  opts: PromptEstimateOptions,
): number {
  if (message.role !== 'assistant') return 0
  return estimateCompiledReasoningTokens(
    opts.reasoningResolver.compilationFor(message),
    opts.family,
  )
}

export function estimateCompiledReasoningTokens(
  compiled: OutboundReasoningCompilation,
  family: TokenizerFamily,
): number {
  let total = compiled.inline ? estimateTokens(compiled.inline, family) : 0
  switch (compiled.kind) {
    case 'text':
      return clampTokens(total)
    case 'chat':
      total += estimateCompiledChatAttempts(compiled, family)
      break
    case 'responses':
      total += estimateCompiledResponsesAttempts(compiled, family)
      break
    case 'anthropic':
      total += estimateCompiledAnthropicAttempts(compiled, family)
      break
    case 'gemini':
      total += estimateCompiledGeminiAttempts(compiled, family)
      break
  }
  return clampTokens(total)
}

function cappedAttemptCost(
  opaque: number,
  visible: number,
  reportedReasoningTokens: number | undefined,
): number {
  const reported = safeServerTokens(reportedReasoningTokens)
  return clampTokens(
    (opaque > 0 && reported !== undefined ? Math.min(opaque, reported) : opaque) + visible,
  )
}

function estimateCompiledChatAttempts(
  compiled: ChatReasoningCompilation,
  family: TokenizerFamily,
): number {
  let total = 0
  for (const attempt of compiled.attempts) {
    let opaque = 0
    let visible = 0
    for (const detail of attempt.units) {
      if (detail.type === 'reasoning.encrypted') {
        opaque += clampTokens(Math.ceil(safeLen(detail.data) / 3))
      } else if (detail.type === 'reasoning.summary') {
        visible += estimateTokens(detail.summary, family)
      } else if (typeof detail.text === 'string') {
        if (typeof detail.signature === 'string' && detail.signature.length > 0) {
          opaque += estimateTokens(detail.text, family) + SIGNATURE_TOKEN_GUARD
        } else {
          visible += estimateTokens(detail.text, family)
        }
      }
    }
    total += cappedAttemptCost(opaque, visible, attempt.reportedReasoningTokens)
  }
  return total
}

function estimateCompiledResponsesAttempts(
  compiled: ResponsesReasoningCompilation,
  family: TokenizerFamily,
): number {
  let total = 0
  for (const attempt of compiled.attempts) {
    let opaque = 0
    let visible = 0
    for (const unit of attempt.units) {
      if (unit.encryptedContent) {
        opaque += clampTokens(Math.ceil(safeLen(unit.encryptedContent) / 3))
      }
      for (const summary of unit.summaries) visible += estimateTokens(summary.text, family)
    }
    total += cappedAttemptCost(opaque, visible, attempt.reportedReasoningTokens)
  }
  return total
}

function estimateCompiledAnthropicAttempts(
  compiled: AnthropicReasoningCompilation,
  family: TokenizerFamily,
): number {
  let total = 0
  for (const attempt of compiled.attempts) {
    let opaque = 0
    for (const unit of attempt.units) {
      opaque +=
        unit.kind === 'thinking-authenticated'
          ? estimateTokens(unit.text, family) + SIGNATURE_TOKEN_GUARD
          : clampTokens(Math.ceil(safeLen(unit.data) / 3))
    }
    total += cappedAttemptCost(opaque, 0, attempt.reportedReasoningTokens)
  }
  return total
}

function estimateCompiledGeminiAttempts(
  compiled: GeminiReasoningCompilation,
  family: TokenizerFamily,
): number {
  let total = 0
  for (const attempt of compiled.attempts) {
    let opaque = 0
    let visible = 0
    for (const unit of attempt.units) {
      if (unit.kind === 'bound-thought') {
        opaque += clampTokens(Math.ceil(safeLen(unit.signature) / 3))
        visible += estimateTokens(unit.text, family)
      } else if (unit.kind === 'unbound-signature') {
        opaque += clampTokens(Math.ceil(safeLen(unit.signature) / 3))
      } else {
        visible += estimateTokens(unit.text, family)
      }
    }
    total += cappedAttemptCost(opaque, visible, attempt.reportedReasoningTokens)
  }
  return total
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
  opts: Pick<PromptEstimateOptions, 'family' | 'providerOutput' | 'includeToolCalls'>,
): number {
  if (message.role !== 'assistant') return 0
  if (opts.includeToolCalls !== true) return 0
  const projection = projectProviderOutputForContext(
    createAppliedMessageView(message),
    opts.providerOutput,
    {
      includeToolCalls: opts.includeToolCalls,
    },
  )
  const fallback = renderProviderOutputContextFallback(projection)
  const fallbackTokens = fallback ? estimateTokens(fallback, opts.family) : 0
  const nativeCharacters = estimateNativeProviderOutputCharacters(projection)
  const nativeTokens =
    nativeCharacters > 0
      ? clampTokens(
          Math.ceil(
            (nativeCharacters + projection.native.length * 8) / CHAR_PER_TOKEN[opts.family],
          ),
        )
      : 0
  return clampTokens(fallbackTokens + nativeTokens)
}

export function estimateToolCallContextTokens(
  messages: readonly Message[],
  opts: Pick<PromptEstimateOptions, 'family' | 'providerOutput' | 'includeToolCalls'>,
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

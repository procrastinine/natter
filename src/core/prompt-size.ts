// Rough pre-send prompt-size estimate. See `plan/14-details.md §14.15` for
// the tokenization ratio; `plan/10-ui.md §10.9` for the gauge this feeds.
//
// We do not have the model's tokenizer; we approximate with a family-keyed
// char/token ratio. The number is ONLY used for UI context gauges and for
// the truncation preview — the authoritative token count comes from the
// stream's `usage.prompt_tokens`.
//
// The estimate covers the active path, the system prompt, and the
// composer draft. Attachments are approximated by a flat 258 tokens per
// image and their file sizes for docs — same approximations used
// elsewhere when we don't have a precise image-token helper yet.
//
// Reasoning echo: when an assistant message carries `reasoningDetails[]`,
// the next turn echoes the subset allowed by the chat's `ReasoningInclude`
// flags (`encrypted` / `summary` / `text`) back in the wire. That costs
// prompt tokens — `filterReasoningForInclude` + `estimateReasoningEchoTokens`
// live in `core/tokens.ts` and `core/reasoning.ts` respectively. Per-block
// `hidden: true` is honored inside the filter, so toggling the eye on a
// reasoning row drops its contribution from the gauge.

import { activePath } from './active-path'
import {
  type PromptEstimateOptions,
  estimateReasoningEchoTokens,
  estimateTokens,
  type TokenizerFamily,
  tokenizerFamily,
} from './tokens'
import type {
  ChatSettings,
  ContentItem,
  Message,
  ReasoningFormat,
  ReasoningInclude,
} from './types'

export interface PromptSizeEstimateInput {
  systemPrompt: string
  activePathMessages: Message[]
  draftText: string
  tokenizer: TokenizerFamily
  // Caller opts in by passing these; when omitted, reasoning contributes
  // zero to the total (backcompat with pre-Phase-11 callers). The Context
  // panel and composer gauge always pass them so toggling the three
  // Include checkboxes updates the number live.
  reasoningInclude?: ReasoningInclude
  reasoningPreservationFormat?: ReasoningFormat
  reasoningExcluded?: boolean
}

export interface PromptSizeEstimate {
  systemTokens: number
  historyTokens: number
  draftTokens: number
  mediaTokens: number
  reasoningTokens: number
  total: number
}

const IMAGE_TOKEN_ESTIMATE = 258 // OpenAI "low-detail" image cost as a placeholder.

function mediaTokenCountFor(content: readonly ContentItem[]): number {
  let tokens = 0
  for (const item of content) {
    if (item.type === 'image_url' || item.type === 'output_image') {
      tokens += IMAGE_TOKEN_ESTIMATE
    }
    if (item.type === 'file') {
      // One token per 3 bytes is a conservative cap for PDF/file upload
      // estimates until the upstream provider returns a better number.
      const bytes = 0 // We don't have the actual size handy here; treat
      // files as ~1000 tokens each for the rough gauge.
      tokens += bytes > 0 ? Math.ceil(bytes / 3) : 1000
    }
  }
  return tokens
}

function plainTextOf(content: readonly ContentItem[]): string {
  let out = ''
  for (const item of content) {
    if (item.type === 'text' || item.type === 'output_text') {
      out += item.text
    }
  }
  return out
}

export function estimatePromptSize(input: PromptSizeEstimateInput): PromptSizeEstimate {
  const family = input.tokenizer
  const systemTokens = estimateTokens(input.systemPrompt, family)

  // We always compute a character-based fallback estimate so edits,
  // deletions, and inserts between sends are reflected immediately —
  // the provider-reported `prompt_tokens` on older assistant messages
  // is frozen at the time of that request and can lie about current
  // path content. The final number is max(fallback, calibrated) to
  // stay honest even when either side is stale.
  let fallbackHistory = 0
  let fallbackMedia = 0
  const visiblePath: Message[] = []
  for (const m of input.activePathMessages) {
    if (m.deleted || m.hiddenFromContext) continue
    visiblePath.push(m)
    fallbackHistory += estimateTokens(plainTextOf(m.content), family)
    fallbackMedia += mediaTokenCountFor(m.content)
  }

  // Provider-calibrated estimate — use the LATEST reported usage on the
  // active path as a baseline, then estimate only the deltas after it.
  let baselineIdx = -1
  let baselinePromptTokens: number | undefined
  for (let i = input.activePathMessages.length - 1; i >= 0; i -= 1) {
    const m = input.activePathMessages[i]
    if (!m || m.deleted || m.hiddenFromContext) continue
    const usage = m.generation?.usage
    if (
      m.role === 'assistant' &&
      usage &&
      typeof usage.prompt_tokens === 'number' &&
      usage.prompt_tokens > 0
    ) {
      baselineIdx = i
      baselinePromptTokens = usage.prompt_tokens
      break
    }
  }

  let calibratedHistory = fallbackHistory
  let calibratedMedia = fallbackMedia
  if (baselinePromptTokens !== undefined && baselineIdx >= 0) {
    let h = Math.max(0, baselinePromptTokens - systemTokens)
    let media = 0
    const baseline = input.activePathMessages[baselineIdx]
    if (baseline && !baseline.deleted && !baseline.hiddenFromContext) {
      h += estimateTokens(plainTextOf(baseline.content), family)
      media += mediaTokenCountFor(baseline.content)
    }
    for (let i = baselineIdx + 1; i < input.activePathMessages.length; i += 1) {
      const m = input.activePathMessages[i]
      if (!m || m.deleted || m.hiddenFromContext) continue
      h += estimateTokens(plainTextOf(m.content), family)
      media += mediaTokenCountFor(m.content)
    }
    calibratedHistory = h
    calibratedMedia = media
  }
  // Conservative: never report below the char-based estimate so edits
  // that grew a pre-baseline message are still reflected.
  const historyTokens = Math.max(calibratedHistory, fallbackHistory)
  const mediaTokens = Math.max(calibratedMedia, fallbackMedia)
  const draftTokens = estimateTokens(input.draftText, family)

  // Reasoning echo is computed from visible path only (we already
  // filtered hiddenFromContext + deleted). Each assistant message with
  // `reasoningDetails[]` contributes the tokens whose `ReasoningInclude`
  // flag is on AND whose `hidden` flag is off, gated further by
  // preservation-format match for encrypted carriers.
  let reasoningTokens = 0
  if (input.reasoningInclude) {
    const opts: PromptEstimateOptions = {
      family,
      reasoningInclude: input.reasoningInclude,
      reasoningExcluded: input.reasoningExcluded ?? false,
    }
    if (input.reasoningPreservationFormat !== undefined) {
      opts.reasoningPreservationFormat = input.reasoningPreservationFormat
    }
    reasoningTokens = estimateReasoningEchoTokens(visiblePath, opts)
  }

  return {
    systemTokens,
    historyTokens,
    draftTokens,
    mediaTokens,
    reasoningTokens,
    total: systemTokens + historyTokens + draftTokens + mediaTokens + reasoningTokens,
  }
}

// Sentinel value for `customMaxContext` / `maxCompletionTokens` meaning
// "no cap — rely on provider limits or OpenRouter middle-out compression."
// The user types `-1` into the numeric input; we keep the stored value as
// -1 so preset/chat round-tripping preserves intent, but budget math
// treats it as `Infinity`.
export const UNLIMITED_CONTEXT = -1

export function resolveContextCap(stored: number | undefined, providerCap: number): number {
  if (stored === UNLIMITED_CONTEXT) return Number.POSITIVE_INFINITY
  return stored ?? providerCap
}

export function tokenizerFromSettings(
  settings: ChatSettings,
  endpointTokenizer: string | null | undefined,
): TokenizerFamily {
  if (endpointTokenizer) return tokenizerFamily(endpointTokenizer)
  const model = settings.model.toLowerCase()
  if (model.includes('claude')) return 'claude'
  if (model.includes('gpt') || model.includes('openai')) return 'gpt'
  if (model.includes('gemini')) return 'gemini'
  if (model.includes('llama')) return 'llama'
  if (model.includes('mistral')) return 'mistral'
  if (model.includes('deepseek')) return 'deepseek'
  if (model.includes('qwen')) return 'qwen'
  return 'unknown'
}

export { activePath }

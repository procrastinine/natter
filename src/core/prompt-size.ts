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

import { activePath } from './active-path'
import { estimateTokens, type TokenizerFamily, tokenizerFamily } from './tokens'
import type { ChatSettings, ContentItem, Message } from './types'

export interface PromptSizeEstimateInput {
  systemPrompt: string
  activePathMessages: Message[]
  draftText: string
  tokenizer: TokenizerFamily
}

export interface PromptSizeEstimate {
  systemTokens: number
  historyTokens: number
  draftTokens: number
  mediaTokens: number
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
  for (const m of input.activePathMessages) {
    if (m.deleted || m.hiddenFromContext) continue
    fallbackHistory += estimateTokens(plainTextOf(m.content), family)
    fallbackMedia += mediaTokenCountFor(m.content)
  }

  // Provider-calibrated estimate — use the LATEST reported usage on the
  // active path as a baseline, then estimate only the deltas after it.
  // Edge cases handled here:
  //
  //   1. No reported usage yet → fall back to pure per-message estimation.
  //   2. The baseline is older than the current system prompt (system
  //      edited post-send) → `promptTokens - systemTokens` could go
  //      negative; clamp to 0.
  //   3. The baseline message itself, OR any message before it, has been
  //      edited after the request went out → `promptTokens` reflects the
  //      OLD text. We can't detect this cheaply, so the calibrated
  //      number may UNDERSHOOT if edits grew text. The fallback
  //      (char-based) recomputes from current content, so max(fallback,
  //      calibrated) is always conservative.
  //   4. Hidden-from-context / deleted messages between baseline and
  //      now are skipped, so we don't charge for text that won't ship.
  //   5. The baseline's own completion content belongs to "history" for
  //      the NEXT prompt (it's the assistant turn the provider is about
  //      to see echoed back). We add that explicitly.
  //   6. Media tokens attached to pre-baseline messages are folded into
  //      `promptTokens` by the provider, so we only add media AFTER the
  //      baseline to avoid double-counting.
  //   7. When sending from an intermediate message, `activePathMessages`
  //      contains only ancestors-and-self of that message, so the
  //      baseline search naturally walks the right path.
  //   8. If `promptTokens` is zero or negative (some error paths), we
  //      skip it — that's clearly a non-answer.
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
  return {
    systemTokens,
    historyTokens,
    draftTokens,
    mediaTokens,
    total: systemTokens + historyTokens + draftTokens + mediaTokens,
  }
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

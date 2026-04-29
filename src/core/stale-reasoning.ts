// Detect provider-side rejections that happen when echoed reasoning from an
// earlier turn is no longer accepted, e.g. encrypted_content whose
// attestation expired, or a Gemini `thoughtSignature` missing from an
// imported chat. Phase 11.1's banner surface reads this predicate to offer
// a "retry without preserved reasoning" recovery flow.
//
// Patterns come from live probes against OpenAI and Gemini direct, plus the
// generic "upstream 400 while reasoning_details were being sent" fallback.
// See `plan/13-delivery.md §Phase 11.1 → Stale-reasoning rejection UI`.

import type { ApiError } from '../api/errors'

type StaleReasoningProvider = 'openai' | 'gemini' | 'generic'

const OPENAI_PATTERNS = [
  /invalid encrypted reasoning content/i,
  /encrypted[_\s-]content.*(?:expired|invalid)/i,
  /reasoning\.encrypted_content/i,
]

const GEMINI_PATTERNS = [
  /missing (?:a )?thought_?signature/i,
  /invalid (?:thought_?signature|thoughtSignature)/i,
]

export function detectStaleReasoning(
  error: { message?: string; statusCode?: number } | null | undefined,
  opts: { hadReasoningDetails?: boolean } = {},
): StaleReasoningProvider | null {
  if (!error) return null
  const msg = error.message ?? ''
  for (const re of OPENAI_PATTERNS) {
    if (re.test(msg)) return 'openai'
  }
  for (const re of GEMINI_PATTERNS) {
    if (re.test(msg)) return 'gemini'
  }
  // Generic 400 while reasoning_details were being sent. Only classify
  // this way when the caller signals reasoning was in flight; otherwise
  // every unrelated bad-request would trip the banner.
  if (error.statusCode === 400 && opts.hadReasoningDetails === true) {
    return 'generic'
  }
  return null
}

// Version that takes an ApiError directly. Thin convenience wrapper so call
// sites don't have to destructure the httpStatus themselves.
export function detectStaleReasoningFromApiError(
  error: ApiError | undefined,
  opts: { hadReasoningDetails?: boolean } = {},
): StaleReasoningProvider | null {
  if (!error) return null
  return detectStaleReasoning(
    {
      message: error.message,
      ...(error.httpStatus !== undefined ? { statusCode: error.httpStatus } : {}),
    },
    opts,
  )
}

export function staleReasoningBannerText(provider: StaleReasoningProvider): string {
  if (provider === 'openai') {
    return 'The model rejected preserved reasoning from an earlier turn. This can happen after editing history or switching model families.'
  }
  if (provider === 'gemini') {
    return "Gemini rejected a turn that was missing a thoughtSignature. This can happen on imported chats or after switching the connection's Gemini mode."
  }
  return 'The model rejected a request carrying preserved reasoning. This can happen after editing history or switching model families.'
}

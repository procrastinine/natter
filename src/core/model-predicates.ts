// Centralized model-slug and endpoint predicates. See `plan/05-transforms-and-quirks.md §5.5.1`.
//
// Every feature that needs "is this a free model?" / "is this a preset slug?" /
// "is this Anthropic routed through Bedrock/Vertex?" must import from here. The
// regexes and provider-name tests are NOT duplicated anywhere else; drift between
// sites has caused real bugs (privacy filter missing `:free` variants, Bedrock
// receiving top-level `cache_control` and 400ing, etc.).

import type { ModelEndpoint } from './types'

// A model slug is "free" when the `:free` variant suffix is present. Matches at
// end-of-string or before another colon-separated variant tag (e.g.
// `meta-llama/llama-3.3-70b:free:nitro`). The regex must not be inlined elsewhere.
export function isFreeModel(slug: string): boolean {
  return /:free(?:$|:)/.test(slug)
}

// "@preset/..." is OpenRouter's side-channel for account-level preset references
// in the `model` field. These behave differently from real slugs (privacy filter
// skipped, endpoints lookup indirected) and must never be confused with them.
export function isPresetSlug(slug: string): boolean {
  return slug.startsWith('@preset/')
}

// Anthropic routed via Bedrock or Vertex rejects top-level `cache_control`; the
// body must carry per-block breakpoints instead. The older name drift
// `Google Vertex` → `Google` has been observed in the wild, so both match.
export function isAnthropicOnBedrockOrVertex(
  model: string,
  endpoint?: Pick<ModelEndpoint, 'provider_name' | 'provider_display_name' | 'provider_slug'> | undefined,
): boolean {
  if (!/^anthropic\//.test(model)) return false
  const refs = [
    endpoint?.provider_name,
    endpoint?.provider_display_name,
    endpoint?.provider_slug,
  ].map((value) => value?.trim().toLowerCase())
  return refs.some(
    (ref) =>
      ref === 'amazon bedrock' ||
      ref === 'amazon-bedrock' ||
      ref === 'google vertex' ||
      ref === 'google-vertex' ||
      ref === 'google',
  )
}

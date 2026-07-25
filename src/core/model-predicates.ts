// A model slug is "free" when the `:free` variant suffix is present. Matches at
// end-of-string or before another colon-separated variant tag (e.g.
// `meta-llama/llama-3.3-70b:free:nitro`). The regex must not be inlined elsewhere.
export function isFreeModel(slug: string): boolean {
  return /:free(?:$|:)/.test(slug)
}

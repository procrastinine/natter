// The default list covers origins that LLM responses commonly reference and
// that are trusted not to ship tracking pixels. User-added origins are
// persisted under `settings['image-allowlist']` and appended at render time.

export const DEFAULT_IMAGE_ORIGINS: readonly string[] = Object.freeze([
  'https://openrouter.ai',
  'https://*.openrouter.ai',
  'https://upload.wikimedia.org',
  'https://huggingface.co',
  'https://*.huggingface.co',
  'data:',
  'blob:',
])

export function isImageOriginAllowed(url: string, allowed: readonly string[]): boolean {
  if (!url) return false
  // `data:` and `blob:` are scheme-only entries; they don't parse as URLs
  // with an `origin` component, so match them first.
  for (const entry of allowed) {
    if (entry.endsWith(':') && url.startsWith(entry)) return true
  }
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    // Relative URLs have no origin; only allow them if one of the explicit
    // entries matches the raw string prefix (used for future "scroll to file"
    // citations). Otherwise block.
    return allowed.some((entry) => entry === url || url.startsWith(entry))
  }
  for (const entry of allowed) {
    if (entry.endsWith(':')) continue
    if (matchOriginPattern(origin, entry)) return true
  }
  return false
}

function matchOriginPattern(origin: string, pattern: string): boolean {
  if (!pattern.startsWith('http')) return false
  if (pattern === origin) return true
  // Wildcard host pattern: `https://*.example.com` matches any subdomain of
  // `example.com` (but NOT the bare apex; the apex needs its own entry).
  const wildcard = pattern.replace(/^https?:\/\//, '')
  if (wildcard.startsWith('*.')) {
    const suffix = wildcard.slice(1) // ".example.com"
    const [scheme] = pattern.split('://')
    const originHost = origin.replace(/^https?:\/\//, '')
    return (
      origin.startsWith(`${scheme}://`) &&
      originHost.endsWith(suffix) &&
      originHost !== suffix.slice(1)
    )
  }
  return false
}

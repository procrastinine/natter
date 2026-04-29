// Pure CORS-proxy constants and config shape. Intentionally has zero
// imports so daemon-mode hosts (and the wire-only `api/privacy-scrape.ts`,
// which must stay daemon-portable) can pull these in without dragging
// in IDB, Dexie, or any browser-only state via `core/global-settings.ts`.
//
// `core/global-settings.ts` re-exports the same names for browser callers
// that already group their preference imports there.

// CORS proxy used for the OpenRouter privacy scrape (see
// `plan/09-privacy.md §9.4` and `plan/14-details.md §14.14`). The default
// `/_or_scrape` is the same-origin path Vite's dev server rewrites to
// `https://openrouter.ai`. A user running the production bundle elsewhere
// can point this at a hosted CORS bouncer (e.g. a Cloudflare Worker —
// see `docs/cors-proxy.md`). When `corsProxySecret` is non-empty the
// scrape sends `X-Proxy-Secret: <secret>` so a bouncer can require auth.
export const DEFAULT_CORS_PROXY_URL = '/_or_scrape'
export const CORS_PROXY_SECRET_HEADER = 'X-Proxy-Secret'

// Direct OpenRouter base for daemon-mode hosts that fetch
// `openrouter.ai/{model}/providers` server-to-server, where CORS doesn't
// apply. The future daemon engine constructs a `CorsProxyConfig` using
// this base instead of reading the user's `corsProxyUrl` (which is a
// browser-only concern). See `directCorsProxyConfig` in
// `core/global-settings.ts`.
export const DIRECT_OPENROUTER_BASE = 'https://openrouter.ai'

export interface CorsProxyConfig {
  /** Trimmed base URL with no trailing slash. Always non-empty — falls back
   *  to `DEFAULT_CORS_PROXY_URL` when the user clears the input. */
  url: string
  /** Optional secret echoed as `X-Proxy-Secret`. Empty = header omitted. */
  secret: string
}

// Known public CORS bouncers. Each entry maps a canonical lowercase host
// to the URL builder for the OpenRouter privacy-scrape page. The Settings
// field's "simple host" shortcut works by looking the host up here; users
// who paste the full template (e.g.
// `https://corsproxy.io/?url=https://openrouter.ai/{model}/providers`)
// take the template path in `privacyScrapeUrl` and bypass this table.
//
// To add a bouncer: live-check it returns `openrouter.ai/{model}/providers`
// HTML (200 + the page's `data_policy` / `provider_display_name` markers)
// from a browser-style request, document it in `plan/cors-proxy.md`, and
// add a row here.
interface KnownBouncer {
  host: string
  buildUrl: (modelId: string) => string
}

const KNOWN_BOUNCERS: ReadonlyArray<KnownBouncer> = [
  {
    host: 'corsproxy.io',
    buildUrl: (m) => `https://corsproxy.io/?url=https://openrouter.ai/${m}/providers`,
  },
  {
    host: 'api.allorigins.win',
    buildUrl: (m) => `https://api.allorigins.win/raw?url=https://openrouter.ai/${m}/providers`,
  },
  {
    host: 'proxy.corsfix.com',
    buildUrl: (m) => `https://proxy.corsfix.com/?url=https://openrouter.ai/${m}/providers`,
  },
]

// Resolve a user-pasted proxy value to a known bouncer when it's a bare
// host (with optional scheme and trailing slash, no path/query/hash).
// Returns `undefined` for templates, custom hosts, and anything that
// looks like a path-prefix base — those follow other branches in
// `privacyScrapeUrl`.
export function matchKnownBouncer(raw: string): KnownBouncer | undefined {
  const stripped = raw.trim().replace(/\/+$/, '')
  if (stripped.length === 0) return undefined
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(stripped)
    ? stripped
    : `https://${stripped}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') return undefined
  if (parsed.search !== '' || parsed.hash !== '') return undefined
  const host = parsed.hostname.toLowerCase()
  return KNOWN_BOUNCERS.find((b) => b.host === host)
}

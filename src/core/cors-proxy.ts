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

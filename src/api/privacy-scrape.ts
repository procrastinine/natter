// Privacy scrape — fetch `openrouter.ai/{model}/providers`, extract per-
// provider `data_policy` blocks, and cache them for 24h.
//
// The provider-privacy matrix isn't in the JSON API. It lives on the
// per-model page OpenRouter ships to the browser; the relevant fields
// are embedded in the page's React flight payload (`__NEXT_DATA__` or
// streamed `self.__next_f.push(...)` fragments, depending on the route).
// The scraper greps for `"data_policy"` JSON objects, pairs each with the
// nearest preceding provider name, and returns a map keyed by every stable
// provider ref recoverable from the payload (display/name plus slug when present).
//
// The fetch path is a workspace-global CORS proxy — config shape +
// constants live in `core/cors-proxy.ts` (the daemon-safe module the
// browser preference layer also re-exports). Vite dev defaults to the
// same-origin `/_or_scrape` rewrite; static builds do not fetch live provider
// pages until the user configures a bouncer. No Authorization header is sent —
// the page is public. When a secret is configured it rides as `X-Proxy-Secret`.

import {
  CORS_PROXY_SECRET_HEADER,
  type CorsProxyConfig,
  DEFAULT_CORS_PROXY_URL,
  isCorsProxyDisabled,
  matchKnownBouncer,
} from '../core/cors-proxy'
import type { DataPolicy } from '../core/types'
import { fetchWithTimeout, readResponseText } from './client'
import { ApiError, normalizeError } from './errors'

interface PrivacyScrapeContext {
  // Workspace-global CORS-proxy config. Required — `core/privacy-request.ts`
  // and `usePrivacyPolicies` resolve it before calling the scrape so this
  // module never touches IDB itself (keeps it daemon-portable).
  proxy: CorsProxyConfig
  // Optional fetcher injection for tests (default: fetchWithTimeout).
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

interface PrivacyScrapeResult {
  modelId: string
  // Keyed by recovered provider refs: display/name plus provider_slug
  // when the page exposes it. Missing providers are absent — the filter
  // layer treats online misses as unavailable, not as a guessed policy.
  policies: Record<string, DataPolicy>
  // The raw scraped payload persisted in the cache row for replay /
  // regression tests. Shape-stable: `{ policies, fetchedAt }`.
  raw: { policies: Record<string, DataPolicy>; fetchedAt: number }
  fetchedAt: number
}

// Build the scrape URL. The browser can't fetch `openrouter.ai/{model}/
// providers` cross-origin (CORS), so Vite dev defaults to the relative proxy
// path `/_or_scrape`, which the dev server rewrites. Static builds default to
// no live scrape, and users can override `corsProxyUrl` to any hosted bouncer.
// Daemon-mode hosts can pass a direct OpenRouter base because CORS does not
// apply server-to-server.
//
// Three URL shapes are accepted (resolution order matters — template
// wins, then known-bouncer shortcut, then path-prefix fallback):
//
//   1. Template mode: when the URL contains `{model}` or `{path}`
//      placeholders, those are substituted literally and the result is
//      used as-is. This makes any public CORS bouncer (e.g.
//      `https://corsproxy.io/?url=https://openrouter.ai/{model}/providers`)
//      work, including ones we don't know about — they expect the
//      upstream URL passed via query string, not appended to a base.
//   2. Known-bouncer shortcut: when the URL is just a bare host that
//      matches `KNOWN_BOUNCERS` in `core/cors-proxy.ts` (with or
//      without `https://`, with at most a trailing slash), the
//      bouncer's canonical template is applied. Lets users paste
//      `corsproxy.io` instead of the full `?url=...` form.
//   3. Path-prefix mode (fallback, default): the URL is treated as a
//      base and the scrape becomes `<base>/{model}/providers`. Mirrors
//      the dev proxy and self-hosted Cloudflare Workers.
//
// `{model}` expands to `{author}/{slug}` (e.g. `openai/gpt-5.4`).
// `{path}` expands to `{author}/{slug}/providers`.
const DEFAULT_PRIVACY_SCRAPE_BASE = DEFAULT_CORS_PROXY_URL

const MODEL_PLACEHOLDER = '{model}'
const PATH_PLACEHOLDER = '{path}'

export function privacyScrapeUrl(proxy: CorsProxyConfig, modelId: string): string {
  const raw = proxy.url
  if (isCorsProxyDisabled(proxy)) {
    throw new Error('Privacy-page proxy is disabled')
  }
  if (raw.includes(MODEL_PLACEHOLDER) || raw.includes(PATH_PLACEHOLDER)) {
    return raw
      .split(PATH_PLACEHOLDER)
      .join(`${modelId}/providers`)
      .split(MODEL_PLACEHOLDER)
      .join(modelId)
  }
  const bouncer = matchKnownBouncer(raw)
  if (bouncer) return bouncer.buildUrl(modelId)
  const base = raw.trim().replace(/\/+$/, '') || DEFAULT_PRIVACY_SCRAPE_BASE
  // Model slugs contain a `/` — the URL path accepts it verbatim.
  return `${base}/${modelId}/providers`
}

export async function fetchPrivacyScrape(
  ctx: PrivacyScrapeContext,
  modelId: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PrivacyScrapeResult> {
  const url = privacyScrapeUrl(ctx.proxy, modelId)
  const headers: Record<string, string> = { Accept: 'text/html,application/xhtml+xml' }
  if (ctx.proxy.secret.length > 0) headers[CORS_PROXY_SECRET_HEADER] = ctx.proxy.secret
  const init: RequestInit = {
    method: 'GET',
    headers,
  }
  const fetchImpl = ctx.fetchImpl
  const impl = fetchImpl
    ? (u: string, i: RequestInit) => fetchImpl(u, i)
    : (u: string, i: RequestInit) => fetchWithTimeout(u, i, opts)
  const response = await impl(url, init)
  if (!response.ok) {
    let text = ''
    try {
      text = await readResponseText(response)
    } catch (error) {
      if (error instanceof ApiError && (error.kind === 'timeout' || error.kind === 'abort')) {
        throw error
      }
    }
    throw normalizeError(
      { error: { code: response.status, message: text || response.statusText } },
      { midStream: false, httpStatus: response.status },
    )
  }
  const html = await readResponseText(response)
  const policies = parsePrivacyPage(html)
  const fetchedAt = Date.now()
  return {
    modelId,
    policies,
    raw: { policies, fetchedAt },
    fetchedAt,
  }
}

// Extract `{provider -> DataPolicy}` from the provider-detail HTML. The
// page embeds the data in one of two shapes: the older Pages-router SSR
// uses `__NEXT_DATA__` (a single JSON blob), the newer App-router RSC
// stream uses concatenated `self.__next_f.push([N, "..."])` chunks.
//
// The live page serializes each endpoint as a big object whose fields
// are spread across many chunks — `provider_display_name` and
// `data_policy` are on the same record but 200–400 characters apart.
// A single non-nesting regex can't match them. Instead the parser scans
// forward from each provider-name marker to the next `data_policy:{...}`
// and pairs them up until the next provider marker.
//
// This parser is conservative: if nothing recognizable is present it
// returns an empty map, leaving the filter to mark policy unavailable.
export function parsePrivacyPage(html: string): Record<string, DataPolicy> {
  const out: Record<string, DataPolicy> = {}

  // Strategy A (legacy): `{"provider_name":"X", "data_policy":{...}}`
  // compact blocks in inline scripts. Kept for older fixtures and for
  // API responses that get dumped into the page inline.
  const pairRe = /\{[^{}]{0,2000}"data_policy"\s*:\s*\{[^{}]{0,2000}\}[^{}]{0,2000}\}/g
  for (const match of html.matchAll(pairRe)) {
    const parsed = safeParseObject(match[0])
    if (parsed) absorbPolicy(parsed, out)
  }

  // Strategy B: `__NEXT_DATA__` JSON block (Pages router).
  const nextDataMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (nextDataMatch?.[1]) {
    const parsed = safeParseObject(nextDataMatch[1])
    if (parsed) walkForPolicies(parsed, out)
  }

  // Strategy C: RSC flight chunks. We merge every push payload and run
  // `scanProviderPairs` on the concatenation.
  const flightChunks: string[] = []
  const flightRe = /self\.__next_f\.push\(\[\s*\d+\s*,\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\]\)/g
  for (const match of html.matchAll(flightRe)) {
    const quote = match[1]
    const raw = match[2]
    if (!raw) continue
    const decoded = decodeFlightString(raw, quote)
    if (decoded) flightChunks.push(decoded)
  }
  if (flightChunks.length) {
    const merged = flightChunks.join('')
    scanProviderPairs(merged, out)
  }
  // Also run the scan on the raw HTML so tests that drop the data in
  // a `<script>window.__X__ = [...]</script>` block still work.
  scanProviderPairs(html, out)
  scanProviderPairs(unescapeEmbeddedJsonQuotes(html), out)

  return out
}

function decodeFlightString(raw: string, quote: string | undefined): string | null {
  try {
    if (quote === '"') return JSON.parse(`"${raw}"`) as string
    const normalized = raw.replace(/\\'/g, "'").replace(/"/g, '\\"')
    return JSON.parse(`"${normalized}"`) as string
  } catch {
    // Skip malformed chunks — other strategies may still find the policy.
    return null
  }
}

function unescapeEmbeddedJsonQuotes(text: string): string {
  if (!text.includes('\\"') && !text.includes('\\u0022')) return text
  return text.replace(/\\"/g, '"').replace(/\\u0022/g, '"')
}

// Walk `text` pairing each provider-name marker with the first
// `data_policy:{...}` / `dataPolicy:{...}` that appears BEFORE the next provider marker.
// The live RSC stream serializes records as
//   "..."provider_display_name":"X","provider_slug":"x",..."data_policy":{...},"pricing":{...}..."
// with hundreds of chars between the marker and the policy object.
function scanProviderPairs(text: string, out: Record<string, DataPolicy>): void {
  // Capture every provider marker position + its name. `provider_display_name`
  // is the current RSC field (as of 2026-04); `provider_name` is the JSON API
  // field (same value); `"name"` is kept as a weaker fallback for other
  // pages that might shape the data differently.
  const markerRe =
    /"(provider_display_name|provider_name|providerDisplayName|providerName)"\s*:\s*"([^"]+)"/g
  const markers: Array<{ pos: number; name: string }> = []
  for (const m of text.matchAll(markerRe)) {
    markers.push({ pos: m.index + m[0].length, name: m[2] ?? '' })
  }
  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i]
    if (!marker) continue
    const nextPos = markers[i + 1]?.pos ?? text.length
    const segment = text.slice(marker.pos, nextPos)
    const dpIdx = policyMarkerIndex(segment)
    if (dpIdx < 0) continue
    const objStart = segment.indexOf('{', dpIdx)
    if (objStart < 0) continue
    const objEnd = balancedJsonEnd(segment, objStart)
    if (objEnd < 0) continue
    const raw = segment.slice(objStart, objEnd + 1)
    const parsed = safeParseObject(raw)
    if (!parsed) continue
    const policy = normalizeDataPolicy(parsed)
    if (!policy) continue
    const keys = [marker.name, ...providerSlugKeys(segment)]
    for (const key of keys) {
      if (!(key in out)) out[key] = policy
    }
  }
}

function providerSlugKeys(segment: string): string[] {
  const keys: string[] = []
  const slugRe = /"(provider_slug|providerSlug)"\s*:\s*"([^"]+)"/g
  for (const match of segment.matchAll(slugRe)) {
    const value = match[2]?.trim()
    if (value && !keys.includes(value)) keys.push(value)
  }
  return keys
}

function policyMarkerIndex(segment: string): number {
  const snake = segment.indexOf('"data_policy"')
  const camel = segment.indexOf('"dataPolicy"')
  if (snake < 0) return camel
  if (camel < 0) return snake
  return Math.min(snake, camel)
}

// Return the index of the closing `}` that matches the `{` at `start`.
// Respects string literals so braces inside `"..."` don't confuse the
// depth counter. Returns -1 on unbalanced input.
function balancedJsonEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

// Try to coerce one candidate object into `{name, data_policy}` and
// merge the result into `out`.
function absorbPolicy(obj: unknown, out: Record<string, DataPolicy>): void {
  if (!obj || typeof obj !== 'object') return
  const rec = obj as Record<string, unknown>
  const names = pickProviderNames(rec)
  const dp = rec.data_policy ?? rec.dataPolicy
  if (names.length === 0 || !dp || typeof dp !== 'object') return
  const policy = normalizeDataPolicy(dp as Record<string, unknown>)
  if (!policy) return
  // First occurrence wins; later duplicates are skipped so tests can be
  // deterministic when the same provider appears in multiple chunks.
  for (const name of names) {
    if (!(name in out)) out[name] = policy
  }
}

function pickProviderNames(rec: Record<string, unknown>): string[] {
  const candidates = [
    rec.provider_name,
    rec.providerName,
    rec.provider_display_name,
    rec.providerDisplayName,
    rec.provider_slug,
    rec.providerSlug,
    rec.name,
    rec.display_name,
    rec.displayName,
  ]
  const out: string[] = []
  for (const cand of candidates) {
    if (typeof cand !== 'string') continue
    const trimmed = cand.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

// Walk a parsed JSON structure looking for `{name, data_policy}` pairs.
function walkForPolicies(node: unknown, out: Record<string, DataPolicy>): void {
  if (!node) return
  if (Array.isArray(node)) {
    for (const child of node) walkForPolicies(child, out)
    return
  }
  if (typeof node !== 'object') return
  const rec = node as Record<string, unknown>
  if ('data_policy' in rec || 'dataPolicy' in rec) absorbPolicy(rec, out)
  for (const value of Object.values(rec)) walkForPolicies(value, out)
}

// Coerce a raw `data_policy` object into the `DataPolicy` shape. Unknown
// fields are dropped so tests survive future OpenRouter fields.
export function normalizeDataPolicy(raw: Record<string, unknown>): DataPolicy | null {
  const training = asBool(raw.training)
  const trainingOpenRouter =
    asBool(raw.training_openrouter) ??
    asBool(raw.trainingOpenRouter) ??
    // Some scrape variants nest it under "openrouter" / "openrouter_training".
    asBool(raw.openrouter_training) ??
    asBool(raw.trainsOnOpenRouter)
  const retainsPrompts =
    asBool(raw.retains_prompts) ?? asBool(raw.retainsPrompts) ?? asBool(raw.retains)
  const canPublish = asBool(raw.can_publish) ?? asBool(raw.canPublish) ?? asBool(raw.publishes)
  const requiresUserIDs =
    asBool(raw.requires_user_ids) ??
    asBool(raw.requiresUserIDs) ??
    asBool(raw.requiresUserIds) ??
    asBool(raw.user_ids_required)
  const retentionDays = asPositiveInt(raw.retention_days ?? raw.retentionDays ?? raw.retention)
  const tos = asString(raw.terms_of_service_url ?? raw.termsOfServiceURL ?? raw.tos)
  const pp = asString(raw.privacy_policy_url ?? raw.privacyPolicyURL ?? raw.privacy)

  if (training === undefined && retainsPrompts === undefined && canPublish === undefined) {
    return null
  }

  const policy: DataPolicy = {
    training: training ?? false,
    trainingOpenRouter: trainingOpenRouter ?? false,
    retainsPrompts: retainsPrompts ?? false,
    canPublish: canPublish ?? false,
    termsOfServiceURL: tos ?? '',
    privacyPolicyURL: pp ?? '',
  }
  if (retentionDays !== undefined) policy.retentionDays = retentionDays
  if (requiresUserIDs !== undefined) policy.requiresUserIDs = requiresUserIDs
  return policy
}

function asBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.toLowerCase()
    if (s === 'true' || s === 'yes') return true
    if (s === 'false' || s === 'no') return false
  }
  return undefined
}

function asPositiveInt(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v)
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n) && n >= 0) return Math.trunc(n)
  }
  return undefined
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v
  return undefined
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Not parseable. Trimming trailing commas / single quotes is a future
    // possibility; the loss is currently accepted and the UI falls back to
    // worst-case policy.
  }
  return null
}

// Used by `usePrivacyPolicies` and by test harnesses: wrap whatever the
// scrape produced in the shape persisted to the cache row.
interface CachedPrivacyPayload {
  policies: Record<string, DataPolicy>
  fetchedAt: number
}

export function readCachedPrivacyPayload(raw: unknown): CachedPrivacyPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const policies = rec.policies
  const fetchedAt = rec.fetchedAt
  if (!policies || typeof policies !== 'object') return null
  const out: Record<string, DataPolicy> = {}
  for (const [k, v] of Object.entries(policies)) {
    if (!v || typeof v !== 'object') continue
    const normalized = normalizeDataPolicy(v as Record<string, unknown>)
    if (normalized) out[k] = normalized
  }
  return {
    policies: out,
    fetchedAt: typeof fetchedAt === 'number' ? fetchedAt : 0,
  }
}

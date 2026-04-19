// Privacy scrape — fetch `openrouter.ai/{model}/providers`, extract per-
// provider `data_policy` blocks, cache for 24h. See
// `plan/09-privacy.md §9.4` and `plan/07-discovery.md §7.5`.
//
// The provider-privacy matrix isn't in the JSON API. It lives on the
// per-model page OpenRouter ships to the browser; the relevant fields
// are embedded in the page's React flight payload (`__NEXT_DATA__` or
// streamed `self.__next_f.push(...)` fragments, depending on the route).
// We grep for `"data_policy"` JSON objects, pair each with the nearest
// preceding provider name, and return a map keyed by provider name.
//
// Fetch goes through the caller's ConnectionProfile so a user-configured
// `privacyScrapeProxy` (e.g. CORS bouncer for the browser) can intercept.
// No Authorization header is sent — the page is public.

import type { ConnectionProfile, DataPolicy, ProfileId } from '../core/types'
import { fetchWithTimeout } from './client'
import { normalizeError } from './errors'

export interface PrivacyScrapeContext {
  profile: ConnectionProfile
  // Optional fetcher injection for tests (default: fetchWithTimeout).
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

export interface PrivacyScrapeResult {
  modelId: string
  // Keyed by `provider_name` as it appears in /endpoints (e.g. "Azure",
  // "Google AI Studio"). Missing providers are absent — the filter
  // layer synthesizes worst-case for them.
  policies: Record<string, DataPolicy>
  // The raw scraped payload we persist in the cache row for replay /
  // regression tests. Shape-stable: `{ policies, fetchedAt }`.
  raw: { policies: Record<string, DataPolicy>; fetchedAt: number }
  fetchedAt: number
}

// Build the scrape URL. Defaults to `openrouter.ai` (production site);
// tests and a user-configured proxy can override via
// `profile.privacyScrapeProxy`.
export function privacyScrapeUrl(
  profile: ConnectionProfile,
  modelId: string,
): string {
  const base = profile.privacyScrapeProxy?.replace(/\/+$/, '') ?? 'https://openrouter.ai'
  // Model slugs contain a `/` — the URL path accepts it verbatim.
  return `${base}/${modelId}/providers`
}

export async function fetchPrivacyScrape(
  ctx: PrivacyScrapeContext,
  modelId: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<PrivacyScrapeResult> {
  const url = privacyScrapeUrl(ctx.profile, modelId)
  const init: RequestInit = {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  }
  const impl = ctx.fetchImpl
    ? (u: string, i: RequestInit) => ctx.fetchImpl!(u, i)
    : (u: string, i: RequestInit) => fetchWithTimeout(u, i, opts)
  const response = await impl(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw normalizeError(
      { error: { code: response.status, message: text || response.statusText } },
      { midStream: false, httpStatus: response.status },
    )
  }
  const html = await response.text()
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
// We can't match them with a single non-nesting regex. Instead we scan
// forward from each provider-name marker to the next `data_policy:{...}`
// and pair them up until we hit the next provider marker.
//
// This parser is conservative: if nothing recognizable is present it
// returns an empty map, leaving the filter to synthesize worst-case
// policies (same behavior as a provider that was never scraped).
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
  const nextDataMatch = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  )
  if (nextDataMatch?.[1]) {
    const parsed = safeParseObject(nextDataMatch[1])
    if (parsed) walkForPolicies(parsed, out)
  }

  // Strategy C: RSC flight chunks. We merge every push payload and run
  // `scanProviderPairs` on the concatenation.
  const flightChunks: string[] = []
  const flightRe =
    /self\.__next_f\.push\(\[\s*\d+\s*,\s*"((?:\\.|[^"\\])*)"\s*\]\)/g
  for (const match of html.matchAll(flightRe)) {
    const raw = match[1]
    if (!raw) continue
    try {
      flightChunks.push(JSON.parse(`"${raw}"`))
    } catch {
      // Skip malformed chunks — other strategies may still find the policy.
    }
  }
  if (flightChunks.length) {
    const merged = flightChunks.join('')
    scanProviderPairs(merged, out)
  }
  // Also run the scan on the raw HTML so tests that drop the data in
  // a `<script>window.__X__ = [...]</script>` block still work.
  scanProviderPairs(html, out)

  return out
}

// Walk `text` pairing each provider-name marker with the first
// `data_policy:{...}` that appears BEFORE the next provider marker.
// The live RSC stream serializes records as
//   "..."provider_display_name":"X","provider_slug":"x",..."data_policy":{...},"pricing":{...}..."
// with hundreds of chars between the marker and the policy object.
function scanProviderPairs(text: string, out: Record<string, DataPolicy>): void {
  // Capture every provider marker position + its name. `provider_display_name`
  // is the current RSC field (as of 2026-04); `provider_name` is the JSON API
  // field (same value); `"name"` is kept as a weaker fallback for other
  // pages that might shape the data differently.
  const markerRe = /"(provider_display_name|provider_name)"\s*:\s*"([^"]+)"/g
  const markers: Array<{ pos: number; name: string }> = []
  for (const m of text.matchAll(markerRe)) {
    if (m.index === undefined) continue
    markers.push({ pos: m.index + m[0].length, name: m[2] ?? '' })
  }
  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i]
    if (!marker) continue
    const nextPos = markers[i + 1]?.pos ?? text.length
    const segment = text.slice(marker.pos, nextPos)
    const dpIdx = segment.indexOf('"data_policy"')
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
    if (!(marker.name in out)) out[marker.name] = policy
  }
}

// Return the index of the closing `}` that matches the `{` at `start`.
// Respects string literals so braces inside `"..."` don't confuse the
// depth counter. Returns -1 on unbalanced input.
function balancedJsonEnd(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
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
  const name = pickProviderName(rec)
  const dp = rec['data_policy'] ?? rec['dataPolicy']
  if (!name || !dp || typeof dp !== 'object') return
  const policy = normalizeDataPolicy(dp as Record<string, unknown>)
  if (!policy) return
  // First occurrence wins; later duplicates are skipped so tests can be
  // deterministic when the same provider appears in multiple chunks.
  if (!(name in out)) out[name] = policy
}

function pickProviderName(rec: Record<string, unknown>): string | null {
  const candidates = [
    rec['provider_name'],
    rec['providerName'],
    rec['name'],
    rec['display_name'],
    rec['displayName'],
  ]
  for (const cand of candidates) {
    if (typeof cand === 'string' && cand.trim().length > 0) return cand.trim()
  }
  return null
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

// Coerce a raw `data_policy` object into our `DataPolicy` shape. We drop
// fields we don't understand so tests survive future OpenRouter fields.
export function normalizeDataPolicy(raw: Record<string, unknown>): DataPolicy | null {
  const training = asBool(raw['training'])
  const trainingOpenRouter =
    asBool(raw['training_openrouter']) ??
    asBool(raw['trainingOpenRouter']) ??
    // Some scrape variants nest it under "openrouter" / "openrouter_training".
    asBool(raw['openrouter_training']) ??
    asBool(raw['trainsOnOpenRouter'])
  const retainsPrompts =
    asBool(raw['retains_prompts']) ??
    asBool(raw['retainsPrompts']) ??
    asBool(raw['retains'])
  const canPublish =
    asBool(raw['can_publish']) ?? asBool(raw['canPublish']) ?? asBool(raw['publishes'])
  const requiresUserIDs =
    asBool(raw['requires_user_ids']) ??
    asBool(raw['requiresUserIDs']) ??
    asBool(raw['requiresUserIds']) ??
    asBool(raw['user_ids_required'])
  const retentionDays = asPositiveInt(
    raw['retention_days'] ?? raw['retentionDays'] ?? raw['retention'],
  )
  const tos = asString(raw['terms_of_service_url'] ?? raw['termsOfServiceURL'] ?? raw['tos'])
  const pp = asString(raw['privacy_policy_url'] ?? raw['privacyPolicyURL'] ?? raw['privacy'])

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
    // Not parseable — try trimming trailing commas / single quotes? For now
    // we accept the loss — the UI falls back to worst-case policy.
  }
  return null
}

// Used by `usePrivacyPolicies` and by test harnesses: wrap whatever the
// scrape produced in the shape we persist to the cache row.
export interface CachedPrivacyPayload {
  policies: Record<string, DataPolicy>
  fetchedAt: number
}

export function readCachedPrivacyPayload(
  raw: unknown,
): CachedPrivacyPayload | null {
  if (!raw || typeof raw !== 'object') return null
  const rec = raw as Record<string, unknown>
  const policies = rec['policies']
  const fetchedAt = rec['fetchedAt']
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

// Helper for the hook layer — key the in-flight dedup map the same way
// the cache is keyed, so two sibling mounts share one scrape.
export function privacyScrapeDedupKey(profileId: ProfileId, modelId: string): string {
  return `${profileId}\u0000${modelId}`
}

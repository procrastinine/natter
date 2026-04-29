// Fetch wrapper — header merge, timeout, abort, GET retry, key-fallback chain.
// See `plan/04-api-client.md §4.2, §4.9, §4.10, §4.10.1`.
//
// This file is environment-neutral (no `window`, no IDB, no DOM). Both the
// in-tab engine and the daemon engine build import it directly.

import type { ConnectionProfile } from '../core/types'
import { ApiError, normalizeError } from './errors'
import type { CallOpts } from './types'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_CAP_MS = 5_000

function isAnthropicBrowserOriginProfile(profile: ConnectionProfile): boolean {
  if (profile.kind === 'anthropic') return true
  try {
    return new URL(profile.baseUrl).host === 'api.anthropic.com'
  } catch {
    return false
  }
}

// Merge order (later entries win): required defaults → profile.defaultHeaders
// → opts.overrideHeaders. Profile can override a required default (rare —
// e.g. custom auth scheme); per-call overrides are the escape hatch.
//
// `authScheme` selects between `Authorization: Bearer` (default, for any
// OpenAI-compatible endpoint including Gemini's `/v1beta/openai/…` shim) and
// `x-goog-api-key` (only for the native Gemini transport — see Phase 11).
// The transport adapter decides; `buildHeaders` does not infer it from the
// profile's `kind` because the same Google profile can serve BOTH transports
// depending on `geminiMode`.
export function buildHeaders(
  profile: ConnectionProfile,
  apiKey: string,
  opts: {
    overrideHeaders?: Record<string, string>
    method?: 'GET' | 'POST'
    authScheme?: 'bearer' | 'gemini-native'
  } = {},
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (apiKey) {
    if (opts.authScheme === 'gemini-native') {
      headers['x-goog-api-key'] = apiKey
    } else {
      headers.Authorization = `Bearer ${apiKey}`
    }
  }
  if (isAnthropicBrowserOriginProfile(profile)) {
    // Anthropic blocks browser-origin preflights unless this opt-in header is
    // present on the actual request. Sending it unconditionally is harmless in
    // Node/daemon paths and keeps the browser app usable on localhost.
    headers['anthropic-dangerous-direct-browser-access'] = 'true'
  }
  if (profile.kind === 'openrouter') {
    if (profile.appUrl) headers['HTTP-Referer'] = profile.appUrl
    if (profile.appTitle) headers['X-OpenRouter-Title'] = profile.appTitle
    if (profile.appCategories?.length) {
      headers['X-OpenRouter-Categories'] = profile.appCategories.join(',')
    }
  }
  if (opts.method === 'POST') headers['Content-Type'] = 'application/json'
  for (const [k, v] of Object.entries(profile.defaultHeaders)) {
    headers[k] = v
  }
  if (opts.overrideHeaders) {
    for (const [k, v] of Object.entries(opts.overrideHeaders)) {
      headers[k] = v
    }
  }
  return headers
}

// Linked-abort helper. AbortSignal.any isn't available everywhere (jsdom
// versions vary), and "user aborted" must be distinguishable from "timeout
// fired" AFTER fetch throws; fetch itself only exposes a single AbortError.
// Forwarding both sources into one controller and keeping the source refs
// provides the needed introspection.
function linkSignals(sources: Array<AbortSignal | undefined>): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const disposers: Array<() => void> = []
  for (const source of sources) {
    if (!source) continue
    if (source.aborted) {
      controller.abort(source.reason)
      break
    }
    const onAbort = () => controller.abort(source.reason)
    source.addEventListener('abort', onAbort, { once: true })
    disposers.push(() => source.removeEventListener('abort', onAbort))
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const d of disposers) d()
    },
  }
}

// Single-attempt fetch. Applies the composed timeout+abort signal and
// classifies pre-response failures so callers don't need to figure out whether
// a thrown AbortError came from the user signal or the timeout.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutCtl = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => timeoutCtl.abort(), timeoutMs) : undefined
  const link = linkSignals([opts.signal, timeoutCtl.signal])
  try {
    return await fetch(url, { ...init, signal: link.signal })
  } catch (e) {
    if (timeoutCtl.signal.aborted && !opts.signal?.aborted) {
      throw normalizeError(e, { midStream: false, cause: 'timeout' })
    }
    if (opts.signal?.aborted) {
      throw normalizeError(e, { midStream: false, cause: 'abort' })
    }
    throw normalizeError(e, { midStream: false, cause: 'network' })
  } finally {
    if (timer) clearTimeout(timer)
    link.dispose()
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function computeBackoffMs(
  attempt: number,
  baseMs: number,
  capMs = DEFAULT_RETRY_CAP_MS,
): number {
  return Math.min(baseMs * 2 ** attempt, capMs)
}

// Idempotent GET retry. Stops as soon as it gets a 2xx or a non-retryable
// status; otherwise backs off and tries again up to `attempts`. `attempts`
// is the TOTAL number of calls, not additional retries — attempts=1 means
// one call, zero retries. On final failure, returns the last Response (if
// any) or re-throws the last ApiError.
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: CallOpts = {},
): Promise<Response> {
  const attempts = Math.max(1, opts.retry?.attempts ?? 1)
  const baseBackoff = opts.retry?.backoffMs ?? 250
  let lastError: ApiError | undefined
  for (let i = 0; i < attempts; i += 1) {
    try {
      const init2: RequestInit = { ...init }
      const res = await fetchWithTimeout(url, init2, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      })
      if (res.ok || !isRetryableStatus(res.status)) return res
      lastError = undefined
      if (i === attempts - 1) return res
    } catch (e) {
      if (!(e instanceof ApiError) || !e.retryable) throw e
      lastError = e
      if (i === attempts - 1) throw e
    }
    await sleep(computeBackoffMs(i, baseBackoff))
  }
  if (lastError) throw lastError
  throw new Error('fetchWithRetry: unreachable')
}

// True when the response says "this key itself is the problem" — 401, 403,
// or an account-exhaustion 429 (x-ratelimit-limit: 0). A plain 429 without
// that header is a per-minute throttle and must NOT rotate (§4.10.1).
export function isKeyFallbackTrigger(response: Response): boolean {
  if (response.status === 401 || response.status === 403) return true
  if (response.status === 429) {
    return response.headers.get('x-ratelimit-limit') === '0'
  }
  return false
}

interface KeyFallbackResult {
  response: Response
  keyIndex: number
}

// Tries each key in `keys` in order. Rotates on 401/403/qualifying 429;
// returns on first non-rotation status (success or otherwise). If all keys
// trigger rotation, returns the LAST response so the caller can surface
// whatever error the last attempt produced (§4.10.1 step 3).
export async function fetchWithKeyFallback(
  keys: string[],
  build: (key: string) => { url: string; init: RequestInit },
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<KeyFallbackResult> {
  if (keys.length === 0) {
    throw new Error('fetchWithKeyFallback: at least one key is required')
  }
  let last: Response | undefined
  let lastIndex = 0
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    if (key === undefined) continue
    const { url, init } = build(key)
    const res = await fetchWithTimeout(url, init, opts)
    last = res
    lastIndex = i
    if (res.ok) return { response: res, keyIndex: i }
    if (!isKeyFallbackTrigger(res)) return { response: res, keyIndex: i }
    // Non-last rotate trigger: drain the body to free the socket before
    // the next attempt. A response returned to the caller stays unread.
    if (i < keys.length - 1) {
      await res.body?.cancel().catch(() => {})
    }
  }
  return { response: last as Response, keyIndex: lastIndex }
}

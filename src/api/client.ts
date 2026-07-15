// Fetch wrapper — header merge, timeout, abort, GET retry, key-fallback chain.
//
// This file is environment-neutral (no `window`, no IDB, no DOM). Both the
// in-tab engine and the daemon engine build import it directly.

import type { ConnectionProfile } from '../core/types'
import { raceWithAbortSignal } from '../lib/abort'
import type { CallOpts } from './call-opts'
import { ApiError, normalizeError } from './errors'

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_RETRY_CAP_MS = 5_000

interface ResponseBodyContract {
  readonly deadline: number | undefined
  readonly signal: AbortSignal | undefined
}

const responseBodyContracts = new WeakMap<Response, ResponseBodyContract>()

function monotonicNow(): number {
  const performance = (globalThis as { performance?: Performance }).performance
  return performance?.now() ?? Date.now()
}

type TargetAddressSpace = 'local' | 'loopback'
type LocalNetworkRequestInit = RequestInit & { targetAddressSpace?: TargetAddressSpace }

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
// OpenAI-compatible endpoint including Gemini's `/v1beta/openai/…` shim),
// `x-goog-api-key` (native Gemini), and `x-api-key` (native Anthropic).
// The transport adapter decides; `buildHeaders` does not infer it from the
// profile's `kind` because the same Google profile can serve BOTH transports
// depending on the chat's API mode.
export function buildHeaders(
  profile: ConnectionProfile,
  apiKey: string,
  opts: {
    overrideHeaders?: Record<string, string>
    method?: 'GET' | 'POST'
    authScheme?: 'bearer' | 'gemini-native' | 'anthropic-native'
  } = {},
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (apiKey) {
    if (opts.authScheme === 'gemini-native') {
      headers['x-goog-api-key'] = apiKey
    } else if (opts.authScheme === 'anthropic-native') {
      headers['x-api-key'] = apiKey
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
    setHeader(headers, k, v)
  }
  if (opts.overrideHeaders) {
    for (const [k, v] of Object.entries(opts.overrideHeaders)) {
      setHeader(headers, k, v)
    }
  }
  return headers
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const normalizedName = name.toLowerCase()
  for (const existing of Object.keys(headers)) {
    if (existing !== name && existing.toLowerCase() === normalizedName) delete headers[existing]
  }
  headers[name] = value
}

export function hasExplicitAuthHeaderOverride(
  profile: ConnectionProfile,
  overrideHeaders: Record<string, string> | undefined,
  authHeaderName: 'Authorization' | 'x-goog-api-key' | 'x-api-key',
): boolean {
  const normalizedName = authHeaderName.toLowerCase()
  return [profile.defaultHeaders, overrideHeaders].some(
    (headers) =>
      headers !== undefined &&
      Object.keys(headers).some((name) => name.toLowerCase() === normalizedName),
  )
}

function parseIpv4(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map((part) => Number(part))
  if (bytes.some((byte, index) => !/^\d+$/.test(parts[index] ?? '') || byte < 0 || byte > 255)) {
    return null
  }
  return bytes as [number, number, number, number]
}

function targetAddressSpaceForHostname(hostname: string): TargetAddressSpace | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = parseIpv4(host)
  if (ipv4) {
    const [a, b] = ipv4
    if (a === 127) return 'loopback'
    if (a === 10) return 'local'
    if (a === 169) return b === 254 ? 'local' : null
    if (a === 172) return b >= 16 && b <= 31 ? 'local' : null
    return a === 192 && b === 168 ? 'local' : null
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return 'loopback'
  if (host.endsWith('.local')) return 'local'
  if (!host.includes(':')) return null
  if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return 'local'
  return null
}

function targetAddressSpaceForUrl(url: string): TargetAddressSpace | null {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return targetAddressSpaceForHostname(parsed.hostname)
}

function annotateLocalNetworkFetch(url: string, init: RequestInit): RequestInit {
  try {
    const targetAddressSpace = targetAddressSpaceForUrl(url)
    if (targetAddressSpace) {
      const annotated: LocalNetworkRequestInit = {
        ...(init as LocalNetworkRequestInit),
        targetAddressSpace,
      }
      return annotated
    }
  } catch {
    // Relative URLs are same-origin app requests, not cross-origin local-network targets.
  }
  return init
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
  const deadline = timeoutMs > 0 ? monotonicNow() + timeoutMs : undefined
  const timeoutCtl = new AbortController()
  const timer = timeoutMs > 0 ? setTimeout(() => timeoutCtl.abort(), timeoutMs) : undefined
  const link = linkSignals([opts.signal, timeoutCtl.signal])
  try {
    const response = await fetch(
      url,
      annotateLocalNetworkFetch(url, { ...init, signal: link.signal }),
    )
    responseBodyContracts.set(response, { deadline, signal: opts.signal })
    return response
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

function bufferedBodyFailure(cause: 'timeout' | 'abort' | 'network' | 'protocol'): ApiError {
  return normalizeError(undefined, { midStream: false, cause })
}

export function releaseResponseBodyTimeout(response: Response): void {
  responseBodyContracts.delete(response)
}

export async function readResponseText(response: Response): Promise<string> {
  const contract = responseBodyContracts.get(response)
  responseBodyContracts.delete(response)

  let body: ReadableStream<Uint8Array> | null
  try {
    body = response.body
  } catch {
    throw bufferedBodyFailure('protocol')
  }
  if (!body) throw bufferedBodyFailure('protocol')

  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    throw bufferedBodyFailure('protocol')
  }

  const signal = contract?.signal
  let interruptedBy: 'timeout' | 'abort' | undefined
  let rejectInterrupted: ((error: ApiError) => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupted = reject
  })
  const interrupt = (cause: 'timeout' | 'abort') => {
    if (interruptedBy !== undefined) return
    interruptedBy = cause
    try {
      void reader.cancel().catch(() => {})
    } catch {
      // The typed timeout/abort remains authoritative even if cancellation fails.
    }
    rejectInterrupted?.(bufferedBodyFailure(cause))
  }
  const onAbort = () => interrupt('abort')
  let timer: ReturnType<typeof setTimeout> | undefined

  if (signal?.aborted) {
    interrupt('abort')
  } else {
    signal?.addEventListener('abort', onAbort, { once: true })
    if (contract?.deadline !== undefined) {
      const remainingMs = contract.deadline - monotonicNow()
      if (remainingMs <= 0) interrupt('timeout')
      else timer = setTimeout(() => interrupt(signal?.aborted ? 'abort' : 'timeout'), remainingMs)
    }
  }

  const decoder = new TextDecoder()
  const parts: string[] = []
  try {
    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await Promise.race([reader.read(), interrupted])
      } catch (error) {
        if (error instanceof ApiError) throw error
        if (signal?.aborted) throw bufferedBodyFailure('abort')
        if (interruptedBy === 'timeout') throw bufferedBodyFailure('timeout')
        throw bufferedBodyFailure('network')
      }
      if (signal?.aborted) throw bufferedBodyFailure('abort')
      if (interruptedBy === 'timeout') throw bufferedBodyFailure('timeout')
      if (result.done) break
      parts.push(decoder.decode(result.value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } finally {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // A failed/canceled reader may still be settling; cancellation above released the body.
    }
  }
}

export async function readResponseJson<T>(response: Response): Promise<T> {
  const text = await readResponseText(response)
  try {
    return JSON.parse(text) as T
  } catch {
    throw bufferedBodyFailure('protocol')
  }
}

export async function readErrorResponseJson(response: Response): Promise<unknown> {
  try {
    return await readResponseJson<unknown>(response)
  } catch (error) {
    if (error instanceof ApiError && (error.kind === 'timeout' || error.kind === 'abort')) {
      throw error
    }
    return { error: { code: response.status, message: response.statusText } }
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503
}

function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(bufferedBodyFailure('abort'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(bufferedBodyFailure('abort'))
    }
    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
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
      cancelUnusedResponseBody(res)
    } catch (e) {
      if (!(e instanceof ApiError) || !e.retryable) throw e
      lastError = e
      if (i === attempts - 1) throw e
    }
    await abortableDelay(computeBackoffMs(i, baseBackoff), opts.signal)
  }
  if (lastError) throw lastError
  throw new Error('fetchWithRetry: unreachable')
}

function cancelUnusedResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {})
  } catch {
    // Retry behavior must not depend on whether a runtime can cancel an unused body.
  }
}

// True when the response says "this key itself is the problem" — 401, 403,
// or an account-exhaustion 429 (x-ratelimit-limit: 0). A plain 429 without
// that header is a per-minute throttle and must NOT rotate (§4.10.1).
export function isKeyFallbackTrigger(response: Response): boolean {
  if (response.status === 401 || response.status === 403) return true
  if (response.status === 429) {
    const rawLimit = response.headers.get('x-ratelimit-limit')
    if (rawLimit === null || rawLimit.trim().length === 0) return false
    const limit = Number(rawLimit)
    return Number.isFinite(limit) && limit === 0
  }
  return false
}

interface KeyFallbackResult<Candidate> {
  response: Response
  candidate: Candidate
  candidateIndex: number
}

interface KeyFallbackRequest {
  url: string
  init: RequestInit
}

export interface ApiKeyCandidate {
  readonly resolve: () => string | Promise<string>
  readonly markUsed?: () => void | Promise<void>
}

export interface ApiKeyDispatchContext {
  readonly apiKey: string
  readonly apiKeyCandidates?: readonly ApiKeyCandidate[]
  readonly onKeyCandidateSelected?: (
    candidate: ApiKeyCandidate,
    candidateIndex: number,
    apiKey: string,
  ) => void | Promise<void>
}

interface ApiKeyFallbackResult {
  response: Response
  candidate: ApiKeyCandidate
  candidateIndex: number
  apiKey: string
}

interface RequestBuilderState {
  pending: boolean
}

const requestBuilderStates = import.meta.env.DEV
  ? new WeakMap<object, RequestBuilderState>()
  : undefined

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw normalizeError(signal.reason, { midStream: false, cause: 'abort' })
  }
}

async function runAbortableRequestStep<T>(
  start: () => T | PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  try {
    return await raceWithAbortSignal(start, signal)
  } catch (error) {
    if (signal?.aborted) {
      throw normalizeError(error, { midStream: false, cause: 'abort' })
    }
    throw error
  }
}

// Tries each opaque candidate in order. The caller rebuilds authentication
// headers per candidate while reusing the same request body. Rotation is only
// allowed before response-body consumption; the selected candidate is returned
// ephemerally and is never inspected or logged here.
export async function fetchWithKeyFallback<Candidate>(
  candidates: readonly Candidate[],
  build: (
    candidate: Candidate,
    candidateIndex: number,
  ) => KeyFallbackRequest | Promise<KeyFallbackRequest>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<KeyFallbackResult<Candidate>> {
  if (candidates.length === 0) {
    throw new Error('fetchWithKeyFallback: at least one candidate is required')
  }
  for (let i = 0; i < candidates.length; i += 1) {
    throwIfAborted(opts.signal)
    const candidate = candidates[i] as Candidate
    const { url, init } = await runAbortableRequestStep(() => build(candidate, i), opts.signal)
    throwIfAborted(opts.signal)
    const res = await fetchWithTimeout(url, init, opts)
    const result = { response: res, candidate, candidateIndex: i }
    if (res.ok || res.bodyUsed || !isKeyFallbackTrigger(res)) return result
    if (i === candidates.length - 1) return result
    // Non-last rotate trigger: cancel the body to free the socket before
    // the next attempt. A response returned to the caller stays unread.
    try {
      await runAbortableRequestStep(() => res.body?.cancel(), opts.signal)
    } catch (error) {
      if (opts.signal?.aborted) throw error
      return result
    }
  }
  throw new Error('fetchWithKeyFallback: unreachable')
}

type ApiKeyRequestBuilder = (
  apiKey: string,
  candidate: ApiKeyCandidate,
  candidateIndex: number,
) => KeyFallbackRequest | Promise<KeyFallbackRequest>

export function fetchWithApiKeyFallback(
  ctx: ApiKeyDispatchContext,
  build: ApiKeyRequestBuilder,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ApiKeyFallbackResult> {
  const state: RequestBuilderState | undefined = requestBuilderStates
    ? { pending: true }
    : undefined
  const requested = fetchWithApiKeyFallbackImpl(ctx, build, opts, state)
  if (state) requestBuilderStates?.set(requested, state)
  return requested
}

async function fetchWithApiKeyFallbackImpl(
  ctx: ApiKeyDispatchContext,
  buildRequest: ApiKeyRequestBuilder | undefined,
  opts: { signal?: AbortSignal; timeoutMs?: number },
  state: RequestBuilderState | undefined,
): Promise<ApiKeyFallbackResult> {
  const legacyCandidate: ApiKeyCandidate = { resolve: () => ctx.apiKey }
  const candidates =
    ctx.apiKeyCandidates && ctx.apiKeyCandidates.length > 0
      ? ctx.apiKeyCandidates
      : [legacyCandidate]
  const resolvedKeys = new Map<number, string>()
  let result: KeyFallbackResult<ApiKeyCandidate>
  try {
    result = await fetchWithKeyFallback(
      candidates,
      async (candidate, candidateIndex) => {
        const apiKey = await runAbortableRequestStep(candidate.resolve, opts.signal)
        resolvedKeys.set(candidateIndex, apiKey)
        return (buildRequest as ApiKeyRequestBuilder)(apiKey, candidate, candidateIndex)
      },
      opts,
    )
  } finally {
    buildRequest = undefined
    if (state) state.pending = false
  }
  const apiKey = resolvedKeys.get(result.candidateIndex)
  if (apiKey === undefined) {
    throw new Error('fetchWithApiKeyFallback: selected candidate was not resolved')
  }
  if (result.response.ok) {
    await ctx.onKeyCandidateSelected?.(result.candidate, result.candidateIndex, apiKey)
    try {
      const marked = result.candidate.markUsed?.()
      void Promise.resolve(marked).catch(() => {})
    } catch {
      // Key-use metadata is best-effort and must not discard a provider response.
    }
  }
  return { ...result, apiKey }
}

export function __apiKeyRequestBuilderPendingForTests(request: object): boolean | undefined {
  return requestBuilderStates?.get(request)?.pending
}

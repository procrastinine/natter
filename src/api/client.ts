// Fetch wrapper — header merge, timeout, abort, and key-fallback chain.
//
// This file is environment-neutral (no `window`, no IDB, no DOM). Both the
// in-tab engine and the daemon engine build import it directly.

import type { ConnectionHttpProfile, ConnectionProfile } from '../core/types'
import { raceWithAbortSignal } from '../lib/abort'
import {
  logStreamDebug,
  logStreamDebugError,
  logStreamDebugRequestAttempt,
  type StreamDebugTrace,
  snapshotStreamDebugRequest,
  startStreamDebug,
} from '../lib/debug-streams'
import type { CallOpts } from './call-opts'
import { ApiError, normalizeError } from './errors'

const DEFAULT_TIMEOUT_MS = 120_000

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

function isAnthropicBrowserOriginProfile(profile: ConnectionHttpProfile): boolean {
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
  profile: ConnectionHttpProfile,
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

function hasExplicitAuthHeaderOverride(
  profile: ConnectionHttpProfile,
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

async function consumeResponseBody<T>(
  response: Response,
  consume: (chunk: Uint8Array) => void,
  finish: () => T,
): Promise<T> {
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
      consume(result.value)
    }
    return finish()
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

export function readResponseText(response: Response): Promise<string> {
  const decoder = new TextDecoder()
  const parts: string[] = []
  return consumeResponseBody(
    response,
    (chunk) => parts.push(decoder.decode(chunk, { stream: true })),
    () => {
      parts.push(decoder.decode())
      return parts.join('')
    },
  )
}

export function readResponseBlob(response: Response): Promise<Blob> {
  const parts: BlobPart[] = []
  return consumeResponseBody(
    response,
    (chunk) => parts.push(chunk as Uint8Array<ArrayBuffer>),
    () => new Blob(parts, { type: response.headers.get('content-type') ?? '' }),
  )
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

interface KeyFallbackOptions<Candidate> {
  signal?: AbortSignal
  timeoutMs?: number
  onAttemptResponse?: (result: KeyFallbackResult<Candidate>) => void
}

export interface ApiKeyCandidate {
  readonly resolve: () => string | Promise<string>
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
  opts: KeyFallbackOptions<Candidate> = {},
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
    opts.onAttemptResponse?.(result)
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
  opts: KeyFallbackOptions<ApiKeyCandidate> = {},
): Promise<ApiKeyFallbackResult> {
  return fetchWithApiKeyFallbackImpl(ctx, build, opts)
}

async function fetchWithApiKeyFallbackImpl(
  ctx: ApiKeyDispatchContext,
  buildRequest: ApiKeyRequestBuilder | undefined,
  opts: KeyFallbackOptions<ApiKeyCandidate>,
): Promise<ApiKeyFallbackResult> {
  const legacyCandidate: ApiKeyCandidate = { resolve: () => ctx.apiKey }
  const candidates =
    ctx.apiKeyCandidates && ctx.apiKeyCandidates.length > 0
      ? ctx.apiKeyCandidates
      : [legacyCandidate]
  let resolvedCandidateIndex = -1
  let resolvedApiKey: string | undefined
  let result: KeyFallbackResult<ApiKeyCandidate>
  try {
    result = await fetchWithKeyFallback(
      candidates,
      async (candidate, candidateIndex) => {
        const apiKey = await runAbortableRequestStep(candidate.resolve, opts.signal)
        resolvedCandidateIndex = candidateIndex
        resolvedApiKey = apiKey
        return (buildRequest as ApiKeyRequestBuilder)(apiKey, candidate, candidateIndex)
      },
      opts,
    )
  } finally {
    buildRequest = undefined
  }
  if (resolvedCandidateIndex !== result.candidateIndex || resolvedApiKey === undefined) {
    throw new Error('fetchWithApiKeyFallback: selected candidate was not resolved')
  }
  const apiKey = resolvedApiKey
  if (result.response.ok) {
    try {
      await runAbortableRequestStep(
        () => ctx.onKeyCandidateSelected?.(result.candidate, result.candidateIndex, apiKey),
        opts.signal,
      )
    } catch (error) {
      cancelUnusedResponseBody(result.response)
      throw error
    }
  }
  return { ...result, apiKey }
}

export interface ProviderDispatchResult {
  readonly response: Response
  readonly debugTrace: StreamDebugTrace | null
  readonly selectedApiKey: string
}

export function dispatchProviderJsonRequest<Request>(input: {
  readonly adapter: string
  readonly context: ApiKeyDispatchContext & { readonly profile: ConnectionProfile }
  readonly url: string
  readonly request: Request
  readonly opts: CallOpts
  readonly authHeaderName: 'Authorization' | 'x-goog-api-key' | 'x-api-key'
  readonly authScheme?: 'bearer' | 'gemini-native' | 'anthropic-native'
  readonly fixedHeaders?: Readonly<Record<string, string>>
}): Promise<ProviderDispatchResult> {
  const overrideHeaders = mergeRequestHeaders(input.fixedHeaders, input.opts.overrideHeaders)
  return dispatchJsonWithApiKeyFallback({
    adapter: input.adapter,
    ...(input.opts.diagnosticId ? { diagnosticId: input.opts.diagnosticId } : {}),
    profile: input.context.profile,
    authContext: hasExplicitAuthHeaderOverride(
      input.context.profile,
      overrideHeaders,
      input.authHeaderName,
    )
      ? { apiKey: input.context.apiKey }
      : input.context,
    url: input.url,
    body: JSON.stringify(input.request),
    request: input.request,
    buildHeaders: (apiKey) =>
      buildHeaders(input.context.profile, apiKey, {
        method: 'POST',
        ...(input.authScheme ? { authScheme: input.authScheme } : {}),
        ...(overrideHeaders ? { overrideHeaders } : {}),
      }),
    ...(input.opts.signal ? { signal: input.opts.signal } : {}),
    ...(input.opts.timeoutMs !== undefined ? { timeoutMs: input.opts.timeoutMs } : {}),
  })
}

function mergeRequestHeaders(
  fixed: Readonly<Record<string, string>> | undefined,
  overrides: Readonly<Record<string, string>> | undefined,
): Record<string, string> | undefined {
  if (!fixed && !overrides) return undefined
  return { ...(fixed ?? {}), ...(overrides ?? {}) }
}

function dispatchJsonWithApiKeyFallback(input: {
  readonly adapter: string
  readonly diagnosticId?: string
  readonly profile: ConnectionProfile
  readonly authContext: ApiKeyDispatchContext
  readonly url: string
  readonly body: string
  readonly request: unknown
  readonly buildHeaders: (
    apiKey: string,
    candidate: ApiKeyCandidate,
    candidateIndex: number,
  ) => Record<string, string>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}): Promise<ProviderDispatchResult> {
  const debugRequest = snapshotStreamDebugRequest(input.profile, input.request)
  let debugTrace: StreamDebugTrace | null = null
  const fallbackOptions: KeyFallbackOptions<ApiKeyCandidate> = {
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  }
  if (debugRequest !== null) {
    fallbackOptions.onAttemptResponse = ({ response, candidateIndex }) => {
      if (!debugTrace) return
      logStreamDebug(debugTrace, 'response-head', {
        attemptIndex: candidateIndex,
        status: response.status,
        contentType: response.headers.get('content-type'),
        generationId:
          response.headers.get('x-generation-id') ??
          response.headers.get('x-request-id') ??
          response.headers.get('anthropic-request-id') ??
          undefined,
      })
    }
  }
  const fetched = fetchWithApiKeyFallback(
    input.authContext,
    (apiKey, candidate, candidateIndex) => {
      const headers = input.buildHeaders(apiKey, candidate, candidateIndex)
      if (debugRequest !== null) {
        if (debugTrace) {
          logStreamDebugRequestAttempt(debugTrace, {
            url: input.url,
            headers,
            attemptIndex: candidateIndex,
          })
        } else {
          debugTrace = startStreamDebug({
            adapter: input.adapter,
            ...(input.diagnosticId ? { diagnosticId: input.diagnosticId } : {}),
            profile: input.profile,
            url: input.url,
            request: debugRequest,
            headers,
            attemptIndex: candidateIndex,
          })
        }
      }
      return { url: input.url, init: { method: 'POST', headers, body: input.body } }
    },
    fallbackOptions,
  )
  return fetched.then(
    async ({ response, apiKey }) => {
      const result = { response, debugTrace, selectedApiKey: apiKey }
      if (response.ok) return result
      const errorBody = await readErrorResponseJson(response)
      if (debugTrace) {
        logStreamDebug(debugTrace, 'error', { status: response.status, body: errorBody })
      }
      throw normalizeError(errorBody, { midStream: false, httpStatus: response.status })
    },
    (error: unknown) => {
      if (debugTrace) logStreamDebugError(debugTrace, error)
      throw error
    },
  )
}

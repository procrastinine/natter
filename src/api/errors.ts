// Transport error taxonomy. See `plan/04-api-client.md §4.5`.
//
// `normalizeError` is the single choke point for all upstream failure modes.
// Every error that leaves the transport layer is an `ApiError` — callers don't
// need to branch on DOMException / TypeError / response shape themselves. The
// `retryable` flag is a HINT for the UI's retry button; the actual retry policy
// (GET backoff, key fallback chain) lives in `client.ts`.

type ApiErrorKind =
  | 'network'
  | 'timeout'
  | 'abort'
  | 'bad_request'
  | 'unauthorized'
  | 'payment_required'
  | 'moderation'
  | 'rate_limited'
  | 'provider_error'
  | 'no_provider_available'
  | 'validation'
  | 'unknown'

interface ApiErrorShape {
  kind: ApiErrorKind
  httpStatus?: number
  code: number | string
  message: string
  metadata?: Record<string, unknown>
  midStream: boolean
  retryable: boolean
}

export class ApiError extends Error implements ApiErrorShape {
  readonly kind: ApiErrorKind
  readonly httpStatus?: number
  readonly code: number | string
  readonly metadata?: Record<string, unknown>
  readonly midStream: boolean
  readonly retryable: boolean

  constructor(shape: ApiErrorShape) {
    super(shape.message)
    this.name = 'ApiError'
    this.kind = shape.kind
    if (shape.httpStatus !== undefined) this.httpStatus = shape.httpStatus
    this.code = shape.code
    if (shape.metadata !== undefined) this.metadata = shape.metadata
    this.midStream = shape.midStream
    this.retryable = shape.retryable
  }
}

interface NormalizeCtx {
  midStream: boolean
  httpStatus?: number
  // When the request never reached a response, the caller indicates WHICH
  // abort happened (timeout, user-abort, or plain network failure).
  // 'timeout' + 'abort' distinguish the two AbortError sources that fetch
  // cannot tell apart on its own; without this, every aborted request would
  // wind up as `network` or `unknown`.
  cause?: 'timeout' | 'abort' | 'network'
}

function classifyStatus(
  status: number,
  body: { error?: { metadata?: Record<string, unknown> } } | undefined,
): { kind: ApiErrorKind; retryable: boolean } {
  if (status === 400) return { kind: 'bad_request', retryable: false }
  if (status === 401) return { kind: 'unauthorized', retryable: false }
  if (status === 402) return { kind: 'payment_required', retryable: false }
  if (status === 403) {
    const hasReasons = body?.error?.metadata !== undefined && 'reasons' in body.error.metadata
    return hasReasons
      ? { kind: 'moderation', retryable: false }
      : { kind: 'unauthorized', retryable: false }
  }
  if (status === 408) return { kind: 'timeout', retryable: true }
  if (status === 429) return { kind: 'rate_limited', retryable: true }
  if (status === 502) return { kind: 'provider_error', retryable: true }
  if (status === 503) return { kind: 'no_provider_available', retryable: true }
  if (status >= 500 && status < 600) return { kind: 'provider_error', retryable: true }
  if (status >= 400 && status < 500) return { kind: 'bad_request', retryable: false }
  return { kind: 'unknown', retryable: false }
}

interface ErrorLike {
  error?: {
    code?: number | string
    message?: string
    metadata?: Record<string, unknown>
  }
}

function extractErrorBody(input: unknown): ErrorLike {
  if (input && typeof input === 'object') return input
  return {}
}

export function normalizeError(input: unknown, ctx: NormalizeCtx): ApiError {
  if (input instanceof ApiError) return input

  // Pre-response failures: the AbortSignal.any path above this classifies the
  // `cause` so that a timeout AbortError doesn't get labeled `abort`.
  if (ctx.cause === 'abort') {
    return new ApiError({
      kind: 'abort',
      code: 'ABORTED',
      message: 'Request aborted',
      midStream: ctx.midStream,
      retryable: false,
    })
  }
  if (ctx.cause === 'timeout') {
    return new ApiError({
      kind: 'timeout',
      code: 'TIMEOUT',
      message: 'Request timed out',
      midStream: ctx.midStream,
      retryable: true,
    })
  }

  if (ctx.httpStatus !== undefined) {
    const body = extractErrorBody(input)
    const cls = classifyStatus(ctx.httpStatus, body)
    const shape: ApiErrorShape = {
      kind: cls.kind,
      httpStatus: ctx.httpStatus,
      code: body.error?.code ?? ctx.httpStatus,
      message: body.error?.message ?? `HTTP ${ctx.httpStatus}`,
      midStream: ctx.midStream,
      retryable: cls.retryable,
    }
    if (body.error?.metadata !== undefined) shape.metadata = body.error.metadata
    return new ApiError(shape)
  }

  // Mid-stream JSON chunk carrying `error.code` is already at HTTP 200 (§4.5).
  if (ctx.midStream) {
    const body = extractErrorBody(input)
    const code = body.error?.code
    if (typeof code === 'number' && code >= 100 && code < 600) {
      const cls = classifyStatus(code, body)
      const shape: ApiErrorShape = {
        kind: cls.kind,
        httpStatus: code,
        code,
        message: body.error?.message ?? `Stream error ${code}`,
        midStream: true,
        retryable: cls.retryable,
      }
      if (body.error?.metadata !== undefined) shape.metadata = body.error.metadata
      return new ApiError(shape)
    }
  }

  // No HTTP status, no user abort, no timeout: network or an opaque throw.
  const message =
    input instanceof Error ? input.message : typeof input === 'string' ? input : 'Network error'
  return new ApiError({
    kind: ctx.cause === 'network' ? 'network' : 'unknown',
    code: ctx.cause === 'network' ? 'NETWORK' : 'UNKNOWN',
    message,
    midStream: ctx.midStream,
    retryable: ctx.cause === 'network',
  })
}

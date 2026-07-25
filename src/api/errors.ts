// `normalizeError` is the single choke point for all upstream failure modes.
// Every error that leaves the transport layer is an `ApiError` — callers don't
// need to branch on DOMException / TypeError / response shape themselves. The
// `retryable` flag is a HINT for the UI's retry button; the actual retry policy
// (GET backoff, key fallback chain) lives in `client.ts`.

import type { AttemptTerminalFailure } from '../core/attempt-outcome'
import type {
  GenerationFailureKindV2,
  GenerationStreamFailureV2,
} from '../core/generation-stream-events'

export type ApiErrorKind = GenerationFailureKindV2

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

export function apiErrorFromAttemptTerminalFailure(failure: AttemptTerminalFailure): ApiError {
  return new ApiError({
    kind: failure.kind,
    code: failure.code,
    message: failure.message,
    ...(failure.statusCode !== undefined ? { httpStatus: failure.statusCode } : {}),
    midStream: failure.midStream ?? false,
    retryable: failure.retryable ?? false,
  })
}

export function apiErrorFromGenerationStreamFailure(failure: GenerationStreamFailureV2): ApiError {
  if (failure instanceof ApiError) return failure
  return new ApiError({
    kind: failure.kind,
    code: failure.code,
    message: failure.message,
    ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    ...(failure.metadata === undefined ? {} : { metadata: failure.metadata }),
    midStream: failure.midStream,
    retryable: failure.retryable,
  })
}

export interface NormalizeCtx {
  midStream: boolean
  httpStatus?: number
  // When the request never reached a response, the caller indicates WHICH
  // abort happened (timeout, user-abort, or plain network failure).
  // 'timeout' + 'abort' distinguish the two AbortError sources that fetch
  // cannot tell apart on its own; without this, every aborted request would
  // wind up as `network` or `unknown`.
  cause?: 'timeout' | 'abort' | 'network' | 'protocol' | 'storage' | 'integrity' | 'internal'
}

function classifyStatus(
  status: number,
  body: ErrorLike | undefined,
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
  return { kind: 'protocol', retryable: false }
}

interface ErrorLike {
  error?: {
    code?: number | string
    message?: string
    metadata?: Record<string, unknown>
  }
}

function extractErrorBody(input: unknown): ErrorLike {
  if (!isRecord(input) || !isRecord(input.error)) return {}
  const source = input.error
  const error: NonNullable<ErrorLike['error']> = {}
  if (typeof source.code === 'number' || typeof source.code === 'string') {
    error.code = source.code
  }
  if (typeof source.message === 'string') error.message = source.message
  if (isRecord(source.metadata)) error.metadata = source.metadata
  return { error }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  if (
    ctx.cause === 'network' ||
    ctx.cause === 'protocol' ||
    ctx.cause === 'storage' ||
    ctx.cause === 'integrity' ||
    ctx.cause === 'internal'
  ) {
    const labels = {
      network: { code: 'NETWORK', message: 'Network error', retryable: true },
      protocol: {
        code: 'PROTOCOL',
        message: 'Provider response could not be decoded',
        retryable: false,
      },
      storage: { code: 'STORAGE', message: 'Local persistence failed', retryable: true },
      integrity: {
        code: 'INTEGRITY',
        message: 'Response integrity could not be verified',
        retryable: false,
      },
      internal: { code: 'INTERNAL', message: 'Internal generation failure', retryable: false },
    } as const
    const selected = labels[ctx.cause]
    return new ApiError({
      kind: ctx.cause,
      code: selected.code,
      message: input instanceof Error && input.message ? input.message : selected.message,
      midStream: ctx.midStream,
      retryable: selected.retryable,
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

  // No boundary hint means an internal failure. Network/protocol/storage
  // boundaries must classify their own throws before they reach this point.
  const message =
    input instanceof Error
      ? input.message
      : typeof input === 'string'
        ? input
        : 'Internal generation failure'
  return new ApiError({
    kind: 'internal',
    code: 'INTERNAL',
    message,
    midStream: ctx.midStream,
    retryable: false,
  })
}

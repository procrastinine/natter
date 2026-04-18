import { describe, expect, it } from 'vitest'
import { ApiError, normalizeError } from '../../src/api/errors'

describe('normalizeError', () => {
  it('classifies 400 as bad_request (not retryable)', () => {
    const err = normalizeError(
      { error: { code: 400, message: 'bad input' } },
      { midStream: false, httpStatus: 400 },
    )
    expect(err.kind).toBe('bad_request')
    expect(err.retryable).toBe(false)
    expect(err.httpStatus).toBe(400)
    expect(err.code).toBe(400)
    expect(err.message).toBe('bad input')
  })

  it('classifies 401 as unauthorized, 402 as payment_required', () => {
    expect(
      normalizeError({}, { midStream: false, httpStatus: 401 }).kind,
    ).toBe('unauthorized')
    expect(
      normalizeError({}, { midStream: false, httpStatus: 402 }).kind,
    ).toBe('payment_required')
  })

  it('splits 403 into moderation (with metadata.reasons) vs unauthorized (without)', () => {
    const moderation = normalizeError(
      {
        error: {
          code: 403,
          message: 'flagged',
          metadata: { reasons: ['violence'] },
        },
      },
      { midStream: false, httpStatus: 403 },
    )
    expect(moderation.kind).toBe('moderation')
    expect(moderation.metadata?.reasons).toEqual(['violence'])

    const generic = normalizeError(
      { error: { code: 403, message: 'nope' } },
      { midStream: false, httpStatus: 403 },
    )
    expect(generic.kind).toBe('unauthorized')
  })

  it('marks 408/429/502/503 as retryable', () => {
    for (const status of [408, 429, 502, 503]) {
      const err = normalizeError({}, { midStream: false, httpStatus: status })
      expect(err.retryable).toBe(true)
    }
  })

  it('timeout cause yields kind:timeout, not network', () => {
    const err = normalizeError(new Error('boom'), {
      midStream: false,
      cause: 'timeout',
    })
    expect(err.kind).toBe('timeout')
    expect(err.retryable).toBe(true)
  })

  it('abort cause yields kind:abort, not unknown', () => {
    const err = normalizeError(new DOMException('aborted', 'AbortError'), {
      midStream: false,
      cause: 'abort',
    })
    expect(err.kind).toBe('abort')
    expect(err.retryable).toBe(false)
  })

  it('network cause yields kind:network (retryable)', () => {
    const err = normalizeError(new TypeError('fetch failed'), {
      midStream: false,
      cause: 'network',
    })
    expect(err.kind).toBe('network')
    expect(err.retryable).toBe(true)
  })

  it('mid-stream chunk with error.code gets classified and tagged midStream', () => {
    const err = normalizeError(
      { error: { code: 429, message: 'slow down' } },
      { midStream: true },
    )
    expect(err.kind).toBe('rate_limited')
    expect(err.midStream).toBe(true)
    expect(err.httpStatus).toBe(429)
  })

  it('returns ApiError instances unchanged (idempotent)', () => {
    const source = new ApiError({
      kind: 'bad_request',
      code: 400,
      message: 'x',
      midStream: false,
      retryable: false,
    })
    expect(normalizeError(source, { midStream: false })).toBe(source)
  })
})

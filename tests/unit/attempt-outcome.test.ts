import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/api/errors'
import {
  normalizeAttemptIntegritySummary,
  toPersistedAttemptFailure,
} from '../../src/core/attempt-outcome'

describe('persisted attempt outcomes', () => {
  it('maps runtime failures to coarse categories without raw or metadata fields', () => {
    const error = new ApiError({
      kind: 'rate_limited',
      httpStatus: 429,
      code: 429,
      message: 'rate limited',
      metadata: {
        authorization: 'Bearer secret-value',
        prompt: 'private prompt',
      },
      midStream: true,
      retryable: true,
    })

    expect(toPersistedAttemptFailure(error)).toEqual({
      category: 'provider',
      code: '429',
      message: 'rate limited',
      statusCode: 429,
      retryable: true,
      midStream: true,
    })
    expect(JSON.stringify(toPersistedAttemptFailure(error))).not.toContain('secret-value')
    expect(JSON.stringify(toPersistedAttemptFailure(error))).not.toContain('private prompt')
  })

  it('redacts credentials, drops payload-bearing messages, and bounds unsafe codes', () => {
    expect(
      toPersistedAttemptFailure({
        kind: 'provider_error',
        code: 'unsafe code with private material',
        message: 'Bearer sk-private-value',
        raw: { response: { output: 'must-not-persist' } },
      }),
    ).toEqual({
      category: 'provider',
      code: 'PROVIDER',
      message: 'Bearer <redacted>',
    })
    expect(
      toPersistedAttemptFailure({
        kind: 'protocol',
        code: 'BAD_JSON',
        message: 'response payload: {"prompt":"private"}',
      }).message,
    ).toBe('Provider response could not be decoded')
  })

  it('normalizes and caps integrity summaries without accepting arbitrary diagnostics', () => {
    const entries = Array.from({ length: 20 }, (_, index) => ({
      category: 'malformed-json-frame',
      adapter: 'responses',
      eventType: `response.output_text.delta.${index}`,
      count: 1,
      characterCount: 10,
      fingerprint: `fnv1a32:${index.toString(16).padStart(8, '0')}`,
      raw: 'private frame',
    }))

    const summary = normalizeAttemptIntegritySummary({
      count: 20,
      characterCount: 200,
      entries,
      raw: 'private frame',
    })

    expect(summary).toMatchObject({ count: 20, characterCount: 200 })
    expect(summary?.entries).toHaveLength(16)
    expect(JSON.stringify(summary)).not.toContain('private frame')
  })
})

// Phase 11: token-estimate accounting for reasoning echo.
// Regression guard: NEVER double-count a scalar `reasoning` field — storage
// only ever carries `reasoningDetails[]` after the 1390685 dedup fix.

import { describe, expect, it } from 'vitest'
import {
  estimatePromptTokens,
  estimateReasoningEchoTokens,
  type PromptEstimateOptions,
} from '../../src/core/tokens'
import type { Message, ReasoningDetail, ReasoningInclude } from '../../src/core/types'

function assistant(id: string, text: string, details?: ReasoningDetail[]): Message {
  return {
    id,
    chatId: 'c',
    parentId: null,
    siblingIndex: 0,
    turnId: `${id}-t`,
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'text', text }],
    ...(details ? { reasoningDetails: details } : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

function user(id: string, text: string): Message {
  return {
    id,
    chatId: 'c',
    parentId: null,
    siblingIndex: 0,
    turnId: `${id}-t`,
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text }],
    nodeVersion: 0,
    deleted: false,
  }
}

function opts(
  include: ReasoningInclude,
  fmt:
    | 'openai-responses-v1'
    | 'anthropic-claude-v1'
    | 'google-gemini-v1'
    | 'unknown'
    | undefined = 'openai-responses-v1',
  excluded = false,
): PromptEstimateOptions {
  return {
    family: 'gpt',
    reasoningInclude: include,
    ...(fmt !== undefined ? { reasoningPreservationFormat: fmt } : {}),
    reasoningExcluded: excluded,
  }
}

describe('estimateReasoningEchoTokens — include flags gate cost', () => {
  it('zero cost when all-false', () => {
    const path: Message[] = [
      assistant('a1', 'answer', [
        { type: 'reasoning.text', text: 'verbose reasoning' },
        { type: 'reasoning.summary', summary: 'summary' },
        { type: 'reasoning.encrypted', data: 'A'.repeat(300), format: 'openai-responses-v1' },
      ]),
    ]
    expect(
      estimateReasoningEchoTokens(path, opts({ encrypted: false, summary: false, text: false })),
    ).toBe(0)
  })

  it('encrypted-only counts ≈ data.length / 3', () => {
    const path: Message[] = [
      assistant('a1', 'answer', [
        { type: 'reasoning.encrypted', data: 'A'.repeat(300), format: 'openai-responses-v1' },
      ]),
    ]
    const cost = estimateReasoningEchoTokens(
      path,
      opts({ encrypted: true, summary: false, text: false }),
    )
    // 300 / 3 = 100
    expect(cost).toBe(100)
  })

  it('mismatched preservationFormat drops encrypted cost', () => {
    const path: Message[] = [
      assistant('a1', 'answer', [
        { type: 'reasoning.encrypted', data: 'A'.repeat(300), format: 'anthropic-claude-v1' },
      ]),
    ]
    expect(
      estimateReasoningEchoTokens(
        path,
        opts({ encrypted: true, summary: false, text: false }, 'openai-responses-v1'),
      ),
    ).toBe(0)
  })

  it('summary counts by characters (GPT ≈ 3.5 cpt)', () => {
    const summary = 'A'.repeat(70) // 70 chars ≈ 20 tokens at 3.5 cpt
    const path: Message[] = [assistant('a1', 'answer', [{ type: 'reasoning.summary', summary }])]
    const cost = estimateReasoningEchoTokens(
      path,
      opts({ encrypted: false, summary: true, text: false }),
    )
    expect(cost).toBe(20)
  })

  it('text counts by characters + 16-token signature guard when present', () => {
    const text = 'A'.repeat(70) // 20 tokens
    const path: Message[] = [
      assistant('a1', 'answer', [
        {
          type: 'reasoning.text',
          format: 'anthropic-claude-v1',
          text,
          signature: 'sig',
        },
      ]),
    ]
    // The Anthropic signed-text detail is encrypted-gated (signature present):
    // include.text=true doesn't keep it; include.encrypted=true does.
    const cost = estimateReasoningEchoTokens(
      path,
      opts({ encrypted: true, summary: false, text: false }, 'anthropic-claude-v1'),
    )
    expect(cost).toBe(20 + 16)
  })

  it('reasoningExcluded drops visible (summary/text) cost even when flags are true', () => {
    const path: Message[] = [
      assistant('a1', 'answer', [
        { type: 'reasoning.summary', summary: 'A'.repeat(70) },
        { type: 'reasoning.text', text: 'A'.repeat(70) },
        { type: 'reasoning.encrypted', data: 'A'.repeat(300), format: 'openai-responses-v1' },
      ]),
    ]
    const cost = estimateReasoningEchoTokens(
      path,
      opts({ encrypted: true, summary: true, text: true }, 'openai-responses-v1', true),
    )
    // Only encrypted counted (300/3 = 100).
    expect(cost).toBe(100)
  })
})

describe('estimatePromptTokens — full path', () => {
  it('sums system prompt + visible content + reasoning echo', () => {
    const path: Message[] = [
      user('u1', 'A'.repeat(35)), // ≈10 tokens
      assistant('a1', 'A'.repeat(35), [
        { type: 'reasoning.encrypted', data: 'A'.repeat(300), format: 'openai-responses-v1' },
      ]),
    ]
    const cost = estimatePromptTokens(
      path,
      'A'.repeat(35), // ≈10 tokens
      opts({ encrypted: true, summary: false, text: false }),
    )
    // 10 (system) + 10 (user) + 10 (assistant visible) + 100 (encrypted echo) = 130
    expect(cost).toBe(130)
  })

  it('skips tombstoned + hidden messages', () => {
    const pathA: Message[] = [
      {
        ...user('u1', 'A'.repeat(35)),
        deleted: true,
      },
      assistant('a1', 'A'.repeat(35)),
    ]
    const pathB: Message[] = [
      {
        ...user('u1', 'A'.repeat(35)),
        hiddenFromContext: true,
      },
      assistant('a1', 'A'.repeat(35)),
    ]
    const costA = estimatePromptTokens(
      pathA,
      '',
      opts({ encrypted: true, summary: false, text: false }),
    )
    const costB = estimatePromptTokens(
      pathB,
      '',
      opts({ encrypted: true, summary: false, text: false }),
    )
    // Each path has only the assistant's 10 tokens left.
    expect(costA).toBe(10)
    expect(costB).toBe(10)
  })
})

describe('guards — reasoning echo robustness', () => {
  it('does not throw on malformed reasoning entries (returns 0)', () => {
    const path: Message[] = [
      {
        ...assistant('a1', 'answer'),
        reasoningDetails: [
          // Intentionally wrong shapes — a corrupt rehydrated row.
          {
            type: 'reasoning.text',
            text: null as unknown as string,
            signature: {} as unknown as string,
          },
          { type: 'reasoning.encrypted', data: null as unknown as string },
          { type: 'reasoning.summary', summary: undefined as unknown as string },
        ],
      },
    ]
    expect(() =>
      estimateReasoningEchoTokens(path, opts({ encrypted: true, summary: true, text: true })),
    ).not.toThrow()
  })

  it('caps enormous encrypted blob via clampTokens (no 3.3M-token explosion)', () => {
    const path: Message[] = [
      assistant('a1', 'answer', [
        {
          type: 'reasoning.encrypted',
          data: 'A'.repeat(10_000_000),
          format: 'openai-responses-v1',
        },
      ]),
    ]
    const cost = estimateReasoningEchoTokens(
      path,
      opts({ encrypted: true, summary: false, text: false }),
    )
    // 10M / 3 = 3.33M — well below MAX_PLAUSIBLE_TOKENS (100M) so we expect
    // the ceil'd value through but NOT an overflow.
    expect(cost).toBeGreaterThan(0)
    expect(cost).toBeLessThanOrEqual(100_000_000)
  })

  it('ignores corrupt reasoning_tokens via safeServerTokens', () => {
    const m: Message = {
      ...assistant('a1', 'answer', [
        { type: 'reasoning.encrypted', data: 'A'.repeat(300), format: 'openai-responses-v1' },
      ]),
      generation: {
        usage: {
          // `reasoning_tokens` of "n/a" is a hypothetical malformed server field.
          completion_tokens_details: { reasoning_tokens: 'n/a' as unknown as number },
        } as unknown as Message['generation']['usage'],
      } as unknown as Message['generation'],
    }
    // When providerReasoningTokens is invalid, we fall back to the char estimate.
    const cost = estimateReasoningEchoTokens(
      [m],
      opts({ encrypted: true, summary: false, text: false }),
    )
    // 300 / 3 = 100 (as in the earlier test — no clamp because provider field was invalid).
    expect(cost).toBe(100)
  })

  it('ignores negative reasoning_tokens via safeServerTokens', () => {
    const m: Message = {
      ...assistant('a1', 'answer', [
        { type: 'reasoning.encrypted', data: 'A'.repeat(300), format: 'openai-responses-v1' },
      ]),
      generation: {
        usage: {
          completion_tokens_details: { reasoning_tokens: -5 },
        } as unknown as Message['generation']['usage'],
      } as unknown as Message['generation'],
    }
    const cost = estimateReasoningEchoTokens(
      [m],
      opts({ encrypted: true, summary: false, text: false }),
    )
    expect(cost).toBe(100)
  })
})

describe('dedup invariant — storage never holds scalar reasoning', () => {
  it('normalizes partial-overlap reasoning.text details before counting', () => {
    // Emulating a rehydrated legacy chat where the accumulator wrote both
    // scalar-style "thinking about X" as detail[0].text AND appended
    // " about X" as a second detail chunk. `normalizeReasoningDetails` in
    // core/reasoning.ts collapses these on read.
    const path: Message[] = [
      assistant('a1', 'answer', [
        { type: 'reasoning.text', id: 'r', text: 'thinking about ' },
        { type: 'reasoning.text', id: 'r', text: 'thinking about X' },
      ]),
    ]
    const cost = estimateReasoningEchoTokens(
      path,
      opts({ encrypted: false, summary: false, text: true }, 'unknown'),
    )
    // Normalized: single "thinking about X" (16 chars) ≈ ceil(16 / 3.5) = 5.
    expect(cost).toBe(5)
  })
})

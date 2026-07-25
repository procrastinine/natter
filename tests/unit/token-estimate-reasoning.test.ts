// Phase 11: token-estimate accounting for reasoning echo.
// Regression guard: NEVER double-count a scalar `reasoning` field — storage
// only ever carries `reasoningDetails[]` after the 1390685 dedup fix.

import { describe, expect, it } from 'vitest'
import {
  createOutboundReasoningCompiler,
  outboundReasoningRouteForReplayContract,
} from '../../src/core/outbound-reasoning'
import { TEXT_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import {
  estimatePromptTokens,
  estimateReasoningEchoTokens,
  type PromptEstimateOptions,
} from '../../src/core/tokens'
import type {
  Message,
  ReasoningDetail,
  ReasoningInclude,
  ReasoningOriginDialect,
} from '../../src/core/types'
import {
  anthropicReasoningContract,
  chatReasoningContract,
  geminiReasoningContract,
  responsesReasoningContract,
} from '../helpers/reasoning-contracts'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

function assistant(
  id: string,
  text: string,
  details?: ReasoningDetail[],
  dialect: ReasoningOriginDialect = dialectForDetails(details ?? []),
): Message {
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
    ...(details
      ? { reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(details, dialect) }
      : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

function dialectForDetails(details: readonly ReasoningDetail[]): ReasoningOriginDialect {
  const format = details[0]?.format
  if (format === 'anthropic-claude-v1') return 'anthropic-messages'
  if (format === 'google-gemini-v1') return 'gemini-native'
  if (
    format === 'openai-responses-v1' ||
    format === 'azure-openai-responses-v1' ||
    format === 'xai-responses-v1'
  ) {
    return 'openai-responses'
  }
  return 'openrouter-chat'
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
    | 'unknown' = 'openai-responses-v1',
  excluded = false,
): PromptEstimateOptions {
  const effectiveInclude = excluded ? { ...include, summary: false, text: false } : include
  const contract =
    fmt === 'anthropic-claude-v1'
      ? anthropicReasoningContract({ include: effectiveInclude })
      : fmt === 'google-gemini-v1'
        ? geminiReasoningContract({ include: effectiveInclude })
        : fmt === 'unknown'
          ? chatReasoningContract({
              include: effectiveInclude,
              carrier: 'openrouter-reasoning-details',
              originDialect: 'openrouter-chat',
              targetFormat: null,
            })
          : responsesReasoningContract({
              include: effectiveInclude,
              targetFormat: fmt,
            })
  return {
    family: 'gpt',
    reasoningResolver: createOutboundReasoningCompiler(
      outboundReasoningRouteForReplayContract(contract),
    ),
    providerOutput: TEXT_PROVIDER_OUTPUT_CONTRACT,
  }
}

describe('estimateReasoningEchoTokens — include flags gate cost', () => {
  it('zero cost when all-false', () => {
    const path: Message[] = [
      assistant('a1', 'answer', [
        { type: 'reasoning.text', format: 'openai-responses-v1', text: 'verbose reasoning' },
        { type: 'reasoning.summary', format: 'openai-responses-v1', summary: 'summary' },
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
    const path: Message[] = [
      assistant('a1', 'answer', [
        { type: 'reasoning.summary', format: 'openai-responses-v1', summary },
      ]),
    ]
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
        { type: 'reasoning.summary', format: 'openai-responses-v1', summary: 'A'.repeat(70) },
        { type: 'reasoning.text', format: 'openai-responses-v1', text: 'A'.repeat(70) },
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
  it('does not throw after malformed history is normalized to an empty envelope', () => {
    const path: Message[] = [
      {
        ...assistant('a1', 'answer'),
        reasoningEnvelope: { schemaVersion: 2, visible: [], carriers: [] },
      },
    ]
    expect(
      estimateReasoningEchoTokens(path, opts({ encrypted: true, summary: true, text: true })),
    ).toBe(0)
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
    // 10M / 3 = 3.33M, well below MAX_PLAUSIBLE_TOKENS (100M), so the
    // ceil'd value passes through without overflow.
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
        } as unknown as NonNullable<Message['generation']>['usage'],
      } as unknown as NonNullable<Message['generation']>,
    }
    // When providerReasoningTokens is invalid, the char estimate is used.
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
        } as unknown as NonNullable<Message['generation']>['usage'],
      } as unknown as NonNullable<Message['generation']>,
    }
    const cost = estimateReasoningEchoTokens(
      [m],
      opts({ encrypted: true, summary: false, text: false }),
    )
    expect(cost).toBe(100)
  })
})

describe('reasoning row accounting', () => {
  it('counts distinct current-envelope text members without read-time deduplication', () => {
    const message = assistant('a1', 'answer')
    message.reasoningEnvelope = {
      schemaVersion: 2,
      visible: [
        {
          id: 'visible-1',
          groupId: 'group-1',
          kind: 'text',
          format: 'unknown',
          text: 'thinking about ',
          source: { dialect: 'openrouter-chat', bridge: 'openrouter', detailId: 'r-1' },
        },
        {
          id: 'visible-2',
          groupId: 'group-2',
          kind: 'text',
          format: 'unknown',
          text: 'thinking about X',
          source: { dialect: 'openrouter-chat', bridge: 'openrouter', detailId: 'r-2' },
        },
      ],
      carriers: [],
    }
    const cost = estimateReasoningEchoTokens(
      [message],
      opts({ encrypted: false, summary: false, text: true }, 'unknown'),
    )
    expect(cost).toBe(14)
  })

  it('caps opaque reasoning independently for each applied attempt', () => {
    const root = reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.encrypted',
          format: 'openai-responses-v1',
          data: 'A'.repeat(300),
        },
      ],
      'openai-responses',
    )
    const applied = reasoningEnvelopeFromDetailsForTest(
      [
        {
          type: 'reasoning.encrypted',
          format: 'openai-responses-v1',
          data: 'B'.repeat(300),
        },
      ],
      'openai-responses',
    )
    const message: Message = {
      ...assistant('a1', 'answer'),
      reasoningEnvelope: root,
      generation: {
        usage: {
          prompt_tokens: 0,
          completion_tokens: 40,
          total_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 40 },
        },
        startedAt: 1,
        reasoningCarryForward: 'carrier',
        reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
      },
      continuationAttempts: [
        {
          streamId: 'applied',
          strategy: 'prompt',
          status: 'done',
          startedAt: 2,
          finishedAt: 3,
          application: { kind: 'applied' },
          reasoningEnvelope: applied,
          usage: {
            prompt_tokens: 0,
            completion_tokens: 30,
            total_tokens: 30,
            completion_tokens_details: { reasoning_tokens: 30 },
          },
          reasoningCarryForward: 'carrier',
          reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
        },
        {
          streamId: 'unapplied',
          strategy: 'prompt',
          status: 'done',
          startedAt: 4,
          finishedAt: 5,
          application: { kind: 'unapplied', reason: 'base-version-changed' },
          reasoningEnvelope: applied,
          reasoningCarryForward: 'carrier',
          reasoningVisibility: { disclosure: 'visible', visibleKind: 'summary' },
        },
      ],
    }
    expect(
      estimateReasoningEchoTokens(
        [message],
        opts({ encrypted: true, summary: false, text: false }),
      ),
    ).toBe(70)
  })
})

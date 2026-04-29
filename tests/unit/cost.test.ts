import { describe, expect, it } from 'vitest'
import {
  aggregateChatCost,
  emptyUsage,
  normalizeChatUsage,
  normalizeResponsesUsage,
  type ResponsesUsage,
} from '../../src/core/cost'
import type { ChatUsage, Message } from '../../src/core/types'

function buildAssistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? '01J0000000000000000000000A',
    chatId: 'chat1',
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn1',
    turnIndex: 1,
    createdAt: 1_700_000_000_000,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'text', text: 'hi' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

describe('normalizeChatUsage (chat-completions shape)', () => {
  it('normalizes the full usage object', () => {
    const u: ChatUsage = {
      prompt_tokens: 100,
      completion_tokens: 200,
      total_tokens: 300,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 50 },
      cache_creation_input_tokens: 20,
      cost: 0.0042,
    }
    expect(normalizeChatUsage(u)).toEqual({
      promptTokens: 100,
      completionTokens: 200,
      totalTokens: 300,
      reasoningTokens: 50,
      cachedTokens: 40,
      cacheCreationTokens: 20,
      cost: 0.0042,
    })
  })

  it('coerces missing sub-fields to 0', () => {
    const u: ChatUsage = {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    }
    expect(normalizeChatUsage(u)).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      cost: 0,
    })
  })

  it('returns zero usage for null/undefined', () => {
    expect(normalizeChatUsage(null)).toEqual(emptyUsage())
    expect(normalizeChatUsage(undefined)).toEqual(emptyUsage())
  })
})

describe('normalizeResponsesUsage (Responses API shape)', () => {
  it('normalizes input_tokens / output_tokens / total_tokens', () => {
    const u: ResponsesUsage = {
      input_tokens: 15,
      output_tokens: 85,
      total_tokens: 100,
    }
    expect(normalizeResponsesUsage(u)).toEqual({
      promptTokens: 15,
      completionTokens: 85,
      totalTokens: 100,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      cost: 0,
    })
  })

  it('pulls reasoning_tokens out of output_tokens_details', () => {
    const u: ResponsesUsage = {
      input_tokens: 15,
      output_tokens: 85,
      total_tokens: 100,
      output_tokens_details: { reasoning_tokens: 45 },
    }
    expect(normalizeResponsesUsage(u).reasoningTokens).toBe(45)
  })

  it('pulls cached_tokens out of input_tokens_details', () => {
    const u: ResponsesUsage = {
      input_tokens: 1024,
      output_tokens: 10,
      total_tokens: 1034,
      input_tokens_details: { cached_tokens: 800 },
    }
    expect(normalizeResponsesUsage(u).cachedTokens).toBe(800)
  })

  it('uses the authoritative cost when present', () => {
    const u: ResponsesUsage = {
      input_tokens: 10,
      output_tokens: 10,
      total_tokens: 20,
      cost: 0.0015,
    }
    expect(normalizeResponsesUsage(u).cost).toBe(0.0015)
  })

  it('returns zero usage for null/undefined', () => {
    expect(normalizeResponsesUsage(null)).toEqual(emptyUsage())
    expect(normalizeResponsesUsage(undefined)).toEqual(emptyUsage())
  })
})

describe('normalizeChatUsage — robustness guards', () => {
  it('coerces negative token fields to 0', () => {
    const u: ChatUsage = {
      prompt_tokens: -500,
      completion_tokens: 200,
      total_tokens: 300,
    }
    const n = normalizeChatUsage(u)
    expect(n.promptTokens).toBe(0)
    expect(n.completionTokens).toBe(200)
  })

  it('coerces NaN/Infinity token fields to 0', () => {
    const u: ChatUsage = {
      prompt_tokens: Number.NaN,
      completion_tokens: Number.POSITIVE_INFINITY,
      total_tokens: 300,
    }
    const n = normalizeChatUsage(u)
    expect(n.promptTokens).toBe(0)
    expect(n.completionTokens).toBe(0)
    expect(Number.isFinite(n.totalTokens)).toBe(true)
  })

  it('caps gigantic token fields at MAX_PLAUSIBLE_TOKENS', () => {
    const u: ChatUsage = {
      prompt_tokens: 1e12,
      completion_tokens: 10,
      total_tokens: 1e12,
    }
    const n = normalizeChatUsage(u)
    expect(n.promptTokens).toBeLessThanOrEqual(100_000_000)
    expect(n.totalTokens).toBeLessThanOrEqual(100_000_000)
  })

  it('rejects negative and NaN cost', () => {
    const u1 = normalizeChatUsage({
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      cost: -1,
    })
    const u2 = normalizeChatUsage({
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
      cost: Number.NaN,
    })
    expect(u1.cost).toBe(0)
    expect(u2.cost).toBe(0)
  })
})

describe('normalizeResponsesUsage — robustness guards', () => {
  it('coerces negative / NaN / Infinity token fields to 0', () => {
    const u: ResponsesUsage = {
      input_tokens: -100,
      output_tokens: Number.NaN,
      total_tokens: Number.POSITIVE_INFINITY,
    }
    const n = normalizeResponsesUsage(u)
    expect(n.promptTokens).toBe(0)
    expect(n.completionTokens).toBe(0)
    expect(n.totalTokens).toBe(0)
  })
})

describe('aggregateChatCost', () => {
  it('sums generation.cost across non-deleted messages', () => {
    const messages: Message[] = [
      buildAssistantMessage({
        id: '01J0000000000000000000000A',
        generation: {
          id: 'g1',
          model: 'openai/gpt-5.2',
          requestedModel: 'openai/gpt-5.2',
          apiUsed: 'chat',
          delivery: 'streaming',
          cost: 0.001,
          costSource: 'stream',
          startedAt: 1,
        },
      }),
      buildAssistantMessage({
        id: '01J0000000000000000000000B',
        generation: {
          id: 'g2',
          model: 'openai/gpt-5.2',
          requestedModel: 'openai/gpt-5.2',
          apiUsed: 'chat',
          delivery: 'streaming',
          cost: 0.002,
          costSource: 'stream',
          startedAt: 2,
        },
      }),
    ]
    expect(aggregateChatCost(messages)).toBeCloseTo(0.003, 10)
  })

  it('ignores deleted (tombstoned) messages', () => {
    const messages: Message[] = [
      buildAssistantMessage({
        id: '01J0000000000000000000000A',
        deleted: true,
        generation: {
          id: 'g1',
          model: 'openai/gpt-5.2',
          requestedModel: 'openai/gpt-5.2',
          apiUsed: 'chat',
          delivery: 'streaming',
          cost: 0.1,
          costSource: 'stream',
          startedAt: 1,
        },
      }),
      buildAssistantMessage({
        id: '01J0000000000000000000000B',
        generation: {
          id: 'g2',
          model: 'openai/gpt-5.2',
          requestedModel: 'openai/gpt-5.2',
          apiUsed: 'chat',
          delivery: 'streaming',
          cost: 0.002,
          costSource: 'stream',
          startedAt: 2,
        },
      }),
    ]
    expect(aggregateChatCost(messages)).toBeCloseTo(0.002, 10)
  })

  it('treats messages without generation as contributing 0', () => {
    const messages: Message[] = [
      buildAssistantMessage({ id: '01J0000000000000000000000A' }),
      buildAssistantMessage({
        id: '01J0000000000000000000000B',
        role: 'user',
        origin: 'user',
      }),
    ]
    expect(aggregateChatCost(messages)).toBe(0)
  })

  it('returns 0 on an empty message list', () => {
    expect(aggregateChatCost([])).toBe(0)
  })

  it('ignores non-finite or NaN cost values', () => {
    const messages: Message[] = [
      buildAssistantMessage({
        id: '01J0000000000000000000000A',
        generation: {
          id: 'g1',
          model: 'openai/gpt-5.2',
          requestedModel: 'openai/gpt-5.2',
          apiUsed: 'chat',
          delivery: 'streaming',
          cost: Number.NaN,
          costSource: 'stream',
          startedAt: 1,
        },
      }),
      buildAssistantMessage({
        id: '01J0000000000000000000000B',
        generation: {
          id: 'g2',
          model: 'openai/gpt-5.2',
          requestedModel: 'openai/gpt-5.2',
          apiUsed: 'chat',
          delivery: 'streaming',
          cost: Number.POSITIVE_INFINITY,
          costSource: 'stream',
          startedAt: 2,
        },
      }),
      buildAssistantMessage({
        id: '01J0000000000000000000000C',
        generation: {
          id: 'g3',
          model: 'openai/gpt-5.2',
          requestedModel: 'openai/gpt-5.2',
          apiUsed: 'chat',
          delivery: 'streaming',
          cost: 0.005,
          costSource: 'stream',
          startedAt: 3,
        },
      }),
    ]
    expect(aggregateChatCost(messages)).toBeCloseTo(0.005, 10)
  })
})

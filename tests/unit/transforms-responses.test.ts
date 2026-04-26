// Phase 11: `toResponses` transform tests. See `plan/phase11-implementation.md §4.5`.

import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { toResponses } from '../../src/core/transforms'
import type {
  ChatSettings,
  Message,
  ReasoningDetail,
  ReasoningInclude,
  ResponsesOutputItem,
  ToolCall,
} from '../../src/core/types'

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.profileId = 'p'
  s.model = 'openai/gpt-5.4-nano'
  s.systemPrompt = ''
  s.reasoning = {
    mode: 'off',
    exclude: false,
    summary: 'off',
    include: { encrypted: true, summary: false, text: false },
  }
  return { ...s, ...overrides }
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

function assistant(id: string, text: string, opts: Partial<Message> = {}): Message {
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
    nodeVersion: 0,
    deleted: false,
    ...opts,
  }
}

describe('toResponses — envelope', () => {
  it('plain user prompt → input: [{type:"message", role:"user", content:[input_text]}]', () => {
    const { wire, requestedModel } = toResponses(settings(), [user('u1', 'hi')])
    expect(requestedModel).toBe('openai/gpt-5.4-nano')
    expect(wire.model).toBe('openai/gpt-5.4-nano')
    expect(wire.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
    ])
    expect(wire.stream).toBe(true)
    expect(wire.store).toBe(false)
  })

  it("imports system prompt into `instructions`", () => {
    const s = settings({ systemPrompt: 'Be brief.' })
    const { wire } = toResponses(s, [user('u1', 'hi')])
    expect(wire.instructions).toBe('Be brief.')
  })

  it("prefers an inline system message over `settings.systemPrompt`", () => {
    const imported: Message = {
      ...user('s1', 'You are helpful.'),
      role: 'system',
    }
    const { wire } = toResponses(settings({ systemPrompt: 'override me' }), [
      imported,
      user('u1', 'hi'),
    ])
    expect(wire.instructions).toBe('You are helpful.')
  })

  it('does not enable hosted tools for image-capable models unless tool settings say so', () => {
    const { wire } = toResponses(
      settings({
        model: 'openai/gpt-5-image-mini',
        modalities: ['image', 'text'],
      }),
      [user('u1', 'draw a red square')],
    )
    expect(wire.tools).toBeUndefined()
    expect(wire.tool_choice).toBeUndefined()
    expect(wire.parallel_tool_calls).toBeUndefined()
  })
})

describe('toResponses — reasoning echo', () => {
  it('emits responsesEchoItem verbatim when include flags allow (encrypted + summary)', () => {
    const echo: ResponsesOutputItem = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'gAAA...blob',
      summary: [{ type: 'summary_text', text: 'I thought about X' }],
    }
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', { responsesEchoItem: echo }),
      user('u2', 'follow'),
    ]
    // Enable BOTH summary + encrypted so the echo rides through unchanged.
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: true, summary: true, text: false },
        },
      }),
      path,
    )
    const items = wire.input as Array<{ type: string; [k: string]: unknown }>
    const reasoningItem = items.find((i) => i.type === 'reasoning')
    expect(reasoningItem).toEqual(echo)
  })

  it('drops naked reasoning item when stripping leaves no carrier fields', () => {
    // With include.encrypted=false and no `summary` on the echo item,
    // stripping leaves `{type:'reasoning', id}` — an empty envelope the
    // next turn cannot use. We drop instead of sending it.
    const echo: ResponsesOutputItem = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'gAAA...blob',
    }
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', { responsesEchoItem: echo }),
    ]
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: true, text: false } as ReasoningInclude,
        },
      }),
      path,
    )
    const items = wire.input as Array<{ type: string; [k: string]: unknown }>
    const reasoningItem = items.find((i) => i.type === 'reasoning')
    expect(reasoningItem).toBeUndefined()
  })

  it('keeps echo item when summary survives stripping (include.summary = true)', () => {
    const echo: ResponsesOutputItem = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'gAAA...blob',
      summary: [{ type: 'summary_text', text: 'visible reasoning' }],
    }
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', { responsesEchoItem: echo }),
    ]
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: true, text: false } as ReasoningInclude,
        },
      }),
      path,
    )
    const items = wire.input as Array<{ type: string; [k: string]: unknown }>
    const reasoningItem = items.find((i) => i.type === 'reasoning') as {
      encrypted_content?: string
      summary?: unknown[]
    } | undefined
    expect(reasoningItem).toBeDefined()
    expect(reasoningItem?.encrypted_content).toBeUndefined()
    expect(reasoningItem?.summary).toHaveLength(1)
  })

  it('synthesizes reasoning item from reasoningDetails when responsesEchoItem is absent', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.encrypted', id: 'r_e', data: 'blob', format: 'openai-responses-v1' },
      { type: 'reasoning.summary', id: 'r_s', summary: 'quick summary' },
    ]
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', { reasoningDetails: details }),
      user('u2', 'followup'),
    ]
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: true, summary: true, text: false } as ReasoningInclude,
        },
      }),
      path,
      { reasoningPreservationFormat: 'openai-responses-v1' },
    )
    const items = wire.input as Array<{ type: string; [k: string]: unknown }>
    const reasoning = items.find((i) => i.type === 'reasoning') as
      | { type: string; encrypted_content?: string; summary?: unknown[] }
      | undefined
    expect(reasoning?.encrypted_content).toBe('blob')
    expect(reasoning?.summary).toEqual([{ type: 'summary_text', text: 'quick summary' }])
  })

  it('drops the synthesized reasoning item when all include flags are false', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.encrypted', id: 'r_e', data: 'blob', format: 'openai-responses-v1' },
    ]
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', { reasoningDetails: details }),
    ]
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false } as ReasoningInclude,
        },
      }),
      path,
      { reasoningPreservationFormat: 'openai-responses-v1' },
    )
    const items = wire.input as Array<{ type: string }>
    expect(items.find((i) => i.type === 'reasoning')).toBeUndefined()
  })
})

describe('toResponses — phase round-trip', () => {
  it('preserves `phase` on synthesized message items', () => {
    const path: Message[] = [
      user('u1', 'q'),
      { ...assistant('a1', 'answer'), phase: 'final_answer' },
    ]
    const { wire } = toResponses(settings(), path)
    const items = wire.input as Array<{ type: string; role?: string; phase?: string }>
    const assistantMsg = items.find((i) => i.type === 'message' && i.role === 'assistant')
    expect(assistantMsg?.phase).toBe('final_answer')
  })
})

describe('toResponses — gpt54SamplingGate', () => {
  it('strips temperature/top_p/logprobs when effort != none on gpt-5.4', () => {
    const s = settings({
      sampling: { temperature: 0.7, top_p: 0.9, logprobs: 1 },
      reasoning: {
        mode: 'enabled',
        effort: 'medium',
        exclude: false,
        summary: 'off',
        include: { encrypted: true, summary: false, text: false } as ReasoningInclude,
      },
    })
    const { wire } = toResponses(s, [user('u1', 'hi')])
    expect(wire.temperature).toBeUndefined()
    expect(wire.top_p).toBeUndefined()
    expect(wire.logprobs).toBeUndefined()
    expect(wire.reasoning).toMatchObject({ effort: 'medium' })
  })

  it('keeps sampling when effort: "none"', () => {
    const s = settings({
      sampling: { temperature: 0.5, top_p: 0.8 },
      reasoning: {
        mode: 'enabled',
        effort: 'none',
        exclude: false,
        summary: 'off',
        include: { encrypted: true, summary: false, text: false } as ReasoningInclude,
      },
    })
    const { wire } = toResponses(s, [user('u1', 'hi')])
    expect(wire.temperature).toBe(0.5)
    expect(wire.top_p).toBe(0.8)
  })
})

describe('toResponses — include header', () => {
  it('adds `include: ["reasoning.encrypted_content"]` when encrypted carry-forward is on', () => {
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'enabled',
          effort: 'low',
          exclude: false,
          summary: 'off',
          include: { encrypted: true, summary: false, text: false },
        },
      }),
      [user('u1', 'hi')],
      { reasoningPreservationFormat: 'openai-responses-v1' },
    )
    expect(wire.include).toEqual(['reasoning.encrypted_content'])
  })

  it('omits include when reasoning.include.encrypted is false', () => {
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'enabled',
          effort: 'low',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
      [user('u1', 'hi')],
      { reasoningPreservationFormat: 'openai-responses-v1' },
    )
    expect(wire.include).toBeUndefined()
  })

  it('respects responses.includeEncrypted override', () => {
    const { wire } = toResponses(
      settings({
        responses: { includeEncrypted: false, store: false },
        reasoning: {
          mode: 'enabled',
          effort: 'low',
          exclude: false,
          summary: 'off',
          include: { encrypted: true, summary: false, text: false },
        },
      }),
      [user('u1', 'hi')],
      { reasoningPreservationFormat: 'openai-responses-v1' },
    )
    expect(wire.include).toBeUndefined()
  })
})

describe('toResponses — tool calls + tool outputs', () => {
  it('assistant tool calls → function_call items', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
    ]
    const path: Message[] = [
      user('u1', 'search'),
      assistant('a1', '', { toolCalls }),
    ]
    const { wire } = toResponses(settings(), path)
    const items = wire.input as Array<{ type: string; [k: string]: unknown }>
    const call = items.find((i) => i.type === 'function_call')
    expect(call).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'search',
      arguments: '{"q":"x"}',
    })
  })

  it('tool role message → function_call_output', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_9', type: 'function', function: { name: 'f', arguments: '{}' } },
    ]
    const toolMsg: Message = {
      id: 't1',
      chatId: 'c',
      parentId: null,
      siblingIndex: 0,
      turnId: 't1-t',
      turnIndex: 0,
      createdAt: 1,
      role: 'tool',
      origin: 'generated',
      content: [{ type: 'text', text: 'search returned 42' }],
      toolCalls,
      nodeVersion: 0,
      deleted: false,
    }
    const { wire } = toResponses(settings(), [user('u1', 'q'), toolMsg])
    const items = wire.input as Array<{ type: string; [k: string]: unknown }>
    expect(items[1]).toEqual({
      type: 'function_call_output',
      call_id: 'call_9',
      output: 'search returned 42',
    })
  })
})

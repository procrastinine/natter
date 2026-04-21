// Phase 11: `toGeminiNative` transform tests. See `plan/phase11-implementation.md §4.5`.
//
// Verified against `gemini_docs/` and live probes (Gemini 3.1 confirms
// `thought: true` summary parts AND a final-part `thoughtSignature` can
// coexist in the same response).

import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { toGeminiNative } from '../../src/core/transforms'
import type {
  ChatSettings,
  Message,
  ReasoningDetail,
  ReasoningInclude,
  ToolCall,
} from '../../src/core/types'

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.profileId = 'p'
  s.model = 'google/gemini-3.1-flash-lite-preview'
  s.reasoning = {
    mode: 'off',
    exclude: false,
    summary: 'auto',
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

describe('toGeminiNative — envelope + URL', () => {
  it('strips provider prefix from the modelId', () => {
    const { modelId, requestedModel } = toGeminiNative(settings(), [user('u1', 'hi')])
    expect(modelId).toBe('gemini-3.1-flash-lite-preview')
    expect(requestedModel).toBe('google/gemini-3.1-flash-lite-preview')
  })

  it('plain user prompt → contents: [{role:"user", parts:[{text}]}]', () => {
    const { wire } = toGeminiNative(settings(), [user('u1', 'hi')])
    expect(wire.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('moves first system message into systemInstruction', () => {
    const system: Message = { ...user('s1', 'Be helpful.'), role: 'system' }
    const { wire } = toGeminiNative(settings(), [system, user('u1', 'hi')])
    expect(wire.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: 'Be helpful.' }],
    })
    // System message NOT in contents[]
    expect(wire.contents).toHaveLength(1)
    expect(wire.contents[0]?.role).toBe('user')
  })

  it('uses settings.systemPrompt when no imported system message', () => {
    const s = settings({ systemPrompt: 'You are a calculator.' })
    const { wire } = toGeminiNative(s, [user('u1', 'hi')])
    expect(wire.systemInstruction?.parts[0]).toEqual({ text: 'You are a calculator.' })
  })
})

describe('toGeminiNative — thinkingConfig (Gemini 3)', () => {
  it('maps effort → thinkingLevel on Gemini 3.x', () => {
    const cases: Array<[NonNullable<ChatSettings['reasoning']['effort']>, 'minimal' | 'low' | 'medium' | 'high']> = [
      ['none', 'minimal'],
      ['minimal', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'high'], // clamped
    ]
    for (const [effort, expected] of cases) {
      const { wire } = toGeminiNative(
        settings({
          reasoning: {
            mode: 'enabled',
            effort,
            exclude: false,
            summary: 'off',
            include: { encrypted: true, summary: false, text: false },
          },
        }),
        [user('u1', 'hi')],
      )
      expect(wire.generationConfig?.thinkingConfig?.thinkingLevel).toBe(expected)
    }
  })

  it('mode:"off" → thinkingLevel:"minimal" on Gemini 3', () => {
    const { wire } = toGeminiNative(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
      [user('u1', 'hi')],
    )
    expect(wire.generationConfig?.thinkingConfig?.thinkingLevel).toBe('minimal')
  })

  it("settings.reasoning.summary !== 'off' → includeThoughts:true", () => {
    const { wire } = toGeminiNative(
      settings({
        reasoning: {
          mode: 'enabled',
          effort: 'medium',
          exclude: false,
          summary: 'detailed',
          include: { encrypted: true, summary: false, text: false },
        },
      }),
      [user('u1', 'hi')],
    )
    expect(wire.generationConfig?.thinkingConfig?.includeThoughts).toBe(true)
  })

  it("summary:'off' → no includeThoughts", () => {
    const { wire } = toGeminiNative(
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
    )
    expect(wire.generationConfig?.thinkingConfig?.includeThoughts).toBeUndefined()
  })
})

describe('toGeminiNative — thinkingConfig (Gemini 2.5)', () => {
  function g25(): ChatSettings {
    return { ...settings(), model: 'google/gemini-2.5-flash' }
  }

  it('maps effort → thinkingBudget (integer)', () => {
    // Per Google's Vertex thinking docs: gemini-2.5-flash supports budgets
    // 0..24576. `xhigh` uses the model's max (24576) rather than our old
    // conservative 8192 cap. `none` = 0 is valid only on flash (not
    // pro/flash-lite).
    const cases: Array<[NonNullable<ChatSettings['reasoning']['effort']>, number]> = [
      ['minimal', 128],
      ['low', 512],
      ['medium', 2048],
      ['high', 8192],
      ['xhigh', 24576],
      ['none', 0],
    ]
    for (const [effort, expected] of cases) {
      const { wire } = toGeminiNative(
        { ...g25(), reasoning: { mode: 'enabled', effort, exclude: false, summary: 'off', include: { encrypted: true, summary: false, text: false } } },
        [user('u1', 'hi')],
      )
      expect(wire.generationConfig?.thinkingConfig?.thinkingBudget).toBe(expected)
      expect(wire.generationConfig?.thinkingConfig?.thinkingLevel).toBeUndefined()
    }
  })

  it('explicit maxTokens overrides effort-derived budget', () => {
    const { wire } = toGeminiNative(
      {
        ...g25(),
        reasoning: {
          mode: 'default', // not enabled — skip effort mapping path
          exclude: false,
          summary: 'off',
          maxTokens: 1024,
          include: { encrypted: true, summary: false, text: false },
        },
      },
      [user('u1', 'hi')],
    )
    expect(wire.generationConfig?.thinkingConfig?.thinkingBudget).toBe(1024)
  })
})

describe('toGeminiNative — reasoning echo (thoughtSignature on LAST part)', () => {
  it('attaches thoughtSignature to the last assistant part when include.encrypted', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.encrypted', id: 'r_e', data: 'SIG_BLOB', format: 'google-gemini-v1' },
    ]
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'The answer is 42.', { reasoningDetails: details }),
      user('u2', 'follow'),
    ]
    const { wire } = toGeminiNative(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: true, summary: false, text: false },
        },
      }),
      path,
    )
    // contents[0] = user, contents[1] = model, contents[2] = user follow-up
    expect(wire.contents).toHaveLength(3)
    const modelTurn = wire.contents[1]!
    expect(modelTurn.role).toBe('model')
    const lastPart = modelTurn.parts[modelTurn.parts.length - 1]! as { text?: string; thoughtSignature?: string }
    expect(lastPart.thoughtSignature).toBe('SIG_BLOB')
    expect(lastPart.text).toBe('The answer is 42.')
  })

  it('drops signature when include.encrypted is false', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.encrypted', id: 'r_e', data: 'SIG_BLOB', format: 'google-gemini-v1' },
    ]
    const path: Message[] = [user('u1', 'q'), assistant('a1', 'answer', { reasoningDetails: details })]
    const { wire } = toGeminiNative(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
      path,
    )
    const modelTurn = wire.contents[1]!
    const lastPart = modelTurn.parts[modelTurn.parts.length - 1]! as { thoughtSignature?: string }
    expect(lastPart.thoughtSignature).toBeUndefined()
  })

  it('drops signature when format mismatch', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.encrypted', id: 'r_e', data: 'SIG_BLOB', format: 'openai-responses-v1' },
    ]
    const path: Message[] = [user('u1', 'q'), assistant('a1', 'answer', { reasoningDetails: details })]
    const { wire } = toGeminiNative(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: true, summary: false, text: false },
        },
      }),
      path,
    )
    const modelTurn = wire.contents[1]!
    const lastPart = modelTurn.parts[modelTurn.parts.length - 1]! as { thoughtSignature?: string }
    // Format mismatch → preservation format is google-gemini-v1 (from quirks),
    // but the stored detail is openai-responses-v1 → skip the attach.
    expect(lastPart.thoughtSignature).toBeUndefined()
  })

  it('emits thought:true summary parts when include.summary is on', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', id: 'r_s', summary: 'I was thinking about X.' },
    ]
    const path: Message[] = [user('u1', 'q'), assistant('a1', 'answer', { reasoningDetails: details })]
    const { wire } = toGeminiNative(
      settings({
        reasoning: {
          mode: 'enabled',
          effort: 'low',
          exclude: false,
          summary: 'auto',
          include: { encrypted: false, summary: true, text: false } as ReasoningInclude,
        },
      }),
      path,
    )
    const modelTurn = wire.contents[1]!
    expect(modelTurn.parts).toEqual([
      { text: 'I was thinking about X.', thought: true },
      { text: 'answer' },
    ])
  })

  it('emits thought:true text parts for OpenRouter-repackaged Gemini summary (reasoning.text) when include.text', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.text',
        id: 'r_t',
        format: 'google-gemini-v1',
        text: 'Summary of thinking',
      },
    ]
    const path: Message[] = [user('u1', 'q'), assistant('a1', 'answer', { reasoningDetails: details })]
    const { wire } = toGeminiNative(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: true } as ReasoningInclude,
        },
      }),
      path,
    )
    const modelTurn = wire.contents[1]!
    expect(modelTurn.parts[0]).toEqual({ text: 'Summary of thinking', thought: true })
  })
})

describe('toGeminiNative — tool calls + tool results', () => {
  it('assistant toolCalls → functionCall parts with parsed args', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"consecutive"}' },
      },
    ]
    const path: Message[] = [user('u1', 'search'), assistant('a1', '', { toolCalls })]
    const { wire } = toGeminiNative(settings(), path)
    const model = wire.contents[1]!
    expect(model.parts).toEqual([
      {
        functionCall: { name: 'search', args: { q: 'consecutive' }, id: 'call_1' },
      },
    ])
  })

  it('tool message → {role:"user", parts:[{functionResponse}]}', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_9', type: 'function', function: { name: 'calc', arguments: '{}' } },
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
      content: [{ type: 'text', text: '{"result":42}' }],
      toolCalls,
      nodeVersion: 0,
      deleted: false,
    }
    const { wire } = toGeminiNative(settings(), [user('u1', 'q'), toolMsg])
    expect(wire.contents[1]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'calc',
            response: { result: 42 },
            id: 'call_9',
          },
        },
      ],
    })
  })
})

describe('toGeminiNative — response format', () => {
  it('json_object → responseMimeType: application/json', () => {
    const { wire } = toGeminiNative(
      settings({ responseFormat: { type: 'json_object' } }),
      [user('u1', 'hi')],
    )
    expect(wire.generationConfig?.responseMimeType).toBe('application/json')
  })

  it('json_schema → responseJsonSchema', () => {
    const schema = { type: 'object', properties: { x: { type: 'number' } } }
    const { wire } = toGeminiNative(
      settings({
        responseFormat: {
          type: 'json_schema',
          jsonSchema: { name: 'x', schema },
        },
      }),
      [user('u1', 'hi')],
    )
    expect(wire.generationConfig?.responseJsonSchema).toEqual(schema)
  })
})

describe('toGeminiNative — sampling + stops + cachedContent', () => {
  it('temperature/topP/topK map camelCase', () => {
    const { wire } = toGeminiNative(
      settings({ sampling: { temperature: 0.5, top_p: 0.9, top_k: 50 } }),
      [user('u1', 'hi')],
    )
    expect(wire.generationConfig?.temperature).toBe(0.5)
    expect(wire.generationConfig?.topP).toBe(0.9)
    expect(wire.generationConfig?.topK).toBe(50)
  })

  it('stop[] → stopSequences', () => {
    const { wire } = toGeminiNative(
      settings({ stop: ['STOP1', 'STOP2'] }),
      [user('u1', 'hi')],
    )
    expect(wire.generationConfig?.stopSequences).toEqual(['STOP1', 'STOP2'])
  })

  it('gemini.cachedContentName → wire.cachedContent', () => {
    const { wire } = toGeminiNative(
      settings({ gemini: { cachedContentName: 'cachedContents/abc123' } }),
      [user('u1', 'hi')],
    )
    expect(wire.cachedContent).toBe('cachedContents/abc123')
  })
})

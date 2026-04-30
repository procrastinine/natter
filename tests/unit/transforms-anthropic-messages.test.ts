import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { toAnthropicMessages } from '../../src/core/transforms'
import type { ChatSettings, Message } from '../../src/core/types'

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.profileId = 'p'
  s.model = 'anthropic/claude-haiku-4.5'
  s.maxCompletionTokens = 80
  s.reasoning = {
    mode: 'off',
    exclude: false,
    summary: 'auto',
    include: { encrypted: true, summary: false, text: false },
  }
  return { ...s, ...overrides }
}

function anthropicTools(
  anthropic: Partial<ChatSettings['tools']['anthropic']>,
): Pick<ChatSettings, 'tools'> {
  const tools = cloneDefaultChatSettings().tools
  return { tools: { ...tools, anthropic: { ...tools.anthropic, ...anthropic } } }
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
    content: [{ type: 'output_text', text }],
    nodeVersion: 0,
    deleted: false,
    ...opts,
  }
}

describe('toAnthropicMessages', () => {
  it('normalizes provider-prefixed dotted Claude ids to Messages model ids', () => {
    const { modelId, requestedModel, wire } = toAnthropicMessages(settings(), [user('u1', 'hi')])
    expect(modelId).toBe('claude-haiku-4-5')
    expect(requestedModel).toBe('anthropic/claude-haiku-4.5')
    expect(wire.model).toBe('claude-haiku-4-5')
  })

  it('moves system/developer text to top-level system and serializes user content blocks', () => {
    const system = { ...user('s1', 'Be terse.'), role: 'system' as const }
    const { wire } = toAnthropicMessages(settings(), [system, user('u1', 'Hello')])
    expect(wire.system).toBe('Be terse.')
    expect(wire.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }])
  })

  it('emits Anthropic hosted tool definitions only for the Anthropic provider', () => {
    const s = settings({
      ...anthropicTools({
        enabledServerToolIds: ['web-search', 'web-fetch', 'code-execution', 'advisor'],
        toolChoice: { type: 'function', function: { name: 'web_search' } },
        config: {
          'web-search': { maxUses: 2, allowedDomains: ['example.com'] },
          'web-fetch': { citationsEnabled: true, maxContentTokens: 1200 },
          'code-execution': { version: 'code_execution_20250825' },
          advisor: { advisorModel: 'claude-opus-4-7' },
        },
      }),
    })
    expect(toAnthropicMessages(s, [user('u1', 'hi')]).wire.tools).toBeUndefined()

    const { wire } = toAnthropicMessages(s, [user('u1', 'hi')], {
      hostedToolsProvider: 'anthropic',
    })
    expect(wire.tools).toEqual([
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 2,
        allowed_domains: ['example.com'],
      },
      {
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        citations: { enabled: true },
        max_content_tokens: 1200,
      },
      { type: 'code_execution_20250825', name: 'code_execution' },
      { type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-7' },
    ])
    expect(wire.tool_choice).toEqual({ type: 'tool', name: 'web_search' })
  })

  it('replays native Anthropic tool blocks and textifies unsupported provider evidence', () => {
    const prior = assistant('a1', 'I searched.', {
      providerOutputItems: [
        {
          dialect: 'anthropic-claude',
          type: 'server_tool_use',
          item: {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'docs' },
          },
        },
        {
          dialect: 'google-gemini',
          type: 'google:code_execution',
          item: { executableCode: { language: 'PYTHON', code: 'print(5)' } },
        },
      ],
    })

    const { wire } = toAnthropicMessages(settings(), [prior, user('u2', 'continue')], {
      reasoningPreservationFormat: 'anthropic-claude-v1',
    })
    expect(wire.messages[0]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'docs' },
        },
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('<tool_call>'),
        }),
      ],
    })
    expect(JSON.stringify(wire)).toContain('Dialect: google-gemini')
  })

  it('round-trips signed Claude thinking as a native thinking block', () => {
    const prior = assistant('a1', 'Answer.', {
      reasoningDetails: [
        {
          type: 'reasoning.text',
          format: 'anthropic-claude-v1',
          text: 'signed thought',
          signature: 'sig-blob',
        },
      ],
    })
    const { wire } = toAnthropicMessages(settings(), [prior], {
      reasoningPreservationFormat: 'anthropic-claude-v1',
    })
    expect(wire.messages[0]?.content).toEqual([
      { type: 'thinking', thinking: 'signed thought', signature: 'sig-blob' },
      { type: 'text', text: 'Answer.' },
    ])
  })
})

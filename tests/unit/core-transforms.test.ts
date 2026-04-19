import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { buildChatMessages, toChatCompletions } from '../../src/core/transforms'
import type { CapabilityDescriptor, ChatSettings, Message, MessageRole } from '../../src/core/types'

function textMessage(
  overrides: Partial<Message> & { id: string; role: MessageRole; text: string },
): Message {
  return {
    id: overrides.id,
    chatId: 'c',
    parentId: overrides.parentId ?? null,
    siblingIndex: 0,
    turnId: overrides.turnId ?? `${overrides.id}-turn`,
    turnIndex: 0,
    createdAt: overrides.createdAt ?? 1,
    role: overrides.role,
    origin: overrides.origin ?? 'user',
    content: [{ type: 'text', text: overrides.text }],
    nodeVersion: 0,
    deleted: overrides.deleted ?? false,
    ...(overrides.hiddenFromContext !== undefined
      ? { hiddenFromContext: overrides.hiddenFromContext }
      : {}),
  }
}

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const base = cloneDefaultChatSettings()
  return {
    ...base,
    profileId: 'prof',
    model: 'anthropic/claude-haiku-4.5',
    reasoning: { mode: 'off', exclude: false, summary: 'off', carryForward: 'off' },
    ...overrides,
  }
}

describe('toChatCompletions', () => {
  it('plain text conversation — envelope + messages + stream', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    const { wire, requestedModel } = toChatCompletions(settings(), path)
    expect(wire.model).toBe('anthropic/claude-haiku-4.5')
    expect(wire.stream).toBe(true)
    expect(wire.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(requestedModel).toBe('anthropic/claude-haiku-4.5')
    // Reasoning.mode === 'off' emits an explicit enabled:false object so Claude
    // 4.x provider doesn't default-enable reasoning.
    expect(wire.reasoning).toEqual({ enabled: false })
  })

  it('prepends the system prompt when non-empty and absent from the path', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hello' })]
    const { wire } = toChatCompletions(settings({ systemPrompt: 'Be concise.' }), path)
    expect(wire.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'hello' },
    ])
  })

  it('does not duplicate the system prompt when the path already has one', () => {
    const path = [
      textMessage({ id: 's1', role: 'system', text: 'imported system' }),
      textMessage({ id: 'u1', role: 'user', text: 'hi' }),
    ]
    const { wire } = toChatCompletions(settings({ systemPrompt: 'Would-be system' }), path)
    expect(wire.messages).toEqual([
      { role: 'system', content: 'imported system' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('includes stop sequences and sampling when capabilities permit', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    const caps: CapabilityDescriptor = {
      supportedParameters: ['temperature', 'top_p', 'stop'],
      streaming: 'supported',
    }
    const { wire } = toChatCompletions(
      settings({
        stop: ['\n\n'],
        sampling: { temperature: 0.7, top_p: 0.9, frequency_penalty: 0.2 },
      }),
      path,
      { capabilities: caps },
    )
    expect(wire.temperature).toBe(0.7)
    expect(wire.top_p).toBe(0.9)
    // frequency_penalty wasn't in supported_parameters → gated out.
    expect(wire.frequency_penalty).toBeUndefined()
    expect(wire.stop).toEqual(['\n\n'])
  })

  it('never drops envelope fields even when supported_parameters is narrow', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    // Empty capabilities set — gate denies everything optional, but envelope
    // fields (model/messages/stream) must still be present.
    const caps: CapabilityDescriptor = {
      supportedParameters: [],
      streaming: 'supported',
    }
    const { wire } = toChatCompletions(
      settings({
        stop: ['stop'],
        sampling: { temperature: 0.5 },
        maxCompletionTokens: 128,
        logitBias: { '42': 5 },
        modalities: ['text'],
      }),
      path,
      { capabilities: caps },
    )
    expect(wire.model).toBe('anthropic/claude-haiku-4.5')
    expect(Array.isArray(wire.messages)).toBe(true)
    expect(wire.stream).toBe(true)
    expect(wire.temperature).toBeUndefined()
    expect(wire.stop).toBeUndefined()
    expect(wire.max_completion_tokens).toBeUndefined()
    expect(wire.logit_bias).toBeUndefined()
    expect(wire.modalities).toBeUndefined()
  })

  it('respects reasoning.mode=off (emits enabled:false)', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    const { wire } = toChatCompletions(
      settings({
        reasoning: { mode: 'off', exclude: false, summary: 'off', carryForward: 'off' },
      }),
      path,
    )
    expect(wire.reasoning).toEqual({ enabled: false })
  })

  it('emits bare { enabled: true } for plain enabled mode', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    const { wire } = toChatCompletions(
      settings({
        reasoning: { mode: 'enabled', exclude: false, summary: 'off', carryForward: 'off' },
      }),
      path,
    )
    expect(wire.reasoning).toEqual({ enabled: true })
  })

  it('omits reasoning entirely for default mode (let provider pick)', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    const { wire } = toChatCompletions(
      settings({
        reasoning: { mode: 'default', exclude: false, summary: 'off', carryForward: 'off' },
      }),
      path,
    )
    expect(wire.reasoning).toBeUndefined()
  })

  it('filters hiddenFromContext + deleted messages from the wire path', () => {
    const path = [
      textMessage({ id: 'u1', role: 'user', text: 'visible' }),
      textMessage({
        id: 'a-hidden',
        role: 'assistant',
        text: 'hidden',
        hiddenFromContext: true,
      }),
    ]
    const { wire } = toChatCompletions(settings(), path)
    expect(wire.messages).toEqual([{ role: 'user', content: 'visible' }])
  })

  it('does not append tool/reasoning echoes in Phase 7 (tools off)', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    const { wire } = toChatCompletions(settings(), path)
    expect(wire.tools).toBeUndefined()
    expect(wire.tool_choice).toBeUndefined()
    expect(wire.parallel_tool_calls).toBeUndefined()
  })

  it('serializes a trailing assistant prefill as an open assistant turn', () => {
    const path = [
      textMessage({ id: 'u1', role: 'user', text: 'hi' }),
      textMessage({ id: 'a1', role: 'assistant', text: 'Sure,', origin: 'prefill' }),
    ]
    const { wire } = toChatCompletions(settings(), path)
    expect(wire.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Sure,' },
    ])
  })

  it('respects opts.rewriteSlug without changing requestedModel', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    const { wire, requestedModel } = toChatCompletions(
      settings({ model: 'anthropic/claude-sonnet-3.7:thinking' }),
      path,
      { rewriteSlug: (slug) => slug.replace(/:thinking$/, '') },
    )
    expect(wire.model).toBe('anthropic/claude-sonnet-3.7')
    expect(requestedModel).toBe('anthropic/claude-sonnet-3.7:thinking')
  })

  it('opts.stream=false omits the stream field for buffered callers', () => {
    const path = [textMessage({ id: 'u1', role: 'user', text: 'hi' })]
    const { wire } = toChatCompletions(settings(), path, { stream: false })
    expect(wire.stream).toBeUndefined()
  })
})

describe('buildChatMessages', () => {
  it('emits tool_call_id for role=tool when the message carries a tool_calls link', () => {
    const path: Message[] = [
      {
        id: 't1',
        chatId: 'c',
        parentId: null,
        siblingIndex: 0,
        turnId: 't-turn',
        turnIndex: 0,
        createdAt: 1,
        role: 'tool',
        origin: 'imported',
        content: [{ type: 'text', text: '{"ok":true}' }],
        nodeVersion: 0,
        deleted: false,
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '' } }],
      },
    ]
    const messages = buildChatMessages(settings(), path)
    expect(messages).toEqual([
      {
        role: 'tool',
        content: '{"ok":true}',
        tool_call_id: 'call_1',
      },
    ])
  })
})

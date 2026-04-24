// Phase 11: reasoning echo in `toChatCompletions` + standalone
// `filterReasoningForInclude` helper. See `plan/phase11-implementation.md §2 / §4.5b`.

import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { filterReasoningForInclude } from '../../src/core/reasoning'
import { buildChatMessages, toChatCompletions } from '../../src/core/transforms'
import type {
  ChatSettings,
  Message,
  MessageRole,
  ReasoningDetail,
  ReasoningFormat,
  ReasoningInclude,
  ToolCall,
} from '../../src/core/types'

function assistantWithReasoning(
  id: string,
  text: string,
  details: ReasoningDetail[],
  toolCalls?: ToolCall[],
): Message {
  return {
    id,
    chatId: 'c',
    parentId: null,
    siblingIndex: 0,
    turnId: `${id}-t`,
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant' as MessageRole,
    origin: 'generated',
    content: [{ type: 'text', text }],
    reasoningDetails: details,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

function userMessage(id: string, text: string): Message {
  return {
    id,
    chatId: 'c',
    parentId: null,
    siblingIndex: 0,
    turnId: `${id}-t`,
    turnIndex: 0,
    createdAt: 0,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text }],
    nodeVersion: 0,
    deleted: false,
  }
}

function withInclude(include: ReasoningInclude, overrides: Partial<ChatSettings> = {}): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.profileId = 'prof'
  s.model = 'anthropic/claude-haiku-4.5'
  s.reasoning = {
    mode: 'off',
    exclude: false,
    summary: 'off',
    include,
  }
  return { ...s, ...overrides }
}

describe('filterReasoningForInclude', () => {
  it('drops tool-call signatures (id starts with tool_)', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', id: 'tool_123', text: 'bogus' },
      { type: 'reasoning.text', id: 'r_1', text: 'real' },
    ]
    const kept = filterReasoningForInclude(
      details,
      { encrypted: false, summary: true, text: true },
      'anthropic-claude-v1',
    )
    expect(kept).toEqual([{ type: 'reasoning.text', id: 'r_1', text: 'real' }])
  })

  it('keeps encrypted only when include.encrypted AND format matches (Anthropic redacted gate opt-in)', () => {
    const claudeEncrypted: ReasoningDetail = {
      type: 'reasoning.encrypted',
      id: 'r_c',
      data: 'blob',
      format: 'anthropic-claude-v1',
    }
    const openaiEncrypted: ReasoningDetail = {
      type: 'reasoning.encrypted',
      id: 'r_o',
      data: 'blob2',
      format: 'openai-responses-v1',
    }
    const kept = filterReasoningForInclude(
      [claudeEncrypted, openaiEncrypted],
      { encrypted: true, summary: false, text: false },
      'anthropic-claude-v1',
      { acceptsAnthropicRedactedThinking: true },
    )
    expect(kept).toEqual([claudeEncrypted])
  })

  it('Anthropic reasoning.encrypted (redacted_thinking) is DROPPED by default — only Claude 3.7 accepts', () => {
    const claudeRedacted: ReasoningDetail = {
      type: 'reasoning.encrypted',
      id: 'r_c',
      data: 'blob',
      format: 'anthropic-claude-v1',
    }
    // Default (no flag) → drop for Claude 4+
    const dropped = filterReasoningForInclude(
      [claudeRedacted],
      { encrypted: true, summary: false, text: false },
      'anthropic-claude-v1',
    )
    expect(dropped).toEqual([])
    // Flag=true → keep (Claude 3.7 target)
    const kept = filterReasoningForInclude(
      [claudeRedacted],
      { encrypted: true, summary: false, text: false },
      'anthropic-claude-v1',
      { acceptsAnthropicRedactedThinking: true },
    )
    expect(kept).toEqual([claudeRedacted])
  })

  it('drops encrypted when preservationFormat is undefined or unknown', () => {
    const detail: ReasoningDetail = {
      type: 'reasoning.encrypted',
      id: 'r_c',
      data: 'blob',
      format: 'anthropic-claude-v1',
    }
    for (const fmt of [undefined, 'unknown'] as (ReasoningFormat | undefined)[]) {
      const kept = filterReasoningForInclude(
        [detail],
        { encrypted: true, summary: false, text: false },
        fmt,
      )
      expect(kept).toEqual([])
    }
  })

  it('keeps encrypted when stored format is missing and route is compatible', () => {
    // `format` absent on the carrier → trust include flag + route format.
    const detail: ReasoningDetail = { type: 'reasoning.encrypted', id: 'r_c', data: 'b' }
    const kept = filterReasoningForInclude(
      [detail],
      { encrypted: true, summary: false, text: false },
      'openai-responses-v1',
    )
    expect(kept).toEqual([detail])
  })

  it('summary and text flags gate independently', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.summary', id: 'r_s', summary: 'gist' },
      { type: 'reasoning.text', id: 'r_t', text: 'verbose' },
    ]
    expect(filterReasoningForInclude(details, { encrypted: false, summary: true, text: false }, undefined)).toEqual([
      { type: 'reasoning.summary', id: 'r_s', summary: 'gist' },
    ])
    expect(filterReasoningForInclude(details, { encrypted: false, summary: false, text: true }, undefined)).toEqual([
      { type: 'reasoning.text', id: 'r_t', text: 'verbose' },
    ])
  })

  it('all-false drops everything', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', id: 'r_t', text: 'a' },
      { type: 'reasoning.summary', id: 'r_s', summary: 'b' },
      { type: 'reasoning.encrypted', id: 'r_e', data: 'c', format: 'anthropic-claude-v1' },
    ]
    expect(
      filterReasoningForInclude(details, { encrypted: false, summary: false, text: false }, 'anthropic-claude-v1'),
    ).toEqual([])
  })

  it('treats Anthropic reasoning.text with .signature as encrypted-gated', () => {
    const claudeText: ReasoningDetail = {
      type: 'reasoning.text',
      id: 'r_c',
      format: 'anthropic-claude-v1',
      text: 'Let me think...',
      signature: 'sig-blob',
    }
    // encrypted:true, text:false → Anthropic carrier STILL kept (signature present).
    const keptEncrypted = filterReasoningForInclude(
      [claudeText],
      { encrypted: true, summary: false, text: false },
      'anthropic-claude-v1',
    )
    expect(keptEncrypted).toEqual([claudeText])

    // encrypted:false, text:true → Anthropic carrier DROPPED (signature gates on encrypted).
    const droppedByEncryptedOff = filterReasoningForInclude(
      [claudeText],
      { encrypted: false, summary: false, text: true },
      'anthropic-claude-v1',
    )
    expect(droppedByEncryptedOff).toEqual([])

    // Format mismatch drops it even when encrypted:true.
    const droppedByFormatMismatch = filterReasoningForInclude(
      [claudeText],
      { encrypted: true, summary: false, text: false },
      'openai-responses-v1',
    )
    expect(droppedByFormatMismatch).toEqual([])
  })

  it('reasoning.text WITHOUT signature is plaintext — gated by include.text', () => {
    // OpenRouter-Gemini repackages the summary as a reasoning.text detail with
    // no signature. Default (text:false) drops it.
    const openRouterGeminiSummary: ReasoningDetail = {
      type: 'reasoning.text',
      id: 'r_s',
      format: 'google-gemini-v1',
      text: 'summary of thinking',
      // no signature
    }
    const dropped = filterReasoningForInclude(
      [openRouterGeminiSummary],
      { encrypted: true, summary: false, text: false },
      'google-gemini-v1',
    )
    expect(dropped).toEqual([])

    // text:true keeps it.
    const kept = filterReasoningForInclude(
      [openRouterGeminiSummary],
      { encrypted: true, summary: false, text: true },
      'google-gemini-v1',
    )
    expect(kept).toEqual([openRouterGeminiSummary])
  })
})

describe('buildChatMessages / toChatCompletions — reasoning echo', () => {
  it('echoes assistant reasoning_details per the include matrix', () => {
    // `reasoning.text` without signature is plaintext (gated on include.text).
    // `reasoning.summary` is always summary-gated.
    const path: Message[] = [
      userMessage('u1', 'hello'),
      assistantWithReasoning('a1', 'hi!', [
        { type: 'reasoning.text', id: 'r_t', text: 'thinking...' }, // no signature → plaintext
        { type: 'reasoning.summary', id: 'r_s', summary: 'summary' },
      ]),
      userMessage('u2', 'go on'),
    ]
    const settings = withInclude({ encrypted: false, summary: true, text: true })
    // Pass a known preservation format so the native `reasoning_details` echo
    // path fires. With format undefined / 'unknown' the transform falls back
    // to wrapping reasoning in a `<think>…</think>` block in content (since
    // OR strips reasoning_details for unknown-format models).
    const messages = buildChatMessages(settings, path, {
      reasoningPreservationFormat: 'anthropic-claude-v1',
    })
    expect(messages).toHaveLength(3)
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.role).toBe('assistant')
    expect(echoed.content).toBe('hi!')
    expect(echoed.reasoning_details).toEqual([
      { type: 'reasoning.text', id: 'r_t', text: 'thinking...' },
      { type: 'reasoning.summary', id: 'r_s', summary: 'summary' },
    ])
  })

  it('falls back to <think> wrap when the target format is unknown', () => {
    // DeepSeek / Qwen / Gemma etc. — OR strips reasoning_details on input,
    // so we wrap the reasoning in a single `<think>…</think>` block at the
    // start of assistant content so the model still conditions on prior CoT.
    const path: Message[] = [
      userMessage('u1', 'hello'),
      assistantWithReasoning('a1', 'hi!', [
        { type: 'reasoning.text', id: 'r_t', text: 'thinking...' },
        { type: 'reasoning.summary', id: 'r_s', summary: 'summary' },
      ]),
      userMessage('u2', 'go on'),
    ]
    const settings = withInclude({ encrypted: false, summary: true, text: true })
    const messages = buildChatMessages(settings, path)
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.role).toBe('assistant')
    expect(echoed.reasoning_details).toBeUndefined()
    expect(echoed.content).toContain('<think>')
    expect(echoed.content).toContain('thinking...')
    expect(echoed.content).toContain('Summary: summary')
    expect(echoed.content).toContain('</think>')
    expect(echoed.content).toContain('hi!')
  })

  it('Anthropic-style reasoning.text with .signature rides encrypted gate', () => {
    const path: Message[] = [
      userMessage('u1', 'hi'),
      assistantWithReasoning('a1', 'reply', [
        {
          type: 'reasoning.text',
          id: 'r_c',
          format: 'anthropic-claude-v1',
          text: 'thought',
          signature: 'sig',
        },
      ]),
    ]
    // include.encrypted=true + format match → echo keeps the signed text.
    const kept = buildChatMessages(
      withInclude({ encrypted: true, summary: false, text: false }),
      path,
      { reasoningPreservationFormat: 'anthropic-claude-v1' },
    )
    const keptEchoed = kept[1] as Record<string, unknown>
    expect(keptEchoed.reasoning_details).toEqual([
      {
        type: 'reasoning.text',
        id: 'r_c',
        format: 'anthropic-claude-v1',
        text: 'thought',
        signature: 'sig',
      },
    ])

    // include.text=true + encrypted=false → drop (signature flag gates on encrypted).
    const dropped = buildChatMessages(
      withInclude({ encrypted: false, summary: false, text: true }),
      path,
      { reasoningPreservationFormat: 'anthropic-claude-v1' },
    )
    const droppedEchoed = dropped[1] as Record<string, unknown>
    expect(droppedEchoed).not.toHaveProperty('reasoning_details')
  })

  it('drops reasoning_details field when include is all-false', () => {
    const path: Message[] = [
      userMessage('u1', 'x'),
      assistantWithReasoning('a1', 'y', [
        { type: 'reasoning.text', id: 'r', text: 'think' },
      ]),
    ]
    const messages = buildChatMessages(
      withInclude({ encrypted: false, summary: false, text: false }),
      path,
    )
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed).not.toHaveProperty('reasoning_details')
  })

  it('drops encrypted carriers when preservationFormat is undefined', () => {
    const path: Message[] = [
      userMessage('u1', 'x'),
      assistantWithReasoning('a1', 'y', [
        { type: 'reasoning.encrypted', id: 'r', data: 'blob', format: 'anthropic-claude-v1' },
      ]),
    ]
    const messages = buildChatMessages(withInclude({ encrypted: true, summary: false, text: false }), path)
    // No format passed → encrypted dropped.
    expect(messages[1]).not.toHaveProperty('reasoning_details')
  })

  it('keeps encrypted carriers when preservationFormat + Anthropic redacted-thinking gate match', () => {
    const path: Message[] = [
      userMessage('u1', 'x'),
      assistantWithReasoning('a1', 'y', [
        { type: 'reasoning.encrypted', id: 'r', data: 'blob', format: 'anthropic-claude-v1' },
      ]),
    ]
    const messages = buildChatMessages(
      withInclude({ encrypted: true, summary: false, text: false }),
      path,
      {
        reasoningPreservationFormat: 'anthropic-claude-v1',
        acceptsAnthropicRedactedThinking: true,
      },
    )
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.reasoning_details).toEqual([
      { type: 'reasoning.encrypted', id: 'r', data: 'blob', format: 'anthropic-claude-v1' },
    ])
  })

  it('never strips tool_calls on assistant echo', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"x"}' },
      },
    ]
    const path: Message[] = [
      userMessage('u1', 'x'),
      assistantWithReasoning('a1', '', [], toolCalls),
    ]
    const messages = buildChatMessages(withInclude({ encrypted: false, summary: false, text: false }), path)
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"x"}' },
      },
    ])
  })

  it('emits tool_call_id on tool messages but no reasoning/tool_calls fields', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_9', type: 'function', function: { name: 'f', arguments: '{}' } },
    ]
    const toolMessage: Message = {
      id: 't1',
      chatId: 'c',
      parentId: null,
      siblingIndex: 0,
      turnId: 't1-t',
      turnIndex: 0,
      createdAt: 1,
      role: 'tool',
      origin: 'generated',
      content: [{ type: 'text', text: 'result' }],
      toolCalls,
      nodeVersion: 0,
      deleted: false,
    }
    const path: Message[] = [userMessage('u1', 'x'), toolMessage]
    const messages = buildChatMessages(withInclude({ encrypted: false, summary: false, text: false }), path)
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.role).toBe('tool')
    expect(echoed.tool_call_id).toBe('call_9')
    expect(echoed).not.toHaveProperty('tool_calls')
    expect(echoed).not.toHaveProperty('reasoning_details')
  })

  it('does NOT echo phase field on chat completions (strip on wire)', () => {
    const path: Message[] = [
      userMessage('u1', 'x'),
      {
        ...assistantWithReasoning('a1', 'y', []),
        phase: 'final_answer',
      },
    ]
    const { wire } = toChatCompletions(withInclude({ encrypted: false, summary: false, text: false }), path, {})
    const echoed = (wire.messages as Record<string, unknown>[])[1]
    expect(echoed).not.toHaveProperty('phase')
  })
})

describe('echoAsThinkTags — universal-compat transport', () => {
  function withEchoAsThink(
    include: ReasoningInclude,
    echoAsThinkTags: boolean,
  ): ChatSettings {
    const s = withInclude(include)
    s.reasoning = { ...s.reasoning, echoAsThinkTags }
    return s
  }

  it('forces <think> wrap on a known-format model when echoAsThinkTags is on', () => {
    // Anthropic claude-v1 normally rides reasoning_details[]. With the user
    // opt-in, plaintext text + summary become a single <think>…</think> block
    // prepended to content.
    const path: Message[] = [
      userMessage('u1', 'hi'),
      assistantWithReasoning('a1', 'reply', [
        { type: 'reasoning.summary', id: 'r_s', summary: 'brief' },
        { type: 'reasoning.text', id: 'r_t', text: 'verbose chain' },
      ]),
    ]
    const messages = buildChatMessages(
      withEchoAsThink({ encrypted: false, summary: true, text: true }, true),
      path,
      { reasoningPreservationFormat: 'anthropic-claude-v1' },
    )
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed).not.toHaveProperty('reasoning_details')
    const content = echoed.content as string
    expect(content).toMatch(/^<think>[\s\S]*<\/think>\n\nreply$/)
    expect(content).toContain('Summary: brief')
    expect(content).toContain('verbose chain')
  })

  it('keeps opaque encrypted carriers on reasoning_details[] when echoAsThinkTags is on', () => {
    // Encrypted bytes are opaque — the universal-compat path must keep them
    // riding the native channel even when text/summary become <think>.
    const path: Message[] = [
      userMessage('u1', 'hi'),
      assistantWithReasoning('a1', 'reply', [
        { type: 'reasoning.encrypted', id: 'r_e', data: 'blob', format: 'anthropic-claude-v1' },
        { type: 'reasoning.summary', id: 'r_s', summary: 'brief' },
      ]),
    ]
    const messages = buildChatMessages(
      withEchoAsThink({ encrypted: true, summary: true, text: false }, true),
      path,
      {
        reasoningPreservationFormat: 'anthropic-claude-v1',
        acceptsAnthropicRedactedThinking: true,
      },
    )
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.reasoning_details).toEqual([
      { type: 'reasoning.encrypted', id: 'r_e', data: 'blob', format: 'anthropic-claude-v1' },
    ])
    expect(echoed.content).toMatch(/<think>[\s\S]*Summary: brief[\s\S]*<\/think>/)
  })

  it('keeps Anthropic signed-text on reasoning_details[] (signature is opaque) when echoAsThinkTags is on', () => {
    // reasoning.text with .signature is Anthropic's signed thinking block —
    // the signature is what the next turn validates, so we never strip it
    // out by tag-ifying the text.
    const path: Message[] = [
      userMessage('u1', 'hi'),
      assistantWithReasoning('a1', 'reply', [
        {
          type: 'reasoning.text',
          id: 'r_signed',
          format: 'anthropic-claude-v1',
          text: 'signed thought',
          signature: 'sig-bytes',
        },
        { type: 'reasoning.text', id: 'r_plain', text: 'plain thought' },
      ]),
    ]
    const messages = buildChatMessages(
      withEchoAsThink({ encrypted: true, summary: false, text: true }, true),
      path,
      { reasoningPreservationFormat: 'anthropic-claude-v1' },
    )
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.reasoning_details).toEqual([
      {
        type: 'reasoning.text',
        id: 'r_signed',
        format: 'anthropic-claude-v1',
        text: 'signed thought',
        signature: 'sig-bytes',
      },
    ])
    const content = echoed.content as string
    expect(content).toMatch(/<think>[\s\S]*plain thought[\s\S]*<\/think>/)
    // Signed text was NOT also wrapped — would have duplicated bytes.
    expect(content).not.toContain('signed thought')
  })

  it('with no plaintext to wrap, falls through to the native echo path', () => {
    const path: Message[] = [
      userMessage('u1', 'hi'),
      assistantWithReasoning('a1', 'reply', [
        { type: 'reasoning.encrypted', id: 'r_e', data: 'blob', format: 'anthropic-claude-v1' },
      ]),
    ]
    const messages = buildChatMessages(
      withEchoAsThink({ encrypted: true, summary: false, text: false }, true),
      path,
      {
        reasoningPreservationFormat: 'anthropic-claude-v1',
        acceptsAnthropicRedactedThinking: true,
      },
    )
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.content).toBe('reply')
    expect(echoed.reasoning_details).toEqual([
      { type: 'reasoning.encrypted', id: 'r_e', data: 'blob', format: 'anthropic-claude-v1' },
    ])
  })

  it('echoAsThinkTags off (default) keeps the original native echo behavior', () => {
    // Regression guard: untouched chats must serialize the same as before
    // the flag landed.
    const path: Message[] = [
      userMessage('u1', 'hi'),
      assistantWithReasoning('a1', 'reply', [
        { type: 'reasoning.summary', id: 'r_s', summary: 'brief' },
      ]),
    ]
    const messages = buildChatMessages(
      withInclude({ encrypted: false, summary: true, text: false }),
      path,
      { reasoningPreservationFormat: 'anthropic-claude-v1' },
    )
    const echoed = messages[1] as Record<string, unknown>
    expect(echoed.content).toBe('reply')
    expect(echoed.reasoning_details).toEqual([
      { type: 'reasoning.summary', id: 'r_s', summary: 'brief' },
    ])
  })
})

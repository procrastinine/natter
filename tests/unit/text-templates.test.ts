import { describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  EMPTY_TEXT_TEMPLATE,
  editableTextTemplateConfig,
  RAW_TEXT_TEMPLATE_SOURCE,
  renderTextPrompt,
  TEXT_TEMPLATES,
  templateSourceForConfig,
} from '../../src/core/text-templates'
import { toTextCompletions } from '../../src/core/transforms'
import type { Message } from '../../src/core/types'

function msg(overrides: Partial<Message>): Message {
  return {
    id: overrides.id ?? 'm1',
    chatId: 'c1',
    parentId: overrides.parentId ?? null,
    siblingIndex: overrides.siblingIndex ?? 0,
    turnId: overrides.turnId ?? 't1',
    turnIndex: overrides.turnIndex ?? 0,
    createdAt: overrides.createdAt ?? 1,
    role: overrides.role ?? 'user',
    origin: overrides.origin ?? 'user',
    content: overrides.content ?? [{ type: 'text', text: '' }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

function builtInTemplate(name: 'chatml' | 'raw') {
  const template = TEXT_TEMPLATES[name]
  if (!template) throw new Error(`missing built-in text template: ${name}`)
  return template
}

describe('text-completions prompt templates', () => {
  it('renders raw as literal visible text without the chat system prompt', () => {
    const settings = cloneDefaultChatSettings()
    settings.systemPrompt = 'You are a helpful assistant.'
    const prompt = renderTextPrompt(builtInTemplate('raw'), settings, [
      msg({ role: 'user', content: [{ type: 'text', text: 'Why did' }] }),
    ])

    expect(prompt).toBe('Why did')
  })

  it('treats raw as a Jinja plaintext continuation template', () => {
    const settings = cloneDefaultChatSettings()
    const prompt = renderTextPrompt(builtInTemplate('raw'), settings, [
      msg({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'Why did' }] }),
      msg({
        id: 'a1',
        role: 'assistant',
        parentId: 'u1',
        content: [{ type: 'output_text', text: ' the chicken' }],
      }),
    ])

    expect(TEXT_TEMPLATES.raw?.template).toBe(RAW_TEXT_TEMPLATE_SOURCE)
    expect(prompt).toBe('Why did the chicken')
  })

  it('renders editable Jinja template source with role branches and generation prompts', () => {
    const settings = cloneDefaultChatSettings()
    settings.systemPrompt = 'Ignored here.'
    const template = {
      ...EMPTY_TEXT_TEMPLATE,
      includeSystemPrompt: false,
      template:
        '{% for message in messages %}' +
        '{% if message.role == "user" %}U: {{ message.content }}\n' +
        '{% elif message.role == "assistant" %}A: {{ message.content }}{% if not message.is_open %}\n{% endif %}' +
        '{% endif %}' +
        '{% endfor %}' +
        '{% if add_generation_prompt %}A: {% endif %}',
    }

    const prompt = renderTextPrompt(template, settings, [
      msg({ role: 'user', content: [{ type: 'text', text: 'Continue' }] }),
    ])

    expect(prompt).toBe('U: Continue\nA: ')
  })

  it('keeps a trailing assistant prefill open through Jinja templates', () => {
    const settings = cloneDefaultChatSettings()
    const template = {
      ...EMPTY_TEXT_TEMPLATE,
      includeSystemPrompt: false,
      template:
        '{% for message in messages %}' +
        '{% if message.role == "user" %}U: {{ message.content }}\n' +
        '{% elif message.role == "assistant" %}A: {{ message.content }}{% if not message.is_open %}\n{% endif %}' +
        '{% endif %}' +
        '{% endfor %}' +
        '{% if add_generation_prompt %}A: {% endif %}',
    }

    const prompt = renderTextPrompt(template, settings, [
      msg({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'Continue' }] }),
      msg({
        id: 'p1',
        role: 'assistant',
        origin: 'prefill',
        parentId: 'u1',
        content: [{ type: 'text', text: 'because' }],
      }),
    ])

    expect(prompt).toBe('U: Continue\nA: because')
  })

  it('exposes built-ins as plaintext template source for user-owned copies', () => {
    const chatml = builtInTemplate('chatml')
    const source = templateSourceForConfig(chatml)
    const copy = editableTextTemplateConfig(chatml)
    expect(source).toContain('{% for message in messages %}')
    expect(source).toContain('<|im_start|>user')
    expect(copy.template).toBe(source)
    expect(copy.includeSystemPrompt).toBe(true)
  })

  it('renders a trailing assistant prefill as the open segment', () => {
    const settings = cloneDefaultChatSettings()
    settings.systemPrompt = 'Be brief.'
    const prompt = renderTextPrompt(builtInTemplate('chatml'), settings, [
      msg({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] }),
      msg({
        id: 'p1',
        role: 'assistant',
        origin: 'prefill',
        parentId: 'u1',
        content: [{ type: 'text', text: 'The answer is' }],
      }),
    ])

    expect(prompt).toBe(
      '<|im_start|>system\nBe brief.<|im_end|>\n' +
        '<|im_start|>user\nWhat is 2+2?<|im_end|>\n' +
        '<|im_start|>assistant\nThe answer is',
    )
  })

  it('automatically carries included plaintext reasoning as a sanitized think block', () => {
    const settings = cloneDefaultChatSettings()
    settings.reasoning.include = { encrypted: true, summary: true, text: true }
    const prompt = renderTextPrompt(builtInTemplate('chatml'), settings, [
      msg({
        id: 'a1',
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'Final answer.' }],
        reasoningDetails: [
          { type: 'reasoning.summary', summary: '<think>short summary</think>', index: 0 },
          { type: 'reasoning.encrypted', data: 'SECRET', index: 1 },
          { type: 'reasoning.text', id: 'tool_1', text: 'tool signature', index: 2 },
          { type: 'reasoning.text', text: 'raw </think> thought', index: 3 },
        ],
      }),
    ])

    expect(prompt).toContain('<think>\nshort summary\n\nraw </think > thought\n</think>')
    expect(prompt).toContain('\n\nFinal answer.<|im_end|>')
    expect(prompt).not.toContain('SECRET')
    expect(prompt).not.toContain('tool signature')
  })

  it('builds OpenRouter-style text completion bodies with provider and reasoning settings', () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'moonshotai/kimi-k2.6'
    settings.api = 'text'
    settings.maxCompletionTokens = 32
    settings.reasoning = { ...settings.reasoning, mode: 'off' }
    settings.allowFallbacks = false
    settings.providerPrefs = { only: ['Moonshot AI'] }
    const result = toTextCompletions(
      settings,
      [msg({ role: 'user', content: [{ type: 'text', text: 'One plus one equals' }] })],
      {
        template: builtInTemplate('raw'),
        allowProviderRouting: true,
        capabilities: {
          supportedParameters: ['provider', 'reasoning', 'max_tokens'],
          streaming: 'supported',
        },
      },
    )

    expect(result.wire).toMatchObject({
      model: 'moonshotai/kimi-k2.6',
      prompt: 'One plus one equals',
      max_tokens: 32,
      reasoning: { enabled: false },
      provider: { only: ['Moonshot AI'], allow_fallbacks: false },
    })
    expect(result.wire).not.toHaveProperty('messages')
  })

  it('uses classic max_tokens for text completions even when caps list chat-style max_completion_tokens', () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'meta-llama/llama-3.3-70b-instruct'
    settings.api = 'text'
    settings.maxCompletionTokens = 7
    const result = toTextCompletions(
      settings,
      [msg({ role: 'user', content: [{ type: 'text', text: 'Why did' }] })],
      {
        template: builtInTemplate('raw'),
        capabilities: {
          supportedParameters: ['max_completion_tokens'],
          streaming: 'supported',
        },
      },
    )

    expect(result.wire.prompt).toBe('Why did')
    expect(result.wire.max_tokens).toBe(7)
    expect(result.wire).not.toHaveProperty('max_completion_tokens')
  })
})

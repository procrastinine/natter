import { describe, expect, it } from 'vitest'
import { toTextCompletions as toTextCompletionsWithContract } from '../../src/api/request-transforms'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { TEXT_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import { persistedReasoningCarryForwardFromEvidence } from '../../src/core/reasoning'
import {
  EMPTY_TEXT_TEMPLATE,
  editableTextTemplateConfig,
  RAW_TEXT_TEMPLATE_SOURCE,
  renderedTextPromptFromOpaqueServer,
  renderTextPromptProjection,
  TEXT_TEMPLATES,
  templateSourceForConfig,
} from '../../src/core/text-templates'
import type { Message, ReasoningDetail } from '../../src/core/types'
import {
  TEST_TEXT_PREFIX_PREFILL_PLAN,
  textReasoningContractForSettings,
} from '../helpers/reasoning-contracts'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

function renderTextPrompt(
  template: Parameters<typeof renderTextPromptProjection>[0],
  settings: ReturnType<typeof cloneDefaultChatSettings>,
  branch: readonly Message[],
) {
  return renderTextPromptProjection(
    template,
    settings,
    branch,
    textReasoningContractForSettings(settings),
    TEXT_PROVIDER_OUTPUT_CONTRACT,
  ).prompt
}

type TextOptions = Omit<
  Parameters<typeof toTextCompletionsWithContract>[2],
  'reasoning' | 'reasoningDialect' | 'prefillPlan' | 'providerOutput'
> & {
  reasoning?: Parameters<typeof toTextCompletionsWithContract>[2]['reasoning']
  reasoningDialect?: Parameters<typeof toTextCompletionsWithContract>[2]['reasoningDialect']
  prefillPlan?: Parameters<typeof toTextCompletionsWithContract>[2]['prefillPlan']
  providerOutput?: Parameters<typeof toTextCompletionsWithContract>[2]['providerOutput']
}

function toTextCompletions(
  settings: Parameters<typeof toTextCompletionsWithContract>[0],
  path: Parameters<typeof toTextCompletionsWithContract>[1],
  options: TextOptions,
) {
  return toTextCompletionsWithContract(settings, path, {
    ...options,
    reasoningDialect: options.reasoningDialect ?? 'generic-inline',
    reasoning: options.reasoning ?? textReasoningContractForSettings(settings),
    providerOutput: options.providerOutput ?? TEXT_PROVIDER_OUTPUT_CONTRACT,
    prefillPlan: options.prefillPlan ?? TEST_TEXT_PREFIX_PREFILL_PLAN,
  })
}

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
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.summary',
        format: 'unknown',
        summary: '<think>short summary</think>',
        index: 0,
      },
      { type: 'reasoning.encrypted', format: 'unknown', data: 'SECRET', index: 1 },
      {
        type: 'reasoning.text',
        format: 'unknown',
        id: 'tool_1',
        text: 'tool signature',
        index: 2,
      },
      {
        type: 'reasoning.text',
        format: 'unknown',
        text: 'raw </think> thought',
        index: 3,
      },
    ]
    const prompt = renderTextPrompt(builtInTemplate('chatml'), settings, [
      msg({
        id: 'a1',
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'Final answer.' }],
        reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(details, 'inline'),
      }),
    ])

    expect(prompt).toContain('<think>\nSummary: short summary\n\nraw </think > thought\n</think>')
    expect(prompt).toContain('\n\nFinal answer.<|im_end|>')
    expect(prompt).not.toContain('SECRET')
    expect(prompt).not.toContain('tool signature')
  })

  it('seals carry-forward from the expressions the selected Jinja branch actually emits', () => {
    const settings = cloneDefaultChatSettings()
    settings.reasoning.include = { encrypted: false, summary: false, text: true }
    const assistant = msg({
      id: 'a1',
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'answer' }],
      reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
        [{ type: 'reasoning.text', format: 'unknown', text: 'thought' }],
        'inline',
      ),
    })
    const omitted = renderTextPromptProjection(
      {
        ...EMPTY_TEXT_TEMPLATE,
        template:
          '{% for message in messages %}{% if message.role == "user" %}{{ message.content }}{% endif %}{% endfor %}',
      },
      settings,
      [assistant],
      textReasoningContractForSettings(settings),
      TEXT_PROVIDER_OUTPUT_CONTRACT,
    )
    const emitted = renderTextPromptProjection(
      {
        ...EMPTY_TEXT_TEMPLATE,
        template: '{% for message in messages %}{{ "prefix:" + message.content }}{% endfor %}',
      },
      settings,
      [assistant],
      textReasoningContractForSettings(settings),
      TEXT_PROVIDER_OUTPUT_CONTRACT,
    )

    expect(omitted).toMatchObject({ reasoning: { certainty: 'sealed', value: 'none' } })
    expect(emitted.prompt).toContain('prefix:<think>')
    expect(emitted).toMatchObject({
      reasoning: { certainty: 'sealed', value: 'visible-only' },
    })
  })

  it('does not count reasoning inspected only by control flow', () => {
    const settings = cloneDefaultChatSettings()
    settings.reasoning.include = { encrypted: false, summary: false, text: true }
    const result = renderTextPromptProjection(
      {
        ...EMPTY_TEXT_TEMPLATE,
        template:
          '{% for message in messages %}' +
          '{% if message.content != "" %}present{% endif %}' +
          '{% endfor %}',
      },
      settings,
      [
        msg({
          role: 'assistant',
          origin: 'generated',
          content: [{ type: 'output_text', text: 'answer' }],
          reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
            [{ type: 'reasoning.text', format: 'unknown', text: 'thought' }],
            'inline',
          ),
        }),
      ],
      textReasoningContractForSettings(settings),
      TEXT_PROVIDER_OUTPUT_CONTRACT,
    )

    expect(result).toEqual({
      prompt: 'present',
      reasoning: { certainty: 'sealed', value: 'none' },
    })
  })

  it('keeps duplicate and concatenated reasoning provenance idempotent', () => {
    const settings = cloneDefaultChatSettings()
    settings.reasoning.include = { encrypted: false, summary: false, text: true }
    const result = renderTextPromptProjection(
      {
        ...EMPTY_TEXT_TEMPLATE,
        template:
          '{% for message in messages %}' +
          '{{ message.content }}|{{ "copy:" + message.content }}' +
          '{% endfor %}',
      },
      settings,
      [
        msg({
          role: 'assistant',
          origin: 'generated',
          content: [{ type: 'output_text', text: 'answer' }],
          reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
            [{ type: 'reasoning.text', format: 'unknown', text: 'thought' }],
            'inline',
          ),
        }),
      ],
      textReasoningContractForSettings(settings),
      TEXT_PROVIDER_OUTPUT_CONTRACT,
    )

    expect(result.prompt.match(/<think>/gu)).toHaveLength(2)
    expect(result.reasoning).toEqual({ certainty: 'sealed', value: 'visible-only' })
  })

  it('merges provenance only from the message expressions that reach output', () => {
    const settings = cloneDefaultChatSettings()
    const first = msg({
      id: 'a1',
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'first' }],
    })
    const second = msg({
      id: 'a2',
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'second' }],
    })
    const result = renderTextPromptProjection(
      { ...EMPTY_TEXT_TEMPLATE, template: '{{ messages[1].content }}' },
      settings,
      [first, second],
      textReasoningContractForSettings(settings),
      TEXT_PROVIDER_OUTPUT_CONTRACT,
      {
        reasoningCarryForwardByMessageId: new Map([
          [first.id, 'visible-only'],
          [second.id, 'carrier'],
        ]),
      },
    )

    expect(result).toEqual({
      prompt: 'second',
      reasoning: { certainty: 'sealed', value: 'carrier' },
    })
  })

  it('marks reasoning candidates passed through an opaque server template without guessing', () => {
    const none = renderedTextPromptFromOpaqueServer(
      { kind: 'opaque-server-rendered-prompt', prompt: 'plain' },
      'none',
    )
    const possible = renderedTextPromptFromOpaqueServer(
      { kind: 'opaque-server-rendered-prompt', prompt: 'opaque' },
      'carrier',
    )

    expect(none.reasoning).toEqual({ certainty: 'sealed', value: 'none' })
    expect(possible.reasoning).toEqual({ certainty: 'opaque', possible: 'carrier' })
    expect(persistedReasoningCarryForwardFromEvidence(possible.reasoning)).toBe('unknown')
  })

  it('keeps every built-in delimiter template identical to its editable Jinja form', () => {
    const settings = cloneDefaultChatSettings()
    settings.systemPrompt = 'system'
    settings.reasoning.include = { encrypted: false, summary: false, text: true }
    const branch = [
      msg({ id: 'u1', role: 'user', content: [{ type: 'text', text: 'question' }] }),
      msg({
        id: 'a1',
        role: 'assistant',
        parentId: 'u1',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'answer' }],
        reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
          [{ type: 'reasoning.text', format: 'unknown', text: 'thought' }],
          'inline',
        ),
      }),
      msg({
        id: 'p1',
        role: 'assistant',
        parentId: 'a1',
        origin: 'prefill',
        content: [{ type: 'text', text: 'open' }],
      }),
    ]
    const reasoning = textReasoningContractForSettings(settings)
    for (const template of Object.values(TEXT_TEMPLATES)) {
      const direct = renderTextPromptProjection(
        template,
        settings,
        branch,
        reasoning,
        TEXT_PROVIDER_OUTPUT_CONTRACT,
      )
      const editable = renderTextPromptProjection(
        editableTextTemplateConfig(template),
        settings,
        branch,
        reasoning,
        TEXT_PROVIDER_OUTPUT_CONTRACT,
      )
      expect(editable).toEqual(direct)
    }
  })

  it('renders a large nested template without changing message or provenance semantics', () => {
    const settings = cloneDefaultChatSettings()
    const count = 4_096
    const branch = Array.from({ length: count }, (_, index) =>
      msg({
        id: `m${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: index % 2 === 0 ? 'text' : 'output_text', text: `v${index}` }],
      }),
    )
    const result = renderTextPromptProjection(
      {
        ...EMPTY_TEXT_TEMPLATE,
        template:
          '{% for message in messages %}' +
          '{% if message.role == "user" or message.role == "assistant" %}' +
          '{{ "[" + message.role + "]" + message.content + "\\n" }}' +
          '{% endif %}' +
          '{% endfor %}',
      },
      settings,
      branch,
      textReasoningContractForSettings(settings),
      TEXT_PROVIDER_OUTPUT_CONTRACT,
    )

    expect(result.prompt.startsWith('[user]v0\n[assistant]v1\n')).toBe(true)
    expect(result.prompt.endsWith(`[assistant]v${count - 1}\n`)).toBe(true)
    expect(result.prompt.match(/\n/gu)).toHaveLength(count)
    expect(result.reasoning).toEqual({ certainty: 'sealed', value: 'none' })
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
        promptSource: { kind: 'client-template', template: builtInTemplate('raw') },
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
    expect(result.reasoningVisibilityEvidence).toEqual({
      kind: 'inline',
      activation: 'disabled',
    })
  })

  it('derives inline visibility only from reasoning fields that reached the wire', () => {
    const settings = cloneDefaultChatSettings()
    settings.reasoning = { ...settings.reasoning, mode: 'enabled', exclude: true }
    const promptSource = { kind: 'client-template' as const, template: builtInTemplate('raw') }
    const emitted = toTextCompletions(settings, [], { promptSource })
    expect(emitted.reasoningVisibilityEvidence).toEqual({
      kind: 'inline',
      activation: 'excluded',
    })

    const gated = toTextCompletions(
      { ...settings, reasoning: { ...settings.reasoning, mode: 'off', exclude: false } },
      [],
      {
        promptSource,
        capabilities: { supportedParameters: ['temperature'], streaming: 'supported' },
      },
    )
    expect(gated.wire.reasoning).toBeUndefined()
    expect(gated.reasoningVisibilityEvidence).toEqual({
      kind: 'inline',
      activation: 'active',
    })
  })

  it('keeps OpenRouter text display controls independent in default reasoning mode', () => {
    const settings = cloneDefaultChatSettings()
    settings.reasoning = {
      ...settings.reasoning,
      mode: 'default',
      exclude: true,
      summary: 'auto',
    }
    const promptSource = { kind: 'client-template' as const, template: builtInTemplate('raw') }
    const emitted = toTextCompletions(settings, [], {
      promptSource,
      reasoningDialect: 'openrouter-text',
    })
    expect(emitted.wire.reasoning).toEqual({ exclude: true })
    expect(emitted.reasoningVisibilityEvidence).toEqual({
      kind: 'inline',
      activation: 'excluded',
    })

    const gated = toTextCompletions(settings, [], {
      promptSource,
      reasoningDialect: 'openrouter-text',
      capabilities: { supportedParameters: ['temperature'], streaming: 'supported' },
    })
    expect(gated.wire.reasoning).toBeUndefined()
    expect(gated.reasoningVisibilityEvidence).toEqual({
      kind: 'inline',
      activation: 'active',
    })
  })

  it('preserves forward sampling keys from portable imports', () => {
    const settings = cloneDefaultChatSettings()
    Object.assign(settings.sampling, { future_sampler: 0.25 })

    const result = toTextCompletions(settings, [], {
      promptSource: { kind: 'client-template', template: builtInTemplate('raw') },
    })

    expect(result.wire.future_sampler).toBe(0.25)
    expect(result.wire.undefined).toBeUndefined()
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
        promptSource: { kind: 'client-template', template: builtInTemplate('raw') },
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

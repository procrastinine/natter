import { describe, expect, it } from 'vitest'
import { toResponses as toResponsesWithContract } from '../../src/api/request-transforms'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
  OPENROUTER_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
} from '../../src/core/provider-tool-context'
import type {
  ChatSettings,
  Message,
  ReasoningDetail,
  ResponsesOutputItem,
  ToolCall,
} from '../../src/core/types'
import {
  responsesReasoningContractForSettings,
  TEST_UNSUPPORTED_PREFILL_PLAN,
} from '../helpers/reasoning-contracts'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

type ResponsesOptions = Omit<
  Parameters<typeof toResponsesWithContract>[2],
  'reasoning' | 'providerOutput' | 'prefillPlan'
> & {
  reasoning?: Parameters<typeof toResponsesWithContract>[2]['reasoning']
  providerOutput?: Parameters<typeof toResponsesWithContract>[2]['providerOutput']
  prefillPlan?: Parameters<typeof toResponsesWithContract>[2]['prefillPlan']
}

function toResponses(
  settings: Parameters<typeof toResponsesWithContract>[0],
  path: Parameters<typeof toResponsesWithContract>[1],
  options: ResponsesOptions = {},
) {
  return toResponsesWithContract(settings, path, {
    ...options,
    reasoning: options.reasoning ?? responsesReasoningContractForSettings(settings),
    providerOutput: options.providerOutput ?? OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
    prefillPlan: options.prefillPlan ?? TEST_UNSUPPORTED_PREFILL_PLAN,
  })
}

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

function openRouterTools(
  openrouter: Partial<ChatSettings['tools']['openrouter']>,
): Pick<ChatSettings, 'tools'> {
  const tools = cloneDefaultChatSettings().tools
  return { tools: { ...tools, openrouter: { ...tools.openrouter, ...openrouter } } }
}

function openAiTools(
  openai: Partial<ChatSettings['tools']['openai']>,
): Pick<ChatSettings, 'tools'> {
  const tools = cloneDefaultChatSettings().tools
  return { tools: { ...tools, openai: { ...tools.openai, ...openai } } }
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

type AssistantOptions = Partial<Message> & {
  reasoningDetails?: readonly ReasoningDetail[]
}

function assistant(id: string, text: string, opts: AssistantOptions = {}): Message {
  const { reasoningDetails, ...messageOptions } = opts
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
    ...messageOptions,
    ...(reasoningDetails
      ? {
          reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
            reasoningDetails,
            'openai-responses',
          ),
        }
      : {}),
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

  it('imports system prompt into `instructions`', () => {
    const s = settings({ systemPrompt: 'Be brief.' })
    const { wire } = toResponses(s, [user('u1', 'hi')])
    expect(wire.instructions).toBe('Be brief.')
  })

  it('prefers an inline system message over `settings.systemPrompt`', () => {
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

  it('serializes enabled OpenRouter hosted tools only when explicitly allowed', () => {
    const s = settings({
      ...openRouterTools({
        enabledServerToolIds: ['web-search', 'datetime', 'web-fetch', 'shell'],
        toolChoice: 'auto',
        parallelToolCalls: true,
      }),
    })

    expect(toResponses(s, [user('u1', 'hi')]).wire.tools).toBeUndefined()

    const { wire } = toResponses(s, [user('u1', 'hi')], { hostedToolsProvider: 'openrouter' })
    expect(wire.tools).toEqual([
      { type: 'openrouter:web_search' },
      { type: 'openrouter:datetime' },
      { type: 'openrouter:web_fetch' },
      { type: 'openrouter:shell' },
    ])
    expect(wire.tool_choice).toBe('auto')
    expect(wire.parallel_tool_calls).toBe(true)
  })

  it('serializes direct OpenAI hosted tools from the OpenAI bucket only', () => {
    const s = settings({
      ...openAiTools({
        enabledServerToolIds: ['web-search', 'image-generation', 'code-interpreter', 'shell'],
        toolChoice: 'auto',
        parallelToolCalls: false,
        config: {
          'web-search': {
            searchContextSize: 'high',
            allowedDomains: ['example.com', ' example.com ', 'docs.example.com'],
            includeSources: true,
            userLocation: { country: 'US', region: 'CA', city: 'San Francisco' },
          },
          'image-generation': {
            model: 'gpt-image-1-mini',
            size: '1024x1024',
            quality: 'medium',
            format: 'webp',
            partialImages: 2,
          },
          shell: {
            networkPolicy: { type: 'allowlist', allowedDomains: ['api.example.com'] },
          },
        },
      }),
    })

    expect(
      toResponses(s, [user('u1', 'hi')], { hostedToolsProvider: 'openrouter' }).wire.tools,
    ).toBeUndefined()

    const { wire } = toResponses(s, [user('u1', 'hi')], { hostedToolsProvider: 'openai' })
    expect(wire.tools).toEqual([
      {
        type: 'web_search',
        filters: { allowed_domains: ['example.com', 'docs.example.com'] },
        search_context_size: 'high',
        user_location: {
          type: 'approximate',
          country: 'US',
          region: 'CA',
          city: 'San Francisco',
        },
      },
      {
        type: 'image_generation',
        model: 'gpt-image-1-mini',
        quality: 'medium',
        size: '1024x1024',
        output_format: 'webp',
        partial_images: 2,
      },
      { type: 'code_interpreter', container: { type: 'auto' } },
      {
        type: 'shell',
        environment: {
          type: 'container_auto',
          network_policy: { type: 'allowlist', allowed_domains: ['api.example.com'] },
        },
      },
    ])
    expect(wire.include).toEqual(
      expect.arrayContaining([
        'reasoning.encrypted_content',
        'web_search_call.action.sources',
        'code_interpreter_call.outputs',
      ]),
    )
    expect(wire.tool_choice).toBe('auto')
    expect(wire.parallel_tool_calls).toBe(false)
  })
})

describe('toResponses — citation echo', () => {
  it('keeps Responses annotations on their exact output text part and does not cross-echo other dialects', () => {
    const prior = assistant('a1', '', {
      content: [
        {
          type: 'output_text',
          text: 'OpenAI source',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://openai.example/source',
              startIndex: 7,
              endIndex: 13,
              source: 'openai-responses',
              providerPayload: {
                type: 'url_citation',
                start_index: 7,
                end_index: 13,
                url: 'https://openai.example/source',
              },
            },
          ],
        },
        {
          type: 'output_text',
          text: 'Anthropic source',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://anthropic.example/source',
              startIndex: 10,
              endIndex: 16,
              source: 'anthropic-messages',
              providerPayload: {
                type: 'web_search_result_location',
                cited_text: 'source',
                url: 'https://anthropic.example/source',
              },
            },
          ],
        },
      ],
    })
    const { wire } = toResponses(settings(), [prior])
    const item = (wire.input as ResponsesOutputItem[]).find(
      (candidate) => candidate.type === 'message',
    )
    expect(item?.content).toEqual([
      {
        type: 'output_text',
        text: 'OpenAI source',
        annotations: [
          {
            type: 'url_citation',
            start_index: 7,
            end_index: 13,
            url: 'https://openai.example/source',
          },
        ],
      },
      { type: 'output_text', text: 'Anthropic source' },
    ])
  })
})

describe('toResponses — reasoning echo', () => {
  it('rebuilds the provider reasoning item from canonical grouped carrier rows', () => {
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', {
        reasoningDetails: [
          {
            type: 'reasoning.encrypted',
            format: 'openai-responses-v1',
            data: 'gAAA...blob',
            providerItemId: 'rs_1',
            providerOutputIndex: 0,
          },
          {
            type: 'reasoning.summary',
            format: 'openai-responses-v1',
            summary: 'I thought about X',
            providerItemId: 'rs_1',
            providerOutputIndex: 0,
            providerSummaryIndex: 0,
          },
        ],
      }),
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
    expect(reasoningItem).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'gAAA...blob',
      summary: [{ type: 'summary_text', text: 'I thought about X' }],
    })
  })

  it('emits only canonical input fields from persisted reasoning rows', () => {
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', {
        reasoningDetails: [
          {
            type: 'reasoning.encrypted',
            format: 'openai-responses-v1',
            data: 'gAAA...blob',
            providerOutputIndex: 0,
          },
          {
            type: 'reasoning.summary',
            format: 'openai-responses-v1',
            summary: 'I thought about X',
            providerOutputIndex: 0,
            providerSummaryIndex: 0,
          },
        ],
      }),
      user('u2', 'follow'),
    ]
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
    expect(items.find((i) => i.type === 'reasoning')).toEqual({
      type: 'reasoning',
      encrypted_content: 'gAAA...blob',
      summary: [{ type: 'summary_text', text: 'I thought about X' }],
    })
  })

  it('does not create a naked reasoning item when no carrier row survives policy', () => {
    // With include.encrypted=false and no `summary` on the echo item,
    // stripping leaves `{type:'reasoning', id}` — an empty envelope the
    // next turn cannot use. The transform drops it instead of sending it.
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', {
        reasoningDetails: [
          {
            type: 'reasoning.encrypted',
            format: 'openai-responses-v1',
            data: 'gAAA...blob',
            providerItemId: 'rs_1',
          },
        ],
      }),
    ]
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: true, text: false },
        },
      }),
      path,
    )
    const items = wire.input as Array<{ type: string; [k: string]: unknown }>
    const reasoningItem = items.find((i) => i.type === 'reasoning')
    expect(reasoningItem).toBeUndefined()
  })

  it('keeps a grouped item when its summary row survives policy', () => {
    const path: Message[] = [
      user('u1', 'q'),
      assistant('a1', 'answer', {
        reasoningDetails: [
          {
            type: 'reasoning.encrypted',
            format: 'openai-responses-v1',
            data: 'gAAA...blob',
            providerItemId: 'rs_1',
          },
          {
            type: 'reasoning.summary',
            format: 'openai-responses-v1',
            summary: 'visible reasoning',
            providerItemId: 'rs_1',
            providerSummaryIndex: 0,
          },
        ],
      }),
    ]
    const { wire } = toResponses(
      settings({
        reasoning: {
          mode: 'off',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: true, text: false },
        },
      }),
      path,
    )
    const items = wire.input as Array<{ type: string; [k: string]: unknown }>
    const reasoningItem = items.find((i) => i.type === 'reasoning') as
      | {
          id?: string
          encrypted_content?: string
          summary?: unknown[]
        }
      | undefined
    expect(reasoningItem).toBeDefined()
    expect(reasoningItem?.id).toBeUndefined()
    expect(reasoningItem?.encrypted_content).toBeUndefined()
    expect(reasoningItem?.summary).toHaveLength(1)
  })

  it('synthesizes a reasoning item from canonical reasoning details', () => {
    const details: ReasoningDetail[] = [
      {
        type: 'reasoning.encrypted',
        id: 'r_e',
        data: 'blob',
        format: 'openai-responses-v1',
        providerOutputIndex: 0,
      },
      {
        type: 'reasoning.summary',
        id: 'r_s',
        format: 'openai-responses-v1',
        summary: 'quick summary',
        providerOutputIndex: 0,
      },
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
          include: { encrypted: true, summary: true, text: false },
        },
      }),
      path,
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
          include: { encrypted: false, summary: false, text: false },
        },
      }),
      path,
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

describe('toResponses — reasoning dialect', () => {
  it('omits OpenRouter-only reasoning fields on native Responses', () => {
    const s = settings({
      reasoning: {
        mode: 'effort',
        effort: 'high',
        exclude: true,
        summary: 'auto',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const direct = toResponses(s, [user('u1', 'hi')])
    expect(direct.wire.reasoning).toEqual({
      effort: 'high',
      summary: 'auto',
    })
    expect(direct.reasoningVisibilityEvidence).toMatchObject({ activation: 'active' })
    const openRouter = toResponses(s, [user('u1', 'hi')], {
      allowOpenRouterExtensions: true,
    })
    expect(openRouter.wire.reasoning).toEqual({
      enabled: true,
      effort: 'high',
      exclude: true,
    })
    expect(openRouter.reasoningVisibilityEvidence).toMatchObject({ activation: 'excluded' })
  })

  it('emits an independently requested summary on direct and OpenRouter Responses', () => {
    const s = settings({
      reasoning: {
        ...settings().reasoning,
        mode: 'default',
        summary: 'auto',
      },
    })
    const direct = toResponses(s, [user('u1', 'hi')])
    const openRouter = toResponses(s, [user('u1', 'hi')], {
      allowOpenRouterExtensions: true,
    })
    expect(direct.wire.reasoning).toEqual({ summary: 'auto' })
    expect(direct.reasoningVisibilityEvidence).toMatchObject({
      dialect: 'openai-responses',
      display: 'available',
    })
    expect(openRouter.wire.reasoning).toEqual({ summary: 'auto' })
    expect(openRouter.reasoningVisibilityEvidence).toMatchObject({
      dialect: 'openrouter-responses',
      display: 'available',
    })

    const explicitlyOmitted = toResponses(
      {
        ...s,
        reasoning: { ...s.reasoning, mode: 'effort', effort: 'low', summary: 'off' },
      },
      [user('u1', 'hi')],
    )
    expect(explicitlyOmitted.reasoningVisibilityEvidence).toMatchObject({
      display: 'request-omitted',
    })
  })

  it('uses each provider dialect to turn reasoning off', () => {
    const direct = toResponses(settings(), [user('u1', 'hi')])
    expect(direct.wire.reasoning).toEqual({ effort: 'none' })
    expect(direct.reasoningVisibilityEvidence).toMatchObject({ activation: 'disabled' })
    const openRouter = toResponses(settings(), [user('u1', 'hi')], {
      allowOpenRouterExtensions: true,
    })
    expect(openRouter.wire.reasoning).toEqual({ enabled: false })
    expect(openRouter.reasoningVisibilityEvidence).toMatchObject({ activation: 'disabled' })
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
        include: { encrypted: true, summary: false, text: false },
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
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const { wire } = toResponses(s, [user('u1', 'hi')])
    expect(wire.temperature).toBe(0.5)
    expect(wire.top_p).toBe(0.8)
  })

  it('passes GPT-5.6 max effort through the existing Responses transform', () => {
    const s = settings({
      model: 'openai/gpt-5.6-terra',
      sampling: { temperature: 0.5 },
      reasoning: {
        mode: 'effort',
        effort: 'max',
        exclude: false,
        summary: 'off',
        include: { encrypted: true, summary: false, text: false },
      },
    })
    const { wire } = toResponses(s, [user('u1', 'hi')])
    expect(wire.reasoning).toEqual({ effort: 'max' })
    expect(wire.temperature).toBeUndefined()
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
    )
    expect(wire.include).toBeUndefined()
  })

  it('keeps encrypted reasoning include independent of the store flag', () => {
    const { wire } = toResponses(
      settings({
        responses: { store: true },
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
    expect(wire.include).toEqual(['reasoning.encrypted_content'])
    expect(wire.store).toBe(true)
  })
})

describe('toResponses — tool calls + tool outputs', () => {
  it('keeps direct OpenAI provider tool output items native on Responses', () => {
    const path: Message[] = [
      user('u1', 'compute'),
      assistant('a1', '55', {
        providerOutputItems: [
          {
            dialect: 'openai-responses',
            type: 'code_interpreter_call',
            outputIndex: 0,
            item: {
              id: 'ci_1',
              type: 'code_interpreter_call',
              status: 'completed',
              code: 'sum(i*i for i in range(6))',
              outputs: [{ type: 'logs', logs: '55' }],
            },
          },
        ],
      }),
      user('u2', 'what was the result?'),
    ]
    const { wire } = toResponses(settings(), path, { hostedToolsProvider: 'openai' })
    const items = wire.input as Array<Record<string, unknown>>
    expect(items.some((item) => item.type === 'code_interpreter_call')).toBe(true)
    const assistantMessage = items.find(
      (item) => item.type === 'message' && item.role === 'assistant',
    ) as { content?: Array<{ text?: string }> } | undefined
    expect(assistantMessage?.content?.[0]?.text).toBe('55')
  })

  it('renders unsupported provider tool output items as assistant text', () => {
    const path: Message[] = [
      user('u1', 'compute'),
      assistant('a1', '55', {
        providerOutputItems: [
          {
            dialect: 'openai-responses',
            type: 'shell_call_output',
            outputIndex: 0,
            item: {
              id: 'sho_1',
              type: 'shell_call_output',
              output: [{ stdout: 'natter-shape-probe.', stderr: '' }],
            },
          },
        ],
      }),
    ]
    const { wire } = toResponses(settings(), path, {
      hostedToolsProvider: 'openrouter',
      providerOutput: OPENROUTER_RESPONSES_PROVIDER_OUTPUT_CONTRACT,
    })
    const items = wire.input as Array<Record<string, unknown>>
    expect(items.some((item) => item.type === 'shell_call_output')).toBe(false)
    const assistantMessage = items.find(
      (item) => item.type === 'message' && item.role === 'assistant',
    ) as { content?: Array<{ text?: string }> } | undefined
    expect(assistantMessage?.content?.[0]?.text).toContain('<tool_call>')
    expect(assistantMessage?.content?.[0]?.text).toContain('natter-shape-probe.')
  })

  it('does not replay hidden provider tool output items', () => {
    const path: Message[] = [
      user('u1', 'compute'),
      assistant('a1', '55', {
        providerOutputItems: [
          {
            dialect: 'openai-responses',
            type: 'code_interpreter_call',
            hidden: true,
            item: {
              id: 'ci_1',
              type: 'code_interpreter_call',
              code: 'print(55)',
            },
          },
        ],
      }),
    ]
    const { wire } = toResponses(settings(), path, { hostedToolsProvider: 'openai' })
    const items = wire.input as Array<Record<string, unknown>>
    expect(items.some((item) => item.type === 'code_interpreter_call')).toBe(false)
    expect(JSON.stringify(items)).not.toContain('print(55)')
  })

  it('keeps edited direct OpenAI provider tool output native on Responses', () => {
    const path: Message[] = [
      user('u1', 'compute'),
      assistant('a1', '55', {
        providerOutputItems: [
          {
            dialect: 'openai-responses',
            type: 'code_interpreter_call',
            edited: true,
            item: {
              id: 'ci_1',
              type: 'code_interpreter_call',
              code: 'print(55)',
            },
          },
        ],
      }),
    ]
    const { wire } = toResponses(settings(), path, { hostedToolsProvider: 'openai' })
    const items = wire.input as Array<Record<string, unknown>>
    expect(items.some((item) => item.type === 'code_interpreter_call')).toBe(true)
    const assistantMessage = items.find(
      (item) => item.type === 'message' && item.role === 'assistant',
    ) as { content?: Array<{ text?: string }> } | undefined
    expect(assistantMessage?.content?.[0]?.text).toBe('55')
  })

  it('always renders OpenRouter provider output as tool_call text on Responses', () => {
    const path: Message[] = [
      user('u1', 'fetch'),
      assistant('a1', 'fetched', {
        providerOutputItems: [
          {
            dialect: 'openrouter-responses',
            type: 'openrouter:web_fetch',
            item: {
              type: 'openrouter:web_fetch',
              url: 'https://example.com',
              content: 'edited body',
            },
          },
        ],
      }),
    ]
    const { wire } = toResponses(settings(), path, { hostedToolsProvider: 'openrouter' })
    const items = wire.input as Array<Record<string, unknown>>
    expect(items.some((item) => item.type === 'openrouter:web_fetch')).toBe(false)
    const assistantMessage = items.find(
      (item) => item.type === 'message' && item.role === 'assistant',
    ) as { content?: Array<{ text?: string }> } | undefined
    expect(assistantMessage?.content?.[0]?.text).toContain('<tool_call>')
    expect(assistantMessage?.content?.[0]?.text).toContain('edited body')
  })

  it('respects the global tool-call context checkbox', () => {
    const s = settings({ toolCallContext: { include: false } })
    const path: Message[] = [
      user('u1', 'compute'),
      assistant('a1', '55', {
        providerOutputItems: [
          {
            dialect: 'openai-responses',
            type: 'code_interpreter_call',
            item: {
              id: 'ci_1',
              type: 'code_interpreter_call',
              code: 'print(55)',
            },
          },
        ],
      }),
    ]
    const { wire } = toResponses(s, path, { hostedToolsProvider: 'openai' })
    const items = wire.input as Array<Record<string, unknown>>
    expect(items.some((item) => item.type === 'code_interpreter_call')).toBe(false)
    expect(JSON.stringify(items)).not.toContain('<tool_call>')
    expect(JSON.stringify(items)).not.toContain('print(55)')
  })

  it('assistant tool calls → function_call items', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
    ]
    const path: Message[] = [user('u1', 'search'), assistant('a1', '', { toolCalls })]
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

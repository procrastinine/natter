import { describe, expect, it } from 'vitest'
import { toAnthropicMessages as toAnthropicMessagesWithContract } from '../../src/api/request-transforms'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { ANTHROPIC_PROVIDER_OUTPUT_CONTRACT } from '../../src/core/provider-tool-context'
import { reasoningVisibilityPolicyFor } from '../../src/core/quirks'
import { resolveAttemptInboundReasoningVisibility } from '../../src/core/reasoning'
import type { ChatSettings, Message, ReasoningDetail } from '../../src/core/types'
import {
  anthropicReasoningContractForSettings,
  TEST_ASSISTANT_TAIL_PREFILL_PLAN,
} from '../helpers/reasoning-contracts'
import { reasoningEnvelopeFromDetailsForTest } from '../helpers/reasoning-events'

type AnthropicOptions = Omit<
  Parameters<typeof toAnthropicMessagesWithContract>[2],
  'reasoning' | 'providerOutput' | 'prefillPlan'
> & {
  reasoning?: Parameters<typeof toAnthropicMessagesWithContract>[2]['reasoning']
  providerOutput?: Parameters<typeof toAnthropicMessagesWithContract>[2]['providerOutput']
  prefillPlan?: Parameters<typeof toAnthropicMessagesWithContract>[2]['prefillPlan']
}

function toAnthropicMessages(
  settings: Parameters<typeof toAnthropicMessagesWithContract>[0],
  path: Parameters<typeof toAnthropicMessagesWithContract>[1],
  options: AnthropicOptions = {},
) {
  return toAnthropicMessagesWithContract(settings, path, {
    ...options,
    reasoning: options.reasoning ?? anthropicReasoningContractForSettings(settings),
    providerOutput: options.providerOutput ?? ANTHROPIC_PROVIDER_OUTPUT_CONTRACT,
    prefillPlan: options.prefillPlan ?? TEST_ASSISTANT_TAIL_PREFILL_PLAN,
  })
}

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
    content: [{ type: 'output_text', text }],
    nodeVersion: 0,
    deleted: false,
    ...messageOptions,
    ...(reasoningDetails
      ? {
          reasoningEnvelope: reasoningEnvelopeFromDetailsForTest(
            reasoningDetails,
            'anthropic-messages',
          ),
        }
      : {}),
  }
}

describe('toAnthropicMessages', () => {
  it('normalizes provider-prefixed dotted Claude ids to Messages model ids', () => {
    const { modelId, requestedModel, wire } = toAnthropicMessages(settings(), [user('u1', 'hi')])
    expect(modelId).toBe('claude-haiku-4-5')
    expect(requestedModel).toBe('anthropic/claude-haiku-4.5')
    expect(wire.model).toBe('claude-haiku-4-5')
  })

  it('returns visibility evidence from the exact thinking block', () => {
    const base = settings({ model: 'anthropic/claude-opus-4.6' })
    expect(
      toAnthropicMessages({ ...base, reasoning: { ...base.reasoning, mode: 'default' } }, [
        user('u1', 'hi'),
      ]).reasoningVisibilityEvidence,
    ).toEqual({ kind: 'anthropic', display: 'provider-default' })
    expect(toAnthropicMessages(base, [user('u1', 'hi')]).reasoningVisibilityEvidence).toEqual({
      kind: 'anthropic',
      display: 'disabled',
    })
    expect(
      toAnthropicMessages(
        { ...base, reasoning: { ...base.reasoning, mode: 'enabled', summary: 'auto' } },
        [user('u1', 'hi')],
      ).reasoningVisibilityEvidence,
    ).toEqual({ kind: 'anthropic', display: 'provider-default' })
    expect(
      toAnthropicMessages(
        { ...base, reasoning: { ...base.reasoning, mode: 'enabled', summary: 'off' } },
        [user('u1', 'hi')],
      ).reasoningVisibilityEvidence,
    ).toEqual({ kind: 'anthropic', display: 'provider-default' })
  })

  it('seals Claude 4.6 plaintext and Claude 4.7 summary from their exact thinking wire', () => {
    const claude46 = settings({
      model: 'anthropic/claude-opus-4.6',
      reasoning: { ...settings().reasoning, mode: 'enabled', summary: 'auto' },
    })
    const claude46Result = toAnthropicMessages(claude46, [user('u1', 'hi')])
    expect(claude46Result.wire.thinking).toEqual({ type: 'adaptive' })
    expect(
      resolveAttemptInboundReasoningVisibility(
        reasoningVisibilityPolicyFor(claude46.model),
        claude46Result.reasoningVisibilityEvidence,
      ),
    ).toEqual({ disclosure: 'visible', visibleKind: 'text' })

    const claude47 = settings({
      model: 'anthropic/claude-opus-4.7',
      reasoning: { ...settings().reasoning, mode: 'enabled', summary: 'auto' },
    })
    const claude47Result = toAnthropicMessages(claude47, [user('u1', 'hi')])
    expect(claude47Result.wire.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(
      resolveAttemptInboundReasoningVisibility(
        reasoningVisibilityPolicyFor(claude47.model),
        claude47Result.reasoningVisibilityEvidence,
      ),
    ).toEqual({ disclosure: 'visible', visibleKind: 'summary' })

    const omitted = toAnthropicMessages(
      {
        ...claude47,
        reasoning: { ...claude47.reasoning, exclude: true },
      },
      [user('u1', 'hi')],
    )
    expect(omitted.wire.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
    expect(
      resolveAttemptInboundReasoningVisibility(
        reasoningVisibilityPolicyFor(claude47.model),
        omitted.reasoningVisibilityEvidence,
      ),
    ).toMatchObject({ disclosure: 'absent', reason: 'request-display' })
  })

  it('uses adaptive thinking and output_config effort for Claude 4.7', () => {
    const s = settings({
      model: 'anthropic/claude-opus-4.7',
      verbosity: 'xhigh',
      reasoning: { ...settings().reasoning, mode: 'enabled', summary: 'auto' },
    })
    const { wire } = toAnthropicMessages(s, [user('u1', 'hard problem')])
    expect(wire.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(wire.output_config).toEqual({ effort: 'xhigh' })
  })

  it('uses adaptive thinking for Claude Opus 4.8 without a per-model branch', () => {
    const s = settings({
      model: 'anthropic/claude-opus-4.8',
      verbosity: 'max',
      reasoning: { ...settings().reasoning, mode: 'budget', maxTokens: 4096, summary: 'auto' },
    })
    const { modelId, wire } = toAnthropicMessages(s, [user('u1', 'hard problem')])
    expect(modelId).toBe('claude-opus-4-8')
    expect(wire.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(wire.output_config).toEqual({ effort: 'max' })
  })

  it('uses the shared adaptive-only path for Claude Sonnet 5', () => {
    const s = settings({
      model: 'anthropic/claude-sonnet-5',
      verbosity: 'xhigh',
      reasoning: { ...settings().reasoning, mode: 'budget', maxTokens: 4096, summary: 'auto' },
    })
    const { modelId, wire } = toAnthropicMessages(s, [user('u1', 'hard problem')])
    expect(modelId).toBe('claude-sonnet-5')
    expect(wire.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(wire.output_config).toEqual({ effort: 'xhigh' })
  })

  it('uses manual budget thinking for Claude 4.6 only when a budget is set', () => {
    const s = settings({
      model: 'anthropic/claude-opus-4.6',
      reasoning: { ...settings().reasoning, mode: 'budget', maxTokens: 4096 },
    })
    const { wire } = toAnthropicMessages(s, [user('u1', 'hard problem')])
    expect(wire.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    })
  })

  it('gates stale Anthropic Messages sampling against current capabilities', () => {
    const s = settings({
      model: 'anthropic/claude-opus-4.7',
      sampling: { temperature: 0.2, top_p: 0.8, top_k: 20 },
      reasoning: { ...settings().reasoning, mode: 'enabled' },
    })
    const { wire } = toAnthropicMessages(s, [user('u1', 'hi')], {
      capabilities: {
        supportedParameters: ['max_tokens', 'thinking', 'verbosity'],
        streaming: 'supported',
        architecture: { inputModalities: ['text'], outputModalities: ['text'] },
      },
    })
    expect(wire.temperature).toBeUndefined()
    expect(wire.top_p).toBeUndefined()
    expect(wire.top_k).toBeUndefined()
    expect(wire.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
  })

  it('does not claim disabled thinking when capabilities kept it off the wire', () => {
    const s = settings({ reasoning: { ...settings().reasoning, mode: 'off' } })
    const result = toAnthropicMessages(s, [user('u1', 'hi')], {
      capabilities: {
        supportedParameters: ['max_tokens'],
        streaming: 'supported',
      },
    })
    expect(result.wire.thinking).toBeUndefined()
    expect(result.reasoningVisibilityEvidence).toEqual({
      kind: 'anthropic',
      display: 'provider-default',
    })
  })

  it('moves system/developer text to top-level system and serializes user content blocks', () => {
    const system = { ...user('s1', 'Be terse.'), role: 'system' as const }
    const { wire } = toAnthropicMessages(settings(), [system, user('u1', 'Hello')])
    expect(wire.system).toBe('Be terse.')
    expect(wire.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }])
  })

  it('keeps native Anthropic citations on their exact text block only', () => {
    const prior = assistant('a1', '', {
      content: [
        {
          type: 'output_text',
          text: 'Claude source',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://anthropic.example/source',
              startIndex: 7,
              endIndex: 13,
              source: 'anthropic-messages',
              providerPayload: {
                type: 'web_search_result_location',
                cited_text: 'source',
                url: 'https://anthropic.example/source',
                encrypted_index: 'opaque',
              },
            },
          ],
        },
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
                url: 'https://openai.example/source',
              },
            },
          ],
        },
      ],
    })
    const { wire } = toAnthropicMessages(settings(), [prior])
    expect(wire.messages[0]?.content).toEqual([
      {
        type: 'text',
        text: 'Claude source',
        citations: [
          {
            type: 'web_search_result_location',
            cited_text: 'source',
            url: 'https://anthropic.example/source',
            encrypted_index: 'opaque',
          },
        ],
      },
      { type: 'text', text: 'OpenAI source' },
    ])
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

    const { wire } = toAnthropicMessages(settings(), [prior, user('u2', 'continue')])
    const firstMessage = wire.messages[0]
    expect(firstMessage?.role).toBe('assistant')
    const content = firstMessage?.content
    if (!Array.isArray(content)) throw new Error('expected assistant content blocks')
    expect(content[0]).toEqual({
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'web_search',
      input: { query: 'docs' },
    })
    const textBlock = content.find((block) => block.type === 'text')
    expect(textBlock?.type).toBe('text')
    expect(typeof textBlock?.text).toBe('string')
    expect(textBlock?.text).toContain('<tool_call>')
    expect(JSON.stringify(wire)).toContain('Dialect: google-gemini')
  })

  it('keeps edited Anthropic provider tool blocks native', () => {
    const prior = assistant('a1', 'I searched.', {
      providerOutputItems: [
        {
          dialect: 'anthropic-claude',
          type: 'server_tool_use',
          edited: true,
          item: {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: { query: 'edited docs' },
          },
        },
      ],
    })

    const { wire } = toAnthropicMessages(settings(), [prior, user('u2', 'continue')])
    expect(wire.messages[0]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'edited docs' },
        },
        { type: 'text', text: 'I searched.' },
      ],
    })
    expect(JSON.stringify(wire)).not.toContain('<tool_call>')
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
    const { wire } = toAnthropicMessages(settings(), [prior])
    expect(wire.messages[0]?.content).toEqual([
      { type: 'thinking', thinking: 'signed thought', signature: 'sig-blob' },
      { type: 'text', text: 'Answer.' },
    ])
  })
})

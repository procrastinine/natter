import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  ChatSettings,
  ConnectionProfile,
  Message,
  MessageRole,
  ReasoningDetail,
} from '../../src/core/types'
import { continueAssistantInPlace } from '../../src/hooks/useContinue'
import { sendFromMessage, sendText } from '../../src/hooks/useChat'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { putCachedEndpoints } from '../../src/store/models-cache'
import {
  __resetPrivacyInFlightForTests,
  putCachedPrivacyPolicy,
} from '../../src/store/privacy-cache'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'
import { useUiStore } from '../../src/store/zustand/uiStore'

const DB_NAME = 'natter'

function makeProfile(): ConnectionProfile {
  return {
    id: 'prof',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'key-a',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost:5173',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function makeOpenAiProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function makeGoogleNativeProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-google',
    name: 'Google',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function makeAnthropicProfile(): ConnectionProfile {
  return {
    ...makeProfile(),
    id: 'prof-anthropic',
    name: 'Anthropic',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    supportsEndpointsApi: false,
    supportsGenerationApi: false,
    supportsPrivacyScrape: false,
  }
}

function chatSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  const base = cloneDefaultChatSettings()
  return {
    ...base,
    profileId: 'prof',
    model: 'openai/gpt-4o',
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
    ...overrides,
  }
}

async function reset() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetPrivacyInFlightForTests()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  useUiStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

async function* stream<T>(...chunks: T[]): AsyncGenerator<T> {
  for (const c of chunks) yield c
}

async function messagesFor(chatId: string): Promise<Message[]> {
  return getBrowserRepository().listMessages(chatId)
}

function requireDefined<T>(value: T | undefined, label: string): T {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error(`${label} missing`)
  return value
}

const LOREM_USER =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer posuere erat a ante.'
const LOREM_ASSISTANT =
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque.'
const LOREM_FOLLOWUP =
  'Quisque rutrum, aenean imperdiet etiam ultricies nisi vel augue curabitur ullamcorper.'
const SYSTEM_PROMPT =
  'System: answer with concise citations, preserve variables, and never drop the requested format.'
const APPEND_PROMPT = '\n\nAppend: verify assumptions and include the requested unit labels.'

interface SeedMessage {
  id: string
  role: MessageRole
  text: string
  origin?: Message['origin']
  reasoningDetails?: ReasoningDetail[]
}

async function seedLinearMessages(chatId: string, specs: readonly SeedMessage[]): Promise<Message[]> {
  const repo = getBrowserRepository()
  const rows: Message[] = []
  let parentId: string | null = null
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i] as SeedMessage
    const row: Message = {
      id: spec.id,
      chatId,
      parentId,
      siblingIndex: 0,
      turnId: `seed-turn-${i}`,
      turnIndex: i,
      createdAt: 100 + i,
      role: spec.role,
      origin: spec.origin ?? (spec.role === 'assistant' ? 'generated' : 'user'),
      content:
        spec.role === 'assistant'
          ? [{ type: 'output_text', text: spec.text }]
          : [{ type: 'text', text: spec.text }],
      nodeVersion: 0,
      deleted: false,
      ...(spec.reasoningDetails ? { reasoningDetails: spec.reasoningDetails } : {}),
    }
    await repo.runMutation(
      [
        { kind: 'message', messageId: row.id },
        { kind: 'children', chatId, parentId },
      ],
      async (ctx) => {
        await ctx.putMessage(row)
      },
    )
    rows.push(row)
    parentId = row.id
  }
  return rows
}

function captureChatDelta(
  capture: (wire: Record<string, unknown>) => void,
  text = 'ok',
): NonNullable<Parameters<typeof sendText>[0]['openStream']> {
  return (open) => {
    capture(open.wireBody)
    return stream({
      type: 'delta',
      chunk: {
        id: 'almost-live',
        choices: [{ delta: { content: text }, finish_reason: 'stop' }],
      },
    })
  }
}

async function warmOpenRouterPrivacy(modelId: string) {
  await putCachedEndpoints('prof', modelId, {
    id: modelId,
    endpoints: [
      {
        provider_name: 'Trusted Host',
        supported_parameters: ['temperature'],
        context_length: 200000,
        pricing: {},
      },
      {
        provider_name: 'Filtered Host',
        supported_parameters: ['temperature'],
        context_length: 200000,
        pricing: {},
      },
    ],
  })
  await putCachedPrivacyPolicy('prof', modelId, {
    policies: {
      'Trusted Host': {
        training: false,
        trainingOpenRouter: false,
        retainsPrompts: false,
        canPublish: false,
        termsOfServiceURL: '',
        privacyPolicyURL: '',
      },
      'Filtered Host': {
        training: false,
        trainingOpenRouter: false,
        retainsPrompts: true,
        requiresUserIDs: true,
        canPublish: false,
        termsOfServiceURL: '',
        privacyPolicyURL: '',
      },
    },
    fetchedAt: 0,
  })
}

beforeEach(async () => {
  await reset()
  await openDb()
})

afterEach(async () => {
  await reset()
})

describe('almost-live request shape matrix', () => {
  it('normal send captures seeded history, system prompt, append prompt, and assistant prefill', async () => {
    const modelId = 'google/gemini-3.1-flash-lite-preview'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
      }),
    })
    await seedLinearMessages(chat.id, [
      { id: 'seed-u1', role: 'user', text: LOREM_USER },
      { id: 'seed-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let wire: Record<string, unknown> | undefined
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: LOREM_FOLLOWUP }],
      prefillContent: [{ type: 'text', text: 'Prefilled opening sentence   ' }],
      openStream: captureChatDelta((captured) => {
        wire = captured
      }),
    })

    const messages = (wire as { messages?: Array<{ role: string; content: unknown }> }).messages
    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: LOREM_USER },
      { role: 'assistant', content: LOREM_ASSISTANT },
      { role: 'user', content: `${LOREM_FOLLOWUP}${APPEND_PROMPT}` },
      { role: 'assistant', content: 'Prefilled opening sentence' },
    ])
    expect(wire?.input).toBeUndefined()
    expect(wire?.provider).toMatchObject({ data_collection: 'deny' })
  })

  it('sendFromMessage captures the same append/system shape without creating another user turn', async () => {
    const modelId = 'google/gemini-3.1-flash-lite-preview'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
      }),
    })
    const [user] = await seedLinearMessages(chat.id, [
      { id: 'edit-u1', role: 'user', text: LOREM_USER },
    ])

    let wire: Record<string, unknown> | undefined
    await sendFromMessage({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      parentMessageId: requireDefined(user, 'seeded user').id,
      openStream: captureChatDelta((captured) => {
        wire = captured
      }),
    })

    const messages = (wire as { messages?: Array<{ role: string; content: unknown }> }).messages
    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${LOREM_USER}${APPEND_PROMPT}` },
    ])
  })

  it('legacy Continue captures continue prompts while append stays on the real user turn', async () => {
    const modelId = 'google/gemini-3.1-flash-lite-preview'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
        continueSystemPrompt: 'Continue the assistant text.\n\nOriginal system:\n[SYSTEM_PROMPT]',
        continueUserPrompt: 'Continue from the exact next token.',
      }),
    })
    const [, assistant] = await seedLinearMessages(chat.id, [
      { id: 'cont-u1', role: 'user', text: LOREM_USER },
      { id: 'cont-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let wire: Record<string, unknown> | undefined
    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: requireDefined(assistant, 'seeded assistant').id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        wire = open.wireBody
        return stream({
          type: 'delta',
          chunk: {
            id: 'almost-live-continue',
            choices: [{ delta: { content: ' continuation' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    const messages = (wire as { messages?: Array<{ role: string; content: unknown }> }).messages
    expect(messages).toEqual([
      {
        role: 'system',
        content: `Continue the assistant text.\n\nOriginal system:\n${SYSTEM_PROMPT}`,
      },
      { role: 'user', content: `${LOREM_USER}${APPEND_PROMPT}` },
      { role: 'assistant', content: LOREM_ASSISTANT },
      { role: 'user', content: 'Continue from the exact next token.' },
    ])
  })

  it('Continue prefill captures append plus visible reasoning context and omits continue prompts', async () => {
    const modelId = 'z-ai/glm-5.1'
    await warmOpenRouterPrivacy(modelId)
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
        continueSystemPrompt: 'THIS CONTINUE SYSTEM PROMPT MUST NOT BE SENT',
        continueUserPrompt: 'THIS CONTINUE USER PROMPT MUST NOT BE SENT',
        continuePrefill: true,
        reasoning: {
          mode: 'off',
          exclude: true,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
    })
    const [, assistant] = await seedLinearMessages(chat.id, [
      { id: 'prefill-u1', role: 'user', text: LOREM_USER },
      {
        id: 'prefill-a1',
        role: 'assistant',
        text: LOREM_ASSISTANT,
        reasoningDetails: [
          { type: 'reasoning.text', text: 'Visible lorem reasoning.' },
          { type: 'reasoning.text', text: 'Hidden lorem reasoning.', hidden: true },
          { type: 'reasoning.encrypted', data: 'opaque-carrier' },
        ],
      },
    ])

    let wire: Record<string, unknown> | undefined
    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: requireDefined(assistant, 'seeded assistant').id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        wire = open.wireBody
        return stream({
          type: 'delta',
          chunk: {
            id: 'almost-live-continue-prefill',
            choices: [{ delta: { content: ' continuation' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    const messages = (wire as { messages?: Array<{ role: string; content: unknown }> }).messages
    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${LOREM_USER}${APPEND_PROMPT}` },
      {
        role: 'assistant',
        content: `<think>\nVisible lorem reasoning.\n</think>\n\n${LOREM_ASSISTANT}`,
      },
    ])
    expect(JSON.stringify(wire)).not.toContain('THIS CONTINUE')
    expect(JSON.stringify(wire)).not.toContain('Hidden lorem reasoning.')
    expect(JSON.stringify(wire)).not.toContain('opaque-carrier')
  })

  it('Responses and Gemini native sends expose valid transport-specific request shapes', async () => {
    const openAiChat = await createChat({
      settings: chatSettings({
        profileId: 'prof-openai',
        model: 'gpt-5.4',
        api: 'responses',
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
      }),
    })
    await seedLinearMessages(openAiChat.id, [
      { id: 'resp-u1', role: 'user', text: LOREM_USER },
      { id: 'resp-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let responsesWire: Record<string, unknown> | undefined
    await sendText({
      chatId: openAiChat.id,
      connection: makeOpenAiProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: LOREM_FOLLOWUP }],
      openStream: captureChatDelta((captured) => {
        responsesWire = captured
      }),
    })

    expect(responsesWire?.instructions).toBe(SYSTEM_PROMPT)
    expect(responsesWire?.messages).toBeUndefined()
    expect(responsesWire?.provider).toBeUndefined()
    const responseInput = responsesWire?.input as Array<{
      type: string
      role?: string
      content?: Array<{ type: string; text?: string }>
    }>
    expect(responseInput.map((item) => item.role)).toEqual(['user', 'assistant', 'user'])
    expect(responseInput[2]?.content?.[0]?.text).toBe(`${LOREM_FOLLOWUP}${APPEND_PROMPT}`)

    const geminiChat = await createChat({
      settings: chatSettings({
        profileId: 'prof-google',
        model: 'google/gemini-3.1-flash-lite-preview',
        api: 'gemini-native',
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
      }),
    })
    await seedLinearMessages(geminiChat.id, [
      { id: 'gem-u1', role: 'user', text: LOREM_USER },
      { id: 'gem-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let geminiWire: Record<string, unknown> | undefined
    await sendText({
      chatId: geminiChat.id,
      connection: makeGoogleNativeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: LOREM_FOLLOWUP }],
      openStream: captureChatDelta((captured) => {
        geminiWire = captured
      }),
    })

    expect(geminiWire?.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: SYSTEM_PROMPT }],
    })
    expect(geminiWire?.messages).toBeUndefined()
    expect(geminiWire?.input).toBeUndefined()
    const contents = geminiWire?.contents as Array<{
      role: string
      parts: Array<{ text?: string }>
    }>
    expect(contents.map((item) => item.role)).toEqual(['user', 'model', 'user'])
    expect(contents[2]?.parts?.[0]?.text).toBe(`${LOREM_FOLLOWUP}${APPEND_PROMPT}`)
  })

  it('direct provider mode matrix exposes the expected request shape for every chat-owned API mode', async () => {
    async function capture(input: {
      profile: ConnectionProfile
      settings: Partial<ChatSettings>
    }): Promise<{
      route: string | undefined
      transport: string | undefined
      geminiModelId: string | undefined
      wire: Record<string, unknown>
    }> {
      const chat = await createChat({
        settings: chatSettings({
          profileId: input.profile.id,
          systemPrompt: SYSTEM_PROMPT,
          appendPrompt: APPEND_PROMPT,
          ...input.settings,
        }),
      })
      await seedLinearMessages(chat.id, [
        { id: `${chat.id}-u1`, role: 'user', text: LOREM_USER },
        { id: `${chat.id}-a1`, role: 'assistant', text: LOREM_ASSISTANT },
      ])

      let wire: Record<string, unknown> | undefined
      let route: string | undefined
      let transport: string | undefined
      let geminiModelId: string | undefined
      await sendText({
        chatId: chat.id,
        connection: input.profile,
        apiKey: 'sk-test',
        content: [{ type: 'text', text: LOREM_FOLLOWUP }],
        openStream: (open) => {
          wire = open.wireBody
          route = open.route?.kind
          transport = open.route?.transport
          geminiModelId = open.geminiModelId
          return stream({
            type: 'delta',
            chunk: {
              id: `${chat.id}-shape`,
              choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
            },
          })
        },
      })
      expect(wire).toBeDefined()
      return { route, transport, geminiModelId, wire: wire as Record<string, unknown> }
    }

    const openAiResponses = await capture({
      profile: makeOpenAiProfile(),
      settings: { model: 'gpt-5.4-nano', api: 'responses' },
    })
    expect(openAiResponses.route).toBe('responses')
    expect(openAiResponses.transport).toBe('openai-responses')
    expect(openAiResponses.wire.provider).toBeUndefined()
    expect(openAiResponses.wire.messages).toBeUndefined()
    expect(openAiResponses.wire.instructions).toBe(SYSTEM_PROMPT)
    expect(openAiResponses.wire.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'assistant' }),
      ]),
    )

    const openAiChat = await capture({
      profile: makeOpenAiProfile(),
      settings: { model: 'gpt-4o', api: 'chat' },
    })
    expect(openAiChat.route).toBe('chat-completions')
    expect(openAiChat.transport).toBe('openai-chat')
    expect(openAiChat.wire.provider).toBeUndefined()
    expect(openAiChat.wire.input).toBeUndefined()
    expect(openAiChat.wire.messages).toEqual(
      expect.arrayContaining([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: LOREM_USER },
        { role: 'assistant', content: LOREM_ASSISTANT },
        { role: 'user', content: `${LOREM_FOLLOWUP}${APPEND_PROMPT}` },
      ]),
    )

    const googleNative = await capture({
      profile: makeGoogleNativeProfile(),
      settings: {
        model: 'google/gemini-3.1-flash-lite-preview',
        api: 'gemini-native',
      },
    })
    expect(googleNative.route).toBe('gemini-generate')
    expect(googleNative.transport).toBe('gemini-native')
    expect(googleNative.geminiModelId).toBe('gemini-3.1-flash-lite-preview')
    expect(googleNative.wire.provider).toBeUndefined()
    expect(googleNative.wire.messages).toBeUndefined()
    expect(googleNative.wire.input).toBeUndefined()
    expect(googleNative.wire.systemInstruction).toEqual({
      role: 'system',
      parts: [{ text: SYSTEM_PROMPT }],
    })
    expect(googleNative.wire.contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({ role: 'model' }),
      ]),
    )

    const googleCompat = await capture({
      profile: makeGoogleNativeProfile(),
      settings: {
        model: 'google/gemini-3.1-flash-lite-preview',
        api: 'chat',
      },
    })
    expect(googleCompat.route).toBe('chat-completions')
    expect(googleCompat.transport).toBe('openai-chat')
    expect(googleCompat.wire.provider).toBeUndefined()
    expect(googleCompat.wire.contents).toBeUndefined()
    expect(googleCompat.wire.messages).toEqual(
      expect.arrayContaining([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: LOREM_USER },
        { role: 'assistant', content: LOREM_ASSISTANT },
        { role: 'user', content: `${LOREM_FOLLOWUP}${APPEND_PROMPT}` },
      ]),
    )

    const anthropicMessages = await capture({
      profile: makeAnthropicProfile(),
      settings: { model: 'claude-haiku-4.5', api: 'anthropic-messages' },
    })
    expect(anthropicMessages.route).toBe('anthropic-messages')
    expect(anthropicMessages.transport).toBe('anthropic')
    expect(anthropicMessages.wire.provider).toBeUndefined()
    expect(anthropicMessages.wire.input).toBeUndefined()
    expect(anthropicMessages.wire.system).toBe(SYSTEM_PROMPT)
    expect(anthropicMessages.wire.model).toBe('claude-haiku-4-5')
    const anthropicNativeMessages = anthropicMessages.wire.messages as Array<{
      role: string
      content: Array<{ type: string; text?: string }>
    }>
    expect(anthropicNativeMessages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
    expect(anthropicNativeMessages[0]?.content?.[0]?.text).toBe(LOREM_USER)
    expect(anthropicNativeMessages[1]?.content?.[0]?.text).toBe(LOREM_ASSISTANT)
    expect(anthropicNativeMessages[2]?.content?.[0]?.text).toBe(
      `${LOREM_FOLLOWUP}${APPEND_PROMPT}`,
    )

    const anthropicCompat = await capture({
      profile: makeAnthropicProfile(),
      settings: { model: 'claude-haiku-4.5', api: 'chat' },
    })
    expect(anthropicCompat.route).toBe('chat-completions')
    expect(anthropicCompat.transport).toBe('openai-chat')
    expect(anthropicCompat.wire.provider).toBeUndefined()
    expect(anthropicCompat.wire.input).toBeUndefined()
    expect(anthropicCompat.wire.model).toBe('claude-haiku-4-5')
    expect(anthropicCompat.wire.messages).toEqual(
      expect.arrayContaining([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: LOREM_USER },
        { role: 'assistant', content: LOREM_ASSISTANT },
        { role: 'user', content: `${LOREM_FOLLOWUP}${APPEND_PROMPT}` },
      ]),
    )
  })

  it('text-completions send captures a rendered prompt with the same rewritten context', async () => {
    const modelId = 'meta-llama/llama-3.3-70b-instruct'
    await putCachedEndpoints('prof', modelId, {
      id: modelId,
      endpoints: [
        {
          provider_name: 'Trusted Host',
          provider_slug: 'trusted-host',
          supported_parameters: ['provider', 'max_tokens', 'reasoning'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof', modelId, {
      policies: {
        'Trusted Host': {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        api: 'text',
        textTemplate: 'chatml',
        systemPrompt: SYSTEM_PROMPT,
        appendPrompt: APPEND_PROMPT,
        maxCompletionTokens: 64,
      }),
    })
    await seedLinearMessages(chat.id, [
      { id: 'text-u1', role: 'user', text: LOREM_USER },
      { id: 'text-a1', role: 'assistant', text: LOREM_ASSISTANT },
    ])

    let wire: Record<string, unknown> | undefined
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: LOREM_FOLLOWUP }],
      openStream: captureChatDelta((captured) => {
        wire = captured
      }),
    })

    expect(wire?.messages).toBeUndefined()
    expect(wire?.input).toBeUndefined()
    expect(wire?.prompt).toContain(`<|im_start|>system\n${SYSTEM_PROMPT}<|im_end|>`)
    expect(wire?.prompt).toContain(`<|im_start|>user\n${LOREM_USER}<|im_end|>`)
    expect(wire?.prompt).toContain(`<|im_start|>assistant\n${LOREM_ASSISTANT}<|im_end|>`)
    expect(wire?.prompt).toContain(`<|im_start|>user\n${LOREM_FOLLOWUP}${APPEND_PROMPT}<|im_end|>`)
    expect(wire?.max_tokens).toBe(64)
  })
})

describe('send action routing', () => {
  it('sendFromMessage reuses the same privacy/provider selection workflow as normal sends', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({ settings: chatSettings() })
    let initialWire: Record<string, unknown> | undefined
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: (open) => {
        initialWire = open.wireBody
        return stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'seed' }, finish_reason: 'stop' }],
          },
        })
      },
    })
    expect((initialWire as { provider?: { ignore?: string[] } }).provider?.ignore).toContain(
      'Filtered Host',
    )
    const rows = await messagesFor(chat.id)
    const user = requireDefined(
      rows.find((m) => m.role === 'user'),
      'user message',
    )

    let seenWire: Record<string, unknown> | undefined
    await sendFromMessage({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      parentMessageId: user.id,
      openStream: (open) => {
        seenWire = open.wireBody
        return stream({
          type: 'delta',
          chunk: {
            id: 'regen',
            choices: [{ delta: { content: 'regen' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire).toBeDefined()
    expect((seenWire as { provider?: { ignore?: string[] } }).provider?.ignore).toContain(
      'Filtered Host',
    )
    expect((seenWire as { provider?: { ignore?: string[] } }).provider?.ignore).not.toContain(
      'Trusted Host',
    )
  })

  it('sendText applies zero-eligible provider selection before creating the user row', async () => {
    const modelId = 'openai/gpt-4o'
    await putCachedEndpoints('prof', modelId, {
      id: modelId,
      endpoints: [
        {
          provider_name: 'Only Trainer',
          supported_parameters: ['temperature'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof', modelId, {
      policies: {
        'Only Trainer': {
          training: true,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const chat = await createChat({ settings: chatSettings({ model: modelId }) })

    await expect(
      sendText({
        chatId: chat.id,
        connection: makeProfile(),
        apiKey: 'sk-test',
        content: [{ type: 'text', text: 'hello' }],
        openStream: () =>
          stream({
            type: 'delta',
            chunk: {
              id: 'should-not-open',
              choices: [{ delta: { content: 'nope' }, finish_reason: 'stop' }],
            },
          }),
      }),
    ).rejects.toThrow('No eligible providers can serve this request.')

    expect(useUiStore.getState().zeroEligibleChatId).toBe(chat.id)
    expect(await messagesFor(chat.id)).toEqual([])
  })

  it('continueAssistantInPlace does not add the original system prompt when the template has no placeholder in double-assistant mode', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({
      settings: chatSettings({
        systemPrompt: 'ORIGINAL SYSTEM PROMPT SHOULD NOT APPEAR',
        continueSystemPrompt: 'Continue exactly from the last assistant message.',
        continueUserPrompt: '',
      }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
          },
        }),
    })
    const rows = await messagesFor(chat.id)
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )

    let seenWire: Record<string, unknown> | undefined
    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        seenWire = open.wireBody
        return stream({
          type: 'delta',
          chunk: {
            id: 'continue',
            choices: [{ delta: { content: ' more' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire).toBeDefined()
    expect((seenWire as { provider?: { ignore?: string[] } }).provider?.ignore).toContain(
      'Filtered Host',
    )
    const chatMessages = (seenWire as {
      messages?: Array<{ role: string; content: string }>
    }).messages
    const responseInput = (seenWire as {
      input?: Array<{
        type: string
        role?: string
        content?: Array<{ type: string; text?: string }>
      }>
      instructions?: string
    }).input
    if (chatMessages) {
      expect(chatMessages).toEqual([
        {
          role: 'system',
          content: 'Continue exactly from the last assistant message.',
        },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'partial' },
      ])
    } else {
      expect((seenWire as { instructions?: string }).instructions).toBe(
        'Continue exactly from the last assistant message.',
      )
      expect(responseInput).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'partial' }],
        },
      ])
    }
    expect(JSON.stringify(seenWire)).not.toContain('ORIGINAL SYSTEM PROMPT SHOULD NOT APPEAR')
    const updated = await getBrowserRepository().getMessage(assistant.id)
    expect(updated?.content).toEqual([{ type: 'output_text', text: 'partial more' }])
    expect(updated?.originalCharCount).toBe('partial'.length)
    expect(updated?.charCountDelta).toBe(' more'.length)
    expect(updated?.cachedTokenEstimate).toBeGreaterThan(0)
  })

  it('continueAssistantInPlace expands [SYSTEM_PROMPT] verbatim inside the system template', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({
      settings: chatSettings({
        systemPrompt: 'ORIGINAL SYSTEM PROMPT SHOULD APPEAR IN A CODE BLOCK',
        continueSystemPrompt:
          'Continue exactly from the last assistant message.\n\nThe original system prompt (for reference):\n```\n[SYSTEM_PROMPT]\n```',
        continueUserPrompt: '',
      }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
          },
        }),
    })
    const rows = await messagesFor(chat.id)
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )

    let seenWire: Record<string, unknown> | undefined
    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        seenWire = open.wireBody
        return stream({
          type: 'delta',
          chunk: {
            id: 'continue',
            choices: [{ delta: { content: ' more' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    const expectedTemplate =
      'Continue exactly from the last assistant message.\n\nThe original system prompt (for reference):\n```\nORIGINAL SYSTEM PROMPT SHOULD APPEAR IN A CODE BLOCK\n```'
    const chatMessages = (seenWire as {
      messages?: Array<{ role: string; content: string }>
    }).messages
    if (chatMessages) {
      expect(chatMessages[0]).toEqual({ role: 'system', content: expectedTemplate })
    } else {
      expect((seenWire as { instructions?: string }).instructions).toBe(expectedTemplate)
    }
  })

  it('continueAssistantInPlace supports a synthetic user prompt with no system prompt when the template is blank', async () => {
    await warmOpenRouterPrivacy('openai/gpt-4o')
    const chat = await createChat({
      settings: chatSettings({
        systemPrompt: 'ORIGINAL SYSTEM PROMPT SHOULD APPEAR',
        continueSystemPrompt: '',
        continueUserPrompt: 'Now only continue the last assistant message.',
      }),
    })
    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
          },
        }),
    })
    const rows = await messagesFor(chat.id)
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )

    let seenWire: Record<string, unknown> | undefined
    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        seenWire = open.wireBody
        return stream({
          type: 'delta',
          chunk: {
            id: 'continue',
            choices: [{ delta: { content: ' more' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire).toBeDefined()
    expect((seenWire as { provider?: { ignore?: string[] } }).provider?.ignore).toContain(
      'Filtered Host',
    )
    const chatMessages = (seenWire as {
      messages?: Array<{ role: string; content: string }>
    }).messages
    const responseInput = (seenWire as {
      input?: Array<{
        type: string
        role?: string
        content?: Array<{ type: string; text?: string }>
      }>
      instructions?: string
    }).input
    if (chatMessages) {
      expect(chatMessages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'partial' },
        { role: 'user', content: 'Now only continue the last assistant message.' },
      ])
    } else {
      expect((seenWire as { instructions?: string }).instructions ?? '').toBe('')
      expect(responseInput).toEqual([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'partial' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Now only continue the last assistant message.' }],
        },
      ])
    }
    expect(JSON.stringify(seenWire)).not.toContain('Continue exactly from the last assistant message.')
    expect(JSON.stringify(seenWire)).not.toContain('ORIGINAL SYSTEM PROMPT SHOULD APPEAR')
    const updated = await getBrowserRepository().getMessage(assistant.id)
    expect(updated?.content).toEqual([{ type: 'output_text', text: 'partial more' }])
  })

  it('continueAssistantInPlace prefill mode skips continue prompts without auto-configuring settings', async () => {
    const modelId = 'z-ai/glm-5.1'
    await putCachedEndpoints('prof', modelId, {
      id: modelId,
      endpoints: [
        {
          provider_name: 'DeepInfra',
          provider_slug: 'deepinfra',
          supported_parameters: ['temperature', 'reasoning'],
          context_length: 200000,
          pricing: {},
        },
      ],
    })
    await putCachedPrivacyPolicy('prof', modelId, {
      policies: {
        DeepInfra: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
        deepinfra: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
      fetchedAt: 0,
    })
    const chat = await createChat({
      settings: chatSettings({
        model: modelId,
        systemPrompt: 'ORIGINAL SYSTEM PROMPT',
        continueSystemPrompt: 'CONTINUE SYSTEM PROMPT SHOULD NOT APPEAR',
        continueUserPrompt: 'CONTINUE USER PROMPT SHOULD NOT APPEAR',
        continuePrefill: true,
        reasoning: {
          mode: 'default',
          exclude: false,
          summary: 'off',
          include: { encrypted: false, summary: false, text: false },
        },
      }),
    })

    await sendText({
      chatId: chat.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'hello' }],
      openStream: () =>
        stream({
          type: 'delta',
          chunk: {
            id: 'seed',
            choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }],
          },
        }),
    })
    const rows = await messagesFor(chat.id)
    const assistant = requireDefined(
      rows.find((m) => m.role === 'assistant'),
      'assistant message',
    )

    let seenWire: Record<string, unknown> | undefined
    await continueAssistantInPlace({
      chatId: chat.id,
      targetMessageId: assistant.id,
      connection: makeProfile(),
      apiKey: 'sk-test',
      openStream: (open) => {
        seenWire = open.wireBody
        return stream({
          type: 'delta',
          chunk: {
            id: 'continue-prefill',
            choices: [{ delta: { content: ' more' }, finish_reason: 'stop' }],
          },
        })
      },
    })

    expect(seenWire).toBeDefined()
    expect((seenWire as { messages?: Array<{ role: string; content: string }> }).messages).toEqual([
      { role: 'system', content: 'ORIGINAL SYSTEM PROMPT' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial' },
    ])
    expect(JSON.stringify(seenWire)).not.toContain('CONTINUE SYSTEM PROMPT SHOULD NOT APPEAR')
    expect(JSON.stringify(seenWire)).not.toContain('CONTINUE USER PROMPT SHOULD NOT APPEAR')
    expect((seenWire as { reasoning?: unknown }).reasoning).toBeUndefined()
    expect((seenWire as { provider?: { only?: string[] } }).provider?.only).toBeUndefined()
    const storedChat = await getBrowserRepository().getChat(chat.id)
    expect(storedChat?.settings.reasoning.mode).toBe('default')
    expect(storedChat?.settings.providerPrefs?.only).toBeUndefined()
    const finalRows = await messagesFor(chat.id)
    expect(finalRows.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect((await getBrowserRepository().getMessage(assistant.id))?.content).toEqual([
      { type: 'output_text', text: 'partial more' },
    ])
  })
})

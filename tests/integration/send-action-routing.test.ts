import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatStreamChunk } from '../../src/api/types'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
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
    usesResponsesApiByDefault: false,
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: true,
    createdAt: 1,
    updatedAt: 1,
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
      carryForward: 'off',
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
        } as ChatStreamChunk)
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
        } as ChatStreamChunk)
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
        } as ChatStreamChunk)
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
          carryForward: 'off',
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
        } as ChatStreamChunk),
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
        } as ChatStreamChunk)
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

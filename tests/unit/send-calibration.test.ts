import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import type { ChatCompletionUsageWire } from '../../src/api/types'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import { readTokenCalibrationGlobal } from '../../src/core/token-calibration'
import type { CapabilityDescriptor } from '../../src/core/types'
import { sendText } from '../../src/hooks/useChat'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { createKey } from '../../src/store/keys'
import { putCachedEndpoints } from '../../src/store/models-cache'
import { createProfile } from '../../src/store/profiles'
import { __resetStreamLeasesForTests } from '../../src/store/stream-leases'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'

const DB_NAME = 'natter'

const TEXT_CAPABILITIES: CapabilityDescriptor = {
  supportedParameters: ['tools'],
  streaming: 'supported',
  contextLength: 8_192,
  architecture: {
    inputModalities: ['text'],
    outputModalities: ['text'],
  },
}

const MULTIMODAL_CAPABILITIES: CapabilityDescriptor = {
  ...TEXT_CAPABILITIES,
  architecture: {
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
  },
}

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  __resetStreamLeasesForTests()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

async function seedChat(opts: { tools?: boolean } = {}) {
  const key = await createKey({ name: 'OpenRouter', plaintextKey: 'sk-test' })
  const profile = await createProfile({
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: key.id,
  })
  await putCachedEndpoints(profile.id, 'openai/gpt-4o', {
    id: 'openai/gpt-4o',
    endpoints: [
      {
        provider_name: 'Test Provider',
        supported_parameters: ['tools', 'provider', 'tool_choice'],
        context_length: 8_192,
        pricing: {},
        data_policy: {
          training: false,
          trainingOpenRouter: false,
          retainsPrompts: false,
          canPublish: false,
          termsOfServiceURL: '',
          privacyPolicyURL: '',
        },
      },
    ],
  })
  const settings = cloneDefaultChatSettings()
  settings.profileId = profile.id
  settings.model = 'openai/gpt-4o'
  if (opts.tools) {
    settings.tools = {
      ...settings.tools,
      openrouter: {
        ...settings.tools.openrouter,
        enabledServerToolIds: ['web-search'],
      },
    }
  }
  const chat = await createChat({ id: opts.tools ? 'chat-tools' : 'chat-text', settings })
  return { chat, profile }
}

function streamText(text: string, usage: ChatCompletionUsageWire, finishReason = 'stop') {
  return async function* (): AsyncIterable<AssistantStreamChunk> {
    if (text.length > 0) {
      yield {
        type: 'delta',
        chunk: {
          id: 'gen-test',
          model: 'openai/gpt-4o',
          choices: [{ delta: { content: text } }],
        },
      }
    }
    yield {
      type: 'delta',
      chunk: {
        id: 'gen-test',
        model: 'openai/gpt-4o',
        choices: [{ finish_reason: finishReason }],
        usage,
      },
    }
  }
}

describe('sendText token calibration gates', () => {
  beforeEach(async () => {
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    await resetAll()
    await openDb()
  })

  afterEach(async () => {
    await resetAll()
  })

  it('calibrates prompt and completion for completed text-only requests', async () => {
    const { chat, profile } = await seedChat()

    await sendText({
      chatId: chat.id,
      connection: profile,
      apiKey: 'sk-test',
      capabilities: TEXT_CAPABILITIES,
      content: [{ type: 'text', text: 'a'.repeat(400) }],
      openStream: streamText('b'.repeat(200), {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      }),
    })

    const stored = await getDb().chats.get(chat.id)
    const calibrationKey = tokenCalibrationKey('openai/gpt-4o')
    expect(stored?.tokenCalibration?.[calibrationKey]?.sampleCount).toBe(2)
    const global = await readTokenCalibrationGlobal()
    expect(global.byModel[calibrationKey]?.sampleCount).toBe(2)
    const assistant = (await getDb().messages.where('chatId').equals(chat.id).toArray()).find(
      (message) => message.role === 'assistant',
    )
    expect(assistant?.generation?.tokenCalibration).toMatchObject({
      calibrationKey,
      promptSample: true,
      completionSample: true,
      sampleCount: 2,
    })
  })

  it('calibrates only completion when tool schemas are present but no tool call happens', async () => {
    const { chat, profile } = await seedChat({ tools: true })

    await sendText({
      chatId: chat.id,
      connection: profile,
      apiKey: 'sk-test',
      capabilities: TEXT_CAPABILITIES,
      content: [{ type: 'text', text: 'a'.repeat(400) }],
      openStream: streamText('b'.repeat(200), {
        prompt_tokens: 140,
        completion_tokens: 50,
        total_tokens: 190,
      }),
    })

    const stored = await getDb().chats.get(chat.id)
    const calibrationKey = tokenCalibrationKey('openai/gpt-4o')
    expect(stored?.tokenCalibration?.[calibrationKey]?.sampleCount).toBe(1)
    const assistant = (await getDb().messages.where('chatId').equals(chat.id).toArray()).find(
      (message) => message.role === 'assistant',
    )
    expect(assistant?.generation?.tokenCalibration).toMatchObject({
      calibrationKey,
      promptSample: false,
      completionSample: true,
      sampleCount: 1,
    })
  })

  it('calibrates only completion for multimodal context with text-only output', async () => {
    const { chat, profile } = await seedChat()

    await sendText({
      chatId: chat.id,
      connection: profile,
      apiKey: 'sk-test',
      capabilities: MULTIMODAL_CAPABILITIES,
      content: [
        { type: 'text', text: 'a'.repeat(400) },
        { type: 'image_url', url: 'https://example.com/image.png' },
      ],
      openStream: streamText('b'.repeat(200), {
        prompt_tokens: 180,
        completion_tokens: 50,
        total_tokens: 230,
      }),
    })

    const stored = await getDb().chats.get(chat.id)
    expect(stored?.tokenCalibration?.[tokenCalibrationKey('openai/gpt-4o')]?.sampleCount).toBe(1)
  })

  it('does not calibrate a request that finishes with a tool call', async () => {
    const { chat, profile } = await seedChat({ tools: true })

    await sendText({
      chatId: chat.id,
      connection: profile,
      apiKey: 'sk-test',
      capabilities: TEXT_CAPABILITIES,
      content: [{ type: 'text', text: 'a'.repeat(400) }],
      openStream: streamText(
        '',
        {
          prompt_tokens: 140,
          completion_tokens: 50,
          total_tokens: 190,
        },
        'tool_calls',
      ),
    })

    const stored = await getDb().chats.get(chat.id)
    expect(stored?.tokenCalibration).toBeUndefined()
    const global = await readTokenCalibrationGlobal()
    expect(global.byModel[tokenCalibrationKey('openai/gpt-4o')]).toBeUndefined()
  })

  it('does not calibrate a request that reports server tool usage', async () => {
    const { chat, profile } = await seedChat({ tools: true })

    await sendText({
      chatId: chat.id,
      connection: profile,
      apiKey: 'sk-test',
      capabilities: TEXT_CAPABILITIES,
      content: [{ type: 'text', text: 'a'.repeat(400) }],
      openStream: streamText('b'.repeat(200), {
        prompt_tokens: 140,
        completion_tokens: 50,
        total_tokens: 190,
        server_tool_use: { web_search: 1 },
      }),
    })

    const stored = await getDb().chats.get(chat.id)
    expect(stored?.tokenCalibration).toBeUndefined()
    const assistant = (await getDb().messages.where('chatId').equals(chat.id).toArray()).find(
      (message) => message.role === 'assistant',
    )
    expect(assistant?.generation?.tokenCalibration).toBeUndefined()
  })
})

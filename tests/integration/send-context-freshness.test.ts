import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatStreamChunk } from '../../src/api/types'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { editMessageContent, insertSibling, sendUserMessage } from '../../src/core/messages'
import type { ChatSettings, ConnectionProfile, Message } from '../../src/core/types'
import { sendFromMessage, sendText } from '../../src/hooks/useChat'
import { continueAssistantInPlace } from '../../src/hooks/useContinue'
import { __resetBroadcastForTests, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat, touchLastViewed, updateChatSettings } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { assertSendContextFresh, StaleSendContextError } from '../../src/store/send-context'
import { __resetStreamLeasesForTests } from '../../src/store/stream-leases'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'

const DB_NAME = 'natter'
const MODEL = 'google/gemini-3.1-flash-lite-preview'

function profile(): ConnectionProfile {
  return {
    id: 'freshness-profile',
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyRef: 'freshness-key',
    defaultHeaders: {},
    appTitle: 'natter',
    appUrl: 'http://localhost:5173',
    supportsEndpointsApi: true,
    supportsGenerationApi: true,
    supportsPrivacyScrape: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...cloneDefaultChatSettings(),
    profileId: profile().id,
    model: MODEL,
    reasoning: {
      mode: 'off',
      exclude: false,
      summary: 'off',
      include: { encrypted: false, summary: false, text: false },
    },
    ...overrides,
  }
}

const endpointsPayload = {
  id: MODEL,
  endpoints: [
    {
      provider_name: 'Freshness Test Provider',
      provider_slug: 'freshness-test-provider',
      supported_parameters: ['temperature'],
      context_length: 200_000,
      pricing: {},
      data_policy: {
        training: false,
        training_openrouter: false,
        retains_prompts: false,
        can_publish: false,
      },
    },
  ],
}

interface DiscoveryGate {
  started: Promise<void>
  release: () => void
}

function delayEndpointDiscovery(): DiscoveryGate {
  let markStarted!: () => void
  let releaseFetch!: (response: Response) => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const response = new Promise<Response>((resolve) => {
    releaseFetch = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string | URL | Request) => {
      const href = url instanceof Request ? url.url : String(url)
      if (!href.includes('/endpoints')) throw new Error(`Unexpected fetch during test: ${href}`)
      markStarted()
      return response
    }),
  )
  return {
    started,
    release: () => {
      releaseFetch(
        new Response(JSON.stringify(endpointsPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    },
  }
}

async function* completedStream(text = 'done'): AsyncGenerator<ChatStreamChunk> {
  yield {
    type: 'delta',
    chunk: {
      id: 'freshness-generation',
      choices: [{ delta: { content: text }, finish_reason: 'stop' }],
    },
  }
}

async function clearEndpointCache(): Promise<void> {
  await getDb().endpoints.delete([profile().id, MODEL])
}

async function reset(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  __resetStreamLeasesForTests()
  useChatStore.getState().reset()
  useStreamStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await reset()
  await openDb()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await reset()
})

async function seedAssistantBranch(): Promise<{
  chatId: string
  user: Message
  assistant: Message
}> {
  const chat = await createChat({ settings: settings() })
  const sent = await sendUserMessage({
    chatId: chat.id,
    expectedLeafId: null,
    content: [{ type: 'text', text: 'question' }],
    now: 1,
    messageId: 'freshness-user',
    turnId: 'freshness-user-turn',
  })
  const user = await getBrowserRepository().getMessage(sent.messageId)
  if (!user) throw new Error('seed user missing')
  const assistant: Message = {
    id: 'freshness-assistant',
    chatId: chat.id,
    parentId: user.id,
    siblingIndex: 0,
    turnId: 'freshness-assistant-turn',
    turnIndex: 0,
    createdAt: 2,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'partial' }],
    nodeVersion: 0,
    deleted: false,
  }
  await getBrowserRepository().runMutation(
    [
      { kind: 'message', messageId: assistant.id },
      { kind: 'children', chatId: chat.id, parentId: user.id },
    ],
    async (ctx) => ctx.putMessage(assistant),
  )
  return { chatId: chat.id, user, assistant }
}

describe('send-context freshness', () => {
  it('rejects a same-chat insert during delayed send planning before creating a placeholder', async () => {
    const chat = await createChat({ settings: settings() })
    await clearEndpointCache()
    const discovery = delayEndpointDiscovery()
    const openStream = vi.fn(() => completedStream())
    const send = sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'original question' }],
      openStream,
    })

    await discovery.started
    const user = (await getBrowserRepository().listMessages(chat.id)).find(
      (message) => message.role === 'user',
    )
    if (!user) throw new Error('sent user missing')
    await insertSibling({
      chatId: chat.id,
      targetId: user.id,
      content: [{ type: 'text', text: 'concurrent sibling' }],
    })
    discovery.release()

    await expect(send).rejects.toBeInstanceOf(StaleSendContextError)
    expect(openStream).not.toHaveBeenCalled()
    expect(
      (await getBrowserRepository().listMessages(chat.id)).filter((m) => m.role === 'assistant'),
    ).toEqual([])
  })

  it('rejects a parent edit during delayed send-from-message planning', async () => {
    const chat = await createChat({ settings: settings() })
    const sent = await sendUserMessage({
      chatId: chat.id,
      expectedLeafId: null,
      content: [{ type: 'text', text: 'before edit' }],
    })
    await clearEndpointCache()
    const discovery = delayEndpointDiscovery()
    const openStream = vi.fn(() => completedStream())
    const send = sendFromMessage({
      chatId: chat.id,
      parentMessageId: sent.messageId,
      connection: profile(),
      apiKey: 'sk-test',
      openStream,
    })

    await discovery.started
    await editMessageContent({
      chatId: chat.id,
      messageId: sent.messageId,
      content: [{ type: 'text', text: 'after edit' }],
    })
    discovery.release()

    await expect(send).rejects.toBeInstanceOf(StaleSendContextError)
    expect(openStream).not.toHaveBeenCalled()
    expect(
      (await getBrowserRepository().listMessages(chat.id)).filter((m) => m.role === 'assistant'),
    ).toEqual([])
  })

  it('rejects a settings change during delayed send planning', async () => {
    const chat = await createChat({ settings: settings() })
    await clearEndpointCache()
    const discovery = delayEndpointDiscovery()
    const openStream = vi.fn(() => completedStream())
    const send = sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'question' }],
      openStream,
    })

    await discovery.started
    await updateChatSettings(chat.id, { sampling: { temperature: 0.25 } })
    discovery.release()

    await expect(send).rejects.toBeInstanceOf(StaleSendContextError)
    expect(openStream).not.toHaveBeenCalled()
    expect(
      (await getBrowserRepository().listMessages(chat.id)).filter((m) => m.role === 'assistant'),
    ).toEqual([])
  })

  it('revalidates after the placeholder commits and before the lazy provider opens', async () => {
    const chat = await createChat({ settings: settings() })
    const openStream = vi.fn(() => completedStream())
    let messageMutationCount = 0
    let concurrentUpdate: Promise<void> | undefined
    const unsubscribe = onEvent((event) => {
      if (event.kind !== 'chat-mutated' || event.chatId !== chat.id) return
      if (!event.affected.some((affected) => affected.kind === 'message')) return
      messageMutationCount += 1
      if (messageMutationCount === 2) {
        const db = getDb()
        concurrentUpdate = db.transaction('rw', db.chats, async () => {
          const current = await db.chats.get(chat.id)
          if (!current) throw new Error('chat disappeared during dispatch-race test')
          await db.chats.put({
            ...current,
            settings: { ...current.settings, sampling: { temperature: 0.75 } },
            updatedAt: current.updatedAt + 1,
            metaVersion: current.metaVersion + 1,
            summaryVersion: current.summaryVersion + 1,
          })
        })
      }
    })

    const send = sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'question' }],
      openStream,
    })

    await expect(send).rejects.toBeInstanceOf(StaleSendContextError)
    unsubscribe()
    await concurrentUpdate
    expect(openStream).not.toHaveBeenCalled()
    expect(useStreamStore.getState().listByChat(chat.id)).toEqual([])
    await vi.waitFor(async () => {
      expect(await getBrowserRepository().listStreamLeases(chat.id)).toEqual([])
      expect(await getBrowserRepository().listStreamChunksForChat(chat.id)).toEqual([])
    })
  })

  it('does not invalidate for another chat or a hidden last-viewed update', async () => {
    const chat = await createChat({ settings: settings() })
    const unrelated = await createChat({ settings: settings() })
    await clearEndpointCache()
    const discovery = delayEndpointDiscovery()
    const openStream = vi.fn(() => completedStream('answer'))
    const send = sendText({
      chatId: chat.id,
      connection: profile(),
      apiKey: 'sk-test',
      content: [{ type: 'text', text: 'question' }],
      openStream,
    })

    await discovery.started
    await updateChatSettings(unrelated.id, { sampling: { temperature: 0.5 } })
    await touchLastViewed(chat.id, Date.now() + 10_000)
    discovery.release()

    await expect(send).resolves.toMatchObject({ outcome: 'done' })
    expect(openStream).toHaveBeenCalledTimes(1)
  })

  it.each([
    'target',
    'ancestor',
  ] as const)('rejects a Continue %s edit during delayed planning without opening', async (changedMessage) => {
    const { chatId, user, assistant } = await seedAssistantBranch()
    await clearEndpointCache()
    const discovery = delayEndpointDiscovery()
    const openStream = vi.fn(() => completedStream(' continued'))
    const continuation = continueAssistantInPlace({
      chatId,
      targetMessageId: assistant.id,
      connection: profile(),
      apiKey: 'sk-test',
      openStream,
    })

    await discovery.started
    const messageId = changedMessage === 'target' ? assistant.id : user.id
    await editMessageContent({
      chatId,
      messageId,
      content: [
        {
          type: changedMessage === 'target' ? 'output_text' : 'text',
          text: `${changedMessage} changed`,
        },
      ],
    })
    discovery.release()

    await expect(continuation).rejects.toBeInstanceOf(StaleSendContextError)
    expect(openStream).not.toHaveBeenCalled()
    expect(
      (await getBrowserRepository().getMessage(assistant.id))?.continuationAttempts,
    ).toBeUndefined()
  })

  it('checks the final summary version without reading message bodies', async () => {
    const chat = await createChat({ settings: settings() })
    const bodyGet = vi.spyOn(getDb().messageBodies, 'get')
    const bodyBulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')

    await expect(assertSendContextFresh(chat.id, chat.summaryVersion)).resolves.toBeUndefined()

    expect(bodyGet).not.toHaveBeenCalled()
    expect(bodyBulkGet).not.toHaveBeenCalled()
  })
})

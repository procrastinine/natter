import { fireEvent, render, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { useLiveQuery } from 'dexie-react-hooks'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectiveCapabilityFromEndpoints } from '../../src/core/capabilities'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message, MessageAttachmentRef, ModelEndpoint } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat, getChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { ContextPanel } from '../../src/ui/settings/ContextPanel'
import { putTestMessages } from '../helpers/message-storage'

const DB_NAME = 'natter'

function makeEndpoint(overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name: 'OpenAI',
    supported_parameters: ['max_tokens'],
    context_length: 128000,
    max_prompt_tokens: 128000,
    max_completion_tokens: 8192,
    pricing: {},
    ...overrides,
  }
}

function attachmentRef(attachmentId: string): MessageAttachmentRef {
  return {
    refId: `ref-${attachmentId}`,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function userMessage(chatId: string): Message {
  return {
    id: 'u1',
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: 't1',
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: 'look' }],
    attachmentRefs: [attachmentRef('att-1')],
    nodeVersion: 0,
    deleted: false,
  }
}

function assistantMessage(chatId: string): Message {
  return {
    id: 'a1',
    chatId,
    parentId: 'u1',
    siblingIndex: 0,
    turnId: 't1',
    turnIndex: 1,
    createdAt: 2,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'a cat' }],
    generation: {
      id: 'gen-1',
      model: 'openai/gpt-4o-mini',
      requestedModel: 'openai/gpt-4o-mini',
      apiUsed: 'chat',
      delivery: 'streaming',
      usage: { prompt_tokens: 1200, completion_tokens: 4, total_tokens: 1204 },
      costSource: 'stream',
      startedAt: 1,
    },
    nodeVersion: 0,
    deleted: false,
  }
}

function LiveContextPanel({
  chatId,
  capability,
}: {
  chatId: string
  capability: ReturnType<typeof effectiveCapabilityFromEndpoints>
}) {
  const chat = useLiveQuery(() => getChat(chatId), [chatId], undefined)
  if (!chat) return null
  return <ContextPanel chat={chat as Chat} capability={capability} endpointTokenizer={null} />
}

async function resetAll() {
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('ContextPanel slider persistence', () => {
  it('does not persist max context on every drag tick, only after the value settles', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o-mini'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const { container } = render(
      <ContextPanel chat={chat} capability={capability} endpointTokenizer={null} />,
    )

    const sliders = container.querySelectorAll<HTMLInputElement>('[data-ui="slider"]')
    const maxContext = sliders[0]
    expect(maxContext).toBeTruthy()
    fireEvent.change(maxContext as HTMLInputElement, { target: { value: '4096' } })

    expect((await getChat(chat.id))?.settings.customMaxContext).toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 250))
    await waitFor(async () => {
      expect((await getChat(chat.id))?.settings.customMaxContext).toBe(4096)
    })
  })

  it('uses the same estimator when Files is switched Off', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o-mini'
    const chat = await createChat({ settings })
    await putTestMessages([userMessage(chat.id), assistantMessage(chat.id)])
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const { container, getByRole } = render(
      <LiveContextPanel chatId={chat.id} capability={capability} />,
    )

    await waitFor(() => {
      expect(container.textContent).toContain('media')
    })
    const initialUsed = Number(
      container
        .querySelector('[data-ui="context-gauge-label"] strong')
        ?.textContent?.replaceAll(',', ''),
    )
    expect(initialUsed).toBeGreaterThan(1000)

    fireEvent.click(getByRole('button', { name: 'Off' }))

    await waitFor(() => {
      expect(container.textContent).not.toContain('media')
    })
    const afterOff = Number(
      container
        .querySelector('[data-ui="context-gauge-label"] strong')
        ?.textContent?.replaceAll(',', ''),
    )
    expect(initialUsed - afterOff).toBe(1000)
  })
})

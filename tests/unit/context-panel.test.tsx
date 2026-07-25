import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { useEffect, useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectiveCapabilityFromEndpoints } from '../../src/core/capabilities'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { estimateSettingsPromptSize, type PromptSizeEstimate } from '../../src/core/prompt-size'
import type { Attachment, Message, MessageAttachmentRef, ModelEndpoint } from '../../src/core/types'
import { splitAttachmentForStorage } from '../../src/store/attachment-storage'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { getChat } from '../../src/store/chats'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { __resetLockTrackerForTests, withMutationLocks } from '../../src/store/locks'
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
      reasoningCarryForward: 'none',
      reasoningVisibility: { disclosure: 'unknown' },
      startedAt: 1,
    },
    nodeVersion: 0,
    deleted: false,
  }
}

function LiveContextPanel({
  initialChat,
  branch,
  capability,
}: {
  initialChat: Awaited<ReturnType<typeof createChat>>
  branch: readonly Message[]
  capability: ReturnType<typeof effectiveCapabilityFromEndpoints>
}) {
  const [chat, setChat] = useState(initialChat)
  useEffect(
    () =>
      subscribeWorkspaceChanges(() => {
        void getChat(initialChat.id).then((next) => {
          if (next) setChat(next)
        })
      }),
    [initialChat.id],
  )
  const estimate = useMemo<PromptSizeEstimate>(
    () =>
      estimateSettingsPromptSize(
        chat.settings,
        branch,
        '',
        null,
        capability.maxPromptTokens ?? capability.contextLength ?? null,
      ),
    [branch, capability, chat.settings],
  )
  return <ContextPanel chat={chat} capability={capability} estimateOverride={estimate} />
}

async function resetAll() {
  __resetBroadcastForTests()
  __resetLockTrackerForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openBrowserWorkspace()
})

afterEach(async () => {
  cleanup()
  await shutdownBrowserWorkspace()
  await resetAll()
})

describe('ContextPanel slider persistence', () => {
  it('labels the gauge as a persisted-branch estimate and never presents volatile draft work', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o-mini'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const estimate = estimateSettingsPromptSize(settings, [], 'volatile draft', null)
    const { getByRole, queryByText } = render(
      <ContextPanel chat={chat} capability={capability} estimateOverride={estimate} />,
    )

    expect(getByRole('meter', { name: 'Estimated prompt tokens used' })).toHaveAttribute(
      'title',
      expect.stringContaining('persisted-branch estimate'),
    )
    expect(queryByText('draft', { exact: true })).toBeNull()
  })

  it('does not persist max context on every drag tick, only after the value settles', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o-mini'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const estimate = estimateSettingsPromptSize(settings, [], '', null)
    const { container } = render(
      <ContextPanel chat={chat} capability={capability} estimateOverride={estimate} />,
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

  it('flushes a pending max-context slider value on unmount', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o-mini'
    const chat = await createChat({ settings })
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const estimate = estimateSettingsPromptSize(settings, [], '', null)
    const { container, unmount } = render(
      <ContextPanel chat={chat} capability={capability} estimateOverride={estimate} />,
    )
    const maxContext = container.querySelector<HTMLInputElement>('[data-ui="slider"]')
    expect(maxContext).toBeTruthy()

    fireEvent.change(maxContext as HTMLInputElement, { target: { value: '8192' } })
    unmount()

    await waitFor(async () => {
      expect((await getChat(chat.id))?.settings.customMaxContext).toBe(8192)
    })
    await withMutationLocks([{ kind: 'chat-meta', chatId: chat.id }], () => {})
  })

  it('uses the same estimator when Files is switched Off', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o-mini'
    const chat = await createChat({ settings })
    const attachment: Attachment = {
      id: 'att-1',
      kind: 'image',
      mime: 'image/png',
      filename: 'cat.png',
      origin: 'system-fixture',
      createdAt: 1,
      updatedAt: 1,
      storage: { kind: 'missing', reason: 'import-missing', missingSince: 1 },
      artifacts: [],
      processing: [],
      refCount: 0,
    }
    await getDb().attachments.put(splitAttachmentForStorage(attachment, 0, 1))
    await putTestMessages([userMessage(chat.id), assistantMessage(chat.id)])
    const capability = effectiveCapabilityFromEndpoints(settings.model, [makeEndpoint()])
    const { container, getByRole } = render(
      <LiveContextPanel
        initialChat={chat}
        branch={[userMessage(chat.id), assistantMessage(chat.id)]}
        capability={capability}
      />,
    )

    await waitFor(() => {
      expect(container.textContent).toContain('media')
    })
    const initialUsed = readGaugeValue(container)
    expect(initialUsed).toBeGreaterThan(1000)

    fireEvent.click(getByRole('button', { name: 'Off' }))

    await waitFor(() => {
      expect(container.textContent).not.toContain('media')
    })
    const afterOff = readGaugeValue(container)
    expect(initialUsed - afterOff).toBe(1000)
  })
})

function readGaugeValue(container: HTMLElement): number {
  const label = container.querySelector('[data-ui="context-gauge-label"] strong')
  if (!label) throw new Error('missing context gauge label')
  return Number(label.textContent.replaceAll(',', '').replace('≈', '').trim())
}

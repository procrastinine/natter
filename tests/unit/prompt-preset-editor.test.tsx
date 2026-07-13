import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat, getChat } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import {
  __promptSettingSaveRegistrySizeForTests,
  flushPendingPromptSettingSaves,
} from '../../src/store/prompt-presets'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { SystemPromptEditor } from '../../src/ui/settings/PromptPresetEditor'

const DB_NAME = 'natter'

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetBroadcastForTests()
  __resetDbForTests()
  useToastStore.getState().reset()
  window.sessionStorage.clear()
  await Dexie.delete(DB_NAME)
  await openDb()
})

afterEach(async () => {
  cleanup()
  __resetBroadcastForTests()
  __resetDbForTests()
  useToastStore.getState().reset()
  await Dexie.delete(DB_NAME)
})

describe('PromptPresetEditor persistence', () => {
  it('flushes the latest draft when the editor unmounts before its debounce', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    const view = render(<SystemPromptEditor chat={chat} />)
    const textarea = view.getByRole('textbox', { name: 'System prompt' })
    fireEvent.change(textarea, { target: { value: 'saved during unmount' } })

    view.unmount()
    await flushPendingPromptSettingSaves(chat.id)

    expect((await getChat(chat.id))?.settings.systemPrompt).toBe('saved during unmount')
    expect(__promptSettingSaveRegistrySizeForTests()).toEqual({
      pendingChats: 0,
      pendingSaves: 0,
      flusherChats: 0,
      flushers: 0,
    })
  })

  it('keeps a failed draft dirty and retries on the next blur', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    const view = render(<SystemPromptEditor chat={chat} />)
    const textarea = view.getByRole('textbox', {
      name: 'System prompt',
    }) as HTMLTextAreaElement
    const injectedFailure = () => {
      throw new Error('injected prompt write failure')
    }
    getDb().chats.hook.updating.subscribe(injectedFailure)

    fireEvent.change(textarea, { target: { value: 'retryable draft' } })
    fireEvent.blur(textarea)
    await waitFor(() => {
      expect(__promptSettingSaveRegistrySizeForTests().pendingSaves).toBe(0)
    })
    expect(textarea.value).toBe('retryable draft')
    expect((await getDb().chats.get(chat.id))?.settings.systemPrompt).toBe('')

    getDb().chats.hook.updating.unsubscribe(injectedFailure)
    fireEvent.blur(textarea)
    await waitFor(async () => {
      expect((await getChat(chat.id))?.settings.systemPrompt).toBe('retryable draft')
    })
  })

  it('flushes the old chat without leaking its draft when a keyed panel switches chats', async () => {
    const first = await createChat({ settings: cloneDefaultChatSettings() })
    const second = await createChat({ settings: cloneDefaultChatSettings() })
    const view = render(<SystemPromptEditor key={first.id} chat={first} />)
    fireEvent.change(view.getByRole('textbox', { name: 'System prompt' }), {
      target: { value: 'first chat draft' },
    })

    view.rerender(<SystemPromptEditor key={second.id} chat={second} />)
    await flushPendingPromptSettingSaves(first.id)

    expect((await getChat(first.id))?.settings.systemPrompt).toBe('first chat draft')
    expect((await getChat(second.id))?.settings.systemPrompt).toBe('')
    expect(view.getByRole('textbox', { name: 'System prompt' })).toHaveValue('')
  })
})

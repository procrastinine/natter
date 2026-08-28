import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { getChat } from '../../src/store/chats'
import { configurationController } from '../../src/store/configuration-controller'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { __resetWorkspaceRepositoryForTests } from '../../src/store/workspace-repository'
import { awaitWorkspaceForegroundDemandIdle } from '../../src/store/workspace-runtime'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { SystemPromptEditor } from '../../src/ui/settings/PromptPresetEditor'

const DB_NAME = 'natter'

beforeEach(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  useToastStore.getState().reset()
  window.sessionStorage.clear()
  await Dexie.delete(DB_NAME)
  await openBrowserWorkspace()
})

afterEach(async () => {
  cleanup()
  await shutdownBrowserWorkspace()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  useToastStore.getState().reset()
  await Dexie.delete(DB_NAME)
})

describe('PromptPresetEditor persistence', () => {
  it('holds background replacement demand only while the prompt field is focused', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    const view = render(<SystemPromptEditor chat={chat} />)
    const textarea = view.getByRole('textbox', { name: 'System prompt' })

    fireEvent.focus(textarea)
    let maintenanceAdmitted = false
    const maintenance = awaitWorkspaceForegroundDemandIdle().then(() => {
      maintenanceAdmitted = true
    })
    await Promise.resolve()
    expect(maintenanceAdmitted).toBe(false)

    fireEvent.blur(textarea)
    fireEvent.focus(textarea)
    await Promise.resolve()
    await Promise.resolve()
    expect(maintenanceAdmitted).toBe(false)

    fireEvent.blur(textarea)
    await maintenance
    expect(maintenanceAdmitted).toBe(true)
  })

  it('accepts a remote stored value when the mounted editor is clean', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    const view = render(<SystemPromptEditor chat={chat} />)

    view.rerender(
      <SystemPromptEditor
        chat={{
          ...chat,
          settings: { ...chat.settings, systemPrompt: 'remote system prompt' },
        }}
      />,
    )

    expect(view.getByRole('textbox', { name: 'System prompt' })).toHaveValue('remote system prompt')
  })

  it('does not overwrite a dirty mounted draft with a remote stored value', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    const view = render(<SystemPromptEditor chat={chat} />)
    const textarea = view.getByRole('textbox', { name: 'System prompt' })
    fireEvent.change(textarea, { target: { value: 'local draft' } })

    view.rerender(
      <SystemPromptEditor
        chat={{
          ...chat,
          settings: { ...chat.settings, systemPrompt: 'remote system prompt' },
        }}
      />,
    )

    expect(textarea).toHaveValue('local draft')
  })

  it('flushes the latest draft when the editor unmounts before its debounce', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    const view = render(<SystemPromptEditor chat={chat} />)
    const textarea = view.getByRole('textbox', { name: 'System prompt' })
    fireEvent.change(textarea, { target: { value: 'saved during unmount' } })

    view.unmount()
    await configurationController.flushChatEdits(chat.id)

    expect((await getChat(chat.id))?.settings.systemPrompt).toBe('saved during unmount')
    expect(configurationController.editQueueStats()).toMatchObject({
      pendingChats: 0,
      pendingOperations: 0,
      mountedChats: 0,
      mountedSessions: 0,
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
      expect(configurationController.editQueueStats().pendingOperations).toBe(0)
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
    await configurationController.flushChatEdits(first.id)

    expect((await getChat(first.id))?.settings.systemPrompt).toBe('first chat draft')
    expect((await getChat(second.id))?.settings.systemPrompt).toBe('')
    expect(view.getByRole('textbox', { name: 'System prompt' })).toHaveValue('')
  })
})

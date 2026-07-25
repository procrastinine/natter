import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import Dexie from 'dexie'
import { ownBrowserWorkspaceSuite } from '../helpers/browser-workspace-suite'
import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest'
import { App } from '../../src/app/App'
import { conversationActions } from '../../src/app/conversation-actions'
import { browserConversationNavigationPort, navigate } from '../../src/app/router'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Message } from '../../src/core/types'
import type { MessageAttachmentRefMutation } from '../../src/store/attachments'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { archiveChat, setManualTitle } from '../../src/store/chats'
import { configurationController } from '../../src/store/configuration-controller'
import { conversationController } from '../../src/store/conversation-controller'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { createFolder } from '../../src/store/folders'
import {
  exportChat,
  exportWorkspaceBackup,
  restoreWorkspaceBackup,
} from '../../src/store/import-export'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import { __resetWorkspaceRepositoryForTests } from '../../src/store/workspace-repository'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { useUiStore } from '../../src/store/zustand/uiStore'
import type * as BranchTreeViewModule from '../../src/ui/chat/BranchTreeView'
import type { BranchTreeViewProps } from '../../src/ui/chat/BranchTreeView'
import { createConfigurationProfile } from '../helpers/configuration'

const branchTreeViewProbe = vi.hoisted(() => ({
  props: null as BranchTreeViewProps | null,
}))

vi.mock('../../src/ui/chat/BranchTreeView', async (importOriginal) => {
  const actual = await importOriginal<typeof BranchTreeViewModule>()
  return {
    ...actual,
    BranchTreeView: (props: BranchTreeViewProps) => {
      branchTreeViewProbe.props = props
      return <actual.BranchTreeView {...props} />
    },
  }
})

const DB_NAME = 'natter'
const workspaceSuite = ownBrowserWorkspaceSuite()
let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>
let errorSpy: MockInstance<typeof console.error>
let warnSpy: MockInstance<typeof console.warn>

beforeAll(async () => {
  conversationController.setNavigationPort(browserConversationNavigationPort)
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await workspaceSuite.open()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

afterAll(() => {
  conversationController.setNavigationPort(null)
})

beforeEach(async () => {
  branchTreeViewProbe.props = null
  __resetKeyCacheForTests()
  useToastStore.getState().reset()
  useUiStore.getState().reset()
  window.localStorage.clear()
  window.sessionStorage.clear()
  navigate('#/')
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  cleanup()
  await Promise.resolve()
  errorSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('controller-backed shell contract', () => {
  it('mounts the sidebar, first-run connection action, and main pane', async () => {
    const { container } = render(<App />)

    expect(container.querySelector('[data-ui="app-shell"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="sidebar"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="main-pane"]')).toBeInTheDocument()
    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-empty-action"]')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="connection-header"]')).not.toBeInTheDocument()
  })

  it('keeps the sidebar mounted on storage routes', async () => {
    navigate('#/storage/chats')
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="storage-chats"]')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="sidebar"]')).toBeInTheDocument()
    expect(container.querySelector('[data-ui="app-shell"]')).not.toHaveAttribute(
      'data-sidebar-hidden',
    )
  })

  it('imports a chat from the sidebar toolbar and navigates to the new identity', async () => {
    const source = await createChat({ id: 'shell-import-source', title: 'Alpha', now: 10 })
    const envelope = await exportChat(source.id)
    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="sidebar-import-chat"]')).toBeInTheDocument()
    })
    const input = container.querySelector<HTMLInputElement>('[data-ui="sidebar-chat-import-input"]')
    if (!input) throw new Error('SidebarImportInputMissing')

    fireEvent.change(input, {
      target: {
        files: [new File([JSON.stringify(envelope)], 'chat.json', { type: 'application/json' })],
      },
    })

    await waitFor(async () => {
      const chats = await getDb().chats.orderBy('createdAt').toArray()
      expect(chats).toHaveLength(2)
      expect(chats[1]?.id).not.toBe(source.id)
      expect(window.location.hash).toMatch(/^#\/chat\//)
    })
  })

  it('keeps no-op new-chat visits out of IndexedDB', async () => {
    navigate('#/new')
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="composer"]')).toBeInTheDocument()
    })
    expect(await getDb().chats.count()).toBe(0)
    expect(await getDb().messages.count()).toBe(0)

    navigate('#/')
    await waitFor(() => expect(window.location.hash).toBe('#/'))
    expect(await getDb().chats.count()).toBe(0)
  })

  it('updates lastViewedAt without rewriting the chat update timestamp', async () => {
    const chat = await createChat({ id: 'shell-viewed', title: 'Draft', now: 1_000 })
    await setManualTitle(chat.id, 'Viewed', 5_000)
    navigate(`#/chat/${chat.id}`)

    render(<App />)

    await waitFor(async () => {
      const stored = await getDb().chats.get(chat.id)
      expect(stored?.lastViewedAt).toBeGreaterThan(1_000)
      expect(stored?.updatedAt).toBe(5_000)
    })
  })

  it('keeps chat and global settings closed until requested', () => {
    const { container } = render(<App />)

    expect(container.querySelector('[data-ui="chat-model-panel"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-ui="global-settings-overlay"]')).not.toBeInTheDocument()
    expect(container.querySelector('[data-ui="app-shell"]')).toHaveAttribute(
      'data-chat-model-panel',
      'closed',
    )
  })

  it('opens globally resident settings without a loading interstitial', async () => {
    const { container } = render(<App />)
    const open = container.querySelector('[data-ui="open-global-settings"]')
    if (!open) throw new Error('GlobalSettingsActionMissing')

    fireEvent.click(open)

    await waitFor(() => {
      expect(document.body.querySelector('[data-ui="global-settings-modal"]')).toBeInTheDocument()
    })
    expect(document.body.querySelector('[data-ui="global-settings-header"]')).toBeInTheDocument()
    expect(container).not.toHaveTextContent('Loading settings')
  })

  it('opens chat settings without mounting an empty transcript', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    navigate(`#/chat/${chat.id}`)
    const { container } = render(<App />)
    await waitFor(() => {
      expect(conversationController.getSnapshot().activeChatId).toBe(chat.id)
      expect(container.querySelector('[data-role="settings-cog"]')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="message-list"]')).not.toBeInTheDocument()

    fireEvent.click(container.querySelector('[data-role="settings-cog"]') as HTMLButtonElement)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-model-panel"]')).toBeInTheDocument()
    })
    expect(container).not.toHaveTextContent('Loading chat settings')
    expect(container.querySelector('[data-ui="message-list"]')).not.toBeInTheDocument()
  })

  it('admits New Chat before preserving an open chat-settings panel', async () => {
    const first = await createChat({ settings: cloneDefaultChatSettings() })
    const second = await createChat({ settings: cloneDefaultChatSettings() })
    navigate(`#/chat/${first.id}`)
    const { container } = render(<App />)
    await waitFor(() => expect(conversationController.getSnapshot().activeChatId).toBe(first.id))
    navigate(`#/chat/${second.id}`)
    await waitFor(() => {
      expect(conversationController.getSnapshot().activeChatId).toBe(second.id)
      expect(container.querySelector('[data-role="settings-cog"]')).toBeInTheDocument()
    })

    fireEvent.click(container.querySelector('[data-role="settings-cog"]') as HTMLButtonElement)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="chat-model-panel"]')).toBeInTheDocument()
    })
    fireEvent.click(container.querySelector('[data-role="new-chat"]') as HTMLAnchorElement)

    expect(window.location.hash).not.toBe(`#/chat/${second.id}`)
    expect(conversationController.getSnapshot().activeChatId).toBeNull()
    expect(configurationController.getSnapshot().frame.target.kind).toBe('new-chat')
    await waitFor(() => {
      expect(window.location.hash).toMatch(/^#\/chat\//)
      expect(container.querySelector('[data-ui="chat-model-panel"]')).toBeInTheDocument()
    })
    const temporaryChatId = window.location.hash.replace('#/chat/', '')
    await waitFor(async () => {
      expect((await getDb().chats.get(temporaryChatId))?.temporary).toBe(true)
    })
  })

  it('renders configured connection access beside the active chat title', async () => {
    const key = await createKey({ name: 'OpenRouter', plaintextKey: 'sk-or-v1-test' })
    const profile = await createConfigurationProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: key.id,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const chat = await createChat({ settings })
    navigate(`#/chat/${chat.id}`)
    const { container } = render(<App />)

    await waitFor(() => {
      expect(container.querySelector('[data-ui="connection-provider-button"]')).toBeInTheDocument()
    })
    expect(
      container.querySelector('[data-ui="connection-provider-button"][data-kind="openrouter"]'),
    ).toBeInTheDocument()
  })

  it('shows focus mode only on chat surfaces', async () => {
    navigate('#/storage')
    const storage = render(<App />)
    await waitFor(() => {
      expect(storage.container.querySelector('[data-ui="storage-view"]')).toBeInTheDocument()
    })
    expect(storage.container.querySelector('[data-ui="focus-mode-toggle"]')).not.toBeInTheDocument()
    storage.unmount()

    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    navigate(`#/chat/${chat.id}`)
    const conversation = render(<App />)
    await waitFor(() => {
      expect(
        conversation.container.querySelector('[data-ui="focus-mode-toggle"]'),
      ).toBeInTheDocument()
    })
  })

  it('round-trips an empty chat through tree view without losing the composer', async () => {
    const chat = await createChat({ title: 'Empty tree', settings: cloneDefaultChatSettings() })
    navigate(`#/chat/${chat.id}`)
    const { container } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-role="chat-branch-tree"]')).toBeInTheDocument()
      expect(container.querySelector('[data-ui="composer"]')).toBeInTheDocument()
    })
    const toggle = container.querySelector('[data-role="chat-branch-tree"]') as HTMLButtonElement

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-tree-view"]')).toBeVisible()
    })
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="branch-tree-view"]')).not.toBeVisible()
      expect(container.querySelector('[data-ui="composer"]')).toBeVisible()
    })
  })

  it('routes a retained tree attachment mutation through the message-owned chat identity', async () => {
    const retainedChat = await createChat({
      title: 'Retained tree',
      settings: cloneDefaultChatSettings(),
    })
    const activeChat = await createChat({
      title: 'Active tree',
      settings: cloneDefaultChatSettings(),
    })
    navigate(`#/chat/${retainedChat.id}`)
    const { container } = render(<App />)
    const toggle = await waitFor(() => {
      const current = container.querySelector<HTMLButtonElement>('[data-role="chat-branch-tree"]')
      expect(current).toBeInTheDocument()
      return current
    })
    if (!toggle) throw new Error('BranchTreeToggleMissing')
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(branchTreeViewProbe.props?.binding.seal.chatId).toBe(retainedChat.id)
    })

    navigate(`#/chat/${activeChat.id}`)
    await waitFor(() => {
      expect(conversationController.getSnapshot().activeChatId).toBe(activeChat.id)
    })
    expect(branchTreeViewProbe.props?.binding.seal.chatId).toBe(retainedChat.id)
    const retainedMessage: Message = {
      id: 'retained-message',
      chatId: retainedChat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'retained-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'retained' }],
      nodeVersion: 0,
      deleted: false,
    }
    const mutation: MessageAttachmentRefMutation = {
      kind: 'visibility',
      refId: 'retained-ref',
      includeInContext: false,
    }
    const mutate = vi.spyOn(conversationActions, 'mutateAttachment').mockResolvedValue(undefined)
    try {
      const callback = branchTreeViewProbe.props?.onMutateMessageAttachmentRef
      if (!callback) throw new Error('TreeAttachmentMutationCallbackMissing')
      await act(async () => callback(retainedMessage, mutation))

      expect(mutate).toHaveBeenCalledOnce()
      expect(mutate).toHaveBeenCalledWith(retainedMessage, mutation)
    } finally {
      mutate.mockRestore()
    }
  })

  it('uses the app shortcut while leaving browser new-window shortcuts alone', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    navigate(`#/chat/${chat.id}`)
    render(<App />)
    const originalHash = window.location.hash
    const browserShortcut = new KeyboardEvent('keydown', {
      key: 'n',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => window.dispatchEvent(browserShortcut))
    expect(browserShortcut.defaultPrevented).toBe(false)
    expect(window.location.hash).toBe(originalHash)

    const appShortcut = new KeyboardEvent('keydown', {
      key: 'O',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => window.dispatchEvent(appShortcut))
    expect(appShortcut.defaultPrevented).toBe(true)
    await waitFor(() => expect(window.location.hash).toBe('#/new'))
  })

  it('shows folders created after the shell mounts', async () => {
    const { findByText } = render(<App />)

    await createFolder({ id: 'shell-live-folder', name: 'Live folder', now: 1 })

    expect(await findByText('Live folder')).toBeInTheDocument()
  })

  it('opens archived chats from storage while keeping them out of the sidebar', async () => {
    const chat = await createChat({ title: 'Archived chat', settings: cloneDefaultChatSettings() })
    await archiveChat(chat.id, 2)
    navigate('#/storage/archive')
    const { container, findByText } = render(<App />)

    fireEvent.click(await findByText('Archived chat'))

    await waitFor(() => {
      expect(window.location.hash).toBe(`#/chat/${chat.id}`)
      expect(container.querySelector('[data-ui="chat-title-bar"]')).toBeInTheDocument()
    })
    expect(container.querySelector('[data-ui="chat-row"]')).not.toBeInTheDocument()
  })

  it('uploads files dropped onto the active chat pane', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings() })
    navigate(`#/chat/${chat.id}`)
    const { container, findByText } = render(<App />)
    await waitFor(() => {
      expect(container.querySelector('[data-ui="composer"]')).toBeInTheDocument()
      expect(container.querySelector('[data-ui="composer-input"]')).not.toBeDisabled()
    })
    const mainPane = container.querySelector('[data-ui="main-pane"]') as HTMLElement
    const file = new File(['drop upload body'], 'drop-note.txt', { type: 'text/plain' })
    const dataTransfer = { types: ['Files'], files: [file], dropEffect: 'none' }

    expect(fireEvent.dragOver(mainPane, { dataTransfer })).toBe(false)
    expect(fireEvent.drop(mainPane, { dataTransfer })).toBe(false)

    expect(await findByText('drop-note.txt')).toBeInTheDocument()
    await waitFor(() => {
      expect(
        container.querySelector('[data-ui="attachment-file-card"][data-storage="local"]'),
      ).toBeInTheDocument()
    })
  })

  it('boots without console errors or warnings', async () => {
    render(<App />)
    await waitFor(() => {
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    })
  })
})

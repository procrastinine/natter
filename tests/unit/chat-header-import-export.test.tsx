import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, openDb } from '../../src/store/db'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useToastStore } from '../../src/store/zustand/toastStore'
import { ChatHeader } from '../../src/ui/chat/ChatHeader'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  useChatStore.getState().reset()
  useToastStore.getState().reset()
  await Dexie.delete(DB_NAME)
}

function mockBlobDownloads() {
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  const createdBlobs: Blob[] = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn((blob: Blob) => {
      createdBlobs.push(blob)
      return `blob:natter-${createdBlobs.length}`
    }),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  return {
    createdBlobs,
    clickSpy,
    restore() {
      clickSpy.mockRestore()
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL,
      })
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
      })
    },
  }
}

describe('ChatHeader import/export controls', () => {
  beforeEach(async () => {
    ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
    await resetAll()
    await openDb()
  })

  afterEach(async () => {
    cleanup()
    vi.restoreAllMocks()
    await resetAll()
  })

  it('exports the active chat as portable JSON beside the text download', async () => {
    const chat = await createChat({ id: 'chat-alpha', title: 'Alpha', now: 1000 })
    const downloads = mockBlobDownloads()
    try {
      render(
        <ChatHeader chatId={chat.id} settingsOpen={false} onToggleSettings={() => undefined} />,
      )

      fireEvent.click(await screen.findByRole('button', { name: 'Export chat JSON' }))

      await waitFor(() => expect(downloads.clickSpy).toHaveBeenCalled())
      expect(downloads.createdBlobs).toHaveLength(1)
      const exported = JSON.parse(await (downloads.createdBlobs[0] as Blob).text()) as {
        objectKind: string
        payload: { chat: { sourceChatId: string } }
      }
      expect(exported.objectKind).toBe('chat')
      expect(exported.payload.chat.sourceChatId).toBe('chat-alpha')
    } finally {
      downloads.restore()
    }
  })

  it('marks tree view active and disables tree editing until conversation view returns', async () => {
    const chat = await createChat({ id: 'chat-tree-state', title: 'Tree state', now: 1000 })
    const onToggleEditTree = vi.fn()
    const onToggleTreeView = vi.fn()
    const { container, rerender } = render(
      <ChatHeader
        chatId={chat.id}
        settingsOpen={false}
        onToggleSettings={() => undefined}
        editTreeActive={false}
        onToggleEditTree={onToggleEditTree}
        treeViewActive
        onToggleTreeView={onToggleTreeView}
      />,
    )

    const treeButton = await screen.findByRole('button', { name: 'Return to conversation' })
    const editButton = container.querySelector('[data-role="chat-edit-tree"]') as HTMLButtonElement
    expect(treeButton).toHaveAttribute('aria-pressed', 'true')
    expect(treeButton).toHaveAttribute('data-state', 'active')
    expect(editButton).toBeDisabled()
    expect(editButton).toHaveAttribute('aria-pressed', 'false')
    expect(editButton).toHaveAttribute('title', 'Return to conversation to edit the tree')

    fireEvent.click(editButton)
    expect(onToggleEditTree).not.toHaveBeenCalled()

    fireEvent.click(container.querySelector('[data-role="chat-controls-menu"]') as HTMLElement)
    const mobileEditButton = container.querySelector(
      '[data-role="mobile-chat-edit-tree"]',
    ) as HTMLButtonElement
    const mobileTreeButton = container.querySelector(
      '[data-role="mobile-chat-branch-tree"]',
    ) as HTMLButtonElement
    expect(mobileEditButton).toBeDisabled()
    expect(mobileTreeButton).toHaveAttribute('data-state', 'active')
    fireEvent.click(mobileEditButton)
    expect(onToggleEditTree).not.toHaveBeenCalled()

    rerender(
      <ChatHeader
        chatId={chat.id}
        settingsOpen={false}
        onToggleSettings={() => undefined}
        editTreeActive={false}
        onToggleEditTree={onToggleEditTree}
        treeViewActive={false}
        onToggleTreeView={onToggleTreeView}
      />,
    )

    expect(editButton).toBeEnabled()
    expect(editButton).toHaveAttribute('aria-label', 'Enter edit tree mode')
    expect(editButton).toHaveAttribute('title', 'Edit tree mode (⇧⌘E)')
    fireEvent.click(editButton)
    expect(onToggleEditTree).toHaveBeenCalledOnce()
  })
})

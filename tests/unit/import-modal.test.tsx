import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Message } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { getBrowserRepository } from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import type { WorkspaceRepository } from '../../src/store/repository'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
} from '../../src/store/workspace-repository'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { ImportModal } from '../../src/ui/chat/ImportModal'
import { putTestMessages } from '../helpers/message-storage'

async function resetAll(): Promise<void> {
  cleanup()
  __resetWorkspaceRepositoryForTests()
  useChatStore.getState().reset()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete('natter')
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(resetAll)

function message(id: string, parentId: string | null, siblingIndex: number): Message {
  return {
    id,
    chatId: 'shared-import-chat',
    parentId,
    siblingIndex,
    turnId: `turn-${id}`,
    turnIndex: 0,
    createdAt: siblingIndex + 1,
    role: parentId === null ? 'user' : 'assistant',
    origin: 'user',
    content: [{ type: 'text', text: id }],
    nodeVersion: 0,
    deleted: false,
  }
}

describe('ImportModal tree insertion', () => {
  it('keeps an existing-chat import owned by its tab after another chat is opened', async () => {
    const target = await createChat({
      id: 'shared-import-chat',
      settings: cloneDefaultChatSettings(),
    })
    const visible = await createChat({
      id: 'newer-visible-chat',
      settings: cloneDefaultChatSettings(),
    })
    const root = message('root', null, 0)
    await putTestMessages([root])
    useChatStore.getState().navigateToCursor(target.id, { __root__: root.id })

    const repo = getBrowserRepository()
    let releaseHeaders!: () => void
    const headersReleased = new Promise<void>((resolve) => {
      releaseHeaders = resolve
    })
    let signalHeadersStarted!: () => void
    const headersStarted = new Promise<void>((resolve) => {
      signalHeadersStarted = resolve
    })
    __setWorkspaceRepositoryForTests({
      listMessageHeaders: async (chatId) => {
        signalHeadersStarted()
        await headersReleased
        return repo.listMessageHeaders(chatId)
      },
      runMutation: repo.runMutation.bind(repo),
    } as WorkspaceRepository)

    const onClose = vi.fn()
    const { getAllByRole, getByRole } = render(
      <ImportModal
        chatId={target.id}
        slot={{ kind: 'at-end' }}
        cursor={useChatStore.getState().getCursor(target.id) ?? {}}
        presentationWindowLimit={1}
        onClose={onClose}
      />,
    )
    fireEvent.change(getAllByRole('textbox')[0] as HTMLTextAreaElement, {
      target: { value: 'background import' },
    })
    fireEvent.click(getByRole('button', { name: 'Import' }))
    await headersStarted

    const newerIntent = useChatStore
      .getState()
      .navigateToCursor(visible.id, { __root__: 'visible-message' })
    await act(async () => releaseHeaders())

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    const receipt = useChatStore.getState().getCommittedPathPresentation(target.id)
    const importedLeafId = receipt?.pathHeaders.at(-1)?.id
    expect(receipt?.phase).toBe('terminal')
    expect(receipt?.pathHeaders.map((header) => header.id)).toEqual([root.id, importedLeafId])
    expect(receipt?.presentations.map((presentation) => presentation.message.id)).toEqual([
      importedLeafId,
    ])
    expect(useChatStore.getState().getCursor(target.id)).toMatchObject({
      __root__: root.id,
      [root.id]: importedLeafId,
    })
    expect(useChatStore.getState().isNavigationIntentCurrent(newerIntent)).toBe(true)
  })

  it('keeps a superseded new-chat import detached while its write completes', async () => {
    const target = await createChat({
      id: 'detached-import-chat',
      settings: cloneDefaultChatSettings(),
    })
    const visible = await createChat({
      id: 'newer-visible-chat',
      settings: cloneDefaultChatSettings(),
    })
    let resolveMaterialized!: (value: { chatId: string; navigationIntent: null }) => void
    const materialized = new Promise<{ chatId: string; navigationIntent: null }>((resolve) => {
      resolveMaterialized = resolve
    })
    const materializeChat = vi.fn(() => materialized)
    const onClose = vi.fn()
    const { getAllByRole, getByRole } = render(
      <ImportModal
        chatId={null}
        slot={{ kind: 'at-end' }}
        cursor={{}}
        presentationWindowLimit={10}
        materializeChat={materializeChat}
        onClose={onClose}
      />,
    )
    fireEvent.change(getAllByRole('textbox')[0] as HTMLTextAreaElement, {
      target: { value: 'background import' },
    })
    fireEvent.click(getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(materializeChat).toHaveBeenCalledTimes(1))

    const newerIntent = useChatStore
      .getState()
      .navigateToCursor(visible.id, { __root__: 'visible-message' })
    await act(async () => resolveMaterialized({ chatId: target.id, navigationIntent: null }))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(await getDb().messages.where('chatId').equals(target.id).count()).toBe(1)
    expect(useChatStore.getState().getCursor(target.id)).toBeUndefined()
    expect(useChatStore.getState().isNavigationIntentCurrent(newerIntent)).toBe(true)
  })

  it('applies shared-trunk topology and the returned cursor effects', async () => {
    const chat = await createChat({
      id: 'shared-import-chat',
      settings: cloneDefaultChatSettings(),
    })
    const parent = message('parent', null, 0)
    const left = message('left', parent.id, 0)
    const right = message('right', parent.id, 1)
    await putTestMessages([parent, left, right])
    useChatStore
      .getState()
      .navigateToCursor(chat.id, { __root__: parent.id, [parent.id]: right.id })
    const onClose = vi.fn()

    const { getAllByRole, getByRole } = render(
      <ImportModal
        chatId={chat.id}
        slot={{ kind: 'after-all', parentId: parent.id }}
        cursor={useChatStore.getState().getCursor(chat.id) ?? {}}
        presentationWindowLimit={2}
        onClose={onClose}
      />,
    )
    fireEvent.change(getAllByRole('textbox')[0] as HTMLTextAreaElement, {
      target: { value: 'first inserted' },
    })
    fireEvent.click(getByRole('button', { name: /add another message/i }))
    fireEvent.change(getAllByRole('textbox')[1] as HTMLTextAreaElement, {
      target: { value: 'second inserted' },
    })
    fireEvent.click(getByRole('button', { name: 'Import' }))

    await waitFor(async () => {
      expect(onClose).toHaveBeenCalled()
      const headers = await getDb().messages.where('chatId').equals(chat.id).toArray()
      expect(headers).toHaveLength(5)
      const first = headers.find(
        (header) => header.origin === 'imported' && header.parentId === parent.id,
      )
      const second = headers.find(
        (header) => header.origin === 'imported' && header.parentId === first?.id,
      )
      expect(first?.parentId).toBe(parent.id)
      expect(second?.parentId).toBe(first?.id)
      expect(headers.find((header) => header.id === left.id)?.parentId).toBe(second?.id)
      expect(headers.find((header) => header.id === right.id)?.parentId).toBe(second?.id)
      expect(useChatStore.getState().getCursor(chat.id)).toMatchObject({
        [parent.id]: first?.id,
        [first?.id ?? 'missing-first']: second?.id,
        [second?.id ?? 'missing-second']: right.id,
      })
      const structuralById = new Map(
        useChatStore
          .getState()
          .getCommittedPathPresentation(chat.id)
          ?.structuralHeaders.map((header) => [header.id, header]),
      )
      expect(structuralById.size).toBe(5)
      expect(structuralById.get(left.id)?.parentId).toBe(second?.id)
      expect(structuralById.get(right.id)?.parentId).toBe(second?.id)
    })
  })

  it('selects the exact inserted path when the tree target is off the active branch', async () => {
    const chat = await createChat({
      id: 'shared-import-chat',
      settings: cloneDefaultChatSettings(),
    })
    const leftRoot = message('left-root', null, 0)
    const leftLeaf = message('left-leaf', leftRoot.id, 0)
    const rightRoot = message('right-root', null, 1)
    const rightLeaf = message('right-leaf', rightRoot.id, 0)
    await putTestMessages([leftRoot, leftLeaf, rightRoot, rightLeaf])
    useChatStore.getState().navigateToCursor(chat.id, {
      __root__: rightRoot.id,
      [rightRoot.id]: rightLeaf.id,
    })
    const onClose = vi.fn()

    const { getAllByRole, getByRole } = render(
      <ImportModal
        chatId={chat.id}
        slot={{ kind: 'after', messageId: leftLeaf.id }}
        cursor={useChatStore.getState().getCursor(chat.id) ?? {}}
        presentationWindowLimit={2}
        onClose={onClose}
      />,
    )
    fireEvent.change(getAllByRole('textbox')[0] as HTMLTextAreaElement, {
      target: { value: 'off-branch child' },
    })
    fireEvent.click(getByRole('button', { name: 'Import' }))

    await waitFor(async () => {
      expect(onClose).toHaveBeenCalled()
      const inserted = (await getDb().messages.where('chatId').equals(chat.id).toArray()).find(
        (row) => row.origin === 'imported',
      )
      expect(inserted?.parentId).toBe(leftLeaf.id)
      expect(useChatStore.getState().getCursor(chat.id)).toMatchObject({
        __root__: leftRoot.id,
        [leftRoot.id]: leftLeaf.id,
        [leftLeaf.id]: inserted?.id,
      })
      expect(useChatStore.getState().getPendingBranchNavigation(chat.id)?.pathMessageIds).toEqual([
        leftRoot.id,
        leftLeaf.id,
        inserted?.id,
      ])
      const receipt = useChatStore.getState().getCommittedPathPresentation(chat.id)
      expect(receipt?.phase).toBe('terminal')
      expect(receipt?.pathHeaders.map((header) => header.id)).toEqual([
        leftRoot.id,
        leftLeaf.id,
        inserted?.id,
      ])
      expect(receipt?.presentations.map((presentation) => presentation.message.id)).toEqual([
        leftLeaf.id,
        inserted?.id,
      ])
    })
  })
})

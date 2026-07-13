import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Message } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { ImportModal } from '../../src/ui/chat/ImportModal'
import { putTestMessages } from '../helpers/message-storage'

async function resetAll(): Promise<void> {
  cleanup()
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
  it('applies shared-trunk topology and the returned cursor effects', async () => {
    const chat = await createChat({
      id: 'shared-import-chat',
      settings: cloneDefaultChatSettings(),
    })
    const parent = message('parent', null, 0)
    const left = message('left', parent.id, 0)
    const right = message('right', parent.id, 1)
    await putTestMessages([parent, left, right])
    useChatStore.getState().setCursor(chat.id, { __root__: parent.id, [parent.id]: right.id })
    const onClose = vi.fn()

    const { getAllByRole, getByRole } = render(
      <ImportModal
        chatId={chat.id}
        slot={{ kind: 'after-all', parentId: parent.id }}
        cursor={useChatStore.getState().getCursor(chat.id) ?? {}}
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
    })
  })
})

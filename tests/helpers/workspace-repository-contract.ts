import { expect } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, CursorMap, Message } from '../../src/core/types'
import type { WorkspaceRepository } from '../../src/store/repository'

function contractChat(id: string): Chat {
  return {
    id,
    title: 'Repository contract',
    titleStatus: 'untitled',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function contractMessage(
  chatId: string,
  id: string,
  parentId: string | null,
  siblingIndex: number,
  createdAt: number,
): Message {
  return {
    id,
    chatId,
    parentId,
    siblingIndex,
    turnId: `turn-${id}`,
    turnIndex: createdAt,
    createdAt,
    role: createdAt % 2 === 0 ? 'assistant' : 'user',
    origin: createdAt % 2 === 0 ? 'generated' : 'user',
    content: [{ type: 'text', text: `body ${id}` }],
    nodeVersion: 0,
    deleted: false,
  }
}

export async function expectWorkspaceRepositoryCoreContract(
  repository: WorkspaceRepository,
): Promise<void> {
  const before = await repository.getWorkspaceMeta()
  const chat = await repository.createChat(contractChat('contract-chat'))
  expect(await repository.getChat(chat.id)).toEqual(chat)
  expect((await repository.listChats()).map((row) => row.id)).toContain(chat.id)
  const afterCreate = await repository.getWorkspaceMeta()
  expect(afterCreate.workspaceId).toBe(before.workspaceId)
  expect(afterCreate.backendKind).not.toBe('unknown')
  expect(afterCreate.mutationCounter).toBeGreaterThan(before.mutationCounter)

  const root = contractMessage(chat.id, 'contract-root', null, 0, 1)
  const older = contractMessage(chat.id, 'contract-older', root.id, 0, 2)
  const newer = contractMessage(chat.id, 'contract-newer', root.id, 1, 3)
  const mutation = await repository.runMutation(
    [
      { kind: 'message', messageId: root.id },
      { kind: 'message', messageId: older.id },
      { kind: 'message', messageId: newer.id },
      { kind: 'children', chatId: chat.id, parentId: null },
      { kind: 'children', chatId: chat.id, parentId: root.id },
    ],
    async (context) => {
      await context.putMessage(root)
      await context.putMessage(older)
      await context.putMessage(newer)
      return 'committed'
    },
  )
  expect(mutation.value).toBe('committed')
  expect(mutation.affectedMessageIds).toEqual([root.id, older.id, newer.id])
  expect(mutation.chatVersions[chat.id]).toBeDefined()
  expect(await repository.getMessage(root.id)).toEqual(
    expect.objectContaining({ ...root, attachmentRefs: [] }),
  )
  expect(await repository.getMessageTextPreview(root.id)).toBe('body contract-root')
  expect(await repository.getMessageHeader(root.id)).toEqual(
    expect.objectContaining({ id: root.id, textPreview: 'body contract-root' }),
  )

  const defaultSnapshot = await repository.getActiveBranchSnapshot(chat.id, {})
  expect(defaultSnapshot.branch.map((message) => message.id)).toEqual([root.id, newer.id])
  const cursor: CursorMap = { [root.id]: older.id }
  const pinnedWindow = await repository.getActiveBranchWindowSnapshot(chat.id, cursor, {
    offset: -1,
    limit: 1,
  })
  expect(pinnedWindow.branchHeaders.map((message) => message.id)).toEqual([root.id, older.id])
  expect(pinnedWindow.branchWindow.map((message) => message.id)).toEqual([older.id])
  expect(pinnedWindow.branchLength).toBe(2)
}

export async function expectWorkspaceRepositoryRollbackContract(
  repository: WorkspaceRepository,
): Promise<void> {
  const chat = await repository.createChat(contractChat('rollback-chat'))
  const message = contractMessage(chat.id, 'rollback-message', null, 0, 1)
  const before = await repository.getWorkspaceMeta()
  await expect(
    repository.runMutation(
      [
        { kind: 'message', messageId: message.id },
        { kind: 'children', chatId: chat.id, parentId: null },
      ],
      async (context) => {
        await context.putMessage(message)
        throw new Error('contract rollback')
      },
    ),
  ).rejects.toThrow('contract rollback')
  expect(await repository.getMessage(message.id)).toBeUndefined()
  expect((await repository.getWorkspaceMeta()).mutationCounter).toBe(before.mutationCounter)
}

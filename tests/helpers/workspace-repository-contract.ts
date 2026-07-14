import { expect } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, Message } from '../../src/core/types'
import { ExpectedLeafChangedError, type WorkspaceRepository } from '../../src/store/repository'

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
  const revisionSnapshot = await repository.getSendContextRevisionSnapshot(chat.id, [
    newer.id,
    'contract-missing',
    root.id,
  ])
  expect(revisionSnapshot.chat?.settings).toEqual(chat.settings)
  expect(revisionSnapshot.headers.map((header) => header?.id)).toEqual([
    newer.id,
    undefined,
    root.id,
  ])

  const defaultSnapshot = await repository.getActiveBranchSnapshot(chat.id, {})
  expect(defaultSnapshot.branch.map((message) => message.id)).toEqual([root.id, newer.id])
  const pageMeasurements: Array<{ pageHeaderRowsRead: number; bodyRowsRead: number }> = []
  const pinnedPageResult = await repository.getKnownBranchPageSnapshot(
    chat.id,
    [root.id, older.id],
    {
      offset: -1,
      limit: 1,
      onMeasure: (measurement) => pageMeasurements.push(measurement),
    },
  )
  expect(pinnedPageResult.kind).toBe('ready')
  if (pinnedPageResult.kind !== 'ready') throw new Error('expected ready branch page')
  expect(pinnedPageResult.snapshot.pageHeaders.map((message) => message.id)).toEqual([older.id])
  expect(pinnedPageResult.snapshot.pageMessages.map((message) => message.id)).toEqual([older.id])
  expect(pinnedPageResult.snapshot.pageOffset).toBe(1)
  expect(pinnedPageResult.snapshot.branchLength).toBe(2)
  expect(pageMeasurements).toEqual([{ pageHeaderRowsRead: 1, bodyRowsRead: 1 }])
  await expect(
    repository.getKnownBranchPageSnapshot(chat.id, [], { offset: -1, limit: 1 }),
  ).resolves.toMatchObject({ kind: 'stale-path', reason: 'empty-path' })
  await expect(
    repository.getKnownBranchPageSnapshot(chat.id, [root.id, older.id, newer.id], {
      offset: 1,
      limit: 2,
    }),
  ).resolves.toMatchObject({
    kind: 'stale-path',
    reason: 'non-contiguous',
    messageId: newer.id,
  })

  await expect(
    repository.getKnownBranchPageSnapshot(chat.id, [root.id, root.id], {
      offset: 0,
      limit: 2,
    }),
  ).resolves.toMatchObject({ kind: 'stale-path', reason: 'duplicate-id', messageId: root.id })
  await expect(
    repository.getKnownBranchPageSnapshot(chat.id, ['contract-missing'], {
      offset: -1,
      limit: 1,
    }),
  ).resolves.toMatchObject({
    kind: 'stale-path',
    reason: 'missing-header',
    messageId: 'contract-missing',
  })
  await expect(
    repository.getKnownBranchPageSnapshot('contract-other-chat', [root.id], {
      offset: -1,
      limit: 1,
    }),
  ).resolves.toMatchObject({ kind: 'stale-path', reason: 'wrong-chat', messageId: root.id })
  await expect(
    repository.getKnownBranchPageSnapshot(chat.id, [older.id], { offset: -1, limit: 1 }),
  ).resolves.toMatchObject({ kind: 'stale-path', reason: 'non-root', messageId: older.id })
  await expect(
    repository.getKnownBranchPageSnapshot(chat.id, [root.id, older.id, newer.id], {
      offset: -1,
      limit: 1,
    }),
  ).resolves.toMatchObject({ kind: 'stale-path', reason: 'non-contiguous', messageId: newer.id })

  await repository.runMutation(
    [
      { kind: 'message', messageId: older.id },
      { kind: 'children', chatId: chat.id, parentId: root.id },
    ],
    async (context) => context.putMessage({ ...older, deleted: true }),
  )
  await expect(
    repository.getKnownBranchPageSnapshot(chat.id, [root.id, older.id], {
      offset: -1,
      limit: 1,
    }),
  ).resolves.toMatchObject({ kind: 'stale-path', reason: 'deleted-header', messageId: older.id })
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

export async function expectWorkspaceRepositoryExpectedLeafAppendContract(
  repository: WorkspaceRepository,
): Promise<void> {
  const chat = await repository.createChat(contractChat('expected-leaf-chat'))
  const rootTemplate = contractMessage(chat.id, 'expected-leaf-root', null, 0, 1)
  const { parentId, siblingIndex, nodeVersion, deleted, ...root } = rootTemplate
  void parentId
  void siblingIndex
  void nodeVersion
  void deleted
  await repository.appendMessageToExpectedLeaf({ expectedLeafId: null, message: root })

  const candidate = (id: string, createdAt: number) => {
    const template = contractMessage(chat.id, id, root.id, 0, createdAt)
    const {
      parentId: ignoredParent,
      siblingIndex: ignoredSiblingIndex,
      nodeVersion: ignoredNodeVersion,
      deleted: ignoredDeleted,
      ...message
    } = template
    void ignoredParent
    void ignoredSiblingIndex
    void ignoredNodeVersion
    void ignoredDeleted
    return repository.appendMessageToExpectedLeaf({ expectedLeafId: root.id, message })
  }

  const before = await repository.getWorkspaceMeta()
  const settled = await Promise.allSettled([
    candidate('expected-leaf-a', 2),
    candidate('expected-leaf-b', 3),
  ])
  const fulfilled = settled.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof candidate>>> =>
      result.status === 'fulfilled',
  )
  const rejected = settled.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  expect(fulfilled).toHaveLength(1)
  expect(rejected).toHaveLength(1)
  expect(rejected[0]?.reason).toBeInstanceOf(ExpectedLeafChangedError)

  const winnerId = fulfilled[0]?.value.message.id
  const loserId = winnerId === 'expected-leaf-a' ? 'expected-leaf-b' : 'expected-leaf-a'
  expect(await repository.getMessage(loserId)).toBeUndefined()
  const children = await repository.listChildHeaders(chat.id, root.id)
  expect(children.filter((row) => !row.deleted).map((row) => row.id)).toEqual([winnerId])
  expect(new Set(children.map((row) => row.siblingIndex)).size).toBe(children.length)
  expect((await repository.getChat(chat.id))?.lastUpdatedLeafId).toBe(winnerId)
  expect((await repository.getWorkspaceMeta()).mutationCounter).toBe(before.mutationCounter + 1)

  await expect(candidate('expected-leaf-stale', 4)).rejects.toBeInstanceOf(ExpectedLeafChangedError)
  expect(await repository.getMessage('expected-leaf-stale')).toBeUndefined()
}

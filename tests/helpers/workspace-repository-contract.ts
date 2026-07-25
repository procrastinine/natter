import { expect } from 'vitest'
import { createBranchPath } from '../../src/core/branch-session'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  fixedConversationSelectionTarget,
  resolvingConversationSelectionTarget,
} from '../../src/core/messages'
import type { Chat } from '../../src/core/types'
import type {
  CommitEnvelope,
  ReadEnvelope,
  WorkspaceCommand,
  WorkspaceCommandResult,
  WorkspaceQuery,
  WorkspaceQueryResult,
  WorkspaceRepository,
} from '../../src/store/workspace-protocol'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'
import { putTestChat } from './chats'

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
    structuralVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function read<Q extends WorkspaceQuery>(
  repository: WorkspaceRepository,
  query: Q,
): Promise<ReadEnvelope<WorkspaceQueryResult<Q>>> {
  return runWorkspaceRead('repository-query', (permit) => repository.query(permit, query))
}

function write<C extends WorkspaceCommand>(
  repository: WorkspaceRepository,
  command: C,
): Promise<CommitEnvelope<WorkspaceCommandResult<C>>> {
  return runWorkspaceAction('maintenance', (permit) => repository.execute(permit, command))
}

export async function expectWorkspaceRepositoryCoreContract(
  repository: WorkspaceRepository,
): Promise<void> {
  const before = await read(repository, { kind: 'workspace.meta' })
  const chat = await putTestChat(contractChat('contract-chat'))
  expect((await read(repository, { kind: 'chat.get', chatId: chat.id })).value).toEqual(chat)
  const afterCreate = await read(repository, { kind: 'workspace.meta' })
  expect(afterCreate.workspaceId).toBe(before.workspaceId)
  expect(afterCreate.replacementEpoch).toBe(before.replacementEpoch)
  expect(afterCreate.value.backendKind).not.toBe('unknown')

  const rootCommit = await write(repository, {
    kind: 'message.import',
    input: {
      chatId: chat.id,
      slot: { kind: 'at-end' },
      activeLeafId: null,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'body contract-root' }] }],
      now: 1,
    },
  })
  const root = rootCommit.value.presentations[0]
  if (!root) throw new Error('ExpectedRootPresentation')
  const olderCommit = await write(repository, {
    kind: 'message.import',
    input: {
      chatId: chat.id,
      slot: { kind: 'at-end' },
      activeLeafId: root.message.id,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'body contract-older' }] }],
      now: 2,
    },
  })
  const older = olderCommit.value.presentations[0]
  if (!older) throw new Error('ExpectedOlderPresentation')
  const newerCommit = await write(repository, {
    kind: 'message.import',
    input: {
      chatId: chat.id,
      slot: { kind: 'sibling', messageId: older.message.id },
      activeLeafId: older.message.id,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'body contract-newer' }] }],
      now: 3,
    },
  })
  const newer = newerCommit.value.presentations[0]
  if (!newer) throw new Error('ExpectedNewerPresentation')
  expect(rootCommit.receipt.messageRevisions.map((revision) => revision.header.id)).toContain(
    root.message.id,
  )
  expect(olderCommit.receipt.messageRevisions.map((revision) => revision.header.id)).toContain(
    older.message.id,
  )
  expect(newerCommit.receipt.messageRevisions.map((revision) => revision.header.id)).toContain(
    newer.message.id,
  )
  for (const [commit, messageId] of [
    [rootCommit, root.message.id],
    [olderCommit, older.message.id],
    [newerCommit, newer.message.id],
  ] as const) {
    const revision = commit.receipt.messageRevisions.find(
      (candidate) => candidate.header.id === messageId,
    )
    const committedChat = commit.receipt.chats.find((candidate) => candidate.id === chat.id)
    expect(revision?.structuralVersion).toBe(committedChat?.structuralVersion)
    expect(revision?.header).toEqual(expect.objectContaining({ id: messageId, chatId: chat.id }))
  }

  const rootPresentation = (
    await read(repository, { kind: 'message.presentation', messageId: root.message.id })
  ).value
  expect(rootPresentation?.message).toEqual(
    expect.objectContaining({ id: root.message.id, attachmentRefs: [] }),
  )
  expect(rootPresentation?.header).toEqual(expect.objectContaining({ id: root.message.id }))
  const rootPreview = (
    await read(repository, {
      kind: 'message.preview-window',
      targets: [{ messageId: root.message.id, bodyVersion: rootPresentation?.bodyVersion ?? -1 }],
    })
  ).value[0]
  expect(rootPreview?.text).toBe('body contract-root')

  const [revisionChat, revisionTopology] = await Promise.all([
    read(repository, { kind: 'chat.get', chatId: chat.id }),
    read(repository, { kind: 'message.headers-by-chat', chatId: chat.id }),
  ])
  expect(revisionChat.value?.settings).toEqual(chat.settings)
  expect(revisionTopology.value.kind).toBe('ready')
  if (revisionTopology.value.kind !== 'ready') {
    throw new Error('ExpectedReadyContractTopology')
  }
  expect(revisionTopology.value.chat.settings).toEqual(chat.settings)
  expect(revisionTopology.value.structuralVersion).toBe(
    revisionTopology.value.chat.structuralVersion,
  )
  expect(new Set(revisionTopology.value.headers.map((header) => header.id))).toEqual(
    new Set([root.message.id, older.message.id, newer.message.id]),
  )
  expect(revisionTopology.value.headers.some((header) => header.id === 'contract-missing')).toBe(
    false,
  )

  const defaultSelection = (
    await read(repository, {
      kind: 'branch.open',
      chatId: chat.id,
      target: resolvingConversationSelectionTarget({ kind: 'default' }),
      bodyDemand: 'terminal',
    })
  ).value
  expect(defaultSelection.kind).toBe('ready')
  if (defaultSelection.kind !== 'ready') throw new Error('ExpectedReadyDefaultSelection')
  expect(defaultSelection.proof.pathHeaders.map((message) => message.id)).toEqual([
    root.message.id,
    newer.message.id,
  ])

  const olderSelection = (
    await read(repository, {
      kind: 'branch.open',
      chatId: chat.id,
      target: fixedConversationSelectionTarget(
        { kind: 'tip', messageId: older.message.id },
        older.message.id,
      ),
      bodyDemand: 'terminal',
    })
  ).value
  expect(olderSelection.kind).toBe('ready')
  if (olderSelection.kind !== 'ready') throw new Error('ExpectedReadyPinnedSelection')
  const olderPath = createBranchPath(olderSelection.proof.pathHeaders)
  const pinnedPage = await read(repository, {
    kind: 'branch.page-structure',
    chatId: chat.id,
    resolvedTipId: older.message.id,
    structuralVersion: olderSelection.proof.structuralVersion,
    window: olderPath.window({ offset: -1, limit: 1 }),
  })
  expect(pinnedPage.value.kind).toBe('ready')
  if (pinnedPage.value.kind !== 'ready') throw new Error('ExpectedReadyBranchPage')
  expect(pinnedPage.value.snapshot.pageHeaders.map((message) => message.id)).toEqual([
    older.message.id,
  ])
  expect(pinnedPage.value.snapshot.pageOffset).toBe(1)
  expect(pinnedPage.value.snapshot.branchLength).toBe(2)
  const pinnedMaterial = (
    await read(repository, {
      kind: 'message.presentations',
      messageIds: pinnedPage.value.snapshot.pageHeaders.map((header) => header.id),
    })
  ).value
  expect(pinnedMaterial.map((presentation) => presentation?.message.id)).toEqual([older.message.id])

  const [rootHeader, olderHeader] = olderSelection.proof.pathHeaders
  const newerHeader = newer.header
  if (!rootHeader || !olderHeader) throw new Error('ExpectedPinnedHeaders')
  await expect(
    read(repository, {
      kind: 'branch.page-structure',
      chatId: chat.id,
      resolvedTipId: older.message.id,
      structuralVersion: olderSelection.proof.structuralVersion,
      window: {
        branchLength: 0,
        offset: 0,
        limit: 1,
        boundaryParentId: null,
        nodes: [],
      },
    }),
  ).resolves.toMatchObject({ value: { kind: 'stale-path', reason: 'empty-path' } })
  await expect(
    read(repository, {
      kind: 'branch.page-structure',
      chatId: chat.id,
      resolvedTipId: root.message.id,
      structuralVersion: olderSelection.proof.structuralVersion,
      window: {
        branchLength: 2,
        offset: 0,
        limit: 2,
        boundaryParentId: null,
        nodes: [rootHeader, rootHeader],
      },
    }),
  ).resolves.toMatchObject({
    value: { kind: 'stale-path', reason: 'duplicate-id', messageId: root.message.id },
  })
  await expect(
    read(repository, {
      kind: 'branch.page-structure',
      chatId: chat.id,
      resolvedTipId: 'contract-missing',
      structuralVersion: olderSelection.proof.structuralVersion,
      window: {
        branchLength: 1,
        offset: 0,
        limit: 1,
        boundaryParentId: null,
        nodes: [{ ...rootHeader, id: 'contract-missing' }],
      },
    }),
  ).resolves.toMatchObject({
    value: { kind: 'stale-path', reason: 'missing-header', messageId: 'contract-missing' },
  })
  const otherChat = await putTestChat(contractChat('contract-other-chat'))
  await expect(
    read(repository, {
      kind: 'branch.page-structure',
      chatId: otherChat.id,
      resolvedTipId: root.message.id,
      structuralVersion: otherChat.structuralVersion,
      window: {
        branchLength: 1,
        offset: 0,
        limit: 1,
        boundaryParentId: null,
        nodes: [rootHeader],
      },
    }),
  ).resolves.toMatchObject({
    value: { kind: 'stale-path', reason: 'wrong-chat', messageId: root.message.id },
  })
  await expect(
    read(repository, {
      kind: 'branch.page-structure',
      chatId: chat.id,
      resolvedTipId: older.message.id,
      structuralVersion: olderSelection.proof.structuralVersion,
      window: {
        branchLength: 1,
        offset: 0,
        limit: 1,
        boundaryParentId: null,
        nodes: [olderHeader],
      },
    }),
  ).resolves.toMatchObject({
    value: { kind: 'stale-path', reason: 'non-root', messageId: older.message.id },
  })
  await expect(
    read(repository, {
      kind: 'branch.page-structure',
      chatId: chat.id,
      resolvedTipId: newer.message.id,
      structuralVersion: olderSelection.proof.structuralVersion,
      window: {
        branchLength: 3,
        offset: 0,
        limit: 3,
        boundaryParentId: null,
        nodes: [rootHeader, olderHeader, newerHeader],
      },
    }),
  ).resolves.toMatchObject({
    value: { kind: 'stale-path', reason: 'non-contiguous', messageId: newer.message.id },
  })

  const deleteCommit = await write(repository, {
    kind: 'message.delete',
    mode: 'single',
    input: {
      chatId: chat.id,
      messageId: older.message.id,
      activeLeafId: older.message.id,
      now: 4,
    },
  })
  const deletedChat = deleteCommit.receipt.chats.find((row) => row.id === chat.id)
  if (!deletedChat) throw new Error('ExpectedDeletedChatReceipt')
  await expect(
    read(repository, {
      kind: 'branch.page-structure',
      chatId: chat.id,
      resolvedTipId: older.message.id,
      structuralVersion: deletedChat.structuralVersion,
      window: olderPath.window({ offset: -1, limit: 1 }),
    }),
  ).resolves.toMatchObject({
    value: { kind: 'stale-path', reason: 'deleted-header', messageId: older.message.id },
  })
}

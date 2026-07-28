import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, MessageAttachmentRef } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import {
  markAttachmentIntegrityRepairPending,
  pendingAttachmentIntegrityState,
} from '../../src/store/attachment-integrity-maintenance'
import { ingestAttachmentBytes } from '../../src/store/attachments'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
  tryExecuteBrowserWorkspaceCommandWithinFanoutBudget,
} from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { buildChat } from '../../src/store/chats'
import { __resetDbForTests, getDb } from '../../src/store/db'
import {
  awaitStorageMaintenanceRuntimeIdle,
  closeStorageMaintenanceRuntime,
} from '../../src/store/storage-maintenance-runtime'
import type {
  AttachmentIntegrityMaintenanceResult,
  WorkspaceCommand,
} from '../../src/store/workspace-protocol'
import { runWorkspaceAction } from '../../src/store/workspace-runtime'
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'
import { putTestChat } from '../helpers/chats'
import { putTestMessages } from '../helpers/message-storage'

beforeEach(async () => {
  await resetWorkspace()
  await openBrowserWorkspace()
  closeStorageMaintenanceRuntime()
  await awaitStorageMaintenanceRuntimeIdle()
  await markIntegrityPending()
})

afterEach(async () => {
  await shutdownBrowserWorkspace()
  await resetWorkspace()
})

describe('attachment integrity maintenance', () => {
  it('repairs stale counts, orphan edges, catalog rows, and aggregate in bounded cold pages', async () => {
    const chat = await seedChat()
    const first = await seedAttachment('first.txt', 1)
    const ref = attachmentRef(first, 4)
    const messageId = await appendMessage(chat, ref)
    const second = await seedAttachment('second.txt', 2)
    const third = await seedAttachment('third.txt', 3)
    const fourth = await seedAttachment('fourth.txt', 4)
    const draftRef = attachmentRef(fourth, 5)
    await execute({
      kind: 'draft.put',
      input: {
        draft: { chatId: chat.id, text: 'draft', attachmentRefs: [draftRef], updatedAt: 5 },
        expectedUpdatedAt: null,
      },
    })
    const db = getDb()
    const firstCatalog = await db.attachmentCatalogRows.get(first)
    const aggregate = await db.attachmentCatalogAggregate.get('workspace')
    if (!firstCatalog || !aggregate) throw new Error('attachment projection seed missing')
    await db.transaction(
      'rw',
      [
        db.attachmentCatalogAggregate,
        db.attachmentCatalogRows,
        db.attachmentRefEdges,
        db.attachments,
      ],
      async () => {
        await db.attachments.update(first, { refCount: 0 })
        await db.attachments.update(second, { refCount: 9 })
        await db.attachments.update(third, { refCount: 1 })
        await db.attachments.update(fourth, { refCount: 0 })
        await db.attachmentRefEdges.bulkDelete([
          ['message', messageId, ref.refId],
          ['draft', chat.id, draftRef.refId],
        ])
        await db.attachmentRefEdges.put({
          ownerKind: 'message',
          ownerId: 'missing-owner',
          chatId: chat.id,
          refId: 'orphan-ref',
          attachmentId: third,
          ordinal: 0,
          includeInContext: true,
          refUpdatedAt: 5,
        })
        await db.attachmentCatalogRows.put({ ...firstCatalog, id: 'ghost-attachment' })
        await db.attachmentCatalogAggregate.put({
          ...aggregate,
          totalCount: 999,
          activeCount: 999,
          referencedCount: 999,
          unreferencedCount: 0,
          totalSizeBytes: 999_999,
        })
      },
    )
    const bodyReads = [
      vi.spyOn(db.messageBodies, 'get'),
      vi.spyOn(db.messageBodies, 'bulkGet'),
      vi.spyOn(db.messageBodies, 'toArray'),
      vi.spyOn(db.attachmentBlobs, 'get'),
      vi.spyOn(db.attachmentBlobs, 'bulkGet'),
      vi.spyOn(db.attachmentBlobs, 'toArray'),
    ]
    const wholeMessageRead = vi.spyOn(db.messages, 'toArray')
    const wholeAttachmentRead = vi.spyOn(db.attachments, 'toArray')
    const pages: AttachmentIntegrityMaintenanceResult[] = []
    for (;;) {
      const result = await reconcilePageWithinDirectBudget(1)
      pages.push(result)
      if (result.done) break
    }

    expect(pages.every((page) => page.scanned <= 1)).toBe(true)
    expect(new Set(pages.map((page) => page.phase))).toEqual(
      new Set(['messages', 'drafts', 'edges', 'attachments', 'catalog', 'aggregate']),
    )
    expect((await db.attachments.get(first))?.refCount).toBe(1)
    expect((await db.attachments.get(second))?.refCount).toBe(0)
    expect((await db.attachments.get(third))?.refCount).toBe(0)
    expect((await db.attachments.get(fourth))?.refCount).toBe(1)
    expect(await db.attachmentRefEdges.get(['message', messageId, ref.refId])).toBeDefined()
    expect(await db.attachmentRefEdges.get(['draft', chat.id, draftRef.refId])).toBeDefined()
    expect(
      await db.attachmentRefEdges.get(['message', 'missing-owner', 'orphan-ref']),
    ).toBeUndefined()
    expect(await db.attachmentCatalogRows.get('ghost-attachment')).toBeUndefined()
    expect(await db.attachmentCatalogAggregate.get('workspace')).toMatchObject({
      totalCount: 4,
      activeCount: 4,
      referencedCount: 2,
      unreferencedCount: 2,
    })
    expect(bodyReads.every((spy) => spy.mock.calls.length === 0)).toBe(true)
    expect(wholeMessageRead).not.toHaveBeenCalled()
    expect(wholeAttachmentRead).not.toHaveBeenCalled()
    await expectAttachmentReferenceInvariants(db)

    await execute({
      kind: 'attachment.reap',
      now: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 0,
      limit: 32,
    })
    expect(await db.attachments.get(first)).toBeDefined()
    expect(await db.attachments.get(second)).toBeUndefined()
    expect(await db.attachments.get(third)).toBeUndefined()
    expect(await db.attachments.get(fourth)).toBeDefined()
  })

  it('serializes a canonical ref mutation with edge reconciliation without deleting its target', async () => {
    const chat = await seedChat()
    const attachmentId = await seedAttachment('race.txt', 1)
    const ref = attachmentRef(attachmentId, 2)
    const messageId = await appendMessage(chat, ref)

    await Promise.all([
      reconcilePage(32),
      execute({
        kind: 'attachment.ref.detach',
        input: {
          owner: { kind: 'message', messageId, expectedChatId: chat.id },
          refId: ref.refId,
          expectedAttachmentId: attachmentId,
          now: 3,
        },
      }),
    ])

    expect(await getDb().attachments.get(attachmentId)).toBeDefined()
    expect((await getDb().attachments.get(attachmentId))?.refCount).toBe(0)
    expect(
      await getDb().attachmentRefEdges.where('attachmentId').equals(attachmentId).count(),
    ).toBe(0)
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('pages both directions of a high-fanout reference graph by actual edge rows', async () => {
    const chat = await seedChat()
    const refs: MessageAttachmentRef[] = []
    for (let index = 0; index < 33; index += 1) {
      refs.push(attachmentRef(await seedAttachment(`many-${index}.txt`, index + 1), index + 1))
    }
    await appendMessageWithRefs(chat, refs)
    const db = getDb()
    await db.attachmentIntegrityState.put(pendingAttachmentIntegrityState())
    const pages: AttachmentIntegrityMaintenanceResult[] = []
    for (;;) {
      const result = await reconcilePage(1)
      pages.push(result)
      if (result.done) break
    }

    expect(pages.every((page) => page.scanned <= 1)).toBe(true)
    expect(pages.filter((page) => page.phase === 'messages')).toHaveLength(34)
    expect(pages.filter((page) => page.phase === 'edges').length).toBe(34)
    expect(pages.filter((page) => page.phase === 'attachments')).toHaveLength(34)
    await expectAttachmentReferenceInvariants(db)
  })
})

async function resetWorkspace(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  await Dexie.delete('natter')
}

async function markIntegrityPending(): Promise<void> {
  const db = getDb()
  await db.transaction('rw', [db.attachmentCatalogAggregate, db.attachmentIntegrityState], (tx) =>
    markAttachmentIntegrityRepairPending(tx),
  )
}

async function execute(command: WorkspaceCommand): Promise<unknown> {
  return runWorkspaceAction('maintenance', async (permit) => {
    const commit = await getBrowserRepository().execute(permit, command)
    return commit.value
  })
}

async function reconcilePage(limit: number): Promise<AttachmentIntegrityMaintenanceResult> {
  return (await execute({
    kind: 'maintenance.reconcile-attachment-integrity',
    limit,
    now: Date.now(),
  })) as AttachmentIntegrityMaintenanceResult
}

async function reconcilePageWithinDirectBudget(
  limit: number,
): Promise<AttachmentIntegrityMaintenanceResult> {
  return runWorkspaceAction('maintenance', async (permit) => {
    const admission = await tryExecuteBrowserWorkspaceCommandWithinFanoutBudget(
      permit,
      {
        kind: 'maintenance.reconcile-attachment-integrity',
        limit,
        now: Date.now(),
      },
      { maxReadRows: 64, maxWriteRows: 64, maxBytes: 1024 * 1024 },
    )
    expect(admission.kind).toBe('committed')
    if (admission.kind !== 'committed') throw new Error('AttachmentIntegrityUnexpectedStaging')
    return admission.execution.commit.value
  })
}

async function seedChat(): Promise<Chat> {
  const chat = buildChat({
    id: newId(),
    settings: cloneDefaultChatSettings(),
    now: 1,
  })
  return putTestChat(chat)
}

async function seedAttachment(filename: string, now: number): Promise<string> {
  const result = await ingestAttachmentBytes({
    blob: new Blob([filename], { type: 'text/plain' }),
    filename,
    now,
  })
  return result.attachment.id
}

function attachmentRef(attachmentId: string, now: number): MessageAttachmentRef {
  return {
    refId: newId(),
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt: now,
    updatedAt: now,
  }
}

async function appendMessage(chat: Chat, ref: MessageAttachmentRef): Promise<string> {
  return appendMessageWithRefs(chat, [ref])
}

async function appendMessageWithRefs(
  chat: Chat,
  refs: readonly MessageAttachmentRef[],
): Promise<string> {
  const messageId = newId()
  await putTestMessages([
    {
      id: messageId,
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: newId(),
      turnIndex: 0,
      createdAt: refs[0]?.createdAt ?? 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'attachment' }],
      attachmentRefs: [...refs],
      nodeVersion: 0,
      deleted: false,
    },
  ])
  return messageId
}

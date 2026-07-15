// Phase 8.1 invariants: chat-fork, inline-editor plaintext round-trip,
// undo-snapshot, and the "branch = leaf selection" safety net.
//
// Focused on the new surface landed in 8.1 — the existing exhaustive
// coverage for editInPlace / regenerate / delete / insert / swipe lives
// in `tests/unit/messages.test.ts`.

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  collectAncestorsToMessage,
  computeBranchTitle,
  forkChatFromMessage,
} from '../../src/core/chat-fork'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { deletePair } from '../../src/core/messages'
import type {
  Attachment,
  Chat,
  ChatId,
  ContinuationAttempt,
  Message,
  MessageAttachmentRef,
  MessageId,
  MessageRole,
} from '../../src/core/types'
import { applyStructuralSnapshot, snapshotMessages } from '../../src/core/undo'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import {
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { loadChatMessages } from '../../src/store/chats'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { plaintextOf, writeTextInto } from '../../src/ui/chat/InlineEditor'
import { expectAttachmentReferenceInvariants } from '../helpers/attachment-reference-invariants'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  __resetBroadcastForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

async function seedChat(title = 'Source'): Promise<Chat> {
  const chat: Chat = {
    id: newId(),
    title,
    titleStatus: 'manual',
    createdAt: 100,
    updatedAt: 100,
    lastViewedAt: 100,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 100,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  await getDb().chats.put(chat)
  return chat
}

interface SeedMsg {
  id?: MessageId
  parentId?: MessageId | null
  siblingIndex?: number
  role?: MessageRole
  createdAt?: number
  text?: string
  deleted?: boolean
}

async function putMessage(chatId: ChatId, spec: SeedMsg = {}): Promise<Message> {
  const row: Message = {
    id: spec.id ?? newId(),
    chatId,
    parentId: spec.parentId ?? null,
    siblingIndex: spec.siblingIndex ?? 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: spec.createdAt ?? 1,
    role: spec.role ?? 'user',
    origin: 'user',
    content: [{ type: 'text', text: spec.text ?? 'x' }],
    nodeVersion: 0,
    deleted: spec.deleted ?? false,
  }
  const { header, body } = splitMessageForStorage(row)
  await getDb().messages.put(header)
  await getDb().messageBodies.put(body)
  return row
}

async function putFullMessage(row: Message): Promise<void> {
  await getBrowserRepository().runMutation(
    [
      { kind: 'message', messageId: row.id },
      { kind: 'children', chatId: row.chatId, parentId: row.parentId },
      ...[...new Set((row.attachmentRefs ?? []).map((ref) => ref.attachmentId))].map(
        (attachmentId) => ({ kind: 'attachment' as const, attachmentId }),
      ),
    ],
    async (ctx) => {
      await ctx.putMessage(row)
    },
  )
}

function attachment(id: string, refCount: number): Attachment {
  return {
    id,
    kind: 'plaintext',
    mime: 'text/plain',
    filename: `${id}.txt`,
    origin: 'user-upload',
    createdAt: 1,
    updatedAt: 1,
    storage: { kind: 'missing', reason: 'import-missing', missingSince: 1 },
    artifacts: [],
    processing: [],
    refCount,
  }
}

function attachmentRef(
  refId: string,
  attachmentId: string,
  deletedAt?: number,
): MessageAttachmentRef {
  return {
    refId,
    attachmentId,
    includeInContext: true,
    presentation: { label: refId },
    createdAt: 1,
    updatedAt: 1,
    ...(deletedAt === undefined ? {} : { deletedAt }),
  }
}

describe('computeBranchTitle', () => {
  it('starts at "Branch 1" on the first fork', () => {
    expect(computeBranchTitle('Design review', [])).toBe('Design review Branch 1')
  })
  it('uses "Untitled chat Branch 1" when the source has no title', () => {
    expect(computeBranchTitle('', [])).toBe('Untitled chat Branch 1')
    expect(computeBranchTitle('   ', [])).toBe('Untitled chat Branch 1')
  })
  it('skips taken branch numbers', () => {
    const existing = ['Design review', 'Design review Branch 1', 'Design review Branch 2']
    expect(computeBranchTitle('Design review', existing)).toBe('Design review Branch 3')
  })
  it('does not reuse "Branch 2" when "Branch 3" exists but 2 is free', () => {
    const existing = ['Notes', 'Notes Branch 3']
    expect(computeBranchTitle('Notes', existing)).toBe('Notes Branch 1')
  })
})

describe('collectAncestorsToMessage', () => {
  it('returns root→target in order, excluding siblings and descendants', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'R', createdAt: 1 })
    await putMessage(chat.id, {
      id: 'A',
      parentId: 'R',
      role: 'assistant',
      createdAt: 2,
    })
    await putMessage(chat.id, {
      id: 'A2',
      parentId: 'R',
      role: 'assistant',
      createdAt: 2,
      siblingIndex: 1,
    })
    await putMessage(chat.id, {
      id: 'U2',
      parentId: 'A',
      role: 'user',
      createdAt: 3,
    })
    await putMessage(chat.id, {
      id: 'A3',
      parentId: 'U2',
      role: 'assistant',
      createdAt: 4,
    })
    const rows = await loadChatMessages(chat.id)
    const ancestors = collectAncestorsToMessage(rows, 'U2')
    expect(ancestors.map((a) => a.id)).toEqual(['R', 'A', 'U2'])
  })
})

describe('forkChatFromMessage', () => {
  it('copies only the active-path ancestors into a fresh chat with a new title', async () => {
    const chat = await seedChat('Design review')
    await putMessage(chat.id, { id: 'R', text: 'root', createdAt: 1 })
    await putMessage(chat.id, {
      id: 'A',
      parentId: 'R',
      role: 'assistant',
      text: 'a',
      createdAt: 2,
    })
    await putMessage(chat.id, {
      id: 'A2',
      parentId: 'R',
      role: 'assistant',
      text: 'a2',
      createdAt: 2,
      siblingIndex: 1,
    })
    await putMessage(chat.id, {
      id: 'U2',
      parentId: 'A',
      role: 'user',
      text: 'u2',
      createdAt: 3,
    })
    const { chatId: forkId, messageCount } = await forkChatFromMessage({
      chatId: chat.id,
      messageId: 'A',
      title: 'Design review Branch 1',
      cursor: {},
    })
    expect(messageCount).toBe(2)
    const fork = await getDb().chats.get(forkId)
    expect(fork?.title).toBe('Design review Branch 1')
    expect(fork?.titleStatus).toBe('manual')
    expect(fork?.previewText).toBe('root')
    const forkMessages = await loadChatMessages(forkId)
    expect(forkMessages).toHaveLength(2)
    const roles = forkMessages.sort((a, b) => a.createdAt - b.createdAt).map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant'])
    // The sibling A2 and descendant U2 are NOT copied.
    for (const m of forkMessages) {
      expect(['root', 'a']).toContain((m.content[0] as { type: string; text: string }).text)
    }
    // Source chat is untouched.
    const sourceRows = await loadChatMessages(chat.id)
    expect(sourceRows).toHaveLength(4)
  })

  it('atomically preserves every message field and increments only live attachment refs', async () => {
    const chat = await seedChat('Fidelity')
    chat.presetId = 'preset-1'
    await getDb().chats.put(chat)
    await getDb().attachments.bulkPut([
      attachment('live-attachment', 0),
      attachment('dead-only', 0),
    ])
    const continuationAttempt: ContinuationAttempt = {
      streamId: 'continuation-1',
      strategy: 'prefill',
      status: 'done',
      requestedModel: 'requested-model',
      model: 'actual-model',
      apiUsed: 'responses',
      provider: 'provider-a',
      generationId: 'continuation-generation',
      startedAt: 3,
      finishedAt: 4,
      finishReason: 'stop',
      reasoningDetails: [{ type: 'reasoning.summary', summary: 'continued thought' }],
      phase: 'final_answer',
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'reasoning',
          item: { id: 'continued-output', encrypted_content: 'opaque' },
        },
      ],
    }
    const source: Message = {
      id: 'FULL',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 3,
      turnId: 'source-turn',
      turnIndex: 2,
      createdAt: 2,
      editedAt: 5,
      role: 'assistant',
      origin: 'generated',
      generation: {
        id: 'generation-1',
        model: 'actual-model',
        requestedModel: 'requested-model',
        apiUsed: 'responses',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
        finishedAt: 2,
        cost: 0.25,
      },
      content: [{ type: 'output_text', text: 'complete answer' }],
      reasoningDetails: [{ type: 'reasoning.summary', summary: 'private thought' }],
      toolCalls: [
        { id: 'tool-1', type: 'function', function: { name: 'lookup', arguments: '{}' } },
      ],
      refusal: 'preserved refusal',
      phase: 'final_answer',
      responsesEchoItem: { type: 'message', id: 'echo-1', status: 'completed' },
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'message',
          outputIndex: 0,
          item: { type: 'message', id: 'output-1', unknown: { nested: true } },
        },
      ],
      continuationAttempts: [continuationAttempt],
      attachmentRefs: [
        attachmentRef('live-1', 'live-attachment'),
        attachmentRef('live-2', 'live-attachment'),
        attachmentRef('tombstoned-same', 'live-attachment', 9),
        attachmentRef('tombstoned-only', 'dead-only', 9),
      ],
      approval: { state: 'approved', approvedAt: 6, approvedBy: 'local-user' },
      nodeVersion: 8,
      pinCache: true,
      hiddenFromContext: true,
      deleted: false,
      originalCharCount: 12,
      originalTokenEstimate: 4,
      originalModelId: 'requested-model',
      originalCalibrationKey: 'calibration-family',
      charCountDelta: 3,
      cachedTokenEstimate: 5,
      cachedMediaTokens: 6,
    }
    await putFullMessage(source)

    const repo = getBrowserRepository()
    const beforeWorkspace = await repo.getWorkspaceMeta()
    const events: BroadcastEvent[] = []
    const unsubscribe = onEvent((event) => events.push(event))
    const now = 1_000
    const result = await forkChatFromMessage({
      chatId: chat.id,
      messageId: source.id,
      title: 'Fidelity Branch 1',
      cursor: {},
      now,
    })
    unsubscribe()

    const fork = await repo.getChat(result.chatId)
    const copied = (await repo.listMessages(result.chatId))[0]
    if (!copied) throw new Error('expected copied message')
    expect(fork).toMatchObject({
      title: 'Fidelity Branch 1',
      titleStatus: 'manual',
      presetId: 'preset-1',
      metaVersion: 0,
      summaryVersion: 1,
      lastUpdatedLeafId: copied.id,
      wordCount: 2,
      totalCostUsd: 0.25,
    })
    const expectedCopy = structuredClone(source)
    expectedCopy.id = copied.id
    expectedCopy.chatId = result.chatId
    expectedCopy.parentId = null
    expectedCopy.siblingIndex = 0
    expectedCopy.turnId = copied.turnId
    expectedCopy.turnIndex = 0
    expectedCopy.createdAt = now - 1
    expectedCopy.editedAt = now
    expectedCopy.nodeVersion = 0
    expect(copied).toEqual(expectedCopy)
    expect(copied.id).not.toBe(source.id)
    expect(copied.turnId).not.toBe(source.turnId)
    expect((await repo.getAttachment('live-attachment'))?.refCount).toBe(4)
    expect((await repo.getAttachment('dead-only'))?.refCount).toBe(0)
    expect(await repo.getChatBranchCache(result.chatId)).toMatchObject({
      branchLeafId: copied.id,
      messageCount: 1,
      wordCount: 2,
    })
    expect(
      (await getDb().childLists.toArray()).filter((row) => row.chatId === result.chatId),
    ).toHaveLength(1)
    expect((await repo.getWorkspaceMeta()).mutationCounter).toBe(
      beforeWorkspace.mutationCounter + 1,
    )
    expect(events).toEqual([
      {
        kind: 'chat-mutated',
        chatId: result.chatId,
        metaVersion: 0,
        summaryVersion: 1,
        affected: [
          { kind: 'chat-meta', chatId: result.chatId },
          { kind: 'message', chatId: result.chatId, messageId: copied.id },
          { kind: 'children', chatId: result.chatId, parentId: null },
        ],
      },
    ])
    await expectAttachmentReferenceInvariants(getDb())
  })

  it('rolls every destination write back when a late write fails', async () => {
    const chat = await seedChat('Rollback')
    await getDb().attachments.put(attachment('rollback-attachment', 0))
    const source: Message = {
      id: 'ROLLBACK-SOURCE',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'rollback-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'rollback source' }],
      attachmentRefs: [attachmentRef('rollback-ref', 'rollback-attachment')],
      nodeVersion: 0,
      deleted: false,
    }
    await putFullMessage(source)
    const repo = getBrowserRepository()
    const beforeWorkspace = await repo.getWorkspaceMeta()
    const beforeCounts = {
      chats: await getDb().chats.count(),
      messages: await getDb().messages.count(),
      bodies: await getDb().messageBodies.count(),
      childLists: await getDb().childLists.count(),
      branchCaches: await getDb().chatBranchCache.count(),
    }

    const failureCases = [
      {
        event: getDb().messageBodies.hook('creating'),
        message: 'body write failed',
      },
      {
        event: getDb().attachments.hook('updating'),
        message: 'refcount write failed',
      },
      {
        event: getDb().settings.hook('updating'),
        message: 'workspace metadata write failed',
      },
    ]
    for (const failureCase of failureCases) {
      const fail = () => {
        throw new Error(failureCase.message)
      }
      failureCase.event.subscribe(fail)
      const events: BroadcastEvent[] = []
      const unsubscribe = onEvent((event) => events.push(event))
      await expect(
        forkChatFromMessage({
          chatId: chat.id,
          messageId: source.id,
          title: 'Must Roll Back',
          cursor: {},
          now: 2_000,
        }),
      ).rejects.toThrow(failureCase.message)
      unsubscribe()
      failureCase.event.unsubscribe(fail)

      expect(await getDb().chats.count()).toBe(beforeCounts.chats)
      expect(await getDb().messages.count()).toBe(beforeCounts.messages)
      expect(await getDb().messageBodies.count()).toBe(beforeCounts.bodies)
      expect(await getDb().childLists.count()).toBe(beforeCounts.childLists)
      expect(await getDb().chatBranchCache.count()).toBe(beforeCounts.branchCaches)
      expect((await repo.getAttachment('rollback-attachment'))?.refCount).toBe(1)
      expect((await repo.getWorkspaceMeta()).mutationCounter).toBe(beforeWorkspace.mutationCounter)
      expect(events).toEqual([])
      await expectAttachmentReferenceInvariants(getDb())
    }
  })
})

describe('InlineEditor helpers', () => {
  it('plaintextOf concatenates text and output_text lanes, skipping other types', () => {
    expect(
      plaintextOf([
        { type: 'text', text: 'hello ' },
        { type: 'image_url', url: 'x' },
        { type: 'output_text', text: 'world' },
      ]),
    ).toBe('hello world')
  })
  it('writeTextInto replaces the first text item', () => {
    const next = writeTextInto(
      [
        { type: 'text', text: 'old' },
        { type: 'image_url', url: 'x' },
      ],
      'new',
    )
    expect(next[0]).toEqual({ type: 'text', text: 'new' })
    expect(next[1]).toEqual({ type: 'image_url', url: 'x' })
  })
  it('writeTextInto appends a text item when none existed', () => {
    const next = writeTextInto([{ type: 'image_url', url: 'x' }], 'new')
    expect(next).toHaveLength(2)
    expect(next.at(-1)).toEqual({ type: 'text', text: 'new' })
  })
})

describe('undo snapshot for structural deletes', () => {
  it('restores tombstoned rows so a delete-pair can be undone', async () => {
    const chat = await seedChat()
    const user = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      createdAt: 1,
    })
    const assistant = await putMessage(chat.id, {
      id: 'A',
      parentId: user.id,
      role: 'assistant',
      createdAt: 2,
    })
    const rowsBefore = await snapshotMessages(chat.id, [user.id, assistant.id])
    await deletePair({
      chatId: chat.id,
      messageId: assistant.id,
      cursor: {},
    })
    const afterDelete = await getDb().messages.where('chatId').equals(chat.id).toArray()
    expect(afterDelete.every((m) => m.deleted)).toBe(true)
    await applyStructuralSnapshot({
      chatId: chat.id,
      previousRows: rowsBefore,
      newMessageIds: [],
      attachmentIds: [],
    })
    const afterUndo = await getDb().messages.where('chatId').equals(chat.id).toArray()
    expect(afterUndo.find((m) => m.id === user.id)?.deleted).toBe(false)
    expect(afterUndo.find((m) => m.id === assistant.id)?.deleted).toBe(false)
  })

  it('tombstones introduced rows without restoring unrelated header edits', async () => {
    const chat = await seedChat()
    await getDb().attachments.bulkPut([attachment('undo-a', 0), attachment('undo-b', 0)])
    const previous: Message = {
      id: 'undo-previous',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'undo-turn-a',
      turnIndex: 0,
      createdAt: 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'previous' }],
      attachmentRefs: [attachmentRef('undo-ref-a', 'undo-a')],
      nodeVersion: 0,
      deleted: false,
    }
    const introduced: Message = {
      ...previous,
      id: 'undo-introduced',
      siblingIndex: 1,
      turnId: 'undo-turn-b',
      content: [{ type: 'text', text: 'introduced' }],
      attachmentRefs: [attachmentRef('undo-ref-b', 'undo-b')],
    }
    await putFullMessage(previous)
    await putFullMessage(introduced)
    await getBrowserRepository().runMutation(
      [
        { kind: 'message', messageId: previous.id },
        { kind: 'attachment', attachmentId: 'undo-a' },
        { kind: 'attachment', attachmentId: 'undo-b' },
      ],
      async (ctx) => {
        await ctx.putMessage({
          ...previous,
          attachmentRefs: [attachmentRef('undo-ref-b-replacement', 'undo-b')],
        })
      },
    )

    await applyStructuralSnapshot({
      chatId: chat.id,
      previousRows: [previous],
      newMessageIds: [introduced.id],
      attachmentIds: ['undo-a', 'undo-b'],
    })

    const undoneIntroduced = await getBrowserRepository().getMessage(introduced.id)
    expect(undoneIntroduced).toMatchObject({
      id: introduced.id,
      turnId: introduced.turnId,
      turnIndex: introduced.turnIndex,
      deleted: true,
    })
    expect(undoneIntroduced?.content).toEqual(introduced.content)
    expect(undoneIntroduced?.attachmentRefs).toEqual(introduced.attachmentRefs)
    expect((await getBrowserRepository().getMessage(previous.id))?.attachmentRefs).toEqual([
      attachmentRef('undo-ref-b-replacement', 'undo-b'),
    ])
    expect((await getDb().attachments.get('undo-a'))?.refCount).toBe(0)
    expect((await getDb().attachments.get('undo-b'))?.refCount).toBe(2)
    await expectAttachmentReferenceInvariants(getDb())
  })
})

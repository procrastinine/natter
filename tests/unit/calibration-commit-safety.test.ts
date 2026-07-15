import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Message } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __messageRequestContextChangedForTests,
  __resetBrowserRepositoryForTests,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { createChat } from '../../src/store/chats'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { WorkspaceReplacementFenceError } from '../../src/store/repository'
import {
  markBrowserWorkspaceReplaced,
  readBrowserWorkspaceMeta,
} from '../../src/store/workspace-meta'

const DB_NAME = 'natter'

async function resetAll(): Promise<void> {
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(resetAll)
afterEach(resetAll)

async function seedMessage(): Promise<Message> {
  const chat = await createChat({ id: 'chat-calibration', settings: cloneDefaultChatSettings() })
  const message: Message = {
    id: 'assistant-calibration',
    chatId: chat.id,
    parentId: null,
    siblingIndex: 0,
    turnId: 'turn-calibration',
    turnIndex: 0,
    createdAt: 1,
    role: 'assistant',
    origin: 'generated',
    content: [{ type: 'output_text', text: 'canonical answer' }],
    nodeVersion: 0,
    deleted: false,
  }
  await getBrowserRepository().runMutation(
    [
      { kind: 'message', messageId: message.id },
      { kind: 'children', chatId: chat.id, parentId: null },
    ],
    (ctx) => ctx.putMessage(message),
  )
  return message
}

describe('calibration metadata commits', () => {
  it('partitions semantic and advisory storage revisions', () => {
    const message: Message = {
      id: 'partition-message',
      chatId: 'partition-chat',
      parentId: null,
      siblingIndex: 0,
      turnId: 'partition-turn',
      turnIndex: 0,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'answer' }],
      nodeVersion: 0,
      deleted: false,
    }
    const { header, body } = splitMessageForStorage(message)
    const semanticHeaders = [
      { ...header, parentId: 'new-parent' },
      { ...header, role: 'tool' as const },
      { ...header, origin: 'imported' as const },
      { ...header, deleted: true },
      { ...header, hiddenFromContext: true },
      { ...header, pinCache: true },
      {
        ...header,
        attachmentRefs: [
          {
            refId: 'partition-ref',
            attachmentId: 'partition-attachment',
            includeInContext: true,
            presentation: {},
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
      { ...header, approval: { state: 'approved' as const, approvedAt: 2 } },
    ]
    for (const nextHeader of semanticHeaders) {
      expect(__messageRequestContextChangedForTests(header, body, nextHeader, body)).toBe(true)
    }

    const advisoryHeader = {
      ...header,
      siblingIndex: 4,
      turnId: 'other-turn',
      turnIndex: 3,
      createdAt: 9,
      editedAt: 10,
      nodeVersion: 11,
      requestContextVersion: 12,
      bodyVersion: 13,
      bodyWordCount: 14,
      textPreview: 'derived',
      originalCharCount: 15,
      originalTokenEstimate: 16,
      originalModelId: 'model',
      originalCalibrationKey: 'family:model',
      charCountDelta: 17,
      cachedTokenEstimate: 18,
      cachedMediaTokens: 19,
    }
    expect(__messageRequestContextChangedForTests(header, body, advisoryHeader, body)).toBe(false)
    expect(
      __messageRequestContextChangedForTests(header, body, header, {
        ...body,
        content: [{ type: 'output_text', text: 'changed' }],
        phase: 'final_answer',
      }),
    ).toBe(true)
    expect(
      __messageRequestContextChangedForTests(header, body, header, {
        ...body,
        bodyVersion: body.bodyVersion + 1,
        updatedAt: body.updatedAt + 1,
        continuationAttempts: [
          {
            streamId: 'partition-continuation',
            strategy: 'prompt',
            status: 'done',
            startedAt: 1,
            finishedAt: 2,
          },
        ],
        generationServerToolOutputs: [{ index: 0, output: { value: 'advisory' } }],
      }),
    ).toBe(false)
  })

  it('updates only the header and leaves the canonical body row/version untouched', async () => {
    const message = await seedMessage()
    const beforeHeader = await getDb().messages.get(message.id)
    const beforeBody = await getDb().messageBodies.get(message.id)

    const result = await getBrowserRepository().runMutation(
      [{ kind: 'message', messageId: message.id }],
      (ctx) =>
        ctx.patchMessageCalibration(message.id, {
          originalCharCount: 16,
          originalTokenEstimate: 4,
          originalModelId: 'openai/gpt-4o',
          originalCalibrationKey: 'family:gpt',
          charCountDelta: 0,
          cachedTokenEstimate: 4,
        }),
    )

    expect(result.value).toMatchObject({
      nodeVersion: (beforeHeader?.nodeVersion ?? 0) + 1,
      bodyVersion: beforeHeader?.bodyVersion,
      requestContextVersion: beforeHeader?.requestContextVersion,
      originalCharCount: 16,
    })
    expect(await getDb().messageBodies.get(message.id)).toEqual(beforeBody)
  })

  it('atomically rejects an old workspace epoch even when ids and versions still match', async () => {
    const message = await seedMessage()
    const db = getDb()
    const before = await readBrowserWorkspaceMeta(db)
    await db.transaction('rw', db.settings, async (tx) => {
      await markBrowserWorkspaceReplaced(tx, 10, before)
    })

    await expect(
      getBrowserRepository().runMutation(
        [{ kind: 'message', messageId: message.id }],
        (ctx) => ctx.patchMessageCalibration(message.id, { originalCharCount: 99 }),
        { workspaceFence: { replacementEpoch: before.replacementEpoch } },
      ),
    ).rejects.toBeInstanceOf(WorkspaceReplacementFenceError)
    expect(await getDb().messages.get(message.id)).not.toHaveProperty('originalCharCount')
  })

  it('keeps a header-only semantic put on the existing cold body version', async () => {
    const message = await seedMessage()
    const repo = getBrowserRepository()
    const current = await repo.getMessage(message.id)
    const beforeHeader = await getDb().messages.get(message.id)
    const beforeBody = await getDb().messageBodies.get(message.id)
    if (!current || !beforeHeader || !beforeBody) throw new Error('seed rows missing')

    await repo.runMutation([{ kind: 'message', messageId: message.id }], (ctx) =>
      ctx.putMessage({ ...current, hiddenFromContext: true }),
    )

    const afterHeader = await getDb().messages.get(message.id)
    expect(afterHeader).toMatchObject({
      nodeVersion: beforeHeader.nodeVersion + 1,
      bodyVersion: beforeHeader.bodyVersion,
      requestContextVersion: beforeHeader.requestContextVersion + 1,
      hiddenFromContext: true,
    })
    expect(await getDb().messageBodies.get(message.id)).toEqual(beforeBody)

    if (!afterHeader) throw new Error('header-only put missing')
    await repo.runMutation([{ kind: 'message', messageId: message.id }], (ctx) =>
      ctx.patchMessageBody(message.id, {}, { headerPatch: { cachedMediaTokens: 12 } }),
    )
    expect(await getDb().messages.get(message.id)).toMatchObject({
      nodeVersion: afterHeader.nodeVersion + 1,
      bodyVersion: afterHeader.bodyVersion,
      requestContextVersion: afterHeader.requestContextVersion,
      cachedMediaTokens: 12,
    })
    expect(await getDb().messageBodies.get(message.id)).toEqual(beforeBody)
  })

  it('advances physical and semantic versions independently for body puts', async () => {
    const message = await seedMessage()
    const repo = getBrowserRepository()
    const first = await repo.getMessage(message.id)
    const before = await getDb().messages.get(message.id)
    if (!first || !before) throw new Error('seed rows missing')

    await repo.runMutation([{ kind: 'message', messageId: message.id }], (ctx) =>
      ctx.putMessage({
        ...first,
        continuationAttempts: [
          {
            streamId: 'completed-continuation',
            strategy: 'prompt',
            status: 'done',
            startedAt: 1,
            finishedAt: 2,
          },
        ],
      }),
    )
    const attemptsOnly = await getDb().messages.get(message.id)
    expect(attemptsOnly).toMatchObject({
      nodeVersion: before.nodeVersion + 1,
      bodyVersion: before.bodyVersion + 1,
      requestContextVersion: before.requestContextVersion,
    })

    const second = await repo.getMessage(message.id)
    if (!second || !attemptsOnly) throw new Error('intermediate message missing')
    await repo.runMutation([{ kind: 'message', messageId: message.id }], (ctx) =>
      ctx.putMessage({
        ...second,
        content: [{ type: 'output_text', text: 'changed canonical answer' }],
      }),
    )
    expect(await getDb().messages.get(message.id)).toMatchObject({
      nodeVersion: attemptsOnly.nodeVersion + 1,
      bodyVersion: attemptsOnly.bodyVersion + 1,
      requestContextVersion: attemptsOnly.requestContextVersion + 1,
    })
  })
})

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cursorKeyOf } from '../../src/core/active-path'
import {
  attachmentContextIds,
  attachmentContextPolicyForSettings,
} from '../../src/core/attachments/context'
import { applyContextCutoff } from '../../src/core/context-cutoff'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { applyOutboundContextRewrites } from '../../src/core/prompt-context'
import { tokenizerFromSettings } from '../../src/core/prompt-size'
import type {
  Attachment,
  AttachmentId,
  ChatSettings,
  MediaContextStrategy,
  Message,
  MessageAttachmentRef,
} from '../../src/core/types'
import { editInPlace } from '../../src/hooks/useMessageOps'
import {
  createChat,
  listChatSidebarRows,
  loadActiveBranchSnapshot,
  loadActiveBranchWindowSnapshot,
} from '../../src/store/chats'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { hydrateMessages, splitMessageForStorage } from '../../src/store/message-storage'
import {
  loadActiveBranchHeaderSnapshot,
  loadSendContextForBranch,
} from '../../src/store/send-context'

const DB_NAME = 'natter'

async function resetAll(): Promise<void> {
  __resetBroadcastForTests()
  __resetDbForTests()
  vi.restoreAllMocks()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

function message(chatId: string, id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: id,
    turnIndex: 0,
    createdAt: 1,
    role: 'user',
    origin: 'user',
    content: [{ type: 'text', text: `body:${id}` }],
    nodeVersion: 0,
    deleted: false,
    ...overrides,
  }
}

async function putFullMessages(rows: readonly Message[]): Promise<void> {
  const split = rows.map((row) => splitMessageForStorage(row))
  const db = getDb()
  await db.messages.bulkPut(split.map((row) => row.header))
  await db.messageBodies.bulkPut(split.map((row) => row.body))
}

async function putHeaderOnly(row: Message): Promise<void> {
  await getDb().messages.put(splitMessageForStorage(row).header)
}

function attachmentRef(attachmentId: AttachmentId, createdAt = 1): MessageAttachmentRef {
  return {
    refId: `ref-${attachmentId}-${createdAt}`,
    attachmentId,
    includeInContext: true,
    presentation: {},
    createdAt,
    updatedAt: createdAt,
  }
}

function storedAttachment(
  partial: Partial<Attachment> & Pick<Attachment, 'id' | 'kind' | 'mime' | 'filename'>,
): Attachment {
  return {
    origin: 'system-fixture',
    createdAt: 1,
    updatedAt: 1,
    storage: { kind: 'local-blob', blobId: `${partial.id}:blob` },
    artifacts: [],
    processing: [],
    refCount: 1,
    ...partial,
  }
}

async function hydrateBranchMessages(
  branchHeaders: readonly ReturnType<typeof splitMessageForStorage>['header'][],
): Promise<Message[]> {
  const ids = branchHeaders.map((header) => header.id)
  const db = getDb()
  const [headers, bodies] = await Promise.all([
    db.messages.bulkGet(ids),
    db.messageBodies.bulkGet(ids),
  ])
  return hydrateMessages(
    headers.map((header, index) => {
      if (!header) throw new Error(`MessageHeaderMissing:${ids[index]}`)
      return header
    }),
    bodies.map((body, index) => {
      if (!body) throw new Error(`MessageBodyMissing:${ids[index]}`)
      return body
    }),
  )
}

async function cutoffIdsAfterPlanning(input: {
  messages: readonly Message[]
  settings: ChatSettings
  providerCap?: number | null
  preCutAttachmentIds?: readonly AttachmentId[]
}): Promise<Message['id'][]> {
  const rewritten = applyOutboundContextRewrites(input.messages, input.settings)
  const attachmentIds = new Set<AttachmentId>(
    attachmentContextIds({
      messages: rewritten,
      policy: attachmentContextPolicyForSettings(input.settings),
    }),
  )
  for (const id of input.preCutAttachmentIds ?? []) attachmentIds.add(id)
  const rows = await getDb().attachments.bulkGet([...attachmentIds])
  const byId = new Map<AttachmentId, Attachment>()
  for (const row of rows) {
    if (row) byId.set(row.id, row)
  }
  return applyContextCutoff({
    messages: rewritten,
    settings: input.settings,
    tokenizer: tokenizerFromSettings(input.settings, null),
    providerCap: input.providerCap ?? null,
    currentModelId: input.settings.model,
    attachmentResolver: (id) => byId.get(id),
    ...(attachmentIds.size > 0 ? { disableTextCalibration: true } : {}),
  }).map((row) => row.id)
}

describe('loading poison boundaries', () => {
  it('keeps sidebar reads on chat metadata without touching messages or body rows', async () => {
    const chat = await createChat({
      id: 'sidebar-safe',
      title: 'Sidebar safe',
      settings: cloneDefaultChatSettings(),
      now: 10,
    })
    await getDb().chats.put({
      ...chat,
      titleStatus: 'manual',
      previewText: 'short preview',
      folderId: 'folder-1',
      tags: ['tag-a'],
      settings: { ...chat.settings, systemPrompt: 'large-setting-blob'.repeat(10_000) },
      tokenCalibration: {
        poison: {
          totalTextChars: 1,
          totalTextTokens: 1,
          sampleCount: 1,
          updatedAt: 1,
        },
      },
      favoriteModels: ['favorite-poison/'.repeat(5_000)],
      recentModels: ['recent-poison/'.repeat(5_000)],
    })
    await putHeaderOnly(message(chat.id, 'sidebar-message-poison'))

    const db = getDb()
    const messagesWhere = vi.spyOn(db.messages, 'where')
    const messagesToArray = vi.spyOn(db.messages, 'toArray')
    const bodiesGet = vi.spyOn(db.messageBodies, 'get')
    const bodiesBulkGet = vi.spyOn(db.messageBodies, 'bulkGet')
    const bodiesToArray = vi.spyOn(db.messageBodies, 'toArray')

    const rows = await listChatSidebarRows({ limit: 10 })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: chat.id,
        title: 'Sidebar safe',
        previewText: 'short preview',
        folderId: 'folder-1',
        tags: ['tag-a'],
      }),
    )
    expect('settings' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('tokenCalibration' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('favoriteModels' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect('recentModels' in (rows[0] as Record<string, unknown>)).toBe(false)
    expect(messagesWhere).not.toHaveBeenCalled()
    expect(messagesToArray).not.toHaveBeenCalled()
    expect(bodiesGet).not.toHaveBeenCalled()
    expect(bodiesBulkGet).not.toHaveBeenCalled()
    expect(bodiesToArray).not.toHaveBeenCalled()
  })

  it('hydrates only active-branch bodies, not off-branch or other-chat poison rows', async () => {
    const active = await createChat({
      id: 'active-chat',
      title: 'Active',
      settings: cloneDefaultChatSettings(),
    })
    const other = await createChat({
      id: 'other-chat',
      title: 'Other',
      settings: cloneDefaultChatSettings(),
    })
    const root = message(active.id, 'branch-root', { createdAt: 1 })
    const activeLeaf = message(active.id, 'branch-active', {
      parentId: root.id,
      createdAt: 3,
    })
    const offBranch = message(active.id, 'off-branch-poison', {
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 2,
      content: [{ type: 'text', text: 'OFF_BRANCH_BODY_MUST_NOT_LOAD' }],
    })
    const otherMessage = message(other.id, 'other-chat-poison', {
      content: [{ type: 'text', text: 'OTHER_CHAT_BODY_MUST_NOT_LOAD' }],
    })
    await putFullMessages([root, activeLeaf])
    await putHeaderOnly(offBranch)
    await putHeaderOnly(otherMessage)

    const bulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')

    const snapshot = await loadActiveBranchSnapshot(active.id, {})

    expect(snapshot.branch.map((row) => row.id)).toEqual(['branch-root', 'branch-active'])
    expect(bulkGet).toHaveBeenCalledTimes(1)
    expect(bulkGet.mock.calls[0]?.[0]).toEqual(['branch-root', 'branch-active'])
  })

  it('hydrates only the requested active-branch body window', async () => {
    const chat = await createChat({
      id: 'window-chat',
      title: 'Window',
      settings: cloneDefaultChatSettings(),
    })
    const w0 = message(chat.id, 'W0', { createdAt: 0 })
    const w1 = message(chat.id, 'W1', { parentId: 'W0', createdAt: 1 })
    const w2 = message(chat.id, 'W2', { parentId: 'W1', createdAt: 2 })
    const w3 = message(chat.id, 'W3', {
      parentId: 'W2',
      createdAt: 3,
      content: [{ type: 'text', text: 'WINDOW_POISON_BODY_MUST_NOT_LOAD' }],
    })
    await putHeaderOnly(w0)
    await putFullMessages([w1, w2])
    await putHeaderOnly(w3)

    const bulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')

    const snapshot = await loadActiveBranchWindowSnapshot(chat.id, {}, { offset: 1, limit: 2 })

    expect(snapshot.branchHeaders.map((row) => row.id)).toEqual(['W0', 'W1', 'W2', 'W3'])
    expect(snapshot.branchWindow.map((row) => row.id)).toEqual(['W1', 'W2'])
    expect(snapshot.branchLength).toBe(4)
    expect(bulkGet).toHaveBeenCalledTimes(1)
    expect(bulkGet.mock.calls[0]?.[0]).toEqual(['W1', 'W2'])
  })

  it('anchors negative active-branch body windows to the newest messages', async () => {
    const chat = await createChat({
      id: 'tail-window-chat',
      title: 'Tail window',
      settings: cloneDefaultChatSettings(),
    })
    const w0 = message(chat.id, 'T0', { createdAt: 0 })
    const w1 = message(chat.id, 'T1', { parentId: 'T0', createdAt: 1 })
    const w2 = message(chat.id, 'T2', { parentId: 'T1', createdAt: 2 })
    const w3 = message(chat.id, 'T3', { parentId: 'T2', createdAt: 3 })
    const w4 = message(chat.id, 'T4', { parentId: 'T3', createdAt: 4 })
    await putHeaderOnly(w0)
    await putHeaderOnly(w1)
    await putHeaderOnly(w2)
    await putFullMessages([w3, w4])

    const bulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')

    const snapshot = await loadActiveBranchWindowSnapshot(chat.id, {}, { offset: -1, limit: 2 })

    expect(snapshot.branchHeaders.map((row) => row.id)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4'])
    expect(snapshot.branchWindow.map((row) => row.id)).toEqual(['T3', 'T4'])
    expect(snapshot.windowOffset).toBe(3)
    expect(snapshot.branchLength).toBe(5)
    expect(bulkGet).toHaveBeenCalledTimes(1)
    expect(bulkGet.mock.calls[0]?.[0]).toEqual(['T3', 'T4'])
  })

  it('switching branches hydrates only the selected window, not stale sibling bodies', async () => {
    const chat = await createChat({
      id: 'branch-switch-window-chat',
      title: 'Branch switch window',
      settings: cloneDefaultChatSettings(),
    })
    const root = message(chat.id, 'root', { createdAt: 0 })
    const branchA1 = message(chat.id, 'A1', {
      parentId: root.id,
      siblingIndex: 0,
      createdAt: 1,
      content: [{ type: 'text', text: 'A_BRANCH_BODY_MUST_NOT_LOAD' }],
    })
    const branchA2 = message(chat.id, 'A2', {
      parentId: branchA1.id,
      siblingIndex: 0,
      createdAt: 2,
      content: [{ type: 'text', text: 'A_BRANCH_TAIL_MUST_NOT_LOAD' }],
    })
    const branchB1 = message(chat.id, 'B1', {
      parentId: root.id,
      siblingIndex: 1,
      createdAt: 3,
    })
    const branchB2 = message(chat.id, 'B2', {
      parentId: branchB1.id,
      siblingIndex: 0,
      createdAt: 4,
    })
    await putHeaderOnly(root)
    await putHeaderOnly(branchA1)
    await putHeaderOnly(branchA2)
    await putFullMessages([branchB1, branchB2])

    const bulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')

    const snapshot = await loadActiveBranchWindowSnapshot(
      chat.id,
      { [cursorKeyOf(root.id)]: branchB1.id },
      { offset: -1, limit: 2 },
    )

    expect(snapshot.branchHeaders.map((row) => row.id)).toEqual(['root', 'B1', 'B2'])
    expect(snapshot.branchWindow.map((row) => row.id)).toEqual(['B1', 'B2'])
    expect(bulkGet).toHaveBeenCalledTimes(1)
    expect(bulkGet.mock.calls[0]?.[0]).toEqual(['B1', 'B2'])
  })

  it('edits one message in place without branch-wide body hydration', async () => {
    const chat = await createChat({
      id: 'edit-efficient-chat',
      title: 'Edit efficient',
      settings: cloneDefaultChatSettings(),
    })
    const root = message(chat.id, 'edit-root', { createdAt: 0 })
    const target = message(chat.id, 'edit-target', {
      parentId: root.id,
      createdAt: 1,
      content: [{ type: 'text', text: 'before edit' }],
    })
    const later = message(chat.id, 'edit-later', {
      parentId: target.id,
      createdAt: 2,
      content: [{ type: 'text', text: 'LATER_BODY_MUST_NOT_LOAD_FOR_EDIT' }],
    })
    await putHeaderOnly(root)
    await putFullMessages([target])
    await putHeaderOnly(later)

    const bodiesBulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')
    const messagesWhere = vi.spyOn(getDb().messages, 'where')

    await editInPlace(chat.id, target, 'after edit')

    const body = await getDb().messageBodies.get(target.id)
    expect(body?.content).toEqual([{ type: 'text', text: 'after edit' }])
    expect(bodiesBulkGet).not.toHaveBeenCalled()
    expect(messagesWhere).not.toHaveBeenCalled()
  })

  it('loads send context from the tail without hydrating cold branch bodies', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o'
    settings.customMaxContext = 80
    settings.maxCompletionTokens = 0
    settings.mediaContextStrategy = 'echo-all'
    settings.contextStrategy = { ...settings.contextStrategy, keepFirstPairs: 0 }
    const chat = await createChat({
      id: 'send-tail-chat',
      title: 'Send tail',
      settings,
    })
    await getDb().attachments.put(
      storedAttachment({
        id: 'att-cold',
        kind: 'image',
        mime: 'image/png',
        filename: 'cold.png',
        dimensions: { width: 32, height: 32 },
      }),
    )

    const rows: Message[] = []
    let parentId: string | null = null
    for (let i = 0; i < 6; i += 1) {
      const user = message(chat.id, `u${i}`, {
        parentId,
        turnId: `turn-${i}`,
        turnIndex: 0,
        createdAt: i * 2,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: `user ${i} ${'x'.repeat(80)}` }],
        ...(i === 0 ? { attachmentRefs: [attachmentRef('att-cold')] } : {}),
      })
      const assistant = message(chat.id, `a${i}`, {
        parentId: user.id,
        turnId: `turn-${i}`,
        turnIndex: 1,
        createdAt: i * 2 + 1,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'text', text: `assistant ${i} ${'y'.repeat(80)}` }],
      })
      rows.push(user, assistant)
      parentId = assistant.id
    }
    for (const row of rows.slice(0, 8)) await putHeaderOnly(row)
    await putFullMessages(rows.slice(8))

    const bulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')
    const branch = await loadActiveBranchHeaderSnapshot(chat.id, {})
    const pending = message(chat.id, 'pending-user', {
      parentId,
      createdAt: 20,
      content: [{ type: 'text', text: 'go' }],
    })

    const snapshot = await loadSendContextForBranch({
      chat,
      branchHeaders: branch.branchHeaders,
      pendingMessages: [pending],
    })

    const requestedBodyIds = bulkGet.mock.calls.flatMap((call) => call[0])
    expect(snapshot.usedFullBranch).toBe(false)
    expect(snapshot.pathMessages.at(-1)?.id).toBe('pending-user')
    expect(requestedBodyIds).not.toContain('u0')
    expect(requestedBodyIds).not.toContain('a0')
    expect(requestedBodyIds).not.toContain('u1')
    expect(requestedBodyIds).not.toContain('a1')
    expect(snapshot.preCutAttachmentIds).toContain('att-cold')
  })

  it.each<MediaContextStrategy>([
    'echo-all',
    'echo-last-N',
    'echo-user-only',
    'drop-all',
  ])('matches previous full-hydration cutoff with %s attachment policy', async (mediaContextStrategy) => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o'
    settings.customMaxContext = 260
    settings.maxCompletionTokens = 0
    settings.mediaContextStrategy = mediaContextStrategy
    settings.mediaEchoN = 1
    settings.contextStrategy = { ...settings.contextStrategy, keepFirstPairs: 1 }
    const chat = await createChat({
      id: `send-media-${mediaContextStrategy}`,
      title: `Send media ${mediaContextStrategy}`,
      settings,
    })
    await getDb().attachments.bulkPut([
      storedAttachment({
        id: 'att-head',
        kind: 'image',
        mime: 'image/png',
        filename: 'head.png',
        dimensions: { width: 32, height: 32 },
      }),
      storedAttachment({
        id: 'att-assistant',
        kind: 'image',
        mime: 'image/png',
        filename: 'assistant.png',
        dimensions: { width: 32, height: 32 },
      }),
      storedAttachment({
        id: 'att-pending',
        kind: 'image',
        mime: 'image/png',
        filename: 'pending.png',
        dimensions: { width: 32, height: 32 },
      }),
    ])

    const rows: Message[] = []
    let parentId: string | null = null
    for (let i = 0; i < 4; i += 1) {
      const user = message(chat.id, `mu${i}`, {
        parentId,
        turnId: `media-turn-${i}`,
        turnIndex: 0,
        createdAt: i * 2,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: `user ${i} ${'u'.repeat(20)}` }],
        ...(i === 0 ? { attachmentRefs: [attachmentRef('att-head', i)] } : {}),
      })
      const assistant = message(chat.id, `ma${i}`, {
        parentId: user.id,
        turnId: `media-turn-${i}`,
        turnIndex: 1,
        createdAt: i * 2 + 1,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: `assistant ${i} ${'a'.repeat(20)}` }],
        ...(i === 2 ? { attachmentRefs: [attachmentRef('att-assistant', i)] } : {}),
      })
      rows.push(user, assistant)
      parentId = assistant.id
    }
    await putFullMessages(rows)

    const branch = await loadActiveBranchHeaderSnapshot(chat.id, {})
    const fullPath = await hydrateBranchMessages(branch.branchHeaders)
    const pending = message(chat.id, 'pending-media-user', {
      parentId,
      createdAt: 99,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'final prompt' }],
      attachmentRefs: [attachmentRef('att-pending', 99)],
    })

    const snapshot = await loadSendContextForBranch({
      chat,
      branchHeaders: branch.branchHeaders,
      pendingMessages: [pending],
    })
    const expected = await cutoffIdsAfterPlanning({
      messages: [...fullPath, pending],
      settings,
    })
    const actual = await cutoffIdsAfterPlanning({
      messages: snapshot.pathMessages,
      settings,
      preCutAttachmentIds: snapshot.preCutAttachmentIds,
    })

    expect(snapshot.usedFullBranch).toBe(false)
    expect(actual).toEqual(expected)
    expect([...snapshot.preCutAttachmentIds].sort()).toEqual(
      attachmentContextIds({
        messages: applyOutboundContextRewrites([...fullPath, pending], settings),
        policy: attachmentContextPolicyForSettings(settings),
      }),
    )
  })

  it('matches previous full-hydration cutoff for inline media body items', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o'
    settings.customMaxContext = 180
    settings.maxCompletionTokens = 0
    settings.contextStrategy = { ...settings.contextStrategy, keepFirstPairs: 0 }
    const chat = await createChat({
      id: 'send-inline-media',
      title: 'Send inline media',
      settings,
    })
    const rows: Message[] = []
    let parentId: string | null = null
    for (let i = 0; i < 4; i += 1) {
      const user = message(chat.id, `iu${i}`, {
        parentId,
        turnId: `inline-turn-${i}`,
        turnIndex: 0,
        createdAt: i * 2,
        role: 'user',
        origin: 'user',
        content:
          i === 3
            ? ([
                { type: 'image_url' },
                { type: 'text', text: 'latest image' },
              ] as Message['content'])
            : [{ type: 'text', text: `older ${i} ${'x'.repeat(30)}` }],
      })
      const assistant = message(chat.id, `ia${i}`, {
        parentId: user.id,
        turnId: `inline-turn-${i}`,
        turnIndex: 1,
        createdAt: i * 2 + 1,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: `reply ${i}` }],
      })
      rows.push(user, assistant)
      parentId = assistant.id
    }
    await putFullMessages(rows)

    const branch = await loadActiveBranchHeaderSnapshot(chat.id, {})
    const fullPath = await hydrateBranchMessages(branch.branchHeaders)
    const snapshot = await loadSendContextForBranch({
      chat,
      branchHeaders: branch.branchHeaders,
    })

    expect(snapshot.usedFullBranch).toBe(false)
    await expect(
      cutoffIdsAfterPlanning({ messages: snapshot.pathMessages, settings }),
    ).resolves.toEqual(await cutoffIdsAfterPlanning({ messages: fullPath, settings }))
  })

  it.each([
    'off',
    'middle_out_plugin',
  ] as const)('falls back to the full branch for non-sliding context mode %s', async (kind) => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o'
    settings.customMaxContext = 10
    settings.maxCompletionTokens = 0
    settings.contextStrategy = { ...settings.contextStrategy, kind, keepFirstPairs: 1 }
    const chat = await createChat({
      id: `send-non-sliding-${kind}`,
      title: `Send non sliding ${kind}`,
      settings,
    })
    const rows = [
      message(chat.id, 'n0', { createdAt: 0 }),
      message(chat.id, 'n1', { parentId: 'n0', createdAt: 1 }),
      message(chat.id, 'n2', { parentId: 'n1', createdAt: 2 }),
    ]
    await putFullMessages(rows)
    const bulkGet = vi.spyOn(getDb().messageBodies, 'bulkGet')
    const branch = await loadActiveBranchHeaderSnapshot(chat.id, {})

    const snapshot = await loadSendContextForBranch({
      chat,
      branchHeaders: branch.branchHeaders,
    })

    expect(snapshot.usedFullBranch).toBe(true)
    expect(snapshot.pathMessages.map((row) => row.id)).toEqual(['n0', 'n1', 'n2'])
    expect(bulkGet.mock.calls.some((call) => call[0].length === 3)).toBe(true)
  })

  it('counts append prompts before send-context cutoff', async () => {
    const settings = cloneDefaultChatSettings()
    settings.model = 'openai/gpt-4o'
    settings.customMaxContext = 12
    settings.maxCompletionTokens = 0
    settings.contextStrategy = { ...settings.contextStrategy, keepFirstPairs: 0 }
    settings.appendPrompt = `\n\n${'x'.repeat(200)}`
    const chat = await createChat({
      id: 'send-append-cutoff-chat',
      title: 'Send append cutoff',
      settings,
    })
    const pending = message(chat.id, 'pending-user', {
      content: [{ type: 'text', text: 'short' }],
    })

    const snapshot = await loadSendContextForBranch({
      chat,
      branchHeaders: [],
      pendingMessages: [pending],
    })

    expect(snapshot.usedFullBranch).toBe(false)
    expect(snapshot.pathMessages).toEqual([])
  })
})

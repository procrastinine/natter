import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { groupByParent, indexById } from '../../src/core/active-path'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  appendAsChild,
  branchExplicit,
  continueAssistant,
  deletePair,
  deleteTurn,
  deleteVariant,
  editMessageContent,
  insertBetween,
  insertSibling,
  pasteImport,
  regenerateAssistant,
  sendUserMessage,
  swipe,
} from '../../src/core/messages'
import { nextSiblingIndex, TreeChangedError } from '../../src/core/tree-ops'
import type { Chat, ChatId, Message, MessageId, MessageRole } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { replaceChatSettings, updateChatSettings } from '../../src/store/chats'

const DB_NAME = 'natter'

async function resetAll() {
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

async function seedChat(overrides: Partial<Chat> = {}): Promise<Chat> {
  const chat: Chat = {
    id: newId(),
    title: 'Test',
    titleStatus: 'untitled',
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
    ...overrides,
  }
  await getDb().chats.put(chat)
  return chat
}

interface SeedMsg {
  id?: MessageId
  parentId?: MessageId | null
  siblingIndex?: number
  turnId?: string
  turnIndex?: number
  role?: MessageRole
  createdAt?: number
  deleted?: boolean
  text?: string
}

async function putMessage(chatId: ChatId, spec: SeedMsg = {}): Promise<Message> {
  const row: Message = {
    id: spec.id ?? newId(),
    chatId,
    parentId: spec.parentId ?? null,
    siblingIndex: spec.siblingIndex ?? 0,
    turnId: spec.turnId ?? newId(),
    turnIndex: spec.turnIndex ?? 0,
    createdAt: spec.createdAt ?? 1,
    role: spec.role ?? 'user',
    origin: 'user',
    content: [{ type: 'text', text: spec.text ?? 'x' }],
    nodeVersion: 0,
    deleted: spec.deleted ?? false,
  }
  await getDb().messages.put(row)
  return row
}

async function loadMessages(chatId: ChatId): Promise<Message[]> {
  return getDb().messages.where('chatId').equals(chatId).toArray()
}

async function getChat(chatId: ChatId): Promise<Chat | undefined> {
  return getDb().chats.get(chatId)
}

// -----------------------------------------------------------------------------

describe('sendUserMessage', () => {
  it('creates a top-level user message and updates lastUpdatedLeafId', async () => {
    const chat = await seedChat()
    const res = await sendUserMessage({
      chatId: chat.id,
      cursor: {},
      content: [{ type: 'text', text: 'hi' }],
      now: 200,
    })
    const stored = await getDb().messages.get(res.messageId)
    expect(stored?.parentId).toBeNull()
    expect(stored?.siblingIndex).toBe(0)
    expect(stored?.turnIndex).toBe(0)
    expect(stored?.role).toBe('user')
    expect(stored?.origin).toBe('user')
    expect(stored?.content).toEqual([{ type: 'text', text: 'hi' }])
    const updated = await getChat(chat.id)
    expect(updated?.lastUpdatedLeafId).toBe(res.messageId)
    expect(updated?.summaryVersion).toBe(1)
  })

  it('appends under the active-path leaf and bumps siblingIndex above existing siblings', async () => {
    const chat = await seedChat()
    const root = await putMessage(chat.id, { id: 'R', text: 'root', createdAt: 1 })
    await putMessage(chat.id, { parentId: 'R', siblingIndex: 0, createdAt: 2 })
    const res = await sendUserMessage({
      chatId: chat.id,
      cursor: {},
      content: [{ type: 'text', text: 'new' }],
      now: 300,
    })
    const row = await getDb().messages.get(res.messageId)
    expect(row?.parentId).not.toBeNull()
    // New leaf sits under the active-path leaf (not the root user message).
    expect(row?.parentId).not.toBe(root.id)
  })
})

describe('updateChatSettings', () => {
  it('removes optional top-level settings when patched to undefined', async () => {
    const settings = cloneDefaultChatSettings()
    settings.verbosity = 'high'
    const chat = await seedChat({ settings })
    const changed = await updateChatSettings(chat.id, { verbosity: undefined })
    expect(changed).toBe(true)
    const updated = await getChat(chat.id)
    expect(updated?.settings.verbosity).toBeUndefined()
    expect('verbosity' in (updated?.settings ?? {})).toBe(false)
  })

  it('replaces the full settings snapshot when loading a preset', async () => {
    const settings = cloneDefaultChatSettings()
    settings.providerPrefs = { sort: 'throughput' }
    settings.verbosity = 'high'
    const chat = await seedChat({ settings })
    const presetSettings = cloneDefaultChatSettings()
    presetSettings.providerPrefs = { sort: 'price' }

    const changed = await replaceChatSettings(chat.id, presetSettings)

    expect(changed).toBe(true)
    const updated = await getChat(chat.id)
    expect(updated?.settings.providerPrefs).toEqual({ sort: 'price' })
    expect(updated?.settings.verbosity).toBeUndefined()
  })
})

describe('regenerateAssistant', () => {
  it('creates a new sibling at max+1, leaves the original, and advances the cursor', async () => {
    const chat = await seedChat()
    const user = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      siblingIndex: 0,
      createdAt: 1,
    })
    const assistant = await putMessage(chat.id, {
      id: 'A',
      role: 'assistant',
      parentId: user.id,
      siblingIndex: 0,
      createdAt: 2,
    })
    const res = await regenerateAssistant({
      chatId: chat.id,
      messageId: assistant.id,
      now: 3,
    })
    const rows = await loadMessages(chat.id)
    const newMsg = rows.find((r) => r.id === res.messageId)
    expect(newMsg).toBeDefined()
    expect(newMsg?.parentId).toBe(user.id)
    expect(newMsg?.siblingIndex).toBe(1)
    expect(newMsg?.role).toBe('assistant')
    expect(newMsg?.origin).toBe('generated')
    // Previous variant still live.
    const prev = await getDb().messages.get('A')
    expect(prev?.deleted).toBe(false)
    // Cursor advances to the new variant at user's fork.
    expect(res.effects.cursorUpdates[user.id]).toBe(res.messageId)
  })

  it('stays above tombstoned siblings when assigning siblingIndex', async () => {
    const chat = await seedChat()
    const user = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      siblingIndex: 0,
      createdAt: 1,
    })
    await putMessage(chat.id, {
      id: 'A1',
      role: 'assistant',
      parentId: user.id,
      siblingIndex: 0,
      createdAt: 2,
    })
    // Tombstoned sibling at siblingIndex 5 — new sibling must be > 5.
    await putMessage(chat.id, {
      id: 'AT',
      role: 'assistant',
      parentId: user.id,
      siblingIndex: 5,
      createdAt: 3,
      deleted: true,
    })
    const res = await regenerateAssistant({
      chatId: chat.id,
      messageId: 'A1',
      now: 4,
    })
    const newMsg = await getDb().messages.get(res.messageId)
    expect(newMsg?.siblingIndex).toBe(6)
  })

  it('fails with TreeChangedError when the target has been deleted', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, {
      id: 'A',
      role: 'assistant',
      parentId: null,
      deleted: true,
    })
    await expect(regenerateAssistant({ chatId: chat.id, messageId: 'A' })).rejects.toBeInstanceOf(
      TreeChangedError,
    )
  })
})

describe('editMessageContent', () => {
  it('mutates content and sets editedAt, preserving every immutable field', async () => {
    const chat = await seedChat()
    const row: Message = {
      id: 'M',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'T',
      turnIndex: 0,
      createdAt: 123,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'text', text: 'original' }],
      nodeVersion: 0,
      generation: {
        id: 'gen-1',
        model: 'openai/gpt-5',
        requestedModel: 'openai/gpt-5',
        apiUsed: 'chat',
        delivery: 'streaming',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
        cost: 0.001,
        costSource: 'stream',
        startedAt: 100,
        finishedAt: 110,
      },
      reasoningDetails: [{ type: 'reasoning.text', text: 'original thought' }],
      deleted: false,
    }
    await getDb().messages.put(row)
    await editMessageContent({
      chatId: chat.id,
      messageId: 'M',
      content: [{ type: 'text', text: 'edited' }],
      now: 500,
    })
    const stored = await getDb().messages.get('M')
    expect(stored?.content).toEqual([{ type: 'text', text: 'edited' }])
    expect(stored?.editedAt).toBe(500)
    // Immutable fields unchanged.
    expect(stored?.createdAt).toBe(123)
    expect(stored?.turnId).toBe('T')
    expect(stored?.turnIndex).toBe(0)
    expect(stored?.role).toBe('assistant')
    expect(stored?.origin).toBe('generated')
    expect(stored?.generation?.id).toBe('gen-1')
    expect(stored?.generation?.usage?.prompt_tokens).toBe(10)
    expect(stored?.generation?.model).toBe('openai/gpt-5')
    expect(stored?.reasoningDetails).toEqual([{ type: 'reasoning.text', text: 'original thought' }])
  })

  it('preserves an explicit empty ref list when edited content still points at attachments', async () => {
    const chat = await seedChat()
    const row: Message = {
      id: 'M',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'T',
      turnIndex: 0,
      createdAt: 123,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_image', attachmentId: 'att-generated' }],
      attachmentRefs: [
        {
          refId: 'ref-generated',
          attachmentId: 'att-generated',
          includeInContext: true,
          presentation: {},
          createdAt: 123,
          updatedAt: 123,
        },
      ],
      nodeVersion: 0,
      deleted: false,
    }
    await getDb().messages.put(row)
    await editMessageContent({
      chatId: chat.id,
      messageId: 'M',
      content: [{ type: 'output_image', attachmentId: 'att-generated' }],
      attachmentRefs: [],
      now: 500,
    })
    const stored = await getDb().messages.get('M')
    expect(stored?.attachmentRefs).toEqual([])
  })

  it('editing a historical user message leaves descendants unchanged', async () => {
    const chat = await seedChat()
    const user = await putMessage(chat.id, {
      id: 'U1',
      role: 'user',
      parentId: null,
      createdAt: 1,
    })
    const assistant = await putMessage(chat.id, {
      id: 'A1',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
    })
    const user2 = await putMessage(chat.id, {
      id: 'U2',
      role: 'user',
      parentId: assistant.id,
      createdAt: 3,
    })
    await editMessageContent({
      chatId: chat.id,
      messageId: 'U1',
      content: [{ type: 'text', text: 'edited' }],
      now: 500,
    })
    const assistantAfter = await getDb().messages.get(assistant.id)
    const user2After = await getDb().messages.get(user2.id)
    expect(assistantAfter?.parentId).toBe(user.id)
    expect(assistantAfter?.content).toEqual([{ type: 'text', text: 'x' }])
    expect(user2After?.parentId).toBe(assistant.id)
  })

  it('bumps lastBranchUpdatedAt when the message is on the last-updated branch', async () => {
    const chat = await seedChat()
    const user = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      createdAt: 1,
    })
    const assistant = await putMessage(chat.id, {
      id: 'A',
      role: 'assistant',
      parentId: user.id,
      createdAt: 2,
    })
    await getDb().chats.put({
      ...((await getChat(chat.id)) as Chat),
      lastUpdatedLeafId: assistant.id,
      lastBranchUpdatedAt: 50,
    })
    await editMessageContent({
      chatId: chat.id,
      messageId: user.id,
      content: [{ type: 'text', text: 'edited' }],
      now: 999,
    })
    const chatAfter = await getChat(chat.id)
    expect(chatAfter?.lastBranchUpdatedAt).toBeGreaterThan(50)
  })

  it('does not touch lastBranchUpdatedAt for an off-branch edit', async () => {
    const chat = await seedChat()
    const user = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      createdAt: 1,
    })
    const a1 = await putMessage(chat.id, {
      id: 'A1',
      role: 'assistant',
      parentId: user.id,
      siblingIndex: 0,
      createdAt: 2,
    })
    const a2 = await putMessage(chat.id, {
      id: 'A2',
      role: 'assistant',
      parentId: user.id,
      siblingIndex: 1,
      createdAt: 3,
    })
    await getDb().chats.put({
      ...((await getChat(chat.id)) as Chat),
      lastUpdatedLeafId: a2.id,
      lastBranchUpdatedAt: 50,
    })
    // Edit the OFF-branch variant.
    await editMessageContent({
      chatId: chat.id,
      messageId: a1.id,
      content: [{ type: 'text', text: 'edited' }],
      now: 999,
    })
    const chatAfter = await getChat(chat.id)
    expect(chatAfter?.lastBranchUpdatedAt).toBe(50)
  })
})

describe('continueAssistant', () => {
  it('creates an assistant child with origin=continued and advances cursor', async () => {
    const chat = await seedChat()
    const assistant = await putMessage(chat.id, {
      id: 'A',
      role: 'assistant',
      parentId: null,
      createdAt: 1,
    })
    const res = await continueAssistant({
      chatId: chat.id,
      messageId: assistant.id,
      now: 2,
    })
    const row = await getDb().messages.get(res.messageId)
    expect(row?.parentId).toBe(assistant.id)
    expect(row?.role).toBe('assistant')
    expect(row?.origin).toBe('continued')
    expect(res.effects.cursorUpdates[assistant.id]).toBe(res.messageId)
  })
})

describe('branchExplicit', () => {
  it('clones allowed fields and clears generation-only fields', async () => {
    const chat = await seedChat()
    const source: Message = {
      id: 'A',
      chatId: chat.id,
      parentId: null,
      siblingIndex: 0,
      turnId: 'T',
      turnIndex: 0,
      createdAt: 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'text', text: 'cloned' }],
      nodeVersion: 0,
      generation: {
        id: 'gen-1',
        model: 'x',
        requestedModel: 'x',
        apiUsed: 'chat',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: 1,
      },
      reasoningDetails: [{ type: 'reasoning.text', text: 't' }],
      toolCalls: [{ id: 't1', type: 'function', function: { name: 'n', arguments: '{}' } }],
      refusal: 'no',
      phase: 'final_answer',
      attachmentRefs: [],
      hiddenFromContext: true,
      deleted: false,
    }
    await getDb().messages.put(source)
    const res = await branchExplicit({ chatId: chat.id, messageId: 'A', now: 100 })
    const clone = await getDb().messages.get(res.messageId)
    expect(clone).toBeDefined()
    expect(clone?.role).toBe('assistant')
    expect(clone?.content).toEqual([{ type: 'text', text: 'cloned' }])
    expect(clone?.hiddenFromContext).toBe(true)
    expect(clone?.origin).toBe('imported')
    // Generation-only fields cleared.
    expect(clone?.generation).toBeUndefined()
    expect(clone?.reasoningDetails).toBeUndefined()
    expect(clone?.toolCalls).toBeUndefined()
    expect(clone?.refusal).toBeUndefined()
    expect(clone?.phase).toBeUndefined()
    expect(clone?.editedAt).toBeUndefined()
  })
})

describe('insertSibling', () => {
  it('clones the target role and places the new node at max+1', async () => {
    const chat = await seedChat()
    const user = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      siblingIndex: 0,
      createdAt: 1,
    })
    await putMessage(chat.id, {
      id: 'U2',
      role: 'user',
      parentId: null,
      siblingIndex: 3,
      createdAt: 2,
      deleted: true,
    })
    const res = await insertSibling({
      chatId: chat.id,
      targetId: user.id,
      content: [{ type: 'text', text: 'alt' }],
      now: 3,
    })
    const newMsg = await getDb().messages.get(res.messageId)
    expect(newMsg?.role).toBe('user') // inherited from target
    expect(newMsg?.siblingIndex).toBe(4) // above tombstoned max (3) + 1
    expect(newMsg?.parentId).toBeNull()
    expect(res.effects.cursorUpdates.__root__).toBe(res.messageId)
  })
})

describe('insertBetween', () => {
  it('reparents child under the new intermediate node and writes both cursor entries', async () => {
    const chat = await seedChat()
    const p = await putMessage(chat.id, {
      id: 'P',
      role: 'user',
      parentId: null,
      siblingIndex: 0,
      createdAt: 1,
    })
    const c = await putMessage(chat.id, {
      id: 'C',
      role: 'assistant',
      parentId: p.id,
      siblingIndex: 0,
      createdAt: 2,
    })
    const res = await insertBetween({
      chatId: chat.id,
      parentId: p.id,
      childId: c.id,
      content: [{ type: 'text', text: 'between' }],
      role: 'assistant',
      now: 3,
    })
    const x = await getDb().messages.get(res.messageId)
    const cAfter = await getDb().messages.get(c.id)
    expect(x?.parentId).toBe(p.id)
    expect(cAfter?.parentId).toBe(res.messageId)
    expect(cAfter?.siblingIndex).toBe(0)
    expect(res.effects.cursorUpdates[p.id]).toBe(res.messageId)
    expect(res.effects.cursorUpdates[res.messageId]).toBe(c.id)
  })

  it('assigns X siblingIndex above any pre-existing variants at the same slot', async () => {
    const chat = await seedChat()
    const p = await putMessage(chat.id, {
      id: 'P',
      role: 'user',
      parentId: null,
      createdAt: 1,
    })
    // Two variants at the slot: the active child C and another turn V that
    // should survive alongside X.
    const c = await putMessage(chat.id, {
      id: 'C',
      role: 'assistant',
      parentId: p.id,
      siblingIndex: 0,
      createdAt: 2,
      turnId: 'T1',
    })
    await putMessage(chat.id, {
      id: 'V',
      role: 'assistant',
      parentId: p.id,
      siblingIndex: 1,
      createdAt: 3,
      turnId: 'T2', // different turn → NOT a peer of C
    })
    const res = await insertBetween({
      chatId: chat.id,
      parentId: p.id,
      childId: c.id,
      content: [{ type: 'text', text: 'X' }],
      role: 'assistant',
      now: 5,
    })
    const x = await getDb().messages.get(res.messageId)
    expect(x?.siblingIndex).toBe(2) // above V (siblingIndex 1)
    const vAfter = await getDb().messages.get('V')
    expect(vAfter?.parentId).toBe(p.id) // V NOT reparented
  })

  it('fails with TreeChangedError when the child no longer sits under the requested parent', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'P', parentId: null, createdAt: 1 })
    await putMessage(chat.id, { id: 'C', parentId: null, createdAt: 2 })
    await expect(
      insertBetween({
        chatId: chat.id,
        parentId: 'P',
        childId: 'C',
        content: [{ type: 'text', text: 'x' }],
        role: 'user',
      }),
    ).rejects.toBeInstanceOf(TreeChangedError)
  })
})

describe('appendAsChild', () => {
  it('creates a child with siblingIndex 0 when the parent has none and advances cursor', async () => {
    const chat = await seedChat()
    const p = await putMessage(chat.id, { id: 'P', parentId: null, createdAt: 1 })
    const res = await appendAsChild({
      chatId: chat.id,
      parentMessageId: p.id,
      content: [{ type: 'text', text: 'child' }],
      role: 'assistant',
      now: 2,
    })
    const newMsg = await getDb().messages.get(res.messageId)
    expect(newMsg?.parentId).toBe(p.id)
    expect(newMsg?.siblingIndex).toBe(0)
    expect(res.effects.cursorUpdates[p.id]).toBe(res.messageId)
  })
})

// -----------------------------------------------------------------------------

describe('deletePair (splice-up)', () => {
  // Seeds a canonical three-pair chain:
  //   U1 → A1 → U2 → A2 → U3 → A3
  async function seedThreePairChain(chatId: ChatId): Promise<Message[]> {
    const nodes: Message[] = []
    const specs: Array<[string, MessageRole, string]> = [
      ['U1', 'user', 'u1'],
      ['A1', 'assistant', 'a1'],
      ['U2', 'user', 'u2'],
      ['A2', 'assistant', 'a2'],
      ['U3', 'user', 'u3'],
      ['A3', 'assistant', 'a3'],
    ]
    let parentId: MessageId | null = null
    for (let i = 0; i < specs.length; i++) {
      const [id, role] = specs[i] as [string, MessageRole, string]
      const row = await putMessage(chatId, {
        id,
        role,
        parentId,
        siblingIndex: 0,
        createdAt: i + 1,
        turnId: id,
      })
      nodes.push(row)
      parentId = id
    }
    return nodes
  }

  it('re-parents descendants of the deleted pair to the pair-root parent', async () => {
    const chat = await seedChat()
    await seedThreePairChain(chat.id)
    // Cursor points through the full chain so the active path covers everything.
    const cursor = {
      __root__: 'U1',
      U1: 'A1',
      A1: 'U2',
      U2: 'A2',
      A2: 'U3',
      U3: 'A3',
    }
    // Delete the middle pair (U2 + A2).
    await deletePair({
      chatId: chat.id,
      messageId: 'U2',
      cursor,
      now: 999,
    })
    const rows = await loadMessages(chat.id)
    const u2 = rows.find((r) => r.id === 'U2')
    const a2 = rows.find((r) => r.id === 'A2')
    const u3 = rows.find((r) => r.id === 'U3')
    expect(u2?.deleted).toBe(true)
    expect(a2?.deleted).toBe(true)
    // U3 re-parented to A1 (pair-root parent).
    expect(u3?.parentId).toBe('A1')
  })

  it('splices K up to P when an entire multi-step turn chain is deleted', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'P', parentId: null, createdAt: 1 })
    // One multi-item turn chain: head→mid→tail, all sharing turnId 'T'.
    await putMessage(chat.id, {
      id: 'HEAD',
      parentId: 'P',
      createdAt: 2,
      role: 'assistant',
      turnId: 'T',
      turnIndex: 0,
    })
    await putMessage(chat.id, {
      id: 'MID',
      parentId: 'HEAD',
      createdAt: 3,
      role: 'tool',
      turnId: 'T',
      turnIndex: 1,
    })
    await putMessage(chat.id, {
      id: 'TAIL',
      parentId: 'MID',
      createdAt: 4,
      role: 'assistant',
      turnId: 'T',
      turnIndex: 2,
    })
    await putMessage(chat.id, {
      id: 'K',
      parentId: 'TAIL',
      createdAt: 5,
      role: 'user',
      turnId: 'Tu',
      turnIndex: 0,
    })
    const cursor = {
      __root__: 'P',
      P: 'HEAD',
      HEAD: 'MID',
      MID: 'TAIL',
      TAIL: 'K',
    }
    await deleteVariant({
      chatId: chat.id,
      messageId: 'MID',
      cursor,
      now: 10,
    })
    const k = await getDb().messages.get('K')
    // TAIL is tombstoned; K splices through HEAD+MID+TAIL to P.
    expect(k?.parentId).toBe('P')
    const head = await getDb().messages.get('HEAD')
    const mid = await getDb().messages.get('MID')
    const tail = await getDb().messages.get('TAIL')
    expect(head?.deleted).toBe(true)
    expect(mid?.deleted).toBe(true)
    expect(tail?.deleted).toBe(true)
  })

  it('keeps siblingIndex unique per parent after splice (no collision with tombstoned rows)', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'P', parentId: null, createdAt: 1 })
    // Two existing children of P: one live (`L`), one tombstoned at index 5.
    await putMessage(chat.id, {
      id: 'L',
      parentId: 'P',
      siblingIndex: 0,
      createdAt: 2,
      role: 'assistant',
    })
    await putMessage(chat.id, {
      id: 'T',
      parentId: 'P',
      siblingIndex: 5,
      createdAt: 3,
      role: 'user',
      deleted: true,
    })
    // Sub-tree to re-parent: L → C, where C will splice up to P when L is deleted.
    await putMessage(chat.id, {
      id: 'C',
      parentId: 'L',
      siblingIndex: 0,
      createdAt: 4,
      role: 'user',
    })
    await deleteVariant({
      chatId: chat.id,
      messageId: 'L',
      cursor: { __root__: 'P', P: 'L', L: 'C' },
      now: 10,
    })
    const children = (await loadMessages(chat.id)).filter((m) => m.parentId === 'P')
    const indices = children.map((m) => m.siblingIndex).sort((a, b) => a - b)
    expect(new Set(indices).size).toBe(indices.length)
  })
})

describe('deleteTurn', () => {
  it('tombstones every variant head at the slot and its turn chains', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'P', parentId: null, createdAt: 1 })
    await putMessage(chat.id, {
      id: 'V1',
      parentId: 'P',
      siblingIndex: 0,
      createdAt: 2,
      role: 'assistant',
      turnId: 'V1',
    })
    await putMessage(chat.id, {
      id: 'V2',
      parentId: 'P',
      siblingIndex: 1,
      createdAt: 3,
      role: 'assistant',
      turnId: 'V2',
    })
    await putMessage(chat.id, {
      id: 'K',
      parentId: 'V1',
      siblingIndex: 0,
      createdAt: 4,
      role: 'user',
      turnId: 'K',
    })
    await deleteTurn({
      chatId: chat.id,
      messageId: 'V1',
      cursor: { __root__: 'P', P: 'V1', V1: 'K' },
      now: 10,
    })
    const v1 = await getDb().messages.get('V1')
    const v2 = await getDb().messages.get('V2')
    const k = await getDb().messages.get('K')
    expect(v1?.deleted).toBe(true)
    expect(v2?.deleted).toBe(true)
    // K splices up to P.
    expect(k?.parentId).toBe('P')
  })
})

describe('deleteVariant', () => {
  it('tombstones one variant chain and leaves other sibling variants intact', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'P', parentId: null, createdAt: 1 })
    await putMessage(chat.id, {
      id: 'V1',
      parentId: 'P',
      siblingIndex: 0,
      createdAt: 2,
      role: 'assistant',
      turnId: 'V1',
    })
    await putMessage(chat.id, {
      id: 'V2',
      parentId: 'P',
      siblingIndex: 1,
      createdAt: 3,
      role: 'assistant',
      turnId: 'V2',
    })
    await deleteVariant({
      chatId: chat.id,
      messageId: 'V1',
      cursor: {},
      now: 10,
    })
    expect((await getDb().messages.get('V1'))?.deleted).toBe(true)
    expect((await getDb().messages.get('V2'))?.deleted).toBe(false)
  })
})

describe('cascade delete', () => {
  it('tombstones descendants and skips any splice-up when cascade is true', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'P', parentId: null, createdAt: 1 })
    await putMessage(chat.id, {
      id: 'A',
      parentId: 'P',
      siblingIndex: 0,
      createdAt: 2,
      role: 'assistant',
      turnId: 'A',
    })
    await putMessage(chat.id, {
      id: 'K',
      parentId: 'A',
      siblingIndex: 0,
      createdAt: 3,
      role: 'user',
      turnId: 'K',
    })
    await putMessage(chat.id, {
      id: 'GK',
      parentId: 'K',
      siblingIndex: 0,
      createdAt: 4,
      role: 'assistant',
      turnId: 'GK',
    })
    await deleteVariant({
      chatId: chat.id,
      messageId: 'A',
      cursor: {},
      cascade: true,
      now: 10,
    })
    for (const id of ['A', 'K', 'GK']) {
      expect((await getDb().messages.get(id))?.deleted).toBe(true)
    }
    // K and GK still point at their original parents (no reparent).
    expect((await getDb().messages.get('K'))?.parentId).toBe('A')
    expect((await getDb().messages.get('GK'))?.parentId).toBe('K')
  })
})

// -----------------------------------------------------------------------------

describe('pasteImport', () => {
  it('appends a multi-message chain under the active leaf', async () => {
    const chat = await seedChat()
    const root = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      createdAt: 1,
    })
    const res = await pasteImport({
      chatId: chat.id,
      slot: { kind: 'at-end' },
      cursor: { __root__: root.id },
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'A' }] },
        { role: 'user', content: [{ type: 'text', text: 'B' }] },
      ],
      now: 5,
    })
    expect(res.newMessageIds).toHaveLength(2)
    const [firstId, secondId] = res.newMessageIds as [MessageId, MessageId]
    const first = await getDb().messages.get(firstId)
    const second = await getDb().messages.get(secondId)
    expect(first?.parentId).toBe(root.id)
    expect(first?.origin).toBe('imported')
    expect(second?.parentId).toBe(firstId)
    expect(second?.origin).toBe('imported')
  })

  it('insert-after on a leaf degenerates to append-as-child', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'L', parentId: null, createdAt: 1 })
    const res = await pasteImport({
      chatId: chat.id,
      slot: { kind: 'after', messageId: 'L' },
      cursor: {},
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x' }] }],
      now: 5,
    })
    const first = await getDb().messages.get(res.newMessageIds[0] as MessageId)
    expect(first?.parentId).toBe('L')
  })
})

// -----------------------------------------------------------------------------

describe('swipe', () => {
  it('cycles forward through variants at a fork and wraps at the end', async () => {
    const chat = await seedChat()
    const messages: Message[] = []
    const specs = ['V0', 'V1', 'V2']
    for (let i = 0; i < specs.length; i++) {
      messages.push(
        await putMessage(chat.id, {
          id: specs[i] as string,
          parentId: null,
          siblingIndex: i,
          createdAt: i + 1,
        }),
      )
    }
    let cursor = { __root__: 'V0' }
    const all = await loadMessages(chat.id)

    const a = swipe({ messages: all, targetId: 'V0', direction: 1, cursor })
    expect(a.chosenSiblingId).toBe('V1')
    cursor = { ...cursor, ...a.cursorUpdates }

    const b = swipe({ messages: all, targetId: 'V1', direction: 1, cursor })
    expect(b.chosenSiblingId).toBe('V2')
    cursor = { ...cursor, ...b.cursorUpdates }

    // Wrap around.
    const c = swipe({ messages: all, targetId: 'V2', direction: 1, cursor })
    expect(c.chosenSiblingId).toBe('V0')
  })

  it('writes descendant cursor entries below the new sibling (resolve-below)', async () => {
    const chat = await seedChat()
    await putMessage(chat.id, { id: 'V0', parentId: null, siblingIndex: 0, createdAt: 1 })
    await putMessage(chat.id, { id: 'V1', parentId: null, siblingIndex: 1, createdAt: 2 })
    // V0 has two descendants — one with a later leaf.
    await putMessage(chat.id, { id: 'V0a', parentId: 'V0', siblingIndex: 0, createdAt: 3 })
    await putMessage(chat.id, { id: 'V0b', parentId: 'V0', siblingIndex: 1, createdAt: 5 })
    const all = await loadMessages(chat.id)
    const res = swipe({
      messages: all,
      targetId: 'V1',
      direction: -1,
      cursor: { __root__: 'V1' },
    })
    expect(res.chosenSiblingId).toBe('V0')
    expect(res.cursorUpdates.__root__).toBe('V0')
    expect(res.cursorUpdates.V0).toBe('V0b')
  })
})

// -----------------------------------------------------------------------------

describe('cycle prevention', () => {
  it('no structural op produces a cycle in the persisted tree', async () => {
    const chat = await seedChat()
    const u = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      createdAt: 1,
    })
    const a = await putMessage(chat.id, {
      id: 'A',
      role: 'assistant',
      parentId: u.id,
      createdAt: 2,
    })
    // Run a sequence of ops that all complete without throwing.
    await regenerateAssistant({ chatId: chat.id, messageId: a.id, now: 3 })
    await insertBetween({
      chatId: chat.id,
      parentId: u.id,
      childId: a.id,
      content: [{ type: 'text', text: 'between' }],
      role: 'assistant',
      now: 4,
    })
    await insertSibling({
      chatId: chat.id,
      targetId: u.id,
      content: [{ type: 'text', text: 'alt' }],
      now: 5,
    })
    // Verify tree is acyclic: every message's parent chain reaches null.
    const rows = await loadMessages(chat.id)
    const byId = indexById(rows)
    for (const m of rows) {
      const seen = new Set<MessageId>()
      let cur: MessageId | null = m.id
      while (cur !== null) {
        if (seen.has(cur)) throw new Error(`Cycle at ${m.id}`)
        seen.add(cur)
        cur = byId.get(cur)?.parentId ?? null
      }
    }
  })
})

// -----------------------------------------------------------------------------

describe('concurrency', () => {
  it('serializes two concurrent structural ops without torn writes', async () => {
    const chat = await seedChat()
    const u = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      createdAt: 1,
    })
    const a = await putMessage(chat.id, {
      id: 'A',
      role: 'assistant',
      parentId: u.id,
      siblingIndex: 0,
      createdAt: 2,
    })
    // Kick off two regenerates concurrently.
    const [r1, r2] = await Promise.all([
      regenerateAssistant({ chatId: chat.id, messageId: a.id, now: 10 }),
      regenerateAssistant({ chatId: chat.id, messageId: a.id, now: 11 }),
    ])
    expect(r1.messageId).not.toBe(r2.messageId)
    const rows = (await loadMessages(chat.id)).filter((r) => r.parentId === u.id && !r.deleted)
    const indices = rows.map((r) => r.siblingIndex).sort((x, y) => x - y)
    // Unique siblingIndex values — no overwrite.
    expect(new Set(indices).size).toBe(indices.length)
    // Both new messages exist.
    const ids = new Set(rows.map((r) => r.id))
    expect(ids.has(r1.messageId)).toBe(true)
    expect(ids.has(r2.messageId)).toBe(true)
  })

  it('the later op fails with TreeChangedError when its target has been deleted', async () => {
    const chat = await seedChat()
    const u = await putMessage(chat.id, {
      id: 'U',
      role: 'user',
      parentId: null,
      createdAt: 1,
    })
    const a = await putMessage(chat.id, {
      id: 'A',
      role: 'assistant',
      parentId: u.id,
      createdAt: 2,
    })
    // First: delete the variant. Second: insert a sibling of the deleted node.
    await deleteVariant({
      chatId: chat.id,
      messageId: a.id,
      cursor: {},
      now: 5,
    })
    await expect(
      insertSibling({
        chatId: chat.id,
        targetId: a.id,
        content: [{ type: 'text', text: 'x' }],
        now: 6,
      }),
    ).rejects.toBeInstanceOf(TreeChangedError)
  })
})

// -----------------------------------------------------------------------------

describe('nextSiblingIndex', () => {
  it('stays above the max of live + tombstoned siblings', () => {
    // Pure-function sanity check; the integration tests above exercise it via
    // the op paths.
    const byParent = groupByParent([
      {
        id: 'a',
        chatId: 'C',
        parentId: 'P',
        siblingIndex: 2,
        turnId: 'a',
        turnIndex: 0,
        createdAt: 1,
        role: 'user',
        origin: 'user',
        content: [],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'b',
        chatId: 'C',
        parentId: 'P',
        siblingIndex: 5,
        turnId: 'b',
        turnIndex: 0,
        createdAt: 2,
        role: 'user',
        origin: 'user',
        content: [],
        nodeVersion: 0,
        deleted: true,
      },
    ])
    expect(nextSiblingIndex(byParent, 'P')).toBe(6)
    expect(nextSiblingIndex(byParent, 'nobody')).toBe(0)
  })
})

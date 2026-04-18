// High-level message-tree operations. See `plan/08-branching.md §8.4` for
// the full semantics and `plan/13-delivery.md §13.2.4` for the Phase 4 scope.
//
// Every op in this module wraps `withChatLock`, performs its IDB writes inside
// the chat's Dexie transaction, and returns a structured effect bundle so the
// caller can apply cursor + attachment side-effects after commit. Ops never
// write to Zustand themselves — the cursor is ephemeral per-tab state.

import type { Transaction } from 'dexie'
import type {
  AttachmentId,
  Chat,
  ChatId,
  ContentItem,
  CursorMap,
  Message,
  MessageId,
  MessageOrigin,
  MessageRole,
  TurnId,
} from './types'
import { newId } from '../lib/ulid'
import { withChatLock } from '../store/locks'
import { decRefs, diffAttachmentRefs, incRefs } from '../store/attachments'
import {
  cursorKeyOf,
  findLastUpdatedLeafId,
  groupByParent,
  indexById,
  isOnPathToLeaf,
} from './active-path'
import { cloneForExplicitBranch } from './branching'
import {
  TreeChangedError,
  cascadeSoftDelete,
  collectTurnChain,
  loadChatMessages,
  nextSiblingIndex,
  softDeleteWithSplice,
  turnHeadOf,
} from './tree-ops'

// Effect bundle every structural op returns. Callers apply `cursorUpdates` /
// `cursorRemoveKeys` / `cursorRemoveValueIds` to Zustand AFTER the IDB
// transaction commits (the chat lock already guarantees it did). Tombstones
// and new ids are reported so Zustand-side reducers can update UI lists.
export interface StructuralEffects {
  cursorUpdates: CursorMap
  cursorRemoveKeys: string[]
  cursorRemoveValueIds: MessageId[]
  newMessageIds: MessageId[]
  tombstoned: MessageId[]
  reparented: Array<{
    id: MessageId
    previousParentId: MessageId | null
    newParentId: MessageId | null
  }>
}

function emptyEffects(): StructuralEffects {
  return {
    cursorUpdates: {},
    cursorRemoveKeys: [],
    cursorRemoveValueIds: [],
    newMessageIds: [],
    tombstoned: [],
    reparented: [],
  }
}

// After any mutation that might change the live-leaf set, recompute and patch
// the chat-level pointer. Rule sources: §2.1.2 update rules 2, 3, 5, 6.
interface MaintainInput {
  tx: Transaction
  chat: Chat
  patchChat: (patch: Partial<Chat>) => void
  now: number
  // `true` when the op created or removed at least one live leaf. Edits pass
  // `false` and handle the on-branch-only bump themselves.
  leafSetChanged: boolean
  // Optional pre-computed leaf id. When omitted, the function re-reads and
  // recomputes from the messages table.
  precomputedLeafId?: MessageId | null
}

async function maintainLastUpdatedPointer(input: MaintainInput): Promise<void> {
  const { tx, chat, patchChat, now, leafSetChanged } = input
  if (!leafSetChanged) return
  const leafId =
    input.precomputedLeafId !== undefined
      ? input.precomputedLeafId
      : findLastUpdatedLeafId(await loadChatMessages(tx, chat.id))
  if (leafId !== chat.lastUpdatedLeafId) {
    patchChat({ lastUpdatedLeafId: leafId, lastBranchUpdatedAt: now })
  } else {
    patchChat({ lastBranchUpdatedAt: now })
  }
}

// -----------------------------------------------------------------------------
// 8.4.1 Send new user message
// -----------------------------------------------------------------------------

export interface SendUserMessageInput {
  chatId: ChatId
  cursor: CursorMap
  content: ContentItem[]
  attachmentRefs?: AttachmentId[]
  origin?: MessageOrigin // defaults to 'user'
  role?: MessageRole // defaults to 'user'
  now?: number
}

export async function sendUserMessage(
  input: SendUserMessageInput,
): Promise<{ effects: StructuralEffects; version: number; messageId: MessageId }> {
  const { chatId, cursor, content, attachmentRefs, now = Date.now() } = input
  const role = input.role ?? 'user'
  const origin = input.origin ?? 'user'
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const parentId = resolveActiveLeafId(all, cursor)
    const messageId = newId()
    const turnId = newId()
    const row: Message = {
      id: messageId,
      chatId,
      parentId,
      siblingIndex: nextSiblingIndex(byParent, parentId),
      turnId,
      turnIndex: 0,
      createdAt: now,
      role,
      origin,
      content: structuredClone(content),
      deleted: false,
    }
    if (attachmentRefs && attachmentRefs.length > 0) {
      row.attachmentRefs = [...attachmentRefs]
    }
    await tx.table<Message, MessageId>('messages').put(row)
    if (attachmentRefs && attachmentRefs.length > 0) {
      await incRefs(tx, attachmentRefs)
    }
    effects.newMessageIds.push(messageId)
    effects.cursorUpdates[cursorKeyOf(parentId)] = messageId
    await maintainLastUpdatedPointer({
      tx,
      chat,
      patchChat,
      now,
      leafSetChanged: true,
      precomputedLeafId: messageId,
    })
    return { effects, messageId }
  })
  return {
    effects: result.value.effects,
    version: result.version,
    messageId: result.value.messageId,
  }
}

// -----------------------------------------------------------------------------
// 8.4.2 Regenerate assistant variant
// -----------------------------------------------------------------------------

export interface RegenerateInput {
  chatId: ChatId
  messageId: MessageId
  now?: number
}

export async function regenerateAssistant(
  input: RegenerateInput,
): Promise<{ effects: StructuralEffects; version: number; messageId: MessageId }> {
  const { chatId, messageId, now = Date.now() } = input
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const target = await table.get(messageId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `regenerate target ${messageId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const newMessageId = newId()
    const row: Message = {
      id: newMessageId,
      chatId,
      parentId: target.parentId,
      siblingIndex: nextSiblingIndex(byParent, target.parentId),
      turnId: newId(),
      turnIndex: 0,
      createdAt: now,
      role: target.role,
      origin: 'generated',
      content: [],
      deleted: false,
    }
    await table.put(row)
    effects.newMessageIds.push(newMessageId)
    effects.cursorUpdates[cursorKeyOf(target.parentId)] = newMessageId
    await maintainLastUpdatedPointer({
      tx,
      chat,
      patchChat,
      now,
      leafSetChanged: true,
      precomputedLeafId: newMessageId,
    })
    return { effects, messageId: newMessageId }
  })
  return {
    effects: result.value.effects,
    version: result.version,
    messageId: result.value.messageId,
  }
}

// -----------------------------------------------------------------------------
// 8.4.4 Edit in place
// -----------------------------------------------------------------------------

export interface EditMessageInput {
  chatId: ChatId
  messageId: MessageId
  content: ContentItem[]
  attachmentRefs?: AttachmentId[] // when omitted, attachmentRefs are untouched
  now?: number
}

export async function editMessageContent(
  input: EditMessageInput,
): Promise<{ version: number }> {
  const { chatId, messageId, content, now = Date.now() } = input
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const table = tx.table<Message, MessageId>('messages')
    const target = await table.get(messageId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `edit target ${messageId} unavailable`)
    }
    const next: Message = {
      ...target,
      content: structuredClone(content),
      editedAt: now,
    }
    if (input.attachmentRefs !== undefined) {
      const { toInc, toDec } = diffAttachmentRefs(
        target.attachmentRefs,
        input.attachmentRefs,
      )
      if (input.attachmentRefs.length > 0) next.attachmentRefs = [...input.attachmentRefs]
      else delete next.attachmentRefs
      await incRefs(tx, toInc)
      await decRefs(tx, toDec)
    }
    await table.put(next)
    // Only the branch-pointer's `lastBranchUpdatedAt` is touched on edit, and
    // only when the edited message lies on the last-updated branch. Leaves and
    // tree shape don't change, so `lastUpdatedLeafId` is unaffected (§2.1.2 #3).
    if (chat.lastUpdatedLeafId !== null) {
      const all = await loadChatMessages(tx, chatId)
      const byId = indexById(all)
      if (isOnPathToLeaf(messageId, chat.lastUpdatedLeafId, byId)) {
        patchChat({ lastBranchUpdatedAt: now })
      }
    }
  })
  return { version: result.version }
}

// -----------------------------------------------------------------------------
// 8.4.6 Branch explicitly
// -----------------------------------------------------------------------------

export async function branchExplicit(params: {
  chatId: ChatId
  messageId: MessageId
  now?: number
}): Promise<{ effects: StructuralEffects; version: number; messageId: MessageId }> {
  const { chatId, messageId, now = Date.now() } = params
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const source = await table.get(messageId)
    if (!source || source.chatId !== chatId || source.deleted) {
      throw new TreeChangedError(chatId, `branch source ${messageId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const newMessageId = newId()
    const cloned = cloneForExplicitBranch(source, {
      id: newMessageId,
      turnId: newId(),
      turnIndex: 0,
      parentId: source.parentId,
      siblingIndex: nextSiblingIndex(byParent, source.parentId),
      createdAt: now,
    })
    await table.put(cloned)
    if (cloned.attachmentRefs && cloned.attachmentRefs.length > 0) {
      await incRefs(tx, cloned.attachmentRefs)
    }
    effects.newMessageIds.push(newMessageId)
    effects.cursorUpdates[cursorKeyOf(source.parentId)] = newMessageId
    await maintainLastUpdatedPointer({
      tx,
      chat,
      patchChat,
      now,
      leafSetChanged: true,
      precomputedLeafId: newMessageId,
    })
    return { effects, messageId: newMessageId }
  })
  return {
    effects: result.value.effects,
    version: result.version,
    messageId: result.value.messageId,
  }
}

// -----------------------------------------------------------------------------
// 8.4.8 Continue partial response
// -----------------------------------------------------------------------------

export async function continueAssistant(params: {
  chatId: ChatId
  messageId: MessageId
  now?: number
}): Promise<{ effects: StructuralEffects; version: number; messageId: MessageId }> {
  const { chatId, messageId, now = Date.now() } = params
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const target = await table.get(messageId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `continue target ${messageId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const newMessageId = newId()
    const row: Message = {
      id: newMessageId,
      chatId,
      parentId: target.id,
      siblingIndex: nextSiblingIndex(byParent, target.id),
      turnId: newId(),
      turnIndex: 0,
      createdAt: now,
      role: 'assistant',
      origin: 'continued',
      content: [],
      deleted: false,
    }
    await table.put(row)
    effects.newMessageIds.push(newMessageId)
    effects.cursorUpdates[cursorKeyOf(target.id)] = newMessageId
    await maintainLastUpdatedPointer({
      tx,
      chat,
      patchChat,
      now,
      leafSetChanged: true,
      precomputedLeafId: newMessageId,
    })
    return { effects, messageId: newMessageId }
  })
  return {
    effects: result.value.effects,
    version: result.version,
    messageId: result.value.messageId,
  }
}

// -----------------------------------------------------------------------------
// 8.4.9 Insert primitives
// -----------------------------------------------------------------------------

export interface InsertSiblingInput {
  chatId: ChatId
  targetId: MessageId
  content: ContentItem[]
  role?: MessageRole // defaults to target.role (plan §8.4.9 #1)
  origin?: MessageOrigin
  attachmentRefs?: AttachmentId[]
  now?: number
}

export async function insertSibling(
  input: InsertSiblingInput,
): Promise<{ effects: StructuralEffects; version: number; messageId: MessageId }> {
  const { chatId, targetId, content, now = Date.now() } = input
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const target = await table.get(targetId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `insert-sibling target ${targetId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const newMessageId = newId()
    const row: Message = {
      id: newMessageId,
      chatId,
      parentId: target.parentId,
      siblingIndex: nextSiblingIndex(byParent, target.parentId),
      turnId: newId(),
      turnIndex: 0,
      createdAt: now,
      role: input.role ?? target.role,
      origin: input.origin ?? 'imported',
      content: structuredClone(content),
      deleted: false,
    }
    if (input.attachmentRefs && input.attachmentRefs.length > 0) {
      row.attachmentRefs = [...input.attachmentRefs]
    }
    await table.put(row)
    if (input.attachmentRefs && input.attachmentRefs.length > 0) {
      await incRefs(tx, input.attachmentRefs)
    }
    effects.newMessageIds.push(newMessageId)
    effects.cursorUpdates[cursorKeyOf(target.parentId)] = newMessageId
    await maintainLastUpdatedPointer({
      tx,
      chat,
      patchChat,
      now,
      leafSetChanged: true,
      precomputedLeafId: newMessageId,
    })
    return { effects, messageId: newMessageId }
  })
  return {
    effects: result.value.effects,
    version: result.version,
    messageId: result.value.messageId,
  }
}

export interface InsertBetweenInput {
  chatId: ChatId
  parentId: MessageId | null
  childId: MessageId
  content: ContentItem[]
  role: MessageRole
  origin?: MessageOrigin
  attachmentRefs?: AttachmentId[]
  now?: number
}

// §8.4.9 #2. Re-parents C and any same-turnId peers under the new node X.
// Sibling variants at the same slot (different turnIds) survive alongside X.
export async function insertBetween(
  input: InsertBetweenInput,
): Promise<{ effects: StructuralEffects; version: number; messageId: MessageId }> {
  const { chatId, parentId, childId, content, role, now = Date.now() } = input
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const child = await table.get(childId)
    if (!child || child.chatId !== chatId || child.deleted) {
      throw new TreeChangedError(chatId, `insert-between child ${childId} unavailable`)
    }
    if (child.parentId !== parentId) {
      throw new TreeChangedError(chatId, `insert-between stale parent of ${childId}`)
    }
    if (parentId !== null) {
      const parentRow = await table.get(parentId)
      if (!parentRow || parentRow.chatId !== chatId || parentRow.deleted) {
        throw new TreeChangedError(chatId, `insert-between parent ${parentId} unavailable`)
      }
    }
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const newMessageId = newId()
    const x: Message = {
      id: newMessageId,
      chatId,
      parentId,
      // Gap-preserving above ALL existing children at the slot (§8.4.9 #2 last
      // paragraph): "max(siblingIndex over ALL of that slot's children,
      // including tombstones) + 1. We do NOT renumber existing siblings here."
      siblingIndex: nextSiblingIndex(byParent, parentId),
      turnId: newId(),
      turnIndex: 0,
      createdAt: now,
      role,
      origin: input.origin ?? 'imported',
      content: structuredClone(content),
      deleted: false,
    }
    if (input.attachmentRefs && input.attachmentRefs.length > 0) {
      x.attachmentRefs = [...input.attachmentRefs]
    }
    await table.put(x)
    if (input.attachmentRefs && input.attachmentRefs.length > 0) {
      await incRefs(tx, input.attachmentRefs)
    }

    // Re-parent the child's turn-peers (S_C) under X. In practice |S_C| === 1
    // (regen siblings have different turnIds) but the plan keeps the set-form
    // so the op works if that convention ever loosens.
    const slotSiblings = byParent.get(parentId) ?? []
    const peers = slotSiblings.filter((s) => s.turnId === child.turnId && !s.deleted)
    peers.sort((a, b) => a.createdAt - b.createdAt)
    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i] as Message
      await table.put({ ...peer, parentId: newMessageId, siblingIndex: i })
    }
    effects.reparented = peers.map((peer) => ({
      id: peer.id,
      previousParentId: parentId,
      newParentId: newMessageId,
    }))

    effects.newMessageIds.push(newMessageId)
    effects.cursorUpdates[cursorKeyOf(parentId)] = newMessageId
    // Preserve the previously-active descendant below X.
    effects.cursorUpdates[cursorKeyOf(newMessageId)] = childId
    // §2.1.2 rule 6: insert-between creates no NEW leaf, so the leaf pointer
    // does not move. If X lands on the path to the current leaf, the branch
    // text changes and `lastBranchUpdatedAt` bumps. We cheap-check with
    // on-path membership via the new tree state.
    if (chat.lastUpdatedLeafId !== null) {
      const after = await loadChatMessages(tx, chatId)
      const byId = indexById(after)
      if (isOnPathToLeaf(newMessageId, chat.lastUpdatedLeafId, byId)) {
        patchChat({ lastBranchUpdatedAt: now })
      }
    }
    return { effects, messageId: newMessageId }
  })
  return {
    effects: result.value.effects,
    version: result.version,
    messageId: result.value.messageId,
  }
}

export interface AppendAsChildInput {
  chatId: ChatId
  parentMessageId: MessageId
  content: ContentItem[]
  role: MessageRole
  origin?: MessageOrigin
  attachmentRefs?: AttachmentId[]
  now?: number
}

export async function appendAsChild(
  input: AppendAsChildInput,
): Promise<{ effects: StructuralEffects; version: number; messageId: MessageId }> {
  const { chatId, parentMessageId, content, role, now = Date.now() } = input
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const parent = await table.get(parentMessageId)
    if (!parent || parent.chatId !== chatId || parent.deleted) {
      throw new TreeChangedError(chatId, `append-as-child parent ${parentMessageId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const newMessageId = newId()
    const row: Message = {
      id: newMessageId,
      chatId,
      parentId: parentMessageId,
      siblingIndex: nextSiblingIndex(byParent, parentMessageId),
      turnId: newId(),
      turnIndex: 0,
      createdAt: now,
      role,
      origin: input.origin ?? 'imported',
      content: structuredClone(content),
      deleted: false,
    }
    if (input.attachmentRefs && input.attachmentRefs.length > 0) {
      row.attachmentRefs = [...input.attachmentRefs]
    }
    await table.put(row)
    if (input.attachmentRefs && input.attachmentRefs.length > 0) {
      await incRefs(tx, input.attachmentRefs)
    }
    effects.newMessageIds.push(newMessageId)
    effects.cursorUpdates[cursorKeyOf(parentMessageId)] = newMessageId
    await maintainLastUpdatedPointer({
      tx,
      chat,
      patchChat,
      now,
      leafSetChanged: true,
      precomputedLeafId: newMessageId,
    })
    return { effects, messageId: newMessageId }
  })
  return {
    effects: result.value.effects,
    version: result.version,
    messageId: result.value.messageId,
  }
}

// -----------------------------------------------------------------------------
// 8.4.10 Paste import (compound)
// -----------------------------------------------------------------------------

export type PasteImportSlot =
  | { kind: 'at-end' }
  | { kind: 'before'; messageId: MessageId }
  | { kind: 'after'; messageId: MessageId }
  | { kind: 'sibling'; messageId: MessageId }

export interface PasteImportMessageInput {
  role: MessageRole
  content: ContentItem[]
  attachmentRefs?: AttachmentId[]
}

export interface PasteImportInput {
  chatId: ChatId
  slot: PasteImportSlot
  cursor: CursorMap
  messages: readonly PasteImportMessageInput[]
  now?: number
}

// Runs N primitives in a single chat-lock transaction. Every created message
// has `origin: 'imported'`. See §8.4.9 #4 for the input-to-primitive mapping.
export async function pasteImport(
  input: PasteImportInput,
): Promise<{ effects: StructuralEffects; version: number; newMessageIds: MessageId[] }> {
  const { chatId, slot, cursor, messages, now = Date.now() } = input
  if (messages.length === 0) {
    return {
      effects: emptyEffects(),
      version: 0,
      newMessageIds: [],
    }
  }
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')

    const [first, ...rest] = messages as [PasteImportMessageInput, ...PasteImportMessageInput[]]
    const firstRow = await createFirstImported(tx, chatId, slot, cursor, first, now, effects)

    let tail = firstRow
    for (const m of rest) {
      const all = await loadChatMessages(tx, chatId)
      const byParent = groupByParent(all)
      const id = newId()
      const row: Message = {
        id,
        chatId,
        parentId: tail.id,
        siblingIndex: nextSiblingIndex(byParent, tail.id),
        turnId: newId(),
        turnIndex: 0,
        createdAt: now,
        role: m.role,
        origin: 'imported',
        content: structuredClone(m.content),
        deleted: false,
      }
      if (m.attachmentRefs && m.attachmentRefs.length > 0) {
        row.attachmentRefs = [...m.attachmentRefs]
      }
      await table.put(row)
      if (m.attachmentRefs && m.attachmentRefs.length > 0) {
        await incRefs(tx, m.attachmentRefs)
      }
      effects.newMessageIds.push(id)
      effects.cursorUpdates[cursorKeyOf(tail.id)] = id
      tail = row
    }

    await maintainLastUpdatedPointer({
      tx,
      chat,
      patchChat,
      now,
      leafSetChanged: true,
      precomputedLeafId: tail.id,
    })
    return { effects }
  })
  return {
    effects: result.value.effects,
    version: result.version,
    newMessageIds: result.value.effects.newMessageIds,
  }
}

async function createFirstImported(
  tx: Transaction,
  chatId: ChatId,
  slot: PasteImportSlot,
  cursor: CursorMap,
  spec: PasteImportMessageInput,
  now: number,
  effects: StructuralEffects,
): Promise<Message> {
  const table = tx.table<Message, MessageId>('messages')
  if (slot.kind === 'at-end') {
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const leaf = resolveActiveLeafId(all, cursor)
    const id = newId()
    const row: Message = {
      id,
      chatId,
      parentId: leaf,
      siblingIndex: nextSiblingIndex(byParent, leaf),
      turnId: newId(),
      turnIndex: 0,
      createdAt: now,
      role: spec.role,
      origin: 'imported',
      content: structuredClone(spec.content),
      deleted: false,
    }
    if (spec.attachmentRefs && spec.attachmentRefs.length > 0) {
      row.attachmentRefs = [...spec.attachmentRefs]
    }
    await table.put(row)
    if (spec.attachmentRefs && spec.attachmentRefs.length > 0) {
      await incRefs(tx, spec.attachmentRefs)
    }
    effects.newMessageIds.push(id)
    effects.cursorUpdates[cursorKeyOf(leaf)] = id
    return row
  }
  if (slot.kind === 'sibling') {
    const target = await table.get(slot.messageId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `paste-sibling target ${slot.messageId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byParent = groupByParent(all)
    const id = newId()
    const row: Message = {
      id,
      chatId,
      parentId: target.parentId,
      siblingIndex: nextSiblingIndex(byParent, target.parentId),
      turnId: newId(),
      turnIndex: 0,
      createdAt: now,
      role: spec.role,
      origin: 'imported',
      content: structuredClone(spec.content),
      deleted: false,
    }
    if (spec.attachmentRefs && spec.attachmentRefs.length > 0) {
      row.attachmentRefs = [...spec.attachmentRefs]
    }
    await table.put(row)
    if (spec.attachmentRefs && spec.attachmentRefs.length > 0) {
      await incRefs(tx, spec.attachmentRefs)
    }
    effects.newMessageIds.push(id)
    effects.cursorUpdates[cursorKeyOf(target.parentId)] = id
    return row
  }
  if (slot.kind === 'before') {
    const target = await table.get(slot.messageId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `paste-before target ${slot.messageId} unavailable`)
    }
    return insertBetweenInner(
      tx,
      chatId,
      target.parentId,
      target.id,
      spec,
      now,
      effects,
    )
  }
  // kind === 'after'
  const target = await table.get(slot.messageId)
  if (!target || target.chatId !== chatId || target.deleted) {
    throw new TreeChangedError(chatId, `paste-after target ${slot.messageId} unavailable`)
  }
  // Find the active-path descendant D of `target`; if none, degenerate to
  // append-as-child (§8.4.9 #4 "Insert after on leaf → append-as-child").
  const kidsOfTarget = await table
    .where('[chatId+parentId]')
    .equals([chatId, target.id])
    .toArray()
  const liveKids = kidsOfTarget.filter((k) => !k.deleted)
  const activeDescendantId = cursor[cursorKeyOf(target.id)]
  const activeDescendant =
    activeDescendantId !== undefined
      ? liveKids.find((k) => k.id === activeDescendantId)
      : undefined
  if (activeDescendant) {
    return insertBetweenInner(
      tx,
      chatId,
      target.id,
      activeDescendant.id,
      spec,
      now,
      effects,
    )
  }
  // Degenerate: append as child of target.
  const all = await loadChatMessages(tx, chatId)
  const byParent = groupByParent(all)
  const id = newId()
  const row: Message = {
    id,
    chatId,
    parentId: target.id,
    siblingIndex: nextSiblingIndex(byParent, target.id),
    turnId: newId(),
    turnIndex: 0,
    createdAt: now,
    role: spec.role,
    origin: 'imported',
    content: structuredClone(spec.content),
    deleted: false,
  }
  if (spec.attachmentRefs && spec.attachmentRefs.length > 0) {
    row.attachmentRefs = [...spec.attachmentRefs]
  }
  await table.put(row)
  if (spec.attachmentRefs && spec.attachmentRefs.length > 0) {
    await incRefs(tx, spec.attachmentRefs)
  }
  effects.newMessageIds.push(id)
  effects.cursorUpdates[cursorKeyOf(target.id)] = id
  return row
}

async function insertBetweenInner(
  tx: Transaction,
  chatId: ChatId,
  parentId: MessageId | null,
  childId: MessageId,
  spec: PasteImportMessageInput,
  now: number,
  effects: StructuralEffects,
): Promise<Message> {
  const table = tx.table<Message, MessageId>('messages')
  const child = await table.get(childId)
  if (!child || child.chatId !== chatId || child.deleted) {
    throw new TreeChangedError(chatId, `insert-between child ${childId} unavailable`)
  }
  const all = await loadChatMessages(tx, chatId)
  const byParent = groupByParent(all)
  const id = newId()
  const row: Message = {
    id,
    chatId,
    parentId,
    siblingIndex: nextSiblingIndex(byParent, parentId),
    turnId: newId(),
    turnIndex: 0,
    createdAt: now,
    role: spec.role,
    origin: 'imported',
    content: structuredClone(spec.content),
    deleted: false,
  }
  if (spec.attachmentRefs && spec.attachmentRefs.length > 0) {
    row.attachmentRefs = [...spec.attachmentRefs]
  }
  await table.put(row)
  if (spec.attachmentRefs && spec.attachmentRefs.length > 0) {
    await incRefs(tx, spec.attachmentRefs)
  }
  const slotSiblings = byParent.get(parentId) ?? []
  const peers = slotSiblings
    .filter((s) => s.turnId === child.turnId && !s.deleted)
    .sort((a, b) => a.createdAt - b.createdAt)
  for (let i = 0; i < peers.length; i++) {
    const peer = peers[i] as Message
    await table.put({ ...peer, parentId: id, siblingIndex: i })
    effects.reparented.push({
      id: peer.id,
      previousParentId: parentId,
      newParentId: id,
    })
  }
  effects.newMessageIds.push(id)
  effects.cursorUpdates[cursorKeyOf(parentId)] = id
  effects.cursorUpdates[cursorKeyOf(id)] = childId
  return row
}

// -----------------------------------------------------------------------------
// 8.4.7 Delete pair / variant / turn
// -----------------------------------------------------------------------------

export interface DeleteInput {
  chatId: ChatId
  messageId: MessageId
  cursor: CursorMap
  cascade?: boolean
  now?: number
}

// Walk UPWARD from `start` via parentId, treating tombstones as transparent,
// until we find a live message with the target role. Used to find the user
// ancestor of a pair.
function walkUpUntilRole(
  start: Message,
  role: MessageRole,
  byId: Map<MessageId, Message>,
): Message | null {
  let cur: Message | null = start
  while (cur !== null) {
    if (!cur.deleted && cur.role === role) return cur
    cur = cur.parentId ? (byId.get(cur.parentId) ?? null) : null
  }
  return null
}

// Walk DOWN from `node` along the active-path cursor, collecting all messages
// in following non-user turns until the next user message (or end of path).
function collectPairFollowers(
  userHead: Message,
  byParent: Map<MessageId | null, Message[]>,
  cursor: CursorMap,
): Message[] {
  const result: Message[] = []
  let currentId: MessageId = userHead.id
  while (true) {
    const kids = (byParent.get(currentId) ?? []).filter((k) => !k.deleted)
    if (kids.length === 0) break
    const pinnedId = cursor[cursorKeyOf(currentId)]
    const next =
      (pinnedId !== undefined && kids.find((k) => k.id === pinnedId)) ||
      (kids.find((k) => k.turnIndex === 0 && k.role !== 'user') ?? null)
    // We walk only while the step lands on a non-user turn. Once the next
    // message is a user turn, the pair ends. When no pinned entry exists, pick
    // a non-user child if available; otherwise break.
    if (!next || next.role === 'user') break
    result.push(next)
    // Follow the turn chain (parent→child under same turnId) — all its items
    // belong to the pair.
    let cur: MessageId = next.id
    while (true) {
      const innerKids = (byParent.get(cur) ?? []).filter(
        (k) => !k.deleted && k.turnId === next.turnId,
      )
      if (innerKids.length === 0) break
      // Linear chain — at most one non-deleted child with matching turnId.
      const inner = innerKids[0] as Message
      result.push(inner)
      cur = inner.id
    }
    currentId = cur
  }
  return result
}

export async function deletePair(
  input: DeleteInput,
): Promise<{ effects: StructuralEffects; version: number }> {
  const { chatId, messageId, cursor, cascade = false, now = Date.now() } = input
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const target = await table.get(messageId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `delete-pair target ${messageId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byId = indexById(all)
    const byParent = groupByParent(all)
    // Pair root: nearest user ancestor on the walk up (inclusive of target).
    const userHead = walkUpUntilRole(target, 'user', byId)
    const pairMembers: Message[] = []
    if (userHead) {
      // Include the user's entire turn chain.
      const userChain = collectTurnChain(userHead, byParent)
      pairMembers.push(...userChain)
      // Plus following non-user turns on the active path.
      pairMembers.push(...collectPairFollowers(userHead, byParent, cursor))
    } else {
      // Target is an orphan assistant/tool — pair = its own turn chain only.
      const head = turnHeadOf(target, byId)
      pairMembers.push(...collectTurnChain(head, byParent))
    }
    await applyDelete(tx, chatId, pairMembers, cascade, effects)
    await finalizeDelete({
      tx,
      chat,
      patchChat,
      cursor,
      effects,
      now,
    })
    return { effects }
  })
  return { effects: result.value.effects, version: result.version }
}

export async function deleteTurn(
  input: DeleteInput,
): Promise<{ effects: StructuralEffects; version: number }> {
  const { chatId, messageId, cursor, cascade = false, now = Date.now() } = input
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const target = await table.get(messageId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `delete-turn target ${messageId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byId = indexById(all)
    const byParent = groupByParent(all)
    const head = turnHeadOf(target, byId)
    // Variant heads at the same slot: parent matches, turnIndex === 0.
    const slotSiblings = (byParent.get(head.parentId) ?? []).filter(
      (s) => !s.deleted && s.turnIndex === 0,
    )
    const members: Message[] = []
    for (const variantHead of slotSiblings) {
      members.push(...collectTurnChain(variantHead, byParent))
    }
    await applyDelete(tx, chatId, members, cascade, effects)
    await finalizeDelete({
      tx,
      chat,
      patchChat,
      cursor,
      effects,
      now,
    })
    return { effects }
  })
  return { effects: result.value.effects, version: result.version }
}

export async function deleteVariant(
  input: DeleteInput,
): Promise<{ effects: StructuralEffects; version: number }> {
  const { chatId, messageId, cursor, cascade = false, now = Date.now() } = input
  const result = await withChatLock(chatId, async ({ tx, chat, patchChat }) => {
    const effects = emptyEffects()
    const table = tx.table<Message, MessageId>('messages')
    const target = await table.get(messageId)
    if (!target || target.chatId !== chatId || target.deleted) {
      throw new TreeChangedError(chatId, `delete-variant target ${messageId} unavailable`)
    }
    const all = await loadChatMessages(tx, chatId)
    const byId = indexById(all)
    const byParent = groupByParent(all)
    const head = turnHeadOf(target, byId)
    const members = collectTurnChain(head, byParent)
    await applyDelete(tx, chatId, members, cascade, effects)
    await finalizeDelete({
      tx,
      chat,
      patchChat,
      cursor,
      effects,
      now,
    })
    return { effects }
  })
  return { effects: result.value.effects, version: result.version }
}

async function applyDelete(
  tx: Transaction,
  chatId: ChatId,
  members: readonly Message[],
  cascade: boolean,
  effects: StructuralEffects,
): Promise<void> {
  const ids = members.filter((m) => !m.deleted).map((m) => m.id)
  if (cascade) {
    const tombstoned = await cascadeSoftDelete(tx, chatId, ids)
    effects.tombstoned.push(...tombstoned)
  } else {
    const res = await softDeleteWithSplice(tx, chatId, ids)
    effects.tombstoned.push(...res.tombstoned)
    effects.reparented.push(...res.reparented)
  }
}

interface FinalizeDeleteInput {
  tx: Transaction
  chat: Chat
  patchChat: (patch: Partial<Chat>) => void
  cursor: CursorMap
  effects: StructuralEffects
  now: number
}

async function finalizeDelete(input: FinalizeDeleteInput): Promise<void> {
  const { tx, chat, patchChat, cursor, effects, now } = input
  // Drop cursor entries whose key or value was tombstoned, and any reparented
  // value that no longer belongs under its old key. Callers apply these to the
  // Zustand cursor; the in-tx cursor parameter is read-only for discovery.
  const deletedIds = new Set(effects.tombstoned)
  for (const [key, val] of Object.entries(cursor)) {
    if (deletedIds.has(key)) effects.cursorRemoveKeys.push(key)
    else if (deletedIds.has(val)) effects.cursorRemoveValueIds.push(val)
  }
  // Recompute the chat-level leaf pointer. §2.1.2 rule 5.
  const leafId = findLastUpdatedLeafId(await loadChatMessages(tx, chat.id))
  if (leafId !== chat.lastUpdatedLeafId) {
    patchChat({ lastUpdatedLeafId: leafId, lastBranchUpdatedAt: now })
  } else {
    // Leaf unchanged but a delete may still warrant a `lastBranchUpdatedAt`
    // bump when an on-branch delete happened. Err on the side of bumping.
    patchChat({ lastBranchUpdatedAt: now })
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Derive the leaf of the active path given the current messages and cursor.
// Sends target here to keep the send-path branching-aware. Returns null when
// the chat has no live messages (new-user-message at root).
function resolveActiveLeafId(
  messages: readonly Message[],
  cursor: CursorMap,
): MessageId | null {
  const byParent = groupByParent(messages)
  const byId = indexById(messages)
  let parentId: MessageId | null = null
  while (true) {
    const kids: Message[] = (byParent.get(parentId) ?? []).filter((m) => !m.deleted)
    if (kids.length === 0) break
    const pinnedId: MessageId | undefined = cursor[cursorKeyOf(parentId)]
    const pinned: Message | undefined =
      pinnedId !== undefined ? kids.find((k) => k.id === pinnedId) : undefined
    const chosen: Message = pinned ?? pickByGreatestSubtreeCreatedAt(kids, byParent, byId)
    parentId = chosen.id
  }
  return parentId
}

function pickByGreatestSubtreeCreatedAt(
  kids: readonly Message[],
  byParent: Map<MessageId | null, Message[]>,
  byId: Map<MessageId, Message>,
): Message {
  // Inline of active-path.pickDefaultChild — importing here avoids a cyclic
  // import; this internal helper is only used for send-path leaf resolution.
  let best = kids[0] as Message
  let bestScore = subtreeMaxCreatedAt(best.id, byParent, byId)
  for (let i = 1; i < kids.length; i++) {
    const cand = kids[i] as Message
    const score = subtreeMaxCreatedAt(cand.id, byParent, byId)
    if (
      score > bestScore ||
      (score === bestScore &&
        (cand.siblingIndex > best.siblingIndex ||
          (cand.siblingIndex === best.siblingIndex && cand.id > best.id)))
    ) {
      best = cand
      bestScore = score
    }
  }
  return best
}

function subtreeMaxCreatedAt(
  rootId: MessageId,
  byParent: Map<MessageId | null, Message[]>,
  byId: Map<MessageId, Message>,
): number {
  const start = byId.get(rootId)
  let best = start && !start.deleted ? start.createdAt : -Infinity
  const stack: MessageId[] = [rootId]
  while (stack.length > 0) {
    const id = stack.pop() as MessageId
    const kids = byParent.get(id)
    if (!kids) continue
    for (const k of kids) {
      if (!k.deleted && k.createdAt > best) best = k.createdAt
      stack.push(k.id)
    }
  }
  return best
}

// -----------------------------------------------------------------------------
// Swipe (ephemeral cursor-only op, no IDB writes)
// -----------------------------------------------------------------------------

export interface SwipeInput {
  messages: readonly Message[]
  targetId: MessageId
  direction: -1 | 1
  cursor: CursorMap
}

// Compute the cursor updates that a swipe at `targetId` should produce. The
// update set contains the new cursor entry at the target's fork and any
// entries below the new sibling as written by `resolveLastUpdatedBranchBelow`.
// Pure function; the caller merges `cursorUpdates` into Zustand.
export function swipe(
  input: SwipeInput,
): { cursorUpdates: CursorMap; chosenSiblingId: MessageId } {
  const { messages, targetId, direction, cursor } = input
  const byParent = groupByParent(messages)
  const byId = indexById(messages)
  const target = byId.get(targetId)
  if (!target) throw new Error(`Swipe target not found: ${targetId}`)
  const siblings = (byParent.get(target.parentId) ?? []).filter((m) => !m.deleted)
  if (siblings.length === 0) return { cursorUpdates: {}, chosenSiblingId: targetId }
  siblings.sort((a, b) => a.siblingIndex - b.siblingIndex)
  const idx = siblings.findIndex((s) => s.id === target.id)
  const nextIdx = (idx + direction + siblings.length) % siblings.length
  const chosen = siblings[nextIdx] as Message
  const nextCursor: CursorMap = { ...cursor, [cursorKeyOf(target.parentId)]: chosen.id }
  // Resolve the descendant chain below the new sibling.
  // Import lazily to keep this file small; safe because branch-resolve has no
  // circular dep back to messages.ts.
  const updates: CursorMap = { [cursorKeyOf(target.parentId)]: chosen.id }
  let cur: MessageId | null = chosen.id
  while (cur !== null) {
    const kids: Message[] = (byParent.get(cur) ?? []).filter((k) => !k.deleted)
    if (kids.length === 0) break
    const pinnedId: MessageId | undefined = nextCursor[cursorKeyOf(cur)]
    if (pinnedId !== undefined && kids.some((k) => k.id === pinnedId)) {
      cur = pinnedId
      continue
    }
    const pick: Message = pickByGreatestSubtreeCreatedAt(kids, byParent, byId)
    updates[cursorKeyOf(cur)] = pick.id
    nextCursor[cursorKeyOf(cur)] = pick.id
    cur = pick.id
  }
  return { cursorUpdates: updates, chosenSiblingId: chosen.id }
}

// Re-export for convenience.
export type { TurnId }

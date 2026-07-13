import { newId } from '../lib/ulid'
import { attachmentRefsFromIds, attachmentScopes } from '../store/attachments'
import type {
  MutationContext,
  WorkspaceMutationResult,
  WorkspaceRepository,
} from '../store/repository'
import { getWorkspaceRepository } from '../store/workspace-repository'
import {
  createDefaultChildPicker,
  cursorKeyOf,
  groupByParent,
  indexById,
  resolveActiveLeafId,
} from './active-path'
import { cloneForExplicitBranch } from './branching'
import { readGlobalPreferences } from './global-settings'
import {
  calibrationFieldsForCreate,
  calibrationFieldsForEdit,
  readTokenCalibrationGlobal,
} from './token-calibration'
import {
  cascadeSoftDelete,
  collectTurnChain,
  softDeleteWithSplice,
  TreeChangedError,
  turnHeadOf,
} from './tree-ops'
import type {
  AttachmentId,
  AttachmentRef,
  ChatId,
  ChatVersions,
  ContentItem,
  CursorMap,
  Message,
  MessageId,
  MessageOrigin,
  MessageRole,
  MutationScope,
  TurnId,
} from './types'
import type { StructuralSnapshot } from './undo'

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

export interface DeleteResult {
  effects: StructuralEffects
  versions: ChatVersions
  preImage: StructuralSnapshot
}

const ZERO_VERSIONS: ChatVersions = { metaVersion: 0, summaryVersion: 0 }

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

function versionsFor<T>(result: WorkspaceMutationResult<T>, chatId: ChatId): ChatVersions {
  return result.chatVersions[chatId] ?? ZERO_VERSIONS
}

function messageScope(messageId: MessageId): MutationScope {
  return { kind: 'message', messageId }
}

function childrenScope(chatId: ChatId, parentId: MessageId | null): MutationScope {
  return { kind: 'children', chatId, parentId }
}

function attachmentIdScopes(ids: readonly AttachmentId[] | undefined): MutationScope[] {
  return [...new Set(ids ?? [])].map((attachmentId) => ({ kind: 'attachment', attachmentId }))
}

function dedupeScopes(scopes: readonly MutationScope[]): MutationScope[] {
  const seen = new Set<string>()
  const out: MutationScope[] = []
  for (const scope of scopes) {
    const key =
      scope.kind === 'message'
        ? `message:${scope.messageId}`
        : scope.kind === 'children'
          ? `children:${scope.chatId}:${scope.parentId ?? '__root__'}`
          : scope.kind === 'attachment'
            ? `attachment:${scope.attachmentId}`
            : scope.kind === 'draft'
              ? `draft:${scope.chatId}`
              : `chat-meta:${scope.chatId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(scope)
  }
  return out
}

function isTextOnlyContent(content: readonly ContentItem[]): boolean {
  return content.every((item) => item.type === 'text' || item.type === 'output_text')
}

function contentHasAttachmentIds(content: readonly ContentItem[]): boolean {
  return content.some((item) => 'attachmentId' in item && Boolean(item.attachmentId))
}

function withAttachmentRefs<T extends object>(
  row: T,
  refs: readonly AttachmentRef[] | readonly AttachmentId[] | undefined,
  now?: number,
  existing?: readonly AttachmentRef[],
): T & { attachmentRefs?: AttachmentRef[] } {
  const next = row as T & { attachmentRefs?: AttachmentRef[] }
  if (refs && refs.length > 0) {
    next.attachmentRefs = attachmentInputIsIds(refs)
      ? attachmentRefsFromIds(refs, {
          ...(now !== undefined ? { createdAt: now } : {}),
          ...(existing ? { existing } : {}),
        })
      : refs.map((ref) => ({ ...ref, updatedAt: now ?? ref.updatedAt }))
  }
  return next
}

function attachmentInputIsIds(
  refs: readonly AttachmentRef[] | readonly AttachmentId[],
): refs is readonly AttachmentId[] {
  return typeof refs[0] === 'string'
}

type MessageTreeRow = Pick<
  Message,
  'id' | 'parentId' | 'siblingIndex' | 'turnId' | 'turnIndex' | 'createdAt' | 'role' | 'deleted'
>

function groupTreeRowsByParent(
  messages: readonly MessageTreeRow[],
): Map<MessageId | null, MessageTreeRow[]> {
  const buckets = new Map<MessageId | null, MessageTreeRow[]>()
  for (const message of messages) {
    const bucket = buckets.get(message.parentId)
    if (bucket) bucket.push(message)
    else buckets.set(message.parentId, [message])
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.siblingIndex - b.siblingIndex)
  return buckets
}

function compareExistingSiblingOrder(left: MessageTreeRow, right: MessageTreeRow): number {
  return (
    left.siblingIndex - right.siblingIndex ||
    left.createdAt - right.createdAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}

function liveDirectChildren(
  messages: readonly MessageTreeRow[],
  parentId: MessageId | null,
): MessageTreeRow[] {
  return messages
    .filter((message) => !message.deleted && message.parentId === parentId)
    .sort(compareExistingSiblingOrder)
}

function selectedOrDefaultChild(
  messages: readonly MessageTreeRow[],
  parentId: MessageId | null,
  cursor: CursorMap,
  liveChildren: readonly MessageTreeRow[],
): MessageTreeRow | undefined {
  if (liveChildren.length === 0) return undefined
  const selectedId = cursor[cursorKeyOf(parentId)]
  const selected = liveChildren.find((child) => child.id === selectedId)
  if (selected) return selected
  const byParent = groupTreeRowsByParent(messages)
  const byId = new Map(messages.map((message) => [message.id, message]))
  return createDefaultChildPicker(byParent, byId)(liveChildren)
}

export function nextSiblingIndexFromChildren(
  children: readonly Pick<Message, 'siblingIndex'>[],
): number {
  let max = -1
  for (const child of children) {
    if (child.siblingIndex > max) max = child.siblingIndex
  }
  return max + 1
}

function walkUpUntilRole(
  start: MessageTreeRow,
  role: MessageRole,
  byId: Map<MessageId, MessageTreeRow>,
): MessageTreeRow | null {
  let current: MessageTreeRow | null = start
  while (current !== null) {
    if (!current.deleted && current.role === role) return current
    current = current.parentId ? (byId.get(current.parentId) ?? null) : null
  }
  return null
}

function collectPairFollowers(
  userHead: MessageTreeRow,
  byParent: Map<MessageId | null, MessageTreeRow[]>,
  cursor: CursorMap,
): MessageTreeRow[] {
  const result: MessageTreeRow[] = []
  let currentId: MessageId = userHead.id
  for (;;) {
    const kids = (byParent.get(currentId) ?? []).filter((kid) => !kid.deleted)
    if (kids.length === 0) break
    const pinnedId = cursor[cursorKeyOf(currentId)]
    const pinned = pinnedId !== undefined ? kids.find((kid) => kid.id === pinnedId) : undefined
    // Fallback when there is no cursor entry at this fork (fresh chat
    // open, or user deleted before swiping). Pick the first assistant/
    // tool/system child at turnIndex=0. Mirror the §8.3 default rule:
    // without a cursor a deterministic pick is still required so
    // delete-pair works on freshly-opened chats.
    const fallback = kids.find((kid) => kid.turnIndex === 0 && kid.role !== 'user')
    const next = pinned ?? fallback
    if (!next || next.role === 'user') break
    result.push(next)
    let cursorId: MessageId = next.id
    for (;;) {
      const chainKids = (byParent.get(cursorId) ?? []).filter(
        (kid) => !kid.deleted && kid.turnId === next.turnId,
      )
      if (chainKids.length === 0) break
      const inner = chainKids[0] as MessageTreeRow
      result.push(inner)
      cursorId = inner.id
    }
    currentId = cursorId
  }
  return result
}

function collectInsertBetweenScopes(
  chatId: ChatId,
  messages: readonly MessageTreeRow[],
  parentId: MessageId | null,
  childId: MessageId,
  newMessageId: MessageId,
): MutationScope[] {
  const byId = new Map(messages.map((message) => [message.id, message]))
  const byParent = groupTreeRowsByParent(messages)
  const child = byId.get(childId)
  if (!child || child.deleted || child.parentId !== parentId) {
    throw new TreeChangedError(chatId, `insert-between child ${childId} unavailable`)
  }
  const scopes: MutationScope[] = [
    messageScope(childId),
    messageScope(newMessageId),
    childrenScope(chatId, parentId),
    childrenScope(chatId, newMessageId),
  ]
  if (parentId !== null) scopes.push(messageScope(parentId))
  const peers = (byParent.get(parentId) ?? []).filter(
    (sibling) => !sibling.deleted && sibling.turnId === child.turnId,
  )
  for (const peer of peers) scopes.push(messageScope(peer.id))
  return dedupeScopes(scopes)
}

function collectPasteImportScopes(
  chatId: ChatId,
  messages: readonly MessageTreeRow[],
  slot: PasteImportSlot,
  cursor: CursorMap,
  newMessageIds: readonly MessageId[],
  attachmentIds: readonly AttachmentId[],
): MutationScope[] {
  const scopes: MutationScope[] = []
  for (const id of newMessageIds) scopes.push(messageScope(id))
  for (let i = 0; i < newMessageIds.length - 1; i += 1) {
    scopes.push(childrenScope(chatId, newMessageIds[i] as MessageId))
  }
  scopes.push(...attachmentIdScopes(attachmentIds))

  const byId = new Map(messages.map((message) => [message.id, message]))

  if (slot.kind === 'at-end') {
    scopes.push(childrenScope(chatId, resolveActiveLeafId(messages, cursor)))
    return dedupeScopes(scopes)
  }

  if (slot.kind === 'after-all') {
    if (slot.parentId !== null) {
      const parent = byId.get(slot.parentId)
      if (!parent || parent.deleted) {
        throw new TreeChangedError(chatId, `paste parent ${slot.parentId} unavailable`)
      }
      scopes.push(messageScope(parent.id))
    }
    scopes.push(childrenScope(chatId, slot.parentId))
    scopes.push(childrenScope(chatId, newMessageIds.at(-1) as MessageId))
    for (const child of liveDirectChildren(messages, slot.parentId)) {
      scopes.push(messageScope(child.id))
    }
    return dedupeScopes(scopes)
  }

  const target = byId.get(slot.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(chatId, `paste target ${slot.messageId} unavailable`)
  }
  scopes.push(messageScope(target.id))

  if (slot.kind === 'sibling') {
    scopes.push(childrenScope(chatId, target.parentId))
    return dedupeScopes(scopes)
  }

  if (slot.kind === 'before') {
    return dedupeScopes([
      ...scopes,
      ...collectInsertBetweenScopes(
        chatId,
        messages,
        target.parentId,
        target.id,
        newMessageIds[0] as MessageId,
      ),
      childrenScope(chatId, newMessageIds.at(-1) as MessageId),
    ])
  }

  const liveKids = (groupTreeRowsByParent(messages).get(target.id) ?? []).filter(
    (kid) => !kid.deleted,
  )
  const activeDescendantId = cursor[cursorKeyOf(target.id)]
  const activeDescendant =
    activeDescendantId !== undefined
      ? liveKids.find((kid) => kid.id === activeDescendantId)
      : undefined
  if (!activeDescendant) {
    scopes.push(childrenScope(chatId, target.id))
    return dedupeScopes(scopes)
  }

  return dedupeScopes([
    ...scopes,
    ...collectInsertBetweenScopes(
      chatId,
      messages,
      target.id,
      activeDescendant.id,
      newMessageIds[0] as MessageId,
    ),
    childrenScope(chatId, newMessageIds.at(-1) as MessageId),
  ])
}

function collectDeleteScopes(
  chatId: ChatId,
  messages: readonly MessageTreeRow[],
  members: readonly MessageTreeRow[],
  cascade: boolean,
): MutationScope[] {
  const byParent = groupTreeRowsByParent(messages)
  const byId = new Map(messages.map((message) => [message.id, message]))
  const idsToDelete = new Set(
    members.filter((member) => !member.deleted).map((member) => member.id),
  )
  if (cascade) {
    const stack = [...idsToDelete]
    while (stack.length > 0) {
      const id = stack.pop() as MessageId
      for (const kid of byParent.get(id) ?? []) {
        if (idsToDelete.has(kid.id)) continue
        idsToDelete.add(kid.id)
        stack.push(kid.id)
      }
    }
  }
  const scopes: MutationScope[] = []
  const affectedNewParents = new Set<MessageId | null>()

  const firstLiveAncestor = (message: MessageTreeRow): MessageId | null => {
    let parentId = message.parentId
    while (parentId && idsToDelete.has(parentId)) {
      parentId = byId.get(parentId)?.parentId ?? null
    }
    return parentId
  }

  for (const member of messages) {
    if (!idsToDelete.has(member.id)) continue
    if (member.deleted) continue
    scopes.push(messageScope(member.id))
    scopes.push(childrenScope(chatId, member.parentId))
    if (cascade) continue
    scopes.push(childrenScope(chatId, member.id))
    const directKids = (byParent.get(member.id) ?? []).filter((kid) => !kid.deleted)
    for (const kid of directKids) {
      if (idsToDelete.has(kid.id)) continue
      const newParentId = firstLiveAncestor(member)
      scopes.push(messageScope(kid.id))
      scopes.push(childrenScope(chatId, newParentId))
      affectedNewParents.add(newParentId)
    }
  }

  if (!cascade) {
    for (const parentId of affectedNewParents) {
      const siblings = byParent.get(parentId) ?? []
      for (const sibling of siblings) {
        scopes.push(messageScope(sibling.id))
      }
    }
  }

  return dedupeScopes(scopes)
}

async function applyDelete(
  ctx: MutationContext,
  chatId: ChatId,
  members: readonly Pick<MessageTreeRow, 'id' | 'deleted'>[],
  cascade: boolean,
  effects: StructuralEffects,
): Promise<void> {
  const ids = members.filter((message) => !message.deleted).map((message) => message.id)
  if (cascade) {
    effects.tombstoned.push(...(await cascadeSoftDelete(ctx, chatId, ids)))
    return
  }
  const result = await softDeleteWithSplice(ctx, chatId, ids)
  effects.tombstoned.push(...result.tombstoned)
  effects.reparented.push(...result.reparented)
}

function cursorSelectedReparentedChild(
  cursor: CursorMap,
  effect: StructuralEffects['reparented'][number],
  beforeById: ReadonlyMap<MessageId, Message>,
): boolean {
  if (cursor[cursorKeyOf(effect.previousParentId)] !== effect.id) return false
  let currentId = effect.previousParentId
  while (currentId !== effect.newParentId) {
    if (currentId === null) return false
    const current = beforeById.get(currentId)
    if (!current || cursor[cursorKeyOf(current.parentId)] !== current.id) return false
    currentId = current.parentId
  }
  return true
}

function finalizeDelete(
  cursor: CursorMap,
  effects: StructuralEffects,
  beforeById: ReadonlyMap<MessageId, Message>,
): void {
  effects.cursorRemoveKeys = [...effects.tombstoned]
  effects.cursorRemoveValueIds = [...effects.tombstoned]
  for (const effect of effects.reparented) {
    if (!cursorSelectedReparentedChild(cursor, effect, beforeById)) continue
    effects.cursorUpdates[cursorKeyOf(effect.newParentId)] = effect.id
  }
}

export function applyStructuralEffectsToCursor(
  cursor: CursorMap,
  effects: Pick<StructuralEffects, 'cursorRemoveKeys' | 'cursorRemoveValueIds' | 'cursorUpdates'>,
): CursorMap {
  const next = { ...cursor }
  for (const key of effects.cursorRemoveKeys) delete next[key]
  const removeValueIds = new Set(effects.cursorRemoveValueIds)
  for (const [key, value] of Object.entries(next)) {
    if (removeValueIds.has(value)) delete next[key]
  }
  return { ...next, ...effects.cursorUpdates }
}

function deleteCandidateIds(scopes: readonly MutationScope[]): MessageId[] {
  const ids = new Set<MessageId>()
  for (const scope of scopes) {
    if (scope.kind === 'message') ids.add(scope.messageId)
  }
  return [...ids]
}

function structuralFieldsChanged(before: Message, after: Message): boolean {
  return (
    before.deleted !== after.deleted ||
    before.parentId !== after.parentId ||
    before.siblingIndex !== after.siblingIndex
  )
}

function attachmentIdsFromRows(rows: readonly Message[]): AttachmentId[] {
  const ids = new Set<AttachmentId>()
  for (const row of rows) {
    for (const ref of row.attachmentRefs ?? []) {
      if (ref.deletedAt === undefined) ids.add(ref.attachmentId)
    }
  }
  return [...ids]
}

async function executeDeleteMutation(
  repo: WorkspaceRepository,
  input: DeleteInput,
  members: readonly MessageTreeRow[],
  scopes: MutationScope[],
): Promise<DeleteResult> {
  const candidateIds = deleteCandidateIds(scopes)
  const requiredLiveIds = new Set(
    members.filter((member) => !member.deleted).map((member) => member.id),
  )
  const result = await repo.runMutation(scopes, async (ctx) => {
    const beforeById = new Map<MessageId, Message>()
    for (const id of candidateIds) {
      const row = await ctx.getMessage(id)
      if (!row || row.chatId !== input.chatId) {
        throw new TreeChangedError(input.chatId, `delete candidate ${id} unavailable`)
      }
      beforeById.set(id, row)
    }
    for (const id of requiredLiveIds) {
      if (beforeById.get(id)?.deleted !== false) {
        throw new TreeChangedError(input.chatId, `delete member ${id} unavailable`)
      }
    }

    const effects = emptyEffects()
    await applyDelete(ctx, input.chatId, members, input.cascade ?? false, effects)
    const reportedTombstoned = new Set(effects.tombstoned)
    const reportedReparented = new Map(effects.reparented.map((effect) => [effect.id, effect]))

    const changedBeforeRows: Message[] = []
    const changedAfterRows: Message[] = []
    const tombstoned: MessageId[] = []
    const reparented: StructuralEffects['reparented'] = []
    for (const id of candidateIds) {
      const before = beforeById.get(id) as Message
      const after = await ctx.getMessage(id)
      if (!after || after.chatId !== input.chatId) {
        throw new TreeChangedError(input.chatId, `delete candidate ${id} disappeared`)
      }
      if (!structuralFieldsChanged(before, after)) continue
      changedBeforeRows.push(before)
      changedAfterRows.push(after)
      if (!before.deleted && after.deleted) tombstoned.push(id)
      if (before.parentId !== after.parentId) {
        reparented.push({
          id,
          previousParentId: before.parentId,
          newParentId: after.parentId,
        })
      }
    }

    const actualTombstoned = new Set(tombstoned)
    if (
      reportedTombstoned.size !== actualTombstoned.size ||
      [...reportedTombstoned].some((id) => !actualTombstoned.has(id))
    ) {
      throw new TreeChangedError(input.chatId, 'delete tombstone effects escaped capture')
    }
    if (reportedReparented.size !== reparented.length) {
      throw new TreeChangedError(input.chatId, 'delete reparent effects escaped capture')
    }
    for (const effect of reparented) {
      const reported = reportedReparented.get(effect.id)
      if (
        !reported ||
        reported.previousParentId !== effect.previousParentId ||
        reported.newParentId !== effect.newParentId
      ) {
        throw new TreeChangedError(
          input.chatId,
          `delete reparent effect ${effect.id} was not captured`,
        )
      }
    }

    effects.tombstoned = tombstoned
    effects.reparented = reparented
    finalizeDelete(input.cursor, effects, beforeById)

    const preImage: StructuralSnapshot = {
      chatId: input.chatId,
      previousRows: changedBeforeRows,
      newMessageIds: [],
      attachmentIds: attachmentIdsFromRows([...changedBeforeRows, ...changedAfterRows]),
      expectedRows: changedAfterRows.map((row) => ({
        id: row.id,
        parentId: row.parentId,
        siblingIndex: row.siblingIndex,
        deleted: row.deleted,
        nodeVersion: row.nodeVersion,
      })),
    }
    return { effects, preImage }
  })
  return {
    effects: result.value.effects,
    versions: versionsFor(result, input.chatId),
    preImage: result.value.preImage,
  }
}

interface SendUserMessageInput {
  chatId: ChatId
  cursor: CursorMap
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  origin?: MessageOrigin
  role?: MessageRole
  now?: number
  messageId?: MessageId
  turnId?: TurnId
  skipCalibration?: boolean
}

export async function sendUserMessage(
  input: SendUserMessageInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getWorkspaceRepository()
  const { chatId, cursor, content, attachmentRefs, now = Date.now() } = input
  const role = input.role ?? 'user'
  const origin = input.origin ?? 'user'
  const headers = await repo.listMessageHeaders(chatId)
  const parentId = resolveActiveLeafId(headers, cursor)
  const messageId = input.messageId ?? newId()
  const turnId = input.turnId ?? newId()
  // Pre-fetch chat + global calibration outside the mutation. Both are
  // read-only reference data and should not be held under the scope
  // lock. Chat lookup may miss for brand-new chats (first message)
  // in which case calibration falls through to hardcoded tiers.
  const chatForRatio = await repo.getChat(chatId)
  const [globalCal, prefs] = await Promise.all([
    readTokenCalibrationGlobal(),
    readGlobalPreferences(),
  ])
  const modelId = chatForRatio?.settings.model ?? ''
  const canCacheTextCalibration =
    input.skipCalibration !== true &&
    (attachmentRefs?.length ?? 0) === 0 &&
    isTextOnlyContent(content)
  const calibrationFields =
    modelId && canCacheTextCalibration
      ? calibrationFieldsForCreate(
          content,
          modelId,
          chatForRatio,
          globalCal,
          prefs.tokenCalibrationMode,
        )
      : null
  const result = await repo.runMutation(
    dedupeScopes([
      messageScope(messageId),
      childrenScope(chatId, parentId),
      ...attachmentScopes(attachmentRefs),
    ]),
    async (ctx) => {
      const effects = emptyEffects()
      const siblings = await ctx.listChildHeaders(chatId, parentId)
      const row: Message = withAttachmentRefs(
        {
          id: messageId,
          chatId,
          parentId,
          siblingIndex: nextSiblingIndexFromChildren(siblings),
          turnId,
          turnIndex: 0,
          createdAt: now,
          role,
          origin,
          content: structuredClone(content),
          nodeVersion: 0,
          deleted: false,
          ...(calibrationFields ?? {}),
        },
        attachmentRefs,
        now,
      )
      await ctx.putMessage(row)
      effects.newMessageIds.push(messageId)
      if (siblings.length > 0) effects.cursorUpdates[cursorKeyOf(parentId)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, chatId), messageId }
}

interface RegenerateInput {
  chatId: ChatId
  messageId: MessageId
  now?: number
}

export async function regenerateAssistant(
  input: RegenerateInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getWorkspaceRepository()
  const target = await repo.getMessageHeader(input.messageId)
  if (!target || target.chatId !== input.chatId || target.deleted) {
    throw new TreeChangedError(input.chatId, `regenerate target ${input.messageId} unavailable`)
  }
  const messageId = newId()
  const result = await repo.runMutation(
    dedupeScopes([
      messageScope(target.id),
      messageScope(messageId),
      childrenScope(input.chatId, target.parentId),
    ]),
    async (ctx) => {
      const current = await ctx.getMessageHeader(target.id)
      if (!current || current.chatId !== input.chatId || current.deleted) {
        throw new TreeChangedError(input.chatId, `regenerate target ${target.id} unavailable`)
      }
      const effects = emptyEffects()
      const siblings = await ctx.listChildHeaders(input.chatId, current.parentId)
      await ctx.putMessage({
        id: messageId,
        chatId: input.chatId,
        parentId: current.parentId,
        siblingIndex: nextSiblingIndexFromChildren(siblings),
        turnId: newId(),
        turnIndex: 0,
        createdAt: input.now ?? Date.now(),
        role: current.role,
        origin: 'generated',
        content: [],
        nodeVersion: 0,
        deleted: false,
      })
      effects.newMessageIds.push(messageId)
      effects.cursorUpdates[cursorKeyOf(current.parentId)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId), messageId }
}

interface EditMessageInput {
  chatId: ChatId
  messageId: MessageId
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  now?: number
}

export async function editMessageContent(
  input: EditMessageInput,
): Promise<{ versions: ChatVersions }> {
  const repo = getWorkspaceRepository()
  const target = await repo.getMessage(input.messageId)
  if (!target || target.chatId !== input.chatId || target.deleted) {
    throw new TreeChangedError(input.chatId, `edit target ${input.messageId} unavailable`)
  }
  // Pre-fetch chat + global calibration outside the mutation to avoid
  // holding scope locks while reading other tables. Edits update the
  // cache under the CURRENT chat model, not `originalModelId`.
  const chatForRatio = await repo.getChat(input.chatId)
  const [globalCal, prefs] = await Promise.all([
    readTokenCalibrationGlobal(),
    readGlobalPreferences(),
  ])
  const currentModelId = chatForRatio?.settings.model ?? ''
  const calibrationPatch = currentModelId
    ? calibrationFieldsForEdit(
        input.content,
        target.originalCharCount,
        target.originalModelId,
        target.originalCalibrationKey,
        currentModelId,
        chatForRatio,
        globalCal,
        prefs.tokenCalibrationMode,
      )
    : null
  const result = await repo.runMutation(
    dedupeScopes([
      messageScope(input.messageId),
      ...attachmentScopes(target.attachmentRefs),
      ...attachmentScopes(input.attachmentRefs),
    ]),
    async (ctx) => {
      const current = await ctx.getMessage(input.messageId)
      if (!current || current.chatId !== input.chatId || current.deleted) {
        throw new TreeChangedError(input.chatId, `edit target ${input.messageId} unavailable`)
      }
      const next: Message = {
        ...current,
        content: structuredClone(input.content),
        editedAt: input.now ?? Date.now(),
        ...(calibrationPatch ?? {}),
      }
      if (input.attachmentRefs !== undefined) {
        if (input.attachmentRefs.length > 0) {
          const withRefs = withAttachmentRefs(
            {},
            input.attachmentRefs,
            input.now ?? Date.now(),
            current.attachmentRefs,
          )
          if (withRefs.attachmentRefs) next.attachmentRefs = withRefs.attachmentRefs
        } else if (contentHasAttachmentIds(input.content)) {
          next.attachmentRefs = []
        } else delete next.attachmentRefs
      }
      await ctx.putMessage(next)
    },
  )
  return { versions: versionsFor(result, input.chatId) }
}

export async function branchExplicit(params: {
  chatId: ChatId
  messageId: MessageId
  now?: number
}): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getWorkspaceRepository()
  const source = await repo.getMessage(params.messageId)
  if (!source || source.chatId !== params.chatId || source.deleted) {
    throw new TreeChangedError(params.chatId, `branch source ${params.messageId} unavailable`)
  }
  const messageId = newId()
  const result = await repo.runMutation(
    dedupeScopes([
      messageScope(source.id),
      messageScope(messageId),
      childrenScope(params.chatId, source.parentId),
      ...attachmentScopes(source.attachmentRefs),
    ]),
    async (ctx) => {
      const current = await ctx.getMessage(source.id)
      if (!current || current.chatId !== params.chatId || current.deleted) {
        throw new TreeChangedError(params.chatId, `branch source ${source.id} unavailable`)
      }
      const siblings = await ctx.listChildHeaders(params.chatId, current.parentId)
      const cloned = cloneForExplicitBranch(current, {
        id: messageId,
        turnId: newId(),
        turnIndex: 0,
        parentId: current.parentId,
        siblingIndex: nextSiblingIndexFromChildren(siblings),
        createdAt: params.now ?? Date.now(),
      })
      cloned.nodeVersion = 0
      await ctx.putMessage(cloned)
      const effects = emptyEffects()
      effects.newMessageIds.push(messageId)
      effects.cursorUpdates[cursorKeyOf(current.parentId)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, params.chatId), messageId }
}

interface InsertSiblingInput {
  chatId: ChatId
  targetId: MessageId
  content: ContentItem[]
  role?: MessageRole
  origin?: MessageOrigin
  attachmentRefs?: AttachmentRef[]
  now?: number
}

export async function insertSibling(
  input: InsertSiblingInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getWorkspaceRepository()
  const target = await repo.getMessageHeader(input.targetId)
  if (!target || target.chatId !== input.chatId || target.deleted) {
    throw new TreeChangedError(input.chatId, `insert-sibling target ${input.targetId} unavailable`)
  }
  const messageId = newId()
  const result = await repo.runMutation(
    dedupeScopes([
      messageScope(target.id),
      messageScope(messageId),
      childrenScope(input.chatId, target.parentId),
      ...attachmentScopes(input.attachmentRefs),
    ]),
    async (ctx) => {
      const current = await ctx.getMessageHeader(target.id)
      if (!current || current.chatId !== input.chatId || current.deleted) {
        throw new TreeChangedError(input.chatId, `insert-sibling target ${target.id} unavailable`)
      }
      const siblings = await ctx.listChildHeaders(input.chatId, current.parentId)
      const row = withAttachmentRefs(
        {
          id: messageId,
          chatId: input.chatId,
          parentId: current.parentId,
          siblingIndex: nextSiblingIndexFromChildren(siblings),
          turnId: newId(),
          turnIndex: 0,
          createdAt: input.now ?? Date.now(),
          role: input.role ?? current.role,
          origin: input.origin ?? 'imported',
          content: structuredClone(input.content),
          nodeVersion: 0,
          deleted: false,
        },
        input.attachmentRefs,
      )
      await ctx.putMessage(row)
      const effects = emptyEffects()
      effects.newMessageIds.push(messageId)
      effects.cursorUpdates[cursorKeyOf(current.parentId)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId), messageId }
}

interface InsertBetweenInput {
  chatId: ChatId
  parentId: MessageId | null
  childId: MessageId
  content: ContentItem[]
  role: MessageRole
  origin?: MessageOrigin
  attachmentRefs?: AttachmentId[]
  now?: number
}

export async function insertBetween(
  input: InsertBetweenInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getWorkspaceRepository()
  const snapshot = await repo.listMessageHeaders(input.chatId)
  const messageId = newId()
  const scopes = dedupeScopes([
    ...collectInsertBetweenScopes(input.chatId, snapshot, input.parentId, input.childId, messageId),
    ...attachmentIdScopes(input.attachmentRefs),
  ])
  const result = await repo.runMutation(scopes, async (ctx) => {
    const effects = emptyEffects()
    const row = await insertBetweenInner(
      ctx,
      input.chatId,
      input.parentId,
      input.childId,
      {
        id: messageId,
        role: input.role,
        origin: input.origin ?? 'imported',
        content: input.content,
        createdAt: input.now ?? Date.now(),
        ...(input.attachmentRefs && input.attachmentRefs.length > 0
          ? { attachmentRefs: input.attachmentRefs }
          : {}),
      },
      effects,
    )
    return { effects, messageId: row.id }
  })
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId), messageId }
}

interface AppendAsChildInput {
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
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getWorkspaceRepository()
  const parent = await repo.getMessageHeader(input.parentMessageId)
  if (!parent || parent.chatId !== input.chatId || parent.deleted) {
    throw new TreeChangedError(
      input.chatId,
      `append-as-child parent ${input.parentMessageId} unavailable`,
    )
  }
  const messageId = newId()
  const result = await repo.runMutation(
    dedupeScopes([
      messageScope(parent.id),
      messageScope(messageId),
      childrenScope(input.chatId, parent.id),
      ...attachmentIdScopes(input.attachmentRefs),
    ]),
    async (ctx) => {
      const current = await ctx.getMessageHeader(parent.id)
      if (!current || current.chatId !== input.chatId || current.deleted) {
        throw new TreeChangedError(input.chatId, `append-as-child parent ${parent.id} unavailable`)
      }
      const children = await ctx.listChildHeaders(input.chatId, current.id)
      const row = withAttachmentRefs(
        {
          id: messageId,
          chatId: input.chatId,
          parentId: current.id,
          siblingIndex: nextSiblingIndexFromChildren(children),
          turnId: newId(),
          turnIndex: 0,
          createdAt: input.now ?? Date.now(),
          role: input.role,
          origin: input.origin ?? 'imported',
          content: structuredClone(input.content),
          nodeVersion: 0,
          deleted: false,
        },
        input.attachmentRefs,
      )
      await ctx.putMessage(row)
      const effects = emptyEffects()
      effects.newMessageIds.push(messageId)
      effects.cursorUpdates[cursorKeyOf(current.id)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId), messageId }
}

export type PasteImportSlot =
  | { kind: 'at-end' }
  | { kind: 'after-all'; parentId: MessageId | null }
  | { kind: 'before'; messageId: MessageId }
  | { kind: 'after'; messageId: MessageId }
  | { kind: 'sibling'; messageId: MessageId }

interface PasteImportMessageInput {
  role: MessageRole
  content: ContentItem[]
  attachmentRefs?: AttachmentId[]
}

interface PasteImportInput {
  chatId: ChatId
  slot: PasteImportSlot
  cursor: CursorMap
  messages: readonly PasteImportMessageInput[]
  now?: number
}

export async function pasteImport(
  input: PasteImportInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; newMessageIds: MessageId[] }> {
  if (input.messages.length === 0) {
    return { effects: emptyEffects(), versions: ZERO_VERSIONS, newMessageIds: [] }
  }
  const repo = getWorkspaceRepository()
  const snapshot = await repo.listMessageHeaders(input.chatId)
  const newMessageIds = input.messages.map(() => newId())
  const attachmentIds = input.messages.flatMap((message) => message.attachmentRefs ?? [])
  const scopes = collectPasteImportScopes(
    input.chatId,
    snapshot,
    input.slot,
    input.cursor,
    newMessageIds,
    attachmentIds,
  )

  const result = await repo.runMutation(scopes, async (ctx) => {
    if (input.slot.kind === 'after-all') {
      const effects = await createAfterAllImportedChain(
        ctx,
        input.chatId,
        input.slot.parentId,
        input.cursor,
        input.messages,
        newMessageIds,
        snapshot,
        input.now ?? Date.now(),
      )
      return { effects }
    }

    const effects = emptyEffects()
    const firstRow = await createFirstImported(
      ctx,
      input.chatId,
      input.slot,
      input.cursor,
      input.messages[0] as PasteImportMessageInput,
      newMessageIds[0] as MessageId,
      input.now ?? Date.now(),
      effects,
    )

    let tail = firstRow
    const displacedMessageIds = effects.reparented.map((effect) => effect.id)
    const displacedMessageIdSet = new Set(displacedMessageIds)
    const displacedCursorTargetId =
      displacedMessageIds.length > 0 ? (effects.cursorUpdates[firstRow.id] as MessageId) : undefined
    for (let i = 1; i < input.messages.length; i += 1) {
      const spec = input.messages[i] as PasteImportMessageInput
      const id = newMessageIds[i] as MessageId
      const children = await ctx.listChildHeaders(input.chatId, tail.id)
      const retainedChildren =
        displacedMessageIds.length > 0
          ? children.filter((child) => !displacedMessageIdSet.has(child.id))
          : children
      const row: Message = withAttachmentRefs(
        {
          id,
          chatId: input.chatId,
          parentId: tail.id,
          siblingIndex: nextSiblingIndexFromChildren(retainedChildren),
          turnId: newId(),
          turnIndex: 0,
          createdAt: input.now ?? Date.now(),
          role: spec.role,
          origin: 'imported',
          content: structuredClone(spec.content),
          nodeVersion: 0,
          deleted: false,
        },
        spec.attachmentRefs,
      )
      await ctx.putMessage(row)
      effects.newMessageIds.push(id)
      effects.cursorUpdates[cursorKeyOf(tail.id)] = id
      tail = row
    }

    if (displacedCursorTargetId !== undefined && tail.id !== firstRow.id) {
      for (let peerIndex = 0; peerIndex < displacedMessageIds.length; peerIndex += 1) {
        const displacedId = displacedMessageIds[peerIndex] as MessageId
        const displaced = await ctx.getMessage(displacedId)
        if (!displaced || displaced.chatId !== input.chatId || displaced.parentId !== firstRow.id) {
          throw new TreeChangedError(
            input.chatId,
            `paste displaced child ${displacedId} unavailable`,
          )
        }
        await ctx.putMessage({ ...displaced, parentId: tail.id, siblingIndex: peerIndex })
      }
      for (const effect of effects.reparented) {
        if (displacedMessageIdSet.has(effect.id)) effect.newParentId = tail.id
      }
      effects.cursorUpdates[cursorKeyOf(tail.id)] = displacedCursorTargetId
    }

    return { effects }
  })

  return {
    effects: result.value.effects,
    versions: versionsFor(result, input.chatId),
    newMessageIds: result.value.effects.newMessageIds,
  }
}

async function createAfterAllImportedChain(
  ctx: MutationContext,
  chatId: ChatId,
  parentId: MessageId | null,
  cursor: CursorMap,
  messages: readonly PasteImportMessageInput[],
  newMessageIds: readonly MessageId[],
  expectedHeaders: readonly MessageTreeRow[],
  now: number,
): Promise<StructuralEffects> {
  const currentHeaders = await ctx.listMessageHeaders(chatId)
  if (parentId !== null) {
    const parent = currentHeaders.find((message) => message.id === parentId)
    if (!parent || parent.deleted) {
      throw new TreeChangedError(chatId, `paste parent ${parentId} unavailable`)
    }
  }

  const expectedChildren = liveDirectChildren(expectedHeaders, parentId)
  const currentChildren = liveDirectChildren(currentHeaders, parentId)
  if (
    expectedChildren.length !== currentChildren.length ||
    expectedChildren.some((child, index) => child.id !== currentChildren[index]?.id)
  ) {
    throw new TreeChangedError(chatId, `paste children of ${parentId ?? 'root'} changed`)
  }

  const selectedChild = selectedOrDefaultChild(currentHeaders, parentId, cursor, currentChildren)
  const allCurrentChildren = currentHeaders.filter((message) => message.parentId === parentId)
  const effects = emptyEffects()
  let chainParentId = parentId
  const tailId = newMessageIds.at(-1) as MessageId

  for (let index = 0; index < messages.length; index += 1) {
    const spec = messages[index] as PasteImportMessageInput
    const id = newMessageIds[index] as MessageId
    const row = withAttachmentRefs(
      {
        id,
        chatId,
        parentId: chainParentId,
        siblingIndex: index === 0 ? nextSiblingIndexFromChildren(allCurrentChildren) : 0,
        turnId: newId(),
        turnIndex: 0,
        createdAt: now,
        role: spec.role,
        origin: 'imported' as const,
        content: structuredClone(spec.content),
        nodeVersion: 0,
        deleted: false,
      },
      spec.attachmentRefs,
      now,
    )
    await ctx.putMessage(row)
    effects.newMessageIds.push(id)
    effects.cursorUpdates[cursorKeyOf(chainParentId)] = id
    chainParentId = id
  }

  for (let index = 0; index < currentChildren.length; index += 1) {
    const expected = currentChildren[index] as MessageTreeRow
    const child = await ctx.getMessage(expected.id)
    if (
      !child ||
      child.chatId !== chatId ||
      child.deleted ||
      child.parentId !== parentId ||
      child.siblingIndex !== expected.siblingIndex
    ) {
      throw new TreeChangedError(chatId, `paste child ${expected.id} changed`)
    }
    await ctx.putMessage({ ...child, parentId: tailId, siblingIndex: index })
    effects.reparented.push({
      id: child.id,
      previousParentId: parentId,
      newParentId: tailId,
    })
  }

  if (selectedChild) {
    effects.cursorUpdates[cursorKeyOf(tailId)] = selectedChild.id
  }
  return effects
}

async function createFirstImported(
  ctx: MutationContext,
  chatId: ChatId,
  slot: Exclude<PasteImportSlot, { kind: 'after-all' }>,
  cursor: CursorMap,
  spec: PasteImportMessageInput,
  messageId: MessageId,
  now: number,
  effects: StructuralEffects,
): Promise<Message> {
  if (slot.kind === 'at-end') {
    const headers = await ctx.listMessageHeaders(chatId)
    const leaf = resolveActiveLeafId(headers, cursor)
    const children = await ctx.listChildHeaders(chatId, leaf)
    const row: Message = withAttachmentRefs(
      {
        id: messageId,
        chatId,
        parentId: leaf,
        siblingIndex: nextSiblingIndexFromChildren(children),
        turnId: newId(),
        turnIndex: 0,
        createdAt: now,
        role: spec.role,
        origin: 'imported',
        content: structuredClone(spec.content),
        nodeVersion: 0,
        deleted: false,
      },
      spec.attachmentRefs,
    )
    await ctx.putMessage(row)
    effects.newMessageIds.push(row.id)
    effects.cursorUpdates[cursorKeyOf(leaf)] = row.id
    return row
  }

  const target = await ctx.getMessageHeader(slot.messageId)
  if (!target || target.chatId !== chatId || target.deleted) {
    throw new TreeChangedError(chatId, `paste target ${slot.messageId} unavailable`)
  }

  if (slot.kind === 'sibling') {
    const siblings = await ctx.listChildHeaders(chatId, target.parentId)
    const row: Message = withAttachmentRefs(
      {
        id: messageId,
        chatId,
        parentId: target.parentId,
        siblingIndex: nextSiblingIndexFromChildren(siblings),
        turnId: newId(),
        turnIndex: 0,
        createdAt: now,
        role: spec.role,
        origin: 'imported',
        content: structuredClone(spec.content),
        nodeVersion: 0,
        deleted: false,
      },
      spec.attachmentRefs,
    )
    await ctx.putMessage(row)
    effects.newMessageIds.push(row.id)
    effects.cursorUpdates[cursorKeyOf(target.parentId)] = row.id
    return row
  }

  if (slot.kind === 'before') {
    return insertBetweenInner(
      ctx,
      chatId,
      target.parentId,
      target.id,
      {
        id: messageId,
        role: spec.role,
        origin: 'imported',
        content: spec.content,
        createdAt: now,
        ...(spec.attachmentRefs && spec.attachmentRefs.length > 0
          ? { attachmentRefs: spec.attachmentRefs }
          : {}),
      },
      effects,
    )
  }

  const liveKids = (await ctx.listChildHeaders(chatId, target.id)).filter((kid) => !kid.deleted)
  const activeDescendantId = cursor[cursorKeyOf(target.id)]
  const activeDescendant =
    activeDescendantId !== undefined
      ? liveKids.find((kid) => kid.id === activeDescendantId)
      : undefined
  if (activeDescendant) {
    return insertBetweenInner(
      ctx,
      chatId,
      target.id,
      activeDescendant.id,
      {
        id: messageId,
        role: spec.role,
        origin: 'imported',
        content: spec.content,
        createdAt: now,
        ...(spec.attachmentRefs && spec.attachmentRefs.length > 0
          ? { attachmentRefs: spec.attachmentRefs }
          : {}),
      },
      effects,
    )
  }

  const children = await ctx.listChildHeaders(chatId, target.id)
  const row: Message = withAttachmentRefs(
    {
      id: messageId,
      chatId,
      parentId: target.id,
      siblingIndex: nextSiblingIndexFromChildren(children),
      turnId: newId(),
      turnIndex: 0,
      createdAt: now,
      role: spec.role,
      origin: 'imported',
      content: structuredClone(spec.content),
      nodeVersion: 0,
      deleted: false,
    },
    spec.attachmentRefs,
  )
  await ctx.putMessage(row)
  effects.newMessageIds.push(row.id)
  effects.cursorUpdates[cursorKeyOf(target.id)] = row.id
  return row
}

async function insertBetweenInner(
  ctx: MutationContext,
  chatId: ChatId,
  parentId: MessageId | null,
  childId: MessageId,
  spec: {
    id: MessageId
    role: MessageRole
    origin: MessageOrigin
    content: ContentItem[]
    attachmentRefs?: readonly AttachmentId[]
    createdAt: number
  },
  effects: StructuralEffects,
): Promise<Message> {
  const child = await ctx.getMessageHeader(childId)
  if (!child || child.chatId !== chatId || child.deleted || child.parentId !== parentId) {
    throw new TreeChangedError(chatId, `insert-between child ${childId} unavailable`)
  }
  if (parentId !== null) {
    const parent = await ctx.getMessageHeader(parentId)
    if (!parent || parent.chatId !== chatId || parent.deleted) {
      throw new TreeChangedError(chatId, `insert-between parent ${parentId} unavailable`)
    }
  }

  const siblings = await ctx.listChildHeaders(chatId, parentId)
  const row: Message = withAttachmentRefs(
    {
      id: spec.id,
      chatId,
      parentId,
      siblingIndex: nextSiblingIndexFromChildren(siblings),
      turnId: newId(),
      turnIndex: 0,
      createdAt: spec.createdAt,
      role: spec.role,
      origin: spec.origin,
      content: structuredClone(spec.content),
      nodeVersion: 0,
      deleted: false,
    },
    spec.attachmentRefs,
  )
  await ctx.putMessage(row)

  const peerHeaders = siblings
    .filter((sibling) => sibling.turnId === child.turnId && !sibling.deleted)
    .sort((a, b) => a.createdAt - b.createdAt)
  for (let i = 0; i < peerHeaders.length; i += 1) {
    const peerHeader = peerHeaders[i] as MessageTreeRow
    const peer = await ctx.getMessage(peerHeader.id)
    if (!peer || peer.chatId !== chatId || peer.deleted || peer.parentId !== parentId) {
      throw new TreeChangedError(chatId, `insert-between peer ${peerHeader.id} unavailable`)
    }
    await ctx.putMessage({ ...peer, parentId: row.id, siblingIndex: i })
    effects.reparented.push({
      id: peer.id,
      previousParentId: parentId,
      newParentId: row.id,
    })
  }

  effects.newMessageIds.push(row.id)
  effects.cursorUpdates[cursorKeyOf(parentId)] = row.id
  effects.cursorUpdates[cursorKeyOf(row.id)] = childId
  return row
}

interface DeleteInput {
  chatId: ChatId
  messageId: MessageId
  cursor: CursorMap
  cascade?: boolean
  now?: number
}

export async function deletePair(input: DeleteInput): Promise<DeleteResult> {
  const repo = getWorkspaceRepository()
  const all = await repo.listMessageHeaders(input.chatId)
  const byId = new Map(all.map((message) => [message.id, message]))
  const byParent = groupTreeRowsByParent(all)
  const target = byId.get(input.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(input.chatId, `delete-pair target ${input.messageId} unavailable`)
  }
  const userHead = walkUpUntilRole(target, 'user', byId)
  const members: MessageTreeRow[] = []
  if (userHead) {
    members.push(...collectTurnChain(userHead, byParent))
    members.push(...collectPairFollowers(userHead, byParent, input.cursor))
  } else {
    members.push(...collectTurnChain(turnHeadOf(target, byId), byParent))
  }
  return executeDeleteMutation(
    repo,
    input,
    members,
    collectDeleteScopes(input.chatId, all, members, input.cascade ?? false),
  )
}

export async function deleteTurn(input: DeleteInput): Promise<DeleteResult> {
  const repo = getWorkspaceRepository()
  const all = await repo.listMessageHeaders(input.chatId)
  const byId = new Map(all.map((message) => [message.id, message]))
  const byParent = groupTreeRowsByParent(all)
  const target = byId.get(input.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(input.chatId, `delete-turn target ${input.messageId} unavailable`)
  }
  const head = turnHeadOf(target, byId)
  const slotSiblings = (byParent.get(head.parentId) ?? []).filter(
    (sibling) => !sibling.deleted && sibling.turnIndex === 0,
  )
  const members: MessageTreeRow[] = []
  for (const variantHead of slotSiblings) {
    members.push(...collectTurnChain(variantHead, byParent))
  }
  return executeDeleteMutation(
    repo,
    input,
    members,
    collectDeleteScopes(input.chatId, all, members, input.cascade ?? false),
  )
}

// Tombstone exactly ONE message. Live direct children splice up to the
// message's parent; tombstoned children stay in place (already dead and
// re-parenting them has no user-visible effect). Used for the "delete
// just this row" affordance when the user is cleaning up a
// role-adjacency mismatch or explicitly opting out of pair-delete.
export async function deleteSingleMessage(input: DeleteInput): Promise<DeleteResult> {
  const repo = getWorkspaceRepository()
  const all = await repo.listMessageHeaders(input.chatId)
  const byId = new Map(all.map((message) => [message.id, message]))
  const target = byId.get(input.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(input.chatId, `delete-single target ${input.messageId} unavailable`)
  }
  const members: MessageTreeRow[] = [target]
  return executeDeleteMutation(
    repo,
    input,
    members,
    collectDeleteScopes(input.chatId, all, members, input.cascade ?? false),
  )
}

export async function deleteVariant(input: DeleteInput): Promise<DeleteResult> {
  const repo = getWorkspaceRepository()
  const all = await repo.listMessageHeaders(input.chatId)
  const byId = new Map(all.map((message) => [message.id, message]))
  const byParent = groupTreeRowsByParent(all)
  const target = byId.get(input.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(input.chatId, `delete-variant target ${input.messageId} unavailable`)
  }
  const members = collectTurnChain(turnHeadOf(target, byId), byParent)
  return executeDeleteMutation(
    repo,
    input,
    members,
    collectDeleteScopes(input.chatId, all, members, input.cascade ?? false),
  )
}

interface SwipeInput {
  messages: readonly Message[]
  targetId: MessageId
  direction: -1 | 1
  cursor: CursorMap
}

export function swipe(input: SwipeInput): { cursorUpdates: CursorMap; chosenSiblingId: MessageId } {
  const { messages, targetId, direction, cursor } = input
  const byParent = groupByParent(messages)
  const byId = indexById(messages)
  const target = byId.get(targetId)
  if (!target) throw new Error(`Swipe target not found: ${targetId}`)
  const siblings = (byParent.get(target.parentId) ?? []).filter((message) => !message.deleted)
  if (siblings.length === 0) {
    return { cursorUpdates: {}, chosenSiblingId: targetId }
  }
  siblings.sort((a, b) => a.siblingIndex - b.siblingIndex)
  const idx = siblings.findIndex((sibling) => sibling.id === target.id)
  const nextIdx = (idx + direction + siblings.length) % siblings.length
  const chosen = siblings[nextIdx] as Message
  const nextCursor: CursorMap = { ...cursor, [cursorKeyOf(target.parentId)]: chosen.id }
  const updates: CursorMap = { [cursorKeyOf(target.parentId)]: chosen.id }
  const pickDefaultChild = createDefaultChildPicker(byParent, byId)
  let currentId: MessageId = chosen.id
  for (;;) {
    const kids: Message[] = (byParent.get(currentId) ?? []).filter((kid) => !kid.deleted)
    if (kids.length === 0) break
    const pinnedId: MessageId | undefined = nextCursor[cursorKeyOf(currentId)]
    if (pinnedId !== undefined && kids.some((kid) => kid.id === pinnedId)) {
      currentId = pinnedId
      continue
    }
    const pick = pickDefaultChild(kids)
    updates[cursorKeyOf(currentId)] = pick.id
    nextCursor[cursorKeyOf(currentId)] = pick.id
    currentId = pick.id
  }
  return { cursorUpdates: updates, chosenSiblingId: chosen.id }
}

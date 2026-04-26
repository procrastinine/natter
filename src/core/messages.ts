import { newId } from '../lib/ulid'
import {
  attachmentRefsFromIds,
  attachmentScopes,
  decRefs,
  diffAttachmentRefs,
  incRefs,
} from '../store/attachments'
import { getBrowserRepository } from '../store/browser-repo'
import type { MutationContext, WorkspaceMutationResult } from '../store/repository'
import { cursorKeyOf, groupByParent, indexById } from './active-path'
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
  nextSiblingIndex,
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
  refs: readonly AttachmentRef[] | undefined,
  now?: number,
  existing?: readonly AttachmentRef[],
): T & { attachmentRefs?: AttachmentRef[] } {
  const next = row as T & { attachmentRefs?: AttachmentRef[] }
  if (refs && refs.length > 0) {
    next.attachmentRefs = refs.some((ref) => typeof ref !== 'string')
      ? refs.map((ref) => {
          if (typeof ref !== 'string') return { ...ref, updatedAt: now ?? ref.updatedAt }
          return attachmentRefsFromIds([ref], {
            ...(now !== undefined ? { createdAt: now } : {}),
            ...(existing ? { existing } : {}),
          })[0] as AttachmentRef
        })
      : attachmentRefsFromIds(refs as readonly AttachmentId[], {
          ...(now !== undefined ? { createdAt: now } : {}),
          ...(existing ? { existing } : {}),
        })
  }
  return next
}

function resolveActiveLeafId(messages: readonly Message[], cursor: CursorMap): MessageId | null {
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
  let best = kids[0] as Message
  let bestScore = subtreeMaxCreatedAt(best.id, byParent, byId)
  for (let i = 1; i < kids.length; i += 1) {
    const candidate = kids[i] as Message
    const score = subtreeMaxCreatedAt(candidate.id, byParent, byId)
    if (
      score > bestScore ||
      (score === bestScore &&
        (candidate.siblingIndex > best.siblingIndex ||
          (candidate.siblingIndex === best.siblingIndex && candidate.id > best.id)))
    ) {
      best = candidate
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
    for (const kid of kids) {
      if (!kid.deleted && kid.createdAt > best) best = kid.createdAt
      stack.push(kid.id)
    }
  }
  return best
}

function walkUpUntilRole(
  start: Message,
  role: MessageRole,
  byId: Map<MessageId, Message>,
): Message | null {
  let current: Message | null = start
  while (current !== null) {
    if (!current.deleted && current.role === role) return current
    current = current.parentId ? (byId.get(current.parentId) ?? null) : null
  }
  return null
}

function collectPairFollowers(
  userHead: Message,
  byParent: Map<MessageId | null, Message[]>,
  cursor: CursorMap,
): Message[] {
  const result: Message[] = []
  let currentId: MessageId = userHead.id
  while (true) {
    const kids = (byParent.get(currentId) ?? []).filter((kid) => !kid.deleted)
    if (kids.length === 0) break
    const pinnedId = cursor[cursorKeyOf(currentId)]
    const pinned = pinnedId !== undefined ? kids.find((kid) => kid.id === pinnedId) : undefined
    // Fallback when there is no cursor entry at this fork (fresh chat
    // open, or user deleted before swiping). Pick the first assistant/
    // tool/system child at turnIndex=0. Mirror the §8.3 default rule:
    // without a cursor we still need a deterministic pick so delete-pair
    // works on freshly-opened chats.
    const fallback = kids.find((kid) => kid.turnIndex === 0 && kid.role !== 'user')
    const next = pinned ?? fallback
    if (!next || next.role === 'user') break
    result.push(next)
    let cursorId: MessageId = next.id
    while (true) {
      const chainKids = (byParent.get(cursorId) ?? []).filter(
        (kid) => !kid.deleted && kid.turnId === next.turnId,
      )
      if (chainKids.length === 0) break
      const inner = chainKids[0] as Message
      result.push(inner)
      cursorId = inner.id
    }
    currentId = cursorId
  }
  return result
}

function collectInsertBetweenScopes(
  chatId: ChatId,
  messages: readonly Message[],
  parentId: MessageId | null,
  childId: MessageId,
  newMessageId: MessageId,
): MutationScope[] {
  const byId = indexById(messages)
  const byParent = groupByParent(messages)
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
  messages: readonly Message[],
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
  scopes.push(...attachmentScopes(attachmentIds))

  const byId = indexById(messages)

  if (slot.kind === 'at-end') {
    scopes.push(childrenScope(chatId, resolveActiveLeafId(messages, cursor)))
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
    ])
  }

  const liveKids = (groupByParent(messages).get(target.id) ?? []).filter((kid) => !kid.deleted)
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
  ])
}

function collectDeleteScopes(
  chatId: ChatId,
  messages: readonly Message[],
  members: readonly Message[],
  cascade: boolean,
): MutationScope[] {
  const byParent = groupByParent(messages)
  const byId = indexById(messages)
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

  const firstLiveAncestor = (message: Message): MessageId | null => {
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
  members: readonly Message[],
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

function finalizeDelete(cursor: CursorMap, effects: StructuralEffects): void {
  const deletedIds = new Set(effects.tombstoned)
  for (const [key, value] of Object.entries(cursor)) {
    if (deletedIds.has(key)) effects.cursorRemoveKeys.push(key)
    else if (deletedIds.has(value)) effects.cursorRemoveValueIds.push(value)
  }
}

export interface SendUserMessageInput {
  chatId: ChatId
  cursor: CursorMap
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  origin?: MessageOrigin
  role?: MessageRole
  now?: number
  messageId?: MessageId
  turnId?: TurnId
}

export async function sendUserMessage(
  input: SendUserMessageInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getBrowserRepository()
  const { chatId, cursor, content, attachmentRefs, now = Date.now() } = input
  const role = input.role ?? 'user'
  const origin = input.origin ?? 'user'
  const all = await repo.listMessages(chatId)
  const parentId = resolveActiveLeafId(all, cursor)
  const messageId = input.messageId ?? newId()
  const turnId = input.turnId ?? newId()
  // Pre-fetch chat + global calibration outside the mutation — both are
  // read-only reference data and we don't want to hold them under the
  // scope lock. Chat lookup may miss for brand-new chats (first message)
  // in which case calibration falls through to hardcoded tiers.
  const chatForRatio = await repo.getChat(chatId)
  const [globalCal, prefs] = await Promise.all([
    readTokenCalibrationGlobal(),
    readGlobalPreferences(),
  ])
  const modelId = chatForRatio?.settings.model ?? ''
  const canCacheTextCalibration = (attachmentRefs?.length ?? 0) === 0 && isTextOnlyContent(content)
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
      const row: Message = withAttachmentRefs(
        {
          id: messageId,
          chatId,
          parentId,
          siblingIndex: nextSiblingIndex(groupByParent(await ctx.listMessages(chatId)), parentId),
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
      await incRefs(ctx, attachmentRefs ?? [])
      effects.newMessageIds.push(messageId)
      effects.cursorUpdates[cursorKeyOf(parentId)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, chatId), messageId }
}

export interface RegenerateInput {
  chatId: ChatId
  messageId: MessageId
  now?: number
}

export async function regenerateAssistant(
  input: RegenerateInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getBrowserRepository()
  const target = await repo.getMessage(input.messageId)
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
      const current = await ctx.getMessage(target.id)
      if (!current || current.chatId !== input.chatId || current.deleted) {
        throw new TreeChangedError(input.chatId, `regenerate target ${target.id} unavailable`)
      }
      const effects = emptyEffects()
      const siblings = groupByParent(await ctx.listMessages(input.chatId))
      await ctx.putMessage({
        id: messageId,
        chatId: input.chatId,
        parentId: current.parentId,
        siblingIndex: nextSiblingIndex(siblings, current.parentId),
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

export interface EditMessageInput {
  chatId: ChatId
  messageId: MessageId
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  now?: number
}

export async function editMessageContent(
  input: EditMessageInput,
): Promise<{ versions: ChatVersions }> {
  const repo = getBrowserRepository()
  const target = await repo.getMessage(input.messageId)
  if (!target || target.chatId !== input.chatId || target.deleted) {
    throw new TreeChangedError(input.chatId, `edit target ${input.messageId} unavailable`)
  }
  const { toInc, toDec } = diffAttachmentRefs(target.attachmentRefs, input.attachmentRefs)
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
    dedupeScopes([messageScope(input.messageId), ...attachmentScopes([...toInc, ...toDec])]),
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
      await incRefs(ctx, toInc)
      await decRefs(ctx, toDec)
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
  const repo = getBrowserRepository()
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
      const all = await ctx.listMessages(params.chatId)
      const cloned = cloneForExplicitBranch(current, {
        id: messageId,
        turnId: newId(),
        turnIndex: 0,
        parentId: current.parentId,
        siblingIndex: nextSiblingIndex(groupByParent(all), current.parentId),
        createdAt: params.now ?? Date.now(),
      })
      cloned.nodeVersion = 0
      await ctx.putMessage(cloned)
      await incRefs(ctx, cloned.attachmentRefs ?? [])
      const effects = emptyEffects()
      effects.newMessageIds.push(messageId)
      effects.cursorUpdates[cursorKeyOf(current.parentId)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, params.chatId), messageId }
}

export async function continueAssistant(params: {
  chatId: ChatId
  messageId: MessageId
  now?: number
}): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getBrowserRepository()
  const target = await repo.getMessage(params.messageId)
  if (!target || target.chatId !== params.chatId || target.deleted) {
    throw new TreeChangedError(params.chatId, `continue target ${params.messageId} unavailable`)
  }
  const messageId = newId()
  const result = await repo.runMutation(
    dedupeScopes([
      messageScope(target.id),
      messageScope(messageId),
      childrenScope(params.chatId, target.id),
    ]),
    async (ctx) => {
      const current = await ctx.getMessage(target.id)
      if (!current || current.chatId !== params.chatId || current.deleted) {
        throw new TreeChangedError(params.chatId, `continue target ${target.id} unavailable`)
      }
      const all = await ctx.listMessages(params.chatId)
      await ctx.putMessage({
        id: messageId,
        chatId: params.chatId,
        parentId: current.id,
        siblingIndex: nextSiblingIndex(groupByParent(all), current.id),
        turnId: newId(),
        turnIndex: 0,
        createdAt: params.now ?? Date.now(),
        role: 'assistant',
        origin: 'continued',
        content: [],
        nodeVersion: 0,
        deleted: false,
      })
      const effects = emptyEffects()
      effects.newMessageIds.push(messageId)
      effects.cursorUpdates[cursorKeyOf(current.id)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, params.chatId), messageId }
}

export interface InsertSiblingInput {
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
  const repo = getBrowserRepository()
  const target = await repo.getMessage(input.targetId)
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
      const current = await ctx.getMessage(target.id)
      if (!current || current.chatId !== input.chatId || current.deleted) {
        throw new TreeChangedError(input.chatId, `insert-sibling target ${target.id} unavailable`)
      }
      const all = await ctx.listMessages(input.chatId)
      await ctx.putMessage(
        withAttachmentRefs(
          {
            id: messageId,
            chatId: input.chatId,
            parentId: current.parentId,
            siblingIndex: nextSiblingIndex(groupByParent(all), current.parentId),
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
        ),
      )
      await incRefs(ctx, input.attachmentRefs ?? [])
      const effects = emptyEffects()
      effects.newMessageIds.push(messageId)
      effects.cursorUpdates[cursorKeyOf(current.parentId)] = messageId
      return { effects, messageId }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId), messageId }
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

export async function insertBetween(
  input: InsertBetweenInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getBrowserRepository()
  const snapshot = await repo.listMessages(input.chatId)
  const messageId = newId()
  const scopes = dedupeScopes([
    ...collectInsertBetweenScopes(input.chatId, snapshot, input.parentId, input.childId, messageId),
    ...attachmentScopes(input.attachmentRefs),
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
    effects.newMessageIds.push(row.id)
    return { effects, messageId: row.id }
  })
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId), messageId }
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
): Promise<{ effects: StructuralEffects; versions: ChatVersions; messageId: MessageId }> {
  const repo = getBrowserRepository()
  const parent = await repo.getMessage(input.parentMessageId)
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
      ...attachmentScopes(input.attachmentRefs),
    ]),
    async (ctx) => {
      const current = await ctx.getMessage(parent.id)
      if (!current || current.chatId !== input.chatId || current.deleted) {
        throw new TreeChangedError(input.chatId, `append-as-child parent ${parent.id} unavailable`)
      }
      const all = await ctx.listMessages(input.chatId)
      await ctx.putMessage(
        withAttachmentRefs(
          {
            id: messageId,
            chatId: input.chatId,
            parentId: current.id,
            siblingIndex: nextSiblingIndex(groupByParent(all), current.id),
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
        ),
      )
      await incRefs(ctx, input.attachmentRefs ?? [])
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

export async function pasteImport(
  input: PasteImportInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions; newMessageIds: MessageId[] }> {
  if (input.messages.length === 0) {
    return { effects: emptyEffects(), versions: ZERO_VERSIONS, newMessageIds: [] }
  }
  const repo = getBrowserRepository()
  const snapshot = await repo.listMessages(input.chatId)
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
    for (let i = 1; i < input.messages.length; i += 1) {
      const spec = input.messages[i] as PasteImportMessageInput
      const id = newMessageIds[i] as MessageId
      const all = await ctx.listMessages(input.chatId)
      const row: Message = withAttachmentRefs(
        {
          id,
          chatId: input.chatId,
          parentId: tail.id,
          siblingIndex: nextSiblingIndex(groupByParent(all), tail.id),
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
      await incRefs(ctx, spec.attachmentRefs ?? [])
      effects.newMessageIds.push(id)
      effects.cursorUpdates[cursorKeyOf(tail.id)] = id
      tail = row
    }

    return { effects }
  })

  return {
    effects: result.value.effects,
    versions: versionsFor(result, input.chatId),
    newMessageIds: result.value.effects.newMessageIds,
  }
}

async function createFirstImported(
  ctx: MutationContext,
  chatId: ChatId,
  slot: PasteImportSlot,
  cursor: CursorMap,
  spec: PasteImportMessageInput,
  messageId: MessageId,
  now: number,
  effects: StructuralEffects,
): Promise<Message> {
  if (slot.kind === 'at-end') {
    const all = await ctx.listMessages(chatId)
    const leaf = resolveActiveLeafId(all, cursor)
    const row: Message = withAttachmentRefs(
      {
        id: messageId,
        chatId,
        parentId: leaf,
        siblingIndex: nextSiblingIndex(groupByParent(all), leaf),
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
    await incRefs(ctx, spec.attachmentRefs ?? [])
    effects.newMessageIds.push(row.id)
    effects.cursorUpdates[cursorKeyOf(leaf)] = row.id
    return row
  }

  const target = await ctx.getMessage(slot.messageId)
  if (!target || target.chatId !== chatId || target.deleted) {
    throw new TreeChangedError(chatId, `paste target ${slot.messageId} unavailable`)
  }

  if (slot.kind === 'sibling') {
    const all = await ctx.listMessages(chatId)
    const row: Message = withAttachmentRefs(
      {
        id: messageId,
        chatId,
        parentId: target.parentId,
        siblingIndex: nextSiblingIndex(groupByParent(all), target.parentId),
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
    await incRefs(ctx, spec.attachmentRefs ?? [])
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

  const liveKids = (await ctx.listChildren(chatId, target.id)).filter((kid) => !kid.deleted)
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

  const all = await ctx.listMessages(chatId)
  const row: Message = withAttachmentRefs(
    {
      id: messageId,
      chatId,
      parentId: target.id,
      siblingIndex: nextSiblingIndex(groupByParent(all), target.id),
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
  await incRefs(ctx, spec.attachmentRefs ?? [])
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
  const child = await ctx.getMessage(childId)
  if (!child || child.chatId !== chatId || child.deleted || child.parentId !== parentId) {
    throw new TreeChangedError(chatId, `insert-between child ${childId} unavailable`)
  }
  if (parentId !== null) {
    const parent = await ctx.getMessage(parentId)
    if (!parent || parent.chatId !== chatId || parent.deleted) {
      throw new TreeChangedError(chatId, `insert-between parent ${parentId} unavailable`)
    }
  }

  const all = await ctx.listMessages(chatId)
  const byParent = groupByParent(all)
  const row: Message = withAttachmentRefs(
    {
      id: spec.id,
      chatId,
      parentId,
      siblingIndex: nextSiblingIndex(byParent, parentId),
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
  await incRefs(ctx, spec.attachmentRefs ?? [])

  const peers = (byParent.get(parentId) ?? [])
    .filter((sibling) => sibling.turnId === child.turnId && !sibling.deleted)
    .sort((a, b) => a.createdAt - b.createdAt)
  for (let i = 0; i < peers.length; i += 1) {
    const peer = peers[i] as Message
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

export interface DeleteInput {
  chatId: ChatId
  messageId: MessageId
  cursor: CursorMap
  cascade?: boolean
  now?: number
}

export async function deletePair(
  input: DeleteInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions }> {
  const repo = getBrowserRepository()
  const all = await repo.listMessages(input.chatId)
  const byId = indexById(all)
  const byParent = groupByParent(all)
  const target = byId.get(input.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(input.chatId, `delete-pair target ${input.messageId} unavailable`)
  }
  const userHead = walkUpUntilRole(target, 'user', byId)
  const members: Message[] = []
  if (userHead) {
    members.push(...collectTurnChain(userHead, byParent))
    members.push(...collectPairFollowers(userHead, byParent, input.cursor))
  } else {
    members.push(...collectTurnChain(turnHeadOf(target, byId), byParent))
  }
  const result = await repo.runMutation(
    collectDeleteScopes(input.chatId, all, members, input.cascade ?? false),
    async (ctx) => {
      const effects = emptyEffects()
      await applyDelete(ctx, input.chatId, members, input.cascade ?? false, effects)
      finalizeDelete(input.cursor, effects)
      return { effects }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId) }
}

export async function deleteTurn(
  input: DeleteInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions }> {
  const repo = getBrowserRepository()
  const all = await repo.listMessages(input.chatId)
  const byId = indexById(all)
  const byParent = groupByParent(all)
  const target = byId.get(input.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(input.chatId, `delete-turn target ${input.messageId} unavailable`)
  }
  const head = turnHeadOf(target, byId)
  const slotSiblings = (byParent.get(head.parentId) ?? []).filter(
    (sibling) => !sibling.deleted && sibling.turnIndex === 0,
  )
  const members: Message[] = []
  for (const variantHead of slotSiblings) {
    members.push(...collectTurnChain(variantHead, byParent))
  }
  const result = await repo.runMutation(
    collectDeleteScopes(input.chatId, all, members, input.cascade ?? false),
    async (ctx) => {
      const effects = emptyEffects()
      await applyDelete(ctx, input.chatId, members, input.cascade ?? false, effects)
      finalizeDelete(input.cursor, effects)
      return { effects }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId) }
}

// Tombstone exactly ONE message. Live direct children splice up to the
// message's parent; tombstoned children stay in place (they're already
// dead and re-parenting them has no user-visible effect). Used for the
// "delete just this row" affordance when the user is cleaning up a
// role-adjacency mismatch or explicitly opting out of pair-delete.
export async function deleteSingleMessage(
  input: DeleteInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions }> {
  const repo = getBrowserRepository()
  const all = await repo.listMessages(input.chatId)
  const byId = indexById(all)
  const target = byId.get(input.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(input.chatId, `delete-single target ${input.messageId} unavailable`)
  }
  const members: Message[] = [target]
  const result = await repo.runMutation(
    collectDeleteScopes(input.chatId, all, members, input.cascade ?? false),
    async (ctx) => {
      const effects = emptyEffects()
      await applyDelete(ctx, input.chatId, members, input.cascade ?? false, effects)
      finalizeDelete(input.cursor, effects)
      return { effects }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId) }
}

export async function deleteVariant(
  input: DeleteInput,
): Promise<{ effects: StructuralEffects; versions: ChatVersions }> {
  const repo = getBrowserRepository()
  const all = await repo.listMessages(input.chatId)
  const byId = indexById(all)
  const byParent = groupByParent(all)
  const target = byId.get(input.messageId)
  if (!target || target.deleted) {
    throw new TreeChangedError(input.chatId, `delete-variant target ${input.messageId} unavailable`)
  }
  const members = collectTurnChain(turnHeadOf(target, byId), byParent)
  const result = await repo.runMutation(
    collectDeleteScopes(input.chatId, all, members, input.cascade ?? false),
    async (ctx) => {
      const effects = emptyEffects()
      await applyDelete(ctx, input.chatId, members, input.cascade ?? false, effects)
      finalizeDelete(input.cursor, effects)
      return { effects }
    },
  )
  return { effects: result.value.effects, versions: versionsFor(result, input.chatId) }
}

export interface SwipeInput {
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
  let currentId: MessageId | null = chosen.id
  while (currentId !== null) {
    const kids: Message[] = (byParent.get(currentId) ?? []).filter((kid) => !kid.deleted)
    if (kids.length === 0) break
    const pinnedId: MessageId | undefined = nextCursor[cursorKeyOf(currentId)]
    if (pinnedId !== undefined && kids.some((kid) => kid.id === pinnedId)) {
      currentId = pinnedId
      continue
    }
    const pick = pickByGreatestSubtreeCreatedAt(kids, byParent, byId)
    updates[cursorKeyOf(currentId)] = pick.id
    nextCursor[cursorKeyOf(currentId)] = pick.id
    currentId = pick.id
  }
  return { cursorUpdates: updates, chosenSiblingId: chosen.id }
}

export type { TurnId }

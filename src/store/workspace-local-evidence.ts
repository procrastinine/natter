import { childListKey } from '../core/child-list-state'
import type { ChatId, ChildListState, ChildSlotMember, MessageId } from '../core/types'
import {
  classifyMessageHeaderRevision,
  sameMessageHeaderStructure,
  sameMessageHeaderValue,
} from './message-storage'
import {
  freezeWorkspaceBoundaryValue,
  type WorkspaceDeltaNormalForm,
} from './workspace-change-boundary'
import type {
  CommitEnvelope,
  WorkspaceLocalChildSlotEvidence,
  WorkspaceLocalMessageRevision,
} from './workspace-protocol'

export class WorkspaceLocalChildSlotAccumulator {
  private before: ChildListState | undefined
  private beforeTail: ChildSlotMember | null | undefined
  private state: ChildListState | undefined
  private mode: 'append' | 'replace' = 'append'
  private readonly upserts = new Map<MessageId, ChildSlotMember>()
  private readonly removedMessageIds = new Set<MessageId>()

  add(incoming: WorkspaceLocalChildSlotEvidence): void {
    validateWorkspaceLocalChildSlotEvidence(incoming)
    const current = this.state
    if (!current) {
      this.before = incoming.before
      this.beforeTail = incoming.mode === 'append' ? incoming.beforeTail : undefined
      this.state = incoming.state
      this.mode = incoming.mode
      this.replaceMutableEvidence(incoming)
      return
    }
    if (current.id !== incoming.state.id) {
      throw new Error('WorkspaceLocalChildSlotOwnerMismatch')
    }
    if (incoming.state.version === current.version) {
      const materialized = this.materialize()
      if (!materialized || !sameWorkspaceLocalChildSlotEvidence(materialized, incoming)) {
        throw new Error(`WorkspaceLocalChildSlotVersionCollision:${incoming.state.id}`)
      }
      return
    }
    if (!incoming.before || !sameChildListState(incoming.before, current)) {
      throw new Error(`WorkspaceLocalChildSlotTransitionBroken:${incoming.state.id}`)
    }
    if (incoming.state.version < current.version) {
      throw new Error(`WorkspaceLocalChildSlotVersionRegressed:${incoming.state.id}`)
    }
    this.state = incoming.state
    if (incoming.mode === 'replace') {
      this.mode = 'replace'
      this.beforeTail = undefined
      this.replaceMutableEvidence(incoming, true)
      return
    }
    for (const messageId of incoming.removedMessageIds) {
      this.upserts.delete(messageId)
      this.removedMessageIds.add(messageId)
    }
    for (const member of incoming.upserts) {
      this.removedMessageIds.delete(member.id)
      this.upserts.set(member.id, member)
    }
  }

  materialize(): WorkspaceLocalChildSlotEvidence | undefined {
    const state = this.state
    if (!state) return undefined
    const evidence = cloneWorkspaceLocalChildSlotEvidence(
      this.mode === 'append'
        ? {
            before: this.before as ChildListState,
            beforeTail: this.beforeTail as ChildSlotMember | null,
            state,
            mode: 'append',
            upserts: [...this.upserts.values()],
            removedMessageIds: [],
          }
        : {
            ...(this.before ? { before: this.before } : {}),
            state,
            mode: 'replace',
            upserts: [...this.upserts.values()],
            removedMessageIds: [...this.removedMessageIds],
          },
    )
    validateWorkspaceLocalChildSlotEvidence(evidence)
    return evidence
  }

  private replaceMutableEvidence(
    evidence: WorkspaceLocalChildSlotEvidence,
    preserveRemovals = false,
  ): void {
    const removedMessageIds = preserveRemovals
      ? new Set([...this.removedMessageIds, ...evidence.removedMessageIds])
      : new Set(evidence.removedMessageIds)
    this.upserts.clear()
    this.removedMessageIds.clear()
    for (const member of evidence.upserts) {
      this.upserts.set(member.id, member)
      removedMessageIds.delete(member.id)
    }
    for (const messageId of removedMessageIds) this.removedMessageIds.add(messageId)
  }
}

export function validateWorkspaceLocalChildSlotEvidence(
  evidence: WorkspaceLocalChildSlotEvidence,
): void {
  const { state } = evidence
  const expectedKey = childListKey(state.chatId, state.parentId)
  validateChildListState(state, expectedKey)
  if (evidence.before) {
    validateChildListState(evidence.before, expectedKey)
    if (
      evidence.before.id !== state.id ||
      evidence.before.chatId !== state.chatId ||
      evidence.before.parentId !== state.parentId ||
      evidence.before.version > state.version ||
      (evidence.before.version === state.version && !sameChildListState(evidence.before, state))
    ) {
      throw new Error(`WorkspaceLocalChildSlotBeforeInvalid:${state.id}`)
    }
  }
  const upsertIds = new Set<MessageId>()
  const upsertPositions = new Set<number>()
  const upsertsById = new Map<MessageId, ChildSlotMember>()
  const upsertsByPosition = new Map<number, ChildSlotMember>()
  for (const member of evidence.upserts) {
    if (
      upsertIds.has(member.id) ||
      upsertPositions.has(member.position) ||
      member.chatId !== state.chatId ||
      member.parentId !== state.parentId ||
      member.parentKey !== state.id ||
      !Number.isSafeInteger(member.position) ||
      member.position < 0 ||
      member.position >= state.liveCount ||
      (member.position === 0) !== (member.previousMessageId === null) ||
      (member.position === state.liveCount - 1) !== (member.nextMessageId === null) ||
      (member.position === 0 && state.firstLiveChildId !== member.id) ||
      (member.position === state.liveCount - 1 && state.lastLiveChildId !== member.id)
    ) {
      throw new Error(`WorkspaceLocalChildSlotMemberInvalid:${member.id}`)
    }
    upsertIds.add(member.id)
    upsertPositions.add(member.position)
    upsertsById.set(member.id, member)
    upsertsByPosition.set(member.position, member)
  }
  for (const member of evidence.upserts) {
    const previous = member.previousMessageId
      ? upsertsById.get(member.previousMessageId)
      : undefined
    const next = member.nextMessageId ? upsertsById.get(member.nextMessageId) : undefined
    const adjacentPrevious = upsertsByPosition.get(member.position - 1)
    const adjacentNext = upsertsByPosition.get(member.position + 1)
    if (
      (previous &&
        (previous.position !== member.position - 1 || previous.nextMessageId !== member.id)) ||
      (next && (next.position !== member.position + 1 || next.previousMessageId !== member.id)) ||
      (adjacentPrevious && member.previousMessageId !== adjacentPrevious.id) ||
      (adjacentNext && member.nextMessageId !== adjacentNext.id)
    ) {
      throw new Error(`WorkspaceLocalChildSlotPatchLinkInvalid:${member.id}`)
    }
  }
  if (evidence.mode === 'append') validateCompleteAppend(evidence)
  else validateCompleteReplacement(evidence)
  const removedIds = new Set<MessageId>()
  for (const messageId of evidence.removedMessageIds) {
    if (removedIds.has(messageId) || upsertIds.has(messageId)) {
      throw new Error(`WorkspaceLocalChildSlotRemovalInvalid:${messageId}`)
    }
    removedIds.add(messageId)
  }
}

export function validateAndFreezeWorkspaceLocalCommit(
  commit: CommitEnvelope<unknown>,
  normalForm: WorkspaceDeltaNormalForm,
): void {
  validateWorkspaceLocalCommitEvidence(commit, normalForm)
  freezeWorkspaceBoundaryValue(commit.delta)
  freezeWorkspaceBoundaryValue(commit.receipt)
  Object.freeze(commit)
}

function validateWorkspaceLocalCommitEvidence(
  commit: CommitEnvelope<unknown>,
  normalForm: WorkspaceDeltaNormalForm,
): void {
  const { delta, receipt } = commit
  if (commit.effectScope === 'none') {
    if (
      delta.facts.length !== 0 ||
      delta.invalidations.length !== 0 ||
      receipt.chats.length !== 0 ||
      receipt.constructions.length !== 0 ||
      receipt.messageRevisions.length !== 0 ||
      receipt.childSlots.length !== 0
    ) {
      throw new Error('WorkspaceLocalNoopEvidencePresent')
    }
    return
  }
  if (delta.facts.length === 0 && delta.invalidations.length === 0) {
    throw new Error('WorkspaceLocalWriteEvidenceMissing')
  }

  const { messageFacts, createdChatIds, changedSidebarIds, deletedChatIds } = normalForm

  const receiptRevisions = new Map<MessageId, WorkspaceLocalMessageRevision>()
  const revisedChatIds = new Set<ChatId>()
  for (const revision of receipt.messageRevisions) {
    validateWorkspaceLocalMessageRevision(revision)
    if (receiptRevisions.has(revision.header.id)) {
      throw new Error(`WorkspaceLocalMessageReceiptDuplicate:${revision.header.id}`)
    }
    receiptRevisions.set(revision.header.id, revision)
    revisedChatIds.add(revision.header.chatId)
    const fact = messageFacts.get(revision.header.id)
    if (
      !fact ||
      fact.structuralVersion !== revision.structuralVersion ||
      !sameMessageHeaderValue(fact.header, revision.header) ||
      fact.changed.structure !== revision.changed.structure ||
      fact.changed.body !== revision.changed.body
    ) {
      throw new Error(`WorkspaceLocalMessageFactMismatch:${revision.header.id}`)
    }
  }
  for (const messageId of messageFacts.keys()) {
    if (!receiptRevisions.has(messageId)) {
      throw new Error(`WorkspaceLocalMessageReceiptMissing:${messageId}`)
    }
  }

  const receiptChatIds = validateReceiptChats(receipt.chats, 'WorkspaceLocalChatReceiptDuplicate')
  const constructionIds = validateReceiptChats(
    receipt.constructions,
    'WorkspaceLocalConstructionReceiptDuplicate',
  )
  for (const chatId of constructionIds) {
    if (receiptChatIds.has(chatId) || !createdChatIds.has(chatId)) {
      throw new Error(`WorkspaceLocalConstructionFactMismatch:${chatId}`)
    }
  }
  for (const chatId of createdChatIds) {
    if (!constructionIds.has(chatId)) {
      throw new Error(`WorkspaceLocalConstructionReceiptMissing:${chatId}`)
    }
  }
  for (const chatId of receiptChatIds) {
    if (!changedSidebarIds.has(chatId)) {
      throw new Error(`WorkspaceLocalChatFactMismatch:${chatId}`)
    }
  }
  for (const chatId of changedSidebarIds) {
    if (!receiptChatIds.has(chatId)) {
      throw new Error(`WorkspaceLocalChatReceiptMissing:${chatId}`)
    }
  }
  if (
    [...deletedChatIds].some(
      (chatId) =>
        createdChatIds.has(chatId) ||
        changedSidebarIds.has(chatId) ||
        receiptChatIds.has(chatId) ||
        constructionIds.has(chatId) ||
        revisedChatIds.has(chatId),
    )
  ) {
    throw new Error('WorkspaceLocalChatFinalStateContradiction')
  }

  const childEvidenceByKey = new Map<string, WorkspaceLocalChildSlotEvidence>()
  for (const evidence of receipt.childSlots) {
    validateWorkspaceLocalChildSlotEvidence(evidence)
    if (childEvidenceByKey.has(evidence.state.id)) {
      throw new Error(`WorkspaceLocalChildSlotReceiptDuplicate:${evidence.state.id}`)
    }
    childEvidenceByKey.set(evidence.state.id, evidence)
  }
  const exactInvalidatedChildKeys = new Set<string>()
  const broadlyInvalidatedChats = new Set<ChatId>()
  for (const invalidation of delta.invalidations) {
    if (invalidation.kind !== 'child-slot') continue
    if (!invalidation.parentIds) broadlyInvalidatedChats.add(invalidation.chatId)
    else {
      for (const parentId of invalidation.parentIds) {
        exactInvalidatedChildKeys.add(childListKey(invalidation.chatId, parentId))
      }
    }
  }
  for (const evidence of childEvidenceByKey.values()) {
    if (deletedChatIds.has(evidence.state.chatId)) {
      throw new Error(`WorkspaceLocalDeletedChatChildSlotEvidence:${evidence.state.id}`)
    }
    if (
      !broadlyInvalidatedChats.has(evidence.state.chatId) &&
      !exactInvalidatedChildKeys.has(evidence.state.id)
    ) {
      throw new Error(`WorkspaceLocalChildSlotInvalidationMissing:${evidence.state.id}`)
    }
  }
  for (const key of exactInvalidatedChildKeys) {
    if (!childEvidenceByKey.has(key)) {
      throw new Error(`WorkspaceLocalChildSlotReceiptMissing:${key}`)
    }
  }
}

function validateWorkspaceLocalMessageRevision(revision: WorkspaceLocalMessageRevision): void {
  const { before, header, presentation } = revision
  if (
    !Number.isSafeInteger(revision.structuralVersion) ||
    revision.structuralVersion < 0 ||
    (before !== undefined && (before.id !== header.id || before.chatId !== header.chatId))
  ) {
    throw new Error(`WorkspaceLocalMessageRevisionInvalid:${header.id}`)
  }
  if (before) {
    const relation = classifyMessageHeaderRevision(header, before)
    if (
      relation !== 'compatible-newer' &&
      relation !== 'structural-newer' &&
      relation !== 'identical'
    ) {
      throw new Error(`WorkspaceLocalMessageRevisionInvalid:${header.id}:${relation}`)
    }
  }
  const structureChanged = !before || !sameMessageHeaderStructure(before, header)
  const bodyChanged = !before || before.bodyVersion !== header.bodyVersion
  if (
    revision.changed.structure !== structureChanged ||
    revision.changed.body !== bodyChanged ||
    (before !== undefined && sameMessageHeaderValue(before, header)) ||
    (bodyChanged && !presentation)
  ) {
    throw new Error(`WorkspaceLocalMessageRevisionFlagsInvalid:${header.id}`)
  }
  if (
    presentation &&
    (!sameMessageHeaderValue(presentation.header, header) ||
      presentation.message.id !== header.id ||
      presentation.message.chatId !== header.chatId ||
      presentation.bodyVersion !== header.bodyVersion)
  ) {
    throw new Error(`WorkspaceLocalMessagePresentationInvalid:${header.id}`)
  }
}

function validateReceiptChats(
  chats: CommitEnvelope<unknown>['receipt']['chats'],
  duplicateError: string,
): Set<ChatId> {
  const ids = new Set<ChatId>()
  for (const chat of chats) {
    if (!chat.id || ids.has(chat.id)) throw new Error(`${duplicateError}:${chat.id}`)
    ids.add(chat.id)
  }
  return ids
}

function validateChildListState(state: ChildListState, expectedKey: string): void {
  if (
    state.id !== expectedKey ||
    !Number.isSafeInteger(state.version) ||
    state.version < 0 ||
    !Number.isFinite(state.updatedAt) ||
    state.updatedAt < 0 ||
    !Number.isSafeInteger(state.liveCount) ||
    state.liveCount < 0 ||
    !Number.isSafeInteger(state.nextSiblingIndex) ||
    state.nextSiblingIndex < state.liveCount ||
    (state.liveCount === 0) !== (state.firstLiveChildId === null) ||
    (state.liveCount === 0) !== (state.lastLiveChildId === null)
  ) {
    throw new Error(`WorkspaceLocalChildSlotStateInvalid:${state.id}`)
  }
}

function validateCompleteReplacement(evidence: WorkspaceLocalChildSlotEvidence): void {
  if (evidence.upserts.length !== evidence.state.liveCount) {
    throw new Error(`WorkspaceLocalChildSlotReplacementIncomplete:${evidence.state.id}`)
  }
  const ordered = new Array<ChildSlotMember | undefined>(evidence.state.liveCount)
  for (const member of evidence.upserts) ordered[member.position] = member
  for (let index = 0; index < ordered.length; index += 1) {
    const member = ordered[index]
    if (
      !member ||
      member.position !== index ||
      member.previousMessageId !== (ordered[index - 1]?.id ?? null) ||
      member.nextMessageId !== (ordered[index + 1]?.id ?? null)
    ) {
      throw new Error(
        `WorkspaceLocalChildSlotReplacementLinkInvalid:${member?.id ?? evidence.state.id}`,
      )
    }
  }
}

function validateCompleteAppend(
  evidence: Extract<WorkspaceLocalChildSlotEvidence, { mode: 'append' }>,
): void {
  const { before, state, upserts, removedMessageIds } = evidence
  if (
    removedMessageIds.length !== 0 ||
    before.id !== state.id ||
    before.chatId !== state.chatId ||
    before.parentId !== state.parentId ||
    before.version >= state.version ||
    before.updatedAt > state.updatedAt ||
    before.liveCount >= state.liveCount ||
    before.nextSiblingIndex > state.nextSiblingIndex ||
    (before.liveCount > 0 && before.firstLiveChildId !== state.firstLiveChildId)
  ) {
    throw new Error(`WorkspaceLocalChildSlotAppendTransitionInvalid:${state.id}`)
  }

  const appendedCount = state.liveCount - before.liveCount
  const expectedUpsertCount = appendedCount + (before.liveCount > 0 ? 1 : 0)
  if (upserts.length !== expectedUpsertCount) {
    throw new Error(`WorkspaceLocalChildSlotAppendIncomplete:${state.id}`)
  }
  const byPosition = new Map(upserts.map((member) => [member.position, member]))
  const priorTail = before.liveCount > 0 ? byPosition.get(before.liveCount - 1) : undefined
  if (
    (before.liveCount === 0 && evidence.beforeTail !== null) ||
    (before.liveCount > 0 &&
      (!evidence.beforeTail ||
        !priorTail ||
        evidence.beforeTail.id !== before.lastLiveChildId ||
        evidence.beforeTail.chatId !== before.chatId ||
        evidence.beforeTail.parentId !== before.parentId ||
        evidence.beforeTail.parentKey !== before.id ||
        evidence.beforeTail.position !== before.liveCount - 1 ||
        evidence.beforeTail.nextMessageId !== null ||
        priorTail.id !== evidence.beforeTail.id ||
        priorTail.chatId !== evidence.beforeTail.chatId ||
        priorTail.parentId !== evidence.beforeTail.parentId ||
        priorTail.parentKey !== evidence.beforeTail.parentKey ||
        priorTail.position !== evidence.beforeTail.position ||
        priorTail.previousMessageId !== evidence.beforeTail.previousMessageId ||
        priorTail.nextMessageId !== byPosition.get(before.liveCount)?.id))
  ) {
    throw new Error(`WorkspaceLocalChildSlotAppendTailMissing:${state.id}`)
  }
  for (let position = before.liveCount; position < state.liveCount; position += 1) {
    const member = byPosition.get(position)
    const previous = byPosition.get(position - 1)
    const next = byPosition.get(position + 1)
    if (
      !member ||
      member.previousMessageId !==
        (position === 0 ? null : (previous?.id ?? before.lastLiveChildId)) ||
      member.nextMessageId !== (next?.id ?? null)
    ) {
      throw new Error(`WorkspaceLocalChildSlotAppendLinkInvalid:${member?.id ?? state.id}`)
    }
  }
  const firstAppended = byPosition.get(before.liveCount)
  const lastAppended = byPosition.get(state.liveCount - 1)
  if (
    !firstAppended ||
    !lastAppended ||
    state.firstLiveChildId !== (before.firstLiveChildId ?? firstAppended.id) ||
    state.lastLiveChildId !== lastAppended.id
  ) {
    throw new Error(`WorkspaceLocalChildSlotAppendBoundaryInvalid:${state.id}`)
  }
}

function cloneWorkspaceLocalChildSlotEvidence(
  evidence: WorkspaceLocalChildSlotEvidence,
): WorkspaceLocalChildSlotEvidence {
  return Object.freeze(
    evidence.mode === 'append'
      ? {
          before: structuredClone(evidence.before),
          beforeTail: structuredClone(evidence.beforeTail),
          state: structuredClone(evidence.state),
          mode: evidence.mode,
          upserts: Object.freeze(evidence.upserts.map((member) => structuredClone(member))),
          removedMessageIds: Object.freeze([]),
        }
      : {
          ...(evidence.before ? { before: structuredClone(evidence.before) } : {}),
          state: structuredClone(evidence.state),
          mode: evidence.mode,
          upserts: Object.freeze(evidence.upserts.map((member) => structuredClone(member))),
          removedMessageIds: Object.freeze([...evidence.removedMessageIds]),
        },
  )
}

function sameWorkspaceLocalChildSlotEvidence(
  left: WorkspaceLocalChildSlotEvidence,
  right: WorkspaceLocalChildSlotEvidence,
): boolean {
  return (
    left.mode === right.mode &&
    (left.mode !== 'append' ||
      (right.mode === 'append' &&
        ((left.beforeTail === null && right.beforeTail === null) ||
          (left.beforeTail !== null &&
            right.beforeTail !== null &&
            sameChildSlotMember(left.beforeTail, right.beforeTail))))) &&
    ((left.before === undefined && right.before === undefined) ||
      (left.before !== undefined &&
        right.before !== undefined &&
        sameChildListState(left.before, right.before))) &&
    left.state.id === right.state.id &&
    left.state.chatId === right.state.chatId &&
    left.state.parentId === right.state.parentId &&
    left.state.version === right.state.version &&
    left.state.updatedAt === right.state.updatedAt &&
    left.state.liveCount === right.state.liveCount &&
    left.state.firstLiveChildId === right.state.firstLiveChildId &&
    left.state.lastLiveChildId === right.state.lastLiveChildId &&
    left.state.nextSiblingIndex === right.state.nextSiblingIndex &&
    sameStringSet(left.removedMessageIds, right.removedMessageIds) &&
    sameChildSlotMemberSet(left.upserts, right.upserts)
  )
}

function sameChildSlotMember(left: ChildSlotMember, right: ChildSlotMember): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.parentId === right.parentId &&
    left.parentKey === right.parentKey &&
    left.position === right.position &&
    left.previousMessageId === right.previousMessageId &&
    left.nextMessageId === right.nextMessageId
  )
}

function sameChildListState(left: ChildListState, right: ChildListState): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.parentId === right.parentId &&
    left.version === right.version &&
    left.updatedAt === right.updatedAt &&
    left.liveCount === right.liveCount &&
    left.firstLiveChildId === right.firstLiveChildId &&
    left.lastLiveChildId === right.lastLiveChildId &&
    left.nextSiblingIndex === right.nextSiblingIndex
  )
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const values = new Set(left)
  return values.size === right.length && right.every((value) => values.has(value))
}

function sameChildSlotMemberSet(
  left: readonly ChildSlotMember[],
  right: readonly ChildSlotMember[],
): boolean {
  if (left.length !== right.length) return false
  const byId = new Map(left.map((member) => [member.id, member]))
  return right.every((member) => {
    const current = byId.get(member.id)
    return Boolean(
      current &&
        current.chatId === member.chatId &&
        current.parentId === member.parentId &&
        current.parentKey === member.parentKey &&
        current.position === member.position &&
        current.previousMessageId === member.previousMessageId &&
        current.nextMessageId === member.nextMessageId,
    )
  })
}

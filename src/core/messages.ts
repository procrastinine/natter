import { newId } from '../lib/ulid'
import {
  type ActiveBranchChildSlot,
  type ActiveBranchForkSlot,
  type ActiveBranchSelection,
  createActiveBranchSpine,
  createActiveBranchSpineFromPath,
  type VersionedActiveBranchSpine,
} from './active-branch-spine'
import { attachmentRefsFromIds, liveAttachmentRefs } from './attachment-refs'
import { type BranchPathDescriptor, readLiveBranchPath } from './branch-session'
import type { TokenCalibrationMode } from './global-settings'
import {
  type MessageBodyAuthoringOperations,
  type ProviderOutputAuthoringOperation,
  preserveProviderSealedFields,
  providerOutputItemEquals,
  type ReasoningAuthoringOperation,
} from './message-body-authoring'
import type { MessageTreeIndexFields } from './message-tree-index'
import type { MessageContextRouteFacts } from './reasoning'
import {
  reasoningCarrierDescriptorEquals,
  reasoningCarrierDescriptorFromCarrier,
  reasoningVisiblePartEquals,
} from './reasoning-envelope'
import { calibrationFieldsForEdit } from './token-calibration'
import {
  cascadeSoftDelete,
  createAncestorOutsideSetResolver,
  softDeleteWithSplice,
  TreeChangedError,
} from './tree-ops'
import type {
  AttachmentId,
  AttachmentRef,
  Chat,
  ChatId,
  ChatVersions,
  ChildListState,
  ChildSlotMember,
  ContentItem,
  GlobalTokenCalibration,
  Message,
  MessageId,
  MessageRole,
  MutationScope,
  ProviderOutputItem,
  ProviderOutputMemberRef,
  ReasoningMemberRef,
  ReasoningVisiblePartV2,
} from './types'

type MessageBodyKey =
  | 'content'
  | 'reasoningEnvelope'
  | 'toolCalls'
  | 'refusal'
  | 'phase'
  | 'providerOutputItems'
  | 'continuationAttempts'

export type MessageHeaderRow = Omit<Message, MessageBodyKey> & {
  requestContextVersion: number
  bodyVersion: number
  bodyWordCount: number
  bodyTextCharCount: number
  bodyMediaCount: number
  bodyRenderCost: number
  contextRouteFacts: MessageContextRouteFacts
} & MessageTreeIndexFields

export interface MessagePresentation {
  readonly header: MessageHeaderRow
  readonly message: Message
  readonly bodyVersion: number
}

export interface MessageMutationContext {
  getMessage(messageId: MessageId): Promise<Message | undefined>
  getMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined>
  getMessageHeaders(messageIds: readonly MessageId[]): Promise<Array<MessageHeaderRow | undefined>>
  listMessageHeaders(chatId: ChatId): Promise<MessageHeaderRow[]>
  listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<MessageHeaderRow[]>
  getChildList(chatId: ChatId, parentId: MessageId | null): Promise<ChildListState>
  getChildLists(chatId: ChatId, parentIds: readonly (MessageId | null)[]): Promise<ChildListState[]>
  getChildSlotMembers(messageIds: readonly MessageId[]): Promise<Array<ChildSlotMember | undefined>>
  putMessage(
    message: Message,
    options?: {
      readonly touchChatSummary?: boolean
      readonly creationTimestamp?: 'preserve'
    },
  ): Promise<Message>
  patchMessageStructure(
    messageId: MessageId,
    patch: Partial<Pick<MessageHeaderRow, 'deleted' | 'parentId' | 'siblingIndex'>>,
  ): Promise<void>
}

export interface MessageMutationFinalizationContext {
  getFinalChat(chatId: ChatId): Promise<Chat | undefined>
  sealCommittedDestination(input: {
    readonly chat: Chat
    readonly tipId: MessageId | null
    readonly presentations?: readonly MessagePresentation[]
  }): Promise<ConversationProvedSelection>
}

interface MessageMutationResult<T> {
  value: T
  chatVersions: Record<ChatId, ChatVersions>
}

export interface ConversationPathProofIdentity {
  readonly chatId: ChatId
  readonly structuralVersion: number
  readonly tipId: MessageId | null
}

export interface ConversationPathProof extends ConversationPathProofIdentity {
  readonly pathHeaders: readonly MessageHeaderRow[]
}

export type ConversationSelectionProofTarget =
  | {
      readonly kind: 'resolve-selection'
      readonly selection: ActiveBranchSelection
    }
  | {
      readonly kind: 'fixed-tip'
      readonly selection: ActiveBranchSelection
      readonly messageId: MessageId
    }
  | {
      readonly kind: 'fixed-empty'
      readonly selection: ActiveBranchSelection
    }

export function resolvingConversationSelectionTarget(
  selection: ActiveBranchSelection,
): ConversationSelectionProofTarget {
  return Object.freeze({
    kind: 'resolve-selection',
    selection: Object.freeze({ ...selection }),
  })
}

export function fixedConversationSelectionTarget(
  selection: ActiveBranchSelection,
  tipId: MessageId | null,
): ConversationSelectionProofTarget {
  return tipId === null
    ? Object.freeze({
        kind: 'fixed-empty',
        selection: Object.freeze({ ...selection }),
      })
    : Object.freeze({
        kind: 'fixed-tip',
        selection: Object.freeze({ ...selection }),
        messageId: tipId,
      })
}

export interface ConversationSelectionFrame {
  readonly kind: 'ready'
  readonly chat: Chat
  readonly target: ConversationSelectionProofTarget
  readonly proof: ConversationPathProofIdentity
  readonly presentations: readonly MessagePresentation[]
  readonly forks: readonly ActiveBranchForkSlot[]
  readonly terminalChildSlot: ActiveBranchChildSlot
}

export interface ConversationProvedSelection extends ConversationSelectionFrame {
  readonly proof: ConversationPathProof
}

export interface ConversationAppendSelectionTransition {
  readonly kind: 'append-transition'
  readonly chat: Chat
  readonly target: ConversationSelectionProofTarget
  readonly proof: ConversationPathProofIdentity
  readonly base: ConversationPathProofIdentity
  readonly suffixHeaders: readonly MessageHeaderRow[]
  readonly forks: readonly ActiveBranchForkSlot[]
  readonly terminalChildSlot: ActiveBranchChildSlot
  readonly presentations: readonly MessagePresentation[]
  readonly fallback: {
    readonly prefixHeaders: readonly MessageHeaderRow[]
    readonly finalHeader: MessageHeaderRow
  }
}

export type ConversationDestinationPoint =
  | {
      readonly kind: 'empty-point'
      readonly chat: Chat
      readonly target: ConversationSelectionProofTarget
      readonly structuralVersion: number
    }
  | {
      readonly kind: 'tip-point'
      readonly chat: Chat
      readonly target: ConversationSelectionProofTarget
      readonly structuralVersion: number
      readonly presentation: MessagePresentation
    }

export type ConversationDestinationHeaderPoint =
  | Extract<ConversationDestinationPoint, { readonly kind: 'empty-point' }>
  | {
      readonly kind: 'tip-header-point'
      readonly chat: Chat
      readonly target: ConversationSelectionProofTarget
      readonly structuralVersion: number
      readonly header: MessageHeaderRow
    }

const SEALED_CONVERSATION_SELECTION = Symbol('sealed-conversation-selection')

export interface SealedConversationSelection extends ConversationSelectionFrame {
  readonly [SEALED_CONVERSATION_SELECTION]: true
  readonly spine: VersionedActiveBranchSpine<MessageHeaderRow>
}

export function sealConversationSelection(
  selection: ConversationSelectionFrame,
  acceptedPath?: BranchPathDescriptor<MessageHeaderRow>,
  acceptedForks?: Iterable<ActiveBranchForkSlot>,
): SealedConversationSelection {
  const proof = selection.proof
  if (
    selection.chat.id !== proof.chatId ||
    selection.chat.structuralVersion !== proof.structuralVersion ||
    (selection.target.kind === 'fixed-tip' && selection.target.messageId !== proof.tipId) ||
    (selection.target.kind === 'fixed-empty' && proof.tipId !== null) ||
    (selection.target.selection.kind === 'tip' &&
      selection.target.selection.messageId !== proof.tipId)
  ) {
    throw new Error(`ConversationProvedSelectionMismatch:${selection.chat.id}`)
  }
  let spine: VersionedActiveBranchSpine<MessageHeaderRow>
  if (acceptedPath) {
    spine = createActiveBranchSpineFromPath({
      chatId: proof.chatId,
      structuralVersion: proof.structuralVersion,
      resolvedLeafId: proof.tipId,
      path: acceptedPath,
      terminalChildSlot: selection.terminalChildSlot,
    })
  } else if (SEALED_CONVERSATION_SELECTION in selection) {
    spine = (selection as SealedConversationSelection).spine
  } else {
    const pathHeaders = (proof as ConversationPathProof).pathHeaders
    spine = createActiveBranchSpine({
      chatId: proof.chatId,
      structuralVersion: proof.structuralVersion,
      resolvedLeafId: proof.tipId,
      headers: pathHeaders,
      terminalChildSlot: selection.terminalChildSlot,
    })
  }
  const forks: Iterable<ActiveBranchForkSlot> = acceptedForks ?? selection.forks
  spine = spine.replaceForks(forks)
  for (const presentation of selection.presentations) {
    const header = spine.path.get(presentation.header.id)
    if (
      !header ||
      presentation.header.chatId !== proof.chatId ||
      presentation.message.chatId !== proof.chatId ||
      presentation.header.id !== presentation.message.id ||
      presentation.header.nodeVersion !== header.nodeVersion ||
      presentation.header.bodyVersion !== header.bodyVersion ||
      presentation.bodyVersion !== header.bodyVersion
    ) {
      throw new Error(`ConversationSelectionPresentationInvalid:${presentation.header.id}`)
    }
  }
  return Object.freeze({
    kind: 'ready',
    chat: selection.chat,
    target: selection.target,
    proof: Object.freeze({
      chatId: proof.chatId,
      structuralVersion: proof.structuralVersion,
      tipId: proof.tipId,
    }),
    presentations: selection.presentations,
    forks: Object.freeze([...spine.forkSlots()]),
    terminalChildSlot: spine.terminalChildSlot,
    [SEALED_CONVERSATION_SELECTION]: true as const,
    spine,
  })
}

export type StructuralSnapshotRow = Pick<
  Message,
  'attachmentRefs' | 'chatId' | 'deleted' | 'id' | 'nodeVersion' | 'parentId' | 'siblingIndex'
>

type StructuralSnapshotExpectedRow = Pick<
  MessageHeaderRow,
  'id' | 'parentId' | 'siblingIndex' | 'deleted' | 'requestContextVersion'
>

export interface StructuralSnapshot {
  chatId: ChatId
  selectedTipId: MessageId | null
  previousRows: StructuralSnapshotRow[]
  newMessageIds: MessageId[]
  attachmentIds: AttachmentId[]
  expectedRows?: StructuralSnapshotExpectedRow[]
}

export interface StructuralEffects {
  newMessageIds: MessageId[]
  tombstoned: MessageId[]
  reparented: Array<{
    id: MessageId
    previousParentId: MessageId | null
    newParentId: MessageId | null
  }>
}

export interface DeleteResult {
  destination: ConversationProvedSelection
  effects: StructuralEffects
  versions: ChatVersions
  preImage: StructuralSnapshot
  structuralHeaders: MessageHeaderRow[]
}

export interface MessageMutationRepository {
  readStructurePreflight<T>(
    read: (reader: MessageStructurePreflightReader) => Promise<T> | T,
  ): Promise<T>
  readEditPreflight<T>(read: (reader: MessageEditPreflightReader) => Promise<T> | T): Promise<T>
  runMutation<T, U = T>(
    scopes: MutationScope[],
    fn: (ctx: MessageMutationContext) => Promise<T> | T,
    finalize?: (ctx: MessageMutationFinalizationContext, value: T) => Promise<U> | U,
  ): Promise<MessageMutationResult<U>>
}

export type MessageBodyMutationInput =
  | {
      kind: 'message.toggle-reasoning-detail'
      chatId: ChatId
      messageId: MessageId
      member: ReasoningMemberRef
    }
  | {
      kind: 'message.toggle-provider-output-item'
      chatId: ChatId
      messageId: MessageId
      member: ProviderOutputMemberRef
    }
  | { kind: 'message.toggle-context'; chatId: ChatId; messageId: MessageId }
  | { kind: 'message.dismiss-generation-notice'; chatId: ChatId; messageId: MessageId }

export interface MessageBodyMutationCapability {
  readonly access: 'presentation'
  readonly replayReason: 'unfenced-relative-update' | 'non-replayable'
  readonly summary: 'preserves' | 'updates'
}

export function messageBodyMutationCapability(
  input: MessageBodyMutationInput,
): MessageBodyMutationCapability {
  switch (input.kind) {
    case 'message.toggle-reasoning-detail':
    case 'message.toggle-provider-output-item':
    case 'message.toggle-context':
      return {
        access: 'presentation',
        replayReason: 'unfenced-relative-update',
        summary: 'preserves',
      }
    case 'message.dismiss-generation-notice':
      return { access: 'presentation', replayReason: 'non-replayable', summary: 'preserves' }
  }
}

const ZERO_VERSIONS: ChatVersions = {
  metaVersion: 0,
  summaryVersion: 0,
  structuralVersion: 0,
}

function emptyEffects(): StructuralEffects {
  return {
    newMessageIds: [],
    tombstoned: [],
    reparented: [],
  }
}

function versionsFor<T>(result: MessageMutationResult<T>, chatId: ChatId): ChatVersions {
  return result.chatVersions[chatId] ?? ZERO_VERSIONS
}

function messageScope(
  messageId: MessageId,
  access?: Extract<MutationScope, { kind: 'message' }>['access'],
): MutationScope {
  return { kind: 'message', messageId, ...(access ? { access } : {}) }
}

function childrenScope(chatId: ChatId, parentId: MessageId | null): MutationScope {
  return { kind: 'children', chatId, parentId }
}

function attachmentIdScopes(ids: readonly AttachmentId[] | undefined): MutationScope[] {
  return [...new Set(ids ?? [])].map((attachmentId) => ({ kind: 'attachment', attachmentId }))
}

function attachmentScopes(refs: readonly AttachmentRef[] | undefined): MutationScope[] {
  return attachmentIdScopes(liveAttachmentRefs(refs).map((ref) => ref.attachmentId))
}

function dedupeScopes(scopes: readonly MutationScope[]): MutationScope[] {
  const seen = new Set<string>()
  const out: MutationScope[] = []
  for (const scope of scopes) {
    const key =
      scope.kind === 'message'
        ? `message:${scope.messageId}`
        : scope.kind === 'chat-topology'
          ? `message-topology:${scope.chatId}`
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

function compareExistingSiblingOrder(left: MessageTreeRow, right: MessageTreeRow): number {
  return (
    left.siblingIndex - right.siblingIndex ||
    left.createdAt - right.createdAt ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  )
}

function nextSiblingIndexFromChildren(children: readonly Pick<Message, 'siblingIndex'>[]): number {
  let max = -1
  for (const child of children) {
    if (child.siblingIndex > max) max = child.siblingIndex
  }
  return max + 1
}

export interface MessageHeaderReader {
  getMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined>
  listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<MessageHeaderRow[]>
}

export interface MessageStructurePreflightReader extends MessageHeaderReader {
  getMessageHeaders(messageIds: readonly MessageId[]): Promise<Array<MessageHeaderRow | undefined>>
}

export interface MessageEditPreflightReader extends MessageStructurePreflightReader {
  getChat(chatId: ChatId): Promise<Chat | undefined>
  getSettings(keys: readonly string[]): Promise<ReadonlyMap<string, unknown>>
}

function sameHeaderIds(
  left: readonly Pick<MessageHeaderRow, 'id'>[],
  right: readonly Pick<MessageHeaderRow, 'id'>[],
): boolean {
  return (
    left.length === right.length && left.every((header, index) => header.id === right[index]?.id)
  )
}

function sameHeaderIdList(
  headers: readonly Pick<MessageHeaderRow, 'id'>[],
  expectedIds: readonly MessageId[],
): boolean {
  return (
    headers.length === expectedIds.length &&
    headers.every((header, index) => header.id === expectedIds[index])
  )
}

function liveChildrenSorted(headers: readonly MessageHeaderRow[]): MessageHeaderRow[] {
  return headers.filter((header) => !header.deleted).sort(compareExistingSiblingOrder)
}

async function readMutationBranchPath(
  reader: Pick<MessageHeaderReader, 'getMessageHeader'>,
  chatId: ChatId,
  leafId: MessageId | null,
): Promise<MessageHeaderRow[]> {
  const result = await readLiveBranchPath({
    chatId,
    leafId,
    getHeader: (messageId) => reader.getMessageHeader(messageId),
  })
  if (result.kind === 'unavailable') {
    throw new TreeChangedError(chatId, `branch leaf ${leafId} unavailable:${result.reason}`)
  }
  return [...result.rows]
}

function sameStructuralPath(
  left: readonly MessageHeaderRow[],
  right: readonly MessageHeaderRow[],
): boolean {
  return (
    left.length === right.length &&
    left.every((header, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        header.id === other.id &&
        header.parentId === other.parentId &&
        header.siblingIndex === other.siblingIndex &&
        header.nodeVersion === other.nodeVersion &&
        header.deleted === other.deleted
      )
    })
  )
}

function collectInsertBetweenScopes(
  chatId: ChatId,
  child: MessageTreeRow,
  siblings: readonly MessageTreeRow[],
  newMessageId: MessageId,
): MutationScope[] {
  if (child.deleted) {
    throw new TreeChangedError(chatId, `insert-between child ${child.id} unavailable`)
  }
  const parentId = child.parentId
  const scopes: MutationScope[] = [
    messageScope(child.id),
    messageScope(newMessageId),
    childrenScope(chatId, parentId),
    childrenScope(chatId, newMessageId),
  ]
  if (parentId !== null) scopes.push(messageScope(parentId))
  const peers = siblings.filter((sibling) => !sibling.deleted && sibling.turnId === child.turnId)
  for (const peer of peers) scopes.push(messageScope(peer.id))
  return dedupeScopes(scopes)
}

interface DeleteMutationPlan {
  readonly scopes: MutationScope[]
  readonly candidateIds: MessageId[]
  readonly expectedChildIdsByParent: ReadonlyMap<MessageId | null, readonly MessageId[]>
}

async function planDeleteMutation(
  reader: MessageHeaderReader,
  chatId: ChatId,
  members: readonly MessageTreeRow[],
  cascade: boolean,
): Promise<DeleteMutationPlan> {
  const membersById = new Map(members.map((message) => [message.id, message]))
  const idsToDelete = new Set(
    members.filter((member) => !member.deleted).map((member) => member.id),
  )
  const expectedChildIdsByParent = new Map<MessageId | null, readonly MessageId[]>()
  const childrenByParent = new Map<MessageId | null, MessageHeaderRow[]>()
  const readChildren = async (parentId: MessageId | null): Promise<MessageHeaderRow[]> => {
    const known = childrenByParent.get(parentId)
    if (known) return known
    const children = await reader.listChildHeaders(chatId, parentId)
    childrenByParent.set(parentId, children)
    expectedChildIdsByParent.set(
      parentId,
      children.map((child) => child.id),
    )
    return children
  }

  if (cascade) {
    const stack = [...idsToDelete]
    while (stack.length > 0) {
      const id = stack.pop() as MessageId
      for (const kid of await readChildren(id)) {
        if (kid.chatId !== chatId) {
          throw new TreeChangedError(chatId, `delete descendant ${kid.id} unavailable`)
        }
        if (idsToDelete.has(kid.id)) continue
        idsToDelete.add(kid.id)
        membersById.set(kid.id, kid)
        stack.push(kid.id)
      }
    }
  }
  const scopes: MutationScope[] = []
  const affectedNewParents = new Set<MessageId | null>()
  const firstLiveAncestor = createAncestorOutsideSetResolver(membersById, idsToDelete)

  for (const member of membersById.values()) {
    if (!idsToDelete.has(member.id)) continue
    if (member.deleted) continue
    await readChildren(member.parentId)
    scopes.push(messageScope(member.id))
    scopes.push(childrenScope(chatId, member.parentId))
    if (cascade) continue
    scopes.push(childrenScope(chatId, member.id))
    const directKids = (await readChildren(member.id)).filter((kid) => !kid.deleted)
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
      const siblings = await readChildren(parentId)
      for (const sibling of siblings) {
        scopes.push(messageScope(sibling.id))
      }
    }
  }

  const deduped = dedupeScopes(scopes)
  return {
    scopes: deduped,
    candidateIds: deleteCandidateIds(deduped),
    expectedChildIdsByParent,
  }
}

async function applyDelete(
  ctx: MessageMutationContext,
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

function deleteCandidateIds(scopes: readonly MutationScope[]): MessageId[] {
  const ids = new Set<MessageId>()
  for (const scope of scopes) {
    if (scope.kind === 'message') ids.add(scope.messageId)
  }
  return [...ids]
}

function structuralFieldsChanged(before: MessageTreeRow, after: MessageTreeRow): boolean {
  return (
    before.deleted !== after.deleted ||
    before.parentId !== after.parentId ||
    before.siblingIndex !== after.siblingIndex
  )
}

function attachmentIdsFromRows(
  rows: readonly Pick<MessageHeaderRow, 'attachmentRefs'>[],
): AttachmentId[] {
  const ids = new Set<AttachmentId>()
  for (const row of rows) {
    for (const ref of row.attachmentRefs ?? []) {
      if (ref.deletedAt === undefined) ids.add(ref.attachmentId)
    }
  }
  return [...ids]
}

async function executeDeleteMutation(
  repo: MessageMutationRepository,
  input: DeleteInput,
  members: readonly MessageTreeRow[],
  plan: DeleteMutationPlan,
  activeBranchBefore: readonly MessageHeaderRow[],
): Promise<DeleteResult> {
  const { candidateIds, scopes } = plan
  const requiredLiveIds = new Set(
    members.filter((member) => !member.deleted).map((member) => member.id),
  )
  type DeleteMutationValue = {
    effects: StructuralEffects
    preImage: StructuralSnapshot
    structuralHeaders: MessageHeaderRow[]
    selectionTipId: MessageId | null
  }
  type DeleteMutationCommittedValue = DeleteMutationValue & {
    destination: ConversationProvedSelection
  }
  const result = await repo.runMutation<DeleteMutationValue, DeleteMutationCommittedValue>(
    scopes,
    async (ctx) => {
      const activeBranch = await readMutationBranchPath(ctx, input.chatId, input.activeLeafId)
      if (!sameStructuralPath(activeBranchBefore, activeBranch)) {
        throw new TreeChangedError(input.chatId, 'delete active branch changed')
      }
      for (const [parentId, expectedIds] of plan.expectedChildIdsByParent) {
        const children = await ctx.listChildHeaders(input.chatId, parentId)
        if (!sameHeaderIdList(children, expectedIds)) {
          throw new TreeChangedError(
            input.chatId,
            `delete children of ${parentId ?? 'root'} changed`,
          )
        }
      }
      const beforeById = new Map<MessageId, MessageHeaderRow>()
      const beforeRows = await ctx.getMessageHeaders(candidateIds)
      for (let index = 0; index < candidateIds.length; index += 1) {
        const id = candidateIds[index] as MessageId
        const row = beforeRows[index]
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

      const changedBeforeRows: MessageHeaderRow[] = []
      const changedAfterRows: MessageHeaderRow[] = []
      const tombstoned: MessageId[] = []
      const reparented: StructuralEffects['reparented'] = []
      const afterRows = await ctx.getMessageHeaders(candidateIds)
      for (let index = 0; index < candidateIds.length; index += 1) {
        const id = candidateIds[index] as MessageId
        const before = beforeById.get(id) as MessageHeaderRow
        const after = afterRows[index]
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

      const preImage: StructuralSnapshot = {
        chatId: input.chatId,
        selectedTipId: input.activeLeafId,
        previousRows: changedBeforeRows,
        newMessageIds: [],
        attachmentIds: attachmentIdsFromRows([...changedBeforeRows, ...changedAfterRows]),
        expectedRows: changedAfterRows.map((row) => ({
          id: row.id,
          parentId: row.parentId,
          siblingIndex: row.siblingIndex,
          deleted: row.deleted,
          requestContextVersion: row.requestContextVersion,
        })),
      }
      let selectionTipId: MessageId | null = null
      for (let index = activeBranch.length - 1; index >= 0; index -= 1) {
        const header = activeBranch[index] as MessageHeaderRow
        if (actualTombstoned.has(header.id)) continue
        selectionTipId = header.id
        break
      }
      return {
        effects,
        preImage,
        structuralHeaders: changedAfterRows,
        selectionTipId,
      }
    },
    async (ctx, value) => {
      const chat = await ctx.getFinalChat(input.chatId)
      if (!chat) throw new TreeChangedError(input.chatId, 'committed chat unavailable')
      const destination = await ctx.sealCommittedDestination({
        chat,
        tipId: value.selectionTipId,
      })
      return {
        ...value,
        destination,
      }
    },
  )
  return {
    destination: result.value.destination,
    effects: result.value.effects,
    versions: versionsFor(result, input.chatId),
    preImage: result.value.preImage,
    structuralHeaders: result.value.structuralHeaders,
  }
}

export interface EditMessageBodyInput {
  chatId: ChatId
  messageId: MessageId
  content?: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  authoring?: MessageBodyAuthoringOperations
  now?: number
}

export interface EditMessageBodyResult {
  versions: ChatVersions
  message: Message
  header: MessageHeaderRow
}

export interface EditMessageCalibrationSnapshot {
  global: GlobalTokenCalibration
  mode: TokenCalibrationMode
}

export async function editMessageBodyInRepository(
  repo: MessageMutationRepository,
  input: EditMessageBodyInput,
  readCalibration: (reader: MessageEditPreflightReader) => Promise<EditMessageCalibrationSnapshot>,
): Promise<EditMessageBodyResult> {
  const now = input.now ?? Date.now()
  const { target, chatForRatio, calibration } = await repo.readEditPreflight(async (reader) => {
    const [target, chatForRatio, calibration] = await Promise.all([
      reader.getMessageHeader(input.messageId),
      reader.getChat(input.chatId),
      readCalibration(reader),
    ])
    if (!target || target.chatId !== input.chatId || target.deleted) {
      throw new TreeChangedError(input.chatId, `edit target ${input.messageId} unavailable`)
    }
    return { target, chatForRatio, calibration }
  })
  const currentModelId = chatForRatio?.settings.model ?? ''
  const calibrationPatch =
    currentModelId && input.content
      ? calibrationFieldsForEdit(
          input.content,
          target.originalCharCount,
          target.originalModelId,
          target.originalCalibrationKey,
          currentModelId,
          chatForRatio,
          calibration.global,
          calibration.mode,
        )
      : null
  const result = await repo.runMutation(
    dedupeScopes([
      messageScope(input.messageId),
      ...attachmentScopes(target.attachmentRefs),
      ...attachmentScopes(input.attachmentRefs),
    ]),
    async (ctx) => {
      const [current, currentHeader] = await Promise.all([
        ctx.getMessage(input.messageId),
        ctx.getMessageHeader(input.messageId),
      ])
      if (!current || !currentHeader || current.chatId !== input.chatId || current.deleted) {
        throw new TreeChangedError(input.chatId, `edit target ${input.messageId} unavailable`)
      }
      if (
        currentHeader.nodeVersion !== target.nodeVersion ||
        currentHeader.bodyVersion !== target.bodyVersion ||
        currentHeader.requestContextVersion !== target.requestContextVersion
      ) {
        throw new TreeChangedError(input.chatId, `edit target ${input.messageId} changed`)
      }
      let next: Message = {
        ...current,
        content: input.content ? structuredClone(input.content) : current.content,
        editedAt: now,
        ...(calibrationPatch ?? {}),
      }
      if (input.authoring?.reasoning && input.authoring.reasoning.length > 0) {
        next = applyReasoningAuthoringOperations(next, input.authoring.reasoning)
      }
      if (input.authoring?.providerOutput && input.authoring.providerOutput.length > 0) {
        next = applyProviderOutputAuthoringOperations(next, input.authoring.providerOutput)
      }
      if (input.attachmentRefs !== undefined) {
        if (input.attachmentRefs.length > 0) {
          const withRefs = withAttachmentRefs({}, input.attachmentRefs, now, current.attachmentRefs)
          if (withRefs.attachmentRefs) next.attachmentRefs = withRefs.attachmentRefs
        } else if (contentHasAttachmentIds(next.content)) {
          next.attachmentRefs = []
        } else delete next.attachmentRefs
      }
      const message = await ctx.putMessage(next, {
        touchChatSummary: input.content !== undefined,
      })
      const header = await ctx.getMessageHeader(input.messageId)
      if (!header) throw new Error(`EditMessagePresentationMissing:${input.messageId}`)
      return { message, header }
    },
  )
  return { ...result.value, versions: versionsFor(result, input.chatId) }
}

function applyReasoningAuthoringOperations(
  message: Message,
  operations: readonly ReasoningAuthoringOperation[],
): Message {
  let next = message
  for (const operation of operations) {
    const owner = 'owner' in operation ? operation.owner : operation.member.owner
    const updated = mutateOwnedReasoningEnvelopeForAuthoring(next, owner, (envelope) => {
      switch (operation.kind) {
        case 'visible-create': {
          if (
            envelope.visible.some((part) => part.id === operation.part.id) ||
            envelope.carriers.some((carrier) => carrier.id === operation.part.id)
          ) {
            throw new TreeChangedError(
              message.chatId,
              `reasoning member ${operation.part.id} exists`,
            )
          }
          return {
            ...envelope,
            visible: [...envelope.visible, structuredClone(operation.part)],
          }
        }
        case 'visible-replace': {
          const index = envelope.visible.findIndex((part) => part.id === operation.member.id)
          const current = envelope.visible[index]
          if (!current || !reasoningVisiblePartEquals(current, operation.expected)) {
            throw new TreeChangedError(
              message.chatId,
              `reasoning member ${operation.member.id} changed`,
            )
          }
          const { hidden: _expectedHidden, ...expectedWithoutHidden } = operation.expected
          const allowedNext: ReasoningVisiblePartV2 = {
            ...expectedWithoutHidden,
            kind: operation.next.kind,
            text: operation.next.text,
            ...(operation.next.hidden !== undefined ? { hidden: operation.next.hidden } : {}),
          }
          if (!reasoningVisiblePartEquals(allowedNext, operation.next)) {
            throw new Error(`ReasoningVisibleAuthoringMetadataChanged:${operation.member.id}`)
          }
          const visible = [...envelope.visible]
          visible[index] = structuredClone(operation.next)
          const invalidatesBinding =
            operation.expected.text !== operation.next.text ||
            operation.expected.kind !== operation.next.kind
          const carriers = invalidatesBinding
            ? envelope.carriers.filter(
                (carrier) =>
                  !(
                    (carrier.kind === 'anthropic-signature' ||
                      carrier.kind === 'gemini-thought-signature') &&
                    carrier.bindsVisiblePartId === operation.member.id
                  ),
              )
            : envelope.carriers
          return { ...envelope, visible, carriers }
        }
        case 'visible-delete': {
          const index = envelope.visible.findIndex((part) => part.id === operation.member.id)
          const current = envelope.visible[index]
          if (!current || !reasoningVisiblePartEquals(current, operation.expected)) {
            throw new TreeChangedError(
              message.chatId,
              `reasoning member ${operation.member.id} changed`,
            )
          }
          return {
            ...envelope,
            visible: envelope.visible.filter((_, candidateIndex) => candidateIndex !== index),
            carriers: envelope.carriers.filter(
              (carrier) =>
                !(
                  (carrier.kind === 'anthropic-signature' ||
                    carrier.kind === 'gemini-thought-signature') &&
                  carrier.bindsVisiblePartId === operation.member.id
                ),
            ),
          }
        }
        case 'carrier-set-hidden':
        case 'carrier-delete': {
          const index = envelope.carriers.findIndex((carrier) => carrier.id === operation.member.id)
          const current = envelope.carriers[index]
          if (
            !current ||
            !reasoningCarrierDescriptorEquals(
              reasoningCarrierDescriptorFromCarrier(current),
              operation.expected,
            )
          ) {
            throw new TreeChangedError(
              message.chatId,
              `reasoning carrier ${operation.member.id} changed`,
            )
          }
          if (operation.kind === 'carrier-delete') {
            return {
              ...envelope,
              carriers: envelope.carriers.filter((_, candidateIndex) => candidateIndex !== index),
            }
          }
          const carriers = [...envelope.carriers]
          if (operation.hidden) carriers[index] = { ...current, hidden: true }
          else {
            const { hidden: _hidden, ...shown } = current
            carriers[index] = shown
          }
          return { ...envelope, carriers }
        }
      }
    })
    if (!updated) {
      throw new TreeChangedError(message.chatId, 'reasoning attempt owner unavailable')
    }
    next = updated
  }
  return next
}

function mutateOwnedReasoningEnvelopeForAuthoring(
  message: Message,
  owner: ReasoningMemberRef['owner'],
  mutate: (
    envelope: NonNullable<Message['reasoningEnvelope']>,
  ) => NonNullable<Message['reasoningEnvelope']>,
): Message | undefined {
  if (owner.kind === 'generation') {
    const reasoningEnvelope = mutate(
      message.reasoningEnvelope ?? { schemaVersion: 2, visible: [], carriers: [] },
    )
    return { ...message, reasoningEnvelope }
  }
  const attempts = message.continuationAttempts
  const attemptIndex = attempts?.findIndex(
    (attempt) => attempt.application.kind === 'applied' && attempt.streamId === owner.streamId,
  )
  if (!attempts || attemptIndex === undefined || attemptIndex < 0) return undefined
  const attempt = attempts[attemptIndex]
  if (!attempt) return undefined
  const reasoningEnvelope = mutate(
    attempt.reasoningEnvelope ?? { schemaVersion: 2, visible: [], carriers: [] },
  )
  const nextAttempts = [...attempts]
  nextAttempts[attemptIndex] = { ...attempt, reasoningEnvelope }
  return { ...message, continuationAttempts: nextAttempts }
}

function applyProviderOutputAuthoringOperations(
  message: Message,
  operations: readonly ProviderOutputAuthoringOperation[],
): Message {
  let next = message
  for (const operation of operations) {
    const owner = 'owner' in operation ? operation.owner : operation.member.owner
    const updated = mutateOwnedProviderOutputForAuthoring(next, owner, (items) => {
      if (operation.kind === 'provider-output-create') {
        return [...items, structuredClone({ ...operation.item, edited: true })]
      }
      const index = locateProviderOutputMember(
        message.chatId,
        items,
        operation.member,
        operation.expected,
      )
      if (operation.kind === 'provider-output-delete') {
        return items.filter((_, candidateIndex) => candidateIndex !== index)
      }
      const sealedItem = preserveProviderSealedFields(operation.expected.item, operation.next.item)
      if (!providerOutputItemEquals({ ...operation.next, item: sealedItem }, operation.next)) {
        throw new Error(`ProviderOutputSealedFieldChanged:${operation.member.itemIndex}`)
      }
      const replaced = [...items]
      replaced[index] = structuredClone(operation.next)
      return replaced
    })
    if (!updated) {
      throw new TreeChangedError(message.chatId, 'provider output attempt owner unavailable')
    }
    next = updated
  }
  return next
}

function locateProviderOutputMember(
  chatId: ChatId,
  items: readonly ProviderOutputItem[],
  member: ProviderOutputMemberRef,
  expected: ProviderOutputItem,
): number {
  const direct = items[member.itemIndex]
  if (direct && providerOutputItemEquals(direct, expected)) return member.itemIndex
  const matches: number[] = []
  for (const [index, item] of items.entries()) {
    if (providerOutputItemEquals(item, expected)) matches.push(index)
  }
  if (matches.length === 1) return matches[0] as number
  throw new TreeChangedError(chatId, `provider output member ${member.itemIndex} changed`)
}

function mutateOwnedProviderOutputForAuthoring(
  message: Message,
  owner: ProviderOutputMemberRef['owner'],
  mutate: (items: readonly ProviderOutputItem[]) => ProviderOutputItem[],
): Message | undefined {
  if (owner.kind === 'generation') {
    const providerOutputItems = mutate(message.providerOutputItems ?? [])
    if (providerOutputItems.length > 0) return { ...message, providerOutputItems }
    const { providerOutputItems: _providerOutputItems, ...withoutItems } = message
    return withoutItems
  }
  const attempts = message.continuationAttempts
  const attemptIndex = attempts?.findIndex(
    (attempt) => attempt.application.kind === 'applied' && attempt.streamId === owner.streamId,
  )
  if (!attempts || attemptIndex === undefined || attemptIndex < 0) return undefined
  const attempt = attempts[attemptIndex]
  if (!attempt) return undefined
  const providerOutputItems = mutate(attempt.providerOutputItems ?? [])
  const nextAttempt: typeof attempt = { ...attempt }
  if (providerOutputItems.length > 0) nextAttempt.providerOutputItems = providerOutputItems
  else delete nextAttempt.providerOutputItems
  const nextAttempts = [...attempts]
  nextAttempts[attemptIndex] = nextAttempt
  return { ...message, continuationAttempts: nextAttempts }
}

export async function mutateMessageBodyInRepository(
  repo: MessageMutationRepository,
  input: MessageBodyMutationInput,
): Promise<MessagePresentation | undefined> {
  const capability = messageBodyMutationCapability(input)
  const result = await repo.runMutation(
    [messageScope(input.messageId, capability.access)],
    async (ctx) => {
      const current = await ctx.getMessage(input.messageId)
      if (!current || current.chatId !== input.chatId || current.deleted) return undefined

      let next: Message | undefined
      switch (input.kind) {
        case 'message.toggle-reasoning-detail': {
          next = mutateOwnedReasoningEnvelope(current, input.member.owner, (envelope) =>
            toggleReasoningMember(envelope, input.member),
          )
          if (!next) return undefined
          break
        }
        case 'message.toggle-provider-output-item': {
          if (input.member.owner.kind === 'generation') {
            const items = current.providerOutputItems
            const item = items?.[input.member.itemIndex]
            if (!items || !item) return undefined
            const nextItem = { ...item }
            if (nextItem.hidden === true) delete nextItem.hidden
            else nextItem.hidden = true
            const nextItems = [...items]
            nextItems[input.member.itemIndex] = nextItem
            next = { ...current, providerOutputItems: nextItems }
            break
          }
          const streamId = input.member.owner.streamId
          const attempts = current.continuationAttempts
          const attemptIndex = attempts?.findIndex(
            (attempt) => attempt.application.kind === 'applied' && attempt.streamId === streamId,
          )
          if (!attempts || attemptIndex === undefined || attemptIndex < 0) return undefined
          const attempt = attempts[attemptIndex]
          const items = attempt?.providerOutputItems
          const item = items?.[input.member.itemIndex]
          if (!attempt || !items || !item) return undefined
          const nextItem = { ...item }
          if (nextItem.hidden === true) delete nextItem.hidden
          else nextItem.hidden = true
          const nextItems = [...items]
          nextItems[input.member.itemIndex] = nextItem
          const nextAttempts = [...attempts]
          nextAttempts[attemptIndex] = { ...attempt, providerOutputItems: nextItems }
          next = { ...current, continuationAttempts: nextAttempts }
          break
        }
        case 'message.toggle-context':
          next = { ...current, hiddenFromContext: !current.hiddenFromContext }
          break
        case 'message.dismiss-generation-notice': {
          const generation = current.generation
          if (
            !generation ||
            (generation.abortReason === undefined && generation.error === undefined)
          ) {
            return undefined
          }
          const nextGeneration = { ...generation }
          delete (nextGeneration as { abortReason?: unknown }).abortReason
          delete (nextGeneration as { error?: unknown }).error
          next = { ...current, generation: nextGeneration }
          break
        }
      }

      const message = await ctx.putMessage(next, {
        touchChatSummary: capability.summary !== 'preserves',
      })
      const header = await ctx.getMessageHeader(input.messageId)
      if (!header) return undefined
      return { header, message, bodyVersion: header.bodyVersion }
    },
  )
  return result.value
}

function mutateOwnedReasoningEnvelope(
  message: Message,
  owner: ReasoningMemberRef['owner'],
  mutate: (
    envelope: NonNullable<Message['reasoningEnvelope']>,
  ) => NonNullable<Message['reasoningEnvelope']> | undefined,
): Message | undefined {
  if (owner.kind === 'generation') {
    const envelope = message.reasoningEnvelope
    if (!envelope) return undefined
    const reasoningEnvelope = mutate(envelope)
    return reasoningEnvelope ? { ...message, reasoningEnvelope } : undefined
  }
  const attempts = message.continuationAttempts
  const attemptIndex = attempts?.findIndex(
    (attempt) => attempt.application.kind === 'applied' && attempt.streamId === owner.streamId,
  )
  if (!attempts || attemptIndex === undefined || attemptIndex < 0) return undefined
  const attempt = attempts[attemptIndex]
  if (!attempt?.reasoningEnvelope) return undefined
  const reasoningEnvelope = mutate(attempt.reasoningEnvelope)
  if (!reasoningEnvelope) return undefined
  const nextAttempts = [...attempts]
  nextAttempts[attemptIndex] = { ...attempt, reasoningEnvelope }
  return { ...message, continuationAttempts: nextAttempts }
}

function toggleReasoningMember(
  envelope: NonNullable<Message['reasoningEnvelope']>,
  member: ReasoningMemberRef,
): NonNullable<Message['reasoningEnvelope']> | undefined {
  if (member.kind === 'carrier') {
    const carrier = envelope.carriers.find((candidate) => candidate.id === member.id)
    if (!carrier) return undefined
    if (carrier.kind !== 'anthropic-signature') {
      const index = envelope.carriers.indexOf(carrier)
      const carriers = [...envelope.carriers]
      carriers[index] = { ...carrier, hidden: !carrier.hidden }
      return { ...envelope, carriers }
    }
    member = { owner: member.owner, kind: 'visible', id: carrier.bindsVisiblePartId }
  }

  const index = envelope.visible.findIndex((part) => part.id === member.id)
  const part = envelope.visible[index]
  if (!part) return undefined
  const visible = [...envelope.visible]
  visible[index] = { ...part, hidden: !part.hidden }
  let carriers = envelope.carriers
  for (let carrierIndex = 0; carrierIndex < carriers.length; carrierIndex += 1) {
    const carrier = carriers[carrierIndex]
    if (
      carrier?.kind !== 'anthropic-signature' ||
      carrier.bindsVisiblePartId !== part.id ||
      carrier.hidden === undefined
    ) {
      continue
    }
    if (carriers === envelope.carriers) carriers = [...carriers]
    const { hidden: _hidden, ...canonical } = carrier
    carriers[carrierIndex] = canonical
  }
  return { ...envelope, visible, carriers }
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

interface PreparedImportedMessage {
  readonly id: MessageId
  readonly turnId: string
  readonly input: PasteImportMessageInput
}

function importedMessage(
  chatId: ChatId,
  prepared: PreparedImportedMessage,
  placement: {
    readonly parentId: MessageId | null
    readonly siblingIndex: number
    readonly createdAt: number
  },
): Message {
  return withAttachmentRefs(
    {
      id: prepared.id,
      chatId,
      parentId: placement.parentId,
      siblingIndex: placement.siblingIndex,
      turnId: prepared.turnId,
      turnIndex: 0,
      createdAt: placement.createdAt,
      role: prepared.input.role,
      origin: 'imported',
      content: prepared.input.content,
      nodeVersion: 0,
      deleted: false,
    },
    prepared.input.attachmentRefs,
    placement.createdAt,
  )
}

export interface PasteImportInput {
  chatId: ChatId
  slot: PasteImportSlot
  activeLeafId: MessageId | null
  messages: readonly PasteImportMessageInput[]
  now?: number
}

export interface PasteImportResult {
  destination: ConversationProvedSelection
  effects: StructuralEffects
  versions: ChatVersions
  newMessageIds: MessageId[]
  insertedTailId: MessageId | null
  structuralHeaders: MessageHeaderRow[]
  presentations: MessagePresentation[]
}

export async function pasteImportInRepository(
  repo: MessageMutationRepository,
  input: PasteImportInput,
): Promise<PasteImportResult> {
  if (input.messages.length === 0) {
    const result = await repo.runMutation(
      [childrenScope(input.chatId, null)],
      () => undefined,
      async (ctx) => {
        const chat = await ctx.getFinalChat(input.chatId)
        if (!chat) throw new TreeChangedError(input.chatId, 'committed chat unavailable')
        const destination = await ctx.sealCommittedDestination({
          chat,
          tipId: input.activeLeafId,
        })
        return {
          destination,
        }
      },
    )
    return {
      destination: result.value.destination,
      effects: emptyEffects(),
      versions: versionsFor(result, input.chatId),
      newMessageIds: [],
      insertedTailId: null,
      structuralHeaders: [],
      presentations: [],
    }
  }
  const now = input.now ?? Date.now()
  const activeLeafId = input.activeLeafId
  const preparedMessages = input.messages.map(
    (message): PreparedImportedMessage => ({
      id: newId(),
      turnId: newId(),
      input: message,
    }),
  )
  const newMessageIds = preparedMessages.map(({ id }) => id)
  const insertedTailId = newMessageIds.at(-1) as MessageId
  const attachmentIds = input.messages.flatMap((message) => message.attachmentRefs ?? [])
  const {
    scopes,
    placementChildren,
    expectedTargetParentId,
    activePathBefore,
    activePathIds,
    selectedChildId,
  } = await repo.readStructurePreflight(async (reader) => {
    const scopes: MutationScope[] = [
      ...newMessageIds.map((messageId) => messageScope(messageId)),
      ...newMessageIds.slice(0, -1).map((messageId) => childrenScope(input.chatId, messageId)),
      ...attachmentIdScopes(attachmentIds),
    ]
    let placementChildren: MessageHeaderRow[] = []
    let expectedTargetParentId: MessageId | null | undefined
    const activePathBefore = await readMutationBranchPath(reader, input.chatId, activeLeafId)
    const activePathIds = new Set(activePathBefore.map((header) => header.id))
    const afterMessageId = input.slot.kind === 'after' ? input.slot.messageId : undefined
    const selectedChildId =
      afterMessageId !== undefined
        ? activePathBefore.find((header) => header.parentId === afterMessageId)?.id
        : undefined

    if (input.slot.kind === 'at-end') {
      scopes.push(childrenScope(input.chatId, activeLeafId))
    } else if (input.slot.kind === 'after-all') {
      if (input.slot.parentId !== null) {
        const parent = await reader.getMessageHeader(input.slot.parentId)
        if (!parent || parent.chatId !== input.chatId || parent.deleted) {
          throw new TreeChangedError(
            input.chatId,
            `paste parent ${input.slot.parentId} unavailable`,
          )
        }
        scopes.push(messageScope(parent.id))
      }
      placementChildren = await reader.listChildHeaders(input.chatId, input.slot.parentId)
      scopes.push(
        childrenScope(input.chatId, input.slot.parentId),
        childrenScope(input.chatId, insertedTailId),
      )
      for (const child of placementChildren) {
        if (!child.deleted) scopes.push(messageScope(child.id))
      }
    } else {
      const target = await reader.getMessageHeader(input.slot.messageId)
      if (!target || target.chatId !== input.chatId || target.deleted) {
        throw new TreeChangedError(input.chatId, `paste target ${input.slot.messageId} unavailable`)
      }
      scopes.push(messageScope(target.id))
      if (input.slot.kind === 'sibling') {
        expectedTargetParentId = target.parentId
        scopes.push(childrenScope(input.chatId, target.parentId))
      } else if (input.slot.kind === 'before') {
        expectedTargetParentId = target.parentId
        placementChildren = await reader.listChildHeaders(input.chatId, target.parentId)
        scopes.push(
          ...collectInsertBetweenScopes(
            input.chatId,
            target,
            placementChildren,
            newMessageIds[0] as MessageId,
          ),
        )
        scopes.push(childrenScope(input.chatId, insertedTailId))
      } else if (selectedChildId !== undefined) {
        placementChildren = await reader.listChildHeaders(input.chatId, target.id)
        const activeDescendant = placementChildren.find(
          (child) => !child.deleted && child.id === selectedChildId,
        )
        if (!activeDescendant) {
          throw new TreeChangedError(
            input.chatId,
            `paste selected child ${selectedChildId} unavailable`,
          )
        }
        scopes.push(
          ...collectInsertBetweenScopes(
            input.chatId,
            activeDescendant,
            placementChildren,
            newMessageIds[0] as MessageId,
          ),
          childrenScope(input.chatId, insertedTailId),
        )
      } else {
        scopes.push(childrenScope(input.chatId, target.id))
      }
    }
    return {
      scopes: dedupeScopes(scopes),
      placementChildren,
      expectedTargetParentId,
      activePathBefore,
      activePathIds,
      selectedChildId,
    }
  })

  type PasteMutationValue = {
    effects: StructuralEffects
    structuralHeaders: MessageHeaderRow[]
    presentations: MessagePresentation[]
    selectionTipId: MessageId | null
  }
  type PasteMutationCommittedValue = PasteMutationValue & {
    destination: ConversationProvedSelection
  }
  const result = await repo.runMutation<PasteMutationValue, PasteMutationCommittedValue>(
    scopes,
    async (ctx) => {
      const activePath = await readMutationBranchPath(ctx, input.chatId, activeLeafId)
      if (!sameStructuralPath(activePathBefore, activePath)) {
        throw new TreeChangedError(input.chatId, 'paste active branch changed')
      }
      if (input.slot.kind === 'after-all') {
        const created = await createAfterAllImportedChain(
          ctx,
          input.chatId,
          input.slot.parentId,
          preparedMessages,
          placementChildren,
          now,
        )
        const structuralHeaders = await structuralHeadersForEffects(
          ctx,
          input.chatId,
          created.effects,
        )
        return {
          effects: created.effects,
          structuralHeaders,
          presentations: presentationsForWrittenMessages(
            input.chatId,
            structuralHeaders,
            created.messages,
          ),
          selectionTipId:
            activeLeafId !== null &&
            (input.slot.parentId === null || activePathIds.has(input.slot.parentId))
              ? activeLeafId
              : insertedTailId,
        }
      }

      const effects = emptyEffects()
      const firstRow = await createFirstImported(
        ctx,
        input.chatId,
        input.slot,
        selectedChildId,
        preparedMessages[0] as PreparedImportedMessage,
        now,
        effects,
        activeLeafId,
        expectedTargetParentId,
        placementChildren.map((header) => header.id),
      )

      let tail = firstRow
      const writtenMessages = [firstRow]
      const displacedMessageIds = effects.reparented.map((effect) => effect.id)
      const displacedMessageIdSet = new Set(displacedMessageIds)
      for (let i = 1; i < input.messages.length; i += 1) {
        const prepared = preparedMessages[i] as PreparedImportedMessage
        const slot = await ctx.getChildList(input.chatId, tail.id)
        const row = importedMessage(input.chatId, prepared, {
          parentId: tail.id,
          siblingIndex: slot.nextSiblingIndex,
          createdAt: now,
        })
        tail = await ctx.putMessage(row)
        writtenMessages.push(tail)
        effects.newMessageIds.push(prepared.id)
      }

      if (displacedMessageIds.length > 0 && tail.id !== firstRow.id) {
        for (let peerIndex = 0; peerIndex < displacedMessageIds.length; peerIndex += 1) {
          const displacedId = displacedMessageIds[peerIndex] as MessageId
          const displaced = await ctx.getMessageHeader(displacedId)
          if (
            !displaced ||
            displaced.chatId !== input.chatId ||
            displaced.parentId !== firstRow.id
          ) {
            throw new TreeChangedError(
              input.chatId,
              `paste displaced child ${displacedId} unavailable`,
            )
          }
          await ctx.patchMessageStructure(displaced.id, {
            parentId: tail.id,
            siblingIndex: peerIndex,
          })
        }
        for (const effect of effects.reparented) {
          if (displacedMessageIdSet.has(effect.id)) effect.newParentId = tail.id
        }
      }

      const structuralHeaders = await structuralHeadersForEffects(ctx, input.chatId, effects)
      return {
        effects,
        structuralHeaders,
        presentations: presentationsForWrittenMessages(
          input.chatId,
          structuralHeaders,
          writtenMessages,
        ),
        selectionTipId:
          activeLeafId !== null &&
          ((input.slot.kind === 'before' && activePathIds.has(input.slot.messageId)) ||
            (input.slot.kind === 'after' && selectedChildId !== undefined))
            ? activeLeafId
            : insertedTailId,
      }
    },
    async (ctx, value) => {
      const chat = await ctx.getFinalChat(input.chatId)
      if (!chat) throw new TreeChangedError(input.chatId, 'committed chat unavailable')
      const destination = await ctx.sealCommittedDestination({
        chat,
        tipId: value.selectionTipId,
        presentations: value.presentations,
      })
      return {
        ...value,
        destination,
      }
    },
  )

  return {
    destination: result.value.destination,
    effects: result.value.effects,
    versions: versionsFor(result, input.chatId),
    newMessageIds: result.value.effects.newMessageIds,
    insertedTailId,
    structuralHeaders: result.value.structuralHeaders,
    presentations: result.value.presentations,
  }
}

async function structuralHeadersForEffects(
  ctx: MessageMutationContext,
  chatId: ChatId,
  effects: Pick<StructuralEffects, 'newMessageIds' | 'reparented' | 'tombstoned'>,
): Promise<MessageHeaderRow[]> {
  const ids = new Set<MessageId>([
    ...effects.newMessageIds,
    ...effects.reparented.map((effect) => effect.id),
    ...effects.tombstoned,
  ])
  const headers: MessageHeaderRow[] = []
  for (const id of ids) {
    const header = await ctx.getMessageHeader(id)
    if (!header || header.chatId !== chatId) {
      throw new TreeChangedError(chatId, `structural result ${id} unavailable`)
    }
    headers.push(header)
  }
  return headers
}

function presentationsForWrittenMessages(
  chatId: ChatId,
  headers: readonly MessageHeaderRow[],
  messages: readonly Message[],
): MessagePresentation[] {
  const headersById = new Map(headers.map((header) => [header.id, header]))
  const presentations: MessagePresentation[] = []
  for (const message of messages) {
    const header = headersById.get(message.id)
    if (
      !header ||
      message.chatId !== chatId ||
      message.deleted ||
      message.nodeVersion !== header.nodeVersion ||
      message.parentId !== header.parentId ||
      message.siblingIndex !== header.siblingIndex ||
      message.createdAt !== header.createdAt
    ) {
      throw new TreeChangedError(chatId, `paste message ${message.id} unavailable`)
    }
    presentations.push({ header, message, bodyVersion: header.bodyVersion })
  }
  return presentations
}

async function createAfterAllImportedChain(
  ctx: MessageMutationContext,
  chatId: ChatId,
  parentId: MessageId | null,
  messages: readonly PreparedImportedMessage[],
  expectedChildren: readonly MessageHeaderRow[],
  now: number,
): Promise<{ effects: StructuralEffects; messages: Message[] }> {
  if (parentId !== null) {
    const parent = await ctx.getMessageHeader(parentId)
    if (!parent || parent.chatId !== chatId || parent.deleted) {
      throw new TreeChangedError(chatId, `paste parent ${parentId} unavailable`)
    }
  }

  const currentAllChildren = await ctx.listChildHeaders(chatId, parentId)
  if (!sameHeaderIds(expectedChildren, currentAllChildren)) {
    throw new TreeChangedError(chatId, `paste children of ${parentId ?? 'root'} changed`)
  }
  const currentChildren = liveChildrenSorted(currentAllChildren)

  const effects = emptyEffects()
  const writtenMessages: Message[] = []
  let chainParentId = parentId
  const tailId = (messages.at(-1) as PreparedImportedMessage).id

  for (let index = 0; index < messages.length; index += 1) {
    const prepared = messages[index] as PreparedImportedMessage
    const row = importedMessage(chatId, prepared, {
      parentId: chainParentId,
      siblingIndex: index === 0 ? nextSiblingIndexFromChildren(currentAllChildren) : 0,
      createdAt: now,
    })
    const written = await ctx.putMessage(row)
    writtenMessages.push(written)
    effects.newMessageIds.push(prepared.id)
    chainParentId = prepared.id
  }

  for (let index = 0; index < currentChildren.length; index += 1) {
    const expected = currentChildren[index] as MessageTreeRow
    const child = await ctx.getMessageHeader(expected.id)
    if (
      !child ||
      child.chatId !== chatId ||
      child.deleted ||
      child.parentId !== parentId ||
      child.siblingIndex !== expected.siblingIndex
    ) {
      throw new TreeChangedError(chatId, `paste child ${expected.id} changed`)
    }
    await ctx.patchMessageStructure(child.id, { parentId: tailId, siblingIndex: index })
    effects.reparented.push({
      id: child.id,
      previousParentId: parentId,
      newParentId: tailId,
    })
  }

  return { effects, messages: writtenMessages }
}

async function createFirstImported(
  ctx: MessageMutationContext,
  chatId: ChatId,
  slot: Exclude<PasteImportSlot, { kind: 'after-all' }>,
  selectedChildId: MessageId | undefined,
  prepared: PreparedImportedMessage,
  now: number,
  effects: StructuralEffects,
  activeLeafId: MessageId | null,
  expectedTargetParentId: MessageId | null | undefined,
  expectedPlacementChildIds: readonly MessageId[],
): Promise<Message> {
  if (slot.kind === 'at-end') {
    if (activeLeafId !== null) {
      const leaf = await ctx.getMessageHeader(activeLeafId)
      if (!leaf || leaf.chatId !== chatId || leaf.deleted) {
        throw new TreeChangedError(chatId, `paste leaf ${activeLeafId} unavailable`)
      }
    }
    const slot = await ctx.getChildList(chatId, activeLeafId)
    if (slot.liveCount !== 0) {
      throw new TreeChangedError(chatId, `paste leaf ${activeLeafId ?? 'root'} advanced`)
    }
    const row = importedMessage(chatId, prepared, {
      parentId: activeLeafId,
      siblingIndex: slot.nextSiblingIndex,
      createdAt: now,
    })
    const written = await ctx.putMessage(row)
    effects.newMessageIds.push(row.id)
    return written
  }

  const target = await ctx.getMessageHeader(slot.messageId)
  if (!target || target.chatId !== chatId || target.deleted) {
    throw new TreeChangedError(chatId, `paste target ${slot.messageId} unavailable`)
  }

  if (
    (slot.kind === 'sibling' || slot.kind === 'before') &&
    target.parentId !== expectedTargetParentId
  ) {
    throw new TreeChangedError(chatId, `paste target ${slot.messageId} moved`)
  }

  if (slot.kind === 'sibling') {
    const siblingSlot = await ctx.getChildList(chatId, target.parentId)
    const row = importedMessage(chatId, prepared, {
      parentId: target.parentId,
      siblingIndex: siblingSlot.nextSiblingIndex,
      createdAt: now,
    })
    const written = await ctx.putMessage(row)
    effects.newMessageIds.push(row.id)
    return written
  }

  if (slot.kind === 'before') {
    return insertBetweenInner(
      ctx,
      chatId,
      target.parentId,
      target.id,
      prepared,
      now,
      effects,
      expectedPlacementChildIds,
    )
  }

  const children =
    selectedChildId === undefined ? undefined : await ctx.listChildHeaders(chatId, target.id)
  if (children && !sameHeaderIdList(children, expectedPlacementChildIds)) {
    throw new TreeChangedError(chatId, `paste children of ${target.id} changed`)
  }
  const liveKids = children?.filter((kid) => !kid.deleted) ?? []
  const activeDescendant =
    selectedChildId !== undefined ? liveKids.find((kid) => kid.id === selectedChildId) : undefined
  if (selectedChildId !== undefined && !activeDescendant) {
    throw new TreeChangedError(chatId, `paste selected child ${selectedChildId} unavailable`)
  }
  const childSlot =
    selectedChildId === undefined ? await ctx.getChildList(chatId, target.id) : undefined
  if (childSlot && childSlot.liveCount !== 0) {
    throw new TreeChangedError(chatId, `paste target ${target.id} is not a leaf`)
  }
  if (activeDescendant) {
    return insertBetweenInner(
      ctx,
      chatId,
      target.id,
      activeDescendant.id,
      prepared,
      now,
      effects,
      expectedPlacementChildIds,
    )
  }

  const row = importedMessage(chatId, prepared, {
    parentId: target.id,
    siblingIndex: childSlot?.nextSiblingIndex ?? 0,
    createdAt: now,
  })
  const written = await ctx.putMessage(row)
  effects.newMessageIds.push(row.id)
  return written
}

async function insertBetweenInner(
  ctx: MessageMutationContext,
  chatId: ChatId,
  parentId: MessageId | null,
  childId: MessageId,
  prepared: PreparedImportedMessage,
  now: number,
  effects: StructuralEffects,
  expectedSiblingIds?: readonly MessageId[],
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
  if (expectedSiblingIds && !sameHeaderIdList(siblings, expectedSiblingIds)) {
    throw new TreeChangedError(chatId, `insert-between children of ${parentId ?? 'root'} changed`)
  }
  const row = importedMessage(chatId, prepared, {
    parentId,
    siblingIndex: nextSiblingIndexFromChildren(siblings),
    createdAt: now,
  })
  const written = await ctx.putMessage(row)

  const peerHeaders = siblings
    .filter((sibling) => sibling.turnId === child.turnId && !sibling.deleted)
    .sort((a, b) => a.createdAt - b.createdAt)
  for (let i = 0; i < peerHeaders.length; i += 1) {
    const peerHeader = peerHeaders[i] as MessageTreeRow
    const peer = await ctx.getMessageHeader(peerHeader.id)
    if (!peer || peer.chatId !== chatId || peer.deleted || peer.parentId !== parentId) {
      throw new TreeChangedError(chatId, `insert-between peer ${peerHeader.id} unavailable`)
    }
    await ctx.patchMessageStructure(peer.id, { parentId: row.id, siblingIndex: i })
    effects.reparented.push({
      id: peer.id,
      previousParentId: parentId,
      newParentId: row.id,
    })
  }

  effects.newMessageIds.push(row.id)
  return written
}

function cachedMessageHeaderReader(source: MessageHeaderReader): MessageHeaderReader {
  const headers = new Map<MessageId, MessageHeaderRow | undefined>()
  const children = new Map<string, MessageHeaderRow[]>()
  return {
    getMessageHeader: async (messageId) => {
      if (!headers.has(messageId)) {
        headers.set(messageId, await source.getMessageHeader(messageId))
      }
      return headers.get(messageId)
    },
    listChildHeaders: async (chatId, parentId) => {
      const key = `${chatId}:${parentId ?? '__root__'}`
      const known = children.get(key)
      if (known) return known
      const rows = await source.listChildHeaders(chatId, parentId)
      children.set(key, rows)
      for (const row of rows) headers.set(row.id, row)
      return rows
    },
  }
}

async function requireLiveTarget(
  reader: MessageHeaderReader,
  chatId: ChatId,
  messageId: MessageId,
  operation: string,
): Promise<MessageHeaderRow> {
  const target = await reader.getMessageHeader(messageId)
  if (!target || target.chatId !== chatId || target.deleted) {
    throw new TreeChangedError(chatId, `${operation} target ${messageId} unavailable`)
  }
  return target
}

async function targetedTurnHead(
  reader: MessageHeaderReader,
  chatId: ChatId,
  message: MessageHeaderRow,
): Promise<MessageHeaderRow> {
  let current = message
  const seen = new Set<MessageId>()
  while (current.turnIndex !== 0) {
    if (seen.has(current.id)) throw new TreeChangedError(chatId, `turn cycle ${current.id}`)
    seen.add(current.id)
    const parent = current.parentId ? await reader.getMessageHeader(current.parentId) : undefined
    if (!parent || parent.chatId !== chatId || parent.turnId !== current.turnId) return current
    current = parent
  }
  return current
}

async function targetedTurnChain(
  reader: MessageHeaderReader,
  chatId: ChatId,
  head: MessageHeaderRow,
): Promise<MessageHeaderRow[]> {
  const result: MessageHeaderRow[] = [head]
  const seen = new Set<MessageId>([head.id])
  const stack: MessageId[] = [head.id]
  while (stack.length > 0) {
    const parentId = stack.pop() as MessageId
    for (const child of await reader.listChildHeaders(chatId, parentId)) {
      if (child.turnId !== head.turnId || seen.has(child.id)) continue
      seen.add(child.id)
      result.push(child)
      stack.push(child.id)
    }
  }
  return result
}

async function targetedAncestorWithRole(
  reader: MessageHeaderReader,
  chatId: ChatId,
  start: MessageHeaderRow,
  role: MessageRole,
): Promise<MessageHeaderRow | null> {
  let current: MessageHeaderRow | undefined = start
  const seen = new Set<MessageId>()
  while (current) {
    if (seen.has(current.id)) throw new TreeChangedError(chatId, `ancestry cycle ${current.id}`)
    seen.add(current.id)
    if (!current.deleted && current.role === role) return current
    current = current.parentId ? await reader.getMessageHeader(current.parentId) : undefined
    if (current && current.chatId !== chatId) {
      throw new TreeChangedError(chatId, `ancestor ${current.id} unavailable`)
    }
  }
  return null
}

async function targetedPairFollowers(
  reader: MessageHeaderReader,
  chatId: ChatId,
  userHead: MessageHeaderRow,
  selectedChildIds: ReadonlyMap<MessageId | null, MessageId>,
): Promise<MessageHeaderRow[]> {
  const result: MessageHeaderRow[] = []
  const seen = new Set<MessageId>()
  let currentId = userHead.id
  for (;;) {
    const children = liveChildrenSorted(await reader.listChildHeaders(chatId, currentId))
    if (children.length === 0) return result
    const pinnedId = selectedChildIds.get(currentId)
    const pinned = children.find((child) => child.id === pinnedId)
    const next = pinned ?? children.find((child) => child.turnIndex === 0 && child.role !== 'user')
    if (!next || next.role === 'user') return result
    if (seen.has(next.id)) throw new TreeChangedError(chatId, `pair cycle ${next.id}`)
    seen.add(next.id)
    result.push(next)
    let chainId = next.id
    for (;;) {
      const chainChildren = liveChildrenSorted(
        await reader.listChildHeaders(chatId, chainId),
      ).filter((child) => child.turnId === next.turnId)
      const inner = chainChildren[0]
      if (!inner) break
      if (seen.has(inner.id)) throw new TreeChangedError(chatId, `pair cycle ${inner.id}`)
      seen.add(inner.id)
      result.push(inner)
      chainId = inner.id
    }
    currentId = chainId
  }
}

export interface DeleteInput {
  chatId: ChatId
  messageId: MessageId
  activeLeafId: MessageId | null
  cascade?: boolean
  now?: number
}

export async function deletePairInRepository(
  repo: MessageMutationRepository,
  input: DeleteInput,
): Promise<DeleteResult> {
  const { activeBranchBefore, members, plan } = await repo.readStructurePreflight(
    async (source) => {
      const reader = cachedMessageHeaderReader(source)
      const target = await requireLiveTarget(reader, input.chatId, input.messageId, 'delete-pair')
      const activeBranchBefore = await readMutationBranchPath(
        reader,
        input.chatId,
        input.activeLeafId,
      )
      const targetBranchBefore = activeBranchBefore.some((header) => header.id === target.id)
        ? activeBranchBefore
        : await readMutationBranchPath(reader, input.chatId, target.id)
      const selectedChildIds = new Map(
        targetBranchBefore.map((header) => [header.parentId, header.id] as const),
      )
      const userHead = await targetedAncestorWithRole(reader, input.chatId, target, 'user')
      const members: MessageTreeRow[] = []
      if (userHead) {
        members.push(...(await targetedTurnChain(reader, input.chatId, userHead)))
        members.push(
          ...(await targetedPairFollowers(reader, input.chatId, userHead, selectedChildIds)),
        )
      } else {
        members.push(
          ...(await targetedTurnChain(
            reader,
            input.chatId,
            await targetedTurnHead(reader, input.chatId, target),
          )),
        )
      }
      const plan = await planDeleteMutation(reader, input.chatId, members, input.cascade ?? false)
      return { activeBranchBefore, members, plan }
    },
  )
  return executeDeleteMutation(repo, input, members, plan, activeBranchBefore)
}

export async function deleteTurnInRepository(
  repo: MessageMutationRepository,
  input: DeleteInput,
): Promise<DeleteResult> {
  const { activeBranchBefore, members, plan } = await repo.readStructurePreflight(
    async (source) => {
      const reader = cachedMessageHeaderReader(source)
      const target = await requireLiveTarget(reader, input.chatId, input.messageId, 'delete-turn')
      const activeBranchBefore = await readMutationBranchPath(
        reader,
        input.chatId,
        input.activeLeafId,
      )
      const head = await targetedTurnHead(reader, input.chatId, target)
      const slotSiblings = (await reader.listChildHeaders(input.chatId, head.parentId)).filter(
        (sibling) => !sibling.deleted && sibling.turnIndex === 0,
      )
      const members: MessageTreeRow[] = []
      for (const variantHead of slotSiblings) {
        members.push(...(await targetedTurnChain(reader, input.chatId, variantHead)))
      }
      const plan = await planDeleteMutation(reader, input.chatId, members, input.cascade ?? false)
      return { activeBranchBefore, members, plan }
    },
  )
  return executeDeleteMutation(repo, input, members, plan, activeBranchBefore)
}

// Tombstone exactly ONE message. Live direct children splice up to the
// message's parent; tombstoned children stay in place (already dead and
// re-parenting them has no user-visible effect). Used for the "delete
// just this row" affordance when the user is cleaning up a
// role-adjacency mismatch or explicitly opting out of pair-delete.
export async function deleteSingleMessageInRepository(
  repo: MessageMutationRepository,
  input: DeleteInput,
): Promise<DeleteResult> {
  const { activeBranchBefore, members, plan } = await repo.readStructurePreflight(
    async (source) => {
      const reader = cachedMessageHeaderReader(source)
      const target = await requireLiveTarget(reader, input.chatId, input.messageId, 'delete-single')
      const activeBranchBefore = await readMutationBranchPath(
        reader,
        input.chatId,
        input.activeLeafId,
      )
      const members: MessageTreeRow[] = [target]
      const plan = await planDeleteMutation(reader, input.chatId, members, input.cascade ?? false)
      return { activeBranchBefore, members, plan }
    },
  )
  return executeDeleteMutation(repo, input, members, plan, activeBranchBefore)
}

export async function deleteVariantInRepository(
  repo: MessageMutationRepository,
  input: DeleteInput,
): Promise<DeleteResult> {
  const { activeBranchBefore, members, plan } = await repo.readStructurePreflight(
    async (source) => {
      const reader = cachedMessageHeaderReader(source)
      const target = await requireLiveTarget(
        reader,
        input.chatId,
        input.messageId,
        'delete-variant',
      )
      const activeBranchBefore = await readMutationBranchPath(
        reader,
        input.chatId,
        input.activeLeafId,
      )
      const members = await targetedTurnChain(
        reader,
        input.chatId,
        await targetedTurnHead(reader, input.chatId, target),
      )
      const plan = await planDeleteMutation(reader, input.chatId, members, input.cascade ?? false)
      return { activeBranchBefore, members, plan }
    },
  )
  return executeDeleteMutation(repo, input, members, plan, activeBranchBefore)
}

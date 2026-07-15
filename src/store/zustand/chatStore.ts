// Per-tab branch navigation is an intent-owned state machine. Producer tokens
// publish branch-changing results; exact local body mutations publish one
// route-independent presentation and may refresh the already-selected path,
// but never become navigation intents.

import { create } from 'zustand'
import type { ChatId, CursorMap, CursorPatch, MessageId } from '../../core/types'
import type { MessageHeaderRow, MessagePresentation } from '../message-storage'
import {
  isPersistentCursor,
  patchPersistentCursor,
  persistentCursorSize,
  toPersistentCursor,
} from './persistentCursor'
import {
  claimTabNavigation,
  invalidateTabNavigation,
  isTabNavigationCurrent,
  type TabNavigationAuthority,
} from './tabNavigation'

const navigationIntentBrand: unique symbol = Symbol('NavigationIntent')
const navigationAuthority: unique symbol = Symbol('NavigationAuthority')
const committedPathProducerBrand: unique symbol = Symbol('CommittedPathProducer')
const committedPresentationFocusBrand: unique symbol = Symbol('CommittedPresentationFocus')

export interface NavigationIntent {
  readonly chatId: ChatId
  readonly revision: string
  readonly [navigationIntentBrand]: true
  readonly [navigationAuthority]: TabNavigationAuthority
}

export interface CommittedPathProducer {
  readonly chatId: ChatId
  readonly originIntent: NavigationIntent
  readonly [committedPathProducerBrand]: true
}

export interface CommittedPresentationFocus {
  readonly chatId: ChatId
  readonly [committedPresentationFocusBrand]: true
}

export interface PendingBranchNavigation {
  readonly revision: string
  readonly selections: Readonly<CursorMap>
  readonly pathMessageIds: readonly MessageId[]
}

export type CommittedMessagePresentation = MessagePresentation

export interface CommittedMessagePresentationReceipt {
  readonly chatId: ChatId
  readonly presentation: CommittedMessagePresentation
}

export interface CommittedPathPresentationReceipt {
  readonly chatId: ChatId
  readonly revision: string
  readonly phase: 'open' | 'terminal'
  readonly pathHeaders: readonly MessageHeaderRow[]
  readonly structuralHeaders: readonly MessageHeaderRow[]
  readonly presentations: readonly CommittedMessagePresentation[]
}

export interface CommittedPathPresentationInput {
  readonly phase: CommittedPathPresentationReceipt['phase']
  readonly pathHeaders: readonly MessageHeaderRow[]
  readonly structuralHeaders?: readonly MessageHeaderRow[]
  readonly presentations: readonly CommittedMessagePresentation[]
}

interface TabBranchState {
  readonly intent: NavigationIntent | null
  readonly revision: string
  readonly cursor: Readonly<CursorMap>
  readonly pending?: PendingBranchNavigation
}

interface ChatStoreState {
  publication: number
  getDebugStats: () => { chatCursorCount: number; cursorEntryCount: number }
  getCursor: (chatId: ChatId) => Readonly<CursorMap> | undefined
  getNavigationRevision: (chatId: ChatId) => string
  getPendingBranchNavigation: (chatId: ChatId) => PendingBranchNavigation | undefined
  getCommittedPathPresentation: (chatId: ChatId) => CommittedPathPresentationReceipt | undefined
  getCommittedMessagePresentation: (
    chatId: ChatId,
  ) => CommittedMessagePresentationReceipt | undefined
  beginCommittedPresentationFocus: (chatId: ChatId) => CommittedPresentationFocus
  endCommittedPresentationFocus: (focus: CommittedPresentationFocus) => void
  setCommittedPresentationWindowLimit: (chatId: ChatId, limit: number) => void
  isNavigationIntentCurrent: (intent: NavigationIntent) => boolean
  beginNavigationIntent: (chatId: ChatId) => NavigationIntent
  navigateToCursor: (chatId: ChatId, cursor: Readonly<CursorMap>) => NavigationIntent
  navigateWithCursorPatch: (chatId: ChatId, patch: Readonly<CursorPatch>) => NavigationIntent
  setCursorForIntent: (
    chatId: ChatId,
    intent: NavigationIntent,
    cursor: Readonly<CursorMap>,
  ) => boolean
  patchCursorForIntent: (
    chatId: ChatId,
    intent: NavigationIntent,
    patch: Readonly<CursorPatch>,
  ) => boolean
  reconcileCursor: (chatId: ChatId, cursor: Readonly<CursorMap>) => void
  reconcileCursorPatch: (chatId: ChatId, patch: Readonly<CursorPatch>) => void
  selectPathForIntent: (
    chatId: ChatId,
    intent: NavigationIntent,
    selections: Readonly<Record<string, MessageId>>,
    pendingPathMessageIds?: readonly MessageId[],
  ) => boolean
  registerCommittedPathProducer: (
    chatId: ChatId,
    intent: NavigationIntent,
  ) => CommittedPathProducer | null
  selectCommittedPathForProducer: (
    chatId: ChatId,
    producer: CommittedPathProducer,
    selections: Readonly<Record<string, MessageId>>,
    presentation: CommittedPathPresentationInput,
    cursorPatch?: Readonly<CursorPatch>,
  ) => boolean
  updateCommittedMessageForProducer: (
    chatId: ChatId,
    producer: CommittedPathProducer,
    presentation: CommittedMessagePresentation,
    phase: CommittedPathPresentationReceipt['phase'],
  ) => boolean
  publishCommittedMessageMutation: (
    chatId: ChatId,
    selectedPathHeaders: readonly MessageHeaderRow[],
    presentation: CommittedMessagePresentation,
  ) => boolean
  sealCommittedPathProducer: (chatId: ChatId, producer: CommittedPathProducer) => boolean
  acknowledgePendingBranchNavigation: (chatId: ChatId, pending: PendingBranchNavigation) => void
  acknowledgeCommittedPathPresentation: (
    chatId: ChatId,
    receipt: CommittedPathPresentationReceipt,
  ) => void
  acknowledgeCommittedMessagePresentation: (
    chatId: ChatId,
    receipt: CommittedMessagePresentationReceipt,
  ) => void
  clearCursor: (chatId: ChatId) => void
  resetForWorkspaceReplacement: () => void
  reset: () => void
}

const branches = new Map<ChatId, TabBranchState>()
const committedPresentationWindowLimits = new Map<ChatId, number>()
interface CommittedPathPresentationState {
  readonly receipt: CommittedPathPresentationReceipt
  readonly producer: CommittedPathProducer | null
}

const committedPathPresentations = new Map<ChatId, CommittedPathPresentationState>()
const committedMessagePresentations = new Map<ChatId, CommittedMessagePresentationReceipt>()
const committedBodyRetention = new Map<ChatId, true>()
const pendingCommittedPathProducers = new Map<ChatId, CommittedPathProducer>()
const consumedCommittedPathIntents = new WeakSet<NavigationIntent>()
const DEFAULT_COMMITTED_PRESENTATION_WINDOW = 10
const MAX_COMMITTED_BODY_CHATS = 8
const EMPTY_COMMITTED_PRESENTATIONS = Object.freeze([]) as readonly CommittedMessagePresentation[]
let committedPresentationFocus: CommittedPresentationFocus | null = null

function chatHasCommittedBodies(chatId: ChatId): boolean {
  return (
    committedMessagePresentations.has(chatId) ||
    (committedPathPresentations.get(chatId)?.receipt.presentations.length ?? 0) > 0
  )
}

function evictCommittedBodies(chatId: ChatId): void {
  committedMessagePresentations.delete(chatId)
  const committed = committedPathPresentations.get(chatId)
  if (!committed || committed.receipt.presentations.length === 0) return
  if (committed.producer === null && committed.receipt.phase === 'terminal') {
    committedPathPresentations.delete(chatId)
    return
  }
  committedPathPresentations.set(
    chatId,
    Object.freeze({
      receipt: Object.freeze({
        ...committed.receipt,
        presentations: EMPTY_COMMITTED_PRESENTATIONS,
      }),
      producer: committed.producer,
    }),
  )
}

function reconcileCommittedBodyRetention(chatId: ChatId, touch: boolean): void {
  if (!chatHasCommittedBodies(chatId)) {
    committedBodyRetention.delete(chatId)
    return
  }
  if (touch || !committedBodyRetention.has(chatId)) {
    committedBodyRetention.delete(chatId)
    committedBodyRetention.set(chatId, true)
  }
  while (committedBodyRetention.size > MAX_COMMITTED_BODY_CHATS) {
    let evictedChatId: ChatId | undefined
    for (const candidate of committedBodyRetention.keys()) {
      if (candidate === committedPresentationFocus?.chatId) continue
      evictedChatId = candidate
      break
    }
    if (evictedChatId === undefined) break
    committedBodyRetention.delete(evictedChatId)
    evictCommittedBodies(evictedChatId)
  }
}

function retainCommittedMessagePresentation(
  chatId: ChatId,
  receipt: CommittedMessagePresentationReceipt,
): void {
  committedMessagePresentations.delete(chatId)
  committedMessagePresentations.set(chatId, receipt)
  reconcileCommittedBodyRetention(chatId, true)
}

function clearCommittedPathPresentation(chatId: ChatId): void {
  const producer = committedPathPresentations.get(chatId)?.producer
  if (producer) consumedCommittedPathIntents.add(producer.originIntent)
  committedPathPresentations.delete(chatId)
  reconcileCommittedBodyRetention(chatId, false)
}

function createNavigationIntent(chatId: ChatId): NavigationIntent {
  const authority = claimTabNavigation()
  return Object.freeze({
    chatId,
    revision: authority.revision,
    [navigationIntentBrand]: true as const,
    [navigationAuthority]: authority,
  })
}

function transferCommittedPathPresentation(
  chatId: ChatId,
  previousRevision: string | undefined,
  intent: NavigationIntent,
  cursor: Readonly<CursorMap>,
): void {
  const committed = committedPathPresentations.get(chatId)
  if (!committed) return
  const { receipt, producer } = committed
  if (
    receipt.revision === previousRevision &&
    (receipt.phase === 'terminal' || producer) &&
    cursorSelectsReceiptPath(cursor, receipt)
  ) {
    committedPathPresentations.set(
      chatId,
      Object.freeze({
        receipt: Object.freeze({ ...receipt, revision: intent.revision }),
        producer,
      }),
    )
    return
  }
  clearCommittedPathPresentation(chatId)
}

function transferPendingBranchNavigation(
  pending: PendingBranchNavigation | undefined,
  intent: NavigationIntent,
  cursor: Readonly<CursorMap>,
): PendingBranchNavigation | undefined {
  const pathPreserved =
    pending &&
    Object.entries(pending.selections).every(
      ([parentKey, childId]) => cursor[parentKey] === childId,
    )
  return pending && pathPreserved
    ? Object.freeze({ ...pending, revision: intent.revision })
    : undefined
}

function ownedHeader(header: MessageHeaderRow): MessageHeaderRow {
  return Object.freeze(structuredClone(header))
}

function ownedPresentation(
  presentation: CommittedMessagePresentation,
): CommittedMessagePresentation {
  return Object.freeze({
    header: ownedHeader(presentation.header),
    message: Object.freeze(structuredClone(presentation.message)),
    bodyVersion: presentation.bodyVersion,
  })
}

function ownedMessagePresentationReceipt(
  chatId: ChatId,
  presentation: CommittedMessagePresentation,
): CommittedMessagePresentationReceipt {
  return Object.freeze({ chatId, presentation: ownedPresentation(presentation) })
}

function sameHeaderVersion(left: MessageHeaderRow, right: MessageHeaderRow): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.parentId === right.parentId &&
    left.siblingIndex === right.siblingIndex &&
    left.deleted === right.deleted &&
    left.nodeVersion === right.nodeVersion &&
    left.bodyVersion === right.bodyVersion
  )
}

function completeStructuralHeaders(
  input: Pick<CommittedPathPresentationInput, 'pathHeaders' | 'structuralHeaders'>,
): readonly MessageHeaderRow[] {
  if (!input.structuralHeaders) return input.pathHeaders
  const byId = new Map(input.structuralHeaders.map((header) => [header.id, header]))
  for (const header of input.pathHeaders) byId.set(header.id, header)
  return [...byId.values()]
}

function ownedCommittedPathPresentation(
  chatId: ChatId,
  revision: string,
  input: CommittedPathPresentationInput,
  previous: CommittedPathPresentationReceipt | null,
): CommittedPathPresentationReceipt {
  const presentationWindowLimit =
    committedPresentationWindowLimits.get(chatId) ?? DEFAULT_COMMITTED_PRESENTATION_WINDOW
  const retainedIds = new Set(
    input.pathHeaders.slice(-presentationWindowLimit).map((header) => header.id),
  )
  const previousPresentations = new Set(previous?.presentations ?? [])
  const ownedByInputHeader = new Map<MessageHeaderRow, CommittedMessagePresentation>()
  const presentations = input.presentations
    .filter((presentation) => retainedIds.has(presentation.message.id))
    .map((presentation) => {
      const owned = previousPresentations.has(presentation)
        ? presentation
        : ownedPresentation(presentation)
      ownedByInputHeader.set(presentation.header, owned)
      return owned
    })
  const previousHeaderById = new Map(
    previous?.pathHeaders.map((header) => [header.id, header]) ?? [],
  )
  const pathHeaders = input.pathHeaders.map((header) => {
    const presentation = ownedByInputHeader.get(header)
    if (presentation) return presentation.header
    const prior = previousHeaderById.get(header.id)
    return prior && sameHeaderVersion(prior, header) ? prior : ownedHeader(header)
  })
  const previousStructuralHeaderById = new Map(
    previous?.structuralHeaders.map((header) => [header.id, header]) ?? [],
  )
  const pathHeaderById = new Map(pathHeaders.map((header) => [header.id, header]))
  const structuralHeaders = completeStructuralHeaders(input).map((header) => {
    const pathHeader = pathHeaderById.get(header.id)
    if (pathHeader) return pathHeader
    const prior = previousStructuralHeaderById.get(header.id)
    return prior && sameHeaderVersion(prior, header) ? prior : ownedHeader(header)
  })
  return Object.freeze({
    chatId,
    revision,
    phase: input.phase,
    pathHeaders: Object.freeze(pathHeaders),
    structuralHeaders: Object.freeze(structuralHeaders),
    presentations: Object.freeze(presentations),
  })
}

function ownedCursor(cursor: Readonly<CursorMap>): Readonly<CursorMap> {
  return toPersistentCursor(cursor)
}

function mergedCursor(
  cursor: Readonly<CursorMap>,
  selections: Readonly<CursorMap>,
): Readonly<CursorMap> {
  return patchPersistentCursor(cursor, selections)
}

function cursorEqual(left: Readonly<CursorMap>, right: Readonly<CursorMap>): boolean {
  if (left === right) return true
  if (isPersistentCursor(left) && isPersistentCursor(right)) return false
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => left[key] === right[key])
}

function pathEqual(left: readonly MessageId[], right: readonly MessageId[]): boolean {
  return (
    left.length === right.length && left.every((messageId, index) => messageId === right[index])
  )
}

function pendingEqual(
  pending: PendingBranchNavigation | undefined,
  revision: string,
  selections: Readonly<CursorMap>,
  pathMessageIds: readonly MessageId[] | undefined,
): boolean {
  if (!pathMessageIds?.at(-1)) return pending === undefined
  return (
    pending?.revision === revision &&
    cursorEqual(pending.selections, selections) &&
    pathEqual(pending.pathMessageIds, pathMessageIds)
  )
}

function ownedPath(pathMessageIds: readonly MessageId[]): readonly MessageId[] {
  return Object.freeze([...pathMessageIds])
}

function ownedSelections(selections: Readonly<CursorMap>): Readonly<CursorMap> {
  return Object.freeze({ ...selections })
}

function isCurrent(chatId: ChatId, intent: NavigationIntent): boolean {
  return (
    intent.chatId === chatId &&
    branches.get(chatId)?.intent === intent &&
    isTabNavigationCurrent(intent[navigationAuthority])
  )
}

function cursorSelectsReceiptPath(
  cursor: Readonly<CursorMap>,
  receipt: CommittedPathPresentationReceipt,
): boolean {
  return cursorSelectsPath(cursor, receipt.pathHeaders)
}

function cursorSelectsPath(
  cursor: Readonly<CursorMap>,
  pathHeaders: readonly MessageHeaderRow[],
): boolean {
  return pathHeaders.every((header) => cursor[header.parentId ?? '__root__'] === header.id)
}

function samePathStructure(
  left: readonly MessageHeaderRow[],
  right: readonly MessageHeaderRow[],
): boolean {
  return (
    left.length === right.length &&
    left.every((header, index) => {
      const candidate = right[index]
      return (
        candidate?.id === header.id &&
        candidate.chatId === header.chatId &&
        candidate.parentId === header.parentId &&
        candidate.siblingIndex === header.siblingIndex &&
        candidate.deleted === header.deleted
      )
    })
  )
}

function samePathIdentity(
  left: readonly MessageHeaderRow[],
  right: readonly MessageHeaderRow[],
): boolean {
  return (
    left.length === right.length &&
    left.every((header, index) => {
      const candidate = right[index]
      return (
        candidate?.id === header.id &&
        candidate.chatId === header.chatId &&
        candidate.parentId === header.parentId &&
        candidate.deleted === header.deleted
      )
    })
  )
}

function validSelectedPathHeaders(
  chatId: ChatId,
  pathHeaders: readonly MessageHeaderRow[],
): boolean {
  const ids = new Set<MessageId>()
  for (let index = 0; index < pathHeaders.length; index += 1) {
    const header = pathHeaders[index] as MessageHeaderRow
    const expectedParentId = index === 0 ? null : pathHeaders[index - 1]?.id
    if (
      header.chatId !== chatId ||
      header.deleted ||
      header.parentId !== expectedParentId ||
      ids.has(header.id)
    ) {
      return false
    }
    ids.add(header.id)
  }
  return true
}

function validStructuralHeaders(
  chatId: ChatId,
  structuralHeaders: readonly MessageHeaderRow[],
): boolean {
  const ids = new Set<MessageId>()
  for (const header of structuralHeaders) {
    if (header.chatId !== chatId || ids.has(header.id)) return false
    ids.add(header.id)
  }
  return true
}

function presentationMatchesPathHeader(
  chatId: ChatId,
  pathHeader: MessageHeaderRow,
  presentation: CommittedMessagePresentation,
): boolean {
  const { header, message } = presentation
  return (
    header.chatId === chatId &&
    message.chatId === chatId &&
    header.id === pathHeader.id &&
    message.id === header.id &&
    !header.deleted &&
    !message.deleted &&
    samePathStructure([pathHeader], [header]) &&
    message.parentId === header.parentId &&
    message.siblingIndex === header.siblingIndex &&
    message.nodeVersion === header.nodeVersion &&
    presentation.bodyVersion === header.bodyVersion
  )
}

function validCommittedMessagePresentation(
  chatId: ChatId,
  presentation: CommittedMessagePresentation,
): boolean {
  return presentationMatchesPathHeader(chatId, presentation.header, presentation)
}

function clearReceiptIfPathChanged(chatId: ChatId, cursor: Readonly<CursorMap>): void {
  const receipt = committedPathPresentations.get(chatId)?.receipt
  if (receipt && !cursorSelectsReceiptPath(cursor, receipt)) {
    const pending = pendingCommittedPathProducers.get(chatId)
    if (pending && pendingProducerCanPublish(chatId, pending)) return
    clearCommittedPathPresentation(chatId)
  }
}

function currentProducerReceipt(
  chatId: ChatId,
  producer: CommittedPathProducer,
): { branch: TabBranchState; receipt: CommittedPathPresentationReceipt } | undefined {
  const branch = branches.get(chatId)
  const committed = committedPathPresentations.get(chatId)
  const receipt = committed?.receipt
  if (
    !branch?.intent ||
    producer.chatId !== chatId ||
    committed?.producer !== producer ||
    !receipt ||
    receipt.revision !== branch.revision ||
    !cursorSelectsReceiptPath(branch.cursor, receipt)
  ) {
    return undefined
  }
  return { branch, receipt }
}

function pendingProducerCanPublish(chatId: ChatId, producer: CommittedPathProducer): boolean {
  return (
    producer.chatId === chatId &&
    pendingCommittedPathProducers.get(chatId) === producer &&
    branches.get(chatId)?.intent === producer.originIntent
  )
}

function clearPendingProducer(chatId: ChatId): void {
  pendingCommittedPathProducers.delete(chatId)
}

function presentationExtendsReceiptPath(
  receipt: CommittedPathPresentationReceipt,
  presentation: CommittedPathPresentationInput,
): boolean {
  if (presentation.pathHeaders.length < receipt.pathHeaders.length) return false
  return receipt.pathHeaders.every((committed, index) => {
    const next = presentation.pathHeaders[index]
    return next !== undefined && samePathIdentity([committed], [next])
  })
}

function validCommittedPathPresentationInput(
  chatId: ChatId,
  selections: Readonly<Record<string, MessageId>>,
  presentation: CommittedPathPresentationInput,
): boolean {
  if (!validSelectedPathHeaders(chatId, presentation.pathHeaders)) return false
  const structuralHeaders = completeStructuralHeaders(presentation)
  if (!validStructuralHeaders(chatId, structuralHeaders)) return false
  const pathById = new Map<MessageId, MessageHeaderRow>()
  for (let index = 0; index < presentation.pathHeaders.length; index += 1) {
    const header = presentation.pathHeaders[index] as MessageHeaderRow
    if (selections[header.parentId ?? '__root__'] !== header.id) {
      return false
    }
    pathById.set(header.id, header)
  }
  const presentationIds = new Set<MessageId>()
  for (const item of presentation.presentations) {
    const pathHeader = pathById.get(item.header.id)
    if (
      !pathHeader ||
      presentationIds.has(item.header.id) ||
      !presentationMatchesPathHeader(chatId, pathHeader, item) ||
      pathHeader.nodeVersion !== item.header.nodeVersion ||
      pathHeader.bodyVersion !== item.header.bodyVersion
    ) {
      return false
    }
    presentationIds.add(item.header.id)
  }
  return true
}

function presentationDoesNotRegressReceipt(
  receipt: CommittedPathPresentationReceipt,
  presentation: CommittedPathPresentationInput,
): boolean {
  const headerDoesNotRegress = (previous: MessageHeaderRow, next: MessageHeaderRow): boolean => {
    if (next.bodyVersion < previous.bodyVersion) return false
    const sameIdentity = samePathIdentity([previous], [next])
    if (!sameIdentity) return next.nodeVersion > previous.nodeVersion
    return next.nodeVersion >= previous.nodeVersion || next.bodyVersion === previous.bodyVersion
  }
  const sharedLength = Math.min(receipt.pathHeaders.length, presentation.pathHeaders.length)
  for (let index = 0; index < sharedLength; index += 1) {
    const previous = receipt.pathHeaders[index] as MessageHeaderRow
    const next = presentation.pathHeaders[index] as MessageHeaderRow
    if (previous.id !== next.id) break
    if (!headerDoesNotRegress(previous, next)) return false
  }
  const previousStructuralById = new Map(
    receipt.structuralHeaders.map((header) => [header.id, header]),
  )
  for (const next of completeStructuralHeaders(presentation)) {
    const previous = previousStructuralById.get(next.id)
    if (previous && !headerDoesNotRegress(previous, next)) return false
  }
  return true
}

function compatibleNewerHeader(
  previous: MessageHeaderRow | undefined,
  next: MessageHeaderRow,
): MessageHeaderRow {
  return previous &&
    previous.nodeVersion >= next.nodeVersion &&
    previous.bodyVersion === next.bodyVersion &&
    samePathIdentity([previous], [next])
    ? previous
    : next
}

function presentationWithCanonicalHeader(
  presentation: CommittedMessagePresentation,
  header: MessageHeaderRow,
): CommittedMessagePresentation {
  if (presentation.header === header) return presentation
  const {
    requestContextVersion: _requestContextVersion,
    bodyVersion,
    bodyWordCount: _bodyWordCount,
    textPreview: _textPreview,
    ...messageHeader
  } = header
  return {
    header,
    bodyVersion,
    message: { ...presentation.message, ...messageHeader },
  }
}

function mergeCommittedPresentationInput(
  receipt: CommittedPathPresentationReceipt | null,
  presentation: CommittedPathPresentationInput,
): CommittedPathPresentationInput {
  const nextStructuralHeaders = completeStructuralHeaders(presentation)
  const nextStructuralIds = new Set(nextStructuralHeaders.map((header) => header.id))
  if (!receipt) return { ...presentation, structuralHeaders: nextStructuralHeaders }
  const previousStructuralById = new Map(
    receipt.structuralHeaders.map((header) => [header.id, header]),
  )
  const previousPathById = new Map(receipt.pathHeaders.map((header) => [header.id, header]))
  const pathHeaders = presentation.pathHeaders.map((header) =>
    compatibleNewerHeader(previousPathById.get(header.id), header),
  )
  const pathHeaderById = new Map(pathHeaders.map((header) => [header.id, header]))
  const structuralHeaders = [
    ...receipt.structuralHeaders.filter((committed) => !nextStructuralIds.has(committed.id)),
    ...nextStructuralHeaders.map(
      (header) =>
        pathHeaderById.get(header.id) ??
        compatibleNewerHeader(previousStructuralById.get(header.id), header),
    ),
  ]
  const nextById = new Map(presentation.presentations.map((item) => [item.message.id, item]))
  const carriedById = new Map(receipt.presentations.map((item) => [item.message.id, item]))
  const presentations = pathHeaders.flatMap((header) => {
    const incoming = nextById.get(header.id)
    if (
      incoming &&
      incoming.bodyVersion === header.bodyVersion &&
      samePathIdentity([incoming.header], [header])
    ) {
      return [presentationWithCanonicalHeader(incoming, header)]
    }
    const carried = carriedById.get(header.id)
    if (
      carried &&
      carried.bodyVersion === header.bodyVersion &&
      samePathIdentity([carried.header], [header])
    ) {
      return [presentationWithCanonicalHeader(carried, header)]
    }
    return []
  })
  return {
    ...presentation,
    pathHeaders,
    structuralHeaders,
    presentations,
  }
}

function selectedBranchState(
  current: TabBranchState,
  intent: NavigationIntent,
  selections: Readonly<Record<string, MessageId>>,
  pendingPathMessageIds: readonly MessageId[] | undefined,
): TabBranchState {
  const cursorChanged = Object.entries(selections).some(
    ([parentKey, childId]) => current.cursor[parentKey] !== childId,
  )
  const path = pendingPathMessageIds?.length ? ownedPath(pendingPathMessageIds) : undefined
  const nextSelections = path?.at(-1) ? ownedSelections(selections) : undefined
  return {
    intent,
    revision: intent.revision,
    cursor: cursorChanged ? mergedCursor(current.cursor, selections) : current.cursor,
    ...(path && nextSelections
      ? {
          pending: Object.freeze({
            revision: intent.revision,
            selections: nextSelections,
            pathMessageIds: path,
          }),
        }
      : {}),
  }
}

export const useChatStore = create<ChatStoreState>((set) => {
  const publish = () => set((state) => ({ publication: state.publication + 1 }))

  return {
    publication: 0,
    getDebugStats: () => {
      let cursorEntryCount = 0
      for (const branch of branches.values()) {
        cursorEntryCount += persistentCursorSize(branch.cursor)
      }
      return { chatCursorCount: branches.size, cursorEntryCount }
    },
    getCursor: (chatId) => branches.get(chatId)?.cursor,
    getNavigationRevision: (chatId) => branches.get(chatId)?.revision ?? '0',
    getPendingBranchNavigation: (chatId) => {
      const branch = branches.get(chatId)
      return branch?.intent && branch.pending?.revision === branch.revision
        ? branch.pending
        : undefined
    },
    getCommittedPathPresentation: (chatId) => {
      const receipt = committedPathPresentations.get(chatId)?.receipt
      if (!receipt) return undefined
      const branch = branches.get(chatId)
      return branch &&
        branch.revision === receipt.revision &&
        cursorSelectsReceiptPath(branch.cursor, receipt)
        ? receipt
        : undefined
    },
    getCommittedMessagePresentation: (chatId) => committedMessagePresentations.get(chatId),
    beginCommittedPresentationFocus: (chatId) => {
      const focus = Object.freeze({
        chatId,
        [committedPresentationFocusBrand]: true as const,
      })
      committedPresentationFocus = focus
      return focus
    },
    endCommittedPresentationFocus: (focus) => {
      if (committedPresentationFocus === focus) committedPresentationFocus = null
    },
    setCommittedPresentationWindowLimit: (chatId, limit) => {
      const normalized = Math.max(1, Math.floor(limit))
      if (committedPresentationWindowLimits.get(chatId) === normalized) return
      committedPresentationWindowLimits.set(chatId, normalized)
      const committed = committedPathPresentations.get(chatId)
      if (!committed) return
      const { receipt } = committed
      const retainedIds = new Set(receipt.pathHeaders.slice(-normalized).map((header) => header.id))
      if (receipt.presentations.every((presentation) => retainedIds.has(presentation.message.id))) {
        return
      }
      committedPathPresentations.set(
        chatId,
        Object.freeze({
          receipt: ownedCommittedPathPresentation(chatId, receipt.revision, receipt, receipt),
          producer: committed.producer,
        }),
      )
      reconcileCommittedBodyRetention(chatId, false)
      publish()
    },
    isNavigationIntentCurrent: (intent) => isCurrent(intent.chatId, intent),
    beginNavigationIntent: (chatId) => {
      clearPendingProducer(chatId)
      const intent = createNavigationIntent(chatId)
      const current = branches.get(chatId)
      const cursor = current?.cursor ?? ownedCursor({})
      transferCommittedPathPresentation(chatId, current?.revision, intent, cursor)
      const pending = transferPendingBranchNavigation(current?.pending, intent, cursor)
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor,
        ...(pending ? { pending } : {}),
      })
      publish()
      return intent
    },
    navigateToCursor: (chatId, cursor) => {
      clearPendingProducer(chatId)
      const current = branches.get(chatId)
      const intent = createNavigationIntent(chatId)
      const cursorUnchanged = current !== undefined && cursorEqual(current.cursor, cursor)
      const nextCursor = cursorUnchanged ? current.cursor : ownedCursor(cursor)
      transferCommittedPathPresentation(chatId, current?.revision, intent, nextCursor)
      const pending = transferPendingBranchNavigation(current?.pending, intent, nextCursor)
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor: nextCursor,
        ...(pending ? { pending } : {}),
      })
      publish()
      return intent
    },
    navigateWithCursorPatch: (chatId, patch) => {
      clearPendingProducer(chatId)
      const current = branches.get(chatId)
      const cursor = patchPersistentCursor(current?.cursor ?? ownedCursor({}), patch)
      const intent = createNavigationIntent(chatId)
      transferCommittedPathPresentation(chatId, current?.revision, intent, cursor)
      const pending = transferPendingBranchNavigation(current?.pending, intent, cursor)
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor,
        ...(pending ? { pending } : {}),
      })
      publish()
      return intent
    },
    setCursorForIntent: (chatId, intent, cursor) => {
      const current = branches.get(chatId)
      if (!current || !isCurrent(chatId, intent)) return false
      const cursorUnchanged = cursorEqual(current.cursor, cursor)
      if (cursorUnchanged && !current.pending) return true
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor: cursorUnchanged ? current.cursor : ownedCursor(cursor),
      })
      clearReceiptIfPathChanged(chatId, cursor)
      publish()
      return true
    },
    patchCursorForIntent: (chatId, intent, patch) => {
      const current = branches.get(chatId)
      if (!current || !isCurrent(chatId, intent)) return false
      const cursor = patchPersistentCursor(current.cursor, patch)
      if (cursor === current.cursor && !current.pending) return true
      branches.set(chatId, {
        intent,
        revision: intent.revision,
        cursor,
      })
      clearReceiptIfPathChanged(chatId, cursor)
      publish()
      return true
    },
    reconcileCursor: (chatId, cursor) => {
      const current = branches.get(chatId)
      if (current && cursorEqual(current.cursor, cursor)) return
      branches.set(chatId, {
        intent: current?.intent ?? null,
        revision: current?.revision ?? '0',
        cursor: ownedCursor(cursor),
        ...(current?.pending ? { pending: current.pending } : {}),
      })
      clearReceiptIfPathChanged(chatId, cursor)
      publish()
    },
    reconcileCursorPatch: (chatId, patch) => {
      const current = branches.get(chatId)
      const cursor = patchPersistentCursor(current?.cursor ?? ownedCursor({}), patch)
      if (current && cursor === current.cursor) return
      branches.set(chatId, {
        intent: current?.intent ?? null,
        revision: current?.revision ?? '0',
        cursor,
        ...(current?.pending ? { pending: current.pending } : {}),
      })
      clearReceiptIfPathChanged(chatId, cursor)
      publish()
    },
    selectPathForIntent: (chatId, intent, selections, pendingPathMessageIds) => {
      const current = branches.get(chatId)
      if (!current || !isCurrent(chatId, intent)) return false
      const cursorChanged = Object.entries(selections).some(
        ([parentKey, childId]) => current.cursor[parentKey] !== childId,
      )
      if (
        !cursorChanged &&
        pendingEqual(current.pending, intent.revision, selections, pendingPathMessageIds)
      ) {
        return true
      }
      const next = selectedBranchState(current, intent, selections, pendingPathMessageIds)
      branches.set(chatId, next)
      clearReceiptIfPathChanged(chatId, next.cursor)
      publish()
      return true
    },
    registerCommittedPathProducer: (chatId, intent) => {
      if (intent.chatId !== chatId) return null
      if (consumedCommittedPathIntents.has(intent)) return null
      const pending = pendingCommittedPathProducers.get(chatId)
      if (pending?.originIntent === intent) return pending
      const active = committedPathPresentations.get(chatId)?.producer
      if (active?.originIntent === intent) return active
      if (!isCurrent(chatId, intent)) return null
      const producer = Object.freeze({
        chatId,
        originIntent: intent,
        [committedPathProducerBrand]: true as const,
      })
      pendingCommittedPathProducers.set(chatId, producer)
      return producer
    },
    selectCommittedPathForProducer: (chatId, producer, selections, presentation, cursorPatch) => {
      const current = branches.get(chatId)
      if (!current?.intent) return false
      if (!validCommittedPathPresentationInput(chatId, selections, presentation)) return false
      const pendingProducer = pendingProducerCanPublish(chatId, producer)
      const producerReceipt = currentProducerReceipt(chatId, producer)?.receipt
      if (!pendingProducer && !producerReceipt) return false
      if (producerReceipt?.phase === 'terminal') return false
      if (producerReceipt && !presentationExtendsReceiptPath(producerReceipt, presentation)) {
        return false
      }
      const committed = committedPathPresentations.get(chatId)
      if (
        committed?.receipt &&
        !presentationDoesNotRegressReceipt(committed.receipt, presentation)
      ) {
        return false
      }
      const nextPresentation = mergeCommittedPresentationInput(
        committed?.receipt ?? null,
        presentation,
      )
      const pathMessageIds = nextPresentation.pathHeaders.map((header) => header.id)
      const selectionBase = cursorPatch
        ? { ...current, cursor: patchPersistentCursor(current.cursor, cursorPatch) }
        : current
      branches.set(
        chatId,
        selectedBranchState(selectionBase, current.intent, selections, pathMessageIds),
      )
      committedPathPresentations.set(
        chatId,
        Object.freeze({
          receipt: ownedCommittedPathPresentation(
            chatId,
            current.revision,
            nextPresentation,
            committed?.receipt ?? null,
          ),
          producer: nextPresentation.phase === 'terminal' ? null : producer,
        }),
      )
      reconcileCommittedBodyRetention(chatId, true)
      if (pendingProducer) pendingCommittedPathProducers.delete(chatId)
      if (nextPresentation.phase === 'terminal') {
        consumedCommittedPathIntents.add(producer.originIntent)
      }
      publish()
      return true
    },
    updateCommittedMessageForProducer: (chatId, producer, presentation, phase) => {
      const owned = currentProducerReceipt(chatId, producer)
      if (!owned) return false
      const { receipt } = owned
      const pathIndex = receipt.pathHeaders.findIndex(
        (header) => header.id === presentation.header.id,
      )
      if (pathIndex < 0) return false
      const previousHeader = receipt.pathHeaders[pathIndex] as MessageHeaderRow
      if (
        !presentationMatchesPathHeader(chatId, previousHeader, presentation) ||
        presentation.header.nodeVersion < previousHeader.nodeVersion ||
        presentation.bodyVersion < previousHeader.bodyVersion
      ) {
        return false
      }
      const pathHeaders = [...receipt.pathHeaders]
      pathHeaders[pathIndex] = presentation.header
      const structuralHeaders = receipt.structuralHeaders.map((header) =>
        header.id === presentation.header.id ? presentation.header : header,
      )
      const presentations = receipt.presentations.filter(
        (currentPresentation) => currentPresentation.message.id !== presentation.message.id,
      )
      presentations.push(presentation)
      committedPathPresentations.set(
        chatId,
        Object.freeze({
          receipt: ownedCommittedPathPresentation(
            chatId,
            receipt.revision,
            {
              phase,
              pathHeaders,
              structuralHeaders,
              presentations,
            },
            receipt,
          ),
          producer: phase === 'terminal' ? null : producer,
        }),
      )
      reconcileCommittedBodyRetention(chatId, true)
      if (phase === 'terminal') consumedCommittedPathIntents.add(producer.originIntent)
      publish()
      return true
    },
    publishCommittedMessageMutation: (chatId, selectedPathHeaders, presentation) => {
      if (!validCommittedMessagePresentation(chatId, presentation)) return false
      const previousLocalPresentation = committedMessagePresentations.get(chatId)?.presentation
      if (
        previousLocalPresentation?.message.id === presentation.message.id &&
        (presentation.header.nodeVersion < previousLocalPresentation.header.nodeVersion ||
          presentation.bodyVersion < previousLocalPresentation.bodyVersion)
      ) {
        return false
      }
      const publishGenericPresentation = () => {
        retainCommittedMessagePresentation(
          chatId,
          ownedMessagePresentationReceipt(chatId, presentation),
        )
        publish()
        return true
      }
      const publishPathPresentation = () => {
        const pathReceipt = committedPathPresentations.get(chatId)?.receipt
        const pathCoversBody = pathReceipt?.presentations.some(
          (candidate) =>
            candidate.message.id === presentation.message.id &&
            candidate.bodyVersion === presentation.bodyVersion,
        )
        if (pathCoversBody) {
          const generic = committedMessagePresentations.get(chatId)
          if (generic?.presentation.message.id === presentation.message.id) {
            committedMessagePresentations.delete(chatId)
          }
          reconcileCommittedBodyRetention(chatId, true)
        } else {
          retainCommittedMessagePresentation(
            chatId,
            ownedMessagePresentationReceipt(chatId, presentation),
          )
        }
        publish()
        return true
      }
      const current = branches.get(chatId)
      if (
        !current ||
        !validSelectedPathHeaders(chatId, selectedPathHeaders) ||
        !cursorSelectsPath(current.cursor, selectedPathHeaders)
      ) {
        return publishGenericPresentation()
      }
      const selectedIndex = selectedPathHeaders.findIndex(
        (header) => header.id === presentation.message.id,
      )
      if (selectedIndex < 0) return publishGenericPresentation()
      const selectedHeader = selectedPathHeaders[selectedIndex] as MessageHeaderRow
      if (
        !presentationMatchesPathHeader(chatId, selectedHeader, presentation) ||
        presentation.header.nodeVersion < selectedHeader.nodeVersion ||
        presentation.bodyVersion < selectedHeader.bodyVersion
      ) {
        return publishGenericPresentation()
      }

      const committed = committedPathPresentations.get(chatId)
      const receipt = committed?.receipt
      if (
        receipt &&
        receipt.revision === current.revision &&
        cursorSelectsReceiptPath(current.cursor, receipt)
      ) {
        if (!samePathIdentity(receipt.pathHeaders, selectedPathHeaders)) {
          return publishGenericPresentation()
        }
        const receiptIndex = receipt.pathHeaders.findIndex(
          (header) => header.id === presentation.message.id,
        )
        if (receiptIndex < 0) return publishGenericPresentation()
        const previousHeader = receipt.pathHeaders[receiptIndex] as MessageHeaderRow
        if (
          presentation.header.nodeVersion < previousHeader.nodeVersion ||
          presentation.bodyVersion < previousHeader.bodyVersion
        ) {
          return publishGenericPresentation()
        }
        const input: CommittedPathPresentationInput = {
          phase: receipt.phase,
          pathHeaders: selectedPathHeaders.map((header, index) =>
            index === selectedIndex ? presentation.header : header,
          ),
          structuralHeaders: selectedPathHeaders,
          presentations: [presentation],
        }
        if (!presentationDoesNotRegressReceipt(receipt, input)) {
          return publishGenericPresentation()
        }
        const merged = mergeCommittedPresentationInput(receipt, input)
        committedPathPresentations.set(
          chatId,
          Object.freeze({
            receipt: ownedCommittedPathPresentation(chatId, receipt.revision, merged, receipt),
            producer: committed.producer,
          }),
        )
        return publishPathPresentation()
      }

      if (receipt?.phase === 'open') return publishGenericPresentation()
      const pathHeaders = selectedPathHeaders.map((header, index) =>
        index === selectedIndex ? presentation.header : header,
      )
      if (!pathHeaders.at(-1)) return publishGenericPresentation()
      committedPathPresentations.set(
        chatId,
        Object.freeze({
          receipt: ownedCommittedPathPresentation(
            chatId,
            current.revision,
            {
              phase: 'terminal',
              pathHeaders,
              structuralHeaders: pathHeaders,
              presentations: [presentation],
            },
            null,
          ),
          producer: null,
        }),
      )
      return publishPathPresentation()
    },
    sealCommittedPathProducer: (chatId, producer) => {
      if (pendingCommittedPathProducers.get(chatId) === producer) {
        pendingCommittedPathProducers.delete(chatId)
        const receipt = committedPathPresentations.get(chatId)?.receipt
        const cursor = branches.get(chatId)?.cursor
        if (receipt && cursor && !cursorSelectsReceiptPath(cursor, receipt)) {
          clearCommittedPathPresentation(chatId)
        }
        consumedCommittedPathIntents.add(producer.originIntent)
        return true
      }
      const owned = currentProducerReceipt(chatId, producer)
      if (!owned) return false
      const { receipt } = owned
      if (receipt.phase === 'terminal') return true
      if (receipt.presentations.length === 0) {
        committedPathPresentations.delete(chatId)
        committedBodyRetention.delete(chatId)
        consumedCommittedPathIntents.add(producer.originIntent)
        publish()
        return true
      }
      committedPathPresentations.set(
        chatId,
        Object.freeze({
          receipt: Object.freeze({ ...receipt, phase: 'terminal' }),
          producer: null,
        }),
      )
      consumedCommittedPathIntents.add(producer.originIntent)
      publish()
      return true
    },
    acknowledgePendingBranchNavigation: (chatId, pending) => {
      const current = branches.get(chatId)
      if (!current || current.pending !== pending) return
      branches.set(chatId, {
        intent: current.intent,
        revision: current.revision,
        cursor: current.cursor,
      })
      publish()
    },
    acknowledgeCommittedPathPresentation: (chatId, receipt) => {
      if (
        committedPathPresentations.get(chatId)?.receipt !== receipt ||
        receipt.chatId !== chatId
      ) {
        return
      }
      clearCommittedPathPresentation(chatId)
      publish()
    },
    acknowledgeCommittedMessagePresentation: (chatId, receipt) => {
      if (committedMessagePresentations.get(chatId) !== receipt || receipt.chatId !== chatId) return
      committedMessagePresentations.delete(chatId)
      reconcileCommittedBodyRetention(chatId, false)
      publish()
    },
    clearCursor: (chatId) => {
      const current = branches.get(chatId)
      const hadBranch = branches.delete(chatId)
      const hadPresentationLimit = committedPresentationWindowLimits.delete(chatId)
      const hadCommittedPresentation = committedPathPresentations.delete(chatId)
      const hadCommittedMessagePresentation = committedMessagePresentations.delete(chatId)
      committedBodyRetention.delete(chatId)
      const hadPendingProducer = pendingCommittedPathProducers.delete(chatId)
      if (
        !hadBranch &&
        !hadPresentationLimit &&
        !hadCommittedPresentation &&
        !hadCommittedMessagePresentation &&
        !hadPendingProducer
      ) {
        return
      }
      if (current?.intent && isTabNavigationCurrent(current.intent[navigationAuthority])) {
        invalidateTabNavigation()
      }
      publish()
    },
    resetForWorkspaceReplacement: () => {
      branches.clear()
      committedPresentationWindowLimits.clear()
      committedPathPresentations.clear()
      committedMessagePresentations.clear()
      committedBodyRetention.clear()
      pendingCommittedPathProducers.clear()
      publish()
    },
    reset: () => {
      branches.clear()
      committedPresentationWindowLimits.clear()
      committedPathPresentations.clear()
      committedMessagePresentations.clear()
      committedBodyRetention.clear()
      pendingCommittedPathProducers.clear()
      committedPresentationFocus = null
      invalidateTabNavigation()
      publish()
    },
  }
})

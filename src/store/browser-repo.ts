import Dexie, { type Collection, type Table, type Transaction } from 'dexie'
import { type ActivePathMeasurement, activePath, findLastUpdatedLeafId } from '../core/active-path'
import { buildBranchCacheRow } from '../core/branch-flatten'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  AttachmentReferenceEdge,
  Chat,
  ChatBranchCache,
  ChatFolder,
  ChatId,
  ChatTag,
  ChatVersions,
  ChildListState,
  DraftRow,
  FolderId,
  Message,
  MessageAttachmentRef,
  MessageId,
  MutationScope,
  PresetId,
  TagId,
} from '../core/types'
import { countMessagesWords } from '../core/word-count'
import { newId } from '../lib/ulid'
import {
  attachmentReferenceCounts,
  edgesForOwner,
  replaceAttachmentReferenceOwner,
  replaceAttachmentReferenceOwners,
  requireNoAttachmentReferences,
} from './attachment-reference-edges'
import { liveAttachmentRefs, normalizeAttachmentRefs } from './attachment-refs'
import {
  type AttachmentHeaderRow,
  attachmentHeaderFromStoredRow,
  hydrateAttachment,
  splitAttachmentForStorage,
} from './attachment-storage'
import { postEvent } from './broadcast'
import {
  createChatInBrowser,
  deletePresetAndClearBreadcrumbsInBrowser,
  deleteProfileAndReassignInBrowser,
  deletePromptPresetAndClearPinsInBrowser,
  discardEmptyDraftChatsInBrowser,
  updateProfileAndInvalidateCachesInBrowser,
  updatePromptPresetAndPropagateInBrowser,
} from './browser-domain-mutations'
import { deleteChatSidebarProjections, putChatSidebarProjection } from './chat-sidebar-projection'
import { childListKey, type NatterDb, openDb } from './db'
import { withMutationLocks, withNamedLock, withNamedLocks } from './locks'
import {
  contentIncludesCaseInsensitiveText,
  hydrateMessage,
  hydrateMessages,
  type MessageBodyRow,
  type MessageHeaderRow,
  previewTextFromContent,
  previewTextFromMessages,
  previewTextFromStoredProjection,
  splitMessageForStorage,
  syncMessageHeaderProjections,
} from './message-storage'
import type {
  ActiveBranchBodyWindow,
  ActiveBranchSnapshot,
  ActiveBranchWindowSnapshot,
  AppendMessageToExpectedLeafInput,
  AppendMessageToExpectedLeafResult,
  AttachmentBundle,
  AttachmentSearchMeasurement,
  AttachmentSearchPage,
  AttachmentSearchQuery,
  BranchHeaderSnapshot,
  ChatBranchCacheWriteGuard,
  ChatMutationSummary,
  CreateFolderInput,
  CreateTagInput,
  DeleteArchivedChatsResult,
  DeleteFolderResult,
  DeletePresetCascadeResult,
  DeleteProfileAtomicInput,
  DeleteProfileAtomicResult,
  DeletePromptPresetAtomicInput,
  DeletePromptPresetAtomicResult,
  DeleteTagResult,
  ForkChatFromMessageInput,
  ForkChatFromMessageResult,
  MessageBodyPatch,
  MessageHeaderPatch,
  MutationContext,
  PatchMessageBodyOptions,
  PutMessageOptions,
  StreamChunkRow,
  StreamLeaseRow,
  StreamWriteFence,
  UpdateFolderInput,
  UpdateProfileAtomicInput,
  UpdateProfileAtomicResult,
  UpdatePromptPresetAtomicInput,
  UpdatePromptPresetAtomicResult,
  UpdateTagInput,
  WorkspaceMeta,
  WorkspaceMutationOptions,
  WorkspaceMutationResult,
  WorkspaceRepository,
} from './repository'
import {
  ChatMissingError,
  chatMatchesBranchCacheWriteGuard,
  ExpectedLeafChangedError,
  StreamChatBusyError,
  StreamTargetBusyError,
} from './repository'
import {
  bumpBrowserWorkspaceMeta,
  readBrowserWorkspaceMeta,
  readBrowserWorkspaceMetaFromTransaction,
} from './workspace-meta'

export { ChatMissingError } from './repository'

interface ChatMutationState {
  beforeChat: Chat
  beforeHeaders?: MessageHeaderRow[]
  afterHeaders?: MessageHeaderRow[]
  headersBeforeWrites: Map<MessageId, MessageHeaderRow | undefined>
  incrementalAppends: Message[]
  wordCountDeltas: Map<MessageId, number>
  totalCostDelta: number
  visibleMetaPatch: Partial<Chat>
  hiddenMetaPatch: Partial<Chat>
  summaryPatch: Partial<Chat>
  visibleMetaDirty: boolean
  summaryVersionDirty: boolean
  messageSummaryDirty: boolean
  previewDirty: boolean
  broadcast: boolean
  changedMessageIds: Set<MessageId>
  affected: Map<string, ChatMutationSummary>
}

type BrowserMutationTableName =
  | 'attachmentArtifacts'
  | 'attachmentBlobs'
  | 'attachmentJobs'
  | 'attachmentRefEdges'
  | 'attachments'
  | 'chatBranchCache'
  | 'chatSidebarRows'
  | 'chats'
  | 'childLists'
  | 'drafts'
  | 'messages'
  | 'messageBodies'
  | 'settings'
  | 'streamLeases'

const MUTATION_TABLE_ORDER: readonly BrowserMutationTableName[] = [
  'attachmentArtifacts',
  'attachmentBlobs',
  'attachmentJobs',
  'attachmentRefEdges',
  'attachments',
  'chatBranchCache',
  'chatSidebarRows',
  'chats',
  'childLists',
  'drafts',
  'messages',
  'messageBodies',
  'settings',
  'streamLeases',
]

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

function streamOwnedMessageFieldsChanged(
  existingHeader: MessageHeaderRow,
  existingBody: MessageBodyRow,
  nextHeader: MessageHeaderRow,
  nextBody: MessageBodyRow,
): boolean {
  const comparableHeader = (header: MessageHeaderRow) => {
    const { nodeVersion, hiddenFromContext, attachmentRefs, cachedMediaTokens, ...value } = header
    void nodeVersion
    void hiddenFromContext
    void attachmentRefs
    void cachedMediaTokens
    return value
  }
  const comparableBody = (body: MessageBodyRow) => {
    const { nodeVersion, updatedAt, ...value } = body
    void nodeVersion
    void updatedAt
    return value
  }
  return (
    stableStringify(comparableHeader(existingHeader)) !==
      stableStringify(comparableHeader(nextHeader)) ||
    stableStringify(comparableBody(existingBody)) !== stableStringify(comparableBody(nextBody))
  )
}

async function assertStreamLeaseTargetAvailable(
  tx: Transaction,
  incoming: StreamLeaseRow,
): Promise<void> {
  if (!incoming.messageId) return
  const competing = await tx
    .table<StreamLeaseRow, string>('streamLeases')
    .where('messageId')
    .equals(incoming.messageId)
    .toArray()
  for (const lease of competing) {
    if (lease.streamId === incoming.streamId) continue
    if (await streamLeaseTargetFinalized(tx, lease)) continue
    throw new StreamTargetBusyError(incoming.messageId)
  }
}

async function assertStreamLeaseChatAdmissionAvailable(
  tx: Transaction,
  incoming: StreamLeaseRow,
): Promise<void> {
  const competing = await tx
    .table<StreamLeaseRow, string>('streamLeases')
    .where('chatId')
    .equals(incoming.chatId)
    .toArray()
  for (const lease of competing) {
    if (lease.streamId === incoming.streamId) continue
    if (incoming.exclusiveChat !== true && lease.exclusiveChat !== true) continue
    if (await streamLeaseTargetFinalized(tx, lease)) continue
    throw new StreamChatBusyError(incoming.chatId, lease.streamId)
  }
}

async function streamLeaseTargetFinalized(
  tx: Transaction,
  lease: StreamLeaseRow,
): Promise<boolean> {
  if (!lease.messageId) return false
  const header = await tx.table<MessageHeaderRow, MessageId>('messages').get(lease.messageId)
  if (lease.attemptKind === 'generation') return header?.generation?.finishedAt !== undefined
  if (lease.attemptKind !== 'continuation') return false
  const body = await tx.table<MessageBodyRow, MessageId>('messageBodies').get(lease.messageId)
  return body?.continuationAttempts?.some((attempt) => attempt.streamId === lease.streamId) === true
}

function isStreamLeaseRow(value: unknown): value is StreamLeaseRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<Record<keyof StreamLeaseRow, unknown>>
  return (
    typeof row.streamId === 'string' &&
    typeof row.chatId === 'string' &&
    (row.messageId === undefined || typeof row.messageId === 'string') &&
    typeof row.ownerClientId === 'string' &&
    typeof row.startedAt === 'number' &&
    Number.isFinite(row.startedAt) &&
    typeof row.heartbeatAt === 'number' &&
    Number.isFinite(row.heartbeatAt) &&
    (row.attemptKind === undefined ||
      row.attemptKind === 'generation' ||
      row.attemptKind === 'continuation') &&
    (row.continuationStrategy === undefined ||
      row.continuationStrategy === 'prompt' ||
      row.continuationStrategy === 'prefill') &&
    (row.baseNodeVersion === undefined ||
      (typeof row.baseNodeVersion === 'number' &&
        Number.isSafeInteger(row.baseNodeVersion) &&
        row.baseNodeVersion >= 0)) &&
    (row.requestedModel === undefined || typeof row.requestedModel === 'string') &&
    (row.exclusiveChat === undefined || row.exclusiveChat === true) &&
    (row.apiUsed === undefined ||
      row.apiUsed === 'chat' ||
      row.apiUsed === 'responses' ||
      row.apiUsed === 'gemini-native' ||
      row.apiUsed === 'anthropic-messages' ||
      row.apiUsed === 'completion' ||
      row.apiUsed === 'video-generation')
  )
}

function requiredStreamFence(lease: StreamLeaseRow): StreamWriteFence {
  if (
    typeof lease.fenceToken !== 'string' ||
    !Number.isSafeInteger(lease.replacementEpoch) ||
    (lease.replacementEpoch ?? -1) < 0
  ) {
    throw new Error(`StreamFenceMissing:${lease.streamId}`)
  }
  return {
    ownerClientId: lease.ownerClientId,
    fenceToken: lease.fenceToken,
    replacementEpoch: lease.replacementEpoch as number,
  }
}

function requiredChunkFence(
  chunk: StreamChunkRow,
): Pick<StreamWriteFence, 'fenceToken' | 'replacementEpoch'> {
  if (
    typeof chunk.fenceToken !== 'string' ||
    !Number.isSafeInteger(chunk.replacementEpoch) ||
    (chunk.replacementEpoch ?? -1) < 0
  ) {
    throw new Error(`StreamFenceMissing:${chunk.streamId}`)
  }
  return {
    fenceToken: chunk.fenceToken,
    replacementEpoch: chunk.replacementEpoch as number,
  }
}

function assertOwnedStreamFence(
  lease: StreamLeaseRow | undefined,
  fence: StreamWriteFence,
  replacementEpoch: number,
  streamId: string,
): asserts lease is StreamLeaseRow {
  if (
    !lease ||
    lease.ownerClientId !== fence.ownerClientId ||
    lease.fenceToken !== fence.fenceToken ||
    lease.replacementEpoch !== fence.replacementEpoch ||
    replacementEpoch !== fence.replacementEpoch
  ) {
    throw new Error(`StreamFenceLost:${streamId}`)
  }
}

function isStreamChunkRow(value: unknown): value is StreamChunkRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<StreamChunkRow>
  return (
    typeof row.id === 'string' &&
    typeof row.streamId === 'string' &&
    typeof row.chatId === 'string' &&
    typeof row.messageId === 'string' &&
    typeof row.seq === 'number' &&
    Number.isFinite(row.seq) &&
    typeof row.createdAt === 'number' &&
    Number.isFinite(row.createdAt) &&
    'event' in row
  )
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

function changedPatch<Row extends object>(
  current: Partial<Row>,
  patch: Partial<Row>,
): Partial<Row> | null {
  const next: Partial<Row> = {}
  let changed = false
  for (const key of Object.keys(patch) as Array<keyof Row>) {
    const value = patch[key]
    if (valuesEqual(current[key], value)) continue
    next[key] = value
    changed = true
  }
  return changed ? next : null
}

function cloneMessage(message: Message): Message {
  const cloned = structuredClone(message)
  cloned.attachmentRefs = normalizeAttachmentRefs(cloned.attachmentRefs, {
    messageId: cloned.id,
    createdAt: cloned.createdAt,
  })
  return cloned
}

function cloneMessageHeader(message: MessageHeaderRow): MessageHeaderRow {
  const cloned = structuredClone(message)
  cloned.attachmentRefs = normalizeAttachmentRefs(cloned.attachmentRefs, {
    messageId: cloned.id,
    createdAt: cloned.createdAt,
  })
  return cloned
}

function branchWindowRange(
  total: number,
  window: ActiveBranchBodyWindow,
): { start: number; end: number; limit: number } {
  const limit = Math.max(0, Math.floor(window.limit))
  const offset = Math.floor(window.offset)
  const start = offset < 0 ? Math.max(0, total - limit) : Math.max(0, Math.min(total, offset))
  return { start, end: Math.min(total, start + limit), limit }
}

async function listChildHeaderRows(
  table: Table<MessageHeaderRow, MessageId>,
  chatId: ChatId,
  parentId: MessageId | null,
): Promise<MessageHeaderRow[]> {
  if (parentId === null) {
    return table
      .where('chatId')
      .equals(chatId)
      .filter((row) => row.parentId === null)
      .toArray()
  }
  return table
    .where('[chatId+parentId]')
    .equals([chatId, parentId] as never)
    .toArray()
}

function nextSiblingIndex(headers: readonly Pick<MessageHeaderRow, 'siblingIndex'>[]): number {
  let highest = -1
  for (const header of headers) highest = Math.max(highest, header.siblingIndex)
  return highest + 1
}

function applyMessageBodyPatch(body: MessageBodyRow, patch: MessageBodyPatch): MessageBodyRow {
  const next = structuredClone(body)
  if ('content' in patch) {
    if (patch.content === undefined) throw new Error(`MessageBodyPatchMissingContent:${body.id}`)
    next.content = structuredClone(patch.content)
  }
  if ('reasoningDetails' in patch) {
    if (patch.reasoningDetails === undefined) delete next.reasoningDetails
    else next.reasoningDetails = structuredClone(patch.reasoningDetails)
  }
  if ('toolCalls' in patch) {
    if (patch.toolCalls === undefined) delete next.toolCalls
    else next.toolCalls = structuredClone(patch.toolCalls)
  }
  if ('refusal' in patch) {
    if (patch.refusal === undefined) delete next.refusal
    else next.refusal = patch.refusal
  }
  if ('phase' in patch) {
    if (patch.phase === undefined) delete next.phase
    else next.phase = patch.phase
  }
  if ('responsesEchoItem' in patch) {
    if (patch.responsesEchoItem === undefined) delete next.responsesEchoItem
    else next.responsesEchoItem = structuredClone(patch.responsesEchoItem)
  }
  if ('providerOutputItems' in patch) {
    if (patch.providerOutputItems === undefined) delete next.providerOutputItems
    else next.providerOutputItems = structuredClone(patch.providerOutputItems)
  }
  if ('continuationAttempts' in patch) {
    if (patch.continuationAttempts === undefined) delete next.continuationAttempts
    else next.continuationAttempts = structuredClone(patch.continuationAttempts)
  }
  return next
}

function replacementMessageBody(
  header: MessageHeaderRow,
  patch: MessageBodyPatch,
  options: { nodeVersion: number; updatedAt: number },
): MessageBodyRow {
  if (!('content' in patch) || patch.content === undefined) {
    throw new Error(`MessageBodyPatchMissingContent:${header.id}`)
  }
  const body: MessageBodyRow = {
    id: header.id,
    chatId: header.chatId,
    nodeVersion: options.nodeVersion,
    updatedAt: options.updatedAt,
    content: structuredClone(patch.content),
  }
  if (patch.reasoningDetails !== undefined) {
    body.reasoningDetails = structuredClone(patch.reasoningDetails)
  }
  if (patch.toolCalls !== undefined) body.toolCalls = structuredClone(patch.toolCalls)
  if (patch.refusal !== undefined) body.refusal = patch.refusal
  if (patch.phase !== undefined) body.phase = patch.phase
  if (patch.responsesEchoItem !== undefined) {
    body.responsesEchoItem = structuredClone(patch.responsesEchoItem)
  }
  if (patch.providerOutputItems !== undefined) {
    body.providerOutputItems = structuredClone(patch.providerOutputItems)
  }
  if (patch.continuationAttempts !== undefined) {
    body.continuationAttempts = structuredClone(patch.continuationAttempts)
  }
  return body
}

const FORBIDDEN_MESSAGE_HEADER_PATCH_KEYS = new Set<keyof MessageHeaderRow>([
  'id',
  'chatId',
  'parentId',
  'siblingIndex',
  'turnId',
  'turnIndex',
  'createdAt',
  'role',
  'origin',
  'nodeVersion',
  'deleted',
  'textPreview',
])

function applyMessageHeaderPatch(
  header: MessageHeaderRow,
  patch: MessageHeaderPatch | undefined,
): MessageHeaderRow {
  const next = cloneMessageHeader(header)
  if (!patch) return next
  for (const key of Object.keys(patch) as Array<keyof MessageHeaderRow>) {
    if (FORBIDDEN_MESSAGE_HEADER_PATCH_KEYS.has(key)) {
      throw new Error(`MessageHeaderPatchForbidden:${header.id}:${String(key)}`)
    }
    const value = patch[key]
    if (value === undefined) delete next[key]
    else next[key] = structuredClone(value) as never
  }
  return next
}

function hydrateStoredMessage(header: MessageHeaderRow, body: MessageBodyRow): Message {
  return hydrateMessage(cloneMessageHeader(header), body)
}

async function hydrateStoredMessages(
  headers: readonly MessageHeaderRow[],
  bodyTable: Table<MessageBodyRow, MessageId>,
): Promise<Message[]> {
  const bodies = (await bodyTable.bulkGet(headers.map((header) => header.id))).filter(
    (row): row is MessageBodyRow => row !== undefined,
  )
  return hydrateMessages(headers.map(cloneMessageHeader), bodies)
}

async function listMessagesInTransaction(tx: Transaction, chatId: ChatId): Promise<Message[]> {
  const headers = await tx
    .table<MessageHeaderRow, MessageId>('messages')
    .where('chatId')
    .equals(chatId)
    .toArray()
  return hydrateStoredMessages(headers, tx.table<MessageBodyRow, MessageId>('messageBodies'))
}

async function chatPreviewInTransaction(tx: Transaction, chatId: ChatId): Promise<string> {
  const header = await tx
    .table<MessageHeaderRow, MessageId>('messages')
    .where('[chatId+createdAt]')
    .between([chatId, Dexie.minKey], [chatId, Dexie.maxKey])
    .filter((row) => !row.deleted && row.role === 'user')
    .first()
  if (!header) return ''
  const body = await tx.table<MessageBodyRow, MessageId>('messageBodies').get(header.id)
  return previewTextFromContent(body?.content ?? [])
}

function branchHeadersByLeaf(
  headers: readonly MessageHeaderRow[],
  leafId: MessageId | null,
): MessageHeaderRow[] {
  if (leafId === null) return []
  const byId = new Map(headers.map((header) => [header.id, header]))
  const branch: MessageHeaderRow[] = []
  let cursor: MessageId | null = leafId
  while (cursor !== null) {
    const header = byId.get(cursor)
    if (!header || header.deleted) break
    branch.push(header)
    cursor = header.parentId
  }
  branch.reverse()
  return branch
}

function messageHeaderTreeKey(headers: readonly MessageHeaderRow[]): string {
  return headers
    .map((message) =>
      [
        message.id,
        message.nodeVersion,
        message.parentId ?? '',
        message.siblingIndex,
        message.createdAt,
        message.deleted ? 1 : 0,
      ].join(':'),
    )
    .join('|')
}

function siblingGroupsForBranch(
  headers: readonly MessageHeaderRow[],
  branchHeaders: readonly MessageHeaderRow[],
): ActiveBranchSnapshot['siblingGroups'] {
  const parentIds = new Set<MessageId | null>([null])
  for (const header of branchHeaders) parentIds.add(header.parentId)
  const byParent = new Map<MessageId | null, MessageHeaderRow[]>()
  for (const header of headers) {
    if (!parentIds.has(header.parentId)) continue
    const bucket = byParent.get(header.parentId)
    if (bucket) bucket.push(header)
    else byParent.set(header.parentId, [header])
  }
  for (const bucket of byParent.values()) {
    bucket.sort((left, right) => left.siblingIndex - right.siblingIndex)
  }
  return [...parentIds].map((parentId) => ({
    parentId,
    siblings: (byParent.get(parentId) ?? []).map(cloneMessageHeader),
  }))
}

function cloneDraft(draft: DraftRow): DraftRow {
  const cloned = structuredClone(draft)
  cloned.attachmentRefs = normalizeAttachmentRefs(cloned.attachmentRefs, {
    draftChatId: cloned.chatId,
    createdAt: cloned.updatedAt,
  })
  return cloned
}

async function hydrateStoredAttachment(
  header: AttachmentHeaderRow,
  artifacts: Table<AttachmentArtifact, string>,
): Promise<Attachment> {
  return hydrateAttachment(header, await artifacts.bulkGet(header.artifactIds))
}

function replaceMessageHeader(messages: MessageHeaderRow[], nextMessage: MessageHeaderRow): void {
  const next = cloneMessageHeader(nextMessage)
  const index = messages.findIndex((message) => message.id === next.id)
  if (index === -1) {
    messages.push(next)
    return
  }
  messages[index] = next
}

function removeMessageHeader(messages: MessageHeaderRow[], messageId: MessageId): void {
  const index = messages.findIndex((message) => message.id === messageId)
  if (index === -1) return
  messages.splice(index, 1)
}

function messageCost(message: Message): number {
  return message.deleted ? 0 : (message.generation?.cost ?? 0)
}

function recordMessageSummaryDeltas(
  state: ChatMutationState | undefined,
  messageId: MessageId,
  before: Message,
  after: Message,
): void {
  if (!state) return
  const delta = countMessagesWords([after]) - countMessagesWords([before])
  state.wordCountDeltas.set(messageId, (state.wordCountDeltas.get(messageId) ?? 0) + delta)
  state.totalCostDelta += messageCost(after) - messageCost(before)
}

function recordNewMessageSummary(state: ChatMutationState, message: Message): void {
  state.wordCountDeltas.set(message.id, countMessagesWords([message]))
  state.totalCostDelta += messageCost(message)
}

function computeTotalCostUsd(messages: readonly Pick<Message, 'deleted' | 'generation'>[]): number {
  let total = 0
  for (const message of messages) {
    if (message.deleted) continue
    total += message.generation?.cost ?? 0
  }
  return total
}

function stripMetaPatch(patch: Partial<Chat>): Partial<Chat> {
  const next = { ...patch }
  delete next.updatedAt
  delete next.wordCount
  delete next.totalCostUsd
  delete next.lastUpdatedLeafId
  delete next.lastBranchUpdatedAt
  delete next.summaryVersion
  delete next.metaVersion
  return next
}

function stripSummaryPatch(patch: Partial<Chat>): Partial<Chat> {
  const next = { ...patch }
  delete next.updatedAt
  delete next.metaVersion
  delete next.summaryVersion
  delete next.settings
  delete next.title
  delete next.titleStatus
  delete next.archived
  delete next.pinned
  delete next.folderId
  delete next.tags
  delete next.presetId
  return next
}

function attachmentSearchText(
  attachment: AttachmentHeaderRow,
  artifacts: readonly AttachmentArtifact[],
): string {
  return [
    attachment.id,
    attachment.contentHash,
    attachment.kind,
    attachment.mime,
    attachment.filename,
    attachment.extension,
    attachment.origin,
    attachment.sourceUrl,
    attachment.storage.kind,
    ...attachment.processing.map((state) => state.processorId),
    ...artifacts.flatMap((artifact) => [
      artifact.artifactId,
      artifact.kind,
      artifact.processorId,
      artifact.kind === 'text' ? artifact.text : undefined,
      artifact.kind === 'json' ? JSON.stringify(artifact.value) : undefined,
    ]),
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('\n')
    .toLowerCase()
}

function attachmentSorter(
  sort: AttachmentSearchQuery['sort'],
): (left: AttachmentHeaderRow, right: AttachmentHeaderRow) => number {
  const resolvedSort = sort ?? 'created-desc'
  return (left, right) =>
    compareAttachmentSortTuples(
      attachmentSortValue(left, resolvedSort),
      left.id,
      attachmentSortValue(right, resolvedSort),
      right.id,
      resolvedSort,
    )
}

type AttachmentSearchSort = NonNullable<AttachmentSearchQuery['sort']>
type AttachmentSearchIndex = AttachmentSearchMeasurement['selectedIndex']

const ATTACHMENT_SEARCH_CURSOR_PREFIX = 'natter-attachment-search:v1:'
const ATTACHMENT_SEARCH_CURSOR_FAMILY = 'natter-attachment-search:'
const ATTACHMENT_ARTIFACT_ID_BATCH = 500
const ATTACHMENT_SEARCH_ABORT_CHECK_INTERVAL = 256

interface AttachmentCursorTuple {
  sort: AttachmentSearchSort
  value: number
  id: AttachmentId
}

interface AttachmentIndexCandidate {
  index: Exclude<AttachmentSearchIndex, 'createdAt' | 'updatedAt' | 'primary'>
  collection: Collection<Attachment, AttachmentId>
  count: number
}

async function loadAttachmentSearchMetadata(
  table: Table<Attachment, AttachmentId>,
  query: AttachmentSearchQuery,
  sort: AttachmentSearchSort,
  measurement: AttachmentSearchMeasurement,
): Promise<AttachmentHeaderRow[]> {
  const filters = query.filters
  if (
    filters?.minRefCount !== undefined &&
    filters.maxRefCount !== undefined &&
    filters.minRefCount > filters.maxRefCount
  ) {
    measurement.selectedIndex = 'refCount'
    measurement.indexCounts.refCount = 0
    return []
  }
  const candidates: Array<{
    index: AttachmentIndexCandidate['index']
    collection: Collection<Attachment, AttachmentId>
  }> = []
  if (filters?.kind) {
    candidates.push({ index: 'kind', collection: table.where('kind').equals(filters.kind) })
  }
  if (filters?.mime) {
    candidates.push({ index: 'mime', collection: table.where('mime').equals(filters.mime) })
  }
  if (filters?.origin) {
    candidates.push({ index: 'origin', collection: table.where('origin').equals(filters.origin) })
  }
  if (filters?.minRefCount !== undefined || filters?.maxRefCount !== undefined) {
    candidates.push({
      index: 'refCount',
      collection: table
        .where('refCount')
        .between(
          filters.minRefCount ?? Dexie.minKey,
          filters.maxRefCount ?? Dexie.maxKey,
          true,
          true,
        ),
    })
  }

  let selected: AttachmentIndexCandidate | undefined
  if (candidates.length === 1) {
    const candidate = candidates[0]
    if (candidate) selected = { ...candidate, count: 0 }
  } else {
    for (const candidate of candidates) {
      throwIfAttachmentSearchAborted(query.signal)
      const count = await candidate.collection.count()
      throwIfAttachmentSearchAborted(query.signal)
      measurement.indexCounts[candidate.index] = count
      if (!selected || count < selected.count) selected = { ...candidate, count }
    }
  }

  let collection: Collection<Attachment, AttachmentId>
  if (selected) {
    measurement.selectedIndex = selected.index
    collection = selected.collection
  } else if (sort === 'created-asc' || sort === 'created-desc') {
    measurement.selectedIndex = 'createdAt'
    const ordered = table.orderBy('createdAt')
    collection = sort === 'created-desc' ? ordered.reverse() : ordered
  } else if (sort === 'updated-desc') {
    measurement.selectedIndex = 'updatedAt'
    collection = table.orderBy('updatedAt').reverse()
  } else {
    measurement.selectedIndex = 'primary'
    collection = table.toCollection()
  }

  const rows = await collection.toArray()
  throwIfAttachmentSearchAborted(query.signal)
  measurement.metadataRowsRead = rows.length
  return rows.map(attachmentHeaderFromStoredRow)
}

function attachmentMatchesFilters(
  attachment: AttachmentHeaderRow,
  query: AttachmentSearchQuery,
): boolean {
  const filters = query.filters
  if (filters?.kind && attachment.kind !== filters.kind) return false
  if (filters?.mime && attachment.mime !== filters.mime) return false
  if (filters?.origin && attachment.origin !== filters.origin) return false
  if (filters?.storageKind && attachment.storage.kind !== filters.storageKind) return false
  if (filters?.minSizeBytes !== undefined && (attachment.sizeBytes ?? 0) < filters.minSizeBytes) {
    return false
  }
  if (filters?.maxSizeBytes !== undefined && (attachment.sizeBytes ?? 0) > filters.maxSizeBytes) {
    return false
  }
  if (filters?.minRefCount !== undefined && attachment.refCount < filters.minRefCount) return false
  if (filters?.maxRefCount !== undefined && attachment.refCount > filters.maxRefCount) return false
  return true
}

async function loadCandidateAttachmentArtifacts(
  table: Table<AttachmentArtifact, string>,
  attachmentIds: readonly AttachmentId[],
  signal: AbortSignal | undefined,
): Promise<AttachmentArtifact[]> {
  const rows: AttachmentArtifact[] = []
  for (let offset = 0; offset < attachmentIds.length; offset += ATTACHMENT_ARTIFACT_ID_BATCH) {
    throwIfAttachmentSearchAborted(signal)
    const batch = attachmentIds.slice(offset, offset + ATTACHMENT_ARTIFACT_ID_BATCH)
    rows.push(...(await table.where('attachmentId').anyOf(batch).toArray()))
    throwIfAttachmentSearchAborted(signal)
  }
  return rows
}

function encodeAttachmentCursor(
  attachment: AttachmentHeaderRow,
  sort: AttachmentSearchSort,
): string {
  const tuple: [AttachmentSearchSort, number, AttachmentId] = [
    sort,
    attachmentSortValue(attachment, sort),
    attachment.id,
  ]
  return `${ATTACHMENT_SEARCH_CURSOR_PREFIX}${encodeURIComponent(JSON.stringify(tuple))}`
}

function decodeAttachmentCursor(cursor: string): AttachmentCursorTuple | { legacyId: string } {
  if (!cursor.startsWith(ATTACHMENT_SEARCH_CURSOR_FAMILY)) return { legacyId: cursor }
  if (!cursor.startsWith(ATTACHMENT_SEARCH_CURSOR_PREFIX)) {
    throw new Error('AttachmentSearchCursorVersionUnsupported')
  }
  try {
    const parsed = JSON.parse(
      decodeURIComponent(cursor.slice(ATTACHMENT_SEARCH_CURSOR_PREFIX.length)),
    ) as unknown
    if (!Array.isArray(parsed) || parsed.length !== 3) throw new Error('shape')
    const sort: unknown = parsed[0]
    const value: unknown = parsed[1]
    const id: unknown = parsed[2]
    if (!isAttachmentSearchSort(sort) || typeof value !== 'number' || typeof id !== 'string') {
      throw new Error('value')
    }
    return { sort, value, id }
  } catch {
    throw new Error('AttachmentSearchCursorInvalid')
  }
}

function attachmentPageStart(
  rows: readonly AttachmentHeaderRow[],
  cursor: string | undefined,
  sort: AttachmentSearchSort,
): number {
  if (cursor === undefined) return 0
  const decoded = decodeAttachmentCursor(cursor)
  if ('legacyId' in decoded || decoded.sort !== sort) {
    const legacyId = 'legacyId' in decoded ? decoded.legacyId : decoded.id
    return Math.max(0, rows.findIndex((row) => row.id === legacyId) + 1)
  }
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2)
    const row = rows[middle]
    if (
      row &&
      compareAttachmentSortTuples(
        attachmentSortValue(row, sort),
        row.id,
        decoded.value,
        decoded.id,
        sort,
      ) <= 0
    ) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

function attachmentSortValue(attachment: AttachmentHeaderRow, sort: AttachmentSearchSort): number {
  if (sort === 'updated-desc') return attachment.updatedAt
  if (sort === 'size-desc' || sort === 'size-asc') return attachment.sizeBytes ?? 0
  return attachment.createdAt
}

function compareAttachmentSortTuples(
  leftValue: number,
  leftId: AttachmentId,
  rightValue: number,
  rightId: AttachmentId,
  sort: AttachmentSearchSort,
): number {
  if (leftValue !== rightValue) {
    const ascending = sort === 'created-asc' || sort === 'size-asc'
    return (leftValue < rightValue ? -1 : 1) * (ascending ? 1 : -1)
  }
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

function isAttachmentSearchSort(value: unknown): value is AttachmentSearchSort {
  return (
    value === 'created-desc' ||
    value === 'created-asc' ||
    value === 'updated-desc' ||
    value === 'size-desc' ||
    value === 'size-asc'
  )
}

function throwIfAttachmentSearchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Attachment search aborted', 'AbortError')
}

export function resolveMutationTableNames(
  scopes: readonly MutationScope[],
  options?: WorkspaceMutationOptions,
): BrowserMutationTableName[] {
  const names = new Set<BrowserMutationTableName>(['settings'])
  if (options?.streamFence) names.add('streamLeases')
  for (const scope of scopes) {
    switch (scope.kind) {
      case 'attachment':
        names.add('attachmentArtifacts')
        names.add('attachmentBlobs')
        names.add('attachmentJobs')
        names.add('attachmentRefEdges')
        names.add('attachments')
        break
      case 'chat-meta':
        names.add('chatSidebarRows')
        names.add('chats')
        break
      case 'children':
        names.add('chatBranchCache')
        names.add('chatSidebarRows')
        names.add('chats')
        names.add('childLists')
        names.add('messages')
        names.add('messageBodies')
        break
      case 'draft':
        names.add('chatSidebarRows')
        names.add('chats')
        names.add('drafts')
        break
      case 'message':
        names.add('chatBranchCache')
        names.add('chatSidebarRows')
        names.add('chats')
        names.add('messages')
        names.add('messageBodies')
        names.add('streamLeases')
        break
    }
  }
  return MUTATION_TABLE_ORDER.filter((name) => names.has(name))
}

function resolveMutationTables(
  db: NatterDb,
  scopes: readonly MutationScope[],
  options?: WorkspaceMutationOptions,
): Table<unknown, unknown>[] {
  return resolveMutationTableNames(scopes, options).map((name) => {
    switch (name) {
      case 'attachments':
        return db.attachments as Table<unknown, unknown>
      case 'attachmentArtifacts':
        return db.attachmentArtifacts as Table<unknown, unknown>
      case 'attachmentBlobs':
        return db.attachmentBlobs as Table<unknown, unknown>
      case 'attachmentJobs':
        return db.attachmentJobs as Table<unknown, unknown>
      case 'attachmentRefEdges':
        return db.attachmentRefEdges as Table<unknown, unknown>
      case 'chats':
        return db.chats as Table<unknown, unknown>
      case 'chatBranchCache':
        return db.chatBranchCache as Table<unknown, unknown>
      case 'chatSidebarRows':
        return db.chatSidebarRows as Table<unknown, unknown>
      case 'childLists':
        return db.childLists as Table<unknown, unknown>
      case 'drafts':
        return db.drafts as Table<unknown, unknown>
      case 'messages':
        return db.messages as Table<unknown, unknown>
      case 'messageBodies':
        return db.messageBodies as Table<unknown, unknown>
      case 'settings':
        return db.settings as Table<unknown, unknown>
      case 'streamLeases':
        return db.streamLeases as Table<unknown, unknown>
    }
    const exhaustive: never = name
    void exhaustive
    throw new Error('UnknownMutationTable')
  })
}

function affectedKey(summary: ChatMutationSummary): string {
  switch (summary.kind) {
    case 'chat-meta':
      return `chat-meta:${summary.chatId ?? ''}`
    case 'message':
      return `message:${summary.chatId ?? ''}:${summary.messageId ?? ''}`
    case 'children':
      return `children:${summary.chatId ?? ''}:${summary.parentId ?? '__root__'}`
    case 'draft':
      return `draft:${summary.chatId ?? ''}`
    case 'attachment':
      return `attachment:${summary.attachmentId ?? ''}`
  }
}

function scopeResourceName(scope: MutationScope): string {
  switch (scope.kind) {
    case 'chat-meta':
      return `chat-meta:${scope.chatId}`
    case 'message':
      return `message:${scope.messageId}`
    case 'children':
      return `children:${scope.chatId}:${scope.parentId ?? '__root__'}`
    case 'draft':
      return `draft:${scope.chatId}`
    case 'attachment':
      return `attachment:${scope.attachmentId}`
  }
}

function createScopeChecker(scopes: readonly MutationScope[]) {
  const allowed = new Set(scopes.map(scopeResourceName))
  const assertScope = (scope: MutationScope): void => {
    const key = scopeResourceName(scope)
    if (!allowed.has(key)) {
      throw new Error(`UndeclaredScope:${key}`)
    }
  }
  return { assertScope }
}

function upsertAffected(state: ChatMutationState, summary: ChatMutationSummary): void {
  state.affected.set(affectedKey(summary), summary)
}

async function loadChatOrThrow(table: Table<Chat, string>, chatId: ChatId): Promise<Chat> {
  const chat = await table.get(chatId)
  if (!chat) throw new ChatMissingError(chatId)
  return structuredClone(chat)
}

function findLastUpdatedLeafIdFromHeaders(headers: readonly MessageHeaderRow[]): MessageId | null {
  const parentsWithLiveChildren = new Set<MessageId>()
  for (const header of headers) {
    if (!header.deleted && header.parentId !== null) parentsWithLiveChildren.add(header.parentId)
  }
  let best: MessageHeaderRow | undefined
  for (const header of headers) {
    if (header.deleted || parentsWithLiveChildren.has(header.id)) continue
    if (
      !best ||
      header.createdAt > best.createdAt ||
      (header.createdAt === best.createdAt && header.id > best.id)
    ) {
      best = header
    }
  }
  return best?.id ?? null
}

function headerIsOnPathToLeaf(
  messageId: MessageId,
  leafId: MessageId,
  byId: ReadonlyMap<MessageId, MessageHeaderRow>,
): boolean {
  let currentId: MessageId | null = leafId
  while (currentId !== null) {
    if (currentId === messageId) return true
    currentId = byId.get(currentId)?.parentId ?? null
  }
  return false
}

function shouldBumpLastBranchUpdatedAt(
  beforeChat: Chat,
  beforeHeaders: readonly MessageHeaderRow[],
  afterHeaders: readonly MessageHeaderRow[],
  changedMessageIds: ReadonlySet<MessageId>,
): boolean {
  const nextLeafId = findLastUpdatedLeafIdFromHeaders(afterHeaders)
  if (nextLeafId !== beforeChat.lastUpdatedLeafId) return true
  if (nextLeafId === null) return false
  if (changedMessageIds.size === 0) return false
  const beforeById = new Map(beforeHeaders.map((header) => [header.id, header]))
  const afterById = new Map(afterHeaders.map((header) => [header.id, header]))
  for (const messageId of changedMessageIds) {
    if (
      headerIsOnPathToLeaf(messageId, nextLeafId, beforeById) ||
      headerIsOnPathToLeaf(messageId, nextLeafId, afterById)
    ) {
      return true
    }
  }
  return false
}

function shouldBumpLastBranchUpdatedAtFromHeaders(
  beforeChat: Chat,
  nextLeafId: MessageId | null,
  branchHeaders: readonly MessageHeaderRow[],
  changedMessageIds: ReadonlySet<MessageId>,
): boolean {
  if (nextLeafId !== beforeChat.lastUpdatedLeafId) return true
  if (nextLeafId === null || changedMessageIds.size === 0) return false
  const branchIds = new Set(branchHeaders.map((header) => header.id))
  for (const messageId of changedMessageIds) {
    if (branchIds.has(messageId)) return true
  }
  return false
}

async function invalidateBranchCacheForSummary(tx: Transaction, chatId: ChatId): Promise<void> {
  await tx.table<ChatBranchCache, ChatId>('chatBranchCache').delete(chatId)
}

function countStoredBodyWords(body: MessageBodyRow): number {
  return countMessagesWords([body as unknown as Message])
}

function branchPathIsComplete(
  branch: readonly MessageHeaderRow[],
  leafId: MessageId | null,
): boolean {
  if (leafId === null) return branch.length === 0
  return branch.at(-1)?.id === leafId
}

async function hydrateBranchWordCount(
  headers: readonly MessageHeaderRow[],
  bodyTable: Table<MessageBodyRow, MessageId>,
): Promise<number> {
  return countMessagesWords(await hydrateStoredMessages(headers, bodyTable))
}

async function structuralBranchWordCount(input: {
  tx: Transaction
  state: ChatMutationState
  beforeHeaders: readonly MessageHeaderRow[]
  afterHeaders: readonly MessageHeaderRow[]
  nextLeafId: MessageId | null
}): Promise<number> {
  const { state } = input
  const bodyTable = input.tx.table<MessageBodyRow, MessageId>('messageBodies')
  const oldBranch = branchHeadersByLeaf(input.beforeHeaders, state.beforeChat.lastUpdatedLeafId)
  const newBranch = branchHeadersByLeaf(input.afterHeaders, input.nextLeafId)
  const fallback = () => hydrateBranchWordCount(newBranch, bodyTable)
  if (
    !branchPathIsComplete(oldBranch, state.beforeChat.lastUpdatedLeafId) ||
    !branchPathIsComplete(newBranch, input.nextLeafId)
  ) {
    return fallback()
  }

  const oldIds = new Set(oldBranch.map((header) => header.id))
  const newIds = new Set(newBranch.map((header) => header.id))
  const beforeIds = new Set(input.beforeHeaders.map((header) => header.id))
  let wordCount = state.beforeChat.wordCount

  for (const messageId of state.changedMessageIds) {
    if (!oldIds.has(messageId) || !newIds.has(messageId)) continue
    const delta = state.wordCountDeltas.get(messageId)
    if (delta === undefined) return fallback()
    wordCount += delta
  }

  for (const header of oldBranch) {
    if (newIds.has(header.id)) continue
    const body = await bodyTable.get(header.id)
    if (!body) return fallback()
    const currentCount = countStoredBodyWords(body)
    wordCount -= currentCount - (state.wordCountDeltas.get(header.id) ?? 0)
  }

  for (const header of newBranch) {
    if (oldIds.has(header.id)) continue
    const delta = state.wordCountDeltas.get(header.id)
    if (!beforeIds.has(header.id) && delta !== undefined) {
      wordCount += delta
      continue
    }
    const body = await bodyTable.get(header.id)
    if (!body) return fallback()
    wordCount += countStoredBodyWords(body)
  }

  return Math.max(0, wordCount)
}

function messageOutranksLeaf(
  message: Pick<Message, 'createdAt' | 'id'>,
  leaf: Pick<MessageHeaderRow, 'createdAt' | 'id'>,
): boolean {
  return (
    message.createdAt > leaf.createdAt ||
    (message.createdAt === leaf.createdAt && message.id > leaf.id)
  )
}

async function branchHeadersByLeafInTransaction(
  tx: Transaction,
  chatId: ChatId,
  leafId: MessageId | null,
): Promise<MessageHeaderRow[]> {
  if (leafId === null) return []
  const table = tx.table<MessageHeaderRow, MessageId>('messages')
  const branch: MessageHeaderRow[] = []
  let currentId: MessageId | null = leafId
  while (currentId !== null) {
    const header: MessageHeaderRow | undefined = await table.get(currentId)
    if (!header || header.chatId !== chatId || header.deleted) break
    branch.push(cloneMessageHeader(header))
    currentId = header.parentId
  }
  branch.reverse()
  return branch
}

async function getWorkspaceMetaRow(): Promise<WorkspaceMeta> {
  const db = await openDb()
  return readBrowserWorkspaceMeta(db)
}

async function bumpWorkspaceMeta(tx: Transaction, now: number): Promise<void> {
  await bumpBrowserWorkspaceMeta(tx, now)
}

function normalizeName(value: string, kind: 'Folder' | 'Tag'): string {
  const name = value.trim()
  if (name.length === 0) throw new Error(`${kind}NameRequired`)
  return name
}

function tagNameLower(name: string): string {
  return name.toLocaleLowerCase()
}

function sortFolders(rows: ChatFolder[]): ChatFolder[] {
  return rows.sort((left, right) => {
    if (left.sortIndex !== right.sortIndex) return left.sortIndex - right.sortIndex
    const byName = left.name.localeCompare(right.name)
    return byName !== 0 ? byName : left.id.localeCompare(right.id)
  })
}

function sortTags(rows: ChatTag[]): ChatTag[] {
  return rows.sort((left, right) => {
    const byName = left.nameLower.localeCompare(right.nameLower)
    return byName !== 0 ? byName : left.id.localeCompare(right.id)
  })
}

function patchOptionalString<T extends object>(
  row: T,
  key: keyof T,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined || value.trim().length === 0) {
    delete row[key]
    return
  }
  row[key] = value as T[keyof T]
}

function patchOptionalNumber<T extends object>(
  row: T,
  key: keyof T,
  value: number | null | undefined,
): void {
  if (value === null || value === undefined) {
    delete row[key]
    return
  }
  row[key] = value as T[keyof T]
}

interface ArchivedChatDeleteSnapshot {
  chatId: ChatId
  messageIds: MessageId[]
  attachmentIds: AttachmentId[]
}

class ArchivedChatDeletePlanChangedError extends Error {}

async function archivedDeleteSnapshots(
  db: NatterDb,
  chatIds: readonly ChatId[],
): Promise<ArchivedChatDeleteSnapshot[]> {
  const snapshots: ArchivedChatDeleteSnapshot[] = []
  await db.transaction('r', [db.chats, db.messages, db.drafts], async (tx: Transaction) => {
    const chats = tx.table<Chat, ChatId>('chats')
    const messages = tx.table<MessageHeaderRow, MessageId>('messages')
    const drafts = tx.table<DraftRow, ChatId>('drafts')
    for (const chatId of chatIds) {
      const chat = await chats.get(chatId)
      if (!chat?.archived) continue
      const rows = await messages.where('chatId').equals(chatId).toArray()
      const draft = await drafts.get(chatId)
      snapshots.push({
        chatId,
        messageIds: rows.map((message) => message.id),
        attachmentIds: attachmentIdsFromDeletedChat(rows, draft),
      })
    }
  })
  return snapshots
}

function attachmentIdsFromDeletedChat(
  messages: readonly Pick<Message, 'attachmentRefs'>[],
  draft: DraftRow | undefined,
): AttachmentId[] {
  const ids: AttachmentId[] = []
  for (const message of messages) {
    for (const ref of liveAttachmentRefs(message.attachmentRefs)) ids.push(ref.attachmentId)
  }
  for (const ref of liveAttachmentRefs(draft?.attachmentRefs)) ids.push(ref.attachmentId)
  return ids
}

function sameArchivedDeleteSnapshot(
  snapshot: ArchivedChatDeleteSnapshot,
  messages: readonly MessageHeaderRow[],
  draft: DraftRow | undefined,
): boolean {
  return (
    sameOrderedValues(
      [...snapshot.messageIds].sort(),
      messages.map((message) => message.id).sort(),
    ) &&
    sameOrderedValues(
      [...snapshot.attachmentIds].sort(),
      attachmentIdsFromDeletedChat(messages, draft).sort(),
    )
  )
}

interface ForkWritePlan {
  sourceMessageIds: MessageId[]
  sourceParentIds: Array<MessageId | null>
  liveAttachmentIds: AttachmentId[]
  destinationChatId: ChatId
  destinationMessageIds: MessageId[]
  destinationParentIds: Array<MessageId | null>
  scopes: MutationScope[]
}

class ForkWritePlanChangedError extends Error {}

async function forkAncestorHeaders(
  table: Table<MessageHeaderRow, MessageId>,
  chatId: ChatId,
  targetId: MessageId,
): Promise<MessageHeaderRow[]> {
  const ancestors: MessageHeaderRow[] = []
  const visited = new Set<MessageId>()
  let currentId: MessageId | null = targetId
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error(`fork: cycle at message ${currentId}`)
    visited.add(currentId)
    const row: MessageHeaderRow | undefined = await table.get(currentId)
    if (!row) {
      if (currentId === targetId) throw new Error(`fork: message ${targetId} not found`)
      break
    }
    if (row.chatId !== chatId) {
      throw new Error(`fork: message ${row.id} does not belong to chat ${chatId}`)
    }
    ancestors.push(cloneMessageHeader(row))
    currentId = row.parentId
  }
  ancestors.reverse()
  return ancestors
}

function forkLiveAttachmentIds(rows: readonly Pick<Message, 'attachmentRefs'>[]): AttachmentId[] {
  return rows.flatMap((row) =>
    liveAttachmentRefs(row.attachmentRefs).map((ref) => ref.attachmentId),
  )
}

function sameOrderedValues<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameForkPlanSource(plan: ForkWritePlan, rows: readonly Message[]): boolean {
  return (
    sameOrderedValues(
      plan.sourceMessageIds,
      rows.map((row) => row.id),
    ) &&
    sameOrderedValues(
      plan.sourceParentIds,
      rows.map((row) => row.parentId),
    ) &&
    sameOrderedValues([...plan.liveAttachmentIds].sort(), forkLiveAttachmentIds(rows).sort())
  )
}

async function planForkWrite(
  db: NatterDb,
  input: ForkChatFromMessageInput,
  destinationChatId: ChatId,
): Promise<ForkWritePlan> {
  const headers = await db.transaction('r', [db.chats, db.messages], async (tx: Transaction) => {
    if (!(await tx.table<Chat, ChatId>('chats').get(input.chatId))) {
      throw new Error(`fork: source chat ${input.chatId} not found`)
    }
    return forkAncestorHeaders(
      tx.table<MessageHeaderRow, MessageId>('messages'),
      input.chatId,
      input.messageId,
    )
  })
  if (headers.length === 0) throw new Error('fork: no ancestors to copy')

  const destinationMessageIds = headers.map(() => newId())
  const destinationIdBySourceId = new Map(
    headers.map((row, index) => [row.id, destinationMessageIds[index] as MessageId]),
  )
  const destinationParentIds = headers.map((row) =>
    row.parentId ? (destinationIdBySourceId.get(row.parentId) ?? null) : null,
  )
  const scopes: MutationScope[] = [
    { kind: 'chat-meta', chatId: input.chatId },
    { kind: 'chat-meta', chatId: destinationChatId },
  ]
  for (const row of headers) scopes.push({ kind: 'message', messageId: row.id })
  for (const messageId of destinationMessageIds) scopes.push({ kind: 'message', messageId })
  for (const parentId of destinationParentIds) {
    scopes.push({ kind: 'children', chatId: destinationChatId, parentId })
  }
  const liveAttachmentIds = forkLiveAttachmentIds(headers)
  for (const attachmentId of new Set(liveAttachmentIds)) {
    scopes.push({ kind: 'attachment', attachmentId })
  }

  return {
    sourceMessageIds: headers.map((row) => row.id),
    sourceParentIds: headers.map((row) => row.parentId),
    liveAttachmentIds,
    destinationChatId,
    destinationMessageIds,
    destinationParentIds,
    scopes,
  }
}

function cloneForkMessages(
  ancestors: readonly Message[],
  plan: ForkWritePlan,
  now: number,
): Message[] {
  const destinationIdBySourceId = new Map(
    ancestors.map((row, index) => [row.id, plan.destinationMessageIds[index] as MessageId]),
  )
  return ancestors.map((source, index) => {
    const clone = structuredClone(source)
    clone.id = plan.destinationMessageIds[index] as MessageId
    clone.chatId = plan.destinationChatId
    clone.parentId = source.parentId ? (destinationIdBySourceId.get(source.parentId) ?? null) : null
    clone.siblingIndex = 0
    clone.turnId = newId()
    clone.turnIndex = 0
    clone.createdAt = now - (ancestors.length - index)
    if (clone.editedAt !== undefined) clone.editedAt = now
    clone.nodeVersion = 0
    return clone
  })
}

class BrowserWorkspaceRepository implements WorkspaceRepository {
  async getWorkspaceMeta(): Promise<WorkspaceMeta> {
    return getWorkspaceMetaRow()
  }

  async appendMessageToExpectedLeaf(
    input: AppendMessageToExpectedLeafInput,
  ): Promise<AppendMessageToExpectedLeafResult> {
    const { expectedLeafId, message } = input
    const attachmentIds = [
      ...new Set((message.attachmentRefs ?? []).map((ref) => ref.attachmentId)),
    ]
    const result = await this.runMutation(
      [
        { kind: 'message', messageId: message.id },
        ...(expectedLeafId ? [{ kind: 'message' as const, messageId: expectedLeafId }] : []),
        { kind: 'children', chatId: message.chatId, parentId: expectedLeafId },
        ...attachmentIds.map((attachmentId) => ({
          kind: 'attachment' as const,
          attachmentId,
        })),
      ],
      async (ctx) => {
        if (await ctx.getMessageHeader(message.id)) {
          throw new Error(`AppendMessageIdAlreadyExists:${message.id}`)
        }
        if (expectedLeafId !== null) {
          const expected = await ctx.getMessageHeader(expectedLeafId)
          if (!expected) {
            throw new ExpectedLeafChangedError(message.chatId, expectedLeafId, 'missing')
          }
          if (expected.chatId !== message.chatId) {
            throw new ExpectedLeafChangedError(message.chatId, expectedLeafId, 'wrong-chat')
          }
          if (expected.deleted) {
            throw new ExpectedLeafChangedError(message.chatId, expectedLeafId, 'deleted')
          }
        }
        const siblings = await ctx.listChildHeaders(message.chatId, expectedLeafId)
        const blockingChild = siblings.find((header) => !header.deleted)
        if (blockingChild) {
          throw new ExpectedLeafChangedError(
            message.chatId,
            expectedLeafId,
            expectedLeafId === null ? 'root-not-empty' : 'has-live-child',
            blockingChild.id,
          )
        }
        const appended: Message = {
          ...structuredClone(message),
          parentId: expectedLeafId,
          siblingIndex: nextSiblingIndex(siblings),
          nodeVersion: 0,
          deleted: false,
        }
        await ctx.putMessage(appended)
        return { message: appended, hadExistingSiblings: siblings.length > 0 }
      },
    )
    const versions = result.chatVersions[message.chatId]
    if (!versions) throw new Error(`AppendMessageVersionsMissing:${message.chatId}`)
    return { ...result.value, versions }
  }

  async forkChatFromMessage(input: ForkChatFromMessageInput): Promise<ForkChatFromMessageResult> {
    const db = await openDb()
    const destinationChatId = newId()
    const now = input.now ?? Date.now()

    for (;;) {
      const plan = await planForkWrite(db, input, destinationChatId)
      try {
        const result = await withMutationLocks(plan.scopes, async (grant) =>
          grant.runTransaction(
            db,
            [
              db.attachments,
              db.attachmentRefEdges,
              db.chatBranchCache,
              db.chatSidebarRows,
              db.chats,
              db.childLists,
              db.messages,
              db.messageBodies,
              db.settings,
            ],
            async (tx: Transaction) => {
              const chatTable = tx.table<Chat, ChatId>('chats')
              const source = await chatTable.get(input.chatId)
              if (!source) throw new Error(`fork: source chat ${input.chatId} not found`)
              if (await chatTable.get(destinationChatId)) {
                throw new Error(`fork: destination chat ${destinationChatId} already exists`)
              }

              const headers = await forkAncestorHeaders(
                tx.table<MessageHeaderRow, MessageId>('messages'),
                input.chatId,
                input.messageId,
              )
              const ancestors = await hydrateStoredMessages(
                headers,
                tx.table<MessageBodyRow, MessageId>('messageBodies'),
              )
              if (!sameForkPlanSource(plan, ancestors)) throw new ForkWritePlanChangedError()

              const messages = cloneForkMessages(ancestors, plan, now)
              const lastUpdatedLeafId = findLastUpdatedLeafId(messages)
              const branchCache =
                lastUpdatedLeafId === null
                  ? undefined
                  : buildBranchCacheRow({
                      chatId: destinationChatId,
                      branchLeafId: lastUpdatedLeafId,
                      messages,
                      generatedAt: now,
                    })
              const chat: Chat = {
                id: destinationChatId,
                title: input.title,
                titleStatus: 'manual',
                createdAt: now,
                updatedAt: now,
                lastViewedAt: now,
                wordCount: branchCache?.wordCount ?? 0,
                totalCostUsd: computeTotalCostUsd(messages),
                metaVersion: 0,
                summaryVersion: 1,
                settings: structuredClone(source.settings),
                lastUpdatedLeafId,
                lastBranchUpdatedAt: now,
                archived: false,
                pinned: false,
                folderId: null,
                tags: [],
                previewText: previewTextFromMessages(messages),
                ...(source.presetId ? { presetId: source.presetId } : {}),
              }

              await chatTable.put(chat)
              await putChatSidebarProjection(tx, chat, true)
              const headerTable = tx.table<MessageHeaderRow, MessageId>('messages')
              const bodyTable = tx.table<MessageBodyRow, MessageId>('messageBodies')
              const childListTable = tx.table<ChildListState, string>('childLists')
              for (const message of messages) {
                const { header, body } = splitMessageForStorage(message, { updatedAt: now })
                await headerTable.put(header)
                await bodyTable.put(body)
                await childListTable.put({
                  id: childListKey(destinationChatId, message.parentId),
                  chatId: destinationChatId,
                  parentId: message.parentId,
                  version: 1,
                  updatedAt: now,
                })
              }
              if (branchCache) {
                await tx.table<ChatBranchCache, ChatId>('chatBranchCache').put(branchCache)
              }
              await replaceAttachmentReferenceOwners(
                tx,
                messages.map((message) => ({
                  ownerKind: 'message' as const,
                  ownerId: message.id,
                  chatId: message.chatId,
                  refs: message.attachmentRefs,
                })),
              )
              await bumpWorkspaceMeta(tx, now)
              return { chatId: destinationChatId, messageCount: messages.length }
            },
          ),
        )

        postEvent({
          kind: 'chat-mutated',
          chatId: destinationChatId,
          metaVersion: 0,
          summaryVersion: 1,
          affected: [
            { kind: 'chat-meta', chatId: destinationChatId },
            ...plan.destinationMessageIds.map((messageId) => ({
              kind: 'message' as const,
              chatId: destinationChatId,
              messageId,
            })),
            ...plan.destinationParentIds.map((parentId) => ({
              kind: 'children' as const,
              chatId: destinationChatId,
              parentId,
            })),
          ],
        })
        return result
      } catch (error) {
        if (error instanceof ForkWritePlanChangedError) continue
        throw error
      }
    }
  }

  async createChat(chat: Chat): Promise<Chat> {
    const result = await withMutationLocks(
      [{ kind: 'chat-meta', chatId: chat.id }],
      async (grant) => createChatInBrowser(await openDb(), grant, chat, bumpWorkspaceMeta),
    )
    postEvent({
      kind: 'chat-mutated',
      chatId: result.id,
      metaVersion: result.metaVersion,
      summaryVersion: result.summaryVersion,
      affected: [{ kind: 'chat-meta', chatId: result.id }],
    })
    return result
  }

  async discardEmptyDraftChats(input: {
    chatIds?: readonly ChatId[]
    exceptChatId?: ChatId | null
    now?: number
  }): Promise<ChatId[]> {
    const deleted = await withNamedLock('db:global', async (grant) =>
      discardEmptyDraftChatsInBrowser(
        await openDb(),
        grant,
        input,
        input.now ?? Date.now(),
        bumpWorkspaceMeta,
      ),
    )
    for (const chatId of deleted) postEvent({ kind: 'chat-deleted', chatId })
    return deleted
  }

  async deletePresetAndClearBreadcrumbs(
    presetId: PresetId,
    now: number,
  ): Promise<DeletePresetCascadeResult> {
    const result = await withNamedLock(`preset:${presetId}`, async (grant) =>
      deletePresetAndClearBreadcrumbsInBrowser(
        await openDb(),
        grant,
        presetId,
        now,
        bumpWorkspaceMeta,
      ),
    )
    if (result.kind === 'missing') return result
    for (const chat of result.chats) {
      postEvent({
        kind: 'chat-mutated',
        chatId: chat.chatId,
        metaVersion: chat.metaVersion,
        summaryVersion: chat.summaryVersion,
        affected: [{ kind: 'chat-meta', chatId: chat.chatId }],
      })
    }
    postEvent({ kind: 'preset-deleted', presetId })
    return result
  }

  async updateProfileAndInvalidateCaches(
    input: UpdateProfileAtomicInput,
  ): Promise<UpdateProfileAtomicResult> {
    const result = await withNamedLock(`profile:${input.profileId}`, async (grant) =>
      updateProfileAndInvalidateCachesInBrowser(await openDb(), grant, input, bumpWorkspaceMeta),
    )
    if (result.kind === 'missing') return result
    if (result.cachesInvalidated) {
      postEvent({ kind: 'models-refreshed', profileId: input.profileId })
    }
    postEvent({ kind: 'profile-mutated', profileId: input.profileId })
    return result
  }

  async deleteProfileAndReassign(
    input: DeleteProfileAtomicInput,
  ): Promise<DeleteProfileAtomicResult> {
    const lockIds = [
      ...new Set(
        [input.profileId, input.reassignTo].filter((id): id is string => id !== undefined),
      ),
    ].sort()
    const result = await withNamedLocks(
      lockIds.map((profileId) => `profile:${profileId}`),
      async (grant) =>
        deleteProfileAndReassignInBrowser(await openDb(), grant, input, bumpWorkspaceMeta),
    )
    if (result.kind !== 'deleted') return result
    for (const presetId of result.presetIds) {
      postEvent({ kind: 'preset-mutated', presetId })
    }
    for (const chat of result.chats) {
      postEvent({
        kind: 'chat-mutated',
        chatId: chat.chatId,
        metaVersion: chat.metaVersion,
        summaryVersion: chat.summaryVersion,
        affected: [{ kind: 'chat-meta', chatId: chat.chatId }],
      })
    }
    for (const keyId of result.deletedKeyIds) {
      postEvent({ kind: 'key-rotated', keyId })
    }
    postEvent({ kind: 'profile-deleted', profileId: input.profileId })
    return result
  }

  async updatePromptPresetAndPropagate(
    input: UpdatePromptPresetAtomicInput,
  ): Promise<UpdatePromptPresetAtomicResult> {
    const result = await withNamedLock(`prompt-preset:${input.presetId}`, async (grant) =>
      updatePromptPresetAndPropagateInBrowser(await openDb(), grant, input, bumpWorkspaceMeta),
    )
    if (result.kind === 'missing') return result
    postEvent({ kind: 'prompt-preset-mutated', promptPresetId: input.presetId })
    for (const chat of result.chats) {
      postEvent({
        kind: 'chat-mutated',
        chatId: chat.chatId,
        metaVersion: chat.metaVersion,
        summaryVersion: chat.summaryVersion,
        affected: [{ kind: 'chat-meta', chatId: chat.chatId }],
      })
    }
    for (const presetId of result.presetIds) {
      postEvent({ kind: 'preset-mutated', presetId })
    }
    return result
  }

  async deletePromptPresetAndClearPins(
    input: DeletePromptPresetAtomicInput,
  ): Promise<DeletePromptPresetAtomicResult> {
    const result = await withNamedLock(`prompt-preset:${input.presetId}`, async (grant) =>
      deletePromptPresetAndClearPinsInBrowser(await openDb(), grant, input, bumpWorkspaceMeta),
    )
    if (result.kind === 'missing') return result
    postEvent({ kind: 'prompt-preset-deleted', promptPresetId: input.presetId })
    for (const chat of result.chats) {
      postEvent({
        kind: 'chat-mutated',
        chatId: chat.chatId,
        metaVersion: chat.metaVersion,
        summaryVersion: chat.summaryVersion,
        affected: [{ kind: 'chat-meta', chatId: chat.chatId }],
      })
    }
    for (const presetId of result.presetIds) {
      postEvent({ kind: 'preset-mutated', presetId })
    }
    return result
  }

  async upsertStreamLease(lease: StreamLeaseRow): Promise<StreamLeaseRow> {
    const db = await openDb()
    const row = await withNamedLocks(
      [`stream-chat:${lease.chatId}`, `stream-journal:${lease.streamId}`],
      (grant) =>
        grant.runTransaction(
          db,
          [db.streamLeases, db.settings, db.messages, db.messageBodies],
          async (tx) => {
            const table = tx.table<StreamLeaseRow, string>('streamLeases')
            const existing = await table.get(lease.streamId)
            const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
            const fenceToken = lease.fenceToken ?? newId()
            if (existing && existing.chatId !== lease.chatId) {
              throw new Error(`StreamLeaseChatMismatch:${lease.streamId}`)
            }
            if (
              existing &&
              (existing.ownerClientId !== lease.ownerClientId || existing.fenceToken !== fenceToken)
            ) {
              throw new Error(`StreamLeaseAlreadyOwned:${lease.streamId}`)
            }
            const admitted: StreamLeaseRow = {
              ...lease,
              fenceToken,
              replacementEpoch: meta.replacementEpoch,
              ...(existing?.exclusiveChat === true || lease.exclusiveChat === true
                ? { exclusiveChat: true as const }
                : {}),
            }
            await assertStreamLeaseChatAdmissionAvailable(tx, admitted)
            await assertStreamLeaseTargetAvailable(tx, admitted)
            await table.put(admitted)
            return admitted
          },
        ),
    )
    postEvent({ kind: 'stream-heartbeat', lease: row })
    return row
  }

  async renewStreamLease(
    lease: StreamLeaseRow,
    options: { targetChanged?: boolean } = {},
  ): Promise<StreamLeaseRow> {
    const fence = requiredStreamFence(lease)
    const db = await openDb()
    const checkTarget = options.targetChanged !== false
    const row = await withNamedLock(`stream-journal:${lease.streamId}`, (grant) =>
      grant.runTransaction(
        db,
        checkTarget && lease.messageId
          ? [db.streamLeases, db.settings, db.messages, db.messageBodies]
          : [db.streamLeases, db.settings],
        async (tx) => {
          const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
          const table = tx.table<StreamLeaseRow, string>('streamLeases')
          const existing = await table.get(lease.streamId)
          assertOwnedStreamFence(existing, fence, meta.replacementEpoch, lease.streamId)
          if (existing.chatId !== lease.chatId) {
            throw new Error(`StreamLeaseChatMismatch:${lease.streamId}`)
          }
          const renewed: StreamLeaseRow = {
            ...lease,
            startedAt: existing.startedAt,
            fenceToken: fence.fenceToken,
            replacementEpoch: fence.replacementEpoch,
            ...(existing.exclusiveChat === true ? { exclusiveChat: true as const } : {}),
          }
          if (renewed.messageId !== existing.messageId) {
            if (!checkTarget) throw new Error(`StreamLeaseTargetChanged:${lease.streamId}`)
            await assertStreamLeaseTargetAvailable(tx, renewed)
          }
          await table.put(renewed)
          return renewed
        },
      ),
    )
    postEvent({ kind: 'stream-heartbeat', lease: row })
    return row
  }

  async claimStreamLeaseForRecovery(
    expected: StreamLeaseRow,
    now: number,
  ): Promise<StreamLeaseRow | undefined> {
    const expectedFence = requiredStreamFence(expected)
    const db = await openDb()
    return withNamedLock(`stream-journal:${expected.streamId}`, (grant) =>
      grant.runTransaction(db, [db.streamLeases, db.settings], async (tx) => {
        const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
        const table = tx.table<StreamLeaseRow, string>('streamLeases')
        const existing = await table.get(expected.streamId)
        if (
          !existing ||
          existing.ownerClientId !== expectedFence.ownerClientId ||
          existing.fenceToken !== expectedFence.fenceToken ||
          existing.replacementEpoch !== expectedFence.replacementEpoch ||
          existing.heartbeatAt !== expected.heartbeatAt ||
          meta.replacementEpoch !== expectedFence.replacementEpoch
        ) {
          return undefined
        }
        const claimed: StreamLeaseRow = {
          ...existing,
          ownerClientId: `recovery:${newId()}`,
          fenceToken: newId(),
          heartbeatAt: now,
        }
        await table.put(claimed)
        return claimed
      }),
    )
  }

  async deleteStreamLease(streamId: string): Promise<boolean> {
    const db = await openDb()
    return withNamedLock(`stream-journal:${streamId}`, (grant) =>
      grant.runTransaction(db, [db.streamLeases], async (tx) => {
        const table = tx.table<StreamLeaseRow, string>('streamLeases')
        const existing = await table.get(streamId)
        if (!existing) return false
        await table.delete(streamId)
        return true
      }),
    )
  }

  async deleteOwnedStreamLease(streamId: string, fence: StreamWriteFence): Promise<boolean> {
    const db = await openDb()
    return withNamedLock(`stream-journal:${streamId}`, (grant) =>
      grant.runTransaction(db, [db.streamLeases, db.settings], async (tx) => {
        const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
        const table = tx.table<StreamLeaseRow, string>('streamLeases')
        const existing = await table.get(streamId)
        if (!existing) return false
        assertOwnedStreamFence(existing, fence, meta.replacementEpoch, streamId)
        await table.delete(streamId)
        return true
      }),
    )
  }

  async listStreamLeases(chatId?: ChatId): Promise<StreamLeaseRow[]> {
    const db = await openDb()
    const rows =
      chatId === undefined
        ? await db.streamLeases.toArray()
        : await db.streamLeases.where('chatId').equals(chatId).toArray()
    return rows.filter(isStreamLeaseRow).map((lease) => ({ ...lease }))
  }

  async appendStreamChunks(chunks: readonly StreamChunkRow[]): Promise<void> {
    if (chunks.length === 0) return
    const db = await openDb()
    const streamIds = [...new Set(chunks.map((chunk) => chunk.streamId))]
    await withNamedLocks(
      streamIds.map((streamId) => `stream-journal:${streamId}`),
      (grant) =>
        grant.runTransaction(db, [db.streamChunks, db.streamLeases, db.settings], async (tx) => {
          const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
          const leases = tx.table<StreamLeaseRow, string>('streamLeases')
          const leaseRows = await leases.bulkGet(streamIds)
          const byStreamId = new Map(
            leaseRows.flatMap((lease) => (lease ? [[lease.streamId, lease] as const] : [])),
          )
          const latestCreatedAtByStreamId = new Map<string, number>()
          for (const chunk of chunks) {
            const fence = requiredChunkFence(chunk)
            const lease = byStreamId.get(chunk.streamId)
            if (
              !lease ||
              lease.fenceToken !== fence.fenceToken ||
              lease.replacementEpoch !== fence.replacementEpoch ||
              meta.replacementEpoch !== fence.replacementEpoch
            ) {
              throw new Error(`StreamFenceLost:${chunk.streamId}`)
            }
            latestCreatedAtByStreamId.set(
              chunk.streamId,
              Math.max(
                latestCreatedAtByStreamId.get(chunk.streamId) ?? chunk.createdAt,
                chunk.createdAt,
              ),
            )
          }
          const advancedLeases: StreamLeaseRow[] = []
          for (const [streamId, latestCreatedAt] of latestCreatedAtByStreamId) {
            const lease = byStreamId.get(streamId) as StreamLeaseRow
            if (latestCreatedAt <= lease.heartbeatAt) continue
            advancedLeases.push({ ...lease, heartbeatAt: latestCreatedAt })
          }
          if (advancedLeases.length > 0) await leases.bulkPut(advancedLeases)
          await tx
            .table<StreamChunkRow, string>('streamChunks')
            .bulkPut(chunks.map((chunk) => structuredClone(chunk)))
        }),
    )
  }

  async listStreamChunks(streamId: string): Promise<StreamChunkRow[]> {
    const db = await openDb()
    const rows = await db.streamChunks
      .where('[streamId+seq]')
      .between([streamId, Dexie.minKey], [streamId, Dexie.maxKey])
      .toArray()
    return rows.filter(isStreamChunkRow).map((chunk) => structuredClone(chunk))
  }

  async listStreamChunksForMessage(messageId: MessageId): Promise<StreamChunkRow[]> {
    const db = await openDb()
    const rows = await db.streamChunks.where('messageId').equals(messageId).toArray()
    return rows
      .filter(isStreamChunkRow)
      .sort((a, b) => a.seq - b.seq)
      .map((chunk) => structuredClone(chunk))
  }

  async listStreamChunksForChat(chatId: ChatId): Promise<StreamChunkRow[]> {
    const db = await openDb()
    const rows = await db.streamChunks.where('chatId').equals(chatId).toArray()
    return rows
      .filter(isStreamChunkRow)
      .sort((a, b) =>
        a.streamId === b.streamId ? a.seq - b.seq : a.streamId.localeCompare(b.streamId),
      )
      .map((chunk) => structuredClone(chunk))
  }

  async deleteStreamChunks(streamId: string, fence?: StreamWriteFence): Promise<number> {
    const db = await openDb()
    return withNamedLock(`stream-journal:${streamId}`, (grant) =>
      grant.runTransaction(
        db,
        fence ? [db.streamChunks, db.streamLeases, db.settings] : [db.streamChunks],
        async (tx) => {
          if (fence) {
            const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
            const lease = await tx.table<StreamLeaseRow, string>('streamLeases').get(streamId)
            assertOwnedStreamFence(lease, fence, meta.replacementEpoch, streamId)
          }
          return tx
            .table<StreamChunkRow, string>('streamChunks')
            .where('streamId')
            .equals(streamId)
            .delete()
        },
      ),
    )
  }

  async listChats(): Promise<Chat[]> {
    return openDb().then((db) => db.chats.toArray())
  }

  async getChat(chatId: ChatId): Promise<Chat | undefined> {
    return openDb().then((db) => db.chats.get(chatId))
  }

  async deleteArchivedChat(chatId: ChatId): Promise<boolean> {
    const result = await this.deleteArchivedChats([chatId])
    return result.deletedChatIds.includes(chatId)
  }

  async emptyArchivedChats(): Promise<DeleteArchivedChatsResult> {
    const db = await openDb()
    const archivedIds = (await db.chats.filter((chat) => chat.archived).toArray()).map(
      (chat) => chat.id,
    )
    return this.deleteArchivedChats(archivedIds)
  }

  private async deleteArchivedChats(
    chatIds: readonly ChatId[],
  ): Promise<DeleteArchivedChatsResult> {
    if (chatIds.length === 0) return { deletedChatIds: [] }
    const db = await openDb()
    for (;;) {
      const snapshots = await archivedDeleteSnapshots(db, chatIds)
      if (snapshots.length === 0) return { deletedChatIds: [] }
      const scopes: MutationScope[] = []
      const attachmentScopeIds = new Set<AttachmentId>()
      for (const snapshot of snapshots) {
        scopes.push({ kind: 'chat-meta', chatId: snapshot.chatId })
        scopes.push({ kind: 'draft', chatId: snapshot.chatId })
        for (const messageId of snapshot.messageIds) {
          scopes.push({ kind: 'message', messageId })
        }
        for (const attachmentId of snapshot.attachmentIds) {
          if (attachmentScopeIds.has(attachmentId)) continue
          attachmentScopeIds.add(attachmentId)
          scopes.push({ kind: 'attachment', attachmentId })
        }
      }

      const deletedChatIds: ChatId[] = []
      const now = Date.now()
      try {
        await withMutationLocks(scopes, async (grant) =>
          grant.runTransaction(
            db,
            [
              db.attachmentArtifacts,
              db.attachmentBlobs,
              db.attachmentJobs,
              db.attachmentRefEdges,
              db.attachments,
              db.chatBranchCache,
              db.chatSidebarRows,
              db.chats,
              db.childLists,
              db.drafts,
              db.messages,
              db.messageBodies,
              db.streamLeases,
              db.streamChunks,
              db.settings,
            ],
            async (tx: Transaction) => {
              const chats = tx.table<Chat, ChatId>('chats')
              const messages = tx.table<MessageHeaderRow, MessageId>('messages')
              const drafts = tx.table<DraftRow, ChatId>('drafts')
              for (const snapshot of snapshots) {
                const chat = await chats.get(snapshot.chatId)
                if (!chat?.archived) continue
                const messageRows = await messages.where('chatId').equals(snapshot.chatId).toArray()
                const draft = await drafts.get(snapshot.chatId)
                if (!sameArchivedDeleteSnapshot(snapshot, messageRows, draft)) {
                  throw new ArchivedChatDeletePlanChangedError()
                }
                await replaceAttachmentReferenceOwners(tx, [
                  ...messageRows.map((message) => ({
                    ownerKind: 'message' as const,
                    ownerId: message.id,
                    chatId: message.chatId,
                    refs: [],
                  })),
                  ...(draft
                    ? [
                        {
                          ownerKind: 'draft' as const,
                          ownerId: draft.chatId,
                          chatId: draft.chatId,
                          refs: [],
                        },
                      ]
                    : []),
                ])
                await messages.where('chatId').equals(snapshot.chatId).delete()
                await tx
                  .table<MessageBodyRow, MessageId>('messageBodies')
                  .where('chatId')
                  .equals(snapshot.chatId)
                  .delete()
                await drafts.delete(snapshot.chatId)
                await tx.table<ChatBranchCache, ChatId>('chatBranchCache').delete(snapshot.chatId)
                await tx
                  .table<ChildListState, string>('childLists')
                  .filter((row) => row.chatId === snapshot.chatId)
                  .delete()
                await tx
                  .table<StreamLeaseRow, string>('streamLeases')
                  .where('chatId')
                  .equals(snapshot.chatId)
                  .delete()
                await tx
                  .table<StreamChunkRow, string>('streamChunks')
                  .where('chatId')
                  .equals(snapshot.chatId)
                  .delete()
                await chats.delete(snapshot.chatId)
                deletedChatIds.push(snapshot.chatId)
              }
              if (deletedChatIds.length > 0) {
                await deleteChatSidebarProjections(tx, deletedChatIds)
                await bumpWorkspaceMeta(tx, now)
              }
            },
          ),
        )
      } catch (error) {
        if (error instanceof ArchivedChatDeletePlanChangedError) continue
        throw error
      }

      for (const chatId of deletedChatIds) {
        postEvent({ kind: 'chat-deleted', chatId })
        postEvent({ kind: 'branch-cache-refreshed', chatId })
      }
      return { deletedChatIds }
    }
  }

  async listFolders(): Promise<ChatFolder[]> {
    const db = await openDb()
    return sortFolders(await db.folders.toArray())
  }

  async getFolder(folderId: FolderId): Promise<ChatFolder | undefined> {
    const db = await openDb()
    return db.folders.get(folderId)
  }

  async createFolder(input: CreateFolderInput): Promise<ChatFolder> {
    const db = await openDb()
    const now = input.now ?? Date.now()
    const folder: ChatFolder = {
      id: input.id ?? newId(),
      name: normalizeName(input.name, 'Folder'),
      sortIndex: input.sortIndex ?? now,
      createdAt: now,
      updatedAt: now,
    }
    if (input.color) folder.color = input.color

    await withNamedLock(`folder:${folder.id}`, (grant) =>
      grant.runTransaction(db, [db.folders, db.settings], async (tx: Transaction) => {
        await tx.table<ChatFolder, FolderId>('folders').put(folder)
        await bumpWorkspaceMeta(tx, now)
      }),
    )
    postEvent({ kind: 'folder-mutated', folderId: folder.id })
    return folder
  }

  async updateFolder(
    folderId: FolderId,
    patch: UpdateFolderInput,
  ): Promise<ChatFolder | undefined> {
    const db = await openDb()
    const now = patch.now ?? Date.now()
    let next: ChatFolder | undefined
    const result = { changed: false }
    await withNamedLock(`folder:${folderId}`, (grant) =>
      grant.runTransaction(db, [db.folders, db.settings], async (tx: Transaction) => {
        const table = tx.table<ChatFolder, FolderId>('folders')
        const current = await table.get(folderId)
        if (!current) return
        next = { ...current }
        if (patch.name !== undefined) next.name = normalizeName(patch.name, 'Folder')
        if (patch.color !== undefined) patchOptionalString(next, 'color', patch.color)
        if (patch.sortIndex !== undefined) next.sortIndex = patch.sortIndex
        if (patch.lastUsedAt !== undefined) {
          patchOptionalNumber(next, 'lastUsedAt', patch.lastUsedAt)
        }
        if (stableStringify(current) === stableStringify(next)) return
        next.updatedAt = now
        result.changed = true
        await table.put(next)
        await bumpWorkspaceMeta(tx, now)
      }),
    )
    if (result.changed) postEvent({ kind: 'folder-mutated', folderId })
    return next
  }

  async deleteFolder(folderId: FolderId): Promise<DeleteFolderResult> {
    const db = await openDb()
    const now = Date.now()
    const changedChats: Chat[] = []
    const result = { deleted: false }
    await withNamedLock(`folder:${folderId}`, (grant) =>
      grant.runTransaction(
        db,
        [db.folders, db.chatSidebarRows, db.chats, db.settings],
        async (tx: Transaction) => {
          const folders = tx.table<ChatFolder, FolderId>('folders')
          if (!(await folders.get(folderId))) return
          await folders.delete(folderId)
          result.deleted = true

          const chats = tx.table<Chat, ChatId>('chats')
          const rows = await chats.where('folderId').equals(folderId).toArray()
          for (const row of rows) {
            const next: Chat = {
              ...row,
              folderId: null,
              updatedAt: now,
              metaVersion: row.metaVersion + 1,
              summaryVersion: row.summaryVersion + 1,
            }
            await chats.put(next)
            await putChatSidebarProjection(tx, next)
            changedChats.push(next)
          }
          await bumpWorkspaceMeta(tx, now)
        },
      ),
    )
    if (result.deleted) {
      postEvent({ kind: 'folder-deleted', folderId })
      for (const chat of changedChats) {
        postEvent({
          kind: 'chat-mutated',
          chatId: chat.id,
          metaVersion: chat.metaVersion,
          summaryVersion: chat.summaryVersion,
          affected: [{ kind: 'chat-meta', chatId: chat.id }],
        })
      }
    }
    return { deleted: result.deleted, affectedChatIds: changedChats.map((chat) => chat.id) }
  }

  async listTags(): Promise<ChatTag[]> {
    const db = await openDb()
    return sortTags(await db.tags.toArray())
  }

  async getTag(tagId: TagId): Promise<ChatTag | undefined> {
    const db = await openDb()
    return db.tags.get(tagId)
  }

  async createTag(input: CreateTagInput): Promise<ChatTag> {
    const db = await openDb()
    const now = input.now ?? Date.now()
    const name = normalizeName(input.name, 'Tag')
    const tag: ChatTag = {
      id: input.id ?? newId(),
      name,
      nameLower: tagNameLower(name),
      createdAt: now,
      updatedAt: now,
    }
    if (input.color) tag.color = input.color

    await withNamedLock(`tag:${tag.id}`, (grant) =>
      grant.runTransaction(db, [db.tags, db.settings], async (tx: Transaction) => {
        await tx.table<ChatTag, TagId>('tags').put(tag)
        await bumpWorkspaceMeta(tx, now)
      }),
    )
    postEvent({ kind: 'tag-mutated', tagId: tag.id })
    return tag
  }

  async updateTag(tagId: TagId, patch: UpdateTagInput): Promise<ChatTag | undefined> {
    const db = await openDb()
    const now = patch.now ?? Date.now()
    let next: ChatTag | undefined
    const result = { changed: false }
    await withNamedLock(`tag:${tagId}`, (grant) =>
      grant.runTransaction(db, [db.tags, db.settings], async (tx: Transaction) => {
        const table = tx.table<ChatTag, TagId>('tags')
        const current = await table.get(tagId)
        if (!current) return
        next = { ...current }
        if (patch.name !== undefined) {
          next.name = normalizeName(patch.name, 'Tag')
          next.nameLower = tagNameLower(next.name)
        }
        if (patch.color !== undefined) patchOptionalString(next, 'color', patch.color)
        if (patch.lastUsedAt !== undefined) {
          patchOptionalNumber(next, 'lastUsedAt', patch.lastUsedAt)
        }
        if (stableStringify(current) === stableStringify(next)) return
        next.updatedAt = now
        result.changed = true
        await table.put(next)
        await bumpWorkspaceMeta(tx, now)
      }),
    )
    if (result.changed) postEvent({ kind: 'tag-mutated', tagId })
    return next
  }

  async deleteTag(tagId: TagId): Promise<DeleteTagResult> {
    const db = await openDb()
    const now = Date.now()
    const changedChats: Chat[] = []
    const result = { deleted: false }
    await withNamedLock(`tag:${tagId}`, (grant) =>
      grant.runTransaction(
        db,
        [db.tags, db.chatSidebarRows, db.chats, db.settings],
        async (tx: Transaction) => {
          const tags = tx.table<ChatTag, TagId>('tags')
          if (!(await tags.get(tagId))) return
          await tags.delete(tagId)
          result.deleted = true

          const chats = tx.table<Chat, ChatId>('chats')
          const rows = await chats.where('tags').equals(tagId).toArray()
          for (const row of rows) {
            const nextTags = row.tags.filter((id) => id !== tagId)
            if (nextTags.length === row.tags.length) continue
            const next: Chat = {
              ...row,
              tags: nextTags,
              metaVersion: row.metaVersion + 1,
            }
            await chats.put(next)
            await putChatSidebarProjection(tx, next)
            changedChats.push(next)
          }
          await bumpWorkspaceMeta(tx, now)
        },
      ),
    )
    if (result.deleted) {
      postEvent({ kind: 'tag-deleted', tagId })
      for (const chat of changedChats) {
        postEvent({
          kind: 'chat-mutated',
          chatId: chat.id,
          metaVersion: chat.metaVersion,
          summaryVersion: chat.summaryVersion,
          affected: [{ kind: 'chat-meta', chatId: chat.id }],
        })
      }
    }
    return { deleted: result.deleted, affectedChatIds: changedChats.map((chat) => chat.id) }
  }

  async getChatBranchCache(chatId: ChatId): Promise<ChatBranchCache | undefined> {
    const db = await openDb()
    return db.chatBranchCache.get(chatId)
  }

  async putChatBranchCache(
    cache: ChatBranchCache,
    expected: ChatBranchCacheWriteGuard,
  ): Promise<ChatBranchCache | undefined> {
    if (expected.missingChat) throw new Error(`BranchCacheGuardMissingChat:${cache.chatId}`)
    if (cache.branchLeafId !== expected.branchLeafId) {
      throw new Error(`BranchCacheGuardLeafMismatch:${cache.chatId}`)
    }
    const db = await openDb()
    const now = Date.now()
    const guardedCache =
      cache.generatedAt < expected.lastBranchUpdatedAt
        ? { ...cache, generatedAt: expected.lastBranchUpdatedAt }
        : cache
    let written: ChatBranchCache | undefined
    await withNamedLock(`branch-cache:${cache.chatId}`, (grant) =>
      grant.runTransaction(
        db,
        [db.chatBranchCache, db.chats, db.settings],
        async (tx: Transaction) => {
          const [chat, meta] = await Promise.all([
            tx.table<Chat, ChatId>('chats').get(cache.chatId),
            readBrowserWorkspaceMetaFromTransaction(tx),
          ])
          if (
            meta.replacementEpoch !== expected.replacementEpoch ||
            !chat ||
            !chatMatchesBranchCacheWriteGuard(chat, expected)
          ) {
            return
          }
          await tx.table<ChatBranchCache, ChatId>('chatBranchCache').put(guardedCache)
          written = guardedCache
          await bumpWorkspaceMeta(tx, now)
        },
      ),
    )
    if (written) postEvent({ kind: 'branch-cache-refreshed', chatId: cache.chatId })
    return written
  }

  async deleteChatBranchCache(
    chatId: ChatId,
    expected?: ChatBranchCacheWriteGuard,
  ): Promise<boolean> {
    const db = await openDb()
    const now = Date.now()
    const result = { deleted: false }
    await withNamedLock(`branch-cache:${chatId}`, (grant) =>
      grant.runTransaction(
        db,
        expected ? [db.chatBranchCache, db.chats, db.settings] : [db.chatBranchCache, db.settings],
        async (tx: Transaction) => {
          if (expected) {
            const [chat, meta] = await Promise.all([
              tx.table<Chat, ChatId>('chats').get(chatId),
              readBrowserWorkspaceMetaFromTransaction(tx),
            ])
            if (meta.replacementEpoch !== expected.replacementEpoch) return
            if (
              expected.missingChat
                ? chat !== undefined
                : !chat || !chatMatchesBranchCacheWriteGuard(chat, expected)
            )
              return
          }
          const table = tx.table<ChatBranchCache, ChatId>('chatBranchCache')
          result.deleted = (await table.where(':id').equals(chatId).delete()) > 0
          if (result.deleted) await bumpWorkspaceMeta(tx, now)
        },
      ),
    )
    if (result.deleted) postEvent({ kind: 'branch-cache-refreshed', chatId })
    return result.deleted
  }

  async getMessage(messageId: MessageId): Promise<Message | undefined> {
    return openDb().then(async (db) => {
      return db.transaction('r', db.messages, db.messageBodies, async () => {
        const [header, body] = await Promise.all([
          db.messages.get(messageId),
          db.messageBodies.get(messageId),
        ])
        return header && body ? hydrateStoredMessage(header, body) : undefined
      })
    })
  }

  async getMessageTextPreview(
    messageId: MessageId,
    options: { maxChars?: number } = {},
  ): Promise<string | undefined> {
    const db = await openDb()
    const maxChars = Math.min(4_096, Math.max(1, Math.floor(options.maxChars ?? 240)))
    return db.transaction('r', db.messages, db.messageBodies, async () => {
      const [header, bodyKey] = await Promise.all([
        db.messages.get(messageId),
        db.messageBodies.where(':id').equals(messageId).firstKey(),
      ])
      if (!header || bodyKey === undefined) return undefined
      return previewTextFromStoredProjection(header.textPreview, maxChars)
    })
  }

  async searchChatMessageText(
    chatId: ChatId,
    query: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MessageId[]> {
    if (query.length === 0) return []
    if (options.signal?.aborted) throw new DOMException('Search aborted', 'AbortError')
    const db = await openDb()
    return db.transaction('r', db.messages, db.messageBodies, async () => {
      const liveIds = new Set(
        (await db.messages.where('chatId').equals(chatId).toArray())
          .filter((header) => !header.deleted)
          .map((header) => header.id),
      )
      const matches: MessageId[] = []
      await db.messageBodies
        .where('chatId')
        .equals(chatId)
        .each((body) => {
          if (options.signal?.aborted) throw new DOMException('Search aborted', 'AbortError')
          if (!liveIds.has(body.id)) return
          if (contentIncludesCaseInsensitiveText(body.content, query, options.signal)) {
            matches.push(body.id)
          }
        })
      return matches
    })
  }

  async listMessages(chatId: ChatId): Promise<Message[]> {
    return openDb().then(async (db) => {
      return db.transaction('r', db.messages, db.messageBodies, async () => {
        const headers = await db.messages.where('chatId').equals(chatId).toArray()
        return hydrateStoredMessages(headers, db.messageBodies)
      })
    })
  }

  async getMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined> {
    const db = await openDb()
    const header = await db.messages.get(messageId)
    return header ? cloneMessageHeader(header) : undefined
  }

  async listMessageHeaders(chatId: ChatId): Promise<MessageHeaderRow[]> {
    const db = await openDb()
    return (await db.messages.where('chatId').equals(chatId).toArray()).map(cloneMessageHeader)
  }

  async listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<MessageHeaderRow[]> {
    const db = await openDb()
    return (await listChildHeaderRows(db.messages, chatId, parentId)).map(cloneMessageHeader)
  }

  async getActiveBranchSnapshot(
    chatId: ChatId,
    cursor: Record<string, MessageId>,
  ): Promise<ActiveBranchSnapshot> {
    const db = await openDb()
    return db.transaction('r', db.messages, db.messageBodies, async () => {
      const headers = await db.messages.where('chatId').equals(chatId).toArray()
      const branchHeaders = activePath(headers as unknown as Message[], cursor).map(
        (message) => message as unknown as MessageHeaderRow,
      )
      const bodies = (
        await db.messageBodies.bulkGet(branchHeaders.map((header) => header.id))
      ).filter((row): row is MessageBodyRow => row !== undefined)
      return {
        chatId,
        allHeaders: headers.map(cloneMessageHeader),
        branchHeaders: branchHeaders.map(cloneMessageHeader),
        branch: hydrateMessages(branchHeaders.map(cloneMessageHeader), bodies),
        siblingGroups: siblingGroupsForBranch(headers, branchHeaders),
        treeKey: messageHeaderTreeKey(headers),
      }
    })
  }

  async getActiveBranchWindowSnapshot(
    chatId: ChatId,
    cursor: Record<string, MessageId>,
    window: ActiveBranchBodyWindow,
  ): Promise<ActiveBranchWindowSnapshot> {
    const db = await openDb()
    return db.transaction('r', db.messages, db.messageBodies, async () => {
      const headers = await db.messages.where('chatId').equals(chatId).toArray()
      let activePathMeasurement: ActivePathMeasurement | undefined
      const branchHeaders = activePath(
        headers as unknown as Message[],
        cursor,
        window.onMeasure
          ? (measurement) => {
              activePathMeasurement = measurement
            }
          : undefined,
      ).map((message) => message as unknown as MessageHeaderRow)
      const range = branchWindowRange(branchHeaders.length, window)
      const windowHeaders = branchHeaders.slice(range.start, range.end)
      const bodies = (
        await db.messageBodies.bulkGet(windowHeaders.map((header) => header.id))
      ).filter((row): row is MessageBodyRow => row !== undefined)
      const siblingGroups = siblingGroupsForBranch(headers, branchHeaders)
      if (window.onMeasure && activePathMeasurement) {
        window.onMeasure({
          headerRowsRead: headers.length,
          bodyRowsRead: bodies.length,
          siblingRowsRetained: siblingGroups.reduce(
            (total, group) => total + group.siblings.length,
            0,
          ),
          treeKeyRows: headers.length,
          activePath: activePathMeasurement,
        })
      }
      return {
        chatId,
        allHeaders: headers.map(cloneMessageHeader),
        branchHeaders: branchHeaders.map(cloneMessageHeader),
        branchWindow: hydrateMessages(windowHeaders.map(cloneMessageHeader), bodies),
        windowOffset: range.start,
        windowLimit: range.limit,
        branchLength: branchHeaders.length,
        siblingGroups,
        treeKey: messageHeaderTreeKey(headers),
      }
    })
  }

  async getBranchHeaderSnapshotByLeaf(
    chatId: ChatId,
    leafId: MessageId | null,
  ): Promise<BranchHeaderSnapshot> {
    const db = await openDb()
    return db.transaction('r', db.chats, db.messages, async () => {
      const [chat, headers] = await Promise.all([
        db.chats.get(chatId),
        db.messages.where('chatId').equals(chatId).toArray(),
      ])
      if (!chat) throw new ChatMissingError(chatId)
      return {
        chat,
        summaryVersion: chat.summaryVersion,
        chatId,
        allHeaders: headers.map(cloneMessageHeader),
        branchHeaders: branchHeadersByLeaf(headers, leafId).map(cloneMessageHeader),
      }
    })
  }

  async getBranchByLeaf(chatId: ChatId, leafId: MessageId | null): Promise<Message[]> {
    const db = await openDb()
    return db.transaction('r', db.messages, db.messageBodies, async () => {
      const headers = await db.messages.where('chatId').equals(chatId).toArray()
      const branchHeaders = branchHeadersByLeaf(headers, leafId)
      return hydrateStoredMessages(branchHeaders, db.messageBodies)
    })
  }

  async getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined> {
    return openDb().then(async (db) => {
      const header = await db.attachments.get(attachmentId)
      return header
        ? hydrateStoredAttachment(attachmentHeaderFromStoredRow(header), db.attachmentArtifacts)
        : undefined
    })
  }

  async getAttachmentBundle(attachmentId: AttachmentId): Promise<AttachmentBundle | undefined> {
    return openDb().then(async (db) => {
      const header = await db.attachments.get(attachmentId)
      if (!header) return undefined
      const [blobs, artifacts, jobs] = await Promise.all([
        db.attachmentBlobs.where('attachmentId').equals(attachmentId).toArray(),
        db.attachmentArtifacts.where('attachmentId').equals(attachmentId).toArray(),
        db.attachmentJobs.where('attachmentId').equals(attachmentId).toArray(),
      ])
      const attachment = hydrateAttachment(attachmentHeaderFromStoredRow(header), artifacts)
      return { attachment, blobs, artifacts, jobs }
    })
  }

  async getAttachmentBlob(blobId: string): Promise<AttachmentBlob | undefined> {
    return openDb().then((db) => db.attachmentBlobs.get(blobId))
  }

  async searchAttachments(query: AttachmentSearchQuery = {}): Promise<AttachmentSearchPage> {
    const db = await openDb()
    throwIfAttachmentSearchAborted(query.signal)
    const limit = query.limit ?? 100
    const sort = query.sort ?? 'created-desc'
    const measurement: AttachmentSearchMeasurement = {
      selectedIndex: 'primary',
      indexCounts: {},
      metadataRowsRead: 0,
      metadataCandidates: 0,
      embeddedArtifactRowsRead: 0,
      artifactCandidateAttachments: 0,
      artifactRowsRead: 0,
      attachmentBlobRowsRead: 0,
      matchedRows: 0,
      returnedRows: 0,
    }
    const rows = await loadAttachmentSearchMetadata(db.attachments, query, sort, measurement)
    throwIfAttachmentSearchAborted(query.signal)
    const terms = query.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? []
    const metadataCandidates: AttachmentHeaderRow[] = []
    for (const [index, attachment] of rows.entries()) {
      if (index % ATTACHMENT_SEARCH_ABORT_CHECK_INTERVAL === 0) {
        throwIfAttachmentSearchAborted(query.signal)
      }
      if (attachmentMatchesFilters(attachment, query)) metadataCandidates.push(attachment)
    }
    measurement.metadataCandidates = metadataCandidates.length
    const metadataTextByAttachment = new Map<AttachmentId, string>()
    const artifactCandidateIds: AttachmentId[] = []
    if (terms.length > 0) {
      for (const [index, attachment] of metadataCandidates.entries()) {
        if (index % ATTACHMENT_SEARCH_ABORT_CHECK_INTERVAL === 0) {
          throwIfAttachmentSearchAborted(query.signal)
        }
        const metadataText = attachmentSearchText(attachment, [])
        metadataTextByAttachment.set(attachment.id, metadataText)
        if (!terms.every((term) => metadataText.includes(term))) {
          artifactCandidateIds.push(attachment.id)
        }
      }
    }
    measurement.artifactCandidateAttachments = artifactCandidateIds.length
    const artifacts =
      terms.length === 0
        ? []
        : await loadCandidateAttachmentArtifacts(
            db.attachmentArtifacts,
            artifactCandidateIds,
            query.signal,
          )
    measurement.artifactRowsRead = artifacts.length
    const artifactsByAttachment = new Map<AttachmentId, AttachmentArtifact[]>()
    for (const [index, artifact] of artifacts.entries()) {
      if (index % ATTACHMENT_SEARCH_ABORT_CHECK_INTERVAL === 0) {
        throwIfAttachmentSearchAborted(query.signal)
      }
      const list = artifactsByAttachment.get(artifact.attachmentId) ?? []
      list.push(artifact)
      artifactsByAttachment.set(artifact.attachmentId, list)
    }
    const filtered: AttachmentHeaderRow[] = []
    for (const [index, attachment] of metadataCandidates.entries()) {
      if (index % ATTACHMENT_SEARCH_ABORT_CHECK_INTERVAL === 0) {
        throwIfAttachmentSearchAborted(query.signal)
      }
      if (terms.length === 0) {
        filtered.push(attachment)
        continue
      }
      const metadataText = metadataTextByAttachment.get(attachment.id) ?? ''
      if (terms.every((term) => metadataText.includes(term))) {
        filtered.push(attachment)
        continue
      }
      const haystack = attachmentSearchText(
        attachment,
        artifactsByAttachment.get(attachment.id) ?? [],
      )
      if (terms.every((term) => haystack.includes(term))) filtered.push(attachment)
    }
    filtered.sort(attachmentSorter(sort))
    throwIfAttachmentSearchAborted(query.signal)
    measurement.matchedRows = filtered.length
    const start = attachmentPageStart(filtered, query.cursor, sort)
    const pageHeaders = filtered.slice(start, start + limit)
    const last = pageHeaders.at(-1)
    const nextCursor =
      last && filtered.length > start + limit ? encodeAttachmentCursor(last, sort) : undefined
    const artifactsById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]))
    const missingArtifactIds = pageHeaders
      .flatMap((header) => header.artifactIds)
      .filter((artifactId) => !artifactsById.has(artifactId))
    if (missingArtifactIds.length > 0) {
      const pageArtifacts = await db.attachmentArtifacts.bulkGet(missingArtifactIds)
      for (const artifact of pageArtifacts) {
        if (artifact) artifactsById.set(artifact.artifactId, artifact)
      }
      measurement.artifactRowsRead += pageArtifacts.filter(
        (artifact): artifact is AttachmentArtifact => artifact !== undefined,
      ).length
    }
    const page = pageHeaders.map((header) =>
      hydrateAttachment(
        header,
        header.artifactIds.map((artifactId) => artifactsById.get(artifactId)),
      ),
    )
    measurement.returnedRows = page.length
    query.onMeasure?.({ ...measurement, indexCounts: { ...measurement.indexCounts } })
    return nextCursor ? { rows: page, nextCursor } : { rows: page }
  }

  async getDraft(chatId: ChatId): Promise<DraftRow | undefined> {
    return openDb().then(async (db) => {
      const row = await db.drafts.get(chatId)
      return row ? cloneDraft(row) : undefined
    })
  }

  async runMutation<T>(
    scopes: MutationScope[],
    fn: (ctx: MutationContext) => Promise<T> | T,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult<T>> {
    const db = await openDb()
    const now = Date.now()
    const pendingEvents: Array<{
      chatId: ChatId
      versions: ChatVersions
      affected: ChatMutationSummary[]
    }> = []
    const pendingBranchCacheEvents = new Set<ChatId>()
    const mutationTables = resolveMutationTables(db, scopes, options)

    const result: WorkspaceMutationResult<T> = await withMutationLocks(scopes, async (grant) =>
      grant.runTransaction<WorkspaceMutationResult<T>>(
        db,
        mutationTables,
        async (tx: Transaction) => {
          let ownedStreamLease: StreamLeaseRow | undefined
          if (options?.streamFence) {
            const { streamId, fence } = options.streamFence
            const [meta, lease] = await Promise.all([
              readBrowserWorkspaceMetaFromTransaction(tx),
              tx.table<StreamLeaseRow, string>('streamLeases').get(streamId),
            ])
            assertOwnedStreamFence(lease, fence, meta.replacementEpoch, streamId)
            ownedStreamLease = lease
          }
          const { assertScope } = createScopeChecker(scopes)
          const chatStates = new Map<ChatId, ChatMutationState>()
          const affectedMessageIds = new Set<MessageId>()
          let wroteWorkspaceState = false
          const targetLeasesByMessage = new Map<MessageId, StreamLeaseRow[]>()

          const assertStreamTargetWriteAllowed = async (messageId: MessageId): Promise<void> => {
            let targetLeases = targetLeasesByMessage.get(messageId)
            if (!targetLeases) {
              const candidates = await tx
                .table<StreamLeaseRow, string>('streamLeases')
                .where('messageId')
                .equals(messageId)
                .toArray()
              targetLeases = []
              for (const lease of candidates) {
                if (!(await streamLeaseTargetFinalized(tx, lease))) targetLeases.push(lease)
              }
              targetLeasesByMessage.set(messageId, targetLeases)
            }
            if (targetLeases.length === 0) return
            if (
              ownedStreamLease?.messageId === messageId &&
              targetLeases.every((lease) => lease.streamId === ownedStreamLease.streamId)
            ) {
              return
            }
            throw new StreamTargetBusyError(messageId)
          }

          const syncAttachmentReferenceOwner = async (input: {
            ownerKind: AttachmentReferenceEdge['ownerKind']
            ownerId: string
            chatId: ChatId
            previousRefs: readonly MessageAttachmentRef[] | undefined
            nextRefs: readonly MessageAttachmentRef[] | undefined
          }): Promise<void> => {
            const previousEdges = edgesForOwner({
              ownerKind: input.ownerKind,
              ownerId: input.ownerId,
              chatId: input.chatId,
              refs: input.previousRefs,
            })
            const nextOwner = {
              ownerKind: input.ownerKind,
              ownerId: input.ownerId,
              chatId: input.chatId,
              refs: input.nextRefs,
            }
            const nextEdges = edgesForOwner(nextOwner)
            if (stableStringify(previousEdges) === stableStringify(nextEdges)) return
            if (!scopes.some((scope) => scope.kind === 'attachment')) {
              throw new Error(
                `UndeclaredAttachmentReferenceScope:${input.ownerKind}:${input.ownerId}`,
              )
            }
            await replaceAttachmentReferenceOwner(tx, nextOwner, (attachmentId) =>
              assertScope({ kind: 'attachment', attachmentId }),
            )
          }

          const ensureChatState = async (chatId: ChatId): Promise<ChatMutationState> => {
            const existing = chatStates.get(chatId)
            if (existing) return existing
            const beforeChat = await loadChatOrThrow(tx.table<Chat, ChatId>('chats'), chatId)
            const state: ChatMutationState = {
              beforeChat,
              headersBeforeWrites: new Map<MessageId, MessageHeaderRow | undefined>(),
              incrementalAppends: [],
              wordCountDeltas: new Map<MessageId, number>(),
              totalCostDelta: 0,
              visibleMetaPatch: {},
              hiddenMetaPatch: {},
              summaryPatch: {},
              visibleMetaDirty: false,
              summaryVersionDirty: false,
              messageSummaryDirty: false,
              previewDirty: false,
              broadcast: false,
              changedMessageIds: new Set<MessageId>(),
              affected: new Map<string, ChatMutationSummary>(),
            }
            chatStates.set(chatId, state)
            return state
          }

          const ensureMessageHeaderSnapshots = async (
            state: ChatMutationState,
          ): Promise<{
            beforeHeaders: MessageHeaderRow[]
            afterHeaders: MessageHeaderRow[]
          }> => {
            if (state.beforeHeaders && state.afterHeaders) {
              return {
                beforeHeaders: state.beforeHeaders,
                afterHeaders: state.afterHeaders,
              }
            }
            const currentHeaders = (
              await tx
                .table<MessageHeaderRow, MessageId>('messages')
                .where('chatId')
                .equals(state.beforeChat.id)
                .toArray()
            ).map(cloneMessageHeader)
            const beforeHeaders = currentHeaders.map(cloneMessageHeader)
            for (const [messageId, before] of state.headersBeforeWrites) {
              if (before) replaceMessageHeader(beforeHeaders, before)
              else removeMessageHeader(beforeHeaders, messageId)
            }
            state.beforeHeaders = beforeHeaders
            state.afterHeaders = currentHeaders
            return {
              beforeHeaders: state.beforeHeaders,
              afterHeaders: state.afterHeaders,
            }
          }

          const recordHeaderBeforeWrite = (
            state: ChatMutationState | undefined,
            messageId: MessageId,
            header: MessageHeaderRow | undefined,
          ): void => {
            if (!state || state.headersBeforeWrites.has(messageId)) return
            state.headersBeforeWrites.set(
              messageId,
              header ? cloneMessageHeader(header) : undefined,
            )
          }

          for (const scope of scopes) {
            if (scope.kind === 'chat-meta' || scope.kind === 'children' || scope.kind === 'draft') {
              await ensureChatState(scope.chatId)
            }
          }

          const requireChatState = (chatId: ChatId): ChatMutationState => {
            const state = chatStates.get(chatId)
            if (!state) {
              throw new Error(`ChatStateUnavailable:${chatId}`)
            }
            return state
          }

          const bumpChildList = async (
            chatId: ChatId,
            parentId: MessageId | null,
            bumpNow = now,
          ): Promise<ChildListState> => {
            assertScope({ kind: 'children', chatId, parentId })
            const table = tx.table<ChildListState, string>('childLists')
            const id = childListKey(chatId, parentId)
            const existing = await table.get(id)
            const next: ChildListState = existing
              ? { ...existing, version: existing.version + 1, updatedAt: bumpNow }
              : { id, chatId, parentId, version: 1, updatedAt: bumpNow }
            await table.put(next)
            wroteWorkspaceState = true
            const state = await ensureChatState(chatId)
            state.broadcast = true
            upsertAffected(state, { kind: 'children', chatId, parentId })
            return next
          }

          const ctx: MutationContext = {
            getChat: async (chatId) => {
              const state = chatStates.get(chatId)
              if (!state) return tx.table<Chat, ChatId>('chats').get(chatId)
              return {
                ...state.beforeChat,
                ...state.hiddenMetaPatch,
                ...state.visibleMetaPatch,
                ...state.summaryPatch,
              }
            },

            patchChatMeta: (chatId, patch, options = {}) => {
              const {
                touchVisibleState = true,
                touchSummary = touchVisibleState,
                broadcast = touchVisibleState || touchSummary,
              } = options
              assertScope({ kind: 'chat-meta', chatId })
              const state = requireChatState(chatId)
              const current = {
                ...state.beforeChat,
                ...state.hiddenMetaPatch,
                ...state.visibleMetaPatch,
                ...state.summaryPatch,
              }
              if (touchVisibleState) {
                const applied = changedPatch(current, stripMetaPatch(patch))
                if (!applied) return
                state.visibleMetaPatch = {
                  ...state.visibleMetaPatch,
                  ...applied,
                }
                state.visibleMetaDirty = true
                state.summaryVersionDirty ||= touchSummary
              } else {
                const applied = changedPatch(current, stripMetaPatch(patch))
                if (!applied) return
                state.hiddenMetaPatch = {
                  ...state.hiddenMetaPatch,
                  ...applied,
                }
              }
              state.broadcast ||= broadcast
              upsertAffected(state, { kind: 'chat-meta', chatId })
            },

            patchChatSummary: (chatId, patch) => {
              const state = requireChatState(chatId)
              const current = {
                ...state.beforeChat,
                ...state.hiddenMetaPatch,
                ...state.visibleMetaPatch,
                ...state.summaryPatch,
              }
              const applied = changedPatch(current, stripSummaryPatch(patch))
              if (!applied) return
              state.summaryPatch = {
                ...state.summaryPatch,
                ...applied,
              }
              state.summaryVersionDirty = true
              state.broadcast = true
              upsertAffected(state, { kind: 'chat-meta', chatId })
            },

            getMessage: async (messageId) => {
              const [header, body] = await Promise.all([
                tx.table<MessageHeaderRow, MessageId>('messages').get(messageId),
                tx.table<MessageBodyRow, MessageId>('messageBodies').get(messageId),
              ])
              return header && body ? hydrateStoredMessage(header, body) : undefined
            },

            getMessageHeader: async (messageId) => {
              const header = await tx.table<MessageHeaderRow, MessageId>('messages').get(messageId)
              return header ? cloneMessageHeader(header) : undefined
            },

            listMessages: async (chatId) => listMessagesInTransaction(tx, chatId),

            listMessageHeaders: async (chatId) =>
              (
                await tx
                  .table<MessageHeaderRow, MessageId>('messages')
                  .where('chatId')
                  .equals(chatId)
                  .toArray()
              ).map(cloneMessageHeader),

            listChildHeaders: async (chatId, parentId) => {
              return (
                await listChildHeaderRows(
                  tx.table<MessageHeaderRow, MessageId>('messages'),
                  chatId,
                  parentId,
                )
              ).map(cloneMessageHeader)
            },

            listChildren: async (chatId, parentId) => {
              const headers = await listChildHeaderRows(
                tx.table<MessageHeaderRow, MessageId>('messages'),
                chatId,
                parentId,
              )
              return hydrateStoredMessages(
                headers,
                tx.table<MessageBodyRow, MessageId>('messageBodies'),
              )
            },

            putMessage: async (message, options: PutMessageOptions = {}) => {
              const { touchChatSummary = true, broadcast = touchChatSummary } = options
              const headerTable = tx.table<MessageHeaderRow, MessageId>('messages')
              const bodyTable = tx.table<MessageBodyRow, MessageId>('messageBodies')
              const existing = await headerTable.get(message.id)
              const existingBody = existing ? await bodyTable.get(message.id) : undefined
              const chatId = existing?.chatId ?? message.chatId
              const needsChatState = touchChatSummary || broadcast
              const state = needsChatState ? await ensureChatState(chatId) : undefined
              const clone = cloneMessage(message)

              assertScope({ kind: 'message', messageId: clone.id })
              if (existing) {
                if (existing.chatId !== clone.chatId) {
                  throw new Error(`CrossChatMessageMove:${clone.id}`)
                }
                const moved =
                  existing.parentId !== clone.parentId ||
                  existing.siblingIndex !== clone.siblingIndex
                const deletionChanged = existing.deleted !== clone.deleted
                const leafOrderingChanged = existing.createdAt !== clone.createdAt
                if (!touchChatSummary && (moved || deletionChanged || leafOrderingChanged)) {
                  throw new Error(`DeferredMessageWriteRequiresStableTree:${clone.id}`)
                }
                if (moved || deletionChanged) {
                  assertScope({ kind: 'children', chatId, parentId: existing.parentId })
                  assertScope({ kind: 'children', chatId, parentId: clone.parentId })
                }
                if (!existingBody) throw new Error(`MessageBodyMissing:${clone.id}`)
                const comparable = { ...clone, nodeVersion: existing.nodeVersion }
                const comparableSplit = splitMessageForStorage(comparable, {
                  updatedAt: existingBody.updatedAt,
                })
                const changed =
                  stableStringify(existing) !== stableStringify(comparableSplit.header) ||
                  stableStringify(existingBody) !== stableStringify(comparableSplit.body)
                if (!changed) return
                if (
                  streamOwnedMessageFieldsChanged(
                    existing,
                    existingBody,
                    comparableSplit.header,
                    comparableSplit.body,
                  )
                ) {
                  await assertStreamTargetWriteAllowed(clone.id)
                }
                if (
                  (existing.role === 'user' || clone.role === 'user') &&
                  (existing.role !== clone.role ||
                    deletionChanged ||
                    existing.createdAt !== clone.createdAt ||
                    stableStringify(existingBody.content) !== stableStringify(clone.content))
                ) {
                  const previewState = state ?? (await ensureChatState(chatId))
                  previewState.previewDirty = true
                }
                if (touchChatSummary && (moved || deletionChanged || leafOrderingChanged)) {
                  await ensureMessageHeaderSnapshots(state as ChatMutationState)
                }
                if (touchChatSummary) {
                  recordMessageSummaryDeltas(
                    state,
                    clone.id,
                    hydrateStoredMessage(existing, existingBody),
                    clone,
                  )
                }
                recordHeaderBeforeWrite(state, clone.id, existing)
                clone.nodeVersion = existing.nodeVersion + 1
                const { header, body } = splitMessageForStorage(clone, { updatedAt: now })
                await syncAttachmentReferenceOwner({
                  ownerKind: 'message',
                  ownerId: clone.id,
                  chatId: clone.chatId,
                  previousRefs: existing.attachmentRefs,
                  nextRefs: clone.attachmentRefs,
                })
                await headerTable.put(header)
                await bodyTable.put(body)
                wroteWorkspaceState = true
                if (state?.afterHeaders) {
                  replaceMessageHeader(state.afterHeaders, header)
                }
                if (moved || deletionChanged) {
                  await bumpChildList(chatId, existing.parentId)
                  if (existing.parentId !== clone.parentId) {
                    await bumpChildList(chatId, clone.parentId)
                  }
                }
              } else {
                if (!touchChatSummary) {
                  throw new Error(`DeferredMessageWriteRequiresExistingRow:${clone.id}`)
                }
                const summaryState = state as ChatMutationState
                const expectedLeafId =
                  summaryState.incrementalAppends.at(-1)?.id ??
                  summaryState.beforeChat.lastUpdatedLeafId
                let incrementalAppend =
                  !summaryState.afterHeaders && !clone.deleted && clone.parentId === expectedLeafId
                if (incrementalAppend && expectedLeafId !== null) {
                  const expectedLeaf = await headerTable.get(expectedLeafId)
                  incrementalAppend =
                    expectedLeaf !== undefined &&
                    !expectedLeaf.deleted &&
                    messageOutranksLeaf(clone, expectedLeaf)
                }
                if (!incrementalAppend) {
                  await ensureMessageHeaderSnapshots(summaryState)
                }
                assertScope({ kind: 'children', chatId, parentId: clone.parentId })
                const { header, body } = splitMessageForStorage(clone, { updatedAt: now })
                recordHeaderBeforeWrite(summaryState, clone.id, undefined)
                await syncAttachmentReferenceOwner({
                  ownerKind: 'message',
                  ownerId: clone.id,
                  chatId: clone.chatId,
                  previousRefs: undefined,
                  nextRefs: clone.attachmentRefs,
                })
                await headerTable.put(header)
                await bodyTable.put(body)
                wroteWorkspaceState = true
                if (clone.role === 'user') summaryState.previewDirty = true
                recordNewMessageSummary(summaryState, clone)
                if (summaryState.afterHeaders) {
                  replaceMessageHeader(summaryState.afterHeaders, header)
                } else if (incrementalAppend) {
                  summaryState.incrementalAppends.push(clone)
                }
                await bumpChildList(chatId, clone.parentId)
              }

              if (touchChatSummary && state) {
                state.summaryVersionDirty = true
                state.messageSummaryDirty = true
                state.changedMessageIds.add(clone.id)
              }
              if (broadcast && state) {
                state.broadcast = true
                upsertAffected(state, { kind: 'message', chatId, messageId: clone.id })
              }
              affectedMessageIds.add(clone.id)
            },

            patchMessageBody: async (messageId, patch, options: PatchMessageBodyOptions = {}) => {
              const {
                touchChatSummary = true,
                broadcast = touchChatSummary,
                headerPatch,
                replaceBody = false,
              } = options
              assertScope({ kind: 'message', messageId })
              const headerTable = tx.table<MessageHeaderRow, MessageId>('messages')
              const bodyTable = tx.table<MessageBodyRow, MessageId>('messageBodies')
              const existing = await headerTable.get(messageId)
              if (!existing) return
              const state =
                touchChatSummary || broadcast ? await ensureChatState(existing.chatId) : undefined
              const nextHeader = applyMessageHeaderPatch(existing, headerPatch)
              const generationReplaced =
                headerPatch !== undefined && Object.hasOwn(headerPatch, 'generation')
              const preserveColdServerToolOutputs =
                replaceBody &&
                !generationReplaced &&
                (existing.generation?.serverTools?.length ?? 0) > 0
              const existingBody =
                replaceBody && !touchChatSummary && !preserveColdServerToolOutputs
                  ? undefined
                  : await bodyTable.get(messageId)
              if (!replaceBody && !existingBody) throw new Error(`MessageBodyMissing:${messageId}`)
              if (replaceBody && touchChatSummary && !existingBody) {
                throw new Error(`MessageBodyMissing:${messageId}`)
              }
              let nextBody: MessageBodyRow
              if (!replaceBody) {
                const patchedBody = applyMessageBodyPatch(existingBody as MessageBodyRow, patch)
                nextHeader.nodeVersion = existing.nodeVersion
                patchedBody.nodeVersion = (existingBody as MessageBodyRow).nodeVersion
                patchedBody.updatedAt = (existingBody as MessageBodyRow).updatedAt
                syncMessageHeaderProjections(nextHeader, patchedBody, {
                  replaceGenerationServerToolOutputs: generationReplaced,
                })
                const changed =
                  stableStringify(existing) !== stableStringify(nextHeader) ||
                  stableStringify(existingBody) !== stableStringify(patchedBody)
                if (!changed) return
                nextHeader.nodeVersion = existing.nodeVersion + 1
                nextBody = {
                  ...patchedBody,
                  nodeVersion: nextHeader.nodeVersion,
                  updatedAt: now,
                }
                if (touchChatSummary) {
                  recordMessageSummaryDeltas(
                    state,
                    messageId,
                    hydrateStoredMessage(existing, existingBody as MessageBodyRow),
                    hydrateStoredMessage(nextHeader, nextBody),
                  )
                }
              } else {
                await assertStreamTargetWriteAllowed(messageId)
                nextHeader.nodeVersion = existing.nodeVersion + 1
                nextBody = replacementMessageBody(nextHeader, patch, {
                  nodeVersion: nextHeader.nodeVersion,
                  updatedAt: now,
                })
                if (preserveColdServerToolOutputs && existingBody?.generationServerToolOutputs) {
                  nextBody.generationServerToolOutputs = structuredClone(
                    existingBody.generationServerToolOutputs,
                  )
                }
                syncMessageHeaderProjections(nextHeader, nextBody, {
                  replaceGenerationServerToolOutputs: generationReplaced,
                })
                if (touchChatSummary) {
                  recordMessageSummaryDeltas(
                    state,
                    messageId,
                    hydrateStoredMessage(existing, existingBody as MessageBodyRow),
                    hydrateStoredMessage(nextHeader, nextBody),
                  )
                }
              }
              if (
                !replaceBody &&
                streamOwnedMessageFieldsChanged(
                  existing,
                  existingBody as MessageBodyRow,
                  nextHeader,
                  nextBody,
                )
              ) {
                await assertStreamTargetWriteAllowed(messageId)
              }
              if (
                headerPatch !== undefined &&
                Object.hasOwn(headerPatch, 'attachmentRefs') &&
                stableStringify(existing.attachmentRefs ?? []) !==
                  stableStringify(nextHeader.attachmentRefs ?? [])
              ) {
                await syncAttachmentReferenceOwner({
                  ownerKind: 'message',
                  ownerId: nextHeader.id,
                  chatId: nextHeader.chatId,
                  previousRefs: existing.attachmentRefs,
                  nextRefs: nextHeader.attachmentRefs,
                })
              }
              recordHeaderBeforeWrite(state, messageId, existing)
              await headerTable.put(nextHeader)
              await bodyTable.put(nextBody)
              wroteWorkspaceState = true
              if (existing.role === 'user' && Object.hasOwn(patch, 'content')) {
                const previewState = state ?? (await ensureChatState(existing.chatId))
                previewState.previewDirty = true
              }
              if (state?.afterHeaders) {
                replaceMessageHeader(state.afterHeaders, nextHeader)
              }
              if (touchChatSummary && state) {
                state.summaryVersionDirty = true
                state.messageSummaryDirty = true
                state.changedMessageIds.add(messageId)
              }
              if (broadcast && state) {
                state.broadcast = true
                upsertAffected(state, {
                  kind: 'message',
                  chatId: existing.chatId,
                  messageId,
                })
              }
              affectedMessageIds.add(messageId)
            },

            deleteMessage: async (messageId) => {
              assertScope({ kind: 'message', messageId })
              const table = tx.table<MessageHeaderRow, MessageId>('messages')
              const existing = await table.get(messageId)
              if (!existing) return
              await assertStreamTargetWriteAllowed(messageId)
              const state = await ensureChatState(existing.chatId)
              await ensureMessageHeaderSnapshots(state)
              assertScope({
                kind: 'children',
                chatId: existing.chatId,
                parentId: existing.parentId,
              })
              await syncAttachmentReferenceOwner({
                ownerKind: 'message',
                ownerId: existing.id,
                chatId: existing.chatId,
                previousRefs: existing.attachmentRefs,
                nextRefs: [],
              })
              recordHeaderBeforeWrite(state, messageId, existing)
              await table.delete(messageId)
              await tx.table<MessageBodyRow, MessageId>('messageBodies').delete(messageId)
              wroteWorkspaceState = true
              if (existing.role === 'user') state.previewDirty = true
              removeMessageHeader(state.afterHeaders ?? [], messageId)
              await bumpChildList(existing.chatId, existing.parentId)
              state.summaryVersionDirty = true
              state.messageSummaryDirty = true
              state.broadcast = true
              state.changedMessageIds.add(messageId)
              affectedMessageIds.add(messageId)
              upsertAffected(state, {
                kind: 'message',
                chatId: existing.chatId,
                messageId,
              })
            },

            getChildList: async (chatId, parentId) => {
              const row = await tx
                .table<ChildListState, string>('childLists')
                .get(childListKey(chatId, parentId))
              return (
                row ?? {
                  id: childListKey(chatId, parentId),
                  chatId,
                  parentId,
                  version: 0,
                  updatedAt: 0,
                }
              )
            },

            bumpChildList,

            getAttachment: async (attachmentId) => {
              const header = await tx
                .table<AttachmentHeaderRow, AttachmentId>('attachments')
                .get(attachmentId)
              return header
                ? hydrateStoredAttachment(
                    header,
                    tx.table<AttachmentArtifact, string>('attachmentArtifacts'),
                  )
                : undefined
            },

            putAttachment: async (attachment) => {
              assertScope({ kind: 'attachment', attachmentId: attachment.id })
              const refCount = await tx
                .table<AttachmentReferenceEdge>('attachmentRefEdges')
                .where('attachmentId')
                .equals(attachment.id)
                .count()
              await tx
                .table<AttachmentHeaderRow, AttachmentId>('attachments')
                .put(splitAttachmentForStorage({ ...attachment, refCount }))
              wroteWorkspaceState = true
            },

            deleteAttachment: async (attachmentId) => {
              assertScope({ kind: 'attachment', attachmentId })
              const table = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
              const existing = await table.get(attachmentId)
              if (!existing) return
              if (!(await requireNoAttachmentReferences(tx, attachmentId))) {
                throw new Error(`AttachmentStillReferenced:${attachmentId}`)
              }
              await tx
                .table<AttachmentBlob, string>('attachmentBlobs')
                .where('attachmentId')
                .equals(attachmentId)
                .delete()
              await tx
                .table<AttachmentArtifact, string>('attachmentArtifacts')
                .where('attachmentId')
                .equals(attachmentId)
                .delete()
              await tx
                .table<AttachmentJob, string>('attachmentJobs')
                .where('attachmentId')
                .equals(attachmentId)
                .delete()
              await table.delete(attachmentId)
              wroteWorkspaceState = true
            },

            countAttachmentReferences: async (attachmentId) =>
              attachmentReferenceCounts(tx, attachmentId),

            deleteAttachmentBlobs: async (attachmentId) => {
              assertScope({ kind: 'attachment', attachmentId })
              await tx
                .table<AttachmentBlob, string>('attachmentBlobs')
                .where('attachmentId')
                .equals(attachmentId)
                .delete()
              wroteWorkspaceState = true
            },

            deleteAttachmentArtifacts: async (attachmentId) => {
              assertScope({ kind: 'attachment', attachmentId })
              await tx
                .table<AttachmentArtifact, string>('attachmentArtifacts')
                .where('attachmentId')
                .equals(attachmentId)
                .delete()
              wroteWorkspaceState = true
            },

            deleteAttachmentJobs: async (attachmentId) => {
              assertScope({ kind: 'attachment', attachmentId })
              await tx
                .table<AttachmentJob, string>('attachmentJobs')
                .where('attachmentId')
                .equals(attachmentId)
                .delete()
              wroteWorkspaceState = true
            },

            getAttachmentBlob: async (blobId) =>
              tx.table<AttachmentBlob, string>('attachmentBlobs').get(blobId),

            putAttachmentBlob: async (blob) => {
              assertScope({ kind: 'attachment', attachmentId: blob.attachmentId })
              await tx.table<AttachmentBlob, string>('attachmentBlobs').put(blob)
              wroteWorkspaceState = true
            },

            deleteAttachmentBlob: async (blobId) => {
              const table = tx.table<AttachmentBlob, string>('attachmentBlobs')
              const existing = await table.get(blobId)
              if (!existing) return
              assertScope({ kind: 'attachment', attachmentId: existing.attachmentId })
              await table.delete(blobId)
              wroteWorkspaceState = true
            },

            putAttachmentArtifact: async (artifact) => {
              assertScope({ kind: 'attachment', attachmentId: artifact.attachmentId })
              await tx.table<AttachmentArtifact, string>('attachmentArtifacts').put(artifact)
              wroteWorkspaceState = true
            },

            deleteAttachmentArtifact: async (artifactId) => {
              const table = tx.table<AttachmentArtifact, string>('attachmentArtifacts')
              const existing = await table.get(artifactId)
              if (!existing) return
              assertScope({ kind: 'attachment', attachmentId: existing.attachmentId })
              await table.delete(artifactId)
              wroteWorkspaceState = true
            },

            putAttachmentJob: async (job) => {
              assertScope({ kind: 'attachment', attachmentId: job.attachmentId })
              await tx.table<AttachmentJob, string>('attachmentJobs').put(job)
              wroteWorkspaceState = true
            },

            deleteAttachmentJob: async (jobId) => {
              const table = tx.table<AttachmentJob, string>('attachmentJobs')
              const existing = await table.get(jobId)
              if (!existing) return
              assertScope({ kind: 'attachment', attachmentId: existing.attachmentId })
              await table.delete(jobId)
              wroteWorkspaceState = true
            },

            getDraft: async (chatId) => {
              const row = await tx.table<DraftRow, ChatId>('drafts').get(chatId)
              return row ? cloneDraft(row) : undefined
            },

            putDraft: async (draft) => {
              assertScope({ kind: 'draft', chatId: draft.chatId })
              const state = await ensureChatState(draft.chatId)
              const table = tx.table<DraftRow, ChatId>('drafts')
              const existing = await table.get(draft.chatId)
              const normalized = cloneDraft(draft)
              if (existing && stableStringify(cloneDraft(existing)) === stableStringify(normalized))
                return
              if (
                stableStringify(existing?.attachmentRefs ?? []) !==
                stableStringify(normalized.attachmentRefs)
              ) {
                await syncAttachmentReferenceOwner({
                  ownerKind: 'draft',
                  ownerId: normalized.chatId,
                  chatId: normalized.chatId,
                  previousRefs: existing?.attachmentRefs,
                  nextRefs: normalized.attachmentRefs,
                })
              }
              await table.put(normalized)
              wroteWorkspaceState = true
              state.broadcast = true
              upsertAffected(state, { kind: 'draft', chatId: draft.chatId })
            },

            deleteDraft: async (chatId) => {
              assertScope({ kind: 'draft', chatId })
              const state = await ensureChatState(chatId)
              const table = tx.table<DraftRow, ChatId>('drafts')
              const existing = await table.get(chatId)
              if (!existing) return
              await syncAttachmentReferenceOwner({
                ownerKind: 'draft',
                ownerId: chatId,
                chatId,
                previousRefs: existing.attachmentRefs,
                nextRefs: [],
              })
              await table.delete(chatId)
              wroteWorkspaceState = true
              state.broadcast = true
              upsertAffected(state, { kind: 'draft', chatId })
            },
          }

          const value = await fn(ctx)

          const chatVersions: Record<ChatId, ChatVersions> = {}
          const affectedChatIds: ChatId[] = []
          const chatTable = tx.table<Chat, ChatId>('chats')

          for (const [chatId, state] of chatStates) {
            const current = await chatTable.get(chatId)
            if (!current) throw new ChatMissingError(chatId)
            const next: Chat = {
              ...current,
              ...state.hiddenMetaPatch,
              ...state.visibleMetaPatch,
            }

            if (state.visibleMetaDirty) {
              next.metaVersion = current.metaVersion + 1
            }

            if (state.summaryVersionDirty) {
              next.updatedAt = now
              next.summaryVersion = current.summaryVersion + 1
            }

            if (state.messageSummaryDirty) {
              if (state.afterHeaders) {
                const afterHeaders = state.afterHeaders
                const nextLeafId = findLastUpdatedLeafIdFromHeaders(afterHeaders)
                next.lastUpdatedLeafId = nextLeafId
                next.wordCount = await structuralBranchWordCount({
                  tx,
                  state,
                  beforeHeaders: state.beforeHeaders ?? [],
                  afterHeaders,
                  nextLeafId,
                })
                next.totalCostUsd = computeTotalCostUsd(afterHeaders)
                const lastBranchUpdatedAtChanged = shouldBumpLastBranchUpdatedAt(
                  state.beforeChat,
                  state.beforeHeaders ?? [],
                  afterHeaders,
                  state.changedMessageIds,
                )
                if (lastBranchUpdatedAtChanged) next.lastBranchUpdatedAt = now
                if (
                  nextLeafId !== state.beforeChat.lastUpdatedLeafId ||
                  lastBranchUpdatedAtChanged
                ) {
                  await invalidateBranchCacheForSummary(tx, chatId)
                  wroteWorkspaceState = true
                  pendingBranchCacheEvents.add(chatId)
                }
              } else {
                const nextLeafId =
                  state.incrementalAppends.at(-1)?.id ?? state.beforeChat.lastUpdatedLeafId
                const branchHeaders = await branchHeadersByLeafInTransaction(tx, chatId, nextLeafId)
                next.lastUpdatedLeafId = nextLeafId
                let wordCountDelta = 0
                const branchIds = new Set(branchHeaders.map((header) => header.id))
                for (const [messageId, delta] of state.wordCountDeltas) {
                  if (branchIds.has(messageId)) wordCountDelta += delta
                }
                next.wordCount = Math.max(0, current.wordCount + wordCountDelta)
                next.totalCostUsd = Math.max(0, current.totalCostUsd + state.totalCostDelta)
                const lastBranchUpdatedAtChanged = shouldBumpLastBranchUpdatedAtFromHeaders(
                  state.beforeChat,
                  nextLeafId,
                  branchHeaders,
                  state.changedMessageIds,
                )
                if (lastBranchUpdatedAtChanged) next.lastBranchUpdatedAt = now
                if (
                  nextLeafId !== state.beforeChat.lastUpdatedLeafId ||
                  lastBranchUpdatedAtChanged
                ) {
                  await invalidateBranchCacheForSummary(tx, chatId)
                  wroteWorkspaceState = true
                  pendingBranchCacheEvents.add(chatId)
                }
              }
            }

            if (state.previewDirty) {
              next.previewText = await chatPreviewInTransaction(tx, chatId)
            }

            const summaryPatch = stripSummaryPatch(state.summaryPatch)
            const patched: Chat = { ...next, ...summaryPatch }

            const changed = stableStringify(current) !== stableStringify(patched)
            if (changed) {
              await chatTable.put(patched)
              await putChatSidebarProjection(tx, patched)
              wroteWorkspaceState = true
              affectedChatIds.push(chatId)
            }
            chatVersions[chatId] = {
              metaVersion: patched.metaVersion,
              summaryVersion: patched.summaryVersion,
            }
          }

          if (wroteWorkspaceState) {
            await bumpWorkspaceMeta(tx, now)
          }

          for (const [chatId, state] of chatStates) {
            if (!state.broadcast) continue
            const versions = chatVersions[chatId]
            if (!versions) continue
            pendingEvents.push({
              chatId,
              versions,
              affected: [...state.affected.values()],
            })
          }

          return {
            value,
            affectedChatIds,
            affectedMessageIds: [...affectedMessageIds],
            chatVersions,
          }
        },
      ),
    )

    for (const event of pendingEvents) {
      postEvent({
        kind: 'chat-mutated',
        chatId: event.chatId,
        metaVersion: event.versions.metaVersion,
        summaryVersion: event.versions.summaryVersion,
        affected: event.affected,
      })
    }
    for (const chatId of pendingBranchCacheEvents) {
      postEvent({ kind: 'branch-cache-refreshed', chatId })
    }

    return result
  }
}

let singleton: WorkspaceRepository | null = null

export function getBrowserRepository(): WorkspaceRepository {
  singleton ??= new BrowserWorkspaceRepository()
  return singleton
}

export function __resetBrowserRepositoryForTests(): void {
  singleton = null
}

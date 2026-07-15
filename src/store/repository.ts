import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  AttachmentKind,
  AttachmentOrigin,
  AttachmentStorage,
  Chat,
  ChatBranchCache,
  ChatFolder,
  ChatId,
  ChatTag,
  ChatVersions,
  ChildListState,
  ConnectionProfile,
  ContinuationStrategy,
  CursorMap,
  DraftRow,
  FolderId,
  GenerationMeta,
  KeyId,
  Message,
  MessageId,
  MutationScope,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  TagId,
} from '../core/types'
import type { MessageBodyFields, MessageHeaderRow } from './message-storage'

export class ChatMissingError extends Error {
  readonly chatId: ChatId

  constructor(chatId: ChatId) {
    super(`ChatMissing:${chatId}`)
    this.name = 'ChatMissingError'
    this.chatId = chatId
  }
}

export class ChatStreamBusyError extends Error {
  readonly chatId: ChatId
  readonly streamId: string

  constructor(chatId: ChatId, streamId: string) {
    super(`ChatStreamBusy:${chatId}:${streamId}`)
    this.name = 'ChatStreamBusyError'
    this.chatId = chatId
    this.streamId = streamId
  }
}

export interface WorkspaceMeta {
  workspaceId: string
  backendKind: 'browser-idb' | 'daemon' | 'unknown'
  lastMutationAt: number
  mutationCounter: number
  replacementEpoch: number
}

export interface MessagePresentationSnapshot {
  message: Message
  bodyVersion: number
}

export interface StreamWriteFence {
  ownerClientId: string
  fenceToken: string
  replacementEpoch: number
  admissionSequence?: number
}

export const STREAM_LEASE_TTL_MS = 15_000

export class StreamTargetBusyError extends Error {
  readonly messageId: MessageId

  constructor(messageId: MessageId) {
    super(`StreamTargetBusy:${messageId}`)
    this.name = 'StreamTargetBusyError'
    this.messageId = messageId
  }
}

export class WorkspaceReplacementFenceError extends Error {
  constructor() {
    super('WorkspaceReplacementFenceChanged')
    this.name = 'WorkspaceReplacementFenceError'
  }
}

export type ExpectedLeafChangedReason =
  | 'missing'
  | 'deleted'
  | 'wrong-chat'
  | 'has-live-child'
  | 'root-not-empty'

export class ExpectedLeafChangedError extends Error {
  readonly chatId: ChatId
  readonly expectedLeafId: MessageId | null
  readonly reason: ExpectedLeafChangedReason
  readonly blockingChildId?: MessageId

  constructor(
    chatId: ChatId,
    expectedLeafId: MessageId | null,
    reason: ExpectedLeafChangedReason,
    blockingChildId?: MessageId,
  ) {
    super(
      `ExpectedLeafChanged:${chatId}:${expectedLeafId ?? '__root__'}:${reason}${blockingChildId ? `:${blockingChildId}` : ''}`,
    )
    this.name = 'ExpectedLeafChangedError'
    this.chatId = chatId
    this.expectedLeafId = expectedLeafId
    this.reason = reason
    if (blockingChildId !== undefined) this.blockingChildId = blockingChildId
  }
}

export interface WorkspaceMutationOptions {
  streamFence?: {
    streamId: string
    fence: StreamWriteFence
  }
  workspaceFence?: {
    replacementEpoch: number
  }
}

export interface ChatBranchCacheWriteGuard {
  branchLeafId: MessageId | null
  lastBranchUpdatedAt: number
  summaryVersion: number
  replacementEpoch: number
  missingChat?: true
}

export function chatBranchCacheWriteGuard(
  chat: Pick<Chat, 'lastUpdatedLeafId' | 'lastBranchUpdatedAt' | 'summaryVersion'>,
  replacementEpoch: number,
): ChatBranchCacheWriteGuard {
  return {
    branchLeafId: chat.lastUpdatedLeafId,
    lastBranchUpdatedAt: chat.lastBranchUpdatedAt,
    summaryVersion: chat.summaryVersion,
    replacementEpoch,
  }
}

export function missingChatBranchCacheWriteGuard(
  replacementEpoch: number,
): ChatBranchCacheWriteGuard {
  return {
    branchLeafId: null,
    lastBranchUpdatedAt: 0,
    summaryVersion: 0,
    replacementEpoch,
    missingChat: true,
  }
}

export function chatMatchesBranchCacheWriteGuard(
  chat: Pick<Chat, 'lastUpdatedLeafId' | 'lastBranchUpdatedAt' | 'summaryVersion'>,
  expected: ChatBranchCacheWriteGuard,
): boolean {
  return (
    expected.missingChat !== true &&
    chat.lastUpdatedLeafId === expected.branchLeafId &&
    chat.lastBranchUpdatedAt === expected.lastBranchUpdatedAt &&
    chat.summaryVersion === expected.summaryVersion
  )
}

export interface StreamLeaseRow {
  streamId: string
  chatId: ChatId
  messageId?: MessageId
  ownerClientId: string
  fenceToken?: string
  replacementEpoch?: number
  startedAt: number
  heartbeatAt: number
  admissionSequence?: number
  attemptKind?: 'generation' | 'continuation'
  continuationStrategy?: ContinuationStrategy
  baseNodeVersion?: number
  baseBodyVersion?: number
  requestedModel?: string
  apiUsed?: GenerationMeta['apiUsed']
}

export function streamLeaseOwnsTargetWrites(
  lease: Pick<
    StreamLeaseRow,
    'messageId' | 'attemptKind' | 'continuationStrategy' | 'baseNodeVersion' | 'baseBodyVersion'
  >,
): boolean {
  if (!lease.messageId) return false
  if (lease.attemptKind !== 'continuation') return true
  return (
    lease.continuationStrategy !== undefined ||
    lease.baseNodeVersion !== undefined ||
    lease.baseBodyVersion !== undefined
  )
}

export interface AppendMessageToExpectedLeafInput {
  expectedLeafId: MessageId | null
  message: Omit<Message, 'parentId' | 'siblingIndex' | 'nodeVersion' | 'deleted'>
}

export interface AppendMessageToExpectedLeafResult {
  message: Message
  header: MessageHeaderRow
  branchHeaders: MessageHeaderRow[]
  versions: ChatVersions
  hadExistingSiblings: boolean
}

export interface BranchHeaderSnapshot {
  chat: Chat
  chatId: ChatId
  branchHeaders: MessageHeaderRow[]
}

export interface SendContextRevisionSnapshot {
  chat: Chat | undefined
  headers: Array<MessageHeaderRow | undefined>
}

export interface StreamChunkRow {
  id: string
  streamId: string
  chatId: ChatId
  messageId: MessageId
  seq: number
  createdAt: number
  event: unknown
  fenceToken?: string
  replacementEpoch?: number
}

export interface ChatMutationSummary {
  kind: 'chat-meta' | 'message' | 'children' | 'draft' | 'attachment'
  chatId?: ChatId
  messageId?: MessageId
  parentId?: MessageId | null
  attachmentId?: AttachmentId
}

export interface AttachmentSearchFilters {
  kind?: AttachmentKind
  mime?: string
  origin?: AttachmentOrigin
  storageKind?: AttachmentStorage['kind']
  minSizeBytes?: number
  maxSizeBytes?: number
  minRefCount?: number
  maxRefCount?: number
}

type AttachmentSearchSort =
  | 'created-desc'
  | 'created-asc'
  | 'updated-desc'
  | 'size-desc'
  | 'size-asc'

export interface AttachmentSearchQuery {
  query?: string
  filters?: AttachmentSearchFilters
  sort?: AttachmentSearchSort
  limit?: number
  cursor?: string
  signal?: AbortSignal
  onMeasure?: (measurement: AttachmentSearchMeasurement) => void
}

export interface AttachmentSearchPage {
  rows: Attachment[]
  nextCursor?: string
}

export interface AttachmentSearchMeasurement {
  selectedIndex: 'kind' | 'mime' | 'origin' | 'refCount' | 'createdAt' | 'updatedAt' | 'primary'
  indexCounts: Partial<Record<'kind' | 'mime' | 'origin' | 'refCount', number>>
  metadataRowsRead: number
  metadataCandidates: number
  embeddedArtifactRowsRead: number
  artifactCandidateAttachments: number
  artifactRowsRead: number
  attachmentBlobRowsRead: 0
  matchedRows: number
  returnedRows: number
}

export interface AttachmentBundle {
  attachment: Attachment
  blobs: AttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

interface ChatMetaPatchOptions {
  touchVisibleState?: boolean
  touchSummary?: boolean
  broadcast?: boolean
}

export interface PutMessageOptions {
  touchChatSummary?: boolean
  broadcast?: boolean
}

export type MessageBodyPatch = {
  [K in keyof MessageBodyFields]?: MessageBodyFields[K] | undefined
}

export type MessageHeaderPatch = {
  [K in keyof MessageHeaderRow]?: MessageHeaderRow[K] | undefined
}

export type MessageCalibrationPatch = Partial<
  Pick<
    Message,
    | 'originalCharCount'
    | 'originalTokenEstimate'
    | 'originalModelId'
    | 'originalCalibrationKey'
    | 'charCountDelta'
    | 'cachedTokenEstimate'
  >
> & { generation?: GenerationMeta }

export type MessageStructurePatch = Partial<
  Pick<MessageHeaderRow, 'deleted' | 'parentId' | 'siblingIndex'>
>

export interface PatchMessageBodyOptions extends PutMessageOptions {
  headerPatch?: MessageHeaderPatch
  // The patch is a full replacement for the message body fields. Used by
  // streaming flushes so appending text does not read, clone, and stringify
  // the previous full body on every chunk.
  replaceBody?: boolean
}

export interface MutationContext {
  getChat(chatId: ChatId): Promise<Chat | undefined>
  patchChatMeta(chatId: ChatId, patch: Partial<Chat>, options?: ChatMetaPatchOptions): void
  patchChatSummary(chatId: ChatId, patch: Partial<Chat>): void
  getMessage(messageId: MessageId): Promise<Message | undefined>
  getMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined>
  getMessageHeaders(messageIds: readonly MessageId[]): Promise<Array<MessageHeaderRow | undefined>>
  listMessages(chatId: ChatId): Promise<Message[]>
  listMessageHeaders(chatId: ChatId): Promise<MessageHeaderRow[]>
  listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<MessageHeaderRow[]>
  putMessage(message: Message, options?: PutMessageOptions): Promise<void>
  patchMessageStructure(messageId: MessageId, patch: MessageStructurePatch): Promise<void>
  patchMessageBody(
    messageId: MessageId,
    patch: MessageBodyPatch,
    options?: PatchMessageBodyOptions,
  ): Promise<void>
  patchMessageCalibration(
    messageId: MessageId,
    patch: MessageCalibrationPatch,
  ): Promise<MessageHeaderRow | undefined>
  deleteMessage(messageId: MessageId): Promise<void>
  getChildList(chatId: ChatId, parentId: MessageId | null): Promise<ChildListState>
  bumpChildList(chatId: ChatId, parentId: MessageId | null, now?: number): Promise<ChildListState>
  getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined>
  putAttachment(attachment: Attachment): Promise<void>
  deleteAttachment(attachmentId: AttachmentId): Promise<void>
  countAttachmentReferences(
    attachmentId: AttachmentId,
  ): Promise<{ messages: number; drafts: number; occurrences: number }>
  deleteAttachmentBlobs(attachmentId: AttachmentId): Promise<void>
  deleteAttachmentArtifacts(attachmentId: AttachmentId): Promise<void>
  deleteAttachmentJobs(attachmentId: AttachmentId): Promise<void>
  getAttachmentBlob(blobId: string): Promise<AttachmentBlob | undefined>
  putAttachmentBlob(blob: AttachmentBlob): Promise<void>
  deleteAttachmentBlob(blobId: string): Promise<void>
  putAttachmentArtifact(artifact: AttachmentArtifact): Promise<void>
  deleteAttachmentArtifact(artifactId: string): Promise<void>
  putAttachmentJob(job: AttachmentJob): Promise<void>
  deleteAttachmentJob(jobId: string): Promise<void>
  getDraft(chatId: ChatId): Promise<DraftRow | undefined>
  putDraft(draft: DraftRow): Promise<void>
  deleteDraft(chatId: ChatId): Promise<void>
}

export interface WorkspaceMutationResult<T> {
  value: T
  affectedChatIds: ChatId[]
  affectedMessageIds: MessageId[]
  chatVersions: Record<ChatId, ChatVersions>
}

export interface CreateFolderInput {
  id?: FolderId
  name: string
  color?: string
  sortIndex?: number
  now?: number
}

export interface UpdateFolderInput {
  name?: string
  color?: string | null
  sortIndex?: number
  lastUsedAt?: number | null
  now?: number
}

export interface DeleteFolderResult {
  deleted: boolean
  affectedChatIds: ChatId[]
}

export interface CreateTagInput {
  id?: TagId
  name: string
  color?: string
  now?: number
}

export interface UpdateTagInput {
  name?: string
  color?: string | null
  lastUsedAt?: number | null
  now?: number
}

export interface DeleteTagResult {
  deleted: boolean
  affectedChatIds: ChatId[]
}

export interface DeleteArchivedChatsResult {
  deletedChatIds: ChatId[]
  deletedChats: Chat[]
}

export interface ChatCascadeVersion extends ChatVersions {
  chatId: ChatId
}

export type DeletePresetCascadeResult =
  | { kind: 'missing' }
  | { kind: 'deleted'; chats: ChatCascadeVersion[] }

export interface UpdateProfileAtomicInput {
  profileId: ProfileId
  patch: Partial<Omit<ConnectionProfile, 'id' | 'createdAt'>>
  now: number
}

export type UpdateProfileAtomicResult =
  | { kind: 'missing' }
  | { kind: 'updated'; profile: ConnectionProfile; cachesInvalidated: boolean }

export interface DeleteProfileAtomicInput {
  profileId: ProfileId
  force?: boolean
  reassignTo?: ProfileId
  now: number
}

export type DeleteProfileAtomicResult =
  | { kind: 'missing-profile'; profileId: ProfileId }
  | { kind: 'missing-target'; profileId: ProfileId }
  | { kind: 'in-use'; presetIds: PresetId[]; chatIds: ChatId[] }
  | {
      kind: 'deleted'
      chats: ChatCascadeVersion[]
      presetIds: PresetId[]
      deletedKeyIds: KeyId[]
    }

export interface PromptPresetSlot {
  textKey:
    | 'systemPrompt'
    | 'appendPrompt'
    | 'continueSystemPrompt'
    | 'continueUserPrompt'
    | 'defaultPrefill'
  pinKey:
    | 'systemPromptPresetId'
    | 'appendPromptPresetId'
    | 'continueSystemPromptPresetId'
    | 'continueUserPromptPresetId'
    | 'defaultPrefillPresetId'
}

interface PromptPresetCascadeResultBase {
  chats: ChatCascadeVersion[]
  presetIds: PresetId[]
}

export interface UpdatePromptPresetAtomicInput {
  presetId: PromptPresetId
  patch: { name?: string; text?: string }
  slot: PromptPresetSlot
  now: number
}

export type UpdatePromptPresetAtomicResult =
  | { kind: 'missing' }
  | ({ kind: 'updated'; promptPreset: PromptPreset } & PromptPresetCascadeResultBase)

export interface DeletePromptPresetAtomicInput {
  presetId: PromptPresetId
  slot: PromptPresetSlot
  now: number
}

export type DeletePromptPresetAtomicResult =
  | { kind: 'missing' }
  | ({ kind: 'deleted' } & PromptPresetCascadeResultBase)

export interface ForkChatFromMessageInput {
  chatId: ChatId
  messageId: MessageId
  title: string
  now?: number
}

export interface ForkChatFromMessageResult {
  chatId: ChatId
  messageCount: number
}

interface BranchSiblingGroup {
  parentId: MessageId | null
  siblings: MessageHeaderRow[]
}

export interface ActiveBranchSnapshot {
  chatId: ChatId
  branch: Message[]
  allHeaders: MessageHeaderRow[]
  branchHeaders: MessageHeaderRow[]
  siblingGroups: BranchSiblingGroup[]
  treeKey: string
}

export interface ActiveBranchBodyPage {
  // Negative offsets anchor the page to the newest branch messages.
  offset: number
  limit: number
  signal?: AbortSignal
  onMeasure?: (measurement: KnownBranchPageMeasurement) => void
}

interface KnownBranchPageMeasurement {
  pageHeaderRowsRead: number
  bodyRowsRead: number
}

export interface ActiveBranchPageSnapshot {
  chatId: ChatId
  pageMessages: Message[]
  pageHeaders: MessageHeaderRow[]
  pageOffset: number
  pageLimit: number
  branchLength: number
}

export interface ActiveBranchWindowSnapshot {
  chatId: ChatId
  branchWindow: Message[]
  branchHeaders: MessageHeaderRow[]
  windowOffset: number
  windowLimit: number
  branchLength: number
}

type KnownBranchStaleReason =
  | 'database-unavailable'
  | 'empty-path'
  | 'duplicate-id'
  | 'missing-header'
  | 'wrong-chat'
  | 'deleted-header'
  | 'non-root'
  | 'non-contiguous'
  | 'missing-body'
  | 'body-version-mismatch'

interface KnownBranchStalePathResult {
  kind: 'stale-path'
  chatId: ChatId
  reason: KnownBranchStaleReason
  messageId?: MessageId
}

export type KnownBranchPageResult =
  | { kind: 'ready'; snapshot: ActiveBranchPageSnapshot }
  | KnownBranchStalePathResult

export interface WorkspaceRepository {
  getWorkspaceMeta(): Promise<WorkspaceMeta>
  appendMessageToExpectedLeaf(
    input: AppendMessageToExpectedLeafInput,
  ): Promise<AppendMessageToExpectedLeafResult>
  forkChatFromMessage(input: ForkChatFromMessageInput): Promise<ForkChatFromMessageResult>
  createChat(chat: Chat): Promise<Chat>
  discardEmptyDraftChats(input: {
    chatIds?: readonly ChatId[]
    exceptChatId?: ChatId | null
    now?: number
  }): Promise<ChatId[]>
  deletePresetAndClearBreadcrumbs(
    presetId: PresetId,
    now: number,
  ): Promise<DeletePresetCascadeResult>
  updateProfileAndInvalidateCaches(
    input: UpdateProfileAtomicInput,
  ): Promise<UpdateProfileAtomicResult>
  deleteProfileAndReassign(input: DeleteProfileAtomicInput): Promise<DeleteProfileAtomicResult>
  updatePromptPresetAndPropagate(
    input: UpdatePromptPresetAtomicInput,
  ): Promise<UpdatePromptPresetAtomicResult>
  deletePromptPresetAndClearPins(
    input: DeletePromptPresetAtomicInput,
  ): Promise<DeletePromptPresetAtomicResult>
  upsertStreamLease(lease: StreamLeaseRow): Promise<StreamLeaseRow>
  renewStreamLease(
    lease: StreamLeaseRow,
    options?: { targetChanged?: boolean },
  ): Promise<StreamLeaseRow>
  claimStreamLeaseForRecovery(
    expected: StreamLeaseRow,
    now: number,
  ): Promise<StreamLeaseRow | undefined>
  deleteStreamLease(streamId: string): Promise<boolean>
  deleteOwnedStreamLease(streamId: string, fence: StreamWriteFence): Promise<boolean>
  getStreamLease(streamId: string): Promise<StreamLeaseRow | undefined>
  listStreamLeases(chatId?: ChatId): Promise<StreamLeaseRow[]>
  listStreamLeasesForMessage(messageId: MessageId): Promise<StreamLeaseRow[]>
  listMessageLessGenerationStreamLeases(chatId: ChatId): Promise<StreamLeaseRow[]>
  appendStreamChunks(chunks: readonly StreamChunkRow[]): Promise<void>
  listStreamChunks(streamId: string): Promise<StreamChunkRow[]>
  listStreamChunksForMessage(messageId: MessageId): Promise<StreamChunkRow[]>
  listStreamChunksForChat(chatId: ChatId): Promise<StreamChunkRow[]>
  deleteStreamChunks(streamId: string, fence?: StreamWriteFence): Promise<number>
  deleteStreamJournal(
    streamId: string,
    options:
      | {
          replacementEpoch: number
          streamFence: StreamWriteFence
          expectedLeaseMissing?: never
        }
      | {
          replacementEpoch: number
          expectedLeaseMissing: true
          streamFence?: never
        },
  ): Promise<{ deletedLease: boolean; deletedChunks: number }>
  listChats(): Promise<Chat[]>
  getChat(chatId: ChatId): Promise<Chat | undefined>
  deleteArchivedChat(chatId: ChatId): Promise<boolean>
  deleteArchivedChatReturningRow(chatId: ChatId): Promise<Chat | undefined>
  emptyArchivedChats(): Promise<DeleteArchivedChatsResult>
  listFolders(): Promise<ChatFolder[]>
  getFolder(folderId: FolderId): Promise<ChatFolder | undefined>
  createFolder(input: CreateFolderInput): Promise<ChatFolder>
  updateFolder(folderId: FolderId, patch: UpdateFolderInput): Promise<ChatFolder | undefined>
  deleteFolder(folderId: FolderId): Promise<DeleteFolderResult>
  listTags(): Promise<ChatTag[]>
  getTag(tagId: TagId): Promise<ChatTag | undefined>
  createTag(input: CreateTagInput): Promise<ChatTag>
  updateTag(tagId: TagId, patch: UpdateTagInput): Promise<ChatTag | undefined>
  deleteTag(tagId: TagId): Promise<DeleteTagResult>
  getChatBranchCache(chatId: ChatId): Promise<ChatBranchCache | undefined>
  putChatBranchCache(
    cache: ChatBranchCache,
    expected: ChatBranchCacheWriteGuard,
  ): Promise<ChatBranchCache | undefined>
  deleteChatBranchCache(chatId: ChatId, expected?: ChatBranchCacheWriteGuard): Promise<boolean>
  getMessage(messageId: MessageId, options?: { signal?: AbortSignal }): Promise<Message | undefined>
  getMessagePresentationSnapshot(
    messageId: MessageId,
    options?: { signal?: AbortSignal },
  ): Promise<MessagePresentationSnapshot | undefined>
  getMessageTextPreview(
    messageId: MessageId,
    options?: { maxChars?: number; signal?: AbortSignal },
  ): Promise<string | undefined>
  searchChatMessageText(
    chatId: ChatId,
    query: string,
    options?: { signal?: AbortSignal },
  ): Promise<MessageId[]>
  listMessages(chatId: ChatId): Promise<Message[]>
  getMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined>
  getMessageHeaders(
    messageIds: readonly MessageId[],
    options?: { signal?: AbortSignal },
  ): Promise<Array<MessageHeaderRow | undefined>>
  // One coherent settings+header read. Header slots preserve messageIds order;
  // this path must never hydrate message bodies.
  getSendContextRevisionSnapshot(
    chatId: ChatId,
    messageIds: readonly MessageId[],
  ): Promise<SendContextRevisionSnapshot>
  listMessageHeaders(
    chatId: ChatId,
    options?: { signal?: AbortSignal },
  ): Promise<MessageHeaderRow[]>
  listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<MessageHeaderRow[]>
  getActiveBranchSnapshot(chatId: ChatId, cursor: CursorMap): Promise<ActiveBranchSnapshot>
  getKnownBranchPageSnapshot(
    chatId: ChatId,
    pathMessageIds: readonly MessageId[],
    page: ActiveBranchBodyPage,
  ): Promise<KnownBranchPageResult>
  getBranchHeaderSnapshotByLeaf(
    chatId: ChatId,
    leafId: MessageId | null,
  ): Promise<BranchHeaderSnapshot>
  getBranchByLeaf(chatId: ChatId, leafId: MessageId | null): Promise<Message[]>
  getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined>
  getAttachmentBundle(attachmentId: AttachmentId): Promise<AttachmentBundle | undefined>
  getAttachmentBlob(blobId: string): Promise<AttachmentBlob | undefined>
  searchAttachments(query?: AttachmentSearchQuery): Promise<AttachmentSearchPage>
  getDraft(chatId: ChatId): Promise<DraftRow | undefined>
  runMutation<T>(
    scopes: MutationScope[],
    fn: (ctx: MutationContext) => Promise<T> | T,
    options?: WorkspaceMutationOptions,
  ): Promise<WorkspaceMutationResult<T>>
}

export async function readChatBranchCacheSource(
  repo: Pick<WorkspaceRepository, 'getChat' | 'getWorkspaceMeta'>,
  chatId: ChatId,
): Promise<{ chat: Chat | undefined; expected: ChatBranchCacheWriteGuard }> {
  for (;;) {
    const before = await repo.getWorkspaceMeta()
    const chat = await repo.getChat(chatId)
    const after = await repo.getWorkspaceMeta()
    if (before.replacementEpoch !== after.replacementEpoch) continue
    return {
      chat,
      expected: chat
        ? chatBranchCacheWriteGuard(chat, after.replacementEpoch)
        : missingChatBranchCacheWriteGuard(after.replacementEpoch),
    }
  }
}

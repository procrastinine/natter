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
  DraftRow,
  FolderId,
  Message,
  MessageId,
  MutationScope,
  CursorMap,
  TagId,
} from '../core/types'
import type { MessageBodyFields, MessageHeaderRow } from './message-storage'

export interface WorkspaceMeta {
  workspaceId: string
  lastMutationAt: number
  mutationCounter: number
}

export interface StreamLeaseRow {
  streamId: string
  chatId: ChatId
  messageId?: MessageId
  ownerClientId: string
  startedAt: number
  heartbeatAt: number
}

export interface StreamChunkRow {
  id: string
  streamId: string
  chatId: ChatId
  messageId: MessageId
  seq: number
  createdAt: number
  event: unknown
}

export interface ChatMutationSummary {
  kind: 'chat-meta' | 'message' | 'children' | 'draft' | 'attachment'
  chatId?: ChatId
  messageId?: MessageId
  parentId?: MessageId | null
  attachmentId?: AttachmentId
}

interface AttachmentSearchFilters {
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
}

export interface AttachmentSearchPage {
  rows: Attachment[]
  nextCursor?: string
}

export interface AttachmentBundle {
  attachment: Attachment
  blobs: AttachmentBlob[]
  artifacts: AttachmentArtifact[]
  jobs: AttachmentJob[]
}

interface ChatMetaPatchOptions {
  touchVisibleState?: boolean
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
  listMessages(chatId: ChatId): Promise<Message[]>
  listMessageHeaders(chatId: ChatId): Promise<MessageHeaderRow[]>
  listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<MessageHeaderRow[]>
  listChildren(chatId: ChatId, parentId: MessageId | null): Promise<Message[]>
  putMessage(message: Message, options?: PutMessageOptions): Promise<void>
  patchMessageBody(
    messageId: MessageId,
    patch: MessageBodyPatch,
    options?: PatchMessageBodyOptions,
  ): Promise<void>
  deleteMessage(messageId: MessageId): Promise<void>
  getChildList(chatId: ChatId, parentId: MessageId | null): Promise<ChildListState>
  bumpChildList(chatId: ChatId, parentId: MessageId | null, now?: number): Promise<ChildListState>
  getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined>
  putAttachment(attachment: Attachment): Promise<void>
  deleteAttachment(attachmentId: AttachmentId): Promise<void>
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

export interface ActiveBranchBodyWindow {
  // Negative offsets anchor the window to the newest branch messages.
  offset: number
  limit: number
}

export interface ActiveBranchWindowSnapshot {
  chatId: ChatId
  branchWindow: Message[]
  allHeaders: MessageHeaderRow[]
  branchHeaders: MessageHeaderRow[]
  windowOffset: number
  windowLimit: number
  branchLength: number
  siblingGroups: BranchSiblingGroup[]
  treeKey: string
}

export interface WorkspaceRepository {
  getWorkspaceMeta(): Promise<WorkspaceMeta>
  upsertStreamLease(lease: StreamLeaseRow): Promise<StreamLeaseRow>
  deleteStreamLease(streamId: string): Promise<boolean>
  listStreamLeases(chatId?: ChatId): Promise<StreamLeaseRow[]>
  appendStreamChunks(chunks: readonly StreamChunkRow[]): Promise<void>
  listStreamChunksForMessage(messageId: MessageId): Promise<StreamChunkRow[]>
  listStreamChunksForChat(chatId: ChatId): Promise<StreamChunkRow[]>
  deleteStreamChunks(streamId: string): Promise<number>
  listChats(): Promise<Chat[]>
  getChat(chatId: ChatId): Promise<Chat | undefined>
  deleteArchivedChat(chatId: ChatId): Promise<boolean>
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
  putChatBranchCache(cache: ChatBranchCache): Promise<ChatBranchCache>
  deleteChatBranchCache(chatId: ChatId): Promise<boolean>
  getMessage(messageId: MessageId): Promise<Message | undefined>
  listMessages(chatId: ChatId): Promise<Message[]>
  getMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined>
  listMessageHeaders(chatId: ChatId): Promise<MessageHeaderRow[]>
  listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<MessageHeaderRow[]>
  getActiveBranchSnapshot(chatId: ChatId, cursor: CursorMap): Promise<ActiveBranchSnapshot>
  getActiveBranchWindowSnapshot(
    chatId: ChatId,
    cursor: CursorMap,
    window: ActiveBranchBodyWindow,
  ): Promise<ActiveBranchWindowSnapshot>
  getBranchByLeaf(chatId: ChatId, leafId: MessageId | null): Promise<Message[]>
  getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined>
  getAttachmentBundle(attachmentId: AttachmentId): Promise<AttachmentBundle | undefined>
  getAttachmentBlob(blobId: string): Promise<AttachmentBlob | undefined>
  searchAttachments(query?: AttachmentSearchQuery): Promise<AttachmentSearchPage>
  getDraft(chatId: ChatId): Promise<DraftRow | undefined>
  runMutation<T>(
    scopes: MutationScope[],
    fn: (ctx: MutationContext) => Promise<T> | T,
  ): Promise<WorkspaceMutationResult<T>>
}

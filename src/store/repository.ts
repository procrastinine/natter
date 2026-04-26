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
  ChatId,
  ChatVersions,
  ChildListState,
  DraftRow,
  Message,
  MessageId,
  MutationScope,
} from '../core/types'

export interface WorkspaceMeta {
  workspaceId: string
  lastMutationAt: number
  mutationCounter: number
}

export interface ChatMutationSummary {
  kind: 'chat-meta' | 'message' | 'children' | 'draft' | 'attachment'
  chatId?: ChatId
  messageId?: MessageId
  parentId?: MessageId | null
  attachmentId?: AttachmentId
}

export interface WorkspaceEvent {
  kind: 'chat-mutated'
  chatId: ChatId
  metaVersion: number
  summaryVersion: number
  affected: ChatMutationSummary[]
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

export type AttachmentSearchSort =
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

export interface ChatMetaPatchOptions {
  touchVisibleState?: boolean
  broadcast?: boolean
}

export interface PutMessageOptions {
  touchChatSummary?: boolean
  broadcast?: boolean
}

export interface MutationContext {
  getChat(chatId: ChatId): Promise<Chat | undefined>
  patchChatMeta(chatId: ChatId, patch: Partial<Chat>, options?: ChatMetaPatchOptions): void
  patchChatSummary(chatId: ChatId, patch: Partial<Chat>): void
  getMessage(messageId: MessageId): Promise<Message | undefined>
  listMessages(chatId: ChatId): Promise<Message[]>
  listChildren(chatId: ChatId, parentId: MessageId | null): Promise<Message[]>
  putMessage(message: Message, options?: PutMessageOptions): Promise<void>
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

export interface WorkspaceRepository {
  getWorkspaceMeta(): Promise<WorkspaceMeta>
  listChats(): Promise<Chat[]>
  getChat(chatId: ChatId): Promise<Chat | undefined>
  getMessage(messageId: MessageId): Promise<Message | undefined>
  listMessages(chatId: ChatId): Promise<Message[]>
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

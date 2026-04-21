import type {
  Attachment,
  AttachmentId,
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
  getDraft(chatId: ChatId): Promise<DraftRow | undefined>
  runMutation<T>(
    scopes: MutationScope[],
    fn: (ctx: MutationContext) => Promise<T> | T,
  ): Promise<WorkspaceMutationResult<T>>
}

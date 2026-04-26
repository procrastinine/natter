import type { Chat, ChatId, DraftRow, Message, MessageId } from '../core/types'
import type { WorkspaceRepository } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

// Phase 0-4 read-side cache boundary. The current implementation is a thin
// repository-backed facade so UI code can depend on one workspace surface
// without reaching directly into Dexie tables.
export interface WorkspaceCache {
  listChats(): Promise<Chat[]>
  getChat(chatId: ChatId): Promise<Chat | undefined>
  listMessages(chatId: ChatId): Promise<Message[]>
  getMessage(messageId: MessageId): Promise<Message | undefined>
  getDraft(chatId: ChatId): Promise<DraftRow | undefined>
}

class RepositoryWorkspaceCache implements WorkspaceCache {
  private readonly repo: WorkspaceRepository

  constructor(repo: WorkspaceRepository) {
    this.repo = repo
  }

  listChats(): Promise<Chat[]> {
    return this.repo.listChats()
  }

  getChat(chatId: ChatId): Promise<Chat | undefined> {
    return this.repo.getChat(chatId)
  }

  listMessages(chatId: ChatId): Promise<Message[]> {
    return this.repo.listMessages(chatId)
  }

  getMessage(messageId: MessageId): Promise<Message | undefined> {
    return this.repo.getMessage(messageId)
  }

  getDraft(chatId: ChatId): Promise<DraftRow | undefined> {
    return this.repo.getDraft(chatId)
  }
}

let singleton: WorkspaceCache | null = null

export function getWorkspaceCache(): WorkspaceCache {
  singleton ??= new RepositoryWorkspaceCache(getWorkspaceRepository())
  return singleton
}

export function __resetWorkspaceCacheForTests(): void {
  singleton = null
}

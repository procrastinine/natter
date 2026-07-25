import type { ChatId, MessageId } from '../core/types'
import type { MessageTextEvaluation } from './message-search-service'
import type { MessageHeaderRow } from './message-storage'
import type { WorkspaceFence } from './repository'

export type BranchTreeSearchStatus = 'idle' | 'searching' | 'ready' | 'error'

export interface BranchTreeSearchTarget {
  readonly id: MessageId
  readonly nodeVersion: number
  readonly bodyVersion: number
  readonly pending: boolean
  readonly deleted: boolean
}

export interface BranchTreeSearchRequest extends WorkspaceFence {
  readonly chatId: ChatId
  readonly query: string
  readonly targets: readonly BranchTreeSearchTarget[]
}

export interface BranchTreeSearchSnapshot extends WorkspaceFence {
  readonly revision: number
  readonly status: BranchTreeSearchStatus
  readonly interactive: boolean
  readonly chatId: ChatId
  readonly query: string
  readonly matches: readonly MessageId[]
  readonly currentIndex: number
  readonly currentMatchId: MessageId | null
  readonly revealRevision: number
  readonly error: unknown
}

export interface BranchTreeSearchSource {
  searchChatMessageText(
    chatId: ChatId,
    query: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly MessageId[]>
  evaluateMessageTexts(
    chatId: ChatId,
    messageIds: readonly MessageId[],
    query: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly MessageTextEvaluation[]>
}

export interface BranchTreeSearchSession {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => BranchTreeSearchSnapshot | null
  setActive(active: boolean): void
  request(request: BranchTreeSearchRequest): void
  replaceTopology(targets: readonly BranchTreeSearchTarget[]): void
  observeHeaders(headers: readonly MessageHeaderRow[]): void
  observeTargets(targets: readonly BranchTreeSearchTarget[]): void
  setInspectedMessageId(messageId: MessageId | null): void
  move(delta: -1 | 1): MessageId | null
  clear(): void
  dispose(): void
}

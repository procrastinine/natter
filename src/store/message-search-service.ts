import { messageRenderableTextSegments } from '../core/branch-flatten'
import {
  literalSearchClause,
  literalSearchText,
  type MessageCorpusSearchRequest,
  type MessageCorpusSearchResult,
  scanSearchTextSegments,
} from '../core/search-query'
import type { ChatId, MessageId } from '../core/types'
import type { WorkspaceReadAuthority, WorkspaceRepository } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export interface MessageSearchOptions {
  readonly repository?: WorkspaceRepository
  readonly authority?: WorkspaceReadAuthority
  readonly signal?: AbortSignal
}

export interface MessageTextEvaluation {
  readonly messageId: MessageId
  readonly nodeVersion?: number
  readonly bodyVersion?: number
  readonly present: boolean
  readonly pending: boolean
  readonly matches: boolean
}

export async function searchMessageCorpus(
  request: MessageCorpusSearchRequest,
  options: MessageSearchOptions = {},
): Promise<MessageCorpusSearchResult> {
  const authority = options.authority
  if (!authority) {
    return runWorkspaceRead(
      'search-session',
      (permit) =>
        searchMessageCorpus(request, {
          ...options,
          authority: permit,
          signal: permit.signal,
        }),
      options.signal ? { signal: options.signal } : {},
    )
  }
  const repository = options.repository ?? getWorkspaceRepository()
  const envelope = await repository.query(
    authority,
    { kind: 'message.search-corpus', request },
    { signal: options.signal ?? authority.signal },
  )
  return envelope.value
}

export async function searchChatMessageText(
  chatId: ChatId,
  query: string,
  options: MessageSearchOptions = {},
): Promise<MessageId[]> {
  if (query.length === 0) return []
  const result = await searchMessageCorpus(
    {
      chatId,
      clauses: [literalSearchClause(query)],
      collectMatchingMessageIds: true,
    },
    options,
  )
  return [...result.matchingMessageIds]
}

export async function evaluateMessageTexts(
  chatId: ChatId,
  messageIds: readonly MessageId[],
  query: string,
  options: MessageSearchOptions = {},
): Promise<MessageTextEvaluation[]> {
  if (query.length === 0) {
    return messageIds.map((messageId) => ({
      messageId,
      present: false,
      pending: false,
      matches: false,
    }))
  }
  const authority = options.authority
  if (!authority) {
    return runWorkspaceRead(
      'search-session',
      (permit) =>
        evaluateMessageTexts(chatId, messageIds, query, {
          ...options,
          authority: permit,
          signal: permit.signal,
        }),
      options.signal ? { signal: options.signal } : {},
    )
  }
  const repository = options.repository ?? getWorkspaceRepository()
  const presentations = (
    await repository.query(
      authority,
      { kind: 'message.presentations', messageIds },
      { signal: options.signal ?? authority.signal },
    )
  ).value
  if (presentations.length !== messageIds.length) {
    throw new Error('MessageTextEvaluationLengthMismatch')
  }
  const compiled = literalSearchText(query)
  return messageIds.map((messageId, index) => {
    const presentation = presentations[index]
    if (
      !presentation ||
      presentation.header.id !== messageId ||
      presentation.header.chatId !== chatId ||
      presentation.header.deleted
    ) {
      return { messageId, present: false, pending: false, matches: false }
    }
    return {
      messageId,
      nodeVersion: presentation.header.nodeVersion,
      bodyVersion: presentation.bodyVersion,
      present: true,
      pending: false,
      matches: scanSearchTextSegments(
        messageRenderableTextSegments(presentation.message),
        compiled,
        {
          signal: options.signal ?? authority.signal,
        },
      ).matches,
    }
  })
}

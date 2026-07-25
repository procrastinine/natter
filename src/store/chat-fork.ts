import type { ChatId, MessageId } from '../core/types'
import {
  type ConversationCommittedResult,
  conversationCommittedResult,
} from './conversation-repository-adapter'
import type { ForkChatFromMessageResult } from './repository'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction } from './workspace-runtime'

export function forkChatFromMessage(
  input: {
    chatId: ChatId
    messageId: MessageId
    title: string
    destinationChatId?: ChatId
    now?: number
  },
  apply?: (result: ConversationCommittedResult<ForkChatFromMessageResult>) => void,
): Promise<ConversationCommittedResult<ForkChatFromMessageResult>> {
  return runWorkspaceAction('chat-fork', (permit) =>
    getWorkspaceRepository()
      .execute(
        permit,
        { kind: 'chat.fork', input },
        apply
          ? {
              localApplications: {
                conversation: (commit) => {
                  apply(conversationCommittedResult(commit, commit.value.chatId))
                  return 'applied'
                },
              },
            }
          : undefined,
      )
      .then((commit) => conversationCommittedResult(commit, commit.value.chatId)),
  )
}

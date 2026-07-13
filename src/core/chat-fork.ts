// "Branch this chat from here" — fork an entire chat at the selected
// message into a NEW Chat row.
//
// Distinct from the per-message structural "branch from here" action
// (§8.4.6 `branchExplicit`), which creates a SIBLING variant in the
// same chat. The fork produces a brand-new chat that contains only the
// active-path ancestors of the selected message (root → … → node,
// inclusive) — no descendants below the node, no sibling variants. The
// user then "continues from here" in a separate chat.
//
// Performance note: a "branch" of a chat really means the selection of
// a leaf. The tree stores every node and branches are just one root→
// leaf walk picked by the cursor. This fork flattens that walk into a
// self-contained Chat, which is why it doesn't need to copy siblings
// or descendants.

import type { ForkChatFromMessageResult } from '../store/repository'
import { getWorkspaceRepository } from '../store/workspace-repository'
import { indexById } from './active-path'
import type { ChatId, Message, MessageId } from './types'

interface ForkChatFromMessageInput {
  chatId: ChatId
  messageId: MessageId
  title: string
  cursor: Record<string, MessageId>
  now?: number
}

// Walk up from `messageId` via `parentId` to collect the active-path
// ancestors up to and including the target. Returns them in root→target
// order. Throws if the target doesn't exist or doesn't belong to the chat.
export function collectAncestorsToMessage(
  messages: readonly Message[],
  targetId: MessageId,
): Message[] {
  const byId = indexById(messages)
  const target = byId.get(targetId)
  if (!target) {
    throw new Error(`fork: message ${targetId} not found`)
  }
  const ancestors: Message[] = []
  let cur: Message | undefined = target
  while (cur) {
    ancestors.push(cur)
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  ancestors.reverse()
  return ancestors
}

// Compute a default title for a fork: "{base} Branch N" where N is the
// smallest positive integer making the title unique in the current chat
// list. If the source chat has no title (titleStatus: 'untitled' or an
// empty title), use the constant placeholder "Untitled chat".
export function computeBranchTitle(baseTitle: string, existingTitles: readonly string[]): string {
  const base = baseTitle.trim() || 'Untitled chat'
  const taken = new Set(existingTitles.map((t) => t.trim()))
  let n = 1
  while (taken.has(`${base} Branch ${n}`)) n += 1
  return `${base} Branch ${n}`
}

export async function forkChatFromMessage(
  input: ForkChatFromMessageInput,
): Promise<ForkChatFromMessageResult> {
  const { cursor: _cursor, ...repositoryInput } = input
  void _cursor
  return getWorkspaceRepository().forkChatFromMessage(repositoryInput)
}

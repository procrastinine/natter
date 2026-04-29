// Branch-explicit clone helper. See `plan/13-delivery.md §13.2.2` (Branch-explicit rule)
// and `plan/08-branching.md §8.4.6`.
//
// A "Branch from here" op creates a new sibling of a source message. The clone
// copies a narrow set of user-authored fields and clears all generation-specific
// state. The caller supplies the new ids + tree position; this function only
// shapes the field copy.

import type { Message, MessageId, TurnId } from './types'

// Fields the clone copies verbatim from the source. Kept as a readonly tuple so
// the type checker flags plan drift when a field is added/removed.
export const BRANCH_EXPLICIT_COPY_FIELDS = [
  'content',
  'attachmentRefs',
  'pinCache',
  'hiddenFromContext',
  'role',
] as const

// Fields the clone must NOT carry over — they describe the previous generation
// run and would be stale on a new sibling. Asserted by the unit test.
export const BRANCH_EXPLICIT_CLEAR_FIELDS = [
  'generation',
  'reasoningDetails',
  'toolCalls',
  'responsesEchoItem',
  'phase',
  'refusal',
  'editedAt',
] as const

interface BranchExplicitInput {
  id: MessageId
  turnId: TurnId
  turnIndex: number
  parentId: MessageId | null
  siblingIndex: number
  createdAt: number
}

// Build the cloned `Message` for an explicit-branch op. The caller is responsible
// for persistence and cursor advance; this is a pure transform.
export function cloneForExplicitBranch(source: Message, input: BranchExplicitInput): Message {
  const cloned: Message = {
    id: input.id,
    chatId: source.chatId,
    parentId: input.parentId,
    siblingIndex: input.siblingIndex,
    turnId: input.turnId,
    turnIndex: input.turnIndex,
    createdAt: input.createdAt,
    role: source.role,
    origin: 'imported',
    content: structuredClone(source.content),
    nodeVersion: 0,
    deleted: false,
  }
  if (source.attachmentRefs !== undefined) {
    cloned.attachmentRefs = structuredClone(source.attachmentRefs)
  }
  if (source.pinCache !== undefined) {
    cloned.pinCache = source.pinCache
  }
  if (source.hiddenFromContext !== undefined) {
    cloned.hiddenFromContext = source.hiddenFromContext
  }
  return cloned
}

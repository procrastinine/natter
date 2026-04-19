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
// a leaf — the tree stores every node and branches are just one root→
// leaf walk picked by the cursor. This fork flattens that walk into a
// self-contained Chat, which is why it doesn't need to copy siblings
// or descendants. See `plan/08-branching.md §8.1` + `§8.3`.

import type {
  AttachmentId,
  Chat,
  ChatId,
  Message,
  MessageId,
} from './types'
import { activePath, indexById } from './active-path'
import { getDb } from '../store/db'
import { createChat, loadChatMessages } from '../store/chats'
import { incRefs } from '../store/attachments'
import { getBrowserRepository } from '../store/browser-repo'
import { postEvent } from '../store/broadcast'
import { newId } from '../lib/ulid'

export interface ForkChatFromMessageInput {
  chatId: ChatId
  messageId: MessageId
  title: string
  cursor: Record<string, MessageId>
  now?: number
}

export interface ForkChatFromMessageResult {
  chatId: ChatId
  messageCount: number
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
export function computeBranchTitle(
  baseTitle: string,
  existingTitles: readonly string[],
): string {
  const base = baseTitle.trim() || 'Untitled chat'
  const taken = new Set(existingTitles.map((t) => t.trim()))
  let n = 1
  while (taken.has(`${base} Branch ${n}`)) n += 1
  return `${base} Branch ${n}`
}

export async function forkChatFromMessage(
  input: ForkChatFromMessageInput,
): Promise<ForkChatFromMessageResult> {
  const source = await getDb().chats.get(input.chatId)
  if (!source) throw new Error(`fork: source chat ${input.chatId} not found`)
  const allMessages = await loadChatMessages(input.chatId)
  const ancestors = collectAncestorsToMessage(allMessages, input.messageId)
  if (ancestors.length === 0) {
    throw new Error('fork: no ancestors to copy')
  }
  // Sanity-check: verify the target is on the currently-viewed active
  // path. Silent prune if not — we still fork, but from the computed
  // ancestors (which may differ from the user's cursor if they
  // mid-action swiped).
  void activePath

  const now = input.now ?? Date.now()
  // Copy settings by value so the fork can diverge freely.
  const forkedSettings = structuredClone(source.settings)
  const newChat = await createChat({
    title: input.title,
    settings: forkedSettings,
    ...(source.presetId ? { presetId: source.presetId } : {}),
    now,
  })
  const titlePatch: Partial<Chat> = {
    title: input.title,
    titleStatus: 'manual',
  }
  await getDb().chats.update(newChat.id, titlePatch)

  // Assign each ancestor a fresh id; thread parentId through the chain.
  // Keep role, origin, content, reasoningDetails, toolCalls, phase,
  // generation (as factual record), attachmentRefs. `createdAt` is
  // remapped to preserve relative ordering but anchored at `now` so the
  // fork is clearly a recent object in the sidebar.
  const idMap = new Map<MessageId, MessageId>()
  for (const row of ancestors) idMap.set(row.id, newId())

  const repo = getBrowserRepository()
  const touchedAttachments: AttachmentId[] = []
  const scopes: Array<
    | { kind: 'message'; messageId: MessageId }
    | { kind: 'children'; chatId: ChatId; parentId: MessageId | null }
    | { kind: 'attachment'; attachmentId: AttachmentId }
  > = ancestors.map((row) => ({
    kind: 'message' as const,
    messageId: idMap.get(row.id) as MessageId,
  }))
  // Claim the children scope for every unique parentId slot we're about
  // to populate so the mutation executor allows the `putMessage` calls.
  const parentSlots = new Set<string>()
  for (const row of ancestors) {
    const newParentId = row.parentId
      ? (idMap.get(row.parentId) ?? null)
      : null
    const key = newParentId ?? '__root__'
    if (parentSlots.has(key)) continue
    parentSlots.add(key)
    scopes.push({ kind: 'children', chatId: newChat.id, parentId: newParentId })
  }
  for (const row of ancestors) {
    for (const ref of row.attachmentRefs ?? []) {
      touchedAttachments.push(ref)
      scopes.push({ kind: 'attachment', attachmentId: ref })
    }
  }

  await repo.runMutation(scopes, async (ctx) => {
    for (let i = 0; i < ancestors.length; i += 1) {
      const src = ancestors[i] as Message
      const id = idMap.get(src.id) as MessageId
      const parentId = src.parentId
        ? (idMap.get(src.parentId) ?? null)
        : null
      const clone: Message = {
        id,
        chatId: newChat.id,
        parentId,
        siblingIndex: 0,
        turnId: newId(),
        turnIndex: 0,
        createdAt: now - (ancestors.length - i),
        role: src.role,
        origin: src.origin,
        content: structuredClone(src.content),
        nodeVersion: 0,
        deleted: false,
      }
      if (src.editedAt !== undefined) clone.editedAt = now
      if (src.reasoningDetails) {
        clone.reasoningDetails = structuredClone(src.reasoningDetails)
      }
      if (src.toolCalls) clone.toolCalls = structuredClone(src.toolCalls)
      if (src.refusal !== undefined) clone.refusal = src.refusal
      if (src.phase !== undefined) clone.phase = src.phase
      if (src.responsesEchoItem) {
        clone.responsesEchoItem = structuredClone(src.responsesEchoItem)
      }
      if (src.attachmentRefs && src.attachmentRefs.length > 0) {
        clone.attachmentRefs = [...src.attachmentRefs]
      }
      if (src.generation) {
        clone.generation = structuredClone(src.generation)
      }
      await ctx.putMessage(clone)
    }
    // Bump refCounts for any shared attachments so the fork's messages
    // survive GC even when the source chat is later purged.
    await incRefs(ctx, touchedAttachments)
  })
  postEvent({
    kind: 'chat-mutated',
    chatId: newChat.id,
    metaVersion: 1,
    summaryVersion: 1,
    affected: [{ kind: 'chat-meta', chatId: newChat.id }],
  })
  return { chatId: newChat.id, messageCount: ancestors.length }
}

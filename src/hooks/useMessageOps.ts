// Message-level ops bridge: turn MessageActions callbacks into core
// mutations + send-pipeline calls. Keeps the React surface thin and
// means the ops can be unit-tested by calling these helpers directly.
//
// Three distinct "modify user prompt" semantics, per the user's rule:
//   1. Edit in place — `editInPlace(messageId, text)` mutates `content`
//      on the existing row; NO sibling is created; NO API call.
//   2. Edit & resend — `editAndResend(messageId, text)` inserts a user
//      *sibling* of the original (so both swipe-able), advances the
//      cursor to the new sibling, THEN runs a fresh assistant completion
//      under that new user message. One API call.
//   3. Regenerate — `regenerate(messageId)` creates a fresh assistant
//      sibling under the existing user parent; old assistant stays as a
//      swipe variant. One API call.

import { cursorKeyOf } from '../core/active-path'
import {
  deletePair,
  deleteSingleMessage,
  deleteTurn,
  deleteVariant,
  editMessageContent,
  insertSibling,
} from '../core/messages'
import type {
  AttachmentRef,
  ChatId,
  ConnectionProfile,
  ContentItem,
  Message,
  MessageId,
} from '../core/types'
import { getChat } from '../store/chats'
import {
  type ConnectionRuntimeKeyCandidate,
  resolveConnectionRuntimeKeys,
} from '../store/connection-runtime'
import { bumpPresetLastUsedAt } from '../store/presets'
import { bumpProfileLastUsedAt, getProfile } from '../store/profiles'
import { getWorkspaceRepository } from '../store/workspace-repository'
import type { NavigationIntent } from '../store/zustand/chatStore'
import { useChatStore } from '../store/zustand/chatStore'
import { writeTextInto } from '../ui/chat/InlineEditor'
import type { SendTextResult } from './useChat'
import { continueAssistantInPlace } from './useContinue'

export interface MessageOpsContext {
  chatId: ChatId
  navigationIntent?: NavigationIntent
  // Start a fresh assistant completion stream under an existing message
  // (used by Edit & Send and Regenerate). Supplied by `useChat`.
  sendFrom: (input: {
    chatId: ChatId
    navigationIntent: NavigationIntent
    connection: ConnectionProfile
    apiKey: string
    apiKeyCandidates?: readonly ConnectionRuntimeKeyCandidate[]
    parentMessageId: MessageId
    regenerateTargetMessageId?: MessageId
    prefillContent?: ContentItem[]
  }) => Promise<SendTextResult>
}

export async function editInPlace(
  chatId: ChatId,
  message: Message,
  newText: string,
): Promise<void> {
  const nextContent = writeTextInto(message.content, newText)
  await editMessageContent({
    chatId,
    messageId: message.id,
    content: nextContent,
  })
}

export async function toggleReasoningDetailHidden(
  chatId: ChatId,
  messageId: MessageId,
  detailIndex: number,
): Promise<void> {
  const repo = getWorkspaceRepository()
  await repo.runMutation([{ kind: 'message', messageId }], async (ctx) => {
    const current = await ctx.getMessage(messageId)
    if (!current || current.chatId !== chatId) return
    const details = current.reasoningDetails
    const detail = details?.[detailIndex]
    if (!details || !detail || detail.id?.startsWith('tool_')) return
    const nextDetails = [...details]
    nextDetails[detailIndex] = { ...detail, hidden: !detail.hidden }
    await ctx.putMessage({ ...current, reasoningDetails: nextDetails })
  })
}

export async function toggleProviderOutputItemHidden(
  chatId: ChatId,
  messageId: MessageId,
  itemIndex: number,
): Promise<void> {
  const repo = getWorkspaceRepository()
  await repo.runMutation([{ kind: 'message', messageId }], async (ctx) => {
    const current = await ctx.getMessage(messageId)
    if (!current || current.chatId !== chatId) return
    const items = current.providerOutputItems
    const item = items?.[itemIndex]
    if (!items || !item) return
    const nextItem = { ...item }
    if (nextItem.hidden === true) delete nextItem.hidden
    else nextItem.hidden = true
    const nextItems = [...items]
    nextItems[itemIndex] = nextItem
    await ctx.putMessage({ ...current, providerOutputItems: nextItems })
  })
}

async function resolveActiveConnection(chatId: ChatId): Promise<
  | {
      ok: true
      profile: ConnectionProfile
      apiKey: string
      apiKeyCandidates: readonly ConnectionRuntimeKeyCandidate[]
      presetId?: string
    }
  | { ok: false; reason: string }
> {
  const chat = await getChat(chatId)
  if (!chat) return { ok: false, reason: 'chat-missing' }
  if (!chat.settings.profileId) return { ok: false, reason: 'no-profile' }
  if (!chat.settings.model) return { ok: false, reason: 'no-model' }
  const profile = await getProfile(chat.settings.profileId)
  if (!profile) return { ok: false, reason: 'profile-missing' }
  try {
    const apiKeyCandidates = await resolveConnectionRuntimeKeys(profile, { chatId })
    return {
      ok: true,
      profile,
      apiKey: '',
      apiKeyCandidates,
      ...(chat.presetId ? { presetId: chat.presetId } : {}),
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? `resolveKey: ${err.message}` : 'resolveKey-failed',
    }
  }
}

export async function editAndResend(
  ctx: MessageOpsContext,
  originalUser: Message,
  newText: string,
  options: { prefillContent?: ContentItem[]; attachmentRefs?: AttachmentRef[] } = {},
): Promise<SendTextResult> {
  const navigationIntent =
    ctx.navigationIntent ?? useChatStore.getState().beginNavigationIntent(ctx.chatId)
  const conn = await resolveActiveConnection(ctx.chatId)
  if (!conn.ok) {
    throw new Error(`edit-and-resend: connection unavailable (${conn.reason})`)
  }
  const nextContent: ContentItem[] = [{ type: 'text', text: newText }]
  const inserted = await insertSibling({
    chatId: ctx.chatId,
    targetId: originalUser.id,
    content: nextContent,
    role: originalUser.role,
    origin: 'user',
    ...(options.attachmentRefs ? { attachmentRefs: options.attachmentRefs } : {}),
  })
  const insertedBranch = await getWorkspaceRepository().getBranchHeaderSnapshotByLeaf(
    ctx.chatId,
    inserted.messageId,
  )
  if (insertedBranch.branchHeaders.at(-1)?.id !== inserted.messageId) {
    throw new Error(`edit-and-resend: inserted message unavailable (${inserted.messageId})`)
  }
  const insertedPathSelections = Object.fromEntries(
    insertedBranch.branchHeaders.map((header) => [cursorKeyOf(header.parentId), header.id]),
  )
  useChatStore.getState().selectPathForIntent(
    ctx.chatId,
    navigationIntent,
    insertedPathSelections,
    insertedBranch.branchHeaders.map((header) => header.id),
  )
  const hasPrefill = (options.prefillContent?.length ?? 0) > 0
  const result = await ctx.sendFrom({
    chatId: ctx.chatId,
    navigationIntent,
    connection: conn.profile,
    apiKey: conn.apiKey,
    apiKeyCandidates: conn.apiKeyCandidates,
    parentMessageId: inserted.messageId,
    ...(hasPrefill ? { prefillContent: options.prefillContent } : {}),
  })
  await bumpProfileLastUsedAt(conn.profile.id)
  if (conn.presetId) await bumpPresetLastUsedAt(conn.presetId)
  return result
}

export async function regenerateFromMessage(
  ctx: MessageOpsContext,
  assistantMessage: Message,
): Promise<SendTextResult> {
  const navigationIntent =
    ctx.navigationIntent ?? useChatStore.getState().beginNavigationIntent(ctx.chatId)
  const conn = await resolveActiveConnection(ctx.chatId)
  if (!conn.ok) {
    throw new Error(`regenerate: connection unavailable (${conn.reason})`)
  }
  const assistantHeader = await getWorkspaceRepository().getMessageHeader(assistantMessage.id)
  if (!assistantHeader || assistantHeader.chatId !== ctx.chatId || assistantHeader.deleted) {
    throw new Error(`regenerate: assistant message unavailable (${assistantMessage.id})`)
  }
  if (assistantHeader.parentId === null) {
    throw new Error('regenerate: assistant message has no parent')
  }
  // `sendFrom` creates a new assistant placeholder under the user parent —
  // that IS a new sibling of the existing assistant. The old variant stays
  // swipeable (§8.4.2) and the cursor advances to the new sibling.
  const result = await ctx.sendFrom({
    chatId: ctx.chatId,
    navigationIntent,
    connection: conn.profile,
    apiKey: conn.apiKey,
    apiKeyCandidates: conn.apiKeyCandidates,
    parentMessageId: assistantHeader.parentId,
    regenerateTargetMessageId: assistantHeader.id,
  })
  await bumpProfileLastUsedAt(conn.profile.id)
  if (conn.presetId) await bumpPresetLastUsedAt(conn.presetId)
  return result
}

// Continue in place. Instead of creating a new assistant sibling (which
// requires model-specific prefill semantics that not every model
// supports), the flow is:
//   1. Keep the existing assistant row intact, its generation.model /
//      usage / cost / reasoningDetails are the FACTUAL record of the
//      original turn and must not be mutated.
//   2. Build a one-shot wire body from the active path up to (and
//      including) the target assistant, but with a system prompt that
//      tells the model: "Continue this chat from the last incomplete
//      assistant message. Output only the continuation, nothing else."
//   3. Stream the response. Every chunk APPENDS to the target's
//      `content` text; no new row is created, generation metadata is
//      untouched, and any reasoning is discarded (the continuation
//      call's reasoning is about the instruction, not the original
//      turn, so keeping it would be misleading).
//
// Reasoning discipline: the existing reasoningDetails on the target
// stay untouched (they describe the original partial run). The
// continuation call's reasoning is dropped. If a future phase wants
// reasoning from the continuation, it can be added to the tail of
// reasoningDetails under a new `type: 'reasoning.text'` entry, but
// Phase 8.1 keeps the surface plain.
export async function continueFromMessage(
  ctx: MessageOpsContext,
  assistantMessage: Message,
): Promise<void> {
  const conn = await resolveActiveConnection(ctx.chatId)
  if (!conn.ok) {
    throw new Error(`continue: connection unavailable (${conn.reason})`)
  }
  await continueAssistantInPlace({
    chatId: ctx.chatId,
    targetMessageId: assistantMessage.id,
    connection: conn.profile,
    apiKey: conn.apiKey,
    apiKeyCandidates: conn.apiKeyCandidates,
  })
  await bumpProfileLastUsedAt(conn.profile.id)
  if (conn.presetId) await bumpPresetLastUsedAt(conn.presetId)
}

interface DeleteOpArgs {
  chatId: ChatId
  messageId: MessageId
  cursor: Record<string, string>
  cascade?: boolean
}

export async function deletePairOp(args: DeleteOpArgs) {
  return deletePair({
    chatId: args.chatId,
    messageId: args.messageId,
    cursor: args.cursor,
    ...(args.cascade ? { cascade: true } : {}),
  })
}
export async function deleteTurnOp(args: DeleteOpArgs) {
  return deleteTurn({
    chatId: args.chatId,
    messageId: args.messageId,
    cursor: args.cursor,
    ...(args.cascade ? { cascade: true } : {}),
  })
}
export async function deleteVariantOp(args: DeleteOpArgs) {
  return deleteVariant({
    chatId: args.chatId,
    messageId: args.messageId,
    cursor: args.cursor,
    ...(args.cascade ? { cascade: true } : {}),
  })
}

// Surgical single-message delete: tombstones JUST the target and splices
// its descendants up. Used when the user opts OUT of pair-delete in the
// confirmation dialog, or when the target is flagged with a role-
// adjacency mismatch (the pair-delete "both partners" semantics would
// remove a healthy neighbor). Reuses `core/messages.deleteSingleMessage`
// so the scope-collection logic stays in one place.
export async function deleteSingleOp(args: DeleteOpArgs) {
  return deleteSingleMessage({
    chatId: args.chatId,
    messageId: args.messageId,
    cursor: args.cursor,
    ...(args.cascade ? { cascade: true } : {}),
  })
}

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

import {
  deletePair,
  deleteSingleMessage,
  deleteTurn,
  deleteVariant,
  editMessageContent,
  insertSibling,
} from '../core/messages'
import type {
  ChatId,
  ConnectionProfile,
  ContentItem,
  Message,
  MessageId,
  ReasoningDetail,
} from '../core/types'
import { getBrowserRepository } from '../store/browser-repo'
import { getChat, loadChatMessages } from '../store/chats'
import { resolveKeyIfPresent } from '../store/keys'
import { bumpPresetLastUsedAt } from '../store/presets'
import { bumpProfileLastUsedAt, getProfile } from '../store/profiles'
import { useChatStore } from '../store/zustand/chatStore'
import { writeTextInto } from '../ui/chat/InlineEditor'
import type { SendTextResult } from './useChat'
import { continueAssistantInPlace } from './useContinue'

export interface MessageOpsContext {
  chatId: ChatId
  // Start a fresh assistant completion stream under an existing message
  // (used by Edit & Send and Regenerate). Supplied by `useChat`.
  sendFrom: (input: {
    chatId: ChatId
    connection: ConnectionProfile
    apiKey: string
    parentMessageId: MessageId
  }) => Promise<SendTextResult>
}

export async function editInPlace(
  chatId: ChatId,
  message: Message,
  newText: string,
  reasoning?: ReasoningDetail[],
): Promise<void> {
  const nextContent = writeTextInto(message.content, newText)
  await editMessageContent({
    chatId,
    messageId: message.id,
    content: nextContent,
  })
  // Reasoning edits bypass `editMessageContent` (that helper only
  // touches content). A separate scoped mutation updates
  // reasoningDetails directly — this preserves the "never mutate the
  // generation factual record" rule for cost / usage / model while
  // still letting advanced users curate the reasoning carrier.
  if (reasoning !== undefined) {
    const repo = getBrowserRepository()
    await repo.runMutation([{ kind: 'message', messageId: message.id }], async (ctx) => {
      const current = await ctx.getMessage(message.id)
      if (!current) return
      const next: Message = { ...current }
      if (reasoning.length === 0) {
        delete next.reasoningDetails
      } else {
        next.reasoningDetails = reasoning
      }
      await ctx.putMessage(next)
    })
  }
}

async function resolveActiveConnection(
  chatId: ChatId,
): Promise<
  | { ok: true; profile: ConnectionProfile; apiKey: string; presetId?: string }
  | { ok: false; reason: string }
> {
  const chat = await getChat(chatId)
  if (!chat) return { ok: false, reason: 'chat-missing' }
  if (!chat.settings.profileId) return { ok: false, reason: 'no-profile' }
  if (!chat.settings.model) return { ok: false, reason: 'no-model' }
  const profile = await getProfile(chat.settings.profileId)
  if (!profile) return { ok: false, reason: 'profile-missing' }
  try {
    const apiKey = (await resolveKeyIfPresent(profile.apiKeyRef)) ?? ''
    if (profile.kind !== 'custom' && profile.kind !== 'llama-server' && !apiKey) {
      return { ok: false, reason: 'missing-key' }
    }
    return {
      ok: true,
      profile,
      apiKey,
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
): Promise<SendTextResult> {
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
  })
  const existingCursor = useChatStore.getState().getCursor(ctx.chatId) ?? {}
  useChatStore.getState().setCursor(ctx.chatId, {
    ...existingCursor,
    ...inserted.effects.cursorUpdates,
  })
  const result = await ctx.sendFrom({
    chatId: ctx.chatId,
    connection: conn.profile,
    apiKey: conn.apiKey,
    parentMessageId: inserted.messageId,
  })
  await bumpProfileLastUsedAt(conn.profile.id)
  if (conn.presetId) await bumpPresetLastUsedAt(conn.presetId)
  return result
}

export async function regenerateFromMessage(
  ctx: MessageOpsContext,
  assistantMessage: Message,
): Promise<SendTextResult> {
  const conn = await resolveActiveConnection(ctx.chatId)
  if (!conn.ok) {
    throw new Error(`regenerate: connection unavailable (${conn.reason})`)
  }
  if (assistantMessage.parentId === null) {
    throw new Error('regenerate: assistant message has no parent')
  }
  // `sendFrom` creates a new assistant placeholder under the user parent —
  // that IS a new sibling of the existing assistant. The old variant stays
  // swipeable (§8.4.2) and the cursor advances to the new sibling.
  const result = await ctx.sendFrom({
    chatId: ctx.chatId,
    connection: conn.profile,
    apiKey: conn.apiKey,
    parentMessageId: assistantMessage.parentId,
  })
  await bumpProfileLastUsedAt(conn.profile.id)
  if (conn.presetId) await bumpPresetLastUsedAt(conn.presetId)
  return result
}

// Continue in place. Instead of creating a new assistant sibling (which
// requires model-specific prefill semantics that not every model
// supports), we:
//   1. Keep the existing assistant row intact — its generation.model /
//      usage / cost / reasoningDetails are the FACTUAL record of the
//      original turn and must not be mutated.
//   2. Build a one-shot wire body from the active path up to (and
//      including) the target assistant, but with a system prompt that
//      tells the model: "Continue this chat from the last incomplete
//      assistant message. Output only the continuation, nothing else."
//   3. Stream the response. Every chunk APPENDS to the target's
//      `content` text; we don't create a new row, we don't touch
//      generation metadata, and we discard any reasoning (the
//      continuation call's reasoning is about the instruction, not the
//      original turn, so keeping it would be misleading).
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
  })
  await bumpProfileLastUsedAt(conn.profile.id)
  if (conn.presetId) await bumpPresetLastUsedAt(conn.presetId)
}

export interface DeleteOpArgs {
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

// Collect the turn chain of the message plus its "pair partners" so the
// undo-snapshot knows which rows to restore. Best-effort: callers use the
// result only to stash the rows for a 5s undo toast.
export async function snapshotForDelete(chatId: ChatId, messageId: MessageId): Promise<Message[]> {
  const rows = await loadChatMessages(chatId)
  return rows.filter((row) => row.id === messageId || row.chatId === chatId)
}

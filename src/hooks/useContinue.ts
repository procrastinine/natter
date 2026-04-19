// Continue-in-place pipeline. See `plan/08-branching.md §8.4.8` (the
// "continue partial response" op) but note the 8.1 implementation
// differs from the plan's prefill-based sketch: we keep the existing
// assistant row and append tokens to it, driven by a system-prompt
// instruction to the model. Prefill isn't universally supported and
// even where it is, models reason about the partial + instruction
// differently per family — this approach works for every chat-
// completions model we care about.
//
// The existing assistant's generation metadata (model, usage, cost,
// reasoningDetails, responsesEchoItem) is NEVER touched: those fields
// are factual records of the original turn. The continuation call's
// reasoning is discarded (it describes the meta-instruction, not the
// original turn).

import { activePath, cursorKeyOf } from '../core/active-path'
import { readGlobalPreferences } from '../core/global-settings'
import type { ChatCompletionsTransformOptions } from '../core/transforms'
import { toChatCompletions } from '../core/transforms'
import type {
  ChatId,
  ConnectionProfile,
  ContentItem,
  Message,
  MessageId,
} from '../core/types'
import { chatCompletions } from '../api/chat-completions'
import { ApiError } from '../api/errors'
import { splitChatStream } from '../api/stream-transforms'
import type { ChatStreamChunk } from '../api/types'
import { newId } from '../lib/ulid'
import { getBrowserRepository } from '../store/browser-repo'
import { postEvent } from '../store/broadcast'
import { getChat, loadChatMessages } from '../store/chats'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'

export interface ContinueInPlaceInput {
  chatId: ChatId
  targetMessageId: MessageId
  connection: ConnectionProfile
  apiKey: string
  now?: () => number
  signal?: AbortSignal
  openStream?: (input: {
    connection: ConnectionProfile
    apiKey: string
    wireBody: Record<string, unknown>
    signal: AbortSignal
  }) => AsyncIterable<ChatStreamChunk>
}

export async function continueAssistantInPlace(
  input: ContinueInPlaceInput,
): Promise<void> {
  const now = input.now ?? Date.now
  const repo = getBrowserRepository()
  const chat = await getChat(input.chatId)
  if (!chat) {
    throw new Error(`continue: chat not found: ${input.chatId}`)
  }
  const target = await repo.getMessage(input.targetMessageId)
  if (!target || target.chatId !== input.chatId || target.deleted) {
    throw new Error(
      `continue: target ${input.targetMessageId} unavailable`,
    )
  }
  if (target.role !== 'assistant') {
    throw new Error('continue: target must be an assistant message')
  }

  const baseCursor = useChatStore.getState().getCursor(input.chatId) ?? {}
  // Pin the cursor so the active-path walk ends at our target. Without
  // this, a fresh chat (no cursor) might resolve a different leaf.
  const cursor: Record<string, MessageId> = { ...baseCursor }
  let cur: Message | undefined = target
  while (cur) {
    cursor[cursorKeyOf(cur.parentId)] = cur.id
    cur = cur.parentId
      ? await repo.getMessage(cur.parentId)
      : undefined
  }
  const allMessages = await loadChatMessages(input.chatId)
  const path = activePath(allMessages, cursor)
  // Truncate the path at the target so we don't include downstream
  // descendants that happen to share siblingIndex 0.
  const targetIdx = path.findIndex((m) => m.id === target.id)
  const upstream = targetIdx >= 0 ? path.slice(0, targetIdx + 1) : path

  // Build the wire body as if we were sending a request that ends with
  // the target assistant. The transform keeps the target's partial
  // text as the tail assistant message. We then override the system
  // prompt with the continuation instruction; the original prompt is
  // appended underneath so the model retains the chat's character
  // while following the continue directive.
  //
  // The continue prompt is a global setting (editable in GeneralSettings
  // → Continue) so the user can tune the wording per model — some
  // prefer "continue writing", others respond better to "resume".
  const globalPrefs = await readGlobalPreferences()
  const continueInstruction =
    globalPrefs.continuePrompt.trim() ||
    'Continue the chat from the last assistant message. Output only the continuation.'
  const baseSystem = chat.settings.systemPrompt?.trim() ?? ''
  const continueSystem = baseSystem
    ? `${continueInstruction}\n\nOriginal system prompt follows:\n${baseSystem}`
    : continueInstruction
  const settingsForContinue = {
    ...chat.settings,
    systemPrompt: continueSystem,
  }

  const transformOpts: ChatCompletionsTransformOptions = {
    stream: true,
  }
  const { wire, requestedModel } = toChatCompletions(
    settingsForContinue,
    upstream,
    transformOpts,
  )
  void requestedModel

  const streamId = newId()
  const abortController = new AbortController()
  const userSignal = input.signal
  if (userSignal?.aborted) abortController.abort(userSignal.reason)
  else
    userSignal?.addEventListener(
      'abort',
      () => abortController.abort(userSignal.reason),
      { once: true },
    )

  useStreamStore.getState().setActive({
    streamId,
    chatId: input.chatId,
    messageId: target.id,
    startedAt: now(),
    ownerClientId: 'in-tab',
    textLen: existingTextOf(target).length,
  })
  postEvent({
    kind: 'stream-started',
    chatId: input.chatId,
    streamId,
    messageId: target.id,
    ownerClientId: 'in-tab',
  })

  let buffer = ''
  const baseText = existingTextOf(target)
  const openStream =
    input.openStream ??
    ((open) =>
      chatCompletions(
        { profile: open.connection, apiKey: open.apiKey },
        open.wireBody as Parameters<typeof chatCompletions>[1],
        { signal: open.signal },
      ))

  let lastFlushedAt = now()
  let lastFlushedLen = 0

  const flush = async (final: boolean) => {
    const combined = baseText + buffer
    await repo.runMutation(
      [{ kind: 'message', messageId: target.id }],
      async (ctx) => {
        const current = await ctx.getMessage(target.id)
        if (!current) return
        const nextContent: ContentItem[] = appendTextOnto(
          current.content,
          // The delta-since-last-flush is what we haven't written yet;
          // but `current.content` already has everything from prior
          // flushes, so compute the tail from buffer and merge.
          combined,
        )
        await ctx.putMessage({ ...current, content: nextContent })
      },
    )
    lastFlushedAt = now()
    lastFlushedLen = buffer.length
    useStreamStore
      .getState()
      .updateTextLen(streamId, combined.length)
    postEvent({
      kind: 'stream-tokens',
      chatId: input.chatId,
      streamId,
      messageId: target.id,
      textLen: combined.length,
    })
    void final
  }

  try {
    const chunkIter = openStream({
      connection: input.connection,
      apiKey: input.apiKey,
      wireBody: wire as Record<string, unknown>,
      signal: abortController.signal,
    })
    for await (const event of splitChatStream(chunkIter)) {
      if (event.lane === 'text') {
        buffer += event.text
      } else if (event.lane === 'error') {
        break
      }
      // Flush every ~200ms or 4KB of growth.
      if (
        now() - lastFlushedAt >= 200 ||
        buffer.length - lastFlushedLen >= 4096
      ) {
        await flush(false)
      }
    }
    await flush(true)
  } catch (err) {
    if (abortController.signal.aborted) {
      await flush(true)
    } else if (err instanceof ApiError) {
      await flush(true)
    } else {
      await flush(true)
      throw err
    }
  } finally {
    useStreamStore.getState().clearActive(streamId)
    postEvent({
      kind: 'stream-ended',
      chatId: input.chatId,
      streamId,
      messageId: target.id,
      outcome: 'done',
    })
  }
}

function existingTextOf(message: Message): string {
  let out = ''
  for (const item of message.content) {
    if (item.type === 'text' || item.type === 'output_text') out += item.text
  }
  return out
}

function appendTextOnto(
  content: readonly ContentItem[],
  fullText: string,
): ContentItem[] {
  // Rewrite the first text/output_text item with the full combined
  // text, drop any subsequent plain text items that were part of the
  // prior partial (they get merged into the first), keep non-text
  // items. The simplest reliable form: return a single output_text
  // entry with the full combined text plus any non-text items we had.
  const nonText: ContentItem[] = content.filter(
    (item) => item.type !== 'text' && item.type !== 'output_text',
  )
  return [{ type: 'output_text', text: fullText }, ...nonText]
}

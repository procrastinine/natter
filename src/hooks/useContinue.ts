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

import {
  openAssistantRequestStream,
  type AssistantStreamChunk,
} from '../api/assistant-stream'
import { ApiError } from '../api/errors'
import {
  splitChatStream,
  splitGeminiStream,
  splitResponsesStream,
  type StreamLaneEvent,
} from '../api/stream-transforms'
import type { GeminiStreamChunk } from '../api/gemini-types'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../api/types'
import { activePath, cursorKeyOf } from '../core/active-path'
import {
  readGlobalPreferences,
  resolveContinueSystemPromptTemplate,
} from '../core/global-settings'
// `globalPrefs` is still read for token-calibration mode; continue prompts
// moved to `chat.settings` in the prompt-preset refactor.
import {
  calibrationFieldsForEdit,
  readTokenCalibrationGlobal,
} from '../core/token-calibration'
import {
  type AssistantRequestPlan,
  NoEligibleProvidersError,
  prepareAssistantRequestPlan,
} from '../core/send-planning'
import type { ChatId, ConnectionProfile, ContentItem, Message, MessageId } from '../core/types'
import { newId } from '../lib/ulid'
import { postEvent } from '../store/broadcast'
import { getBrowserRepository } from '../store/browser-repo'
import { dismissAbortReason, getChat, loadChatMessages } from '../store/chats'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useUiStore } from '../store/zustand/uiStore'
import { markLifecycleTarget, startRequestLifecycle } from './requestLifecycle'

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
    route?: AssistantRequestPlan['route']
    geminiModelId?: string
  }) => AsyncIterable<AssistantStreamChunk>
}

function throwWithZeroEligibleUi(chatId: ChatId, err: unknown): never {
  if (err instanceof NoEligibleProvidersError) {
    useUiStore.getState().setZeroEligibleChatId(chatId)
  }
  throw err
}

function devOnlyOpenStreamOverride(
  openStream: ContinueInPlaceInput['openStream'],
): ContinueInPlaceInput['openStream'] {
  if (!openStream) return undefined
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV !== true) {
    throw new Error('openStream override is dev-only; production sends must use assistant-stream')
  }
  return openStream
}

async function* laneStreamForRoute(
  route: AssistantRequestPlan['route'],
  source: AsyncIterable<AssistantStreamChunk>,
): AsyncGenerator<StreamLaneEvent> {
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) return
  const replay = {
    async *[Symbol.asyncIterator]() {
      yield first.value
      for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) yield chunk
    },
  }
  const kind = (first.value as { type?: string }).type
  if (kind === 'event') {
    yield* splitResponsesStream(replay as AsyncIterable<ResponsesStreamChunk>)
    return
  }
  if (kind === 'chunk') {
    yield* splitGeminiStream(replay as AsyncIterable<GeminiStreamChunk>)
    return
  }
  if (kind === 'delta') {
    yield* splitChatStream(replay as AsyncIterable<ChatStreamChunk>)
    return
  }
  if (route?.transport === 'openai-responses') {
    yield* splitResponsesStream(replay as AsyncIterable<ResponsesStreamChunk>)
    return
  }
  if (route?.transport === 'gemini-native') {
    yield* splitGeminiStream(replay as AsyncIterable<GeminiStreamChunk>)
    return
  }
  yield* splitChatStream(replay as AsyncIterable<ChatStreamChunk>)
}

export async function continueAssistantInPlace(input: ContinueInPlaceInput): Promise<void> {
  const now = input.now ?? Date.now
  const repo = getBrowserRepository()
  const chat = await getChat(input.chatId)
  if (!chat) {
    throw new Error(`continue: chat not found: ${input.chatId}`)
  }
  const target = await repo.getMessage(input.targetMessageId)
  if (!target || target.chatId !== input.chatId || target.deleted) {
    throw new Error(`continue: target ${input.targetMessageId} unavailable`)
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
    cur = cur.parentId ? await repo.getMessage(cur.parentId) : undefined
  }
  const allMessages = await loadChatMessages(input.chatId)
  const path = activePath(allMessages, cursor)
  // Truncate the path at the target so we don't include downstream
  // descendants that happen to share siblingIndex 0.
  const targetIdx = path.findIndex((m) => m.id === target.id)
  const upstream = targetIdx >= 0 ? path.slice(0, targetIdx + 1) : path

  // Build the wire body as if we were sending a request that ends with
  // the target assistant. Continue has two independent per-chat prompt slots
  // (stored on chat.settings, preset-pinnable): a system override (which
  // replaces the chat system prompt when non-empty) and a synthetic trailing
  // user prompt (which avoids the double-assistant shape when non-empty).
  // Either can be blank.
  const [globalPrefs, globalCalibration] = await Promise.all([
    readGlobalPreferences(),
    readTokenCalibrationGlobal(),
  ])
  const continueSystemPrompt = chat.settings.continueSystemPrompt
  const continueUserPrompt = chat.settings.continueUserPrompt
  const originalSystemPrompt = chat.settings.systemPrompt
  const settingsForContinue = {
    ...chat.settings,
    systemPrompt: resolveContinueSystemPromptTemplate(
      continueSystemPrompt,
      originalSystemPrompt,
    ),
  }
  const continuePath =
    continueUserPrompt.trim().length > 0
      ? [
          ...upstream,
          {
            id: `continue-user:${target.id}`,
            chatId: input.chatId,
            parentId: target.id,
            siblingIndex: 0,
            turnId: `continue-user:${target.turnId}`,
            turnIndex: 0,
            createdAt: target.createdAt,
            role: 'user' as const,
            origin: 'user' as const,
            content: [{ type: 'text' as const, text: continueUserPrompt }],
            nodeVersion: 0,
            deleted: false,
          },
        ]
      : upstream
  const lifecycle = startRequestLifecycle({
    chatId: input.chatId,
    streamId: newId(),
    ...(input.signal ? { userSignal: input.signal } : {}),
  })

  let outcome: 'done' | 'error' | 'abort' = 'done'
  let abortController: AbortController | null = null
  let flush: (final: boolean) => Promise<void> = async () => {}
  try {
    const requestPlan = await prepareAssistantRequestPlan({
      chat,
      connection: input.connection,
      pathMessages: continuePath,
      settings: settingsForContinue,
      draftText: '',
      debugSource: 'continue',
      signal: lifecycle.signal,
    })
      .then((prepared) => prepared.requestPlan)
      .catch((err) => throwWithZeroEligibleUi(input.chatId, err))
    const { route, geminiModelId, wire } = requestPlan

    const streamId = lifecycle.streamId
    const controller = new AbortController()
    abortController = controller
    const abortStream = () => controller.abort()
    const userSignal = lifecycle.signal
    if (userSignal.aborted) controller.abort(userSignal.reason)
    else
      userSignal.addEventListener('abort', () => controller.abort(userSignal.reason), {
        once: true,
      })

    markLifecycleTarget({
      chatId: input.chatId,
      streamId,
      messageId: target.id,
      abort: abortStream,
    })

    let buffer = ''
    const baseText = existingTextOf(target)
    const openStream =
      devOnlyOpenStreamOverride(input.openStream) ??
      ((open) =>
        openAssistantRequestStream({
          connection: open.connection,
          apiKey: open.apiKey,
          requestPlan,
          signal: open.signal,
        }))

    let lastFlushedAt = now()
    let lastFlushedLen = 0

    flush = async (final: boolean) => {
      const combined = baseText + buffer
      await repo.runMutation([{ kind: 'message', messageId: target.id }], async (ctx) => {
        const current = await ctx.getMessage(target.id)
        if (!current) return
        const nextContent: ContentItem[] = appendTextOnto(
          current.content,
          // The delta-since-last-flush is what we haven't written yet;
          // but `current.content` already has everything from prior
          // flushes, so compute the tail from buffer and merge.
          combined,
        )
        const calibrationPatch = chat.settings.model
          ? calibrationFieldsForEdit(
              nextContent,
              current.originalCharCount,
              current.originalModelId,
              current.originalCalibrationKey,
              chat.settings.model,
              chat,
              globalCalibration,
              globalPrefs.tokenCalibrationMode,
            )
          : null
        await ctx.putMessage(
          { ...current, content: nextContent, ...(calibrationPatch ?? {}) },
          final ? undefined : { touchChatSummary: false, broadcast: false },
        )
      })
      lastFlushedAt = now()
      lastFlushedLen = buffer.length
    }

    const chunkIter = openStream({
      connection: input.connection,
      apiKey: input.apiKey,
      wireBody: wire as Record<string, unknown>,
      signal: abortController.signal,
      ...(route ? { route } : {}),
      ...(geminiModelId ? { geminiModelId } : {}),
    })
    for await (const event of laneStreamForRoute(route, chunkIter)) {
      if (event.lane === 'text') {
        buffer += event.text
      } else if (event.lane === 'error') {
        outcome = 'error'
        break
      }
      // Flush every ~200ms or 4KB of growth.
      if (now() - lastFlushedAt >= 200 || buffer.length - lastFlushedLen >= 4096) {
        await flush(false)
      }
    }
    await flush(true)
    // Continue succeeded — clear the previous abort banner since the
    // response is now whole. The original generation metadata (usage /
    // model / reasoning) is preserved by flush(); only the abortReason
    // and error flags go.
    if (outcome === 'done') {
      await dismissAbortReason(target.id)
    }
  } catch (err) {
    if (abortController?.signal.aborted || lifecycle.signal.aborted) {
      outcome = 'abort'
      await flush(true)
    } else if (err instanceof ApiError) {
      outcome = 'error'
      await flush(true)
    } else {
      outcome = 'error'
      await flush(true)
      throw err
    }
  } finally {
    useStreamStore.getState().clearActive(lifecycle.streamId)
    postEvent({
      kind: 'stream-ended',
      chatId: input.chatId,
      streamId: lifecycle.streamId,
      messageId: target.id,
      outcome,
    })
    lifecycle.end(outcome)
  }
}

function existingTextOf(message: Message): string {
  let out = ''
  for (const item of message.content) {
    if (item.type === 'text' || item.type === 'output_text') out += item.text
  }
  return out
}

function appendTextOnto(content: readonly ContentItem[], fullText: string): ContentItem[] {
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

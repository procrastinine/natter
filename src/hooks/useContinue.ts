// Continue-in-place pipeline. See `plan/08-branching.md §8.4.8` (the
// "continue partial response" op) but note the 8.1 implementation
// supports two request strategies. Default continue keeps the existing
// assistant row and appends tokens to it, driven by a system-prompt
// instruction to the model. Continue-prefill instead sends the existing
// assistant row as the final assistant prefix on the wire, still appending
// the returned continuation into that same stored row.
//
// The existing assistant's generation metadata (model, usage, cost,
// reasoningDetails, responsesEchoItem) is NEVER touched: those fields
// are factual records of the original turn. The continuation call's
// reasoning is discarded (it describes the meta-instruction, not the
// original turn).

import type { AnthropicStreamChunk } from '../api/anthropic-types'
import { type AssistantStreamChunk, openAssistantRequestStream } from '../api/assistant-stream'
import { ApiError } from '../api/errors'
import type { GeminiStreamChunk } from '../api/gemini-types'
import {
  type StreamLaneEvent,
  splitAnthropicStream,
  splitChatStream,
  splitGeminiStream,
  splitResponsesStream,
} from '../api/stream-transforms'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../api/types'
import { activePath, cursorKeyOf } from '../core/active-path'
import { readGlobalPreferences, resolveContinueSystemPromptTemplate } from '../core/global-settings'
import { prefillClassFor } from '../core/quirks'
import {
  type AssistantRequestPlan,
  NoEligibleProvidersError,
  prepareAssistantRequestPlan,
} from '../core/send-planning'
// `globalPrefs` is still read for token-calibration mode; continue prompts
// moved to `chat.settings` in the prompt-preset refactor.
import { calibrationFieldsForEdit, readTokenCalibrationGlobal } from '../core/token-calibration'
import type { ChatId, ConnectionProfile, ContentItem, Message, MessageId } from '../core/types'
import { newId } from '../lib/ulid'
import { postEvent } from '../store/broadcast'
import { getBrowserRepository } from '../store/browser-repo'
import { dismissAbortReason, getChat, loadMessageHeaders } from '../store/chats'
import { loadSendContextForBranch } from '../store/send-context'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useUiStore } from '../store/zustand/uiStore'
import { markLifecycleTarget, startRequestLifecycle } from './requestLifecycle'

const CONTINUE_LIVE_UPDATE_INTERVAL_MS = 125
const CONTINUE_LIVE_TEXT_GROWTH_CHARS = 2048

interface ContinueInPlaceInput {
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
  if (kind === 'anthropic_event') {
    yield* splitAnthropicStream(replay as AsyncIterable<AnthropicStreamChunk>)
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
  if (route?.transport === 'anthropic') {
    yield* splitAnthropicStream(replay as AsyncIterable<AnthropicStreamChunk>)
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
  const allHeaders = await loadMessageHeaders(input.chatId)
  const byId = new Map(allHeaders.map((header) => [header.id, header]))
  const targetHeader = byId.get(input.targetMessageId)
  if (!targetHeader || targetHeader.chatId !== input.chatId || targetHeader.deleted) {
    throw new Error(`continue: target ${input.targetMessageId} unavailable`)
  }
  if (targetHeader.role !== 'assistant') {
    throw new Error('continue: target must be an assistant message')
  }
  const target = await repo.getMessage(input.targetMessageId)
  if (!target || target.chatId !== input.chatId || target.deleted) {
    throw new Error(`continue: target ${input.targetMessageId} unavailable`)
  }

  const baseCursor = useChatStore.getState().getCursor(input.chatId) ?? {}
  // Pin the cursor so the active-path walk ends at the target. Without
  // this, a fresh chat (no cursor) might resolve a different leaf.
  const cursor: Record<string, MessageId> = { ...baseCursor }
  let cur: (typeof allHeaders)[number] | undefined = targetHeader
  while (cur) {
    cursor[cursorKeyOf(cur.parentId)] = cur.id
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  const path = activePath(allHeaders as unknown as Message[], cursor).map(
    (message) => message as unknown as (typeof allHeaders)[number],
  )
  // Truncate the path at the target so downstream descendants that
  // happen to share siblingIndex 0 are excluded.
  const targetIdx = path.findIndex((m) => m.id === target.id)
  const upstream = targetIdx >= 0 ? path.slice(0, targetIdx + 1) : path

  // Build the wire body as if sending a request that ends with
  // the target assistant. Continue has two independent per-chat prompt slots
  // (stored on chat.settings, preset-pinnable): a system override (which
  // replaces the chat system prompt when non-empty) and a synthetic trailing
  // user prompt (which avoids the double-assistant shape when non-empty).
  // Either can be blank.
  const [globalPrefs, globalCalibration] = await Promise.all([
    readGlobalPreferences(),
    readTokenCalibrationGlobal(),
  ])
  // Two continue strategies:
  //
  //   continuePrefill = true → real prefill turn. Don't override the system
  //     prompt; don't append a synthetic continue-user turn. Just walk the
  //     active path up through the target and mark the target as
  //     `origin: 'prefill'` so the wire transform applies the trailing-
  //     whitespace trim and treats the assistant content as the prefix the
  //     model continues from. Hidden continue prompts (continueSystemPrompt /
  //     continueUserPrompt) are unused.
  //
  //   continuePrefill = false → legacy continue-prompt mode (kept for
  //     compat / models where prefill is unsupported). System prompt is
  //     swapped for the continue-system template; the synthetic
  //     continue-user trailing turn (if non-empty) avoids the double-
  //     assistant shape.
  const usePrefillContinue =
    chat.settings.continuePrefill === true && prefillClassFor(chat.settings.model) !== 'unsupported'
  const continueSystemPrompt = chat.settings.continueSystemPrompt
  const continueUserPrompt = chat.settings.continueUserPrompt
  const originalSystemPrompt = chat.settings.systemPrompt
  const settingsForContinue = usePrefillContinue
    ? chat.settings
    : {
        ...chat.settings,
        systemPrompt: resolveContinueSystemPromptTemplate(
          continueSystemPrompt,
          originalSystemPrompt,
        ),
      }
  let continuePath: Message[]
  let pendingMessages: Message[]
  let preCutAttachmentIds: string[]
  const mapHydratedMessage = usePrefillContinue
    ? (message: Message): Message =>
        message.id === target.id ? { ...message, origin: 'prefill' } : message
    : undefined
  if (usePrefillContinue) {
    const sendContext = await loadSendContextForBranch({
      chat,
      branchHeaders: upstream,
      settings: settingsForContinue,
      ...(mapHydratedMessage ? { mapHydratedMessage } : {}),
    })
    continuePath = sendContext.pathMessages
    preCutAttachmentIds = sendContext.preCutAttachmentIds
  } else {
    pendingMessages =
      continueUserPrompt.trim().length > 0
        ? [
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
        : []
    const sendContext = await loadSendContextForBranch({
      chat,
      branchHeaders: upstream,
      settings: settingsForContinue,
      pendingMessages,
    })
    continuePath = sendContext.pathMessages
    preCutAttachmentIds = sendContext.preCutAttachmentIds
  }
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
      preCutAttachmentIds,
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

    const baseText = existingTextOf(target)
    let buffer = ''
    const openStream =
      devOnlyOpenStreamOverride(input.openStream) ??
      ((open) =>
        openAssistantRequestStream({
          connection: open.connection,
          apiKey: open.apiKey,
          requestPlan,
          signal: open.signal,
        }))

    let lastPublishedAt = now()
    let lastPublishedLen = 0

    const publishLiveSnapshot = (publishedAt: number) => {
      const combined = baseText + buffer
      useStreamStore.getState().setLiveSnapshot({
        streamId,
        chatId: input.chatId,
        messageId: target.id,
        content: appendTextOnto(target.content, combined),
        textLength: combined.length,
        reasoningLength: 0,
        updatedAt: publishedAt,
      })
      lastPublishedAt = publishedAt
      lastPublishedLen = buffer.length
    }

    flush = async (final: boolean) => {
      const combined = baseText + buffer
      await repo.runMutation([{ kind: 'message', messageId: target.id }], async (ctx) => {
        const current = await ctx.getMessage(target.id)
        if (!current) return
        const nextContent: ContentItem[] = appendTextOnto(
          current.content,
          // The delta-since-last-flush is what hasn't been written yet;
          // but `current.content` already has everything from prior
          // flushes, so compute the tail from buffer and merge.
          combined,
        )
        const calibrationPatch =
          chat.settings.model && !requestPlan.hasAttachmentContext
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
        if (final) {
          await ctx.putMessage({ ...current, content: nextContent, ...(calibrationPatch ?? {}) })
        } else {
          await ctx.patchMessageBody(
            target.id,
            { content: nextContent },
            {
              touchChatSummary: false,
              broadcast: false,
              ...(calibrationPatch ? { headerPatch: calibrationPatch } : {}),
            },
          )
        }
      })
      if (final) publishLiveSnapshot(now())
    }

    const chunkIter = openStream({
      connection: input.connection,
      apiKey: input.apiKey,
      wireBody: wire,
      signal: abortController.signal,
      ...(route ? { route } : {}),
      ...(geminiModelId ? { geminiModelId } : {}),
    })
    for await (const event of laneStreamForRoute(route, chunkIter)) {
      const eventNow = now()
      if (event.lane === 'text') {
        buffer += event.text
      } else if (event.lane === 'error') {
        outcome = 'error'
        break
      }
      if (
        eventNow - lastPublishedAt >= CONTINUE_LIVE_UPDATE_INTERVAL_MS ||
        buffer.length - lastPublishedLen >= CONTINUE_LIVE_TEXT_GROWTH_CHARS
      ) {
        publishLiveSnapshot(eventNow)
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
    useStreamStore.getState().clearLiveSnapshot(target.id)
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
  // entry with the full combined text plus any non-text items present.
  const nonText: ContentItem[] = content.filter(
    (item) => item.type !== 'text' && item.type !== 'output_text',
  )
  return [{ type: 'output_text', text: fullText }, ...nonText]
}

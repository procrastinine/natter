// Send pipeline for basic text chat. See `plan/06-streaming.md §6.1` and
// `plan/13-delivery.md §13.2.7`.
//
// Lifecycle (text-only Phase 7):
//   1. Persist the user message (via messages.sendUserMessage) and an assistant
//      placeholder (via continueAssistant-style append under the user) — both
//      rows are durable BEFORE the fetch opens (`plan/13 §13.2.2 first-token-latency`).
//   2. Compose the wire body from the active path via `send-planning`.
//   3. Open the stream through the single assistant dispatcher. Feed chunks
//      through `splitChatStream` into an
//      in-memory accumulator (text / reasoning / tool-calls / usage / meta).
//   4. Append stream-lane deltas to the durable `streamChunks` recovery log
//      while the visible owner tab renders from the in-memory accumulator.
//      The canonical `messageBodies` row is not rewritten on the hot path.
//   5. On stream end, write the final commit (content, reasoningDetails,
//      generation.usage/cost/finishReason/finishedAt). On error, attach
//      ApiError metadata. On user abort, attach abortReason='user'.
//
// The send function is written as a plain async function that lives outside
// React so integration tests can drive it without mounting a component. The
// `useChat` hook is a thin React wrapper that binds `streamStore` / `uiStore`
// callbacks; components call `sendText({chat, connection, ...})`.

import { useCallback, useRef } from 'react'
import { type AssistantStreamChunk, openAssistantRequestStream } from '../api/assistant-stream'
import { ApiError } from '../api/errors'
import type { AnthropicStreamChunk } from '../api/anthropic-types'
import type { GeminiStreamChunk } from '../api/gemini-types'
import {
  splitAnthropicStream,
  type StreamLaneEvent,
  splitChatStream,
  splitGeminiStream,
  splitResponsesStream,
} from '../api/stream-transforms'
import type { ChatStreamChunk, ResponsesStreamChunk } from '../api/types'
import { cursorKeyOf, groupByParent } from '../core/active-path'
import { readGlobalPreferences } from '../core/global-settings'
import { sendUserMessage } from '../core/messages'
import {
  findMergeTargetIndex,
  mergeReasoningDetail,
  normalizeIncomingReasoningDetail,
} from '../core/reasoning'
import {
  providerOutputItemFromResponsesItem,
  providerOutputItemFromGeminiPart,
} from '../core/provider-tool-context'
import {
  type AssistantRequestPlan,
  NoEligibleProvidersError,
  prepareAssistantRequestPlan,
} from '../core/send-planning'
import {
  addSampleToChat,
  addSampleToGlobal,
  calibrationFieldsForCreate,
  deriveCompletionSample,
  derivePromptSample,
  readTokenCalibrationGlobal,
} from '../core/token-calibration'
import type { PromptEstimateOptions } from '../core/tokens'
import type { ChatCompletionsTransformOptions } from '../core/transforms'
import { nextSiblingIndex } from '../core/tree-ops'
import type {
  AbortReason,
  AttachmentRef,
  CapabilityDescriptor,
  ChatId,
  ChatUsage,
  ConnectionProfile,
  ContentItem,
  FinishReason,
  GenerationMeta,
  GenerationServerToolCall,
  Message,
  MessageId,
  MessagePhase,
  ProviderOutputItem,
  ReasoningDetail,
} from '../core/types'
import { logStreamDebug, streamDebugEnabled } from '../lib/debug-streams'
import { newId } from '../lib/ulid'
import { attachmentScopes, incRefs } from '../store/attachments'
import { postEvent } from '../store/broadcast'
import { getBrowserRepository } from '../store/browser-repo'
import { getChat, loadActiveBranchSnapshot } from '../store/chats'
import {
  type GeneratedOutputDownloader,
  materializeGeneratedOutputAttachments,
  mergeGeneratedImageAttachmentRefs,
} from '../store/generated-images'
import type { MessageHeaderPatch, StreamChunkRow } from '../store/repository'
import { isFreshStreamLease, STREAM_LEASE_TTL_MS } from '../store/stream-leases'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'
import { useUiStore } from '../store/zustand/uiStore'
import { markLifecycleTarget, startRequestLifecycle } from './requestLifecycle'

const STREAM_LIVE_UPDATE_INTERVAL_MS = 125
const STREAM_LIVE_TEXT_GROWTH_CHARS = 2048
const STREAM_CHUNK_FLUSH_INTERVAL_MS = 150
const STREAM_CHUNK_FLUSH_MAX_ROWS = 256
const STREAM_CHUNK_FLUSH_MAX_TEXT_CHARS = 128 * 1024

function routeApiUsed(route: AssistantRequestPlan['route']): GenerationMeta['apiUsed'] {
  if (route?.kind === 'responses') return 'responses'
  if (route?.kind === 'gemini-generate') return 'gemini-native'
  if (route?.kind === 'anthropic-messages') return 'anthropic-messages'
  if (route?.kind === 'video-generation') return 'video-generation'
  if (route?.kind === 'text-completions') return 'completion'
  return 'chat'
}

function pendingUserMessage(input: {
  chatId: ChatId
  parentId: MessageId | null
  siblingIndex: number
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  createdAt: number
  messageId: MessageId
  turnId: string
}): Message {
  return {
    id: input.messageId,
    chatId: input.chatId,
    parentId: input.parentId,
    siblingIndex: input.siblingIndex,
    turnId: input.turnId,
    turnIndex: 0,
    createdAt: input.createdAt,
    role: 'user',
    origin: 'user',
    content: input.content,
    ...(input.attachmentRefs && input.attachmentRefs.length > 0
      ? { attachmentRefs: structuredClone(input.attachmentRefs) }
      : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

function pendingPrefillMessage(input: {
  chatId: ChatId
  parentId: MessageId | null
  siblingIndex: number
  content: ContentItem[]
  createdAt: number
  messageId: MessageId
  turnId: string
}): Message {
  return {
    id: input.messageId,
    chatId: input.chatId,
    parentId: input.parentId,
    siblingIndex: input.siblingIndex,
    turnId: input.turnId,
    turnIndex: 1,
    createdAt: input.createdAt,
    role: 'assistant',
    origin: 'prefill',
    content: input.content,
    nodeVersion: 0,
    deleted: false,
  }
}

function throwWithZeroEligibleUi(chatId: ChatId, err: unknown): never {
  if (err instanceof NoEligibleProvidersError) {
    useUiStore.getState().setZeroEligibleChatId(chatId)
  }
  throw err
}

async function* laneStreamForRoute(
  route: AssistantRequestPlan['route'],
  source: AsyncIterable<OpenStreamChunk>,
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

  const transport = detectStreamTransport(first.value, route)
  if (transport === 'openai-responses') {
    yield* splitResponsesStream(replay as AsyncIterable<ResponsesStreamChunk>)
    return
  }
  if (transport === 'gemini-native') {
    yield* splitGeminiStream(replay as AsyncIterable<GeminiStreamChunk>)
    return
  }
  if (transport === 'anthropic') {
    yield* splitAnthropicStream(replay as AsyncIterable<AnthropicStreamChunk>)
    return
  }
  yield* splitChatStream(replay as AsyncIterable<ChatStreamChunk>)
}

function detectStreamTransport(
  chunk: OpenStreamChunk,
  route: AssistantRequestPlan['route'],
): NonNullable<AssistantRequestPlan['route']>['transport'] | 'openai-chat' {
  if ((chunk as { type?: string }).type === 'event') return 'openai-responses'
  if ((chunk as { type?: string }).type === 'chunk') return 'gemini-native'
  if ((chunk as { type?: string }).type === 'anthropic_event') return 'anthropic'
  if ((chunk as { type?: string }).type === 'delta') return 'openai-chat'
  if ((chunk as { type?: string }).type === 'buffered_result') {
    const result = (chunk as { result?: Record<string, unknown> }).result
    if (result) {
      if (Array.isArray((result as { content?: unknown[] }).content) && 'stop_reason' in result) {
        return 'anthropic'
      }
      if (Array.isArray((result as { output?: unknown[] }).output) || 'status' in result) {
        return 'openai-responses'
      }
      if (Array.isArray((result as { candidates?: unknown[] }).candidates)) {
        return 'gemini-native'
      }
      if (Array.isArray((result as { choices?: unknown[] }).choices)) return 'openai-chat'
    }
  }
  if (route?.transport === 'openai-responses') return 'openai-responses'
  if (route?.transport === 'gemini-native') return 'gemini-native'
  if (route?.transport === 'anthropic') return 'anthropic'
  return 'openai-chat'
}

// Per-stream mutable state. Mirrors the §6.2 `ActiveStream` fields that apply
// at the Phase 7 scope. Reasoning / tool-call reducers are in place so later
// phases can extend without changing the lifecycle.
interface ChatAccumulator {
  initialContent: ContentItem[]
  textChunks: string[]
  textLength: number
  textSnapshot: string
  // Ordered list of reasoning details accumulated so far. Streaming deltas
  // from Responses / Gemini-native lanes carry a stable synthetic id when
  // possible, so incremental text/summary/encrypted fragments and buffered
  // fallbacks all converge on the same row. Legacy chat-completions
  // `reasoning_details[]` entries still go through `findMergeTargetIndex`.
  reasoningList: ReasoningDetail[]
  reasoningRowById: Map<string, number>
  generationId?: string
  model?: string
  provider?: string
  phase?: MessagePhase
  finishReason?: string
  usage?: ChatUsage
  generatedContent: ContentItem[]
  audioOutput?: {
    chunks: string[]
    transcript: string
    format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'pcm16'
  }
  serverTools: GenerationServerToolCall[]
  providerOutputItems: ProviderOutputItem[]
  firstTextAt?: number
  reasoningStartedAt?: number
  reasoningFinishedAt?: number
  dirtySinceLastLivePublish: boolean
  lastLivePublishedAt: number
  lastLivePublishedTextLen: number
  lastLivePublishedReasoningLen: number
  streamChunkBuffer: StreamChunkRow[]
  nextStreamChunkSeq: number
  pendingStreamChunkFlush?: Promise<void>
  streamChunkFlushTimer?: ReturnType<typeof setTimeout>
  lastStreamChunkFlushAt: number
  bufferedStreamChunkTextLen: number
  persistedStreamGenerationId?: string
  persistedStreamModel?: string
  persistedStreamProvider?: string
  lastChunkReceivedAt: number
  midStreamError?: ApiError
  debugScope?: string
}

function createAccumulator(input: {
  initialContent: ContentItem[]
  now: number
  debugScope?: string
}): ChatAccumulator {
  return {
    initialContent: input.initialContent,
    textChunks: [],
    textLength: 0,
    textSnapshot: '',
    reasoningList: [],
    reasoningRowById: new Map(),
    generatedContent: [],
    serverTools: [],
    providerOutputItems: [],
    dirtySinceLastLivePublish: false,
    lastLivePublishedAt: input.now,
    lastLivePublishedTextLen: 0,
    lastLivePublishedReasoningLen: 0,
    streamChunkBuffer: [],
    nextStreamChunkSeq: 0,
    lastStreamChunkFlushAt: input.now,
    bufferedStreamChunkTextLen: 0,
    lastChunkReceivedAt: input.now,
    ...(input.debugScope ? { debugScope: input.debugScope } : {}),
  }
}

interface SendTextInput {
  chatId: ChatId
  connection: ConnectionProfile
  apiKey: string
  content: ContentItem[]
  attachmentRefs?: AttachmentRef[]
  capabilities?: CapabilityDescriptor
  transform?: Partial<ChatCompletionsTransformOptions>
  // Injection seam for integration tests that want to mock the stream
  // generator instead of `fetch`. The default opens a real chat-completions
  // call; tests pass a replacement iterable.
  openStream?: (input: OpenStreamInput) => AsyncIterable<OpenStreamChunk>
  signal?: AbortSignal
  now?: () => number
  // Optional assistant-prefill content. The request planner sees it as a
  // trailing assistant input, while storage creates one generated assistant
  // row initialized with this content and appends streamed continuation
  // tokens into that same row.
  prefillContent?: ContentItem[]
}

// "Open an assistant stream under an existing user (or other) message."
// Used by edit-then-send (the user sibling already exists; only a
// fresh assistant reply is needed) and regenerate-after-branch flows. No user
// message is created here. `prefillContent` (inherited from SendTextInput)
// is honored by adding a trailing assistant input to the request plan and
// initializing the generated assistant row with that text.
interface SendFromMessageInput extends Omit<SendTextInput, 'content'> {
  // Any existing message on the active path; the assistant placeholder
  // will be created as its child. Typically a user-role message.
  parentMessageId: MessageId
}

interface OpenStreamInput {
  connection: ConnectionProfile
  apiKey: string
  wireBody: Record<string, unknown>
  signal: AbortSignal
  route?: AssistantRequestPlan['route']
  geminiModelId?: string
}

type OpenStreamChunk = AssistantStreamChunk

function devOnlyOpenStreamOverride(
  openStream: SendTextInput['openStream'],
): SendTextInput['openStream'] {
  if (!openStream) return undefined
  if ((import.meta as { env?: { DEV?: boolean } }).env?.DEV !== true) {
    throw new Error('openStream override is dev-only; production sends must use assistant-stream')
  }
  return openStream
}

export interface SendTextResult {
  streamId: string
  userMessageId: MessageId
  assistantMessageId: MessageId
  outcome: 'done' | 'error' | 'abort'
  finishReason?: FinishReason
  error?: ApiError
}

// Public entry used by the hook + integration tests. Opens a stream, persists
// results, and resolves with the outcome. Never throws for normal upstream
// errors (they land in `result.error`); only programming errors (missing chat
// id, invalid invariants) throw.
export async function sendText(input: SendTextInput): Promise<SendTextResult> {
  const now = input.now ?? Date.now
  const lifecycle = startRequestLifecycle({
    chatId: input.chatId,
    streamId: newId(),
    ...(input.signal ? { userSignal: input.signal } : {}),
  })
  try {
    const chat = await getChat(input.chatId)
    if (!chat) throw new Error(`sendText: chat not found: ${input.chatId}`)

    const cursor = useChatStore.getState().getCursor(input.chatId) ?? {}
    const branchSnapshot = await loadActiveBranchSnapshot(input.chatId, cursor)
    const path = branchSnapshot.branch
    const parentId = path.at(-1)?.id ?? null
    const createdAt = now()
    const userMessageId = newId()
    const userTurnId = newId()
    const pendingUser = pendingUserMessage({
      chatId: input.chatId,
      parentId,
      siblingIndex: nextSiblingIndex(
        groupByParent(branchSnapshot.allHeaders as unknown as Message[]),
        parentId,
      ),
      content: input.content,
      ...(input.attachmentRefs ? { attachmentRefs: input.attachmentRefs } : {}),
      createdAt,
      messageId: userMessageId,
      turnId: userTurnId,
    })
    const hasPrefill = (input.prefillContent?.length ?? 0) > 0
    const prefillMessageId = hasPrefill ? newId() : null
    const pendingPrefill = hasPrefill
      ? pendingPrefillMessage({
          chatId: input.chatId,
          parentId: userMessageId,
          siblingIndex: 0,
          content: input.prefillContent ?? [],
          createdAt,
          messageId: prefillMessageId as MessageId,
          turnId: userTurnId,
        })
      : null
    const plannedPath = pendingPrefill
      ? [...path, pendingUser, pendingPrefill]
      : [...path, pendingUser]
    let requestPlan: AssistantRequestPlan
    try {
      requestPlan = (
        await prepareAssistantRequestPlan({
          chat,
          connection: input.connection,
          pathMessages: plannedPath,
          draftText: '',
          debugSource: 'send',
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
          ...(input.transform ? { transform: input.transform } : {}),
          signal: lifecycle.signal,
        })
      ).requestPlan
    } catch (err) {
      throwWithZeroEligibleUi(input.chatId, err)
    }
    if (lifecycle.signal.aborted) throw new DOMException('Request aborted.', 'AbortError')
    const skipTurnCalibration = requestHasTools(requestPlan.wire)

    const userMsg = await sendUserMessage({
      chatId: input.chatId,
      cursor,
      content: input.content,
      ...(input.attachmentRefs ? { attachmentRefs: input.attachmentRefs } : {}),
      now: createdAt,
      messageId: userMessageId,
      turnId: userTurnId,
      ...(skipTurnCalibration ? { skipCalibration: true } : {}),
    })
    const cursorAfterUser = {
      ...cursor,
      ...userMsg.effects.cursorUpdates,
    }
    useChatStore.getState().setCursor(input.chatId, cursorAfterUser)

    return await openAssistantStreamUnder({
      ...input,
      signal: lifecycle.signal,
      streamId: lifecycle.streamId,
      parentMessageId: userMsg.messageId,
      userMessageId: userMsg.messageId,
      ...(hasPrefill ? { initialAssistantContent: input.prefillContent ?? [] } : {}),
      requestPlan,
    })
  } finally {
    lifecycle.end(lifecycle.signal.aborted ? 'abort' : 'error')
  }
}

// Edit-then-send / resend-from-existing-user entrypoint. The caller has
// already created the user sibling (e.g. via `insertSibling` with
// role:'user', origin:'user'); all that's left is to attach an assistant
// placeholder under it and stream the reply. No user message is created.
export async function sendFromMessage(input: SendFromMessageInput): Promise<SendTextResult> {
  const lifecycle = startRequestLifecycle({
    chatId: input.chatId,
    streamId: newId(),
    ...(input.signal ? { userSignal: input.signal } : {}),
  })
  try {
    const chat = await getChat(input.chatId)
    if (!chat) throw new Error(`sendText: chat not found: ${input.chatId}`)
    const repo = getBrowserRepository()
    const parent = await repo.getMessage(input.parentMessageId)
    if (!parent || parent.chatId !== input.chatId || parent.deleted) {
      throw new Error(`sendFrom: parent ${input.parentMessageId} unavailable`)
    }
    const baseCursor = useChatStore.getState().getCursor(input.chatId) ?? {}
    const cursor: Record<string, MessageId> = { ...baseCursor }
    let cur: Message | undefined = parent
    while (cur) {
      cursor[cursorKeyOf(cur.parentId)] = cur.id
      cur = cur.parentId ? await repo.getMessage(cur.parentId) : undefined
    }
    const branchSnapshot = await loadActiveBranchSnapshot(input.chatId, cursor)
    const path = branchSnapshot.branch
    const parentIdx = path.findIndex((m) => m.id === parent.id)
    const rawOutboundPath = parentIdx >= 0 ? path.slice(0, parentIdx + 1) : path
    const hasPrefill = (input.prefillContent?.length ?? 0) > 0
    const prefillMessageId = hasPrefill ? newId() : null
    const createdAt = (input.now ?? Date.now)()
    const pendingPrefill =
      hasPrefill && prefillMessageId
        ? pendingPrefillMessage({
            chatId: input.chatId,
            parentId: input.parentMessageId,
            siblingIndex: 0,
            content: input.prefillContent ?? [],
            createdAt,
            messageId: prefillMessageId,
            turnId: parent.turnId,
          })
        : null
    const plannedPath = pendingPrefill ? [...rawOutboundPath, pendingPrefill] : rawOutboundPath
    let requestPlan: AssistantRequestPlan
    try {
      requestPlan = (
        await prepareAssistantRequestPlan({
          chat,
          connection: input.connection,
          pathMessages: plannedPath,
          draftText: '',
          debugSource: 'send-from-message',
          ...(input.capabilities ? { capabilities: input.capabilities } : {}),
          ...(input.transform ? { transform: input.transform } : {}),
          signal: lifecycle.signal,
        })
      ).requestPlan
    } catch (err) {
      throwWithZeroEligibleUi(input.chatId, err)
    }
    if (lifecycle.signal.aborted) throw new DOMException('Request aborted.', 'AbortError')

    return await openAssistantStreamUnder({
      ...input,
      signal: lifecycle.signal,
      streamId: lifecycle.streamId,
      parentMessageId: input.parentMessageId,
      userMessageId: input.parentMessageId,
      ...(hasPrefill ? { initialAssistantContent: input.prefillContent ?? [] } : {}),
      requestPlan,
    })
  } finally {
    lifecycle.end(lifecycle.signal.aborted ? 'abort' : 'error')
  }
}

async function openAssistantStreamUnder(
  input: SendFromMessageInput & {
    userMessageId: MessageId
    requestPlan: AssistantRequestPlan
    streamId?: string
    initialAssistantContent?: ContentItem[]
  },
): Promise<SendTextResult> {
  const now = input.now ?? Date.now
  const repo = getBrowserRepository()
  const chat = await getChat(input.chatId)
  if (!chat) throw new Error(`sendText: chat not found: ${input.chatId}`)

  const parent = await repo.getMessage(input.parentMessageId)
  if (!parent || parent.chatId !== input.chatId || parent.deleted) {
    throw new Error(`sendText: parent ${input.parentMessageId} unavailable`)
  }
  const requestPlan = input.requestPlan
  const {
    settings: requestSettings,
    useTextProtocol,
    route,
    requestedModel,
    geminiModelId,
    wire,
    outboundPath,
    outboundTokenizer,
    outboundReasoningOpts,
    hasAttachmentContext,
  } = requestPlan
  const placeholderApiUsed: 'chat' | 'completion' = useTextProtocol ? 'completion' : 'chat'
  const initialAssistantContent = input.initialAssistantContent ?? []
  const initialStoredContent = assistantContentWithStreamPrefix(initialAssistantContent, '')
  const hasNonTextOutbound = outboundPath.some((message) =>
    message.content.some(isNonTextContentItem),
  )

  const assistantId = newId()
  await repo.runMutation(
    [
      { kind: 'message', messageId: assistantId },
      { kind: 'children', chatId: input.chatId, parentId: input.parentMessageId },
    ],
    async (ctx) => {
      const siblings = await ctx.listChildren(input.chatId, input.parentMessageId)
      await ctx.putMessage({
        id: assistantId,
        chatId: input.chatId,
        parentId: input.parentMessageId,
        siblingIndex: nextSiblingIndex(groupByParent(siblings), input.parentMessageId),
        turnId: newId(),
        turnIndex: 0,
        createdAt: now(),
        role: 'assistant',
        origin: 'generated',
        content: structuredClone(initialStoredContent),
        nodeVersion: 0,
        deleted: false,
        generation: {
          id: '',
          model: chat.settings.model,
          requestedModel: chat.settings.model,
          apiUsed: placeholderApiUsed,
          delivery: 'streaming',
          costSource: 'stream',
          startedAt: now(),
        },
      })
    },
  )

  useChatStore.getState().patchCursor(input.chatId, cursorKeyOf(input.parentMessageId), assistantId)

  const streamId = input.streamId ?? newId()
  const debugScope = `send:${streamId}`
  const abortController = new AbortController()
  const abortStream = () => abortController.abort()
  const userSignal = input.signal
  if (userSignal?.aborted) abortController.abort(userSignal.reason)
  else
    userSignal?.addEventListener('abort', () => abortController.abort(userSignal.reason), {
      once: true,
    })

  markLifecycleTarget({
    chatId: input.chatId,
    streamId,
    messageId: assistantId,
    abort: abortStream,
  })

  const accumulator = createAccumulator({
    initialContent: initialAssistantContent,
    now: now(),
    ...(streamDebugEnabled(input.connection) ? { debugScope } : {}),
  })

  const resolvedApiUsed: GenerationMeta['apiUsed'] = useTextProtocol
    ? 'completion'
    : routeApiUsed(route)

  await repo.runMutation([{ kind: 'message', messageId: assistantId }], async (ctx) => {
    const current = await ctx.getMessage(assistantId)
    if (!current?.generation) return
    await ctx.putMessage(
      {
        ...current,
        generation: {
          ...current.generation,
          requestedModel,
          apiUsed: resolvedApiUsed,
        },
      },
      { touchChatSummary: false, broadcast: false },
    )
  })

  if (streamDebugEnabled(input.connection)) {
    logStreamDebug(debugScope, 'send.open', {
      streamId,
      requestedModel,
      connection: {
        id: input.connection.id,
        name: input.connection.name,
        kind: input.connection.kind,
        baseUrl: input.connection.baseUrl,
      },
      chatSettingsModel: requestSettings.model,
      useTextProtocol,
      route,
      wireBody: wire,
    })
  }

  const openStream =
    devOnlyOpenStreamOverride(input.openStream) ??
    ((open) =>
      openAssistantRequestStream({
        connection: open.connection,
        apiKey: open.apiKey,
        requestPlan,
        signal: open.signal,
      }))

  let outcome: 'done' | 'error' | 'abort' = 'done'
  let abortReason: AbortReason | undefined
  let streamError: ApiError | undefined
  let finalFinishReason: FinishReason | undefined

  try {
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
      accumulator.lastChunkReceivedAt = eventNow
      applyEvent(accumulator, event, eventNow)
      queueStreamChunk({
        repo,
        chatId: input.chatId,
        streamId,
        messageId: assistantId,
        accumulator,
        event,
        now: eventNow,
      })
      if (event.lane === 'error') {
        outcome = 'error'
        streamError = event.error
        break
      }
      const afterEventNow = now()
      if (shouldPublishLive(accumulator, afterEventNow)) {
        publishLiveSnapshot({
          chatId: input.chatId,
          streamId,
          messageId: assistantId,
          accumulator,
          requestedModel,
          apiUsed: resolvedApiUsed,
          now: afterEventNow,
        })
      }
      flushStreamChunksSoon(repo, accumulator, afterEventNow)
    }
  } catch (err) {
    if (abortController.signal.aborted || userSignal?.aborted) {
      outcome = 'abort'
      abortReason = 'user'
    } else if (err instanceof ApiError && err.kind === 'network') {
      // Network drop: the fetch never reached completion. Treat as an abort
      // with a 'network' reason so the UI can surface a Continue affordance
      // (plan/13-delivery.md Phase 7 e2e row: network drop mid-stream).
      outcome = 'abort'
      abortReason = 'network'
    } else {
      outcome = 'error'
      streamError = err instanceof ApiError ? err : undefined
    }
  } finally {
    const commitFinalState = async () => {
      let finalized = false
      try {
        await settlePendingStreamChunkFlush(accumulator)
        await finalize({
          repo,
          chatId: input.chatId,
          streamId,
          messageId: assistantId,
          connection: input.connection,
          apiKey: input.apiKey,
          accumulator,
          requestedModel,
          apiUsed: resolvedApiUsed,
          outcome,
          ...(abortReason ? { abortReason } : {}),
          ...(streamError ? { error: streamError } : {}),
          now: now(),
          ...(hasAttachmentContext ||
          hasNonTextOutbound ||
          requestHasTools(wire) ||
          accumulator.generatedContent.some(isNonTextContentItem) ||
          hasAudioOutput(accumulator)
            ? {}
            : {
                calibrationInputs: {
                  outboundPath,
                  systemPrompt: requestSettings.systemPrompt,
                  modelId: requestSettings.model,
                  family: outboundTokenizer,
                  ...(outboundReasoningOpts ? { reasoningOpts: outboundReasoningOpts } : {}),
                },
              }),
        })
        finalized = true
        await repo.deleteStreamChunks(streamId).catch(() => {})
      } catch (err) {
        if (!finalized) await flushStreamChunks(repo, accumulator).catch(() => {})
        throw err
      }
    }
    try {
      await commitFinalState()
    } finally {
      finalFinishReason = accumulator.finishReason as FinishReason | undefined
      releaseAccumulatorBuffers(accumulator)
      useStreamStore.getState().clearActive(streamId)
      useStreamStore.getState().clearLiveSnapshot(assistantId)
      postEvent({
        kind: 'stream-ended',
        chatId: input.chatId,
        streamId,
        messageId: assistantId,
        outcome,
      })
    }
  }

  const result: SendTextResult = {
    streamId,
    userMessageId: input.userMessageId,
    assistantMessageId: assistantId,
    outcome,
  }
  if (finalFinishReason) {
    result.finishReason = finalFinishReason
  }
  if (streamError) result.error = streamError
  return result
}

function applyEvent(acc: ChatAccumulator, event: StreamLaneEvent, nowMs: number): void {
  switch (event.lane) {
    case 'text':
      if (acc.firstTextAt === undefined) acc.firstTextAt = nowMs
      appendStreamText(acc, event.text)
      acc.dirtySinceLastLivePublish = true
      return
    case 'reasoning': {
      // Phase-7 reasoning reducer preserves whatever structure the provider
      // emitted. Responses / Gemini-native deltas carry stable synthetic ids
      // when possible so repeated flushes, mirrored buffered fallbacks, and
      // incremental deltas all hit the same row instead of each surface
      // inventing its own merge rule.
      if (acc.reasoningStartedAt === undefined) acc.reasoningStartedAt = nowMs
      acc.reasoningFinishedAt = nowMs
      const outputIndex = event.outputIndex ?? 0
      if (Array.isArray(event.details)) {
        for (const raw of event.details) {
          if (!raw || typeof raw !== 'object') continue
          const detail = normalizeIncomingReasoningDetail(
            raw as ReasoningDetail & { index?: number },
          )
          if (detail.id?.startsWith('tool_')) continue
          putReasoningDetail(acc, detail)
          acc.dirtySinceLastLivePublish = true
        }
      }
      if (event.textDelta !== undefined) {
        const id = syntheticReasoningDetailId('reasoning.text', event)
        putReasoningDetail(acc, {
          type: 'reasoning.text',
          ...(id ? { id } : {}),
          index: outputIndex,
          text: event.textDelta,
        })
        acc.dirtySinceLastLivePublish = true
      }
      if (event.summaryDelta !== undefined) {
        const id = syntheticReasoningDetailId('reasoning.summary', event)
        putReasoningDetail(acc, {
          type: 'reasoning.summary',
          ...(id ? { id } : {}),
          index: outputIndex,
          summary: event.summaryDelta,
        })
        acc.dirtySinceLastLivePublish = true
      }
      if (event.encryptedDelta !== undefined) {
        const id = syntheticReasoningDetailId('reasoning.encrypted', event)
        putReasoningDetail(acc, {
          type: 'reasoning.encrypted',
          ...(id ? { id } : {}),
          index: outputIndex,
          data: event.encryptedDelta,
        })
        acc.dirtySinceLastLivePublish = true
      }
      if (acc.debugScope) {
        logStreamDebug(acc.debugScope, 'reasoning.apply', {
          event,
          reasoningList: acc.reasoningList,
        })
      }
      return
    }
    case 'usage':
      acc.usage = event.usage as ChatUsage
      return
    case 'finish':
      acc.finishReason = event.finishReason
      return
    case 'meta':
      if (event.generationId) acc.generationId = event.generationId
      if (event.model) acc.model = event.model
      if (event.provider) acc.provider = event.provider
      return
    case 'content-item':
      acc.generatedContent.push(structuredClone(event.item))
      acc.dirtySinceLastLivePublish = true
      return
    case 'audio-output':
      if (!acc.audioOutput) {
        acc.audioOutput = { chunks: [], transcript: '', format: event.format ?? 'pcm16' }
      }
      if (event.format) acc.audioOutput.format = event.format
      if (event.dataDelta) acc.audioOutput.chunks.push(event.dataDelta)
      if (event.transcriptDelta) acc.audioOutput.transcript += event.transcriptDelta
      acc.dirtySinceLastLivePublish = true
      return
    case 'server-tool':
      recordServerToolStatus(acc, event)
      return
    case 'server-tool-output':
      upsertServerTool(acc.serverTools, {
        type: event.itemType,
        source: 'provider-output',
        id: event.itemId,
        ...(event.status ? { status: event.status } : {}),
        outputIndex: event.outputIndex,
        output: structuredClone(event.output),
      })
      recordProviderOutputItem(acc, event.itemType, event.output, event.outputIndex)
      return
    case 'output-item-added':
      recordServerToolOutputItem(acc, event.item, event.outputIndex, 'stream-status')
      return
    case 'output-item-done':
      recordServerToolOutputItem(acc, event.item, event.outputIndex, 'responses-output')
      recordResponsesOutputItem(acc, event.item, event.outputIndex)
      return
    case 'phase':
      if (event.phase === null) delete acc.phase
      else acc.phase = event.phase
      return
    case 'error':
      acc.midStreamError = event.error
      return
    case 'buffered':
      // `splitChatStream` re-emits buffered payloads as text/finish/usage so
      // the main reducer doesn't need a branch; the buffered event itself is
      // informational only at Phase 7.
      return
    case 'keepalive':
    case 'tool-call':
      // Phase 7: keepalive feeds hang detection (not persisted) and
      // tool-calls aren't supported yet. Both are accepted so later phases
      // just add branches here.
      return
  }
}

const HOSTED_SERVER_TOOL_ITEM_TYPES = new Set<string>([
  'web_search_call',
  'file_search_call',
  'image_generation_call',
  'code_interpreter_call',
  'shell_call',
  'shell_call_output',
  'computer_call',
  'mcp_tool_call',
  'mcp_call',
  'google:google_search',
  'google:url_context',
  'google:code_execution',
  'google:google_maps',
  'openrouter:datetime',
  'openrouter:web_fetch',
  'openrouter:web_search',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'advisor_tool_result',
])

function requestHasTools(wire: unknown): boolean {
  if (!wire || typeof wire !== 'object') return false
  const tools = (wire as { tools?: unknown }).tools
  return Array.isArray(tools) && tools.length > 0
}

function hasServerToolUsage(usage: ChatUsage | undefined): boolean {
  if (!usage?.server_tool_use || typeof usage.server_tool_use !== 'object') return false
  return Object.values(usage.server_tool_use).some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
  )
}

function recordServerToolStatus(
  acc: ChatAccumulator,
  event: Extract<StreamLaneEvent, { lane: 'server-tool' }>,
): void {
  upsertServerTool(acc.serverTools, {
    type: event.itemType,
    source: 'stream-status',
    id: event.itemId,
    status: event.status,
    outputIndex: event.outputIndex,
    ...(event.partialImageB64 ? { output: { partialImageB64: event.partialImageB64 } } : {}),
  })
}

function recordServerToolOutputItem(
  acc: ChatAccumulator,
  item: unknown,
  outputIndex: number,
  fallbackSource: GenerationServerToolCall['source'],
): void {
  if (!item || typeof item !== 'object') return
  const record = item as { type?: unknown; id?: unknown; status?: unknown }
  if (typeof record.type !== 'string' || !HOSTED_SERVER_TOOL_ITEM_TYPES.has(record.type)) return
  upsertServerTool(acc.serverTools, {
    type: record.type,
    source: fallbackSource,
    ...(typeof record.id === 'string' ? { id: record.id } : {}),
    ...(typeof record.status === 'string' ? { status: record.status } : {}),
    outputIndex,
    output: structuredClone(item),
  })
}

function recordResponsesOutputItem(acc: ChatAccumulator, item: unknown, outputIndex: number): void {
  const providerItem = providerOutputItemFromResponsesItem(item, outputIndex)
  if (!providerItem) return
  upsertProviderOutputItem(acc.providerOutputItems, providerItem)
}

function recordProviderOutputItem(
  acc: ChatAccumulator,
  type: string,
  output: unknown,
  outputIndex: number,
): void {
  const providerItem = type.startsWith('google:')
    ? providerOutputItemFromGeminiPart(type, output, outputIndex)
    : type === 'server_tool_use' || type.endsWith('_tool_result')
      ? providerOutputItemFromResponsesItem(output, outputIndex)
    : null
  if (!providerItem) return
  upsertProviderOutputItem(acc.providerOutputItems, providerItem)
}

function serverToolRecordsFromUsage(usage: ChatUsage | undefined): GenerationServerToolCall[] {
  const raw = usage?.server_tool_use
  if (!raw || typeof raw !== 'object') return []
  const records: GenerationServerToolCall[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue
    records.push({
      type: serverToolUsageKeyToType(key),
      source: 'usage',
      status: 'completed',
      requestCount: value,
      output: { [key]: value },
    })
  }
  return records
}

function serverToolUsageKeyToType(key: string): string {
  if (key === 'web_search_requests') return 'openrouter:web_search'
  if (key === 'web_fetch_requests') return 'openrouter:web_fetch'
  if (key === 'datetime_requests') return 'openrouter:datetime'
  return key
}

function mergeServerToolRecords(
  records: readonly GenerationServerToolCall[],
): GenerationServerToolCall[] {
  const merged: GenerationServerToolCall[] = []
  for (const record of records) upsertServerTool(merged, record)
  return merged
}

function upsertServerTool(
  records: GenerationServerToolCall[],
  incoming: GenerationServerToolCall,
): void {
  const key = serverToolRecordKey(incoming)
  const index = records.findIndex((record) => serverToolRecordKey(record) === key)
  if (index < 0) {
    records.push(structuredClone(incoming))
    return
  }
  const existing = records[index]
  if (!existing) return
  records[index] = {
    ...existing,
    ...structuredClone(incoming),
    source:
      incoming.source === 'responses-output' || existing.source !== 'responses-output'
        ? incoming.source
        : existing.source,
  }
}

function upsertProviderOutputItem(
  records: ProviderOutputItem[],
  incoming: ProviderOutputItem,
): void {
  const key = providerOutputItemKey(incoming)
  const index = records.findIndex((record) => providerOutputItemKey(record) === key)
  if (index < 0) {
    records.push(structuredClone(incoming))
    return
  }
  records[index] = structuredClone(incoming)
}

function providerOutputItemKey(record: ProviderOutputItem): string {
  const item = record.item as {
    id?: unknown
    call_id?: unknown
    executableCode?: { id?: unknown }
    codeExecutionResult?: { id?: unknown }
  }
  if (typeof item?.id === 'string') return `id:${item.id}`
  if (typeof item?.call_id === 'string') return `call:${record.type}:${item.call_id}`
  if (typeof item?.executableCode?.id === 'string') {
    return `gemini-code:${item.executableCode.id}:exec`
  }
  if (typeof item?.codeExecutionResult?.id === 'string') {
    return `gemini-code:${item.codeExecutionResult.id}:result`
  }
  if (record.outputIndex !== undefined) {
    return `idx:${record.outputIndex}:${record.type}:${Object.keys(item ?? {}).join(',')}`
  }
  return `${record.dialect}:${record.type}:${JSON.stringify(record.item).slice(0, 128)}`
}

function serverToolRecordKey(record: GenerationServerToolCall): string {
  if (record.id) return `id:${record.id}:${record.type}`
  if (record.outputIndex !== undefined) return `idx:${record.outputIndex}:${record.type}`
  return `usage:${record.type}`
}

function appendStreamText(acc: ChatAccumulator, text: string): void {
  if (text.length === 0) return
  acc.textChunks.push(text)
  acc.textLength += text.length
}

function streamTextSnapshot(acc: ChatAccumulator): string {
  if (acc.textChunks.length === 0) return acc.textSnapshot
  acc.textSnapshot =
    acc.textSnapshot.length === 0
      ? acc.textChunks.join('')
      : `${acc.textSnapshot}${acc.textChunks.join('')}`
  acc.textChunks = []
  return acc.textSnapshot
}

function releaseAccumulatorBuffers(acc: ChatAccumulator): void {
  acc.initialContent = []
  acc.textChunks = []
  acc.textSnapshot = ''
  acc.textLength = 0
  acc.reasoningList = []
  acc.reasoningRowById.clear()
  acc.generatedContent = []
  acc.serverTools = []
  acc.providerOutputItems = []
  acc.streamChunkBuffer = []
  if (acc.streamChunkFlushTimer) {
    clearTimeout(acc.streamChunkFlushTimer)
    delete acc.streamChunkFlushTimer
  }
  delete acc.audioOutput
}

function shouldPublishLive(acc: ChatAccumulator, nowMs: number): boolean {
  if (!acc.dirtySinceLastLivePublish) return false
  if (nowMs - acc.lastLivePublishedAt >= STREAM_LIVE_UPDATE_INTERVAL_MS) return true
  if (acc.textLength - acc.lastLivePublishedTextLen >= STREAM_LIVE_TEXT_GROWTH_CHARS) {
    return true
  }
  const reasoningLen = reasoningTextLength(acc.reasoningList)
  if (reasoningLen - acc.lastLivePublishedReasoningLen >= STREAM_LIVE_TEXT_GROWTH_CHARS) {
    return true
  }
  return false
}

function reasoningTextLength(details: readonly ReasoningDetail[]): number {
  let total = 0
  for (const detail of details) {
    if (detail.type === 'reasoning.text') total += detail.text?.length ?? 0
    else if (detail.type === 'reasoning.summary') total += detail.summary?.length ?? 0
    else if (detail.type === 'reasoning.encrypted') total += detail.data?.length ?? 0
  }
  return total
}

function publishLiveSnapshot(ctx: {
  chatId: ChatId
  streamId: string
  messageId: MessageId
  accumulator: ChatAccumulator
  requestedModel: string
  apiUsed: GenerationMeta['apiUsed']
  now: number
}): void {
  const { accumulator } = ctx
  const reasoning = collectReasoning(accumulator)
  const streamedText = streamTextSnapshot(accumulator)
  const content = assistantContentWithStreamPrefix(
    accumulator.initialContent,
    streamedText,
    streamPreviewGeneratedContent(accumulator.generatedContent),
  )
  useStreamStore.getState().setLiveSnapshot({
    streamId: ctx.streamId,
    chatId: ctx.chatId,
    messageId: ctx.messageId,
    content,
    ...(reasoning.length > 0 ? { reasoningDetails: reasoning } : {}),
    generation: updatedGeneration(undefined, accumulator, ctx.requestedModel, {
      apiUsed: ctx.apiUsed,
    }),
    textLength: accumulator.textLength,
    reasoningLength: reasoningTextLength(reasoning),
    updatedAt: ctx.now,
  })
  accumulator.lastLivePublishedAt = ctx.now
  accumulator.lastLivePublishedTextLen = accumulator.textLength
  accumulator.lastLivePublishedReasoningLen = reasoningTextLength(reasoning)
  accumulator.dirtySinceLastLivePublish = false
}

function queueStreamChunk(ctx: {
  repo: ReturnType<typeof getBrowserRepository>
  chatId: ChatId
  streamId: string
  messageId: MessageId
  accumulator: ChatAccumulator
  event: StreamLaneEvent
  now: number
}): void {
  if (!shouldPersistStreamEvent(ctx.event)) return
  const event = serializeStreamEvent(ctx.event, ctx.accumulator)
  if (!event) return
  ctx.accumulator.streamChunkBuffer.push({
    id: `${ctx.streamId}:${ctx.accumulator.nextStreamChunkSeq}`,
    streamId: ctx.streamId,
    chatId: ctx.chatId,
    messageId: ctx.messageId,
    seq: ctx.accumulator.nextStreamChunkSeq,
    createdAt: ctx.now,
    event,
  })
  ctx.accumulator.nextStreamChunkSeq += 1
  ctx.accumulator.bufferedStreamChunkTextLen += streamEventTextLength(event)
}

function shouldPersistStreamEvent(event: StreamLaneEvent): boolean {
  switch (event.lane) {
    case 'text':
    case 'reasoning':
    case 'usage':
    case 'finish':
    case 'meta':
    case 'content-item':
    case 'audio-output':
    case 'server-tool':
    case 'server-tool-output':
    case 'output-item-added':
    case 'output-item-done':
    case 'error':
      return true
    case 'buffered':
    case 'keepalive':
    case 'phase':
      return true
    case 'tool-call':
      return false
  }
}

function serializeStreamEvent(
  event: StreamLaneEvent,
  acc: ChatAccumulator,
): StreamLaneEvent | null {
  if (event.lane === 'meta') {
    const meta: StreamLaneEvent & { lane: 'meta' } = { lane: 'meta' }
    let dirty = false
    if (event.generationId !== undefined && acc.persistedStreamGenerationId === undefined) {
      meta.generationId = event.generationId
      acc.persistedStreamGenerationId = event.generationId
      dirty = true
    }
    if (event.model !== undefined && event.model !== acc.persistedStreamModel) {
      meta.model = event.model
      acc.persistedStreamModel = event.model
      dirty = true
    }
    if (event.provider !== undefined && event.provider !== acc.persistedStreamProvider) {
      meta.provider = event.provider
      acc.persistedStreamProvider = event.provider
      dirty = true
    }
    return dirty ? meta : null
  }
  if (event.lane === 'output-item-added' || event.lane === 'output-item-done') {
    if (!isRecoverableOutputItem(event.item)) return null
  }
  if (event.lane === 'error') {
    return {
      lane: 'error',
      error: {
        ...event.error,
        message: event.error.message,
      },
    }
  }
  return structuredClone(event)
}

function isRecoverableOutputItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const type = (item as { type?: unknown }).type
  return typeof type === 'string' && HOSTED_SERVER_TOOL_ITEM_TYPES.has(type)
}

function streamEventTextLength(event: StreamLaneEvent): number {
  switch (event.lane) {
    case 'text':
      return event.text.length
    case 'reasoning':
      return (
        (event.textDelta?.length ?? 0) +
        (event.summaryDelta?.length ?? 0) +
        (event.encryptedDelta?.length ?? 0)
      )
    case 'audio-output':
      return (event.dataDelta?.length ?? 0) + (event.transcriptDelta?.length ?? 0)
    default:
      return 0
  }
}

function flushStreamChunksSoon(
  repo: ReturnType<typeof getBrowserRepository>,
  acc: ChatAccumulator,
  nowMs: number,
): void {
  if (acc.streamChunkBuffer.length === 0 || acc.pendingStreamChunkFlush) return
  const dueIn = Math.max(0, STREAM_CHUNK_FLUSH_INTERVAL_MS - (nowMs - acc.lastStreamChunkFlushAt))
  const dueNow =
    acc.streamChunkBuffer.length >= STREAM_CHUNK_FLUSH_MAX_ROWS ||
    acc.bufferedStreamChunkTextLen >= STREAM_CHUNK_FLUSH_MAX_TEXT_CHARS ||
    dueIn === 0
  if (!dueNow) {
    if (!acc.streamChunkFlushTimer) {
      acc.streamChunkFlushTimer = setTimeout(() => {
        delete acc.streamChunkFlushTimer
        void flushStreamChunks(repo, acc).catch(() => {})
      }, dueIn)
    }
    return
  }
  void flushStreamChunks(repo, acc).catch(() => {})
}

async function settlePendingStreamChunkFlush(acc: ChatAccumulator): Promise<void> {
  if (acc.streamChunkFlushTimer) {
    clearTimeout(acc.streamChunkFlushTimer)
    delete acc.streamChunkFlushTimer
  }
  if (acc.pendingStreamChunkFlush) await acc.pendingStreamChunkFlush.catch(() => {})
}

async function flushStreamChunks(
  repo: ReturnType<typeof getBrowserRepository>,
  acc: ChatAccumulator,
): Promise<void> {
  if (acc.streamChunkFlushTimer) {
    clearTimeout(acc.streamChunkFlushTimer)
    delete acc.streamChunkFlushTimer
  }
  if (acc.pendingStreamChunkFlush) {
    await acc.pendingStreamChunkFlush
    return
  }
  if (acc.streamChunkBuffer.length === 0) return
  const batch = acc.streamChunkBuffer
  acc.streamChunkBuffer = []
  acc.bufferedStreamChunkTextLen = 0
  let flush: Promise<void>
  flush = repo
    .appendStreamChunks(batch)
    .catch((err) => {
      acc.streamChunkBuffer = [...batch, ...acc.streamChunkBuffer]
      acc.bufferedStreamChunkTextLen += batch.reduce(
        (sum, row) => sum + streamEventTextLength(row.event as StreamLaneEvent),
        0,
      )
      throw err
    })
    .finally(() => {
      if (acc.pendingStreamChunkFlush === flush) {
        delete acc.pendingStreamChunkFlush
        acc.lastStreamChunkFlushAt = acc.lastChunkReceivedAt
        if (acc.streamChunkBuffer.length > 0) {
          flushStreamChunksSoon(repo, acc, acc.lastStreamChunkFlushAt)
        }
      }
    })
  acc.pendingStreamChunkFlush = flush
  await flush
}

function assistantContentWithStreamPrefix(
  initialContent: readonly ContentItem[],
  streamedText: string,
  generatedContent: readonly ContentItem[] = [],
): ContentItem[] {
  const prefix = initialContent
    .filter(
      (item): item is Extract<ContentItem, { type: 'text' | 'output_text' }> =>
        item.type === 'text' || item.type === 'output_text',
    )
    .map((item) => item.text)
    .join('')
  const nonText = initialContent.filter(
    (item) => item.type !== 'text' && item.type !== 'output_text',
  )
  const text = prefix.length > 0 ? `${prefix}${streamedText}` : streamedText
  return [
    { type: 'output_text', text },
    ...structuredClone(nonText),
    ...structuredClone(generatedContent),
  ]
}

function streamPreviewGeneratedContent(generatedContent: readonly ContentItem[]): ContentItem[] {
  return generatedContent.filter(
    (item) => item.type !== 'audio_output' && item.type !== 'output_video',
  )
}

function hasAudioOutput(acc: ChatAccumulator): boolean {
  return Boolean(
    acc.audioOutput && (acc.audioOutput.chunks.length > 0 || acc.audioOutput.transcript.length > 0),
  )
}

function audioOutputContent(acc: ChatAccumulator): ContentItem[] {
  if (!hasAudioOutput(acc) || !acc.audioOutput) return []
  const format = acc.audioOutput.format
  const joined = acc.audioOutput.chunks.join('')
  const item: ContentItem = {
    type: 'audio_output',
    format,
    ...(acc.audioOutput.transcript.length > 0 ? { transcript: acc.audioOutput.transcript } : {}),
  }
  if (joined.length > 0) {
    item.url =
      format === 'pcm16'
        ? pcm16DataUrlToWav(joined, { sampleRate: 24_000, channels: 1 })
        : `data:audio/${format};base64,${joined}`
  }
  return [item]
}

function pcm16DataUrlToWav(
  base64Pcm: string,
  opts: { sampleRate: number; channels: number },
): string {
  const pcm = decodeBase64Bytes(base64Pcm)
  const header = wavHeader(pcm.byteLength, opts.sampleRate, opts.channels)
  const bytes = new Uint8Array(header.byteLength + pcm.byteLength)
  bytes.set(header, 0)
  bytes.set(pcm, header.byteLength)
  return `data:audio/wav;base64,${encodeBase64Bytes(bytes)}`
}

function decodeBase64Bytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/gu, '').replace(/-/gu, '+').replace(/_/gu, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function wavHeader(dataBytes: number, sampleRate: number, channels: number): Uint8Array {
  const bytesPerSample = 2
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)
  return new Uint8Array(header)
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
}

interface FlushContext {
  repo: ReturnType<typeof getBrowserRepository>
  chatId: ChatId
  streamId: string
  messageId: MessageId
  accumulator: ChatAccumulator
  requestedModel: string
  apiUsed: GenerationMeta['apiUsed']
}

interface FinalizeContext extends FlushContext {
  connection: ConnectionProfile
  apiKey: string
  outcome: 'done' | 'error' | 'abort'
  abortReason?: AbortReason
  error?: ApiError
  now: number
  // Token-calibration inputs — present when the send can produce a
  // calibration sample on success. When omitted, calibration is skipped
  // (e.g., text-protocol / llama-server, where usage is not returned).
  calibrationInputs?: {
    outboundPath: readonly Message[]
    systemPrompt: string
    modelId: string
    family: import('../core/tokens').TokenizerFamily
    reasoningOpts?: PromptEstimateOptions
  }
}

function generatedOutputDownloader(input: {
  connection: ConnectionProfile
  apiKey: string
}): GeneratedOutputDownloader {
  return async ({ url }) => {
    const headers: Record<string, string> = {}
    if (shouldAuthorizeGeneratedOutputUrl(url, input.connection)) {
      headers.Authorization = `Bearer ${input.apiKey}`
    }
    const response = await fetch(url, { headers })
    if (!response.ok) return null
    return response.blob()
  }
}

function shouldAuthorizeGeneratedOutputUrl(url: string, connection: ConnectionProfile): boolean {
  if (connection.kind !== 'openrouter') return false
  let target: URL
  let base: URL
  try {
    target = new URL(url)
    base = new URL(connection.baseUrl)
  } catch {
    return false
  }
  if (target.origin !== base.origin) return false
  const basePath = base.pathname.replace(/\/+$/u, '')
  return target.pathname.startsWith(`${basePath}/videos/`)
}

async function finalize(ctx: FinalizeContext): Promise<void> {
  const {
    repo,
    chatId,
    messageId,
    accumulator,
    requestedModel,
    apiUsed,
    outcome,
    abortReason,
    error,
    now,
    calibrationInputs,
  } = ctx

  const rawFinalContent = assistantContentWithStreamPrefix(
    accumulator.initialContent,
    streamTextSnapshot(accumulator),
    [...accumulator.generatedContent, ...audioOutputContent(accumulator)],
  )
  const generatedImageAttachments = contentNeedsGeneratedOutputMaterialization(rawFinalContent)
    ? await materializeGeneratedOutputAttachments({
        messageId,
        content: rawFinalContent,
        now,
        downloader: generatedOutputDownloader(ctx),
      })
    : {
        content: rawFinalContent,
        replacements: [],
        newRefs: [],
        changed: false,
      }
  const finalContent = generatedImageAttachments.content
  const reasoning = collectReasoning(accumulator)

  // Pre-compute calibration fields for the assistant row. On a successful
  // `done`, `originalCharCount` / `originalTokenEstimate` /
  // `originalModelId` / `cachedTokenEstimate` are populated so the next
  // gauge tick can read the cache directly instead of re-multiplying
  // chars × ratio.
  // This block only runs for text-only sends; multimodal input/output is
  // excluded before `calibrationInputs` is passed into finalize.
  let assistantCalibrationFields: ReturnType<typeof calibrationFieldsForCreate> | null = null
  const toolCalibrationBlocked =
    calibrationInputs !== undefined &&
    (accumulator.serverTools.length > 0 || hasServerToolUsage(accumulator.usage))
  if (outcome === 'done' && calibrationInputs && !toolCalibrationBlocked) {
    try {
      const [chatForRatio, globalCal, prefs] = await Promise.all([
        repo.getChat(chatId),
        readTokenCalibrationGlobal(),
        readGlobalPreferences(),
      ])
      assistantCalibrationFields = calibrationFieldsForCreate(
        finalContent,
        calibrationInputs.modelId,
        chatForRatio,
        globalCal,
        prefs.tokenCalibrationMode,
      )
    } catch {
      assistantCalibrationFields = null
    }
  }

  let persistedAssistant: Message | null = null
  await repo.runMutation(
    [{ kind: 'message', messageId }, ...attachmentScopes(generatedImageAttachments.newRefs)],
    async (inner) => {
      const current = await inner.getMessageHeader(messageId)
      if (!current) return
      const generation = updatedGeneration(current.generation, accumulator, requestedModel, {
        apiUsed,
        finishedAt: now,
      })
      if (outcome === 'abort') {
        generation.abortReason = abortReason ?? 'user'
      }
      const finalError = error ?? accumulator.midStreamError
      if (finalError) {
        generation.error = {
          code: String(finalError.code),
          message: finalError.message,
          ...(finalError.httpStatus !== undefined ? { statusCode: finalError.httpStatus } : {}),
          raw: finalError,
        }
      }
      const headerPatch: MessageHeaderPatch = {
        generation,
        ...(assistantCalibrationFields ?? {}),
      }
      if (generatedImageAttachments.newRefs.length > 0) {
        const merged = mergeGeneratedImageAttachmentRefs(
          current.attachmentRefs,
          generatedImageAttachments.newRefs,
          messageId,
          now,
        )
        headerPatch.attachmentRefs = merged.refs
        headerPatch.cachedMediaTokens = undefined
        await incRefs(inner, merged.addedRefs)
      }
      await inner.patchMessageBody(
        messageId,
        {
          content: finalContent,
          reasoningDetails: reasoning.length > 0 ? reasoning : undefined,
          phase: accumulator.phase,
          providerOutputItems:
            accumulator.providerOutputItems.length > 0
              ? structuredClone(accumulator.providerOutputItems)
              : undefined,
        },
        {
          headerPatch,
          replaceBody: true,
        },
      )
      if (accumulator.debugScope) {
        logStreamDebug(accumulator.debugScope, 'message.finalize', {
          messageId,
          outcome,
          reasoningDetails: reasoning,
          content: finalContent,
          generation,
        })
      }
      persistedAssistant = {
        ...current,
        ...headerPatch,
        content: finalContent,
        ...(reasoning.length > 0 ? { reasoningDetails: reasoning } : {}),
        ...(accumulator.phase !== undefined ? { phase: accumulator.phase } : {}),
        ...(accumulator.providerOutputItems.length > 0
          ? { providerOutputItems: structuredClone(accumulator.providerOutputItems) }
          : {}),
      } as Message
    },
  )

  // Token calibration happens AFTER the assistant message is persisted
  // so the final content + reasoningDetails + usage are available. Skips
  // on anything other than a clean `done`, because error/abort streams
  // don't have reliable usage from the server.
  if (
    outcome === 'done' &&
    calibrationInputs &&
    !toolCalibrationBlocked &&
    persistedAssistant !== null &&
    accumulator.usage
  ) {
    try {
      await ingestCalibrationSample({
        repo,
        chatId,
        assistantMessage: persistedAssistant,
        usage: accumulator.usage,
        calibrationInputs,
      })
    } catch {
      // Non-fatal: calibration failure must not surface to the user.
    }
  }
}

function isNonTextContentItem(item: ContentItem): boolean {
  return item.type !== 'text' && item.type !== 'output_text'
}

function contentNeedsGeneratedOutputMaterialization(content: readonly ContentItem[]): boolean {
  return content.some(
    (item) =>
      (item.type === 'output_image' ||
        item.type === 'audio_output' ||
        item.type === 'output_video') &&
      !item.attachmentId &&
      typeof item.url === 'string' &&
      item.url.length > 0,
  )
}

async function ingestCalibrationSample(args: {
  repo: ReturnType<typeof getBrowserRepository>
  chatId: ChatId
  assistantMessage: Message
  usage: ChatUsage
  calibrationInputs: NonNullable<FinalizeContext['calibrationInputs']>
}): Promise<void> {
  const { repo, chatId, assistantMessage, usage, calibrationInputs } = args
  if (
    calibrationInputs.outboundPath.some((message) => message.content.some(isNonTextContentItem)) ||
    assistantMessage.content.some(isNonTextContentItem)
  ) {
    return
  }

  const promptSample = derivePromptSample({
    sentPath: calibrationInputs.outboundPath,
    systemPrompt: calibrationInputs.systemPrompt,
    usage,
    family: calibrationInputs.family,
    modelId: calibrationInputs.modelId,
    mediaTokens: 0,
    ...(calibrationInputs.reasoningOpts
      ? { reasoningEchoOpts: calibrationInputs.reasoningOpts }
      : {}),
  })
  const completionSample = deriveCompletionSample({
    assistantMessage,
    usage,
    family: calibrationInputs.family,
  })

  if (promptSample === null && completionSample === null) return

  // Step 1: apply per-chat samples in memory. `patchChatMeta` with
  // `touchVisibleState: false` writes into the hidden meta patch so
  // `metaVersion` doesn't bump and a sidebar broadcast doesn't fire just
  // for a calibration delta.
  const acceptedSamples: Array<{ chars: number; tokens: number }> = []
  await repo.runMutation([{ kind: 'chat-meta', chatId }], async (inner) => {
    const chat = await inner.getChat(chatId)
    if (!chat) return
    const staged = {
      tokenCalibration: { ...(chat.tokenCalibration ?? {}) },
    }
    if (promptSample !== null) {
      const outcome = addSampleToChat(
        staged,
        calibrationInputs.modelId,
        promptSample.chars,
        promptSample.tokens,
      )
      if (outcome.accepted) acceptedSamples.push(promptSample)
    }
    if (completionSample !== null) {
      const outcome = addSampleToChat(
        staged,
        calibrationInputs.modelId,
        completionSample.chars,
        completionSample.tokens,
      )
      if (outcome.accepted) acceptedSamples.push(completionSample)
    }
    if (acceptedSamples.length > 0) {
      inner.patchChatMeta(
        chatId,
        { tokenCalibration: staged.tokenCalibration },
        { touchVisibleState: false, broadcast: false },
      )
    }
  })

  // Step 2: roll up to global AFTER the chat mutation closes — separate
  // transaction on the settings table.
  for (const s of acceptedSamples) {
    await addSampleToGlobal(calibrationInputs.modelId, s.chars, s.tokens)
  }
}

function collectReasoning(acc: ChatAccumulator): ReasoningDetail[] {
  // Return in insertion order — the list already reflects the stream's
  // natural lane ordering, and per-row merges kept identity through stable
  // ids plus `findMergeTargetIndex` for legacy shapes.
  return acc.reasoningList.slice()
}

function putReasoningDetail(acc: ChatAccumulator, incoming: ReasoningDetail): void {
  if (incoming.id) {
    const existing = acc.reasoningRowById.get(incoming.id)
    if (existing !== undefined) {
      acc.reasoningList[existing] = mergeReasoningDetail(acc.reasoningList[existing], incoming)
      return
    }
  }
  const target = findMergeTargetIndex(acc.reasoningList, incoming)
  if (target >= 0) {
    acc.reasoningList[target] = mergeReasoningDetail(acc.reasoningList[target], incoming)
    if (incoming.id) acc.reasoningRowById.set(incoming.id, target)
    return
  }
  acc.reasoningList.push(incoming)
  if (incoming.id) acc.reasoningRowById.set(incoming.id, acc.reasoningList.length - 1)
}

function syntheticReasoningDetailId(
  type: ReasoningDetail['type'],
  event: Extract<StreamLaneEvent, { lane: 'reasoning' }>,
): string | undefined {
  if (type === 'reasoning.summary') {
    if (event.itemId) return `summary#${event.itemId}#${event.summaryIndex ?? 0}`
    if (event.summaryIndex !== undefined) {
      return event.outputIndex !== undefined
        ? `summary#${event.outputIndex}#${event.summaryIndex}`
        : `summary#${event.summaryIndex}`
    }
    return event.outputIndex !== undefined ? `summary#${event.outputIndex}` : 'summary#default'
  }
  if (event.itemId) {
    return type === 'reasoning.text' ? `text#${event.itemId}` : `encrypted#${event.itemId}`
  }
  if (event.outputIndex !== undefined) {
    return type === 'reasoning.text'
      ? `text#${event.outputIndex}`
      : `encrypted#${event.outputIndex}`
  }
  if (type === 'reasoning.text') return 'text#default'
  return 'encrypted#default'
}

function updatedGeneration(
  existing: GenerationMeta | undefined,
  acc: ChatAccumulator,
  requestedModel: string,
  opts: { apiUsed?: GenerationMeta['apiUsed']; finishedAt?: number },
): GenerationMeta {
  const base: GenerationMeta = existing
    ? { ...existing }
    : {
        id: '',
        model: requestedModel,
        requestedModel,
        apiUsed: 'chat',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: Date.now(),
      }
  if (opts.apiUsed !== undefined) base.apiUsed = opts.apiUsed
  if (acc.generationId) base.id = acc.generationId
  if (acc.model) base.model = acc.model
  if (acc.provider) base.provider = acc.provider
  if (acc.usage) base.usage = acc.usage
  if (acc.usage?.cost !== undefined) base.cost = acc.usage.cost
  const serverTools = mergeServerToolRecords([
    ...acc.serverTools,
    ...(acc.serverTools.length === 0 ? serverToolRecordsFromUsage(acc.usage) : []),
  ])
  if (serverTools.length > 0) base.serverTools = serverTools
  else delete base.serverTools
  if (acc.firstTextAt !== undefined) base.firstTextAt = acc.firstTextAt
  if (acc.reasoningStartedAt !== undefined) base.reasoningStartedAt = acc.reasoningStartedAt
  if (acc.reasoningFinishedAt !== undefined) base.reasoningFinishedAt = acc.reasoningFinishedAt
  if (acc.finishReason) base.finishReason = acc.finishReason as FinishReason
  if (opts.finishedAt !== undefined) base.finishedAt = opts.finishedAt
  return base
}

// Orphan sweep for interrupted streams. Called on app start from the shell
// (Phase 7: fired manually from tests, wired up in Phase 8). Any message
// whose `generation.startedAt` is set without a `finishedAt` is marked
// `abortReason: 'tab-close'` so the UI can render the "Stream interrupted"
// banner per `plan/03-storage.md §3.11.1`.
export async function recoverOrphans(now = Date.now(), chatId?: ChatId): Promise<number> {
  const repo = getBrowserRepository()
  const scopedChat = chatId !== undefined ? await repo.getChat(chatId) : undefined
  const chats = chatId !== undefined ? (scopedChat ? [scopedChat] : []) : await repo.listChats()
  const allLeases = await repo.listStreamLeases(chatId)
  const leases = allLeases.filter((lease) => isFreshStreamLease(lease, now))
  const leasedMessageIds = new Set(
    leases
      .filter((lease) => isFreshStreamLease(lease, now) && lease.messageId !== undefined)
      .map((lease) => lease.messageId as MessageId),
  )
  let recovered = 0
  for (const chat of chats) {
    const headers = await repo.listMessageHeaders(chat.id)
    for (const header of headers) {
      const gen = header.generation
      if (!gen || gen.finishedAt !== undefined || gen.abortReason !== undefined) continue
      if (now - gen.startedAt < STREAM_LEASE_TTL_MS) continue
      if (useStreamStore.getState().isTargetActive(chat.id, header.id)) continue
      if (leasedMessageIds.has(header.id)) continue
      const chunks = await repo.listStreamChunksForMessage(header.id)
      let wroteCanonical = false
      await repo.runMutation([{ kind: 'message', messageId: header.id }], async (ctx) => {
        const current = await ctx.getMessage(header.id)
        if (!current?.generation || current.generation.finishedAt !== undefined) return
        if (chunks.length === 0) {
          await ctx.putMessage({
            ...current,
            generation: {
              ...current.generation,
              finishedAt: now,
              abortReason: 'tab-close',
            },
          })
          wroteCanonical = true
          return
        }
        const recovered = replayStreamChunks(current, chunks, now)
        const generation = updatedGeneration(
          current.generation,
          recovered.accumulator,
          current.generation.requestedModel || current.generation.model,
          { apiUsed: current.generation.apiUsed, finishedAt: now },
        )
        if (!recovered.finishedCleanly) generation.abortReason = 'tab-close'
        if (recovered.accumulator.midStreamError) {
          generation.error = {
            code: String(recovered.accumulator.midStreamError.code),
            message: recovered.accumulator.midStreamError.message,
            ...(recovered.accumulator.midStreamError.httpStatus !== undefined
              ? { statusCode: recovered.accumulator.midStreamError.httpStatus }
              : {}),
            raw: recovered.accumulator.midStreamError,
          }
        }
        await ctx.patchMessageBody(
          header.id,
          {
            content: recovered.content,
            reasoningDetails: recovered.reasoning.length > 0 ? recovered.reasoning : undefined,
            phase: recovered.accumulator.phase,
          },
          {
            headerPatch: { generation },
            replaceBody: true,
          },
        )
        wroteCanonical = true
      })
      const streamIds = new Set(chunks.map((chunk) => chunk.streamId))
      for (const streamId of streamIds) {
        await repo.deleteStreamChunks(streamId)
        await repo.deleteStreamLease(streamId)
      }
      for (const lease of allLeases) {
        if (lease.messageId === header.id && !isFreshStreamLease(lease, now)) {
          await repo.deleteStreamLease(lease.streamId)
        }
      }
      if (wroteCanonical) recovered += 1
    }
  }
  return recovered
}

function replayStreamChunks(
  message: Message,
  chunks: readonly StreamChunkRow[],
  now: number,
): {
  accumulator: ChatAccumulator
  content: ContentItem[]
  reasoning: ReasoningDetail[]
  finishedCleanly: boolean
} {
  const accumulator = createAccumulator({
    initialContent: structuredClone(message.content),
    now,
  })
  let finishedCleanly = false
  for (const chunk of chunks) {
    const event = replayableStreamEvent(chunk.event)
    if (!event) continue
    applyEvent(accumulator, event, chunk.createdAt)
    if (event.lane === 'finish') finishedCleanly = true
  }
  const content = assistantContentWithStreamPrefix(
    accumulator.initialContent,
    streamTextSnapshot(accumulator),
    [...accumulator.generatedContent, ...audioOutputContent(accumulator)],
  )
  const reasoning = collectReasoning(accumulator)
  return { accumulator, content, reasoning, finishedCleanly }
}

function replayableStreamEvent(event: unknown): StreamLaneEvent | null {
  if (!event || typeof event !== 'object') return null
  const lane = (event as { lane?: unknown }).lane
  if (typeof lane !== 'string') return null
  switch (lane) {
    case 'text':
    case 'reasoning':
    case 'usage':
    case 'finish':
    case 'meta':
    case 'content-item':
    case 'audio-output':
    case 'server-tool':
    case 'server-tool-output':
    case 'output-item-added':
    case 'output-item-done':
    case 'phase':
    case 'error':
      return event as StreamLaneEvent
    default:
      return null
  }
}

interface UseChatApi {
  send: (input: Omit<SendTextInput, 'signal'>) => Promise<SendTextResult>
  sendFrom: (input: Omit<SendFromMessageInput, 'signal'>) => Promise<SendTextResult>
  abort: () => void
  isStreaming: () => boolean
}

export function useChat(): UseChatApi {
  const controllerRef = useRef<AbortController | null>(null)
  const streamIdRef = useRef<string | null>(null)

  const send = useCallback(async (input: Omit<SendTextInput, 'signal'>) => {
    const ctl = new AbortController()
    controllerRef.current = ctl
    try {
      const result = await sendText({ ...input, signal: ctl.signal })
      streamIdRef.current = result.streamId
      return result
    } finally {
      if (controllerRef.current === ctl) controllerRef.current = null
    }
  }, [])

  const sendFrom = useCallback(async (input: Omit<SendFromMessageInput, 'signal'>) => {
    const ctl = new AbortController()
    controllerRef.current = ctl
    try {
      const result = await sendFromMessage({ ...input, signal: ctl.signal })
      streamIdRef.current = result.streamId
      return result
    } finally {
      if (controllerRef.current === ctl) controllerRef.current = null
    }
  }, [])

  const abort = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort()
      return
    }
    const streamId = streamIdRef.current
    if (!streamId) return
    useStreamStore.getState().abortStream(streamId)
  }, [])

  const isStreaming = useCallback(() => controllerRef.current !== null, [])

  return { send, sendFrom, abort, isStreaming }
}

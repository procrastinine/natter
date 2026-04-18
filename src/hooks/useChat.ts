// Send pipeline for basic text chat. See `plan/06-streaming.md §6.1` and
// `plan/13-delivery.md §13.2.7`.
//
// Lifecycle (text-only Phase 7):
//   1. Persist the user message (via messages.sendUserMessage) and an assistant
//      placeholder (via continueAssistant-style append under the user) — both
//      rows are durable BEFORE the fetch opens (`plan/13 §13.2.2 first-token-latency`).
//   2. Compose the wire body from the active path via `toChatCompletions`.
//   3. Open the stream. Feed chunks through `splitChatStream` into an
//      in-memory accumulator (text / reasoning / tool-calls / usage / meta).
//   4. Periodically (every ~200ms or on 4KB text growth) flush the
//      accumulator into the placeholder row via the scoped mutation executor.
//      Cost / usage persist on the placeholder (turnIndex === 0 — Phase 7 has
//      no tool-result chain yet).
//   5. On stream end, write the final commit (content, reasoningDetails,
//      generation.usage/cost/finishReason/finishedAt). On error, attach
//      ApiError metadata. On user abort, attach abortReason='user'.
//
// The send function is written as a plain async function that lives outside
// React so integration tests can drive it without mounting a component. The
// `useChat` hook is a thin React wrapper that binds `streamStore` / `uiStore`
// callbacks; components call `sendText({chat, connection, ...})`.

import { useCallback, useRef } from 'react'
import { activePath, cursorKeyOf, groupByParent } from '../core/active-path'
import type { ChatCompletionsTransformOptions } from '../core/transforms'
import { toChatCompletions } from '../core/transforms'
import type {
  AbortReason,
  CapabilityDescriptor,
  ChatId,
  ChatUsage,
  ContentItem,
  ConnectionProfile,
  FinishReason,
  GenerationMeta,
  Message,
  MessageId,
  ReasoningDetail,
} from '../core/types'
import { newId } from '../lib/ulid'
import { chatCompletions } from '../api/chat-completions'
import { ApiError } from '../api/errors'
import {
  splitChatStream,
  type StreamLaneEvent,
} from '../api/stream-transforms'
import type { ChatStreamChunk } from '../api/types'
import { nextSiblingIndex } from '../core/tree-ops'
import { getBrowserRepository } from '../store/browser-repo'
import { postEvent } from '../store/broadcast'
import { getChat, loadChatMessages } from '../store/chats'
import { sendUserMessage } from '../core/messages'
import { useChatStore } from '../store/zustand/chatStore'
import { useStreamStore } from '../store/zustand/streamStore'

export const FLUSH_INTERVAL_MS = 200
export const FLUSH_TEXT_GROWTH_BYTES = 4096

// Per-stream mutable state. Mirrors the §6.2 `ActiveStream` fields that apply
// at the Phase 7 scope. Reasoning / tool-call reducers are in place so later
// phases can extend without changing the lifecycle.
interface ChatAccumulator {
  textBuffer: string
  reasoningByIndex: Map<number, ReasoningDetail>
  generationId?: string
  model?: string
  provider?: string
  finishReason?: string
  usage?: ChatUsage
  lastFlushedAt: number
  lastFlushedTextLen: number
  lastChunkReceivedAt: number
  midStreamError?: ApiError
}

export interface SendTextInput {
  chatId: ChatId
  connection: ConnectionProfile
  apiKey: string
  content: ContentItem[]
  capabilities?: CapabilityDescriptor
  transform?: Partial<ChatCompletionsTransformOptions>
  // Injection seam for integration tests that want to mock the stream
  // generator instead of `fetch`. The default opens a real chat-completions
  // call; tests pass a replacement iterable.
  openStream?: (input: OpenStreamInput) => AsyncIterable<ChatStreamChunk>
  signal?: AbortSignal
  now?: () => number
}

export interface OpenStreamInput {
  connection: ConnectionProfile
  apiKey: string
  wireBody: Record<string, unknown>
  signal: AbortSignal
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
  const repo = getBrowserRepository()
  const chat = await getChat(input.chatId)
  if (!chat) throw new Error(`sendText: chat not found: ${input.chatId}`)

  const cursor = useChatStore.getState().getCursor(input.chatId) ?? {}

  const userMsg = await sendUserMessage({
    chatId: input.chatId,
    cursor,
    content: input.content,
    now: now(),
  })
  useChatStore.getState().setCursor(input.chatId, {
    ...cursor,
    ...userMsg.effects.cursorUpdates,
  })

  const assistantId = newId()
  await repo.runMutation(
    [
      { kind: 'message', messageId: assistantId },
      { kind: 'children', chatId: input.chatId, parentId: userMsg.messageId },
    ],
    async (ctx) => {
      const all = await ctx.listMessages(input.chatId)
      await ctx.putMessage({
        id: assistantId,
        chatId: input.chatId,
        parentId: userMsg.messageId,
        siblingIndex: nextSiblingIndex(groupByParent(all), userMsg.messageId),
        turnId: newId(),
        turnIndex: 0,
        createdAt: now(),
        role: 'assistant',
        origin: 'generated',
        content: [],
        nodeVersion: 0,
        deleted: false,
        generation: {
          id: '',
          model: chat.settings.model,
          requestedModel: chat.settings.model,
          apiUsed: 'chat',
          delivery: 'streaming',
          costSource: 'stream',
          startedAt: now(),
        },
      })
    },
  )

  useChatStore.getState().patchCursor(
    input.chatId,
    cursorKeyOf(userMsg.messageId),
    assistantId,
  )

  const allMessages = await loadChatMessages(input.chatId)
  const nextCursor = {
    ...cursor,
    ...userMsg.effects.cursorUpdates,
    [cursorKeyOf(userMsg.messageId)]: assistantId,
  }
  const path = activePath(allMessages, nextCursor)

  const transformOpts: ChatCompletionsTransformOptions = {
    stream: true,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    ...(input.transform ?? {}),
  }
  const { wire, requestedModel } = toChatCompletions(
    chat.settings,
    path.filter((m) => m.id !== assistantId),
    transformOpts,
  )

  const streamId = newId()
  const abortController = new AbortController()
  const userSignal = input.signal
  if (userSignal?.aborted) abortController.abort(userSignal.reason)
  else userSignal?.addEventListener('abort', () => abortController.abort(userSignal.reason), { once: true })

  useStreamStore.getState().setActive({
    streamId,
    chatId: input.chatId,
    messageId: assistantId,
    startedAt: now(),
    ownerClientId: 'in-tab',
    textLen: 0,
  })
  postEvent({
    kind: 'stream-started',
    chatId: input.chatId,
    streamId,
    messageId: assistantId,
    ownerClientId: 'in-tab',
  })

  const accumulator: ChatAccumulator = {
    textBuffer: '',
    reasoningByIndex: new Map(),
    lastFlushedAt: now(),
    lastFlushedTextLen: 0,
    lastChunkReceivedAt: now(),
  }

  const openStream =
    input.openStream ??
    ((open) =>
      chatCompletions(
        { profile: open.connection, apiKey: open.apiKey },
        open.wireBody as Parameters<typeof chatCompletions>[1],
        { signal: open.signal },
      ))

  let outcome: 'done' | 'error' | 'abort' = 'done'
  let abortReason: AbortReason | undefined
  let streamError: ApiError | undefined

  try {
    const chunkIter = openStream({
      connection: input.connection,
      apiKey: input.apiKey,
      wireBody: wire as Record<string, unknown>,
      signal: abortController.signal,
    })
    for await (const event of splitChatStream(chunkIter)) {
      accumulator.lastChunkReceivedAt = now()
      applyEvent(accumulator, event)
      if (event.lane === 'error') {
        outcome = 'error'
        streamError = event.error
        break
      }
      if (shouldFlush(accumulator, now())) {
        await flushPartial({
          repo,
          chatId: input.chatId,
          streamId,
          messageId: assistantId,
          accumulator,
          requestedModel,
        })
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
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
    await finalize({
      repo,
      chatId: input.chatId,
      streamId,
      messageId: assistantId,
      accumulator,
      requestedModel,
      outcome,
      ...(abortReason ? { abortReason } : {}),
      ...(streamError ? { error: streamError } : {}),
      now: now(),
    })
    useStreamStore.getState().clearActive(streamId)
    postEvent({
      kind: 'stream-ended',
      chatId: input.chatId,
      streamId,
      messageId: assistantId,
      outcome,
    })
  }

  const result: SendTextResult = {
    streamId,
    userMessageId: userMsg.messageId,
    assistantMessageId: assistantId,
    outcome,
  }
  if (accumulator.finishReason) {
    result.finishReason = accumulator.finishReason as FinishReason
  }
  if (streamError) result.error = streamError
  return result
}

function applyEvent(acc: ChatAccumulator, event: StreamLaneEvent): void {
  switch (event.lane) {
    case 'text':
      acc.textBuffer += event.text
      return
    case 'reasoning': {
      // Phase-7 reasoning reducer preserves the lane so the persisted
      // placeholder carries whatever the provider emitted. Details reduce by
      // `index` per §5.3.
      if (Array.isArray(event.details)) {
        for (const raw of event.details) {
          if (!raw || typeof raw !== 'object') continue
          const detail = raw as ReasoningDetail & { index?: number }
          const idx = typeof detail.index === 'number' ? detail.index : 0
          const existing = acc.reasoningByIndex.get(idx)
          acc.reasoningByIndex.set(idx, mergeReasoning(existing, detail))
        }
      }
      if (event.textDelta !== undefined) {
        const existing = acc.reasoningByIndex.get(0)
        const next: ReasoningDetail =
          existing && existing.type === 'reasoning.text'
            ? { ...existing, text: (existing.text ?? '') + event.textDelta }
            : { type: 'reasoning.text', index: 0, text: event.textDelta }
        acc.reasoningByIndex.set(0, next)
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

function mergeReasoning(
  existing: ReasoningDetail | undefined,
  incoming: ReasoningDetail,
): ReasoningDetail {
  if (!existing) return incoming
  if (existing.type === 'reasoning.text' && incoming.type === 'reasoning.text') {
    return { ...existing, text: (existing.text ?? '') + (incoming.text ?? '') }
  }
  return incoming
}

function shouldFlush(acc: ChatAccumulator, nowMs: number): boolean {
  if (nowMs - acc.lastFlushedAt >= FLUSH_INTERVAL_MS) return true
  if (acc.textBuffer.length - acc.lastFlushedTextLen >= FLUSH_TEXT_GROWTH_BYTES) {
    return true
  }
  return false
}

interface FlushContext {
  repo: ReturnType<typeof getBrowserRepository>
  chatId: ChatId
  streamId: string
  messageId: MessageId
  accumulator: ChatAccumulator
  requestedModel: string
}

async function flushPartial(ctx: FlushContext): Promise<void> {
  const { repo, chatId, streamId, messageId, accumulator, requestedModel } = ctx
  await repo.runMutation(
    [{ kind: 'message', messageId }],
    async (inner) => {
      const current = await inner.getMessage(messageId)
      if (!current) return
      const reasoning = collectReasoning(accumulator)
      const next: Message = {
        ...current,
        content: [{ type: 'output_text', text: accumulator.textBuffer }],
      }
      if (reasoning.length > 0) next.reasoningDetails = reasoning
      next.generation = updatedGeneration(current.generation, accumulator, requestedModel, {})
      await inner.putMessage(next)
    },
  )
  accumulator.lastFlushedAt = Date.now()
  accumulator.lastFlushedTextLen = accumulator.textBuffer.length
  useStreamStore.getState().updateTextLen(streamId, accumulator.textBuffer.length)
  postEvent({
    kind: 'stream-tokens',
    chatId,
    streamId,
    messageId,
    textLen: accumulator.textBuffer.length,
  })
}

interface FinalizeContext extends FlushContext {
  outcome: 'done' | 'error' | 'abort'
  abortReason?: AbortReason
  error?: ApiError
  now: number
}

async function finalize(ctx: FinalizeContext): Promise<void> {
  const { repo, messageId, accumulator, requestedModel, outcome, abortReason, error, now } = ctx
  await repo.runMutation(
    [{ kind: 'message', messageId }],
    async (inner) => {
      const current = await inner.getMessage(messageId)
      if (!current) return
      const reasoning = collectReasoning(accumulator)
      const generation = updatedGeneration(current.generation, accumulator, requestedModel, {
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
          ...(finalError.httpStatus !== undefined
            ? { statusCode: finalError.httpStatus }
            : {}),
          raw: finalError,
        }
      }
      const next: Message = {
        ...current,
        content: [{ type: 'output_text', text: accumulator.textBuffer }],
        generation,
      }
      if (reasoning.length > 0) next.reasoningDetails = reasoning
      await inner.putMessage(next)
    },
  )
}

function collectReasoning(acc: ChatAccumulator): ReasoningDetail[] {
  return Array.from(acc.reasoningByIndex.entries())
    .sort(([a], [b]) => a - b)
    .map(([, value]) => value)
}

function updatedGeneration(
  existing: GenerationMeta | undefined,
  acc: ChatAccumulator,
  requestedModel: string,
  opts: { finishedAt?: number },
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
  if (acc.generationId) base.id = acc.generationId
  if (acc.model) base.model = acc.model
  if (acc.provider) base.provider = acc.provider
  if (acc.usage) base.usage = acc.usage
  if (acc.usage?.cost !== undefined) base.cost = acc.usage.cost
  if (acc.finishReason) base.finishReason = acc.finishReason as FinishReason
  if (opts.finishedAt !== undefined) base.finishedAt = opts.finishedAt
  return base
}

// Orphan sweep for interrupted streams. Called on app start from the shell
// (Phase 7: fired manually from tests, wired up in Phase 8). Any message
// whose `generation.startedAt` is set without a `finishedAt` is marked
// `abortReason: 'tab-close'` so the UI can render the "Stream interrupted"
// banner per `plan/03-storage.md §3.11.1`.
export async function recoverOrphans(now = Date.now()): Promise<number> {
  const repo = getBrowserRepository()
  const chats = await repo.listChats()
  let recovered = 0
  for (const chat of chats) {
    const messages = await repo.listMessages(chat.id)
    for (const message of messages) {
      const gen = message.generation
      if (!gen || gen.finishedAt !== undefined || gen.abortReason !== undefined) continue
      await repo.runMutation(
        [{ kind: 'message', messageId: message.id }],
        async (ctx) => {
          const current = await ctx.getMessage(message.id)
          if (!current?.generation || current.generation.finishedAt !== undefined) return
          await ctx.putMessage({
            ...current,
            generation: {
              ...current.generation,
              finishedAt: now,
              abortReason: 'tab-close',
            },
          })
        },
      )
      recovered += 1
    }
  }
  return recovered
}

export interface UseChatApi {
  send: (input: Omit<SendTextInput, 'signal'>) => Promise<SendTextResult>
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

  const abort = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const isStreaming = useCallback(() => controllerRef.current !== null, [])

  return { send, abort, isStreaming }
}

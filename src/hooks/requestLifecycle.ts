import { normalizeError } from '../api/errors'
import type { ChatId, GenerationMeta, MessageId } from '../core/types'
import { postEvent } from '../store/broadcast'
import type { StreamWriteFence } from '../store/repository'
import {
  announceStreamEnded,
  getStreamClientId,
  startStreamLease,
  stopStreamLease,
} from '../store/stream-leases'
import { useAnnouncementStore } from '../store/zustand/announcementStore'
import { useStreamStore } from '../store/zustand/streamStore'

interface RequestLifecycle {
  streamId: string
  signal: AbortSignal
  abort: () => void
  preserveLease: () => void
  end: (outcome: 'done' | 'error' | 'abort') => Promise<void>
}

export async function startRequestLifecycle(args: {
  chatId: ChatId
  streamId: string
  attemptKind: 'generation' | 'continuation'
  userSignal?: AbortSignal
}): Promise<RequestLifecycle> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let shouldPreserveLease = false
  let removeUserAbort: (() => void) | undefined
  const startedAt = Date.now()

  if (args.userSignal?.aborted) {
    controller.abort(args.userSignal.reason)
  } else if (args.userSignal) {
    const onAbort = () => controller.abort(args.userSignal?.reason)
    args.userSignal.addEventListener('abort', onAbort, { once: true })
    removeUserAbort = () => args.userSignal?.removeEventListener('abort', onAbort)
  }

  try {
    await startStreamLease({
      streamId: args.streamId,
      chatId: args.chatId,
      startedAt,
      attemptKind: args.attemptKind,
    })
  } catch (error) {
    removeUserAbort?.()
    await stopStreamLease(args.streamId)
    throw normalizeError(error, { midStream: false, cause: 'storage' })
  }

  useStreamStore.getState().setActive({
    streamId: args.streamId,
    chatId: args.chatId,
    startedAt,
    heartbeatAt: startedAt,
    ownerClientId: getStreamClientId(),
    abort,
  })
  postEvent({
    kind: 'stream-started',
    chatId: args.chatId,
    streamId: args.streamId,
    ownerClientId: getStreamClientId(),
  })

  return {
    streamId: args.streamId,
    signal: controller.signal,
    abort,
    preserveLease() {
      shouldPreserveLease = true
    },
    async end(outcome) {
      removeUserAbort?.()
      await stopStreamLease(args.streamId, { deleteRow: !shouldPreserveLease })
      if (!useStreamStore.getState().isActive(args.streamId)) return
      announceStreamEnded({
        chatId: args.chatId,
        streamId: args.streamId,
        outcome,
      })
    },
  }
}

export async function markLifecycleTarget(args: {
  chatId: ChatId
  streamId: string
  messageId: MessageId
  abort: () => void
  attemptKind?: 'generation' | 'continuation'
  continuationStrategy?: 'prompt' | 'prefill'
  baseNodeVersion?: number
  requestedModel?: string
  apiUsed?: GenerationMeta['apiUsed']
}): Promise<StreamWriteFence> {
  const startedAt = Date.now()
  const fence = await startStreamLease({
    streamId: args.streamId,
    chatId: args.chatId,
    messageId: args.messageId,
    startedAt,
    ...(args.attemptKind ? { attemptKind: args.attemptKind } : {}),
    ...(args.continuationStrategy ? { continuationStrategy: args.continuationStrategy } : {}),
    ...(args.baseNodeVersion !== undefined ? { baseNodeVersion: args.baseNodeVersion } : {}),
    ...(args.requestedModel ? { requestedModel: args.requestedModel } : {}),
    ...(args.apiUsed ? { apiUsed: args.apiUsed } : {}),
  })
  useStreamStore.getState().setActive({
    streamId: args.streamId,
    chatId: args.chatId,
    messageId: args.messageId,
    startedAt,
    heartbeatAt: startedAt,
    ownerClientId: getStreamClientId(),
    abort: args.abort,
  })
  postEvent({
    kind: 'stream-started',
    chatId: args.chatId,
    streamId: args.streamId,
    messageId: args.messageId,
    ownerClientId: getStreamClientId(),
  })
  useAnnouncementStore.getState().announce({
    text: 'Assistant is responding.',
    eventKey: `stream-start:${args.streamId}`,
  })
  return fence
}

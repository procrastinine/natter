import type { ChatId, MessageId } from '../core/types'
import { postEvent } from '../store/broadcast'
import { getStreamClientId, startStreamLease, stopStreamLease } from '../store/stream-leases'
import { useStreamStore } from '../store/zustand/streamStore'

export interface RequestLifecycle {
  streamId: string
  signal: AbortSignal
  end: (outcome: 'done' | 'error' | 'abort') => void
}

export function startRequestLifecycle(args: {
  chatId: ChatId
  streamId: string
  userSignal?: AbortSignal
}): RequestLifecycle {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let removeUserAbort: (() => void) | undefined

  if (args.userSignal?.aborted) {
    controller.abort(args.userSignal.reason)
  } else if (args.userSignal) {
    const onAbort = () => controller.abort(args.userSignal?.reason)
    args.userSignal.addEventListener('abort', onAbort, { once: true })
    removeUserAbort = () => args.userSignal?.removeEventListener('abort', onAbort)
  }

  useStreamStore.getState().setActive({
    streamId: args.streamId,
    chatId: args.chatId,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
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
    end(outcome) {
      removeUserAbort?.()
      stopStreamLease(args.streamId)
      if (!useStreamStore.getState().isActive(args.streamId)) return
      useStreamStore.getState().clearActive(args.streamId)
      postEvent({
        kind: 'stream-ended',
        chatId: args.chatId,
        streamId: args.streamId,
        outcome,
      })
    },
  }
}

export function markLifecycleTarget(args: {
  chatId: ChatId
  streamId: string
  messageId: MessageId
  abort: () => void
}): void {
  const startedAt = Date.now()
  useStreamStore.getState().setActive({
    streamId: args.streamId,
    chatId: args.chatId,
    messageId: args.messageId,
    startedAt,
    heartbeatAt: startedAt,
    ownerClientId: getStreamClientId(),
    abort: args.abort,
  })
  startStreamLease({
    streamId: args.streamId,
    chatId: args.chatId,
    messageId: args.messageId,
    startedAt,
  })
  postEvent({
    kind: 'stream-started',
    chatId: args.chatId,
    streamId: args.streamId,
    messageId: args.messageId,
    ownerClientId: getStreamClientId(),
  })
}

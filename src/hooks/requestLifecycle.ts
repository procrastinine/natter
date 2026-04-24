import type { ChatId, MessageId } from '../core/types'
import { postEvent } from '../store/broadcast'
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
    ownerClientId: 'in-tab',
    abort,
  })
  postEvent({
    kind: 'stream-started',
    chatId: args.chatId,
    streamId: args.streamId,
    ownerClientId: 'in-tab',
  })

  return {
    streamId: args.streamId,
    signal: controller.signal,
    end(outcome) {
      removeUserAbort?.()
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
  useStreamStore.getState().setActive({
    streamId: args.streamId,
    chatId: args.chatId,
    messageId: args.messageId,
    startedAt: Date.now(),
    ownerClientId: 'in-tab',
    abort: args.abort,
  })
  postEvent({
    kind: 'stream-started',
    chatId: args.chatId,
    streamId: args.streamId,
    messageId: args.messageId,
    ownerClientId: 'in-tab',
  })
}

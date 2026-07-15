import { useEffect } from 'react'
import type { Message } from '../core/types'
import {
  type ActiveStream,
  type LiveStreamSnapshot,
  useStreamTarget,
} from '../store/zustand/streamStore'

function streamAttemptCommitted(message: Message, stream: ActiveStream): boolean {
  if (stream.attemptKind === 'continuation') {
    return (
      message.continuationAttempts?.some((attempt) => attempt.streamId === stream.streamId) === true
    )
  }
  return message.generation?.status !== 'streaming' && message.generation?.finishedAt !== undefined
}

export function useMessageStreamProjection(message: Message, enabled = true) {
  const { activeStream, liveSnapshot } = useStreamTarget(message.chatId, message.id, enabled)
  const committed = activeStream ? streamAttemptCommitted(message, activeStream) : false
  useEffect(() => {
    if (!enabled || !activeStream || committed || !activeStream.requestLiveSnapshot) return
    const requestIfVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void activeStream.requestLiveSnapshot?.().catch(() => {})
    }
    requestIfVisible()
    if (typeof document === 'undefined') return
    document.addEventListener('visibilitychange', requestIfVisible)
    return () => document.removeEventListener('visibilitychange', requestIfVisible)
  }, [activeStream, committed, enabled])
  const currentLiveSnapshot: LiveStreamSnapshot | undefined =
    activeStream && liveSnapshot?.streamId === activeStream.streamId && !committed
      ? liveSnapshot
      : undefined
  return [activeStream, currentLiveSnapshot] as const
}

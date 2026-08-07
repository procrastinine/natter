import { useEffect } from 'react'
import type { Message } from '../core/types'
import { useAttemptTargetSnapshot } from '../store/attempt-controller'
import type {
  AttemptExecutionRecord,
  AttemptPresentationRecord,
  WorkspaceFence,
} from '../store/presentation-contracts'

export function useMessageStreamProjection(
  message: Message,
  fence: WorkspaceFence,
  enabled = true,
) {
  const target = useAttemptTargetSnapshot(message.chatId, message.id, enabled)
  const execution = attemptMatchesFence(target.execution, fence) ? target.execution : undefined
  const presentation = attemptMatchesFence(target.presentation, fence)
    ? target.presentation
    : undefined
  const liveProjection = liveProjectionMatchesFence(target.liveProjection, fence)
    ? target.liveProjection
    : undefined
  const currentLiveSnapshot =
    liveProjection &&
    (liveProjection.streamId === execution?.streamId ||
      liveProjection.streamId === presentation?.streamId)
      ? liveProjection
      : undefined
  useEffect(() => {
    if (!enabled || !execution?.requestLiveProjection) {
      return
    }
    const requestIfVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (currentLiveSnapshot) return
      void execution.requestLiveProjection?.().catch(() => {})
    }
    if (typeof document === 'undefined') return
    document.addEventListener('visibilitychange', requestIfVisible)
    return () => document.removeEventListener('visibilitychange', requestIfVisible)
  }, [currentLiveSnapshot, enabled, execution])
  return {
    execution,
    presentation,
    liveProjection: currentLiveSnapshot,
  } as const
}

function attemptMatchesFence(
  attempt: AttemptExecutionRecord | AttemptPresentationRecord | undefined,
  fence: WorkspaceFence,
): boolean {
  return Boolean(
    attempt &&
      attempt.workspaceId === fence.workspaceId &&
      attempt.replacementEpoch === fence.replacementEpoch,
  )
}

function liveProjectionMatchesFence(
  projection: ReturnType<typeof useAttemptTargetSnapshot>['liveProjection'],
  fence: WorkspaceFence,
): boolean {
  return Boolean(
    projection &&
      projection.workspaceId === fence.workspaceId &&
      projection.replacementEpoch === fence.replacementEpoch,
  )
}

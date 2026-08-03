import { useEffect, useSyncExternalStore } from 'react'
import type {
  PromptEstimateContextSnapshot,
  PromptEstimateContextTarget,
} from '../store/presentation-contracts'
import { promptEstimateContextWorkspace } from '../store/prompt-estimate-context-workspace'
import { useWorkspaceFence } from './useCatalogApplication'

interface PromptEstimateContextPublication {
  readonly targetKey: string
  readonly chatId: string
  readonly value: PromptEstimateContextSnapshot | null
}

export function selectPromptEstimateContextForTarget(
  target: Pick<PromptEstimateContextTarget, 'key' | 'chat'> | null,
  snapshot: PromptEstimateContextPublication | null,
): PromptEstimateContextSnapshot | null {
  return target && snapshot?.targetKey === target.key && snapshot.chatId === target.chat.id
    ? snapshot.value
    : null
}

export function usePromptEstimateContext(
  target: PromptEstimateContextTarget | null,
): PromptEstimateContextSnapshot | null {
  const fence = useWorkspaceFence()
  const controller = promptEstimateContextWorkspace.promptEstimate()
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useEffect(() => {
    if (!fence || !target) return
    return controller.request(fence, target)
  }, [controller, fence, target])
  return selectPromptEstimateContextForTarget(target, snapshot)
}

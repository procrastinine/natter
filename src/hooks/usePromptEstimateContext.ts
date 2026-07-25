import { useEffect, useSyncExternalStore } from 'react'
import type {
  PromptEstimateContextSnapshot,
  PromptEstimateContextTarget,
} from '../store/presentation-contracts'
import { promptEstimateContextWorkspace } from '../store/prompt-estimate-context-workspace'
import { useWorkspaceFence } from './useCatalogApplication'

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
  return target && snapshot?.chatId === target.chat.id ? snapshot.value : null
}

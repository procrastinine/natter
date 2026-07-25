import { useSyncExternalStore } from 'react'
import type {
  AttachmentSearchSessionController,
  AttachmentSearchSessionSnapshot,
} from '../store/presentation-contracts'

export function useAttachmentSearchSession(
  controller: AttachmentSearchSessionController,
): AttachmentSearchSessionSnapshot | null {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

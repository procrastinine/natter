import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AttachmentId } from '../../core/types'
import { errorFromUnknown } from '../../lib/error'
import {
  attachmentMessageMediaController,
  attachmentPreviewMediaController,
} from '../../store/attachment-catalog-workspace'
import type {
  AttachmentMediaProjection,
  AttachmentMediaPurpose,
  WorkspaceFence,
} from '../../store/presentation-contracts'

export interface AttachmentMediaSnapshot {
  readonly media: AttachmentMediaProjection | undefined
  readonly workspaceFence: WorkspaceFence | null
}

export function useAttachmentMedia(
  attachmentId: AttachmentId | undefined,
  purpose: AttachmentMediaPurpose,
): AttachmentMediaSnapshot {
  const controller =
    purpose === 'preview' ? attachmentPreviewMediaController : attachmentMessageMediaController
  const demand = useMemo(
    () => controller.demand(attachmentId ? [attachmentId] : []),
    [attachmentId, controller],
  )
  useEffect(() => () => demand.release(), [demand])
  const snapshot = useSyncExternalStore(demand.subscribe, demand.getSnapshot, demand.getSnapshot)
  const error = attachmentId ? snapshot.errorsById.get(attachmentId) : undefined
  if (error !== undefined) throw errorFromUnknown(error)
  return {
    media: attachmentId ? snapshot.rowsById.get(attachmentId) : undefined,
    workspaceFence: snapshot.workspaceFence,
  }
}

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { AttachmentId } from '../../core/types'
import { attachmentCatalogController } from '../../store/attachment-catalog-workspace'
import type {
  AttachmentCatalogRow,
  AttachmentDemandSnapshot,
} from '../../store/presentation-contracts'

const EMPTY_IDS: readonly AttachmentId[] = Object.freeze([])

export function useAttachmentCatalogRows(
  attachmentIds: readonly AttachmentId[],
): AttachmentDemandSnapshot<AttachmentCatalogRow> {
  const identity = JSON.stringify([...new Set(attachmentIds)])
  const ids = useMemo(() => JSON.parse(identity) as AttachmentId[], [identity])
  const demand = useMemo(
    () => attachmentCatalogController.demand(ids.length > 0 ? ids : EMPTY_IDS),
    [ids],
  )
  const snapshot = useSyncExternalStore(demand.subscribe, demand.getSnapshot, demand.getSnapshot)
  useEffect(() => () => demand.release(), [demand])
  return snapshot
}

import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { AttachmentBlob } from '../../core/types'
import {
  acquireAttachmentObjectUrl,
  attachmentObjectUrlGeneration,
  subscribeAttachmentObjectUrlGeneration,
} from '../../store/attachment-object-url'
import type { WorkspaceFence } from '../../store/presentation-contracts'

function blobIdentity(blob: AttachmentBlob): string {
  return JSON.stringify([blob.id, blob.contentHash, blob.sizeBytes, blob.mime])
}

export function useAttachmentObjectUrl(
  blob: AttachmentBlob | undefined,
  workspaceFence: WorkspaceFence | null | undefined,
): string | undefined {
  const generation = useSyncExternalStore(
    subscribeAttachmentObjectUrlGeneration,
    attachmentObjectUrlGeneration,
    attachmentObjectUrlGeneration,
  )
  const identity = useMemo(() => (blob ? blobIdentity(blob) : null), [blob])
  const workspaceId = workspaceFence?.workspaceId
  const replacementEpoch = workspaceFence?.replacementEpoch
  const fenceIdentity = workspaceId ? JSON.stringify([workspaceId, replacementEpoch]) : null
  const stableFence = useMemo(
    () =>
      workspaceId && replacementEpoch !== undefined
        ? Object.freeze({ workspaceId, replacementEpoch })
        : null,
    [replacementEpoch, workspaceId],
  )
  const leaseIdentity =
    identity === null || fenceIdentity === null
      ? null
      : `${generation}:${fenceIdentity}:${identity}`
  const [leased, setLeased] = useState<{ identity: string; url: string } | null>(null)
  useLayoutEffect(() => {
    if (!blob || !leaseIdentity) {
      setLeased(null)
      return
    }
    const lease = acquireAttachmentObjectUrl(blob, stableFence)
    setLeased(lease ? { identity: leaseIdentity, url: lease.url } : null)
    return () => lease?.release()
  }, [blob, leaseIdentity, stableFence])
  return leased?.identity === leaseIdentity ? leased.url : undefined
}

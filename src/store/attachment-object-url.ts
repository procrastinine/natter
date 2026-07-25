import type { AttachmentBlob } from '../core/types'
import type { WorkspaceFence } from './repository'

export interface WorkspaceObjectUrlLease {
  readonly url: string
  release(): void
}

interface ObjectUrlEntry {
  readonly url: string
  readonly generation: number
  refCount: number
}

const activeObjectUrls = new Map<string, ObjectUrlEntry>()
const generationListeners = new Set<() => void>()
let generation = 0
let acceptedWorkspaceFence: WorkspaceFence | null = null

function blobIdentity(blob: AttachmentBlob): string {
  return JSON.stringify([blob.id, blob.contentHash, blob.sizeBytes, blob.mime])
}

export function acquireAttachmentObjectUrl(
  blob: AttachmentBlob,
  workspaceFence: WorkspaceFence | null | undefined,
): WorkspaceObjectUrlLease | undefined {
  if (!workspaceFence || !sameWorkspaceFence(acceptedWorkspaceFence, workspaceFence)) {
    return undefined
  }
  if (!(blob.blob instanceof Blob) || typeof URL.createObjectURL !== 'function') return undefined
  const key = JSON.stringify([
    workspaceFence.workspaceId,
    workspaceFence.replacementEpoch,
    blobIdentity(blob),
  ])
  let entry = activeObjectUrls.get(key)
  if (!entry) {
    entry = { url: URL.createObjectURL(blob.blob), generation, refCount: 0 }
    activeObjectUrls.set(key, entry)
  }
  entry.refCount += 1
  let active = true
  return {
    url: entry.url,
    release() {
      if (!active) return
      active = false
      if (entry.generation !== generation || activeObjectUrls.get(key) !== entry) return
      entry.refCount -= 1
      if (entry.refCount > 0) return
      activeObjectUrls.delete(key)
      URL.revokeObjectURL(entry.url)
    },
  }
}

export function reconcileAttachmentObjectUrlWorkspace(fence: WorkspaceFence): void {
  if (sameWorkspaceFence(acceptedWorkspaceFence, fence)) return
  acceptedWorkspaceFence = Object.freeze({ ...fence })
  clearAttachmentObjectUrls()
}

export function disposeAttachmentObjectUrlWorkspace(): void {
  if (acceptedWorkspaceFence === null && activeObjectUrls.size === 0) return
  acceptedWorkspaceFence = null
  clearAttachmentObjectUrls()
}

function clearAttachmentObjectUrls(): void {
  generation += 1
  for (const entry of activeObjectUrls.values()) URL.revokeObjectURL(entry.url)
  activeObjectUrls.clear()
  for (const listener of [...generationListeners]) listener()
}

export function attachmentObjectUrlGeneration(): number {
  return generation
}

export function subscribeAttachmentObjectUrlGeneration(listener: () => void): () => void {
  generationListeners.add(listener)
  return () => generationListeners.delete(listener)
}

function sameWorkspaceFence(left: WorkspaceFence | null, right: WorkspaceFence): boolean {
  return (
    left !== null &&
    left.workspaceId === right.workspaceId &&
    left.replacementEpoch === right.replacementEpoch
  )
}

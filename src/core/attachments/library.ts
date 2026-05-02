import { processAttachment } from './process'
import type {
  AttachmentRecord,
  AttachmentSearchQuery,
  MessageAttachmentRef,
  ProcessAttachmentInput,
  ProcessAttachmentResult,
} from './types'

interface CreateAttachmentRefInput {
  attachmentId: string
  refId?: string
  messageId?: string
  draftChatId?: string
  includeInContext?: boolean
  now?: number
}

interface AttachmentLibrarySnapshot {
  attachments: ProcessAttachmentResult[]
  refs: MessageAttachmentRef[]
}

export class AttachmentLibrary {
  private readonly results = new Map<string, ProcessAttachmentResult>()
  private readonly refs = new Map<string, MessageAttachmentRef>()

  constructor(snapshot?: AttachmentLibrarySnapshot) {
    if (!snapshot) return
    for (const result of snapshot.attachments)
      this.results.set(result.attachment.id, cloneResult(result))
    for (const ref of snapshot.refs) this.refs.set(ref.refId, { ...ref })
  }

  async ingest(input: ProcessAttachmentInput): Promise<ProcessAttachmentResult> {
    return this.put(await processAttachment(input))
  }

  put(result: ProcessAttachmentResult): ProcessAttachmentResult {
    const stored = cloneResult(result)
    const existing = this.results.get(stored.attachment.id)
    const refCount = existing?.attachment.refCount ?? 0
    this.results.set(stored.attachment.id, {
      ...stored,
      attachment: { ...stored.attachment, refCount },
    })
    this.refreshRefsForAttachment(stored.attachment.id)
    return this.get(stored.attachment.id) ?? stored
  }

  get(attachmentId: string): ProcessAttachmentResult | undefined {
    const result = this.results.get(attachmentId)
    return result ? cloneResult(result) : undefined
  }

  getRef(refId: string): MessageAttachmentRef | undefined {
    const ref = this.refs.get(refId)
    return ref ? { ...ref } : undefined
  }

  snapshot(): AttachmentLibrarySnapshot {
    return {
      attachments: Array.from(this.results.values(), cloneResult),
      refs: Array.from(this.refs.values(), (ref) => ({ ...ref })),
    }
  }

  searchAttachments(query: AttachmentSearchQuery = {}): ProcessAttachmentResult[] {
    const needle = query.query?.trim().toLowerCase()
    const terms = needle ? needle.split(/\s+/) : []
    const filtered = Array.from(this.results.values()).filter((result) => {
      const attachment = result.attachment
      if (query.filters?.kind && attachment.kind !== query.filters.kind) return false
      if (query.filters?.mime && attachment.mime !== query.filters.mime) return false
      if (query.filters?.origin && attachment.origin !== query.filters.origin) return false
      if (query.filters?.storageState && attachment.storageState !== query.filters.storageState) {
        return false
      }
      if (
        query.filters?.minSizeBytes !== undefined &&
        (attachment.sizeBytes ?? 0) < query.filters.minSizeBytes
      ) {
        return false
      }
      if (
        query.filters?.maxSizeBytes !== undefined &&
        (attachment.sizeBytes ?? 0) > query.filters.maxSizeBytes
      ) {
        return false
      }
      if (
        query.filters?.minRefCount !== undefined &&
        attachment.refCount < query.filters.minRefCount
      ) {
        return false
      }
      if (
        query.filters?.maxRefCount !== undefined &&
        attachment.refCount > query.filters.maxRefCount
      ) {
        return false
      }
      if (terms.length === 0) return true
      const haystack = searchableText(result)
      return terms.every((term) => haystack.includes(term))
    })

    filtered.sort(sorter(query.sort ?? 'created-desc'))
    return filtered.slice(0, query.limit ?? filtered.length).map(cloneResult)
  }

  addExistingRef(input: CreateAttachmentRefInput): MessageAttachmentRef {
    const result = requireResult(this.results, input.attachmentId)
    const now = input.now ?? Date.now()
    const ref: MessageAttachmentRef = {
      refId: input.refId ?? newRefId(),
      attachmentId: input.attachmentId,
      includeInContext: input.includeInContext ?? true,
      tokenEstimate:
        result.attachment.storageState === 'missing' ? 0 : Math.max(0, result.tokenEstimate),
      filenameSnapshot: result.attachment.filename,
      kindSnapshot: result.attachment.kind,
      storageStateSnapshot: result.attachment.storageState,
      createdAt: now,
      updatedAt: now,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.draftChatId ? { draftChatId: input.draftChatId } : {}),
    }
    if (this.refs.has(ref.refId)) throw new Error(`attachment ref already exists: ${ref.refId}`)
    this.refs.set(ref.refId, ref)
    this.bumpRefCount(input.attachmentId, 1)
    return { ...ref }
  }

  deleteRef(refId: string): void {
    const existing = this.refs.get(refId)
    if (!existing) return
    this.refs.delete(refId)
    this.bumpRefCount(existing.attachmentId, -1)
  }

  setRefVisibility(
    refId: string,
    includeInContext: boolean,
    now = Date.now(),
  ): MessageAttachmentRef {
    const ref = requireRef(this.refs, refId)
    const updated = { ...ref, includeInContext, updatedAt: now }
    this.refs.set(refId, updated)
    return { ...updated }
  }

  relinkRef(refId: string, attachmentId: string, now = Date.now()): MessageAttachmentRef {
    const ref = requireRef(this.refs, refId)
    const target = requireResult(this.results, attachmentId)
    if (ref.attachmentId !== attachmentId) {
      this.bumpRefCount(ref.attachmentId, -1)
      this.bumpRefCount(attachmentId, 1)
    }
    const updated = {
      ...ref,
      attachmentId,
      filenameSnapshot: target.attachment.filename,
      kindSnapshot: target.attachment.kind,
      storageStateSnapshot: target.attachment.storageState,
      tokenEstimate: target.attachment.storageState === 'missing' ? 0 : target.tokenEstimate,
      updatedAt: now,
    }
    this.refs.set(refId, updated)
    return { ...updated }
  }

  markObjectBytesDeleted(attachmentId: string, now = Date.now()): ProcessAttachmentResult {
    const result = requireResult(this.results, attachmentId)
    const updated = {
      ...result,
      attachment: {
        ...result.attachment,
        storageState: 'missing' as const,
        updatedAt: now,
      },
    }
    this.results.set(attachmentId, updated)
    this.refreshRefsForAttachment(attachmentId)
    return cloneResult(updated)
  }

  deleteObject(attachmentId: string, now = Date.now()): 'removed' | 'marked-missing' {
    const result = requireResult(this.results, attachmentId)
    if (result.attachment.refCount > 0) {
      this.markObjectBytesDeleted(attachmentId, now)
      return 'marked-missing'
    }
    this.results.delete(attachmentId)
    return 'removed'
  }

  rehydrateMissingObject(
    attachmentId: string,
    replacement: ProcessAttachmentResult,
    now = Date.now(),
  ): ProcessAttachmentResult {
    const existing = requireResult(this.results, attachmentId)
    const rekeyed = rekeyResult(replacement, attachmentId)
    const updated = {
      ...rekeyed,
      attachment: {
        ...rekeyed.attachment,
        id: attachmentId,
        createdAt: existing.attachment.createdAt,
        updatedAt: now,
        refCount: existing.attachment.refCount,
      },
    }
    this.results.set(attachmentId, updated)
    this.refreshRefsForAttachment(attachmentId)
    return cloneResult(updated)
  }

  refEffectiveTokenEstimate(refId: string): number {
    const ref = requireRef(this.refs, refId)
    if (!ref.includeInContext || ref.storageStateSnapshot === 'missing') return 0
    return ref.tokenEstimate
  }

  contextForRefs(refIds: string[]): ProcessAttachmentResult[] {
    return refIds.flatMap((refId) => {
      const ref = this.refs.get(refId)
      if (!ref?.includeInContext || ref.storageStateSnapshot === 'missing') return []
      const result = this.results.get(ref.attachmentId)
      if (!result || result.attachment.storageState === 'missing') return []
      return [cloneResult(result)]
    })
  }

  effectiveTokenEstimateForRefs(refIds: string[]): number {
    return refIds.reduce((sum, refId) => sum + this.refEffectiveTokenEstimate(refId), 0)
  }

  missingRefs(refIds: string[]): MessageAttachmentRef[] {
    return refIds.flatMap((refId) => {
      const ref = this.refs.get(refId)
      if (!ref || ref.storageStateSnapshot !== 'missing') return []
      return [{ ...ref }]
    })
  }

  private bumpRefCount(attachmentId: string, delta: number): void {
    const result = this.results.get(attachmentId)
    if (!result) return
    const refCount = Math.max(0, result.attachment.refCount + delta)
    this.results.set(attachmentId, {
      ...result,
      attachment: { ...result.attachment, refCount },
    })
  }

  private refreshRefsForAttachment(attachmentId: string): void {
    const result = this.results.get(attachmentId)
    if (!result) return
    for (const ref of this.refs.values()) {
      if (ref.attachmentId !== attachmentId) continue
      this.refs.set(ref.refId, snapshotRef(ref, result))
    }
  }
}

function snapshotRef(
  ref: MessageAttachmentRef,
  result: ProcessAttachmentResult,
): MessageAttachmentRef {
  return {
    ...ref,
    filenameSnapshot: result.attachment.filename,
    kindSnapshot: result.attachment.kind,
    storageStateSnapshot: result.attachment.storageState,
    tokenEstimate: result.attachment.storageState === 'missing' ? 0 : result.tokenEstimate,
    updatedAt: result.attachment.updatedAt,
  }
}

function searchableText(result: ProcessAttachmentResult): string {
  const attachment = result.attachment
  return [
    attachment.id,
    attachment.contentHash,
    attachment.kind,
    attachment.mime,
    attachment.filename,
    attachment.extension,
    attachment.origin,
    attachment.sourceUrl,
    attachment.storageState,
    ...attachment.processorLabels,
    ...result.artifacts.flatMap((artifact) => [
      artifact.id,
      artifact.kind,
      artifact.processorId,
      artifact.label,
      artifact.text,
      artifact.metadata ? JSON.stringify(artifact.metadata) : undefined,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase()
}

function sorter(
  sort: NonNullable<AttachmentSearchQuery['sort']>,
): (left: ProcessAttachmentResult, right: ProcessAttachmentResult) => number {
  if (sort === 'created-asc') {
    return (left, right) => left.attachment.createdAt - right.attachment.createdAt
  }
  if (sort === 'size-desc') {
    return (left, right) => (right.attachment.sizeBytes ?? 0) - (left.attachment.sizeBytes ?? 0)
  }
  if (sort === 'size-asc') {
    return (left, right) => (left.attachment.sizeBytes ?? 0) - (right.attachment.sizeBytes ?? 0)
  }
  return (left, right) => right.attachment.createdAt - left.attachment.createdAt
}

function cloneResult(result: ProcessAttachmentResult): ProcessAttachmentResult {
  return {
    ...result,
    attachment: cloneAttachment(result.attachment),
    artifacts: result.artifacts.map(cloneArtifact),
    processing: result.processing.map((state) => ({ ...state })),
    openRouter: {
      ...result.openRouter,
      requiredProcessors: [...result.openRouter.requiredProcessors],
    },
  }
}

function cloneAttachment(attachment: AttachmentRecord): AttachmentRecord {
  return {
    ...attachment,
    processorLabels: [...attachment.processorLabels],
    ...(attachment.dimensions ? { dimensions: { ...attachment.dimensions } } : {}),
  }
}

function cloneArtifact(artifact: ProcessAttachmentResult['artifacts'][number]) {
  return {
    ...artifact,
    ...(artifact.metadata ? { metadata: { ...artifact.metadata } } : {}),
  }
}

function rekeyResult(
  result: ProcessAttachmentResult,
  attachmentId: string,
): ProcessAttachmentResult {
  const previousId = result.attachment.id
  return {
    ...cloneResult(result),
    attachment: { ...cloneAttachment(result.attachment), id: attachmentId },
    artifacts: result.artifacts.map((artifact) => ({
      ...cloneArtifact(artifact),
      id: artifact.id.startsWith(`${previousId}:`)
        ? `${attachmentId}:${artifact.id.slice(previousId.length + 1)}`
        : artifact.id,
      attachmentId,
    })),
  }
}

function requireResult(
  results: ReadonlyMap<string, ProcessAttachmentResult>,
  attachmentId: string,
): ProcessAttachmentResult {
  const result = results.get(attachmentId)
  if (!result) throw new Error(`attachment not found: ${attachmentId}`)
  return result
}

function requireRef(
  refs: ReadonlyMap<string, MessageAttachmentRef>,
  refId: string,
): MessageAttachmentRef {
  const ref = refs.get(refId)
  if (!ref) throw new Error(`attachment ref not found: ${refId}`)
  return ref
}

function newRefId(): string {
  return globalThis.crypto.randomUUID()
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createAttachmentRef, normalizeAttachmentRefs } from '../../core/attachment-refs'
import type { Attachment, AttachmentRef, MessageAttachmentRef } from '../../core/types'
import { newId } from '../../lib/ulid'
import { ingestAttachmentBytes } from '../../store/attachment-application'
import type { AttachmentDisplayRow } from './format'
import { useAttachmentCatalogRows } from './useAttachmentCatalogRows'

export interface AttachmentUploadItem {
  id: string
  filename: string
  sizeBytes: number
  state: 'uploading' | 'failed'
  error?: string
}

export function useAttachmentDrafts(initialRefs?: readonly AttachmentRef[]) {
  const initialRefsRef = useRef<MessageAttachmentRef[]>(
    normalizeAttachmentRefs(initialRefs, { createdAt: 0 }),
  )
  const [attachmentRefs, setAttachmentRefs] = useState<MessageAttachmentRef[]>(
    initialRefsRef.current,
  )
  const attachmentRefsRef = useRef(attachmentRefs)
  const scopeVersionRef = useRef(0)
  const [optimisticRows, setOptimisticRows] = useState<Map<string, AttachmentDisplayRow>>(
    () => new Map(),
  )
  const [uploads, setUploads] = useState<AttachmentUploadItem[]>([])
  const attachmentIds = useMemo(
    () => [...new Set(attachmentRefs.map((ref) => ref.attachmentId))],
    [attachmentRefs],
  )
  const catalog = useAttachmentCatalogRows(attachmentIds)
  const attachmentRows = useMemo(() => {
    const rows = new Map<string, AttachmentDisplayRow>()
    for (const attachmentId of attachmentIds) {
      const row = catalog.rowsById.get(attachmentId) ?? optimisticRows.get(attachmentId)
      if (row) rows.set(attachmentId, row)
    }
    return rows
  }, [attachmentIds, catalog.rowsById, optimisticRows])

  useEffect(() => {
    setOptimisticRows((current) => {
      let next: Map<string, AttachmentDisplayRow> | null = null
      const demanded = new Set(attachmentIds)
      for (const attachmentId of current.keys()) {
        if (demanded.has(attachmentId) && !catalog.rowsById.has(attachmentId)) continue
        next ??= new Map(current)
        next.delete(attachmentId)
      }
      return next ?? current
    })
  }, [attachmentIds, catalog.rowsById])

  const addAttachment = useCallback((attachment: Attachment) => {
    setOptimisticRows((current) => {
      const next = new Map(current)
      next.set(attachment.id, attachment)
      return next
    })
    const next = [...attachmentRefsRef.current, createAttachmentRef(attachment.id)]
    attachmentRefsRef.current = next
    setAttachmentRefs(next)
  }, [])

  const replaceAttachment = useCallback((refId: string, attachment: Attachment) => {
    setOptimisticRows((current) => {
      const next = new Map(current)
      next.set(attachment.id, attachment)
      return next
    })
    const updatedAt = Date.now()
    const next = attachmentRefsRef.current.map((ref) =>
      ref.refId === refId ? { ...ref, attachmentId: attachment.id, updatedAt } : ref,
    )
    attachmentRefsRef.current = next
    setAttachmentRefs(next)
  }, [])

  const toggleAttachment = useCallback((refId: string) => {
    const updatedAt = Date.now()
    const next = attachmentRefsRef.current.map((ref) =>
      ref.refId === refId ? { ...ref, includeInContext: !ref.includeInContext, updatedAt } : ref,
    )
    attachmentRefsRef.current = next
    setAttachmentRefs(next)
  }, [])

  const removeAttachment = useCallback((refId: string) => {
    const next = attachmentRefsRef.current.filter((ref) => ref.refId !== refId)
    attachmentRefsRef.current = next
    setAttachmentRefs(next)
  }, [])

  const ingestFiles = useCallback(
    async (rawFiles: FileList | File[]) => {
      const files = Array.from(rawFiles)
      if (files.length === 0) return
      const scopeVersion = scopeVersionRef.current
      for (const file of files) {
        const uploadId = newId()
        setUploads((current) => [
          ...current,
          { id: uploadId, filename: file.name, sizeBytes: file.size, state: 'uploading' },
        ])
        try {
          const bundle = await ingestAttachmentBytes({
            blob: file,
            filename: file.name,
            origin: 'user-upload',
            ...(file.type ? { declaredMime: file.type } : {}),
          })
          if (scopeVersion === scopeVersionRef.current) addAttachment(bundle.attachment)
          setUploads((current) => current.filter((upload) => upload.id !== uploadId))
        } catch (err) {
          setUploads((current) =>
            current.map((upload) =>
              upload.id === uploadId
                ? {
                    ...upload,
                    state: 'failed',
                    error: err instanceof Error ? err.message : 'Upload failed',
                  }
                : upload,
            ),
          )
        }
      }
    },
    [addAttachment],
  )

  const dismissUpload = useCallback((uploadId: string) => {
    setUploads((current) => current.filter((upload) => upload.id !== uploadId))
  }, [])

  const clear = useCallback(() => {
    scopeVersionRef.current += 1
    attachmentRefsRef.current = []
    setAttachmentRefs(attachmentRefsRef.current)
    setOptimisticRows(new Map())
    setUploads([])
  }, [])

  const consume = useCallback((refs: readonly MessageAttachmentRef[]) => {
    const submitted = new Set(refs)
    const next = attachmentRefsRef.current.filter((ref) => !submitted.has(ref))
    attachmentRefsRef.current = next
    setAttachmentRefs(next)
  }, [])

  const restore = useCallback(
    (refs: readonly MessageAttachmentRef[], rows?: Map<string, AttachmentDisplayRow>) => {
      scopeVersionRef.current += 1
      attachmentRefsRef.current = [...refs]
      setAttachmentRefs(attachmentRefsRef.current)
      setOptimisticRows(rows ? new Map(rows) : new Map())
      setUploads([])
    },
    [],
  )

  const currentAttachmentRefs = useCallback(() => attachmentRefsRef.current, [])

  return {
    initialAttachmentRefs: initialRefsRef.current,
    attachmentRefs,
    currentAttachmentRefs,
    attachmentRows,
    uploads,
    addAttachment,
    replaceAttachment,
    toggleAttachment,
    removeAttachment,
    ingestFiles,
    dismissUpload,
    clear,
    consume,
    restore,
  }
}

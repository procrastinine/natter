import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment, AttachmentRef, MessageAttachmentRef } from '../../core/types'
import { newId } from '../../lib/ulid'
import { createAttachmentRef, normalizeAttachmentRefs } from '../../store/attachment-refs'
import { ingestAttachmentBytes } from '../../store/attachments'
import { getWorkspaceRepository } from '../../store/workspace-repository'

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
  const [attachmentRows, setAttachmentRows] = useState<Map<string, Attachment>>(() => new Map())
  const [uploads, setUploads] = useState<AttachmentUploadItem[]>([])

  useEffect(() => {
    let cancelled = false
    const ids = [...new Set(attachmentRefs.map((ref) => ref.attachmentId))]
    if (ids.length === 0) return
    void Promise.all(
      ids.map(async (id) => [id, await getWorkspaceRepository().getAttachment(id)] as const),
    )
      .then((rows) => {
        if (cancelled) return
        setAttachmentRows((current) => {
          const next = new Map(current)
          for (const [id, row] of rows) {
            if (row) next.set(id, row)
          }
          return next
        })
      })
      .catch((err) => console.error('attachment metadata load failed', err))
    return () => {
      cancelled = true
    }
  }, [attachmentRefs])

  const addAttachment = useCallback((attachment: Attachment) => {
    setAttachmentRows((current) => {
      const next = new Map(current)
      next.set(attachment.id, attachment)
      return next
    })
    setAttachmentRefs((current) => [...current, createAttachmentRef(attachment.id)])
  }, [])

  const replaceAttachment = useCallback((refId: string, attachment: Attachment) => {
    setAttachmentRows((current) => {
      const next = new Map(current)
      next.set(attachment.id, attachment)
      return next
    })
    setAttachmentRefs((current) =>
      current.map((ref) =>
        ref.refId === refId ? { ...ref, attachmentId: attachment.id, updatedAt: Date.now() } : ref,
      ),
    )
  }, [])

  const toggleAttachment = useCallback((refId: string) => {
    setAttachmentRefs((current) =>
      current.map((ref) =>
        ref.refId === refId
          ? { ...ref, includeInContext: !ref.includeInContext, updatedAt: Date.now() }
          : ref,
      ),
    )
  }, [])

  const removeAttachment = useCallback((refId: string) => {
    setAttachmentRefs((current) => current.filter((ref) => ref.refId !== refId))
  }, [])

  const ingestFiles = useCallback(
    async (rawFiles: FileList | File[]) => {
      const files = Array.from(rawFiles)
      if (files.length === 0) return
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
          addAttachment(bundle.attachment)
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
    setAttachmentRefs([])
    setAttachmentRows(new Map())
    setUploads([])
  }, [])

  const restore = useCallback(
    (refs: readonly MessageAttachmentRef[], rows?: Map<string, Attachment>) => {
      setAttachmentRefs([...refs])
      setAttachmentRows(rows ? new Map(rows) : new Map())
      setUploads([])
    },
    [],
  )

  return {
    initialAttachmentRefs: initialRefsRef.current,
    attachmentRefs,
    attachmentRows,
    uploads,
    addAttachment,
    replaceAttachment,
    toggleAttachment,
    removeAttachment,
    ingestFiles,
    dismissUpload,
    clear,
    restore,
  }
}

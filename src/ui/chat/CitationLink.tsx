import type { MouseEvent, ReactNode } from 'react'
import type { AttachmentId, ContentAnnotation } from '../../core/types'
import { getAttachmentMedia } from '../../store/attachment-application'

type RenderableCitation = Exclude<ContentAnnotation, { type: 'unknown' }>

interface CitationLinkProps {
  annotation: RenderableCitation
  children?: ReactNode
  onOpenAttachment?: (attachmentId: AttachmentId) => void | Promise<void>
}

export function CitationLink({ annotation, children, onOpenAttachment }: CitationLinkProps) {
  if (annotation.type === 'url_citation') {
    return (
      <a
        data-ui="citation-link"
        data-citation-kind="url"
        href={annotation.url}
        title={annotation.title}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children ?? annotation.title ?? annotation.url}
      </a>
    )
  }
  const identity = annotation.file
  const attachmentId = identity.kind === 'attachment' ? identity.attachmentId : undefined
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    if (!attachmentId) return
    void (onOpenAttachment ?? openCitationAttachment)(attachmentId)
  }
  const label = annotation.filename ?? annotation.title ?? fileIdentityLabel(identity)
  return (
    <a
      data-ui="citation-link"
      data-citation-kind="file"
      data-file-identity={identity.kind}
      {...(attachmentId ? { 'data-attachment-id': attachmentId } : {})}
      href={`#citation-file-${encodeURIComponent(label)}`}
      title={fileCitationTitle(annotation)}
      aria-disabled={attachmentId ? undefined : true}
      onClick={onClick}
    >
      {children ?? label}
    </a>
  )
}

async function openCitationAttachment(attachmentId: AttachmentId): Promise<void> {
  const media = await getAttachmentMedia(attachmentId, 'preview')
  if (!media || typeof document === 'undefined') return
  const storage = media.attachment.storage
  let href: string | undefined
  let revoke = false
  if (storage.kind === 'remote-url') href = storage.url
  else if (storage.kind === 'local-blob' && media.blob) {
    href = URL.createObjectURL(media.blob.blob)
    revoke = true
  }
  if (!href) return
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.download = media.attachment.filename
  anchor.click()
  if (revoke) {
    const objectUrl = href
    queueMicrotask(() => URL.revokeObjectURL(objectUrl))
  }
}

function fileIdentityLabel(
  identity: Extract<RenderableCitation, { type: 'file_citation' }>['file'],
): string {
  if (identity.kind === 'attachment') return identity.attachmentId
  if (identity.kind === 'provider-file') return identity.fileId
  if (identity.kind === 'document') return `Document ${identity.documentIndex + 1}`
  return 'Cited file'
}

function fileCitationTitle(
  annotation: Extract<RenderableCitation, { type: 'file_citation' }>,
): string {
  if (annotation.file.kind === 'attachment') {
    return annotation.title ?? annotation.filename ?? 'Open cited attachment'
  }
  if (annotation.file.kind === 'provider-file') {
    return annotation.title ?? annotation.filename ?? 'Provider file reference'
  }
  return annotation.title ?? annotation.filename ?? 'File citation'
}

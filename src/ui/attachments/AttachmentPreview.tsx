import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import type { Attachment, AttachmentBlob } from '../../core/types'
import { getBrowserRepository } from '../../store/browser-repo'
import type { AttachmentBundle } from '../../store/repository'
import { FileIcon } from '../icons/Icon'

type AttachmentPreviewVariant = 'chip' | 'card' | 'panel'

export function AttachmentPreview({
  attachment,
  bundle,
  variant = 'chip',
}: {
  attachment: Attachment | undefined
  bundle?: AttachmentBundle | undefined
  variant?: AttachmentPreviewVariant
}) {
  const needsBundle = Boolean(attachment && !bundle && canPreviewFromBundle(attachment))
  const liveBundle = useLiveQuery(
    async () => {
      if (!attachment || !needsBundle) return undefined
      return getBrowserRepository().getAttachmentBundle(attachment.id)
    },
    [attachment?.id, needsBundle],
    undefined,
  )
  const resolvedBundle = bundle ?? liveBundle
  const blob = useMemo(
    () => (attachment ? selectPreviewBlob(attachment, resolvedBundle, variant) : undefined),
    [attachment, resolvedBundle, variant],
  )
  const [objectUrl, setObjectUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!blob) {
      setObjectUrl(undefined)
      return
    }
    if (!(blob.blob instanceof Blob) || typeof URL.createObjectURL !== 'function') {
      setObjectUrl(undefined)
      return
    }
    const url = URL.createObjectURL(blob.blob)
    setObjectUrl(url)
    return () => URL.revokeObjectURL?.(url)
  }, [blob])

  const src = objectUrl ?? remotePreviewUrl(attachment)
  const mime = blob?.mime ?? attachment?.mime ?? ''
  const textArtifact = useMemo(
    () => resolvedBundle?.artifacts.find((artifact) => artifact.kind === 'text'),
    [resolvedBundle],
  )

  if (attachment && src && isImageAttachment(attachment, mime)) {
    return (
      <span data-ui="attachment-preview" data-variant={variant}>
        <img src={src} alt={variant === 'panel' ? attachment.filename : ''} loading="lazy" />
      </span>
    )
  }

  if (variant === 'panel' && attachment && src && isAudioAttachment(attachment, mime)) {
    return (
      <span data-ui="attachment-preview" data-variant="panel" data-media="audio">
        {/* biome-ignore lint/a11y/useMediaCaption: local attachment previews do not have authored caption tracks. */}
        <audio controls src={src} preload="metadata" />
      </span>
    )
  }

  if (variant === 'panel' && attachment && src && isVideoAttachment(attachment, mime)) {
    return (
      <span data-ui="attachment-preview" data-variant="panel" data-media="video">
        {/* biome-ignore lint/a11y/useMediaCaption: local attachment previews do not have authored caption tracks. */}
        <video controls src={src} preload="metadata" />
      </span>
    )
  }

  if (variant === 'panel' && attachment && src && isPdfAttachment(attachment, mime)) {
    return (
      <span data-ui="attachment-preview" data-variant="panel" data-media="pdf">
        <object data={src} type="application/pdf" aria-label={attachment.filename}>
          <a href={src} target="_blank" rel="noreferrer">
            Open PDF
          </a>
        </object>
      </span>
    )
  }

  if (variant === 'panel' && attachment && textArtifact) {
    const text = textArtifact.text.trim()
    return (
      <span data-ui="attachment-preview" data-variant="panel" data-media="text">
        <pre>{text.length > 6000 ? `${text.slice(0, 6000)}\n...` : text}</pre>
      </span>
    )
  }

  if (variant !== 'panel' && textArtifact && attachment && isTextAttachment(attachment, mime)) {
    return (
      <span data-ui="attachment-preview" data-variant={variant} data-media="text-mini">
        <span>{attachment.kind === 'code' ? '{}' : 'TXT'}</span>
      </span>
    )
  }

  return (
    <span data-ui="attachment-preview" data-variant={variant} data-empty="true">
      <FileIcon size={variant === 'panel' ? 24 : 14} />
    </span>
  )
}

function canPreviewFromBundle(attachment: Attachment): boolean {
  if (attachment.storage.kind === 'missing') return false
  return (
    attachment.kind === 'image' ||
    attachment.kind === 'audio' ||
    attachment.kind === 'video' ||
    attachment.kind === 'pdf' ||
    attachment.kind === 'plaintext' ||
    attachment.kind === 'code'
  )
}

function selectPreviewBlob(
  attachment: Attachment,
  bundle: AttachmentBundle | undefined,
  variant: AttachmentPreviewVariant,
): AttachmentBlob | undefined {
  if (!bundle) return undefined
  if (variant === 'panel' && attachment.kind !== 'image') {
    return (
      bundle.blobs.find((row) => row.role === 'original') ??
      bundle.blobs.find((row) => row.role === 'normalized') ??
      bundle.blobs[0]
    )
  }
  if (attachment.thumbnailBlobId) {
    const thumbnail = bundle.blobs.find((row) => row.id === attachment.thumbnailBlobId)
    if (thumbnail) return thumbnail
  }
  const imageSized = bundle.blobs.find(
    (row) => row.role === 'thumbnail' || row.role === 'image-resize',
  )
  if (imageSized) return imageSized
  return (
    bundle.blobs.find((row) => row.role === 'original') ??
    bundle.blobs.find((row) => row.role === 'normalized') ??
    bundle.blobs[0]
  )
}

function remotePreviewUrl(attachment: Attachment | undefined): string | undefined {
  if (!attachment) return undefined
  if (attachment.storage.kind === 'remote-url') return attachment.storage.url
  return attachment.sourceUrl
}

function isImageAttachment(attachment: Attachment, mime: string): boolean {
  return attachment.kind === 'image' || mime.startsWith('image/')
}

function isAudioAttachment(attachment: Attachment, mime: string): boolean {
  return attachment.kind === 'audio' || mime.startsWith('audio/')
}

function isVideoAttachment(attachment: Attachment, mime: string): boolean {
  return attachment.kind === 'video' || mime.startsWith('video/')
}

function isPdfAttachment(attachment: Attachment, mime: string): boolean {
  return attachment.kind === 'pdf' || mime === 'application/pdf'
}

function isTextAttachment(attachment: Attachment, mime: string): boolean {
  return attachment.kind === 'plaintext' || attachment.kind === 'code' || mime.startsWith('text/')
}

import { useMemo } from 'react'
import type { AttachmentBlob } from '../../core/types'
import type { AttachmentBundle, WorkspaceFence } from '../../store/presentation-contracts'
import { FileIcon } from '../icons/Icon'
import type { AttachmentDisplayRow } from './format'
import { useAttachmentMedia } from './useAttachmentMedia'
import { useAttachmentObjectUrl } from './useAttachmentObjectUrl'

type AttachmentPreviewVariant = 'chip' | 'card' | 'panel'

export function AttachmentPreview({
  attachment,
  bundle,
  bundleWorkspaceFence,
  textPreview,
  variant = 'chip',
}: {
  attachment: AttachmentDisplayRow | undefined
  bundle?: AttachmentBundle | undefined
  bundleWorkspaceFence?: WorkspaceFence | null | undefined
  textPreview?: string | undefined
  variant?: AttachmentPreviewVariant
}) {
  const needsMedia = Boolean(attachment && !bundle && canPreviewFromMedia(attachment))
  const liveMedia = useAttachmentMedia(needsMedia ? attachment?.id : undefined, 'preview')
  const blob = useMemo(
    () =>
      attachment
        ? bundle
          ? selectPreviewBlob(attachment, bundle, variant)
          : liveMedia.media?.blob
        : undefined,
    [attachment, bundle, liveMedia.media, variant],
  )
  const objectUrl = useAttachmentObjectUrl(
    blob,
    bundle ? bundleWorkspaceFence : liveMedia.workspaceFence,
  )

  const src = objectUrl ?? remotePreviewUrl(attachment)
  const mime = blob?.mime ?? attachment?.mime ?? ''
  const textArtifact = useMemo(
    () => bundle?.artifacts.find((artifact) => artifact.kind === 'text'),
    [bundle],
  )
  const previewText = textPreview ?? textArtifact?.text

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

  if (variant === 'panel' && attachment && previewText) {
    const text = previewText.trim()
    return (
      <span data-ui="attachment-preview" data-variant="panel" data-media="text">
        <pre>{text.length > 6000 ? `${text.slice(0, 6000)}\n...` : text}</pre>
      </span>
    )
  }

  if (variant !== 'panel' && attachment && isTextAttachment(attachment, mime)) {
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

function canPreviewFromMedia(attachment: AttachmentDisplayRow): boolean {
  if (attachment.storage.kind === 'missing') return false
  return (
    attachment.kind === 'image' ||
    attachment.kind === 'audio' ||
    attachment.kind === 'video' ||
    attachment.kind === 'pdf'
  )
}

function selectPreviewBlob(
  attachment: AttachmentDisplayRow,
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

function remotePreviewUrl(attachment: AttachmentDisplayRow | undefined): string | undefined {
  if (!attachment) return undefined
  if (attachment.storage.kind === 'remote-url') return attachment.storage.url
  return undefined
}

function isImageAttachment(attachment: AttachmentDisplayRow, mime: string): boolean {
  return attachment.kind === 'image' || mime.startsWith('image/')
}

function isAudioAttachment(attachment: AttachmentDisplayRow, mime: string): boolean {
  return attachment.kind === 'audio' || mime.startsWith('audio/')
}

function isVideoAttachment(attachment: AttachmentDisplayRow, mime: string): boolean {
  return attachment.kind === 'video' || mime.startsWith('video/')
}

function isPdfAttachment(attachment: AttachmentDisplayRow, mime: string): boolean {
  return attachment.kind === 'pdf' || mime === 'application/pdf'
}

function isTextAttachment(attachment: AttachmentDisplayRow, mime: string): boolean {
  return attachment.kind === 'plaintext' || attachment.kind === 'code' || mime.startsWith('text/')
}

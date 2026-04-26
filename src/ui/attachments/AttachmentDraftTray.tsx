import { useState } from 'react'
import type { Attachment, MessageAttachmentRef } from '../../core/types'
import { attachmentHref, makeAnchorClickHandler } from '../../app/router'
import { CloseIcon, DatabaseIcon, EyeIcon, EyeOffIcon, TrashIcon, UploadIcon } from '../icons/Icon'
import { AttachmentPicker } from './AttachmentPicker'
import { AttachmentPreview } from './AttachmentPreview'
import { formatBytes, kindLabel, shortId, storageLabel } from './format'
import type { AttachmentUploadItem } from './useAttachmentDrafts'

export function AttachmentDraftTray({
  refs,
  attachments,
  uploads,
  disabled,
  onToggle,
  onRemove,
  onReplace,
  onDismissUpload,
}: {
  refs: readonly MessageAttachmentRef[]
  attachments: Map<string, Attachment>
  uploads: readonly AttachmentUploadItem[]
  disabled?: boolean | undefined
  onToggle: (refId: string) => void
  onRemove: (refId: string) => void
  onReplace: (refId: string, attachment: Attachment) => void
  onDismissUpload: (uploadId: string) => void
}) {
  const [replaceRefId, setReplaceRefId] = useState<string | null>(null)
  if (refs.length === 0 && uploads.length === 0) return null
  return (
    <div data-ui="attachment-draft-tray">
      {uploads.map((upload) => (
        <span
          key={upload.id}
          data-ui="attachment-file-card"
          data-state={upload.state}
          data-storage="uploading"
        >
          <span data-ui="attachment-file-main">
            <UploadIcon size={16} />
            <span data-ui="attachment-file-copy">
              <span data-ui="attachment-file-name">{upload.filename}</span>
              <span data-ui="attachment-file-meta">
                {upload.state === 'uploading'
                  ? `Uploading · ${formatBytes(upload.sizeBytes)}`
                  : (upload.error ?? 'Upload failed')}
              </span>
            </span>
          </span>
          {upload.state === 'failed' ? (
            <span data-ui="attachment-file-actions">
              <button
                type="button"
                data-ui="icon-button"
                data-size="xs"
                onClick={() => onDismissUpload(upload.id)}
                aria-label="Dismiss failed upload"
                title="Dismiss failed upload"
              >
                <CloseIcon size={13} />
              </button>
            </span>
          ) : null}
        </span>
      ))}
      {refs.map((ref) => {
        const attachment = attachments.get(ref.attachmentId)
        const href = attachmentHref(ref.attachmentId)
        return (
          <span
            key={ref.refId}
            data-ui="attachment-file-card"
            data-kind={attachment?.kind ?? 'other'}
            data-storage={attachment ? storageLabel(attachment) : 'missing'}
            data-context={ref.includeInContext ? 'included' : 'excluded'}
          >
            <a
              href={href}
              onClick={makeAnchorClickHandler(href)}
              data-ui="attachment-file-main"
              title={attachment ? `${attachment.id}\n${attachment.mime}` : ref.attachmentId}
            >
              <AttachmentPreview attachment={attachment} variant="card" />
              <span data-ui="attachment-file-copy">
                <span data-ui="attachment-file-name">
                  {attachment?.filename ?? `Stored ${shortId(ref.attachmentId)}`}
                </span>
                <span data-ui="attachment-file-meta">
                  {attachment
                    ? `${kindLabel(attachment.kind)} · ${formatBytes(attachment.sizeBytes)}`
                    : shortId(ref.attachmentId)}
                </span>
              </span>
            </a>
            <span data-ui="attachment-file-actions">
              <button
                type="button"
                data-ui="icon-button"
                data-size="xs"
                aria-label={
                  ref.includeInContext
                    ? 'Hide attachment from context'
                    : 'Include attachment in context'
                }
                title={
                  ref.includeInContext
                    ? 'Hide this attachment from future context'
                    : 'Include this attachment in future context'
                }
                onClick={() => onToggle(ref.refId)}
                disabled={disabled}
              >
                {ref.includeInContext ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
              </button>
              <button
                type="button"
                data-ui="icon-button"
                data-size="xs"
                aria-label="Relink attachment"
                title="Relink this reference to another stored attachment"
                onClick={() => setReplaceRefId(ref.refId)}
                disabled={disabled}
              >
                <DatabaseIcon size={13} />
              </button>
              <button
                type="button"
                data-ui="icon-button"
                data-size="xs"
                aria-label="Remove attachment"
                title="Detach from this draft"
                onClick={() => onRemove(ref.refId)}
                disabled={disabled}
              >
                <TrashIcon size={13} />
              </button>
            </span>
          </span>
        )
      })}
      {replaceRefId ? (
        <AttachmentPicker
          title="Relink attachment"
          onClose={() => setReplaceRefId(null)}
          onPick={(attachment) => {
            onReplace(replaceRefId, attachment)
            setReplaceRefId(null)
          }}
        />
      ) : null}
    </div>
  )
}

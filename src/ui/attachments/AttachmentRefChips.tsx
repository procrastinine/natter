import { useLiveQuery } from 'dexie-react-hooks'
import { useState } from 'react'
import { attachmentHref, makeAnchorClickHandler } from '../../app/router'
import type { AttachmentRef, ChatId, MessageId } from '../../core/types'
import { liveAttachmentRefs } from '../../store/attachment-refs'
import {
  detachAttachmentRef,
  relinkAttachmentRef,
  setAttachmentRefVisibility,
} from '../../store/attachments'
import { getBrowserRepository } from '../../store/browser-repo'
import { DatabaseIcon, EyeIcon, EyeOffIcon, TrashIcon } from '../icons/Icon'
import { AttachmentPicker } from './AttachmentPicker'
import { AttachmentPreview } from './AttachmentPreview'
import { formatBytes, kindLabel, shortId, storageLabel } from './format'

interface AttachmentRefChipsProps {
  refs: readonly AttachmentRef[] | undefined
  messageId?: MessageId
  draftChatId?: ChatId
  editable?: boolean
}

export function AttachmentRefChips({
  refs,
  messageId,
  draftChatId,
  editable = true,
}: AttachmentRefChipsProps) {
  const liveRefs = liveAttachmentRefs(refs)
  const attachmentIds = liveRefs.map((ref) => ref.attachmentId).join('|')
  const attachments = useLiveQuery(
    async () => {
      const repo = getBrowserRepository()
      const entries = await Promise.all(
        liveRefs.map(
          async (ref) => [ref.attachmentId, await repo.getAttachment(ref.attachmentId)] as const,
        ),
      )
      return new Map(entries)
    },
    [attachmentIds],
    undefined,
  )
  const [replaceRefId, setReplaceRefId] = useState<string | null>(null)
  if (liveRefs.length === 0) return null
  if (!attachments) return null
  const visibleRefs = liveRefs.filter(
    (ref) => attachments.get(ref.attachmentId)?.origin !== 'generated-output',
  )
  if (visibleRefs.length === 0) return null

  return (
    <div data-ui="attachment-chip-row">
      {visibleRefs.map((ref) => {
        const attachment = attachments.get(ref.attachmentId)
        const missing = attachment?.storage.kind === 'missing'
        const href = attachmentHref(ref.attachmentId)
        return (
          <span
            key={ref.refId}
            data-ui="attachment-chip"
            data-kind={attachment?.kind ?? 'other'}
            data-storage={attachment ? storageLabel(attachment) : 'missing'}
            data-context={ref.includeInContext ? 'included' : 'excluded'}
          >
            <a
              href={href}
              onClick={makeAnchorClickHandler(href)}
              data-ui="attachment-chip-main"
              title={attachment ? `${attachment.id}\n${attachment.mime}` : ref.attachmentId}
            >
              <AttachmentPreview attachment={attachment} variant="chip" />
              <span data-ui="attachment-chip-name">
                {attachment?.filename ?? `Missing ${shortId(ref.attachmentId)}`}
              </span>
              <span data-ui="attachment-chip-meta">
                {attachment
                  ? `${kindLabel(attachment.kind)} · ${formatBytes(attachment.sizeBytes)}`
                  : 'missing'}
              </span>
            </a>
            {missing ? <span data-ui="attachment-chip-state">missing</span> : null}
            {editable ? (
              <span data-ui="attachment-chip-actions">
                <button
                  type="button"
                  data-ui="icon-button"
                  data-size="xs"
                  aria-pressed={ref.includeInContext}
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
                  onClick={() =>
                    void setAttachmentRefVisibility({
                      ...(messageId ? { messageId } : { draftChatId: draftChatId as ChatId }),
                      refId: ref.refId,
                      includeInContext: !ref.includeInContext,
                    })
                  }
                  disabled={!messageId && !draftChatId}
                >
                  {ref.includeInContext ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
                </button>
                <button
                  type="button"
                  data-ui="icon-button"
                  data-size="xs"
                  aria-label="Relink attachment reference"
                  title="Relink this reference to another stored attachment"
                  onClick={() => setReplaceRefId(ref.refId)}
                  disabled={!messageId && !draftChatId}
                >
                  <DatabaseIcon size={13} />
                </button>
                <button
                  type="button"
                  data-ui="icon-button"
                  data-size="xs"
                  aria-label="Detach attachment from this message"
                  title="Detach from this message; stored file remains"
                  onClick={() =>
                    void detachAttachmentRef({
                      ...(messageId ? { messageId } : { draftChatId: draftChatId as ChatId }),
                      refId: ref.refId,
                    })
                  }
                  disabled={!messageId && !draftChatId}
                >
                  <TrashIcon size={13} />
                </button>
              </span>
            ) : null}
          </span>
        )
      })}
      {replaceRefId ? (
        <AttachmentPicker
          title="Relink reference"
          onClose={() => setReplaceRefId(null)}
          onPick={async (attachment) => {
            await relinkAttachmentRef({
              ...(messageId ? { messageId } : { draftChatId: draftChatId as ChatId }),
              refId: replaceRefId,
              newAttachmentId: attachment.id,
            })
            setReplaceRefId(null)
          }}
        />
      ) : null}
    </div>
  )
}

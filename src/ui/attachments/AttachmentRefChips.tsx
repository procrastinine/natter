import { useEffect, useState } from 'react'
import {
  attachmentMutationInteraction,
  attachmentMutationTarget,
} from '../../app/presentation-interactions'
import { attachmentHref, makeAnchorClickHandler } from '../../app/router'
import { liveAttachmentRefs } from '../../core/attachment-refs'
import type { AttachmentRef, ChatId, MessageId } from '../../core/types'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import {
  detachAttachmentRef,
  relinkAttachmentRef,
  setAttachmentRefVisibility,
} from '../../store/attachment-application'
import type { MessageAttachmentRefMutation } from '../../store/presentation-contracts'
import { DatabaseIcon, EyeIcon, EyeOffIcon, TrashIcon } from '../icons/Icon'
import { IconButton } from '../primitives/Button'
import { AttachmentPicker } from './AttachmentPicker'
import { AttachmentPreview } from './AttachmentPreview'
import { formatBytes, kindLabel, shortId, storageLabel } from './format'
import { useAttachmentCatalogRows } from './useAttachmentCatalogRows'

interface AttachmentRefChipsProps {
  refs: readonly AttachmentRef[] | undefined
  messageId?: MessageId
  draftChatId?: ChatId
  editable?: boolean
  onMutateMessageRef?: (mutation: MessageAttachmentRefMutation) => void | Promise<void>
}

export function AttachmentRefChips({
  refs,
  messageId,
  draftChatId,
  editable = true,
  onMutateMessageRef,
}: AttachmentRefChipsProps) {
  const liveRefs = liveAttachmentRefs(refs)
  const attachments = useAttachmentCatalogRows(liveRefs.map((ref) => ref.attachmentId))
  const [replaceRefId, setReplaceRefId] = useState<string | null>(null)
  const mutationInteraction = usePresentationInteraction(attachmentMutationInteraction)
  useEffect(() => {
    if (!attachments.interactive) setReplaceRefId(null)
  }, [attachments.interactive])
  if (liveRefs.length === 0) return null
  if (attachments.status === 'loading') return null
  const visibleRefs = liveRefs.filter(
    (ref) => attachments.rowsById.get(ref.attachmentId)?.origin !== 'generated-output',
  )
  if (visibleRefs.length === 0) return null

  return (
    <div data-ui="attachment-chip-row" data-inert={!attachments.interactive || undefined}>
      {visibleRefs.map((ref) => {
        const attachment = attachments.rowsById.get(ref.attachmentId)
        const missing = attachment?.storage.kind === 'missing'
        const href = attachmentHref(ref.attachmentId)
        const mutationTarget = attachmentMutationTarget({
          refId: ref.refId,
          ...(messageId ? { messageId } : { draftChatId: draftChatId as ChatId }),
        })
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
              aria-disabled={!attachments.interactive || undefined}
              tabIndex={attachments.interactive ? undefined : -1}
              onClick={
                attachments.interactive
                  ? makeAnchorClickHandler(href)
                  : (event) => event.preventDefault()
              }
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
                <IconButton
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
                  onClick={() => {
                    mutationInteraction.run({
                      target: mutationTarget,
                      action: async () => {
                        if (messageId) {
                          return onMutateMessageRef?.({
                            kind: 'visibility',
                            refId: ref.refId,
                            includeInContext: !ref.includeInContext,
                          })
                        }
                        await setAttachmentRefVisibility({
                          draftChatId: draftChatId as ChatId,
                          refId: ref.refId,
                          includeInContext: !ref.includeInContext,
                        })
                      },
                    })
                  }}
                  disabled={
                    mutationInteraction.isPending(mutationTarget) ||
                    !attachments.interactive ||
                    (messageId ? !onMutateMessageRef : !draftChatId)
                  }
                >
                  {ref.includeInContext ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
                </IconButton>
                <IconButton
                  type="button"
                  data-ui="icon-button"
                  data-size="xs"
                  aria-label="Relink attachment reference"
                  title="Relink this reference to another stored attachment"
                  onClick={() => setReplaceRefId(ref.refId)}
                  disabled={
                    !attachments.interactive || (messageId ? !onMutateMessageRef : !draftChatId)
                  }
                >
                  <DatabaseIcon size={13} />
                </IconButton>
                <IconButton
                  type="button"
                  data-ui="icon-button"
                  data-size="xs"
                  aria-label="Detach attachment from this message"
                  title="Detach from this message; stored file remains"
                  onClick={() => {
                    mutationInteraction.run({
                      target: mutationTarget,
                      action: async () => {
                        if (messageId) {
                          return onMutateMessageRef?.({ kind: 'detach', refId: ref.refId })
                        }
                        await detachAttachmentRef({
                          draftChatId: draftChatId as ChatId,
                          refId: ref.refId,
                        })
                      },
                    })
                  }}
                  disabled={
                    mutationInteraction.isPending(mutationTarget) ||
                    !attachments.interactive ||
                    (messageId ? !onMutateMessageRef : !draftChatId)
                  }
                >
                  <TrashIcon size={13} />
                </IconButton>
              </span>
            ) : null}
          </span>
        )
      })}
      {replaceRefId && attachments.interactive ? (
        <AttachmentPicker
          sessionSurface="picker-message-reference"
          title="Relink reference"
          onClose={() => setReplaceRefId(null)}
          interactionTarget={attachmentMutationTarget({
            refId: replaceRefId,
            ...(messageId ? { messageId } : { draftChatId: draftChatId as ChatId }),
          })}
          onPick={async (attachment) => {
            if (messageId) {
              await onMutateMessageRef?.({
                kind: 'relink',
                refId: replaceRefId,
                newAttachmentId: attachment.id,
              })
              return
            }
            await relinkAttachmentRef({
              draftChatId: draftChatId as ChatId,
              refId: replaceRefId,
              newAttachmentId: attachment.id,
            })
          }}
        />
      ) : null}
    </div>
  )
}

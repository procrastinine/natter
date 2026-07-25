import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import {
  attachmentMutationInteraction,
  definePresentationInteraction,
} from '../../app/presentation-interactions'
import type { Attachment, AttachmentKind } from '../../core/types'
import { useAttachmentSearchSession } from '../../hooks/useAttachmentSearchSession'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { getAttachment } from '../../store/attachment-application'
import { catalogSessionWorkspace } from '../../store/catalog-session-workspace'
import type { AttachmentSearchSurface } from '../../store/presentation-contracts'
import {
  getWorkspaceTabSessionSnapshot,
  subscribeWorkspaceTabSession,
} from '../../store/workspace-tab-session'
import { CloseIcon, DatabaseIcon, SearchIcon } from '../icons/Icon'
import { Button, IconButton } from '../primitives/Button'
import { Dialog } from '../primitives/Dialog'
import { formatBytes, kindLabel, shortId, storageLabel } from './format'

interface AttachmentPickerProps {
  sessionSurface: Exclude<AttachmentSearchSurface, 'storage-manager'>
  title?: string
  excludeAttachmentId?: string
  interactionTarget?: string
  onPick: (attachment: Attachment) => void | Promise<void>
  onClose: () => void
}

const KIND_FILTERS: Array<AttachmentKind | 'all'> = [
  'all',
  'image',
  'pdf',
  'audio',
  'video',
  'document',
  'spreadsheet',
  'presentation',
  'code',
  'plaintext',
  'other',
]

const attachmentPickerInteraction = definePresentationInteraction<string>({
  id: 'attachment-picker.pick',
  label: 'Select attachment',
  concurrency: 'reject',
  lifetime: 'presenter',
})

export function AttachmentPicker({
  sessionSurface,
  title = 'Stored attachments',
  excludeAttachmentId,
  interactionTarget,
  onPick,
  onClose,
}: AttachmentPickerProps) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<AttachmentKind | 'all'>('all')
  const pickInteraction = usePresentationInteraction(
    interactionTarget ? attachmentMutationInteraction : attachmentPickerInteraction,
  )
  const pickTarget = interactionTarget ?? 'picker'
  const searchController = catalogSessionWorkspace.attachmentSearchFor(sessionSurface)
  const searchSession = useAttachmentSearchSession(searchController)
  const workspaceSession = useSyncExternalStore(
    subscribeWorkspaceTabSession,
    getWorkspaceTabSessionSnapshot,
    getWorkspaceTabSessionSnapshot,
  )

  const filters = useMemo(() => (kind === 'all' ? undefined : { kind }), [kind])
  const rows = useMemo(
    () =>
      excludeAttachmentId
        ? (searchSession?.rows ?? []).filter((row) => row.id !== excludeAttachmentId)
        : (searchSession?.rows ?? []),
    [excludeAttachmentId, searchSession?.rows],
  )

  useEffect(() => {
    const fence = workspaceSession.fence
    if (!fence) return
    const normalizedQuery = query.trim()
    return searchController.request({
      ...fence,
      search: {
        ...(normalizedQuery ? { query: normalizedQuery } : {}),
        ...(filters ? { filters } : {}),
        sort: 'created-desc',
      },
      pageSize: 80,
    })
  }, [filters, query, searchController, workspaceSession.fence])
  if (searchSession?.status === 'error' && rows.length === 0) throw searchSession.error

  return (
    <Dialog
      onClose={onClose}
      overlayUi="attachment-picker-backdrop"
      scrimUi="attachment-picker-scrim"
      surfaceUi="attachment-picker"
      surfaceAs="section"
      ariaLabel={title}
      scrimLabel="Close attachment picker"
      backdrop="light"
      closeOnScrim={false}
    >
      <header data-ui="attachment-picker-header">
        <span data-ui="attachment-picker-title">
          <DatabaseIcon size={15} />
          {title}
        </span>
        <IconButton
          type="button"
          data-ui="icon-button"
          data-compact
          onClick={onClose}
          aria-label="Close attachment picker"
          title="Close"
        >
          <CloseIcon size={15} />
        </IconButton>
      </header>
      <div data-ui="attachment-picker-controls">
        <label data-ui="attachment-search">
          <SearchIcon size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search id, name, MIME, hash, text…"
          />
        </label>
        <fieldset data-ui="attachment-filter-strip" aria-label="Attachment kind">
          {KIND_FILTERS.map((value) => (
            <Button
              key={value}
              type="button"
              data-ui="attachment-filter"
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {value === 'all' ? 'All' : kindLabel(value)}
            </Button>
          ))}
        </fieldset>
      </div>
      <div data-ui="attachment-picker-list">
        {rows.length === 0 ? (
          <p data-ui="helper">No stored attachments match.</p>
        ) : (
          rows.map((attachment) => (
            <Button
              key={attachment.id}
              type="button"
              data-ui="attachment-picker-row"
              onClick={() => {
                if (!searchSession?.interactive) return
                pickInteraction.run({
                  target: pickTarget,
                  action: async ({ signal }) => {
                    const current = await getAttachment(attachment.id)
                    if (signal.aborted) return
                    if (!current) throw new Error(`AttachmentMissing:${attachment.id}`)
                    await onPick(current)
                  },
                  commit: () => {
                    onClose()
                    return undefined
                  },
                })
              }}
              disabled={pickInteraction.isPending(pickTarget) || !searchSession?.interactive}
              title={`${attachment.id}\n${attachment.mime}`}
            >
              <span data-ui="attachment-row-main">
                <strong>{attachment.filename}</strong>
                <span>
                  {kindLabel(attachment.kind)} · {formatBytes(attachment.sizeBytes)} ·{' '}
                  {storageLabel(attachment)} · {shortId(attachment.id)}
                </span>
              </span>
              <span data-ui="attachment-row-meta">{attachment.refCount} refs</span>
            </Button>
          ))
        )}
      </div>
    </Dialog>
  )
}

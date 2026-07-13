import { useEffect, useMemo, useRef, useState } from 'react'
import type { Attachment, AttachmentKind } from '../../core/types'
import { getWorkspaceRepository } from '../../store/workspace-repository'
import { CloseIcon, DatabaseIcon, SearchIcon } from '../icons/Icon'
import { formatBytes, kindLabel, shortId, storageLabel } from './format'

interface AttachmentPickerProps {
  title?: string
  excludeAttachmentId?: string
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
const ATTACHMENT_SEARCH_DEBOUNCE_MS = 150

export function AttachmentPicker({
  title = 'Stored attachments',
  excludeAttachmentId,
  onPick,
  onClose,
}: AttachmentPickerProps) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<AttachmentKind | 'all'>('all')
  const [rows, setRows] = useState<Attachment[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const lastStartedTextQueryRef = useRef<string | null>(null)

  const filters = useMemo(() => (kind === 'all' ? undefined : { kind }), [kind])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  useEffect(() => {
    const controller = new AbortController()
    const normalizedQuery = query.trim()
    const delay =
      normalizedQuery.length > 0 &&
      lastStartedTextQueryRef.current !== null &&
      lastStartedTextQueryRef.current !== normalizedQuery
        ? ATTACHMENT_SEARCH_DEBOUNCE_MS
        : 0
    const timer = window.setTimeout(() => {
      lastStartedTextQueryRef.current = normalizedQuery.length > 0 ? normalizedQuery : null
      void getWorkspaceRepository()
        .searchAttachments({
          query,
          ...(filters ? { filters } : {}),
          sort: 'created-desc',
          limit: 80,
          signal: controller.signal,
        })
        .then((page) => {
          if (controller.signal.aborted) return
          setRows(
            excludeAttachmentId
              ? page.rows.filter((row) => row.id !== excludeAttachmentId)
              : page.rows,
          )
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted && (error as { name?: string }).name !== 'AbortError') {
            throw error
          }
        })
    }, delay)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query, filters, excludeAttachmentId])

  return (
    <div data-ui="attachment-picker-backdrop" role="presentation">
      <section data-ui="attachment-picker" role="dialog" aria-modal="true" aria-label={title}>
        <header data-ui="attachment-picker-header">
          <span data-ui="attachment-picker-title">
            <DatabaseIcon size={15} />
            {title}
          </span>
          <button
            type="button"
            data-ui="icon-button"
            data-compact
            onClick={onClose}
            aria-label="Close attachment picker"
            title="Close"
          >
            <CloseIcon size={15} />
          </button>
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
              <button
                key={value}
                type="button"
                data-ui="attachment-filter"
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
              >
                {value === 'all' ? 'All' : kindLabel(value)}
              </button>
            ))}
          </fieldset>
        </div>
        <div data-ui="attachment-picker-list">
          {rows.length === 0 ? (
            <p data-ui="helper">No stored attachments match.</p>
          ) : (
            rows.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                data-ui="attachment-picker-row"
                onClick={() => {
                  setBusyId(attachment.id)
                  void Promise.resolve(onPick(attachment)).finally(() => setBusyId(null))
                }}
                disabled={busyId !== null}
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
              </button>
            ))
          )}
        </div>
      </section>
    </div>
  )
}

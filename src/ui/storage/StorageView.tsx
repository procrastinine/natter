import { useLiveQuery } from 'dexie-react-hooks'
import { useRef, useState } from 'react'
import type { StorageRoute } from '../../app/router'
import {
  attachmentHref,
  chatHref,
  makeAnchorClickHandler,
  navigate,
  storageHref,
} from '../../app/router'
import type { Attachment, AttachmentKind, Chat, ChatId, MessageId } from '../../core/types'
import {
  batchRelinkAttachmentRefs,
  deleteReferencedAttachmentBytes,
  deleteUnreferencedAttachment,
  detachAttachmentRef,
  ingestAttachmentBytes,
  listAttachmentReferences,
  relinkAttachmentRef,
  replaceAttachmentBytes,
  restoreMissingAttachment,
  setAttachmentRefVisibility,
  type AttachmentReferenceRow,
} from '../../store/attachments'
import { getBrowserRepository } from '../../store/browser-repo'
import {
  deleteArchivedChatPermanently,
  emptyArchivedChats,
  listChats,
  unarchiveChat,
} from '../../store/chats'
import type { AttachmentBundle } from '../../store/repository'
import { AttachmentPicker } from '../attachments/AttachmentPicker'
import { AttachmentPreview } from '../attachments/AttachmentPreview'
import { formatBytes, formatDate, kindLabel, shortId, storageLabel } from '../attachments/format'
import {
  ArchiveIcon,
  CloseIcon,
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  SearchIcon,
  TrashIcon,
  UnarchiveIcon,
  UploadIcon,
} from '../icons/Icon'

export interface StorageViewProps {
  route: StorageRoute
}

type ManagerFilter =
  | 'all'
  | 'missing'
  | 'unreferenced'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'document'
  | 'remote'
  | 'generated'

const FILTERS: ManagerFilter[] = [
  'all',
  'missing',
  'unreferenced',
  'image',
  'pdf',
  'audio',
  'video',
  'document',
  'remote',
  'generated',
]

export function StorageView({ route }: StorageViewProps) {
  return (
    <main data-ui="storage-view">
      <header data-ui="storage-header">
        <span data-ui="storage-title">
          <DatabaseIcon size={18} />
          Storage
        </span>
        <nav data-ui="storage-nav" aria-label="Storage sections">
          <a
            href={storageHref()}
            onClick={makeAnchorClickHandler(storageHref())}
            aria-current={route.section === 'overview' ? 'page' : undefined}
            aria-label="Overview"
            title="Overview"
          >
            <DatabaseIcon size={15} />
          </a>
          <a
            href={storageHref({ section: 'attachments' })}
            onClick={makeAnchorClickHandler(storageHref({ section: 'attachments' }))}
            aria-current={route.section === 'attachments' ? 'page' : undefined}
            aria-label="Attachments"
            title="Attachments"
          >
            <FileIcon size={15} />
          </a>
          <a
            href={storageHref({ section: 'archive' })}
            onClick={makeAnchorClickHandler(storageHref({ section: 'archive' }))}
            aria-current={route.section === 'archive' ? 'page' : undefined}
            aria-label="Archive"
            title="Archive"
          >
            <ArchiveIcon size={15} />
          </a>
          <a
            href={storageHref({ section: 'backups' })}
            onClick={makeAnchorClickHandler(storageHref({ section: 'backups' }))}
            aria-current={route.section === 'backups' ? 'page' : undefined}
            aria-label="Backups"
            title="Backups"
          >
            <UploadIcon size={15} />
          </a>
        </nav>
      </header>
      {route.section === 'overview' ? <StorageOverview /> : null}
      {route.section === 'attachments' ? <AttachmentManager route={route} /> : null}
      {route.section === 'archive' ? <ArchiveManager /> : null}
      {route.section === 'backups' ? <BackupSurface /> : null}
    </main>
  )
}

function StorageOverview() {
  const chats = useLiveQuery(() => listChats(), [], [])
  const attachments = useLiveQuery(
    () => getBrowserRepository().searchAttachments({ sort: 'size-desc', limit: 5000 }),
    [],
    { rows: [] },
  )
  const localBytes = attachments.rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)
  const missing = attachments.rows.filter((row) => row.storage.kind === 'missing').length
  const unreferenced = attachments.rows.filter((row) => row.refCount === 0).length
  const archived = chats.filter((chat) => chat.archived).length
  return (
    <section data-ui="storage-overview">
      <div data-ui="storage-stat-row">
        <StorageStat label="mode" value="Browser" detail="IndexedDB" />
        <StorageStat label="chats" value={String(chats.length)} />
        <StorageStat label="attachments" value={String(attachments.rows.length)} />
        <StorageStat label="bytes" value={formatBytes(localBytes)} />
      </div>
      <div data-ui="storage-shortcuts">
        <a href={storageHref({ section: 'attachments' })}>All attachments</a>
        <a href={storageHref({ section: 'attachments', filter: 'missing' })}>Missing · {missing}</a>
        <a href={storageHref({ section: 'attachments', filter: 'unreferenced' })}>
          Unreferenced · {unreferenced}
        </a>
        <a href={storageHref({ section: 'archive' })}>Archive · {archived}</a>
      </div>
    </section>
  )
}

function StorageStat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <dl data-ui="storage-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail ? <dd data-ui="storage-stat-detail">{detail}</dd> : null}
    </dl>
  )
}

function BackupSurface() {
  return (
    <section data-ui="storage-backups">
      <p data-ui="helper">Backup, restore, and raw dump controls land with daemon storage.</p>
    </section>
  )
}

function ArchiveManager() {
  const chats = useLiveQuery(() => listChats(), [], [])
  const [busy, setBusy] = useState<string | null>(null)
  const archived = chats
    .filter((chat) => chat.archived)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
  const handleRestore = async (chat: Chat) => {
    setBusy(chat.id)
    try {
      await unarchiveChat(chat.id)
    } finally {
      setBusy(null)
    }
  }
  const handleDelete = async (chat: Chat) => {
    const title = displayChatTitle(chat)
    if (!window.confirm(`Permanently delete "${title}"? This cannot be undone.`)) return
    setBusy(chat.id)
    try {
      await deleteArchivedChatPermanently(chat.id)
    } finally {
      setBusy(null)
    }
  }
  const handleEmpty = async () => {
    if (archived.length === 0) return
    if (!window.confirm(`Permanently delete ${archived.length} archived chats?`)) return
    setBusy('__all__')
    try {
      await emptyArchivedChats()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section data-ui="archive-manager">
      <div data-ui="archive-toolbar">
        <span data-ui="archive-count">{archived.length}</span>
        <button
          type="button"
          data-ui="storage-action"
          data-tone="danger"
          aria-label="Empty trash"
          title="Empty trash"
          disabled={archived.length === 0 || busy !== null}
          onClick={() => void handleEmpty()}
        >
          <TrashIcon size={14} />
        </button>
      </div>
      {archived.length === 0 ? (
        <p data-ui="helper">No archived chats.</p>
      ) : (
        <ul data-ui="archive-list">
          {archived.map((chat) => {
            const title = displayChatTitle(chat)
            const href = chatHref(chat.id)
            return (
              <li key={chat.id} data-ui="archive-row">
                <a data-ui="archive-row-link" href={href} onClick={makeAnchorClickHandler(href)}>
                  <span data-ui="archive-row-main">
                    <strong>{title}</strong>
                    <span>{chat.previewText || shortId(chat.id)}</span>
                  </span>
                  <span data-ui="archive-row-meta">{formatDate(chat.updatedAt)}</span>
                </a>
                <span data-ui="archive-row-actions">
                  <button
                    type="button"
                    data-ui="archive-restore-button"
                    aria-label={`Restore ${title}`}
                    title="Restore to sidebar"
                    disabled={busy !== null}
                    onClick={() => void handleRestore(chat)}
                  >
                    <UnarchiveIcon size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Permanently delete ${title}`}
                    title="Delete permanently"
                    disabled={busy !== null}
                    onClick={() => void handleDelete(chat)}
                  >
                    <TrashIcon size={14} />
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function displayChatTitle(chat: Chat): string {
  const trimmed = chat.title.trim()
  return trimmed.length > 0 ? trimmed : 'Untitled chat'
}

function AttachmentManager({
  route,
}: {
  route: Extract<StorageRoute, { section: 'attachments' }>
}) {
  const routeFilter = route.filter ?? 'all'
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ManagerFilter>(routeFilter)
  const [replaceTarget, setReplaceTarget] = useState<AttachmentReferenceRow | null>(null)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const uploadRef = useRef<HTMLInputElement | null>(null)
  const replaceUploadRef = useRef<HTMLInputElement | null>(null)
  const selectedId = route.attachmentId
  const rows = useLiveQuery(
    async () => listManagerAttachments({ query, filter, limit: 5000 }),
    [query, filter],
    [],
  )
  const selected = useLiveQuery(
    async () =>
      selectedId ? await getBrowserRepository().getAttachmentBundle(selectedId) : undefined,
    [selectedId],
    undefined,
  )
  const references = useLiveQuery(
    async () => (selectedId ? await listAttachmentReferences(selectedId) : []),
    [selectedId],
    [],
  )
  const unknownSelected = Boolean(selectedId && selected === undefined)
  const displaySelected =
    selected?.attachment ?? (selectedId ? rows.find((row) => row.id === selectedId) : rows[0])
  const handleDeleteAttachment = async (attachment: Attachment) => {
    if (!confirmDeleteAttachment(attachment)) return
    const removed = await deleteAttachmentForStorage(attachment)
    if (selectedId === attachment.id && removed) {
      navigate(attachmentListHrefForFilter(filter))
    }
  }

  return (
    <section data-ui="attachment-manager">
      <div data-ui="attachment-manager-toolbar">
        <label data-ui="attachment-search">
          <SearchIcon size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search id, name, MIME, hash, URL, extracted text…"
          />
        </label>
        <div data-ui="attachment-filter-row">
          <fieldset data-ui="attachment-filter-strip" aria-label="Attachment filters">
            {FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                data-ui="attachment-filter"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {filterLabel(value)}
              </button>
            ))}
          </fieldset>
          <button
            type="button"
            data-ui="storage-action"
            data-tone="danger"
            disabled={bulkDeleting || rows.length === 0}
            onClick={() => {
              void (async () => {
                setBulkDeleting(true)
                try {
                  const candidates = await listManagerAttachments({ query, filter })
                  if (candidates.length === 0) return
                  if (!confirmDeleteAll(filter, query, candidates.length)) return
                  const removedIds = await deleteAttachmentsForStorage(candidates)
                  if (selectedId && removedIds.has(selectedId)) {
                    navigate(attachmentListHrefForFilter(filter))
                  }
                } finally {
                  setBulkDeleting(false)
                }
              })()
            }}
          >
            <TrashIcon size={14} />
            {bulkDeleting ? 'Deleting…' : `Delete all${rows.length > 0 ? ` (${rows.length})` : ''}`}
          </button>
        </div>
      </div>
      {unknownSelected ? (
        <div data-ui="notice-banner" data-tone="warning" role="status">
          Attachment not found in this workspace.
        </div>
      ) : null}
      <div data-ui="attachment-manager-grid">
        <AttachmentTable
          rows={rows}
          selectedId={displaySelected?.id}
          onDelete={handleDeleteAttachment}
        />
        <AttachmentDetails
          attachment={displaySelected}
          bundle={displaySelected?.id === selectedId ? selected : undefined}
          references={displaySelected?.id === selectedId || !selectedId ? references : []}
          onReplaceRef={setReplaceTarget}
          onRestoreUpload={() => uploadRef.current?.click()}
          onReplaceUpload={() => replaceUploadRef.current?.click()}
          onDelete={handleDeleteAttachment}
        />
      </div>
      <input
        ref={uploadRef}
        data-ui="attachment-hidden-input"
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!file || !displaySelected) return
          void (async () => {
            const replacement = await ingestAttachmentBytes({
              blob: file,
              filename: file.name,
              origin: 'user-upload',
              ...(file.type ? { declaredMime: file.type } : {}),
            })
            await restoreMissingAttachment({
              missingAttachmentId: displaySelected.id,
              replacementAttachmentId: replacement.attachment.id,
              refs: references.map(referenceTarget),
            })
          })()
        }}
      />
      <input
        ref={replaceUploadRef}
        data-ui="attachment-hidden-input"
        type="file"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (!file || !displaySelected) return
          void (async () => {
            const result = await replaceAttachmentBytes({
              attachmentId: displaySelected.id,
              blob: file,
              filename: file.name,
              origin: 'user-upload',
              ...(file.type ? { declaredMime: file.type } : {}),
            })
            if (result.reusedExisting && result.bundle.attachment.id !== displaySelected.id) {
              if (references.length > 0) {
                await batchRelinkAttachmentRefs({
                  oldAttachmentId: displaySelected.id,
                  newAttachmentId: result.bundle.attachment.id,
                  refs: references.map(referenceTarget),
                })
              }
              await deleteUnreferencedAttachment(displaySelected.id)
              navigate(attachmentHref(result.bundle.attachment.id))
            }
          })()
        }}
      />
      {replaceTarget ? (
        <AttachmentPicker
          title="Relink reference"
          excludeAttachmentId={replaceTarget.ref.attachmentId}
          onClose={() => setReplaceTarget(null)}
          onPick={async (attachment) => {
            await relinkAttachmentRef({
              ...referenceTarget(replaceTarget),
              newAttachmentId: attachment.id,
            })
            setReplaceTarget(null)
          }}
        />
      ) : null}
    </section>
  )
}

function AttachmentTable({
  rows,
  selectedId,
  onDelete,
}: {
  rows: Attachment[]
  selectedId: string | undefined
  onDelete: (attachment: Attachment) => void | Promise<void>
}) {
  return (
    <div data-ui="attachment-table-wrap">
      <table data-ui="attachment-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>State</th>
            <th>Refs</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((attachment) => {
            const href = attachmentHref(attachment.id)
            return (
              <tr
                key={attachment.id}
                data-selected={selectedId === attachment.id ? 'true' : undefined}
                tabIndex={0}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) {
                    return
                  }
                  navigate(href)
                }}
                onKeyDown={(event) => {
                  if ((event.target as HTMLElement).closest('a, button, input, select, textarea')) {
                    return
                  }
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  navigate(href)
                }}
              >
                <td>
                  <a href={href} onClick={makeAnchorClickHandler(href)}>
                    <FileIcon size={14} />
                    <span>{attachment.filename}</span>
                    <small>{shortId(attachment.id)}</small>
                  </a>
                </td>
                <td>
                  {formatBytes(attachment.sizeBytes)} · {storageLabel(attachment)}
                </td>
                <td>{attachment.refCount}</td>
                <td>{formatDate(attachment.createdAt)}</td>
                <td data-ui="attachment-table-actions">
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-size="xs"
                    aria-label={`Delete ${attachment.filename}`}
                    title="Delete"
                    onClick={() => void onDelete(attachment)}
                  >
                    <TrashIcon size={13} />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function AttachmentDetails({
  attachment,
  bundle,
  references,
  onReplaceRef,
  onRestoreUpload,
  onReplaceUpload,
  onDelete,
}: {
  attachment: Attachment | undefined
  bundle: AttachmentBundle | undefined
  references: AttachmentReferenceRow[]
  onReplaceRef: (reference: AttachmentReferenceRow) => void
  onRestoreUpload: () => void
  onReplaceUpload: () => void
  onDelete: (attachment: Attachment) => void | Promise<void>
}) {
  if (!attachment) {
    return (
      <aside data-ui="attachment-details">
        <p data-ui="helper">Select an attachment.</p>
      </aside>
    )
  }
  return (
    <aside data-ui="attachment-details">
      <header data-ui="attachment-details-header">
        <span data-ui="attachment-details-title">
          <FileIcon size={16} />
          {attachment.filename}
        </span>
      </header>
      <AttachmentPreview attachment={attachment} bundle={bundle} variant="panel" />
      <dl data-ui="attachment-metadata">
        <Meta label="id" value={attachment.id} />
        <Meta label="kind" value={kindLabel(attachment.kind)} />
        <Meta label="MIME" value={attachment.mime} />
        <Meta label="size" value={formatBytes(attachment.sizeBytes)} />
        <Meta label="state" value={storageLabel(attachment)} />
        <Meta label="hash" value={attachment.contentHash ?? 'none'} />
        <Meta label="origin" value={attachment.origin} />
        <Meta label="created" value={formatDate(attachment.createdAt)} />
        {attachment.sourceUrl ? <Meta label="URL" value={attachment.sourceUrl} /> : null}
        {attachment.pageCount !== undefined ? (
          <Meta label="pages" value={String(attachment.pageCount)} />
        ) : null}
        {attachment.dimensions ? (
          <Meta
            label="pixels"
            value={`${attachment.dimensions.width}×${attachment.dimensions.height}`}
          />
        ) : null}
      </dl>
      <div data-ui="attachment-lifecycle-actions">
        <button type="button" data-ui="storage-action" onClick={onReplaceUpload}>
          <UploadIcon size={14} />
          Replace
        </button>
        {attachment.storage.kind === 'missing' ? (
          <button type="button" data-ui="storage-action" onClick={onRestoreUpload}>
            <UploadIcon size={14} />
            Restore
          </button>
        ) : null}
        <button
          type="button"
          data-ui="storage-action"
          data-tone="danger"
          onClick={() => void onDelete(attachment)}
        >
          <TrashIcon size={14} />
          Delete
        </button>
      </div>
      <section data-ui="attachment-reference-section">
        <h3>References</h3>
        {references.length === 0 ? (
          <p data-ui="helper">No live message or draft refs.</p>
        ) : (
          <ul data-ui="attachment-reference-list">
            {references.map((row) => (
              <li key={`${row.ownerKind}:${row.messageId ?? row.draftChatId}:${row.ref.refId}`}>
                <div data-ui="attachment-reference-main">
                  <strong>{row.chatTitle}</strong>
                  <span>
                    {row.ownerKind === 'message'
                      ? `${row.role ?? 'message'} · ${formatDate(row.messageCreatedAt)}`
                      : 'draft'}
                  </span>
                </div>
                <div data-ui="attachment-reference-actions">
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-size="xs"
                    aria-pressed={row.ref.includeInContext}
                    aria-label={
                      row.ref.includeInContext ? 'Hide from context' : 'Include in context'
                    }
                    title={
                      row.ref.includeInContext
                        ? 'Hide this exact reference from future context'
                        : 'Include this exact reference in future context'
                    }
                    onClick={() =>
                      void setAttachmentRefVisibility({
                        ...referenceTarget(row),
                        includeInContext: !row.ref.includeInContext,
                      })
                    }
                  >
                    {row.ref.includeInContext ? <EyeIcon size={13} /> : <EyeOffIcon size={13} />}
                  </button>
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-size="xs"
                    aria-label="Relink reference"
                    title="Relink this exact reference to another stored attachment"
                    onClick={() => onReplaceRef(row)}
                  >
                    <DatabaseIcon size={13} />
                  </button>
                  <button
                    type="button"
                    data-ui="icon-button"
                    data-size="xs"
                    aria-label="Detach reference"
                    title="Detach this exact reference"
                    onClick={() => void detachAttachmentRef(referenceTarget(row))}
                  >
                    <CloseIcon size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div data-ui="attachment-meta-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function filterToSearch(filter: ManagerFilter) {
  if (filter === 'missing') return { storageKind: 'missing' as const }
  if (filter === 'unreferenced') return { maxRefCount: 0 }
  if (filter === 'remote') return { storageKind: 'remote-url' as const }
  if (filter === 'image' || filter === 'pdf' || filter === 'audio' || filter === 'video') {
    return { kind: filter as AttachmentKind }
  }
  if (filter === 'document') return { kind: 'document' as AttachmentKind }
  return undefined
}

async function listManagerAttachments({
  query,
  filter,
  limit,
}: {
  query: string
  filter: ManagerFilter
  limit?: number
}): Promise<Attachment[]> {
  const filters = filterToSearch(filter)
  const rows: Attachment[] = []
  let cursor: string | undefined
  do {
    const page = await getBrowserRepository().searchAttachments({
      query,
      ...(filters ? { filters } : {}),
      sort: 'size-desc',
      limit: 500,
      ...(cursor ? { cursor } : {}),
    })
    const pageRows =
      filter === 'generated'
        ? page.rows.filter((row) => row.origin === 'generated-output')
        : page.rows
    rows.push(...pageRows)
    cursor = page.nextCursor
  } while (cursor && (limit === undefined || rows.length < limit))
  return limit === undefined ? rows : rows.slice(0, limit)
}

async function deleteAttachmentForStorage(attachment: Attachment): Promise<boolean> {
  if (attachment.refCount === 0) {
    const result = await deleteUnreferencedAttachment(attachment.id)
    if (result.deleted) return true
  }
  await deleteReferencedAttachmentBytes(attachment.id, 'deleted')
  return false
}

async function deleteAttachmentsForStorage(
  attachments: readonly Attachment[],
): Promise<Set<string>> {
  const removed = new Set<string>()
  for (const attachment of attachments) {
    if (await deleteAttachmentForStorage(attachment)) {
      removed.add(attachment.id)
    }
  }
  return removed
}

function confirmDeleteAttachment(attachment: Attachment): boolean {
  if (attachment.refCount === 0) {
    return window.confirm(`Delete "${attachment.filename}"?`)
  }
  return window.confirm(
    `Delete "${attachment.filename}"? ${attachment.refCount} message/draft refs will keep stubs.`,
  )
}

function confirmDeleteAll(filter: ManagerFilter, query: string, count: number): boolean {
  const scope = query.trim()
    ? `${filterLabel(filter)} matching "${query.trim()}"`
    : filterLabel(filter)
  const noun = count === 1 ? 'attachment' : 'attachments'
  return window.confirm(
    `Delete ${count} ${noun} in ${scope}? Referenced message/draft refs will keep stubs.`,
  )
}

function attachmentListHrefForFilter(filter: ManagerFilter): string {
  if (filter === 'missing' || filter === 'unreferenced') {
    return storageHref({ section: 'attachments', filter })
  }
  return storageHref({ section: 'attachments' })
}

function filterLabel(filter: ManagerFilter): string {
  if (filter === 'all') return 'All'
  if (filter === 'remote') return 'Remote'
  if (filter === 'generated') return 'Generated'
  return kindLabel(filter as AttachmentKind)
}

function referenceTarget(row: AttachmentReferenceRow): {
  refId: string
  messageId?: MessageId
  draftChatId?: ChatId
} {
  return {
    refId: row.ref.refId,
    ...(row.ownerKind === 'message'
      ? { messageId: row.messageId as MessageId }
      : { draftChatId: row.draftChatId as ChatId }),
  }
}

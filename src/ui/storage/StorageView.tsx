import { useLiveQuery } from 'dexie-react-hooks'
import {
  Fragment,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { StorageRoute } from '../../app/router'
import {
  attachmentHref,
  chatHref,
  makeAnchorClickHandler,
  navigate,
  storageHref,
} from '../../app/router'
import {
  exportLastUpdatedChatAsTxt,
  exportLastUpdatedChatsAsZip,
  triggerBrowserBlobDownload,
  triggerBrowserDownload,
} from '../../core/chat-export'
import {
  DEFAULT_SIDEBAR_SORT_MODE,
  SIDEBAR_SORT_OPTIONS,
  type SidebarSortMode,
  sidebarSortDirection,
  sidebarSortField,
  sidebarSortOption,
} from '../../core/sidebar-sort'
import {
  aggregateCalibrationSamples,
  readTokenCalibrationGlobal,
} from '../../core/token-calibration'
import type {
  Attachment,
  AttachmentKind,
  Chat,
  ChatFolder,
  ChatId,
  ChatSidebarRow,
  ChatTag,
  FolderId,
  MessageId,
  TagId,
  TokenCalibrationSample,
} from '../../core/types'
import {
  type AttachmentReferenceRow,
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
} from '../../store/attachments'
import { getBrowserRepository } from '../../store/browser-repo'
import {
  DEFAULT_SEARCH_FILTERS,
  hasActiveSearchFilters,
  type SearchFilters,
  type SearchResult,
} from '../../store/chat-search'
import {
  archiveChat,
  clearAllTokenCalibrationEverywhere,
  clearChatTokenCalibration,
  clearTokenCalibrationFamilyEverywhere,
  deleteArchivedChatPermanently,
  emptyArchivedChats,
  listChatSidebarRows,
  listChats,
  moveChatsToFolder,
  projectChatSidebarRow,
  setChatsTagsFromNames,
  unarchiveChat,
} from '../../store/chats'
import { createFolder, listFolders } from '../../store/folders'
import {
  estimateQuota,
  isPersisted,
  type QuotaSnapshot,
  requestPersist,
  storagePersistenceAvailable,
} from '../../store/quota'
import type { AttachmentBundle } from '../../store/repository'
import { abortSearchSession, requestSearchSession } from '../../store/search-session'
import { readSidebarSortMode, writeSidebarSortMode } from '../../store/sidebar-preferences'
import { listTags } from '../../store/tags'
import { startSearchStoreBroadcastListener, useSearchStore } from '../../store/zustand/searchStore'
import { useToastStore } from '../../store/zustand/toastStore'
import { AttachmentPicker } from '../attachments/AttachmentPicker'
import { AttachmentPreview } from '../attachments/AttachmentPreview'
import { formatBytes, formatDate, kindLabel, shortId, storageLabel } from '../attachments/format'
import {
  ArchiveIcon,
  ChevronIcon,
  CloseIcon,
  DatabaseIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FolderIcon,
  MessageSquareIcon,
  SearchIcon,
  SortIcon,
  TagIcon,
  TrashIcon,
  UnarchiveIcon,
  UploadIcon,
} from '../icons/Icon'
import { isEmptySidebarDraft, sortChats } from '../sidebar/chat-organization'

interface StorageViewProps {
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

interface StorageChatModel {
  chats: ChatSidebarRow[]
  folders: ChatFolder[]
  tags: ChatTag[]
  calibrations: Map<ChatId, Record<string, TokenCalibrationSample> | undefined>
}

interface StorageGlobalCalibrationModel {
  rows: Array<[string, TokenCalibrationSample]>
}

const EMPTY_SEARCH_RESULTS: SearchResult[] = []
const EMPTY_STORAGE_CHAT_MODEL: StorageChatModel = {
  chats: [],
  folders: [],
  tags: [],
  calibrations: new Map(),
}
const EMPTY_GLOBAL_CALIBRATION_MODEL: StorageGlobalCalibrationModel = {
  rows: [],
}

async function loadStorageChatModel(): Promise<StorageChatModel> {
  const [rows, chats, folders, tags] = await Promise.all([
    listChatSidebarRows(),
    listChats(),
    listFolders(),
    listTags(),
  ])
  return {
    chats: rows,
    folders,
    tags,
    calibrations: new Map(chats.map((chat) => [chat.id, chat.tokenCalibration])),
  }
}

async function loadStorageGlobalCalibrationModel(): Promise<StorageGlobalCalibrationModel> {
  const global = await readTokenCalibrationGlobal()
  return {
    rows: Object.entries(aggregateCalibrationSamples(global.byModel)).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  }
}

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
            href={storageHref({ section: 'chats' })}
            onClick={makeAnchorClickHandler(storageHref({ section: 'chats' }))}
            aria-current={route.section === 'chats' ? 'page' : undefined}
            aria-label="Chats"
            title="Chats"
          >
            <MessageSquareIcon size={15} />
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
            href={storageHref({ section: 'attachments' })}
            onClick={makeAnchorClickHandler(storageHref({ section: 'attachments' }))}
            aria-current={route.section === 'attachments' ? 'page' : undefined}
            aria-label="Attachments"
            title="Attachments"
          >
            <FileIcon size={15} />
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
      {route.section === 'chats' ? <ChatsStorageSurface /> : null}
      {route.section === 'attachments' ? <AttachmentManager route={route} /> : null}
      {route.section === 'archive' ? <ArchiveManager /> : null}
      {route.section === 'backups' ? <BackupSurface /> : null}
    </main>
  )
}

function StorageOverview() {
  const pushToast = useToastStore((s) => s.push)
  const chats = useLiveQuery(() => listChats(), [], [])
  const attachments = useLiveQuery(
    () => listManagerAttachments({ query: '', filter: 'all' }),
    [],
    [],
  )
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null)
  const [persistence, setPersistence] = useState<
    'checking' | 'unsupported' | 'persistent' | 'best-effort'
  >(storagePersistenceAvailable() ? 'checking' : 'unsupported')
  const [persistenceRequestResult, setPersistenceRequestResult] = useState<
    'granted' | 'denied' | null
  >(null)
  const [persistenceBusy, setPersistenceBusy] = useState(false)
  const storageMode = 'indexeddb' as const
  const isIndexedDbMode = storageMode === 'indexeddb'
  const localBytes = attachments.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)
  useEffect(() => {
    let active = true
    void Promise.all([
      estimateQuota(),
      storagePersistenceAvailable() ? isPersisted() : Promise.resolve(false),
    ]).then(([quotaSnapshot, persisted]) => {
      if (!active) return
      setQuota(quotaSnapshot)
      setPersistence(
        storagePersistenceAvailable() ? (persisted ? 'persistent' : 'best-effort') : 'unsupported',
      )
    })
    return () => {
      active = false
    }
  }, [])
  const handleRequestPersistence = async () => {
    if (!storagePersistenceAvailable()) {
      setPersistence('unsupported')
      setPersistenceRequestResult(null)
      return
    }
    setPersistenceBusy(true)
    try {
      const granted = await requestPersist()
      const persisted = granted || (await isPersisted())
      setPersistence(persisted ? 'persistent' : 'best-effort')
      setPersistenceRequestResult(persisted ? 'granted' : 'denied')
      if (persisted) {
        console.info('Natter storage persistence granted for this origin.')
        pushToast({ level: 'success', text: 'Storage persistence granted.' })
      } else {
        console.warn(
          'Natter storage persistence denied by the browser. Chromium grants this only for origins it considers important, such as installed, bookmarked, notification-permitted, or high-engagement sites.',
        )
        pushToast({ level: 'warning', text: 'Browser denied storage persistence.' })
      }
      const quotaSnapshot = await estimateQuota()
      setQuota(quotaSnapshot)
    } finally {
      setPersistenceBusy(false)
    }
  }
  const spaceValue = quota ? `${formatBytes(quota.usage)} / ${formatBytes(quota.quota)}` : 'Unknown'
  const persistenceValue =
    persistenceRequestResult === 'denied'
      ? 'Denied'
      : persistence === 'persistent'
        ? 'Persistent'
        : persistence === 'best-effort'
          ? 'Best effort'
          : persistence === 'unsupported'
            ? 'Unsupported'
            : 'Checking'
  let persistenceDetail: string | undefined
  if (persistenceRequestResult === 'granted') persistenceDetail = 'Granted by browser'
  else if (persistenceRequestResult === 'denied') persistenceDetail = 'Denied by browser'
  else if (persistence === 'persistent') persistenceDetail = 'Eviction protected'
  else if (persistence === 'best-effort') persistenceDetail = 'Browser may evict under pressure'
  else if (persistence === 'unsupported') persistenceDetail = 'API unavailable'
  return (
    <section data-ui="storage-overview">
      <div data-ui="storage-panel-row">
        <StoragePanel title="Mode" value="IndexedDB" detail="Browser workspace">
          {isIndexedDbMode ? (
            <>
              <StoragePanelMetric
                label="Persistence"
                value={persistenceValue}
                detail={persistenceDetail}
              />
              {persistence !== 'unsupported' ? (
                <button
                  type="button"
                  data-ui="storage-action"
                  onClick={handleRequestPersistence}
                  disabled={persistenceBusy || persistence === 'persistent'}
                  title="Request persistent browser storage"
                >
                  <DatabaseIcon size={14} />
                  {persistenceBusy
                    ? 'Requesting'
                    : persistenceRequestResult === 'denied'
                      ? 'Request again'
                      : 'Request persistence'}
                </button>
              ) : null}
            </>
          ) : null}
        </StoragePanel>
        <StoragePanel title="Space" value={spaceValue} detail="Total / quota" />
        <StoragePanel
          title="Chats"
          value={String(chats.length)}
          href={storageHref({ section: 'chats' })}
        />
        <StoragePanel
          title="Attachments"
          value={`${attachments.length} (${formatBytes(localBytes)})`}
          href={storageHref({ section: 'attachments' })}
        />
      </div>
      <div data-ui="storage-panel-row" data-role="calibration">
        <StorageGlobalCalibrationPanel />
      </div>
    </section>
  )
}

function StorageGlobalCalibrationPanel() {
  const model = useLiveQuery(loadStorageGlobalCalibrationModel, [], EMPTY_GLOBAL_CALIBRATION_MODEL)
  const [busy, setBusy] = useState<string | null>(null)
  const rows = model.rows
  const handleClearFamily = async (calibrationKey: string) => {
    setBusy(calibrationKey)
    try {
      await clearTokenCalibrationFamilyEverywhere(calibrationKey)
    } finally {
      setBusy(null)
    }
  }
  const handleClearAll = async () => {
    setBusy('*')
    try {
      await clearAllTokenCalibrationEverywhere()
    } finally {
      setBusy(null)
    }
  }
  return (
    <StoragePanel
      title="Global token calibration"
      value={`${rows.length} ${pluralize('family', rows.length)}`}
      detail="Materialized from per-chat samples"
    >
      {rows.length === 0 ? (
        <span data-ui="storage-calibration-empty">No calibration samples.</span>
      ) : (
        <div data-ui="storage-global-calibration-list">
          {rows.map(([key, sample]) => (
            <div key={key} data-ui="storage-global-calibration-item">
              <span data-ui="storage-global-calibration-key">{key}</span>
              <span data-ui="storage-global-calibration-ratio">
                {formatCalibrationRatio(sample)}
              </span>
              <span data-ui="storage-global-calibration-samples">
                {formatInteger(sample.sampleCount)} samples
              </span>
              <button
                type="button"
                data-ui="storage-action"
                aria-label={`Clear calibration for ${key}`}
                disabled={busy !== null}
                onClick={() => void handleClearFamily(key)}
              >
                Clear
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        data-ui="storage-action"
        disabled={busy !== null || rows.length === 0}
        onClick={() => void handleClearAll()}
      >
        Clear all calibration globally
      </button>
    </StoragePanel>
  )
}

function StoragePanel({
  title,
  value,
  detail,
  href,
  children,
}: {
  title: string
  value: string
  detail?: string | undefined
  href?: string | undefined
  children?: ReactNode
}) {
  const content = (
    <>
      <span data-ui="storage-panel-title">{title}</span>
      <span data-ui="storage-panel-value">{value}</span>
      {detail ? <span data-ui="storage-panel-detail">{detail}</span> : null}
      {children ? <span data-ui="storage-panel-extra">{children}</span> : null}
    </>
  )
  if (href) {
    return (
      <a data-ui="storage-panel" href={href} onClick={makeAnchorClickHandler(href)}>
        {content}
      </a>
    )
  }
  return <section data-ui="storage-panel">{content}</section>
}

function StoragePanelMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string | undefined
}) {
  return (
    <span data-ui="storage-panel-metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </span>
  )
}

function ChatsStorageSurface() {
  const model = useLiveQuery(loadStorageChatModel, [], EMPTY_STORAGE_CHAT_MODEL)
  const persistedSortMode = useLiveQuery(readSidebarSortMode, [], DEFAULT_SIDEBAR_SORT_MODE)
  const [sortMode, setSortMode] = useState<SidebarSortMode>(DEFAULT_SIDEBAR_SORT_MODE)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchTitleOnly, setSearchTitleOnly] = useState(false)
  const [searchAllBranches, setSearchAllBranches] = useState(false)
  const [searchIncludeArchived, setSearchIncludeArchived] = useState(false)
  const [includeFolderIds, setIncludeFolderIds] = useState<FolderId[]>([])
  const [excludeFolderIds, setExcludeFolderIds] = useState<FolderId[]>([])
  const [includeTagIds, setIncludeTagIds] = useState<TagId[]>([])
  const [excludeTagIds, setExcludeTagIds] = useState<TagId[]>([])
  const [openCalibrationChatId, setOpenCalibrationChatId] = useState<ChatId | null>(null)
  const [selectedChatIds, setSelectedChatIds] = useState<Set<ChatId>>(() => new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<ChatId | null>(null)
  const [busyChatAction, setBusyChatAction] = useState<string | null>(null)
  const [busyCalibration, setBusyCalibration] = useState<string | null>(null)
  const selectAllRef = useRef<HTMLInputElement | null>(null)
  const searchSession = useSearchStore((state) => state.session)
  const sortLocale = useMemo(
    () => (typeof navigator === 'undefined' ? 'en-US' : navigator.language),
    [],
  )
  const sortOptions = useMemo(() => ({ locale: sortLocale }), [sortLocale])
  const activeSortOption = sidebarSortOption(sortMode)
  const folderById = useMemo(
    () => new Map(model.folders.map((folder) => [folder.id, folder])),
    [model.folders],
  )
  const tagById = useMemo(() => new Map(model.tags.map((tag) => [tag.id, tag])), [model.tags])
  const searchFilters = useMemo<SearchFilters>(
    () => ({
      includeFolderIds,
      excludeFolderIds,
      includeTagIds,
      excludeTagIds,
      archived: searchIncludeArchived ? 'include' : DEFAULT_SEARCH_FILTERS.archived,
      titleOnly: searchTitleOnly,
    }),
    [
      excludeFolderIds,
      excludeTagIds,
      includeFolderIds,
      includeTagIds,
      searchIncludeArchived,
      searchTitleOnly,
    ],
  )
  const searchTextActive = searchQuery.trim().length > 0
  const searchHasFilters = hasActiveSearchFilters(searchFilters) || searchAllBranches
  const sortedSearchResults = useMemo(() => {
    const results = searchSession?.results ?? EMPTY_SEARCH_RESULTS
    const byChatId = new Map(results.map((result) => [result.chatId, result]))
    return sortChats(
      results.map((result) => projectChatSidebarRow(result.chat)),
      sortMode,
      sortOptions,
    )
      .map((chat) => byChatId.get(chat.id))
      .filter((result): result is SearchResult => Boolean(result))
  }, [searchSession?.results, sortMode, sortOptions])
  const searchResultByChatId = useMemo(
    () => new Map(sortedSearchResults.map((result) => [result.chatId, result])),
    [sortedSearchResults],
  )
  const filteredLocalRows = useMemo(
    () =>
      model.chats.filter(
        (chat) => !isEmptySidebarDraft(chat) && chatPassesStorageFilters(chat, searchFilters),
      ),
    [model.chats, searchFilters],
  )
  const tableRows = useMemo(() => {
    if (searchTextActive) {
      return sortedSearchResults
        .map((result) => projectChatSidebarRow(result.chat))
        .filter((chat) => !isEmptySidebarDraft(chat))
    }
    return sortChats(filteredLocalRows, sortMode, sortOptions)
  }, [filteredLocalRows, searchTextActive, sortMode, sortOptions, sortedSearchResults])
  const tableRowIds = useMemo(() => tableRows.map((chat) => chat.id), [tableRows])
  const tableRowIndexById = useMemo(
    () => new Map(tableRows.map((chat, index) => [chat.id, index])),
    [tableRows],
  )
  const selectedChats = useMemo(
    () => tableRows.filter((chat) => selectedChatIds.has(chat.id)),
    [selectedChatIds, tableRows],
  )
  const live = model.chats.filter((chat) => !chat.archived && !isEmptySidebarDraft(chat)).length
  const archived = model.chats.filter((chat) => chat.archived && !isEmptySidebarDraft(chat)).length
  const status = searchSession?.status ?? 'idle'
  const completed = searchSession?.completedCount ?? 0
  const total = searchSession?.candidateCount ?? 0
  const selectedArchivedCount = selectedChats.filter((chat) => chat.archived).length
  const selectedLiveCount = selectedChats.length - selectedArchivedCount

  useEffect(() => {
    startSearchStoreBroadcastListener()
  }, [])
  useEffect(() => setSortMode(persistedSortMode), [persistedSortMode])
  useEffect(() => {
    if (!searchTextActive) {
      abortSearchSession()
      return
    }
    requestSearchSession({
      query: searchQuery,
      scope: searchAllBranches ? 'all-branches' : 'last-updated-branch',
      filters: searchFilters,
    })
  }, [searchAllBranches, searchFilters, searchQuery, searchTextActive])
  useEffect(() => () => abortSearchSession(), [])
  useEffect(() => {
    const visible = new Set(tableRowIds)
    setSelectedChatIds((current) => {
      let changed = false
      const next = new Set<ChatId>()
      for (const chatId of current) {
        if (visible.has(chatId)) next.add(chatId)
        else changed = true
      }
      return changed ? next : current
    })
    setSelectionAnchorId((current) => (current && visible.has(current) ? current : null))
  }, [tableRowIds])
  useEffect(() => {
    if (!selectAllRef.current) return
    selectAllRef.current.indeterminate =
      selectedChats.length > 0 && selectedChats.length < tableRows.length
  }, [selectedChats.length, tableRows.length])

  const handleSelectSortMode = useCallback((mode: SidebarSortMode) => {
    setSortMode(mode)
    void writeSidebarSortMode(mode).catch((error: unknown) => {
      console.error('Failed to persist sidebar sort mode', error)
    })
  }, [])
  const handleColumnSort = useCallback(
    (field: ReturnType<typeof sidebarSortField>) => {
      const currentField = sidebarSortField(sortMode)
      const currentDirection = sidebarSortDirection(sortMode)
      const direction =
        currentField === field
          ? currentDirection === 'asc'
            ? 'desc'
            : 'asc'
          : field === 'title'
            ? 'asc'
            : 'desc'
      handleSelectSortMode(`${field}-${direction}` as SidebarSortMode)
    },
    [handleSelectSortMode, sortMode],
  )
  const handleClearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchTitleOnly(false)
    setSearchAllBranches(false)
    setSearchIncludeArchived(false)
    setIncludeFolderIds([])
    setExcludeFolderIds([])
    setIncludeTagIds([])
    setExcludeTagIds([])
  }, [])
  const toggleFolderFilter = useCallback(
    (folderId: FolderId) => {
      const state = filterState(folderId, includeFolderIds, excludeFolderIds)
      if (state === 'none') {
        setIncludeFolderIds([...includeFolderIds, folderId])
        setExcludeFolderIds(excludeFolderIds.filter((id) => id !== folderId))
      } else if (state === 'include') {
        setIncludeFolderIds(includeFolderIds.filter((id) => id !== folderId))
        setExcludeFolderIds([...excludeFolderIds, folderId])
      } else {
        setExcludeFolderIds(excludeFolderIds.filter((id) => id !== folderId))
      }
    },
    [excludeFolderIds, includeFolderIds],
  )
  const toggleTagFilter = useCallback(
    (tagId: TagId) => {
      const state = filterState(tagId, includeTagIds, excludeTagIds)
      if (state === 'none') {
        setIncludeTagIds([...includeTagIds, tagId])
        setExcludeTagIds(excludeTagIds.filter((id) => id !== tagId))
      } else if (state === 'include') {
        setIncludeTagIds(includeTagIds.filter((id) => id !== tagId))
        setExcludeTagIds([...excludeTagIds, tagId])
      } else {
        setExcludeTagIds(excludeTagIds.filter((id) => id !== tagId))
      }
    },
    [excludeTagIds, includeTagIds],
  )
  const withBusyChatAction = useCallback(async (key: string, action: () => Promise<void>) => {
    setBusyChatAction(key)
    try {
      await action()
    } finally {
      setBusyChatAction(null)
    }
  }, [])
  const handleSelectAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedChatIds(checked ? new Set(tableRowIds) : new Set())
      setSelectionAnchorId(checked ? (tableRowIds.at(-1) ?? null) : null)
    },
    [tableRowIds],
  )
  const handleSelectChat = useCallback(
    (chatId: ChatId, event: Pick<MouseEvent<HTMLElement>, 'shiftKey' | 'metaKey' | 'ctrlKey'>) => {
      if (event.shiftKey && selectionAnchorId && tableRowIndexById.has(selectionAnchorId)) {
        const anchorIndex = tableRowIndexById.get(selectionAnchorId) as number
        const targetIndex = tableRowIndexById.get(chatId)
        if (targetIndex !== undefined) {
          const start = Math.min(anchorIndex, targetIndex)
          const end = Math.max(anchorIndex, targetIndex)
          setSelectedChatIds((current) => {
            const next = new Set(current)
            for (const row of tableRows.slice(start, end + 1)) next.add(row.id)
            return next
          })
          return
        }
      }
      setSelectedChatIds((current) => {
        const next = new Set(current)
        if (next.has(chatId)) next.delete(chatId)
        else next.add(chatId)
        return next
      })
      setSelectionAnchorId(chatId)
    },
    [selectionAnchorId, tableRowIndexById, tableRows],
  )
  const clearSelection = useCallback(() => {
    setSelectedChatIds(new Set())
    setSelectionAnchorId(null)
  }, [])
  const handleDownloadSelection = useCallback(async () => {
    if (selectedChats.length === 0) return
    const chatIds = selectedChats.map((chat) => chat.id)
    await withBusyChatAction('bulk:download', async () => {
      if (chatIds.length === 1) {
        const { filename, content } = await exportLastUpdatedChatAsTxt(chatIds[0] as ChatId)
        triggerBrowserDownload(filename, content)
        return
      }
      const { filename, blob } = await exportLastUpdatedChatsAsZip(chatIds)
      triggerBrowserBlobDownload(filename, blob)
    })
  }, [selectedChats, withBusyChatAction])
  const handleMoveSelection = useCallback(async () => {
    if (selectedChats.length === 0) return
    const defaultName = sharedFolderName(selectedChats, folderById)
    const name = window.prompt(
      `Move ${selectedChats.length} ${pluralize('chat', selectedChats.length)} to folder (blank removes folder)`,
      defaultName,
    )
    if (name === null) return
    await withBusyChatAction('bulk:move', async () => {
      const trimmed = name.trim()
      if (trimmed.length === 0) {
        await moveChatsToFolder(
          selectedChats.map((chat) => chat.id),
          null,
        )
        return
      }
      const existing = model.folders.find(
        (folder) => folder.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
      )
      const folder = existing ?? (await createFolder({ name: trimmed }))
      await moveChatsToFolder(
        selectedChats.map((chat) => chat.id),
        folder.id,
      )
    })
  }, [folderById, model.folders, selectedChats, withBusyChatAction])
  const handleSetSelectedTags = useCallback(async () => {
    if (selectedChats.length === 0) return
    const defaultNames = sharedTagNames(selectedChats, tagById)
    const value = window.prompt(
      `Tags for ${selectedChats.length} ${pluralize('chat', selectedChats.length)}, comma-separated`,
      defaultNames,
    )
    if (value === null) return
    await withBusyChatAction('bulk:tags', async () => {
      await setChatsTagsFromNames(
        selectedChats.map((chat) => chat.id),
        tagNamesFromPrompt(value),
      )
    })
  }, [selectedChats, tagById, withBusyChatAction])
  const handleDeleteSelection = useCallback(async () => {
    if (selectedChats.length === 0) return
    const archivedCount = selectedChats.filter((chat) => chat.archived).length
    const liveCount = selectedChats.length - archivedCount
    const message =
      archivedCount > 0 && liveCount > 0
        ? `Archive ${liveCount} live ${pluralize('chat', liveCount)} and permanently delete ${archivedCount} archived ${pluralize('chat', archivedCount)}?`
        : archivedCount > 0
          ? `Permanently delete ${archivedCount} archived ${pluralize('chat', archivedCount)}? This cannot be undone.`
          : `Delete ${liveCount} ${pluralize('chat', liveCount)}? They will move to the archive.`
    if (!window.confirm(message)) return
    await withBusyChatAction('bulk:delete', async () => {
      await Promise.all(
        selectedChats.map((chat) =>
          chat.archived ? deleteArchivedChatPermanently(chat.id) : archiveChat(chat.id),
        ),
      )
      clearSelection()
    })
  }, [clearSelection, selectedChats, withBusyChatAction])
  const handleUnarchiveSelection = useCallback(async () => {
    const archivedChats = selectedChats.filter((chat) => chat.archived)
    if (archivedChats.length === 0) return
    await withBusyChatAction('bulk:unarchive', async () => {
      await Promise.all(archivedChats.map((chat) => unarchiveChat(chat.id)))
    })
  }, [selectedChats, withBusyChatAction])
  const handleClearCalibration = useCallback(async (chatId: ChatId, calibrationKey?: string) => {
    const busyKey = `${chatId}:${calibrationKey ?? '*'}`
    setBusyCalibration(busyKey)
    try {
      await clearChatTokenCalibration(chatId, calibrationKey)
    } finally {
      setBusyCalibration(null)
    }
  }, [])
  return (
    <section data-ui="storage-chats">
      <div data-ui="storage-chat-toolbar">
        <label data-ui="storage-chat-search">
          <SearchIcon size={14} />
          <input
            data-ui="storage-chat-search-input"
            type="search"
            value={searchQuery}
            placeholder="Search chats"
            aria-label="Search chats"
            onChange={(event) => setSearchQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') handleClearSearch()
            }}
          />
          {searchTextActive ? (
            <span data-ui="storage-chat-search-progress">
              {status === 'scanning' || status === 'debouncing'
                ? `${completed}/${total}`
                : `${sortedSearchResults.length}`}
            </span>
          ) : null}
          {searchTextActive || searchHasFilters ? (
            <button
              type="button"
              data-ui="storage-chat-search-clear"
              aria-label="Clear search"
              title="Clear search"
              onClick={handleClearSearch}
            >
              <CloseIcon size={13} />
            </button>
          ) : null}
        </label>
        <label data-ui="storage-chat-sort">
          <SortIcon size={14} />
          <select
            value={sortMode}
            aria-label={`Sort: ${activeSortOption.label}`}
            onChange={(event) => handleSelectSortMode(event.currentTarget.value as SidebarSortMode)}
          >
            {SIDEBAR_SORT_OPTIONS.map((option) => (
              <option key={option.mode} value={option.mode}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <span data-ui="storage-chat-count">
          {searchTextActive || searchHasFilters ? tableRows.length : live} live / {archived}{' '}
          archived
        </span>
      </div>
      <div data-ui="storage-chat-filters">
        <label>
          <input
            type="checkbox"
            checked={searchTitleOnly}
            onChange={(event) => setSearchTitleOnly(event.currentTarget.checked)}
          />
          <span>Title</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={searchAllBranches}
            onChange={(event) => setSearchAllBranches(event.currentTarget.checked)}
          />
          <span>Branches</span>
        </label>
        <label>
          <input
            type="checkbox"
            checked={searchIncludeArchived}
            onChange={(event) => setSearchIncludeArchived(event.currentTarget.checked)}
          />
          <span>Archive</span>
        </label>
      </div>
      {model.folders.length > 0 ? (
        <section data-ui="storage-chat-filter-group">
          <span>
            <FolderIcon size={12} />
            Folders
          </span>
          <div data-ui="storage-chat-chip-row">
            {model.folders.map((folder) => (
              <button
                key={folder.id}
                type="button"
                data-filter-state={filterState(folder.id, includeFolderIds, excludeFolderIds)}
                title={filterTitle(folder.name, includeFolderIds, excludeFolderIds, folder.id)}
                onClick={() => toggleFolderFilter(folder.id)}
              >
                {folder.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {model.tags.length > 0 ? (
        <section data-ui="storage-chat-filter-group">
          <span>
            <TagIcon size={12} />
            Tags
          </span>
          <div data-ui="storage-chat-chip-row">
            {model.tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                data-filter-state={filterState(tag.id, includeTagIds, excludeTagIds)}
                title={filterTitle(tag.name, includeTagIds, excludeTagIds, tag.id)}
                onClick={() => toggleTagFilter(tag.id)}
              >
                {tag.name}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {searchSession?.status === 'error' && searchSession.error ? (
        <div data-ui="storage-chat-search-error">{searchSession.error}</div>
      ) : null}
      {selectedChats.length > 0 ? (
        <div data-ui="storage-chat-selection-toolbar">
          <span data-ui="storage-chat-selection-count">
            {selectedChats.length} selected
            {selectedArchivedCount > 0 ? ` (${selectedArchivedCount} archived)` : ''}
          </span>
          <span data-ui="storage-chat-selection-actions">
            <button
              type="button"
              data-ui="storage-chat-bulk-download"
              disabled={Boolean(busyChatAction)}
              onClick={() => void handleDownloadSelection()}
            >
              <DownloadIcon size={14} />
              Download
            </button>
            <button
              type="button"
              data-ui="storage-chat-bulk-move"
              disabled={Boolean(busyChatAction)}
              onClick={() => void handleMoveSelection()}
            >
              <FolderIcon size={14} />
              Move
            </button>
            <button
              type="button"
              data-ui="storage-chat-bulk-tags"
              disabled={Boolean(busyChatAction)}
              onClick={() => void handleSetSelectedTags()}
            >
              <TagIcon size={14} />
              Tags
            </button>
            {selectedArchivedCount > 0 ? (
              <button
                type="button"
                data-ui="storage-chat-bulk-unarchive"
                disabled={Boolean(busyChatAction)}
                onClick={() => void handleUnarchiveSelection()}
              >
                <UnarchiveIcon size={14} />
                Unarchive
              </button>
            ) : null}
            {selectedLiveCount > 0 ? (
              <button
                type="button"
                data-ui="storage-chat-bulk-archive"
                disabled={Boolean(busyChatAction)}
                onClick={() =>
                  void withBusyChatAction('bulk:archive', async () => {
                    await Promise.all(
                      selectedChats
                        .filter((chat) => !chat.archived)
                        .map((chat) => archiveChat(chat.id)),
                    )
                  })
                }
              >
                <ArchiveIcon size={14} />
                Archive
              </button>
            ) : null}
            <button
              type="button"
              data-ui="storage-chat-bulk-delete"
              data-tone="danger"
              disabled={Boolean(busyChatAction)}
              onClick={() => void handleDeleteSelection()}
            >
              <TrashIcon size={14} />
              Delete
            </button>
            <button type="button" disabled={Boolean(busyChatAction)} onClick={clearSelection}>
              Clear
            </button>
          </span>
        </div>
      ) : null}
      <div data-ui="storage-chat-table-wrap">
        <table data-ui="storage-chat-table" data-sort-key={sortMode}>
          <thead>
            <tr>
              <th scope="col" data-ui="storage-chat-select-header">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="Select all visible chats"
                  checked={tableRows.length > 0 && selectedChats.length === tableRows.length}
                  disabled={tableRows.length === 0}
                  onChange={(event) => handleSelectAllVisible(event.currentTarget.checked)}
                />
              </th>
              <StorageSortableHeader
                label="Title"
                field="title"
                sortMode={sortMode}
                onSort={handleColumnSort}
              />
              <th scope="col">Preview</th>
              <StorageSortableHeader
                label="Updated"
                field="updatedAt"
                sortMode={sortMode}
                onSort={handleColumnSort}
              />
              <StorageSortableHeader
                label="Created"
                field="createdAt"
                sortMode={sortMode}
                onSort={handleColumnSort}
              />
              <StorageSortableHeader
                label="Viewed"
                field="lastViewedAt"
                sortMode={sortMode}
                onSort={handleColumnSort}
              />
              <StorageSortableHeader
                label="Cost"
                field="totalCostUsd"
                sortMode={sortMode}
                onSort={handleColumnSort}
              />
              <StorageSortableHeader
                label="Words"
                field="wordCount"
                sortMode={sortMode}
                onSort={handleColumnSort}
              />
              <th scope="col">Folder</th>
              <th scope="col">Tags</th>
              <th scope="col">Calibration</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.length === 0 ? (
              <tr>
                <td colSpan={11} data-ui="storage-chat-empty">
                  {searchTextActive || searchHasFilters ? 'No matches' : 'No chats'}
                </td>
              </tr>
            ) : (
              tableRows.map((chat) => {
                const title = displayChatTitle(chat)
                const href = chatHref(chat.id)
                const searchResult = searchResultByChatId.get(chat.id)
                const preview = searchResult?.snippet || chat.previewText || shortId(chat.id)
                const calibrationRows = calibrationEntries(model.calibrations.get(chat.id))
                const calibrationOpen = openCalibrationChatId === chat.id
                const selected = selectedChatIds.has(chat.id)
                return (
                  <Fragment key={chat.id}>
                    <tr
                      data-ui="storage-chat-row"
                      data-archived={chat.archived ? 'true' : undefined}
                      data-selected={selected ? 'true' : undefined}
                      onClick={(event) => {
                        if (!event.shiftKey && !event.metaKey && !event.ctrlKey) return
                        const target = event.target
                        if (
                          target instanceof Element &&
                          target.closest('a, button, input, select, textarea')
                        ) {
                          return
                        }
                        handleSelectChat(chat.id, event)
                      }}
                    >
                      <td data-ui="storage-chat-select-cell">
                        <input
                          data-ui="storage-chat-select"
                          type="checkbox"
                          aria-label={`Select ${title}`}
                          checked={selected}
                          onClick={(event) => handleSelectChat(chat.id, event)}
                          readOnly
                        />
                      </td>
                      <td data-ui="storage-chat-title-cell">
                        <a href={href} onClick={makeAnchorClickHandler(href)}>
                          {title}
                        </a>
                        {chat.archived ? <span data-ui="storage-chat-state">Archived</span> : null}
                      </td>
                      <td data-ui="storage-chat-preview-cell">
                        <a href={href} onClick={makeAnchorClickHandler(href)}>
                          {preview}
                        </a>
                      </td>
                      <td>{formatDate(chat.updatedAt)}</td>
                      <td>{formatDate(chat.createdAt)}</td>
                      <td>{formatDate(chat.lastViewedAt)}</td>
                      <td>{formatCost(chat.totalCostUsd)}</td>
                      <td>{formatInteger(chat.wordCount)}</td>
                      <td>{folderLabel(chat.folderId, folderById)}</td>
                      <td data-ui="storage-chat-tags-cell">{tagLabels(chat.tags, tagById)}</td>
                      <td>
                        <button
                          type="button"
                          data-ui="storage-chat-calibration-button"
                          aria-expanded={calibrationOpen}
                          onClick={() =>
                            setOpenCalibrationChatId((current) =>
                              current === chat.id ? null : chat.id,
                            )
                          }
                        >
                          {calibrationLabel(calibrationRows)}
                          <ChevronIcon size={12} rotate={calibrationOpen ? 90 : 0} />
                        </button>
                      </td>
                    </tr>
                    {calibrationOpen ? (
                      <tr data-ui="storage-chat-calibration-row">
                        <td colSpan={11}>
                          <div data-ui="storage-chat-calibration-detail">
                            <div data-ui="storage-chat-calibration-detail-header">
                              <strong>{title}</strong>
                              <button
                                type="button"
                                data-ui="storage-action"
                                disabled={
                                  calibrationRows.length === 0 || busyCalibration === `${chat.id}:*`
                                }
                                onClick={() => void handleClearCalibration(chat.id)}
                              >
                                <TrashIcon size={13} />
                                Clear all calibration
                              </button>
                            </div>
                            {calibrationRows.length === 0 ? (
                              <span data-ui="helper">No chat calibration.</span>
                            ) : (
                              <div data-ui="storage-chat-calibration-list">
                                {calibrationRows.map(([key, sample]) => (
                                  <div key={key} data-ui="storage-chat-calibration-item">
                                    <span data-ui="storage-chat-calibration-key">{key}</span>
                                    <span>{formatCalibrationRatio(sample)}</span>
                                    <span>{formatInteger(sample.sampleCount)} samples</span>
                                    <span>{formatDate(sample.updatedAt)}</span>
                                    <button
                                      type="button"
                                      data-ui="storage-action"
                                      disabled={busyCalibration === `${chat.id}:${key}`}
                                      onClick={() => void handleClearCalibration(chat.id, key)}
                                    >
                                      Clear
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function StorageSortableHeader({
  label,
  field,
  sortMode,
  onSort,
}: {
  label: string
  field: ReturnType<typeof sidebarSortField>
  sortMode: SidebarSortMode
  onSort: (field: ReturnType<typeof sidebarSortField>) => void
}) {
  const active = sidebarSortField(sortMode) === field
  const direction = sidebarSortDirection(sortMode)
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        data-ui="storage-chat-sort-header"
        data-active={active ? 'true' : undefined}
        onClick={() => onSort(field)}
      >
        <span>{label}</span>
        <ChevronIcon size={12} rotate={active && direction === 'asc' ? 270 : 90} />
      </button>
    </th>
  )
}

function calibrationEntries(
  samples: Record<string, TokenCalibrationSample> | undefined,
): Array<[string, TokenCalibrationSample]> {
  return Object.entries(aggregateCalibrationSamples(samples)).sort(([left], [right]) =>
    left.localeCompare(right),
  )
}

function calibrationLabel(entries: readonly [string, TokenCalibrationSample][]): string {
  if (entries.length === 0) return 'None'
  if (entries.length === 1) return '1 family'
  return `${entries.length} families`
}

function formatCalibrationRatio(sample: TokenCalibrationSample): string {
  if (sample.totalTextTokens <= 0) return 'Unknown ratio'
  const ratio = sample.totalTextChars / sample.totalTextTokens
  if (!Number.isFinite(ratio) || ratio <= 0) return 'Unknown ratio'
  return `${ratio.toFixed(2)} chars/token`
}

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  if (value < 0.01) return '<$0.01'
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Math.max(0, Math.round(value)).toLocaleString()
}

function folderLabel(
  folderId: FolderId | null,
  folderById: ReadonlyMap<FolderId, ChatFolder>,
): string {
  if (!folderId) return 'Top-level'
  return folderById.get(folderId)?.name ?? 'Missing folder'
}

function sharedFolderName(
  chats: readonly ChatSidebarRow[],
  folderById: ReadonlyMap<FolderId, ChatFolder>,
): string {
  if (chats.length === 0) return ''
  const folderId = chats[0]?.folderId ?? null
  if (chats.some((chat) => (chat.folderId ?? null) !== folderId)) return ''
  return folderId ? (folderById.get(folderId)?.name ?? '') : ''
}

function tagLabels(tagIds: readonly TagId[], tagById: ReadonlyMap<TagId, ChatTag>): ReactNode {
  const names = tagIds
    .map((tagId) => tagById.get(tagId)?.name)
    .filter((name): name is string => Boolean(name))
  if (names.length === 0) return 'None'
  return (
    <span data-ui="storage-chat-tag-list">
      {names.map((name) => (
        <span key={name} data-ui="storage-chat-tag">
          {name}
        </span>
      ))}
    </span>
  )
}

function sharedTagNames(
  chats: readonly ChatSidebarRow[],
  tagById: ReadonlyMap<TagId, ChatTag>,
): string {
  if (chats.length === 0) return ''
  const firstKey = normalizedTagSetKey(chats[0]?.tags ?? [])
  if (chats.some((chat) => normalizedTagSetKey(chat.tags) !== firstKey)) return ''
  return (chats[0]?.tags ?? [])
    .map((tagId) => tagById.get(tagId)?.name)
    .filter((name): name is string => Boolean(name))
    .join(', ')
}

function normalizedTagSetKey(tagIds: readonly TagId[]): string {
  return [...tagIds].sort().join('\u0000')
}

function tagNamesFromPrompt(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function pluralize(word: string, count: number): string {
  if (count === 1) return word
  return word.endsWith('y') ? `${word.slice(0, -1)}ies` : `${word}s`
}

function filterState(id: string, includeIds: readonly string[], excludeIds: readonly string[]) {
  if (includeIds.includes(id)) return 'include'
  if (excludeIds.includes(id)) return 'exclude'
  return 'none'
}

function filterTitle(
  name: string,
  includeIds: readonly string[],
  excludeIds: readonly string[],
  id: string,
): string {
  const state = filterState(id, includeIds, excludeIds)
  if (state === 'include') return `Including ${name}; click to exclude`
  if (state === 'exclude') return `Excluding ${name}; click to clear`
  return `Click to include ${name}`
}

function chatPassesStorageFilters(chat: ChatSidebarRow, filters: SearchFilters): boolean {
  if (filters.archived === 'exclude' && chat.archived) return false
  if (filters.archived === 'only' && !chat.archived) return false
  if (
    filters.includeFolderIds.length > 0 &&
    (!chat.folderId || !filters.includeFolderIds.includes(chat.folderId))
  ) {
    return false
  }
  if (chat.folderId && filters.excludeFolderIds.includes(chat.folderId)) return false
  if (
    filters.includeTagIds.length > 0 &&
    !chat.tags.some((tagId) => filters.includeTagIds.includes(tagId))
  ) {
    return false
  }
  if (chat.tags.some((tagId) => filters.excludeTagIds.includes(tagId))) return false
  return true
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

function displayChatTitle(chat: { title: string }): string {
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

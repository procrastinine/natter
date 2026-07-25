import { useVirtualizer } from '@tanstack/react-virtual'
import {
  type ChangeEvent,
  Fragment,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { chatHref, makeAnchorClickHandler } from '../../app/router'
import {
  compareSidebarChatRows,
  SIDEBAR_SORT_OPTIONS,
  type SidebarSortMode,
  sidebarSortDirection,
  sidebarSortField,
  sidebarSortOption,
} from '../../core/sidebar-sort'
import { aggregateCalibrationSamples } from '../../core/token-calibration'
import type {
  ChatFolder,
  ChatId,
  ChatSidebarRow,
  ChatTag,
  FolderId,
  TagId,
  TokenCalibrationSample,
} from '../../core/types'
import {
  catalogSidebarSortMode,
  DEFAULT_SEARCH_FILTERS,
  hasActiveSearchFilters,
  type SearchFilters,
  useCatalogTab,
  useChatCatalogSearch,
} from '../../hooks/useCatalogApplication'
import { useConfigurationPreferences } from '../../hooks/useConfigurationPreferences'
import { useStorageChatCatalogApplication } from '../../hooks/useStorageCatalogApplication'
import { storageApplication } from '../../store/storage-application'
import { useToastStore } from '../../store/zustand/toastStore'
import { formatDate, shortId } from '../attachments/format'
import {
  ArchiveIcon,
  ChevronIcon,
  CloseIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  SearchIcon,
  SortIcon,
  TagIcon,
  TrashIcon,
  UnarchiveIcon,
  UploadIcon,
} from '../icons/Icon'
import {
  exportLastUpdatedChatAsTxt,
  exportLastUpdatedChatsAsZip,
  triggerBrowserBlobDownload,
  triggerBrowserDownload,
} from '../import-export/chat-download'
import {
  forEachJsonOrZipFile,
  importExportErrorMessage,
  natterJsonFilename,
  natterZipFilename,
  triggerJsonDownload,
  triggerJsonZipDownload,
} from '../import-export/json-file'
import { Button, IconButton } from '../primitives/Button'
import { useVirtualSpacerHeight } from '../primitives/virtual-spacer'
import { isEmptySidebarDraft } from '../sidebar/chat-organization'

import {
  displayChatTitle,
  formatCalibrationRatio,
  formatInteger,
  permanentDeleteBlockedMessage,
  pluralize,
} from './storage-surface-shared'

const EMPTY_CHAT_ROWS: readonly ChatSidebarRow[] = Object.freeze([])
const EMPTY_CHAT_FOLDERS: readonly ChatFolder[] = Object.freeze([])
const EMPTY_CHAT_TAGS: readonly ChatTag[] = Object.freeze([])
const EMPTY_CHAT_CALIBRATIONS: ReadonlyMap<
  ChatId,
  Readonly<Record<string, TokenCalibrationSample>> | undefined
> = new Map()

export default function ChatsStorageSurface() {
  const pushToast = useToastStore((s) => s.push)
  const tab = useCatalogTab()
  const configurationPreferences = useConfigurationPreferences()
  const sortMode = catalogSidebarSortMode(tab, configurationPreferences)
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
  const [selectedRowsById, setSelectedRowsById] = useState<Map<ChatId, ChatSidebarRow>>(
    () => new Map(),
  )
  const [selectAllMatching, setSelectAllMatching] = useState(false)
  const [excludedMatchingIds, setExcludedMatchingIds] = useState<Set<ChatId>>(() => new Set())
  const [selectionAnchorId, setSelectionAnchorId] = useState<ChatId | null>(null)
  const [busyChatAction, setBusyChatAction] = useState<string | null>(null)
  const [busyCalibration, setBusyCalibration] = useState<string | null>(null)
  const selectAllRef = useRef<HTMLInputElement | null>(null)
  const chatImportInputRef = useRef<HTMLInputElement | null>(null)
  const chatTableScrollRef = useRef<HTMLDivElement | null>(null)
  const activeSortOption = sidebarSortOption(sortMode)
  const catalogRequest = useMemo(
    () => ({
      orderBy: sidebarSortField(sortMode),
      direction: sidebarSortDirection(sortMode),
      archived: searchIncludeArchived ? ('include' as const) : ('exclude' as const),
      includeFolderIds,
      excludeFolderIds,
      includeTagIds,
      excludeTagIds,
      excludeEmptyDrafts: true,
    }),
    [
      excludeFolderIds,
      excludeTagIds,
      includeFolderIds,
      includeTagIds,
      searchIncludeArchived,
      sortMode,
    ],
  )
  const {
    session: chatCatalogSession,
    nextPage: nextChatCatalogPage,
    previousPage: previousChatCatalogPage,
    demandCalibrations,
    collectMatchingRows,
    resolveRows,
  } = useStorageChatCatalogApplication(catalogRequest)
  const catalogRows = chatCatalogSession?.page.rows ?? EMPTY_CHAT_ROWS
  const folders = chatCatalogSession?.folders ?? EMPTY_CHAT_FOLDERS
  const tags = chatCatalogSession?.tags ?? EMPTY_CHAT_TAGS
  const calibrations = chatCatalogSession?.calibrations ?? EMPTY_CHAT_CALIBRATIONS
  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders])
  const tagById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags])
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
  const { session: searchSession, orderedResults: catalogSearchResults } = useChatCatalogSearch({
    surface: 'storage-chats',
    query: searchQuery,
    scope: searchAllBranches ? 'all-branches' : 'last-updated-branch',
    filters: searchFilters,
    enabled: searchTextActive,
  })
  const sortedSearchResults = useMemo(() => {
    return [...catalogSearchResults].sort((left, right) =>
      compareStorageChatRows(left.chat, right.chat, sortMode),
    )
  }, [catalogSearchResults, sortMode])
  const searchResultByChatId = searchSession?.results.byChatId
  const tableRows = useMemo(() => {
    if (searchTextActive) {
      return sortedSearchResults
        .map((result) => result.chat)
        .filter((chat) => !isEmptySidebarDraft(chat))
    }
    return catalogRows
  }, [catalogRows, searchTextActive, sortedSearchResults])
  const tableRowIds = useMemo(() => tableRows.map((chat) => chat.id), [tableRows])
  const tableRowIndexById = useMemo(
    () => new Map(tableRows.map((chat, index) => [chat.id, index])),
    [tableRows],
  )
  const selectedChats = useMemo(() => [...selectedRowsById.values()], [selectedRowsById])
  const matchingCount = searchTextActive
    ? tableRows.length
    : (chatCatalogSession?.page.exactCount ?? 0)
  const selectedCount = selectAllMatching
    ? Math.max(0, matchingCount - excludedMatchingIds.size)
    : selectedChatIds.size
  const live = chatCatalogSession?.aggregate.visibleCount ?? 0
  const archived = chatCatalogSession?.aggregate.archivedCount ?? 0
  const status = searchSession?.status ?? 'idle'
  const completed = searchSession?.completedCount ?? 0
  const total = searchSession?.candidateCount ?? 0
  const searchPending = searchTextActive && (status === 'debouncing' || status === 'scanning')
  const searchRowsInteractive = searchTextActive
    ? searchSession?.interactive === true
    : chatCatalogSession?.interactive === true
  const selectedArchivedCount = selectAllMatching
    ? searchTextActive
      ? tableRows.filter((chat) => chat.archived && !excludedMatchingIds.has(chat.id)).length
      : searchIncludeArchived
        ? null
        : 0
    : selectedChats.filter((chat) => chat.archived).length
  const selectedLiveCount =
    selectedArchivedCount === null ? null : selectedCount - selectedArchivedCount
  const selectionUniverseKey = useMemo(
    () =>
      JSON.stringify([
        searchTextActive ? searchQuery.trim() : '',
        searchTextActive ? (searchAllBranches ? 'all-branches' : 'last-updated-branch') : 'browse',
        searchFilters,
      ]),
    [searchAllBranches, searchFilters, searchQuery, searchTextActive],
  )
  const chatTableVirtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: tableRows.length,
    getScrollElement: () => chatTableScrollRef.current,
    estimateSize: (index) => (tableRows[index]?.id === openCalibrationChatId ? 210 : 45),
    overscan: 8,
    getItemKey: (index) => tableRows[index]?.id ?? index,
  })
  const measuredChatItems = chatTableVirtualizer.getVirtualItems()
  const chatVirtualItems =
    tableRows.length <= 100
      ? tableRows.map((_, index) => ({ index }))
      : measuredChatItems.length === 0
        ? tableRows.slice(0, 24).map((_, index) => ({ index }))
        : measuredChatItems
  const chatTopSpacer =
    measuredChatItems.length > 0 && tableRows.length > 100 ? (measuredChatItems[0]?.start ?? 0) : 0
  const chatTotalSize =
    measuredChatItems.length > 0 ? chatTableVirtualizer.getTotalSize() : tableRows.length * 45
  const chatBottomSpacer =
    measuredChatItems.length > 0 && tableRows.length > 100
      ? Math.max(0, chatTotalSize - (measuredChatItems.at(-1)?.end ?? 0))
      : tableRows.length > 100
        ? Math.max(0, tableRows.length - 24) * 45
        : 0
  const chatTopSpacerRef = useVirtualSpacerHeight<HTMLTableCellElement>(chatTopSpacer)
  const chatBottomSpacerRef = useVirtualSpacerHeight<HTMLTableCellElement>(chatBottomSpacer)
  const renderedChatIds = useMemo(
    () =>
      chatVirtualItems
        .map((item) => tableRows[item.index]?.id)
        .filter((chatId): chatId is ChatId => Boolean(chatId)),
    [chatVirtualItems, tableRows],
  )

  useEffect(() => {
    void selectionUniverseKey
    setSelectedChatIds(new Set())
    setSelectedRowsById(new Map())
    setSelectAllMatching(false)
    setExcludedMatchingIds(new Set())
    setSelectionAnchorId(null)
  }, [selectionUniverseKey])
  useEffect(() => {
    if (!selectAllRef.current) return
    selectAllRef.current.indeterminate =
      selectedCount > 0 && (!selectAllMatching || excludedMatchingIds.size > 0)
  }, [excludedMatchingIds.size, selectAllMatching, selectedCount])
  useEffect(() => {
    demandCalibrations(renderedChatIds)
  }, [demandCalibrations, renderedChatIds])
  useEffect(() => {
    void openCalibrationChatId
    chatTableVirtualizer.measure()
  }, [chatTableVirtualizer, openCalibrationChatId])

  const handleSelectSortMode = useCallback((mode: SidebarSortMode) => {
    void storageApplication.tab.setSidebarSortMode(mode).catch((error: unknown) => {
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
      handleSelectSortMode(`${field}-${direction}`)
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
  const withBusyChatAction = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusyChatAction(key)
      try {
        await action()
      } catch (error) {
        const message = permanentDeleteBlockedMessage(error)
        if (!message) throw error
        pushToast({ level: 'warning', text: message })
      } finally {
        setBusyChatAction(null)
      }
    },
    [pushToast],
  )
  const handleSelectAllVisible = useCallback(
    (checked: boolean) => {
      setSelectAllMatching(checked)
      setExcludedMatchingIds(new Set())
      setSelectedChatIds(new Set())
      setSelectedRowsById(new Map())
      setSelectionAnchorId(checked ? (tableRowIds.at(-1) ?? null) : null)
    },
    [tableRowIds],
  )
  const handleSelectChat = useCallback(
    (chatId: ChatId, event: Pick<MouseEvent<HTMLElement>, 'shiftKey' | 'metaKey' | 'ctrlKey'>) => {
      const row = tableRows[tableRowIndexById.get(chatId) ?? -1]
      if (!row) return
      if (selectAllMatching) {
        setExcludedMatchingIds((current) => {
          const next = new Set(current)
          if (next.has(chatId)) next.delete(chatId)
          else next.add(chatId)
          return next
        })
        setSelectionAnchorId(chatId)
        return
      }
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
          setSelectedRowsById((current) => {
            const next = new Map(current)
            for (const row of tableRows.slice(start, end + 1)) next.set(row.id, row)
            return next
          })
          return
        }
      }
      const selected = selectedChatIds.has(chatId)
      setSelectedChatIds((current) => {
        const next = new Set(current)
        if (selected) next.delete(chatId)
        else next.add(chatId)
        return next
      })
      setSelectedRowsById((current) => {
        const next = new Map(current)
        if (selected) next.delete(chatId)
        else next.set(chatId, row)
        return next
      })
      setSelectionAnchorId(chatId)
    },
    [selectAllMatching, selectedChatIds, selectionAnchorId, tableRowIndexById, tableRows],
  )
  const clearSelection = useCallback(() => {
    setSelectedChatIds(new Set())
    setSelectedRowsById(new Map())
    setSelectAllMatching(false)
    setExcludedMatchingIds(new Set())
    setSelectionAnchorId(null)
  }, [])
  const resolveCurrentSelection = useCallback(async (): Promise<readonly ChatSidebarRow[]> => {
    if (selectAllMatching) {
      const matching = searchTextActive ? tableRows : await collectMatchingRows()
      return matching.filter((chat) => !excludedMatchingIds.has(chat.id))
    }
    return resolveRows([...selectedChatIds])
  }, [
    collectMatchingRows,
    excludedMatchingIds,
    resolveRows,
    searchTextActive,
    selectAllMatching,
    selectedChatIds,
    tableRows,
  ])
  const handleDownloadSelection = useCallback(async () => {
    if (selectedCount === 0) return
    await withBusyChatAction('bulk:download', async () => {
      const chatIds = (await resolveCurrentSelection()).map((chat) => chat.id)
      if (chatIds.length === 0) return
      if (chatIds.length === 1) {
        const { filename, content } = await exportLastUpdatedChatAsTxt(chatIds[0] as ChatId)
        triggerBrowserDownload(filename, content)
        return
      }
      const { filename, blob } = await exportLastUpdatedChatsAsZip(chatIds)
      triggerBrowserBlobDownload(filename, blob)
    })
  }, [resolveCurrentSelection, selectedCount, withBusyChatAction])
  const handleExportSelection = useCallback(async () => {
    if (selectedCount === 0) return
    const actionId = selectedCount === 1 ? 'export:selected' : 'bulk:export-json'
    await withBusyChatAction(actionId, async () => {
      try {
        const chats = await resolveCurrentSelection()
        if (chats.length === 0) return
        if (chats.length === 1) {
          const chat = chats[0]
          if (!chat) return
          const envelope = await storageApplication.transfer.exportChat(chat.id)
          triggerJsonDownload(natterJsonFilename('chat', displayChatTitle(chat), chat.id), envelope)
          pushToast({ level: 'success', text: 'Exported chat JSON.', durationMs: 2500 })
          return
        }
        const pendingEntries = chats.map((chat) => ({
          chat,
          filename: natterJsonFilename('chat', displayChatTitle(chat), chat.id),
        }))
        const entries = pendingEntries.map(({ chat, filename }) => ({
          filename,
          loadValue: () => storageApplication.transfer.exportChat(chat.id),
        }))
        await triggerJsonZipDownload(natterZipFilename('chats'), entries)
        pushToast({
          level: 'success',
          text: `Exported ${chats.length} chat JSON files.`,
          durationMs: 2500,
        })
      } catch (error) {
        console.error('Failed to export chat JSON', error)
        pushToast({ level: 'danger', text: importExportErrorMessage(error) })
      }
    })
  }, [pushToast, resolveCurrentSelection, selectedCount, withBusyChatAction])
  const handleImportChatFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget
      const file = input.files?.[0] ?? null
      input.value = ''
      if (!file) return
      setBusyChatAction('import')
      try {
        let importedCount = 0
        let lastChatId = ''
        await forEachJsonOrZipFile(file, async (value) => {
          const result = await storageApplication.transfer.importChat(value)
          importedCount += 1
          lastChatId = result.chatId
        })
        pushToast({
          level: 'success',
          text:
            importedCount === 1
              ? `Imported chat ${shortId(lastChatId)}.`
              : `Imported ${importedCount} chats.`,
          durationMs: 3000,
        })
      } catch (error) {
        console.error('Failed to import chat JSON/ZIP', error)
        pushToast({ level: 'danger', text: importExportErrorMessage(error) })
      } finally {
        setBusyChatAction(null)
      }
    },
    [pushToast],
  )
  const handleMoveSelection = useCallback(async () => {
    if (selectedCount === 0) return
    const chats = await resolveCurrentSelection()
    if (chats.length === 0) return
    const defaultName = sharedFolderName(chats, folderById)
    const name = window.prompt(
      `Move ${chats.length} ${pluralize('chat', chats.length)} to folder (blank removes folder)`,
      defaultName,
    )
    if (name === null) return
    await withBusyChatAction('bulk:move', async () => {
      const trimmed = name.trim()
      if (trimmed.length === 0) {
        await storageApplication.chat.moveManyToFolder(
          chats.map((chat) => chat.id),
          null,
        )
        return
      }
      await storageApplication.folder.ensureAndMoveChats({
        name: trimmed,
        chatIds: chats.map((chat) => chat.id),
      })
    })
  }, [folderById, resolveCurrentSelection, selectedCount, withBusyChatAction])
  const handleSetSelectedTags = useCallback(async () => {
    if (selectedCount === 0) return
    const chats = await resolveCurrentSelection()
    if (chats.length === 0) return
    const defaultNames = sharedTagNames(chats, tagById)
    const value = window.prompt(
      `Tags for ${chats.length} ${pluralize('chat', chats.length)}, comma-separated`,
      defaultNames,
    )
    if (value === null) return
    await withBusyChatAction('bulk:tags', async () => {
      await storageApplication.chat.setManyTagsFromNames(
        chats.map((chat) => chat.id),
        tagNamesFromPrompt(value),
      )
    })
  }, [resolveCurrentSelection, selectedCount, tagById, withBusyChatAction])
  const handleDeleteSelection = useCallback(async () => {
    if (selectedCount === 0) return
    const chats = await resolveCurrentSelection()
    if (chats.length === 0) return
    const archivedCount = chats.filter((chat) => chat.archived).length
    const liveCount = chats.length - archivedCount
    const message =
      archivedCount > 0 && liveCount > 0
        ? `Archive ${liveCount} live ${pluralize('chat', liveCount)} and permanently delete ${archivedCount} archived ${pluralize('chat', archivedCount)}?`
        : archivedCount > 0
          ? `Permanently delete ${archivedCount} archived ${pluralize('chat', archivedCount)}? This cannot be undone.`
          : `Delete ${liveCount} ${pluralize('chat', liveCount)}? They will move to the archive.`
    if (!window.confirm(message)) return
    await withBusyChatAction('bulk:delete', async () => {
      const archivedIds = chats.filter((chat) => chat.archived).map((chat) => chat.id)
      const liveIds = chats.filter((chat) => !chat.archived).map((chat) => chat.id)
      await Promise.all([
        ...(archivedIds.length > 0
          ? [storageApplication.chat.deleteArchivedMany(archivedIds)]
          : []),
        ...(liveIds.length > 0 ? [storageApplication.chat.archiveMany(liveIds)] : []),
      ])
      clearSelection()
    })
  }, [clearSelection, resolveCurrentSelection, selectedCount, withBusyChatAction])
  const handleUnarchiveSelection = useCallback(async () => {
    const archivedChats = (await resolveCurrentSelection()).filter((chat) => chat.archived)
    if (archivedChats.length === 0) return
    await withBusyChatAction('bulk:unarchive', async () => {
      await storageApplication.chat.unarchiveMany(archivedChats.map((chat) => chat.id))
    })
  }, [resolveCurrentSelection, withBusyChatAction])
  const handleClearCalibration = useCallback(async (chatId: ChatId, calibrationKey?: string) => {
    const busyKey = `${chatId}:${calibrationKey ?? '*'}`
    setBusyCalibration(busyKey)
    try {
      await storageApplication.calibration.clearChat(chatId, calibrationKey)
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
            <IconButton
              type="button"
              data-ui="storage-chat-search-clear"
              aria-label="Clear search"
              title="Clear search"
              onClick={handleClearSearch}
            >
              <CloseIcon size={13} />
            </IconButton>
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
        <IconButton
          type="button"
          data-ui="icon-button"
          data-size="lg"
          size="lg"
          data-role="chat-import"
          disabled={Boolean(busyChatAction)}
          onClick={() => chatImportInputRef.current?.click()}
          aria-label="Import chat JSON or ZIP"
          title="Import chat JSON or ZIP"
        >
          <UploadIcon size={16} />
        </IconButton>
        <input
          ref={chatImportInputRef}
          data-ui="storage-chat-import-input"
          type="file"
          accept="application/json,application/zip,.json,.zip"
          hidden
          onChange={(event) => void handleImportChatFile(event)}
        />
        <span data-ui="storage-chat-count">
          {searchTextActive || searchHasFilters
            ? searchTextActive
              ? tableRows.length
              : (chatCatalogSession?.page.exactCount ?? 0)
            : live}{' '}
          live / {archived} archived
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
      {folders.length > 0 ? (
        <section data-ui="storage-chat-filter-group">
          <span>
            <FolderIcon size={12} />
            Folders
          </span>
          <div data-ui="storage-chat-chip-row">
            {folders.map((folder) => (
              <Button
                key={folder.id}
                type="button"
                data-filter-state={filterState(folder.id, includeFolderIds, excludeFolderIds)}
                title={filterTitle(folder.name, includeFolderIds, excludeFolderIds, folder.id)}
                onClick={() => toggleFolderFilter(folder.id)}
              >
                {folder.name}
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      {tags.length > 0 ? (
        <section data-ui="storage-chat-filter-group">
          <span>
            <TagIcon size={12} />
            Tags
          </span>
          <div data-ui="storage-chat-chip-row">
            {tags.map((tag) => (
              <Button
                key={tag.id}
                type="button"
                data-filter-state={filterState(tag.id, includeTagIds, excludeTagIds)}
                title={filterTitle(tag.name, includeTagIds, excludeTagIds, tag.id)}
                onClick={() => toggleTagFilter(tag.id)}
              >
                {tag.name}
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      {searchSession?.status === 'error' && searchSession.error ? (
        <div data-ui="storage-chat-search-error">{searchSession.error}</div>
      ) : null}
      {selectedCount > 0 ? (
        <div data-ui="storage-chat-selection-toolbar">
          <span data-ui="storage-chat-selection-count">
            {selectedCount} selected
            {selectedArchivedCount !== null && selectedArchivedCount > 0
              ? ` (${selectedArchivedCount} archived)`
              : ''}
          </span>
          <span data-ui="storage-chat-selection-actions">
            <Button
              type="button"
              data-ui="storage-chat-bulk-download"
              disabled={Boolean(busyChatAction) || !searchRowsInteractive}
              onClick={() => void handleDownloadSelection()}
            >
              <DownloadIcon size={14} />
              Download
            </Button>
            <Button
              type="button"
              data-ui="storage-chat-bulk-export"
              disabled={Boolean(busyChatAction) || !searchRowsInteractive}
              onClick={() => void handleExportSelection()}
              title={
                selectedCount === 1
                  ? 'Export selected chat JSON'
                  : 'Export selected chats as a JSON ZIP'
              }
            >
              <FileIcon size={14} />
              Export
            </Button>
            <Button
              type="button"
              data-ui="storage-chat-bulk-move"
              disabled={Boolean(busyChatAction) || !searchRowsInteractive}
              onClick={() => void handleMoveSelection()}
            >
              <FolderIcon size={14} />
              Move
            </Button>
            <Button
              type="button"
              data-ui="storage-chat-bulk-tags"
              disabled={Boolean(busyChatAction) || !searchRowsInteractive}
              onClick={() => void handleSetSelectedTags()}
            >
              <TagIcon size={14} />
              Tags
            </Button>
            {selectedArchivedCount === null || selectedArchivedCount > 0 ? (
              <Button
                type="button"
                data-ui="storage-chat-bulk-unarchive"
                disabled={Boolean(busyChatAction) || !searchRowsInteractive}
                onClick={() => void handleUnarchiveSelection()}
              >
                <UnarchiveIcon size={14} />
                Unarchive
              </Button>
            ) : null}
            {selectedLiveCount === null || selectedLiveCount > 0 ? (
              <Button
                type="button"
                data-ui="storage-chat-bulk-archive"
                disabled={Boolean(busyChatAction) || !searchRowsInteractive}
                onClick={() =>
                  void withBusyChatAction('bulk:archive', async () => {
                    const selected = await resolveCurrentSelection()
                    await storageApplication.chat.archiveMany(
                      selected.filter((chat) => !chat.archived).map((chat) => chat.id),
                    )
                  })
                }
              >
                <ArchiveIcon size={14} />
                Archive
              </Button>
            ) : null}
            <Button
              type="button"
              data-ui="storage-chat-bulk-delete"
              tone="danger"
              disabled={Boolean(busyChatAction) || !searchRowsInteractive}
              onClick={() => void handleDeleteSelection()}
            >
              <TrashIcon size={14} />
              Delete
            </Button>
            <Button type="button" disabled={Boolean(busyChatAction)} onClick={clearSelection}>
              Clear
            </Button>
          </span>
        </div>
      ) : null}
      <div ref={chatTableScrollRef} data-ui="storage-chat-table-wrap">
        <table
          data-ui="storage-chat-table"
          data-sort-key={sortMode}
          data-interactive={searchRowsInteractive ? 'true' : 'false'}
        >
          <thead>
            <tr>
              <th scope="col" data-ui="storage-chat-select-header">
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label="Select all matching chats"
                  checked={matchingCount > 0 && selectAllMatching && excludedMatchingIds.size === 0}
                  disabled={matchingCount === 0 || !searchRowsInteractive}
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
                  {searchPending
                    ? 'Searching...'
                    : searchTextActive || searchHasFilters
                      ? 'No matches'
                      : 'No chats'}
                </td>
              </tr>
            ) : (
              <>
                {chatTopSpacer > 0 ? (
                  <tr data-ui="storage-chat-virtual-spacer">
                    <td ref={chatTopSpacerRef} colSpan={11} />
                  </tr>
                ) : null}
                {chatVirtualItems.map((virtual) => {
                  const chat = tableRows[virtual.index]
                  if (!chat) return null
                  const title = displayChatTitle(chat)
                  const searchResult = searchResultByChatId?.get(chat.id)
                  const searchTargetId =
                    searchResult?.messageId ?? searchResult?.branchLeafId ?? undefined
                  const href = chatHref(chat.id, searchTargetId)
                  const preview = searchResult?.snippet || chat.previewText || shortId(chat.id)
                  const calibrationKnown = calibrations.has(chat.id)
                  const calibrationRows = calibrationEntries(calibrations.get(chat.id))
                  const calibrationOpen = openCalibrationChatId === chat.id
                  const selected = selectAllMatching
                    ? !excludedMatchingIds.has(chat.id)
                    : selectedChatIds.has(chat.id)
                  const rowInteractive = searchRowsInteractive
                  return (
                    <Fragment key={chat.id}>
                      <tr
                        ref={
                          tableRows.length > 100 && !calibrationOpen
                            ? chatTableVirtualizer.measureElement
                            : undefined
                        }
                        data-index={virtual.index}
                        data-ui="storage-chat-row"
                        data-archived={chat.archived ? 'true' : undefined}
                        data-selected={selected ? 'true' : undefined}
                        data-interactive={rowInteractive ? 'true' : 'false'}
                        onClick={(event) => {
                          if (!rowInteractive) return
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
                            disabled={!rowInteractive}
                            onClick={(event) => handleSelectChat(chat.id, event)}
                            readOnly
                          />
                        </td>
                        <td data-ui="storage-chat-title-cell">
                          <a
                            href={rowInteractive ? href : undefined}
                            aria-disabled={!rowInteractive || undefined}
                            tabIndex={rowInteractive ? undefined : -1}
                            onClick={rowInteractive ? makeAnchorClickHandler(href) : undefined}
                          >
                            {title}
                          </a>
                          {chat.archived ? (
                            <span data-ui="storage-chat-state">Archived</span>
                          ) : null}
                        </td>
                        <td data-ui="storage-chat-preview-cell">
                          <a
                            href={rowInteractive ? href : undefined}
                            aria-disabled={!rowInteractive || undefined}
                            tabIndex={rowInteractive ? undefined : -1}
                            onClick={rowInteractive ? makeAnchorClickHandler(href) : undefined}
                          >
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
                          <Button
                            type="button"
                            data-ui="storage-chat-calibration-button"
                            aria-expanded={calibrationOpen}
                            disabled={!rowInteractive}
                            onClick={() =>
                              setOpenCalibrationChatId((current) =>
                                current === chat.id ? null : chat.id,
                              )
                            }
                          >
                            {calibrationKnown ? calibrationLabel(calibrationRows) : '…'}
                            <ChevronIcon size={12} rotate={calibrationOpen ? 90 : 0} />
                          </Button>
                        </td>
                      </tr>
                      {calibrationOpen ? (
                        <tr data-ui="storage-chat-calibration-row">
                          <td colSpan={11}>
                            <div data-ui="storage-chat-calibration-detail">
                              <div data-ui="storage-chat-calibration-detail-header">
                                <strong>{title}</strong>
                                <Button
                                  type="button"
                                  data-ui="storage-action"
                                  disabled={
                                    !rowInteractive ||
                                    calibrationRows.length === 0 ||
                                    busyCalibration === `${chat.id}:*`
                                  }
                                  onClick={() => void handleClearCalibration(chat.id)}
                                >
                                  <TrashIcon size={13} />
                                  Clear all calibration
                                </Button>
                              </div>
                              {!calibrationKnown ? (
                                <span data-ui="helper">Loading calibration…</span>
                              ) : calibrationRows.length === 0 ? (
                                <span data-ui="helper">No chat calibration.</span>
                              ) : (
                                <div data-ui="storage-chat-calibration-list">
                                  {calibrationRows.map(([key, sample]) => (
                                    <div key={key} data-ui="storage-chat-calibration-item">
                                      <span data-ui="storage-chat-calibration-key">{key}</span>
                                      <span>{formatCalibrationRatio(sample)}</span>
                                      <span>{formatInteger(sample.sampleCount)} samples</span>
                                      <span>{formatDate(sample.updatedAt)}</span>
                                      <Button
                                        type="button"
                                        data-ui="storage-action"
                                        disabled={
                                          !rowInteractive || busyCalibration === `${chat.id}:${key}`
                                        }
                                        onClick={() => void handleClearCalibration(chat.id, key)}
                                      >
                                        Clear
                                      </Button>
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
                })}
                {chatBottomSpacer > 0 ? (
                  <tr data-ui="storage-chat-virtual-spacer">
                    <td ref={chatBottomSpacerRef} colSpan={11} />
                  </tr>
                ) : null}
              </>
            )}
          </tbody>
        </table>
      </div>
      {!searchTextActive &&
      (chatCatalogSession?.page.previousCursor || chatCatalogSession?.page.nextCursor) ? (
        <nav data-ui="storage-chat-pagination" aria-label="Chat table pages">
          <Button
            type="button"
            disabled={
              !chatCatalogSession.page.previousCursor || chatCatalogSession.interactive !== true
            }
            onClick={() => {
              previousChatCatalogPage()
              chatTableScrollRef.current?.scrollTo({ top: 0 })
            }}
          >
            Previous
          </Button>
          <span>
            Page {chatCatalogSession.pageNumber + 1} · {chatCatalogSession.page.exactCount} chats
          </span>
          <Button
            type="button"
            disabled={
              !chatCatalogSession.page.nextCursor || chatCatalogSession.interactive !== true
            }
            onClick={() => {
              nextChatCatalogPage()
              chatTableScrollRef.current?.scrollTo({ top: 0 })
            }}
          >
            Next
          </Button>
        </nav>
      ) : null}
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
      <Button
        type="button"
        data-ui="storage-chat-sort-header"
        data-active={active ? 'true' : undefined}
        onClick={() => onSort(field)}
      >
        <span>{label}</span>
        <ChevronIcon size={12} rotate={active && direction === 'asc' ? 270 : 90} />
      </Button>
    </th>
  )
}

function compareStorageChatRows(
  left: ChatSidebarRow,
  right: ChatSidebarRow,
  mode: SidebarSortMode,
): number {
  return compareSidebarChatRows(left, right, mode, false)
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

function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  if (value < 0.01) return '<$0.01'
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
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

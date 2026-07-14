import {
  defaultRangeExtractor,
  type Range,
  useVirtualizer,
  type VirtualItem,
} from '@tanstack/react-virtual'
import {
  type ChangeEvent,
  type DragEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  beginRouteIntent,
  cancelRouteIntent,
  chatHref,
  homeHref,
  makeAnchorClickHandler,
  navigateForIntent,
} from '../../app/router'
import { exportLastUpdatedChatAsTxt, triggerBrowserDownload } from '../../core/chat-export'
import { DEFAULT_GLOBAL_PREFERENCES, readGlobalPreferences } from '../../core/global-settings'
import {
  DEFAULT_SIDEBAR_SORT_MODE,
  SIDEBAR_SORT_OPTIONS,
  type SidebarSortMode,
  sidebarSortOption,
} from '../../core/sidebar-sort'
import type { ChatFolder, ChatId, ChatSidebarRow, ChatTag, FolderId } from '../../core/types'
import { isPageHidingAbortError } from '../../lib/page-lifecycle'
import {
  DEFAULT_SEARCH_FILTERS,
  hasActiveSearchFilters,
  hasSearchWork,
  type SearchFilters,
  type SearchResult,
} from '../../store/chat-search'
import {
  archiveChat,
  listChatSidebarRows,
  moveChatToFolder,
  setChatTagsFromNames,
} from '../../store/chats'
import { createFolder, deleteFolder, listFolders, updateFolder } from '../../store/folders'
import { exportChat, importChat } from '../../store/import-export'
import {
  GLOBAL_PREFERENCES_DEPENDENCIES,
  primaryKeys,
  SIDEBAR_MODEL_DEPENDENCIES,
} from '../../store/reactive-dependencies'
import { useRepositoryQuery, useRepositoryQueryState } from '../../store/reactive-query'
import { abortSearchSession, requestSearchSession } from '../../store/search-session'
import {
  readCollapsedSidebarFolderIds,
  readSidebarSortMode,
  SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  SIDEBAR_SORT_SETTING_KEY,
  updateCollapsedSidebarFolderIds,
  writeSidebarSortMode,
} from '../../store/sidebar-preferences'
import { listTags } from '../../store/tags'
import {
  orderedSearchResults,
  startSearchStoreBroadcastListener,
  useSearchStore,
} from '../../store/zustand/searchStore'
import { useToastStore } from '../../store/zustand/toastStore'
import {
  ChevronIcon,
  CloseIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  MoreVerticalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SortIcon,
  TagIcon,
  TrashIcon,
  UploadIcon,
} from '../icons/Icon'
import {
  forEachJsonOrZipFile,
  importExportErrorMessage,
  natterJsonFilename,
  triggerJsonDownload,
} from '../import-export/json-file'
import { Button, IconButton } from '../primitives/Button'
import {
  buildCreatedAtGroups,
  buildSidebarEntries,
  formatSidebarRowMeta,
  isEmptySidebarDraft,
  shouldRenderCreatedAtGroups,
  sortChats,
} from './chat-organization'

interface ChatListProps {
  activeChatId: ChatId | null
  collapsed?: boolean
  onChatIntent?: () => void
}

const EMPTY_COLLAPSED_FOLDER_IDS: FolderId[] = []
const SIDEBAR_VIRTUALIZE_THRESHOLD = 200
const SIDEBAR_INITIAL_VIRTUAL_ROWS = 18

type SidebarRowDepth = 'root' | 'folder'

type SidebarVirtualRow =
  | {
      kind: 'chat'
      key: string
      chat: ChatSidebarRow
      depth: SidebarRowDepth
      searchResult?: SearchResult
    }
  | {
      kind: 'folder'
      key: string
      folder: ChatFolder
      chats: ChatSidebarRow[]
    }
  | {
      kind: 'time-group'
      key: string
      label: string
      depth: SidebarRowDepth
    }
  | {
      kind: 'status'
      key: string
      text: string
    }
  | {
      kind: 'folder-empty'
      key: string
      depth: SidebarRowDepth
    }

interface VirtualRowOptions {
  key?: string
  depth?: SidebarRowDepth
  virtual?: SidebarVirtualMount
}

interface SidebarVirtualMount {
  index: number
  start: number
  measureElement: (node: HTMLLIElement | null) => void
}

interface SidebarScrollAnchor {
  key: string
  top: number
}

function captureSidebarScrollAnchor(
  root: HTMLElement,
  source?: Element | null,
): SidebarScrollAnchor | null {
  const sourceRow = source ? source.closest<HTMLElement>('[data-sidebar-row-key]') : null
  const row = sourceRow ?? firstVisibleSidebarRow(root)
  const key = row?.dataset.sidebarRowKey
  if (!row || !key) return null
  return {
    key,
    top: row.getBoundingClientRect().top - root.getBoundingClientRect().top,
  }
}

function firstVisibleSidebarRow(root: HTMLElement): HTMLElement | null {
  const rootRect = root.getBoundingClientRect()
  const rows = root.querySelectorAll<HTMLElement>('[data-sidebar-row-key]')
  let lastBeforeViewport: HTMLElement | null = null
  for (const row of rows) {
    const rowRect = row.getBoundingClientRect()
    if (rowRect.bottom < rootRect.top) {
      lastBeforeViewport = row
      continue
    }
    if (rowRect.top <= rootRect.bottom) return row
  }
  return lastBeforeViewport ?? rows[0] ?? null
}

function findSidebarRowByKey(root: HTMLElement, key: string): HTMLElement | null {
  for (const row of root.querySelectorAll<HTMLElement>('[data-sidebar-row-key]')) {
    if (row.dataset.sidebarRowKey === key) return row
  }
  return null
}

function restoreSidebarScrollAnchor(root: HTMLElement, anchor: SidebarScrollAnchor): boolean {
  const row = findSidebarRowByKey(root, anchor.key)
  if (!row) return false
  const delta = row.getBoundingClientRect().top - root.getBoundingClientRect().top - anchor.top
  if (Math.abs(delta) < 1) return true
  root.scrollTop += delta
  return true
}

// Loads the chat-row list only — never touches the `messages` table.
// `chat.previewText` is maintained in the authoritative message transaction,
// so the sidebar stays
// cheap even with thousands of chats. The daemon-mode equivalent will
// implement the same read via the repository boundary; this module
// doesn't couple its read path to Dexie semantics.
async function loadSidebarModel(): Promise<{
  chats: ChatSidebarRow[]
  folders: ChatFolder[]
  tags: ChatTag[]
}> {
  try {
    const [chats, folders, tags] = await Promise.all([
      listChatSidebarRows(),
      listFolders(),
      listTags(),
    ])
    return { chats, folders, tags }
  } catch (error) {
    if (error instanceof Error && error.name === 'DatabaseClosedError') {
      return { chats: [], folders: [], tags: [] }
    }
    throw error
  }
}

function buildChatVirtualRows(
  chats: readonly ChatSidebarRow[],
  options: {
    keyPrefix: string
    depth: SidebarRowDepth
    sortMode: SidebarSortMode
    searchResultsByChatId?: ReadonlyMap<ChatId, SearchResult>
  },
): SidebarVirtualRow[] {
  const chatRow = (chat: ChatSidebarRow): SidebarVirtualRow => {
    const row: SidebarVirtualRow = {
      kind: 'chat',
      key: `${options.keyPrefix}:chat:${chat.id}`,
      chat,
      depth: options.depth,
    }
    const searchResult = options.searchResultsByChatId?.get(chat.id)
    if (searchResult) row.searchResult = searchResult
    return row
  }
  if (!shouldRenderCreatedAtGroups(options.sortMode)) {
    return chats.map(chatRow)
  }

  const rows: SidebarVirtualRow[] = []
  for (const group of buildCreatedAtGroups(chats, options.sortMode)) {
    rows.push({
      kind: 'time-group',
      key: `${options.keyPrefix}:time:${group.key}`,
      label: group.label,
      depth: options.depth,
    })
    for (const chat of group.chats) {
      rows.push(chatRow(chat))
    }
  }
  return rows
}

function estimateSidebarVirtualRowSize(
  row: SidebarVirtualRow | undefined,
  collapsed: boolean,
): number {
  if (!row) return 56
  switch (row.kind) {
    case 'folder':
      return 41
    case 'time-group':
      return 25
    case 'status':
    case 'folder-empty':
      return 36
    case 'chat':
      if (collapsed) return 38
      return row.chat.tags.length > 0 ? 82 : 58
  }
}

function bindSidebarVirtualRow(node: HTMLLIElement | null, virtual: SidebarVirtualMount): void {
  if (node) node.style.setProperty('--sidebar-row-y', `${virtual.start}px`)
  virtual.measureElement(node)
}

function sidebarRangeExtractor(range: Range): number[] {
  const rows = defaultRangeExtractor(range)
  if (rows.length > 0) return rows
  return Array.from(
    { length: Math.min(SIDEBAR_INITIAL_VIRTUAL_ROWS, range.count) },
    (_, index) => index,
  )
}

function fallbackSidebarVirtualItems(
  rows: readonly SidebarVirtualRow[],
  collapsed: boolean,
): VirtualItem[] {
  let start = 0
  return rows.slice(0, SIDEBAR_INITIAL_VIRTUAL_ROWS).map((row, index) => {
    const size = estimateSidebarVirtualRowSize(row, collapsed)
    const item: VirtualItem = {
      key: row.key,
      index,
      start,
      end: start + size,
      size,
      lane: 0,
    }
    start += size
    return item
  })
}

function estimateSidebarVirtualTotalSize(
  rows: readonly SidebarVirtualRow[],
  collapsed: boolean,
): number {
  return rows.reduce((sum, row) => sum + estimateSidebarVirtualRowSize(row, collapsed), 0)
}

export const ChatList = memo(function ChatList({
  activeChatId,
  collapsed,
  onChatIntent,
}: ChatListProps) {
  const model = useRepositoryQuery(
    'sidebar-model',
    loadSidebarModel,
    {
      chats: [],
      folders: [],
      tags: [],
    },
    SIDEBAR_MODEL_DEPENDENCIES,
  )
  const preferencesQuery = useRepositoryQueryState(
    'global-preferences',
    readGlobalPreferences,
    DEFAULT_GLOBAL_PREFERENCES,
    GLOBAL_PREFERENCES_DEPENDENCIES,
  )
  if (preferencesQuery.status === 'error') throw preferencesQuery.error
  const loadedPrefs = preferencesQuery.status === 'ready' ? preferencesQuery.value : undefined
  const prefs = preferencesQuery.value
  const persistedSortMode = useRepositoryQuery(
    'sidebar-sort-mode',
    readSidebarSortMode,
    DEFAULT_SIDEBAR_SORT_MODE,
    primaryKeys('settings', SIDEBAR_SORT_SETTING_KEY),
  )
  const persistedCollapsedFolderIds = useRepositoryQuery(
    'sidebar-collapsed-folder-ids',
    readCollapsedSidebarFolderIds,
    EMPTY_COLLAPSED_FOLDER_IDS,
    primaryKeys('settings', SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY),
  )
  const [sortMode, setSortMode] = useState<SidebarSortMode>(DEFAULT_SIDEBAR_SORT_MODE)
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const [openActionChatId, setOpenActionChatId] = useState<ChatId | null>(null)
  const [importingChat, setImportingChat] = useState(false)
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<ReadonlySet<FolderId>>(
    () => new Set(),
  )
  const [dragOverFolderId, setDragOverFolderId] = useState<FolderId | null>(null)
  const [recentMove, setRecentMove] = useState<{ chatId: ChatId; folderId: FolderId } | null>(null)
  const [folderDeleteTarget, setFolderDeleteTarget] = useState<ChatFolder | null>(null)
  const [deleteFolderChats, setDeleteFolderChats] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [searchFoldersOpen, setSearchFoldersOpen] = useState(false)
  const [searchTagsOpen, setSearchTagsOpen] = useState(false)
  const [searchTitleOnly, setSearchTitleOnly] = useState(false)
  const [searchAllBranches, setSearchAllBranches] = useState(false)
  const [searchIncludeArchived, setSearchIncludeArchived] = useState(false)
  const [includeFolderIds, setIncludeFolderIds] = useState<FolderId[]>([])
  const [excludeFolderIds, setExcludeFolderIds] = useState<FolderId[]>([])
  const [includeTagIds, setIncludeTagIds] = useState<string[]>([])
  const [excludeTagIds, setExcludeTagIds] = useState<string[]>([])
  const recentMoveTimerRef = useRef<number | null>(null)
  const sortMenuRef = useRef<HTMLDivElement | null>(null)
  const sidebarOrganizerRef = useRef<HTMLDivElement | null>(null)
  const chatImportInputRef = useRef<HTMLInputElement | null>(null)
  const sidebarWindowLoadRef = useRef<HTMLLIElement | null>(null)
  const preserveSearchExpansionRef = useRef(false)
  const rowMenuButtonRefs = useRef(new Map<ChatId, HTMLButtonElement>())
  const searchSession = useSearchStore((state) => state.session)
  const pushToast = useToastStore((s) => s.push)
  const sortLocale = useMemo(
    () => (typeof navigator === 'undefined' ? 'en-US' : navigator.language),
    [],
  )
  const sortOptions = useMemo(() => ({ locale: sortLocale }), [sortLocale])
  const activeSortOption = sidebarSortOption(sortMode)
  const tagById = useMemo(() => new Map(model.tags.map((tag) => [tag.id, tag])), [model.tags])
  const folderById = useMemo(
    () => new Map(model.folders.map((folder) => [folder.id, folder])),
    [model.folders],
  )
  const flatRows = useMemo(
    () =>
      sortChats(
        model.chats.filter((chat) => !chat.archived && !isEmptySidebarDraft(chat)),
        sortMode,
        sortOptions,
      ),
    [model.chats, sortMode, sortOptions],
  )
  const entries = useMemo(
    () => buildSidebarEntries(model.chats, model.folders, sortMode, sortOptions),
    [model.chats, model.folders, sortMode, sortOptions],
  )
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
  const searchHasFilters = hasActiveSearchFilters(searchFilters) || searchAllBranches
  const searchActive = hasSearchWork(searchQuery, searchFilters)
  const searchControlsExpanded = searchExpanded || searchActive || searchHasFilters
  const sortedSearchResults = useMemo(() => {
    const results = orderedSearchResults(searchSession?.results)
    const byChatId = new Map(results.map((result) => [result.chatId, result]))
    return sortChats(
      results.map((result) => result.chat),
      sortMode,
      sortOptions,
    )
      .map((chat) => byChatId.get(chat.id))
      .filter((result): result is SearchResult => Boolean(result))
  }, [searchSession?.results, sortMode, sortOptions])
  const rowMetaNow = Date.now()
  const sidebarListRef = useRef<HTMLUListElement | null>(null)
  const pendingSidebarScrollAnchorRef = useRef<SidebarScrollAnchor | null>(null)
  const [renderedSidebarRowCount, setRenderedSidebarRowCount] = useState(
    prefs.sidebarRenderWindowSize,
  )
  const queueSidebarScrollAnchor = useCallback((source?: Element | null) => {
    const root = sidebarListRef.current
    if (!root) return
    const anchor = captureSidebarScrollAnchor(root, source)
    if (anchor) pendingSidebarScrollAnchorRef.current = anchor
  }, [])
  const virtualRows = useMemo<SidebarVirtualRow[]>(() => {
    if (collapsed) {
      return flatRows.map((chat) => ({
        kind: 'chat',
        key: `collapsed:chat:${chat.id}`,
        chat,
        depth: 'root',
      }))
    }
    if (searchActive) {
      if (sortedSearchResults.length === 0) {
        const status = searchSession?.status ?? 'idle'
        return [
          {
            kind: 'status',
            key: `search-status:${status}`,
            text: status === 'scanning' || status === 'debouncing' ? 'Searching...' : 'No matches',
          },
        ]
      }
      return sortedSearchResults.map((result) => ({
        kind: 'chat',
        key: `search:chat:${result.chat.id}:${result.messageId ?? result.branchLeafId ?? 'row'}`,
        chat: result.chat,
        depth: 'root',
        searchResult: result,
      }))
    }

    const rows: SidebarVirtualRow[] = []
    for (const entry of entries) {
      if (entry.kind === 'chat') {
        rows.push({
          kind: 'chat',
          key: `entry:chat:${entry.chat.id}`,
          chat: entry.chat,
          depth: 'root',
        })
        continue
      }
      rows.push({
        kind: 'folder',
        key: `entry:folder:${entry.folder.id}`,
        folder: entry.folder,
        chats: entry.chats,
      })
      if (collapsedFolderIds.has(entry.folder.id)) continue
      if (entry.chats.length === 0) {
        rows.push({
          kind: 'folder-empty',
          key: `entry:folder:${entry.folder.id}:empty`,
          depth: 'folder',
        })
        continue
      }
      rows.push(
        ...buildChatVirtualRows(entry.chats, {
          keyPrefix: `entry:folder:${entry.folder.id}`,
          depth: 'folder',
          sortMode,
        }),
      )
    }
    return rows
  }, [
    collapsed,
    collapsedFolderIds,
    entries,
    flatRows,
    searchActive,
    searchSession?.status,
    sortMode,
    sortedSearchResults,
  ])
  const visibleVirtualRows = useMemo(
    () => virtualRows.slice(0, Math.min(virtualRows.length, renderedSidebarRowCount)),
    [renderedSidebarRowCount, virtualRows],
  )
  const sidebarAnchorRestoreKey = useMemo(
    () =>
      visibleVirtualRows
        .map((row) => (row.kind === 'chat' ? `${row.key}:${row.chat.tags.join(',')}` : row.key))
        .join('\n'),
    [visibleVirtualRows],
  )
  const hiddenSidebarRowCount = Math.max(0, virtualRows.length - visibleVirtualRows.length)
  const shouldVirtualizeSidebar = visibleVirtualRows.length > SIDEBAR_VIRTUALIZE_THRESHOLD
  const sidebarVirtualizer = useVirtualizer<HTMLUListElement, HTMLLIElement>({
    count: visibleVirtualRows.length,
    getScrollElement: () => sidebarListRef.current,
    estimateSize: (index) =>
      estimateSidebarVirtualRowSize(visibleVirtualRows[index], collapsed === true),
    getItemKey: (index) => visibleVirtualRows[index]?.key ?? index,
    overscan: 8,
    initialRect: { width: 260, height: 720 },
    rangeExtractor: sidebarRangeExtractor,
    enabled: shouldVirtualizeSidebar,
  })
  const sidebarWindowResetKey = useMemo(
    () =>
      JSON.stringify({
        collapsed: collapsed === true,
        mode: searchActive ? 'search' : 'browse',
        sortMode,
        searchQuery,
        searchAllBranches,
        searchIncludeArchived,
        searchTitleOnly,
        includeFolderIds,
        excludeFolderIds,
        includeTagIds,
        excludeTagIds,
      }),
    [
      collapsed,
      excludeFolderIds,
      excludeTagIds,
      includeFolderIds,
      includeTagIds,
      searchActive,
      searchAllBranches,
      searchIncludeArchived,
      searchQuery,
      searchTitleOnly,
      sortMode,
    ],
  )
  const loadMoreSidebarRows = useCallback(
    (source?: Element | null) => {
      queueSidebarScrollAnchor(source)
      setRenderedSidebarRowCount(
        Math.min(virtualRows.length, renderedSidebarRowCount + prefs.sidebarRenderWindowSize),
      )
    },
    [
      prefs.sidebarRenderWindowSize,
      queueSidebarScrollAnchor,
      renderedSidebarRowCount,
      virtualRows.length,
    ],
  )
  useEffect(() => {
    startSearchStoreBroadcastListener()
  }, [])
  useEffect(() => {
    void sidebarWindowResetKey
    setRenderedSidebarRowCount(prefs.sidebarRenderWindowSize)
  }, [prefs.sidebarRenderWindowSize, sidebarWindowResetKey])
  useLayoutEffect(() => {
    void sidebarAnchorRestoreKey
    const anchor = pendingSidebarScrollAnchorRef.current
    const root = sidebarListRef.current
    if (!anchor || !root) return

    if (!restoreSidebarScrollAnchor(root, anchor) && shouldVirtualizeSidebar) {
      const anchorIndex = visibleVirtualRows.findIndex((row) => row.key === anchor.key)
      if (anchorIndex >= 0) sidebarVirtualizer.scrollToIndex(anchorIndex, { align: 'start' })
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      pendingSidebarScrollAnchorRef.current = null
      return
    }

    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      restoreSidebarScrollAnchor(root, anchor)
      secondFrame = window.requestAnimationFrame(() => {
        restoreSidebarScrollAnchor(root, anchor)
        if (pendingSidebarScrollAnchorRef.current === anchor) {
          pendingSidebarScrollAnchorRef.current = null
        }
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [shouldVirtualizeSidebar, sidebarAnchorRestoreKey, sidebarVirtualizer, visibleVirtualRows])
  useEffect(() => {
    if (!loadedPrefs || prefs.sidebarRenderWindowLoadMode !== 'auto') return
    if (hiddenSidebarRowCount <= 0) return
    if (typeof IntersectionObserver === 'undefined') return
    const root = sidebarListRef.current
    const target = sidebarWindowLoadRef.current
    if (!root || !target) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMoreSidebarRows(target)
      },
      { root, rootMargin: '0px 0px 240px 0px', threshold: 0 },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [hiddenSidebarRowCount, loadedPrefs, loadMoreSidebarRows, prefs.sidebarRenderWindowLoadMode])
  useEffect(() => {
    if (!openActionChatId) return
    if (visibleVirtualRows.some((row) => row.kind === 'chat' && row.chat.id === openActionChatId))
      return
    setOpenActionChatId(null)
  }, [openActionChatId, visibleVirtualRows])
  useEffect(() => {
    requestSearchSession({
      query: searchQuery,
      scope: searchAllBranches ? 'all-branches' : 'last-updated-branch',
      filters: searchFilters,
    })
  }, [searchAllBranches, searchFilters, searchQuery])
  useEffect(() => () => abortSearchSession(), [])
  useEffect(() => setSortMode(persistedSortMode), [persistedSortMode])
  useEffect(
    () => setCollapsedFolderIds(new Set(persistedCollapsedFolderIds)),
    [persistedCollapsedFolderIds],
  )
  useEffect(
    () => () => {
      if (recentMoveTimerRef.current) window.clearTimeout(recentMoveTimerRef.current)
    },
    [],
  )
  useEffect(() => {
    if (!searchExpanded || searchActive || searchHasFilters) return
    const collapseOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target
      const root = sidebarOrganizerRef.current
      if (!root || !(target instanceof Node) || root.contains(target)) return
      setSearchExpanded(false)
    }
    document.addEventListener('mousedown', collapseOnOutsideMouseDown, true)
    return () => document.removeEventListener('mousedown', collapseOnOutsideMouseDown, true)
  }, [searchActive, searchExpanded, searchHasFilters])
  useEffect(() => {
    if (!sortMenuOpen) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && sortMenuRef.current?.contains(target)) return
      setSortMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSortMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [sortMenuOpen])
  // Hide empty drafts — even the currently-active one. A temporary row can
  // exist after /new send/import/settings starts, but the sidebar should stay
  // quiet until the user actually creates a message.
  const handleDelete = useCallback(
    async (chat: ChatSidebarRow) => {
      const routeIntent = activeChatId === chat.id ? beginRouteIntent() : null
      try {
        await archiveChat(chat.id)
        if (routeIntent) navigateForIntent(routeIntent, homeHref())
      } finally {
        if (routeIntent) cancelRouteIntent(routeIntent)
      }
    },
    [activeChatId],
  )
  const handleDownload = useCallback(async (chat: ChatSidebarRow) => {
    const { filename, content } = await exportLastUpdatedChatAsTxt(chat.id)
    triggerBrowserDownload(filename, content)
  }, [])
  const handleExportJson = useCallback(async (chat: ChatSidebarRow) => {
    const envelope = await exportChat(chat.id)
    triggerJsonDownload(natterJsonFilename('chat', chat.title, chat.id), envelope)
  }, [])
  const handleImportChatFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget
      const file = input.files?.[0] ?? null
      input.value = ''
      if (!file) return
      const routeIntent = beginRouteIntent()
      setImportingChat(true)
      try {
        let importedCount = 0
        const imported = { lastChatId: null as ChatId | null }
        await forEachJsonOrZipFile(file, async (value) => {
          const result = await importChat(value)
          importedCount += 1
          imported.lastChatId = result.chatId
        })
        pushToast({
          level: 'success',
          text: importedCount === 1 ? 'Imported chat.' : `Imported ${importedCount} chats.`,
          durationMs: 2500,
        })
        if (imported.lastChatId) {
          navigateForIntent(routeIntent, chatHref(imported.lastChatId))
        }
      } catch (error) {
        console.error('Failed to import chat JSON/ZIP', error)
        pushToast({ level: 'danger', text: importExportErrorMessage(error) })
      } finally {
        cancelRouteIntent(routeIntent)
        setImportingChat(false)
      }
    },
    [pushToast],
  )
  const handleCreateFolder = useCallback(async () => {
    const name = window.prompt('Folder name')
    if (!name?.trim()) return
    await createFolder({ name })
  }, [])
  const handleSelectSortMode = useCallback((mode: SidebarSortMode) => {
    setSortMode(mode)
    setSortMenuOpen(false)
    void writeSidebarSortMode(mode).catch((error: unknown) => {
      if (isPageHidingAbortError(error)) return
      console.error('Failed to persist sidebar sort mode', error)
    })
  }, [])
  const handleRenameFolder = useCallback(async (folder: ChatFolder) => {
    const name = window.prompt('Rename folder', folder.name)
    if (!name?.trim() || name.trim() === folder.name) return
    await updateFolder(folder.id, { name })
  }, [])
  const beginDeleteFolder = useCallback((folder: ChatFolder) => {
    setFolderDeleteTarget(folder)
    setDeleteFolderChats(false)
  }, [])
  const commitDeleteFolder = useCallback(async () => {
    const folder = folderDeleteTarget
    if (!folder) return
    const chatsInFolder = model.chats.filter((chat) => chat.folderId === folder.id)
    const routeIntent =
      deleteFolderChats && activeChatId && chatsInFolder.some((chat) => chat.id === activeChatId)
        ? beginRouteIntent()
        : null
    try {
      if (deleteFolderChats) {
        await Promise.all(
          chatsInFolder.filter((chat) => !chat.archived).map((chat) => archiveChat(chat.id)),
        )
      }
      await deleteFolder(folder.id)
      if (routeIntent) navigateForIntent(routeIntent, homeHref())
      setFolderDeleteTarget(null)
      setDeleteFolderChats(false)
    } finally {
      if (routeIntent) cancelRouteIntent(routeIntent)
    }
  }, [activeChatId, deleteFolderChats, folderDeleteTarget, model.chats])
  const markRecentMove = useCallback((chatId: ChatId, folderId: FolderId) => {
    if (recentMoveTimerRef.current) window.clearTimeout(recentMoveTimerRef.current)
    setRecentMove({ chatId, folderId })
    recentMoveTimerRef.current = window.setTimeout(() => {
      setRecentMove(null)
      recentMoveTimerRef.current = null
    }, 1400)
  }, [])
  const handleMoveChat = useCallback(
    async (chat: ChatSidebarRow, source?: Element | null) => {
      queueSidebarScrollAnchor(source)
      const currentFolder = chat.folderId ? folderById.get(chat.folderId)?.name : ''
      const name = window.prompt('Move to folder (blank removes folder)', currentFolder ?? '')
      if (name === null) return
      const trimmed = name.trim()
      if (trimmed.length === 0) {
        await moveChatToFolder(chat.id, null)
        return
      }
      const existing = model.folders.find(
        (folder) => folder.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
      )
      const folder = existing ?? (await createFolder({ name: trimmed }))
      const changed = await moveChatToFolder(chat.id, folder.id)
      if (changed) markRecentMove(chat.id, folder.id)
    },
    [folderById, markRecentMove, model.folders, queueSidebarScrollAnchor],
  )
  const handleSetTags = useCallback(
    async (chat: ChatSidebarRow, source?: Element | null) => {
      queueSidebarScrollAnchor(source)
      const currentNames = chat.tags
        .map((tagId) => tagById.get(tagId)?.name)
        .filter((name): name is string => Boolean(name))
        .join(', ')
      const value = window.prompt('Tags, comma-separated', currentNames)
      if (value === null) return
      await setChatTagsFromNames(chat.id, tagNamesFromPrompt(value))
    },
    [queueSidebarScrollAnchor, tagById],
  )
  const handleClearSearch = useCallback(() => {
    setSearchQuery('')
    setSearchExpanded(false)
    setSearchTitleOnly(false)
    setSearchAllBranches(false)
    setSearchIncludeArchived(false)
    setIncludeFolderIds([])
    setExcludeFolderIds([])
    setIncludeTagIds([])
    setExcludeTagIds([])
  }, [])
  const handleTagSearch = useCallback((tagId: string) => {
    setSearchExpanded(true)
    setSearchTagsOpen(true)
    setIncludeTagIds((include) => (include.includes(tagId) ? include : [...include, tagId]))
    setExcludeTagIds((exclude) => exclude.filter((id) => id !== tagId))
  }, [])
  const toggleChatActions = useCallback((chatId: ChatId) => {
    setOpenActionChatId((current) => {
      if (current !== chatId) return chatId
      rowMenuButtonRefs.current.get(chatId)?.blur()
      return null
    })
  }, [])
  const toggleFolderFilter = useCallback(
    (folderId: FolderId) => {
      setIncludeFolderIds((include) => {
        if (!include.includes(folderId) && !excludeFolderIds.includes(folderId)) {
          return [...include, folderId]
        }
        if (include.includes(folderId)) return include.filter((id) => id !== folderId)
        return include
      })
      setExcludeFolderIds((exclude) => {
        if (includeFolderIds.includes(folderId)) return [...exclude, folderId]
        if (exclude.includes(folderId)) return exclude.filter((id) => id !== folderId)
        return exclude
      })
    },
    [excludeFolderIds, includeFolderIds],
  )
  const toggleTagFilter = useCallback(
    (tagId: string) => {
      setIncludeTagIds((include) => {
        if (!include.includes(tagId) && !excludeTagIds.includes(tagId)) return [...include, tagId]
        if (include.includes(tagId)) return include.filter((id) => id !== tagId)
        return include
      })
      setExcludeTagIds((exclude) => {
        if (includeTagIds.includes(tagId)) return [...exclude, tagId]
        if (exclude.includes(tagId)) return exclude.filter((id) => id !== tagId)
        return exclude
      })
    },
    [excludeTagIds, includeTagIds],
  )
  const handleDropOnFolder = useCallback(
    async (event: DragEvent, folderId: FolderId) => {
      event.preventDefault()
      queueSidebarScrollAnchor(event.currentTarget)
      setDragOverFolderId(null)
      const chatId = event.dataTransfer.getData('application/x-natter-chat-id')
      if (!chatId) return
      const changed = await moveChatToFolder(chatId, folderId)
      setCollapsedFolderIds((current) => {
        const next = new Set(current)
        next.delete(folderId)
        return next
      })
      void updateCollapsedSidebarFolderIds((current) =>
        current.filter((id) => id !== folderId),
      ).catch((error: unknown) => {
        if (isPageHidingAbortError(error)) return
        console.error('Failed to persist sidebar folder state', error)
      })
      if (changed) markRecentMove(chatId, folderId)
    },
    [markRecentMove, queueSidebarScrollAnchor],
  )
  const toggleFolder = useCallback(
    (folderId: FolderId, source?: Element | null) => {
      queueSidebarScrollAnchor(source)
      setCollapsedFolderIds((current) => {
        const next = new Set(current)
        if (next.has(folderId)) next.delete(folderId)
        else next.add(folderId)
        return next
      })
      void updateCollapsedSidebarFolderIds((current) => {
        const next = new Set(current)
        if (next.has(folderId)) next.delete(folderId)
        else next.add(folderId)
        return [...next]
      }).catch((error: unknown) => {
        if (isPageHidingAbortError(error)) return
        console.error('Failed to persist sidebar folder state', error)
      })
    },
    [queueSidebarScrollAnchor],
  )
  const renderChatRow = (
    chat: ChatSidebarRow,
    searchResult?: SearchResult,
    options: VirtualRowOptions = {},
  ) => {
    const displayTitle = chat.title.trim().length ? chat.title : 'Untitled chat'
    const preview = chat.previewText ?? ''
    const searchTargetId = searchResult?.messageId ?? searchResult?.branchLeafId ?? undefined
    const href = chatHref(chat.id, searchTargetId)
    const meta = formatSidebarRowMeta(chat, sortMode, rowMetaNow)
    const visibleTags = chat.tags
      .map((tagId) => tagById.get(tagId))
      .filter((tag): tag is ChatTag => Boolean(tag))
    return (
      <li
        key={options.key ?? chat.id}
        data-ui="chat-row"
        data-sidebar-row-key={options.key ?? chat.id}
        data-sidebar-depth={options.depth === 'folder' ? 'folder' : undefined}
        data-active={chat.id === activeChatId}
        data-menu-open={openActionChatId === chat.id ? 'true' : undefined}
        data-moved={recentMove?.chatId === chat.id ? 'true' : undefined}
        data-title-status={chat.titleStatus}
        data-index={options.virtual?.index}
        ref={
          options.virtual
            ? (node) => bindSidebarVirtualRow(node, options.virtual as SidebarVirtualMount)
            : undefined
        }
        draggable={!collapsed}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('application/x-natter-chat-id', chat.id)
        }}
        onDragEnd={() => setDragOverFolderId(null)}
      >
        <a
          data-ui="chat-row-link"
          href={href}
          rel="noopener"
          onPointerEnter={onChatIntent}
          onPointerDown={onChatIntent}
          onFocus={onChatIntent}
          onClick={makeAnchorClickHandler(href)}
        >
          <span data-ui="chat-row-head">
            <span data-ui="chat-row-title">
              {searchResult?.source === 'title'
                ? renderHighlightedText(displayTitle, searchResult.highlightRanges)
                : displayTitle}
            </span>
            {!collapsed && meta ? <span data-ui="chat-row-meta">{meta}</span> : null}
          </span>
          {!collapsed && searchResult ? (
            <span data-ui="chat-row-preview" data-search-snippet="" title={searchResult.snippet}>
              {searchResult.prefixTruncated ? <span aria-hidden="true">...</span> : null}
              {renderHighlightedText(searchResult.snippet, searchResult.highlightRanges)}
              {searchResult.suffixTruncated ? <span aria-hidden="true">...</span> : null}
            </span>
          ) : !collapsed && preview ? (
            <span data-ui="chat-row-preview">{preview}</span>
          ) : null}
        </a>
        {!collapsed && visibleTags.length > 0 ? (
          <span data-ui="chat-row-tags">
            <a
              data-ui="chat-row-tags-link"
              href={href}
              rel="noopener"
              onClick={makeAnchorClickHandler(href)}
              aria-label={`Open ${displayTitle}`}
            >
              <span data-ui="visually-hidden">Open {displayTitle}</span>
            </a>
            <span data-ui="chat-row-tag-list">
              {visibleTags.slice(0, 3).map((tag) => (
                <Button
                  key={tag.id}
                  type="button"
                  data-ui="chat-row-tag"
                  title={`Search tag ${tag.name}`}
                  onClick={(event) => {
                    queueSidebarScrollAnchor(event.currentTarget)
                    handleTagSearch(tag.id)
                  }}
                >
                  {tag.name}
                </Button>
              ))}
              {visibleTags.length > 3 ? (
                <span
                  data-ui="chat-row-tag-more"
                  title={visibleTags.map((tag) => tag.name).join(', ')}
                >
                  +{visibleTags.length - 3}
                </span>
              ) : null}
            </span>
          </span>
        ) : null}
        {collapsed ? null : (
          <span data-ui="chat-row-actions">
            <IconButton
              ref={(node) => {
                if (node) rowMenuButtonRefs.current.set(chat.id, node)
                else rowMenuButtonRefs.current.delete(chat.id)
              }}
              type="button"
              data-ui="chat-row-menu-button"
              aria-label={`Open actions for ${displayTitle}`}
              aria-haspopup="menu"
              aria-expanded={openActionChatId === chat.id}
              title="Actions"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                toggleChatActions(chat.id)
              }}
            >
              <MoreVerticalIcon size={15} />
            </IconButton>
            {openActionChatId === chat.id ? (
              <div
                data-ui="chat-row-menu"
                role="menu"
                aria-label={`Actions for ${displayTitle}`}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setOpenActionChatId(null)
                }}
              >
                <Button
                  type="button"
                  role="menuitem"
                  data-ui="chat-row-folder"
                  onClick={(event) => {
                    const source = event.currentTarget
                    setOpenActionChatId(null)
                    void handleMoveChat(chat, source)
                  }}
                >
                  <FolderIcon size={14} />
                  <span>Move</span>
                </Button>
                <Button
                  type="button"
                  role="menuitem"
                  data-ui="chat-row-tags-button"
                  onClick={(event) => {
                    const source = event.currentTarget
                    setOpenActionChatId(null)
                    void handleSetTags(chat, source)
                  }}
                >
                  <TagIcon size={14} />
                  <span>Tags</span>
                </Button>
                <Button
                  type="button"
                  role="menuitem"
                  data-ui="chat-row-download"
                  onClick={() => {
                    setOpenActionChatId(null)
                    void handleDownload(chat)
                  }}
                >
                  <DownloadIcon size={14} />
                  <span>Download</span>
                </Button>
                <Button
                  type="button"
                  role="menuitem"
                  data-ui="chat-row-export"
                  onClick={() => {
                    setOpenActionChatId(null)
                    void handleExportJson(chat)
                  }}
                >
                  <FileIcon size={14} />
                  <span>Export</span>
                </Button>
                <Button
                  type="button"
                  role="menuitem"
                  data-ui="chat-row-delete"
                  tone="danger"
                  onClick={() => {
                    setOpenActionChatId(null)
                    void handleDelete(chat)
                  }}
                >
                  <TrashIcon size={14} />
                  <span>Trash</span>
                </Button>
              </div>
            ) : null}
          </span>
        )}
      </li>
    )
  }
  const renderFolderHeaderContents = (row: Extract<SidebarVirtualRow, { kind: 'folder' }>) => {
    const folderCollapsed = collapsedFolderIds.has(row.folder.id)
    const dropState =
      dragOverFolderId === row.folder.id
        ? 'over'
        : recentMove?.folderId === row.folder.id
          ? 'recent'
          : undefined
    return (
      <fieldset
        data-ui="folder-header"
        data-drop-state={dropState}
        aria-label={`Folder ${row.folder.name}`}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('application/x-natter-chat-id')) return
          setDragOverFolderId(row.folder.id)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('application/x-natter-chat-id')) return
          event.preventDefault()
          setDragOverFolderId(row.folder.id)
          event.dataTransfer.dropEffect = 'move'
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget as Node | null
          if (nextTarget && event.currentTarget.contains(nextTarget)) return
          setDragOverFolderId((current) => (current === row.folder.id ? null : current))
        }}
        onDrop={(event) => void handleDropOnFolder(event, row.folder.id)}
      >
        <Button
          type="button"
          data-ui="folder-main"
          title={row.folder.name}
          aria-expanded={!folderCollapsed}
          onClick={(event) => toggleFolder(row.folder.id, event.currentTarget)}
        >
          <ChevronIcon size={13} rotate={folderCollapsed ? 0 : 90} />
          <FolderIcon size={14} />
          <span>{row.folder.name}</span>
          <span data-ui="folder-count">{row.chats.length}</span>
        </Button>
        <span data-ui="folder-actions">
          <Button
            type="button"
            aria-label={`Rename folder ${row.folder.name}`}
            title="Rename folder"
            onClick={() => void handleRenameFolder(row.folder)}
          >
            <PencilIcon size={13} />
          </Button>
          <Button
            type="button"
            aria-label={`Delete folder ${row.folder.name}`}
            title="Delete folder"
            onClick={() => beginDeleteFolder(row.folder)}
          >
            <TrashIcon size={13} />
          </Button>
        </span>
      </fieldset>
    )
  }

  const renderSidebarWindowLoad = () => {
    if (hiddenSidebarRowCount <= 0) return null
    return (
      <li ref={sidebarWindowLoadRef} data-ui="sidebar-window-load">
        <Button
          type="button"
          data-ui="load-more-sidebar"
          onClick={(event) => loadMoreSidebarRows(event.currentTarget)}
        >
          Load more
        </Button>
        <span>{hiddenSidebarRowCount} more</span>
      </li>
    )
  }

  const renderStaticSidebarRow = (row: SidebarVirtualRow) => {
    switch (row.kind) {
      case 'chat':
        return renderChatRow(row.chat, row.searchResult, {
          key: row.key,
          depth: row.depth,
        })
      case 'folder':
        return (
          <li key={row.key} data-ui="folder-section" data-sidebar-row-key={row.key}>
            {renderFolderHeaderContents(row)}
          </li>
        )
      case 'time-group':
        return (
          <li
            key={row.key}
            data-ui="sidebar-time-group"
            data-sidebar-row-key={row.key}
            data-sidebar-depth={row.depth === 'folder' ? 'folder' : undefined}
          >
            <div data-ui="sidebar-time-group-label">{row.label}</div>
          </li>
        )
      case 'status':
        return (
          <li key={row.key} data-ui="sidebar-search-empty" data-sidebar-row-key={row.key}>
            {row.text}
          </li>
        )
      case 'folder-empty':
        return (
          <li
            key={row.key}
            data-ui="folder-empty"
            data-sidebar-row-key={row.key}
            data-sidebar-depth={row.depth === 'folder' ? 'folder' : undefined}
          >
            Empty
          </li>
        )
    }
  }

  const renderVirtualSidebarRow = (virtualItem: VirtualItem) => {
    const row = visibleVirtualRows[virtualItem.index]
    if (!row) return null
    const virtual = {
      index: virtualItem.index,
      start: virtualItem.start,
      measureElement: sidebarVirtualizer.measureElement,
    }
    switch (row.kind) {
      case 'chat':
        return renderChatRow(row.chat, row.searchResult, {
          key: row.key,
          depth: row.depth,
          virtual,
        })
      case 'folder':
        return (
          <li
            key={row.key}
            data-ui="folder-section"
            data-sidebar-row-key={row.key}
            data-index={virtual.index}
            ref={(node) => bindSidebarVirtualRow(node, virtual)}
          >
            {renderFolderHeaderContents(row)}
          </li>
        )
      case 'time-group':
        return (
          <li
            key={row.key}
            data-ui="sidebar-time-group"
            data-sidebar-row-key={row.key}
            data-sidebar-depth={row.depth === 'folder' ? 'folder' : undefined}
            data-index={virtual.index}
            ref={(node) => bindSidebarVirtualRow(node, virtual)}
          >
            <div data-ui="sidebar-time-group-label">{row.label}</div>
          </li>
        )
      case 'status':
        return (
          <li
            key={row.key}
            data-ui="sidebar-search-empty"
            data-sidebar-row-key={row.key}
            data-index={virtual.index}
            ref={(node) => bindSidebarVirtualRow(node, virtual)}
          >
            {row.text}
          </li>
        )
      case 'folder-empty':
        return (
          <li
            key={row.key}
            data-ui="folder-empty"
            data-sidebar-row-key={row.key}
            data-sidebar-depth={row.depth === 'folder' ? 'folder' : undefined}
            data-index={virtual.index}
            ref={(node) => bindSidebarVirtualRow(node, virtual)}
          >
            Empty
          </li>
        )
    }
  }

  const renderVirtualSidebarList = () => {
    const virtualItems = sidebarVirtualizer.getVirtualItems()
    const renderedItems =
      virtualItems.length > 0
        ? virtualItems
        : fallbackSidebarVirtualItems(visibleVirtualRows, collapsed === true)
    const totalSize =
      virtualItems.length > 0
        ? sidebarVirtualizer.getTotalSize()
        : estimateSidebarVirtualTotalSize(visibleVirtualRows, collapsed === true)
    return (
      <ul
        ref={sidebarListRef}
        data-ui="chat-list"
        data-sort-key={sortMode}
        data-search-mode={searchActive ? 'true' : undefined}
        data-virtualized="true"
        data-render-window-size={prefs.sidebarRenderWindowSize}
        data-rendered-count={visibleVirtualRows.length}
        data-total-count={virtualRows.length}
      >
        <li
          data-ui="sidebar-virtual-spacer"
          aria-hidden="true"
          ref={(node) => {
            if (node) node.style.setProperty('--sidebar-virtual-total-h', `${totalSize}px`)
          }}
        />
        {renderedItems.map(renderVirtualSidebarRow)}
        {renderSidebarWindowLoad()}
      </ul>
    )
  }

  const renderSearchControls = () => {
    const status = searchSession?.status ?? 'idle'
    const completed = searchSession?.completedCount ?? 0
    const total = searchSession?.candidateCount ?? 0
    return (
      <label data-ui="sidebar-search" onFocusCapture={() => setSearchExpanded(true)}>
        <SearchIcon size={14} />
        <input
          data-ui="sidebar-search-input"
          type="search"
          value={searchQuery}
          placeholder="Search"
          aria-label="Search chats"
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') handleClearSearch()
          }}
        />
        {searchActive ? (
          <span data-ui="sidebar-search-progress">
            {status === 'scanning' || status === 'debouncing'
              ? `${completed}/${total}`
              : `${sortedSearchResults.length}`}
          </span>
        ) : null}
        {searchActive ? (
          <IconButton
            type="button"
            data-ui="sidebar-search-clear"
            aria-label="Clear search"
            title="Clear"
            onClick={handleClearSearch}
          >
            <CloseIcon size={13} />
          </IconButton>
        ) : null}
      </label>
    )
  }

  const renderSearchDetails = () => (
    <>
      {searchSession?.status === 'error' && searchSession.error ? (
        <div data-ui="sidebar-search-error">{searchSession.error}</div>
      ) : null}
      {searchControlsExpanded ? (
        <div data-ui="sidebar-search-filters">
          <div data-ui="sidebar-search-filter-toggles">
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
            <section
              data-ui="sidebar-search-filter-group"
              data-open={searchFoldersOpen ? 'true' : undefined}
            >
              <Button
                type="button"
                data-ui="sidebar-search-filter-heading"
                aria-expanded={searchFoldersOpen}
                onClick={() => setSearchFoldersOpen((open) => !open)}
              >
                <ChevronIcon size={12} rotate={searchFoldersOpen ? 90 : 0} />
                <FolderIcon size={12} />
                <span>Folders</span>
                <span data-ui="sidebar-search-filter-count">{model.folders.length}</span>
              </Button>
              {searchFoldersOpen ? (
                <div data-ui="sidebar-search-chip-row">
                  {model.folders.map((folder) => (
                    <Button
                      key={folder.id}
                      type="button"
                      data-filter-state={filterState(folder.id, includeFolderIds, excludeFolderIds)}
                      title={filterTitle(
                        folder.name,
                        includeFolderIds,
                        excludeFolderIds,
                        folder.id,
                      )}
                      onClick={() => toggleFolderFilter(folder.id)}
                    >
                      {folder.name}
                    </Button>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}
          {model.tags.length > 0 ? (
            <section
              data-ui="sidebar-search-filter-group"
              data-open={searchTagsOpen ? 'true' : undefined}
            >
              <Button
                type="button"
                data-ui="sidebar-search-filter-heading"
                aria-expanded={searchTagsOpen}
                onClick={() => setSearchTagsOpen((open) => !open)}
              >
                <ChevronIcon size={12} rotate={searchTagsOpen ? 90 : 0} />
                <TagIcon size={12} />
                <span>Tags</span>
                <span data-ui="sidebar-search-filter-count">{model.tags.length}</span>
              </Button>
              {searchTagsOpen ? (
                <div data-ui="sidebar-search-chip-row">
                  {model.tags.map((tag) => (
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
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </>
  )

  const renderStaticSidebarList = () => {
    return (
      <ul
        ref={sidebarListRef}
        data-ui="chat-list"
        data-sort-key={sortMode}
        data-search-mode={searchActive ? 'true' : undefined}
        data-render-window-size={prefs.sidebarRenderWindowSize}
        data-rendered-count={visibleVirtualRows.length}
        data-total-count={virtualRows.length}
      >
        {visibleVirtualRows.map(renderStaticSidebarRow)}
        {renderSidebarWindowLoad()}
      </ul>
    )
  }

  if (collapsed) {
    if (shouldVirtualizeSidebar) return renderVirtualSidebarList()
    return renderStaticSidebarList()
  }

  return (
    <div
      ref={sidebarOrganizerRef}
      data-ui="sidebar-organizer"
      data-sort-key={sortMode}
      onMouseDownCapture={() => {
        if (!searchControlsExpanded) return
        preserveSearchExpansionRef.current = true
        window.setTimeout(() => {
          preserveSearchExpansionRef.current = false
        }, 0)
      }}
    >
      <div
        data-ui="sidebar-org-toolbar"
        data-search-expanded={searchControlsExpanded ? 'true' : undefined}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
          if (preserveSearchExpansionRef.current) return
          if (!searchActive && !searchHasFilters) setSearchExpanded(false)
        }}
      >
        {renderSearchControls()}
        <Button
          type="button"
          aria-label="New folder"
          title="New folder"
          onClick={() => void handleCreateFolder()}
        >
          <FolderIcon size={14} />
          <PlusIcon size={10} strokeWidth={2.4} />
        </Button>
        <IconButton
          type="button"
          data-ui="sidebar-import-chat"
          aria-label="Import chat JSON or ZIP"
          title="Import chat JSON or ZIP"
          disabled={importingChat}
          onClick={() => chatImportInputRef.current?.click()}
        >
          <UploadIcon size={15} />
        </IconButton>
        <input
          ref={chatImportInputRef}
          data-ui="sidebar-chat-import-input"
          type="file"
          accept="application/json,application/zip,.json,.zip"
          hidden
          onChange={(event) => void handleImportChatFile(event)}
        />
        <div data-ui="sidebar-sort" ref={sortMenuRef}>
          <IconButton
            type="button"
            data-ui="sidebar-sort-button"
            aria-label={`Sort: ${activeSortOption.label}`}
            title={`Sort: ${activeSortOption.label}`}
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            onClick={() => setSortMenuOpen((open) => !open)}
          >
            <SortIcon size={15} />
          </IconButton>
          {sortMenuOpen ? (
            <div data-ui="sidebar-sort-menu" role="menu" aria-label="Sort chats">
              {SIDEBAR_SORT_OPTIONS.map((option) => (
                <Button
                  key={option.mode}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.mode === sortMode}
                  data-active={option.mode === sortMode ? 'true' : undefined}
                  onClick={() => handleSelectSortMode(option.mode)}
                >
                  <span>{option.label}</span>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        {renderSearchDetails()}
      </div>
      {shouldVirtualizeSidebar ? renderVirtualSidebarList() : renderStaticSidebarList()}
      {folderDeleteTarget ? (
        <div data-ui="folder-delete-dialog" role="dialog" aria-label="Delete folder">
          <div data-ui="folder-delete-title">{folderDeleteTarget.name}</div>
          <label data-ui="folder-delete-option">
            <input
              type="checkbox"
              checked={deleteFolderChats}
              onChange={(event) => setDeleteFolderChats(event.currentTarget.checked)}
            />
            <span>Delete chats in folder</span>
          </label>
          <div data-ui="folder-delete-actions">
            <Button
              type="button"
              onClick={() => {
                setFolderDeleteTarget(null)
                setDeleteFolderChats(false)
              }}
            >
              Cancel
            </Button>
            <Button type="button" tone="danger" onClick={() => void commitDeleteFolder()}>
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
})

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

function renderHighlightedText(
  text: string,
  ranges: readonly { start: number; end: number }[],
): ReactNode {
  if (ranges.length === 0) return text
  const parts: ReactNode[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(0, Math.min(text.length, range.start))
    const end = Math.max(start, Math.min(text.length, range.end))
    if (start > cursor) parts.push(text.slice(cursor, start))
    if (end > start) {
      parts.push(
        <mark key={`${start}-${end}-${text.slice(start, end)}`} data-search-hit="">
          {text.slice(start, end)}
        </mark>,
      )
    }
    cursor = end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { SidebarSortMode } from '../core/sidebar-sort'
import type { ChatFolder, ChatTag, FolderId } from '../core/types'
import {
  catalogApplication,
  catalogChatPresentation,
  catalogCollapsedFolderIds,
  catalogSidebarSortMode,
} from '../store/catalog-application'
import type {
  ChatSearchSurface,
  OrganizationCatalogPageRequest,
  SearchFilters,
  SearchResult,
  SearchScope,
  SearchSession,
  WorkspaceFence,
} from '../store/presentation-contracts'
import { orderedSearchResults } from '../store/search-session'
import { getWorkspaceRuntimeFence, subscribeWorkspaceRuntime } from '../store/workspace-runtime'

export interface ChatCatalogSearchRequest {
  readonly surface: ChatSearchSurface
  readonly query: string
  readonly scope: SearchScope
  readonly filters: SearchFilters
  readonly enabled?: boolean
}

export interface ChatCatalogSearchProjection {
  readonly session: SearchSession | null
  readonly orderedResults: readonly SearchResult[]
}

interface OrganizationCatalogState<Row> {
  readonly rows: readonly Row[]
  readonly nextCursor?: string
  readonly loading: boolean
  readonly error: unknown
}

type OrganizationCatalogPageReader<Row> = (
  request: OrganizationCatalogPageRequest,
  signal: AbortSignal,
) => Promise<{
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly value: {
    readonly rows: readonly Row[]
    readonly nextCursor?: string
  }
}>

export interface OrganizationCatalogProjection<Row> extends OrganizationCatalogState<Row> {
  readonly loadMore: () => void
}

export interface OrganizationCatalogApplication {
  readonly folders: OrganizationCatalogProjection<ChatFolder>
  readonly tags: OrganizationCatalogProjection<ChatTag>
}

const EMPTY_ORGANIZATION_ROWS: readonly never[] = Object.freeze([])
const ORGANIZATION_CATALOG_PAGE_SIZE = 40

export function useCatalogTab() {
  return useSyncExternalStore(
    catalogApplication.tab.subscribe,
    catalogApplication.tab.getSnapshot,
    catalogApplication.tab.getSnapshot,
  )
}

export function useWorkspaceFence(): WorkspaceFence | null {
  return useSyncExternalStore(
    (listener) => subscribeWorkspaceRuntime(listener),
    getWorkspaceRuntimeFence,
    getWorkspaceRuntimeFence,
  )
}

export function useSidebarCatalogApplication(request: {
  readonly enabled?: boolean
  readonly mode: 'expanded' | 'collapsed'
  readonly sort: SidebarSortMode
  readonly collapsedFolderIds: readonly FolderId[]
  readonly pageSize: number
  readonly createdAtGroupBoundaries: readonly [number, number, number, number]
}) {
  const workspaceFence = useWorkspaceFence()
  const controller = catalogApplication.sessions.sidebar()
  const session = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  const collapsedFolderKey = request.collapsedFolderIds.join('\u0000')
  const collapsedFolderIds = useMemo(
    () => Object.freeze(collapsedFolderKey === '' ? [] : collapsedFolderKey.split('\u0000')),
    [collapsedFolderKey],
  )
  const [today, yesterday, previous7Days, previous30Days] = request.createdAtGroupBoundaries
  const createdAtGroupBoundaries = useMemo(
    () => Object.freeze([today, yesterday, previous7Days, previous30Days] as const),
    [previous30Days, previous7Days, today, yesterday],
  )
  useEffect(() => {
    if (!workspaceFence || request.enabled === false) return
    controller.request({
      ...workspaceFence,
      mode: request.mode,
      sort: request.sort,
      collapsedFolderIds,
      pageSize: request.pageSize,
      createdAtGroupBoundaries,
    })
  }, [
    collapsedFolderIds,
    controller,
    createdAtGroupBoundaries,
    request.enabled,
    request.mode,
    request.pageSize,
    request.sort,
    workspaceFence,
  ])
  const loadMore = useCallback(() => controller.loadMore(), [controller])
  useEffect(() => {
    if (!session) return
    catalogApplication.tab.observeChatRows(
      session.page.rows.flatMap((row) => (row.kind === 'chat' ? [row.chat] : [])),
    )
  }, [session])
  const model = useMemo(
    () => ({
      presentationRows: session?.page.rows ?? Object.freeze([]),
      folders: session?.page.meta.folders ?? Object.freeze([]),
      tags: session?.page.meta.tags ?? Object.freeze([]),
      aggregate: session?.page.meta.aggregate ?? null,
      loadedTotalRows: session?.page.rows.length ?? 0,
      hasMore: session?.page.nextCursor !== undefined,
      exactVisibleChats: session?.page.meta.exactVisibleChats ?? 0,
      interactive: session?.interactive === true,
    }),
    [session],
  )
  return useMemo(() => ({ model, loadMore }), [loadMore, model])
}

export function useOrganizationCatalogApplication(request: {
  readonly foldersDemanded: boolean
  readonly tagsDemanded: boolean
  readonly pageSize?: number
}): OrganizationCatalogApplication {
  const workspaceFence = useWorkspaceFence()
  const [refreshRevision, setRefreshRevision] = useState(0)
  const demanded = request.foldersDemanded || request.tagsDemanded
  useEffect(() => {
    if (!demanded) return
    return catalogApplication.organization.subscribe(() =>
      setRefreshRevision((revision) => revision + 1),
    )
  }, [demanded])
  const pageSize = request.pageSize ?? ORGANIZATION_CATALOG_PAGE_SIZE
  const folders = useDemandPagedOrganizationCatalog<ChatFolder>(
    'folder.catalog-page',
    request.foldersDemanded,
    pageSize,
    workspaceFence,
    refreshRevision,
    queryFolderCatalogPage,
  )
  const tags = useDemandPagedOrganizationCatalog<ChatTag>(
    'tag.catalog-page',
    request.tagsDemanded,
    pageSize,
    workspaceFence,
    refreshRevision,
    queryTagCatalogPage,
  )
  return useMemo(() => ({ folders, tags }), [folders, tags])
}

function useDemandPagedOrganizationCatalog<Row extends { readonly id: string }>(
  kind: 'folder.catalog-page' | 'tag.catalog-page',
  demanded: boolean,
  pageSize: number,
  workspaceFence: WorkspaceFence | null,
  refreshRevision: number,
  queryPage: OrganizationCatalogPageReader<Row>,
): OrganizationCatalogProjection<Row> {
  const [state, setState] = useState<OrganizationCatalogState<Row>>({
    rows: EMPTY_ORGANIZATION_ROWS,
    loading: false,
    error: null,
  })
  const stateRef = useRef(state)
  const generationRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const loadingRef = useRef(false)

  const publish = useCallback((next: OrganizationCatalogState<Row>) => {
    stateRef.current = next
    setState(next)
  }, [])

  const readPage = useCallback(
    async (cursor: string | undefined, replace: boolean, generation: number) => {
      if (!workspaceFence || loadingRef.current) return
      loadingRef.current = true
      const controller = new AbortController()
      controllerRef.current = controller
      publish({ ...stateRef.current, loading: true, error: null })
      try {
        const envelope = await queryPage(
          {
            limit: pageSize,
            ...(cursor ? { cursor } : {}),
          },
          controller.signal,
        )
        if (
          generationRef.current !== generation ||
          envelope.workspaceId !== workspaceFence.workspaceId ||
          envelope.replacementEpoch !== workspaceFence.replacementEpoch
        ) {
          return
        }
        const value = envelope.value
        const rows = replace
          ? value.rows
          : [
              ...new Map(
                [...stateRef.current.rows, ...value.rows].map((row) => [row.id, row]),
              ).values(),
            ]
        publish({
          rows: Object.freeze(rows.map((row) => ({ ...row }))),
          ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
          loading: false,
          error: null,
        })
      } catch (error) {
        if (generationRef.current !== generation || controller.signal.aborted) return
        publish({ ...stateRef.current, loading: false, error })
      } finally {
        if (generationRef.current === generation) {
          loadingRef.current = false
          if (controllerRef.current === controller) controllerRef.current = null
        }
      }
    },
    [pageSize, publish, queryPage, workspaceFence],
  )

  useEffect(() => {
    void refreshRevision
    const generation = generationRef.current + 1
    generationRef.current = generation
    controllerRef.current?.abort()
    controllerRef.current = null
    loadingRef.current = false
    publish({ rows: EMPTY_ORGANIZATION_ROWS, loading: false, error: null })
    if (demanded && workspaceFence) {
      void readPage(undefined, true, generation).catch((error: unknown) => {
        console.error('[organization-catalog]', { kind, error })
      })
    }
    return () => controllerRef.current?.abort()
  }, [demanded, kind, publish, readPage, refreshRevision, workspaceFence])

  const loadMore = useCallback(() => {
    const cursor = stateRef.current.nextCursor
    if (!demanded || !cursor) return
    void readPage(cursor, false, generationRef.current).catch((error: unknown) => {
      console.error('[organization-catalog]', { kind, error })
    })
  }, [demanded, kind, readPage])

  return useMemo(() => ({ ...state, loadMore }), [loadMore, state])
}

function queryFolderCatalogPage(request: OrganizationCatalogPageRequest, signal: AbortSignal) {
  return catalogApplication.organization.readFolderPage(request, signal)
}

function queryTagCatalogPage(request: OrganizationCatalogPageRequest, signal: AbortSignal) {
  return catalogApplication.organization.readTagPage(request, signal)
}

export function useChatCatalogSearch(
  request: ChatCatalogSearchRequest,
): ChatCatalogSearchProjection {
  const controller = catalogApplication.sessions.chatSearch(request.surface)
  const session = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )
  useLayoutEffect(() => {
    if (request.enabled === false) {
      controller.abort()
      return
    }
    return controller.request({
      query: request.query,
      scope: request.scope,
      filters: request.filters,
    })
  }, [controller, request.enabled, request.filters, request.query, request.scope])
  const orderedResults = useMemo(() => orderedSearchResults(session?.results), [session?.results])
  return { session, orderedResults }
}

export {
  DEFAULT_SEARCH_FILTERS,
  hasActiveSearchFilters,
  hasSearchWork,
} from '../store/chat-search'
export type { SearchFilters, SearchResult } from '../store/presentation-contracts'
export {
  catalogApplication,
  catalogChatPresentation,
  catalogCollapsedFolderIds,
  catalogSidebarSortMode,
}

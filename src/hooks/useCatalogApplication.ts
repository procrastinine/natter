import { useCallback, useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { SidebarSortMode } from '../core/sidebar-sort'
import type { FolderId } from '../core/types'
import {
  catalogApplication,
  catalogChatPresentation,
  catalogCollapsedFolderIds,
  catalogSidebarSortMode,
} from '../store/catalog-application'
import type {
  ChatSearchSurface,
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
      exactTotalRows: session?.page.meta.exactTotalRows ?? 0,
      exactVisibleChats: session?.page.meta.exactVisibleChats ?? 0,
      interactive: session?.interactive === true,
    }),
    [session],
  )
  return useMemo(() => ({ model, loadMore }), [loadMore, model])
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

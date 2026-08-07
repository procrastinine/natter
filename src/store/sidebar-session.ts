import type { ChatFolder, ChatTag, FolderId } from '../core/types'
import type {
  ChatSidebarAggregate,
  SidebarPresentationMeasurement,
  SidebarPresentationPage,
  SidebarPresentationRequest,
  SidebarPresentationRow,
  WorkspaceFence,
} from './repository'
import {
  createTabCatalogSession,
  type NormalizedTabCatalogRequest,
  type TabCatalogChangeImpact,
  type TabCatalogSessionAdapter,
  type TabCatalogSessionSnapshot,
} from './tab-catalog-session'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type {
  ReadEnvelope,
  WorkspaceReadAuthority,
  WorkspaceRepository,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'
import type { WorkspaceUsableSurfaceSettlementPort } from './workspace-runtime-control'

interface SidebarSessionRequest extends WorkspaceFence {
  readonly mode: 'expanded' | 'collapsed'
  readonly sort: SidebarPresentationRequest['sort']
  readonly collapsedFolderIds: readonly FolderId[]
  readonly pageSize: number
  readonly createdAtGroupBoundaries: readonly [number, number, number, number]
}

type SidebarSessionQuery = Omit<SidebarPresentationRequest, 'cursor' | 'limit' | 'countMode'>

interface SidebarSessionPageMeta {
  readonly exactVisibleChats: number
  readonly aggregate: ChatSidebarAggregate
  readonly folders: readonly ChatFolder[]
  readonly tags: readonly ChatTag[]
  readonly measurement: SidebarPresentationMeasurement
}

export type SidebarSessionSnapshot = TabCatalogSessionSnapshot<
  SidebarPresentationRow,
  SidebarSessionPageMeta
>

export interface SidebarPresentationSessionSource {
  readonly readPage: (
    request: SidebarPresentationRequest,
    signal: AbortSignal,
  ) => Promise<ReadEnvelope<SidebarPresentationPage>>
  readonly subscribeEffects: (
    apply: (effect: WorkspaceEffect) => void,
    recover: (effect: WorkspaceEffect) => void,
  ) => () => void
}

interface SidebarSessionDependencies {
  readonly source?: SidebarPresentationSessionSource
  readonly firstPageSettlement: WorkspaceUsableSurfaceSettlementPort<'sidebar-first-page'>
}

export interface SidebarSessionController {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => SidebarSessionSnapshot | null
  readonly request: (request: SidebarSessionRequest) => void
  readonly loadMore: () => void
  readonly refresh: () => void
  readonly dispose: () => void
}

const EMPTY_AGGREGATE: ChatSidebarAggregate = Object.freeze({
  totalCount: 0,
  activeCount: 0,
  archivedCount: 0,
  pinnedCount: 0,
  visibleCount: 0,
  visiblePinnedCount: 0,
  folderCounts: Object.freeze({}),
  folderAggregates: Object.freeze({}),
  rootCount: 0,
  rootVisibleCount: 0,
  rootVisiblePinnedCount: 0,
})

const EMPTY_MEASUREMENT: SidebarPresentationMeasurement = Object.freeze({
  rootChatRowsRead: 0,
  folderChildRowsRead: 0,
  folderCatalogRowsRead: 0,
  tagCatalogRowsRead: 0,
  completionProbeQueries: 0,
  completionProbeKeysRead: 0,
  createdAtGroupProbeQueries: 0,
  createdAtGroupProbeKeysRead: 0,
})

export function createSidebarSessionController(
  dependencies: SidebarSessionDependencies,
): SidebarSessionController {
  const source = dependencies.source ?? createWorkspaceSource()
  const core = createTabCatalogSession(sidebarAdapter(source), source.subscribeEffects)
  const settleFirstPage = () => {
    const snapshot = core.getSnapshot()
    if (!snapshot || (snapshot.status !== 'ready' && snapshot.status !== 'error')) return
    dependencies.firstPageSettlement
      .claim({
        workspaceId: snapshot.workspaceId,
        replacementEpoch: snapshot.replacementEpoch,
      })
      ?.settle(
        snapshot.status === 'error' ? 'error' : snapshot.page.rows.length === 0 ? 'empty' : 'ready',
      )
  }
  const stopFirstPage = core.subscribe(settleFirstPage)
  settleFirstPage()
  return {
    subscribe: core.subscribe,
    getSnapshot: core.getSnapshot,
    request: (request) => core.request(request),
    loadMore: () => core.loadMore(),
    refresh: () => core.refresh(),
    dispose: () => {
      stopFirstPage()
      core.dispose()
    },
  }
}

function createWorkspaceSource(repository?: WorkspaceRepository): SidebarPresentationSessionSource {
  const currentRepository = () => repository ?? getWorkspaceRepository()
  const read = <T>(
    signal: AbortSignal,
    operation: (
      workspace: WorkspaceRepository,
      permit: WorkspaceReadAuthority,
    ) => Promise<ReadEnvelope<T>>,
  ) =>
    runWorkspaceRead('repository-query', (permit) => operation(currentRepository(), permit), {
      signal,
    })
  return {
    readPage: (request, signal) =>
      read(signal, (workspace, permit) =>
        workspace.query(
          permit,
          { kind: 'sidebar.presentation-page', request },
          { signal: permit.signal },
        ),
      ),
    subscribeEffects: (apply, recover) =>
      subscribeWorkspaceEffects({
        owner: 'sidebar-session',
        factKinds: [
          'sidebar-row-changed',
          'sidebar-row-deleted',
          'chat-deleted',
          'conversation-created',
        ],
        impactKinds: ['sidebar', 'chat', 'folder', 'tag'],
        replacements: false,
        apply,
        recover: (_error, effect) => {
          recover(effect)
          return WORKSPACE_EFFECT_RECOVERY_OWNED
        },
      }),
  }
}

function sidebarAdapter(
  source: SidebarPresentationSessionSource,
): TabCatalogSessionAdapter<
  SidebarSessionRequest,
  SidebarSessionQuery,
  SidebarPresentationRow,
  string,
  SidebarSessionPageMeta
> {
  return {
    disposedError: 'SidebarSessionDisposed',
    normalize: normalizeSidebarRequest,
    requestKey: sidebarRequestKey,
    emptyPage: () =>
      Object.freeze({
        rows: Object.freeze([]),
        meta: Object.freeze({
          exactVisibleChats: 0,
          aggregate: EMPTY_AGGREGATE,
          folders: Object.freeze([]),
          tags: Object.freeze([]),
          measurement: EMPTY_MEASUREMENT,
        }),
      }),
    readPage: async (query, page, signal) => {
      const envelope = await source.readPage(
        {
          ...query,
          limit: page.limit,
          ...(page.cursor ? { cursor: page.cursor } : {}),
          countMode: page.previousMeta ? 'omit' : 'exact',
        },
        signal,
      )
      const value = envelope.value
      const exactVisibleChats = value.exactVisibleChats ?? page.previousMeta?.exactVisibleChats
      const aggregate = value.aggregate ?? page.previousMeta?.aggregate
      const folders = mergeFolders(page.previousMeta?.folders, value.folders)
      const tags = mergeTags(page.previousMeta?.tags, value.tags)
      if (exactVisibleChats === undefined || !aggregate) {
        throw new Error('SidebarPresentationMetadataMissing')
      }
      return {
        workspaceId: envelope.workspaceId,
        replacementEpoch: envelope.replacementEpoch,
        value: Object.freeze({
          rows: Object.freeze(value.rows.map(cloneSidebarPresentationRow)),
          ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
          meta: Object.freeze({
            exactVisibleChats,
            aggregate,
            folders,
            tags,
            measurement: value.measurement,
          }),
        }),
      }
    },
    changeImpact: sidebarChangeImpact,
    rowId: (row) => row.key,
    cloneRow: cloneSidebarPresentationRow,
    compareRows: () => 0,
  }
}

function mergeFolders(
  previous: readonly ChatFolder[] | undefined,
  current: readonly ChatFolder[] | undefined,
): readonly ChatFolder[] {
  const merged = new Map((previous ?? []).map((folder) => [folder.id, folder]))
  for (const folder of current ?? []) merged.set(folder.id, folder)
  return Object.freeze([...merged.values()])
}

function mergeTags(
  previous: readonly ChatTag[] | undefined,
  current: readonly ChatTag[] | undefined,
): readonly ChatTag[] {
  const merged = new Map((previous ?? []).map((tag) => [tag.id, tag]))
  for (const tag of current ?? []) merged.set(tag.id, tag)
  return Object.freeze([...merged.values()])
}

function normalizeSidebarRequest(
  request: SidebarSessionRequest,
): NormalizedTabCatalogRequest<SidebarSessionQuery> {
  const pageSize = Number.isSafeInteger(request.pageSize)
    ? Math.min(500, Math.max(1, request.pageSize))
    : 100
  const query: SidebarSessionQuery = Object.freeze({
    mode: request.mode,
    sort: request.sort,
    collapsedFolderIds: Object.freeze([...new Set(request.collapsedFolderIds)].sort()),
    createdAtGroupBoundaries: request.createdAtGroupBoundaries,
  })
  const fence = {
    workspaceId: request.workspaceId,
    replacementEpoch: request.replacementEpoch,
  }
  return {
    ...fence,
    requestKey: sidebarRequestKey(fence, query, pageSize),
    query,
    pageSize,
  }
}

function sidebarRequestKey(
  fence: WorkspaceFence,
  query: SidebarSessionQuery,
  pageSize: number,
): string {
  return JSON.stringify([fence.workspaceId, fence.replacementEpoch, query, pageSize])
}

function sidebarChangeImpact(effect: WorkspaceEffect): TabCatalogChangeImpact<string> {
  const changedIds = new Set<string>()
  const deletedIds = new Set<string>()
  if (effect.kind === 'replace') {
    return { relevant: false, broad: false, changedIds, deletedIds }
  }
  const relevant =
    (effect.factsByKind['sidebar-row-changed']?.length ?? 0) > 0 ||
    (effect.factsByKind['sidebar-row-deleted']?.length ?? 0) > 0 ||
    (effect.factsByKind['chat-deleted']?.length ?? 0) > 0 ||
    (effect.factsByKind['conversation-created']?.length ?? 0) > 0 ||
    sidebarImpactRelevant(effect.impactByKind)
  return { relevant, broad: relevant, changedIds, deletedIds }
}

function sidebarImpactRelevant(
  impact: Extract<WorkspaceEffect, { kind: 'changed' }>['impactByKind'],
): boolean {
  if (impact === 'all') return true
  return (
    (impact.sidebar?.length ?? 0) > 0 ||
    (impact.chat?.length ?? 0) > 0 ||
    (impact.folder?.length ?? 0) > 0 ||
    (impact.tag?.length ?? 0) > 0 ||
    (impact.workspace?.length ?? 0) > 0
  )
}

function cloneSidebarPresentationRow(row: SidebarPresentationRow): SidebarPresentationRow {
  switch (row.kind) {
    case 'chat':
      return { ...row, chat: { ...row.chat, tags: [...row.chat.tags] } }
    case 'folder':
      return { ...row, folder: { ...row.folder } }
    case 'time-group':
    case 'folder-empty':
      return { ...row }
  }
}

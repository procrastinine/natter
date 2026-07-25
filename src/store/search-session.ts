import type { ChatId } from '../core/types'
import { createCatalogQueryTransitionScheduler } from './catalog-query-transition'
import {
  type ChatSearchUpdate,
  cloneSearchFilters,
  hasSearchWork,
  type SearchFilters,
  type SearchResult,
  type SearchScope,
  searchChats,
} from './chat-search'
import {
  type MountedProjectionReconcileEvent,
  mountRepositoryProjection,
} from './mounted-projection-lifecycle'
import type { WorkspaceFence } from './repository'
import type { WorkspaceEffect } from './workspace-effect-hub'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type {
  WorkspaceDeltaFact,
  WorkspaceDependency,
  WorkspaceRepository,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { isWorkspaceRuntimeClosedError, runWorkspaceRead } from './workspace-runtime'

type SearchStatus = 'idle' | 'debouncing' | 'scanning' | 'done' | 'aborted' | 'error'

export interface SearchSession {
  readonly queryId: string
  readonly query: string
  readonly scope: SearchScope
  readonly filters: SearchFilters
  readonly status: SearchStatus
  readonly interactive: boolean
  readonly results: SearchResultCollection
  readonly candidateCount: number
  readonly completedCount: number
  readonly startedAt: number
  readonly completedAt?: number
  readonly error?: string
  readonly invalidatedAt?: number
  readonly invalidationRevision: number
}

export interface SearchResultCollection {
  readonly orderedIds: readonly ChatId[]
  readonly byChatId: ReadonlyMap<ChatId, SearchResult>
  readonly values: readonly SearchResult[]
  readonly revision: number
  readonly size: number
}

interface SearchSessionRequest {
  readonly query: string
  readonly scope?: SearchScope
  readonly filters?: SearchFilters
  readonly repo?: WorkspaceRepository
  readonly concurrency?: number
  readonly debounceMs?: number
}

export interface SearchSessionController {
  readonly getSnapshot: () => SearchSession | null
  readonly subscribe: (listener: () => void) => () => void
  readonly request: (input: SearchSessionRequest) => () => void
  readonly abort: () => void
  readonly dispose: () => void
}

interface ActiveSearchRequest {
  readonly queryId: string
  readonly input: SearchSessionRequest
  repository: WorkspaceRepository | null
  readonly candidateStates: Map<ChatId, SearchCandidateState>
  nextCandidateRank: number
  pendingCandidateCount: number
  readonly invalidatedChatIds: Set<ChatId>
  readonly deletedChatIds: Set<ChatId>
  workspaceFence: WorkspaceFence | null
  controller: AbortController | null
  scanAdmitted: boolean
  drainScheduled: boolean
  running: boolean
  fullRescanRequested: boolean
  resumeReadPending: boolean
  disposed: boolean
  stopChanges: (() => void) | null
}

interface SearchCandidateState {
  readonly rank: number
  pending: boolean
}

const SEARCH_DEBOUNCE_MS = 150
const EMPTY_RESULTS = createResultCollection()
const SEARCH_RELEVANT_DEPENDENCY_KINDS = Object.freeze([
  'workspace',
  'chat',
  'sidebar',
  'message-header',
  'message-body',
  'message-preview',
  'folder',
  'tag',
] as const) satisfies readonly WorkspaceDependency['kind'][]
const searchRelevantDependencyKinds: ReadonlySet<WorkspaceDependency['kind']> = new Set(
  SEARCH_RELEVANT_DEPENDENCY_KINDS,
)

export function createSearchSessionController(): SearchSessionController {
  let snapshot: SearchSession | null = null
  let active: ActiveSearchRequest | null = null
  let disposed = false
  const listeners = new Set<() => void>()

  const publish = (next: SearchSession | null) => {
    if (Object.is(snapshot, next)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }

  const cancelActive = () => {
    const request = active
    active = null
    if (!request) return
    request.disposed = true
    request.controller?.abort()
    request.controller = null
    detachRequestSource(request)
  }

  const attachRequestSource = (request: ActiveSearchRequest): WorkspaceRepository | null => {
    if (!lifecycle.isOpen()) return null
    const repository = request.repository ?? request.input.repo ?? getWorkspaceRepository()
    request.repository = repository
    request.stopChanges ??= subscribeWorkspaceEffects({
      owner: 'search-session',
      factKinds: [
        'chat-deleted',
        'conversation-created',
        'message-revision',
        'sidebar-row-changed',
        'sidebar-row-deleted',
      ],
      impactKinds: SEARCH_RELEVANT_DEPENDENCY_KINDS,
      replacements: false,
      apply: (effect) => receiveChange(request, effect),
      recover: () => {
        recoverRequest(request)
        return WORKSPACE_EFFECT_RECOVERY_OWNED
      },
    })
    return repository
  }

  const detachRequestSource = (request: ActiveSearchRequest) => {
    request.stopChanges?.()
    request.stopChanges = null
    if (!request.input.repo) request.repository = null
  }

  const scheduleDrain = (request: ActiveSearchRequest) => {
    if (
      active !== request ||
      request.disposed ||
      !request.scanAdmitted ||
      request.running ||
      request.drainScheduled
    ) {
      return
    }
    if (!lifecycle.isOpen()) {
      request.resumeReadPending = true
      return
    }
    request.drainScheduled = true
    queueMicrotask(() => {
      request.drainScheduled = false
      startDrain(request)
    })
  }

  const receiveChange = (request: ActiveSearchRequest, change: WorkspaceEffect) => {
    if (active !== request || request.disposed) return
    if (change.kind === 'replace') return
    const impact = searchImpact(change)
    if (impact.fullRescan) request.fullRescanRequested = true
    for (const chatId of impact.deletedChatIds) {
      removeCandidate(request, chatId)
      request.deletedChatIds.add(chatId)
      request.invalidatedChatIds.delete(chatId)
    }
    for (const chatId of impact.changedChatIds) {
      request.deletedChatIds.delete(chatId)
      request.invalidatedChatIds.add(chatId)
    }
    if (
      !impact.fullRescan &&
      impact.deletedChatIds.size === 0 &&
      impact.changedChatIds.size === 0
    ) {
      return
    }
    const needsScan = impact.fullRescan || impact.changedChatIds.size > 0
    const current = snapshotFor(request)
    if (current) {
      publish({
        ...current,
        status: needsScan && current.status === 'done' ? 'debouncing' : current.status,
        interactive: current.interactive || current.results.size > 0,
        results: applyResultBatch(current.results, [], [...impact.deletedChatIds]),
        candidateCount: request.candidateStates.size,
        completedCount: request.candidateStates.size - request.pendingCandidateCount,
        invalidatedAt: Date.now(),
        invalidationRevision: current.invalidationRevision + 1,
      })
    }
    if (needsScan) scheduleDrain(request)
    else if (!request.running) request.deletedChatIds.clear()
  }

  const recoverRequest = (request: ActiveSearchRequest) => {
    if (active !== request || request.disposed) return
    request.fullRescanRequested = true
    const current = snapshotFor(request)
    if (current) {
      publish({
        ...current,
        status: 'debouncing',
        interactive: current.interactive || current.results.size > 0,
        invalidatedAt: Date.now(),
        invalidationRevision: current.invalidationRevision + 1,
      })
    }
    scheduleDrain(request)
  }

  const startDrain = (request: ActiveSearchRequest) => {
    if (active !== request || request.disposed || !request.scanAdmitted || request.running) return
    if (!lifecycle.isOpen()) {
      request.resumeReadPending = true
      return
    }
    const repository = attachRequestSource(request)
    if (!repository) {
      request.resumeReadPending = true
      return
    }
    const controller = new AbortController()
    request.controller = controller
    request.running = true
    let running: Promise<void>
    try {
      running = runWorkspaceRead(
        'search-session',
        async (authority) => {
          request.workspaceFence = {
            workspaceId: authority.workspaceId,
            replacementEpoch: authority.replacementEpoch,
          }
          request.resumeReadPending = false
          for (;;) {
            if (active !== request || request.disposed || controller.signal.aborted) return
            const current = snapshotFor(request)
            if (!current) return
            const fullRescan = request.fullRescanRequested
            const chatIds = fullRescan ? undefined : [...request.invalidatedChatIds]
            if (chatIds !== undefined && chatIds.length === 0 && current.status === 'done') return
            request.fullRescanRequested = false
            if (fullRescan) {
              clearCandidates(request)
              request.invalidatedChatIds.clear()
              request.deletedChatIds.clear()
            } else if (chatIds) {
              for (const chatId of chatIds) {
                request.invalidatedChatIds.delete(chatId)
                removeCandidate(request, chatId)
              }
            }
            const scanSnapshot: SearchSession = {
              ...current,
              status: 'scanning',
              interactive: true,
              ...(fullRescan
                ? {
                    completedCount: 0,
                    candidateCount: 0,
                  }
                : {}),
            }
            publish(scanSnapshot)
            const batcher = new SearchUpdateBatcher(
              request.queryId,
              () => snapshotFor(request),
              publish,
              request,
              request.deletedChatIds,
              fullRescan,
            )
            await searchChats({
              queryId: request.queryId,
              query: current.query,
              scope: current.scope,
              filters: current.filters,
              repo: repository,
              authority,
              signal: controller.signal,
              collectResults: false,
              onUpdate: (update) => batcher.accept(update),
              ...(request.input.concurrency ? { concurrency: request.input.concurrency } : {}),
              ...(chatIds ? { chatIds } : {}),
            })
            batcher.flush()
            request.deletedChatIds.clear()
            if (searchRequestNeedsAnotherPass(request)) {
              continue
            }
            const done = snapshotFor(request)
            if (done) {
              const staleResultIds = fullRescan
                ? done.results.orderedIds.filter((chatId) => !request.candidateStates.has(chatId))
                : []
              publish({
                ...done,
                status: 'done',
                interactive: true,
                results:
                  staleResultIds.length > 0
                    ? applyResultBatch(done.results, [], staleResultIds)
                    : done.results,
                completedAt: Date.now(),
              })
            }
            return
          }
        },
        { signal: controller.signal },
      )
      running = lifecycle.track(running)
    } catch (error) {
      settleDrain(request, controller, error)
      return
    }
    void running.then(
      () => settleDrain(request, controller),
      (error: unknown) => settleDrain(request, controller, error),
    )
  }

  const settleDrain = (
    request: ActiveSearchRequest,
    controller: AbortController,
    error?: unknown,
  ) => {
    if (request.controller === controller) request.controller = null
    request.running = false
    if (active !== request || request.disposed) return
    request.deletedChatIds.clear()
    if (error !== undefined && isWorkspaceRuntimeClosedError(error)) {
      request.resumeReadPending = true
      return
    }
    if (error !== undefined && !isAbortError(error)) {
      const current = snapshotFor(request)
      if (current) {
        publish({
          ...current,
          status: 'error',
          interactive: false,
          error: searchRequestErrorMessage(error),
          completedAt: Date.now(),
        })
      }
      return
    }
    if (request.fullRescanRequested || request.invalidatedChatIds.size > 0) {
      scheduleDrain(request)
    }
  }

  const suspendForRuntime = () => {
    const request = active
    if (!request || request.disposed) return
    detachRequestSource(request)
    request.resumeReadPending = true
    request.fullRescanRequested = true
    request.controller?.abort()
    const current = snapshotFor(request)
    if (!current) return
    publish({
      ...current,
      status: current.results.size > 0 ? 'scanning' : 'debouncing',
      interactive: false,
    })
  }

  const reconcileRuntime = (event: MountedProjectionReconcileEvent) => {
    const request = active
    if (!request || request.disposed) return
    detachRequestSource(request)
    const current = snapshotFor(request)
    const replaced =
      request.workspaceFence !== null && !sameFence(request.workspaceFence, event.fence)
    request.workspaceFence = Object.freeze({ ...event.fence })
    request.resumeReadPending = true
    request.fullRescanRequested = true
    clearCandidates(request)
    request.invalidatedChatIds.clear()
    request.deletedChatIds.clear()
    request.controller?.abort()
    if (!current) return
    publish({
      ...current,
      status: 'debouncing',
      interactive: false,
      ...(replaced
        ? {
            results: createResultCollection([], current.results.revision + 1),
            completedCount: 0,
            candidateCount: 0,
          }
        : {}),
      invalidatedAt: Date.now(),
      invalidationRevision: current.invalidationRevision + 1,
    })
  }

  const resumeRuntime = (event: MountedProjectionReconcileEvent) => {
    const request = active
    if (!request || request.disposed) return
    if (!sameFence(request.workspaceFence, event.fence)) reconcileRuntime(event)
    if (!request.resumeReadPending || !request.scanAdmitted) return
    attachRequestSource(request)
    scheduleDrain(request)
  }

  const admitRequest = (request: ActiveSearchRequest) => {
    if (active !== request || request.disposed) return
    request.scanAdmitted = true
    attachRequestSource(request)
    scheduleDrain(request)
  }

  const queryTransitions = createCatalogQueryTransitionScheduler(admitRequest)

  const commitRequest = (input: SearchSessionRequest): (() => void) => {
    if (disposed) return () => undefined
    queryTransitions.cancelPending()
    const resultRevision = (snapshot?.results.revision ?? -1) + 1
    cancelActive()
    const filters = cloneSearchFilters(input.filters)
    const queryId = nextQueryId()
    const searchable = hasSearchWork(input.query, filters)
    const next: SearchSession = {
      queryId,
      query: input.query,
      scope: input.scope ?? 'last-updated-branch',
      filters,
      status: searchable ? 'debouncing' : 'idle',
      interactive: !searchable,
      results: searchable ? createResultCollection([], resultRevision) : EMPTY_RESULTS,
      candidateCount: 0,
      completedCount: 0,
      startedAt: Date.now(),
      invalidationRevision: 0,
    }
    publish(next)
    if (!searchable) return () => undefined
    const request: ActiveSearchRequest = {
      queryId,
      input,
      repository: input.repo ?? null,
      candidateStates: new Map(),
      nextCandidateRank: 0,
      pendingCandidateCount: 0,
      invalidatedChatIds: new Set(),
      deletedChatIds: new Set(),
      workspaceFence: lifecycle.acceptedFence(),
      controller: null,
      scanAdmitted: false,
      drainScheduled: false,
      running: false,
      fullRescanRequested: true,
      resumeReadPending: false,
      disposed: false,
      stopChanges: null,
    }
    active = request
    return queryTransitions.schedule(request, {
      debounceKey: input.query.trim() || null,
      debounceMs: input.debounceMs ?? SEARCH_DEBOUNCE_MS,
    })
  }

  const disposeOwner = () => {
    if (disposed) return
    disposed = true
    queryTransitions.dispose()
    cancelActive()
    listeners.clear()
    snapshot = null
  }

  const lifecycle = mountRepositoryProjection({
    suspend: suspendForRuntime,
    reconcile: reconcileRuntime,
    resume: resumeRuntime,
    dispose: disposeOwner,
  })

  const controller: SearchSessionController = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    request: (input) => {
      if (disposed) throw new Error('SearchSessionControllerDisposed')
      return commitRequest(input)
    },
    abort: () => {
      if (disposed) return
      queryTransitions.cancelPending()
      cancelActive()
      if (snapshot && snapshot.status !== 'idle') {
        publish({
          ...snapshot,
          status: 'aborted',
          interactive: false,
          results: createResultCollection([], snapshot.results.revision + 1),
          candidateCount: 0,
          completedCount: 0,
          completedAt: Date.now(),
        })
      }
    },
    dispose: () => {
      if (disposed) return
      disposeOwner()
      lifecycle.dispose()
    },
  }
  return controller

  function snapshotFor(request: ActiveSearchRequest): SearchSession | null {
    return snapshot?.queryId === request.queryId ? snapshot : null
  }
}

export function orderedSearchResults(
  results: SearchResultCollection | undefined,
): readonly SearchResult[] {
  return results?.values ?? []
}

class SearchUpdateBatcher {
  private readonly queryId: string
  private readonly read: () => SearchSession | null
  private readonly publish: (next: SearchSession | null) => void
  private readonly request: ActiveSearchRequest
  private readonly deletedChatIds: ReadonlySet<ChatId>
  private readonly deferRemovals: boolean
  private readonly upserts: SearchResult[] = []
  private readonly removals: ChatId[] = []
  private pendingCount = 0
  private nextBatchSize = 1
  private completedCount = 0
  private candidateCount = 0

  constructor(
    queryId: string,
    read: () => SearchSession | null,
    publish: (next: SearchSession | null) => void,
    request: ActiveSearchRequest,
    deletedChatIds: ReadonlySet<ChatId>,
    deferRemovals: boolean,
  ) {
    this.queryId = queryId
    this.read = read
    this.publish = publish
    this.request = request
    this.deletedChatIds = deletedChatIds
    this.deferRemovals = deferRemovals
    this.updateCounts()
  }

  accept(update: ChatSearchUpdate): void {
    const session = this.read()
    if (!session || update.queryId !== this.queryId) return
    if (update.kind === 'started') {
      for (const chatId of update.candidateChatIds) {
        if (this.deletedChatIds.has(chatId)) continue
        const state = this.request.candidateStates.get(chatId)
        if (!state) {
          this.request.candidateStates.set(chatId, {
            rank: this.request.nextCandidateRank,
            pending: true,
          })
          this.request.nextCandidateRank += 1
          this.request.pendingCandidateCount += 1
        } else if (!state.pending) {
          state.pending = true
          this.request.pendingCandidateCount += 1
        }
      }
      this.updateCounts()
      this.publish({
        ...session,
        completedCount: this.completedCount,
        candidateCount: this.candidateCount,
      })
      return
    }
    if (update.kind === 'done') {
      this.updateCounts()
      return
    }
    const chatId = update.kind === 'hit' ? update.result.chatId : update.chatId
    if (update.kind !== 'excluded' && !this.deletedChatIds.has(chatId)) {
      let state = this.request.candidateStates.get(chatId)
      if (!state) {
        state = { rank: this.request.nextCandidateRank, pending: false }
        this.request.nextCandidateRank += 1
        this.request.candidateStates.set(chatId, state)
      } else if (state.pending) {
        state.pending = false
        this.request.pendingCandidateCount -= 1
      }
    } else {
      removeCandidate(this.request, chatId)
    }
    this.updateCounts()
    if (update.kind === 'hit' && !this.deletedChatIds.has(update.result.chatId)) {
      this.upserts.push(update.result)
    } else if (!this.deferRemovals && session.results.byChatId.has(chatId)) {
      this.removals.push(chatId)
    }
    this.pendingCount += 1
    if (this.pendingCount >= this.nextBatchSize) {
      this.flush()
      this.nextBatchSize *= 2
    }
  }

  flush(): void {
    const session = this.read()
    if (!session) return
    this.publish({
      ...session,
      results:
        this.upserts.length > 0 || this.removals.length > 0
          ? applyResultBatch(
              session.results,
              this.upserts,
              this.removals,
              this.request.candidateStates,
            )
          : session.results,
      completedCount: this.completedCount,
      candidateCount: this.candidateCount,
    })
    this.upserts.length = 0
    this.removals.length = 0
    this.pendingCount = 0
  }

  private updateCounts(): void {
    this.candidateCount = this.request.candidateStates.size
    this.completedCount = this.candidateCount - this.request.pendingCandidateCount
  }
}

interface SearchImpact {
  fullRescan: boolean
  changedChatIds: ReadonlySet<ChatId>
  deletedChatIds: ReadonlySet<ChatId>
}

const EMPTY_SEARCH_CHAT_IDS: ReadonlySet<ChatId> = new Set()
const EMPTY_SEARCH_IMPACT: SearchImpact = Object.freeze({
  fullRescan: false,
  changedChatIds: EMPTY_SEARCH_CHAT_IDS,
  deletedChatIds: EMPTY_SEARCH_CHAT_IDS,
})

function searchImpact(change: Extract<WorkspaceEffect, { kind: 'changed' }>): SearchImpact {
  const dependencies = change.impact
  if (
    dependencies !== 'all' &&
    !dependencies.some(searchDependencyCanMatter) &&
    change.facts.length === 0
  ) {
    return EMPTY_SEARCH_IMPACT
  }
  const changedChatIds = new Set<ChatId>()
  const deletedChatIds = new Set<ChatId>()
  if (dependencies === 'all') {
    return { fullRescan: true, changedChatIds, deletedChatIds }
  }
  const state = { fullRescan: false, catalogTouched: false }
  const visitDependency = (dependency: WorkspaceDependency) => {
    if (dependency.kind === 'chat' || dependency.kind === 'sidebar') {
      if (dependency.chatIds) {
        for (const chatId of dependency.chatIds) changedChatIds.add(chatId)
      } else {
        state.fullRescan = true
      }
      return
    }
    if (
      dependency.kind === 'message-header' ||
      dependency.kind === 'message-preview' ||
      dependency.kind === 'message-body'
    ) {
      if (dependency.chatId) changedChatIds.add(dependency.chatId)
      else state.fullRescan = true
      return
    }
    if (dependency.kind === 'folder' || dependency.kind === 'tag') {
      if (!dependency.facets || dependency.facets.includes('membership')) {
        state.catalogTouched = true
      }
      return
    }
    if (dependency.kind === 'workspace') state.fullRescan = true
  }
  const visitFact = (fact: WorkspaceDeltaFact) => {
    if (
      fact.kind === 'message-revision' ||
      fact.kind === 'conversation-created' ||
      fact.kind === 'sidebar-row-changed'
    ) {
      changedChatIds.add(fact.chatId)
      return
    }
    if (fact.kind === 'chat-deleted' || fact.kind === 'sidebar-row-deleted') {
      deletedChatIds.add(fact.chatId)
      changedChatIds.delete(fact.chatId)
    }
  }
  for (const fact of change.facts) visitFact(fact)
  for (const dependency of dependencies) visitDependency(dependency)
  for (const chatId of deletedChatIds) changedChatIds.delete(chatId)
  if (state.catalogTouched) state.fullRescan = true
  return { fullRescan: state.fullRescan, changedChatIds, deletedChatIds }
}

function searchDependencyCanMatter(dependency: WorkspaceDependency): boolean {
  return searchRelevantDependencyKinds.has(dependency.kind)
}

function searchRequestNeedsAnotherPass(request: ActiveSearchRequest): boolean {
  return request.fullRescanRequested || request.invalidatedChatIds.size > 0
}

function searchRequestErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'SearchSessionRequestFailed'
}

function nextQueryId(): string {
  return `search-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createResultCollection(
  results: readonly SearchResult[] = [],
  revision = 0,
): SearchResultCollection {
  const orderedIds: ChatId[] = []
  const byChatId = new Map<ChatId, SearchResult>()
  for (const result of results) {
    if (!byChatId.has(result.chatId)) orderedIds.push(result.chatId)
    byChatId.set(result.chatId, result)
  }
  return resultCollectionFromMap(orderedIds, byChatId, revision)
}

function resultCollectionFromMap(
  orderedIds: ChatId[],
  byChatId: Map<ChatId, SearchResult>,
  revision: number,
): SearchResultCollection {
  const values: SearchResult[] = []
  for (const chatId of orderedIds) {
    const result = byChatId.get(chatId)
    if (result) values.push(result)
  }
  return {
    orderedIds: Object.freeze(orderedIds),
    byChatId,
    values: Object.freeze(values),
    revision,
    size: byChatId.size,
  }
}

function applyResultBatch(
  results: SearchResultCollection,
  upserts: readonly SearchResult[],
  removals: readonly ChatId[],
  candidateStates?: ReadonlyMap<ChatId, SearchCandidateState>,
): SearchResultCollection {
  let byChatId: Map<ChatId, SearchResult> | null = null
  const removedIds = new Set<ChatId>()
  const appendedIds: ChatId[] = []
  const appendedIdSet = new Set<ChatId>()
  for (const chatId of removals) {
    const current = byChatId ?? results.byChatId
    if (!current.has(chatId)) continue
    byChatId ??= new Map(results.byChatId)
    byChatId.delete(chatId)
    removedIds.add(chatId)
    appendedIdSet.delete(chatId)
  }
  for (const result of upserts) {
    const chatId = result.chatId
    const current = byChatId ?? results.byChatId
    if (Object.is(current.get(chatId), result)) continue
    byChatId ??= new Map(results.byChatId)
    if (!byChatId.has(chatId)) {
      if (!results.byChatId.has(chatId)) {
        if (!appendedIdSet.has(chatId)) appendedIds.push(chatId)
        appendedIdSet.add(chatId)
      }
    }
    removedIds.delete(chatId)
    byChatId.set(chatId, result)
  }
  if (!byChatId) return results
  const retainedOrder: ChatId[] = []
  for (const chatId of results.orderedIds) {
    if (!removedIds.has(chatId) && byChatId.has(chatId)) retainedOrder.push(chatId)
  }
  const additions = appendedIds.filter(
    (chatId) => appendedIdSet.has(chatId) && byChatId.has(chatId),
  )
  if (candidateStates) {
    additions.sort((left, right) => compareCandidateRank(left, right, candidateStates))
  }
  const nextOrder = candidateStates
    ? mergeCandidateOrder(retainedOrder, additions, candidateStates)
    : [...retainedOrder, ...additions]
  return resultCollectionFromMap(nextOrder, byChatId, results.revision + 1)
}

function mergeCandidateOrder(
  retained: readonly ChatId[],
  additions: readonly ChatId[],
  candidateStates: ReadonlyMap<ChatId, SearchCandidateState>,
): ChatId[] {
  const merged: ChatId[] = []
  let retainedIndex = 0
  let additionIndex = 0
  while (retainedIndex < retained.length && additionIndex < additions.length) {
    const retainedId = retained[retainedIndex] as ChatId
    const additionId = additions[additionIndex] as ChatId
    if (compareCandidateRank(retainedId, additionId, candidateStates) <= 0) {
      merged.push(retainedId)
      retainedIndex += 1
    } else {
      merged.push(additionId)
      additionIndex += 1
    }
  }
  merged.push(...retained.slice(retainedIndex), ...additions.slice(additionIndex))
  return merged
}

function compareCandidateRank(
  left: ChatId,
  right: ChatId,
  candidateStates: ReadonlyMap<ChatId, SearchCandidateState>,
): number {
  const rankDifference =
    (candidateStates.get(left)?.rank ?? Number.MAX_SAFE_INTEGER) -
    (candidateStates.get(right)?.rank ?? Number.MAX_SAFE_INTEGER)
  return rankDifference === 0 ? left.localeCompare(right) : rankDifference
}

function removeCandidate(request: ActiveSearchRequest, chatId: ChatId): void {
  const state = request.candidateStates.get(chatId)
  if (!state) return
  if (state.pending) request.pendingCandidateCount -= 1
  request.candidateStates.delete(chatId)
}

function clearCandidates(request: ActiveSearchRequest): void {
  request.candidateStates.clear()
  request.nextCandidateRank = 0
  request.pendingCandidateCount = 0
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  )
}

function sameFence(left: WorkspaceFence | null, right: WorkspaceFence): boolean {
  return (
    left !== null &&
    left.workspaceId === right.workspaceId &&
    left.replacementEpoch === right.replacementEpoch
  )
}

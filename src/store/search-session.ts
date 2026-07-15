import {
  type ChatSearchUpdate,
  type SearchFilters,
  type SearchScope,
  searchChats,
} from './chat-search'
import type { WorkspaceRepository } from './repository'
import {
  type SearchResultMutation,
  type SearchSession,
  useSearchStore,
} from './zustand/searchStore'

interface SearchSessionRequest {
  query: string
  scope?: SearchScope
  filters?: SearchFilters
  repo?: WorkspaceRepository
  concurrency?: number
  debounceMs?: number
}

const SEARCH_DEBOUNCE_MS = 150

let pendingTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribeStore: (() => void) | null = null

interface ActiveSearchRequest {
  readonly session: SearchSession
  readonly input: SearchSessionRequest
  controller: AbortController | null
  runPromise: Promise<void> | null
  scheduled: boolean
  needsInitialFullScan: boolean
  handledFullRescanRevision: number
}

let activeRequest: ActiveSearchRequest | null = null

export function requestSearchSession(input: SearchSessionRequest): SearchSession | null {
  cancelPendingTimer()
  cancelActiveRequest()

  useSearchStore.getState().setQuery(input.query, {
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.filters ? { filters: input.filters } : {}),
  })
  const session = useSearchStore.getState().session
  if (!session || session.status === 'idle') return session

  ensureStoreSubscription()
  const request: ActiveSearchRequest = {
    session,
    input,
    controller: null,
    runPromise: null,
    scheduled: false,
    needsInitialFullScan: true,
    handledFullRescanRevision: session.fullRescanRevision,
  }
  activeRequest = request

  const debounceMs = input.debounceMs ?? SEARCH_DEBOUNCE_MS
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    startSearchDrain(request)
  }, debounceMs)
  return session
}

export function abortSearchSession(): void {
  cancelPendingTimer()
  cancelActiveRequest()
  useSearchStore.getState().abort()
}

export function __resetSearchSessionRunnerForTests(): void {
  cancelPendingTimer()
  cancelActiveRequest()
  unsubscribeStore?.()
  unsubscribeStore = null
}

function startSearchDrain(request: ActiveSearchRequest): void {
  if (activeRequest !== request) return
  request.scheduled = false
  if (request.runPromise) return
  const promise = Promise.resolve().then(() => runSearchDrain(request))
  request.runPromise = promise
  void promise.finally(() => {
    if (request.runPromise === promise) request.runPromise = null
    if (activeRequest !== request) return
    request.controller = null
    if (hasPendingSearchWork(request)) scheduleSearchDrain(request)
  })
}

async function runSearchDrain(request: ActiveSearchRequest): Promise<void> {
  const session = request.session
  const controller = new AbortController()
  request.controller = controller
  useSearchStore.getState().setStatus('scanning')
  const batcher = new SearchUpdateBatcher(session.queryId)

  try {
    for (;;) {
      const current = useSearchStore.getState().session
      if (!current || current.queryId !== session.queryId) return

      const fullRescanRevision = current.fullRescanRevision
      if (request.needsInitialFullScan || fullRescanRevision > request.handledFullRescanRevision) {
        if (!request.needsInitialFullScan) {
          if (!useSearchStore.getState().prepareFullRescan(session.queryId, fullRescanRevision)) {
            continue
          }
        }
        request.needsInitialFullScan = false
        request.handledFullRescanRevision = fullRescanRevision
        await runSearchPass(session, request.input, controller.signal, batcher)
        batcher.flush()
        continue
      }

      const tailPassChatIds = [...current.tailPassChatIds.keys()]
      if (tailPassChatIds.length === 0) {
        useSearchStore.getState().setStatus('done')
        return
      }
      useSearchStore.getState().clearTailPassChatIds(tailPassChatIds)
      await runSearchPass(session, request.input, controller.signal, batcher, tailPassChatIds)
      batcher.flush()
    }
  } catch (error) {
    batcher.flush()
    if ((error as { name?: string }).name === 'AbortError') {
      if (activeRequest === request) useSearchStore.getState().abort()
    } else if (activeRequest === request) {
      useSearchStore
        .getState()
        .setStatus('error', error instanceof Error ? error.message : String(error))
    }
  }
}

async function runSearchPass(
  session: SearchSession,
  input: SearchSessionRequest,
  signal: AbortSignal,
  batcher: SearchUpdateBatcher,
  chatIds?: readonly string[],
): Promise<void> {
  await searchChats({
    queryId: session.queryId,
    query: session.query,
    scope: session.scope,
    filters: session.filters,
    signal,
    onUpdate: (update) => batcher.accept(update),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    ...(chatIds ? { chatIds } : {}),
  })
}

class SearchUpdateBatcher {
  private readonly queryId: string
  private readonly mutations: SearchResultMutation[] = []
  private pendingCount = 0
  private nextBatchSize = 1
  private completedCount = 0
  private candidateCount = 0

  constructor(queryId: string) {
    this.queryId = queryId
  }

  accept(update: ChatSearchUpdate): void {
    const session = useSearchStore.getState().session
    if (!session || session.queryId !== update.queryId || update.queryId !== this.queryId) return
    if (update.kind === 'started') {
      this.completedCount = 0
      this.candidateCount = update.candidateCount
      useSearchStore.getState().setProgress(0, update.candidateCount)
      return
    }
    if (update.kind === 'done') {
      this.completedCount = update.completedCount
      this.candidateCount = update.candidateCount
      return
    }

    this.completedCount = update.completedCount
    this.candidateCount = update.candidateCount
    this.mutations.push(
      update.kind === 'hit'
        ? { kind: 'upsert', result: update.result }
        : { kind: 'remove', chatId: update.chatId },
    )
    this.pendingCount += 1
    if (this.pendingCount >= this.nextBatchSize) {
      this.flush()
      this.nextBatchSize *= 2
    }
  }

  flush(): void {
    if (this.pendingCount === 0) {
      const session = useSearchStore.getState().session
      if (session?.queryId === this.queryId) {
        useSearchStore.getState().setProgress(this.completedCount, this.candidateCount)
      }
      return
    }
    const session = useSearchStore.getState().session
    if (session?.queryId === this.queryId) {
      useSearchStore
        .getState()
        .applyResultBatch(this.mutations, this.completedCount, this.candidateCount)
    }
    this.mutations.length = 0
    this.pendingCount = 0
  }
}

function ensureStoreSubscription(): void {
  if (unsubscribeStore) return
  unsubscribeStore = useSearchStore.subscribe((state) => {
    const request = activeRequest
    if (!request) return
    const session = state.session
    if (!session || session.queryId !== request.session.queryId) {
      cancelPendingTimer()
      cancelActiveRequest()
      return
    }
    if (hasPendingSearchWork(request)) scheduleSearchDrain(request)
  })
}

function hasPendingSearchWork(request: ActiveSearchRequest): boolean {
  const session = useSearchStore.getState().session
  return Boolean(
    session &&
      session.queryId === request.session.queryId &&
      (request.needsInitialFullScan ||
        session.fullRescanRevision > request.handledFullRescanRevision ||
        session.tailPassChatIds.size > 0),
  )
}

function scheduleSearchDrain(request: ActiveSearchRequest): void {
  if (activeRequest !== request || request.runPromise || request.scheduled) return
  request.scheduled = true
  queueMicrotask(() => startSearchDrain(request))
}

function cancelActiveRequest(): void {
  const request = activeRequest
  activeRequest = null
  if (!request) return
  request.scheduled = false
  request.controller?.abort()
  request.controller = null
}

function cancelPendingTimer(): void {
  if (pendingTimer === null) return
  clearTimeout(pendingTimer)
  pendingTimer = null
}

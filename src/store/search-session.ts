import {
  searchChats,
  type ChatSearchUpdate,
  type SearchFilters,
  type SearchScope,
} from './chat-search'
import type { WorkspaceRepository } from './repository'
import { useSearchStore, type SearchSession } from './zustand/searchStore'

export interface SearchSessionRequest {
  query: string
  scope?: SearchScope
  filters?: SearchFilters
  repo?: WorkspaceRepository
  concurrency?: number
  debounceMs?: number
}

export const SEARCH_DEBOUNCE_MS = 150

let pendingTimer: ReturnType<typeof setTimeout> | null = null
let activeController: AbortController | null = null
let activeQueryId: string | null = null

export function requestSearchSession(input: SearchSessionRequest): SearchSession | null {
  cancelPendingTimer()
  activeController?.abort()
  activeController = null
  activeQueryId = null

  useSearchStore.getState().setQuery(input.query, {
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.filters ? { filters: input.filters } : {}),
  })
  const session = useSearchStore.getState().session
  if (!session || session.status === 'idle') return session

  const debounceMs = input.debounceMs ?? SEARCH_DEBOUNCE_MS
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    void runSearchSession(session, input)
  }, debounceMs)
  return session
}

export function abortSearchSession(): void {
  cancelPendingTimer()
  activeController?.abort()
  activeController = null
  activeQueryId = null
  useSearchStore.getState().abort()
}

export function __resetSearchSessionRunnerForTests(): void {
  cancelPendingTimer()
  activeController?.abort()
  activeController = null
  activeQueryId = null
}

async function runSearchSession(
  session: SearchSession,
  input: SearchSessionRequest,
): Promise<void> {
  const controller = new AbortController()
  activeController = controller
  activeQueryId = session.queryId
  useSearchStore.getState().setStatus('scanning')

  try {
    await runSearchPass(session, input, controller.signal)
    while (true) {
      const current = useSearchStore.getState().session
      if (!current || current.queryId !== session.queryId) return
      const tailPassChatIds = current.tailPassChatIds
      if (tailPassChatIds.length === 0) break
      useSearchStore.getState().clearTailPassChatIds(tailPassChatIds)
      await runSearchPass(session, input, controller.signal, tailPassChatIds)
    }
    if (activeQueryId === session.queryId) {
      useSearchStore.getState().setStatus('done')
    }
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') {
      if (activeQueryId === session.queryId) useSearchStore.getState().abort()
    } else if (activeQueryId === session.queryId) {
      useSearchStore.getState().setStatus('error', error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (activeQueryId === session.queryId) {
      activeController = null
      activeQueryId = null
    }
  }
}

async function runSearchPass(
  session: SearchSession,
  input: SearchSessionRequest,
  signal: AbortSignal,
  chatIds?: readonly string[],
): Promise<void> {
  await searchChats({
    queryId: session.queryId,
    query: session.query,
    scope: session.scope,
    filters: session.filters,
    signal,
    onUpdate: applySearchUpdate,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    ...(chatIds ? { chatIds } : {}),
  })
}

function applySearchUpdate(update: ChatSearchUpdate): void {
  const session = useSearchStore.getState().session
  if (!session || session.queryId !== update.queryId) return
  switch (update.kind) {
    case 'started':
      useSearchStore.getState().setProgress(0, update.candidateCount)
      return
    case 'hit':
      useSearchStore
        .getState()
        .mergeResult(update.result, update.completedCount, update.candidateCount)
      return
    case 'miss':
      useSearchStore.getState().removeResult(update.chatId)
      useSearchStore.getState().setProgress(update.completedCount, update.candidateCount)
      return
    case 'task-error':
      useSearchStore.getState().removeResult(update.chatId)
      useSearchStore.getState().setProgress(update.completedCount, update.candidateCount)
      return
    case 'done':
      useSearchStore.getState().setProgress(update.completedCount, update.candidateCount)
      return
  }
}

function cancelPendingTimer(): void {
  if (pendingTimer === null) return
  clearTimeout(pendingTimer)
  pendingTimer = null
}

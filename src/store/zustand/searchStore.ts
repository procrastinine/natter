import { create } from 'zustand'
import type { ChatId } from '../../core/types'
import {
  cloneSearchFilters,
  hasSearchWork,
  type SearchFilters,
  type SearchResult,
  type SearchScope,
} from '../chat-search'
import { onEvent } from '../broadcast'

type SearchStatus = 'idle' | 'debouncing' | 'scanning' | 'done' | 'aborted' | 'error'

export interface SearchSession {
  queryId: string
  query: string
  scope: SearchScope
  filters: SearchFilters
  status: SearchStatus
  results: SearchResult[]
  candidateCount: number
  completedCount: number
  startedAt: number
  completedAt?: number
  error?: string
  invalidatedAt?: number
  invalidatedChatIds: ChatId[]
  tailPassChatIds: ChatId[]
  deletedChatIds: ChatId[]
}

interface SearchStoreState {
  session: SearchSession | null
  setQuery: (query: string, options?: Partial<Pick<SearchSession, 'scope' | 'filters'>>) => void
  setStatus: (status: SearchStatus, error?: string) => void
  setProgress: (completedCount: number, candidateCount: number) => void
  mergeResult: (result: SearchResult, completedCount?: number, candidateCount?: number) => void
  replaceResults: (results: SearchResult[]) => void
  removeResult: (chatId: ChatId) => void
  markChatDeleted: (chatId: ChatId) => void
  markChatInvalidated: (chatId: ChatId, options?: { rescan?: boolean }) => void
  clearTailPassChatIds: (chatIds: readonly ChatId[]) => void
  abort: () => void
  reset: () => void
}

let unsubscribe: (() => void) | null = null

function nextQueryId(): string {
  return `search-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export const useSearchStore = create<SearchStoreState>((set) => ({
  session: null,
  setQuery: (query, options = {}) => {
    const filters = cloneSearchFilters(options.filters)
    set({
      session: {
        queryId: nextQueryId(),
        query,
        scope: options.scope ?? 'last-updated-branch',
        filters,
        status: hasSearchWork(query, filters) ? 'debouncing' : 'idle',
        results: [],
        candidateCount: 0,
        completedCount: 0,
        startedAt: Date.now(),
        invalidatedChatIds: [],
        tailPassChatIds: [],
        deletedChatIds: [],
      },
    })
  },
  setStatus: (status, error) =>
    set((state) => {
      if (!state.session) return state
      const next: SearchSession = { ...state.session, status }
      if (status === 'done' || status === 'aborted' || status === 'error') {
        next.completedAt = Date.now()
      }
      if (error !== undefined) next.error = error
      else delete next.error
      return { session: next }
    }),
  setProgress: (completedCount, candidateCount) =>
    set((state) =>
      state.session
        ? {
            session: {
              ...state.session,
              completedCount,
              candidateCount,
            },
          }
        : state,
    ),
  mergeResult: (result, completedCount, candidateCount) =>
    set((state) => {
      if (!state.session) return state
      if (state.session.deletedChatIds.includes(result.chatId)) return state
      const results = upsertResult(state.session.results, result)
      return {
        session: {
          ...state.session,
          results,
          completedCount: completedCount ?? state.session.completedCount,
          candidateCount: candidateCount ?? state.session.candidateCount,
        },
      }
    }),
  replaceResults: (results) =>
    set((state) =>
      state.session
        ? {
            session: {
              ...state.session,
              results: results.filter(
                (result) => !state.session?.deletedChatIds.includes(result.chatId),
              ),
            },
          }
        : state,
    ),
  removeResult: (chatId) =>
    set((state) => {
      if (!state.session) return state
      return {
        session: {
          ...state.session,
          results: state.session.results.filter((result) => result.chatId !== chatId),
        },
      }
    }),
  markChatDeleted: (chatId) =>
    set((state) => {
      if (!state.session) return state
      return {
        session: {
          ...state.session,
          results: state.session.results.filter((result) => result.chatId !== chatId),
          invalidatedChatIds: state.session.invalidatedChatIds.filter((id) => id !== chatId),
          tailPassChatIds: state.session.tailPassChatIds.filter((id) => id !== chatId),
          deletedChatIds: appendUnique(state.session.deletedChatIds, chatId),
        },
      }
    }),
  markChatInvalidated: (chatId, options = {}) =>
    set((state) => {
      if (!state.session) return state
      const invalidatedChatIds = appendUnique(state.session.invalidatedChatIds, chatId)
      const tailPassChatIds =
        options.rescan === true
          ? appendUnique(state.session.tailPassChatIds, chatId)
          : state.session.tailPassChatIds
      return {
        session: {
          ...state.session,
          invalidatedAt: Date.now(),
          invalidatedChatIds,
          tailPassChatIds,
        },
      }
    }),
  clearTailPassChatIds: (chatIds) =>
    set((state) => {
      if (!state.session) return state
      const cleared = new Set(chatIds)
      return {
        session: {
          ...state.session,
          tailPassChatIds: state.session.tailPassChatIds.filter((chatId) => !cleared.has(chatId)),
        },
      }
    }),
  abort: () =>
    set((state) =>
      state.session
        ? { session: { ...state.session, status: 'aborted', completedAt: Date.now() } }
        : state,
    ),
  reset: () => set({ session: null }),
}))

export function startSearchStoreBroadcastListener(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => {
    if (event.kind === 'branch-cache-refreshed') {
      useSearchStore.getState().markChatInvalidated(event.chatId)
    }
    if (event.kind === 'chat-mutated') {
      useSearchStore.getState().markChatInvalidated(event.chatId, { rescan: true })
    }
    if (event.kind === 'chat-deleted') {
      useSearchStore.getState().markChatDeleted(event.chatId)
    }
    if (event.kind === 'tag-deleted') {
      const session = useSearchStore.getState().session
      if (!session) return
      if (
        session.filters.includeTagIds.includes(event.tagId) ||
        session.filters.excludeTagIds.includes(event.tagId)
      ) {
        useSearchStore.setState({
          session: { ...session, invalidatedAt: Date.now(), status: 'debouncing' },
        })
      }
    }
  })
}

export function __resetSearchStoreForTests(): void {
  useSearchStore.getState().reset()
  unsubscribe?.()
  unsubscribe = null
}

function upsertResult(results: readonly SearchResult[], result: SearchResult): SearchResult[] {
  const next = [...results]
  const index = next.findIndex((candidate) => candidate.chatId === result.chatId)
  if (index >= 0) next[index] = result
  else next.push(result)
  return next
}

function appendUnique<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? [...values] : [...values, value]
}

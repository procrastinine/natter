import { create } from 'zustand'
import type { ChatId } from '../../core/types'
import { onEvent } from '../broadcast'
import {
  cloneSearchFilters,
  hasSearchWork,
  type SearchFilters,
  type SearchResult,
  type SearchScope,
} from '../chat-search'

type SearchStatus = 'idle' | 'debouncing' | 'scanning' | 'done' | 'aborted' | 'error'

export interface SearchSession {
  queryId: string
  query: string
  scope: SearchScope
  filters: SearchFilters
  status: SearchStatus
  results: SearchResultCollection
  candidateCount: number
  completedCount: number
  startedAt: number
  completedAt?: number
  error?: string
  invalidatedAt?: number
  invalidatedChatIds: ChatId[]
  tailPassChatIds: ChatId[]
  deletedChatIds: ChatId[]
  deletedChatIdSet: ReadonlySet<ChatId>
}

export interface SearchResultCollection {
  readonly orderedIds: readonly ChatId[]
  readonly byChatId: ReadonlyMap<ChatId, SearchResult>
  readonly revision: number
  readonly size: number
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
const RESULT_INDEX = Symbol('resultIndex')
const RESULT_VALUES = Symbol('resultValues')
const EMPTY_ORDERED_RESULTS: readonly SearchResult[] = []

interface MutableSearchResultCollection extends SearchResultCollection {
  readonly orderedIds: ChatId[]
  readonly byChatId: Map<ChatId, SearchResult>
  readonly [RESULT_INDEX]: Map<ChatId, number>
  readonly [RESULT_VALUES]: SearchResult[]
}

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
        results: createResultCollection(),
        candidateCount: 0,
        completedCount: 0,
        startedAt: Date.now(),
        invalidatedChatIds: [],
        tailPassChatIds: [],
        deletedChatIds: [],
        deletedChatIdSet: new Set(),
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
      const chatId = result.chatId
      if (state.session.deletedChatIdSet.has(chatId)) return state
      const results = upsertResult(state.session.results, chatId, result)
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
              results: createResultCollection(
                results.filter((result) => !state.session?.deletedChatIdSet.has(result.chatId)),
                state.session.results.revision + 1,
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
          results: removeResult(state.session.results, chatId),
        },
      }
    }),
  markChatDeleted: (chatId) =>
    set((state) => {
      if (!state.session) return state
      const deletedChatIdSet = new Set(state.session.deletedChatIdSet)
      deletedChatIdSet.add(chatId)
      return {
        session: {
          ...state.session,
          results: removeResult(state.session.results, chatId),
          invalidatedChatIds: state.session.invalidatedChatIds.filter((id) => id !== chatId),
          tailPassChatIds: state.session.tailPassChatIds.filter((id) => id !== chatId),
          deletedChatIds: appendUnique(state.session.deletedChatIds, chatId),
          deletedChatIdSet,
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
    if (event.kind === 'workspace-invalidated' || event.kind === 'workspace-replaced') {
      useSearchStore.getState().reset()
      return
    }
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

export function orderedSearchResults(
  results: SearchResultCollection | undefined,
): readonly SearchResult[] {
  return results ? mutableResults(results)[RESULT_VALUES] : EMPTY_ORDERED_RESULTS
}

function createResultCollection(
  results: readonly SearchResult[] = [],
  revision = 0,
): SearchResultCollection {
  const collection: MutableSearchResultCollection = {
    orderedIds: [],
    byChatId: new Map(),
    revision,
    size: 0,
    [RESULT_INDEX]: new Map(),
    [RESULT_VALUES]: [],
  }
  for (const result of results) {
    const chatId = result.chatId
    const index = collection[RESULT_INDEX].get(chatId)
    if (index === undefined) {
      collection[RESULT_INDEX].set(chatId, collection.orderedIds.length)
      collection.orderedIds.push(chatId)
      collection[RESULT_VALUES].push(result)
    } else {
      collection[RESULT_VALUES][index] = result
    }
    collection.byChatId.set(chatId, result)
  }
  return { ...collection, size: collection.byChatId.size }
}

function upsertResult(
  results: SearchResultCollection,
  chatId: ChatId,
  result: SearchResult,
): SearchResultCollection {
  const mutable = mutableResults(results)
  const index = mutable[RESULT_INDEX].get(chatId)
  if (index !== undefined) {
    mutable[RESULT_VALUES][index] = result
  } else {
    mutable[RESULT_INDEX].set(chatId, mutable.orderedIds.length)
    mutable.orderedIds.push(chatId)
    mutable[RESULT_VALUES].push(result)
  }
  mutable.byChatId.set(chatId, result)
  return {
    ...mutable,
    revision: results.revision + 1,
    size: mutable.byChatId.size,
  }
}

function removeResult(results: SearchResultCollection, chatId: ChatId): SearchResultCollection {
  const mutable = mutableResults(results)
  const index = mutable[RESULT_INDEX].get(chatId)
  if (index === undefined) return results
  mutable.orderedIds.splice(index, 1)
  mutable[RESULT_VALUES].splice(index, 1)
  mutable.byChatId.delete(chatId)
  mutable[RESULT_INDEX].delete(chatId)
  for (let position = index; position < mutable.orderedIds.length; position += 1) {
    const shiftedChatId = mutable.orderedIds[position]
    if (shiftedChatId !== undefined) mutable[RESULT_INDEX].set(shiftedChatId, position)
  }
  return {
    ...mutable,
    revision: results.revision + 1,
    size: mutable.byChatId.size,
  }
}

function mutableResults(results: SearchResultCollection): MutableSearchResultCollection {
  return results as MutableSearchResultCollection
}

function appendUnique<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? [...values] : [...values, value]
}

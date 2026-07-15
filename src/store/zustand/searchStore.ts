import { create } from 'zustand'
import type { ChatId } from '../../core/types'
import { PersistentStringMap } from '../../lib/persistent-string-map'
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
  invalidationRevision: number
  fullRescanRevision: number
  invalidatedChatIds: PersistentStringMap<true>
  tailPassChatIds: PersistentStringMap<true>
  deletedChatIds: PersistentStringMap<true>
}

export interface SearchResultCollection {
  readonly orderedIds: readonly ChatId[]
  readonly byChatId: ReadonlyMap<ChatId, SearchResult>
  readonly revision: number
  readonly size: number
}

export type SearchResultMutation =
  | { readonly kind: 'upsert'; readonly result: SearchResult }
  | { readonly kind: 'remove'; readonly chatId: ChatId }

interface SearchStoreState {
  session: SearchSession | null
  setQuery: (query: string, options?: Partial<Pick<SearchSession, 'scope' | 'filters'>>) => void
  setStatus: (status: SearchStatus, error?: string) => void
  setProgress: (completedCount: number, candidateCount: number) => void
  applyResultBatch: (
    mutations: readonly SearchResultMutation[],
    completedCount: number,
    candidateCount: number,
  ) => void
  replaceResults: (results: SearchResult[]) => void
  markChatDeleted: (chatId: ChatId) => void
  markChatInvalidated: (chatId: ChatId, options?: { rescan?: boolean }) => void
  requestFullRescan: () => void
  prepareFullRescan: (queryId: string, fullRescanRevision: number) => boolean
  clearTailPassChatIds: (chatIds: readonly ChatId[]) => void
  abort: () => void
  reset: () => void
}

let unsubscribe: (() => void) | null = null
const RESULT_VALUES = Symbol('resultValues')
const EMPTY_ORDERED_RESULTS: readonly SearchResult[] = []

interface MutableSearchResultCollection extends SearchResultCollection {
  readonly [RESULT_VALUES]: readonly SearchResult[]
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
        invalidationRevision: 0,
        fullRescanRevision: 0,
        invalidatedChatIds: PersistentStringMap.empty(),
        tailPassChatIds: PersistentStringMap.empty(),
        deletedChatIds: PersistentStringMap.empty(),
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
  applyResultBatch: (mutations, completedCount, candidateCount) =>
    set((state) => {
      if (!state.session) return state
      const allowed = mutations.filter(
        (mutation) =>
          mutation.kind === 'remove' || !state.session?.deletedChatIds.has(mutation.result.chatId),
      )
      return {
        session: {
          ...state.session,
          results: applyResultMutations(state.session.results, allowed),
          completedCount,
          candidateCount,
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
                results.filter((result) => !state.session?.deletedChatIds.has(result.chatId)),
                state.session.results.revision + 1,
              ),
            },
          }
        : state,
    ),
  markChatDeleted: (chatId) =>
    set((state) => {
      if (!state.session) return state
      return {
        session: {
          ...state.session,
          results: applyResultMutations(state.session.results, [{ kind: 'remove', chatId }]),
          invalidationRevision: state.session.invalidationRevision + 1,
          invalidatedChatIds: state.session.invalidatedChatIds.delete(chatId),
          tailPassChatIds: state.session.tailPassChatIds.delete(chatId),
          deletedChatIds: state.session.deletedChatIds.set(chatId, true),
        },
      }
    }),
  markChatInvalidated: (chatId, options = {}) =>
    set((state) => {
      if (!state.session) return state
      if (state.session.deletedChatIds.has(chatId)) return state
      const invalidatedChatIds = state.session.invalidatedChatIds.set(chatId, true)
      const tailPassChatIds =
        options.rescan === true
          ? state.session.tailPassChatIds.set(chatId, true)
          : state.session.tailPassChatIds
      return {
        session: {
          ...state.session,
          invalidatedAt: Date.now(),
          invalidationRevision: state.session.invalidationRevision + 1,
          invalidatedChatIds,
          tailPassChatIds,
          ...(options.rescan === true && state.session.status === 'done'
            ? { status: 'debouncing' as const }
            : {}),
        },
      }
    }),
  requestFullRescan: () =>
    set((state) =>
      state.session
        ? {
            session: {
              ...state.session,
              status: 'debouncing',
              invalidatedAt: Date.now(),
              invalidationRevision: state.session.invalidationRevision + 1,
              fullRescanRevision: state.session.fullRescanRevision + 1,
            },
          }
        : state,
    ),
  prepareFullRescan: (queryId, fullRescanRevision) => {
    let prepared = false
    set((state) => {
      if (
        !state.session ||
        state.session.queryId !== queryId ||
        state.session.fullRescanRevision !== fullRescanRevision
      ) {
        return state
      }
      prepared = true
      return {
        session: {
          ...state.session,
          status: 'scanning',
          results: createResultCollection([], state.session.results.revision + 1),
          completedCount: 0,
          candidateCount: 0,
          tailPassChatIds: PersistentStringMap.empty(),
        },
      }
    })
    return prepared
  },
  clearTailPassChatIds: (chatIds) =>
    set((state) => {
      if (!state.session) return state
      let tailPassChatIds = state.session.tailPassChatIds
      for (const chatId of chatIds) tailPassChatIds = tailPassChatIds.delete(chatId)
      return {
        session: {
          ...state.session,
          tailPassChatIds,
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
        useSearchStore.getState().requestFullRescan()
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
  const orderedIds: ChatId[] = []
  const byChatId = new Map<ChatId, SearchResult>()
  for (const result of results) {
    const chatId = result.chatId
    if (!byChatId.has(chatId)) orderedIds.push(chatId)
    byChatId.set(chatId, result)
  }
  const orderedValues = collectOrderedValues(orderedIds, byChatId)
  return {
    orderedIds: Object.freeze(orderedIds),
    byChatId,
    revision,
    size: byChatId.size,
    [RESULT_VALUES]: Object.freeze(orderedValues),
  } as MutableSearchResultCollection
}

function applyResultMutations(
  results: SearchResultCollection,
  mutations: readonly SearchResultMutation[],
): SearchResultCollection {
  let byChatId: Map<ChatId, SearchResult> | null = null
  const removedFromOrder = new Set<ChatId>()
  const appendedIds: ChatId[] = []
  const appendedIdSet = new Set<ChatId>()
  const queuedAppendIds = new Set<ChatId>()

  for (const mutation of mutations) {
    const current = byChatId === null ? results.byChatId : byChatId
    if (mutation.kind === 'remove') {
      if (!current.has(mutation.chatId)) continue
      if (byChatId === null) byChatId = new Map(results.byChatId)
      byChatId.delete(mutation.chatId)
      removedFromOrder.add(mutation.chatId)
      appendedIdSet.delete(mutation.chatId)
      continue
    }

    const chatId = mutation.result.chatId
    const existing = current.get(chatId)
    if (Object.is(existing, mutation.result)) continue
    if (!existing) {
      if (!queuedAppendIds.has(chatId)) {
        queuedAppendIds.add(chatId)
        appendedIds.push(chatId)
      }
      appendedIdSet.add(chatId)
    }
    if (byChatId === null) byChatId = new Map(results.byChatId)
    byChatId.set(chatId, mutation.result)
  }

  if (byChatId === null) return results
  const nextByChatId = byChatId
  const nextOrderedIds: ChatId[] = []
  for (const chatId of results.orderedIds) {
    if (!removedFromOrder.has(chatId) && nextByChatId.has(chatId)) nextOrderedIds.push(chatId)
  }
  for (const chatId of appendedIds) {
    if (appendedIdSet.has(chatId) && nextByChatId.has(chatId)) nextOrderedIds.push(chatId)
  }
  const orderedValues = collectOrderedValues(nextOrderedIds, nextByChatId)
  return {
    orderedIds: Object.freeze(nextOrderedIds),
    byChatId: nextByChatId,
    revision: results.revision + 1,
    size: nextByChatId.size,
    [RESULT_VALUES]: Object.freeze(orderedValues),
  } as MutableSearchResultCollection
}

function mutableResults(results: SearchResultCollection): MutableSearchResultCollection {
  return results as MutableSearchResultCollection
}

function collectOrderedValues(
  orderedIds: readonly ChatId[],
  byChatId: ReadonlyMap<ChatId, SearchResult>,
): SearchResult[] {
  const values: SearchResult[] = []
  for (const chatId of orderedIds) {
    const result = byChatId.get(chatId)
    if (result) values.push(result)
  }
  return values
}

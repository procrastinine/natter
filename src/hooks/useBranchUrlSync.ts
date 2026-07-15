// URL ↔ branch sync, split by direction so user actions don't get
// reversed.
//
// Bug that motivated the split: when the user swipes/jumps in-tab,
// `setCursor` fires. If the same "seed + write" helper ran for the
// cursor event, it would RE-seed the cursor from the stale URL
// (which still names the pre-swipe sibling), reverting the user's
// swipe. Splitting URL → cursor from cursor → URL fixes this.
//
//   - URL → cursor runs on mount and on `hashchange`. The URL is a
//     user-initiated intent (new tab arrival, back/forward, manual
//     edit). The cursor is seeded once per arrival so the pinned
//     message is on the active path.
//   - cursor → URL runs on every cursor change. After seeding (or
//     after any user swipe), the URL mirrors the active-path leaf
//     via `replaceRoute` (silent, no hashchange fires).
//
// `replaceRoute` updates route-snapshot readers but not URL-arrival
// subscribers, so direction 2 never triggers direction 1.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { chatHref, parseRoute, replaceRoute, subscribeRouteArrival } from '../app/router'
import {
  activePathProjected,
  createMessageTreeProjection,
  cursorKeyOf,
  type MessageTreeProjection,
} from '../core/active-path'
import { seedCursorAtMessageProjected } from '../core/branch-resolve'
import type { ChatId, CursorMap } from '../core/types'
import type { PersistentStringMap } from '../lib/persistent-string-map'
import { loadMessageHeaders, loadMessageHeadersById } from '../store/chats'
import type { MessageHeaderRow } from '../store/message-storage'
import { indexKeys } from '../store/reactive-dependencies'
import { useRepositoryKeyedPresentationQuery } from '../store/reactive-query'
import type { NavigationIntent } from '../store/zustand/chatStore'
import { useChatStore } from '../store/zustand/chatStore'

export interface BranchUrlSyncState {
  headerById: PersistentStringMap<MessageHeaderRow>
  changedHeaderKeys: readonly string[] | null
  changedHeaders: readonly (MessageHeaderRow | undefined)[] | null
  navigationHeaders: readonly MessageHeaderRow[]
  structuralHeaders: readonly StructuralMessageHeader[]
  projection: MessageTreeProjection<StructuralMessageHeader>
}

export type StructuralMessageHeader = Pick<
  MessageHeaderRow,
  'chatId' | 'createdAt' | 'deleted' | 'id' | 'parentId' | 'role' | 'siblingIndex'
>

interface PendingUrlTarget {
  arrival: number
  chatId: ChatId
  messageId: string
  navigationIntent: NavigationIntent
  headersAtCapture: readonly StructuralMessageHeader[]
  freshReadStarted: boolean
  abortController: AbortController
  retryAttempt: number
  retryTimer: ReturnType<typeof setTimeout> | null
}

const URL_READ_RETRY_BASE_MS = 50
const URL_READ_RETRY_MAX_MS = 2_000

function clearPendingUrlRetry(pending: PendingUrlTarget): void {
  if (pending.retryTimer === null) return
  clearTimeout(pending.retryTimer)
  pending.retryTimer = null
}

function resetPendingUrlRead(pending: PendingUrlTarget): void {
  pending.abortController.abort()
  clearPendingUrlRetry(pending)
  pending.abortController = new AbortController()
  pending.freshReadStarted = false
}

function cancelPendingUrlTarget(pending: PendingUrlTarget): void {
  pending.abortController.abort()
  clearPendingUrlRetry(pending)
  pending.freshReadStarted = false
}

let branchProjectionBuildProbe: (() => void) | undefined
let branchHeaderMergeProbe: ((kind: 'full' | 'delta', rowCount: number) => void) | undefined

export function __setBranchProjectionBuildProbeForTests(probe: (() => void) | undefined): void {
  if (import.meta.env.MODE === 'test') branchProjectionBuildProbe = probe
}

export function __setBranchHeaderMergeProbeForTests(
  probe: ((kind: 'full' | 'delta', rowCount: number) => void) | undefined,
): void {
  if (import.meta.env.MODE === 'test') branchHeaderMergeProbe = probe
}

export function useStableStructuralHeaders(
  headers: readonly MessageHeaderRow[],
  reusableSource?: readonly MessageHeaderRow[],
  reusableProjection?: readonly StructuralMessageHeader[],
  changedKeys?: readonly string[] | null,
  changedRows?: readonly (MessageHeaderRow | undefined)[] | null,
): readonly StructuralMessageHeader[] {
  const rowsRef = useRef(new Map<string, StructuralMessageHeader>())
  const indexesRef = useRef(new Map<string, number>())
  const arrayRef = useRef<readonly StructuralMessageHeader[]>([])
  return useMemo(() => {
    if (headers === reusableSource && reusableProjection) {
      arrayRef.current = reusableProjection
      return reusableProjection
    }
    if (
      changedKeys !== undefined &&
      changedKeys !== null &&
      changedRows !== undefined &&
      changedRows !== null &&
      changedKeys.length === changedRows.length
    ) {
      let next = arrayRef.current
      let copied = false
      const deletedIndexes = new Set<number>()
      for (let changeIndex = 0; changeIndex < changedKeys.length; changeIndex += 1) {
        const id = changedKeys[changeIndex] as string
        const header = changedRows[changeIndex]
        const existing = rowsRef.current.get(id)
        const existingIndex = indexesRef.current.get(id)
        if (!header) {
          if (existingIndex !== undefined) deletedIndexes.add(existingIndex)
          rowsRef.current.delete(id)
          indexesRef.current.delete(id)
          continue
        }
        if (
          existing &&
          existing.chatId === header.chatId &&
          existing.parentId === header.parentId &&
          existing.siblingIndex === header.siblingIndex &&
          existing.createdAt === header.createdAt &&
          existing.deleted === header.deleted &&
          existing.role === header.role
        ) {
          continue
        }
        const structuralHeader: StructuralMessageHeader = {
          id: header.id,
          chatId: header.chatId,
          parentId: header.parentId,
          siblingIndex: header.siblingIndex,
          createdAt: header.createdAt,
          role: header.role,
          deleted: header.deleted,
        }
        rowsRef.current.set(id, structuralHeader)
        if (!copied) {
          next = [...next]
          copied = true
        }
        if (existingIndex === undefined) {
          indexesRef.current.set(id, next.length)
          ;(next as StructuralMessageHeader[]).push(structuralHeader)
        } else {
          ;(next as StructuralMessageHeader[])[existingIndex] = structuralHeader
        }
      }
      if (deletedIndexes.size > 0) {
        next = next.filter((_, index) => !deletedIndexes.has(index))
        indexesRef.current.clear()
        for (let index = 0; index < next.length; index += 1) {
          indexesRef.current.set((next[index] as StructuralMessageHeader).id, index)
        }
      }
      if (next !== arrayRef.current) arrayRef.current = next
      return arrayRef.current
    }
    const nextRows = new Map<string, StructuralMessageHeader>()
    const nextIndexes = new Map<string, number>()
    const next = headers.map((header) => {
      const cached = rowsRef.current.get(header.id)
      if (
        cached &&
        cached.chatId === header.chatId &&
        cached.parentId === header.parentId &&
        cached.siblingIndex === header.siblingIndex &&
        cached.createdAt === header.createdAt &&
        cached.deleted === header.deleted &&
        cached.role === header.role
      ) {
        nextRows.set(header.id, cached)
        nextIndexes.set(header.id, nextIndexes.size)
        return cached
      }
      const structuralHeader: StructuralMessageHeader = {
        id: header.id,
        chatId: header.chatId,
        parentId: header.parentId,
        siblingIndex: header.siblingIndex,
        createdAt: header.createdAt,
        role: header.role,
        deleted: header.deleted,
      }
      nextRows.set(header.id, structuralHeader)
      nextIndexes.set(header.id, nextIndexes.size)
      return structuralHeader
    })
    rowsRef.current = nextRows
    indexesRef.current = nextIndexes
    const previous = arrayRef.current
    if (previous.length === next.length && previous.every((row, index) => row === next[index])) {
      return previous
    }
    arrayRef.current = next
    return next
  }, [changedKeys, changedRows, headers, reusableProjection, reusableSource])
}

function sameStructuralHeader(left: MessageHeaderRow, right: MessageHeaderRow): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.parentId === right.parentId &&
    left.siblingIndex === right.siblingIndex &&
    left.createdAt === right.createdAt &&
    left.deleted === right.deleted &&
    left.role === right.role
  )
}

function useStableNavigationHeaders(
  allRows: readonly MessageHeaderRow[] | null,
  changedKeys: readonly string[] | null,
  changedRows: readonly (MessageHeaderRow | undefined)[] | null,
): readonly MessageHeaderRow[] {
  const rowsRef = useRef<readonly MessageHeaderRow[]>([])
  const indexesRef = useRef(new Map<string, number>())
  const fullSourceRef = useRef<readonly MessageHeaderRow[] | null>(null)
  if (allRows !== null) {
    if (fullSourceRef.current !== allRows) {
      fullSourceRef.current = allRows
      rowsRef.current = allRows
      indexesRef.current = new Map(allRows.map((header, index) => [header.id, index]))
    }
    return rowsRef.current
  }
  if (!changedKeys || !changedRows || changedKeys.length !== changedRows.length) {
    return rowsRef.current
  }
  let next = rowsRef.current
  let copied = false
  const deletedIndexes = new Set<number>()
  for (let changeIndex = 0; changeIndex < changedKeys.length; changeIndex += 1) {
    const id = changedKeys[changeIndex] as string
    const header = changedRows[changeIndex]
    const existingIndex = indexesRef.current.get(id)
    const existing = existingIndex === undefined ? undefined : next[existingIndex]
    if (!header) {
      if (existingIndex !== undefined) deletedIndexes.add(existingIndex)
      indexesRef.current.delete(id)
      continue
    }
    if (existing && sameStructuralHeader(existing, header)) continue
    if (!copied) {
      next = [...next]
      copied = true
    }
    if (existingIndex === undefined) {
      indexesRef.current.set(id, next.length)
      ;(next as MessageHeaderRow[]).push(header)
    } else {
      ;(next as MessageHeaderRow[])[existingIndex] = header
    }
  }
  if (deletedIndexes.size > 0) {
    next = next.filter((_, index) => !deletedIndexes.has(index))
    indexesRef.current = new Map(next.map((header, index) => [header.id, index]))
  }
  rowsRef.current = next
  return next
}

export function useBranchUrlSync(chatId: ChatId | null): BranchUrlSyncState {
  const headerSnapshot = useRepositoryKeyedPresentationQuery(
    JSON.stringify(['message-headers', chatId]),
    (signal) => (chatId ? loadMessageHeaders(chatId, { signal }) : Promise.resolve([])),
    (messageIds, signal) => loadMessageHeadersById(messageIds, { signal }),
    [],
    indexKeys('messages', 'chatId', chatId),
    {
      table: 'messages',
      keyOf: (header) => header.id,
      include: (header) => header.chatId === chatId,
      onMerge: (kind, rowCount) => branchHeaderMergeProbe?.(kind, rowCount),
    },
  )
  const navigationHeaders = useStableNavigationHeaders(
    headerSnapshot.allRows,
    headerSnapshot.changedKeys,
    headerSnapshot.changedRows,
  )
  const structuralHeaders = useStableStructuralHeaders(navigationHeaders)
  const messages = structuralHeaders
  const messagesRef = useRef<readonly StructuralMessageHeader[]>(messages)
  messagesRef.current = messages
  const projection = useMemo(() => {
    branchProjectionBuildProbe?.()
    return createMessageTreeProjection(messages)
  }, [messages])
  const projectionRef = useRef<MessageTreeProjection<StructuralMessageHeader>>(projection)
  projectionRef.current = projection

  const projectionForRows = (
    rows: readonly StructuralMessageHeader[],
  ): MessageTreeProjection<StructuralMessageHeader> =>
    rows === messagesRef.current ? projectionRef.current : createMessageTreeProjection(rows)

  const pendingUrlTargetRef = useRef<PendingUrlTarget | null>(null)
  const observedRowsRef = useRef<{
    chatId: ChatId | null
    initialized: boolean
    ids: { has(messageId: string): boolean }
  }>({
    chatId: null,
    initialized: false,
    ids: new Set(),
  })
  const nextUrlArrivalRef = useRef(0)
  const previousChatIdRef = useRef<ChatId | null | undefined>(undefined)
  const activeChatIdRef = useRef(chatId)
  const capturingUrlIntentRef = useRef(false)
  activeChatIdRef.current = chatId

  const captureUrlIntent = useRef<(() => void) | null>(null)
  captureUrlIntent.current = () => {
    const previous = pendingUrlTargetRef.current
    if (previous) cancelPendingUrlTarget(previous)
    const arrival = ++nextUrlArrivalRef.current
    if (!chatId || typeof window === 'undefined') {
      pendingUrlTargetRef.current = null
      return
    }
    const route = parseRoute(window.location.hash)
    if (route.kind !== 'chat' || route.chatId !== chatId || !route.pinnedMessageId) {
      pendingUrlTargetRef.current = null
      return
    }
    capturingUrlIntentRef.current = true
    try {
      pendingUrlTargetRef.current = {
        arrival,
        chatId,
        messageId: route.pinnedMessageId,
        navigationIntent: useChatStore.getState().beginNavigationIntent(chatId),
        headersAtCapture: messagesRef.current,
        freshReadStarted: false,
        abortController: new AbortController(),
        retryAttempt: 0,
        retryTimer: null,
      }
    } finally {
      capturingUrlIntentRef.current = false
    }
  }

  // ─── cursor → URL ────────────────────────────────────────────────
  const writeUrlFromCursor = useRef<(() => void) | null>(null)
  const writeUrlFromRows = (
    rows: readonly StructuralMessageHeader[],
    rowProjection = projectionForRows(rows),
  ) => {
    if (!chatId || typeof window === 'undefined') return
    const route = parseRoute(window.location.hash)
    if (route.kind !== 'chat' || route.chatId !== chatId) return
    const chatState = useChatStore.getState()
    const pendingUrlTarget = pendingUrlTargetRef.current
    if (pendingUrlTarget?.chatId === chatId) {
      if (chatState.isNavigationIntentCurrent(pendingUrlTarget.navigationIntent)) return
      cancelPendingUrlTarget(pendingUrlTarget)
      pendingUrlTargetRef.current = null
    }
    const cursor = chatState.getCursor(chatId) ?? {}
    const path = activePathProjected(rowProjection, cursor)
    const pending = chatState.getPendingBranchNavigation(chatId)
    const committed = chatState.getCommittedPathPresentation(chatId)
    if (committed && committed.pathHeaders.length === 0) {
      replaceRoute(chatHref(chatId))
      return
    }
    const committedPathLeaf = committed?.pathHeaders.at(-1)?.id
    const pendingLeaf =
      pending &&
      pending.revision === chatState.getNavigationRevision(chatId) &&
      Object.entries(pending.selections).every(([key, value]) => cursor[key] === value)
        ? (pending.pathMessageIds.at(-1) ?? null)
        : null
    const repositoryContainsCommittedLeaf =
      committedPathLeaf !== undefined && path.some((header) => header.id === committedPathLeaf)
    const leaf =
      pendingLeaf ??
      (committedPathLeaf && !repositoryContainsCommittedLeaf
        ? committedPathLeaf
        : (path.at(-1)?.id ?? committedPathLeaf))
    if (!leaf) {
      replaceRoute(chatHref(chatId))
      return
    }
    const desired = chatHref(chatId, leaf)
    if (window.location.hash === desired) return
    replaceRoute(desired)
  }
  writeUrlFromCursor.current = () => writeUrlFromRows(messagesRef.current)

  // ─── URL → cursor ────────────────────────────────────────────────
  const seedCursorFromUrl = useRef<(() => boolean) | null>(null)

  // Materialize every path edge this tab has accepted from an authoritative
  // header snapshot. Bootstrap keeps the normal newest-leaf default. After
  // that, a batch of children at an unpinned edge chooses the first sorted
  // child, exactly as serial observation would have pinned the first arrival.
  // Missing pending selections stop the walk until their local row appears.
  const pinObservedPath = useRef<(() => void) | null>(null)
  const pinObservedRows = (
    rows: readonly StructuralMessageHeader[],
    rowProjection = projectionForRows(rows),
  ) => {
    if (!chatId || typeof window === 'undefined') return
    const route = parseRoute(window.location.hash)
    if (route.kind !== 'chat' || route.chatId !== chatId) return
    const observation = observedRowsRef.current
    const hadPriorSnapshot = observation.chatId === chatId && observation.initialized
    const previousObservedIds = observation.ids
    const observedIds =
      rows === messagesRef.current ? headerSnapshot.byKey : new Set(rows.map((row) => row.id))
    observedRowsRef.current = { chatId, initialized: true, ids: observedIds }
    if (rows.length === 0) return
    const state = useChatStore.getState()
    const cursor = state.getCursor(chatId) ?? {}
    const pending = state.getPendingBranchNavigation(chatId)
    const currentPending =
      pending?.revision === state.getNavigationRevision(chatId) ? pending : undefined
    const patch: CursorMap = {}
    if (!hadPriorSnapshot) {
      const path = activePathProjected(rowProjection, cursor)
      for (const child of path) {
        const key = cursorKeyOf(child.parentId)
        const selectedId = cursor[key]
        if (selectedId === child.id) continue
        if (selectedId !== undefined) {
          const selected = rowProjection.byId.get(selectedId)
          if (!selected) {
            if (currentPending?.selections[key] === selectedId) break
          } else if (!selected.deleted && selected.parentId === child.parentId) {
            break
          }
        }
        patch[key] = child.id
      }
    } else {
      let parentId: string | null = null
      const visited = new Set<string>()
      for (;;) {
        const children: readonly StructuralMessageHeader[] =
          rowProjection.liveByParent.get(parentId) ?? []
        if (children.length === 0) break
        const key = cursorKeyOf(parentId)
        const selectedId = cursor[key]
        let child = selectedId ? rowProjection.byId.get(selectedId) : undefined
        if (!child || child.deleted || child.parentId !== parentId) {
          if (selectedId !== undefined && currentPending?.selections[key] === selectedId) break
          const newlyObservedChild = children.find(
            (candidate) => !previousObservedIds.has(candidate.id),
          )
          child = newlyObservedChild ?? children.at(-1)
          if (!child) break
          patch[key] = child.id
        }
        if (visited.has(child.id)) break
        visited.add(child.id)
        parentId = child.id
      }
    }
    if (Object.keys(patch).length > 0) {
      useChatStore.getState().reconcileCursorPatch(chatId, patch)
    }
  }
  pinObservedPath.current = () => pinObservedRows(messagesRef.current)

  const finishUrlIntent = (pending: PendingUrlTarget, rows: readonly StructuralMessageHeader[]) => {
    if (
      pendingUrlTargetRef.current?.arrival !== pending.arrival ||
      activeChatIdRef.current !== pending.chatId
    ) {
      return
    }
    const state = useChatStore.getState()
    if (!state.isNavigationIntentCurrent(pending.navigationIntent)) {
      cancelPendingUrlTarget(pending)
      pendingUrlTargetRef.current = null
      writeUrlFromRows(messagesRef.current)
      return
    }
    const rowProjection = projectionForRows(rows)
    const target = rowProjection.byId.get(pending.messageId)
    if (target && !target.deleted) {
      const cursor = state.getCursor(pending.chatId) ?? {}
      const patch = seedCursorAtMessageProjected(rowProjection, target.id, cursor)
      if (!state.patchCursorForIntent(pending.chatId, pending.navigationIntent, patch)) {
        cancelPendingUrlTarget(pending)
        pendingUrlTargetRef.current = null
        writeUrlFromRows(messagesRef.current)
        return
      }
    }
    cancelPendingUrlTarget(pending)
    pendingUrlTargetRef.current = null
    pinObservedRows(rows, rowProjection)
    writeUrlFromRows(rows, rowProjection)
  }

  const scheduleUrlReadRetry = (pending: PendingUrlTarget) => {
    resetPendingUrlRead(pending)
    const delay = Math.min(
      URL_READ_RETRY_MAX_MS,
      URL_READ_RETRY_BASE_MS * 2 ** Math.min(pending.retryAttempt, 10),
    )
    pending.retryAttempt += 1
    const retryController = pending.abortController
    const retryTimer = setTimeout(() => {
      if (
        pendingUrlTargetRef.current !== pending ||
        pending.retryTimer !== retryTimer ||
        pending.abortController !== retryController
      ) {
        return
      }
      pending.retryTimer = null
      const stillOnChat = activeChatIdRef.current === pending.chatId
      if (
        !stillOnChat ||
        !useChatStore.getState().isNavigationIntentCurrent(pending.navigationIntent)
      ) {
        cancelPendingUrlTarget(pending)
        pendingUrlTargetRef.current = null
        if (stillOnChat) writeUrlFromRows(messagesRef.current)
        return
      }
      seedCursorFromUrl.current?.()
    }, delay)
    pending.retryTimer = retryTimer
  }

  seedCursorFromUrl.current = () => {
    if (!chatId || typeof window === 'undefined') return true
    const pending = pendingUrlTargetRef.current
    if (!pending || pending.chatId !== chatId) return true
    const currentRows = messagesRef.current
    const currentTarget = projectionForRows(currentRows).byId.get(pending.messageId)
    if (currentRows !== pending.headersAtCapture && currentTarget && !currentTarget.deleted) {
      finishUrlIntent(pending, currentRows)
      return true
    }
    if (!pending.freshReadStarted) {
      clearPendingUrlRetry(pending)
      pending.freshReadStarted = true
      const readController = pending.abortController
      void loadMessageHeaders(pending.chatId, { signal: readController.signal }).then(
        (freshHeaders) => {
          if (
            pendingUrlTargetRef.current !== pending ||
            pending.abortController !== readController
          ) {
            return
          }
          finishUrlIntent(pending, freshHeaders)
        },
        () => {
          if (
            pendingUrlTargetRef.current !== pending ||
            pending.abortController !== readController
          ) {
            return
          }
          scheduleUrlReadRetry(pending)
        },
      )
    }
    return false
  }

  // Keep the URL-arrival capability across React's development lifecycle
  // replay. Cleanup cancels only the physical read; a failed or aborted read
  // cannot prove that the pinned row is absent and therefore cannot rewrite
  // the address. The replayed setup resumes from the same per-tab intent.
  useLayoutEffect(
    () => () => {
      const pending = pendingUrlTargetRef.current
      if (pending) resetPendingUrlRead(pending)
    },
    [],
  )

  // Header publications pin before paint so a remote sibling cannot flash and
  // then be corrected. Cursor-only changes do not trigger this path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId/messages changes intentionally trigger the ref-backed URL sync.
  useLayoutEffect(() => {
    if (previousChatIdRef.current !== chatId) {
      previousChatIdRef.current = chatId
      observedRowsRef.current = { chatId, initialized: false, ids: new Set() }
      captureUrlIntent.current?.()
    }
    if (seedCursorFromUrl.current?.() === false) return
    if (headerSnapshot.loaded) pinObservedPath.current?.()
    writeUrlFromCursor.current?.()
  }, [chatId, headerSnapshot.loaded, messages])

  // Cursor changes (swipe / send / delete / jump): URL follows.
  // DO NOT call seedCursorFromUrl here — that would re-seed from the
  // stale URL and undo the user's action.
  useEffect(() => {
    if (!chatId) return
    const initialState = useChatStore.getState()
    let previousCursor = initialState.getCursor(chatId)
    let previousRevision = initialState.getNavigationRevision(chatId)
    let previousPending = initialState.getPendingBranchNavigation(chatId)
    let previousCommitted = initialState.getCommittedPathPresentation(chatId)
    const unsub = useChatStore.subscribe((state) => {
      const cursor = state.getCursor(chatId)
      const revision = state.getNavigationRevision(chatId)
      const pending = state.getPendingBranchNavigation(chatId)
      const committed = state.getCommittedPathPresentation(chatId)
      if (
        cursor === previousCursor &&
        revision === previousRevision &&
        pending === previousPending &&
        committed === previousCommitted
      ) {
        return
      }
      previousCursor = cursor
      previousRevision = revision
      previousPending = pending
      previousCommitted = committed
      if (!capturingUrlIntentRef.current) writeUrlFromCursor.current?.()
    })
    return unsub
  }, [chatId])

  // Real or explicit navigation (back/forward, manual hash edit, in-app
  // route action): seed from the new URL, then write back the canonical leaf.
  // Passive replaceRoute projection does not publish to this channel.
  useEffect(() => {
    const onHashChange = () => {
      captureUrlIntent.current?.()
      if (seedCursorFromUrl.current?.() === false) return
      pinObservedPath.current?.()
      writeUrlFromCursor.current?.()
    }
    return subscribeRouteArrival(onHashChange)
  }, [])

  return useMemo(
    () => ({
      headerById: headerSnapshot.byKey,
      changedHeaderKeys: headerSnapshot.changedKeys,
      changedHeaders: headerSnapshot.changedRows,
      navigationHeaders,
      structuralHeaders,
      projection,
    }),
    [
      headerSnapshot.byKey,
      headerSnapshot.changedKeys,
      headerSnapshot.changedRows,
      navigationHeaders,
      projection,
      structuralHeaders,
    ],
  )
}

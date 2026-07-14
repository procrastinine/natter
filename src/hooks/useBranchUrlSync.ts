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
import { loadMessageHeaders } from '../store/chats'
import type { MessageHeaderRow } from '../store/message-storage'
import { indexKeys } from '../store/reactive-dependencies'
import { useRepositoryPresentationQuery } from '../store/reactive-query'
import type { NavigationIntent } from '../store/zustand/chatStore'
import { useChatStore } from '../store/zustand/chatStore'

export interface BranchUrlSyncState {
  headers: readonly MessageHeaderRow[]
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
}

function resetPendingUrlRead(pending: PendingUrlTarget): void {
  pending.abortController.abort()
  pending.abortController = new AbortController()
  pending.freshReadStarted = false
}

let branchProjectionBuildProbe: (() => void) | undefined

export function __setBranchProjectionBuildProbeForTests(probe: (() => void) | undefined): void {
  if (import.meta.env.MODE === 'test') branchProjectionBuildProbe = probe
}

export function useStableStructuralHeaders(
  headers: readonly MessageHeaderRow[],
  reusableSource?: readonly MessageHeaderRow[],
  reusableProjection?: readonly StructuralMessageHeader[],
): readonly StructuralMessageHeader[] {
  const rowsRef = useRef(new Map<string, StructuralMessageHeader>())
  const arrayRef = useRef<readonly StructuralMessageHeader[]>([])
  return useMemo(() => {
    if (headers === reusableSource && reusableProjection) {
      arrayRef.current = reusableProjection
      return reusableProjection
    }
    const nextRows = new Map<string, StructuralMessageHeader>()
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
      return structuralHeader
    })
    rowsRef.current = nextRows
    const previous = arrayRef.current
    if (previous.length === next.length && previous.every((row, index) => row === next[index])) {
      return previous
    }
    arrayRef.current = next
    return next
  }, [headers, reusableProjection, reusableSource])
}

export function useBranchUrlSync(chatId: ChatId | null): BranchUrlSyncState {
  const headers = useRepositoryPresentationQuery(
    JSON.stringify(['message-headers', chatId]),
    (signal) => (chatId ? loadMessageHeaders(chatId, { signal }) : Promise.resolve([])),
    [],
    indexKeys('messages', 'chatId', chatId),
  )
  const structuralHeaders = useStableStructuralHeaders(headers)
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
  const nextUrlArrivalRef = useRef(0)
  const previousChatIdRef = useRef<ChatId | null | undefined>(undefined)
  const activeChatIdRef = useRef(chatId)
  const capturingUrlIntentRef = useRef(false)
  activeChatIdRef.current = chatId

  const captureUrlIntent = useRef<(() => void) | null>(null)
  captureUrlIntent.current = () => {
    pendingUrlTargetRef.current?.abortController.abort()
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
      pendingUrlTarget.abortController.abort()
      pendingUrlTargetRef.current = null
    }
    if (rows.length === 0) {
      replaceRoute(chatHref(chatId))
      return
    }
    const cursor = chatState.getCursor(chatId) ?? {}
    const path = activePathProjected(rowProjection, cursor)
    const pending = chatState.getPendingBranchNavigation(chatId)
    const pendingLeaf =
      pending &&
      pending.revision === chatState.getNavigationRevision(chatId) &&
      Object.entries(pending.selections).every(([key, value]) => cursor[key] === value)
        ? pending.targetMessageId
        : null
    const leaf = pendingLeaf ?? path.at(-1)?.id
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
  // header snapshot. A later remote sibling then cannot replace an observed
  // linear extension. Missing selections are preserved and stop the walk:
  // they can be local send/regenerate pins whose rows are not observable yet.
  const pinObservedPath = useRef<(() => void) | null>(null)
  const pinObservedRows = (
    rows: readonly StructuralMessageHeader[],
    rowProjection = projectionForRows(rows),
  ) => {
    if (!chatId || typeof window === 'undefined') return
    if (rows.length === 0) return
    const route = parseRoute(window.location.hash)
    if (route.kind !== 'chat' || route.chatId !== chatId) return
    const state = useChatStore.getState()
    const cursor = state.getCursor(chatId) ?? {}
    const pending = state.getPendingBranchNavigation(chatId)
    const currentPending =
      pending?.revision === state.getNavigationRevision(chatId) ? pending : undefined
    const path = activePathProjected(rowProjection, cursor)
    const patch: CursorMap = {}
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
      pending.abortController.abort()
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
        pending.abortController.abort()
        pendingUrlTargetRef.current = null
        writeUrlFromRows(messagesRef.current)
        return
      }
    }
    pending.abortController.abort()
    pendingUrlTargetRef.current = null
    pinObservedRows(rows, rowProjection)
    writeUrlFromRows(rows, rowProjection)
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
          resetPendingUrlRead(pending)
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
      captureUrlIntent.current?.()
    }
    if (seedCursorFromUrl.current?.() === false) return
    pinObservedPath.current?.()
    writeUrlFromCursor.current?.()
  }, [chatId, messages])

  // Cursor changes (swipe / send / delete / jump): URL follows.
  // DO NOT call seedCursorFromUrl here — that would re-seed from the
  // stale URL and undo the user's action.
  useEffect(() => {
    if (!chatId) return
    const initialState = useChatStore.getState()
    let previousCursor = initialState.getCursor(chatId)
    let previousRevision = initialState.getNavigationRevision(chatId)
    let previousPending = initialState.getPendingBranchNavigation(chatId)
    const unsub = useChatStore.subscribe((state) => {
      const cursor = state.getCursor(chatId)
      const revision = state.getNavigationRevision(chatId)
      const pending = state.getPendingBranchNavigation(chatId)
      if (
        cursor === previousCursor &&
        revision === previousRevision &&
        pending === previousPending
      ) {
        return
      }
      previousCursor = cursor
      previousRevision = revision
      previousPending = pending
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
    () => ({ headers, structuralHeaders, projection }),
    [headers, projection, structuralHeaders],
  )
}

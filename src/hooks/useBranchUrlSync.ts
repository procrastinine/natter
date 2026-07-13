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
// `replaceRoute` is silent per the HTML spec, so direction 2 never
// triggers direction 1.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { chatHref, parseRoute, replaceRoute } from '../app/router'
import { activePath, cursorKeyOf } from '../core/active-path'
import { seedCursorAtMessage } from '../core/branch-resolve'
import type { ChatId, Message } from '../core/types'
import { loadMessageHeaders } from '../store/chats'
import type { MessageHeaderRow } from '../store/message-storage'
import { chatRowDependencies, indexKeys } from '../store/reactive-dependencies'
import { useRepositoryQuery } from '../store/reactive-query'
import { useChatStore } from '../store/zustand/chatStore'

function cursorEqual(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left)
  if (leftEntries.length !== Object.keys(right).length) return false
  return leftEntries.every(([key, value]) => right[key] === value)
}

function pendingCursorLeaf(
  rows: readonly Message[],
  path: readonly Message[],
  cursor: Readonly<Record<string, string>>,
): string | undefined {
  const loadedIds = new Set(rows.map((row) => row.id))
  const parents: Array<string | null> = [null, ...path.map((row) => row.id)]
  for (const parentId of parents) {
    const selected = cursor[cursorKeyOf(parentId)]
    if (selected === undefined || loadedIds.has(selected)) continue
    const seen = new Set<string>()
    let leaf = selected
    while (!seen.has(leaf)) {
      seen.add(leaf)
      const child = cursor[cursorKeyOf(leaf)]
      if (child === undefined || loadedIds.has(child)) return leaf
      leaf = child
    }
    return leaf
  }
  return path.at(-1)?.id
}

export function useBranchUrlSync(chatId: ChatId | null): MessageHeaderRow[] {
  const headers = useRepositoryQuery(
    JSON.stringify(['message-headers', chatId]),
    () => (chatId ? loadMessageHeaders(chatId) : Promise.resolve([])),
    [],
    [...chatRowDependencies(chatId), ...indexKeys('messages', 'chatId', chatId)],
  )
  const messages = headers as unknown as Message[]
  const messagesRef = useRef<Message[]>(messages)
  messagesRef.current = messages

  // Track the URLs already consumed (seeded from) so repeated
  // triggers don't reseed once landed.
  const seededRef = useRef<Set<string>>(new Set())

  // ─── cursor → URL ────────────────────────────────────────────────
  const writeUrlFromCursor = useRef<(() => void) | null>(null)
  writeUrlFromCursor.current = () => {
    if (!chatId || typeof window === 'undefined') return
    const rows = messagesRef.current
    if (rows.length === 0) return
    const route = parseRoute(window.location.hash)
    if (route.kind !== 'chat' || route.chatId !== chatId) return
    const cursor = useChatStore.getState().getCursor(chatId) ?? {}
    const path = activePath(rows, cursor)
    const pendingLeaf = pendingCursorLeaf(rows, path, cursor)
    if (!pendingLeaf) return
    const desired = chatHref(chatId, pendingLeaf)
    if (window.location.hash === desired) return
    replaceRoute(desired)
    // Mark the URL just written as already-seeded so the hashchange
    // that might fire for some external reason (DevTools edits, etc.)
    // doesn't reseed and bounce back.
    seededRef.current.add(`${chatId}:${pendingLeaf}`)
  }

  // ─── URL → cursor ────────────────────────────────────────────────
  const seedCursorFromUrl = useRef<(() => void) | null>(null)
  seedCursorFromUrl.current = () => {
    if (!chatId || typeof window === 'undefined') return
    const rows = messagesRef.current
    if (rows.length === 0) return
    const route = parseRoute(window.location.hash)
    if (route.kind !== 'chat' || route.chatId !== chatId) return
    if (!route.pinnedMessageId) return
    const key = `${chatId}:${route.pinnedMessageId}`
    if (seededRef.current.has(key)) return
    const target = rows.find((m) => m.id === route.pinnedMessageId)
    if (!target || target.deleted) return
    seededRef.current.add(key)
    const cursor = useChatStore.getState().getCursor(chatId) ?? {}
    const draft = { ...cursor }
    seedCursorAtMessage(rows, route.pinnedMessageId, draft)
    if (!cursorEqual(cursor, draft)) {
      useChatStore.getState().setCursor(chatId, draft)
    }
  }

  // Materialize every path edge this tab has accepted from an authoritative
  // header snapshot. A later remote sibling then cannot replace an observed
  // linear extension. Missing selections are preserved and stop the walk:
  // they can be local send/regenerate pins whose rows are not observable yet.
  const pinObservedPath = useRef<(() => void) | null>(null)
  pinObservedPath.current = () => {
    if (!chatId || typeof window === 'undefined') return
    const rows = messagesRef.current
    if (rows.length === 0) return
    const route = parseRoute(window.location.hash)
    if (route.kind !== 'chat' || route.chatId !== chatId) return
    const cursor = useChatStore.getState().getCursor(chatId) ?? {}
    const path = activePath(rows, cursor)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const draft = { ...cursor }
    for (const child of path) {
      const key = cursorKeyOf(child.parentId)
      const selectedId = draft[key]
      if (selectedId === child.id) continue
      if (selectedId !== undefined) {
        const selected = byId.get(selectedId)
        if (!selected) break
        if (!selected.deleted && selected.parentId === child.parentId) break
      }
      draft[key] = child.id
    }
    if (!cursorEqual(cursor, draft)) {
      useChatStore.getState().setCursor(chatId, draft)
    }
  }

  // Header publications pin before paint so a remote sibling cannot flash and
  // then be corrected. Cursor-only changes do not trigger this path.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId/messages changes intentionally trigger the ref-backed URL sync.
  useLayoutEffect(() => {
    seedCursorFromUrl.current?.()
    pinObservedPath.current?.()
    writeUrlFromCursor.current?.()
  }, [chatId, messages])

  // Cursor changes (swipe / send / delete / jump): URL follows.
  // DO NOT call seedCursorFromUrl here — that would re-seed from the
  // stale URL and undo the user's action.
  useEffect(() => {
    if (!chatId) return
    const unsub = useChatStore.subscribe((state, prev) => {
      if (state.cursors[chatId] !== prev.cursors[chatId]) {
        writeUrlFromCursor.current?.()
      }
    })
    return unsub
  }, [chatId])

  // Real browser navigation (back/forward, manual hash edit): seed
  // from the new URL, then write back the canonical leaf. The internal
  // replaceState is silent, so this listener only fires for
  // user-driven URL changes.
  useEffect(() => {
    const onHashChange = () => {
      seedCursorFromUrl.current?.()
      pinObservedPath.current?.()
      writeUrlFromCursor.current?.()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  return headers
}

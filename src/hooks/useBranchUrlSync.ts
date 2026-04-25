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
//     edit). We seed the cursor once per arrival so the pinned
//     message is on the active path.
//   - cursor → URL runs on every cursor change. After seeding (or
//     after any user swipe), the URL mirrors the active-path leaf
//     via `replaceRoute` (silent, no hashchange fires).
//
// `replaceRoute` is silent per the HTML spec, so direction 2 never
// triggers direction 1.

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useRef } from 'react'
import { chatHref, parseRoute, replaceRoute } from '../app/router'
import { activePath } from '../core/active-path'
import { seedCursorAtMessage } from '../core/branch-resolve'
import type { ChatId, Message } from '../core/types'
import { loadChatMessages } from '../store/chats'
import { useChatStore } from '../store/zustand/chatStore'

export function useBranchUrlSync(chatId: ChatId | null): void {
  const messages = useLiveQuery(
    () => (chatId ? loadChatMessages(chatId) : Promise.resolve([])),
    [chatId],
    [],
  )
  const messagesRef = useRef<Message[]>(messages)
  messagesRef.current = messages

  // Track the URLs we've already consumed (seeded from) so repeated
  // triggers don't reseed once we've landed.
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
    const leaf = path.at(-1)
    if (!leaf) return
    const desired = chatHref(chatId, leaf.id)
    if (window.location.hash === desired) return
    replaceRoute(desired)
    // Mark the URL we just wrote as already-seeded so the hashchange
    // that might fire for some external reason (DevTools edits, etc.)
    // doesn't reseed and bounce us back.
    seededRef.current.add(`${chatId}:${leaf.id}`)
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
    seededRef.current.add(key)
    const target = rows.find((m) => m.id === route.pinnedMessageId)
    if (!target || target.deleted) return
    // "Already on path" guard — a new-tab URL might happen to name a
    // message that IS already on the default active path, in which
    // case we don't need to touch the cursor at all. This also makes
    // the seed idempotent when a cursor-change race fires mid-flight.
    const cursor = useChatStore.getState().getCursor(chatId) ?? {}
    const currentPath = activePath(rows, cursor)
    if (currentPath.some((m) => m.id === target.id)) return
    const draft = { ...cursor }
    seedCursorAtMessage(rows, route.pinnedMessageId, draft)
    useChatStore.getState().setCursor(chatId, draft)
  }

  // On mount / chatId change / messages load: seed then write.
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId/messages changes intentionally trigger the ref-backed URL sync.
  useEffect(() => {
    seedCursorFromUrl.current?.()
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
  // from the new URL, then write back the canonical leaf. Our own
  // replaceState is silent, so this listener only fires for
  // user-driven URL changes.
  useEffect(() => {
    const onHashChange = () => {
      seedCursorFromUrl.current?.()
      writeUrlFromCursor.current?.()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
}

// Hash router. The URL is the source of truth for "which chat / which sibling
// am I looking at" so reload restores the view and Cmd/middle-click on chat
// affordances opens a new tab at the same route.
//
// Routes:
//   #/             → home (launcher / sample prompts; no chat selected)
//   #/new          → blank-chat surface (NO chat row created until first send)
//   #/chat/<id>                   → open chat with no specific cursor pin
//   #/chat/<id>/message/<msgId>   → open chat with cursor pinned at <msgId>
//   #/storage                     → workspace/storage overview
//   #/storage/attachments         → attachment manager
//   #/storage/attachments/missing → missing attachment cleanup filter
//   #/storage/attachments/unreferenced → unreferenced attachment cleanup filter
//   #/storage/attachments/<id>    → attachment details permalink
//   #/storage/archive              → archived chats / trash
//   #/storage/backups             → backup / restore / raw dump surface
//
// The hash form is intentional: it works on static hosts without server config
// and matches plan/01-architecture.md. Cursor pins persist in per-tab Zustand
// per plan/02-data-model.md §2.1 / §2.1.2 — the URL only carries the *target*
// pin for opens; subsequent in-tab swipes update Zustand without touching URL.

import { type MouseEvent, useSyncExternalStore } from 'react'
import type { AttachmentId, ChatId, MessageId } from '../core/types'

export type StorageRoute =
  | { section: 'overview' }
  | { section: 'attachments'; filter?: 'missing' | 'unreferenced'; attachmentId?: AttachmentId }
  | { section: 'archive' }
  | { section: 'backups' }

export type Route =
  | { kind: 'home' }
  | { kind: 'new' }
  | { kind: 'chat'; chatId: ChatId; pinnedMessageId?: MessageId }
  | { kind: 'storage'; storage: StorageRoute }
  | { kind: 'unknown'; raw: string }

export function parseRoute(hash: string): Route {
  const stripped = hash.startsWith('#') ? hash.slice(1) : hash
  const pathWithQuery = stripped.startsWith('/') ? stripped.slice(1) : stripped
  const path = pathWithQuery.split('?', 1)[0] ?? ''
  if (path === '' || path === '/') return { kind: 'home' }
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 1 && parts[0] === 'new') return { kind: 'new' }
  if (parts[0] === 'storage') {
    if (parts.length === 1) return { kind: 'storage', storage: { section: 'overview' } }
    if (parts[1] === 'attachments') {
      if (parts.length === 2) return { kind: 'storage', storage: { section: 'attachments' } }
      if (parts[2] === 'missing') {
        return { kind: 'storage', storage: { section: 'attachments', filter: 'missing' } }
      }
      if (parts[2] === 'unreferenced') {
        return { kind: 'storage', storage: { section: 'attachments', filter: 'unreferenced' } }
      }
      if (parts[2] && parts.length === 3) {
        return {
          kind: 'storage',
          storage: { section: 'attachments', attachmentId: decodeURIComponent(parts[2]) },
        }
      }
    }
    if (parts[1] === 'backups' && parts.length === 2) {
      return { kind: 'storage', storage: { section: 'backups' } }
    }
    if (parts[1] === 'archive' && parts.length === 2) {
      return { kind: 'storage', storage: { section: 'archive' } }
    }
  }
  if (parts[0] === 'chat' && parts[1]) {
    const chatId = parts[1]
    if (parts[2] === 'message' && parts[3]) {
      return { kind: 'chat', chatId, pinnedMessageId: parts[3] }
    }
    if (parts.length === 2) return { kind: 'chat', chatId }
  }
  return { kind: 'unknown', raw: stripped }
}

export function routeToHref(route: Route): string {
  switch (route.kind) {
    case 'home':
      return '#/'
    case 'new':
      return '#/new'
    case 'chat':
      return route.pinnedMessageId
        ? `#/chat/${route.chatId}/message/${route.pinnedMessageId}`
        : `#/chat/${route.chatId}`
    case 'storage':
      return storageRouteToHref(route.storage)
    case 'unknown':
      return `#${route.raw.startsWith('/') ? route.raw : `/${route.raw}`}`
  }
}

export function chatHref(chatId: ChatId, pinnedMessageId?: MessageId): string {
  return routeToHref(
    pinnedMessageId ? { kind: 'chat', chatId, pinnedMessageId } : { kind: 'chat', chatId },
  )
}

export function homeHref(): string {
  return routeToHref({ kind: 'home' })
}

export function newChatHref(): string {
  return routeToHref({ kind: 'new' })
}

export function storageHref(storage: StorageRoute = { section: 'overview' }): string {
  return storageRouteToHref(storage)
}

export function attachmentHref(attachmentId: AttachmentId): string {
  return storageRouteToHref({ section: 'attachments', attachmentId })
}

function storageRouteToHref(route: StorageRoute): string {
  if (route.section === 'overview') return '#/storage'
  if (route.section === 'archive') return '#/storage/archive'
  if (route.section === 'backups') return '#/storage/backups'
  if (route.attachmentId) {
    return `#/storage/attachments/${encodeURIComponent(route.attachmentId)}`
  }
  if (route.filter === 'missing') return '#/storage/attachments/missing'
  if (route.filter === 'unreferenced') return '#/storage/attachments/unreferenced'
  return '#/storage/attachments'
}

export function navigate(href: string): void {
  if (typeof window === 'undefined') return
  if (window.location.hash === href) return
  window.location.hash = href
}

// Silent URL rewrite via `history.replaceState`. Does NOT fire a
// hashchange (so downstream hooks won't react) and does NOT push a new
// history entry. Used by the branch↔URL sync so swiping through
// variants updates the address bar without spamming back-history, and
// interior-message URLs (#/chat/id/message/<mid>) can redirect to the
// branch leaf (#/chat/id/message/<leafId>) without the user seeing a
// back button that undoes the auto-redirect.
export function replaceRoute(href: string): void {
  if (typeof window === 'undefined') return
  if (window.location.hash === href) return
  const url = new URL(window.location.href)
  url.hash = href
  window.history.replaceState(window.history.state, '', url.toString())
}

export function navigateToChat(chatId: ChatId, pinnedMessageId?: MessageId): void {
  navigate(chatHref(chatId, pinnedMessageId))
}

export function navigateHome(): void {
  navigate(homeHref())
}

export function navigateNew(): void {
  navigate(newChatHref())
}

const hashSubscribers = new Set<() => void>()
let hashListenerInstalled = false

function ensureHashListener(): void {
  if (typeof window === 'undefined' || hashListenerInstalled) return
  hashListenerInstalled = true
  window.addEventListener('hashchange', () => {
    for (const fn of hashSubscribers) fn()
  })
}

function subscribeHash(fn: () => void): () => void {
  ensureHashListener()
  hashSubscribers.add(fn)
  return () => hashSubscribers.delete(fn)
}

function getHashSnapshot(): string {
  if (typeof window === 'undefined') return ''
  return window.location.hash
}

function getServerSnapshot(): string {
  return ''
}

// React hook surface. Rerenders the consumer whenever the hash changes —
// any number of components can call this; one window listener feeds them all.
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, getHashSnapshot, getServerSnapshot)
  return parseRoute(hash)
}

// Intercept-on-left-click handler factory. Plain left-click → in-app SPA nav;
// modified clicks (middle, Cmd, Ctrl, Shift, Alt) and non-primary buttons
// fall through to the browser so the affordance opens in a new tab/window.
export function makeAnchorClickHandler(
  href: string,
): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }
    event.preventDefault()
    navigate(href)
  }
}

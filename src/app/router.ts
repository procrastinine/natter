// Hash router. The URL is the address/deep-link input and the per-tab cursor is
// the live branch authority. Cursor changes mirror their leaf into the address
// without publishing a new URL-arrival intent, so reload and new-tab opens
// restore the view without letting a passive mirror steer this tab.
//
// Routes:
//   #/             → home (launcher / sample prompts; no chat selected)
//   #/new          → blank-chat surface; materializes a row on send/import/settings
//   #/chat/<id>                   → open chat with no specific cursor pin
//   #/chat/<id>/message/<msgId>   → open chat with cursor pinned at <msgId>
//   #/storage                     → workspace/storage overview
//   #/storage/chats               → chat storage manager
//   #/storage/attachments         → attachment manager
//   #/storage/attachments/missing → missing attachment cleanup filter
//   #/storage/attachments/unreferenced → unreferenced attachment cleanup filter
//   #/storage/attachments/<id>    → attachment details permalink
//   #/storage/archive              → archived chats / trash
//   #/storage/backups             → legacy alias for the storage overview
//
// The hash form is intentional: it works on static hosts without server
// configuration. The URL carries the target pin for opens and silently mirrors
// subsequent in-tab cursor changes.

import { type MouseEvent, useSyncExternalStore } from 'react'
import type { AttachmentId, ChatId, MessageId } from '../core/types'
import { newId } from '../lib/ulid'
import { createConversationRouteOwnerController } from '../store/conversation-route-owner'
import type {
  ConversationNavigationPort,
  ConversationRouteArrival,
  ConversationRouteHandoff,
  ConversationRouteOwner,
  ConversationRouteOwnerController,
} from '../store/presentation-contracts'

const routeIntentBrand: unique symbol = Symbol('RouteIntent')
const routeIntentState: unique symbol = Symbol('RouteIntentState')

export interface RouteIntent {
  readonly startedAtHash: string
  readonly [routeIntentBrand]: true
  readonly [routeIntentState]: {
    expectedHash: string
    readonly controller: AbortController
    readonly routeOwnerController: ConversationRouteOwnerController
  }
}

let currentRouteIntent: RouteIntent | null = null

function invalidateRouteIntent(): void {
  currentRouteIntent?.[routeIntentState].controller.abort()
  currentRouteIntent?.[routeIntentState].routeOwnerController.cancel()
  currentRouteIntent = null
}

export function beginRouteIntent(): RouteIntent {
  return claimRouteIntent()
}

function claimRouteIntent(): RouteIntent {
  ensureHashListener()
  invalidateRouteIntent()
  const startedAtHash = typeof window === 'undefined' ? '' : window.location.hash
  const intent = Object.freeze({
    startedAtHash,
    [routeIntentBrand]: true as const,
    [routeIntentState]: {
      expectedHash: startedAtHash,
      controller: new AbortController(),
      routeOwnerController: createConversationRouteOwnerController(),
    },
  })
  currentRouteIntent = intent
  return intent
}

export function isRouteIntentCurrent(intent: RouteIntent): boolean {
  return (
    currentRouteIntent === intent &&
    !intent[routeIntentState].controller.signal.aborted &&
    intent[routeIntentState].expectedHash ===
      (typeof window === 'undefined' ? intent.startedAtHash : window.location.hash)
  )
}

export function routeIntentOwner(intent: RouteIntent): ConversationRouteOwner {
  return intent[routeIntentState].routeOwnerController.owner
}

export function navigateForIntent(intent: RouteIntent, href: string): boolean {
  if (!consumeRouteIntent(intent)) return false
  commitHashNavigation(href)
  return true
}

// End an abandoned delayed route action without disturbing a newer action.
// Cleanup belongs in every async owner's finally block; successful navigation
// consumes the same object first, making that cleanup a harmless no-op.
export function cancelRouteIntent(intent: RouteIntent): boolean {
  const stillOwnsNavigation = currentRouteIntent === intent
  if (!stillOwnsNavigation) return false
  currentRouteIntent = null
  intent[routeIntentState].controller.abort()
  intent[routeIntentState].routeOwnerController.cancel()
  return true
}

function consumeRouteIntent(intent: RouteIntent): boolean {
  if (!isRouteIntentCurrent(intent)) return false
  currentRouteIntent = null
  intent[routeIntentState].controller.abort()
  intent[routeIntentState].routeOwnerController.cancel()
  return true
}

// Atomically hand a successful delayed chat-route action over to the branch
// navigator. A caller must not begin a branch intent after an awaited route
// attempt on its own: if that route was superseded, the late branch claim
// would steal authority back from the user's newer action.
export function navigateToChatForIntent(
  intent: RouteIntent,
  chatId: ChatId,
  handoff?: ConversationRouteHandoff,
): boolean {
  if (!isRouteIntentCurrent(intent)) {
    handoff?.cancel()
    return false
  }
  const routeOwner = intent[routeIntentState].routeOwnerController.owner
  if (handoff && (handoff.chatId !== chatId || handoff.id !== routeOwner.id)) {
    handoff.cancel()
    throw new Error('ConversationRouteHandoffChatMismatch')
  }
  currentRouteIntent = null
  intent[routeIntentState].controller.abort()
  try {
    commitHashNavigation(chatHref(chatId), false)
    publishRouteChange(handoff)
    return true
  } catch (error) {
    intent[routeIntentState].routeOwnerController.cancel(error)
    handoff?.cancel()
    throw error
  }
}

export type StorageRoute =
  | { section: 'overview' }
  | { section: 'chats' }
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
    if (parts[1] === 'chats' && parts.length === 2) {
      return { kind: 'storage', storage: { section: 'chats' } }
    }
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

export function activeRouteChatId(): ChatId | null {
  const route = committedRouteSnapshot
  return route.kind === 'chat' ? route.chatId : null
}

export function isChatRouteActive(chatId: ChatId): boolean {
  return activeRouteChatId() === chatId
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
  if (route.section === 'chats') return '#/storage/chats'
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
  invalidateRouteIntent()
  commitHashNavigation(href)
}

function commitHashNavigation(href: string, publish = true): boolean {
  if (window.location.hash === href) {
    if (publish) publishRouteChange()
    return false
  }
  const url = new URL(window.location.href)
  url.hash = href
  // pushState gives the hash router normal back/forward history without an
  // asynchronous hashchange echo. That removes the need for a bounded
  // pending-event queue whose eviction could misclassify an old internal
  // event as a new user navigation.
  window.history.pushState(window.history.state, '', url.toString())
  if (publish) publishRouteChange()
  return true
}

// URL rewrite via `history.replaceState`. Does NOT fire a hashchange,
// publish a new URL-arrival intent, or push a new history entry. It does
// notify route-snapshot readers so rendered route state cannot lag behind
// the address bar. Used by the branch↔URL sync so swiping through
// variants updates the address bar without spamming back-history, and
// interior-message URLs (#/chat/id/message/<mid>) can redirect to the
// branch leaf (#/chat/id/message/<leafId>) without the user seeing a
// back button that undoes the auto-redirect.
export function replaceRoute(href: string): void {
  if (typeof window === 'undefined') return
  const before = window.location.hash
  if (currentRouteIntent && currentRouteIntent[routeIntentState].expectedHash === before) {
    currentRouteIntent[routeIntentState].expectedHash = href
  }
  if (window.location.hash === href) {
    const candidate = currentAddressRoute()
    updateRouteArrivalSnapshot(false, candidate)
    if (routeToHref(committedRouteSnapshot) !== routeToHref(candidate)) {
      committedRouteSnapshot = candidate
      publishRouteSnapshotChange()
    }
    return
  }
  const url = new URL(window.location.href)
  url.hash = href
  window.history.replaceState(window.history.state, '', url.toString())
  const candidate = currentAddressRoute()
  updateRouteArrivalSnapshot(false, candidate)
  committedRouteSnapshot = candidate
  publishRouteSnapshotChange()
}

export function navigateHome(): void {
  navigate(homeHref())
}

export function navigateNew(): void {
  navigate(newChatHref())
}

const routeSnapshotSubscribers = new Set<() => void>()
const routeArrivalSubscribers = new Set<() => void>()
const routeArrivalPrefix = newId()
let routeArrivalRevision = 0n
const HOME_ROUTE = Object.freeze({ kind: 'home' as const })
let committedRouteSnapshot = currentAddressRoute()
let routeArrivalSnapshot = conversationRouteArrival(committedRouteSnapshot)
let hashListenerInstalled = false

function ensureHashListener(): void {
  if (typeof window === 'undefined') return
  if (!hashListenerInstalled) {
    hashListenerInstalled = true
    window.addEventListener('hashchange', () => {
      invalidateRouteIntent()
      publishRouteChange()
    })
    window.addEventListener('pageshow', reconcileRouteSnapshotWithAddress)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reconcileRouteSnapshotWithAddress()
    })
  }
  reconcileRouteSnapshotWithAddress()
}

function reconcileRouteSnapshotWithAddress(): void {
  if (routeToHref(committedRouteSnapshot) !== routeToHref(currentAddressRoute())) {
    invalidateRouteIntent()
    publishRouteChange()
  }
}

function publishRouteChange(handoff?: ConversationRouteHandoff): void {
  const candidate = currentAddressRoute()
  updateRouteArrivalSnapshot(true, candidate, handoff)
  for (const fn of [...routeArrivalSubscribers]) fn()
  committedRouteSnapshot = candidate
  publishRouteSnapshotChange()
}

function currentAddressRoute(): Route {
  return typeof window === 'undefined' ? HOME_ROUTE : parseRoute(window.location.hash)
}

function conversationRouteArrival(
  route: Route,
  handoff?: ConversationRouteHandoff,
): ConversationRouteArrival {
  return Object.freeze({
    id: `${routeArrivalPrefix}:${routeArrivalRevision.toString()}`,
    route:
      route.kind === 'chat'
        ? Object.freeze({
            chatId: route.chatId,
            ...(route.pinnedMessageId ? { targetMessageId: route.pinnedMessageId } : {}),
            ...(handoff?.chatId === route.chatId ? { handoff } : {}),
          })
        : null,
  })
}

function updateRouteArrivalSnapshot(
  increment: boolean,
  route: Route,
  handoff?: ConversationRouteHandoff,
): void {
  if (increment) routeArrivalRevision += 1n
  const next = conversationRouteArrival(route, handoff)
  const previousHandoff = routeArrivalSnapshot.route?.handoff
  if (previousHandoff && previousHandoff !== next.route?.handoff) previousHandoff.cancel()
  routeArrivalSnapshot = next
}

function publishRouteSnapshotChange(): void {
  for (const fn of [...routeSnapshotSubscribers]) fn()
}

// The router owns the one native hashchange listener so invalidation and
// internal/external classification always happen before downstream URL work.
export function subscribeRouteChange(fn: () => void): () => void {
  ensureHashListener()
  routeSnapshotSubscribers.add(fn)
  return () => routeSnapshotSubscribers.delete(fn)
}

// URL-arrival subscribers own URL → view intent. Passive branch projection
// through replaceRoute updates route snapshots but must never reseed a cursor.
export function subscribeRouteArrival(fn: () => void): () => void {
  ensureHashListener()
  routeArrivalSubscribers.add(fn)
  return () => routeArrivalSubscribers.delete(fn)
}

export const browserConversationNavigationPort: ConversationNavigationPort = Object.freeze({
  getArrival: () => routeArrivalSnapshot,
  subscribeArrival: subscribeRouteArrival,
  replaceConversationUrl: (chatId: ChatId, targetMessageId?: MessageId) => {
    if (typeof window === 'undefined') return
    const route = parseRoute(window.location.hash)
    if (route.kind !== 'chat' || route.chatId !== chatId) return
    const publishedRoute = routeArrivalSnapshot.route
    if (
      !publishedRoute ||
      publishedRoute.chatId !== route.chatId ||
      publishedRoute.targetMessageId !== route.pinnedMessageId
    ) {
      return
    }
    replaceRoute(chatHref(chatId, targetMessageId))
  },
})

function getCommittedRouteSnapshot(): Route {
  return committedRouteSnapshot
}

function getServerRouteSnapshot(): Route {
  return HOME_ROUTE
}

// React hook surface. Rerenders the consumer whenever the hash changes —
// any number of components can call this; one window listener feeds them all.
export function useRoute(): Route {
  return useSyncExternalStore(
    subscribeRouteChange,
    getCommittedRouteSnapshot,
    getServerRouteSnapshot,
  )
}

// Intercept-on-left-click handler factory. Plain left-click → in-app SPA nav;
// modified clicks (middle, Cmd, Ctrl, Shift, Alt) and non-primary buttons
// fall through to the browser so the affordance opens in a new tab/window.
export function makeAnchorClickHandler(
  href: string,
  onPrimaryNavigate: (href: string) => void = navigate,
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
    onPrimaryNavigate(href)
  }
}

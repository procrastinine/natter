import { beforeEach, describe, expect, it } from 'vitest'
import {
  attachmentHref,
  beginRouteIntent,
  beginWorkspaceReplacementRouteIntent,
  cancelRouteIntent,
  chatHref,
  homeHref,
  isRouteIntentCurrent,
  navigate,
  navigateForIntent,
  navigateToChatForIntent,
  newChatHref,
  parseRoute,
  refreshRouteForWorkspaceReplacement,
  replaceRoute,
  routeToHref,
  storageHref,
  subscribeRouteArrival,
  subscribeRouteChange,
} from '../../src/app/router'
import { useChatStore } from '../../src/store/zustand/chatStore'

beforeEach(() => {
  useChatStore.getState().reset()
  window.history.replaceState(null, '', '#/')
})

describe('parseRoute', () => {
  it('treats empty hash as home', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' })
    expect(parseRoute('#')).toEqual({ kind: 'home' })
    expect(parseRoute('#/')).toEqual({ kind: 'home' })
  })

  it('parses #/new', () => {
    expect(parseRoute('#/new')).toEqual({ kind: 'new' })
    expect(parseRoute('#new')).toEqual({ kind: 'new' })
  })

  it('parses chat with no pin', () => {
    expect(parseRoute('#/chat/abc123')).toEqual({
      kind: 'chat',
      chatId: 'abc123',
    })
  })

  it('parses chat with a message-id pin', () => {
    expect(parseRoute('#/chat/abc123/message/m9')).toEqual({
      kind: 'chat',
      chatId: 'abc123',
      pinnedMessageId: 'm9',
    })
  })

  it('marks unrecognized hashes as unknown (no crash)', () => {
    expect(parseRoute('#/banana')).toMatchObject({ kind: 'unknown' })
    expect(parseRoute('#/chat')).toMatchObject({ kind: 'unknown' })
  })

  it('parses storage management routes', () => {
    expect(parseRoute('#/storage')).toEqual({
      kind: 'storage',
      storage: { section: 'overview' },
    })
    expect(parseRoute('#/storage/chats')).toEqual({
      kind: 'storage',
      storage: { section: 'chats' },
    })
    expect(parseRoute('#/storage/attachments')).toEqual({
      kind: 'storage',
      storage: { section: 'attachments' },
    })
    expect(parseRoute('#/storage/attachments/missing')).toEqual({
      kind: 'storage',
      storage: { section: 'attachments', filter: 'missing' },
    })
    expect(parseRoute('#/storage/attachments/unreferenced')).toEqual({
      kind: 'storage',
      storage: { section: 'attachments', filter: 'unreferenced' },
    })
    expect(parseRoute('#/storage/attachments/att%2F1')).toEqual({
      kind: 'storage',
      storage: { section: 'attachments', attachmentId: 'att/1' },
    })
    expect(parseRoute('#/storage/backups')).toEqual({
      kind: 'storage',
      storage: { section: 'backups' },
    })
    expect(parseRoute('#/storage/archive')).toEqual({
      kind: 'storage',
      storage: { section: 'archive' },
    })
  })
})

describe('routeToHref / convenience helpers', () => {
  it('round-trips home and new', () => {
    expect(routeToHref({ kind: 'home' })).toBe('#/')
    expect(routeToHref({ kind: 'new' })).toBe('#/new')
    expect(homeHref()).toBe('#/')
    expect(newChatHref()).toBe('#/new')
  })

  it('round-trips chat hrefs with and without pin', () => {
    expect(chatHref('xyz')).toBe('#/chat/xyz')
    expect(chatHref('xyz', 'm1')).toBe('#/chat/xyz/message/m1')
    expect(routeToHref({ kind: 'chat', chatId: 'xyz' })).toBe('#/chat/xyz')
    expect(routeToHref({ kind: 'chat', chatId: 'xyz', pinnedMessageId: 'm1' })).toBe(
      '#/chat/xyz/message/m1',
    )
  })

  it('round-trips storage hrefs', () => {
    expect(storageHref()).toBe('#/storage')
    expect(storageHref({ section: 'chats' })).toBe('#/storage/chats')
    expect(storageHref({ section: 'attachments' })).toBe('#/storage/attachments')
    expect(storageHref({ section: 'attachments', filter: 'missing' })).toBe(
      '#/storage/attachments/missing',
    )
    expect(storageHref({ section: 'attachments', filter: 'unreferenced' })).toBe(
      '#/storage/attachments/unreferenced',
    )
    expect(storageHref({ section: 'backups' })).toBe('#/storage/backups')
    expect(storageHref({ section: 'archive' })).toBe('#/storage/archive')
    expect(attachmentHref('att/1')).toBe('#/storage/attachments/att%2F1')
  })

  it('round-trips parse → render → parse', () => {
    const cases = [
      '#/',
      '#/new',
      '#/chat/A',
      '#/chat/A/message/B',
      '#/storage',
      '#/storage/chats',
      '#/storage/attachments',
      '#/storage/attachments/missing',
      '#/storage/attachments/unreferenced',
      '#/storage/attachments/A',
      '#/storage/backups',
      '#/storage/archive',
    ]
    for (const raw of cases) {
      const route = parseRoute(raw)
      expect(routeToHref(route)).toBe(raw)
    }
  })
})

describe('tab route intents', () => {
  it('accepts only the latest opaque intent object', () => {
    const older = beginRouteIntent()
    const current = beginRouteIntent()
    const copied = { ...current } as typeof current

    expect(isRouteIntentCurrent(older)).toBe(false)
    expect(isRouteIntentCurrent(copied)).toBe(false)
    expect(navigateForIntent(older, '#/new')).toBe(false)
    expect(navigateForIntent(copied, '#/new')).toBe(false)
    expect(window.location.hash).toBe('#/')
    expect(navigateForIntent(current, '#/new')).toBe(true)
    expect(window.location.hash).toBe('#/new')
  })

  it('consumes a successful intent even when asked to navigate twice', () => {
    const intent = beginRouteIntent()

    expect(navigateForIntent(intent, '#/storage')).toBe(true)
    expect(navigateForIntent(intent, '#/new')).toBe(false)
    expect(window.location.hash).toBe('#/storage')
  })

  it('cancels only the exact abandoned intent object', () => {
    const abandoned = beginRouteIntent()
    const current = beginRouteIntent()
    const copied = { ...current } as typeof current

    expect(cancelRouteIntent(abandoned)).toBe(false)
    expect(cancelRouteIntent(copied)).toBe(false)
    expect(isRouteIntentCurrent(current)).toBe(true)
    expect(cancelRouteIntent(current)).toBe(true)
    expect(isRouteIntentCurrent(current)).toBe(false)
    expect(navigateForIntent(current, '#/new')).toBe(false)
  })

  it('makes finally cleanup harmless after successful navigation', () => {
    const intent = beginRouteIntent()

    expect(navigateForIntent(intent, '#/storage')).toBe(true)
    expect(cancelRouteIntent(intent)).toBe(false)
    expect(window.location.hash).toBe('#/storage')
  })

  it('replays a replacement skipped by a newer local owner when that owner is abandoned', () => {
    let arrivals = 0
    const unsubscribe = subscribeRouteArrival(() => {
      arrivals += 1
    })
    beginWorkspaceReplacementRouteIntent()
    const newerReplacement = beginWorkspaceReplacementRouteIntent()

    // This may be the older replacement's synchronous local event. The newer
    // operation owns route authority, so its eventual outcome resolves it.
    refreshRouteForWorkspaceReplacement('local')
    expect(arrivals).toBe(0)

    expect(cancelRouteIntent(newerReplacement)).toBe(true)
    expect(arrivals).toBe(1)
    unsubscribe()
  })

  it('does not let abandoned replacement cleanup steal a newer branch action', () => {
    let arrivals = 0
    const unsubscribe = subscribeRouteArrival(() => {
      arrivals += 1
    })
    const replacement = beginWorkspaceReplacementRouteIntent()
    refreshRouteForWorkspaceReplacement('local')
    const branchIntent = useChatStore
      .getState()
      .navigateToCursor('visible-chat', { __root__: 'visible-message' })

    expect(cancelRouteIntent(replacement)).toBe(true)
    expect(arrivals).toBe(0)
    expect(useChatStore.getState().isNavigationIntentCurrent(branchIntent)).toBe(true)
    unsubscribe()
  })

  it('lets synchronous navigation supersede a pending intent, including a same-href no-op', () => {
    const intent = beginRouteIntent()

    navigate('#/')

    expect(isRouteIntentCurrent(intent)).toBe(false)
    expect(navigateForIntent(intent, '#/new')).toBe(false)
    expect(window.location.hash).toBe('#/')
  })

  it('keeps a newer route intent through a passive silent branch projection', () => {
    const intent = beginRouteIntent()

    replaceRoute('#/storage')

    expect(isRouteIntentCurrent(intent)).toBe(true)
    expect(navigateForIntent(intent, '#/new')).toBe(true)
    expect(window.location.hash).toBe('#/new')
  })

  it('does not cancel an intent for a no-op branch URL projection', () => {
    const intent = beginRouteIntent()

    replaceRoute('#/')

    expect(isRouteIntentCurrent(intent)).toBe(true)
  })

  it('publishes passive replacements to route readers without creating a URL arrival', () => {
    let snapshots = 0
    let arrivals = 0
    const unsubscribeSnapshot = subscribeRouteChange(() => {
      snapshots += 1
    })
    const unsubscribeArrival = subscribeRouteArrival(() => {
      arrivals += 1
    })

    replaceRoute('#/chat/passive/message/leaf')
    unsubscribeSnapshot()
    unsubscribeArrival()

    expect(snapshots).toBe(1)
    expect(arrivals).toBe(0)
  })

  it('preserves only the local replacement owner and invalidates remote or unrelated work', () => {
    let arrivals = 0
    const unsubscribe = subscribeRouteArrival(() => {
      arrivals += 1
    })

    const unrelatedIntent = beginRouteIntent()
    refreshRouteForWorkspaceReplacement('local')

    expect(arrivals).toBe(1)
    expect(isRouteIntentCurrent(unrelatedIntent)).toBe(false)

    const localOwner = beginWorkspaceReplacementRouteIntent()
    refreshRouteForWorkspaceReplacement('local')

    expect(arrivals).toBe(1)
    expect(isRouteIntentCurrent(localOwner)).toBe(true)

    refreshRouteForWorkspaceReplacement('remote')
    unsubscribe()

    expect(arrivals).toBe(2)
    expect(isRouteIntentCurrent(localOwner)).toBe(false)
  })

  it('rejects a raw hash change before its hashchange event is delivered', () => {
    const intent = beginRouteIntent()
    window.history.replaceState(null, '', '#/chat/other')

    expect(isRouteIntentCurrent(intent)).toBe(false)
    expect(navigateForIntent(intent, '#/new')).toBe(false)
    expect(window.location.hash).toBe('#/chat/other')
  })

  it('invalidates pending work when the browser delivers back/forward navigation', () => {
    const intent = beginRouteIntent()

    window.dispatchEvent(new HashChangeEvent('hashchange'))

    expect(isRouteIntentCurrent(intent)).toBe(false)
    expect(navigateForIntent(intent, '#/new')).toBe(false)
  })

  it('observes real back traversal across pushState hash entries', async () => {
    const observed: string[] = []
    const unsubscribe = subscribeRouteChange(() => observed.push(window.location.hash))
    navigate('#/chat/history-a')
    navigate('#/chat/history-b')
    const branchIntent = useChatStore.getState().beginNavigationIntent('history-b')
    const traversed = new Promise<void>((resolve) => {
      window.addEventListener('hashchange', () => resolve(), { once: true })
    })

    window.history.back()
    await traversed
    unsubscribe()

    expect(window.location.hash).toBe('#/chat/history-a')
    expect(observed.at(-1)).toBe('#/chat/history-a')
    expect(useChatStore.getState().isNavigationIntentCurrent(branchIntent)).toBe(false)
  })

  it('arbitrates route and branch actions on one tab-wide latest-intent clock', () => {
    const branchIntent = useChatStore.getState().beginNavigationIntent('chat-a')
    const routeIntent = beginRouteIntent()

    expect(useChatStore.getState().isNavigationIntentCurrent(branchIntent)).toBe(false)
    expect(isRouteIntentCurrent(routeIntent)).toBe(true)

    useChatStore.getState().navigateToCursor('chat-a', { __root__: 'message-a' })

    expect(isRouteIntentCurrent(routeIntent)).toBe(false)
    expect(navigateForIntent(routeIntent, '#/storage')).toBe(false)
  })

  it('preserves an import redirect across workspace branch reset without defeating a newer route', () => {
    const completedImport = beginRouteIntent()

    useChatStore.getState().resetForWorkspaceReplacement()

    expect(isRouteIntentCurrent(completedImport)).toBe(true)
    expect(navigateForIntent(completedImport, '#/storage')).toBe(true)

    const supersededImport = beginRouteIntent()
    useChatStore.getState().resetForWorkspaceReplacement()
    navigate('#/new')

    expect(navigateForIntent(supersededImport, '#/storage')).toBe(false)
    expect(window.location.hash).toBe('#/new')
  })

  it('hands a successful chat route directly to one current branch intent', () => {
    const routeIntent = beginRouteIntent()

    const branchIntent = navigateToChatForIntent(routeIntent, 'created-chat')

    expect(branchIntent).not.toBeNull()
    expect(window.location.hash).toBe('#/chat/created-chat')
    expect(branchIntent && useChatStore.getState().isNavigationIntentCurrent(branchIntent)).toBe(
      true,
    )
    expect(isRouteIntentCurrent(routeIntent)).toBe(false)
  })

  it('does not reclaim branch authority when a delayed chat route was superseded', () => {
    const staleRouteIntent = beginRouteIntent()
    const newerBranchIntent = useChatStore
      .getState()
      .navigateToCursor('visible-chat', { __root__: 'visible-message' })

    expect(navigateToChatForIntent(staleRouteIntent, 'hidden-created-chat')).toBeNull()
    expect(window.location.hash).toBe('#/')
    expect(useChatStore.getState().isNavigationIntentCurrent(newerBranchIntent)).toBe(true)
    expect(useChatStore.getState().getCursor('hidden-created-chat')).toBeUndefined()
  })

  it('does not create delayed hash events that can cancel newer branch intent', () => {
    let hashChanges = 0
    const countHashChange = () => {
      hashChanges += 1
    }
    window.addEventListener('hashchange', countHashChange)
    for (let index = 0; index < 64; index += 1) {
      navigate(`#/chat/internal-${index}`)
    }
    const branchIntent = useChatStore.getState().beginNavigationIntent('chat-a')
    window.removeEventListener('hashchange', countHashChange)

    expect(hashChanges).toBe(0)
    expect(useChatStore.getState().isNavigationIntentCurrent(branchIntent)).toBe(true)
  })
})

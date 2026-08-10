import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeRouteChatId,
  attachmentHref,
  beginRouteIntent,
  browserConversationNavigationPort,
  cancelRouteIntent,
  chatHref,
  homeHref,
  isChatRouteActive,
  isRouteIntentCurrent,
  makeAnchorClickHandler,
  navigate,
  navigateForIntent,
  navigateToChatForIntent,
  newChatHref,
  parseRoute,
  replaceRoute,
  routeForegroundPresentationSettled,
  routeIntentOwner,
  routeToHref,
  settleRouteForegroundDemandForPresentation,
  startRouteForegroundMetadata,
  storageHref,
  subscribeRouteArrival,
  subscribeRouteChange,
} from '../../src/app/router'
import type { ConversationRouteHandoff } from '../../src/store/conversation-controller'
import { awaitWorkspaceForegroundDemandIdle } from '../../src/store/workspace-runtime'

function handoffFor(
  intent: ReturnType<typeof beginRouteIntent>,
  chatId: string,
  cancel = vi.fn(),
): ConversationRouteHandoff {
  return Object.freeze({
    id: routeIntentOwner(intent).id,
    workspaceId: 'workspace-a',
    replacementEpoch: 0,
    chatId,
    cancel,
  })
}

beforeEach(() => {
  navigate('#/')
})

describe('route parsing and rendering', () => {
  it('parses home, new-chat, chat, and pinned-message routes', () => {
    expect(parseRoute('')).toEqual({ kind: 'home' })
    expect(parseRoute('#')).toEqual({ kind: 'home' })
    expect(parseRoute('#/')).toEqual({ kind: 'home' })
    expect(parseRoute('#/new')).toEqual({ kind: 'new' })
    expect(parseRoute('#new')).toEqual({ kind: 'new' })
    expect(parseRoute('#/chat/abc123')).toEqual({ kind: 'chat', chatId: 'abc123' })
    expect(parseRoute('#/chat/abc123/message/m9')).toEqual({
      kind: 'chat',
      chatId: 'abc123',
      pinnedMessageId: 'm9',
    })
  })

  it('treats unrecognized or incomplete routes as unknown', () => {
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

  it('renders every supported route canonically', () => {
    expect(routeToHref({ kind: 'home' })).toBe('#/')
    expect(routeToHref({ kind: 'new' })).toBe('#/new')
    expect(homeHref()).toBe('#/')
    expect(newChatHref()).toBe('#/new')
    expect(chatHref('xyz')).toBe('#/chat/xyz')
    expect(chatHref('xyz', 'm1')).toBe('#/chat/xyz/message/m1')
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

  it('round-trips every canonical route', () => {
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
    for (const raw of cases) expect(routeToHref(parseRoute(raw))).toBe(raw)
  })

  it('derives active-chat helpers from the current route only', () => {
    expect(activeRouteChatId()).toBeNull()
    navigate('#/chat/active')
    expect(activeRouteChatId()).toBe('active')
    expect(isChatRouteActive('active')).toBe(true)
    expect(isChatRouteActive('other')).toBe(false)
    navigate('#/storage')
    expect(activeRouteChatId()).toBeNull()
  })
})

describe('opaque tab route intents', () => {
  it('accepts only the latest exact intent object', () => {
    const older = beginRouteIntent()
    const current = beginRouteIntent()
    const copied = { ...current } as typeof current

    expect(isRouteIntentCurrent(older)).toBe(false)
    expect(isRouteIntentCurrent(copied)).toBe(false)
    expect(navigateForIntent(older, '#/new')).toBe(false)
    expect(navigateForIntent(copied, '#/new')).toBe(false)
    expect(navigateForIntent(current, '#/new')).toBe(true)
    expect(window.location.hash).toBe('#/new')
  })

  it('consumes a successful intent and makes finally cleanup harmless', () => {
    const intent = beginRouteIntent()

    expect(navigateForIntent(intent, '#/storage')).toBe(true)
    expect(navigateForIntent(intent, '#/new')).toBe(false)
    expect(cancelRouteIntent(intent)).toBe(false)
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
  })

  it('lets synchronous route navigation supersede delayed work, including a no-op', () => {
    const intent = beginRouteIntent()
    navigate('#/')

    expect(isRouteIntentCurrent(intent)).toBe(false)
    expect(navigateForIntent(intent, '#/new')).toBe(false)
  })

  it('keeps route ownership through passive branch URL projection', () => {
    const intent = beginRouteIntent()
    replaceRoute('#/chat/projected/message/leaf')

    expect(isRouteIntentCurrent(intent)).toBe(true)
    expect(navigateForIntent(intent, '#/new')).toBe(true)
    expect(window.location.hash).toBe('#/new')
  })

  it('updates an intent expected hash when passive projection rewrites its route', () => {
    navigate('#/chat/chat-a')
    const intent = beginRouteIntent()
    replaceRoute('#/chat/chat-a/message/leaf')

    expect(isRouteIntentCurrent(intent)).toBe(true)
  })

  it('rejects a raw URL rewrite before its hashchange event arrives', () => {
    const intent = beginRouteIntent()
    window.history.replaceState(null, '', '#/chat/other')

    expect(isRouteIntentCurrent(intent)).toBe(false)
    expect(navigateForIntent(intent, '#/new')).toBe(false)
  })

  it('invalidates delayed work when the browser publishes back/forward navigation', () => {
    const intent = beginRouteIntent()
    window.dispatchEvent(new HashChangeEvent('hashchange'))

    expect(isRouteIntentCurrent(intent)).toBe(false)
    expect(navigateForIntent(intent, '#/new')).toBe(false)
  })

  it('hands a successful delayed chat route directly to the route-arrival owner', () => {
    let arrivals = 0
    const unsubscribe = subscribeRouteArrival(() => {
      arrivals += 1
    })
    const intent = beginRouteIntent()

    expect(navigateToChatForIntent(intent, 'created-chat')).toBe(true)
    unsubscribe()

    expect(window.location.hash).toBe('#/chat/created-chat')
    expect(arrivals).toBe(1)
    expect(isRouteIntentCurrent(intent)).toBe(false)
  })

  it('does not reclaim route authority after a delayed chat route is superseded', () => {
    const stale = beginRouteIntent()
    const cancel = vi.fn()
    const handoff = handoffFor(stale, 'hidden-created-chat', cancel)
    const current = beginRouteIntent()

    expect(navigateToChatForIntent(stale, 'hidden-created-chat', handoff)).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('#/')
    expect(isRouteIntentCurrent(current)).toBe(true)
  })

  it('cancels the handoff displaced from the route-arrival owner slot', () => {
    const intent = beginRouteIntent()
    const cancel = vi.fn()
    const handoff = handoffFor(intent, 'created-chat', cancel)

    expect(navigateToChatForIntent(intent, 'created-chat', handoff)).toBe(true)
    expect(cancel).not.toHaveBeenCalled()
    navigate('#/chat/newer-chat')

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels route delivery when an arrival subscriber rejects publication', () => {
    const intent = beginRouteIntent()
    const owner = routeIntentOwner(intent)
    const cancel = vi.fn()
    const handoff = handoffFor(intent, 'created-chat', cancel)
    const unsubscribe = subscribeRouteArrival(() => {
      throw new Error('arrival publication failed')
    })

    expect(() => navigateToChatForIntent(intent, 'created-chat', handoff)).toThrow(
      'arrival publication failed',
    )
    unsubscribe()
    expect(owner.signal.aborted).toBe(true)
    expect(cancel).toHaveBeenCalledTimes(1)
  })
})

describe('route snapshots and conversation navigation port', () => {
  it('reconciles a fragment navigation completed before a route subscriber attaches', () => {
    navigate('#/chat/opener')
    const beforeId = browserConversationNavigationPort.getArrival().id
    window.history.replaceState(null, '', '#/new')

    const unsubscribe = subscribeRouteArrival(() => undefined)
    unsubscribe()

    expect(activeRouteChatId()).toBeNull()
    expect(browserConversationNavigationPort.getArrival().id).not.toBe(beforeId)
    expect(browserConversationNavigationPort.getArrival().route).toBeNull()
  })

  it('reconciles a missed fragment navigation when the page resumes', () => {
    const unsubscribe = subscribeRouteArrival(() => undefined)
    navigate('#/chat/background')
    window.history.replaceState(null, '', '#/new')

    window.dispatchEvent(new Event('pageshow'))
    unsubscribe()

    expect(activeRouteChatId()).toBeNull()
    expect(browserConversationNavigationPort.getArrival().route).toBeNull()
  })

  it('keeps an unadmitted browser address out of the committed render frame', () => {
    navigate('#/chat/admitted')
    window.history.replaceState(null, '', '#/chat/not-yet-admitted')

    expect(activeRouteChatId()).toBe('admitted')

    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(activeRouteChatId()).toBe('not-yet-admitted')
  })

  it('admits the route arrival before exposing its address to render subscribers', () => {
    const publications: string[] = []
    const unsubscribeSnapshot = subscribeRouteChange(() => {
      publications.push('snapshot')
    })
    const unsubscribeArrival = subscribeRouteArrival(() => {
      publications.push('arrival')
    })

    navigate('#/chat/prepared')
    unsubscribeSnapshot()
    unsubscribeArrival()

    expect(publications).toEqual(['arrival', 'snapshot'])
  })

  it('publishes passive replacements to route readers without creating an arrival', () => {
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

  it('publishes each explicit navigation as one route arrival', () => {
    let arrivals = 0
    const unsubscribe = subscribeRouteArrival(() => {
      arrivals += 1
    })

    navigate('#/chat/a')
    navigate('#/chat/b')
    unsubscribe()

    expect(arrivals).toBe(2)
  })

  it('projects only the currently routed chat and never publishes a new arrival', () => {
    navigate('#/chat/active')
    let arrivals = 0
    const unsubscribe = browserConversationNavigationPort.subscribeArrival(() => {
      arrivals += 1
    })
    const beforeId = browserConversationNavigationPort.getArrival().id

    browserConversationNavigationPort.replaceConversationUrl('other', 'hidden')
    expect(window.location.hash).toBe('#/chat/active')
    browserConversationNavigationPort.replaceConversationUrl('active', 'visible')
    unsubscribe()

    expect(window.location.hash).toBe('#/chat/active/message/visible')
    expect(arrivals).toBe(0)
    expect(browserConversationNavigationPort.getArrival().id).toBe(beforeId)
    expect(browserConversationNavigationPort.getArrival().route).toEqual({
      chatId: 'active',
      targetMessageId: 'visible',
    })
  })

  it('does not let passive projection overwrite a browser route awaiting arrival', () => {
    navigate('#/chat/active/message/old-leaf')
    window.history.replaceState(null, '', '#/chat/active/message/new-leaf')

    browserConversationNavigationPort.replaceConversationUrl('active', 'old-leaf')

    expect(window.location.hash).toBe('#/chat/active/message/new-leaf')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(browserConversationNavigationPort.getArrival().route).toEqual({
      chatId: 'active',
      targetMessageId: 'new-leaf',
    })
  })

  it('uses pushState for internal navigation without synthetic hashchange events', () => {
    let hashChanges = 0
    const countHashChange = () => {
      hashChanges += 1
    }
    window.addEventListener('hashchange', countHashChange)
    for (let index = 0; index < 64; index += 1) navigate(`#/chat/internal-${index}`)
    window.removeEventListener('hashchange', countHashChange)

    expect(hashChanges).toBe(0)
  })
})

describe('anchor interception', () => {
  it('holds background maintenance until the primary navigation is semantically ready', async () => {
    const handler = makeAnchorClickHandler('#/chat/foreground-demand')
    handler({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: vi.fn(),
    } as never)
    let resumed = false
    const maintenance = awaitWorkspaceForegroundDemandIdle().then(() => {
      resumed = true
    })

    await Promise.resolve()
    expect(resumed).toBe(false)
    settleRouteForegroundDemandForPresentation('#/chat/foreground-demand', {
      hasActiveChat: true,
      targetKind: 'pending',
      revealPending: false,
      destinationDeferred: false,
    })
    await Promise.resolve()
    expect(resumed).toBe(false)
    settleRouteForegroundDemandForPresentation('#/chat/foreground-demand', {
      hasActiveChat: true,
      targetKind: 'ready',
      revealPending: true,
      destinationDeferred: false,
    })
    await Promise.resolve()
    expect(resumed).toBe(false)
    settleRouteForegroundDemandForPresentation('#/chat/foreground-demand', {
      hasActiveChat: true,
      targetKind: 'ready',
      revealPending: false,
      destinationDeferred: false,
    })
    await Promise.resolve()
    expect(resumed).toBe(false)
    let finishMetadata = () => {}
    const metadata = startRouteForegroundMetadata(
      '#/chat/foreground-demand',
      'foreground-demand',
      () =>
        new Promise<void>((resolve) => {
          finishMetadata = resolve
        }),
    )
    expect(metadata).not.toBeNull()
    expect(
      startRouteForegroundMetadata('#/chat/foreground-demand', 'foreground-demand', async () => {
        throw new Error('duplicate route metadata')
      }),
    ).toBeNull()
    finishMetadata()
    await metadata
    await maintenance
    expect(resumed).toBe(true)
  })

  it('cancels the exact route metadata owner when a later route supersedes it', async () => {
    navigate('#/chat/metadata-a')
    const metadataState: { signal?: AbortSignal } = {}
    const metadata = startRouteForegroundMetadata('#/chat/metadata-a', 'metadata-a', (signal) => {
      metadataState.signal = signal
      return new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
    })

    navigate('#/chat/metadata-b')

    expect(metadataState.signal?.aborted).toBe(true)
    await metadata
  })

  it('terminally settles failed, retained-editor, and no-chat route outcomes', () => {
    expect(
      [
        {
          hasActiveChat: true,
          targetKind: 'failed' as const,
          revealPending: false,
          destinationDeferred: false,
        },
        {
          hasActiveChat: true,
          targetKind: 'pending' as const,
          revealPending: false,
          destinationDeferred: true,
        },
        {
          hasActiveChat: false,
          targetKind: null,
          revealPending: false,
          destinationDeferred: false,
        },
      ].map(routeForegroundPresentationSettled),
    ).toEqual([true, true, true])
  })

  it('intercepts only an unmodified primary click', () => {
    const handler = makeAnchorClickHandler('#/new')
    const preventDefault = vi.fn()
    handler({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault,
    } as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(window.location.hash).toBe('#/new')
  })

  it('uses the same primary-click classifier for a caller-owned route action', () => {
    const navigatePrimary = vi.fn((href: string) => navigate(href))
    const handler = makeAnchorClickHandler('#/new', navigatePrimary)
    const preventDefault = vi.fn()

    handler({
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault,
    } as never)

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(navigatePrimary).toHaveBeenCalledOnce()
    expect(navigatePrimary).toHaveBeenCalledWith('#/new')
    expect(window.location.hash).toBe('#/new')
  })

  it.each([
    { button: 1, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false },
    { button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false },
    { button: 0, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false },
    { button: 0, metaKey: false, ctrlKey: false, shiftKey: true, altKey: false },
    { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: true },
  ])('leaves modified or non-primary clicks to the browser', (modifiers) => {
    const handler = makeAnchorClickHandler('#/new')
    const preventDefault = vi.fn()
    handler({ defaultPrevented: false, ...modifiers, preventDefault } as never)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('#/')
  })
})

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { CursorMap } from '../../src/core/types'
import { useChatStore } from '../../src/store/zustand/chatStore'
import {
  subscribeChatStreams,
  subscribeStreamTarget,
  useStreamStore,
} from '../../src/store/zustand/streamStore'
import { useUiStore } from '../../src/store/zustand/uiStore'

beforeEach(() => {
  useStreamStore.getState().reset()
  useUiStore.getState().reset()
  useChatStore.getState().reset()
})

describe('streamStore', () => {
  it('tracks active streams by stream id', () => {
    const { setActive, isActive, getActive, listByChat } = useStreamStore.getState()
    expect(isActive('S1')).toBe(false)
    setActive({
      streamId: 'S1',
      replacementEpoch: 0,
      chatId: 'C1',
      startedAt: 1,
      ownerClientId: 'tab-a',
    })
    expect(isActive('S1')).toBe(true)
    expect(getActive('S1')?.streamId).toBe('S1')
    expect(listByChat('C1').map((stream) => stream.streamId)).toEqual(['S1'])
  })

  it('supports multiple same-chat streams keyed independently', () => {
    const { setActive, getActive, getTargetActive, isTargetActive } = useStreamStore.getState()
    setActive({
      streamId: 'S1',
      replacementEpoch: 0,
      chatId: 'C1',
      messageId: 'M1',
      startedAt: 1,
      ownerClientId: 'tab-a',
    })
    setActive({
      streamId: 'S2',
      replacementEpoch: 0,
      chatId: 'C1',
      messageId: 'M2',
      startedAt: 2,
      ownerClientId: 'tab-a',
    })
    expect(getActive('S1')?.streamId).toBe('S1')
    expect(getActive('S2')?.streamId).toBe('S2')
    expect(getTargetActive('C1', 'M1')?.streamId).toBe('S1')
    expect(isTargetActive('C1', 'M1')).toBe(true)
    expect(isTargetActive('C1', 'M2')).toBe(true)
    expect(isTargetActive('C1', 'M3')).toBe(false)
  })

  it('clearActive removes only the targeted stream', () => {
    const { setActive, clearActive, isActive } = useStreamStore.getState()
    setActive({
      streamId: 'S1',
      replacementEpoch: 0,
      chatId: 'C1',
      startedAt: 1,
      ownerClientId: 'tab-a',
    })
    setActive({
      streamId: 'S2',
      replacementEpoch: 0,
      chatId: 'C2',
      startedAt: 2,
      ownerClientId: 'tab-a',
    })
    clearActive('S1', 0)
    expect(isActive('S1')).toBe(false)
    expect(isActive('S2')).toBe(true)
  })

  it('abortChat calls the registered abort handlers for that chat only', () => {
    const abortA = vi.fn()
    const abortB = vi.fn()
    const abortOther = vi.fn()
    const { setActive, abortChat } = useStreamStore.getState()
    setActive({
      streamId: 'S1',
      replacementEpoch: 0,
      chatId: 'C1',
      startedAt: 1,
      ownerClientId: 'tab-a',
      abort: abortA,
    })
    setActive({
      streamId: 'S2',
      replacementEpoch: 0,
      chatId: 'C1',
      startedAt: 2,
      ownerClientId: 'tab-a',
      abort: abortB,
    })
    setActive({
      streamId: 'S3',
      replacementEpoch: 0,
      chatId: 'C2',
      startedAt: 3,
      ownerClientId: 'tab-a',
      abort: abortOther,
    })
    expect(abortChat('C1')).toBe(2)
    expect(abortA).toHaveBeenCalledTimes(1)
    expect(abortB).toHaveBeenCalledTimes(1)
    expect(abortOther).not.toHaveBeenCalled()
  })

  it('rejects stale publishers and cleanup after a workspace replacement', () => {
    const oldAbort = vi.fn()
    const state = useStreamStore.getState()
    state.setActive({
      streamId: 'same-stream',
      replacementEpoch: 0,
      chatId: 'same-chat',
      messageId: 'same-message',
      startedAt: 1,
      ownerClientId: 'old-tab',
      abort: oldAbort,
    })
    state.setLiveSnapshot({
      streamId: 'same-stream',
      replacementEpoch: 0,
      chatId: 'same-chat',
      messageId: 'same-message',
      content: [{ type: 'output_text', text: 'old' }],
      textLength: 3,
      reasoningLength: 0,
      updatedAt: 1,
    })

    state.replaceWorkspace(1)
    expect(oldAbort).toHaveBeenCalledTimes(1)
    expect(state.getActive('same-stream')).toBeUndefined()

    state.setActive({
      streamId: 'same-stream',
      replacementEpoch: 0,
      chatId: 'same-chat',
      messageId: 'same-message',
      startedAt: 2,
      ownerClientId: 'old-tab',
    })
    state.setLiveSnapshot({
      streamId: 'same-stream',
      replacementEpoch: 0,
      chatId: 'same-chat',
      messageId: 'same-message',
      content: [{ type: 'output_text', text: 'late old' }],
      textLength: 8,
      reasoningLength: 0,
      updatedAt: 2,
    })
    expect(state.getActive('same-stream')).toBeUndefined()
    expect(useStreamStore.getState().getLiveSnapshot('same-chat', 'same-message')).toBeUndefined()

    state.setActive({
      streamId: 'same-stream',
      replacementEpoch: 1,
      chatId: 'same-chat',
      messageId: 'same-message',
      startedAt: 3,
      ownerClientId: 'new-tab',
    })
    state.setLiveSnapshot({
      streamId: 'same-stream',
      replacementEpoch: 1,
      chatId: 'same-chat',
      messageId: 'same-message',
      content: [{ type: 'output_text', text: 'current' }],
      textLength: 7,
      reasoningLength: 0,
      updatedAt: 3,
    })
    state.clearActive('same-stream', 0)
    state.clearLiveSnapshot('same-message', 'same-stream', 0)

    expect(state.getActive('same-stream')?.replacementEpoch).toBe(1)
    expect(useStreamStore.getState().getLiveSnapshot('same-chat', 'same-message')?.content).toEqual(
      [{ type: 'output_text', text: 'current' }],
    )
  })

  it('indexes 10k starts linearly and isolates a live update to one target', () => {
    const state = useStreamStore.getState()
    const firstTarget = vi.fn()
    const updatedTarget = vi.fn()
    const lastTarget = vi.fn()
    const unrelatedTarget = vi.fn()
    const chatLifecycle = vi.fn()
    const unrelatedChat = vi.fn()
    const stopFirst = subscribeStreamTarget('wide-chat', 'M0', firstTarget)
    const stopUpdated = subscribeStreamTarget('wide-chat', 'M5000', updatedTarget)
    const stopLast = subscribeStreamTarget('wide-chat', 'M9999', lastTarget)
    const stopUnrelatedTarget = subscribeStreamTarget(
      'unrelated-chat',
      'unrelated-message',
      unrelatedTarget,
    )
    const stopChat = subscribeChatStreams('wide-chat', chatLifecycle)
    const stopUnrelatedChat = subscribeChatStreams('unrelated-chat', unrelatedChat)
    const globalLifecycle = vi.fn()
    const stopGlobal = useStreamStore.subscribe(globalLifecycle)
    const listActive = vi.spyOn(state, 'listActive')

    for (let index = 0; index < 10_000; index += 1) {
      state.setActive({
        streamId: `S${index}`,
        replacementEpoch: 0,
        chatId: 'wide-chat',
        messageId: `M${index}`,
        startedAt: index,
        ownerClientId: 'tab-a',
      })
    }

    expect(state.listByChat('wide-chat')).toHaveLength(10_000)
    expect(globalLifecycle).toHaveBeenCalledTimes(10_000)
    expect(chatLifecycle).toHaveBeenCalledTimes(10_000)
    expect(firstTarget).toHaveBeenCalledTimes(1)
    expect(updatedTarget).toHaveBeenCalledTimes(1)
    expect(lastTarget).toHaveBeenCalledTimes(1)
    expect(unrelatedTarget).not.toHaveBeenCalled()
    expect(unrelatedChat).not.toHaveBeenCalled()
    expect(listActive).toHaveBeenCalledTimes(0)

    state.setLiveSnapshot({
      streamId: 'S5000',
      replacementEpoch: 0,
      chatId: 'wide-chat',
      messageId: 'M5000',
      content: [{ type: 'output_text', text: 'one token target' }],
      textLength: 16,
      reasoningLength: 0,
      updatedAt: 10_001,
    })

    expect(updatedTarget).toHaveBeenCalledTimes(2)
    expect(firstTarget).toHaveBeenCalledTimes(1)
    expect(lastTarget).toHaveBeenCalledTimes(1)
    expect(unrelatedTarget).not.toHaveBeenCalled()
    expect(chatLifecycle).toHaveBeenCalledTimes(10_000)
    expect(unrelatedChat).not.toHaveBeenCalled()
    expect(globalLifecycle).toHaveBeenCalledTimes(10_000)
    expect(listActive).toHaveBeenCalledTimes(0)

    stopFirst()
    stopUpdated()
    stopLast()
    stopUnrelatedTarget()
    stopChat()
    stopUnrelatedChat()
    stopGlobal()
  })
})

describe('uiStore', () => {
  it('starts with system theme, sidebar open, no active chat', () => {
    const state = useUiStore.getState()
    expect(state.theme).toBe('system')
    expect(state.sidebarCollapsed).toBe(false)
    expect(state.activeChatId).toBeNull()
    expect(state.composerFullscreen).toBe(false)
    expect(state.treeViewChatId).toBeNull()
    expect(state.treeExpanded).toBe(false)
  })

  it('setters update individual slices', () => {
    const { setTheme, setSidebarCollapsed, setActiveChatId, setComposerFullscreen } =
      useUiStore.getState()
    setTheme('dark')
    setSidebarCollapsed(true)
    setActiveChatId('C1')
    setComposerFullscreen(true)
    const state = useUiStore.getState()
    expect(state.theme).toBe('dark')
    expect(state.sidebarCollapsed).toBe(true)
    expect(state.activeChatId).toBe('C1')
    expect(state.composerFullscreen).toBe(true)
  })

  it('keeps tree view and density ephemeral in this tab', () => {
    const { setTreeExpanded, setTreeViewChatId } = useUiStore.getState()
    setTreeViewChatId('C1')
    setTreeExpanded(true)
    expect(useUiStore.getState()).toMatchObject({ treeViewChatId: 'C1', treeExpanded: true })
    useUiStore.getState().reset()
    expect(useUiStore.getState()).toMatchObject({ treeViewChatId: null, treeExpanded: false })
  })
})

describe('chatStore cursor map', () => {
  it('navigateToCursor stores an immutable copy (caller mutation does not bleed in)', () => {
    const { navigateToCursor, getCursor } = useChatStore.getState()
    const map = { __root__: 'M1' }
    navigateToCursor('C1', map)
    map.__root__ = 'MUTATED'
    const cursor = getCursor('C1')
    expectTypeOf(cursor).toEqualTypeOf<Readonly<CursorMap> | undefined>()
    expect(cursor).toEqual({ __root__: 'M1' })
    if (!cursor) throw new Error('cursor missing')
    const mutableCursor = cursor as CursorMap
    expect(() => {
      mutableCursor.__root__ = 'MUTATED'
    }).toThrow(TypeError)
    expect(getCursor('C1')).toEqual({ __root__: 'M1' })
  })

  it('clearCursor removes only the targeted chat', () => {
    const { navigateToCursor, clearCursor, getCursor } = useChatStore.getState()
    navigateToCursor('C1', { __root__: 'M1' })
    navigateToCursor('C2', { __root__: 'M9' })
    clearCursor('C1')
    expect(getCursor('C1')).toBeUndefined()
    expect(getCursor('C2')).toEqual({ __root__: 'M9' })
  })

  it('accepts only the latest navigation intent', () => {
    const store = useChatStore.getState()
    const older = store.beginNavigationIntent('C1')
    const newer = store.beginNavigationIntent('C1')

    expect(store.setCursorForIntent('C1', older, { __root__: 'old' })).toBe(false)
    expect(store.setCursorForIntent('C1', newer, { __root__: 'new' })).toBe(true)
    expect(store.getCursor('C1')).toEqual({ __root__: 'new' })
  })

  it('claims navigation ownership without publishing a cursor change', () => {
    const store = useChatStore.getState()
    store.navigateToCursor('C1', { __root__: 'M1' })
    const cursor = store.getCursor('C1')
    const revisions: string[] = []
    let previousCursor = cursor
    const unsubscribe = useChatStore.subscribe((state) => {
      const nextCursor = state.getCursor('C1')
      if (nextCursor !== previousCursor) {
        previousCursor = nextCursor
        revisions.push(state.getNavigationRevision('C1'))
      }
    })

    store.beginNavigationIntent('C1')

    unsubscribe()
    expect(store.getCursor('C1')).toBe(cursor)
    expect(revisions).toEqual([])
  })

  it('keeps the cursor reference while identical direct navigation mints a newer intent', () => {
    const store = useChatStore.getState()
    const olderIntent = store.navigateToCursor('C1', { __root__: 'M1' })
    const cursor = store.getCursor('C1')
    const publication = useChatStore.getState().publication

    const newerIntent = store.navigateToCursor('C1', { __root__: 'M1' })

    expect(newerIntent).not.toBe(olderIntent)
    expect(store.isNavigationIntentCurrent(olderIntent)).toBe(false)
    expect(store.isNavigationIntentCurrent(newerIntent)).toBe(true)
    expect(store.getCursor('C1')).toBe(cursor)
    expect(useChatStore.getState().publication).toBe(publication + 1)
  })

  it('does not publish value-identical guarded cursor commits or reconciliation', () => {
    const store = useChatStore.getState()
    const intent = store.navigateToCursor('C1', { __root__: 'M1' })
    const cursor = store.getCursor('C1')
    const publication = useChatStore.getState().publication
    const listener = vi.fn()
    const unsubscribe = useChatStore.subscribe(listener)

    expect(store.setCursorForIntent('C1', intent, { __root__: 'M1' })).toBe(true)
    store.reconcileCursor('C1', { __root__: 'M1' })

    unsubscribe()
    expect(store.getCursor('C1')).toBe(cursor)
    expect(useChatStore.getState().publication).toBe(publication)
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not republish an identical pending path selection', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const selections = { __root__: 'M1', M1: 'pending-assistant' }
    const path = ['M1', 'pending-assistant']
    expect(store.selectPathForIntent('C1', intent, selections, path)).toBe(true)
    const cursor = store.getCursor('C1')
    const pending = store.getPendingBranchNavigation('C1')
    const publication = useChatStore.getState().publication
    const listener = vi.fn()
    const unsubscribe = useChatStore.subscribe(listener)

    expect(store.selectPathForIntent('C1', intent, { ...selections }, [...path])).toBe(true)

    unsubscribe()
    expect(store.getCursor('C1')).toBe(cursor)
    expect(store.getPendingBranchNavigation('C1')).toBe(pending)
    expect(useChatStore.getState().publication).toBe(publication)
    expect(listener).not.toHaveBeenCalled()
  })

  it('applies cursor patches without replacing or mutating the previous snapshot', () => {
    const store = useChatStore.getState()
    store.navigateToCursor('C1', { __root__: 'M1', M1: 'M2' })
    const previous = store.getCursor('C1')

    store.navigateWithCursorPatch('C1', { M1: 'M9', M9: 'M10' })

    expect(previous).toEqual({ __root__: 'M1', M1: 'M2' })
    expect(store.getCursor('C1')).toEqual({ __root__: 'M1', M1: 'M9', M9: 'M10' })
  })

  it('clears branch intents on workspace replacement without resetting tab route authority', () => {
    const store = useChatStore.getState()
    const staleIntent = store.beginNavigationIntent('C1')

    store.resetForWorkspaceReplacement()

    expect(store.isNavigationIntentCurrent(staleIntent)).toBe(false)
    expect(store.setCursorForIntent('C1', staleIntent, { __root__: 'stale' })).toBe(false)
    expect(store.getCursor('C1')).toBeUndefined()
  })

  it('publishes pending removal without replacing an identical cursor', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    store.selectPathForIntent('C1', intent, { __root__: 'pending' }, ['pending'])
    const cursor = store.getCursor('C1')
    const publication = useChatStore.getState().publication

    expect(store.setCursorForIntent('C1', intent, { __root__: 'pending' })).toBe(true)

    expect(store.getCursor('C1')).toBe(cursor)
    expect(store.getPendingBranchNavigation('C1')).toBeUndefined()
    expect(useChatStore.getState().publication).toBe(publication + 1)
  })

  it('keeps unpublished local targets explicit and revision-scoped', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    expect(
      store.selectPathForIntent('C1', intent, { __root__: 'M1', M1: 'pending-assistant' }, [
        'M1',
        'pending-assistant',
      ]),
    ).toBe(true)
    expect(store.getPendingBranchNavigation('C1')).toEqual({
      revision: intent.revision,
      selections: { __root__: 'M1', M1: 'pending-assistant' },
      pathMessageIds: ['M1', 'pending-assistant'],
      targetMessageId: 'pending-assistant',
    })
    const pending = store.getPendingBranchNavigation('C1')
    expectTypeOf(pending?.selections).toEqualTypeOf<Readonly<CursorMap> | undefined>()
    expect(Object.isFrozen(pending)).toBe(true)
    expect(Object.isFrozen(pending?.selections)).toBe(true)
    expect(Object.isFrozen(pending?.pathMessageIds)).toBe(true)
    if (!pending) throw new Error('pending navigation missing')
    const mutableSelections = pending.selections as CursorMap
    expect(() => {
      mutableSelections.__root__ = 'MUTATED'
    }).toThrow(TypeError)

    store.acknowledgePendingBranchNavigation('C1', pending)
    expect(store.getPendingBranchNavigation('C1')).toBeUndefined()
  })

  it('clears pending local targets when a newer explicit navigation starts', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    store.selectPathForIntent('C1', intent, { __root__: 'pending' }, ['pending'])

    const newer = store.navigateToCursor('C1', { __root__: 'observed' })

    expect(store.getPendingBranchNavigation('C1')).toBeUndefined()
    expect(store.getCursor('C1')).toEqual({ __root__: 'observed' })
    expect(store.getNavigationRevision('C1')).toBe(newer.revision)
    expect(store.getNavigationRevision('C1')).not.toBe(intent.revision)
  })

  it('does not let a superseded chat pending target protect a dangling cursor', () => {
    const store = useChatStore.getState()
    const firstIntent = store.beginNavigationIntent('C1')
    store.selectPathForIntent('C1', firstIntent, { __root__: 'pending' }, ['pending'])

    store.beginNavigationIntent('C2')

    expect(store.getPendingBranchNavigation('C1')).toBeUndefined()
    expect(store.getCursor('C1')).toEqual({ __root__: 'pending' })
  })

  it('cannot acknowledge a newer pending target with an older pending snapshot', () => {
    const store = useChatStore.getState()
    const olderIntent = store.beginNavigationIntent('C1')
    store.selectPathForIntent('C1', olderIntent, { __root__: 'older' }, ['older'])
    const olderPending = store.getPendingBranchNavigation('C1')
    if (!olderPending) throw new Error('older pending navigation missing')

    const newerIntent = store.beginNavigationIntent('C1')
    store.selectPathForIntent('C1', newerIntent, { __root__: 'newer' }, ['newer'])
    const newerPending = store.getPendingBranchNavigation('C1')

    store.acknowledgePendingBranchNavigation('C1', olderPending)

    expect(store.getPendingBranchNavigation('C1')).toBe(newerPending)
  })

  it('does not reuse intent revisions across workspace resets', () => {
    const store = useChatStore.getState()
    const staleIntent = store.beginNavigationIntent('C1')
    store.reset()
    const currentIntent = store.beginNavigationIntent('C1')

    expect(BigInt(currentIntent.revision)).toBeGreaterThan(BigInt(staleIntent.revision))
    expect(store.setCursorForIntent('C1', staleIntent, { __root__: 'stale' })).toBe(false)
    expect(store.getCursor('C1')).toEqual({})
  })

  it('rejects copied or cross-chat intent objects even when their revision text matches', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const forged = { ...intent } as typeof intent

    expect(store.setCursorForIntent('C1', forged, { __root__: 'forged' })).toBe(false)
    expect(store.setCursorForIntent('C2', intent, { __root__: 'cross-chat' })).toBe(false)
    expect(store.getCursor('C1')).toEqual({})
    expect(store.getCursor('C2')).toBeUndefined()
  })
})

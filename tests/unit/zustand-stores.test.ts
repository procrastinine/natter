import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { ChatId, CursorMap, Message } from '../../src/core/types'
import { splitMessageForStorage } from '../../src/store/message-storage'
import {
  type CommittedPathProducer,
  type NavigationIntent,
  useChatStore,
} from '../../src/store/zustand/chatStore'
import {
  __streamStoreIndexStatsForTests,
  isStreamRelevantToSelectedPath,
  subscribeChatStreams,
  subscribeStreamTarget,
  useIsStreamTargetActive,
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

  it('subscribes target activity to only the exact message key', () => {
    let renders = 0
    const { result } = renderHook(() => {
      renders += 1
      return useIsStreamTargetActive('C1', 'M1')
    })
    const initialRenders = renders

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'sibling-stream',
        replacementEpoch: 0,
        chatId: 'C1',
        messageId: 'M2',
        startedAt: 1,
        ownerClientId: 'tab-a',
      })
    })
    expect(result.current).toBe(false)
    expect(renders).toBe(initialRenders)

    act(() => {
      useStreamStore.getState().setActive({
        streamId: 'target-stream',
        replacementEpoch: 0,
        chatId: 'C1',
        messageId: 'M1',
        startedAt: 2,
        ownerClientId: 'tab-a',
      })
    })
    expect(result.current).toBe(true)
    expect(renders).toBe(initialRenders + 1)
  })

  it('matches a selected path exactly and bridges only an unknown local generation target', () => {
    const selected = new Set<Message['id']>(['selected-target'])
    const known = new Set<Message['id']>(['selected-target', 'known-off-path'])
    const base = {
      streamId: 'S1',
      replacementEpoch: 0,
      chatId: 'C1',
      startedAt: 1,
      ownerClientId: 'tab-a',
    }

    expect(
      isStreamRelevantToSelectedPath(
        { ...base, messageId: 'selected-target', ownerClientId: 'other-tab' },
        selected,
        known,
        'revision-current',
      ),
    ).toBe(true)
    expect(
      isStreamRelevantToSelectedPath(
        {
          ...base,
          messageId: 'known-off-path',
          attemptKind: 'generation',
          originNavigationRevision: 'revision-current',
        },
        selected,
        known,
        'revision-current',
      ),
    ).toBe(false)
    expect(
      isStreamRelevantToSelectedPath(
        {
          ...base,
          messageId: 'reserved-not-committed',
          attemptKind: 'generation',
          originNavigationRevision: 'revision-current',
        },
        selected,
        known,
        'revision-current',
      ),
    ).toBe(true)
    expect(
      isStreamRelevantToSelectedPath(
        {
          ...base,
          messageId: 'reserved-not-committed',
          attemptKind: 'generation',
          originNavigationRevision: 'revision-old',
        },
        selected,
        known,
        'revision-current',
      ),
    ).toBe(false)
    expect(
      isStreamRelevantToSelectedPath(
        {
          ...base,
          messageId: 'reserved-not-committed',
          attemptKind: 'continuation',
          originNavigationRevision: 'revision-current',
        },
        selected,
        known,
        'revision-current',
      ),
    ).toBe(false)
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

  it('retires per-chat lifecycle revisions after the final active stream', () => {
    const state = useStreamStore.getState()
    for (let index = 0; index < 1_000; index += 1) {
      const chatId = `completed-chat-${index}`
      const streamId = `completed-stream-${index}`
      state.setActive({
        streamId,
        replacementEpoch: 0,
        chatId,
        messageId: `message-${index}`,
        startedAt: index,
        ownerClientId: 'tab-a',
      })
      state.clearActive(streamId, 0)
    }

    expect(__streamStoreIndexStatsForTests()).toEqual({
      activeChats: 0,
      chatLifecycleRevisions: 0,
    })

    state.setActive({
      streamId: 'first-live',
      replacementEpoch: 0,
      chatId: 'shared-live-chat',
      messageId: 'first-message',
      startedAt: 1_001,
      ownerClientId: 'tab-a',
    })
    state.setActive({
      streamId: 'second-live',
      replacementEpoch: 0,
      chatId: 'shared-live-chat',
      messageId: 'second-message',
      startedAt: 1_002,
      ownerClientId: 'tab-a',
    })
    state.clearActive('first-live', 0)
    expect(__streamStoreIndexStatsForTests()).toEqual({
      activeChats: 1,
      chatLifecycleRevisions: 1,
    })
    state.clearActive('second-live', 0)
    expect(__streamStoreIndexStatsForTests()).toEqual({
      activeChats: 0,
      chatLifecycleRevisions: 0,
    })
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
  function registerProducer(chatId: ChatId, intent: NavigationIntent): CommittedPathProducer {
    const producer = useChatStore.getState().registerCommittedPathProducer(chatId, intent)
    if (!producer) throw new Error('committed path producer registration failed')
    return producer
  }

  function committedPresentation(
    id: string,
    parentId: string | null,
    nodeVersion: number,
    bodyVersion: number,
    text: string,
    chatId = 'C1',
  ) {
    const message: Message = {
      id,
      chatId,
      parentId,
      siblingIndex: 0,
      turnId: `turn-${id}`,
      turnIndex: 0,
      createdAt: nodeVersion + 1,
      role: parentId === null ? 'user' : 'assistant',
      origin: parentId === null ? 'user' : 'generated',
      content: [{ type: parentId === null ? 'text' : 'output_text', text }],
      nodeVersion,
      deleted: false,
    }
    const { header } = splitMessageForStorage(message, { bodyVersion })
    return { header, message, bodyVersion }
  }

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

  it('keeps a chat-local pending target while another chat owns route authority', () => {
    const store = useChatStore.getState()
    const firstIntent = store.beginNavigationIntent('C1')
    store.selectPathForIntent('C1', firstIntent, { __root__: 'pending' }, ['pending'])

    store.beginNavigationIntent('C2')

    expect(store.getPendingBranchNavigation('C1')?.pathMessageIds.at(-1)).toBe('pending')
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

  it('publishes committed path selection and its read-your-write receipt atomically', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const assistant = committedPresentation('A1', 'U1', 0, 0, '')
    const listener = vi.fn()
    const unsubscribe = useChatStore.subscribe(listener)

    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'open',
          pathHeaders: [user.header, assistant.header],
          presentations: [user, assistant],
        },
      ),
    ).toBe(true)

    unsubscribe()
    const receipt = useChatStore.getState().getCommittedPathPresentation('C1')
    expect(listener).toHaveBeenCalledOnce()
    expect(useChatStore.getState().getCursor('C1')).toEqual({ __root__: 'U1', U1: 'A1' })
    expect(useChatStore.getState().getPendingBranchNavigation('C1')?.pathMessageIds.at(-1)).toBe(
      'A1',
    )
    expect(receipt?.phase).toBe('open')
    expect(receipt?.pathHeaders.at(-1)?.id).toBe('A1')
    expect(receipt?.presentations.map((presentation) => presentation.message.id)).toEqual([
      'U1',
      'A1',
    ])
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt?.pathHeaders)).toBe(true)
    expect(Object.isFrozen(receipt?.structuralHeaders)).toBe(true)
    expect(Object.isFrozen(receipt?.presentations)).toBe(true)
  })

  it('rebases an exact body onto newer metadata and sibling order for a new local leaf', () => {
    const store = useChatStore.getState()
    const firstIntent = store.beginNavigationIntent('C1')
    const firstProducer = registerProducer('C1', firstIntent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        firstProducer,
        { __root__: 'U1' },
        {
          phase: 'terminal',
          pathHeaders: [user.header],
          presentations: [user],
        },
      ),
    ).toBe(true)

    const calibratedUser = {
      ...user,
      header: {
        ...user.header,
        siblingIndex: 1,
        nodeVersion: 1,
        originalTokenEstimate: 1,
      },
      message: {
        ...user.message,
        siblingIndex: 1,
        nodeVersion: 1,
        originalTokenEstimate: 1,
      },
    }
    expect(
      store.publishCommittedMessageMutation('C1', [calibratedUser.header], calibratedUser),
    ).toBe(true)

    const nextIntent = store.beginNavigationIntent('C1')
    const nextProducer = registerProducer('C1', nextIntent)
    const assistant = committedPresentation('A1', 'U1', 0, 0, '')
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        nextProducer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'open',
          pathHeaders: [user.header, assistant.header],
          presentations: [assistant],
        },
      ),
    ).toBe(true)

    const receipt = store.getCommittedPathPresentation('C1')
    expect(store.getCursor('C1')).toEqual({ __root__: 'U1', U1: 'A1' })
    expect(receipt?.pathHeaders[0]).toMatchObject({
      id: 'U1',
      siblingIndex: 1,
      nodeVersion: 1,
      bodyVersion: 0,
      originalTokenEstimate: 1,
    })
    expect(receipt?.presentations.find((item) => item.message.id === 'U1')).toMatchObject({
      bodyVersion: 0,
      message: {
        nodeVersion: 1,
        siblingIndex: 1,
        originalTokenEstimate: 1,
        content: [{ type: 'text', text: 'prompt' }],
      },
    })
  })

  it('publishes an exact empty path and tombstones after a structural delete', () => {
    const store = useChatStore.getState()
    const initialIntent = store.beginNavigationIntent('C1')
    const initialProducer = registerProducer('C1', initialIntent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        initialProducer,
        { __root__: 'U1' },
        {
          phase: 'terminal',
          pathHeaders: [user.header],
          presentations: [user],
        },
      ),
    ).toBe(true)

    const deleteIntent = store.beginNavigationIntent('C1')
    const deleteProducer = registerProducer('C1', deleteIntent)
    expect(store.patchCursorForIntent('C1', deleteIntent, { __root__: undefined })).toBe(true)
    const tombstone = { ...user.header, deleted: true, nodeVersion: 1 }
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        deleteProducer,
        {},
        {
          phase: 'terminal',
          pathHeaders: [],
          structuralHeaders: [tombstone],
          presentations: [],
        },
      ),
    ).toBe(true)

    const receipt = store.getCommittedPathPresentation('C1')
    expect(receipt?.pathHeaders).toEqual([])
    expect(receipt?.structuralHeaders).toEqual([tombstone])
    expect(receipt?.presentations).toEqual([])
    expect(store.getCursor('C1')).toEqual({})
  })

  it('publishes a structural cursor patch and its empty receipt in one state change', () => {
    const store = useChatStore.getState()
    const root = committedPresentation('U1', null, 0, 0, 'prompt')
    const intent = store.navigateToCursor('C1', { __root__: 'U1' })
    const producer = registerProducer('C1', intent)
    const tombstone = { ...root.header, deleted: true, nodeVersion: 1 }
    const listener = vi.fn()
    const unsubscribe = useChatStore.subscribe(listener)

    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        {},
        {
          phase: 'terminal',
          pathHeaders: [],
          structuralHeaders: [tombstone],
          presentations: [],
        },
        { __root__: undefined },
      ),
    ).toBe(true)

    unsubscribe()
    expect(listener).toHaveBeenCalledOnce()
    expect(store.getCursor('C1')).toEqual({})
    expect(store.getCommittedPathPresentation('C1')?.structuralHeaders).toEqual([tombstone])
  })

  it('carries unresolved off-path structural changes into a later receipt', () => {
    const store = useChatStore.getState()
    const root = committedPresentation('U1', null, 0, 0, 'prompt')
    const selected = committedPresentation('A1', 'U1', 0, 0, 'selected')
    const deletedSibling = {
      ...committedPresentation('A2', 'U1', 1, 0, 'deleted sibling').header,
      siblingIndex: 1,
      deleted: true,
    }
    const firstIntent = store.beginNavigationIntent('C1')
    const firstProducer = registerProducer('C1', firstIntent)
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        firstProducer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'terminal',
          pathHeaders: [root.header, selected.header],
          structuralHeaders: [deletedSibling],
          presentations: [root, selected],
        },
      ),
    ).toBe(true)

    const imported = committedPresentation('U2', 'A1', 0, 0, 'imported')
    const secondIntent = store.beginNavigationIntent('C1')
    const secondProducer = registerProducer('C1', secondIntent)
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        secondProducer,
        { __root__: 'U1', U1: 'A1', A1: 'U2' },
        {
          phase: 'terminal',
          pathHeaders: [root.header, selected.header, imported.header],
          structuralHeaders: [imported.header],
          presentations: [imported],
        },
      ),
    ).toBe(true)

    const structuralById = new Map(
      store
        .getCommittedPathPresentation('C1')
        ?.structuralHeaders.map((header) => [header.id, header]),
    )
    expect(structuralById.get('A2')).toEqual(deletedSibling)
    expect(structuralById.get('U2')).toEqual(imported.header)
  })

  it('carries unresolved off-path structure through a path-changing empty delete', () => {
    const store = useChatStore.getState()
    const root = committedPresentation('U1', null, 0, 0, 'prompt')
    const deletedSibling = {
      ...committedPresentation('U2', null, 1, 0, 'older deleted root').header,
      siblingIndex: 1,
      deleted: true,
    }
    const firstIntent = store.beginNavigationIntent('C1')
    const firstProducer = registerProducer('C1', firstIntent)
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        firstProducer,
        { __root__: 'U1' },
        {
          phase: 'terminal',
          pathHeaders: [root.header],
          structuralHeaders: [deletedSibling],
          presentations: [root],
        },
      ),
    ).toBe(true)

    const deleteIntent = store.beginNavigationIntent('C1')
    const deleteProducer = registerProducer('C1', deleteIntent)
    expect(store.patchCursorForIntent('C1', deleteIntent, { __root__: undefined })).toBe(true)
    expect(store.getCommittedPathPresentation('C1')).toBeUndefined()
    const deletedRoot = { ...root.header, deleted: true, nodeVersion: 1 }
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        deleteProducer,
        {},
        {
          phase: 'terminal',
          pathHeaders: [],
          structuralHeaders: [deletedRoot],
          presentations: [],
        },
      ),
    ).toBe(true)

    expect(
      new Map(
        store
          .getCommittedPathPresentation('C1')
          ?.structuralHeaders.map((header) => [header.id, header]),
      ),
    ).toEqual(
      new Map([
        [deletedSibling.id, deletedSibling],
        [deletedRoot.id, deletedRoot],
      ]),
    )
  })

  it('discards a hidden prior receipt when a path-changing producer seals without publishing', () => {
    const store = useChatStore.getState()
    const root = committedPresentation('U1', null, 0, 0, 'prompt')
    const firstIntent = store.beginNavigationIntent('C1')
    const firstProducer = registerProducer('C1', firstIntent)
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        firstProducer,
        { __root__: 'U1' },
        {
          phase: 'terminal',
          pathHeaders: [root.header],
          presentations: [root],
        },
      ),
    ).toBe(true)

    const failedIntent = store.beginNavigationIntent('C1')
    const failedProducer = registerProducer('C1', failedIntent)
    expect(store.patchCursorForIntent('C1', failedIntent, { __root__: undefined })).toBe(true)
    expect(store.sealCommittedPathProducer('C1', failedProducer)).toBe(true)
    store.navigateToCursor('C1', { __root__: 'U1' })

    expect(store.getCommittedPathPresentation('C1')).toBeUndefined()
  })

  it('lets a registered producer publish its first receipt after this tab visits another chat', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const user = committedPresentation('U1', null, 0, 0, 'background prompt')

    store.beginNavigationIntent('C2')

    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1' },
        {
          phase: 'terminal',
          pathHeaders: [user.header],
          presentations: [user],
        },
      ),
    ).toBe(true)
    expect(store.getCommittedPathPresentation('C1')?.phase).toBe('terminal')
    expect(store.getCommittedPathPresentation('C1')?.pathHeaders.at(-1)?.id).toBe('U1')
    expect(store.getCursor('C2')).toEqual({})
  })

  it('rejects a pending producer after a newer same-chat navigation', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const user = committedPresentation('U1', null, 0, 0, 'stale prompt')

    store.navigateToCursor('C1', { __root__: 'newer' })

    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1' },
        {
          phase: 'terminal',
          pathHeaders: [user.header],
          presentations: [user],
        },
      ),
    ).toBe(false)
    expect(store.getCursor('C1')).toEqual({ __root__: 'newer' })
    expect(store.getCommittedPathPresentation('C1')).toBeUndefined()
  })

  it('keeps the newest terminal receipt until that exact identity is acknowledged', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const placeholder = committedPresentation('A1', 'U1', 0, 0, '')
    store.selectCommittedPathForProducer(
      'C1',
      producer,
      { __root__: 'U1', U1: 'A1' },
      {
        phase: 'open',
        pathHeaders: [user.header, placeholder.header],
        presentations: [user, placeholder],
      },
    )
    const openReceipt = store.getCommittedPathPresentation('C1')
    if (!openReceipt) throw new Error('open receipt missing')
    const finalAssistant = committedPresentation('A1', 'U1', 1, 1, 'answer')

    expect(
      store.updateCommittedMessageForProducer('C1', producer, finalAssistant, 'terminal'),
    ).toBe(true)
    const terminalReceipt = useChatStore.getState().getCommittedPathPresentation('C1')
    expect(terminalReceipt).not.toBe(openReceipt)
    expect(terminalReceipt).toMatchObject({ phase: 'terminal' })
    expect(
      terminalReceipt?.presentations.find((presentation) => presentation.message.id === 'A1'),
    ).toMatchObject({ bodyVersion: 1, message: { content: [{ text: 'answer' }] } })

    store.acknowledgeCommittedPathPresentation('C1', openReceipt)
    expect(useChatStore.getState().getCommittedPathPresentation('C1')).toBe(terminalReceipt)
    if (!terminalReceipt) throw new Error('terminal receipt missing')
    store.acknowledgeCommittedPathPresentation('C1', terminalReceipt)
    expect(useChatStore.getState().getCommittedPathPresentation('C1')).toBeUndefined()
  })

  it('makes sealing an open producer absorbing while retaining its terminal receipt', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const placeholder = committedPresentation('A1', 'U1', 0, 0, '')
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'open',
          pathHeaders: [user.header, placeholder.header],
          presentations: [user, placeholder],
        },
      ),
    ).toBe(true)

    expect(store.sealCommittedPathProducer('C1', producer)).toBe(true)
    const sealed = store.getCommittedPathPresentation('C1')
    expect(sealed?.phase).toBe('terminal')
    expect(sealed?.pathHeaders.at(-1)?.id).toBe('A1')
    expect(
      store.updateCommittedMessageForProducer(
        'C1',
        producer,
        committedPresentation('A1', 'U1', 1, 1, 'late answer'),
        'terminal',
      ),
    ).toBe(false)
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'open',
          pathHeaders: [user.header, placeholder.header],
          presentations: [placeholder],
        },
      ),
    ).toBe(false)
    expect(store.getCommittedPathPresentation('C1')).toBe(sealed)
  })

  it('rejects a producer update that changes committed tree structure', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const placeholder = committedPresentation('A1', 'U1', 0, 0, '')
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'open',
          pathHeaders: [user.header, placeholder.header],
          presentations: [user, placeholder],
        },
      ),
    ).toBe(true)
    const finalPresentation = committedPresentation('A1', 'U1', 1, 1, 'answer')
    const structurallyStale = {
      ...finalPresentation,
      header: { ...finalPresentation.header, parentId: 'different-parent' },
      message: { ...finalPresentation.message, parentId: 'different-parent' },
    }

    expect(
      store.updateCommittedMessageForProducer('C1', producer, structurallyStale, 'terminal'),
    ).toBe(false)
    expect(store.getCommittedPathPresentation('C1')?.phase).toBe('open')
    expect(store.getCommittedPathPresentation('C1')?.pathHeaders.at(-1)?.id).toBe('A1')
  })

  it('rejects incoherent exact presentations at every publication boundary', () => {
    const store = useChatStore.getState()
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const placeholder = committedPresentation('A1', 'U1', 0, 0, '')
    const incoherentPlaceholder = {
      ...placeholder,
      message: { ...placeholder.message, nodeVersion: 99 },
    }
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'open',
          pathHeaders: [user.header, placeholder.header],
          presentations: [user, incoherentPlaceholder],
        },
      ),
    ).toBe(false)

    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'open',
          pathHeaders: [user.header, placeholder.header],
          presentations: [user, placeholder],
        },
      ),
    ).toBe(true)
    const finalAssistant = committedPresentation('A1', 'U1', 1, 1, 'answer')
    expect(
      store.updateCommittedMessageForProducer(
        'C1',
        producer,
        { ...finalAssistant, bodyVersion: 0 },
        'terminal',
      ),
    ).toBe(false)
    expect(
      store.publishCommittedMessageMutation('C1', [user.header, placeholder.header], {
        ...user,
        message: { ...user.message, parentId: 'wrong-parent' },
      }),
    ).toBe(false)
  })

  it.each([
    'cursor replacement',
    'cursor patch',
  ] as const)('keeps producer ownership and pending path through same-path %s', (navigationKind) => {
    const store = useChatStore.getState()
    const producerIntent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', producerIntent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const placeholder = committedPresentation('A1', 'U1', 0, 0, '')
    store.selectCommittedPathForProducer(
      'C1',
      producer,
      { __root__: 'U1' },
      {
        phase: 'open',
        pathHeaders: [user.header],
        presentations: [user],
      },
    )
    const userReceipt = store.getCommittedPathPresentation('C1')
    if (!userReceipt) throw new Error('user receipt missing')

    const navigateSamePath = (patch: CursorMap) =>
      navigationKind === 'cursor replacement'
        ? store.navigateToCursor('C1', {
            ...(store.getCursor('C1') ?? {}),
            ...patch,
          })
        : store.navigateWithCursorPatch('C1', patch)

    const firstNavigation = navigateSamePath({ offPath: 'X1' })
    expect(store.getCommittedPathPresentation('C1')).toMatchObject({
      revision: firstNavigation.revision,
    })
    expect(store.getCommittedPathPresentation('C1')?.pathHeaders.at(-1)?.id).toBe('U1')
    expect(store.getPendingBranchNavigation('C1')).toMatchObject({
      revision: firstNavigation.revision,
    })
    expect(store.getPendingBranchNavigation('C1')?.pathMessageIds.at(-1)).toBe('U1')

    expect(
      store.selectCommittedPathForProducer(
        'C1',
        producer,
        { __root__: 'U1', U1: 'A1' },
        {
          phase: 'open',
          pathHeaders: [user.header, placeholder.header],
          presentations: [user, placeholder],
        },
      ),
    ).toBe(true)
    const placeholderReceipt = store.getCommittedPathPresentation('C1')
    if (!placeholderReceipt) throw new Error('placeholder receipt missing')

    const secondNavigation = navigateSamePath({ anotherOffPath: 'X2' })
    expect(store.getPendingBranchNavigation('C1')).toMatchObject({
      revision: secondNavigation.revision,
      pathMessageIds: ['U1', 'A1'],
    })
    store.acknowledgeCommittedPathPresentation('C1', placeholderReceipt)
    expect(store.getCommittedPathPresentation('C1')).toBeDefined()

    expect(
      store.updateCommittedMessageForProducer(
        'C1',
        producer,
        committedPresentation('A1', 'U1', 1, 1, 'answer'),
        'terminal',
      ),
    ).toBe(true)
    expect(store.getCommittedPathPresentation('C1')).toMatchObject({
      revision: secondNavigation.revision,
      phase: 'terminal',
    })
    expect(store.getCommittedPathPresentation('C1')?.pathHeaders.at(-1)?.id).toBe('A1')

    navigateSamePath({ U1: 'A2' })
    expect(store.getCommittedPathPresentation('C1')).toBeUndefined()
    expect(
      store.updateCommittedMessageForProducer(
        'C1',
        producer,
        committedPresentation('A1', 'U1', 2, 2, 'late'),
        'terminal',
      ),
    ).toBe(false)
  })

  it('carries unresolved committed bodies into the next linear send receipt', () => {
    const store = useChatStore.getState()
    const firstIntent = store.beginNavigationIntent('C1')
    const firstProducer = registerProducer('C1', firstIntent)
    const firstUser = committedPresentation('U1', null, 0, 0, 'first prompt')
    const firstAssistant = committedPresentation('A1', 'U1', 1, 1, 'first answer')
    store.selectCommittedPathForProducer(
      'C1',
      firstProducer,
      { __root__: 'U1', U1: 'A1' },
      {
        phase: 'terminal',
        pathHeaders: [firstUser.header, firstAssistant.header],
        presentations: [firstUser, firstAssistant],
      },
    )
    const firstReceipt = store.getCommittedPathPresentation('C1')
    if (!firstReceipt) throw new Error('first receipt missing')

    const nextIntent = store.beginNavigationIntent('C1')
    const nextProducer = registerProducer('C1', nextIntent)
    const secondUser = committedPresentation('U2', 'A1', 0, 0, 'second prompt')
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        nextProducer,
        { __root__: 'U1', U1: 'A1', A1: 'U2' },
        {
          phase: 'open',
          pathHeaders: [firstUser.header, firstAssistant.header, secondUser.header],
          presentations: [secondUser],
        },
      ),
    ).toBe(true)

    const receipt = store.getCommittedPathPresentation('C1')
    expect(receipt?.pathHeaders.map((header) => header.id)).toEqual(['U1', 'A1', 'U2'])
    expect(receipt?.presentations.map((presentation) => presentation.message.id)).toEqual([
      'U1',
      'A1',
      'U2',
    ])
    expect(
      receipt?.presentations.find((presentation) => presentation.message.id === 'A1')?.message
        .content,
    ).toEqual([{ type: 'output_text', text: 'first answer' }])
    expect(receipt?.presentations[0]).toBe(firstReceipt.presentations[0])
    expect(receipt?.presentations[1]).toBe(firstReceipt.presentations[1])
  })

  it('never carries a receipt body behind a newer committed path version', () => {
    const store = useChatStore.getState()
    const firstIntent = store.beginNavigationIntent('C1')
    const firstProducer = registerProducer('C1', firstIntent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const staleAssistant = committedPresentation('A1', 'U1', 1, 1, 'stale answer')
    store.selectCommittedPathForProducer(
      'C1',
      firstProducer,
      { __root__: 'U1', U1: 'A1' },
      {
        phase: 'terminal',
        pathHeaders: [user.header, staleAssistant.header],
        presentations: [user, staleAssistant],
      },
    )

    const editedAssistant = committedPresentation('A1', 'U1', 2, 2, 'edited answer')
    const nextUser = committedPresentation('U2', 'A1', 0, 0, 'next prompt')
    const nextIntent = store.beginNavigationIntent('C1')
    const nextProducer = registerProducer('C1', nextIntent)
    expect(
      store.selectCommittedPathForProducer(
        'C1',
        nextProducer,
        { __root__: 'U1', U1: 'A1', A1: 'U2' },
        {
          phase: 'open',
          pathHeaders: [user.header, editedAssistant.header, nextUser.header],
          presentations: [nextUser],
        },
      ),
    ).toBe(true)

    const receipt = store.getCommittedPathPresentation('C1')
    expect(receipt?.pathHeaders[1]).toMatchObject({ id: 'A1', bodyVersion: 2, nodeVersion: 2 })
    expect(receipt?.presentations.some((presentation) => presentation.message.id === 'A1')).toBe(
      false,
    )
  })

  it('publishes an ancestor edit without taking ownership from an open generation', () => {
    const store = useChatStore.getState()
    const producerIntent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', producerIntent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const placeholder = committedPresentation('A1', 'U1', 0, 0, '')
    store.selectCommittedPathForProducer(
      'C1',
      producer,
      { __root__: 'U1', U1: 'A1' },
      {
        phase: 'open',
        pathHeaders: [user.header, placeholder.header],
        presentations: [user, placeholder],
      },
    )
    const cursor = store.getCursor('C1')
    const revision = store.getNavigationRevision('C1')
    const editedUser = committedPresentation('U1', null, 1, 1, 'edited prompt')

    expect(
      store.publishCommittedMessageMutation('C1', [user.header, placeholder.header], editedUser),
    ).toBe(true)
    expect(store.getCursor('C1')).toBe(cursor)
    expect(store.getNavigationRevision('C1')).toBe(revision)
    expect(store.getCommittedPathPresentation('C1')?.phase).toBe('open')

    expect(
      store.updateCommittedMessageForProducer(
        'C1',
        producer,
        committedPresentation('A1', 'U1', 1, 1, 'answer'),
        'terminal',
      ),
    ).toBe(true)
    const receipt = store.getCommittedPathPresentation('C1')
    expect(receipt?.phase).toBe('terminal')
    expect(receipt?.pathHeaders.at(-1)?.id).toBe('A1')
    expect(
      receipt?.presentations.find((presentation) => presentation.message.id === 'U1')?.message
        .content,
    ).toEqual([{ type: 'text', text: 'edited prompt' }])
    expect(
      receipt?.presentations.find((presentation) => presentation.message.id === 'A1')?.message
        .content,
    ).toEqual([{ type: 'output_text', text: 'answer' }])
    expect(store.getCursor('C1')).toBe(cursor)
    expect(store.getNavigationRevision('C1')).toBe(revision)
  })

  it('publishes an exact off-path body without steering this tab', () => {
    const store = useChatStore.getState()
    const root = committedPresentation('U1', null, 0, 0, 'prompt')
    const selected = committedPresentation('B1', 'U1', 0, 0, 'selected answer')
    const offPath = committedPresentation('A1', 'U1', 1, 1, 'edited off-path answer')
    const intent = store.navigateToCursor('C1', { __root__: 'U1', U1: 'B1' })
    const cursor = store.getCursor('C1')

    expect(
      store.publishCommittedMessageMutation('C1', [root.header, selected.header], offPath),
    ).toBe(true)
    expect(store.getCursor('C1')).toBe(cursor)
    expect(store.getNavigationRevision('C1')).toBe(intent.revision)
    expect(store.getCommittedPathPresentation('C1')).toBeUndefined()
    expect(store.getCommittedMessagePresentation('C1')).toMatchObject({
      chatId: 'C1',
      presentation: {
        bodyVersion: 1,
        message: { id: 'A1', content: [{ type: 'output_text', text: 'edited off-path answer' }] },
      },
    })
  })

  it('does not let a path-covered publication displace an exact off-path body', () => {
    const store = useChatStore.getState()
    const root = committedPresentation('U1', null, 0, 0, 'prompt')
    const selected = committedPresentation('B1', 'U1', 0, 0, 'selected answer')
    const offPath = committedPresentation('A1', 'U1', 1, 1, 'edited off-path answer')
    store.navigateToCursor('C1', { __root__: 'U1', U1: 'B1' })

    expect(
      store.publishCommittedMessageMutation('C1', [root.header, selected.header], offPath),
    ).toBe(true)
    const exactOffPath = store.getCommittedMessagePresentation('C1')
    const updatedSelected = committedPresentation('B1', 'U1', 1, 1, 'updated selected answer')
    expect(
      store.publishCommittedMessageMutation('C1', [root.header, selected.header], updatedSelected),
    ).toBe(true)

    expect(store.getCommittedMessagePresentation('C1')).toBe(exactOffPath)
    expect(
      store
        .getCommittedPathPresentation('C1')
        ?.presentations.find((presentation) => presentation.message.id === 'B1')?.message.content,
    ).toEqual([{ type: 'output_text', text: 'updated selected answer' }])
  })

  it('retains only the latest exact local body per chat and clears it with chat scope', () => {
    const store = useChatStore.getState()
    const first = committedPresentation('A1', 'U1', 1, 1, 'first body')
    const second = committedPresentation('B1', 'U1', 2, 2, 'second body')
    const other = committedPresentation('A2', 'U2', 1, 1, 'other chat body', 'C2')

    expect(store.publishCommittedMessageMutation('C1', [], first)).toBe(true)
    const firstReceipt = store.getCommittedMessagePresentation('C1')
    expect(firstReceipt?.presentation.message.id).toBe('A1')
    expect(store.publishCommittedMessageMutation('C1', [], second)).toBe(true)
    const secondReceipt = store.getCommittedMessagePresentation('C1')
    expect(secondReceipt?.presentation.message.id).toBe('B1')
    expect(secondReceipt).not.toBe(firstReceipt)
    expect(Object.isFrozen(secondReceipt)).toBe(true)
    expect(Object.isFrozen(secondReceipt?.presentation.message)).toBe(true)

    expect(store.publishCommittedMessageMutation('C2', [], other)).toBe(true)
    store.clearCursor('C1')
    expect(store.getCommittedMessagePresentation('C1')).toBeUndefined()
    expect(store.getCommittedMessagePresentation('C2')?.presentation.message.id).toBe('A2')

    store.resetForWorkspaceReplacement()
    expect(store.getCommittedMessagePresentation('C2')).toBeUndefined()
  })

  it('acknowledges only the exact committed message receipt', () => {
    const store = useChatStore.getState()
    const first = committedPresentation('A1', 'U1', 1, 1, 'first body')
    const second = committedPresentation('A1', 'U1', 2, 2, 'second body')

    expect(store.publishCommittedMessageMutation('C1', [], first)).toBe(true)
    const staleReceipt = store.getCommittedMessagePresentation('C1')
    expect(staleReceipt).toBeDefined()
    expect(store.publishCommittedMessageMutation('C1', [], second)).toBe(true)
    const currentReceipt = store.getCommittedMessagePresentation('C1')
    expect(currentReceipt).toBeDefined()
    if (!staleReceipt || !currentReceipt) throw new Error('expected committed message receipts')

    store.acknowledgeCommittedMessagePresentation('C1', staleReceipt)
    expect(store.getCommittedMessagePresentation('C1')).toBe(currentReceipt)
    store.acknowledgeCommittedMessagePresentation('C1', currentReceipt)
    expect(store.getCommittedMessagePresentation('C1')).toBeUndefined()
  })

  it('bounds exact message receipts across chats without evicting the newest mutation', () => {
    const store = useChatStore.getState()
    for (let index = 0; index < 10; index += 1) {
      const chatId = `receipt-chat-${index}`
      const presentation = committedPresentation(
        `receipt-message-${index}`,
        null,
        index,
        index,
        `body ${index}`,
        chatId,
      )
      expect(store.publishCommittedMessageMutation(chatId, [], presentation)).toBe(true)
    }

    expect(store.getCommittedMessagePresentation('receipt-chat-0')).toBeUndefined()
    expect(store.getCommittedMessagePresentation('receipt-chat-1')).toBeUndefined()
    for (let index = 2; index < 10; index += 1) {
      expect(store.getCommittedMessagePresentation(`receipt-chat-${index}`)).toBeDefined()
    }
    expect(store.getCommittedMessagePresentation('receipt-chat-9')?.presentation.message.id).toBe(
      'receipt-message-9',
    )
  })

  it('protects the focused chat from bounded body eviction with identity-safe cleanup', () => {
    const store = useChatStore.getState()
    const staleFocus = store.beginCommittedPresentationFocus('stale-focus-chat')
    const focusedChatId = 'receipt-chat-0'
    const currentFocus = store.beginCommittedPresentationFocus(focusedChatId)
    store.endCommittedPresentationFocus(staleFocus)

    for (let index = 0; index < 10; index += 1) {
      const chatId = `receipt-chat-${index}`
      expect(
        store.publishCommittedMessageMutation(
          chatId,
          [],
          committedPresentation(
            `receipt-message-${index}`,
            null,
            index,
            index,
            `body ${index}`,
            chatId,
          ),
        ),
      ).toBe(true)
    }

    expect(store.getCommittedMessagePresentation(focusedChatId)).toBeDefined()
    expect(store.getCommittedMessagePresentation('receipt-chat-1')).toBeUndefined()
    expect(store.getCommittedMessagePresentation('receipt-chat-2')).toBeUndefined()
    for (let index = 3; index < 10; index += 1) {
      expect(store.getCommittedMessagePresentation(`receipt-chat-${index}`)).toBeDefined()
    }
    store.endCommittedPresentationFocus(currentFocus)
  })

  it('globally bounds terminal path receipts once their durable fallback is sufficient', () => {
    const store = useChatStore.getState()
    for (let index = 0; index < 10; index += 1) {
      const chatId = `path-receipt-chat-${index}`
      const message = committedPresentation(
        `path-receipt-message-${index}`,
        null,
        index,
        index,
        `body ${index}`,
        chatId,
      )
      const intent = store.beginNavigationIntent(chatId)
      const producer = registerProducer(chatId, intent)
      expect(
        store.selectCommittedPathForProducer(
          chatId,
          producer,
          { __root__: message.message.id },
          {
            phase: 'terminal',
            pathHeaders: [message.header],
            presentations: [message],
          },
        ),
      ).toBe(true)
    }

    for (let index = 0; index < 2; index += 1) {
      expect(store.getCommittedPathPresentation(`path-receipt-chat-${index}`)).toBeUndefined()
    }
    for (let index = 2; index < 10; index += 1) {
      expect(
        store.getCommittedPathPresentation(`path-receipt-chat-${index}`)?.presentations,
      ).toHaveLength(1)
    }
  })

  it('keeps lightweight authority but evicts bodies for open background producers', () => {
    const store = useChatStore.getState()
    const producers: CommittedPathProducer[] = []
    for (let index = 0; index < 10; index += 1) {
      const chatId = `open-path-receipt-chat-${index}`
      const message = committedPresentation(
        `open-path-receipt-message-${index}`,
        null,
        index,
        index,
        `body ${index}`,
        chatId,
      )
      const intent = store.beginNavigationIntent(chatId)
      const producer = registerProducer(chatId, intent)
      producers.push(producer)
      expect(
        store.selectCommittedPathForProducer(
          chatId,
          producer,
          { __root__: message.message.id },
          {
            phase: 'open',
            pathHeaders: [message.header],
            presentations: [message],
          },
        ),
      ).toBe(true)
    }

    for (let index = 0; index < 2; index += 1) {
      const receipt = store.getCommittedPathPresentation(`open-path-receipt-chat-${index}`)
      expect(receipt?.pathHeaders).toHaveLength(1)
      expect(receipt?.presentations).toHaveLength(0)
    }
    const evictedProducer = producers[0]
    if (!evictedProducer) throw new Error('evicted producer missing')
    expect(store.sealCommittedPathProducer('open-path-receipt-chat-0', evictedProducer)).toBe(true)
    expect(store.getCommittedPathPresentation('open-path-receipt-chat-0')).toBeUndefined()
  })

  it('bounds unresolved bodies to the tab-local active render window', () => {
    const store = useChatStore.getState()
    store.setCommittedPresentationWindowLimit('C1', 4)
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const presentations = Array.from({ length: 6 }, (_, index) =>
      committedPresentation(
        `M${index}`,
        index === 0 ? null : `M${index - 1}`,
        0,
        0,
        `message ${index}`,
      ),
    )
    const selections = Object.fromEntries(
      presentations.map((presentation) => [
        presentation.header.parentId ?? '__root__',
        presentation.header.id,
      ]),
    )

    expect(
      store.selectCommittedPathForProducer('C1', producer, selections, {
        phase: 'terminal',
        pathHeaders: presentations.map((presentation) => presentation.header),
        presentations,
      }),
    ).toBe(true)

    expect(store.getCommittedPathPresentation('C1')?.pathHeaders).toHaveLength(6)
    expect(store.getCommittedPathPresentation('C1')?.presentations).toHaveLength(4)
    expect(store.getCommittedPathPresentation('C1')?.presentations[0]?.message.id).toBe('M2')

    store.setCommittedPresentationWindowLimit('C1', 2)
    const receipt = store.getCommittedPathPresentation('C1')
    expect(receipt?.pathHeaders).toHaveLength(6)
    expect(receipt?.presentations).toHaveLength(2)
    expect(receipt?.presentations[0]?.message.id).toBe('M4')
    expect(receipt?.presentations.at(-1)?.message.id).toBe('M5')
  })

  it('retains a background chat receipt and producer while another chat owns navigation', () => {
    const store = useChatStore.getState()
    const producerIntent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', producerIntent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    store.selectCommittedPathForProducer(
      'C1',
      producer,
      { __root__: 'U1' },
      {
        phase: 'open',
        pathHeaders: [user.header],
        presentations: [user],
      },
    )

    const otherIntent = store.beginNavigationIntent('C2')
    const otherProducer = registerProducer('C2', otherIntent)
    const otherUser = committedPresentation('U2', null, 0, 0, 'other prompt', 'C2')
    store.selectCommittedPathForProducer(
      'C2',
      otherProducer,
      { __root__: 'U2' },
      {
        phase: 'open',
        pathHeaders: [otherUser.header],
        presentations: [otherUser],
      },
    )

    expect(store.getCommittedPathPresentation('C1')?.phase).toBe('open')
    expect(store.getCommittedPathPresentation('C1')?.pathHeaders.at(-1)?.id).toBe('U1')
    expect(
      store.updateCommittedMessageForProducer(
        'C1',
        producer,
        committedPresentation('U1', null, 1, 1, 'background answer'),
        'terminal',
      ),
    ).toBe(true)
    const otherReceipt = store.getCommittedPathPresentation('C2')
    expect(otherReceipt?.phase).toBe('open')
    expect(otherReceipt?.pathHeaders.at(-1)?.id).toBe('U2')

    const returnedIntent = store.beginNavigationIntent('C1')
    const returnedReceipt = store.getCommittedPathPresentation('C1')
    expect(returnedReceipt).toMatchObject({
      revision: returnedIntent.revision,
      phase: 'terminal',
    })
    expect(returnedReceipt?.pathHeaders.at(-1)?.id).toBe('U1')
    expect(returnedReceipt?.presentations[0]?.message.content).toEqual([
      { type: 'text', text: 'background answer' },
    ])
    expect(store.getCommittedPathPresentation('C2')).toBe(otherReceipt)

    if (!returnedReceipt) throw new Error('returned receipt missing')
    store.acknowledgeCommittedPathPresentation('C1', returnedReceipt)
    store.beginNavigationIntent('C2')
    expect(store.getCommittedPathPresentation('C2')).toMatchObject({
      phase: otherReceipt?.phase,
      pathHeaders: otherReceipt?.pathHeaders,
      presentations: otherReceipt?.presentations,
    })
    expect(store.getCommittedPathPresentation('C1')).toBeUndefined()
  })

  it('keeps a terminal receipt exact across a different-chat visit within its body window', () => {
    const store = useChatStore.getState()
    store.setCommittedPresentationWindowLimit('C1', 1)
    const intent = store.beginNavigationIntent('C1')
    const producer = registerProducer('C1', intent)
    const user = committedPresentation('U1', null, 0, 0, 'prompt')
    const assistant = committedPresentation('A1', 'U1', 1, 1, 'answer')
    store.selectCommittedPathForProducer(
      'C1',
      producer,
      { __root__: 'U1', U1: 'A1' },
      {
        phase: 'terminal',
        pathHeaders: [user.header, assistant.header],
        presentations: [user, assistant],
      },
    )

    store.beginNavigationIntent('C2')
    expect(store.getCommittedPathPresentation('C1')).toBeDefined()

    store.beginNavigationIntent('C1')
    const receipt = store.getCommittedPathPresentation('C1')
    expect(receipt?.pathHeaders.map((header) => header.id)).toEqual(['U1', 'A1'])
    expect(receipt?.presentations.map((presentation) => presentation.message.id)).toEqual(['A1'])
    expect(receipt?.presentations[0]?.message.content).toEqual([
      { type: 'output_text', text: 'answer' },
    ])
  })
})

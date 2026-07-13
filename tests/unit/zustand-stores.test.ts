import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../src/store/zustand/chatStore'
import { useStreamStore } from '../../src/store/zustand/streamStore'
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
      chatId: 'C1',
      messageId: 'M1',
      startedAt: 1,
      ownerClientId: 'tab-a',
    })
    setActive({
      streamId: 'S2',
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
      chatId: 'C1',
      startedAt: 1,
      ownerClientId: 'tab-a',
    })
    setActive({
      streamId: 'S2',
      chatId: 'C2',
      startedAt: 2,
      ownerClientId: 'tab-a',
    })
    clearActive('S1')
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
      chatId: 'C1',
      startedAt: 1,
      ownerClientId: 'tab-a',
      abort: abortA,
    })
    setActive({
      streamId: 'S2',
      chatId: 'C1',
      startedAt: 2,
      ownerClientId: 'tab-a',
      abort: abortB,
    })
    setActive({
      streamId: 'S3',
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
  it('setCursor stores an immutable copy (caller mutation does not bleed in)', () => {
    const { setCursor, getCursor } = useChatStore.getState()
    const map = { __root__: 'M1' }
    setCursor('C1', map)
    map.__root__ = 'MUTATED'
    expect(getCursor('C1')).toEqual({ __root__: 'M1' })
  })

  it('patchCursor merges into the existing map', () => {
    const { setCursor, patchCursor, getCursor } = useChatStore.getState()
    setCursor('C1', { __root__: 'M1' })
    patchCursor('C1', 'M1', 'M2')
    expect(getCursor('C1')).toEqual({ __root__: 'M1', M1: 'M2' })
  })

  it('patchCursor on an unseen chat creates a new map', () => {
    const { patchCursor, getCursor } = useChatStore.getState()
    patchCursor('Cnew', '__root__', 'M1')
    expect(getCursor('Cnew')).toEqual({ __root__: 'M1' })
  })

  it('clearCursor removes only the targeted chat', () => {
    const { setCursor, clearCursor, getCursor } = useChatStore.getState()
    setCursor('C1', { __root__: 'M1' })
    setCursor('C2', { __root__: 'M9' })
    clearCursor('C1')
    expect(getCursor('C1')).toBeUndefined()
    expect(getCursor('C2')).toEqual({ __root__: 'M9' })
  })
})

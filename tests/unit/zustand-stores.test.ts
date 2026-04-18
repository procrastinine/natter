import { describe, expect, it, beforeEach } from 'vitest'
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
      textLen: 0,
    })
    expect(isActive('S1')).toBe(true)
    expect(getActive('S1')?.streamId).toBe('S1')
    expect(listByChat('C1').map((stream) => stream.streamId)).toEqual(['S1'])
  })

  it('updateTextLen is a no-op when no stream is active for that id', () => {
    const { updateTextLen, getActive } = useStreamStore.getState()
    updateTextLen('ghost', 99)
    expect(getActive('ghost')).toBeUndefined()
  })

  it('supports multiple same-chat streams keyed independently', () => {
    const { setActive, updateTextLen, getActive, isTargetActive } = useStreamStore.getState()
    setActive({
      streamId: 'S1',
      chatId: 'C1',
      messageId: 'M1',
      startedAt: 1,
      ownerClientId: 'tab-a',
      textLen: 0,
    })
    setActive({
      streamId: 'S2',
      chatId: 'C1',
      messageId: 'M2',
      startedAt: 2,
      ownerClientId: 'tab-a',
      textLen: 0,
    })
    updateTextLen('S1', 128)
    expect(getActive('S1')?.textLen).toBe(128)
    expect(getActive('S2')?.textLen).toBe(0)
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
      textLen: 0,
    })
    setActive({
      streamId: 'S2',
      chatId: 'C2',
      startedAt: 2,
      ownerClientId: 'tab-a',
      textLen: 0,
    })
    clearActive('S1')
    expect(isActive('S1')).toBe(false)
    expect(isActive('S2')).toBe(true)
  })
})

describe('uiStore', () => {
  it('starts with system theme, sidebar open, no active chat', () => {
    const state = useUiStore.getState()
    expect(state.theme).toBe('system')
    expect(state.sidebarCollapsed).toBe(false)
    expect(state.activeChatId).toBeNull()
    expect(state.composerFullscreen).toBe(false)
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

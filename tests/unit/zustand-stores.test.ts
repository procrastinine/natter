import { beforeEach, describe, expect, it } from 'vitest'
import { useUiStore } from '../../src/store/zustand/uiStore'

beforeEach(() => {
  useUiStore.getState().reset()
})

describe('ui store', () => {
  it('starts with every ephemeral conversation control inactive', () => {
    expect(useUiStore.getState()).toMatchObject({
      editTreeMode: false,
      treeExpanded: false,
      cascadeDelete: false,
      focusMode: false,
      zeroEligibleChatId: null,
    })
  })

  it('updates independent tab-local controls without persisting conversation authority', () => {
    const state = useUiStore.getState()
    state.setEditTreeMode(true)
    state.setTreeExpanded(true)
    state.setCascadeDelete(true)
    state.setFocusMode(true)
    state.setZeroEligibleChatId('chat-a')

    expect(useUiStore.getState()).toMatchObject({
      editTreeMode: true,
      treeExpanded: true,
      cascadeDelete: true,
      focusMode: true,
      zeroEligibleChatId: 'chat-a',
    })
  })

  it('clears cascade deletion with edit-tree mode and resets the whole ephemeral slice', () => {
    const state = useUiStore.getState()
    state.setEditTreeMode(true)
    state.setCascadeDelete(true)
    state.setEditTreeMode(false)
    expect(useUiStore.getState().cascadeDelete).toBe(false)

    state.setTreeExpanded(true)
    state.setFocusMode(true)
    state.reset()
    expect(useUiStore.getState()).toMatchObject({
      editTreeMode: false,
      treeExpanded: false,
      cascadeDelete: false,
      focusMode: false,
      zeroEligibleChatId: null,
    })
  })
})

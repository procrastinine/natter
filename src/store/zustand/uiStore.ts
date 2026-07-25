// Ephemeral UI state. Per-tab only — not persisted to IDB and not broadcast.
//
import { create } from 'zustand'
import type { ChatId } from '../../core/types'

interface UiStoreState {
  // Edit-tree mode applies globally across open chats
  // because the user's mental model is "editing the structure of the
  // current conversation"; switching chats re-uses the same mode.
  editTreeMode: boolean
  // Tree density is a per-tab viewing preference, never chat data.
  treeExpanded: boolean
  // Cascade-delete checkbox state inside Edit-tree toolbar. UI-local; resets
  // whenever the mode toggles off per §10.6.1.
  cascadeDelete: boolean
  // "Reading mode" — hides every piece of UI chrome (sidebar, headers,
  // composer, jump-to-latest) so only the message list + a small
  // re-entry toggle remain visible. Toggled via the floating eye icon
  // at the bottom-left of the viewport.
  focusMode: boolean
  // Chat id whose privacy filter left zero eligible providers; triggers
  // the zero-eligible modal per §10.13.1. Cleared by any of the three
  // quick-fix actions (switch model / disable Pareto / allow fallbacks)
  // or by explicit dismiss. Only the chat id is stored, the modal reads
  // the live `usePrivacyRouting` result so it shows the current filter
  // decision, not a stale snapshot.
  zeroEligibleChatId: ChatId | null
  setEditTreeMode: (on: boolean) => void
  setTreeExpanded: (expanded: boolean) => void
  setCascadeDelete: (on: boolean) => void
  setFocusMode: (on: boolean) => void
  setZeroEligibleChatId: (chatId: ChatId | null) => void
  reset: () => void
}

const INITIAL: Pick<
  UiStoreState,
  'editTreeMode' | 'treeExpanded' | 'cascadeDelete' | 'focusMode' | 'zeroEligibleChatId'
> = {
  editTreeMode: false,
  treeExpanded: false,
  cascadeDelete: false,
  focusMode: false,
  zeroEligibleChatId: null,
}

export const useUiStore = create<UiStoreState>((set) => ({
  ...INITIAL,
  setEditTreeMode: (on) =>
    set((state) => ({
      editTreeMode: on,
      // Exiting edit-tree mode always clears cascade (§10.6.1 "resets when the mode is toggled off").
      cascadeDelete: on ? state.cascadeDelete : false,
    })),
  setTreeExpanded: (treeExpanded) => set({ treeExpanded }),
  setCascadeDelete: (on) => set({ cascadeDelete: on }),
  setFocusMode: (on) => set({ focusMode: on }),
  setZeroEligibleChatId: (zeroEligibleChatId) => set({ zeroEligibleChatId }),
  reset: () => set(INITIAL),
}))

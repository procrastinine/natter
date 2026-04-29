// Per-tab ephemeral chat state. Holds the active-path cursor map for each chat
// the user has opened in this tab. Navigation-only mutations (swipes, search
// clicks, deep-links) write here and NEVER touch IDB — see `plan/02-data-model.md
// §2.1 comment` and `plan/08-branching.md §8.3`.
//
// A missing entry means "no cursor recorded for this chat in this tab" — the
// active-path resolver falls back to the plan's highest-priority defaults.

import { create } from 'zustand'
import type { ChatId, CursorMap, MessageId } from '../../core/types'

interface ChatStoreState {
  cursors: Record<ChatId, CursorMap>
  getCursor: (chatId: ChatId) => CursorMap | undefined
  setCursor: (chatId: ChatId, cursor: CursorMap) => void
  patchCursor: (chatId: ChatId, parentKey: string, childId: MessageId) => void
  clearCursor: (chatId: ChatId) => void
  reset: () => void
}

export const useChatStore = create<ChatStoreState>((set, get) => ({
  cursors: {},
  getCursor: (chatId) => get().cursors[chatId],
  setCursor: (chatId, cursor) =>
    set((state) => ({ cursors: { ...state.cursors, [chatId]: { ...cursor } } })),
  patchCursor: (chatId, parentKey, childId) =>
    set((state) => {
      const existing = state.cursors[chatId] ?? {}
      return {
        cursors: {
          ...state.cursors,
          [chatId]: { ...existing, [parentKey]: childId },
        },
      }
    }),
  clearCursor: (chatId) =>
    set((state) => {
      if (!(chatId in state.cursors)) return state
      const next = { ...state.cursors }
      delete next[chatId]
      return { cursors: next }
    }),
  reset: () => set({ cursors: {} }),
}))

// Per-tab ephemeral state for active streams. See `plan/03-storage.md §3.10` and
// `plan/06-streaming.md §6.2`.
//
// Owns the `chatId → ActiveStream` map so `withChatLock`-adjacent code can
// ask "is this chat currently streaming in this tab?" without racing against
// IDB writes. The map never crosses tabs — each tab runs its own stream, and
// cross-tab awareness goes through BroadcastChannel (`stream-started` /
// `stream-ended`) to the appropriate UI slices.

import { create } from 'zustand'
import type { ChatId, MessageId } from '../../core/types'

export interface ActiveStream {
  streamId: string
  chatId: ChatId
  messageId?: MessageId
  startedAt: number
  ownerClientId: string
  textLen: number
}

export interface StreamStoreState {
  activeByChatId: Record<ChatId, ActiveStream>
  isActive: (chatId: ChatId) => boolean
  getActive: (chatId: ChatId) => ActiveStream | undefined
  setActive: (stream: ActiveStream) => void
  updateTextLen: (chatId: ChatId, textLen: number) => void
  clearActive: (chatId: ChatId) => void
  reset: () => void
}

export const useStreamStore = create<StreamStoreState>((set, get) => ({
  activeByChatId: {},
  isActive: (chatId) => get().activeByChatId[chatId] !== undefined,
  getActive: (chatId) => get().activeByChatId[chatId],
  setActive: (stream) =>
    set((state) => ({
      activeByChatId: { ...state.activeByChatId, [stream.chatId]: stream },
    })),
  updateTextLen: (chatId, textLen) =>
    set((state) => {
      const existing = state.activeByChatId[chatId]
      if (!existing) return state
      return {
        activeByChatId: {
          ...state.activeByChatId,
          [chatId]: { ...existing, textLen },
        },
      }
    }),
  clearActive: (chatId) =>
    set((state) => {
      if (!(chatId in state.activeByChatId)) return state
      const next = { ...state.activeByChatId }
      delete next[chatId]
      return { activeByChatId: next }
    }),
  reset: () => set({ activeByChatId: {} }),
}))

// Per-tab ephemeral state for active streams. See `plan/03-storage.md §3.10` and
// `plan/06-streaming.md §6.2`.
//
// Streams are keyed by `streamId`, not `chatId`, so one chat can host multiple
// concurrent same-tab streams as long as they target different output rows.

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
  activeByStreamId: Record<string, ActiveStream>
  isActive: (streamId: string) => boolean
  isTargetActive: (chatId: ChatId, messageId?: MessageId) => boolean
  // Short-circuiting membership test for "is ANY stream running for this
  // chat?". Used on the hot path (Shell re-renders on every stream token
  // update) so we avoid allocating an array via `Object.values()` — the
  // allocation is discarded immediately and adds GC pressure.
  hasStreamForChat: (chatId: ChatId) => boolean
  getActive: (streamId: string) => ActiveStream | undefined
  listByChat: (chatId: ChatId) => ActiveStream[]
  setActive: (stream: ActiveStream) => void
  updateTextLen: (streamId: string, textLen: number) => void
  clearActive: (streamId: string) => void
  reset: () => void
}

export const useStreamStore = create<StreamStoreState>((set, get) => ({
  activeByStreamId: {},
  isActive: (streamId) => get().activeByStreamId[streamId] !== undefined,
  isTargetActive: (chatId, messageId) => {
    const map = get().activeByStreamId
    for (const id in map) {
      const stream = map[id]!
      if (stream.chatId === chatId && stream.messageId === messageId) return true
    }
    return false
  },
  hasStreamForChat: (chatId) => {
    const map = get().activeByStreamId
    for (const id in map) {
      if (map[id]!.chatId === chatId) return true
    }
    return false
  },
  getActive: (streamId) => get().activeByStreamId[streamId],
  listByChat: (chatId) =>
    Object.values(get().activeByStreamId).filter((stream) => stream.chatId === chatId),
  setActive: (stream) =>
    set((state) => ({
      activeByStreamId: { ...state.activeByStreamId, [stream.streamId]: stream },
    })),
  updateTextLen: (streamId, textLen) =>
    set((state) => {
      const existing = state.activeByStreamId[streamId]
      if (!existing) return state
      return {
        activeByStreamId: {
          ...state.activeByStreamId,
          [streamId]: { ...existing, textLen },
        },
      }
    }),
  clearActive: (streamId) =>
    set((state) => {
      if (!(streamId in state.activeByStreamId)) return state
      const next = { ...state.activeByStreamId }
      delete next[streamId]
      return { activeByStreamId: next }
    }),
  reset: () => set({ activeByStreamId: {} }),
}))

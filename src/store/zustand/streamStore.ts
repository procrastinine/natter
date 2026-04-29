// Per-tab ephemeral state for active streams. See `plan/03-storage.md §3.10` and
// `plan/06-streaming.md §6.2`.
//
// Streams are keyed by `streamId`, not `chatId`, so one chat can host multiple
// concurrent same-tab streams as long as they target different output rows.

import { create } from 'zustand'
import type {
  ChatId,
  ContentItem,
  GenerationMeta,
  MessageId,
  ReasoningDetail,
} from '../../core/types'

export interface ActiveStream {
  streamId: string
  chatId: ChatId
  messageId?: MessageId
  startedAt: number
  heartbeatAt?: number
  ownerClientId: string
  abort?: () => void
}

export interface LiveStreamSnapshot {
  streamId: string
  chatId: ChatId
  messageId: MessageId
  content: ContentItem[]
  reasoningDetails?: ReasoningDetail[]
  generation?: GenerationMeta
  textLength: number
  reasoningLength: number
  updatedAt: number
}

export interface StreamStoreState {
  activeByStreamId: Record<string, ActiveStream>
  liveByMessageId: Record<string, LiveStreamSnapshot>
  isActive: (streamId: string) => boolean
  isTargetActive: (chatId: ChatId, messageId?: MessageId) => boolean
  getTargetActive: (chatId: ChatId, messageId?: MessageId) => ActiveStream | undefined
  // Short-circuiting membership test for "is ANY stream running for this
  // chat?". Used on the hot path (Shell re-renders on every stream token
  // update) so allocating an array via `Object.values()` is avoided, the
  // allocation would be discarded immediately and add GC pressure.
  hasStreamForChat: (chatId: ChatId) => boolean
  getActive: (streamId: string) => ActiveStream | undefined
  listByChat: (chatId: ChatId) => ActiveStream[]
  setActive: (stream: ActiveStream) => void
  setLiveSnapshot: (snapshot: LiveStreamSnapshot) => void
  abortStream: (streamId: string) => boolean
  abortChat: (chatId: ChatId) => number
  clearActive: (streamId: string) => void
  clearLiveSnapshot: (messageId: MessageId) => void
  reset: () => void
}

export const useStreamStore = create<StreamStoreState>((set, get) => ({
  activeByStreamId: {},
  liveByMessageId: {},
  isActive: (streamId) => get().activeByStreamId[streamId] !== undefined,
  isTargetActive: (chatId, messageId) => {
    return get().getTargetActive(chatId, messageId) !== undefined
  },
  getTargetActive: (chatId, messageId) => {
    const map = get().activeByStreamId
    for (const id in map) {
      const stream = map[id]
      if (!stream) continue
      if (stream.chatId === chatId && stream.messageId === messageId) return stream
    }
    return undefined
  },
  hasStreamForChat: (chatId) => {
    const map = get().activeByStreamId
    for (const id in map) {
      if (map[id]?.chatId === chatId) return true
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
  setLiveSnapshot: (snapshot) =>
    set((state) => ({
      liveByMessageId: { ...state.liveByMessageId, [snapshot.messageId]: snapshot },
    })),
  abortStream: (streamId) => {
    const abort = get().activeByStreamId[streamId]?.abort
    if (!abort) return false
    abort()
    return true
  },
  abortChat: (chatId) => {
    let count = 0
    const map = get().activeByStreamId
    for (const id in map) {
      const stream = map[id]
      if (!stream || stream.chatId !== chatId || !stream.abort) continue
      stream.abort()
      count += 1
    }
    return count
  },
  clearActive: (streamId) =>
    set((state) => {
      if (!(streamId in state.activeByStreamId)) return state
      const next = { ...state.activeByStreamId }
      delete next[streamId]
      return { activeByStreamId: next }
    }),
  clearLiveSnapshot: (messageId) =>
    set((state) => {
      if (!(messageId in state.liveByMessageId)) return state
      const next = { ...state.liveByMessageId }
      delete next[messageId]
      return { liveByMessageId: next }
    }),
  reset: () => set({ activeByStreamId: {}, liveByMessageId: {} }),
}))

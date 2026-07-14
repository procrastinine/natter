import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { create } from 'zustand'
import type {
  StreamAccumulatorLiveReasoningRow,
  StreamAccumulatorLiveToolCallRow,
} from '../../core/stream-accumulator'
import type { ChatId, ContentItem, GenerationMeta, MessageId } from '../../core/types'

export interface ActiveStream {
  streamId: string
  chatId: ChatId
  messageId?: MessageId
  replacementEpoch: number
  startedAt: number
  heartbeatAt?: number
  ownerClientId: string
  abort?: () => void
}

export interface LiveStreamSnapshot {
  streamId: string
  chatId: ChatId
  messageId: MessageId
  replacementEpoch: number
  content: ContentItem[]
  reasoningRows?: StreamAccumulatorLiveReasoningRow[]
  toolCallRows?: StreamAccumulatorLiveToolCallRow[]
  generation?: GenerationMeta
  textLength: number
  reasoningLength: number
  updatedAt: number
}

export interface StreamTargetSnapshot {
  activeStream: ActiveStream | undefined
  liveSnapshot: LiveStreamSnapshot | undefined
}

interface StreamStoreState {
  replacementEpoch: number | null
  lifecycleRevision: number
  isActive: (streamId: string) => boolean
  isTargetActive: (chatId: ChatId, messageId?: MessageId) => boolean
  getTargetActive: (chatId: ChatId, messageId?: MessageId) => ActiveStream | undefined
  hasStreamForChat: (chatId: ChatId) => boolean
  getActive: (streamId: string) => ActiveStream | undefined
  getLiveSnapshot: (chatId: ChatId, messageId: MessageId) => LiveStreamSnapshot | undefined
  getLiveSnapshotByStreamId: (streamId: string) => LiveStreamSnapshot | undefined
  listActive: () => ActiveStream[]
  listLiveSnapshots: () => LiveStreamSnapshot[]
  listByChat: (chatId: ChatId) => ActiveStream[]
  listStreamIds: () => string[]
  setActive: (stream: ActiveStream) => void
  setLiveSnapshot: (snapshot: LiveStreamSnapshot) => void
  abortStream: (streamId: string, replacementEpoch: number) => boolean
  abortChat: (chatId: ChatId) => number
  clearActive: (streamId: string, replacementEpoch: number) => void
  clearLiveSnapshot: (
    messageId: MessageId,
    expectedStreamId: string,
    replacementEpoch: number,
  ) => void
  replaceWorkspace: (replacementEpoch: number) => void
  reset: () => void
}

const activeByStreamId = new Map<string, ActiveStream>()
const activeStreamIdsByTarget = new Map<string, Set<string>>()
const activeStreamIdsByChat = new Map<ChatId, Set<string>>()
const liveByTarget = new Map<string, LiveStreamSnapshot>()
const liveTargetByStreamId = new Map<string, string>()
const targetSnapshotByKey = new Map<string, StreamTargetSnapshot>()
const targetListeners = new Map<string, Set<() => void>>()
const chatListeners = new Map<ChatId, Set<() => void>>()
const chatLifecycleRevision = new Map<ChatId, number>()
let chatLifecycleSequence = 0
const EMPTY_TARGET_SNAPSHOT: StreamTargetSnapshot = {
  activeStream: undefined,
  liveSnapshot: undefined,
}
const EMPTY_STREAMS: ActiveStream[] = []

function targetKey(chatId: ChatId, messageId?: MessageId): string {
  return `${chatId}\u0000${messageId ?? ''}`
}

function firstActiveForTarget(key: string): ActiveStream | undefined {
  const ids = activeStreamIdsByTarget.get(key)
  if (!ids) return undefined
  for (const streamId of ids) {
    const stream = activeByStreamId.get(streamId)
    if (stream) return stream
  }
  return undefined
}

function refreshTargetSnapshot(key: string): void {
  const activeStream = firstActiveForTarget(key)
  const liveSnapshot = liveByTarget.get(key)
  const previous = targetSnapshotByKey.get(key)
  if (previous?.activeStream === activeStream && previous?.liveSnapshot === liveSnapshot) return
  if (activeStream === undefined && liveSnapshot === undefined) {
    targetSnapshotByKey.delete(key)
  } else {
    targetSnapshotByKey.set(key, { activeStream, liveSnapshot })
  }
}

function notifyTarget(key: string): void {
  refreshTargetSnapshot(key)
  const listeners = targetListeners.get(key)
  if (!listeners) return
  for (const listener of [...listeners]) listener()
}

function notifyChat(chatId: ChatId): void {
  chatLifecycleSequence += 1
  chatLifecycleRevision.set(chatId, chatLifecycleSequence)
  const listeners = chatListeners.get(chatId)
  if (!listeners) return
  for (const listener of [...listeners]) listener()
}

function addIndex(index: Map<string, Set<string>>, key: string, streamId: string): void {
  const current = index.get(key)
  if (current) {
    current.add(streamId)
  } else {
    index.set(key, new Set([streamId]))
  }
}

function removeIndex(index: Map<string, Set<string>>, key: string, streamId: string): void {
  const current = index.get(key)
  if (!current) return
  current.delete(streamId)
  if (current.size === 0) index.delete(key)
}

function removeActiveIndexes(stream: ActiveStream): void {
  removeIndex(activeStreamIdsByChat, stream.chatId, stream.streamId)
  removeIndex(activeStreamIdsByTarget, targetKey(stream.chatId, stream.messageId), stream.streamId)
}

function addActiveIndexes(stream: ActiveStream): void {
  addIndex(activeStreamIdsByChat, stream.chatId, stream.streamId)
  addIndex(activeStreamIdsByTarget, targetKey(stream.chatId, stream.messageId), stream.streamId)
}

function listByChat(chatId: ChatId): ActiveStream[] {
  const ids = activeStreamIdsByChat.get(chatId)
  if (!ids) return []
  const streams: ActiveStream[] = []
  for (const streamId of ids) {
    const stream = activeByStreamId.get(streamId)
    if (stream) streams.push(stream)
  }
  return streams
}

function bumpLifecycleState(
  set: (partial: Partial<StreamStoreState>) => void,
  replacementEpoch?: number | null,
): void {
  const state = useStreamStore.getState()
  set({
    lifecycleRevision: state.lifecycleRevision + 1,
    ...(replacementEpoch !== undefined ? { replacementEpoch } : {}),
  })
}

export const useStreamStore = create<StreamStoreState>((set, get) => ({
  replacementEpoch: null,
  lifecycleRevision: 0,
  isActive: (streamId) => activeByStreamId.has(streamId),
  isTargetActive: (chatId, messageId) =>
    firstActiveForTarget(targetKey(chatId, messageId)) !== undefined,
  getTargetActive: (chatId, messageId) => firstActiveForTarget(targetKey(chatId, messageId)),
  hasStreamForChat: (chatId) => (activeStreamIdsByChat.get(chatId)?.size ?? 0) > 0,
  getActive: (streamId) => activeByStreamId.get(streamId),
  getLiveSnapshot: (chatId, messageId) => liveByTarget.get(targetKey(chatId, messageId)),
  getLiveSnapshotByStreamId: (streamId) => {
    const key = liveTargetByStreamId.get(streamId)
    return key ? liveByTarget.get(key) : undefined
  },
  listActive: () => [...activeByStreamId.values()],
  listLiveSnapshots: () => [...liveByTarget.values()],
  listByChat,
  listStreamIds: () => [...activeByStreamId.keys()],
  setActive: (stream) => {
    const state = get()
    if (state.replacementEpoch !== null && state.replacementEpoch !== stream.replacementEpoch)
      return
    const previous = activeByStreamId.get(stream.streamId)
    const previousTarget = previous ? targetKey(previous.chatId, previous.messageId) : null
    if (previous) removeActiveIndexes(previous)
    activeByStreamId.set(stream.streamId, stream)
    addActiveIndexes(stream)
    const nextTarget = targetKey(stream.chatId, stream.messageId)
    bumpLifecycleState(set, stream.replacementEpoch)
    if (previousTarget && previousTarget !== nextTarget) notifyTarget(previousTarget)
    notifyTarget(nextTarget)
    if (previous && previous.chatId !== stream.chatId) notifyChat(previous.chatId)
    notifyChat(stream.chatId)
  },
  setLiveSnapshot: (snapshot) => {
    if (get().replacementEpoch !== snapshot.replacementEpoch) return
    const nextTarget = targetKey(snapshot.chatId, snapshot.messageId)
    const previousTarget = liveTargetByStreamId.get(snapshot.streamId)
    if (previousTarget && previousTarget !== nextTarget) {
      const previous = liveByTarget.get(previousTarget)
      if (previous?.streamId === snapshot.streamId) {
        liveByTarget.delete(previousTarget)
        notifyTarget(previousTarget)
      }
    }
    const displaced = liveByTarget.get(nextTarget)
    if (displaced && displaced.streamId !== snapshot.streamId) {
      liveTargetByStreamId.delete(displaced.streamId)
    }
    liveByTarget.set(nextTarget, snapshot)
    liveTargetByStreamId.set(snapshot.streamId, nextTarget)
    notifyTarget(nextTarget)
  },
  abortStream: (streamId, replacementEpoch) => {
    const stream = activeByStreamId.get(streamId)
    if (stream?.replacementEpoch !== replacementEpoch || !stream.abort) return false
    stream.abort()
    return true
  },
  abortChat: (chatId) => {
    let count = 0
    const ids = activeStreamIdsByChat.get(chatId)
    if (!ids) return count
    for (const streamId of ids) {
      const abort = activeByStreamId.get(streamId)?.abort
      if (!abort) continue
      abort()
      count += 1
    }
    return count
  },
  clearActive: (streamId, replacementEpoch) => {
    const current = activeByStreamId.get(streamId)
    if (current?.replacementEpoch !== replacementEpoch) return
    const key = targetKey(current.chatId, current.messageId)
    removeActiveIndexes(current)
    activeByStreamId.delete(streamId)
    bumpLifecycleState(set)
    notifyTarget(key)
    notifyChat(current.chatId)
  },
  clearLiveSnapshot: (messageId, expectedStreamId, replacementEpoch) => {
    const key = liveTargetByStreamId.get(expectedStreamId)
    if (!key) return
    const current = liveByTarget.get(key)
    if (
      !current ||
      current.messageId !== messageId ||
      current.streamId !== expectedStreamId ||
      current.replacementEpoch !== replacementEpoch
    ) {
      return
    }
    liveByTarget.delete(key)
    liveTargetByStreamId.delete(expectedStreamId)
    notifyTarget(key)
  },
  replaceWorkspace: (replacementEpoch) => {
    const state = get()
    if (state.replacementEpoch !== null && replacementEpoch <= state.replacementEpoch) return
    const targets = new Set([...activeStreamIdsByTarget.keys(), ...liveByTarget.keys()])
    const chats = new Set(activeStreamIdsByChat.keys())
    for (const stream of activeByStreamId.values()) stream.abort?.()
    activeByStreamId.clear()
    activeStreamIdsByTarget.clear()
    activeStreamIdsByChat.clear()
    liveByTarget.clear()
    liveTargetByStreamId.clear()
    targetSnapshotByKey.clear()
    bumpLifecycleState(set, replacementEpoch)
    for (const key of targets) notifyTarget(key)
    for (const chatId of chats) notifyChat(chatId)
  },
  reset: () => {
    const targets = new Set([...activeStreamIdsByTarget.keys(), ...liveByTarget.keys()])
    const chats = new Set(activeStreamIdsByChat.keys())
    activeByStreamId.clear()
    activeStreamIdsByTarget.clear()
    activeStreamIdsByChat.clear()
    liveByTarget.clear()
    liveTargetByStreamId.clear()
    targetSnapshotByKey.clear()
    chatLifecycleRevision.clear()
    bumpLifecycleState(set, null)
    for (const key of targets) notifyTarget(key)
    for (const chatId of chats) notifyChat(chatId)
  },
}))

export function subscribeStreamTarget(
  chatId: ChatId,
  messageId: MessageId,
  listener: () => void,
): () => void {
  const key = targetKey(chatId, messageId)
  const listeners = targetListeners.get(key)
  if (listeners) {
    listeners.add(listener)
  } else {
    targetListeners.set(key, new Set([listener]))
  }
  return () => {
    const current = targetListeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) targetListeners.delete(key)
  }
}

function getStreamTargetSnapshot(chatId: ChatId, messageId: MessageId): StreamTargetSnapshot {
  return targetSnapshotByKey.get(targetKey(chatId, messageId)) ?? EMPTY_TARGET_SNAPSHOT
}

export function useStreamTarget(
  chatId: ChatId | null,
  messageId: MessageId | null,
  enabled = true,
): StreamTargetSnapshot {
  const active = enabled && chatId !== null && messageId !== null
  const subscribe = useCallback(
    (listener: () => void) =>
      active ? subscribeStreamTarget(chatId, messageId, listener) : () => undefined,
    [active, chatId, messageId],
  )
  const getSnapshot = useCallback(
    () => (active ? getStreamTargetSnapshot(chatId, messageId) : EMPTY_TARGET_SNAPSHOT),
    [active, chatId, messageId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function subscribeChatStreams(chatId: ChatId, listener: () => void): () => void {
  const listeners = chatListeners.get(chatId)
  if (listeners) {
    listeners.add(listener)
  } else {
    chatListeners.set(chatId, new Set([listener]))
  }
  return () => {
    const current = chatListeners.get(chatId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) chatListeners.delete(chatId)
  }
}

function useChatLifecycleRevision(chatId: ChatId | null, enabled: boolean): number {
  const active = enabled && chatId !== null
  const subscribe = useCallback(
    (listener: () => void) => (active ? subscribeChatStreams(chatId, listener) : () => undefined),
    [active, chatId],
  )
  const getSnapshot = useCallback(
    () => (active ? (chatLifecycleRevision.get(chatId) ?? 0) : 0),
    [active, chatId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useHasStreamForChat(chatId: ChatId | null, enabled = true): boolean {
  useChatLifecycleRevision(chatId, enabled)
  return enabled && chatId !== null && (activeStreamIdsByChat.get(chatId)?.size ?? 0) > 0
}

export function useIsStreamTargetActive(
  chatId: ChatId | null,
  messageId: MessageId | null,
  enabled = true,
): boolean {
  useChatLifecycleRevision(chatId, enabled)
  return (
    enabled &&
    chatId !== null &&
    messageId !== null &&
    firstActiveForTarget(targetKey(chatId, messageId)) !== undefined
  )
}

export function useActiveStreamsForChat(
  chatId: ChatId | null,
  enabled = true,
): readonly ActiveStream[] {
  const revision = useChatLifecycleRevision(chatId, enabled)
  return useMemo(() => {
    void revision
    return enabled && chatId !== null ? listByChat(chatId) : EMPTY_STREAMS
  }, [chatId, enabled, revision])
}

export function clearLiveSnapshotIfPresent(
  messageId: MessageId,
  expectedStreamId: string,
  replacementEpoch: number,
): void {
  const state = useStreamStore.getState()
  const current = state.getLiveSnapshotByStreamId(expectedStreamId)
  if (current?.messageId === messageId && current.replacementEpoch === replacementEpoch) {
    state.clearLiveSnapshot(messageId, expectedStreamId, replacementEpoch)
  }
}

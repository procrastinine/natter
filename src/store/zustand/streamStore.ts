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
  attemptKind?: 'generation' | 'continuation'
  originNavigationRevision?: string
  replacementEpoch: number
  admissionSequence?: number
  startedAt: number
  heartbeatAt?: number
  ownerClientId: string
  abort?: () => void
  requestLiveSnapshot?: () => Promise<void>
  phase?: 'streaming' | 'recovery-pending' | 'cleanup-pending'
  recoveryOutcome?: 'done' | 'error' | 'abort'
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
  listSelectedByChat: (chatId: ChatId) => ActiveStream[]
  listStreamIds: () => string[]
  setActive: (stream: ActiveStream) => void
  setLiveSnapshotRequester: (
    streamId: string,
    replacementEpoch: number,
    requester: (() => Promise<void>) | undefined,
  ) => void
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
const activeStreamIdsByChat = new Map<ChatId, Set<string>>()
const selectedStreamIdByTarget = new Map<string, string>()
const selectedStreamIdsByChat = new Map<ChatId, Set<string>>()
const admissionSequenceByStreamId = new Map<string, number>()
const recoveryPendingStreamCountByChat = new Map<ChatId, number>()
const liveByTarget = new Map<string, LiveStreamSnapshot>()
const liveTargetByStreamId = new Map<string, string>()
const targetSnapshotByKey = new Map<string, StreamTargetSnapshot>()
const targetListeners = new Map<string, Set<() => void>>()
const chatListeners = new Map<ChatId, Set<() => void>>()
const recoveryPendingListeners = new Set<(chatId: ChatId) => void>()
const recoveryPendingStreamListeners = new Set<(stream: ActiveStream) => void>()
const chatLifecycleRevision = new Map<ChatId, number>()
let chatLifecycleSequence = 0
let admissionSequence = 0
const EMPTY_TARGET_SNAPSHOT: StreamTargetSnapshot = {
  activeStream: undefined,
  liveSnapshot: undefined,
}
const EMPTY_STREAMS: ActiveStream[] = []

function targetKey(chatId: ChatId, messageId?: MessageId): string {
  return `${chatId}\u0000${messageId ?? ''}`
}

function selectedActiveForTarget(key: string): ActiveStream | undefined {
  const streamId = selectedStreamIdByTarget.get(key)
  return streamId ? activeByStreamId.get(streamId) : undefined
}

function shouldSelectCandidate(key: string, candidate: ActiveStream): boolean {
  if (candidate.phase === 'cleanup-pending') return false
  const selected = selectedActiveForTarget(key)
  if (!selected || selected.streamId === candidate.streamId) return true
  if (candidate.admissionSequence !== undefined || selected.admissionSequence !== undefined) {
    if (candidate.admissionSequence === undefined) return false
    if (selected.admissionSequence === undefined) return true
    return candidate.admissionSequence > selected.admissionSequence
  }
  return (
    (admissionSequenceByStreamId.get(candidate.streamId) ?? 0) >
    (admissionSequenceByStreamId.get(selected.streamId) ?? 0)
  )
}

function removeSelectedChatIndex(stream: ActiveStream): void {
  removeIndex(selectedStreamIdsByChat, stream.chatId, stream.streamId)
}

function selectTargetStream(key: string, stream: ActiveStream): string | undefined {
  const previousId = selectedStreamIdByTarget.get(key)
  if (previousId === stream.streamId) return previousId
  if (previousId) {
    const previous = activeByStreamId.get(previousId)
    if (previous) removeSelectedChatIndex(previous)
  }
  selectedStreamIdByTarget.set(key, stream.streamId)
  addIndex(selectedStreamIdsByChat, stream.chatId, stream.streamId)
  return previousId
}

function clearSelectedTargetIfMatch(key: string, stream: ActiveStream): boolean {
  if (selectedStreamIdByTarget.get(key) !== stream.streamId) return false
  selectedStreamIdByTarget.delete(key)
  removeSelectedChatIndex(stream)
  return true
}

function refreshTargetSnapshot(key: string): void {
  const activeStream = selectedActiveForTarget(key)
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
  if (activeStreamIdsByChat.has(chatId)) {
    chatLifecycleRevision.set(chatId, chatLifecycleSequence)
  } else {
    chatLifecycleRevision.delete(chatId)
  }
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
}

function addActiveIndexes(stream: ActiveStream): void {
  addIndex(activeStreamIdsByChat, stream.chatId, stream.streamId)
}

function updateRecoveryPendingIndex(
  previous: ActiveStream | undefined,
  next: ActiveStream | undefined,
): void {
  const previousPending =
    previous?.phase === 'recovery-pending' || previous?.phase === 'cleanup-pending'
  const nextPending = next?.phase === 'recovery-pending' || next?.phase === 'cleanup-pending'
  if (previousPending === nextPending && (!previousPending || previous?.chatId === next?.chatId)) {
    return
  }
  if (previousPending && previous) {
    const count = recoveryPendingStreamCountByChat.get(previous.chatId) ?? 0
    if (count <= 1) recoveryPendingStreamCountByChat.delete(previous.chatId)
    else recoveryPendingStreamCountByChat.set(previous.chatId, count - 1)
  }
  if (nextPending && next) {
    recoveryPendingStreamCountByChat.set(
      next.chatId,
      (recoveryPendingStreamCountByChat.get(next.chatId) ?? 0) + 1,
    )
    for (const listener of [...recoveryPendingListeners]) listener(next.chatId)
    for (const listener of [...recoveryPendingStreamListeners]) listener(next)
  }
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

function listSelectedByChat(chatId: ChatId): ActiveStream[] {
  const ids = selectedStreamIdsByChat.get(chatId)
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
    selectedActiveForTarget(targetKey(chatId, messageId)) !== undefined,
  getTargetActive: (chatId, messageId) => selectedActiveForTarget(targetKey(chatId, messageId)),
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
  listSelectedByChat,
  listStreamIds: () => [...activeByStreamId.keys()],
  setActive: (stream) => {
    const state = get()
    if (state.replacementEpoch !== null && state.replacementEpoch !== stream.replacementEpoch)
      return
    const previous = activeByStreamId.get(stream.streamId)
    const previousTarget = previous ? targetKey(previous.chatId, previous.messageId) : null
    if (!admissionSequenceByStreamId.has(stream.streamId)) {
      admissionSequence += 1
      admissionSequenceByStreamId.set(stream.streamId, admissionSequence)
    }
    if (previous) {
      removeActiveIndexes(previous)
      if (previousTarget && previousTarget !== targetKey(stream.chatId, stream.messageId)) {
        clearSelectedTargetIfMatch(previousTarget, previous)
      }
    }
    activeByStreamId.set(stream.streamId, stream)
    addActiveIndexes(stream)
    updateRecoveryPendingIndex(previous, stream)
    const nextTarget = targetKey(stream.chatId, stream.messageId)
    if (stream.phase === 'cleanup-pending') {
      clearSelectedTargetIfMatch(nextTarget, stream)
      const completedLive = liveByTarget.get(nextTarget)
      if (completedLive?.streamId === stream.streamId) {
        liveByTarget.delete(nextTarget)
        liveTargetByStreamId.delete(stream.streamId)
      }
    } else if (shouldSelectCandidate(nextTarget, stream)) {
      const displacedStreamId = selectTargetStream(nextTarget, stream)
      const displacedLive = liveByTarget.get(nextTarget)
      if (
        displacedLive &&
        displacedLive.streamId !== stream.streamId &&
        displacedStreamId !== stream.streamId
      ) {
        liveByTarget.delete(nextTarget)
        liveTargetByStreamId.delete(displacedLive.streamId)
      }
    }
    bumpLifecycleState(set, stream.replacementEpoch)
    if (previousTarget && previousTarget !== nextTarget) notifyTarget(previousTarget)
    notifyTarget(nextTarget)
    if (previous && previous.chatId !== stream.chatId) notifyChat(previous.chatId)
    notifyChat(stream.chatId)
  },
  setLiveSnapshotRequester: (streamId, replacementEpoch, requester) => {
    const current = activeByStreamId.get(streamId)
    if (
      current?.replacementEpoch !== replacementEpoch ||
      current.requestLiveSnapshot === requester
    ) {
      return
    }
    const { requestLiveSnapshot: _previousRequester, ...rest } = current
    const next: ActiveStream = requester ? { ...rest, requestLiveSnapshot: requester } : rest
    get().setActive(next)
  },
  setLiveSnapshot: (snapshot) => {
    if (get().replacementEpoch !== snapshot.replacementEpoch) return
    const nextTarget = targetKey(snapshot.chatId, snapshot.messageId)
    const selected = selectedActiveForTarget(nextTarget)
    if (
      selected?.streamId !== snapshot.streamId ||
      selected.replacementEpoch !== snapshot.replacementEpoch
    ) {
      return
    }
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
    clearSelectedTargetIfMatch(key, current)
    removeActiveIndexes(current)
    activeByStreamId.delete(streamId)
    admissionSequenceByStreamId.delete(streamId)
    updateRecoveryPendingIndex(current, undefined)
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
    const targets = new Set([...selectedStreamIdByTarget.keys(), ...liveByTarget.keys()])
    const chats = new Set(activeStreamIdsByChat.keys())
    for (const stream of activeByStreamId.values()) stream.abort?.()
    activeByStreamId.clear()
    activeStreamIdsByChat.clear()
    selectedStreamIdByTarget.clear()
    selectedStreamIdsByChat.clear()
    admissionSequenceByStreamId.clear()
    admissionSequence = 0
    recoveryPendingStreamCountByChat.clear()
    liveByTarget.clear()
    liveTargetByStreamId.clear()
    targetSnapshotByKey.clear()
    bumpLifecycleState(set, replacementEpoch)
    for (const key of targets) notifyTarget(key)
    for (const chatId of chats) notifyChat(chatId)
  },
  reset: () => {
    const targets = new Set([...selectedStreamIdByTarget.keys(), ...liveByTarget.keys()])
    const chats = new Set(activeStreamIdsByChat.keys())
    activeByStreamId.clear()
    activeStreamIdsByChat.clear()
    selectedStreamIdByTarget.clear()
    selectedStreamIdsByChat.clear()
    admissionSequenceByStreamId.clear()
    admissionSequence = 0
    recoveryPendingStreamCountByChat.clear()
    liveByTarget.clear()
    liveTargetByStreamId.clear()
    targetSnapshotByKey.clear()
    chatLifecycleRevision.clear()
    bumpLifecycleState(set, null)
    for (const key of targets) notifyTarget(key)
    for (const chatId of chats) notifyChat(chatId)
  },
}))

export function recoveryPendingChatIds(): readonly ChatId[] {
  return [...recoveryPendingStreamCountByChat.keys()]
}

export function isRecoveryPendingChat(chatId: ChatId): boolean {
  return recoveryPendingStreamCountByChat.has(chatId)
}

export function subscribeRecoveryPendingChats(listener: (chatId: ChatId) => void): () => void {
  recoveryPendingListeners.add(listener)
  return () => recoveryPendingListeners.delete(listener)
}

export function recoveryPendingStreams(): readonly ActiveStream[] {
  return [...activeByStreamId.values()].filter(
    (stream) => stream.phase === 'recovery-pending' || stream.phase === 'cleanup-pending',
  )
}

export function isRecoveryPendingStream(streamId: string): boolean {
  const stream = activeByStreamId.get(streamId)
  return stream?.phase === 'recovery-pending' || stream?.phase === 'cleanup-pending'
}

export function subscribeRecoveryPendingStreams(
  listener: (stream: ActiveStream) => void,
): () => void {
  recoveryPendingStreamListeners.add(listener)
  return () => recoveryPendingStreamListeners.delete(listener)
}

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

export function __streamStoreIndexStatsForTests(): {
  activeChats: number
  chatLifecycleRevisions: number
} {
  return {
    activeChats: activeStreamIdsByChat.size,
    chatLifecycleRevisions: chatLifecycleRevision.size,
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
  const active = enabled && chatId !== null && messageId !== null
  const subscribe = useCallback(
    (listener: () => void) =>
      active ? subscribeStreamTarget(chatId, messageId, listener) : () => undefined,
    [active, chatId, messageId],
  )
  const getSnapshot = useCallback(
    () => active && selectedActiveForTarget(targetKey(chatId, messageId)) !== undefined,
    [active, chatId, messageId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function isStreamRelevantToSelectedPath(
  stream: ActiveStream,
  selectedPathMessageIds: ReadonlySet<MessageId>,
  knownHeaderMessageIds: ReadonlySet<MessageId>,
  currentNavigationRevision: string,
  localOwnerClientId: string,
): boolean {
  const targetMessageId = stream.messageId
  if (targetMessageId && selectedPathMessageIds.has(targetMessageId)) return true
  if (!targetMessageId || knownHeaderMessageIds.has(targetMessageId)) return false
  return (
    stream.attemptKind === 'generation' &&
    streamOriginatesFromTabNavigation(stream, currentNavigationRevision, localOwnerClientId)
  )
}

export function streamOriginatesFromTabNavigation(
  stream: Pick<ActiveStream, 'ownerClientId' | 'originNavigationRevision'>,
  navigationRevision: string,
  localOwnerClientId: string,
): boolean {
  return (
    stream.ownerClientId === localOwnerClientId &&
    stream.originNavigationRevision === navigationRevision
  )
}

export function useActiveStreamsForChat(
  chatId: ChatId | null,
  enabled = true,
): readonly ActiveStream[] {
  const revision = useChatLifecycleRevision(chatId, enabled)
  return useMemo(() => {
    void revision
    return enabled && chatId !== null ? listSelectedByChat(chatId) : EMPTY_STREAMS
  }, [chatId, enabled, revision])
}

export function mostRecentlyAdmittedStream(
  streams: readonly ActiveStream[],
): ActiveStream | undefined {
  let selected: ActiveStream | undefined
  let selectedSequence = -1
  let selectedIsDurable = false
  for (const stream of streams) {
    const isDurable = stream.admissionSequence !== undefined
    const sequence =
      stream.admissionSequence ?? admissionSequenceByStreamId.get(stream.streamId) ?? -1
    if (selected && selectedIsDurable !== isDurable) {
      if (!isDurable) continue
    } else if (sequence <= selectedSequence) {
      continue
    }
    selected = stream
    selectedSequence = sequence
    selectedIsDurable = isDurable
  }
  return selected
}

export function currentStreamAdmissionRevision(): number {
  return admissionSequence
}

export function wasStreamAdmittedBy(streamId: string, revision: number): boolean {
  const sequence = admissionSequenceByStreamId.get(streamId)
  return sequence !== undefined && sequence <= revision
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

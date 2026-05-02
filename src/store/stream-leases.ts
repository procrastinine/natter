import type { ChatId, MessageId } from '../core/types'
import { newId } from '../lib/ulid'
import { onEvent, postEvent } from './broadcast'
import type { StreamLeaseRow } from './repository'
import { getWorkspaceRepository } from './workspace-repository'
import { useStreamStore } from './zustand/streamStore'

const STREAM_LEASE_HEARTBEAT_MS = 2_000
export const STREAM_LEASE_TTL_MS = 15_000

const clientId = newId()
const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>()
let listenerInstalled = false
let unsubscribe: (() => void) | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null

export function getStreamClientId(): string {
  return clientId
}

export function isFreshStreamLease(lease: StreamLeaseRow, now = Date.now()): boolean {
  return now - lease.heartbeatAt <= STREAM_LEASE_TTL_MS
}

export function installStreamLeaseListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  unsubscribe = onEvent((event) => {
    if (event.kind === 'stream-heartbeat') {
      applyRemoteLease(event.lease)
      return
    }
    if (event.kind === 'stream-started') {
      if (event.ownerClientId === clientId) return
      useStreamStore.getState().setActive({
        streamId: event.streamId,
        chatId: event.chatId,
        ...(event.messageId ? { messageId: event.messageId } : {}),
        startedAt: Date.now(),
        heartbeatAt: Date.now(),
        ownerClientId: event.ownerClientId,
      })
      return
    }
    if (event.kind === 'stream-ended') {
      useStreamStore.getState().clearActive(event.streamId)
      if (event.messageId) useStreamStore.getState().clearLiveSnapshot(event.messageId)
      return
    }
    if (event.kind === 'stream-abort-requested' && event.ownerClientId === clientId) {
      useStreamStore.getState().abortStream(event.streamId)
    }
  })
  void refreshRemoteStreamLeases().catch(() => {})
  refreshTimer = setInterval(() => {
    void refreshRemoteStreamLeases().catch(() => {})
  }, STREAM_LEASE_TTL_MS)
}

export function startStreamLease(input: {
  streamId: string
  chatId: ChatId
  messageId: MessageId
  startedAt: number
}): void {
  stopHeartbeatTimer(input.streamId)
  const write = () => {
    const lease: StreamLeaseRow = {
      streamId: input.streamId,
      chatId: input.chatId,
      messageId: input.messageId,
      ownerClientId: clientId,
      startedAt: input.startedAt,
      heartbeatAt: Date.now(),
    }
    void getWorkspaceRepository()
      .upsertStreamLease(lease)
      .catch(() => {})
  }
  write()
  heartbeatTimers.set(input.streamId, setInterval(write, STREAM_LEASE_HEARTBEAT_MS))
}

export function stopStreamLease(streamId: string): void {
  stopHeartbeatTimer(streamId)
  void getWorkspaceRepository()
    .deleteStreamLease(streamId)
    .catch(() => {})
}

async function freshStreamLeases(chatId?: ChatId, now = Date.now()): Promise<StreamLeaseRow[]> {
  const leases = await getWorkspaceRepository().listStreamLeases(chatId)
  return leases.filter((lease) => isFreshStreamLease(lease, now))
}

export function requestAbortForChat(chatId: ChatId): number {
  const state = useStreamStore.getState()
  let count = state.abortChat(chatId)
  for (const stream of state.listByChat(chatId)) {
    if (stream.ownerClientId === clientId || stream.abort) continue
    postEvent({
      kind: 'stream-abort-requested',
      chatId,
      streamId: stream.streamId,
      ownerClientId: stream.ownerClientId,
    })
    count += 1
  }
  return count
}

function applyRemoteLease(lease: StreamLeaseRow): void {
  if (lease.ownerClientId === clientId) return
  if (!isFreshStreamLease(lease)) return
  useStreamStore.getState().setActive({
    streamId: lease.streamId,
    chatId: lease.chatId,
    ...(lease.messageId ? { messageId: lease.messageId } : {}),
    startedAt: lease.startedAt,
    heartbeatAt: lease.heartbeatAt,
    ownerClientId: lease.ownerClientId,
  })
}

async function refreshRemoteStreamLeases(): Promise<void> {
  const leases = await freshStreamLeases()
  const freshIds = new Set<string>()
  for (const lease of leases) {
    freshIds.add(lease.streamId)
    applyRemoteLease(lease)
  }
  const state = useStreamStore.getState()
  for (const stream of Object.values(state.activeByStreamId)) {
    if (stream.ownerClientId === clientId) continue
    if (!freshIds.has(stream.streamId)) state.clearActive(stream.streamId)
  }
}

function stopHeartbeatTimer(streamId: string): void {
  const timer = heartbeatTimers.get(streamId)
  if (timer !== undefined) {
    clearInterval(timer)
    heartbeatTimers.delete(streamId)
  }
}

export function __resetStreamLeasesForTests(): void {
  unsubscribe?.()
  unsubscribe = null
  listenerInstalled = false
  if (refreshTimer !== null) clearInterval(refreshTimer)
  refreshTimer = null
  for (const timer of heartbeatTimers.values()) clearInterval(timer)
  heartbeatTimers.clear()
}

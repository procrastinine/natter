import type { ChatId, MessageId } from '../core/types'
import { newId } from '../lib/ulid'
import { type BroadcastEvent, isBroadcastChannelAvailable, onEvent, postEvent } from './broadcast'
import {
  STREAM_LEASE_TTL_MS,
  type StreamLeaseRow,
  type StreamWriteFence,
  type WorkspaceRepository,
} from './repository'
import { getWorkspaceRepository } from './workspace-repository'
import { clearLiveSnapshotIfPresent, useStreamStore } from './zustand/streamStore'

const STREAM_LEASE_HEARTBEAT_MS = 2_000
const STREAM_LEASE_REFRESH_RETRY_MS = 2_000

export { STREAM_LEASE_TTL_MS } from './repository'

const ENDED_STREAM_TOMBSTONE_LIMIT = 4_096

export type StreamEndedAnnouncement = Omit<
  Extract<BroadcastEvent, { kind: 'stream-ended' }>,
  'kind'
>

export type RemoteStreamLeasesExpiredHandler = (leases: readonly StreamLeaseRow[]) => void

export type RemoteStreamOwnershipReleasedHandler = (stream: {
  chatId: ChatId
  streamId: string
}) => void

interface RemoteStreamOwnershipReleaseSubscription {
  chatId: ChatId
  handler: RemoteStreamOwnershipReleasedHandler
  stopped: boolean
  watches: Map<string, AbortController>
}

interface ActiveLeaseWriter {
  input: Parameters<typeof startStreamLease>[0]
  readonly repo: WorkspaceRepository
  readonly fenceToken: string
  readonly replacementEpoch: number
  lease?: StreamLeaseRow
  nextHeartbeatAt: number | null
  releaseOwnership: (() => void) | null
  closed: boolean
  writeScheduled: boolean
}

type StreamLockManager = Pick<LockManager, 'request'>

const clientId = newId()
const activeLeaseWriters = new Map<string, ActiveLeaseWriter>()
const streamOperationTails = new Map<string, Promise<void>>()
const streamOwnershipTasks = new Set<Promise<void>>()
const endedStreamIds = new Set<string>()
let lockManagerOverride: StreamLockManager | null | undefined
let listenerInstalled = false
let unsubscribe: (() => void) | null = null
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatDeadline: number | null = null
let heartbeatSchedulerWakeups = 0
let fallbackRefreshTimer: ReturnType<typeof setInterval> | null = null
let remoteExpiryTimer: ReturnType<typeof setTimeout> | null = null
let remoteExpiryDeadline: number | null = null
let refreshInFlight: { generation: number; promise: Promise<void> } | null = null
let refreshGeneration = 0
let currentReplacementEpoch: number | null = null
let remoteObservationRevision = 0
const remoteHeartbeatAtByStreamId = new Map<string, number>()
const remoteObservationRevisionByStreamId = new Map<string, number>()
const reportedExpiredStreamIds = new Set<string>()
const remoteExpiryHandlers = new Set<RemoteStreamLeasesExpiredHandler>()
const remoteOwnershipReleaseSubscriptions = new Set<RemoteStreamOwnershipReleaseSubscription>()

export function getStreamClientId(): string {
  return clientId
}

export function isFreshStreamLease(lease: StreamLeaseRow, now = Date.now()): boolean {
  return now - lease.heartbeatAt <= STREAM_LEASE_TTL_MS
}

export function isRecoveryClaimedStreamLease(lease: StreamLeaseRow): boolean {
  return lease.ownerClientId.startsWith('recovery:')
}

export type StreamRecoveryLockResult<T> = { acquired: false } | { acquired: true; value: T }

export function streamOwnershipLocksSupported(): boolean {
  return streamLockManager() !== null
}

export async function withStreamRecoveryLocks<T>(
  streamIds: readonly string[],
  recover: (ownershipVerified: boolean) => Promise<T>,
): Promise<StreamRecoveryLockResult<T>> {
  const manager = streamLockManager()
  if (!manager) return { acquired: true, value: await recover(false) }
  const names = [...new Set(streamIds)].sort().map(streamOwnershipLockName)
  let result: StreamRecoveryLockResult<T> = { acquired: false }
  const recoveryState = { started: false }
  const acquire = async (index: number): Promise<void> => {
    if (index >= names.length) {
      recoveryState.started = true
      result = { acquired: true, value: await recover(names.length > 0) }
      return
    }
    const name = names[index] as string
    await manager.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return
      await acquire(index + 1)
    })
  }
  try {
    await acquire(0)
  } catch (error) {
    if (recoveryState.started) throw error
    return { acquired: false }
  }
  return result
}

export function installStreamLeaseListener(): void {
  if (listenerInstalled) return
  listenerInstalled = true
  unsubscribe = onEvent((event) => {
    if (event.kind === 'workspace-replaced') {
      replaceStreamWorkspace(event.replacementEpoch)
      ensureFallbackLeaseRefresh()
      refreshRemoteStreamLeasesWithRetry()
      return
    }
    if (event.kind === 'workspace-invalidated') {
      refreshGeneration += 1
      ensureFallbackLeaseRefresh()
      refreshRemoteStreamLeasesWithRetry()
      return
    }
    if (event.kind === 'stream-heartbeat') {
      applyRemoteLease(event.lease, { recordObservation: true })
      return
    }
    if (event.kind === 'stream-started') {
      applyRemoteStreamStarted(event)
      return
    }
    if (event.kind === 'stream-ended') {
      applyStreamEnded(event)
      return
    }
    if (
      event.kind === 'stream-abort-requested' &&
      event.ownerClientId === clientId &&
      event.replacementEpoch === currentReplacementEpoch
    ) {
      useStreamStore.getState().abortStream(event.streamId, event.replacementEpoch)
    }
  })
  ensureFallbackLeaseRefresh()
  refreshRemoteStreamLeasesWithRetry()
}

export function announceStreamEnded(event: StreamEndedAnnouncement): void {
  applyStreamEnded({ kind: 'stream-ended', ...event })
  postEvent({ kind: 'stream-ended', ...event })
}

function replaceStreamWorkspace(replacementEpoch: number): boolean {
  if (currentReplacementEpoch !== null && replacementEpoch <= currentReplacementEpoch) {
    return false
  }
  currentReplacementEpoch = replacementEpoch
  refreshGeneration += 1
  refreshInFlight = null
  const writers = [...activeLeaseWriters.values()]
  activeLeaseWriters.clear()
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  heartbeatDeadline = null
  for (const writer of writers) {
    writer.closed = true
    writer.nextHeartbeatAt = null
    writer.releaseOwnership?.()
    writer.releaseOwnership = null
  }
  endedStreamIds.clear()
  remoteObservationRevision = 0
  remoteHeartbeatAtByStreamId.clear()
  remoteObservationRevisionByStreamId.clear()
  reportedExpiredStreamIds.clear()
  for (const subscription of remoteOwnershipReleaseSubscriptions) {
    for (const controller of subscription.watches.values()) controller.abort()
    subscription.watches.clear()
  }
  if (remoteExpiryTimer !== null) clearTimeout(remoteExpiryTimer)
  remoteExpiryTimer = null
  remoteExpiryDeadline = null
  useStreamStore.getState().replaceWorkspace(replacementEpoch)
  return true
}

async function ensureCurrentReplacementEpoch(): Promise<number> {
  if (currentReplacementEpoch !== null) {
    if (useStreamStore.getState().replacementEpoch === null) {
      useStreamStore.getState().replaceWorkspace(currentReplacementEpoch)
    }
    return currentReplacementEpoch
  }
  const replacementEpoch = (await getWorkspaceRepository().getWorkspaceMeta()).replacementEpoch
  return synchronizeReplacementEpoch(replacementEpoch)
}

function synchronizeReplacementEpoch(replacementEpoch: number): number {
  if (currentReplacementEpoch === null) {
    currentReplacementEpoch = replacementEpoch
    useStreamStore.getState().replaceWorkspace(replacementEpoch)
  } else if (replacementEpoch > currentReplacementEpoch) {
    replaceStreamWorkspace(replacementEpoch)
  }
  return currentReplacementEpoch
}

export function onRemoteStreamLeasesExpired(handler: RemoteStreamLeasesExpiredHandler): () => void {
  remoteExpiryHandlers.add(handler)
  refreshRemoteStreamLeasesWithRetry()
  return () => remoteExpiryHandlers.delete(handler)
}

export function onRemoteStreamOwnershipReleased(
  chatId: ChatId,
  handler: RemoteStreamOwnershipReleasedHandler,
): () => void {
  const subscription: RemoteStreamOwnershipReleaseSubscription = {
    chatId,
    handler,
    stopped: false,
    watches: new Map(),
  }
  remoteOwnershipReleaseSubscriptions.add(subscription)
  for (const stream of useStreamStore.getState().listByChat(chatId)) {
    observeRemoteStreamOwnership(subscription, stream)
  }
  void getWorkspaceRepository()
    .listStreamLeases(chatId)
    .then(
      (leases) => {
        if (subscription.stopped) return
        for (const lease of leases) observeRemoteStreamOwnership(subscription, lease)
      },
      () => {},
    )
  return () => stopRemoteOwnershipReleaseSubscription(subscription)
}

export async function startStreamLease(input: {
  streamId: string
  chatId: ChatId
  messageId?: MessageId
  startedAt: number
  attemptKind?: StreamLeaseRow['attemptKind']
  continuationStrategy?: StreamLeaseRow['continuationStrategy']
  baseBodyVersion?: number
  baseNodeVersion?: number
  requestedModel?: string
  apiUsed?: StreamLeaseRow['apiUsed']
  replacementEpoch?: number
}): Promise<StreamWriteFence> {
  const replacementEpoch = currentReplacementEpoch ?? (await ensureCurrentReplacementEpoch())
  if (input.replacementEpoch !== undefined && input.replacementEpoch !== replacementEpoch) {
    throw new Error(`StreamWorkspaceReplaced:${input.streamId}`)
  }
  const expectedReplacementEpoch = input.replacementEpoch ?? replacementEpoch
  const existing = activeLeaseWriters.get(input.streamId)
  if (existing) {
    if (existing.input.chatId !== input.chatId) throw new Error('StreamLeaseChatMismatch')
    if (existing.replacementEpoch !== expectedReplacementEpoch) {
      throw new Error(`StreamWorkspaceReplaced:${input.streamId}`)
    }
    existing.input = { ...existing.input, ...input, startedAt: existing.input.startedAt }
    await enqueueLeaseWrite(existing)
    assertWriterEpochCurrent(existing)
    return writerFence(existing)
  }
  const writer: ActiveLeaseWriter = {
    input,
    repo: getWorkspaceRepository(),
    fenceToken: newId(),
    replacementEpoch: expectedReplacementEpoch,
    nextHeartbeatAt: null,
    releaseOwnership: null,
    closed: false,
    writeScheduled: false,
  }
  activeLeaseWriters.set(input.streamId, writer)
  try {
    await holdStreamOwnership(writer)
    await scheduleHeartbeat(writer)
    assertWriterEpochCurrent(writer)
  } catch (error) {
    const closed = closeLeaseWriter(input.streamId)
    if (closed) releaseOwnershipAfter(closed, pendingStreamOperations(input.streamId))
    await deleteCrossEpochAdmission(writer)
    throw error
  }
  if (!writer.closed && activeLeaseWriters.get(input.streamId) === writer) {
    writer.nextHeartbeatAt =
      heartbeatTimer !== null && heartbeatDeadline !== null
        ? heartbeatDeadline
        : heartbeatSchedulerNow() + STREAM_LEASE_HEARTBEAT_MS
    scheduleHeartbeatTimer()
  }
  return writerFence(writer)
}

function assertWriterEpochCurrent(writer: ActiveLeaseWriter): void {
  if (
    currentReplacementEpoch !== writer.replacementEpoch ||
    writer.lease?.replacementEpoch !== writer.replacementEpoch
  ) {
    throw new Error(`StreamWorkspaceReplaced:${writer.input.streamId}`)
  }
}

async function deleteCrossEpochAdmission(writer: ActiveLeaseWriter): Promise<void> {
  const lease = writer.lease
  if (!lease || lease.replacementEpoch === writer.replacementEpoch) return
  try {
    await writer.repo.deleteOwnedStreamLease(lease.streamId, streamWriteFenceForLease(lease))
  } catch {
    // The unique owner fence makes a failed stale-admission cleanup safe to abandon.
  }
}

export function stopStreamLease(
  streamId: string,
  options: { deleteRow?: boolean } = {},
): Promise<void> {
  const writer = activeLeaseWriters.get(streamId)
  closeLeaseWriter(streamId)
  if (options.deleteRow === false) {
    const settled = pendingStreamOperations(streamId).catch(() => {})
    if (writer) releaseOwnershipAfter(writer, settled)
    return settled
  }
  const repo = writer?.repo ?? getWorkspaceRepository()
  const deleted = enqueueStreamOperation(streamId, async () => {
    if (!writer?.lease) return
    const fence = streamWriteFenceForLease(writer.lease)
    try {
      await repo.deleteOwnedStreamLease(streamId, fence)
    } catch {
      await repo.deleteOwnedStreamLease(streamId, fence)
    }
  })
  const settled = deleted.catch(() => {})
  if (writer) releaseOwnershipAfter(writer, settled)
  return settled
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
      replacementEpoch: stream.replacementEpoch,
    })
    count += 1
  }
  return count
}

function applyRemoteLease(
  lease: StreamLeaseRow,
  options: {
    recordObservation?: boolean
    refreshStartedAtRevision?: number
  } = {},
): void {
  if (lease.replacementEpoch === undefined || lease.replacementEpoch !== currentReplacementEpoch) {
    return
  }
  if (endedStreamIds.has(lease.streamId)) return
  if (lease.ownerClientId === clientId) return
  observeRemoteStreamOwnershipForSubscribers(lease)
  if (!isFreshStreamLease(lease)) return
  const observedRevision = remoteObservationRevisionByStreamId.get(lease.streamId) ?? 0
  if (
    options.refreshStartedAtRevision !== undefined &&
    observedRevision > options.refreshStartedAtRevision
  ) {
    return
  }
  if (options.recordObservation) recordRemoteObservation(lease.streamId)
  const state = useStreamStore.getState()
  const current = state.getActive(lease.streamId)
  const knownHeartbeatAt = remoteHeartbeatAtByStreamId.get(lease.streamId)
  const targetImproves = current?.messageId === undefined && lease.messageId !== undefined
  const targetRegresses = current?.messageId !== undefined && lease.messageId === undefined
  if (knownHeartbeatAt !== undefined && lease.heartbeatAt < knownHeartbeatAt && !targetImproves) {
    return
  }
  remoteHeartbeatAtByStreamId.set(
    lease.streamId,
    Math.max(knownHeartbeatAt ?? lease.heartbeatAt, lease.heartbeatAt),
  )
  reportedExpiredStreamIds.delete(lease.streamId)
  if (targetRegresses) {
    scheduleRemoteExpiryRefresh()
    return
  }
  setRemoteActiveIfChanged({
    streamId: lease.streamId,
    chatId: lease.chatId,
    ...(lease.messageId ? { messageId: lease.messageId } : {}),
    replacementEpoch: lease.replacementEpoch,
    startedAt: lease.startedAt,
    ownerClientId: lease.ownerClientId,
  })
  scheduleRemoteExpiryRefresh()
}

function applyRemoteStreamStarted(
  event: Extract<BroadcastEvent, { kind: 'stream-started' }>,
): void {
  if (event.replacementEpoch !== currentReplacementEpoch) return
  if (endedStreamIds.has(event.streamId)) return
  if (event.ownerClientId === clientId) return
  observeRemoteStreamOwnershipForSubscribers(event)
  recordRemoteObservation(event.streamId)
  const state = useStreamStore.getState()
  const current = state.getActive(event.streamId)
  const heartbeatAt = Math.max(
    remoteHeartbeatAtByStreamId.get(event.streamId) ?? Number.NEGATIVE_INFINITY,
    Date.now(),
  )
  remoteHeartbeatAtByStreamId.set(event.streamId, heartbeatAt)
  reportedExpiredStreamIds.delete(event.streamId)
  setRemoteActiveIfChanged({
    streamId: event.streamId,
    chatId: event.chatId,
    ...((event.messageId ?? current?.messageId)
      ? { messageId: (event.messageId ?? current?.messageId) as MessageId }
      : {}),
    replacementEpoch: event.replacementEpoch,
    startedAt: current?.startedAt ?? heartbeatAt,
    ownerClientId: event.ownerClientId,
  })
  scheduleRemoteExpiryRefresh()
}

function applyStreamEnded(event: Extract<BroadcastEvent, { kind: 'stream-ended' }>): void {
  if (event.replacementEpoch !== currentReplacementEpoch) return
  markStreamEnded(event.streamId)
  cancelRemoteOwnershipReleaseWatches(event.streamId)
  remoteHeartbeatAtByStreamId.delete(event.streamId)
  remoteObservationRevisionByStreamId.delete(event.streamId)
  reportedExpiredStreamIds.delete(event.streamId)
  useStreamStore.getState().clearActive(event.streamId, event.replacementEpoch)
  if (event.messageId) {
    clearLiveSnapshotIfPresent(event.messageId, event.streamId, event.replacementEpoch)
  }
  scheduleRemoteExpiryRefresh()
}

function observeRemoteStreamOwnershipForSubscribers(stream: {
  chatId: ChatId
  streamId: string
  ownerClientId: string
  replacementEpoch?: number
}): void {
  for (const subscription of remoteOwnershipReleaseSubscriptions) {
    observeRemoteStreamOwnership(subscription, stream)
  }
}

function observeRemoteStreamOwnership(
  subscription: RemoteStreamOwnershipReleaseSubscription,
  stream: {
    chatId: ChatId
    streamId: string
    ownerClientId: string
    replacementEpoch?: number
  },
): void {
  if (
    subscription.stopped ||
    stream.replacementEpoch !== currentReplacementEpoch ||
    subscription.chatId !== stream.chatId ||
    stream.ownerClientId === clientId ||
    endedStreamIds.has(stream.streamId) ||
    subscription.watches.has(stream.streamId)
  ) {
    return
  }
  const manager = streamLockManager()
  if (!manager) return
  const controller = new AbortController()
  subscription.watches.set(stream.streamId, controller)
  let ownershipReleased = false
  let request: Promise<unknown>
  try {
    request = manager.request(
      streamOwnershipLockName(stream.streamId),
      { mode: 'shared', signal: controller.signal },
      (lock) => {
        ownershipReleased = lock !== null
      },
    )
  } catch {
    subscription.watches.delete(stream.streamId)
    return
  }
  void request.then(
    () => {
      if (subscription.watches.get(stream.streamId) !== controller) return
      subscription.watches.delete(stream.streamId)
      if (
        subscription.stopped ||
        controller.signal.aborted ||
        !ownershipReleased ||
        endedStreamIds.has(stream.streamId)
      ) {
        return
      }
      try {
        subscription.handler({ chatId: stream.chatId, streamId: stream.streamId })
      } catch {
        // A release observer only schedules recovery; another observer must still be notified.
      }
    },
    () => {
      if (subscription.watches.get(stream.streamId) === controller) {
        subscription.watches.delete(stream.streamId)
      }
    },
  )
}

function cancelRemoteOwnershipReleaseWatches(streamId: string): void {
  for (const subscription of remoteOwnershipReleaseSubscriptions) {
    const controller = subscription.watches.get(streamId)
    if (!controller) continue
    subscription.watches.delete(streamId)
    controller.abort()
  }
}

function stopRemoteOwnershipReleaseSubscription(
  subscription: RemoteStreamOwnershipReleaseSubscription,
): void {
  if (subscription.stopped) return
  subscription.stopped = true
  remoteOwnershipReleaseSubscriptions.delete(subscription)
  for (const controller of subscription.watches.values()) controller.abort()
  subscription.watches.clear()
}

function recordRemoteObservation(streamId: string): void {
  remoteObservationRevision += 1
  remoteObservationRevisionByStreamId.set(streamId, remoteObservationRevision)
}

function markStreamEnded(streamId: string): void {
  endedStreamIds.delete(streamId)
  endedStreamIds.add(streamId)
  if (endedStreamIds.size <= ENDED_STREAM_TOMBSTONE_LIMIT) return
  const oldest = endedStreamIds.values().next().value
  if (oldest !== undefined) endedStreamIds.delete(oldest)
}

function requestRemoteStreamLeaseRefresh(): Promise<void> {
  const generation = refreshGeneration
  if (refreshInFlight?.generation === generation) return refreshInFlight.promise
  const promise = refreshRemoteStreamLeases(generation).finally(() => {
    if (refreshInFlight?.promise === promise) refreshInFlight = null
  })
  refreshInFlight = { generation, promise }
  return promise
}

async function refreshRemoteStreamLeases(generation: number): Promise<void> {
  const replacementEpoch = await ensureCurrentReplacementEpoch()
  if (generation !== refreshGeneration) return
  const refreshStartedAtRevision = remoteObservationRevision
  const snapshot = await getWorkspaceRepository().listStreamLeases()
  if (generation !== refreshGeneration || replacementEpoch !== currentReplacementEpoch) {
    return
  }
  const leases = snapshot.filter((lease) => lease.replacementEpoch === replacementEpoch)
  const now = Date.now()
  const freshLeases = leases.filter((lease) => isFreshStreamLease(lease, now))
  const snapshotIds = new Set(leases.map((lease) => lease.streamId))
  const freshIds = new Set<string>()
  for (const lease of freshLeases) {
    freshIds.add(lease.streamId)
    reportedExpiredStreamIds.delete(lease.streamId)
    applyRemoteLease(lease, { refreshStartedAtRevision })
  }
  const state = useStreamStore.getState()
  for (const stream of state.listActive()) {
    if (stream.ownerClientId === clientId) continue
    if (freshIds.has(stream.streamId)) continue
    if (isFreshRemoteObservation(stream.streamId, now)) continue
    if (
      (remoteObservationRevisionByStreamId.get(stream.streamId) ?? 0) > refreshStartedAtRevision
    ) {
      continue
    }
    remoteHeartbeatAtByStreamId.delete(stream.streamId)
    remoteObservationRevisionByStreamId.delete(stream.streamId)
    state.clearActive(stream.streamId, replacementEpoch)
  }
  const newlyExpired: StreamLeaseRow[] = []
  for (const lease of leases) {
    if (isFreshStreamLease(lease, now)) continue
    if (lease.ownerClientId === clientId || endedStreamIds.has(lease.streamId)) continue
    if (isFreshRemoteObservation(lease.streamId, now)) continue
    if (remoteExpiryHandlers.size === 0) continue
    if ((remoteObservationRevisionByStreamId.get(lease.streamId) ?? 0) > refreshStartedAtRevision) {
      continue
    }
    if (reportedExpiredStreamIds.has(lease.streamId)) continue
    reportedExpiredStreamIds.add(lease.streamId)
    newlyExpired.push({ ...lease })
  }
  for (const streamId of [...reportedExpiredStreamIds]) {
    if (!snapshotIds.has(streamId)) reportedExpiredStreamIds.delete(streamId)
  }
  scheduleRemoteExpiryRefresh()
  notifyRemoteStreamLeasesExpired(newlyExpired)
}

function isFreshRemoteObservation(streamId: string, now: number): boolean {
  const heartbeatAt = remoteHeartbeatAtByStreamId.get(streamId)
  return heartbeatAt !== undefined && now - heartbeatAt <= STREAM_LEASE_TTL_MS
}

function refreshRemoteStreamLeasesWithRetry(): void {
  const generation = refreshGeneration
  void requestRemoteStreamLeaseRefresh().then(
    () => {
      if (generation === refreshGeneration) scheduleRemoteExpiryRefresh()
    },
    () => {
      if (generation === refreshGeneration) {
        scheduleRemoteExpiryRefresh(Date.now() + STREAM_LEASE_REFRESH_RETRY_MS)
      }
    },
  )
}

function notifyRemoteStreamLeasesExpired(leases: readonly StreamLeaseRow[]): void {
  if (leases.length === 0) return
  for (const handler of [...remoteExpiryHandlers]) {
    try {
      handler(leases)
    } catch {
      // One recovery subscriber must not prevent the others from observing expiry.
    }
  }
}

function setRemoteActiveIfChanged(stream: {
  streamId: string
  chatId: ChatId
  messageId?: MessageId
  replacementEpoch: number
  startedAt: number
  ownerClientId: string
}): void {
  const state = useStreamStore.getState()
  const current = state.getActive(stream.streamId)
  if (
    current?.chatId === stream.chatId &&
    current.messageId === stream.messageId &&
    current.replacementEpoch === stream.replacementEpoch &&
    current.startedAt === stream.startedAt &&
    current.ownerClientId === stream.ownerClientId
  ) {
    return
  }
  state.setActive(stream)
}

function scheduleRemoteExpiryRefresh(notBefore?: number): void {
  let earliestExpiry = Number.POSITIVE_INFINITY
  for (const heartbeatAt of remoteHeartbeatAtByStreamId.values()) {
    earliestExpiry = Math.min(earliestExpiry, heartbeatAt + STREAM_LEASE_TTL_MS + 1)
  }
  const deadline = Number.isFinite(earliestExpiry)
    ? Math.max(earliestExpiry, notBefore ?? Number.NEGATIVE_INFINITY)
    : notBefore
  if (deadline === undefined || !Number.isFinite(deadline)) {
    if (remoteExpiryTimer !== null) clearTimeout(remoteExpiryTimer)
    remoteExpiryTimer = null
    remoteExpiryDeadline = null
    return
  }
  if (
    remoteExpiryTimer !== null &&
    remoteExpiryDeadline !== null &&
    remoteExpiryDeadline <= deadline
  ) {
    return
  }
  if (remoteExpiryTimer !== null) clearTimeout(remoteExpiryTimer)
  remoteExpiryDeadline = deadline
  remoteExpiryTimer = setTimeout(
    () => {
      remoteExpiryTimer = null
      remoteExpiryDeadline = null
      refreshRemoteStreamLeasesWithRetry()
    },
    Math.max(1, deadline - Date.now()),
  )
}

function ensureFallbackLeaseRefresh(): void {
  if (isBroadcastChannelAvailable()) {
    if (fallbackRefreshTimer !== null) clearInterval(fallbackRefreshTimer)
    fallbackRefreshTimer = null
    return
  }
  if (fallbackRefreshTimer !== null) return
  fallbackRefreshTimer = setInterval(() => {
    refreshRemoteStreamLeasesWithRetry()
  }, STREAM_LEASE_TTL_MS)
}

function heartbeatSchedulerNow(): number {
  return Date.now()
}

function scheduleHeartbeatTimer(now = heartbeatSchedulerNow()): void {
  let earliest = Number.POSITIVE_INFINITY
  for (const writer of activeLeaseWriters.values()) {
    if (writer.closed || writer.nextHeartbeatAt === null) continue
    earliest = Math.min(earliest, writer.nextHeartbeatAt)
  }
  if (!Number.isFinite(earliest)) {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
    heartbeatTimer = null
    heartbeatDeadline = null
    return
  }
  if (heartbeatTimer !== null && heartbeatDeadline === earliest) return
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatDeadline = earliest
  heartbeatTimer = setTimeout(
    () => {
      heartbeatTimer = null
      heartbeatDeadline = null
      runDueHeartbeats(heartbeatSchedulerNow())
    },
    Math.max(0, earliest - now),
  )
}

function runDueHeartbeats(now: number): void {
  heartbeatSchedulerWakeups += 1
  for (const writer of activeLeaseWriters.values()) {
    if (writer.closed || writer.nextHeartbeatAt === null || writer.nextHeartbeatAt > now) continue
    writer.nextHeartbeatAt = now + STREAM_LEASE_HEARTBEAT_MS
    void scheduleHeartbeat(writer).catch(() => {})
  }
  scheduleHeartbeatTimer(now)
}

function scheduleHeartbeat(writer: ActiveLeaseWriter): Promise<void> {
  if (writer.closed || writer.writeScheduled) return pendingStreamOperations(writer.input.streamId)
  writer.writeScheduled = true
  const write = enqueueLeaseWrite(writer)
  void write.then(
    () => {
      writer.writeScheduled = false
    },
    () => {
      writer.writeScheduled = false
    },
  )
  return write
}

function enqueueLeaseWrite(writer: ActiveLeaseWriter): Promise<void> {
  return enqueueStreamOperation(writer.input.streamId, async () => {
    const input = writer.input
    const lease: StreamLeaseRow = {
      streamId: input.streamId,
      chatId: input.chatId,
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ownerClientId: clientId,
      fenceToken: writer.fenceToken,
      startedAt: input.startedAt,
      heartbeatAt: Date.now(),
      ...(input.attemptKind ? { attemptKind: input.attemptKind } : {}),
      ...(input.continuationStrategy ? { continuationStrategy: input.continuationStrategy } : {}),
      ...(input.baseBodyVersion !== undefined ? { baseBodyVersion: input.baseBodyVersion } : {}),
      ...(input.baseNodeVersion !== undefined ? { baseNodeVersion: input.baseNodeVersion } : {}),
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(input.apiUsed ? { apiUsed: input.apiUsed } : {}),
    }
    const currentFence = writer.lease ? streamWriteFenceForLease(writer.lease) : undefined
    const targetChanged = writer.lease?.messageId !== lease.messageId
    writer.lease = currentFence
      ? await writer.repo.renewStreamLease(
          {
            ...lease,
            replacementEpoch: currentFence.replacementEpoch,
          },
          { targetChanged },
        )
      : await writer.repo.upsertStreamLease(lease)
  })
}

export function streamWriteFenceForLease(lease: StreamLeaseRow): StreamWriteFence {
  if (typeof lease.fenceToken !== 'string' || lease.replacementEpoch === undefined) {
    throw new Error(`StreamFenceMissing:${lease.streamId}`)
  }
  return {
    ownerClientId: lease.ownerClientId,
    fenceToken: lease.fenceToken,
    replacementEpoch: lease.replacementEpoch,
  }
}

function writerFence(writer: ActiveLeaseWriter): StreamWriteFence {
  if (!writer.lease) throw new Error(`StreamLeaseAdmissionMissing:${writer.input.streamId}`)
  return streamWriteFenceForLease(writer.lease)
}

function streamOwnershipLockName(streamId: string): string {
  return `stream-owner:${streamId}`
}

function streamLockManager(): StreamLockManager | null {
  if (lockManagerOverride !== undefined) return lockManagerOverride
  if (typeof navigator === 'undefined') return null
  const locks = (navigator as unknown as { locks?: StreamLockManager }).locks
  return locks && typeof locks.request === 'function' ? locks : null
}

async function holdStreamOwnership(writer: ActiveLeaseWriter): Promise<void> {
  const manager = streamLockManager()
  if (!manager) return
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  writer.releaseOwnership = release
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let ownership: Promise<unknown>
  try {
    ownership = manager.request(
      streamOwnershipLockName(writer.input.streamId),
      { ifAvailable: true },
      async (lock) => {
        if (!lock) {
          rejectReady(new Error(`StreamLeaseAlreadyOwned:${writer.input.streamId}`))
          return
        }
        resolveReady()
        if (writer.closed) return
        await released
      },
    )
  } catch (error) {
    writer.releaseOwnership = null
    throw error
  }
  const task = ownership.then(
    () => {},
    () => {},
  )
  void ownership.catch((error) => rejectReady(error))
  streamOwnershipTasks.add(task)
  void task.finally(() => streamOwnershipTasks.delete(task))
  try {
    await ready
  } catch (error) {
    writer.releaseOwnership = null
    throw error
  }
}

function enqueueStreamOperation(
  streamId: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  const prior = streamOperationTails.get(streamId) ?? Promise.resolve()
  const result = prior.then(operation, operation).then(() => {})
  const tail = result.catch(() => {})
  streamOperationTails.set(streamId, tail)
  void tail.then(() => {
    if (streamOperationTails.get(streamId) === tail) streamOperationTails.delete(streamId)
  })
  return result
}

function closeLeaseWriter(streamId: string): ActiveLeaseWriter | undefined {
  const writer = activeLeaseWriters.get(streamId)
  if (!writer) return undefined
  writer.closed = true
  writer.nextHeartbeatAt = null
  activeLeaseWriters.delete(streamId)
  scheduleHeartbeatTimer()
  return writer
}

function pendingStreamOperations(streamId: string): Promise<void> {
  return streamOperationTails.get(streamId) ?? Promise.resolve()
}

function releaseOwnershipAfter(writer: ActiveLeaseWriter, operations: Promise<void>): void {
  void operations.finally(() => {
    writer.releaseOwnership?.()
    writer.releaseOwnership = null
  })
}

export async function __flushStreamLeaseWritesForTests(): Promise<void> {
  for (;;) {
    const pending = [...streamOperationTails.values()]
    if (pending.length === 0) return
    await Promise.all(pending)
  }
}

export async function __flushStreamOwnershipForTests(): Promise<void> {
  for (;;) {
    const pending = [...streamOwnershipTasks]
    if (pending.length === 0) return
    await Promise.all(pending)
  }
}

export function __setStreamLockManagerForTests(
  manager: StreamLockManager | null | undefined,
): void {
  lockManagerOverride = manager
}

export function __streamLeaseHeartbeatSchedulerStateForTests(): {
  activeWriters: number
  timerScheduled: boolean
  deadline: number | null
  wakeups: number
} {
  return {
    activeWriters: activeLeaseWriters.size,
    timerScheduled: heartbeatTimer !== null,
    deadline: heartbeatDeadline,
    wakeups: heartbeatSchedulerWakeups,
  }
}

export function __runStreamLeaseHeartbeatSchedulerForTests(now: number): void {
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  heartbeatDeadline = null
  runDueHeartbeats(now)
}

export function __resetStreamLeasesForTests(): void {
  unsubscribe?.()
  unsubscribe = null
  listenerInstalled = false
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  heartbeatDeadline = null
  heartbeatSchedulerWakeups = 0
  if (fallbackRefreshTimer !== null) clearInterval(fallbackRefreshTimer)
  fallbackRefreshTimer = null
  if (remoteExpiryTimer !== null) clearTimeout(remoteExpiryTimer)
  remoteExpiryTimer = null
  remoteExpiryDeadline = null
  refreshGeneration += 1
  refreshInFlight = null
  currentReplacementEpoch = 0
  remoteObservationRevision = 0
  remoteHeartbeatAtByStreamId.clear()
  remoteObservationRevisionByStreamId.clear()
  reportedExpiredStreamIds.clear()
  remoteExpiryHandlers.clear()
  for (const subscription of [...remoteOwnershipReleaseSubscriptions]) {
    stopRemoteOwnershipReleaseSubscription(subscription)
  }
  for (const streamId of activeLeaseWriters.keys()) {
    const writer = closeLeaseWriter(streamId)
    if (writer) releaseOwnershipAfter(writer, pendingStreamOperations(streamId))
  }
  endedStreamIds.clear()
  lockManagerOverride = undefined
}

import { useLayoutEffect, useRef, useState } from 'react'
import type { ChatId, Message, MessageId } from '../core/types'
import { useStreamStore } from '../store/zustand/streamStore'

type LiveSnapshot = NonNullable<
  ReturnType<typeof useStreamStore.getState>['liveByMessageId'][string]
>

interface RetainedLiveSnapshot {
  snapshot: LiveSnapshot
  baseNodeVersion: number
  generationWasStreaming: boolean
}

interface SharedRetainedLiveSnapshot extends RetainedLiveSnapshot {
  expiryTimer: ReturnType<typeof setTimeout> | null
}

interface SharedCommittedStream {
  streamId: string
  expiryTimer: ReturnType<typeof setTimeout>
}

const SHARED_RETENTION_MAX_ENTRIES = 8
const SHARED_RETENTION_MS = 15_000
const sharedRetainedByTarget = new Map<string, SharedRetainedLiveSnapshot>()
const sharedCommittedByTarget = new Map<string, SharedCommittedStream>()

function projectionKey(chatId: ChatId, messageId: MessageId): string {
  return `${chatId}\u0000${messageId}`
}

function newerRetainedSnapshot(
  left: RetainedLiveSnapshot | null,
  right: RetainedLiveSnapshot | null,
  preferredStreamId?: string,
): RetainedLiveSnapshot | null {
  if (!left) return right
  if (!right) return left
  const leftPreferred = left.snapshot.streamId === preferredStreamId
  const rightPreferred = right.snapshot.streamId === preferredStreamId
  if (leftPreferred !== rightPreferred) return leftPreferred ? left : right
  if (left.snapshot.updatedAt !== right.snapshot.updatedAt) {
    return left.snapshot.updatedAt > right.snapshot.updatedAt ? left : right
  }
  const leftLength = left.snapshot.textLength + left.snapshot.reasoningLength
  const rightLength = right.snapshot.textLength + right.snapshot.reasoningLength
  return leftLength > rightLength ? left : right
}

function clearSharedRetained(key: string, streamId?: string): void {
  const retained = sharedRetainedByTarget.get(key)
  if (!retained || (streamId !== undefined && retained.snapshot.streamId !== streamId)) return
  if (retained.expiryTimer !== null) clearTimeout(retained.expiryTimer)
  sharedRetainedByTarget.delete(key)
}

function evictOldestSharedRetained(): void {
  while (sharedRetainedByTarget.size > SHARED_RETENTION_MAX_ENTRIES) {
    const oldest = sharedRetainedByTarget.entries().next()
    if (oldest.done) return
    const [key, retained] = oldest.value
    if (retained.expiryTimer !== null) clearTimeout(retained.expiryTimer)
    sharedRetainedByTarget.delete(key)
  }
}

function retainForViewHandoff(key: string, retained: RetainedLiveSnapshot): void {
  const existing = sharedRetainedByTarget.get(key)
  if (existing?.expiryTimer !== null && existing?.expiryTimer !== undefined) {
    clearTimeout(existing.expiryTimer)
  }
  sharedRetainedByTarget.delete(key)
  sharedRetainedByTarget.set(key, { ...retained, expiryTimer: null })
  evictOldestSharedRetained()
}

function expireViewHandoffLater(key: string, streamId: string): void {
  const retained = sharedRetainedByTarget.get(key)
  if (!retained || retained.snapshot.streamId !== streamId || retained.expiryTimer !== null) return
  retained.expiryTimer = setTimeout(() => {
    clearSharedRetained(key, streamId)
  }, SHARED_RETENTION_MS)
}

function markSharedCommitted(key: string, streamId: string): void {
  const previous = sharedCommittedByTarget.get(key)
  if (previous) clearTimeout(previous.expiryTimer)
  const expiryTimer = setTimeout(() => {
    if (sharedCommittedByTarget.get(key)?.streamId === streamId) {
      sharedCommittedByTarget.delete(key)
    }
  }, SHARED_RETENTION_MS)
  sharedCommittedByTarget.set(key, { streamId, expiryTimer })
  while (sharedCommittedByTarget.size > SHARED_RETENTION_MAX_ENTRIES * 2) {
    const oldest = sharedCommittedByTarget.entries().next()
    if (oldest.done) break
    clearTimeout(oldest.value[1].expiryTimer)
    sharedCommittedByTarget.delete(oldest.value[0])
  }
}

function sharedStreamCommitted(key: string, streamId: string | undefined): boolean {
  return streamId !== undefined && sharedCommittedByTarget.get(key)?.streamId === streamId
}

export function __resetMessageStreamProjectionForTests(): void {
  for (const retained of sharedRetainedByTarget.values()) {
    if (retained.expiryTimer !== null) clearTimeout(retained.expiryTimer)
  }
  for (const committed of sharedCommittedByTarget.values()) clearTimeout(committed.expiryTimer)
  sharedRetainedByTarget.clear()
  sharedCommittedByTarget.clear()
}

function useMessageStreamProjection(chatId: ChatId, messageId: MessageId, enabled = true) {
  const activeStream = useStreamStore((state) =>
    enabled ? state.getTargetActive(chatId, messageId) : undefined,
  )
  const liveSnapshot = useStreamStore((state) =>
    enabled ? state.liveByMessageId[messageId] : undefined,
  )
  return [activeStream, liveSnapshot] as const
}

export function useRetainedMessageStreamProjection(message: Message, enabled = true) {
  const key = projectionKey(message.chatId, message.id)
  const [activeStream, currentLiveSnapshot] = useMessageStreamProjection(
    message.chatId,
    message.id,
    enabled,
  )
  const retainedLiveSnapshotRef = useRef<RetainedLiveSnapshot | null>(null)
  const committedLiveStreamIdRef = useRef<string | null>(null)
  const retentionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, setRetentionRevision] = useState(0)
  const retained = enabled
    ? newerRetainedSnapshot(
        retainedLiveSnapshotRef.current,
        sharedRetainedByTarget.get(key) ?? null,
        currentLiveSnapshot?.streamId ?? activeStream?.streamId,
      )
    : null
  const retainedSuperseded =
    retained !== null &&
    ((currentLiveSnapshot !== undefined &&
      currentLiveSnapshot.streamId !== retained.snapshot.streamId) ||
      (activeStream !== undefined && activeStream.streamId !== retained.snapshot.streamId))
  const retainedCommitted =
    retained !== null &&
    !retainedSuperseded &&
    message.nodeVersion > retained.baseNodeVersion &&
    (activeStream === undefined ||
      message.continuationAttempts?.some(
        (attempt) => attempt.streamId === retained.snapshot.streamId,
      ) === true ||
      (retained.generationWasStreaming &&
        message.generation?.status !== 'streaming' &&
        message.generation?.finishedAt !== undefined))
  const currentLiveSnapshotCommitted =
    currentLiveSnapshot?.streamId === committedLiveStreamIdRef.current ||
    sharedStreamCommitted(key, currentLiveSnapshot?.streamId)
  const liveSnapshot =
    retainedCommitted || currentLiveSnapshotCommitted
      ? undefined
      : (currentLiveSnapshot ?? (retainedSuperseded ? undefined : retained?.snapshot))

  useLayoutEffect(() => {
    if (!enabled) return
    if (retainedSuperseded) {
      clearSharedRetained(key, retained.snapshot.streamId)
      if (retainedLiveSnapshotRef.current?.snapshot.streamId === retained.snapshot.streamId) {
        retainedLiveSnapshotRef.current = null
      }
    }
    if (retainedCommitted) {
      committedLiveStreamIdRef.current = retained.snapshot.streamId
      markSharedCommitted(key, retained.snapshot.streamId)
      clearSharedRetained(key, retained.snapshot.streamId)
      retainedLiveSnapshotRef.current = null
    } else if (currentLiveSnapshot && !currentLiveSnapshotCommitted) {
      const current = newerRetainedSnapshot(
        retainedLiveSnapshotRef.current,
        sharedRetainedByTarget.get(key) ?? null,
        currentLiveSnapshot.streamId,
      )
      const next = {
        snapshot: currentLiveSnapshot,
        baseNodeVersion:
          current?.snapshot.streamId === currentLiveSnapshot.streamId
            ? activeStream && message.nodeVersion > current.baseNodeVersion
              ? message.nodeVersion
              : current.baseNodeVersion
            : message.nodeVersion,
        generationWasStreaming:
          current?.snapshot.streamId === currentLiveSnapshot.streamId
            ? current.generationWasStreaming
            : message.generation?.status === 'streaming' &&
              message.generation.finishedAt === undefined,
      }
      retainedLiveSnapshotRef.current = next
      retainForViewHandoff(key, next)
    } else if (!retainedSuperseded && retainedLiveSnapshotRef.current !== retained && retained) {
      retainedLiveSnapshotRef.current = retained
    }
    if (currentLiveSnapshot || activeStream || retainedCommitted) {
      if (retentionTimerRef.current !== null) clearTimeout(retentionTimerRef.current)
      retentionTimerRef.current = null
      return
    }
    if (retainedLiveSnapshotRef.current && retentionTimerRef.current === null) {
      expireViewHandoffLater(key, retainedLiveSnapshotRef.current.snapshot.streamId)
      retentionTimerRef.current = setTimeout(() => {
        const stale = retainedLiveSnapshotRef.current
        if (stale) {
          committedLiveStreamIdRef.current = stale.snapshot.streamId
          clearSharedRetained(key, stale.snapshot.streamId)
        }
        retainedLiveSnapshotRef.current = null
        retentionTimerRef.current = null
        setRetentionRevision((revision) => revision + 1)
      }, SHARED_RETENTION_MS)
    }
  }, [
    activeStream,
    currentLiveSnapshot,
    currentLiveSnapshotCommitted,
    enabled,
    key,
    message,
    retained,
    retainedCommitted,
    retainedSuperseded,
  ])
  useLayoutEffect(
    () => () => {
      if (retentionTimerRef.current !== null) clearTimeout(retentionTimerRef.current)
      if (!enabled) return
      const retained = retainedLiveSnapshotRef.current
      if (retained) expireViewHandoffLater(key, retained.snapshot.streamId)
    },
    [enabled, key],
  )

  return [activeStream, liveSnapshot] as const
}

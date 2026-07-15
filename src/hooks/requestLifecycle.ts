import { normalizeError } from '../api/errors'
import type { ChatId, GenerationMeta, MessageId } from '../core/types'
import { postEvent } from '../store/broadcast'
import type { StreamWriteFence } from '../store/repository'
import {
  announceStreamEnded,
  getStreamClientId,
  startStreamLease,
  stopStreamLease,
} from '../store/stream-leases'
import { useAnnouncementStore } from '../store/zustand/announcementStore'
import { useStreamStore } from '../store/zustand/streamStore'

interface RequestLifecycle {
  streamId: string
  messageId?: MessageId
  streamFence: StreamWriteFence
  replacementEpoch: number
  signal: AbortSignal
  abort: () => void
  publishTarget: () => void
  refreshLease: () => Promise<void>
  preserveLease: (reason?: 'content' | 'cleanup') => void
  end: (outcome: 'done' | 'error' | 'abort') => Promise<{ recoveryPending: boolean }>
}

type RequestLifecycleInput = {
  chatId: ChatId
  streamId: string
  originNavigationRevision?: string
  userSignal?: AbortSignal
} & (
  | { attemptKind: 'generation'; messageId: MessageId }
  | { attemptKind: 'continuation'; messageId: MessageId }
)

export async function startRequestLifecycle(
  args: RequestLifecycleInput,
): Promise<RequestLifecycle> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  let shouldPreserveLease = false
  let requiresContentRecovery = false
  let removeUserAbort: (() => void) | undefined
  const startedAt = Date.now()

  if (args.userSignal?.aborted) {
    controller.abort(args.userSignal.reason)
  } else if (args.userSignal) {
    const onAbort = () => controller.abort(args.userSignal?.reason)
    args.userSignal.addEventListener('abort', onAbort, { once: true })
    removeUserAbort = () => args.userSignal?.removeEventListener('abort', onAbort)
  }

  let fence: StreamWriteFence
  try {
    fence = await startStreamLease({
      streamId: args.streamId,
      chatId: args.chatId,
      ...(args.messageId ? { messageId: args.messageId } : {}),
      startedAt,
      attemptKind: args.attemptKind,
    })
  } catch (error) {
    removeUserAbort?.()
    await stopStreamLease(args.streamId)
    throw normalizeError(error, { midStream: false, cause: 'storage' })
  }
  useStreamStore.getState().setActive({
    streamId: args.streamId,
    chatId: args.chatId,
    ...(args.messageId ? { messageId: args.messageId } : {}),
    attemptKind: args.attemptKind,
    ...(args.originNavigationRevision
      ? { originNavigationRevision: args.originNavigationRevision }
      : {}),
    replacementEpoch: fence.replacementEpoch,
    ...(fence.admissionSequence !== undefined
      ? { admissionSequence: fence.admissionSequence }
      : {}),
    startedAt,
    heartbeatAt: startedAt,
    ownerClientId: getStreamClientId(),
    abort,
  })
  postEvent({
    kind: 'stream-started',
    chatId: args.chatId,
    streamId: args.streamId,
    ...(args.messageId ? { messageId: args.messageId } : {}),
    attemptKind: args.attemptKind,
    ownerClientId: getStreamClientId(),
    replacementEpoch: fence.replacementEpoch,
    ...(fence.admissionSequence !== undefined
      ? { admissionSequence: fence.admissionSequence }
      : {}),
  })

  return {
    streamId: args.streamId,
    ...(args.messageId ? { messageId: args.messageId } : {}),
    streamFence: fence,
    replacementEpoch: fence.replacementEpoch,
    signal: controller.signal,
    abort,
    publishTarget() {
      if (!args.messageId) return
      publishLifecycleTarget({
        chatId: args.chatId,
        streamId: args.streamId,
        messageId: args.messageId,
        abort,
        replacementEpoch: fence.replacementEpoch,
        ...(fence.admissionSequence !== undefined
          ? { admissionSequence: fence.admissionSequence }
          : {}),
        startedAt,
        attemptKind: args.attemptKind,
        ...(args.originNavigationRevision
          ? { originNavigationRevision: args.originNavigationRevision }
          : {}),
      })
    },
    async refreshLease() {
      try {
        await startStreamLease({
          streamId: args.streamId,
          chatId: args.chatId,
          ...(args.messageId ? { messageId: args.messageId } : {}),
          startedAt,
          attemptKind: args.attemptKind,
          replacementEpoch: fence.replacementEpoch,
        })
      } catch (error) {
        throw normalizeError(error, { midStream: false, cause: 'storage' })
      }
    },
    preserveLease(reason = 'content') {
      shouldPreserveLease = true
      if (reason === 'content') requiresContentRecovery = true
    },
    async end(outcome) {
      removeUserAbort?.()
      try {
        await stopStreamLease(args.streamId, { deleteRow: !shouldPreserveLease })
      } catch {
        shouldPreserveLease = true
      }
      const active = useStreamStore.getState().getActive(args.streamId)
      if (active?.replacementEpoch !== fence.replacementEpoch) {
        return { recoveryPending: false }
      }
      if (shouldPreserveLease) {
        const { abort: _abort, requestLiveSnapshot: _requestLiveSnapshot, ...recovering } = active
        useStreamStore.getState().setActive({
          ...recovering,
          phase: requiresContentRecovery ? 'recovery-pending' : 'cleanup-pending',
          recoveryOutcome: outcome,
        })
        return { recoveryPending: true }
      }
      announceStreamEnded({
        chatId: args.chatId,
        streamId: args.streamId,
        ...(args.messageId ? { messageId: args.messageId } : {}),
        outcome,
        replacementEpoch: fence.replacementEpoch,
      })
      return { recoveryPending: false }
    },
  }
}

function publishLifecycleTarget(args: {
  chatId: ChatId
  streamId: string
  messageId: MessageId
  abort: () => void
  replacementEpoch: number
  admissionSequence?: number
  startedAt: number
  attemptKind: 'generation' | 'continuation'
  originNavigationRevision?: string
}): void {
  useStreamStore.getState().setActive({
    streamId: args.streamId,
    chatId: args.chatId,
    messageId: args.messageId,
    attemptKind: args.attemptKind,
    ...(args.originNavigationRevision
      ? { originNavigationRevision: args.originNavigationRevision }
      : {}),
    replacementEpoch: args.replacementEpoch,
    ...(args.admissionSequence !== undefined ? { admissionSequence: args.admissionSequence } : {}),
    startedAt: args.startedAt,
    heartbeatAt: Date.now(),
    ownerClientId: getStreamClientId(),
    abort: args.abort,
  })
  postEvent({
    kind: 'stream-started',
    chatId: args.chatId,
    streamId: args.streamId,
    messageId: args.messageId,
    attemptKind: args.attemptKind,
    ownerClientId: getStreamClientId(),
    replacementEpoch: args.replacementEpoch,
    ...(args.admissionSequence !== undefined ? { admissionSequence: args.admissionSequence } : {}),
  })
  useAnnouncementStore.getState().announce({
    text: 'Assistant is responding.',
    eventKey: `stream-start:${args.streamId}`,
  })
}

export async function markLifecycleTarget(args: {
  chatId: ChatId
  streamId: string
  messageId: MessageId
  abort: () => void
  attemptKind: 'generation' | 'continuation'
  continuationStrategy?: 'prompt' | 'prefill'
  baseBodyVersion?: number
  baseNodeVersion?: number
  requestedModel?: string
  apiUsed?: GenerationMeta['apiUsed']
  replacementEpoch: number
}): Promise<StreamWriteFence> {
  const active = useStreamStore.getState().getActive(args.streamId)
  const startedAt = active?.startedAt ?? Date.now()
  const fence = await startStreamLease({
    streamId: args.streamId,
    chatId: args.chatId,
    messageId: args.messageId,
    startedAt,
    attemptKind: args.attemptKind,
    ...(args.continuationStrategy ? { continuationStrategy: args.continuationStrategy } : {}),
    ...(args.baseBodyVersion !== undefined ? { baseBodyVersion: args.baseBodyVersion } : {}),
    ...(args.baseNodeVersion !== undefined ? { baseNodeVersion: args.baseNodeVersion } : {}),
    ...(args.requestedModel ? { requestedModel: args.requestedModel } : {}),
    ...(args.apiUsed ? { apiUsed: args.apiUsed } : {}),
    replacementEpoch: args.replacementEpoch,
  })
  publishLifecycleTarget({
    chatId: args.chatId,
    streamId: args.streamId,
    messageId: args.messageId,
    abort: args.abort,
    replacementEpoch: fence.replacementEpoch,
    ...(fence.admissionSequence !== undefined
      ? { admissionSequence: fence.admissionSequence }
      : {}),
    startedAt,
    attemptKind: args.attemptKind,
    ...(active?.originNavigationRevision
      ? { originNavigationRevision: active.originNavigationRevision }
      : {}),
  })
  return fence
}

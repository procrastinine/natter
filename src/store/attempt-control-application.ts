import { newId } from '../lib/ulid'
import {
  type AttemptExecutionRecord,
  attemptController,
  type RequestableAttemptStopCapability,
} from './attempt-controller'
import { getStreamClientId, interruptClaimedLocalAttemptTransport } from './stream-leases'
import type { AttemptRequestStopResult } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceActionAtFence } from './workspace-runtime'

export interface AttemptStopRequest {
  readonly kind: 'attempt-stop-request'
  readonly requestId: string
  readonly streamId: string
  readonly claimed: boolean
  readonly completed: Promise<AttemptRequestStopResult>
}

export function requestAttemptStop(
  capability: RequestableAttemptStopCapability,
  requestedAt = Date.now(),
): AttemptStopRequest {
  const attempt = capability.attempt
  const requestId = newId()
  const claimed = attemptController.claimStopRequest(capability, { requestId, requestedAt })
  if (!claimed) {
    return Object.freeze({
      kind: 'attempt-stop-request',
      requestId,
      streamId: attempt.streamId,
      claimed: false,
      completed: Promise.resolve({ outcome: 'stale' } satisfies AttemptRequestStopResult),
    })
  }
  const input = Object.freeze({
    streamId: attempt.streamId,
    chatId: attempt.chatId,
    messageId: attempt.messageId,
    attemptKind: attempt.kind,
    replacementEpoch: attempt.replacementEpoch,
    admissionSequence: attempt.admissionSequence,
    requestId,
    requestedBy: getStreamClientId(),
    requestedAt,
    reason: 'user' as const,
  })
  interruptClaimedLocalAttemptTransport(claimed)
  const completed = runWorkspaceActionAtFence('stream-control', claimed, (permit) =>
    getWorkspaceRepository()
      .execute(permit, { kind: 'attempt.request-stop', input })
      .then((committed) => applyCommittedStopResult(claimed, committed.value)),
  )
  return Object.freeze({
    kind: 'attempt-stop-request',
    requestId,
    streamId: attempt.streamId,
    claimed: true,
    completed,
  })
}

function applyCommittedStopResult(
  requested: AttemptExecutionRecord,
  result: AttemptRequestStopResult,
): AttemptRequestStopResult {
  if (result.outcome === 'missing') {
    attemptController.removeStopRequest(requested)
    return result
  }
  if (result.outcome === 'stale') {
    if (!result.lease) attemptController.removeStopRequest(requested)
    else observeStopResultLease(requested, result.lease)
    return result
  }
  observeStopResultLease(requested, result.lease)
  return result
}

function observeStopResultLease(
  requested: AttemptExecutionRecord,
  lease: NonNullable<Exclude<AttemptRequestStopResult, { outcome: 'missing' }>['lease']>,
): void {
  attemptController.observeLease(lease, {
    workspaceId: requested.workspaceId,
  })
}

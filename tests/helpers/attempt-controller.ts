import type { ReasoningEnvelopeLiveProjection } from '../../src/core/reasoning-envelope'
import type { StreamAccumulatorLiveToolCallRow } from '../../src/core/stream-accumulator'
import type { ContentItem, GenerationMeta } from '../../src/core/types'
import type { LocalAttemptAuthority } from '../../src/store/attempt-availability'
import {
  type AttemptExecutionPhase,
  type AttemptKind,
  attemptController,
} from '../../src/store/attempt-controller'
import type {
  StreamLeaseRow,
  WorkspaceFence,
  WriterStreamLeaseRow,
} from '../../src/store/repository'
import { testContinuationLease, testGenerationLease } from './stream-leases'

let replacementEpoch = 0
let admissionSequence = 0

export function resetAttemptControllerForTests(): WorkspaceFence {
  replacementEpoch += 1
  admissionSequence = 0
  const fence = { workspaceId: `test-workspace-${replacementEpoch}`, replacementEpoch }
  attemptController.replaceWorkspace(fence)
  return fence
}

export function observeTestAttempt(input: {
  streamId: string
  chatId: string
  messageId: string
  local?: boolean
  ownerClientId?: string
  kind?: AttemptKind
  phase?: AttemptExecutionPhase
  requestLiveProjection?: () => Promise<void>
  admissionSequence?: number
  revision?: number
}): ReturnType<typeof attemptController.observeLease> {
  const fence = currentFence()
  admissionSequence = Math.max(admissionSequence + 1, input.admissionSequence ?? 0)
  const leaseInput = {
    streamId: input.streamId,
    chatId: input.chatId,
    messageId: input.messageId,
    ownerClientId: input.ownerClientId ?? (input.local === false ? 'remote-tab' : 'test-tab'),
    fenceToken: `fence-${input.streamId}`,
    replacementEpoch: fence.replacementEpoch,
    startedAt: admissionSequence,
    heartbeatAt: admissionSequence,
    admissionSequence,
    revision: input.revision ?? 1,
    targetCommittedAt: admissionSequence,
  }
  const lease: StreamLeaseRow =
    input.kind === 'continuation'
      ? testContinuationLease(leaseInput)
      : testGenerationLease(leaseInput)
  const local = input.local !== false
  const localAuthority: LocalAttemptAuthority = local
    ? {
        kind: 'writer',
        workspaceId: fence.workspaceId,
        lease: lease as WriterStreamLeaseRow,
      }
    : { kind: 'none' }
  const attempt = attemptController.observeLease(lease, {
    workspaceId: fence.workspaceId,
    localAuthority,
    ownershipLock: local
      ? { kind: 'unobserved' }
      : { kind: 'held-by-other', streamId: lease.streamId, observedAt: admissionSequence },
    ...(input.phase ? { phase: input.phase } : {}),
  })
  if (input.requestLiveProjection) {
    attemptController.setLiveProjectionRequester(input.streamId, input.requestLiveProjection)
  }
  return attempt
}

export function publishTestLiveProjection(input: {
  streamId: string
  chatId: string
  messageId: string
  attemptKind?: AttemptKind
  content: readonly ContentItem[]
  baseContent?: readonly ContentItem[]
  generation?: GenerationMeta
  reasoning?: ReasoningEnvelopeLiveProjection
  toolCallRows?: readonly StreamAccumulatorLiveToolCallRow[]
  textLength?: number
  reasoningLength?: number
  updatedAt?: number
}): boolean {
  const fence = currentFence()
  return attemptController.publishLiveProjection({
    ...fence,
    attemptKind: input.attemptKind ?? 'generation',
    streamId: input.streamId,
    chatId: input.chatId,
    messageId: input.messageId,
    content: input.content,
    ...(input.baseContent ? { baseContent: input.baseContent } : {}),
    ...(input.generation ? { generation: input.generation } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.toolCallRows ? { toolCallRows: input.toolCallRows } : {}),
    textLength: input.textLength ?? textLength(input.content),
    reasoningLength: input.reasoningLength ?? 0,
    updatedAt: input.updatedAt ?? Date.now(),
  })
}

export function removeTestAttempt(streamId: string): boolean {
  return attemptController.remove(streamId, currentFence())
}

export function clearTestLiveProjection(streamId: string): boolean {
  return attemptController.clearLiveProjection(streamId, currentFence())
}

function currentFence(): WorkspaceFence {
  const attempt = attemptController.listRecords()[0]
  if (attempt) {
    return { workspaceId: attempt.workspaceId, replacementEpoch: attempt.replacementEpoch }
  }
  return { workspaceId: `test-workspace-${replacementEpoch}`, replacementEpoch }
}

function textLength(content: readonly ContentItem[]): number {
  return content.reduce(
    (sum, item) =>
      item.type === 'text' || item.type === 'output_text' ? sum + item.text.length : sum,
    0,
  )
}

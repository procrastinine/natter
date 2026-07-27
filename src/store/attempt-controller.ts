import { useCallback, useSyncExternalStore } from 'react'
import type { ReasoningEnvelopeLiveProjection } from '../core/reasoning-envelope'
import type { StreamAccumulatorLiveToolCallRow } from '../core/stream-accumulator'
import type { ChatId, ContentItem, GenerationMeta, MessageId } from '../core/types'
import {
  type AttemptAvailability,
  type AttemptAvailabilityExecutionPhase,
  type AttemptOwnershipLockObservation,
  type AttemptStopIntent,
  type AttemptTargetAdmission,
  type LocalAttemptAuthority,
  reduceAttemptAvailability,
} from './attempt-availability'
import {
  type StreamLeaseRow,
  type StreamStopControl,
  streamLeaseOccupiesTarget,
  type WorkspaceFence,
} from './repository'
import { getLocalAttemptAuthority } from './stream-leases'

export type AttemptKind = 'generation' | 'continuation'

export type AttemptExecutionPhase = AttemptAvailabilityExecutionPhase

export interface TargetCommitHandoff extends WorkspaceFence {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly attemptKind: AttemptKind
  readonly admissionSequence: number
  readonly leaseRevision: number
  readonly bodyVersion: number
}

export interface ExactTargetPresentationReceipt extends WorkspaceFence {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly bodyVersion: number
}

export interface TargetPresentationInterest extends WorkspaceFence {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
}

interface AttemptRecordBase {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly kind: AttemptKind
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly admissionSequence: number
  readonly leaseRevision: number
  readonly startedAt: number
}

export interface AttemptExecutionRecord extends AttemptRecordBase {
  readonly phase: AttemptExecutionPhase
  readonly availability: AttemptAvailability
  readonly ownershipLock: AttemptOwnershipLockObservation
  readonly targetCommitHandoff?: never
  readonly requestLiveProjection?: () => Promise<void>
}

export interface AttemptPendingStopRequest {
  readonly requestId: string
  readonly requestedAt: number
}

export interface AttemptPresentationRecord extends AttemptRecordBase {
  readonly phase: 'awaiting-presentation'
  readonly targetCommitHandoff: TargetCommitHandoff
  readonly availability?: never
  readonly ownershipLock?: never
  readonly requestLiveProjection?: never
}

export type AttemptRecord = AttemptExecutionRecord | AttemptPresentationRecord

export type AttemptStopCapability =
  | {
      readonly kind: 'requestable'
      readonly attempt: AttemptExecutionRecord
    }
  | {
      readonly kind: 'requesting'
      readonly attempt: AttemptExecutionRecord
      readonly request: AttemptPendingStopRequest
    }
  | {
      readonly kind: 'requested'
      readonly attempt: AttemptExecutionRecord
      readonly control: StreamStopControl
    }

export type RequestableAttemptStopCapability = Extract<
  AttemptStopCapability,
  { kind: 'requestable' }
>

export interface ObserveAttemptLeaseOptions {
  readonly workspaceId: string
  readonly phase?: AttemptExecutionPhase
  readonly localAuthority?: LocalAttemptAuthority
  readonly ownershipLock?: AttemptOwnershipLockObservation
}

export type AttemptLocalMutation =
  | {
      readonly kind: 'observe-lease'
      readonly lease: StreamLeaseRow
      readonly options: ObserveAttemptLeaseOptions
    }
  | { readonly kind: 'set-phase'; readonly streamId: string; readonly phase: AttemptExecutionPhase }
  | { readonly kind: 'register-target-commit-handoff'; readonly handoff: TargetCommitHandoff }
  | {
      readonly kind: 'clear-live-projection'
      readonly streamId: string
      readonly fence: WorkspaceFence
    }
  | { readonly kind: 'remove'; readonly streamId: string; readonly fence: WorkspaceFence }

export interface AttemptLiveProjection {
  readonly attemptKind: AttemptKind
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly baseContent?: readonly ContentItem[]
  readonly content: readonly ContentItem[]
  readonly reasoning?: ReasoningEnvelopeLiveProjection
  readonly toolCallRows?: readonly StreamAccumulatorLiveToolCallRow[]
  readonly generation?: GenerationMeta
  readonly textLength: number
  readonly reasoningLength: number
  readonly updatedAt: number
}

export interface AttemptTargetSnapshot {
  readonly execution: AttemptExecutionRecord | undefined
  readonly presentation: AttemptPresentationRecord | undefined
  readonly liveProjection: AttemptLiveProjection | undefined
}

export interface AttemptTargetAdmissionFrame extends WorkspaceFence {
  readonly chatId: ChatId
  readonly revision: number
  admission(messageId: MessageId): AttemptTargetAdmission
}

export interface AttemptTargetAdmissionClaim extends WorkspaceFence {
  readonly claimId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
}

type AttemptListener = () => void

interface ChatLeaseCoverage extends WorkspaceFence {
  readonly state: 'pending' | 'ready'
  readonly occupiedTargetByStreamId: ReadonlyMap<string, MessageId>
}

export interface AttemptController {
  subscribeDemand(listener: AttemptListener): () => void
  subscribeChat(chatId: ChatId, listener: AttemptListener): () => void
  subscribeTarget(chatId: ChatId, messageId: MessageId, listener: AttemptListener): () => void
  observeLease(
    lease: StreamLeaseRow,
    options: ObserveAttemptLeaseOptions,
  ): AttemptRecord | undefined
  reconcileLeasePoints(
    fence: WorkspaceFence,
    streamIds: readonly string[],
    leases: readonly (StreamLeaseRow | undefined)[],
  ): void
  reconcileChatLeases(
    fence: WorkspaceFence,
    chatId: ChatId,
    leases: readonly StreamLeaseRow[],
  ): void
  getTargetAdmissionFrame(chatId: ChatId): AttemptTargetAdmissionFrame
  claimTarget(
    fence: WorkspaceFence,
    chatId: ChatId,
    messageId: MessageId,
    claimId: string,
  ): AttemptTargetAdmissionClaim | undefined
  releaseTargetClaim(claim: AttemptTargetAdmissionClaim): boolean
  demandedChatIds(): readonly ChatId[]
  pruneUndemandedRemoteAttempts(demandedChatIds: ReadonlySet<ChatId>): void
  registerTargetCommitHandoff(handoff: TargetCommitHandoff): AttemptRecord | undefined
  targetPresentationInterests(chatId: ChatId): readonly TargetPresentationInterest[]
  publishExactTargetPresentations(receipts: readonly ExactTargetPresentationReceipt[]): void
  claimStopRequest(
    capability: RequestableAttemptStopCapability,
    request: AttemptPendingStopRequest,
  ): AttemptExecutionRecord | undefined
  resetStopRequest(claimed: AttemptExecutionRecord): boolean
  removeStopRequest(claimed: AttemptExecutionRecord): boolean
  setPhase(streamId: string, phase: AttemptExecutionPhase): AttemptExecutionRecord | undefined
  setLiveProjectionRequester(
    streamId: string,
    requester: (() => Promise<void>) | undefined,
  ): AttemptRecord | undefined
  publishLiveProjection(projection: AttemptLiveProjection): boolean
  clearLiveProjection(streamId: string, fence: WorkspaceFence): boolean
  remove(streamId: string, fence: WorkspaceFence): boolean
  replaceWorkspace(fence: WorkspaceFence): void
  get(streamId: string): AttemptRecord | undefined
  getExecution(streamId: string): AttemptExecutionRecord | undefined
  getTargetSnapshot(chatId: ChatId, messageId: MessageId): AttemptTargetSnapshot
  hasTargetSubscribers(chatId: ChatId, messageId: MessageId): boolean
  listChatExecutions(chatId: ChatId): readonly AttemptExecutionRecord[]
  listExecutions(): readonly AttemptExecutionRecord[]
  listRecords(): readonly AttemptRecord[]
  isTargetExecuting(chatId: ChatId, messageId: MessageId): boolean
  applyLocalCommittedTransition<T>(
    mutations: readonly AttemptLocalMutation[],
    publishConversation: () => T,
  ): T
}

class TabAttemptController implements AttemptController {
  private workspaceFence: WorkspaceFence | null = null
  private readonly attempts = new Map<string, AttemptRecord>()
  private readonly streamIdsByChat = new Map<ChatId, Set<string>>()
  private readonly streamIdsByTarget = new Map<string, Set<string>>()
  private readonly selectedExecutionByTarget = new Map<string, AttemptExecutionRecord>()
  private readonly selectedPresentationByTarget = new Map<string, AttemptPresentationRecord>()
  private readonly liveByStreamId = new Map<string, AttemptLiveProjection>()
  private readonly publishedTargetBodyVersionByStreamId = new Map<string, number>()
  private readonly targetSnapshots = new Map<string, AttemptTargetSnapshot>()
  private readonly leaseCoverageByChat = new Map<ChatId, ChatLeaseCoverage>()
  private readonly targetAdmissionClaims = new Map<string, AttemptTargetAdmissionClaim>()
  private readonly targetAdmissionFrames = new Map<ChatId, AttemptTargetAdmissionFrame>()
  private readonly dirtyTargetAdmissionFrames = new Set<ChatId>()
  private targetAdmissionRevision = 0
  private readonly demandListeners = new Set<AttemptListener>()
  private readonly chatDemandCounts = new Map<ChatId, number>()
  private demandedChatSnapshot: readonly ChatId[] = EMPTY_CHAT_IDS
  private readonly chatListeners = new Map<ChatId, Set<AttemptListener>>()
  private readonly targetListeners = new Map<string, Set<AttemptListener>>()
  private readonly chatExecutionSnapshots = new Map<ChatId, readonly AttemptExecutionRecord[]>()
  private readonly dirtyChatSnapshots = new Set<ChatId>()
  private batchDepth = 0
  private readonly notifyChats = new Set<ChatId>()
  private readonly notifyTargets = new Set<string>()

  subscribeDemand(listener: AttemptListener): () => void {
    this.demandListeners.add(listener)
    return () => this.demandListeners.delete(listener)
  }

  subscribeChat(chatId: ChatId, listener: AttemptListener): () => void {
    this.retainChatDemand(chatId)
    const unsubscribe = subscribeKeyed(this.chatListeners, chatId, listener)
    return () => {
      unsubscribe()
      this.releaseChatDemand(chatId)
    }
  }

  subscribeTarget(chatId: ChatId, messageId: MessageId, listener: AttemptListener): () => void {
    const key = targetKey(chatId, messageId)
    this.retainChatDemand(chatId)
    const firstSubscriber = !this.targetListeners.has(key)
    const unsubscribe = subscribeKeyed(this.targetListeners, key, listener)
    if (firstSubscriber) {
      const requester = this.selectedExecutionByTarget.get(key)?.requestLiveProjection
      if (requester) void requester().catch(() => {})
    }
    return () => {
      unsubscribe()
      this.releaseChatDemand(chatId)
      if (!this.targetListeners.has(key)) this.clearLiveProjectionsForTarget(key)
    }
  }

  observeLease(
    lease: StreamLeaseRow,
    options: ObserveAttemptLeaseOptions,
  ): AttemptRecord | undefined {
    const incomingFence = {
      workspaceId: options.workspaceId,
      replacementEpoch: lease.replacementEpoch,
    }
    const workspaceFence = this.workspaceFence
    if (
      workspaceFence !== null &&
      workspaceFence.workspaceId === incomingFence.workspaceId &&
      workspaceFence.replacementEpoch > incomingFence.replacementEpoch
    ) {
      return this.attempts.get(lease.streamId)
    }
    if (!this.workspaceFence || !sameWorkspaceFence(this.workspaceFence, incomingFence)) {
      this.replaceWorkspace(incomingFence)
    }
    const current = this.attempts.get(lease.streamId)
    if (
      current &&
      current.workspaceId === options.workspaceId &&
      (current.replacementEpoch > lease.replacementEpoch ||
        (current.replacementEpoch === lease.replacementEpoch &&
          (current.admissionSequence > lease.admissionSequence ||
            (current.admissionSequence === lease.admissionSequence &&
              current.leaseRevision > lease.revision))))
    ) {
      return current
    }
    const coveredLeaseChanged = this.observeCoveredLease(lease, incomingFence)
    if (!leaseRepresentsActiveAttempt(lease)) {
      const handoff = targetCommitHandoffFromLease(lease, options.workspaceId)
      if (current && handoff) return this.registerTargetCommitHandoff(handoff)
      if (current) this.remove(current.streamId, current)
      else if (coveredLeaseChanged) this.notify(lease.chatId, lease.messageId)
      return undefined
    }
    const sameAttempt =
      current !== undefined &&
      current.workspaceId === options.workspaceId &&
      current.replacementEpoch === lease.replacementEpoch &&
      current.admissionSequence === lease.admissionSequence
    const currentExecution = isAttemptExecution(current) ? current : undefined
    const sameLeaseRevision = sameAttempt && currentExecution?.leaseRevision === lease.revision
    const localAuthority = options.localAuthority ?? getLocalAttemptAuthority(lease.streamId)
    const ownershipLock =
      options.ownershipLock ??
      (sameLeaseRevision ? currentExecution.ownershipLock : UNOBSERVED_OWNERSHIP_LOCK)
    const retainedPhase =
      sameAttempt && currentExecution && attemptAvailabilityIsLocal(currentExecution.availability)
        ? currentExecution.phase
        : undefined
    const inferredLocalPhase =
      localAuthority.kind === 'writer'
        ? lease.phase === 'active'
          ? 'streaming'
          : lease.phase === 'terminal-decided'
            ? 'finalizing'
            : 'admitted'
        : undefined
    const requestedPhase = options.phase ?? retainedPhase ?? inferredLocalPhase
    const stopIntent =
      sameAttempt && currentExecution
        ? stopIntentFromAvailability(currentExecution.availability)
        : undefined
    const availability = reduceAttemptAvailability(currentExecution?.availability, {
      workspace: incomingFence,
      lease: { kind: 'present', lease },
      localAuthority,
      ...(requestedPhase ? { localExecutionPhase: requestedPhase } : {}),
      ownershipLock,
      ...(stopIntent ? { stopIntent } : {}),
      wallNow: Date.now(),
      schedulerNow: attemptSchedulerNow(),
      ...(currentExecution?.availability.freshness
        ? { previousFreshness: currentExecution.availability.freshness }
        : {}),
    })
    const phase = executionPhaseFromAvailability(availability, lease, requestedPhase)
    const requestLiveProjection =
      sameAttempt && attemptAvailabilityIsLocal(availability)
        ? currentExecution?.requestLiveProjection
        : undefined
    if (
      current &&
      current.streamId === lease.streamId &&
      current.chatId === lease.chatId &&
      current.messageId === lease.messageId &&
      current.kind === lease.attemptKind &&
      current.workspaceId === options.workspaceId &&
      current.replacementEpoch === lease.replacementEpoch &&
      current.admissionSequence === lease.admissionSequence &&
      current.leaseRevision === lease.revision &&
      current.startedAt === lease.startedAt &&
      current.phase === phase &&
      isAttemptExecution(current) &&
      sameOwnershipLock(current.ownershipLock, ownershipLock) &&
      sameAttemptAvailability(current.availability, availability) &&
      current.requestLiveProjection === requestLiveProjection
    ) {
      return current
    }
    const next = Object.freeze({
      streamId: lease.streamId,
      chatId: lease.chatId,
      messageId: lease.messageId,
      kind: lease.attemptKind,
      workspaceId: options.workspaceId,
      replacementEpoch: lease.replacementEpoch,
      admissionSequence: lease.admissionSequence,
      leaseRevision: lease.revision,
      startedAt: lease.startedAt,
      phase,
      availability,
      ownershipLock,
      ...(requestLiveProjection ? { requestLiveProjection } : {}),
    }) satisfies AttemptExecutionRecord
    this.replaceRecord(current, next)
    return next
  }

  reconcileLeasePoints(
    fence: WorkspaceFence,
    streamIds: readonly string[],
    leases: readonly (StreamLeaseRow | undefined)[],
  ): void {
    if (workspaceFenceIsOlder(fence, this.workspaceFence)) return
    this.batch(() => {
      if (!this.workspaceFence || !sameWorkspaceFence(this.workspaceFence, fence)) {
        this.replaceWorkspace(fence)
      }
      for (let index = 0; index < streamIds.length; index += 1) {
        const streamId = streamIds[index]
        if (!streamId) continue
        const lease = leases[index]
        if (
          !lease ||
          lease.streamId !== streamId ||
          lease.replacementEpoch !== fence.replacementEpoch
        ) {
          const coveredChatId = this.removeCoveredLease(streamId)
          if (!this.attempts.get(streamId)?.targetCommitHandoff) {
            const removed = this.remove(streamId, fence)
            if (!removed && coveredChatId) this.notify(coveredChatId)
          }
          continue
        }
        this.observeLease(lease, { workspaceId: fence.workspaceId })
      }
    })
  }

  reconcileChatLeases(
    fence: WorkspaceFence,
    chatId: ChatId,
    leases: readonly StreamLeaseRow[],
  ): void {
    if (workspaceFenceIsOlder(fence, this.workspaceFence)) return
    this.batch(() => {
      if (!this.workspaceFence || !sameWorkspaceFence(this.workspaceFence, fence)) {
        this.replaceWorkspace(fence)
      }
      this.replaceChatLeaseCoverage(fence, chatId, leases)
      const retained = new Set<string>()
      for (const lease of leases) {
        if (lease.chatId !== chatId || lease.replacementEpoch !== fence.replacementEpoch) continue
        retained.add(lease.streamId)
        this.observeLease(lease, { workspaceId: fence.workspaceId })
      }
      for (const streamId of [...(this.streamIdsByChat.get(chatId) ?? [])]) {
        if (!retained.has(streamId) && !this.attempts.get(streamId)?.targetCommitHandoff) {
          this.remove(streamId, fence)
        }
      }
    })
  }

  getTargetAdmissionFrame(chatId: ChatId): AttemptTargetAdmissionFrame {
    if (this.dirtyTargetAdmissionFrames.has(chatId) || !this.targetAdmissionFrames.has(chatId)) {
      this.refreshTargetAdmissionFrame(chatId)
    }
    const frame = this.targetAdmissionFrames.get(chatId)
    if (!frame) throw new Error(`AttemptTargetAdmissionFrameMissing:${chatId}`)
    return frame
  }

  claimTarget(
    fence: WorkspaceFence,
    chatId: ChatId,
    messageId: MessageId,
    claimId: string,
  ): AttemptTargetAdmissionClaim | undefined {
    if (!this.workspaceFence || !sameWorkspaceFence(this.workspaceFence, fence)) return undefined
    if (this.getTargetAdmissionFrame(chatId).admission(messageId) !== 'available') return undefined
    const key = targetKey(chatId, messageId)
    if (this.targetAdmissionClaims.has(key)) return undefined
    const claim = Object.freeze({ ...fence, claimId, chatId, messageId })
    this.targetAdmissionClaims.set(key, claim)
    this.invalidateTargetAdmission(chatId)
    this.notify(chatId, messageId)
    return claim
  }

  releaseTargetClaim(claim: AttemptTargetAdmissionClaim): boolean {
    const key = targetKey(claim.chatId, claim.messageId)
    const current = this.targetAdmissionClaims.get(key)
    if (current !== claim) return false
    this.targetAdmissionClaims.delete(key)
    this.invalidateTargetAdmission(claim.chatId)
    this.notify(claim.chatId, claim.messageId)
    return true
  }

  demandedChatIds(): readonly ChatId[] {
    return this.demandedChatSnapshot
  }

  pruneUndemandedRemoteAttempts(demandedChatIds: ReadonlySet<ChatId>): void {
    this.batch(() => {
      for (const attempt of [...this.attempts.values()]) {
        if (demandedChatIds.has(attempt.chatId)) continue
        if (isAttemptExecution(attempt) && attemptAvailabilityIsLocal(attempt.availability))
          continue
        this.remove(attempt.streamId, attempt)
      }
    })
  }

  registerTargetCommitHandoff(handoff: TargetCommitHandoff): AttemptRecord | undefined {
    return this.batch(() => {
      const current = this.attempts.get(handoff.streamId)
      if (!current) return undefined
      if (workspaceFenceIsOlder(handoff, this.workspaceFence)) return current
      if (
        !sameWorkspaceFence(current, handoff) ||
        current.chatId !== handoff.chatId ||
        current.messageId !== handoff.messageId ||
        current.kind !== handoff.attemptKind ||
        current.admissionSequence !== handoff.admissionSequence
      ) {
        throw new Error(`AttemptTargetCommitHandoffIdentityInvalid:${handoff.streamId}`)
      }
      const priorHandoff = current.targetCommitHandoff
      if (priorHandoff && priorHandoff.bodyVersion !== handoff.bodyVersion) {
        throw new Error(`AttemptTargetCommitHandoffConflict:${handoff.streamId}`)
      }
      if (current.leaseRevision > handoff.leaseRevision) return current
      if (!this.hasTargetSubscribers(handoff.chatId, handoff.messageId)) {
        this.remove(handoff.streamId, current)
        return undefined
      }
      if (
        (this.publishedTargetBodyVersionByStreamId.get(handoff.streamId) ?? -1) >=
        handoff.bodyVersion
      ) {
        this.remove(handoff.streamId, current)
        return undefined
      }
      const accepted = Object.freeze({ ...handoff })
      if (
        current.phase === 'awaiting-presentation' &&
        current.leaseRevision === handoff.leaseRevision &&
        current.targetCommitHandoff.bodyVersion === handoff.bodyVersion
      ) {
        return current
      }
      return this.patch(handoff.streamId, (attempt) => {
        const {
          requestLiveProjection: _requestLiveProjection,
          availability: _availability,
          ownershipLock: _ownershipLock,
          targetCommitHandoff: _targetCommitHandoff,
          ...retained
        } = attempt
        return Object.freeze({
          ...retained,
          phase: 'awaiting-presentation',
          leaseRevision: Math.max(attempt.leaseRevision, handoff.leaseRevision),
          targetCommitHandoff: accepted,
        }) satisfies AttemptPresentationRecord
      })
    })
  }

  targetPresentationInterests(chatId: ChatId): readonly TargetPresentationInterest[] {
    return Object.freeze(
      [...(this.streamIdsByChat.get(chatId) ?? [])].flatMap((streamId) => {
        const attempt = this.attempts.get(streamId)
        return attempt?.phase === 'awaiting-presentation' &&
          this.hasTargetSubscribers(attempt.chatId, attempt.messageId)
          ? [
              Object.freeze({
                streamId: attempt.streamId,
                chatId: attempt.chatId,
                messageId: attempt.messageId,
                workspaceId: attempt.workspaceId,
                replacementEpoch: attempt.replacementEpoch,
              }),
            ]
          : []
      }),
    )
  }

  publishExactTargetPresentations(receipts: readonly ExactTargetPresentationReceipt[]): void {
    this.batch(() => {
      for (const receipt of receipts) {
        const current = this.attempts.get(receipt.streamId)
        if (!current || !sameWorkspaceFence(current, receipt)) continue
        if (current.chatId !== receipt.chatId || current.messageId !== receipt.messageId) {
          throw new Error(`AttemptTargetPresentationIdentityInvalid:${receipt.streamId}`)
        }
        const prior = this.publishedTargetBodyVersionByStreamId.get(receipt.streamId) ?? -1
        if (receipt.bodyVersion > prior) {
          this.publishedTargetBodyVersionByStreamId.set(receipt.streamId, receipt.bodyVersion)
        }
        const handoff = current.targetCommitHandoff
        if (handoff && receipt.bodyVersion >= handoff.bodyVersion) {
          this.remove(receipt.streamId, current)
        }
      }
    })
  }

  claimStopRequest(
    capability: RequestableAttemptStopCapability,
    request: AttemptPendingStopRequest,
  ): AttemptExecutionRecord | undefined {
    const current = this.getExecution(capability.attempt.streamId)
    if (
      !current ||
      !sameAttemptIdentityProjection(
        current.availability.identity,
        capability.attempt.availability.identity,
      ) ||
      attemptStopCapability(current)?.kind !== 'requestable'
    ) {
      return undefined
    }
    const stop = current.availability.stop
    if (stop.kind !== 'requestable') return undefined
    const intent: AttemptStopIntent = Object.freeze({
      ...stop.identity,
      requestId: request.requestId,
      requestedAt: request.requestedAt,
    })
    return this.patchExecution(current.streamId, (attempt) =>
      reduceExecutionRecord(attempt, {
        phase: attempt.phase,
        stopIntent: intent,
      }),
    )
  }

  removeStopRequest(claimed: AttemptExecutionRecord): boolean {
    const current = this.getExecution(claimed.streamId)
    return samePendingStopClaim(current, claimed) ? this.remove(current.streamId, current) : false
  }

  resetStopRequest(claimed: AttemptExecutionRecord): boolean {
    const current = this.getExecution(claimed.streamId)
    if (!samePendingStopClaim(current, claimed)) return false
    return (
      this.patchExecution(current.streamId, (attempt) =>
        reduceExecutionRecord(attempt, {
          phase: attempt.phase,
          stopIntent: null,
        }),
      ) !== undefined
    )
  }

  setPhase(streamId: string, phase: AttemptExecutionPhase): AttemptExecutionRecord | undefined {
    return this.patchExecution(streamId, (current) => reduceExecutionRecord(current, { phase }))
  }

  setLiveProjectionRequester(
    streamId: string,
    requester: (() => Promise<void>) | undefined,
  ): AttemptExecutionRecord | undefined {
    const previous = this.getExecution(streamId)
    const next = this.patchExecution(
      streamId,
      (current) => {
        if (current.requestLiveProjection === requester) return current
        const next = { ...current }
        if (requester) next.requestLiveProjection = requester
        else delete next.requestLiveProjection
        return Object.freeze(next)
      },
      true,
    )
    if (
      requester &&
      (!previous || previous.requestLiveProjection !== requester) &&
      next !== undefined &&
      this.hasTargetSubscribers(next.chatId, next.messageId)
    ) {
      void requester().catch(() => {})
    }
    return next
  }

  publishLiveProjection(projection: AttemptLiveProjection): boolean {
    const attempt = this.attempts.get(projection.streamId)
    const key = targetKey(projection.chatId, projection.messageId)
    const selected = isAttemptExecution(attempt)
      ? this.selectedExecutionByTarget.get(key)
      : this.selectedPresentationByTarget.get(key)
    if (
      !attempt ||
      selected?.streamId !== attempt.streamId ||
      attempt.chatId !== projection.chatId ||
      attempt.messageId !== projection.messageId ||
      attempt.workspaceId !== projection.workspaceId ||
      attempt.replacementEpoch !== projection.replacementEpoch ||
      !this.hasTargetSubscribers(projection.chatId, projection.messageId)
    ) {
      return false
    }
    this.liveByStreamId.set(projection.streamId, Object.freeze(projection))
    this.queueTargetNotification(key)
    return true
  }

  clearLiveProjection(streamId: string, fence: WorkspaceFence): boolean {
    const current = this.liveByStreamId.get(streamId)
    if (!current || !sameWorkspaceFence(current, fence)) return false
    this.liveByStreamId.delete(streamId)
    const key = targetKey(current.chatId, current.messageId)
    this.queueTargetNotification(key)
    return true
  }

  remove(streamId: string, fence: WorkspaceFence): boolean {
    const current = this.attempts.get(streamId)
    if (!current || !sameWorkspaceFence(current, fence)) return false
    this.attempts.delete(streamId)
    this.liveByStreamId.delete(streamId)
    this.publishedTargetBodyVersionByStreamId.delete(streamId)
    this.removeIndexes(current)
    this.removeSelectedRecord(current)
    this.markSnapshotsDirty(current.chatId)
    if (recordOccupiesAttemptTarget(current)) this.invalidateTargetAdmission(current.chatId)
    this.notify(current.chatId, current.messageId)
    return true
  }

  replaceWorkspace(fence: WorkspaceFence): void {
    if (workspaceFenceIsOlder(fence, this.workspaceFence)) return
    this.batch(() => {
      const affectedChats = new Set<ChatId>([
        ...this.chatDemandCounts.keys(),
        ...this.leaseCoverageByChat.keys(),
        ...[...this.targetAdmissionClaims.values()].map((claim) => claim.chatId),
      ])
      this.workspaceFence = Object.freeze({ ...fence })
      for (const attempt of [...this.attempts.values()]) {
        if (sameWorkspaceFence(attempt, fence)) continue
        this.remove(attempt.streamId, attempt)
      }
      for (const projection of this.liveByStreamId.values()) {
        this.queueTargetNotification(targetKey(projection.chatId, projection.messageId))
      }
      this.liveByStreamId.clear()
      this.targetAdmissionClaims.clear()
      this.leaseCoverageByChat.clear()
      for (const chatId of this.chatDemandCounts.keys()) {
        this.leaseCoverageByChat.set(chatId, pendingChatLeaseCoverage(fence))
      }
      for (const chatId of affectedChats) {
        this.invalidateTargetAdmission(chatId)
        this.notifyChats.add(chatId)
      }
    })
  }

  get(streamId: string): AttemptRecord | undefined {
    return this.attempts.get(streamId)
  }

  getExecution(streamId: string): AttemptExecutionRecord | undefined {
    const attempt = this.attempts.get(streamId)
    return isAttemptExecution(attempt) ? attempt : undefined
  }

  getTargetSnapshot(chatId: ChatId, messageId: MessageId): AttemptTargetSnapshot {
    const key = targetKey(chatId, messageId)
    let snapshot = this.targetSnapshots.get(key)
    if (!snapshot) {
      this.refreshTargetSnapshot(key)
      snapshot = this.targetSnapshots.get(key)
    }
    return snapshot ?? EMPTY_TARGET_SNAPSHOT
  }

  hasTargetSubscribers(chatId: ChatId, messageId: MessageId): boolean {
    return (this.targetListeners.get(targetKey(chatId, messageId))?.size ?? 0) > 0
  }

  listChatExecutions(chatId: ChatId): readonly AttemptExecutionRecord[] {
    if (this.dirtyChatSnapshots.has(chatId)) this.refreshChatSnapshot(chatId)
    return this.chatExecutionSnapshots.get(chatId) ?? EMPTY_EXECUTIONS
  }

  listExecutions(): readonly AttemptExecutionRecord[] {
    return Object.freeze([...this.attempts.values()].filter(isAttemptExecution))
  }

  listRecords(): readonly AttemptRecord[] {
    return Object.freeze([...this.attempts.values()])
  }

  isTargetExecuting(chatId: ChatId, messageId: MessageId): boolean {
    for (const streamId of this.streamIdsByTarget.get(targetKey(chatId, messageId)) ?? []) {
      if (isAttemptExecution(this.attempts.get(streamId))) return true
    }
    return false
  }

  applyLocalCommittedTransition<T>(
    mutations: readonly AttemptLocalMutation[],
    publishConversation: () => T,
  ): T {
    return this.batch(() => {
      for (const mutation of mutations) {
        switch (mutation.kind) {
          case 'observe-lease':
            this.observeLease(mutation.lease, mutation.options)
            break
          case 'set-phase':
            this.setPhase(mutation.streamId, mutation.phase)
            break
          case 'register-target-commit-handoff':
            this.registerTargetCommitHandoff(mutation.handoff)
            break
          case 'clear-live-projection':
            this.clearLiveProjection(mutation.streamId, mutation.fence)
            break
          case 'remove':
            this.remove(mutation.streamId, mutation.fence)
            break
        }
      }
      return publishConversation()
    })
  }

  private patch(
    streamId: string,
    update: (current: AttemptRecord) => AttemptRecord,
    targetOnly = false,
  ): AttemptRecord | undefined {
    const current = this.attempts.get(streamId)
    if (!current) return undefined
    const next = update(current)
    if (next === current) return current
    this.replaceRecord(current, next, targetOnly)
    return next
  }

  private patchExecution(
    streamId: string,
    update: (current: AttemptExecutionRecord) => AttemptExecutionRecord,
    targetOnly = false,
  ): AttemptExecutionRecord | undefined {
    const current = this.attempts.get(streamId)
    if (!isAttemptExecution(current)) return undefined
    const next = update(current)
    if (next === current) return current
    this.replaceRecord(current, next, targetOnly)
    return next
  }

  private replaceRecord(
    current: AttemptRecord | undefined,
    next: AttemptRecord,
    targetOnly = false,
  ): void {
    const indexChanged =
      !current || current.chatId !== next.chatId || current.messageId !== next.messageId
    if (current && indexChanged) this.removeIndexes(current)
    this.attempts.set(next.streamId, next)
    if (indexChanged) {
      addIndex(this.streamIdsByChat, next.chatId, next.streamId)
      if (next.messageId) {
        addIndex(this.streamIdsByTarget, targetKey(next.chatId, next.messageId), next.streamId)
      }
    }
    this.replaceSelectedRecords(current, next, indexChanged)
    this.markSnapshotsDirty(next.chatId)
    if (current && current.chatId !== next.chatId) this.markSnapshotsDirty(current.chatId)
    if (
      !current ||
      current.chatId !== next.chatId ||
      current.messageId !== next.messageId ||
      recordOccupiesAttemptTarget(current) !== recordOccupiesAttemptTarget(next)
    ) {
      this.invalidateTargetAdmission(next.chatId)
      if (current && current.chatId !== next.chatId) {
        this.invalidateTargetAdmission(current.chatId)
      }
    }
    this.notify(next.chatId, next.messageId, current?.messageId, targetOnly, current?.chatId)
  }

  private removeIndexes(attempt: AttemptRecord): void {
    removeIndex(this.streamIdsByChat, attempt.chatId, attempt.streamId)
    if (attempt.messageId) {
      removeIndex(
        this.streamIdsByTarget,
        targetKey(attempt.chatId, attempt.messageId),
        attempt.streamId,
      )
    }
  }

  private replaceSelectedRecords(
    current: AttemptRecord | undefined,
    next: AttemptRecord,
    indexChanged: boolean,
  ): void {
    const previousKey = current?.messageId
      ? targetKey(current.chatId, current.messageId)
      : undefined
    const nextKey = next.messageId ? targetKey(next.chatId, next.messageId) : undefined
    const laneChanged =
      current !== undefined && isAttemptExecution(current) !== isAttemptExecution(next)
    if (current && previousKey && (indexChanged || previousKey !== nextKey || laneChanged)) {
      this.removeSelectedRecordAtKey(current, previousKey)
    }
    if (!nextKey) return
    const selected = isAttemptExecution(next)
      ? this.selectedExecutionByTarget.get(nextKey)
      : this.selectedPresentationByTarget.get(nextKey)
    if (selected?.streamId === next.streamId || !selected || attemptIsNewer(next, selected)) {
      if (isAttemptExecution(next)) this.setSelectedExecution(nextKey, next)
      else this.setSelectedPresentation(nextKey, next)
    }
  }

  private removeSelectedRecord(attempt: AttemptRecord): void {
    if (!attempt.messageId) return
    this.removeSelectedRecordAtKey(attempt, targetKey(attempt.chatId, attempt.messageId))
  }

  private removeSelectedRecordAtKey(attempt: AttemptRecord, key: string): void {
    if (isAttemptExecution(attempt)) {
      if (this.selectedExecutionByTarget.get(key)?.streamId === attempt.streamId) {
        this.recomputeSelectedExecution(key)
      }
      return
    }
    if (this.selectedPresentationByTarget.get(key)?.streamId === attempt.streamId) {
      this.recomputeSelectedPresentation(key)
    }
  }

  private recomputeSelectedExecution(key: string): void {
    let selected: AttemptExecutionRecord | undefined
    for (const streamId of this.streamIdsByTarget.get(key) ?? []) {
      const attempt = this.attempts.get(streamId)
      if (isAttemptExecution(attempt) && (!selected || attemptIsNewer(attempt, selected))) {
        selected = attempt
      }
    }
    this.setSelectedExecution(key, selected)
  }

  private recomputeSelectedPresentation(key: string): void {
    let selected: AttemptPresentationRecord | undefined
    for (const streamId of this.streamIdsByTarget.get(key) ?? []) {
      const attempt = this.attempts.get(streamId)
      if (
        attempt?.phase === 'awaiting-presentation' &&
        (!selected || attemptIsNewer(attempt, selected))
      ) {
        selected = attempt
      }
    }
    this.setSelectedPresentation(key, selected)
  }

  private setSelectedExecution(key: string, attempt: AttemptExecutionRecord | undefined): void {
    const previous = this.selectedExecutionByTarget.get(key)
    if (previous && previous.streamId !== attempt?.streamId) {
      const retained = this.attempts.get(previous.streamId)
      if (retained?.phase !== 'awaiting-presentation') {
        this.liveByStreamId.delete(previous.streamId)
      }
    }
    if (attempt) this.selectedExecutionByTarget.set(key, attempt)
    else this.selectedExecutionByTarget.delete(key)
  }

  private setSelectedPresentation(
    key: string,
    attempt: AttemptPresentationRecord | undefined,
  ): void {
    const previous = this.selectedPresentationByTarget.get(key)
    if (previous && previous.streamId !== attempt?.streamId) {
      const retained = this.attempts.get(previous.streamId)
      if (!isAttemptExecution(retained)) this.liveByStreamId.delete(previous.streamId)
    }
    if (attempt) this.selectedPresentationByTarget.set(key, attempt)
    else this.selectedPresentationByTarget.delete(key)
  }

  private notify(
    chatId: ChatId,
    messageId?: MessageId,
    previousMessageId?: MessageId,
    targetOnly = false,
    previousChatId = chatId,
  ): void {
    if (messageId) this.notifyTargets.add(targetKey(chatId, messageId))
    if (previousMessageId && previousMessageId !== messageId) {
      this.notifyTargets.add(targetKey(previousChatId, previousMessageId))
    }
    if (!targetOnly) {
      this.notifyChats.add(chatId)
      if (previousChatId !== chatId) this.notifyChats.add(previousChatId)
    }
    this.flushNotifications()
  }

  private refreshTargetSnapshot(key: string): void {
    const execution = this.selectedExecutionByTarget.get(key)
    const presentation = this.selectedPresentationByTarget.get(key)
    const liveProjection =
      (execution ? this.liveByStreamId.get(execution.streamId) : undefined) ??
      (presentation ? this.liveByStreamId.get(presentation.streamId) : undefined)
    if (!execution && !presentation && !liveProjection) {
      this.targetSnapshots.delete(key)
      return
    }
    const previous = this.targetSnapshots.get(key)
    if (
      previous !== undefined &&
      previous.execution === execution &&
      previous.presentation === presentation &&
      previous.liveProjection === liveProjection
    ) {
      return
    }
    this.targetSnapshots.set(key, Object.freeze({ execution, presentation, liveProjection }))
  }

  private refreshChatSnapshot(chatId: ChatId): void {
    const ids = this.streamIdsByChat.get(chatId)
    if (!ids) {
      this.chatExecutionSnapshots.delete(chatId)
      this.dirtyChatSnapshots.delete(chatId)
      return
    }
    this.chatExecutionSnapshots.set(
      chatId,
      Object.freeze(
        [...ids]
          .map((streamId) => this.attempts.get(streamId))
          .filter(isAttemptExecution)
          .sort((left, right) => left.admissionSequence - right.admissionSequence),
      ),
    )
    this.dirtyChatSnapshots.delete(chatId)
  }

  private markSnapshotsDirty(chatId: ChatId): void {
    if (this.streamIdsByChat.has(chatId)) {
      this.dirtyChatSnapshots.add(chatId)
    } else {
      this.chatExecutionSnapshots.delete(chatId)
      this.dirtyChatSnapshots.delete(chatId)
    }
  }

  private queueTargetNotification(key: string): void {
    this.notifyTargets.add(key)
    this.flushNotifications()
  }

  private batch<T>(operation: () => T): T {
    this.batchDepth += 1
    try {
      return operation()
    } finally {
      this.batchDepth -= 1
      this.flushNotifications()
    }
  }

  private flushNotifications(): void {
    if (this.batchDepth > 0) return
    const chats = [...this.notifyChats]
    const targets = [...this.notifyTargets]
    this.notifyChats.clear()
    this.notifyTargets.clear()
    for (const key of targets) this.refreshTargetSnapshot(key)
    for (const chatId of chats) notifyKeyed(this.chatListeners, chatId)
    for (const key of targets) notifyKeyed(this.targetListeners, key)
  }

  private clearLiveProjectionsForTarget(key: string): void {
    for (const streamId of [...(this.streamIdsByTarget.get(key) ?? [])]) {
      this.liveByStreamId.delete(streamId)
      const attempt = this.attempts.get(streamId)
      if (attempt?.targetCommitHandoff) this.remove(streamId, attempt)
    }
    this.refreshTargetSnapshot(key)
  }

  private replaceChatLeaseCoverage(
    fence: WorkspaceFence,
    chatId: ChatId,
    leases: readonly StreamLeaseRow[],
  ): void {
    if (!this.chatDemandCounts.has(chatId)) return
    const occupiedTargetByStreamId = new Map<string, MessageId>()
    for (const lease of leases) {
      if (
        lease.chatId === chatId &&
        lease.replacementEpoch === fence.replacementEpoch &&
        leaseTargetAdmission(lease) === 'occupied'
      ) {
        occupiedTargetByStreamId.set(lease.streamId, lease.messageId)
      }
    }
    this.leaseCoverageByChat.set(
      chatId,
      Object.freeze({ ...fence, state: 'ready' as const, occupiedTargetByStreamId }),
    )
    this.invalidateTargetAdmission(chatId)
    this.notifyChats.add(chatId)
  }

  private observeCoveredLease(lease: StreamLeaseRow, fence: WorkspaceFence): boolean {
    const coverage = this.leaseCoverageByChat.get(lease.chatId)
    if (!coverage || !sameWorkspaceFence(coverage, fence)) return false
    const previous = coverage.occupiedTargetByStreamId.get(lease.streamId)
    const next = leaseTargetAdmission(lease) === 'occupied' ? lease.messageId : undefined
    if (previous === next) return false
    const occupiedTargetByStreamId = new Map(coverage.occupiedTargetByStreamId)
    if (next) occupiedTargetByStreamId.set(lease.streamId, next)
    else occupiedTargetByStreamId.delete(lease.streamId)
    this.leaseCoverageByChat.set(
      lease.chatId,
      Object.freeze({ ...coverage, occupiedTargetByStreamId }),
    )
    this.invalidateTargetAdmission(lease.chatId)
    return true
  }

  private removeCoveredLease(streamId: string): ChatId | undefined {
    for (const [chatId, coverage] of this.leaseCoverageByChat) {
      if (!coverage.occupiedTargetByStreamId.has(streamId)) continue
      const occupiedTargetByStreamId = new Map(coverage.occupiedTargetByStreamId)
      occupiedTargetByStreamId.delete(streamId)
      this.leaseCoverageByChat.set(chatId, Object.freeze({ ...coverage, occupiedTargetByStreamId }))
      this.invalidateTargetAdmission(chatId)
      return chatId
    }
    return undefined
  }

  private invalidateTargetAdmission(chatId: ChatId): void {
    if (!this.chatDemandCounts.has(chatId) && !this.chatRequiresAdmissionFrame(chatId)) {
      this.targetAdmissionFrames.delete(chatId)
      this.dirtyTargetAdmissionFrames.delete(chatId)
      return
    }
    this.dirtyTargetAdmissionFrames.add(chatId)
  }

  private chatRequiresAdmissionFrame(chatId: ChatId): boolean {
    if ((this.streamIdsByChat.get(chatId)?.size ?? 0) > 0) return true
    for (const claim of this.targetAdmissionClaims.values()) {
      if (claim.chatId === chatId) return true
    }
    return false
  }

  private refreshTargetAdmissionFrame(chatId: ChatId): void {
    const fence = this.workspaceFence
    if (!fence) {
      this.targetAdmissionFrames.set(
        chatId,
        Object.freeze({
          workspaceId: '',
          replacementEpoch: -1,
          chatId,
          revision: ++this.targetAdmissionRevision,
          admission: (): AttemptTargetAdmission => 'unknown',
        }),
      )
      this.dirtyTargetAdmissionFrames.delete(chatId)
      return
    }
    const occupied = new Set<MessageId>()
    const coverage = this.leaseCoverageByChat.get(chatId)
    if (coverage && sameWorkspaceFence(coverage, fence)) {
      for (const messageId of coverage.occupiedTargetByStreamId.values()) occupied.add(messageId)
    }
    for (const streamId of this.streamIdsByChat.get(chatId) ?? []) {
      const attempt = this.attempts.get(streamId)
      if (attempt && recordOccupiesAttemptTarget(attempt)) occupied.add(attempt.messageId)
    }
    for (const claim of this.targetAdmissionClaims.values()) {
      if (claim.chatId === chatId && sameWorkspaceFence(claim, fence)) occupied.add(claim.messageId)
    }
    const coverageReady = coverage?.state === 'ready' && sameWorkspaceFence(coverage, fence)
    const revision = ++this.targetAdmissionRevision
    const frame = Object.freeze({
      ...fence,
      chatId,
      revision,
      admission: (messageId: MessageId): AttemptTargetAdmission =>
        occupied.has(messageId) ? 'occupied' : coverageReady ? 'available' : 'unknown',
    }) satisfies AttemptTargetAdmissionFrame
    this.targetAdmissionFrames.set(chatId, frame)
    this.dirtyTargetAdmissionFrames.delete(chatId)
  }

  private retainChatDemand(chatId: ChatId): void {
    const count = this.chatDemandCounts.get(chatId) ?? 0
    this.chatDemandCounts.set(chatId, count + 1)
    if (count !== 0) return
    if (this.workspaceFence) {
      this.leaseCoverageByChat.set(chatId, pendingChatLeaseCoverage(this.workspaceFence))
    }
    this.invalidateTargetAdmission(chatId)
    this.publishDemandSnapshot()
  }

  private releaseChatDemand(chatId: ChatId): void {
    const count = this.chatDemandCounts.get(chatId)
    if (count === undefined) return
    if (count > 1) {
      this.chatDemandCounts.set(chatId, count - 1)
      return
    }
    this.chatDemandCounts.delete(chatId)
    this.leaseCoverageByChat.delete(chatId)
    this.invalidateTargetAdmission(chatId)
    this.publishDemandSnapshot()
  }

  private publishDemandSnapshot(): void {
    this.demandedChatSnapshot = Object.freeze([...this.chatDemandCounts.keys()].sort())
    for (const listener of [...this.demandListeners]) listener()
  }
}

const EMPTY_EXECUTIONS = Object.freeze([]) as readonly AttemptExecutionRecord[]
const EMPTY_CHAT_IDS = Object.freeze([]) as readonly ChatId[]
const EMPTY_TARGET_SNAPSHOT: AttemptTargetSnapshot = Object.freeze({
  execution: undefined,
  presentation: undefined,
  liveProjection: undefined,
})

function pendingChatLeaseCoverage(fence: WorkspaceFence): ChatLeaseCoverage {
  return Object.freeze({
    ...fence,
    state: 'pending',
    occupiedTargetByStreamId: new Map<string, MessageId>(),
  })
}

function leaseTargetAdmission(lease: StreamLeaseRow): AttemptTargetAdmission {
  return streamLeaseOccupiesTarget(lease) ? 'occupied' : 'available'
}

function recordOccupiesAttemptTarget(attempt: AttemptRecord): boolean {
  return isAttemptExecution(attempt) && attempt.availability.targetAdmission === 'occupied'
}

export function createAttemptController(): AttemptController {
  return new TabAttemptController()
}

export const attemptController: AttemptController = createAttemptController()

export function useAttemptExecutionsForChat(
  chatId: ChatId | null,
  enabled = true,
): readonly AttemptExecutionRecord[] {
  const subscribe = useCallback(
    (listener: AttemptListener) =>
      enabled && chatId ? attemptController.subscribeChat(chatId, listener) : () => undefined,
    [chatId, enabled],
  )
  const getSnapshot = useCallback(
    () => (enabled && chatId ? attemptController.listChatExecutions(chatId) : EMPTY_EXECUTIONS),
    [chatId, enabled],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useAttemptTargetAdmissionFrame(
  chatId: ChatId | null,
  enabled = true,
): AttemptTargetAdmissionFrame | null {
  const subscribe = useCallback(
    (listener: AttemptListener) =>
      enabled && chatId ? attemptController.subscribeChat(chatId, listener) : () => undefined,
    [chatId, enabled],
  )
  const getSnapshot = useCallback(
    () => (enabled && chatId ? attemptController.getTargetAdmissionFrame(chatId) : null),
    [chatId, enabled],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useAttemptTargetSnapshot(
  chatId: ChatId,
  messageId: MessageId,
  enabled = true,
): AttemptTargetSnapshot {
  const subscribe = useCallback(
    (listener: AttemptListener) =>
      enabled ? attemptController.subscribeTarget(chatId, messageId, listener) : () => undefined,
    [chatId, enabled, messageId],
  )
  const getSnapshot = useCallback(
    () =>
      enabled ? attemptController.getTargetSnapshot(chatId, messageId) : EMPTY_TARGET_SNAPSHOT,
    [chatId, enabled, messageId],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function mostRecentlyAdmittedAttempt(
  attempts: readonly AttemptExecutionRecord[],
): AttemptExecutionRecord | undefined {
  let selected: AttemptExecutionRecord | undefined
  for (const attempt of attempts) {
    if (!selected || attempt.admissionSequence > selected.admissionSequence) selected = attempt
  }
  return selected
}

export function targetCommitHandoffFromLease(
  lease: StreamLeaseRow,
  workspaceId: string,
): TargetCommitHandoff | null {
  if (lease.phase !== 'canonical' && lease.phase !== 'metadata-committed') return null
  const bodyVersion = lease.postCommit.final.expectedBodyVersion
  if (bodyVersion === undefined) return null
  return Object.freeze({
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    attemptKind: lease.attemptKind,
    workspaceId,
    replacementEpoch: lease.replacementEpoch,
    admissionSequence: lease.admissionSequence,
    leaseRevision: lease.revision,
    bodyVersion,
  })
}

function targetKey(chatId: ChatId, messageId: MessageId): string {
  return `${chatId}\u0000target\u0000${messageId}`
}

function addIndex<Key>(map: Map<Key, Set<string>>, key: Key, streamId: string): void {
  const ids = map.get(key)
  if (ids) ids.add(streamId)
  else map.set(key, new Set([streamId]))
}

function removeIndex<Key>(map: Map<Key, Set<string>>, key: Key, streamId: string): void {
  const ids = map.get(key)
  if (!ids) return
  ids.delete(streamId)
  if (ids.size === 0) map.delete(key)
}

function subscribeKeyed<Key>(
  map: Map<Key, Set<AttemptListener>>,
  key: Key,
  listener: AttemptListener,
): () => void {
  const listeners = map.get(key)
  if (listeners) listeners.add(listener)
  else map.set(key, new Set([listener]))
  return () => {
    const current = map.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) map.delete(key)
  }
}

function notifyKeyed<Key>(map: Map<Key, Set<AttemptListener>>, key: Key): void {
  const listeners = map.get(key)
  if (!listeners) return
  for (const listener of [...listeners]) listener()
}

function leaseRepresentsActiveAttempt(lease: StreamLeaseRow): boolean {
  return (
    lease.phase === 'reserved' || lease.phase === 'active' || lease.phase === 'terminal-decided'
  )
}

function attemptIsNewer(left: AttemptRecord, right: AttemptRecord): boolean {
  return (
    left.admissionSequence > right.admissionSequence ||
    (left.admissionSequence === right.admissionSequence && left.streamId > right.streamId)
  )
}

function executionPhaseFromAvailability(
  availability: AttemptAvailability,
  lease: StreamLeaseRow,
  requestedPhase?: AttemptExecutionPhase,
): AttemptExecutionPhase {
  if (!attemptAvailabilityIsLocal(availability)) return 'recovery-pending'
  if (availability.state === 'terminalizing') return 'finalizing'
  if (requestedPhase) return requestedPhase
  return lease.phase === 'active' ? 'streaming' : 'admitted'
}

function attemptAvailabilityIsLocal(availability: AttemptAvailability): boolean {
  return (
    availability.state === 'reserved' ||
    availability.state === 'local-executing' ||
    (availability.state === 'terminalizing' && availability.recovery.kind === 'none')
  )
}

function stopIntentFromAvailability(
  availability: AttemptAvailability,
): AttemptStopIntent | undefined {
  return availability.stop.kind === 'reconcile' ? availability.stop.intent : undefined
}

function reduceExecutionRecord(
  current: AttemptExecutionRecord,
  input: {
    readonly phase: AttemptExecutionPhase
    readonly stopIntent?: AttemptStopIntent | null
  },
): AttemptExecutionRecord {
  const lease = current.availability.lease
  if (!lease) return current
  const retainedStopIntent = stopIntentFromAvailability(current.availability)
  const availability = reduceAttemptAvailability(current.availability, {
    workspace: current,
    lease: { kind: 'present', lease },
    localAuthority: getLocalAttemptAuthority(current.streamId),
    localExecutionPhase: input.phase,
    ownershipLock: current.ownershipLock,
    ...(input.stopIntent
      ? { stopIntent: input.stopIntent }
      : input.stopIntent !== null && retainedStopIntent
        ? { stopIntent: retainedStopIntent }
        : {}),
    wallNow: Date.now(),
    schedulerNow: attemptSchedulerNow(),
    ...(current.availability.freshness
      ? { previousFreshness: current.availability.freshness }
      : {}),
  })
  const phase = executionPhaseFromAvailability(availability, lease, input.phase)
  if (current.phase === phase && sameAttemptAvailability(current.availability, availability)) {
    return current
  }
  return Object.freeze({ ...current, phase, availability })
}

export function isAttemptExecution(
  attempt: AttemptRecord | undefined,
): attempt is AttemptExecutionRecord {
  return attempt !== undefined && attempt.phase !== 'awaiting-presentation'
}

export function attemptStopCapability(
  attempt: AttemptExecutionRecord | undefined,
): AttemptStopCapability | undefined {
  if (!attempt) return undefined
  const stop = attempt.availability.stop
  switch (stop.kind) {
    case 'requestable':
      return Object.freeze({ kind: 'requestable', attempt })
    case 'reconcile':
      return Object.freeze({
        kind: 'requesting',
        attempt,
        request: Object.freeze({
          requestId: stop.intent.requestId,
          requestedAt: stop.intent.requestedAt,
        }),
      })
    case 'requested':
      return Object.freeze({ kind: 'requested', attempt, control: stop.control })
    case 'settled':
    case 'unavailable':
      return undefined
  }
}

function samePendingStopClaim(
  current: AttemptExecutionRecord | undefined,
  claimed: AttemptExecutionRecord,
): current is AttemptExecutionRecord {
  const currentIntent = current ? stopIntentFromAvailability(current.availability) : undefined
  const claimedIntent = stopIntentFromAvailability(claimed.availability)
  return Boolean(
    current &&
      current.workspaceId === claimed.workspaceId &&
      current.replacementEpoch === claimed.replacementEpoch &&
      current.chatId === claimed.chatId &&
      current.messageId === claimed.messageId &&
      current.kind === claimed.kind &&
      current.admissionSequence === claimed.admissionSequence &&
      currentIntent &&
      claimedIntent &&
      currentIntent.requestId === claimedIntent.requestId &&
      currentIntent.requestedAt === claimedIntent.requestedAt,
  )
}

const UNOBSERVED_OWNERSHIP_LOCK = Object.freeze({ kind: 'unobserved' } as const)

function attemptSchedulerNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

function sameOwnershipLock(
  left: AttemptOwnershipLockObservation,
  right: AttemptOwnershipLockObservation,
): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'held-by-other' && right.kind === 'held-by-other') {
    return left.streamId === right.streamId
  }
  if (left.kind === 'acquired-for-recovery' && right.kind === 'acquired-for-recovery') {
    return left.streamId === right.streamId
  }
  return true
}

function sameAttemptAvailability(left: AttemptAvailability, right: AttemptAvailability): boolean {
  return (
    left.state === right.state &&
    left.presentation === right.presentation &&
    left.blocksReplacement === right.blocksReplacement &&
    sameAttemptIdentityProjection(left.identity, right.identity) &&
    sameStopAvailability(left.stop, right.stop) &&
    sameRecoveryDirective(left.recovery, right.recovery) &&
    left.freshness?.epoch === right.freshness?.epoch &&
    left.freshness?.fresh === right.freshness?.fresh
  )
}

function sameAttemptIdentityProjection(
  left: AttemptAvailability['identity'],
  right: AttemptAvailability['identity'],
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.workspaceId === right.workspaceId &&
      left.replacementEpoch === right.replacementEpoch &&
      left.streamId === right.streamId &&
      left.chatId === right.chatId &&
      left.messageId === right.messageId &&
      left.attemptKind === right.attemptKind &&
      left.admissionSequence === right.admissionSequence)
  )
}

function sameStopAvailability(
  left: AttemptAvailability['stop'],
  right: AttemptAvailability['stop'],
): boolean {
  if (left.kind !== right.kind) return false
  if (!('identity' in left) || !('identity' in right)) return true
  if (!sameAttemptIdentityProjection(left.identity, right.identity)) return false
  if (left.kind === 'reconcile' && right.kind === 'reconcile') {
    return (
      left.intent.requestId === right.intent.requestId &&
      left.intent.requestedAt === right.intent.requestedAt
    )
  }
  if (left.kind === 'requested' && right.kind === 'requested') {
    return (
      left.control.requestId === right.control.requestId &&
      left.control.requestedBy === right.control.requestedBy &&
      left.control.requestedAt === right.control.requestedAt
    )
  }
  return true
}

function sameRecoveryDirective(
  left: AttemptAvailability['recovery'],
  right: AttemptAvailability['recovery'],
): boolean {
  if (left.kind !== right.kind) return false
  if (!('identity' in left) || !('identity' in right)) return true
  return sameAttemptIdentityProjection(left.identity, right.identity)
}

function sameWorkspaceFence(left: WorkspaceFence, right: WorkspaceFence): boolean {
  return left.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}

function workspaceFenceIsOlder(candidate: WorkspaceFence, current: WorkspaceFence | null): boolean {
  return (
    current !== null &&
    candidate.workspaceId === current.workspaceId &&
    candidate.replacementEpoch < current.replacementEpoch
  )
}

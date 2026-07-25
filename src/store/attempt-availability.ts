import type { ChatId, MessageId } from '../core/types'
import {
  type StreamLeaseAdmission,
  type StreamLeaseRow,
  type StreamStopControl,
  streamLeaseOccupiesTarget,
  type WorkspaceFence,
  type WriterStreamLeaseRow,
} from './repository'
import {
  observeStreamLeaseFreshness,
  type StreamLeaseFreshnessObservation,
  streamLeaseRecoveryAuthority,
} from './stream-lease-policy'

export type AttemptAvailabilityExecutionPhase =
  | 'admitted'
  | 'preparing'
  | 'planning'
  | 'dispatching'
  | 'streaming'
  | 'finalizing'
  | 'recovery-pending'

export interface AttemptIdentity extends WorkspaceFence {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly attemptKind: StreamLeaseRow['attemptKind']
  readonly admissionSequence: number
}

export interface AttemptReservationIdentity extends WorkspaceFence {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly attemptKind: StreamLeaseRow['attemptKind']
  readonly admissionSequence?: never
}

export interface AttemptStopIntent extends AttemptIdentity {
  readonly requestId: string
  readonly requestedAt: number
}

export type AttemptLeaseObservation =
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'present'; lease: StreamLeaseRow }>

export type LocalAttemptAuthority =
  | Readonly<{ kind: 'none' }>
  | Readonly<{
      kind: 'reservation'
      workspaceId: string
      admission: StreamLeaseAdmission
    }>
  | Readonly<{
      kind: 'writer'
      workspaceId: string
      lease: WriterStreamLeaseRow
    }>

export type AttemptOwnershipLockObservation =
  | Readonly<{ kind: 'unobserved' }>
  | Readonly<{ kind: 'unsupported' }>
  | Readonly<{ kind: 'held-by-other'; streamId: string; observedAt: number }>
  | Readonly<{ kind: 'acquired-for-recovery'; streamId: string }>

export type AttemptStopAvailability =
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'requestable'; identity: AttemptIdentity }>
  | Readonly<{
      kind: 'reconcile'
      identity: AttemptIdentity
      intent: AttemptStopIntent
    }>
  | Readonly<{
      kind: 'requested'
      identity: AttemptIdentity
      control: StreamStopControl
    }>
  | Readonly<{ kind: 'settled'; identity: AttemptIdentity }>

export type AttemptRecoveryDirective =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'probe-lock'; identity: AttemptIdentity }>
  | Readonly<{
      kind: 'wait-owner-release'
      identity: AttemptIdentity
      deadline: number
    }>
  | Readonly<{ kind: 'claim'; identity: AttemptIdentity }>

export type AttemptAvailabilityState =
  | 'unknown'
  | 'provisional'
  | 'reserved'
  | 'local-executing'
  | 'remote-executing'
  | 'terminalizing'
  | 'reconciling'
  | 'settled'

export type AttemptTargetAdmission = 'unknown' | 'occupied' | 'available'

export interface AttemptAvailability {
  readonly identity: AttemptIdentity | AttemptReservationIdentity | null
  readonly state: AttemptAvailabilityState
  readonly lease?: StreamLeaseRow
  readonly presentation: 'none' | 'local-streaming' | 'remote-streaming'
  readonly stop: AttemptStopAvailability
  readonly recovery: AttemptRecoveryDirective
  readonly targetAdmission: AttemptTargetAdmission
  readonly blocksReplacement: boolean
  readonly freshness?: StreamLeaseFreshnessObservation
}

export interface AttemptAvailabilityInput {
  readonly workspace: WorkspaceFence
  readonly lease: AttemptLeaseObservation
  readonly localAuthority: LocalAttemptAuthority
  readonly localExecutionPhase?: AttemptAvailabilityExecutionPhase
  readonly ownershipLock: AttemptOwnershipLockObservation
  readonly stopIntent?: AttemptStopIntent
  readonly wallNow: number
  readonly schedulerNow: number
  readonly previousFreshness?: Pick<StreamLeaseFreshnessObservation, 'epoch' | 'deadline'>
}

export interface RecoveryPendingStreamLeaseSeedInput {
  readonly lease: StreamLeaseRow
  readonly replacementEpoch: number
  readonly handedOffAt: number
}

const NO_STOP = Object.freeze({ kind: 'unavailable' } as const)
const NO_RECOVERY = Object.freeze({ kind: 'none' } as const)

export function reduceAttemptAvailability(
  previous: AttemptAvailability | undefined,
  input: AttemptAvailabilityInput,
): AttemptAvailability {
  const localAuthority = authorityInWorkspace(input.localAuthority, input.workspace)
  const lock = lockForExpectedStream(input.ownershipLock, expectedStreamId(input, previous))
  if (input.lease.kind === 'unknown') {
    return reduceUnknownAvailability(previous, input, localAuthority)
  }
  if (input.lease.kind === 'absent') {
    return reduceAbsentAvailability(input, localAuthority)
  }
  const lease = input.lease.lease
  if (lease.replacementEpoch !== input.workspace.replacementEpoch) {
    return reduceUnknownAvailability(previous, input, localAuthority)
  }

  const identity = identityFromLease(input.workspace, lease)
  const freshness = observeStreamLeaseFreshness(
    lease,
    input.wallNow,
    input.schedulerNow,
    input.previousFreshness,
  )
  const stopIntent = sameAttemptIdentity(input.stopIntent, identity) ? input.stopIntent : undefined
  const localWriter = exactLocalWriter(localAuthority, input.workspace, lease)

  if (lease.phase === 'canonical' || lease.phase === 'metadata-committed') {
    const recovery = localWriter ? NO_RECOVERY : recoveryDirective(identity, lease, lock, freshness)
    return Object.freeze({
      identity,
      state: 'settled',
      lease,
      presentation: 'none',
      stop: Object.freeze({ kind: 'settled', identity }),
      recovery,
      targetAdmission: streamLeaseOccupiesTarget(lease) ? 'occupied' : 'available',
      blocksReplacement: false,
      freshness,
    })
  }

  const terminalizing = lease.phase === 'terminal-decided'
  const stop = lease.stopControl
    ? Object.freeze({ kind: 'requested', identity, control: lease.stopControl } as const)
    : stopIntent
      ? Object.freeze({ kind: 'reconcile', identity, intent: stopIntent } as const)
      : Object.freeze({ kind: 'requestable', identity } as const)

  if (terminalizing) {
    return Object.freeze({
      identity,
      state: 'terminalizing',
      lease,
      presentation: 'none',
      stop,
      recovery: localWriter ? NO_RECOVERY : recoveryDirective(identity, lease, lock, freshness),
      targetAdmission: 'occupied',
      blocksReplacement: true,
      freshness,
    })
  }

  if (localWriter) {
    const executionPhase = input.localExecutionPhase
    const finalizing = executionPhase === 'finalizing'
    return Object.freeze({
      identity,
      state: finalizing
        ? 'terminalizing'
        : lease.phase === 'reserved'
          ? 'reserved'
          : 'local-executing',
      lease,
      presentation:
        lease.phase === 'active' && executionPhase === 'streaming' ? 'local-streaming' : 'none',
      stop,
      recovery: NO_RECOVERY,
      targetAdmission: 'occupied',
      blocksReplacement: true,
      freshness,
    })
  }

  const recovery = recoveryDirective(identity, lease, lock, freshness)
  const remotelyOwned = lease.custody === 'writer' && lock.kind === 'held-by-other'
  return Object.freeze({
    identity,
    state:
      recovery.kind === 'claim'
        ? 'reconciling'
        : remotelyOwned
          ? 'remote-executing'
          : 'provisional',
    lease,
    presentation: remotelyOwned && lease.phase === 'active' ? 'remote-streaming' : 'none',
    stop,
    recovery,
    targetAdmission: 'occupied',
    blocksReplacement: true,
    freshness,
  })
}

export function seedRecoveryPendingStreamLease(
  input: RecoveryPendingStreamLeaseSeedInput,
): StreamLeaseRow {
  const lease = input.lease
  if (lease.phase !== 'reserved' && lease.phase !== 'active') {
    throw new Error(`RecoveryPendingSeedTerminalLease:${lease.streamId}:${lease.phase}`)
  }
  const handoffId = `migration:${input.replacementEpoch}:${lease.streamId}:${lease.admissionSequence}`
  if (
    lease.custody === 'recovery-pending' &&
    lease.replacementEpoch === input.replacementEpoch &&
    lease.handoffId === handoffId &&
    lease.handedOffAt === input.handedOffAt &&
    lease.handoffReason === 'owner-unavailable' &&
    lease.controlRevision === 0 &&
    lease.stopControl === undefined
  ) {
    return lease
  }
  const {
    custody: _custody,
    ownerClientId: _ownerClientId,
    fenceToken: _fenceToken,
    heartbeatAt: _heartbeatAt,
    handoffId: _handoffId,
    handedOffAt: _handedOffAt,
    handoffReason: _handoffReason,
    stopControl: _stopControl,
    ...retained
  } = lease
  return Object.freeze({
    ...retained,
    replacementEpoch: input.replacementEpoch,
    custody: 'recovery-pending',
    handoffId,
    handedOffAt: input.handedOffAt,
    handoffReason: 'owner-unavailable',
    revision: lease.revision >= Number.MAX_SAFE_INTEGER ? 1 : Math.max(0, lease.revision) + 1,
    controlRevision: 0,
  })
}

function reduceUnknownAvailability(
  previous: AttemptAvailability | undefined,
  input: AttemptAvailabilityInput,
  localAuthority: LocalAttemptAuthority,
): AttemptAvailability {
  const reservation = reservationIdentity(localAuthority, input.workspace)
  if (reservation) {
    return Object.freeze({
      identity: reservation,
      state: 'reserved',
      presentation: 'none',
      stop: NO_STOP,
      recovery: NO_RECOVERY,
      targetAdmission: 'occupied',
      blocksReplacement: true,
    })
  }
  if (previous && previous.state !== 'settled') {
    const stopIntent = exactStopIntentForAvailability(input.stopIntent, previous)
    if (!stopIntent || !isExactAttemptIdentity(previous.identity)) return previous
    return Object.freeze({
      ...previous,
      stop: Object.freeze({
        kind: 'reconcile',
        identity: previous.identity,
        intent: stopIntent,
      }),
    })
  }
  return Object.freeze({
    identity: null,
    state: 'unknown',
    presentation: 'none',
    stop: NO_STOP,
    recovery: NO_RECOVERY,
    targetAdmission: 'unknown',
    blocksReplacement: false,
  })
}

function reduceAbsentAvailability(
  input: AttemptAvailabilityInput,
  localAuthority: LocalAttemptAuthority,
): AttemptAvailability {
  const reservation = reservationIdentity(localAuthority, input.workspace)
  if (reservation) {
    return Object.freeze({
      identity: reservation,
      state: 'reserved',
      presentation: 'none',
      stop: NO_STOP,
      recovery: NO_RECOVERY,
      targetAdmission: 'occupied',
      blocksReplacement: true,
    })
  }
  const stopIntent = input.stopIntent
  return Object.freeze({
    identity: stopIntent ?? null,
    state: 'settled',
    presentation: 'none',
    stop: stopIntent ? Object.freeze({ kind: 'settled', identity: stopIntent }) : NO_STOP,
    recovery: NO_RECOVERY,
    targetAdmission: 'available',
    blocksReplacement: false,
  })
}

function recoveryDirective(
  identity: AttemptIdentity,
  lease: StreamLeaseRow,
  lock: AttemptOwnershipLockObservation,
  freshness: StreamLeaseFreshnessObservation,
): AttemptRecoveryDirective {
  if (lock.kind === 'acquired-for-recovery') {
    return Object.freeze({ kind: 'claim', identity })
  }
  if (lock.kind === 'held-by-other') {
    return Object.freeze({
      kind: 'wait-owner-release',
      identity,
      deadline: freshness.deadline,
    })
  }
  if (lock.kind === 'unobserved') return Object.freeze({ kind: 'probe-lock', identity })
  const authority = streamLeaseRecoveryAuthority({
    custody: lease.custody,
    ownershipVerified: false,
    freshnessProtected: freshness.fresh,
  })
  return authority === 'recover'
    ? Object.freeze({ kind: 'claim', identity })
    : Object.freeze({
        kind: 'wait-owner-release',
        identity,
        deadline: freshness.deadline,
      })
}

function authorityInWorkspace(
  authority: LocalAttemptAuthority,
  workspace: WorkspaceFence,
): LocalAttemptAuthority {
  if (
    authority.kind === 'none' ||
    authority.workspaceId !== workspace.workspaceId ||
    (authority.kind === 'reservation'
      ? authority.admission.replacementEpoch
      : authority.lease.replacementEpoch) !== workspace.replacementEpoch
  ) {
    return { kind: 'none' }
  }
  return authority
}

function exactLocalWriter(
  authority: LocalAttemptAuthority,
  workspace: WorkspaceFence,
  lease: StreamLeaseRow,
): authority is Extract<LocalAttemptAuthority, { kind: 'writer' }> {
  if (authority.kind !== 'writer' || lease.custody !== 'writer') return false
  const local = authority.lease
  return (
    authority.workspaceId === workspace.workspaceId &&
    local.streamId === lease.streamId &&
    local.chatId === lease.chatId &&
    local.messageId === lease.messageId &&
    local.attemptKind === lease.attemptKind &&
    local.replacementEpoch === lease.replacementEpoch &&
    local.admissionSequence === lease.admissionSequence &&
    local.ownerClientId === lease.ownerClientId &&
    local.fenceToken === lease.fenceToken
  )
}

function reservationIdentity(
  authority: LocalAttemptAuthority,
  workspace: WorkspaceFence,
): AttemptReservationIdentity | null {
  if (authority.kind !== 'reservation') return null
  const admission = authority.admission
  return Object.freeze({
    workspaceId: workspace.workspaceId,
    replacementEpoch: workspace.replacementEpoch,
    streamId: admission.streamId,
    chatId: admission.chatId,
    messageId: admission.messageId,
    attemptKind: admission.attemptKind,
  })
}

function identityFromLease(workspace: WorkspaceFence, lease: StreamLeaseRow): AttemptIdentity {
  return Object.freeze({
    workspaceId: workspace.workspaceId,
    replacementEpoch: lease.replacementEpoch,
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    attemptKind: lease.attemptKind,
    admissionSequence: lease.admissionSequence,
  })
}

function expectedStreamId(
  input: AttemptAvailabilityInput,
  previous: AttemptAvailability | undefined,
): string | undefined {
  if (input.lease.kind === 'present') return input.lease.lease.streamId
  if (input.localAuthority.kind === 'reservation') return input.localAuthority.admission.streamId
  if (input.localAuthority.kind === 'writer') return input.localAuthority.lease.streamId
  return input.stopIntent?.streamId ?? previous?.identity?.streamId
}

function lockForExpectedStream(
  lock: AttemptOwnershipLockObservation,
  streamId: string | undefined,
): AttemptOwnershipLockObservation {
  if (
    (lock.kind === 'held-by-other' || lock.kind === 'acquired-for-recovery') &&
    lock.streamId !== streamId
  ) {
    return { kind: 'unobserved' }
  }
  return lock
}

function sameAttemptIdentity(
  left: AttemptIdentity | undefined,
  right: AttemptIdentity,
): left is AttemptIdentity {
  return Boolean(
    left &&
      left.workspaceId === right.workspaceId &&
      left.replacementEpoch === right.replacementEpoch &&
      left.streamId === right.streamId &&
      left.chatId === right.chatId &&
      left.messageId === right.messageId &&
      left.attemptKind === right.attemptKind &&
      left.admissionSequence === right.admissionSequence,
  )
}

function exactStopIntentForAvailability(
  intent: AttemptStopIntent | undefined,
  availability: AttemptAvailability,
): AttemptStopIntent | undefined {
  return isExactAttemptIdentity(availability.identity) &&
    sameAttemptIdentity(intent, availability.identity)
    ? intent
    : undefined
}

function isExactAttemptIdentity(
  identity: AttemptAvailability['identity'],
): identity is AttemptIdentity {
  return identity !== null && identity.admissionSequence !== undefined
}

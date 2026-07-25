import type { ChatId, KeyId, MessageId } from '../core/types'
import { newId } from '../lib/ulid'
import type { AttemptOwnershipLockObservation, LocalAttemptAuthority } from './attempt-availability'
import {
  type FencedStreamLeaseRow,
  type StreamLeaseAdmission,
  type StreamLeaseHandoffReason,
  type StreamLeaseRow,
  type StreamWriteFence,
  streamLeaseHasWriteFence,
  type WorkspaceFence,
  type WriterActiveStreamLeaseRow,
} from './repository'
import { STREAM_LEASE_HEARTBEAT_MS } from './stream-lease-policy'
import { subscribeWorkspaceEffects, WORKSPACE_EFFECT_RECOVERY_OWNED } from './workspace-effect-hub'
import type {
  AttemptSealTerminalInput,
  GenerationPostCommitMetadataResult,
  StreamFinishCleanupResult,
  WorkspaceDeltaFact,
  WorkspaceLocalCommitApplication,
  WorkspaceRepository,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import {
  assertWorkspaceExecutionPermit,
  releaseWorkspaceChild,
  runWorkspacePhase,
  type WorkspaceReservedPermit,
  type WorkspaceWritePermit,
} from './workspace-runtime'

interface LeaseWriterInput {
  streamId: string
  chatId: ChatId
  messageId: MessageId
  startedAt: number
  attemptKind: StreamLeaseRow['attemptKind']
  workspaceId: string
  replacementEpoch: number
}

type WriterStreamLeaseRow = Extract<FencedStreamLeaseRow, { custody: 'writer' }>

interface ActiveLeaseWriter {
  input: LeaseWriterInput
  readonly repo: WorkspaceRepository
  readonly applications: StreamLeaseLocalApplications
  readonly runtimePermit: WorkspaceReservedPermit
  readonly finishRuntime: () => void
  readonly fenceToken: string
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly abortTransport: () => void
  lease: WriterStreamLeaseRow
  deliveredControlRevision: number
  transportInterrupted: boolean
  nextHeartbeatAt: number | null
  releaseOwnership: (() => void) | null
  ownershipSettled: Promise<void> | null
  closed: boolean
  writeScheduled: boolean
  operationTail: Promise<void>
  retirementPromise: Promise<StreamLeaseRetirementOutcome> | null
}

interface StreamOwnershipHold {
  release: (() => void) | null
  settled: Promise<void> | null
}

interface StreamOwnershipReservationState {
  readonly admission: StreamLeaseAdmission
  readonly runtimePermit: WorkspaceReservedPermit
  readonly hold: StreamOwnershipHold
  readonly abortTransport: () => void
  stopEvidencePending: boolean
  boundAdmissionSequence: number | null
  pendingBoundControlRevision: number
  transportInterrupted: boolean
  status: 'reserved' | 'bound' | 'released'
  releasePromise: Promise<void> | null
}

const STREAM_OWNERSHIP_RESERVATION = Symbol('stream-ownership-reservation')

export interface StreamOwnershipReservation {
  readonly streamId: string
  readonly [STREAM_OWNERSHIP_RESERVATION]: StreamOwnershipReservationState
}

export type StreamLeaseRetirementOutcome =
  | { readonly mode: 'cleanup'; readonly result: StreamFinishCleanupResult }
  | { readonly mode: 'handoff'; readonly lease: StreamLeaseRow }

export interface StreamLeaseLocalApplications {
  readonly postCommitMetadata: WorkspaceLocalCommitApplication<GenerationPostCommitMetadataResult>
  readonly cleanup: WorkspaceLocalCommitApplication<StreamFinishCleanupResult>
  readonly handoff: WorkspaceLocalCommitApplication<StreamLeaseRow>
}

type StreamLeaseRetirementOptions =
  | { readonly mode?: 'cleanup'; readonly handoffReason?: StreamLeaseHandoffReason }
  | {
      readonly mode: 'handoff'
      readonly reason: StreamLeaseHandoffReason
    }

export interface StreamLeaseHandle {
  readonly streamId: string
  readonly fence: StreamWriteFence
  readonly lease: FencedStreamLeaseRow
  adoptTargetCommit(lease: WriterActiveStreamLeaseRow): Promise<StreamWriteFence>
  noteSelectedKey(selectedKeyId: KeyId): Promise<void>
  sealTerminal(
    input: Omit<AttemptSealTerminalInput, 'streamId' | 'fence'>,
  ): Promise<Extract<FencedStreamLeaseRow, { phase: 'terminal-decided' }>>
  commitPostCommitMetadata(): Promise<GenerationPostCommitMetadataResult>
  retire(options?: StreamLeaseRetirementOptions): Promise<StreamLeaseRetirementOutcome>
}

export interface ClaimedLocalAttemptStop {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly kind: StreamLeaseRow['attemptKind']
  readonly workspaceId: string
  readonly replacementEpoch: number
  readonly admissionSequence: number
}

export function interruptClaimedLocalAttemptTransport(target: ClaimedLocalAttemptStop): boolean {
  const writer = leaseWriters.get(target.streamId)
  if (
    writer &&
    !writer.closed &&
    writer.input.chatId === target.chatId &&
    writer.input.messageId === target.messageId &&
    writer.input.attemptKind === target.kind &&
    writer.workspaceId === target.workspaceId &&
    writer.replacementEpoch === target.replacementEpoch &&
    writer.lease.admissionSequence === target.admissionSequence
  ) {
    interruptWriterTransport(writer)
    return true
  }
  const reservation = ownershipReservations.get(target.streamId)
  if (
    reservation?.status === 'reserved' &&
    reservation.runtimePermit.workspaceId === target.workspaceId &&
    reservation.admission.chatId === target.chatId &&
    reservation.admission.messageId === target.messageId &&
    reservation.admission.attemptKind === target.kind &&
    reservation.admission.replacementEpoch === target.replacementEpoch &&
    reservation.boundAdmissionSequence === target.admissionSequence
  ) {
    interruptReservationTransport(reservation)
    return true
  }
  return false
}

type StreamLockManager = Pick<LockManager, 'request'>

const clientId = newId()
const leaseWriters = new Map<string, ActiveLeaseWriter>()
const ownershipReservations = new Map<string, StreamOwnershipReservationState>()
let unsubscribeStopControl: (() => void) | null = null
let lockManagerOverride: StreamLockManager | null | undefined
let streamLeaseRuntimeDisposed = true
let streamRuntimeWork = 0
let streamLeaseRuntimeIdle: Promise<void> = Promise.resolve()
let resolveStreamLeaseRuntimeIdle: (() => void) | null = null
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatDeadline: number | null = null
let currentWorkspaceFence: WorkspaceFence | null = null

export function getStreamClientId(): string {
  return clientId
}

export function getLocalAttemptAuthority(streamId: string): LocalAttemptAuthority {
  const writer = leaseWriters.get(streamId)
  if (writer) {
    return Object.freeze({
      kind: 'writer',
      workspaceId: writer.workspaceId,
      lease: writer.lease,
    })
  }
  const reservation = ownershipReservations.get(streamId)
  if (reservation?.status === 'reserved') {
    return Object.freeze({
      kind: 'reservation',
      workspaceId: reservation.runtimePermit.workspaceId,
      admission: reservation.admission,
    })
  }
  return Object.freeze({ kind: 'none' })
}

export async function observeStreamOwnershipLock(
  streamId: string,
): Promise<AttemptOwnershipLockObservation> {
  if (streamLeaseRuntimeDisposed) return Object.freeze({ kind: 'unobserved' })
  const manager = streamLockManager()
  if (!manager) return Object.freeze({ kind: 'unsupported' })
  return trackStreamRuntimePromise(observeStreamOwnershipLockWithManager(manager, streamId))
}

async function observeStreamOwnershipLockWithManager(
  manager: StreamLockManager,
  streamId: string,
): Promise<AttemptOwnershipLockObservation> {
  let observation: AttemptOwnershipLockObservation = Object.freeze({ kind: 'unobserved' })
  try {
    await manager.request(streamOwnershipLockName(streamId), { ifAvailable: true }, (lock) => {
      observation = lock
        ? Object.freeze({ kind: 'acquired-for-recovery', streamId })
        : Object.freeze({ kind: 'held-by-other', streamId, observedAt: Date.now() })
    })
  } catch {
    return Object.freeze({ kind: 'unobserved' })
  }
  return observation
}

export function isRecoveryClaimedStreamLease(lease: StreamLeaseRow): boolean {
  return lease.custody === 'recovery' || lease.custody === 'recovery-pending'
}

export type StreamRecoveryLockResult<T> = { acquired: false } | { acquired: true; value: T }

export async function withStreamRecoveryLocks<T>(
  streamIds: readonly string[],
  recover: (ownershipVerified: boolean) => Promise<T>,
): Promise<StreamRecoveryLockResult<T>> {
  if (streamLeaseRuntimeDisposed) throw new Error('StreamLeaseRuntimeDisposed')
  return trackStreamRuntimePromise(withStreamRecoveryLocksInternal(streamIds, recover))
}

async function withStreamRecoveryLocksInternal<T>(
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

export async function waitForStreamOwnershipRelease(
  streamId: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (streamLeaseRuntimeDisposed || signal.aborted) return false
  const manager = streamLockManager()
  if (!manager) return false
  try {
    await manager.request(streamOwnershipLockName(streamId), { signal }, () => undefined)
    return !signal.aborted
  } catch {
    return false
  }
}

export async function runWithStreamRecoveryCoordinatorLock(
  workspaceId: string,
  signal: AbortSignal,
  coordinate: () => Promise<void>,
): Promise<void> {
  if (streamLeaseRuntimeDisposed || signal.aborted) return
  const manager = streamLockManager()
  if (!manager) {
    await coordinate()
    return
  }
  const state = { started: false }
  try {
    await manager.request(`stream-recovery-coordinator:${workspaceId}`, { signal }, async () => {
      state.started = true
      await coordinate()
    })
  } catch (error) {
    if (state.started) throw error
    if (signalIsActive(signal)) await coordinate()
  }
}

function signalIsActive(signal: AbortSignal): boolean {
  return !signal.aborted
}

export function reserveStreamOwnership(
  runtimePermit: WorkspaceReservedPermit,
  admission: StreamLeaseAdmission,
  abortTransport: () => void,
): Promise<StreamOwnershipReservation> {
  if (streamLeaseRuntimeDisposed) {
    releaseWorkspaceChild(runtimePermit)
    return Promise.reject(new Error('StreamLeaseRuntimeDisposed'))
  }
  return trackStreamRuntimePromise(
    reserveStreamOwnershipInternal(runtimePermit, admission, abortTransport),
  )
}

async function reserveStreamOwnershipInternal(
  runtimePermit: WorkspaceReservedPermit,
  admission: StreamLeaseAdmission,
  abortTransport: () => void,
): Promise<StreamOwnershipReservation> {
  let workspaceFence: WorkspaceFence
  try {
    workspaceFence = synchronizeWorkspaceFence(runtimePermit)
  } catch (error) {
    releaseWorkspaceChild(runtimePermit)
    throw error
  }
  if (
    admission.ownerClientId !== clientId ||
    admission.replacementEpoch !== workspaceFence.replacementEpoch ||
    admission.replacementEpoch !== runtimePermit.replacementEpoch
  ) {
    releaseWorkspaceChild(runtimePermit)
    throw new Error(`StreamOwnershipReservationFenceMismatch:${admission.streamId}`)
  }
  let hold: StreamOwnershipHold
  try {
    hold = await acquireStreamOwnership(admission.streamId)
  } catch (error) {
    releaseWorkspaceChild(runtimePermit)
    throw error
  }
  if (ownershipReservations.has(admission.streamId) || leaseWriters.has(admission.streamId)) {
    await releaseStreamOwnershipHold(hold)
    releaseWorkspaceChild(runtimePermit)
    throw new Error(`StreamOwnershipReservationDuplicate:${admission.streamId}`)
  }
  const state: StreamOwnershipReservationState = {
    admission: { ...admission },
    runtimePermit,
    hold,
    abortTransport,
    stopEvidencePending: false,
    boundAdmissionSequence: null,
    pendingBoundControlRevision: 0,
    transportInterrupted: false,
    status: 'reserved',
    releasePromise: null,
  }
  ownershipReservations.set(admission.streamId, state)
  return Object.freeze({
    streamId: admission.streamId,
    [STREAM_OWNERSHIP_RESERVATION]: state,
  })
}

export function releaseStreamOwnershipReservation(
  reservation: StreamOwnershipReservation,
): Promise<void> {
  return releaseStreamOwnershipReservationState(reservation[STREAM_OWNERSHIP_RESERVATION])
}

async function releaseStreamOwnershipReservationState(
  state: StreamOwnershipReservationState,
): Promise<void> {
  if (state.releasePromise) return state.releasePromise
  if (state.status !== 'reserved') return
  state.status = 'released'
  ownershipReservations.delete(state.admission.streamId)
  state.releasePromise = (async () => {
    try {
      await releaseStreamOwnershipHold(state.hold)
    } finally {
      releaseWorkspaceChild(state.runtimePermit)
    }
  })()
  return state.releasePromise
}

export function adoptPreparedStreamLease(
  reservation: StreamOwnershipReservation,
  lease: StreamLeaseRow,
  applications: StreamLeaseLocalApplications,
): Promise<StreamLeaseHandle> {
  const state = reservation[STREAM_OWNERSHIP_RESERVATION]
  if (streamLeaseRuntimeDisposed) {
    void releaseStreamOwnershipReservationState(state)
    return Promise.reject(new Error('StreamLeaseRuntimeDisposed'))
  }
  return trackStreamRuntimePromise(adoptPreparedStreamLeaseInternal(state, lease, applications))
}

async function adoptPreparedStreamLeaseInternal(
  reservation: StreamOwnershipReservationState,
  lease: StreamLeaseRow,
  applications: StreamLeaseLocalApplications,
): Promise<StreamLeaseHandle> {
  const runtimePermit = reservation.runtimePermit
  let workspaceFence: WorkspaceFence
  try {
    workspaceFence = synchronizeWorkspaceFence(runtimePermit)
  } catch (error) {
    await releaseStreamOwnershipReservationState(reservation)
    throw error
  }
  if (
    reservation.status !== 'reserved' ||
    lease.custody !== 'writer' ||
    lease.ownerClientId !== clientId ||
    lease.streamId !== reservation.admission.streamId ||
    lease.chatId !== reservation.admission.chatId ||
    lease.messageId !== reservation.admission.messageId ||
    lease.attemptKind !== reservation.admission.attemptKind ||
    lease.ownerClientId !== reservation.admission.ownerClientId ||
    lease.fenceToken !== reservation.admission.fenceToken ||
    lease.startedAt !== reservation.admission.startedAt ||
    lease.replacementEpoch !== workspaceFence.replacementEpoch ||
    lease.replacementEpoch !== reservation.admission.replacementEpoch ||
    lease.replacementEpoch !== runtimePermit.replacementEpoch
  ) {
    await releaseStreamOwnershipReservationState(reservation)
    throw new Error(`PreparedStreamLeaseFenceMismatch:${lease.streamId}`)
  }
  let repo: WorkspaceRepository
  try {
    repo = getWorkspaceRepository()
  } catch (error) {
    await releaseStreamOwnershipReservationState(reservation)
    throw error
  }
  reservation.boundAdmissionSequence = lease.admissionSequence
  let adoptedLease = lease
  if (reservation.stopEvidencePending) {
    let observed: StreamLeaseRow | undefined
    try {
      observed = (
        await repo.query(runtimePermit, { kind: 'stream.lease', streamId: lease.streamId })
      ).value
    } catch (error) {
      await releaseStreamOwnershipReservationState(reservation)
      throw error
    }
    if (
      !observed ||
      observed.custody !== 'writer' ||
      observed.streamId !== lease.streamId ||
      observed.chatId !== lease.chatId ||
      observed.messageId !== lease.messageId ||
      observed.attemptKind !== lease.attemptKind ||
      observed.ownerClientId !== lease.ownerClientId ||
      observed.fenceToken !== lease.fenceToken ||
      observed.replacementEpoch !== lease.replacementEpoch ||
      observed.startedAt !== lease.startedAt ||
      observed.admissionSequence !== lease.admissionSequence ||
      observed.phase !== lease.phase ||
      observed.revision < lease.revision ||
      observed.controlRevision < lease.controlRevision
    ) {
      await releaseStreamOwnershipReservationState(reservation)
      throw new Error(`PreparedStreamLeaseStopEvidenceMismatch:${lease.streamId}`)
    }
    adoptedLease = observed
  }
  const writer = createLeaseWriter({
    input: {
      streamId: adoptedLease.streamId,
      chatId: adoptedLease.chatId,
      messageId: adoptedLease.messageId,
      startedAt: adoptedLease.startedAt,
      attemptKind: adoptedLease.attemptKind,
      workspaceId: runtimePermit.workspaceId,
      replacementEpoch: adoptedLease.replacementEpoch,
    },
    runtimePermit,
    repo,
    applications,
    fenceToken: adoptedLease.fenceToken,
    workspaceId: runtimePermit.workspaceId,
    replacementEpoch: adoptedLease.replacementEpoch,
    abortTransport: reservation.abortTransport,
    deliveredControlRevision: 0,
    transportInterrupted: reservation.transportInterrupted,
    lease: { ...adoptedLease },
  })
  writer.releaseOwnership = reservation.hold.release
  writer.ownershipSettled = reservation.hold.settled
  reservation.status = 'bound'
  ownershipReservations.delete(reservation.admission.streamId)
  if (leaseWriters.has(writer.input.streamId)) {
    throw new Error(`StreamLeaseWriterDuplicate:${writer.input.streamId}`)
  }
  leaseWriters.set(writer.input.streamId, writer)
  applyDurableStopControl(writer, adoptedLease)
  if (reservation.pendingBoundControlRevision > writer.deliveredControlRevision) {
    writer.deliveredControlRevision = reservation.pendingBoundControlRevision
    interruptWriterTransport(writer)
  }
  try {
    assertWriterEpochCurrent(writer)
  } catch (error) {
    closeLeaseWriter(writer)
    await handoffOwnedLease(writer, 'adoption-failed').catch(() => undefined)
    await releaseOwnershipAfter(
      writer,
      pendingStreamOperations(writer).catch(() => {}),
    )
    throw error
  }
  writer.nextHeartbeatAt = heartbeatSchedulerNow() + STREAM_LEASE_HEARTBEAT_MS
  scheduleHeartbeatTimer()
  return leaseHandle(writer)
}

function createLeaseWriter(input: {
  input: LeaseWriterInput
  runtimePermit: WorkspaceReservedPermit
  repo: WorkspaceRepository
  applications: StreamLeaseLocalApplications
  fenceToken: string
  workspaceId: string
  replacementEpoch: number
  abortTransport: () => void
  deliveredControlRevision: number
  transportInterrupted: boolean
  lease: WriterStreamLeaseRow
}): ActiveLeaseWriter {
  let runtimeFinished = false
  let resolveRuntime!: () => void
  const runtimeLifetime = new Promise<void>((resolve) => {
    resolveRuntime = resolve
  })
  const runtimePhase = runWorkspacePhase(input.runtimePermit, () => runtimeLifetime)
  void runtimePhase.catch(() => {})
  return {
    input: input.input,
    repo: input.repo,
    applications: input.applications,
    runtimePermit: input.runtimePermit,
    finishRuntime: () => {
      if (runtimeFinished) return
      runtimeFinished = true
      resolveRuntime()
    },
    fenceToken: input.fenceToken,
    workspaceId: input.workspaceId,
    replacementEpoch: input.replacementEpoch,
    abortTransport: input.abortTransport,
    lease: input.lease,
    deliveredControlRevision: input.deliveredControlRevision,
    transportInterrupted: input.transportInterrupted,
    nextHeartbeatAt: null,
    releaseOwnership: null,
    ownershipSettled: null,
    closed: false,
    writeScheduled: false,
    operationTail: Promise.resolve(),
    retirementPromise: null,
  }
}

export function streamWriteFenceForLease(lease: FencedStreamLeaseRow): StreamWriteFence {
  return {
    ownerClientId: lease.ownerClientId,
    fenceToken: lease.fenceToken,
    replacementEpoch: lease.replacementEpoch,
    admissionSequence: lease.admissionSequence,
  }
}

export async function finishStreamCleanup(input: {
  readonly repository: WorkspaceRepository
  readonly permit: WorkspaceWritePermit
  readonly chatId: ChatId
  readonly streamId: string
  readonly fence: StreamWriteFence
  readonly application: WorkspaceLocalCommitApplication<StreamFinishCleanupResult>
}): Promise<StreamFinishCleanupResult> {
  let deletedLease = false
  let deletedFrames = 0
  for (;;) {
    const committed = await input.repository.execute(
      input.permit,
      {
        kind: 'stream.finish-cleanup',
        chatId: input.chatId,
        streamId: input.streamId,
        fence: input.fence,
      },
      { localApplications: { conversation: input.application } },
    )
    deletedLease ||= committed.value.deletedLease
    deletedFrames += committed.value.deletedFrames
    if (committed.value.done) return { deletedLease, deletedFrames, done: true }
    if (committed.value.deletedFrames === 0) {
      throw new Error(`StreamCleanupMadeNoProgress:${input.streamId}`)
    }
  }
}

function leaseHandle(writer: ActiveLeaseWriter): StreamLeaseHandle {
  return Object.freeze({
    streamId: writer.input.streamId,
    get fence() {
      return writerFence(writer)
    },
    get lease() {
      return writer.lease
    },
    adoptTargetCommit: (lease: WriterActiveStreamLeaseRow) =>
      enqueueWriterOperation(writer, () => {
        assertWriterEpochCurrent(writer)
        assertSameOwnedLease(writer, lease)
        writer.lease = { ...lease }
        return writerFence(writer)
      }),
    noteSelectedKey: (selectedKeyId: KeyId) =>
      enqueueWriterOperation(writer, async () => {
        assertWriterEpochCurrent(writer)
        const noted = await writer.repo.execute(writer.runtimePermit, {
          kind: 'stream.note-selected-key',
          input: {
            streamId: writer.input.streamId,
            fence: writerFence(writer),
            selectedKeyId,
          },
        })
        assertSameOwnedLease(writer, noted.value)
        writer.lease = { ...noted.value }
      }),
    sealTerminal: (input: Omit<AttemptSealTerminalInput, 'streamId' | 'fence'>) =>
      enqueueWriterOperation(writer, async () => {
        assertWriterEpochCurrent(writer)
        const sealed = await writer.repo.execute(writer.runtimePermit, {
          kind: 'attempt.seal-terminal',
          input: {
            ...input,
            streamId: writer.input.streamId,
            fence: writerFence(writer),
          },
        })
        assertSameOwnedLease(writer, sealed.value)
        writer.lease = { ...sealed.value }
        return sealed.value
      }),
    commitPostCommitMetadata: () =>
      enqueueWriterOperation(writer, async () => {
        assertWriterEpochCurrent(writer)
        const committed = await writer.repo.execute(
          writer.runtimePermit,
          {
            kind: 'generation.post-commit-metadata',
            input: {
              streamId: writer.input.streamId,
              fence: writerFence(writer),
            },
          },
          {
            localApplications: {
              conversation: writer.applications.postCommitMetadata,
            },
          },
        )
        if (committed.value.outcome !== 'stale') {
          assertSameOwnedLease(writer, committed.value.lease)
          writer.lease = { ...committed.value.lease }
        }
        return committed.value
      }),
    retire: (options?: Parameters<StreamLeaseHandle['retire']>[0]) =>
      retireLeaseWriter(writer, options),
  })
}

function assertSameOwnedLease(
  writer: ActiveLeaseWriter,
  lease: StreamLeaseRow,
): asserts lease is WriterStreamLeaseRow {
  if (
    !streamLeaseHasWriteFence(lease) ||
    lease.custody !== 'writer' ||
    lease.streamId !== writer.input.streamId ||
    lease.chatId !== writer.input.chatId ||
    lease.messageId !== writer.input.messageId ||
    lease.ownerClientId !== clientId ||
    lease.fenceToken !== writer.fenceToken ||
    lease.replacementEpoch !== writer.replacementEpoch ||
    lease.admissionSequence !== writer.lease.admissionSequence
  ) {
    throw new Error(`StreamLeaseTargetCommitMismatch:${writer.input.streamId}`)
  }
}

function synchronizeWorkspaceFence(fence: WorkspaceFence): WorkspaceFence {
  if (currentWorkspaceFence === null) {
    currentWorkspaceFence = {
      workspaceId: fence.workspaceId,
      replacementEpoch: fence.replacementEpoch,
    }
  } else if (
    currentWorkspaceFence.workspaceId === fence.workspaceId &&
    currentWorkspaceFence.replacementEpoch > fence.replacementEpoch
  ) {
    return currentWorkspaceFence
  } else if (!sameWorkspaceFence(currentWorkspaceFence, fence)) {
    replaceStreamWorkspace(fence)
  }
  return currentWorkspaceFence
}

function replaceStreamWorkspace(fence: WorkspaceFence): void {
  if (currentWorkspaceFence && sameWorkspaceFence(currentWorkspaceFence, fence)) return
  assertNoOpenLeaseWriters('workspace-replacement')
  currentWorkspaceFence = {
    workspaceId: fence.workspaceId,
    replacementEpoch: fence.replacementEpoch,
  }
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  heartbeatDeadline = null
}

function assertWriterEpochCurrent(writer: ActiveLeaseWriter): void {
  if (
    !currentWorkspaceFence ||
    currentWorkspaceFence.workspaceId !== writer.workspaceId ||
    currentWorkspaceFence.replacementEpoch !== writer.replacementEpoch ||
    writer.lease.replacementEpoch !== writer.replacementEpoch
  ) {
    throw new Error(`StreamWorkspaceReplaced:${writer.input.streamId}`)
  }
}

async function handoffOwnedLease(
  writer: ActiveLeaseWriter,
  reason: StreamLeaseHandoffReason,
): Promise<StreamLeaseRow> {
  const committed = await writer.repo.execute(
    writer.runtimePermit,
    {
      kind: 'stream.handoff-recovery',
      input: {
        streamId: writer.input.streamId,
        fence: writerFence(writer),
        handedOffAt: Date.now(),
        reason,
      },
    },
    { localApplications: { conversation: writer.applications.handoff } },
  )
  return committed.value
}

function heartbeatSchedulerNow(): number {
  return globalThis.performance.now()
}

function scheduleHeartbeatTimer(now = heartbeatSchedulerNow()): void {
  if (streamLeaseRuntimeDisposed) return
  let hasActiveWriter = false
  for (const writer of leaseWriters.values()) {
    if (writer.closed) continue
    hasActiveWriter = true
    break
  }
  if (!hasActiveWriter) {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
    heartbeatTimer = null
    heartbeatDeadline = null
    return
  }
  if (heartbeatTimer !== null && heartbeatDeadline !== null) return
  heartbeatDeadline = now + STREAM_LEASE_HEARTBEAT_MS
  heartbeatTimer = setTimeout(() => {
    heartbeatTimer = null
    heartbeatDeadline = null
    runDueHeartbeats(heartbeatSchedulerNow())
  }, STREAM_LEASE_HEARTBEAT_MS)
}

function runDueHeartbeats(now: number): void {
  if (streamLeaseRuntimeDisposed) return
  for (const writer of leaseWriters.values()) {
    if (writer.closed || writer.nextHeartbeatAt === null || writer.nextHeartbeatAt > now) continue
    writer.nextHeartbeatAt = now + STREAM_LEASE_HEARTBEAT_MS
    void scheduleHeartbeat(writer).catch(() => {})
  }
  scheduleHeartbeatTimer(now)
}

function scheduleHeartbeat(writer: ActiveLeaseWriter): Promise<void> {
  if (writer.closed || writer.writeScheduled) return pendingStreamOperations(writer)
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
  return enqueueWriterOperation(writer, async () => {
    assertWorkspaceExecutionPermit(writer.runtimePermit)
    const renewed = await writer.repo.execute(writer.runtimePermit, {
      kind: 'stream.renew',
      heartbeat: {
        streamId: writer.lease.streamId,
        fence: streamWriteFenceForLease(writer.lease),
        heartbeatAt: Date.now(),
      },
    })
    if (!streamLeaseHasWriteFence(renewed.value) || renewed.value.custody !== 'writer') {
      throw new Error(`StreamLeaseCustodyLost:${writer.input.streamId}`)
    }
    writer.lease = renewed.value
    applyDurableStopControl(writer, renewed.value)
  })
}

type AttemptStopRequestedFact = Extract<WorkspaceDeltaFact, { kind: 'attempt-stop-requested' }>

function receiveDurableStopFact(
  fact: AttemptStopRequestedFact,
  workspaceId: string,
  replacementEpoch: number,
): void {
  if (
    currentWorkspaceFence?.workspaceId !== workspaceId ||
    currentWorkspaceFence.replacementEpoch !== replacementEpoch ||
    fact.controlRevision < 1
  ) {
    return
  }
  const writer = leaseWriters.get(fact.streamId)
  if (writer) {
    if (
      writer.input.chatId !== fact.chatId ||
      writer.input.messageId !== fact.messageId ||
      writer.input.attemptKind !== fact.attemptKind ||
      writer.replacementEpoch !== replacementEpoch ||
      writer.lease.admissionSequence !== fact.admissionSequence ||
      writer.deliveredControlRevision >= fact.controlRevision
    ) {
      return
    }
    writer.deliveredControlRevision = fact.controlRevision
    interruptWriterTransport(writer)
    return
  }
  const reservation = ownershipReservations.get(fact.streamId)
  if (
    !reservation ||
    reservation.admission.chatId !== fact.chatId ||
    reservation.admission.messageId !== fact.messageId ||
    reservation.admission.attemptKind !== fact.attemptKind ||
    reservation.admission.replacementEpoch !== replacementEpoch
  ) {
    return
  }
  reservation.stopEvidencePending = true
  if (
    reservation.boundAdmissionSequence === fact.admissionSequence &&
    fact.controlRevision > reservation.pendingBoundControlRevision
  ) {
    reservation.pendingBoundControlRevision = fact.controlRevision
  }
}

function applyDurableStopControl(writer: ActiveLeaseWriter, lease: StreamLeaseRow): void {
  if (!lease.stopControl || writer.deliveredControlRevision >= lease.controlRevision) return
  writer.deliveredControlRevision = lease.controlRevision
  interruptWriterTransport(writer)
}

function interruptWriterTransport(writer: ActiveLeaseWriter): void {
  if (writer.transportInterrupted) return
  writer.transportInterrupted = true
  abortTransport(writer.abortTransport)
}

function interruptReservationTransport(reservation: StreamOwnershipReservationState): void {
  if (reservation.transportInterrupted) return
  reservation.transportInterrupted = true
  abortTransport(reservation.abortTransport)
}

function abortTransport(abort: () => void): void {
  try {
    abort()
  } catch {
    // A transport abort callback cannot roll back the durable Stop request.
  }
}

function writerFence(writer: ActiveLeaseWriter): StreamWriteFence {
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

async function acquireStreamOwnership(streamId: string): Promise<StreamOwnershipHold> {
  const manager = streamLockManager()
  if (!manager) return { release: null, settled: null }
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const ownership = manager.request(
    streamOwnershipLockName(streamId),
    { ifAvailable: true },
    async (lock) => {
      if (!lock) {
        rejectReady(new Error(`StreamLeaseAlreadyOwned:${streamId}`))
        return
      }
      resolveReady()
      await released
    },
  )
  const task = ownership.then(
    () => {},
    () => {},
  )
  void ownership.catch((error) => rejectReady(error))
  beginStreamRuntimeWork()
  void task.finally(endStreamRuntimeWork)
  await ready
  return { release, settled: task }
}

async function releaseStreamOwnershipHold(hold: StreamOwnershipHold): Promise<void> {
  hold.release?.()
  hold.release = null
  await hold.settled
  hold.settled = null
}

function enqueueWriterOperation<T>(
  writer: ActiveLeaseWriter,
  operation: () => T | Promise<T>,
): Promise<T> {
  beginStreamRuntimeWork()
  const prior = writer.operationTail
  const result = prior.then(operation, operation).finally(endStreamRuntimeWork)
  writer.operationTail = result.then(
    () => {},
    () => {},
  )
  return result
}

function closeLeaseWriter(writer: ActiveLeaseWriter): void {
  if (writer.closed) return
  writer.closed = true
  writer.nextHeartbeatAt = null
  scheduleHeartbeatTimer()
}

function pendingStreamOperations(writer: ActiveLeaseWriter): Promise<void> {
  return writer.operationTail
}

function retireLeaseWriter(
  writer: ActiveLeaseWriter,
  options: StreamLeaseRetirementOptions = {},
): Promise<StreamLeaseRetirementOutcome> {
  if (writer.retirementPromise) return writer.retirementPromise
  closeLeaseWriter(writer)

  if (options.mode === 'handoff') {
    const terminalOperation = enqueueWriterOperation<StreamLeaseRetirementOutcome>(
      writer,
      async () =>
        ({
          mode: 'handoff',
          lease: await handoffOwnedLease(writer, options.reason),
        }) as const,
    )
    writer.retirementPromise = releaseAfterTerminalOutcome(writer, terminalOperation)
    return writer.retirementPromise
  }

  {
    const terminalOperation = enqueueWriterOperation<StreamLeaseRetirementOutcome>(
      writer,
      async () => {
        assertWriterEpochCurrent(writer)
        try {
          const result = await finishStreamCleanup({
            repository: writer.repo,
            permit: writer.runtimePermit,
            chatId: writer.input.chatId,
            streamId: writer.input.streamId,
            fence: writerFence(writer),
            application: writer.applications.cleanup,
          })
          return { mode: 'cleanup', result }
        } catch (cleanupError) {
          if (!options.handoffReason) throw cleanupError
          try {
            const lease = await handoffOwnedLease(writer, options.handoffReason)
            return { mode: 'handoff', lease }
          } catch (handoffError) {
            throw new AggregateError(
              [cleanupError, handoffError],
              `StreamCleanupAndHandoffFailed:${writer.input.streamId}`,
              { cause: handoffError },
            )
          }
        }
      },
    )
    writer.retirementPromise = releaseAfterTerminalOutcome(writer, terminalOperation)
    return writer.retirementPromise
  }
}

function releaseAfterTerminalOutcome(
  writer: ActiveLeaseWriter,
  operation: Promise<StreamLeaseRetirementOutcome>,
): Promise<StreamLeaseRetirementOutcome> {
  const release = releaseOwnershipAfter(
    writer,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  )
  return operation.then(
    async (outcome) => {
      await release
      return outcome
    },
    async (error) => {
      await release
      throw error
    },
  )
}

function releaseOwnershipAfter(
  writer: ActiveLeaseWriter,
  operations: Promise<void>,
): Promise<void> {
  return operations.finally(async () => {
    try {
      writer.releaseOwnership?.()
      writer.releaseOwnership = null
      await writer.ownershipSettled
      writer.ownershipSettled = null
    } finally {
      leaseWriters.delete(writer.input.streamId)
      writer.finishRuntime()
    }
  })
}

export function disposeStreamLeaseRuntime(): void {
  if (streamLeaseRuntimeDisposed) return
  assertNoOpenLeaseWriters('runtime-disposal')
  streamLeaseRuntimeDisposed = true
  unsubscribeStopControl?.()
  unsubscribeStopControl = null
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  heartbeatDeadline = null
}

export function awaitStreamLeaseRuntimeIdle(): Promise<void> {
  return streamLeaseRuntimeIdle
}

export function resumeStreamLeaseRuntime(): void {
  if (streamRuntimeWork !== 0) throw new Error('StreamLeaseRuntimeBusy')
  streamLeaseRuntimeDisposed = false
  unsubscribeStopControl ??= subscribeWorkspaceEffects({
    owner: 'stream-lease-stop-control',
    factKinds: ['attempt-stop-requested'],
    replacements: false,
    apply: (effect) => {
      if (effect.kind !== 'changed') return
      for (const fact of effect.factsByKind['attempt-stop-requested'] ?? []) {
        receiveDurableStopFact(fact, effect.workspaceId, effect.replacementEpoch)
      }
    },
    recover: () => WORKSPACE_EFFECT_RECOVERY_OWNED,
  })
}

export function assertStreamLeaseRuntimeClosed(): void {
  if (
    !streamLeaseRuntimeDisposed ||
    streamRuntimeWork !== 0 ||
    leaseWriters.size > 0 ||
    unsubscribeStopControl !== null
  ) {
    throw new Error('StreamLeaseRuntimeNotClosed')
  }
}

function trackStreamRuntimePromise<T>(promise: Promise<T>): Promise<T> {
  beginStreamRuntimeWork()
  return promise.finally(endStreamRuntimeWork)
}

function beginStreamRuntimeWork(): void {
  if (streamRuntimeWork === 0) {
    streamLeaseRuntimeIdle = new Promise<void>((resolve) => {
      resolveStreamLeaseRuntimeIdle = resolve
    })
  }
  streamRuntimeWork += 1
}

function endStreamRuntimeWork(): void {
  streamRuntimeWork -= 1
  if (streamRuntimeWork !== 0) return
  const resolve = resolveStreamLeaseRuntimeIdle
  resolveStreamLeaseRuntimeIdle = null
  resolve?.()
}

export function __setStreamLockManagerForTests(
  manager: StreamLockManager | null | undefined,
): void {
  lockManagerOverride = manager
}

export function __runStreamLeaseHeartbeatSchedulerForTests(now: number): void {
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  heartbeatDeadline = null
  runDueHeartbeats(now)
}

export function __resetStreamLeasesForTests(options: { admissionsOpen?: boolean } = {}): void {
  if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
  heartbeatTimer = null
  heartbeatDeadline = null
  currentWorkspaceFence = null
  unsubscribeStopControl?.()
  unsubscribeStopControl = null
  for (const writer of [...leaseWriters.values()]) {
    forceReleaseLeaseWriterForTests(writer)
  }
  for (const reservation of [...ownershipReservations.values()]) {
    void releaseStreamOwnershipReservationState(reservation)
  }
  lockManagerOverride = undefined
  streamLeaseRuntimeDisposed = !(options.admissionsOpen ?? false)
}

function sameWorkspaceFence(left: WorkspaceFence, right: WorkspaceFence): boolean {
  return left.workspaceId === right.workspaceId && left.replacementEpoch === right.replacementEpoch
}

function assertNoOpenLeaseWriters(operation: string): void {
  if (leaseWriters.size !== 0 || ownershipReservations.size !== 0) {
    throw new Error(
      `StreamLeaseWriterLifetimeViolation:${operation}:${leaseWriters.size}:${ownershipReservations.size}`,
    )
  }
}

function forceReleaseLeaseWriterForTests(writer: ActiveLeaseWriter): void {
  closeLeaseWriter(writer)
  void releaseOwnershipAfter(
    writer,
    pendingStreamOperations(writer).catch(() => {}),
  )
}

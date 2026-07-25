export const STREAM_LEASE_TTL_MS = 15_000
export const STREAM_LEASE_HEARTBEAT_MS = 2_000
export const STREAM_LEASE_HEARTBEAT_COALESCE_MS = 250

export type StreamLeaseWallClockFreshness = 'fresh' | 'stale' | 'future'

interface StreamLeaseFreshnessCommon {
  readonly replacementEpoch: number
  readonly admissionSequence: number
  readonly revision: number
}

export type StreamLeaseFreshnessEpoch = StreamLeaseFreshnessCommon &
  (
    | {
        readonly custody: 'writer' | 'recovery'
        readonly ownerClientId: string
        readonly fenceToken: string
        readonly heartbeatAt: number
      }
    | {
        readonly custody: 'recovery-pending'
        readonly handoffId: string
        readonly handedOffAt: number
      }
  )

export interface StreamLeaseFreshnessObservation {
  readonly epoch: string
  readonly deadline: number
  readonly fresh: boolean
}

export type StreamLeaseRecoveryAuthority = 'recover' | 'defer'
export type StreamLeaseCustody = 'writer' | 'recovery' | 'recovery-pending'

export function streamLeaseRecoveryAuthority(input: {
  readonly custody: StreamLeaseCustody
  readonly ownershipVerified: boolean
  readonly freshnessProtected: boolean
}): StreamLeaseRecoveryAuthority {
  return input.custody !== 'writer' || input.ownershipVerified || !input.freshnessProtected
    ? 'recover'
    : 'defer'
}

export function classifyStreamLeaseWallClockFreshness(
  lease: { readonly heartbeatAt: number },
  now = Date.now(),
): StreamLeaseWallClockFreshness {
  const age = now - lease.heartbeatAt
  if (age < 0) return 'future'
  return age <= STREAM_LEASE_TTL_MS ? 'fresh' : 'stale'
}

export function streamLeaseFreshnessEpoch(lease: StreamLeaseFreshnessEpoch): string {
  if (lease.custody === 'recovery-pending') {
    return JSON.stringify([
      lease.custody,
      lease.handoffId,
      lease.handedOffAt,
      lease.replacementEpoch,
      lease.admissionSequence,
      lease.revision,
    ])
  }
  return JSON.stringify([
    lease.custody,
    lease.ownerClientId,
    lease.fenceToken,
    lease.replacementEpoch,
    lease.admissionSequence,
    lease.revision,
    lease.heartbeatAt,
  ])
}

export function observeStreamLeaseFreshness(
  lease: StreamLeaseFreshnessEpoch,
  wallNow: number,
  schedulerNow: number,
  previous?: Pick<StreamLeaseFreshnessObservation, 'epoch' | 'deadline'>,
): StreamLeaseFreshnessObservation {
  const epoch = streamLeaseFreshnessEpoch(lease)
  if (lease.custody === 'recovery-pending') {
    return { epoch, deadline: schedulerNow, fresh: false }
  }
  const wallFreshness = classifyStreamLeaseWallClockFreshness(lease, wallNow)
  const deadline =
    wallFreshness === 'fresh'
      ? schedulerNow + Math.max(0, lease.heartbeatAt + STREAM_LEASE_TTL_MS - wallNow)
      : wallFreshness === 'future'
        ? previous?.epoch === epoch
          ? previous.deadline
          : schedulerNow + STREAM_LEASE_TTL_MS
        : schedulerNow
  return { epoch, deadline, fresh: deadline > schedulerNow }
}

export function isFreshStreamLease(
  lease:
    | { readonly custody: 'writer' | 'recovery'; readonly heartbeatAt: number }
    | { readonly custody: 'recovery-pending' },
  now = Date.now(),
): boolean {
  if (lease.custody === 'recovery-pending') return false
  return classifyStreamLeaseWallClockFreshness(lease, now) === 'fresh'
}

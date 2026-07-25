import type { AttemptTerminalReceipt } from '../../src/core/attempt-outcome'
import type {
  GenerationMeta,
  PersistedInboundReasoningVisibility,
  PersistedReasoningCarryForward,
} from '../../src/core/types'
import { CURRENT_STREAM_JOURNAL_EVENT_VERSION } from '../../src/store/persisted-stream-event'
import type {
  FencedStreamLeaseRow,
  StreamLeaseAdmission,
  StreamLeaseCustody,
  StreamLeaseHandoffReason,
  StreamLeaseRow,
  StreamPostCommitCompletedEvidence,
  StreamPostCommitFinalEvidence,
  StreamPostCommitPlan,
  StreamStopControl,
} from '../../src/store/repository'

interface TestLeaseIdentity {
  streamId?: string
  chatId?: string
  messageId?: string
  replacementEpoch?: number
  startedAt?: number
  admissionSequence?: number
  revision?: number
  controlRevision?: number
  stopControl?: StreamStopControl
  journalStorageBytes?: number
  journalMaxSeq?: number
}

interface TestLeaseFence {
  custody?: 'writer' | 'recovery'
  ownerClientId?: string
  fenceToken?: string
  heartbeatAt?: number
}

interface TestLeaseProgress {
  phase?: StreamLeaseRow['phase']
  targetCommittedAt?: number
  requestedModel?: string
  apiUsed?: GenerationMeta['apiUsed']
  reasoningCarryForward?: PersistedReasoningCarryForward
  reasoningVisibility?: PersistedInboundReasoningVisibility
  canonicalAt?: number
  metadataCommittedAt?: number
  dispatched?: boolean
  postCommit?: StreamPostCommitPlan
  postCommitFinal?: StreamPostCommitFinalEvidence
  terminal?: AttemptTerminalReceipt
}

export interface TestGenerationLeaseInput
  extends TestLeaseIdentity,
    TestLeaseFence,
    TestLeaseProgress {}

export interface TestContinuationLeaseInput
  extends TestLeaseIdentity,
    TestLeaseFence,
    TestLeaseProgress {
  continuationStrategy?: 'prompt' | 'prefill'
  baseNodeVersion?: number
  baseBodyVersion?: number
}

export interface TestRecoveryPendingLeaseInput extends TestLeaseIdentity, TestLeaseProgress {
  attemptKind?: 'generation' | 'continuation'
  handoffId?: string
  handedOffAt?: number
  handoffReason?: StreamLeaseHandoffReason
  continuationStrategy?: 'prompt' | 'prefill'
  baseNodeVersion?: number
  baseBodyVersion?: number
}

type FencedGenerationLease = Extract<FencedStreamLeaseRow, { attemptKind: 'generation' }>
type FencedContinuationLease = Extract<FencedStreamLeaseRow, { attemptKind: 'continuation' }>
type GenerationLeaseAt<
  Phase extends StreamLeaseRow['phase'],
  Custody extends 'writer' | 'recovery',
> = Extract<FencedGenerationLease, { phase: Phase; custody: Custody }>
type ContinuationLeaseAt<
  Phase extends StreamLeaseRow['phase'],
  Custody extends 'writer' | 'recovery',
> = Extract<FencedContinuationLease, { phase: Phase; custody: Custody }>

export function testStreamLeaseAdmission(
  input: TestLeaseIdentity & TestLeaseFence & { attemptKind?: 'generation' | 'continuation' } = {},
): StreamLeaseAdmission {
  const common = commonFields(input)
  return {
    streamId: common.streamId,
    chatId: common.chatId,
    messageId: common.messageId,
    replacementEpoch: common.replacementEpoch,
    startedAt: common.startedAt,
    journalEventVersion: common.journalEventVersion,
    custody: 'writer',
    ownerClientId: input.ownerClientId ?? 'test-tab',
    fenceToken: input.fenceToken ?? 'test-fence',
    heartbeatAt: input.heartbeatAt ?? 1,
    attemptKind: input.attemptKind ?? 'generation',
  }
}

export function testGenerationLease<
  Phase extends StreamLeaseRow['phase'] = 'active',
  Custody extends 'writer' | 'recovery' = 'writer',
>(
  input?: Omit<TestGenerationLeaseInput, 'phase' | 'custody'> & {
    phase?: Phase
    custody?: Custody
  },
): GenerationLeaseAt<Phase, Custody>
export function testGenerationLease(input: TestGenerationLeaseInput = {}): FencedGenerationLease {
  return testFencedGenerationLease(input)
}

export function testContinuationLease<
  Phase extends StreamLeaseRow['phase'] = 'active',
  Custody extends 'writer' | 'recovery' = 'writer',
>(
  input?: Omit<TestContinuationLeaseInput, 'phase' | 'custody'> & {
    phase?: Phase
    custody?: Custody
  },
): ContinuationLeaseAt<Phase, Custody>
export function testContinuationLease(
  input: TestContinuationLeaseInput = {},
): FencedContinuationLease {
  const common = commonFields(input)
  const custody = fencedCustody(input)
  const postCommit = input.postCommit ?? defaultPostCommit(common.startedAt)
  const dispatch = {
    targetCommittedAt: input.targetCommittedAt ?? common.startedAt,
    requestedModel: input.requestedModel ?? 'test/model',
    apiUsed: input.apiUsed ?? 'chat',
    reasoningCarryForward: input.reasoningCarryForward ?? 'none',
    reasoningVisibility: input.reasoningVisibility ?? { disclosure: 'unknown' },
    continuationStrategy: input.continuationStrategy ?? 'prompt',
    baseNodeVersion: input.baseNodeVersion ?? 1,
    baseBodyVersion: input.baseBodyVersion ?? 1,
  } as const
  switch (input.phase ?? 'active') {
    case 'reserved':
      return {
        ...common,
        ...custody,
        attemptKind: 'continuation',
        phase: 'reserved',
        targetOwnerKey: common.messageId,
        postCommit,
      }
    case 'active':
      return {
        ...common,
        ...custody,
        attemptKind: 'continuation',
        phase: 'active',
        targetOwnerKey: common.messageId,
        dispatch,
        postCommit,
      }
    case 'terminal-decided':
      return {
        ...common,
        ...custody,
        attemptKind: 'continuation',
        phase: 'terminal-decided',
        targetOwnerKey: common.messageId,
        dispatch: input.dispatched === false ? null : dispatch,
        terminal: input.terminal ?? defaultTerminal(common, input),
        postCommit,
      }
    case 'canonical':
      return {
        ...common,
        ...custody,
        attemptKind: 'continuation',
        phase: 'canonical',
        dispatch: input.dispatched === false ? null : dispatch,
        canonicalAt: input.canonicalAt ?? common.startedAt + 1,
        postCommit: completedPostCommit(postCommit, input.postCommitFinal),
      }
    case 'metadata-committed': {
      const canonicalAt = input.canonicalAt ?? common.startedAt + 1
      return {
        ...common,
        ...custody,
        attemptKind: 'continuation',
        phase: 'metadata-committed',
        dispatch: input.dispatched === false ? null : dispatch,
        canonicalAt,
        metadataCommittedAt: input.metadataCommittedAt ?? common.startedAt + 2,
        terminalRetentionAt: canonicalAt,
        postCommit: completedPostCommit(postCommit, input.postCommitFinal),
      }
    }
  }
}

export function testRecoveryPendingLease(
  input: TestRecoveryPendingLeaseInput = {},
): StreamLeaseRow {
  const common = commonFields(input)
  const custody = {
    custody: 'recovery-pending' as const,
    handoffId: input.handoffId ?? `handoff:${common.streamId}`,
    handedOffAt: input.handedOffAt ?? common.startedAt,
    handoffReason: input.handoffReason ?? 'cleanup-failed',
  }
  const progress = { ...input, custody: 'writer' as const }
  const fenced =
    input.attemptKind === 'continuation'
      ? testContinuationLease(progress)
      : testFencedGenerationLease(progress)
  const {
    ownerClientId: _ownerClientId,
    fenceToken: _fenceToken,
    heartbeatAt: _heartbeatAt,
    custody: _custody,
    ...row
  } = fenced as FencedStreamLeaseRow
  return { ...row, ...custody }
}

function testFencedGenerationLease(input: TestGenerationLeaseInput): FencedGenerationLease {
  const common = commonFields(input)
  const custody = fencedCustody(input)
  const postCommit = input.postCommit ?? defaultPostCommit(common.startedAt)
  const dispatch = {
    targetCommittedAt: input.targetCommittedAt ?? common.startedAt,
    requestedModel: input.requestedModel ?? 'test/model',
    apiUsed: input.apiUsed ?? 'chat',
    reasoningCarryForward: input.reasoningCarryForward ?? 'none',
    reasoningVisibility: input.reasoningVisibility ?? { disclosure: 'unknown' },
  } as const
  switch (input.phase ?? 'active') {
    case 'reserved':
      return {
        ...common,
        ...custody,
        attemptKind: 'generation',
        phase: 'reserved',
        targetOwnerKey: common.messageId,
        postCommit,
      }
    case 'active':
      return {
        ...common,
        ...custody,
        attemptKind: 'generation',
        phase: 'active',
        targetOwnerKey: common.messageId,
        dispatch,
        postCommit,
      }
    case 'terminal-decided':
      return {
        ...common,
        ...custody,
        attemptKind: 'generation',
        phase: 'terminal-decided',
        targetOwnerKey: common.messageId,
        dispatch: input.dispatched === false ? null : dispatch,
        terminal: input.terminal ?? defaultTerminal(common, input),
        postCommit,
      }
    case 'canonical':
      return {
        ...common,
        ...custody,
        attemptKind: 'generation',
        phase: 'canonical',
        dispatch: input.dispatched === false ? null : dispatch,
        canonicalAt: input.canonicalAt ?? common.startedAt + 1,
        postCommit: completedPostCommit(postCommit, input.postCommitFinal),
      }
    case 'metadata-committed': {
      const canonicalAt = input.canonicalAt ?? common.startedAt + 1
      return {
        ...common,
        ...custody,
        attemptKind: 'generation',
        phase: 'metadata-committed',
        dispatch: input.dispatched === false ? null : dispatch,
        canonicalAt,
        metadataCommittedAt: input.metadataCommittedAt ?? common.startedAt + 2,
        terminalRetentionAt: canonicalAt,
        postCommit: completedPostCommit(postCommit, input.postCommitFinal),
      }
    }
  }
}

function commonFields(input: TestLeaseIdentity) {
  const controlRevision = input.controlRevision ?? (input.stopControl ? 1 : 0)
  return {
    streamId: input.streamId ?? 'stream-1',
    chatId: input.chatId ?? 'chat-1',
    messageId: input.messageId ?? 'message-1',
    replacementEpoch: input.replacementEpoch ?? 0,
    startedAt: input.startedAt ?? 1,
    journalEventVersion: CURRENT_STREAM_JOURNAL_EVENT_VERSION,
    admissionSequence: input.admissionSequence ?? 1,
    revision: input.revision ?? 1,
    controlRevision,
    ...(input.stopControl ? { stopControl: input.stopControl } : {}),
    ...(input.journalStorageBytes === undefined
      ? {}
      : { journalStorageBytes: input.journalStorageBytes }),
    ...(input.journalMaxSeq === undefined ? {} : { journalMaxSeq: input.journalMaxSeq }),
  }
}

function defaultTerminal(
  common: ReturnType<typeof commonFields>,
  input: TestLeaseIdentity,
): AttemptTerminalReceipt {
  return {
    version: 1,
    finishedAt: common.startedAt + 1,
    journalMaxSeq: input.journalMaxSeq ?? -1,
    journalCompleteness: 'settled',
    decision: { outcome: 'done' },
  }
}

function fencedCustody(
  input: TestLeaseFence,
):
  | Extract<StreamLeaseCustody, { custody: 'writer' }>
  | Extract<StreamLeaseCustody, { custody: 'recovery' }> {
  const shared = {
    ownerClientId: input.ownerClientId ?? 'test-tab',
    fenceToken: input.fenceToken ?? 'test-fence',
    heartbeatAt: input.heartbeatAt ?? 1,
  }
  return input.custody === 'recovery'
    ? { custody: 'recovery', ...shared }
    : { custody: 'writer', ...shared }
}

function defaultPostCommit(usedAt: number): StreamPostCommitPlan {
  return { usedAt, profileId: 'test-profile' }
}

function completedPostCommit(
  postCommit: StreamPostCommitPlan,
  final: StreamPostCommitFinalEvidence = { completionAllowed: true },
): StreamPostCommitCompletedEvidence {
  return { ...postCommit, final }
}

import {
  type AttemptTerminalDecision,
  type AttemptTerminalReceipt,
  normalizeAttemptTerminalDecision,
} from '../core/attempt-outcome'
import { withoutUnmaterializedGeneratedOutput } from '../core/generated-output-localization'
import {
  type StreamAccumulator,
  streamAccumulatorHasCompletionCalibrationBlockers,
} from '../core/stream-accumulator'
import type {
  AttachmentRef,
  ChatId,
  GenerationMeta,
  KeyId,
  MessageId,
  PersistedInboundReasoningVisibility,
  PersistedReasoningCarryForward,
  ProfileId,
} from '../core/types'
import { attemptController, targetCommitHandoffFromLease } from './attempt-controller'
import { conversationController } from './conversation-controller'
import { conversationCommittedEffectForCommit } from './conversation-repository-adapter'
import { prepareGeneratedOutputTerminalWrite } from './generated-images'
import {
  generationTerminalBodySemanticEffect,
  projectContinuationTerminalAttempt,
  projectGenerationTerminalAttempt,
} from './generation-projection'
import type { MessageBodyFields } from './message-storage'
import {
  type FencedStreamLeaseRow,
  type StreamLeaseHandoffReason,
  type StreamLeaseRow,
  type StreamWriteFence,
  streamLeaseHasWriteFence,
  streamPostCommitUsageEvidence,
  type TerminalDecidedStreamLeaseRow,
  type WorkspaceFence,
} from './repository'
import {
  finishStreamCleanup,
  type StreamLeaseHandle,
  type StreamLeaseLocalApplications,
  streamWriteFenceForLease,
} from './stream-leases'
import type {
  AttemptFinalizeResult,
  AttemptTerminalProjection,
  GenerationPostCommitMetadataResult,
  StreamFinishCleanupResult,
  WorkspaceLocalCommitApplication,
  WorkspaceRepository,
} from './workspace-protocol'
import type { WorkspaceWritePermit } from './workspace-runtime'

export type { AttemptTerminalDecision, AttemptTerminalReceipt }

interface AttemptCleanupDisposition {
  readonly kind: 'recovery-pending'
  readonly reason: StreamLeaseHandoffReason
}

export type AttemptTerminalCustodyOutcome =
  | {
      readonly kind: 'retired'
      readonly receipt?: AttemptTerminalReceipt
      readonly canonical?: AttemptFinalizeResult
      readonly cleanup?: StreamFinishCleanupResult
    }
  | {
      readonly kind: 'recovery-pending'
      readonly reason: StreamLeaseHandoffReason
      readonly receipt?: AttemptTerminalReceipt
      readonly canonical?: AttemptFinalizeResult
    }

interface AttemptTerminalCustodyPort {
  readonly lease: FencedStreamLeaseRow
  seal(input: {
    readonly finishedAt: number
    readonly decision: AttemptTerminalDecision
  }): Promise<TerminalDecidedStreamLeaseRow>
  canonicalize(projection: AttemptTerminalProjection): Promise<AttemptFinalizeResult>
  commitMetadata(): Promise<GenerationPostCommitMetadataResult>
  retire(): Promise<
    | { readonly kind: 'retired'; readonly cleanup: StreamFinishCleanupResult }
    | AttemptCleanupDisposition
  >
  handoff(reason: StreamLeaseHandoffReason): Promise<void>
}

export interface AttemptTerminalPreparation {
  readonly finishedAt: number
  readonly decision: AttemptTerminalDecision
  project(receipt: AttemptTerminalReceipt): AttemptTerminalProjection
}

export interface AttemptTerminalOwner {
  complete(input: {
    prepareTerminal(receipt?: AttemptTerminalReceipt): Promise<AttemptTerminalPreparation>
  }): Promise<AttemptTerminalCustodyOutcome>
  handoffIfOpen(reason: StreamLeaseHandoffReason): Promise<void>
}

interface AttemptTerminalProjectionBase {
  readonly streamId: string
  readonly messageId: MessageId
  readonly fence: StreamWriteFence
  readonly accumulator: StreamAccumulator
  readonly startedAt: number
  readonly finishedAt: number
  readonly decision: AttemptTerminalDecision
  readonly selectedKeyId?: KeyId
  readonly reasoningCarryForward: PersistedReasoningCarryForward
  readonly reasoningVisibility: PersistedInboundReasoningVisibility
}

export type AttemptTerminalProjectionInput =
  | (AttemptTerminalProjectionBase & {
      readonly kind: 'generation'
      readonly currentGeneration?: GenerationMeta
      readonly baseline:
        | {
            readonly kind: 'exact'
            readonly bodyVersion: number
            readonly body: MessageBodyFields
          }
        | { readonly kind: 'unavailable' }
      readonly requestedModel: string
      readonly apiUsed?: GenerationMeta['apiUsed']
      readonly attachmentRefs?: readonly AttachmentRef[]
      readonly requestCredential?: {
        readonly profileId: ProfileId
        readonly selectedKeyId: KeyId
      }
    })
  | (AttemptTerminalProjectionBase & {
      readonly kind: 'continuation'
      readonly strategy: 'prompt' | 'prefill' | 'unknown'
      readonly requestedModel?: string
      readonly apiUsed?: GenerationMeta['apiUsed']
    })

export async function projectAttemptTerminal(
  input: AttemptTerminalProjectionInput,
): Promise<AttemptTerminalPreparation> {
  const usage = streamPostCommitUsageEvidence(input.accumulator.usage)
  const postCommit = {
    ...(input.selectedKeyId ? { selectedKeyId: input.selectedKeyId } : {}),
    ...(usage ? { usage } : {}),
    completionAllowed: !streamAccumulatorHasCompletionCalibrationBlockers(input.accumulator),
  }
  if (input.kind === 'continuation') {
    const projected = projectContinuationTerminalAttempt({
      streamId: input.streamId,
      accumulator: input.accumulator,
      strategy: input.strategy,
      status: terminalStatus(input.decision),
      reasoningCarryForward: input.reasoningCarryForward,
      reasoningVisibility: input.reasoningVisibility,
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(input.apiUsed ? { apiUsed: input.apiUsed } : {}),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      ...(input.decision.outcome === 'abort' ? { abortReason: input.decision.abortReason } : {}),
      ...(input.decision.outcome === 'error' ? { error: input.decision.error } : {}),
    })
    return {
      finishedAt: input.finishedAt,
      decision: input.decision,
      project: (receipt) => {
        assertReceiptProposal(receipt, input.finishedAt, input.decision)
        return {
          kind: 'continuation',
          streamId: input.streamId,
          fence: input.fence,
          messageId: input.messageId,
          terminal: receipt,
          postCommit,
          continuationText: projected.continuationText,
          continuationAnnotations: projected.continuationAnnotations,
          attempt: projected.attempt,
        }
      },
    }
  }

  let decision = input.decision
  let projected = projectGenerationTerminalAttempt({
    streamId: input.streamId,
    accumulator: input.accumulator,
    ...(input.currentGeneration ? { currentGeneration: input.currentGeneration } : {}),
    requestedModel: input.requestedModel,
    ...(input.apiUsed ? { apiUsed: input.apiUsed } : {}),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    status: terminalStatus(decision),
    reasoningCarryForward: input.reasoningCarryForward,
    reasoningVisibility: input.reasoningVisibility,
    ...(decision.outcome === 'abort' ? { abortReason: decision.abortReason } : {}),
    ...(decision.outcome === 'error' ? { error: decision.error } : {}),
  })
  let generatedOutput: Awaited<ReturnType<typeof prepareGeneratedOutputTerminalWrite>> | undefined
  try {
    generatedOutput = await prepareGeneratedOutputTerminalWrite({
      messageId: input.messageId,
      content: projected.body.content,
      attachmentRefs: input.attachmentRefs,
      now: input.finishedAt,
      ...(input.requestCredential ? { requestCredential: input.requestCredential } : {}),
    })
  } catch (error) {
    decision = normalizeAttemptTerminalDecision({
      outcome: 'error',
      error,
      ...(decision.finishReason ? { finishReason: decision.finishReason } : {}),
    })
    if (decision.outcome !== 'error') {
      throw new Error(`AttemptTerminalFailureDecisionInvalid:${input.streamId}`, { cause: error })
    }
    projected = projectGenerationTerminalAttempt({
      streamId: input.streamId,
      accumulator: input.accumulator,
      ...(input.currentGeneration ? { currentGeneration: input.currentGeneration } : {}),
      requestedModel: input.requestedModel,
      ...(input.apiUsed ? { apiUsed: input.apiUsed } : {}),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      status: 'error',
      reasoningCarryForward: input.reasoningCarryForward,
      reasoningVisibility: input.reasoningVisibility,
      error: decision.error,
    })
    projected = {
      ...projected,
      body: {
        ...projected.body,
        content: withoutUnmaterializedGeneratedOutput(projected.body.content),
      },
    }
  }
  const terminalDecision = decision
  const terminalProjection = projected
  const terminalGeneratedOutput = generatedOutput
  const terminalBody = terminalGeneratedOutput
    ? { ...terminalProjection.body, content: terminalGeneratedOutput.content }
    : terminalProjection.body
  const terminalAttachmentRefs = terminalGeneratedOutput?.attachmentRefs ?? input.attachmentRefs
  const baseline =
    input.baseline.kind === 'unavailable'
      ? input.baseline
      : {
          kind: 'exact' as const,
          bodyVersion: input.baseline.bodyVersion,
          body: input.baseline.body,
          semanticEffect: generationTerminalBodySemanticEffect({
            before: {
              body: input.baseline.body,
              ...(input.currentGeneration ? { generation: input.currentGeneration } : {}),
              ...(input.attachmentRefs ? { attachmentRefs: input.attachmentRefs } : {}),
            },
            after: {
              body: terminalBody,
              generation: terminalProjection.generation,
              ...(terminalAttachmentRefs ? { attachmentRefs: terminalAttachmentRefs } : {}),
            },
          }),
        }
  return {
    finishedAt: input.finishedAt,
    decision: terminalDecision,
    project: (receipt) => {
      assertReceiptProposal(receipt, input.finishedAt, terminalDecision)
      return {
        kind: 'generation',
        streamId: input.streamId,
        fence: input.fence,
        messageId: input.messageId,
        terminal: receipt,
        postCommit,
        body: terminalBody,
        generation: terminalProjection.generation,
        baseline,
        ...(terminalGeneratedOutput ? { generatedOutput: terminalGeneratedOutput } : {}),
      }
    },
  }
}

export function createAttemptTerminalOwner(port: AttemptTerminalCustodyPort): AttemptTerminalOwner {
  let settlement: Promise<AttemptTerminalCustodyOutcome> | undefined
  return {
    complete: (input) => {
      settlement ??= advanceAttemptTerminalCustody({ port, ...input })
      return settlement
    },
    handoffIfOpen: async (reason) => {
      settlement ??= port
        .handoff(reason)
        .then(() => ({ kind: 'recovery-pending', reason }) as const)
      await settlement.then(
        () => undefined,
        () => undefined,
      )
    },
  }
}

export async function advanceAttemptTerminalCustody(input: {
  readonly port: AttemptTerminalCustodyPort
  prepareTerminal(receipt?: AttemptTerminalReceipt): Promise<AttemptTerminalPreparation>
}): Promise<AttemptTerminalCustodyOutcome> {
  let lease: StreamLeaseRow = input.port.lease
  let preparation: AttemptTerminalPreparation | undefined
  let receipt: AttemptTerminalReceipt | undefined
  let canonical: AttemptFinalizeResult | undefined

  if (
    lease.phase === 'reserved' ||
    lease.phase === 'active' ||
    lease.phase === 'terminal-decided'
  ) {
    receipt = lease.phase === 'terminal-decided' ? lease.terminal : undefined
    try {
      preparation = await input.prepareTerminal(receipt)
    } catch (error) {
      await ignoreHandoffFailure(input.port, 'finalize-failed')
      throw error
    }
    if (lease.phase !== 'terminal-decided') {
      try {
        lease = await input.port.seal({
          finishedAt: preparation.finishedAt,
          decision: preparation.decision,
        })
      } catch (error) {
        await ignoreHandoffFailure(input.port, terminalSealFailureReason(error))
        throw terminalSealCause(error)
      }
      receipt = lease.terminal
      if (!receiptMatchesPreparation(receipt, preparation)) {
        try {
          preparation = await input.prepareTerminal(receipt)
        } catch (error) {
          await ignoreHandoffFailure(input.port, 'finalize-failed')
          throw error
        }
      }
    }
    if (!receipt) throw new Error(`AttemptTerminalReceiptMissing:${lease.streamId}`)
    try {
      canonical = await input.port.canonicalize(preparation.project(receipt))
      lease = canonical.lease
    } catch (error) {
      await ignoreHandoffFailure(input.port, 'finalize-failed')
      throw error
    }
  }

  if (lease.phase === 'canonical') {
    let metadata: GenerationPostCommitMetadataResult
    try {
      metadata = await input.port.commitMetadata()
    } catch {
      await ignoreHandoffFailure(input.port, 'cleanup-failed')
      return {
        kind: 'recovery-pending',
        reason: 'cleanup-failed',
        ...(receipt ? { receipt } : {}),
        ...(canonical ? { canonical } : {}),
      }
    }
    if (metadata.outcome === 'stale') {
      await ignoreHandoffFailure(input.port, 'cleanup-failed')
      return {
        kind: 'recovery-pending',
        reason: 'cleanup-failed',
        ...(receipt ? { receipt } : {}),
        ...(canonical ? { canonical } : {}),
      }
    }
    lease = metadata.lease
  }
  if (lease.phase !== 'metadata-committed') {
    throw new Error(`AttemptTerminalLeasePhaseInvalid:${lease.streamId}:${lease.phase}`)
  }
  try {
    const retired = await input.port.retire()
    return retired.kind === 'retired'
      ? {
          kind: 'retired',
          ...(receipt ? { receipt } : {}),
          ...(canonical ? { canonical } : {}),
          cleanup: retired.cleanup,
        }
      : {
          ...retired,
          ...(receipt ? { receipt } : {}),
          ...(canonical ? { canonical } : {}),
        }
  } catch {
    await ignoreHandoffFailure(input.port, 'cleanup-failed')
    return {
      kind: 'recovery-pending',
      reason: 'cleanup-failed',
      ...(receipt ? { receipt } : {}),
      ...(canonical ? { canonical } : {}),
    }
  }
}

export function createWriterAttemptTerminalOwner(input: {
  readonly repository: () => WorkspaceRepository
  readonly permit: WorkspaceWritePermit
  readonly handle: StreamLeaseHandle
  readonly journal: () => { settle(): Promise<void> }
}): AttemptTerminalOwner {
  return createAttemptTerminalOwner(createWriterAttemptTerminalPort(input))
}

export function createRecoveryAttemptTerminalOwner(input: {
  readonly repository: WorkspaceRepository
  readonly permit: WorkspaceWritePermit
  readonly lease: FencedStreamLeaseRow
}): AttemptTerminalOwner {
  return createAttemptTerminalOwner(createRecoveryAttemptTerminalPort(input))
}

export function createAttemptTerminalLeaseApplications(input: {
  readonly chatId: ChatId
  readonly streamId: string
  readonly workspaceId: string
}): StreamLeaseLocalApplications {
  return {
    postCommitMetadata: (committed) => applyPostCommitMetadata(committed, input.chatId),
    cleanup: (committed) => applyStreamCleanup(committed, input.streamId),
    handoff: (committed) => {
      attemptController.applyLocalCommittedTransition(
        [
          {
            kind: 'observe-lease',
            lease: committed.value,
            options: { workspaceId: input.workspaceId },
          },
        ],
        () => undefined,
      )
      return 'applied'
    },
  }
}

function createWriterAttemptTerminalPort(input: {
  readonly repository: () => WorkspaceRepository
  readonly permit: WorkspaceWritePermit
  readonly handle: StreamLeaseHandle
  readonly journal: () => { settle(): Promise<void> }
}): AttemptTerminalCustodyPort {
  return {
    get lease() {
      return input.handle.lease
    },
    seal: async (proposal) => {
      try {
        await input.journal().settle()
      } catch (error) {
        throw new AttemptTerminalSealError('journal-settle-failed', error)
      }
      try {
        return await input.handle.sealTerminal({
          ...proposal,
          journalCompleteness: 'settled',
        })
      } catch (error) {
        throw new AttemptTerminalSealError('finalize-failed', error)
      }
    },
    canonicalize: (projection) =>
      commitCanonicalAttempt({
        repository: input.repository(),
        permit: input.permit,
        lease: input.handle.lease,
        projection,
      }),
    commitMetadata: () => input.handle.commitPostCommitMetadata(),
    retire: async () => {
      const stopped = await input.handle.retire({
        mode: 'cleanup',
        handoffReason: 'cleanup-failed',
      })
      return stopped.mode === 'cleanup'
        ? { kind: 'retired', cleanup: stopped.result }
        : { kind: 'recovery-pending', reason: 'cleanup-failed' }
    },
    handoff: async (reason) => {
      const stopped = await input.handle.retire({ mode: 'handoff', reason })
      if (stopped.mode !== 'handoff') {
        throw new Error(`AttemptTerminalHandoffNotCommitted:${input.handle.streamId}`)
      }
    },
  }
}

function createRecoveryAttemptTerminalPort(input: {
  readonly repository: WorkspaceRepository
  readonly permit: WorkspaceWritePermit
  readonly lease: FencedStreamLeaseRow
}): AttemptTerminalCustodyPort {
  let lease = input.lease
  return {
    get lease() {
      return lease
    },
    seal: async (proposal) => {
      const committed = await input.repository.execute(input.permit, {
        kind: 'attempt.seal-terminal',
        input: {
          streamId: lease.streamId,
          fence: streamWriteFenceForLease(lease),
          ...proposal,
          journalCompleteness: 'settled',
        },
      })
      lease = committed.value
      return committed.value
    },
    canonicalize: async (projection) => {
      const finalized = await commitCanonicalAttempt({
        repository: input.repository,
        permit: input.permit,
        lease,
        projection,
      })
      if (!streamLeaseHasWriteFence(finalized.lease)) {
        throw new Error(`AttemptTerminalLeaseFenceMissing:${finalized.lease.streamId}`)
      }
      lease = finalized.lease
      return finalized
    },
    commitMetadata: async () => {
      const committed = await input.repository.execute(
        input.permit,
        {
          kind: 'generation.post-commit-metadata',
          input: {
            streamId: lease.streamId,
            fence: streamWriteFenceForLease(lease),
          },
        },
        {
          localApplications: {
            conversation: (applied) => applyPostCommitMetadata(applied, lease.chatId),
          },
        },
      )
      if (committed.value.outcome !== 'stale') {
        if (!streamLeaseHasWriteFence(committed.value.lease)) {
          throw new Error(`AttemptTerminalLeaseFenceMissing:${lease.streamId}`)
        }
        lease = committed.value.lease
      }
      return committed.value
    },
    retire: async () => {
      const cleanup = await finishStreamCleanup({
        repository: input.repository,
        permit: input.permit,
        chatId: lease.chatId,
        streamId: lease.streamId,
        fence: streamWriteFenceForLease(lease),
        application: (committed) => applyStreamCleanup(committed, lease.streamId),
      })
      return { kind: 'retired', cleanup }
    },
    handoff: () => Promise.resolve(),
  }
}

async function commitCanonicalAttempt(input: {
  readonly repository: WorkspaceRepository
  readonly permit: WorkspaceWritePermit
  readonly lease: FencedStreamLeaseRow
  readonly projection: AttemptTerminalProjection
}): Promise<AttemptFinalizeResult> {
  try {
    return (
      await input.repository.execute(
        input.permit,
        { kind: 'attempt.finalize', input: input.projection },
        {
          localApplications: {
            conversation: (committed) => {
              applyCanonicalAttemptResult(committed.value, committed, () =>
                conversationController.applyCommittedEffect(
                  conversationCommittedEffectForCommit(committed, input.lease.chatId),
                ),
              )
              return 'applied'
            },
          },
        },
      )
    ).value
  } catch (error) {
    const reconciled = await reconcileCanonicalAttempt(input).catch(() => undefined)
    if (reconciled) {
      applyCanonicalAttemptResult(reconciled, input.permit, () => {
        if (reconciled.presentation) {
          conversationController.admitExactPresentation(input.permit, reconciled.presentation)
        }
      })
      return reconciled
    }
    throw error
  }
}

function applyCanonicalAttemptResult(
  result: AttemptFinalizeResult,
  fence: WorkspaceFence,
  publishConversation: () => void,
): void {
  const handoff =
    result.outcome === 'target-missing'
      ? null
      : targetCommitHandoffFromLease(result.lease, fence.workspaceId)
  if (result.presentation && !handoff) {
    throw new Error(`AttemptTargetCommitHandoffMissing:${result.lease.streamId}`)
  }
  attemptController.applyLocalCommittedTransition(
    handoff
      ? [
          {
            kind: 'observe-lease',
            lease: result.lease,
            options: { workspaceId: fence.workspaceId },
          },
        ]
      : [
          {
            kind: 'observe-lease',
            lease: result.lease,
            options: { workspaceId: fence.workspaceId },
          },
          {
            kind: 'clear-live-projection',
            streamId: result.lease.streamId,
            fence,
          },
          { kind: 'remove', streamId: result.lease.streamId, fence },
        ],
    publishConversation,
  )
}

async function reconcileCanonicalAttempt(input: {
  readonly repository: WorkspaceRepository
  readonly permit: WorkspaceWritePermit
  readonly lease: FencedStreamLeaseRow
}): Promise<AttemptFinalizeResult | undefined> {
  const [leaseEnvelope, presentationEnvelope] = await Promise.all([
    input.repository.query(input.permit, {
      kind: 'stream.lease',
      streamId: input.lease.streamId,
    }),
    input.repository.query(input.permit, {
      kind: 'message.presentation',
      messageId: input.lease.messageId,
    }),
  ])
  const lease = leaseEnvelope.value
  if (
    !lease ||
    !streamLeaseHasWriteFence(lease) ||
    (lease.phase !== 'canonical' && lease.phase !== 'metadata-committed') ||
    !sameWriteFence(streamWriteFenceForLease(lease), streamWriteFenceForLease(input.lease))
  ) {
    return undefined
  }
  const presentation = presentationEnvelope.value
  return {
    outcome: presentation ? 'already-canonical' : 'target-missing',
    ...(presentation ? { presentation } : {}),
    lease,
  }
}

function applyPostCommitMetadata(
  committed: Parameters<WorkspaceLocalCommitApplication<GenerationPostCommitMetadataResult>>[0],
  chatId: ChatId,
): 'applied' | 'inactive' {
  if (committed.value.outcome === 'stale') return 'inactive'
  attemptController.applyLocalCommittedTransition(
    [
      {
        kind: 'observe-lease',
        lease: committed.value.lease,
        options: { workspaceId: committed.workspaceId },
      },
    ],
    () => {
      if (committed.value.outcome !== 'applied') return
      conversationController.applyCommittedEffect(
        conversationCommittedEffectForCommit(committed, chatId),
      )
    },
  )
  return 'applied'
}

function applyStreamCleanup(
  committed: Parameters<WorkspaceLocalCommitApplication<StreamFinishCleanupResult>>[0],
  streamId: string,
): 'applied' {
  if (committed.value.deletedLease) {
    attemptController.reconcileLeasePoints(committed, [streamId], [undefined])
  }
  return 'applied'
}

class AttemptTerminalSealError extends Error {
  readonly reason: StreamLeaseHandoffReason

  constructor(reason: StreamLeaseHandoffReason, cause: unknown) {
    super('AttemptTerminalSealFailed', { cause })
    this.name = 'AttemptTerminalSealError'
    this.reason = reason
  }
}

function terminalSealFailureReason(error: unknown): StreamLeaseHandoffReason {
  return error instanceof AttemptTerminalSealError ? error.reason : 'finalize-failed'
}

function terminalSealCause(error: unknown): unknown {
  return error instanceof AttemptTerminalSealError ? error.cause : error
}

async function ignoreHandoffFailure(
  port: AttemptTerminalCustodyPort,
  reason: StreamLeaseHandoffReason,
): Promise<void> {
  try {
    await port.handoff(reason)
  } catch {
    return
  }
}

function terminalStatus(
  decision: AttemptTerminalDecision,
): 'done' | 'error' | 'abort' | 'interrupted' {
  if (decision.outcome !== 'abort') return decision.outcome
  return decision.abortReason === 'tab-close' ? 'interrupted' : 'abort'
}

function assertReceiptProposal(
  receipt: AttemptTerminalReceipt,
  finishedAt: number,
  decision: AttemptTerminalDecision,
): void {
  if (
    receipt.finishedAt !== finishedAt ||
    JSON.stringify(receipt.decision) !== JSON.stringify(decision)
  ) {
    throw new Error('AttemptTerminalReceiptProjectionMismatch')
  }
}

function receiptMatchesPreparation(
  receipt: AttemptTerminalReceipt,
  preparation: AttemptTerminalPreparation,
): boolean {
  return (
    receipt.finishedAt === preparation.finishedAt &&
    JSON.stringify(receipt.decision) === JSON.stringify(preparation.decision)
  )
}

function sameWriteFence(left: StreamWriteFence, right: StreamWriteFence): boolean {
  return (
    left.ownerClientId === right.ownerClientId &&
    left.fenceToken === right.fenceToken &&
    left.replacementEpoch === right.replacementEpoch &&
    left.admissionSequence === right.admissionSequence
  )
}

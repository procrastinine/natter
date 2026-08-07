import { type AttemptTerminalReceipt, isAttemptTerminalReceipt } from '../core/attempt-outcome'
import type { AppliedMessageSemanticEffect } from '../core/continuation-content'
import type {
  ConversationAppendSelectionTransition,
  ConversationProvedSelection,
  ConversationSelectionProofTarget,
  MessageMutationFinalizationContext,
} from '../core/messages'
import {
  isPersistedInboundReasoningVisibility,
  isPersistedReasoningCarryForward,
  UNKNOWN_INBOUND_REASONING_VISIBILITY,
} from '../core/reasoning'
import type { SidebarSortExtrema, SidebarSortField, SidebarSortMode } from '../core/sidebar-sort'
import type { CalibrationMode, PromptCalibrationBasis } from '../core/token-calibration'
import type { TokenizerFamily } from '../core/tokens'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  AttachmentKind,
  AttachmentMissingReason,
  AttachmentOrigin,
  AttachmentReferenceEdge,
  AttachmentStorage,
  Chat,
  ChatFolder,
  ChatId,
  ChatSidebarRow,
  ChatTag,
  ChatUsage,
  ChatVersions,
  ChildListState,
  ChildSlotMember,
  ContinuationStrategy,
  DispatchedGenerationMeta,
  DraftRow,
  FolderId,
  GenerationMeta,
  KeyId,
  Message,
  MessageAttachmentRef,
  MessageId,
  PersistedInboundReasoningVisibility,
  PersistedReasoningCarryForward,
  PresetId,
  ProfileId,
  TagId,
  TextTemplateConfig,
  TokenCalibrationSample,
} from '../core/types'
import type { ActiveBranchPathSlotFrame } from './active-branch-fork-storage'
import {
  type MessageBodyFields,
  type MessageHeaderRow,
  type MessagePresentation,
  rebaseHydratedMessageHeader,
  sameMessageHeaderValue,
} from './message-storage'
import { CURRENT_STREAM_JOURNAL_EVENT_VERSION } from './persisted-stream-event'
import type { CanonicalStreamJournalFrameRow } from './stream-journal-codec'

export type {
  CanonicalStreamJournalFrameRow,
  StreamJournalFrameRow,
  StreamJournalValueToken,
} from './stream-journal-codec'
export {
  isStreamJournalFrameRow,
  streamJournalFrameId,
  streamJournalFrameStreamId,
} from './stream-journal-codec'

export class WorkspaceSessionClosedError extends Error {
  constructor(message = 'WorkspaceSessionClosed', cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'WorkspaceSessionClosedError'
  }
}

export class ChatMissingError extends Error {
  readonly chatId: ChatId

  constructor(chatId: ChatId) {
    super(`ChatMissing:${chatId}`)
    this.name = 'ChatMissingError'
    this.chatId = chatId
  }
}

export type StorageMaintenanceTaskKind =
  | 'recover-compaction-intents'
  | 'clean-replacement-database'
  | 'reconcile-attachment-integrity'
  | 'reconcile-stream-integrity'
  | 'reclaim-inactive-databases'
  | 'reap-attachments'
  | 'prune-terminal-streams'
  | 'prune-empty-drafts'
  | 'prune-discovery-cache'
  | 'compact-workspace'

export type StorageMaintenanceRequestTaskKind = Extract<
  StorageMaintenanceTaskKind,
  | 'clean-replacement-database'
  | 'reconcile-attachment-integrity'
  | 'reap-attachments'
  | 'prune-terminal-streams'
  | 'prune-empty-drafts'
  | 'prune-discovery-cache'
  | 'compact-workspace'
>

export type BranchTargetUnavailableReason =
  | 'message-missing'
  | 'message-deleted'
  | 'message-chat-mismatch'
  | 'invalid-ancestry'
  | 'ancestry-cycle'

export class BranchTargetUnavailableError extends Error {
  readonly chatId: ChatId
  readonly targetMessageId: MessageId
  readonly reason: BranchTargetUnavailableReason

  constructor(chatId: ChatId, targetMessageId: MessageId, reason: BranchTargetUnavailableReason) {
    super(`BranchTargetUnavailable:${chatId}:${targetMessageId}:${reason}`)
    this.name = 'BranchTargetUnavailableError'
    this.chatId = chatId
    this.targetMessageId = targetMessageId
    this.reason = reason
  }
}

export class ChatStreamBusyError extends Error {
  readonly chatId: ChatId
  readonly streamId: string

  constructor(chatId: ChatId, streamId: string) {
    super(`ChatStreamBusy:${chatId}:${streamId}`)
    this.name = 'ChatStreamBusyError'
    this.chatId = chatId
    this.streamId = streamId
  }
}

export class NoEligibleProvidersError extends Error {
  constructor() {
    super('No eligible providers can serve this request.')
    this.name = 'NoEligibleProvidersError'
  }
}

export class ProviderCatalogEmptyError extends Error {
  constructor() {
    super('No provider endpoints are currently available for this model.')
    this.name = 'ProviderCatalogEmptyError'
  }
}

export interface WorkspaceFence {
  workspaceId: string
  replacementEpoch: number
}

export type WorkspaceCommittedResult<T> = T & WorkspaceFence

export interface CommittedConversationDestination extends WorkspaceFence {
  readonly destination: ConversationProvedSelection
}

export interface CommittedConversationTransition extends WorkspaceFence {
  readonly transition: ConversationAppendSelectionTransition
}

export function committedConversationResult<
  T extends { readonly destination: ConversationProvedSelection },
>(value: T, fence: WorkspaceFence): WorkspaceCommittedResult<T> {
  return Object.freeze({
    ...value,
    workspaceId: fence.workspaceId,
    replacementEpoch: fence.replacementEpoch,
  })
}

export function committedConversationTransition(
  transition: ConversationAppendSelectionTransition,
  fence: WorkspaceFence,
): CommittedConversationTransition {
  return Object.freeze({
    transition,
    workspaceId: fence.workspaceId,
    replacementEpoch: fence.replacementEpoch,
  })
}

export interface WorkspaceMeta extends WorkspaceFence {
  backendKind: 'browser-idb' | 'daemon' | 'unknown'
}

export interface MessageTextPreviewSnapshot {
  messageId: MessageId
  bodyVersion: number
  text: string
}

export interface MessageTextPreviewTarget {
  messageId: MessageId
  bodyVersion: number
}

export interface StreamWriteFence {
  ownerClientId: string
  fenceToken: string
  replacementEpoch: number
  admissionSequence: number
}

export { STREAM_LEASE_TTL_MS } from './stream-lease-policy'

export class StreamTargetBusyError extends Error {
  readonly messageId: MessageId

  constructor(messageId: MessageId) {
    super(`StreamTargetBusy:${messageId}`)
    this.name = 'StreamTargetBusyError'
    this.messageId = messageId
  }
}

export class WorkspaceReplacementFenceError extends Error {
  constructor() {
    super('WorkspaceReplacementFenceChanged')
    this.name = 'WorkspaceReplacementFenceError'
  }
}

export type ExpectedLeafChangedReason =
  | 'missing'
  | 'deleted'
  | 'wrong-chat'
  | 'has-live-child'
  | 'root-not-empty'

export class ExpectedLeafChangedError extends Error {
  readonly chatId: ChatId
  readonly expectedLeafId: MessageId | null
  readonly reason: ExpectedLeafChangedReason
  readonly blockingChildId?: MessageId

  constructor(
    chatId: ChatId,
    expectedLeafId: MessageId | null,
    reason: ExpectedLeafChangedReason,
    blockingChildId?: MessageId,
  ) {
    super(
      `ExpectedLeafChanged:${chatId}:${expectedLeafId ?? '__root__'}:${reason}${blockingChildId ? `:${blockingChildId}` : ''}`,
    )
    this.name = 'ExpectedLeafChangedError'
    this.chatId = chatId
    this.expectedLeafId = expectedLeafId
    this.reason = reason
    if (blockingChildId !== undefined) this.blockingChildId = blockingChildId
  }
}

export interface WorkspaceMutationOptions {
  initialChat?: Chat
  requiredProfileId?: ProfileId
  promoteChatId?: ChatId
  generationReadSet?: GenerationPromptReadSet
  captureGenerationPlanningSnapshot?: boolean
  maintainConfigurationLinksForChatId?: ChatId
  streamAdmission?: StreamLeaseAdmission
  streamFence?: {
    streamId: string
    fence: StreamWriteFence
  }
  streamTargetCommit?: StreamTargetCommit
  streamCanonicalCommit?: {
    streamId: string
    terminal: AttemptTerminalReceipt
    postCommitFinal: Pick<
      StreamPostCommitFinalEvidence,
      'selectedKeyId' | 'usage' | 'completionAllowed'
    >
  }
  allowMissingCanonicalChatId?: ChatId
  workspaceFence?: {
    replacementEpoch: number
  }
  expectedAttachmentCatalogRevision?: number
  settingReadKeys?: readonly string[]
  attachmentContentIdentity?: {
    readonly attachmentId: AttachmentId
    readonly contentHash?: string
    readonly filename: string
  }
  storageMaintenanceTasks?: readonly StorageMaintenanceRequestTaskKind[]
  fastCurrentLeafSummaryTarget?: MessageId
}

export interface StreamStopControl {
  readonly requestId: string
  readonly requestedBy: string
  readonly requestedAt: number
  readonly reason: 'user'
}

interface StreamLeaseCommon {
  streamId: string
  chatId: ChatId
  messageId: MessageId
  replacementEpoch: number
  startedAt: number
  admissionSequence: number
  revision: number
  controlRevision: number
  journalEventVersion: typeof CURRENT_STREAM_JOURNAL_EVENT_VERSION
  stopControl?: StreamStopControl
  journalStorageBytes?: number
  journalMaxSeq?: number
}

export type StreamLeaseCustody =
  | {
      custody: 'writer'
      ownerClientId: string
      fenceToken: string
      heartbeatAt: number
      handoffId?: never
      handedOffAt?: never
      handoffReason?: never
    }
  | {
      custody: 'recovery'
      ownerClientId: string
      fenceToken: string
      heartbeatAt: number
      handoffId?: never
      handedOffAt?: never
      handoffReason?: never
    }
  | {
      custody: 'recovery-pending'
      ownerClientId?: never
      fenceToken?: never
      heartbeatAt?: never
      handoffId: string
      handedOffAt: number
      handoffReason: StreamLeaseHandoffReason
    }

export type StreamLeaseHandoffReason =
  | 'adoption-failed'
  | 'cleanup-failed'
  | 'journal-settle-failed'
  | 'finalize-failed'
  | 'owner-unavailable'

export interface StreamGenerationDispatchEvidence {
  targetCommittedAt: number
  requestedModel: string
  apiUsed: GenerationMeta['apiUsed']
  reasoningCarryForward: PersistedReasoningCarryForward
  reasoningVisibility: PersistedInboundReasoningVisibility
}

export interface StreamContinuationDispatchEvidence extends StreamGenerationDispatchEvidence {
  continuationStrategy: ContinuationStrategy
  baseNodeVersion: number
  baseBodyVersion: number
}

type StreamLeaseProgress<Dispatch> =
  | {
      phase: 'reserved'
      targetOwnerKey: MessageId
      postCommit: StreamPostCommitPlan
      dispatch?: never
      terminal?: never
      canonicalAt?: never
      metadataCommittedAt?: never
      terminalRetentionAt?: never
    }
  | {
      phase: 'active'
      targetOwnerKey: MessageId
      postCommit: StreamPostCommitPlan
      dispatch: Dispatch
      terminal?: never
      canonicalAt?: never
      metadataCommittedAt?: never
      terminalRetentionAt?: never
    }
  | {
      phase: 'terminal-decided'
      targetOwnerKey: MessageId
      postCommit: StreamPostCommitPlan
      dispatch: Dispatch | null
      terminal: AttemptTerminalReceipt
      canonicalAt?: never
      metadataCommittedAt?: never
      terminalRetentionAt?: never
    }
  | {
      phase: 'canonical'
      targetOwnerKey?: never
      dispatch: Dispatch | null
      terminal?: never
      canonicalAt: number
      metadataCommittedAt?: never
      terminalRetentionAt?: never
      postCommit: StreamPostCommitCompletedEvidence
    }
  | {
      phase: 'metadata-committed'
      targetOwnerKey?: never
      dispatch: Dispatch | null
      terminal?: never
      canonicalAt: number
      metadataCommittedAt: number
      terminalRetentionAt: number
      postCommit: StreamPostCommitCompletedEvidence
    }

type StreamLeaseByAttempt<
  Kind extends 'generation' | 'continuation',
  Dispatch,
> = StreamLeaseCommon &
  StreamLeaseCustody & {
    attemptKind: Kind
  } & StreamLeaseProgress<Dispatch>

export type StreamLeaseRow =
  | StreamLeaseByAttempt<'generation', StreamGenerationDispatchEvidence>
  | StreamLeaseByAttempt<'continuation', StreamContinuationDispatchEvidence>

export type FencedStreamLeaseRow = Exclude<StreamLeaseRow, { custody: 'recovery-pending' }>
export type WriterStreamLeaseRow = Extract<StreamLeaseRow, { custody: 'writer' }>
export type WriterReservedStreamLeaseRow = Extract<WriterStreamLeaseRow, { phase: 'reserved' }>
export type WriterActiveStreamLeaseRow = Extract<WriterStreamLeaseRow, { phase: 'active' }>
export type TerminalDecidedStreamLeaseRow = Extract<
  FencedStreamLeaseRow,
  { phase: 'terminal-decided' }
>
export type CanonicalStreamLeaseRow = Extract<FencedStreamLeaseRow, { phase: 'canonical' }>
export type MetadataCommittedStreamLeaseRow = Extract<
  FencedStreamLeaseRow,
  { phase: 'metadata-committed' }
>

export function streamLeaseOccupiesTarget(lease: StreamLeaseRow): boolean {
  return lease.targetOwnerKey !== undefined
}

export function streamLeaseHasWriteFence(lease: StreamLeaseRow): lease is FencedStreamLeaseRow {
  return lease.custody === 'writer' || lease.custody === 'recovery'
}

export function streamLeaseMatchesWriteFence(
  lease: StreamLeaseRow | undefined,
  fence: StreamWriteFence,
): lease is FencedStreamLeaseRow {
  return Boolean(
    lease &&
      streamLeaseHasWriteFence(lease) &&
      lease.ownerClientId === fence.ownerClientId &&
      lease.fenceToken === fence.fenceToken &&
      lease.replacementEpoch === fence.replacementEpoch &&
      lease.admissionSequence === fence.admissionSequence,
  )
}

export function streamLeaseDispatchEvidence(
  lease: StreamLeaseRow,
): StreamGenerationDispatchEvidence | StreamContinuationDispatchEvidence | null {
  return lease.phase === 'reserved' ? null : lease.dispatch
}

export function streamLeaseReasoningCarryForward(
  lease: StreamLeaseRow,
): PersistedReasoningCarryForward {
  return streamLeaseDispatchEvidence(lease)?.reasoningCarryForward ?? 'none'
}

export function streamLeaseReasoningVisibility(
  lease: StreamLeaseRow,
): PersistedInboundReasoningVisibility {
  return (
    streamLeaseDispatchEvidence(lease)?.reasoningVisibility ?? UNKNOWN_INBOUND_REASONING_VISIBILITY
  )
}

export interface StreamPostCommitCalibrationPlan {
  modelId: string
  family: TokenizerFamily
  mode: CalibrationMode
  promptBasis?: PromptCalibrationBasis
  promptAllowed: boolean
  expectedChatGeneration: number
  expectedGlobalClearGeneration: number
}

export interface StreamPostCommitUsageEvidence {
  promptTokens: number
  completionTokens: number
  reasoningTokens?: number
}

export interface StreamPostCommitFinalCalibrationEvidence {
  messageTextChars: number
  completionSample?: {
    chars: number
    tokens: number
  }
}

export interface StreamPostCommitFinalEvidence {
  selectedKeyId?: KeyId
  usage?: StreamPostCommitUsageEvidence
  completionAllowed: boolean
  expectedNodeVersion?: number
  expectedBodyVersion?: number
  calibration?: StreamPostCommitFinalCalibrationEvidence
}

export interface StreamPostCommitEvidence {
  usedAt: number
  profileId: ProfileId
  presetId?: PresetId
  recentModelId?: string
  selectedKeyId?: KeyId
  calibration?: StreamPostCommitCalibrationPlan
  final?: StreamPostCommitFinalEvidence
}

export type StreamPostCommitPlan = Omit<StreamPostCommitEvidence, 'final'> & { final?: never }

export type StreamPostCommitCompletedEvidence = Omit<StreamPostCommitEvidence, 'final'> & {
  final: StreamPostCommitFinalEvidence
}

export function isStreamLeaseRow(value: unknown): value is StreamLeaseRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  const postCommit = row.postCommit
  if (postCommit !== undefined && !isStreamPostCommitEvidence(postCommit)) return false
  const commonFieldsValid =
    isNonEmptyString(row.streamId) &&
    isNonEmptyString(row.chatId) &&
    isNonEmptyString(row.messageId) &&
    isNonNegativeSafeInteger(row.replacementEpoch) &&
    isNonNegativeSafeInteger(row.startedAt) &&
    isNonNegativeSafeInteger(row.admissionSequence) &&
    isNonNegativeSafeInteger(row.controlRevision) &&
    row.journalEventVersion === CURRENT_STREAM_JOURNAL_EVENT_VERSION &&
    isStreamStopControl(row.stopControl) &&
    (row.journalStorageBytes === undefined || isNonNegativeSafeInteger(row.journalStorageBytes)) &&
    (row.journalMaxSeq === undefined || isNonNegativeSafeInteger(row.journalMaxSeq)) &&
    isNonNegativeSafeInteger(row.revision) &&
    (row.attemptKind === 'generation' || row.attemptKind === 'continuation') &&
    (row.canonicalAt === undefined || isNonNegativeSafeInteger(row.canonicalAt)) &&
    (row.metadataCommittedAt === undefined || isNonNegativeSafeInteger(row.metadataCommittedAt)) &&
    (row.terminalRetentionAt === undefined || isNonNegativeSafeInteger(row.terminalRetentionAt))
  if (!commonFieldsValid) return false
  if (!isStreamLeaseCustody(row)) return false
  if (
    (row.stopControl === undefined && row.controlRevision !== 0) ||
    (row.stopControl !== undefined && row.controlRevision === 0)
  ) {
    return false
  }
  if (postCommit === undefined) return false
  if (postCommit.final !== undefined) {
    if (row.phase === 'reserved' || row.phase === 'active' || row.phase === 'terminal-decided') {
      return false
    }
  }
  const terminal = row.phase === 'canonical' || row.phase === 'metadata-committed'
  const decided = row.phase === 'terminal-decided'
  if (!terminal && !decided && row.phase !== 'reserved' && row.phase !== 'active') return false
  if (terminal) {
    if (
      row.targetOwnerKey !== undefined ||
      (row.phase === 'metadata-committed' && row.terminalRetentionAt !== row.canonicalAt) ||
      (row.phase === 'canonical' && row.terminalRetentionAt !== undefined)
    ) {
      return false
    }
  } else if (row.targetOwnerKey !== row.messageId || row.terminalRetentionAt !== undefined) {
    return false
  }
  if (terminal !== (row.canonicalAt !== undefined)) return false
  if ((row.phase === 'metadata-committed') !== (row.metadataCommittedAt !== undefined)) return false
  if (terminal && postCommit.final === undefined) return false
  if (!terminal && postCommit.final !== undefined) return false
  if (decided !== (row.terminal !== undefined)) return false
  if (decided && !isAttemptTerminalReceipt(row.terminal)) return false
  if (
    decided &&
    (row.terminal as AttemptTerminalReceipt).journalMaxSeq !== (row.journalMaxSeq ?? -1)
  ) {
    return false
  }
  if (row.phase === 'reserved') return row.dispatch === undefined && row.terminal === undefined
  if (!terminal && !decided && row.dispatch === null) return false
  if (terminal && row.dispatch === null) return true
  if (decided && row.dispatch === null) return true
  return isStreamDispatchEvidence(row.dispatch, row.attemptKind)
}

export function requireStreamLeaseRow(value: unknown): StreamLeaseRow {
  if (!isStreamLeaseRow(value)) throw new Error('StreamLeaseRowInvalid')
  return value
}

export function commitStreamLeaseMetadata(
  lease: CanonicalStreamLeaseRow,
  metadataCommittedAt: number,
): MetadataCommittedStreamLeaseRow {
  if (!isNonNegativeSafeInteger(metadataCommittedAt)) {
    throw new Error(`StreamLeaseMetadataCommitTimeInvalid:${lease.streamId}`)
  }
  if (lease.revision >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`StreamLeaseRevisionExhausted:${lease.streamId}`)
  }
  const committed = requireStreamLeaseRow({
    ...lease,
    phase: 'metadata-committed',
    metadataCommittedAt,
    terminalRetentionAt: lease.canonicalAt,
    revision: lease.revision + 1,
  })
  if (committed.phase !== 'metadata-committed' || !streamLeaseHasWriteFence(committed)) {
    throw new Error(`MetadataCommittedStreamLeaseRowInvalid:${lease.streamId}`)
  }
  return committed
}

export function requireWriterReservedStreamLeaseRow(value: unknown): WriterReservedStreamLeaseRow {
  const lease = requireStreamLeaseRow(value)
  if (lease.custody !== 'writer' || lease.phase !== 'reserved') {
    throw new Error('WriterReservedStreamLeaseRowInvalid')
  }
  return lease
}

export function requireWriterActiveStreamLeaseRow(value: unknown): WriterActiveStreamLeaseRow {
  const lease = requireStreamLeaseRow(value)
  if (lease.custody !== 'writer' || lease.phase !== 'active') {
    throw new Error('WriterActiveStreamLeaseRowInvalid')
  }
  return lease
}

function isStreamLeaseCustody(row: Record<string, unknown>): boolean {
  if (row.custody === 'recovery-pending') {
    return (
      row.ownerClientId === undefined &&
      row.fenceToken === undefined &&
      row.heartbeatAt === undefined &&
      isNonEmptyString(row.handoffId) &&
      isNonNegativeSafeInteger(row.handedOffAt) &&
      (row.handoffReason === 'adoption-failed' ||
        row.handoffReason === 'cleanup-failed' ||
        row.handoffReason === 'journal-settle-failed' ||
        row.handoffReason === 'finalize-failed' ||
        row.handoffReason === 'owner-unavailable')
    )
  }
  return (
    (row.custody === 'writer' || row.custody === 'recovery') &&
    isNonEmptyString(row.ownerClientId) &&
    isNonEmptyString(row.fenceToken) &&
    isNonNegativeSafeInteger(row.heartbeatAt) &&
    row.handoffId === undefined &&
    row.handedOffAt === undefined &&
    row.handoffReason === undefined
  )
}

function isStreamDispatchEvidence(
  value: unknown,
  attemptKind: unknown,
): value is StreamGenerationDispatchEvidence | StreamContinuationDispatchEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const dispatch = value as Record<string, unknown>
  if (
    !isNonNegativeSafeInteger(dispatch.targetCommittedAt) ||
    !isNonEmptyString(dispatch.requestedModel) ||
    !isGenerationApi(dispatch.apiUsed) ||
    !isPersistedReasoningCarryForward(dispatch.reasoningCarryForward) ||
    !isPersistedInboundReasoningVisibility(dispatch.reasoningVisibility)
  ) {
    return false
  }
  if (attemptKind === 'generation') {
    return (
      dispatch.continuationStrategy === undefined &&
      dispatch.baseNodeVersion === undefined &&
      dispatch.baseBodyVersion === undefined
    )
  }
  return (
    (dispatch.continuationStrategy === 'prompt' || dispatch.continuationStrategy === 'prefill') &&
    isNonNegativeSafeInteger(dispatch.baseNodeVersion) &&
    isNonNegativeSafeInteger(dispatch.baseBodyVersion)
  )
}

function isStreamPostCommitEvidence(value: unknown): value is StreamPostCommitEvidence {
  if (!value || typeof value !== 'object') return false
  const evidence = value as Partial<StreamPostCommitEvidence>
  if (
    !isNonNegativeSafeInteger(evidence.usedAt) ||
    !isNonEmptyString(evidence.profileId) ||
    (evidence.presetId !== undefined && !isNonEmptyString(evidence.presetId)) ||
    (evidence.recentModelId !== undefined && !isNonEmptyString(evidence.recentModelId)) ||
    (evidence.selectedKeyId !== undefined && !isNonEmptyString(evidence.selectedKeyId))
  ) {
    return false
  }
  if (evidence.calibration) {
    const calibration = evidence.calibration
    const basis = calibration.promptBasis
    if (
      !isNonEmptyString(calibration.modelId) ||
      !isTokenizerFamily(calibration.family) ||
      !isCalibrationMode(calibration.mode) ||
      typeof calibration.promptAllowed !== 'boolean' ||
      !isNonNegativeSafeInteger(calibration.expectedChatGeneration) ||
      !isNonNegativeSafeInteger(calibration.expectedGlobalClearGeneration) ||
      (basis !== undefined &&
        (!Number.isFinite(basis.chars) ||
          basis.chars < 0 ||
          !Number.isFinite(basis.tokenOverhead) ||
          basis.tokenOverhead < 0))
    ) {
      return false
    }
  }
  if (evidence.final) {
    const final = evidence.final
    const completionSample = final.calibration?.completionSample
    if (
      (final.selectedKeyId !== undefined && !isNonEmptyString(final.selectedKeyId)) ||
      (evidence.selectedKeyId !== undefined &&
        final.selectedKeyId !== undefined &&
        evidence.selectedKeyId !== final.selectedKeyId) ||
      (final.usage !== undefined && !isStreamPostCommitUsageEvidence(final.usage)) ||
      typeof final.completionAllowed !== 'boolean' ||
      (final.expectedNodeVersion !== undefined &&
        !isNonNegativeSafeInteger(final.expectedNodeVersion)) ||
      (final.expectedBodyVersion !== undefined &&
        !isNonNegativeSafeInteger(final.expectedBodyVersion)) ||
      (final.calibration !== undefined && evidence.calibration === undefined) ||
      (final.calibration !== undefined &&
        (!isNonNegativeSafeInteger(final.calibration.messageTextChars) ||
          (completionSample !== undefined &&
            (!isNonNegativeSafeInteger(completionSample.chars) ||
              completionSample.chars <= 0 ||
              !isNonNegativeSafeInteger(completionSample.tokens) ||
              completionSample.tokens <= 0))))
    ) {
      return false
    }
  }
  return true
}

function isStreamPostCommitUsageEvidence(value: unknown): value is StreamPostCommitUsageEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const usage = value as Partial<StreamPostCommitUsageEvidence>
  const keys = Object.keys(value)
  return (
    (keys.length === 2 || keys.length === 3) &&
    keys.every(
      (key) => key === 'promptTokens' || key === 'completionTokens' || key === 'reasoningTokens',
    ) &&
    isNonNegativeSafeInteger(usage.promptTokens) &&
    isNonNegativeSafeInteger(usage.completionTokens) &&
    (usage.reasoningTokens === undefined || isNonNegativeSafeInteger(usage.reasoningTokens))
  )
}

export function streamPostCommitUsageEvidence(
  usage: ChatUsage | undefined,
): StreamPostCommitUsageEvidence | undefined {
  if (
    !usage ||
    !isNonNegativeSafeInteger(usage.prompt_tokens) ||
    !isNonNegativeSafeInteger(usage.completion_tokens)
  ) {
    return undefined
  }
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    ...(isNonNegativeSafeInteger(usage.completion_tokens_details?.reasoning_tokens)
      ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens }
      : {}),
  }
}

function isCalibrationMode(value: unknown): value is CalibrationMode {
  return value === 'adaptive' || value === 'global-only' || value === 'family-defaults-only'
}

function isTokenizerFamily(value: unknown): value is TokenizerFamily {
  return (
    value === 'claude' ||
    value === 'gpt' ||
    value === 'gemini' ||
    value === 'llama' ||
    value === 'mistral' ||
    value === 'deepseek' ||
    value === 'qwen' ||
    value === 'unknown'
  )
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isStreamStopControl(value: unknown): value is StreamStopControl | undefined {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const control = value as Record<string, unknown>
  return (
    Object.keys(control).length === 4 &&
    isNonEmptyString(control.requestId) &&
    isNonEmptyString(control.requestedBy) &&
    isNonNegativeSafeInteger(control.requestedAt) &&
    control.reason === 'user'
  )
}

function isGenerationApi(value: unknown): value is GenerationMeta['apiUsed'] {
  return (
    value === 'chat' ||
    value === 'responses' ||
    value === 'gemini-native' ||
    value === 'anthropic-messages' ||
    value === 'completion' ||
    value === 'video-generation'
  )
}

export type StreamLeaseAdmission = Pick<
  StreamLeaseCommon,
  'streamId' | 'chatId' | 'messageId' | 'replacementEpoch' | 'startedAt' | 'journalEventVersion'
> &
  Extract<StreamLeaseCustody, { custody: 'writer' }> & {
    attemptKind: StreamLeaseRow['attemptKind']
  }

export interface StreamLeaseHeartbeat {
  streamId: string
  fence: StreamWriteFence
  expectedRevision: number
  heartbeatAt: number
}

interface StreamTargetCommitBase {
  streamId: string
  messageId: MessageId
  targetCommittedAt: number
  requestedModel: string
  apiUsed: GenerationMeta['apiUsed']
  reasoningCarryForward: PersistedReasoningCarryForward
  reasoningVisibility: PersistedInboundReasoningVisibility
}

export type StreamTargetCommit =
  | (StreamTargetCommitBase & {
      attemptKind: 'generation'
      postCommitCalibration?: StreamPostCommitCalibrationPlan
      continuationStrategy?: never
      baseNodeVersion?: never
      baseBodyVersion?: never
    })
  | (StreamTargetCommitBase & {
      attemptKind: 'continuation'
      postCommitCalibration?: never
      continuationStrategy: ContinuationStrategy
      baseNodeVersion: number
      baseBodyVersion: number
    })

export function streamLeaseHasCommittedTarget(lease: StreamLeaseRow): boolean {
  return (
    lease.phase === 'active' ||
    ((lease.phase === 'terminal-decided' ||
      lease.phase === 'canonical' ||
      lease.phase === 'metadata-committed') &&
      lease.dispatch !== null)
  )
}

export interface StreamJournalFramePage {
  readonly frames: readonly CanonicalStreamJournalFrameRow[]
  readonly nextAfterSeq: number
  readonly done: boolean
}

export interface AttachmentSearchFilters {
  kind?: AttachmentKind
  mime?: string
  origin?: AttachmentOrigin
  storageKind?: AttachmentStorage['kind']
  minSizeBytes?: number
  maxSizeBytes?: number
  minRefCount?: number
  maxRefCount?: number
}

type AttachmentSearchSort =
  | 'created-desc'
  | 'created-asc'
  | 'updated-desc'
  | 'size-desc'
  | 'size-asc'

export interface AttachmentCatalogSearchRequest {
  query?: string
  filters?: AttachmentSearchFilters
  sort?: AttachmentSearchSort
  limit?: number
  cursor?: string
  direction?: 'forward' | 'backward'
}

export interface AttachmentSearchMeasurement {
  selectedIndex: 'kind' | 'mime' | 'origin' | 'refCount' | 'createdAt' | 'updatedAt' | 'primary'
  indexCounts: Partial<Record<'kind' | 'mime' | 'origin' | 'refCount', number>>
  metadataRowsRead: number
  metadataCandidates: number
  embeddedArtifactRowsRead: number
  artifactCandidateAttachments: number
  artifactRowsRead: number
  attachmentBlobRowsRead: 0
  matchedRows: number
  returnedRows: number
}

export interface AttachmentCatalogProcessingSummary {
  processorId: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  startedAt?: number
  finishedAt?: number
  errorCode?: string
}

export interface AttachmentCatalogRow {
  id: AttachmentId
  contentHash?: string
  kind: AttachmentKind
  mime: string
  filename: string
  extension?: string
  sizeBytes: number
  origin: AttachmentOrigin
  sourceUrl?: string
  createdAt: number
  updatedAt: number
  storage: AttachmentStorage
  dimensions?: { width: number; height: number }
  durationMs?: number
  pageCount?: number
  textCharCount?: number
  languageHint?: string
  scannedLike?: boolean
  thumbnailBlobId?: string
  refCount: number
  messageRefCount: number
  draftRefCount: number
  visibleRefCount: number
  hiddenRefCount: number
  missingVisibleRefCount: number
  deletedAt?: number
  supersededByAttachmentId?: string
  lastIntegrityCheckAt?: number
  processing: readonly AttachmentCatalogProcessingSummary[]
}

export interface AttachmentCatalogAggregate {
  totalCount: number
  activeCount: number
  deletedCount: number
  referencedCount: number
  unreferencedCount: number
  localCount: number
  remoteCount: number
  missingCount: number
  generatedCount: number
  totalSizeBytes: number
  localSizeBytes: number
}

export interface AttachmentCatalogPage {
  rows: AttachmentCatalogRow[]
  catalogRevision: number
  catalogTotalCount: number
  previousCursor?: string
  nextCursor?: string
  matchedCount?: number
  complete: boolean
  measurement: AttachmentSearchMeasurement
}

export interface AttachmentArtifactSummary {
  artifactId: string
  kind: AttachmentArtifact['kind']
  processorId: string
  createdAt: number
  charCount?: number
  textPreview?: string
  blobId?: string
}

export interface AttachmentJobSummary {
  id: string
  processorId: string
  status: AttachmentJob['status']
  startedAt?: number
  finishedAt?: number
  error?: { code: string; message: string }
  outputArtifactIds: readonly string[]
  updatedAt: number
}

export interface AttachmentBundle {
  attachment: Attachment
  blobs: readonly AttachmentBlob[]
  artifacts: readonly AttachmentArtifact[]
  jobs: readonly AttachmentJob[]
}

export type AttachmentBundleWriteMode =
  | 'put'
  | 'put-if-absent'
  | 'dedupe'
  | 'replace'
  | 'dedupe-or-replace'

export type AttachmentBundleWriteResult =
  | {
      attachmentId: AttachmentId
      outcome: 'written'
      attachment: Attachment
    }
  | {
      attachmentId: AttachmentId
      outcome: 'existing'
    }

export interface AttachmentDispatchBundle {
  bundle: AttachmentBundle
  wireVersion: number
}

export interface GenerationAttachmentTokenEvidence {
  attachment: Attachment
  wireVersion: number
}

export interface GenerationAttachmentReadProof {
  attachmentId: AttachmentId
  wireVersion: number | null
}

export interface GenerationSavedTextTemplateReadProof {
  templateId: string
  config: TextTemplateConfig | null
}

export interface GenerationMessageReadProof {
  messageId: MessageId
  parentId: MessageId | null
  requestContextVersion: number
}

export function generationMessageReadProofFromHeader(
  header: MessageHeaderRow,
): GenerationMessageReadProof {
  return {
    messageId: header.id,
    parentId: header.parentId,
    requestContextVersion: header.requestContextVersion,
  }
}

export function generationMessageReadProofMatchesHeader(
  chatId: ChatId,
  proof: GenerationMessageReadProof,
  header: MessageHeaderRow | undefined,
): header is MessageHeaderRow {
  return Boolean(
    header &&
      header.id === proof.messageId &&
      header.chatId === chatId &&
      header.parentId === proof.parentId &&
      header.requestContextVersion === proof.requestContextVersion &&
      !header.deleted,
  )
}

export interface GenerationPromptReadSet {
  chatId: ChatId
  messages: readonly GenerationMessageReadProof[]
  attachments: readonly GenerationAttachmentReadProof[]
}

interface ChatMetaPatchOptions {
  touchVisibleState?: boolean
  touchSummary?: boolean
  clearModelResolution?: boolean
}

export type ChatMetadataPatch = Partial<
  Pick<
    Chat,
    | 'title'
    | 'titleStatus'
    | 'lastViewedAt'
    | 'configurationVersion'
    | 'settings'
    | 'presetId'
    | 'modelResolution'
    | 'archived'
    | 'pinned'
    | 'color'
    | 'tags'
    | 'favoriteModels'
    | 'recentModels'
    | 'temporary'
  >
>

export interface PutMessageOptions {
  touchChatSummary?: boolean
  semanticEffect?: AppliedMessageSemanticEffect
  creationTimestamp?: 'preserve'
}

export type MessageBodyPatch = {
  [K in keyof MessageBodyFields]?: MessageBodyFields[K] | undefined
}

export type MessageHeaderPatch = {
  [K in keyof MessageHeaderRow]?: MessageHeaderRow[K] | undefined
}

export type MessageCalibrationPatch = Partial<
  Pick<
    Message,
    | 'originalCharCount'
    | 'originalTokenEstimate'
    | 'originalModelId'
    | 'originalCalibrationKey'
    | 'charCountDelta'
    | 'cachedTokenEstimate'
  >
> & { generation?: GenerationMeta }

export type MessageStructurePatch = Partial<
  Pick<MessageHeaderRow, 'deleted' | 'parentId' | 'siblingIndex'>
>

export interface PatchMessageBodyOptions extends PutMessageOptions {
  headerPatch?: MessageHeaderPatch
  // The patch is a full replacement for the message body fields. Used by
  // streaming flushes so appending text does not read, clone, and stringify
  // the previous full body on every chunk.
  replaceBody?: boolean
  replacementBaseline?: {
    readonly bodyVersion: number
    readonly body: MessageBodyFields
    readonly semanticEffect: AppliedMessageSemanticEffect
  }
}

export interface MutationContext {
  getChat(chatId: ChatId): Promise<Chat | undefined>
  getSetting<T = unknown>(key: string): Promise<T | undefined>
  patchChatMeta(chatId: ChatId, patch: ChatMetadataPatch, options?: ChatMetaPatchOptions): void
  getMessage(messageId: MessageId): Promise<Message | undefined>
  getMessageHeader(messageId: MessageId): Promise<MessageHeaderRow | undefined>
  getMessageHeaders(messageIds: readonly MessageId[]): Promise<Array<MessageHeaderRow | undefined>>
  listMessageHeaders(chatId: ChatId): Promise<MessageHeaderRow[]>
  listChildHeaders(chatId: ChatId, parentId: MessageId | null): Promise<MessageHeaderRow[]>
  putMessage(message: Message, options?: PutMessageOptions): Promise<Message>
  replaceMessageAttachmentRefs(
    messageId: MessageId,
    attachmentRefs: readonly MessageAttachmentRef[],
  ): Promise<MessageHeaderRow | undefined>
  patchMessageStructure(messageId: MessageId, patch: MessageStructurePatch): Promise<void>
  patchMessageBody(
    messageId: MessageId,
    patch: MessageBodyPatch,
    options?: PatchMessageBodyOptions,
  ): Promise<MessagePresentation | undefined>
  transitionMessageGenerationForDispatch(
    messageId: MessageId,
    generation: DispatchedGenerationMeta,
  ): Promise<MessageHeaderRow | undefined>
  getChildList(chatId: ChatId, parentId: MessageId | null): Promise<ChildListState>
  getChildLists(chatId: ChatId, parentIds: readonly (MessageId | null)[]): Promise<ChildListState[]>
  getChildSlotMembers(messageIds: readonly MessageId[]): Promise<Array<ChildSlotMember | undefined>>
  getAttachment(attachmentId: AttachmentId): Promise<Attachment | undefined>
  readonly getAttachmentCatalogRevision: () => Promise<number>
  findAttachmentIdByContentHash(
    filename: string,
    contentHash: string,
    excludeId?: AttachmentId,
  ): Promise<AttachmentId | undefined>
  writeAttachmentBundle(
    bundle: AttachmentBundle,
    mode: AttachmentBundleWriteMode,
  ): Promise<AttachmentBundleWriteResult>
  deleteAttachmentIfUnreferenced(
    attachmentId: AttachmentId,
  ): Promise<{ deleted: boolean; refs: { messages: number; drafts: number } }>
  deleteAttachmentForStorage(
    attachmentId: AttachmentId,
    reason: AttachmentMissingReason,
    now: number,
  ): Promise<'deleted' | 'stubbed' | 'absent'>
  reapAttachmentIfEligible(
    attachmentId: AttachmentId,
    cutoff: number,
  ): Promise<'deleted' | 'retained' | 'repair-required' | 'absent'>
  putAttachment(attachment: Attachment): Promise<void>
  deleteAttachment(attachmentId: AttachmentId): Promise<void>
  countAttachmentReferences(
    attachmentId: AttachmentId,
  ): Promise<{ messages: number; drafts: number; occurrences: number }>
  getAttachmentReferenceEdges(attachmentId: AttachmentId): Promise<AttachmentReferenceEdge[]>
  deleteAttachmentBytes(
    attachmentId: AttachmentId,
    reason: AttachmentMissingReason,
    now: number,
  ): Promise<Attachment | undefined>
  deleteAttachmentBlobs(attachmentId: AttachmentId): Promise<void>
  deleteAttachmentArtifacts(attachmentId: AttachmentId): Promise<void>
  deleteAttachmentJobs(attachmentId: AttachmentId): Promise<void>
  getAttachmentArtifacts(attachmentId: AttachmentId): Promise<AttachmentArtifact[]>
  getAttachmentJob(jobId: string): Promise<AttachmentJob | undefined>
  getAttachmentJobs(attachmentId: AttachmentId): Promise<AttachmentJob[]>
  putAttachmentBlob(blob: AttachmentBlob): Promise<void>
  putAttachmentArtifact(artifact: AttachmentArtifact): Promise<void>
  deleteAttachmentArtifact(artifactId: string): Promise<void>
  putAttachmentJob(job: AttachmentJob, options?: { affectsWire?: boolean }): Promise<void>
  deleteAttachmentJob(jobId: string): Promise<void>
  getDraft(chatId: ChatId): Promise<DraftRow | undefined>
  putDraft(
    draft: DraftRow,
    options?: { readonly validateAttachmentTargets?: boolean },
  ): Promise<void>
}

export interface MutationFinalizationContext extends MessageMutationFinalizationContext {
  readonly getAttachmentCatalogRevision: () => Promise<number>
  readFinalActiveBranchPathSlotFrame(
    chatId: ChatId,
    headers: readonly MessageHeaderRow[],
  ): Promise<ActiveBranchPathSlotFrame>
  sealExactConversationDestination(input: {
    readonly chat: Chat
    readonly target: ConversationSelectionProofTarget
    readonly tipId: MessageId | null
    readonly exactPathHeaders: readonly MessageHeaderRow[]
    readonly presentations?: readonly MessagePresentation[]
  }): Promise<ConversationProvedSelection>
}

export interface WorkspaceMutationResult<T> {
  value: T
  affectedChatIds: ChatId[]
  affectedMessageIds: MessageId[]
  chatVersions: Record<ChatId, ChatVersions>
  streamTargetLease?: StreamLeaseRow
}

export interface CreateFolderInput {
  id?: FolderId
  name: string
  color?: string
  sortIndex?: number
  now?: number
}

interface ChatOrganizationFacetChange {
  chatId: ChatId
  previousFolderId: FolderId | null
  nextFolderId: FolderId | null
  previousArchived: boolean
  nextArchived: boolean
}

export interface EnsureFolderAndMoveChatsInput extends CreateFolderInput {
  chatIds: readonly ChatId[]
}

export interface EnsureFolderAndMoveChatsResult {
  folder: ChatFolder
  created: boolean
  affectedChatIds: ChatId[]
  changes: ChatOrganizationFacetChange[]
}

export interface UpdateFolderInput {
  name?: string
  color?: string | null
  sortIndex?: number
  lastUsedAt?: number | null
  now?: number
}

export interface DeleteFolderResult {
  deleted: boolean
  affectedChatIds: ChatId[]
  changes: ChatOrganizationFacetChange[]
}

export interface ChatSidebarCatalogRequest {
  orderBy?: SidebarSortField
  direction?: 'asc' | 'desc'
  /** Keep the presentation's pinned bucket ahead of the selected field order. */
  pinnedFirst?: boolean
  createdAtGroupBoundaries?: readonly [
    today: number,
    yesterday: number,
    previous7Days: number,
    previous30Days: number,
  ]
  archived?: 'exclude' | 'include' | 'only'
  folderId?: FolderId | null
  includeFolderIds?: readonly FolderId[]
  excludeFolderIds?: readonly FolderId[]
  includeTagIds?: readonly TagId[]
  excludeTagIds?: readonly TagId[]
  excludeEmptyDrafts?: boolean
  limit?: number
  cursor?: string
  pageDirection?: 'forward' | 'backward'
  countMode?: 'exact' | 'omit'
}

export interface SidebarCreatedAtGroupCountRequest {
  readonly folderIds: readonly FolderId[]
  readonly boundaries: readonly [
    today: number,
    yesterday: number,
    previous7Days: number,
    previous30Days: number,
  ]
}

export interface ChatSidebarCatalogPage {
  rows: ChatSidebarRow[]
  previousCursor?: string
  nextCursor?: string
  exactCount?: number
}

export type SidebarPresentationRow =
  | {
      readonly kind: 'chat'
      readonly key: string
      readonly chat: ChatSidebarRow
      readonly depth: 'root' | 'folder'
    }
  | {
      readonly kind: 'folder'
      readonly key: string
      readonly folder: ChatFolder
      readonly exactChatCount: number
    }
  | {
      readonly kind: 'time-group'
      readonly key: string
      readonly label: string
      readonly depth: 'root' | 'folder'
    }
  | {
      readonly kind: 'folder-empty'
      readonly key: string
      readonly depth: 'folder'
    }

export interface SidebarPresentationRequest {
  readonly mode: 'expanded' | 'collapsed'
  readonly sort: SidebarSortMode
  readonly collapsedFolderIds: readonly FolderId[]
  readonly createdAtGroupBoundaries: readonly [number, number, number, number]
  readonly limit?: number
  readonly cursor?: string
  readonly countMode?: 'exact' | 'omit'
}

export interface SidebarPresentationMeasurement {
  readonly rootChatRowsRead: number
  readonly folderChildRowsRead: number
  readonly folderCatalogRowsRead: number
  readonly tagCatalogRowsRead: number
  readonly completionProbeQueries: number
  readonly completionProbeKeysRead: number
  readonly createdAtGroupProbeQueries: number
  readonly createdAtGroupProbeKeysRead: number
}

export interface SidebarPresentationPage {
  readonly rows: readonly SidebarPresentationRow[]
  readonly nextCursor?: string
  readonly exactTotalRows?: number
  readonly exactVisibleChats?: number
  readonly aggregate?: ChatSidebarAggregate
  readonly folders?: readonly ChatFolder[]
  readonly tags?: readonly ChatTag[]
  readonly measurement: SidebarPresentationMeasurement
}

export interface ChatTokenCalibrationProjection {
  chatId: ChatId
  tokenCalibration?: Readonly<Record<string, TokenCalibrationSample>>
}

export interface ChatSidebarAggregate {
  totalCount: number
  activeCount: number
  archivedCount: number
  pinnedCount: number
  visibleCount: number
  visiblePinnedCount: number
  folderCounts: Readonly<Record<string, number>>
  folderAggregates: Readonly<
    Record<
      string,
      {
        count: number
        activeCount: number
        visibleCount: number
        visiblePinnedCount: number
        sortExtrema: SidebarSortExtrema | null
      }
    >
  >
  rootCount: number
  rootVisibleCount: number
  rootVisiblePinnedCount: number
}

export interface ForkChatFromMessageInput {
  chatId: ChatId
  messageId: MessageId
  title: string
  destinationChatId?: ChatId
  now?: number
}

export interface ForkChatFromMessageResult {
  chatId: ChatId
  destination: ConversationProvedSelection
  messageCount: number
}

interface ActiveBranchPageStructureSnapshot {
  readonly chatId: ChatId
  readonly pageHeaders: readonly MessageHeaderRow[]
  readonly pageOffset: number
  readonly pageLimit: number
  readonly branchLength: number
}

interface ActiveBranchPageSnapshot extends ActiveBranchPageStructureSnapshot {
  readonly pageMessages: readonly Message[]
}

type KnownBranchStaleReason =
  | 'database-unavailable'
  | 'structural-version-mismatch'
  | 'empty-path'
  | 'duplicate-id'
  | 'chat-missing'
  | 'missing-header'
  | 'wrong-chat'
  | 'deleted-header'
  | 'non-root'
  | 'non-contiguous'
  | 'missing-body'
  | 'body-version-mismatch'

interface KnownBranchStalePathResult {
  kind: 'stale-path'
  chatId: ChatId
  reason: KnownBranchStaleReason
  messageId?: MessageId
}

export type KnownBranchPageStructuralResult =
  | {
      readonly kind: 'ready'
      readonly snapshot: ActiveBranchPageStructureSnapshot
    }
  | KnownBranchStalePathResult

export type KnownBranchPageResult =
  | {
      readonly kind: 'ready'
      readonly snapshot: ActiveBranchPageSnapshot
      readonly material: readonly MessagePresentation[]
    }
  | (KnownBranchStalePathResult & {
      readonly material: readonly MessagePresentation[]
    })

export function joinKnownBranchPageMaterial(
  structural: KnownBranchPageStructuralResult,
  rows: readonly (MessagePresentation | undefined)[],
): KnownBranchPageResult {
  const material = Object.freeze(
    rows.flatMap((presentation) => (presentation ? [presentation] : [])),
  )
  if (structural.kind !== 'ready') return Object.freeze({ ...structural, material })
  const { snapshot } = structural
  const pageMessages: Message[] = []
  for (let index = 0; index < snapshot.pageHeaders.length; index += 1) {
    const header = snapshot.pageHeaders[index] as MessageHeaderRow
    const presentation = rows[index]
    if (!presentation) {
      return Object.freeze({
        kind: 'stale-path',
        chatId: snapshot.chatId,
        reason: 'missing-body',
        messageId: header.id,
        material,
      })
    }
    if (
      presentation.bodyVersion !== header.bodyVersion ||
      presentation.message.id !== header.id ||
      presentation.message.chatId !== snapshot.chatId ||
      !sameMessageHeaderValue(presentation.header, header)
    ) {
      return Object.freeze({
        kind: 'stale-path',
        chatId: snapshot.chatId,
        reason: 'body-version-mismatch',
        messageId: header.id,
        material,
      })
    }
    pageMessages.push(rebaseHydratedMessageHeader(presentation.message, header))
  }
  if (rows.length !== snapshot.pageHeaders.length) {
    const messageId = snapshot.pageHeaders.at(-1)?.id
    return Object.freeze({
      kind: 'stale-path',
      chatId: snapshot.chatId,
      reason: 'body-version-mismatch',
      ...(messageId ? { messageId } : {}),
      material,
    })
  }
  return Object.freeze({
    kind: 'ready',
    snapshot: Object.freeze({ ...snapshot, pageMessages: Object.freeze(pageMessages) }),
    material,
  })
}

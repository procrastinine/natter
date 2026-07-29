import type { Table, Transaction } from 'dexie'
import type { AppliedMessageSemanticEffect } from '../core/continuation-content'
import type {
  Attachment,
  AttachmentArtifact,
  Chat,
  ChatId,
  ChatUsage,
  ChildListState,
  DispatchedGenerationMeta,
  DraftRow,
  GenerationMeta,
  GlobalTokenCalibration,
  Message,
  MessageId,
  MutationScope,
} from '../core/types'
import type { AttachmentHeaderRow } from './attachment-storage'
import type {
  BrowserMutationTableName,
  BrowserMutationTransactionAccess,
} from './browser-mutation-plan'
import type { MessageBodyRow, MessageHeaderRow } from './message-storage'
import type {
  FencedTransaction,
  PhysicalStorageTableName,
  PhysicalTransactionPlan,
} from './physical-storage-tables'
import type {
  ChatMetadataPatch,
  FencedStreamLeaseRow,
  GenerationMessageReadProof,
  MessageBodyPatch,
  MessageCalibrationPatch,
  MessageHeaderPatch,
  MutationContext,
  MutationFinalizationContext,
  StreamLeaseAdmission,
  StreamLeaseRow,
  StreamPostCommitEvidence,
  StreamPostCommitUsageEvidence,
  StreamWriteFence,
  WorkspaceMutationOptions,
  WorkspaceMutationResult,
} from './repository'
import type {
  SemanticOperationDescriptor,
  SemanticOperationExactPhysicalRead,
  SemanticOperationKind,
  SemanticOperationReplayPlan,
  SemanticOperationRunner,
} from './semantic-operation-capability'
import type {
  GenerationPlanningSnapshot,
  GenerationPromptPathProof,
  MessagePresentation,
  PrepareAttemptConfigurationIntent,
  PreparedAttachmentBundle,
  PreparedGenerationPrompt,
  StorageMaintenanceRequestTaskKind,
  WorkspaceCommand,
} from './workspace-protocol'

export const VALIDATED_GENERATION_PROMPT_PATH_HEADERS = Symbol(
  'validated-generation-prompt-path-headers',
)

export type ValidatedGenerationPromptPathHeaders = readonly MessageHeaderRow[] & {
  readonly [VALIDATED_GENERATION_PROMPT_PATH_HEADERS]: true
}

export interface ValidatedGenerationPromptPath {
  readonly headers: ValidatedGenerationPromptPathHeaders
  readonly messageProofs: readonly GenerationMessageReadProof[]
}

export interface ResolvedGenerationPromptPath extends ValidatedGenerationPromptPath {
  readonly leafId: MessageId | null
  readonly targetHeader?: MessageHeaderRow
  readonly slot?: ChildListState
}

export interface ChatMutationState {
  beforeChat: Chat
  structuralSummaryDirty: boolean
  structuralVersionDirty: boolean
  previousBranchIds?: ReadonlySet<MessageId>
  headersBeforeWrites: Map<MessageId, MessageHeaderRow | undefined>
  incrementalAppends: Message[]
  wordCountDeltas: Map<MessageId, number>
  totalCostDelta: number
  visibleMetaPatch: Partial<Chat>
  hiddenMetaPatch: Partial<Chat>
  clearModelResolution: boolean
  visibleMetaDirty: boolean
  summaryVersionDirty: boolean
  messageSummaryDirty: boolean
  branchCorpusDirtyMessageIds: Set<MessageId>
  previewDirty: boolean
  changedMessageIds: Set<MessageId>
}

export interface BrowserMutationOperations {
  getOwnedStreamLease(streamId: string): StreamLeaseRow
  resolveGenerationPromptPath(
    chatId: ChatId,
    proof: GenerationPromptPathProof,
  ): Promise<ValidatedGenerationPromptPath>
  captureGenerationPlanningSnapshot(
    chatId: ChatId,
    intent: PrepareAttemptConfigurationIntent,
    planningChat: Chat,
  ): Promise<GenerationPlanningSnapshot>
  setStreamAdmissionPostCommit(postCommit: StreamPostCommitEvidence): void
  requestStorageMaintenance(task: StorageMaintenanceRequestTaskKind): void
}

export interface BrowserMutationTransactionExtension<Value, Result> {
  readonly access: BrowserMutationTransactionAccess
  readonly receipt?: {
    readonly exactOccurrence: true
    readonly replay: SemanticOperationReplayPlan
  }
  commit(tx: FencedTransaction<BrowserMutationTableName>, value: Value): Promise<Result> | Result
}

export interface BrowserMutationSharedInternals {
  applyMessageBodyPatch(this: void, body: MessageBodyRow, patch: MessageBodyPatch): MessageBodyRow
  applyMessageHeaderPatch(
    this: void,
    header: MessageHeaderRow,
    patch: MessageHeaderPatch | undefined,
  ): MessageHeaderRow
  assertExistingMessageIdentity(this: void, existing: MessageHeaderRow, candidate: Message): void
  assertOwnedStreamFence(
    this: void,
    lease: StreamLeaseRow | undefined,
    fence: StreamWriteFence,
    replacementEpoch: number,
    streamId: string,
  ): asserts lease is FencedStreamLeaseRow
  assertStreamLeaseWorkspaceTarget(
    this: void,
    tx: Transaction,
    lease: Pick<StreamLeaseRow, 'streamId' | 'chatId' | 'messageId' | 'attemptKind'>,
    chat: Chat | undefined,
  ): Promise<void>
  branchHeaderWordCount(this: void, headers: readonly MessageHeaderRow[]): number
  calibrationUsageFromPostCommit(this: void, usage: StreamPostCommitUsageEvidence): ChatUsage
  canApplyIncrementalBranchAppend(this: void, state: ChatMutationState): boolean
  changedPatch<Row extends object>(
    this: void,
    current: Partial<Row>,
    patch: Partial<Row>,
  ): Partial<Row> | null
  chatConfigurationTargetResourceNames(this: void, chat: Chat): string[]
  chatPreviewInTransaction(this: void, tx: Transaction, chatId: ChatId): Promise<string>
  cloneDraft(this: void, draft: DraftRow): DraftRow
  cloneMessage(this: void, message: Message): Message
  cloneMessageHeader(this: void, message: MessageHeaderRow): MessageHeaderRow
  hydrateStoredAttachment(
    this: void,
    header: AttachmentHeaderRow,
    artifacts: Table<AttachmentArtifact, string>,
  ): Promise<Attachment>
  hydrateStoredMessage(this: void, header: MessageHeaderRow, body: MessageBodyRow): Message
  listChildHeaderRows(
    this: void,
    table: Table<MessageHeaderRow, MessageId>,
    chatId: ChatId,
    parentId: MessageId | null,
  ): Promise<MessageHeaderRow[]>
  loadChatOrThrow(this: void, table: Table<Chat, string>, chatId: ChatId): Promise<Chat>
  materializeChatMutationState(this: void, state: ChatMutationState): Chat
  messageCost(this: void, message: Pick<Message, 'deleted' | 'generation'>): number
  messageOutranksLeaf(
    this: void,
    message: Pick<Message, 'createdAt' | 'id'>,
    leaf: Pick<MessageHeaderRow, 'createdAt' | 'id'>,
  ): boolean
  messageSemanticEffect(
    this: void,
    existingHeader: MessageHeaderRow,
    existingBody: MessageBodyRow | undefined,
    nextHeader: MessageHeaderRow,
    nextBody: MessageBodyRow,
    appliedBodyEffect?: AppliedMessageSemanticEffect,
  ): AppliedMessageSemanticEffect
  newestLiveLeafIdInTransaction(
    this: void,
    tx: Transaction,
    chatId: ChatId,
  ): Promise<MessageId | null>
  nextBranchUpdatedAt(this: void, current: number, now: number): number
  nextStreamLeaseRevision(this: void, lease: Pick<StreamLeaseRow, 'revision'>): number
  readBranchPathInTransaction(
    this: void,
    tx: Transaction,
    chatId: ChatId,
    leafId: MessageId | null,
    signal?: AbortSignal,
  ): Promise<MessageHeaderRow[]>
  recordMessageHeaderSummaryDeltas(
    this: void,
    state: ChatMutationState | undefined,
    messageId: MessageId,
    before: MessageHeaderRow,
    after: MessageHeaderRow,
  ): boolean
  recordMessageSummaryDeltas(
    this: void,
    state: ChatMutationState | undefined,
    messageId: MessageId,
    before: Message,
    after: Message,
  ): boolean
  replacementMessageBody(
    this: void,
    header: MessageHeaderRow,
    patch: MessageBodyPatch,
    options: { bodyVersion: number; updatedAt: number },
  ): MessageBodyRow
  requireChatMetadataPatch(this: void, patch: ChatMetadataPatch): ChatMetadataPatch
  requiredStreamPostCommitEvidence(this: void, lease: StreamLeaseRow): StreamPostCommitEvidence
  reserveStreamLeaseTarget(
    this: void,
    tx: FencedTransaction<'settings' | 'streamLeases'>,
    incoming: StreamLeaseAdmission,
  ): Promise<number>
  shouldBumpLastBranchUpdatedAtFromHeaders(
    this: void,
    beforeChat: Chat,
    nextLeafId: MessageId | null,
    branchHeaders: readonly MessageHeaderRow[],
    changedMessageIds: ReadonlySet<MessageId>,
  ): boolean
  shouldBumpStructuralLastBranchUpdatedAt(
    this: void,
    beforeChat: Chat,
    previousBranchIds: ReadonlySet<MessageId>,
    nextLeafId: MessageId | null,
    nextBranchHeaders: readonly MessageHeaderRow[],
    changedMessageIds: ReadonlySet<MessageId>,
  ): boolean
  stableStringify(this: void, value: unknown): string
  streamOwnedMessageFieldsChanged(
    this: void,
    existingHeader: MessageHeaderRow,
    existingBody: MessageBodyRow,
    nextHeader: MessageHeaderRow,
    nextBody: MessageBodyRow,
  ): boolean
  transitionMessageGenerationForDispatch(
    this: void,
    header: MessageHeaderRow,
    generation: DispatchedGenerationMeta,
  ): MessageHeaderRow
  resolveGenerationPromptPath(
    this: void,
    tx: Transaction,
    chatId: ChatId,
    proof: GenerationPromptPathProof,
  ): Promise<ValidatedGenerationPromptPath>
}

export interface BrowserMutationRunnerPort {
  runMutation<T, U = T, ExtensionResult = undefined>(
    scopes: MutationScope[],
    fn: (ctx: MutationContext, operations: BrowserMutationOperations) => Promise<T> | T,
    options: WorkspaceMutationOptions | undefined,
    commandCommit: BrowserMutationCommandPort,
    finalize?: (ctx: MutationFinalizationContext, value: T) => Promise<U> | U,
    transactionExtension?: BrowserMutationTransactionExtension<T, ExtensionResult>,
  ): Promise<WorkspaceMutationResult<U> & { readonly transactionExtensionResult: ExtensionResult }>
}

export interface BrowserMutationCommandPort extends BrowserCommandSessionPort {
  readonly command: WorkspaceCommand
  readonly operationKind: WorkspaceCommand['kind']
  assertReplacementEpoch(expectedReplacementEpoch: number): void
}

export type BrowserGenerationCommandPort = BrowserMutationRunnerPort

export interface BrowserGenerationCommandSupport {
  appendValidatedGenerationPromptPath(
    this: void,
    path: ValidatedGenerationPromptPath,
    header: MessageHeaderRow,
  ): ValidatedGenerationPromptPath
  applyMessageCalibrationPatch(
    this: void,
    header: MessageHeaderRow,
    patch: MessageCalibrationPatch,
  ): MessageHeaderRow
  assertNewChatAttemptRow(this: void, chat: Chat, chatId: ChatId): void
  assertPreparedAttemptMessage(
    this: void,
    message: Message,
    lease: StreamLeaseAdmission,
    role: 'assistant',
    origin: 'generated',
  ): asserts message is Message & { generation: GenerationMeta }
  assertPreparedAttemptMessage(
    this: void,
    message: Message,
    lease: StreamLeaseAdmission,
    role: 'user',
    origin: 'user',
  ): void
  calibrationUsageFromPostCommit(this: void, usage: StreamPostCommitUsageEvidence): ChatUsage
  chatTokenCalibrationGeneration(this: void, chat: Pick<Chat, 'tokenCalibrationGeneration'>): number
  cloneMessageHeader(this: void, message: MessageHeaderRow): MessageHeaderRow
  continuationGlobalCalibration(this: void, value: unknown): GlobalTokenCalibration | undefined
  dedupeMutationScopes(this: void, scopes: readonly MutationScope[]): MutationScope[]
  monotonicTimestamp(this: void, current: number | undefined, next: number): number
  persistPreparedAttachmentBundleInMutation(
    this: void,
    ctx: MutationContext,
    bundle: PreparedAttachmentBundle,
    current?: Attachment,
  ): Promise<void>
  preparedAttachmentIdentityMatches(this: void, current: Attachment, prepared: Attachment): boolean
  preparedGenerationPrompt(
    this: void,
    leafId: MessageId | null,
    canonicalHeaders: ValidatedGenerationPromptPathHeaders,
    messageProofs: readonly GenerationMessageReadProof[],
    knownPresentations: readonly [] | readonly [MessagePresentation],
  ): PreparedGenerationPrompt
  requiredPromptPathTarget(
    this: void,
    path: ResolvedGenerationPromptPath,
    chatId: ChatId,
  ): MessageHeaderRow
  resolveGenerationPromptPathProof(
    this: void,
    ctx: MutationContext,
    chatId: ChatId,
    proof: GenerationPromptPathProof,
    path: ValidatedGenerationPromptPath,
  ): Promise<ResolvedGenerationPromptPath>
  stableStringify(this: void, value: unknown): string
  streamFenceMatches(
    this: void,
    lease: StreamLeaseRow | undefined,
    fence: StreamWriteFence,
    replacementEpoch: number,
  ): lease is FencedStreamLeaseRow
}

export interface BrowserLockedCommandPort {
  runTransaction<Tables extends PhysicalStorageTableName, T>(
    plan: PhysicalTransactionPlan<Tables>,
    operation: (tx: FencedTransaction<Tables>) => Promise<T> | T,
  ): Promise<T>
}

export interface BrowserSemanticCommandPort<Kind extends SemanticOperationKind> {
  executeSemanticOperation<Tables extends PhysicalStorageTableName, ResourceInput, Receipt, T>(
    descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
    resourceInput: ResourceInput,
    operation: SemanticOperationRunner<Tables, T, Receipt>,
  ): Promise<T>
  completeSemanticOperation<Tables extends PhysicalStorageTableName, ResourceInput, Receipt, T>(
    descriptor: SemanticOperationDescriptor<Kind, Tables, ResourceInput, Receipt>,
    resourceInput: ResourceInput,
    value: T,
    receipt: Receipt,
  ): Promise<T>
}

export interface BrowserCommandSessionPort
  extends BrowserSemanticCommandPort<SemanticOperationKind> {
  readSemanticOperationPreflight<Tables extends PhysicalStorageTableName, T>(
    plan: PhysicalTransactionPlan<Tables>,
    operation: (tx: FencedTransaction<Tables>) => Promise<T> | T,
    exactPhysicalReads?: (
      value: T,
    ) => readonly (SemanticOperationExactPhysicalRead & { readonly tableName: Tables })[],
  ): Promise<T>
  withLocks<T>(
    resourceNames: readonly string[],
    operation: (locked: BrowserLockedCommandPort) => Promise<T> | T,
  ): Promise<T>
}

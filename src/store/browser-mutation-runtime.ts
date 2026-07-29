import type { Transaction } from 'dexie'
import { normalizeModelsResponse } from '../api/providers'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../core/cache-keys'
import { connectionDispatchKeyRefs } from '../core/connection-dispatch-proof'
import { assertCanonicalGeneratedOutputMessage } from '../core/generated-output-localization'
import {
  CORS_PROXY_SECRET_KEY,
  CORS_PROXY_URL_KEY,
  generationCorsProxyConfigFromStored,
  TOKEN_CALIBRATION_MODE_KEY,
  tokenCalibrationModeFromStored,
} from '../core/global-settings'
import { messageTreeIndexFields } from '../core/message-tree-index'
import { fixedConversationSelectionTarget } from '../core/messages'
import { tokenCalibrationKey } from '../core/model-ids'
import { pickEquivalentModelId } from '../core/model-selection'
import {
  isStaticTextTemplateId,
  normalizeTextTemplateConfig,
  type SavedTextTemplate,
} from '../core/text-templates'
import {
  deriveCompletionSample,
  GLOBAL_TOKEN_CALIBRATION_KEY,
  messageTextCharCount,
  relevantGlobalTokenCalibration,
} from '../core/token-calibration'
import type {
  Attachment,
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  AttachmentMissingReason,
  AttachmentReferenceEdge,
  Chat,
  ChatId,
  ChatVersions,
  ChildListState,
  ChildSlotMember,
  ConnectionProfile,
  DraftRow,
  KeyId,
  KeyRecord,
  MessageAttachmentRef,
  MessageId,
  MutationScope,
  ProfileId,
} from '../core/types'
import { sameOrderedValues } from '../lib/same-value'
import { readActiveBranchPathSlotFrameInTransaction } from './active-branch-fork-storage'
import {
  ATTACHMENT_CATALOG_AGGREGATE_ID,
  type AttachmentCatalogAggregateRow,
  type AttachmentCatalogProjectionRow,
  deleteAttachmentCatalogProjection,
  putAttachmentCatalogProjectionFromHeader,
} from './attachment-catalog-projection'
import { markAttachmentIntegrityRepairPending } from './attachment-integrity-maintenance'
import {
  applyAttachmentReferenceOwnerTransitions,
  attachmentReferenceCounts,
  edgesForOwner,
  requireNoAttachmentReferences,
} from './attachment-reference-edges'
import {
  type AttachmentHeaderRow,
  hydrateAttachment,
  splitAttachmentForStorage,
} from './attachment-storage'
import {
  type BrowserCommandMessageRevisionFact,
  recordBrowserCommandAttachmentIntegrityRepairRequest,
  recordBrowserCommandAttachmentReferenceState,
  recordBrowserCommandInvalidation,
  recordBrowserCommandMessageRevisions,
} from './browser-command-mutation-journal'
import type {
  BrowserMutationCommandPort,
  BrowserMutationOperations,
  BrowserMutationSharedInternals,
  BrowserMutationTransactionExtension,
  ChatMutationState,
} from './browser-domain-mutations'
import {
  type BrowserMutationTableName,
  planMutationSemanticOperation,
  validateGenerationReadSetTransaction,
} from './browser-mutation-plan'
import {
  addPhysicalStorageRow,
  deleteAttachmentArtifactByteOwner,
  deleteAttachmentArtifactRows,
  deleteAttachmentBlobRows,
  deleteAttachmentByteOwnerBundle,
  deleteAttachmentHeaderByteOwner,
  deleteAttachmentJobByteOwner,
  deleteAttachmentJobRows,
  deletePhysicalStorageRows,
  insertMessageBody,
  putAttachmentArtifactByteOwner,
  putAttachmentBlobByteOwner,
  putAttachmentHeaderByteOwner,
  putAttachmentJobByteOwner,
  putDraftByteOwner,
  putPhysicalStorageRow,
  putPhysicalStorageRows,
  replaceAttachmentByteOwnerBundle,
  replaceMessageBody,
} from './byte-owner-mutation'
import { openLinkedChatMutation } from './chat-row-transition'
import { maintainChildSlotProjections } from './child-list-projection'
import { configurationRequestRevisionFor } from './configuration-domain-contract'
import { proveConversationSelectionInTransaction } from './conversation-destination-seal'
import { childListKey } from './db'
import type { SettingsRow } from './db-rows'
import { readDiscoveryCacheRow } from './discovery-cache-storage'
import { generationAdmissionDecision } from './generation-admission'
import {
  compileCurrentMessageTransition,
  compileCurrentMessageUpdateCandidate,
  finalizeCurrentMessageUpdateTransition,
  type MessageBodyRow,
  type MessageHeaderRow,
  type MessageTextPreviewRow,
  projectMessageTextPreview,
  syncMessageHeaderProjections,
  transitionMessageAttachmentRefs,
} from './message-storage'
import type {
  AttachmentBundle,
  AttachmentBundleWriteMode,
  AttachmentBundleWriteResult,
  MessageStructurePatch,
  MutationContext,
  MutationFinalizationContext,
  PatchMessageBodyOptions,
  PutMessageOptions,
  StreamLeaseRow,
  StreamPostCommitEvidence,
  WorkspaceMutationOptions,
  WorkspaceMutationResult,
} from './repository'
import {
  ChatMissingError,
  NoEligibleProvidersError,
  requireStreamLeaseRow,
  requireWriterActiveStreamLeaseRow,
  requireWriterReservedStreamLeaseRow,
  StreamTargetBusyError,
  streamLeaseHasCommittedTarget,
  streamPostCommitUsageEvidence,
} from './repository'
import {
  absorbSemanticOperationReceiptFragment,
  boundSemanticOperationExactReceiptAccumulator,
  semanticOperationExactReceipt,
  semanticOperationExecution,
} from './semantic-operation-capability'
import { putStreamLeaseByteOwner } from './stream-journal-storage'
import {
  nextChatUpdatedAtInTransaction,
  TransactionMessageCreationClock,
} from './transaction-order'
import type {
  GenerationPlanningSnapshot,
  PrepareAttemptConfigurationIntent,
} from './workspace-protocol'
import { connectionDiscoveryRevisionKey } from './workspace-protocol'

function chatTokenCalibrationGeneration(chat: Pick<Chat, 'tokenCalibrationGeneration'>): number {
  const generation = chat.tokenCalibrationGeneration
  return typeof generation === 'number' && Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : 0
}

async function captureGenerationPlanningSnapshot(
  tx: Transaction,
  chatId: ChatId,
  intent: PrepareAttemptConfigurationIntent,
  planningChat: Chat,
): Promise<GenerationPlanningSnapshot> {
  const profile = await tx
    .table<ConnectionProfile, ProfileId>('profiles')
    .get(planningChat.settings.profileId)
  if (!profile) {
    throw new Error(`GenerationPlanningProfileMissing:${planningChat.settings.profileId}`)
  }
  const keyRefs = connectionDispatchKeyRefs(profile)
  const keyRecords = await tx.table<KeyRecord, KeyId>('keys').bulkGet(keyRefs)
  const preferredDispatchKeyId =
    intent.preferredDispatchKeyId !== null && keyRefs.includes(intent.preferredDispatchKeyId)
      ? intent.preferredDispatchKeyId
      : null
  const modelId = planningChat.settings.model
  if (!modelId) throw new Error(`GenerationPlanningModelMissing:${chatId}`)
  const discoveryRevision = configurationRequestRevisionFor(
    profile,
    profile.apiKeyRef ? keyRecords.find((record) => record?.id === profile.apiKeyRef) : undefined,
  )
  const discoveryRevisionKey = connectionDiscoveryRevisionKey(discoveryRevision)
  const [modelsRow, endpointsRow, privacyRow] = await Promise.all([
    profile.kind === 'openrouter'
      ? Promise.resolve(undefined)
      : readDiscoveryCacheRow(tx, 'models', [
          profile.id,
          modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind)),
        ]),
    profile.kind === 'openrouter'
      ? readDiscoveryCacheRow(tx, 'endpoints', [profile.id, modelId])
      : Promise.resolve(undefined),
    profile.kind === 'openrouter'
      ? readDiscoveryCacheRow(tx, 'privacyPolicies', [profile.id, modelId])
      : Promise.resolve(undefined),
  ])
  const modelsQueryKey = modelsCacheKey(modelCatalogQueryForConnectionKind(profile.kind))
  const modelRows =
    modelsRow?.profileRevision === discoveryRevisionKey
      ? normalizeModelsResponse(modelsRow.payload)
      : null
  const equivalentModelId = modelRows ? pickEquivalentModelId(modelId, modelRows) : null
  const selectedModelRow = equivalentModelId
    ? modelRows?.find((row) => row.id === equivalentModelId)
    : undefined
  const discovery: GenerationPlanningSnapshot['discovery'] = {
    revision: discoveryRevision,
    models:
      modelRows !== null
        ? {
            queryKey: modelsQueryKey,
            rows: selectedModelRow ? [structuredClone(selectedModelRow)] : [],
          }
        : null,
    endpoints:
      endpointsRow?.profileRevision === discoveryRevisionKey ? structuredClone(endpointsRow) : null,
    privacy:
      privacyRow?.profileRevision === discoveryRevisionKey ? structuredClone(privacyRow) : null,
  }
  const settingKeys = [
    GLOBAL_TOKEN_CALIBRATION_KEY,
    TOKEN_CALIBRATION_MODE_KEY,
    CORS_PROXY_URL_KEY,
    CORS_PROXY_SECRET_KEY,
  ]
  const settingRows = await tx.table<SettingsRow, string>('settings').bulkGet(settingKeys)
  const settingsByKey = new Map(
    settingKeys.map((key, index) => [key, settingRows[index]?.value] as const),
  )
  const globalCalibration = relevantGlobalTokenCalibration(
    settingsByKey.get(GLOBAL_TOKEN_CALIBRATION_KEY),
    modelId,
  )
  const tokenCalibrationMode = tokenCalibrationModeFromStored(
    settingsByKey.get(TOKEN_CALIBRATION_MODE_KEY),
  )
  const proxy = generationCorsProxyConfigFromStored(settingsByKey)
  const calibrationKey = tokenCalibrationKey(modelId)
  const admissionDecision = generationAdmissionDecision({
    chat: planningChat,
    profile,
    proxy,
    discovery,
  })
  if (admissionDecision === 'zero-eligible') {
    throw new NoEligibleProvidersError()
  }
  const textTemplateId = planningChat.settings.textTemplate
  const savedTextTemplate =
    textTemplateId && !isStaticTextTemplateId(textTemplateId)
      ? await tx.table<SavedTextTemplate, string>('textTemplates').get(textTemplateId)
      : undefined
  if (textTemplateId && !isStaticTextTemplateId(textTemplateId) && !savedTextTemplate) {
    throw new Error(`GenerationPlanningTemplateMissing:${textTemplateId}`)
  }
  return {
    chat: structuredClone(planningChat),
    profile: structuredClone(profile),
    keyRecords: keyRecords.map((record) => (record ? structuredClone(record) : undefined)),
    preferredDispatchKeyId,
    discovery,
    calibration: {
      modelId,
      calibrationKey,
      mode: tokenCalibrationMode,
      chatGeneration: chatTokenCalibrationGeneration(planningChat),
      global: structuredClone(globalCalibration),
    },
    proxy: structuredClone(proxy),
    ...(savedTextTemplate
      ? {
          savedTextTemplate: {
            templateId: savedTextTemplate.id,
            config: normalizeTextTemplateConfig(savedTextTemplate.config),
          },
        }
      : {}),
  }
}

function missingAttachmentAfterByteDeletion(
  attachment: Attachment,
  reason: AttachmentMissingReason,
  now: number,
  artifacts: readonly AttachmentArtifact[],
  processing: Attachment['processing'],
): Attachment {
  const lastKnownBlobId =
    attachment.storage.kind === 'local-blob'
      ? attachment.storage.blobId
      : attachment.storage.kind === 'missing'
        ? attachment.storage.lastKnownBlobId
        : undefined
  const next: Attachment = {
    ...attachment,
    updatedAt: now,
    storage: {
      kind: 'missing',
      reason,
      missingSince: now,
      ...(lastKnownBlobId ? { lastKnownBlobId } : {}),
    },
    artifacts: [...artifacts],
    processing,
  }
  delete next.thumbnailBlobId
  return next
}

export async function runBrowserMutation<T, U = T, ExtensionResult = undefined>(
  scopes: MutationScope[],
  fn: (ctx: MutationContext, operations: BrowserMutationOperations) => Promise<T> | T,
  options: WorkspaceMutationOptions | undefined,
  commandCommit: BrowserMutationCommandPort,
  shared: BrowserMutationSharedInternals,
  finalize?: (ctx: MutationFinalizationContext, value: T) => Promise<U> | U,
  transactionExtension?: BrowserMutationTransactionExtension<T, ExtensionResult>,
): Promise<WorkspaceMutationResult<U> & { readonly transactionExtensionResult: ExtensionResult }> {
  const assertOwnedStreamFence: BrowserMutationSharedInternals['assertOwnedStreamFence'] =
    shared.assertOwnedStreamFence
  const {
    applyMessageBodyPatch,
    applyMessageHeaderPatch,
    assertExistingMessageIdentity,
    assertStreamLeaseWorkspaceTarget,
    branchHeaderWordCount,
    calibrationUsageFromPostCommit,
    canApplyIncrementalBranchAppend,
    changedPatch,
    chatPreviewInTransaction,
    cloneDraft,
    cloneMessage,
    cloneMessageHeader,
    hydrateStoredAttachment,
    hydrateStoredMessage,
    listChildHeaderRows,
    materializeChatMutationState,
    messageCost,
    messageOutranksLeaf,
    messageSemanticEffect,
    newestLiveLeafIdInTransaction,
    nextBranchUpdatedAt,
    nextStreamLeaseRevision,
    readBranchPathInTransaction,
    recordMessageHeaderSummaryDeltas,
    recordMessageSummaryDeltas,
    replacementMessageBody,
    requireChatMetadataPatch,
    requiredStreamPostCommitEvidence,
    reserveStreamLeaseTarget,
    shouldBumpLastBranchUpdatedAtFromHeaders,
    shouldBumpStructuralLastBranchUpdatedAt,
    stableStringify,
    streamOwnedMessageFieldsChanged,
    transitionMessageGenerationForDispatch,
    resolveGenerationPromptPath,
  } = shared
  const streamAdmission = options?.streamAdmission

  let committedTargetLease: StreamLeaseRow | undefined
  let admittedTargetLease: StreamLeaseRow | undefined
  let admissionExistingLease: StreamLeaseRow | undefined
  let admissionSequence: number | undefined
  let admissionPostCommit: StreamPostCommitEvidence | undefined
  const operationPlan = planMutationSemanticOperation(
    commandCommit.command,
    scopes,
    options,
    transactionExtension?.access,
    transactionExtension?.receipt,
  )
  if (options?.streamTargetCommit && !options.streamFence) {
    throw new Error(`StreamTargetCommitFenceMissing:${options.streamTargetCommit.streamId}`)
  }
  if (
    options?.streamTargetCommit &&
    options.streamFence?.streamId !== options.streamTargetCommit.streamId
  ) {
    throw new Error(`StreamTargetCommitFenceMismatch:${options.streamTargetCommit.streamId}`)
  }
  if (
    options?.streamCanonicalCommit &&
    options.streamFence?.streamId !== options.streamCanonicalCommit.streamId
  ) {
    throw new Error(`StreamCanonicalCommitFenceMismatch:${options.streamCanonicalCommit.streamId}`)
  }
  if (options?.allowMissingCanonicalChatId && !options.streamCanonicalCommit) {
    throw new Error('MissingCanonicalChatAllowanceWithoutCommit')
  }
  if (options?.workspaceFence) {
    commandCommit.assertReplacementEpoch(options.workspaceFence.replacementEpoch)
  }
  const result: WorkspaceMutationResult<U> & {
    readonly transactionExtensionResult: ExtensionResult
  } = await commandCommit.executeSemanticOperation(
    operationPlan.descriptor,
    undefined,
    async (transaction) => {
      const receiptAccumulator =
        boundSemanticOperationExactReceiptAccumulator<BrowserMutationTableName>(transaction)
      if (!receiptAccumulator) {
        throw new Error('BrowserMutationExactReceiptAccumulatorMissing')
      }
      const now = Date.now()
      const tx = transaction
      if (options?.expectedAttachmentCatalogRevision !== undefined) {
        const expected = options.expectedAttachmentCatalogRevision
        if (!Number.isSafeInteger(expected) || expected < 0) {
          throw new Error('AttachmentCatalogRevisionInvalid')
        }
        const aggregate = await tx
          .table<AttachmentCatalogAggregateRow, string>('attachmentCatalogAggregate')
          .get(ATTACHMENT_CATALOG_AGGREGATE_ID)
        receiptAccumulator.physicalRead({
          tableName: 'attachmentCatalogAggregate',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        })
        if (!aggregate) throw new Error('AttachmentCatalogAggregateMissing')
        if (aggregate.projectionRevision !== expected) {
          throw new Error(
            `AttachmentCatalogRevisionChanged:${expected}:${aggregate.projectionRevision}`,
          )
        }
      }
      if (options?.requiredProfileId) {
        const current = await tx
          .table<ConnectionProfile, ProfileId>('profiles')
          .get(options.requiredProfileId)
        if (!current) throw new Error(`RequiredProfileMissing:${options.requiredProfileId}`)
      }
      if (operationPlan.generationReadSet) {
        const reads = await validateGenerationReadSetTransaction(
          tx,
          operationPlan.generationReadSet,
        )
        for (const read of reads) receiptAccumulator.physicalRead(read)
      }
      let ownedStreamLease: StreamLeaseRow | undefined
      const chatMutation = openLinkedChatMutation(tx)
      if (options?.initialChat) {
        const initialChat = structuredClone(options.initialChat)
        const initialRead = await chatMutation.readWithEvidence(initialChat.id)
        const existing = initialRead.chat
        if (commandCommit.command.kind === 'chat.materialize-temporary') {
          receiptAccumulator.physicalRead({
            tableName: 'chats',
            indexKind: 'primary',
            operation: 'get',
            requestCount: initialRead.requestCount,
            rowCount: 1,
          })
        }
        if (existing) {
          throw new Error(`AttemptInitialChatAlreadyExists:${initialChat.id}`)
        }
        await chatMutation.add(initialChat)
      }
      if (options?.streamAdmission) {
        const incoming = options.streamAdmission
        const table = tx.table<StreamLeaseRow, string>('streamLeases')
        const existing = await table.get(incoming.streamId)
        commandCommit.assertReplacementEpoch(incoming.replacementEpoch)
        await assertStreamLeaseWorkspaceTarget(
          tx,
          incoming,
          await chatMutation.read(incoming.chatId),
        )
        if (existing && existing.chatId !== incoming.chatId) {
          throw new Error(`StreamLeaseChatMismatch:${incoming.streamId}`)
        }
        if (
          existing &&
          (existing.messageId !== incoming.messageId ||
            existing.attemptKind !== incoming.attemptKind)
        ) {
          throw new Error(`StreamLeaseIdentityMismatch:${incoming.streamId}`)
        }
        if (
          existing &&
          (existing.custody !== 'writer' ||
            existing.ownerClientId !== incoming.ownerClientId ||
            existing.fenceToken !== incoming.fenceToken)
        ) {
          throw new Error(`StreamLeaseAlreadyOwned:${incoming.streamId}`)
        }
        admissionSequence = existing
          ? existing.admissionSequence
          : await reserveStreamLeaseTarget(tx, incoming)
        admissionExistingLease = existing
      }
      if (options?.streamFence) {
        const { streamId, fence } = options.streamFence
        commandCommit.assertReplacementEpoch(fence.replacementEpoch)
        const lease = await tx.table<StreamLeaseRow, string>('streamLeases').get(streamId)
        receiptAccumulator.physicalRead({
          tableName: 'streamLeases',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: lease ? 1 : 0,
        })
        assertOwnedStreamFence(lease, fence, fence.replacementEpoch, streamId)
        if (options.streamTargetCommit && lease.stopControl) {
          throw new Error(`AttemptDispatchStopped:${streamId}`)
        }
        ownedStreamLease = lease
        if (
          options.allowMissingCanonicalChatId &&
          lease.chatId !== options.allowMissingCanonicalChatId
        ) {
          throw new Error(`MissingCanonicalChatAllowanceMismatch:${lease.streamId}`)
        }
        if (
          !options.streamTargetCommit &&
          !options.streamCanonicalCommit &&
          !streamLeaseHasCommittedTarget(lease)
        ) {
          throw new Error(`StreamTargetNotCommitted:${streamId}`)
        }
      }
      const { assertScope } = operationPlan
      const chatStates = new Map<ChatId, ChatMutationState>()
      const absentChatIds = new Set<ChatId>()
      const draftReads = new Map<ChatId, DraftRow | undefined>()
      const messageCreationClock = new TransactionMessageCreationClock()
      const dirtyChildLists = new Map<string, ChildListState>()
      const affectedMessageIds = new Set<MessageId>()
      const messageHeadersBeforeWrites = new Map<MessageId, MessageHeaderRow | undefined>()
      const targetLeaseByMessage = new Map<MessageId, StreamLeaseRow | null>()

      const assertStreamTargetWriteAllowed = async (messageId: MessageId): Promise<void> => {
        let targetLease = targetLeaseByMessage.get(messageId)
        if (!targetLeaseByMessage.has(messageId)) {
          const candidate = await tx
            .table<StreamLeaseRow, string>('streamLeases')
            .where('targetOwnerKey')
            .equals(messageId)
            .first()
          receiptAccumulator.physicalRead({
            tableName: 'streamLeases',
            indexKind: 'secondary',
            indexName: 'targetOwnerKey',
            operation: 'query',
            requestCount: 1,
            rowCount: candidate ? 1 : 0,
          })
          targetLease = candidate ?? null
          targetLeaseByMessage.set(messageId, targetLease)
        }
        if (!targetLease) return
        if (
          ownedStreamLease?.messageId === messageId &&
          targetLease.streamId === ownedStreamLease.streamId
        ) {
          return
        }
        throw new StreamTargetBusyError(messageId)
      }

      const syncAttachmentReferenceOwner = async (input: {
        ownerKind: AttachmentReferenceEdge['ownerKind']
        ownerId: string
        chatId: ChatId
        previousRefs: readonly MessageAttachmentRef[] | undefined
        nextRefs: readonly MessageAttachmentRef[] | undefined
        validateUnchangedTargets?: boolean
      }): Promise<void> => {
        const previousEdges = edgesForOwner({
          ownerKind: input.ownerKind,
          ownerId: input.ownerId,
          chatId: input.chatId,
          refs: input.previousRefs,
        })
        const nextEdges = edgesForOwner({
          ownerKind: input.ownerKind,
          ownerId: input.ownerId,
          chatId: input.chatId,
          refs: input.nextRefs,
        })
        if (
          stableStringify(previousEdges) === stableStringify(nextEdges) &&
          (!input.validateUnchangedTargets || nextEdges.length === 0)
        ) {
          return
        }
        if (!scopes.some((scope) => scope.kind === 'attachment')) {
          throw new Error(`UndeclaredAttachmentReferenceScope:${input.ownerKind}:${input.ownerId}`)
        }
        await applyAttachmentReferenceOwnerTransitions(
          tx,
          [input],
          now,
          (attachmentId) => assertScope({ kind: 'attachment', attachmentId }),
          input.validateUnchangedTargets === true,
        )
      }

      const loadChatState = async (
        chatId: ChatId,
        allowMissing: boolean,
      ): Promise<ChatMutationState | undefined> => {
        const existing = chatStates.get(chatId)
        if (existing) return existing
        if (absentChatIds.has(chatId)) {
          if (allowMissing) return undefined
          throw new ChatMissingError(chatId)
        }
        const chatRead = await chatMutation.readWithEvidence(chatId)
        const beforeChat = chatRead.chat
        if (operationPlan.descriptor.exactPhysicalReads && chatRead.requestCount > 0) {
          receiptAccumulator.physicalRead({
            tableName: 'chats',
            indexKind: 'primary',
            operation: 'get',
            requestCount: chatRead.requestCount,
            rowCount: chatRead.rowCount,
          })
        }
        if (!beforeChat) {
          absentChatIds.add(chatId)
          if (allowMissing) return undefined
          throw new ChatMissingError(chatId)
        }
        const state: ChatMutationState = {
          beforeChat,
          structuralSummaryDirty: false,
          structuralVersionDirty: false,
          headersBeforeWrites: new Map<MessageId, MessageHeaderRow | undefined>(),
          incrementalAppends: [],
          wordCountDeltas: new Map<MessageId, number>(),
          totalCostDelta: 0,
          visibleMetaPatch: {},
          hiddenMetaPatch: {},
          clearModelResolution: false,
          visibleMetaDirty: false,
          summaryVersionDirty: false,
          messageSummaryDirty: false,
          branchCorpusDirtyMessageIds: new Set<MessageId>(),
          previewDirty: false,
          changedMessageIds: new Set<MessageId>(),
        }
        chatStates.set(chatId, state)
        return state
      }

      const ensureChatState = async (chatId: ChatId): Promise<ChatMutationState> => {
        const state = await loadChatState(chatId, false)
        if (!state) throw new ChatMissingError(chatId)
        return state
      }

      const ensureStructuralSummaryContext = async (state: ChatMutationState): Promise<void> => {
        if (state.structuralSummaryDirty) return
        const previousBranch = await readBranchPathInTransaction(
          tx,
          state.beforeChat.id,
          state.beforeChat.lastUpdatedLeafId,
        )
        state.previousBranchIds = new Set(previousBranch.map((header) => header.id))
        state.structuralSummaryDirty = true
      }

      const recordHeaderBeforeWrite = (
        state: ChatMutationState | undefined,
        messageId: MessageId,
        header: MessageHeaderRow | undefined,
      ): void => {
        if (!messageHeadersBeforeWrites.has(messageId)) {
          messageHeadersBeforeWrites.set(messageId, header ? cloneMessageHeader(header) : undefined)
        }
        if (!state || state.headersBeforeWrites.has(messageId)) return
        state.headersBeforeWrites.set(messageId, header ? cloneMessageHeader(header) : undefined)
      }

      for (const scope of scopes) {
        if (
          scope.kind === 'chat-meta' ||
          scope.kind === 'chat-topology' ||
          scope.kind === 'children'
        ) {
          await loadChatState(scope.chatId, options?.allowMissingCanonicalChatId === scope.chatId)
        }
      }

      const requireChatState = (chatId: ChatId): ChatMutationState => {
        const state = chatStates.get(chatId)
        if (!state) {
          throw new Error(`ChatStateUnavailable:${chatId}`)
        }
        return state
      }

      const bumpChildList = async (
        chatId: ChatId,
        parentId: MessageId | null,
        bumpNow = now,
      ): Promise<ChildListState> => {
        assertScope({ kind: 'children', chatId, parentId })
        const table = tx.table<ChildListState, string>('childLists')
        const id = childListKey(chatId, parentId)
        const pending = dirtyChildLists.get(id)
        if (pending) {
          if (bumpNow <= pending.updatedAt) return pending
          const refreshed = { ...pending, updatedAt: bumpNow }
          dirtyChildLists.set(id, refreshed)
          return refreshed
        }
        const existing = await table.get(id)
        const next: ChildListState = {
          id,
          chatId,
          parentId,
          version: (existing?.version ?? 0) + 1,
          updatedAt: bumpNow,
          liveCount: existing?.liveCount ?? 0,
          firstLiveChildId: existing?.firstLiveChildId ?? null,
          lastLiveChildId: existing?.lastLiveChildId ?? null,
          nextSiblingIndex: existing?.nextSiblingIndex ?? 0,
        }
        dirtyChildLists.set(id, next)
        return next
      }

      const bumpAttachmentWireVersion = async (attachmentId: AttachmentId): Promise<void> => {
        const table = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
        const header = await table.get(attachmentId)
        if (!header) throw new Error(`AttachmentHeaderMissing:${attachmentId}`)
        await putAttachmentHeaderByteOwner(
          tx,
          { ...header, wireVersion: header.wireVersion + 1 },
          header,
        )
      }

      const attachmentWireHeader = (header: AttachmentHeaderRow): unknown => {
        const {
          wireVersion: _wireVersion,
          refCount: _refCount,
          unreferencedAt: _unreferencedAt,
          updatedAt: _updatedAt,
          lastIntegrityCheckAt: _lastIntegrityCheckAt,
          ...wireFields
        } = header
        return wireFields
      }

      const messageHeaderReads = new Map<MessageId, MessageHeaderRow | undefined>()
      const messageBodyReads = new Map<MessageId, MessageBodyRow | undefined>()
      const finalizedChats = new Map<ChatId, Chat>()
      const readMessageHeader = async (
        messageId: MessageId,
      ): Promise<MessageHeaderRow | undefined> => {
        if (!messageHeaderReads.has(messageId)) {
          receiptAccumulator.physicalRead({
            tableName: 'messages',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          })
          messageHeaderReads.set(
            messageId,
            await tx.table<MessageHeaderRow, MessageId>('messages').get(messageId),
          )
        }
        return messageHeaderReads.get(messageId)
      }
      const readMessageBody = async (messageId: MessageId): Promise<MessageBodyRow | undefined> => {
        if (!messageBodyReads.has(messageId)) {
          receiptAccumulator.physicalRead({
            tableName: 'messageBodies',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          })
          messageBodyReads.set(
            messageId,
            await tx.table<MessageBodyRow, MessageId>('messageBodies').get(messageId),
          )
        }
        return messageBodyReads.get(messageId)
      }

      const readAttachmentReferenceCounts = async (attachmentId: AttachmentId) => {
        const counts = await attachmentReferenceCounts(tx, attachmentId)
        receiptAccumulator.physicalRead({
          tableName: 'attachmentRefEdges',
          indexKind: 'secondary',
          indexName: 'attachmentId',
          operation: 'query',
          requestCount: 1,
          rowCount: counts.occurrences,
        })
        return counts
      }

      const deleteAttachmentOwnerBundle = async (
        attachmentId: AttachmentId,
        existing: AttachmentHeaderRow,
        catalogRow?: AttachmentCatalogProjectionRow,
      ): Promise<void> => {
        const deleted = await deleteAttachmentByteOwnerBundle(tx, attachmentId, existing)
        receiptAccumulator.physicalRead({
          tableName: 'attachmentBlobs',
          indexKind: 'secondary',
          indexName: 'attachmentId',
          operation: 'query',
          requestCount: 1,
          rowCount: deleted.blobs,
        })
        receiptAccumulator.physicalRead({
          tableName: 'attachmentArtifacts',
          indexKind: 'secondary',
          indexName: 'attachmentId',
          operation: 'query',
          requestCount: 1,
          rowCount: deleted.artifacts,
        })
        receiptAccumulator.physicalRead({
          tableName: 'attachmentJobs',
          indexKind: 'secondary',
          indexName: 'attachmentId',
          operation: 'query',
          requestCount: 1,
          rowCount: deleted.jobs,
        })
        await deleteAttachmentHeaderByteOwner(tx, existing)
        const catalogReceipt = await deleteAttachmentCatalogProjection(
          tx,
          attachmentId,
          catalogRow ? { previous: catalogRow } : undefined,
        )
        absorbSemanticOperationReceiptFragment(tx, catalogReceipt.fragment)
        recordBrowserCommandAttachmentReferenceState(tx, {
          attachmentId,
          initial: { exists: true, refCount: existing.refCount },
          final: { exists: false, refCount: 0 },
          projectionChanged: true,
        })
      }

      const deleteAttachmentBytesForHeader = async (
        attachmentId: AttachmentId,
        header: AttachmentHeaderRow,
        reason: AttachmentMissingReason,
        deletionNow: number,
        catalogRow?: AttachmentCatalogProjectionRow,
      ): Promise<Attachment> => {
        const [artifacts, jobs] = await Promise.all([
          tx
            .table<AttachmentArtifact, string>('attachmentArtifacts')
            .where('attachmentId')
            .equals(attachmentId)
            .toArray(),
          tx
            .table<AttachmentJob, string>('attachmentJobs')
            .where('attachmentId')
            .equals(attachmentId)
            .toArray(),
        ])
        receiptAccumulator.physicalRead({
          tableName: 'attachmentArtifacts',
          indexKind: 'secondary',
          indexName: 'attachmentId',
          operation: 'query',
          requestCount: 1,
          rowCount: artifacts.length,
        })
        receiptAccumulator.physicalRead({
          tableName: 'attachmentJobs',
          indexKind: 'secondary',
          indexName: 'attachmentId',
          operation: 'query',
          requestCount: 1,
          rowCount: jobs.length,
        })
        const retainedArtifacts = artifacts.filter((artifact) => artifact.kind !== 'blob')
        const deletedArtifacts = artifacts.filter((artifact) => artifact.kind === 'blob')
        const retainedArtifactIds = new Set(
          retainedArtifacts.map((artifact) => artifact.artifactId),
        )
        const deletedJobs: AttachmentJob[] = []
        const updatedJobs: AttachmentJob[] = []
        const previousUpdatedJobs: AttachmentJob[] = []
        for (const job of jobs) {
          const outputArtifactIds = job.outputArtifactIds.filter((id) =>
            retainedArtifactIds.has(id),
          )
          if (job.outputArtifactIds.length > 0 && outputArtifactIds.length === 0) {
            deletedJobs.push(job)
          } else if (!sameOrderedValues(outputArtifactIds, job.outputArtifactIds)) {
            previousUpdatedJobs.push(job)
            updatedJobs.push({ ...job, outputArtifactIds, updatedAt: deletionNow })
          }
        }
        const deletedBlobCount = await deleteAttachmentBlobRows(tx, attachmentId, header)
        receiptAccumulator.physicalRead({
          tableName: 'attachmentBlobs',
          indexKind: 'secondary',
          indexName: 'attachmentId',
          operation: 'query',
          requestCount: 1,
          rowCount: deletedBlobCount,
        })
        await deletePhysicalStorageRows(
          tx,
          'attachmentArtifacts',
          deletedArtifacts.map((artifact) => artifact.artifactId),
          deletedArtifacts,
        )
        await deletePhysicalStorageRows(
          tx,
          'attachmentJobs',
          deletedJobs.map((job) => job.id),
          deletedJobs,
        )
        await putPhysicalStorageRows(tx, 'attachmentJobs', updatedJobs, previousUpdatedJobs)
        if (deletedJobs.length > 0 || updatedJobs.length > 0) {
          recordBrowserCommandInvalidation(tx, {
            kind: 'attachment-job',
            attachmentIds: [attachmentId],
            jobIds: [...deletedJobs, ...updatedJobs].map((job) => job.id),
          })
        }
        const current = hydrateAttachment(header, artifacts)
        const processing = current.processing.flatMap((state) => {
          const outputArtifactIds = state.outputArtifactIds.filter((id) =>
            retainedArtifactIds.has(id),
          )
          return state.outputArtifactIds.length > 0 && outputArtifactIds.length === 0
            ? []
            : [{ ...state, outputArtifactIds }]
        })
        const next = missingAttachmentAfterByteDeletion(
          current,
          reason,
          deletionNow,
          retainedArtifacts,
          processing,
        )
        const unchangedHeader = splitAttachmentForStorage(
          next,
          header.wireVersion,
          header.unreferencedAt,
        )
        const payloadChanged =
          deletedBlobCount > 0 ||
          deletedArtifacts.length > 0 ||
          deletedJobs.length > 0 ||
          updatedJobs.length > 0
        if (!payloadChanged && stableStringify(unchangedHeader) === stableStringify(header)) {
          return current
        }
        const nextHeader = { ...unchangedHeader, wireVersion: header.wireVersion + 1 }
        await putAttachmentHeaderByteOwner(tx, nextHeader, header)
        const catalogReceipt = await putAttachmentCatalogProjectionFromHeader(
          tx,
          nextHeader,
          header,
          catalogRow ? { previous: catalogRow } : undefined,
        )
        absorbSemanticOperationReceiptFragment(tx, catalogReceipt.fragment)
        recordBrowserCommandAttachmentReferenceState(tx, {
          attachmentId,
          initial: { exists: true, refCount: header.refCount },
          final: { exists: true, refCount: nextHeader.refCount },
          projectionChanged: true,
        })
        return hydrateAttachment(nextHeader, retainedArtifacts)
      }

      const readAttachmentDispositionState = async (
        attachmentId: AttachmentId,
      ): Promise<
        | { readonly kind: 'absent' }
        | {
            readonly kind: 'present'
            readonly header: AttachmentHeaderRow
            readonly catalogRow: AttachmentCatalogProjectionRow | undefined
            readonly firstReference: AttachmentReferenceEdge | undefined
          }
      > => {
        const header = await tx
          .table<AttachmentHeaderRow, AttachmentId>('attachments')
          .get(attachmentId)
        receiptAccumulator.physicalRead({
          tableName: 'attachments',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        })
        if (!header) return { kind: 'absent' }
        const catalogRow = await tx
          .table<AttachmentCatalogProjectionRow, AttachmentId>('attachmentCatalogRows')
          .get(attachmentId)
        receiptAccumulator.physicalRead({
          tableName: 'attachmentCatalogRows',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        })
        const firstReference = await tx
          .table<AttachmentReferenceEdge>('attachmentRefEdges')
          .where('attachmentId')
          .equals(attachmentId)
          .first()
        receiptAccumulator.physicalRead({
          tableName: 'attachmentRefEdges',
          indexKind: 'secondary',
          indexName: 'attachmentId',
          operation: 'query',
          requestCount: 1,
          rowCount: firstReference ? 1 : 0,
        })
        return { kind: 'present', header, catalogRow, firstReference }
      }
      let attachmentIntegrityRepairRequested = false

      const requestAttachmentIntegrityRepair = async (): Promise<void> => {
        if (attachmentIntegrityRepairRequested) return
        await markAttachmentIntegrityRepairPending(tx)
        receiptAccumulator.physicalRead({
          tableName: 'attachmentCatalogAggregate',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        })
        receiptAccumulator.physicalRead({
          tableName: 'attachmentIntegrityState',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: 1,
        })
        recordBrowserCommandAttachmentIntegrityRepairRequest(tx)
        attachmentIntegrityRepairRequested = true
      }

      const requireConsistentAttachmentDispositionState = (
        attachmentId: AttachmentId,
        state: Exclude<
          Awaited<ReturnType<typeof readAttachmentDispositionState>>,
          { kind: 'absent' }
        >,
      ) => {
        if (!state.catalogRow) throw new Error(`AttachmentCatalogRowMissing:${attachmentId}`)
        if (
          state.header.refCount !== state.catalogRow.refCount ||
          (state.firstReference !== undefined) !== state.catalogRow.refCount > 0
        ) {
          throw new Error(`AttachmentReferenceProjectionMismatch:${attachmentId}`)
        }
        return { ...state, catalogRow: state.catalogRow }
      }

      const ctx: MutationContext = {
        getChat: async (chatId) => {
          const state = chatStates.get(chatId)
          if (absentChatIds.has(chatId)) return undefined
          if (!state) return tx.table<Chat, ChatId>('chats').get(chatId)
          return materializeChatMutationState(state)
        },

        getSetting: async <T = unknown>(key: string) => {
          if (!options?.settingReadKeys?.includes(key)) {
            throw new Error(`UndeclaredSettingRead:${key}`)
          }
          const row = await tx.table<SettingsRow, string>('settings').get(key)
          return row === undefined ? undefined : structuredClone(row.value as T)
        },

        patchChatMeta: (chatId, patch, options = {}) => {
          const { touchVisibleState = true, touchSummary = touchVisibleState } = options
          assertScope({ kind: 'chat-meta', chatId })
          const state = requireChatState(chatId)
          const current = materializeChatMutationState(state)
          const metadataPatch = requireChatMetadataPatch(patch)
          const clearsModelResolution =
            options.clearModelResolution === true && current.modelResolution !== undefined
          if (touchVisibleState) {
            const applied = changedPatch(current, metadataPatch)
            if (!applied && !clearsModelResolution) return
            if (applied) {
              state.visibleMetaPatch = {
                ...state.visibleMetaPatch,
                ...applied,
              }
            }
            state.clearModelResolution ||= clearsModelResolution
            state.visibleMetaDirty = true
            state.summaryVersionDirty ||= touchSummary
          } else {
            const applied = changedPatch(current, metadataPatch)
            if (!applied && !clearsModelResolution) return
            if (applied) {
              state.hiddenMetaPatch = {
                ...state.hiddenMetaPatch,
                ...applied,
              }
            }
            state.clearModelResolution ||= clearsModelResolution
          }
        },

        getMessage: async (messageId) => {
          const [header, body] = await Promise.all([
            readMessageHeader(messageId),
            readMessageBody(messageId),
          ])
          return header && body ? hydrateStoredMessage(header, body) : undefined
        },

        getMessageHeader: async (messageId) => {
          const header = await readMessageHeader(messageId)
          return header ? cloneMessageHeader(header) : undefined
        },

        getMessageHeaders: async (messageIds) => {
          const missingIds = [
            ...new Set(messageIds.filter((messageId) => !messageHeaderReads.has(messageId))),
          ]
          if (missingIds.length > 0) {
            const missingHeaders = await tx
              .table<MessageHeaderRow, MessageId>('messages')
              .bulkGet(missingIds)
            for (let index = 0; index < missingIds.length; index += 1) {
              messageHeaderReads.set(missingIds[index] as MessageId, missingHeaders[index])
            }
          }
          return messageIds.map((messageId) => {
            const header = messageHeaderReads.get(messageId)
            return header ? cloneMessageHeader(header) : undefined
          })
        },

        listMessageHeaders: async (chatId) =>
          (
            await tx
              .table<MessageHeaderRow, MessageId>('messages')
              .where('chatId')
              .equals(chatId)
              .toArray()
          ).map(cloneMessageHeader),

        listChildHeaders: async (chatId, parentId) => {
          return (
            await listChildHeaderRows(
              tx.table<MessageHeaderRow, MessageId>('messages'),
              chatId,
              parentId,
            )
          ).map(cloneMessageHeader)
        },

        putMessage: async (message, options: PutMessageOptions = {}) => {
          const { touchChatSummary = true, semanticEffect, creationTimestamp } = options
          assertCanonicalGeneratedOutputMessage(message.content, message.attachmentRefs, message.id)
          const headerTable = tx.table<MessageHeaderRow, MessageId>('messages')
          const previewTable = tx.table<MessageTextPreviewRow, MessageId>('messagePreviews')
          const existing = await readMessageHeader(message.id)
          const existingBody = existing ? await readMessageBody(message.id) : undefined
          const chatId = existing?.chatId ?? message.chatId
          const needsChatState = touchChatSummary
          let state = needsChatState ? await ensureChatState(chatId) : undefined
          const clone = cloneMessage(message)
          let messageSummaryChanged = existing === undefined

          assertScope({ kind: 'message', messageId: clone.id })
          if (existing) {
            assertExistingMessageIdentity(existing, clone)
            if (!existingBody) throw new Error(`MessageBodyMissing:${clone.id}`)
            const candidate = compileCurrentMessageUpdateCandidate(clone, existing, existingBody)
            const comparableSplit = candidate.transition.storage
            const { headerChanged, bodyChanged } = candidate
            if (!headerChanged && !bodyChanged) {
              return hydrateStoredMessage(existing, existingBody)
            }
            const semantics = messageSemanticEffect(
              existing,
              existingBody,
              comparableSplit.header,
              comparableSplit.body,
              semanticEffect,
            )
            if (semantics.branchCorpusChanged) {
              state ??= await ensureChatState(chatId)
              state.branchCorpusDirtyMessageIds.add(clone.id)
            }
            if (
              streamOwnedMessageFieldsChanged(
                existing,
                existingBody,
                comparableSplit.header,
                comparableSplit.body,
              )
            ) {
              await assertStreamTargetWriteAllowed(clone.id)
            }
            if (
              existing.role === 'user' &&
              stableStringify(existingBody.content) !== stableStringify(clone.content)
            ) {
              const previewState = state ?? (await ensureChatState(chatId))
              previewState.previewDirty = true
            }
            if (touchChatSummary) {
              messageSummaryChanged = recordMessageHeaderSummaryDeltas(
                state,
                clone.id,
                existing,
                comparableSplit.header,
              )
            }
            recordHeaderBeforeWrite(state, clone.id, existing)
            clone.nodeVersion = existing.nodeVersion + 1
            const requestContextVersion =
              existing.requestContextVersion + (semantics.requestContextChanged ? 1 : 0)
            const transition = finalizeCurrentMessageUpdateTransition(candidate, {
              nodeVersion: clone.nodeVersion,
              requestContextVersion,
              bodyVersion: existing.bodyVersion + (bodyChanged ? 1 : 0),
              bodyUpdatedAt: bodyChanged ? now : existingBody.updatedAt,
            })
            const { header } = transition.storage
            await syncAttachmentReferenceOwner(transition.attachmentOwner)
            await putPhysicalStorageRow(tx, 'messages', header, existing)
            if (bodyChanged) {
              await replaceMessageBody(tx, transition.storage.body, {
                kind: 'row',
                row: existingBody,
              })
              const previousPreview = await previewTable.get(clone.id)
              receiptAccumulator.physicalRead({
                tableName: 'messagePreviews',
                indexKind: 'primary',
                operation: 'get',
                requestCount: 1,
                rowCount: 1,
              })
              await putPhysicalStorageRow(
                tx,
                'messagePreviews',
                transition.storage.preview,
                previousPreview,
              )
            }
            messageHeaderReads.set(clone.id, header)
            messageBodyReads.set(clone.id, bodyChanged ? transition.storage.body : existingBody)
          } else {
            if (!touchChatSummary) {
              throw new Error(`DeferredMessageWriteRequiresExistingRow:${clone.id}`)
            }
            const summaryState = state as ChatMutationState
            summaryState.structuralVersionDirty = true
            if (creationTimestamp !== 'preserve') {
              clone.createdAt = await messageCreationClock.next(tx, clone.chatId, now)
            }
            const expectedLeafId =
              summaryState.incrementalAppends.at(-1)?.id ??
              summaryState.beforeChat.lastUpdatedLeafId
            let incrementalAppend =
              !summaryState.structuralSummaryDirty &&
              !clone.deleted &&
              clone.parentId === expectedLeafId
            if (incrementalAppend && expectedLeafId !== null) {
              const expectedLeaf = await headerTable.get(expectedLeafId)
              incrementalAppend =
                expectedLeaf !== undefined &&
                !expectedLeaf.deleted &&
                messageOutranksLeaf(clone, expectedLeaf)
            }
            if (!incrementalAppend) {
              await ensureStructuralSummaryContext(summaryState)
            }
            assertScope({ kind: 'children', chatId, parentId: clone.parentId })
            const reservedTarget =
              streamAdmission?.messageId === clone.id ? streamAdmission : undefined
            const transition = compileCurrentMessageTransition(clone, {
              updatedAt: now,
              timestamp: creationTimestamp === 'preserve' ? 'exact' : 'transaction-allocated',
              custody: reservedTarget
                ? {
                    kind: 'reserved-attempt-target',
                    messageId: reservedTarget.messageId,
                    streamId: reservedTarget.streamId,
                  }
                : { kind: 'available' },
            })
            const { header, body, preview } = transition.storage
            recordHeaderBeforeWrite(summaryState, clone.id, undefined)
            await syncAttachmentReferenceOwner(transition.attachmentOwner)
            await addPhysicalStorageRow(tx, 'messages', header)
            await insertMessageBody(tx, body)
            await addPhysicalStorageRow(tx, 'messagePreviews', preview)
            messageHeaderReads.set(clone.id, header)
            messageBodyReads.set(clone.id, body)
            if (transition.summary.previewCandidate !== undefined) {
              summaryState.previewDirty = true
            }
            summaryState.wordCountDeltas.set(clone.id, transition.summary.wordCount)
            summaryState.totalCostDelta += transition.summary.costUsd
            if (incrementalAppend) {
              summaryState.incrementalAppends.push(clone)
            }
            await bumpChildList(chatId, transition.structural.parentId)
          }

          if (touchChatSummary && state && messageSummaryChanged) {
            state.summaryVersionDirty = true
            state.messageSummaryDirty = true
            state.changedMessageIds.add(clone.id)
          }
          affectedMessageIds.add(clone.id)
          return clone
        },

        replaceMessageAttachmentRefs: async (messageId, attachmentRefs) => {
          assertScope({ kind: 'message', messageId })
          const existing = await readMessageHeader(messageId)
          if (!existing) return undefined
          const next = transitionMessageAttachmentRefs(existing, attachmentRefs)
          if (stableStringify(existing.attachmentRefs) === stableStringify(next.attachmentRefs)) {
            return cloneMessageHeader(existing)
          }
          await syncAttachmentReferenceOwner({
            ownerKind: 'message',
            ownerId: messageId,
            chatId: existing.chatId,
            previousRefs: existing.attachmentRefs,
            nextRefs: next.attachmentRefs,
          })
          recordHeaderBeforeWrite(undefined, messageId, existing)
          await putPhysicalStorageRow(tx, 'messages', next, existing)
          messageHeaderReads.set(messageId, next)
          affectedMessageIds.add(messageId)
          return cloneMessageHeader(next)
        },

        patchMessageStructure: async (messageId, patch: MessageStructurePatch): Promise<void> => {
          assertScope({ kind: 'message', messageId })
          const keys = Object.keys(patch)
          if (
            keys.some((key) => key !== 'deleted' && key !== 'parentId' && key !== 'siblingIndex')
          ) {
            throw new Error(`MessageStructurePatchForbidden:${messageId}`)
          }
          const existing = await readMessageHeader(messageId)
          if (!existing) return undefined
          const next = cloneMessageHeader(existing)
          if (patch.parentId !== undefined) next.parentId = patch.parentId
          if (patch.siblingIndex !== undefined) next.siblingIndex = patch.siblingIndex
          if (patch.deleted !== undefined) next.deleted = patch.deleted
          const changed =
            next.parentId !== existing.parentId ||
            next.siblingIndex !== existing.siblingIndex ||
            next.deleted !== existing.deleted
          if (!changed) return

          const state = await ensureChatState(existing.chatId)
          state.structuralVersionDirty = true
          await ensureStructuralSummaryContext(state)
          assertScope({
            kind: 'children',
            chatId: existing.chatId,
            parentId: existing.parentId,
          })
          if (next.parentId !== existing.parentId) {
            assertScope({
              kind: 'children',
              chatId: existing.chatId,
              parentId: next.parentId,
            })
          }
          await assertStreamTargetWriteAllowed(messageId)
          recordHeaderBeforeWrite(state, messageId, existing)
          next.nodeVersion = existing.nodeVersion + 1
          next.requestContextVersion =
            existing.requestContextVersion +
            (next.parentId !== existing.parentId || next.deleted !== existing.deleted ? 1 : 0)
          Object.assign(next, messageTreeIndexFields(next))
          await putPhysicalStorageRow(tx, 'messages', next, existing)
          messageHeaderReads.set(messageId, next)
          state.totalCostDelta += messageCost(next) - messageCost(existing)
          await bumpChildList(existing.chatId, existing.parentId)
          if (next.parentId !== existing.parentId) {
            await bumpChildList(existing.chatId, next.parentId)
          }
          if (existing.role === 'user' && next.deleted !== existing.deleted) {
            state.previewDirty = true
          }
          state.summaryVersionDirty = true
          state.messageSummaryDirty = true
          state.changedMessageIds.add(messageId)
          affectedMessageIds.add(messageId)
        },

        patchMessageBody: async (messageId, patch, options: PatchMessageBodyOptions = {}) => {
          const {
            touchChatSummary = true,
            headerPatch,
            replaceBody = false,
            semanticEffect,
            replacementBaseline,
          } = options
          assertScope({ kind: 'message', messageId })
          const previewTable = tx.table<MessageTextPreviewRow, MessageId>('messagePreviews')
          const existing = await readMessageHeader(messageId)
          if (!existing) return
          if (replacementBaseline && !replaceBody) {
            throw new Error(`MessageBodyReplacementBaselineWithoutReplacement:${messageId}`)
          }
          if (replacementBaseline && existing.bodyVersion !== replacementBaseline.bodyVersion) {
            throw new Error(`MessageBodyReplacementBaselineChanged:${messageId}`)
          }
          let state = touchChatSummary ? await ensureChatState(existing.chatId) : undefined
          const nextHeader = applyMessageHeaderPatch(existing, headerPatch)
          const existingBody =
            replaceBody && replacementBaseline ? undefined : await readMessageBody(messageId)
          if (replaceBody && replacementBaseline) {
            const keys = await tx
              .table<MessageBodyRow, MessageId>('messageBodies')
              .where(':id')
              .equals(messageId)
              .primaryKeys()
            if (keys.length === 0) return
          }
          if (!replaceBody && !existingBody) throw new Error(`MessageBodyMissing:${messageId}`)
          if (replaceBody && touchChatSummary && !existingBody && !replacementBaseline) {
            throw new Error(`MessageBodyMissing:${messageId}`)
          }
          let nextBody: MessageBodyRow
          let bodyChanged = true
          let messageSummaryChanged = false
          if (!replaceBody) {
            const patchedBody = applyMessageBodyPatch(existingBody as MessageBodyRow, patch)
            nextHeader.nodeVersion = existing.nodeVersion
            nextHeader.bodyVersion = existing.bodyVersion
            patchedBody.bodyVersion = (existingBody as MessageBodyRow).bodyVersion
            patchedBody.updatedAt = (existingBody as MessageBodyRow).updatedAt
            syncMessageHeaderProjections(nextHeader, patchedBody)
            const headerChanged = stableStringify(existing) !== stableStringify(nextHeader)
            bodyChanged = stableStringify(existingBody) !== stableStringify(patchedBody)
            if (!headerChanged && !bodyChanged) {
              return {
                header: cloneMessageHeader(existing),
                message: hydrateStoredMessage(existing, existingBody as MessageBodyRow),
                bodyVersion: existing.bodyVersion,
              }
            }
            nextHeader.nodeVersion = existing.nodeVersion + 1
            nextHeader.bodyVersion = existing.bodyVersion + (bodyChanged ? 1 : 0)
            nextBody = bodyChanged
              ? {
                  ...patchedBody,
                  bodyVersion: nextHeader.bodyVersion,
                  updatedAt: now,
                }
              : (existingBody as MessageBodyRow)
            if (touchChatSummary) {
              messageSummaryChanged = existingBody
                ? recordMessageSummaryDeltas(
                    state,
                    messageId,
                    hydrateStoredMessage(existing, existingBody),
                    hydrateStoredMessage(nextHeader, nextBody),
                  )
                : recordMessageHeaderSummaryDeltas(state, messageId, existing, nextHeader)
            }
          } else {
            await assertStreamTargetWriteAllowed(messageId)
            nextHeader.nodeVersion = existing.nodeVersion + 1
            nextHeader.bodyVersion = existing.bodyVersion + 1
            nextBody = replacementMessageBody(nextHeader, patch, {
              bodyVersion: nextHeader.bodyVersion,
              updatedAt: now,
            })
            syncMessageHeaderProjections(nextHeader, nextBody)
            if (touchChatSummary) {
              messageSummaryChanged = existingBody
                ? recordMessageSummaryDeltas(
                    state,
                    messageId,
                    hydrateStoredMessage(existing, existingBody),
                    hydrateStoredMessage(nextHeader, nextBody),
                  )
                : recordMessageHeaderSummaryDeltas(state, messageId, existing, nextHeader)
            }
          }
          const semantics = messageSemanticEffect(
            existing,
            existingBody,
            nextHeader,
            nextBody,
            replacementBaseline?.semanticEffect ?? semanticEffect,
          )
          nextHeader.requestContextVersion =
            existing.requestContextVersion + (semantics.requestContextChanged ? 1 : 0)
          if (semantics.branchCorpusChanged) {
            state ??= await ensureChatState(existing.chatId)
            state.branchCorpusDirtyMessageIds.add(messageId)
          }
          assertCanonicalGeneratedOutputMessage(
            nextBody.content,
            nextHeader.attachmentRefs,
            messageId,
          )
          if (
            !replaceBody &&
            streamOwnedMessageFieldsChanged(
              existing,
              existingBody as MessageBodyRow,
              nextHeader,
              nextBody,
            )
          ) {
            await assertStreamTargetWriteAllowed(messageId)
          }
          if (
            headerPatch !== undefined &&
            Object.hasOwn(headerPatch, 'attachmentRefs') &&
            stableStringify(existing.attachmentRefs ?? []) !==
              stableStringify(nextHeader.attachmentRefs ?? [])
          ) {
            await syncAttachmentReferenceOwner({
              ownerKind: 'message',
              ownerId: nextHeader.id,
              chatId: nextHeader.chatId,
              previousRefs: existing.attachmentRefs,
              nextRefs: nextHeader.attachmentRefs,
            })
          }
          recordHeaderBeforeWrite(state, messageId, existing)
          await putPhysicalStorageRow(tx, 'messages', nextHeader, existing)
          if (bodyChanged) {
            await replaceMessageBody(
              tx,
              nextBody,
              existingBody
                ? { kind: 'row', row: existingBody }
                : replacementBaseline
                  ? {
                      kind: 'row',
                      row: {
                        id: existing.id,
                        chatId: existing.chatId,
                        bodyVersion: replacementBaseline.bodyVersion,
                        updatedAt: 0,
                        ...replacementBaseline.body,
                      },
                    }
                  : { kind: 'header-projection', header: existing },
            )
            await putPhysicalStorageRow(
              tx,
              'messagePreviews',
              projectMessageTextPreview(nextHeader, nextBody),
              await previewTable.get(messageId),
            )
          }
          messageHeaderReads.set(messageId, nextHeader)
          messageBodyReads.set(messageId, nextBody)
          if (existing.role === 'user' && Object.hasOwn(patch, 'content')) {
            const previewState = state ?? (await ensureChatState(existing.chatId))
            previewState.previewDirty = true
          }
          if (touchChatSummary && state && messageSummaryChanged) {
            state.summaryVersionDirty = true
            state.messageSummaryDirty = true
            state.changedMessageIds.add(messageId)
          }
          affectedMessageIds.add(messageId)
          return {
            header: cloneMessageHeader(nextHeader),
            message: hydrateStoredMessage(nextHeader, nextBody),
            bodyVersion: nextHeader.bodyVersion,
          }
        },

        transitionMessageGenerationForDispatch: async (messageId, generation) => {
          assertScope({ kind: 'message', messageId })
          const existing = await readMessageHeader(messageId)
          if (!existing) return undefined
          const next = transitionMessageGenerationForDispatch(existing, generation)
          if (stableStringify(existing) === stableStringify(next)) {
            return cloneMessageHeader(existing)
          }
          recordHeaderBeforeWrite(undefined, messageId, existing)
          await putPhysicalStorageRow(tx, 'messages', next, existing)
          messageHeaderReads.set(messageId, next)
          affectedMessageIds.add(messageId)
          return cloneMessageHeader(next)
        },

        getChildList: async (chatId, parentId) => {
          const row = await tx
            .table<ChildListState, string>('childLists')
            .get(childListKey(chatId, parentId))
          return (
            row ?? {
              id: childListKey(chatId, parentId),
              chatId,
              parentId,
              version: 0,
              updatedAt: 0,
              liveCount: 0,
              firstLiveChildId: null,
              lastLiveChildId: null,
              nextSiblingIndex: 0,
            }
          )
        },

        getChildLists: async (chatId, parentIds) => {
          const rows = await tx
            .table<ChildListState, string>('childLists')
            .bulkGet(parentIds.map((parentId) => childListKey(chatId, parentId)))
          return rows.map(
            (row, index): ChildListState =>
              row ?? {
                id: childListKey(chatId, parentIds[index] ?? null),
                chatId,
                parentId: parentIds[index] ?? null,
                version: 0,
                updatedAt: 0,
                liveCount: 0,
                firstLiveChildId: null,
                lastLiveChildId: null,
                nextSiblingIndex: 0,
              },
          )
        },

        getChildSlotMembers: async (messageIds) =>
          tx.table<ChildSlotMember, MessageId>('childSlotMembers').bulkGet([...messageIds]),

        getAttachment: async (attachmentId) => {
          const header = await tx
            .table<AttachmentHeaderRow, AttachmentId>('attachments')
            .get(attachmentId)
          return header
            ? hydrateStoredAttachment(
                header,
                tx.table<AttachmentArtifact, string>('attachmentArtifacts'),
              )
            : undefined
        },

        getAttachmentCatalogRevision: async () => {
          const aggregate = await tx
            .table<AttachmentCatalogAggregateRow, string>('attachmentCatalogAggregate')
            .get(ATTACHMENT_CATALOG_AGGREGATE_ID)
          receiptAccumulator.physicalRead({
            tableName: 'attachmentCatalogAggregate',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          })
          if (!aggregate) throw new Error('AttachmentCatalogAggregateMissing')
          return aggregate.projectionRevision
        },

        findAttachmentIdByContentHash: async (filename, contentHash, excludeId) => {
          const row = await tx
            .table<AttachmentHeaderRow, AttachmentId>('attachments')
            .where('contentHash')
            .equals(contentHash)
            .filter(
              (attachment) =>
                attachment.id !== excludeId &&
                attachment.filename === filename &&
                attachment.deletedAt === undefined &&
                attachment.storage.kind !== 'missing',
            )
            .first()
          return row?.id
        },

        writeAttachmentBundle: async (
          bundle: AttachmentBundle,
          mode: AttachmentBundleWriteMode,
        ): Promise<AttachmentBundleWriteResult> => {
          const attachmentId = bundle.attachment.id
          assertScope({ kind: 'attachment', attachmentId })
          if (
            (mode === 'dedupe' || mode === 'dedupe-or-replace') &&
            bundle.attachment.contentHash
          ) {
            const candidates = await tx
              .table<AttachmentHeaderRow, AttachmentId>('attachments')
              .where('contentHash')
              .equals(bundle.attachment.contentHash)
              .toArray()
            receiptAccumulator.physicalRead({
              tableName: 'attachments',
              indexKind: 'secondary',
              indexName: 'contentHash',
              operation: 'query',
              requestCount: 1,
              rowCount: candidates.length,
            })
            const duplicate = candidates.find(
              (candidate) =>
                candidate.filename === bundle.attachment.filename &&
                candidate.deletedAt === undefined &&
                candidate.storage.kind !== 'missing',
            )
            if (duplicate) {
              return { attachmentId: duplicate.id, outcome: 'existing' }
            }
          }
          const existing = await tx
            .table<AttachmentHeaderRow, AttachmentId>('attachments')
            .get(attachmentId)
          receiptAccumulator.physicalRead({
            tableName: 'attachments',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          })
          if (existing && (mode === 'put-if-absent' || mode === 'dedupe')) {
            return { attachmentId, outcome: 'existing' }
          }
          if ((mode === 'replace' || mode === 'dedupe-or-replace') && !existing) {
            throw new Error(`AttachmentMissing:${attachmentId}`)
          }
          const deleted = await replaceAttachmentByteOwnerBundle(tx, attachmentId, existing, bundle)
          receiptAccumulator.physicalRead({
            tableName: 'attachmentBlobs',
            indexKind: 'secondary',
            indexName: 'attachmentId',
            operation: 'query',
            requestCount: 1,
            rowCount: deleted.blobs,
          })
          receiptAccumulator.physicalRead({
            tableName: 'attachmentArtifacts',
            indexKind: 'secondary',
            indexName: 'attachmentId',
            operation: 'query',
            requestCount: 1,
            rowCount: deleted.artifacts,
          })
          receiptAccumulator.physicalRead({
            tableName: 'attachmentJobs',
            indexKind: 'secondary',
            indexName: 'attachmentId',
            operation: 'query',
            requestCount: 1,
            rowCount: deleted.jobs,
          })
          const refCount = existing?.refCount ?? 0
          const unreferencedAt =
            refCount > 0
              ? null
              : existing?.refCount === 0 && typeof existing.unreferencedAt === 'number'
                ? existing.unreferencedAt
                : now
          const committedAttachment: Attachment = {
            ...bundle.attachment,
            ...(existing ? { createdAt: existing.createdAt } : {}),
            refCount,
          }
          const next = splitAttachmentForStorage(
            committedAttachment,
            existing ? existing.wireVersion + 1 : 0,
            unreferencedAt,
          )
          await putAttachmentHeaderByteOwner(tx, next, existing)
          const catalogReceipt = await putAttachmentCatalogProjectionFromHeader(tx, next, existing)
          absorbSemanticOperationReceiptFragment(tx, catalogReceipt.fragment)
          recordBrowserCommandAttachmentReferenceState(tx, {
            attachmentId,
            initial: { exists: existing !== undefined, refCount: existing?.refCount ?? 0 },
            final: { exists: true, refCount: next.refCount },
            projectionChanged: true,
          })
          return {
            attachmentId,
            outcome: 'written',
            attachment: committedAttachment,
          }
        },

        deleteAttachmentIfUnreferenced: async (attachmentId) => {
          assertScope({ kind: 'attachment', attachmentId })
          const state = await readAttachmentDispositionState(attachmentId)
          if (state.kind === 'absent') {
            return { deleted: false, refs: { messages: 0, drafts: 0 } }
          }
          const current = requireConsistentAttachmentDispositionState(attachmentId, state)
          const refs = {
            messages: current.catalogRow.messageRefCount,
            drafts: current.catalogRow.draftRefCount,
          }
          if (current.firstReference) return { deleted: false, refs }
          await deleteAttachmentOwnerBundle(attachmentId, current.header, current.catalogRow)
          return { deleted: true, refs }
        },

        deleteAttachmentForStorage: async (attachmentId, reason, deletionNow) => {
          assertScope({ kind: 'attachment', attachmentId })
          const state = await readAttachmentDispositionState(attachmentId)
          if (state.kind === 'absent') return 'absent'
          const current = requireConsistentAttachmentDispositionState(attachmentId, state)
          if (!current.firstReference) {
            await deleteAttachmentOwnerBundle(attachmentId, current.header, current.catalogRow)
            return 'deleted'
          }
          await deleteAttachmentBytesForHeader(
            attachmentId,
            current.header,
            reason,
            deletionNow,
            current.catalogRow,
          )
          return 'stubbed'
        },

        reapAttachmentIfEligible: async (attachmentId, cutoff) => {
          assertScope({ kind: 'attachment', attachmentId })
          const state = await readAttachmentDispositionState(attachmentId)
          if (state.kind === 'absent') return 'absent'
          if (
            state.firstReference ||
            !state.catalogRow ||
            state.header.refCount !== state.catalogRow.refCount ||
            state.catalogRow.refCount > 0
          ) {
            await requestAttachmentIntegrityRepair()
            return 'repair-required'
          }
          if (state.header.unreferencedAt === null || state.header.unreferencedAt >= cutoff) {
            return 'retained'
          }
          await deleteAttachmentOwnerBundle(attachmentId, state.header, state.catalogRow)
          return 'deleted'
        },

        putAttachment: async (attachment) => {
          assertScope({ kind: 'attachment', attachmentId: attachment.id })
          const table = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
          const existing = await table.get(attachment.id)
          const refCount = existing?.refCount ?? 0
          const unreferencedAt =
            refCount > 0
              ? null
              : existing?.refCount === 0 && typeof existing.unreferencedAt === 'number'
                ? existing.unreferencedAt
                : Date.now()
          const next = splitAttachmentForStorage(
            { ...attachment, refCount },
            existing?.wireVersion ?? 0,
            unreferencedAt,
          )
          if (existing) {
            const wireChanged =
              stableStringify(attachmentWireHeader(existing)) !==
              stableStringify(attachmentWireHeader(next))
            next.wireVersion = existing.wireVersion + (wireChanged ? 1 : 0)
            if (stableStringify(existing) === stableStringify(next)) return
          }
          await putAttachmentHeaderByteOwner(tx, next, existing)
          await putAttachmentCatalogProjectionFromHeader(tx, next, existing)
          recordBrowserCommandAttachmentReferenceState(tx, {
            attachmentId: attachment.id,
            initial: { exists: existing !== undefined, refCount: existing?.refCount ?? 0 },
            final: { exists: true, refCount: next.refCount },
            projectionChanged: true,
          })
        },

        deleteAttachment: async (attachmentId) => {
          assertScope({ kind: 'attachment', attachmentId })
          const table = tx.table<AttachmentHeaderRow, AttachmentId>('attachments')
          const existing = await table.get(attachmentId)
          if (!existing) return
          if (!(await requireNoAttachmentReferences(tx, attachmentId))) {
            throw new Error(`AttachmentStillReferenced:${attachmentId}`)
          }
          await deleteAttachmentOwnerBundle(attachmentId, existing)
        },

        countAttachmentReferences: readAttachmentReferenceCounts,

        getAttachmentReferenceEdges: async (attachmentId) =>
          tx
            .table<AttachmentReferenceEdge>('attachmentRefEdges')
            .where('attachmentId')
            .equals(attachmentId)
            .toArray(),

        deleteAttachmentBytes: async (attachmentId, reason, deletionNow) => {
          assertScope({ kind: 'attachment', attachmentId })
          const header = await tx
            .table<AttachmentHeaderRow, AttachmentId>('attachments')
            .get(attachmentId)
          receiptAccumulator.physicalRead({
            tableName: 'attachments',
            indexKind: 'primary',
            operation: 'get',
            requestCount: 1,
            rowCount: 1,
          })
          if (!header) return undefined
          return deleteAttachmentBytesForHeader(attachmentId, header, reason, deletionNow)
        },

        deleteAttachmentBlobs: async (attachmentId) => {
          assertScope({ kind: 'attachment', attachmentId })
          const header = await tx
            .table<AttachmentHeaderRow, AttachmentId>('attachments')
            .get(attachmentId)
          const deleted = await deleteAttachmentBlobRows(tx, attachmentId, header)
          if (deleted > 0) {
            await bumpAttachmentWireVersion(attachmentId)
          }
        },

        deleteAttachmentArtifacts: async (attachmentId) => {
          assertScope({ kind: 'attachment', attachmentId })
          const header = await tx
            .table<AttachmentHeaderRow, AttachmentId>('attachments')
            .get(attachmentId)
          const deleted = await deleteAttachmentArtifactRows(tx, attachmentId, header)
          if (deleted > 0) {
            await bumpAttachmentWireVersion(attachmentId)
          }
        },

        deleteAttachmentJobs: async (attachmentId) => {
          assertScope({ kind: 'attachment', attachmentId })
          const deleted = await deleteAttachmentJobRows(tx, attachmentId)
          if (deleted > 0) {
            await bumpAttachmentWireVersion(attachmentId)
          }
        },

        getAttachmentArtifacts: async (attachmentId) =>
          tx
            .table<AttachmentArtifact, string>('attachmentArtifacts')
            .where('attachmentId')
            .equals(attachmentId)
            .toArray(),

        getAttachmentJob: async (jobId) =>
          tx.table<AttachmentJob, string>('attachmentJobs').get(jobId),

        getAttachmentJobs: async (attachmentId) =>
          tx
            .table<AttachmentJob, string>('attachmentJobs')
            .where('attachmentId')
            .equals(attachmentId)
            .toArray(),

        putAttachmentBlob: async (blob) => {
          assertScope({ kind: 'attachment', attachmentId: blob.attachmentId })
          const table = tx.table<AttachmentBlob, string>('attachmentBlobs')
          const existing = await table.get(blob.id)
          if (existing && stableStringify(existing) === stableStringify(blob)) return
          await putAttachmentBlobByteOwner(tx, blob, existing)
          await bumpAttachmentWireVersion(blob.attachmentId)
        },

        putAttachmentArtifact: async (artifact) => {
          assertScope({ kind: 'attachment', attachmentId: artifact.attachmentId })
          const table = tx.table<AttachmentArtifact, string>('attachmentArtifacts')
          const existing = await table.get(artifact.artifactId)
          if (existing && stableStringify(existing) === stableStringify(artifact)) return
          await putAttachmentArtifactByteOwner(tx, artifact, existing)
          await bumpAttachmentWireVersion(artifact.attachmentId)
        },

        deleteAttachmentArtifact: async (artifactId) => {
          const table = tx.table<AttachmentArtifact, string>('attachmentArtifacts')
          const existing = await table.get(artifactId)
          if (!existing) return
          assertScope({ kind: 'attachment', attachmentId: existing.attachmentId })
          await deleteAttachmentArtifactByteOwner(tx, artifactId, existing)
          await bumpAttachmentWireVersion(existing.attachmentId)
        },

        putAttachmentJob: async (job, jobOptions) => {
          assertScope({ kind: 'attachment', attachmentId: job.attachmentId })
          const table = tx.table<AttachmentJob, string>('attachmentJobs')
          const existing = await table.get(job.id)
          if (existing && stableStringify(existing) === stableStringify(job)) return
          await putAttachmentJobByteOwner(tx, job, existing)
          if (jobOptions?.affectsWire !== false) {
            await bumpAttachmentWireVersion(job.attachmentId)
          }
        },

        deleteAttachmentJob: async (jobId) => {
          const table = tx.table<AttachmentJob, string>('attachmentJobs')
          const existing = await table.get(jobId)
          if (!existing) return
          assertScope({ kind: 'attachment', attachmentId: existing.attachmentId })
          await deleteAttachmentJobByteOwner(tx, jobId, existing)
          await bumpAttachmentWireVersion(existing.attachmentId)
        },

        getDraft: async (chatId) => {
          if (!draftReads.has(chatId)) {
            const row = await tx.table<DraftRow, ChatId>('drafts').get(chatId)
            receiptAccumulator.physicalRead({
              tableName: 'drafts',
              indexKind: 'primary',
              operation: 'get',
              requestCount: 1,
              rowCount: 1,
            })
            draftReads.set(chatId, row ? cloneDraft(row) : undefined)
          }
          const row = draftReads.get(chatId)
          return row ? cloneDraft(row) : undefined
        },

        putDraft: async (draft, draftOptions) => {
          assertScope({ kind: 'draft', chatId: draft.chatId })
          const existing = await ctx.getDraft(draft.chatId)
          const normalized = cloneDraft(draft)
          if (existing && stableStringify(cloneDraft(existing)) === stableStringify(normalized))
            return
          const attachmentRefsChanged =
            stableStringify(existing?.attachmentRefs ?? []) !==
            stableStringify(normalized.attachmentRefs)
          if (attachmentRefsChanged || draftOptions?.validateAttachmentTargets) {
            await syncAttachmentReferenceOwner({
              ownerKind: 'draft',
              ownerId: normalized.chatId,
              chatId: normalized.chatId,
              previousRefs: existing?.attachmentRefs,
              nextRefs: normalized.attachmentRefs,
              ...(draftOptions?.validateAttachmentTargets
                ? { validateUnchangedTargets: true }
                : {}),
            })
          }
          await putDraftByteOwner(tx, normalized, existing)
          draftReads.set(draft.chatId, normalized)
        },
      }

      const mutationOperations: BrowserMutationOperations = {
        getOwnedStreamLease: (streamId) => {
          if (!ownedStreamLease || ownedStreamLease.streamId !== streamId) {
            throw new Error(`StreamFenceLost:${streamId}`)
          }
          return structuredClone(ownedStreamLease)
        },
        resolveGenerationPromptPath: (chatId, proof) =>
          resolveGenerationPromptPath(tx, chatId, proof),
        captureGenerationPlanningSnapshot: (chatId, intent, planningChat) =>
          captureGenerationPlanningSnapshot(tx, chatId, intent, planningChat),
        setStreamAdmissionPostCommit: (postCommit) => {
          const incoming = options?.streamAdmission
          if (!incoming || admissionSequence === undefined) {
            throw new Error('StreamAdmissionPostCommitWithoutAdmission')
          }
          if (postCommit.final !== undefined) {
            throw new Error(`StreamPostCommitAdmissionInvalid:${incoming.streamId}`)
          }
          if (
            admissionPostCommit &&
            stableStringify(admissionPostCommit) !== stableStringify(postCommit)
          ) {
            throw new Error(`StreamPostCommitAdmissionChanged:${incoming.streamId}`)
          }
          if (
            admissionExistingLease &&
            stableStringify(admissionExistingLease.postCommit) !== stableStringify(postCommit)
          ) {
            throw new Error(`StreamPostCommitAdmissionMismatch:${incoming.streamId}`)
          }
          admissionPostCommit = structuredClone(postCommit)
          admittedTargetLease = requireStreamLeaseRow(
            admissionExistingLease
              ? {
                  ...admissionExistingLease,
                  heartbeatAt: now,
                  replacementEpoch: incoming.replacementEpoch,
                  revision: nextStreamLeaseRevision(admissionExistingLease),
                }
              : {
                  ...incoming,
                  phase: 'reserved',
                  targetOwnerKey: incoming.messageId,
                  postCommit: admissionPostCommit,
                  admissionSequence,
                  revision: 0,
                  controlRevision: 0,
                },
          )
        },
        requestStorageMaintenance: (task) => {
          if (!options?.storageMaintenanceTasks?.includes(task)) {
            throw new Error(`StorageMaintenanceTaskUndeclared:${task}`)
          }
          const dependency = {
            kind: 'storage-maintenance',
            tasks: [task],
          } as const
          recordBrowserCommandInvalidation(tx, dependency)
        },
      }
      const mutationValue = await fn(ctx, mutationOperations)
      if (options?.streamAdmission) {
        if (!admittedTargetLease || !admissionPostCommit) {
          throw new Error(`StreamPostCommitAdmissionMissing:${options.streamAdmission.streamId}`)
        }
        await putStreamLeaseByteOwner(tx, admittedTargetLease, admissionExistingLease)
      }
      const transactionExtensionResult = transactionExtension
        ? await transactionExtension.commit(tx, mutationValue)
        : (undefined as ExtensionResult)

      const structuralProjectionChanges = []
      for (const state of chatStates.values()) {
        for (const [messageId, before] of state.headersBeforeWrites) {
          const current = await readMessageHeader(messageId)
          if (
            before &&
            current &&
            before.parentId === current.parentId &&
            before.siblingIndex === current.siblingIndex &&
            before.deleted === current.deleted &&
            before.createdAt === current.createdAt
          ) {
            continue
          }
          structuralProjectionChanges.push({ messageId, before })
        }
      }
      if (dirtyChildLists.size > 0) {
        const childSlots = await maintainChildSlotProjections(
          tx,
          structuralProjectionChanges,
          dirtyChildLists,
        )
        receiptAccumulator.absorb(childSlots.fragment)
      }
      if (options?.promoteChatId) {
        const state = await ensureChatState(options.promoteChatId)
        const current = materializeChatMutationState(state)
        if (current.temporary === true) {
          state.visibleMetaPatch = { ...state.visibleMetaPatch, temporary: false }
          state.visibleMetaDirty = true
          state.summaryVersionDirty = true
        }
      }

      if (options?.streamTargetCommit) {
        const target = options.streamTargetCommit
        if (!ownedStreamLease) throw new Error(`StreamFenceLost:${target.streamId}`)
        if (
          ownedStreamLease.streamId !== target.streamId ||
          ownedStreamLease.messageId !== target.messageId ||
          ownedStreamLease.attemptKind !== target.attemptKind
        ) {
          throw new Error(`StreamTargetCommitIdentityMismatch:${target.streamId}`)
        }
        const header = await tx.table<MessageHeaderRow, MessageId>('messages').get(target.messageId)
        receiptAccumulator.physicalRead({
          tableName: 'messages',
          indexKind: 'primary',
          operation: 'get',
          requestCount: 1,
          rowCount: header ? 1 : 0,
        })
        if (!header || header.deleted || header.chatId !== ownedStreamLease.chatId) {
          throw new Error(`StreamTargetCommitTargetMissing:${target.streamId}`)
        }
        if (
          target.attemptKind === 'generation' &&
          (header.role !== 'assistant' ||
            !header.generation ||
            header.generation.reasoningCarryForward !== target.reasoningCarryForward ||
            stableStringify(header.generation.reasoningVisibility) !==
              stableStringify(target.reasoningVisibility) ||
            header.generation.finishedAt !== undefined)
        ) {
          throw new Error(`StreamTargetCommitGenerationInvalid:${target.streamId}`)
        }
        if (
          target.attemptKind === 'continuation' &&
          (header.role !== 'assistant' || header.bodyVersion !== target.baseBodyVersion)
        ) {
          throw new Error(`StreamTargetCommitContinuationInvalid:${target.streamId}`)
        }
        if (!Number.isSafeInteger(target.targetCommittedAt) || target.targetCommittedAt < 0) {
          throw new Error(`StreamTargetCommitTimestampInvalid:${target.streamId}`)
        }
        if (!target.apiUsed) throw new Error(`StreamTargetCommitApiMissing:${target.streamId}`)
        const targetDispatch =
          target.attemptKind === 'generation'
            ? {
                targetCommittedAt: target.targetCommittedAt,
                requestedModel: target.requestedModel,
                apiUsed: target.apiUsed,
                reasoningCarryForward: target.reasoningCarryForward,
                reasoningVisibility: target.reasoningVisibility,
              }
            : {
                targetCommittedAt: target.targetCommittedAt,
                requestedModel: target.requestedModel,
                apiUsed: target.apiUsed,
                reasoningCarryForward: target.reasoningCarryForward,
                reasoningVisibility: target.reasoningVisibility,
                continuationStrategy: target.continuationStrategy,
                baseNodeVersion: target.baseNodeVersion,
                baseBodyVersion: target.baseBodyVersion,
              }
        let committed: StreamLeaseRow
        if (ownedStreamLease.phase !== 'reserved') {
          if (
            ownedStreamLease.dispatch === null ||
            stableStringify(ownedStreamLease.dispatch) !== stableStringify(targetDispatch) ||
            stableStringify(ownedStreamLease.postCommit.calibration) !==
              stableStringify(target.postCommitCalibration)
          ) {
            throw new Error(`StreamTargetAlreadyCommitted:${target.streamId}`)
          }
          committed = ownedStreamLease
        } else if (
          target.attemptKind === 'generation' &&
          ownedStreamLease.attemptKind === 'generation'
        ) {
          committed = {
            ...ownedStreamLease,
            phase: 'active',
            dispatch: {
              targetCommittedAt: target.targetCommittedAt,
              requestedModel: target.requestedModel,
              apiUsed: target.apiUsed,
              reasoningCarryForward: target.reasoningCarryForward,
              reasoningVisibility: target.reasoningVisibility,
            },
            revision: nextStreamLeaseRevision(ownedStreamLease),
            postCommit: {
              ...ownedStreamLease.postCommit,
              ...(target.postCommitCalibration
                ? { calibration: structuredClone(target.postCommitCalibration) }
                : {}),
            },
          }
        } else if (
          target.attemptKind === 'continuation' &&
          ownedStreamLease.attemptKind === 'continuation'
        ) {
          committed = {
            ...ownedStreamLease,
            phase: 'active',
            dispatch: {
              targetCommittedAt: target.targetCommittedAt,
              requestedModel: target.requestedModel,
              apiUsed: target.apiUsed,
              reasoningCarryForward: target.reasoningCarryForward,
              reasoningVisibility: target.reasoningVisibility,
              continuationStrategy: target.continuationStrategy,
              baseNodeVersion: target.baseNodeVersion,
              baseBodyVersion: target.baseBodyVersion,
            },
            revision: nextStreamLeaseRevision(ownedStreamLease),
          }
        } else {
          throw new Error(`StreamTargetCommitIdentityMismatch:${target.streamId}`)
        }
        if (committed !== ownedStreamLease) {
          await putStreamLeaseByteOwner(tx, committed, ownedStreamLease)
        }
        committedTargetLease = committed
      }

      if (options?.streamCanonicalCommit) {
        const canonical = options.streamCanonicalCommit
        if (!ownedStreamLease) throw new Error(`StreamFenceLost:${canonical.streamId}`)
        const canonicalAt = canonical.terminal.finishedAt
        if (!Number.isSafeInteger(canonicalAt) || canonicalAt < 0) {
          throw new Error(`StreamCanonicalTimestampInvalid:${canonical.streamId}`)
        }
        const currentLease = committedTargetLease ?? ownedStreamLease
        if (
          (currentLease.phase === 'canonical' || currentLease.phase === 'metadata-committed') &&
          currentLease.canonicalAt !== canonicalAt
        ) {
          throw new Error(`StreamCanonicalTimestampMismatch:${canonical.streamId}`)
        }
        if (
          currentLease.phase !== 'canonical' &&
          currentLease.phase !== 'metadata-committed' &&
          currentLease.phase !== 'terminal-decided'
        ) {
          throw new Error(`StreamCanonicalDecisionMissing:${canonical.streamId}`)
        }
        if (
          currentLease.phase === 'terminal-decided' &&
          stableStringify(currentLease.terminal) !== stableStringify(canonical.terminal)
        ) {
          throw new Error(`AttemptTerminalDecisionConflict:${canonical.streamId}`)
        }
        const canonicalHeader = await tx
          .table<MessageHeaderRow, MessageId>('messages')
          .get(currentLease.messageId)
        const currentPostCommit = requiredStreamPostCommitEvidence(currentLease)
        const terminalKeyId = canonical.postCommitFinal.selectedKeyId
        if (
          currentPostCommit.selectedKeyId !== undefined &&
          terminalKeyId !== undefined &&
          currentPostCommit.selectedKeyId !== terminalKeyId
        ) {
          throw new Error(`StreamPostCommitSelectedKeyMismatch:${canonical.streamId}`)
        }
        const canonicalUsage =
          currentLease.attemptKind === 'generation'
            ? streamPostCommitUsageEvidence(canonicalHeader?.generation?.usage)
            : undefined
        const terminalUsage = canonical.postCommitFinal.usage
        if (
          canonicalUsage !== undefined &&
          terminalUsage !== undefined &&
          stableStringify(canonicalUsage) !== stableStringify(terminalUsage)
        ) {
          throw new Error(`StreamPostCommitUsageMismatch:${canonical.streamId}`)
        }
        const selectedKeyId = currentPostCommit.selectedKeyId ?? terminalKeyId
        const usage = terminalUsage ?? canonicalUsage
        const canonicalBody = messageBodyReads.get(currentLease.messageId)
        const calibrationPlan = currentPostCommit.calibration
        const finalCalibration =
          currentLease.attemptKind === 'generation' &&
          calibrationPlan &&
          canonicalHeader &&
          canonicalBody &&
          canonicalBody.id === canonicalHeader.id &&
          canonicalBody.chatId === canonicalHeader.chatId &&
          canonicalBody.bodyVersion === canonicalHeader.bodyVersion
            ? {
                messageTextChars: messageTextCharCount(canonicalBody.content),
                ...(canonical.postCommitFinal.completionAllowed && usage
                  ? (() => {
                      const completionSample = deriveCompletionSample({
                        assistantMessage: canonicalBody,
                        usage: calibrationUsageFromPostCommit(usage),
                        family: calibrationPlan.family,
                      })
                      return completionSample ? { completionSample } : {}
                    })()
                  : {}),
              }
            : undefined
        const finalEvidence = {
          ...structuredClone(canonical.postCommitFinal),
          ...(selectedKeyId ? { selectedKeyId } : {}),
          ...(usage ? { usage: structuredClone(usage) } : {}),
          ...(finalCalibration ? { calibration: finalCalibration } : {}),
          ...(canonicalHeader
            ? {
                expectedNodeVersion: canonicalHeader.nodeVersion,
                expectedBodyVersion: canonicalHeader.bodyVersion,
              }
            : {}),
        }
        if (
          (currentLease.phase === 'canonical' || currentLease.phase === 'metadata-committed') &&
          stableStringify(currentLease.postCommit.final) !== stableStringify(finalEvidence)
        ) {
          throw new Error(`StreamPostCommitFinalMismatch:${canonical.streamId}`)
        }
        let committed: StreamLeaseRow
        if (currentLease.phase === 'canonical' || currentLease.phase === 'metadata-committed') {
          committed = currentLease
        } else {
          const { targetOwnerKey: _targetOwnerKey, terminal: _terminal, ...decided } = currentLease
          void _targetOwnerKey
          void _terminal
          committed = requireStreamLeaseRow({
            ...decided,
            phase: 'canonical',
            revision: nextStreamLeaseRevision(currentLease),
            canonicalAt,
            postCommit: {
              ...currentPostCommit,
              final: finalEvidence,
            },
          })
        }
        if (stableStringify(committed) !== stableStringify(currentLease)) {
          await putStreamLeaseByteOwner(tx, committed, currentLease)
        }
        committedTargetLease = committed
      }

      const chatVersions: Record<ChatId, ChatVersions> = {}
      const affectedChatIds: ChatId[] = []

      for (const [chatId, state] of chatStates) {
        const current = state.beforeChat
        const next: Chat = {
          ...current,
          ...state.hiddenMetaPatch,
          ...state.visibleMetaPatch,
          structuralVersion: current.structuralVersion + (state.structuralVersionDirty ? 1 : 0),
        }
        if (state.clearModelResolution) delete next.modelResolution

        if (state.visibleMetaDirty) {
          next.metaVersion = current.metaVersion + 1
        }

        if (state.summaryVersionDirty) {
          next.updatedAt = await nextChatUpdatedAtInTransaction(tx, now)
          next.summaryVersion = current.summaryVersion + 1
        }

        if (state.messageSummaryDirty) {
          if (state.structuralSummaryDirty) {
            if (!state.previousBranchIds) {
              throw new Error(`StructuralSummaryContextMissing:${chatId}`)
            }
            const nextLeafId = await newestLiveLeafIdInTransaction(tx, chatId)
            const nextBranchHeaders = await readBranchPathInTransaction(tx, chatId, nextLeafId)
            next.lastUpdatedLeafId = nextLeafId
            next.wordCount = branchHeaderWordCount(nextBranchHeaders)
            next.totalCostUsd = Math.max(0, current.totalCostUsd + state.totalCostDelta)
            const lastBranchUpdatedAtChanged = shouldBumpStructuralLastBranchUpdatedAt(
              state.beforeChat,
              state.previousBranchIds,
              nextLeafId,
              nextBranchHeaders,
              state.changedMessageIds,
            )
            if (lastBranchUpdatedAtChanged) {
              next.lastBranchUpdatedAt = nextBranchUpdatedAt(current.lastBranchUpdatedAt, now)
            }
          } else {
            const fastCurrentLeafTarget = options?.fastCurrentLeafSummaryTarget
            const canApplyCurrentLeafDelta =
              fastCurrentLeafTarget !== undefined &&
              state.incrementalAppends.length === 0 &&
              state.beforeChat.lastUpdatedLeafId === fastCurrentLeafTarget &&
              state.changedMessageIds.size === 1 &&
              state.changedMessageIds.has(fastCurrentLeafTarget)
            if (canApplyCurrentLeafDelta) {
              const wordCountDelta = state.wordCountDeltas.get(fastCurrentLeafTarget) ?? 0
              next.lastUpdatedLeafId = fastCurrentLeafTarget
              next.wordCount = Math.max(0, current.wordCount + wordCountDelta)
              next.totalCostUsd = Math.max(0, current.totalCostUsd + state.totalCostDelta)
            } else if (canApplyIncrementalBranchAppend(state)) {
              const nextLeafId = state.incrementalAppends.at(-1)?.id ?? null
              let wordCountDelta = 0
              for (const delta of state.wordCountDeltas.values()) wordCountDelta += delta
              next.lastUpdatedLeafId = nextLeafId
              next.wordCount = Math.max(0, current.wordCount + wordCountDelta)
              next.totalCostUsd = Math.max(0, current.totalCostUsd + state.totalCostDelta)
              next.lastBranchUpdatedAt = nextBranchUpdatedAt(current.lastBranchUpdatedAt, now)
            } else {
              const nextLeafId =
                state.incrementalAppends.at(-1)?.id ?? state.beforeChat.lastUpdatedLeafId
              const branchHeaders = await readBranchPathInTransaction(tx, chatId, nextLeafId)
              next.lastUpdatedLeafId = nextLeafId
              let wordCountDelta = 0
              const branchIds = new Set(branchHeaders.map((header) => header.id))
              for (const [messageId, delta] of state.wordCountDeltas) {
                if (branchIds.has(messageId)) wordCountDelta += delta
              }
              next.wordCount = Math.max(0, current.wordCount + wordCountDelta)
              next.totalCostUsd = Math.max(0, current.totalCostUsd + state.totalCostDelta)
              const lastBranchUpdatedAtChanged = shouldBumpLastBranchUpdatedAtFromHeaders(
                state.beforeChat,
                nextLeafId,
                branchHeaders,
                state.changedMessageIds,
              )
              if (lastBranchUpdatedAtChanged) {
                next.lastBranchUpdatedAt = nextBranchUpdatedAt(current.lastBranchUpdatedAt, now)
              }
            }
          }
        }

        if (state.branchCorpusDirtyMessageIds.size > 0 && next.lastUpdatedLeafId !== null) {
          const leafIsDirty = state.branchCorpusDirtyMessageIds.has(next.lastUpdatedLeafId)
          const branchIsDirty =
            leafIsDirty ||
            (await readBranchPathInTransaction(tx, chatId, next.lastUpdatedLeafId)).some((header) =>
              state.branchCorpusDirtyMessageIds.has(header.id),
            )
          if (branchIsDirty) {
            next.lastBranchUpdatedAt = nextBranchUpdatedAt(current.lastBranchUpdatedAt, now)
          }
        }

        if (state.previewDirty) {
          next.previewText = await chatPreviewInTransaction(tx, chatId)
        }

        const patched: Chat = next

        const changed = stableStringify(current) !== stableStringify(patched)
        if (changed) {
          if (options?.maintainConfigurationLinksForChatId === chatId) {
            chatMutation.replaceLinked(chatId, () => patched)
          } else {
            chatMutation.replacePreserving(chatId, () => patched)
          }
          affectedChatIds.push(chatId)
        }
        finalizedChats.set(chatId, patched)
        chatVersions[chatId] = {
          metaVersion: patched.metaVersion,
          summaryVersion: patched.summaryVersion,
          structuralVersion: patched.structuralVersion,
        }
      }
      if (affectedChatIds.length > 0 || options?.initialChat) {
        const transition = await chatMutation.commit()
        absorbSemanticOperationReceiptFragment(tx, transition.fragment)
      }

      const finalizationContext: MutationFinalizationContext = Object.freeze({
        getFinalChat: (chatId: ChatId) => {
          const chat = finalizedChats.get(chatId)
          return Promise.resolve(chat ? structuredClone(chat) : undefined)
        },
        getAttachmentCatalogRevision: ctx.getAttachmentCatalogRevision,
        readFinalActiveBranchPathSlotFrame: (
          chatId: ChatId,
          headers: readonly MessageHeaderRow[],
        ) => readActiveBranchPathSlotFrameInTransaction(tx, chatId, headers),
        sealCommittedDestination: (
          input: Parameters<MutationFinalizationContext['sealCommittedDestination']>[0],
        ) =>
          proveConversationSelectionInTransaction(tx, {
            ...input,
            target: fixedConversationSelectionTarget(
              input.tipId === null ? { kind: 'default' } : { kind: 'tip', messageId: input.tipId },
              input.tipId,
            ),
          }),
        sealExactConversationDestination: (
          input: Parameters<MutationFinalizationContext['sealExactConversationDestination']>[0],
        ) => proveConversationSelectionInTransaction(tx, input),
      })
      const value = finalize
        ? await finalize(finalizationContext, mutationValue)
        : (mutationValue as unknown as U)

      const affectedIds = [...affectedMessageIds]
      const affectedMessageHeaders = affectedIds
        .map((messageId) => messageHeaderReads.get(messageId))
        .filter((header): header is MessageHeaderRow => header !== undefined)
        .map(cloneMessageHeader)
      if (affectedMessageHeaders.length !== affectedIds.length) {
        throw new Error('BrowserCommandMessageRevisionFinalHeaderMissing')
      }
      const revisionChatIds = [
        ...new Set(
          affectedMessageHeaders
            .map((header) => header.chatId)
            .filter((chatId) => chatVersions[chatId] === undefined),
        ),
      ]
      if (revisionChatIds.length > 0) {
        const revisionChats = await tx.table<Chat, ChatId>('chats').bulkGet(revisionChatIds)
        receiptAccumulator.physicalRead({
          tableName: 'chats',
          indexKind: 'primary',
          operation: 'get-many',
          requestCount: 1,
          rowCount: revisionChatIds.length,
        })
        for (let index = 0; index < revisionChatIds.length; index += 1) {
          const chatId = revisionChatIds[index] as ChatId
          const chat = revisionChats[index]
          if (!chat) throw new ChatMissingError(chatId)
          chatVersions[chatId] = {
            metaVersion: chat.metaVersion,
            summaryVersion: chat.summaryVersion,
            structuralVersion: chat.structuralVersion,
          }
        }
      }
      const streamTargetLease = committedTargetLease ?? admittedTargetLease
      if (options?.streamAdmission) {
        const admitted = requireWriterReservedStreamLeaseRow(streamTargetLease)
        const expected = options.streamAdmission
        if (
          admitted.streamId !== expected.streamId ||
          admitted.chatId !== expected.chatId ||
          admitted.messageId !== expected.messageId ||
          admitted.attemptKind !== expected.attemptKind ||
          admitted.ownerClientId !== expected.ownerClientId ||
          admitted.fenceToken !== expected.fenceToken ||
          admitted.replacementEpoch !== expected.replacementEpoch
        ) {
          throw new Error(`StreamAdmissionResultMismatch:${expected.streamId}`)
        }
      }
      if (options?.streamTargetCommit) {
        const active = requireWriterActiveStreamLeaseRow(streamTargetLease)
        const expected = options.streamTargetCommit
        if (
          active.streamId !== expected.streamId ||
          active.messageId !== expected.messageId ||
          active.attemptKind !== expected.attemptKind
        ) {
          throw new Error(`StreamTargetCommitResultMismatch:${expected.streamId}`)
        }
      }
      if (options?.streamCanonicalCommit) {
        const canonical = requireStreamLeaseRow(streamTargetLease)
        if (
          canonical.streamId !== options.streamCanonicalCommit.streamId ||
          (canonical.phase !== 'canonical' && canonical.phase !== 'metadata-committed')
        ) {
          throw new Error(
            `StreamCanonicalCommitResultMismatch:${options.streamCanonicalCommit.streamId}`,
          )
        }
      }
      const affectedMessageRevisions: BrowserCommandMessageRevisionFact[] =
        affectedMessageHeaders.map((header) => {
          if (!messageHeadersBeforeWrites.has(header.id)) {
            throw new Error(`BrowserCommandMessageRevisionBeforeMissing:${header.id}`)
          }
          const before = messageHeadersBeforeWrites.get(header.id)
          const body = messageBodyReads.get(header.id)
          const versions = chatVersions[header.chatId]
          if (!versions) {
            throw new Error(`BrowserCommandMessageRevisionChatMissing:${header.id}`)
          }
          return {
            ...(before ? { before: cloneMessageHeader(before) } : {}),
            header,
            structuralVersion: versions.structuralVersion,
            ...(body && body.bodyVersion === header.bodyVersion
              ? {
                  presentation: {
                    header,
                    message: hydrateStoredMessage(header, body),
                    bodyVersion: header.bodyVersion,
                  },
                }
              : {}),
          }
        })
      if (operationPlan.descriptor.exactInvalidations) {
        for (const revision of affectedMessageRevisions) {
          receiptAccumulator.dependency({
            kind: 'message-header',
            chatId: revision.header.chatId,
            messageIds: [revision.header.id],
          })
          if (!revision.before || revision.before.bodyVersion !== revision.header.bodyVersion) {
            receiptAccumulator.dependency(
              {
                kind: 'message-body',
                chatId: revision.header.chatId,
                messageIds: [revision.header.id],
              },
              {
                kind: 'message-preview',
                chatId: revision.header.chatId,
                messageIds: [revision.header.id],
              },
            )
          }
        }
      }
      recordBrowserCommandMessageRevisions(tx, affectedMessageRevisions)

      const exactFacts = receiptAccumulator.snapshotFragment()
      return semanticOperationExecution(
        {
          value,
          transactionExtensionResult,
          affectedChatIds,
          affectedMessageIds: affectedIds,
          chatVersions,
          ...(streamTargetLease ? { streamTargetLease } : {}),
        },
        semanticOperationExactReceipt(operationPlan.exactPlan, {
          ...(operationPlan.replayPlan ? { replay: operationPlan.replayPlan } : {}),
          dependencies: exactFacts.dependencies,
          physicalMutations: exactFacts.physicalMutations,
          physicalReads: exactFacts.physicalReads,
        }),
      )
    },
  )
  return result
}

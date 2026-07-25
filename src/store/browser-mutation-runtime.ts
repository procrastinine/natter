import type { Transaction } from 'dexie'
import { normalizeModelsResponse } from '../api/providers'
import { modelCatalogQueryForConnectionKind, modelsCacheKey } from '../core/cache-keys'
import { sameChatSettings } from '../core/chat-metadata'
import {
  connectionDispatchKeyRefs,
  profileMatchesDispatchProof,
} from '../core/connection-dispatch-proof'
import { assertCanonicalGeneratedOutputMessage } from '../core/generated-output-localization'
import {
  CORS_PROXY_SECRET_KEY,
  CORS_PROXY_URL_KEY,
  GENERATION_GLOBAL_PREFERENCE_KEYS,
  generationCorsProxyConfigFromStored,
  TOKEN_CALIBRATION_MODE_KEY,
  tokenCalibrationModeFromStored,
} from '../core/global-settings'
import { keyDispatchRevisions, keyDispatchRevisionsEqual } from '../core/key-dispatch-proof'
import { messageTreeIndexFields } from '../core/message-tree-index'
import { fixedConversationSelectionTarget } from '../core/messages'
import { tokenCalibrationKey } from '../core/model-ids'
import { pickEquivalentModelId } from '../core/model-selection'
import {
  deriveCompletionSample,
  GLOBAL_TOKEN_CALIBRATION_KEY,
  messageTextCharCount,
  relevantGlobalTokenCalibration,
} from '../core/token-calibration'
import type {
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
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
import {
  ATTACHMENT_CATALOG_AGGREGATE_ID,
  type AttachmentCatalogAggregateRow,
  deleteAttachmentCatalogProjection,
  putAttachmentCatalogProjectionFromHeader,
} from './attachment-catalog-projection'
import {
  applyAttachmentReferenceOwnerTransitions,
  attachmentReferenceCounts,
  edgesForOwner,
  requireNoAttachmentReferences,
} from './attachment-reference-edges'
import { type AttachmentHeaderRow, splitAttachmentForStorage } from './attachment-storage'
import { readActiveBranchForkSlotsForHeadersInTransaction } from './browser-active-branch-spine'
import {
  type BrowserCommandMessageRevisionFact,
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
  createMutationScopeChecker,
  GenerationPlanningSeedChangedError,
  planMutationTransaction,
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
  insertMessageBody,
  putAttachmentArtifactByteOwner,
  putAttachmentBlobByteOwner,
  putAttachmentHeaderByteOwner,
  putAttachmentJobByteOwner,
  putDraftByteOwner,
  putPhysicalStorageRow,
  replaceMessageBody,
} from './byte-owner-mutation'
import { applyChatRowWriteTransitions } from './chat-row-transition'
import { maintainChildSlotProjections } from './child-list-projection'
import {
  configurationRequestRevisionFor,
  configurationRequestRevisionKey,
} from './configuration-domain-contract'
import { proveConversationSelectionInTransaction } from './conversation-destination-seal'
import { childListKey } from './db'
import type { SettingsRow } from './db-rows'
import { readDiscoveryCacheRow } from './discovery-cache-storage'
import { generationAdmissionDecision } from './generation-admission'
import { scopeResourceName } from './locks'
import {
  type MessageBodyRow,
  type MessageHeaderRow,
  type MessageTextPreviewRow,
  projectMessageTextPreview,
  splitMessageForStorage,
  syncMessageHeaderProjections,
} from './message-storage'
import type {
  MessageStructurePatch,
  MutationContext,
  MutationFinalizationContext,
  PatchMessageBodyOptions,
  PutMessageOptions,
  StreamLeaseRow,
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
import { putStreamLeaseByteOwner } from './stream-journal-storage'
import {
  nextChatUpdatedAtInTransaction,
  TransactionMessageCreationClock,
} from './transaction-order'
import type {
  GenerationPlanningSnapshot,
  PrepareAttemptConfigurationClaim,
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
  expected: PrepareAttemptConfigurationClaim,
  planningChat: Chat,
): Promise<GenerationPlanningSnapshot> {
  if (
    !sameChatSettings(planningChat.settings, expected.settings) ||
    (planningChat.presetId ?? null) !== expected.presetId
  ) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
  const profile = await tx
    .table<ConnectionProfile, ProfileId>('profiles')
    .get(planningChat.settings.profileId)
  if (!profile) {
    throw new Error(`GenerationPlanningProfileMissing:${planningChat.settings.profileId}`)
  }
  if (!profileMatchesDispatchProof(profile, expected.profile)) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
  const keyRefs = connectionDispatchKeyRefs(profile)
  const keyRecords = await tx.table<KeyRecord, KeyId>('keys').bulkGet(keyRefs)
  if (
    !keyDispatchRevisionsEqual(
      keyDispatchRevisions(keyRefs, keyRecords),
      expected.dispatchKeyRevisions,
    )
  ) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
  if (
    expected.preferredDispatchKeyId !== null &&
    !keyRefs.includes(expected.preferredDispatchKeyId)
  ) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
  const modelId = planningChat.settings.model
  if (!modelId) throw new Error(`GenerationPlanningModelMissing:${chatId}`)
  const discoveryRevision = configurationRequestRevisionFor(
    profile,
    profile.apiKeyRef ? keyRecords.find((record) => record?.id === profile.apiKeyRef) : undefined,
  )
  if (
    configurationRequestRevisionKey(discoveryRevision) !==
    configurationRequestRevisionKey(expected.requestRevision)
  ) {
    throw new GenerationPlanningSeedChangedError(chatId)
  }
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
  for (const override of expected.workspaceSettingOverrides) {
    if (!GENERATION_GLOBAL_PREFERENCE_KEYS.includes(override.key as never)) {
      throw new Error(`GenerationPlanningSettingOverrideInvalid:${override.key}`)
    }
    settingsByKey.set(override.key, override.value)
  }
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
  return {
    chat: structuredClone(planningChat),
    profile: structuredClone(profile),
    keyRecords: keyRecords.map((record) => (record ? structuredClone(record) : undefined)),
    preferredDispatchKeyId: expected.preferredDispatchKeyId,
    discovery,
    calibration: {
      modelId,
      calibrationKey,
      mode: tokenCalibrationMode,
      chatGeneration: chatTokenCalibrationGeneration(planningChat),
      global: structuredClone(globalCalibration),
    },
    proxy: structuredClone(proxy),
    ...(expected.savedTextTemplate
      ? { savedTextTemplate: structuredClone(expected.savedTextTemplate) }
      : {}),
  }
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
    chatConfigurationTargetResourceNames,
    chatPreviewInTransaction,
    cloneDraft,
    cloneMessage,
    cloneMessageHeader,
    hydrateStoredAttachment,
    hydrateStoredMessage,
    listChildHeaderRows,
    loadChatOrThrow,
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
    recordNewMessageSummary,
    replacementMessageBody,
    requireChatMetadataPatch,
    requiredStreamPostCommitEvidence,
    reserveStreamLeaseTarget,
    shouldBumpLastBranchUpdatedAtFromHeaders,
    shouldBumpStructuralLastBranchUpdatedAt,
    stableStringify,
    streamOwnedMessageFieldsChanged,
    transitionMessageGenerationForDispatch,
    validateGenerationPromptPathClaim,
  } = shared

  let committedTargetLease: StreamLeaseRow | undefined
  let admittedTargetLease: StreamLeaseRow | undefined
  const transactionPlan = planMutationTransaction(scopes, options, transactionExtension?.tableNames)
  if (options?.streamTargetCommit && !options.streamFence) {
    throw new Error(`StreamTargetCommitFenceMissing:${options.streamTargetCommit.streamId}`)
  }
  if (options?.streamAdmissionPostCommit && !options.streamAdmission) {
    throw new Error('StreamAdmissionPostCommitWithoutAdmission')
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
  if (options?.workspaceFence) {
    commandCommit.assertReplacementEpoch(options.workspaceFence.replacementEpoch)
  }
  const lockNames = [
    ...new Set([
      ...scopes.map(scopeResourceName),
      ...scopes.flatMap((scope) =>
        scope.kind === 'children' ? [`message-topology:${scope.chatId}`] : [],
      ),
      ...(options?.additionalLockNames ?? []),
      ...(options?.initialChat ? chatConfigurationTargetResourceNames(options.initialChat) : []),
    ]),
  ]
  const result: WorkspaceMutationResult<U> & {
    readonly transactionExtensionResult: ExtensionResult
  } = await commandCommit.withLocks(lockNames, async (locked) =>
    locked.runTransaction(transactionPlan.transaction, async (transaction) => {
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
      if (transactionPlan.generationReadSet) {
        await validateGenerationReadSetTransaction(tx, transactionPlan.generationReadSet)
      }
      let ownedStreamLease: StreamLeaseRow | undefined
      if (options?.initialChat) {
        const initialChat = structuredClone(options.initialChat)
        const chatTable = tx.table<Chat, ChatId>('chats')
        if (await chatTable.get(initialChat.id)) {
          throw new Error(`AttemptInitialChatAlreadyExists:${initialChat.id}`)
        }
        await applyChatRowWriteTransitions(tx, [{ kind: 'add-linked', next: initialChat }])
      }
      if (options?.streamAdmission) {
        const incoming = options.streamAdmission
        const table = tx.table<StreamLeaseRow, string>('streamLeases')
        const existing = await table.get(incoming.streamId)
        commandCommit.assertReplacementEpoch(incoming.replacementEpoch)
        await assertStreamLeaseWorkspaceTarget(tx, incoming)
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
        const admissionSequence = existing
          ? existing.admissionSequence
          : await reserveStreamLeaseTarget(tx, incoming)
        const postCommit = options.streamAdmissionPostCommit
        if (!postCommit || postCommit.final !== undefined) {
          throw new Error(`StreamPostCommitAdmissionMissing:${incoming.streamId}`)
        }
        if (existing && stableStringify(existing.postCommit) !== stableStringify(postCommit)) {
          throw new Error(`StreamPostCommitAdmissionMismatch:${incoming.streamId}`)
        }
        admittedTargetLease = requireStreamLeaseRow(
          existing
            ? {
                ...existing,
                heartbeatAt: now,
                replacementEpoch: incoming.replacementEpoch,
                revision: nextStreamLeaseRevision(existing),
              }
            : {
                ...incoming,
                phase: 'reserved',
                targetOwnerKey: incoming.messageId,
                postCommit: structuredClone(postCommit),
                admissionSequence,
                revision: 0,
                controlRevision: 0,
              },
        )
        await putStreamLeaseByteOwner(tx, admittedTargetLease, existing)
      }
      if (options?.streamFence) {
        const { streamId, fence } = options.streamFence
        commandCommit.assertReplacementEpoch(fence.replacementEpoch)
        const lease = await tx.table<StreamLeaseRow, string>('streamLeases').get(streamId)
        assertOwnedStreamFence(lease, fence, fence.replacementEpoch, streamId)
        if (options.streamTargetCommit && lease.stopControl) {
          throw new Error(`AttemptDispatchStopped:${streamId}`)
        }
        ownedStreamLease = lease
        if (
          !options.streamTargetCommit &&
          !options.streamCanonicalCommit &&
          !streamLeaseHasCommittedTarget(lease)
        ) {
          throw new Error(`StreamTargetNotCommitted:${streamId}`)
        }
      }
      const { assertScope } = createMutationScopeChecker(scopes)
      const chatStates = new Map<ChatId, ChatMutationState>()
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
        if (stableStringify(previousEdges) === stableStringify(nextEdges)) return
        if (!scopes.some((scope) => scope.kind === 'attachment')) {
          throw new Error(`UndeclaredAttachmentReferenceScope:${input.ownerKind}:${input.ownerId}`)
        }
        await applyAttachmentReferenceOwnerTransitions(tx, [input], now, (attachmentId) =>
          assertScope({ kind: 'attachment', attachmentId }),
        )
      }

      const ensureChatState = async (chatId: ChatId): Promise<ChatMutationState> => {
        const existing = chatStates.get(chatId)
        if (existing) return existing
        const beforeChat = await loadChatOrThrow(tx.table<Chat, ChatId>('chats'), chatId)
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
          scope.kind === 'children' ||
          scope.kind === 'draft'
        ) {
          await ensureChatState(scope.chatId)
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
          messageHeaderReads.set(
            messageId,
            await tx.table<MessageHeaderRow, MessageId>('messages').get(messageId),
          )
        }
        return messageHeaderReads.get(messageId)
      }
      const readMessageBody = async (messageId: MessageId): Promise<MessageBodyRow | undefined> => {
        if (!messageBodyReads.has(messageId)) {
          messageBodyReads.set(
            messageId,
            await tx.table<MessageBodyRow, MessageId>('messageBodies').get(messageId),
          )
        }
        return messageBodyReads.get(messageId)
      }

      const ctx: MutationContext = {
        getChat: async (chatId) => {
          const state = chatStates.get(chatId)
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
          const { touchChatSummary = true, semanticEffect } = options
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
            const comparable = { ...clone, nodeVersion: existing.nodeVersion }
            const comparableSplit = splitMessageForStorage(comparable, {
              bodyVersion: existing.bodyVersion,
              requestContextVersion: existing.requestContextVersion,
              updatedAt: existingBody.updatedAt,
            })
            const headerChanged =
              stableStringify(existing) !== stableStringify(comparableSplit.header)
            const bodyChanged =
              stableStringify(existingBody) !== stableStringify(comparableSplit.body)
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
              messageSummaryChanged = recordMessageSummaryDeltas(
                state,
                clone.id,
                hydrateStoredMessage(existing, existingBody),
                clone,
              )
            }
            recordHeaderBeforeWrite(state, clone.id, existing)
            clone.nodeVersion = existing.nodeVersion + 1
            const requestContextVersion =
              existing.requestContextVersion + (semantics.requestContextChanged ? 1 : 0)
            let header: MessageHeaderRow
            let storage: ReturnType<typeof splitMessageForStorage> | undefined
            if (bodyChanged) {
              storage = splitMessageForStorage(clone, {
                bodyVersion: existing.bodyVersion + 1,
                requestContextVersion,
                updatedAt: now,
              })
              header = storage.header
            } else {
              header = {
                ...comparableSplit.header,
                nodeVersion: clone.nodeVersion,
                requestContextVersion,
                bodyVersion: existing.bodyVersion,
              }
            }
            await syncAttachmentReferenceOwner({
              ownerKind: 'message',
              ownerId: clone.id,
              chatId: clone.chatId,
              previousRefs: existing.attachmentRefs,
              nextRefs: clone.attachmentRefs,
            })
            await putPhysicalStorageRow(tx, 'messages', header, existing)
            if (storage) {
              await replaceMessageBody(tx, storage.body, { kind: 'row', row: existingBody })
              await putPhysicalStorageRow(
                tx,
                'messagePreviews',
                storage.preview,
                await previewTable.get(clone.id),
              )
            }
            messageHeaderReads.set(clone.id, header)
            messageBodyReads.set(clone.id, storage?.body ?? existingBody)
          } else {
            if (!touchChatSummary) {
              throw new Error(`DeferredMessageWriteRequiresExistingRow:${clone.id}`)
            }
            const summaryState = state as ChatMutationState
            summaryState.structuralVersionDirty = true
            clone.createdAt = await messageCreationClock.next(tx, clone.chatId, now)
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
            const { header, body, preview } = splitMessageForStorage(clone, { updatedAt: now })
            recordHeaderBeforeWrite(summaryState, clone.id, undefined)
            await syncAttachmentReferenceOwner({
              ownerKind: 'message',
              ownerId: clone.id,
              chatId: clone.chatId,
              previousRefs: undefined,
              nextRefs: clone.attachmentRefs,
            })
            await addPhysicalStorageRow(tx, 'messages', header)
            await insertMessageBody(tx, body)
            await addPhysicalStorageRow(tx, 'messagePreviews', preview)
            messageHeaderReads.set(clone.id, header)
            messageBodyReads.set(clone.id, body)
            if (clone.role === 'user') summaryState.previewDirty = true
            recordNewMessageSummary(summaryState, clone)
            if (incrementalAppend) {
              summaryState.incrementalAppends.push(clone)
            }
            await bumpChildList(chatId, clone.parentId)
          }

          if (touchChatSummary && state && messageSummaryChanged) {
            state.summaryVersionDirty = true
            state.messageSummaryDirty = true
            state.changedMessageIds.add(clone.id)
          }
          affectedMessageIds.add(clone.id)
          return clone
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
          if (!aggregate) throw new Error('AttachmentCatalogAggregateMissing')
          return aggregate.projectionRevision
        },

        getAttachmentReclamationState: async (attachmentId) => {
          const header = await tx
            .table<AttachmentHeaderRow, AttachmentId>('attachments')
            .get(attachmentId)
          return header
            ? { exists: true, unreferencedAt: header.unreferencedAt }
            : { exists: false, unreferencedAt: null }
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
          await deleteAttachmentByteOwnerBundle(tx, attachmentId, existing)
          await deleteAttachmentHeaderByteOwner(tx, existing)
          await deleteAttachmentCatalogProjection(tx, attachmentId)
          recordBrowserCommandAttachmentReferenceState(tx, {
            attachmentId,
            initial: { exists: true, refCount: existing.refCount },
            final: { exists: false, refCount: 0 },
            projectionChanged: true,
          })
        },

        countAttachmentReferences: async (attachmentId) =>
          attachmentReferenceCounts(tx, attachmentId),

        getAttachmentReferenceEdges: async (attachmentId) =>
          tx
            .table<AttachmentReferenceEdge>('attachmentRefEdges')
            .where('attachmentId')
            .equals(attachmentId)
            .toArray(),

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
          const row = await tx.table<DraftRow, ChatId>('drafts').get(chatId)
          return row ? cloneDraft(row) : undefined
        },

        putDraft: async (draft) => {
          assertScope({ kind: 'draft', chatId: draft.chatId })
          await ensureChatState(draft.chatId)
          const table = tx.table<DraftRow, ChatId>('drafts')
          const existing = await table.get(draft.chatId)
          const normalized = cloneDraft(draft)
          if (existing && stableStringify(cloneDraft(existing)) === stableStringify(normalized))
            return
          if (
            stableStringify(existing?.attachmentRefs ?? []) !==
            stableStringify(normalized.attachmentRefs)
          ) {
            await syncAttachmentReferenceOwner({
              ownerKind: 'draft',
              ownerId: normalized.chatId,
              chatId: normalized.chatId,
              previousRefs: existing?.attachmentRefs,
              nextRefs: normalized.attachmentRefs,
            })
          }
          await putDraftByteOwner(tx, normalized, existing)
        },
      }

      const mutationOperations: BrowserMutationOperations = {
        validateGenerationPromptPathClaim: (chatId, claim) =>
          validateGenerationPromptPathClaim(tx, chatId, claim),
        captureGenerationPlanningSnapshot: (chatId, expected, planningChat) =>
          captureGenerationPlanningSnapshot(tx, chatId, expected, planningChat),
        requestStorageMaintenance: (task) =>
          recordBrowserCommandInvalidation(tx, {
            kind: 'storage-maintenance',
            tasks: [task],
          }),
      }
      const mutationValue = await fn(ctx, mutationOperations)
      const transactionExtensionResult = transactionExtension
        ? await transactionExtension.commit(tx, mutationValue)
        : (undefined as ExtensionResult)

      const structuralProjectionChanges = []
      for (const state of chatStates.values()) {
        for (const [messageId, before] of state.headersBeforeWrites) {
          const current = await tx.table<MessageHeaderRow, MessageId>('messages').get(messageId)
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
        await maintainChildSlotProjections(tx, structuralProjectionChanges, dirtyChildLists)
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
        const chatTable = tx.table<Chat, ChatId>('chats')
        const current = await chatTable.get(chatId)
        if (!current) throw new ChatMissingError(chatId)
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
          await applyChatRowWriteTransitions(tx, [
            { kind: 'replace-preserving-links', previous: current, next: patched },
          ])
          affectedChatIds.push(chatId)
        }
        finalizedChats.set(chatId, patched)
        chatVersions[chatId] = {
          metaVersion: patched.metaVersion,
          summaryVersion: patched.summaryVersion,
          structuralVersion: patched.structuralVersion,
        }
      }

      const finalizationContext: MutationFinalizationContext = Object.freeze({
        getFinalChat: (chatId: ChatId) => {
          const chat = finalizedChats.get(chatId)
          return Promise.resolve(chat ? structuredClone(chat) : undefined)
        },
        getAttachmentCatalogRevision: ctx.getAttachmentCatalogRevision,
        readFinalActiveBranchForks: (headers: readonly MessageHeaderRow[]) =>
          readActiveBranchForkSlotsForHeadersInTransaction(tx, headers),
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
      const affectedMessageHeaders =
        affectedIds.length === 0
          ? []
          : (await tx.table<MessageHeaderRow, MessageId>('messages').bulkGet(affectedIds))
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
      recordBrowserCommandMessageRevisions(tx, affectedMessageRevisions)

      return {
        value,
        transactionExtensionResult,
        affectedChatIds,
        affectedMessageIds: affectedIds,
        chatVersions,
        ...(streamTargetLease ? { streamTargetLease } : {}),
      }
    }),
  )
  return result
}

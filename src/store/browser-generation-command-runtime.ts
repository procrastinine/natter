import Dexie from 'dexie'
import type { ActiveBranchIntentTarget } from '../core/active-branch-spine'
import { applyChatSettingsPatch, sameChatSettings } from '../core/chat-metadata'
import {
  appendContinuationText,
  appendedContinuationSemanticEffect,
  createAppliedMessageView,
} from '../core/continuation-content'
import { contentHasUnmaterializedGeneratedOutput } from '../core/generated-output-localization'
import {
  advanceRecentModelState,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
  TOKEN_CALIBRATION_MODE_KEY,
  tokenCalibrationModeFromStored,
} from '../core/global-settings'
import { fixedConversationSelectionTarget } from '../core/messages'
import { tokenCalibrationKey } from '../core/model-ids'
import { UNKNOWN_INBOUND_REASONING_VISIBILITY } from '../core/reasoning'
import {
  addSampleToChat,
  applyAcceptedSamplesToGlobalRecord,
  calibrationFieldsForCreateFromTextCharCount,
  calibrationFieldsForEdit,
  derivePromptSampleFromBasis,
  GLOBAL_TOKEN_CALIBRATION_KEY,
  normalizeGlobalTokenCalibration,
  tokenCalibrationClearGeneration,
} from '../core/token-calibration'
import type {
  AttachmentId,
  Chat,
  ChatPreset,
  ChatVersions,
  ConnectionProfile,
  KeyId,
  KeyRecord,
  Message,
  MessageId,
  MutationScope,
  PresetId,
  ProfileId,
} from '../core/types'
import { newId } from '../lib/ulid'
import {
  type BrowserCommandMessageRevisionFact,
  recordBrowserCommandMessageRevisions,
} from './browser-command-mutation-journal'
import type {
  BrowserGenerationCommandPort,
  BrowserGenerationCommandSupport,
  BrowserMutationCommandPort,
} from './browser-domain-mutations'
import {
  putPhysicalStorageRow,
  putTokenCalibrationSettingByteOwner,
  putUserSettingByteOwners,
  replaceLinkedSemanticByteOwner,
  replaceSemanticByteOwner,
} from './byte-owner-mutation'
import {
  CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY,
  openPreservingChatMutation,
} from './chat-row-transition'
import {
  CONFIGURATION_PRESET_RECENCY_TRANSACTION_CAPABILITY,
  CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY,
  putConfigurationPresetRecencyCatalogProjection,
  putConfigurationProfileCatalogProjection,
} from './configuration-catalog-projection'
import type { SettingsRow } from './db-rows'
import type { MessageHeaderRow } from './message-storage'
import {
  type CapabilityTables,
  type FencedTransaction,
  physicalStorageTables,
} from './physical-storage-tables'
import {
  ChatMissingError,
  commitStreamLeaseMetadata,
  type MessageCalibrationPatch,
  type StreamLeaseRow,
  type StreamTargetCommit,
  streamLeaseReasoningCarryForward,
  streamLeaseReasoningVisibility,
  streamPostCommitUsageEvidence,
  WorkspaceReplacementFenceError,
  type WriterActiveStreamLeaseRow,
  type WriterReservedStreamLeaseRow,
} from './repository'
import {
  boundSemanticOperationExactReceiptAccumulator,
  type SemanticOperationExactPhysicalRead,
  type SemanticOperationExactReceipt,
  type SemanticOperationReplayPlan,
  semanticOperationDescriptor,
  semanticOperationExactPlan,
  semanticOperationExactReceipt,
  semanticOperationExactReceiptContracts,
  semanticOperationExactReceiptReplayContract,
  semanticOperationExecution,
} from './semantic-operation-capability'
import {
  putStreamLeaseByteOwner,
  STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY,
} from './stream-journal-storage'
import {
  type AttemptDispatchInput,
  type AttemptDispatchResult,
  type AttemptFinalizeResult,
  type AttemptPrepareResult,
  type AttemptTerminalProjection,
  type GenerationPostCommitMetadataInput,
  type GenerationPostCommitMetadataResult,
  generationPostCommitMetadataResourceProof,
  type MessagePresentation,
  type PrepareAttemptInput,
} from './workspace-protocol'

const GENERATION_METADATA_TRANSACTION_CAPABILITY = physicalStorageTables(
  ...CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY.tableNames,
  ...CONFIGURATION_PRESET_RECENCY_TRANSACTION_CAPABILITY.tableNames,
  ...STREAM_LEASE_MUTATION_TRANSACTION_CAPABILITY.tableNames,
  ...CHAT_ROW_PRESERVING_LINKS_TRANSACTION_CAPABILITY.tableNames,
  'keys',
  'messages',
  'presets',
  'profiles',
  'settings',
)
type GenerationMetadataTable = CapabilityTables<typeof GENERATION_METADATA_TRANSACTION_CAPABILITY>

function generationMetadataReplayPlan(
  input: GenerationPostCommitMetadataInput,
): SemanticOperationReplayPlan {
  return {
    kind: 'fenced-convergent',
    owner: `stream:${input.streamId}`,
    fence: [
      input.fence.ownerClientId,
      input.fence.fenceToken,
      input.fence.replacementEpoch,
      input.fence.admissionSequence,
    ],
    desired: [
      'metadata-committed',
      input.resourceProof.chatId,
      input.resourceProof.messageId,
      input.resourceProof.profileId,
      input.resourceProof.presetId ?? null,
      input.resourceProof.selectedKeyId ?? null,
      ...input.resourceProof.settingKeys,
    ],
    alreadyApplied: 'return-current-or-conflict',
  }
}

function generationMetadataExactPlan(input: GenerationPostCommitMetadataInput) {
  return semanticOperationExactPlan({
    replay: generationMetadataReplayPlan(input),
    bounds: {
      reads: {
        maxRequests: 14,
        maxRows: 14,
        maxBatchRows: 1,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
      writes: {
        maxRequests: 13,
        maxRows: 14,
        maxBatchRows: 2,
        maxBytes: Number.MAX_SAFE_INTEGER,
      },
    },
  })
}

function recordGenerationMetadataPrimaryRead(
  reads: Array<SemanticOperationExactPhysicalRead & { tableName: GenerationMetadataTable }>,
  tableName: GenerationMetadataTable,
  requestCount = 1,
): void {
  if (requestCount === 0) return
  const existing = reads.find(
    (read) =>
      read.tableName === tableName &&
      read.indexKind === 'primary' &&
      read.operation === 'get' &&
      read.indexName === undefined,
  )
  if (existing) {
    const index = reads.indexOf(existing)
    reads[index] = {
      ...existing,
      requestCount: existing.requestCount + requestCount,
      rowCount: existing.rowCount + requestCount,
    }
    return
  }
  reads.push({
    tableName,
    indexKind: 'primary',
    operation: 'get',
    requestCount,
    rowCount: requestCount,
  })
}

function generationMetadataExactReceipt(
  tx: FencedTransaction<GenerationMetadataTable>,
  input: GenerationPostCommitMetadataInput,
  physicalReads: readonly (SemanticOperationExactPhysicalRead & {
    tableName: GenerationMetadataTable
  })[],
): SemanticOperationExactReceipt<GenerationMetadataTable> {
  const accumulator = boundSemanticOperationExactReceiptAccumulator<GenerationMetadataTable>(tx)
  if (!accumulator) throw new Error('GenerationMetadataExactReceiptAccumulatorMissing')
  const fragment = accumulator.snapshotFragment()
  return semanticOperationExactReceipt(generationMetadataExactPlan(input), {
    dependencies: fragment.dependencies,
    physicalMutations: fragment.physicalMutations,
    physicalReads: [...fragment.physicalReads, ...physicalReads],
  })
}

const GENERATION_METADATA_OPERATION = semanticOperationDescriptor({
  operationKind: 'generation.post-commit-metadata',
  transaction: GENERATION_METADATA_TRANSACTION_CAPABILITY,
  resources: (input: GenerationPostCommitMetadataInput) => [
    `stream-journal:${input.streamId}`,
    `chat-meta:${input.resourceProof.chatId}`,
    `message:${input.resourceProof.messageId}`,
    `profile:${input.resourceProof.profileId}`,
    ...(input.resourceProof.presetId ? [`preset:${input.resourceProof.presetId}`] : []),
    ...(input.resourceProof.selectedKeyId ? [`key:${input.resourceProof.selectedKeyId}`] : []),
    ...input.resourceProof.settingKeys.map((key) => `setting:${key}`),
  ],
  permittedWrites: GENERATION_METADATA_TRANSACTION_CAPABILITY.tableNames,
  requiredWritesWhenMutated: ['streamLeases'],
  ...semanticOperationExactReceiptContracts<
    GenerationPostCommitMetadataInput,
    GenerationMetadataTable
  >(),
  replay: semanticOperationExactReceiptReplayContract(generationMetadataReplayPlan),
})

export async function prepareBrowserAttempt(
  repository: BrowserGenerationCommandPort,
  support: BrowserGenerationCommandSupport,
  input: PrepareAttemptInput,
  replacementEpoch: number,
  commit: BrowserMutationCommandPort,
): Promise<AttemptPrepareResult> {
  const {
    appendValidatedGenerationPromptPath,
    assertNewChatAttemptRow,
    preparedGenerationPrompt,
    requiredPromptPathTarget,
    resolveGenerationPromptPathProof,
  } = support
  const requirement = input.promptPath.requirement
  if (
    requirement.kind !== input.strategy ||
    (input.strategy === 'new-chat-send'
      ? requirement.surface !== 'new-chat'
      : requirement.surface !== 'chat' || requirement.chatId !== input.lease.chatId)
  ) {
    throw new Error(`AttemptPromptPathRequirementMismatch:${input.lease.streamId}`)
  }
  const placement = input.strategy === 'continue' ? undefined : input.placement
  const userIntent = placement?.user
  const targetMessageId =
    requirement.kind === 'send'
      ? generationIntentTargetMessageId(requirement.target)
      : requirement.target.kind === 'root'
        ? undefined
        : requirement.target.messageId
  const assistantId = placement?.assistantMessageId ?? targetMessageId
  if (!assistantId) throw new Error(`AttemptAssistantTargetMissing:${input.lease.streamId}`)
  if (input.lease.messageId !== assistantId) {
    throw new Error(`AttemptLeaseTargetMismatch:${input.lease.streamId}:${assistantId}`)
  }
  if (input.lease.replacementEpoch !== replacementEpoch) {
    throw new WorkspaceReplacementFenceError()
  }
  const chatId = input.lease.chatId
  if (input.strategy === 'new-chat-send') assertNewChatAttemptRow(input.chat, chatId)
  const attachmentIds = new Set<AttachmentId>()
  for (const ref of userIntent?.attachmentRefs ?? []) attachmentIds.add(ref.attachmentId)
  const scopes: MutationScope[] = [
    { kind: 'chat-meta', chatId },
    {
      kind: 'message',
      messageId: assistantId,
      ...(input.strategy === 'continue' ? {} : { access: 'create' as const }),
    },
    ...[...attachmentIds].map((attachmentId) => ({
      kind: 'attachment' as const,
      attachmentId,
    })),
  ]
  if (userIntent) {
    scopes.push({ kind: 'message', messageId: userIntent.messageId, access: 'create' })
  }
  if (input.strategy !== 'continue') scopes.push({ kind: 'chat-topology', chatId })
  if (targetMessageId) scopes.push({ kind: 'message', messageId: targetMessageId })
  const mutation = await repository.runMutation(
    scopes,
    async (ctx, mutation) => {
      const currentChat = await ctx.getChat(chatId)
      if (!currentChat) throw new ChatMissingError(chatId)
      const validatedPromptPath = await mutation.resolveGenerationPromptPath(
        chatId,
        input.promptPath,
      )
      const promptPath = await resolveGenerationPromptPathProof(
        ctx,
        chatId,
        input.promptPath,
        validatedPromptPath,
      )
      const settingsPatch =
        input.strategy === 'regenerate' ? input.configurationIntent.settingsPatch : undefined
      const attemptSettings = settingsPatch
        ? applyChatSettingsPatch(currentChat.settings, settingsPatch)
        : currentChat.settings
      const planningChat: Chat = {
        ...currentChat,
        settings: structuredClone(attemptSettings),
      }
      const selectionBase = Object.freeze({
        chatId,
        structuralVersion: currentChat.structuralVersion,
        tipId: promptPath.leafId,
      })
      if (settingsPatch) {
        delete planningChat.modelResolution
        const nextSettings = attemptSettings
        if (
          !sameChatSettings(currentChat.settings, nextSettings) ||
          currentChat.modelResolution !== undefined
        ) {
          const nextConfigurationVersion = (currentChat.configurationVersion ?? 0) + 1
          const nextChat: Chat = {
            ...currentChat,
            settings: structuredClone(nextSettings),
            configurationVersion: nextConfigurationVersion,
          }
          delete nextChat.modelResolution
          ctx.patchChatMeta(
            chatId,
            {
              settings: nextChat.settings,
              configurationVersion: nextConfigurationVersion,
            },
            { clearModelResolution: true },
          )
        }
      }
      mutation.setStreamAdmissionPostCommit({
        usedAt: input.lease.startedAt,
        profileId: attemptSettings.profileId,
        ...(planningChat.presetId ? { presetId: planningChat.presetId } : {}),
        ...(input.strategy === 'new-chat-send' || input.strategy === 'send'
          ? { recentModelId: attemptSettings.model }
          : {}),
      })
      if (input.strategy === 'continue') {
        const header = requiredPromptPathTarget(promptPath, chatId)
        if (header.deleted || header.role !== 'assistant') {
          throw new Error(`GenerationContinuationTargetUnavailable:${header.id}`)
        }
        const planning = await mutation.captureGenerationPlanningSnapshot(
          chatId,
          input.configurationIntent,
          planningChat,
        )
        const prompt = preparedGenerationPrompt(
          header.id,
          promptPath.headers,
          promptPath.messageProofs,
          [],
        )
        return {
          strategy: 'continue' as const,
          assistantHeader: header,
          prompt,
          planning,
          continuationBase: {
            streamId: input.lease.streamId,
            messageId: header.id,
            baseNodeVersion: header.nodeVersion,
            baseBodyVersion: header.bodyVersion,
          },
        }
      }

      if (!placement) {
        throw new Error(`AttemptPlacementMissing:${input.lease.streamId}`)
      }
      if (placement.chatId !== chatId || placement.createdAt !== input.lease.startedAt) {
        throw new Error(`AttemptPlacementIdentityMismatch:${input.lease.streamId}`)
      }
      if (await ctx.getMessageHeader(placement.assistantMessageId)) {
        throw new Error(`AttemptAssistantAlreadyExists:${placement.assistantMessageId}`)
      }
      if (userIntent && (await ctx.getMessageHeader(userIntent.messageId))) {
        throw new Error(`AttemptUserAlreadyExists:${userIntent.messageId}`)
      }
      if (
        input.strategy === 'edit-resend' ||
        input.strategy === 'reply' ||
        input.strategy === 'regenerate'
      ) {
        requiredPromptPathTarget(promptPath, chatId)
      }
      const slot = promptPath.slot
      if (!slot) throw new Error(`AttemptPlacementSlotMissing:${input.lease.streamId}`)
      const replyTarget =
        input.strategy === 'reply' ? requiredPromptPathTarget(promptPath, chatId) : undefined
      const turnId = replyTarget?.turnId ?? newId()
      const rebasedUser: Message | undefined = userIntent
        ? {
            id: userIntent.messageId,
            chatId,
            parentId: promptPath.leafId,
            siblingIndex: slot.nextSiblingIndex,
            turnId,
            turnIndex: 0,
            createdAt: placement.createdAt,
            role: 'user',
            origin: 'user',
            content: structuredClone([...userIntent.content]),
            attachmentRefs: structuredClone([...userIntent.attachmentRefs]),
            nodeVersion: 0,
            deleted: false,
          }
        : undefined
      const rebasedAssistant: Message = {
        id: placement.assistantMessageId,
        chatId,
        parentId: rebasedUser?.id ?? promptPath.leafId,
        siblingIndex: rebasedUser ? 0 : slot.nextSiblingIndex,
        turnId,
        turnIndex: rebasedUser ? 1 : replyTarget ? replyTarget.turnIndex + 1 : 0,
        createdAt: placement.createdAt,
        role: 'assistant',
        origin: 'generated',
        content: structuredClone([...placement.prefillContent]),
        attachmentRefs: [],
        generation: {
          model: attemptSettings.model,
          requestedModel: attemptSettings.model,
          status: 'preparing',
          integrity: 'clean',
          costSource: 'stream',
          startedAt: placement.createdAt,
          reasoningCarryForward: 'none',
          reasoningVisibility: UNKNOWN_INBOUND_REASONING_VISIBILITY,
        },
        nodeVersion: 0,
        deleted: false,
      }
      if (rebasedUser) {
        support.assertPreparedAttemptMessage(rebasedUser, input.lease, 'user', 'user')
      }
      support.assertPreparedAttemptMessage(rebasedAssistant, input.lease, 'assistant', 'generated')
      const committedUser = rebasedUser
        ? await ctx.putMessage(rebasedUser, { creationTimestamp: 'preserve' })
        : undefined
      const committedAssistant = await ctx.putMessage(rebasedAssistant, {
        creationTimestamp: 'preserve',
      })
      const headers = await ctx.getMessageHeaders(
        committedUser ? [committedUser.id, rebasedAssistant.id] : [rebasedAssistant.id],
      )
      if (headers.some((header) => !header)) {
        throw new Error(`AttemptPreparedHeaderMissing:${input.lease.streamId}`)
      }
      const committedUserHeader = committedUser
        ? headers.find((header) => header?.id === committedUser.id)
        : undefined
      if (committedUser && !committedUserHeader) {
        throw new Error(`AttemptPreparedHeaderMissing:${committedUser.id}`)
      }
      const planningPath = committedUserHeader
        ? appendValidatedGenerationPromptPath(promptPath, committedUserHeader)
        : promptPath
      const planningLeafId = committedUserHeader?.id ?? rebasedAssistant.parentId
      const committedAssistantHeader = headers.find(
        (header) => header?.id === committedAssistant.id,
      )
      if (!committedAssistantHeader) {
        throw new Error(`AttemptPreparedHeaderMissing:${committedAssistant.id}`)
      }
      const prompt = preparedGenerationPrompt(
        planningLeafId,
        planningPath.headers,
        planningPath.messageProofs,
        committedUser && committedUserHeader
          ? [
              {
                header: committedUserHeader,
                message: committedUser,
                bodyVersion: committedUserHeader.bodyVersion,
              },
            ]
          : [],
      )
      const planning = await mutation.captureGenerationPlanningSnapshot(
        chatId,
        input.configurationIntent,
        planningChat,
      )
      return {
        strategy: input.strategy,
        ...(committedUser ? { user: committedUser } : {}),
        assistant: committedAssistant,
        ...(committedUserHeader ? { userHeader: committedUserHeader } : {}),
        assistantHeader: committedAssistantHeader,
        prompt,
        headers: headers as MessageHeaderRow[],
        planning,
        selectionBase,
      }
    },
    {
      ...(input.strategy === 'new-chat-send' ? { initialChat: input.chat } : {}),
      captureGenerationPlanningSnapshot: true,
      ...(input.strategy === 'regenerate' && input.configurationIntent.settingsPatch
        ? { maintainConfigurationLinksForChatId: chatId }
        : {}),
      promoteChatId: chatId,
      workspaceFence: { replacementEpoch },
      streamAdmission: input.lease,
    },
    commit,
    async (ctx, value) => {
      if (value.strategy === 'continue') return value
      const committedChat = await ctx.getFinalChat(chatId)
      if (!committedChat) throw new ChatMissingError(chatId)
      const messages = [value.user, value.assistant].filter(
        (message): message is Message => message !== undefined,
      )
      const messagesById = new Map(messages.map((message) => [message.id, message]))
      const knownPresentations = value.headers.flatMap((header) => {
        const message = messagesById.get(header.id)
        return message
          ? [
              {
                header,
                message,
                bodyVersion: header.bodyVersion,
              } satisfies MessagePresentation,
            ]
          : []
      })
      const assistantHeader = value.headers.find((header) => header.id === value.assistant.id)
      if (!assistantHeader) {
        throw new Error(`AttemptPreparedHeaderMissing:${value.assistant.id}`)
      }
      const target = fixedConversationSelectionTarget(
        { kind: 'tip', messageId: value.assistant.id },
        value.assistant.id,
      )
      const pathSlotFrame = await ctx.readFinalActiveBranchPathSlotFrame(chatId, value.headers)
      const selectionTransition = Object.freeze({
        kind: 'append-transition' as const,
        chat: committedChat,
        target,
        proof: Object.freeze({
          chatId,
          structuralVersion: committedChat.structuralVersion,
          tipId: value.assistant.id,
        }),
        base: value.selectionBase,
        suffixHeaders: Object.freeze(value.headers),
        forks: pathSlotFrame.forks,
        terminalChildSlot: pathSlotFrame.terminalChildSlot,
        presentations: Object.freeze(knownPresentations),
        fallback: Object.freeze({
          prefixHeaders: value.prompt.headers,
          finalHeader: assistantHeader,
        }),
      })
      return {
        ...value,
        selectionTransition,
      }
    },
  )
  const preparedLease = mutation.streamTargetLease as WriterReservedStreamLeaseRow
  if (mutation.value.strategy === 'continue') {
    const lease = preparedLease as Extract<
      WriterReservedStreamLeaseRow,
      { attemptKind: 'continuation' }
    >
    return {
      strategy: 'continue',
      lease,
      assistantHeader: mutation.value.assistantHeader,
      prompt: mutation.value.prompt,
      planning: mutation.value.planning,
      continuationBase: mutation.value.continuationBase,
    }
  }
  const lease = preparedLease as Extract<
    WriterReservedStreamLeaseRow,
    { attemptKind: 'generation' }
  >
  return {
    strategy: mutation.value.strategy,
    lease,
    ...('user' in mutation.value ? { user: mutation.value.user } : {}),
    assistant: mutation.value.assistant,
    ...('userHeader' in mutation.value ? { userHeader: mutation.value.userHeader } : {}),
    assistantHeader: mutation.value.assistantHeader,
    prompt: mutation.value.prompt,
    planning: mutation.value.planning,
    selectionTransition: mutation.value.selectionTransition,
  }
}

function generationIntentTargetMessageId(target: ActiveBranchIntentTarget): MessageId | undefined {
  if (target.kind === 'fixed') return target.messageId ?? undefined
  const selection = target.selection
  switch (selection.kind) {
    case 'default':
      return undefined
    case 'tip':
      return selection.messageId
    case 'message':
      return selection.observedTipId ?? selection.messageId
    case 'sibling-position':
      return selection.observedTipId
  }
}

export async function dispatchBrowserAttempt(
  repository: BrowserGenerationCommandPort,
  input: AttemptDispatchInput,
  replacementEpoch: number,
  commit: BrowserMutationCommandPort,
): Promise<AttemptDispatchResult> {
  if (input.target.attemptKind === 'continuation' && !input.continuation) {
    throw new Error(`ContinuationDispatchMetadataMissing:${input.streamId}`)
  }
  if (input.target.attemptKind === 'generation' && input.continuation) {
    throw new Error(`GenerationDispatchHasContinuationMetadata:${input.streamId}`)
  }
  if (input.target.attemptKind === 'continuation' && input.postCommitCalibration) {
    throw new Error(`ContinuationDispatchHasCalibration:${input.streamId}`)
  }
  if (
    input.postCommitCalibration &&
    input.postCommitCalibration.modelId !== input.generation.model
  ) {
    throw new Error(`GenerationDispatchCalibrationModelMismatch:${input.streamId}`)
  }
  const continuationProof = input.continuation?.prepareProof
  if (
    continuationProof &&
    (continuationProof.streamId !== input.streamId ||
      continuationProof.messageId !== input.target.messageId)
  ) {
    throw new Error(`ContinuationPrepareProofMismatch:${input.streamId}`)
  }
  const streamTargetCommit: StreamTargetCommit = input.continuation
    ? {
        streamId: input.streamId,
        messageId: input.target.messageId,
        attemptKind: 'continuation',
        targetCommittedAt: input.dispatchedAt,
        requestedModel: input.generation.requestedModel,
        apiUsed: input.generation.apiUsed,
        reasoningCarryForward: input.generation.reasoningCarryForward,
        reasoningVisibility: input.generation.reasoningVisibility,
        continuationStrategy: input.continuation.strategy,
        baseNodeVersion: input.continuation.prepareProof.baseNodeVersion,
        baseBodyVersion: input.continuation.prepareProof.baseBodyVersion,
      }
    : {
        streamId: input.streamId,
        messageId: input.target.messageId,
        attemptKind: 'generation',
        targetCommittedAt: input.dispatchedAt,
        requestedModel: input.generation.requestedModel,
        apiUsed: input.generation.apiUsed,
        reasoningCarryForward: input.generation.reasoningCarryForward,
        reasoningVisibility: input.generation.reasoningVisibility,
        ...(input.postCommitCalibration
          ? { postCommitCalibration: input.postCommitCalibration }
          : {}),
      }
  const mutation = await repository.runMutation(
    [{ kind: 'message', messageId: input.target.messageId }],
    async (ctx) => {
      if (input.continuation) {
        const target = await ctx.getMessageHeader(input.target.messageId)
        if (!target || target.bodyVersion !== input.continuation.prepareProof.baseBodyVersion) {
          throw new Error(`ContinuationTargetChanged:${input.target.messageId}`)
        }
      }
      const header =
        input.target.attemptKind === 'generation'
          ? await ctx.transitionMessageGenerationForDispatch(
              input.target.messageId,
              input.generation,
            )
          : await ctx.getMessageHeader(input.target.messageId)
      if (!header) throw new Error(`AttemptDispatchTargetMissing:${input.target.messageId}`)
      return header
    },
    {
      workspaceFence: { replacementEpoch },
      generationReadSet: input.readSet,
      streamFence: { streamId: input.streamId, fence: input.fence },
      streamTargetCommit,
    },
    commit,
  )
  return {
    lease: mutation.streamTargetLease as WriterActiveStreamLeaseRow,
    header: mutation.value,
  }
}

export async function finalizeBrowserAttempt(
  repository: BrowserGenerationCommandPort,
  support: BrowserGenerationCommandSupport,
  input: AttemptTerminalProjection,
  replacementEpoch: number,
  commit: BrowserMutationCommandPort,
): Promise<AttemptFinalizeResult> {
  const {
    continuationGlobalCalibration,
    dedupeMutationScopes,
    persistPreparedAttachmentBundleInMutation,
    preparedAttachmentIdentityMatches,
    stableStringify,
  } = support
  if (
    input.kind === 'generation' &&
    contentHasUnmaterializedGeneratedOutput(input.generatedOutput?.content ?? input.body.content)
  ) {
    throw new Error(`AttemptFinalizeGeneratedOutputNotCanonical:${input.messageId}`)
  }
  const generatedAttachmentIds =
    input.kind === 'generation'
      ? (input.generatedOutput?.attachmentBundles.map((bundle) => bundle.attachment.id) ?? [])
      : []
  const mutation = await repository.runMutation(
    dedupeMutationScopes([
      { kind: 'chat-meta', chatId: input.chatId },
      { kind: 'message', messageId: input.messageId },
      ...generatedAttachmentIds.map((attachmentId) => ({
        kind: 'attachment' as const,
        attachmentId,
      })),
    ]),
    async (ctx, operations) => {
      const lease = operations.getOwnedStreamLease(input.streamId)
      if (
        lease.chatId !== input.chatId ||
        lease.messageId !== input.messageId ||
        lease.attemptKind !== input.kind
      ) {
        throw new Error(`AttemptFinalizeIdentityMismatch:${input.streamId}`)
      }
      if (
        lease.phase !== 'terminal-decided' &&
        lease.phase !== 'canonical' &&
        lease.phase !== 'metadata-committed'
      ) {
        throw new Error(`AttemptFinalizeBeforeTerminalDecision:${input.streamId}`)
      }
      if (
        lease.phase === 'terminal-decided' &&
        stableStringify(lease.terminal) !== stableStringify(input.terminal)
      ) {
        throw new Error(`AttemptTerminalDecisionConflict:${input.streamId}`)
      }
      const reasoningCarryForward = streamLeaseReasoningCarryForward(lease)
      if (
        (input.kind === 'generation'
          ? input.generation.reasoningCarryForward
          : input.attempt.reasoningCarryForward) !== reasoningCarryForward
      ) {
        throw new Error(`AttemptFinalizeReasoningCarryForwardConflict:${input.streamId}`)
      }
      const reasoningVisibility = streamLeaseReasoningVisibility(lease)
      if (
        stableStringify(
          input.kind === 'generation'
            ? input.generation.reasoningVisibility
            : input.attempt.reasoningVisibility,
        ) !== stableStringify(reasoningVisibility)
      ) {
        throw new Error(`AttemptFinalizeReasoningVisibilityConflict:${input.streamId}`)
      }
      const chat = await ctx.getChat(input.chatId)
      if (!chat) {
        return {
          outcome: 'target-missing' as const,
          presentation: undefined,
        }
      }
      const header = await ctx.getMessageHeader(input.messageId)
      if (
        !header ||
        header.chatId !== lease.chatId ||
        header.deleted ||
        header.role !== 'assistant'
      ) {
        return {
          outcome: 'target-missing' as const,
          presentation: undefined,
        }
      }
      if (lease.canonicalAt !== undefined) {
        const current = await ctx.getMessage(input.messageId)
        if (!current) {
          return {
            outcome: 'target-missing' as const,
            presentation: undefined,
          }
        }
        return {
          outcome: 'already-canonical' as const,
          presentation: { header, message: current, bodyVersion: header.bodyVersion },
        }
      }
      if (input.kind === 'generation') {
        if (input.baseline.kind === 'unavailable') {
          return {
            outcome: 'target-missing' as const,
            presentation: undefined,
          }
        }
        if (header.bodyVersion !== input.baseline.bodyVersion) {
          throw new Error(`AttemptFinalizeBodyChanged:${input.messageId}`)
        }
        if (input.generation.id === input.streamId || input.generation.finishedAt === undefined) {
          throw new Error(`AttemptFinalizeGenerationMetadataInvalid:${input.streamId}`)
        }
        if (input.generatedOutput) {
          for (const bundle of input.generatedOutput.attachmentBundles) {
            const existing = await ctx.getAttachment(bundle.attachment.id)
            if (existing) {
              if (!preparedAttachmentIdentityMatches(existing, bundle.attachment)) {
                throw new Error(`GeneratedAttachmentIdCollision:${existing.id}`)
              }
              const refs = await ctx.countAttachmentReferences(existing.id)
              if (refs.occurrences > 0) {
                throw new Error(`GeneratedAttachmentIdCollision:${existing.id}`)
              }
              await ctx.deleteAttachmentBlobs(existing.id)
              await ctx.deleteAttachmentArtifacts(existing.id)
              await ctx.deleteAttachmentJobs(existing.id)
            }
            await persistPreparedAttachmentBundleInMutation(ctx, bundle, existing)
          }
        }
        const presentation = await ctx.patchMessageBody(
          input.messageId,
          input.generatedOutput
            ? { ...input.body, content: input.generatedOutput.content }
            : input.body,
          {
            replaceBody: true,
            replacementBaseline: input.baseline,
            headerPatch: {
              generation: input.generation,
              ...(input.generatedOutput
                ? { attachmentRefs: [...input.generatedOutput.attachmentRefs] }
                : {}),
            },
          },
        )
        if (!presentation) throw new Error(`AttemptFinalizeTargetMissing:${input.messageId}`)
        return {
          outcome: 'committed' as const,
          presentation,
        }
      } else {
        const current = await ctx.getMessage(input.messageId)
        if (!current) {
          return {
            outcome: 'target-missing' as const,
            presentation: undefined,
          }
        }
        const existingAttempt = current.continuationAttempts?.find(
          (attempt) => attempt.streamId === input.streamId,
        )
        if (existingAttempt) {
          return {
            outcome: 'already-canonical' as const,
            presentation: { header, message: current, bodyVersion: header.bodyVersion },
          }
        }
        if (input.attempt.streamId !== input.streamId) {
          throw new Error(`AttemptFinalizeContinuationMetadataInvalid:${input.streamId}`)
        }
        const attempts = (current.continuationAttempts ?? []).filter(
          (attempt) => attempt.streamId !== input.streamId,
        )
        const continuationDispatch = lease.attemptKind === 'continuation' ? lease.dispatch : null
        const baseMatches =
          continuationDispatch !== null &&
          header.bodyVersion === continuationDispatch.baseBodyVersion
        const hasContinuationContent =
          input.continuationText.length > 0 || input.continuationAnnotations.length > 0
        const continuationApplied = baseMatches
        const attempt = continuationApplied
          ? {
              ...structuredClone(input.attempt),
              application: { kind: 'applied' } as const,
            }
          : {
              ...structuredClone(input.attempt),
              application: {
                kind: 'unapplied',
                reason: 'base-version-changed',
              } as const,
              ...(input.continuationText.length > 0
                ? { unappliedText: input.continuationText }
                : {}),
              ...(input.continuationAnnotations.length > 0
                ? { unappliedAnnotations: structuredClone([...input.continuationAnnotations]) }
                : {}),
            }
        const nextContent =
          baseMatches && hasContinuationContent
            ? appendContinuationText(
                current.content,
                input.continuationText,
                input.continuationAnnotations,
              )
            : current.content
        let calibrationPatch: MessageCalibrationPatch | undefined
        if (baseMatches && input.continuationText.length > 0) {
          const [chat, globalCalibrationValue, calibrationModeValue] = await Dexie.Promise.all([
            ctx.getChat(current.chatId),
            ctx.getSetting<unknown>(GLOBAL_TOKEN_CALIBRATION_KEY),
            ctx.getSetting<unknown>(TOKEN_CALIBRATION_MODE_KEY),
          ])
          if (chat) {
            calibrationPatch = calibrationFieldsForEdit(
              nextContent,
              current.originalCharCount,
              current.originalModelId,
              current.originalCalibrationKey,
              chat.settings.model,
              chat,
              continuationGlobalCalibration(globalCalibrationValue),
              tokenCalibrationModeFromStored(calibrationModeValue),
            )
          }
        }
        const presentation = await ctx.patchMessageBody(
          input.messageId,
          {
            content: nextContent,
            ...(current.reasoningEnvelope !== undefined
              ? { reasoningEnvelope: current.reasoningEnvelope }
              : {}),
            ...(current.toolCalls !== undefined ? { toolCalls: current.toolCalls } : {}),
            ...(current.refusal !== undefined ? { refusal: current.refusal } : {}),
            ...(current.phase !== undefined ? { phase: current.phase } : {}),
            ...(current.providerOutputItems !== undefined
              ? { providerOutputItems: current.providerOutputItems }
              : {}),
            continuationAttempts: [...attempts, attempt],
          },
          {
            replaceBody: true,
            ...(calibrationPatch ? { headerPatch: calibrationPatch } : {}),
            semanticEffect: appendedContinuationSemanticEffect(
              createAppliedMessageView(current),
              attempt,
              {
                requestChanged: baseMatches && hasContinuationContent,
                corpusChanged: baseMatches && input.continuationText.length > 0,
              },
            ),
          },
        )
        if (!presentation) {
          throw new Error(`AttemptFinalizeTargetMissing:${input.messageId}`)
        }
        return {
          outcome: 'committed' as const,
          presentation,
        }
      }
    },
    {
      workspaceFence: { replacementEpoch },
      streamFence: { streamId: input.streamId, fence: input.fence },
      streamCanonicalCommit: {
        streamId: input.streamId,
        terminal: input.terminal,
        postCommitFinal: input.postCommit,
      },
      allowMissingCanonicalChatId: input.chatId,
      fastCurrentLeafSummaryTarget: input.messageId,
      ...(input.kind === 'continuation' && input.continuationText.length > 0
        ? {
            settingReadKeys: [GLOBAL_TOKEN_CALIBRATION_KEY, TOKEN_CALIBRATION_MODE_KEY],
          }
        : {}),
    },
    commit,
  )
  return {
    outcome: mutation.value.outcome,
    ...(mutation.value.presentation ? { presentation: mutation.value.presentation } : {}),
    lease: mutation.streamTargetLease as StreamLeaseRow,
  }
}

export async function commitBrowserGenerationMetadata(
  support: BrowserGenerationCommandSupport,
  input: GenerationPostCommitMetadataInput,
  replacementEpoch: number,
  commit: BrowserMutationCommandPort,
): Promise<GenerationPostCommitMetadataResult> {
  const {
    applyMessageCalibrationPatch,
    calibrationUsageFromPostCommit,
    chatTokenCalibrationGeneration,
    cloneMessageHeader,
    monotonicTimestamp,
    stableStringify,
    streamFenceMatches,
  } = support
  const transactionResult = await commit.executeSemanticOperation(
    GENERATION_METADATA_OPERATION,
    input,
    async (tx) => {
      const physicalReads: Array<
        SemanticOperationExactPhysicalRead & { tableName: GenerationMetadataTable }
      > = []
      const finish = (value: GenerationPostCommitMetadataResult) =>
        semanticOperationExecution(value, generationMetadataExactReceipt(tx, input, physicalReads))
      const leases = tx.table<StreamLeaseRow, string>('streamLeases')
      recordGenerationMetadataPrimaryRead(physicalReads, 'streamLeases')
      const lease = await leases.get(input.streamId)
      if (!streamFenceMatches(lease, input.fence, replacementEpoch)) {
        return finish({ outcome: 'stale' as const })
      }
      if (lease.phase !== 'canonical' && lease.phase !== 'metadata-committed') {
        return finish({ outcome: 'stale' as const })
      }
      const evidence = lease.postCommit
      const finalEvidence = evidence.final
      if (
        stableStringify(generationPostCommitMetadataResourceProof(lease)) !==
        stableStringify(input.resourceProof)
      ) {
        return finish({ outcome: 'stale' as const })
      }
      if (lease.phase === 'metadata-committed') {
        return finish({ outcome: 'already-applied' as const, lease: structuredClone(lease) })
      }

      const settingKeys: string[] = []
      const usedAt = evidence.usedAt
      const calibrationAt = Math.max(lease.canonicalAt, usedAt)
      const requestDispatched = lease.dispatch !== null
      if (
        lease.attemptKind === 'generation' &&
        (evidence.recentModelId !== undefined || evidence.calibration !== undefined)
      ) {
        recordGenerationMetadataPrimaryRead(physicalReads, 'messages')
      }
      const terminalGenerationHeader =
        lease.attemptKind === 'generation' &&
        (evidence.recentModelId !== undefined || evidence.calibration !== undefined)
          ? await tx.table<MessageHeaderRow, MessageId>('messages').get(lease.messageId)
          : undefined
      const generationCompleted =
        terminalGenerationHeader?.chatId === lease.chatId &&
        terminalGenerationHeader.generation?.status === 'done' &&
        terminalGenerationHeader.generation.finishedAt === lease.canonicalAt
      const profiles = tx.table<ConnectionProfile, ProfileId>('profiles')
      recordGenerationMetadataPrimaryRead(physicalReads, 'profiles')
      const profile = await profiles.get(evidence.profileId)
      if (
        requestDispatched &&
        profile &&
        monotonicTimestamp(profile.lastUsedAt, usedAt) !== profile.lastUsedAt
      ) {
        const touched = { ...profile, lastUsedAt: usedAt }
        await replaceLinkedSemanticByteOwner(tx, 'profiles', touched, profile)
        const projection = await putConfigurationProfileCatalogProjection(tx, touched)
        recordGenerationMetadataPrimaryRead(physicalReads, 'configurationProfileCatalogRows')
        recordGenerationMetadataPrimaryRead(
          physicalReads,
          'configurationCatalogAggregates',
          projection.aggregateIds.length,
        )
      }

      if (requestDispatched && evidence.presetId) {
        const presets = tx.table<ChatPreset, PresetId>('presets')
        recordGenerationMetadataPrimaryRead(physicalReads, 'presets')
        const preset = await presets.get(evidence.presetId)
        if (preset && monotonicTimestamp(preset.lastUsedAt, usedAt) !== preset.lastUsedAt) {
          const touched = { ...preset, lastUsedAt: usedAt }
          await replaceLinkedSemanticByteOwner(tx, 'presets', touched, preset)
          await putConfigurationPresetRecencyCatalogProjection(tx, touched)
          recordGenerationMetadataPrimaryRead(physicalReads, 'configurationPresetCatalogRows')
        }
      }

      if (finalEvidence.selectedKeyId) {
        const keys = tx.table<KeyRecord, KeyId>('keys')
        recordGenerationMetadataPrimaryRead(physicalReads, 'keys')
        const key = await keys.get(finalEvidence.selectedKeyId)
        if (key && monotonicTimestamp(key.lastUsedAt, usedAt) !== key.lastUsedAt) {
          await replaceSemanticByteOwner(tx, 'keys', { ...key, lastUsedAt: usedAt }, key)
        }
      }

      const settings = tx.table<SettingsRow, string>('settings')
      if (evidence.recentModelId !== undefined && generationCompleted) {
        recordGenerationMetadataPrimaryRead(physicalReads, 'settings', 2)
        const [publicRow, recencyRow] = await Dexie.Promise.all([
          settings.get(RECENT_MODELS_KEY),
          settings.get(RECENT_MODEL_RECENCY_KEY),
        ])
        const recent = advanceRecentModelState(publicRow?.value, recencyRow?.value, {
          modelId: evidence.recentModelId,
          usedAt,
          streamId: input.streamId,
        })
        if (recent.changed) {
          await putUserSettingByteOwners(
            tx,
            [
              { key: RECENT_MODEL_RECENCY_KEY, value: recent.recency },
              { key: RECENT_MODELS_KEY, value: recent.models },
            ],
            [recencyRow, publicRow],
          )
          settingKeys.push(RECENT_MODEL_RECENCY_KEY, RECENT_MODELS_KEY)
        }
      }

      const calibration = {
        attempted: false,
        promptAccepted: false,
        completionAccepted: false,
      }
      let committedHeader: MessageHeaderRow | undefined
      let committedMessageRevision: BrowserCommandMessageRevisionFact | undefined
      let chatVersions: ChatVersions | undefined
      if (evidence.calibration && lease.attemptKind === 'generation') {
        const plan = evidence.calibration
        recordGenerationMetadataPrimaryRead(physicalReads, 'chats')
        recordGenerationMetadataPrimaryRead(physicalReads, 'settings')
        const chatMutation = openPreservingChatMutation(tx)
        const [chat, globalRow] = await Dexie.Promise.all([
          chatMutation.read(lease.chatId),
          settings.get(GLOBAL_TOKEN_CALIBRATION_KEY),
        ])
        const header = terminalGenerationHeader
        const finalCalibration = finalEvidence.calibration
        const global = normalizeGlobalTokenCalibration(globalRow?.value)
        if (
          chat &&
          header &&
          finalCalibration &&
          finalEvidence.expectedNodeVersion !== undefined &&
          finalEvidence.expectedBodyVersion !== undefined &&
          header.chatId === lease.chatId &&
          !header.deleted &&
          header.role === 'assistant' &&
          header.nodeVersion === finalEvidence.expectedNodeVersion &&
          header.bodyVersion === finalEvidence.expectedBodyVersion &&
          header.generation?.finishedAt === lease.canonicalAt &&
          header.generation.status === 'done' &&
          !header.generation.tokenCalibration &&
          (finalEvidence.usage === undefined ||
            stableStringify(streamPostCommitUsageEvidence(header.generation.usage)) ===
              stableStringify(finalEvidence.usage)) &&
          chatTokenCalibrationGeneration(chat) === plan.expectedChatGeneration &&
          tokenCalibrationClearGeneration(global) === plan.expectedGlobalClearGeneration
        ) {
          const staged = { tokenCalibration: structuredClone(chat.tokenCalibration ?? {}) }
          const acceptedSamples: Array<{ chars: number; tokens: number }> = []
          if (finalEvidence.usage) {
            calibration.attempted = true
            const usage = calibrationUsageFromPostCommit(finalEvidence.usage)
            const promptSample =
              plan.promptAllowed && plan.promptBasis
                ? derivePromptSampleFromBasis(plan.promptBasis, usage)
                : null
            const completionSample = finalEvidence.completionAllowed
              ? (finalCalibration.completionSample ?? null)
              : null
            if (promptSample) {
              const accepted = addSampleToChat(
                staged,
                plan.modelId,
                promptSample.chars,
                promptSample.tokens,
                calibrationAt,
              )
              if (accepted.accepted) {
                calibration.promptAccepted = true
                acceptedSamples.push(promptSample)
              }
            }
            if (completionSample) {
              const accepted = addSampleToChat(
                staged,
                plan.modelId,
                completionSample.chars,
                completionSample.tokens,
                calibrationAt,
              )
              if (accepted.accepted) {
                calibration.completionAccepted = true
                acceptedSamples.push(completionSample)
              }
            }
          }
          const calibrationFields = calibrationFieldsForCreateFromTextCharCount(
            finalCalibration.messageTextChars,
            plan.modelId,
            chat,
            global,
            plan.mode,
          )
          const nextGeneration =
            acceptedSamples.length === 0
              ? header.generation
              : {
                  ...header.generation,
                  tokenCalibration: {
                    sampleId: header.id,
                    modelId: plan.modelId,
                    calibrationKey: tokenCalibrationKey(plan.modelId),
                    promptSample: calibration.promptAccepted,
                    completionSample: calibration.completionAccepted,
                    sampleCount: acceptedSamples.length,
                    appliedAt: calibrationAt,
                  },
                }
          const nextHeader = applyMessageCalibrationPatch(header, {
            ...calibrationFields,
            generation: nextGeneration,
          })
          if (stableStringify(nextHeader) !== stableStringify(header)) {
            nextHeader.nodeVersion = header.nodeVersion + 1
            nextHeader.requestContextVersion = header.requestContextVersion
            nextHeader.bodyVersion = header.bodyVersion
            await putPhysicalStorageRow(tx, 'messages', nextHeader, header)
            committedHeader = cloneMessageHeader(nextHeader)
            committedMessageRevision = {
              before: cloneMessageHeader(header),
              header: committedHeader,
              structuralVersion: chat.structuralVersion,
            }
          }
          if (acceptedSamples.length > 0) {
            chatMutation.replace(lease.chatId, (current) => ({
              ...current,
              tokenCalibration: staged.tokenCalibration,
            }))
            const transition = await chatMutation.commit()
            boundSemanticOperationExactReceiptAccumulator<GenerationMetadataTable>(tx)?.absorb(
              transition.fragment,
            )
            await putTokenCalibrationSettingByteOwner(
              tx,
              {
                key: GLOBAL_TOKEN_CALIBRATION_KEY,
                value: applyAcceptedSamplesToGlobalRecord(
                  global,
                  plan.modelId,
                  acceptedSamples,
                  calibrationAt,
                ),
              },
              globalRow,
            )
            settingKeys.push(GLOBAL_TOKEN_CALIBRATION_KEY)
            chatVersions = {
              metaVersion: chat.metaVersion,
              summaryVersion: chat.summaryVersion,
              structuralVersion: chat.structuralVersion,
            }
          }
        }
      }

      const committedLease = commitStreamLeaseMetadata(lease, calibrationAt)
      await putStreamLeaseByteOwner(tx, committedLease, lease)
      if (committedMessageRevision) {
        recordBrowserCommandMessageRevisions(tx, [committedMessageRevision])
      }
      return finish({
        outcome: 'applied' as const,
        lease: structuredClone(committedLease),
        chatId: lease.chatId,
        messageId: lease.messageId,
        profileId: evidence.profileId,
        ...(evidence.presetId ? { presetId: evidence.presetId } : {}),
        ...(finalEvidence.selectedKeyId ? { selectedKeyId: finalEvidence.selectedKeyId } : {}),
        settingKeys,
        calibration,
        ...(chatVersions ? { chatVersions } : {}),
        ...(committedHeader ? { header: committedHeader } : {}),
      })
    },
  )
  return transactionResult
}

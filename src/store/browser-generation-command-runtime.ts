import { sameChatSettings } from '../core/chat-metadata'
import {
  appendContinuationText,
  appendedContinuationSemanticEffect,
  createAppliedMessageView,
} from '../core/continuation-content'
import { contentHasUnmaterializedGeneratedOutput } from '../core/generated-output-localization'
import {
  advanceRecentModelState,
  CORS_PROXY_SECRET_KEY,
  CORS_PROXY_URL_KEY,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
  TOKEN_CALIBRATION_MODE_KEY,
  tokenCalibrationModeFromStored,
} from '../core/global-settings'
import { fixedConversationSelectionTarget } from '../core/messages'
import { tokenCalibrationKey } from '../core/model-ids'
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
  ChatId,
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
import {
  type BrowserCommandMessageRevisionFact,
  recordBrowserCommandMessageRevisions,
} from './browser-command-mutation-journal'
import type {
  BrowserGenerationCommandPort,
  BrowserGenerationCommandSupport,
  BrowserMutationCommandPort,
} from './browser-domain-mutations'
import { GenerationPlanningSeedChangedError } from './browser-mutation-plan'
import {
  putPhysicalStorageRow,
  putTokenCalibrationSettingByteOwner,
  putUserSettingByteOwners,
  replaceLinkedSemanticByteOwner,
  replaceSemanticByteOwner,
} from './byte-owner-mutation'
import { applyChatRowWriteTransitions } from './chat-row-transition'
import {
  putConfigurationPresetRecencyCatalogProjection,
  putConfigurationProfileCatalogProjection,
} from './configuration-catalog-projection'
import type { SettingsRow } from './db-rows'
import type { MessageHeaderRow } from './message-storage'
import {
  ChatMissingError,
  commitStreamLeaseMetadata,
  type MessageCalibrationPatch,
  type StreamLeaseRow,
  type StreamPostCommitEvidence,
  type StreamTargetCommit,
  streamLeaseReasoningCarryForward,
  streamLeaseReasoningVisibility,
  streamPostCommitUsageEvidence,
  WorkspaceReplacementFenceError,
  type WriterActiveStreamLeaseRow,
  type WriterReservedStreamLeaseRow,
} from './repository'
import { putStreamLeaseByteOwner } from './stream-journal-storage'
import type {
  AttemptDispatchInput,
  AttemptDispatchResult,
  AttemptFinalizeResult,
  AttemptPrepareResult,
  AttemptTerminalProjection,
  GenerationPostCommitMetadataInput,
  GenerationPostCommitMetadataResult,
  MessagePresentation,
  PrepareAttemptInput,
} from './workspace-protocol'

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
    chatConfigurationTargetResourceNames,
    preparedGenerationPrompt,
    preparedMessage,
    requiredPromptPathSlot,
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
  const assistant = input.strategy === 'continue' ? undefined : input.assistant
  const targetMessageId =
    requirement.target.kind === 'root' ? undefined : requirement.target.messageId
  const assistantId = assistant?.id ?? targetMessageId
  if (!assistantId) throw new Error(`AttemptAssistantTargetMissing:${input.lease.streamId}`)
  if (input.lease.messageId !== assistantId) {
    throw new Error(`AttemptLeaseTargetMismatch:${input.lease.streamId}:${assistantId}`)
  }
  if (input.lease.replacementEpoch !== replacementEpoch) {
    throw new WorkspaceReplacementFenceError()
  }
  const chatId = input.lease.chatId
  if (input.strategy === 'new-chat-send') assertNewChatAttemptRow(input.chat, chatId)
  const persistsCapturedConfiguration =
    input.strategy === 'regenerate' && input.persistCapturedConfiguration === true
  const attemptSettings = input.configurationClaim.settings
  const postCommit: StreamPostCommitEvidence = {
    usedAt: input.lease.startedAt,
    profileId: attemptSettings.profileId,
    ...(input.configurationClaim.presetId ? { presetId: input.configurationClaim.presetId } : {}),
    ...(input.strategy === 'new-chat-send' || input.strategy === 'send'
      ? { recentModelId: attemptSettings.model }
      : {}),
  }
  const planningSettingKeys = [
    GLOBAL_TOKEN_CALIBRATION_KEY,
    TOKEN_CALIBRATION_MODE_KEY,
    CORS_PROXY_URL_KEY,
    CORS_PROXY_SECRET_KEY,
  ]
  const planningExpectation = input.configurationClaim
  if ('user' in input) {
    support.assertPreparedAttemptMessage(input.user, input.lease, 'user', 'user')
  }
  if (assistant) {
    support.assertPreparedAttemptMessage(assistant, input.lease, 'assistant', 'generated')
  }
  const attachmentIds = new Set<AttachmentId>()
  for (const message of [
    ...('user' in input ? [input.user] : []),
    ...(assistant ? [assistant] : []),
  ]) {
    if (message.chatId !== chatId) throw new Error(`AttemptMessageChatMismatch:${message.id}`)
    for (const ref of message.attachmentRefs ?? []) attachmentIds.add(ref.attachmentId)
  }
  const scopes: MutationScope[] = [
    { kind: 'chat-meta', chatId },
    { kind: 'message', messageId: assistantId },
    ...[...attachmentIds].map((attachmentId) => ({
      kind: 'attachment' as const,
      attachmentId,
    })),
  ]
  if ('user' in input) scopes.push({ kind: 'message', messageId: input.user.id })
  if (input.strategy !== 'continue') scopes.push({ kind: 'chat-topology', chatId })
  if (targetMessageId) scopes.push({ kind: 'message', messageId: targetMessageId })

  const mutation = await repository.runMutation(
    scopes,
    async (ctx, mutation) => {
      const currentChat = await ctx.getChat(chatId)
      if (!currentChat) throw new ChatMissingError(chatId)
      if (
        persistsCapturedConfiguration &&
        'configurationVersion' in input.configurationClaim &&
        (currentChat.configurationVersion ?? 0) !== input.configurationClaim.configurationVersion
      ) {
        throw new GenerationPlanningSeedChangedError(chatId)
      }
      const validatedPromptPath = await mutation.validateGenerationPromptPathClaim(
        chatId,
        input.promptPath.claim,
      )
      const promptPath = await resolveGenerationPromptPathProof(
        ctx,
        chatId,
        input.promptPath,
        validatedPromptPath,
      )
      const planningChat: Chat = {
        ...currentChat,
        settings: structuredClone(attemptSettings),
      }
      const selectionBase = Object.freeze({
        chatId,
        structuralVersion: currentChat.structuralVersion,
        tipId: promptPath.leafId,
      })
      if (input.configurationClaim.presetId === null) delete planningChat.presetId
      else planningChat.presetId = input.configurationClaim.presetId
      if (persistsCapturedConfiguration) delete planningChat.modelResolution

      if (persistsCapturedConfiguration) {
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
      if (input.strategy === 'continue') {
        const header = requiredPromptPathTarget(promptPath, chatId)
        const target = await ctx.getMessage(header.id)
        if (!target || target.chatId !== chatId || target.deleted || target.role !== 'assistant') {
          throw new GenerationPlanningSeedChangedError(chatId)
        }
        const planning = await mutation.captureGenerationPlanningSnapshot(
          chatId,
          planningExpectation,
          planningChat,
        )
        const prompt = preparedGenerationPrompt(
          target.id,
          promptPath.headers,
          promptPath.messageProofs,
          [
            {
              header,
              message: target,
              bodyVersion: header.bodyVersion,
            },
          ],
        )
        return {
          strategy: 'continue' as const,
          assistant: target,
          assistantHeader: header,
          prompt,
          planning,
          continuationBase: {
            streamId: input.lease.streamId,
            messageId: target.id,
            baseNodeVersion: header.nodeVersion,
            baseBodyVersion: header.bodyVersion,
          },
        }
      }

      const preparedAssistantInput = input.assistant
      support.assertPreparedAttemptMessage(
        preparedAssistantInput,
        input.lease,
        'assistant',
        'generated',
      )
      if (await ctx.getMessageHeader(preparedAssistantInput.id)) {
        throw new Error(`AttemptAssistantAlreadyExists:${preparedAssistantInput.id}`)
      }
      let user: Message | undefined
      let parentId: MessageId | null
      let siblingIndex: number
      let assistantTurnId = preparedAssistantInput.turnId
      let assistantTurnIndex = preparedAssistantInput.turnIndex

      if (input.strategy === 'send' || input.strategy === 'new-chat-send') {
        if (await ctx.getMessageHeader(input.user.id)) {
          throw new Error(`AttemptUserAlreadyExists:${input.user.id}`)
        }
        const slot = requiredPromptPathSlot(promptPath, chatId)
        user = preparedMessage(
          { ...input.user, turnIndex: 0 },
          promptPath.leafId,
          slot.nextSiblingIndex,
        )
        user = await ctx.putMessage(user)
        parentId = user.id
        siblingIndex = 0
      } else if (input.strategy === 'edit-resend') {
        requiredPromptPathTarget(promptPath, chatId)
        if (await ctx.getMessageHeader(input.user.id)) {
          throw new Error(`AttemptUserAlreadyExists:${input.user.id}`)
        }
        const slot = requiredPromptPathSlot(promptPath, chatId)
        user = preparedMessage(
          { ...input.user, turnIndex: 0 },
          promptPath.leafId,
          slot.nextSiblingIndex,
        )
        user = await ctx.putMessage(user)
        parentId = user.id
        siblingIndex = 0
      } else if (input.strategy === 'reply') {
        const parent = requiredPromptPathTarget(promptPath, chatId)
        const slot = requiredPromptPathSlot(promptPath, chatId)
        parentId = parent.id
        siblingIndex = slot.nextSiblingIndex
        assistantTurnId = parent.turnId
        assistantTurnIndex = parent.turnIndex + 1
      } else {
        requiredPromptPathTarget(promptPath, chatId)
        const slot = requiredPromptPathSlot(promptPath, chatId)
        parentId = promptPath.leafId
        siblingIndex = slot.nextSiblingIndex
        assistantTurnIndex = 0
      }

      if (user) {
        assistantTurnId = user.turnId
        assistantTurnIndex = user.turnIndex + 1
      }
      const pairedAssistant = {
        ...preparedAssistantInput,
        turnId: assistantTurnId,
        turnIndex: assistantTurnIndex,
        generation: {
          ...preparedAssistantInput.generation,
          model: attemptSettings.model,
          requestedModel: attemptSettings.model,
        },
      }
      const preparedAssistant = preparedMessage(pairedAssistant, parentId, siblingIndex)
      const committedAssistant = await ctx.putMessage(preparedAssistant)
      const committedUser = user
      const headers = await ctx.getMessageHeaders(
        user ? [user.id, preparedAssistant.id] : [preparedAssistant.id],
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
      const planningLeafId = committedUserHeader?.id ?? parentId
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
        planningExpectation,
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
      ...(persistsCapturedConfiguration ? { configurationLinkChatId: chatId } : {}),
      promoteChatId: chatId,
      workspaceFence: { replacementEpoch },
      streamAdmission: input.lease,
      streamAdmissionPostCommit: postCommit,
      additionalLockNames: [
        ...(input.strategy === 'new-chat-send'
          ? [
              'chat-catalog',
              ...chatConfigurationTargetResourceNames(input.chat),
              ...(input.chat.folderId ? [`folder:${input.chat.folderId}`] : []),
              ...(input.chat.tags.length > 0 ? ['tag-catalog'] : []),
            ]
          : []),
        `profile:${input.configurationClaim.profile.profileId}`,
        ...planningSettingKeys.map((key) => `setting:${key}`),
        `stream-journal:${input.lease.streamId}`,
      ],
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
        forks: await ctx.readFinalActiveBranchForks(value.headers),
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
      assistant: mutation.value.assistant,
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

export async function dispatchBrowserAttempt(
  repository: BrowserGenerationCommandPort,
  input: AttemptDispatchInput,
  replacementEpoch: number,
  commit: BrowserMutationCommandPort,
): Promise<AttemptDispatchResult> {
  const lease = await repository.getStreamLease(input.streamId)
  if (!lease) throw new Error(`StreamFenceLost:${input.streamId}`)
  if (lease.attemptKind === 'continuation' && !input.continuation) {
    throw new Error(`ContinuationDispatchMetadataMissing:${input.streamId}`)
  }
  if (lease.attemptKind === 'generation' && input.continuation) {
    throw new Error(`GenerationDispatchHasContinuationMetadata:${input.streamId}`)
  }
  if (lease.attemptKind === 'continuation' && input.postCommitCalibration) {
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
      continuationProof.messageId !== lease.messageId)
  ) {
    throw new Error(`ContinuationPrepareProofMismatch:${input.streamId}`)
  }
  const streamTargetCommit: StreamTargetCommit = input.continuation
    ? {
        streamId: input.streamId,
        messageId: lease.messageId,
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
        messageId: lease.messageId,
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
    [{ kind: 'message', messageId: lease.messageId }],
    async (ctx) => {
      if (input.continuation) {
        const target = await ctx.getMessageHeader(lease.messageId)
        if (!target || target.bodyVersion !== input.continuation.prepareProof.baseBodyVersion) {
          throw new Error(`ContinuationTargetChanged:${lease.messageId}`)
        }
      }
      const header =
        lease.attemptKind === 'generation'
          ? await ctx.transitionMessageGenerationForDispatch(lease.messageId, input.generation)
          : await ctx.getMessageHeader(lease.messageId)
      if (!header) throw new Error(`AttemptDispatchTargetMissing:${lease.messageId}`)
      return header
    },
    {
      workspaceFence: { replacementEpoch },
      generationReadSet: input.readSet,
      streamFence: { streamId: input.streamId, fence: input.fence },
      streamTargetCommit,
      additionalLockNames: [`stream-journal:${input.streamId}`],
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
  const lease = await repository.getStreamLease(input.streamId)
  if (!lease) throw new Error(`StreamFenceLost:${input.streamId}`)
  if (lease.messageId !== input.messageId || lease.attemptKind !== input.kind) {
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
  const generatedAttachmentIds =
    input.kind === 'generation'
      ? (input.generatedOutput?.attachmentBundles.map((bundle) => bundle.attachment.id) ?? [])
      : []
  const mutation = await repository.runMutation(
    dedupeMutationScopes([
      { kind: 'message', messageId: input.messageId },
      ...generatedAttachmentIds.map((attachmentId) => ({
        kind: 'attachment' as const,
        attachmentId,
      })),
    ]),
    async (ctx) => {
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
          const [chat, globalCalibrationValue, calibrationModeValue] = await Promise.all([
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
      fastCurrentLeafSummaryTarget: input.messageId,
      ...(input.kind === 'continuation' && input.continuationText.length > 0
        ? {
            settingReadKeys: [GLOBAL_TOKEN_CALIBRATION_KEY, TOKEN_CALIBRATION_MODE_KEY],
          }
        : {}),
      additionalLockNames: [`stream-journal:${input.streamId}`],
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
  repository: BrowserGenerationCommandPort,
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
    GENERATION_METADATA_TRANSACTION,
    monotonicTimestamp,
    stableStringify,
    streamFenceMatches,
  } = support
  const snapshot = await repository.getStreamLease(input.streamId)
  const snapshotPostCommit = snapshot?.postCommit
  const snapshotFinal = snapshotPostCommit?.final
  const settingLockNames = [
    ...(snapshotPostCommit?.recentModelId !== undefined
      ? [RECENT_MODELS_KEY, RECENT_MODEL_RECENCY_KEY]
      : []),
    ...(snapshotPostCommit?.calibration ? [GLOBAL_TOKEN_CALIBRATION_KEY] : []),
  ].map((key) => `setting:${key}`)
  const lockNames = [
    `stream-journal:${input.streamId}`,
    ...(snapshot ? [`message:${snapshot.messageId}`, `chat-meta:${snapshot.chatId}`] : []),
    ...(snapshotPostCommit ? [`profile:${snapshotPostCommit.profileId}`] : []),
    ...(snapshotPostCommit?.presetId ? [`preset:${snapshotPostCommit.presetId}`] : []),
    ...(snapshotFinal?.selectedKeyId ? [`key:${snapshotFinal.selectedKeyId}`] : []),
    ...settingLockNames,
  ]
  const transactionResult = await commit.withLocks(lockNames, (locked) =>
    locked.runTransaction(GENERATION_METADATA_TRANSACTION, async (tx) => {
      const leases = tx.table<StreamLeaseRow, string>('streamLeases')
      const lease = await leases.get(input.streamId)
      if (!streamFenceMatches(lease, input.fence, replacementEpoch)) {
        return { outcome: 'stale' as const }
      }
      if (lease.phase !== 'canonical' && lease.phase !== 'metadata-committed') {
        return { outcome: 'stale' as const }
      }
      const evidence = lease.postCommit
      const finalEvidence = evidence.final
      if (
        !snapshot ||
        snapshot.chatId !== lease.chatId ||
        snapshot.messageId !== lease.messageId ||
        stableStringify(snapshot.postCommit) !== stableStringify(evidence)
      ) {
        return { outcome: 'stale' as const }
      }
      if (lease.phase === 'metadata-committed') {
        return { outcome: 'already-applied' as const, lease: structuredClone(lease) }
      }

      const settingKeys: string[] = []
      const usedAt = evidence.usedAt
      const calibrationAt = Math.max(lease.canonicalAt, usedAt)
      const requestDispatched = lease.dispatch !== null
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
      const profile = await profiles.get(evidence.profileId)
      if (
        requestDispatched &&
        profile &&
        monotonicTimestamp(profile.lastUsedAt, usedAt) !== profile.lastUsedAt
      ) {
        const touched = { ...profile, lastUsedAt: usedAt }
        await replaceLinkedSemanticByteOwner(tx, 'profiles', touched, profile)
        await putConfigurationProfileCatalogProjection(tx, touched)
      }

      if (requestDispatched && evidence.presetId) {
        const presets = tx.table<ChatPreset, PresetId>('presets')
        const preset = await presets.get(evidence.presetId)
        if (preset && monotonicTimestamp(preset.lastUsedAt, usedAt) !== preset.lastUsedAt) {
          const touched = { ...preset, lastUsedAt: usedAt }
          await replaceLinkedSemanticByteOwner(tx, 'presets', touched, preset)
          await putConfigurationPresetRecencyCatalogProjection(tx, touched)
        }
      }

      if (finalEvidence.selectedKeyId) {
        const keys = tx.table<KeyRecord, KeyId>('keys')
        const key = await keys.get(finalEvidence.selectedKeyId)
        if (key && monotonicTimestamp(key.lastUsedAt, usedAt) !== key.lastUsedAt) {
          await replaceSemanticByteOwner(tx, 'keys', { ...key, lastUsedAt: usedAt }, key)
        }
      }

      const settings = tx.table<SettingsRow, string>('settings')
      if (evidence.recentModelId !== undefined && generationCompleted) {
        const [publicRow, recencyRow] = await Promise.all([
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
        const [chat, globalRow] = await Promise.all([
          tx.table<Chat, ChatId>('chats').get(lease.chatId),
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
            await applyChatRowWriteTransitions(tx, [
              {
                kind: 'replace-preserving-links',
                previous: chat,
                next: { ...chat, tokenCalibration: staged.tokenCalibration },
              },
            ])
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
      return {
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
      }
    }),
  )
  return transactionResult
}

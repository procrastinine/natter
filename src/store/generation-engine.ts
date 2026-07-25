import {
  type AssistantDispatchPlan,
  type AssistantStreamChunk,
  createAssistantDispatchPlan,
  openAssistantRequestStream,
} from '../api/assistant-stream'
import { type ApiError, normalizeError } from '../api/errors'
import { createChatRow } from '../core/chat-metadata'
import { resolveContinueSystemPromptTemplate } from '../core/continue-prompts'
import {
  generationNotStarted,
  type NonReadyGenerationCapability,
} from '../core/interaction-capability'
import {
  mergeMessageContextRouteFacts,
  persistedReasoningCarryForwardFromEvidence,
  UNKNOWN_INBOUND_REASONING_VISIBILITY,
} from '../core/reasoning'
import { createStreamAccumulator, messageHasToolArtifacts } from '../core/stream-accumulator'
import {
  derivePromptCalibrationBasis,
  type PromptCalibrationBasis,
  tokenCalibrationClearGeneration,
} from '../core/token-calibration'
import type { TokenizerFamily } from '../core/tokens'
import type {
  AbortReason,
  AttachmentRef,
  Chat,
  ChatId,
  ChatSettings,
  ContentItem,
  DispatchedGenerationMeta,
  FinishReason,
  GenerationMeta,
  KeyId,
  Message,
  MessageId,
} from '../core/types'
import { isPageHiding } from '../lib/page-lifecycle'
import { newId } from '../lib/ulid'
import { attemptController } from './attempt-controller'
import {
  type AttemptTerminalOwner,
  createAttemptTerminalLeaseApplications,
  createWriterAttemptTerminalOwner,
  projectAttemptTerminal,
} from './attempt-terminalization'
import {
  type ConnectionRuntimeKeyCandidate,
  captureConnectionRuntimeKeysFromRecords,
  primeConnectionRuntimeKeyCandidates,
  recordAcceptedConnectionRuntimeKeyPreference,
} from './connection-runtime'
import { type ConversationRouteDelivery, conversationController } from './conversation-controller'
import { conversationCommittedEffectForCommit } from './conversation-repository-adapter'
import type { ConversationRouteOwner } from './conversation-route-owner'
import {
  type ExistingChatGenerationIntent,
  type GenerationAdmissionClaim,
  GenerationAdmissionError,
  type GenerationAdmissionPayload,
  type GenerationAdmissionRequest,
  type GenerationIntent,
  generationAdmissionController,
  type NewChatGenerationIntent,
  type SelectedSendGenerationIntent,
} from './generation-admission-controller'
import {
  CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
  type GenerationAttemptResult,
  runGenerationAttempt,
  SEND_GENERATION_ATTEMPT_ERROR_POLICY,
} from './generation-attempt-runner'
import type { SelectedSendAdmissionClaim } from './generation-capability-controller'
import { GenerationPlanningReader } from './generation-planning-reader'
import {
  projectContinuationLiveAttempt,
  projectGenerationLiveAttempt,
} from './generation-projection'
import type { MessageBodyFields, MessageHeaderRow, MessagePresentation } from './message-storage'
import { CURRENT_STREAM_JOURNAL_EVENT_VERSION } from './persisted-stream-event'
import {
  committedConversationTransition,
  NoEligibleProvidersError,
  type StreamLeaseAdmission,
  streamLeaseReasoningCarryForward,
  streamLeaseReasoningVisibility,
} from './repository'
import {
  logCanonicalGenerationFinalized,
  logPreparedAssistantRequestPlan,
} from './request-plan-diagnostics'
import {
  type AssistantRequestPlan,
  type AssistantRoutingPlan,
  prepareAssistantRequestPlanFromContextSelection,
  resolveAssistantRequestFacts,
} from './request-planning'
import { loadGenerationContextForBranch } from './send-context'
import {
  createStreamJournalWriter,
  type StreamJournalWriter,
  workspaceStreamJournalFrameAppendPort,
} from './stream-chunk-writer'
import {
  adoptPreparedStreamLease,
  getStreamClientId,
  releaseStreamOwnershipReservation,
  reserveStreamOwnership,
  type StreamLeaseHandle,
  type StreamOwnershipReservation,
} from './stream-leases'
import type {
  AttemptPrepareResult,
  GenerationPlanningSnapshot,
  PrepareAttemptInput,
} from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import {
  releaseWorkspaceChild,
  reserveWorkspaceChild,
  runWorkspacePhase,
  type WorkspaceReservedPermit,
  type WorkspaceWritePermit,
} from './workspace-runtime'
import { announceGenerationOutcome, useAnnouncementStore } from './zustand/announcementStore'
import { useUiStore } from './zustand/uiStore'

export type { GenerationIntent } from './generation-admission-controller'
export type SelectedSendGenerationAdmission = SelectedSendAdmissionClaim

const PREPARED_NEW_CHAT_GENERATION = Symbol('prepared-new-chat-generation')

export interface PreparedGeneration {
  readonly streamId: string
  readonly chatId: ChatId
  readonly assistantMessageId: MessageId
  readonly userMessageId?: MessageId
}

export type PreparedNewChatGeneration = PreparedGeneration &
  ConversationRouteDelivery & {
    readonly [PREPARED_NEW_CHAT_GENERATION]: true
  }

export interface CompletedGeneration extends PreparedGeneration {
  readonly outcome: 'done' | 'error' | 'abort'
  readonly finishReason?: FinishReason
  readonly error?: ApiError
}

export interface GenerationHandle<Prepared extends PreparedGeneration = PreparedGeneration> {
  readonly streamId: string
  readonly chatId: ChatId
  readonly prepared: Promise<Prepared>
  readonly completed: Promise<CompletedGeneration>
}

export type GenerationStartResult<Intent extends GenerationIntent = GenerationIntent> =
  | {
      readonly kind: 'started'
      readonly handle: GenerationHandle<PreparedGenerationForIntent<Intent>>
    }
  | {
      readonly kind: 'not-started'
      readonly capability: NonReadyGenerationCapability
    }

export type PreparedGenerationForIntent<Intent extends GenerationIntent> = [Intent] extends [
  Extract<GenerationIntent, { readonly kind: 'new-chat-send' }>,
]
  ? PreparedNewChatGeneration
  : PreparedGeneration

export type GenerationStartRequest =
  | {
      readonly intent: NewChatGenerationIntent
      readonly routeOwner: ConversationRouteOwner
    }
  | {
      readonly intent: ExistingChatGenerationIntent
    }

export type SettlingGenerationStartRequest =
  | GenerationStartRequest
  | {
      readonly intent: SelectedSendGenerationIntent
      readonly admission?: SelectedSendAdmissionClaim
    }

export type PreparedGenerationForSettlingIntent<
  Intent extends GenerationIntent | SelectedSendGenerationIntent,
> = Intent extends SelectedSendGenerationIntent
  ? PreparedGeneration
  : Intent extends NewChatGenerationIntent
    ? PreparedNewChatGeneration
    : PreparedGeneration

export interface GenerationTransportInput {
  readonly connection: GenerationPlanningSnapshot['profile']
  readonly apiKey: string
  readonly apiKeyCandidates: readonly ConnectionRuntimeKeyCandidate[]
  readonly requestPlan: AssistantDispatchPlan
  readonly diagnosticId: string
  readonly signal: AbortSignal
  readonly onKeyCandidateSelected: (candidate: ConnectionRuntimeKeyCandidate) => Promise<void>
}

export interface GenerationEngine {
  start<Request extends GenerationStartRequest>(
    request: Request,
  ): GenerationStartResult<Request['intent']>
  startWhenCapabilitySettles<Request extends SettlingGenerationStartRequest>(
    request: Request,
    options: { readonly signal: AbortSignal },
  ): Promise<GenerationHandle<PreparedGenerationForSettlingIntent<Request['intent']>>>
}

export interface GenerationEngineOptions {
  readonly now?: () => number
  readonly openStream?: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

interface PreparedAttemptState {
  readonly prepared: PreparedGeneration
  readonly result: AttemptPrepareResult
  readonly routeDelivery?: ConversationRouteDelivery
}

interface AttemptRuntimeState {
  readonly prepared: PreparedGeneration
  readonly lease: AttemptPrepareResult['lease']
  readonly assistantAttachmentRefs: readonly AttachmentRef[]
  readonly assistantGeneration: GenerationMeta | undefined
  readonly assistantBody: MessageBodyFields
  readonly assistantBodyVersion: number
  readonly planningModel: string
}

interface ContinuationPlanningState {
  readonly strategy: 'prompt' | 'prefill'
  readonly base: MessagePresentation
  readonly baseTextLength: number
}

type GenerationRuntimeIntent =
  | {
      readonly kind: 'continue'
      readonly targetAssistantId: MessageId
    }
  | {
      readonly kind: Exclude<GenerationIntent['kind'], 'continue'>
    }

interface CalibrationDispatchEvidence {
  readonly modelId: string
  readonly family: TokenizerFamily
  readonly promptBasis: PromptCalibrationBasis | null
  readonly promptBlocked: boolean
}

interface DispatchState {
  readonly profile: GenerationPlanningSnapshot['profile']
  readonly requestPlan: AssistantRequestPlan
  readonly dispatchPlan: AssistantDispatchPlan
  readonly keyCandidates: readonly ConnectionRuntimeKeyCandidate[]
  readonly apiKey: string
  readonly generation: DispatchedGenerationMeta
  readonly dispatchHeader: MessageHeaderRow
  readonly calibration: CalibrationDispatchEvidence
  readonly continuation?: ContinuationPlanningState
}

interface GenerationExecutionEvidence {
  phase: 'claimed' | 'dispatched' | 'transport-open' | 'stream-event'
}

export function createGenerationEngine(options: GenerationEngineOptions = {}): GenerationEngine {
  const now = options.now ?? Date.now
  const openStream = options.openStream ?? defaultOpenStream
  return Object.freeze({
    start<Request extends GenerationStartRequest>(
      request: Request,
    ): GenerationStartResult<Request['intent']> {
      let claim: GenerationAdmissionClaim
      try {
        const admissionRequest: GenerationAdmissionRequest =
          'routeOwner' in request
            ? { intent: request.intent, routeOwner: request.routeOwner }
            : { intent: request.intent }
        claim = generationAdmissionController.claim(admissionRequest)
      } catch (error) {
        if (error instanceof GenerationAdmissionError && error.capability.state !== 'ready') {
          return generationNotStarted(error.capability)
        }
        throw error
      }
      const handle = startClaimedGeneration({ claim, openStream, now })
      return Object.freeze({
        kind: 'started',
        handle: handle as GenerationHandle<PreparedGenerationForIntent<Request['intent']>>,
      })
    },
    async startWhenCapabilitySettles<Request extends SettlingGenerationStartRequest>(
      request: Request,
      startOptions: { readonly signal: AbortSignal },
    ): Promise<GenerationHandle<PreparedGenerationForSettlingIntent<Request['intent']>>> {
      const claim = await generationAdmissionController.claimWhenCapabilitySettles(
        request,
        startOptions.signal,
      )
      return startClaimedGeneration({
        claim,
        openStream,
        now,
        signal: startOptions.signal,
      }) as GenerationHandle<PreparedGenerationForSettlingIntent<Request['intent']>>
    },
  })
}

export const generationEngine = createGenerationEngine()

function startClaimedGeneration(input: {
  readonly claim: GenerationAdmissionClaim
  readonly openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>
  readonly now: () => number
  readonly signal?: AbortSignal
}): GenerationHandle {
  const { claim } = input
  const { streamId, chatId, assistantMessageId, userMessageId } = claim
  const controller = new AbortController()
  const abort = () => controller.abort(input.signal?.reason)
  let submitAbortLinked = false
  const releaseSubmitAbort = () => {
    if (!submitAbortLinked) return
    submitAbortLinked = false
    input.signal?.removeEventListener('abort', abort)
  }
  if (input.signal?.aborted) abort()
  else if (input.signal) {
    submitAbortLinked = true
    input.signal.addEventListener('abort', abort, { once: true })
  }
  const evidence: GenerationExecutionEvidence = { phase: 'claimed' }
  const prepared = deferred<PreparedGeneration>()
  void prepared.promise.catch(() => undefined)
  let preparedSettled = false
  const execution = generationAdmissionController.execute(
    claim,
    (permit) =>
      runGeneration({
        claim,
        chatId,
        streamId,
        assistantMessageId,
        ...(userMessageId ? { userMessageId } : {}),
        permit,
        controller,
        evidence,
        prepared,
        openStream: input.openStream,
        markPreparedSettled: () => {
          preparedSettled = true
          releaseSubmitAbort()
        },
        now: input.now,
      }),
    { signal: controller.signal },
  )
  const completed = execution
    .catch((error: unknown): CompletedGeneration => {
      if (!preparedSettled) prepared.reject(error)
      if (controller.signal.aborted) generationAdmissionController.cancel(claim)
      else generationAdmissionController.fail(claim)
      const normalized = normalizeError(error, {
        midStream: evidence.phase === 'stream-event',
        cause: controller.signal.aborted ? 'abort' : 'internal',
      })
      return {
        streamId,
        chatId,
        assistantMessageId,
        ...(userMessageId ? { userMessageId } : {}),
        outcome: controller.signal.aborted ? 'abort' : 'error',
        error: normalized,
      }
    })
    .then((result) => {
      announceGenerationOutcome(streamId, result.outcome)
      return result
    })
  if (input.signal) {
    void completed.then(releaseSubmitAbort, releaseSubmitAbort)
  }
  return Object.freeze({
    streamId,
    chatId,
    prepared: prepared.promise,
    completed,
  })
}

async function runGeneration(input: {
  claim: GenerationAdmissionClaim
  chatId: ChatId
  streamId: string
  assistantMessageId: MessageId
  userMessageId?: MessageId
  permit: WorkspaceWritePermit
  controller: AbortController
  evidence: GenerationExecutionEvidence
  prepared: Deferred<PreparedGeneration>
  openStream: (input: GenerationTransportInput) => AsyncIterable<AssistantStreamChunk>
  markPreparedSettled: () => void
  now: () => number
}): Promise<CompletedGeneration> {
  let admission: GenerationAdmissionPayload | undefined = generationAdmissionController.takePayload(
    input.claim,
  )
  const promptMaterial = admission.promptMaterial
  let leasePermit: WorkspaceReservedPermit | undefined
  let writerPermit: WorkspaceReservedPermit | undefined
  let terminalPermit: WorkspaceReservedPermit | undefined
  let leasePermitOwned = false
  let writerPermitOwned = false
  let terminalPermitOwned = false
  let writer: StreamJournalWriter | undefined
  let streamLease: StreamLeaseHandle | undefined
  let ownershipReservation: StreamOwnershipReservation | undefined
  let terminalOwner: AttemptTerminalOwner | undefined
  let preparedState: PreparedAttemptState | undefined
  let routeDeliveryTransferred = false
  let dispatchState: DispatchState | undefined
  let planningFailure: unknown
  let selectedKeyId: KeyId | undefined
  const leaseApplications = createAttemptTerminalLeaseApplications({
    chatId: input.chatId,
    streamId: input.streamId,
    workspaceId: input.permit.workspaceId,
  })
  try {
    const activeLeasePermit = reserveWorkspaceChild(input.permit, 'stream-lease')
    leasePermit = activeLeasePermit
    leasePermitOwned = true
    const activeWriterPermit = reserveWorkspaceChild(input.permit, 'stream-writer')
    writerPermit = activeWriterPermit
    writerPermitOwned = true
    const activeTerminalPermit = reserveWorkspaceChild(input.permit, 'generation-finalizer')
    terminalPermit = activeTerminalPermit
    terminalPermitOwned = true
    const preparedIntent = admission.intent
    const leaseAdmission = preparedStreamLeaseAdmission(input, preparedIntent, input.now())
    leasePermitOwned = false
    ownershipReservation = await reserveStreamOwnership(activeLeasePermit, leaseAdmission, () =>
      input.controller.abort(),
    )
    try {
      preparedState = await prepareAttempt({ ...input, admission, lease: leaseAdmission })
    } catch (error) {
      if (error instanceof NoEligibleProvidersError) {
        useUiStore.getState().setZeroEligibleChatId(input.chatId)
      }
      throw error
    }
    let runtimeIntent: GenerationRuntimeIntent | undefined =
      compactGenerationRuntimeIntent(preparedIntent)
    admission = undefined
    streamLease = await adoptPreparedStreamLease(
      ownershipReservation,
      preparedState.result.lease,
      leaseApplications,
    )
    ownershipReservation = undefined
    terminalOwner = createWriterAttemptTerminalOwner({
      repository: getWorkspaceRepository,
      permit: activeTerminalPermit,
      handle: streamLease,
      journal: () => {
        if (!writer) throw new Error(`GenerationJournalUnavailable:${input.streamId}`)
        return writer
      },
    })
    const preparedForConsumer = preparedGenerationForConsumer(preparedIntent, preparedState)
    input.markPreparedSettled()
    routeDeliveryTransferred = true
    input.prepared.resolve(preparedForConsumer)
    writer = createStreamJournalWriter({
      permit: activeWriterPermit,
      port: workspaceStreamJournalFrameAppendPort,
      chatId: input.chatId,
      streamId: input.streamId,
      messageId: input.assistantMessageId,
      now: preparedState.result.lease.startedAt,
      fence: streamLease.fence,
    })
    writerPermitOwned = false

    attemptController.setPhase(input.streamId, 'planning')
    try {
      dispatchState = await planAndDispatch(
        { ...input, intent: runtimeIntent, promptMaterial },
        preparedState,
        streamLease,
      )
      input.evidence.phase = 'dispatched'
    } catch (error) {
      planningFailure = error
      if (error instanceof NoEligibleProvidersError) {
        useUiStore.getState().setZeroEligibleChatId(input.chatId)
      }
    } finally {
      promptMaterial.release()
    }
    const strategy = runtimeIntent.kind
    const initialContent =
      strategy === 'continue'
        ? []
        : preparedState.result.assistant.content.map((item) => structuredClone(item))
    const runtime = compactPreparedAttempt(preparedState, input.assistantMessageId)
    preparedState = undefined
    const accumulator = createStreamAccumulator({
      initialContent,
      now: runtime.lease.startedAt,
    })
    runtimeIntent = undefined
    const result = await runGenerationAttempt({
      open: () => {
        if (!dispatchState) throw new Error(`GenerationDispatchStateMissing:${input.streamId}`)
        const dispatch = dispatchState
        input.evidence.phase = 'transport-open'
        const source = input.openStream({
          connection: dispatch.profile,
          apiKey: dispatch.apiKey,
          apiKeyCandidates: dispatch.keyCandidates,
          requestPlan: dispatch.dispatchPlan,
          diagnosticId: input.streamId,
          signal: input.permit.signal,
          onKeyCandidateSelected: async (candidate) => {
            if (candidate.ref === null) return
            await (streamLease as StreamLeaseHandle).noteSelectedKey(candidate.ref)
            selectedKeyId = candidate.ref
            recordAcceptedConnectionRuntimeKeyPreference({
              chatId: input.chatId,
              profileId: dispatch.profile.id,
              ref: candidate.ref,
              index: candidate.index,
            })
          },
        })
        dispatch.dispatchPlan.wire = {}
        return source
      },
      ...(planningFailure
        ? {
            beforeDispatch: () => {
              throw planningFailure
            },
          }
        : {}),
      streamContract: dispatchState?.dispatchPlan ?? null,
      accumulator,
      journal: writer,
      errorPolicy:
        strategy === 'continue'
          ? CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY
          : SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      now: input.now,
      signal: input.permit.signal,
      isAborted: () => input.permit.signal.aborted,
      abortReason: () => abortReasonForCurrentPage(),
      registerLiveProjectionRequester: (requester) => {
        attemptController.setLiveProjectionRequester(input.streamId, requester)
      },
      onLiveProjectionFailure: () => input.controller.abort(),
      onStreamEvent: () => {
        input.evidence.phase = 'stream-event'
      },
      prepareLive: ({ now: publishedAt }) =>
        prepareLiveProjection(
          { ...input, strategy },
          runtime,
          dispatchState,
          accumulator,
          publishedAt,
        ),
      terminal: {
        complete: async (attemptResult) => {
          terminalPermitOwned = false
          const outcome = await runWorkspacePhase(activeTerminalPermit, () =>
            (terminalOwner as AttemptTerminalOwner).complete({
              prepareTerminal: async (sealedReceipt) => {
                attemptController.setPhase(input.streamId, 'finalizing')
                const finishedAt = sealedReceipt?.finishedAt ?? attemptResult.finishedAt
                const decision = sealedReceipt?.decision ?? attemptResult.decision
                const currentGeneration = dispatchState?.generation ?? runtime.assistantGeneration
                const reasoningCarryForward = streamLeaseReasoningCarryForward(
                  (streamLease as StreamLeaseHandle).lease,
                )
                const reasoningVisibility = streamLeaseReasoningVisibility(
                  (streamLease as StreamLeaseHandle).lease,
                )
                return projectAttemptTerminal(
                  strategy === 'continue'
                    ? {
                        kind: 'continuation',
                        streamId: input.streamId,
                        messageId: input.assistantMessageId,
                        fence: (streamLease as StreamLeaseHandle).fence,
                        accumulator,
                        startedAt: runtime.lease.startedAt,
                        finishedAt,
                        decision,
                        reasoningCarryForward,
                        reasoningVisibility,
                        strategy: dispatchState?.continuation?.strategy ?? 'unknown',
                        ...(dispatchState?.requestPlan.requestedModel
                          ? { requestedModel: dispatchState.requestPlan.requestedModel }
                          : {}),
                        ...(dispatchState?.requestPlan.apiUsed
                          ? { apiUsed: dispatchState.requestPlan.apiUsed }
                          : {}),
                        ...(selectedKeyId ? { selectedKeyId } : {}),
                      }
                    : {
                        kind: 'generation',
                        streamId: input.streamId,
                        messageId: input.assistantMessageId,
                        fence: (streamLease as StreamLeaseHandle).fence,
                        accumulator,
                        startedAt: runtime.lease.startedAt,
                        finishedAt,
                        decision,
                        reasoningCarryForward,
                        reasoningVisibility,
                        ...(currentGeneration ? { currentGeneration } : {}),
                        baseline: {
                          kind: 'exact',
                          body: runtime.assistantBody,
                          bodyVersion:
                            dispatchState?.dispatchHeader.bodyVersion ??
                            runtime.assistantBodyVersion,
                        },
                        requestedModel:
                          dispatchState?.requestPlan.requestedModel ??
                          runtime.assistantGeneration?.requestedModel ??
                          runtime.planningModel,
                        ...(dispatchState?.requestPlan.apiUsed
                          ? { apiUsed: dispatchState.requestPlan.apiUsed }
                          : {}),
                        attachmentRefs: runtime.assistantAttachmentRefs,
                        ...(selectedKeyId ? { selectedKeyId } : {}),
                        ...(dispatchState && selectedKeyId
                          ? {
                              requestCredential: {
                                profileId: dispatchState.profile.id,
                                selectedKeyId,
                              },
                            }
                          : {}),
                      },
                )
              },
            }),
          )
          if (outcome.canonical) {
            try {
              logCanonicalGenerationFinalized(
                input.streamId,
                outcome.receipt?.decision.outcome ?? attemptResult.decision.outcome,
                outcome.canonical.outcome,
                outcome.canonical.presentation,
              )
            } catch {
              // Diagnostic publication must not change the durable terminal outcome.
            }
          }
          if (!outcome.receipt) {
            throw new Error(`AttemptTerminalReceiptMissing:${input.streamId}`)
          }
          return outcome.receipt
        },
      },
    })
    return completionFromAttempt(runtime.prepared, result)
  } catch (error) {
    await terminalOwner?.handoffIfOpen('finalize-failed')
    throw error
  } finally {
    if (!routeDeliveryTransferred && preparedState?.routeDelivery?.kind === 'handoff') {
      preparedState.routeDelivery.handoff.cancel()
    }
    promptMaterial.release()
    if (ownershipReservation) await releaseStreamOwnershipReservation(ownershipReservation)
    if (leasePermitOwned && leasePermit) releaseWorkspaceChild(leasePermit)
    if (writerPermitOwned && writerPermit) releaseWorkspaceChild(writerPermit)
    if (terminalPermitOwned && terminalPermit) releaseWorkspaceChild(terminalPermit)
  }
}

function preparedGenerationForConsumer(
  intent: GenerationIntent,
  state: PreparedAttemptState,
): PreparedGeneration {
  if (intent.kind === 'new-chat-send') {
    if (!state.routeDelivery) throw new Error('GenerationNewChatRouteDeliveryMissing')
    return Object.freeze({
      ...state.prepared,
      [PREPARED_NEW_CHAT_GENERATION]: true as const,
      ...state.routeDelivery,
    }) satisfies PreparedNewChatGeneration
  }
  return state.prepared
}

function preparedStreamLeaseAdmission(
  input: {
    readonly streamId: string
    readonly chatId: ChatId
    readonly assistantMessageId: MessageId
    readonly permit: WorkspaceWritePermit
  },
  intent: GenerationIntent,
  startedAt: number,
): StreamLeaseAdmission {
  return Object.freeze({
    streamId: input.streamId,
    chatId: input.chatId,
    messageId: input.assistantMessageId,
    custody: 'writer',
    ownerClientId: getStreamClientId(),
    fenceToken: newId(),
    replacementEpoch: input.permit.replacementEpoch,
    startedAt,
    journalEventVersion: CURRENT_STREAM_JOURNAL_EVENT_VERSION,
    heartbeatAt: startedAt,
    attemptKind: intent.kind === 'continue' ? 'continuation' : 'generation',
  })
}

async function prepareAttempt(input: {
  claim: GenerationAdmissionClaim
  admission: GenerationAdmissionPayload
  chatId: ChatId
  streamId: string
  assistantMessageId: MessageId
  userMessageId?: MessageId
  permit: WorkspaceWritePermit
  controller: AbortController
  lease: StreamLeaseAdmission
  now: () => number
}): Promise<PreparedAttemptState> {
  const intent = input.admission.intent
  const configuration = input.admission.configuration
  const createdAt = input.lease.startedAt
  const chat =
    intent.kind === 'new-chat-send'
      ? createChatRow({
          id: input.chatId,
          settings: configuration.settings,
          ...(configuration.presetId ? { presetId: configuration.presetId } : {}),
          ...(intent.title !== undefined ? { title: intent.title } : {}),
          now: createdAt,
        })
      : undefined
  const settings = configuration.settings
  if (!settings.profileId) throw new Error(`GenerationProfileNotSelected:${input.chatId}`)
  if (!settings.model) throw new Error(`GenerationModelNotSelected:${input.chatId}`)

  const user = input.userMessageId
    ? preparedUserMessage({
        id: input.userMessageId,
        chatId: input.chatId,
        content:
          intent.kind === 'new-chat-send' || intent.kind === 'send' || intent.kind === 'edit-resend'
            ? intent.content
            : [],
        ...(intent.kind === 'new-chat-send' ||
        intent.kind === 'send' ||
        intent.kind === 'edit-resend'
          ? intent.attachmentRefs
            ? { attachmentRefs: intent.attachmentRefs }
            : {}
          : {}),
        createdAt,
      })
    : undefined
  const assistant =
    intent.kind === 'continue'
      ? undefined
      : preparedAssistantMessage({
          id: input.assistantMessageId,
          chatId: input.chatId,
          content: intent.prefillContent ?? [],
          model: settings.model,
          createdAt,
        })
  const prepareInput = prepareCommandInput(
    intent,
    chat,
    input.lease,
    user,
    assistant,
    configuration,
    input.admission.promptPath,
  )
  let routeDelivery: ConversationRouteDelivery | undefined
  const commit = await getWorkspaceRepository().execute(
    input.permit,
    {
      kind: 'attempt.prepare',
      input: prepareInput,
    },
    {
      localApplications: {
        conversation: (committed) => {
          input.admission.promptMaterial.seal(input.permit, committed.value.prompt)
          const committedEffect = conversationCommittedEffectForCommit(committed, input.chatId)
          const selection =
            committed.value.strategy === 'continue'
              ? null
              : committedConversationTransition(committed.value.selectionTransition, committed)
          routeDelivery = attemptController.applyLocalCommittedTransition(
            [
              {
                kind: 'observe-lease',
                lease: committed.value.lease,
                options: {
                  workspaceId: input.permit.workspaceId,
                  phase: 'preparing',
                },
              },
            ],
            () =>
              generationAdmissionController.acceptPrepared(input.claim, {
                selection,
                committedEffect,
              }),
          )
          return 'applied'
        },
      },
    },
  )
  return {
    result: commit.value,
    ...(routeDelivery ? { routeDelivery } : {}),
    prepared: {
      streamId: input.streamId,
      chatId: input.chatId,
      assistantMessageId: commit.value.assistant.id,
      ...(commit.value.user ? { userMessageId: commit.value.user.id } : {}),
    },
  }
}

function compactGenerationRuntimeIntent(intent: GenerationIntent): GenerationRuntimeIntent {
  if (intent.kind === 'continue') {
    return Object.freeze({ kind: 'continue', targetAssistantId: intent.targetAssistantId })
  }
  return Object.freeze({
    kind: intent.kind,
  })
}

function prepareCommandInput(
  intent: GenerationIntent,
  chat: Chat | undefined,
  lease: PrepareAttemptInput['lease'],
  user: Message | undefined,
  assistant: Message | undefined,
  configuration: GenerationAdmissionPayload['configuration'],
  promptPath: GenerationAdmissionPayload['promptPath'],
): PrepareAttemptInput {
  const existingChatConfiguration =
    configuration.kind === 'chat'
      ? {
          configurationClaim: {
            configurationVersion: configuration.configurationVersion,
            settings: configuration.settings,
            presetId: configuration.presetId,
            profile: configuration.profile,
            requestRevision: configuration.requestRevision,
            dispatchKeyRevisions: configuration.dispatchKeyRevisions,
            preferredDispatchKeyId: configuration.preferredDispatchKeyId,
            workspaceSettingOverrides: configuration.workspaceSettingOverrides,
            ...(configuration.savedTextTemplate
              ? { savedTextTemplate: configuration.savedTextTemplate }
              : {}),
          },
        }
      : undefined
  switch (intent.kind) {
    case 'new-chat-send':
      return {
        strategy: 'new-chat-send',
        promptPath,
        chat: required(chat),
        configurationClaim: {
          settings: configuration.settings,
          presetId: configuration.presetId,
          profile: configuration.profile,
          requestRevision: configuration.requestRevision,
          dispatchKeyRevisions: configuration.dispatchKeyRevisions,
          preferredDispatchKeyId: configuration.preferredDispatchKeyId,
          workspaceSettingOverrides: configuration.workspaceSettingOverrides,
          ...(configuration.savedTextTemplate
            ? { savedTextTemplate: configuration.savedTextTemplate }
            : {}),
        },
        lease,
        user: required(user),
        assistant: required(assistant),
      }
    case 'send':
      return {
        strategy: 'send',
        promptPath,
        ...required(existingChatConfiguration),
        lease,
        user: required(user),
        assistant: required(assistant),
      }
    case 'reply':
      return {
        strategy: 'reply',
        promptPath,
        ...required(existingChatConfiguration),
        lease,
        assistant: required(assistant),
      }
    case 'regenerate':
      return {
        strategy: 'regenerate',
        promptPath,
        ...required(existingChatConfiguration),
        lease,
        assistant: required(assistant),
        ...(intent.settingsPatch ? { persistCapturedConfiguration: true } : {}),
      }
    case 'edit-resend':
      return {
        strategy: 'edit-resend',
        promptPath,
        ...required(existingChatConfiguration),
        lease,
        user: required(user),
        assistant: required(assistant),
      }
    case 'continue':
      return {
        strategy: 'continue',
        promptPath,
        ...required(existingChatConfiguration),
        lease,
      }
  }
}

async function planAndDispatch(
  input: {
    intent: GenerationRuntimeIntent
    chatId: ChatId
    streamId: string
    assistantMessageId: MessageId
    permit: WorkspaceWritePermit
    now: () => number
    controller: AbortController
    promptMaterial: GenerationAdmissionPayload['promptMaterial']
  },
  prepared: PreparedAttemptState,
  streamLease: StreamLeaseHandle,
): Promise<DispatchState> {
  const prompt = prepared.result.prompt
  const requestLeafId = prompt.leafId
  const context = prepared.result.planning
  if ((prompt.headers.at(-1)?.id ?? null) !== requestLeafId) {
    throw new Error(`GenerationPlanningLeafMismatch:${input.streamId}:${requestLeafId}`)
  }
  const capturedKeys = captureConnectionRuntimeKeysFromRecords(
    context.profile,
    context.keyRecords.filter(
      (record): record is NonNullable<typeof record> => record !== undefined,
    ),
    {
      keyPreference: { ref: context.preferredDispatchKeyId },
      authority: input.permit,
    },
  )
  const keyCandidates = await primeConnectionRuntimeKeyCandidates(
    capturedKeys.candidates,
    input.permit.signal,
  )
  const primary = keyCandidates?.[0]
  if (!primary) throw new Error(`GenerationPrimaryKeyMissing:${context.profile.id}`)
  const apiKey = await primary.resolve()
  const planningReader = new GenerationPlanningReader(input.permit, context, apiKey)
  let continuation: ContinuationPlanningState | undefined
  const headers = prompt.headers
  const proofMessages = prompt.messageProofs
  if (input.intent.kind === 'continue') {
    const prepareProof = required(prepared.result.continuationBase)
    const presentation = prompt.knownPresentations.find(
      (candidate) => candidate.header.id === prepareProof.messageId,
    )
    if (
      !presentation ||
      prepareProof.streamId !== input.streamId ||
      prepareProof.messageId !== input.intent.targetAssistantId ||
      presentation.header.bodyVersion !== prepareProof.baseBodyVersion ||
      presentation.header.chatId !== input.chatId ||
      presentation.header.deleted ||
      presentation.header.role !== 'assistant'
    ) {
      throw new Error(`ContinuationTargetUnavailable:${input.intent.targetAssistantId}`)
    }
    continuation = {
      strategy: 'prompt',
      base: presentation,
      baseTextLength: textLengthOf(presentation.message.content),
    }
  }

  const requestFacts = await resolveAssistantRequestFacts({
    chat: context.chat,
    connection: context.profile,
    settings: context.chat.settings,
    contextFacts: mergeMessageContextRouteFacts(
      headers
        .filter((header) => !header.deleted && header.hiddenFromContext !== true)
        .map((header) => header.contextRouteFacts),
    ),
    signal: input.permit.signal,
    resources: planningReader,
  })
  const plannedRequest = await prepareAssistantRequestPlanFromContextSelection({
    chat: context.chat,
    connection: context.profile,
    facts: requestFacts,
    signal: input.permit.signal,
    resources: planningReader,
    selectContext: async (frame) => {
      const frameContinuation = continuation
        ? {
            ...continuation,
            strategy:
              context.chat.settings.continuePrefill === true
                ? frame.routing.prefillPlan.continueStrategy
                : ('prompt' as const),
          }
        : undefined
      const settings = continuationSettings(frame.settings, frameContinuation)
      const pendingMessages = pendingPlanningMessages(
        input,
        prepared,
        frameContinuation,
        context.chat.settings,
      )
      const selectedContext = await loadExactPlanningContext({
        context,
        headers,
        settings,
        ...(frame.capability ? { capabilities: frame.capability } : {}),
        pendingMessages,
        routing: frame.routing.route,
        planningReader,
        promptMaterial: input.promptMaterial,
        ...(frameContinuation ? { continuation: frameContinuation } : {}),
        authority: input.permit,
      })
      return { selectedContext, settings }
    },
  })
  const sendContext = plannedRequest.selectedContext
  logPreparedAssistantRequestPlan(
    input.intent.kind,
    context.chat.id,
    context.profile,
    sendContext.pathMessages.length,
    plannedRequest.requestPlan,
    plannedRequest.privacyPlan,
    input.streamId,
  )
  const requestPlan = plannedRequest.requestPlan
  if (continuation) {
    continuation = {
      ...continuation,
      strategy:
        context.chat.settings.continuePrefill === true
          ? requestPlan.prefillPlan.continueStrategy
          : 'prompt',
    }
  }
  const dispatchPlan: AssistantDispatchPlan = createAssistantDispatchPlan(requestPlan)
  const generation: DispatchedGenerationMeta = {
    model: requestPlan.settings.model,
    requestedModel: requestPlan.requestedModel,
    apiUsed: requestPlan.apiUsed,
    delivery:
      requestPlan.transport === 'openai-responses' && dispatchPlan.wire.stream !== true
        ? 'buffered'
        : 'streaming',
    status: 'streaming',
    integrity: 'clean',
    costSource: 'stream',
    startedAt: prepared.result.lease.startedAt,
    reasoningCarryForward: persistedReasoningCarryForwardFromEvidence(
      requestPlan.reasoningCarryForwardEvidence,
    ),
    reasoningVisibility: requestPlan.reasoning.inboundVisibility,
  }
  attemptController.setPhase(input.streamId, 'dispatching')
  const dispatchedAt = input.now()
  const calibration = calibrationEvidenceForRequest(requestPlan)
  const commit = await getWorkspaceRepository().execute(
    input.permit,
    {
      kind: 'attempt.dispatch',
      input: {
        streamId: input.streamId,
        fence: streamLease.fence,
        readSet: {
          chatId: input.chatId,
          messages: proofMessages,
          attachments: planningReader.attachmentProofs(),
        },
        generation,
        dispatchedAt,
        ...(input.intent.kind !== 'continue'
          ? {
              postCommitCalibration: {
                modelId: calibration.modelId,
                family: calibration.family,
                mode: context.calibration.mode,
                ...(calibration.promptBasis ? { promptBasis: calibration.promptBasis } : {}),
                promptAllowed: !calibration.promptBlocked,
                expectedChatGeneration: context.calibration.chatGeneration,
                expectedGlobalClearGeneration: tokenCalibrationClearGeneration(
                  context.calibration.global,
                ),
              },
            }
          : {}),
        ...(continuation
          ? {
              continuation: {
                strategy: continuation.strategy,
                prepareProof: required(prepared.result.continuationBase),
              },
            }
          : {}),
      },
    },
    {
      localApplications: {
        conversation: (committed) => {
          attemptController.applyLocalCommittedTransition(
            [
              {
                kind: 'observe-lease',
                lease: committed.value.lease,
                options: {
                  workspaceId: input.permit.workspaceId,
                  phase: 'streaming',
                },
              },
            ],
            () =>
              conversationController.applyCommittedEffect(
                conversationCommittedEffectForCommit(committed, input.chatId),
              ),
          )
          return 'applied'
        },
      },
    },
  )
  await streamLease.adoptTargetCommit(commit.value.lease)
  useAnnouncementStore.getState().announce({
    text: 'Assistant is responding.',
    eventKey: `stream-start:${input.streamId}`,
  })
  requestPlan.outboundPath = []
  requestPlan.wire = {}
  return {
    profile: context.profile,
    requestPlan,
    dispatchPlan,
    keyCandidates,
    apiKey,
    generation,
    dispatchHeader: commit.value.header,
    calibration,
    ...(continuation ? { continuation } : {}),
  }
}

function compactPreparedAttempt(
  prepared: PreparedAttemptState,
  assistantMessageId: MessageId,
): AttemptRuntimeState {
  if (prepared.result.assistantHeader.id !== assistantMessageId) {
    throw new Error(`PreparedAssistantIdentityMismatch:${assistantMessageId}`)
  }
  return {
    prepared: prepared.prepared,
    lease: prepared.result.lease,
    assistantAttachmentRefs: (prepared.result.assistant.attachmentRefs ?? []).map((ref) =>
      structuredClone(ref),
    ),
    assistantGeneration: prepared.result.assistant.generation
      ? structuredClone(prepared.result.assistant.generation)
      : undefined,
    assistantBody: messageBodyFields(prepared.result.assistant),
    assistantBodyVersion: prepared.result.assistantHeader.bodyVersion,
    planningModel: prepared.result.planning.chat.settings.model,
  }
}

function messageBodyFields(message: Message): MessageBodyFields {
  return {
    content: structuredClone(message.content),
    ...(message.reasoningEnvelope
      ? { reasoningEnvelope: structuredClone(message.reasoningEnvelope) }
      : {}),
    ...(message.toolCalls ? { toolCalls: structuredClone(message.toolCalls) } : {}),
    ...(message.refusal !== undefined ? { refusal: message.refusal } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
    ...(message.providerOutputItems
      ? { providerOutputItems: structuredClone(message.providerOutputItems) }
      : {}),
    ...(message.continuationAttempts
      ? { continuationAttempts: structuredClone(message.continuationAttempts) }
      : {}),
  }
}

async function loadExactPlanningContext(input: {
  context: GenerationPlanningSnapshot
  headers: readonly MessageHeaderRow[]
  settings: ChatSettings
  capabilities?: { maxPromptTokens?: number; contextLength?: number }
  pendingMessages: readonly Message[]
  routing: AssistantRoutingPlan
  planningReader: GenerationPlanningReader
  promptMaterial: GenerationAdmissionPayload['promptMaterial']
  continuation?: ContinuationPlanningState
  authority: WorkspaceWritePermit
}) {
  return loadGenerationContextForBranch({
    chat: input.context.chat,
    branchHeaders: input.headers,
    settings: input.settings,
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
    pendingMessages: input.pendingMessages,
    routing: input.routing,
    ...(input.continuation?.strategy === 'prefill'
      ? {
          prefillReasoningTargetId: input.continuation.base.message.id,
        }
      : {}),
    signal: input.authority.signal,
    authority: input.authority,
    planningResources: input.planningReader,
    promptMaterial: input.promptMaterial,
  })
}

function pendingPlanningMessages(
  input: { intent: GenerationRuntimeIntent; chatId: ChatId },
  prepared: PreparedAttemptState,
  continuation: ContinuationPlanningState | undefined,
  settings: ChatSettings,
): Message[] {
  if (continuation?.strategy === 'prompt') {
    const prompt = settings.continueUserPrompt
    if (prompt.trim().length === 0) return []
    const base = continuation.base.message
    return [
      {
        id: `continue-user:${base.id}`,
        chatId: input.chatId,
        parentId: base.id,
        siblingIndex: 0,
        turnId: `continue-user:${base.turnId}`,
        turnIndex: 0,
        createdAt: base.createdAt,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: prompt }],
        nodeVersion: 0,
        deleted: false,
      },
    ]
  }
  if (input.intent.kind === 'continue' || prepared.result.assistant.content.length === 0) {
    return []
  }
  return [
    {
      ...structuredClone(prepared.result.assistant),
      origin: 'prefill',
      content: structuredClone(prepared.result.assistant.content),
    },
  ]
}

function continuationSettings(
  settings: ChatSettings,
  continuation: ContinuationPlanningState | undefined,
): ChatSettings {
  if (!continuation || continuation.strategy === 'prefill') return settings
  return {
    ...settings,
    systemPrompt: resolveContinueSystemPromptTemplate(
      settings.continueSystemPrompt,
      settings.systemPrompt,
    ),
  }
}

function prepareLiveProjection(
  input: {
    strategy: GenerationRuntimeIntent['kind']
    chatId: ChatId
    streamId: string
    assistantMessageId: MessageId
    permit: WorkspaceWritePermit
  },
  prepared: AttemptRuntimeState,
  dispatch: DispatchState | undefined,
  accumulator: ReturnType<typeof createStreamAccumulator>,
  publishedAt: number,
): (() => boolean) | undefined {
  if (!dispatch) return undefined
  if (!attemptController.hasTargetSubscribers(input.chatId, input.assistantMessageId)) {
    return undefined
  }
  const projection = dispatch.continuation
    ? projectContinuationLiveAttempt({
        streamId: input.streamId,
        chatId: input.chatId,
        messageId: input.assistantMessageId,
        workspaceId: input.permit.workspaceId,
        replacementEpoch: input.permit.replacementEpoch,
        accumulator,
        baseContent: dispatch.continuation.base.message.content,
        baseTextLength: dispatch.continuation.baseTextLength,
        publishedAt,
      })
    : projectGenerationLiveAttempt({
        streamId: input.streamId,
        chatId: input.chatId,
        messageId: input.assistantMessageId,
        workspaceId: input.permit.workspaceId,
        replacementEpoch: input.permit.replacementEpoch,
        accumulator,
        requestedModel: dispatch.requestPlan.requestedModel,
        apiUsed: dispatch.requestPlan.apiUsed,
        publishedAt,
        startedAt: prepared.lease.startedAt,
        reasoningCarryForward: dispatch.generation.reasoningCarryForward,
        reasoningVisibility: dispatch.generation.reasoningVisibility,
      })
  return () => attemptController.publishLiveProjection(projection)
}

function completionFromAttempt(
  prepared: PreparedGeneration,
  result: GenerationAttemptResult,
): CompletedGeneration {
  return {
    ...prepared,
    outcome: result.outcome,
    ...(result.finishReason ? { finishReason: result.finishReason as FinishReason } : {}),
    ...(result.error ? { error: result.error } : {}),
  }
}

function preparedUserMessage(input: {
  id: MessageId
  chatId: ChatId
  content: readonly ContentItem[]
  attachmentRefs?: readonly AttachmentRef[]
  createdAt: number
}): Message {
  return {
    id: input.id,
    chatId: input.chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: input.createdAt,
    role: 'user',
    origin: 'user',
    content: structuredClone([...input.content]),
    ...(input.attachmentRefs ? { attachmentRefs: structuredClone([...input.attachmentRefs]) } : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

function preparedAssistantMessage(input: {
  id: MessageId
  chatId: ChatId
  content: readonly ContentItem[]
  model: string
  createdAt: number
}): Message {
  return {
    id: input.id,
    chatId: input.chatId,
    parentId: null,
    siblingIndex: 0,
    turnId: newId(),
    turnIndex: 0,
    createdAt: input.createdAt,
    role: 'assistant',
    origin: 'generated',
    content: structuredClone([...input.content]),
    generation: {
      model: input.model,
      requestedModel: input.model,
      status: 'preparing',
      integrity: 'clean',
      costSource: 'stream',
      startedAt: input.createdAt,
      reasoningCarryForward: 'none',
      reasoningVisibility: UNKNOWN_INBOUND_REASONING_VISIBILITY,
    },
    nodeVersion: 0,
    deleted: false,
  }
}

function defaultOpenStream(input: GenerationTransportInput): AsyncIterable<AssistantStreamChunk> {
  const candidates = input.apiKeyCandidates.map((candidate) => ({
    resolve: candidate.resolve,
  }))
  return openAssistantRequestStream({
    connection: input.connection,
    apiKey: input.apiKey,
    apiKeyCandidates: candidates,
    onKeyCandidateSelected: (_candidate, _candidateIndex) => {
      const candidate = input.apiKeyCandidates[_candidateIndex]
      if (!candidate) throw new Error(`GenerationSelectedKeyMissing:${_candidateIndex}`)
      return input.onKeyCandidateSelected(candidate)
    },
    requestPlan: input.requestPlan,
    diagnosticId: input.diagnosticId,
    signal: input.signal,
  })
}

function calibrationEvidenceForRequest(
  requestPlan: AssistantRequestPlan,
): CalibrationDispatchEvidence {
  const hasNonTextOutbound = requestPlan.outboundPath.some((message) =>
    message.content.some((item) => item.type !== 'text' && item.type !== 'output_text'),
  )
  const promptBasis = derivePromptCalibrationBasis({
    sentPath: requestPlan.outboundPath,
    systemPrompt: requestPlan.settings.systemPrompt,
    family: requestPlan.outboundTokenizer,
    mediaTokens: requestPlan.hasAttachmentContext ? 1 : 0,
    reasoningEchoOpts: requestPlan.outboundReasoningOpts,
  })
  return {
    modelId: requestPlan.settings.model,
    family: requestPlan.outboundTokenizer,
    promptBasis,
    promptBlocked:
      requestPlan.hasAttachmentContext ||
      hasNonTextOutbound ||
      requestHasTools(requestPlan.wire) ||
      requestPlan.outboundPath.some(messageHasToolArtifacts),
  }
}

function requestHasTools(wire: unknown): boolean {
  if (!wire || typeof wire !== 'object') return false
  const tools = (wire as { tools?: unknown }).tools
  return Array.isArray(tools) && tools.length > 0
}

function textLengthOf(content: readonly ContentItem[]): number {
  let length = 0
  for (const item of content) {
    if (item.type === 'text' || item.type === 'output_text') length += item.text.length
  }
  return length
}

function abortReasonForCurrentPage(): AbortReason {
  return isPageHiding() ? 'tab-close' : 'user'
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('GenerationRequiredValueMissing')
  return value
}

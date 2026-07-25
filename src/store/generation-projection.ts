import type { AttemptTerminalFailure } from '../core/attempt-outcome'
import { toPersistedAttemptFailure } from '../core/attempt-outcome'
import { messageRenderableTextSemanticsEqual } from '../core/branch-flatten'
import { buildContinuationAttempt } from '../core/continuation-attempt'
import {
  type AppliedMessageSemanticEffect,
  appliedMessageRequestSemanticsEqual,
  createAppliedMessageView,
} from '../core/continuation-content'
import {
  projectStreamAccumulatorFinal,
  projectStreamAccumulatorLive,
  projectStreamAccumulatorLiveAttemptArtifacts,
  projectStreamAccumulatorLiveContent,
  projectStreamGeneration,
  type StreamAccumulator,
  streamAccumulatorAnnotations,
  streamAccumulatorText,
} from '../core/stream-accumulator'
import type {
  AbortReason,
  AttachmentRef,
  ChatId,
  ContentAnnotation,
  ContentItem,
  ContinuationAttemptDraft,
  ContinuationAttemptStatus,
  ContinuationAttemptStrategy,
  GenerationMeta,
  MessageId,
  PersistedInboundReasoningVisibility,
  PersistedReasoningCarryForward,
} from '../core/types'
import type { AttemptLiveProjection } from './attempt-controller'
import type { MessageBodyFields } from './message-storage'

interface AttemptProjectionIdentity {
  streamId: string
  chatId: ChatId
  messageId: MessageId
  workspaceId: string
  replacementEpoch: number
}

export interface GenerationLiveProjectionInput extends AttemptProjectionIdentity {
  accumulator: StreamAccumulator
  requestedModel: string
  apiUsed: GenerationMeta['apiUsed']
  publishedAt: number
  startedAt: number
  reasoningCarryForward: PersistedReasoningCarryForward
  reasoningVisibility: PersistedInboundReasoningVisibility
}

export interface ContinuationLiveProjectionInput extends AttemptProjectionIdentity {
  accumulator: StreamAccumulator
  baseContent: readonly ContentItem[]
  baseTextLength: number
  publishedAt: number
}

type GenerationTerminalStatus = Extract<
  NonNullable<GenerationMeta['status']>,
  'done' | 'error' | 'abort' | 'interrupted'
>

export interface GenerationTerminalProjectionInput {
  streamId: string
  accumulator: StreamAccumulator
  currentGeneration?: GenerationMeta
  requestedModel: string
  apiUsed?: GenerationMeta['apiUsed']
  startedAt: number
  finishedAt: number
  status: GenerationTerminalStatus
  reasoningCarryForward: PersistedReasoningCarryForward
  reasoningVisibility: PersistedInboundReasoningVisibility
  abortReason?: AbortReason
  error?: AttemptTerminalFailure
}

export interface GenerationTerminalProjection {
  body: MessageBodyFields
  generation: GenerationMeta
}

export interface GenerationTerminalBodyState {
  readonly body: MessageBodyFields
  readonly generation?: GenerationMeta
  readonly attachmentRefs?: readonly AttachmentRef[]
}

export interface ContinuationTerminalProjectionInput {
  streamId: string
  accumulator: StreamAccumulator
  strategy: ContinuationAttemptStrategy
  status: ContinuationAttemptStatus
  reasoningCarryForward: PersistedReasoningCarryForward
  reasoningVisibility: PersistedInboundReasoningVisibility
  requestedModel?: string
  apiUsed?: GenerationMeta['apiUsed']
  startedAt: number
  finishedAt: number
  abortReason?: AbortReason
  error?: AttemptTerminalFailure
}

export interface ContinuationTerminalProjection {
  continuationText: string
  continuationAnnotations: readonly ContentAnnotation[]
  attempt: ContinuationAttemptDraft
}

export function projectGenerationLiveAttempt(
  input: GenerationLiveProjectionInput,
): AttemptLiveProjection {
  const projection = projectStreamAccumulatorLive(input.accumulator, {
    requestedModel: input.requestedModel,
    apiUsed: input.apiUsed,
    now: input.publishedAt,
    generationStartedAt: input.startedAt,
    reasoningCarryForward: input.reasoningCarryForward,
    reasoningVisibility: input.reasoningVisibility,
  })
  if (!projection.generation.id) delete projection.generation.id
  projection.generation.requestedModel = input.requestedModel
  if (!projection.generation.model) projection.generation.model = input.requestedModel
  return {
    attemptKind: 'generation',
    streamId: input.streamId,
    chatId: input.chatId,
    messageId: input.messageId,
    workspaceId: input.workspaceId,
    replacementEpoch: input.replacementEpoch,
    ...projection,
  }
}

export function projectContinuationLiveAttempt(
  input: ContinuationLiveProjectionInput,
): AttemptLiveProjection {
  const deltaContent = projectStreamAccumulatorLiveContent(input.accumulator).filter(
    (item) => (item.type !== 'text' && item.type !== 'output_text') || item.text.length > 0,
  )
  const artifacts = projectStreamAccumulatorLiveAttemptArtifacts(input.accumulator)
  return {
    attemptKind: 'continuation',
    streamId: input.streamId,
    chatId: input.chatId,
    messageId: input.messageId,
    workspaceId: input.workspaceId,
    replacementEpoch: input.replacementEpoch,
    baseContent: input.baseContent,
    content: deltaContent,
    ...artifacts,
    textLength: input.baseTextLength + input.accumulator.textLength,
    updatedAt: input.publishedAt,
  }
}

export function projectGenerationTerminalAttempt(
  input: GenerationTerminalProjectionInput,
): GenerationTerminalProjection {
  const final = projectStreamAccumulatorFinal(input.accumulator)
  const generation = projectStreamGeneration(
    input.currentGeneration,
    input.accumulator,
    input.requestedModel,
    {
      ...(input.apiUsed !== undefined ? { apiUsed: input.apiUsed } : {}),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      reasoningCarryForward: input.reasoningCarryForward,
      reasoningVisibility: input.reasoningVisibility,
    },
  )
  if (!generation.id) delete generation.id
  generation.requestedModel = input.requestedModel
  if (!generation.model) generation.model = input.requestedModel
  generation.status = input.status
  delete generation.abortReason
  delete generation.error
  if (input.status === 'abort' || input.status === 'interrupted') {
    generation.abortReason =
      input.abortReason ?? (input.status === 'interrupted' ? 'tab-close' : 'user')
  }
  const error = input.error ?? input.accumulator.midStreamError
  if (error) generation.error = toPersistedAttemptFailure(error, 'provider')

  return {
    body: {
      content: final.content,
      ...(final.reasoningEnvelope ? { reasoningEnvelope: final.reasoningEnvelope } : {}),
      ...(final.toolCalls ? { toolCalls: final.toolCalls } : {}),
      ...(final.phase !== undefined ? { phase: final.phase } : {}),
      ...(final.providerOutputItems ? { providerOutputItems: final.providerOutputItems } : {}),
    },
    generation,
  }
}

export function generationTerminalBodySemanticEffect(input: {
  readonly before: GenerationTerminalBodyState
  readonly after: GenerationTerminalBodyState
}): AppliedMessageSemanticEffect {
  const before = {
    ...input.before.body,
    ...(input.before.generation ? { generation: input.before.generation } : {}),
    ...(input.before.attachmentRefs
      ? { attachmentRefs: input.before.attachmentRefs.map((ref) => structuredClone(ref)) }
      : {}),
  }
  const after = {
    ...input.after.body,
    ...(input.after.generation ? { generation: input.after.generation } : {}),
    ...(input.after.attachmentRefs
      ? { attachmentRefs: input.after.attachmentRefs.map((ref) => structuredClone(ref)) }
      : {}),
  }
  const beforeView = createAppliedMessageView(before)
  const afterView = createAppliedMessageView(after)
  return {
    requestContextChanged: !appliedMessageRequestSemanticsEqual(beforeView, afterView),
    branchCorpusChanged:
      beforeView.phase !== afterView.phase ||
      !messageRenderableTextSemanticsEqual(before, after, beforeView, afterView),
  }
}

export function projectContinuationTerminalAttempt(
  input: ContinuationTerminalProjectionInput,
): ContinuationTerminalProjection {
  return {
    continuationText: streamAccumulatorText(input.accumulator),
    continuationAnnotations: streamAccumulatorAnnotations(input.accumulator),
    attempt: buildContinuationAttempt({
      streamId: input.streamId,
      strategy: input.strategy,
      status: input.status,
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(input.apiUsed ? { apiUsed: input.apiUsed } : {}),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      reasoningCarryForward: input.reasoningCarryForward,
      reasoningVisibility: input.reasoningVisibility,
      accumulator: input.accumulator,
      ...(input.abortReason ? { abortReason: input.abortReason } : {}),
      ...(input.error ? { error: input.error } : {}),
    }),
  }
}

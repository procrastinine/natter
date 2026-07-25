import { sameValue } from '../lib/same-value'
import {
  combineReasoningPresentations,
  projectReasoningPresentation,
  type ReasoningEnvelopeLiveProjection,
  type ReasoningPresentation,
} from './reasoning-envelope'
import type {
  ContentAnnotation,
  ContentItem,
  ContinuationAttempt,
  Message,
  MessageAttemptOwner,
  PersistedInboundReasoningVisibility,
  ProviderOutputItem,
  ReasoningEnvelopeV2,
  ToolCall,
} from './types'

export const GENERATION_ATTEMPT_OWNER = Object.freeze({ kind: 'generation' } as const)
const UNKNOWN_REASONING_VISIBILITY = Object.freeze({ disclosure: 'unknown' } as const)
const EMPTY_TOOL_CALLS = Object.freeze([]) as readonly ToolCall[]
const EMPTY_CONTINUATION_ATTEMPTS = Object.freeze([]) as readonly ContinuationAttempt[]

interface AppliedMessageAttemptArtifacts {
  readonly owner: MessageAttemptOwner
  readonly reasoningEnvelope?: ReasoningEnvelopeV2
  readonly reasoningVisibility: PersistedInboundReasoningVisibility
  readonly providerOutputItems?: readonly ProviderOutputItem[]
  readonly toolCalls?: readonly ToolCall[]
  readonly phase?: Message['phase']
}

export type AppliedMessageAttempt =
  | (AppliedMessageAttemptArtifacts &
      Readonly<{
        kind: 'generation'
        metadata?: Message['generation']
      }>)
  | (AppliedMessageAttemptArtifacts &
      Readonly<{
        kind: 'continuation'
        metadata: ContinuationAttempt
      }>)

export interface AppliedMessageAttemptSource {
  readonly content: Message['content']
  readonly generation?: Message['generation'] | undefined
  readonly reasoningEnvelope?: ReasoningEnvelopeV2 | undefined
  readonly providerOutputItems?: readonly ProviderOutputItem[] | undefined
  readonly toolCalls?: readonly ToolCall[] | undefined
  readonly phase?: Message['phase'] | undefined
  readonly continuationAttempts?: Message['continuationAttempts'] | undefined
}

export interface AppliedMessageView {
  readonly content: Message['content']
  readonly attempts: readonly AppliedMessageAttempt[]
  readonly allContinuationAttempts: readonly ContinuationAttempt[]
  readonly latestAttempt: AppliedMessageAttempt
  readonly toolCalls: readonly ToolCall[]
  readonly phase?: Message['phase']
  readonly providerOutputCount: number
}

export interface AppliedMessageLiveReasoning {
  readonly attemptKind: 'generation' | 'continuation'
  readonly streamId: string
  readonly projection: ReasoningEnvelopeLiveProjection
}

export interface AppliedMessageSemanticEffect {
  readonly requestContextChanged: boolean
  readonly branchCorpusChanged: boolean
}

export function createAppliedMessageView(message: AppliedMessageAttemptSource): AppliedMessageView {
  const root: AppliedMessageAttempt = {
    kind: 'generation',
    owner: GENERATION_ATTEMPT_OWNER,
    reasoningVisibility: message.generation?.reasoningVisibility ?? UNKNOWN_REASONING_VISIBILITY,
    ...(message.generation ? { metadata: message.generation } : {}),
    ...(message.reasoningEnvelope ? { reasoningEnvelope: message.reasoningEnvelope } : {}),
    ...(message.providerOutputItems ? { providerOutputItems: message.providerOutputItems } : {}),
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  }
  const attempts: AppliedMessageAttempt[] = [root]
  const continuationAttempts = message.continuationAttempts ?? EMPTY_CONTINUATION_ATTEMPTS
  let latestAttempt: AppliedMessageAttempt = root
  let phase = message.phase
  let providerOutputCount = message.providerOutputItems?.length ?? 0
  let combinedToolCalls: ToolCall[] | undefined
  const rootToolCalls = message.toolCalls ?? EMPTY_TOOL_CALLS
  for (const continuation of continuationAttempts) {
    if (continuation.application.kind !== 'applied') continue
    const attempt: AppliedMessageAttempt = {
      kind: 'continuation',
      owner: { kind: 'continuation', streamId: continuation.streamId },
      metadata: continuation,
      reasoningVisibility: continuation.reasoningVisibility,
      ...(continuation.reasoningEnvelope
        ? { reasoningEnvelope: continuation.reasoningEnvelope }
        : {}),
      ...(continuation.providerOutputItems
        ? { providerOutputItems: continuation.providerOutputItems }
        : {}),
      ...(continuation.toolCalls ? { toolCalls: continuation.toolCalls } : {}),
      ...(continuation.phase !== undefined ? { phase: continuation.phase } : {}),
    }
    attempts.push(attempt)
    latestAttempt = attempt
    if (continuation.phase !== undefined) phase = continuation.phase
    providerOutputCount += continuation.providerOutputItems?.length ?? 0
    if (continuation.toolCalls && continuation.toolCalls.length > 0) {
      combinedToolCalls ??= [...rootToolCalls]
      combinedToolCalls.push(...continuation.toolCalls)
    }
  }
  return {
    content: message.content,
    attempts,
    allContinuationAttempts: continuationAttempts,
    latestAttempt,
    toolCalls: combinedToolCalls ?? rootToolCalls,
    ...(phase !== undefined ? { phase } : {}),
    providerOutputCount,
  }
}

export function appliedMessageRequestSemanticsEqual(
  left: AppliedMessageView,
  right: AppliedMessageView,
): boolean {
  return (
    sameValue(left.content, right.content) &&
    sameValue(left.toolCalls, right.toolCalls) &&
    left.phase === right.phase &&
    appliedAttemptEnvelopeSequenceEqual(left.attempts, right.attempts) &&
    appliedAttemptMemberSequenceEqual(
      left.attempts,
      right.attempts,
      (attempt) => attempt.providerOutputItems,
    )
  )
}

export function appendedContinuationSemanticEffect(
  current: AppliedMessageView,
  attempt: ContinuationAttempt,
  content: Readonly<{
    requestChanged: boolean
    corpusChanged: boolean
  }>,
): AppliedMessageSemanticEffect {
  if (attempt.application.kind !== 'applied') {
    return { requestContextChanged: false, branchCorpusChanged: false }
  }
  const phaseChanged = attempt.phase !== undefined && attempt.phase !== current.phase
  const toolCallsChanged = (attempt.toolCalls?.length ?? 0) > 0
  return {
    requestContextChanged:
      content.requestChanged ||
      phaseChanged ||
      toolCallsChanged ||
      reasoningEnvelopeHasStoredSemantics(attempt.reasoningEnvelope) ||
      (attempt.providerOutputItems?.length ?? 0) > 0,
    branchCorpusChanged: content.corpusChanged || phaseChanged || toolCallsChanged,
  }
}

export function projectAppliedMessageReasoningPresentation(
  view: AppliedMessageView,
  live?: AppliedMessageLiveReasoning,
): ReasoningPresentation {
  const presentations: ReasoningPresentation[] = []
  let matchedLiveAttempt = false
  for (const attempt of view.attempts) {
    const isLive =
      live !== undefined &&
      (attempt.kind === 'generation'
        ? live.attemptKind === 'generation'
        : live.attemptKind === 'continuation' && live.streamId === attempt.metadata.streamId)
    if (isLive) {
      matchedLiveAttempt = true
      presentations.push(
        projectReasoningPresentation({
          kind: 'live',
          owner: attempt.owner,
          projection: live.projection,
        }),
      )
      continue
    }
    presentations.push(
      projectReasoningPresentation({
        kind: 'durable',
        owner: attempt.owner,
        ...(attempt.reasoningEnvelope ? { envelope: attempt.reasoningEnvelope } : {}),
      }),
    )
  }
  if (
    live?.attemptKind === 'continuation' &&
    !matchedLiveAttempt &&
    !view.allContinuationAttempts.some(
      (attempt) => attempt.streamId === live.streamId && attempt.application.kind === 'unapplied',
    )
  ) {
    presentations.push(
      projectReasoningPresentation({
        kind: 'live',
        owner: { kind: 'continuation', streamId: live.streamId },
        projection: live.projection,
      }),
    )
  }
  return combineReasoningPresentations(presentations)
}

function appliedAttemptEnvelopeSequenceEqual(
  left: readonly AppliedMessageAttempt[],
  right: readonly AppliedMessageAttempt[],
): boolean {
  let leftIndex = 0
  let rightIndex = 0
  for (;;) {
    while (
      leftIndex < left.length &&
      !reasoningEnvelopeHasStoredSemantics(left[leftIndex]?.reasoningEnvelope)
    ) {
      leftIndex += 1
    }
    while (
      rightIndex < right.length &&
      !reasoningEnvelopeHasStoredSemantics(right[rightIndex]?.reasoningEnvelope)
    ) {
      rightIndex += 1
    }
    const leftEnvelope = left[leftIndex]?.reasoningEnvelope
    const rightEnvelope = right[rightIndex]?.reasoningEnvelope
    if (!leftEnvelope || !rightEnvelope) return leftEnvelope === rightEnvelope
    if (!sameValue(leftEnvelope, rightEnvelope)) return false
    leftIndex += 1
    rightIndex += 1
  }
}

function reasoningEnvelopeHasStoredSemantics(
  envelope: ReasoningEnvelopeV2 | undefined,
): envelope is ReasoningEnvelopeV2 {
  return envelope !== undefined && (envelope.visible.length > 0 || envelope.carriers.length > 0)
}

function appliedAttemptMemberSequenceEqual<T>(
  left: readonly AppliedMessageAttempt[],
  right: readonly AppliedMessageAttempt[],
  members: (attempt: AppliedMessageAttempt) => readonly T[] | undefined,
): boolean {
  let leftAttemptIndex = 0
  let rightAttemptIndex = 0
  let leftMemberIndex = 0
  let rightMemberIndex = 0
  for (;;) {
    while (leftAttemptIndex < left.length) {
      const values = members(left[leftAttemptIndex] as AppliedMessageAttempt)
      if (values && leftMemberIndex < values.length) break
      leftAttemptIndex += 1
      leftMemberIndex = 0
    }
    while (rightAttemptIndex < right.length) {
      const values = members(right[rightAttemptIndex] as AppliedMessageAttempt)
      if (values && rightMemberIndex < values.length) break
      rightAttemptIndex += 1
      rightMemberIndex = 0
    }
    const leftValue =
      leftAttemptIndex < left.length
        ? members(left[leftAttemptIndex] as AppliedMessageAttempt)?.[leftMemberIndex]
        : undefined
    const rightValue =
      rightAttemptIndex < right.length
        ? members(right[rightAttemptIndex] as AppliedMessageAttempt)?.[rightMemberIndex]
        : undefined
    if (leftValue === undefined || rightValue === undefined) return leftValue === rightValue
    if (!sameValue(leftValue, rightValue)) return false
    leftMemberIndex += 1
    rightMemberIndex += 1
  }
}

export function appendContinuationText(
  content: readonly ContentItem[],
  continuationText: string,
  continuationAnnotations: readonly ContentAnnotation[] = [],
): ContentItem[] {
  const next = structuredClone(content) as ContentItem[]
  if (continuationText.length === 0 && continuationAnnotations.length === 0) return next

  const finalItem = next.at(-1)
  if (
    finalItem?.type === 'output_text' &&
    (finalItem.annotations === undefined || finalItem.annotations.length === 0)
  ) {
    const annotationOffset = finalItem.text.length
    finalItem.text += continuationText
    if (continuationAnnotations.length > 0) {
      finalItem.annotations = continuationAnnotations.map((annotation) => ({
        ...structuredClone(annotation),
        startIndex: annotationOffset + annotation.startIndex,
        endIndex: annotationOffset + annotation.endIndex,
      }))
    }
    return next
  }

  next.push({
    type: 'output_text',
    text: continuationText,
    ...(continuationAnnotations.length > 0
      ? { annotations: structuredClone([...continuationAnnotations]) }
      : {}),
  })
  return next
}

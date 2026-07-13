import type { ApiError } from '../api/errors'
import { toPersistedAttemptFailure } from './attempt-outcome'
import { projectStreamAccumulatorFinalMetadata, type StreamAccumulator } from './stream-accumulator'
import type {
  AbortReason,
  ContinuationAttempt,
  ContinuationAttemptStatus,
  ContinuationAttemptStrategy,
  GenerationMeta,
} from './types'

export interface BuildContinuationAttemptInput {
  streamId: string
  strategy: ContinuationAttemptStrategy
  status: ContinuationAttemptStatus
  requestedModel?: string
  apiUsed?: GenerationMeta['apiUsed']
  startedAt: number
  finishedAt: number
  accumulator: StreamAccumulator
  abortReason?: AbortReason
  error?: Pick<ApiError, 'code' | 'message' | 'httpStatus'>
  unappliedText?: string
}

export function buildContinuationAttempt(
  input: BuildContinuationAttemptInput,
): ContinuationAttempt {
  const { accumulator } = input
  const final = projectStreamAccumulatorFinalMetadata(accumulator)
  const error = input.error ?? accumulator.midStreamError
  const model = accumulator.model ?? input.requestedModel

  return {
    streamId: input.streamId,
    strategy: input.strategy,
    status: input.status,
    integrity: input.accumulator.integritySummary.count > 0 ? 'degraded' : 'clean',
    ...(input.accumulator.integritySummary.count > 0
      ? { integritySummary: structuredClone(input.accumulator.integritySummary) }
      : {}),
    ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
    ...(model ? { model } : {}),
    ...(input.apiUsed ? { apiUsed: input.apiUsed } : {}),
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    costSource: 'stream',
    ...(accumulator.generationId ? { generationId: accumulator.generationId } : {}),
    ...(accumulator.provider ? { provider: accumulator.provider } : {}),
    ...(accumulator.firstTextAt !== undefined ? { firstTextAt: accumulator.firstTextAt } : {}),
    ...(accumulator.reasoningStartedAt !== undefined
      ? { reasoningStartedAt: accumulator.reasoningStartedAt }
      : {}),
    ...(accumulator.reasoningFinishedAt !== undefined
      ? { reasoningFinishedAt: accumulator.reasoningFinishedAt }
      : {}),
    ...(accumulator.usage ? { usage: structuredClone(accumulator.usage) } : {}),
    ...(accumulator.usage?.cost !== undefined ? { cost: accumulator.usage.cost } : {}),
    ...(accumulator.finishReason
      ? {
          finishReason: accumulator.finishReason as NonNullable<
            ContinuationAttempt['finishReason']
          >,
        }
      : {}),
    ...(input.abortReason ? { abortReason: input.abortReason } : {}),
    ...(input.unappliedText ? { unappliedText: input.unappliedText } : {}),
    ...(error ? { error: toPersistedAttemptFailure(error, 'provider') } : {}),
    ...(final.reasoningDetails
      ? { reasoningDetails: structuredClone(final.reasoningDetails) }
      : {}),
    ...(final.toolCalls ? { toolCalls: structuredClone(final.toolCalls) } : {}),
    ...(final.phase !== undefined ? { phase: final.phase } : {}),
    ...(final.providerOutputItems
      ? { providerOutputItems: structuredClone(final.providerOutputItems) }
      : {}),
  }
}

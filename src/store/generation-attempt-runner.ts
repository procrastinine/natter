import { splitAssistantStream } from '../api/assistant-lanes'
import type { AssistantStreamChunk } from '../api/assistant-stream'
import {
  ApiError,
  apiErrorFromAttemptTerminalFailure,
  apiErrorFromGenerationStreamFailure,
  normalizeError,
} from '../api/errors'
import type { AssistantAttemptContract } from '../core/api-choice'
import {
  type AttemptTerminalDecision,
  type AttemptTerminalReceipt,
  normalizeAttemptTerminalDecision,
} from '../core/attempt-outcome'
import type { CanonicalStreamEventV2 } from '../core/generation-stream-events'
import type { StreamLaneEvent } from '../core/generation-stream-live-events'
import {
  applyStreamAccumulatorEvent,
  foldStreamAccumulatorEvent,
  markStreamAccumulatorPublished,
  releaseStreamAccumulatorBuffers,
  STREAM_LIVE_UPDATE_INTERVAL_MS,
  type StreamAccumulator,
  shouldPublishStreamAccumulatorLive,
} from '../core/stream-accumulator'
import type { AbortReason } from '../core/types'
import { raceWithAbortSignal } from '../lib/abort'
import { errorFromUnknown } from '../lib/error'

type GenerationAttemptOutcome = AttemptTerminalDecision['outcome']

export interface GenerationAttemptErrorPolicy {
  thrownNetworkApiError: 'abort' | 'error'
}

export const SEND_GENERATION_ATTEMPT_ERROR_POLICY = {
  thrownNetworkApiError: 'abort',
} as const satisfies GenerationAttemptErrorPolicy

export const CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY = {
  thrownNetworkApiError: 'error',
} as const satisfies GenerationAttemptErrorPolicy

export type GenerationAttemptResult =
  | {
      readonly outcome: 'done'
      readonly finishReason?: string
      readonly error?: never
      readonly abortReason?: never
    }
  | {
      readonly outcome: 'error'
      readonly error: ApiError
      readonly finishReason?: string
      readonly abortReason?: never
    }
  | {
      readonly outcome: 'abort'
      readonly abortReason: AbortReason
      readonly finishReason?: string
      readonly error?: never
    }

interface GenerationAttemptJournal {
  append(event: CanonicalStreamEventV2, now: number): void
  flush(request: { mode: 'scheduled'; now: number }): void
  flush(request?: { mode: 'immediate' }): Promise<void>
  checkpoint(): Promise<void>
  backpressure(): Promise<void> | undefined
  settle(): Promise<void>
  release(): void
}

interface GenerationAttemptFinalizationContext {
  readonly decision: AttemptTerminalDecision
  readonly accumulator: StreamAccumulator
  readonly finishedAt: number
}

export interface GenerationAttemptRunnerInput {
  open: () => AsyncIterable<AssistantStreamChunk>
  beforeDispatch?: () => Promise<void> | void
  streamContract: AssistantAttemptContract | null
  accumulator: StreamAccumulator
  journal: GenerationAttemptJournal
  errorPolicy: GenerationAttemptErrorPolicy
  now?: () => number
  signal?: AbortSignal
  isAborted?: () => boolean
  abortReason?: AbortReason | (() => AbortReason)
  prepareLive?: (input: {
    accumulator: StreamAccumulator
    now: number
  }) => (() => unknown) | undefined
  registerLiveProjectionRequester?: (requester: (() => Promise<void>) | undefined) => void
  onLiveProjectionFailure?: (error: Error) => void
  onStreamEvent?: () => void
  terminal: {
    complete(input: GenerationAttemptFinalizationContext): Promise<AttemptTerminalReceipt>
  }
}

export async function runGenerationAttempt(
  input: GenerationAttemptRunnerInput,
): Promise<GenerationAttemptResult> {
  const now = input.now ?? Date.now
  let outcome: GenerationAttemptOutcome = 'done'
  let abortReason: AbortReason | undefined
  let error: ApiError | undefined
  let sawTerminalEvidence = false
  let liveProjectionFailure: Error | undefined
  const attemptState = { beforeDispatchFailed: false, streamIterationFailed: false }
  const livePublisher = createAttemptLivePublisher(
    {
      ...input,
      onLiveProjectionFailure: (projectionError) => {
        liveProjectionFailure ??= projectionError
        input.onLiveProjectionFailure?.(projectionError)
      },
    },
    now,
  )
  try {
    input.registerLiveProjectionRequester?.(livePublisher.requestCurrent)
  } catch {
    // Observer registration cannot own the generation outcome.
  }

  try {
    let source: AsyncIterable<AssistantStreamChunk>
    if (input.beforeDispatch) {
      source = openAfterDispatchGuard(
        input.beforeDispatch,
        input.open,
        () => {
          attemptState.beforeDispatchFailed = true
        },
        input.signal,
      )
    } else {
      try {
        source = input.open()
      } catch (caught) {
        attemptState.streamIterationFailed = true
        throw caught
      }
    }
    const iterator = splitAssistantStream(source, input.streamContract)[Symbol.asyncIterator]()
    let iteratorClosed = false
    let iterationError: unknown
    let hasIterationError = false
    try {
      for (;;) {
        let next: IteratorResult<StreamLaneEvent>
        try {
          next = await iterator.next()
        } catch (caught) {
          iteratorClosed = true
          if (sawTerminalEvidence) break
          attemptState.streamIterationFailed = true
          throw caught
        }
        if (input.signal?.aborted || input.isAborted?.()) {
          throw input.signal?.reason ?? new DOMException('Generation aborted', 'AbortError')
        }
        if (next.done) {
          iteratorClosed = true
          break
        }
        const ingressEvent = next.value
        const eventNow = now()
        const event = foldStreamAccumulatorEvent(input.accumulator, ingressEvent, eventNow)
        input.onStreamEvent?.()
        try {
          input.journal.append(event, eventNow)
        } catch (caught) {
          throw normalizeError(caught, { midStream: true, cause: 'storage' })
        }
        if (
          event.lane === 'finish' ||
          event.lane === 'terminal' ||
          (event.lane === 'result-snapshot' && event.outcome.kind === 'finish')
        ) {
          sawTerminalEvidence = true
        }
        if (event.lane === 'error') {
          outcome = 'error'
          error = apiErrorFromGenerationStreamFailure(event.error)
          break
        }
        if (event.lane === 'result-snapshot' && event.outcome.kind === 'error') {
          outcome = 'error'
          error = apiErrorFromGenerationStreamFailure(event.outcome.error)
          break
        }
        const publishNow = now()
        try {
          await livePublisher.afterEvent(publishNow)
        } catch (caught) {
          throw normalizeError(caught, { midStream: true, cause: 'internal' })
        }
        try {
          input.journal.flush({ mode: 'scheduled', now: publishNow })
          const backpressure = input.journal.backpressure()
          if (backpressure) await backpressure
        } catch (caught) {
          throw normalizeError(caught, { midStream: true, cause: 'storage' })
        }
      }
    } catch (caught) {
      iterationError = caught
      hasIterationError = true
    } finally {
      if (!iteratorClosed) {
        iteratorClosed = true
        try {
          await iterator.return(undefined)
        } catch (caught) {
          if (!hasIterationError && outcome === 'done' && error === undefined) {
            iterationError = caught
            hasIterationError = true
          }
        }
      }
    }
    if (hasIterationError) throw iterationError
    try {
      await livePublisher.flush()
    } catch (caught) {
      throw normalizeError(caught, { midStream: true, cause: 'internal' })
    }
    if (outcome === 'done' && !sawTerminalEvidence) {
      outcome = 'error'
      error = prematureStreamEndError()
      const eventNow = now()
      const event = { lane: 'error', error } as const
      applyStreamAccumulatorEvent(input.accumulator, event, eventNow)
      try {
        input.journal.append(event, eventNow)
      } catch (caught) {
        throw normalizeError(caught, { midStream: true, cause: 'storage' })
      }
    }
  } catch (caught) {
    let recoveryFailure: ApiError | undefined
    if (liveProjectionFailure) {
      outcome = 'error'
      error =
        liveProjectionFailure instanceof ApiError
          ? liveProjectionFailure
          : normalizeError(liveProjectionFailure, { midStream: true, cause: 'internal' })
      recoveryFailure = error
    } else if (input.signal?.aborted || input.isAborted?.()) {
      outcome = 'abort'
      abortReason = resolveAbortReason(input.abortReason)
    } else if (attemptState.beforeDispatchFailed) {
      outcome = 'error'
      error = normalizeError(caught, { midStream: false, cause: 'internal' })
    } else if (caught instanceof ApiError) {
      if (caught.kind === 'abort') {
        outcome = 'abort'
        abortReason = resolveAbortReason(input.abortReason)
      } else if (caught.kind === 'network' && input.errorPolicy.thrownNetworkApiError === 'abort') {
        outcome = 'abort'
        abortReason = 'network'
        recoveryFailure = caught
      } else {
        outcome = 'error'
        error = caught
        recoveryFailure = caught
      }
    } else {
      outcome = 'error'
      error = normalizeError(caught, { midStream: true, cause: 'protocol' })
      recoveryFailure = error
    }
    if (attemptState.streamIterationFailed && recoveryFailure) {
      try {
        input.journal.append({ lane: 'error', error: recoveryFailure }, now())
      } catch (journalError) {
        outcome = 'error'
        abortReason = undefined
        error = normalizeError(journalError, { midStream: true, cause: 'storage' })
      }
    }
  }

  try {
    await livePublisher.stopAutomaticPublishing()
  } catch (caught) {
    outcome = 'error'
    abortReason = undefined
    error = normalizeError(caught, { midStream: true, cause: 'internal' })
  }

  const terminalDecision = normalizeAttemptTerminalDecision(
    outcome === 'done'
      ? {
          outcome: 'done',
          ...(input.accumulator.finishReason
            ? { finishReason: input.accumulator.finishReason }
            : {}),
        }
      : outcome === 'abort'
        ? {
            outcome: 'abort',
            abortReason: abortReason ?? resolveAbortReason(input.abortReason),
            ...(input.accumulator.finishReason
              ? { finishReason: input.accumulator.finishReason }
              : {}),
          }
        : {
            outcome: 'error',
            error: error ?? normalizeError('Generation failed', { midStream: true }),
            ...(input.accumulator.finishReason
              ? { finishReason: input.accumulator.finishReason }
              : {}),
          },
  )
  const finishedAt = now()
  let effectiveResult = generationAttemptResultFromReceipt({
    version: 1,
    finishedAt,
    journalMaxSeq: -1,
    journalCompleteness: 'settled',
    decision: terminalDecision,
  })
  let primaryError: unknown
  let hasPrimaryError = false

  try {
    try {
      const receipt = await input.terminal.complete({
        decision: terminalDecision,
        accumulator: input.accumulator,
        finishedAt,
      })
      effectiveResult = generationAttemptResultFromReceipt(receipt)
    } catch (caught) {
      const canonicalError =
        caught instanceof ApiError
          ? caught
          : normalizeError(caught, { midStream: true, cause: 'storage' })
      effectiveResult = {
        outcome: 'error',
        error: canonicalError,
        ...(input.accumulator.finishReason ? { finishReason: input.accumulator.finishReason } : {}),
      }
      throw canonicalError
    }
  } catch (caught) {
    primaryError = caught
    hasPrimaryError = true
  }

  try {
    input.registerLiveProjectionRequester?.(undefined)
  } catch {
    // Observer cleanup cannot replace the already-decided attempt outcome.
  }
  try {
    await livePublisher.close()
  } catch {
    // Terminal persistence owns the result; live publication is best effort after that point.
  }
  try {
    input.journal.release()
  } catch {
    // Release is idempotent cleanup after terminal persistence.
  }
  releaseStreamAccumulatorBuffers(input.accumulator)

  if (hasPrimaryError) throw primaryError
  return effectiveResult
}

function generationAttemptResultFromReceipt(
  receipt: AttemptTerminalReceipt,
): GenerationAttemptResult {
  const decision = receipt.decision
  if (decision.outcome === 'done') {
    return {
      outcome: 'done',
      ...(decision.finishReason ? { finishReason: decision.finishReason } : {}),
    }
  }
  if (decision.outcome === 'abort') {
    return {
      outcome: 'abort',
      abortReason: decision.abortReason,
      ...(decision.finishReason ? { finishReason: decision.finishReason } : {}),
    }
  }
  return {
    outcome: 'error',
    error: apiErrorFromAttemptTerminalFailure(decision.error),
    ...(decision.finishReason ? { finishReason: decision.finishReason } : {}),
  }
}

function createAttemptLivePublisher(
  input: Pick<
    GenerationAttemptRunnerInput,
    'accumulator' | 'journal' | 'prepareLive' | 'onLiveProjectionFailure'
  >,
  now: () => number,
): {
  afterEvent: (publishNow: number) => Promise<void>
  flush: () => Promise<void>
  requestCurrent: () => Promise<void>
  stopAutomaticPublishing: () => Promise<void>
  close: () => Promise<void>
} {
  let timer: ReturnType<typeof setTimeout> | undefined
  let tail = Promise.resolve()
  let failure: Error | undefined
  let automaticPublishingStopped = false
  let closed = false
  let requestedRevision: number | undefined
  let requestedPromise: Promise<void> | undefined
  let projectedRevision: number | undefined
  let automaticProjectionSuppressed = false

  const clearTimer = () => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  const throwIfFailed = () => {
    if (failure !== undefined) throw failure
  }

  const enqueue = (publishNow: number, force = false): Promise<void> => {
    const task = tail.then(async () => {
      if (force) automaticProjectionSuppressed = false
      if (
        closed ||
        !input.prepareLive ||
        (!force && automaticProjectionSuppressed) ||
        (!force && !input.accumulator.dirtySinceLastLivePublish)
      ) {
        return
      }
      const revision = input.accumulator.liveMutationRevision
      if (force && projectedRevision === revision) return
      let apply: ReturnType<NonNullable<GenerationAttemptRunnerInput['prepareLive']>>
      try {
        apply = input.prepareLive({ accumulator: input.accumulator, now: publishNow })
      } catch {
        automaticProjectionSuppressed = true
        clearTimer()
        markStreamAccumulatorPublished(input.accumulator, publishNow, revision)
        return
      }
      if (!apply) {
        automaticProjectionSuppressed = true
        clearTimer()
        markStreamAccumulatorPublished(input.accumulator, publishNow, revision)
        return
      }
      try {
        await input.journal.checkpoint()
      } catch (caught) {
        throw normalizeError(caught, { midStream: true, cause: 'storage' })
      }
      let applied: unknown
      try {
        applied = await apply()
      } catch {
        automaticProjectionSuppressed = true
        clearTimer()
        markStreamAccumulatorPublished(input.accumulator, publishNow, revision)
        return
      }
      automaticProjectionSuppressed = applied === false
      if (automaticProjectionSuppressed) clearTimer()
      else projectedRevision = revision
      markStreamAccumulatorPublished(input.accumulator, publishNow, revision)
    })
    const observed = task.catch((error) => {
      const normalized = errorFromUnknown(error)
      if (failure === undefined) {
        failure = normalized
        input.onLiveProjectionFailure?.(normalized)
      }
      throw normalized
    })
    tail = observed.catch(() => {})
    return observed
  }

  const schedule = (publishNow: number) => {
    if (
      timer !== undefined ||
      !input.prepareLive ||
      automaticProjectionSuppressed ||
      automaticPublishingStopped ||
      closed
    ) {
      return
    }
    const delay = Math.max(
      0,
      STREAM_LIVE_UPDATE_INTERVAL_MS - (publishNow - input.accumulator.lastLivePublishedAt),
    )
    timer = setTimeout(() => {
      timer = undefined
      void enqueue(now()).catch(() => {})
    }, delay)
  }

  return {
    async afterEvent(publishNow) {
      throwIfFailed()
      if (
        automaticPublishingStopped ||
        automaticProjectionSuppressed ||
        !input.prepareLive ||
        !input.accumulator.dirtySinceLastLivePublish
      ) {
        return
      }
      if (shouldPublishStreamAccumulatorLive(input.accumulator, publishNow)) {
        clearTimer()
        await enqueue(publishNow)
        return
      }
      schedule(publishNow)
    },
    async flush() {
      clearTimer()
      throwIfFailed()
      if (
        !automaticPublishingStopped &&
        !automaticProjectionSuppressed &&
        input.prepareLive &&
        input.accumulator.dirtySinceLastLivePublish
      ) {
        await enqueue(now())
      }
      await tail
      throwIfFailed()
    },
    requestCurrent() {
      if (failure !== undefined) return Promise.reject(failure)
      if (closed || !input.prepareLive || input.accumulator.liveMutationRevision === 0) {
        return Promise.resolve()
      }
      const revision = input.accumulator.liveMutationRevision
      if (projectedRevision === revision) return Promise.resolve()
      if (requestedRevision === revision && requestedPromise) return requestedPromise
      requestedRevision = revision
      const request = enqueue(now(), true).finally(() => {
        if (requestedPromise !== request) return
        requestedRevision = undefined
        requestedPromise = undefined
      })
      requestedPromise = request
      return request
    },
    async stopAutomaticPublishing() {
      clearTimer()
      automaticPublishingStopped = true
      await tail
      throwIfFailed()
    },
    async close() {
      clearTimer()
      automaticPublishingStopped = true
      closed = true
      await tail
    },
  }
}

async function* openAfterDispatchGuard(
  beforeDispatch: () => Promise<void> | void,
  open: () => AsyncIterable<AssistantStreamChunk>,
  onFailure: () => void,
  signal: AbortSignal | undefined,
): AsyncGenerator<AssistantStreamChunk> {
  try {
    await raceWithAbortSignal(beforeDispatch, signal)
  } catch (error) {
    onFailure()
    throw error
  }
  yield* open()
}

function resolveAbortReason(configured: GenerationAttemptRunnerInput['abortReason']): AbortReason {
  if (typeof configured === 'function') return configured()
  return configured ?? 'user'
}

function prematureStreamEndError(): ApiError {
  return new ApiError({
    kind: 'protocol',
    code: 'STREAM_TRUNCATED',
    message: 'Stream ended before a terminal event',
    midStream: true,
    retryable: true,
  })
}

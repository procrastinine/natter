import { splitAssistantStream } from '../api/assistant-lanes'
import type { AssistantStreamChunk } from '../api/assistant-stream'
import { ApiError, normalizeError } from '../api/errors'
import type { StreamLaneEvent } from '../api/stream-transforms'
import { raceWithAbortSignal } from '../lib/abort'
import { errorFromUnknown } from '../lib/error'
import type { StreamChunkWriter } from '../store/stream-chunk-writer'
import type { ApiRoute } from './api-choice'
import {
  applyStreamAccumulatorEvent,
  markStreamAccumulatorPublished,
  releaseStreamAccumulatorBuffers,
  STREAM_LIVE_UPDATE_INTERVAL_MS,
  type StreamAccumulator,
  shouldPublishStreamAccumulatorLive,
} from './stream-accumulator'
import type { AbortReason } from './types'

type GenerationAttemptOutcome = 'done' | 'error' | 'abort'

export interface GenerationAttemptErrorPolicy {
  thrownNetworkApiError: 'abort' | 'error'
  unknownError: 'swallow' | 'rethrow-after-finalization'
}

export const SEND_GENERATION_ATTEMPT_ERROR_POLICY = {
  thrownNetworkApiError: 'abort',
  unknownError: 'swallow',
} as const satisfies GenerationAttemptErrorPolicy

export const CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY = {
  thrownNetworkApiError: 'error',
  unknownError: 'rethrow-after-finalization',
} as const satisfies GenerationAttemptErrorPolicy

export interface GenerationAttemptResult {
  outcome: GenerationAttemptOutcome
  abortReason?: AbortReason
  error?: ApiError
  finishReason?: string
  journalCleanupPending?: boolean
}

interface GenerationAttemptFinalizationContext extends GenerationAttemptResult {
  accumulator: StreamAccumulator
}

export interface GenerationAttemptRunnerInput {
  open: () => AsyncIterable<AssistantStreamChunk>
  beforeDispatch?: () => Promise<void> | void
  transportHint?: ApiRoute['transport']
  accumulator: StreamAccumulator
  journal: StreamChunkWriter
  errorPolicy: GenerationAttemptErrorPolicy
  now?: () => number
  signal?: AbortSignal
  isAborted?: () => boolean
  abortReason?: AbortReason | (() => AbortReason)
  prepareLive?: (input: {
    accumulator: StreamAccumulator
    now: number
  }) => (() => unknown | Promise<unknown>) | undefined
  registerLiveProjectionRequester?: (requester: (() => Promise<void>) | undefined) => void
  onLiveProjectionFailure?: (error: Error) => void
  finalize: (input: GenerationAttemptFinalizationContext) => Promise<void>
  onCanonicalCommitted?: (result: GenerationAttemptResult) => void
  cleanupJournal: () => Promise<unknown>
  cleanup: (result: GenerationAttemptResult) => void | Promise<void>
}

export async function runGenerationAttempt(
  input: GenerationAttemptRunnerInput,
): Promise<GenerationAttemptResult> {
  const now = input.now ?? Date.now
  let outcome: GenerationAttemptOutcome = 'done'
  let abortReason: AbortReason | undefined
  let error: ApiError | undefined
  let deferredError: unknown
  let hasDeferredError = false
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
  input.registerLiveProjectionRequester?.(livePublisher.requestCurrent)

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
    const iterator = splitAssistantStream(source, input.transportHint)[Symbol.asyncIterator]()
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
        if (next.done) {
          iteratorClosed = true
          break
        }
        const event = next.value
        const eventNow = now()
        applyStreamAccumulatorEvent(input.accumulator, event, eventNow)
        try {
          input.journal.append(event, eventNow)
        } catch (caught) {
          throw normalizeError(caught, { midStream: true, cause: 'storage' })
        }
        if (event.lane === 'finish' || event.lane === 'terminal') sawTerminalEvidence = true
        if (event.lane === 'error') {
          outcome = 'error'
          error = event.error
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
      deferredError = caught
      hasDeferredError = true
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
      if (input.errorPolicy.unknownError === 'rethrow-after-finalization') {
        deferredError = error
        hasDeferredError = true
      }
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

  let effectiveResult: GenerationAttemptResult = {
    outcome,
    ...(abortReason ? { abortReason } : {}),
    ...(error ? { error } : {}),
    ...(input.accumulator.finishReason ? { finishReason: input.accumulator.finishReason } : {}),
  }
  let primaryError: unknown
  let hasPrimaryError = false

  try {
    try {
      await input.finalize({ ...effectiveResult, accumulator: input.accumulator })
    } catch (caught) {
      const canonicalError =
        caught instanceof ApiError
          ? caught
          : normalizeError(caught, { midStream: true, cause: 'storage' })
      effectiveResult = {
        outcome: 'error',
        error: canonicalError,
        ...(input.accumulator.finishReason ? { finishReason: input.accumulator.finishReason } : {}),
        journalCleanupPending: true,
      }
      await preserveRecoveryJournal(input.journal)
      throw canonicalError
    }
    input.onCanonicalCommitted?.(effectiveResult)

    try {
      await input.journal.settle()
    } catch {
      effectiveResult = { ...effectiveResult, journalCleanupPending: true }
    }
    if (!effectiveResult.journalCleanupPending) {
      try {
        await input.cleanupJournal()
      } catch {
        effectiveResult = { ...effectiveResult, journalCleanupPending: true }
      }
    }
  } catch (caught) {
    primaryError = caught
    hasPrimaryError = true
  }

  let cleanupError: unknown
  let hasCleanupError = false
  input.registerLiveProjectionRequester?.(undefined)
  try {
    await livePublisher.close()
  } catch (caught) {
    cleanupError = normalizeError(caught, { midStream: true, cause: 'internal' })
    hasCleanupError = true
  }
  try {
    input.journal.release()
  } catch (caught) {
    if (!hasCleanupError) {
      cleanupError = normalizeError(caught, { midStream: true, cause: 'internal' })
      hasCleanupError = true
    }
  }
  releaseStreamAccumulatorBuffers(input.accumulator)
  try {
    await input.cleanup(effectiveResult)
  } catch (caught) {
    if (!hasCleanupError) {
      cleanupError =
        caught instanceof ApiError
          ? caught
          : normalizeError(caught, { midStream: true, cause: 'internal' })
      hasCleanupError = true
    }
  }

  if (hasPrimaryError) throw primaryError
  if (hasDeferredError && effectiveResult.error?.kind !== 'storage') throw deferredError
  if (hasCleanupError) throw cleanupError
  return effectiveResult
}

async function preserveRecoveryJournal(journal: StreamChunkWriter): Promise<void> {
  try {
    await journal.settle()
    return
  } catch {
    try {
      await journal.flush({ mode: 'immediate' })
    } catch {
      return
    }
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
      const apply = input.prepareLive({ accumulator: input.accumulator, now: publishNow })
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
      const applied = await apply()
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

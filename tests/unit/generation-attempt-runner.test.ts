import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { splitAssistantStream } from '../../src/api/assistant-lanes'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { ApiError } from '../../src/api/errors'
import {
  type AttemptTerminalDecision,
  type AttemptTerminalReceipt,
  isAttemptTerminalReceipt,
} from '../../src/core/attempt-outcome'
import {
  createStreamAccumulator,
  projectStreamAccumulatorFinal,
  type StreamAccumulator,
  streamAccumulatorText,
} from '../../src/core/stream-accumulator'
import {
  CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
  type GenerationAttemptRunnerInput,
  runGenerationAttempt,
  SEND_GENERATION_ATTEMPT_ERROR_POLICY,
} from '../../src/store/generation-attempt-runner'
import {
  createStreamJournalWriter,
  type StreamJournalWriter,
} from '../../src/store/stream-chunk-writer'
import {
  reserveWorkspaceChild,
  runWorkspaceAction,
  type WorkspaceWritePermit,
  workspaceRuntimeInternal,
} from '../../src/store/workspace-runtime'
import {
  anthropicRouteContract,
  chatRouteContract,
  geminiRouteContract,
  responsesRouteContract,
} from '../helpers/reasoning-contracts'
import {
  createLogicalStreamJournalAppendAdapter,
  type TestSemanticJournalRow,
} from '../helpers/stream-journal'

type GenerationAttemptFinalizationInput = Parameters<
  GenerationAttemptRunnerInput['terminal']['complete']
>[0]

function runTestGenerationAttempt(
  input: Omit<GenerationAttemptRunnerInput, 'streamContract'> &
    Partial<Pick<GenerationAttemptRunnerInput, 'streamContract'>>,
) {
  return runGenerationAttempt({
    ...input,
    streamContract: input.streamContract ?? chatRouteContract(),
  })
}

function terminalDouble(
  overrides: {
    complete?: (
      input: GenerationAttemptFinalizationInput,
    ) => undefined | AttemptTerminalReceipt | Promise<undefined | AttemptTerminalReceipt>
  } = {},
): GenerationAttemptRunnerInput['terminal'] {
  const complete = overrides.complete
  return {
    complete: async (input) => {
      const result = await complete?.(input)
      return isAttemptTerminalReceipt(result) ? result : terminalReceipt(input)
    },
  }
}

function terminalReceipt(input: GenerationAttemptFinalizationInput): AttemptTerminalReceipt {
  return {
    version: 1,
    finishedAt: input.finishedAt,
    journalMaxSeq: -1,
    journalCompleteness: 'settled',
    decision: input.decision,
  }
}

let writerRootPermit: WorkspaceWritePermit | undefined
const writerRootLifetime = deferred<void>()
let writerRootTask: Promise<void> | undefined

beforeAll(async () => {
  const fence = { workspaceId: 'generation-attempt-runner-tests', replacementEpoch: 0 }
  workspaceRuntimeInternal.beginReconciliation(fence)
  workspaceRuntimeInternal.finishReconciliation(fence)
  const ready = deferred<void>()
  writerRootTask = runWorkspaceAction('conversation-generation', async (permit) => {
    writerRootPermit = permit
    ready.resolve(undefined)
    await writerRootLifetime.promise
  })
  await ready.promise
})

afterAll(async () => {
  writerRootLifetime.resolve(undefined)
  await writerRootTask
  workspaceRuntimeInternal.beginQuiesce()
  await workspaceRuntimeInternal.awaitDrain()
  workspaceRuntimeInternal.markQuiesced()
  workspaceRuntimeInternal.seal()
})

describe('generation attempt runner', () => {
  it('opens once and orders reduction, journaling, gated publishing, finalization, and cleanup', async () => {
    const log: string[] = []
    const accumulator = createStreamAccumulator({
      initialContent: [{ type: 'output_text', text: 'prefill-' }],
      now: 0,
    })
    const open = vi.fn(() => {
      log.push('open')
      return chunks({
        type: 'delta',
        chunk: {
          choices: [{ delta: { content: 'x'.repeat(2_048) }, finish_reason: 'stop' }],
        },
      })
    })
    const journal = journalDouble({
      append: (event) => {
        log.push(`append:${event.lane}`)
        if (event.lane === 'text') expect(streamAccumulatorText(accumulator)).toBe(event.text)
      },
      immediateFlush: async () => {
        log.push('durable')
      },
      scheduledFlush: () => log.push('schedule'),
      release: () => log.push('release'),
    })
    const publishLive = vi.fn(() => {
      log.push('publish')
      expect(streamAccumulatorText(accumulator)).toHaveLength(2_048)
    })
    const finalize = vi.fn(async (_input: GenerationAttemptFinalizationInput) => {
      log.push('finalize')
      expect(projectStreamAccumulatorFinal(accumulator).content).toEqual([
        { type: 'output_text', text: `prefill-${'x'.repeat(2_048)}` },
      ])
    })
    const cleanupJournal = vi.fn(async () => {
      log.push('cleanup-journal')
    })
    const cleanup = vi.fn(() => {
      log.push('cleanup')
    })

    const result = await runTestGenerationAttempt({
      open,
      accumulator,
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      now: () => 1,
      prepareLive: prepareLiveCallback(publishLive),
      terminal: terminalDouble({
        complete: async (input) => {
          await journal.settle()
          await finalize(input)
          await cleanupJournal()
          cleanup()
        },
      }),
    })

    expect(result).toEqual({ outcome: 'done', finishReason: 'stop' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(publishLive).toHaveBeenCalledTimes(1)
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(cleanupJournal).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(log).toEqual([
      'open',
      'append:text',
      'durable',
      'publish',
      'schedule',
      'append:finish',
      'schedule',
      'finalize',
      'cleanup-journal',
      'cleanup',
      'release',
    ])
    expect(accumulator.textSections).toEqual([])
    expect(accumulator.initialContent).toEqual([])
  })

  it('publishes only after the accumulator live-update gate opens', async () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const publishLive = vi.fn()

    await runTestGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'a'.repeat(2_047) } }] } },
          { type: 'delta', chunk: { choices: [{ delta: { content: 'b' } }] } },
          { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
        ),
      accumulator,
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      now: () => 0,
      prepareLive: prepareLiveCallback(publishLive),
      terminal: terminalDouble(),
    })

    expect(publishLive).toHaveBeenCalledTimes(2)
    expect(publishLive.mock.calls[0]?.[0]).toMatchObject({ now: 0 })
    expect(publishLive.mock.calls[1]?.[0]).toMatchObject({ now: 0 })
  })

  it('makes a visible recovery prefix durable before publishing it', async () => {
    const visiblePrefixDurable = deferred<void>()
    const visiblePrefixFlushStarted = deferred<void>()
    const terminalDurability = deferred<void>()
    const settleStarted = deferred<void>()
    const publishLive = vi.fn()
    const order: string[] = []
    let immediateFlushCount = 0
    const journal = journalDouble({
      immediateFlush: () => {
        immediateFlushCount += 1
        order.push(`flush:${immediateFlushCount}`)
        if (immediateFlushCount === 1) {
          visiblePrefixFlushStarted.resolve()
          return visiblePrefixDurable.promise
        }
        return Promise.resolve()
      },
      settle: () => {
        order.push('settle')
        settleStarted.resolve()
        return terminalDurability.promise
      },
    })
    const finalize = vi.fn(async (_input: GenerationAttemptFinalizationInput) => {
      order.push('finalize')
    })
    let completed = false
    const attempt = runTestGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'visible' } }] } },
          { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
        ),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      prepareLive: prepareLiveCallback(publishLive),
      terminal: terminalDouble({
        complete: async (input) => {
          await journal.settle()
          await finalize(input)
          order.push('canonical-committed')
        },
      }),
    }).finally(() => {
      completed = true
    })

    await visiblePrefixFlushStarted.promise
    expect(publishLive).not.toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    expect(order).toEqual(['flush:1'])

    visiblePrefixDurable.resolve()
    await settleStarted.promise
    expect(publishLive).toHaveBeenCalled()
    expect(finalize).not.toHaveBeenCalled()
    expect(order).toEqual(['flush:1', 'settle'])
    expect(completed).toBe(false)
    expect(journal.checkpoint).toHaveBeenCalledTimes(1)

    terminalDurability.resolve()
    await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['flush:1', 'settle', 'finalize', 'canonical-committed'])
  })

  it('does not force publication flushes when the target chat is not visible', async () => {
    const journal = journalDouble()
    const prepareLive = vi.fn(() => undefined)

    await runTestGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'offscreen' } }] } },
          { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
        ),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      prepareLive,
      terminal: terminalDouble(),
    })

    expect(prepareLive).toHaveBeenCalled()
    expect(journal.checkpoint).not.toHaveBeenCalled()
  })

  it('republishes a current durable revision when a returning consumer requests it', async () => {
    const paused = deferred<void>()
    const release = deferred<void>()
    const journal = journalDouble()
    let visible = false
    let requester: (() => Promise<void>) | undefined
    const published: string[] = []
    const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
      yield { type: 'delta', chunk: { choices: [{ delta: { content: 'waiting' } }] } }
      paused.resolve()
      await release.promise
      yield { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } }
    }

    const attempt = runTestGenerationAttempt({
      open: () => source(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      prepareLive: ({ accumulator: current }) => {
        if (!visible) return undefined
        const text = streamAccumulatorText(current)
        return () => {
          published.push(text)
        }
      },
      registerLiveProjectionRequester: (next) => {
        if (next) requester = next
      },
      terminal: terminalDouble(),
    })

    await paused.promise
    expect(requester).toBeTypeOf('function')
    expect(published).toEqual([])
    expect(journal.checkpoint).not.toHaveBeenCalled()

    visible = true
    const currentRequester = requester
    if (!currentRequester) throw new Error('Expected live projection requester')
    await Promise.all([currentRequester(), currentRequester()])
    expect(published).toEqual(['waiting'])
    expect(journal.checkpoint).toHaveBeenCalledTimes(1)

    await currentRequester()
    expect(published).toEqual(['waiting', 'waiting'])
    expect(journal.checkpoint).toHaveBeenCalledTimes(2)

    release.resolve()
    await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
  })

  it('suppresses automatic projection checks after a miss until relevance is requested', async () => {
    vi.useFakeTimers()
    try {
      const firstMiss = deferred<void>()
      const allowThirdChunk = deferred<void>()
      const thirdChunkConsumed = deferred<void>()
      const releaseStream = deferred<void>()
      let clock = 0
      let visible = false
      let requester: (() => Promise<void>) | undefined
      const published: string[] = []
      const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'a' } }] } }
        clock = 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'b' } }] } }
        await allowThirdChunk.promise
        clock = 2
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'c' } }] } }
        thirdChunkConsumed.resolve()
        await releaseStream.promise
        clock = 200
        yield { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } }
      }
      const journal = journalDouble()
      const prepareLive = vi.fn(({ accumulator: current }: { accumulator: StreamAccumulator }) => {
        const text = streamAccumulatorText(current)
        if (!visible) {
          firstMiss.resolve()
          return undefined
        }
        return () => {
          published.push(text)
        }
      })
      const attempt = runTestGenerationAttempt({
        open: () => source(),
        accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
        journal,
        errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
        now: () => clock,
        prepareLive,
        registerLiveProjectionRequester: (next) => {
          if (next) requester = next
        },
        terminal: terminalDouble(),
      })

      await firstMiss.promise
      await drainMicrotasks()
      expect(prepareLive).toHaveBeenCalledTimes(1)
      expect(journal.checkpoint).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(prepareLive).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)

      visible = true
      const currentRequester = requester
      if (!currentRequester) throw new Error('Expected live projection requester')
      await currentRequester()
      expect(published).toEqual(['ab'])
      expect(journal.checkpoint).toHaveBeenCalledTimes(1)

      allowThirdChunk.resolve()
      await thirdChunkConsumed.promise
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(123)
      expect(published).toEqual(['ab'])
      await vi.advanceTimersByTimeAsync(1)
      expect(published).toEqual(['ab', 'abc'])

      releaseStream.resolve()
      await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('deduplicates forced requests against the revision projected ahead of them in the queue', async () => {
    vi.useFakeTimers()
    try {
      const secondChunkConsumed = deferred<void>()
      const allowThirdChunk = deferred<void>()
      const thirdChunkConsumed = deferred<void>()
      const blockedPublishStarted = deferred<void>()
      const releaseBlockedPublish = deferred<void>()
      const releaseStream = deferred<void>()
      let clock = 0
      let requester: (() => Promise<void>) | undefined
      const published: string[] = []
      const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'a' } }] } }
        clock = 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'b' } }] } }
        secondChunkConsumed.resolve()
        await allowThirdChunk.promise
        clock = 2
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'c' } }] } }
        thirdChunkConsumed.resolve()
        await releaseStream.promise
        clock = 200
        yield { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } }
      }
      const journal = journalDouble()
      const attempt = runTestGenerationAttempt({
        open: () => source(),
        accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
        journal,
        errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
        now: () => clock,
        prepareLive: ({ accumulator: current }) => {
          const text = streamAccumulatorText(current)
          return async () => {
            if (text === 'ab') {
              blockedPublishStarted.resolve()
              await releaseBlockedPublish.promise
            }
            published.push(text)
          }
        },
        registerLiveProjectionRequester: (next) => {
          if (next) requester = next
        },
        terminal: terminalDouble(),
      })

      await secondChunkConsumed.promise
      expect(published).toEqual(['a'])
      await vi.advanceTimersByTimeAsync(124)
      await blockedPublishStarted.promise

      const currentRequester = requester
      if (!currentRequester) throw new Error('Expected live projection requester')
      const earlierRequest = currentRequester()
      allowThirdChunk.resolve()
      await thirdChunkConsumed.promise
      const laterRequest = currentRequester()

      releaseBlockedPublish.resolve()
      await Promise.all([earlierRequest, laterRequest])
      expect(published).toEqual(['a', 'ab', 'abc'])
      expect(journal.checkpoint).toHaveBeenCalledTimes(3)

      releaseStream.resolve()
      await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps current projection requests available while canonical finalization is pending', async () => {
    const finalizeStarted = deferred<void>()
    const releaseFinalize = deferred<void>()
    const journal = journalDouble()
    let visible = false
    let requester: (() => Promise<void>) | undefined
    const published: string[] = []
    const attempt = runTestGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'terminal-prefix' } }] } },
          { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
        ),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      prepareLive: ({ accumulator: current }) => {
        if (!visible) return undefined
        const text = streamAccumulatorText(current)
        return () => {
          published.push(text)
        }
      },
      registerLiveProjectionRequester: (next) => {
        if (next) requester = next
      },
      terminal: terminalDouble({
        complete: async () => {
          finalizeStarted.resolve()
          await releaseFinalize.promise
        },
      }),
    })

    await finalizeStarted.promise
    visible = true
    const currentRequester = requester
    if (!currentRequester) throw new Error('Expected live projection requester')
    await currentRequester()
    expect(published).toEqual(['terminal-prefix'])
    expect(journal.checkpoint).toHaveBeenCalledTimes(1)

    releaseFinalize.resolve()
    await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
  })

  it('does not publish an undurable snapshot and classifies the failure as storage', async () => {
    const publishLive = vi.fn()
    const finalized = vi.fn<(input: GenerationAttemptFinalizationInput) => void>()

    const result = await runTestGenerationAttempt({
      open: () =>
        chunks({ type: 'delta', chunk: { choices: [{ delta: { content: 'not-durable' } }] } }),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble({ immediateFlushError: new Error('indexeddb unavailable') }),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      prepareLive: prepareLiveCallback(publishLive),
      terminal: terminalDouble({
        complete: async (input) => {
          finalized(input)
        },
      }),
    })

    expect(publishLive).not.toHaveBeenCalled()
    const finalization = finalized.mock.calls[0]?.[0]
    expect(finalization?.decision.outcome).toBe('error')
    if (finalization?.decision.outcome !== 'error') throw new Error('ExpectedErrorFinalization')
    expect(finalization.decision.error.kind).toBe('storage')
    expect(finalization.decision.error.code).toBe('STORAGE')
    expect(result).toMatchObject({
      outcome: 'error',
      error: { kind: 'storage', code: 'STORAGE' },
    })
  })

  it('keeps a projection durability failure classified as storage while aborting transport', async () => {
    const controller = new AbortController()
    const onLiveProjectionFailure = vi.fn(() => controller.abort())

    const result = await runTestGenerationAttempt({
      open: () =>
        chunks({ type: 'delta', chunk: { choices: [{ delta: { content: 'not-durable' } }] } }),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble({ immediateFlushError: new Error('indexeddb unavailable') }),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      signal: controller.signal,
      prepareLive: prepareLiveCallback(vi.fn()),
      onLiveProjectionFailure,
      terminal: terminalDouble(),
    })

    expect(controller.signal.aborted).toBe(true)
    expect(onLiveProjectionFailure).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      outcome: 'error',
      error: { kind: 'storage', code: 'STORAGE' },
    })
    expect(result).not.toHaveProperty('abortReason')
  })

  it('coalesces burst durability writes at the shared 128 KiB publication budget', async () => {
    const committed: TestSemanticJournalRow[][] = []
    const journal = createStreamJournalWriter({
      permit: reserveWorkspaceChild(requireWriterRootPermit(), 'stream-writer'),
      port: createLogicalStreamJournalAppendAdapter({
        append: async (rows) => {
          committed.push(structuredClone([...rows]))
        },
      }),
      chatId: 'chat-burst',
      streamId: 'stream-burst',
      messageId: 'message-burst',
      now: 0,
      fence: {
        ownerClientId: 'owner-burst',
        fenceToken: 'fence-burst',
        replacementEpoch: 0,
        admissionSequence: 1,
      },
    })
    const piece = 'x'.repeat(2_048)
    const values: AssistantStreamChunk[] = Array.from({ length: 512 }, () => ({
      type: 'delta',
      chunk: { choices: [{ delta: { content: piece } }] },
    }))
    values.push({
      type: 'delta',
      chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] },
    })
    const publishLive = vi.fn()

    await runTestGenerationAttempt({
      open: () => chunks(...values),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      now: () => 0,
      prepareLive: prepareLiveCallback(publishLive),
      terminal: terminalDouble(),
    })

    expect(publishLive.mock.calls.length).toBeLessThanOrEqual(10)
    expect(committed.length).toBeLessThanOrEqual(20)
    expect(committed.flat().length).toBeLessThanOrEqual(20)
  })

  it.each([
    { name: 'an empty stream', source: [] as AssistantStreamChunk[], expectedText: '' },
    {
      name: 'content followed by ordinary EOF',
      source: [
        { type: 'delta', chunk: { choices: [{ delta: { content: 'partial' } }] } },
      ] as AssistantStreamChunk[],
      expectedText: 'partial',
    },
  ])('records $name as a retryable truncated-stream failure', async ({ source, expectedText }) => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const journal = journalDouble()
    let finalizedText: string | undefined

    const result = await runTestGenerationAttempt({
      open: () => chunks(...source),
      accumulator,
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async ({ decision: { outcome, error } }) => {
          expect(outcome).toBe('error')
          expect(error).toMatchObject({
            kind: 'protocol',
            code: 'STREAM_TRUNCATED',
            midStream: true,
            retryable: true,
          })
          finalizedText = projectStreamAccumulatorFinal(accumulator)
            .content.filter((item) => item.type === 'output_text')
            .map((item) => item.text)
            .join('')
        },
      }),
    })

    expect(result).toMatchObject({
      outcome: 'error',
      error: {
        kind: 'protocol',
        code: 'STREAM_TRUNCATED',
        message: 'Stream ended before a terminal event',
        midStream: true,
        retryable: true,
      },
    })
    expect(finalizedText).toBe(expectedText)
    const lastAppend = journal.append.mock.calls.at(-1)
    const lastEvent = lastAppend?.[0]
    expect(lastEvent?.lane).toBe('error')
    if (lastEvent?.lane !== 'error') throw new Error('expected terminal error journal event')
    expect(lastEvent.error.code).toBe('STREAM_TRUNCATED')
    expect(typeof lastAppend?.[1]).toBe('number')
  })

  it('accepts explicit chat [DONE] terminal evidence without inventing a finish reason', async () => {
    const result = await runTestGenerationAttempt({
      open: () => chunks({ type: 'transport_terminal', evidence: 'done-sentinel' }),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async ({ decision }) => {
          expect(decision.outcome).toBe('done')
          return undefined
        },
      }),
    })

    expect(result).toEqual({ outcome: 'done' })
  })

  it.each([
    {
      name: 'Responses response.completed',
      streamContract: responsesRouteContract(),
      chunk: {
        type: 'event',
        event: { type: 'response.completed', response: { status: 'completed' } },
      },
    },
    {
      name: 'Anthropic message_stop',
      streamContract: anthropicRouteContract(),
      chunk: {
        type: 'anthropic_event',
        event: { type: 'message_stop' },
      },
    },
    {
      name: 'Gemini finishReason',
      streamContract: geminiRouteContract(),
      chunk: {
        type: 'chunk',
        chunk: {
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        },
      },
    },
  ] satisfies ReadonlyArray<{
    name: string
    streamContract: NonNullable<GenerationAttemptRunnerInput['streamContract']>
    chunk: AssistantStreamChunk
  }>)('accepts $name as clean protocol terminal evidence', async ({ chunk, streamContract }) => {
    const result = await runTestGenerationAttempt({
      open: () => chunks(chunk),
      streamContract,
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async ({ decision }) => {
          expect(decision.outcome).toBe('done')
          return undefined
        },
      }),
    })

    expect(result).toEqual({ outcome: 'done', finishReason: 'stop' })
  })

  it('keeps a journaled native terminal clean when the reader rejects afterward', async () => {
    const trailingReaderError = new ApiError({
      kind: 'network',
      code: 'NETWORK',
      message: 'reader disconnected after message_stop',
      midStream: true,
      retryable: true,
    })
    const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
      yield { type: 'anthropic_event', event: { type: 'message_stop' } }
      throw trailingReaderError
    }
    const journal = journalDouble()

    const result = await runTestGenerationAttempt({
      open: () => source(),
      streamContract: anthropicRouteContract(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async ({ decision }) => {
          expect(decision.outcome).toBe('done')
          return undefined
        },
      }),
    })

    expect(result).toEqual({ outcome: 'done', finishReason: 'stop' })
    expect(journal.append).toHaveBeenCalledWith(
      { lane: 'finish', finishReason: 'stop' },
      expect.any(Number),
    )
    expect(journal.append).not.toHaveBeenCalledWith(
      expect.objectContaining({ lane: 'error' }),
      expect.any(Number),
    )
  })

  it('pauses provider iteration only while journal backpressure is pending', async () => {
    const capacity = deferred<void>()
    const firstAppend = deferred<void>()
    let produced = 0
    let checks = 0
    const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
      produced += 1
      yield { type: 'delta', chunk: { choices: [{ delta: { content: 'first' } }] } }
      produced += 1
      yield { type: 'delta', chunk: { choices: [{ delta: { content: 'second' } }] } }
      produced += 1
      yield { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } }
    }
    const journal = journalDouble({
      append: () => firstAppend.resolve(),
      backpressure: () => {
        checks += 1
        return checks === 1 ? capacity.promise : undefined
      },
    })
    const attempt = runTestGenerationAttempt({
      open: () => source(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble(),
    })

    await firstAppend.promise
    expect(produced).toBe(1)
    expect(journal.append).toHaveBeenCalledTimes(1)

    capacity.resolve()
    await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
    expect(produced).toBe(3)
    expect(journal.append).toHaveBeenCalledTimes(3)
  })

  it('publishes a throttled tail while the provider is otherwise quiet', async () => {
    vi.useFakeTimers()
    try {
      const release = deferred<void>()
      const firstPublished = deferred<void>()
      let clock = 0
      const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'a' } }] } }
        clock = 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'b' } }] } }
        await release.promise
        clock = 200
        yield { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } }
      }
      const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
      const published: string[] = []
      const attempt = runTestGenerationAttempt({
        open: () => source(),
        accumulator,
        journal: journalDouble(),
        errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
        now: () => clock,
        prepareLive: ({ accumulator: current }) => {
          const text = streamAccumulatorText(current)
          return () => {
            published.push(text)
            if (published.length === 1) firstPublished.resolve()
          }
        },
        terminal: terminalDouble(),
      })

      await firstPublished.promise
      expect(published).toEqual(['a'])
      await vi.advanceTimersByTimeAsync(123)
      expect(published).toEqual(['a'])
      await vi.advanceTimersByTimeAsync(1)
      expect(published).toEqual(['a', 'ab'])

      release.resolve()
      await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies only the prepared revision when newer output arrives during publication', async () => {
    vi.useFakeTimers()
    try {
      const allowThirdChunk = deferred<void>()
      const thirdChunkConsumed = deferred<void>()
      const releaseStream = deferred<void>()
      const blockedPublish = deferred<void>()
      const blockedPublishStarted = deferred<void>()
      const firstPublished = deferred<void>()
      const secondPublished = deferred<void>()
      let clock = 0
      const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'a' } }] } }
        clock = 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'b' } }] } }
        await allowThirdChunk.promise
        clock = 2
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'c' } }] } }
        thirdChunkConsumed.resolve()
        await releaseStream.promise
        clock = 200
        yield { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } }
      }
      const published: string[] = []
      const attempt = runTestGenerationAttempt({
        open: () => source(),
        accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
        journal: journalDouble(),
        errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
        now: () => clock,
        prepareLive: ({ accumulator: current }) => {
          const text = streamAccumulatorText(current)
          return async () => {
            if (text === 'ab') {
              blockedPublishStarted.resolve()
              await blockedPublish.promise
            }
            published.push(text)
            if (published.length === 1) firstPublished.resolve()
            if (published.length === 2) secondPublished.resolve()
          }
        },
        terminal: terminalDouble(),
      })

      await firstPublished.promise
      await vi.advanceTimersByTimeAsync(124)
      await blockedPublishStarted.promise
      allowThirdChunk.resolve()
      await thirdChunkConsumed.promise
      expect(published).toEqual(['a'])

      blockedPublish.resolve()
      await secondPublished.promise
      expect(published).toEqual(['a', 'ab'])

      releaseStream.resolve()
      await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
      expect(published.at(-1)).toBe('abc')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not clear newer live dirtiness while an async publication is pending', async () => {
    vi.useFakeTimers()
    try {
      const publicationStarted = deferred<void>()
      const releasePublication = deferred<void>()
      const firstPublished = deferred<void>()
      let clock = 0
      const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'a' } }] } }
        clock = 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'b' } }] } }
        await publicationStarted.promise
        clock = 2
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'c' } }] } }
        clock = 200
        yield { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } }
      }
      const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
      const published: string[] = []
      let publications = 0
      const attempt = runTestGenerationAttempt({
        open: () => source(),
        accumulator,
        journal: journalDouble(),
        errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
        now: () => clock,
        prepareLive: ({ accumulator: current }) => {
          const text = streamAccumulatorText(current)
          return () => {
            publications += 1
            published.push(text)
            if (publications === 1) firstPublished.resolve()
            if (publications !== 2) return
            publicationStarted.resolve()
            return releasePublication.promise
          }
        },
        terminal: terminalDouble(),
      })

      await firstPublished.promise
      expect(published).toEqual(['a'])
      await vi.advanceTimersByTimeAsync(124)
      await publicationStarted.promise
      await drainMicrotasks()
      expect(published).toEqual(['a', 'ab'])

      releasePublication.resolve()
      await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
      expect(published).toEqual(['a', 'ab', 'abc'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues through a transient journal failure when real backpressure retries it', async () => {
    const committed: TestSemanticJournalRow[] = []
    let writes = 0
    const journal = createStreamJournalWriter({
      permit: reserveWorkspaceChild(requireWriterRootPermit(), 'stream-writer'),
      port: createLogicalStreamJournalAppendAdapter({
        append: async (rows) => {
          writes += 1
          if (writes === 1) throw new Error('transient IndexedDB failure')
          committed.push(...structuredClone([...rows]))
        },
      }),
      chatId: 'chat-1',
      streamId: 'stream-1',
      messageId: 'message-1',
      now: 0,
      fence: {
        ownerClientId: 'owner-1',
        fenceToken: 'fence-1',
        replacementEpoch: 0,
        admissionSequence: 1,
      },
    })
    const values: AssistantStreamChunk[] = Array.from({ length: 600 }, () => ({
      type: 'delta',
      chunk: { choices: [{ delta: { content: 'x' } }] },
    }))
    values.push({
      type: 'delta',
      chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] },
    })
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })

    const result = await runTestGenerationAttempt({
      open: () => chunks(...values),
      accumulator,
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async ({ decision }) => {
          expect(decision.outcome).toBe('done')
          expect(streamAccumulatorText(accumulator)).toBe('x'.repeat(600))
        },
      }),
    })

    expect(result).toMatchObject({ outcome: 'done', finishReason: 'stop' })
    expect(writes).toBeGreaterThanOrEqual(2)
    expect(committed.length).toBeGreaterThan(0)
  })

  it('runs the final dispatch guard immediately before opening and preserves its canonical error', async () => {
    const stale = new Error('stale send context')
    const log: string[] = []
    const open = vi.fn(() => {
      log.push('open')
      return chunks()
    })
    const attempt = runTestGenerationAttempt({
      beforeDispatch: async () => {
        log.push('guard')
        throw stale
      },
      open,
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble({ release: () => log.push('release') }),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async ({ decision }) => {
          log.push(
            `finalize:${decision.outcome}:${decision.outcome === 'error' ? decision.error.code : ''}`,
          )
        },
      }),
    })

    await expect(attempt).resolves.toMatchObject({ outcome: 'error', error: { code: 'INTERNAL' } })
    expect(open).not.toHaveBeenCalled()
    expect(log).toEqual(['guard', 'finalize:error:INTERNAL', 'release'])
  })

  it('abort-races a never-settling dispatch guard and finalizes it as an abort', async () => {
    const controller = new AbortController()
    let markGuardStarted: (() => void) | undefined
    const guardStarted = new Promise<void>((resolve) => {
      markGuardStarted = resolve
    })
    const open = vi.fn(() => chunks())
    const finalize = vi.fn(async (_input: GenerationAttemptFinalizationInput) => undefined)
    const attempt = runTestGenerationAttempt({
      beforeDispatch: () => {
        markGuardStarted?.()
        return new Promise<never>(() => {})
      },
      open,
      signal: controller.signal,
      isAborted: () => controller.signal.aborted,
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({ complete: finalize }),
    })

    await guardStarted
    controller.abort()
    await expect(attempt).resolves.toEqual({ outcome: 'abort', abortReason: 'user' })
    expect(open).not.toHaveBeenCalled()
    const finalization = finalize.mock.calls[0]?.[0]
    expect(finalization?.decision).toEqual({ outcome: 'abort', abortReason: 'user' })
  })

  it('rejects a buffered frame delivered after the exact Stop intent', async () => {
    const controller = new AbortController()
    const journal = journalDouble()
    const result = await runTestGenerationAttempt({
      open: async function* () {
        controller.abort()
        yield {
          type: 'delta',
          chunk: { choices: [{ delta: { content: 'too late' }, finish_reason: 'stop' }] },
        }
      },
      signal: controller.signal,
      isAborted: () => controller.signal.aborted,
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble(),
    })

    expect(result).toEqual({ outcome: 'abort', abortReason: 'user' })
    expect(journal.append).not.toHaveBeenCalled()
  })

  it.each([
    {
      name: 'Chat Completions',
      streamContract: chatRouteContract({
        carrier: 'openrouter-reasoning-details',
        include: { text: true },
      }),
      source: [
        {
          type: 'delta',
          chunk: { choices: [{ delta: { reasoning: 'chat partial reasoning' } }] },
        },
      ] as AssistantStreamChunk[],
      expectedReasoning: 'chat partial reasoning',
    },
    {
      name: 'Responses',
      streamContract: responsesRouteContract({ include: { summary: true } }),
      source: [
        {
          type: 'event',
          event: {
            type: 'response.reasoning_summary_text.delta',
            output_index: 0,
            item_id: 'reasoning-abort',
            summary_index: 0,
            delta: 'responses partial reasoning',
          },
        },
      ] as AssistantStreamChunk[],
      expectedReasoning: 'responses partial reasoning',
    },
    {
      name: 'Gemini native',
      streamContract: geminiRouteContract({ include: { summary: true } }),
      source: [
        {
          type: 'chunk',
          chunk: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'gemini partial reasoning', thought: true }],
                },
              },
            ],
          },
        },
      ] as AssistantStreamChunk[],
      expectedReasoning: 'gemini partial reasoning',
    },
    {
      name: 'Anthropic',
      streamContract: anthropicRouteContract({ include: { text: true } }),
      source: [
        {
          type: 'anthropic_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
        },
        {
          type: 'anthropic_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'anthropic partial reasoning' },
          },
        },
      ] as AssistantStreamChunk[],
      expectedReasoning: 'anthropic partial reasoning',
    },
  ])(
    'preserves reasoning-only state when $name is aborted before response text',
    async ({ expectedReasoning, source, streamContract }) => {
      const controller = new AbortController()
      const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
      const decisions: AttemptTerminalDecision[] = []
      const result = await runTestGenerationAttempt({
        open: async function* () {
          for (const chunk of source) yield chunk
          controller.abort()
        },
        signal: controller.signal,
        isAborted: () => controller.signal.aborted,
        streamContract,
        accumulator,
        journal: journalDouble(),
        errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
        terminal: terminalDouble({
          complete: async ({ decision }) => {
            decisions.push(decision)
            const final = projectStreamAccumulatorFinal(accumulator)
            expect(final.content).toEqual([{ type: 'output_text', text: '' }])
            expect(final.reasoningEnvelope?.visible.map((part) => part.text).join('')).toBe(
              expectedReasoning,
            )
          },
        }),
      })

      expect(result).toEqual({ outcome: 'abort', abortReason: 'user' })
      expect(decisions).toEqual([{ outcome: 'abort', abortReason: 'user' }])
    },
  )

  it.each([
    {
      name: 'send network failure',
      policy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      error: apiError('network'),
      expected: { outcome: 'abort', abortReason: 'network' },
    },
    {
      name: 'continue network failure',
      policy: CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
      error: apiError('network'),
      expected: { outcome: 'error', errorKind: 'network' },
    },
    {
      name: 'send provider failure',
      policy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      error: apiError('provider_error'),
      expected: { outcome: 'error', errorKind: 'provider_error' },
    },
  ])('classifies a thrown ApiError for $name', async ({ policy, error, expected }) => {
    const finalized: AttemptTerminalDecision[] = []
    const journal = journalDouble()
    const result = await runTestGenerationAttempt({
      open: () => failedStream(error),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: policy,
      terminal: terminalDouble({
        complete: async (input) => {
          finalized.push(input.decision)
        },
      }),
    })

    expect(result.outcome).toBe(expected.outcome)
    expect(result.abortReason).toBe('abortReason' in expected ? expected.abortReason : undefined)
    expect(result.error?.kind).toBe('errorKind' in expected ? expected.errorKind : undefined)
    expect(finalized).toHaveLength(1)
    expect(finalized[0]?.outcome).toBe(expected.outcome)
    expect(journal.append).toHaveBeenCalledWith({ lane: 'error', error }, expect.any(Number))
  })

  it('classifies an aborted stream before applying the unknown-error policy', async () => {
    const result = await runTestGenerationAttempt({
      open: () => failedStream(new Error('abort transport detail')),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
      isAborted: () => true,
      abortReason: () => 'tab-close',
      terminal: terminalDouble(),
    })

    expect(result).toEqual({ outcome: 'abort', abortReason: 'tab-close' })
  })

  it('normalizes unknown stream failures into one canonical result for send and Continue', async () => {
    const sendError = new Error('send parser failed')
    const sendLog: string[] = []
    const sendResult = await runTestGenerationAttempt({
      open: () => failedStream(sendError),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async ({ decision }) => {
          sendLog.push(
            `finalize:${decision.outcome}:${decision.outcome === 'error' ? decision.error.message : ''}`,
          )
        },
      }),
    })

    expect(sendResult).toMatchObject({
      outcome: 'error',
      error: { kind: 'protocol', code: 'PROTOCOL', message: sendError.message },
    })
    expect(sendLog).toEqual(['finalize:error:send parser failed'])

    const continueError = new Error('continue parser failed')
    const continueLog: string[] = []
    const continuing = runTestGenerationAttempt({
      open: () => failedStream(continueError),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async ({ decision }) => {
          continueLog.push(`finalize:${decision.outcome}`)
        },
      }),
    })

    await expect(continuing).resolves.toMatchObject({
      outcome: 'error',
      error: {
        name: 'ApiError',
        kind: 'protocol',
        code: 'PROTOCOL',
        message: continueError.message,
      },
    })
    expect(continueLog).toEqual(['finalize:error'])
  })

  it('returns a mid-stream error-lane ApiError and stops consuming the provider', async () => {
    const closeError = new Error('provider cancellation failed')
    let produced = 0
    const upstreamClosed = vi.fn()
    const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
      try {
        produced += 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'partial' } }] } }
        produced += 1
        yield {
          type: 'delta',
          chunk: { error: { code: 429, message: 'slow down' } },
        }
        produced += 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'not consumed' } }] } }
      } finally {
        upstreamClosed()
        await Promise.reject(closeError)
      }
    }
    const finalized = vi.fn<(input: GenerationAttemptFinalizationInput) => void>()

    const result = await runTestGenerationAttempt({
      open: () => source(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async (input) => {
          finalized(input)
          return undefined
        },
      }),
    })

    expect(result.outcome).toBe('error')
    expect(result.error).toBeInstanceOf(ApiError)
    expect(result.error?.kind).toBe('rate_limited')
    expect(result.error?.midStream).toBe(true)
    expect(produced).toBe(2)
    expect(upstreamClosed).toHaveBeenCalledTimes(1)
    expect(finalized.mock.calls[0]?.[0].decision).toMatchObject({
      outcome: 'error',
      error: { kind: result.error?.kind, code: result.error?.code },
    })
  })

  it('surfaces an upstream close failure when no primary failure exists', async () => {
    const closeError = new Error('reader cancel failed')
    const upstreamClosed = vi.fn()
    const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
      try {
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'partial' } }] } }
      } finally {
        upstreamClosed()
        await Promise.reject(closeError)
      }
    }
    const iterator = splitAssistantStream(source(), chatRouteContract())[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { lane: 'text', text: 'partial' },
    })
    await expect(iterator.return(undefined)).rejects.toBe(closeError)
    expect(upstreamClosed).toHaveBeenCalledTimes(1)
  })

  it('closes the upstream iterator when a local journal append fails', async () => {
    const appendError = new Error('IndexedDB append failed')
    let produced = 0
    const upstreamClosed = vi.fn()
    const source = async function* (): AsyncGenerator<AssistantStreamChunk> {
      try {
        produced += 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'partial' } }] } }
        produced += 1
        yield { type: 'delta', chunk: { choices: [{ delta: { content: 'not consumed' } }] } }
      } finally {
        upstreamClosed()
      }
    }
    const finalized = vi.fn<(input: GenerationAttemptFinalizationInput) => void>()

    const result = await runTestGenerationAttempt({
      open: () => source(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble({
        append: () => {
          throw appendError
        },
      }),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async (input) => {
          finalized(input)
          return undefined
        },
      }),
    })

    expect(result).toMatchObject({
      outcome: 'error',
      error: { kind: 'storage', code: 'STORAGE', message: appendError.message },
    })
    expect(produced).toBe(1)
    expect(upstreamClosed).toHaveBeenCalledTimes(1)
    expect(finalized.mock.calls[0]?.[0]).toMatchObject({
      decision: {
        outcome: result.outcome,
        ...(result.outcome === 'error'
          ? { error: { kind: result.error.kind, code: result.error.code } }
          : {}),
      },
    })
  })

  it('leaves journal settlement to the terminal custodian', async () => {
    const settleError = new Error('journal settlement failed')
    const finalized = vi.fn<(input: GenerationAttemptFinalizationInput) => void>()
    const completed = vi.fn<GenerationAttemptRunnerInput['terminal']['complete']>()

    const journal = journalDouble({ settleError })
    const result = await runTestGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'complete' } }] } },
          { type: 'transport_terminal', evidence: 'done-sentinel' },
        ),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async (input) => {
          finalized(input)
          await completed(input)
        },
      }),
    })

    expect(result).toEqual({ outcome: 'done' })
    expect(finalized).toHaveBeenCalledTimes(1)
    expect(finalized.mock.calls[0]?.[0]).toMatchObject({ decision: { outcome: 'done' } })
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: { outcome: 'done' },
      }),
    )
    expect(journal.settle).not.toHaveBeenCalled()
  })

  it('keeps housekeeping internal to the terminal custodian', async () => {
    const completed = vi.fn<GenerationAttemptRunnerInput['terminal']['complete']>()

    const result = await runTestGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'done' } }] } },
          { type: 'transport_terminal', evidence: 'done-sentinel' },
        ),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({ complete: async (input) => completed(input) }),
    })

    expect(result).toEqual({ outcome: 'done' })
    expect(completed).toHaveBeenCalledOnce()
  })

  it('rejects a canonical finalizer failure without duplicating custodian settlement', async () => {
    const finalizerError = new Error('canonical write failed')
    const order: string[] = []
    const journal = journalDouble({
      settle: () => {
        order.push('settle')
      },
    })
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })

    const attempt = runTestGenerationAttempt({
      open: () =>
        chunks({ type: 'delta', chunk: { choices: [{ delta: { content: 'retained' } }] } }),
      accumulator,
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async () => {
          order.push('finalize')
          throw finalizerError
        },
      }),
    })

    await expect(attempt).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'storage',
      code: 'STORAGE',
      message: finalizerError.message,
    })
    expect(journal.settle).not.toHaveBeenCalled()
    expect(journal.flush).not.toHaveBeenCalledWith({ mode: 'immediate' })
    expect(order).toEqual(['finalize'])
    expect(journal.release).toHaveBeenCalledTimes(1)
    expect(accumulator.textSections).toEqual([])
  })

  it('keeps the canonical failure primary without a second runner-owned recovery path', async () => {
    const finalizerError = new Error('canonical write failed')
    const settleError = new Error('journal settlement failed')
    const flushError = new Error('journal fallback flush failed')
    const order: string[] = []
    const journal = journalDouble({
      settle: async () => {
        order.push('settle')
        throw settleError
      },
      immediateFlush: async () => {
        order.push('flush')
        throw flushError
      },
    })

    const attempt = runTestGenerationAttempt({
      open: () =>
        chunks({ type: 'delta', chunk: { choices: [{ delta: { content: 'retained' } }] } }),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      terminal: terminalDouble({
        complete: async () => {
          order.push('finalize')
          throw finalizerError
        },
      }),
    })

    await expect(attempt).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'storage',
      code: 'STORAGE',
      message: finalizerError.message,
    })
    expect(journal.settle).not.toHaveBeenCalled()
    expect(journal.flush).not.toHaveBeenCalledWith({ mode: 'immediate' })
    expect(order).toEqual(['finalize'])
  })
})

function journalDouble(
  options: {
    append?: (event: Parameters<StreamJournalWriter['append']>[0]) => void
    scheduledFlush?: () => void
    settle?: () => void | Promise<void>
    backpressure?: () => Promise<void> | undefined
    release?: () => void
    immediateFlush?: () => Promise<void>
    immediateFlushError?: Error
    settleError?: Error
  } = {},
) {
  const append = vi.fn(
    (
      event: Parameters<StreamJournalWriter['append']>[0],
      _now: Parameters<StreamJournalWriter['append']>[1],
    ) => {
      options.append?.(event)
    },
  )
  const flush = vi.fn((request?: { mode: 'scheduled'; now: number } | { mode: 'immediate' }) => {
    if (request?.mode === 'scheduled') {
      options.scheduledFlush?.()
      return
    }
    if (options.immediateFlush) return options.immediateFlush()
    if (options.immediateFlushError) return Promise.reject(options.immediateFlushError)
    return Promise.resolve()
  })
  const settle = vi.fn(async () => {
    await options.settle?.()
    if (options.settleError) throw options.settleError
  })
  const checkpoint = vi.fn(async () => {
    try {
      await flush({ mode: 'immediate' })
    } catch {
      await flush({ mode: 'immediate' })
    }
  })
  const backpressure = vi.fn(() => options.backpressure?.())
  const release = vi.fn(() => {
    options.release?.()
  })
  return {
    append,
    flush,
    checkpoint,
    backpressure,
    settle,
    release,
  } as unknown as StreamJournalWriter & {
    append: typeof append
    flush: typeof flush
    checkpoint: typeof checkpoint
    backpressure: typeof backpressure
    settle: typeof settle
    release: typeof release
  }
}

function prepareLiveCallback(
  callback: (input: { accumulator: StreamAccumulator; now: number }) => void | Promise<void>,
): NonNullable<GenerationAttemptRunnerInput['prepareLive']> {
  return (input) => () => callback(input)
}

async function* chunks(
  ...values: readonly AssistantStreamChunk[]
): AsyncGenerator<AssistantStreamChunk> {
  for (const value of values) yield value
}

async function* failedStream(error: unknown): AsyncGenerator<AssistantStreamChunk> {
  yield* chunks()
  throw error
}

function apiError(kind: 'network' | 'provider_error'): ApiError {
  return new ApiError({
    kind,
    code: kind.toUpperCase(),
    message: kind,
    midStream: false,
    retryable: true,
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function requireWriterRootPermit(): WorkspaceWritePermit {
  if (!writerRootPermit) throw new Error('GenerationAttemptRunnerTestRuntimeNotReady')
  return writerRootPermit
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

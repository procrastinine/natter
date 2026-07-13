import { describe, expect, it, vi } from 'vitest'
import { splitAssistantStream } from '../../src/api/assistant-lanes'
import type { AssistantStreamChunk } from '../../src/api/assistant-stream'
import { ApiError } from '../../src/api/errors'
import {
  CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
  type GenerationAttemptResult,
  type GenerationAttemptRunnerInput,
  runGenerationAttempt,
  SEND_GENERATION_ATTEMPT_ERROR_POLICY,
} from '../../src/core/generation-attempt-runner'
import {
  createStreamAccumulator,
  projectStreamAccumulatorFinal,
  type StreamAccumulator,
  streamAccumulatorText,
} from '../../src/core/stream-accumulator'
import type { StreamChunkRow } from '../../src/store/repository'
import {
  createStreamChunkWriter,
  type StreamChunkWriter,
} from '../../src/store/stream-chunk-writer'

type GenerationAttemptFinalizationInput = Parameters<GenerationAttemptRunnerInput['finalize']>[0]

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
      scheduledFlush: () => log.push('schedule'),
      settle: () => log.push('settle'),
      release: () => log.push('release'),
    })
    const publishLive = vi.fn(() => {
      log.push('publish')
      expect(streamAccumulatorText(accumulator)).toHaveLength(2_048)
    })
    const finalize = vi.fn(async () => {
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

    const result = await runGenerationAttempt({
      open,
      accumulator,
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      now: () => 1,
      prepareLive: prepareLiveCallback(publishLive),
      finalize,
      cleanupJournal,
      cleanup,
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
      'publish',
      'schedule',
      'append:finish',
      'schedule',
      'settle',
      'finalize',
      'cleanup-journal',
      'release',
      'cleanup',
    ])
    expect(accumulator.textSections).toEqual([])
    expect(accumulator.initialContent).toEqual([])
  })

  it('publishes only after the accumulator live-update gate opens', async () => {
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })
    const publishLive = vi.fn()

    await runGenerationAttempt({
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
      finalize: async () => {},
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    expect(publishLive).toHaveBeenCalledTimes(2)
    expect(publishLive.mock.calls[0]?.[0]).toMatchObject({ now: 0 })
    expect(publishLive.mock.calls[1]?.[0]).toMatchObject({ now: 0 })
  })

  it('does not publish live output until the matching recovery journal is durable', async () => {
    const durable = deferred<void>()
    const publishLive = vi.fn()
    let immediateFlushes = 0
    const attempt = runGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'visible' } }] } },
          { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
        ),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble({
        immediateFlush: () => {
          immediateFlushes += 1
          return durable.promise
        },
      }),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      prepareLive: prepareLiveCallback(publishLive),
      finalize: async () => {},
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    await drainMicrotasks()
    expect(immediateFlushes).toBe(1)
    expect(publishLive).not.toHaveBeenCalled()

    durable.resolve()
    await expect(attempt).resolves.toMatchObject({ outcome: 'done' })
    expect(publishLive).toHaveBeenCalled()
  })

  it('does not force publication flushes when the target chat is not visible', async () => {
    const journal = journalDouble()
    const prepareLive = vi.fn(() => undefined)

    await runGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'offscreen' } }] } },
          { type: 'delta', chunk: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
        ),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      prepareLive,
      finalize: async () => {},
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    expect(prepareLive).toHaveBeenCalled()
    expect(journal.flush).not.toHaveBeenCalledWith({ mode: 'immediate' })
  })

  it('coalesces burst durability writes at the shared 128 KiB publication budget', async () => {
    const committed: StreamChunkRow[][] = []
    const journal = createStreamChunkWriter({
      port: {
        appendStreamChunks: async (rows) => {
          committed.push(structuredClone([...rows]))
        },
      },
      chatId: 'chat-burst',
      streamId: 'stream-burst',
      messageId: 'message-burst',
      now: 0,
      fence: { ownerClientId: 'owner-burst', fenceToken: 'fence-burst', replacementEpoch: 0 },
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

    await runGenerationAttempt({
      open: () => chunks(...values),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      now: () => 0,
      prepareLive: prepareLiveCallback(publishLive),
      finalize: async () => {},
      cleanupJournal: async () => {},
      cleanup: () => {},
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

    const result = await runGenerationAttempt({
      open: () => chunks(...source),
      accumulator,
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async ({ outcome, error }) => {
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
      cleanupJournal: async () => {},
      cleanup: () => {},
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
    const result = await runGenerationAttempt({
      open: () => chunks({ type: 'transport_terminal', evidence: 'done-sentinel' }),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async ({ outcome }) => expect(outcome).toBe('done'),
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    expect(result).toEqual({ outcome: 'done' })
  })

  it.each([
    {
      name: 'Responses response.completed',
      chunk: {
        type: 'event',
        event: { type: 'response.completed', response: { status: 'completed' } },
      },
    },
    {
      name: 'Anthropic message_stop',
      chunk: {
        type: 'anthropic_event',
        event: { type: 'message_stop' },
      },
    },
    {
      name: 'Gemini finishReason',
      chunk: {
        type: 'chunk',
        chunk: {
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
        },
      },
    },
  ] satisfies ReadonlyArray<{
    name: string
    chunk: AssistantStreamChunk
  }>)('accepts $name as clean protocol terminal evidence', async ({ chunk }) => {
    const result = await runGenerationAttempt({
      open: () => chunks(chunk),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async ({ outcome }) => expect(outcome).toBe('done'),
      cleanupJournal: async () => {},
      cleanup: () => {},
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

    const result = await runGenerationAttempt({
      open: () => source(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async ({ outcome }) => expect(outcome).toBe('done'),
      cleanupJournal: async () => {},
      cleanup: () => {},
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
      backpressure: () => {
        checks += 1
        return checks === 1 ? capacity.promise : undefined
      },
    })
    const attempt = runGenerationAttempt({
      open: () => source(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async () => {},
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    await drainMicrotasks()
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
      const attempt = runGenerationAttempt({
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
        finalize: async () => {},
        cleanupJournal: async () => {},
        cleanup: () => {},
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

  it('applies only the prepared durable revision when newer output arrives during a flush', async () => {
    vi.useFakeTimers()
    try {
      const allowThirdChunk = deferred<void>()
      const thirdChunkConsumed = deferred<void>()
      const releaseStream = deferred<void>()
      const blockedFlush = deferred<void>()
      const blockedFlushStarted = deferred<void>()
      const firstPublished = deferred<void>()
      const secondPublished = deferred<void>()
      let clock = 0
      let immediateFlushes = 0
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
      const attempt = runGenerationAttempt({
        open: () => source(),
        accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
        journal: journalDouble({
          immediateFlush: () => {
            immediateFlushes += 1
            if (immediateFlushes !== 2) return Promise.resolve()
            blockedFlushStarted.resolve()
            return blockedFlush.promise
          },
        }),
        errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
        now: () => clock,
        prepareLive: ({ accumulator: current }) => {
          const text = streamAccumulatorText(current)
          return () => {
            published.push(text)
            if (published.length === 1) firstPublished.resolve()
            if (published.length === 2) secondPublished.resolve()
          }
        },
        finalize: async () => {},
        cleanupJournal: async () => {},
        cleanup: () => {},
      })

      await firstPublished.promise
      await vi.advanceTimersByTimeAsync(124)
      await blockedFlushStarted.promise
      allowThirdChunk.resolve()
      await thirdChunkConsumed.promise
      expect(published).toEqual(['a'])

      blockedFlush.resolve()
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
      const attempt = runGenerationAttempt({
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
        finalize: async () => {},
        cleanupJournal: async () => {},
        cleanup: () => {},
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
    const committed: StreamChunkRow[] = []
    let writes = 0
    const journal = createStreamChunkWriter({
      port: {
        appendStreamChunks: async (rows) => {
          writes += 1
          if (writes === 1) throw new Error('transient IndexedDB failure')
          committed.push(...structuredClone([...rows]))
        },
      },
      chatId: 'chat-1',
      streamId: 'stream-1',
      messageId: 'message-1',
      now: 0,
      fence: { ownerClientId: 'owner-1', fenceToken: 'fence-1', replacementEpoch: 0 },
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

    const result = await runGenerationAttempt({
      open: () => chunks(...values),
      accumulator,
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async ({ outcome }) => {
        expect(outcome).toBe('done')
        expect(streamAccumulatorText(accumulator)).toBe('x'.repeat(600))
      },
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    expect(result).toMatchObject({ outcome: 'done', finishReason: 'stop' })
    expect(writes).toBeGreaterThanOrEqual(2)
    expect(committed.length).toBeGreaterThan(0)
  })

  it('runs the final dispatch guard immediately before opening and rethrows a guard failure after cleanup', async () => {
    const stale = new Error('stale send context')
    const log: string[] = []
    const open = vi.fn(() => {
      log.push('open')
      return chunks()
    })
    const attempt = runGenerationAttempt({
      beforeDispatch: async () => {
        log.push('guard')
        throw stale
      },
      open,
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble({ release: () => log.push('release') }),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async ({ outcome, error }) => {
        log.push(`finalize:${outcome}:${error?.code}`)
      },
      cleanupJournal: async () => {
        log.push('cleanup-journal')
      },
      cleanup: ({ outcome }) => {
        log.push(`cleanup:${outcome}`)
      },
    })

    await expect(attempt).rejects.toBe(stale)
    expect(open).not.toHaveBeenCalled()
    expect(log).toEqual([
      'guard',
      'finalize:error:INTERNAL',
      'cleanup-journal',
      'release',
      'cleanup:error',
    ])
  })

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
    const finalized: GenerationAttemptResult[] = []
    const journal = journalDouble()
    const result = await runGenerationAttempt({
      open: () => failedStream(error),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal,
      errorPolicy: policy,
      finalize: async (input) => {
        finalized.push({
          outcome: input.outcome,
          ...(input.abortReason ? { abortReason: input.abortReason } : {}),
          ...(input.error ? { error: input.error } : {}),
        })
      },
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    expect(result.outcome).toBe(expected.outcome)
    expect(result.abortReason).toBe('abortReason' in expected ? expected.abortReason : undefined)
    expect(result.error?.kind).toBe('errorKind' in expected ? expected.errorKind : undefined)
    expect(finalized).toHaveLength(1)
    expect(finalized[0]?.outcome).toBe(expected.outcome)
    expect(journal.append).toHaveBeenCalledWith({ lane: 'error', error }, expect.any(Number))
  })

  it('classifies an aborted stream before applying the unknown-error policy', async () => {
    const result = await runGenerationAttempt({
      open: () => failedStream(new Error('abort transport detail')),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
      isAborted: () => true,
      abortReason: () => 'tab-close',
      finalize: async () => {},
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    expect(result).toEqual({ outcome: 'abort', abortReason: 'tab-close' })
  })

  it('normalizes unknown stream failures and preserves Continue rethrow semantics', async () => {
    const sendError = new Error('send parser failed')
    const sendLog: string[] = []
    const sendResult = await runGenerationAttempt({
      open: () => failedStream(sendError),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async ({ outcome, error }) => {
        sendLog.push(`finalize:${outcome}:${String(error)}`)
      },
      cleanupJournal: async () => {
        sendLog.push('cleanup-journal')
      },
      cleanup: ({ outcome }) => {
        sendLog.push(`cleanup:${outcome}`)
      },
    })

    expect(sendResult).toMatchObject({
      outcome: 'error',
      error: { kind: 'protocol', code: 'PROTOCOL', message: sendError.message },
    })
    expect(sendLog).toEqual([
      'finalize:error:ApiError: send parser failed',
      'cleanup-journal',
      'cleanup:error',
    ])

    const continueError = new Error('continue parser failed')
    const continueLog: string[] = []
    const continuing = runGenerationAttempt({
      open: () => failedStream(continueError),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: CONTINUE_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async ({ outcome }) => {
        continueLog.push(`finalize:${outcome}`)
      },
      cleanupJournal: async () => {
        continueLog.push('cleanup-journal')
      },
      cleanup: ({ outcome }) => {
        continueLog.push(`cleanup:${outcome}`)
      },
    })

    await expect(continuing).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'protocol',
      code: 'PROTOCOL',
      message: continueError.message,
    })
    expect(continueLog).toEqual(['finalize:error', 'cleanup-journal', 'cleanup:error'])
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

    const result = await runGenerationAttempt({
      open: () => source(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async (input) => finalized(input),
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    expect(result.outcome).toBe('error')
    expect(result.error).toBeInstanceOf(ApiError)
    expect(result.error?.kind).toBe('rate_limited')
    expect(result.error?.midStream).toBe(true)
    expect(produced).toBe(2)
    expect(upstreamClosed).toHaveBeenCalledTimes(1)
    expect(finalized.mock.calls[0]?.[0].error).toBe(result.error)
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
    const iterator = splitAssistantStream(source())[Symbol.asyncIterator]()

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

    const result = await runGenerationAttempt({
      open: () => source(),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble({
        append: () => {
          throw appendError
        },
      }),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async (input) => finalized(input),
      cleanupJournal: async () => {},
      cleanup: () => {},
    })

    expect(result).toMatchObject({
      outcome: 'error',
      error: { kind: 'storage', code: 'STORAGE', message: appendError.message },
    })
    expect(produced).toBe(1)
    expect(upstreamClosed).toHaveBeenCalledTimes(1)
    expect(finalized.mock.calls[0]?.[0]).toMatchObject(result)
  })

  it('commits an explicit storage outcome when journal settlement remains degraded', async () => {
    const settleError = new Error('journal settlement failed')
    const finalized = vi.fn<(input: GenerationAttemptFinalizationInput) => void>()
    const cleaned = vi.fn<(input: GenerationAttemptResult) => void>()

    const result = await runGenerationAttempt({
      open: () =>
        chunks({ type: 'delta', chunk: { choices: [{ delta: { content: 'partial' } }] } }),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble({ settleError }),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async (input) => finalized(input),
      cleanupJournal: async () => {},
      cleanup: (input) => cleaned(input),
    })

    expect(result).toMatchObject({
      outcome: 'error',
      error: { kind: 'storage', code: 'STORAGE', message: settleError.message },
    })
    expect(finalized).toHaveBeenCalledTimes(1)
    expect(finalized.mock.calls[0]?.[0]).toMatchObject(result)
    expect(cleaned).toHaveBeenCalledWith(result)
  })

  it('returns a cleanup token without rewriting an already committed outcome', async () => {
    const cleanupError = new Error('chunk cleanup failed')
    const cleaned = vi.fn<(input: GenerationAttemptResult) => void>()

    const result = await runGenerationAttempt({
      open: () =>
        chunks(
          { type: 'delta', chunk: { choices: [{ delta: { content: 'done' } }] } },
          { type: 'transport_terminal', evidence: 'done-sentinel' },
        ),
      accumulator: createStreamAccumulator({ initialContent: [], now: 0 }),
      journal: journalDouble(),
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async () => {},
      cleanupJournal: async () => {
        throw cleanupError
      },
      cleanup: (input) => cleaned(input),
    })

    expect(result).toEqual({ outcome: 'done', journalCleanupPending: true })
    expect(cleaned).toHaveBeenCalledWith(result)
  })

  it('rejects a canonical finalizer failure after recovery flush and guaranteed cleanup', async () => {
    const finalizerError = new Error('canonical write failed')
    const cleanupJournal = vi.fn(async () => {})
    const cleaned: GenerationAttemptResult[] = []
    const journal = journalDouble({ immediateFlushError: new Error('journal also failed') })
    const accumulator = createStreamAccumulator({ initialContent: [], now: 0 })

    const attempt = runGenerationAttempt({
      open: () =>
        chunks({ type: 'delta', chunk: { choices: [{ delta: { content: 'retained' } }] } }),
      accumulator,
      journal,
      errorPolicy: SEND_GENERATION_ATTEMPT_ERROR_POLICY,
      finalize: async () => {
        throw finalizerError
      },
      cleanupJournal,
      cleanup: (result) => {
        cleaned.push(result)
      },
    })

    await expect(attempt).rejects.toMatchObject({
      name: 'ApiError',
      kind: 'storage',
      code: 'STORAGE',
      message: finalizerError.message,
    })
    expect(journal.settle).toHaveBeenCalledTimes(1)
    expect(journal.flush).toHaveBeenCalledWith({ mode: 'immediate' })
    expect(
      journal.flush.mock.calls.filter(([request]) => request?.mode === 'immediate'),
    ).toHaveLength(1)
    expect(cleanupJournal).not.toHaveBeenCalled()
    expect(journal.release).toHaveBeenCalledTimes(1)
    expect(cleaned).toHaveLength(1)
    expect(cleaned[0]).toMatchObject({
      outcome: 'error',
      error: { kind: 'storage', code: 'STORAGE', message: finalizerError.message },
    })
    expect(accumulator.textSections).toEqual([])
  })
})

function journalDouble(
  options: {
    append?: (event: Parameters<StreamChunkWriter['append']>[0]) => void
    scheduledFlush?: () => void
    settle?: () => void
    backpressure?: () => Promise<void> | undefined
    release?: () => void
    immediateFlush?: () => Promise<void>
    immediateFlushError?: Error
    settleError?: Error
  } = {},
) {
  const append = vi.fn(
    (
      event: Parameters<StreamChunkWriter['append']>[0],
      _now: Parameters<StreamChunkWriter['append']>[1],
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
    options.settle?.()
    if (options.settleError) throw options.settleError
  })
  const backpressure = vi.fn(() => options.backpressure?.())
  const release = vi.fn(() => {
    options.release?.()
  })
  return {
    append,
    flush,
    backpressure,
    settle,
    release,
  } as unknown as StreamChunkWriter & {
    append: typeof append
    flush: typeof flush
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

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

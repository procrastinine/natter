import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../src/api/errors'
import { parseSSE, type SSEEvent } from '../../src/api/sse'

function responseFromChunks(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

async function collect(response: Response): Promise<SSEEvent[]> {
  const out: SSEEvent[] = []
  for await (const ev of parseSSE(response)) out.push(ev)
  return out
}

afterEach(() => {
  vi.useRealTimers()
})

describe('parseSSE', () => {
  it('handles CRLF line endings', async () => {
    const r = responseFromChunks([enc('data: one\r\n\r\ndata: two\r\n\r\n')])
    const events = await collect(r)
    expect(events).toEqual([
      { kind: 'data', data: 'one' },
      { kind: 'data', data: 'two' },
    ])
  })

  it('concatenates multi-line data: events with \\n', async () => {
    const r = responseFromChunks([enc('data: line1\ndata: line2\ndata: line3\n\n')])
    const events = await collect(r)
    expect(events).toEqual([{ kind: 'data', data: 'line1\nline2\nline3' }])
  })

  it('emits `:` comments as keepalives (used for hang detection)', async () => {
    const r = responseFromChunks([enc(': OPENROUTER PROCESSING\n\ndata: hi\n\n')])
    const events = await collect(r)
    expect(events).toEqual([
      { kind: 'keepalive', comment: 'OPENROUTER PROCESSING' },
      { kind: 'data', data: 'hi' },
    ])
  })

  it('flushes an unterminated terminal event (no trailing blank line)', async () => {
    const r = responseFromChunks([enc('data: final\n')])
    const events = await collect(r)
    expect(events).toEqual([{ kind: 'data', data: 'final' }])
  })

  it('emits explicit terminal evidence for [DONE] and stops before later frames', async () => {
    const r = responseFromChunks([enc('data: one\n\ndata: [DONE]\n\ndata: never\n\n')])
    const events = await collect(r)
    expect(events).toEqual([{ kind: 'data', data: 'one' }, { kind: 'done' }])
  })

  it('emits terminal evidence for [DONE] without a trailing blank line', async () => {
    const r = responseFromChunks([enc('data: [DONE]')])
    expect(await collect(r)).toEqual([{ kind: 'done' }])
  })

  it('survives UTF-8 code points split across chunk boundaries', async () => {
    // U+1F600 😀 = F0 9F 98 80. Split after the first two bytes.
    const bytes = new TextEncoder().encode('data: hi 😀\n\n')
    const idx = 8 // after "data: hi " (9 chars). The split must land mid-emoji.
    const splitAt = 10
    const first = bytes.slice(0, splitAt)
    const second = bytes.slice(splitAt)
    // Sanity: the split must actually land inside the emoji.
    expect(splitAt).toBeGreaterThan(idx)
    const r = responseFromChunks([first, second])
    const events = await collect(r)
    expect(events).toEqual([{ kind: 'data', data: 'hi 😀' }])
  })

  it('preserves mixed SSE semantics when every byte is a separate chunk', async () => {
    const source =
      'event: custom\r\ndata: first\r\ndata: second\n\n: still working\r\n\r\ndata: final'
    const bytes = enc(source)
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte))

    expect(await collect(responseFromChunks(chunks))).toEqual([
      { kind: 'data', event: 'custom', data: 'first\nsecond' },
      { kind: 'keepalive', comment: 'still working' },
      { kind: 'data', data: 'final' },
    ])
  })

  it('does not allocate one watchdog timer per incoming chunk', async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    const source = `data: ${'x'.repeat(10_000)}\n\n`
    const chunks = Array.from(enc(source), (byte) => Uint8Array.of(byte))

    await expect(collect(responseFromChunks(chunks))).resolves.toEqual([
      { kind: 'data', data: 'x'.repeat(10_000) },
    ])
    expect(timeout).toHaveBeenCalledTimes(2)
  })

  it('assembles a large unterminated line from fragments without changing its payload', async () => {
    const payload = 'x'.repeat(100_000)
    const source = `data: ${payload}`
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < source.length; offset += 31) {
      chunks.push(enc(source.slice(offset, offset + 31)))
    }

    expect(await collect(responseFromChunks(chunks))).toEqual([{ kind: 'data', data: payload }])
  })

  it('bounds a trickled unterminated line even while bytes keep arriving', async () => {
    const source = `data: ${'x'.repeat(32)}`
    const response = responseFromChunks(Array.from(enc(source), (byte) => Uint8Array.of(byte)))
    const run = async () => {
      for await (const _ of parseSSE(response, {
        watchdog: { firstByteTimeoutMs: 0, idleTimeoutMs: 0 },
        maxPendingEventChars: 16,
      })) {
        /* drain */
      }
    }

    await expect(run()).rejects.toMatchObject({
      kind: 'protocol',
      code: 'SSE_FRAME_TOO_LARGE',
      midStream: true,
      retryable: false,
    })
  })

  it('bounds a multi-line event even when each individual line is within the limit', async () => {
    const response = responseFromChunks([enc('data: 1234567890\ndata: abcdefghij\n\n')])
    const run = async () => {
      for await (const _ of parseSSE(response, { maxPendingEventChars: 16 })) {
        /* drain */
      }
    }

    await expect(run()).rejects.toMatchObject({
      kind: 'protocol',
      code: 'SSE_FRAME_TOO_LARGE',
      midStream: true,
      retryable: false,
    })
  })

  it('strips a single leading space after `data:` per the SSE spec', async () => {
    const r = responseFromChunks([enc('data:  two-leading-spaces\n\n')])
    const events = await collect(r)
    // Only the first space is stripped; the second is preserved as part of the value.
    expect(events).toEqual([{ kind: 'data', data: ' two-leading-spaces' }])
  })

  it('carries `event:` field through to the emitted event', async () => {
    const r = responseFromChunks([enc('event: custom\ndata: payload\n\n')])
    const events = await collect(r)
    expect(events).toEqual([{ kind: 'data', event: 'custom', data: 'payload' }])
  })

  it('normalizes a missing response body as a protocol error', async () => {
    const response = new Response(null)
    await expect(async () => {
      for await (const _ of parseSSE(response)) {
        /* noop */
      }
    }).rejects.toMatchObject({
      kind: 'protocol',
      code: 'PROTOCOL',
      message: 'Provider response could not be decoded',
      midStream: true,
      retryable: false,
    })
  })

  it('times out when an open stream produces no bytes', async () => {
    vi.useFakeTimers()
    const response = new Response(new ReadableStream<Uint8Array>({}), {
      headers: { 'content-type': 'text/event-stream' },
    })
    const next = parseSSE(response, { watchdog: { firstByteTimeoutMs: 100 } }).next()
    const expectation = expect(next).rejects.toMatchObject({
      kind: 'timeout',
      code: 'TIMEOUT',
      midStream: true,
      retryable: true,
    })

    await vi.advanceTimersByTimeAsync(100)
    await expectation
  })

  it('starts a fresh idle deadline after a keepalive', async () => {
    vi.useFakeTimers()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const iterator = parseSSE(response, {
      watchdog: { firstByteTimeoutMs: 100, idleTimeoutMs: 100 },
    })
    const keepalive = iterator.next()

    await vi.advanceTimersByTimeAsync(90)
    stream?.enqueue(enc(': still working\n\n'))
    await expect(keepalive).resolves.toEqual({
      done: false,
      value: { kind: 'keepalive', comment: 'still working' },
    })

    let settled = false
    const data = iterator.next()
    void data.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await vi.advanceTimersByTimeAsync(90)
    expect(settled).toBe(false)
    stream?.enqueue(enc('data: ready\n\n'))
    stream?.close()
    await expect(data).resolves.toEqual({
      done: false,
      value: { kind: 'data', data: 'ready' },
    })
  })

  it('does not count consumer backpressure as upstream silence', async () => {
    vi.useFakeTimers()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
          controller.enqueue(enc('data: first\n\n'))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const iterator = parseSSE(response, {
      watchdog: { firstByteTimeoutMs: 100, idleTimeoutMs: 100 },
    })
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { kind: 'data', data: 'first' },
    })

    await vi.advanceTimersByTimeAsync(10_000)
    const next = iterator.next()
    await vi.advanceTimersByTimeAsync(90)
    stream?.enqueue(enc('data: second\n\n'))
    stream?.close()
    await expect(next).resolves.toEqual({
      done: false,
      value: { kind: 'data', data: 'second' },
    })
  })

  it('resets on partial bytes but times out if the frame never completes', async () => {
    vi.useFakeTimers()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const next = parseSSE(response, {
      watchdog: { firstByteTimeoutMs: 100, idleTimeoutMs: 100 },
    }).next()
    let settled = false
    void next.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await vi.advanceTimersByTimeAsync(90)
    stream?.enqueue(enc('data: partial'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(90)
    expect(settled).toBe(false)
    const expectation = expect(next).rejects.toMatchObject({
      kind: 'timeout',
      code: 'TIMEOUT',
      midStream: true,
    })
    await vi.advanceTimersByTimeAsync(10)
    await expectation
  })

  it('does not treat a zero-length read as stream activity', async () => {
    vi.useFakeTimers()
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const next = parseSSE(response, { watchdog: { firstByteTimeoutMs: 100 } }).next()
    let settled = false
    void next.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    await vi.advanceTimersByTimeAsync(90)
    stream?.enqueue(new Uint8Array())
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(9)
    expect(settled).toBe(false)
    const expectation = expect(next).rejects.toMatchObject({ kind: 'timeout', midStream: true })
    await vi.advanceTimersByTimeAsync(1)
    await expectation
  })

  it('lets user abort win while a non-cooperative read is stalled', async () => {
    const controller = new AbortController()
    let cancelCalled = false
    let markReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    const response = {
      body: {
        getReader: () => ({
          read: () => {
            markReadStarted?.()
            return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {})
          },
          cancel: async () => {
            cancelCalled = true
          },
        }),
      },
    } as unknown as Response
    const next = parseSSE(response, {
      signal: controller.signal,
      watchdog: { firstByteTimeoutMs: 60_000, idleTimeoutMs: 60_000 },
    }).next()

    await readStarted
    controller.abort()
    await expect(next).rejects.toMatchObject({
      kind: 'abort',
      code: 'ABORTED',
      midStream: true,
      retryable: false,
    })
    expect(cancelCalled).toBe(true)
  })

  it('aborts an already-open stream when the caller signal fires mid-read', async () => {
    const controller = new AbortController()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(enc('data: one\n\n'))
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )
    const seen: SSEEvent[] = []
    await expect(async () => {
      for await (const ev of parseSSE(response, { signal: controller.signal })) {
        seen.push(ev)
        controller.abort()
      }
    }).rejects.toThrow(/abort/i)
    expect(seen).toEqual([{ kind: 'data', data: 'one' }])
  })

  it('maps a post-abort reader rejection to a typed abort', async () => {
    const controller = new AbortController()
    let cancelCalled = false
    let markReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve
    })
    const reader = {
      read: () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          markReadStarted?.()
          controller.signal.addEventListener('abort', () => reject(new TypeError('terminated')), {
            once: true,
          })
        }),
      cancel: async () => {
        cancelCalled = true
      },
    }
    const response = {
      body: {
        getReader: () => reader,
      },
    } as unknown as Response
    const iterator = parseSSE(response, { signal: controller.signal })
    const next = iterator.next()
    await readStarted
    controller.abort()
    await expect(next).rejects.toMatchObject({
      kind: 'abort',
      code: 'ABORTED',
      message: 'Request aborted',
      midStream: true,
      retryable: false,
    })
    expect(cancelCalled).toBe(true)
  })

  it('normalizes reader failures as network errors without retaining the raw failure', async () => {
    const response = {
      body: {
        getReader: () => ({
          read: async () => {
            throw new Error('reader-secret')
          },
          cancel: async () => {},
        }),
      },
    } as unknown as Response

    let thrown: unknown
    try {
      for await (const _ of parseSSE(response)) {
        /* noop */
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).toMatchObject({
      kind: 'network',
      code: 'NETWORK',
      message: 'Network error',
      midStream: true,
      retryable: true,
    })
    expect(JSON.stringify(thrown)).not.toContain('reader-secret')
  })

  it('normalizes arbitrary abort reasons without retaining them', async () => {
    const controller = new AbortController()
    controller.abort(new Error('abort-reason-secret'))
    let canceled = false
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(enc('data: never\n\n'))
        },
        cancel() {
          canceled = true
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )

    let thrown: unknown
    try {
      for await (const _ of parseSSE(response, { signal: controller.signal })) {
        /* noop */
      }
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(ApiError)
    expect(thrown).toMatchObject({
      kind: 'abort',
      code: 'ABORTED',
      message: 'Request aborted',
      midStream: true,
      retryable: false,
    })
    expect(JSON.stringify(thrown)).not.toContain('abort-reason-secret')
    expect(canceled).toBe(true)
  })
})

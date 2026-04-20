import { describe, expect, it } from 'vitest'
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

  it('terminates on [DONE] without emitting the sentinel', async () => {
    const r = responseFromChunks([enc('data: one\n\ndata: [DONE]\n\ndata: never\n\n')])
    const events = await collect(r)
    expect(events).toEqual([{ kind: 'data', data: 'one' }])
  })

  it('survives UTF-8 code points split across chunk boundaries', async () => {
    // U+1F600 😀 = F0 9F 98 80. Split after the first two bytes.
    const bytes = new TextEncoder().encode('data: hi 😀\n\n')
    const idx = 8 // after "data: hi " (9 chars). We want to split mid-emoji.
    const splitAt = 10
    const first = bytes.slice(0, splitAt)
    const second = bytes.slice(splitAt)
    // Sanity: the split must actually land inside the emoji.
    expect(splitAt).toBeGreaterThan(idx)
    const r = responseFromChunks([first, second])
    const events = await collect(r)
    expect(events).toEqual([{ kind: 'data', data: 'hi 😀' }])
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

  it('throws when the response has no body', async () => {
    const response = new Response(null)
    await expect(async () => {
      for await (const _ of parseSSE(response)) {
        /* noop */
      }
    }).rejects.toThrow(/no body/i)
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

  it('maps a post-abort reader rejection back to AbortError', async () => {
    const controller = new AbortController()
    let cancelCalled = false
    const reader = {
      read: () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new TypeError('terminated')),
            { once: true },
          )
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
    await expect(async () => {
      const iter = parseSSE(response, { signal: controller.signal })
      controller.abort()
      for await (const _ of iter) {
        /* noop */
      }
    }).rejects.toThrow(/abort/i)
    expect(cancelCalled).toBe(true)
  })
})

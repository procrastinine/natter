// Minimal SSE parser. See `plan/04-api-client.md §4.4`.
//
// Dependency-free async generator. Handles the four cases that trip up ad-hoc
// parsers: CRLF line endings, multi-line `data:` events, comment keepalives
// (`:` prefix), and UTF-8 code points split across chunk boundaries (via
// TextDecoder's streaming mode). Unterminated final events are flushed on
// `done` — some servers drop the trailing blank line on abort.

export type SSEEvent =
  | { kind: 'data'; event?: string; data: string }
  | { kind: 'keepalive'; comment: string }

export async function* parseSSE(
  response: Response,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<SSEEvent> {
  if (!response.body) throw new Error('parseSSE: response has no body')
  const signal = opts.signal
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataParts: string[] = []
  let aborted = signal?.aborted ?? false
  let abortReason: unknown = signal?.reason

  const throwIfAborted = () => {
    if (!aborted) return
    if (abortReason instanceof Error) throw abortReason
    throw new DOMException('aborted', 'AbortError')
  }

  const flushEvent = (): Extract<SSEEvent, { kind: 'data' }> | null => {
    if (dataParts.length === 0) {
      eventName = undefined
      return null
    }
    const data = dataParts.join('\n')
    const ev: SSEEvent = eventName
      ? { kind: 'data', event: eventName, data }
      : { kind: 'data', data }
    eventName = undefined
    dataParts = []
    return ev
  }

  const onAbort = () => {
    aborted = true
    abortReason = signal?.reason
    void reader.cancel(abortReason).catch(() => {})
  }

  try {
    if (signal && !signal.aborted) {
      signal.addEventListener('abort', onAbort, { once: true })
    } else if (aborted) {
      onAbort()
    }
    for (;;) {
      throwIfAborted()
      let readResult: ReadableStreamReadResult<Uint8Array>
      try {
        readResult = await reader.read()
      } catch (error) {
        if (aborted || signal?.aborted) {
          aborted = true
          abortReason = signal?.reason
          throwIfAborted()
        }
        throw error
      }
      const { done, value } = readResult
      throwIfAborted()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      for (;;) {
        const match = /\r?\n/.exec(buffer)
        if (!match) break
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)

        if (line === '') {
          const ev = flushEvent()
          if (ev) {
            if (ev.data === '[DONE]') return
            yield ev
          }
          continue
        }
        if (line.startsWith(':')) {
          yield { kind: 'keepalive', comment: line.slice(1).replace(/^ /, '') }
          continue
        }
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          // SSE spec: strip at most one leading space after the colon.
          dataParts.push(line.slice(5).replace(/^ /, ''))
        }
        // `id:` / `retry:` / unknown fields: ignore (OpenRouter doesn't use them).
      }
    }
    // Flush trailing incomplete line if any.
    if (buffer.length > 0) {
      if (buffer.startsWith('data:')) {
        dataParts.push(buffer.slice(5).replace(/^ /, ''))
      } else if (buffer.startsWith(':')) {
        yield { kind: 'keepalive', comment: buffer.slice(1).replace(/^ /, '') }
      }
      buffer = ''
    }
    // Unterminated terminal event (no trailing blank line).
    const ev = flushEvent()
    if (ev && ev.data !== '[DONE]') yield ev
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.cancel().catch(() => {})
  }
}

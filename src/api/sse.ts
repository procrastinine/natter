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

export async function* parseSSE(response: Response): AsyncGenerator<SSEEvent> {
  if (!response.body) throw new Error('parseSSE: response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let dataParts: string[] = []

  const flushEvent = (): SSEEvent | null => {
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

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      while (true) {
        const match = /\r?\n/.exec(buffer)
        if (!match) break
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)

        if (line === '') {
          const ev = flushEvent()
          if (ev) {
            if (ev.kind === 'data' && ev.data === '[DONE]') return
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
    if (ev && !(ev.kind === 'data' && ev.data === '[DONE]')) yield ev
  } finally {
    reader.cancel().catch(() => {})
  }
}

// Dependency-free async generator. Handles the four cases that trip up ad-hoc
// parsers: CRLF line endings, multi-line `data:` events, comment keepalives
// (`:` prefix), and UTF-8 code points split across chunk boundaries (via
// TextDecoder's streaming mode). Unterminated final events are flushed on
// `done` — some servers drop the trailing blank line on abort.

import { malformedStreamFrameDiagnostic } from '../lib/diagnostic-redaction'
import { readResponseJson, releaseResponseBodyTimeout } from './client'
import { ApiError, normalizeError } from './errors'
import type { StreamAdapter, StreamIntegrityEvent } from './stream-integrity'

export type {
  StreamAdapter,
  StreamIntegrityEvent,
} from './stream-integrity'

export type SSEEvent =
  | { kind: 'data'; event?: string; data: string }
  | { kind: 'keepalive'; comment: string }
  | { kind: 'done' }

export async function decodeProviderJson<T>(response: Response): Promise<T> {
  return readResponseJson<T>(response)
}

export function malformedJsonFrameReport(input: {
  adapter: StreamAdapter
  eventType: string | undefined
  data: string
  error: unknown
}): { integrity: StreamIntegrityEvent; diagnostic: Record<string, unknown> } {
  const eventType = safeStreamEventType(input.adapter, input.eventType)
  const diagnostic = malformedStreamFrameDiagnostic(eventType, input.data, input.error)
  return {
    integrity: {
      category: 'malformed-json-frame',
      adapter: input.adapter,
      eventType,
      count: 1,
      fingerprint: diagnostic.fingerprint as string,
      characterCount: diagnostic.characterCount as number,
    },
    diagnostic,
  }
}

function safeStreamEventType(adapter: StreamAdapter, eventType: string | undefined): string {
  if (eventType === undefined || eventType === '' || eventType === 'message') return 'message'
  if (adapter === 'anthropic-messages') {
    switch (eventType) {
      case 'message_start':
      case 'message_delta':
      case 'message_stop':
      case 'content_block_start':
      case 'content_block_delta':
      case 'content_block_stop':
      case 'ping':
      case 'error':
        return eventType
      default:
        return 'unknown'
    }
  }
  if (adapter === 'responses' && SAFE_RESPONSES_EVENT_TYPES.has(eventType)) return eventType
  return 'unknown'
}

const SAFE_RESPONSES_EVENT_TYPES = new Set([
  'response.created',
  'response.in_progress',
  'response.completed',
  'response.failed',
  'response.error',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.output_text.delta',
  'response.output_text.done',
  'response.reasoning.delta',
  'response.reasoning.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'response.web_search_call.in_progress',
  'response.web_search_call.searching',
  'response.web_search_call.completed',
  'response.file_search_call.in_progress',
  'response.file_search_call.searching',
  'response.file_search_call.completed',
  'response.image_generation_call.in_progress',
  'response.image_generation_call.partial_image',
  'response.image_generation_call.completed',
  'response.code_interpreter_call.in_progress',
  'response.code_interpreter_call.completed',
  'response.shell_call.in_progress',
  'response.shell_call.completed',
  'response.shell_call_output.completed',
])

export async function* parseSSE(
  response: Response,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<SSEEvent> {
  releaseResponseBodyTimeout(response)
  const signal = opts.signal
  if (signal?.aborted) {
    throw normalizeError(undefined, { midStream: true, cause: 'abort' })
  }
  let body: ReadableStream<Uint8Array> | null
  try {
    body = response.body
  } catch {
    throw normalizeError(undefined, { midStream: true, cause: 'protocol' })
  }
  if (!body) {
    throw normalizeError(undefined, { midStream: true, cause: 'protocol' })
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    reader = body.getReader()
  } catch {
    throw normalizeError(undefined, { midStream: true, cause: 'protocol' })
  }
  const decoder = new TextDecoder()
  let pendingLineParts: string[] = []
  let pendingLineLength = 0
  let eventName: string | undefined
  let dataParts: string[] = []
  let aborted = signal?.aborted ?? false

  const appendPendingLine = (part: string) => {
    if (part.length === 0) return
    pendingLineParts.push(part)
    pendingLineLength += part.length
  }

  const takePendingLine = (tail: string, stripTrailingCr: boolean): string => {
    let line: string
    if (pendingLineParts.length === 0) {
      line = tail
    } else {
      if (tail.length > 0) pendingLineParts.push(tail)
      line = pendingLineParts.join('')
    }
    pendingLineParts = []
    pendingLineLength = 0
    return stripTrailingCr && line.endsWith('\r') ? line.slice(0, -1) : line
  }

  const throwIfAborted = () => {
    if (!aborted) return
    throw normalizeError(undefined, { midStream: true, cause: 'abort' })
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
    try {
      void reader.cancel().catch(() => {})
    } catch {
      // Cancellation is best-effort; the typed abort below remains authoritative.
    }
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
          throwIfAborted()
        }
        if (error instanceof ApiError) throw error
        throw normalizeError(undefined, { midStream: true, cause: 'network' })
      }
      const { done, value } = readResult
      throwIfAborted()
      if (done) break
      let decoded: string
      try {
        decoded = decoder.decode(value, { stream: true })
      } catch {
        throw normalizeError(undefined, { midStream: true, cause: 'protocol' })
      }

      let lineStart = 0
      for (;;) {
        const newline = decoded.indexOf('\n', lineStart)
        if (newline < 0) break
        const line = takePendingLine(decoded.slice(lineStart, newline), true)
        lineStart = newline + 1

        if (line === '') {
          const ev = flushEvent()
          if (ev) {
            if (ev.data === '[DONE]') {
              yield { kind: 'done' }
              return
            }
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
      appendPendingLine(decoded.slice(lineStart))
    }
    // Flush trailing incomplete line if any.
    if (pendingLineLength > 0) {
      const line = takePendingLine('', false)
      if (line.startsWith('data:')) {
        dataParts.push(line.slice(5).replace(/^ /, ''))
      } else if (line.startsWith(':')) {
        yield { kind: 'keepalive', comment: line.slice(1).replace(/^ /, '') }
      }
    }
    // Unterminated terminal event (no trailing blank line).
    const ev = flushEvent()
    if (ev?.data === '[DONE]') yield { kind: 'done' }
    else if (ev) yield ev
  } finally {
    signal?.removeEventListener('abort', onAbort)
    try {
      void reader.cancel().catch(() => {})
    } catch {
      // Cancellation is best-effort after a typed transport outcome is already known.
    }
  }
}

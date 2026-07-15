// Dependency-free async generator. Handles the four cases that trip up ad-hoc
// parsers: CRLF line endings, multi-line `data:` events, comment keepalives
// (`:` prefix), and UTF-8 code points split across chunk boundaries (via
// TextDecoder's streaming mode). Unterminated final events are flushed on
// `done` — some servers drop the trailing blank line on abort.

import { malformedStreamFrameDiagnostic } from '../lib/diagnostic-redaction'
import { readResponseJson, releaseResponseBodyTimeout } from './client'
import { ApiError, normalizeError } from './errors'
import type { ProviderJsonValidation } from './provider-json-boundary'
import type { StreamAdapter, StreamIntegrityEvent } from './stream-integrity'

export type {
  StreamAdapter,
  StreamIntegrityEvent,
} from './stream-integrity'

export type SSEEvent =
  | { kind: 'data'; event?: string; data: string }
  | { kind: 'keepalive'; comment: string }
  | { kind: 'done' }

const DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS = 300_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000
const DEFAULT_MAX_PENDING_EVENT_CHARS = 32 * 1024 * 1024

export interface SSEWatchdogOptions {
  firstByteTimeoutMs?: number
  idleTimeoutMs?: number
}

function providerStreamEventTooLarge(): ApiError {
  return new ApiError({
    kind: 'protocol',
    code: 'SSE_FRAME_TOO_LARGE',
    message: 'Provider stream event exceeded the size limit',
    midStream: true,
    retryable: false,
  })
}

export async function decodeProviderJson<T>(response: Response): Promise<T> {
  return readResponseJson<T>(response)
}

export async function decodeValidatedProviderJson<T>(
  response: Response,
  validate: (value: unknown) => ProviderJsonValidation<T>,
): Promise<T> {
  const value = await readResponseJson<unknown>(response)
  const validation = validate(value)
  if (!validation.ok) {
    throw normalizeError(undefined, { midStream: false, cause: 'protocol' })
  }
  return validation.value
}

export function decodeProviderStreamFrame<T>(input: {
  adapter: StreamAdapter
  eventType: string | undefined
  data: string
  validate: (value: unknown, eventType: string | undefined) => ProviderJsonValidation<T>
}):
  | { ok: true; value: T }
  | {
      ok: false
      integrity: StreamIntegrityEvent
      diagnostic: Record<string, unknown>
    } {
  let value: unknown
  try {
    value = JSON.parse(input.data)
  } catch (error) {
    return { ok: false, ...malformedJsonFrameReport({ ...input, error }) }
  }
  const validation = input.validate(value, input.eventType)
  if (validation.ok) return validation
  return {
    ok: false,
    ...malformedFrameReport({
      ...input,
      category: 'malformed-event-shape',
      error: { name: 'ProviderFrameShapeError', code: validation.issue },
    }),
  }
}

export function malformedJsonFrameReport(input: {
  adapter: StreamAdapter
  eventType: string | undefined
  data: string
  error: unknown
}): { integrity: StreamIntegrityEvent; diagnostic: Record<string, unknown> } {
  return malformedFrameReport({ ...input, category: 'malformed-json-frame' })
}

function malformedFrameReport(input: {
  adapter: StreamAdapter
  eventType: string | undefined
  data: string
  error: unknown
  category: StreamIntegrityEvent['category']
}): { integrity: StreamIntegrityEvent; diagnostic: Record<string, unknown> } {
  const eventType = safeStreamEventType(input.adapter, input.eventType)
  const diagnostic = malformedStreamFrameDiagnostic(eventType, input.data, input.error)
  return {
    integrity: {
      category: input.category,
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
  opts: {
    signal?: AbortSignal
    watchdog?: SSEWatchdogOptions
    maxPendingEventChars?: number
  } = {},
): AsyncGenerator<SSEEvent> {
  releaseResponseBodyTimeout(response)
  const signal = opts.signal
  const firstByteTimeoutMs = Math.max(
    0,
    opts.watchdog?.firstByteTimeoutMs ?? DEFAULT_STREAM_FIRST_BYTE_TIMEOUT_MS,
  )
  const idleTimeoutMs = Math.max(0, opts.watchdog?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS)
  const maxPendingEventChars = Math.max(
    1,
    opts.maxPendingEventChars ?? DEFAULT_MAX_PENDING_EVENT_CHARS,
  )
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
  let dataLength = 0
  let readBudgetMs: number | null = firstByteTimeoutMs > 0 ? firstByteTimeoutMs : null

  const appendPendingLine = (part: string) => {
    if (part.length === 0) return
    if (pendingLineLength + part.length > maxPendingEventChars) {
      throw providerStreamEventTooLarge()
    }
    pendingLineParts.push(part)
    pendingLineLength += part.length
  }

  const appendDataPart = (part: string) => {
    const nextLength = dataLength + (dataParts.length > 0 ? 1 : 0) + part.length
    if (nextLength > maxPendingEventChars) {
      throw providerStreamEventTooLarge()
    }
    dataParts.push(part)
    dataLength = nextLength
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
    if (!signal?.aborted) return
    throw normalizeError(undefined, { midStream: true, cause: 'abort' })
  }

  const flushEvent = (): Extract<SSEEvent, { kind: 'data' }> | null => {
    if (dataParts.length === 0) {
      eventName = undefined
      dataLength = 0
      return null
    }
    const data = dataParts.join('\n')
    const ev: SSEEvent = eventName
      ? { kind: 'data', event: eventName, data }
      : { kind: 'data', data }
    eventName = undefined
    dataParts = []
    dataLength = 0
    return ev
  }

  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => {})
    } catch {
      // The typed transport outcome remains authoritative when cancellation is unavailable.
    }
  }

  let interruptedBy: 'timeout' | 'abort' | undefined
  let rejectInterrupted: ((error: ApiError) => void) | undefined
  const interruption = new Promise<never>((_, reject) => {
    rejectInterrupted = reject
  })
  void interruption.catch(() => {})
  let readPending = false
  let readDeadline: number | null = null
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined
  let watchdogTimerDeadline: number | undefined

  const interrupt = (cause: 'timeout' | 'abort') => {
    if (interruptedBy !== undefined) return
    interruptedBy = cause
    rejectInterrupted?.(normalizeError(undefined, { midStream: true, cause }))
    cancelReader()
  }

  const armWatchdog = (deadline: number | null) => {
    if (deadline === null || interruptedBy !== undefined) return
    if (watchdogTimer !== undefined && (watchdogTimerDeadline ?? 0) <= deadline) return
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer)
    watchdogTimerDeadline = deadline
    watchdogTimer = setTimeout(
      () => {
        watchdogTimer = undefined
        watchdogTimerDeadline = undefined
        if (!readPending || interruptedBy !== undefined || readDeadline === null) return
        if (Date.now() < readDeadline) {
          armWatchdog(readDeadline)
          return
        }
        interrupt(signal?.aborted ? 'abort' : 'timeout')
      },
      Math.max(0, deadline - Date.now()),
    )
  }

  const readNext = async (
    timeoutMs: number | null,
  ): Promise<{ result: ReadableStreamReadResult<Uint8Array>; elapsedMs: number }> => {
    throwIfAborted()
    const startedAt = Date.now()
    readPending = true
    readDeadline = timeoutMs === null ? null : startedAt + timeoutMs
    armWatchdog(readDeadline)
    try {
      const result = await Promise.race([reader.read(), interruption])
      return { result, elapsedMs: Math.max(0, Date.now() - startedAt) }
    } finally {
      readPending = false
      readDeadline = null
    }
  }

  const onAbort = () => interrupt('abort')
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      throwIfAborted()
      let readResult: ReadableStreamReadResult<Uint8Array>
      try {
        const read = await readNext(readBudgetMs)
        readResult = read.result
        if (!readResult.done && readResult.value.byteLength > 0) {
          readBudgetMs = idleTimeoutMs > 0 ? idleTimeoutMs : null
        } else if (!readResult.done && readBudgetMs !== null) {
          readBudgetMs -= read.elapsedMs
          if (readBudgetMs <= 0) {
            throwIfAborted()
            cancelReader()
            throw normalizeError(undefined, { midStream: true, cause: 'timeout' })
          }
        }
      } catch (error) {
        if (signal?.aborted) throwIfAborted()
        if (interruptedBy !== undefined) {
          throw normalizeError(undefined, { midStream: true, cause: interruptedBy })
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
        if (line.length > maxPendingEventChars) {
          throw providerStreamEventTooLarge()
        }
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
          appendDataPart(line.slice(5).replace(/^ /, ''))
        }
        // `id:` / `retry:` / unknown fields: ignore (OpenRouter doesn't use them).
      }
      appendPendingLine(decoded.slice(lineStart))
    }
    // Flush trailing incomplete line if any.
    if (pendingLineLength > 0) {
      const line = takePendingLine('', false)
      if (line.startsWith('data:')) {
        appendDataPart(line.slice(5).replace(/^ /, ''))
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
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer)
    cancelReader()
  }
}

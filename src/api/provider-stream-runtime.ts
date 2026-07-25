import { logStreamDebug, logStreamDebugError, type StreamDebugTrace } from '../lib/debug-streams'
import type { ProviderDispatchResult } from './client'
import type { ProviderJsonValidation } from './provider-json-boundary'
import { decodeProviderStreamFrame, decodeValidatedProviderJson, parseSSE } from './sse'
import type { StreamAdapter, StreamIntegrityEvent } from './stream-integrity'

type ProviderJsonValidator<T> = (value: unknown, sseEventType?: string) => ProviderJsonValidation<T>

export interface ProviderStreamRuntime<Frame, Buffered, Chunk> {
  readonly adapter: StreamAdapter
  readonly dispatched: Promise<ProviderDispatchResult>
  readonly signal?: AbortSignal
  readonly generationId: (response: Response) => string | undefined
  readonly validateBuffered: ProviderJsonValidator<Buffered>
  readonly validateFrame: ProviderJsonValidator<Frame>
  readonly bufferedChunk: (value: Buffered, generationId: string | undefined) => Chunk
  readonly frameChunk: (value: Frame, generationId: string | undefined) => Chunk
  readonly integrityChunk: (integrity: StreamIntegrityEvent) => Chunk
  readonly keepaliveChunk: (comment: string) => Chunk
  readonly doneChunk?: () => Chunk | undefined
}

export async function* consumeProviderStream<Frame, Buffered, Chunk>(
  runtime: ProviderStreamRuntime<Frame, Buffered, Chunk>,
): AsyncGenerator<Chunk, void, unknown> {
  const { response, debugTrace } = await runtime.dispatched
  try {
    const generationId = runtime.generationId(response)
    const contentType = response.headers.get('content-type') ?? ''
    if (!/text\/event-stream/i.test(contentType)) {
      const result = await decodeValidatedProviderJson(response, runtime.validateBuffered)
      logBufferedTerminal(debugTrace, result)
      yield runtime.bufferedChunk(result, generationId)
      return
    }

    for await (const event of parseSSE(
      response,
      runtime.signal ? { signal: runtime.signal } : {},
    )) {
      if (event.kind === 'done') {
        const chunk = runtime.doneChunk?.()
        if (chunk !== undefined) yield chunk
        continue
      }
      if (event.kind === 'keepalive') {
        yield runtime.keepaliveChunk(event.comment)
        continue
      }
      if (debugTrace) {
        logStreamDebug(debugTrace, 'frame-raw', { event: event.event, data: event.data })
      }
      const decoded = decodeProviderStreamFrame({
        adapter: runtime.adapter,
        eventType: event.event,
        data: event.data,
        validate: runtime.validateFrame,
      })
      if (!decoded.ok) {
        if (debugTrace) logStreamDebug(debugTrace, 'frame-invalid', decoded.diagnostic)
        yield runtime.integrityChunk(decoded.integrity)
        continue
      }
      if (debugTrace) logStreamDebug(debugTrace, 'frame', decoded.value)
      yield runtime.frameChunk(decoded.value, generationId)
    }
    if (debugTrace) logStreamDebug(debugTrace, 'terminal', { evidence: 'stream-end' })
  } catch (error) {
    if (debugTrace) logStreamDebugError(debugTrace, error)
    throw error
  }
}

export async function consumeProviderOnce<Result>(
  dispatched: Promise<ProviderDispatchResult>,
  validate: ProviderJsonValidator<Result>,
): Promise<Result> {
  const { response, debugTrace } = await dispatched
  try {
    const result = await decodeValidatedProviderJson(response, validate)
    logBufferedTerminal(debugTrace, result)
    return result
  } catch (error) {
    if (debugTrace) logStreamDebugError(debugTrace, error)
    throw error
  }
}

function logBufferedTerminal(debugTrace: StreamDebugTrace | null, value: unknown): void {
  if (!debugTrace) return
  logStreamDebug(debugTrace, 'buffered-result', value)
  logStreamDebug(debugTrace, 'terminal', { evidence: 'buffered-result' })
}

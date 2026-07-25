import { generatedVideoJobSnapshot } from '../core/generated-output-localization'
import type { ConnectionProfile } from '../core/types'
import {
  logStreamDebug,
  logStreamDebugError,
  logStreamDebugRequestAttempt,
  type StreamDebugTrace,
} from '../lib/debug-streams'
import {
  type ApiKeyDispatchContext,
  buildHeaders,
  dispatchProviderJsonRequest,
  fetchWithTimeout,
  type ProviderDispatchResult,
  readErrorResponseJson,
} from './client'
import { deferAdapterRequest } from './deferred-request'
import { normalizeError } from './errors'
import { decodeProviderJson } from './sse'
import type { CallOpts, ChatCompletionUsageWire, ChatStreamChunk } from './types'

interface VideoGenerationContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
}

interface VideoGenerationRequestWire {
  model: string
  prompt: string
  [extra: string]: unknown
}

interface VideoGenerationJobWire {
  id?: string
  generation_id?: string
  polling_url?: string
  status?: string
  unsigned_urls?: unknown[]
  urls?: unknown[]
  output?: unknown
  data?: unknown
  usage?: { cost?: unknown; [extra: string]: unknown }
  error?: unknown
  [extra: string]: unknown
}

interface VideoOutputMetadata {
  model: string
  prompt: string
}

interface VideoPollContext {
  profile: ConnectionProfile
  debugTrace: StreamDebugTrace | null
  overrideHeaders?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

interface PostedVideoGeneration {
  job: VideoGenerationJobWire
  apiKey: string
  debugTrace: StreamDebugTrace | null
}

const POLL_INTERVAL_MS = 10_000
function videoGenerationUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  return `${base}/videos`
}

async function readJsonResponse(response: Response): Promise<unknown> {
  return readErrorResponseJson(response)
}

function postVideoGeneration(
  ctx: VideoGenerationContext,
  req: VideoGenerationRequestWire,
  opts: CallOpts,
): Promise<PostedVideoGeneration> {
  return finishVideoPost(
    dispatchProviderJsonRequest({
      adapter: 'video-generation',
      context: ctx,
      url: videoGenerationUrl(ctx.profile),
      request: req,
      opts,
      authHeaderName: 'Authorization',
    }),
  )
}

async function finishVideoPost(
  dispatched: Promise<ProviderDispatchResult>,
): Promise<PostedVideoGeneration> {
  const { response, selectedApiKey, debugTrace } = await dispatched
  try {
    const job = await decodeProviderJson<VideoGenerationJobWire>(response)
    if (debugTrace) {
      logStreamDebug(debugTrace, 'frame', () => ({
        phase: 'dispatch',
        status: generatedVideoJobSnapshot(job).status,
      }))
    }
    return { job, apiKey: selectedApiKey, debugTrace }
  } catch (error) {
    if (debugTrace) logStreamDebugError(debugTrace, error, { phase: 'dispatch' })
    throw error
  }
}

async function getVideoGeneration(
  ctx: VideoPollContext,
  pollingUrl: string,
  apiKey: string,
  attemptIndex: number,
): Promise<VideoGenerationJobWire> {
  const headers = buildHeaders(ctx.profile, apiKey, {
    method: 'GET',
    ...(ctx.overrideHeaders ? { overrideHeaders: ctx.overrideHeaders } : {}),
  })
  if (ctx.debugTrace) {
    logStreamDebugRequestAttempt(ctx.debugTrace, {
      url: pollingUrl,
      headers,
      attemptIndex,
      phase: 'poll',
    })
  }
  let errorLogged = false
  try {
    const response = await fetchWithTimeout(
      pollingUrl,
      { method: 'GET', headers },
      {
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...(ctx.timeoutMs !== undefined ? { timeoutMs: ctx.timeoutMs } : {}),
      },
    )
    if (ctx.debugTrace) {
      logStreamDebug(ctx.debugTrace, 'response-head', {
        phase: 'poll',
        attemptIndex,
        status: response.status,
        contentType: response.headers.get('content-type'),
      })
    }
    if (!response.ok) {
      const errorBody = await readJsonResponse(response)
      if (ctx.debugTrace) {
        logStreamDebug(ctx.debugTrace, 'error', {
          phase: 'poll',
          attemptIndex,
          status: response.status,
          body: errorBody,
        })
        errorLogged = true
      }
      throw normalizeError(errorBody, {
        midStream: false,
        httpStatus: response.status,
      })
    }
    const job = await decodeProviderJson<VideoGenerationJobWire>(response)
    if (ctx.debugTrace) {
      logStreamDebug(ctx.debugTrace, 'poll', () => ({
        attemptIndex,
        status: generatedVideoJobSnapshot(job).status,
      }))
    }
    return job
  } catch (error) {
    if (ctx.debugTrace && !errorLogged) {
      logStreamDebugError(ctx.debugTrace, error, { phase: 'poll', attemptIndex })
    }
    throw error
  }
}

export function videoGeneration(
  ctx: VideoGenerationContext,
  req: VideoGenerationRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) => {
    const metadata: VideoOutputMetadata = { model: request.model, prompt: request.prompt }
    return consumeVideoGeneration(postVideoGeneration(ctx, request, opts), metadata, {
      profile: ctx.profile,
      debugTrace: null,
      ...(opts.overrideHeaders ? { overrideHeaders: opts.overrideHeaders } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
  })
}

async function* consumeVideoGeneration(
  postedRequest: Promise<PostedVideoGeneration>,
  metadata: VideoOutputMetadata,
  pollContext: VideoPollContext,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  const posted = await postedRequest
  pollContext.debugTrace = posted.debugTrace
  let job = posted.job
  const pollingUrl = typeof job.polling_url === 'string' ? job.polling_url : undefined
  if (!pollingUrl) {
    logVideoTerminal(posted.debugTrace, 'missing-poll-url')
    yield failedChunk(job, metadata.model, 'Video generation did not return a polling URL.')
    return
  }

  let pollAttemptIndex = 0
  for (;;) {
    const snapshot = generatedVideoJobSnapshot(job)
    yield { type: 'keepalive', comment: `video:${snapshot.status}` }
    if (snapshot.status === 'completed') {
      logVideoTerminal(posted.debugTrace, snapshot.urls.length > 0 ? 'completed' : 'missing-output')
      yield completedChunk(job, metadata)
      return
    }
    if (snapshot.failureMessage) {
      logVideoTerminal(posted.debugTrace, 'provider-failure')
      yield failedChunk(job, metadata.model, snapshot.failureMessage)
      return
    }
    await delay(POLL_INTERVAL_MS, pollContext.signal)
    pollAttemptIndex += 1
    job = await getVideoGeneration(pollContext, pollingUrl, posted.apiKey, pollAttemptIndex)
  }
}

function logVideoTerminal(trace: StreamDebugTrace | null, outcome: string): void {
  if (trace) logStreamDebug(trace, 'terminal', { outcome })
}

function completedChunk(
  job: VideoGenerationJobWire,
  request: VideoOutputMetadata,
): ChatStreamChunk {
  const urls = generatedVideoJobSnapshot(job).urls
  if (urls.length === 0) {
    return failedChunk(job, request.model, 'Video generation completed without a content URL.')
  }
  const generationId = job.generation_id ?? job.id
  return {
    type: 'delta',
    chunk: {
      ...(typeof generationId === 'string' ? { id: generationId } : {}),
      model: request.model,
      choices: [
        {
          index: 0,
          delta: { videos: urls.map((url) => ({ url, prompt: request.prompt })) },
          finish_reason: 'stop',
        },
      ],
      ...(job.usage ? { usage: normalizeVideoUsage(job.usage) } : {}),
    },
    ...(typeof generationId === 'string' ? { generationId } : {}),
  }
}

function failedChunk(job: VideoGenerationJobWire, model: string, message: string): ChatStreamChunk {
  const generationId = job.generation_id ?? job.id
  return {
    type: 'delta',
    chunk: {
      ...(typeof generationId === 'string' ? { id: generationId } : {}),
      model,
      error: { code: 'video_generation_failed', message },
    },
    ...(typeof generationId === 'string' ? { generationId } : {}),
  }
}

function normalizeVideoUsage(usage: VideoGenerationJobWire['usage']): ChatCompletionUsageWire {
  const out: ChatCompletionUsageWire = {}
  if (typeof usage?.cost === 'number') out.cost = usage.cost
  return out
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(normalizeError(undefined, { midStream: true, cause: 'abort' }))
      return
    }
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(normalizeError(undefined, { midStream: true, cause: 'abort' }))
    }
    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

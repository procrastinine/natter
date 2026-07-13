import type { ConnectionProfile } from '../core/types'
import {
  type ApiKeyDispatchContext,
  buildHeaders,
  fetchWithApiKeyFallback,
  fetchWithTimeout,
  hasExplicitAuthHeaderOverride,
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
  signal?: AbortSignal
  timeoutMs?: number
}

const POLL_INTERVAL_MS = 10_000
const VIDEO_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  failed: 'Video generation failed.',
  cancelled: 'Video generation was cancelled.',
  canceled: 'Video generation was canceled.',
  expired: 'Video generation expired.',
}

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
): Promise<{ job: VideoGenerationJobWire; apiKey: string }> {
  return postVideoGenerationSerialized(ctx, JSON.stringify(req), opts)
}

function postVideoGenerationSerialized(
  ctx: VideoGenerationContext,
  body: string,
  opts: CallOpts,
): Promise<{ job: VideoGenerationJobWire; apiKey: string }> {
  const url = videoGenerationUrl(ctx.profile)
  const authCtx = hasExplicitAuthHeaderOverride(ctx.profile, undefined, 'Authorization')
    ? { apiKey: ctx.apiKey }
    : ctx
  const fetched = fetchWithApiKeyFallback(
    authCtx,
    (candidateApiKey) => {
      const headers = buildHeaders(ctx.profile, candidateApiKey, { method: 'POST' })
      return { url, init: { method: 'POST', headers, body } }
    },
    {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  )
  return finishVideoPost(fetched)
}

async function finishVideoPost(
  fetched: ReturnType<typeof fetchWithApiKeyFallback>,
): Promise<{ job: VideoGenerationJobWire; apiKey: string }> {
  const { response, apiKey } = await fetched
  if (!response.ok) {
    throw normalizeError(await readJsonResponse(response), {
      midStream: false,
      httpStatus: response.status,
    })
  }
  return { job: await decodeProviderJson<VideoGenerationJobWire>(response), apiKey }
}

async function getVideoGeneration(
  ctx: VideoPollContext,
  pollingUrl: string,
  apiKey: string,
  opts: CallOpts,
): Promise<VideoGenerationJobWire> {
  const headers = buildHeaders(ctx.profile, apiKey, { method: 'GET' })
  const response = await fetchWithTimeout(
    pollingUrl,
    { method: 'GET', headers },
    {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    },
  )
  if (!response.ok) {
    throw normalizeError(await readJsonResponse(response), {
      midStream: false,
      httpStatus: response.status,
    })
  }
  return decodeProviderJson<VideoGenerationJobWire>(response)
}

export function videoGeneration(
  ctx: VideoGenerationContext,
  req: VideoGenerationRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) => {
    const metadata: VideoOutputMetadata = { model: request.model, prompt: request.prompt }
    const pollContext: VideoPollContext = {
      profile: ctx.profile,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    }
    return consumeVideoGeneration(postVideoGeneration(ctx, request, opts), metadata, pollContext)
  })
}

async function* consumeVideoGeneration(
  postedRequest: Promise<{ job: VideoGenerationJobWire; apiKey: string }>,
  metadata: VideoOutputMetadata,
  pollContext: VideoPollContext,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  const posted = await postedRequest
  let job = posted.job
  const pollingUrl = typeof job.polling_url === 'string' ? job.polling_url : undefined
  if (!pollingUrl) {
    yield failedChunk(job, metadata.model, 'Video generation did not return a polling URL.')
    return
  }

  for (;;) {
    const status = typeof job.status === 'string' ? job.status : 'pending'
    yield { type: 'keepalive', comment: `video:${status}` }
    if (status === 'completed') {
      yield completedChunk(job, metadata)
      return
    }
    const failureMessage = VIDEO_FAILURE_MESSAGES[status]
    if (failureMessage) {
      yield failedChunk(job, metadata.model, errorMessage(job.error) ?? failureMessage)
      return
    }
    await delay(POLL_INTERVAL_MS, pollContext.signal)
    job = await getVideoGeneration(pollContext, pollingUrl, posted.apiKey, pollContext)
  }
}

function completedChunk(
  job: VideoGenerationJobWire,
  request: VideoOutputMetadata,
): ChatStreamChunk {
  const urls = videoContentUrls(job)
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

function videoContentUrls(job: VideoGenerationJobWire): string[] {
  const out = new Set<string>()
  collectVideoUrls(out, job.unsigned_urls)
  collectVideoUrls(out, job.urls)
  collectVideoUrls(out, job.output)
  collectVideoUrls(out, job.data)
  return [...out].filter((url) => !isVideoPollingUrl(url))
}

function collectVideoUrls(out: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectVideoUrls(out, item)
    return
  }
  if (!value || typeof value !== 'object') return
  const record = value as {
    url?: unknown
    content_url?: unknown
    video_url?: unknown
    unsigned_url?: unknown
    unsigned_urls?: unknown
  }
  collectVideoUrls(out, record.url)
  collectVideoUrls(out, record.content_url)
  collectVideoUrls(out, record.video_url)
  collectVideoUrls(out, record.unsigned_url)
  collectVideoUrls(out, record.unsigned_urls)
}

function isVideoPollingUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return /\/videos\/[^/]+\/?$/u.test(url.pathname)
  } catch {
    return false
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

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return undefined
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

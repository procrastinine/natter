import type { ConnectionProfile } from '../core/types'
import { buildHeaders, fetchWithTimeout } from './client'
import { normalizeError } from './errors'
import type { CallOpts, ChatCompletionUsageWire, ChatStreamChunk } from './types'

interface VideoGenerationContext {
  profile: ConnectionProfile
  apiKey: string
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

const POLL_INTERVAL_MS = 10_000

function videoGenerationUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  return `${base}/videos`
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({
    error: { code: response.status, message: response.statusText },
  }))
}

async function postVideoGeneration(
  ctx: VideoGenerationContext,
  req: VideoGenerationRequestWire,
  opts: CallOpts,
): Promise<VideoGenerationJobWire> {
  const url = videoGenerationUrl(ctx.profile)
  const headers = buildHeaders(ctx.profile, ctx.apiKey, { method: 'POST' })
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    },
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
  return (await response.json()) as VideoGenerationJobWire
}

async function getVideoGeneration(
  ctx: VideoGenerationContext,
  pollingUrl: string,
  opts: CallOpts,
): Promise<VideoGenerationJobWire> {
  const headers = buildHeaders(ctx.profile, ctx.apiKey, { method: 'GET' })
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
  return (await response.json()) as VideoGenerationJobWire
}

export async function* videoGeneration(
  ctx: VideoGenerationContext,
  req: VideoGenerationRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk> {
  let job = await postVideoGeneration(ctx, req, opts)
  const pollingUrl = typeof job.polling_url === 'string' ? job.polling_url : undefined
  if (!pollingUrl) {
    yield failedChunk(job, req.model, 'Video generation did not return a polling URL.')
    return
  }

  while (true) {
    const status = typeof job.status === 'string' ? job.status : 'pending'
    yield { type: 'keepalive', comment: `video:${status}` }
    if (status === 'completed') {
      yield completedChunk(job, req)
      return
    }
    if (status === 'failed') {
      yield failedChunk(job, req.model, errorMessage(job.error) ?? 'Video generation failed.')
      return
    }
    await delay(POLL_INTERVAL_MS, opts.signal)
    job = await getVideoGeneration(ctx, pollingUrl, opts)
  }
}

function completedChunk(
  job: VideoGenerationJobWire,
  req: VideoGenerationRequestWire,
): ChatStreamChunk {
  const urls = videoContentUrls(job)
  if (urls.length === 0) {
    return failedChunk(job, req.model, 'Video generation completed without a content URL.')
  }
  const generationId = job.generation_id ?? job.id
  return {
    type: 'delta',
    chunk: {
      ...(typeof generationId === 'string' ? { id: generationId } : {}),
      model: req.model,
      choices: [
        {
          index: 0,
          delta: { videos: urls.map((url) => ({ url, prompt: req.prompt })) },
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
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(done, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

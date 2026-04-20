// Text-completions adapter (OpenAI-compatible `/v1/completions`).
//
// Used for llama-server's protocol='text' path. We prerender the branch
// to a single `prompt` string (see `core/text-templates.ts`), POST it to
// `/v1/completions`, and translate the streaming response into
// `ChatStreamChunk` so the rest of the pipeline (reducer, UI, error
// handling) stays identical to the chat-completions path.
//
// Response shape per OpenAI completion spec:
//   data: { id, choices: [{ text: "...", finish_reason: null | "stop", index: 0 }] }
// We lift `choices[i].text` into `choices[i].delta.content` so downstream
// reducers can keep their one shape.

import type { ConnectionProfile } from '../core/types'
import { buildHeaders, fetchWithTimeout } from './client'
import { normalizeError } from './errors'
import { parseSSE } from './sse'
import type {
  CallOpts,
  ChatCompletionChunkWire,
  ChatCompletionResultWire,
  ChatStreamChunk,
} from './types'

export interface TextCompletionsContext {
  profile: ConnectionProfile
  apiKey: string
}

export interface TextCompletionRequestWire {
  model: string
  prompt: string
  stream?: boolean
  [extra: string]: unknown
}

function textCompletionsUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  return `${base}/completions`
}

async function dispatch(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts,
): Promise<Response> {
  const url = textCompletionsUrl(ctx.profile)
  const headers = buildHeaders(ctx.profile, ctx.apiKey, {
    method: 'POST',
    ...(opts.overrideHeaders ? { overrideHeaders: opts.overrideHeaders } : {}),
  })
  const init: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  }
  const fetchOpts: { signal?: AbortSignal; timeoutMs?: number } = {}
  if (opts.signal) fetchOpts.signal = opts.signal
  if (opts.timeoutMs !== undefined) fetchOpts.timeoutMs = opts.timeoutMs
  const response = await fetchWithTimeout(url, init, fetchOpts)
  if (!response.ok) {
    const body = await response.json().catch(() => ({
      error: { code: response.status, message: response.statusText },
    }))
    throw normalizeError(body, { midStream: false, httpStatus: response.status })
  }
  return response
}

interface TextCompletionChoiceWire {
  index?: number
  text?: string
  finish_reason?: string | null
  [extra: string]: unknown
}

interface TextCompletionChunkWire {
  id?: string
  model?: string
  choices?: TextCompletionChoiceWire[]
  usage?: unknown
  [extra: string]: unknown
}

function liftTextToDelta(chunk: TextCompletionChunkWire): ChatCompletionChunkWire {
  const liftedChoices = (chunk.choices ?? []).map((c) => {
    const base: Record<string, unknown> = { index: c.index ?? 0 }
    if (typeof c.text === 'string') base.delta = { content: c.text }
    if (c.finish_reason !== undefined && c.finish_reason !== null) {
      base.finish_reason = c.finish_reason
    }
    return base
  })
  const { usage: _usage, choices: _choices, ...rest } = chunk
  return { ...rest, choices: liftedChoices } as ChatCompletionChunkWire
}

function liftBufferedToChat(result: TextCompletionChunkWire): ChatCompletionResultWire {
  const liftedChoices = (result.choices ?? []).map((c) => {
    const base: Record<string, unknown> = { index: c.index ?? 0 }
    if (typeof c.text === 'string') base.message = { role: 'assistant', content: c.text }
    if (c.finish_reason !== undefined && c.finish_reason !== null) {
      base.finish_reason = c.finish_reason
    }
    return base
  })
  return { ...result, choices: liftedChoices } as ChatCompletionResultWire
}

export async function* textCompletions(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk> {
  if (req.stream !== true) {
    throw new Error(
      'textCompletions: request body must have stream:true — use textCompletionsOnce for non-streaming',
    )
  }
  const response = await dispatch(ctx, req, opts)
  const generationId = response.headers.get('x-generation-id') ?? undefined
  const contentType = response.headers.get('content-type') ?? ''

  if (!/text\/event-stream/i.test(contentType)) {
    const body = (await response.json()) as TextCompletionChunkWire
    const lifted = liftBufferedToChat(body)
    const chunk: ChatStreamChunk = generationId
      ? { type: 'buffered_result', result: lifted, generationId }
      : { type: 'buffered_result', result: lifted }
    yield chunk
    return
  }

  for await (const ev of parseSSE(response, opts.signal ? { signal: opts.signal } : {})) {
    if (ev.kind === 'keepalive') {
      yield { type: 'keepalive', comment: ev.comment }
      continue
    }
    try {
      const parsed = JSON.parse(ev.data) as TextCompletionChunkWire
      if (generationId && parsed.id === undefined) parsed.id = generationId
      const lifted = liftTextToDelta(parsed)
      const chunk: ChatStreamChunk = generationId
        ? { type: 'delta', chunk: lifted, generationId }
        : { type: 'delta', chunk: lifted }
      yield chunk
    } catch (err) {
      console.warn('textCompletions: malformed SSE chunk skipped', {
        data: ev.data,
        error: err,
      })
    }
  }
}

export async function textCompletionsOnce(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts = {},
): Promise<ChatCompletionResultWire> {
  const body: TextCompletionRequestWire = { ...req, stream: false }
  const response = await dispatch(ctx, body, opts)
  const result = (await response.json()) as TextCompletionChunkWire
  return liftBufferedToChat(result)
}

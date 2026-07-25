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
import { errorFromUnknown } from '../lib/error'
import {
  type ApiKeyDispatchContext,
  dispatchProviderJsonRequest,
  type ProviderDispatchResult,
} from './client'
import { deferAdapterRequest } from './deferred-request'
import { validateTextCompletionPayload } from './provider-json-boundary'
import { consumeProviderOnce, consumeProviderStream } from './provider-stream-runtime'
import type {
  CallOpts,
  ChatCompletionChunkWire,
  ChatCompletionResultWire,
  ChatCompletionUsageWire,
  ChatStreamChunk,
} from './types'

interface TextCompletionsContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
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

function dispatch(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts,
): Promise<ProviderDispatchResult> {
  return dispatchProviderJsonRequest({
    adapter: 'text-completions',
    context: ctx,
    url: textCompletionsUrl(ctx.profile),
    request: req,
    opts,
    authHeaderName: 'Authorization',
  })
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
  usage?: ChatCompletionUsageWire
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
  const { choices: _choices, ...rest } = chunk
  return { ...rest, choices: liftedChoices }
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
  return { ...result, choices: liftedChoices }
}

export function textCompletions(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) => {
    if (request.stream !== true) {
      throw new Error(
        'textCompletions: request body must have stream:true — use textCompletionsOnce for non-streaming',
      )
    }
    return consumeTextCompletions(dispatch(ctx, request, opts), opts.signal)
  })
}

function consumeTextCompletions(
  dispatched: Promise<ProviderDispatchResult>,
  signal: AbortSignal | undefined,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  return consumeProviderStream<TextCompletionChunkWire, TextCompletionChunkWire, ChatStreamChunk>({
    adapter: 'text-completions',
    dispatched,
    ...(signal ? { signal } : {}),
    generationId: (response) => response.headers.get('x-generation-id') ?? undefined,
    validateBuffered: validateTextCompletionPayload,
    validateFrame: validateTextCompletionPayload,
    bufferedChunk: (result, generationId) => {
      const lifted = liftBufferedToChat(result)
      return generationId
        ? { type: 'buffered_result', result: lifted, generationId }
        : { type: 'buffered_result', result: lifted }
    },
    frameChunk: (parsed, generationId) => {
      if (generationId && parsed.id === undefined) parsed.id = generationId
      const lifted = liftTextToDelta(parsed)
      return generationId
        ? { type: 'delta', chunk: lifted, generationId }
        : { type: 'delta', chunk: lifted }
    },
    integrityChunk: (integrity) => ({ type: 'integrity', integrity }),
    keepaliveChunk: (comment) => ({ type: 'keepalive', comment }),
    doneChunk: () => ({ type: 'transport_terminal', evidence: 'done-sentinel' }),
  })
}

export function textCompletionsOnce(
  ctx: TextCompletionsContext,
  req: TextCompletionRequestWire,
  opts: CallOpts = {},
): Promise<ChatCompletionResultWire> {
  try {
    const body: TextCompletionRequestWire = { ...req, stream: false }
    return consumeTextCompletionsOnce(dispatch(ctx, body, opts))
  } catch (error) {
    return Promise.reject(errorFromUnknown(error))
  }
}

async function consumeTextCompletionsOnce(
  dispatched: Promise<ProviderDispatchResult>,
): Promise<ChatCompletionResultWire> {
  return consumeProviderOnce(dispatched, validateTextCompletionPayload).then(liftBufferedToChat)
}

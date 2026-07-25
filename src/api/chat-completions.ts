// Two entry points:
//
// - `chatCompletions()` is the streaming path. It yields `ChatStreamChunk`s —
//   one per SSE data event, plus `keepalive` for `: ...` comments, plus a
//   synthetic `buffered_result` when the upstream answers with JSON despite
//   `stream: true`. Malformed JSON in a data line is skipped and
//   logged, not fatal — streams should be resilient to single-chunk corruption.
// - `chatCompletionsOnce()` is the non-streaming path. It forces `stream: false`
//   and returns a single `ChatCompletionResultWire`.
//
// Headers are bound at dispatch time: changing the profile or key in another
// tab cannot mutate a request already in flight.

import type { ConnectionProfile } from '../core/types'
import { errorFromUnknown } from '../lib/error'
import {
  type ApiKeyDispatchContext,
  dispatchProviderJsonRequest,
  type ProviderDispatchResult,
} from './client'
import { deferAdapterRequest } from './deferred-request'
import { validateChatCompletionChunk, validateChatCompletionResult } from './provider-json-boundary'
import { consumeProviderOnce, consumeProviderStream } from './provider-stream-runtime'
import type {
  CallOpts,
  ChatCompletionChunkWire,
  ChatCompletionRequestWire,
  ChatCompletionResultWire,
  ChatStreamChunk,
} from './types'

export interface ChatCompletionsContext extends ApiKeyDispatchContext {
  profile: ConnectionProfile
}

function chatCompletionsUrl(profile: ConnectionProfile): string {
  const base = normalizedBaseUrl(profile)
  return `${base}/chat/completions`
}

function normalizedBaseUrl(profile: ConnectionProfile): string {
  const base = profile.baseUrl.replace(/\/+$/, '')
  if (profile.kind === 'google' && !/\/openai$/i.test(base)) {
    return `${base}/openai`
  }
  return base
}

function dispatch(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
  opts: CallOpts,
): Promise<ProviderDispatchResult> {
  return dispatchProviderJsonRequest({
    adapter: 'chat-completions',
    context: ctx,
    url: chatCompletionsUrl(ctx.profile),
    request: req,
    opts,
    authHeaderName: 'Authorization',
  })
}

export function chatCompletions(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
  opts: CallOpts = {},
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  return deferAdapterRequest(req, (request) => {
    if (request.stream !== true) {
      throw new Error(
        'chatCompletions: request body must have stream:true — use chatCompletionsOnce for non-streaming',
      )
    }
    return consumeChatCompletions(dispatch(ctx, request, opts), opts.signal)
  })
}

function consumeChatCompletions(
  dispatched: Promise<ProviderDispatchResult>,
  signal: AbortSignal | undefined,
): AsyncGenerator<ChatStreamChunk, void, unknown> {
  return consumeProviderStream<ChatCompletionChunkWire, ChatCompletionResultWire, ChatStreamChunk>({
    adapter: 'chat-completions',
    dispatched,
    ...(signal ? { signal } : {}),
    generationId: (response) => response.headers.get('x-generation-id') ?? undefined,
    validateBuffered: validateChatCompletionResult,
    validateFrame: validateChatCompletionChunk,
    bufferedChunk: (result, generationId) =>
      generationId
        ? { type: 'buffered_result', result, generationId }
        : { type: 'buffered_result', result },
    frameChunk: (parsed, generationId) => {
      if (generationId && parsed.id === undefined) parsed.id = generationId
      return generationId
        ? { type: 'delta', chunk: parsed, generationId }
        : { type: 'delta', chunk: parsed }
    },
    integrityChunk: (integrity) => ({ type: 'integrity', integrity }),
    keepaliveChunk: (comment) => ({ type: 'keepalive', comment }),
    doneChunk: () => ({ type: 'transport_terminal', evidence: 'done-sentinel' }),
  })
}

export function chatCompletionsOnce(
  ctx: ChatCompletionsContext,
  req: ChatCompletionRequestWire,
  opts: CallOpts = {},
): Promise<ChatCompletionResultWire> {
  try {
    const body: ChatCompletionRequestWire = { ...req, stream: false }
    return consumeChatCompletionsOnce(dispatch(ctx, body, opts))
  } catch (error) {
    return Promise.reject(errorFromUnknown(error))
  }
}

async function consumeChatCompletionsOnce(
  dispatched: Promise<ProviderDispatchResult>,
): Promise<ChatCompletionResultWire> {
  return consumeProviderOnce(dispatched, validateChatCompletionResult)
}

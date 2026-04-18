// Wire + internal types for the transport layer. See `plan/04-api-client.md §4.1 and §4.3`.
//
// Wire types mirror the JSON shape on `api.openai.com`-style endpoints (snake_case).
// Internal `ChatStreamChunk` is the tagged union yielded by `chatCompletions()` — it
// lets one consumer handle three outcomes: a normal SSE delta, a keepalive comment
// (used for hang detection per §6.11), and a synthetic `buffered_result` when the
// upstream answers with JSON despite `stream: true`.

export interface CallOpts {
  signal?: AbortSignal
  overrideHeaders?: Record<string, string>
  // GET-only retry policy. POSTs ignore this (see §4.10). API-key fallback is
  // handled separately via `apiKeyFallbackRefs` on the profile.
  retry?: { attempts: number; backoffMs: number }
  // Time allowed to establish the HTTP response headers. Once the response head
  // arrives, stream reads are not bounded by this — long generations are fine.
  // Default 120_000 (2 minutes) per §4.2.
  timeoutMs?: number
}

// ---------------------------------------------------------------------------
// Chat completions — wire shapes
// ---------------------------------------------------------------------------

export interface ChatCompletionRequestWire {
  model: string
  messages: unknown[]
  stream?: boolean
  [extra: string]: unknown
}

export interface ChatCompletionDeltaWire {
  role?: string
  content?: string | null
  reasoning?: string | null
  reasoning_details?: unknown[]
  tool_calls?: unknown[]
  [extra: string]: unknown
}

export interface ChatCompletionMessageWire {
  role?: string
  content?: string | null
  reasoning?: string | null
  reasoning_details?: unknown[]
  tool_calls?: unknown[]
  [extra: string]: unknown
}

export interface ChatCompletionChoiceWire {
  index?: number
  finish_reason?: string | null
  delta?: ChatCompletionDeltaWire
  message?: ChatCompletionMessageWire
  [extra: string]: unknown
}

export interface ChatCompletionUsageWire {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
  [extra: string]: unknown
}

export interface ChatCompletionErrorWire {
  code: number | string
  message: string
  metadata?: Record<string, unknown>
}

export interface ChatCompletionChunkWire {
  id?: string
  model?: string
  provider?: string
  choices?: ChatCompletionChoiceWire[]
  usage?: ChatCompletionUsageWire
  error?: ChatCompletionErrorWire
  [extra: string]: unknown
}

export interface ChatCompletionResultWire {
  id?: string
  model?: string
  provider?: string
  choices?: ChatCompletionChoiceWire[]
  usage?: ChatCompletionUsageWire
  error?: ChatCompletionErrorWire
  [extra: string]: unknown
}

// ---------------------------------------------------------------------------
// Internal stream chunk shape — what `chatCompletions()` yields
// ---------------------------------------------------------------------------

export type ChatStreamChunk =
  | { type: 'delta'; chunk: ChatCompletionChunkWire; generationId?: string }
  | { type: 'keepalive'; comment: string }
  | {
      type: 'buffered_result'
      result: ChatCompletionResultWire
      generationId?: string
    }

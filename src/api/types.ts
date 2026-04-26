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
  audio?: unknown
  images?: unknown[]
  videos?: unknown[]
  reasoning?: string | null
  reasoning_details?: unknown[]
  tool_calls?: unknown[]
  [extra: string]: unknown
}

export interface ChatCompletionMessageWire {
  role?: string
  content?: string | null
  audio?: unknown
  images?: unknown[]
  videos?: unknown[]
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

// ---------------------------------------------------------------------------
// Responses API — wire shapes (OpenAI direct + OpenRouter beta). See
// `plan/phase11-implementation.md §4.1`.
// ---------------------------------------------------------------------------

export interface ResponsesRequestWire {
  model: string
  // Either a plain string prompt (rare) or the canonical input-items array.
  input: string | ResponsesInputItem[]
  instructions?: string
  stream?: boolean
  max_output_tokens?: number
  reasoning?: {
    effort?: string
    summary?: string
    exclude?: boolean
    enabled?: boolean
  }
  text?: {
    verbosity?: string
    format?: { type: string; [extra: string]: unknown }
  }
  tools?: unknown[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  include?: string[]
  // OpenAI default: `true`. Our default: `false` (stateless, privacy posture).
  store?: boolean
  // Reserved — we don't use server-side stateful mode today.
  previous_response_id?: string
  // These three are gated by the GPT-5.4 sampling gate (only valid when
  // `reasoning.effort === 'none'`). Quirks strip them otherwise.
  temperature?: number
  top_p?: number
  logprobs?: number
  [extra: string]: unknown
}

export interface ResponsesInputItem {
  // 'message' | 'reasoning' | 'function_call' | 'function_call_output' |
  // 'web_search_call' | 'file_search_call' | 'image_generation_call' |
  // 'code_interpreter_call' | 'computer_call' | 'mcp_tool_call' | …
  type: string
  id?: string
  role?: string
  status?: string
  content?: unknown[]
  phase?: 'commentary' | 'final_answer' | null
  encrypted_content?: string
  summary?: Array<{ type: 'summary_text'; text: string }>
  // function_call / function_call_output
  call_id?: string
  name?: string
  arguments?: string
  output?: string
  // Free-form forward-compat: let unknown item types round-trip without loss.
  [extra: string]: unknown
}

export interface ResponsesUsageWire {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number; [extra: string]: unknown }
  output_tokens?: number
  output_tokens_details?: {
    reasoning_tokens?: number
    [extra: string]: unknown
  }
  total_tokens?: number
  // OpenRouter-only.
  cost?: number
  cost_details?: Record<string, unknown>
  [extra: string]: unknown
}

export interface ResponsesResultWire {
  id?: string
  object?: string
  status?: 'in_progress' | 'completed' | 'incomplete' | 'failed'
  incomplete_details?: { reason?: string }
  model?: string
  created_at?: number
  completed_at?: number
  output?: ResponsesInputItem[]
  usage?: ResponsesUsageWire
  reasoning?: { effort?: string; summary?: string }
  text?: { verbosity?: string; format?: unknown }
  error?: { code?: string | number; message: string }
  [extra: string]: unknown
}

// SSE envelope. We keep the union narrow for the events we care about and
// forward-compat via a catch-all so unknown event names don't crash the
// splitter.
export type ResponsesEventWire =
  | {
      type: 'response.created'
      response: ResponsesResultWire
      sequence_number?: number
    }
  | {
      type: 'response.in_progress'
      response: ResponsesResultWire
      sequence_number?: number
    }
  | {
      type: 'response.output_item.added'
      output_index: number
      item: ResponsesInputItem
      sequence_number?: number
    }
  | {
      type: 'response.output_item.done'
      output_index: number
      item: ResponsesInputItem
      sequence_number?: number
    }
  | {
      type: 'response.content_part.added'
      output_index: number
      content_index: number
      item_id: string
      part: unknown
      sequence_number?: number
    }
  | {
      type: 'response.content_part.done'
      output_index: number
      content_index: number
      item_id: string
      part: unknown
      sequence_number?: number
    }
  | {
      type: 'response.output_text.delta'
      output_index: number
      content_index: number
      item_id: string
      delta: string
      obfuscation?: string
      sequence_number?: number
    }
  | {
      type: 'response.output_text.done'
      output_index: number
      content_index: number
      item_id: string
      text: string
      sequence_number?: number
    }
  | {
      type: 'response.reasoning.delta'
      output_index: number
      item_id: string
      delta: string
      sequence_number?: number
    }
  | {
      type: 'response.reasoning.done'
      output_index: number
      item_id: string
      sequence_number?: number
    }
  | {
      type: 'response.reasoning_summary_part.added'
      output_index: number
      item_id: string
      part: { type: string; text: string }
      summary_index: number
      sequence_number?: number
    }
  | {
      type: 'response.reasoning_summary_part.done'
      output_index: number
      item_id: string
      part: { type: string; text: string }
      summary_index: number
      sequence_number?: number
    }
  | {
      type: 'response.reasoning_summary_text.delta'
      output_index: number
      item_id: string
      delta: string
      obfuscation?: string
      summary_index: number
      sequence_number?: number
    }
  | {
      type: 'response.reasoning_summary_text.done'
      output_index: number
      item_id: string
      text: string
      summary_index: number
      sequence_number?: number
    }
  | {
      type: 'response.function_call_arguments.delta'
      output_index: number
      item_id: string
      delta: string
      sequence_number?: number
    }
  | {
      type: 'response.function_call_arguments.done'
      output_index: number
      item_id: string
      arguments: string
      sequence_number?: number
    }
  | {
      type:
        | 'response.web_search_call.in_progress'
        | 'response.web_search_call.searching'
        | 'response.web_search_call.completed'
        | 'response.file_search_call.in_progress'
        | 'response.file_search_call.searching'
        | 'response.file_search_call.completed'
        | 'response.code_interpreter_call.in_progress'
        | 'response.code_interpreter_call.completed'
      output_index: number
      item_id: string
      sequence_number?: number
    }
  | {
      type: 'response.image_generation_call.partial_image'
      output_index: number
      item_id: string
      partial_image_b64: string
      sequence_number?: number
    }
  | {
      type: 'response.image_generation_call.completed'
      output_index: number
      item_id: string
      sequence_number?: number
    }
  | {
      type: 'response.completed'
      response: ResponsesResultWire
      sequence_number?: number
    }
  | {
      type: 'response.failed'
      response: ResponsesResultWire
      sequence_number?: number
    }
  | {
      type: 'response.error' | 'error'
      error: { code?: string | number; message: string }
      sequence_number?: number
    }
  // Forward-compat: future event names pass through untouched.
  | { type: string; [extra: string]: unknown }

export type ResponsesStreamChunk =
  | {
      type: 'event'
      event: ResponsesEventWire
      generationId?: string
    }
  | { type: 'keepalive'; comment: string }
  | {
      type: 'buffered_result'
      result: ResponsesResultWire
      generationId?: string
    }

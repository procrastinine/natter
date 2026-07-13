// Anthropic Messages API wire shapes. The request/response bodies intentionally
// keep Anthropic's snake_case field names; internal app models remain camelCase.

import type { StreamIntegrityChunk } from './stream-integrity'

export interface AnthropicMessagesRequestWire {
  model: string
  max_tokens: number
  messages: AnthropicMessageWire[]
  system?: string
  stream?: boolean
  tools?: unknown[]
  tool_choice?: unknown
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  thinking?: unknown
  container?: string
  metadata?: unknown
  [extra: string]: unknown
}

export interface AnthropicMessageWire {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export type AnthropicContentBlock = Record<string, unknown> & {
  type: string
}

export interface AnthropicMessagesResultWire {
  id?: string
  type?: string
  role?: string
  model?: string
  content?: AnthropicContentBlock[]
  stop_reason?: string | null
  stop_sequence?: string | null
  usage?: AnthropicUsageWire
  container?: { id?: string; expires_at?: string; [extra: string]: unknown }
  error?: { type?: string; message?: string; [extra: string]: unknown }
  [extra: string]: unknown
}

export interface AnthropicUsageWire {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
    [extra: string]: unknown
  }
  server_tool_use?: Record<string, number>
  service_tier?: string
  [extra: string]: unknown
}

export type AnthropicEventWire =
  | {
      type: 'message_start'
      message: AnthropicMessagesResultWire
    }
  | {
      type: 'content_block_start'
      index: number
      content_block: AnthropicContentBlock
    }
  | {
      type: 'content_block_delta'
      index: number
      delta: AnthropicContentBlock
    }
  | {
      type: 'content_block_stop'
      index: number
    }
  | {
      type: 'message_delta'
      delta?: {
        stop_reason?: string | null
        stop_sequence?: string | null
        [extra: string]: unknown
      }
      usage?: AnthropicUsageWire
    }
  | {
      type: 'message_stop'
    }
  | {
      type: 'ping'
    }
  | {
      type: 'error'
      error: { type?: string; message?: string; [extra: string]: unknown }
    }
  | (Record<string, unknown> & { type: string })

export type AnthropicStreamChunk =
  | {
      type: 'anthropic_event'
      event: AnthropicEventWire
      generationId?: string
    }
  | { type: 'keepalive'; comment: string }
  | StreamIntegrityChunk
  | {
      type: 'buffered_result'
      result: AnthropicMessagesResultWire
      generationId?: string
    }

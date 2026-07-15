import type { AnthropicEventWire, AnthropicMessagesResultWire } from './anthropic-types'
import type { GeminiPart, GenerateContentResponseWire } from './gemini-types'
import type {
  ChatCompletionChunkWire,
  ChatCompletionResultWire,
  ChatCompletionUsageWire,
  ResponsesEventWire,
  ResponsesInputItem,
  ResponsesResultWire,
} from './types'

export type ProviderJsonValidation<T> = { ok: true; value: T } | { ok: false; issue: string }

type JsonRecord = Record<string, unknown>

export function validateChatCompletionChunk(
  value: unknown,
): ProviderJsonValidation<ChatCompletionChunkWire> {
  return validateChatCompletionPayload<ChatCompletionChunkWire>(value)
}

export function validateChatCompletionResult(
  value: unknown,
): ProviderJsonValidation<ChatCompletionResultWire> {
  return validateChatCompletionPayload<ChatCompletionResultWire>(value)
}

export function validateTextCompletionPayload(value: unknown): ProviderJsonValidation<
  JsonRecord & {
    choices?: Array<{
      index?: number
      text?: string
      finish_reason?: string | null
      [extra: string]: unknown
    }>
    usage?: ChatCompletionUsageWire
  }
> {
  if (!isRecord(value)) return invalid('frame-not-object')
  if (!isOptionalString(value.id)) return invalid('id-not-string')
  if (!isOptionalString(value.model)) return invalid('model-not-string')
  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices)) return invalid('choices-not-array')
    for (const choice of value.choices) {
      if (!isRecord(choice)) return invalid('choice-not-object')
      if (!isOptionalNumber(choice.index)) return invalid('choice-index-not-number')
      if (choice.text !== undefined && typeof choice.text !== 'string') {
        return invalid('choice-text-not-string')
      }
      if (!isNullableString(choice.finish_reason)) return invalid('finish-reason-not-string')
    }
  }
  if (!isOptionalUsageRecord(value.usage)) return invalid('usage-not-object')
  if (!isOptionalErrorRecord(value.error)) return invalid('error-invalid')
  return valid(value)
}

export function validateResponsesEvent(
  value: unknown,
  sseEventType?: string,
): ProviderJsonValidation<ResponsesEventWire> {
  if (!isRecord(value)) return invalid('frame-not-object')
  const inlineType = value.type
  if (inlineType !== undefined && typeof inlineType !== 'string') {
    return invalid('event-type-not-string')
  }
  const type = typeof inlineType === 'string' ? inlineType : sseEventType
  if (typeof type !== 'string' || type.length === 0 || type === 'message') {
    return invalid('event-type-missing')
  }
  if (
    typeof inlineType === 'string' &&
    isSpecificSseEventType(sseEventType) &&
    inlineType !== sseEventType
  ) {
    return invalid('event-type-mismatch')
  }
  value.type = type

  switch (type) {
    case 'response.created':
    case 'response.in_progress':
      if (!isRecord(value.response)) return invalid('response-not-object')
      return validateResponsesResultFields(value.response, value as ResponsesEventWire)

    case 'response.output_item.added':
    case 'response.output_item.done':
      if (!isOutputIndex(value.output_index)) return invalid('output-index-invalid')
      if (!isResponsesItem(value.item)) return invalid('output-item-invalid')
      return valid(value as ResponsesEventWire)

    case 'response.output_text.delta':
      return validateResponsesTextDelta(value)

    case 'response.reasoning.delta':
      if (!isOutputIndex(value.output_index)) return invalid('output-index-invalid')
      if (typeof value.item_id !== 'string') return invalid('item-id-not-string')
      if (typeof value.delta !== 'string') return invalid('delta-not-string')
      return valid(value as ResponsesEventWire)

    case 'response.reasoning_summary_text.delta':
      if (!isOutputIndex(value.output_index)) return invalid('output-index-invalid')
      if (!isOutputIndex(value.summary_index)) return invalid('summary-index-invalid')
      if (typeof value.item_id !== 'string') return invalid('item-id-not-string')
      if (typeof value.delta !== 'string') return invalid('delta-not-string')
      return valid(value as ResponsesEventWire)

    case 'response.function_call_arguments.delta':
      if (!isOutputIndex(value.output_index)) return invalid('output-index-invalid')
      if (typeof value.delta !== 'string') return invalid('delta-not-string')
      return valid(value as ResponsesEventWire)

    case 'response.function_call_arguments.done':
      if (!isOutputIndex(value.output_index)) return invalid('output-index-invalid')
      if (typeof value.arguments !== 'string') return invalid('arguments-not-string')
      return valid(value as ResponsesEventWire)

    case 'response.web_search_call.in_progress':
    case 'response.web_search_call.searching':
    case 'response.web_search_call.completed':
    case 'response.file_search_call.in_progress':
    case 'response.file_search_call.searching':
    case 'response.file_search_call.completed':
    case 'response.code_interpreter_call.in_progress':
    case 'response.code_interpreter_call.completed':
    case 'response.shell_call.in_progress':
    case 'response.shell_call.completed':
    case 'response.shell_call_output.completed':
    case 'response.image_generation_call.in_progress':
    case 'response.image_generation_call.completed':
      if (!isOutputIndex(value.output_index)) return invalid('output-index-invalid')
      if (typeof value.item_id !== 'string') return invalid('item-id-not-string')
      return valid(value as ResponsesEventWire)

    case 'response.image_generation_call.partial_image':
      if (!isOutputIndex(value.output_index)) return invalid('output-index-invalid')
      if (typeof value.item_id !== 'string') return invalid('item-id-not-string')
      if (typeof value.partial_image_b64 !== 'string') return invalid('partial-image-not-string')
      return valid(value as ResponsesEventWire)

    case 'response.completed':
      if (!isRecord(value.response)) return invalid('response-not-object')
      return validateResponsesResultFields(value.response, value as ResponsesEventWire)

    case 'response.failed':
      if (!isRecord(value.response)) return invalid('response-not-object')
      return validateResponsesResultFields(value.response, value as ResponsesEventWire)

    case 'response.error':
    case 'error':
      if (!isErrorRecord(value.error)) return invalid('error-invalid')
      return valid(value as ResponsesEventWire)

    default:
      return valid(value as ResponsesEventWire)
  }
}

export function validateResponsesResult(
  value: unknown,
): ProviderJsonValidation<ResponsesResultWire> {
  if (!isRecord(value)) return invalid('response-not-object')
  return validateResponsesResultFields(value, value as ResponsesResultWire)
}

export function validateAnthropicEvent(
  value: unknown,
  sseEventType?: string,
): ProviderJsonValidation<AnthropicEventWire> {
  if (!isRecord(value)) return invalid('frame-not-object')
  const inlineType = value.type
  if (inlineType !== undefined && typeof inlineType !== 'string') {
    return invalid('event-type-not-string')
  }
  const type = typeof inlineType === 'string' ? inlineType : sseEventType
  if (typeof type !== 'string' || type.length === 0 || type === 'message') {
    return invalid('event-type-missing')
  }
  if (
    typeof inlineType === 'string' &&
    isSpecificSseEventType(sseEventType) &&
    inlineType !== sseEventType
  ) {
    return invalid('event-type-mismatch')
  }
  value.type = type

  switch (type) {
    case 'message_start':
      if (!isRecord(value.message)) return invalid('message-not-object')
      {
        const issue = anthropicResultIssue(value.message)
        if (issue) return invalid(issue)
      }
      break
    case 'content_block_start':
      if (!isOutputIndex(value.index)) return invalid('block-index-invalid')
      if (!isAnthropicBlock(value.content_block)) return invalid('content-block-invalid')
      break
    case 'content_block_delta':
      if (!isOutputIndex(value.index)) return invalid('block-index-invalid')
      if (!isAnthropicBlock(value.delta)) return invalid('content-delta-invalid')
      break
    case 'content_block_stop':
      if (!isOutputIndex(value.index)) return invalid('block-index-invalid')
      break
    case 'message_delta':
      if (!isOptionalRecord(value.delta)) return invalid('message-delta-not-object')
      if (isRecord(value.delta)) {
        if (!isNullableString(value.delta.stop_reason)) return invalid('stop-reason-not-string')
        if (!isNullableString(value.delta.stop_sequence)) {
          return invalid('stop-sequence-not-string')
        }
      }
      if (!isOptionalAnthropicUsage(value.usage)) return invalid('usage-not-object')
      break
    case 'error':
      if (!isErrorRecord(value.error)) return invalid('error-invalid')
      break
    default:
      break
  }
  return valid(value as AnthropicEventWire)
}

export function validateAnthropicResult(
  value: unknown,
): ProviderJsonValidation<AnthropicMessagesResultWire> {
  if (!isRecord(value)) return invalid('response-not-object')
  const issue = anthropicResultIssue(value)
  if (issue) return invalid(issue)
  return valid(value as AnthropicMessagesResultWire)
}

export function validateGeminiResponse(
  value: unknown,
): ProviderJsonValidation<GenerateContentResponseWire> {
  if (!isRecord(value)) return invalid('response-not-object')
  if (!isOptionalString(value.modelVersion)) return invalid('model-version-not-string')
  if (!isOptionalString(value.responseId)) return invalid('response-id-not-string')
  if (value.candidates !== undefined) {
    if (!Array.isArray(value.candidates)) return invalid('candidates-not-array')
    for (const candidate of value.candidates) {
      if (!isRecord(candidate)) return invalid('candidate-not-object')
      if (!isOptionalNumber(candidate.index)) return invalid('candidate-index-not-number')
      if (candidate.content !== undefined) {
        if (!isRecord(candidate.content)) return invalid('content-not-object')
        if (!Array.isArray(candidate.content.parts)) return invalid('parts-not-array')
        if (candidate.content.parts.some((part) => !isGeminiPart(part))) {
          return invalid('part-invalid')
        }
      }
      if (candidate.finishReason !== undefined && typeof candidate.finishReason !== 'string') {
        return invalid('finish-reason-not-string')
      }
    }
  }
  if (!isOptionalGeminiUsage(value.usageMetadata)) return invalid('usage-not-object')
  if (!isOptionalErrorRecord(value.error)) return invalid('error-invalid')
  return valid(value as GenerateContentResponseWire)
}

function validateChatCompletionPayload<T extends ChatCompletionChunkWire>(
  value: unknown,
): ProviderJsonValidation<T> {
  if (!isRecord(value)) return invalid('frame-not-object')
  if (!isOptionalString(value.id)) return invalid('id-not-string')
  if (!isOptionalString(value.model)) return invalid('model-not-string')
  if (!isOptionalString(value.provider)) return invalid('provider-not-string')
  if (value.choices !== undefined) {
    if (!Array.isArray(value.choices)) return invalid('choices-not-array')
    for (const choice of value.choices) {
      if (!isRecord(choice)) return invalid('choice-not-object')
      if (!isOptionalNumber(choice.index)) return invalid('choice-index-not-number')
      if (!isOptionalRecord(choice.delta)) return invalid('choice-delta-not-object')
      if (!isOptionalRecord(choice.message)) return invalid('choice-message-not-object')
      if (!isNullableString(choice.finish_reason)) return invalid('finish-reason-not-string')
      if (isRecord(choice.delta)) {
        const issue = chatContentIssue(choice.delta)
        if (issue) return invalid(issue)
      }
      if (isRecord(choice.message)) {
        const issue = chatContentIssue(choice.message)
        if (issue) return invalid(issue)
      }
    }
  }
  if (!isOptionalUsageRecord(value.usage)) return invalid('usage-not-object')
  if (!isOptionalErrorRecord(value.error)) return invalid('error-invalid')
  return valid(value as T)
}

function validateResponsesTextDelta(value: JsonRecord): ProviderJsonValidation<ResponsesEventWire> {
  if (!isOutputIndex(value.output_index)) return invalid('output-index-invalid')
  if (!isOutputIndex(value.content_index)) return invalid('content-index-invalid')
  if (typeof value.delta !== 'string') return invalid('delta-not-string')
  return valid(value as ResponsesEventWire)
}

function validateResponsesResultFields<T>(value: JsonRecord, typed: T): ProviderJsonValidation<T> {
  if (!isOptionalString(value.id)) return invalid('response-id-not-string')
  if (!isOptionalString(value.model)) return invalid('model-not-string')
  if (value.output !== undefined) {
    if (!Array.isArray(value.output)) return invalid('output-not-array')
    if (value.output.some((item) => !isResponsesItem(item))) {
      return invalid('output-item-invalid')
    }
  }
  if (!isOptionalResponsesUsage(value.usage)) return invalid('usage-not-object')
  if (!isOptionalErrorRecord(value.error)) return invalid('error-invalid')
  if (!isOptionalRecord(value.incomplete_details)) return invalid('incomplete-details-not-object')
  if (isRecord(value.incomplete_details) && !isOptionalString(value.incomplete_details.reason)) {
    return invalid('incomplete-reason-not-string')
  }
  if (value.status !== undefined && typeof value.status !== 'string') {
    return invalid('status-not-string')
  }
  return valid(typed)
}

function chatContentIssue(value: JsonRecord): string | null {
  if (!isOptionalString(value.role)) return 'role-not-string'
  if (!isNullableString(value.content)) return 'content-not-string'
  if (!isNullableString(value.reasoning)) return 'reasoning-not-string'
  for (const key of ['reasoning_details', 'images', 'videos'] as const) {
    if (!isOptionalArray(value[key])) return `${key.replaceAll('_', '-')}-not-array`
  }
  if (!isOptionalArray(value.tool_calls)) return 'tool-calls-not-array'
  if (Array.isArray(value.tool_calls) && value.tool_calls.some((item) => !isChatToolCall(item))) {
    return 'tool-call-invalid'
  }
  return null
}

function isChatToolCall(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isOptionalNumber(value.index)) return false
  if (!isOptionalString(value.id)) return false
  if (!isOptionalString(value.type)) return false
  if (!isOptionalRecord(value.function)) return false
  if (isRecord(value.function)) {
    if (!isOptionalString(value.function.name)) return false
    if (!isOptionalString(value.function.arguments)) return false
  }
  return true
}

function anthropicResultIssue(value: JsonRecord): string | null {
  if (!isOptionalString(value.id)) return 'message-id-not-string'
  if (!isOptionalString(value.type)) return 'message-type-not-string'
  if (!isOptionalString(value.role)) return 'message-role-not-string'
  if (!isOptionalString(value.model)) return 'model-not-string'
  if (value.content !== undefined) {
    if (!Array.isArray(value.content)) return 'content-not-array'
    if (value.content.some((block) => !isAnthropicBlock(block))) {
      return 'content-block-invalid'
    }
  }
  if (!isOptionalAnthropicUsage(value.usage)) return 'usage-not-object'
  if (!isOptionalErrorRecord(value.error)) return 'error-invalid'
  if (!isNullableString(value.stop_reason)) return 'stop-reason-not-string'
  if (!isNullableString(value.stop_sequence)) return 'stop-sequence-not-string'
  if (!isOptionalRecord(value.container)) return 'container-not-object'
  return null
}

function isResponsesItem(value: unknown): value is ResponsesInputItem {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'message':
      return (
        isOptionalString(value.id) &&
        isOptionalString(value.role) &&
        isOptionalString(value.status) &&
        isNullableString(value.phase) &&
        isOptionalArray(value.content)
      )
    case 'reasoning':
      return (
        isOptionalString(value.id) &&
        isOptionalString(value.status) &&
        isOptionalString(value.encrypted_content) &&
        isOptionalArray(value.summary)
      )
    case 'function_call':
      return (
        isOptionalString(value.id) &&
        isOptionalString(value.status) &&
        isOptionalString(value.call_id) &&
        isOptionalString(value.name) &&
        isOptionalString(value.arguments)
      )
    default:
      if (!isKnownResponsesServerToolItemType(value.type)) return true
      return isOptionalString(value.id) && isOptionalString(value.status)
  }
}

function isKnownResponsesServerToolItemType(type: string): boolean {
  return (
    type === 'web_search_call' ||
    type === 'file_search_call' ||
    type === 'image_generation_call' ||
    type === 'code_interpreter_call' ||
    type === 'shell_call' ||
    type === 'shell_call_output' ||
    type === 'computer_call' ||
    type === 'mcp_tool_call' ||
    type === 'mcp_call' ||
    type === 'openrouter:datetime' ||
    type === 'openrouter:web_fetch' ||
    type === 'openrouter:web_search' ||
    type === 'server_tool_use' ||
    type === 'web_search_tool_result' ||
    type === 'web_fetch_tool_result' ||
    type === 'code_execution_tool_result' ||
    type === 'bash_code_execution_tool_result' ||
    type === 'text_editor_code_execution_tool_result' ||
    type === 'advisor_tool_result'
  )
}

function isAnthropicBlock(value: unknown): value is JsonRecord & { type: string } {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  switch (value.type) {
    case 'text':
    case 'text_delta':
      return isOptionalString(value.text) && isOptionalArray(value.citations)
    case 'thinking':
    case 'thinking_delta':
      return isOptionalString(value.thinking) && isOptionalString(value.signature)
    case 'signature_delta':
      return isOptionalString(value.signature)
    case 'redacted_thinking':
      return isOptionalString(value.data)
    case 'input_json_delta':
      return isOptionalString(value.partial_json)
    case 'tool_use':
      return (
        isOptionalString(value.id) &&
        isOptionalString(value.name) &&
        isOptionalArray(value.citations)
      )
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'advisor_tool_result':
      return (
        isOptionalString(value.id) &&
        isOptionalString(value.tool_use_id) &&
        isOptionalString(value.name) &&
        isOptionalArray(value.citations)
      )
    default:
      return true
  }
}

function isGeminiPart(value: unknown): value is GeminiPart {
  if (!isRecord(value)) return false
  if (value.text !== undefined && typeof value.text !== 'string') return false
  if (value.thought !== undefined && typeof value.thought !== 'boolean') return false
  if (value.thoughtSignature !== undefined && typeof value.thoughtSignature !== 'string') {
    return false
  }
  if (value.inlineData !== undefined) {
    if (!isRecord(value.inlineData)) return false
    if (typeof value.inlineData.mimeType !== 'string') return false
    if (typeof value.inlineData.data !== 'string') return false
  }
  if (value.fileData !== undefined) {
    if (!isRecord(value.fileData)) return false
    if (typeof value.fileData.mimeType !== 'string') return false
    if (typeof value.fileData.fileUri !== 'string') return false
  }
  if (value.functionCall !== undefined) {
    if (!isRecord(value.functionCall) || typeof value.functionCall.name !== 'string') return false
    if (!isOptionalString(value.functionCall.id)) return false
    if (!isOptionalRecord(value.functionCall.args)) return false
  }
  if (value.functionResponse !== undefined) {
    if (!isRecord(value.functionResponse)) return false
    if (typeof value.functionResponse.name !== 'string') return false
    if (!isRecord(value.functionResponse.response)) return false
    if (!isOptionalString(value.functionResponse.id)) return false
  }
  if (value.executableCode !== undefined) {
    if (!isRecord(value.executableCode)) return false
    if (!isOptionalString(value.executableCode.language)) return false
    if (!isOptionalString(value.executableCode.code)) return false
  }
  if (value.codeExecutionResult !== undefined) {
    if (!isRecord(value.codeExecutionResult)) return false
    if (!isOptionalString(value.codeExecutionResult.outcome)) return false
    if (!isOptionalString(value.codeExecutionResult.output)) return false
  }
  return true
}

function isErrorRecord(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false
  if (
    value.code !== undefined &&
    value.code !== null &&
    typeof value.code !== 'string' &&
    typeof value.code !== 'number'
  ) {
    return false
  }
  if (!isOptionalString(value.message)) return false
  if (!isOptionalString(value.type)) return false
  if (!isOptionalString(value.status)) return false
  if (!isOptionalRecord(value.metadata)) return false
  return true
}

function isOptionalErrorRecord(value: unknown): boolean {
  return value === undefined || value === null || isErrorRecord(value)
}

function isOptionalUsageRecord(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!isRecord(value)) return false
  for (const key of [
    'prompt_tokens_details',
    'completion_tokens_details',
    'cost_details',
    'server_tool_use',
  ] as const) {
    if (!isOptionalRecord(value[key])) return false
  }
  return true
}

function isOptionalResponsesUsage(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!isRecord(value)) return false
  if (!isOptionalRecord(value.input_tokens_details)) return false
  if (!isOptionalRecord(value.output_tokens_details)) return false
  if (!isOptionalRecord(value.cost_details)) return false
  return true
}

function isOptionalAnthropicUsage(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!isRecord(value)) return false
  if (!isOptionalRecord(value.cache_creation)) return false
  if (!isOptionalRecord(value.server_tool_use)) return false
  return true
}

function isOptionalGeminiUsage(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!isRecord(value)) return false
  if (value.promptTokensDetails !== undefined) {
    if (!Array.isArray(value.promptTokensDetails)) return false
    for (const detail of value.promptTokensDetails) {
      if (!isRecord(detail)) return false
      if (typeof detail.modality !== 'string') return false
      if (typeof detail.tokenCount !== 'number') return false
    }
  }
  return true
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function isOptionalArray(value: unknown): boolean {
  return value === undefined || value === null || Array.isArray(value)
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function isOutputIndex(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isSpecificSseEventType(value: string | undefined): value is string {
  return value !== undefined && value !== '' && value !== 'message'
}

function valid<T>(value: T): ProviderJsonValidation<T> {
  return { ok: true, value }
}

function invalid(issue: string): ProviderJsonValidation<never> {
  return { ok: false, issue }
}

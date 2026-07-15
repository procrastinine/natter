import type { ChatId, ContentItem, Message, MessageId } from '../core/types'
import { countMessagesWords } from '../core/word-count'

type MessageBodyKey =
  | 'content'
  | 'reasoningDetails'
  | 'toolCalls'
  | 'refusal'
  | 'phase'
  | 'responsesEchoItem'
  | 'providerOutputItems'
  | 'continuationAttempts'

export type MessageBodyFields = Pick<Message, MessageBodyKey>

interface GenerationServerToolOutput {
  index: number
  output: unknown
}

export type MessageHeaderRow = Omit<Message, MessageBodyKey> & {
  requestContextVersion: number
  bodyVersion: number
  bodyWordCount: number
  textPreview: string
}

export interface MessagePresentation {
  readonly header: MessageHeaderRow
  readonly message: Message
  readonly bodyVersion: number
}

export function messageHeaderTreeKey(headers: readonly MessageHeaderRow[]): string {
  return headers
    .map((message) =>
      [
        message.id,
        message.nodeVersion,
        message.parentId ?? '',
        message.siblingIndex,
        message.createdAt,
        message.deleted ? 1 : 0,
      ].join(':'),
    )
    .join('|')
}

export interface MessageBodyRow extends MessageBodyFields {
  id: MessageId
  chatId: ChatId
  bodyVersion: number
  updatedAt: number
  generationServerToolOutputs?: GenerationServerToolOutput[]
}

export const MESSAGE_BODY_KEYS: readonly MessageBodyKey[] = [
  'content',
  'reasoningDetails',
  'toolCalls',
  'refusal',
  'phase',
  'responsesEchoItem',
  'providerOutputItems',
  'continuationAttempts',
]

const CHAT_PREVIEW_MAX_CHARS = 240
export const MESSAGE_TEXT_PREVIEW_MAX_CHARS = 4_096

const WHITESPACE = /\s/
const SEARCH_TEXT_CHUNK_CHARS = 64 * 1024

export function contentIncludesCaseInsensitiveText(
  content: readonly ContentItem[],
  query: string,
  signal?: AbortSignal,
): boolean {
  const needle = query.toLocaleLowerCase()
  if (needle.length === 0) return false
  const retainedLength = needle.length - 1
  let trailing = ''
  let sawText = false

  const scan = (text: string): boolean => {
    for (let offset = 0; offset < text.length; offset += SEARCH_TEXT_CHUNK_CHARS) {
      if (signal?.aborted) throw new DOMException('Search aborted', 'AbortError')
      const lowered = text.slice(offset, offset + SEARCH_TEXT_CHUNK_CHARS).toLocaleLowerCase()
      if (lowered.includes(needle)) return true
      if (trailing && `${trailing}${lowered.slice(0, retainedLength)}`.includes(needle)) return true
      if (retainedLength > 0) {
        trailing =
          lowered.length >= retainedLength
            ? lowered.slice(-retainedLength)
            : `${trailing}${lowered}`.slice(-retainedLength)
      }
    }
    return false
  }

  for (const item of content) {
    if (item.type !== 'text' && item.type !== 'output_text') continue
    if (sawText && scan('\n')) return true
    sawText = true
    if (scan(item.text)) return true
  }
  return false
}

export function previewTextFromContent(
  content: readonly ContentItem[],
  maxChars = CHAT_PREVIEW_MAX_CHARS,
): string {
  const prefix: string[] = []
  let normalizedLength = 0
  let pendingSpace = false

  for (const item of content) {
    if (item.type !== 'text' && item.type !== 'output_text') continue
    for (let index = 0; index < item.text.length; index += 1) {
      const character = item.text[index] as string
      if (WHITESPACE.test(character)) {
        pendingSpace = normalizedLength > 0
        continue
      }
      if (pendingSpace) {
        normalizedLength += 1
        if (prefix.length < maxChars) prefix.push(' ')
        pendingSpace = false
      }
      normalizedLength += 1
      if (prefix.length < maxChars) prefix.push(character)
      if (normalizedLength > maxChars) {
        return `${prefix.slice(0, maxChars - 1).join('')}…`
      }
    }
  }

  return prefix.join('')
}

export function previewTextFromMessages(
  messages: readonly Pick<Message, 'content' | 'createdAt' | 'deleted' | 'id' | 'role'>[],
): string {
  let earliest: (typeof messages)[number] | undefined
  for (const message of messages) {
    if (message.deleted || message.role !== 'user') continue
    if (
      !earliest ||
      message.createdAt < earliest.createdAt ||
      (message.createdAt === earliest.createdAt && message.id < earliest.id)
    ) {
      earliest = message
    }
  }
  return earliest ? previewTextFromContent(earliest.content) : ''
}

export function previewTextsByChat(
  messages: readonly Pick<
    Message,
    'chatId' | 'content' | 'createdAt' | 'deleted' | 'id' | 'role'
  >[],
): Map<ChatId, string> {
  const earliestByChat = new Map<ChatId, (typeof messages)[number]>()
  for (const message of messages) {
    if (message.deleted || message.role !== 'user') continue
    const earliest = earliestByChat.get(message.chatId)
    if (
      !earliest ||
      message.createdAt < earliest.createdAt ||
      (message.createdAt === earliest.createdAt && message.id < earliest.id)
    ) {
      earliestByChat.set(message.chatId, message)
    }
  }
  return new Map(
    [...earliestByChat].map(([chatId, message]) => [
      chatId,
      previewTextFromContent(message.content),
    ]),
  )
}

export function splitMessageForStorage(
  message: Message,
  options: { bodyVersion?: number; requestContextVersion?: number; updatedAt?: number } = {},
): { header: MessageHeaderRow; body: MessageBodyRow } {
  const {
    content,
    reasoningDetails,
    toolCalls,
    refusal,
    phase,
    responsesEchoItem,
    providerOutputItems,
    continuationAttempts,
    ...headerFields
  } = message
  const header = structuredClone({
    ...headerFields,
    requestContextVersion: options.requestContextVersion ?? message.nodeVersion,
    bodyVersion: options.bodyVersion ?? message.nodeVersion,
    bodyWordCount: 0,
    textPreview: '',
  }) as MessageHeaderRow
  const body: MessageBodyRow = {
    id: message.id,
    chatId: message.chatId,
    bodyVersion: header.bodyVersion,
    updatedAt:
      options.updatedAt ?? message.editedAt ?? message.generation?.finishedAt ?? message.createdAt,
    content: structuredClone(content),
  }

  if (reasoningDetails !== undefined) {
    body.reasoningDetails = structuredClone(reasoningDetails)
  }
  if (toolCalls !== undefined) body.toolCalls = structuredClone(toolCalls)
  if (refusal !== undefined) body.refusal = refusal
  if (phase !== undefined) body.phase = phase
  if (responsesEchoItem !== undefined) {
    body.responsesEchoItem = structuredClone(responsesEchoItem)
  }
  if (providerOutputItems !== undefined) {
    body.providerOutputItems = structuredClone(providerOutputItems)
  }
  if (continuationAttempts !== undefined) {
    body.continuationAttempts = structuredClone(continuationAttempts)
  }
  syncMessageHeaderProjections(header, body, { replaceGenerationServerToolOutputs: true })

  return { header, body }
}

export function hydrateMessage(header: MessageHeaderRow, body: MessageBodyRow): Message {
  if (header.id !== body.id) throw new Error(`MessageBodyMismatch:${header.id}:${body.id}`)
  if (header.chatId !== body.chatId) {
    throw new Error(`MessageBodyChatMismatch:${header.id}:${header.chatId}:${body.chatId}`)
  }
  if (header.bodyVersion !== body.bodyVersion) {
    throw new Error(
      `MessageBodyVersionMismatch:${header.id}:${header.bodyVersion}:${body.bodyVersion}`,
    )
  }

  const {
    requestContextVersion: _requestContextVersion,
    bodyVersion: _bodyVersion,
    bodyWordCount: _bodyWordCount,
    textPreview: _textPreview,
    ...headerFields
  } = structuredClone(header)
  const message: Message = {
    ...headerFields,
    content: structuredClone(body.content),
  }
  if (body.reasoningDetails !== undefined) {
    message.reasoningDetails = structuredClone(body.reasoningDetails)
  }
  if (body.toolCalls !== undefined) message.toolCalls = structuredClone(body.toolCalls)
  if (body.refusal !== undefined) message.refusal = body.refusal
  if (body.phase !== undefined) message.phase = body.phase
  if (body.responsesEchoItem !== undefined) {
    message.responsesEchoItem = structuredClone(body.responsesEchoItem)
  }
  if (body.providerOutputItems !== undefined) {
    message.providerOutputItems = structuredClone(body.providerOutputItems)
  }
  if (body.continuationAttempts !== undefined) {
    message.continuationAttempts = structuredClone(body.continuationAttempts)
  }
  restoreGenerationServerToolOutputs(message, body.generationServerToolOutputs)
  return message
}

export function previewTextFromStoredProjection(
  textPreview: string,
  maxChars = CHAT_PREVIEW_MAX_CHARS,
): string {
  const limit = Math.min(MESSAGE_TEXT_PREVIEW_MAX_CHARS, Math.max(1, Math.floor(maxChars)))
  if (textPreview.length <= limit) return textPreview
  return `${textPreview.slice(0, limit - 1)}…`
}

function moveGenerationServerToolOutputsToBody(
  header: MessageHeaderRow,
  body: MessageBodyRow,
): void {
  const outputs = takeGenerationServerToolOutputs(header)
  if (outputs.length > 0) body.generationServerToolOutputs = outputs
}

export function syncMessageHeaderProjections(
  header: MessageHeaderRow,
  body: MessageBodyRow,
  options: { replaceGenerationServerToolOutputs?: boolean } = {},
): void {
  header.bodyWordCount = countMessagesWords([body as unknown as Message])
  header.textPreview = previewTextFromContent(body.content, MESSAGE_TEXT_PREVIEW_MAX_CHARS)
  if (!options.replaceGenerationServerToolOutputs) return
  delete body.generationServerToolOutputs
  moveGenerationServerToolOutputsToBody(header, body)
}

function takeGenerationServerToolOutputs(header: MessageHeaderRow): GenerationServerToolOutput[] {
  const tools = header.generation?.serverTools
  if (!tools) return []
  const outputs: GenerationServerToolOutput[] = []
  for (const [index, tool] of tools.entries()) {
    if (!Object.hasOwn(tool, 'output')) continue
    outputs.push({ index, output: structuredClone(tool.output) })
    delete tool.output
  }
  return outputs
}

function restoreGenerationServerToolOutputs(
  message: Message,
  outputs: readonly GenerationServerToolOutput[] | undefined,
): void {
  const tools = message.generation?.serverTools
  if (!tools || !outputs) return
  for (const entry of outputs) {
    const tool = tools[entry.index]
    if (tool) tool.output = structuredClone(entry.output)
  }
}

export function hydrateMessages(
  headers: readonly MessageHeaderRow[],
  bodies: readonly MessageBodyRow[],
): Message[] {
  const bodiesById = new Map(bodies.map((body) => [body.id, body]))
  return headers.map((header) => {
    const body = bodiesById.get(header.id)
    if (!body) throw new Error(`MessageBodyMissing:${header.id}`)
    return hydrateMessage(header, body)
  })
}

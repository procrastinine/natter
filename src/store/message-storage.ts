import type { ChatId, Message, MessageId } from '../core/types'

type MessageBodyKey =
  | 'content'
  | 'reasoningDetails'
  | 'toolCalls'
  | 'refusal'
  | 'phase'
  | 'responsesEchoItem'

export type MessageBodyFields = Pick<Message, MessageBodyKey>

export type MessageHeaderRow = Omit<Message, MessageBodyKey>

export interface MessageBodyRow extends MessageBodyFields {
  id: MessageId
  chatId: ChatId
  nodeVersion: number
  updatedAt: number
}

export const MESSAGE_BODY_KEYS: readonly MessageBodyKey[] = [
  'content',
  'reasoningDetails',
  'toolCalls',
  'refusal',
  'phase',
  'responsesEchoItem',
]

export function splitMessageForStorage(
  message: Message,
  options: { updatedAt?: number } = {},
): { header: MessageHeaderRow; body: MessageBodyRow } {
  const header = structuredClone(message) as MessageHeaderRow & Partial<MessageBodyFields>
  const body: MessageBodyRow = {
    id: message.id,
    chatId: message.chatId,
    nodeVersion: message.nodeVersion,
    updatedAt:
      options.updatedAt ?? message.editedAt ?? message.generation?.finishedAt ?? message.createdAt,
    content: structuredClone(message.content),
  }

  if (message.reasoningDetails !== undefined) {
    body.reasoningDetails = structuredClone(message.reasoningDetails)
  }
  if (message.toolCalls !== undefined) body.toolCalls = structuredClone(message.toolCalls)
  if (message.refusal !== undefined) body.refusal = message.refusal
  if (message.phase !== undefined) body.phase = message.phase
  if (message.responsesEchoItem !== undefined) {
    body.responsesEchoItem = structuredClone(message.responsesEchoItem)
  }

  for (const key of MESSAGE_BODY_KEYS) delete header[key]
  return { header, body }
}

export function hydrateMessage(header: MessageHeaderRow, body: MessageBodyRow): Message {
  if (header.id !== body.id) throw new Error(`MessageBodyMismatch:${header.id}:${body.id}`)
  if (header.chatId !== body.chatId) {
    throw new Error(`MessageBodyChatMismatch:${header.id}:${header.chatId}:${body.chatId}`)
  }
  if (header.nodeVersion !== body.nodeVersion) {
    throw new Error(`MessageBodyVersionMismatch:${header.id}:${header.nodeVersion}:${body.nodeVersion}`)
  }

  const message: Message = {
    ...(structuredClone(header)),
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
  return message
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

import type Dexie from 'dexie'
import type { DBCore, DBCoreMutateRequest, Middleware } from 'dexie'
import { findLastUpdatedLeafId } from '../core/active-path'
import { normalizeAttachmentRefs } from '../core/attachment-refs'
import { buildBranchMessages } from '../core/branch-flatten'
import { buildChildSlotProjection, type ChildSlotProjection } from '../core/child-list-state'
import { type AppliedMessageView, createAppliedMessageView } from '../core/continuation-content'
import { assertCanonicalGeneratedOutputMessage } from '../core/generated-output-localization'
import { messageTreeIndexFields } from '../core/message-tree-index'
import type { MessageHeaderRow as CoreMessageHeaderRow } from '../core/messages'
import {
  EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
  messageContextRouteFactsFromView,
} from '../core/reasoning'
import type { ChatId, ContentItem, Message, MessageAttachmentRef, MessageId } from '../core/types'
import { countMessagesWords } from '../core/word-count'
import { sameValue } from '../lib/same-value'

type MessageBodyKey =
  | 'content'
  | 'reasoningEnvelope'
  | 'toolCalls'
  | 'refusal'
  | 'phase'
  | 'providerOutputItems'
  | 'continuationAttempts'

export type MessageBodyFields = Pick<Message, MessageBodyKey>

export type MessageHeaderRow = CoreMessageHeaderRow

export function branchTreeSearchTarget(header: MessageHeaderRow) {
  return {
    id: header.id,
    nodeVersion: header.nodeVersion,
    bodyVersion: header.bodyVersion,
    pending: false,
    deleted: header.deleted,
  }
}

export type StructuralMessageHeader = Pick<
  MessageHeaderRow,
  'id' | 'chatId' | 'parentId' | 'siblingIndex' | 'createdAt' | 'deleted' | 'role'
>

export function toStructuralMessageHeader(
  header: StructuralMessageHeader,
): StructuralMessageHeader {
  return Object.freeze({
    id: header.id,
    chatId: header.chatId,
    parentId: header.parentId,
    siblingIndex: header.siblingIndex,
    createdAt: header.createdAt,
    deleted: header.deleted,
    role: header.role,
  })
}

export function sameMessageHeaderStructure(
  left: StructuralMessageHeader,
  right: StructuralMessageHeader,
): boolean {
  return (
    left.id === right.id &&
    left.chatId === right.chatId &&
    left.parentId === right.parentId &&
    left.siblingIndex === right.siblingIndex &&
    left.createdAt === right.createdAt &&
    left.deleted === right.deleted &&
    left.role === right.role
  )
}

export type MessageHeaderRevisionRelation =
  | 'older'
  | 'identical'
  | 'compatible-newer'
  | 'structural-newer'
  | 'invalid-regression'
  | 'version-collision'

export function sameMessageHeaderValue(left: MessageHeaderRow, right: MessageHeaderRow): boolean {
  return sameValue(left, right)
}

export function differingMessageHeaderFields(
  left: MessageHeaderRow,
  right: MessageHeaderRow,
): readonly (keyof MessageHeaderRow)[] {
  const keys = new Set<keyof MessageHeaderRow>([
    ...(Object.keys(left) as Array<keyof MessageHeaderRow>),
    ...(Object.keys(right) as Array<keyof MessageHeaderRow>),
  ])
  return Object.freeze([...keys].filter((key) => !sameValue(left[key], right[key])))
}

export function canonicalMessageHeaderRow(header: MessageHeaderRow): MessageHeaderRow {
  const canonical = structuredClone(header)
  canonical.attachmentRefs = canonicalMessageAttachmentRefs(canonical)
  return canonical
}

export function installMessageStorageCodec(db: Dexie): void {
  db.use(messageStorageCodecMiddleware)
}

const messageStorageCodecMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'MessageStorageCodec',
  level: 2,
  create: (down) => ({
    ...down,
    table: (tableName) => {
      const table = down.table(tableName)
      if (tableName !== 'messages') return table
      return {
        ...table,
        mutate: (request) => table.mutate(canonicalMessageMutation(request)),
      }
    },
  }),
}

function canonicalMessageMutation(request: DBCoreMutateRequest): DBCoreMutateRequest {
  if (request.type !== 'add' && request.type !== 'put') return request
  const sourceValues = request.values as unknown[]
  const values = sourceValues.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const header = value as Record<string, unknown>
    if (Array.isArray(header.attachmentRefs)) return value
    return { ...header, attachmentRefs: [] }
  })
  return values.every((value, index) => value === sourceValues[index])
    ? request
    : { ...request, values }
}

function canonicalMessageAttachmentRefs(
  header: Pick<MessageHeaderRow, 'attachmentRefs' | 'createdAt' | 'id'>,
): MessageAttachmentRef[] {
  return normalizeAttachmentRefs(header.attachmentRefs, {
    messageId: header.id,
    createdAt: header.createdAt,
  })
}

export function classifyMessageHeaderRevision(
  incoming: MessageHeaderRow,
  current: MessageHeaderRow,
): MessageHeaderRevisionRelation {
  const nodeDelta = incoming.nodeVersion - current.nodeVersion
  const bodyDelta = incoming.bodyVersion - current.bodyVersion
  if (nodeDelta === 0 && bodyDelta === 0) {
    return sameMessageHeaderValue(incoming, current) ? 'identical' : 'version-collision'
  }
  if (nodeDelta <= 0 && bodyDelta <= 0) return 'older'
  if (nodeDelta < 0 || bodyDelta < 0) return 'invalid-regression'
  return sameMessageHeaderStructure(incoming, current) ? 'compatible-newer' : 'structural-newer'
}

export interface MessagePresentation {
  readonly header: MessageHeaderRow
  readonly message: Message
  readonly bodyVersion: number
}

export interface MessageBodyRow extends MessageBodyFields {
  id: MessageId
  chatId: ChatId
  bodyVersion: number
  updatedAt: number
}

export interface MessageTextPreviewRow {
  id: MessageId
  chatId: ChatId
  bodyVersion: number
  text: string
}

export type CurrentMessageCustodyDisposition =
  | { readonly kind: 'available' }
  | { readonly kind: 'preserve' }
  | {
      readonly kind: 'reserved-attempt-target'
      readonly messageId: MessageId
      readonly streamId: string
    }

export interface CurrentMessageTransition {
  readonly storage: {
    readonly header: MessageHeaderRow
    readonly body: MessageBodyRow
    readonly preview: MessageTextPreviewRow
  }
  readonly attachmentOwner: {
    readonly ownerKind: 'message'
    readonly ownerId: MessageId
    readonly chatId: ChatId
    readonly previousRefs: readonly MessageAttachmentRef[] | undefined
    readonly nextRefs: readonly MessageAttachmentRef[] | undefined
  }
  readonly summary: {
    readonly wordCount: number
    readonly costUsd: number
    readonly previewCandidate: string | undefined
  }
  readonly structural: {
    readonly messageId: MessageId
    readonly chatId: ChatId
    readonly parentId: MessageId | null
    readonly siblingIndex: number
    readonly createdAt: number
    readonly deleted: boolean
    readonly role: Message['role']
  }
  readonly timestamp: {
    readonly kind: 'exact' | 'transaction-allocated'
    readonly createdAt: number
  }
  readonly custody: CurrentMessageCustodyDisposition
}

export interface CurrentMessageGraphTransition {
  readonly messages: readonly Message[]
  readonly transitions: readonly CurrentMessageTransition[]
  readonly childSlots: ChildSlotProjection
  readonly lastUpdatedLeafId: MessageId | null
  readonly branchMessages: readonly Message[]
  readonly branchTransitions: readonly CurrentMessageTransition[]
  readonly wordCount: number
  readonly totalCostUsd: number
  readonly previewText: string
}

export const MESSAGE_BODY_KEYS: readonly MessageBodyKey[] = [
  'content',
  'reasoningEnvelope',
  'toolCalls',
  'refusal',
  'phase',
  'providerOutputItems',
  'continuationAttempts',
]

const CHAT_PREVIEW_MAX_CHARS = 240
export const MESSAGE_TEXT_PREVIEW_MAX_CHARS = 1_024

const WHITESPACE = /\s/

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
): { header: MessageHeaderRow; body: MessageBodyRow; preview: MessageTextPreviewRow } {
  const {
    content,
    reasoningEnvelope,
    toolCalls,
    refusal,
    phase,
    providerOutputItems,
    continuationAttempts,
    ...headerFields
  } = message
  const header = canonicalMessageHeaderRow(
    structuredClone({
      ...headerFields,
      requestContextVersion: options.requestContextVersion ?? message.nodeVersion,
      bodyVersion: options.bodyVersion ?? message.nodeVersion,
      bodyWordCount: 0,
      bodyTextCharCount: 0,
      bodyMediaCount: 0,
      bodyRenderCost: 0,
      contextRouteFacts: EMPTY_MESSAGE_CONTEXT_ROUTE_FACTS,
      ...messageTreeIndexFields(message),
    }),
  )
  const body: MessageBodyRow = {
    id: message.id,
    chatId: message.chatId,
    bodyVersion: header.bodyVersion,
    updatedAt:
      options.updatedAt ?? message.editedAt ?? message.generation?.finishedAt ?? message.createdAt,
    content: structuredClone(content),
  }

  if (reasoningEnvelope !== undefined) {
    body.reasoningEnvelope = structuredClone(reasoningEnvelope)
  }
  if (toolCalls !== undefined) body.toolCalls = structuredClone(toolCalls)
  if (refusal !== undefined) body.refusal = refusal
  if (phase !== undefined) body.phase = phase
  if (providerOutputItems !== undefined) {
    body.providerOutputItems = structuredClone(providerOutputItems)
  }
  if (continuationAttempts !== undefined) {
    body.continuationAttempts = structuredClone(continuationAttempts)
  }
  const preview = syncMessageHeaderProjections(header, body)

  return { header, body, preview }
}

export function compileCurrentMessageTransition(
  message: Message,
  options: {
    readonly bodyVersion?: number
    readonly requestContextVersion?: number
    readonly updatedAt?: number
    readonly previousAttachmentRefs?: readonly MessageAttachmentRef[] | undefined
    readonly custody: CurrentMessageCustodyDisposition
    readonly timestamp: 'exact' | 'transaction-allocated'
  },
): CurrentMessageTransition {
  assertCanonicalGeneratedOutputMessage(message.content, message.attachmentRefs, message.id)
  const storage = splitMessageForStorage(message, options)
  if (
    options.custody.kind === 'reserved-attempt-target' &&
    options.custody.messageId !== message.id
  ) {
    throw new Error(
      `CurrentMessageAttemptCustodyMismatch:${message.id}:${options.custody.messageId}`,
    )
  }
  const generationStatus = message.generation?.status
  if (
    (generationStatus === 'preparing' || generationStatus === 'streaming') &&
    options.custody.kind === 'available'
  ) {
    throw new Error(`CurrentMessageAttemptCustodyMissing:${message.id}`)
  }
  return Object.freeze({
    storage: Object.freeze(storage),
    attachmentOwner: Object.freeze({
      ownerKind: 'message',
      ownerId: message.id,
      chatId: message.chatId,
      previousRefs: options.previousAttachmentRefs,
      nextRefs: message.attachmentRefs,
    }),
    summary: Object.freeze({
      wordCount: message.deleted ? 0 : storage.header.bodyWordCount,
      costUsd: message.deleted ? 0 : (message.generation?.cost ?? 0),
      previewCandidate:
        !message.deleted && message.role === 'user' ? storage.preview.text : undefined,
    }),
    structural: Object.freeze({
      messageId: message.id,
      chatId: message.chatId,
      parentId: message.parentId,
      siblingIndex: message.siblingIndex,
      createdAt: message.createdAt,
      deleted: message.deleted,
      role: message.role,
    }),
    timestamp: Object.freeze({ kind: options.timestamp, createdAt: message.createdAt }),
    custody: options.custody,
  })
}

export function compileCurrentMessageGraphTransition(
  chatId: ChatId,
  messages: readonly Message[],
  updatedAt: number,
): CurrentMessageGraphTransition {
  for (const message of messages) {
    if (message.chatId !== chatId) {
      throw new Error(`CurrentMessageGraphChatMismatch:${chatId}:${message.id}:${message.chatId}`)
    }
  }
  const transitions = messages.map((message) =>
    compileCurrentMessageTransition(message, {
      updatedAt,
      timestamp: 'exact',
      custody: { kind: 'available' },
    }),
  )
  const transitionById = new Map(
    transitions.map((transition) => [transition.storage.header.id, transition]),
  )
  const lastUpdatedLeafId = findLastUpdatedLeafId(messages)
  const branchMessages = buildBranchMessages(messages, lastUpdatedLeafId)
  return Object.freeze({
    messages,
    transitions: Object.freeze(transitions),
    childSlots: buildChildSlotProjection(chatId, messages, { updatedAt }),
    lastUpdatedLeafId,
    branchMessages: Object.freeze(branchMessages),
    branchTransitions: Object.freeze(
      branchMessages.map((message) => {
        const transition = transitionById.get(message.id)
        if (!transition) throw new Error(`CurrentMessageTransitionMissing:${message.id}`)
        return transition
      }),
    ),
    wordCount: branchMessages.reduce((total, message) => {
      const transition = transitionById.get(message.id)
      if (!transition) throw new Error(`CurrentMessageTransitionMissing:${message.id}`)
      return total + transition.summary.wordCount
    }, 0),
    totalCostUsd: transitions.reduce((total, transition) => total + transition.summary.costUsd, 0),
    previewText: previewTextFromMessages(messages),
  })
}

export function hydrateMessage(header: MessageHeaderRow, body: MessageBodyRow): Message {
  return hydrateMessageRows(header, body, true)
}

export function hydrateMessageWithOwnedBody(
  header: MessageHeaderRow,
  body: MessageBodyRow,
): Message {
  return hydrateMessageRows(header, body, false)
}

function hydrateMessageRows(
  header: MessageHeaderRow,
  body: MessageBodyRow,
  cloneBody: boolean,
): Message {
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
    bodyTextCharCount: _bodyTextCharCount,
    bodyMediaCount: _bodyMediaCount,
    bodyRenderCost: _bodyRenderCost,
    contextRouteFacts: _contextRouteFacts,
    treeParentKey: _treeParentKey,
    treeLive: _treeLive,
    ...headerFields
  } = structuredClone(header)
  const message: Message = {
    ...headerFields,
    content: cloneBody ? structuredClone(body.content) : body.content,
  }
  if (body.reasoningEnvelope !== undefined) {
    message.reasoningEnvelope = cloneBody
      ? structuredClone(body.reasoningEnvelope)
      : body.reasoningEnvelope
  }
  if (body.toolCalls !== undefined) {
    message.toolCalls = cloneBody ? structuredClone(body.toolCalls) : body.toolCalls
  }
  if (body.refusal !== undefined) message.refusal = body.refusal
  if (body.phase !== undefined) message.phase = body.phase
  if (body.providerOutputItems !== undefined) {
    message.providerOutputItems = cloneBody
      ? structuredClone(body.providerOutputItems)
      : body.providerOutputItems
  }
  if (body.continuationAttempts !== undefined) {
    message.continuationAttempts = cloneBody
      ? structuredClone(body.continuationAttempts)
      : body.continuationAttempts
  }
  return message
}

export function rebaseHydratedMessageHeader(message: Message, header: MessageHeaderRow): Message {
  const {
    requestContextVersion: _requestContextVersion,
    bodyVersion: _bodyVersion,
    bodyWordCount: _bodyWordCount,
    bodyTextCharCount: _bodyTextCharCount,
    bodyMediaCount: _bodyMediaCount,
    bodyRenderCost: _bodyRenderCost,
    contextRouteFacts: _contextRouteFacts,
    treeParentKey: _treeParentKey,
    treeLive: _treeLive,
    ...headerFields
  } = header
  return { ...message, ...headerFields }
}

export function previewTextFromStoredProjection(
  textPreview: string,
  maxChars = CHAT_PREVIEW_MAX_CHARS,
): string {
  const limit = Math.min(MESSAGE_TEXT_PREVIEW_MAX_CHARS, Math.max(1, Math.floor(maxChars)))
  if (textPreview.length <= limit) return textPreview
  return `${textPreview.slice(0, limit - 1)}…`
}

export function syncMessageHeaderProjections(
  header: MessageHeaderRow,
  body: MessageBodyRow,
): MessageTextPreviewRow {
  const appliedView = createAppliedMessageView(body)
  header.bodyWordCount = countMessagesWords([body as unknown as Message])
  const metrics = projectMessageBodyRenderMetrics(header, body, appliedView)
  header.bodyTextCharCount = metrics.textCharCount
  header.bodyMediaCount = metrics.mediaCount
  header.bodyRenderCost = metrics.renderCost
  header.contextRouteFacts = messageContextRouteFactsFromView(appliedView)
  return projectMessageTextPreview(header, body)
}

export interface MessageBodyRenderMetrics {
  readonly textCharCount: number
  readonly mediaCount: number
  readonly renderCost: number
}

const RENDER_TEXT_CHARS_PER_UNIT = 120
const RENDER_MEDIA_UNITS = 24
const RENDER_ROW_UNITS = 8

export function projectMessageBodyRenderMetrics(
  header: Pick<MessageHeaderRow, 'attachmentRefs'>,
  body: Pick<
    MessageBodyRow,
    'content' | 'reasoningEnvelope' | 'refusal' | 'toolCalls' | 'continuationAttempts'
  >,
  appliedView: AppliedMessageView = createAppliedMessageView(body),
): MessageBodyRenderMetrics {
  let textCharCount = 0
  let auxiliaryTextChars = body.refusal?.length ?? 0
  let mediaCount = 0
  let textBlocks = 0
  for (const item of body.content) {
    if (item.type === 'text' || item.type === 'output_text') {
      textCharCount += item.text.length
      textBlocks += 1
    } else if (item.type === 'audio_output') {
      auxiliaryTextChars += item.transcript?.length ?? 0
      mediaCount += 1
    } else {
      mediaCount += 1
    }
  }
  for (const attempt of appliedView.attempts) {
    for (const part of attempt.reasoningEnvelope?.visible ?? []) {
      auxiliaryTextChars += part.text.length
    }
    for (const call of attempt.toolCalls ?? []) {
      auxiliaryTextChars += call.function.name.length + call.function.arguments.length
    }
  }
  for (const ref of header.attachmentRefs ?? []) {
    if (ref.deletedAt === undefined) mediaCount += 1
  }
  const renderCost = Math.max(
    1,
    RENDER_ROW_UNITS +
      Math.ceil((textCharCount + auxiliaryTextChars) / RENDER_TEXT_CHARS_PER_UNIT) +
      mediaCount * RENDER_MEDIA_UNITS +
      textBlocks,
  )
  return { textCharCount, mediaCount, renderCost }
}

export function projectMessageTextPreview(
  header: MessageHeaderRow,
  body: MessageBodyRow,
): MessageTextPreviewRow {
  if (header.id !== body.id || header.chatId !== body.chatId) {
    throw new Error(`MessagePreviewIdentityMismatch:${header.id}:${body.id}`)
  }
  if (header.bodyVersion !== body.bodyVersion) {
    throw new Error(`MessagePreviewVersionMismatch:${header.id}`)
  }
  return {
    id: header.id,
    chatId: header.chatId,
    bodyVersion: body.bodyVersion,
    text: previewTextFromContent(body.content, MESSAGE_TEXT_PREVIEW_MAX_CHARS),
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

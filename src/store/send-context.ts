import { activePath } from '../core/active-path'
import {
  attachmentContextPolicyForSettings,
  resolveAttachmentContextRefs,
} from '../core/attachments/context'
import { type MessageCostOptions, messageCost, resolveCutoff } from '../core/context-cutoff'
import { readGlobalPreferences } from '../core/global-settings'
import type { AttachmentResolver } from '../core/media-context-tokens'
import { applyOutboundContextRewrites } from '../core/prompt-context'
import { tokenizerFromSettings, UNLIMITED_CONTEXT } from '../core/prompt-size'
import { quirksFor } from '../core/quirks'
import { charsPerToken, readTokenCalibrationGlobal } from '../core/token-calibration'
import { estimateTokens, type PromptEstimateOptions } from '../core/tokens'
import type {
  Attachment,
  AttachmentId,
  Chat,
  ChatSettings,
  Message,
  MessageId,
} from '../core/types'
import { getDb } from './db'
import { hydrateMessages, type MessageBodyRow, type MessageHeaderRow } from './message-storage'
import { flushPendingPromptSettingSaves } from './prompt-presets'
import type { BranchHeaderSnapshot, MutationContext } from './repository'
import { getWorkspaceRepository } from './workspace-repository'

interface ChatHeaderSnapshot {
  chat: Chat
  chatId: string
  allHeaders: MessageHeaderRow[]
}

interface ActiveBranchHeaderSnapshot extends ChatHeaderSnapshot {
  branchHeaders: MessageHeaderRow[]
}

interface SendContextSnapshot {
  pathMessages: Message[]
  loadedBodyIds: MessageId[]
  usedFullBranch: boolean
  preCutAttachmentIds: AttachmentId[]
}

interface SendContextInput {
  chat: Chat
  branchHeaders: readonly MessageHeaderRow[]
  settings?: ChatSettings
  capabilities?: { maxPromptTokens?: number; contextLength?: number }
  pendingMessages?: readonly Message[]
  mapHydratedMessage?: (message: Message) => Message
}

interface SendContextItem {
  id: MessageId
  role: Message['role']
  hiddenFromContext?: boolean | undefined
  deleted: boolean
  header?: MessageHeaderRow
  message?: Message
}

interface SendContextBucket {
  items: SendContextItem[]
  messages?: Message[]
  tokens?: number
}

const EMPTY_PENDING: readonly Message[] = Object.freeze([])

export interface SendContextMessageRevision {
  id: MessageId
  chatId: string
  parentId: MessageId | null
  nodeVersion: number
  deleted: boolean
}

export interface SendContextGuard {
  chatId: string
  settings: ChatSettings
  messageRevisions: SendContextMessageRevision[]
}

export type StaleSendContextReason =
  | 'chat-missing'
  | 'settings-changed'
  | 'message-missing'
  | 'message-changed'

export class StaleSendContextError extends Error {
  readonly chatId: string
  readonly reason: StaleSendContextReason
  readonly messageId?: MessageId

  constructor(chatId: string, reason: StaleSendContextReason, messageId?: MessageId) {
    super(staleSendContextMessage(chatId, reason, messageId))
    this.name = 'StaleSendContextError'
    this.chatId = chatId
    this.reason = reason
    if (messageId !== undefined) this.messageId = messageId
  }
}

function staleSendContextMessage(
  chatId: string,
  reason: StaleSendContextReason,
  messageId?: MessageId,
): string {
  if (reason === 'chat-missing')
    return `Send context is stale because chat ${chatId} is unavailable.`
  if (reason === 'settings-changed') {
    return `Send context is stale because chat ${chatId} settings changed while the request was being prepared.`
  }
  if (reason === 'message-missing') {
    return `Send context is stale because message ${messageId ?? 'unknown'} is unavailable.`
  }
  return `Send context is stale because message ${messageId ?? 'unknown'} changed while the request was being prepared.`
}

export function createSendContextGuard(
  chat: Pick<Chat, 'id' | 'settings'>,
  headers: readonly MessageHeaderRow[],
): SendContextGuard {
  return {
    chatId: chat.id,
    settings: structuredClone(chat.settings),
    messageRevisions: headers.map(messageRevision),
  }
}

export function appendSendContextGuardMessage(
  guard: SendContextGuard,
  message: Pick<MessageHeaderRow, 'id' | 'chatId' | 'parentId' | 'nodeVersion' | 'deleted'>,
): SendContextGuard {
  return {
    ...guard,
    messageRevisions: [...guard.messageRevisions, messageRevision(message)],
  }
}

export function assertSendContextGuard(
  chat: Pick<Chat, 'id' | 'settings'> | undefined,
  headers: readonly (MessageHeaderRow | undefined)[],
  guard: SendContextGuard,
): void {
  if (!chat || chat.id !== guard.chatId) {
    throw new StaleSendContextError(guard.chatId, 'chat-missing')
  }
  if (!sendContextValuesEqual(chat.settings, guard.settings)) {
    throw new StaleSendContextError(guard.chatId, 'settings-changed')
  }
  for (let index = 0; index < guard.messageRevisions.length; index += 1) {
    const expected = guard.messageRevisions[index] as SendContextMessageRevision
    const actual = headers[index]
    if (!actual) {
      throw new StaleSendContextError(guard.chatId, 'message-missing', expected.id)
    }
    if (!messageRevisionMatches(actual, expected)) {
      throw new StaleSendContextError(guard.chatId, 'message-changed', expected.id)
    }
  }
}

export async function assertSendContextGuardInMutation(
  ctx: MutationContext,
  guard: SendContextGuard,
): Promise<void> {
  const [chat, headers] = await Promise.all([
    ctx.getChat(guard.chatId),
    Promise.all(guard.messageRevisions.map((revision) => ctx.getMessageHeader(revision.id))),
  ])
  assertSendContextGuard(chat, headers, guard)
}

export async function assertSendContextFresh(guard: SendContextGuard): Promise<void> {
  const snapshot = await getWorkspaceRepository().getSendContextRevisionSnapshot(
    guard.chatId,
    guard.messageRevisions.map((revision) => revision.id),
  )
  assertSendContextGuard(snapshot.chat, snapshot.headers, guard)
}

function messageRevision(
  message: Pick<MessageHeaderRow, 'id' | 'chatId' | 'parentId' | 'nodeVersion' | 'deleted'>,
): SendContextMessageRevision {
  return {
    id: message.id,
    chatId: message.chatId,
    parentId: message.parentId,
    nodeVersion: message.nodeVersion,
    deleted: message.deleted,
  }
}

function messageRevisionMatches(
  actual: Pick<MessageHeaderRow, 'id' | 'chatId' | 'parentId' | 'nodeVersion' | 'deleted'>,
  expected: SendContextMessageRevision,
): boolean {
  return (
    actual.id === expected.id &&
    actual.chatId === expected.chatId &&
    actual.parentId === expected.parentId &&
    actual.nodeVersion === expected.nodeVersion &&
    actual.deleted === expected.deleted
  )
}

function sendContextValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index += 1) {
      if (!sendContextValuesEqual(left[index], right[index])) return false
    }
    return true
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if (
      !Object.hasOwn(rightRecord, key) ||
      !sendContextValuesEqual(leftRecord[key], rightRecord[key])
    ) {
      return false
    }
  }
  return true
}

export async function loadChatHeaderSnapshot(chatId: string): Promise<ChatHeaderSnapshot> {
  await flushPendingPromptSettingSaves(chatId)
  const db = getDb()
  const [chat, allHeaders] = await db.transaction('r', db.chats, db.messages, async () =>
    Promise.all([db.chats.get(chatId), db.messages.where('chatId').equals(chatId).toArray()]),
  )
  if (!chat) throw new Error(`ChatHeaderSnapshotMissing:${chatId}`)
  return { chat, chatId, allHeaders }
}

export async function loadActiveBranchHeaderSnapshot(
  chatId: string,
  cursor: Record<string, MessageId>,
): Promise<ActiveBranchHeaderSnapshot> {
  const snapshot = await loadChatHeaderSnapshot(chatId)
  const branchHeaders = activePath(snapshot.allHeaders as unknown as Message[], cursor).map(
    (message) => message as unknown as MessageHeaderRow,
  )
  return { ...snapshot, branchHeaders }
}

export async function loadBranchHeaderSnapshotByLeaf(
  chatId: string,
  leafId: MessageId | null,
): Promise<BranchHeaderSnapshot> {
  await flushPendingPromptSettingSaves(chatId)
  return getWorkspaceRepository().getBranchHeaderSnapshotByLeaf(chatId, leafId)
}

export async function loadSendContextForBranch(
  input: SendContextInput,
): Promise<SendContextSnapshot> {
  return loadSendContextForBranchAttempt(input, 0)
}

async function loadSendContextForBranchAttempt(
  input: SendContextInput,
  attempt: number,
): Promise<SendContextSnapshot> {
  const settings = input.settings ?? input.chat.settings
  const pendingMessages = input.pendingMessages ?? EMPTY_PENDING
  const providerCap =
    input.capabilities?.maxPromptTokens ?? input.capabilities?.contextLength ?? null
  if (!canUseTailLoader(settings, providerCap, input.branchHeaders, pendingMessages)) {
    return loadFullContext(input, true)
  }

  const branchHeaders = await refreshHeaders(input.branchHeaders)
  const planningInput = { ...input, branchHeaders }
  const headerSignature = branchHeaderContextSignature(branchHeaders)
  const items = buildContextItems(branchHeaders, pendingMessages)
  const visible = items.filter((item) => !item.deleted && item.hiddenFromContext !== true)
  const attachmentRefsByMessageId = resolveAttachmentContextRefs({
    messages: visible.map(contextMessageForRefs),
    policy: attachmentContextPolicyForSettings(settings),
  })
  const attachmentIds = attachmentIdsFromRefs(attachmentRefsByMessageId)
  const attachmentResolver =
    attachmentIds.length > 0 ? await loadAttachmentResolver(attachmentIds) : undefined
  const globalPrefs = await readGlobalPreferences()
  const globalCalibration = await readTokenCalibrationGlobal()
  const tokenizer = tokenizerFromSettings(settings, null)
  const disableTextCalibration = attachmentIds.length > 0
  const currentTextCharsPerToken =
    settings.model && !disableTextCalibration
      ? charsPerToken(
          settings.model,
          input.chat,
          globalCalibration,
          globalPrefs.tokenCalibrationMode,
        )
      : undefined
  const reasoningOpts: PromptEstimateOptions = {
    family: tokenizer,
    reasoningInclude: settings.reasoning.include,
    reasoningExcluded: settings.reasoning.exclude === true,
    includeToolCalls: settings.toolCallContext.include,
  }
  const reasoningFormat = quirksFor(settings.model).reasoningPreservationFormat
  if (reasoningFormat !== undefined) {
    reasoningOpts.reasoningPreservationFormat = reasoningFormat
  }
  const costOpts: MessageCostOptions = {
    family: tokenizer,
    reasoningOpts,
    currentModelId: settings.model,
    attachmentRefsByMessageId,
  }
  if (attachmentResolver) costOpts.attachmentResolver = attachmentResolver
  if (currentTextCharsPerToken !== undefined) {
    costOpts.currentTextCharsPerToken = currentTextCharsPerToken
  }
  if (disableTextCalibration) costOpts.disableTextCalibration = true

  const grouped = groupContextItems(visible)
  const cutoff = resolveCutoff(settings, providerCap)
  const systemTokens =
    settings.systemPrompt.length > 0 ? estimateTokens(settings.systemPrompt, tokenizer) : 0
  const reserveRaw = settings.maxCompletionTokens
  const reserveTokens = reserveRaw === UNLIMITED_CONTEXT ? 0 : Math.max(0, reserveRaw ?? 0)

  const loadedIds: MessageId[] = []
  const preamble = await loadBucketMessages(grouped.preamble, input, loadedIds)
  const preambleTokens = bucketTokens(preamble, costOpts)
  const available = cutoff - systemTokens - preambleTokens - reserveTokens
  const totalPairs = grouped.pairs.length
  let headCount = Math.min(Math.max(0, settings.contextStrategy.keepFirstPairs ?? 0), totalPairs)
  let headTokens = 0
  const headMessages = new Map<number, Message[]>()
  const pairTokens = new Map<number, number>()

  for (let i = 0; i < headCount; i += 1) {
    const { messages, tokens } = await loadPair({
      bucket: grouped.pairs[i],
      input: planningInput,
      costOpts,
      loadedIds,
      rewriteAsLastPair: i === totalPairs - 1,
    })
    headMessages.set(i, messages)
    pairTokens.set(i, tokens)
    headTokens += tokens
  }
  while (headCount > 0 && headTokens > available) {
    headCount -= 1
    headTokens -= pairTokens.get(headCount) ?? 0
  }

  const remaining = Math.max(0, available - headTokens)
  const tailMessages = new Map<number, Message[]>()
  let tailStart = totalPairs
  let tailTokens = 0
  for (let i = totalPairs - 1; i >= headCount; i -= 1) {
    const loaded = await loadPair({
      bucket: grouped.pairs[i],
      input: planningInput,
      costOpts,
      loadedIds,
      rewriteAsLastPair: i === totalPairs - 1,
    })
    if (tailTokens + loaded.tokens > remaining) break
    tailMessages.set(i, loaded.messages)
    pairTokens.set(i, loaded.tokens)
    tailTokens += loaded.tokens
    tailStart = i
  }

  const pathMessages: Message[] = [...preamble]
  for (let i = 0; i < headCount; i += 1) {
    pathMessages.push(...(headMessages.get(i) ?? []))
  }
  for (let i = tailStart; i < totalPairs; i += 1) {
    pathMessages.push(...(tailMessages.get(i) ?? []))
  }

  const latestHeaders = await refreshHeaders(input.branchHeaders)
  if (branchHeaderContextSignature(latestHeaders) !== headerSignature) {
    if (attempt < 1) return loadSendContextForBranchAttempt(input, attempt + 1)
    return loadFullContext({ ...input, branchHeaders: latestHeaders }, true)
  }

  return {
    pathMessages,
    loadedBodyIds: [...new Set(loadedIds)],
    usedFullBranch: false,
    preCutAttachmentIds: attachmentIds,
  }
}

function canUseTailLoader(
  settings: ChatSettings,
  providerCap: number | null,
  _branchHeaders: readonly MessageHeaderRow[],
  _pendingMessages: readonly Message[],
): boolean {
  if (settings.contextStrategy.kind !== 'sliding_window') return false
  if (!Number.isFinite(resolveCutoff(settings, providerCap))) return false
  return true
}

async function loadFullContext(
  input: SendContextInput,
  usedFullBranch: boolean,
): Promise<SendContextSnapshot> {
  const messages = await hydrateHeaders(input.branchHeaders, input.mapHydratedMessage)
  const pending = (input.pendingMessages ?? EMPTY_PENDING).map((message) =>
    structuredClone(message),
  )
  return {
    pathMessages: [...messages, ...pending],
    loadedBodyIds: input.branchHeaders.map((header) => header.id),
    usedFullBranch,
    preCutAttachmentIds: [],
  }
}

function buildContextItems(
  branchHeaders: readonly MessageHeaderRow[],
  pendingMessages: readonly Message[],
): SendContextItem[] {
  return [
    ...branchHeaders.map((header) => ({
      id: header.id,
      role: header.role,
      hiddenFromContext: header.hiddenFromContext,
      deleted: header.deleted,
      header,
    })),
    ...pendingMessages.map((message) => ({
      id: message.id,
      role: message.role,
      hiddenFromContext: message.hiddenFromContext,
      deleted: message.deleted,
      message,
    })),
  ]
}

function groupContextItems(items: readonly SendContextItem[]): {
  preamble: SendContextBucket
  pairs: SendContextBucket[]
} {
  const preamble: SendContextBucket = { items: [] }
  const pairs: SendContextBucket[] = []
  let current: SendContextBucket | null = null
  for (const item of items) {
    if (item.role === 'user') {
      if (current) pairs.push(current)
      current = { items: [item] }
    } else if (current) {
      current.items.push(item)
    } else {
      preamble.items.push(item)
    }
  }
  if (current) pairs.push(current)
  return { preamble, pairs }
}

async function loadPair(input: {
  bucket: SendContextBucket | undefined
  input: SendContextInput
  costOpts: MessageCostOptions
  loadedIds: MessageId[]
  rewriteAsLastPair: boolean
}): Promise<{ messages: Message[]; tokens: number }> {
  const { bucket } = input
  if (!bucket) return { messages: [], tokens: 0 }
  const messages = await loadBucketMessages(bucket, input.input, input.loadedIds)
  const costMessages = input.rewriteAsLastPair
    ? applyOutboundContextRewrites(messages, input.input.settings ?? input.input.chat.settings)
    : messages
  return { messages, tokens: bucketTokens(costMessages, input.costOpts) }
}

async function loadBucketMessages(
  bucket: SendContextBucket,
  input: SendContextInput,
  loadedIds: MessageId[],
): Promise<Message[]> {
  if (bucket.messages) return bucket.messages
  const historical = bucket.items
    .filter((item) => item.header)
    .map((item) => item.header as MessageHeaderRow)
  const hydrated =
    historical.length > 0 ? await hydrateHeaders(historical, input.mapHydratedMessage) : []
  loadedIds.push(...historical.map((header) => header.id))
  const byId = new Map(hydrated.map((message) => [message.id, message]))
  const messages = bucket.items.map((item) => {
    if (item.message) return structuredClone(item.message)
    const message = byId.get(item.id)
    if (!message) throw new Error(`MessageBodyMissing:${item.id}`)
    return message
  })
  bucket.messages = messages
  return messages
}

function bucketTokens(messages: readonly Message[], costOpts: MessageCostOptions): number {
  let total = 0
  for (const message of messages) {
    total += messageCost(message, costOpts).total
  }
  return total
}

function contextMessageForRefs(item: SendContextItem): Message {
  if (item.message) return item.message
  if (!item.header) throw new Error(`MessageHeaderMissing:${item.id}`)
  return { ...item.header, content: [] }
}

function attachmentIdsFromRefs(
  refsByMessageId: ReadonlyMap<string, readonly { attachmentId: AttachmentId }[]>,
): AttachmentId[] {
  const ids = new Set<AttachmentId>()
  for (const refs of refsByMessageId.values()) {
    for (const ref of refs) ids.add(ref.attachmentId)
  }
  return [...ids]
}

async function loadAttachmentResolver(ids: readonly AttachmentId[]): Promise<AttachmentResolver> {
  const repository = getWorkspaceRepository()
  const rows = await Promise.all(ids.map((id) => repository.getAttachment(id)))
  const byId = new Map<AttachmentId, Attachment>()
  for (const row of rows) {
    if (row) byId.set(row.id, row)
  }
  return (id) => byId.get(id)
}

async function refreshHeaders(headers: readonly MessageHeaderRow[]): Promise<MessageHeaderRow[]> {
  if (headers.length === 0) return []
  const ids = headers.map((header) => header.id)
  const rows = await getDb().messages.bulkGet(ids)
  return rows.map((row, index) => {
    if (!row) throw new Error(`MessageHeaderMissing:${ids[index]}`)
    return row
  })
}

function branchHeaderContextSignature(headers: readonly MessageHeaderRow[]): string {
  return JSON.stringify(
    headers.map((header) => ({
      id: header.id,
      parentId: header.parentId,
      siblingIndex: header.siblingIndex,
      role: header.role,
      createdAt: header.createdAt,
      nodeVersion: header.nodeVersion,
      deleted: header.deleted,
      hiddenFromContext: header.hiddenFromContext === true,
      attachmentRefs: header.attachmentRefs ?? [],
      originalCharCount: header.originalCharCount,
      originalTokenEstimate: header.originalTokenEstimate,
      originalModelId: header.originalModelId,
      originalCalibrationKey: header.originalCalibrationKey,
      charCountDelta: header.charCountDelta,
      cachedTokenEstimate: header.cachedTokenEstimate,
      cachedMediaTokens: header.cachedMediaTokens,
    })),
  )
}

async function hydrateHeaders(
  headers: readonly MessageHeaderRow[],
  mapHydratedMessage?: (message: Message) => Message,
): Promise<Message[]> {
  if (headers.length === 0) return []
  const ids = headers.map((header) => header.id)
  const db = getDb()
  const [currentHeaders, rawBodies] = await db.transaction(
    'r',
    db.messages,
    db.messageBodies,
    async () => Promise.all([db.messages.bulkGet(ids), db.messageBodies.bulkGet(ids)]),
  )
  const hydratedHeaders = currentHeaders.map((header, index) => {
    if (!header) throw new Error(`MessageHeaderMissing:${ids[index]}`)
    return header
  })
  const bodies = rawBodies.filter((row): row is MessageBodyRow => row !== undefined)
  const messages = hydrateMessages(hydratedHeaders, bodies)
  return mapHydratedMessage ? messages.map(mapHydratedMessage) : messages
}

import type { AssistantRouteContract } from '../core/api-choice'
import type { AssistantPlanningResources } from '../core/assistant-planning-resources'
import {
  attachmentContextPolicyForSettings,
  resolveAttachmentContextRefs,
} from '../core/attachments/context'
import { type MessageCostOptions, messageCost, resolveCutoff } from '../core/context-cutoff'
import { groupUserAnchoredContextItems, selectContextPairsLazily } from '../core/context-selection'
import type { AttachmentResolver } from '../core/media-context-tokens'
import {
  createOutboundReasoningCompiler,
  type OutboundReasoningResolver,
  outboundReasoningRouteForAssistantRoute,
} from '../core/outbound-reasoning'
import {
  applyOutboundContextRewrite,
  type OutboundContextRewritePlan,
  planOutboundContextRewrites,
  projectOutboundContextRewrites,
} from '../core/prompt-context'
import { tokenizerFromSettings, UNLIMITED_CONTEXT } from '../core/prompt-size'
import { type CalibrationMode, charsPerToken } from '../core/token-calibration'
import { estimateTokens, type PromptEstimateOptions } from '../core/tokens'
import type {
  Attachment,
  AttachmentId,
  Chat,
  ChatSettings,
  GlobalTokenCalibration,
  Message,
  MessageId,
  SealedReasoningCarryForward,
} from '../core/types'
import {
  GENERATION_MATERIAL_PAGE_ROWS,
  GENERATION_MATERIAL_PAGE_TEXT_CHARS,
  type GenerationPromptMaterialLease,
  generationMaterialPages,
} from './generation-prompt-material'
import { readGlobalPreferences } from './global-settings'
import {
  type MessageHeaderRow,
  type MessagePresentation,
  rebaseHydratedMessageHeader,
} from './message-storage'
import { readTokenCalibrationGlobal } from './token-calibration'
import type { WorkspaceReadAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export interface SendContextSnapshot {
  pathMessages: Message[]
  reasoningResolver: OutboundReasoningResolver
  reasoningCarryForwardByMessageId: ReadonlyMap<MessageId, SealedReasoningCarryForward>
  loadedBodyIds: MessageId[]
  usedFullBranch: boolean
  preCutAttachmentIds: AttachmentId[]
  attachmentTokenEvidence: Attachment[]
  calibrationEvidence?: {
    global: GlobalTokenCalibration
    mode: CalibrationMode
  }
}

export interface PromptEstimateContextSnapshot extends SendContextSnapshot {
  calibrationEvidence: {
    global: GlobalTokenCalibration
    mode: CalibrationMode
  }
}

declare const selectedPromptContextBrand: unique symbol

export interface SelectedPromptContext extends SendContextSnapshot {
  readonly [selectedPromptContextBrand]: true
}

export interface PromptEstimateContextInput {
  chat: Chat
  branchHeaders: readonly MessageHeaderRow[]
  excludedMessageIds?: readonly MessageId[]
  settings?: ChatSettings
  capabilities?: { maxPromptTokens?: number; contextLength?: number }
  calibrationEvidence?: {
    readonly global: GlobalTokenCalibration
    readonly mode: CalibrationMode
  }
  routing: AssistantRouteContract
  signal?: AbortSignal
}

export interface GenerationSendContextInput {
  chat: Chat
  branchHeaders: readonly MessageHeaderRow[]
  settings: ChatSettings
  capabilities?: { maxPromptTokens?: number; contextLength?: number }
  pendingMessages: readonly Message[]
  routing: AssistantRouteContract
  knownMessages?: readonly Message[]
  prefillReasoningTargetId?: MessageId
  signal?: AbortSignal
  authority: WorkspaceReadAuthority
  planningResources?: AssistantPlanningResources
  promptMaterial: GenerationPromptMaterialLease
}

interface SendContextInput {
  chat: Chat
  branchHeaders: readonly MessageHeaderRow[]
  settings?: ChatSettings
  capabilities?: { maxPromptTokens?: number; contextLength?: number }
  pendingMessages?: readonly Message[]
  routing: AssistantRouteContract
  knownMessages?: readonly Message[]
  prefillReasoningTargetId?: MessageId
  signal?: AbortSignal
  authority?: WorkspaceReadAuthority
  planningResources?: AssistantPlanningResources
  promptMaterial?: GenerationPromptMaterialLease
  calibrationEvidence?: {
    readonly global: GlobalTokenCalibration
    readonly mode: CalibrationMode
  }
  includeCalibrationEvidence?: boolean
  excludedMessageIds?: readonly MessageId[]
  rewritePlan?: OutboundContextRewritePlan
  rewriteCarryForwardByMessageId?: Map<MessageId, SealedReasoningCarryForward>
}

interface SendContextItem {
  id: MessageId
  role: Message['role']
  origin: Message['origin']
  hiddenFromContext?: boolean | undefined
  deleted: boolean
  header?: MessageHeaderRow
  message?: Message
}

interface SendContextBucket {
  items: SendContextItem[]
  messages?: Message[]
}

const EMPTY_PENDING: readonly Message[] = Object.freeze([])
function throwIfSendContextAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Send context read aborted', 'AbortError')
}

export function loadPromptEstimateContextForBranch(
  input: PromptEstimateContextInput,
): Promise<PromptEstimateContextSnapshot> {
  return loadSendContextForBranch({
    ...input,
    includeCalibrationEvidence: true,
  }) as Promise<PromptEstimateContextSnapshot>
}

export function loadGenerationContextForBranch(
  input: GenerationSendContextInput,
): Promise<SelectedPromptContext> {
  return loadSendContextForBranch(input) as Promise<SelectedPromptContext>
}

function loadSendContextForBranch(input: SendContextInput): Promise<SendContextSnapshot> {
  if (!input.authority) {
    return runWorkspaceRead(
      'repository-query',
      (authority) => loadSendContextForBranch({ ...input, authority }),
      input.signal ? { signal: input.signal } : {},
    )
  }
  throwIfSendContextAborted(input.signal)
  return loadSendContextForBranchSnapshot(input)
}

async function loadSendContextForBranchSnapshot(
  input: SendContextInput,
): Promise<SendContextSnapshot> {
  throwIfSendContextAborted(input.signal)
  const settings = input.settings ?? input.chat.settings
  const pendingMessages = input.pendingMessages ?? EMPTY_PENDING
  const providerCap =
    input.capabilities?.maxPromptTokens ?? input.capabilities?.contextLength ?? null
  if (!canUseTailLoader(settings, providerCap, input.branchHeaders, pendingMessages)) {
    return loadFullContext(input, true)
  }

  const branchHeaders = input.branchHeaders
  const items = buildContextItems(branchHeaders, pendingMessages, input.knownMessages)
  const excludedMessageIds = new Set(input.excludedMessageIds ?? [])
  const visible = items.filter(
    (item) => !item.deleted && item.hiddenFromContext !== true && !excludedMessageIds.has(item.id),
  )
  const rewritePlan = planOutboundContextRewrites(visible, settings, input.prefillReasoningTargetId)
  const rewriteCarryForwardByMessageId = new Map<MessageId, SealedReasoningCarryForward>()
  const planningInput: SendContextInput = {
    ...input,
    branchHeaders,
    rewritePlan,
    rewriteCarryForwardByMessageId,
  }
  const attachmentRefsByMessageId = resolveAttachmentContextRefs({
    messages: visible.map(contextMessageForRefs),
    policy: attachmentContextPolicyForSettings(settings),
  })
  const attachmentIds = attachmentIdsFromRefs(attachmentRefsByMessageId)
  const attachmentEvidence = createLazyAttachmentEvidence(
    attachmentRefsByMessageId,
    input.authority,
    input.signal,
    input.planningResources,
  )
  const [globalCalibration, calibrationMode] = input.calibrationEvidence
    ? [input.calibrationEvidence.global, input.calibrationEvidence.mode]
    : input.planningResources
      ? [input.planningResources.globalCalibration(), input.planningResources.calibrationMode()]
      : await Promise.all([
          readTokenCalibrationGlobal(input.authority),
          readGlobalPreferences(input.authority).then(
            (preferences) => preferences.tokenCalibrationMode,
          ),
        ])
  throwIfSendContextAborted(input.signal)
  const tokenizer = tokenizerFromSettings(settings, null)
  const reasoningCompiler = createOutboundReasoningCompiler(
    outboundReasoningRouteForAssistantRoute(input.routing),
  )
  const disableTextCalibration = attachmentIds.length > 0
  const currentTextCharsPerToken =
    settings.model && !disableTextCalibration
      ? charsPerToken(settings.model, input.chat, globalCalibration, calibrationMode)
      : undefined
  const reasoningOpts: PromptEstimateOptions = {
    family: tokenizer,
    reasoningResolver: reasoningCompiler,
    providerOutput: input.routing.providerOutput,
    includeToolCalls: settings.toolCallContext.include,
  }
  const costOpts: MessageCostOptions = {
    family: tokenizer,
    reasoningOpts,
    currentModelId: settings.model,
    attachmentRefsByMessageId,
    attachmentResolver: attachmentEvidence.resolver,
  }
  if (currentTextCharsPerToken !== undefined) {
    costOpts.currentTextCharsPerToken = currentTextCharsPerToken
  }
  if (disableTextCalibration) costOpts.disableTextCalibration = true

  const itemGroups = groupUserAnchoredContextItems(visible)
  const grouped = {
    preamble: { items: [...itemGroups.preamble] } as SendContextBucket,
    pairs: itemGroups.pairs.map((items): SendContextBucket => ({ items: [...items] })),
  }
  const cutoff = resolveCutoff(settings, providerCap)
  const systemTokens =
    settings.systemPrompt.length > 0 ? estimateTokens(settings.systemPrompt, tokenizer) : 0
  const reserveRaw = settings.maxCompletionTokens
  const reserveTokens = reserveRaw === UNLIMITED_CONTEXT ? 0 : Math.max(0, reserveRaw ?? 0)

  const loadedIds: MessageId[] = []
  const preamble = await loadBucketMessages(grouped.preamble, planningInput, loadedIds)
  await attachmentEvidence.ensureForMessages(preamble)
  const preambleTokens = bucketTokens(preamble, costOpts)
  const available = cutoff - systemTokens - preambleTokens - reserveTokens
  const totalPairs = grouped.pairs.length
  const pairMessageLoader = createBucketMessageLoader(grouped.pairs, planningInput, loadedIds)
  const pairMessages = new Map<number, Message[]>()
  const selection = await selectContextPairsLazily({
    pairCount: totalPairs,
    keepFirstPairs: settings.contextStrategy.keepFirstPairs ?? 0,
    requiredTailPairs: totalPairs > 0 ? 1 : 0,
    availableTokens: available,
    pairCost: async ({ pairIndex, direction }) => {
      const loaded = await loadPair({
        bucketIndex: pairIndex,
        buckets: grouped.pairs,
        direction,
        loadMessages: pairMessageLoader,
        input: planningInput,
        costOpts,
        ensureAttachmentEvidence: attachmentEvidence.ensureForMessages,
      })
      pairMessages.set(pairIndex, loaded.messages)
      return loaded.tokens
    },
  })

  const pathMessages: Message[] = [...preamble]
  for (let i = 0; i < selection.headPairCount; i += 1) {
    pathMessages.push(...(pairMessages.get(i) ?? []))
  }
  for (let i = selection.tailStart; i < totalPairs; i += 1) {
    pathMessages.push(...(pairMessages.get(i) ?? []))
  }
  const selectedAttachmentIds = attachmentIdsForMessages(pathMessages, attachmentRefsByMessageId)
  const selectedIds = new Set(pathMessages.map((message) => message.id))

  return {
    pathMessages,
    reasoningResolver: reasoningCompiler.retain(pathMessages),
    reasoningCarryForwardByMessageId: new Map(
      [...rewriteCarryForwardByMessageId].filter(([messageId]) => selectedIds.has(messageId)),
    ),
    loadedBodyIds: [...new Set(loadedIds)],
    usedFullBranch: false,
    preCutAttachmentIds: selectedAttachmentIds,
    attachmentTokenEvidence: attachmentEvidence.evidence(),
    ...(input.includeCalibrationEvidence
      ? { calibrationEvidence: { global: globalCalibration, mode: calibrationMode } }
      : {}),
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
  const settings = input.settings ?? input.chat.settings
  const excludedMessageIds = new Set(input.excludedMessageIds ?? [])
  const includedHeaders = input.branchHeaders.filter((header) => !excludedMessageIds.has(header.id))
  const messages = await hydrateHeadersWithKnown(
    includedHeaders,
    input.knownMessages,
    input.authority,
    input.signal,
    input.promptMaterial,
  )
  throwIfSendContextAborted(input.signal)
  const pending = (input.pendingMessages ?? EMPTY_PENDING)
    .filter((message) => !excludedMessageIds.has(message.id))
    .map((message) => structuredClone(message))
  const projection = projectOutboundContextRewrites(
    [...messages, ...pending],
    settings,
    input.prefillReasoningTargetId,
  )
  const pathMessages = projection.messages
  const reasoningCompiler = createOutboundReasoningCompiler(
    outboundReasoningRouteForAssistantRoute(input.routing),
  )
  const attachmentIds = attachmentContextIdsForMessages(pathMessages, settings)
  const attachmentTokenEvidence =
    attachmentIds.length > 0
      ? await loadAttachmentTokenEvidence(
          attachmentIds,
          input.authority,
          input.signal,
          input.planningResources,
        )
      : []
  const calibrationEvidence = input.includeCalibrationEvidence
    ? await loadCalibrationEvidence(input)
    : undefined
  return {
    pathMessages,
    reasoningResolver: reasoningCompiler.retain(pathMessages),
    reasoningCarryForwardByMessageId: projection.reasoningCarryForwardByMessageId,
    loadedBodyIds: unknownHeaderIds(includedHeaders, input.knownMessages),
    usedFullBranch,
    preCutAttachmentIds: [],
    attachmentTokenEvidence,
    ...(calibrationEvidence ? { calibrationEvidence } : {}),
  }
}

async function loadCalibrationEvidence(input: SendContextInput): Promise<{
  global: GlobalTokenCalibration
  mode: CalibrationMode
}> {
  if (input.calibrationEvidence) return input.calibrationEvidence
  if (input.planningResources) {
    return {
      global: input.planningResources.globalCalibration(),
      mode: input.planningResources.calibrationMode(),
    }
  }
  const [global, preferences] = await Promise.all([
    readTokenCalibrationGlobal(input.authority),
    readGlobalPreferences(input.authority),
  ])
  return { global, mode: preferences.tokenCalibrationMode }
}

function buildContextItems(
  branchHeaders: readonly MessageHeaderRow[],
  pendingMessages: readonly Message[],
  knownMessages: readonly Message[] = EMPTY_PENDING,
): SendContextItem[] {
  const knownById = knownMessagesById(branchHeaders, knownMessages)
  return [
    ...branchHeaders.map((header) => {
      const message = knownById.get(header.id)
      return {
        id: header.id,
        role: header.role,
        origin: header.origin,
        hiddenFromContext: header.hiddenFromContext,
        deleted: header.deleted,
        header,
        ...(message ? { message } : {}),
      }
    }),
    ...pendingMessages.map((message) => ({
      id: message.id,
      role: message.role,
      origin: message.origin,
      hiddenFromContext: message.hiddenFromContext,
      deleted: message.deleted,
      message,
    })),
  ]
}

async function loadPair(input: {
  bucketIndex: number
  buckets: readonly SendContextBucket[]
  direction: 'forward' | 'backward'
  loadMessages: (bucketIndex: number, direction: 'forward' | 'backward') => Promise<Message[]>
  input: SendContextInput
  costOpts: MessageCostOptions
  ensureAttachmentEvidence: (messages: readonly Message[]) => Promise<void>
}): Promise<{ messages: Message[]; tokens: number }> {
  throwIfSendContextAborted(input.input.signal)
  if (!input.buckets[input.bucketIndex]) return { messages: [], tokens: 0 }
  const messages = await input.loadMessages(input.bucketIndex, input.direction)
  throwIfSendContextAborted(input.input.signal)
  await input.ensureAttachmentEvidence(messages)
  throwIfSendContextAborted(input.input.signal)
  return { messages, tokens: bucketTokens(messages, input.costOpts) }
}

function createBucketMessageLoader(
  buckets: readonly SendContextBucket[],
  input: SendContextInput,
  loadedIds: MessageId[],
): (bucketIndex: number, direction: 'forward' | 'backward') => Promise<Message[]> {
  return async (bucketIndex, direction) => {
    throwIfSendContextAborted(input.signal)
    const requested = buckets[bucketIndex]
    if (!requested) return []
    if (requested.messages) return requested.messages

    const page: SendContextBucket[] = []
    let rowCount = 0
    let textChars = 0
    for (let offset = 0; offset < buckets.length; offset += 1) {
      const index = direction === 'forward' ? bucketIndex + offset : bucketIndex - offset
      const bucket = buckets[index]
      if (!bucket || bucket.messages) break
      const headers = historicalHeaders(bucket)
      const nextRows = rowCount + headers.length
      const nextTextChars =
        textChars + headers.reduce((sum, header) => sum + header.bodyTextCharCount, 0)
      if (
        page.length > 0 &&
        (nextRows > GENERATION_MATERIAL_PAGE_ROWS ||
          nextTextChars > GENERATION_MATERIAL_PAGE_TEXT_CHARS)
      ) {
        break
      }
      page.push(bucket)
      rowCount = nextRows
      textChars = nextTextChars
      if (page.length >= GENERATION_MATERIAL_PAGE_ROWS) break
    }
    await loadBucketMessagePage(page, input, loadedIds)
    return hydratedBucketMessages(requested)
  }
}

function hydratedBucketMessages(bucket: SendContextBucket): Message[] {
  if (!bucket.messages) throw new Error('SendContextBucketHydrationMissing')
  return bucket.messages
}

function historicalHeaders(bucket: SendContextBucket): MessageHeaderRow[] {
  return bucket.items
    .filter((item) => item.header && !item.message)
    .map((item) => item.header as MessageHeaderRow)
}

async function loadBucketMessagePage(
  buckets: readonly SendContextBucket[],
  input: SendContextInput,
  loadedIds: MessageId[],
): Promise<void> {
  const historical = buckets.flatMap(historicalHeaders)
  const hydrated =
    historical.length > 0
      ? await hydrateHeaders(historical, input.authority, input.signal, input.promptMaterial)
      : []
  loadedIds.push(...historical.map((header) => header.id))
  const byId = new Map(hydrated.map((message) => [message.id, message]))
  for (const bucket of buckets) {
    bucket.messages = bucket.items.map((item) => {
      if (item.message) return rewriteHydratedMessage(structuredClone(item.message), input)
      const message = byId.get(item.id)
      if (!message) throw new Error(`MessageBodyMissing:${item.id}`)
      return rewriteHydratedMessage(message, input)
    })
  }
}

async function loadBucketMessages(
  bucket: SendContextBucket,
  input: SendContextInput,
  loadedIds: MessageId[],
): Promise<Message[]> {
  throwIfSendContextAborted(input.signal)
  if (bucket.messages) return bucket.messages
  const historical = historicalHeaders(bucket)
  const hydrated =
    historical.length > 0
      ? await hydrateHeaders(historical, input.authority, input.signal, input.promptMaterial)
      : []
  loadedIds.push(...historical.map((header) => header.id))
  const byId = new Map(hydrated.map((message) => [message.id, message]))
  const messages = bucket.items.map((item) => {
    if (item.message) return rewriteHydratedMessage(structuredClone(item.message), input)
    const message = byId.get(item.id)
    if (!message) throw new Error(`MessageBodyMissing:${item.id}`)
    return rewriteHydratedMessage(message, input)
  })
  bucket.messages = messages
  return messages
}

function rewriteHydratedMessage(message: Message, input: SendContextInput): Message {
  if (!input.rewritePlan) return message
  const rewritten = applyOutboundContextRewrite(message, input.rewritePlan)
  if (rewritten.reasoningCarryForward) {
    input.rewriteCarryForwardByMessageId?.set(message.id, rewritten.reasoningCarryForward)
  }
  return rewritten.message
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

function attachmentIdsForMessages(
  messages: readonly Pick<Message, 'id'>[],
  refsByMessageId: ReadonlyMap<string, readonly { attachmentId: AttachmentId }[]>,
): AttachmentId[] {
  const ids = new Set<AttachmentId>()
  for (const message of messages) {
    for (const ref of refsByMessageId.get(message.id) ?? []) ids.add(ref.attachmentId)
  }
  return [...ids]
}

function createLazyAttachmentEvidence(
  refsByMessageId: ReadonlyMap<string, readonly { attachmentId: AttachmentId }[]>,
  authority: WorkspaceReadAuthority | undefined,
  signal?: AbortSignal,
  planningResources?: AssistantPlanningResources,
): {
  resolver: AttachmentResolver
  readonly ensureForMessages: (messages: readonly Message[]) => Promise<void>
  readonly evidence: () => Attachment[]
} {
  const evidenceById = new Map<AttachmentId, Attachment>()
  const readIds = new Set<AttachmentId>()
  return {
    resolver: (id) => evidenceById.get(id),
    ensureForMessages: async (messages) => {
      throwIfSendContextAborted(signal)
      const ids = attachmentIdsForMessages(messages, refsByMessageId).filter(
        (id) => !readIds.has(id),
      )
      if (ids.length === 0) return
      for (const id of ids) readIds.add(id)
      const rows = await loadAttachmentTokenEvidence(ids, authority, signal, planningResources)
      for (const row of rows) evidenceById.set(row.id, row)
      throwIfSendContextAborted(signal)
    },
    evidence: () => [...evidenceById.values()],
  }
}

function attachmentContextIdsForMessages(
  messages: readonly Message[],
  settings: ChatSettings,
): AttachmentId[] {
  return attachmentIdsFromRefs(
    resolveAttachmentContextRefs({
      messages,
      policy: attachmentContextPolicyForSettings(settings),
    }),
  )
}

async function loadAttachmentTokenEvidence(
  ids: readonly AttachmentId[],
  authority: WorkspaceReadAuthority | undefined,
  signal?: AbortSignal,
  planningResources?: AssistantPlanningResources,
): Promise<Attachment[]> {
  if (!authority) throw new Error('SendContextAuthorityMissing')
  throwIfSendContextAborted(signal)
  const repository = getWorkspaceRepository()
  const rows = planningResources
    ? await Promise.all(ids.map((id) => planningResources.getAttachment(id)))
    : (
        await repository.query(
          authority,
          { kind: 'attachment.get-many', attachmentIds: ids },
          signal ? { signal } : {},
        )
      ).value
  throwIfSendContextAborted(signal)
  return rows.flatMap((row) => (row ? [attachmentTokenEvidenceFrom(row)] : []))
}

function attachmentTokenEvidenceFrom(row: Attachment): Attachment {
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    filename: row.filename,
    origin: row.origin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    storage: structuredClone(row.storage),
    artifacts: [],
    processing: [],
    refCount: row.refCount,
    ...(row.sizeBytes === undefined ? {} : { sizeBytes: row.sizeBytes }),
    ...(row.dimensions === undefined ? {} : { dimensions: { ...row.dimensions } }),
    ...(row.pageCount === undefined ? {} : { pageCount: row.pageCount }),
  }
}

async function hydrateHeaders(
  headers: readonly MessageHeaderRow[],
  authority?: WorkspaceReadAuthority,
  signal?: AbortSignal,
  promptMaterial?: GenerationPromptMaterialLease,
): Promise<Message[]> {
  if (headers.length === 0) return []
  if (!authority) throw new Error('SendContextAuthorityMissing')
  throwIfSendContextAborted(signal)
  const snapshots = promptMaterial?.covers(authority, headers)
    ? await promptMaterial.read(
        authority,
        headers,
        async (page, sharedSignal) => ({
          workspaceId: authority.workspaceId,
          replacementEpoch: authority.replacementEpoch,
          material: await loadMessagePresentations(page, authority, sharedSignal),
        }),
        signal,
      )
    : await loadMessagePresentations(headers, authority, signal)
  throwIfSendContextAborted(signal)
  const messages = snapshots.map((snapshot, index) => {
    if (!snapshot) throw new Error(`MessageBodyMissing:${headers[index]?.id}`)
    return snapshot.message
  })
  return messages
}

async function loadMessagePresentations(
  headers: readonly MessageHeaderRow[],
  authority: WorkspaceReadAuthority,
  signal?: AbortSignal,
): Promise<readonly (MessagePresentation | undefined)[]> {
  const presentations: Array<MessagePresentation | undefined> = []
  for (const page of generationMaterialPages(headers)) {
    throwIfSendContextAborted(signal)
    const rows = (
      await getWorkspaceRepository().query(
        authority,
        { kind: 'message.presentations', messageIds: page.map((header) => header.id) },
        signal ? { signal } : {},
      )
    ).value
    presentations.push(...rows)
  }
  return Object.freeze(presentations)
}

async function hydrateHeadersWithKnown(
  headers: readonly MessageHeaderRow[],
  knownMessages: readonly Message[] | undefined,
  authority?: WorkspaceReadAuthority,
  signal?: AbortSignal,
  promptMaterial?: GenerationPromptMaterialLease,
): Promise<Message[]> {
  const knownById = knownMessagesById(headers, knownMessages)
  const unknownHeaders = headers.filter((header) => !knownById.has(header.id))
  const hydrated = await hydrateHeaders(unknownHeaders, authority, signal, promptMaterial)
  const hydratedById = new Map(hydrated.map((message) => [message.id, message] as const))
  return headers.map((header) => {
    const message = knownById.get(header.id) ?? hydratedById.get(header.id)
    if (!message) throw new Error(`MessageBodyMissing:${header.id}`)
    return message
  })
}

function knownMessagesById(
  headers: readonly MessageHeaderRow[],
  knownMessages: readonly Message[] | undefined,
): Map<MessageId, Message> {
  if (!knownMessages || knownMessages.length === 0) return new Map()
  const headerById = new Map(headers.map((header) => [header.id, header] as const))
  const knownById = new Map<MessageId, Message>()
  for (const known of knownMessages) {
    const header = headerById.get(known.id)
    if (!header) continue
    const rebased = rebaseHydratedMessageHeader(structuredClone(known), header)
    knownById.set(known.id, rebased)
  }
  return knownById
}

function unknownHeaderIds(
  headers: readonly MessageHeaderRow[],
  knownMessages: readonly Message[] | undefined,
): MessageId[] {
  if (!knownMessages || knownMessages.length === 0) return headers.map((header) => header.id)
  const knownIds = new Set(knownMessages.map((message) => message.id))
  return headers.flatMap((header) => (knownIds.has(header.id) ? [] : [header.id]))
}

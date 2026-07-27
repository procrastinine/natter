import { findLastUpdatedLeafId } from '../core/active-path'
import {
  normalizeContentAnnotations,
  normalizeMessageContentAnnotations,
} from '../core/content-annotations'
import { retainReachableIncomingAttachments } from '../core/import-export/attachment-reachability'
import {
  assertCurrentPortableChatRows,
  assertCurrentWorkspaceBackupRows,
} from '../core/import-export/row-validation'
import {
  assertNatterExportEnvelope,
  type NatterExportEnvelope,
  type WorkspaceBackupPayload,
  workspaceBackupManifest,
} from '../core/import-export/schema'
import { validateWorkspaceBackupManifest } from '../core/import-export/workspace-validation'
import { isPersistedReasoningCarryForward } from '../core/reasoning'
import {
  LEGACY_SAVED_TEXT_TEMPLATES_KEY,
  savedTextTemplatesFromStoredValue,
  savedTextTemplatesStoredValueIsCanonical,
} from '../core/text-templates'
import type {
  Chat,
  ContentAnnotation,
  ContinuationAttempt,
  ContinuationAttemptApplication,
  ContinuationAttemptDraft,
  GenerationMeta,
  Message,
} from '../core/types'
import { chatPreviewProjectionBackfillMarker } from './chat-preview-projection'
import {
  normalizeContinuationAttemptOutcome,
  normalizeGenerationMetaOutcome,
} from './generation-attempt-outcomes'
import { canonicalizeRecentModelSettingsRows } from './global-settings'
import {
  type LegacyGenerationServerToolCall,
  mergeLegacyProviderOutputItems,
  providerOutputItemsFromLegacyServerTools,
} from './provider-output-items'
import {
  normalizeContinuationAttemptContractV92,
  normalizeGenerationReasoningContractV92,
  normalizeReasoningAttemptFieldsV92,
  type ReasoningAttemptV92Context,
} from './reasoning-contract-normalizer-v92'
import { LEGACY_STORAGE_COMPACTION_STATE_KEY } from './storage-compaction-control'

export function migrateNatterExportEnvelope(value: unknown): NatterExportEnvelope {
  const repairedValue = repairWorkspaceChatStructuralVersions(
    repairPartialWorkspaceBackup(migrateLegacyExportVersion(value)),
  )
  assertNatterExportEnvelope(repairedValue)
  if (repairedValue.objectKind === 'workspace-backup') {
    validateWorkspaceBackupManifest(repairedValue.payload)
  }
  let envelope: NatterExportEnvelope = repairedValue
  if (repairedValue.objectKind === 'chat') {
    const context = reasoningContextForProfile(repairedValue.payload.connectionSketch)
    const messages = mapChanged(repairedValue.payload.messages, (message) =>
      normalizeImportedMessageOutcomes(message, context),
    )
    const attachments = retainReachableIncomingAttachments(repairedValue.payload.attachments, {
      messages,
    })
    const chatEnvelope =
      messages === repairedValue.payload.messages &&
      attachments === repairedValue.payload.attachments
        ? repairedValue
        : { ...repairedValue, payload: { ...repairedValue.payload, messages, attachments } }
    envelope = chatEnvelope
  }
  if (repairedValue.objectKind === 'workspace-backup') {
    const contextByChatId = workspaceReasoningContexts(repairedValue.payload)
    const messages = mapChanged(repairedValue.payload.messages, (message) =>
      normalizeImportedMessageOutcomes(message, contextByChatId.get(message.chatId)),
    )
    const chats = normalizeWorkspaceChatLeaves(repairedValue.payload.chats, messages)
    const attachments = retainReachableIncomingAttachments(repairedValue.payload.attachments, {
      messages,
      drafts: repairedValue.payload.drafts,
    })
    const marker = chatPreviewProjectionBackfillMarker()
    let settings = canonicalizeLegacySavedTextTemplateSetting(repairedValue.payload.settings)
    settings = canonicalizeRecentModelSettingsRows(settings)
    settings = discardLegacyStorageCompactionSetting(settings)
    const markerIndex = settings.findIndex((row) => row.key === marker.key)
    if (markerIndex === -1) settings = [...settings, marker]
    else if (settings[markerIndex]?.value !== marker.value) {
      settings = [...settings]
      settings[markerIndex] = marker
    }
    const changed =
      messages !== repairedValue.payload.messages ||
      chats !== repairedValue.payload.chats ||
      attachments !== repairedValue.payload.attachments ||
      settings !== repairedValue.payload.settings
    const payload = changed
      ? refreshedWorkspaceManifest({
          ...repairedValue.payload,
          chats,
          messages,
          attachments,
          settings,
        })
      : repairedValue.payload
    if (changed) {
      envelope = {
        ...repairedValue,
        payload,
      }
    }
    validateWorkspaceBackupManifest(payload)
  }
  if (envelope.objectKind === 'chat') {
    assertCurrentPortableChatRows(envelope.payload as unknown as Record<string, unknown>)
  }
  if (envelope.objectKind === 'workspace-backup') {
    assertCurrentWorkspaceBackupRows(envelope.payload as unknown as Record<string, unknown>)
  }
  return envelope
}

function repairWorkspaceChatStructuralVersions(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.objectKind !== 'workspace-backup' ||
    !isRecord(value.payload) ||
    !Array.isArray(value.payload.chats)
  ) {
    return value
  }
  const state = { changed: false }
  const candidates = value.payload.chats as readonly unknown[]
  const chats = candidates.map((candidate: unknown): unknown => {
    if (!isRecord(candidate) || candidate.structuralVersion !== undefined) return candidate
    state.changed = true
    return { ...candidate, structuralVersion: 0 }
  })
  return state.changed ? { ...value, payload: { ...value.payload, chats } } : value
}

function migrateLegacyExportVersion(value: unknown): unknown {
  if (!isRecord(value) || (value.exportSchemaVersion !== 1 && value.exportSchemaVersion !== 2)) {
    return value
  }
  const legacy = value.exportSchemaVersion === 1
  let payload = value.payload
  if (
    value.objectKind === 'workspace-backup' &&
    isRecord(payload) &&
    Array.isArray(payload.presets)
  ) {
    const presets = canonicalWorkspacePresetRows(payload.presets, legacy)
    if (presets !== payload.presets) payload = { ...payload, presets }
  }
  if (!legacy && payload === value.payload) return value
  return {
    ...value,
    exportSchemaVersion: 2,
    payload,
  }
}

function canonicalWorkspacePresetRows(
  rows: readonly unknown[],
  legacyOrder: boolean,
): readonly unknown[] {
  if (!legacyOrder && rows.every((value) => !isRecord(value) || !('sortIndex' in value))) {
    return rows
  }
  const normalized = rows.map((value, sourceIndex) => {
    if (!isRecord(value))
      return { value, sourceIndex, active: false, rank: 0, createdAt: 0, id: '' }
    const { sortIndex, ...preset } = value
    return {
      value: preset,
      sourceIndex,
      active: value.archived !== true,
      rank: typeof sortIndex === 'number' && Number.isFinite(sortIndex) ? sortIndex : sourceIndex,
      createdAt:
        typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
          ? value.createdAt
          : sourceIndex,
      id: typeof value.id === 'string' ? value.id : '',
    }
  })
  if (legacyOrder) {
    normalized.sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1
      if (!left.active)
        return left.id.localeCompare(right.id) || left.sourceIndex - right.sourceIndex
      return (
        left.rank - right.rank ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id) ||
        left.sourceIndex - right.sourceIndex
      )
    })
  }
  return normalized.map((row) => row.value)
}

function canonicalizeLegacySavedTextTemplateSetting<
  Row extends { readonly key: string; readonly value: unknown },
>(rows: Row[]): Row[] {
  const index = rows.findIndex((row) => row.key === LEGACY_SAVED_TEXT_TEMPLATES_KEY)
  if (index === -1) return rows
  const templates = savedTextTemplatesFromStoredValue(rows[index]?.value)
  if (templates.length === 0) return rows.filter((_, position) => position !== index)
  if (savedTextTemplatesStoredValueIsCanonical(rows[index]?.value, templates)) return rows
  const next = [...rows]
  next[index] = { ...rows[index], value: templates } as Row
  return next
}

function discardLegacyStorageCompactionSetting<
  Row extends { readonly key: string; readonly value: unknown },
>(rows: Row[]): Row[] {
  const index = rows.findIndex((row) => row.key === LEGACY_STORAGE_COMPACTION_STATE_KEY)
  return index === -1 ? rows : rows.filter((_, position) => position !== index)
}

function refreshedWorkspaceManifest(payload: WorkspaceBackupPayload): WorkspaceBackupPayload {
  if (!payload.manifest) return payload
  return { ...payload, manifest: workspaceBackupManifest(payload) }
}

function repairPartialWorkspaceBackup(value: unknown): unknown {
  if (!isRecord(value) || value.objectKind !== 'workspace-backup' || !isRecord(value.payload)) {
    return value
  }
  const payload = value.payload
  let messages = payload.messages
  if (messages === undefined && Array.isArray(payload.chats) && payload.chats.length === 0) {
    messages = []
  }
  const childLists = payload.childLists === undefined ? [] : payload.childLists
  const chatBranchCache = payload.chatBranchCache === undefined ? [] : payload.chatBranchCache
  if (
    messages === payload.messages &&
    childLists === payload.childLists &&
    chatBranchCache === payload.chatBranchCache
  ) {
    return value
  }
  return {
    ...value,
    payload: {
      ...payload,
      messages,
      childLists,
      chatBranchCache,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeImportedMessageOutcomes(
  input: Message,
  context: ReasoningAttemptV92Context = {},
): Message {
  const normalizedGeneration = input.generation
    ? normalizeImportedGeneration(input.generation)
    : undefined
  const content = normalizeMessageContentAnnotations(
    input.content,
    annotationSourceForApi(normalizedGeneration?.apiUsed),
  )
  const continuationAttempts = input.continuationAttempts
    ? mapChanged(input.continuationAttempts, (attempt) =>
        normalizeImportedContinuationAttempt(attempt, context),
      )
    : undefined
  const preliminary =
    normalizedGeneration === input.generation && continuationAttempts === input.continuationAttempts
      ? input
      : {
          ...input,
          ...(normalizedGeneration ? { generation: normalizedGeneration } : {}),
          ...(continuationAttempts ? { continuationAttempts } : {}),
        }
  const carrier = normalizeReasoningAttemptFieldsV92(
    preliminary,
    normalizedGeneration,
    reasoningContextForAttempt(context, normalizedGeneration?.apiUsed),
  )
  const providerOutputItems = canonicalImportedProviderOutputItems(carrier)
  const generation = stripImportedServerToolOutputs(normalizedGeneration)
  if (
    content === input.content &&
    generation === input.generation &&
    continuationAttempts === input.continuationAttempts &&
    carrier === input &&
    providerOutputItems === carrier.providerOutputItems
  ) {
    return input
  }
  const message: Message = carrier
  if (content !== input.content) message.content = content
  if (generation !== undefined) message.generation = generation
  if (continuationAttempts !== undefined) message.continuationAttempts = continuationAttempts
  if (providerOutputItems !== undefined) message.providerOutputItems = providerOutputItems
  return message
}

function stripImportedServerToolOutputs(
  generation: GenerationMeta | undefined,
): GenerationMeta | undefined {
  const tools = generation?.serverTools as LegacyGenerationServerToolCall[] | undefined
  if (!tools?.some((tool) => Object.hasOwn(tool, 'output'))) return generation
  const next = structuredClone(generation as GenerationMeta)
  for (const tool of next.serverTools as LegacyGenerationServerToolCall[]) delete tool.output
  return next
}

function normalizeImportedGeneration(input: GenerationMeta): GenerationMeta {
  const transport = normalizeImportedGenerationTransport(input)
  const outcome = normalizeGenerationMetaOutcome(transport)
  const terminal =
    outcome.status === 'preparing' || outcome.status === 'streaming'
      ? importedInterruptedGeneration(outcome)
      : outcome
  const carryForward = isPersistedReasoningCarryForward(terminal.reasoningCarryForward)
    ? terminal
    : { ...terminal, reasoningCarryForward: 'unknown' as const }
  return normalizeGenerationReasoningContractV92(carryForward)
}

const importedGenerationApis = new Set<NonNullable<GenerationMeta['apiUsed']>>([
  'chat',
  'responses',
  'gemini-native',
  'anthropic-messages',
  'completion',
  'video-generation',
])

const importedGenerationDeliveries = new Set<NonNullable<GenerationMeta['delivery']>>([
  'streaming',
  'buffered',
])

const importedGenerationCostSources = new Set<NonNullable<GenerationMeta['costSource']>>([
  'stream',
  'generation-endpoint',
  'estimated',
])

function normalizeImportedGenerationTransport(input: GenerationMeta): GenerationMeta {
  const raw = input as GenerationMeta & Record<string, unknown>
  const apiUsed = importedGenerationApi(raw.apiUsed)
  const delivery = importedGenerationDeliveries.has(
    raw.delivery as NonNullable<GenerationMeta['delivery']>,
  )
    ? (raw.delivery as NonNullable<GenerationMeta['delivery']>)
    : undefined
  const costSource = importedGenerationCostSources.has(
    raw.costSource as NonNullable<GenerationMeta['costSource']>,
  )
    ? (raw.costSource as NonNullable<GenerationMeta['costSource']>)
    : undefined
  const startedAt =
    typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt)
      ? raw.startedAt
      : typeof raw.finishedAt === 'number' && Number.isFinite(raw.finishedAt)
        ? raw.finishedAt
        : 0
  if (
    input.apiUsed === apiUsed &&
    input.delivery === delivery &&
    input.costSource === costSource &&
    input.startedAt === startedAt
  ) {
    return input
  }
  const normalized: GenerationMeta = { ...input, startedAt }
  if (typeof raw.model !== 'string' || raw.model.length === 0) delete normalized.model
  if (typeof raw.requestedModel !== 'string' || raw.requestedModel.length === 0) {
    delete normalized.requestedModel
  }
  if (apiUsed === undefined) delete normalized.apiUsed
  else normalized.apiUsed = apiUsed
  if (delivery === undefined) delete normalized.delivery
  else normalized.delivery = delivery
  if (costSource === undefined) delete normalized.costSource
  else normalized.costSource = costSource
  return normalized
}

function importedGenerationApi(value: unknown): GenerationMeta['apiUsed'] {
  if (importedGenerationApis.has(value as NonNullable<GenerationMeta['apiUsed']>)) {
    return value as NonNullable<GenerationMeta['apiUsed']>
  }
  if (
    value === 'openai-responses' ||
    value === 'openrouter-responses' ||
    value === 'responses-api'
  ) {
    return 'responses'
  }
  if (value === 'google' || value === 'gemini' || value === 'google-gemini') {
    return 'gemini-native'
  }
  if (value === 'anthropic' || value === 'claude') return 'anthropic-messages'
  if (value === 'text') return 'completion'
  if (value === 'video') return 'video-generation'
  return undefined
}

function importedInterruptedGeneration(input: GenerationMeta): GenerationMeta {
  const generation: GenerationMeta = {
    ...input,
    status: 'interrupted',
    finishedAt: input.finishedAt ?? input.startedAt,
    abortReason: 'tab-close',
  }
  delete generation.error
  return generation
}

function normalizeWorkspaceChatLeaves(
  chats: readonly Chat[],
  messages: readonly Message[],
): Chat[] {
  const messagesByChatId = new Map<string, Message[]>()
  for (const message of messages) {
    const rows = messagesByChatId.get(message.chatId)
    if (rows) rows.push(message)
    else messagesByChatId.set(message.chatId, [message])
  }
  return mapChanged(chats, (chat) => {
    const lastUpdatedLeafId = findLastUpdatedLeafId(messagesByChatId.get(chat.id) ?? [])
    return chat.lastUpdatedLeafId === lastUpdatedLeafId ? chat : { ...chat, lastUpdatedLeafId }
  })
}

function normalizeImportedContinuationAttempt(
  input: ContinuationAttempt,
  context: ReasoningAttemptV92Context,
): ContinuationAttempt {
  const outcome = normalizeContinuationAttemptOutcome(input)
  const legacyInput = input as ContinuationAttempt & {
    unappliedText?: string
    unappliedAnnotations?: ContentAnnotation[]
  }
  const normalized: ContinuationAttemptDraft &
    Record<string, unknown> & {
      application: ContinuationAttemptApplication
      unappliedText?: string
      unappliedAnnotations?: ContentAnnotation[]
    } = {
    ...outcome,
    reasoningCarryForward: isPersistedReasoningCarryForward(outcome.reasoningCarryForward)
      ? outcome.reasoningCarryForward
      : 'unknown',
  }
  const unappliedAnnotations = legacyInput.unappliedAnnotations
    ? normalizeContentAnnotations(legacyInput.unappliedAnnotations, {
        source: annotationSourceForApi(input.apiUsed),
        text: legacyInput.unappliedText ?? '',
      })
    : undefined
  if (unappliedAnnotations && unappliedAnnotations.length > 0) {
    normalized.unappliedAnnotations = unappliedAnnotations
  } else if (legacyInput.unappliedAnnotations) {
    delete normalized.unappliedAnnotations
  }
  const contracted = normalizeContinuationAttemptContractV92(
    normalized as ContinuationAttempt,
    reasoningContextForAttempt(context, input.apiUsed),
  )
  const providerOutputItems = canonicalImportedProviderOutputItems(contracted)
  if (providerOutputItems === contracted.providerOutputItems) return contracted
  const next = { ...contracted } as ContinuationAttempt & Record<string, unknown>
  if (providerOutputItems) next.providerOutputItems = providerOutputItems
  else delete next.providerOutputItems
  return next
}

function canonicalImportedProviderOutputItems(input: {
  generation?: GenerationMeta
  providerOutputItems?: Message['providerOutputItems']
  serverTools?: GenerationMeta['serverTools']
}): Message['providerOutputItems'] {
  const serverTools = input.generation?.serverTools ?? input.serverTools ?? []
  const migrated = providerOutputItemsFromLegacyServerTools(serverTools)
  return mergeLegacyProviderOutputItems(input.providerOutputItems, migrated)
}

function annotationSourceForApi(apiUsed: GenerationMeta['apiUsed'] | undefined) {
  switch (apiUsed) {
    case 'responses':
      return 'openai-responses' as const
    case 'anthropic-messages':
      return 'anthropic-messages' as const
    case 'gemini-native':
      return 'gemini-native' as const
    case 'chat':
      return 'openai-chat' as const
    case undefined:
    case 'completion':
    case 'video-generation':
      return 'imported' as const
  }
}

function workspaceReasoningContexts(
  payload: WorkspaceBackupPayload,
): ReadonlyMap<string, ReasoningAttemptV92Context> {
  const profileById = new Map(payload.profiles.map((profile) => [profile.id, profile] as const))
  return new Map(
    payload.chats.map((chat) => [
      chat.id,
      reasoningContextForProfile(profileById.get(chat.settings.profileId)),
    ]),
  )
}

function reasoningContextForProfile(
  profile: Readonly<{ kind?: unknown; baseUrl?: unknown }> | undefined,
): ReasoningAttemptV92Context {
  return profile ? { profile } : {}
}

function reasoningContextForAttempt(
  context: ReasoningAttemptV92Context,
  apiUsed: GenerationMeta['apiUsed'] | undefined,
): ReasoningAttemptV92Context {
  return apiUsed ? { ...context, apiUsed } : context
}

function mapChanged<T>(values: readonly T[], map: (value: T) => T): T[] {
  let result: T[] | undefined
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index] as T
    const next = map(current)
    if (result) result.push(next)
    else if (next !== current) result = [...values.slice(0, index), next]
  }
  return result ?? (values as T[])
}

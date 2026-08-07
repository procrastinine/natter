import type { MessageHeaderRow } from './message-storage'
import type { WorkspaceFence } from './repository'
import {
  normalizeWorkspaceDependencies,
  type WorkspaceChange,
  type WorkspaceDelta,
  type WorkspaceDeltaFact,
  type WorkspaceDependency,
} from './workspace-protocol'

const CANONICAL_WORKSPACE_CHANGE = Symbol('CanonicalWorkspaceChange')

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer'])
const MESSAGE_ORIGINS = new Set(['user', 'generated', 'imported', 'continued', 'prefill'])
const PROFILE_FACETS = new Set([
  'request-material',
  'selected-detail',
  'catalog-membership',
  'catalog-order',
  'catalog-display',
  'profile-count',
  'dependent-counts',
  'usage',
])
const PRESET_FACETS = new Set([
  'selected-detail',
  'catalog-membership',
  'catalog-order',
  'catalog-display',
  'usage',
])
const KEY_FACETS = new Set(['request-material', 'selected-detail', 'membership', 'usage'])
const ORGANIZATION_FACETS = new Set(['definition', 'membership'])
const STORAGE_MAINTENANCE_TASKS = new Set([
  'clean-replacement-database',
  'reap-attachments',
  'prune-terminal-streams',
  'prune-empty-drafts',
  'prune-discovery-cache',
  'compact-workspace',
])

export interface WorkspaceDeltaNormalForm {
  readonly messageFacts: ReadonlyMap<
    string,
    Extract<WorkspaceDeltaFact, { kind: 'message-revision' }>
  >
  readonly attemptTargetCommitFacts: ReadonlyMap<
    string,
    Extract<WorkspaceDeltaFact, { kind: 'attempt-target-committed' }>
  >
  readonly attemptStopFacts: ReadonlyMap<
    string,
    Extract<WorkspaceDeltaFact, { kind: 'attempt-stop-requested' }>
  >
  readonly createdChatIds: ReadonlySet<string>
  readonly changedSidebarIds: ReadonlySet<string>
  readonly deletedSidebarIds: ReadonlySet<string>
  readonly deletedChatIds: ReadonlySet<string>
  readonly revisedChatIds: ReadonlySet<string>
  readonly changedAttachmentIds: ReadonlySet<string>
  readonly deletedAttachmentIds: ReadonlySet<string>
}

export function canonicalizeWorkspaceChange(value: unknown): WorkspaceChange {
  if (isCanonicalWorkspaceChange(value)) return value
  const change = structuredClone(value)
  return adoptCanonicalWorkspaceChange(change as WorkspaceChange)
}

export function adoptCanonicalWorkspaceChange(change: WorkspaceChange): WorkspaceChange {
  if (isCanonicalWorkspaceChange(change)) return change
  validateWorkspaceChange(change)
  return brandAndFreezeWorkspaceChange(change)
}

export function adoptCanonicalWorkspaceCommitChange(
  change: Extract<WorkspaceChange, { kind: 'commit' }>,
): {
  readonly change: Extract<WorkspaceChange, { kind: 'commit' }>
  readonly normalForm: WorkspaceDeltaNormalForm
} {
  const normalForm = validateWorkspaceChange(change)
  if (!normalForm) throw new Error('WorkspaceCommitChangeInvalid')
  return Object.freeze({
    change: brandAndFreezeWorkspaceChange(change),
    normalForm,
  })
}

function brandAndFreezeWorkspaceChange<T extends WorkspaceChange>(change: T): T {
  Object.defineProperty(change, CANONICAL_WORKSPACE_CHANGE, { value: true })
  freezeWorkspaceBoundaryValue(change)
  return change
}

export function workspaceFenceFromUnknownChange(value: unknown): WorkspaceFence | null {
  if (!isRecord(value)) return null
  const fence = value.kind === 'commit' ? value.stamp : value
  if (!isRecord(fence)) return null
  return validFence(fence)
    ? { workspaceId: fence.workspaceId, replacementEpoch: fence.replacementEpoch }
    : null
}

export function freezeWorkspaceBoundaryValue(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== 'undefined' && value instanceof Blob)
  ) {
    return
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (Array.isArray(value) || prototype === Object.prototype || prototype === null) {
    for (const child of Object.values(value)) freezeWorkspaceBoundaryValue(child, seen)
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
}

export function validateWorkspaceDeltaNormalForm(delta: WorkspaceDelta): WorkspaceDeltaNormalForm {
  const messageFacts = new Map<string, Extract<WorkspaceDeltaFact, { kind: 'message-revision' }>>()
  const attemptTargetCommitFacts = new Map<
    string,
    Extract<WorkspaceDeltaFact, { kind: 'attempt-target-committed' }>
  >()
  const attemptStopFacts = new Map<
    string,
    Extract<WorkspaceDeltaFact, { kind: 'attempt-stop-requested' }>
  >()
  const createdChatIds = new Set<string>()
  const changedSidebarIds = new Set<string>()
  const deletedSidebarIds = new Set<string>()
  const deletedChatIds = new Set<string>()
  const revisedChatIds = new Set<string>()
  const changedAttachmentIds = new Set<string>()
  const deletedAttachmentIds = new Set<string>()

  for (const fact of delta.facts) {
    switch (fact.kind) {
      case 'message-revision':
        if (fact.header.chatId !== fact.chatId) {
          throw new Error(`WorkspaceDeltaMessageOwnerMismatch:${fact.header.id}`)
        }
        addUnique(messageFacts, fact.header.id, fact, 'WorkspaceDeltaMessageFactDuplicate')
        revisedChatIds.add(fact.chatId)
        break
      case 'attempt-target-committed':
        addUnique(
          attemptTargetCommitFacts,
          fact.streamId,
          fact,
          'WorkspaceDeltaAttemptTargetCommitFactDuplicate',
        )
        break
      case 'attempt-stop-requested':
        addUnique(attemptStopFacts, fact.streamId, fact, 'WorkspaceDeltaAttemptStopFactDuplicate')
        break
      case 'conversation-created':
        addUniqueSet(createdChatIds, fact.chatId, 'WorkspaceDeltaConversationFactDuplicate')
        break
      case 'sidebar-row-changed':
        addUniqueSet(changedSidebarIds, fact.chatId, 'WorkspaceDeltaSidebarFactDuplicate')
        break
      case 'sidebar-row-deleted':
        addUniqueSet(deletedSidebarIds, fact.chatId, 'WorkspaceDeltaSidebarDeleteFactDuplicate')
        break
      case 'chat-deleted':
        addUniqueSet(deletedChatIds, fact.chatId, 'WorkspaceDeltaChatDeleteFactDuplicate')
        break
      case 'attachment-row-changed':
        addUniqueSet(
          changedAttachmentIds,
          fact.attachmentId,
          'WorkspaceDeltaAttachmentFactDuplicate',
        )
        break
      case 'attachment-row-deleted':
        addUniqueSet(
          deletedAttachmentIds,
          fact.attachmentId,
          'WorkspaceDeltaAttachmentDeleteFactDuplicate',
        )
        break
    }
  }

  if (!sameSet(deletedSidebarIds, deletedChatIds)) {
    throw new Error('WorkspaceDeltaChatDeleteFactsMismatch')
  }
  for (const chatId of deletedChatIds) {
    if (createdChatIds.has(chatId) || changedSidebarIds.has(chatId) || revisedChatIds.has(chatId)) {
      throw new Error(`WorkspaceDeltaChatFinalStateContradiction:${chatId}`)
    }
  }
  for (const fact of attemptTargetCommitFacts.values()) {
    if (deletedChatIds.has(fact.chatId)) {
      throw new Error(`WorkspaceDeltaAttemptTargetCommitDeletedChat:${fact.streamId}`)
    }
  }
  for (const fact of attemptStopFacts.values()) {
    if (deletedChatIds.has(fact.chatId)) {
      throw new Error(`WorkspaceDeltaAttemptStopDeletedChat:${fact.streamId}`)
    }
  }
  for (const chatId of createdChatIds) {
    if (changedSidebarIds.has(chatId)) {
      throw new Error(`WorkspaceDeltaConversationFinalStateContradiction:${chatId}`)
    }
  }
  for (const chatId of changedSidebarIds) {
    if (deletedSidebarIds.has(chatId)) {
      throw new Error(`WorkspaceDeltaChatFinalStateContradiction:${chatId}`)
    }
  }
  for (const attachmentId of changedAttachmentIds) {
    if (deletedAttachmentIds.has(attachmentId)) {
      throw new Error(`WorkspaceDeltaAttachmentFinalStateContradiction:${attachmentId}`)
    }
  }

  return {
    messageFacts,
    attemptTargetCommitFacts,
    attemptStopFacts,
    createdChatIds,
    changedSidebarIds,
    deletedSidebarIds,
    deletedChatIds,
    revisedChatIds,
    changedAttachmentIds,
    deletedAttachmentIds,
  }
}

function isCanonicalWorkspaceChange(value: unknown): value is WorkspaceChange {
  return (
    isRecord(value) && (value as Record<PropertyKey, unknown>)[CANONICAL_WORKSPACE_CHANGE] === true
  )
}

function validateWorkspaceChange(value: unknown): WorkspaceDeltaNormalForm | null {
  if (!isRecord(value)) throw new Error('WorkspaceChangeInvalid')
  if (value.kind === 'replace') {
    requireFence(value)
    return null
  }
  if (value.kind === 'invalidate') {
    requireFence(value)
    if (value.dependencies !== 'all') validateDependencies(value.dependencies)
    return null
  }
  if (value.kind !== 'commit' || !isRecord(value.stamp) || !isRecord(value.delta)) {
    throw new Error('WorkspaceChangeInvalid')
  }
  requireFence(value.stamp)
  if (value.stamp.commitId !== null && !isNonemptyString(value.stamp.commitId)) {
    throw new Error('WorkspaceChangeCommitIdInvalid')
  }
  if (!Array.isArray(value.delta.facts) || !Array.isArray(value.delta.invalidations)) {
    throw new Error('WorkspaceChangeDeltaInvalid')
  }
  for (const fact of value.delta.facts) validateFact(fact)
  validateDependencies(value.delta.invalidations)
  return validateWorkspaceDeltaNormalForm(value.delta as unknown as WorkspaceDelta)
}

function addUnique<T>(values: Map<string, T>, id: string, value: T, error: string): void {
  if (values.has(id)) throw new Error(`${error}:${id}`)
  values.set(id, value)
}

function addUniqueSet(values: Set<string>, id: string, error: string): void {
  if (values.has(id)) throw new Error(`${error}:${id}`)
  values.add(id)
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false
  for (const id of left) {
    if (!right.has(id)) return false
  }
  return true
}

function validateFact(value: unknown): asserts value is WorkspaceDeltaFact {
  if (!isRecord(value) || !isNonemptyString(value.kind)) {
    throw new Error('WorkspaceChangeFactInvalid')
  }
  switch (value.kind) {
    case 'chat-deleted':
    case 'conversation-created':
    case 'sidebar-row-changed':
    case 'sidebar-row-deleted':
      requireId(value.chatId, 'WorkspaceChangeChatFactInvalid')
      return
    case 'attachment-row-changed':
    case 'attachment-row-deleted':
      requireId(value.attachmentId, 'WorkspaceChangeAttachmentFactInvalid')
      return
    case 'attempt-target-committed':
      requireId(value.streamId, 'WorkspaceChangeAttemptTargetCommitFactInvalid')
      requireId(value.chatId, 'WorkspaceChangeAttemptTargetCommitFactInvalid')
      requireId(value.messageId, 'WorkspaceChangeAttemptTargetCommitFactInvalid')
      if (value.attemptKind !== 'generation' && value.attemptKind !== 'continuation') {
        throw new Error('WorkspaceChangeAttemptTargetCommitFactInvalid')
      }
      requireNonnegativeInteger(
        value.admissionSequence,
        'WorkspaceChangeAttemptTargetCommitFactInvalid',
      )
      requireNonnegativeInteger(
        value.leaseRevision,
        'WorkspaceChangeAttemptTargetCommitFactInvalid',
      )
      requireNonnegativeInteger(value.bodyVersion, 'WorkspaceChangeAttemptTargetCommitFactInvalid')
      return
    case 'attempt-stop-requested':
      requireId(value.streamId, 'WorkspaceChangeAttemptStopFactInvalid')
      requireId(value.chatId, 'WorkspaceChangeAttemptStopFactInvalid')
      requireId(value.messageId, 'WorkspaceChangeAttemptStopFactInvalid')
      requireId(value.requestId, 'WorkspaceChangeAttemptStopFactInvalid')
      requireId(value.requestedBy, 'WorkspaceChangeAttemptStopFactInvalid')
      if (value.attemptKind !== 'generation' && value.attemptKind !== 'continuation') {
        throw new Error('WorkspaceChangeAttemptStopFactInvalid')
      }
      requireNonnegativeInteger(value.admissionSequence, 'WorkspaceChangeAttemptStopFactInvalid')
      requireNonnegativeInteger(value.controlRevision, 'WorkspaceChangeAttemptStopFactInvalid')
      requireNonnegativeInteger(value.requestedAt, 'WorkspaceChangeAttemptStopFactInvalid')
      if (value.reason !== 'user') throw new Error('WorkspaceChangeAttemptStopFactInvalid')
      return
    case 'message-revision':
      requireId(value.chatId, 'WorkspaceChangeMessageFactInvalid')
      requireNonnegativeInteger(value.structuralVersion, 'WorkspaceChangeMessageFactInvalid')
      validateMessageHeader(value.header)
      if (
        value.header.chatId !== value.chatId ||
        !isRecord(value.changed) ||
        typeof value.changed.structure !== 'boolean' ||
        typeof value.changed.body !== 'boolean'
      ) {
        throw new Error('WorkspaceChangeMessageFactInvalid')
      }
      return
    default:
      throw new Error(`WorkspaceChangeFactUnknown:${value.kind}`)
  }
}

function validateMessageHeader(value: unknown): asserts value is MessageHeaderRow {
  if (!isRecord(value)) throw new Error('WorkspaceChangeMessageHeaderInvalid')
  requireId(value.id, 'WorkspaceChangeMessageHeaderInvalid')
  requireId(value.chatId, 'WorkspaceChangeMessageHeaderInvalid')
  if (value.parentId !== null) requireId(value.parentId, 'WorkspaceChangeMessageHeaderInvalid')
  requireId(value.turnId, 'WorkspaceChangeMessageHeaderInvalid')
  for (const field of [
    'siblingIndex',
    'turnIndex',
    'createdAt',
    'nodeVersion',
    'requestContextVersion',
    'bodyVersion',
    'bodyWordCount',
    'bodyTextCharCount',
    'bodyMediaCount',
    'bodyRenderCost',
  ] as const) {
    requireNonnegativeInteger(value[field], 'WorkspaceChangeMessageHeaderInvalid')
  }
  if (
    !MESSAGE_ROLES.has(String(value.role)) ||
    !MESSAGE_ORIGINS.has(String(value.origin)) ||
    typeof value.deleted !== 'boolean'
  ) {
    throw new Error('WorkspaceChangeMessageHeaderInvalid')
  }
}

function validateDependencies(value: unknown): asserts value is readonly WorkspaceDependency[] {
  if (!Array.isArray(value)) throw new Error('WorkspaceChangeDependenciesInvalid')
  for (const dependency of value) validateDependency(dependency)
  const normalized = normalizeWorkspaceDependencies(value)
  if (!sameWorkspaceDependencies(value, normalized)) {
    throw new Error('WorkspaceChangeDependenciesNoncanonical')
  }
}

function sameWorkspaceDependencies(
  left: readonly WorkspaceDependency[],
  right: readonly WorkspaceDependency[],
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const leftRecord = left[index] as unknown as Record<string, unknown>
    const rightRecord = right[index] as unknown as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord).sort()
    const rightKeys = Object.keys(rightRecord).sort()
    if (leftKeys.length !== rightKeys.length) return false
    for (let keyIndex = 0; keyIndex < leftKeys.length; keyIndex += 1) {
      const key = leftKeys[keyIndex] as string
      if (key !== rightKeys[keyIndex]) return false
      const leftValue = leftRecord[key]
      const rightValue = rightRecord[key]
      if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
        if (
          leftValue.length !== rightValue.length ||
          leftValue.some((value, valueIndex) => value !== rightValue[valueIndex])
        ) {
          return false
        }
      } else if (leftValue !== rightValue) {
        return false
      }
    }
  }
  return true
}

function validateDependency(value: unknown): asserts value is WorkspaceDependency {
  if (!isRecord(value) || !isNonemptyString(value.kind)) {
    throw new Error('WorkspaceChangeDependencyInvalid')
  }
  switch (value.kind) {
    case 'workspace':
      return
    case 'chat':
    case 'sidebar':
    case 'draft':
      validateOptionalIds(value.chatIds)
      return
    case 'message-header':
    case 'message-body':
    case 'message-preview':
      validateOptionalId(value.chatId)
      validateOptionalIds(value.messageIds)
      return
    case 'child-slot':
      requireId(value.chatId, 'WorkspaceChangeDependencyInvalid')
      validateOptionalNullableIds(value.parentIds)
      return
    case 'attachment':
      validateOptionalIds(value.attachmentIds)
      return
    case 'attachment-job':
      validateOptionalIds(value.attachmentIds)
      validateOptionalIds(value.jobIds)
      return
    case 'profile':
      validateOptionalIds(value.profileIds)
      validateOptionalEnumValues(value.facets, PROFILE_FACETS)
      return
    case 'preset':
    case 'prompt-preset':
      validateOptionalIds(value.presetIds)
      validateOptionalEnumValues(value.facets, PRESET_FACETS)
      return
    case 'text-template':
      validateOptionalIds(value.templateIds)
      return
    case 'folder':
      validateOptionalIds(value.folderIds)
      validateOptionalEnumValues(value.facets, ORGANIZATION_FACETS)
      return
    case 'tag':
      validateOptionalIds(value.tagIds)
      validateOptionalEnumValues(value.facets, ORGANIZATION_FACETS)
      return
    case 'key':
      validateOptionalIds(value.keyIds)
      validateOptionalEnumValues(value.facets, KEY_FACETS)
      return
    case 'setting':
      validateOptionalIds(value.keys)
      return
    case 'stream-lease':
    case 'stream-chunks':
      validateOptionalId(value.chatId)
      validateOptionalIds(value.streamIds)
      return
    case 'model-resolution':
      validateOptionalIds(value.targetKeys)
      return
    case 'discovery-cache':
      validateOptionalIds(value.cacheKinds)
      validateOptionalIds(value.profileIds)
      validateOptionalIds(value.keys)
      return
    case 'storage-maintenance':
      if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
        throw new Error('WorkspaceChangeDependencyInvalid')
      }
      validateEnumValues(value.tasks, STORAGE_MAINTENANCE_TASKS)
      return
    default:
      throw new Error(`WorkspaceChangeDependencyUnknown:${value.kind}`)
  }
}

function requireFence(value: Record<string, unknown>): void {
  if (!validFence(value)) throw new Error('WorkspaceChangeFenceInvalid')
}

function validFence(
  value: Record<string, unknown>,
): value is Record<string, unknown> & WorkspaceFence {
  return isNonemptyString(value.workspaceId) && isNonnegativeInteger(value.replacementEpoch)
}

function validateOptionalId(value: unknown): void {
  if (value !== undefined) requireId(value, 'WorkspaceChangeDependencyInvalid')
}

function validateOptionalIds(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('WorkspaceChangeDependencyInvalid')
  for (const id of value) requireId(id, 'WorkspaceChangeDependencyInvalid')
}

function validateOptionalNullableIds(value: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('WorkspaceChangeDependencyInvalid')
  for (const id of value) {
    if (id !== null) requireId(id, 'WorkspaceChangeDependencyInvalid')
  }
}

function validateOptionalEnumValues(value: unknown, allowed: ReadonlySet<string>): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error('WorkspaceChangeDependencyInvalid')
  validateEnumValues(value, allowed)
}

function validateEnumValues(value: readonly unknown[], allowed: ReadonlySet<string>): void {
  if (value.some((item) => !isNonemptyString(item) || !allowed.has(item))) {
    throw new Error('WorkspaceChangeDependencyInvalid')
  }
}

function requireId(value: unknown, error: string): asserts value is string {
  if (!isNonemptyString(value)) throw new Error(error)
}

function requireNonnegativeInteger(value: unknown, error: string): asserts value is number {
  if (!isNonnegativeInteger(value)) throw new Error(error)
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import type Dexie from 'dexie'
import type {
  DBCore,
  DBCoreKeyRange,
  DBCoreMutateRequest,
  DBCoreMutateResponse,
  DBCoreTransaction,
  Middleware,
  Transaction,
} from 'dexie'
import type { AttachmentId, Chat, ChatId, MessageId } from '../core/types'
import { sameValue } from '../lib/same-value'
import { type ConfigurationLink, configurationTargetKey } from './configuration-domain-contract'
import {
  type MessageHeaderRow,
  type MessagePresentation,
  sameMessageHeaderValue,
} from './message-storage'
import type { PhysicalStorageTableName } from './physical-storage-tables'
import { streamJournalFrameStreamId } from './repository'
import type { StorageRetentionTask } from './storage-retention-state'
import { WorkspaceLocalChildSlotAccumulator } from './workspace-local-evidence'
import type { WorkspaceDependency, WorkspaceLocalChildSlotEvidence } from './workspace-protocol'

const DBCORE_RANGE_NEVER = 4 as DBCoreKeyRange['type']
const journals = new WeakMap<DBCoreTransaction, MutableMutationJournal>()
const installedDatabases = new WeakSet<Dexie>()

interface MutableMutationJournal {
  readonly tableNames: Set<string>
  readonly physicalMutations: Map<string, BrowserCommandPhysicalMutation>
  readonly physicalOwnerScopes: Map<string, BrowserCommandPhysicalOwnerScope>
  readonly internalMutationEvidence: Set<string>
  readonly physicalMutationHints: Map<string, BrowserCommandPhysicalMutationHint>
  readonly invalidations: WorkspaceDependency[]
  readonly attachmentReferenceStates: Map<AttachmentId, MutableAttachmentReferenceStateFact>
  readonly attachmentRows: Map<AttachmentId, boolean>
  readonly messageRevisions: Map<MessageId, MutableMessageRevisionFact>
  readonly childSlots: Map<string, WorkspaceLocalChildSlotAccumulator>
  readonly chatIds: Set<ChatId>
  readonly initialChatExistsById: Map<ChatId, boolean>
  successfulMutations: number
}

interface BrowserCommandPhysicalMutationHint {
  readonly ownerScopeId?: string
  readonly chatId?: ChatId
  readonly messageId?: MessageId
  readonly attachmentId?: AttachmentId
  readonly profileId?: string
  readonly profileIds?: readonly string[]
  readonly presetIds?: readonly string[]
  readonly promptPresetIds?: readonly string[]
  readonly keyIds?: readonly string[]
  readonly templateIds?: readonly string[]
  readonly streamId?: string
  readonly mutationGroupAddress?: string
}

export interface AttachmentReferenceState {
  readonly exists: boolean
  readonly refCount: number
}

export interface AttachmentReferenceStateFact {
  readonly attachmentId: AttachmentId
  readonly initial: AttachmentReferenceState
  readonly final: AttachmentReferenceState
  readonly projectionChanged: boolean
}

interface MutableAttachmentReferenceStateFact {
  readonly attachmentId: AttachmentId
  readonly initial: AttachmentReferenceState
  final: AttachmentReferenceState
  projectionChanged: boolean
}

export interface BrowserCommandMutationFacts {
  readonly tableNames: readonly string[]
  readonly physicalMutations: readonly BrowserCommandPhysicalMutation[]
  readonly physicalOwnerScopes: readonly BrowserCommandPhysicalOwnerScope[]
  readonly internalMutationEvidence: readonly string[]
  readonly invalidations: readonly WorkspaceDependency[]
  readonly attachmentReferenceStates: readonly AttachmentReferenceStateFact[]
  readonly attachmentRows: readonly BrowserCommandAttachmentRowFact[]
  readonly messageRevisions: readonly BrowserCommandMessageRevisionFact[]
  readonly childSlots: readonly WorkspaceLocalChildSlotEvidence[]
  readonly chatStates: readonly BrowserCommandChatStateFact[]
  readonly successfulMutations: number
}

export interface BrowserCommandPhysicalMutation {
  readonly tableName: string
  readonly address: string
  readonly operation: 'write' | 'delete' | 'delete-range' | 'delete-group'
  readonly affectedRows?: number
  readonly key?: unknown
  readonly rowId?: string
  readonly ownerScopeId?: string
  readonly chatId?: ChatId
  readonly messageId?: MessageId
  readonly attachmentId?: AttachmentId
  readonly profileId?: string
  readonly profileIds?: readonly string[]
  readonly presetIds?: readonly string[]
  readonly promptPresetIds?: readonly string[]
  readonly keyIds?: readonly string[]
  readonly templateIds?: readonly string[]
  readonly streamId?: string
}

export interface BrowserCommandPhysicalOwnerScope {
  readonly id: string
  readonly kind: 'chat'
  readonly ownerIds: readonly ChatId[]
}

export interface BrowserCommandAttachmentRowFact {
  readonly attachmentId: AttachmentId
  readonly exists: boolean
}

export interface BrowserCommandMessageRevisionFact {
  readonly before?: MessageHeaderRow
  readonly header: MessageHeaderRow
  readonly structuralVersion: number
  readonly presentation?: MessagePresentation
}

interface MutableMessageRevisionFact {
  readonly before?: MessageHeaderRow
  header: MessageHeaderRow
  structuralVersion: number
  presentation?: MessagePresentation
}

export interface BrowserCommandChatStateFact {
  readonly chatId: ChatId
  readonly chat: Chat | null
  readonly initialExists: boolean
}

export interface BrowserCommandTransactionResult<T> {
  readonly value: T
  readonly facts: BrowserCommandMutationFacts
}

export function installBrowserCommandMutationJournal(db: Dexie): void {
  if (installedDatabases.has(db)) return
  db.use(browserCommandMutationMiddleware)
  installedDatabases.add(db)
}

export async function runBrowserCommandTransaction<T>(
  tx: Transaction,
  operation: (tx: Transaction) => Promise<T> | T,
): Promise<BrowserCommandTransactionResult<T>> {
  if (!installedDatabases.has(tx.db)) throw new Error('BrowserCommandMutationJournalMissing')
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  if (journals.has(transaction)) throw new Error('BrowserCommandMutationJournalAlreadyBound')
  const journal: MutableMutationJournal = {
    tableNames: new Set<string>(),
    physicalMutations: new Map(),
    physicalOwnerScopes: new Map(),
    internalMutationEvidence: new Set(),
    physicalMutationHints: new Map(),
    invalidations: [],
    attachmentReferenceStates: new Map(),
    attachmentRows: new Map(),
    messageRevisions: new Map(),
    childSlots: new Map(),
    chatIds: new Set(),
    initialChatExistsById: new Map(),
    successfulMutations: 0,
  }
  journals.set(transaction, journal)
  try {
    const value = await operation(tx)
    await recordKeyRequestMaterialDependents(tx, journal)
    const chatIds = [...journal.chatIds]
    const chatRows =
      chatIds.length === 0 ? [] : await tx.table<Chat, ChatId>('chats').bulkGet(chatIds)
    return {
      value,
      facts: Object.freeze({
        tableNames: Object.freeze([...journal.tableNames].sort()),
        physicalMutations: Object.freeze(
          [...journal.physicalMutations.values()].map((mutation) =>
            Object.freeze(structuredClone(mutation)),
          ),
        ),
        physicalOwnerScopes: Object.freeze(
          [...journal.physicalOwnerScopes.values()].map((scope) =>
            Object.freeze({ ...scope, ownerIds: Object.freeze([...scope.ownerIds]) }),
          ),
        ),
        internalMutationEvidence: Object.freeze([...journal.internalMutationEvidence]),
        invalidations: Object.freeze([...journal.invalidations]),
        attachmentReferenceStates: Object.freeze(
          [...journal.attachmentReferenceStates.values()].map((fact) =>
            Object.freeze({
              attachmentId: fact.attachmentId,
              initial: Object.freeze({ ...fact.initial }),
              final: Object.freeze({ ...fact.final }),
              projectionChanged: fact.projectionChanged,
            }),
          ),
        ),
        attachmentRows: Object.freeze(
          [...journal.attachmentRows].map(([attachmentId, exists]) =>
            Object.freeze({ attachmentId, exists }),
          ),
        ),
        messageRevisions: Object.freeze(
          [...journal.messageRevisions.values()].map((fact) =>
            Object.freeze({
              ...(fact.before ? { before: structuredClone(fact.before) } : {}),
              header: structuredClone(fact.header),
              structuralVersion: fact.structuralVersion,
              ...(fact.presentation ? { presentation: structuredClone(fact.presentation) } : {}),
            }),
          ),
        ),
        childSlots: Object.freeze(
          [...journal.childSlots.values()].flatMap((accumulator) => {
            const evidence = accumulator.materialize()
            return evidence ? [evidence] : []
          }),
        ),
        chatStates: Object.freeze(
          chatIds.map((chatId, index) => {
            const chat = chatRows[index]
            return Object.freeze({
              chatId,
              chat: chat ? structuredClone(chat) : null,
              initialExists: requiredInitialChatExistence(journal, chatId),
            })
          }),
        ),
        successfulMutations: journal.successfulMutations,
      }),
    }
  } finally {
    journals.delete(transaction)
  }
}

async function recordKeyRequestMaterialDependents(
  tx: Transaction,
  journal: MutableMutationJournal,
): Promise<void> {
  const keyIds = new Set<string>()
  for (const dependency of journal.invalidations) {
    if (
      dependency.kind !== 'key' ||
      !dependency.facets?.includes('request-material') ||
      !dependency.keyIds
    ) {
      continue
    }
    for (const keyId of dependency.keyIds) keyIds.add(keyId)
  }
  if (keyIds.size === 0) return
  const links = await tx
    .table<ConfigurationLink, string>('configurationLinks')
    .where('targetKey')
    .anyOf([...keyIds].map((keyId) => configurationTargetKey('key', keyId)))
    .toArray()
  const profileIds = [
    ...new Set(links.flatMap((link) => (link.ownerKind === 'profile' ? [link.ownerId] : []))),
  ].sort()
  if (profileIds.length === 0) return
  journal.invalidations.push(
    { kind: 'profile', profileIds, facets: ['request-material'] },
    { kind: 'discovery-cache', profileIds },
  )
}

export function recordBrowserCommandMessageRevisions(
  tx: Transaction,
  revisions: readonly BrowserCommandMessageRevisionFact[],
): void {
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  const journal = journals.get(transaction)
  if (!journal) throw new Error('BrowserCommandMutationJournalMissing')
  for (const revision of revisions) {
    if (
      !Number.isSafeInteger(revision.structuralVersion) ||
      revision.structuralVersion < 0 ||
      (revision.presentation !== undefined &&
        (!sameMessageHeaderValue(revision.presentation.header, revision.header) ||
          revision.presentation.message.id !== revision.header.id ||
          revision.presentation.message.chatId !== revision.header.chatId)) ||
      (revision.presentation?.bodyVersion !== undefined &&
        revision.presentation.bodyVersion !== revision.header.bodyVersion)
    ) {
      throw new Error(`BrowserCommandMessageRevisionInvalid:${revision.header.id}`)
    }
    const current = journal.messageRevisions.get(revision.header.id)
    if (current && (!revision.before || !sameMessageHeaderValue(current.header, revision.before))) {
      throw new Error(`BrowserCommandMessageRevisionTransitionBroken:${revision.header.id}`)
    }
    const retainedPresentation =
      revision.presentation ??
      (current?.presentation?.bodyVersion === revision.header.bodyVersion
        ? current.presentation
        : undefined)
    journal.messageRevisions.set(revision.header.id, {
      ...(current
        ? current.before
          ? { before: structuredClone(current.before) }
          : {}
        : revision.before
          ? { before: structuredClone(revision.before) }
          : {}),
      header: structuredClone(revision.header),
      structuralVersion: revision.structuralVersion,
      ...(retainedPresentation ? { presentation: structuredClone(retainedPresentation) } : {}),
    })
  }
}

export function recordBrowserCommandChildSlotEvidence(
  tx: Transaction,
  evidence: WorkspaceLocalChildSlotEvidence,
): void {
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  const journal = journals.get(transaction)
  if (!journal) throw new Error('BrowserCommandMutationJournalMissing')
  let accumulator = journal.childSlots.get(evidence.state.id)
  if (!accumulator) {
    accumulator = new WorkspaceLocalChildSlotAccumulator()
    journal.childSlots.set(evidence.state.id, accumulator)
  }
  accumulator.add(evidence)
}

export function recordBrowserCommandStorageRetentionMutation(
  tx: Transaction,
  task: StorageRetentionTask,
): void {
  recordInternalMutationAddress(tx, 'storageRetentionState', task)
}

export function recordBrowserCommandBackfillSettingMutation(
  tx: Transaction,
  key: `backfill:${string}`,
): void {
  recordInternalMutationAddress(tx, 'settings', key)
}

export function recordBrowserCommandDiscoveryCacheMaintenance(tx: Transaction): void {
  requireMutationJournal(tx).internalMutationEvidence.add(INTERNAL_DISCOVERY_CACHE_MAINTENANCE)
}

export function recordBrowserCommandAttachmentIntegrityMaintenance(tx: Transaction): void {
  const journal = requireMutationJournal(tx)
  journal.internalMutationEvidence.add(INTERNAL_ATTACHMENT_INTEGRITY_MAINTENANCE)
  journal.invalidations.push({ kind: 'attachment' })
}

export function recordBrowserCommandAttachmentPayloadDeletion(
  tx: Transaction,
  tableName: 'attachmentArtifacts' | 'attachmentBlobs' | 'attachmentJobs',
  keys: readonly string[],
  attachmentId: AttachmentId,
): void {
  const journal = requireMutationJournal(tx)
  for (const key of keys) {
    journal.physicalMutationHints.set(
      `${tableName}\u0000${encodePhysicalMutationKey(key)}`,
      Object.freeze({ attachmentId }),
    )
  }
}

export function recordBrowserCommandPhysicalDeletionRows(
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  keys: readonly unknown[],
  rows: readonly unknown[],
): void {
  if (keys.length !== rows.length) {
    throw new Error(`BrowserCommandPhysicalDeletionIdentityMismatch:${tableName}`)
  }
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  const journal = journals.get(transaction)
  if (!journal) return
  for (let index = 0; index < keys.length; index += 1) {
    const identity = physicalMutationIdentity(tableName, keys[index], rows[index], 'delete')
    const previous = journal.physicalMutationHints.get(identity.address)
    journal.physicalMutationHints.set(
      identity.address,
      mergePhysicalMutationHints(identity.address, previous, physicalMutationHint(identity)),
    )
  }
}

export function recordBrowserCommandPhysicalDeletionOwnerScope(
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  keys: readonly unknown[],
  scope: { readonly kind: 'chat'; readonly ownerIds: readonly ChatId[] },
): string | undefined {
  if (keys.length === 0) return undefined
  const ownerIds = [...new Set(scope.ownerIds)].sort()
  if (ownerIds.length === 0) {
    throw new Error(`BrowserCommandPhysicalDeletionOwnerScopeEmpty:${tableName}`)
  }
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  const journal = journals.get(transaction)
  if (!journal) return
  const id = `chat:${ownerIds.map(encodePhysicalMutationKey).join('|')}`
  const nextScope = Object.freeze({ id, kind: 'chat' as const, ownerIds: Object.freeze(ownerIds) })
  const previousScope = journal.physicalOwnerScopes.get(id)
  if (previousScope && !sameValue(previousScope, nextScope)) {
    throw new Error(`BrowserCommandPhysicalOwnerScopeConflict:${id}`)
  }
  journal.physicalOwnerScopes.set(id, nextScope)
  for (const key of keys) {
    const address = `${tableName}\u0000${encodePhysicalMutationKey(key)}`
    const previous = journal.physicalMutationHints.get(address)
    journal.physicalMutationHints.set(
      address,
      mergePhysicalMutationHints(address, previous, { ownerScopeId: id }),
    )
  }
  return id
}

export function recordBrowserCommandStreamJournalRetirementPage(
  tx: Transaction,
  keys: readonly string[],
  scope:
    | { readonly kind: 'stream'; readonly streamId: string; readonly chatId?: ChatId }
    | { readonly kind: 'orphan-chat-closure'; readonly chatIds: readonly ChatId[] },
): void {
  if (keys.length === 0) return
  const journal = requireMutationJournal(tx)
  const ownerScopeId =
    scope.kind === 'orphan-chat-closure'
      ? recordBrowserCommandPhysicalDeletionOwnerScope(tx, 'streamChunks', keys, {
          kind: 'chat',
          ownerIds: scope.chatIds,
        })
      : undefined
  const groupAddress =
    scope.kind === 'stream'
      ? `streamChunks\u0000stream:${encodePhysicalMutationKey(scope.streamId)}`
      : `streamChunks\u0000owner:${ownerScopeId}`
  for (const key of keys) {
    const streamId = streamJournalFrameStreamId(key)
    if (!streamId) throw new Error(`BrowserCommandStreamJournalFrameIdentityInvalid:${key}`)
    if (scope.kind === 'stream' && streamId !== scope.streamId) {
      throw new Error(`BrowserCommandStreamJournalRetirementScopeMismatch:${scope.streamId}`)
    }
    const address = `streamChunks\u0000${encodePhysicalMutationKey(key)}`
    const previous = journal.physicalMutationHints.get(address)
    journal.physicalMutationHints.set(
      address,
      mergePhysicalMutationHints(address, previous, {
        mutationGroupAddress: groupAddress,
        ...(scope.kind === 'stream'
          ? { streamId: scope.streamId, ...(scope.chatId ? { chatId: scope.chatId } : {}) }
          : ownerScopeId
            ? { ownerScopeId }
            : {}),
      }),
    )
  }
}

export function recordBrowserCommandAttachmentReferenceState(
  tx: Transaction,
  fact: AttachmentReferenceStateFact,
): void {
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  const journal = journals.get(transaction)
  if (!journal) return
  const current = journal.attachmentReferenceStates.get(fact.attachmentId)
  if (!current) {
    journal.attachmentReferenceStates.set(fact.attachmentId, {
      attachmentId: fact.attachmentId,
      initial: { ...fact.initial },
      final: { ...fact.final },
      projectionChanged: fact.projectionChanged,
    })
    return
  }
  if (
    current.final.exists !== fact.initial.exists ||
    current.final.refCount !== fact.initial.refCount
  ) {
    throw new Error(`AttachmentReferenceStateTransitionBroken:${fact.attachmentId}`)
  }
  current.final = { ...fact.final }
  current.projectionChanged ||= fact.projectionChanged
}

export function recordBrowserCommandAttachmentRow(
  tx: Transaction,
  attachmentId: AttachmentId,
  exists: boolean,
): void {
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  journals.get(transaction)?.attachmentRows.set(attachmentId, exists)
}

export function recordBrowserCommandInvalidation(
  tx: Transaction,
  invalidation: WorkspaceDependency,
): void {
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  const journal = journals.get(transaction)
  if (!journal) throw new Error('BrowserCommandMutationJournalMissing')
  journal.invalidations.push(invalidation)
}

export function recordBrowserCommandOwnerInvalidation(
  tx: Transaction,
  invalidation: WorkspaceDependency,
): void {
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  journals.get(transaction)?.invalidations.push(invalidation)
}

const browserCommandMutationMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'BrowserCommandMutationJournal',
  level: 3,
  create: (down) => ({
    ...down,
    table: (tableName) => {
      const table = down.table(tableName)
      return {
        ...table,
        mutate: async (request) => {
          const journal = journals.get(request.trans)
          if (!journal) return table.mutate(request)
          if (request.type === 'deleteRange' && request.range.type !== DBCORE_RANGE_NEVER) {
            throw new Error(`BrowserCommandExactDeleteRangeForbidden:${tableName}`)
          }
          const deletedValues =
            request.type === 'delete' &&
            !DELETE_KEY_HAS_REQUIRED_IDENTITY.has(tableName) &&
            !request.keys.every((key) =>
              journal.physicalMutationHints.has(
                `${tableName}\u0000${encodePhysicalMutationKey(key)}`,
              ),
            )
              ? await table.getMany({ trans: request.trans, keys: request.keys })
              : undefined
          const requested = requestedMutationCount(request)
          try {
            const response = await table.mutate(request)
            if (requested === 0) return response
            const successful = Math.max(0, requested - response.numFailures)
            if (successful === 0) return response
            journal.tableNames.add(tableName)
            journal.successfulMutations += successful
            recordSuccessfulPhysicalMutations(
              journal,
              tableName,
              table.schema.primaryKey.extractKey,
              request,
              response,
              deletedValues,
              journal.physicalMutationHints,
            )
            if (tableName === 'chats') recordSuccessfulChatMutations(journal, request, response)
            return response
          } finally {
            if (request.type === 'delete') {
              for (const key of request.keys) {
                journal.physicalMutationHints.delete(
                  `${tableName}\u0000${encodePhysicalMutationKey(key)}`,
                )
              }
            }
          }
        },
      }
    },
  }),
}

const DELETE_KEY_HAS_REQUIRED_IDENTITY = new Set([
  'childSlotMembers',
  'messageBodies',
  'messagePreviews',
  'streamChunks',
])

export const INTERNAL_DISCOVERY_CACHE_MAINTENANCE = 'group:discovery-cache-maintenance'
export const INTERNAL_ATTACHMENT_INTEGRITY_MAINTENANCE = 'group:attachment-integrity-maintenance'

function requireMutationJournal(tx: Transaction): MutableMutationJournal {
  const transaction = tx.idbtrans as unknown as DBCoreTransaction
  const journal = journals.get(transaction)
  if (!journal) throw new Error('BrowserCommandMutationJournalMissing')
  return journal
}

function recordInternalMutationAddress(tx: Transaction, tableName: string, key: unknown): void {
  requireMutationJournal(tx).internalMutationEvidence.add(
    `${tableName}\u0000${encodePhysicalMutationKey(key)}`,
  )
}

function recordSuccessfulPhysicalMutations(
  journal: MutableMutationJournal,
  tableName: string,
  extractKey: ((value: unknown) => unknown) | null,
  request: DBCoreMutateRequest,
  response: DBCoreMutateResponse,
  deletedValues?: readonly unknown[],
  hints: ReadonlyMap<string, BrowserCommandPhysicalMutationHint> = new Map(),
): void {
  if (tableName === 'streamChunks' && request.type === 'delete') {
    recordSuccessfulStreamJournalRetirements(journal, request, response, hints)
    return
  }
  if (request.type === 'deleteRange') {
    if (!response.failures[0]) {
      const address = `${tableName}\u0000range`
      journal.physicalMutations.set(
        address,
        Object.freeze({ tableName, address, operation: 'delete-range' }),
      )
    }
    return
  }
  const values: readonly unknown[] | undefined =
    request.type === 'delete' ? deletedValues : (request.values as readonly unknown[])
  const keys = request.keys as readonly unknown[] | undefined
  const results = response.results as readonly unknown[] | undefined
  const count = request.type === 'delete' ? request.keys.length : request.values.length
  for (let index = 0; index < count; index += 1) {
    if (response.failures[index]) continue
    const value = values?.[index]
    const key =
      keys?.[index] ??
      (value !== undefined && extractKey ? extractKey(value) : undefined) ??
      results?.[index]
    if (key === undefined) {
      throw new Error(`BrowserCommandPhysicalMutationKeyMissing:${tableName}:${index}`)
    }
    const mutation = physicalMutationIdentity(
      tableName,
      key,
      value,
      request.type === 'delete' ? 'delete' : 'write',
      hints.get(`${tableName}\u0000${encodePhysicalMutationKey(key)}`),
    )
    journal.physicalMutations.set(mutation.address, mutation)
  }
}

function recordSuccessfulStreamJournalRetirements(
  journal: MutableMutationJournal,
  request: Extract<DBCoreMutateRequest, { type: 'delete' }>,
  response: DBCoreMutateResponse,
  hints: ReadonlyMap<string, BrowserCommandPhysicalMutationHint>,
): void {
  for (let index = 0; index < request.keys.length; index += 1) {
    if (response.failures[index]) continue
    const key: unknown = request.keys[index]
    if (typeof key !== 'string') throw new Error('BrowserCommandStreamJournalFrameKeyInvalid')
    const streamId = streamJournalFrameStreamId(key)
    if (!streamId) throw new Error(`BrowserCommandStreamJournalFrameIdentityInvalid:${key}`)
    const hint = hints.get(`streamChunks\u0000${encodePhysicalMutationKey(key)}`)
    const address = hint?.mutationGroupAddress
    if (!hint || !address) {
      throw new Error(`BrowserCommandStreamJournalRetirementMissing:${streamId}`)
    }
    const identity = Object.freeze({
      tableName: 'streamChunks',
      address,
      operation: 'delete-group' as const,
      ...(hint.streamId ? { streamId: hint.streamId } : {}),
      ...(hint.chatId ? { chatId: hint.chatId } : {}),
      ...(hint.ownerScopeId ? { ownerScopeId: hint.ownerScopeId } : {}),
    })
    const previous = journal.physicalMutations.get(address)
    if (
      previous &&
      !sameValue({ ...previous, affectedRows: undefined }, { ...identity, affectedRows: undefined })
    ) {
      throw new Error(`BrowserCommandStreamJournalRetirementConflict:${streamId}`)
    }
    journal.physicalMutations.set(
      address,
      Object.freeze({ ...identity, affectedRows: saturatingCount(previous?.affectedRows ?? 0, 1) }),
    )
  }
}

function physicalMutationIdentity(
  tableName: string,
  key: unknown,
  value: unknown,
  operation: 'write' | 'delete',
  hint?: BrowserCommandPhysicalMutationHint,
): BrowserCommandPhysicalMutation {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  const rowId = typeof row?.id === 'string' ? row.id : typeof key === 'string' ? key : undefined
  const chatId =
    hint?.chatId ??
    (typeof row?.chatId === 'string'
      ? row.chatId
      : tableName === 'chatSidebarRows' && rowId
        ? rowId
        : row?.ownerKind === 'chat' && typeof row.ownerId === 'string'
          ? row.ownerId
          : tableName === 'chats' && typeof key === 'string'
            ? key
            : undefined)
  const messageId =
    hint?.messageId ?? (MESSAGE_IDENTITY_TABLES.has(tableName) && rowId ? rowId : undefined)
  const attachmentId =
    hint?.attachmentId ??
    (typeof row?.attachmentId === 'string'
      ? row.attachmentId
      : tableName === 'attachmentCatalogRows' && rowId
        ? rowId
        : tableName === 'attachments' && rowId
          ? rowId
          : undefined)
  const profileId =
    hint?.profileId ??
    (typeof row?.profileId === 'string'
      ? row.profileId
      : tableName === 'profiles' && rowId
        ? rowId
        : row?.ownerKind === 'profile' && typeof row.ownerId === 'string'
          ? row.ownerId
          : row?.targetKind === 'profile' && typeof row.targetId === 'string'
            ? row.targetId
            : undefined)
  const streamId =
    hint?.streamId ??
    (typeof row?.streamId === 'string'
      ? row.streamId
      : tableName === 'streamLeases' && rowId
        ? rowId
        : tableName === 'streamChunks' && typeof key === 'string'
          ? streamJournalFrameStreamId(key)
          : undefined)
  const profileIds = hint?.profileIds ?? physicalConfigurationIds(tableName, rowId, row, 'profile')
  const presetIds =
    hint?.presetIds ?? physicalConfigurationIds(tableName, rowId, row, 'chat-preset')
  const promptPresetIds =
    hint?.promptPresetIds ?? physicalConfigurationIds(tableName, rowId, row, 'prompt-preset')
  const keyIds = hint?.keyIds ?? physicalConfigurationIds(tableName, rowId, row, 'key')
  const templateIds =
    hint?.templateIds ?? physicalConfigurationIds(tableName, rowId, row, 'text-template')
  const address = `${tableName}\u0000${encodePhysicalMutationKey(key)}`
  return Object.freeze({
    tableName,
    address,
    operation,
    key: structuredClone(key),
    ...(rowId ? { rowId } : {}),
    ...(hint?.ownerScopeId ? { ownerScopeId: hint.ownerScopeId } : {}),
    ...(chatId ? { chatId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
    ...(profileId ? { profileId } : {}),
    ...(profileIds.length > 0 ? { profileIds } : {}),
    ...(presetIds.length > 0 ? { presetIds } : {}),
    ...(promptPresetIds.length > 0 ? { promptPresetIds } : {}),
    ...(keyIds.length > 0 ? { keyIds } : {}),
    ...(templateIds.length > 0 ? { templateIds } : {}),
    ...(streamId ? { streamId } : {}),
  })
}

function physicalMutationHint(
  mutation: BrowserCommandPhysicalMutation,
): BrowserCommandPhysicalMutationHint {
  return {
    ...(mutation.ownerScopeId ? { ownerScopeId: mutation.ownerScopeId } : {}),
    ...(mutation.chatId ? { chatId: mutation.chatId } : {}),
    ...(mutation.messageId ? { messageId: mutation.messageId } : {}),
    ...(mutation.attachmentId ? { attachmentId: mutation.attachmentId } : {}),
    ...(mutation.profileId ? { profileId: mutation.profileId } : {}),
    ...(mutation.profileIds ? { profileIds: mutation.profileIds } : {}),
    ...(mutation.presetIds ? { presetIds: mutation.presetIds } : {}),
    ...(mutation.promptPresetIds ? { promptPresetIds: mutation.promptPresetIds } : {}),
    ...(mutation.keyIds ? { keyIds: mutation.keyIds } : {}),
    ...(mutation.templateIds ? { templateIds: mutation.templateIds } : {}),
    ...(mutation.streamId ? { streamId: mutation.streamId } : {}),
  }
}

function mergePhysicalMutationHints(
  address: string,
  previous: BrowserCommandPhysicalMutationHint | undefined,
  next: BrowserCommandPhysicalMutationHint,
): BrowserCommandPhysicalMutationHint {
  if (!previous) return Object.freeze({ ...next })
  const previousFields = previous as Record<string, unknown>
  const nextFields = next as Record<string, unknown>
  for (const [field, value] of Object.entries(nextFields)) {
    if (Object.hasOwn(previousFields, field) && !sameValue(previousFields[field], value)) {
      throw new Error(`BrowserCommandPhysicalMutationHintConflict:${address}:${field}`)
    }
  }
  return Object.freeze({ ...previous, ...next })
}

function physicalConfigurationIds(
  tableName: string,
  rowId: string | undefined,
  row: Record<string, unknown> | null,
  kind: 'profile' | 'chat-preset' | 'prompt-preset' | 'key' | 'text-template',
): readonly string[] {
  const ids = new Set<string>()
  const directTable =
    (kind === 'profile' &&
      (tableName === 'profiles' ||
        tableName === 'configurationProfileCatalogRows' ||
        tableName === 'configurationProfileUsageRows')) ||
    (kind === 'chat-preset' &&
      (tableName === 'presets' || tableName === 'configurationPresetCatalogRows')) ||
    (kind === 'prompt-preset' &&
      (tableName === 'promptPresets' || tableName === 'configurationPromptPresetCatalogRows')) ||
    (kind === 'key' && tableName === 'keys') ||
    (kind === 'text-template' && tableName === 'textTemplates')
  if (directTable && rowId) ids.add(rowId)
  if (row?.ownerKind === kind && typeof row.ownerId === 'string') ids.add(row.ownerId)
  if (row?.targetKind === kind && typeof row.targetId === 'string') ids.add(row.targetId)
  return Object.freeze([...ids].sort())
}

const MESSAGE_IDENTITY_TABLES = new Set([
  'messages',
  'messageBodies',
  'messagePreviews',
  'childSlotMembers',
])

function encodePhysicalMutationKey(value: unknown): string {
  if (typeof value === 'string') return `s:${value.length}:${value}`
  if (typeof value === 'number') return `n:${Object.is(value, -0) ? '-0' : String(value)}`
  if (value instanceof Date) return `d:${value.getTime()}`
  if (Array.isArray(value)) return `a:[${value.map(encodePhysicalMutationKey).join(',')}]`
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    let encoded = 'b:'
    for (const byte of bytes) encoded += byte.toString(16).padStart(2, '0')
    return encoded
  }
  throw new Error('BrowserCommandPhysicalMutationKeyInvalid')
}

function recordSuccessfulChatMutations(
  journal: MutableMutationJournal,
  request: DBCoreMutateRequest,
  response: DBCoreMutateResponse,
): void {
  switch (request.type) {
    case 'add':
    case 'put':
      request.values.forEach((value, index) => {
        if (response.failures[index]) return
        const chatId = (value as { id?: unknown }).id
        if (typeof chatId !== 'string') throw new Error('BrowserCommandChatMutationIdMissing')
        journal.chatIds.add(chatId)
        if (!journal.initialChatExistsById.has(chatId)) {
          journal.initialChatExistsById.set(chatId, request.type !== 'add')
        }
      })
      return
    case 'delete':
      request.keys.forEach((key, index) => {
        if (response.failures[index]) return
        if (typeof key !== 'string') throw new Error('BrowserCommandChatMutationKeyInvalid')
        journal.chatIds.add(key)
        if (!journal.initialChatExistsById.has(key)) {
          journal.initialChatExistsById.set(key, true)
        }
      })
      return
    case 'deleteRange':
      throw new Error('BrowserCommandChatDeleteRangeForbidden')
  }
}

function requiredInitialChatExistence(journal: MutableMutationJournal, chatId: ChatId): boolean {
  const exists = journal.initialChatExistsById.get(chatId)
  if (exists === undefined) throw new Error(`BrowserCommandChatInitialStateMissing:${chatId}`)
  return exists
}

function requestedMutationCount(request: DBCoreMutateRequest): number {
  switch (request.type) {
    case 'add':
    case 'put':
      return request.values.length
    case 'delete':
      return request.keys.length
    case 'deleteRange':
      return request.range.type === DBCORE_RANGE_NEVER ? 0 : 1
  }
}

function saturatingCount(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment)
}

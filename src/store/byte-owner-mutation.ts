import type { Collection, Transaction } from 'dexie'
import type { SavedTextTemplate } from '../core/text-templates'
import type {
  AttachmentArtifact,
  AttachmentBlob,
  AttachmentId,
  AttachmentJob,
  Chat,
  ChatFolder,
  ChatId,
  ChatPreset,
  ChatTag,
  ConnectionProfile,
  DraftRow,
  FolderId,
  KeyId,
  KeyRecord,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  TagId,
  TextTemplateId,
} from '../core/types'
import type { AttachmentHeaderRow } from './attachment-storage'
import {
  recordBrowserCommandAttachmentPayloadDeletion,
  recordBrowserCommandAttachmentRow,
  recordBrowserCommandInvalidation,
  recordBrowserCommandOwnerInvalidation,
  recordBrowserCommandPhysicalDeletionOwnerScope,
  recordBrowserCommandPhysicalDeletionRows,
} from './browser-command-mutation-journal'
import {
  type ConfigurationLink,
  type ConfigurationLinkOwnerKind,
  configurationLinksForChat,
  configurationLinksForPreset,
  configurationLinksForProfile,
  configurationOwnerKey,
  sameConfigurationValue,
} from './configuration-domain-contract'
import {
  CONFIGURATION_PROFILE_MANAGER_STATE_ID,
  type ConfigurationProfileManagerStateRow,
  type ConfigurationProfileUsageDelta,
  type ConfigurationProfileUsageProjectionRow,
  configurationProfileUsageDeltas,
  emptyConfigurationProfileUsageProjectionRow,
} from './configuration-profile-usage-projection'
import type { SettingsRow } from './db-rows'
import type { MessageBodyRow, MessageHeaderRow } from './message-storage'
import type { PhysicalStorageTableName } from './physical-storage-tables'
import {
  recordSemanticOperationExactPhysicalWrite,
  type SemanticOperationExactReceiptAccumulator,
} from './semantic-operation-capability'
import { accumulateStorageCompactionDebt } from './storage-compaction-state'
import {
  estimateAttachmentPayloadProjectionStorageBytes,
  estimateDeletedCompactRowsStorageBytes,
  estimateMessageBodyProjectionStorageBytes,
  estimateStoredValueBytes,
} from './storage-size-estimate'
import { workspaceDependenciesForConfigurationSemanticMutation } from './workspace-protocol'

type GenericPhysicalDeletionTableName = Exclude<
  PhysicalStorageTableName,
  'streamChunks' | 'streamLeases'
>

interface ExactConfigurationOwnerLinkTransition {
  readonly kind: 'exact'
  readonly ownerKind: ConfigurationLinkOwnerKind
  readonly ownerId: string
  readonly previous: readonly ConfigurationLink[]
  readonly next: readonly ConfigurationLink[]
}

interface RepairDeleteConfigurationOwnerLinkTransition {
  readonly kind: 'repair-delete'
  readonly ownerKind: ConfigurationLinkOwnerKind
  readonly ownerId: string
  readonly accountedPrevious: readonly ConfigurationLink[]
  readonly next: readonly []
}

type ConfigurationOwnerLinkTransition =
  | ExactConfigurationOwnerLinkTransition
  | RepairDeleteConfigurationOwnerLinkTransition

const profileUsageRevisionTransactions = new WeakSet<object>()
export const CONFIGURATION_OWNER_LINK_BATCH_SIZE = 128

export interface ConfigurationOwnerLinkMutationReceipt {
  readonly ownerQueryRequests: number
  readonly ownerQueryRowCount: number
  readonly removedLinkIds: readonly string[]
  readonly writtenLinkIds: readonly string[]
  readonly profileUsageReadRequests: number
  readonly profileUsageMutations: readonly {
    readonly profileId: ProfileId
    readonly operation: 'write' | 'delete'
  }[]
  readonly profileManagerRevisionChanged: boolean
}

export function emptyConfigurationOwnerLinkMutationReceipt(): ConfigurationOwnerLinkMutationReceipt {
  return Object.freeze({
    ownerQueryRequests: 0,
    ownerQueryRowCount: 0,
    removedLinkIds: Object.freeze([]),
    writtenLinkIds: Object.freeze([]),
    profileUsageReadRequests: 0,
    profileUsageMutations: Object.freeze([]),
    profileManagerRevisionChanged: false,
  })
}

export async function addPhysicalStorageRow<Row, Key>(
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  next: Row,
): Promise<void> {
  const receipt = recordSemanticOperationExactPhysicalWrite(tx, tableName, 'add', [next])
  const key = await tx.table<Row, Key>(tableName).add(next)
  recordConstructivePhysicalKeys(receipt, tableName, 'write', [key])
}

export async function addPhysicalStorageRows<Row, Key>(
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  next: readonly Row[],
): Promise<void> {
  if (next.length === 0) return
  const receipt = recordSemanticOperationExactPhysicalWrite(tx, tableName, 'add', next)
  await tx.table<Row, Key>(tableName).bulkAdd([...next])
  recordConstructivePhysicalRows(receipt, tx, tableName, 'write', next)
}

export async function putPhysicalStorageRow<Row, Key>(
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  next: Row,
  previous: Row | undefined,
): Promise<void> {
  const table = tx.table<Row, Key>(tableName)
  if (!previous) {
    const receipt = recordSemanticOperationExactPhysicalWrite(tx, tableName, 'add', [next])
    const key = await table.add(next)
    recordConstructivePhysicalKeys(receipt, tableName, 'write', [key])
    return
  }
  await replacePhysicalStorageRow<Row, Key>(tx, tableName, next, previous)
}

export async function replacePhysicalStorageRow<Row, Key>(
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  next: Row,
  previous: Row | undefined,
): Promise<void> {
  if (previous !== undefined) await recordObsoleteByteOwnerValues(tx, [previous])
  const receipt = recordSemanticOperationExactPhysicalWrite(tx, tableName, 'put', [next])
  const key = await tx.table<Row, Key>(tableName).put(next)
  recordConstructivePhysicalKeys(receipt, tableName, 'write', [key])
}

export async function putPhysicalStorageRows<Row, Key>(
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  next: readonly Row[],
  replaced: readonly Row[],
): Promise<void> {
  if (next.length === 0) return
  await recordObsoleteByteOwnerValues(tx, replaced)
  const receipt = recordSemanticOperationExactPhysicalWrite(tx, tableName, 'put', next)
  await tx.table<Row, Key>(tableName).bulkPut([...next])
  recordConstructivePhysicalRows(receipt, tx, tableName, 'write', next)
}

export async function putChatFolderByteOwner(
  tx: Transaction,
  next: ChatFolder,
  previous: ChatFolder | undefined,
): Promise<void> {
  await putPhysicalStorageRow<ChatFolder, FolderId>(tx, 'folders', next, previous)
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'folder', folderIds: [next.id] })
}

export async function deleteChatFolderByteOwner(
  tx: Transaction,
  previous: ChatFolder,
): Promise<void> {
  await deletePhysicalStorageRows<ChatFolder, FolderId>(tx, 'folders', [previous.id], [previous])
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'folder', folderIds: [previous.id] })
}

export async function putChatTagByteOwners(
  tx: Transaction,
  next: readonly ChatTag[],
  previous: readonly ChatTag[],
): Promise<void> {
  if (next.length === 0) return
  await putPhysicalStorageRows<ChatTag, TagId>(tx, 'tags', next, previous)
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'tag',
    tagIds: next.map((tag) => tag.id),
  })
}

export async function deleteChatTagByteOwners(
  tx: Transaction,
  previous: readonly ChatTag[],
): Promise<void> {
  if (previous.length === 0) return
  await deletePhysicalStorageRows<ChatTag, TagId>(
    tx,
    'tags',
    previous.map((tag) => tag.id),
    previous,
  )
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'tag',
    tagIds: previous.map((tag) => tag.id),
  })
}

export async function deletePhysicalStorageRows<Row, Key>(
  tx: Transaction,
  tableName: GenericPhysicalDeletionTableName,
  keys: readonly Key[],
  previous: readonly Row[],
): Promise<void> {
  if (keys.length === 0) return
  recordBrowserCommandPhysicalDeletionRows(tx, tableName, keys, previous)
  await recordObsoleteByteOwnerValues(tx, previous)
  await deletePhysicalStorageKeys<Row, Key>(tx, tableName, keys)
}

export async function deletePhysicalStorageKeys<Row, Key>(
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  keys: readonly Key[],
): Promise<void> {
  if (keys.length === 0) return
  const receipt = recordSemanticOperationExactPhysicalWrite(tx, tableName, 'delete', keys)
  await tx.table<Row, Key>(tableName).bulkDelete([...keys])
  recordConstructivePhysicalKeys(receipt, tableName, 'delete', keys)
}

export async function deletePhysicalStorageCollection<Row, Key>(
  tx: Transaction,
  tableName: GenericPhysicalDeletionTableName,
  collection: Collection<Row, Key>,
): Promise<number> {
  const rows: Row[] = []
  const keys: Key[] = []
  let obsoleteBytes = 0
  await collection.each((row, cursor) => {
    rows.push(row)
    keys.push(cursor.primaryKey)
    obsoleteBytes = saturatingAdd(obsoleteBytes, estimateStoredValueBytes(row))
  })
  recordBrowserCommandPhysicalDeletionRows(tx, tableName, keys, rows)
  await recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
  if (keys.length > 0) {
    await deletePhysicalStorageKeys<Row, Key>(tx, tableName, keys)
  }
  return keys.length
}

function recordConstructivePhysicalKeys(
  receipt: SemanticOperationExactReceiptAccumulator<PhysicalStorageTableName> | undefined,
  tableName: PhysicalStorageTableName,
  mutationOperation: 'write' | 'delete',
  keys: readonly unknown[],
): void {
  if (!receipt) return
  for (const key of keys) {
    receipt.physicalMutation({ tableName, operation: mutationOperation, key })
  }
}

function recordConstructivePhysicalRows<Row>(
  receipt: SemanticOperationExactReceiptAccumulator<PhysicalStorageTableName> | undefined,
  tx: Transaction,
  tableName: PhysicalStorageTableName,
  mutationOperation: 'write' | 'delete',
  rows: readonly Row[],
): void {
  if (!receipt) return
  const keyPath = tx.table(tableName).schema.primKey.keyPath
  if (keyPath === undefined) {
    throw new Error(`SemanticOperationPhysicalKeyPathMissing:${tableName}`)
  }
  const keyPaths = Array.isArray(keyPath) ? keyPath : [keyPath]
  const keys = rows.map((row) => {
    const values = keyPaths.map((path) => physicalStorageRowKeyPathValue(row, path))
    return values.length === 1 ? values[0] : values
  })
  recordConstructivePhysicalKeys(receipt, tableName, mutationOperation, keys)
}

function physicalStorageRowKeyPathValue(row: unknown, keyPath: string): unknown {
  let value = row
  for (const key of keyPath.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) {
      throw new Error(`SemanticOperationPhysicalKeyMissing:${keyPath}`)
    }
    value = (value as Record<string, unknown>)[key]
  }
  if (value === undefined) throw new Error(`SemanticOperationPhysicalKeyMissing:${keyPath}`)
  return value
}

export async function deleteChatOwnedPhysicalStorageCollectionWithKnownBytes<
  Row extends { readonly chatId: ChatId },
  Key,
>(
  tx: Transaction,
  tableName: GenericPhysicalDeletionTableName,
  chatIds: readonly ChatId[],
  obsoleteBytes: number,
): Promise<number> {
  const ownerIds = [...new Set(chatIds)]
  if (ownerIds.length === 0) return 0
  const collection = tx.table<Row, Key>(tableName).where('chatId').anyOf(ownerIds)
  const keys = await collection.primaryKeys()
  recordBrowserCommandPhysicalDeletionOwnerScope(tx, tableName, keys, {
    kind: 'chat',
    ownerIds,
  })
  await recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
  if (keys.length > 0) {
    await deletePhysicalStorageKeys<Row, Key>(tx, tableName, keys)
  }
  return keys.length
}

async function applyConfigurationOwnerLinkTransitions(
  tx: Transaction,
  transitions: readonly ConfigurationOwnerLinkTransition[],
): Promise<ConfigurationOwnerLinkMutationReceipt> {
  if (transitions.length === 0) return emptyConfigurationOwnerLinkMutationReceipt()
  assertConfigurationOwnerLinkTransitions(transitions)
  const usageDeltas = new Map<ProfileId, ConfigurationProfileUsageDelta>()
  const removedLinkIds: string[] = []
  const writtenLinkIds: string[] = []
  let ownerQueryRequests = 0
  let ownerQueryRowCount = 0
  for (let offset = 0; offset < transitions.length; offset += CONFIGURATION_OWNER_LINK_BATCH_SIZE) {
    const batch = transitions.slice(offset, offset + CONFIGURATION_OWNER_LINK_BATCH_SIZE)
    const nextLinks = batch.flatMap((transition) => [...transition.next])
    const batchOwnerKeys = batch.map((transition) =>
      configurationOwnerKey(transition.ownerKind, transition.ownerId),
    )
    const storedLinks = await tx
      .table<ConfigurationLink, string>('configurationLinks')
      .where('ownerKey')
      .anyOf(batchOwnerKeys)
      .toArray()
    ownerQueryRequests += 1
    ownerQueryRowCount += storedLinks.length
    const storedByOwner = configurationLinksByOwnerKey(storedLinks)
    for (const transition of batch) {
      const ownerKey = configurationOwnerKey(transition.ownerKind, transition.ownerId)
      const storedPrevious = storedByOwner.get(ownerKey) ?? []
      if (
        transition.kind === 'exact' &&
        !sameConfigurationLinks(storedPrevious, transition.previous)
      ) {
        throw new Error(`ConfigurationOwnerLinkPreviousMismatch:${ownerKey}`)
      }
      addConfigurationProfileUsageDeltas(
        usageDeltas,
        configurationProfileUsageDeltas(
          transition.kind === 'exact' ? transition.previous : transition.accountedPrevious,
          transition.next,
        ),
      )
    }
    const storedById = uniqueConfigurationLinksById(storedLinks)
    const nextById = uniqueConfigurationLinksById(nextLinks)
    const removed = storedLinks.filter((link) => !nextById.has(link.id))
    removedLinkIds.push(...removed.map((link) => link.id))
    await deletePhysicalStorageRows(
      tx,
      'configurationLinks',
      removed.map((link) => link.id),
      removed,
    )
    const changed = nextLinks.filter((link) => {
      const stored = storedById.get(link.id)
      return !stored || !sameConfigurationValue(stored, link)
    })
    writtenLinkIds.push(...changed.map((link) => link.id))
    await putPhysicalStorageRows(
      tx,
      'configurationLinks',
      changed.map((link) => structuredClone(link)),
      changed.flatMap((link) => {
        const stored = storedById.get(link.id)
        return stored ? [stored] : []
      }),
    )
  }
  const usage = await applyConfigurationProfileUsageDeltas(tx, [...usageDeltas.values()])
  return Object.freeze({
    ownerQueryRequests,
    ownerQueryRowCount,
    removedLinkIds: Object.freeze(removedLinkIds.sort()),
    writtenLinkIds: Object.freeze(writtenLinkIds.sort()),
    profileUsageReadRequests: usage.readRequests,
    profileUsageMutations: usage.mutations,
    profileManagerRevisionChanged: usage.profileManagerRevisionChanged,
  })
}

async function addConfigurationOwnerLinks(
  tx: Transaction,
  transitions: readonly ExactConfigurationOwnerLinkTransition[],
): Promise<ConfigurationOwnerLinkMutationReceipt> {
  if (transitions.length === 0) return emptyConfigurationOwnerLinkMutationReceipt()
  assertConfigurationOwnerLinkTransitions(transitions)
  if (transitions.some((transition) => transition.previous.length !== 0)) {
    throw new Error('ConfigurationOwnerLinkAdditionPreviousNotEmpty')
  }
  uniqueConfigurationLinksById(transitions.flatMap((transition) => [...transition.next]))
  const usageDeltas = new Map<ProfileId, ConfigurationProfileUsageDelta>()
  const writtenLinkIds: string[] = []
  for (let offset = 0; offset < transitions.length; offset += CONFIGURATION_OWNER_LINK_BATCH_SIZE) {
    const batch = transitions.slice(offset, offset + CONFIGURATION_OWNER_LINK_BATCH_SIZE)
    const links = batch.flatMap((transition) => transition.next)
    await addPhysicalStorageRows(
      tx,
      'configurationLinks',
      links.map((link) => structuredClone(link)),
    )
    writtenLinkIds.push(...links.map((link) => link.id))
    for (const transition of batch) {
      addConfigurationProfileUsageDeltas(
        usageDeltas,
        configurationProfileUsageDeltas([], transition.next),
      )
    }
  }
  const usage = await applyConfigurationProfileUsageDeltas(tx, [...usageDeltas.values()])
  return Object.freeze({
    ownerQueryRequests: 0,
    ownerQueryRowCount: 0,
    removedLinkIds: Object.freeze([]),
    writtenLinkIds: Object.freeze(writtenLinkIds.sort()),
    profileUsageReadRequests: usage.readRequests,
    profileUsageMutations: usage.mutations,
    profileManagerRevisionChanged: usage.profileManagerRevisionChanged,
  })
}

function assertConfigurationOwnerLinkTransitions(
  transitions: readonly ConfigurationOwnerLinkTransition[],
): void {
  const ownerKeys = new Set<string>()
  for (const transition of transitions) {
    const ownerKey = configurationOwnerKey(transition.ownerKind, transition.ownerId)
    if (ownerKeys.has(ownerKey)) {
      throw new Error(`ConfigurationOwnerLinkTransitionDuplicate:${ownerKey}`)
    }
    const assertedLinks =
      transition.kind === 'exact'
        ? [...transition.previous, ...transition.next]
        : [...transition.accountedPrevious]
    if (assertedLinks.some((link) => link.ownerKey !== ownerKey)) {
      throw new Error(`ConfigurationOwnerLinkTransitionMismatch:${ownerKey}`)
    }
    ownerKeys.add(ownerKey)
  }
}

function uniqueConfigurationLinksById(
  links: readonly ConfigurationLink[],
): Map<string, ConfigurationLink> {
  const byId = new Map<string, ConfigurationLink>()
  for (const link of links) {
    if (byId.has(link.id)) throw new Error(`ConfigurationLinkTransitionDuplicate:${link.id}`)
    byId.set(link.id, link)
  }
  return byId
}

function configurationLinksByOwnerKey(
  links: readonly ConfigurationLink[],
): Map<string, ConfigurationLink[]> {
  const byOwner = new Map<string, ConfigurationLink[]>()
  for (const link of links) {
    const retained = byOwner.get(link.ownerKey)
    if (retained) retained.push(link)
    else byOwner.set(link.ownerKey, [link])
  }
  return byOwner
}

function sameConfigurationLinks(
  stored: readonly ConfigurationLink[],
  expected: readonly ConfigurationLink[],
): boolean {
  if (stored.length !== expected.length) return false
  const storedById = uniqueConfigurationLinksById(stored)
  return expected.every((link) => {
    const current = storedById.get(link.id)
    return current !== undefined && sameConfigurationValue(current, link)
  })
}

function addConfigurationProfileUsageDeltas(
  target: Map<ProfileId, ConfigurationProfileUsageDelta>,
  deltas: readonly ConfigurationProfileUsageDelta[],
): void {
  for (const delta of deltas) {
    const current = target.get(delta.id) ?? emptyConfigurationProfileUsageProjectionRow(delta.id)
    const next = {
      id: delta.id,
      presetCount: current.presetCount + delta.presetCount,
      activePresetCount: current.activePresetCount + delta.activePresetCount,
      chatCount: current.chatCount + delta.chatCount,
      activeChatCount: current.activeChatCount + delta.activeChatCount,
    }
    if (
      next.presetCount === 0 &&
      next.activePresetCount === 0 &&
      next.chatCount === 0 &&
      next.activeChatCount === 0
    ) {
      target.delete(delta.id)
    } else {
      target.set(delta.id, next)
    }
  }
}

async function applyConfigurationProfileUsageDeltas(
  tx: Transaction,
  deltas: readonly ConfigurationProfileUsageDelta[],
): Promise<{
  readonly readRequests: number
  readonly mutations: readonly {
    readonly profileId: ProfileId
    readonly operation: 'write' | 'delete'
  }[]
  readonly profileManagerRevisionChanged: boolean
}> {
  if (deltas.length === 0) {
    return {
      readRequests: 0,
      mutations: Object.freeze([]),
      profileManagerRevisionChanged: false,
    }
  }
  const table = tx.table<ConfigurationProfileUsageProjectionRow, ProfileId>(
    'configurationProfileUsageRows',
  )
  const mutations: Array<{
    readonly profileId: ProfileId
    readonly operation: 'write' | 'delete'
  }> = []
  let readRequests = 0
  for (let offset = 0; offset < deltas.length; offset += CONFIGURATION_OWNER_LINK_BATCH_SIZE) {
    const batch = deltas.slice(offset, offset + CONFIGURATION_OWNER_LINK_BATCH_SIZE)
    const previousRows = await table.bulkGet(batch.map((delta) => delta.id))
    readRequests += 1
    const deletedIds: ProfileId[] = []
    const deletedRows: ConfigurationProfileUsageProjectionRow[] = []
    const writtenRows: ConfigurationProfileUsageProjectionRow[] = []
    const replacedRows: ConfigurationProfileUsageProjectionRow[] = []
    for (let index = 0; index < batch.length; index += 1) {
      const delta = batch[index]
      if (!delta) continue
      const previous = previousRows[index]
      const base = previous ?? emptyConfigurationProfileUsageProjectionRow(delta.id)
      const next: ConfigurationProfileUsageProjectionRow = {
        id: delta.id,
        presetCount: base.presetCount + delta.presetCount,
        activePresetCount: base.activePresetCount + delta.activePresetCount,
        chatCount: base.chatCount + delta.chatCount,
        activeChatCount: base.activeChatCount + delta.activeChatCount,
      }
      if (
        next.presetCount < 0 ||
        next.activePresetCount < 0 ||
        next.chatCount < 0 ||
        next.activeChatCount < 0 ||
        next.activePresetCount > next.presetCount ||
        next.activeChatCount > next.chatCount
      ) {
        throw new Error(`ConfigurationProfileUsageCountInvalid:${delta.id}`)
      }
      if (
        next.presetCount === 0 &&
        next.activePresetCount === 0 &&
        next.chatCount === 0 &&
        next.activeChatCount === 0
      ) {
        deletedIds.push(delta.id)
        if (previous) deletedRows.push(previous)
      } else {
        writtenRows.push(next)
        if (previous) replacedRows.push(previous)
      }
    }
    await deletePhysicalStorageRows(tx, 'configurationProfileUsageRows', deletedIds, deletedRows)
    await putPhysicalStorageRows(tx, 'configurationProfileUsageRows', writtenRows, replacedRows)
    mutations.push(
      ...deletedIds.map((profileId) => ({ profileId, operation: 'delete' as const })),
      ...writtenRows.map(({ id: profileId }) => ({ profileId, operation: 'write' as const })),
    )
  }
  const transactionIdentity = tx.idbtrans as unknown as object
  let profileManagerRevisionChanged = false
  if (!profileUsageRevisionTransactions.has(transactionIdentity)) {
    profileUsageRevisionTransactions.add(transactionIdentity)
    const states = tx.table<ConfigurationProfileManagerStateRow, string>(
      'configurationCatalogAggregates',
    )
    const state = await states.get(CONFIGURATION_PROFILE_MANAGER_STATE_ID)
    if (!state) throw new Error('ConfigurationProfileManagerStateMissing')
    await putPhysicalStorageRow(
      tx,
      'configurationCatalogAggregates',
      { ...state, revision: state.revision + 1 },
      state,
    )
    profileManagerRevisionChanged = true
  }
  recordBrowserCommandInvalidation(tx, {
    kind: 'profile',
    profileIds: deltas.map((delta) => delta.id),
    facets: ['dependent-counts'],
  })
  return {
    readRequests,
    mutations: Object.freeze(
      mutations.sort((left, right) => left.profileId.localeCompare(right.profileId)),
    ),
    profileManagerRevisionChanged,
  }
}

interface AllSemanticByteOwnerRows {
  readonly chats: Chat
  readonly profiles: ConnectionProfile
  readonly presets: ChatPreset
  readonly promptPresets: PromptPreset
  readonly keys: KeyRecord
}

interface AllSemanticByteOwnerKeys {
  readonly chats: ChatId
  readonly profiles: ProfileId
  readonly presets: PresetId
  readonly promptPresets: PromptPresetId
  readonly keys: KeyId
}

type SemanticByteOwnerRows = Pick<AllSemanticByteOwnerRows, 'promptPresets' | 'keys'>

type SemanticByteOwnerKeys = Pick<AllSemanticByteOwnerKeys, 'promptPresets' | 'keys'>

type LinkedSemanticByteOwnerRows = Pick<AllSemanticByteOwnerRows, 'chats' | 'profiles' | 'presets'>

type LinkedSemanticByteOwnerKeys = Pick<AllSemanticByteOwnerKeys, 'chats' | 'profiles' | 'presets'>

type AllSemanticByteOwnerTableName = keyof AllSemanticByteOwnerRows
type AllSemanticByteOwnerRow = AllSemanticByteOwnerRows[AllSemanticByteOwnerTableName]
export type SemanticByteOwnerTableName = keyof SemanticByteOwnerRows
export type LinkedSemanticByteOwnerTableName = keyof LinkedSemanticByteOwnerRows

export async function addSemanticByteOwner<TableName extends SemanticByteOwnerTableName>(
  tx: Transaction,
  tableName: TableName,
  next: SemanticByteOwnerRows[TableName],
): Promise<void> {
  await addSemanticByteOwnerRaw(tx, tableName, next)
}

export async function addLinkedSemanticByteOwner<
  TableName extends LinkedSemanticByteOwnerTableName,
>(
  tx: Transaction,
  tableName: TableName,
  next: LinkedSemanticByteOwnerRows[TableName],
): Promise<ConfigurationOwnerLinkMutationReceipt> {
  return addLinkedSemanticByteOwnerBatch(tx, tableName, [next])
}

export async function addLinkedSemanticByteOwnerBatch<
  TableName extends LinkedSemanticByteOwnerTableName,
>(
  tx: Transaction,
  tableName: TableName,
  next: readonly LinkedSemanticByteOwnerRows[TableName][],
): Promise<ConfigurationOwnerLinkMutationReceipt> {
  if (next.length === 0) return emptyConfigurationOwnerLinkMutationReceipt()
  const ids = new Set<string>()
  for (const row of next) {
    if (ids.has(row.id)) throw new Error(`SemanticByteOwnerBatchIdentityDuplicate:${tableName}`)
    ids.add(row.id)
  }
  await addPhysicalStorageRows<AllSemanticByteOwnerRow, string>(tx, tableName, next)
  for (const row of next) recordSemanticConfigurationMutation(tx, tableName, undefined, row)
  return addConfigurationOwnerLinks(
    tx,
    next.map((row) => linkedSemanticByteOwnerTransition(tableName, undefined, row)),
  )
}

async function addSemanticByteOwnerRaw<TableName extends AllSemanticByteOwnerTableName>(
  tx: Transaction,
  tableName: TableName,
  next: AllSemanticByteOwnerRow,
): Promise<void> {
  await addPhysicalStorageRow<AllSemanticByteOwnerRow, string>(tx, tableName, next)
  recordSemanticConfigurationMutation(tx, tableName, undefined, next)
}

export async function replaceSemanticByteOwner<TableName extends SemanticByteOwnerTableName>(
  tx: Transaction,
  tableName: TableName,
  next: SemanticByteOwnerRows[TableName],
  previous: SemanticByteOwnerRows[TableName],
): Promise<void> {
  await replaceSemanticByteOwnerRaw(tx, tableName, next, previous)
}

export async function replaceLinkedSemanticByteOwner<
  TableName extends LinkedSemanticByteOwnerTableName,
>(
  tx: Transaction,
  tableName: TableName,
  next: LinkedSemanticByteOwnerRows[TableName],
  previous: LinkedSemanticByteOwnerRows[TableName],
): Promise<ConfigurationOwnerLinkMutationReceipt> {
  return replaceLinkedSemanticByteOwnerBatch(tx, tableName, [next], [previous])
}

async function replaceSemanticByteOwnerRaw<TableName extends AllSemanticByteOwnerTableName>(
  tx: Transaction,
  tableName: TableName,
  next: AllSemanticByteOwnerRow,
  previous: AllSemanticByteOwnerRow,
): Promise<void> {
  if (next.id !== previous.id) throw new Error(`SemanticByteOwnerIdentityMismatch:${tableName}`)
  await replacePhysicalStorageRow<AllSemanticByteOwnerRow, string>(tx, tableName, next, previous)
  recordSemanticConfigurationMutation(tx, tableName, previous, next)
}

export async function putSemanticByteOwner<TableName extends SemanticByteOwnerTableName>(
  tx: Transaction,
  tableName: TableName,
  next: SemanticByteOwnerRows[TableName],
  previous: SemanticByteOwnerRows[TableName] | undefined,
): Promise<void> {
  if (!previous) {
    await addSemanticByteOwner(tx, tableName, next)
    return
  }
  await replaceSemanticByteOwner(tx, tableName, next, previous)
}

export async function deleteSemanticByteOwner<TableName extends SemanticByteOwnerTableName>(
  tx: Transaction,
  tableName: TableName,
  key: SemanticByteOwnerKeys[TableName],
  previous: SemanticByteOwnerRows[TableName],
): Promise<void> {
  await deleteSemanticByteOwnerRaw(tx, tableName, key, previous)
}

export async function deleteLinkedSemanticByteOwner<
  TableName extends LinkedSemanticByteOwnerTableName,
>(
  tx: Transaction,
  tableName: TableName,
  key: LinkedSemanticByteOwnerKeys[TableName],
  previous: LinkedSemanticByteOwnerRows[TableName],
): Promise<ConfigurationOwnerLinkMutationReceipt> {
  await deleteSemanticByteOwnerRaw(tx, tableName, key, previous)
  return applyConfigurationOwnerLinkTransitions(tx, [
    linkedSemanticByteOwnerTransition(tableName, previous, undefined),
  ])
}

export async function deleteLinkedSemanticByteOwnerBatchRepairingLinks<
  TableName extends LinkedSemanticByteOwnerTableName,
>(
  tx: Transaction,
  tableName: TableName,
  keys: readonly LinkedSemanticByteOwnerKeys[TableName][],
  previous: readonly LinkedSemanticByteOwnerRows[TableName][],
): Promise<void> {
  if (keys.length !== previous.length || keys.some((key, index) => previous[index]?.id !== key)) {
    throw new Error(`SemanticByteOwnerBatchIdentityMismatch:${tableName}`)
  }
  const ownerKind = linkedSemanticByteOwnerKind(tableName)
  await deletePhysicalStorageRows<AllSemanticByteOwnerRow, string>(tx, tableName, keys, previous)
  for (const row of previous) recordSemanticConfigurationMutation(tx, tableName, row, undefined)
  await applyConfigurationOwnerLinkTransitions(
    tx,
    previous.map((row) => {
      return {
        kind: 'repair-delete',
        ownerKind,
        ownerId: row.id,
        accountedPrevious: linkedSemanticByteOwnerLinks(tableName, row),
        next: [],
      }
    }),
  )
}

async function deleteSemanticByteOwnerRaw<TableName extends AllSemanticByteOwnerTableName>(
  tx: Transaction,
  tableName: TableName,
  key: string,
  previous: AllSemanticByteOwnerRow,
): Promise<void> {
  if (previous.id !== key) throw new Error(`SemanticByteOwnerIdentityMismatch:${tableName}`)
  await deletePhysicalStorageRows<AllSemanticByteOwnerRow, string>(tx, tableName, [key], [previous])
  recordSemanticConfigurationMutation(tx, tableName, previous, undefined)
}

export async function replaceLinkedSemanticByteOwnerBatch<
  TableName extends LinkedSemanticByteOwnerTableName,
>(
  tx: Transaction,
  tableName: TableName,
  next: readonly LinkedSemanticByteOwnerRows[TableName][],
  previous: readonly LinkedSemanticByteOwnerRows[TableName][],
): Promise<ConfigurationOwnerLinkMutationReceipt> {
  await replaceSemanticByteOwnerBatchRaw(tx, tableName, next, previous)
  const transitions = next.flatMap((row, index) => {
    const previousRow = previous[index]
    return previousRow && sameLinkedSemanticByteOwnerLinks(tableName, previousRow, row)
      ? []
      : [linkedSemanticByteOwnerTransition(tableName, previousRow, row)]
  })
  return applyConfigurationOwnerLinkTransitions(tx, transitions)
}

export async function replaceLinkedSemanticByteOwnerPreservingLinksBatch<
  TableName extends LinkedSemanticByteOwnerTableName,
>(
  tx: Transaction,
  tableName: TableName,
  next: readonly LinkedSemanticByteOwnerRows[TableName][],
  previous: readonly LinkedSemanticByteOwnerRows[TableName][],
): Promise<void> {
  if (
    next.length !== previous.length ||
    next.some((row, index) => {
      const previousRow = previous[index]
      return (
        previousRow === undefined ||
        row.id !== previousRow.id ||
        !sameLinkedSemanticByteOwnerLinks(tableName, previousRow, row)
      )
    })
  ) {
    throw new Error(`SemanticByteOwnerPreservingLinksMismatch:${tableName}`)
  }
  await replaceSemanticByteOwnerBatchRaw(tx, tableName, next, previous)
}

async function replaceSemanticByteOwnerBatchRaw<TableName extends AllSemanticByteOwnerTableName>(
  tx: Transaction,
  tableName: TableName,
  next: readonly AllSemanticByteOwnerRow[],
  previous: readonly AllSemanticByteOwnerRow[],
): Promise<void> {
  const ids = new Set<string>()
  if (
    next.length !== previous.length ||
    next.some((row, index) => {
      if (row.id !== previous[index]?.id || ids.has(row.id)) return true
      ids.add(row.id)
      return false
    })
  ) {
    throw new Error(`SemanticByteOwnerBatchIdentityMismatch:${tableName}`)
  }
  await putPhysicalStorageRows<AllSemanticByteOwnerRow, string>(tx, tableName, next, previous)
  for (let index = 0; index < next.length; index += 1) {
    recordSemanticConfigurationMutation(tx, tableName, previous[index], next[index])
  }
}

function linkedSemanticByteOwnerLinks<TableName extends LinkedSemanticByteOwnerTableName>(
  tableName: TableName,
  row: LinkedSemanticByteOwnerRows[TableName],
): readonly ConfigurationLink[] {
  if (tableName === 'chats') return configurationLinksForChat(row as Chat)
  if (tableName === 'profiles') return configurationLinksForProfile(row as ConnectionProfile)
  return configurationLinksForPreset(row as ChatPreset)
}

function linkedSemanticByteOwnerKind<TableName extends LinkedSemanticByteOwnerTableName>(
  tableName: TableName,
): ConfigurationLinkOwnerKind {
  if (tableName === 'chats') return 'chat'
  if (tableName === 'profiles') return 'profile'
  return 'chat-preset'
}

function linkedSemanticByteOwnerTransition<TableName extends LinkedSemanticByteOwnerTableName>(
  tableName: TableName,
  previous: LinkedSemanticByteOwnerRows[TableName] | undefined,
  next: LinkedSemanticByteOwnerRows[TableName] | undefined,
): ExactConfigurationOwnerLinkTransition {
  const row = next ?? previous
  if (!row) throw new Error(`LinkedSemanticByteOwnerTransitionEmpty:${tableName}`)
  return {
    kind: 'exact',
    ownerKind: linkedSemanticByteOwnerKind(tableName),
    ownerId: row.id,
    previous: previous ? linkedSemanticByteOwnerLinks(tableName, previous) : [],
    next: next ? linkedSemanticByteOwnerLinks(tableName, next) : [],
  }
}

function sameLinkedSemanticByteOwnerLinks<TableName extends LinkedSemanticByteOwnerTableName>(
  tableName: TableName,
  previous: LinkedSemanticByteOwnerRows[TableName],
  next: LinkedSemanticByteOwnerRows[TableName],
): boolean {
  const previousLinks = linkedSemanticByteOwnerLinks(tableName, previous)
  const nextLinks = linkedSemanticByteOwnerLinks(tableName, next)
  return sameConfigurationValue(previousLinks, nextLinks)
}

function recordSemanticConfigurationMutation(
  tx: Transaction,
  tableName: AllSemanticByteOwnerTableName,
  previous: AllSemanticByteOwnerRow | undefined,
  next: AllSemanticByteOwnerRow | undefined,
): void {
  const invalidations = (() => {
    switch (tableName) {
      case 'profiles':
        return workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'profile',
          previous: previous as ConnectionProfile | undefined,
          next: next as ConnectionProfile | undefined,
        })
      case 'presets':
        return workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'preset',
          previous: previous as ChatPreset | undefined,
          next: next as ChatPreset | undefined,
        })
      case 'promptPresets':
        return workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'prompt-preset',
          previous: previous as PromptPreset | undefined,
          next: next as PromptPreset | undefined,
        })
      case 'keys':
        return workspaceDependenciesForConfigurationSemanticMutation({
          kind: 'key',
          previous: previous as KeyRecord | undefined,
          next: next as KeyRecord | undefined,
        })
      case 'chats':
        return []
    }
  })()
  for (const invalidation of invalidations) {
    recordBrowserCommandInvalidation(tx, invalidation)
  }
}

export async function putUserSettingByteOwner(
  tx: Transaction,
  next: SettingsRow,
  previous: SettingsRow | undefined,
): Promise<void> {
  assertUserSettingKey(next.key)
  if (previous) {
    assertUserSettingKey(previous.key)
  }
  await putPhysicalStorageRow<SettingsRow, string>(tx, 'settings', next, previous)
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'setting', keys: [next.key] })
}

export async function putUserSettingByteOwners(
  tx: Transaction,
  next: readonly SettingsRow[],
  previous: readonly (SettingsRow | undefined)[],
): Promise<void> {
  if (
    next.length !== previous.length ||
    next.some((row, index) => {
      const prior = previous[index]
      return prior !== undefined && prior.key !== row.key
    })
  ) {
    throw new Error('UserSettingByteOwnerBatchIdentityMismatch')
  }
  for (const row of next) assertUserSettingKey(row.key)
  const replaced = previous.filter((row): row is SettingsRow => row !== undefined)
  for (const row of replaced) assertUserSettingKey(row.key)
  await putPhysicalStorageRows<SettingsRow, string>(tx, 'settings', next, replaced)
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'setting',
    keys: next.map((row) => row.key),
  })
}

export async function deleteUserSettingByteOwner(
  tx: Transaction,
  previous: SettingsRow,
): Promise<void> {
  assertUserSettingKey(previous.key)
  await deletePhysicalStorageRows<SettingsRow, string>(tx, 'settings', [previous.key], [previous])
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'setting', keys: [previous.key] })
}

export async function putTokenCalibrationSettingByteOwner(
  tx: Transaction,
  next: SettingsRow & { readonly key: 'global:token-calibration' },
  previous: SettingsRow | undefined,
): Promise<void> {
  if (previous && previous.key !== next.key) {
    throw new Error('TokenCalibrationSettingKeyMismatch')
  }
  await putPhysicalStorageRow<SettingsRow, string>(tx, 'settings', next, previous)
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'setting', keys: [next.key] })
}

export async function recordObsoleteByteOwnerValues(
  tx: Transaction,
  values: readonly unknown[],
): Promise<void> {
  let obsoleteBytes = 0
  for (const value of values) {
    if (value === undefined) continue
    obsoleteBytes = saturatingAdd(obsoleteBytes, estimateStoredValueBytes(value))
  }
  await recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
}

export function recordObsoleteByteOwnerBytes(
  tx: Transaction,
  obsoleteBytes: number,
): Promise<void> {
  if (obsoleteBytes === 0) return Promise.resolve()
  accumulateStorageCompactionDebt(tx, obsoleteBytes)
  return Promise.resolve()
}

export async function insertMessageBody(tx: Transaction, body: MessageBodyRow): Promise<void> {
  await addPhysicalStorageRow<MessageBodyRow, string>(tx, 'messageBodies', body)
}

export async function replaceMessageBody(
  tx: Transaction,
  body: MessageBodyRow,
  previous:
    | { readonly kind: 'row'; readonly row: MessageBodyRow }
    | { readonly kind: 'header-projection'; readonly header: MessageHeaderRow },
): Promise<void> {
  const previousId = previous.kind === 'row' ? previous.row.id : previous.header.id
  if (body.id !== previousId) {
    throw new Error('MessageBodyIdentityMismatch')
  }
  if (previous.kind === 'row') {
    await replacePhysicalStorageRow<MessageBodyRow, string>(tx, 'messageBodies', body, previous.row)
  } else {
    await recordObsoleteByteOwnerBytes(
      tx,
      estimateMessageBodyProjectionStorageBytes(previous.header),
    )
    await replacePhysicalStorageRow<MessageBodyRow, string>(tx, 'messageBodies', body, undefined)
  }
}

export async function deleteChatAuxiliaryByteOwners(
  tx: Transaction,
  input: {
    readonly chatIds: readonly ChatId[]
    readonly messageBodyProjectionBytes: number
  },
): Promise<void> {
  const drafts = await tx.table<DraftRow, string>('drafts').bulkGet([...input.chatIds])
  const deletedDraftChatIds = drafts.flatMap((draft) => (draft ? [draft.chatId] : []))
  const [deletedBodies] = await Promise.all([
    deleteChatOwnedPhysicalStorageCollectionWithKnownBytes<MessageBodyRow, string>(
      tx,
      'messageBodies',
      input.chatIds,
      input.messageBodyProjectionBytes,
    ),
    deletedDraftChatIds.length > 0
      ? deletePhysicalStorageKeys<DraftRow, string>(tx, 'drafts', deletedDraftChatIds)
      : Promise.resolve(),
  ])
  if (deletedDraftChatIds.length > 0) {
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'draft',
      chatIds: deletedDraftChatIds,
    })
  }
  const deletedBodyFallback =
    input.messageBodyProjectionBytes === 0
      ? estimateDeletedCompactRowsStorageBytes(deletedBodies)
      : input.messageBodyProjectionBytes
  let obsoleteBytes = deletedBodyFallback
  for (const value of drafts) {
    if (value !== undefined) {
      obsoleteBytes = saturatingAdd(obsoleteBytes, estimateStoredValueBytes(value))
    }
  }
  await recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
}

export async function putDraftByteOwner(
  tx: Transaction,
  next: DraftRow,
  previous: DraftRow | undefined,
): Promise<void> {
  if (previous && previous.chatId !== next.chatId) throw new Error('DraftByteOwnerIdentityMismatch')
  await putPhysicalStorageRow<DraftRow, string>(tx, 'drafts', next, previous)
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'draft', chatIds: [next.chatId] })
}

export async function addTextTemplateByteOwner(
  tx: Transaction,
  template: SavedTextTemplate,
): Promise<void> {
  await addPhysicalStorageRow<SavedTextTemplate, TextTemplateId>(tx, 'textTemplates', template)
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'text-template',
    templateIds: [template.id],
  })
}

export async function replaceTextTemplateByteOwner(
  tx: Transaction,
  next: SavedTextTemplate,
  previous: SavedTextTemplate,
): Promise<void> {
  if (next.id !== previous.id) throw new Error('TextTemplateByteOwnerIdentityMismatch')
  await replacePhysicalStorageRow<SavedTextTemplate, TextTemplateId>(
    tx,
    'textTemplates',
    next,
    previous,
  )
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'text-template', templateIds: [next.id] })
}

export async function deleteTextTemplateByteOwner(
  tx: Transaction,
  templateId: TextTemplateId,
  previous: SavedTextTemplate,
): Promise<void> {
  await deletePhysicalStorageRows<SavedTextTemplate, TextTemplateId>(
    tx,
    'textTemplates',
    [templateId],
    [previous],
  )
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'text-template', templateIds: [templateId] })
}

export async function putAttachmentBlobByteOwner(
  tx: Transaction,
  next: AttachmentBlob,
  previous: AttachmentBlob | undefined,
): Promise<void> {
  await putAttachmentByteOwner(tx, 'attachmentBlobs', next, previous)
}

export async function addAttachmentBlobByteOwners(
  tx: Transaction,
  rows: readonly AttachmentBlob[],
): Promise<void> {
  await addAttachmentByteOwners(tx, 'attachmentBlobs', rows)
}

export async function putAttachmentHeaderByteOwner(
  tx: Transaction,
  next: AttachmentHeaderRow,
  previous: AttachmentHeaderRow | undefined,
): Promise<void> {
  if (previous && previous.id !== next.id) throw new Error('AttachmentHeaderIdentityMismatch')
  await putPhysicalStorageRow<AttachmentHeaderRow, AttachmentId>(tx, 'attachments', next, previous)
  recordBrowserCommandAttachmentRow(tx, next.id, true)
  recordBrowserCommandOwnerInvalidation(tx, { kind: 'attachment', attachmentIds: [next.id] })
}

export async function deleteAttachmentHeaderByteOwner(
  tx: Transaction,
  previous: AttachmentHeaderRow,
): Promise<void> {
  await deletePhysicalStorageRows<AttachmentHeaderRow, AttachmentId>(
    tx,
    'attachments',
    [previous.id],
    [previous],
  )
  recordBrowserCommandAttachmentRow(tx, previous.id, false)
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'attachment',
    attachmentIds: [previous.id],
  })
}

export async function replaceAttachmentHeaderByteOwnerBatch(
  tx: Transaction,
  next: readonly AttachmentHeaderRow[],
  previous: readonly AttachmentHeaderRow[],
): Promise<void> {
  if (
    next.length !== previous.length ||
    next.some((row, index) => row.id !== previous[index]?.id)
  ) {
    throw new Error('AttachmentHeaderBatchIdentityMismatch')
  }
  await putPhysicalStorageRows<AttachmentHeaderRow, AttachmentId>(tx, 'attachments', next, previous)
  for (const row of next) recordBrowserCommandAttachmentRow(tx, row.id, true)
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'attachment',
    attachmentIds: next.map((row) => row.id),
  })
}

export async function putAttachmentArtifactByteOwner(
  tx: Transaction,
  next: AttachmentArtifact,
  previous: AttachmentArtifact | undefined,
): Promise<void> {
  await putAttachmentByteOwner(tx, 'attachmentArtifacts', next, previous)
}

export async function addAttachmentArtifactByteOwners(
  tx: Transaction,
  rows: readonly AttachmentArtifact[],
): Promise<void> {
  await addAttachmentByteOwners(tx, 'attachmentArtifacts', rows)
}

export async function putAttachmentJobByteOwner(
  tx: Transaction,
  next: AttachmentJob,
  previous: AttachmentJob | undefined,
): Promise<void> {
  await putAttachmentByteOwner(tx, 'attachmentJobs', next, previous)
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'attachment-job',
    attachmentIds: [next.attachmentId],
    jobIds: [next.id],
  })
}

export async function addAttachmentJobByteOwners(
  tx: Transaction,
  rows: readonly AttachmentJob[],
): Promise<void> {
  await addAttachmentByteOwners(tx, 'attachmentJobs', rows)
  if (rows.length === 0) return
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'attachment-job',
    attachmentIds: [...new Set(rows.map((row) => row.attachmentId))],
    jobIds: rows.map((row) => row.id),
  })
}

export async function deleteAttachmentArtifactByteOwner(
  tx: Transaction,
  artifactId: string,
  previous: AttachmentArtifact,
): Promise<void> {
  await deleteAttachmentByteOwner(tx, 'attachmentArtifacts', artifactId, previous)
}

export async function deleteAttachmentJobByteOwner(
  tx: Transaction,
  jobId: string,
  previous: AttachmentJob,
): Promise<void> {
  await deleteAttachmentByteOwner(tx, 'attachmentJobs', jobId, previous)
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'attachment-job',
    attachmentIds: [previous.attachmentId],
    jobIds: [jobId],
  })
}

export async function deleteAttachmentByteOwnerBundle(
  tx: Transaction,
  attachmentId: AttachmentId,
  header: AttachmentHeaderRow,
): Promise<{ blobs: number; artifacts: number; jobs: number }> {
  return replaceAttachmentByteOwnerBundle(tx, attachmentId, header, {
    blobs: [],
    artifacts: [],
    jobs: [],
  })
}

export async function replaceAttachmentByteOwnerBundle(
  tx: Transaction,
  attachmentId: AttachmentId,
  header: AttachmentHeaderRow | undefined,
  next: {
    readonly blobs: readonly AttachmentBlob[]
    readonly artifacts: readonly AttachmentArtifact[]
    readonly jobs: readonly AttachmentJob[]
  },
): Promise<{ blobs: number; artifacts: number; jobs: number }> {
  if (
    next.blobs.some((row) => row.attachmentId !== attachmentId) ||
    next.artifacts.some((row) => row.attachmentId !== attachmentId) ||
    next.jobs.some((row) => row.attachmentId !== attachmentId)
  ) {
    throw new Error(`AttachmentPayloadIdentityMismatch:${attachmentId}`)
  }
  const [blobKeys, artifactKeys, jobKeys] = await Promise.all([
    attachmentRowKeys(tx, 'attachmentBlobs', attachmentId),
    attachmentRowKeys(tx, 'attachmentArtifacts', attachmentId),
    attachmentRowKeys(tx, 'attachmentJobs', attachmentId),
  ])
  recordBrowserCommandAttachmentPayloadDeletion(tx, 'attachmentBlobs', blobKeys, attachmentId)
  recordBrowserCommandAttachmentPayloadDeletion(
    tx,
    'attachmentArtifacts',
    artifactKeys,
    attachmentId,
  )
  recordBrowserCommandAttachmentPayloadDeletion(tx, 'attachmentJobs', jobKeys, attachmentId)
  await Promise.all([
    deletePhysicalStorageKeys(tx, 'attachmentBlobs', blobKeys),
    deletePhysicalStorageKeys(tx, 'attachmentArtifacts', artifactKeys),
    deletePhysicalStorageKeys(tx, 'attachmentJobs', jobKeys),
  ])
  const blobs = blobKeys.length
  const artifacts = artifactKeys.length
  const jobs = jobKeys.length
  const obsoleteBytes = saturatingAdd(
    header ? estimateAttachmentPayloadProjectionStorageBytes(header) : 0,
    estimateDeletedCompactRowsStorageBytes(blobs + artifacts + jobs),
  )
  await recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
  await Promise.all([
    addAttachmentBlobByteOwners(tx, next.blobs),
    addAttachmentArtifactByteOwners(tx, next.artifacts),
    addAttachmentByteOwners(tx, 'attachmentJobs', next.jobs),
  ])
  if (jobs > 0 || next.jobs.length > 0) {
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'attachment-job',
      attachmentIds: [attachmentId],
      jobIds: [...jobKeys, ...next.jobs.map((job) => job.id)],
    })
  }
  return { blobs, artifacts, jobs }
}

export async function deleteAttachmentBlobRows(
  tx: Transaction,
  attachmentId: AttachmentId,
  header: AttachmentHeaderRow | undefined,
): Promise<number> {
  const deleted = await deleteAttachmentRows(tx, 'attachmentBlobs', attachmentId)
  if (deleted > 0) {
    await recordObsoleteByteOwnerBytes(
      tx,
      saturatingAdd(
        estimateAttachmentPayloadProjectionStorageBytes({ sizeBytes: header?.sizeBytes ?? 0 }),
        estimateDeletedCompactRowsStorageBytes(deleted),
      ),
    )
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'attachment-job',
      attachmentIds: [attachmentId],
    })
  }
  return deleted
}

export async function deleteAttachmentArtifactRows(
  tx: Transaction,
  attachmentId: AttachmentId,
  header: AttachmentHeaderRow | undefined,
): Promise<number> {
  const deleted = await deleteAttachmentRows(tx, 'attachmentArtifacts', attachmentId)
  if (deleted > 0) {
    await recordObsoleteByteOwnerBytes(
      tx,
      saturatingAdd(
        estimateAttachmentPayloadProjectionStorageBytes({
          textCharCount: header?.textCharCount ?? 0,
        }),
        estimateDeletedCompactRowsStorageBytes(deleted),
      ),
    )
  }
  return deleted
}

export async function deleteAttachmentJobRows(
  tx: Transaction,
  attachmentId: AttachmentId,
): Promise<number> {
  const deleted = await deleteAttachmentRows(tx, 'attachmentJobs', attachmentId)
  if (deleted > 0) {
    await recordObsoleteByteOwnerBytes(tx, estimateDeletedCompactRowsStorageBytes(deleted))
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'attachment-job',
      attachmentIds: [attachmentId],
    })
  }
  return deleted
}

type AttachmentByteOwnerTableName = 'attachmentBlobs' | 'attachmentArtifacts' | 'attachmentJobs'

async function addAttachmentByteOwners<Row>(
  tx: Transaction,
  tableName: AttachmentByteOwnerTableName,
  rows: readonly Row[],
): Promise<void> {
  await addPhysicalStorageRows<Row, string>(tx, tableName, rows)
}

async function putAttachmentByteOwner<Row>(
  tx: Transaction,
  tableName: AttachmentByteOwnerTableName,
  next: Row,
  previous: Row | undefined,
): Promise<void> {
  await putPhysicalStorageRow<Row, string>(tx, tableName, next, previous)
}

async function deleteAttachmentByteOwner<Row>(
  tx: Transaction,
  tableName: AttachmentByteOwnerTableName,
  key: string,
  previous: Row,
): Promise<void> {
  await deletePhysicalStorageRows<Row, string>(tx, tableName, [key], [previous])
}

function deleteAttachmentRows(
  tx: Transaction,
  tableName: AttachmentByteOwnerTableName,
  attachmentId: AttachmentId,
): Promise<number> {
  return attachmentRowKeys(tx, tableName, attachmentId).then(async (keys) => {
    if (keys.length === 0) return 0
    recordBrowserCommandAttachmentPayloadDeletion(tx, tableName, keys, attachmentId)
    await deletePhysicalStorageKeys(tx, tableName, keys)
    return keys.length
  })
}

function attachmentRowKeys(
  tx: Transaction,
  tableName: AttachmentByteOwnerTableName,
  attachmentId: AttachmentId,
): Promise<string[]> {
  return tx
    .table<AttachmentBlob | AttachmentArtifact | AttachmentJob, string>(tableName)
    .where('attachmentId')
    .equals(attachmentId)
    .primaryKeys()
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function assertUserSettingKey(key: string): void {
  if (
    key === 'workspace-meta' ||
    key === 'stream-admission-sequence' ||
    key === 'global:token-calibration' ||
    key.startsWith('backfill:') ||
    key.startsWith('projection:')
  ) {
    throw new Error(`InternalSettingByteOwnerForbidden:${key}`)
  }
}

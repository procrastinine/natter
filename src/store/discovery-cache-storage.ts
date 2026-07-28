import type { Transaction } from 'dexie'
import {
  recordBrowserCommandDiscoveryCacheMaintenance,
  recordBrowserCommandOwnerInvalidation,
} from './browser-command-mutation-journal'
import {
  addPhysicalStorageRow,
  deletePhysicalStorageKeys,
  deletePhysicalStorageRows,
  putPhysicalStorageRow,
  recordObsoleteByteOwnerBytes,
} from './byte-owner-mutation'
import type {
  CachedEndpointsRow,
  CachedEndpointsStorageRow,
  CachedModelsRow,
  CachedModelsStorageRow,
  CachedPrivacyPolicyRow,
  CachedPrivacyPolicyStorageRow,
  DiscoveryCacheAuditStorageRow,
  DiscoveryCacheStateStorageRow,
  DiscoveryPayloadMetadataStorageRow,
  DiscoveryPayloadStorageRow,
} from './db-rows'
import { exactCompoundPrefixBetween } from './indexeddb-key-ranges'
import { type PhysicalStorageTableName, physicalStorageTables } from './physical-storage-tables'
import type {
  SemanticOperationExactReceiptAccumulator,
  SemanticOperationReplayPlan,
} from './semantic-operation-capability'
import { boundedMaintenanceLimit } from './storage-maintenance-bounds'
import { estimateStoredValueBytes } from './storage-size-estimate'
import {
  type DiscoveryCacheKind,
  discoveryCacheKey,
  type WorkspaceDependency,
} from './workspace-protocol'

export const DISCOVERY_CACHE_MUTATION_TRANSACTION_CAPABILITY = physicalStorageTables(
  'discoveryCacheState',
  'discoveryPayloadMetadata',
  'discoveryPayloads',
  'models',
  'endpoints',
  'privacyPolicies',
)

export const DISCOVERY_CACHE_LIMITS = Object.freeze({
  maxPayloadByteLength: 8 * 1024 * 1024,
  maxUniquePayloadByteLength: 64 * 1024 * 1024,
  maxEvictionsPerWrite: 64,
  perProfileRows: Object.freeze({
    models: 16,
    endpoints: 256,
    privacyPolicies: 256,
  }),
  globalRows: Object.freeze({
    models: 64,
    endpoints: 512,
    privacyPolicies: 512,
  }),
})

export type DiscoveryCacheStorageTable = keyof typeof DISCOVERY_CACHE_LIMITS.globalRows

type PublicRowByTable = {
  models: CachedModelsRow
  endpoints: CachedEndpointsRow
  privacyPolicies: CachedPrivacyPolicyRow
}

type StorageRowByTable = {
  models: CachedModelsStorageRow
  endpoints: CachedEndpointsStorageRow
  privacyPolicies: CachedPrivacyPolicyStorageRow
}

export interface PreparedDiscoveryPayload {
  readonly cacheable: boolean
  readonly id: string
  readonly canonicalJson: string
  readonly byteLength: number
}

export interface DiscoveryCacheEviction {
  readonly tableName: DiscoveryCacheStorageTable
  readonly profileId: string
  readonly discriminator: string
}

export interface DiscoveryCachePutResult {
  readonly accepted: true
  readonly cacheChanged: boolean
  readonly cached: boolean
  readonly repairRequired: boolean
  readonly evictions: readonly DiscoveryCacheEviction[]
}

export interface DiscoveryCacheMaintenanceResult {
  readonly scanned: number
  readonly deletedPayloads: number
  readonly evictions: readonly DiscoveryCacheEviction[]
  readonly done: boolean
  readonly replay: SemanticOperationReplayPlan
}

export interface DiscoveryCacheProfileClearReceipt {
  readonly profileId: string
  readonly deleted: number
  readonly evictions: readonly DiscoveryCacheEviction[]
  readonly repairRequired: boolean
}

export interface DiscoveryCacheReadEvidence<Row> {
  readonly row: Row | undefined
  readonly headerFound: boolean
  readonly metadataFound: boolean
  readonly payloadFound: boolean
  readonly storageRow?:
    | CachedModelsStorageRow
    | CachedEndpointsStorageRow
    | CachedPrivacyPolicyStorageRow
  readonly metadata?: DiscoveryPayloadMetadataStorageRow
}

type DiscoveryCacheReceiptAccumulator =
  SemanticOperationExactReceiptAccumulator<PhysicalStorageTableName>

const DISCOVERY_CACHE_STATE_ID = 'global' as const
const DISCOVERY_CACHE_STATE_FORMAT_VERSION = 1 as const
const TABLE_ORDER: readonly DiscoveryCacheStorageTable[] = [
  'models',
  'endpoints',
  'privacyPolicies',
]

export async function prepareDiscoveryPayload(
  tableName: DiscoveryCacheStorageTable,
  payload: unknown,
): Promise<PreparedDiscoveryPayload> {
  const canonicalJson = canonicalJsonForStorage(tableName, payload)
  if (canonicalJson.length > DISCOVERY_CACHE_LIMITS.maxPayloadByteLength) {
    return {
      cacheable: false,
      id: '',
      canonicalJson: '',
      byteLength: canonicalJson.length,
    }
  }
  const bytes = new TextEncoder().encode(canonicalJson)
  if (bytes.byteLength > DISCOVERY_CACHE_LIMITS.maxPayloadByteLength) {
    return {
      cacheable: false,
      id: '',
      canonicalJson: '',
      byteLength: bytes.byteLength,
    }
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return {
    cacheable: true,
    id: `sha256:${hex(new Uint8Array(digest))}`,
    canonicalJson,
    byteLength: bytes.byteLength,
  }
}

export async function readDiscoveryCacheRow<T extends DiscoveryCacheStorageTable>(
  tx: Transaction,
  tableName: T,
  key: string | [string, string],
): Promise<PublicRowByTable[T] | undefined> {
  return (await readDiscoveryCacheRowWithEvidence(tx, tableName, key)).row
}

export async function readDiscoveryCacheRowWithEvidence<T extends DiscoveryCacheStorageTable>(
  tx: Transaction,
  tableName: T,
  key: string | [string, string],
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<DiscoveryCacheReadEvidence<PublicRowByTable[T]>> {
  const stored = await tx.table<StorageRowByTable[T], string | [string, string]>(tableName).get(key)
  recordDiscoveryCacheRead(receipt, tableName, 'primary', undefined, 'get', 1, 1)
  if (!stored) {
    return {
      row: undefined,
      headerFound: false,
      metadataFound: false,
      payloadFound: false,
    }
  }
  const [metadata, payload] = await Promise.all([
    tx
      .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
      .get(stored.payloadId),
    tx.table<DiscoveryPayloadStorageRow, string>('discoveryPayloads').get(stored.payloadId),
  ])
  recordDiscoveryCacheRead(receipt, 'discoveryPayloadMetadata', 'primary', undefined, 'get', 1, 1)
  recordDiscoveryCacheRead(receipt, 'discoveryPayloads', 'primary', undefined, 'get', 1, 1)
  if (
    !metadata ||
    !payload ||
    metadata.referenceCount < 1 ||
    metadata.byteLength !== stored.payloadByteLength ||
    payload.byteLength !== stored.payloadByteLength
  ) {
    return {
      row: undefined,
      headerFound: true,
      metadataFound: metadata !== undefined,
      payloadFound: payload !== undefined,
      storageRow: stored,
      ...(metadata ? { metadata } : {}),
    }
  }
  const decoded = JSON.parse(payload.canonicalJson) as unknown
  return {
    row: hydratePublicRow(tableName, stored, decoded),
    headerFound: true,
    metadataFound: true,
    payloadFound: true,
    storageRow: stored,
    metadata,
  }
}

function discoveryStorageRow<T extends DiscoveryCacheStorageTable>(
  tableName: T,
  row: PublicRowByTable[T],
  payload: PreparedDiscoveryPayload,
): StorageRowByTable[T] {
  if (!payload.cacheable) throw new Error(`DiscoveryPayloadNotCacheable:${tableName}`)
  const common = {
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    fetchedAt: row.fetchedAt,
    payloadId: payload.id,
    payloadByteLength: payload.byteLength,
  }
  if (tableName === 'models') {
    return { ...common, queryKey: (row as CachedModelsRow).queryKey } as StorageRowByTable[T]
  }
  return { ...common, modelId: (row as CachedEndpointsRow).modelId } as StorageRowByTable[T]
}

export async function seedEmptyDiscoveryCacheState(tx: Transaction): Promise<void> {
  const table = tx.table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
  const previous = await table.get(DISCOVERY_CACHE_STATE_ID)
  await putPhysicalStorageRow(tx, 'discoveryCacheState', emptyDiscoveryCacheState(true), previous)
}

export async function putDiscoveryCacheRow<T extends DiscoveryCacheStorageTable>(
  tx: Transaction,
  tableName: T,
  row: PublicRowByTable[T],
  prepared: PreparedDiscoveryPayload,
  options: {
    readonly knownCurrent?: DiscoveryCacheReadEvidence<PublicRowByTable[T]>
    readonly receipt?: DiscoveryCacheReceiptAccumulator
  } = {},
): Promise<DiscoveryCachePutResult> {
  const { knownCurrent, receipt } = options
  if (!prepared.cacheable) {
    return {
      accepted: true,
      cacheChanged: false,
      cached: false,
      repairRequired: false,
      evictions: [],
    }
  }
  const storedState = await tx
    .table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
    .get(DISCOVERY_CACHE_STATE_ID)
  recordDiscoveryCacheRead(receipt, 'discoveryCacheState', 'primary', undefined, 'get', 1, 1)
  const state = isDiscoveryCacheState(storedState) && storedState.valid ? storedState : undefined
  if (!state) {
    await createMissingDiscoveryCacheRepairState(tx, storedState, receipt)
    return {
      accepted: true,
      cacheChanged: false,
      cached: false,
      repairRequired: true,
      evictions: [],
    }
  }
  const table = tx.table<StorageRowByTable[T], [string, string]>(tableName)
  const key = primaryKeyForPublicRow(tableName, row)
  const currentStorage = knownCurrent
    ? (knownCurrent.storageRow as StorageRowByTable[T] | undefined)
    : await table.get(key)
  if (!knownCurrent) {
    recordDiscoveryCacheRead(receipt, tableName, 'primary', undefined, 'get', 1, 1)
  }
  const nextStorage = discoveryStorageRow(tableName, row, prepared)
  const metadataTable = tx.table<DiscoveryPayloadMetadataStorageRow, string>(
    'discoveryPayloadMetadata',
  )
  const knownMetadata = knownCurrent?.metadata
  const metadataIds = [
    ...new Set([currentStorage?.payloadId, nextStorage.payloadId].filter(isString)),
  ]
  const missingMetadataIds = metadataIds.filter((id) => knownMetadata?.id !== id)
  const fetchedMetadata =
    missingMetadataIds.length === 0 ? [] : await metadataTable.bulkGet(missingMetadataIds)
  recordDiscoveryCacheRead(
    receipt,
    'discoveryPayloadMetadata',
    'primary',
    undefined,
    'get-many',
    missingMetadataIds.length > 0 ? 1 : 0,
    missingMetadataIds.length,
  )
  const affectedMetadata = [...(knownMetadata ? [knownMetadata] : []), ...fetchedMetadata]
  const metadataById = new Map(
    affectedMetadata.flatMap((metadata) => (metadata ? [[metadata.id, metadata] as const] : [])),
  )
  const previousMetadataById = new Map(metadataById)
  if (currentStorage && !metadataById.has(currentStorage.payloadId)) {
    await markStateInvalid(tx, state, receipt)
    return {
      accepted: true,
      cacheChanged: false,
      cached: false,
      repairRequired: true,
      evictions: [],
    }
  }
  const existingNextMetadata = metadataById.get(nextStorage.payloadId)
  if (existingNextMetadata && existingNextMetadata.byteLength !== nextStorage.payloadByteLength) {
    await markStateInvalid(tx, state, receipt)
    return {
      accepted: true,
      cacheChanged: false,
      cached: false,
      repairRequired: true,
      evictions: [],
    }
  }

  const projected = cloneStateTotals(state)
  const projectedRefs = new Map<string, DiscoveryPayloadMetadataStorageRow>()
  for (const metadata of metadataById.values()) projectedRefs.set(metadata.id, { ...metadata })
  if (currentStorage?.payloadId !== nextStorage.payloadId) {
    if (currentStorage)
      decrementProjectedPayload(projected, projectedRefs, currentStorage.payloadId)
    incrementProjectedPayload(projected, projectedRefs, prepared, row.fetchedAt)
  }
  if (!currentStorage) projected.headerCounts[tableName] += 1
  const storedProfileKeys = await table
    .where('profileId')
    .equals(row.profileId)
    .limit(DISCOVERY_CACHE_LIMITS.perProfileRows[tableName] + 1)
    .primaryKeys()
  recordDiscoveryCacheRead(
    receipt,
    tableName,
    'secondary',
    'profileId',
    'query',
    1,
    storedProfileKeys.length,
  )
  if (storedProfileKeys.length > DISCOVERY_CACHE_LIMITS.perProfileRows[tableName]) {
    await markStateInvalid(tx, state, receipt)
    return {
      accepted: true,
      cacheChanged: false,
      cached: false,
      repairRequired: true,
      evictions: [],
    }
  }
  const profileCount = storedProfileKeys.length + (currentStorage ? 0 : 1)
  const selected: EvictionCandidate[] = []
  let projectedProfileCount = profileCount
  if (exceedsLimits(projected, tableName, projectedProfileCount)) {
    const candidates = await readEvictionCandidates(
      tx,
      tableName,
      row.profileId,
      key,
      DISCOVERY_CACHE_LIMITS.maxEvictionsPerWrite + 1,
      receipt,
    )
    const candidatePayloadIds = [...new Set(candidates.map((candidate) => candidate.row.payloadId))]
    const candidateMetadata =
      candidatePayloadIds.length === 0 ? [] : await metadataTable.bulkGet(candidatePayloadIds)
    recordDiscoveryCacheRead(
      receipt,
      'discoveryPayloadMetadata',
      'primary',
      undefined,
      'get-many',
      candidatePayloadIds.length > 0 ? 1 : 0,
      candidatePayloadIds.length,
    )
    for (const metadata of candidateMetadata) {
      if (!metadata) continue
      if (!projectedRefs.has(metadata.id)) projectedRefs.set(metadata.id, { ...metadata })
      if (!previousMetadataById.has(metadata.id)) previousMetadataById.set(metadata.id, metadata)
    }
    if (candidateMetadata.some((metadata) => metadata === undefined)) {
      await markStateInvalid(tx, state, receipt)
      return {
        accepted: true,
        cacheChanged: false,
        cached: false,
        repairRequired: true,
        evictions: [],
      }
    }
    while (
      exceedsLimits(projected, tableName, projectedProfileCount) &&
      selected.length < DISCOVERY_CACHE_LIMITS.maxEvictionsPerWrite
    ) {
      const candidate = selectEvictionCandidate(
        candidates,
        selected,
        projected,
        tableName,
        row.profileId,
        projectedProfileCount,
      )
      if (!candidate) break
      selected.push(candidate)
      projected.headerCounts[candidate.tableName] -= 1
      if (candidate.tableName === tableName && candidate.row.profileId === row.profileId) {
        projectedProfileCount -= 1
      }
      decrementProjectedPayload(projected, projectedRefs, candidate.row.payloadId)
    }
  }
  if (exceedsLimits(projected, tableName, projectedProfileCount)) {
    return {
      accepted: true,
      cacheChanged: false,
      cached: false,
      repairRequired: false,
      evictions: [],
    }
  }

  const changed = stableStringify(currentStorage) !== stableStringify(nextStorage)
  for (const selectedTableName of TABLE_ORDER) {
    const rows = selected.flatMap((candidate) =>
      candidate.tableName === selectedTableName ? [candidate.row] : [],
    )
    if (rows.length === 0) continue
    await deletePhysicalStorageRows(
      tx,
      selectedTableName,
      rows.map((selectedRow) => primaryKey(selectedTableName, selectedRow)),
      rows,
    )
  }
  if (changed) await putPhysicalStorageRow(tx, tableName, nextStorage, currentStorage)
  if (!existingNextMetadata) {
    if (!(await payloadBodyExists(tx, prepared.id, receipt))) {
      await addPhysicalStorageRow<DiscoveryPayloadStorageRow, string>(tx, 'discoveryPayloads', {
        id: prepared.id,
        canonicalJson: prepared.canonicalJson,
        byteLength: prepared.byteLength,
      })
    }
  }
  for (const [payloadId, metadata] of projectedRefs) {
    if (metadata.referenceCount <= 0) {
      await deleteDiscoveryPayload(tx, payloadId, metadata, undefined, receipt)
      continue
    }
    await putDiscoveryPayloadMetadata(tx, metadata, previousMetadataById.get(payloadId))
  }
  await writeState(tx, projected, state, receipt)
  const evictions = selected.map(evictionForCandidate)
  recordDiscoveryCacheEvictions(tx, evictions, receipt)
  if (changed) recordDiscoveryCacheRowInvalidation(tx, tableName, nextStorage, receipt)
  return {
    accepted: true,
    cacheChanged: changed,
    cached: true,
    repairRequired: false,
    evictions,
  }
}

export async function deleteDiscoveryCacheRow(
  tx: Transaction,
  tableName: DiscoveryCacheStorageTable,
  key: [string, string],
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<{ deleted: boolean; evictions: readonly DiscoveryCacheEviction[] }> {
  const table = tx.table<StorageRowByTable[typeof tableName], [string, string]>(tableName)
  const current = await table.get(key)
  recordDiscoveryCacheRead(receipt, tableName, 'primary', undefined, 'get', 1, 1)
  if (!current) return { deleted: false, evictions: [] }
  await deletePhysicalStorageRows(tx, tableName, [key], [current])
  const storedState = await tx
    .table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
    .get(DISCOVERY_CACHE_STATE_ID)
  recordDiscoveryCacheRead(receipt, 'discoveryCacheState', 'primary', undefined, 'get', 1, 1)
  const state = isDiscoveryCacheState(storedState) && storedState.valid ? storedState : undefined
  if (!state) {
    await deletePayloadIfUnreferenced(tx, current.payloadId, receipt)
    await markStateInvalid(tx, storedState, receipt)
  } else {
    const metadata = await tx
      .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
      .get(current.payloadId)
    recordDiscoveryCacheRead(receipt, 'discoveryPayloadMetadata', 'primary', undefined, 'get', 1, 1)
    if (!metadata) {
      await markStateInvalid(tx, state, receipt)
    } else {
      const projected = cloneStateTotals(state)
      const refs = new Map([[metadata.id, { ...metadata }]])
      projected.headerCounts[tableName] -= 1
      decrementProjectedPayload(projected, refs, current.payloadId)
      const next = refs.get(current.payloadId)
      if (!next || next.referenceCount <= 0) {
        await deleteDiscoveryPayload(tx, current.payloadId, metadata, undefined, receipt)
      } else {
        await putDiscoveryPayloadMetadata(tx, next, metadata)
      }
      await writeState(tx, projected, state, receipt)
    }
  }
  const evictions = [evictionForStorageRow(tableName, current)]
  recordDiscoveryCacheEvictions(tx, evictions, receipt)
  return {
    deleted: true,
    evictions,
  }
}

export async function clearDiscoveryCacheProfileRows(
  tx: Transaction,
  tableNames: readonly DiscoveryCacheStorageTable[],
  profileId: string,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<DiscoveryCacheProfileClearReceipt> {
  recordDiscoveryCacheProfileInvalidations(tx, tableNames, profileId)
  const state = await readValidatedState(tx, receipt)
  const boundedRows = await Promise.all(
    tableNames.map((tableName) =>
      tx
        .table<StorageRowByTable[typeof tableName], [string, string]>(tableName)
        .where('profileId')
        .equals(profileId)
        .limit(DISCOVERY_CACHE_LIMITS.perProfileRows[tableName] + 1)
        .toArray(),
    ),
  )
  for (let index = 0; index < tableNames.length; index += 1) {
    const tableName = tableNames[index]
    if (!tableName) continue
    recordDiscoveryCacheRead(
      receipt,
      tableName,
      'secondary',
      'profileId',
      'query',
      1,
      boundedRows[index]?.length ?? 0,
    )
  }
  if (
    !state ||
    tableNames.some(
      (tableName, index) =>
        (boundedRows[index]?.length ?? 0) > DISCOVERY_CACHE_LIMITS.perProfileRows[tableName],
    )
  ) {
    await markStateInvalid(tx, null, receipt)
    return { profileId, deleted: 0, evictions: [], repairRequired: true }
  }
  const rows: Array<{
    tableName: DiscoveryCacheStorageTable
    row: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow
  }> = []
  for (const [index, tableName] of tableNames.entries()) {
    const selected = boundedRows[index] ?? []
    rows.push(...selected.map((row) => ({ tableName, row })))
  }
  if (rows.length === 0) {
    return { profileId, deleted: 0, evictions: [], repairRequired: false }
  }
  const projected = cloneStateTotals(state)
  const metadataTable = tx.table<DiscoveryPayloadMetadataStorageRow, string>(
    'discoveryPayloadMetadata',
  )
  const payloadIds = [...new Set(rows.map(({ row }) => row.payloadId))]
  const metadataRows = await metadataTable.bulkGet(payloadIds)
  recordDiscoveryCacheRead(
    receipt,
    'discoveryPayloadMetadata',
    'primary',
    undefined,
    'get-many',
    1,
    payloadIds.length,
  )
  if (metadataRows.some((metadata) => metadata === undefined)) {
    for (const tableName of tableNames) {
      const tableRows = rows.flatMap(({ tableName: rowTableName, row }) =>
        rowTableName === tableName ? [row] : [],
      )
      await deletePhysicalStorageRows(
        tx,
        tableName,
        tableRows.map((row) => primaryKey(tableName, row)),
        tableRows,
      )
    }
    await markStateInvalid(tx, null, receipt)
    return { profileId, deleted: rows.length, evictions: [], repairRequired: true }
  }
  const refs = new Map(
    metadataRows.flatMap((metadata) => (metadata ? [[metadata.id, { ...metadata }] as const] : [])),
  )
  const previousMetadataById = new Map(
    metadataRows.flatMap((metadata) => (metadata ? [[metadata.id, metadata] as const] : [])),
  )
  for (const { tableName, row } of rows) {
    projected.headerCounts[tableName] -= 1
    decrementProjectedPayload(projected, refs, row.payloadId)
  }
  for (const tableName of tableNames) {
    const tableRows = rows.flatMap(({ tableName: rowTableName, row }) =>
      rowTableName === tableName ? [row] : [],
    )
    await deletePhysicalStorageRows(
      tx,
      tableName,
      tableRows.map((row) => primaryKey(tableName, row)),
      tableRows,
    )
  }
  for (const [payloadId, metadata] of refs) {
    if (metadata.referenceCount <= 0) {
      await deleteDiscoveryPayload(tx, payloadId, metadata, undefined, receipt)
    } else {
      await putDiscoveryPayloadMetadata(tx, metadata, previousMetadataById.get(payloadId))
    }
  }
  await writeState(tx, projected, state, receipt)
  const evictions = rows.map(({ tableName, row }) => evictionForStorageRow(tableName, row))
  recordDiscoveryCacheEvictions(tx, evictions, receipt)
  return {
    profileId,
    deleted: rows.length,
    evictions,
    repairRequired: false,
  }
}

export async function maintainDiscoveryCache(
  tx: Transaction,
  requestedLimit: number,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<DiscoveryCacheMaintenanceResult> {
  const limit = boundedMaintenanceLimit(requestedLimit)
  const stateTable = tx.table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
  const storedState = await stateTable.get(DISCOVERY_CACHE_STATE_ID)
  recordDiscoveryCacheRead(receipt, 'discoveryCacheState', 'primary', undefined, 'get', 1, 1)
  const replay = discoveryCacheMaintenanceReplay(storedState, limit)
  if (isDiscoveryCacheState(storedState) && storedState.valid && !storedState.audit) {
    return { scanned: 0, deletedPayloads: 0, evictions: [], done: true, replay }
  }
  recordBrowserCommandDiscoveryCacheMaintenance(tx)
  const baseState = isDiscoveryCacheState(storedState)
    ? storedState
    : emptyDiscoveryCacheState(false)
  let audit = baseState.audit ? cloneAudit(baseState.audit) : emptyAudit()
  let scanned = 0
  let deletedPayloads = 0
  const evictions: DiscoveryCacheEviction[] = []
  const headerRepairCandidates = await readBoundedDiscoveryHeaderRepairCandidates(tx, receipt)
  if (headerRepairCandidates.length > 0) {
    const selected = headerRepairCandidates.slice(0, limit)
    for (const tableName of TABLE_ORDER) {
      const rows = selected.flatMap((candidate) =>
        candidate.tableName === tableName ? [candidate.row] : [],
      )
      if (rows.length === 0) continue
      await deletePhysicalStorageRows(
        tx,
        tableName,
        rows.map((row) => primaryKey(tableName, row)),
        rows,
      )
    }
    const repairEvictions = selected.map(evictionForCandidate)
    recordDiscoveryCacheEvictions(tx, repairEvictions, receipt)
    await putPhysicalStorageRow(
      tx,
      'discoveryCacheState',
      { ...emptyDiscoveryCacheState(false), audit: emptyAudit() },
      storedState,
    )
    return {
      scanned: selected.length,
      deletedPayloads: 0,
      evictions: repairEvictions,
      done: false,
      replay,
    }
  }
  while (scanned < limit) {
    if (isHeaderPhase(audit.phase)) {
      const page = await readHeaderAuditPage(
        tx,
        audit.phase,
        audit.afterKey,
        limit - scanned,
        receipt,
      )
      scanned += page.rows.length
      for (const row of page.rows) {
        if (row.valid) {
          audit.headerCounts[audit.phase] = saturatingAdd(audit.headerCounts[audit.phase], 1)
        } else {
          await deletePhysicalStorageRows(
            tx,
            audit.phase,
            [primaryKey(audit.phase, row.row)],
            [row.row],
          )
          evictions.push(evictionForStorageRow(audit.phase, row.row))
        }
      }
      if (page.nextAfterKey !== undefined) {
        audit.afterKey = page.nextAfterKey
        break
      }
      audit = advanceAudit(audit)
      continue
    }
    if (audit.phase === 'metadata') {
      const page = await readMetadataAuditPage(tx, audit.afterKey, limit - scanned, receipt)
      scanned += page.rows.length
      for (const row of page.rows) {
        if (!isDiscoveryPayloadMetadata(row)) {
          await deleteDiscoveryPayload(tx, row.id, null, undefined, receipt)
          deletedPayloads += 1
          continue
        }
        const referenceCount = await countPayloadReferences(tx, row.id, receipt)
        const bodyExists = await payloadBodyExists(tx, row.id, receipt)
        if (
          referenceCount === 0 ||
          !bodyExists ||
          row.byteLength > DISCOVERY_CACHE_LIMITS.maxPayloadByteLength
        ) {
          await deleteDiscoveryPayload(tx, row.id, row, bodyExists, receipt)
          deletedPayloads += 1
          continue
        }
        if (row.referenceCount !== referenceCount) {
          await putDiscoveryPayloadMetadata(tx, { ...row, referenceCount }, row)
        }
        audit.payloadCount = saturatingAdd(audit.payloadCount, 1)
        audit.payloadByteLength = saturatingAdd(audit.payloadByteLength, row.byteLength)
      }
      if (page.nextAfterKey !== undefined) {
        audit.afterKey = page.nextAfterKey
        break
      }
      audit = advanceAudit(audit)
      continue
    }
    const page = await readPayloadBodyAuditPage(tx, audit.afterKey, limit - scanned, receipt)
    scanned += page.ids.length
    for (const id of page.orphanIds) {
      await deleteDiscoveryPayload(tx, id, null, true, receipt)
      deletedPayloads += 1
    }
    if (page.nextAfterKey !== undefined) {
      audit.afterKey = page.nextAfterKey
      break
    }
    const completed: DiscoveryCacheStateStorageRow = {
      id: DISCOVERY_CACHE_STATE_ID,
      formatVersion: DISCOVERY_CACHE_STATE_FORMAT_VERSION,
      valid: true,
      headerCounts: { ...audit.headerCounts },
      payloadCount: audit.payloadCount,
      payloadByteLength: audit.payloadByteLength,
    }
    await putPhysicalStorageRow(tx, 'discoveryCacheState', completed, storedState)
    recordDiscoveryCacheEvictions(tx, evictions, receipt)
    return { scanned, deletedPayloads, evictions, done: true, replay }
  }
  await putPhysicalStorageRow(
    tx,
    'discoveryCacheState',
    {
      ...baseState,
      valid: baseState.valid && evictions.length === 0 && deletedPayloads === 0,
      audit,
    },
    storedState,
  )
  recordDiscoveryCacheEvictions(tx, evictions, receipt)
  return { scanned, deletedPayloads, evictions, done: false, replay }
}

async function readValidatedState(
  tx: Transaction,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<DiscoveryCacheStateStorageRow | undefined> {
  const table = tx.table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
  const state = await table.get(DISCOVERY_CACHE_STATE_ID)
  recordDiscoveryCacheRead(receipt, 'discoveryCacheState', 'primary', undefined, 'get', 1, 1)
  if (!isDiscoveryCacheState(state) || !state.valid) return undefined
  return state
}

async function createMissingDiscoveryCacheRepairState(
  tx: Transaction,
  current: DiscoveryCacheStateStorageRow | undefined,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<void> {
  if (isDiscoveryCacheState(current) && !current.valid) return
  await markStateInvalid(tx, current, receipt)
}

function recordDiscoveryCacheRepairRequest(
  tx: Transaction,
  receipt?: DiscoveryCacheReceiptAccumulator,
): void {
  const dependency = {
    kind: 'storage-maintenance',
    tasks: ['prune-discovery-cache'],
  } as const satisfies WorkspaceDependency
  recordBrowserCommandOwnerInvalidation(tx, dependency)
  receipt?.dependency(dependency)
}

async function markStateInvalid(
  tx: Transaction,
  knownCurrent: DiscoveryCacheStateStorageRow | undefined | null,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<void> {
  const current =
    knownCurrent === null
      ? await tx
          .table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
          .get(DISCOVERY_CACHE_STATE_ID)
      : knownCurrent
  if (knownCurrent === null) {
    recordDiscoveryCacheRead(receipt, 'discoveryCacheState', 'primary', undefined, 'get', 1, 1)
  }
  const base = isDiscoveryCacheState(current) ? current : emptyDiscoveryCacheState(false)
  const { audit: _audit, ...withoutAudit } = base
  const next = { ...withoutAudit, valid: false }
  if (stableStringify(current) !== stableStringify(next)) {
    await putPhysicalStorageRow(tx, 'discoveryCacheState', next, current)
  }
  recordDiscoveryCacheRepairRequest(tx, receipt)
}

async function writeState(
  tx: Transaction,
  state: Pick<DiscoveryCacheStateStorageRow, 'headerCounts' | 'payloadCount' | 'payloadByteLength'>,
  previous: DiscoveryCacheStateStorageRow | undefined,
  _receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<void> {
  const next: DiscoveryCacheStateStorageRow = {
    id: DISCOVERY_CACHE_STATE_ID,
    formatVersion: DISCOVERY_CACHE_STATE_FORMAT_VERSION,
    valid: true,
    headerCounts: { ...state.headerCounts },
    payloadCount: state.payloadCount,
    payloadByteLength: state.payloadByteLength,
  }
  if (stableStringify(previous) === stableStringify(next)) return
  await putPhysicalStorageRow(tx, 'discoveryCacheState', next, previous)
}

function emptyDiscoveryCacheState(valid: boolean): DiscoveryCacheStateStorageRow {
  return {
    id: DISCOVERY_CACHE_STATE_ID,
    formatVersion: DISCOVERY_CACHE_STATE_FORMAT_VERSION,
    valid,
    headerCounts: { models: 0, endpoints: 0, privacyPolicies: 0 },
    payloadCount: 0,
    payloadByteLength: 0,
  }
}

function cloneStateTotals(state: DiscoveryCacheStateStorageRow): DiscoveryCacheStateStorageRow {
  const { audit: _audit, ...withoutAudit } = state
  return { ...withoutAudit, headerCounts: { ...state.headerCounts } }
}

function emptyAudit(): DiscoveryCacheAuditStorageRow {
  return {
    phase: 'models',
    headerCounts: { models: 0, endpoints: 0, privacyPolicies: 0 },
    payloadCount: 0,
    payloadByteLength: 0,
  }
}

function cloneAudit(audit: DiscoveryCacheAuditStorageRow): DiscoveryCacheAuditStorageRow {
  return { ...audit, headerCounts: { ...audit.headerCounts } }
}

function advanceAudit(audit: DiscoveryCacheAuditStorageRow): DiscoveryCacheAuditStorageRow {
  const phase =
    audit.phase === 'models'
      ? 'endpoints'
      : audit.phase === 'endpoints'
        ? 'privacyPolicies'
        : audit.phase === 'privacyPolicies'
          ? 'metadata'
          : 'payloads'
  const { afterKey: _afterKey, ...withoutCursor } = audit
  return { ...withoutCursor, phase }
}

function isHeaderPhase(
  phase: DiscoveryCacheAuditStorageRow['phase'],
): phase is DiscoveryCacheStorageTable {
  return phase === 'models' || phase === 'endpoints' || phase === 'privacyPolicies'
}

interface EvictionCandidate {
  tableName: DiscoveryCacheStorageTable
  row: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow
}

async function readBoundedDiscoveryHeaderRepairCandidates(
  tx: Transaction,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<EvictionCandidate[]> {
  const candidates: EvictionCandidate[] = []
  for (const tableName of TABLE_ORDER) {
    const globalLimit = DISCOVERY_CACHE_LIMITS.globalRows[tableName]
    const rows = await tx
      .table<StorageRowByTable[typeof tableName], [string, string]>(tableName)
      .orderBy('fetchedAt')
      .limit(globalLimit + 1)
      .toArray()
    recordDiscoveryCacheRead(receipt, tableName, 'secondary', 'fetchedAt', 'query', 1, rows.length)
    candidates.push(
      ...rows
        .filter((row) => !isDiscoveryCacheHeaderRow(tableName, row))
        .map((row) => ({ tableName, row })),
    )
    if (rows.length > globalLimit) {
      const oldest = rows[0]
      if (oldest) candidates.push({ tableName, row: oldest })
      continue
    }
    const rowsByProfile = new Map<string, StorageRowByTable[typeof tableName][]>()
    for (const row of rows) {
      if (!isDiscoveryCacheHeaderRow(tableName, row)) continue
      const profileRows = rowsByProfile.get(row.profileId) ?? []
      profileRows.push(row)
      rowsByProfile.set(row.profileId, profileRows)
    }
    const profileLimit = DISCOVERY_CACHE_LIMITS.perProfileRows[tableName]
    for (const profileRows of rowsByProfile.values()) {
      candidates.push(
        ...profileRows
          .slice(0, Math.max(0, profileRows.length - profileLimit))
          .map((row) => ({ tableName, row })),
      )
    }
  }
  const unique = new Map<string, EvictionCandidate>()
  for (const candidate of candidates) unique.set(candidateKey(candidate), candidate)
  return [...unique.values()].sort(compareEvictionCandidates)
}

async function readEvictionCandidates(
  tx: Transaction,
  targetTable: DiscoveryCacheStorageTable,
  profileId: string,
  protectedKey: [string, string],
  limit: number,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<EvictionCandidate[]> {
  const candidates: EvictionCandidate[] = []
  for (const tableName of TABLE_ORDER) {
    const rows = await tx
      .table<StorageRowByTable[typeof tableName], [string, string]>(tableName)
      .orderBy('fetchedAt')
      .limit(limit)
      .toArray()
    recordDiscoveryCacheRead(receipt, tableName, 'secondary', 'fetchedAt', 'query', 1, rows.length)
    candidates.push(...rows.map((row) => ({ tableName, row })))
  }
  const profileRows = await tx
    .table<StorageRowByTable[typeof targetTable], [string, string]>(targetTable)
    .where('[profileId+fetchedAt]')
    .between(...exactCompoundPrefixBetween([profileId]))
    .limit(limit)
    .toArray()
  recordDiscoveryCacheRead(
    receipt,
    targetTable,
    'secondary',
    '[profileId+fetchedAt]',
    'query',
    1,
    profileRows.length,
  )
  candidates.push(...profileRows.map((row) => ({ tableName: targetTable, row })))
  const byKey = new Map<string, EvictionCandidate>()
  for (const candidate of candidates) {
    if (samePrimaryKey(candidate.tableName, candidate.row, targetTable, protectedKey)) continue
    byKey.set(candidateKey(candidate), candidate)
  }
  return [...byKey.values()].sort(compareEvictionCandidates)
}

function selectEvictionCandidate(
  candidates: readonly EvictionCandidate[],
  selected: readonly EvictionCandidate[],
  projected: DiscoveryCacheStateStorageRow,
  targetTable: DiscoveryCacheStorageTable,
  profileId: string,
  projectedProfileCount: number,
): EvictionCandidate | undefined {
  const selectedKeys = new Set(selected.map(candidateKey))
  const available = candidates.filter((candidate) => !selectedKeys.has(candidateKey(candidate)))
  if (projectedProfileCount > DISCOVERY_CACHE_LIMITS.perProfileRows[targetTable]) {
    return available.find(
      (candidate) => candidate.tableName === targetTable && candidate.row.profileId === profileId,
    )
  }
  const overfullTable = TABLE_ORDER.find(
    (tableName) => projected.headerCounts[tableName] > DISCOVERY_CACHE_LIMITS.globalRows[tableName],
  )
  if (overfullTable) return available.find((candidate) => candidate.tableName === overfullTable)
  if (projected.payloadByteLength > DISCOVERY_CACHE_LIMITS.maxUniquePayloadByteLength) {
    return available[0]
  }
  return undefined
}

function exceedsLimits(
  projected: DiscoveryCacheStateStorageRow,
  targetTable: DiscoveryCacheStorageTable,
  projectedProfileCount: number,
): boolean {
  return (
    projectedProfileCount > DISCOVERY_CACHE_LIMITS.perProfileRows[targetTable] ||
    TABLE_ORDER.some(
      (tableName) =>
        projected.headerCounts[tableName] > DISCOVERY_CACHE_LIMITS.globalRows[tableName],
    ) ||
    projected.payloadByteLength > DISCOVERY_CACHE_LIMITS.maxUniquePayloadByteLength
  )
}

function incrementProjectedPayload(
  state: DiscoveryCacheStateStorageRow,
  refs: Map<string, DiscoveryPayloadMetadataStorageRow>,
  prepared: PreparedDiscoveryPayload,
  fetchedAt: number,
): void {
  const current = refs.get(prepared.id)
  if (current) {
    current.referenceCount += 1
    current.lastReferencedAt = Math.max(current.lastReferencedAt, fetchedAt)
    return
  }
  refs.set(prepared.id, {
    id: prepared.id,
    byteLength: prepared.byteLength,
    referenceCount: 1,
    lastReferencedAt: fetchedAt,
  })
  state.payloadCount += 1
  state.payloadByteLength += prepared.byteLength
}

function decrementProjectedPayload(
  state: DiscoveryCacheStateStorageRow,
  refs: Map<string, DiscoveryPayloadMetadataStorageRow>,
  payloadId: string,
): void {
  const current = refs.get(payloadId)
  if (!current) throw new Error(`DiscoveryPayloadMetadataMissing:${payloadId}`)
  current.referenceCount -= 1
  if (current.referenceCount === 0) {
    state.payloadCount -= 1
    state.payloadByteLength -= current.byteLength
  }
}

async function readHeaderAuditPage(
  tx: Transaction,
  tableName: DiscoveryCacheStorageTable,
  afterKey: string | [string, string] | undefined,
  limit: number,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<{
  rows: Array<{
    row: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow
    valid: boolean
  }>
  nextAfterKey?: [string, string]
}> {
  const table = tx.table<
    CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow,
    [string, string]
  >(tableName)
  const rows = await (afterKey === undefined
    ? table.orderBy(':id')
    : table.where(':id').above(afterKey as [string, string])
  )
    .limit(limit + 1)
    .toArray()
  recordDiscoveryCacheRead(receipt, tableName, 'primary', undefined, 'query', 1, rows.length)
  const page = rows.slice(0, limit)
  const payloadIds = [...new Set(page.map((row) => row.payloadId))]
  const [metadata, bodyIds] = await Promise.all([
    payloadIds.length === 0
      ? Promise.resolve([] as Array<DiscoveryPayloadMetadataStorageRow | undefined>)
      : tx
          .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
          .bulkGet(payloadIds),
    payloadIds.length === 0
      ? Promise.resolve([] as string[])
      : (tx
          .table<DiscoveryPayloadStorageRow, string>('discoveryPayloads')
          .where(':id')
          .anyOf(payloadIds)
          .primaryKeys() as Promise<string[]>),
  ])
  recordDiscoveryCacheRead(
    receipt,
    'discoveryPayloadMetadata',
    'primary',
    undefined,
    'get-many',
    payloadIds.length > 0 ? 1 : 0,
    payloadIds.length,
  )
  recordDiscoveryCacheRead(
    receipt,
    'discoveryPayloads',
    'primary',
    undefined,
    'open-cursor',
    payloadIds.length > 0 ? 1 : 0,
    bodyIds.length,
  )
  const metadataById = new Map(metadata.flatMap((row) => (row ? [[row.id, row] as const] : [])))
  const bodies = new Set(bodyIds)
  return {
    rows: page.map((row) => {
      const meta = metadataById.get(row.payloadId)
      return {
        row,
        valid:
          !!meta &&
          bodies.has(row.payloadId) &&
          meta.byteLength === row.payloadByteLength &&
          meta.byteLength <= DISCOVERY_CACHE_LIMITS.maxPayloadByteLength,
      }
    }),
    ...(rows.length > limit && page.at(-1)
      ? { nextAfterKey: primaryKey(tableName, page.at(-1) as (typeof page)[number]) }
      : {}),
  }
}

async function readMetadataAuditPage(
  tx: Transaction,
  afterKey: string | [string, string] | undefined,
  limit: number,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<{ rows: DiscoveryPayloadMetadataStorageRow[]; nextAfterKey?: string }> {
  const table = tx.table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
  const rows = await (afterKey === undefined
    ? table.orderBy(':id')
    : table.where(':id').above(afterKey as string)
  )
    .limit(limit + 1)
    .toArray()
  recordDiscoveryCacheRead(
    receipt,
    'discoveryPayloadMetadata',
    'primary',
    undefined,
    'query',
    1,
    rows.length,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    rows: page,
    ...(rows.length > limit && last ? { nextAfterKey: last.id } : {}),
  }
}

async function readPayloadBodyAuditPage(
  tx: Transaction,
  afterKey: string | [string, string] | undefined,
  limit: number,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<{ ids: string[]; orphanIds: string[]; nextAfterKey?: string }> {
  const table = tx.table<DiscoveryPayloadStorageRow, string>('discoveryPayloads')
  const ids = await (afterKey === undefined
    ? table.orderBy(':id')
    : table.where(':id').above(afterKey as string)
  )
    .limit(limit + 1)
    .primaryKeys()
  recordDiscoveryCacheRead(
    receipt,
    'discoveryPayloads',
    'primary',
    undefined,
    'query',
    1,
    ids.length,
  )
  const page = ids.slice(0, limit)
  const metadataIds =
    page.length === 0
      ? []
      : await tx
          .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
          .where(':id')
          .anyOf(page)
          .primaryKeys()
  recordDiscoveryCacheRead(
    receipt,
    'discoveryPayloadMetadata',
    'primary',
    undefined,
    'open-cursor',
    page.length > 0 ? 1 : 0,
    metadataIds.length,
  )
  const retained = new Set(metadataIds)
  const last = page.at(-1)
  return {
    ids: page,
    orphanIds: page.filter((id) => !retained.has(id)),
    ...(ids.length > limit && last ? { nextAfterKey: last } : {}),
  }
}

async function countPayloadReferences(
  tx: Transaction,
  payloadId: string,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<number> {
  const counts = await Promise.all(
    TABLE_ORDER.map((tableName) =>
      tx.table(tableName).where('payloadId').equals(payloadId).count(),
    ),
  )
  for (const [index, count] of counts.entries()) {
    recordDiscoveryCacheRead(
      receipt,
      TABLE_ORDER[index] as DiscoveryCacheStorageTable,
      'secondary',
      'payloadId',
      'count',
      1,
      count,
    )
  }
  return counts.reduce((total, count) => total + count, 0)
}

async function payloadBodyExists(
  tx: Transaction,
  payloadId: string,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<boolean> {
  const count = await tx
    .table<DiscoveryPayloadStorageRow, string>('discoveryPayloads')
    .where(':id')
    .equals(payloadId)
    .limit(1)
    .count()
  recordDiscoveryCacheRead(receipt, 'discoveryPayloads', 'primary', undefined, 'count', 1, count)
  return count > 0
}

async function deletePayloadIfUnreferenced(
  tx: Transaction,
  payloadId: string,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<boolean> {
  const references = await Promise.all(
    TABLE_ORDER.map((tableName) =>
      tx.table(tableName).where('payloadId').equals(payloadId).limit(1).primaryKeys(),
    ),
  )
  for (const [index, keys] of references.entries()) {
    recordDiscoveryCacheRead(
      receipt,
      TABLE_ORDER[index] as DiscoveryCacheStorageTable,
      'secondary',
      'payloadId',
      'query',
      1,
      keys.length,
    )
  }
  if (references.some((keys) => keys.length > 0)) return false
  return deleteDiscoveryPayload(tx, payloadId, undefined, undefined, receipt)
}

async function deleteDiscoveryPayload(
  tx: Transaction,
  payloadId: string,
  knownMetadata?: DiscoveryPayloadMetadataStorageRow | null,
  knownBodyExists?: boolean,
  receipt?: DiscoveryCacheReceiptAccumulator,
): Promise<boolean> {
  const [metadata, bodyExists] = await Promise.all([
    knownMetadata !== undefined
      ? Promise.resolve(knownMetadata ?? undefined)
      : tx
          .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
          .get(payloadId),
    knownBodyExists === undefined
      ? payloadBodyExists(tx, payloadId, receipt)
      : Promise.resolve(knownBodyExists),
  ])
  if (knownMetadata === undefined) {
    recordDiscoveryCacheRead(receipt, 'discoveryPayloadMetadata', 'primary', undefined, 'get', 1, 1)
  }
  await Promise.all([
    deletePhysicalStorageKeys<DiscoveryPayloadMetadataStorageRow, string>(
      tx,
      'discoveryPayloadMetadata',
      [payloadId],
    ),
    deletePhysicalStorageKeys<DiscoveryPayloadStorageRow, string>(tx, 'discoveryPayloads', [
      payloadId,
    ]),
  ])
  const obsoleteBytes = metadata
    ? estimateStoredValueBytes(metadata) + (bodyExists ? metadata.byteLength : 0)
    : 0
  await recordObsoleteByteOwnerBytes(tx, obsoleteBytes)
  return bodyExists
}

async function putDiscoveryPayloadMetadata(
  tx: Transaction,
  next: DiscoveryPayloadMetadataStorageRow,
  previous: DiscoveryPayloadMetadataStorageRow | undefined,
): Promise<void> {
  if (previous && stableStringify(previous) === stableStringify(next)) return
  await putPhysicalStorageRow(tx, 'discoveryPayloadMetadata', next, previous)
}

function canonicalJsonForStorage(tableName: DiscoveryCacheStorageTable, payload: unknown): string {
  const normalized =
    tableName === 'privacyPolicies' && isPrivacyPayload(payload)
      ? { policies: payload.policies }
      : payload
  const serialized: unknown = JSON.stringify(normalized, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    )
  })
  if (typeof serialized !== 'string') throw new Error(`DiscoveryPayloadNotJson:${tableName}`)
  return serialized
}

function hydratePublicRow<T extends DiscoveryCacheStorageTable>(
  tableName: T,
  stored: StorageRowByTable[T],
  decoded: unknown,
): PublicRowByTable[T] {
  const payload =
    tableName === 'privacyPolicies' && isPrivacyPayload(decoded)
      ? { policies: decoded.policies, fetchedAt: stored.fetchedAt }
      : decoded
  if (tableName === 'models') {
    const row = stored as CachedModelsStorageRow
    return {
      profileId: row.profileId,
      profileRevision: row.profileRevision,
      queryKey: row.queryKey,
      fetchedAt: row.fetchedAt,
      payload,
    } as PublicRowByTable[T]
  }
  const row = stored as CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow
  return {
    profileId: row.profileId,
    profileRevision: row.profileRevision,
    modelId: row.modelId,
    fetchedAt: row.fetchedAt,
    payload,
  } as PublicRowByTable[T]
}

function primaryKey(
  tableName: DiscoveryCacheStorageTable,
  row: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow,
): [string, string] {
  return tableName === 'models'
    ? [row.profileId, (row as CachedModelsStorageRow).queryKey]
    : [row.profileId, (row as CachedEndpointsStorageRow).modelId]
}

function primaryKeyForPublicRow<T extends DiscoveryCacheStorageTable>(
  tableName: T,
  row: PublicRowByTable[T],
): [string, string] {
  return tableName === 'models'
    ? [row.profileId, (row as CachedModelsRow).queryKey]
    : [row.profileId, (row as CachedEndpointsRow).modelId]
}

function evictionForStorageRow(
  tableName: DiscoveryCacheStorageTable,
  row: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow,
): DiscoveryCacheEviction {
  return {
    tableName,
    profileId: row.profileId,
    discriminator:
      tableName === 'models'
        ? (row as CachedModelsStorageRow).queryKey
        : (row as CachedEndpointsStorageRow).modelId,
  }
}

function evictionForCandidate(candidate: EvictionCandidate): DiscoveryCacheEviction {
  return evictionForStorageRow(candidate.tableName, candidate.row)
}

function discoveryCacheKindForStorageTable(
  tableName: DiscoveryCacheStorageTable,
): DiscoveryCacheKind {
  return tableName === 'privacyPolicies' ? 'privacy' : tableName
}

function recordDiscoveryCacheProfileInvalidations(
  tx: Transaction,
  tableNames: readonly DiscoveryCacheStorageTable[],
  profileId: string,
  receipt?: DiscoveryCacheReceiptAccumulator,
): void {
  const dependency = {
    kind: 'discovery-cache',
    cacheKinds: [...new Set(tableNames.map(discoveryCacheKindForStorageTable))],
    profileIds: [profileId],
  } as const satisfies WorkspaceDependency
  recordBrowserCommandOwnerInvalidation(tx, dependency)
  receipt?.dependency(dependency)
}

function recordDiscoveryCacheRowInvalidation(
  tx: Transaction,
  tableName: DiscoveryCacheStorageTable,
  row: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow,
  receipt?: DiscoveryCacheReceiptAccumulator,
): void {
  const cacheKind = discoveryCacheKindForStorageTable(tableName)
  const eviction = evictionForStorageRow(tableName, row)
  const dependency = {
    kind: 'discovery-cache',
    cacheKinds: [cacheKind],
    profileIds: [eviction.profileId],
    keys: [discoveryCacheKey(cacheKind, eviction.profileId, eviction.discriminator)],
  } as const satisfies WorkspaceDependency
  recordBrowserCommandOwnerInvalidation(tx, dependency)
  receipt?.dependency(dependency)
}

function recordDiscoveryCacheEvictions(
  tx: Transaction,
  evictions: readonly DiscoveryCacheEviction[],
  receipt?: DiscoveryCacheReceiptAccumulator,
): void {
  for (const eviction of evictions) {
    const cacheKind = discoveryCacheKindForStorageTable(eviction.tableName)
    const dependency = {
      kind: 'discovery-cache',
      cacheKinds: [cacheKind],
      profileIds: [eviction.profileId],
      keys: [discoveryCacheKey(cacheKind, eviction.profileId, eviction.discriminator)],
    } as const satisfies WorkspaceDependency
    recordBrowserCommandOwnerInvalidation(tx, dependency)
    receipt?.dependency(dependency)
  }
}

function discoveryCacheMaintenanceReplay(
  state: DiscoveryCacheStateStorageRow | undefined,
  limit: number,
): SemanticOperationReplayPlan {
  const current = isDiscoveryCacheState(state) ? state : undefined
  return {
    kind: 'durable-page-resume',
    owner: 'discovery-cache:maintenance',
    cycle: current?.formatVersion ?? 'missing',
    revision: stableStringify(
      current
        ? {
            valid: current.valid,
            headerCounts: current.headerCounts,
            payloadCount: current.payloadCount,
            payloadByteLength: current.payloadByteLength,
          }
        : null,
    ),
    cursor: stableStringify(current?.audit ?? null),
    doneMarker: current?.valid === true && !current.audit ? 'valid' : 'audit-required',
    limit,
  }
}

function recordDiscoveryCacheRead(
  receipt: DiscoveryCacheReceiptAccumulator | undefined,
  tableName:
    | 'discoveryCacheState'
    | 'discoveryPayloadMetadata'
    | 'discoveryPayloads'
    | DiscoveryCacheStorageTable,
  indexKind: 'primary' | 'secondary',
  indexName: string | undefined,
  operation: 'get' | 'get-many' | 'query' | 'open-cursor' | 'count',
  requestCount: number,
  rowCount: number,
): void {
  if (!receipt || requestCount === 0) return
  receipt.physicalRead({
    tableName,
    indexKind,
    ...(indexName ? { indexName } : {}),
    operation,
    requestCount,
    rowCount,
  })
}

function candidateKey(candidate: EvictionCandidate): string {
  return JSON.stringify([candidate.tableName, ...primaryKey(candidate.tableName, candidate.row)])
}

function compareEvictionCandidates(left: EvictionCandidate, right: EvictionCandidate): number {
  return (
    left.row.fetchedAt - right.row.fetchedAt ||
    candidateKey(left).localeCompare(candidateKey(right))
  )
}

function samePrimaryKey(
  candidateTable: DiscoveryCacheStorageTable,
  candidate: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow,
  targetTable: DiscoveryCacheStorageTable,
  targetKey: [string, string],
): boolean {
  if (candidateTable !== targetTable) return false
  const key = primaryKey(candidateTable, candidate)
  return key[0] === targetKey[0] && key[1] === targetKey[1]
}

function isDiscoveryCacheState(value: unknown): value is DiscoveryCacheStateStorageRow {
  if (!value || typeof value !== 'object') return false
  const state = value as Partial<DiscoveryCacheStateStorageRow>
  return (
    state.id === DISCOVERY_CACHE_STATE_ID &&
    state.formatVersion === DISCOVERY_CACHE_STATE_FORMAT_VERSION &&
    typeof state.valid === 'boolean' &&
    isSafeNonNegative(state.payloadCount) &&
    isSafeNonNegative(state.payloadByteLength) &&
    !!state.headerCounts &&
    TABLE_ORDER.every((tableName) => isSafeNonNegative(state.headerCounts?.[tableName])) &&
    (state.audit === undefined || isDiscoveryCacheAudit(state.audit))
  )
}

function isDiscoveryCacheAudit(value: unknown): value is DiscoveryCacheAuditStorageRow {
  if (!value || typeof value !== 'object') return false
  const audit = value as Partial<DiscoveryCacheAuditStorageRow>
  if (
    !audit.phase ||
    !['models', 'endpoints', 'privacyPolicies', 'metadata', 'payloads'].includes(audit.phase) ||
    !audit.headerCounts ||
    !TABLE_ORDER.every((tableName) => isSafeNonNegative(audit.headerCounts?.[tableName])) ||
    !isSafeNonNegative(audit.payloadCount) ||
    !isSafeNonNegative(audit.payloadByteLength)
  ) {
    return false
  }
  if (audit.afterKey === undefined) return true
  return isHeaderPhase(audit.phase)
    ? Array.isArray(audit.afterKey) && audit.afterKey.every((part) => typeof part === 'string')
    : typeof audit.afterKey === 'string'
}

function isDiscoveryCacheHeaderRow(
  tableName: DiscoveryCacheStorageTable,
  value: unknown,
): value is CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<
    CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow
  >
  const discriminator =
    tableName === 'models'
      ? (row as Partial<CachedModelsStorageRow>).queryKey
      : (row as Partial<CachedEndpointsStorageRow>).modelId
  return (
    typeof row.profileId === 'string' &&
    typeof row.profileRevision === 'string' &&
    typeof discriminator === 'string' &&
    typeof row.payloadId === 'string' &&
    isSafeNonNegative(row.fetchedAt) &&
    isSafeNonNegative(row.payloadByteLength) &&
    row.payloadByteLength <= DISCOVERY_CACHE_LIMITS.maxPayloadByteLength
  )
}

function isDiscoveryPayloadMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const metadata = value as Partial<DiscoveryPayloadMetadataStorageRow>
  return (
    typeof metadata.id === 'string' &&
    isSafeNonNegative(metadata.byteLength) &&
    metadata.byteLength <= DISCOVERY_CACHE_LIMITS.maxPayloadByteLength &&
    isSafeNonNegative(metadata.referenceCount) &&
    isSafeNonNegative(metadata.lastReferencedAt)
  )
}

function isSafeNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function saturatingAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right)
}

function isPrivacyPayload(value: unknown): value is { policies: unknown; fetchedAt?: unknown } {
  return !!value && typeof value === 'object' && 'policies' in value
}

function isString(value: string | undefined): value is string {
  return value !== undefined
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

function hex(bytes: Uint8Array): string {
  let output = ''
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0')
  return output
}

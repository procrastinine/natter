import type { Transaction } from 'dexie'
import {
  recordBrowserCommandDiscoveryCacheMaintenance,
  recordBrowserCommandOwnerInvalidation,
} from './browser-command-mutation-journal'
import {
  deletePhysicalStorageCollection,
  deletePhysicalStorageRows,
  putPhysicalStorageRow,
  recordObsoleteByteOwnerBytes,
  recordObsoleteByteOwnerValues,
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
import { physicalStorageTables } from './physical-storage-tables'
import { estimateStoredValueBytes } from './storage-size-estimate'
import { type DiscoveryCacheKind, discoveryCacheKey } from './workspace-protocol'

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
}

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
  const stored = await tx.table<StorageRowByTable[T], string | [string, string]>(tableName).get(key)
  if (!stored) return undefined
  const [metadata, payload] = await Promise.all([
    tx
      .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
      .get(stored.payloadId),
    tx.table<DiscoveryPayloadStorageRow, string>('discoveryPayloads').get(stored.payloadId),
  ])
  if (
    !metadata ||
    !payload ||
    metadata.referenceCount < 1 ||
    metadata.byteLength !== stored.payloadByteLength ||
    payload.byteLength !== stored.payloadByteLength
  ) {
    return undefined
  }
  const decoded = JSON.parse(payload.canonicalJson) as unknown
  return hydratePublicRow(tableName, stored, decoded)
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
): Promise<DiscoveryCachePutResult> {
  if (!prepared.cacheable) {
    return {
      accepted: true,
      cacheChanged: false,
      cached: false,
      repairRequired: false,
      evictions: [],
    }
  }
  const state = await readValidatedState(tx)
  if (!state) {
    await createMissingDiscoveryCacheRepairState(tx)
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
  const currentStorage = await table.get(key)
  const nextStorage = discoveryStorageRow(tableName, row, prepared)
  const metadataTable = tx.table<DiscoveryPayloadMetadataStorageRow, string>(
    'discoveryPayloadMetadata',
  )
  const affectedMetadata = await metadataTable.bulkGet([
    ...new Set([currentStorage?.payloadId, nextStorage.payloadId].filter(isString)),
  ])
  const metadataById = new Map(
    affectedMetadata.flatMap((metadata) => (metadata ? [[metadata.id, metadata] as const] : [])),
  )
  const previousMetadataById = new Map(metadataById)
  if (currentStorage && !metadataById.has(currentStorage.payloadId)) {
    await markStateInvalid(tx)
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
    await markStateInvalid(tx)
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
  const profileCount =
    (await table.where('profileId').equals(row.profileId).count()) + (currentStorage ? 0 : 1)
  const selected: EvictionCandidate[] = []
  let projectedProfileCount = profileCount
  if (exceedsLimits(projected, tableName, projectedProfileCount)) {
    const candidates = await readEvictionCandidates(
      tx,
      tableName,
      row.profileId,
      key,
      DISCOVERY_CACHE_LIMITS.maxEvictionsPerWrite + 1,
    )
    const candidateMetadata = await metadataTable.bulkGet([
      ...new Set(candidates.map((candidate) => candidate.row.payloadId)),
    ])
    for (const metadata of candidateMetadata) {
      if (!metadata) continue
      if (!projectedRefs.has(metadata.id)) projectedRefs.set(metadata.id, { ...metadata })
      if (!previousMetadataById.has(metadata.id)) previousMetadataById.set(metadata.id, metadata)
    }
    if (candidateMetadata.some((metadata) => metadata === undefined)) {
      await markStateInvalid(tx)
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
  for (const candidate of selected) {
    await recordObsoleteByteOwnerValues(tx, [candidate.row])
    await tx.table(candidate.tableName).delete(primaryKey(candidate.tableName, candidate.row))
  }
  if (changed) await putPhysicalStorageRow(tx, tableName, nextStorage, currentStorage)
  if (!existingNextMetadata) {
    const payloads = tx.table<DiscoveryPayloadStorageRow, string>('discoveryPayloads')
    if (!(await payloadBodyExists(tx, prepared.id))) {
      await payloads.add({
        id: prepared.id,
        canonicalJson: prepared.canonicalJson,
        byteLength: prepared.byteLength,
      })
    }
  }
  for (const [payloadId, metadata] of projectedRefs) {
    if (metadata.referenceCount <= 0) {
      await deleteDiscoveryPayload(tx, payloadId, metadata)
      continue
    }
    await putDiscoveryPayloadMetadata(tx, metadata, previousMetadataById.get(payloadId))
  }
  await writeState(tx, projected, state)
  const evictions = selected.map(evictionForCandidate)
  recordDiscoveryCacheEvictions(tx, evictions)
  if (changed) recordDiscoveryCacheRowInvalidation(tx, tableName, nextStorage)
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
): Promise<{ deleted: boolean; evictions: readonly DiscoveryCacheEviction[] }> {
  const table = tx.table<StorageRowByTable[typeof tableName], [string, string]>(tableName)
  const current = await table.get(key)
  if (!current) return { deleted: false, evictions: [] }
  await recordObsoleteByteOwnerValues(tx, [current])
  await table.delete(key)
  const state = await readValidatedState(tx)
  if (!state) {
    await deletePayloadIfUnreferenced(tx, current.payloadId)
    await markStateInvalid(tx)
  } else {
    const metadata = await tx
      .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
      .get(current.payloadId)
    if (!metadata) {
      await markStateInvalid(tx)
    } else {
      const projected = cloneStateTotals(state)
      const refs = new Map([[metadata.id, { ...metadata }]])
      projected.headerCounts[tableName] -= 1
      decrementProjectedPayload(projected, refs, current.payloadId)
      const next = refs.get(current.payloadId)
      if (!next || next.referenceCount <= 0) {
        await deleteDiscoveryPayload(tx, current.payloadId, metadata)
      } else {
        await putDiscoveryPayloadMetadata(tx, next, metadata)
      }
      await writeState(tx, projected, state)
    }
  }
  const evictions = [evictionForStorageRow(tableName, current)]
  recordDiscoveryCacheEvictions(tx, evictions)
  return {
    deleted: true,
    evictions,
  }
}

export async function clearDiscoveryCacheProfileRows(
  tx: Transaction,
  tableNames: readonly DiscoveryCacheStorageTable[],
  profileId: string,
): Promise<{ deleted: number; evictions: readonly DiscoveryCacheEviction[] }> {
  recordDiscoveryCacheProfileInvalidations(tx, tableNames, profileId)
  const state = await readValidatedState(tx)
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
  if (
    !state ||
    tableNames.some(
      (tableName, index) =>
        (boundedRows[index]?.length ?? 0) > DISCOVERY_CACHE_LIMITS.perProfileRows[tableName],
    )
  ) {
    let deleted = 0
    for (const tableName of tableNames) {
      deleted += await deletePhysicalStorageCollection(
        tx,
        tableName,
        tx.table(tableName).where('profileId').equals(profileId),
      )
    }
    await markStateInvalid(tx)
    return { deleted, evictions: [] }
  }
  const rows: Array<{
    tableName: DiscoveryCacheStorageTable
    row: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow
  }> = []
  for (const [index, tableName] of tableNames.entries()) {
    const selected = boundedRows[index] ?? []
    rows.push(...selected.map((row) => ({ tableName, row })))
  }
  if (rows.length === 0) return { deleted: 0, evictions: [] }
  const projected = cloneStateTotals(state)
  const metadataTable = tx.table<DiscoveryPayloadMetadataStorageRow, string>(
    'discoveryPayloadMetadata',
  )
  const metadataRows = await metadataTable.bulkGet([
    ...new Set(rows.map(({ row }) => row.payloadId)),
  ])
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
    await markStateInvalid(tx)
    return { deleted: rows.length, evictions: [] }
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
      await deleteDiscoveryPayload(tx, payloadId, metadata)
    } else {
      await putDiscoveryPayloadMetadata(tx, metadata, previousMetadataById.get(payloadId))
    }
  }
  await writeState(tx, projected, state)
  const evictions = rows.map(({ tableName, row }) => evictionForStorageRow(tableName, row))
  return {
    deleted: rows.length,
    evictions,
  }
}

export async function maintainDiscoveryCache(
  tx: Transaction,
  requestedLimit: number,
): Promise<DiscoveryCacheMaintenanceResult> {
  const limit = Math.max(1, Math.min(Math.floor(requestedLimit), 128))
  const stateTable = tx.table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
  const storedState = await stateTable.get(DISCOVERY_CACHE_STATE_ID)
  if (isDiscoveryCacheState(storedState) && storedState.valid && !storedState.audit) {
    return { scanned: 0, deletedPayloads: 0, evictions: [], done: true }
  }
  recordBrowserCommandDiscoveryCacheMaintenance(tx)
  const baseState = isDiscoveryCacheState(storedState)
    ? storedState
    : emptyDiscoveryCacheState(false)
  let audit = baseState.audit ? cloneAudit(baseState.audit) : emptyAudit()
  let scanned = 0
  let deletedPayloads = 0
  const evictions: DiscoveryCacheEviction[] = []
  while (scanned < limit) {
    if (isHeaderPhase(audit.phase)) {
      const page = await readHeaderAuditPage(tx, audit.phase, audit.afterKey, limit - scanned)
      scanned += page.rows.length
      for (const row of page.rows) {
        if (row.valid) {
          audit.headerCounts[audit.phase] += 1
        } else {
          await recordObsoleteByteOwnerValues(tx, [row.row])
          await tx.table(audit.phase).delete(primaryKey(audit.phase, row.row))
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
      const page = await readMetadataAuditPage(tx, audit.afterKey, limit - scanned)
      scanned += page.rows.length
      for (const row of page.rows) {
        const referenceCount = await countPayloadReferences(tx, row.id)
        const bodyExists = await payloadBodyExists(tx, row.id)
        if (
          referenceCount === 0 ||
          !bodyExists ||
          row.byteLength > DISCOVERY_CACHE_LIMITS.maxPayloadByteLength
        ) {
          await deleteDiscoveryPayload(tx, row.id, row)
          deletedPayloads += 1
          continue
        }
        if (row.referenceCount !== referenceCount) {
          await putDiscoveryPayloadMetadata(tx, { ...row, referenceCount }, row)
        }
        audit.payloadCount += 1
        audit.payloadByteLength += row.byteLength
      }
      if (page.nextAfterKey !== undefined) {
        audit.afterKey = page.nextAfterKey
        break
      }
      audit = advanceAudit(audit)
      continue
    }
    const page = await readPayloadBodyAuditPage(tx, audit.afterKey, limit - scanned)
    scanned += page.ids.length
    for (const id of page.orphanIds) {
      await deleteDiscoveryPayload(tx, id)
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
    recordDiscoveryCacheEvictions(tx, evictions)
    return { scanned, deletedPayloads, evictions, done: true }
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
  recordDiscoveryCacheEvictions(tx, evictions)
  return { scanned, deletedPayloads, evictions, done: false }
}

async function readValidatedState(
  tx: Transaction,
): Promise<DiscoveryCacheStateStorageRow | undefined> {
  const table = tx.table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
  const state = await table.get(DISCOVERY_CACHE_STATE_ID)
  if (!isDiscoveryCacheState(state) || !state.valid) return undefined
  return state
}

async function createMissingDiscoveryCacheRepairState(tx: Transaction): Promise<void> {
  const current = await tx
    .table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
    .get(DISCOVERY_CACHE_STATE_ID)
  if (isDiscoveryCacheState(current) && !current.valid) return
  await markStateInvalid(tx)
}

function recordDiscoveryCacheRepairRequest(tx: Transaction): void {
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'storage-maintenance',
    tasks: ['prune-discovery-cache'],
  })
}

async function markStateInvalid(tx: Transaction): Promise<void> {
  const table = tx.table<DiscoveryCacheStateStorageRow, string>('discoveryCacheState')
  const current = await table.get(DISCOVERY_CACHE_STATE_ID)
  const base = isDiscoveryCacheState(current) ? current : emptyDiscoveryCacheState(false)
  const { audit: _audit, ...withoutAudit } = base
  const next = { ...withoutAudit, valid: false }
  if (stableStringify(current) !== stableStringify(next)) {
    await putPhysicalStorageRow(tx, 'discoveryCacheState', next, current)
  }
  recordDiscoveryCacheRepairRequest(tx)
}

async function writeState(
  tx: Transaction,
  state: Pick<DiscoveryCacheStateStorageRow, 'headerCounts' | 'payloadCount' | 'payloadByteLength'>,
  previous: DiscoveryCacheStateStorageRow | undefined,
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

async function readEvictionCandidates(
  tx: Transaction,
  targetTable: DiscoveryCacheStorageTable,
  profileId: string,
  protectedKey: [string, string],
  limit: number,
): Promise<EvictionCandidate[]> {
  const candidates: EvictionCandidate[] = []
  for (const tableName of TABLE_ORDER) {
    const rows = await tx
      .table<StorageRowByTable[typeof tableName], [string, string]>(tableName)
      .orderBy('fetchedAt')
      .limit(limit)
      .toArray()
    candidates.push(...rows.map((row) => ({ tableName, row })))
  }
  const profileRows = await tx
    .table<StorageRowByTable[typeof targetTable], [string, string]>(targetTable)
    .where('[profileId+fetchedAt]')
    .between(...exactCompoundPrefixBetween([profileId]))
    .limit(limit)
    .toArray()
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
  const page = rows.slice(0, limit)
  const payloadIds = [...new Set(page.map((row) => row.payloadId))]
  const [metadata, bodyIds] = await Promise.all([
    tx
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
): Promise<{ rows: DiscoveryPayloadMetadataStorageRow[]; nextAfterKey?: string }> {
  const table = tx.table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
  const rows = await (afterKey === undefined
    ? table.orderBy(':id')
    : table.where(':id').above(afterKey as string)
  )
    .limit(limit + 1)
    .toArray()
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
): Promise<{ ids: string[]; orphanIds: string[]; nextAfterKey?: string }> {
  const table = tx.table<DiscoveryPayloadStorageRow, string>('discoveryPayloads')
  const ids = await (afterKey === undefined
    ? table.orderBy(':id')
    : table.where(':id').above(afterKey as string)
  )
    .limit(limit + 1)
    .primaryKeys()
  const page = ids.slice(0, limit)
  const metadataIds =
    page.length === 0
      ? []
      : await tx
          .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
          .where(':id')
          .anyOf(page)
          .primaryKeys()
  const retained = new Set(metadataIds)
  const last = page.at(-1)
  return {
    ids: page,
    orphanIds: page.filter((id) => !retained.has(id)),
    ...(ids.length > limit && last ? { nextAfterKey: last } : {}),
  }
}

async function countPayloadReferences(tx: Transaction, payloadId: string): Promise<number> {
  const counts = await Promise.all(
    TABLE_ORDER.map((tableName) =>
      tx.table(tableName).where('payloadId').equals(payloadId).count(),
    ),
  )
  return counts.reduce((total, count) => total + count, 0)
}

async function payloadBodyExists(tx: Transaction, payloadId: string): Promise<boolean> {
  return (
    (await tx
      .table<DiscoveryPayloadStorageRow, string>('discoveryPayloads')
      .where(':id')
      .equals(payloadId)
      .limit(1)
      .count()) > 0
  )
}

async function deletePayloadIfUnreferenced(tx: Transaction, payloadId: string): Promise<boolean> {
  if ((await countPayloadReferences(tx, payloadId)) > 0) return false
  return deleteDiscoveryPayload(tx, payloadId)
}

async function deleteDiscoveryPayload(
  tx: Transaction,
  payloadId: string,
  knownMetadata?: DiscoveryPayloadMetadataStorageRow,
): Promise<boolean> {
  const [metadata, bodyExists] = await Promise.all([
    knownMetadata
      ? Promise.resolve(knownMetadata)
      : tx
          .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
          .get(payloadId),
    payloadBodyExists(tx, payloadId),
  ])
  await Promise.all([
    tx
      .table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
      .delete(payloadId),
    tx.table<DiscoveryPayloadStorageRow, string>('discoveryPayloads').delete(payloadId),
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
  await recordObsoleteByteOwnerValues(tx, [previous])
  const table = tx.table<DiscoveryPayloadMetadataStorageRow, string>('discoveryPayloadMetadata')
  if (previous) await table.put(next)
  else await table.add(next)
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
): void {
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'discovery-cache',
    cacheKinds: [...new Set(tableNames.map(discoveryCacheKindForStorageTable))],
    profileIds: [profileId],
  })
}

function recordDiscoveryCacheRowInvalidation(
  tx: Transaction,
  tableName: DiscoveryCacheStorageTable,
  row: CachedModelsStorageRow | CachedEndpointsStorageRow | CachedPrivacyPolicyStorageRow,
): void {
  const cacheKind = discoveryCacheKindForStorageTable(tableName)
  const eviction = evictionForStorageRow(tableName, row)
  recordBrowserCommandOwnerInvalidation(tx, {
    kind: 'discovery-cache',
    cacheKinds: [cacheKind],
    profileIds: [eviction.profileId],
    keys: [discoveryCacheKey(cacheKind, eviction.profileId, eviction.discriminator)],
  })
}

function recordDiscoveryCacheEvictions(
  tx: Transaction,
  evictions: readonly DiscoveryCacheEviction[],
): void {
  for (const eviction of evictions) {
    const cacheKind = discoveryCacheKindForStorageTable(eviction.tableName)
    recordBrowserCommandOwnerInvalidation(tx, {
      kind: 'discovery-cache',
      cacheKinds: [cacheKind],
      profileIds: [eviction.profileId],
      keys: [discoveryCacheKey(cacheKind, eviction.profileId, eviction.discriminator)],
    })
  }
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
    isFiniteNonNegative(state.payloadCount) &&
    isFiniteNonNegative(state.payloadByteLength) &&
    !!state.headerCounts &&
    TABLE_ORDER.every((tableName) => isFiniteNonNegative(state.headerCounts?.[tableName]))
  )
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
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

import type { Transaction } from 'dexie'
import type { PresetId } from '../core/types'
import { newId } from '../lib/ulid'
import {
  PRESET_ORDER_STATE_ID,
  type PresetOrderBlockRow,
  type PresetOrderMembershipRow,
  type PresetOrderStateRow,
} from '../store/preset-order'

const PRESET_ORDER_STAGE_PREFIX_V94 = 'v94-order'
const PRESET_ORDER_PAGE_SIZE_V94 = 64
const PRESET_ORDER_EXISTING_BLOCK_MAX_V94 = 96

type PresetOrderStageKeyV94 = [
  typeof PRESET_ORDER_STAGE_PREFIX_V94,
  0 | 1,
  number,
  number,
  PresetId,
]

interface PresetOrderStageRowV94 {
  readonly id: PresetOrderStageKeyV94
  readonly presetId: PresetId
}

export interface LegacyPresetOrderInputV94 {
  readonly id: unknown
  readonly createdAt: unknown
  readonly archived?: unknown
  readonly sortIndex?: unknown
}

interface PreservedPresetOrderCandidateV94 {
  readonly orderedCount: number
}

export interface WaveAPresetOrderPlanV94 {
  readonly previousRevision: number
  readonly candidate: PreservedPresetOrderCandidateV94 | null
  activeCount: number
  indexedActiveCount: number
  candidateSetValid: boolean
}

export async function beginWaveAPresetOrderV94(tx: Transaction): Promise<WaveAPresetOrderPlanV94> {
  const states = tx.table<unknown, string>('presetOrderState')
  const blocks = tx.table<unknown, string>('presetOrderBlocks')
  const memberships = tx.table<PresetOrderMembershipRow, PresetId>('presetOrderMembership')
  const rawState = await states.get(PRESET_ORDER_STATE_ID)
  const previousRevision = normalizedRevisionV94(recordV94(rawState)?.revision)

  await memberships.clear()
  const state = validPresetOrderStateV94(rawState)
  const candidate = state ? await validatePresetOrderChainV94(tx, state) : null
  if (!candidate) {
    await Promise.all([states.clear(), blocks.clear(), memberships.clear()])
  }

  return {
    previousRevision,
    candidate,
    activeCount: 0,
    indexedActiveCount: 0,
    candidateSetValid: true,
  }
}

export async function observeWaveAPresetOrderRowsV94(
  tx: Transaction,
  plan: WaveAPresetOrderPlanV94,
  rows: readonly LegacyPresetOrderInputV94[],
): Promise<void> {
  const memberships = tx.table<PresetOrderMembershipRow, PresetId>('presetOrderMembership')
  const stagingStore = tx.idbtrans.objectStore('presetOrderBlocks')

  for (let offset = 0; offset < rows.length; offset += PRESET_ORDER_PAGE_SIZE_V94) {
    const page = rows.slice(offset, offset + PRESET_ORDER_PAGE_SIZE_V94)
    const ids = page.map((row) => {
      if (typeof row.id !== 'string' || row.id.length === 0) {
        throw new Error('WaveAPresetOrderPresetIdInvalid')
      }
      return row.id
    })
    const existingMemberships = plan.candidate ? await memberships.bulkGet(ids) : []
    const stagedRows: PresetOrderStageRowV94[] = []
    for (let index = 0; index < page.length; index += 1) {
      const row = page[index]
      const presetId = ids[index]
      if (!row || !presetId) throw new Error('WaveAPresetOrderPageInvalid')
      const membership = existingMemberships[index]
      if (row.archived === true) {
        if (membership !== undefined) plan.candidateSetValid = false
        continue
      }

      plan.activeCount += 1
      if (membership !== undefined) plan.indexedActiveCount += 1
      const createdAt =
        typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0
      const hasLegacyRank = typeof row.sortIndex === 'number' && Number.isFinite(row.sortIndex)
      stagedRows.push({
        id: [
          PRESET_ORDER_STAGE_PREFIX_V94,
          hasLegacyRank ? 0 : 1,
          hasLegacyRank ? row.sortIndex : createdAt,
          createdAt,
          presetId,
        ],
        presetId,
      })
    }
    await putRawRowsV94(stagingStore, stagedRows, 'put', 'PresetOrderStageWrite')
  }
}

export async function finishWaveAPresetOrderV94(
  tx: Transaction,
  plan: WaveAPresetOrderPlanV94,
): Promise<void> {
  const stagingStore = tx.idbtrans.objectStore('presetOrderBlocks')
  const preservesCandidate =
    plan.candidate !== null &&
    plan.candidateSetValid &&
    plan.activeCount === plan.candidate.orderedCount &&
    plan.indexedActiveCount === plan.activeCount

  if (preservesCandidate) {
    await rawRequestV94(stagingStore.delete(presetOrderStageRangeV94()), 'PresetOrderStageDelete')
    return
  }

  if (plan.candidate) {
    await rawRequestV94(
      stagingStore.delete(IDBKeyRange.upperBound(presetOrderStageLowerKeyV94(), true)),
      'PresetOrderCurrentBlockDelete',
    )
  }
  await Promise.all([
    tx.table('presetOrderState').clear(),
    tx.table('presetOrderMembership').clear(),
  ])
  await rebuildPresetOrderFromStagingV94(tx, plan)
}

async function validatePresetOrderChainV94(
  tx: Transaction,
  state: PresetOrderStateRow,
): Promise<PreservedPresetOrderCandidateV94 | null> {
  const blocks = tx.table<unknown, string>('presetOrderBlocks')
  const memberships = tx.table<PresetOrderMembershipRow, PresetId>('presetOrderMembership')
  const blockCount = await blocks.count()
  if (state.exactCount === 0) return blockCount === 0 ? { orderedCount: 0 } : null

  let currentBlockId = state.headBlockId
  let previousBlockId: string | null = null
  let visitedBlockCount = 0
  let orderedCount = 0
  while (currentBlockId) {
    const blockId = currentBlockId
    if (visitedBlockCount >= blockCount) return null
    const value = recordV94(await blocks.get(blockId))
    if (!value || value.id !== blockId) return null
    if (value.previousBlockId !== previousBlockId) return null
    if (!validNullableIdV94(value.nextBlockId)) return null
    if (
      !Array.isArray(value.presetIds) ||
      value.presetIds.length === 0 ||
      value.presetIds.length > PRESET_ORDER_EXISTING_BLOCK_MAX_V94
    ) {
      return null
    }

    for (let offset = 0; offset < value.presetIds.length; offset += PRESET_ORDER_PAGE_SIZE_V94) {
      const rawIds = value.presetIds.slice(offset, offset + PRESET_ORDER_PAGE_SIZE_V94)
      if (
        rawIds.some((id) => typeof id !== 'string' || id.length === 0) ||
        new Set(rawIds).size !== rawIds.length
      ) {
        return null
      }
      const ids = rawIds as PresetId[]
      const existing = await memberships.bulkGet(ids)
      if (existing.some((membership) => membership !== undefined)) return null
      await memberships.bulkAdd(ids.map((presetId) => ({ presetId, blockId })))
      orderedCount += ids.length
      if (orderedCount > state.exactCount) return null
    }
    visitedBlockCount += 1
    previousBlockId = blockId
    currentBlockId = value.nextBlockId
  }
  if (
    visitedBlockCount !== blockCount ||
    previousBlockId !== state.tailBlockId ||
    orderedCount !== state.exactCount
  ) {
    return null
  }
  return { orderedCount }
}

async function rebuildPresetOrderFromStagingV94(
  tx: Transaction,
  plan: WaveAPresetOrderPlanV94,
): Promise<void> {
  const blocks = tx.idbtrans.objectStore('presetOrderBlocks')
  const memberships = tx.idbtrans.objectStore('presetOrderMembership')
  const states = tx.idbtrans.objectStore('presetOrderState')
  let headBlockId: string | null = null
  let previousBlockId: string | null = null
  let currentBlockId: string | null = null
  let tailBlockId: string | null = null
  let exactCount = 0

  for (;;) {
    const rawPage = await rawRequestV94(
      blocks.getAll(presetOrderStageRangeV94(), PRESET_ORDER_PAGE_SIZE_V94),
      'PresetOrderStageRead',
    )
    if (rawPage.length === 0) break
    const page = rawPage.map(parsePresetOrderStageRowV94)
    const firstKey = page[0]?.id
    const lastKey = page.at(-1)?.id
    if (!firstKey || !lastKey) throw new Error('PresetOrderStagePageInvalid')
    const hasMore =
      page.length === PRESET_ORDER_PAGE_SIZE_V94 &&
      (await hasPresetOrderStageAfterV94(blocks, lastKey))

    currentBlockId ??= newId()
    const nextBlockId = hasMore ? newId() : null
    const presetIds = page.map((row) => row.presetId)
    await Promise.all([
      rawRequestV94(
        blocks.put({
          id: currentBlockId,
          previousBlockId,
          nextBlockId,
          presetIds,
        } satisfies PresetOrderBlockRow),
        'PresetOrderBlockWrite',
      ),
      putRawRowsV94(
        memberships,
        presetIds.map((presetId) => ({ presetId, blockId: currentBlockId as string })),
        'add',
        'PresetOrderMembershipWrite',
      ),
      rawRequestV94(
        blocks.delete(IDBKeyRange.bound(firstKey, lastKey)),
        'PresetOrderStagePageDelete',
      ),
    ])
    headBlockId ??= currentBlockId
    tailBlockId = currentBlockId
    previousBlockId = currentBlockId
    currentBlockId = nextBlockId
    exactCount += presetIds.length
    if (!hasMore) break
  }

  if (exactCount !== plan.activeCount) throw new Error('PresetOrderStageCountMismatch')
  const revision = plan.previousRevision < Number.MAX_SAFE_INTEGER ? plan.previousRevision + 1 : 0
  await rawRequestV94(
    states.put({
      id: PRESET_ORDER_STATE_ID,
      revision,
      exactCount,
      headBlockId,
      tailBlockId,
    } satisfies PresetOrderStateRow),
    'PresetOrderStateWrite',
  )
  await rawRequestV94(blocks.delete(presetOrderStageRangeV94()), 'PresetOrderStageFinalDelete')
}

function hasPresetOrderStageAfterV94(
  store: IDBObjectStore,
  after: PresetOrderStageKeyV94,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = store.openKeyCursor(
      IDBKeyRange.bound(after, presetOrderStageUpperKeyV94(), true, true),
    )
    request.onerror = () => reject(request.error ?? new Error('PresetOrderStageLookaheadFailed'))
    request.onsuccess = () => resolve(request.result !== null)
  })
}

function validPresetOrderStateV94(value: unknown): PresetOrderStateRow | null {
  const row = recordV94(value)
  if (
    !row ||
    row.id !== PRESET_ORDER_STATE_ID ||
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 0 ||
    !Number.isSafeInteger(row.exactCount) ||
    (row.exactCount as number) < 0 ||
    !validNullableIdV94(row.headBlockId) ||
    !validNullableIdV94(row.tailBlockId)
  ) {
    return null
  }
  const empty = row.exactCount === 0
  if (empty !== (row.headBlockId === null) || empty !== (row.tailBlockId === null)) return null
  return row as unknown as PresetOrderStateRow
}

function parsePresetOrderStageRowV94(value: unknown): PresetOrderStageRowV94 {
  const row = recordV94(value)
  const key = row?.id
  if (
    !row ||
    !Array.isArray(key) ||
    key.length !== 5 ||
    key[0] !== PRESET_ORDER_STAGE_PREFIX_V94 ||
    (key[1] !== 0 && key[1] !== 1) ||
    typeof key[2] !== 'number' ||
    !Number.isFinite(key[2]) ||
    typeof key[3] !== 'number' ||
    !Number.isFinite(key[3]) ||
    typeof key[4] !== 'string' ||
    row.presetId !== key[4]
  ) {
    throw new Error('PresetOrderStageRowInvalid')
  }
  return { id: key as PresetOrderStageKeyV94, presetId: key[4] }
}

function presetOrderStageLowerKeyV94(): IDBValidKey {
  return [PRESET_ORDER_STAGE_PREFIX_V94]
}

function presetOrderStageUpperKeyV94(): IDBValidKey {
  return [PRESET_ORDER_STAGE_PREFIX_V94, []]
}

function presetOrderStageRangeV94(): IDBKeyRange {
  return IDBKeyRange.bound(presetOrderStageLowerKeyV94(), presetOrderStageUpperKeyV94(), true, true)
}

function normalizedRevisionV94(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0
}

function validNullableIdV94(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0)
}

function recordV94(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function rawRequestV94<T>(request: IDBRequest<T>, operation: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error(`WaveA${operation}Failed`))
    request.onsuccess = () => resolve(request.result)
  })
}

function putRawRowsV94(
  store: IDBObjectStore,
  rows: readonly unknown[],
  method: 'add' | 'put',
  operation: string,
): Promise<void> {
  if (rows.length === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let remaining = rows.length
    let settled = false
    for (const row of rows) {
      const request = store[method](row)
      request.onerror = () => {
        if (settled) return
        settled = true
        reject(request.error ?? new Error(`WaveA${operation}Failed`))
      }
      request.onsuccess = () => {
        if (settled) return
        remaining -= 1
        if (remaining === 0) {
          settled = true
          resolve()
        }
      }
    }
  })
}

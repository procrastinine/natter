import type { Table, Transaction } from 'dexie'
import type { PresetId } from '../core/types'
import { newId } from '../lib/ulid'
import { recordBrowserCommandInvalidation } from './browser-command-mutation-journal'
import {
  deletePhysicalStorageRows,
  putPhysicalStorageRow,
  putPhysicalStorageRows,
} from './byte-owner-mutation'
import { physicalStorageTables } from './physical-storage-tables'

export const PRESET_ORDER_MUTATION_TRANSACTION_CAPABILITY = physicalStorageTables(
  'presetOrderState',
  'presetOrderBlocks',
  'presetOrderMembership',
)

export const PRESET_ORDER_STATE_ID = 'active'

export interface PresetOrderStateRow {
  readonly id: typeof PRESET_ORDER_STATE_ID
  readonly revision: number
  readonly exactCount: number
  readonly headBlockId: string | null
  readonly tailBlockId: string | null
}

export interface PresetOrderBlockRow {
  readonly id: string
  readonly previousBlockId: string | null
  readonly nextBlockId: string | null
  readonly presetIds: readonly PresetId[]
}

export interface PresetOrderMembershipRow {
  readonly presetId: PresetId
  readonly blockId: string
}

export interface PresetOrderMutationReceipt {
  readonly presetId: PresetId
  readonly changed: boolean
  readonly reads: readonly PresetOrderPhysicalRead[]
  readonly mutations: readonly PresetOrderPhysicalMutation[]
}

export interface PresetOrderPhysicalRead {
  readonly tableName: 'presetOrderState' | 'presetOrderBlocks' | 'presetOrderMembership'
  readonly operation: 'get' | 'get-many'
  readonly requestCount: number
  readonly rowCount: number
}

export interface PresetOrderPhysicalMutation {
  readonly tableName: 'presetOrderState' | 'presetOrderBlocks' | 'presetOrderMembership'
  readonly operation: 'write' | 'delete'
  readonly key: string
}

interface MutablePresetOrderState {
  id: typeof PRESET_ORDER_STATE_ID
  revision: number
  exactCount: number
  headBlockId: string | null
  tailBlockId: string | null
}

interface MutablePresetOrderBlock {
  id: string
  previousBlockId: string | null
  nextBlockId: string | null
  presetIds: PresetId[]
}

const PRESET_ORDER_TARGET_BLOCK_SIZE = 64
const PRESET_ORDER_MIN_BLOCK_SIZE = 32
const PRESET_ORDER_MAX_BLOCK_SIZE = 96
const revisionClaimedTransactions = new WeakSet<Transaction>()

export function emptyPresetOrderState(): PresetOrderStateRow {
  return {
    id: PRESET_ORDER_STATE_ID,
    revision: 0,
    exactCount: 0,
    headBlockId: null,
    tailBlockId: null,
  }
}

export async function bumpPresetCatalogRevision(
  tx: Transaction,
  presetId: PresetId,
): Promise<PresetOrderMutationReceipt> {
  if (!claimPresetCatalogRevision(tx)) return emptyPresetOrderMutationReceipt(presetId)
  const table = tx.table<PresetOrderStateRow, typeof PRESET_ORDER_STATE_ID>('presetOrderState')
  const current = await table.get(PRESET_ORDER_STATE_ID)
  if (!current) throw new Error('PresetOrderStateMissing')
  await putPhysicalStorageRow(
    tx,
    'presetOrderState',
    { ...current, revision: current.revision + 1 },
    current,
  )
  const reads: readonly PresetOrderPhysicalRead[] = Object.freeze([
    {
      tableName: 'presetOrderState',
      operation: 'get',
      requestCount: 1,
      rowCount: 1,
    },
  ])
  const mutations: readonly PresetOrderPhysicalMutation[] = Object.freeze([
    {
      tableName: 'presetOrderState',
      operation: 'write',
      key: PRESET_ORDER_STATE_ID,
    },
  ])
  return Object.freeze({
    presetId,
    changed: true,
    reads,
    mutations,
  })
}

export async function appendPresetOrderEntry(
  tx: Transaction,
  presetId: PresetId,
): Promise<PresetOrderMutationReceipt> {
  const mutation = new PresetOrderMutation(tx)
  if (await mutation.locate(presetId)) throw new Error(`PresetOrderMembershipDuplicate:${presetId}`)
  await mutation.bumpCatalogRevision()
  const state = await mutation.loadState()
  const afterPresetId = state.tailBlockId
    ? ((await mutation.loadBlock(state.tailBlockId)).presetIds.at(-1) ?? null)
    : null
  await mutation.insertAfter(presetId, afterPresetId, true)
  const receipt = await mutation.commit(presetId)
  recordPresetOrderChanged(tx, presetId)
  return receipt
}

export async function movePresetOrderEntry(
  tx: Transaction,
  presetId: PresetId,
  afterPresetId: PresetId | null,
): Promise<PresetOrderMutationReceipt> {
  const mutation = new PresetOrderMutation(tx)
  const current = await mutation.locate(presetId)
  if (!current) throw new Error(`PresetOrderMembershipMissing:${presetId}`)
  if (afterPresetId === presetId) throw new Error('PresetOrderAnchorSelf')
  if (afterPresetId && !(await mutation.locate(afterPresetId))) {
    throw new Error(`PresetOrderAnchorMissing:${afterPresetId}`)
  }
  if ((await mutation.predecessor(current)) === afterPresetId) {
    return mutation.receipt(presetId, [])
  }
  await mutation.bumpCatalogRevision()
  await mutation.removeLocated(current, false)
  await mutation.insertAfter(presetId, afterPresetId, false)
  const receipt = await mutation.commit(presetId)
  recordPresetOrderChanged(tx, presetId)
  return receipt
}

export async function removePresetOrderEntry(
  tx: Transaction,
  presetId: PresetId,
): Promise<PresetOrderMutationReceipt> {
  const mutation = new PresetOrderMutation(tx)
  const current = await mutation.locate(presetId)
  if (!current) throw new Error(`PresetOrderMembershipMissing:${presetId}`)
  await mutation.bumpCatalogRevision()
  await mutation.removeLocated(current, true)
  const receipt = await mutation.commit(presetId)
  recordPresetOrderChanged(tx, presetId)
  return receipt
}

export function emptyPresetOrderMutationReceipt(presetId: PresetId): PresetOrderMutationReceipt {
  return Object.freeze({
    presetId,
    changed: false,
    reads: Object.freeze([]),
    mutations: Object.freeze([]),
  })
}

export async function buildPresetOrderOnEmptyTables(
  tables: {
    readonly states: Table<PresetOrderStateRow, typeof PRESET_ORDER_STATE_ID>
    readonly blocks: Table<PresetOrderBlockRow, string>
    readonly memberships: Table<PresetOrderMembershipRow, PresetId>
  },
  presetIds: Iterable<PresetId>,
  runTransaction: <T>(
    tables: readonly Table[],
    operation: (tx: Transaction) => Promise<T>,
  ) => Promise<T>,
  checkpoint: () => void = () => undefined,
): Promise<void> {
  const counts = await runTransaction([tables.states, tables.blocks, tables.memberships], (tx) =>
    Promise.all([
      tx.table<PresetOrderStateRow, typeof PRESET_ORDER_STATE_ID>(tables.states.name).count(),
      tx.table<PresetOrderBlockRow, string>(tables.blocks.name).count(),
      tx.table<PresetOrderMembershipRow, PresetId>(tables.memberships.name).count(),
    ]),
  )
  if (counts.some((count) => count !== 0)) throw new Error('PresetOrderBuildTargetNotEmpty')

  let headBlockId: string | null = null
  let tailBlockId: string | null = null
  let previous: PresetOrderBlockRow | null = null
  let buffer: PresetId[] = []
  let exactCount = 0
  const writePrevious = async (nextBlockId: string | null): Promise<void> => {
    if (!previous) return
    checkpoint()
    const block = { ...previous, nextBlockId }
    await runTransaction([tables.blocks, tables.memberships], async (tx) => {
      await tx.table<PresetOrderBlockRow, string>(tables.blocks.name).add(block)
      await tx
        .table<PresetOrderMembershipRow, PresetId>(tables.memberships.name)
        .bulkAdd(block.presetIds.map((presetId) => ({ presetId, blockId: block.id })))
    })
  }
  const rotateBlock = async (): Promise<void> => {
    if (buffer.length === 0) return
    const id = newId()
    await writePrevious(id)
    headBlockId ??= id
    tailBlockId = id
    previous = {
      id,
      previousBlockId: previous?.id ?? null,
      nextBlockId: null,
      presetIds: Object.freeze(buffer),
    }
    buffer = []
  }
  for (const presetId of presetIds) {
    buffer.push(presetId)
    exactCount += 1
    if (buffer.length === PRESET_ORDER_TARGET_BLOCK_SIZE) await rotateBlock()
  }
  await rotateBlock()
  await writePrevious(null)
  checkpoint()
  await runTransaction([tables.states], async (tx) => {
    await tx.table<PresetOrderStateRow, typeof PRESET_ORDER_STATE_ID>(tables.states.name).add({
      id: PRESET_ORDER_STATE_ID,
      revision: 0,
      exactCount,
      headBlockId,
      tailBlockId,
    })
  })
}

export async function rebuildPresetOrderMembership(tx: Transaction): Promise<void> {
  const blocks = tx.table<PresetOrderBlockRow, string>('presetOrderBlocks')
  const memberships = tx.table<PresetOrderMembershipRow, PresetId>('presetOrderMembership')
  await memberships.clear()
  let after: string | undefined
  for (;;) {
    const page = await (after === undefined
      ? blocks.orderBy(':id')
      : blocks.where(':id').above(after)
    )
      .limit(PRESET_ORDER_TARGET_BLOCK_SIZE)
      .toArray()
    if (page.length === 0) return
    await memberships.bulkAdd(
      page.flatMap((block) => block.presetIds.map((presetId) => ({ presetId, blockId: block.id }))),
    )
    if (page.length < PRESET_ORDER_TARGET_BLOCK_SIZE) return
    after = page.at(-1)?.id
    if (!after) throw new Error('PresetOrderRepairCursorMissing')
  }
}

export async function readPresetOrderIds(tx: Transaction): Promise<readonly PresetId[]> {
  const state = await tx
    .table<PresetOrderStateRow, typeof PRESET_ORDER_STATE_ID>('presetOrderState')
    .get(PRESET_ORDER_STATE_ID)
  if (!state) throw new Error('PresetOrderStateMissing')
  const storedBlocks = await tx.table<PresetOrderBlockRow, string>('presetOrderBlocks').toArray()
  const blocksById = new Map(storedBlocks.map((block) => [block.id, block]))
  const ordered: PresetId[] = []
  const visitedBlocks = new Set<string>()
  const visitedPresets = new Set<PresetId>()
  let previousBlockId: string | null = null
  let blockId = state.headBlockId
  while (blockId) {
    if (visitedBlocks.has(blockId)) throw new Error(`PresetOrderBlockCycle:${blockId}`)
    visitedBlocks.add(blockId)
    const block = blocksById.get(blockId)
    if (!block) throw new Error(`PresetOrderBlockMissing:${blockId}`)
    if (block.previousBlockId !== previousBlockId) {
      throw new Error(`PresetOrderPreviousLinkInvalid:${blockId}`)
    }
    if (block.presetIds.length === 0 || block.presetIds.length > PRESET_ORDER_MAX_BLOCK_SIZE) {
      throw new Error(`PresetOrderBlockOccupancyInvalid:${blockId}`)
    }
    for (const presetId of block.presetIds) {
      if (visitedPresets.has(presetId)) throw new Error(`PresetOrderPresetDuplicate:${presetId}`)
      visitedPresets.add(presetId)
      ordered.push(presetId)
    }
    previousBlockId = block.id
    blockId = block.nextBlockId
  }
  if (previousBlockId !== state.tailBlockId) throw new Error('PresetOrderTailInvalid')
  if (visitedBlocks.size !== blocksById.size) throw new Error('PresetOrderOrphanBlock')
  if (ordered.length !== state.exactCount) throw new Error('PresetOrderCountInvalid')
  return Object.freeze(ordered)
}

interface LocatedPresetOrderEntry {
  readonly block: MutablePresetOrderBlock
  readonly index: number
}

class PresetOrderMutation {
  private readonly tx: Transaction
  private originalState: PresetOrderStateRow | undefined
  private state: MutablePresetOrderState | undefined
  private readonly originalBlocks = new Map<string, PresetOrderBlockRow | undefined>()
  private readonly blocks = new Map<string, MutablePresetOrderBlock | null>()
  private stateGetRequests = 0
  private blockGetRequests = 0
  private membershipGetRequests = 0
  private membershipGetManyRequests = 0
  private membershipGetManyRows = 0

  constructor(tx: Transaction) {
    this.tx = tx
  }

  async loadState(): Promise<MutablePresetOrderState> {
    if (this.state) return this.state
    this.stateGetRequests += 1
    const current = await this.tx
      .table<PresetOrderStateRow, typeof PRESET_ORDER_STATE_ID>('presetOrderState')
      .get(PRESET_ORDER_STATE_ID)
    if (!current) throw new Error('PresetOrderStateMissing')
    this.originalState = current
    this.state = { ...current }
    return this.state
  }

  async bumpCatalogRevision(): Promise<void> {
    if (!claimPresetCatalogRevision(this.tx)) return
    const state = await this.loadState()
    state.revision += 1
  }

  async loadBlock(blockId: string): Promise<MutablePresetOrderBlock> {
    if (this.blocks.has(blockId)) {
      const loaded = this.blocks.get(blockId)
      if (!loaded) throw new Error(`PresetOrderBlockDeleted:${blockId}`)
      return loaded
    }
    this.blockGetRequests += 1
    const current = await this.tx
      .table<PresetOrderBlockRow, string>('presetOrderBlocks')
      .get(blockId)
    if (!current) throw new Error(`PresetOrderBlockMissing:${blockId}`)
    const block = { ...current, presetIds: [...current.presetIds] }
    this.originalBlocks.set(blockId, current)
    this.blocks.set(blockId, block)
    return block
  }

  async locate(presetId: PresetId): Promise<LocatedPresetOrderEntry | null> {
    for (const block of this.blocks.values()) {
      if (!block) continue
      const index = block.presetIds.indexOf(presetId)
      if (index >= 0) return { block, index }
    }
    this.membershipGetRequests += 1
    const membership = await this.tx
      .table<PresetOrderMembershipRow, PresetId>('presetOrderMembership')
      .get(presetId)
    if (!membership) return null
    const block = await this.loadBlock(membership.blockId)
    const index = block.presetIds.indexOf(presetId)
    if (index < 0) throw new Error(`PresetOrderMembershipBlockMismatch:${presetId}`)
    return { block, index }
  }

  async predecessor(entry: LocatedPresetOrderEntry): Promise<PresetId | null> {
    if (entry.index > 0) return entry.block.presetIds[entry.index - 1] ?? null
    if (!entry.block.previousBlockId) return null
    return (await this.loadBlock(entry.block.previousBlockId)).presetIds.at(-1) ?? null
  }

  async removeLocated(entry: LocatedPresetOrderEntry, adjustCount: boolean): Promise<void> {
    const state = await this.loadState()
    entry.block.presetIds.splice(entry.index, 1)
    if (entry.block.presetIds.length === 0) await this.unlinkEmptyBlock(entry.block, state)
    else if (entry.block.presetIds.length < PRESET_ORDER_MIN_BLOCK_SIZE) {
      await this.rebalanceUnderfullBlock(entry.block, state)
    }
    if (adjustCount) {
      state.exactCount -= 1
      if (state.exactCount < 0) throw new Error('PresetOrderCountUnderflow')
    }
  }

  async insertAfter(
    presetId: PresetId,
    afterPresetId: PresetId | null,
    adjustCount: boolean,
  ): Promise<void> {
    const state = await this.loadState()
    let target: MutablePresetOrderBlock
    let index: number
    if (state.headBlockId === null) {
      target = this.createBlock([], null, null)
      state.headBlockId = target.id
      state.tailBlockId = target.id
      index = 0
    } else if (afterPresetId === null) {
      target = await this.loadBlock(state.headBlockId)
      index = 0
    } else {
      const anchor = await this.locate(afterPresetId)
      if (!anchor) throw new Error(`PresetOrderAnchorMissing:${afterPresetId}`)
      target = anchor.block
      index = anchor.index + 1
    }
    target.presetIds.splice(index, 0, presetId)
    if (target.presetIds.length > PRESET_ORDER_MAX_BLOCK_SIZE) {
      await this.splitOverflowBlock(target, state)
    }
    if (adjustCount) {
      state.exactCount += 1
    }
  }

  async commit(presetId: PresetId): Promise<PresetOrderMutationReceipt> {
    const mutations: PresetOrderPhysicalMutation[] = []
    const state = this.state
    if (state && (!this.originalState || !sameState(this.originalState, state))) {
      await putPhysicalStorageRow(
        this.tx,
        'presetOrderState',
        Object.freeze({ ...state }),
        this.originalState,
      )
      mutations.push({
        tableName: 'presetOrderState',
        operation: 'write',
        key: PRESET_ORDER_STATE_ID,
      })
    }

    const affectedPresetIds = new Set<PresetId>()
    for (const [blockId, current] of this.blocks) {
      const previous = this.originalBlocks.get(blockId)
      for (const presetId of previous?.presetIds ?? []) affectedPresetIds.add(presetId)
      for (const presetId of current?.presetIds ?? []) affectedPresetIds.add(presetId)
      if (!current) {
        if (previous) {
          await deletePhysicalStorageRows(this.tx, 'presetOrderBlocks', [blockId], [previous])
          mutations.push({
            tableName: 'presetOrderBlocks',
            operation: 'delete',
            key: blockId,
          })
        }
      } else if (!previous || !sameBlock(previous, current)) {
        await putPhysicalStorageRow(this.tx, 'presetOrderBlocks', frozenBlock(current), previous)
        mutations.push({
          tableName: 'presetOrderBlocks',
          operation: 'write',
          key: blockId,
        })
      }
    }

    const affected = [...affectedPresetIds]
    const membershipTable = this.tx.table<PresetOrderMembershipRow, PresetId>(
      'presetOrderMembership',
    )
    this.membershipGetManyRequests += 1
    this.membershipGetManyRows += affected.length
    const previousMemberships = await membershipTable.bulkGet(affected)
    const nextMemberships = new Map<PresetId, PresetOrderMembershipRow>()
    for (const block of this.blocks.values()) {
      if (!block) continue
      for (const presetId of block.presetIds) {
        if (affectedPresetIds.has(presetId)) {
          nextMemberships.set(presetId, { presetId, blockId: block.id })
        }
      }
    }
    const puts: PresetOrderMembershipRow[] = []
    const replaced: PresetOrderMembershipRow[] = []
    const deletes: PresetId[] = []
    const deletedRows: PresetOrderMembershipRow[] = []
    for (let index = 0; index < affected.length; index += 1) {
      const presetId = affected[index] as PresetId
      const previous = previousMemberships[index]
      const next = nextMemberships.get(presetId)
      if (!next) {
        if (previous) {
          deletes.push(presetId)
          deletedRows.push(previous)
        }
      } else if (!previous || previous.blockId !== next.blockId) {
        puts.push(next)
        if (previous) replaced.push(previous)
      }
    }
    await putPhysicalStorageRows(this.tx, 'presetOrderMembership', puts, replaced)
    await deletePhysicalStorageRows(this.tx, 'presetOrderMembership', deletes, deletedRows)
    mutations.push(
      ...puts.map(({ presetId: changedPresetId }) => ({
        tableName: 'presetOrderMembership' as const,
        operation: 'write' as const,
        key: changedPresetId,
      })),
      ...deletes.map((changedPresetId) => ({
        tableName: 'presetOrderMembership' as const,
        operation: 'delete' as const,
        key: changedPresetId,
      })),
    )
    return this.receipt(presetId, mutations)
  }

  receipt(
    presetId: PresetId,
    mutations: readonly PresetOrderPhysicalMutation[],
  ): PresetOrderMutationReceipt {
    const reads: PresetOrderPhysicalRead[] = []
    if (this.stateGetRequests > 0) {
      reads.push({
        tableName: 'presetOrderState',
        operation: 'get',
        requestCount: this.stateGetRequests,
        rowCount: this.stateGetRequests,
      })
    }
    if (this.blockGetRequests > 0) {
      reads.push({
        tableName: 'presetOrderBlocks',
        operation: 'get',
        requestCount: this.blockGetRequests,
        rowCount: this.blockGetRequests,
      })
    }
    if (this.membershipGetRequests > 0) {
      reads.push({
        tableName: 'presetOrderMembership',
        operation: 'get',
        requestCount: this.membershipGetRequests,
        rowCount: this.membershipGetRequests,
      })
    }
    if (this.membershipGetManyRequests > 0) {
      reads.push({
        tableName: 'presetOrderMembership',
        operation: 'get-many',
        requestCount: this.membershipGetManyRequests,
        rowCount: this.membershipGetManyRows,
      })
    }
    return Object.freeze({
      presetId,
      changed: mutations.length > 0,
      reads: Object.freeze(reads),
      mutations: Object.freeze([...mutations]),
    })
  }

  private createBlock(
    presetIds: readonly PresetId[],
    previousBlockId: string | null,
    nextBlockId: string | null,
  ): MutablePresetOrderBlock {
    const block: MutablePresetOrderBlock = {
      id: newId(),
      previousBlockId,
      nextBlockId,
      presetIds: [...presetIds],
    }
    this.originalBlocks.set(block.id, undefined)
    this.blocks.set(block.id, block)
    return block
  }

  private async unlinkEmptyBlock(
    block: MutablePresetOrderBlock,
    state: MutablePresetOrderState,
  ): Promise<void> {
    const previous = block.previousBlockId ? await this.loadBlock(block.previousBlockId) : null
    const next = block.nextBlockId ? await this.loadBlock(block.nextBlockId) : null
    if (previous) previous.nextBlockId = next?.id ?? null
    else state.headBlockId = next?.id ?? null
    if (next) next.previousBlockId = previous?.id ?? null
    else state.tailBlockId = previous?.id ?? null
    this.blocks.set(block.id, null)
  }

  private async rebalanceUnderfullBlock(
    block: MutablePresetOrderBlock,
    state: MutablePresetOrderState,
  ): Promise<void> {
    const neighborId = block.nextBlockId ?? block.previousBlockId
    if (!neighborId) return
    const neighbor = await this.loadBlock(neighborId)
    const left = block.nextBlockId ? block : neighbor
    const right = block.nextBlockId ? neighbor : block
    const combined = [...left.presetIds, ...right.presetIds]
    if (combined.length <= PRESET_ORDER_MAX_BLOCK_SIZE) {
      left.presetIds = combined
      left.nextBlockId = right.nextBlockId
      if (right.nextBlockId) {
        const next = await this.loadBlock(right.nextBlockId)
        next.previousBlockId = left.id
      } else {
        state.tailBlockId = left.id
      }
      this.blocks.set(right.id, null)
      return
    }
    const splitAt = Math.floor(combined.length / 2)
    left.presetIds = combined.slice(0, splitAt)
    right.presetIds = combined.slice(splitAt)
  }

  private async splitOverflowBlock(
    block: MutablePresetOrderBlock,
    state: MutablePresetOrderState,
  ): Promise<void> {
    const next = block.nextBlockId ? await this.loadBlock(block.nextBlockId) : null
    const right = this.createBlock(
      block.presetIds.slice(PRESET_ORDER_TARGET_BLOCK_SIZE),
      block.id,
      next?.id ?? null,
    )
    block.presetIds = block.presetIds.slice(0, PRESET_ORDER_TARGET_BLOCK_SIZE)
    block.nextBlockId = right.id
    if (next) next.previousBlockId = right.id
    else state.tailBlockId = right.id
  }
}

function claimPresetCatalogRevision(tx: Transaction): boolean {
  if (revisionClaimedTransactions.has(tx)) return false
  revisionClaimedTransactions.add(tx)
  return true
}

function sameState(left: PresetOrderStateRow, right: MutablePresetOrderState): boolean {
  return (
    left.revision === right.revision &&
    left.exactCount === right.exactCount &&
    left.headBlockId === right.headBlockId &&
    left.tailBlockId === right.tailBlockId
  )
}

function sameBlock(left: PresetOrderBlockRow, right: MutablePresetOrderBlock): boolean {
  return (
    left.previousBlockId === right.previousBlockId &&
    left.nextBlockId === right.nextBlockId &&
    left.presetIds.length === right.presetIds.length &&
    left.presetIds.every((presetId, index) => presetId === right.presetIds[index])
  )
}

function frozenBlock(block: MutablePresetOrderBlock): PresetOrderBlockRow {
  return Object.freeze({ ...block, presetIds: Object.freeze([...block.presetIds]) })
}

function recordPresetOrderChanged(tx: Transaction, presetId: PresetId): void {
  recordBrowserCommandInvalidation(tx, {
    kind: 'preset',
    presetIds: [presetId],
    facets: ['catalog-order'],
  })
}

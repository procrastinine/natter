import type { Transaction } from 'dexie'
import type {
  ChatPreset,
  ConnectionProfile,
  PresetId,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  PromptPresetKind,
} from '../core/types'
import { deletePhysicalStorageRows, putPhysicalStorageRow } from './byte-owner-mutation'
import {
  CONFIGURATION_PROFILE_MANAGER_STATE_ID,
  type ConfigurationProfileManagerStateRow,
  emptyConfigurationProfileManagerStateRow,
} from './configuration-profile-usage-projection'
import { scalarCompoundIndexBetween } from './indexeddb-key-ranges'
import { physicalStorageTables } from './physical-storage-tables'
import {
  bumpPresetCatalogRevision,
  emptyPresetOrderMutationReceipt,
  type PresetOrderMutationReceipt,
} from './preset-order'
import type {
  ConfigurationPresetCatalogRow,
  ConfigurationProfileCatalogRow,
  ConfigurationPromptPresetCatalogRow,
} from './workspace-protocol'

export const CONFIGURATION_PROFILE_CATALOG_TRANSACTION_CAPABILITY = physicalStorageTables(
  'configurationProfileCatalogRows',
  'configurationCatalogAggregates',
)
export const CONFIGURATION_PRESET_CATALOG_TRANSACTION_CAPABILITY = physicalStorageTables(
  'configurationPresetCatalogRows',
  'presetOrderState',
)
export const CONFIGURATION_PRESET_RECENCY_TRANSACTION_CAPABILITY = physicalStorageTables(
  'configurationPresetCatalogRows',
)
export const CONFIGURATION_PROMPT_PRESET_CATALOG_TRANSACTION_CAPABILITY = physicalStorageTables(
  'configurationPromptPresetCatalogRows',
  'configurationCatalogAggregates',
)
export const CONFIGURATION_PROMPT_PRESET_RECENCY_TRANSACTION_CAPABILITY = physicalStorageTables(
  'configurationPromptPresetCatalogRows',
)

export interface ConfigurationCatalogProjectionMutationReceipt {
  readonly projectionTable:
    | 'configurationProfileCatalogRows'
    | 'configurationPresetCatalogRows'
    | 'configurationPromptPresetCatalogRows'
  readonly projectionId: string
  readonly projectionMutation: 'write' | 'delete' | 'none'
  readonly aggregateIds: readonly string[]
}

export interface ConfigurationPresetCatalogMutationReceipt {
  readonly projection: ConfigurationCatalogProjectionMutationReceipt
  readonly order: PresetOrderMutationReceipt
}

export interface ConfigurationProfileCatalogProjectionRow extends ConfigurationProfileCatalogRow {
  readonly archived: boolean
  readonly activeKey: 0 | 1
  readonly managerTier: 0 | 1
  readonly mruSortKey: number
  readonly nameSortKey: string
}

export function configurationCatalogNameSortKey(name: string): string {
  return name.normalize('NFKC').toLowerCase()
}

export function configurationProfileCatalogProjectionRow(
  profile: ConnectionProfile,
): ConfigurationProfileCatalogProjectionRow {
  return {
    id: profile.id,
    name: profile.name,
    kind: profile.kind,
    ...(profile.lastUsedAt === undefined ? {} : { lastUsedAt: profile.lastUsedAt }),
    archived: profile.archived === true,
    activeKey: profile.archived === true ? 0 : 1,
    managerTier: profile.archived === true ? 1 : 0,
    mruSortKey: -(profile.lastUsedAt ?? 0),
    nameSortKey: configurationCatalogNameSortKey(profile.name),
  }
}

export async function readDefaultConfigurationProfileId(
  transaction: Transaction,
): Promise<ProfileId | null> {
  const row = await transaction
    .table<ConfigurationProfileCatalogProjectionRow, ProfileId>('configurationProfileCatalogRows')
    .where('[activeKey+mruSortKey+nameSortKey+id]')
    .between(...scalarCompoundIndexBetween([1], [1], 4))
    .first()
  return row?.id ?? null
}

export const CONFIGURATION_CATALOG_AGGREGATE_ID = 'global'
export const CONFIGURATION_PROFILE_CATALOG_STATE_ID = 'profiles:active'

export type ConfigurationCatalogStateId =
  | typeof CONFIGURATION_PROFILE_CATALOG_STATE_ID
  | typeof CONFIGURATION_PROFILE_MANAGER_STATE_ID
  | `prompt-presets:${PromptPresetKind}`

export interface ConfigurationCatalogAggregateRow {
  readonly id: typeof CONFIGURATION_CATALOG_AGGREGATE_ID
  readonly totalProfileCount: number
}

export interface ConfigurationCatalogStateRow {
  readonly id: ConfigurationCatalogStateId
  readonly revision: number
  readonly exactCount: number
}

export type ConfigurationCatalogMetadataRow =
  | ConfigurationCatalogAggregateRow
  | ConfigurationCatalogStateRow
  | ConfigurationProfileManagerStateRow

export interface ConfigurationCatalogCounts {
  readonly totalProfileCount: number
  readonly activeProfileCount: number
  readonly promptPresetCounts: Readonly<Record<PromptPresetKind, number>>
}

export function emptyConfigurationCatalogAggregateRow(): ConfigurationCatalogAggregateRow {
  return { id: CONFIGURATION_CATALOG_AGGREGATE_ID, totalProfileCount: 0 }
}

export function configurationPromptPresetCatalogStateId(
  kind: PromptPresetKind,
): ConfigurationCatalogStateId {
  return `prompt-presets:${kind}`
}

export function emptyConfigurationCatalogStateRow(
  id: ConfigurationCatalogStateId,
): ConfigurationCatalogStateRow {
  return { id, revision: 0, exactCount: 0 }
}

export function emptyConfigurationCatalogMetadataRows(): readonly ConfigurationCatalogMetadataRow[] {
  return Object.freeze([
    emptyConfigurationCatalogAggregateRow(),
    emptyConfigurationCatalogStateRow(CONFIGURATION_PROFILE_CATALOG_STATE_ID),
    emptyConfigurationProfileManagerStateRow(),
    ...(['system', 'append', 'continue-system', 'continue-user', 'prefill'] as const).map((kind) =>
      emptyConfigurationCatalogStateRow(configurationPromptPresetCatalogStateId(kind)),
    ),
  ])
}

export function configurationCatalogMetadataRowsFromCounts(
  counts: ConfigurationCatalogCounts,
): readonly ConfigurationCatalogMetadataRow[] {
  return Object.freeze([
    { id: CONFIGURATION_CATALOG_AGGREGATE_ID, totalProfileCount: counts.totalProfileCount },
    {
      id: CONFIGURATION_PROFILE_CATALOG_STATE_ID,
      revision: 0,
      exactCount: counts.activeProfileCount,
    },
    {
      id: CONFIGURATION_PROFILE_MANAGER_STATE_ID,
      revision: 0,
      exactCount: counts.totalProfileCount,
    },
    ...(['system', 'append', 'continue-system', 'continue-user', 'prefill'] as const).map(
      (kind) => ({
        id: configurationPromptPresetCatalogStateId(kind),
        revision: 0,
        exactCount: counts.promptPresetCounts[kind],
      }),
    ),
  ])
}

async function updateConfigurationCatalogAggregate(
  transaction: Transaction,
  delta: -1 | 1,
): Promise<void> {
  const table = transaction.table<ConfigurationCatalogAggregateRow, string>(
    'configurationCatalogAggregates',
  )
  const current =
    (await table.get(CONFIGURATION_CATALOG_AGGREGATE_ID)) ?? emptyConfigurationCatalogAggregateRow()
  await putPhysicalStorageRow(
    transaction,
    'configurationCatalogAggregates',
    {
      id: CONFIGURATION_CATALOG_AGGREGATE_ID,
      totalProfileCount: Math.max(0, current.totalProfileCount + delta),
    },
    current,
  )
}

async function updateConfigurationCatalogState(
  transaction: Transaction,
  id: ConfigurationCatalogStateId,
  exactCountDelta: -1 | 0 | 1,
): Promise<void> {
  const table = transaction.table<ConfigurationCatalogStateRow, ConfigurationCatalogStateId>(
    'configurationCatalogAggregates',
  )
  const current = await table.get(id)
  if (!current) throw new Error(`ConfigurationCatalogStateMissing:${id}`)
  const exactCount = current.exactCount + exactCountDelta
  if (exactCount < 0) throw new Error(`ConfigurationCatalogCountUnderflow:${id}`)
  await putPhysicalStorageRow(
    transaction,
    'configurationCatalogAggregates',
    { id, revision: current.revision + 1, exactCount },
    current,
  )
}

export async function putConfigurationProfileCatalogProjection(
  transaction: Transaction,
  profile: ConnectionProfile,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  const next = configurationProfileCatalogProjectionRow(profile)
  const previous = await transaction
    .table<ConfigurationProfileCatalogProjectionRow, ProfileId>('configurationProfileCatalogRows')
    .get(profile.id)
  return applyConfigurationProfileCatalogProjectionRows(transaction, previous, next)
}

export function applyConfigurationProfileCatalogProjectionTransition(
  transaction: Transaction,
  previous: ConnectionProfile | undefined,
  next: ConnectionProfile,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  return applyConfigurationProfileCatalogProjectionRows(
    transaction,
    previous ? configurationProfileCatalogProjectionRow(previous) : undefined,
    configurationProfileCatalogProjectionRow(next),
  )
}

async function applyConfigurationProfileCatalogProjectionRows(
  transaction: Transaction,
  previous: ConfigurationProfileCatalogProjectionRow | undefined,
  next: ConfigurationProfileCatalogProjectionRow,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  if (previous && sameProfileProjection(previous, next)) {
    return configurationCatalogProjectionMutationReceipt(
      'configurationProfileCatalogRows',
      next.id,
      'none',
    )
  }
  const aggregateIds: string[] = []
  await putPhysicalStorageRow(transaction, 'configurationProfileCatalogRows', next, previous)
  if (!previous) {
    await updateConfigurationCatalogAggregate(transaction, 1)
    aggregateIds.push(CONFIGURATION_CATALOG_AGGREGATE_ID)
  }
  if (!previous || !sameProfileManagerProjection(previous, next)) {
    await updateConfigurationCatalogState(
      transaction,
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
      previous ? 0 : 1,
    )
    aggregateIds.push(CONFIGURATION_PROFILE_MANAGER_STATE_ID)
  }
  const previousActive = previous?.activeKey === 1
  const nextActive = next.activeKey === 1
  if (previousActive || nextActive) {
    await updateConfigurationCatalogState(
      transaction,
      CONFIGURATION_PROFILE_CATALOG_STATE_ID,
      previousActive === nextActive ? 0 : nextActive ? 1 : -1,
    )
    aggregateIds.push(CONFIGURATION_PROFILE_CATALOG_STATE_ID)
  }
  return configurationCatalogProjectionMutationReceipt(
    'configurationProfileCatalogRows',
    next.id,
    'write',
    aggregateIds,
  )
}

export function applyConfigurationProfileCatalogProjectionDeletion(
  transaction: Transaction,
  previous: ConnectionProfile,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  return deleteConfigurationProfileCatalogProjectionRow(
    transaction,
    previous.id,
    configurationProfileCatalogProjectionRow(previous),
  )
}

async function deleteConfigurationProfileCatalogProjectionRow(
  transaction: Transaction,
  profileId: ProfileId,
  previous: ConfigurationProfileCatalogProjectionRow | undefined,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  await deletePhysicalStorageRows(
    transaction,
    'configurationProfileCatalogRows',
    [profileId],
    previous ? [previous] : [],
  )
  if (previous) {
    await updateConfigurationCatalogAggregate(transaction, -1)
    await updateConfigurationCatalogState(transaction, CONFIGURATION_PROFILE_MANAGER_STATE_ID, -1)
    if (previous.activeKey === 1) {
      await updateConfigurationCatalogState(transaction, CONFIGURATION_PROFILE_CATALOG_STATE_ID, -1)
    }
  }
  return configurationCatalogProjectionMutationReceipt(
    'configurationProfileCatalogRows',
    profileId,
    previous ? 'delete' : 'none',
    previous
      ? [
          CONFIGURATION_CATALOG_AGGREGATE_ID,
          CONFIGURATION_PROFILE_MANAGER_STATE_ID,
          ...(previous.activeKey === 1 ? [CONFIGURATION_PROFILE_CATALOG_STATE_ID] : []),
        ]
      : [],
  )
}

export interface ConfigurationPresetCatalogProjectionRow extends ConfigurationPresetCatalogRow {
  readonly lastUsedAt?: number
  readonly archived: boolean
  readonly activeKey: 0 | 1
  readonly defaultTier: 0 | 1
  readonly defaultTime: number
}

export function configurationPresetCatalogProjectionRow(
  preset: ChatPreset,
): ConfigurationPresetCatalogProjectionRow {
  return {
    id: preset.id,
    name: preset.name,
    connectionProfileId: preset.connectionProfileId,
    createdAt: preset.createdAt,
    ...(preset.lastUsedAt === undefined ? {} : { lastUsedAt: preset.lastUsedAt }),
    archived: preset.archived === true,
    activeKey: preset.archived === true ? 0 : 1,
    defaultTier: preset.lastUsedAt === undefined ? 1 : 0,
    defaultTime: preset.lastUsedAt === undefined ? preset.createdAt : -preset.lastUsedAt,
  }
}

export async function putConfigurationPresetCatalogProjection(
  transaction: Transaction,
  preset: ChatPreset,
): Promise<ConfigurationPresetCatalogMutationReceipt> {
  const next = configurationPresetCatalogProjectionRow(preset)
  const previous = await transaction
    .table<ConfigurationPresetCatalogProjectionRow, PresetId>('configurationPresetCatalogRows')
    .get(preset.id)
  return applyConfigurationPresetCatalogProjectionRows(transaction, previous, next)
}

export function applyConfigurationPresetCatalogProjectionTransition(
  transaction: Transaction,
  previous: ChatPreset | undefined,
  next: ChatPreset,
): Promise<ConfigurationPresetCatalogMutationReceipt> {
  return applyConfigurationPresetCatalogProjectionRows(
    transaction,
    previous ? configurationPresetCatalogProjectionRow(previous) : undefined,
    configurationPresetCatalogProjectionRow(next),
  )
}

async function applyConfigurationPresetCatalogProjectionRows(
  transaction: Transaction,
  previous: ConfigurationPresetCatalogProjectionRow | undefined,
  next: ConfigurationPresetCatalogProjectionRow,
): Promise<ConfigurationPresetCatalogMutationReceipt> {
  if (previous && samePresetProjection(previous, next)) {
    return {
      projection: configurationCatalogProjectionMutationReceipt(
        'configurationPresetCatalogRows',
        next.id,
        'none',
      ),
      order: emptyPresetOrderMutationReceipt(next.id),
    }
  }
  const catalogChanged = !previous || !samePresetCatalogViewProjection(previous, next)
  await putPhysicalStorageRow(transaction, 'configurationPresetCatalogRows', next, previous)
  const order =
    catalogChanged && (previous?.activeKey === 1 || next.activeKey === 1)
      ? await bumpPresetCatalogRevision(transaction, next.id)
      : emptyPresetOrderMutationReceipt(next.id)
  return {
    projection: configurationCatalogProjectionMutationReceipt(
      'configurationPresetCatalogRows',
      next.id,
      'write',
    ),
    order,
  }
}

export async function putConfigurationPresetRecencyCatalogProjection(
  transaction: Transaction,
  preset: ChatPreset,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  const next = configurationPresetCatalogProjectionRow(preset)
  const previous = await transaction
    .table<ConfigurationPresetCatalogProjectionRow, PresetId>('configurationPresetCatalogRows')
    .get(preset.id)
  if (!previous) throw new Error(`ConfigurationPresetCatalogProjectionMissing:${preset.id}`)
  return applyConfigurationPresetRecencyCatalogProjectionRows(transaction, previous, next)
}

export function applyConfigurationPresetRecencyCatalogProjectionTransition(
  transaction: Transaction,
  previous: ChatPreset,
  next: ChatPreset,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  return applyConfigurationPresetRecencyCatalogProjectionRows(
    transaction,
    configurationPresetCatalogProjectionRow(previous),
    configurationPresetCatalogProjectionRow(next),
  )
}

async function applyConfigurationPresetRecencyCatalogProjectionRows(
  transaction: Transaction,
  previous: ConfigurationPresetCatalogProjectionRow,
  next: ConfigurationPresetCatalogProjectionRow,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  if (!samePresetCatalogViewProjection(previous, next)) {
    throw new Error(`ConfigurationPresetRecencyProjectionChangedCatalog:${next.id}`)
  }
  if (samePresetProjection(previous, next)) {
    return configurationCatalogProjectionMutationReceipt(
      'configurationPresetCatalogRows',
      next.id,
      'none',
    )
  }
  await putPhysicalStorageRow(transaction, 'configurationPresetCatalogRows', next, previous)
  return configurationCatalogProjectionMutationReceipt(
    'configurationPresetCatalogRows',
    next.id,
    'write',
  )
}

export async function deleteConfigurationPresetCatalogProjection(
  transaction: Transaction,
  presetId: PresetId,
): Promise<ConfigurationPresetCatalogMutationReceipt> {
  const previous = await transaction
    .table<ConfigurationPresetCatalogProjectionRow, PresetId>('configurationPresetCatalogRows')
    .get(presetId)
  return deleteConfigurationPresetCatalogProjectionRow(transaction, presetId, previous)
}

export function applyConfigurationPresetCatalogProjectionDeletion(
  transaction: Transaction,
  previous: ChatPreset,
): Promise<ConfigurationPresetCatalogMutationReceipt> {
  return deleteConfigurationPresetCatalogProjectionRow(
    transaction,
    previous.id,
    configurationPresetCatalogProjectionRow(previous),
  )
}

async function deleteConfigurationPresetCatalogProjectionRow(
  transaction: Transaction,
  presetId: PresetId,
  previous: ConfigurationPresetCatalogProjectionRow | undefined,
): Promise<ConfigurationPresetCatalogMutationReceipt> {
  await deletePhysicalStorageRows(
    transaction,
    'configurationPresetCatalogRows',
    [presetId],
    previous ? [previous] : [],
  )
  const order =
    previous?.activeKey === 1
      ? await bumpPresetCatalogRevision(transaction, presetId)
      : emptyPresetOrderMutationReceipt(presetId)
  return {
    projection: configurationCatalogProjectionMutationReceipt(
      'configurationPresetCatalogRows',
      presetId,
      previous ? 'delete' : 'none',
    ),
    order,
  }
}

export interface ConfigurationPromptPresetCatalogProjectionRow
  extends ConfigurationPromptPresetCatalogRow {
  readonly lastUsedAt?: number
  readonly nameSortKey: string
}

export function configurationPromptPresetCatalogProjectionRow(
  preset: PromptPreset,
): ConfigurationPromptPresetCatalogProjectionRow {
  return {
    id: preset.id,
    kind: preset.kind,
    name: preset.name,
    createdAt: preset.createdAt,
    ...(preset.lastUsedAt === undefined ? {} : { lastUsedAt: preset.lastUsedAt }),
    nameSortKey: configurationCatalogNameSortKey(preset.name),
  }
}

export async function putConfigurationPromptPresetCatalogProjection(
  transaction: Transaction,
  preset: PromptPreset,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  const next = configurationPromptPresetCatalogProjectionRow(preset)
  const previous = await transaction
    .table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
      'configurationPromptPresetCatalogRows',
    )
    .get(preset.id)
  return applyConfigurationPromptPresetCatalogProjectionRows(transaction, previous, next)
}

export function applyConfigurationPromptPresetCatalogProjectionTransition(
  transaction: Transaction,
  previous: PromptPreset | undefined,
  next: PromptPreset,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  return applyConfigurationPromptPresetCatalogProjectionRows(
    transaction,
    previous ? configurationPromptPresetCatalogProjectionRow(previous) : undefined,
    configurationPromptPresetCatalogProjectionRow(next),
  )
}

async function applyConfigurationPromptPresetCatalogProjectionRows(
  transaction: Transaction,
  previous: ConfigurationPromptPresetCatalogProjectionRow | undefined,
  next: ConfigurationPromptPresetCatalogProjectionRow,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  if (previous && samePromptPresetProjection(previous, next)) {
    return configurationCatalogProjectionMutationReceipt(
      'configurationPromptPresetCatalogRows',
      next.id,
      'none',
    )
  }
  const aggregateIds: string[] = []
  await putPhysicalStorageRow(transaction, 'configurationPromptPresetCatalogRows', next, previous)
  if (!previous) {
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(next.kind),
      1,
    )
    aggregateIds.push(configurationPromptPresetCatalogStateId(next.kind))
  } else if (previous.kind !== next.kind) {
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(previous.kind),
      -1,
    )
    aggregateIds.push(configurationPromptPresetCatalogStateId(previous.kind))
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(next.kind),
      1,
    )
    aggregateIds.push(configurationPromptPresetCatalogStateId(next.kind))
  } else if (!samePromptPresetCatalogViewProjection(previous, next)) {
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(next.kind),
      0,
    )
    aggregateIds.push(configurationPromptPresetCatalogStateId(next.kind))
  }
  return configurationCatalogProjectionMutationReceipt(
    'configurationPromptPresetCatalogRows',
    next.id,
    'write',
    aggregateIds,
  )
}

export async function putConfigurationPromptPresetRecencyCatalogProjection(
  transaction: Transaction,
  preset: PromptPreset,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  const next = configurationPromptPresetCatalogProjectionRow(preset)
  const previous = await transaction
    .table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
      'configurationPromptPresetCatalogRows',
    )
    .get(preset.id)
  if (!previous) throw new Error(`ConfigurationPromptPresetCatalogProjectionMissing:${preset.id}`)
  return applyConfigurationPromptPresetRecencyCatalogProjectionRows(transaction, previous, next)
}

export function applyConfigurationPromptPresetRecencyCatalogProjectionTransition(
  transaction: Transaction,
  previous: PromptPreset,
  next: PromptPreset,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  return applyConfigurationPromptPresetRecencyCatalogProjectionRows(
    transaction,
    configurationPromptPresetCatalogProjectionRow(previous),
    configurationPromptPresetCatalogProjectionRow(next),
  )
}

async function applyConfigurationPromptPresetRecencyCatalogProjectionRows(
  transaction: Transaction,
  previous: ConfigurationPromptPresetCatalogProjectionRow,
  next: ConfigurationPromptPresetCatalogProjectionRow,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  if (!samePromptPresetCatalogViewProjection(previous, next)) {
    throw new Error(`ConfigurationPromptPresetRecencyProjectionChangedCatalog:${next.id}`)
  }
  if (samePromptPresetProjection(previous, next)) {
    return configurationCatalogProjectionMutationReceipt(
      'configurationPromptPresetCatalogRows',
      next.id,
      'none',
    )
  }
  await putPhysicalStorageRow(transaction, 'configurationPromptPresetCatalogRows', next, previous)
  return configurationCatalogProjectionMutationReceipt(
    'configurationPromptPresetCatalogRows',
    next.id,
    'write',
  )
}

export async function deleteConfigurationPromptPresetCatalogProjection(
  transaction: Transaction,
  presetId: PromptPresetId,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  const previous = await transaction
    .table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
      'configurationPromptPresetCatalogRows',
    )
    .get(presetId)
  return deleteConfigurationPromptPresetCatalogProjectionRow(transaction, presetId, previous)
}

export function applyConfigurationPromptPresetCatalogProjectionDeletion(
  transaction: Transaction,
  previous: PromptPreset,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  return deleteConfigurationPromptPresetCatalogProjectionRow(
    transaction,
    previous.id,
    configurationPromptPresetCatalogProjectionRow(previous),
  )
}

async function deleteConfigurationPromptPresetCatalogProjectionRow(
  transaction: Transaction,
  presetId: PromptPresetId,
  previous: ConfigurationPromptPresetCatalogProjectionRow | undefined,
): Promise<ConfigurationCatalogProjectionMutationReceipt> {
  await deletePhysicalStorageRows(
    transaction,
    'configurationPromptPresetCatalogRows',
    [presetId],
    previous ? [previous] : [],
  )
  if (previous) {
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(previous.kind),
      -1,
    )
  }
  return configurationCatalogProjectionMutationReceipt(
    'configurationPromptPresetCatalogRows',
    presetId,
    previous ? 'delete' : 'none',
    previous ? [configurationPromptPresetCatalogStateId(previous.kind)] : [],
  )
}

function sameProfileProjection(
  left: ConfigurationProfileCatalogProjectionRow,
  right: ConfigurationProfileCatalogProjectionRow,
): boolean {
  return (
    left.name === right.name &&
    left.kind === right.kind &&
    left.lastUsedAt === right.lastUsedAt &&
    left.archived === right.archived &&
    left.activeKey === right.activeKey &&
    left.managerTier === right.managerTier &&
    left.mruSortKey === right.mruSortKey &&
    left.nameSortKey === right.nameSortKey
  )
}

function sameProfileManagerProjection(
  left: ConfigurationProfileCatalogProjectionRow,
  right: ConfigurationProfileCatalogProjectionRow,
): boolean {
  return (
    left.name === right.name &&
    left.kind === right.kind &&
    left.archived === right.archived &&
    left.managerTier === right.managerTier &&
    left.nameSortKey === right.nameSortKey
  )
}

function samePresetProjection(
  left: ConfigurationPresetCatalogProjectionRow,
  right: ConfigurationPresetCatalogProjectionRow,
): boolean {
  return (
    left.name === right.name &&
    left.connectionProfileId === right.connectionProfileId &&
    left.createdAt === right.createdAt &&
    left.lastUsedAt === right.lastUsedAt &&
    left.archived === right.archived &&
    left.activeKey === right.activeKey &&
    left.defaultTier === right.defaultTier &&
    left.defaultTime === right.defaultTime
  )
}

function samePresetCatalogViewProjection(
  left: ConfigurationPresetCatalogProjectionRow,
  right: ConfigurationPresetCatalogProjectionRow,
): boolean {
  return (
    left.name === right.name &&
    left.connectionProfileId === right.connectionProfileId &&
    left.createdAt === right.createdAt &&
    left.archived === right.archived &&
    left.activeKey === right.activeKey
  )
}

function samePromptPresetProjection(
  left: ConfigurationPromptPresetCatalogProjectionRow,
  right: ConfigurationPromptPresetCatalogProjectionRow,
): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.createdAt === right.createdAt &&
    left.lastUsedAt === right.lastUsedAt &&
    left.nameSortKey === right.nameSortKey
  )
}

function samePromptPresetCatalogViewProjection(
  left: ConfigurationPromptPresetCatalogProjectionRow,
  right: ConfigurationPromptPresetCatalogProjectionRow,
): boolean {
  return left.kind === right.kind && left.name === right.name && left.createdAt === right.createdAt
}

function configurationCatalogProjectionMutationReceipt(
  projectionTable: ConfigurationCatalogProjectionMutationReceipt['projectionTable'],
  projectionId: string,
  projectionMutation: ConfigurationCatalogProjectionMutationReceipt['projectionMutation'],
  aggregateIds: readonly string[] = [],
): ConfigurationCatalogProjectionMutationReceipt {
  return Object.freeze({
    projectionTable,
    projectionId,
    projectionMutation,
    aggregateIds: Object.freeze([...aggregateIds]),
  })
}

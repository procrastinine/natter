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
import { bumpPresetCatalogRevision } from './preset-order'
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
): Promise<void> {
  const next = configurationProfileCatalogProjectionRow(profile)
  const previous = await transaction
    .table<ConfigurationProfileCatalogProjectionRow, ProfileId>('configurationProfileCatalogRows')
    .get(profile.id)
  if (previous && sameProfileProjection(previous, next)) return
  await putPhysicalStorageRow(transaction, 'configurationProfileCatalogRows', next, previous)
  if (!previous) await updateConfigurationCatalogAggregate(transaction, 1)
  if (!previous || !sameProfileManagerProjection(previous, next)) {
    await updateConfigurationCatalogState(
      transaction,
      CONFIGURATION_PROFILE_MANAGER_STATE_ID,
      previous ? 0 : 1,
    )
  }
  const previousActive = previous?.activeKey === 1
  const nextActive = next.activeKey === 1
  if (previousActive || nextActive) {
    await updateConfigurationCatalogState(
      transaction,
      CONFIGURATION_PROFILE_CATALOG_STATE_ID,
      previousActive === nextActive ? 0 : nextActive ? 1 : -1,
    )
  }
}

export async function deleteConfigurationProfileCatalogProjection(
  transaction: Transaction,
  profileId: ProfileId,
): Promise<void> {
  const previous = await transaction
    .table<ConfigurationProfileCatalogProjectionRow, ProfileId>('configurationProfileCatalogRows')
    .get(profileId)
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
): Promise<void> {
  const next = configurationPresetCatalogProjectionRow(preset)
  const previous = await transaction
    .table<ConfigurationPresetCatalogProjectionRow, PresetId>('configurationPresetCatalogRows')
    .get(preset.id)
  if (previous && samePresetProjection(previous, next)) return
  const catalogChanged = !previous || !samePresetCatalogViewProjection(previous, next)
  await putPhysicalStorageRow(transaction, 'configurationPresetCatalogRows', next, previous)
  if (catalogChanged && (previous?.activeKey === 1 || next.activeKey === 1)) {
    await bumpPresetCatalogRevision(transaction)
  }
}

export async function putConfigurationPresetRecencyCatalogProjection(
  transaction: Transaction,
  preset: ChatPreset,
): Promise<void> {
  const next = configurationPresetCatalogProjectionRow(preset)
  const previous = await transaction
    .table<ConfigurationPresetCatalogProjectionRow, PresetId>('configurationPresetCatalogRows')
    .get(preset.id)
  if (!previous) throw new Error(`ConfigurationPresetCatalogProjectionMissing:${preset.id}`)
  if (!samePresetCatalogViewProjection(previous, next)) {
    throw new Error(`ConfigurationPresetRecencyProjectionChangedCatalog:${preset.id}`)
  }
  if (samePresetProjection(previous, next)) return
  await putPhysicalStorageRow(transaction, 'configurationPresetCatalogRows', next, previous)
}

export async function deleteConfigurationPresetCatalogProjection(
  transaction: Transaction,
  presetId: PresetId,
): Promise<void> {
  const previous = await transaction
    .table<ConfigurationPresetCatalogProjectionRow, PresetId>('configurationPresetCatalogRows')
    .get(presetId)
  await deletePhysicalStorageRows(
    transaction,
    'configurationPresetCatalogRows',
    [presetId],
    previous ? [previous] : [],
  )
  if (previous?.activeKey === 1) {
    await bumpPresetCatalogRevision(transaction)
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
): Promise<void> {
  const next = configurationPromptPresetCatalogProjectionRow(preset)
  const previous = await transaction
    .table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
      'configurationPromptPresetCatalogRows',
    )
    .get(preset.id)
  if (previous && samePromptPresetProjection(previous, next)) return
  await putPhysicalStorageRow(transaction, 'configurationPromptPresetCatalogRows', next, previous)
  if (!previous) {
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(next.kind),
      1,
    )
  } else if (previous.kind !== next.kind) {
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(previous.kind),
      -1,
    )
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(next.kind),
      1,
    )
  } else if (!samePromptPresetCatalogViewProjection(previous, next)) {
    await updateConfigurationCatalogState(
      transaction,
      configurationPromptPresetCatalogStateId(next.kind),
      0,
    )
  }
}

export async function putConfigurationPromptPresetRecencyCatalogProjection(
  transaction: Transaction,
  preset: PromptPreset,
): Promise<void> {
  const next = configurationPromptPresetCatalogProjectionRow(preset)
  const previous = await transaction
    .table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
      'configurationPromptPresetCatalogRows',
    )
    .get(preset.id)
  if (!previous) throw new Error(`ConfigurationPromptPresetCatalogProjectionMissing:${preset.id}`)
  if (!samePromptPresetCatalogViewProjection(previous, next)) {
    throw new Error(`ConfigurationPromptPresetRecencyProjectionChangedCatalog:${preset.id}`)
  }
  if (samePromptPresetProjection(previous, next)) return
  await putPhysicalStorageRow(transaction, 'configurationPromptPresetCatalogRows', next, previous)
}

export async function deleteConfigurationPromptPresetCatalogProjection(
  transaction: Transaction,
  presetId: PromptPresetId,
): Promise<void> {
  const previous = await transaction
    .table<ConfigurationPromptPresetCatalogProjectionRow, PromptPresetId>(
      'configurationPromptPresetCatalogRows',
    )
    .get(presetId)
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

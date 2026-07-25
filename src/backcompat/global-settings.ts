import type Dexie from 'dexie'
import type { Transaction } from 'dexie'
import {
  isCanonicalRecentModelState,
  normalizeRecentModelRecency,
  normalizeRecentModels,
  PINNED_MODELS_KEY,
  RECENT_MODEL_LIMIT,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
  type RecentModelRecencyRecord,
} from '../core/global-settings'
import { LATEST_OPENROUTER_MODEL_IDS } from '../core/latest-models'
import type { SettingsRow } from '../store/db-rows'
import { runOnceBackfill, runOnceBackfillInTransaction } from './run-once'

const GLOBAL_SETTINGS_BACKFILL_KEY = 'backfill:global-settings-v1'
const PINNED_MODEL_DEFAULT_BACKFILL_KEY = 'backfill:pinned-model-default-v2'
const RECENT_MODEL_RECENCY_BACKFILL_KEY = 'backfill:recent-model-recency-v1'
const PREVIOUS_PINNED_MODEL_DEFAULT = Object.freeze([
  'openai/gpt-5.4',
  'anthropic/claude-opus-4.7',
  'deepseek/deepseek-v4-pro',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-flash-lite-preview',
])

const RETIRED_AUTO_SCROLL_OPEN_KEY = 'global:auto-scroll-open'
const AUTO_SCROLL_STREAM_KEY = 'global:auto-scroll-stream'
const LEGACY_AUTO_SCROLL_KEY = 'global:auto-scroll'
const SIDEBAR_SORT_SETTING_KEY = 'sidebar:sort-key'
const LEGACY_SIDEBAR_SORT_MODES: Record<string, string> = {
  'updated-desc': 'updatedAt-desc',
  'updated-asc': 'updatedAt-asc',
}

export function globalSettingsMigrationKeys(): readonly string[] {
  return [
    LEGACY_AUTO_SCROLL_KEY,
    AUTO_SCROLL_STREAM_KEY,
    RETIRED_AUTO_SCROLL_OPEN_KEY,
    SIDEBAR_SORT_SETTING_KEY,
  ]
}

export function globalSettingsBackfillMarker(): SettingsRow {
  return { key: GLOBAL_SETTINGS_BACKFILL_KEY, value: 1 }
}

export function pinnedModelDefaultBackfillMarker(): SettingsRow {
  return { key: PINNED_MODEL_DEFAULT_BACKFILL_KEY, value: 1 }
}

export function recentModelRecencyBackfillMarker(): SettingsRow {
  return { key: RECENT_MODEL_RECENCY_BACKFILL_KEY, value: 1 }
}

export interface GlobalSettingsRowsPatch {
  readonly put: readonly SettingsRow[]
  readonly deleteKeys: readonly string[]
}

export function canonicalizeGlobalSettingsRows(
  rows: readonly SettingsRow[],
): GlobalSettingsRowsPatch {
  const byKey = new Map(rows.map((row) => [row.key, row] as const))
  const put: SettingsRow[] = []
  const legacy = byKey.get(LEGACY_AUTO_SCROLL_KEY)
  if (typeof legacy?.value === 'boolean' && byKey.get(AUTO_SCROLL_STREAM_KEY) === undefined) {
    put.push({ key: AUTO_SCROLL_STREAM_KEY, value: legacy.value })
  }
  const sidebarSort = byKey.get(SIDEBAR_SORT_SETTING_KEY)
  if (typeof sidebarSort?.value === 'string') {
    const migratedSort = LEGACY_SIDEBAR_SORT_MODES[sidebarSort.value]
    if (migratedSort) put.push({ key: SIDEBAR_SORT_SETTING_KEY, value: migratedSort })
  }
  return {
    put,
    deleteKeys: [LEGACY_AUTO_SCROLL_KEY, RETIRED_AUTO_SCROLL_OPEN_KEY],
  }
}

export function canonicalizePinnedModelSettingsRows(
  rows: readonly SettingsRow[],
): readonly SettingsRow[] {
  const current = rows.find((row) => row.key === PINNED_MODELS_KEY)
  return sameStringArray(current?.value, PREVIOUS_PINNED_MODEL_DEFAULT)
    ? [{ key: PINNED_MODELS_KEY, value: [...LATEST_OPENROUTER_MODEL_IDS] }]
    : []
}

export async function migratePinnedModelDefault(tx: Transaction): Promise<void> {
  await runOnceBackfillInTransaction(tx, {
    marker: pinnedModelDefaultBackfillMarker(),
    run: async (transaction) => {
      const settings = transaction.table<SettingsRow, string>('settings')
      const current = await settings.get(PINNED_MODELS_KEY)
      await settings.bulkPut(canonicalizePinnedModelSettingsRows(current ? [current] : []))
    },
  })
}

export async function migrateGlobalSettingsRows(db: Dexie): Promise<void> {
  await runOnceBackfill(db, {
    marker: globalSettingsBackfillMarker(),
    tables: [],
    run: async (tx) => {
      const settings = tx.table<SettingsRow, string>('settings')
      const keys = globalSettingsMigrationKeys()
      const rows = (await settings.bulkGet([...keys])).filter(
        (row): row is SettingsRow => row !== undefined,
      )
      const patch = canonicalizeGlobalSettingsRows(rows)
      await Promise.all([
        settings.bulkPut([...patch.put]),
        settings.bulkDelete([...patch.deleteKeys]),
      ])
    },
  })
}

export async function migrateRecentModelRecencyRows(db: Dexie): Promise<void> {
  await runOnceBackfill(db, {
    marker: recentModelRecencyBackfillMarker(),
    tables: [],
    isCurrent: async (tx) => {
      const settings = tx.table<SettingsRow, string>('settings')
      const [recent, recency] = await Promise.all([
        settings.get(RECENT_MODELS_KEY),
        settings.get(RECENT_MODEL_RECENCY_KEY),
      ])
      return isCanonicalRecentModelState(recent?.value, recency?.value)
    },
    run: async (tx) => {
      const settings = tx.table<SettingsRow, string>('settings')
      const [recent, recency] = await Promise.all([
        settings.get(RECENT_MODELS_KEY),
        settings.get(RECENT_MODEL_RECENCY_KEY),
      ])
      const migrated = migratedRecentModelState(recent?.value, recency?.value)
      await settings.bulkPut([
        { key: RECENT_MODELS_KEY, value: migrated.models },
        { key: RECENT_MODEL_RECENCY_KEY, value: migrated.recency },
      ])
    },
  })
}

export function canonicalizeRecentModelSettingsRows<
  Row extends { readonly key: string; readonly value: unknown },
>(rows: Row[]): Row[] {
  const recent = rows.find((row) => row.key === RECENT_MODELS_KEY)
  const recency = rows.find((row) => row.key === RECENT_MODEL_RECENCY_KEY)
  const marker = recentModelRecencyBackfillMarker()
  const storedMarker = rows.find((row) => row.key === marker.key)
  if (
    storedMarker?.value === marker.value &&
    isCanonicalRecentModelState(recent?.value, recency?.value)
  ) {
    return rows
  }
  const migrated = migratedRecentModelState(recent?.value, recency?.value)
  let next = upsertSettingRow(rows, { key: RECENT_MODELS_KEY, value: migrated.models })
  next = upsertSettingRow(next, { key: RECENT_MODEL_RECENCY_KEY, value: migrated.recency })
  return upsertSettingRow(next, marker)
}

function migratedRecentModelState(
  publicValue: unknown,
  recencyValue: unknown,
): { models: string[]; recency: RecentModelRecencyRecord } {
  const models = normalizeRecentModels(publicValue)
  const normalizedRecency = normalizeRecentModelRecency(recencyValue)
  if (
    normalizedRecency &&
    sameStringArray(
      normalizedRecency.entries.map((entry) => entry.modelId),
      models,
    )
  ) {
    return { models, recency: normalizedRecency }
  }
  return {
    models,
    recency: {
      version: 1,
      entries: models.map((modelId, index) => ({
        modelId,
        usedAt: 0,
        streamId: `legacy:${String(RECENT_MODEL_LIMIT - index).padStart(2, '0')}`,
      })),
    },
  }
}

function upsertSettingRow<Row extends { readonly key: string; readonly value: unknown }>(
  rows: Row[],
  row: { readonly key: string; readonly value: unknown },
): Row[] {
  const index = rows.findIndex((candidate) => candidate.key === row.key)
  if (index === -1) return [...rows, row as Row]
  const next = [...rows]
  next[index] = { ...rows[index], ...row } as Row
  return next
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  )
}

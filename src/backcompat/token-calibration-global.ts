import type Dexie from 'dexie'
import { tokenCalibrationKeyForStoredRecordKey } from '../core/model-ids'
import type { Chat, GlobalTokenCalibration, TokenCalibrationSample } from '../core/types'
import type { SettingsRow } from '../store/db-rows'
import type { MessageHeaderRow } from '../store/message-storage'
import { forEachTableBatch } from './batched-table'
import { runOnceBackfill } from './run-once'

const TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY = 'backfill:token-calibration-global-v1'
const TOKEN_CALIBRATION_CANONICALIZE_BACKFILL_KEY = 'backfill:token-calibration-canonicalize-v1'
export const GLOBAL_TOKEN_CALIBRATION_KEY = 'global:token-calibration'

export function tokenCalibrationGlobalBackfillMarker(): SettingsRow {
  return { key: TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY, value: 1 }
}

export function tokenCalibrationCanonicalizeBackfillMarker(): SettingsRow {
  return { key: TOKEN_CALIBRATION_CANONICALIZE_BACKFILL_KEY, value: 1 }
}

export async function rebuildTokenCalibrationGlobalRows(db: Dexie): Promise<void> {
  await runOnceBackfill(db, {
    marker: tokenCalibrationGlobalBackfillMarker(),
    tables: ['chats'],
    run: async (tx) => {
      const chats = tx.table<Chat, string>('chats')
      const settings = tx.table<SettingsRow, string>('settings')
      const global = createGlobalCalibrationAccumulator()
      await forEachTableBatch(chats, (rows) => appendGlobalCalibrationRows(global, rows))
      await settings.put({ key: GLOBAL_TOKEN_CALIBRATION_KEY, value: global })
    },
  })
}

export async function canonicalizeTokenCalibrationRows(db: Dexie): Promise<void> {
  await runOnceBackfill(db, {
    marker: tokenCalibrationCanonicalizeBackfillMarker(),
    tables: ['chats', 'messages'],
    run: async (tx) => {
      const chats = tx.table<Chat, string>('chats')
      const messages = tx.table<MessageHeaderRow, string>('messages')
      const settings = tx.table<SettingsRow, string>('settings')
      const global = createGlobalCalibrationAccumulator()
      await forEachTableBatch(chats, async (rows) => {
        const changed: Chat[] = []
        const current: Chat[] = []
        for (const chat of rows) {
          const result = canonicalizeTokenCalibrationSamples(chat.tokenCalibration)
          const next = result.changed ? { ...chat, tokenCalibration: result.samples ?? {} } : chat
          current.push(next)
          if (result.changed) changed.push(next)
        }
        appendGlobalCalibrationRows(global, current)
        if (changed.length > 0) await chats.bulkPut(changed)
      })

      await messages.toCollection().modify((message) => {
        const key = message.originalCalibrationKey
        if (typeof key !== 'string' || key.length === 0) return
        const canonical = tokenCalibrationKeyForStoredRecordKey(key)
        if (canonical !== key) message.originalCalibrationKey = canonical
      })

      await settings.put({
        key: GLOBAL_TOKEN_CALIBRATION_KEY,
        value: global,
      })
    },
  })
}

export function canonicalizeTokenCalibrationSamples(
  samples: Record<string, TokenCalibrationSample> | undefined,
): { samples: Record<string, TokenCalibrationSample> | undefined; changed: boolean } {
  if (!samples) return { samples, changed: false }
  const normalized: Record<string, TokenCalibrationSample> = {}
  let changed = false
  for (const [storedKey, rawSample] of Object.entries(samples)) {
    const sample = normalizeStoredSample(rawSample)
    if (!sample) {
      changed = true
      continue
    }
    const calibrationKey = tokenCalibrationKeyForStoredRecordKey(storedKey)
    if (calibrationKey !== storedKey) changed = true
    const target = normalized[calibrationKey]
    if (target) {
      mergeSample(target, sample)
      changed = true
    } else {
      normalized[calibrationKey] = sample
    }
  }
  if (Object.keys(normalized).length !== Object.keys(samples).length) changed = true
  return { samples: normalized, changed }
}

export function rebuildGlobalCalibration(
  chats: readonly Pick<Chat, 'tokenCalibration'>[],
): GlobalTokenCalibration {
  const global = createGlobalCalibrationAccumulator()
  appendGlobalCalibrationRows(global, chats)
  return global
}

export function createGlobalCalibrationAccumulator(): GlobalTokenCalibration {
  return { version: 1, updatedAt: 0, byModel: {} }
}

export function appendGlobalCalibrationRows(
  global: GlobalTokenCalibration,
  chats: readonly Pick<Chat, 'tokenCalibration'>[],
): void {
  for (const chat of chats) {
    appendGlobalCalibrationRow(global, chat)
  }
}

export function appendGlobalCalibrationRow(
  global: GlobalTokenCalibration,
  chat: Pick<Chat, 'tokenCalibration'>,
): void {
  for (const [storedKey, rawSample] of Object.entries(chat.tokenCalibration ?? {})) {
    const sample = normalizeSample(rawSample)
    if (!sample) continue
    const calibrationKey = tokenCalibrationKeyForStoredRecordKey(storedKey)
    let target = global.byModel[calibrationKey]
    if (!target) {
      target = { totalTextChars: 0, totalTextTokens: 0, sampleCount: 0, updatedAt: 0 }
      global.byModel[calibrationKey] = target
    }
    target.totalTextChars += sample.totalTextChars
    target.totalTextTokens += sample.totalTextTokens
    target.sampleCount += sample.sampleCount
    if (sample.updatedAt >= target.updatedAt) {
      target.updatedAt = sample.updatedAt
      if (sample.lastRatio !== undefined) target.lastRatio = sample.lastRatio
      else delete target.lastRatio
    }
    if (sample.updatedAt > global.updatedAt) global.updatedAt = sample.updatedAt
  }
}

function mergeSample(target: TokenCalibrationSample, sample: TokenCalibrationSample): void {
  target.totalTextChars += sample.totalTextChars
  target.totalTextTokens += sample.totalTextTokens
  target.sampleCount += sample.sampleCount
  if (sample.updatedAt >= target.updatedAt) {
    target.updatedAt = sample.updatedAt
    if (sample.lastRatio !== undefined) target.lastRatio = sample.lastRatio
    else delete target.lastRatio
  }
}

function normalizeStoredSample(
  sample: TokenCalibrationSample | undefined,
): TokenCalibrationSample | null {
  if (!sample || typeof sample !== 'object') return null
  const normalized: TokenCalibrationSample = {
    totalTextChars: finiteNumber(sample.totalTextChars),
    totalTextTokens: finiteNumber(sample.totalTextTokens),
    sampleCount: finiteNumber(sample.sampleCount),
    updatedAt: finiteNumber(sample.updatedAt),
  }
  const lastRatio = finiteNumber(sample.lastRatio)
  if (lastRatio > 0) normalized.lastRatio = lastRatio
  return normalized
}

function normalizeSample(
  sample: TokenCalibrationSample | undefined,
): TokenCalibrationSample | null {
  if (!sample || typeof sample !== 'object') return null
  const totalTextChars = finiteNumber(sample.totalTextChars)
  const totalTextTokens = finiteNumber(sample.totalTextTokens)
  const sampleCount = finiteNumber(sample.sampleCount)
  if (totalTextChars <= 0 || totalTextTokens <= 0 || sampleCount <= 0) return null
  const normalized: TokenCalibrationSample = {
    totalTextChars,
    totalTextTokens,
    sampleCount,
    updatedAt: finiteNumber(sample.updatedAt),
  }
  const lastRatio = finiteNumber(sample.lastRatio)
  if (lastRatio > 0) normalized.lastRatio = lastRatio
  return normalized
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

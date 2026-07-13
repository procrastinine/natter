import type Dexie from 'dexie'
import { tokenCalibrationKeyForStoredRecordKey } from '../core/model-ids'
import type { Chat, GlobalTokenCalibration, TokenCalibrationSample } from '../core/types'
import type { SettingsRow } from '../store/db-rows'
import type { MessageHeaderRow } from '../store/message-storage'
import { forEachTableBatch } from './batched-table'

const TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY = 'backfill:token-calibration-global-v1'
const TOKEN_CALIBRATION_CANONICALIZE_BACKFILL_KEY = 'backfill:token-calibration-canonicalize-v1'
const GLOBAL_TOKEN_CALIBRATION_KEY = 'global:token-calibration'

export function tokenCalibrationGlobalBackfillMarker(): SettingsRow {
  return { key: TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY, value: 1 }
}

export function tokenCalibrationCanonicalizeBackfillMarker(): SettingsRow {
  return { key: TOKEN_CALIBRATION_CANONICALIZE_BACKFILL_KEY, value: 1 }
}

export async function rebuildTokenCalibrationGlobalRows(db: Dexie): Promise<void> {
  const chats = db.table<Chat, string>('chats')
  const settings = db.table<SettingsRow, string>('settings')
  const marker = await settings.get(TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', chats, settings, async () => {
    const global = emptyGlobalCalibration()
    await forEachTableBatch(chats, (rows) => appendGlobalCalibration(global, rows))
    await settings.put({ key: GLOBAL_TOKEN_CALIBRATION_KEY, value: global })
    await settings.put(tokenCalibrationGlobalBackfillMarker())
  })
}

export async function canonicalizeTokenCalibrationRows(db: Dexie): Promise<void> {
  const chats = db.table<Chat, string>('chats')
  const messages = db.table<MessageHeaderRow, string>('messages')
  const settings = db.table<SettingsRow, string>('settings')
  const marker = await settings.get(TOKEN_CALIBRATION_CANONICALIZE_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', chats, messages, settings, async () => {
    const global = emptyGlobalCalibration()
    await forEachTableBatch(chats, async (rows) => {
      const changed: Chat[] = []
      const current: Chat[] = []
      for (const chat of rows) {
        const result = canonicalizeTokenCalibrationSamples(chat.tokenCalibration)
        const next = result.changed ? { ...chat, tokenCalibration: result.samples ?? {} } : chat
        current.push(next)
        if (result.changed) changed.push(next)
      }
      appendGlobalCalibration(global, current)
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
    await settings.put(tokenCalibrationCanonicalizeBackfillMarker())
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
  const global = emptyGlobalCalibration()
  appendGlobalCalibration(global, chats)
  return global
}

function emptyGlobalCalibration(): GlobalTokenCalibration {
  return { version: 1, updatedAt: 0, byModel: {} }
}

function appendGlobalCalibration(
  global: GlobalTokenCalibration,
  chats: readonly Pick<Chat, 'tokenCalibration'>[],
): void {
  for (const chat of chats) {
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

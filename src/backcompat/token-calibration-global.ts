import { tokenCalibrationKeyForStoredRecordKey } from '../core/model-ids'
import type { Chat, GlobalTokenCalibration, TokenCalibrationSample } from '../core/types'
import type { NatterDb, SettingsRow } from '../store/db'
import type { MessageHeaderRow } from '../store/message-storage'

const TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY = 'backfill:token-calibration-global-v1'
const TOKEN_CALIBRATION_CANONICALIZE_BACKFILL_KEY = 'backfill:token-calibration-canonicalize-v1'
const GLOBAL_TOKEN_CALIBRATION_KEY = 'global:token-calibration'

export function tokenCalibrationGlobalBackfillMarker(): SettingsRow {
  return { key: TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY, value: 1 }
}

export function tokenCalibrationCanonicalizeBackfillMarker(): SettingsRow {
  return { key: TOKEN_CALIBRATION_CANONICALIZE_BACKFILL_KEY, value: 1 }
}

export async function rebuildTokenCalibrationGlobalRows(db: NatterDb): Promise<void> {
  const marker = await db.settings.get(TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', db.chats, db.settings, async () => {
    const chats = await db.chats.toArray()
    const global = rebuildGlobalCalibration(chats)
    await db.settings.put({ key: GLOBAL_TOKEN_CALIBRATION_KEY, value: global })
    await db.settings.put(tokenCalibrationGlobalBackfillMarker())
  })
}

export async function canonicalizeTokenCalibrationRows(db: NatterDb): Promise<void> {
  const marker = await db.settings.get(TOKEN_CALIBRATION_CANONICALIZE_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', db.chats, db.messages, db.settings, async () => {
    const chats = await db.chats.toArray()
    const nextChats: Chat[] = []
    for (const chat of chats) {
      const result = canonicalizeTokenCalibrationSamples(chat.tokenCalibration)
      if (!result.changed) continue
      nextChats.push({ ...chat, tokenCalibration: result.samples ?? {} })
    }
    if (nextChats.length > 0) await db.chats.bulkPut(nextChats)

    await db.messages.toCollection().modify((message: MessageHeaderRow) => {
      const key = message.originalCalibrationKey
      if (typeof key !== 'string' || key.length === 0) return
      const canonical = tokenCalibrationKeyForStoredRecordKey(key)
      if (canonical !== key) message.originalCalibrationKey = canonical
    })

    const currentChats = nextChats.length > 0 ? await db.chats.toArray() : chats
    await db.settings.put({
      key: GLOBAL_TOKEN_CALIBRATION_KEY,
      value: rebuildGlobalCalibration(currentChats),
    })
    await db.settings.put(tokenCalibrationCanonicalizeBackfillMarker())
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
  const byModel: Record<string, TokenCalibrationSample> = {}
  let updatedAt = 0
  for (const chat of chats) {
    for (const [storedKey, rawSample] of Object.entries(chat.tokenCalibration ?? {})) {
      const sample = normalizeSample(rawSample)
      if (!sample) continue
      const calibrationKey = tokenCalibrationKeyForStoredRecordKey(storedKey)
      let target = byModel[calibrationKey]
      if (!target) {
        target = { totalTextChars: 0, totalTextTokens: 0, sampleCount: 0, updatedAt: 0 }
        byModel[calibrationKey] = target
      }
      target.totalTextChars += sample.totalTextChars
      target.totalTextTokens += sample.totalTextTokens
      target.sampleCount += sample.sampleCount
      if (sample.updatedAt >= target.updatedAt) {
        target.updatedAt = sample.updatedAt
        if (sample.lastRatio !== undefined) target.lastRatio = sample.lastRatio
        else delete target.lastRatio
      }
      if (sample.updatedAt > updatedAt) updatedAt = sample.updatedAt
    }
  }
  return { version: 1, updatedAt, byModel }
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

import { tokenCalibrationKeyForStoredRecordKey } from '../core/model-ids'
import type { Chat, GlobalTokenCalibration, TokenCalibrationSample } from '../core/types'
import type { NatterDb, SettingsRow } from '../store/db'

export const TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY = 'backfill:token-calibration-global-v1'
const GLOBAL_TOKEN_CALIBRATION_KEY = 'global:token-calibration'

export function tokenCalibrationGlobalBackfillMarker(): SettingsRow {
  return { key: TOKEN_CALIBRATION_GLOBAL_BACKFILL_KEY, value: 1 }
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

import Dexie from 'dexie'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeRecentModelSettingsRows,
  migrateRecentModelRecencyRows,
  recentModelRecencyBackfillMarker,
} from '../../src/backcompat/global-settings'
import {
  advanceRecentModelState,
  emptyRecentModelRecency,
  isCanonicalRecentModelState,
  RECENT_MODEL_RECENCY_KEY,
  RECENT_MODELS_KEY,
} from '../../src/core/global-settings'

const names: string[] = []

afterEach(async () => {
  await Promise.all(names.splice(0).map((name) => Dexie.delete(name)))
})

describe('recent model state', () => {
  it('advances only canonical bounded state and never reconstructs a missing ordering record', () => {
    const empty = emptyRecentModelRecency()
    expect(isCanonicalRecentModelState([], empty)).toBe(true)

    const first = advanceRecentModelState(
      [],
      empty,
      { modelId: 'model-a', usedAt: 10, streamId: 'stream-a' },
      20,
    )
    const second = advanceRecentModelState(
      first.models,
      first.recency,
      { modelId: 'model-b', usedAt: 20, streamId: 'stream-b' },
      1,
    )

    expect(second).toEqual({
      changed: true,
      models: ['model-b'],
      recency: {
        version: 1,
        entries: [{ modelId: 'model-b', usedAt: 20, streamId: 'stream-b' }],
      },
    })
    expect(() =>
      advanceRecentModelState(
        ['legacy-only'],
        undefined,
        { modelId: 'model-a', usedAt: 10, streamId: 'stream-a' },
        20,
      ),
    ).toThrow('RecentModelStateInvariant')
  })

  it('canonicalizes legacy interchange rows once and preserves current rows by identity', () => {
    const legacy = [{ key: RECENT_MODELS_KEY, value: ['model-b', 'model-a'] }]

    const migrated = canonicalizeRecentModelSettingsRows(legacy)

    expect(migrated).toEqual([
      legacy[0],
      {
        key: RECENT_MODEL_RECENCY_KEY,
        value: {
          version: 1,
          entries: [
            { modelId: 'model-b', usedAt: 0, streamId: 'legacy:20' },
            { modelId: 'model-a', usedAt: 0, streamId: 'legacy:19' },
          ],
        },
      },
      recentModelRecencyBackfillMarker(),
    ])
    expect(canonicalizeRecentModelSettingsRows(migrated)).toBe(migrated)
  })

  it('repairs a marked legacy database at the run-once boundary and then preserves recency', async () => {
    const name = `recent-model-state-${Math.random().toString(36).slice(2)}`
    names.push(name)
    const db = new Dexie(name)
    db.version(1).stores({ settings: 'key' })
    await db.open()
    const settings = db.table<{ key: string; value: unknown }, string>('settings')
    await settings.bulkPut([
      { key: RECENT_MODELS_KEY, value: ['model-b', 'model-a'] },
      recentModelRecencyBackfillMarker(),
    ])

    await migrateRecentModelRecencyRows(db)

    expect((await settings.get(RECENT_MODEL_RECENCY_KEY))?.value).toEqual({
      version: 1,
      entries: [
        { modelId: 'model-b', usedAt: 0, streamId: 'legacy:20' },
        { modelId: 'model-a', usedAt: 0, streamId: 'legacy:19' },
      ],
    })
    const currentRecency = {
      version: 1,
      entries: [
        { modelId: 'model-b', usedAt: 20, streamId: 'stream-b' },
        { modelId: 'model-a', usedAt: 10, streamId: 'stream-a' },
      ],
    }
    await settings.put({ key: RECENT_MODEL_RECENCY_KEY, value: currentRecency })

    await migrateRecentModelRecencyRows(db)

    expect((await settings.get(RECENT_MODEL_RECENCY_KEY))?.value).toEqual(currentRecency)
    db.close()
  })
})

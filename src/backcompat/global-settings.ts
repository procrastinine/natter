import type { NatterDb, SettingsRow } from '../store/db'

export const GLOBAL_SETTINGS_BACKFILL_KEY = 'backfill:global-settings-v1'

const RETIRED_AUTO_SCROLL_OPEN_KEY = 'global:auto-scroll-open'
const AUTO_SCROLL_STREAM_KEY = 'global:auto-scroll-stream'
const LEGACY_AUTO_SCROLL_KEY = 'global:auto-scroll'
const SIDEBAR_SORT_SETTING_KEY = 'sidebar:sort-key'
const LEGACY_SIDEBAR_SORT_MODES: Record<string, string> = {
  'updated-desc': 'updatedAt-desc',
  'updated-asc': 'updatedAt-asc',
}

export function globalSettingsBackfillMarker(): SettingsRow {
  return { key: GLOBAL_SETTINGS_BACKFILL_KEY, value: 1 }
}

export async function migrateGlobalSettingsRows(db: NatterDb): Promise<void> {
  const marker = await db.settings.get(GLOBAL_SETTINGS_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', db.settings, async () => {
    const legacy = await db.settings.get(LEGACY_AUTO_SCROLL_KEY)
    const stream = await db.settings.get(AUTO_SCROLL_STREAM_KEY)
    const sidebarSort = await db.settings.get(SIDEBAR_SORT_SETTING_KEY)
    if (typeof legacy?.value === 'boolean') {
      if (!stream) await db.settings.put({ key: AUTO_SCROLL_STREAM_KEY, value: legacy.value })
      await db.settings.delete(LEGACY_AUTO_SCROLL_KEY)
    }
    await db.settings.delete(RETIRED_AUTO_SCROLL_OPEN_KEY)
    if (typeof sidebarSort?.value === 'string') {
      const migratedSort = LEGACY_SIDEBAR_SORT_MODES[sidebarSort.value]
      if (migratedSort)
        await db.settings.put({ key: SIDEBAR_SORT_SETTING_KEY, value: migratedSort })
    }
    await db.settings.put(globalSettingsBackfillMarker())
  })
}

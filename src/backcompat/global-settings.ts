import type Dexie from 'dexie'
import type { SettingsRow } from '../store/db-rows'

const GLOBAL_SETTINGS_BACKFILL_KEY = 'backfill:global-settings-v1'

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

export async function migrateGlobalSettingsRows(db: Dexie): Promise<void> {
  const settings = db.table<SettingsRow, string>('settings')
  const marker = await settings.get(GLOBAL_SETTINGS_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', settings, async () => {
    const legacy = await settings.get(LEGACY_AUTO_SCROLL_KEY)
    const stream = await settings.get(AUTO_SCROLL_STREAM_KEY)
    const sidebarSort = await settings.get(SIDEBAR_SORT_SETTING_KEY)
    if (typeof legacy?.value === 'boolean') {
      if (!stream) await settings.put({ key: AUTO_SCROLL_STREAM_KEY, value: legacy.value })
      await settings.delete(LEGACY_AUTO_SCROLL_KEY)
    }
    await settings.delete(RETIRED_AUTO_SCROLL_OPEN_KEY)
    if (typeof sidebarSort?.value === 'string') {
      const migratedSort = LEGACY_SIDEBAR_SORT_MODES[sidebarSort.value]
      if (migratedSort) await settings.put({ key: SIDEBAR_SORT_SETTING_KEY, value: migratedSort })
    }
    await settings.put(globalSettingsBackfillMarker())
  })
}

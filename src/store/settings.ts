// Simple key-value settings bag. See `plan/03-storage.md §3.1` (`settings` table).
//
// Used for app-wide preferences that aren't worth a dedicated table: theme
// preference, "don't show this again" dismissals, the onboarding state, etc.
// Every write broadcasts `settings-mutated { key }` so other tabs can reload.

import { postEvent } from './broadcast'
import { getDb } from './db'
import { withNamedLock } from './locks'

function stableStringify(value: unknown): string {
  return JSON.stringify(value)
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

export async function getSetting<T>(key: string): Promise<T | undefined> {
  const row = await getDb().settings.get(key)
  return row?.value as T | undefined
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await getDb().settings.put({ key, value })
  postEvent({ kind: 'settings-mutated', key })
}

export async function deleteSetting(key: string): Promise<void> {
  await getDb().settings.delete(key)
  postEvent({ kind: 'settings-mutated', key })
}

export async function updateSetting<T>(
  key: string,
  updater: (current: T | undefined) => T | undefined | Promise<T | undefined>,
): Promise<T | undefined> {
  return withNamedLock(`setting:${key}`, async () => {
    const db = getDb()
    let changed = false
    const next = await db.transaction('rw', db.settings, async () => {
      const current = (await db.settings.get(key))?.value as T | undefined
      const updated = await updater(current)
      if (updated === undefined) {
        if (current === undefined) return undefined
        await db.settings.delete(key)
        changed = true
        return undefined
      }
      if (current !== undefined && valuesEqual(current, updated)) return updated
      await db.settings.put({ key, value: updated })
      changed = true
      return updated
    })
    if (changed) postEvent({ kind: 'settings-mutated', key })
    return next
  })
}

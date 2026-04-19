// Simple key-value settings bag. See `plan/03-storage.md §3.1` (`settings` table).
//
// Used for app-wide preferences that aren't worth a dedicated table: theme
// preference, "don't show this again" dismissals, the onboarding state, etc.
// Every write broadcasts `settings-mutated { key }` so other tabs can reload.

import { postEvent } from './broadcast'
import { getDb } from './db'

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

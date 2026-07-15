// Used for app-wide preferences that aren't worth a dedicated table: theme
// preference, "don't show this again" dismissals, the onboarding state, etc.
// Every write broadcasts `settings-mutated { key }` so other tabs can reload.

import { postEvent } from './broadcast'
import { getDb } from './db'
import { withNamedLock } from './locks'
import { bumpBrowserWorkspaceMeta, readBrowserWorkspaceMetaFromTransaction } from './workspace-meta'

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

export function getSettings(keys: readonly string[]): Promise<ReadonlyMap<string, unknown>> {
  return getDb()
    .settings.bulkGet([...keys])
    .then(
      (rows) =>
        new Map(rows.flatMap((row) => (row === undefined ? [] : [[row.key, row.value] as const]))),
    )
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = getDb()
  await withNamedLock(`setting:${key}`, (grant) =>
    grant.runTransaction(db, [db.settings], async (tx) => {
      await tx.table('settings').put({ key, value })
      await bumpBrowserWorkspaceMeta(tx, Date.now())
    }),
  )
  postEvent({ kind: 'settings-mutated', key })
}

export async function deleteSetting(key: string): Promise<void> {
  const db = getDb()
  await withNamedLock(`setting:${key}`, (grant) =>
    grant.runTransaction(db, [db.settings], async (tx) => {
      await tx.table('settings').delete(key)
      await bumpBrowserWorkspaceMeta(tx, Date.now())
    }),
  )
  postEvent({ kind: 'settings-mutated', key })
}

export async function updateSetting<T>(
  key: string,
  updater: (current: T | undefined) => T | undefined | Promise<T | undefined>,
  options: { expectedReplacementEpoch?: number } = {},
): Promise<T | undefined> {
  return withNamedLock(`setting:${key}`, async (grant) => {
    const db = getDb()
    const result = { changed: false }
    const next = await grant.runTransaction(db, [db.settings], async (tx) => {
      const settings = tx.table<{ key: string; value: unknown }, string>('settings')
      const current = (await settings.get(key))?.value as T | undefined
      if (options.expectedReplacementEpoch !== undefined) {
        const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
        if (meta.replacementEpoch !== options.expectedReplacementEpoch) return current
      }
      const updated = await updater(current)
      if (updated === undefined) {
        if (current === undefined) return undefined
        await settings.delete(key)
        result.changed = true
        await bumpBrowserWorkspaceMeta(tx, Date.now())
        return undefined
      }
      if (current !== undefined && valuesEqual(current, updated)) return updated
      await settings.put({ key, value: updated })
      result.changed = true
      await bumpBrowserWorkspaceMeta(tx, Date.now())
      return updated
    })
    if (result.changed) postEvent({ kind: 'settings-mutated', key })
    return next
  })
}

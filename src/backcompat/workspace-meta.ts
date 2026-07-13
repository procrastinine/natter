import type { Transaction } from 'dexie'

const WORKSPACE_META_KEY = 'workspace-meta'

interface SettingsValueRow {
  key: string
  value: unknown
}

export async function migrateWorkspaceReplacementEpoch(tx: Transaction): Promise<void> {
  const settings = tx.table<SettingsValueRow, string>('settings')
  const row = await settings.get(WORKSPACE_META_KEY)
  if (!row?.value || typeof row.value !== 'object') return
  const value = row.value as Record<string, unknown>
  if (value.replacementEpoch !== undefined) return
  await settings.put({ key: WORKSPACE_META_KEY, value: { ...value, replacementEpoch: 0 } })
}

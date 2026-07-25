import type { Transaction } from 'dexie'

const WORKSPACE_META_KEY = 'workspace-meta'

interface SettingsValueRow {
  key: string
  value: unknown
}

const LEGACY_BROWSER_WORKSPACE_META = Object.freeze({
  workspaceId: 'browser-idb:natter',
  backendKind: 'browser-idb',
  lastMutationAt: 0,
  mutationCounter: 0,
  replacementEpoch: 0,
})

export async function migrateWorkspaceReplacementEpoch(tx: Transaction): Promise<void> {
  const settings = tx.table<SettingsValueRow, string>('settings')
  const row = await settings.get(WORKSPACE_META_KEY)
  if (!row?.value || typeof row.value !== 'object') {
    await settings.put({ key: WORKSPACE_META_KEY, value: LEGACY_BROWSER_WORKSPACE_META })
    return
  }
  const value = row.value as Record<string, unknown>
  if (
    typeof value.workspaceId !== 'string' ||
    value.workspaceId.length === 0 ||
    value.backendKind !== 'browser-idb'
  ) {
    await settings.put({ key: WORKSPACE_META_KEY, value: LEGACY_BROWSER_WORKSPACE_META })
    return
  }
  if (Number.isSafeInteger(value.replacementEpoch) && (value.replacementEpoch as number) >= 0) {
    return
  }
  await settings.put({ key: WORKSPACE_META_KEY, value: { ...value, replacementEpoch: 0 } })
}

export async function readLegacyBrowserWorkspaceMetaFromTransaction(
  tx: Transaction,
): Promise<{ workspaceId: string; replacementEpoch: number }> {
  const value = (await tx.table<SettingsValueRow, string>('settings').get(WORKSPACE_META_KEY))
    ?.value
  if (!value || typeof value !== 'object') {
    return {
      workspaceId: LEGACY_BROWSER_WORKSPACE_META.workspaceId,
      replacementEpoch: 0,
    }
  }
  const stored = value as Record<string, unknown>
  return {
    workspaceId:
      typeof stored.workspaceId === 'string' && stored.workspaceId.length > 0
        ? stored.workspaceId
        : LEGACY_BROWSER_WORKSPACE_META.workspaceId,
    replacementEpoch:
      Number.isSafeInteger(stored.replacementEpoch) && (stored.replacementEpoch as number) >= 0
        ? (stored.replacementEpoch as number)
        : 0,
  }
}

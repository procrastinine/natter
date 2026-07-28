import { readExistingIndexedDb } from './browser-workspace-database-control'
import {
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY,
  isBrowserWorkspaceCurrentCompletionValueV97,
  WAVE_B_STORAGE_VERSION,
} from './browser-workspace-schema-v97'
import type { SettingsRow } from './db-rows'

const CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION = WAVE_B_STORAGE_VERSION * 10

export type BrowserWorkspaceCurrentProbe =
  | { readonly kind: 'absent' }
  | { readonly kind: 'current'; readonly physicalVersion: number }
  | { readonly kind: 'repair-required'; readonly physicalVersion: number }
  | { readonly kind: 'future'; readonly physicalVersion: number }

export async function probeBrowserWorkspaceCurrent(
  databaseName: string,
): Promise<BrowserWorkspaceCurrentProbe> {
  const inspected = await readExistingIndexedDb<{
    readonly physicalVersion: number
    readonly completionValue?: unknown
  }>(databaseName, (database) => {
    const physicalVersion = database.version
    if (!database.objectStoreNames.contains('settings')) {
      return { kind: 'value', value: { physicalVersion } }
    }
    return {
      kind: 'transaction',
      storeNames: ['settings'],
      read: (transaction) =>
        new Promise<{ readonly physicalVersion: number; readonly completionValue?: unknown }>(
          (resolve, reject) => {
            const request = transaction
              .objectStore('settings')
              .get(BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY)
            request.onsuccess = () => {
              const row: unknown = request.result
              resolve({
                physicalVersion,
                ...(isSettingsRow(row) ? { completionValue: row.value } : {}),
              })
            }
            request.onerror = () =>
              reject(request.error ?? new Error('BrowserWorkspaceCurrentCompletionProbeFailed'))
          },
        ),
    }
  })
  if (!inspected) return { kind: 'absent' }
  if (inspected.physicalVersion > CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION) {
    return { kind: 'future', physicalVersion: inspected.physicalVersion }
  }
  if (
    inspected.physicalVersion === CURRENT_BROWSER_WORKSPACE_NATIVE_VERSION &&
    isBrowserWorkspaceCurrentCompletionValueV97(inspected.completionValue)
  ) {
    return { kind: 'current', physicalVersion: inspected.physicalVersion }
  }
  return { kind: 'repair-required', physicalVersion: inspected.physicalVersion }
}

function isSettingsRow(value: unknown): value is SettingsRow {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { readonly key?: unknown }).key === BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY
  )
}

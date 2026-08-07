import { readExistingIndexedDb } from './browser-workspace-database-control'
import {
  BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES,
  CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH,
  registeredBrowserWorkspaceUpgradeStrategyFrom,
} from './browser-workspace-upgrade-strategy'
import type { SettingsRow } from './db-rows'

export type BrowserWorkspaceCurrentProbe =
  | { readonly kind: 'absent' }
  | { readonly kind: 'current'; readonly physicalVersion: number }
  | {
      readonly kind: 'upgrade-required'
      readonly physicalVersion: number
      readonly strategyId: string
      readonly strategy: 'registered-in-place'
    }
  | { readonly kind: 'repair-required'; readonly physicalVersion: number }
  | { readonly kind: 'strategy-missing'; readonly physicalVersion: number }
  | { readonly kind: 'future'; readonly physicalVersion: number }

export async function probeBrowserWorkspaceCurrent(
  databaseName: string,
): Promise<BrowserWorkspaceCurrentProbe> {
  const inspected = await readExistingIndexedDb<{
    readonly physicalVersion: number
    readonly completionValues: Readonly<Record<string, unknown>>
  }>(databaseName, (database) => {
    const physicalVersion = database.version
    if (!database.objectStoreNames.contains('settings')) {
      return { kind: 'value', value: { physicalVersion, completionValues: {} } }
    }
    return {
      kind: 'transaction',
      storeNames: ['settings'],
      read: async (transaction) => {
        const store = transaction.objectStore('settings')
        const sourceStrategy = registeredBrowserWorkspaceUpgradeStrategyFrom(physicalVersion)
        const currentKey = CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.completionKey
        const sourceKey = sourceStrategy?.sourceCompletionKey
        const currentRequest = requestValue(store.get(currentKey))
        const sourceRequest =
          sourceKey !== undefined && sourceKey !== currentKey
            ? requestValue(store.get(sourceKey))
            : undefined
        const currentRow = await currentRequest
        const sourceRow = await sourceRequest
        const completionValues: Record<string, unknown> = {}
        if (isSettingsRow(currentRow, currentKey)) completionValues[currentKey] = currentRow.value
        if (sourceKey !== undefined && isSettingsRow(sourceRow, sourceKey)) {
          completionValues[sourceKey] = sourceRow.value
        }
        return {
          physicalVersion,
          completionValues,
        }
      },
    }
  })
  if (!inspected) return { kind: 'absent' }
  if (inspected.physicalVersion > CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.physicalVersion) {
    return { kind: 'future', physicalVersion: inspected.physicalVersion }
  }
  if (
    inspected.physicalVersion === CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.physicalVersion &&
    CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.completionIsValid(
      inspected.completionValues[CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.completionKey],
    )
  ) {
    return { kind: 'current', physicalVersion: inspected.physicalVersion }
  }
  const registered = registeredBrowserWorkspaceUpgradeStrategyFrom(inspected.physicalVersion)
  if (registered) {
    if (
      registered.sourceCompletionIsValid(inspected.completionValues[registered.sourceCompletionKey])
    ) {
      return {
        kind: 'upgrade-required',
        physicalVersion: inspected.physicalVersion,
        strategyId: registered.id,
        strategy: registered.strategy,
      }
    }
    return { kind: 'repair-required', physicalVersion: inspected.physicalVersion }
  }
  const earliestRegisteredSource = BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES.at(0)
  if (
    earliestRegisteredSource &&
    inspected.physicalVersion > earliestRegisteredSource.sourcePhysicalVersion &&
    inspected.physicalVersion < CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.physicalVersion
  ) {
    return { kind: 'strategy-missing', physicalVersion: inspected.physicalVersion }
  }
  return { kind: 'repair-required', physicalVersion: inspected.physicalVersion }
}

function requestValue(request: IDBRequest<unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () =>
      reject(request.error ?? new Error('BrowserWorkspaceCompletionProbeFailed'))
  })
}

function isSettingsRow(value: unknown, key: string): value is SettingsRow {
  return (
    value !== null && typeof value === 'object' && (value as { readonly key?: unknown }).key === key
  )
}

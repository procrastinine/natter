import {
  isBrowserWorkspaceCurrentCompletionValueV97,
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY as V97_COMPLETION_KEY,
  WAVE_B_STORAGE_VERSION,
  WAVE_B_V97_STORES,
} from './browser-workspace-schema-v97'
import {
  isBrowserWorkspaceCurrentCompletionValueV98,
  BROWSER_WORKSPACE_CURRENT_COMPLETION_KEY as V98_COMPLETION_KEY,
  WAVE_C_STORAGE_VERSION,
  WAVE_C_V98_STORES,
} from './browser-workspace-schema-v98'

export interface BrowserWorkspaceRegisteredUpgradeStrategy {
  readonly id: string
  readonly sourceStorageVersion: number
  readonly sourcePhysicalVersion: number
  readonly sourceCompletionKey: string
  readonly sourceCompletionIsValid: (value: unknown) => boolean
  readonly targetStorageVersion: number
  readonly targetCompletionKey: string
  readonly targetCompletionIsValid: (value: unknown) => boolean
  readonly strategy: 'registered-in-place'
  readonly sourceStores: Readonly<Record<string, string | null>>
  readonly targetStores: Readonly<Record<string, string | null>>
  readonly schemaTouchedStores: readonly string[]
  readonly dataReadStores: readonly string[]
  readonly progressOwner: string
  readonly implementationId: string
}

export const BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'v97-to-v98',
    sourceStorageVersion: WAVE_B_STORAGE_VERSION,
    sourcePhysicalVersion: WAVE_B_STORAGE_VERSION * 10,
    sourceCompletionKey: V97_COMPLETION_KEY,
    sourceCompletionIsValid: isBrowserWorkspaceCurrentCompletionValueV97,
    targetStorageVersion: WAVE_C_STORAGE_VERSION,
    targetCompletionKey: V98_COMPLETION_KEY,
    targetCompletionIsValid: isBrowserWorkspaceCurrentCompletionValueV98,
    strategy: 'registered-in-place',
    sourceStores: WAVE_B_V97_STORES,
    targetStores: WAVE_C_V98_STORES,
    schemaTouchedStores: Object.freeze(['chatSidebarAggregates', 'presets']),
    dataReadStores: Object.freeze(['chatSidebarAggregates', 'folders', 'settings']),
    progressOwner: 'sidebar-folder-presentation-v98',
    implementationId: 'sidebar-folder-presentation-v98',
  } satisfies BrowserWorkspaceRegisteredUpgradeStrategy),
])

export const CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH = Object.freeze({
  storageVersion: WAVE_C_STORAGE_VERSION,
  physicalVersion: WAVE_C_STORAGE_VERSION * 10,
  completionKey: V98_COMPLETION_KEY,
  completionIsValid: isBrowserWorkspaceCurrentCompletionValueV98,
})

validateRegisteredUpgradeStrategies()

export function registeredBrowserWorkspaceUpgradeStrategyFrom(
  physicalVersion: number,
): BrowserWorkspaceRegisteredUpgradeStrategy | undefined {
  return BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES.find(
    (strategy) => strategy.sourcePhysicalVersion === physicalVersion,
  )
}

export function registeredBrowserWorkspaceUpgradeRouteFrom(
  physicalVersion: number,
): readonly BrowserWorkspaceRegisteredUpgradeStrategy[] {
  const first = BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES.findIndex(
    (strategy) => strategy.sourcePhysicalVersion === physicalVersion,
  )
  if (first < 0) throw new Error(`BrowserWorkspaceUpgradeStrategyMissing:${physicalVersion}`)
  const route = BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES.slice(first)
  const terminal = route.at(-1)
  if (
    !terminal ||
    terminal.targetStorageVersion !== CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.storageVersion
  ) {
    throw new Error(`BrowserWorkspaceUpgradeStrategyRouteIncomplete:${physicalVersion}`)
  }
  return route
}

export function validateRegisteredUpgradeStrategies(): void {
  const ids = new Set<string>()
  for (let index = 0; index < BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES.length; index += 1) {
    const strategy = BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES[index]
    if (!strategy) throw new Error(`BrowserWorkspaceUpgradeStrategyMissing:${index}`)
    if (ids.has(strategy.id)) {
      throw new Error(`BrowserWorkspaceUpgradeStrategyDuplicate:${strategy.id}`)
    }
    ids.add(strategy.id)
    if (
      strategy.sourcePhysicalVersion !== strategy.sourceStorageVersion * 10 ||
      strategy.targetStorageVersion <= strategy.sourceStorageVersion
    ) {
      throw new Error(`BrowserWorkspaceUpgradeStrategyVersionInvalid:${strategy.id}`)
    }
    const sourceStores: Readonly<Record<string, string | null>> = strategy.sourceStores
    const targetStores: Readonly<Record<string, string | null>> = strategy.targetStores
    const actualSchemaTouchedStores = [
      ...new Set([...Object.keys(sourceStores), ...Object.keys(targetStores)]),
    ]
      .filter((storeName) => sourceStores[storeName] !== targetStores[storeName])
      .sort()
    const declaredSchemaTouchedStores = [...strategy.schemaTouchedStores].sort()
    if (
      actualSchemaTouchedStores.length !== declaredSchemaTouchedStores.length ||
      actualSchemaTouchedStores.some(
        (storeName, storeIndex) => storeName !== declaredSchemaTouchedStores[storeIndex],
      )
    ) {
      throw new Error(`BrowserWorkspaceUpgradeStrategySchemaLocalityInvalid:${strategy.id}`)
    }
    const previous = BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES[index - 1]
    if (previous && previous.targetStorageVersion !== strategy.sourceStorageVersion) {
      throw new Error(
        `BrowserWorkspaceUpgradeStrategyRouteGap:${previous.targetStorageVersion}:${strategy.sourceStorageVersion}`,
      )
    }
    const next = BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES[index + 1]
    if (
      next &&
      (strategy.targetStorageVersion !== next.sourceStorageVersion ||
        strategy.targetCompletionKey !== next.sourceCompletionKey)
    ) {
      throw new Error(`BrowserWorkspaceUpgradeStrategyProofGap:${strategy.id}:${next.id}`)
    }
    const targetStoreNames = new Set(Object.keys(strategy.targetStores))
    if (
      strategy.sourceCompletionKey.length === 0 ||
      strategy.targetCompletionKey.length === 0 ||
      strategy.progressOwner.length === 0 ||
      strategy.implementationId.length === 0 ||
      new Set(strategy.schemaTouchedStores).size !== strategy.schemaTouchedStores.length ||
      new Set(strategy.dataReadStores).size !== strategy.dataReadStores.length ||
      typeof strategy.sourceCompletionIsValid !== 'function' ||
      typeof strategy.targetCompletionIsValid !== 'function' ||
      strategy.dataReadStores.some((storeName) => !targetStoreNames.has(storeName))
    ) {
      throw new Error(`BrowserWorkspaceUpgradeStrategyContractInvalid:${strategy.id}`)
    }
  }
  const finalStrategy = BROWSER_WORKSPACE_REGISTERED_UPGRADE_STRATEGIES.at(-1)
  if (
    finalStrategy &&
    (finalStrategy.targetStorageVersion !==
      CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.storageVersion ||
      finalStrategy.targetCompletionKey !== CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.completionKey)
  ) {
    throw new Error(
      `BrowserWorkspaceUpgradeStrategyCurrentGap:${finalStrategy.targetStorageVersion}:${CURRENT_BROWSER_WORKSPACE_STORAGE_EPOCH.storageVersion}`,
    )
  }
}

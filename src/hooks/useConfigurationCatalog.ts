import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { PromptPresetKind } from '../core/types'
import {
  createConfigurationConnectionManagerSessionController,
  createConfigurationPresetCatalogSessionController,
  createConfigurationProfileCatalogSessionController,
  createConfigurationPromptPresetCatalogSessionController,
} from '../store/configuration-catalog-session'
import type {
  ConfigurationCatalogSessionController,
  ConfigurationCatalogSessionSnapshot,
  ConfigurationConnectionManagerRow,
  ConfigurationPresetCatalogRow,
  ConfigurationProfileCatalogRow,
  ConfigurationPromptPresetCatalogRow,
} from '../store/presentation-contracts'
import { useWorkspaceFence } from './useCatalogApplication'

export function useConnectionProfileCatalog(
  demanded: boolean,
  addressedIds: readonly string[] = EMPTY_ADDRESSED_IDS,
): ConfigurationCatalogHookResult<ConfigurationProfileCatalogRow> {
  const [controller] = useState(createConfigurationProfileCatalogSessionController)
  return useConfigurationCatalogSession(controller, demanded, addressedIds)
}

export function useConnectionManagerCatalog(
  demanded: boolean,
  addressedIds: readonly string[] = EMPTY_ADDRESSED_IDS,
  pageSize?: number,
): ConfigurationCatalogHookResult<ConfigurationConnectionManagerRow> {
  const [controller] = useState(createConfigurationConnectionManagerSessionController)
  return useConfigurationCatalogSession(controller, demanded, addressedIds, pageSize)
}

export function useChatPresetCatalog(
  demanded: boolean,
  addressedIds: readonly string[] = EMPTY_ADDRESSED_IDS,
): ConfigurationCatalogHookResult<ConfigurationPresetCatalogRow> {
  const [controller] = useState(createConfigurationPresetCatalogSessionController)
  return useConfigurationCatalogSession(controller, demanded, addressedIds)
}

export function usePromptPresetCatalog(
  kind: PromptPresetKind,
  demanded: boolean,
  addressedIds: readonly string[] = EMPTY_ADDRESSED_IDS,
): ConfigurationCatalogHookResult<ConfigurationPromptPresetCatalogRow> {
  const [controller] = useState(() => createConfigurationPromptPresetCatalogSessionController(kind))
  return useConfigurationCatalogSession(controller, demanded, addressedIds)
}

export interface ConfigurationCatalogHookResult<Row> {
  readonly snapshot: ConfigurationCatalogSessionSnapshot<Row> | null
  readonly demandAfter: () => void
  readonly demandBefore: () => void
  readonly refresh: () => number
}

const EMPTY_ADDRESSED_IDS: readonly string[] = Object.freeze([])

function useConfigurationCatalogSession<Row>(
  controller: ConfigurationCatalogSessionController<Row>,
  demanded: boolean,
  addressedIds: readonly string[],
  pageSize?: number,
): ConfigurationCatalogHookResult<Row> {
  const fence = useWorkspaceFence()
  const addressedKey = JSON.stringify(addressedIds)
  const stableAddressedIds = useMemo(
    () => Object.freeze(JSON.parse(addressedKey) as string[]),
    [addressedKey],
  )
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  )

  useEffect(() => {
    if (!demanded || !fence) {
      controller.release()
      return
    }
    controller.request({
      ...fence,
      addressedIds: stableAddressedIds,
      ...(pageSize === undefined ? {} : { pageSize }),
    })
    return () => controller.release()
  }, [controller, demanded, fence, pageSize, stableAddressedIds])

  const demandAfter = useCallback(() => controller.demandAfter(), [controller])
  const demandBefore = useCallback(() => controller.demandBefore(), [controller])
  const refresh = useCallback(() => {
    controller.refresh()
    return controller.getSnapshot()?.revision ?? 0
  }, [controller])

  return useMemo(
    () => ({ snapshot, demandAfter, demandBefore, refresh }),
    [demandAfter, demandBefore, refresh, snapshot],
  )
}

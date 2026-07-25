import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react'
import { configurationController } from '../store/configuration-controller'
import type { ConfigurationPreferencesProjection } from '../store/presentation-contracts'

export const ConfigurationPreferencesContext =
  createContext<ConfigurationPreferencesProjection | null>(null)

export function ConfigurationPreferencesProvider({ children }: { children: ReactNode }) {
  const preferences =
    useSyncExternalStore(
      configurationController.subscribe,
      configurationController.getSnapshot,
      configurationController.getSnapshot,
    ).frame.shell?.preferences ?? null
  return createElement(ConfigurationPreferencesContext.Provider, { value: preferences }, children)
}

export function useConfigurationPreferences(): ConfigurationPreferencesProjection | null {
  return useContext(ConfigurationPreferencesContext)
}

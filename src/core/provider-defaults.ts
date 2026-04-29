import type { ChatSettings, SortBy } from './types'

export const DEFAULT_OPENROUTER_PROVIDER_SORT: SortBy = 'price'

export function withOpenRouterProviderDefaults(settings: ChatSettings): ChatSettings {
  if (settings.providerPrefs?.sort !== undefined) return settings
  return {
    ...settings,
    providerPrefs: {
      ...(settings.providerPrefs ?? {}),
      sort: DEFAULT_OPENROUTER_PROVIDER_SORT,
    },
  }
}

import type { ApiVariant, ChatSettings, ConnectionProfile, SortBy } from './types'

export const DEFAULT_OPENROUTER_PROVIDER_SORT: SortBy = 'price'

function withOpenRouterProviderDefaults(settings: ChatSettings): ChatSettings {
  if (settings.providerPrefs?.sort !== undefined) return settings
  return {
    ...settings,
    providerPrefs: {
      ...(settings.providerPrefs ?? {}),
      sort: DEFAULT_OPENROUTER_PROVIDER_SORT,
    },
  }
}

export function isOpenAiDirectBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com'
  } catch {
    return /^https?:\/\/api\.openai\.com(\/|$)/u.test(baseUrl)
  }
}

export function defaultApiForProfile(profile: ConnectionProfile): ApiVariant {
  if (profile.kind === 'openai-compatible' && isOpenAiDirectBaseUrl(profile.baseUrl)) {
    return 'responses'
  }
  if (profile.kind === 'google') return 'gemini-native'
  if (profile.kind === 'anthropic') return 'anthropic-messages'
  return 'auto'
}

export function withProfileApiDefaults(
  settings: ChatSettings,
  profile: ConnectionProfile,
): ChatSettings {
  const api = settings.api === 'auto' ? defaultApiForProfile(profile) : settings.api
  const next = api === settings.api ? settings : { ...settings, api }
  return profile.kind === 'openrouter' ? withOpenRouterProviderDefaults(next) : next
}

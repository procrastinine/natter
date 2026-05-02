import { defaultApiForProfile } from '../core/provider-defaults'
import type { ApiVariant, ChatSettings, ConnectionProfile } from '../core/types'
import { migrateCurrentChatSettingsSnapshot } from './chat-settings'

type LegacyGeminiMode = 'native' | 'openai-compat'

type LegacyConnectionProfile = ConnectionProfile & {
  usesResponsesApiByDefault?: boolean
  geminiMode?: LegacyGeminiMode
  responsesDefaults?: {
    store?: unknown
    includeEncrypted?: unknown
  }
  geminiDefaults?: {
    allowImportedWithoutSignature?: unknown
  }
}

interface ProviderApiModeMigrationResult {
  settings: ChatSettings
  changed: boolean
}

export function migrateProviderApiModeSettings(
  settings: ChatSettings,
  profile: ConnectionProfile | undefined,
): ProviderApiModeMigrationResult {
  const currentResult = migrateCurrentChatSettingsSnapshot(settings)
  const current = currentResult.settings
  const legacyProfile = profile as LegacyConnectionProfile | undefined
  const next: ChatSettings = {
    ...current,
    responses: {
      store: current.responses?.store === true || legacyProfile?.responsesDefaults?.store === true,
    },
  }

  const gemini = current.gemini?.cachedContentName
    ? { cachedContentName: current.gemini.cachedContentName }
    : undefined
  if (gemini) {
    next.gemini = gemini
  } else {
    delete next.gemini
  }

  if (profile) next.api = migrateApiMode(current.api, legacyProfile ?? profile)

  const changed =
    currentResult.changed ||
    JSON.stringify(sortObjectKeys(settings)) !== JSON.stringify(sortObjectKeys(next))
  return changed ? { settings: next, changed: true } : { settings, changed: false }
}

export function migrateProviderApiModeProfile(profile: ConnectionProfile): {
  profile: ConnectionProfile
  changed: boolean
} {
  const legacy = profile as LegacyConnectionProfile
  if (
    legacy.usesResponsesApiByDefault === undefined &&
    legacy.geminiMode === undefined &&
    legacy.responsesDefaults === undefined &&
    legacy.geminiDefaults === undefined
  ) {
    return { profile, changed: false }
  }
  const next = { ...profile } as LegacyConnectionProfile
  delete next.usesResponsesApiByDefault
  delete next.geminiMode
  delete next.responsesDefaults
  delete next.geminiDefaults
  return { profile: next, changed: true }
}

function migrateApiMode(api: ApiVariant, profile: LegacyConnectionProfile): ApiVariant {
  if (profile.kind === 'google') {
    if (api === 'chat' || api === 'gemini-native') return api
    return profile.geminiMode === 'openai-compat' ? 'chat' : 'gemini-native'
  }
  if (profile.kind === 'anthropic') {
    if (api === 'chat' || api === 'anthropic-messages') return api
    return 'anthropic-messages'
  }
  if (profile.kind === 'openai-compatible') {
    if (api === 'chat' || api === 'responses') return api
    if (api !== 'auto') return defaultApiForProfile(profile)
    if (profile.usesResponsesApiByDefault !== undefined) {
      return profile.usesResponsesApiByDefault ? 'responses' : 'chat'
    }
    return defaultApiForProfile(profile)
  }
  if (api === 'gemini-native' || api === 'anthropic-messages') return 'auto'
  return api
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (!value || typeof value !== 'object') return value
  const input = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(input).sort()) {
    const child = input[key]
    if (child !== undefined) out[key] = sortObjectKeys(child)
  }
  return out
}

import { cloneDefaultChatSettings } from '../core/defaults'
import { withProfileApiDefaults } from '../core/provider-defaults'
import type { ChatPreset, ConnectionProfile, KeyRecord } from '../core/types'
import { createKey } from './keys'
import { createPreset } from './presets'
import { createProfile } from './profiles'

interface FirstRunSeedInput {
  apiKey: string
  keyName?: string
  passphrase?: string
  passphraseHint?: string
  profileName?: string
  profileBaseUrl?: string
  profileKind?: ConnectionProfile['kind']
  appTitle?: string
  appUrl?: string
  presetName?: string
  model?: string
  now?: number
}

interface FirstRunSeedResult {
  key: KeyRecord
  profile: ConnectionProfile
  preset: ChatPreset
}

export async function runFirstRunSeed(input: FirstRunSeedInput): Promise<FirstRunSeedResult> {
  const now = input.now ?? Date.now()
  const key = await createKey({
    name: input.keyName ?? 'OpenRouter',
    plaintextKey: input.apiKey,
    ...(input.passphrase !== undefined ? { passphrase: input.passphrase } : {}),
    ...(input.passphraseHint !== undefined ? { passphraseHint: input.passphraseHint } : {}),
    now,
  })
  const profile = await createProfile({
    name: input.profileName ?? 'OpenRouter',
    kind: input.profileKind ?? 'openrouter',
    baseUrl: input.profileBaseUrl ?? 'https://openrouter.ai/api/v1',
    apiKeyRef: key.id,
    appTitle: input.appTitle ?? 'llm-api-frontend',
    appUrl: input.appUrl ?? '',
    now,
  })
  const settings = cloneDefaultChatSettings()
  settings.profileId = profile.id
  settings.model = input.model ?? ''
  const preset = await createPreset({
    name: input.presetName ?? `${profile.name} default`,
    connectionProfileId: profile.id,
    settings: withProfileApiDefaults(settings, profile),
    lastUsedAt: now,
    now,
  })
  return { key, profile, preset }
}

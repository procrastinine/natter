// Default values for the core domain. Frozen to guard against accidental mutation
// via shared references, since every new chat / preset copies from these.
//
// See `plan/02-data-model.md §2.5` (settings precedence) and `plan/13-delivery.md §13.2.1`
// for the fields Phase 0 requires.

import type { ChatPreset, ChatSettings, ConnectionProfile, DataPolicy, KeyRecord, PrivacyPrefs } from './types'
import { createKey } from '../store/keys'
import { createPreset } from '../store/presets'
import { createProfile } from '../store/profiles'

// First-run seed: ordered candidate model list consumed by `resolveDefaultModel`
// when creating the seed ChatPreset for a new ConnectionProfile. See
// `plan/14-details.md §14.35.8`. The actual fetch + resolution lives in Phase 5;
// this constant is the pure-data default that Phase 2 pins so no other
// subsystem has to hardcode the list.
export const SEED_DEFAULT_MODEL_CANDIDATES: readonly string[] = Object.freeze([
  'anthropic/claude-opus-4.7',
  'openai/gpt-5.4',
  'google/gemini-3.1-pro',
  'z-ai/glm-5.1',
])

export const DEFAULT_PRIVACY_PREFS: Readonly<PrivacyPrefs> = Object.freeze({
  denyDataCollection: true,
  zdrOnly: false,
  paretoFilter: true,
  usePreferredOrdering: true,
  ignoreProviders: [],
  onlyProviders: [],
  byokEnabled: false,
})

// Worst-case synthetic policy used when scraping returned no policy for an endpoint.
// See `plan/09-privacy.md §9.6`.
export const UNKNOWN_POLICY: Readonly<DataPolicy> = Object.freeze({
  training: true,
  trainingOpenRouter: true,
  retainsPrompts: true,
  canPublish: false,
  requiresUserIDs: true,
  termsOfServiceURL: '',
  privacyPolicyURL: '',
})

export const DEFAULT_CHAT_SETTINGS: Readonly<ChatSettings> = Object.freeze({
  profileId: '',
  model: '',
  systemPrompt: '',
  systemRole: 'system',
  sampling: Object.freeze({}),
  reasoning: Object.freeze<ChatSettings['reasoning']>({
    mode: 'enabled',
    exclude: false,
    summary: 'auto',
    carryForward: 'auto',
  }),
  contextStrategy: Object.freeze<ChatSettings['contextStrategy']>({
    kind: 'sliding_window',
    reservedForCompletion: 512,
    onOverflow: 'ask',
  }),
  allowFallbacks: true,
  mediaContextStrategy: 'echo-all',
  mediaEchoN: 5,
  cacheRemoteImages: true,
  stripExifOnUpload: true,
  toolContextStrategy: 'echo-all',
  toolContextSummarizeAfterN: 6,
  enabledToolIds: [],
  enabledServerToolIds: [],
  enabledPluginIds: [],
  trustedToolIds: [],
  autoContinueToolLoop: true,
  anthropicCache: Object.freeze<ChatSettings['anthropicCache']>({
    mode: 'off',
    ttl: '5m',
  }),
  privacy: DEFAULT_PRIVACY_PREFS,
  api: 'auto',
  userIdMode: 'omit',
  serviceTier: 'auto',
})

// Deep-clone the defaults for seeding a new chat or preset. We never hand out the
// frozen singleton because callers mutate freely.
export function cloneDefaultChatSettings(): ChatSettings {
  return structuredClone(DEFAULT_CHAT_SETTINGS) as ChatSettings
}

export function cloneDefaultPrivacyPrefs(): PrivacyPrefs {
  return structuredClone(DEFAULT_PRIVACY_PREFS) as PrivacyPrefs
}

// Pick a default model for a brand-new ConnectionProfile's seed preset.
// §14.35.8: walk the candidate list in order, returning the first model
// exposed by `/models` whose `expiration_date` (if any) is at least 60 days
// out. If none match, fall back to the first tool-capable model; finally, the
// first model the endpoint advertised at all. Phase 5 callers pass
// `availableModels` from the live `/models` response; tests supply fixtures.
export interface ModelCandidate {
  id: string
  expirationDate?: string
  supportedParameters?: string[]
}

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000

export function resolveDefaultModel(
  availableModels: readonly ModelCandidate[],
  opts: { now?: number } = {},
): string {
  const now = opts.now ?? Date.now()
  const byId = new Map<string, ModelCandidate>()
  for (const m of availableModels) byId.set(m.id, m)
  const freshEnough = (m: ModelCandidate): boolean => {
    if (!m.expirationDate) return true
    const parsed = Date.parse(m.expirationDate)
    if (Number.isNaN(parsed)) return true
    return parsed - now >= SIXTY_DAYS_MS
  }
  for (const candidate of SEED_DEFAULT_MODEL_CANDIDATES) {
    const match = byId.get(candidate)
    if (match && freshEnough(match)) return match.id
  }
  for (const m of availableModels) {
    if (m.supportedParameters?.includes('tools') && freshEnough(m)) return m.id
  }
  return availableModels[0]?.id ?? SEED_DEFAULT_MODEL_CANDIDATES[0] ?? ''
}

// First-run seed per `plan/09-privacy.md §9.1`:
//   1. Create ONE KeyRecord wrapping the pasted API key.
//   2. Create ONE ConnectionProfile pointing at that key.
//   3. Create ONE ChatPreset pointing at that profile with DEFAULT_CHAT_SETTINGS.
// `resolveDefaultModel` is expected to run before calling this so the preset
// starts with a concrete model; callers that haven't loaded /models yet can
// pass an explicit `model` and defer resolution.
export interface FirstRunSeedInput {
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

export interface FirstRunSeedResult {
  key: KeyRecord
  profile: ConnectionProfile
  preset: ChatPreset
}

export async function runFirstRunSeed(
  input: FirstRunSeedInput,
): Promise<FirstRunSeedResult> {
  const now = input.now ?? Date.now()
  const key = await createKey({
    name: input.keyName ?? 'OpenRouter',
    plaintextKey: input.apiKey,
    ...(input.passphrase !== undefined ? { passphrase: input.passphrase } : {}),
    ...(input.passphraseHint !== undefined
      ? { passphraseHint: input.passphraseHint }
      : {}),
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
    settings,
    lastUsedAt: now,
    now,
  })
  return { key, profile, preset }
}

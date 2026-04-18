// Default values for the core domain. Frozen to guard against accidental mutation
// via shared references, since every new chat / preset copies from these.
//
// See `plan/02-data-model.md §2.5` (settings precedence) and `plan/13-delivery.md §13.2.1`
// for the fields Phase 0 requires.

import type { ChatSettings, DataPolicy, PrivacyPrefs } from './types'

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

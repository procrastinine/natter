// Default values for the core domain. Frozen to guard against accidental mutation
// via shared references, since every new chat / preset copies from these.
import { DEFAULT_CONTINUE_SYSTEM_PROMPT, DEFAULT_CONTINUE_USER_PROMPT } from './continue-prompts'
import { LATEST_OPENROUTER_MODEL_IDS } from './latest-models'
import type { ChatSettings, DataPolicy, PrivacyPrefs } from './types'

const DEFAULT_PRIVACY_PREFS: Readonly<PrivacyPrefs> = Object.freeze({
  denyDataCollection: true,
  zdrOnly: false,
  paretoFilter: true,
  byokEnabled: false,
})

// Worst-case synthetic policy used when scraping returned no policy for an endpoint.
export const UNKNOWN_POLICY: Readonly<DataPolicy> = Object.freeze({
  training: true,
  trainingOpenRouter: true,
  retainsPrompts: true,
  canPublish: false,
  requiresUserIDs: true,
  termsOfServiceURL: '',
  privacyPolicyURL: '',
})

const DEFAULT_CHAT_SETTINGS: Readonly<ChatSettings> = Object.freeze({
  profileId: '',
  model: '',
  systemPrompt: '',
  systemRole: 'system',
  appendPrompt: '',
  continueSystemPrompt: DEFAULT_CONTINUE_SYSTEM_PROMPT,
  continueUserPrompt: DEFAULT_CONTINUE_USER_PROMPT,
  defaultPrefill: '',
  continuePrefill: false,
  sampling: Object.freeze({}),
  reasoning: Object.freeze<ChatSettings['reasoning']>({
    mode: 'default',
    exclude: false,
    // `summary: 'auto'` asks the provider for a human-readable summary.
    // UI shows it; it's NOT echoed on the next turn (see `include` below).
    summary: 'auto',
    // Phase 11 default: round-trip ONLY the encrypted carry-forward carrier.
    // `summary` + `text` are false by default — those only count when the
    // user explicitly wants to resend visible reasoning (rare). Anthropic's
    // carrier lives in a `reasoning.text` detail with `.signature`; the
    // filter treats that as encrypted-gated automatically.
    include: Object.freeze<ChatSettings['reasoning']['include']>({
      encrypted: true,
      summary: false,
      text: false,
    }),
    echoAsThinkTags: false,
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
  toolCallContext: Object.freeze<ChatSettings['toolCallContext']>({
    include: true,
  }),
  enabledToolIds: [],
  tools: Object.freeze<ChatSettings['tools']>({
    openrouter: Object.freeze({ enabledServerToolIds: [] }),
    openai: Object.freeze({ enabledServerToolIds: [] }),
    anthropic: Object.freeze({ enabledServerToolIds: [] }),
    google: Object.freeze({ enabledServerToolIds: [] }),
  }),
  enabledPluginIds: [],
  trustedToolIds: [],
  autoContinueToolLoop: true,
  anthropicCache: Object.freeze<ChatSettings['anthropicCache']>({
    mode: 'off',
    ttl: '5m',
  }),
  privacy: DEFAULT_PRIVACY_PREFS,
  api: 'auto',
  responses: Object.freeze<NonNullable<ChatSettings['responses']>>({
    store: false,
  }),
  userIdMode: 'omit',
  serviceTier: 'auto',
})

// Deep-clone the defaults for seeding a new chat or preset. We never hand out the
// frozen singleton because callers mutate freely.
export function cloneDefaultChatSettings(): ChatSettings {
  return structuredClone(DEFAULT_CHAT_SETTINGS)
}

interface ModelCandidate {
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
  for (const model of availableModels) byId.set(model.id, model)
  const freshEnough = (model: ModelCandidate): boolean => {
    if (!model.expirationDate) return true
    const expiration = Date.parse(model.expirationDate)
    return Number.isNaN(expiration) || expiration - now >= SIXTY_DAYS_MS
  }
  for (const candidate of LATEST_OPENROUTER_MODEL_IDS) {
    const model = byId.get(candidate)
    if (model && freshEnough(model)) return model.id
  }
  for (const model of availableModels) {
    if (model.supportedParameters?.includes('tools') && freshEnough(model)) return model.id
  }
  return availableModels[0]?.id ?? LATEST_OPENROUTER_MODEL_IDS[0] ?? ''
}

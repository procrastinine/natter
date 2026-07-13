// Default values for the core domain. Frozen to guard against accidental mutation
// via shared references, since every new chat / preset copies from these.
import { DEFAULT_CONTINUE_SYSTEM_PROMPT, DEFAULT_CONTINUE_USER_PROMPT } from './continue-prompts'
import type { ChatSettings, DataPolicy, PrivacyPrefs } from './types'

// First-run seed: ordered candidate model list consumed by `resolveDefaultModel`
// when creating the seed ChatPreset for a new ConnectionProfile. This
// pure-data default keeps the list out of fetch and resolution code.
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

export const DEFAULT_CHAT_SETTINGS: Readonly<ChatSettings> = Object.freeze({
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

export function cloneDefaultPrivacyPrefs(): PrivacyPrefs {
  return structuredClone(DEFAULT_PRIVACY_PREFS)
}

// Pick a default model for a brand-new ConnectionProfile's seed preset.
// §14.35.8: walk the candidate list in order, returning the first model
// exposed by `/models` whose `expiration_date` (if any) is at least 60 days
// out. If none match, fall back to the first tool-capable model; finally, the
// first model the endpoint advertised at all. Phase 5 callers pass
// `availableModels` from the live `/models` response; tests supply fixtures.
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

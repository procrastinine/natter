import { cloneDefaultChatSettings } from '../core/defaults'
import { defaultReasoningInclude, normalizeReasoningSettings } from '../core/reasoning'
import type { ChatSettings, ReasoningFormat, ReasoningInclude } from '../core/types'
import { migrateProviderToolSettings } from './provider-tools'

const LEGACY_PRIVACY_KEYS = ['usePreferredOrdering'] as const

type LegacyReasoningCarryForward = 'off' | 'plaintext' | 'encrypted' | 'auto'

export interface ChatSettingsMigrationResult {
  settings: ChatSettings
  changed: boolean
}

export function migrateLegacyChatSettings(settings: ChatSettings): ChatSettingsMigrationResult {
  const privacyResult = migrateLegacyPrivacyPrefs(settings.privacy)
  const reasoningResult = migrateLegacyReasoningSettings(settings.reasoning)
  if (!privacyResult.changed && !reasoningResult.changed) return { settings, changed: false }
  return {
    settings: { ...settings, privacy: privacyResult.privacy, reasoning: reasoningResult.reasoning },
    changed: true,
  }
}

const CURRENT_CHAT_SETTINGS_KEYS = [
  'profileId',
  'model',
  'fallbackModels',
  'systemPrompt',
  'systemPromptPresetId',
  'systemRole',
  'appendPrompt',
  'appendPromptPresetId',
  'continueSystemPrompt',
  'continueSystemPromptPresetId',
  'continueUserPrompt',
  'continueUserPromptPresetId',
  'defaultPrefill',
  'defaultPrefillPresetId',
  'continuePrefill',
  'sampling',
  'stop',
  'modalities',
  'reasoning',
  'verbosity',
  'maxCompletionTokens',
  'customMaxContext',
  'strictProviderRouting',
  'contextStrategy',
  'allowFallbacks',
  'mediaContextStrategy',
  'mediaEchoN',
  'cacheRemoteImages',
  'stripExifOnUpload',
  'toolContextStrategy',
  'toolContextSummarizeAfterN',
  'toolCallContext',
  'enabledToolIds',
  'tools',
  'enabledPluginIds',
  'trustedToolIds',
  'autoContinueToolLoop',
  'responseFormat',
  'logitBias',
  'anthropicCache',
  'providerPrefs',
  'privacy',
  'api',
  'sessionId',
  'userIdMode',
  'metadata',
  'trace',
  'serviceTier',
  'cachePrompt',
  'protocol',
  'textTemplate',
  'customTextTemplate',
  'responses',
  'gemini',
] as const satisfies readonly (keyof ChatSettings)[]

export function migrateCurrentChatSettingsSnapshot(
  rawSettings: ChatSettings,
): ChatSettingsMigrationResult {
  const defaults = cloneDefaultChatSettings()
  const toolResult = migrateProviderToolSettings(rawSettings)
  const raw = toolResult.settings as Partial<ChatSettings> & Record<string, unknown>

  const preLegacy = currentFieldsFrom(defaults, raw)
  preLegacy.sampling = mergeObject(defaults.sampling, raw.sampling)
  preLegacy.contextStrategy = mergeObject(defaults.contextStrategy, raw.contextStrategy)
  preLegacy.anthropicCache = mergeObject(defaults.anthropicCache, raw.anthropicCache)
  preLegacy.privacy = mergeObject(defaults.privacy, raw.privacy)
  preLegacy.reasoning = isRecord(raw.reasoning)
    ? (raw.reasoning as ChatSettings['reasoning'])
    : defaults.reasoning
  preLegacy.tools = mergeToolSettings(defaults.tools, raw.tools)
  preLegacy.toolCallContext = mergeObject(defaults.toolCallContext, raw.toolCallContext)

  const legacyResult = migrateLegacyChatSettings(preLegacy)
  const migratedRaw = legacyResult.settings as Partial<ChatSettings> & Record<string, unknown>
  const next = currentFieldsFrom(defaults, migratedRaw)
  next.sampling = mergeObject(defaults.sampling, migratedRaw.sampling)
  next.contextStrategy = mergeObject(defaults.contextStrategy, migratedRaw.contextStrategy)
  next.anthropicCache = mergeObject(defaults.anthropicCache, migratedRaw.anthropicCache)
  next.privacy = mergeObject(defaults.privacy, migratedRaw.privacy)
  next.reasoning = mergeReasoning(defaults.reasoning, migratedRaw.reasoning)
  next.tools = mergeToolSettings(defaults.tools, migratedRaw.tools)
  next.toolCallContext = mergeObject(defaults.toolCallContext, migratedRaw.toolCallContext)

  const changed =
    toolResult.changed ||
    legacyResult.changed ||
    JSON.stringify(sortObjectKeys(rawSettings)) !== JSON.stringify(sortObjectKeys(next))
  return changed ? { settings: next, changed: true } : { settings: rawSettings, changed: false }
}

export function migrateLegacyCarryForwardToInclude(
  legacy: LegacyReasoningCarryForward | undefined,
  preservationFormat: ReasoningFormat | undefined,
): ReasoningInclude {
  switch (legacy) {
    case 'off':
      return { encrypted: false, summary: false, text: false }
    case 'plaintext':
      return { encrypted: false, summary: true, text: true }
    case 'encrypted':
      return { encrypted: true, summary: false, text: false }
    default:
      return defaultReasoningInclude(preservationFormat)
  }
}

function migrateLegacyPrivacyPrefs(privacy: ChatSettings['privacy']): {
  privacy: ChatSettings['privacy']
  changed: boolean
} {
  const next = { ...privacy } as ChatSettings['privacy'] & Record<string, unknown>
  let changed = false
  for (const key of LEGACY_PRIVACY_KEYS) {
    if (key in next) {
      delete next[key]
      changed = true
    }
  }
  return changed ? { privacy: next, changed: true } : { privacy, changed: false }
}

function migrateLegacyReasoningSettings(reasoning: ChatSettings['reasoning']): {
  reasoning: ChatSettings['reasoning']
  changed: boolean
} {
  const legacy = reasoning as ChatSettings['reasoning'] & {
    carryForward?: LegacyReasoningCarryForward
  }
  if (legacy.carryForward === undefined) {
    const next = normalizeReasoningSettings(reasoning)
    return next !== reasoning ? { reasoning: next, changed: true } : { reasoning, changed: false }
  }
  const { carryForward, ...rest } = legacy
  const nextInput =
    legacy.include === undefined
      ? { ...rest, include: migrateLegacyCarryForwardToInclude(carryForward, undefined) }
      : rest
  const next = normalizeReasoningSettings(nextInput)
  return { reasoning: next, changed: true }
}

function currentFieldsFrom(
  defaults: ChatSettings,
  raw: Partial<ChatSettings> & Record<string, unknown>,
): ChatSettings {
  const next = structuredClone(defaults)
  for (const key of CURRENT_CHAT_SETTINGS_KEYS) {
    const value = raw[key]
    if (value !== undefined) {
      ;(next as Record<keyof ChatSettings, unknown>)[key] = value
    }
  }
  return next
}

function mergeReasoning(
  defaults: ChatSettings['reasoning'],
  raw: unknown,
): ChatSettings['reasoning'] {
  const merged = mergeObject(defaults, raw)
  merged.include = mergeObject(defaults.include, isRecord(raw) ? raw.include : undefined)
  return normalizeReasoningSettings(merged)
}

function mergeToolSettings(
  defaults: ChatSettings['tools'],
  raw: unknown,
): ChatSettings['tools'] {
  const tools = isRecord(raw) ? raw : {}
  return {
    openrouter: mergeObject(defaults.openrouter, tools.openrouter),
    openai: mergeObject(defaults.openai, tools.openai),
    anthropic: mergeObject(defaults.anthropic, tools.anthropic),
    google: mergeObject(defaults.google, tools.google),
  }
}

function mergeObject<T extends object>(defaults: T, raw: unknown): T {
  const next = structuredClone(defaults)
  const out = next as Record<string, unknown>
  if (!isRecord(raw)) return next as T
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined) out[key] = value
  }
  return next as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const child = value[key]
    if (child !== undefined) out[key] = sortObjectKeys(child)
  }
  return out
}

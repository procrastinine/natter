import { defaultReasoningInclude, normalizeReasoningSettings } from '../core/reasoning'
import type { ChatSettings, ReasoningFormat, ReasoningInclude } from '../core/types'

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

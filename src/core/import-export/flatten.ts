import {
  EMPTY_TEXT_TEMPLATE,
  TEXT_TEMPLATES,
  type SavedTextTemplate,
} from '../text-templates'
import type { ChatSettings, PromptPresetId } from '../types'

const PROMPT_PIN_KEYS = [
  'systemPromptPresetId',
  'appendPromptPresetId',
  'continueSystemPromptPresetId',
  'continueUserPromptPresetId',
  'defaultPrefillPresetId',
] as const satisfies readonly (keyof ChatSettings)[]

export interface FlattenChatSettingsOptions {
  savedTextTemplates?: readonly SavedTextTemplate[]
}

export function flattenChatSettingsForPortableExport(
  settings: ChatSettings,
  options: FlattenChatSettingsOptions = {},
): ChatSettings {
  const next = structuredClone(settings)
  stripPromptPresetPins(next)
  flattenTextTemplate(next, options.savedTextTemplates ?? [])

  // User-defined tool registry rows are not portable until the registry has
  // its own export block. Provider-hosted tool settings remain portable.
  next.enabledToolIds = []
  next.trustedToolIds = []

  return next
}

export function stripPromptPresetPins(settings: ChatSettings): ChatSettings {
  for (const key of PROMPT_PIN_KEYS) {
    delete (settings as Record<keyof ChatSettings, unknown>)[key]
  }
  return settings
}

export function chatSettingsHasPromptPresetPins(settings: ChatSettings): boolean {
  return PROMPT_PIN_KEYS.some((key) => typeof settings[key] === 'string')
}

function flattenTextTemplate(
  settings: ChatSettings,
  savedTextTemplates: readonly SavedTextTemplate[],
): void {
  const id = settings.textTemplate
  if (!id || id === 'default' || id === 'custom') return
  if (TEXT_TEMPLATES[id]) return
  if (!id.startsWith('user:')) return

  const saved = savedTextTemplates.find((row) => row.id === id)
  settings.textTemplate = 'custom'
  settings.customTextTemplate = structuredClone(
    saved?.config ?? settings.customTextTemplate ?? EMPTY_TEXT_TEMPLATE,
  )
}

export function promptPresetIdKeys(): readonly (keyof ChatSettings)[] {
  return PROMPT_PIN_KEYS
}

export function promptPresetIdsInSettings(settings: ChatSettings): PromptPresetId[] {
  const ids: PromptPresetId[] = []
  for (const key of PROMPT_PIN_KEYS) {
    const value = settings[key]
    if (typeof value === 'string') ids.push(value)
  }
  return ids
}

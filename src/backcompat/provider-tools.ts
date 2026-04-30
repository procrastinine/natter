import type { ChatProviderToolSettings, ChatSettings } from '../core/types'
import type { Chat, ChatPreset } from '../core/types'
import type { NatterDb, SettingsRow } from '../store/db'

export const PROVIDER_TOOL_SETTINGS_BACKFILL_KEY = 'backfill:provider-tool-settings-v2'

export function providerToolSettingsBackfillMarker(): SettingsRow {
  return { key: PROVIDER_TOOL_SETTINGS_BACKFILL_KEY, value: 1 }
}

export async function migrateProviderToolSettingsRows(db: NatterDb): Promise<void> {
  const marker = await db.settings.get(PROVIDER_TOOL_SETTINGS_BACKFILL_KEY)
  if (marker?.value === 1) return

  await db.transaction('rw', db.chats, db.presets, db.settings, async () => {
    await db.chats.toCollection().modify((chat: Chat) => {
      const result = migrateProviderToolSettings(chat.settings)
      if (result.changed) chat.settings = result.settings
    })
    await db.presets.toCollection().modify((preset: ChatPreset) => {
      const result = migrateProviderToolSettings(preset.settings)
      if (result.changed) preset.settings = result.settings
    })
    await db.settings.put(providerToolSettingsBackfillMarker())
  })
}

type LegacyToolSettings = ChatSettings & {
  enabledServerToolIds?: ChatSettings['tools']['openrouter']['enabledServerToolIds']
  toolChoice?: ChatSettings['tools']['openrouter']['toolChoice']
  parallelToolCalls?: ChatSettings['tools']['openrouter']['parallelToolCalls']
  toolCallContext?: Partial<ChatSettings['toolCallContext']>
  tools?: Partial<{
    openrouter: Partial<ChatProviderToolSettings['openrouter']>
    openai: Partial<ChatProviderToolSettings['openai']>
    anthropic: Partial<ChatProviderToolSettings['anthropic']>
    google: Partial<ChatProviderToolSettings['google']>
  }>
}

export interface ProviderToolSettingsMigrationResult {
  settings: ChatSettings
  changed: boolean
}

export function migrateProviderToolSettings(
  rawSettings: ChatSettings,
): ProviderToolSettingsMigrationResult {
  const legacy = rawSettings as LegacyToolSettings
  const tools = legacy.tools
  const nextToolCallContext: ChatSettings['toolCallContext'] = {
    include: legacy.toolCallContext?.include ?? true,
  }
  const nextTools: ChatProviderToolSettings = {
    openrouter: {
      ...tools?.openrouter,
      enabledServerToolIds:
        tools?.openrouter?.enabledServerToolIds ?? legacy.enabledServerToolIds ?? [],
      ...(tools?.openrouter?.toolChoice !== undefined
        ? { toolChoice: tools.openrouter.toolChoice }
        : legacy.toolChoice !== undefined
          ? { toolChoice: legacy.toolChoice }
          : {}),
      ...(tools?.openrouter?.parallelToolCalls !== undefined
        ? { parallelToolCalls: tools.openrouter.parallelToolCalls }
        : legacy.parallelToolCalls !== undefined
          ? { parallelToolCalls: legacy.parallelToolCalls }
          : {}),
    },
    openai: {
      ...tools?.openai,
      enabledServerToolIds: tools?.openai?.enabledServerToolIds ?? [],
      ...(tools?.openai?.toolChoice !== undefined ? { toolChoice: tools.openai.toolChoice } : {}),
      ...(tools?.openai?.parallelToolCalls !== undefined
        ? { parallelToolCalls: tools.openai.parallelToolCalls }
        : {}),
    },
    anthropic: {
      ...tools?.anthropic,
      enabledServerToolIds: tools?.anthropic?.enabledServerToolIds ?? [],
      ...(tools?.anthropic?.toolChoice !== undefined
        ? { toolChoice: tools.anthropic.toolChoice }
        : {}),
      ...(tools?.anthropic?.parallelToolCalls !== undefined
        ? { parallelToolCalls: tools.anthropic.parallelToolCalls }
        : {}),
    },
    google: {
      ...tools?.google,
      enabledServerToolIds: tools?.google?.enabledServerToolIds ?? [],
      ...(tools?.google?.toolChoice !== undefined ? { toolChoice: tools.google.toolChoice } : {}),
      ...(tools?.google?.parallelToolCalls !== undefined
        ? { parallelToolCalls: tools.google.parallelToolCalls }
        : {}),
    },
  }
  if (
    hasCurrentToolBuckets(tools) &&
    hasCurrentToolCallContext(legacy.toolCallContext) &&
    legacy.enabledServerToolIds === undefined &&
    legacy.toolChoice === undefined &&
    legacy.parallelToolCalls === undefined
  ) {
    return { settings: rawSettings, changed: false }
  }

  const next = {
    ...rawSettings,
    tools: nextTools,
    toolCallContext: nextToolCallContext,
  } as LegacyToolSettings
  delete next.enabledServerToolIds
  delete next.toolChoice
  delete next.parallelToolCalls
  return { settings: next as ChatSettings, changed: true }
}

function hasCurrentToolCallContext(
  value: LegacyToolSettings['toolCallContext'],
): value is ChatSettings['toolCallContext'] {
  return !!value && typeof value === 'object' && typeof value.include === 'boolean'
}

function hasCurrentToolBuckets(
  tools: LegacyToolSettings['tools'],
): tools is ChatProviderToolSettings {
  return (
    hasToolBucket(tools?.openrouter) &&
    hasToolBucket(tools?.openai) &&
    hasToolBucket(tools?.anthropic) &&
    hasToolBucket(tools?.google)
  )
}

function hasToolBucket(value: unknown): value is { enabledServerToolIds: string[] } {
  return (
    !!value &&
    typeof value === 'object' &&
    Array.isArray((value as { enabledServerToolIds?: unknown }).enabledServerToolIds)
  )
}

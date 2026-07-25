import {
  AUTO_SCROLL_STREAM_KEY,
  BASE_FONT_SIZE_KEY,
  type BaseFontSize,
  CHAT_MAX_WIDTH_KEY,
  type ChatMaxWidth,
  COMPOSER_FOCUS_MANUAL_HEIGHT_KEY,
  COMPOSER_HEIGHT_KEY,
  COMPOSER_NORMAL_MANUAL_HEIGHT_KEY,
  CORS_PROXY_SECRET_KEY,
  CORS_PROXY_URL_KEY,
  clampGlobalPreferenceInt,
  FONT_FAMILY_KEY,
  type FontFamilyChoice,
  GLOBAL_PREFERENCE_KEYS,
  type GlobalPreferences,
  globalPreferencesFromStored,
  LONG_MESSAGE_DISPLAY_MODE_KEY,
  type LongMessageDisplayMode,
  MESSAGE_INITIAL_RENDER_WORK_KEY,
  MESSAGE_INITIAL_RENDER_WORK_MAX,
  MESSAGE_INITIAL_RENDER_WORK_MIN,
  MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY,
  type RenderWindowLoadMode,
  SEND_SHORTCUT_KEY,
  type SendShortcut,
  SIDEBAR_COLLAPSED_KEY,
  SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY,
  SIDEBAR_RENDER_WINDOW_SIZE_KEY,
  SIDEBAR_RENDER_WINDOW_SIZE_MAX,
  SIDEBAR_RENDER_WINDOW_SIZE_MIN,
  THEME_KEY,
  type ThemePreference,
  TOKEN_CALIBRATION_MODE_KEY,
  type TokenCalibrationMode,
} from '../core/global-settings'
import { configurationApplication } from './configuration-application'
import { getSettings } from './settings'
import type { WorkspaceReadAuthority } from './workspace-protocol'

export async function readGlobalPreferences(
  authority?: WorkspaceReadAuthority,
): Promise<GlobalPreferences> {
  return globalPreferencesFromStored(await getSettings(GLOBAL_PREFERENCE_KEYS, authority))
}

export function writeCorsProxyUrl(value: string): Promise<void> {
  return writeGlobalPreference(CORS_PROXY_URL_KEY, value)
}

export function writeCorsProxySecret(value: string): Promise<void> {
  return writeGlobalPreference(CORS_PROXY_SECRET_KEY, value)
}

export function writeLongMessageDisplayMode(value: LongMessageDisplayMode): Promise<void> {
  return writeGlobalPreference(LONG_MESSAGE_DISPLAY_MODE_KEY, value)
}

export function writeMessageInitialRenderWork(value: number): Promise<void> {
  return writeGlobalPreference(
    MESSAGE_INITIAL_RENDER_WORK_KEY,
    clampGlobalPreferenceInt(
      value,
      MESSAGE_INITIAL_RENDER_WORK_MIN,
      MESSAGE_INITIAL_RENDER_WORK_MAX,
    ),
  )
}

export function writeSidebarRenderWindowSize(value: number): Promise<void> {
  return writeGlobalPreference(
    SIDEBAR_RENDER_WINDOW_SIZE_KEY,
    clampGlobalPreferenceInt(value, SIDEBAR_RENDER_WINDOW_SIZE_MIN, SIDEBAR_RENDER_WINDOW_SIZE_MAX),
  )
}

export function writeMessageRenderWindowLoadMode(value: RenderWindowLoadMode): Promise<void> {
  return writeGlobalPreference(MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY, value)
}

export function writeSidebarRenderWindowLoadMode(value: RenderWindowLoadMode): Promise<void> {
  return writeGlobalPreference(SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY, value)
}

export function writeTokenCalibrationMode(value: TokenCalibrationMode): Promise<void> {
  return writeGlobalPreference(TOKEN_CALIBRATION_MODE_KEY, value)
}

export async function setPinnedModel(modelId: string, pinned: boolean): Promise<void> {
  await configurationApplication.execute({
    kind: 'pinned-model.set-membership',
    modelId,
    pinned,
    now: Date.now(),
  })
}

export async function movePinnedModel(modelId: string, delta: -1 | 1): Promise<void> {
  await configurationApplication.execute({
    kind: 'pinned-model.move',
    modelId,
    delta,
    now: Date.now(),
  })
}

export async function clearRecentModels(): Promise<void> {
  await configurationApplication.execute({ kind: 'recent-model.clear', now: Date.now() })
}

export function writeTheme(value: ThemePreference): Promise<void> {
  return writeGlobalPreference(THEME_KEY, value)
}

export function writeSendShortcut(value: SendShortcut): Promise<void> {
  return writeGlobalPreference(SEND_SHORTCUT_KEY, value)
}

export function writeChatMaxWidth(value: ChatMaxWidth): Promise<void> {
  return writeGlobalPreference(CHAT_MAX_WIDTH_KEY, value)
}

export function writeFontFamily(value: FontFamilyChoice): Promise<void> {
  return writeGlobalPreference(FONT_FAMILY_KEY, value)
}

export function writeBaseFontSize(value: BaseFontSize): Promise<void> {
  return writeGlobalPreference(BASE_FONT_SIZE_KEY, value)
}

export function writeAutoScrollOnStream(value: boolean): Promise<void> {
  return writeGlobalPreference(AUTO_SCROLL_STREAM_KEY, value)
}

export function writeSidebarCollapsed(value: boolean): Promise<void> {
  return writeGlobalPreference(SIDEBAR_COLLAPSED_KEY, value)
}

export function writeComposerHeight(value: number): Promise<void> {
  return writeGlobalPreference(COMPOSER_HEIGHT_KEY, Math.min(600, Math.max(80, Math.round(value))))
}

export function writeComposerManualHeight(
  variant: 'normal' | 'focus',
  value: number | null,
): Promise<void> {
  const key =
    variant === 'normal' ? COMPOSER_NORMAL_MANUAL_HEIGHT_KEY : COMPOSER_FOCUS_MANUAL_HEIGHT_KEY
  const normalized = value === null ? null : Math.min(600, Math.max(1, Math.round(value)))
  return writeGlobalPreference(key, normalized)
}

async function writeGlobalPreference(key: string, value: unknown): Promise<void> {
  await configurationApplication.execute({
    kind: 'global-preference.set',
    key,
    value,
    now: Date.now(),
  })
}

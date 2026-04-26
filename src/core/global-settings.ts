// Global (app-wide) preferences. Distinct from per-chat settings (which live
// on `Chat.settings` / `ChatPreset.settings`) and from connection-profile
// settings (creds + endpoint, on `ConnectionProfile`). See plan/02-data-model.md
// §2.5 for the precedence picture.
//
// Everything here is keyed under the `settings` IDB table via the existing
// `getSetting/setSetting` helpers. We expose typed read/write wrappers so call
// sites don't have to remember the key names.

import { getSetting, setSetting } from '../store/settings'

export type ThemePreference = 'system' | 'light' | 'dark' | 'high-contrast'

export type SendShortcut = 'enter' | 'cmd-enter'

// Profile pictures for the user / assistant glyphs in the message gutter.
// Built-in: a generic person silhouette and a robot silhouette. Custom
// values (uploaded image / data URL) lands in a follow-up; for now the
// type allows the literal slot but the UI only renders the built-ins.
export type ProfilePictureRef = 'default-person' | 'default-robot'

// Maximum width of the centered chat reading column. Stored as a number
// of CSS pixels, or the literal string `'full'` for no cap (the column
// spans the entire main pane). Applied via `--message-max-width`.
export type ChatMaxWidth = number | 'full'

// Font family preference — applied globally via `--font-sans` on
// :root. `'system'` defers to the OS's native UI font; the other
// values pick a common webfont stack shipped with the OS.
export type FontFamilyChoice = 'system' | 'sans-serif' | 'serif' | 'monospace' | 'inter' | 'georgia'

// Base body font-size in CSS pixels, driving `--font-size-md`. Other
// typographic tokens scale relative to the base so bumping this lifts
// headers and chips too.
export type BaseFontSize = 13 | 14 | 15 | 16 | 17 | 18

// Which tier of the chars-per-token calibration ladder to use at
// estimate time. Controls `charsPerToken()` in `core/token-calibration.ts`.
//
//   - 'adaptive' (default): per-chat → global → family anchor. The
//     learning pipeline runs as designed.
//   - 'global-only': skip per-chat even if samples exist; use the
//     cross-workspace global rollup. Useful if the user doesn't trust
//     their own chat's drift.
//   - 'family-defaults-only': ignore learned calibration entirely; use
//     the per-family anchor from RATIO_BOUNDS. Useful if something went
//     wrong with calibration and the user wants a known baseline.
//
// Sample ingestion still runs regardless — the toggle only affects
// consumption. Users can flip back to 'adaptive' later and their
// accumulated samples are still there.
export type TokenCalibrationMode = 'adaptive' | 'global-only' | 'family-defaults-only'

export type LongMessageDisplayMode = 'full' | 'compact'

// Continue prompts injected by Continue-in-place (see `src/hooks/useContinue.ts`).
// The actual prompts live on `chat.settings.continueSystemPrompt` /
// `continueUserPrompt` (per-chat, preset-pinnable). These constants remain
// the seed defaults for new chats and the reset-to-default target.
//
// `continueSystemPrompt` is a template. `[SYSTEM_PROMPT]` expands to the
// original chat system prompt verbatim; if the placeholder is absent, the
// original system prompt is not appended automatically.
// `continueUserPrompt` is appended as a synthetic trailing user turn when
// non-empty; blank falls back to the legacy double-assistant shape.
export const CONTINUE_SYSTEM_PROMPT_PLACEHOLDER = '[SYSTEM_PROMPT]'
export const DEFAULT_CONTINUE_SYSTEM_PROMPT =
  'Continue the chat from the last assistant message. The last assistant message is incomplete. Output only the continuation. Do not repeat prior content, do not add filler text, and do not restate the user question.\n\nThe original system prompt (for reference):\n```\n[SYSTEM_PROMPT]\n```'
export const DEFAULT_CONTINUE_USER_PROMPT =
  'Now please generate only the continuation of the last message, with zero filler text.'

export function resolveContinueSystemPromptTemplate(
  template: string,
  originalSystemPrompt: string,
): string {
  if (template.trim().length === 0) return ''
  return template.split(CONTINUE_SYSTEM_PROMPT_PLACEHOLDER).join(originalSystemPrompt)
}

export interface GlobalPreferences {
  theme: ThemePreference
  sendShortcut: SendShortcut
  userProfilePicture: ProfilePictureRef
  assistantProfilePicture: ProfilePictureRef
  chatMaxWidth: ChatMaxWidth
  fontFamily: FontFamilyChoice
  baseFontSize: BaseFontSize
  // Workspace-wide pinned model ids. Model picker shows these at the top.
  // Seeded with sane defaults on first read; the user can pin/unpin any
  // model and reorder pins.
  pinnedModels: string[]
  // Most-recently-used model ids (most-recent first). Drives the Recent
  // list in the picker. Capped at 20 entries.
  recentModels: string[]
  // Jump to the bottom when a chat opens. When false, the scroll
  // position starts wherever the browser's default places it (top
  // for fresh mounts). Independent of `autoScrollOnStream` so you
  // can, e.g., always land at the bottom on open but not get yanked
  // while reading mid-stream.
  autoScrollOnOpen: boolean
  // Pull the viewport down as new tokens arrive during a live stream.
  // Only applies while the ScrollRegion is in `follow` state (the
  // sentinel is visible); scrolling up into `pinned` always stops
  // the yank regardless of this flag.
  autoScrollOnStream: boolean
  // Which tier of the chars-per-token calibration ladder to consume at
  // estimate time. Ingest is unaffected — samples keep accumulating.
  tokenCalibrationMode: TokenCalibrationMode
  // Default rendering mode for long/oversized messages when a row mounts
  // or reloads. Manual avatar clicks stay session-local.
  longMessageDisplayMode: LongMessageDisplayMode
}

export const DEFAULT_PINNED_MODELS: readonly string[] = Object.freeze([
  'openai/gpt-5.4',
  'anthropic/claude-opus-4.7',
  'deepseek/deepseek-v4-pro',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-flash-lite-preview',
])

export const DEFAULT_GLOBAL_PREFERENCES: Readonly<GlobalPreferences> = Object.freeze({
  theme: 'system',
  sendShortcut: 'enter',
  userProfilePicture: 'default-person',
  assistantProfilePicture: 'default-robot',
  chatMaxWidth: 920,
  fontFamily: 'system',
  baseFontSize: 15,
  autoScrollOnOpen: true,
  autoScrollOnStream: true,
  pinnedModels: [...DEFAULT_PINNED_MODELS],
  recentModels: [],
  tokenCalibrationMode: 'adaptive',
  longMessageDisplayMode: 'full',
})

const THEME_KEY = 'global:theme'
const SEND_SHORTCUT_KEY = 'global:send-shortcut'
const USER_PIC_KEY = 'global:user-profile-picture'
const ASSISTANT_PIC_KEY = 'global:assistant-profile-picture'
const CHAT_MAX_WIDTH_KEY = 'global:chat-max-width'
const FONT_FAMILY_KEY = 'global:font-family'
const BASE_FONT_SIZE_KEY = 'global:base-font-size'
const AUTO_SCROLL_OPEN_KEY = 'global:auto-scroll-open'
const AUTO_SCROLL_STREAM_KEY = 'global:auto-scroll-stream'
const PINNED_MODELS_KEY = 'global:pinned-models'
const RECENT_MODELS_KEY = 'global:recent-models'
const TOKEN_CALIBRATION_MODE_KEY = 'global:token-calibration-mode'
const LONG_MESSAGE_DISPLAY_MODE_KEY = 'global:long-message-display-mode'
// Legacy single-flag key — used for migration so existing installs
// don't suddenly flip to the default. Read on boot, split into the
// two new keys, then retired.
const LEGACY_AUTO_SCROLL_KEY = 'global:auto-scroll'

export const FONT_FAMILY_OPTIONS: ReadonlyArray<{
  value: FontFamilyChoice
  label: string
  stack: string
}> = [
  {
    value: 'system',
    label: 'System',
    stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
  },
  {
    value: 'sans-serif',
    label: 'Sans-serif (Helvetica / Arial)',
    stack: 'Helvetica, Arial, sans-serif',
  },
  {
    value: 'serif',
    label: 'Serif (Times / Charter)',
    stack: 'Charter, Georgia, "Times New Roman", Times, serif',
  },
  {
    value: 'monospace',
    label: 'Monospace (Menlo / Consolas)',
    stack: '"SF Mono", Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  {
    value: 'inter',
    label: 'Inter (if installed)',
    stack: '"Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  {
    value: 'georgia',
    label: 'Georgia',
    stack: 'Georgia, "Times New Roman", Times, serif',
  },
]

export const BASE_FONT_SIZE_OPTIONS: readonly BaseFontSize[] = [13, 14, 15, 16, 17, 18]

function fontFamilyOrDefault(value: unknown): FontFamilyChoice {
  const allowed = new Set(FONT_FAMILY_OPTIONS.map((f) => f.value))
  return allowed.has(value as FontFamilyChoice)
    ? (value as FontFamilyChoice)
    : DEFAULT_GLOBAL_PREFERENCES.fontFamily
}

function baseFontSizeOrDefault(value: unknown): BaseFontSize {
  return typeof value === 'number' && (BASE_FONT_SIZE_OPTIONS as readonly number[]).includes(value)
    ? (value as BaseFontSize)
    : DEFAULT_GLOBAL_PREFERENCES.baseFontSize
}

const ALLOWED_THEMES: readonly ThemePreference[] = ['system', 'light', 'dark', 'high-contrast']

const ALLOWED_SHORTCUTS: readonly SendShortcut[] = ['enter', 'cmd-enter']

const ALLOWED_PICTURES: readonly ProfilePictureRef[] = ['default-person', 'default-robot']

function pictureOrDefault(value: unknown, fallback: ProfilePictureRef): ProfilePictureRef {
  return ALLOWED_PICTURES.includes(value as ProfilePictureRef)
    ? (value as ProfilePictureRef)
    : fallback
}

export const CHAT_MAX_WIDTH_MIN = 640
export const CHAT_MAX_WIDTH_MAX_PX = 1600
export const CHAT_MAX_WIDTH_STEP = 20
export const CHAT_MAX_WIDTH_FULL_POSITION = CHAT_MAX_WIDTH_MAX_PX + CHAT_MAX_WIDTH_STEP

function chatMaxWidthOrDefault(value: unknown): ChatMaxWidth {
  if (value === 'full') return 'full'
  if (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CHAT_MAX_WIDTH_MIN &&
    value <= CHAT_MAX_WIDTH_MAX_PX
  ) {
    return value
  }
  return DEFAULT_GLOBAL_PREFERENCES.chatMaxWidth
}

export const CHAT_MAX_WIDTH_OPTIONS: readonly ChatMaxWidth[] = [
  640,
  720,
  840,
  920,
  1040,
  1200,
  1440,
  'full',
]

const ALLOWED_CALIBRATION_MODES: readonly TokenCalibrationMode[] = [
  'adaptive',
  'global-only',
  'family-defaults-only',
]

function calibrationModeOrDefault(value: unknown): TokenCalibrationMode {
  return ALLOWED_CALIBRATION_MODES.includes(value as TokenCalibrationMode)
    ? (value as TokenCalibrationMode)
    : DEFAULT_GLOBAL_PREFERENCES.tokenCalibrationMode
}

const ALLOWED_LONG_MESSAGE_DISPLAY_MODES: readonly LongMessageDisplayMode[] = ['full', 'compact']

function longMessageDisplayModeOrDefault(value: unknown): LongMessageDisplayMode {
  return ALLOWED_LONG_MESSAGE_DISPLAY_MODES.includes(value as LongMessageDisplayMode)
    ? (value as LongMessageDisplayMode)
    : DEFAULT_GLOBAL_PREFERENCES.longMessageDisplayMode
}

export async function readGlobalPreferences(): Promise<GlobalPreferences> {
  const [
    theme,
    sendShortcut,
    userPic,
    asstPic,
    chatMaxWidth,
    fontFamily,
    baseFontSize,
    autoScrollOpen,
    autoScrollStream,
    legacyAutoScroll,
    pinned,
    recent,
    tokenCalibrationMode,
    longMessageDisplayMode,
  ] = await Promise.all([
    getSetting<ThemePreference>(THEME_KEY),
    getSetting<SendShortcut>(SEND_SHORTCUT_KEY),
    getSetting<ProfilePictureRef>(USER_PIC_KEY),
    getSetting<ProfilePictureRef>(ASSISTANT_PIC_KEY),
    getSetting<ChatMaxWidth>(CHAT_MAX_WIDTH_KEY),
    getSetting<FontFamilyChoice>(FONT_FAMILY_KEY),
    getSetting<BaseFontSize>(BASE_FONT_SIZE_KEY),
    getSetting<boolean>(AUTO_SCROLL_OPEN_KEY),
    getSetting<boolean>(AUTO_SCROLL_STREAM_KEY),
    getSetting<boolean>(LEGACY_AUTO_SCROLL_KEY),
    getSetting<string[]>(PINNED_MODELS_KEY),
    getSetting<string[]>(RECENT_MODELS_KEY),
    getSetting<TokenCalibrationMode>(TOKEN_CALIBRATION_MODE_KEY),
    getSetting<LongMessageDisplayMode>(LONG_MESSAGE_DISPLAY_MODE_KEY),
  ])
  return {
    theme: ALLOWED_THEMES.includes(theme as ThemePreference)
      ? (theme as ThemePreference)
      : DEFAULT_GLOBAL_PREFERENCES.theme,
    sendShortcut: ALLOWED_SHORTCUTS.includes(sendShortcut as SendShortcut)
      ? (sendShortcut as SendShortcut)
      : DEFAULT_GLOBAL_PREFERENCES.sendShortcut,
    userProfilePicture: pictureOrDefault(userPic, DEFAULT_GLOBAL_PREFERENCES.userProfilePicture),
    assistantProfilePicture: pictureOrDefault(
      asstPic,
      DEFAULT_GLOBAL_PREFERENCES.assistantProfilePicture,
    ),
    chatMaxWidth: chatMaxWidthOrDefault(chatMaxWidth),
    fontFamily: fontFamilyOrDefault(fontFamily),
    baseFontSize: baseFontSizeOrDefault(baseFontSize),
    autoScrollOnOpen:
      typeof autoScrollOpen === 'boolean'
        ? autoScrollOpen
        : typeof legacyAutoScroll === 'boolean'
          ? legacyAutoScroll
          : DEFAULT_GLOBAL_PREFERENCES.autoScrollOnOpen,
    autoScrollOnStream:
      typeof autoScrollStream === 'boolean'
        ? autoScrollStream
        : typeof legacyAutoScroll === 'boolean'
          ? legacyAutoScroll
          : DEFAULT_GLOBAL_PREFERENCES.autoScrollOnStream,
    pinnedModels: Array.isArray(pinned)
      ? pinned.filter((x) => typeof x === 'string')
      : [...DEFAULT_PINNED_MODELS],
    recentModels: Array.isArray(recent) ? recent.filter((x) => typeof x === 'string') : [],
    tokenCalibrationMode: calibrationModeOrDefault(tokenCalibrationMode),
    longMessageDisplayMode: longMessageDisplayModeOrDefault(longMessageDisplayMode),
  }
}

export async function writeLongMessageDisplayMode(value: LongMessageDisplayMode): Promise<void> {
  await setSetting(LONG_MESSAGE_DISPLAY_MODE_KEY, value)
}

export async function writeTokenCalibrationMode(value: TokenCalibrationMode): Promise<void> {
  await setSetting(TOKEN_CALIBRATION_MODE_KEY, value)
}

export async function writePinnedModels(value: readonly string[]): Promise<void> {
  await setSetting(PINNED_MODELS_KEY, [...value])
}

export async function writeRecentModels(value: readonly string[]): Promise<void> {
  await setSetting(RECENT_MODELS_KEY, [...value])
}

// Move `modelId` to the head of the recent-models list, deduped, capped at
// 20 entries. Used by the send pipeline to keep the picker's Recent tab
// ordered by actual usage.
export async function bumpRecentModel(modelId: string): Promise<void> {
  if (!modelId) return
  const current = (await readGlobalPreferences()).recentModels
  const deduped = current.filter((id) => id !== modelId)
  deduped.unshift(modelId)
  await writeRecentModels(deduped.slice(0, 20))
}

export async function writeTheme(theme: ThemePreference): Promise<void> {
  await setSetting(THEME_KEY, theme)
}

export async function writeSendShortcut(value: SendShortcut): Promise<void> {
  await setSetting(SEND_SHORTCUT_KEY, value)
}

export async function writeUserProfilePicture(value: ProfilePictureRef): Promise<void> {
  await setSetting(USER_PIC_KEY, value)
}

export async function writeAssistantProfilePicture(value: ProfilePictureRef): Promise<void> {
  await setSetting(ASSISTANT_PIC_KEY, value)
}

export async function writeChatMaxWidth(value: ChatMaxWidth): Promise<void> {
  await setSetting(CHAT_MAX_WIDTH_KEY, value)
}

export async function writeFontFamily(value: FontFamilyChoice): Promise<void> {
  await setSetting(FONT_FAMILY_KEY, value)
}

export async function writeBaseFontSize(value: BaseFontSize): Promise<void> {
  await setSetting(BASE_FONT_SIZE_KEY, value)
}

export async function writeAutoScrollOnOpen(value: boolean): Promise<void> {
  await setSetting(AUTO_SCROLL_OPEN_KEY, value)
}

export async function writeAutoScrollOnStream(value: boolean): Promise<void> {
  await setSetting(AUTO_SCROLL_STREAM_KEY, value)
}

// Apply the font-family preference by swapping the `--font-sans` CSS
// variable on :root. Stacks are looked up in FONT_FAMILY_OPTIONS so
// the token keeps the same `system-ui, …` fallback chain when the
// user's preferred font isn't installed.
export function applyFontFamilyToDocument(value: FontFamilyChoice): void {
  if (typeof document === 'undefined') return
  const match = FONT_FAMILY_OPTIONS.find((f) => f.value === value)
  const stack = match?.stack ?? FONT_FAMILY_OPTIONS[0]?.stack ?? ''
  document.documentElement.style.setProperty('--font-sans', stack)
}

// Apply the base font-size pref — drives `--font-size-md` on :root.
// Other typographic tokens scale off md so lifting md cascades.
export function applyBaseFontSizeToDocument(value: BaseFontSize): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--font-size-md', `${value}px`)
}

// Apply the chat-max-width preference by setting `--message-max-width`
// on :root. `'full'` clears the cap (the column spans the available
// main-pane width via a very large value).
export function applyChatMaxWidthToDocument(value: ChatMaxWidth): void {
  if (typeof document === 'undefined') return
  const cssValue = value === 'full' ? '100%' : `${value}px`
  document.documentElement.style.setProperty('--message-max-width', cssValue)
}

// Apply a theme preference to the DOM. `system` removes the data-theme attr
// so the user agent's `prefers-color-scheme` media-query takes over.
export function applyThemeToDocument(theme: ThemePreference): void {
  if (typeof document === 'undefined') return
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}

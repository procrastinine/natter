// Global (app-wide) preferences. Distinct from per-chat settings (which live
// on `Chat.settings` / `ChatPreset.settings`) and from connection-profile
// settings (creds + endpoint, on `ConnectionProfile`). See plan/02-data-model.md
// §2.5 for the precedence picture.
//
// Everything here is keyed under the `settings` IDB table via the existing
// `getSetting/setSetting` helpers. Typed read/write wrappers are exposed so
// call sites don't have to remember the key names.

import { getSetting, setSetting } from '../store/settings'
import { DEFAULT_CORS_PROXY_URL, type CorsProxyConfig, DEV_CORS_PROXY_URL } from './cors-proxy'

export { DEV_CORS_PROXY_URL }

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
//     cross-workspace global rollup. Useful when the user doesn't trust
//     a single chat's drift.
//   - 'family-defaults-only': ignore learned calibration entirely; use
//     the per-family anchor from RATIO_BOUNDS. Useful when calibration
//     misbehaves and a known baseline is preferred.
//
// Sample ingestion still runs regardless — the toggle only affects
// consumption. Flipping back to 'adaptive' later resumes use of the
// accumulated samples, which are still there.
export type TokenCalibrationMode = 'adaptive' | 'global-only' | 'family-defaults-only'

export type LongMessageDisplayMode = 'full' | 'compact'

export type RenderWindowLoadMode = 'auto' | 'manual'

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

interface GlobalPreferences {
  theme: ThemePreference
  sendShortcut: SendShortcut
  userProfilePicture: ProfilePictureRef
  assistantProfilePicture: ProfilePictureRef
  chatMaxWidth: ChatMaxWidth
  fontFamily: FontFamilyChoice
  baseFontSize: BaseFontSize
  // Workspace-wide pinned model ids. Model picker shows these at the top.
  // Seeded with sane defaults on first read; users can pin/unpin any
  // model and reorder pins.
  pinnedModels: string[]
  // Most-recently-used model ids (most-recent first). Drives the Recent
  // list in the picker. Capped at 20 entries.
  recentModels: string[]
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
  // Render-window sizes bound expensive DOM work for long transcripts and
  // large sidebars. The full active branch/sidebar model can still exist in
  // memory, but React only mounts this many rows before incremental expansion.
  messageRenderWindowSize: number
  sidebarRenderWindowSize: number
  messageRenderWindowLoadMode: RenderWindowLoadMode
  sidebarRenderWindowLoadMode: RenderWindowLoadMode
  // CORS-proxy base URL prefixed in front of `/{model}/providers` for the
  // privacy scrape. Empty string uses the runtime default: `/_or_scrape`
  // under Vite dev, no live scrape in static builds.
  corsProxyUrl: string
  // Optional secret echoed as `X-Proxy-Secret` so a hosted bouncer can
  // gatekeep its open relay. Empty string = header omitted.
  corsProxySecret: string
}

export const DEFAULT_PINNED_MODELS: readonly string[] = Object.freeze([
  'openai/gpt-5.4',
  'anthropic/claude-opus-4.7',
  'deepseek/deepseek-v4-pro',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.1-flash-lite-preview',
])

export function defaultCorsProxyUrlForRuntime(isDev = import.meta.env.DEV): string {
  return isDev ? DEV_CORS_PROXY_URL : DEFAULT_CORS_PROXY_URL
}

export const DEFAULT_GLOBAL_PREFERENCES: Readonly<GlobalPreferences> = Object.freeze({
  theme: 'system',
  sendShortcut: 'enter',
  userProfilePicture: 'default-person',
  assistantProfilePicture: 'default-robot',
  chatMaxWidth: 920,
  fontFamily: 'system',
  baseFontSize: 15,
  autoScrollOnStream: true,
  pinnedModels: [...DEFAULT_PINNED_MODELS],
  recentModels: [],
  tokenCalibrationMode: 'adaptive',
  longMessageDisplayMode: 'full',
  messageRenderWindowSize: 10,
  sidebarRenderWindowSize: 50,
  messageRenderWindowLoadMode: 'auto',
  sidebarRenderWindowLoadMode: 'auto',
  corsProxyUrl: defaultCorsProxyUrlForRuntime(),
  corsProxySecret: '',
})

export const MESSAGE_RENDER_WINDOW_SIZE_MIN = 1
export const MESSAGE_RENDER_WINDOW_SIZE_MAX = 500
export const SIDEBAR_RENDER_WINDOW_SIZE_MIN = 1
export const SIDEBAR_RENDER_WINDOW_SIZE_MAX = 1000

const THEME_KEY = 'global:theme'
const SEND_SHORTCUT_KEY = 'global:send-shortcut'
const USER_PIC_KEY = 'global:user-profile-picture'
const ASSISTANT_PIC_KEY = 'global:assistant-profile-picture'
const CHAT_MAX_WIDTH_KEY = 'global:chat-max-width'
const FONT_FAMILY_KEY = 'global:font-family'
const BASE_FONT_SIZE_KEY = 'global:base-font-size'
const AUTO_SCROLL_STREAM_KEY = 'global:auto-scroll-stream'
const PINNED_MODELS_KEY = 'global:pinned-models'
const RECENT_MODELS_KEY = 'global:recent-models'
const TOKEN_CALIBRATION_MODE_KEY = 'global:token-calibration-mode'
const LONG_MESSAGE_DISPLAY_MODE_KEY = 'global:long-message-display-mode'
const MESSAGE_RENDER_WINDOW_SIZE_KEY = 'global:message-render-window-size'
const SIDEBAR_RENDER_WINDOW_SIZE_KEY = 'global:sidebar-render-window-size'
const MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY = 'global:message-render-window-load-mode'
const SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY = 'global:sidebar-render-window-load-mode'
const CORS_PROXY_URL_KEY = 'global:cors-proxy-url'
const CORS_PROXY_SECRET_KEY = 'global:cors-proxy-secret'

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

const ALLOWED_RENDER_WINDOW_LOAD_MODES: readonly RenderWindowLoadMode[] = ['auto', 'manual']

function renderWindowLoadModeOrDefault(
  value: unknown,
  fallback: RenderWindowLoadMode,
): RenderWindowLoadMode {
  return ALLOWED_RENDER_WINDOW_LOAD_MODES.includes(value as RenderWindowLoadMode)
    ? (value as RenderWindowLoadMode)
    : fallback
}

function intInRangeOrDefault(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
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
    autoScrollStream,
    pinned,
    recent,
    tokenCalibrationMode,
    longMessageDisplayMode,
    messageRenderWindowSize,
    sidebarRenderWindowSize,
    messageRenderWindowLoadMode,
    sidebarRenderWindowLoadMode,
    corsProxyUrl,
    corsProxySecret,
  ] = await Promise.all([
    getSetting<ThemePreference>(THEME_KEY),
    getSetting<SendShortcut>(SEND_SHORTCUT_KEY),
    getSetting<ProfilePictureRef>(USER_PIC_KEY),
    getSetting<ProfilePictureRef>(ASSISTANT_PIC_KEY),
    getSetting<ChatMaxWidth>(CHAT_MAX_WIDTH_KEY),
    getSetting<FontFamilyChoice>(FONT_FAMILY_KEY),
    getSetting<BaseFontSize>(BASE_FONT_SIZE_KEY),
    getSetting<boolean>(AUTO_SCROLL_STREAM_KEY),
    getSetting<string[]>(PINNED_MODELS_KEY),
    getSetting<string[]>(RECENT_MODELS_KEY),
    getSetting<TokenCalibrationMode>(TOKEN_CALIBRATION_MODE_KEY),
    getSetting<LongMessageDisplayMode>(LONG_MESSAGE_DISPLAY_MODE_KEY),
    getSetting<number>(MESSAGE_RENDER_WINDOW_SIZE_KEY),
    getSetting<number>(SIDEBAR_RENDER_WINDOW_SIZE_KEY),
    getSetting<RenderWindowLoadMode>(MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY),
    getSetting<RenderWindowLoadMode>(SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY),
    getSetting<string>(CORS_PROXY_URL_KEY),
    getSetting<string>(CORS_PROXY_SECRET_KEY),
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
    autoScrollOnStream:
      typeof autoScrollStream === 'boolean'
        ? autoScrollStream
        : DEFAULT_GLOBAL_PREFERENCES.autoScrollOnStream,
    pinnedModels: Array.isArray(pinned)
      ? pinned.filter((x) => typeof x === 'string')
      : [...DEFAULT_PINNED_MODELS],
    recentModels: Array.isArray(recent) ? recent.filter((x) => typeof x === 'string') : [],
    tokenCalibrationMode: calibrationModeOrDefault(tokenCalibrationMode),
    longMessageDisplayMode: longMessageDisplayModeOrDefault(longMessageDisplayMode),
    messageRenderWindowSize: intInRangeOrDefault(
      messageRenderWindowSize,
      DEFAULT_GLOBAL_PREFERENCES.messageRenderWindowSize,
      MESSAGE_RENDER_WINDOW_SIZE_MIN,
      MESSAGE_RENDER_WINDOW_SIZE_MAX,
    ),
    sidebarRenderWindowSize: intInRangeOrDefault(
      sidebarRenderWindowSize,
      DEFAULT_GLOBAL_PREFERENCES.sidebarRenderWindowSize,
      SIDEBAR_RENDER_WINDOW_SIZE_MIN,
      SIDEBAR_RENDER_WINDOW_SIZE_MAX,
    ),
    messageRenderWindowLoadMode: renderWindowLoadModeOrDefault(
      messageRenderWindowLoadMode,
      DEFAULT_GLOBAL_PREFERENCES.messageRenderWindowLoadMode,
    ),
    sidebarRenderWindowLoadMode: renderWindowLoadModeOrDefault(
      sidebarRenderWindowLoadMode,
      DEFAULT_GLOBAL_PREFERENCES.sidebarRenderWindowLoadMode,
    ),
    corsProxyUrl: typeof corsProxyUrl === 'string' ? corsProxyUrl : defaultCorsProxyUrlForRuntime(),
    corsProxySecret: typeof corsProxySecret === 'string' ? corsProxySecret : '',
  }
}

export function corsProxyConfigFromPrefs(prefs: GlobalPreferences): CorsProxyConfig {
  const trimmed = prefs.corsProxyUrl.trim().replace(/\/+$/, '')
  return {
    url: trimmed.length > 0 ? trimmed : defaultCorsProxyUrlForRuntime(),
    secret: prefs.corsProxySecret,
  }
}

export async function writeCorsProxyUrl(value: string): Promise<void> {
  await setSetting(CORS_PROXY_URL_KEY, value)
}

export async function writeCorsProxySecret(value: string): Promise<void> {
  await setSetting(CORS_PROXY_SECRET_KEY, value)
}

export async function writeLongMessageDisplayMode(value: LongMessageDisplayMode): Promise<void> {
  await setSetting(LONG_MESSAGE_DISPLAY_MODE_KEY, value)
}

export async function writeMessageRenderWindowSize(value: number): Promise<void> {
  await setSetting(
    MESSAGE_RENDER_WINDOW_SIZE_KEY,
    clampInt(value, MESSAGE_RENDER_WINDOW_SIZE_MIN, MESSAGE_RENDER_WINDOW_SIZE_MAX),
  )
}

export async function writeSidebarRenderWindowSize(value: number): Promise<void> {
  await setSetting(
    SIDEBAR_RENDER_WINDOW_SIZE_KEY,
    clampInt(value, SIDEBAR_RENDER_WINDOW_SIZE_MIN, SIDEBAR_RENDER_WINDOW_SIZE_MAX),
  )
}

export async function writeMessageRenderWindowLoadMode(value: RenderWindowLoadMode): Promise<void> {
  await setSetting(MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY, value)
}

export async function writeSidebarRenderWindowLoadMode(value: RenderWindowLoadMode): Promise<void> {
  await setSetting(SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY, value)
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

export async function writeChatMaxWidth(value: ChatMaxWidth): Promise<void> {
  await setSetting(CHAT_MAX_WIDTH_KEY, value)
}

export async function writeFontFamily(value: FontFamilyChoice): Promise<void> {
  await setSetting(FONT_FAMILY_KEY, value)
}

export async function writeBaseFontSize(value: BaseFontSize): Promise<void> {
  await setSetting(BASE_FONT_SIZE_KEY, value)
}

export async function writeAutoScrollOnStream(value: boolean): Promise<void> {
  await setSetting(AUTO_SCROLL_STREAM_KEY, value)
}

// Apply the font-family preference by swapping the `--font-sans` CSS
// variable on :root. Stacks are looked up in FONT_FAMILY_OPTIONS so
// the token keeps the same `system-ui, …` fallback chain when the
// preferred font isn't installed.
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

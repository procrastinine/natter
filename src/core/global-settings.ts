// Global (app-wide) preferences. Distinct from per-chat settings (which live
// on `Chat.settings` / `ChatPreset.settings`) and from connection-profile
// settings (credentials and endpoint, on `ConnectionProfile`).
//
// This module owns only the schema, defaults, normalization and document
// projection. Persisted reads/writes live behind the workspace store boundary.

import { type CorsProxyConfig, DEFAULT_CORS_PROXY_URL, DEV_CORS_PROXY_URL } from './cors-proxy'
import { LATEST_OPENROUTER_MODEL_IDS } from './latest-models'
import { DEFAULT_TRANSCRIPT_INITIAL_ROW_COUNT } from './transcript-work-budget'

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

// Continue prompts injected by the unified generation engine.
// The actual prompts live on `chat.settings.continueSystemPrompt` /
// `continueUserPrompt` (per-chat, preset-pinnable). These constants remain
// the seed defaults for new chats and the reset-to-default target.
//
// `continueSystemPrompt` is a template. `[SYSTEM_PROMPT]` expands to the
// original chat system prompt verbatim; if the placeholder is absent, the
// original system prompt is not appended automatically.
// `continueUserPrompt` is appended as a synthetic trailing user turn when
// non-empty; blank falls back to the legacy double-assistant shape.
export interface GlobalPreferences {
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
  // Relative initial transcript work target. Durable body-cost projections
  // and viewport overscan decide the actual row suffix; this value never caps
  // branch length or reachability.
  messageInitialRenderWork: number
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
  // Durable defaults for a newly mounted tab. The live sidebar/composer
  // presentation remains tab-local after these values seed it.
  sidebarCollapsed: boolean
  composerHeight: number
  composerNormalManualHeight: number | null
  composerFocusManualHeight: number | null
}

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
  pinnedModels: [...LATEST_OPENROUTER_MODEL_IDS],
  recentModels: [],
  tokenCalibrationMode: 'adaptive',
  longMessageDisplayMode: 'full',
  messageInitialRenderWork: DEFAULT_TRANSCRIPT_INITIAL_ROW_COUNT,
  sidebarRenderWindowSize: 50,
  messageRenderWindowLoadMode: 'auto',
  sidebarRenderWindowLoadMode: 'auto',
  corsProxyUrl: defaultCorsProxyUrlForRuntime(),
  corsProxySecret: '',
  sidebarCollapsed: false,
  composerHeight: 120,
  composerNormalManualHeight: null,
  composerFocusManualHeight: null,
})

export const MESSAGE_INITIAL_RENDER_WORK_MIN = 1
export const MESSAGE_INITIAL_RENDER_WORK_MAX = 500
export const SIDEBAR_RENDER_WINDOW_SIZE_MIN = 1
export const SIDEBAR_RENDER_WINDOW_SIZE_MAX = 1000

export const THEME_KEY = 'global:theme'
export const SEND_SHORTCUT_KEY = 'global:send-shortcut'
const USER_PIC_KEY = 'global:user-profile-picture'
const ASSISTANT_PIC_KEY = 'global:assistant-profile-picture'
export const CHAT_MAX_WIDTH_KEY = 'global:chat-max-width'
export const FONT_FAMILY_KEY = 'global:font-family'
export const BASE_FONT_SIZE_KEY = 'global:base-font-size'
export const AUTO_SCROLL_STREAM_KEY = 'global:auto-scroll-stream'
export const PINNED_MODELS_KEY = 'global:pinned-models'
export const RECENT_MODELS_KEY = 'global:recent-models'
export const RECENT_MODEL_RECENCY_KEY = 'global:recent-model-recency-v1'
export const RECENT_MODEL_LIMIT = 20

export interface RecentModelRecencyEntry {
  modelId: string
  usedAt: number
  streamId: string
}

export interface RecentModelRecencyRecord {
  version: 1
  entries: RecentModelRecencyEntry[]
}

export interface RecentModelState {
  changed: boolean
  models: string[]
  recency: RecentModelRecencyRecord
}

export function emptyRecentModelRecency(): RecentModelRecencyRecord {
  return { version: 1, entries: [] }
}

export function normalizeRecentModels(value: unknown, limit = RECENT_MODEL_LIMIT): string[] {
  if (!Array.isArray(value)) return []
  const boundedLimit = boundedRecentModelLimit(limit)
  if (boundedLimit === 0) return []
  const seen = new Set<string>()
  const models: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
    seen.add(item)
    models.push(item)
    if (models.length === boundedLimit) break
  }
  return models
}

export function normalizeRecentModelRecency(value: unknown): RecentModelRecencyRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Partial<RecentModelRecencyRecord>
  if (record.version !== 1 || !Array.isArray(record.entries)) return undefined
  const byModel = new Map<string, RecentModelRecencyEntry>()
  for (const candidate of record.entries) {
    if (
      typeof candidate.modelId !== 'string' ||
      candidate.modelId.length === 0 ||
      typeof candidate.streamId !== 'string' ||
      candidate.streamId.length === 0 ||
      !Number.isSafeInteger(candidate.usedAt) ||
      candidate.usedAt < 0
    ) {
      return undefined
    }
    const entry: RecentModelRecencyEntry = {
      modelId: candidate.modelId,
      usedAt: candidate.usedAt,
      streamId: candidate.streamId,
    }
    const existing = byModel.get(entry.modelId)
    if (!existing || compareRecentModelRecency(entry, existing) > 0) {
      byModel.set(entry.modelId, entry)
    }
  }
  return {
    version: 1,
    entries: [...byModel.values()]
      .sort((left, right) => compareRecentModelRecency(right, left))
      .slice(0, RECENT_MODEL_LIMIT),
  }
}

export function isCanonicalRecentModelState(publicValue: unknown, recencyValue: unknown): boolean {
  const models = normalizeRecentModels(publicValue)
  if (!sameStringArray(publicValue, models)) return false
  const recency = normalizeRecentModelRecency(recencyValue)
  return (
    recency !== undefined &&
    sameRecentModelRecency(recencyValue, recency) &&
    sameStringArray(
      models,
      recency.entries.map((entry) => entry.modelId),
    )
  )
}

export function advanceRecentModelState(
  publicValue: unknown,
  recencyValue: unknown,
  candidate: RecentModelRecencyEntry,
  limit = RECENT_MODEL_LIMIT,
): RecentModelState {
  if (!isCanonicalRecentModelState(publicValue, recencyValue)) {
    throw new Error('RecentModelStateInvariant')
  }
  if (
    typeof candidate.modelId !== 'string' ||
    candidate.modelId.length === 0 ||
    typeof candidate.streamId !== 'string' ||
    candidate.streamId.length === 0 ||
    !Number.isSafeInteger(candidate.usedAt) ||
    candidate.usedAt < 0
  ) {
    throw new Error('RecentModelRecencyCandidateInvalid')
  }
  const currentModels = publicValue as string[]
  const currentRecency = recencyValue as RecentModelRecencyRecord
  const byModel = new Map(
    currentRecency.entries.map((entry) => [entry.modelId, { ...entry }] as const),
  )
  const existing = byModel.get(candidate.modelId)
  if (!existing || compareRecentModelRecency(candidate, existing) > 0) {
    byModel.set(candidate.modelId, { ...candidate })
  }
  const entries = [...byModel.values()]
    .sort((left, right) => compareRecentModelRecency(right, left))
    .slice(0, boundedRecentModelLimit(limit))
  const recency: RecentModelRecencyRecord = { version: 1, entries }
  const models = entries.map((entry) => entry.modelId)
  return {
    changed:
      !sameStringArray(currentModels, models) || !sameRecentModelRecency(currentRecency, recency),
    models,
    recency,
  }
}

function boundedRecentModelLimit(value: number): number {
  if (!Number.isFinite(value)) return RECENT_MODEL_LIMIT
  return Math.min(RECENT_MODEL_LIMIT, Math.max(0, Math.trunc(value)))
}

function compareRecentModelRecency(
  left: Pick<RecentModelRecencyEntry, 'usedAt' | 'streamId'>,
  right: Pick<RecentModelRecencyEntry, 'usedAt' | 'streamId'>,
): number {
  if (left.usedAt !== right.usedAt) return left.usedAt - right.usedAt
  if (left.streamId === right.streamId) return 0
  return left.streamId < right.streamId ? -1 : 1
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  )
}

function sameRecentModelRecency(value: unknown, expected: RecentModelRecencyRecord): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<RecentModelRecencyRecord>
  return (
    record.version === expected.version &&
    Array.isArray(record.entries) &&
    record.entries.length === expected.entries.length &&
    record.entries.every((entry, index) => {
      const expectedEntry = expected.entries.at(index)
      if (!expectedEntry) return false
      return (
        entry.modelId === expectedEntry.modelId &&
        entry.usedAt === expectedEntry.usedAt &&
        entry.streamId === expectedEntry.streamId
      )
    })
  )
}
export const TOKEN_CALIBRATION_MODE_KEY = 'global:token-calibration-mode'
export const LONG_MESSAGE_DISPLAY_MODE_KEY = 'global:long-message-display-mode'
export const MESSAGE_INITIAL_RENDER_WORK_KEY = 'global:message-initial-render-work'
const LEGACY_MESSAGE_RENDER_WINDOW_SIZE_KEY = 'global:message-render-window-size'
export const SIDEBAR_RENDER_WINDOW_SIZE_KEY = 'global:sidebar-render-window-size'
export const MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY = 'global:message-render-window-load-mode'
export const SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY = 'global:sidebar-render-window-load-mode'
export const CORS_PROXY_URL_KEY = 'global:cors-proxy-url'
export const CORS_PROXY_SECRET_KEY = 'global:cors-proxy-secret'
export const SAMPLE_PROMPTS_DISMISSED_KEY = 'sample-prompts:dismissed'
export const SIDEBAR_COLLAPSED_KEY = 'global:sidebar-collapsed'
export const COMPOSER_HEIGHT_KEY = 'global:composer-height'
export const COMPOSER_NORMAL_MANUAL_HEIGHT_KEY = 'global:composer-normal-manual-height'
export const COMPOSER_FOCUS_MANUAL_HEIGHT_KEY = 'global:composer-focus-manual-height'

export const GENERATION_GLOBAL_PREFERENCE_KEYS = [
  TOKEN_CALIBRATION_MODE_KEY,
  CORS_PROXY_URL_KEY,
  CORS_PROXY_SECRET_KEY,
] as const

export const GLOBAL_PREFERENCE_KEYS = [
  THEME_KEY,
  SEND_SHORTCUT_KEY,
  USER_PIC_KEY,
  ASSISTANT_PIC_KEY,
  CHAT_MAX_WIDTH_KEY,
  FONT_FAMILY_KEY,
  BASE_FONT_SIZE_KEY,
  AUTO_SCROLL_STREAM_KEY,
  PINNED_MODELS_KEY,
  RECENT_MODELS_KEY,
  TOKEN_CALIBRATION_MODE_KEY,
  LONG_MESSAGE_DISPLAY_MODE_KEY,
  MESSAGE_INITIAL_RENDER_WORK_KEY,
  LEGACY_MESSAGE_RENDER_WINDOW_SIZE_KEY,
  SIDEBAR_RENDER_WINDOW_SIZE_KEY,
  MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY,
  SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY,
  CORS_PROXY_URL_KEY,
  CORS_PROXY_SECRET_KEY,
  SIDEBAR_COLLAPSED_KEY,
  COMPOSER_HEIGHT_KEY,
  COMPOSER_NORMAL_MANUAL_HEIGHT_KEY,
  COMPOSER_FOCUS_MANUAL_HEIGHT_KEY,
] as const

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

export function fontFamilyStack(value: FontFamilyChoice): string {
  return (
    FONT_FAMILY_OPTIONS.find((option) => option.value === value)?.stack ??
    FONT_FAMILY_OPTIONS[0]?.stack ??
    ''
  )
}

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

export function tokenCalibrationModeFromStored(value: unknown): TokenCalibrationMode {
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

export function clampGlobalPreferenceInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function globalPreferencesFromStored(
  stored: ReadonlyMap<string, unknown>,
): GlobalPreferences {
  const theme = stored.get(THEME_KEY)
  const sendShortcut = stored.get(SEND_SHORTCUT_KEY)
  const userPic = stored.get(USER_PIC_KEY)
  const asstPic = stored.get(ASSISTANT_PIC_KEY)
  const chatMaxWidth = stored.get(CHAT_MAX_WIDTH_KEY)
  const fontFamily = stored.get(FONT_FAMILY_KEY)
  const baseFontSize = stored.get(BASE_FONT_SIZE_KEY)
  const autoScrollStream = stored.get(AUTO_SCROLL_STREAM_KEY)
  const pinned = stored.get(PINNED_MODELS_KEY)
  const recent = stored.get(RECENT_MODELS_KEY)
  const tokenCalibrationMode = stored.get(TOKEN_CALIBRATION_MODE_KEY)
  const longMessageDisplayMode = stored.get(LONG_MESSAGE_DISPLAY_MODE_KEY)
  const messageInitialRenderWork =
    stored.get(MESSAGE_INITIAL_RENDER_WORK_KEY) ?? stored.get(LEGACY_MESSAGE_RENDER_WINDOW_SIZE_KEY)
  const sidebarRenderWindowSize = stored.get(SIDEBAR_RENDER_WINDOW_SIZE_KEY)
  const messageRenderWindowLoadMode = stored.get(MESSAGE_RENDER_WINDOW_LOAD_MODE_KEY)
  const sidebarRenderWindowLoadMode = stored.get(SIDEBAR_RENDER_WINDOW_LOAD_MODE_KEY)
  const corsProxyUrl = stored.get(CORS_PROXY_URL_KEY)
  const corsProxySecret = stored.get(CORS_PROXY_SECRET_KEY)
  const sidebarCollapsed = stored.get(SIDEBAR_COLLAPSED_KEY)
  const composerHeight = stored.get(COMPOSER_HEIGHT_KEY)
  const composerNormalManualHeight = stored.get(COMPOSER_NORMAL_MANUAL_HEIGHT_KEY)
  const composerFocusManualHeight = stored.get(COMPOSER_FOCUS_MANUAL_HEIGHT_KEY)
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
      : [...LATEST_OPENROUTER_MODEL_IDS],
    recentModels: Array.isArray(recent) ? recent.filter((x) => typeof x === 'string') : [],
    tokenCalibrationMode: tokenCalibrationModeFromStored(tokenCalibrationMode),
    longMessageDisplayMode: longMessageDisplayModeOrDefault(longMessageDisplayMode),
    messageInitialRenderWork: intInRangeOrDefault(
      messageInitialRenderWork,
      DEFAULT_GLOBAL_PREFERENCES.messageInitialRenderWork,
      MESSAGE_INITIAL_RENDER_WORK_MIN,
      MESSAGE_INITIAL_RENDER_WORK_MAX,
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
    sidebarCollapsed:
      typeof sidebarCollapsed === 'boolean'
        ? sidebarCollapsed
        : DEFAULT_GLOBAL_PREFERENCES.sidebarCollapsed,
    composerHeight: intInRangeOrDefault(
      composerHeight,
      DEFAULT_GLOBAL_PREFERENCES.composerHeight,
      80,
      600,
    ),
    composerNormalManualHeight: nullableIntInRangeOrDefault(
      composerNormalManualHeight,
      DEFAULT_GLOBAL_PREFERENCES.composerNormalManualHeight,
      1,
      600,
    ),
    composerFocusManualHeight: nullableIntInRangeOrDefault(
      composerFocusManualHeight,
      DEFAULT_GLOBAL_PREFERENCES.composerFocusManualHeight,
      1,
      600,
    ),
  }
}

function nullableIntInRangeOrDefault(
  value: unknown,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  if (value === null) return null
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback
}

export function corsProxyConfigFromPrefs(prefs: GlobalPreferences): CorsProxyConfig {
  const trimmed = prefs.corsProxyUrl.trim().replace(/\/+$/, '')
  return {
    url: trimmed.length > 0 ? trimmed : defaultCorsProxyUrlForRuntime(),
    secret: prefs.corsProxySecret,
  }
}

export function generationCorsProxyConfigFromStored(
  values: ReadonlyMap<string, unknown>,
): CorsProxyConfig {
  const url = values.get(CORS_PROXY_URL_KEY)
  const secret = values.get(CORS_PROXY_SECRET_KEY)
  return corsProxyConfigFromPrefs({
    ...DEFAULT_GLOBAL_PREFERENCES,
    corsProxyUrl: typeof url === 'string' ? url : defaultCorsProxyUrlForRuntime(),
    corsProxySecret: typeof secret === 'string' ? secret : '',
  })
}

// Apply the font-family preference by swapping the `--font-sans` CSS
// variable on :root. Stacks are looked up in FONT_FAMILY_OPTIONS so
// the token keeps the same `system-ui, …` fallback chain when the
// preferred font isn't installed.
export function applyFontFamilyToDocument(value: FontFamilyChoice): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--font-sans', fontFamilyStack(value))
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

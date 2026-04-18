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

export interface GlobalPreferences {
  theme: ThemePreference
  sendShortcut: SendShortcut
  userProfilePicture: ProfilePictureRef
  assistantProfilePicture: ProfilePictureRef
  chatMaxWidth: ChatMaxWidth
}

export const DEFAULT_GLOBAL_PREFERENCES: Readonly<GlobalPreferences> =
  Object.freeze({
    theme: 'system',
    sendShortcut: 'enter',
    userProfilePicture: 'default-person',
    assistantProfilePicture: 'default-robot',
    chatMaxWidth: 920,
  })

const THEME_KEY = 'global:theme'
const SEND_SHORTCUT_KEY = 'global:send-shortcut'
const USER_PIC_KEY = 'global:user-profile-picture'
const ASSISTANT_PIC_KEY = 'global:assistant-profile-picture'
const CHAT_MAX_WIDTH_KEY = 'global:chat-max-width'

const ALLOWED_THEMES: readonly ThemePreference[] = [
  'system',
  'light',
  'dark',
  'high-contrast',
]

const ALLOWED_SHORTCUTS: readonly SendShortcut[] = ['enter', 'cmd-enter']

const ALLOWED_PICTURES: readonly ProfilePictureRef[] = [
  'default-person',
  'default-robot',
]

function pictureOrDefault(
  value: unknown,
  fallback: ProfilePictureRef,
): ProfilePictureRef {
  return ALLOWED_PICTURES.includes(value as ProfilePictureRef)
    ? (value as ProfilePictureRef)
    : fallback
}

const ALLOWED_CHAT_MAX_WIDTHS: readonly ChatMaxWidth[] = [
  640, 720, 840, 920, 1040, 1200, 1440, 'full',
]

function chatMaxWidthOrDefault(value: unknown): ChatMaxWidth {
  if (value === 'full') return 'full'
  if (typeof value === 'number' && ALLOWED_CHAT_MAX_WIDTHS.includes(value)) {
    return value
  }
  return DEFAULT_GLOBAL_PREFERENCES.chatMaxWidth
}

export const CHAT_MAX_WIDTH_OPTIONS = ALLOWED_CHAT_MAX_WIDTHS

export async function readGlobalPreferences(): Promise<GlobalPreferences> {
  const [theme, sendShortcut, userPic, asstPic, chatMaxWidth] = await Promise.all([
    getSetting<ThemePreference>(THEME_KEY),
    getSetting<SendShortcut>(SEND_SHORTCUT_KEY),
    getSetting<ProfilePictureRef>(USER_PIC_KEY),
    getSetting<ProfilePictureRef>(ASSISTANT_PIC_KEY),
    getSetting<ChatMaxWidth>(CHAT_MAX_WIDTH_KEY),
  ])
  return {
    theme: ALLOWED_THEMES.includes(theme as ThemePreference)
      ? (theme as ThemePreference)
      : DEFAULT_GLOBAL_PREFERENCES.theme,
    sendShortcut: ALLOWED_SHORTCUTS.includes(sendShortcut as SendShortcut)
      ? (sendShortcut as SendShortcut)
      : DEFAULT_GLOBAL_PREFERENCES.sendShortcut,
    userProfilePicture: pictureOrDefault(
      userPic,
      DEFAULT_GLOBAL_PREFERENCES.userProfilePicture,
    ),
    assistantProfilePicture: pictureOrDefault(
      asstPic,
      DEFAULT_GLOBAL_PREFERENCES.assistantProfilePicture,
    ),
    chatMaxWidth: chatMaxWidthOrDefault(chatMaxWidth),
  }
}

export async function writeTheme(theme: ThemePreference): Promise<void> {
  await setSetting(THEME_KEY, theme)
}

export async function writeSendShortcut(value: SendShortcut): Promise<void> {
  await setSetting(SEND_SHORTCUT_KEY, value)
}

export async function writeUserProfilePicture(
  value: ProfilePictureRef,
): Promise<void> {
  await setSetting(USER_PIC_KEY, value)
}

export async function writeAssistantProfilePicture(
  value: ProfilePictureRef,
): Promise<void> {
  await setSetting(ASSISTANT_PIC_KEY, value)
}

export async function writeChatMaxWidth(value: ChatMaxWidth): Promise<void> {
  await setSetting(CHAT_MAX_WIDTH_KEY, value)
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

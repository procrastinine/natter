import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyChatMaxWidthToDocument,
  applyThemeToDocument,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
  writeChatMaxWidth,
  writeSendShortcut,
  writeTheme,
  type ChatMaxWidth,
  type SendShortcut,
  type ThemePreference,
} from '../../core/global-settings'

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'high-contrast', label: 'High contrast' },
]

const SHORTCUT_OPTIONS: ReadonlyArray<{ value: SendShortcut; label: string }> = [
  { value: 'enter', label: 'Enter sends · Shift+Enter inserts a newline' },
  { value: 'cmd-enter', label: 'Cmd/Ctrl+Enter sends · Enter inserts a newline' },
]

// Slider range. The rightmost step is overloaded to mean "no cap" (full
// width); positions to the left are continuous pixel widths in steps of
// 20 px.
const CHAT_WIDTH_MIN = 640
const CHAT_WIDTH_MAX_PX = 1600
const CHAT_WIDTH_STEP = 20
const CHAT_WIDTH_FULL_POSITION = CHAT_WIDTH_MAX_PX + CHAT_WIDTH_STEP

function sliderPositionFromPref(value: ChatMaxWidth): number {
  if (value === 'full') return CHAT_WIDTH_FULL_POSITION
  return Math.min(CHAT_WIDTH_MAX_PX, Math.max(CHAT_WIDTH_MIN, value))
}

function prefFromSliderPosition(position: number): ChatMaxWidth {
  if (position >= CHAT_WIDTH_FULL_POSITION) return 'full'
  return position
}

function chatMaxWidthLabel(value: ChatMaxWidth): string {
  if (value === 'full') return 'Full width'
  return `${value}px`
}

export function GeneralSettings() {
  const prefs = useLiveQuery(
    readGlobalPreferences,
    [],
    DEFAULT_GLOBAL_PREFERENCES,
  )
  const onTheme = useCallback(async (value: ThemePreference) => {
    applyThemeToDocument(value)
    await writeTheme(value)
  }, [])
  const onShortcut = useCallback(async (value: SendShortcut) => {
    await writeSendShortcut(value)
  }, [])

  // Slider is locally controlled. The live-query roundtrip (drag → write →
  // IndexedDB → liveQuery refresh → re-render with new value) takes long
  // enough that a controlled slider visibly snaps back during drag. Keep
  // the position in local state, write to IDB on a debounce, and only
  // accept a fresh value from prefs when the underlying chatMaxWidth pref
  // changes from outside this component.
  const [position, setPosition] = useState<number>(() =>
    sliderPositionFromPref(prefs.chatMaxWidth),
  )
  const lastPersistedRef = useRef<ChatMaxWidth>(prefs.chatMaxWidth)
  const persistTimerRef = useRef<number | null>(null)
  useEffect(() => {
    // External writes (settings imported, multi-tab change) — sync the
    // slider position. Skips when WE were the writer (lastPersistedRef
    // matches the incoming value).
    if (prefs.chatMaxWidth === lastPersistedRef.current) return
    lastPersistedRef.current = prefs.chatMaxWidth
    setPosition(sliderPositionFromPref(prefs.chatMaxWidth))
    applyChatMaxWidthToDocument(prefs.chatMaxWidth)
  }, [prefs.chatMaxWidth])
  const onChatMaxWidth = useCallback((raw: string) => {
    const next = Number.parseInt(raw, 10)
    if (!Number.isFinite(next)) return
    setPosition(next)
    const value = prefFromSliderPosition(next)
    applyChatMaxWidthToDocument(value)
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
    }
    persistTimerRef.current = window.setTimeout(() => {
      lastPersistedRef.current = value
      void writeChatMaxWidth(value)
    }, 200)
  }, [])
  return (
    <>
      <div data-ui="settings-section">
        <h3>Appearance</h3>
        <div data-ui="field-group">
          <label htmlFor="theme-select">Theme</label>
          <select
            id="theme-select"
            data-ui="theme-select"
            value={prefs.theme}
            onChange={(e) => void onTheme(e.target.value as ThemePreference)}
          >
            {THEME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div data-ui="settings-section">
        <h3>Layout</h3>
        <div data-ui="field-group">
          <label htmlFor="chat-max-width">
            Chat width{' '}
            <span data-ui="field-value">
              {chatMaxWidthLabel(prefFromSliderPosition(position))}
            </span>
          </label>
          <input
            id="chat-max-width"
            data-ui="chat-max-width-slider"
            type="range"
            min={CHAT_WIDTH_MIN}
            max={CHAT_WIDTH_FULL_POSITION}
            step={CHAT_WIDTH_STEP}
            value={position}
            onChange={(e) => onChatMaxWidth(e.target.value)}
            onInput={(e) =>
              onChatMaxWidth((e.target as HTMLInputElement).value)
            }
          />
          <span data-ui="helper">
            Maximum width of the centered reading column. Drag to the right
            edge for full width.
          </span>
        </div>
      </div>
      <div data-ui="settings-section">
        <h3>Composer</h3>
        <div data-ui="field-group">
          <label htmlFor="send-shortcut">Send shortcut</label>
          <select
            id="send-shortcut"
            data-ui="send-shortcut-select"
            value={prefs.sendShortcut}
            onChange={(e) => void onShortcut(e.target.value as SendShortcut)}
          >
            {SHORTCUT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  )
}

// Appearance tab: theme, layout (chat width), fonts, and code-rendering
// themes. Collects everything that changes how the chat LOOKS — split
// from General, which now houses only composer + continue behavior.

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BASE_FONT_SIZE_OPTIONS,
  FONT_FAMILY_OPTIONS,
  applyBaseFontSizeToDocument,
  applyChatMaxWidthToDocument,
  applyFontFamilyToDocument,
  applyThemeToDocument,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
  writeBaseFontSize,
  writeChatMaxWidth,
  writeFontFamily,
  writeTheme,
  type BaseFontSize,
  type ChatMaxWidth,
  type FontFamilyChoice,
  type ThemePreference,
} from '../../core/global-settings'
import { RenderingSettings } from './RenderingSettings'

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'high-contrast', label: 'High contrast' },
]

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

export function AppearanceSettings() {
  const prefs = useLiveQuery(
    readGlobalPreferences,
    [],
    DEFAULT_GLOBAL_PREFERENCES,
  )

  const onTheme = useCallback(async (value: ThemePreference) => {
    applyThemeToDocument(value)
    await writeTheme(value)
  }, [])

  const onFontFamily = useCallback(async (value: FontFamilyChoice) => {
    applyFontFamilyToDocument(value)
    await writeFontFamily(value)
  }, [])

  const onBaseFontSize = useCallback(async (value: BaseFontSize) => {
    applyBaseFontSizeToDocument(value)
    await writeBaseFontSize(value)
  }, [])

  const [position, setPosition] = useState<number>(() =>
    sliderPositionFromPref(prefs.chatMaxWidth),
  )
  const lastPersistedRef = useRef<ChatMaxWidth>(prefs.chatMaxWidth)
  const persistTimerRef = useRef<number | null>(null)
  useEffect(() => {
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
        <h3>Theme</h3>
        <div data-ui="field-group">
          <label htmlFor="theme-select">Color theme</label>
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
        <h3>Typography</h3>
        <div data-ui="field-group">
          <label htmlFor="font-family">Font family</label>
          <select
            id="font-family"
            data-ui="font-family-select"
            value={prefs.fontFamily}
            onChange={(e) =>
              void onFontFamily(e.target.value as FontFamilyChoice)
            }
          >
            {FONT_FAMILY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span data-ui="helper">
            Applies to the chat transcript, composer, and sidebar. Code
            blocks keep the monospace family from the rendering theme.
          </span>
        </div>
        <div data-ui="field-group">
          <label htmlFor="base-font-size">Base font size</label>
          <select
            id="base-font-size"
            data-ui="base-font-size-select"
            value={prefs.baseFontSize}
            onChange={(e) =>
              void onBaseFontSize(
                Number.parseInt(e.target.value, 10) as BaseFontSize,
              )
            }
          >
            {BASE_FONT_SIZE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}px
              </option>
            ))}
          </select>
          <span data-ui="helper">
            Scales headings, chips, and helper text proportionally.
          </span>
        </div>
      </div>
      <RenderingSettings />
    </>
  )
}

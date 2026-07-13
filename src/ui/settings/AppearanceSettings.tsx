// Appearance tab: theme, layout (chat width), fonts, and code-rendering
// themes. Collects everything that changes how the chat LOOKS — split
// from General, which now houses only composer + continue behavior.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyBaseFontSizeToDocument,
  applyChatMaxWidthToDocument,
  applyFontFamilyToDocument,
  applyThemeToDocument,
  BASE_FONT_SIZE_OPTIONS,
  type BaseFontSize,
  CHAT_MAX_WIDTH_FULL_POSITION,
  CHAT_MAX_WIDTH_MAX_PX,
  CHAT_MAX_WIDTH_MIN,
  CHAT_MAX_WIDTH_STEP,
  type ChatMaxWidth,
  DEFAULT_GLOBAL_PREFERENCES,
  FONT_FAMILY_OPTIONS,
  type FontFamilyChoice,
  type LongMessageDisplayMode,
  readGlobalPreferences,
  type ThemePreference,
  writeBaseFontSize,
  writeChatMaxWidth,
  writeFontFamily,
  writeLongMessageDisplayMode,
  writeTheme,
} from '../../core/global-settings'
import { GLOBAL_PREFERENCES_DEPENDENCIES } from '../../store/reactive-dependencies'
import { useRepositoryQueryState } from '../../store/reactive-query'
import { InfoDisclosure } from './InfoDisclosure'
import { RenderingSettings } from './RenderingSettings'

const THEME_OPTIONS: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'high-contrast', label: 'High contrast' },
]

const LONG_MESSAGE_DISPLAY_OPTIONS: ReadonlyArray<{
  value: LongMessageDisplayMode
  label: string
}> = [
  { value: 'full', label: 'Fully displayed' },
  { value: 'compact', label: 'Compact preview' },
]

function sliderPositionFromPref(value: ChatMaxWidth): number {
  if (value === 'full') return CHAT_MAX_WIDTH_FULL_POSITION
  return Math.min(CHAT_MAX_WIDTH_MAX_PX, Math.max(CHAT_MAX_WIDTH_MIN, value))
}

function prefFromSliderPosition(position: number): ChatMaxWidth {
  if (position >= CHAT_MAX_WIDTH_FULL_POSITION) return 'full'
  return position
}

function chatMaxWidthLabel(value: ChatMaxWidth): string {
  if (value === 'full') return 'Full width'
  return `${value}px`
}

export function AppearanceSettings() {
  const preferencesQuery = useRepositoryQueryState(
    'global-preferences',
    readGlobalPreferences,
    DEFAULT_GLOBAL_PREFERENCES,
    GLOBAL_PREFERENCES_DEPENDENCIES,
  )
  if (preferencesQuery.status === 'error') throw preferencesQuery.error
  const loadedPrefs = preferencesQuery.status === 'ready' ? preferencesQuery.value : undefined
  const prefs = preferencesQuery.value

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

  const onLongMessageDisplayMode = useCallback(async (value: LongMessageDisplayMode) => {
    await writeLongMessageDisplayMode(value)
  }, [])

  const [position, setPosition] = useState<number>(() => sliderPositionFromPref(prefs.chatMaxWidth))
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const pendingChatMaxWidthRef = useRef<ChatMaxWidth | null>(null)
  const loadedChatMaxWidth = loadedPrefs?.chatMaxWidth
  useEffect(() => {
    if (loadedChatMaxWidth === undefined) return
    if (
      pendingChatMaxWidthRef.current !== null &&
      loadedChatMaxWidth !== pendingChatMaxWidthRef.current
    ) {
      return
    }
    pendingChatMaxWidthRef.current = null
    setPosition(sliderPositionFromPref(loadedChatMaxWidth))
    applyChatMaxWidthToDocument(loadedChatMaxWidth)
  }, [loadedChatMaxWidth])
  const onChatMaxWidth = useCallback((raw: string) => {
    const next = Number.parseInt(raw, 10)
    if (!Number.isFinite(next)) return
    setPosition(next)
    const value = prefFromSliderPosition(next)
    pendingChatMaxWidthRef.current = value
    applyChatMaxWidthToDocument(value)
    writeQueueRef.current = writeQueueRef.current
      .catch(() => undefined)
      .then(() => writeChatMaxWidth(value))
      .then(
        () => {
          if (pendingChatMaxWidthRef.current === value) {
            pendingChatMaxWidthRef.current = null
          }
        },
        () => {
          if (pendingChatMaxWidthRef.current === value) {
            pendingChatMaxWidthRef.current = null
          }
        },
      )
  }, [])
  const renderedPosition =
    loadedPrefs && pendingChatMaxWidthRef.current === null
      ? sliderPositionFromPref(loadedPrefs.chatMaxWidth)
      : position

  if (!loadedPrefs) {
    return <div data-ui="settings-section" data-loading="true" aria-busy="true" />
  }

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
              {chatMaxWidthLabel(prefFromSliderPosition(renderedPosition))}
            </span>
            <InfoDisclosure title="Chat width">
              Maximum width of the centered reading column. Drag to the right edge for full width.
            </InfoDisclosure>
          </label>
          <input
            id="chat-max-width"
            data-ui="chat-max-width-slider"
            type="range"
            min={CHAT_MAX_WIDTH_MIN}
            max={CHAT_MAX_WIDTH_FULL_POSITION}
            step={CHAT_MAX_WIDTH_STEP}
            value={renderedPosition}
            onChange={(e) => onChatMaxWidth(e.target.value)}
          />
        </div>
        <div data-ui="field-group">
          <label htmlFor="long-message-display">
            Long messages
            <InfoDisclosure title="Long messages">
              Controls whether long messages reload as full text or as an avatar-expandable compact
              preview.
            </InfoDisclosure>
          </label>
          <select
            id="long-message-display"
            data-ui="long-message-display-select"
            value={prefs.longMessageDisplayMode}
            onChange={(e) =>
              void onLongMessageDisplayMode(e.target.value as LongMessageDisplayMode)
            }
          >
            {LONG_MESSAGE_DISPLAY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div data-ui="settings-section">
        <h3>Typography</h3>
        <div data-ui="field-group">
          <label htmlFor="font-family">
            Font family
            <InfoDisclosure title="Font family">
              Applies to the chat transcript, composer, and sidebar. Code blocks keep the monospace
              family from the rendering theme.
            </InfoDisclosure>
          </label>
          <select
            id="font-family"
            data-ui="font-family-select"
            value={prefs.fontFamily}
            onChange={(e) => void onFontFamily(e.target.value as FontFamilyChoice)}
          >
            {FONT_FAMILY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div data-ui="field-group">
          <label htmlFor="base-font-size">
            Base font size
            <InfoDisclosure title="Base font size">
              Scales headings, chips, and helper text proportionally.
            </InfoDisclosure>
          </label>
          <select
            id="base-font-size"
            data-ui="base-font-size-select"
            value={prefs.baseFontSize}
            onChange={(e) =>
              void onBaseFontSize(Number.parseInt(e.target.value, 10) as BaseFontSize)
            }
          >
            {BASE_FONT_SIZE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}px
              </option>
            ))}
          </select>
        </div>
      </div>
      <RenderingSettings />
    </>
  )
}

// General tab: behavior-only prefs. Everything aesthetic (theme,
// layout, fonts, code rendering) lives under Appearance. Continue prompts
// moved to per-chat settings (see `PromptPresetEditor`) in the prompt-preset
// refactor — they're no longer workspace-global.

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback } from 'react'
import {
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
  type SendShortcut,
  type TokenCalibrationMode,
  writeAutoScrollOnOpen,
  writeAutoScrollOnStream,
  writeSendShortcut,
  writeTokenCalibrationMode,
} from '../../core/global-settings'
import { TokenCalibrationSettings } from './TokenCalibrationSettings'

const SHORTCUT_OPTIONS: ReadonlyArray<{ value: SendShortcut; label: string }> = [
  { value: 'enter', label: 'Enter sends · Shift+Enter inserts a newline' },
  { value: 'cmd-enter', label: 'Cmd/Ctrl+Enter sends · Enter inserts a newline' },
]

export function GeneralSettings() {
  const prefs = useLiveQuery(readGlobalPreferences, [], DEFAULT_GLOBAL_PREFERENCES)
  const onShortcut = useCallback(async (value: SendShortcut) => {
    await writeSendShortcut(value)
  }, [])
  const onAutoScrollOnOpen = useCallback(async (value: boolean) => {
    await writeAutoScrollOnOpen(value)
  }, [])
  const onAutoScrollOnStream = useCallback(async (value: boolean) => {
    await writeAutoScrollOnStream(value)
  }, [])
  const onTokenCalibrationMode = useCallback(async (value: TokenCalibrationMode) => {
    await writeTokenCalibrationMode(value)
  }, [])

  return (
    <>
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
      <div data-ui="settings-section">
        <h3>Scroll</h3>
        <div data-ui="field-group">
          <label data-ui="toggle-row" htmlFor="auto-scroll-open-toggle">
            <input
              id="auto-scroll-open-toggle"
              data-ui="auto-scroll-open-toggle"
              type="checkbox"
              checked={prefs.autoScrollOnOpen}
              onChange={(e) => void onAutoScrollOnOpen(e.target.checked)}
            />
            <span>Jump to the branch leaf when opening a chat</span>
          </label>
          <span data-ui="helper">
            When on, the chat loads already positioned at the latest message (no visible scroll —
            the view is placed before paint). When off, the chat opens at the top and you can scroll
            down manually.
          </span>
        </div>
        <div data-ui="field-group">
          <label data-ui="toggle-row" htmlFor="auto-scroll-stream-toggle">
            <input
              id="auto-scroll-stream-toggle"
              data-ui="auto-scroll-stream-toggle"
              type="checkbox"
              checked={prefs.autoScrollOnStream}
              onChange={(e) => void onAutoScrollOnStream(e.target.checked)}
            />
            <span>Auto-scroll to the bottom during streams</span>
          </label>
          <span data-ui="helper">
            When off, new tokens during a live stream don't pull the viewport. You can still jump
            to the latest reply via the floating chip.
          </span>
        </div>
      </div>
      <TokenCalibrationSettings
        mode={prefs.tokenCalibrationMode}
        onModeChange={onTokenCalibrationMode}
      />
    </>
  )
}

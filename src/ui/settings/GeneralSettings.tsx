// General tab: behavior-only prefs. Everything aesthetic (theme,
// layout, fonts, code rendering) lives under Appearance.

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CONTINUE_PROMPT,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
  writeAutoScrollOnOpen,
  writeAutoScrollOnStream,
  writeContinuePrompt,
  writeSendShortcut,
  type SendShortcut,
} from '../../core/global-settings'

const SHORTCUT_OPTIONS: ReadonlyArray<{ value: SendShortcut; label: string }> = [
  { value: 'enter', label: 'Enter sends · Shift+Enter inserts a newline' },
  { value: 'cmd-enter', label: 'Cmd/Ctrl+Enter sends · Enter inserts a newline' },
]

export function GeneralSettings() {
  const prefs = useLiveQuery(
    readGlobalPreferences,
    [],
    DEFAULT_GLOBAL_PREFERENCES,
  )
  const onShortcut = useCallback(async (value: SendShortcut) => {
    await writeSendShortcut(value)
  }, [])
  const onAutoScrollOnOpen = useCallback(async (value: boolean) => {
    await writeAutoScrollOnOpen(value)
  }, [])
  const onAutoScrollOnStream = useCallback(async (value: boolean) => {
    await writeAutoScrollOnStream(value)
  }, [])

  const [continueDraft, setContinueDraft] = useState<string>(
    prefs.continuePrompt,
  )
  const continueLastPersistedRef = useRef<string>(prefs.continuePrompt)
  const continueTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (prefs.continuePrompt === continueLastPersistedRef.current) return
    continueLastPersistedRef.current = prefs.continuePrompt
    setContinueDraft(prefs.continuePrompt)
  }, [prefs.continuePrompt])
  const onContinuePromptChange = useCallback((value: string) => {
    setContinueDraft(value)
    if (continueTimerRef.current !== null) {
      window.clearTimeout(continueTimerRef.current)
    }
    continueTimerRef.current = window.setTimeout(() => {
      continueLastPersistedRef.current = value
      void writeContinuePrompt(value)
    }, 300)
  }, [])
  const onContinueReset = useCallback(() => {
    if (continueTimerRef.current !== null) {
      window.clearTimeout(continueTimerRef.current)
    }
    setContinueDraft(DEFAULT_CONTINUE_PROMPT)
    continueLastPersistedRef.current = DEFAULT_CONTINUE_PROMPT
    void writeContinuePrompt(DEFAULT_CONTINUE_PROMPT)
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
          <label
            data-ui="toggle-row"
            htmlFor="auto-scroll-open-toggle"
          >
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
            When on, the chat loads already positioned at the latest
            message (no visible scroll — the view is placed before
            paint). When off, the chat opens at the top and you can
            scroll down manually.
          </span>
        </div>
        <div data-ui="field-group">
          <label
            data-ui="toggle-row"
            htmlFor="auto-scroll-stream-toggle"
          >
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
            When off, new tokens during a live stream don't pull the
            viewport down. You can still jump to the latest reply via
            the floating chip.
          </span>
        </div>
      </div>
      <div data-ui="settings-section">
        <h3>Continue</h3>
        <div data-ui="field-group">
          <label htmlFor="continue-prompt">
            Continue-as-assistant system prompt
            {continueDraft !== DEFAULT_CONTINUE_PROMPT ? (
              <button
                type="button"
                data-ui="field-inline-action"
                data-role="continue-reset"
                onClick={onContinueReset}
                title="Restore the default continue prompt"
              >
                Reset to default
              </button>
            ) : null}
          </label>
          <textarea
            id="continue-prompt"
            data-ui="continue-prompt"
            value={continueDraft}
            onChange={(e) => onContinuePromptChange(e.target.value)}
            rows={5}
            spellCheck
          />
          <span data-ui="helper">
            Injected as the system prompt when you hit Continue on an
            assistant message. The original chat system prompt is
            appended underneath so the assistant retains its character.
          </span>
        </div>
      </div>
    </>
  )
}

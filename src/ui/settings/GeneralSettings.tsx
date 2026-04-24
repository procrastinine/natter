// General tab: behavior-only prefs. Everything aesthetic (theme,
// layout, fonts, code rendering) lives under Appearance.

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CONTINUE_SYSTEM_PROMPT_PLACEHOLDER,
  DEFAULT_CONTINUE_SYSTEM_PROMPT,
  DEFAULT_CONTINUE_USER_PROMPT,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
  type SendShortcut,
  type TokenCalibrationMode,
  writeAutoScrollOnOpen,
  writeAutoScrollOnStream,
  writeContinueSystemPrompt,
  writeContinueUserPrompt,
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

  const [continueSystemDraft, setContinueSystemDraft] = useState<string>(prefs.continueSystemPrompt)
  const continueSystemLastPersistedRef = useRef<string>(prefs.continueSystemPrompt)
  const continueSystemTimerRef = useRef<number | null>(null)
  const [continueUserDraft, setContinueUserDraft] = useState<string>(prefs.continueUserPrompt)
  const continueUserLastPersistedRef = useRef<string>(prefs.continueUserPrompt)
  const continueUserTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (prefs.continueSystemPrompt === continueSystemLastPersistedRef.current) return
    continueSystemLastPersistedRef.current = prefs.continueSystemPrompt
    setContinueSystemDraft(prefs.continueSystemPrompt)
  }, [prefs.continueSystemPrompt])
  useEffect(() => {
    if (prefs.continueUserPrompt === continueUserLastPersistedRef.current) return
    continueUserLastPersistedRef.current = prefs.continueUserPrompt
    setContinueUserDraft(prefs.continueUserPrompt)
  }, [prefs.continueUserPrompt])
  useEffect(
    () => () => {
      if (continueSystemTimerRef.current !== null) {
        window.clearTimeout(continueSystemTimerRef.current)
      }
      if (continueUserTimerRef.current !== null) {
        window.clearTimeout(continueUserTimerRef.current)
      }
    },
    [],
  )
  const onContinueSystemPromptChange = useCallback((value: string) => {
    setContinueSystemDraft(value)
    if (continueSystemTimerRef.current !== null) {
      window.clearTimeout(continueSystemTimerRef.current)
    }
    continueSystemTimerRef.current = window.setTimeout(() => {
      continueSystemLastPersistedRef.current = value
      void writeContinueSystemPrompt(value)
    }, 300)
  }, [])
  const onContinueUserPromptChange = useCallback((value: string) => {
    setContinueUserDraft(value)
    if (continueUserTimerRef.current !== null) {
      window.clearTimeout(continueUserTimerRef.current)
    }
    continueUserTimerRef.current = window.setTimeout(() => {
      continueUserLastPersistedRef.current = value
      void writeContinueUserPrompt(value)
    }, 300)
  }, [])
  const onContinueSystemReset = useCallback(() => {
    if (continueSystemTimerRef.current !== null) {
      window.clearTimeout(continueSystemTimerRef.current)
    }
    setContinueSystemDraft(DEFAULT_CONTINUE_SYSTEM_PROMPT)
    continueSystemLastPersistedRef.current = DEFAULT_CONTINUE_SYSTEM_PROMPT
    void writeContinueSystemPrompt(DEFAULT_CONTINUE_SYSTEM_PROMPT)
  }, [])
  const onContinueUserReset = useCallback(() => {
    if (continueUserTimerRef.current !== null) {
      window.clearTimeout(continueUserTimerRef.current)
    }
    setContinueUserDraft(DEFAULT_CONTINUE_USER_PROMPT)
    continueUserLastPersistedRef.current = DEFAULT_CONTINUE_USER_PROMPT
    void writeContinueUserPrompt(DEFAULT_CONTINUE_USER_PROMPT)
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
            When off, new tokens during a live stream don't pull the viewport down. You can still
            jump to the latest reply via the floating chip.
          </span>
        </div>
      </div>
      <div data-ui="settings-section">
        <h3>Continue</h3>
        <div data-ui="field-group">
          <label htmlFor="continue-system-prompt">
            Continue system prompt
            {continueSystemDraft !== DEFAULT_CONTINUE_SYSTEM_PROMPT ? (
              <button
                type="button"
                data-ui="field-inline-action"
                data-role="continue-system-reset"
                onClick={onContinueSystemReset}
                title="Restore the default continue system prompt"
              >
                Reset to default
              </button>
            ) : null}
          </label>
          <textarea
            id="continue-system-prompt"
            data-ui="continue-system-prompt"
            value={continueSystemDraft}
            onChange={(e) => onContinueSystemPromptChange(e.target.value)}
            rows={4}
            spellCheck
          />
          <span data-ui="helper">
            This field is a template. <code>{CONTINUE_SYSTEM_PROMPT_PLACEHOLDER}</code> expands to
            the original chat system prompt verbatim. If the placeholder is absent, the original
            system prompt is not added. Leave the field blank to send no system prompt at all
            during Continue.
          </span>
        </div>
        <div data-ui="field-group">
          <label htmlFor="continue-user-prompt">
            Continue user prompt
            {continueUserDraft !== DEFAULT_CONTINUE_USER_PROMPT ? (
              <button
                type="button"
                data-ui="field-inline-action"
                data-role="continue-user-reset"
                onClick={onContinueUserReset}
                title="Restore the default continue user prompt"
              >
                Reset to default
              </button>
            ) : null}
          </label>
          <textarea
            id="continue-user-prompt"
            data-ui="continue-user-prompt"
            value={continueUserDraft}
            onChange={(e) => onContinueUserPromptChange(e.target.value)}
            rows={3}
            spellCheck
          />
          <span data-ui="helper">
            Appended as a synthetic trailing user turn during Continue. Leave blank to fall back to
            the legacy double-assistant shape, which can perform poorly on some models.
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

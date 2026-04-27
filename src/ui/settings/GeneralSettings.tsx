// General tab: behavior-only prefs. Everything aesthetic (theme,
// layout, fonts, code rendering) lives under Appearance. Continue prompts
// moved to per-chat settings (see `PromptPresetEditor`) in the prompt-preset
// refactor — they're no longer workspace-global.

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback } from 'react'
import {
  DEFAULT_CORS_PROXY_URL,
  DEFAULT_GLOBAL_PREFERENCES,
  readGlobalPreferences,
  type SendShortcut,
  type TokenCalibrationMode,
  writeAutoScrollOnOpen,
  writeAutoScrollOnStream,
  writeCorsProxySecret,
  writeCorsProxyUrl,
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
  const onCorsProxyUrl = useCallback(async (value: string) => {
    await writeCorsProxyUrl(value)
  }, [])
  const onCorsProxySecret = useCallback(async (value: string) => {
    await writeCorsProxySecret(value)
  }, [])

  // The default `/_or_scrape` is a Vite dev-server rewrite — the compiled
  // bundle has no route for it, so a relative URL only works while
  // `pnpm dev` is the host. Flag it so the user knows to swap in a
  // hosted bouncer (e.g. a Cloudflare Worker) for production.
  const isDev = import.meta.env.DEV
  const trimmedProxyUrl = prefs.corsProxyUrl.trim()
  const proxyIsRelative = trimmedProxyUrl.length === 0 || trimmedProxyUrl.startsWith('/')
  const showDevDefaultWarning = proxyIsRelative && !isDev
  const proxyPlaceholder = isDev
    ? DEFAULT_CORS_PROXY_URL
    : 'https://corsproxy.io/?url=https://openrouter.ai/{model}/providers'

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
            When on, the chat loads already positioned at the latest message (no visible scroll,
            the view is placed before paint). When off, the chat opens at the top and the view
            stays scrollable manually.
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
            When off, new tokens during a live stream don't pull the viewport. Jumping to the
            latest reply via the floating chip remains available.
          </span>
        </div>
      </div>
      <TokenCalibrationSettings
        mode={prefs.tokenCalibrationMode}
        onModeChange={onTokenCalibrationMode}
      />
      <div data-ui="settings-section">
        <h3>Privacy-page proxy</h3>
        <span data-ui="helper">
          Fetches per-provider <code>data_policy</code> info from OpenRouter's per-model HTML
          pages.{' '}
          {isDev ? (
            <>
              Default <code>{DEFAULT_CORS_PROXY_URL}</code> works while <code>pnpm dev</code>{' '}
              is running.
            </>
          ) : (
            <>Paste one of the examples below.</>
          )}
        </span>
        <ul data-ui="helper">
          <li>
            Public bouncer:{' '}
            <code>{'https://corsproxy.io/?url=https://openrouter.ai/{model}/providers'}</code>
          </li>
          <li>
            Self-hosted Worker base: <code>https://or-scrape.example.workers.dev</code>{' '}
            (<code>{'/{model}/providers'}</code> is appended automatically)
          </li>
        </ul>
        <span data-ui="helper">
          URLs containing <code>{'{model}'}</code> are substituted in place; otherwise the
          value is treated as a base and the path is appended.
        </span>
        <div data-ui="field-group">
          <label htmlFor="cors-proxy-url">Proxy URL</label>
          <input
            id="cors-proxy-url"
            data-ui="cors-proxy-url"
            type="text"
            inputMode="url"
            spellCheck={false}
            placeholder={proxyPlaceholder}
            value={prefs.corsProxyUrl}
            onChange={(e) => void onCorsProxyUrl(e.target.value)}
            aria-invalid={showDevDefaultWarning}
          />
          {showDevDefaultWarning ? (
            <span data-ui="helper" data-validation="invalid">
              Relative URLs only resolve under <code>pnpm dev</code>. Paste an absolute
              bouncer URL to make the privacy scrape work in production.
            </span>
          ) : null}
        </div>
        <div data-ui="field-group">
          <label htmlFor="cors-proxy-secret">
            Proxy secret <em>(optional)</em>
          </label>
          <input
            id="cors-proxy-secret"
            data-ui="cors-proxy-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="X-Proxy-Secret value"
            value={prefs.corsProxySecret}
            onChange={(e) => void onCorsProxySecret(e.target.value)}
          />
          <span data-ui="helper">
            Sent as <code>X-Proxy-Secret</code>. Only needed when a self-hosted bouncer
            requires auth.
          </span>
        </div>
      </div>
    </>
  )
}

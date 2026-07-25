// General tab: behavior-only prefs. Everything aesthetic (theme,
// layout, fonts, code rendering) lives under Appearance. Continue prompts
// moved to per-chat settings (see `PromptPresetEditor`) in the prompt-preset
// refactor — they're no longer workspace-global.

import { useCallback } from 'react'
import { workspaceConfigurationWriteInteraction } from '../../app/presentation-interactions'
import {
  AUTO_SCROLL_STREAM_KEY,
  CORS_PROXY_SECRET_KEY,
  CORS_PROXY_URL_KEY,
  DEFAULT_GLOBAL_PREFERENCES,
  DEV_CORS_PROXY_URL,
  defaultCorsProxyUrlForRuntime,
  SEND_SHORTCUT_KEY,
  type SendShortcut,
  TOKEN_CALIBRATION_MODE_KEY,
  type TokenCalibrationMode,
} from '../../core/global-settings'
import { useConfigurationPreferences } from '../../hooks/useConfigurationPreferences'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { useSettledConfigurationEdit } from '../../hooks/useSettledConfigurationEdit'
import { configurationController } from '../../store/configuration-controller'
import {
  writeAutoScrollOnStream,
  writeCorsProxySecret,
  writeCorsProxyUrl,
  writeSendShortcut,
  writeTokenCalibrationMode,
} from '../../store/preferences-application'
import { InfoDisclosure } from './InfoDisclosure'

const SHORTCUT_OPTIONS: ReadonlyArray<{ value: SendShortcut; label: string }> = [
  { value: 'enter', label: 'Enter sends · Shift+Enter inserts a newline' },
  { value: 'cmd-enter', label: 'Cmd/Ctrl+Enter sends · Enter inserts a newline' },
]

const CALIBRATION_MODE_OPTIONS: ReadonlyArray<{
  value: TokenCalibrationMode
  label: string
  helper: string
}> = [
  {
    value: 'adaptive',
    label: 'Chat, then global',
    helper: 'Use chat-specific samples first, then the global family rollup.',
  },
  {
    value: 'global-only',
    label: 'Global only',
    helper: 'Ignore per-chat samples and use only the global family rollup.',
  },
  {
    value: 'family-defaults-only',
    label: 'Family defaults only',
    helper: 'Disable learned calibration and use built-in tokenizer-family defaults.',
  },
]

export function GeneralSettings() {
  const { run: runWorkspaceConfigurationWrite } = usePresentationInteraction(
    workspaceConfigurationWriteInteraction,
    { observePending: false },
  )
  const prefs = useConfigurationPreferences()?.global ?? DEFAULT_GLOBAL_PREFERENCES
  const onShortcut = useCallback(
    (value: SendShortcut) =>
      runWorkspaceConfigurationWrite({
        target: SEND_SHORTCUT_KEY,
        action: () => writeSendShortcut(value),
      }),
    [runWorkspaceConfigurationWrite],
  )
  const onAutoScrollOnStream = useCallback(
    (value: boolean) =>
      runWorkspaceConfigurationWrite({
        target: AUTO_SCROLL_STREAM_KEY,
        action: () => writeAutoScrollOnStream(value),
      }),
    [runWorkspaceConfigurationWrite],
  )
  const onTokenCalibrationMode = useCallback(
    (value: TokenCalibrationMode) =>
      runWorkspaceConfigurationWrite({
        target: TOKEN_CALIBRATION_MODE_KEY,
        action: () => writeTokenCalibrationMode(value),
      }),
    [runWorkspaceConfigurationWrite],
  )
  const corsProxyUrl = useSettledConfigurationEdit({
    fieldKey: CORS_PROXY_URL_KEY,
    storedValue: prefs.corsProxyUrl,
    stage: (value) => configurationController.stageWorkspaceSetting(CORS_PROXY_URL_KEY, value),
    commit: writeCorsProxyUrl,
  })
  const corsProxySecret = useSettledConfigurationEdit({
    fieldKey: CORS_PROXY_SECRET_KEY,
    storedValue: prefs.corsProxySecret,
    stage: (value) => configurationController.stageWorkspaceSetting(CORS_PROXY_SECRET_KEY, value),
    commit: writeCorsProxySecret,
  })

  // `/_or_scrape` is a Vite dev-server rewrite — the compiled bundle
  // has no route for it, so it is only the default in `pnpm dev`.
  const isDev = import.meta.env.DEV
  const trimmedProxyUrl = corsProxyUrl.value.trim()
  const proxyDisabled = trimmedProxyUrl.length === 0 && !isDev
  const proxyIsRelative = trimmedProxyUrl.length > 0 && trimmedProxyUrl.startsWith('/')
  const showDevDefaultWarning = proxyIsRelative && !isDev
  const proxyPlaceholder = isDev
    ? defaultCorsProxyUrlForRuntime(isDev)
    : 'No live scrape by default'

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
          <label data-ui="toggle-row" htmlFor="auto-scroll-stream-toggle">
            <input
              id="auto-scroll-stream-toggle"
              data-ui="auto-scroll-stream-toggle"
              type="checkbox"
              checked={prefs.autoScrollOnStream}
              onChange={(e) => void onAutoScrollOnStream(e.target.checked)}
            />
            <span>Auto-scroll to the bottom during streams</span>
            <InfoDisclosure title="Auto-scroll to the bottom during streams">
              When off, new tokens during a live stream don't pull the viewport. Jumping to the
              latest reply via the floating chip remains available.
            </InfoDisclosure>
          </label>
        </div>
      </div>
      <div data-ui="settings-section">
        <h3>Token calibration</h3>
        <div data-ui="field-group">
          <label htmlFor="token-calibration-mode">Mode</label>
          <select
            id="token-calibration-mode"
            data-ui="token-calibration-mode"
            value={prefs.tokenCalibrationMode}
            onChange={(e) => void onTokenCalibrationMode(e.target.value as TokenCalibrationMode)}
          >
            {CALIBRATION_MODE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span data-ui="helper">
            {
              CALIBRATION_MODE_OPTIONS.find((option) => option.value === prefs.tokenCalibrationMode)
                ?.helper
            }
          </span>
        </div>
      </div>
      <div data-ui="settings-section">
        <h3>
          Privacy-page proxy
          <InfoDisclosure title="Privacy-page proxy">
            Fetches per-provider <code>data_policy</code> info from OpenRouter's per-model HTML
            pages.{' '}
            {isDev ? (
              <>
                Default <code>{DEV_CORS_PROXY_URL}</code> works while <code>pnpm dev</code> is
                running.
              </>
            ) : (
              <>
                Static builds default to no live scrape. Paste a proxy URL here to refresh live
                provider policies from the browser.
              </>
            )}
            <ul>
              <li>
                Known bouncer (just the host): <code>corsproxy.io</code>,{' '}
                <code>api.allorigins.win</code>, or <code>proxy.corsfix.com</code>.
              </li>
              <li>
                Custom bouncer (full template):{' '}
                <code>{'https://corsproxy.io/?url=https://openrouter.ai/{model}/providers'}</code>
              </li>
              <li>
                Self-hosted Worker base: <code>https://or-scrape.example.workers.dev</code> (
                <code>{'/{model}/providers'}</code> is appended automatically)
              </li>
            </ul>
            URLs containing <code>{'{model}'}</code> or <code>{'{path}'}</code> are substituted in
            place; bare hosts in the known-bouncer list expand automatically; everything else is
            treated as a base and the path is appended. Public bouncers can see the OpenRouter
            model/provider page URLs requested through them.
          </InfoDisclosure>
        </h3>
        <div data-ui="field-group">
          <label htmlFor="cors-proxy-url">Proxy URL</label>
          <input
            id="cors-proxy-url"
            data-ui="cors-proxy-url"
            type="text"
            inputMode="url"
            spellCheck={false}
            placeholder={proxyPlaceholder}
            value={corsProxyUrl.value}
            onChange={(e) => corsProxyUrl.setValue(e.target.value)}
            onBlur={corsProxyUrl.onBlur}
            aria-invalid={showDevDefaultWarning}
          />
          {showDevDefaultWarning ? (
            <span data-ui="helper" data-validation="invalid">
              Relative URLs only resolve under <code>pnpm dev</code>. Paste an absolute bouncer URL
              to make the privacy scrape work in production.
            </span>
          ) : null}
          {proxyDisabled ? (
            <span data-ui="helper" data-tone="muted">
              Live privacy scrape is off. Provider privacy uses cached data, endpoint-supplied data,
              and curated fallback defaults until a proxy is configured.
            </span>
          ) : null}
        </div>
        <div data-ui="field-group">
          <label htmlFor="cors-proxy-secret">
            Proxy secret <em>(optional)</em>
            <InfoDisclosure title="Proxy secret">
              Sent as <code>X-Proxy-Secret</code>. Only needed when a self-hosted bouncer requires
              auth.
            </InfoDisclosure>
          </label>
          <input
            id="cors-proxy-secret"
            data-ui="cors-proxy-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="X-Proxy-Secret value"
            value={corsProxySecret.value}
            onChange={(e) => corsProxySecret.setValue(e.target.value)}
            onBlur={corsProxySecret.onBlur}
          />
        </div>
      </div>
    </>
  )
}

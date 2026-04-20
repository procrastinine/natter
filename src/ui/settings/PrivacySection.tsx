// Privacy controls block. See `plan/09-privacy.md §9.9` + `plan/10-ui.md §10.5.1`.
//
// Sits beneath the provider picker on the Model tab. Exposes the two
// axes the picker itself can't surface:
//   - `paretoFilter` — turn off the tier-based auto-exclusion
//   - `zdrOnly` — route only through ZDR-tagged endpoints
//   - `allowFallbacks` — provider-only retry within the current allowed set
// These live in `chat.settings.privacy` / `chat.settings.allowFallbacks`.
// Hidden entirely on non-OpenRouter connections because none apply there.

import { useCallback } from 'react'
import type { Chat } from '../../core/types'
import { updateChatSettings } from '../../store/chats'

export interface PrivacySectionProps {
  chat: Chat
}

export function PrivacySection({ chat }: PrivacySectionProps) {
  const prefs = chat.settings.providerPrefs ?? {}
  const privacy = chat.settings.privacy

  const setPareto = useCallback(
    (on: boolean) => {
      void updateChatSettings(chat.id, {
        privacy: { ...privacy, paretoFilter: on },
      })
    },
    [chat.id, privacy],
  )
  const setZdr = useCallback(
    (on: boolean) => {
      void updateChatSettings(chat.id, {
        privacy: { ...privacy, zdrOnly: on },
      })
    },
    [chat.id, privacy],
  )
  const setDenyCollection = useCallback(
    (on: boolean) => {
      void updateChatSettings(chat.id, {
        privacy: { ...privacy, denyDataCollection: on },
      })
    },
    [chat.id, privacy],
  )
  const setAllowFallbacks = useCallback(
    (on: boolean) => {
      const nextPrefs = { ...prefs } as typeof prefs & { allowFallbacks?: boolean }
      delete nextPrefs.allowFallbacks
      void updateChatSettings(chat.id, {
        allowFallbacks: on,
        providerPrefs: nextPrefs,
      })
    },
    [chat.id, prefs],
  )

  return (
    <div data-ui="settings-section" data-ui-section="privacy-section">
      <header data-ui="privacy-section-header">
        <h3>Privacy</h3>
      </header>
      <ul data-ui="privacy-section-list">
        <li>
          <label data-ui="privacy-toggle">
            <input
              type="checkbox"
              checked={privacy.paretoFilter === true}
              onChange={(e) => setPareto(e.target.checked)}
            />
            <span>
              <strong>Pareto filter</strong>
              <span data-ui="helper">
                Auto-exclude providers dominated by a stricter sibling (e.g. Google
                Vertex when Google AI Studio is available). Off: every non-training
                provider is offered; you pick manually.
              </span>
            </span>
          </label>
        </li>
        <li>
          <label data-ui="privacy-toggle">
            <input
              type="checkbox"
              checked={privacy.denyDataCollection === true}
              onChange={(e) => setDenyCollection(e.target.checked)}
            />
            <span>
              <strong>Deny data collection</strong>
              <span data-ui="helper">
                Asks OpenRouter to refuse any provider that would collect prompt
                data. Applies even when Pareto is off.
              </span>
            </span>
          </label>
        </li>
        <li>
          <label data-ui="privacy-toggle">
            <input
              type="checkbox"
              checked={privacy.zdrOnly === true}
              onChange={(e) => setZdr(e.target.checked)}
            />
            <span>
              <strong>ZDR-only routing</strong>
              <span data-ui="helper">
                Route only to endpoints OpenRouter flags as Zero Data Retention.
                Narrower than Pareto — can leave zero eligible providers for some
                models.
              </span>
            </span>
          </label>
        </li>
        <li>
          <label data-ui="privacy-toggle">
            <input
              type="checkbox"
              checked={chat.settings.allowFallbacks !== false}
              onChange={(e) => setAllowFallbacks(e.target.checked)}
            />
            <span>
              <strong>Allow provider fallbacks</strong>
              <span data-ui="helper">
                Retry another allowed provider for this same model when the
                first eligible provider fails or rate-limits. Never bypasses
                your allowed, ignored, or privacy-filtered provider set. Off =
                fail on the first eligible provider.
              </span>
            </span>
          </label>
        </li>
      </ul>
    </div>
  )
}

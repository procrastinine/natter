// Privacy controls block. See `plan/09-privacy.md §9.9` + `plan/10-ui.md §10.5.1`.
//
// Renders inline inside the Providers section on the Model tab. Exposes the
// axes the picker itself can't surface:
//   - `paretoFilter` — turn off the tier-based auto-exclusion
//   - `zdrOnly` — route only through ZDR-tagged endpoints
//   - `allowFallbacks` — provider-only retry within the current allowed set
// These live in `chat.settings.privacy` / `chat.settings.allowFallbacks`.
// Hidden entirely on non-OpenRouter connections because none apply there.

import { useCallback } from 'react'
import type { Chat } from '../../core/types'
import { updateChatSettings } from '../../store/chats'
import { InfoDisclosure } from './InfoDisclosure'

interface PrivacySectionProps {
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
    <div data-ui="privacy-block">
      <span data-ui="privacy-block-label">Privacy</span>
      <ul data-ui="privacy-section-list">
        <li>
          <label data-ui="privacy-toggle">
            <input
              type="checkbox"
              checked={privacy.paretoFilter === true}
              onChange={(e) => setPareto(e.target.checked)}
            />
            <span data-ui="privacy-toggle-copy">
              <span data-ui="privacy-toggle-title">
                <strong>Pareto filter</strong>
                <InfoDisclosure title="Auto-exclude providers dominated by a stricter sibling, such as Google Vertex when Google AI Studio is also available. Turn this off to offer every non-training provider and pick manually." />
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
            <span data-ui="privacy-toggle-copy">
              <span data-ui="privacy-toggle-title">
                <strong>Deny data collection</strong>
                <InfoDisclosure title="Ask OpenRouter to refuse any provider that would collect prompt data. This still applies even when the Pareto filter is off." />
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
            <span data-ui="privacy-toggle-copy">
              <span data-ui="privacy-toggle-title">
                <strong>ZDR-only routing</strong>
                <InfoDisclosure title="Route only to endpoints OpenRouter flags as Zero Data Retention. This is narrower than the Pareto filter and can leave some models with zero eligible providers." />
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
            <span data-ui="privacy-toggle-copy">
              <span data-ui="privacy-toggle-title">
                <strong>Allow provider fallbacks</strong>
                <InfoDisclosure title="Retry another allowed provider for the same model when the first eligible provider fails or rate-limits. This never bypasses the allowed, ignored, or privacy-filtered provider set. Turn it off to fail on the first eligible provider." />
              </span>
            </span>
          </label>
        </li>
      </ul>
    </div>
  )
}

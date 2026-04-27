import { useMemo, useState } from 'react'
import { prefillSettingsRecommendation } from '../../core/prefill-settings'
import type { ChatId, ChatSettings, ModelEndpoint } from '../../core/types'
import { updateChatSettings } from '../../store/chats'

export function PrefillSettingsPrompt({
  chatId,
  settings,
  endpoints = [],
}: {
  chatId: ChatId
  settings: ChatSettings
  endpoints?: readonly ModelEndpoint[]
}) {
  const recommendation = useMemo(
    () => prefillSettingsRecommendation(settings, endpoints),
    [settings, endpoints],
  )
  const [dismissed, setDismissed] = useState(false)

  if (!recommendation || dismissed) return null

  const label =
    recommendation.issues.length === 1
      ? recommendation.issues[0]
      : `${recommendation.issues.slice(0, -1).join(', ')} and ${recommendation.issues.at(-1)}`

  return (
    <div data-ui="prefill-settings-prompt" role="status">
      <span>For best prefill results: {label}.</span>
      <div data-ui="prefill-settings-actions">
        <button
          type="button"
          data-ui="field-inline-action"
          onClick={() => {
            void updateChatSettings(chatId, recommendation.patch)
            setDismissed(true)
          }}
        >
          Apply
        </button>
        <button
          type="button"
          data-ui="field-inline-action"
          onClick={() => setDismissed(true)}
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}

import { useState } from 'react'
import {
  configurationWriteInteraction,
  configurationWriteTarget,
} from '../../app/presentation-interactions'
import type { PrefillPlan } from '../../core/effective-endpoint-routing'
import type { ChatId } from '../../core/types'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { configurationApplication } from '../../store/configuration-application'
import { Button } from '../primitives/Button'

export function PrefillSettingsPrompt({ chatId, plan }: { chatId: ChatId; plan: PrefillPlan }) {
  const { run: runConfigurationWrite, isPending } = usePresentationInteraction(
    configurationWriteInteraction,
  )
  const recommendation = plan.availability === 'unsupported' ? undefined : plan.recommendation
  const warning = plan.availability === 'warned-attempt' ? plan.warning : undefined
  const recommendationLabel = recommendation
    ? recommendation.issues.length === 1
      ? recommendation.issues[0]
      : `${recommendation.issues.slice(0, -1).join(', ')} and ${recommendation.issues.at(-1)}`
    : undefined
  const message = [
    warning,
    recommendationLabel ? `For best prefill results: ${recommendationLabel}.` : null,
  ]
    .filter((part): part is string => part !== null && part !== undefined)
    .join(' ')
  const [dismissedMessage, setDismissedMessage] = useState<string | null>(null)
  const writeTarget = configurationWriteTarget(chatId, 'prefill-recommendation')
  const writePending = isPending(writeTarget)

  if (!message || dismissedMessage === message) return null

  return (
    <div data-ui="prefill-settings-prompt" role="status">
      <span>{message}</span>
      <div data-ui="prefill-settings-actions">
        {recommendation ? (
          <Button
            type="button"
            data-ui="field-inline-action"
            disabled={writePending}
            onClick={() => {
              runConfigurationWrite({
                target: writeTarget,
                action: () =>
                  configurationApplication.patchChatSettings(chatId, recommendation.patch),
                commit: () => {
                  setDismissedMessage(message)
                  return undefined
                },
              })
            }}
          >
            Apply
          </Button>
        ) : null}
        <Button
          type="button"
          data-ui="field-inline-action"
          disabled={writePending}
          onClick={() => setDismissedMessage(message)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}

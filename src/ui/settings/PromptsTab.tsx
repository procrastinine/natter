// Prompts tab body. Houses every prompt-shaped control on the chat:
// system, append, prefill (default text + continue-prefill toggle), and the
// continue-system / continue-user editors. Generation tab keeps the
// model-behavior knobs (reasoning, verbosity, sampling, stop) — splitting
// the two so neither pane scrolls forever.

import { prefillClassFor } from '../../core/quirks'
import type { Chat, ModelEndpoint } from '../../core/types'
import { PrefillSettingsSection } from './ParamForm'
import {
  AppendPromptEditor,
  ContinueSystemPromptEditor,
  ContinueUserPromptEditor,
  SystemPromptEditor,
} from './PromptPresetEditor'

interface PromptsTabProps {
  chat: Chat
  prefillRecommendationEndpoints?: readonly ModelEndpoint[] | undefined
}

export function PromptsTab({
  chat,
  prefillRecommendationEndpoints = [],
}: PromptsTabProps) {
  const prefillSupportedForModel = chat.settings.model
    ? prefillClassFor(chat.settings.model) !== 'unsupported'
    : false
  const continuePrefill = prefillSupportedForModel && chat.settings.continuePrefill === true
  return (
    <div data-ui="prompts-form">
      <SystemPromptEditor chat={chat} />
      <AppendPromptEditor chat={chat} defaultCollapsed />
      {prefillSupportedForModel ? (
        <PrefillSettingsSection chat={chat} endpoints={prefillRecommendationEndpoints} />
      ) : null}
      {continuePrefill ? null : <ContinueSystemPromptEditor chat={chat} defaultCollapsed />}
      {continuePrefill ? null : <ContinueUserPromptEditor chat={chat} defaultCollapsed />}
    </div>
  )
}

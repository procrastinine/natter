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

export function PromptsTab({ chat, prefillRecommendationEndpoints = [] }: PromptsTabProps) {
  const prefillSupportedForModel = chat.settings.model
    ? prefillClassFor(chat.settings.model) !== 'unsupported'
    : false
  const continuePrefill = prefillSupportedForModel && chat.settings.continuePrefill === true
  return (
    <div data-ui="prompts-form">
      <SystemPromptEditor key={`${chat.id}:system`} chat={chat} />
      <AppendPromptEditor key={`${chat.id}:append`} chat={chat} defaultCollapsed />
      {prefillSupportedForModel ? (
        <PrefillSettingsSection
          key={`${chat.id}:prefill`}
          chat={chat}
          endpoints={prefillRecommendationEndpoints}
        />
      ) : null}
      {continuePrefill ? null : (
        <ContinueSystemPromptEditor
          key={`${chat.id}:continue-system`}
          chat={chat}
          defaultCollapsed
        />
      )}
      {continuePrefill ? null : (
        <ContinueUserPromptEditor key={`${chat.id}:continue-user`} chat={chat} defaultCollapsed />
      )}
    </div>
  )
}

// Prompts tab body. Houses every prompt-shaped control on the chat:
// system, append, prefill (default text + continue-prefill toggle), and the
// continue-system / continue-user editors. Generation tab keeps the
// model-behavior knobs (reasoning, verbosity, sampling, stop) — splitting
// the two so neither pane scrolls forever.

import { useEffect, useState } from 'react'
import {
  connectionConfigurationWriteTarget,
  workspaceConfigurationWriteInteraction,
} from '../../app/presentation-interactions'
import type { PrefillPlan } from '../../core/effective-endpoint-routing'
import type { Chat, ConnectionProfile, EndpointPrefillCapability } from '../../core/types'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { configurationApplication } from '../../store/configuration-application'
import { PrefillSettingsSection } from './ParamForm'
import {
  AppendPromptEditor,
  ContinueSystemPromptEditor,
  ContinueUserPromptEditor,
  SystemPromptEditor,
} from './PromptPresetEditor'

interface PromptsTabProps {
  chat: Chat
  profile?: ConnectionProfile
  prefillPlan: PrefillPlan
}

export function PromptsTab({ chat, profile, prefillPlan }: PromptsTabProps) {
  const prefillSupported = prefillPlan.availability !== 'unsupported'
  const continuePrefill = prefillSupported && chat.settings.continuePrefill === true
  return (
    <div data-ui="prompts-form">
      <SystemPromptEditor key={`${chat.id}:system`} chat={chat} />
      <AppendPromptEditor key={`${chat.id}:append`} chat={chat} defaultCollapsed />
      {prefillSupported ? (
        <PrefillSettingsSection key={`${chat.id}:prefill`} chat={chat} prefillPlan={prefillPlan} />
      ) : null}
      {profile &&
      profile.kind !== 'openrouter' &&
      profile.kind !== 'google' &&
      profile.kind !== 'anthropic' ? (
        <DirectPrefillCapabilityControl
          key={`${profile.id}:${chat.settings.model}:prefill-capability`}
          profile={profile}
          model={chat.settings.model}
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

type DirectPrefillValue =
  | 'automatic'
  | 'unsupported'
  | 'assistant-tail:none'
  | 'assistant-tail:partial'
  | 'assistant-tail:prefix'

function DirectPrefillCapabilityControl({
  profile,
  model,
}: {
  profile: ConnectionProfile
  model: string
}) {
  const persisted = directPrefillValue(profile.capabilityOverrides?.[model]?.prefill)
  const [value, setValue] = useState<DirectPrefillValue>(persisted)
  const { run: runConfigurationWrite, isPending } = usePresentationInteraction(
    workspaceConfigurationWriteInteraction,
  )
  const writeTarget = connectionConfigurationWriteTarget(
    profile.id,
    `model:${model}:prefill-capability`,
  )
  const writePending = isPending(writeTarget)
  useEffect(() => {
    if (!writePending) setValue(persisted)
  }, [persisted, writePending])

  return (
    <label data-control="prefill-capability-control">
      <span>Direct endpoint assistant prefill</span>
      <select
        value={value}
        disabled={writePending || !model}
        onChange={(event) => {
          const next = event.target.value as DirectPrefillValue
          setValue(next)
          runConfigurationWrite({
            target: writeTarget,
            action: () =>
              configurationApplication.editConnection({
                profile,
                patch: { capabilityOverrides: withDirectPrefill(profile, model, next) },
              }),
          })
        }}
      >
        <option value="automatic">Automatic / unknown</option>
        <option value="assistant-tail:none">Bare assistant tail</option>
        <option value="assistant-tail:partial">Assistant tail + partial</option>
        <option value="assistant-tail:prefix">Assistant tail + prefix</option>
        <option value="unsupported">Unsupported</option>
      </select>
      <small>Applies to this model on this connection. Unknown endpoints are attempted once.</small>
    </label>
  )
}

function directPrefillValue(capability: EndpointPrefillCapability | undefined): DirectPrefillValue {
  if (!capability) return 'automatic'
  if (capability.kind === 'unsupported') return 'unsupported'
  if (capability.kind === 'assistant-tail') return `assistant-tail:${capability.marker}`
  return 'automatic'
}

function withDirectPrefill(
  profile: ConnectionProfile,
  model: string,
  value: DirectPrefillValue,
): NonNullable<ConnectionProfile['capabilityOverrides']> {
  const overrides = structuredClone(profile.capabilityOverrides ?? {})
  const current = { ...(overrides[model] ?? {}) }
  if (value === 'automatic') {
    delete current.prefill
    if (Object.keys(current).length === 0) delete overrides[model]
    else overrides[model] = current
    return overrides
  }
  current.prefill =
    value === 'unsupported'
      ? { kind: 'unsupported' }
      : {
          kind: 'assistant-tail',
          marker: value.slice('assistant-tail:'.length) as 'none' | 'partial' | 'prefix',
        }
  overrides[model] = current
  return overrides
}

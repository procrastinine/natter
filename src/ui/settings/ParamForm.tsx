// Renders only controls whose wire-key is in the effective capability's
// `supportedParameters`. For reasoning effort / verbosity the value set
// is narrowed against the quirks registry, e.g. Claude 4.7 shows the
// "verbosity" segmented control with xhigh as the ceiling, and adaptive-
// only models hide the effort segmented control entirely.
//
// Stored settings remain a preference reservoir across model changes. The
// request planner derives the capability-valid request snapshot, so merely
// mounting this panel never mutates durable chat state.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LlamaServerProps } from '../../api/probe'
import {
  configurationWriteInteraction,
  configurationWriteTarget,
} from '../../app/presentation-interactions'
import {
  type AssistantRouteContract,
  isResponsesCapable,
  isTextCompletionsCapable,
} from '../../core/api-choice'
import type { EffectiveCapability } from '../../core/capabilities'
import type { ChatSettingsFieldPatch } from '../../core/chat-metadata'
import type { PrefillPlan } from '../../core/effective-endpoint-routing'
import { type HostedToolProvider, isOpenAiDirectProfile } from '../../core/provider-hosted-tools'
import {
  emitsEncryptedReasoningFor,
  reasoningToggleableFor,
  responsesSupportFor,
} from '../../core/quirks'
import type {
  AnthropicServerToolId,
  Chat,
  ConnectionKind,
  ConnectionProfile,
  GoogleServerToolId,
  OpenAiServerToolId,
  OpenRouterServerToolId,
  ReasoningInclude,
  SamplingKey,
  VerbosityLevel,
} from '../../core/types'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { useSettledChatSettingsEdit } from '../../hooks/useSettledConfigurationEdit'
import { configurationApplication } from '../../store/configuration-application'
import { PrefillSettingsPrompt } from '../chat/PrefillSettingsPrompt'
import { Button } from '../primitives/Button'
import { InfoDisclosure } from './InfoDisclosure'
import { PrefillPromptEditor } from './PromptPresetEditor'
import { TextTemplateSection } from './TextTemplateSection'

interface ParamFormProps {
  chat: Chat
  capability: EffectiveCapability | null
  assistantRouteKind?: AssistantRouteContract['kind'] | null | undefined
  textTemplateMode?: 'openrouter' | 'llama-server' | null | undefined
  llamaProps?: LlamaServerProps | null | undefined
  connectionKind?: ConnectionKind | undefined
  connectionProfile?: ConnectionProfile | null | undefined
  textCompletionsActive?: boolean | undefined
}

interface SamplingSpec {
  key: SamplingKey
  wire: string
  label: string
  // Inclusive bounds for validation. When a value falls outside, it's
  // rejected (no silent clamp — user should see that the value didn't stick).
  min: number
  max: number
  // Tooltip description. Surfaced via an info button so the main UI stays
  // quiet.
  hint: string
  // Integer-only fields reject fractional values.
  integer?: boolean
}

const SAMPLING_FIELDS: SamplingSpec[] = [
  {
    key: 'temperature',
    wire: 'temperature',
    label: 'Temperature',
    min: 0,
    max: 2,
    hint: 'Randomness. 0 is deterministic; higher values explore. Default is provider-specific (usually 1).',
  },
  {
    key: 'top_p',
    wire: 'top_p',
    label: 'Top-p',
    min: 0,
    max: 1,
    hint: 'Nucleus sampling. Consider the smallest token set whose probabilities sum to at least p.',
  },
  {
    key: 'top_k',
    wire: 'top_k',
    label: 'Top-k',
    min: 0,
    max: 1000,
    integer: true,
    hint: 'Consider only the k most likely tokens. 0 disables.',
  },
  {
    key: 'min_p',
    wire: 'min_p',
    label: 'Min-p',
    min: 0,
    max: 1,
    hint: 'Drop tokens whose probability is below min_p × max-probability in the current step.',
  },
  {
    key: 'top_a',
    wire: 'top_a',
    label: 'Top-a',
    min: 0,
    max: 1,
    hint: 'Drop tokens whose probability is below top_a × (max-probability)². Supported by some providers (Mistral, OpenRouter).',
  },
  {
    key: 'frequency_penalty',
    wire: 'frequency_penalty',
    label: 'Frequency penalty',
    min: -2,
    max: 2,
    hint: 'Penalize tokens proportional to how often they appeared. Positive discourages repetition.',
  },
  {
    key: 'presence_penalty',
    wire: 'presence_penalty',
    label: 'Presence penalty',
    min: -2,
    max: 2,
    hint: 'Flat penalty for tokens that already appeared anywhere in the context.',
  },
  {
    key: 'repetition_penalty',
    wire: 'repetition_penalty',
    label: 'Repetition penalty',
    min: 0,
    max: 2,
    hint: 'Penalty applied to previously-emitted tokens. 1.0 is neutral.',
  },
  {
    key: 'seed',
    wire: 'seed',
    label: 'Seed',
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
    integer: true,
    hint: 'Fix RNG seed for reproducible sampling. Leave empty for random.',
  },
  // llama.cpp-only knobs. These render only when the effective capability
  // lists them in supportedParameters — today that means the llama-server
  // kind. All defaults / bounds follow llama_server.md §sampling params.
  {
    key: 'typical_p',
    wire: 'typical_p',
    label: 'Typical-p',
    min: 0,
    max: 1,
    hint: 'Locally typical sampling. 1.0 disables.',
  },
  {
    key: 'repeat_penalty',
    wire: 'repeat_penalty',
    label: 'Repeat penalty',
    min: 0,
    max: 2,
    hint: 'Penalize repeated token sequences. 1.0 is neutral (llama.cpp-only; not the OpenRouter repetition_penalty).',
  },
  {
    key: 'repeat_last_n',
    wire: 'repeat_last_n',
    label: 'Repeat last N',
    min: -1,
    max: 131072,
    integer: true,
    hint: 'How many prior tokens the repeat penalty looks at. 0 disables, -1 uses ctx size.',
  },
  {
    key: 'dynatemp_range',
    wire: 'dynatemp_range',
    label: 'DynaTemp range',
    min: 0,
    max: 5,
    hint: 'Dynamic-temperature spread around `temperature`. 0 disables.',
  },
  {
    key: 'dynatemp_exponent',
    wire: 'dynatemp_exponent',
    label: 'DynaTemp exponent',
    min: 0,
    max: 4,
    hint: 'Dynamic-temperature curve. Only meaningful when DynaTemp range > 0.',
  },
  {
    key: 'mirostat',
    wire: 'mirostat',
    label: 'Mirostat',
    min: 0,
    max: 2,
    integer: true,
    hint: '0 disables. 1 = Mirostat. 2 = Mirostat 2.0. Ignores top-k/top-p/typical-p when active.',
  },
  {
    key: 'mirostat_tau',
    wire: 'mirostat_tau',
    label: 'Mirostat τ',
    min: 0,
    max: 20,
    hint: 'Target entropy (τ). Only used when Mirostat ≠ 0.',
  },
  {
    key: 'mirostat_eta',
    wire: 'mirostat_eta',
    label: 'Mirostat η',
    min: 0,
    max: 1,
    hint: 'Learning rate (η). Only used when Mirostat ≠ 0.',
  },
  {
    key: 'xtc_probability',
    wire: 'xtc_probability',
    label: 'XTC probability',
    min: 0,
    max: 1,
    hint: 'Chance of the XTC sampler firing per token. 0 disables.',
  },
  {
    key: 'xtc_threshold',
    wire: 'xtc_threshold',
    label: 'XTC threshold',
    min: 0,
    max: 1,
    hint: 'Minimum token probability for XTC removal eligibility. > 0.5 disables XTC.',
  },
  {
    key: 'dry_multiplier',
    wire: 'dry_multiplier',
    label: 'DRY multiplier',
    min: 0,
    max: 5,
    hint: 'DRY penalty multiplier. 0 disables.',
  },
  {
    key: 'dry_base',
    wire: 'dry_base',
    label: 'DRY base',
    min: 0,
    max: 5,
    hint: 'DRY exponential base for the repeat penalty curve.',
  },
  {
    key: 'dry_allowed_length',
    wire: 'dry_allowed_length',
    label: 'DRY allowed length',
    min: 0,
    max: 128,
    integer: true,
    hint: 'Tokens beyond this repeating length receive DRY penalty.',
  },
  {
    key: 'dry_penalty_last_n',
    wire: 'dry_penalty_last_n',
    label: 'DRY scan length',
    min: -1,
    max: 131072,
    integer: true,
    hint: 'How many prior tokens DRY scans. 0 disables, -1 uses ctx size.',
  },
  {
    key: 'n_keep',
    wire: 'n_keep',
    label: 'Keep N (n_keep)',
    min: -1,
    max: 131072,
    integer: true,
    hint: 'Tokens from the prompt to retain when context overflows. Excludes BOS.',
  },
]

const OPENROUTER_HOSTED_TOOL_OPTIONS: ReadonlyArray<{
  id: OpenRouterServerToolId
  label: string
  help: string
}> = [
  { id: 'web-search', label: 'Web search', help: 'OpenRouter runs the search server-side.' },
  { id: 'datetime', label: 'Datetime', help: 'OpenRouter supplies current date/time context.' },
  { id: 'web-fetch', label: 'Web fetch', help: 'OpenRouter fetches URLs server-side.' },
  {
    id: 'shell',
    label: 'Shell',
    help: 'OpenRouter runs commands in a hosted sandbox through the Responses API.',
  },
]

const OPENAI_HOSTED_TOOL_OPTIONS: ReadonlyArray<{
  id: OpenAiServerToolId
  label: string
  help: string
}> = [
  { id: 'web-search', label: 'Web search', help: 'OpenAI Responses web search.' },
  { id: 'image-generation', label: 'Image generation', help: 'OpenAI hosted image tool.' },
  { id: 'code-interpreter', label: 'Code interpreter', help: 'OpenAI provider-hosted Python.' },
  { id: 'shell', label: 'Shell', help: "OpenAI's provider-hosted container shell." },
]

const GOOGLE_HOSTED_TOOL_OPTIONS: ReadonlyArray<{
  id: GoogleServerToolId
  label: string
  help: string
}> = [
  { id: 'google-search', label: 'Google Search', help: 'Gemini native search grounding.' },
  { id: 'url-context', label: 'URL context', help: 'Gemini reads URLs explicitly in context.' },
  { id: 'code-execution', label: 'Code execution', help: 'Gemini provider-hosted Python.' },
]

const ANTHROPIC_HOSTED_TOOL_OPTIONS: ReadonlyArray<{
  id: AnthropicServerToolId
  label: string
  help: string
}> = [
  { id: 'web-search', label: 'Web search', help: 'Claude searches the web server-side.' },
  { id: 'web-fetch', label: 'Web fetch', help: 'Claude fetches explicit URLs server-side.' },
  { id: 'code-execution', label: 'Code execution', help: 'Claude provider-hosted code sandbox.' },
  { id: 'advisor', label: 'Advisor', help: 'Claude consults a higher-capability advisor model.' },
]

export function ParamForm({
  chat,
  capability,
  assistantRouteKind = null,
  textTemplateMode = null,
  llamaProps = null,
  connectionKind = 'custom',
  connectionProfile = null,
  textCompletionsActive = false,
}: ParamFormProps) {
  if (!chat.settings.model) {
    return (
      <div data-ui="param-form">
        <section data-ui="settings-section" data-ui-section="generation-empty">
          <h3>Generation</h3>
          <p data-ui="helper">Select a model first.</p>
        </section>
      </div>
    )
  }

  if (!capability) {
    return (
      <div data-ui="param-form">
        <section data-ui="settings-section" data-ui-section="generation-empty">
          <h3>Generation</h3>
          <p data-ui="helper">Waiting for model capability…</p>
        </section>
      </div>
    )
  }

  // Reasoning → verbosity → hosted tools → sampling → stop / text template.
  // Prompt-slot editors moved to the dedicated Prompts tab in `PromptsTab.tsx`
  // so the Generation tab stays focused on knobs the model layer cares about.
  return (
    <div data-ui="param-form">
      <ReasoningSection chat={chat} capability={capability} />
      <VerbositySection chat={chat} capability={capability} />
      <HostedToolsSection
        chat={chat}
        capability={capability}
        assistantRouteKind={assistantRouteKind}
        connectionKind={connectionKind}
        connectionProfile={connectionProfile}
        textCompletionsActive={textCompletionsActive}
      />
      <SamplingSection chat={chat} capability={capability} showStopInline={!textTemplateMode} />
      {textTemplateMode ? (
        <TextTemplateSection
          chat={chat}
          mode={textTemplateMode}
          llamaProps={llamaProps}
          heading="Text completions template and stops"
          requestStopControl={
            <StopTextAreaControl
              chat={chat}
              capability={capability}
              label="Additional stop sequences"
              helper="Merged with the selected template stop sequences on the wire."
            />
          }
        />
      ) : null}
    </div>
  )
}

export function PrefillSettingsSection({
  chat,
  prefillPlan,
}: {
  chat: Chat
  prefillPlan: PrefillPlan
}) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  const continuePrefill = chat.settings.continuePrefill === true
  const toggleContinuePrefill = () =>
    runConfigurationWrite({
      target: configurationWriteTarget(chat.id, 'continuePrefill'),
      action: () =>
        configurationApplication.patchChatSettings(chat.id, {
          continuePrefill: !continuePrefill,
        }),
    })
  return (
    <PrefillPromptEditor chat={chat}>
      <div data-ui="field-group" data-ui-field>
        <label data-ui="checkbox-row">
          <input
            type="checkbox"
            checked={continuePrefill}
            onChange={toggleContinuePrefill}
            data-ui="continue-prefill-toggle"
          />
          <span>Continue prefill</span>
        </label>
      </div>
      {continuePrefill ? <PrefillSettingsPrompt chatId={chat.id} plan={prefillPlan} /> : null}
    </PrefillPromptEditor>
  )
}

function HostedToolsSection({
  chat,
  capability,
  assistantRouteKind,
  connectionKind,
  connectionProfile,
  textCompletionsActive,
}: {
  chat: Chat
  capability: EffectiveCapability
  assistantRouteKind: AssistantRouteContract['kind'] | null
  connectionKind: ConnectionKind
  connectionProfile?: ConnectionProfile | null | undefined
  textCompletionsActive: boolean
}) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  const config = hostedToolUiConfig({
    connectionKind,
    connectionProfile,
    chat,
    capability,
    assistantRouteKind,
  })
  if (!config || textCompletionsActive) {
    return null
  }
  const options =
    config.provider === 'anthropic'
      ? config.options.filter(
          (option) => option.id !== 'advisor' || anthropicAdvisorAvailable(chat.settings.model),
        )
      : config.options
  if (options.length === 0) return null
  const bucket = chat.settings.tools[config.provider]
  const selected = bucket.enabledServerToolIds as string[]
  const enabledCount = options.filter((option) => selected.includes(option.id)).length

  const toggle = (id: string, checked: boolean) => {
    runConfigurationWrite({
      target: configurationWriteTarget(
        chat.id,
        `tools.${config.provider}.enabledServerToolIds:${id}`,
      ),
      action: () =>
        configurationApplication.patchChatSettingsFields(chat.id, [
          {
            path: ['tools', config.provider, 'enabledServerToolIds'],
            membership: { member: id, present: checked },
          },
        ]),
    })
  }

  return (
    <section data-ui="settings-section" data-ui-section="hosted-tools">
      <h3>
        {config.title}
        {enabledCount > 0 ? (
          <>
            {' '}
            <span data-ui="field-value">{enabledCount} enabled</span>
          </>
        ) : null}
      </h3>
      <div data-ui="field-group" data-ui-field>
        {options.map((option) => {
          const enabled = selected.includes(option.id)
          return (
            <div key={option.id} data-ui="hosted-tool-row">
              <label data-ui="checkbox-row">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => toggle(option.id, e.target.checked)}
                />
                <span>{option.label}</span>
                <InfoDisclosure title={option.help} />
              </label>
              {enabled ? (
                <HostedToolConfigControls
                  chat={chat}
                  provider={config.provider}
                  toolId={option.id}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

type HostedToolUiOption = {
  id: string
  label: string
  help: string
}

function hostedToolUiConfig(input: {
  connectionKind: ConnectionKind
  connectionProfile?: ConnectionProfile | null | undefined
  chat: Chat
  capability: EffectiveCapability
  assistantRouteKind: AssistantRouteContract['kind'] | null
}): {
  provider: HostedToolProvider
  title: string
  options: readonly HostedToolUiOption[]
} | null {
  if (!input.capability.supportedParameters.has('tools')) return null
  if (input.connectionKind === 'openrouter') {
    return {
      provider: 'openrouter',
      title: 'OpenRouter tools',
      options: OPENROUTER_HOSTED_TOOL_OPTIONS.filter(
        (option) => option.id !== 'shell' || input.assistantRouteKind === 'responses',
      ),
    }
  }
  const profile = input.connectionProfile
  if (
    (profile ? isOpenAiDirectProfile(profile) : input.connectionKind === 'openai-compatible') &&
    input.capability.supportedParameters.has('tools')
  ) {
    return { provider: 'openai', title: 'OpenAI tools', options: OPENAI_HOSTED_TOOL_OPTIONS }
  }
  if (input.connectionKind === 'google' && input.chat.settings.api !== 'chat') {
    return { provider: 'google', title: 'Gemini tools', options: GOOGLE_HOSTED_TOOL_OPTIONS }
  }
  if (input.connectionKind === 'anthropic' && input.chat.settings.api !== 'chat') {
    return {
      provider: 'anthropic',
      title: 'Anthropic tools',
      options: ANTHROPIC_HOSTED_TOOL_OPTIONS,
    }
  }
  return null
}

function HostedToolConfigControls({
  chat,
  provider,
  toolId,
}: {
  chat: Chat
  provider: HostedToolProvider
  toolId: string
}) {
  if (provider === 'openai') {
    return <OpenAiHostedToolConfig chat={chat} toolId={toolId as OpenAiServerToolId} />
  }
  if (provider === 'google') {
    return <GoogleHostedToolConfig chat={chat} toolId={toolId as GoogleServerToolId} />
  }
  if (provider === 'anthropic') {
    return <AnthropicHostedToolConfig chat={chat} toolId={toolId as AnthropicServerToolId} />
  }
  return null
}

function OpenAiHostedToolConfig({ chat, toolId }: { chat: Chat; toolId: OpenAiServerToolId }) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  const config = chat.settings.tools.openai.config ?? {}
  const updateConfig = (tool: string, patch: Record<string, unknown>) => {
    const fields = Object.entries(patch)
    runConfigurationWrite({
      target: configurationWriteTarget(
        chat.id,
        fields
          .map(([field]) => `tools.openai.config.${tool}.${field}`)
          .sort()
          .join('+'),
      ),
      action: () =>
        configurationApplication.patchChatSettingsFields(
          chat.id,
          fields.map(([field, value]) => ({
            path: ['tools', 'openai', 'config', tool, field],
            value,
          })),
        ),
    })
  }
  if (toolId === 'web-search') {
    const web = config['web-search'] ?? {}
    return (
      <div data-ui="hosted-tool-config">
        <div data-ui="field-group" data-ui-field>
          <span>Search context</span>
          <div data-ui="segmented">
            {(['low', 'medium', 'high'] as const).map((value) => (
              <Button
                key={value}
                type="button"
                data-ui="segmented-option"
                aria-pressed={(web.searchContextSize ?? 'medium') === value}
                onClick={() => updateConfig('web-search', { searchContextSize: value })}
              >
                {value}
              </Button>
            ))}
          </div>
        </div>
        <label data-ui="checkbox-row">
          <input
            type="checkbox"
            checked={web.includeSources === true}
            onChange={(e) => updateConfig('web-search', { includeSources: e.target.checked })}
          />
          <span>Include sources</span>
        </label>
      </div>
    )
  }
  if (toolId === 'image-generation') {
    const image = config['image-generation'] ?? {}
    return (
      <div data-ui="hosted-tool-config">
        <div data-ui="field-group" data-ui-field>
          <span>Image output</span>
          <select
            aria-label="Image format"
            value={image.format ?? 'png'}
            onChange={(e) =>
              updateConfig('image-generation', {
                format: e.target.value,
              })
            }
          >
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
          <select
            aria-label="Image size"
            value={image.size ?? 'auto'}
            onChange={(e) =>
              updateConfig('image-generation', {
                size: e.target.value,
              })
            }
          >
            <option value="auto">auto</option>
            <option value="1024x1024">1024x1024</option>
            <option value="1024x1536">1024x1536</option>
            <option value="1536x1024">1536x1024</option>
          </select>
        </div>
      </div>
    )
  }
  if (toolId === 'shell') {
    return <span data-ui="helper">Runs in OpenAI's provider container with network disabled.</span>
  }
  return <span data-ui="helper">Runs provider-hosted Python without local file uploads.</span>
}

function GoogleHostedToolConfig({ chat, toolId }: { chat: Chat; toolId: GoogleServerToolId }) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  if (toolId !== 'google-search') return null
  const config = chat.settings.tools.google.config ?? {}
  const search = config['google-search'] ?? {}
  return (
    <label data-ui="checkbox-row">
      <input
        type="checkbox"
        checked={search.renderSearchEntryPoint === true}
        onChange={(e) =>
          runConfigurationWrite({
            target: configurationWriteTarget(
              chat.id,
              'tools.google.config.google-search.renderSearchEntryPoint',
            ),
            action: () =>
              configurationApplication.patchChatSettingsFields(chat.id, [
                {
                  path: ['tools', 'google', 'config', 'google-search', 'renderSearchEntryPoint'],
                  value: e.target.checked,
                },
              ]),
          })
        }
      />
      <span>Render search entry point when returned</span>
    </label>
  )
}

function AnthropicHostedToolConfig({
  chat,
  toolId,
}: {
  chat: Chat
  toolId: AnthropicServerToolId
}) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  const config = chat.settings.tools.anthropic.config ?? {}
  const updateConfig = (tool: string, patch: Record<string, unknown>) => {
    const fields = Object.entries(patch)
    runConfigurationWrite({
      target: configurationWriteTarget(
        chat.id,
        fields
          .map(([field]) => `tools.anthropic.config.${tool}.${field}`)
          .sort()
          .join('+'),
      ),
      action: () =>
        configurationApplication.patchChatSettingsFields(
          chat.id,
          fields.map(([field, value]) => ({
            path: ['tools', 'anthropic', 'config', tool, field],
            value,
          })),
        ),
    })
  }

  if (toolId === 'web-search') {
    const web = config['web-search'] ?? {}
    return (
      <div data-ui="hosted-tool-config">
        <div data-ui="field-group" data-ui-field>
          <span>Version</span>
          <select
            aria-label="Anthropic web search version"
            value={web.version ?? 'web_search_20250305'}
            onChange={(e) =>
              updateConfig('web-search', {
                version: e.target.value,
              })
            }
          >
            <option value="web_search_20250305">Basic</option>
            <option value="web_search_20260209">Dynamic filtering</option>
          </select>
          <NumberField
            chatId={chat.id}
            fieldKey="tools.anthropic.config.web-search.maxUses"
            label="Max uses"
            value={web.maxUses}
            min={1}
            max={100}
            patches={(value) => [
              {
                path: ['tools', 'anthropic', 'config', 'web-search', 'maxUses'],
                value,
              },
            ]}
          />
        </div>
      </div>
    )
  }

  if (toolId === 'web-fetch') {
    const fetch = config['web-fetch'] ?? {}
    return (
      <div data-ui="hosted-tool-config">
        <div data-ui="field-group" data-ui-field>
          <span>Version</span>
          <select
            aria-label="Anthropic web fetch version"
            value={fetch.version ?? 'web_fetch_20250910'}
            onChange={(e) =>
              updateConfig('web-fetch', {
                version: e.target.value,
              })
            }
          >
            <option value="web_fetch_20250910">Basic</option>
            <option value="web_fetch_20260209">Dynamic filtering</option>
          </select>
          <NumberField
            chatId={chat.id}
            fieldKey="tools.anthropic.config.web-fetch.maxUses"
            label="Max uses"
            value={fetch.maxUses}
            min={1}
            max={100}
            patches={(value) => [
              {
                path: ['tools', 'anthropic', 'config', 'web-fetch', 'maxUses'],
                value,
              },
            ]}
          />
          <NumberField
            chatId={chat.id}
            fieldKey="tools.anthropic.config.web-fetch.maxContentTokens"
            label="Max content tokens"
            value={fetch.maxContentTokens}
            min={1}
            max={200000}
            patches={(value) => [
              {
                path: ['tools', 'anthropic', 'config', 'web-fetch', 'maxContentTokens'],
                value,
              },
            ]}
          />
        </div>
        <label data-ui="checkbox-row">
          <input
            type="checkbox"
            checked={fetch.citationsEnabled === true}
            onChange={(e) => updateConfig('web-fetch', { citationsEnabled: e.target.checked })}
          />
          <span>Include citations</span>
        </label>
      </div>
    )
  }

  if (toolId === 'code-execution') {
    const code = config['code-execution'] ?? {}
    return (
      <div data-ui="hosted-tool-config">
        <div data-ui="field-group" data-ui-field>
          <span>Version</span>
          <select
            aria-label="Anthropic code execution version"
            value={code.version ?? 'code_execution_20250825'}
            onChange={(e) =>
              updateConfig('code-execution', {
                version: e.target.value,
              })
            }
          >
            <option value="code_execution_20250825">Current</option>
            <option value="code_execution_20260120">2026 beta</option>
          </select>
        </div>
        <span data-ui="helper">Provider-hosted sandbox; local files are not uploaded.</span>
      </div>
    )
  }

  const advisor = config.advisor ?? { advisorModel: 'claude-opus-4-7' as const }
  return (
    <div data-ui="hosted-tool-config" data-tool="advisor">
      <div data-ui="field-group" data-ui-field>
        <span>Advisor model</span>
        <select
          aria-label="Anthropic advisor model"
          value={advisor.advisorModel}
          onChange={() => updateConfig('advisor', { advisorModel: 'claude-opus-4-7' })}
        >
          <option value="claude-opus-4-7">Claude Opus 4.7</option>
        </select>
      </div>
    </div>
  )
}

function anthropicAdvisorAvailable(modelId: string): boolean {
  const normalized = modelId
    .replace(/^anthropic\//u, '')
    .replace(/(\d)\.(\d)(?=-|$)/g, '$1-$2')
    .replace(/-\d{8}$/u, '')
  return new Set([
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'claude-opus-4-7',
  ]).has(normalized)
}

function NumberField({
  chatId,
  fieldKey,
  label,
  value,
  min,
  max,
  patches,
}: {
  chatId: Chat['id']
  fieldKey: string
  label: string
  value: number | undefined
  min: number
  max: number
  patches: (value: number | undefined) => readonly ChatSettingsFieldPatch[]
}) {
  const edit = useSettledChatSettingsEdit({
    chatId,
    fieldKey,
    storedValue: value,
    patches,
  })
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  useEffect(() => {
    setDraft(value === undefined ? '' : String(value))
  }, [value])
  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) {
      edit.setValue(undefined)
      edit.onBlur()
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return
    edit.setValue(Math.min(max, Math.max(min, Math.trunc(parsed))))
    edit.onBlur()
  }
  return (
    <label data-ui="inline-control-row">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          if (next.trim().length === 0) edit.setValue(undefined)
          else {
            const parsed = Number(next)
            if (Number.isFinite(parsed)) {
              edit.setValue(Math.min(max, Math.max(min, Math.trunc(parsed))))
            }
          }
        }}
        onBlur={commit}
      />
    </label>
  )
}

function SamplingSection({
  chat,
  capability,
  showStopInline = false,
}: {
  chat: Chat
  capability: EffectiveCapability
  showStopInline?: boolean
}) {
  const visible = SAMPLING_FIELDS.filter((s) => capability.supportedParameters.has(s.wire))
  const hasLogitBias = capability.supportedParameters.has('logit_bias')
  const hasStop =
    capability.supportedParameters.has('stop') ||
    capability.supportedParameters.has('stop_sequences')
  const showStop = showStopInline && hasStop
  if (visible.length === 0 && !hasLogitBias && !showStop) return null
  return (
    <section data-ui="settings-section" data-ui-section="sampling">
      <h3>Sampling</h3>
      {visible.length > 0 ? (
        <div data-ui="sampling-grid">
          {visible.map((s) => (
            <SamplingInput
              key={s.key}
              chatId={chat.id}
              spec={s}
              value={chat.settings.sampling[s.key]}
            />
          ))}
        </div>
      ) : null}
      {showStop ? <StopInlineRow chat={chat} capability={capability} /> : null}
      <LogitBiasSection chat={chat} capability={capability} />
    </section>
  )
}

function ReasoningSection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  const hasReasoning =
    capability.supportedParameters.has('reasoning') ||
    capability.supportedParameters.has('thinking') ||
    capability.supportedParameters.has('include_reasoning')
  if (!hasReasoning) return null
  const adaptiveOnly = capability.quirks.adaptiveReasoningOnly === true
  const effortChoices = adaptiveOnly ? [] : capability.allowedEffort
  const supportsReasoning =
    capability.supportedParameters.has('reasoning') ||
    capability.supportedParameters.has('thinking')
  const supportsBudget = supportsReasoning && !adaptiveOnly
  // Models in the P.7 reasoning-required list reject `reasoning.enabled:
  // false` outright (or accept it silently while still emitting reasoning
  // tokens). Hide the "off" mode so the UI doesn't offer a setting that
  // 400s on the wire.
  const reasoningToggleable = chat.settings.model
    ? reasoningToggleableFor(chat.settings.model)
    : true
  const modes = (['default', 'off', 'enabled', 'effort', 'budget'] as const).filter((m) => {
    if (m === 'off') return reasoningToggleable
    if (m === 'effort') return effortChoices.length > 0
    if (m === 'budget') return supportsBudget
    return true
  })
  const modeInfo = adaptiveOnly
    ? 'This model uses adaptive thinking when enabled; effort and budget are ignored.'
    : effortChoices.length === 0 && supportsBudget
      ? 'Enabled uses adaptive thinking. Budget uses a fixed token cap.'
      : null
  const r = chat.settings.reasoning
  const updateReasoning = (patch: Partial<typeof r>) => {
    const fields = Object.entries(patch)
    runConfigurationWrite({
      target: configurationWriteTarget(
        chat.id,
        fields
          .map(([key]) => `reasoning.${key}`)
          .sort()
          .join('+'),
      ),
      action: () =>
        configurationApplication.patchChatSettingsFields(
          chat.id,
          fields.map(([key, value]) => ({ path: ['reasoning', key], value })),
        ),
    })
  }
  return (
    <section data-ui="settings-section" data-ui-section="reasoning">
      <h3>Reasoning</h3>
      <div data-ui="field-group" data-ui-field>
        <span>Mode {modeInfo ? <InfoDisclosure title={modeInfo} /> : null}</span>
        <div data-ui="segmented">
          {modes.map((m) => (
            <Button
              key={m}
              type="button"
              data-ui="segmented-option"
              aria-pressed={r.mode === m}
              onClick={() => updateReasoning({ mode: m })}
            >
              {m}
            </Button>
          ))}
        </div>
      </div>
      {r.mode === 'effort' && effortChoices.length > 0 ? (
        <div data-ui="field-group" data-ui-field>
          <span>Effort</span>
          <div data-ui="segmented">
            {effortChoices.map((e) => (
              <Button
                key={e}
                type="button"
                data-ui="segmented-option"
                aria-pressed={r.effort === e}
                onClick={() => updateReasoning({ effort: e })}
              >
                {e}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      {r.mode === 'budget' && supportsBudget ? (
        <ReasoningBudgetControl
          chatId={chat.id}
          max={capability.maxCompletionTokens ?? 32000}
          value={r.maxTokens}
        />
      ) : null}
      <ReasoningSummaryControl chat={chat} capability={capability} />
    </section>
  )
}

function ReasoningBudgetControl({
  chatId,
  max,
  value,
}: {
  chatId: Chat['id']
  max: number
  value: number | undefined
}) {
  const edit = useSettledChatSettingsEdit({
    chatId,
    fieldKey: 'reasoning.maxTokens',
    storedValue: value ?? 0,
    patches: (next) => [{ path: ['reasoning', 'maxTokens'], value: next }],
  })
  const committedSliderValue = Math.min(max, Math.max(0, edit.value))
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))

  useEffect(() => {
    setDraft(value === undefined ? '' : String(value))
  }, [value])

  const commitNumberDraft = () => {
    const n = Number(draft)
    if (!Number.isFinite(n) || n < 0) {
      setDraft(value === undefined ? '' : String(value))
      return
    }
    const clamped = Math.min(max, Math.floor(n))
    edit.setValue(clamped)
    setDraft(String(clamped))
    edit.onBlur()
  }

  return (
    <div data-ui="field-group" data-ui-field data-ui-slider-row>
      <span data-ui="slider-label">Max reasoning tokens</span>
      <input
        data-ui="slider"
        type="range"
        min={0}
        max={max}
        step={1}
        value={committedSliderValue}
        onChange={(e) => {
          const next = Number(e.target.value)
          edit.setValue(next)
          setDraft(String(next))
        }}
        onPointerUp={edit.onPointerUp}
        onBlur={edit.onBlur}
      />
      <input
        data-ui="slider-number"
        type="number"
        min={0}
        max={max}
        value={draft}
        placeholder="0"
        onChange={(e) => {
          const raw = e.target.value
          setDraft(raw)
          if (raw === '') return
          const n = Number(raw)
          if (Number.isFinite(n) && n >= 0) {
            edit.setValue(Math.min(max, Math.floor(n)))
          }
        }}
        onBlur={commitNumberDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(value === undefined ? '' : String(value))
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
    </div>
  )
}

const SUMMARY_VALUES: readonly ('off' | 'auto' | 'concise' | 'detailed')[] = [
  'off',
  'auto',
  'concise',
  'detailed',
]

function ReasoningSummaryControl({
  chat,
  capability,
}: {
  chat: Chat
  capability: EffectiveCapability
}) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  // Summary-output is a request flag asking the provider to surface the
  // visible reasoning summary. The provider decides whether to honor it;
  // on chat-completions against most models it's ignored, on OpenAI
  // Responses + Gemini native it's honored. Render whenever reasoning is
  // a supported parameter — the user can decide what to ask for.
  const hasSummarySupport =
    capability.supportedParameters.has('reasoning') ||
    capability.supportedParameters.has('thinking')
  if (!hasSummarySupport) return null
  const r = chat.settings.reasoning
  const selected = r.summary ?? 'off'
  return (
    <div data-ui="field-group" data-ui-field>
      <span>Summary output</span>
      <div data-ui="segmented">
        {SUMMARY_VALUES.map((v) => (
          <Button
            key={v}
            type="button"
            data-ui="segmented-option"
            aria-pressed={selected === v}
            onClick={() =>
              runConfigurationWrite({
                target: configurationWriteTarget(chat.id, 'reasoning.summary'),
                action: () =>
                  configurationApplication.patchChatSettingsFields(chat.id, [
                    { path: ['reasoning', 'summary'], value: v },
                  ]),
              })
            }
          >
            {v}
          </Button>
        ))}
      </div>
    </div>
  )
}

// Include-in-next-turn checkboxes: reasoning carriers plus provider tool
// evidence. Tool evidence is intentionally controlled from the same context
// group as reasoning because both affect what assistant-side metadata is
// echoed into the next request.
// User directive: shown reasoning include checkboxes are ALWAYS clickable (a
// mid-chat model swap may bring history from another family that the current
// model can still consume). The only gate is the encrypted checkbox: it is
// hidden entirely when the model doesn't emit encrypted reasoning (unknown
// format, Gemini 2.5, etc.), no disabled-with-tooltip.
//
// The selected route's reasoning projector drops incompatible carriers before
// serialization. The UI only owns the user's include preference.
//
// Lives on the Context tab (see `ChatModelPanel` — tabs 2026-04).
export function ReasoningIncludeControls({
  chat,
}: {
  chat: Chat
  capability: EffectiveCapability | null
}) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  if (!chat.settings.model) return null

  // Plaintext reasoning is portable: it can stay in a native plaintext
  // reasoning lane when supported, or be normalized into `<think>` text.
  // Only encrypted carriers are target-model gated.
  const r = chat.settings.reasoning
  const include = r.include
  const includeToolCalls = chat.settings.toolCallContext.include
  const emitsEncrypted = emitsEncryptedReasoningFor(chat.settings.model) === 'always'
  const updateInclude = (patch: Partial<ReasoningInclude>) => {
    const fields = Object.entries(patch)
    runConfigurationWrite({
      target: configurationWriteTarget(
        chat.id,
        fields
          .map(([key]) => `reasoning.include.${key}`)
          .sort()
          .join('+'),
      ),
      action: () =>
        configurationApplication.patchChatSettingsFields(
          chat.id,
          fields.map(([key, value]) => ({
            path: ['reasoning', 'include', key],
            value,
          })),
        ),
    })
  }
  const echoAsThink = r.echoAsThinkTags === true
  const textCompletionsActive = chat.settings.api === 'text' || chat.settings.protocol === 'text'
  // Text completions has no structured reasoning echo channel; carried
  // plaintext reasoning belongs in the rendered prompt as <think> blocks.
  const sendAsThinkDisabled = textCompletionsActive || (!include.summary && !include.text)
  const sendAsThinkChecked = textCompletionsActive || echoAsThink
  const sendAsThinkTitle = textCompletionsActive
    ? 'Text completions always sends kept plaintext reasoning as <think> blocks in the rendered prompt.'
    : sendAsThinkDisabled
      ? 'No plaintext reasoning is being included — check Visible summary or Visible text first.'
      : 'When on, kept summary + text are sent as a <think>…</think> block prepended to the assistant message body instead of reasoning_details. Encrypted carriers ride the native channel either way. Ignored on Responses + Gemini-native routes.'
  return (
    <section data-ui="settings-section" data-ui-section="include-next-turn">
      <h3>Include in next turn</h3>
      <div data-ui="field-group" data-ui-field data-ui-group="include-next-turn">
        <div data-ui="reasoning-include-group">
          {emitsEncrypted ? (
            <label data-ui="reasoning-checkbox">
              <input
                type="checkbox"
                checked={include.encrypted}
                onChange={(e) => updateInclude({ encrypted: e.target.checked })}
              />
              <span>Encrypted reasoning</span>
            </label>
          ) : null}
          <label data-ui="reasoning-checkbox">
            <input
              type="checkbox"
              checked={include.summary}
              onChange={(e) => updateInclude({ summary: e.target.checked })}
            />
            <span>Visible summary</span>
          </label>
          <label data-ui="reasoning-checkbox">
            <input
              type="checkbox"
              checked={include.text}
              onChange={(e) => updateInclude({ text: e.target.checked })}
            />
            <span>Visible text</span>
          </label>
          <label
            data-ui="reasoning-checkbox"
            data-disabled={sendAsThinkDisabled ? 'true' : undefined}
            title={sendAsThinkTitle}
          >
            <input
              type="checkbox"
              checked={sendAsThinkChecked}
              disabled={sendAsThinkDisabled}
              onChange={(e) => {
                if (textCompletionsActive) return
                runConfigurationWrite({
                  target: configurationWriteTarget(chat.id, 'reasoning.echoAsThinkTags'),
                  action: () =>
                    configurationApplication.patchChatSettingsFields(chat.id, [
                      { path: ['reasoning', 'echoAsThinkTags'], value: e.target.checked },
                    ]),
                })
              }}
            />
            <span>Send as &lt;think&gt; tags</span>
          </label>
          <label data-ui="reasoning-checkbox">
            <input
              type="checkbox"
              checked={includeToolCalls}
              onChange={(e) =>
                runConfigurationWrite({
                  target: configurationWriteTarget(chat.id, 'toolCallContext.include'),
                  action: () =>
                    configurationApplication.patchChatSettingsFields(chat.id, [
                      { path: ['toolCallContext', 'include'], value: e.target.checked },
                    ]),
                })
              }
            />
            <span>Tool calls</span>
            <InfoDisclosure title="When enabled, provider-returned tool calls and results are replayed in their native format when the next provider supports that dialect; otherwise they are converted to <tool_call> text blocks. Per-message eye toggles can exclude individual tool records." />
          </label>
        </div>
      </div>
    </section>
  )
}

// API mode — Chat completions / Responses / Text completions. Text
// completions is an OpenRouter-only prompt-mode route; llama-server keeps its
// separate protocol toggle because it also has a server-defined GGUF template.
//
// Lives on the Model tab. Exported for use in `ChatModelPanel`.
export function ApiModeSection({
  chat,
  capability,
  profile,
  routing,
}: {
  chat: Chat
  capability: EffectiveCapability
  profile: ConnectionProfile | null
  routing: AssistantRouteContract | null
}) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  if (!profile) return null
  if (profile.kind === 'google') {
    const resolvedKind = chat.settings.api === 'chat' ? 'chat' : 'gemini-native'
    return (
      <section data-ui="settings-section" data-ui-section="api-mode">
        <div data-ui="field-group" data-ui-field>
          <span>
            API Mode{' '}
            <InfoDisclosure title="Native Gemini preserves thought signatures and uses generateContent with x-goog-api-key. OpenAI-compat uses Gemini's chat-completions shim." />
          </span>
          <div data-ui="segmented">
            <Button
              type="button"
              data-ui="segmented-option"
              aria-pressed={resolvedKind === 'gemini-native'}
              onClick={() =>
                runConfigurationWrite({
                  target: configurationWriteTarget(chat.id, 'api'),
                  action: () =>
                    configurationApplication.patchChatSettings(chat.id, {
                      api: 'gemini-native',
                    }),
                })
              }
            >
              Native
            </Button>
            <Button
              type="button"
              data-ui="segmented-option"
              aria-pressed={resolvedKind === 'chat'}
              onClick={() =>
                runConfigurationWrite({
                  target: configurationWriteTarget(chat.id, 'api'),
                  action: () =>
                    configurationApplication.patchChatSettings(chat.id, { api: 'chat' }),
                })
              }
            >
              OpenAI-compat
            </Button>
          </div>
        </div>
      </section>
    )
  }
  if (profile.kind === 'anthropic') {
    const resolvedKind = chat.settings.api === 'chat' ? 'chat' : 'anthropic-messages'
    return (
      <section data-ui="settings-section" data-ui-section="api-mode">
        <div data-ui="field-group" data-ui-field>
          <span>
            API Mode{' '}
            <InfoDisclosure title="Messages uses Anthropic's native API with x-api-key. OpenAI-compat uses the chat-completions shim." />
          </span>
          <div data-ui="segmented">
            <Button
              type="button"
              data-ui="segmented-option"
              aria-pressed={resolvedKind === 'anthropic-messages'}
              onClick={() =>
                runConfigurationWrite({
                  target: configurationWriteTarget(chat.id, 'api'),
                  action: () =>
                    configurationApplication.patchChatSettings(chat.id, {
                      api: 'anthropic-messages',
                    }),
                })
              }
            >
              Messages
            </Button>
            <Button
              type="button"
              data-ui="segmented-option"
              aria-pressed={resolvedKind === 'chat'}
              onClick={() =>
                runConfigurationWrite({
                  target: configurationWriteTarget(chat.id, 'api'),
                  action: () =>
                    configurationApplication.patchChatSettings(chat.id, { api: 'chat' }),
                })
              }
            >
              OpenAI-compat
            </Button>
          </div>
        </div>
      </section>
    )
  }
  if (capability.outputModalities.has('video') || capability.outputModalities.has('audio')) {
    return null
  }
  const support = responsesSupportFor(chat.settings.model)
  const canResponses = isResponsesCapable(profile) && support === 'both'
  const canText = isTextCompletionsCapable(profile, chat.settings.model)
  // Hide the whole section unless the current model exposes a genuine
  // per-chat API choice beyond the default chat-completions route.
  if (!canResponses && !canText) return null
  if (!routing) return null
  const route = routing
  const resolvedKind: 'chat' | 'responses' | 'text' =
    route.kind === 'text-completions' ? 'text' : route.kind === 'responses' ? 'responses' : 'chat'
  const requiresPhaseEcho = capability.quirks.requiresPhaseEcho === true
  const pinTo = (target: 'chat' | 'responses' | 'text') => {
    if (target === 'chat' && requiresPhaseEcho) {
      if (
        typeof window !== 'undefined' &&
        !window.confirm(
          'This model relies on the Responses API to preserve `phase` metadata across turns. Dropping it can cause the model to stop early mid-answer. Switch anyway?',
        )
      ) {
        return
      }
    }
    runConfigurationWrite({
      target: configurationWriteTarget(chat.id, 'api'),
      action: () => configurationApplication.patchChatSettings(chat.id, { api: target }),
    })
  }
  return (
    <section data-ui="settings-section" data-ui-section="api-mode">
      <div data-ui="field-group" data-ui-field>
        <span>
          API Mode{' '}
          <InfoDisclosure title="Responses preserves encrypted reasoning and `phase` metadata across turns. Text completions sends a single rendered prompt to /completions and is intended for OpenRouter-routed open-weight models." />
        </span>
        <div data-ui="segmented">
          <Button
            type="button"
            data-ui="segmented-option"
            aria-pressed={resolvedKind === 'chat'}
            onClick={() => pinTo('chat')}
          >
            Chat completions
          </Button>
          {canResponses ? (
            <Button
              type="button"
              data-ui="segmented-option"
              aria-pressed={resolvedKind === 'responses'}
              onClick={() => pinTo('responses')}
            >
              Responses
            </Button>
          ) : null}
          {canText ? (
            <Button
              type="button"
              data-ui="segmented-option"
              aria-pressed={resolvedKind === 'text'}
              onClick={() => pinTo('text')}
            >
              Text completions
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function VerbositySection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  if (!capability.supportedParameters.has('verbosity')) return null
  const choices = capability.allowedVerbosity
  if (choices.length === 0) return null
  const selected = chat.settings.verbosity ?? 'default'
  const options: ReadonlyArray<'default' | VerbosityLevel> = ['default', ...choices]
  return (
    <section data-ui="settings-section" data-ui-section="verbosity">
      <h3>Verbosity</h3>
      <div data-ui="segmented">
        {options.map((v) => (
          <Button
            key={v}
            type="button"
            data-ui="segmented-option"
            aria-pressed={selected === v}
            onClick={() =>
              runConfigurationWrite({
                target: configurationWriteTarget(chat.id, 'verbosity'),
                action: () =>
                  configurationApplication.patchChatSettings(
                    chat.id,
                    v === 'default' ? { verbosity: undefined } : { verbosity: v },
                  ),
              })
            }
          >
            {v}
          </Button>
        ))}
      </div>
    </section>
  )
}

function StopInlineRow({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  const hasStop =
    capability.supportedParameters.has('stop') ||
    capability.supportedParameters.has('stop_sequences')
  if (!hasStop) return null
  const values = chat.settings.stop ?? []
  const setValues = (next: string[]) => {
    const clean = sanitizeStopValues(next)
    runConfigurationWrite({
      target: configurationWriteTarget(chat.id, 'stop'),
      action: () =>
        configurationApplication.patchChatSettings(
          chat.id,
          clean.length === 0 ? { stop: [] } : { stop: clean },
        ),
    })
  }
  const entries = values.map((value, index) => ({
    value,
    index,
    key: `${value}:${values.slice(0, index).filter((item) => item === value).length}`,
  }))
  return (
    <div data-ui="sampling-stop-row">
      <span data-ui="sampling-stop-label">Stop sequences</span>
      <div data-ui="chip-input">
        {entries.map((entry) => (
          <span key={entry.key} data-ui="chip">
            <code>{entry.value}</code>
            <Button
              type="button"
              aria-label={`Remove ${entry.value}`}
              onClick={() => setValues(values.filter((_, idx) => idx !== entry.index))}
            >
              ×
            </Button>
          </span>
        ))}
        <input
          type="text"
          placeholder={values.length >= 4 ? 'max 4' : 'add stop sequence…'}
          disabled={values.length >= 4}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              const v = (e.target as HTMLInputElement).value
              if (!v.trim()) return
              setValues([...values, v])
              ;(e.target as HTMLInputElement).value = ''
            }
          }}
        />
      </div>
    </div>
  )
}

function StopTextAreaControl({
  chat,
  capability,
  label,
  helper,
}: {
  chat: Chat
  capability: EffectiveCapability
  label: string
  helper: string
}) {
  const hasStop =
    capability.supportedParameters.has('stop') ||
    capability.supportedParameters.has('stop_sequences')
  const values = chat.settings.stop ?? []
  const text = values.join('\n')
  const edit = useSettledChatSettingsEdit({
    chatId: chat.id,
    fieldKey: 'stop',
    storedValue: text,
    patches: (next) => [{ path: ['stop'], value: sanitizeStopValues(next.split('\n')) }],
  })
  if (!hasStop) return null
  const id = 'request-stop-sequences'
  return (
    <div data-ui="field-group">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={4}
        value={edit.value}
        onChange={(e) => edit.setValue(e.target.value)}
        onBlur={edit.onBlur}
      />
      <span data-ui="helper">{helper}</span>
    </div>
  )
}

function sanitizeStopValues(values: readonly string[]): string[] {
  return values
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 4)
}

function LogitBiasSection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  const [open, setOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const storedBias = chat.settings.logitBias ?? EMPTY_LOGIT_BIAS
  const edit = useSettledChatSettingsEdit({
    chatId: chat.id,
    fieldKey: 'logitBias',
    storedValue: storedBias,
    equal: sameLogitBias,
    patches: (next) => [{ path: ['logitBias'], value: next }],
  })
  const raw = useMemo(
    () => (chat.settings.logitBias ? JSON.stringify(chat.settings.logitBias, null, 2) : ''),
    [chat.settings.logitBias],
  )
  const [draft, setDraft] = useState(raw)
  useEffect(() => {
    setDraft(raw)
    setErrorMsg(null)
  }, [raw])
  if (!capability.supportedParameters.has('logit_bias')) return null
  const commit = () => {
    const parsed = parseLogitBiasDraft(draft)
    if ('error' in parsed) {
      setErrorMsg(parsed.error)
      return
    }
    edit.setValue(parsed.value)
    edit.onBlur()
    setErrorMsg(null)
  }
  const handleUpload = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      setDraft(text)
      const parsed = parseLogitBiasDraft(text)
      if ('error' in parsed) {
        setErrorMsg(parsed.error)
        return
      }
      edit.setValue(parsed.value)
      edit.onBlur()
      setErrorMsg(null)
    }
    reader.readAsText(file)
  }
  return (
    <section data-ui="settings-section" data-ui-section="logit-bias">
      <Button
        type="button"
        data-ui="settings-advanced-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Logit bias (advanced)
      </Button>
      {open ? (
        <div data-ui="field-group">
          <div data-ui="logit-bias-toolbar">
            <Button type="button" data-ui="logit-bias-btn" onClick={() => fileRef.current?.click()}>
              Upload
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleUpload(file)
                e.target.value = ''
              }}
            />
            {draft ? (
              <Button
                type="button"
                data-ui="logit-bias-btn"
                onClick={() => {
                  setDraft('')
                  edit.setValue({})
                  edit.onBlur()
                  setErrorMsg(null)
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
          <textarea
            data-ui="logit-bias-editor"
            value={draft}
            onChange={(e) => {
              const next = e.target.value
              setDraft(next)
              const parsed = parseLogitBiasDraft(next)
              if (!('error' in parsed)) edit.setValue(parsed.value)
            }}
            placeholder='{ "50256": -100 }'
            rows={6}
            onBlur={commit}
          />
          {errorMsg ? (
            <span data-ui="helper" data-tone="danger">
              {errorMsg}
            </span>
          ) : (
            <span data-ui="helper">JSON object: token id → bias. -100 blocks; +100 forces.</span>
          )}
        </div>
      ) : null}
    </section>
  )
}

const EMPTY_LOGIT_BIAS: Readonly<Record<string, number>> = Object.freeze({})

function parseLogitBiasDraft(text: string): { value: Record<string, number> } | { error: string } {
  if (text.trim() === '') return { value: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: 'Must be an object of token → bias pairs' }
    }
    for (const value of Object.values(parsed)) {
      if (typeof value !== 'number') return { error: 'Bias values must be numbers' }
    }
    return { value: parsed as Record<string, number> }
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'invalid JSON' }
  }
}

function sameLogitBias(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}

function placeholderForSpec(spec: SamplingSpec): string {
  // Seed hasn't got a meaningful "allowed range" — any int. Show the
  // hint placeholder instead.
  if (spec.key === 'seed') return 'any int'
  // For big unbounded integers (logprobs, etc.) don't dump the full max
  // into the placeholder — readable text wins over literal bounds.
  if (spec.max > 1000 && spec.integer) return `${spec.min}-${spec.max}`
  const formatNum = (n: number) =>
    spec.integer ? String(n) : Number.isInteger(n) ? n.toFixed(1) : String(n)
  return `${formatNum(spec.min)}-${formatNum(spec.max)}`
}

function SamplingInput({
  chatId,
  spec,
  value,
}: {
  chatId: Chat['id']
  spec: SamplingSpec
  value: number | undefined
}) {
  const edit = useSettledChatSettingsEdit({
    chatId,
    fieldKey: `sampling.${spec.key}`,
    storedValue: value,
    patches: (next) => [{ path: ['sampling', spec.key], value: next }],
  })
  const [draft, setDraft] = useState<string>(value === undefined ? '' : String(value))
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    setDraft(value === undefined ? '' : String(value))
    setInvalid(null)
  }, [value])
  const commit = () => {
    const raw = draft.trim()
    if (raw === '') {
      setInvalid(null)
      edit.setValue(undefined)
      edit.onBlur()
      return
    }
    const n = Number(raw)
    if (!Number.isFinite(n)) {
      setInvalid('not a number')
      return
    }
    if (spec.integer && !Number.isInteger(n)) {
      setInvalid('must be integer')
      return
    }
    if (n < spec.min || n > spec.max) {
      setInvalid(`${spec.min}–${spec.max}`)
      return
    }
    setInvalid(null)
    edit.setValue(n)
    edit.onBlur()
  }
  return (
    <div data-ui="sampling-field" data-invalid={invalid ? 'true' : undefined}>
      <span data-ui="sampling-field-label">
        {spec.label}
        <InfoDisclosure title={spec.hint} />
      </span>
      <input
        data-ui="sampling-field-input"
        type="text"
        inputMode={spec.integer ? 'numeric' : 'decimal'}
        value={draft}
        placeholder={placeholderForSpec(spec)}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          const raw = next.trim()
          if (raw === '') {
            edit.setValue(undefined)
            return
          }
          const parsed = Number(raw)
          if (
            Number.isFinite(parsed) &&
            (!spec.integer || Number.isInteger(parsed)) &&
            parsed >= spec.min &&
            parsed <= spec.max
          ) {
            edit.setValue(parsed)
          }
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(edit.value === undefined ? '' : String(edit.value))
            setInvalid(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      {invalid ? <span data-ui="sampling-field-error">{invalid}</span> : null}
    </div>
  )
}

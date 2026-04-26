// Capability-gated generation-settings form. See `plan/10-ui.md §10.9
// tab 1` and `plan/07-discovery.md §7.10`.
//
// Renders only controls whose wire-key is in the effective capability's
// `supportedParameters`. For reasoning effort / verbosity we narrow the
// value set against the quirks registry — e.g. Claude 4.7 shows the
// "verbosity" segmented control with xhigh as the ceiling, and adaptive-
// only models hide the effort segmented control entirely.
//
// On mount the stored settings are validated against the live caps; any
// dropped params or clamped enums are surfaced via a small issues banner
// and a toast. This way moving from a low-cap model to a high-cap one
// doesn't leave dangling knobs that will 400 on send.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LlamaServerProps } from '../../api/probe'
import { chooseApi, isResponsesCapable, isTextCompletionsCapable } from '../../core/api-choice'
import type { EffectiveCapability } from '../../core/capabilities'
import { validateChatSettings } from '../../core/capabilities'
import {
  emitsEncryptedReasoningFor,
  prefillClassFor,
  reasoningToggleableFor,
  responsesSupportFor,
} from '../../core/quirks'
import type {
  ApiVariant,
  Chat,
  ConnectionProfile,
  ConnectionKind,
  EffortLevel,
  Message,
  ModelEndpoint,
  ReasoningInclude,
  ReasoningSummary,
  SamplingKey,
  ServerToolId,
  VerbosityLevel,
} from '../../core/types'
import { updateChatSettings } from '../../store/chats'
import { PrefillSettingsPrompt } from '../chat/PrefillSettingsPrompt'
import { InfoDisclosure } from './InfoDisclosure'
import {
  ContinueSystemPromptEditor,
  ContinueUserPromptEditor,
  SystemPromptEditor,
} from './PromptPresetEditor'
import { TextTemplateSection } from './TextTemplateSection'

export interface ParamFormProps {
  chat: Chat
  capability: EffectiveCapability | null
  // Preserved for forward-compat — future sampling fields (seed variance,
  // deterministic tokenizer-aware ops) may want it. Unused today.
  endpointTokenizer?: string | null | undefined
  prefillRecommendationEndpoints?: readonly ModelEndpoint[] | undefined
  textTemplateMode?: 'openrouter' | 'llama-server' | null | undefined
  llamaProps?: LlamaServerProps | null | undefined
  connectionKind?: ConnectionKind | undefined
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
    hint: "DRY (Don't Repeat Yourself) penalty multiplier. 0 disables.",
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

const SETTINGS_SLIDER_COMMIT_DEBOUNCE_MS = 200

const HOSTED_TOOL_OPTIONS: ReadonlyArray<{
  id: ServerToolId
  label: string
}> = [
  { id: 'web-search', label: 'Web search' },
  { id: 'datetime', label: 'Datetime' },
  { id: 'web-fetch', label: 'Web fetch' },
]

export function ParamForm({
  chat,
  capability,
  prefillRecommendationEndpoints = [],
  textTemplateMode = null,
  llamaProps = null,
  connectionKind = 'custom',
  textCompletionsActive = false,
}: ParamFormProps) {
  const prefillSupportedForModel = chat.settings.model
    ? prefillClassFor(chat.settings.model) !== 'unsupported'
    : false
  const continuePrefillStored = chat.settings.continuePrefill === true

  // Validate stored settings once the live cap lands. Re-run whenever the
  // cap identity changes — e.g. model swap. Silent: we just fix the values,
  // no user-visible banner (the UI re-renders with the clamped values).
  const lastValidatedCapRef = useRef<EffectiveCapability | null>(null)
  useEffect(() => {
    if (!capability) return
    if (lastValidatedCapRef.current === capability) return
    lastValidatedCapRef.current = capability
    const result = validateChatSettings(chat.settings, capability)
    if (result.changed) {
      void updateChatSettings(chat.id, result.settings)
    }
  }, [capability, chat.id, chat.settings])

  useEffect(() => {
    if (!chat.settings.model) return
    if (prefillSupportedForModel) return
    if (!continuePrefillStored) return
    void updateChatSettings(chat.id, { continuePrefill: false })
  }, [chat.id, chat.settings.model, continuePrefillStored, prefillSupportedForModel])

  if (!chat.settings.model) {
    return (
      <div data-ui="param-form">
        <section data-ui="settings-section" data-ui-section="generation-empty">
          <h3>Generation</h3>
          <p data-ui="helper">Select a model first.</p>
        </section>
        <SystemPromptEditor chat={chat} />
        <ContinueSystemPromptEditor chat={chat} />
        <ContinueUserPromptEditor chat={chat} />
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
        <SystemPromptEditor chat={chat} />
        <ContinueSystemPromptEditor chat={chat} />
        <ContinueUserPromptEditor chat={chat} />
      </div>
    )
  }

  // Ordering per user spec: reasoning → verbosity, then prompt slots, then
  // sampling. Continue prompts start collapsed; system prompt starts open.
  // Prefill block lives between the prompt slots and sampling so the user
  // sees it as another prompt-like input. Continue prompts auto-hide when
  // continuePrefill is on (their slots are unused in that mode).
  const continuePrefill = prefillSupportedForModel && continuePrefillStored
  return (
    <div data-ui="param-form">
      <ReasoningSection chat={chat} capability={capability} />
      <VerbositySection chat={chat} capability={capability} />
      <HostedToolsSection
        chat={chat}
        connectionKind={connectionKind}
        textCompletionsActive={textCompletionsActive}
      />
      <SystemPromptEditor chat={chat} />
      {prefillSupportedForModel ? (
        <PrefillSettingsSection chat={chat} endpoints={prefillRecommendationEndpoints} />
      ) : null}
      {continuePrefill ? null : <ContinueSystemPromptEditor chat={chat} defaultCollapsed />}
      {continuePrefill ? null : <ContinueUserPromptEditor chat={chat} defaultCollapsed />}
      <SamplingSection chat={chat} capability={capability} />
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
      ) : (
        <StopSection chat={chat} capability={capability} />
      )}
    </div>
  )
}

function PrefillSettingsSection({
  chat,
  endpoints,
}: {
  chat: Chat
  endpoints: readonly ModelEndpoint[]
}) {
  const draft = chat.settings.defaultPrefill ?? ''
  const continuePrefill = chat.settings.continuePrefill === true
  const [expanded, setExpanded] = useState(false)
  const lastPersistedRef = useRef(draft)
  const [text, setText] = useState(draft)
  const lastChatIdRef = useRef(chat.id)
  // Resync on chat switch / external write.
  useEffect(() => {
    if (lastChatIdRef.current !== chat.id) {
      lastChatIdRef.current = chat.id
      lastPersistedRef.current = draft
      setText(draft)
      return
    }
    if (draft !== lastPersistedRef.current) {
      lastPersistedRef.current = draft
      setText(draft)
    }
  }, [chat.id, draft])
  // Debounced save (300ms — matches the prompt-preset editor).
  useEffect(() => {
    if (text === lastPersistedRef.current) return
    const id = window.setTimeout(() => {
      lastPersistedRef.current = text
      void updateChatSettings(chat.id, { defaultPrefill: text })
    }, 300)
    return () => window.clearTimeout(id)
  }, [text, chat.id])
  const toggleContinuePrefill = () =>
    void updateChatSettings(chat.id, { continuePrefill: !continuePrefill })
  return (
    <section
      data-ui="settings-section"
      data-ui-section="prefill"
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div data-ui="prompt-slot-header">
        <button
          type="button"
          data-ui="prompt-slot-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <PrefillChevronIcon expanded={expanded} />
          <h3>Prefill</h3>
        </button>
      </div>
      {expanded ? (
        <>
          <div data-ui="field-group">
            <label htmlFor="default-prefill-textarea" data-ui="visually-hidden">
              Default prefill text
            </label>
            <textarea
              id="default-prefill-textarea"
              data-ui="default-prefill-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder='Default text for the prefill box. Example: "Chapter 1: The"'
              rows={3}
              spellCheck
            />
          </div>
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
          {continuePrefill ? (
            <PrefillSettingsPrompt
              chatId={chat.id}
              settings={chat.settings}
              endpoints={endpoints}
            />
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function PrefillChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      data-ui="prompt-slot-chevron"
      data-expanded={expanded ? 'true' : 'false'}
      viewBox="0 0 12 12"
      aria-hidden="true"
      focusable="false"
      width="10"
      height="10"
    >
      <path
        d="M4 2.5L8 6l-4 3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function HostedToolsSection({
  chat,
  connectionKind,
  textCompletionsActive,
}: {
  chat: Chat
  connectionKind: ConnectionKind
  textCompletionsActive: boolean
}) {
  const selected = chat.settings.enabledServerToolIds
  const enabledCount = HOSTED_TOOL_OPTIONS.filter((option) => selected.includes(option.id)).length
  const available = connectionKind === 'openrouter' && !textCompletionsActive
  const disabledReason = textCompletionsActive
    ? 'Hosted tools are not sent on text completions.'
    : connectionKind === 'openrouter'
      ? ''
      : 'Hosted tools are only sent through OpenRouter in this pass.'

  const toggle = (id: ServerToolId, checked: boolean) => {
    const next = checked
      ? selected.includes(id)
        ? selected
        : [...selected, id]
      : selected.filter((candidate) => candidate !== id)
    void updateChatSettings(chat.id, { enabledServerToolIds: next })
  }

  return (
    <details data-ui="settings-section" data-ui-section="hosted-tools">
      <summary data-ui="settings-disclosure-summary">
        <span>Tools</span>
        {enabledCount > 0 ? <span data-ui="field-value">{enabledCount} enabled</span> : null}
      </summary>
      <div data-ui="field-group" data-ui-field>
        {HOSTED_TOOL_OPTIONS.map((option) => (
          <label
            key={option.id}
            data-ui="checkbox-row"
            data-disabled={available ? undefined : 'true'}
          >
            <input
              type="checkbox"
              checked={selected.includes(option.id)}
              disabled={!available}
              onChange={(e) => toggle(option.id, e.target.checked)}
            />
            <span>{option.label}</span>
          </label>
        ))}
        {!available && disabledReason ? <span data-ui="helper">{disabledReason}</span> : null}
      </div>
    </details>
  )
}

function SamplingSection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  const visible = SAMPLING_FIELDS.filter((s) => capability.supportedParameters.has(s.wire))
  const hasLogitBias = capability.supportedParameters.has('logit_bias')
  if (visible.length === 0 && !hasLogitBias) return null
  return (
    <section data-ui="settings-section" data-ui-section="sampling">
      <h3>Sampling</h3>
      {visible.length > 0 ? (
        <div data-ui="sampling-grid">
          {visible.map((s) => (
            <SamplingInput
              key={s.key}
              spec={s}
              value={chat.settings.sampling[s.key]}
              onCommit={(v) => {
                const next = { ...chat.settings.sampling }
                if (v === undefined) delete next[s.key]
                else next[s.key] = v
                void updateChatSettings(chat.id, { sampling: next })
              }}
            />
          ))}
        </div>
      ) : null}
      <LogitBiasSection chat={chat} capability={capability} />
    </section>
  )
}

function ReasoningSection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  const hasReasoning =
    capability.supportedParameters.has('reasoning') ||
    capability.supportedParameters.has('thinking') ||
    capability.supportedParameters.has('include_reasoning')
  if (!hasReasoning) return null
  const adaptiveOnly = capability.quirks.adaptiveReasoningOnly === true
  const effortChoices = adaptiveOnly ? [] : capability.allowedEffort
  // OpenAI o-series returns reasoning opaquely — control rendering stays
  // the same, but the user won't see tokens in the response. Hide the
  // whole section for hidden-reasoning models to avoid implying the
  // knobs do something visible.
  if (capability.quirks.reasoningHidden === true) return null
  const supportsReasoning =
    capability.supportedParameters.has('reasoning') ||
    capability.supportedParameters.has('thinking')
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
    if (m === 'budget') return supportsReasoning
    return true
  })
  const r = chat.settings.reasoning
  const updateReasoning = (patch: Partial<typeof r>) => {
    void updateChatSettings(chat.id, { reasoning: { ...r, ...patch } })
  }
  return (
    <section data-ui="settings-section" data-ui-section="reasoning">
      <h3>Reasoning</h3>
      {adaptiveOnly ? (
        // Claude 4.6/4.7: the model picks its own effort. Exposing Mode +
        // Effort would mislead the user into thinking their clicks matter.
        // We still render the section header + the include/summary sub-
        // controls below (they DO matter — Anthropic returns signed reasoning
        // text that can be echoed on the next turn).
        <div data-ui="field-group" data-ui-field>
          <span data-ui="helper">This model decides reasoning effort automatically.</span>
        </div>
      ) : (
        <>
          <div data-ui="field-group" data-ui-field>
            <span>Mode</span>
            <div data-ui="segmented">
              {modes.map((m) => (
                <button
                  key={m}
                  type="button"
                  data-ui="segmented-option"
                  aria-pressed={r.mode === m}
                  onClick={() => updateReasoning({ mode: m })}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          {r.mode === 'effort' && effortChoices.length > 0 ? (
            <div data-ui="field-group" data-ui-field>
              <span>Effort</span>
              <div data-ui="segmented">
                {effortChoices.map((e) => (
                  <button
                    key={e}
                    type="button"
                    data-ui="segmented-option"
                    aria-pressed={r.effort === e}
                    onClick={() => updateReasoning({ effort: e as EffortLevel })}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {r.mode === 'budget' ? (
            <ReasoningBudgetControl
              max={capability.maxCompletionTokens ?? 32000}
              value={r.maxTokens}
              onCommit={(next) => updateReasoning({ maxTokens: next })}
            />
          ) : null}
        </>
      )}
      <ReasoningSummaryControl chat={chat} capability={capability} />
    </section>
  )
}

function ReasoningBudgetControl({
  max,
  value,
  onCommit,
}: {
  max: number
  value: number | undefined
  onCommit: (next: number) => void
}) {
  const committedSliderValue = Math.min(max, Math.max(0, value ?? 0))
  const [draft, setDraft] = useState(value === undefined ? '' : String(value))
  const [sliderValue, setSliderValue] = useState(committedSliderValue)

  useEffect(() => {
    setDraft(value === undefined ? '' : String(value))
    setSliderValue(committedSliderValue)
  }, [value, committedSliderValue])

  const commitSliderDraft = useCallback(() => {
    const clamped = Math.min(max, Math.max(0, sliderValue))
    if (clamped !== committedSliderValue) onCommit(clamped)
  }, [max, sliderValue, committedSliderValue, onCommit])

  useEffect(() => {
    if (sliderValue === committedSliderValue) return
    const id = window.setTimeout(() => {
      commitSliderDraft()
    }, SETTINGS_SLIDER_COMMIT_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [sliderValue, committedSliderValue, commitSliderDraft])

  const commitNumberDraft = () => {
    const n = Number(draft)
    if (!Number.isFinite(n) || n < 0) {
      setDraft(value === undefined ? '' : String(value))
      setSliderValue(committedSliderValue)
      return
    }
    const clamped = Math.min(max, Math.floor(n))
    if (clamped !== committedSliderValue) onCommit(clamped)
    setDraft(String(clamped))
    setSliderValue(clamped)
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
        value={sliderValue}
        onChange={(e) => {
          const next = Number(e.target.value)
          setSliderValue(next)
          setDraft(String(next))
        }}
        onPointerUp={commitSliderDraft}
        onBlur={commitSliderDraft}
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
            setSliderValue(Math.min(max, Math.floor(n)))
          }
        }}
        onBlur={commitNumberDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(value === undefined ? '' : String(value))
            setSliderValue(committedSliderValue)
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
          <button
            key={v}
            type="button"
            data-ui="segmented-option"
            aria-pressed={selected === v}
            onClick={() =>
              void updateChatSettings(chat.id, {
                reasoning: { ...r, summary: v as ReasoningSummary },
              })
            }
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  )
}

// Three independent checkboxes: encrypted / visible summary / visible text.
// User directive: all three are ALWAYS clickable (a mid-chat model swap may
// bring history from another family that the current model can still
// consume). The only gate is the encrypted checkbox: we hide it entirely
// when the model doesn't emit encrypted reasoning (unknown format, Gemini
// 2.5, etc.) — no disabled-with-tooltip.
//
// Filter-side safety: `filterReasoningForInclude` silent-drops incompatible
// formats before sending, with a console.warn. The UI just lets users pick.
//
// Lives on the Context tab (see `ChatModelPanel` — tabs 2026-04).
export function ReasoningIncludeControls({
  chat,
  capability,
}: {
  chat: Chat
  capability: EffectiveCapability
}) {
  // Only surface this control when the model actually has a reasoning param.
  // Otherwise include flags are a no-op.
  const hasReasoning =
    capability.supportedParameters.has('reasoning') ||
    capability.supportedParameters.has('thinking') ||
    capability.supportedParameters.has('include_reasoning')
  if (!hasReasoning) return null
  const r = chat.settings.reasoning
  const include = r.include
  const emitsEncrypted = emitsEncryptedReasoningFor(chat.settings.model) === 'always'
  const updateInclude = (patch: Partial<ReasoningInclude>) =>
    void updateChatSettings(chat.id, {
      reasoning: { ...r, include: { ...include, ...patch } },
    })
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
    <section data-ui="settings-section" data-ui-section="reasoning-include">
      <h3>Include in next turn</h3>
      <div data-ui="field-group" data-ui-field data-ui-group="reasoning-include">
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
                void updateChatSettings(chat.id, {
                  reasoning: { ...r, echoAsThinkTags: e.target.checked },
                })
              }}
            />
            <span>Send as &lt;think&gt; tags</span>
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
  activePathMessages = [],
}: {
  chat: Chat
  capability: EffectiveCapability
  profile: ConnectionProfile | null
  activePathMessages?: readonly Message[]
}) {
  if (!profile) return null
  // Gemini native picks transport at the connection level — nothing per-chat.
  if (profile.kind === 'google' && profile.geminiMode !== 'openai-compat') return null
  if (capability.outputModalities.has('video') || capability.outputModalities.has('audio')) {
    return null
  }
  const support = responsesSupportFor(chat.settings.model)
  const canResponses = isResponsesCapable(profile) && support === 'both'
  const canText = isTextCompletionsCapable(profile, chat.settings.model)
  // Hide the whole section unless the current model exposes a genuine
  // per-chat API choice beyond the default chat-completions route.
  if (!canResponses && !canText) return null
  const route = chooseApi(profile, chat.settings, activePathMessages, capability)
  const resolvedKind: 'chat' | 'responses' | 'text' =
    route.kind === 'responses' ? 'responses' : route.kind === 'text-completions' ? 'text' : 'chat'
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
    void updateChatSettings(chat.id, { api: target as ApiVariant })
  }
  return (
    <section data-ui="settings-section" data-ui-section="api-mode">
      <h3>
        API Mode{' '}
        <InfoDisclosure title="Responses preserves encrypted reasoning and `phase` metadata across turns. Text completions sends a single rendered prompt to /completions and is intended for OpenRouter-routed open-weight models." />
      </h3>
      <div data-ui="field-group" data-ui-field>
        <div data-ui="segmented">
          <button
            type="button"
            data-ui="segmented-option"
            aria-pressed={resolvedKind === 'chat'}
            onClick={() => pinTo('chat')}
          >
            Chat completions
          </button>
          {canResponses ? (
            <button
              type="button"
              data-ui="segmented-option"
              aria-pressed={resolvedKind === 'responses'}
              onClick={() => pinTo('responses')}
            >
              Responses
            </button>
          ) : null}
          {canText ? (
            <button
              type="button"
              data-ui="segmented-option"
              aria-pressed={resolvedKind === 'text'}
              onClick={() => pinTo('text')}
            >
              Text completions
            </button>
          ) : null}
        </div>
      </div>
    </section>
  )
}

function VerbositySection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
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
          <button
            key={v}
            type="button"
            data-ui="segmented-option"
            aria-pressed={selected === v}
            onClick={() =>
              void updateChatSettings(
                chat.id,
                v === 'default' ? { verbosity: undefined } : { verbosity: v },
              )
            }
          >
            {v}
          </button>
        ))}
      </div>
    </section>
  )
}

function StopSection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  const hasStop =
    capability.supportedParameters.has('stop') ||
    capability.supportedParameters.has('stop_sequences')
  if (!hasStop) return null
  const values = chat.settings.stop ?? []
  const setValues = (next: string[]) => {
    const clean = sanitizeStopValues(next)
    void updateChatSettings(chat.id, clean.length === 0 ? { stop: [] } : { stop: clean })
  }
  const entries = values.map((value, index) => ({
    value,
    index,
    key: `${value}:${values.slice(0, index).filter((item) => item === value).length}`,
  }))
  return (
    <section data-ui="settings-section" data-ui-section="stop">
      <h3>Stop sequences</h3>
      <div data-ui="chip-input">
        {entries.map((entry) => (
          <span key={entry.key} data-ui="chip">
            <code>{entry.value}</code>
            <button
              type="button"
              aria-label={`Remove ${entry.value}`}
              onClick={() => setValues(values.filter((_, idx) => idx !== entry.index))}
            >
              ×
            </button>
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
    </section>
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
  const [draft, setDraft] = useState(text)
  useEffect(() => {
    setDraft(text)
  }, [text])
  if (!hasStop) return null
  const setValues = (next: string[]) => {
    const clean = sanitizeStopValues(next)
    void updateChatSettings(chat.id, clean.length === 0 ? { stop: [] } : { stop: clean })
  }
  const id = 'request-stop-sequences'
  return (
    <div data-ui="field-group">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        rows={4}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === text) return
          setValues(draft.split('\n'))
        }}
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
    if (draft.trim() === '') {
      void updateChatSettings(chat.id, { logitBias: {} })
      setErrorMsg(null)
      return
    }
    try {
      const parsed = JSON.parse(draft)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setErrorMsg('Must be an object of token → bias pairs')
        return
      }
      for (const v of Object.values(parsed)) {
        if (typeof v !== 'number') {
          setErrorMsg('Bias values must be numbers')
          return
        }
      }
      void updateChatSettings(chat.id, { logitBias: parsed as Record<string, number> })
      setErrorMsg(null)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'invalid JSON')
    }
  }
  const handleUpload = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      setDraft(text)
      try {
        const parsed = JSON.parse(text)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setErrorMsg('Must be an object of token → bias pairs')
          return
        }
        for (const v of Object.values(parsed)) {
          if (typeof v !== 'number') {
            setErrorMsg('Bias values must be numbers')
            return
          }
        }
        void updateChatSettings(chat.id, { logitBias: parsed as Record<string, number> })
        setErrorMsg(null)
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'invalid JSON')
      }
    }
    reader.readAsText(file)
  }
  return (
    <section data-ui="settings-section" data-ui-section="logit-bias">
      <button
        type="button"
        data-ui="settings-advanced-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Logit bias (advanced)
      </button>
      {open ? (
        <div data-ui="field-group">
          <div data-ui="logit-bias-toolbar">
            <button type="button" data-ui="logit-bias-btn" onClick={() => fileRef.current?.click()}>
              Upload
            </button>
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
              <button
                type="button"
                data-ui="logit-bias-btn"
                onClick={() => {
                  setDraft('')
                  void updateChatSettings(chat.id, { logitBias: {} })
                  setErrorMsg(null)
                }}
              >
                Clear
              </button>
            ) : null}
          </div>
          <textarea
            data-ui="logit-bias-editor"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
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
  spec,
  value,
  onCommit,
}: {
  spec: SamplingSpec
  value: number | undefined
  onCommit: (v: number | undefined) => void
}) {
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
      if (value !== undefined) onCommit(undefined)
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
    if (n !== value) onCommit(n)
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
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(value === undefined ? '' : String(value))
            setInvalid(null)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      {invalid ? <span data-ui="sampling-field-error">{invalid}</span> : null}
    </div>
  )
}

// Re-exported so tests and other code can reference the spec list without
// importing individual fields.
export { SAMPLING_FIELDS }

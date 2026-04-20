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

import { useEffect, useMemo, useRef, useState } from 'react'
import type { EffectiveCapability } from '../../core/capabilities'
import { validateChatSettings } from '../../core/capabilities'
import type { Chat, EffortLevel, SamplingKey, VerbosityLevel } from '../../core/types'
import { updateChatSettings } from '../../store/chats'
import { SystemPromptEditor } from './SystemPromptEditor'

export interface ParamFormProps {
  chat: Chat
  capability: EffectiveCapability | null
  // Preserved for forward-compat — future sampling fields (seed variance,
  // deterministic tokenizer-aware ops) may want it. Unused today.
  endpointTokenizer?: string | null | undefined
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
    hint: 'DRY (Don\'t Repeat Yourself) penalty multiplier. 0 disables.',
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

export function ParamForm({ chat, capability }: ParamFormProps) {
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

  if (!capability) return null

  return (
    <div data-ui="param-form">
      <SamplingSection chat={chat} capability={capability} />
      <ReasoningSection chat={chat} capability={capability} />
      <VerbositySection chat={chat} capability={capability} />
      <StopSection chat={chat} capability={capability} />
      <SystemPromptEditor chat={chat} />
    </div>
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
  // For adaptive-only models (Claude 4.7), the model controls reasoning
  // entirely — no knobs to expose. Rather than showing a useless block with
  // a single "off" toggle and an explanatory paragraph, hide the whole
  // section.
  if (adaptiveOnly) return null
  // OpenAI o-series returns reasoning opaquely — control rendering stays
  // the same, but the user won't see tokens in the response. Hide the
  // whole section for hidden-reasoning models to avoid implying the
  // knobs do something visible.
  if (capability.quirks.reasoningHidden === true) return null
  const supportsReasoning =
    capability.supportedParameters.has('reasoning') ||
    capability.supportedParameters.has('thinking')
  const modes = (['default', 'off', 'enabled', 'effort', 'budget'] as const).filter((m) => {
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
        <div data-ui="field-group" data-ui-field data-ui-slider-row>
          <span data-ui="slider-label">Max reasoning tokens</span>
          <input
            data-ui="slider"
            type="range"
            min={0}
            max={capability.maxCompletionTokens ?? 32000}
            step={1}
            value={Math.min(
              capability.maxCompletionTokens ?? 32000,
              Math.max(0, r.maxTokens ?? 0),
            )}
            onChange={(e) => updateReasoning({ maxTokens: Number(e.target.value) })}
          />
          <input
            data-ui="slider-number"
            type="number"
            min={0}
            max={capability.maxCompletionTokens ?? 32000}
            value={r.maxTokens ?? ''}
            placeholder="0"
            onChange={(e) => {
              const raw = e.target.value
              if (raw === '') return
              const n = Number(raw)
              if (Number.isFinite(n) && n >= 0)
                updateReasoning({ maxTokens: Math.floor(n) })
            }}
          />
        </div>
      ) : null}
    </section>
  )
}

function VerbositySection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  if (!capability.supportedParameters.has('verbosity')) return null
  const choices = capability.allowedVerbosity
  const selected = chat.settings.verbosity
  return (
    <section data-ui="settings-section" data-ui-section="verbosity">
      <h3>Verbosity</h3>
      <div data-ui="segmented">
        {choices.map((v) => (
          <button
            key={v}
            type="button"
            data-ui="segmented-option"
            aria-pressed={selected === v}
            onClick={() => void updateChatSettings(chat.id, { verbosity: v as VerbosityLevel })}
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
    const clean = next
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 4)
    void updateChatSettings(chat.id, clean.length === 0 ? { stop: [] } : { stop: clean })
  }
  return (
    <section data-ui="settings-section" data-ui-section="stop">
      <h3>Stop sequences</h3>
      <div data-ui="chip-input">
        {values.map((v, i) => (
          <span key={`${v}-${i}`} data-ui="chip">
            <code>{v}</code>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => setValues(values.filter((_, idx) => idx !== i))}
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

function LogitBiasSection({ chat, capability }: { chat: Chat; capability: EffectiveCapability }) {
  const [open, setOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  if (!capability.supportedParameters.has('logit_bias')) return null
  const raw = useMemo(
    () => (chat.settings.logitBias ? JSON.stringify(chat.settings.logitBias, null, 2) : ''),
    [chat.settings.logitBias],
  )
  const [draft, setDraft] = useState(raw)
  useEffect(() => {
    setDraft(raw)
    setErrorMsg(null)
  }, [raw])
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
            <button
              type="button"
              data-ui="logit-bias-btn"
              onClick={() => fileRef.current?.click()}
            >
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
    spec.integer
      ? String(n)
      : Number.isInteger(n)
        ? n.toFixed(1)
        : String(n)
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
        <InfoHint text={spec.hint} />
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

function InfoHint({ text }: { text: string }) {
  return (
    <button
      type="button"
      data-ui="info-hint"
      aria-label={text}
      title={text}
      tabIndex={-1}
      onClick={(e) => e.preventDefault()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="14" height="14">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="8" cy="4.5" r="0.9" fill="currentColor" />
        <path d="M8 6.8v5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    </button>
  )
}

// Re-exported so tests and other code can reference the spec list without
// importing individual fields.
export { SAMPLING_FIELDS }

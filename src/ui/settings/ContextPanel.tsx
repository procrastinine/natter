// Context control — the single most important piece of the settings pane
// per the user ("max tokens, current tokens used, chat truncation for
// tokens"). SillyTavern's fixed-context slider + live gauge is the
// reference.
//
// Layout (top-to-bottom):
// - Live gauge: used / (effective prompt budget). Colors escalate over
//   75% (warn) and 95% (danger). Compact breakdown row: system / history /
//   media.
// - Model context cap: compact one-liner showing the provider's cap and
//   the currently-effective budget.
// - Max context slider + numeric input (custom cap ≤ model cap). Drives
//   both the prompt budget and the "keep what in history" calculation.
// - Max completion slider + numeric input. Held back from the prompt
//   budget so the model always has room to reply; also caps the model's
//   actual completion length.
// - Truncation: "Keep last N pairs" numeric + Middle-out checkbox.
//   Overflow never fails, trimming is always done locally; middle-out is
//   additive (server-side compression of what remains).
//
// Visible values are pinned to the effective capability. Request planning
// derives a clamped snapshot without rewriting stored preferences on mount.

import { useEffect, useState } from 'react'
import {
  configurationWriteInteraction,
  configurationWriteTarget,
} from '../../app/presentation-interactions'
import type { EffectiveCapability } from '../../core/capabilities'
import type { ChatSettingsFieldPatch } from '../../core/chat-metadata'
import { type PromptSizeEstimate, UNLIMITED_CONTEXT } from '../../core/prompt-size'
import type { Chat, ChatId } from '../../core/types'
import { usePresentationInteraction } from '../../hooks/usePresentationInteraction'
import { useSettledChatSettingsEdit } from '../../hooks/useSettledConfigurationEdit'
import { configurationApplication } from '../../store/configuration-application'
import { Button } from '../primitives/Button'
import { InfoDisclosure } from './InfoDisclosure'

interface ContextPanelProps {
  chat: Chat
  capability: EffectiveCapability | null
  estimateOverride: PromptSizeEstimate | null
  // Middle-out is an OpenRouter plugin (`plugins:[{id:'context-compression'}]`);
  // the checkbox only makes sense on an OpenRouter connection.
  showMiddleOut?: boolean
}

export function ContextPanel({
  chat,
  capability,
  estimateOverride,
  showMiddleOut = false,
}: ContextPanelProps) {
  const { run: runConfigurationWrite } = usePresentationInteraction(configurationWriteInteraction, {
    observePending: false,
  })
  const estimate = estimateOverride
  const keepFirstPairsEdit = useSettledChatSettingsEdit({
    chatId: chat.id,
    fieldKey: 'contextStrategy.keepFirstPairs',
    storedValue: chat.settings.contextStrategy.keepFirstPairs ?? 0,
    patches: (value) => [{ path: ['contextStrategy', 'keepFirstPairs'], value }],
  })
  const mediaEchoEdit = useSettledChatSettingsEdit({
    chatId: chat.id,
    fieldKey: 'mediaEchoN',
    storedValue: chat.settings.mediaEchoN ?? 5,
    patches: (value) => [{ path: ['mediaEchoN'], value }],
  })

  if (!chat.settings.model) {
    return (
      <section data-ui="settings-section" data-ui-section="context-control">
        <p data-ui="helper">Select a model first.</p>
      </section>
    )
  }

  // Numeric caps drive every slider in this panel. Without a capability,
  // fallback numbers would have to be invented; last time those were 128k,
  // which briefly snapped 1M-context Gemini chats to a bogus ceiling and
  // clobbered customMaxContext on any render during the load. Render a
  // minimal placeholder instead so nothing is shown that can't be
  // honored. The panel re-renders as soon as live /endpoints lands.
  if (
    !capability ||
    (capability.contextLength === undefined &&
      capability.maxPromptTokens === undefined &&
      capability.maxCompletionTokens === undefined)
  ) {
    if (capability?.outputModalities.has('video')) {
      return (
        <section data-ui="settings-section" data-ui-section="context-control">
          <p data-ui="helper">Video generation does not expose a token context window.</p>
        </section>
      )
    }
    return (
      <section data-ui="settings-section" data-ui-section="context-control">
        <p data-ui="helper">Waiting for model capability…</p>
      </section>
    )
  }
  const modelCap = capability.contextLength ?? capability.maxPromptTokens
  const modelPromptCap = capability.maxPromptTokens ?? modelCap
  const modelCompletionCap = capability.maxCompletionTokens ?? modelCap
  // Every branch above guarantees at least one of these is defined;
  // assert so the slider arithmetic below reads cleanly.
  if (modelCap === undefined || modelPromptCap === undefined || modelCompletionCap === undefined) {
    return (
      <section data-ui="settings-section" data-ui-section="context-control">
        <p data-ui="helper">Waiting for model capability…</p>
      </section>
    )
  }
  if (!estimate) {
    return (
      <section data-ui="settings-section" data-ui-section="context-control">
        <p data-ui="helper">Waiting for prompt estimate…</p>
      </section>
    )
  }
  const customMaxStored = chat.settings.customMaxContext
  const customMaxUnlimited = customMaxStored === UNLIMITED_CONTEXT
  const customMax = customMaxStored ?? modelPromptCap
  const effectiveMax = customMaxUnlimited
    ? Number.POSITIVE_INFINITY
    : Math.min(customMax, modelPromptCap)
  const storedMaxCompletionRaw = chat.settings.maxCompletionTokens
  const storedMaxCompletion =
    storedMaxCompletionRaw === UNLIMITED_CONTEXT
      ? 0
      : (storedMaxCompletionRaw ?? Math.min(4096, modelCompletionCap))
  const strategy = chat.settings.contextStrategy
  const keepFirstPairs = keepFirstPairsEdit.value
  const useMiddleOut = strategy.useOpenRouterMiddleOut === true
  const effectivePromptBudget = Number.isFinite(effectiveMax)
    ? Math.max(0, effectiveMax - storedMaxCompletion)
    : Number.POSITIVE_INFINITY

  const usedTokens = estimate.total
  const budgetPct =
    Number.isFinite(effectivePromptBudget) && effectivePromptBudget > 0
      ? usedTokens / effectivePromptBudget
      : 0
  const overBudget = Number.isFinite(effectivePromptBudget) && usedTokens > effectivePromptBudget
  const warnLevel: 'ok' | 'warn' | 'danger' = overBudget
    ? 'danger'
    : budgetPct > 0.95
      ? 'danger'
      : budgetPct > 0.75
        ? 'warn'
        : 'ok'

  const updateStrategy = (patch: Partial<typeof strategy>) => {
    const fields = Object.entries(patch)
    runConfigurationWrite({
      target: configurationWriteTarget(
        chat.id,
        fields
          .map(([key]) => `contextStrategy.${key}`)
          .sort()
          .join('+'),
      ),
      action: () =>
        configurationApplication.patchChatSettingsFields(
          chat.id,
          fields.map(([key, value]) => ({
            path: ['contextStrategy', key],
            value,
          })),
        ),
    })
  }

  return (
    <section data-ui="settings-section" data-ui-section="context-control">
      {/* biome-ignore lint/a11y/useSemanticElements: this custom gauge needs an internal fill element that <meter> cannot provide. */}
      <div
        data-ui="context-gauge"
        data-warn-level={warnLevel}
        role="meter"
        aria-valuenow={usedTokens}
        aria-valuemin={0}
        aria-valuemax={effectivePromptBudget}
        aria-label="Estimated prompt tokens used"
        title="Approximate persisted-branch estimate: history may use provider-reported usage and media uses tokenizer-family heuristics. The complete current composer payload is included in fresh request planning when sent."
      >
        <div
          data-ui="context-gauge-fill"
          ref={(el) => {
            if (!el) return
            const pct = Math.min(100, Math.max(0, budgetPct * 100))
            el.style.setProperty('--context-fill', `${pct.toFixed(1)}%`)
          }}
        />
        <div data-ui="context-gauge-label">
          <strong>≈ {usedTokens.toLocaleString()}</strong>
          <span>
            {' '}
            /{' '}
            {Number.isFinite(effectivePromptBudget) ? effectivePromptBudget.toLocaleString() : '∞'}{' '}
            tokens
          </span>
          {overBudget ? (
            <span data-ui="status-text" data-tone="danger">
              {' '}
              · over budget
            </span>
          ) : null}
        </div>
      </div>
      <div data-ui="context-gauge-breakdown-compact">
        <span>
          <em>sys</em> {estimate.systemTokens.toLocaleString()}
        </span>
        <span>
          <em>chat</em> {estimate.historyTokens.toLocaleString()}
        </span>
        {estimate.mediaTokens > 0 ? (
          <span>
            <em>media</em> {estimate.mediaTokens.toLocaleString()}
          </span>
        ) : null}
        {estimate.reasoningTokens > 0 ? (
          <span title="Reasoning echoed back on the next turn, filtered by the Include checkboxes in the Context tab">
            <em>reasoning</em> {estimate.reasoningTokens.toLocaleString()}
          </span>
        ) : null}
        {estimate.toolCallTokens > 0 ? (
          <span title="Tool calls and results echoed on the next turn, filtered by the Tool calls row under Include in next turn and per-item eye toggles">
            <em>tools</em> {estimate.toolCallTokens.toLocaleString()}
          </span>
        ) : null}
        <span data-ui="context-model-cap">
          <em>cap</em> {modelCap.toLocaleString()}
        </span>
      </div>

      <NumberSlider
        chatId={chat.id}
        fieldKey="customMaxContext"
        label="Max context"
        value={customMaxUnlimited ? UNLIMITED_CONTEXT : customMax}
        min={1024}
        max={modelPromptCap}
        allowUnlimited
        unlimitedHint="Typing -1 disables the local cap (provider limits still apply; pair with middle-out compression for long chats)."
        patches={(v) => {
          if (v === UNLIMITED_CONTEXT) {
            return [{ path: ['customMaxContext'], value: UNLIMITED_CONTEXT }]
          }
          const next = Math.min(Math.max(1024, v), modelPromptCap)
          if (next >= modelPromptCap) {
            return [{ path: ['customMaxContext'] }]
          }
          return [{ path: ['customMaxContext'], value: next }]
        }}
      />

      <NumberSlider
        chatId={chat.id}
        fieldKey="maxCompletionTokens"
        label="Max completion"
        value={
          storedMaxCompletionRaw === UNLIMITED_CONTEXT ? UNLIMITED_CONTEXT : storedMaxCompletion
        }
        min={1}
        max={modelCompletionCap}
        allowUnlimited
        unlimitedHint="Typing -1 removes the local completion cap (provider limits still apply)."
        patches={(v) => {
          if (v === UNLIMITED_CONTEXT) {
            return [{ path: ['maxCompletionTokens'], value: UNLIMITED_CONTEXT }]
          }
          const next = Math.min(Math.max(1, v), modelCompletionCap)
          return [{ path: ['maxCompletionTokens'], value: next }]
        }}
      />

      <label data-ui="field-group" data-ui-field data-ui-inline-number-row>
        <span>
          Keep first N pairs
          <InfoDisclosure title="Pin the first N user+assistant pairs at the top of the chat. Later turns are dropped from the middle to fit the budget; the most recent turns always stay. 0 = plain sliding window (drop oldest)." />
        </span>
        <input
          type="number"
          value={keepFirstPairs}
          min={0}
          step={1}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n) && n >= 0) keepFirstPairsEdit.setValue(Math.floor(n))
          }}
          onBlur={keepFirstPairsEdit.onBlur}
        />
      </label>

      {showMiddleOut ? (
        <label data-ui="toggle-row">
          <input
            type="checkbox"
            checked={useMiddleOut}
            onChange={(e) => updateStrategy({ useOpenRouterMiddleOut: e.target.checked })}
          />
          <span>
            Use OpenRouter middle-out compression
            <InfoDisclosure title="After local trimming, send plugins:[{id:'context-compression'}] so OpenRouter compresses any remaining middle-of-chat messages." />
          </span>
        </label>
      ) : null}

      <section data-ui="attachment-context-settings" aria-label="Attachment context settings">
        <div data-ui="settings-subheader">
          <span>
            Files
            <InfoDisclosure title="Chat-level default for media/file echo. Per-attachment chips still win: hiding one ref excludes only that exact reference." />
          </span>
        </div>
        <fieldset data-ui="segmented" aria-label="Attachment inclusion">
          {(
            [
              ['echo-all', 'All'],
              ['echo-last-N', 'Recent'],
              ['echo-user-only', 'User'],
              ['drop-all', 'Off'],
            ] as const
          ).map(([value, label]) => (
            <Button
              key={value}
              type="button"
              data-ui="segmented-option"
              aria-pressed={chat.settings.mediaContextStrategy === value}
              onClick={() =>
                runConfigurationWrite({
                  target: configurationWriteTarget(chat.id, 'mediaContextStrategy'),
                  action: () =>
                    configurationApplication.patchChatSettings(chat.id, {
                      mediaContextStrategy: value,
                    }),
                })
              }
            >
              {label}
            </Button>
          ))}
        </fieldset>
        {chat.settings.mediaContextStrategy === 'echo-last-N' ? (
          <label data-ui="field-group" data-ui-field data-ui-inline-number-row>
            <span>
              Recent refs
              <InfoDisclosure title="Number of most-recent attachment references to include when the chat-level media policy is Recent. Individual hidden refs remain excluded." />
            </span>
            <input
              type="number"
              min={1}
              step={1}
              value={mediaEchoEdit.value}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value) || value < 1) return
                mediaEchoEdit.setValue(Math.floor(value))
              }}
              onBlur={mediaEchoEdit.onBlur}
            />
          </label>
        ) : null}
      </section>
    </section>
  )
}

function NumberSlider({
  chatId,
  fieldKey,
  label,
  value,
  min,
  max,
  patches,
  allowUnlimited = false,
  unlimitedHint,
}: {
  chatId: ChatId
  fieldKey: string
  label: string
  value: number
  min: number
  max: number
  patches: (v: number) => readonly ChatSettingsFieldPatch[]
  // When true, the numeric input accepts `-1` as a sentinel for "no local
  // cap" (`UNLIMITED_CONTEXT`). The slider visually sits at max but the
  // stored value stays at -1 so preset round-trip preserves intent.
  allowUnlimited?: boolean
  unlimitedHint?: string
}) {
  const edit = useSettledChatSettingsEdit({
    chatId,
    fieldKey,
    storedValue: value,
    patches,
  })
  const isUnlimited = allowUnlimited && edit.value === UNLIMITED_CONTEXT
  const sliderValue = isUnlimited ? max : Math.min(max, Math.max(min, edit.value))
  const [draft, setDraft] = useState(isUnlimited ? '-1' : String(edit.value))
  useEffect(() => {
    setDraft(isUnlimited ? '-1' : String(edit.value))
  }, [edit.value, isUnlimited])

  const commitFromDraft = () => {
    const n = Number(draft)
    if (!Number.isFinite(n)) {
      setDraft(isUnlimited ? '-1' : String(edit.value))
      return
    }
    if (allowUnlimited && n <= UNLIMITED_CONTEXT) {
      edit.setValue(UNLIMITED_CONTEXT)
      setDraft('-1')
      edit.onBlur()
      return
    }
    const clamped = Math.min(Math.max(n, min), max)
    edit.setValue(clamped)
    setDraft(String(clamped))
    edit.onBlur()
  }
  // Step of 1 guarantees the slider hits both endpoints. Previous
  // implementation used `floor((max-min)/1000)` which left the top ~step
  // unreachable whenever (max-min) wasn't cleanly divisible — e.g. a
  // 128000-range stopped at 127872 because 128000 isn't a multiple of 127.
  // Browsers handle integer step=1 on ranges up to ~2M without perf
  // issues, which covers every model cap that will ever be seen.
  return (
    <div data-ui="field-group" data-ui-field data-ui-slider-row>
      <span data-ui="slider-label">
        {label}
        {isUnlimited ? <span data-ui="slider-unlimited-badge"> · ∞</span> : null}
      </span>
      <input
        data-ui="slider"
        type="range"
        min={min}
        max={max}
        step={1}
        // Slider doesn't participate in the -1 sentinel: park it at `max`
        // when unlimited so the track stays usable (nudging the slider
        // exits unlimited mode via onChange → commit below).
        value={sliderValue}
        onChange={(e) => {
          const next = Number(e.target.value)
          edit.setValue(next)
          setDraft(String(next))
        }}
        onPointerUp={edit.onPointerUp}
        onBlur={edit.onBlur}
        {...(isUnlimited ? { 'data-unlimited': 'true' } : {})}
      />
      <input
        data-ui="slider-number"
        type="number"
        value={draft}
        // Allow -1 via the text box by NOT clamping `min` when unlimited
        // is on — browsers honor `min` and auto-correct.
        {...(allowUnlimited ? {} : { min })}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitFromDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(isUnlimited ? '-1' : String(edit.value))
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        {...(unlimitedHint && allowUnlimited ? { title: unlimitedHint } : {})}
      />
    </div>
  )
}

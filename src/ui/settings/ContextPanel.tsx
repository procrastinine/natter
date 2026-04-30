// Context control — the single most important piece of the settings pane
// per the user ("max tokens, current tokens used, chat truncation for
// tokens"). SillyTavern's fixed-context slider + live gauge is the
// reference.
//
// Layout (top-to-bottom):
// - Live gauge: used / (effective prompt budget). Colors escalate over
//   75% (warn) and 95% (danger). Compact breakdown row: system / history /
//   media / draft.
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
// All values are pinned to the effective capability; `validateChatSettings`
// re-clamps when the model changes.

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EffectiveCapability } from '../../core/capabilities'
import { DEFAULT_GLOBAL_PREFERENCES, readGlobalPreferences } from '../../core/global-settings'
import {
  estimateSettingsPromptSize,
  type PromptSizeEstimate,
  UNLIMITED_CONTEXT,
} from '../../core/prompt-size'
import { readTokenCalibrationGlobal } from '../../core/token-calibration'
import type { Chat, Message } from '../../core/types'
import { getChatDraft, loadActiveBranchSnapshot, updateChatSettings } from '../../store/chats'
import { useChatStore } from '../../store/zustand/chatStore'
import { useAttachmentResolverForContext } from '../attachments/useAttachmentResolver'
import { InfoDisclosure } from './InfoDisclosure'

interface ContextPanelProps {
  chat: Chat
  capability: EffectiveCapability | null
  endpointTokenizer: string | null | undefined
  estimateOverride?: PromptSizeEstimate | null
  // Middle-out is an OpenRouter plugin (`plugins:[{id:'context-compression'}]`);
  // the checkbox only makes sense on an OpenRouter connection.
  showMiddleOut?: boolean
}

export function ContextPanel({
  chat,
  capability,
  endpointTokenizer,
  estimateOverride = null,
  showMiddleOut = false,
}: ContextPanelProps) {
  const needsLocalEstimate = estimateOverride === null
  const cursor = useChatStore((s) =>
    needsLocalEstimate ? (s.cursors[chat.id] ?? EMPTY_CURSOR) : EMPTY_CURSOR,
  )
  const branchSnapshot = useLiveQuery(
    () =>
      needsLocalEstimate ? loadActiveBranchSnapshot(chat.id, cursor) : Promise.resolve(null),
    [chat.id, needsLocalEstimate, cursor],
    null,
  )
  const draft = useLiveQuery(
    () => (needsLocalEstimate ? getChatDraft(chat.id) : Promise.resolve(undefined)),
    [chat.id, needsLocalEstimate],
    undefined,
  )
  const prefs = useLiveQuery(
    () =>
      needsLocalEstimate ? readGlobalPreferences() : Promise.resolve(DEFAULT_GLOBAL_PREFERENCES),
    [needsLocalEstimate],
    DEFAULT_GLOBAL_PREFERENCES,
  )
  const globalCalibration = useLiveQuery(
    () => (needsLocalEstimate ? readTokenCalibrationGlobal() : Promise.resolve(null)),
    [needsLocalEstimate],
    null,
  )
  // Flatten capability to a single providerCap number so the memo's
  // dependency array is primitive (capability objects can re-render the
  // parent without changing their prompt-cap). `null` disables cutoff when
  // capability hasn't loaded; once it does, the memo re-runs.
  const providerCap = capability?.maxPromptTokens ?? capability?.contextLength ?? null
  const localPath = needsLocalEstimate ? (branchSnapshot?.branch ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  const attachmentResolver = useAttachmentResolverForContext({
    settings: chat.settings,
    messages: localPath,
    draftAttachmentRefs: draft?.attachmentRefs,
    enabled: needsLocalEstimate,
  })
  const localEstimate = useMemo(() => {
    if (!needsLocalEstimate) return null
    return estimateSettingsPromptSize(
      chat.settings,
      localPath,
      draft?.text ?? '',
      endpointTokenizer ?? null,
      providerCap,
      attachmentResolver,
      {
        chatTokenCalibration: chat.tokenCalibration,
        globalCalibration,
        mode: prefs.tokenCalibrationMode,
      },
      draft?.attachmentRefs,
    )
  }, [
    needsLocalEstimate,
    localPath,
    chat.settings,
    chat.tokenCalibration,
    draft,
    endpointTokenizer,
    providerCap,
    attachmentResolver,
    globalCalibration,
    prefs.tokenCalibrationMode,
  ])
  const estimate = estimateOverride ?? localEstimate

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
  const keepFirstPairs = strategy.keepFirstPairs ?? 0
  const useMiddleOut = strategy.useOpenRouterMiddleOut === true
  const effectivePromptBudget = Number.isFinite(effectiveMax)
    ? Math.max(0, (effectiveMax) - storedMaxCompletion)
    : Number.POSITIVE_INFINITY

  const usedTokens = estimate.total
  const budgetPct =
    Number.isFinite(effectivePromptBudget) && effectivePromptBudget > 0
      ? usedTokens / (effectivePromptBudget)
      : 0
  const overBudget = Number.isFinite(effectivePromptBudget) && usedTokens > effectivePromptBudget
  const warnLevel: 'ok' | 'warn' | 'danger' = overBudget
    ? 'danger'
    : budgetPct > 0.95
      ? 'danger'
      : budgetPct > 0.75
        ? 'warn'
        : 'ok'

  const updateStrategy = (patch: Partial<typeof strategy>) =>
    void updateChatSettings(chat.id, { contextStrategy: { ...strategy, ...patch } })

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
        aria-label="Prompt tokens used"
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
          <strong>{usedTokens.toLocaleString()}</strong>
          <span>
            {' '}
            /{' '}
            {Number.isFinite(effectivePromptBudget) ? effectivePromptBudget.toLocaleString() : '∞'}{' '}
            tokens
          </span>
          {overBudget ? <span data-tone="danger"> · over budget</span> : null}
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
        {estimate.draftTokens > 0 ? (
          <span>
            <em>draft</em> {estimate.draftTokens.toLocaleString()}
          </span>
        ) : null}
        <span data-ui="context-model-cap">
          <em>cap</em> {modelCap.toLocaleString()}
        </span>
      </div>

      <NumberSlider
        label="Max context"
        value={customMaxUnlimited ? UNLIMITED_CONTEXT : customMax}
        min={1024}
        max={modelPromptCap}
        allowUnlimited
        unlimitedHint="Typing -1 disables the local cap (provider limits still apply; pair with middle-out compression for long chats)."
        onCommit={(v) => {
          if (v === UNLIMITED_CONTEXT) {
            void updateChatSettings(chat.id, { customMaxContext: UNLIMITED_CONTEXT })
            return
          }
          const next = Math.min(Math.max(1024, v), modelPromptCap)
          if (next >= modelPromptCap) {
            // Removing customMaxContext (rather than clamping to modelPromptCap)
            // lets the chat follow the model cap on future model swaps.
            // exactOptionalPropertyTypes rejects `undefined` as a value here,
            // so a cast is required to write the deleted key.
            const patch = { customMaxContext: undefined } as unknown as Partial<Chat['settings']>
            void updateChatSettings(chat.id, patch)
          } else {
            void updateChatSettings(chat.id, { customMaxContext: next })
          }
        }}
      />

      <NumberSlider
        label="Max completion"
        value={
          storedMaxCompletionRaw === UNLIMITED_CONTEXT ? UNLIMITED_CONTEXT : storedMaxCompletion
        }
        min={1}
        max={modelCompletionCap}
        allowUnlimited
        unlimitedHint="Typing -1 removes the local completion cap (provider limits still apply)."
        onCommit={(v) => {
          if (v === UNLIMITED_CONTEXT) {
            void updateChatSettings(chat.id, { maxCompletionTokens: UNLIMITED_CONTEXT })
            return
          }
          const next = Math.min(Math.max(1, v), modelCompletionCap)
          void updateChatSettings(chat.id, { maxCompletionTokens: next })
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
            if (Number.isFinite(n) && n >= 0) updateStrategy({ keepFirstPairs: Math.floor(n) })
          }}
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
            <button
              key={value}
              type="button"
              data-ui="segmented-option"
              aria-pressed={chat.settings.mediaContextStrategy === value}
              onClick={() =>
                void updateChatSettings(chat.id, {
                  mediaContextStrategy: value,
                })
              }
            >
              {label}
            </button>
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
              value={chat.settings.mediaEchoN ?? 5}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (!Number.isFinite(value) || value < 1) return
                void updateChatSettings(chat.id, { mediaEchoN: Math.floor(value) })
              }}
            />
          </label>
        ) : null}
      </section>
    </section>
  )
}

function NumberSlider({
  label,
  value,
  min,
  max,
  onCommit,
  allowUnlimited = false,
  unlimitedHint,
}: {
  label: string
  value: number
  min: number
  max: number
  onCommit: (v: number) => void
  // When true, the numeric input accepts `-1` as a sentinel for "no local
  // cap" (`UNLIMITED_CONTEXT`). The slider visually sits at max but the
  // stored value stays at -1 so preset round-trip preserves intent.
  allowUnlimited?: boolean
  unlimitedHint?: string
}) {
  const isUnlimited = allowUnlimited && value === UNLIMITED_CONTEXT
  const committedSliderValue = isUnlimited ? max : Math.min(max, Math.max(min, value))
  const [draft, setDraft] = useState(isUnlimited ? '-1' : String(value))
  const [sliderValue, setSliderValue] = useState(committedSliderValue)
  useEffect(() => {
    setDraft(isUnlimited ? '-1' : String(value))
    setSliderValue(committedSliderValue)
  }, [isUnlimited, value, committedSliderValue])

  const commitSliderDraft = useCallback(() => {
    const clamped = Math.min(Math.max(sliderValue, min), max)
    if (clamped !== committedSliderValue) onCommit(clamped)
  }, [sliderValue, min, max, committedSliderValue, onCommit])

  useEffect(() => {
    if (sliderValue === committedSliderValue) return
    const id = window.setTimeout(() => {
      commitSliderDraft()
    }, SLIDER_COMMIT_DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [sliderValue, committedSliderValue, commitSliderDraft])

  const commitFromDraft = () => {
    const n = Number(draft)
    if (!Number.isFinite(n)) {
      setDraft(isUnlimited ? '-1' : String(value))
      setSliderValue(committedSliderValue)
      return
    }
    if (allowUnlimited && n <= UNLIMITED_CONTEXT) {
      if (value !== UNLIMITED_CONTEXT) onCommit(UNLIMITED_CONTEXT)
      setDraft('-1')
      setSliderValue(max)
      return
    }
    const clamped = Math.min(Math.max(n, min), max)
    if (clamped !== value) onCommit(clamped)
    setDraft(String(clamped))
    setSliderValue(clamped)
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
          setSliderValue(next)
          setDraft(String(next))
        }}
        onPointerUp={commitSliderDraft}
        onBlur={commitSliderDraft}
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
            setDraft(isUnlimited ? '-1' : String(value))
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        {...(unlimitedHint && allowUnlimited ? { title: unlimitedHint } : {})}
      />
    </div>
  )
}

const SLIDER_COMMIT_DEBOUNCE_MS = 200

const EMPTY_CURSOR = Object.freeze({}) as Readonly<Record<string, string>>
const EMPTY_MESSAGES: Message[] = []

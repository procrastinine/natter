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
//   Overflow never fails — we always trim locally; middle-out is
//   additive (server-side compression of what remains).
//
// All values are pinned to the effective capability; `validateChatSettings`
// re-clamps when the model changes.

import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { activePath } from '../../core/active-path'
import type { EffectiveCapability } from '../../core/capabilities'
import { estimatePromptSize, tokenizerFromSettings } from '../../core/prompt-size'
import type { Chat } from '../../core/types'
import { getChatDraft, loadChatMessages, updateChatSettings } from '../../store/chats'
import { useChatStore } from '../../store/zustand/chatStore'

export interface ContextPanelProps {
  chat: Chat
  capability: EffectiveCapability | null
  endpointTokenizer: string | null | undefined
  // Middle-out is an OpenRouter plugin (`plugins:[{id:'context-compression'}]`);
  // the checkbox only makes sense on an OpenRouter connection.
  showMiddleOut?: boolean
}

export function ContextPanel({
  chat,
  capability,
  endpointTokenizer,
  showMiddleOut = false,
}: ContextPanelProps) {
  const messages = useLiveQuery(() => loadChatMessages(chat.id), [chat.id], [])
  const cursor = useChatStore((s) => s.cursors[chat.id] ?? EMPTY_CURSOR)
  const draft = useLiveQuery(
    () => getChatDraft(chat.id).then((d) => d?.text ?? ''),
    [chat.id],
    '',
  )
  const estimate = useMemo(() => {
    const path = activePath(messages, cursor)
    return estimatePromptSize({
      systemPrompt: chat.settings.systemPrompt,
      activePathMessages: path,
      draftText: draft ?? '',
      tokenizer: tokenizerFromSettings(chat.settings, endpointTokenizer ?? null),
    })
  }, [messages, cursor, chat.settings, draft, endpointTokenizer])

  // Numeric caps drive every slider in this panel. Without a capability
  // we'd have to invent fallback numbers — last time those were 128k,
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
    return (
      <section data-ui="settings-section" data-ui-section="context-control">
        <h3>Context</h3>
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
        <h3>Context</h3>
        <p data-ui="helper">Waiting for model capability…</p>
      </section>
    )
  }
  const customMax = chat.settings.customMaxContext ?? modelPromptCap
  const effectiveMax = Math.min(customMax, modelPromptCap)
  const storedMaxCompletion = chat.settings.maxCompletionTokens ?? Math.min(4096, modelCompletionCap)
  const strategy = chat.settings.contextStrategy
  const keepFirstPairs = strategy.keepFirstPairs ?? 0
  const useMiddleOut = strategy.useOpenRouterMiddleOut === true
  const effectivePromptBudget = Math.max(0, effectiveMax - storedMaxCompletion)

  const usedTokens = estimate.total
  const budgetPct = effectivePromptBudget > 0 ? usedTokens / effectivePromptBudget : 0
  const overBudget = usedTokens > effectivePromptBudget
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
      <h3>Context</h3>
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
          <span> / {effectivePromptBudget.toLocaleString()} tokens</span>
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
        value={customMax}
        min={1024}
        max={modelPromptCap}
        onCommit={(v) => {
          const next = Math.min(Math.max(1024, v), modelPromptCap)
          if (next >= modelPromptCap) {
            // Removing customMaxContext (rather than clamping to modelPromptCap)
            // lets the chat follow the model cap on future model swaps.
            // exactOptionalPropertyTypes rejects `undefined` as a value here,
            // so we cast to write the deleted key.
            const patch = { customMaxContext: undefined } as unknown as Partial<Chat['settings']>
            void updateChatSettings(chat.id, patch)
          } else {
            void updateChatSettings(chat.id, { customMaxContext: next })
          }
        }}
      />

      <NumberSlider
        label="Max completion"
        value={storedMaxCompletion}
        min={1}
        max={modelCompletionCap}
        onCommit={(v) => {
          const next = Math.min(Math.max(1, v), modelCompletionCap)
          void updateChatSettings(chat.id, { maxCompletionTokens: next })
        }}
      />

      <label data-ui="field-group" data-ui-field>
        <span>
          Keep first N pairs
          <InfoHintSpan text="Pin the first N user+assistant pairs at the top of the chat. Later turns are dropped from the middle to fit the budget; the most recent turns always stay. 0 = plain sliding window (drop oldest)." />
        </span>
        <input
          type="number"
          value={keepFirstPairs}
          min={0}
          step={1}
          onChange={(e) => {
            const n = Number(e.target.value)
            if (Number.isFinite(n) && n >= 0)
              updateStrategy({ keepFirstPairs: Math.floor(n) })
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
            <InfoHintSpan text="After local trimming, send plugins:[{id:'context-compression'}] so OpenRouter compresses any remaining middle-of-chat messages." />
          </span>
        </label>
      ) : null}
    </section>
  )
}

function NumberSlider({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])
  const commitFromDraft = () => {
    const n = Number(draft)
    if (!Number.isFinite(n)) {
      setDraft(String(value))
      return
    }
    const clamped = Math.min(Math.max(n, min), max)
    if (clamped !== value) onCommit(clamped)
    setDraft(String(clamped))
  }
  // Step of 1 guarantees the slider hits both endpoints. Previous
  // implementation used `floor((max-min)/1000)` which left the top ~step
  // unreachable whenever (max-min) wasn't cleanly divisible — e.g. a
  // 128000-range stopped at 127872 because 128000 isn't a multiple of 127.
  // Browsers handle integer step=1 on ranges up to ~2M without perf
  // issues, which covers every model cap we'll see.
  return (
    <div data-ui="field-group" data-ui-field data-ui-slider-row>
      <span data-ui="slider-label">{label}</span>
      <input
        data-ui="slider"
        type="range"
        min={min}
        max={max}
        step={1}
        value={Math.min(max, Math.max(min, value))}
        onChange={(e) => onCommit(Number(e.target.value))}
      />
      <input
        data-ui="slider-number"
        type="number"
        value={draft}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commitFromDraft}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setDraft(String(value))
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
    </div>
  )
}

function InfoHintSpan({ text }: { text: string }) {
  return (
    <span data-ui="info-hint" title={text} aria-label={text}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
        <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
        <circle cx="8" cy="4.5" r="0.9" fill="currentColor" />
        <path d="M8 6.8v5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      </svg>
    </span>
  )
}

const EMPTY_CURSOR = Object.freeze({}) as Readonly<Record<string, string>>

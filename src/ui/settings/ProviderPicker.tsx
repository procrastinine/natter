// Provider picker. See `plan/10-ui.md §10.5` and `plan/07-discovery.md §7.2`.
//
// Per-provider checkbox (checked = used, unchecked = excluded from routing)
// plus an info (i) button to reveal the full endpoint details — pricing,
// uptime, latency, quantization, context length, tokenizer, etc. Reorder
// arrows (↑/↓) remain so the user can nudge preferred providers to the top.
// Non-OpenRouter connections render nothing (the parent already hides us,
// but we return null defensively).

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useMemo, useState } from 'react'
import { activePath } from '../../core/active-path'
import { estimatePromptSize, tokenizerFromSettings } from '../../core/prompt-size'
import type { Chat, ModelEndpoint, ProviderPreferences } from '../../core/types'
import { useEndpoints } from '../../hooks/useEndpoints'
import { loadChatMessages, updateChatSettings } from '../../store/chats'
import { getDb } from '../../store/db'
import { useChatStore } from '../../store/zustand/chatStore'

export interface ProviderPickerProps {
  chat: Chat
}

const EMPTY_CURSOR = Object.freeze({}) as Readonly<Record<string, string>>

export function ProviderPicker({ chat }: ProviderPickerProps) {
  const { endpoints, loading, refresh } = useEndpoints(
    chat.settings.profileId,
    chat.settings.model || null,
  )
  const prefs = chat.settings.providerPrefs ?? {}
  const ordered = useMemo(() => orderEndpoints(endpoints, prefs), [endpoints, prefs])

  // Compute the CURRENT prompt size so "insufficient context" reflects what
  // the next send would actually need — not the user's theoretical ceiling.
  // A 100k-cap provider is perfectly usable when the conversation is 5k
  // tokens; blocking it on the basis of customMaxContext=200k is surprising.
  // This matches what the Composer's token indicator and the ContextPanel
  // gauge already show. When estimate is loading (live-query race on first
  // mount), neededTokens stays 0 so no provider is wrongly disabled.
  const messages = useLiveQuery(() => loadChatMessages(chat.id), [chat.id], [])
  const cursor = useChatStore((s) => s.cursors[chat.id] ?? EMPTY_CURSOR)
  const draft = useLiveQuery(
    () =>
      getDb()
        .drafts.get(chat.id)
        .then((d) => d?.text ?? ''),
    [chat.id],
    '',
  )
  const neededTokens = useMemo(() => {
    const path = activePath(messages, cursor)
    const est = estimatePromptSize({
      systemPrompt: chat.settings.systemPrompt,
      activePathMessages: path,
      draftText: draft ?? '',
      tokenizer: tokenizerFromSettings(chat.settings, null),
    })
    const reserve = chat.settings.maxCompletionTokens ?? 0
    return est.total + reserve
  }, [messages, cursor, chat.settings, draft])

  const updatePrefs = useCallback(
    (patch: Partial<ProviderPreferences>) => {
      const next: ProviderPreferences = { ...(chat.settings.providerPrefs ?? {}), ...patch }
      void updateChatSettings(chat.id, { providerPrefs: next })
    },
    [chat.id, chat.settings.providerPrefs],
  )

  const toggleProvider = useCallback(
    (providerName: string, enabled: boolean) => {
      const ignore = new Set(prefs.ignore ?? [])
      if (enabled) ignore.delete(providerName)
      else ignore.add(providerName)
      updatePrefs({ ignore: [...ignore] })
    },
    [prefs.ignore, updatePrefs],
  )

  const moveBy = useCallback(
    (providerName: string, delta: 1 | -1) => {
      const current = [...(prefs.order ?? ordered.map((e) => e.provider_name))]
      const idx = current.indexOf(providerName)
      if (idx < 0) current.push(providerName)
      const from = current.indexOf(providerName)
      const to = Math.max(0, Math.min(current.length - 1, from + delta))
      if (from === to) return
      current.splice(from, 1)
      current.splice(to, 0, providerName)
      updatePrefs({ order: current })
    },
    [ordered, prefs.order, updatePrefs],
  )

  const resetPrefs = useCallback(() => {
    // `{}` instead of `undefined` keeps the field shape consistent with
    // exactOptionalPropertyTypes — behaves identically to "no prefs" on the
    // wire because the transformer only emits set fields.
    void updateChatSettings(chat.id, { providerPrefs: {} })
  }, [chat.id])

  if (!chat.settings.model) return null

  return (
    <div data-ui="settings-section" data-ui-section="provider-picker">
      <header data-ui="provider-picker-header">
        <h3>Providers</h3>
        <button
          type="button"
          data-ui="icon-button"
          onClick={() => refresh()}
          aria-label="Reload providers"
          title="Reload providers"
          aria-busy={loading}
        >
          <ReloadIcon />
        </button>
      </header>
      <label data-ui="provider-picker-strict">
        <input
          type="checkbox"
          checked={chat.settings.strictProviderRouting === true}
          onChange={(e) => {
            const checked = e.target.checked
            void updateChatSettings(chat.id, {
              strictProviderRouting: checked,
              providerPrefs: {
                ...(chat.settings.providerPrefs ?? {}),
                requireParameters: checked,
              },
            })
          }}
        />
        <span>
          Strict mode
          <span
            data-ui="info-hint"
            aria-label="Only route to providers that support every set parameter. Unchecked: send all parameters; providers ignore unsupported ones."
            title="Only route to providers that support every set parameter. Unchecked: send all parameters; providers ignore unsupported ones."
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
              <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
              <circle cx="8" cy="4.5" r="0.9" fill="currentColor" />
              <path d="M8 6.8v5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          </span>
        </span>
      </label>
      {ordered.length === 0 ? (
        <p data-ui="helper">
          {loading ? 'Loading…' : 'No providers available for this model.'}
        </p>
      ) : (
        <ul data-ui="provider-picker-list">
          {ordered.map((ep, idx) => {
            const epCap = ep.max_prompt_tokens ?? ep.context_length
            // "Insufficient" means the provider literally cannot fit the
            // current prompt + reserved completion — not just that its cap
            // is below the user's preferred ceiling. We only block here
            // because sending to an over-cap provider guarantees a 400.
            const insufficient =
              epCap !== undefined && epCap > 0 && neededTokens > epCap
            return (
              <ProviderRow
                key={`${ep.provider_name}:${idx}`}
                endpoint={ep}
                ignored={prefs.ignore?.includes(ep.provider_name) ?? false}
                insufficientContext={insufficient}
                onToggle={(on) => toggleProvider(ep.provider_name, on)}
                onMoveUp={() => moveBy(ep.provider_name, -1)}
                onMoveDown={() => moveBy(ep.provider_name, 1)}
              />
            )
          })}
        </ul>
      )}
      {(prefs.ignore?.length ?? 0) > 0 || (prefs.order?.length ?? 0) > 0 ? (
        <footer data-ui="provider-picker-footer">
          <button type="button" data-ui="field-inline-action" onClick={resetPrefs}>
            Reset
          </button>
        </footer>
      ) : null}
    </div>
  )
}

function orderEndpoints(
  endpoints: readonly ModelEndpoint[],
  prefs: ProviderPreferences,
): ModelEndpoint[] {
  const order = prefs.order ?? []
  const byName = new Map<string, ModelEndpoint>()
  for (const ep of endpoints) byName.set(ep.provider_name, ep)
  const out: ModelEndpoint[] = []
  const seen = new Set<string>()
  for (const name of order) {
    const hit = byName.get(name)
    if (hit && !seen.has(name)) {
      out.push(hit)
      seen.add(name)
    }
  }
  for (const ep of endpoints) {
    if (!seen.has(ep.provider_name)) out.push(ep)
  }
  return out
}

function ProviderRow({
  endpoint,
  ignored,
  insufficientContext,
  onToggle,
  onMoveUp,
  onMoveDown,
}: {
  endpoint: ModelEndpoint
  ignored: boolean
  insufficientContext: boolean
  onToggle: (enabled: boolean) => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const pricingLabel = useMemo(() => {
    const prompt = Number(endpoint.pricing.prompt)
    const completion = Number(endpoint.pricing.completion)
    if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return ''
    const parts: string[] = []
    if (Number.isFinite(prompt)) parts.push(`$${(prompt * 1_000_000).toFixed(2)}/M in`)
    if (Number.isFinite(completion)) parts.push(`$${(completion * 1_000_000).toFixed(2)}/M out`)
    return parts.join(' · ')
  }, [endpoint.pricing])
  // OpenRouter returns uptime as a percent (e.g. 99.39). Throughput is
  // more useful than latency-to-first-byte for comparing providers — a
  // fast TTFT with slow tokens is worse than the other way around — so
  // we surface tok/s here and reserve latency for the details panel.
  const uptimeLabel =
    endpoint.uptime_last_30m !== undefined ? `${endpoint.uptime_last_30m.toFixed(1)}% up` : ''
  const throughput = endpoint.throughput_last_30m as
    | { p50?: number; tokensPerSecond?: number }
    | undefined
  const throughputLabel = (() => {
    const tps =
      typeof throughput?.p50 === 'number'
        ? throughput.p50
        : typeof throughput?.tokensPerSecond === 'number'
          ? throughput.tokensPerSecond
          : undefined
    if (tps === undefined) return ''
    return `${tps.toFixed(0)} tok/s`
  })()
  return (
    <li
      data-ui="provider-picker-row"
      data-ignored={ignored ? 'true' : undefined}
      data-insufficient-context={insufficientContext ? 'true' : undefined}
    >
      <div data-ui="provider-picker-row-head">
        <label data-ui="provider-picker-toggle">
          <input
            type="checkbox"
            checked={!ignored && !insufficientContext}
            disabled={insufficientContext}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Use ${endpoint.provider_name}`}
          />
          <span data-ui="provider-picker-name">{endpoint.provider_name}</span>
        </label>
        <div data-ui="provider-picker-row-actions">
          <button
            type="button"
            data-ui="icon-button"
            data-compact
            onClick={onMoveUp}
            aria-label="Move up"
            title="Move up"
          >
            ↑
          </button>
          <button
            type="button"
            data-ui="icon-button"
            data-compact
            onClick={onMoveDown}
            aria-label="Move down"
            title="Move down"
          >
            ↓
          </button>
          <button
            type="button"
            data-ui="icon-button"
            data-compact
            aria-pressed={expanded}
            aria-label="Show details"
            title="Show details"
            onClick={() => setExpanded((v) => !v)}
          >
            <InfoGlyph />
          </button>
        </div>
      </div>
      <div data-ui="provider-picker-row-stats">
        {insufficientContext ? (
          <span data-tone="danger">insufficient context</span>
        ) : null}
        {pricingLabel ? <span>{pricingLabel}</span> : null}
        {uptimeLabel ? <span>{uptimeLabel}</span> : null}
        {throughputLabel ? <span>{throughputLabel}</span> : null}
        {endpoint.quantization && endpoint.quantization !== 'unknown' ? (
          <span>{endpoint.quantization}</span>
        ) : null}
      </div>
      {expanded ? <ProviderDetails endpoint={endpoint} /> : null}
    </li>
  )
}

function ProviderDetails({ endpoint }: { endpoint: ModelEndpoint }) {
  const rows: Array<[string, string]> = []
  rows.push(['Provider', endpoint.provider_name])
  if (endpoint.status) rows.push(['Status', endpoint.status])
  if (endpoint.context_length) rows.push(['Context', endpoint.context_length.toLocaleString()])
  if (endpoint.max_prompt_tokens)
    rows.push(['Max prompt', endpoint.max_prompt_tokens.toLocaleString()])
  if (endpoint.max_completion_tokens)
    rows.push(['Max completion', endpoint.max_completion_tokens.toLocaleString()])
  const prompt = Number(endpoint.pricing.prompt)
  const completion = Number(endpoint.pricing.completion)
  if (Number.isFinite(prompt)) rows.push(['Input $/M', (prompt * 1_000_000).toFixed(3)])
  if (Number.isFinite(completion)) rows.push(['Output $/M', (completion * 1_000_000).toFixed(3)])
  if (endpoint.quantization && endpoint.quantization !== 'unknown')
    rows.push(['Quantization', endpoint.quantization])
  if (endpoint.uptime_last_30m !== undefined)
    rows.push(['Uptime (30m)', `${endpoint.uptime_last_30m.toFixed(2)}%`])
  const tp = endpoint.throughput_last_30m as
    | { p50?: number; p95?: number; tokensPerSecond?: number }
    | undefined
  const tpP50 =
    typeof tp?.p50 === 'number'
      ? tp.p50
      : typeof tp?.tokensPerSecond === 'number'
        ? tp.tokensPerSecond
        : undefined
  if (tpP50 !== undefined) rows.push(['Throughput p50', `${tpP50.toFixed(0)} tok/s`])
  if (typeof tp?.p95 === 'number') rows.push(['Throughput p95', `${tp.p95.toFixed(0)} tok/s`])
  if (endpoint.latency_last_30m?.p50 !== undefined)
    rows.push(['Latency p50', `${endpoint.latency_last_30m.p50.toFixed(0)}ms`])
  if (endpoint.latency_last_30m?.p95 !== undefined)
    rows.push(['Latency p95', `${endpoint.latency_last_30m.p95.toFixed(0)}ms`])
  if (endpoint.architecture?.tokenizer) rows.push(['Tokenizer', endpoint.architecture.tokenizer])
  if (endpoint.supports_implicit_caching !== undefined) {
    rows.push(['Implicit caching', endpoint.supports_implicit_caching ? 'yes' : 'no'])
  }
  const supported = endpoint.supported_parameters ?? []
  if (supported.length > 0) rows.push(['Parameters', supported.join(', ')])
  return (
    <dl data-ui="provider-picker-details">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function InfoGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="13" height="13">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="8" cy="4.5" r="0.9" fill="currentColor" />
      <path d="M8 6.8v5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

function ReloadIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" width="14" height="14">
      <path
        d="M3 8a5 5 0 0 1 9-3.2M13 8a5 5 0 0 1-9 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M12 2.5V5h-2.5M4 13.5V11h2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

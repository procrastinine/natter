// Provider picker. See `plan/10-ui.md §10.5`, `plan/07-discovery.md §7.2`,
// `plan/09-privacy.md §9.11`.
//
// Rows render in one of three states:
//   - kept: survived the privacy filter and will receive traffic. Padlock
//     tinted by tier (green/yellow/orange/red).
//   - auto-excluded: dropped by hard-deny / Pareto / user-ignore. Row is
//     dimmed, padlock still shows the tier so the user can see what
//     they're excluding. Exclusion reasons render beneath the name.
//   - no-filter: privacy filter doesn't apply (non-OpenRouter connection,
//     or `:free` model). No padlock; plain endpoint list.
//
// Sort dropdown binds to `providerPrefs.sort`. OpenRouter sorts the
// request's allowed providers by this axis — auto-excluded entries don't
// appear on the wire, so sort only reorders providers we actually keep.
// Reset clears both `providerPrefs` (order/ignore/sort) and privacy-side
// manual overrides (only/ignoreProviders) in one operation.

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback, useMemo, useState } from 'react'
import { activePath } from '../../core/active-path'
import { estimatePromptSize, tokenizerFromSettings } from '../../core/prompt-size'
import type {
  Chat,
  ModelEndpoint,
  ProviderPreferences,
  SortBy,
} from '../../core/types'
import { usePrivacyRouting } from '../../hooks/usePrivacyRouting'
import { loadChatMessages, updateChatSettings } from '../../store/chats'
import { getDb } from '../../store/db'
import { useChatStore } from '../../store/zustand/chatStore'
import { LockIcon } from '../icons/Icon'
import {
  buildPickerRows,
  reasonsToTooltip,
  tierToLockLabel,
  type PickerRow,
} from './provider-picker-rows'

export interface ProviderPickerProps {
  chat: Chat
}

const EMPTY_CURSOR = Object.freeze({}) as Readonly<Record<string, string>>

export function ProviderPicker({ chat }: ProviderPickerProps) {
  const routing = usePrivacyRouting(chat)
  const { endpoints, filter, loading, isFreeModel, scrapeApplicable, refresh } = routing
  const prefs = chat.settings.providerPrefs ?? {}
  const manualOrdered = useMemo(() => orderEndpoints(endpoints, prefs), [endpoints, prefs])
  const rows = useMemo(() => buildPickerRows(manualOrdered, filter), [manualOrdered, filter])

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
      // Unified allowed/disallowed model:
      //   - `prefs.ignoreOverridesFilter=true` means "user touched the
      //     picker; trust their `ignore` list verbatim."
      //   - When false/undefined, the wire falls back to the filter's
      //     auto-exclusion.
      // On first click we seed `ignore` from the filter's current
      // excluded set, then mutate it — this way clicking Allow on the
      // only auto-excluded row yields `ignore=[]` but the Override flag
      // still pins us into user-authoritative mode.
      const alreadyTouched = prefs.ignoreOverridesFilter === true
      const base = alreadyTouched
        ? new Set(prefs.ignore)
        : new Set((filter?.excluded ?? []).map((e) => e.endpoint.provider_name))
      if (enabled) base.delete(providerName)
      else base.add(providerName)
      updatePrefs({ ignore: [...base], ignoreOverridesFilter: true })
    },
    [prefs.ignore, prefs.ignoreOverridesFilter, filter, updatePrefs],
  )

  const moveBy = useCallback(
    (providerName: string, delta: 1 | -1) => {
      const current = [...(prefs.order ?? manualOrdered.map((e) => e.provider_name))]
      const idx = current.indexOf(providerName)
      if (idx < 0) current.push(providerName)
      const from = current.indexOf(providerName)
      const to = Math.max(0, Math.min(current.length - 1, from + delta))
      if (from === to) return
      current.splice(from, 1)
      current.splice(to, 0, providerName)
      updatePrefs({ order: current })
    },
    [manualOrdered, prefs.order, updatePrefs],
  )

  const setSort = useCallback(
    (sort: SortBy | 'default') => {
      // 'default' drops the field entirely so OpenRouter picks its own
      // ordering. Other values bind `providerPrefs.sort = scalar`. The
      // `{by, partition}` object form exists on the type but the user
      // asked for a simple three-way toggle — we don't surface partition.
      const next: ProviderPreferences = { ...(chat.settings.providerPrefs ?? {}) }
      if (sort === 'default') delete next.sort
      else next.sort = sort
      void updateChatSettings(chat.id, { providerPrefs: next })
    },
    [chat.id, chat.settings.providerPrefs],
  )

  const resetPrefs = useCallback(() => {
    // Reset clears every override this panel can produce: provider
    // order, manual ignore, the user-touched flag, sort, privacy-side
    // `onlyProviders` / `ignoreProviders`. After reset the picker falls
    // back to the filter's default — kept providers checked,
    // auto-excluded providers unchecked.
    const nextPrivacy = {
      ...chat.settings.privacy,
      onlyProviders: [],
      ignoreProviders: [],
    }
    void updateChatSettings(chat.id, {
      providerPrefs: {}, // clears ignore + ignoreOverridesFilter in one shot
      privacy: nextPrivacy,
    })
  }, [chat.id, chat.settings.privacy])

  if (!chat.settings.model) return null

  const privacyOverrides =
    chat.settings.privacy.onlyProviders.length +
    chat.settings.privacy.ignoreProviders.length
  const hasOverrides =
    prefs.ignoreOverridesFilter === true ||
    (prefs.ignore?.length ?? 0) > 0 ||
    (prefs.order?.length ?? 0) > 0 ||
    prefs.sort !== undefined ||
    privacyOverrides > 0

  const currentSort: SortBy | 'default' =
    typeof prefs.sort === 'string'
      ? prefs.sort
      : typeof prefs.sort === 'object' && prefs.sort !== null
        ? prefs.sort.by
        : 'default'

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
      <div data-ui="provider-picker-controls">
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
              <InfoGlyph />
            </span>
          </span>
        </label>
        <label data-ui="provider-picker-sort">
          <span>Sort</span>
          <select
            value={currentSort}
            onChange={(e) => setSort(e.target.value as SortBy | 'default')}
            aria-label="Provider sort order"
          >
            <option value="default">OpenRouter default</option>
            <option value="price">Lowest price</option>
            <option value="throughput">Highest throughput</option>
            <option value="latency">Lowest latency</option>
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <p data-ui="helper">
          {loading ? 'Loading…' : 'No providers available for this model.'}
        </p>
      ) : (
        <ul data-ui="provider-picker-list">
          {rows.map((row, idx) => {
            const epCap = row.endpoint.max_prompt_tokens ?? row.endpoint.context_length
            const insufficient =
              epCap !== undefined && epCap > 0 && neededTokens > epCap
            // Allowed = ignoreOverridesFilter ? !prefs.ignore : kept.
            // Two different sources of truth depending on whether the user
            // has taken over from the filter. Insufficient-context always
            // forces unchecked regardless.
            const userTouched = prefs.ignoreOverridesFilter === true
            const name = row.endpoint.provider_name
            const allowed = userTouched
              ? !(prefs.ignore ?? []).includes(name)
              : row.state === 'kept'
            return (
              <ProviderRow
                key={`${name}:${idx}`}
                row={row}
                allowed={allowed}
                insufficientContext={insufficient}
                onToggle={(on) => toggleProvider(name, on)}
                onMoveUp={() => moveBy(name, -1)}
                onMoveDown={() => moveBy(name, 1)}
              />
            )
          })}
        </ul>
      )}
      {isFreeModel ? (
        <p data-ui="helper" data-tone="muted">
          Privacy routing is ignored on <code>:free</code> models — OpenRouter picks a free provider.
        </p>
      ) : !scrapeApplicable ? (
        <p data-ui="helper" data-tone="muted">
          Privacy filter does not apply to this connection. Manual overrides still apply.
        </p>
      ) : null}
      <footer data-ui="provider-picker-footer">
        {/*
          Always shown so users can "reset to default" at any time,
          even from a state the picker wouldn't normally flag as
          overridden (e.g. the UX disagrees with what we think of as
          'touched'). When nothing is overridden this is a no-op,
          which is cheap and eliminates the "where's the reset?"
          question the user hit when the flag was gated on hasOverrides.
        */}
        <button
          type="button"
          data-ui="field-inline-action"
          onClick={resetPrefs}
          disabled={!hasOverrides}
          aria-disabled={!hasOverrides}
          title={hasOverrides ? 'Reset to default' : 'No overrides to reset'}
        >
          Reset to default
        </button>
      </footer>
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
  row,
  allowed,
  insufficientContext,
  onToggle,
  onMoveUp,
  onMoveDown,
}: {
  row: PickerRow
  allowed: boolean
  insufficientContext: boolean
  onToggle: (enabled: boolean) => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const { endpoint } = row
  const pricingLabel = useMemo(() => {
    const prompt = Number(endpoint.pricing.prompt)
    const completion = Number(endpoint.pricing.completion)
    if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return ''
    const parts: string[] = []
    if (Number.isFinite(prompt)) parts.push(`$${(prompt * 1_000_000).toFixed(2)}/M in`)
    if (Number.isFinite(completion)) parts.push(`$${(completion * 1_000_000).toFixed(2)}/M out`)
    return parts.join(' · ')
  }, [endpoint.pricing])
  const uptimeLabel =
    endpoint.uptime_last_30m !== undefined
      ? `${endpoint.uptime_last_30m.toFixed(1)}% up`
      : ''
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

  // Lock tooltip carries the privacy story (tier + retention) so the row
  // itself stays a plain name + stats. Exclusion reasons and "No privacy
  // data available" used to render inline — that was clutter; they now
  // only surface on hover of the lock (or in the expanded details).
  const lockTitle = row.state === 'no-filter'
    ? ''
    : [
        tierToLockLabel(row.tier),
        ...(row.state === 'auto-excluded'
          ? [reasonsToTooltip(row.reasons, row.policy)]
          : []),
      ]
        .filter(Boolean)
        .join('\n\n')

  return (
    <li
      data-ui="provider-picker-row"
      data-allowed={allowed ? 'true' : 'false'}
      data-insufficient-context={insufficientContext ? 'true' : undefined}
      data-privacy-tier={row.tier}
    >
      <div data-ui="provider-picker-row-head">
        <label data-ui="provider-picker-toggle">
          <input
            type="checkbox"
            checked={allowed && !insufficientContext}
            disabled={insufficientContext}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Use ${endpoint.provider_name}`}
          />
          {row.state !== 'no-filter' ? (
            <PrivacyLock tier={row.tier} title={lockTitle} />
          ) : null}
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
      {expanded ? <ProviderDetails row={row} /> : null}
    </li>
  )
}

function PrivacyLock({ tier, title }: { tier: string; title: string }) {
  // The padlock is always rendered closed — tier is reflected via the
  // CSS `color` channel driven by `data-privacy-tier`. An open lock would
  // fight the visual hierarchy (user reads "unlocked = no privacy"),
  // whereas tier color is the actual axis.
  return (
    <span
      data-ui="provider-picker-lock"
      data-privacy-tier={tier}
      title={title}
      aria-label={title}
    >
      <LockIcon size={13} />
    </span>
  )
}

function ProviderDetails({ row }: { row: PickerRow }) {
  const { endpoint, policy, policySynthesized } = row
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
  if (Number.isFinite(completion))
    rows.push(['Output $/M', (completion * 1_000_000).toFixed(3)])
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
  if (endpoint.architecture?.tokenizer)
    rows.push(['Tokenizer', endpoint.architecture.tokenizer])
  if (endpoint.supports_implicit_caching !== undefined) {
    rows.push(['Implicit caching', endpoint.supports_implicit_caching ? 'yes' : 'no'])
  }
  const supported = endpoint.supported_parameters ?? []
  if (supported.length > 0) rows.push(['Parameters', supported.join(', ')])
  if (policy && row.state !== 'no-filter') {
    rows.push(['Training', policy.training ? 'yes' : 'no'])
    rows.push([
      'Retention',
      policy.retainsPrompts
        ? policy.retentionDays !== undefined
          ? `${policy.retentionDays} days`
          : 'unknown period'
        : 'none',
    ])
    if (policy.requiresUserIDs) rows.push(['User IDs', 'required'])
    if (policySynthesized) rows.push(['Source', 'worst-case (live data missing)'])
  }
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

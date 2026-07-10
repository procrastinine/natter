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
// Routing-sort control binds to `providerPrefs.sort`. OpenRouter sorts the
// request's allowed providers by this axis — auto-excluded entries don't
// appear on the wire. The visible picker sorts every row by the same metric,
// including blocked rows, so toggling a provider doesn't move it around.
// Bulk select/deselect writes the same manual ignore override as row clicks,
// leaving sort/order intact. Quantization bulk actions are just selection
// filters over that same ignore list, not provider.quantizations writes. Reset
// clears provider order/ignore overrides while restoring the default Price sort.

import { useCallback, useMemo, useState } from 'react'
import { DEFAULT_OPENROUTER_PROVIDER_SORT } from '../../core/provider-defaults'
import {
  endpointMatchesProviderRef,
  providerDisplayLabel,
  providerDisplayName,
  providerEndpointKey,
  providerRoutingRef,
  resolveProviderRefsToRoutingRefs,
} from '../../core/provider-identity'
import type { Chat, ModelEndpoint, ProviderPreferences, SortBy } from '../../core/types'
import type { UsePrivacyRoutingResult } from '../../hooks/usePrivacyRouting'
import { updateChatSettings } from '../../store/chats'
import { LockIcon } from '../icons/Icon'
import { InfoDisclosure } from './InfoDisclosure'
import { PrivacySection } from './PrivacySection'
import {
  buildPickerRows,
  ignoredProviderRefsAfterBulkDeselect,
  isLowQuantization,
  isUnknownQuantization,
  type PickerRow,
  reasonsToTooltip,
  tierToLockLabel,
} from './provider-picker-rows'

interface ProviderPickerProps {
  chat: Chat
  routing: UsePrivacyRoutingResult
  neededTokens: number | null
}

const SORT_OPTIONS: ReadonlyArray<{ value: SortBy; label: string }> = [
  { value: 'price', label: 'Price' },
  { value: 'throughput', label: 'Throughput' },
  { value: 'latency', label: 'Latency' },
]

export function ProviderPicker({
  chat,
  routing,
  neededTokens: neededTokensRaw,
}: ProviderPickerProps) {
  const { endpoints, filter, loading, isFreeModel, scrapeApplicable, liveScrapeEnabled, refresh } =
    routing
  const prefs = chat.settings.providerPrefs ?? {}
  const currentSort: SortBy =
    typeof prefs.sort === 'string'
      ? prefs.sort
      : typeof prefs.sort === 'object' && prefs.sort !== null
        ? prefs.sort.by
        : DEFAULT_OPENROUTER_PROVIDER_SORT
  const manualOrdered = useMemo(() => orderEndpoints(endpoints, prefs), [endpoints, prefs])
  const displayOrdered = useMemo(
    () => sortEndpointsByMetric(manualOrdered, currentSort),
    [manualOrdered, currentSort],
  )
  const rows = useMemo(
    () =>
      loading && scrapeApplicable && !filter
        ? []
        : buildPickerRows(displayOrdered, filter, {
            providerPrefs: prefs,
            privacy: chat.settings.privacy,
          }),
    [displayOrdered, filter, prefs, chat.settings.privacy, loading, scrapeApplicable],
  )
  // Provider filtering ignores unsent draft text; the live composer only
  // tracks characters, while the full token estimate is recomputed on send.
  const neededTokens = neededTokensRaw ?? undefined

  const updatePrefs = useCallback(
    (patch: Partial<ProviderPreferences>) => {
      const next: ProviderPreferences = { ...(chat.settings.providerPrefs ?? {}), ...patch }
      if (patch.ignore !== undefined) delete next.only
      void updateChatSettings(chat.id, { providerPrefs: next })
    },
    [chat.id, chat.settings.providerPrefs],
  )

  const toggleProvider = useCallback(
    (providerRef: string, enabled: boolean) => {
      // Unified allowed/disallowed model:
      //   - `prefs.ignoreOverridesFilter=true` means "user touched the
      //     picker; trust their `ignore` list verbatim."
      //   - When false/undefined, the wire falls back to the filter's
      //     auto-exclusion.
      // On first click `ignore` is seeded from the filter's current
      // excluded set, then mutated, so that clicking Allow on the
      // only auto-excluded row yields `ignore=[]` but the Override flag
      // still pins the chat into user-authoritative mode.
      const alreadyTouched = prefs.ignoreOverridesFilter === true
      const base = alreadyTouched
        ? new Set(
            resolveProviderRefsToRoutingRefs(endpoints, prefs.ignore, { preserveUnknown: true }),
          )
        : new Set((filter?.excluded ?? []).map((e) => providerRoutingRef(e.endpoint)))
      if (enabled) base.delete(providerRef)
      else base.add(providerRef)
      const nextPrefs: ProviderPreferences = {
        ...(chat.settings.providerPrefs ?? {}),
        ignore: [...base],
        ignoreOverridesFilter: true,
      }
      delete nextPrefs.only
      void updateChatSettings(chat.id, { providerPrefs: nextPrefs })
    },
    [
      chat.id,
      chat.settings.providerPrefs,
      endpoints,
      prefs.ignore,
      prefs.ignoreOverridesFilter,
      filter,
    ],
  )

  const moveBy = useCallback(
    (providerRef: string, delta: 1 | -1) => {
      const current =
        prefs.order && prefs.order.length > 0
          ? resolveProviderRefsToRoutingRefs(endpoints, prefs.order, { preserveUnknown: true })
          : manualOrdered.map((e) => providerRoutingRef(e))
      const idx = current.indexOf(providerRef)
      if (idx < 0) current.push(providerRef)
      const from = current.indexOf(providerRef)
      const to = Math.max(0, Math.min(current.length - 1, from + delta))
      if (from === to) return
      current.splice(from, 1)
      current.splice(to, 0, providerRef)
      updatePrefs({ order: current })
    },
    [endpoints, manualOrdered, prefs.order, updatePrefs],
  )

  const setSort = useCallback(
    (sort: SortBy) => {
      const next: ProviderPreferences = { ...(chat.settings.providerPrefs ?? {}) }
      next.sort = sort
      void updateChatSettings(chat.id, { providerPrefs: next })
    },
    [chat.id, chat.settings.providerPrefs],
  )

  const resetPrefs = useCallback(() => {
    // Reset clears every override this panel can produce: provider
    // order, manual ignore, quantization routing, the user-touched flag,
    // strict mode, and non-default sort.
    // After reset the picker falls back to Price + the filter's default — kept providers checked,
    // auto-excluded providers unchecked.
    void updateChatSettings(chat.id, {
      strictProviderRouting: undefined,
      providerPrefs: { sort: DEFAULT_OPENROUTER_PROVIDER_SORT },
    })
  }, [chat.id])

  const setAllProviders = useCallback(
    (enabled: boolean) => {
      const nextPrefs: ProviderPreferences = {
        ...(chat.settings.providerPrefs ?? {}),
        ignore: enabled ? [] : displayOrdered.map((endpoint) => providerRoutingRef(endpoint)),
        ignoreOverridesFilter: true,
      }
      delete nextPrefs.only
      void updateChatSettings(chat.id, { providerPrefs: nextPrefs })
    },
    [chat.id, chat.settings.providerPrefs, displayOrdered],
  )
  const selectedLowQuantizationCount = useMemo(
    () =>
      rows.filter((row) => row.state === 'kept' && isLowQuantization(row.endpoint.quantization))
        .length,
    [rows],
  )
  const selectedUnknownQuantizationCount = useMemo(
    () =>
      rows.filter((row) => row.state === 'kept' && isUnknownQuantization(row.endpoint.quantization))
        .length,
    [rows],
  )
  const deselectProvidersWhere = useCallback(
    (shouldDeselect: (endpoint: ModelEndpoint) => boolean) => {
      const nextPrefs: ProviderPreferences = {
        ...(chat.settings.providerPrefs ?? {}),
        ignore: ignoredProviderRefsAfterBulkDeselect(
          rows,
          endpoints,
          chat.settings.providerPrefs,
          shouldDeselect,
        ),
        ignoreOverridesFilter: true,
      }
      delete nextPrefs.only
      void updateChatSettings(chat.id, { providerPrefs: nextPrefs })
    },
    [chat.id, chat.settings.providerPrefs, endpoints, rows],
  )

  if (!chat.settings.model) return null

  const sortOverridden =
    prefs.sort !== undefined &&
    JSON.stringify(prefs.sort) !== JSON.stringify(DEFAULT_OPENROUTER_PROVIDER_SORT)
  const hasOverrides =
    chat.settings.strictProviderRouting !== undefined ||
    prefs.ignoreOverridesFilter === true ||
    (prefs.ignore?.length ?? 0) > 0 ||
    (prefs.only?.length ?? 0) > 0 ||
    (prefs.order?.length ?? 0) > 0 ||
    (prefs.quantizations?.length ?? 0) > 0 ||
    prefs.requireParameters !== undefined ||
    sortOverridden

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
            <InfoDisclosure title="Only route to providers that support every set parameter. Unchecked: send all parameters; providers ignore unsupported ones." />
          </span>
        </label>
        <fieldset data-ui="provider-picker-sort">
          <legend>Routing sort</legend>
          <div data-ui="provider-picker-sort-toggle">
            {SORT_OPTIONS.map((option) => {
              const selected = currentSort === option.value
              return (
                <label key={option.value} data-active={selected}>
                  <input
                    type="radio"
                    name={`provider-sort-${chat.id}`}
                    value={option.value}
                    checked={selected}
                    onChange={() => setSort(option.value)}
                    onClick={() => {
                      if (selected && prefs.sort === undefined) setSort(option.value)
                    }}
                  />
                  {option.label}
                </label>
              )
            })}
          </div>
        </fieldset>
      </div>
      {rows.length === 0 ? (
        <p data-ui="helper">{loading ? 'Loading…' : 'No providers available for this model.'}</p>
      ) : (
        <ul data-ui="provider-picker-list">
          {rows.map((row) => {
            const epCap = row.endpoint.max_prompt_tokens ?? row.endpoint.context_length
            const insufficient =
              neededTokens !== undefined && epCap !== undefined && epCap > 0 && neededTokens > epCap
            const ref = providerRoutingRef(row.endpoint)
            const key = providerEndpointKey(row.endpoint)
            const label = providerDisplayLabel(row.endpoint, endpoints)
            const allowed = row.state === 'kept'
            return (
              <ProviderRow
                key={`${key}:${ref}`}
                row={row}
                label={label}
                allowed={allowed}
                insufficientContext={insufficient}
                onToggle={(on) => toggleProvider(ref, on)}
                onMoveUp={() => moveBy(ref, -1)}
                onMoveDown={() => moveBy(ref, 1)}
              />
            )
          })}
        </ul>
      )}
      {isFreeModel ? (
        <p data-ui="helper" data-tone="muted">
          Privacy routing is ignored on <code>:free</code> models — OpenRouter picks a free
          provider.
        </p>
      ) : !scrapeApplicable ? (
        <p data-ui="helper" data-tone="muted">
          Privacy filter does not apply to this connection. Manual overrides still apply.
        </p>
      ) : null}
      {scrapeApplicable && !liveScrapeEnabled ? (
        <p data-ui="helper" data-tone="muted">
          Live provider privacy refresh is off. Provider privacy uses cached policy data,
          endpoint-supplied policy data, and curated fallback defaults until a proxy is configured
          in General settings.
        </p>
      ) : null}
      <PrivacySection chat={chat} />
      <footer data-ui="provider-picker-footer">
        <button
          type="button"
          data-ui="field-inline-action"
          onClick={() => setAllProviders(true)}
          disabled={rows.length === 0}
          aria-disabled={rows.length === 0}
          title={rows.length === 0 ? 'No providers to select' : 'Select all providers'}
        >
          Select all
        </button>
        <button
          type="button"
          data-ui="field-inline-action"
          onClick={() => setAllProviders(false)}
          disabled={rows.length === 0}
          aria-disabled={rows.length === 0}
          title={rows.length === 0 ? 'No providers to deselect' : 'Deselect all providers'}
        >
          Deselect all
        </button>
        <button
          type="button"
          data-ui="field-inline-action"
          onClick={() =>
            deselectProvidersWhere((endpoint) => isLowQuantization(endpoint.quantization))
          }
          disabled={selectedLowQuantizationCount === 0}
          aria-disabled={selectedLowQuantizationCount === 0}
          title={
            selectedLowQuantizationCount === 0
              ? 'No selected low-quantization providers'
              : `Deselect ${selectedLowQuantizationCount} selected low-quantization provider${
                  selectedLowQuantizationCount === 1 ? '' : 's'
                }`
          }
        >
          Deselect low quant
        </button>
        <button
          type="button"
          data-ui="field-inline-action"
          onClick={() =>
            deselectProvidersWhere((endpoint) => isUnknownQuantization(endpoint.quantization))
          }
          disabled={selectedUnknownQuantizationCount === 0}
          aria-disabled={selectedUnknownQuantizationCount === 0}
          title={
            selectedUnknownQuantizationCount === 0
              ? 'No selected unknown-quantization providers'
              : `Deselect ${selectedUnknownQuantizationCount} selected unknown-quantization provider${
                  selectedUnknownQuantizationCount === 1 ? '' : 's'
                }`
          }
        >
          Deselect unknown quant
        </button>
        {/*
          Always shown so users can "reset to default" at any time,
          even from a state the picker wouldn't normally flag as
          overridden (e.g. the UX disagrees with the internal definition of
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
  const out: ModelEndpoint[] = []
  const seen = new Set<string>()
  for (const ref of order) {
    for (const ep of endpoints) {
      const key = providerEndpointKey(ep)
      if (seen.has(key)) continue
      if (!endpointMatchesProviderRef(ep, ref, endpoints)) continue
      out.push(ep)
      seen.add(key)
    }
  }
  for (const ep of endpoints) {
    if (!seen.has(providerEndpointKey(ep))) out.push(ep)
  }
  return out
}

function sortEndpointsByMetric(endpoints: readonly ModelEndpoint[], sort: SortBy): ModelEndpoint[] {
  return endpoints
    .map((endpoint, index) => ({ endpoint, index, value: endpointSortValue(endpoint, sort) }))
    .sort((left, right) => {
      if (left.value !== right.value) return left.value - right.value
      return left.index - right.index
    })
    .map((entry) => entry.endpoint)
}

function endpointSortValue(endpoint: ModelEndpoint, sort: SortBy): number {
  switch (sort) {
    case 'price':
      return endpointPrice(endpoint)
    case 'throughput':
      return -endpointThroughput(endpoint)
    case 'latency':
      return endpointLatency(endpoint)
  }
}

function endpointPrice(endpoint: ModelEndpoint): number {
  const prompt = Number(endpoint.pricing.prompt)
  const completion = Number(endpoint.pricing.completion)
  if (Number.isFinite(prompt) && Number.isFinite(completion)) return prompt + completion
  if (Number.isFinite(prompt)) return prompt
  if (Number.isFinite(completion)) return completion
  return Number.POSITIVE_INFINITY
}

function endpointThroughput(endpoint: ModelEndpoint): number {
  const throughput = endpoint.throughput_last_30m as
    | { p50?: number; tokensPerSecond?: number }
    | undefined
  if (typeof throughput?.p50 === 'number') return throughput.p50
  if (typeof throughput?.tokensPerSecond === 'number') return throughput.tokensPerSecond
  return Number.NEGATIVE_INFINITY
}

function endpointLatency(endpoint: ModelEndpoint): number {
  const latency = endpoint.latency_last_30m
  if (typeof latency?.p50 === 'number') return latency.p50
  return Number.POSITIVE_INFINITY
}

function ProviderRow({
  row,
  label,
  allowed,
  insufficientContext,
  onToggle,
  onMoveUp,
  onMoveDown,
}: {
  row: PickerRow
  label: string
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

  // Lock tooltip carries the privacy story (tier + retention) so the row
  // itself stays a plain name + stats. Exclusion reasons and "No privacy
  // data available" used to render inline — that was clutter; they now
  // only surface on hover of the lock (or in the expanded details).
  const lockTitle =
    row.state === 'no-filter'
      ? ''
      : [
          tierToLockLabel(row.tier),
          ...(row.state === 'auto-excluded' ? [reasonsToTooltip(row.reasons, row.policy)] : []),
        ]
          .filter(Boolean)
          .join('\n\n')
  const detailsTitle = providerDetailsTooltip(row)

  return (
    <li
      data-ui="provider-picker-row"
      data-allowed={allowed ? 'true' : 'false'}
      data-insufficient-context={insufficientContext ? 'true' : undefined}
      data-privacy-tier={row.tier}
    >
      <div data-ui="provider-picker-row-head">
        <label data-ui="provider-picker-toggle">
          {/* Insufficient-context is purely presentational: the checkbox
              reflects the user's persisted intent, the row grays out via
              data-insufficient-context, and wire-time send skips these
              endpoints. The user can still toggle (to silence the row or
              to prepare for a shorter chat later) and the greyed-out
              state is never written back to settings. */}
          <input
            type="checkbox"
            checked={allowed}
            onChange={(e) => onToggle(e.target.checked)}
            aria-label={`Use ${label}`}
            {...(insufficientContext
              ? {
                  title:
                    "Checked but greyed out — this provider can't fit the current prompt. Send will skip it until the chat shrinks.",
                }
              : {})}
          />
          {row.state !== 'no-filter' ? <PrivacyLock tier={row.tier} title={lockTitle} /> : null}
          <span data-ui="provider-picker-name" title={label}>
            {label}
          </span>
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
            title={detailsTitle}
            onClick={() => setExpanded((v) => !v)}
          >
            <InfoGlyph />
          </button>
        </div>
      </div>
      <div data-ui="provider-picker-row-stats">
        {insufficientContext ? <span data-tone="danger">insufficient context</span> : null}
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
      role="img"
      aria-label={title}
    >
      <LockIcon size={13} />
    </span>
  )
}

function ProviderDetails({ row }: { row: PickerRow }) {
  const rows = providerDetailRows(row)
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

function providerDetailsTooltip(row: PickerRow): string {
  return providerDetailRows(row)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}

function providerDetailRows(row: PickerRow): Array<[string, string]> {
  const { endpoint, policy, policySynthesized } = row
  const rows: Array<[string, string]> = []
  rows.push(['Provider', providerDisplayName(endpoint)])
  const routingRef = providerRoutingRef(endpoint)
  if (routingRef !== endpoint.provider_name) rows.push(['Routing ref', routingRef])
  if (endpoint.provider_model_id) rows.push(['Provider model', endpoint.provider_model_id])
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
    if (policySynthesized) rows.push(['Source', 'offline fallback (privacy data unavailable)'])
  }
  return rows
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

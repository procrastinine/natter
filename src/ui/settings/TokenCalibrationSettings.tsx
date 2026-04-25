// Global-settings section for token calibration. Shows:
//   1. Mode control — "adaptive" (tier-1 per-chat → tier-2 global → tier-3
//      family anchor), "global-only" (skip per-chat), or "family-defaults-only"
//      (hardcoded anchor regardless of learned calibration).
//   2. Global rollup readout — per-bucket chars/token + sample count,
//      summed across every chat the user has sent.
//   3. Reset action — wipes the global rollup. Per-chat samples are not
//      touched; they'll repopulate the global on next send.
//
// Sample ingestion is unaffected by mode — samples always accumulate.
// The mode only changes which tier the estimator reads from.

import { useLiveQuery } from 'dexie-react-hooks'
import { useCallback } from 'react'
import type { TokenCalibrationMode } from '../../core/global-settings'
import {
  aggregateCalibrationSamples,
  readTokenCalibrationGlobal,
  writeTokenCalibrationGlobal,
} from '../../core/token-calibration'
import type { GlobalTokenCalibration, TokenCalibrationSample } from '../../core/types'

const MODE_OPTIONS: ReadonlyArray<{ value: TokenCalibrationMode; label: string; helper: string }> =
  [
    {
      value: 'adaptive',
      label: 'Adaptive (per-chat → global → family defaults)',
      helper:
        'The estimator first trusts the ratio learned in this chat; if absent, it falls back to the cross-chat global average; if still absent, it uses the built-in family default.',
    },
    {
      value: 'global-only',
      label: 'Global only (skip per-chat learning)',
      helper:
        'Use the cross-chat average even when the current chat has its own samples. Useful when your chat topics vary wildly and per-chat calibration is noisy.',
    },
    {
      value: 'family-defaults-only',
      label: 'Family defaults only',
      helper:
        'Ignore learned ratios entirely. Every estimate uses the hardcoded per-family anchor. Restart from a known baseline.',
    },
  ]

function formatRatio(sample: TokenCalibrationSample): string {
  if (sample.totalTextTokens <= 0) return '—'
  return (sample.totalTextChars / sample.totalTextTokens).toFixed(2)
}

export function TokenCalibrationSettings({
  mode,
  onModeChange,
}: {
  mode: TokenCalibrationMode
  onModeChange: (value: TokenCalibrationMode) => void | Promise<void>
}) {
  const global = useLiveQuery(readTokenCalibrationGlobal, [], null)
  const entries = Object.entries(aggregateCalibrationSamples(global?.byModel)).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const selectedHelper = MODE_OPTIONS.find((o) => o.value === mode)?.helper ?? ''

  const onReset = useCallback(async () => {
    const empty: GlobalTokenCalibration = { version: 1, updatedAt: Date.now(), byModel: {} }
    await writeTokenCalibrationGlobal(empty)
  }, [])

  return (
    <div data-ui="settings-section" data-ui-section="token-calibration">
      <h3>Token calibration</h3>
      <div data-ui="field-group">
        <label htmlFor="token-calibration-mode">Estimation mode</label>
        <select
          id="token-calibration-mode"
          data-ui="token-calibration-mode"
          value={mode}
          onChange={(e) => void onModeChange(e.target.value as TokenCalibrationMode)}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span data-ui="helper">{selectedHelper}</span>
      </div>
      <div data-ui="field-group">
        <span data-ui="field-label">Global calibration buckets</span>
        {entries.length === 0 ? (
          <span data-ui="helper">
            No cross-chat samples yet. The global rollup updates on every successful send.
          </span>
        ) : (
          <dl data-ui="calibration-list">
            {entries.map(([modelId, sample]) => (
              <div key={modelId} data-ui="calibration-row">
                <dt title={modelId}>{modelId}</dt>
                <dd>
                  <span data-ui="calibration-ratio">{formatRatio(sample)} chars/token</span>
                  <span data-ui="calibration-samples">
                    {' · '}
                    {sample.sampleCount.toLocaleString()} sample
                    {sample.sampleCount === 1 ? '' : 's'}
                  </span>
                </dd>
              </div>
            ))}
          </dl>
        )}
        {entries.length > 0 ? (
          <button
            type="button"
            data-ui="field-inline-action"
            data-role="token-calibration-reset"
            onClick={() => void onReset()}
          >
            Reset global calibration
          </button>
        ) : null}
      </div>
    </div>
  )
}

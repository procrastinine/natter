// These tests assume the privacy filter's correctness is covered in
// `privacy-filter.test.ts`; they only verify that the UI-facing mapping
// lines up endpoint ↔ filter-result ↔ row state.

import { describe, expect, it } from 'vitest'
import type { PrivacyFilterResult } from '../../src/core/privacy-filter'
import type { DataPolicy, ModelEndpoint } from '../../src/core/types'
import {
  buildPickerRows,
  ignoredProviderRefsAfterBulkDeselect,
  isLowQuantization,
  isUnknownQuantization,
  pickerRowIsHardDenied,
  reasonLabel,
  reasonsToTooltip,
  tierToLockLabel,
} from '../../src/ui/settings/provider-picker-rows'

function ep(provider_name: string, overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name,
    supported_parameters: ['temperature'],
    context_length: 200_000,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    ...overrides,
  }
}

const POLICY_CLEAN: DataPolicy = {
  training: false,
  trainingOpenRouter: false,
  retainsPrompts: false,
  canPublish: false,
  termsOfServiceURL: '',
  privacyPolicyURL: '',
}

const POLICY_USER_IDS: DataPolicy = {
  ...POLICY_CLEAN,
  requiresUserIDs: true,
}

const POLICY_UNKNOWN_RETENTION: DataPolicy = {
  ...POLICY_CLEAN,
  retainsPrompts: true,
  requiresUserIDs: true,
}

describe('buildPickerRows', () => {
  it('tags every endpoint as no-filter when filter is null', () => {
    const endpoints = [ep('Azure'), ep('OpenAI')]
    const rows = buildPickerRows(endpoints, null)
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.state === 'no-filter')).toBe(true)
    expect(rows.every((r) => r.tier === 'open')).toBe(true)
    expect(rows.every((r) => r.reasons.length === 0)).toBe(true)
  })

  it('maps kept endpoints to state=kept with tier derived from policy', () => {
    const azure = ep('Azure')
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [{ endpoint: azure, policy: POLICY_CLEAN, policySynthesized: false }],
      excluded: [],
      zeroEligible: false,
    }
    const [row] = buildPickerRows([azure], filter)
    expect(row?.state).toBe('kept')
    expect(row?.tier).toBe('green')
    expect(row?.reasons).toEqual([])
    expect(row?.policySynthesized).toBe(false)
  })

  it('maps auto-excluded endpoints with their reasons + dominated tier', () => {
    const openai = ep('OpenAI')
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [],
      excluded: [
        {
          endpoint: openai,
          policy: POLICY_UNKNOWN_RETENTION,
          policySynthesized: false,
          reasons: ['dominated'],
        },
      ],
      zeroEligible: true,
    }
    const [row] = buildPickerRows([openai], filter)
    expect(row?.state).toBe('auto-excluded')
    // Indefinite retention + requiresUserIDs is orange per 2026-04-19 spec.
    expect(row?.tier).toBe('orange')
    expect(row?.reasons).toEqual(['dominated'])
  })

  it('preserves endpoint order from input (picker controls sorting upstream)', () => {
    const a = ep('Alpha')
    const b = ep('Beta')
    const c = ep('Gamma')
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [
        { endpoint: c, policy: POLICY_CLEAN, policySynthesized: false },
        { endpoint: a, policy: POLICY_USER_IDS, policySynthesized: false },
      ],
      excluded: [
        { endpoint: b, policy: POLICY_CLEAN, policySynthesized: false, reasons: ['user-ignored'] },
      ],
      zeroEligible: false,
    }
    const rows = buildPickerRows([a, b, c], filter)
    expect(rows.map((r) => r.endpoint.provider_name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(rows.map((r) => r.state)).toEqual(['kept', 'auto-excluded', 'kept'])
  })

  it('flags synthesized-policy rows red and tags unknown-policy', () => {
    const mystery = ep('NewHost')
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [],
      excluded: [
        {
          endpoint: mystery,
          policy: POLICY_UNKNOWN_RETENTION,
          policySynthesized: true,
          reasons: ['unknown-policy', 'training'],
        },
      ],
      zeroEligible: true,
    }
    const [row] = buildPickerRows([mystery], filter)
    expect(row?.tier).toBe('red')
    expect(row?.policySynthesized).toBe(true)
    expect(row?.reasons).toContain('unknown-policy')
  })

  it('falls back gracefully when an endpoint is missing from both kept + excluded', () => {
    // Shouldn't happen, but the row builder must not crash — it renders
    // the orphan as auto-excluded / unavailable rather than throwing.
    const ghost = ep('GhostHost')
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [],
      excluded: [],
      zeroEligible: false,
    }
    const [row] = buildPickerRows([ghost], filter)
    expect(row?.state).toBe('auto-excluded')
    expect(row?.tier).toBe('unavailable')
    expect(row?.reasons).toEqual(['unknown-policy'])
    expect(row?.policySynthesized).toBe(false)
  })

  it('treats manually re-allowed dominated providers as kept while preserving their lower tier', () => {
    const fastRetain = ep('Fast Retain')
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [],
      excluded: [
        {
          endpoint: fastRetain,
          policy: POLICY_UNKNOWN_RETENTION,
          policySynthesized: false,
          reasons: ['dominated'],
        },
      ],
      zeroEligible: false,
    }
    const [row] = buildPickerRows([fastRetain], filter, {
      providerPrefs: { ignore: [], ignoreOverridesFilter: true },
    })
    expect(row?.state).toBe('kept')
    expect(row?.tier).toBe('orange')
    expect(row?.reasons).toEqual([])
  })

  it('keeps mandatory training denial visible when the picker owns reversible exclusions', () => {
    const trainer = ep('Training Host')
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [],
      excluded: [
        {
          endpoint: trainer,
          policy: { ...POLICY_CLEAN, training: true },
          policySynthesized: false,
          reasons: ['training'],
        },
      ],
      zeroEligible: true,
    }
    const [row] = buildPickerRows([trainer], filter, {
      providerPrefs: { ignore: [], ignoreOverridesFilter: true },
    })
    expect(row?.state).toBe('auto-excluded')
    expect(row?.tier).toBe('red')
    expect(row?.reasons).toEqual(['training'])
    expect(row && pickerRowIsHardDenied(row)).toBe(true)
  })

  it('renders compatibility providerPrefs.only as a visible pinned set', () => {
    const kept = ep('Allowed', { provider_slug: 'allowed' })
    const outside = ep('Outside', { provider_slug: 'outside' })
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [
        { endpoint: kept, policy: POLICY_CLEAN, policySynthesized: false },
        { endpoint: outside, policy: POLICY_CLEAN, policySynthesized: false },
      ],
      excluded: [],
      zeroEligible: false,
    }
    const rows = buildPickerRows([kept, outside], filter, {
      providerPrefs: { only: ['allowed'], ignoreOverridesFilter: true },
    })
    expect(rows.map((r) => [r.endpoint.provider_slug, r.state, r.reasons])).toEqual([
      ['allowed', 'kept', []],
      ['outside', 'auto-excluded', ['not-in-only-list']],
    ])
  })

  it('renders stored providerPrefs.only even before the picker override flag is set', () => {
    const kept = ep('Allowed', { provider_slug: 'allowed' })
    const outside = ep('Outside', { provider_slug: 'outside' })
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [
        { endpoint: kept, policy: POLICY_CLEAN, policySynthesized: false },
        { endpoint: outside, policy: POLICY_CLEAN, policySynthesized: false },
      ],
      excluded: [],
      zeroEligible: false,
    }
    const rows = buildPickerRows([kept, outside], filter, {
      providerPrefs: { only: ['allowed'] },
    })
    expect(rows.map((r) => [r.endpoint.provider_slug, r.state, r.reasons])).toEqual([
      ['allowed', 'kept', []],
      ['outside', 'auto-excluded', ['not-in-only-list']],
    ])
  })

  it('keys rows by endpoint identity, not duplicate display name', () => {
    const anth2 = ep('Anthropic', { provider_slug: 'anthropic/2' })
    const anth = ep('Anthropic', { provider_slug: 'anthropic' })
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [{ endpoint: anth, policy: POLICY_CLEAN, policySynthesized: false }],
      excluded: [
        {
          endpoint: anth2,
          policy: POLICY_UNKNOWN_RETENTION,
          policySynthesized: false,
          reasons: ['user-ignored'],
        },
      ],
      zeroEligible: false,
    }
    const rows = buildPickerRows([anth2, anth], filter)
    expect(rows.map((r) => r.endpoint.provider_slug)).toEqual(['anthropic/2', 'anthropic'])
    expect(rows.map((r) => r.state)).toEqual(['auto-excluded', 'kept'])
  })

  it('uses exact slug refs for manual picker state while preserving legacy display refs', () => {
    const anth2 = ep('Anthropic', { provider_slug: 'anthropic/2' })
    const anth = ep('Anthropic', { provider_slug: 'anthropic' })
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: [
        { endpoint: anth2, policy: POLICY_CLEAN, policySynthesized: false },
        { endpoint: anth, policy: POLICY_CLEAN, policySynthesized: false },
      ],
      excluded: [],
      zeroEligible: false,
    }
    const exact = buildPickerRows([anth2, anth], filter, {
      providerPrefs: { ignore: ['anthropic/2'], ignoreOverridesFilter: true },
    })
    expect(exact.map((r) => r.state)).toEqual(['auto-excluded', 'kept'])

    const exactCollision = buildPickerRows([anth2, anth], filter, {
      providerPrefs: { ignore: ['anthropic'], ignoreOverridesFilter: true },
    })
    expect(exactCollision.map((r) => r.state)).toEqual(['kept', 'auto-excluded'])

    const legacy = buildPickerRows([anth2, anth], filter, {
      providerPrefs: { ignore: ['Anthropic'], ignoreOverridesFilter: true },
    })
    expect(legacy.map((r) => r.state)).toEqual(['auto-excluded', 'auto-excluded'])
  })
})

describe('provider-picker bulk quantization helpers', () => {
  it('classifies low and unknown quantization labels from OpenRouter endpoints', () => {
    expect(isLowQuantization('fp4')).toBe(true)
    expect(isLowQuantization('int4')).toBe(true)
    expect(isLowQuantization('GPTQ-Int4')).toBe(true)
    expect(isLowQuantization('Q4_K_M')).toBe(true)
    expect(isLowQuantization('fp8')).toBe(false)
    expect(isLowQuantization('bf16')).toBe(false)
    expect(isLowQuantization('unknown')).toBe(false)
    expect(isLowQuantization(undefined)).toBe(false)

    expect(isUnknownQuantization('unknown')).toBe(true)
    expect(isUnknownQuantization(undefined)).toBe(true)
    expect(isUnknownQuantization('fp4')).toBe(false)
  })

  it('deselects low quantizations relative to the current selected rows', () => {
    const deepseek = ep('DeepSeek', { provider_slug: 'deepseek', quantization: 'unknown' })
    const streamlake = ep('StreamLake', { provider_slug: 'streamlake/fp8', quantization: 'fp8' })
    const deepinfra = ep('DeepInfra', { provider_slug: 'deepinfra/fp4', quantization: 'fp4' })
    const endpoints = [deepseek, streamlake, deepinfra]
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: endpoints.map((endpoint) => ({
        endpoint,
        policy: POLICY_CLEAN,
        policySynthesized: false,
      })),
      excluded: [],
      zeroEligible: false,
    }
    const providerPrefs = {
      ignore: ['streamlake/fp8', 'missing-provider'],
      ignoreOverridesFilter: true,
    }
    const rows = buildPickerRows(endpoints, filter, { providerPrefs })

    expect(
      ignoredProviderRefsAfterBulkDeselect(rows, endpoints, providerPrefs, (endpoint) =>
        isLowQuantization(endpoint.quantization),
      ),
    ).toEqual(['streamlake/fp8', 'missing-provider', 'deepinfra/fp4'])
  })

  it('deselects unknown quantizations without reselecting existing ignores', () => {
    const deepseek = ep('DeepSeek', { provider_slug: 'deepseek', quantization: 'unknown' })
    const atlas = ep('AtlasCloud', { provider_slug: 'atlas-cloud/fp4', quantization: 'fp4' })
    const endpoints = [deepseek, atlas]
    const filter: PrivacyFilterResult = {
      model: 'test/model',
      kept: endpoints.map((endpoint) => ({
        endpoint,
        policy: POLICY_CLEAN,
        policySynthesized: false,
      })),
      excluded: [],
      zeroEligible: false,
    }
    const providerPrefs = {
      ignore: ['atlas-cloud/fp4'],
      ignoreOverridesFilter: true,
    }
    const rows = buildPickerRows(endpoints, filter, { providerPrefs })

    expect(
      ignoredProviderRefsAfterBulkDeselect(rows, endpoints, providerPrefs, (endpoint) =>
        isUnknownQuantization(endpoint.quantization),
      ),
    ).toEqual(['atlas-cloud/fp4', 'deepseek'])
  })
})

describe('reasonLabel', () => {
  it('covers every ExclusionReason with a non-empty human phrase', () => {
    const reasons = [
      'training',
      'training-openrouter',
      'dominated',
      'unknown-policy',
      'user-ignored',
      'not-in-only-list',
    ] as const
    for (const r of reasons) {
      const s = reasonLabel(r)
      expect(s.length).toBeGreaterThan(0)
      expect(s).not.toContain('_')
    }
  })
})

describe('reasonsToTooltip', () => {
  it('combines reasons + retention detail into multiline tooltip', () => {
    const tip = reasonsToTooltip(['dominated'], POLICY_UNKNOWN_RETENTION)
    const lines = tip.split('\n')
    expect(lines[0]).toBe('A stricter provider exists')
    expect(lines).toContain('Retains prompts for an unknown period')
    expect(lines).toContain('Requires user IDs')
  })

  it('renders a finite retention window', () => {
    const policy: DataPolicy = { ...POLICY_CLEAN, retainsPrompts: true, retentionDays: 30 }
    const tip = reasonsToTooltip(['dominated'], policy)
    expect(tip).toContain('Retains prompts 30d')
  })

  it('handles no policy without crashing', () => {
    expect(reasonsToTooltip(['training'], undefined)).toBe('Trains on prompts')
  })
})

describe('tierToLockLabel', () => {
  it('returns a distinct, non-empty label per tier', () => {
    const tiers = ['green', 'yellow', 'orange', 'red', 'open', 'unavailable'] as const
    const labels = tiers.map(tierToLockLabel)
    expect(new Set(labels).size).toBe(tiers.length)
    for (const l of labels) expect(l.length).toBeGreaterThan(0)
  })
})

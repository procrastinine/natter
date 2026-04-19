// Privacy filter. See `plan/09-privacy.md §9.6 / §9.9` and
// `src/core/privacy-filter.ts`. The rules we test here are the load-bearing
// ones called out in CLAUDE.md "Non-negotiable behaviors #2":
//
//   - Hard-deny (training OR trainingOpenRouter) BEFORE Pareto
//   - Pareto dominance along 4 dimensions
//   - onlyProviders narrows post-deny but BEFORE Pareto
//   - ignoreProviders layers on TOP of Pareto
//   - Preferred ordering is only a tiebreaker (reorders, never excludes)
//   - Missing policy → worst-case, flagged `unknown-policy`

import { describe, expect, it } from 'vitest'
import {
  buildWireProviderPrivacy,
  filterEndpointsByPrivacy,
  privacyTierForPolicy,
} from '../../src/core/privacy-filter'
import { cloneDefaultPrivacyPrefs } from '../../src/core/defaults'
import type { DataPolicy, ModelEndpoint } from '../../src/core/types'

function ep(provider_name: string): ModelEndpoint {
  return {
    provider_name,
    supported_parameters: ['temperature', 'reasoning'],
    context_length: 200_000,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
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

const POLICY_TRAINS: DataPolicy = {
  ...POLICY_CLEAN,
  training: true,
}

const POLICY_UNKNOWN_RETENTION: DataPolicy = {
  ...POLICY_CLEAN,
  retainsPrompts: true,
  requiresUserIDs: true,
}

const POLICY_SHORT_RETENTION: DataPolicy = {
  ...POLICY_CLEAN,
  retainsPrompts: true,
  retentionDays: 30,
  requiresUserIDs: true,
}

const POLICY_AI_STUDIO: DataPolicy = {
  ...POLICY_CLEAN,
  retainsPrompts: true,
  retentionDays: 55,
  requiresUserIDs: false,
}

const POLICY_VERTEX: DataPolicy = {
  ...POLICY_CLEAN,
  requiresUserIDs: true,
}

describe('filterEndpointsByPrivacy — hard deny', () => {
  it('drops training:true providers before Pareto runs', () => {
    const result = filterEndpointsByPrivacy({
      model: 'example/x',
      endpoints: [ep('Azure'), ep('Cerebras')],
      policies: { Azure: POLICY_CLEAN, Cerebras: POLICY_TRAINS },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    expect(result.kept.map((k) => k.endpoint.provider_name)).toEqual(['Azure'])
    const denied = result.excluded.find((e) => e.endpoint.provider_name === 'Cerebras')
    expect(denied?.reasons).toContain('training')
  })

  it('drops trainingOpenRouter:true providers too', () => {
    const policyOrTrain: DataPolicy = { ...POLICY_CLEAN, trainingOpenRouter: true }
    const result = filterEndpointsByPrivacy({
      model: 'example/x',
      endpoints: [ep('Azure'), ep('Rogue')],
      policies: { Azure: POLICY_CLEAN, Rogue: policyOrTrain },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    expect(result.kept.map((k) => k.endpoint.provider_name)).toEqual(['Azure'])
    const denied = result.excluded.find((e) => e.endpoint.provider_name === 'Rogue')
    expect(denied?.reasons).toContain('training-openrouter')
  })

  it('hard-deny runs even when paretoFilter is off', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.paretoFilter = false
    const result = filterEndpointsByPrivacy({
      model: 'example/x',
      endpoints: [ep('Azure'), ep('Cerebras')],
      policies: { Azure: POLICY_CLEAN, Cerebras: POLICY_TRAINS },
      privacy: prefs,
    })
    expect(result.kept.map((k) => k.endpoint.provider_name)).toEqual(['Azure'])
  })
})

describe('filterEndpointsByPrivacy — GPT-5.4 live fixture', () => {
  // Per plan/09 §9.6: Azure clean dominates OpenAI's unknown-retention +
  // requires-user-IDs policy, so the filter should keep only Azure.
  it('Azure survives, OpenAI auto-excluded for GPT-5.4', () => {
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure'), ep('OpenAI')],
      policies: {
        Azure: POLICY_CLEAN,
        OpenAI: POLICY_UNKNOWN_RETENTION,
      },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    expect(result.kept.map((k) => k.endpoint.provider_name)).toEqual(['Azure'])
    const openai = result.excluded.find((e) => e.endpoint.provider_name === 'OpenAI')
    expect(openai?.reasons).toContain('dominated')
  })
})

describe('filterEndpointsByPrivacy — Claude Opus 4.7 fixture', () => {
  it('Bedrock dominates Anthropic direct (30d retention + IDs)', () => {
    const result = filterEndpointsByPrivacy({
      model: 'anthropic/claude-opus-4.7',
      endpoints: [ep('Amazon Bedrock'), ep('Anthropic')],
      policies: {
        'Amazon Bedrock': POLICY_CLEAN,
        Anthropic: POLICY_SHORT_RETENTION,
      },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    expect(result.kept.map((k) => k.endpoint.provider_name)).toEqual(['Amazon Bedrock'])
  })
})

describe('filterEndpointsByPrivacy — Gemini fixture', () => {
  it('AI Studio and Vertex both kept; ordering prefers AI Studio', () => {
    const result = filterEndpointsByPrivacy({
      model: 'google/gemini-3.1-pro',
      endpoints: [ep('Google Vertex'), ep('Google AI Studio')],
      policies: {
        'Google Vertex': POLICY_VERTEX,
        'Google AI Studio': POLICY_AI_STUDIO,
      },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    const kept = result.kept.map((k) => k.endpoint.provider_name).sort()
    expect(kept).toEqual(['Google AI Studio', 'Google Vertex'])
    // Preferred-ordering tiebreaker fires when kept.length > 1.
    expect(result.orderedKeptNames).toEqual(['Google AI Studio', 'Google Vertex'])
  })

  it('usePreferredOrdering=false preserves raw kept order', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.usePreferredOrdering = false
    const result = filterEndpointsByPrivacy({
      model: 'google/gemini-3.1-pro',
      endpoints: [ep('Google Vertex'), ep('Google AI Studio')],
      policies: {
        'Google Vertex': POLICY_VERTEX,
        'Google AI Studio': POLICY_AI_STUDIO,
      },
      privacy: prefs,
    })
    expect(result.orderedKeptNames).toEqual(['Google Vertex', 'Google AI Studio'])
  })
})

describe('filterEndpointsByPrivacy — missing policies synthesize worst-case', () => {
  it('synthesized policy is flagged `unknown-policy` AND hard-denied as training', () => {
    const result = filterEndpointsByPrivacy({
      model: 'example/x',
      endpoints: [ep('Azure'), ep('Completely Novel Provider')],
      policies: { Azure: POLICY_CLEAN },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    expect(result.kept.map((k) => k.endpoint.provider_name)).toEqual(['Azure'])
    const fresh = result.excluded.find(
      (e) => e.endpoint.provider_name === 'Completely Novel Provider',
    )
    expect(fresh?.reasons).toContain('unknown-policy')
    expect(fresh?.reasons).toContain('training')
    expect(fresh?.policySynthesized).toBe(true)
  })

  it('curated fallback fills gaps — scrape missing Google still resolves', () => {
    // Gemini drift fixture: the HTML scrape carries
    // "Google Vertex (Global)" but /endpoints returns "Google". The
    // curated data_policies.json entry for "Google" lets the filter
    // resolve correctly without the scrape.
    const result = filterEndpointsByPrivacy({
      model: 'google/gemini-3.1-pro',
      endpoints: [ep('Google AI Studio'), ep('Google')],
      policies: {}, // empty — simulate scrape miss for both
      privacy: cloneDefaultPrivacyPrefs(),
    })
    // Both resolve via the curated table (AI Studio: 55d/no-IDs;
    // Google: clean-on-retention/requires-IDs). Neither dominates;
    // both kept.
    const kept = result.kept.map((k) => k.endpoint.provider_name).sort()
    expect(kept).toEqual(['Google', 'Google AI Studio'])
    // Neither was flagged synthesized because the curated table
    // covered both.
    for (const k of result.kept) expect(k.policySynthesized).toBe(false)
  })
})

describe('filterEndpointsByPrivacy — manual override layers', () => {
  it('onlyProviders narrows the scoped set before Pareto', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.onlyProviders = ['Azure']
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure'), ep('OpenAI')],
      policies: {
        Azure: POLICY_CLEAN,
        OpenAI: POLICY_UNKNOWN_RETENTION,
      },
      privacy: prefs,
    })
    expect(result.kept.map((k) => k.endpoint.provider_name)).toEqual(['Azure'])
    const openai = result.excluded.find((e) => e.endpoint.provider_name === 'OpenAI')
    expect(openai?.reasons).toContain('not-in-only-list')
  })

  it('ignoreProviders removes a Pareto-survivor', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.ignoreProviders = ['Google AI Studio']
    const result = filterEndpointsByPrivacy({
      model: 'google/gemini-3.1-pro',
      endpoints: [ep('Google Vertex'), ep('Google AI Studio')],
      policies: {
        'Google Vertex': POLICY_VERTEX,
        'Google AI Studio': POLICY_AI_STUDIO,
      },
      privacy: prefs,
    })
    expect(result.kept.map((k) => k.endpoint.provider_name)).toEqual(['Google Vertex'])
    const studio = result.excluded.find(
      (e) => e.endpoint.provider_name === 'Google AI Studio',
    )
    expect(studio?.reasons).toContain('user-ignored')
  })
})

describe('filterEndpointsByPrivacy — zeroEligible signal', () => {
  it('is true when hard-deny and Pareto eliminate every endpoint', () => {
    const result = filterEndpointsByPrivacy({
      model: 'example/x',
      endpoints: [ep('Trainer A'), ep('Trainer B')],
      policies: { 'Trainer A': POLICY_TRAINS, 'Trainer B': POLICY_TRAINS },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    expect(result.kept.length).toBe(0)
    expect(result.zeroEligible).toBe(true)
  })

  it('is false when at least one endpoint survives', () => {
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure'), ep('OpenAI')],
      policies: { Azure: POLICY_CLEAN, OpenAI: POLICY_UNKNOWN_RETENTION },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    expect(result.zeroEligible).toBe(false)
  })

  it('is false on an empty endpoint list (nothing to decide yet)', () => {
    const result = filterEndpointsByPrivacy({
      model: 'example/x',
      endpoints: [],
      policies: {},
      privacy: cloneDefaultPrivacyPrefs(),
    })
    expect(result.zeroEligible).toBe(false)
  })
})

describe('buildWireProviderPrivacy', () => {
  it('builds ignore union with the caller-supplied list', () => {
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure'), ep('OpenAI')],
      policies: { Azure: POLICY_CLEAN, OpenAI: POLICY_UNKNOWN_RETENTION },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    const wire = buildWireProviderPrivacy(result, cloneDefaultPrivacyPrefs(), {
      existingIgnore: ['Legacy Manual Ignore'],
    })
    expect(wire.ignore).toEqual(['Legacy Manual Ignore', 'OpenAI'])
    expect(wire.data_collection).toBe('deny') // DEFAULT_PRIVACY_PREFS.denyDataCollection = true
    expect(wire.zeroEligible).toBe(false)
  })

  it('emits only/order when the filter kept more than one provider', () => {
    const result = filterEndpointsByPrivacy({
      model: 'google/gemini-3.1-pro',
      endpoints: [ep('Google Vertex'), ep('Google AI Studio')],
      policies: {
        'Google Vertex': POLICY_VERTEX,
        'Google AI Studio': POLICY_AI_STUDIO,
      },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    const wire = buildWireProviderPrivacy(result, cloneDefaultPrivacyPrefs())
    expect(wire.order).toEqual(['Google AI Studio', 'Google Vertex'])
  })

  it('echoes the pinned-and-surviving set when onlyProviders is set', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.onlyProviders = ['Azure', 'OpenAI']
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure'), ep('OpenAI')],
      policies: { Azure: POLICY_CLEAN, OpenAI: POLICY_UNKNOWN_RETENTION },
      privacy: prefs,
    })
    const wire = buildWireProviderPrivacy(result, prefs)
    // onlyProviders = [Azure, OpenAI] but Pareto drops OpenAI — only Azure
    // survives, so the wire `only` reflects the post-filter survivors.
    expect(wire.only).toEqual(['Azure'])
  })

  it('omits data_collection when the user turned it off', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.denyDataCollection = false
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure')],
      policies: { Azure: POLICY_CLEAN },
      privacy: prefs,
    })
    const wire = buildWireProviderPrivacy(result, prefs)
    expect(wire.data_collection).toBeUndefined()
  })

  it('adds zdr: true when enabled', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.zdrOnly = true
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure')],
      policies: { Azure: POLICY_CLEAN },
      privacy: prefs,
    })
    const wire = buildWireProviderPrivacy(result, prefs)
    expect(wire.zdr).toBe(true)
  })
})

describe('privacyTierForPolicy', () => {
  it('green for clean (no retention, no user IDs)', () => {
    expect(privacyTierForPolicy(POLICY_CLEAN)).toBe('green')
  })

  it('yellow for finite short retention without user IDs', () => {
    const policy: DataPolicy = { ...POLICY_CLEAN, retainsPrompts: true, retentionDays: 30 }
    expect(privacyTierForPolicy(policy)).toBe('yellow')
  })

  it('orange for finite retention + user IDs', () => {
    expect(privacyTierForPolicy(POLICY_SHORT_RETENTION)).toBe('orange')
  })

  it('orange for retention > 90 days', () => {
    const policy: DataPolicy = {
      ...POLICY_CLEAN,
      retainsPrompts: true,
      retentionDays: 120,
    }
    expect(privacyTierForPolicy(policy)).toBe('orange')
  })

  it('red for unknown retention period', () => {
    expect(privacyTierForPolicy(POLICY_UNKNOWN_RETENTION)).toBe('red')
  })

  it('red when policy data was synthesized', () => {
    expect(privacyTierForPolicy(POLICY_CLEAN, { synthesized: true })).toBe('red')
  })

  it('unavailable when policy is missing and not synthesized (defensive)', () => {
    expect(privacyTierForPolicy(undefined)).toBe('unavailable')
  })
})

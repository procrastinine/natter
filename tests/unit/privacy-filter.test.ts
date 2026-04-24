// Privacy filter. See `plan/09-privacy.md §9.6 / §9.9` and
// `src/core/privacy-filter.ts`. The rules we test here are the load-bearing
// ones called out in CLAUDE.md "Non-negotiable behaviors #2":
//
//   - Hard-deny (training OR trainingOpenRouter) BEFORE Pareto
//   - Pareto dominance along 4 dimensions
//   - onlyProviders narrows post-deny but BEFORE Pareto
//   - ignoreProviders layers on TOP of Pareto
//   - Preferred ordering is only a tiebreaker (reorders, never excludes)
//   - Missing online policy → unavailable/excluded, flagged `unknown-policy`
//   - Explicit offline fallback → synthesized worst-case, flagged `unknown-policy`

import { describe, expect, it } from 'vitest'
import {
  buildWireProviderPrivacy,
  filterEndpointsByPrivacy,
  privacyTierForPolicy,
} from '../../src/core/privacy-filter'
import { cloneDefaultPrivacyPrefs } from '../../src/core/defaults'
import type { DataPolicy, ModelEndpoint } from '../../src/core/types'

function ep(provider_name: string, overrides: Partial<ModelEndpoint> = {}): ModelEndpoint {
  return {
    provider_name,
    supported_parameters: ['temperature', 'reasoning'],
    context_length: 200_000,
    pricing: { prompt: '0.0000025', completion: '0.00001' },
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
  it('AI Studio dominates Vertex (yellow vs orange) — only AI Studio kept', () => {
    // Per user spec 2026-04-19: AI Studio (yellow: 55d retention, no
    // user IDs) is a strictly better tier than Google Vertex (orange:
    // requires user IDs). Pareto drops Vertex by default.
    const result = filterEndpointsByPrivacy({
      model: 'google/gemini-3.1-pro',
      endpoints: [ep('Google Vertex'), ep('Google AI Studio')],
      policies: {
        'Google Vertex': POLICY_VERTEX,
        'Google AI Studio': POLICY_AI_STUDIO,
      },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    const kept = result.kept.map((k) => k.endpoint.provider_name)
    expect(kept).toEqual(['Google AI Studio'])
    const vertex = result.excluded.find((e) => e.endpoint.provider_name === 'Google Vertex')
    expect(vertex?.reasons).toContain('dominated')
  })

  it('with Pareto off, both providers remain kept', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.paretoFilter = false
    const result = filterEndpointsByPrivacy({
      model: 'google/gemini-3.1-pro',
      endpoints: [ep('Google Vertex'), ep('Google AI Studio')],
      policies: {
        'Google Vertex': POLICY_VERTEX,
        'Google AI Studio': POLICY_AI_STUDIO,
      },
      privacy: prefs,
    })
    const kept = result.kept.map((k) => k.endpoint.provider_name).sort()
    expect(kept).toEqual(['Google AI Studio', 'Google Vertex'])
    // Preferred ordering still runs — AI Studio before Vertex.
    expect(result.orderedKeptNames).toEqual(['Google AI Studio', 'Google Vertex'])
  })
})

describe('filterEndpointsByPrivacy — missing policies', () => {
  it('online policy misses are unavailable, not synthesized training policies', () => {
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
    expect(fresh?.reasons).not.toContain('training')
    expect(fresh?.policy).toBeUndefined()
    expect(fresh?.policySynthesized).toBe(false)
  })

  it('explicit offline mode synthesizes worst-case for safety', () => {
    const result = filterEndpointsByPrivacy({
      model: 'example/x',
      endpoints: [ep('Azure'), ep('Completely Novel Provider')],
      policies: { Azure: POLICY_CLEAN },
      privacy: cloneDefaultPrivacyPrefs(),
      missingPolicyMode: 'offline-worst-case',
    })
    const fresh = result.excluded.find(
      (e) => e.endpoint.provider_name === 'Completely Novel Provider',
    )
    expect(fresh?.reasons).toContain('unknown-policy')
    expect(fresh?.reasons).toContain('training')
    expect(fresh?.policySynthesized).toBe(true)
  })

  it('maps numbered scrape labels onto slash-tag endpoint slugs', () => {
    const result = filterEndpointsByPrivacy({
      model: 'anthropic/claude-opus-4.7',
      endpoints: [
        ep('Anthropic', { provider_slug: 'anthropic' }),
        ep('Anthropic', { provider_slug: 'anthropic/2' }),
      ],
      policies: {
        Anthropic: POLICY_UNKNOWN_RETENTION,
        'Anthropic 2': POLICY_UNKNOWN_RETENTION,
      },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    const rows = [...result.kept, ...result.excluded]
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.policySynthesized === false)).toBe(true)
    expect(rows.every((row) => row.policy?.training === false)).toBe(true)
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

  it('ignoreProviders drops a Pareto-survivor (with Pareto off, proves user veto)', () => {
    // With paretoFilter on, AI Studio would already dominate Vertex and
    // Vertex wouldn't be in kept. Turn Pareto off so both survive, then
    // ignoreProviders vetoes AI Studio — leaving Vertex as the sole
    // kept endpoint. Under Pareto-on, see the Gemini fixture test —
    // which asserts AI Studio alone stands.
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.paretoFilter = false
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

  it('matches manual refs by endpoint identity so duplicate display names stay separate', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.paretoFilter = false
    prefs.ignoreProviders = ['anthropic/2']
    const anth2 = ep('Anthropic', { provider_slug: 'anthropic/2' })
    const anth = ep('Anthropic', { provider_slug: 'anthropic' })
    const result = filterEndpointsByPrivacy({
      model: 'anthropic/claude-opus-4.7',
      endpoints: [anth2, anth],
      policies: {
        'anthropic/2': POLICY_CLEAN,
        anthropic: POLICY_CLEAN,
      },
      privacy: prefs,
    })
    expect(result.kept.map((k) => k.endpoint.provider_slug)).toEqual(['anthropic'])
    expect(result.excluded.find((e) => e.endpoint.provider_slug === 'anthropic/2')?.reasons).toContain(
      'user-ignored',
    )
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
  it('emits auto-ignore when the user has not touched the picker', () => {
    // `existingIgnore` empty → wire falls back to the filter's exclusion
    // set. Per the unified allow/disallow model, an empty caller list
    // means "trust the filter."
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure'), ep('OpenAI')],
      policies: { Azure: POLICY_CLEAN, OpenAI: POLICY_UNKNOWN_RETENTION },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    const wire = buildWireProviderPrivacy(result, cloneDefaultPrivacyPrefs(), {})
    expect(wire.ignore).toEqual(['OpenAI'])
    expect(wire.data_collection).toBe('deny')
    expect(wire.zeroEligible).toBe(false)
  })

  it('treats caller-supplied existingIgnore as authoritative when userTouchedPicker=true', () => {
    // `userTouchedPicker: true` signals the picker has the
    // authoritative disallowed list; the wire uses it verbatim without
    // re-layering the filter's auto-exclusion on top. Without the flag,
    // existingIgnore is ignored (the filter's autoIgnore wins).
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure'), ep('OpenAI')],
      policies: { Azure: POLICY_CLEAN, OpenAI: POLICY_UNKNOWN_RETENTION },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    const wire = buildWireProviderPrivacy(result, cloneDefaultPrivacyPrefs(), {
      existingIgnore: ['Legacy Manual Ignore'],
      userTouchedPicker: true,
    })
    expect(wire.ignore).toEqual(['Legacy Manual Ignore'])
    expect(wire.data_collection).toBe('deny')
    expect(wire.zeroEligible).toBe(false)
  })

  it('lets manual provider prefs re-allow hard-denied providers when userTouchedPicker=true', () => {
    const result = filterEndpointsByPrivacy({
      model: 'openai/gpt-5.4',
      endpoints: [ep('Azure'), ep('Training Host')],
      policies: { Azure: POLICY_CLEAN, 'Training Host': POLICY_TRAINS },
      privacy: cloneDefaultPrivacyPrefs(),
    })
    const wire = buildWireProviderPrivacy(result, cloneDefaultPrivacyPrefs(), {
      existingIgnore: [],
      userTouchedPicker: true,
    })
    expect(wire.ignore).toBeUndefined()
    expect(wire.zeroEligible).toBe(false)
  })

  it('emits order when the filter kept more than one provider', () => {
    // Disable Pareto so both Gemini providers survive — otherwise AI
    // Studio dominates Vertex (yellow vs orange) and there's only one.
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.paretoFilter = false
    const result = filterEndpointsByPrivacy({
      model: 'google/gemini-3.1-pro',
      endpoints: [ep('Google Vertex'), ep('Google AI Studio')],
      policies: {
        'Google Vertex': POLICY_VERTEX,
        'Google AI Studio': POLICY_AI_STUDIO,
      },
      privacy: prefs,
    })
    const wire = buildWireProviderPrivacy(result, prefs)
    expect(wire.order).toEqual(['Google AI Studio', 'Google Vertex'])
  })

  it('emits provider slugs for duplicate display-name endpoints', () => {
    const prefs = cloneDefaultPrivacyPrefs()
    prefs.paretoFilter = false
    const result = filterEndpointsByPrivacy({
      model: 'anthropic/claude-opus-4.7',
      endpoints: [
        ep('Anthropic', { provider_slug: 'anthropic/2' }),
        ep('Anthropic', { provider_slug: 'anthropic' }),
      ],
      policies: {
        'anthropic/2': POLICY_CLEAN,
        anthropic: POLICY_CLEAN,
      },
      privacy: prefs,
    })
    const wire = buildWireProviderPrivacy(result, prefs, {
      existingIgnore: ['anthropic/2'],
      existingOrder: ['Anthropic'],
      userTouchedPicker: true,
    })
    expect(wire.ignore).toEqual(['anthropic/2'])
    expect(wire.order).toEqual(['anthropic/2', 'anthropic'])
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

  it('yellow for finite retention without user IDs', () => {
    // Per user spec 2026-04-19: retained for a set period AND no user IDs
    // → yellow. Was tested as orange pre-spec; keep the assertion aligned
    // with the current tier rules.
    const policy: DataPolicy = {
      ...POLICY_CLEAN,
      retainsPrompts: true,
      retentionDays: 120,
    }
    expect(privacyTierForPolicy(policy)).toBe('yellow')
  })

  it('orange for unknown (indefinite) retention period', () => {
    // POLICY_UNKNOWN_RETENTION is retainsPrompts: true + retentionDays
    // undefined + requiresUserIDs: true. Either of the last two alone
    // would be orange; together still orange.
    expect(privacyTierForPolicy(POLICY_UNKNOWN_RETENTION)).toBe('orange')
  })

  it('red for training: true (even if hard-denied pre-render)', () => {
    const policy: DataPolicy = { ...POLICY_CLEAN, training: true }
    expect(privacyTierForPolicy(policy)).toBe('red')
  })

  it('red when policy data was synthesized', () => {
    expect(privacyTierForPolicy(POLICY_CLEAN, { synthesized: true })).toBe('red')
  })

  it('unavailable when policy is missing and not synthesized (defensive)', () => {
    expect(privacyTierForPolicy(undefined)).toBe('unavailable')
  })
})

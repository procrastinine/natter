import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings, resolveDefaultModel } from '../../src/core/defaults'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { runFirstRunSeed } from '../../src/store/first-run-seed'
import { __resetKeyCacheForTests, resolveKey } from '../../src/store/keys'
import { listPresets } from '../../src/store/presets'
import { listProfiles } from '../../src/store/profiles'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('resolveDefaultModel', () => {
  it('prefers the first canonical candidate present in the live list', () => {
    const chosen = resolveDefaultModel([
      { id: 'openai/gpt-5.4' },
      { id: 'anthropic/claude-opus-4.7' },
    ])
    expect(chosen).toBe('anthropic/claude-opus-4.7')
  })

  it('skips a candidate that expires within 60 days', () => {
    const now = Date.parse('2026-04-18T00:00:00Z')
    const within30 = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString()
    const chosen = resolveDefaultModel(
      [{ id: 'anthropic/claude-opus-4.7', expirationDate: within30 }, { id: 'openai/gpt-5.4' }],
      { now },
    )
    expect(chosen).toBe('openai/gpt-5.4')
  })

  it('falls back to the first tool-capable model when no canonical candidate is present', () => {
    const chosen = resolveDefaultModel([
      { id: 'misc/noop' },
      { id: 'misc/toolish', supportedParameters: ['tools'] },
    ])
    expect(chosen).toBe('misc/toolish')
  })

  it('falls back to the first listed model as the final resort', () => {
    const chosen = resolveDefaultModel([{ id: 'misc/only' }])
    expect(chosen).toBe('misc/only')
  })
})

describe('runFirstRunSeed', () => {
  it('creates exactly one key, one profile, and one preset', async () => {
    const result = await runFirstRunSeed({
      apiKey: 'sk-or-v1-realkey-abcdef',
      model: 'anthropic/claude-opus-4.7',
    })
    expect(await getDb().keys.count()).toBe(1)
    expect(await getDb().profiles.count()).toBe(1)
    expect(await getDb().presets.count()).toBe(1)
    expect(result.profile.apiKeyRef).toBe(result.key.id)
    expect(result.preset.connectionProfileId).toBe(result.profile.id)
    expect(result.preset.settings.profileId).toBe(result.profile.id)
    expect(result.preset.settings.model).toBe('anthropic/claude-opus-4.7')
    expect(result.preset.lastUsedAt).toBeDefined()
  })

  it('round-trips the pasted api key through the persisted KeyRecord', async () => {
    const result = await runFirstRunSeed({
      apiKey: 'sk-or-v1-secret-payload',
    })
    const plaintext = await resolveKey(result.key.id)
    expect(plaintext).toBe('sk-or-v1-secret-payload')
  })

  it('uses kind-specific defaults; the seed profile is an OpenRouter-shaped bundle', async () => {
    const result = await runFirstRunSeed({ apiKey: 'sk-or-v1-short' })
    expect(result.profile.kind).toBe('openrouter')
    expect(result.profile.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(result.profile.supportsEndpointsApi).toBe(true)
    expect(result.profile.supportsGenerationApi).toBe(true)
    expect(result.profile.supportsPrivacyScrape).toBe(true)
    expect('usesResponsesApiByDefault' in result.profile).toBe(false)
    expect(result.preset.settings.api).toBe('auto')
    expect(result.preset.settings.responses?.store).toBe(false)
  })

  it('accepts an optional passphrase; the resulting key is passphrase-protected', async () => {
    const result = await runFirstRunSeed({
      apiKey: 'sk-or-v1-pp',
      passphrase: 'correct horse',
      passphraseHint: 'xkcd',
    })
    __resetKeyCacheForTests()
    const plaintext = await resolveKey(result.key.id, { passphrase: 'correct horse' })
    expect(plaintext).toBe('sk-or-v1-pp')
    expect(result.key.passphraseHint).toBe('xkcd')
  })

  it('the seed preset is MRU-eligible via listPresets', async () => {
    const result = await runFirstRunSeed({ apiKey: 'sk-or-v1-mru' })
    const profiles = await listProfiles()
    const presets = await listPresets()
    expect(profiles.map((p) => p.id)).toEqual([result.profile.id])
    expect(presets.map((p) => p.id)).toEqual([result.preset.id])
  })

  it('starts with a cloned settings payload so future mutations do not bleed into the defaults', async () => {
    const result = await runFirstRunSeed({ apiKey: 'sk-or-v1-iso', model: 'm' })
    result.preset.settings.systemPrompt = 'mutated'
    const fresh = cloneDefaultChatSettings()
    expect(fresh.systemPrompt).toBe('')
  })
})

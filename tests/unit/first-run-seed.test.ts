import Dexie from 'dexie'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings, resolveDefaultModel } from '../../src/core/defaults'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { configurationApplication } from '../../src/store/configuration-application'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { __resetKeyCacheForTests, resolveKey } from '../../src/store/keys'
import { createBrowserWorkspaceSuiteOwner } from '../helpers/browser-workspace-suite'

const DB_NAME = 'natter'
const workspaceSuite = createBrowserWorkspaceSuiteOwner()

beforeAll(async () => {
  await resetAll()
  await workspaceSuite.open()
})

async function resetAll() {
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetBrowserRepositoryForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

async function clearFirstConnectionRows() {
  __resetKeyCacheForTests()
  __resetBrowserRepositoryForTests()
  const db = getDb()
  await db.transaction(
    'rw',
    [
      db.keys,
      db.profiles,
      db.presets,
      db.configurationLinks,
      db.configurationProfileCatalogRows,
      db.configurationPresetCatalogRows,
    ],
    async () => {
      await Promise.all([
        db.keys.clear(),
        db.profiles.clear(),
        db.presets.clear(),
        db.configurationLinks.clear(),
        db.configurationProfileCatalogRows.clear(),
        db.configurationPresetCatalogRows.clear(),
      ])
    },
  )
}

beforeEach(clearFirstConnectionRows)

afterAll(async () => {
  await workspaceSuite.dispose()
  await resetAll()
})

describe('resolveDefaultModel', () => {
  it('prefers the first canonical candidate present in the live list', () => {
    expect(
      resolveDefaultModel([{ id: 'openai/gpt-5.6-sol' }, { id: 'anthropic/claude-opus-4.8' }]),
    ).toBe('anthropic/claude-opus-4.8')
  })

  it('skips a candidate that expires within 60 days', () => {
    const now = Date.parse('2026-04-18T00:00:00Z')
    const within30 = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString()
    expect(
      resolveDefaultModel(
        [
          { id: 'anthropic/claude-opus-4.8', expirationDate: within30 },
          { id: 'openai/gpt-5.6-sol' },
        ],
        { now },
      ),
    ).toBe('openai/gpt-5.6-sol')
  })

  it('falls back to the first fresh tool-capable model, then the first listed model', () => {
    expect(
      resolveDefaultModel([
        { id: 'misc/noop' },
        { id: 'misc/toolish', supportedParameters: ['tools'] },
      ]),
    ).toBe('misc/toolish')
    expect(resolveDefaultModel([{ id: 'misc/only' }])).toBe('misc/only')
  })
})

describe('first connection creation', () => {
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
    const profiles = await getDb().profiles.toArray()
    const presets = await getDb().presets.toArray()
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

async function runFirstRunSeed(input: {
  apiKey: string
  model?: string
  passphrase?: string
  passphraseHint?: string
}) {
  const result = await configurationApplication.createConnection({
    name: 'OpenRouter',
    kind: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    plaintextKey: input.apiKey,
    keyName: 'OpenRouter',
    ...(input.passphrase === undefined ? {} : { passphrase: input.passphrase }),
    ...(input.passphraseHint === undefined ? {} : { passphraseHint: input.passphraseHint }),
    initialPresetName: 'OpenRouter default',
    initialPresetModel: input.model ?? '',
  })
  if (result.kind !== 'connection-saved' || !result.key || !result.initialPreset) {
    throw new Error('FirstConnectionAtomicCreateFailed')
  }
  return { key: result.key, profile: result.profile, preset: result.initialPreset }
}

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, KeyId, ProfileId } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { __resetKeyCacheForTests, createKey, getKey } from '../../src/store/keys'
import { putCachedEndpoints, putCachedModels } from '../../src/store/models-cache'
import { createPreset } from '../../src/store/presets'
import { putCachedPrivacyPolicy, putCachedProviders } from '../../src/store/privacy-cache'
import {
  archiveProfile,
  bumpProfileLastUsedAt,
  createProfile,
  deleteProfile,
  duplicateProfile,
  exportProfile,
  getProfile,
  listProfiles,
  ProfileInUseError,
  ProfileMissingError,
  profileDependents,
  unarchiveProfile,
  updateProfile,
} from '../../src/store/profiles'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

async function fakeKeyId(name = 'k'): Promise<KeyId> {
  const rec = await createKey({ name, plaintextKey: 'sk-or-v1-fake' })
  return rec.id
}

async function seedChatWithProfile(profileId: ProfileId): Promise<Chat> {
  const db = await openDb()
  const settings = cloneDefaultChatSettings()
  settings.profileId = profileId
  const chat: Chat = {
    id: newId(),
    title: 'T',
    titleStatus: 'untitled',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    settings,
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
  await db.chats.put(chat)
  return chat
}

beforeEach(async () => {
  await resetAll()
  await openDb()
})

afterEach(async () => {
  await resetAll()
})

describe('createProfile', () => {
  it('fills kind-specific defaults for OpenRouter', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKeyRef: keyId,
    })
    expect(profile.supportsEndpointsApi).toBe(true)
    expect(profile.supportsGenerationApi).toBe(true)
    expect(profile.supportsPrivacyScrape).toBe(true)
    expect('usesResponsesApiByDefault' in profile).toBe(false)
    expect('geminiMode' in profile).toBe(false)
  })

  it('keeps provider transport modes out of connection profiles', async () => {
    const keyId = await fakeKeyId()
    const openai = await createProfile({
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyRef: keyId,
    })
    const azure = await createProfile({
      name: 'Azure',
      kind: 'openai-compatible',
      baseUrl: 'https://my.openai.azure.com/v1',
      apiKeyRef: keyId,
    })
    expect('usesResponsesApiByDefault' in openai).toBe(false)
    expect('responsesDefaults' in openai).toBe(false)
    expect('usesResponsesApiByDefault' in azure).toBe(false)
    expect('responsesDefaults' in azure).toBe(false)
  })

  it('broadcasts profile-mutated', async () => {
    const keyId = await fakeKeyId()
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    unsub()
    expect(seen).toContainEqual({ kind: 'profile-mutated', profileId: profile.id })
  })
})

describe('listProfiles / getProfile', () => {
  it('hides archived profiles unless includeArchived is requested', async () => {
    const keyId = await fakeKeyId()
    const a = await createProfile({
      name: 'A',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const b = await createProfile({
      name: 'B',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    await archiveProfile(b.id)
    const visible = await listProfiles()
    expect(visible.map((p) => p.id)).toEqual([a.id])
    const all = await listProfiles({ includeArchived: true })
    expect(all.map((p) => p.id).sort()).toEqual([a.id, b.id].sort())
  })
})

describe('updateProfile cache invalidation', () => {
  it('drops /models /endpoints /privacyPolicies /providers caches when baseUrl changes', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://old',
      apiKeyRef: keyId,
    })
    await putCachedModels(profile.id, { supportedParameters: ['tools'] }, { m: 1 }, 100)
    await putCachedEndpoints(profile.id, 'anthropic/claude-opus-4.7', { e: 1 }, 100)
    await putCachedPrivacyPolicy(profile.id, 'anthropic/claude-opus-4.7', { p: 1 }, 100)
    await putCachedProviders(profile.id, { directory: true }, 100)

    await updateProfile(profile.id, { baseUrl: 'https://new' })

    const db = getDb()
    expect(await db.models.count()).toBe(0)
    expect(await db.endpoints.count()).toBe(0)
    expect(await db.privacyPolicies.count()).toBe(0)
    expect(await db.providers.count()).toBe(0)
  })

  it('does NOT drop caches when baseUrl is unchanged', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://same',
      apiKeyRef: keyId,
    })
    await putCachedModels(profile.id, { supportedParameters: ['tools'] }, { m: 1 }, 100)
    await updateProfile(profile.id, { name: 'Renamed' })
    const db = getDb()
    expect(await db.models.count()).toBe(1)
  })
})

describe('duplicateProfile', () => {
  it('clones with a new id, suffixed name, and shared apiKeyRef', async () => {
    const keyId = await fakeKeyId()
    const source = await createProfile({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const copy = await duplicateProfile(source.id)
    expect(copy.id).not.toBe(source.id)
    expect(copy.name).toBe('OpenRouter (copy)')
    expect(copy.apiKeyRef).toBe(source.apiKeyRef)
  })
})

describe('deleteProfile blocking', () => {
  it('blocks when a non-archived preset references the profile', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    await createPreset({
      name: 'P-preset',
      connectionProfileId: profile.id,
      settings,
    })
    await expect(deleteProfile(profile.id)).rejects.toBeInstanceOf(ProfileInUseError)
    // Profile and key still present.
    expect(await getProfile(profile.id)).toBeDefined()
    expect(await getKey(keyId)).toBeDefined()
  })

  it('blocks when a non-archived chat references the profile via settings.profileId', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    await seedChatWithProfile(profile.id)
    await expect(deleteProfile(profile.id)).rejects.toBeInstanceOf(ProfileInUseError)
  })

  it('force-deletes despite dependents; referenced chats/presets enter "connection missing" state', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const chat = await seedChatWithProfile(profile.id)
    await deleteProfile(profile.id, { force: true })
    expect(await getProfile(profile.id)).toBeUndefined()
    // Chat is still present; its settings.profileId points at the missing
    // connection so send paths must surface the reconnect prompt.
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.settings.profileId).toBe(profile.id)
    // Key got reaped (no remaining profile references it).
    expect(await getKey(keyId)).toBeUndefined()
  })

  it('reassigns dependents to another profile when reassignTo is provided', async () => {
    const keyId = await fakeKeyId()
    const a = await createProfile({
      name: 'A',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const b = await createProfile({
      name: 'B',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = a.id
    const preset = await createPreset({
      name: 'P',
      connectionProfileId: a.id,
      settings,
    })
    const chat = await seedChatWithProfile(a.id)

    await deleteProfile(a.id, { reassignTo: b.id })
    const db = getDb()
    const nextPreset = await db.presets.get(preset.id)
    expect(nextPreset?.connectionProfileId).toBe(b.id)
    expect(nextPreset?.settings.profileId).toBe(b.id)
    const nextChat = await db.chats.get(chat.id)
    expect(nextChat?.settings.profileId).toBe(b.id)
  })

  it('keeps the shared key when a sibling profile still references it', async () => {
    const keyId = await fakeKeyId()
    const a = await createProfile({
      name: 'A',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    await createProfile({
      name: 'B',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    await deleteProfile(a.id)
    expect(await getKey(keyId)).toBeDefined()
  })

  it('throws ProfileMissingError when deleting a ghost id', async () => {
    await expect(deleteProfile('ghost')).rejects.toBeInstanceOf(ProfileMissingError)
  })
})

describe('profileDependents', () => {
  it('ignores archived presets and archived chats', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const preset = await createPreset({
      name: 'P-preset',
      connectionProfileId: profile.id,
      settings,
    })
    const stored = await getDb().presets.get(preset.id)
    if (stored) await getDb().presets.put({ ...stored, archived: true })
    const chat = await seedChatWithProfile(profile.id)
    await getDb().chats.put({ ...chat, archived: true })
    const deps = await profileDependents(profile.id)
    expect(deps.presetIds).toEqual([])
    expect(deps.chatIds).toEqual([])
  })
})

describe('archive / unarchive / bumpProfileLastUsedAt', () => {
  it('round-trips archive state without touching other fields', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    await archiveProfile(profile.id)
    expect((await getProfile(profile.id))?.archived).toBe(true)
    await unarchiveProfile(profile.id)
    expect((await getProfile(profile.id))?.archived).toBe(false)
  })

  it('bumpProfileLastUsedAt updates lastUsedAt without firing a broadcast', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    await bumpProfileLastUsedAt(profile.id, 5000)
    unsub()
    expect((await getProfile(profile.id))?.lastUsedAt).toBe(5000)
    expect(seen.filter((ev) => ev.kind === 'profile-mutated')).toEqual([])
  })
})

describe('exportProfile', () => {
  it('omits apiKeyRef / apiKeyFallbackRefs / managementApiKeyRef', async () => {
    const keyId = await fakeKeyId()
    const fallbackId = await fakeKeyId('fallback')
    const mgmtId = await fakeKeyId('mgmt')
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
      apiKeyFallbackRefs: [fallbackId],
      managementApiKeyRef: mgmtId,
    })
    const exported = await exportProfile(profile.id)
    expect(exported.schemaVersion).toBe(1)
    const body = JSON.stringify(exported)
    expect(body.includes(keyId)).toBe(false)
    expect(body.includes(fallbackId)).toBe(false)
    expect(body.includes(mgmtId)).toBe(false)
    expect((exported.profile as { baseUrl: string }).baseUrl).toBe('https://x')
  })
})

import Dexie from 'dexie'
import { ownBrowserWorkspaceSuite } from '../helpers/browser-workspace-suite'
import { createChat } from '../helpers/chats'
import {
  putCachedEndpoints,
  putCachedModels,
  putCachedPrivacyPolicy,
} from '../helpers/discovery-cache'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ConnectionProfile, KeyId, ProfileId } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import { archiveChat } from '../../src/store/chats'
import { configurationApplication } from '../../src/store/configuration-application'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import { interchangeApplication } from '../../src/store/interchange-application'
import { __resetKeyCacheForTests, createKey, getKey } from '../../src/store/keys'

import type { WorkspaceChange, WorkspaceDependency } from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'
import {
  createConfigurationChatPreset,
  createConfigurationProfile,
  getConfigurationProfile,
  listConfigurationProfiles,
} from '../helpers/configuration'

const DB_NAME = 'natter'
const workspaceSuite = ownBrowserWorkspaceSuite()

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

const createProfile = createConfigurationProfile
const getProfile = getConfigurationProfile

function listProfiles(options: { includeArchived?: boolean } = {}) {
  return listConfigurationProfiles(options.includeArchived === true)
}

async function updateProfile(
  profileId: ProfileId,
  patch: Partial<Omit<ConnectionProfile, 'id' | 'createdAt' | 'requestRevision'>>,
) {
  const result = await configurationApplication.execute({
    kind: 'connection.edit',
    profileId,
    patch,
    now: Date.now(),
  })
  if (result.kind !== 'connection-saved') throw new Error(`ProfileUpdateFailed:${profileId}`)
  return result.profile
}

async function duplicateProfile(profileId: ProfileId) {
  const result = await configurationApplication.duplicateConnection(profileId)
  if (result.kind !== 'connection-saved') throw new Error(`ProfileDuplicateFailed:${profileId}`)
  return result.profile
}

function deleteProfile(
  profileId: ProfileId,
  options: { reassignTo?: ProfileId; now?: number } = {},
) {
  return configurationApplication.deleteConnection(profileId, {
    ...(options.reassignTo === undefined ? {} : { reassignTo: options.reassignTo }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}

const archiveProfile = (profileId: ProfileId) =>
  configurationApplication.archiveConnection(profileId)
const unarchiveProfile = (profileId: ProfileId) =>
  configurationApplication.unarchiveConnection(profileId)
const bumpProfileLastUsedAt = (profileId: ProfileId, now: number) =>
  configurationApplication.execute({ kind: 'connection.touch', profileId, now })

async function fakeKeyId(name = 'k'): Promise<KeyId> {
  const rec = await createKey({ name, plaintextKey: 'sk-or-v1-fake' })
  return rec.id
}

async function seedChatWithProfile(profileId: ProfileId): Promise<Chat> {
  const settings = cloneDefaultChatSettings()
  settings.profileId = profileId
  return createChat({ id: newId(), title: 'T', settings, now: 1 })
}

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await workspaceSuite.open()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetKeyCacheForTests()
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
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

  it('publishes a scoped profile invalidation', async () => {
    const keyId = await fakeKeyId()
    const seen: WorkspaceChange[] = []
    const unsub = subscribeWorkspaceChanges((change) => seen.push(change))
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    unsub()
    const dependency = changedDependencies(seen).find(
      (candidate) =>
        candidate.kind === 'profile' && candidate.profileIds?.includes(profile.id) === true,
    )
    expect(dependency?.kind).toBe('profile')
    if (dependency?.kind !== 'profile') throw new Error('ProfileDependencyMissing')
    expect(dependency.facets).toEqual(
      expect.arrayContaining([
        'request-material',
        'selected-detail',
        'catalog-membership',
        'catalog-order',
        'catalog-display',
        'profile-count',
        'usage',
      ]),
    )
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
  it('drops models, endpoints, and privacy caches when baseUrl changes', async () => {
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

    await updateProfile(profile.id, { baseUrl: 'https://new' })

    const db = getDb()
    expect(await db.models.count()).toBe(0)
    expect(await db.endpoints.count()).toBe(0)
    expect(await db.privacyPolicies.count()).toBe(0)
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

  it('derives kind defaults from the locked current profile when baseUrl is omitted', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'Custom endpoint',
      kind: 'custom',
      baseUrl: 'https://existing.example/v1',
      apiKeyRef: keyId,
    })

    const updated = await updateProfile(profile.id, { kind: 'openrouter' })

    expect(updated.baseUrl).toBe('https://existing.example/v1')
    expect(updated.supportsEndpointsApi).toBe(true)
    expect(updated.supportsGenerationApi).toBe(true)
    expect(updated.supportsPrivacyScrape).toBe(true)
  })

  it('rolls back the profile and caches when invalidation fails', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://old',
      apiKeyRef: keyId,
    })
    await putCachedModels(profile.id, { supportedParameters: ['tools'] }, { m: 1 }, 100)
    const seen: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => seen.push(change))
    const failDelete = () => {
      throw new Error('injected cache failure')
    }
    getDb().models.hook.deleting.subscribe(failDelete)

    await expect(updateProfile(profile.id, { baseUrl: 'https://new' })).rejects.toThrow(
      'injected cache failure',
    )

    getDb().models.hook.deleting.unsubscribe(failDelete)
    unsubscribe()
    expect(await getProfile(profile.id)).toEqual(profile)
    expect(await getDb().models.count()).toBe(1)
    expect(seen).toEqual([])
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
  it('blocks when a preset references the profile', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    await createConfigurationChatPreset({
      name: 'P-preset',
      connectionProfileId: profile.id,
      settings,
    })
    await expect(deleteProfile(profile.id)).resolves.toMatchObject({
      kind: 'connection-delete-blocked',
      profileId: profile.id,
      presetCount: 1,
      chatCount: 0,
    })
    // Profile and key still present.
    expect(await getProfile(profile.id)).toBeDefined()
    expect(await getKey(keyId)).toBeDefined()
  })

  it('blocks when a chat references the profile via settings.profileId', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    await seedChatWithProfile(profile.id)
    await expect(deleteProfile(profile.id)).resolves.toMatchObject({
      kind: 'connection-delete-blocked',
      profileId: profile.id,
      presetCount: 0,
      chatCount: 1,
    })
  })

  it('requires explicit reassignment instead of leaving dependent chats orphaned', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const chat = await seedChatWithProfile(profile.id)
    const seen: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => seen.push(change))
    const result = await deleteProfile(profile.id)
    unsubscribe()
    expect(result).toEqual({
      kind: 'connection-delete-blocked',
      profileId: profile.id,
      presetCount: 0,
      chatCount: 1,
    })
    expect(await getProfile(profile.id)).toBeDefined()
    const stored = await getDb().chats.get(chat.id)
    expect(stored?.settings.profileId).toBe(profile.id)
    expect(await getKey(keyId)).toBeDefined()
    expect(seen).toEqual([])
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
    const preset = await createConfigurationChatPreset({
      name: 'P',
      connectionProfileId: a.id,
      settings,
    })
    const chat = await seedChatWithProfile(a.id)

    await deleteProfile(a.id, { reassignTo: b.id, now: 500 })
    const db = getDb()
    const nextPreset = await db.presets.get(preset.id)
    expect(nextPreset?.connectionProfileId).toBe(b.id)
    expect(nextPreset?.settings.profileId).toBe(b.id)
    const nextChat = await db.chats.get(chat.id)
    expect(nextChat?.settings.profileId).toBe(b.id)
    expect(nextChat).toMatchObject({ metaVersion: 1, summaryVersion: 1, updatedAt: 500 })
  })

  it('rolls back dependent rewrites, deletion, caches, key cleanup, and events on failure', async () => {
    const keyId = await fakeKeyId()
    const replacementKeyId = await fakeKeyId('replacement')
    const source = await createProfile({
      name: 'source',
      kind: 'openrouter',
      baseUrl: 'https://source',
      apiKeyRef: keyId,
    })
    const replacement = await createProfile({
      name: 'replacement',
      kind: 'openrouter',
      baseUrl: 'https://replacement',
      apiKeyRef: replacementKeyId,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = source.id
    const preset = await createConfigurationChatPreset({
      name: 'source preset',
      connectionProfileId: source.id,
      settings,
    })
    const first = await seedChatWithProfile(source.id)
    const second = await seedChatWithProfile(source.id)
    await putCachedModels(source.id, {}, { cached: true }, 1)
    const beforeChats = await getDb().chats.bulkGet([first.id, second.id])
    const beforePreset = await getDb().presets.get(preset.id)
    const seen: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => seen.push(change))
    let updates = 0
    const failSecondUpdate = () => {
      updates += 1
      if (updates === 2) throw new Error('injected profile cascade failure')
    }
    getDb().chats.hook.updating.subscribe(failSecondUpdate)

    await expect(
      deleteProfile(source.id, { reassignTo: replacement.id, now: 500 }),
    ).rejects.toThrow('injected profile cascade failure')

    getDb().chats.hook.updating.unsubscribe(failSecondUpdate)
    unsubscribe()
    expect(await getDb().chats.bulkGet([first.id, second.id])).toEqual(beforeChats)
    expect(await getDb().presets.get(preset.id)).toEqual(beforePreset)
    expect(await getProfile(source.id)).toEqual(source)
    expect(await getKey(keyId)).toBeDefined()
    expect(await getDb().models.where('profileId').equals(source.id).count()).toBe(1)
    expect(seen).toEqual([])
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

  it("keeps primary and fallback keys referenced through another profile's fallback and management slots", async () => {
    const primaryId = await fakeKeyId('primary')
    const fallbackId = await fakeKeyId('fallback')
    const managementId = await fakeKeyId('management')
    const source = await createProfile({
      name: 'source',
      kind: 'openrouter',
      baseUrl: 'https://source',
      apiKeyRef: primaryId,
      apiKeyFallbackRefs: [fallbackId],
      managementApiKeyRef: managementId,
    })
    const siblingKeyId = await fakeKeyId('sibling')
    await createProfile({
      name: 'sibling',
      kind: 'openrouter',
      baseUrl: 'https://sibling',
      apiKeyRef: siblingKeyId,
      apiKeyFallbackRefs: [primaryId],
      managementApiKeyRef: fallbackId,
    })

    await deleteProfile(source.id)

    expect(await getKey(primaryId)).toBeDefined()
    expect(await getKey(fallbackId)).toBeDefined()
    expect(await getKey(managementId)).toBeUndefined()
    expect(await getKey(siblingKeyId)).toBeDefined()
  })

  it('keeps a management key referenced by another profile and reaps every unshared source key', async () => {
    const primaryId = await fakeKeyId('primary')
    const fallbackId = await fakeKeyId('fallback')
    const managementId = await fakeKeyId('management')
    const source = await createProfile({
      name: 'source',
      kind: 'openrouter',
      baseUrl: 'https://source',
      apiKeyRef: primaryId,
      apiKeyFallbackRefs: [fallbackId],
      managementApiKeyRef: managementId,
    })
    await createProfile({
      name: 'sibling',
      kind: 'openrouter',
      baseUrl: 'https://sibling',
      apiKeyRef: managementId,
    })

    await deleteProfile(source.id)

    expect(await getKey(primaryId)).toBeUndefined()
    expect(await getKey(fallbackId)).toBeUndefined()
    expect(await getKey(managementId)).toBeDefined()
  })

  it('throws the application missing result when deleting a ghost id', async () => {
    await expect(deleteProfile('ghost')).rejects.toThrow('ConfigurationMissing:profile:ghost')
  })
})

describe('profileDependents', () => {
  it('includes archived dependents so ordinary deletion cannot create orphan references', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const preset = await createConfigurationChatPreset({
      name: 'P-preset',
      connectionProfileId: profile.id,
      settings,
    })
    await configurationApplication.archiveChatPreset(preset.id, 10)
    const chat = await seedChatWithProfile(profile.id)
    await archiveChat(chat.id, 10)
    const managerPage = await runWorkspaceRead('repository-query', (permit) =>
      getWorkspaceRepository()
        .query(permit, {
          kind: 'configuration.connection-manager-page',
          request: {
            direction: 'forward',
            limit: 1,
            addressedIds: [profile.id],
          },
        })
        .then((envelope) => envelope.value),
    )
    const managerRow = managerPage.addressedRows[0]?.row
    expect(managerRow).toMatchObject({
      id: profile.id,
      presetCount: 1,
      activePresetCount: 0,
      chatCount: 1,
      activeChatCount: 0,
    })
    await expect(deleteProfile(profile.id)).resolves.toMatchObject({
      kind: 'connection-delete-blocked',
      profileId: profile.id,
      presetCount: 1,
      chatCount: 1,
    })
  })
})

describe('connection manager projection', () => {
  it('reads compact rows and indexed dependency links without hydrating full configuration rows', async () => {
    const profile = await createProfile({
      name: 'Compact',
      kind: 'openrouter',
      baseUrl: 'https://x',
    })
    const settings = cloneDefaultChatSettings()
    settings.profileId = profile.id
    const preset = await createConfigurationChatPreset({
      name: 'Archived preset',
      connectionProfileId: profile.id,
      settings,
    })
    await configurationApplication.archiveChatPreset(preset.id, 10)
    await seedChatWithProfile(profile.id)

    const poison = () => {
      throw new Error('FullConfigurationRowHydrated')
    }
    getDb().profiles.hook.reading.subscribe(poison)
    getDb().presets.hook.reading.subscribe(poison)
    getDb().chats.hook.reading.subscribe(poison)
    try {
      const projection = await runWorkspaceRead('repository-query', (permit) =>
        getWorkspaceRepository()
          .query(permit, {
            kind: 'configuration.connection-manager-page',
            request: { direction: 'forward', limit: 256 },
          })
          .then((envelope) => envelope.value),
      )
      if (projection.kind !== 'page') {
        throw new Error(`ConnectionManagerProjectionFailed:${projection.kind}`)
      }
      expect(projection.rows).toEqual([
        expect.objectContaining({
          id: profile.id,
          presetCount: 1,
          activePresetCount: 0,
          chatCount: 1,
          activeChatCount: 1,
        }),
      ])
    } finally {
      getDb().profiles.hook.reading.unsubscribe(poison)
      getDb().presets.hook.reading.unsubscribe(poison)
      getDb().chats.hook.reading.unsubscribe(poison)
    }
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

  it('bumpProfileLastUsedAt publishes profile metadata without invalidating discovery', async () => {
    const keyId = await fakeKeyId()
    const profile = await createProfile({
      name: 'P',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
    })
    const seen: WorkspaceChange[] = []
    const unsub = subscribeWorkspaceChanges((change) => seen.push(change))
    await bumpProfileLastUsedAt(profile.id, 5000)
    unsub()
    expect((await getProfile(profile.id))?.lastUsedAt).toBe(5000)
    const dependencies = changedDependencies(seen)
    expect(dependencies).toContainEqual({
      kind: 'profile',
      profileIds: [profile.id],
      facets: ['usage'],
    })
    expect(dependencies.some((dependency) => dependency.kind === 'discovery-cache')).toBe(false)
  })
})

describe('connection interchange', () => {
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
    const exported = await interchangeApplication.exportConnectionProfile(profile.id)
    expect(exported.objectKind).toBe('connection-profile')
    const body = JSON.stringify(exported)
    expect(body.includes(keyId)).toBe(false)
    expect(body.includes(fallbackId)).toBe(false)
    expect(body.includes(mgmtId)).toBe(false)
    expect(exported.payload.baseUrl).toBe('https://x')
  })

  it('imports a new credential-free connection with a unique name', async () => {
    const keyId = await fakeKeyId()
    const source = await createProfile({
      name: 'Portable',
      kind: 'openrouter',
      baseUrl: 'https://x',
      apiKeyRef: keyId,
      defaultHeaders: {
        Authorization: 'Bearer private',
        'X-OpenRouter-Title': 'Natter',
      },
    })
    const envelope = await interchangeApplication.exportConnectionProfile(source.id)
    expect(envelope.payload.defaultHeaders).toEqual({ 'X-OpenRouter-Title': 'Natter' })

    const imported = await interchangeApplication.importConnectionProfile(
      {
        ...envelope,
        payload: {
          ...envelope.payload,
          defaultHeaders: {
            ...envelope.payload.defaultHeaders,
            Authorization: 'Bearer forged',
          },
        },
      },
      { now: 700 },
    )
    const profile = await getProfile(imported.profileId)
    expect(profile).toMatchObject({
      name: 'Portable (2)',
      baseUrl: 'https://x',
      defaultHeaders: { 'X-OpenRouter-Title': 'Natter' },
      createdAt: 700,
      updatedAt: 700,
    })
    expect(profile?.apiKeyRef).toBeUndefined()
    expect(profile?.apiKeyFallbackRefs).toBeUndefined()
    expect(profile?.managementApiKeyRef).toBeUndefined()
  })
})

function changedDependencies(changes: readonly WorkspaceChange[]): WorkspaceDependency[] {
  return changes.flatMap((change) => {
    if (change.kind === 'replace') return [{ kind: 'workspace' } satisfies WorkspaceDependency]
    if (change.kind === 'invalidate') {
      return change.dependencies === 'all'
        ? [{ kind: 'workspace' } satisfies WorkspaceDependency]
        : [...change.dependencies]
    }
    return [...change.delta.invalidations]
  })
}

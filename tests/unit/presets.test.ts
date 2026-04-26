import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatSettings, PresetId, ProfileId } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import {
  archivePreset,
  bumpPresetLastUsedAt,
  createPreset,
  deletePreset,
  duplicatePreset,
  exportPreset,
  getPreset,
  listPresets,
  pickMruPresetForProfile,
  pickPreferredPreset,
  PresetMissingError,
  pickMruPreset,
  unarchivePreset,
  updatePreset,
} from '../../src/store/presets'
import { createProfile, ProfileMissingError } from '../../src/store/profiles'

const DB_NAME = 'natter'

async function resetAll() {
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

async function fakeProfileId(name = 'P'): Promise<ProfileId> {
  const key = await createKey({ name, plaintextKey: 'sk-x' })
  const profile = await createProfile({
    name,
    kind: 'openrouter',
    baseUrl: 'https://x',
    apiKeyRef: key.id,
  })
  return profile.id
}

function settingsFor(profileId: ProfileId): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.profileId = profileId
  s.model = 'anthropic/claude-opus-4.7'
  return s
}

async function seedChatReferencingPreset(profileId: ProfileId, presetId: PresetId): Promise<Chat> {
  const db = await openDb()
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
    settings: settingsFor(profileId),
    presetId,
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

describe('createPreset', () => {
  it('pins settings.profileId to connectionProfileId and broadcasts preset-mutated', async () => {
    const profileId = await fakeProfileId()
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    const s = cloneDefaultChatSettings()
    // Intentionally wrong to verify the helper aligns it.
    s.profileId = 'stale'
    const preset = await createPreset({
      name: 'OpenRouter default',
      connectionProfileId: profileId,
      settings: s,
    })
    unsub()
    expect(preset.settings.profileId).toBe(profileId)
    expect(preset.settings.providerPrefs).toEqual({ sort: 'price' })
    expect(seen).toContainEqual({ kind: 'preset-mutated', presetId: preset.id })
  })

  it('rejects a preset whose connectionProfileId does not exist', async () => {
    await expect(
      createPreset({
        name: 'ghost',
        connectionProfileId: 'missing',
        settings: settingsFor('missing'),
      }),
    ).rejects.toBeInstanceOf(ProfileMissingError)
  })
})

describe('updatePreset', () => {
  it('keeps settings.profileId in sync with connectionProfileId on re-pin', async () => {
    const a = await fakeProfileId('A')
    const b = await fakeProfileId('B')
    const preset = await createPreset({
      name: 'P',
      connectionProfileId: a,
      settings: settingsFor(a),
    })
    const next = await updatePreset(preset.id, { connectionProfileId: b })
    expect(next.connectionProfileId).toBe(b)
    expect(next.settings.profileId).toBe(b)
  })

  it('ignores the caller-provided settings.profileId and forces it to the current connection', async () => {
    const a = await fakeProfileId('A')
    const preset = await createPreset({
      name: 'P',
      connectionProfileId: a,
      settings: settingsFor(a),
    })
    const drifted = settingsFor('wrong')
    delete drifted.providerPrefs
    const next = await updatePreset(preset.id, { settings: drifted })
    expect(next.settings.profileId).toBe(a)
    expect(next.settings.providerPrefs).toEqual({ sort: 'price' })
  })

  it('rejects an update to a missing preset', async () => {
    await expect(updatePreset('missing', { name: 'x' })).rejects.toBeInstanceOf(PresetMissingError)
  })
})

describe('listPresets', () => {
  it('hides archived presets from pickers but keeps them available with includeArchived', async () => {
    const profileId = await fakeProfileId()
    const live = await createPreset({
      name: 'live',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
    })
    const shelved = await createPreset({
      name: 'shelved',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
    })
    await archivePreset(shelved.id)
    const visible = await listPresets()
    expect(visible.map((p) => p.id)).toEqual([live.id])
    const all = await listPresets({ includeArchived: true })
    expect(all.map((p) => p.id).sort()).toEqual([live.id, shelved.id].sort())
  })

  it('archived presets still resolve for existing chats via getPreset', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPreset({
      name: 'live',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
    })
    await archivePreset(preset.id)
    expect((await getPreset(preset.id))?.id).toBe(preset.id)
  })
})

describe('duplicatePreset', () => {
  it('clones into a new id with suffixed name and reset lifecycle fields', async () => {
    const profileId = await fakeProfileId()
    const source = await createPreset({
      name: 'base',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      lastUsedAt: 1000,
    })
    const copy = await duplicatePreset(source.id)
    expect(copy.id).not.toBe(source.id)
    expect(copy.name).toBe('base (copy)')
    expect(copy.lastUsedAt).toBeUndefined()
    expect(copy.archived).toBe(false)
    expect(copy.settings.model).toBe(source.settings.model)
  })
})

describe('deletePreset', () => {
  it('clears chat.presetId for referencing chats and broadcasts preset-deleted', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPreset({
      name: 'base',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
    })
    const chat = await seedChatReferencingPreset(profileId, preset.id)
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    await deletePreset(preset.id)
    unsub()
    expect(seen.some((ev) => ev.kind === 'preset-deleted' && ev.presetId === preset.id)).toBe(true)
    const row = await getDb().chats.get(chat.id)
    expect(row?.presetId).toBeUndefined()
    expect(row?.settings.profileId).toBe(profileId) // settings stay intact
  })
})

describe('pickMruPreset', () => {
  it('picks the non-archived preset with the greatest lastUsedAt', async () => {
    const profileId = await fakeProfileId()
    const older = await createPreset({
      name: 'older',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      lastUsedAt: 1000,
    })
    await createPreset({
      name: 'newer',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      lastUsedAt: 5000,
    })
    const archivedNewest = await createPreset({
      name: 'archived-but-newest',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      lastUsedAt: 9000,
    })
    await archivePreset(archivedNewest.id)
    const mru = await pickMruPreset()
    expect(mru?.name).toBe('newer')
    // archived=newest must be ignored even though its lastUsedAt is largest.
    expect(mru?.lastUsedAt).toBe(5000)
    expect(older.lastUsedAt).toBe(1000)
  })

  it('falls back to the oldest non-archived preset when none has lastUsedAt', async () => {
    const profileId = await fakeProfileId()
    const first = await createPreset({
      name: 'first',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      now: 100,
    })
    await createPreset({
      name: 'second',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      now: 200,
    })
    const mru = await pickMruPreset()
    expect(mru?.id).toBe(first.id)
  })

  it('returns null when there are no presets at all', async () => {
    expect(await pickMruPreset()).toBeNull()
  })

  it('scopes MRU selection to a single profile when requested', async () => {
    const a = await fakeProfileId('A')
    const b = await fakeProfileId('B')
    await createPreset({
      name: 'a-old',
      connectionProfileId: a,
      settings: settingsFor(a),
      lastUsedAt: 1000,
    })
    const aNew = await createPreset({
      name: 'a-new',
      connectionProfileId: a,
      settings: settingsFor(a),
      lastUsedAt: 5000,
    })
    await createPreset({
      name: 'b-newest',
      connectionProfileId: b,
      settings: settingsFor(b),
      lastUsedAt: 9000,
    })
    expect((await pickMruPresetForProfile(a))?.id).toBe(aNew.id)
  })

  it('prefers the last-viewed preset over workspace-global MRU', async () => {
    const a = await fakeProfileId('A')
    const b = await fakeProfileId('B')
    const viewed = await createPreset({
      name: 'viewed',
      connectionProfileId: a,
      settings: settingsFor(a),
      lastUsedAt: 1000,
    })
    await createPreset({
      name: 'global-mru',
      connectionProfileId: b,
      settings: settingsFor(b),
      lastUsedAt: 9000,
    })
    expect((await pickPreferredPreset({ presetId: viewed.id, profileId: a }))?.id).toBe(viewed.id)
  })

  it('prefers the last-viewed profile over workspace-global MRU when preset is absent', async () => {
    const a = await fakeProfileId('A')
    const b = await fakeProfileId('B')
    const scoped = await createPreset({
      name: 'scoped',
      connectionProfileId: a,
      settings: settingsFor(a),
      lastUsedAt: 1000,
    })
    await createPreset({
      name: 'global-mru',
      connectionProfileId: b,
      settings: settingsFor(b),
      lastUsedAt: 9000,
    })
    expect((await pickPreferredPreset({ profileId: a }))?.id).toBe(scoped.id)
  })
})

describe('bumpPresetLastUsedAt', () => {
  it('promotes a preset to MRU without broadcasting', async () => {
    const profileId = await fakeProfileId()
    const old = await createPreset({
      name: 'old',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      lastUsedAt: 1000,
    })
    const newer = await createPreset({
      name: 'new',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      lastUsedAt: 5000,
    })
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    await bumpPresetLastUsedAt(old.id, 9999)
    unsub()
    const mru = await pickMruPreset()
    expect(mru?.id).toBe(old.id)
    expect(newer.lastUsedAt).toBe(5000)
    expect(seen.filter((ev) => ev.kind === 'preset-mutated')).toEqual([])
  })
})

describe('archive / unarchive', () => {
  it('round-trips archived state', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPreset({
      name: 'p',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
    })
    await archivePreset(preset.id)
    expect((await getPreset(preset.id))?.archived).toBe(true)
    await unarchivePreset(preset.id)
    expect((await getPreset(preset.id))?.archived).toBe(false)
  })
})

describe('exportPreset', () => {
  it('omits lifecycle + archived state and includes a connectionSketch without key material', async () => {
    const profileId = await fakeProfileId('OpenRouter')
    const preset = await createPreset({
      name: 'p',
      connectionProfileId: profileId,
      settings: settingsFor(profileId),
      lastUsedAt: 9000,
    })
    await archivePreset(preset.id)
    const exported = await exportPreset(preset.id)
    expect(exported.schemaVersion).toBe(1)
    expect(JSON.stringify(exported).includes('apiKeyRef')).toBe(false)
    const body = exported.preset as unknown as Record<string, unknown>
    expect(body.lastUsedAt).toBeUndefined()
    expect(body.archived).toBeUndefined()
    expect(exported.connectionSketch.name).toBe('OpenRouter')
    expect(exported.connectionSketch.kind).toBe('openrouter')
    expect(exported.connectionSketch.baseUrl).toBe('https://x')
  })
})

import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { Chat, ChatSettings, ProfileId } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, type BroadcastEvent, onEvent } from '../../src/store/broadcast'
import { __resetDbForTests, getDb, openDb } from '../../src/store/db'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import { createPreset } from '../../src/store/presets'
import { createProfile } from '../../src/store/profiles'
import {
  createPromptPreset,
  deletePromptPreset,
  getPromptPreset,
  listPromptPresets,
  PromptPresetMissingError,
  slotFor,
  updatePromptPreset,
} from '../../src/store/prompt-presets'

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

function chatSettingsFor(profileId: ProfileId): ChatSettings {
  const s = cloneDefaultChatSettings()
  s.profileId = profileId
  s.model = 'anthropic/claude-opus-4.7'
  return s
}

async function seedChat(
  profileId: ProfileId,
  patch: Partial<ChatSettings> = {},
): Promise<Chat> {
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
    settings: { ...chatSettingsFor(profileId), ...patch },
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

describe('createPromptPreset', () => {
  it('persists the preset with kind/name/text and broadcasts prompt-preset-mutated', async () => {
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    const p = await createPromptPreset({
      kind: 'system',
      name: 'My sysprompt',
      text: 'You are helpful.',
    })
    unsub()
    expect(p.kind).toBe('system')
    expect(p.name).toBe('My sysprompt')
    expect(p.text).toBe('You are helpful.')
    expect(seen).toContainEqual({ kind: 'prompt-preset-mutated', promptPresetId: p.id })
    const row = await getPromptPreset(p.id)
    expect(row?.text).toBe('You are helpful.')
  })
})

describe('listPromptPresets', () => {
  it('filters by kind when requested', async () => {
    const sys = await createPromptPreset({ kind: 'system', name: 's1', text: 's' })
    await createPromptPreset({ kind: 'continue-system', name: 'c1', text: 'c' })
    await createPromptPreset({ kind: 'continue-user', name: 'u1', text: 'u' })
    const onlySystem = await listPromptPresets('system')
    expect(onlySystem.map((p) => p.id)).toEqual([sys.id])
    const all = await listPromptPresets()
    expect(all.length).toBe(3)
  })

  it('sorts by name case-insensitively', async () => {
    await createPromptPreset({ kind: 'system', name: 'Zed', text: '' })
    await createPromptPreset({ kind: 'system', name: 'alpha', text: '' })
    const rows = await listPromptPresets('system')
    expect(rows.map((p) => p.name.toLowerCase())).toEqual(['alpha', 'zed'])
  })
})

describe('updatePromptPreset', () => {
  it('rejects an update to a missing preset', async () => {
    await expect(
      updatePromptPreset('missing', { text: 'x' }),
    ).rejects.toBeInstanceOf(PromptPresetMissingError)
  })

  it('rename does not propagate to pinned chats', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({ kind: 'system', name: 'name1', text: 'T1' })
    const chat = await seedChat(profileId, { systemPrompt: 'T1', systemPromptPresetId: preset.id })
    await updatePromptPreset(preset.id, { name: 'name2' })
    const updatedChat = await getDb().chats.get(chat.id)
    expect(updatedChat?.settings.systemPrompt).toBe('T1') // untouched
    const updatedPreset = await getPromptPreset(preset.id)
    expect(updatedPreset?.name).toBe('name2')
  })

  it('text change propagates eagerly to every chat pinned to the preset', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({ kind: 'system', name: 'n', text: 'old' })
    const pinnedA = await seedChat(profileId, {
      systemPrompt: 'old',
      systemPromptPresetId: preset.id,
    })
    const pinnedB = await seedChat(profileId, {
      systemPrompt: 'old',
      systemPromptPresetId: preset.id,
    })
    const unrelated = await seedChat(profileId, { systemPrompt: 'old' }) // no pin
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    await updatePromptPreset(preset.id, { text: 'new' })
    unsub()

    const rowA = await getDb().chats.get(pinnedA.id)
    const rowB = await getDb().chats.get(pinnedB.id)
    const rowC = await getDb().chats.get(unrelated.id)
    expect(rowA?.settings.systemPrompt).toBe('new')
    expect(rowB?.settings.systemPrompt).toBe('new')
    expect(rowC?.settings.systemPrompt).toBe('old') // unpinned: untouched

    // chat-mutated per touched chat; prompt-preset-mutated once.
    expect(seen.filter((ev) => ev.kind === 'prompt-preset-mutated').length).toBe(1)
    const touchedChats = seen.filter((ev) => ev.kind === 'chat-mutated').map((ev) => ev.chatId)
    expect(new Set(touchedChats)).toEqual(new Set([pinnedA.id, pinnedB.id]))
  })

  it('propagates to every ChatPreset whose settings pin the prompt-preset', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({
      kind: 'continue-system',
      name: 'n',
      text: 'old',
    })
    const bundle = await createPreset({
      name: 'bundle',
      connectionProfileId: profileId,
      settings: {
        ...chatSettingsFor(profileId),
        continueSystemPrompt: 'old',
        continueSystemPromptPresetId: preset.id,
      },
    })
    await updatePromptPreset(preset.id, { text: 'new' })
    const refreshed = await getDb().presets.get(bundle.id)
    expect(refreshed?.settings.continueSystemPrompt).toBe('new')
    expect(refreshed?.settings.continueSystemPromptPresetId).toBe(preset.id) // pin intact
  })

  it('only propagates to the matching kind slot, not other slots', async () => {
    const profileId = await fakeProfileId()
    const contSys = await createPromptPreset({
      kind: 'continue-system',
      name: 'n',
      text: 'old cs',
    })
    const chat = await seedChat(profileId, {
      systemPrompt: 'original system',
      continueSystemPrompt: 'old cs',
      continueSystemPromptPresetId: contSys.id,
    })
    await updatePromptPreset(contSys.id, { text: 'new cs' })
    const row = await getDb().chats.get(chat.id)
    // Continue-system slot updated; plain systemPrompt untouched.
    expect(row?.settings.continueSystemPrompt).toBe('new cs')
    expect(row?.settings.systemPrompt).toBe('original system')
  })
})

describe('deletePromptPreset', () => {
  it('clears pins on chats + ChatPresets but preserves the denormalized text', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({ kind: 'system', name: 'p', text: 'canonical' })
    const chat = await seedChat(profileId, {
      systemPrompt: 'canonical',
      systemPromptPresetId: preset.id,
    })
    const bundle = await createPreset({
      name: 'b',
      connectionProfileId: profileId,
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'canonical',
        systemPromptPresetId: preset.id,
      },
    })
    const seen: BroadcastEvent[] = []
    const unsub = onEvent((ev) => seen.push(ev))
    await deletePromptPreset(preset.id)
    unsub()

    expect(await getPromptPreset(preset.id)).toBeUndefined()
    const rowChat = await getDb().chats.get(chat.id)
    expect(rowChat?.settings.systemPromptPresetId).toBeUndefined() // pin cleared
    expect(rowChat?.settings.systemPrompt).toBe('canonical') // text preserved
    const rowBundle = await getDb().presets.get(bundle.id)
    expect(rowBundle?.settings.systemPromptPresetId).toBeUndefined()
    expect(rowBundle?.settings.systemPrompt).toBe('canonical')
    expect(seen.some((ev) => ev.kind === 'prompt-preset-deleted' && ev.promptPresetId === preset.id)).toBe(
      true,
    )
  })
})

describe('slotFor', () => {
  it('maps kind → ChatSettings field names correctly', () => {
    expect(slotFor('system')).toEqual({
      textKey: 'systemPrompt',
      pinKey: 'systemPromptPresetId',
    })
    expect(slotFor('continue-system')).toEqual({
      textKey: 'continueSystemPrompt',
      pinKey: 'continueSystemPromptPresetId',
    })
    expect(slotFor('continue-user')).toEqual({
      textKey: 'continueUserPrompt',
      pinKey: 'continueUserPromptPresetId',
    })
  })
})

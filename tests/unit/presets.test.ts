import Dexie from 'dexie'
import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type { ChatPreset, ChatSettings, PresetId, ProfileId } from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { getChat } from '../../src/store/chats'
import { configurationApplication } from '../../src/store/configuration-application'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import { interchangeApplication } from '../../src/store/interchange-application'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import type {
  ConfigurationActiveSelectionProjection,
  WorkspaceChange,
  WorkspaceDependency,
  WorkspaceQuery,
  WorkspaceQueryResult,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceRead } from '../../src/store/workspace-runtime'
import { createConfigurationProfile } from '../helpers/configuration'

const DB_NAME = 'natter'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await openBrowserWorkspace()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  __resetKeyCacheForTests()
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
})

afterAll(async () => {
  await shutdownBrowserWorkspace()
  __resetKeyCacheForTests()
})

async function query<Q extends WorkspaceQuery>(request: Q): Promise<WorkspaceQueryResult<Q>> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, request, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

async function fakeProfileId(name = 'P'): Promise<ProfileId> {
  const key = await createKey({ name, plaintextKey: 'sk-x' })
  const profile = await createConfigurationProfile({
    name,
    kind: 'openrouter',
    baseUrl: 'https://x',
    apiKeyRef: key.id,
  })
  return profile.id
}

function settingsFor(profileId: ProfileId): ChatSettings {
  const settings = cloneDefaultChatSettings()
  settings.profileId = profileId
  settings.model = 'anthropic/claude-opus-4.7'
  return settings
}

async function createPreset(input: {
  name: string
  connectionProfileId: ProfileId
  settings?: ChatSettings
  now?: number
  lastUsedAt?: number
}): Promise<ChatPreset> {
  const id = newId()
  const result = await configurationApplication.execute({
    kind: 'chat-preset.create',
    preset: {
      id,
      name: input.name,
      connectionProfileId: input.connectionProfileId,
      settings: input.settings ?? settingsFor(input.connectionProfileId),
      ...(input.lastUsedAt === undefined ? {} : { lastUsedAt: input.lastUsedAt }),
    },
    now: input.now ?? Date.now(),
  })
  if (result.kind !== 'chat-preset-saved') throw new Error(`PresetCreateFailed:${id}`)
  return result.preset
}

function getPreset(presetId: PresetId): Promise<ChatPreset | undefined> {
  return getDb().presets.get(presetId)
}

async function listPresets(includeArchived = false): Promise<ChatPreset[]> {
  if (includeArchived) return getDb().presets.toArray()
  const orderedIds: PresetId[] = []
  let cursor: string | undefined
  do {
    const page = await query({
      kind: 'configuration.preset-catalog-page',
      request: {
        direction: 'forward',
        limit: 256,
        ...(cursor ? { cursor } : {}),
      },
    })
    if (page.kind !== 'page') throw new Error(`PresetCatalogReadFailed:${page.kind}`)
    orderedIds.push(...page.rows.map((row) => row.id))
    cursor = page.nextCursor
  } while (cursor)
  const presets = await getDb().presets.bulkGet(orderedIds)
  return presets.filter((preset): preset is ChatPreset => preset !== undefined)
}

function resolveSeed(
  input: { profileId?: ProfileId | null; presetId?: PresetId | null } = {},
): Promise<ConfigurationActiveSelectionProjection> {
  return query({
    kind: 'configuration.active-selection',
    target: {
      kind: 'new-chat',
      profileId: input.profileId ?? null,
      presetId: input.presetId ?? null,
      fallback: 'full',
      promptPresets: [],
      textTemplateId: null,
    },
  })
}

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

function changedFacts(changes: readonly WorkspaceChange[]) {
  return changes.flatMap((change) => (change.kind === 'commit' ? change.delta.facts : []))
}

function mergedPresetDependency(dependencies: readonly WorkspaceDependency[]) {
  const presetDependencies = dependencies.filter(
    (dependency): dependency is Extract<WorkspaceDependency, { readonly kind: 'preset' }> =>
      dependency.kind === 'preset',
  )
  return {
    presetIds: [...new Set(presetDependencies.flatMap((dependency) => dependency.presetIds ?? []))],
    facets: [...new Set(presetDependencies.flatMap((dependency) => dependency.facets ?? []))],
  }
}

describe('chat preset configuration commands', () => {
  it('creates a profile-aligned preset and publishes one compact preset invalidation', async () => {
    const profileId = await fakeProfileId()
    const drifted = cloneDefaultChatSettings()
    drifted.profileId = 'stale'
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const preset = await createPreset({
      name: 'OpenRouter default',
      connectionProfileId: profileId,
      settings: drifted,
    })
    unsubscribe()

    expect(preset.settings.profileId).toBe(profileId)
    expect(preset.settings.providerPrefs).toEqual({ sort: 'price' })
    expect(changes.filter((change) => change.kind === 'commit')).toHaveLength(1)
    const presetDependency = mergedPresetDependency(changedDependencies(changes))
    expect(presetDependency.presetIds).toEqual([preset.id])
    expect(presetDependency.facets).toEqual(
      expect.arrayContaining([
        'selected-detail',
        'catalog-membership',
        'catalog-order',
        'catalog-display',
        'usage',
      ]),
    )
  })

  it('rejects a preset whose connection profile does not exist', async () => {
    await expect(
      configurationApplication.execute({
        kind: 'chat-preset.create',
        preset: {
          id: newId(),
          name: 'ghost',
          connectionProfileId: 'missing',
          settings: settingsFor('missing'),
        },
        now: 100,
      }),
    ).rejects.toThrow('ConfigurationMissing:profile:missing')
  })

  it('re-pins settings to the selected profile and normalizes a replacement snapshot', async () => {
    const profileA = await fakeProfileId('A')
    const profileB = await fakeProfileId('B')
    const preset = await createPreset({ name: 'P', connectionProfileId: profileA })
    const drifted = settingsFor('wrong')
    delete drifted.providerPrefs

    const result = await configurationApplication.execute({
      kind: 'chat-preset.update',
      presetId: preset.id,
      patch: { connectionProfileId: profileB, settings: drifted },
      now: 200,
    })

    expect(result.kind).toBe('chat-preset-saved')
    if (result.kind !== 'chat-preset-saved') return
    expect(result.preset.connectionProfileId).toBe(profileB)
    expect(result.preset.settings.profileId).toBe(profileB)
    expect(result.preset.settings.providerPrefs).toEqual({ sort: 'price' })
  })

  it('rejects updates and reorders that reference missing presets', async () => {
    await expect(
      configurationApplication.execute({
        kind: 'chat-preset.update',
        presetId: 'missing',
        patch: { name: 'x' },
        now: 100,
      }),
    ).rejects.toThrow('ConfigurationMissing:chat-preset:missing')
    await expect(configurationApplication.moveChatPreset('missing', null, 100)).rejects.toThrow(
      'ConfigurationMissing:chat-preset:missing',
    )
  })

  it('duplicates into a new live preset and resets MRU lifecycle state', async () => {
    const profileId = await fakeProfileId()
    const source = await createPreset({
      name: 'base',
      connectionProfileId: profileId,
      lastUsedAt: 1_000,
    })
    const copyId = newId()
    const result = await configurationApplication.execute({
      kind: 'chat-preset.duplicate',
      sourceId: source.id,
      copyId,
      now: 200,
    })

    expect(result.kind).toBe('chat-preset-saved')
    if (result.kind !== 'chat-preset-saved') return
    expect(result.preset).toMatchObject({ id: copyId, name: 'base (copy)', archived: false })
    expect(result.preset.lastUsedAt).toBeUndefined()
    expect(result.preset.settings).toEqual(source.settings)
  })
})

describe('chat preset catalog, archive, order, and MRU selection', () => {
  it('keeps archived rows addressable while excluding them from picker projections', async () => {
    const profileId = await fakeProfileId()
    const live = await createPreset({ name: 'live', connectionProfileId: profileId })
    const shelved = await createPreset({ name: 'shelved', connectionProfileId: profileId })
    await configurationApplication.archiveChatPreset(shelved.id, 300)

    expect((await listPresets()).map((preset) => preset.id)).toEqual([live.id])
    expect((await listPresets(true)).map((preset) => preset.id).sort()).toEqual(
      [live.id, shelved.id].sort(),
    )
    expect((await getPreset(shelved.id))?.archived).toBe(true)

    await configurationApplication.unarchiveChatPreset(shelved.id, 400)
    expect((await getPreset(shelved.id))?.archived).toBe(false)
  })

  it('uses the typed preset order for display without changing the MRU new-chat seed', async () => {
    const profileId = await fakeProfileId()
    const olderMru = await createPreset({
      name: 'older-mru',
      connectionProfileId: profileId,
      lastUsedAt: 1_000,
    })
    const newestMru = await createPreset({
      name: 'newest-mru',
      connectionProfileId: profileId,
      lastUsedAt: 9_000,
    })
    const neverUsed = await createPreset({ name: 'never-used', connectionProfileId: profileId })

    await configurationApplication.moveChatPreset(neverUsed.id, null, 300)

    expect((await listPresets()).map((preset) => preset.id)).toEqual([
      neverUsed.id,
      olderMru.id,
      newestMru.id,
    ])
    expect((await resolveSeed()).preset?.id).toBe(newestMru.id)
    expect((await getPreset(neverUsed.id))?.updatedAt).toBe(neverUsed.updatedAt)
  })

  it('falls back to the oldest live preset and returns no preset for an empty catalog', async () => {
    expect((await resolveSeed()).preset).toBeNull()
    const profileId = await fakeProfileId()
    const first = await createPreset({ name: 'first', connectionProfileId: profileId, now: 100 })
    await createPreset({ name: 'second', connectionProfileId: profileId, now: 200 })
    expect((await resolveSeed()).preset?.id).toBe(first.id)
  })

  it('honors a remembered live preset, then a remembered profile, before workspace MRU', async () => {
    const profileA = await fakeProfileId('A')
    const profileB = await fakeProfileId('B')
    const scoped = await createPreset({
      name: 'scoped',
      connectionProfileId: profileA,
      lastUsedAt: 1_000,
    })
    const globalMru = await createPreset({
      name: 'global-mru',
      connectionProfileId: profileB,
      lastUsedAt: 9_000,
    })

    expect(
      (
        await resolveSeed({
          profileId: profileA,
          presetId: scoped.id,
        })
      ).preset?.id,
    ).toBe(scoped.id)
    expect((await resolveSeed({ profileId: profileA })).preset?.id).toBe(scoped.id)
    expect((await resolveSeed()).preset?.id).toBe(globalMru.id)
  })

  it('touches MRU monotonically and publishes the compact cross-tab dependency', async () => {
    const profileId = await fakeProfileId()
    const old = await createPreset({
      name: 'old',
      connectionProfileId: profileId,
      lastUsedAt: 1_000,
    })
    await createPreset({ name: 'new', connectionProfileId: profileId, lastUsedAt: 5_000 })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    await configurationApplication.execute({
      kind: 'chat-preset.touch',
      presetId: old.id,
      now: 9_999,
    })
    unsubscribe()

    expect((await resolveSeed()).preset?.id).toBe(old.id)
    expect(changedDependencies(changes)).toContainEqual({
      kind: 'preset',
      presetIds: [old.id],
      facets: ['usage'],
    })
  })
})

describe('chat preset references and atomicity', () => {
  it('deletes a preset and clears every chat breadcrumb in one compact commit', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPreset({ name: 'base', connectionProfileId: profileId })
    const first = await createChat({
      title: 'first',
      settings: settingsFor(profileId),
      presetId: preset.id,
      now: 100,
    })
    const second = await createChat({
      title: 'second',
      settings: settingsFor(profileId),
      presetId: preset.id,
      now: 100,
    })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    await configurationApplication.deleteChatPreset(preset.id, 500)
    unsubscribe()

    const rows = await Promise.all([getChat(first.id), getChat(second.id)])
    for (const row of rows) {
      expect(row?.presetId).toBeUndefined()
      expect(row?.settings.profileId).toBe(profileId)
      expect(row).toMatchObject({
        configurationVersion: 1,
        metaVersion: 1,
        summaryVersion: 1,
      })
    }
    expect(rows.map((row) => row?.updatedAt).sort()).toEqual([500, 501])
    expect(await getPreset(preset.id)).toBeUndefined()
    expect(changes.filter((change) => change.kind === 'commit')).toHaveLength(1)
    const dependencies = changedDependencies(changes)
    const presetDependency = mergedPresetDependency(dependencies)
    const chatDependency = dependencies.find((dependency) => dependency.kind === 'chat')
    const sidebarDependency = dependencies.find((dependency) => dependency.kind === 'sidebar')
    expect(presetDependency.presetIds).toEqual([preset.id])
    expect(presetDependency.facets).toEqual(
      expect.arrayContaining([
        'selected-detail',
        'catalog-membership',
        'catalog-order',
        'catalog-display',
        'usage',
      ]),
    )
    expect(chatDependency?.chatIds).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(sidebarDependency?.chatIds).toEqual(expect.arrayContaining([first.id, second.id]))
    expect(changedFacts(changes)).toEqual(
      expect.arrayContaining([
        { kind: 'sidebar-row-changed', chatId: first.id },
        { kind: 'sidebar-row-changed', chatId: second.id },
      ]),
    )
  })

  it('rolls back the preset, all chat breadcrumbs, and cross-tab publication on failure', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPreset({ name: 'base', connectionProfileId: profileId })
    const first = await createChat({
      settings: settingsFor(profileId),
      presetId: preset.id,
      now: 100,
    })
    const second = await createChat({
      settings: settingsFor(profileId),
      presetId: preset.id,
      now: 100,
    })
    const beforeChats = await Promise.all([getChat(first.id), getChat(second.id)])
    const beforePreset = await getPreset(preset.id)
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))
    let updates = 0
    const failSecondUpdate = () => {
      updates += 1
      if (updates === 2) throw new Error('injected breadcrumb failure')
    }
    getDb().chats.hook.updating.subscribe(failSecondUpdate)

    try {
      await expect(configurationApplication.deleteChatPreset(preset.id, 500)).rejects.toThrow(
        'injected breadcrumb failure',
      )
    } finally {
      getDb().chats.hook.updating.unsubscribe(failSecondUpdate)
      unsubscribe()
    }

    expect(await Promise.all([getChat(first.id), getChat(second.id)])).toEqual(beforeChats)
    expect(await getPreset(preset.id)).toEqual(beforePreset)
    expect(changes).toEqual([])
  })
})

describe('chat settings configuration ownership', () => {
  it('removes optional top-level fields when a patch explicitly supplies undefined', async () => {
    const settings = cloneDefaultChatSettings()
    settings.verbosity = 'high'
    const chat = await createChat({ settings, now: 100 })

    expect(
      await configurationApplication.patchChatSettings(
        chat.id,
        { verbosity: undefined },
        { now: 200 },
      ),
    ).toBe(true)

    const updated = await getChat(chat.id)
    expect(updated?.settings.verbosity).toBeUndefined()
    expect('verbosity' in (updated?.settings ?? {})).toBe(false)
  })

  it('replaces the full settings snapshot and drops fields omitted by the replacement', async () => {
    const settings = cloneDefaultChatSettings()
    settings.providerPrefs = { sort: 'throughput' }
    settings.verbosity = 'high'
    const chat = await createChat({ settings, now: 100 })
    const replacement = cloneDefaultChatSettings()
    replacement.providerPrefs = { sort: 'price' }

    expect(
      await configurationApplication.replaceChatSettings(chat.id, replacement, { now: 200 }),
    ).toBe(true)

    const updated = await getChat(chat.id)
    expect(updated?.settings.providerPrefs).toEqual({ sort: 'price' })
    expect(updated?.settings.verbosity).toBeUndefined()
  })

  it('applies settings and presetId atomically without rewriting an identical repeat', async () => {
    const profileA = await fakeProfileId('A')
    const profileB = await fakeProfileId('B')
    const original = await createPreset({ name: 'original', connectionProfileId: profileA })
    const targetSettings = settingsFor(profileB)
    targetSettings.model = 'openai/gpt-5.4-nano'
    targetSettings.providerPrefs = { sort: 'price' }
    const target = await createPreset({
      name: 'target',
      connectionProfileId: profileB,
      settings: targetSettings,
    })
    const chat = await createChat({
      settings: settingsFor(profileA),
      presetId: original.id,
      now: 100,
    })

    expect(await configurationApplication.applyChatPreset(chat.id, target.id, 500)).toBe(true)
    const applied = await getChat(chat.id)
    expect(applied?.presetId).toBe(target.id)
    expect(applied?.settings).toEqual(target.settings)
    expect(applied?.updatedAt).toBe(500)

    expect(await configurationApplication.applyChatPreset(chat.id, target.id, 900)).toBe(false)
    expect((await getChat(chat.id))?.updatedAt).toBe(500)
  })
})

describe('chat preset interchange', () => {
  it('exports the portable payload without lifecycle or key material', async () => {
    const profileId = await fakeProfileId('OpenRouter')
    const preset = await createPreset({
      name: 'p',
      connectionProfileId: profileId,
      lastUsedAt: 9_000,
    })
    await configurationApplication.archiveChatPreset(preset.id, 300)

    const exported = await interchangeApplication.exportChatPreset(preset.id)
    expect(exported.exportSchemaVersion).toBe(2)
    expect(JSON.stringify(exported)).not.toContain('apiKeyRef')
    expect(exported.payload).not.toHaveProperty('lastUsedAt')
    expect(exported.payload).not.toHaveProperty('archived')
    expect(exported.payload.connectionSketch).toMatchObject({
      name: 'OpenRouter',
      kind: 'openrouter',
      baseUrl: 'https://x',
    })
  })
})

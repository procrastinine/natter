import Dexie from 'dexie'
import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { promptPresetSlotForKind } from '../../src/core/chat-metadata'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import type {
  ChatPreset,
  ChatSettings,
  ProfileId,
  PromptPreset,
  PromptPresetId,
  PromptPresetKind,
} from '../../src/core/types'
import { newId } from '../../src/lib/ulid'
import { __resetBroadcastForTests, subscribeWorkspaceChanges } from '../../src/store/broadcast'
import { __resetBrowserRepositoryForTests } from '../../src/store/browser-repo'
import {
  openBrowserWorkspace,
  shutdownBrowserWorkspace,
} from '../../src/store/browser-workspace-lifecycle'
import { getChat } from '../../src/store/chats'
import { configurationApplication } from '../../src/store/configuration-application'
import { configurationController } from '../../src/store/configuration-controller'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { __resetKeyCacheForTests, createKey } from '../../src/store/keys'
import type { WorkspaceChange, WorkspaceDependency } from '../../src/store/workspace-protocol'
import { __resetWorkspaceRepositoryForTests } from '../../src/store/workspace-repository'
import {
  createConfigurationProfile,
  createConfigurationPromptPreset,
} from '../helpers/configuration'

const DB_NAME = 'natter'

async function resetAll(): Promise<void> {
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetKeyCacheForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
}

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  await resetAll()
  await openBrowserWorkspace()
})

beforeEach(async () => {
  await shutdownBrowserWorkspace()
  await resetAll()
  await openBrowserWorkspace()
})

afterAll(async () => {
  await shutdownBrowserWorkspace()
  await resetAll()
})

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

function chatSettingsFor(profileId: ProfileId): ChatSettings {
  const settings = cloneDefaultChatSettings()
  settings.profileId = profileId
  settings.model = 'anthropic/claude-opus-4.7'
  return settings
}

async function createPromptPreset(input: {
  kind: PromptPresetKind
  name: string
  text: string
  now?: number
}): Promise<PromptPreset> {
  return createConfigurationPromptPreset(input)
}

async function createChatPreset(input: {
  profileId: ProfileId
  settings: ChatSettings
  name?: string
  now?: number
}): Promise<ChatPreset> {
  const id = newId()
  const result = await configurationApplication.createChatPreset({
    presetId: id,
    name: input.name ?? 'bundle',
    profileId: input.profileId,
    settings: input.settings,
    now: input.now ?? Date.now(),
  })
  if (result.kind !== 'chat-preset-saved') throw new Error(`ChatPresetCreateFailed:${id}`)
  return result.preset
}

function getPromptPreset(presetId: PromptPresetId): Promise<PromptPreset | undefined> {
  return getDb().promptPresets.get(presetId)
}

async function listPromptPresets(presetKind?: PromptPresetKind): Promise<PromptPreset[]> {
  const presets = await getDb().promptPresets.toArray()
  return presets
    .filter((preset) => presetKind === undefined || preset.kind === presetKind)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

function getChatPreset(presetId: string): Promise<ChatPreset | undefined> {
  return getDb().presets.get(presetId)
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

describe('prompt preset catalog commands', () => {
  it('creates a preset and publishes one compact prompt-preset invalidation', async () => {
    const chat = await createChat({ now: 100 })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const result = await configurationApplication.createAndPinPromptPreset({
      chatId: chat.id,
      kind: 'system',
      name: 'My sysprompt',
      text: 'You are helpful.',
      now: 200,
    })
    unsubscribe()
    if (result.kind !== 'prompt-preset-saved' || !result.preset) {
      throw new Error('PromptPresetCreateFailed')
    }
    const preset = result.preset

    const promptPresetDependency = changedDependencies(changes).find(
      (dependency) => dependency.kind === 'prompt-preset',
    )
    expect(await getPromptPreset(preset.id)).toMatchObject({
      kind: 'system',
      name: 'My sysprompt',
      text: 'You are helpful.',
    })
    expect(changes.filter((change) => change.kind === 'commit')).toHaveLength(1)
    expect(promptPresetDependency?.presetIds).toEqual([preset.id])
    expect(promptPresetDependency?.facets).toEqual(
      expect.arrayContaining([
        'selected-detail',
        'catalog-membership',
        'catalog-order',
        'catalog-display',
        'usage',
      ]),
    )
  })

  it('rolls back the prompt row when its derived catalog write fails', async () => {
    const preset = await createPromptPreset({
      kind: 'system',
      name: 'Catalog rollback',
      text: 'Body',
      now: 100,
    })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))
    const rejectProjection = () => {
      throw new Error('injected catalog projection failure')
    }
    getDb().configurationPromptPresetCatalogRows.hook.updating.subscribe(rejectProjection)

    try {
      await expect(
        configurationApplication.renamePromptPreset(preset.id, 'Changed', 200),
      ).rejects.toThrow('injected catalog projection failure')
    } finally {
      getDb().configurationPromptPresetCatalogRows.hook.updating.unsubscribe(rejectProjection)
      unsubscribe()
    }

    expect(await getPromptPreset(preset.id)).toEqual(preset)
    expect(changes).toEqual([])
  })

  it('filters by kind and presents rows in name order', async () => {
    const system = await createPromptPreset({ kind: 'system', name: 'Zed', text: 's' })
    const alpha = await createPromptPreset({ kind: 'system', name: 'alpha', text: 'a' })
    await createPromptPreset({ kind: 'continue-system', name: 'c1', text: 'c' })
    await createPromptPreset({ kind: 'continue-user', name: 'u1', text: 'u' })

    expect((await listPromptPresets('system')).map((preset) => preset.id)).toEqual([
      alpha.id,
      system.id,
    ])
    expect(await listPromptPresets()).toHaveLength(4)
  })

  it('rejects renames to a missing prompt preset', async () => {
    await expect(configurationApplication.renamePromptPreset('missing', 'x', 100)).rejects.toThrow(
      'ConfigurationMissing:prompt-preset:missing',
    )
  })
})

describe('prompt preset pin propagation', () => {
  it('renames metadata without changing pinned chat text', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({ kind: 'system', name: 'name1', text: 'T1' })
    const chat = await createChat({
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'T1',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })

    await configurationApplication.renamePromptPreset(preset.id, 'name2', 500)

    expect((await getChat(chat.id))?.settings.systemPrompt).toBe('T1')
    expect((await getPromptPreset(preset.id))?.name).toBe('name2')
  })

  it('propagates text to every linked chat and chat preset in one compact commit', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({ kind: 'system', name: 'n', text: 'old' })
    const pinnedA = await createChat({
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'old',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })
    const pinnedB = await createChat({
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'old',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })
    const unrelated = await createChat({
      settings: { ...chatSettingsFor(profileId), systemPrompt: 'old' },
      now: 100,
    })
    const bundle = await createChatPreset({
      profileId,
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'old',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    await configurationApplication.overwriteAndPinPromptPreset(pinnedA.id, preset.id, 'new', 500)
    unsubscribe()

    const rowA = await getChat(pinnedA.id)
    const rowB = await getChat(pinnedB.id)
    const rowC = await getChat(unrelated.id)
    expect(rowA?.settings.systemPrompt).toBe('new')
    expect(rowB?.settings.systemPrompt).toBe('new')
    expect(rowC?.settings.systemPrompt).toBe('old')
    expect(rowA).toMatchObject({
      configurationVersion: 1,
      metaVersion: 1,
      summaryVersion: 1,
    })
    expect(rowB).toMatchObject({
      configurationVersion: 1,
      metaVersion: 1,
      summaryVersion: 1,
    })
    expect([rowA?.updatedAt, rowB?.updatedAt].sort()).toEqual([500, 501])
    expect((await getChatPreset(bundle.id))?.settings).toMatchObject({
      systemPrompt: 'new',
      systemPromptPresetId: preset.id,
    })
    expect(changes.filter((change) => change.kind === 'commit')).toHaveLength(1)
    const dependencies = changedDependencies(changes)
    const promptPresetDependency = dependencies.find(
      (dependency) => dependency.kind === 'prompt-preset',
    )
    const presetDependency = dependencies.find((dependency) => dependency.kind === 'preset')
    const chatDependency = dependencies.find((dependency) => dependency.kind === 'chat')
    expect(promptPresetDependency?.presetIds).toEqual([preset.id])
    expect(promptPresetDependency?.facets).toContain('selected-detail')
    expect(presetDependency?.presetIds).toEqual([bundle.id])
    expect(presetDependency?.facets).toContain('selected-detail')
    expect(chatDependency?.chatIds).toEqual(expect.arrayContaining([pinnedA.id, pinnedB.id]))
    expect(changedFacts(changes)).toEqual(
      expect.arrayContaining([
        { kind: 'sidebar-row-changed', chatId: pinnedA.id },
        { kind: 'sidebar-row-changed', chatId: pinnedB.id },
      ]),
    )
  })

  it('updates only the slot belonging to the prompt preset kind', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({
      kind: 'continue-system',
      name: 'n',
      text: 'old continue',
    })
    const chat = await createChat({
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'original system',
        continueSystemPrompt: 'old continue',
        continueSystemPromptPresetId: preset.id,
      },
      now: 100,
    })

    await configurationApplication.overwriteAndPinPromptPreset(
      chat.id,
      preset.id,
      'new continue',
      500,
    )

    const updated = await getChat(chat.id)
    expect(updated?.settings.continueSystemPrompt).toBe('new continue')
    expect(updated?.settings.systemPrompt).toBe('original system')
  })

  it('rolls back prompt, chats, bundle, and publication when a linked write fails', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({ kind: 'system', name: 'n', text: 'old' })
    const first = await createChat({
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'old',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })
    const second = await createChat({
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'old',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })
    const bundle = await createChatPreset({
      profileId,
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'old',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })
    const beforePrompt = await getPromptPreset(preset.id)
    const beforeChats = await Promise.all([getChat(first.id), getChat(second.id)])
    const beforeBundle = await getChatPreset(bundle.id)
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))
    let updates = 0
    const failSecondUpdate = () => {
      updates += 1
      if (updates === 2) throw new Error('injected prompt cascade failure')
    }
    getDb().chats.hook.updating.subscribe(failSecondUpdate)

    try {
      await expect(
        configurationApplication.overwriteAndPinPromptPreset(first.id, preset.id, 'new', 500),
      ).rejects.toThrow('injected prompt cascade failure')
    } finally {
      getDb().chats.hook.updating.unsubscribe(failSecondUpdate)
      unsubscribe()
    }

    expect(await getPromptPreset(preset.id)).toEqual(beforePrompt)
    expect(await Promise.all([getChat(first.id), getChat(second.id)])).toEqual(beforeChats)
    expect(await getChatPreset(bundle.id)).toEqual(beforeBundle)
    expect(changes).toEqual([])
  })

  it('deletes a preset by clearing pins while retaining denormalized text', async () => {
    const profileId = await fakeProfileId()
    const preset = await createPromptPreset({ kind: 'system', name: 'p', text: 'canonical' })
    const chat = await createChat({
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'canonical',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })
    const bundle = await createChatPreset({
      profileId,
      settings: {
        ...chatSettingsFor(profileId),
        systemPrompt: 'canonical',
        systemPromptPresetId: preset.id,
      },
      now: 100,
    })
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    await configurationApplication.deletePromptPreset(preset.id, 500)
    unsubscribe()

    expect(await getPromptPreset(preset.id)).toBeUndefined()
    const chatRow = await getChat(chat.id)
    expect(chatRow?.settings.systemPromptPresetId).toBeUndefined()
    expect(chatRow?.settings.systemPrompt).toBe('canonical')
    expect(chatRow).toMatchObject({
      configurationVersion: 1,
      metaVersion: 1,
      summaryVersion: 1,
      updatedAt: 500,
    })
    const bundleRow = await getChatPreset(bundle.id)
    expect(bundleRow?.settings.systemPromptPresetId).toBeUndefined()
    expect(bundleRow?.settings.systemPrompt).toBe('canonical')
    const dependencies = changedDependencies(changes)
    const promptPresetDependency = dependencies.find(
      (dependency) => dependency.kind === 'prompt-preset',
    )
    const presetDependency = dependencies.find((dependency) => dependency.kind === 'preset')
    expect(promptPresetDependency?.presetIds).toEqual([preset.id])
    expect(promptPresetDependency?.facets).toEqual(
      expect.arrayContaining([
        'selected-detail',
        'catalog-membership',
        'catalog-order',
        'catalog-display',
        'usage',
      ]),
    )
    expect(presetDependency?.presetIds).toEqual([bundle.id])
    expect(presetDependency?.facets).toContain('selected-detail')
    expect(dependencies).toContainEqual({ kind: 'chat', chatIds: [chat.id] })
    expect(dependencies).toContainEqual({ kind: 'sidebar', chatIds: [chat.id] })
    expect(changedFacts(changes)).toContainEqual({
      kind: 'sidebar-row-changed',
      chatId: chat.id,
    })
  })
})

describe('prompt slot and pending edit ownership', () => {
  it('maps every prompt kind onto its canonical text and pin fields', () => {
    expect(promptPresetSlotForKind('system')).toEqual({
      textKey: 'systemPrompt',
      pinKey: 'systemPromptPresetId',
    })
    expect(promptPresetSlotForKind('append')).toEqual({
      textKey: 'appendPrompt',
      pinKey: 'appendPromptPresetId',
    })
    expect(promptPresetSlotForKind('continue-system')).toEqual({
      textKey: 'continueSystemPrompt',
      pinKey: 'continueSystemPromptPresetId',
    })
    expect(promptPresetSlotForKind('continue-user')).toEqual({
      textKey: 'continueUserPrompt',
      pinKey: 'continueUserPromptPresetId',
    })
    expect(promptPresetSlotForKind('prefill')).toEqual({
      textKey: 'defaultPrefill',
      pinKey: 'defaultPrefillPresetId',
    })
  })

  it('flushes mounted edits per chat and propagates the original failure', async () => {
    let releaseA: () => void = () => undefined
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const sessionA = configurationController.openEditSession({
      chatId: 'chat-a',
      fieldKey: 'system-prompt',
      flush: () => gateA,
    })
    const sessionB = configurationController.openEditSession({
      chatId: 'chat-b',
      fieldKey: 'system-prompt',
      flush: async () => undefined,
    })

    await configurationController.flushChatEdits('chat-b')
    let flushedA = false
    const pendingA = configurationController.flushChatEdits('chat-a').then(() => {
      flushedA = true
    })
    await Promise.resolve()
    expect(flushedA).toBe(false)
    releaseA()
    await pendingA
    await Promise.all([sessionA.close('discard'), sessionB.close('discard')])

    const failure = new Error('prompt save failed before send')
    const failedSession = configurationController.openEditSession({
      chatId: 'chat-c',
      fieldKey: 'system-prompt',
      flush: () => Promise.reject(failure),
    })
    await expect(configurationController.flushChatEdits('chat-c')).rejects.toBe(failure)
    await failedSession.close('discard')
  })

  it('projects a staged prompt edit immediately for its chat without waiting for persistence', async () => {
    const chat = await createChat({ settings: cloneDefaultChatSettings(), now: 100 })
    const [intent] = configurationController.stageChatSettingsFields(chat.id, [
      { path: ['systemPrompt'], value: 'fresh prompt' },
    ])
    if (!intent) throw new Error('PendingIntentMissing')

    expect(configurationController.projectChatConfiguration(chat).settings.systemPrompt).toBe(
      'fresh prompt',
    )
    expect(
      configurationController.projectChatConfiguration({ ...chat, id: 'another-chat' }).settings
        .systemPrompt,
    ).toBe(chat.settings.systemPrompt)

    configurationController.discardPendingChatSettingsField(
      chat.id,
      intent.fieldKey,
      intent.revision,
    )
    expect(configurationController.projectChatConfiguration(chat).settings.systemPrompt).toBe(
      chat.settings.systemPrompt,
    )
  })
})

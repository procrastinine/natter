import Dexie from 'dexie'
import { createChat } from '../helpers/chats'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { connectionDispatchProfileProof } from '../../src/core/connection-dispatch-proof'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  EMPTY_TEXT_TEMPLATE,
  LEGACY_SAVED_TEXT_TEMPLATES_KEY,
  type SavedTextTemplate,
  savedTextTemplateCatalogRow,
} from '../../src/core/text-templates'
import type {
  Chat,
  ChatPreset,
  ChatSettings,
  ConnectionProfile,
  Message,
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
import { configurationRequestRevisionFor } from '../../src/store/configuration-domain-contract'
import { __resetDbForTests, getDb } from '../../src/store/db'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import type {
  ConfigurationActiveSelectionProjection,
  GenerationPlanningSnapshot,
  WorkspaceChange,
  WorkspaceQuery,
  WorkspaceQueryResult,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'
import { testStreamLeaseAdmission } from '../helpers/stream-leases'

const DB_NAME = 'natter'
const MODEL_ID = 'test/text-completions-model'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete(DB_NAME)
  await openBrowserWorkspace()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
})

afterAll(async () => {
  await shutdownBrowserWorkspace()
})

async function seedProfile(): Promise<ConnectionProfile> {
  const result = await configurationApplication.createConnection({
    name: 'Text template test',
    kind: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    now: 10,
  })
  if (result.kind !== 'connection-saved') throw new Error('TextTemplateProfileCreateFailed')
  return result.profile
}

function settingsFor(profile: ConnectionProfile): ChatSettings {
  const settings = cloneDefaultChatSettings()
  settings.profileId = profile.id
  settings.model = MODEL_ID
  return settings
}

async function seedChat(): Promise<Chat> {
  const profile = await seedProfile()
  return createChat({ settings: settingsFor(profile), now: 20 })
}

async function createChatPreset(
  profile: ConnectionProfile,
  settings: ChatSettings,
): Promise<ChatPreset> {
  const presetId = newId()
  const result = await configurationApplication.execute({
    kind: 'chat-preset.create',
    preset: {
      id: presetId,
      name: 'Template bundle',
      connectionProfileId: profile.id,
      settings,
    },
    now: 30,
  })
  if (result.kind !== 'chat-preset-saved') {
    throw new Error(`TextTemplateChatPresetCreateFailed:${presetId}`)
  }
  return result.preset
}

async function query<Q extends WorkspaceQuery>(request: Q): Promise<WorkspaceQueryResult<Q>> {
  return runWorkspaceRead('repository-query', (permit) =>
    getWorkspaceRepository()
      .query(permit, request, { signal: permit.signal })
      .then((envelope) => envelope.value),
  )
}

function loadTextTemplateCatalog() {
  return query({ kind: 'configuration.text-template-catalog' })
}

async function loadSelectedTextTemplate(
  templateId: string,
): Promise<ConfigurationActiveSelectionProjection['textTemplate']> {
  return query({
    kind: 'configuration.active-selection',
    target: {
      kind: 'chat',
      profileId: null,
      presetId: null,
      promptPresets: [],
      textTemplateId: templateId,
    },
  }).then((selection) => selection.textTemplate)
}

describe('saved text template ownership', () => {
  it('lists compact metadata for 1000 templates without hydrating any source row', async () => {
    const largeSource = 'x'.repeat(2 * 1024 * 1024)
    const rows: SavedTextTemplate[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `user:catalog-${String(index).padStart(4, '0')}`,
      name: `Catalog ${index}`,
      config: {
        ...EMPTY_TEXT_TEMPLATE,
        template: index < 8 ? largeSource : `source ${index}`,
      },
      createdAt: index,
      updatedAt: index,
    }))
    await getDb().textTemplates.bulkPut(rows)
    const hydratedIds: string[] = []
    const observeRead = (row: SavedTextTemplate) => {
      hydratedIds.push(row.id)
      return row
    }
    getDb().textTemplates.hook.reading.subscribe(observeRead)
    try {
      const catalog = await loadTextTemplateCatalog()
      expect(catalog).toHaveLength(rows.length)
      expect(catalog[0]).toEqual(savedTextTemplateCatalogRow(rows[0] as SavedTextTemplate))
      expect(catalog.at(-1)).toEqual(savedTextTemplateCatalogRow(rows.at(-1) as SavedTextTemplate))
      expect(hydratedIds).toEqual([])

      expect(await loadSelectedTextTemplate('user:catalog-0500')).toEqual({
        templateId: 'user:catalog-0500',
        config: rows[500]?.config,
      })
      expect(hydratedIds).toEqual(['user:catalog-0500'])
    } finally {
      getDb().textTemplates.hook.reading.unsubscribe(observeRead)
    }
  })

  it('creates and updates one row without rewriting a 1000-template catalog setting', async () => {
    await getDb().textTemplates.bulkPut(
      Array.from(
        { length: 1_000 },
        (_, index): SavedTextTemplate => ({
          id: `user:write-${String(index).padStart(4, '0')}`,
          name: `Write ${index}`,
          config: { ...EMPTY_TEXT_TEMPLATE, template: `source ${index}` },
          createdAt: index,
          updatedAt: index,
        }),
      ),
    )
    let templateCreates = 0
    let templateUpdates = 0
    const settingMutationKeys: unknown[] = []
    const onTemplateCreate = () => {
      templateCreates += 1
    }
    const onTemplateUpdate = () => {
      templateUpdates += 1
    }
    const onSettingCreate = (key: unknown) => {
      settingMutationKeys.push(key)
    }
    const onSettingUpdate = (_modifications: unknown, key: unknown) => {
      settingMutationKeys.push(key)
    }
    getDb().textTemplates.hook.creating.subscribe(onTemplateCreate)
    getDb().textTemplates.hook.updating.subscribe(onTemplateUpdate)
    getDb().settings.hook.creating.subscribe(onSettingCreate)
    getDb().settings.hook.updating.subscribe(onSettingUpdate)
    try {
      await configurationApplication.updateTextTemplate(
        'user:write-0500',
        { config: { ...EMPTY_TEXT_TEMPLATE, template: 'y'.repeat(2 * 1024 * 1024) } },
        2_000,
      )
      await configurationApplication.createTextTemplate({
        name: 'One more',
        config: { ...EMPTY_TEXT_TEMPLATE, template: 'one more source' },
        now: 2_001,
      })
    } finally {
      getDb().textTemplates.hook.creating.unsubscribe(onTemplateCreate)
      getDb().textTemplates.hook.updating.unsubscribe(onTemplateUpdate)
      getDb().settings.hook.creating.unsubscribe(onSettingCreate)
      getDb().settings.hook.updating.unsubscribe(onSettingUpdate)
    }
    expect({ templateCreates, templateUpdates }).toEqual({
      templateCreates: 1,
      templateUpdates: 1,
    })
    expect(settingMutationKeys).not.toContain(LEGACY_SAVED_TEXT_TEMPLATES_KEY)
    expect(await getDb().textTemplates.count()).toBe(1_001)
    expect((await getDb().textTemplates.get('user:write-0499'))?.config.template).toBe('source 499')
  })

  it('creates and selects a saved template atomically in one workspace commit', async () => {
    const chat = await seedChat()
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    const template = await configurationApplication.createAndSelectTextTemplate({
      chatId: chat.id,
      name: 'Atomic template',
      config: { ...EMPTY_TEXT_TEMPLATE, template: 'atomic source' },
      now: 100,
    })
    unsubscribe()

    expect(await loadTextTemplateCatalog()).toEqual([savedTextTemplateCatalogRow(template)])
    expect(await loadSelectedTextTemplate(template.id)).toEqual({
      templateId: template.id,
      config: template.config,
    })
    expect((await getChat(chat.id))?.settings.textTemplate).toBe(template.id)
    const commits = changes.filter((change) => change.kind === 'commit')
    expect(commits).toHaveLength(1)
    expect(commits[0]?.delta.invalidations).toEqual(
      expect.arrayContaining([
        { kind: 'text-template', templateIds: [template.id] },
        { kind: 'chat', chatIds: [chat.id] },
      ]),
    )
    expect(commits[0]?.delta.invalidations).not.toEqual(
      expect.arrayContaining([{ kind: 'setting', keys: ['global:text-templates:v1'] }]),
    )

    const failChatWrite = () => {
      throw new Error('injected create-and-select failure')
    }
    getDb().chats.hook.updating.subscribe(failChatWrite)
    try {
      await expect(
        configurationApplication.createAndSelectTextTemplate({
          chatId: chat.id,
          name: 'Rolled back template',
          config: { ...EMPTY_TEXT_TEMPLATE, template: 'must not persist' },
          now: 200,
        }),
      ).rejects.toThrow('injected create-and-select failure')
    } finally {
      getDb().chats.hook.updating.unsubscribe(failChatWrite)
    }

    expect(await loadTextTemplateCatalog()).toEqual([savedTextTemplateCatalogRow(template)])
    expect((await getChat(chat.id))?.settings.textTemplate).toBe(template.id)
  })

  it('deletes a saved template and resets every linked chat and preset to chatml', async () => {
    const profile = await seedProfile()
    const chat = await createChat({ settings: settingsFor(profile), now: 20 })
    const template = await configurationApplication.createAndSelectTextTemplate({
      chatId: chat.id,
      name: 'Shared template',
      config: { ...EMPTY_TEXT_TEMPLATE, template: 'shared source' },
      now: 100,
    })
    const presetSettings = settingsFor(profile)
    presetSettings.textTemplate = template.id
    const preset = await createChatPreset(profile, presetSettings)
    const changes: WorkspaceChange[] = []
    const unsubscribe = subscribeWorkspaceChanges((change) => changes.push(change))

    await configurationApplication.deleteTextTemplate(template.id, 200)
    unsubscribe()

    expect(await loadTextTemplateCatalog()).toEqual([])
    expect(await loadSelectedTextTemplate(template.id)).toEqual({
      templateId: template.id,
      config: null,
    })
    expect((await getChat(chat.id))?.settings.textTemplate).toBe('chatml')
    expect((await getDb().presets.get(preset.id))?.settings.textTemplate).toBe('chatml')
    expect(changes.filter((change) => change.kind === 'commit')).toHaveLength(1)
  })

  it('flushes a mounted template editor before deleting its template', async () => {
    const template = await configurationApplication.createTextTemplate({
      name: 'Pending editor template',
      config: { ...EMPTY_TEXT_TEMPLATE, template: 'before flush' },
      now: 100,
    })
    const events: string[] = []
    let releaseFlush: () => void = () => undefined
    const flushGate = new Promise<void>((resolve) => {
      releaseFlush = resolve
    })
    const session = configurationController.openEditSession({
      ownerKey: `text-template:${template.id}`,
      fieldKey: 'source',
      flush: async () => {
        events.push('flush-started')
        await flushGate
        events.push('flush-finished')
      },
    })

    const deletion = configurationApplication.deleteTextTemplate(template.id, 200).then(() => {
      events.push('deleted')
    })
    await Promise.resolve()

    expect(events).toEqual(['flush-started'])
    expect(await loadTextTemplateCatalog()).toEqual([savedTextTemplateCatalogRow(template)])
    releaseFlush()
    await deletion

    expect(events).toEqual(['flush-started', 'flush-finished', 'deleted'])
    expect(await loadTextTemplateCatalog()).toEqual([])
    await session.close('discard')
  })

  it('keeps the captured generation template stable after later edits and deletion', async () => {
    const chat = await seedChat()
    const originalConfig = { ...EMPTY_TEXT_TEMPLATE, template: 'captured source' }
    const template = await configurationApplication.createAndSelectTextTemplate({
      chatId: chat.id,
      name: 'Captured template',
      config: originalConfig,
      now: 100,
    })

    await getDb().textTemplates.bulkPut(
      Array.from(
        { length: 999 },
        (_, index): SavedTextTemplate => ({
          id: `user:unselected-${String(index).padStart(4, '0')}`,
          name: `Unselected ${index}`,
          config: { ...EMPTY_TEXT_TEMPLATE, template: `unselected source ${index}` },
          createdAt: index + 1_000,
          updatedAt: index + 1_000,
        }),
      ),
    )
    const hydratedIds: string[] = []
    const observeRead = (row: SavedTextTemplate) => {
      hydratedIds.push(row.id)
      return row
    }
    getDb().textTemplates.hook.reading.subscribe(observeRead)
    let snapshot: GenerationPlanningSnapshot
    try {
      snapshot = await captureGenerationPlanningSnapshot(chat.id)
    } finally {
      getDb().textTemplates.hook.reading.unsubscribe(observeRead)
    }
    expect(hydratedIds).toEqual([template.id])
    await configurationApplication.updateTextTemplate(
      template.id,
      { config: { ...EMPTY_TEXT_TEMPLATE, template: 'later source' } },
      200,
    )
    await configurationApplication.deleteTextTemplate(template.id, 300)

    expect(snapshot.chat.settings.textTemplate).toBe(template.id)
    expect(snapshot.savedTextTemplate).toEqual({
      templateId: template.id,
      config: originalConfig,
    })
    expect((await getChat(chat.id))?.settings.textTemplate).toBe('chatml')
  })
})

async function captureGenerationPlanningSnapshot(
  chatId: string,
): Promise<GenerationPlanningSnapshot> {
  const startedAt = 150
  const streamId = newId()
  const turnId = newId()
  const user = generationMessage({
    id: newId(),
    chatId,
    turnId,
    turnIndex: 0,
    createdAt: startedAt,
    role: 'user',
    parentId: null,
  })
  const assistant = generationMessage({
    id: newId(),
    chatId,
    turnId,
    turnIndex: 1,
    createdAt: startedAt,
    role: 'assistant',
    parentId: user.id,
  })
  const chat = await getChat(chatId)
  if (!chat) throw new Error(`TextTemplatePlanningChatMissing:${chatId}`)
  const templateId = chat.settings.textTemplate
  if (!templateId) throw new Error(`TextTemplatePlanningSelectionMissing:${chatId}`)
  const savedTextTemplate = await loadSelectedTextTemplate(templateId)
  const profileId = chat.settings.profileId
  if (!profileId) throw new Error(`TextTemplatePlanningProfileSelectionMissing:${chatId}`)
  const profile = await getDb().profiles.get(profileId)
  if (!profile) throw new Error(`TextTemplatePlanningProfileMissing:${profileId}`)
  const commit = await runWorkspaceAction('conversation-generation', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'attempt.prepare',
      input: {
        strategy: 'send',
        lease: testStreamLeaseAdmission({
          streamId,
          chatId,
          messageId: assistant.id,
          ownerClientId: 'saved-template-test',
          fenceToken: `fence:${streamId}`,
          replacementEpoch: permit.replacementEpoch,
          startedAt,
          heartbeatAt: startedAt,
          attemptKind: 'generation',
        }),
        promptPath: {
          requirement: {
            kind: 'send',
            surface: 'chat',
            chatId,
            target: { kind: 'root' },
            childSlot: 'empty',
          },
          claim: { chatId, leafId: null, headers: [] },
        },
        configurationClaim: {
          configurationVersion: chat.configurationVersion ?? 0,
          settings: chat.settings,
          presetId: chat.presetId ?? null,
          profile: connectionDispatchProfileProof(profile, MODEL_ID),
          requestRevision: configurationRequestRevisionFor(profile, undefined),
          dispatchKeyRevisions: [],
          preferredDispatchKeyId: null,
          workspaceSettingOverrides: [],
          ...(savedTextTemplate ? { savedTextTemplate } : {}),
        },
        user,
        assistant,
      },
    }),
  )
  return commit.value.planning
}

function generationMessage(input: {
  id: string
  chatId: string
  turnId: string
  turnIndex: number
  createdAt: number
  role: 'user' | 'assistant'
  parentId: string | null
}): Message {
  return {
    ...input,
    siblingIndex: 0,
    origin: input.role === 'assistant' ? 'generated' : 'user',
    content: input.role === 'assistant' ? [] : [{ type: 'text', text: 'pending send' }],
    ...(input.role === 'assistant'
      ? {
          generation: {
            model: MODEL_ID,
            requestedModel: MODEL_ID,
            status: 'preparing' as const,
            integrity: 'clean' as const,
            costSource: 'stream' as const,
            reasoningCarryForward: 'none' as const,
            reasoningVisibility: { disclosure: 'unknown' as const },
            startedAt: input.createdAt,
          },
        }
      : {}),
    nodeVersion: 0,
    deleted: false,
  }
}

import Dexie from 'dexie'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import { tokenCalibrationKey } from '../../src/core/model-ids'
import { EMPTY_TEXT_TEMPLATE, type SavedTextTemplate } from '../../src/core/text-templates'
import { GLOBAL_TOKEN_CALIBRATION_KEY } from '../../src/core/token-calibration'
import type { Chat, ConnectionProfile, KeyRecord, PromptPreset } from '../../src/core/types'
import { __resetBroadcastForTests } from '../../src/store/broadcast'
import {
  __getBrowserWorkspaceSessionRepositoryForTests,
  __resetBrowserRepositoryForTests,
  executeBrowserCommandInDatabase,
  getBrowserRepository,
} from '../../src/store/browser-repo'
import { cleanPendingBrowserWorkspaceDatabase } from '../../src/store/browser-workspace-database-cleanup'
import {
  beginBrowserWorkspaceDatabaseReplacement,
  readBrowserWorkspaceDatabaseManifest,
} from '../../src/store/browser-workspace-database-control'
import {
  isExpectedBrowserWorkspaceShutdownError,
  openBrowserWorkspace,
  resumeBrowserWorkspace,
  shutdownBrowserWorkspace,
  shutdownBrowserWorkspaceWhenIdle,
} from '../../src/store/browser-workspace-lifecycle'
import {
  runBrowserWorkspaceReplacement,
  tryStartBrowserWorkspaceReplacementIfIdle,
} from '../../src/store/browser-workspace-replacement-runner'
import { configurationPromptPresetCatalogProjectionRow } from '../../src/store/configuration-catalog-projection'
import type { ConversationController } from '../../src/store/conversation-controller'
import { createConversationRepositoryAdapter } from '../../src/store/conversation-repository-adapter'
import { __resetDbForTests, BrowserWorkspaceSessionClosedError, getDb } from '../../src/store/db'
import { createWorkspaceMessageMaterialCoordinator } from '../../src/store/generation-prompt-material'
import { exportWorkspaceBackup, restoreWorkspaceBackup } from '../../src/store/import-export'
import { readBrowserWorkspaceMeta } from '../../src/store/workspace-meta'
import type {
  WorkspaceCommand,
  WorkspaceQuery,
  WorkspaceRepository,
} from '../../src/store/workspace-protocol'
import {
  __resetWorkspaceRepositoryForTests,
  __setWorkspaceRepositoryForTests,
  getWorkspaceRepository,
} from '../../src/store/workspace-repository'
import {
  isWorkspaceRuntimeClosedError,
  runWorkspaceAction,
  runWorkspaceRead,
  type WorkspaceReadPermit,
} from '../../src/store/workspace-runtime'
import {
  awaitWorkspaceRuntimeQuiesced,
  getWorkspaceRuntimeControlSnapshot,
  launchImportExportWorkspaceRuntimeReplacementNow,
} from '../../src/store/workspace-runtime-control'
import { putTestChat, putTestChats } from '../helpers/chats'
import { expectWorkspaceRepositoryCoreContract } from '../helpers/workspace-repository-contract'

let emptyWorkspaceBackup: Awaited<ReturnType<typeof exportWorkspaceBackup>>

function sessionChat(id: string): Chat {
  return {
    id,
    title: id,
    titleStatus: 'untitled',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    settings: cloneDefaultChatSettings(),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function read(repository: WorkspaceRepository, query: WorkspaceQuery) {
  return runWorkspaceRead('repository-query', (permit) => repository.query(permit, query))
}

function write(repository: WorkspaceRepository, command: WorkspaceCommand) {
  return runWorkspaceAction('maintenance', (permit) => repository.execute(permit, command))
}

beforeAll(async () => {
  ;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
  __resetWorkspaceRepositoryForTests()
  __resetBrowserRepositoryForTests()
  __resetBroadcastForTests()
  __resetDbForTests()
  await Dexie.delete('natter')
  await openBrowserWorkspace()
  emptyWorkspaceBackup = await exportWorkspaceBackup()
})

beforeEach(async () => {
  await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 1 })
})

afterAll(async () => {
  await shutdownBrowserWorkspace()
})

describe('browser WorkspaceRepository protocol contract', () => {
  it('satisfies the reusable stamped query/command/branch contract', async () => {
    await expectWorkspaceRepositoryCoreContract(getBrowserRepository())
  })

  it('executes chat metadata commands through exact semantic capabilities', async () => {
    const repository = getBrowserRepository()
    await putTestChat(sessionChat('semantic-chat'))

    const viewed = await write(repository, {
      kind: 'chat.touch-viewed',
      chatId: 'semantic-chat',
      now: 2,
    })
    expect(viewed.delta).toMatchObject({
      facts: [{ kind: 'sidebar-row-changed', chatId: 'semantic-chat' }],
      invalidations: expect.arrayContaining([
        { kind: 'chat', chatIds: ['semantic-chat'] },
        { kind: 'sidebar', chatIds: ['semantic-chat'] },
      ]) as unknown,
    })

    await expect(
      write(repository, {
        kind: 'chat.set-manual-title',
        chatId: 'semantic-chat',
        title: 'Semantic title',
        now: 3,
      }),
    ).resolves.toMatchObject({ value: { value: true } })

    await expect(
      write(repository, {
        kind: 'chat.set-archived',
        chatIds: ['semantic-chat'],
        archived: true,
        now: 4,
      }),
    ).resolves.toMatchObject({ value: { value: ['semantic-chat'] } })

    expect(
      (await read(repository, { kind: 'chat.get', chatId: 'semantic-chat' })).value,
    ).toMatchObject({
      title: 'Semantic title',
      titleStatus: 'manual',
      lastViewedAt: 2,
      archived: true,
    })
  })

  it('clears chat calibration through one semantic transaction without catalog planning', async () => {
    const repository = getBrowserRepository()
    const calibrationKey = tokenCalibrationKey('openai/gpt-5.4-nano')
    const sample = {
      totalTextChars: 400,
      totalTextTokens: 100,
      sampleCount: 2,
      updatedAt: 1,
    }
    await putTestChat({
      ...sessionChat('calibration-chat'),
      tokenCalibration: { [calibrationKey]: sample },
      tokenCalibrationGeneration: 0,
    })
    await getDb().settings.put({
      key: GLOBAL_TOKEN_CALIBRATION_KEY,
      value: {
        version: 1,
        updatedAt: 1,
        byModel: { [calibrationKey]: sample },
      },
    })

    const result = await write(repository, {
      kind: 'chat.calibration.clear',
      chatId: 'calibration-chat',
      calibrationKey,
      now: 2,
    })

    expect(result).toMatchObject({
      effectScope: 'workspace',
      value: {
        value: true,
        affectedChatIds: ['calibration-chat'],
      },
      delta: {
        invalidations: expect.arrayContaining([
          { kind: 'chat', chatIds: ['calibration-chat'] },
          { kind: 'setting', keys: [GLOBAL_TOKEN_CALIBRATION_KEY] },
        ]) as unknown,
      },
    })
    expect(await getDb().chats.get('calibration-chat')).toMatchObject({
      tokenCalibration: {},
      tokenCalibrationGeneration: 1,
    })
    expect(await getDb().settings.get(GLOBAL_TOKEN_CALIBRATION_KEY)).toMatchObject({
      value: { byModel: {} },
    })

    await expect(
      write(repository, {
        kind: 'chat.calibration.clear',
        chatId: 'missing-calibration-chat',
        now: 3,
      }),
    ).resolves.toMatchObject({
      effectScope: 'none',
      value: { value: false, affectedChatIds: [] },
    })

    await putTestChat({
      ...sessionChat('calibration-family-chat'),
      tokenCalibration: { [calibrationKey]: sample },
      tokenCalibrationGeneration: 0,
    })
    await getDb().settings.put({
      key: GLOBAL_TOKEN_CALIBRATION_KEY,
      value: {
        version: 1,
        updatedAt: 3,
        byModel: { [calibrationKey]: sample },
      },
    })
    await expect(
      write(repository, {
        kind: 'chat.calibration.clear-family',
        calibrationKey,
        now: 4,
      }),
    ).resolves.toMatchObject({
      effectScope: 'workspace',
      value: { value: { globalChanged: true, chatCount: 1 } },
    })
    await expect(
      write(repository, {
        kind: 'chat.calibration.clear-all',
        now: 5,
      }),
    ).resolves.toMatchObject({
      effectScope: 'workspace',
      value: { value: { globalChanged: false, chatCount: 0 } },
    })
  })

  it('pages workspace calibration atomically and publishes identity-only chat evidence', async () => {
    const calibrationKey = tokenCalibrationKey('paged/calibration-model')
    const sample = {
      totalTextChars: 400,
      totalTextTokens: 100,
      sampleCount: 2,
      updatedAt: 1,
    }
    const chatIds = Array.from({ length: 130 }, (_, index) => `paged-calibration-${index}`)
    await getDb().chats.bulkPut(
      chatIds.map((id) => ({
        ...sessionChat(id),
        tokenCalibration: { [calibrationKey]: sample },
        tokenCalibrationGeneration: 0,
      })),
    )
    const workspace = await readBrowserWorkspaceMeta(getDb())

    const execution = await executeBrowserCommandInDatabase(getDb(), workspace, {
      kind: 'chat.calibration.clear-family',
      calibrationKey,
      now: 10,
    })
    const expectedChatIds = [...chatIds].sort()

    expect(execution.commit.value).toMatchObject({
      value: { globalChanged: false, chatCount: 130 },
      affectedChatIds: expectedChatIds,
    })
    expect(execution.commit.receipt.chats).toEqual([])
    expect(execution.commit.delta.invalidations).toContainEqual({
      kind: 'chat',
      chatIds: expectedChatIds,
    })
    expect(await getDb().chats.get(expectedChatIds.at(-1) ?? '')).toMatchObject({
      tokenCalibration: {},
      tokenCalibrationGeneration: 1,
    })
  })

  it('queues a foreground command behind a generation without replacing the workspace', async () => {
    const calibrationKey = tokenCalibrationKey('paged/blocked-generation-model')
    const sample = {
      totalTextChars: 400,
      totalTextTokens: 100,
      sampleCount: 2,
      updatedAt: 1,
    }
    const chatIds = Array.from({ length: 130 }, (_, index) => `blocked-generation-${index}`)
    await getDb().chats.bulkPut(
      chatIds.map((id) => ({
        ...sessionChat(id),
        tokenCalibration: { [calibrationKey]: sample },
        tokenCalibrationGeneration: 0,
      })),
    )
    let releaseGeneration!: () => void
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    let generationAborted = false
    const generation = runWorkspaceAction(
      'conversation-generation',
      async (permit) => {
        permit.signal.addEventListener('abort', () => {
          generationAborted = true
        })
        await generationGate
      },
      { lineageId: 'generation:paged-command-blocker' },
    )
    let commandSettled = false
    const command = runWorkspaceAction('message-structure', (permit) =>
      getBrowserRepository()
        .execute(permit, {
          kind: 'chat.calibration.clear-family',
          calibrationKey,
          now: 10,
        })
        .finally(() => {
          commandSettled = true
        }),
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(commandSettled).toBe(false)
    expect(generationAborted).toBe(false)
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')

    releaseGeneration()
    await generation
    const committed = await command
    expect(committed).toMatchObject({
      value: { value: { globalChanged: false, chatCount: 130 } },
    })
    expect(committed.receipt.chats).toEqual([])
    expect(committed.delta.invalidations).toContainEqual({
      kind: 'chat',
      chatIds: [...chatIds].sort(),
    })
    expect(generationAborted).toBe(false)
  })

  it('pages prompt target fanout atomically and publishes identity-only chat evidence', async () => {
    const preset: PromptPreset = {
      id: 'staged-prompt-fanout',
      kind: 'system',
      name: 'Staged prompt fanout',
      text: 'before',
      createdAt: 1,
      updatedAt: 1,
    }
    const chatIds = Array.from({ length: 130 }, (_, index) => `staged-prompt-chat-${index}`)
    await Promise.all([
      getDb().promptPresets.put(preset),
      getDb().configurationPromptPresetCatalogRows.put(
        configurationPromptPresetCatalogProjectionRow(preset),
      ),
      putTestChats(
        chatIds.map((id) => ({
          ...sessionChat(id),
          settings: {
            ...cloneDefaultChatSettings(),
            systemPrompt: preset.text,
            systemPromptPresetId: preset.id,
          },
        })),
      ),
    ])
    const workspace = await readBrowserWorkspaceMeta(getDb())

    const execution = await executeBrowserCommandInDatabase(getDb(), workspace, {
      kind: 'configuration.execute',
      input: {
        kind: 'prompt-preset.overwrite-and-pin',
        chatId: chatIds[0] ?? '',
        presetId: preset.id,
        text: 'after',
        now: 10,
      },
    })
    const expectedChatIds = [...chatIds].sort()

    expect(execution.commit.value).toMatchObject({
      kind: 'prompt-preset-saved',
      affectedChatIds: expectedChatIds,
      affectedPresetIds: [],
      affectedChatCount: 130,
      affectedPresetCount: 0,
    })
    expect(execution.commit.receipt.chats).toEqual([])
    expect(execution.commit.delta.invalidations).toContainEqual({
      kind: 'chat',
      chatIds: expectedChatIds,
    })
    expect(
      await getDb()
        .configurationLinks.where('targetKey')
        .equals(`prompt-preset:${preset.id}`)
        .count(),
    ).toBe(130)
    expect(await getDb().chats.get(expectedChatIds.at(-1) ?? '')).toMatchObject({
      settings: { systemPrompt: 'after', systemPromptPresetId: preset.id },
      configurationVersion: 1,
    })
  })

  it('rolls back every earlier page when an atomic command fails late', async () => {
    const preset: PromptPreset = {
      id: 'failed-staged-prompt',
      kind: 'system',
      name: 'Failed staged prompt',
      text: 'before',
      createdAt: 1,
      updatedAt: 1,
    }
    const chatIds = Array.from({ length: 130 }, (_, index) => `failed-staged-chat-${index}`)
    await Promise.all([
      getDb().promptPresets.put(preset),
      getDb().configurationPromptPresetCatalogRows.put(
        configurationPromptPresetCatalogProjectionRow(preset),
      ),
      putTestChats(
        chatIds.map((id) => ({
          ...sessionChat(id),
          settings: {
            ...cloneDefaultChatSettings(),
            systemPrompt: preset.text,
            systemPromptPresetId: preset.id,
          },
        })),
      ),
    ])
    await getDb().configurationLinks.put({
      id: 'failed-staged-stale-link',
      ownerKind: 'chat',
      ownerId: 'zz-failed-staged-missing-chat',
      ownerKey: 'chat:zz-failed-staged-missing-chat',
      targetKind: 'prompt-preset',
      targetId: preset.id,
      targetKey: `prompt-preset:${preset.id}`,
      slot: 'systemPromptPresetId',
    })
    const beforeWorkspace = await readBrowserWorkspaceMeta(getDb())
    const beforeFirstChat = await getDb().chats.get(chatIds[0] ?? '')
    const beforeLastChat = await getDb().chats.get(chatIds.at(-1) ?? '')

    await expect(
      executeBrowserCommandInDatabase(getDb(), beforeWorkspace, {
        kind: 'configuration.execute',
        input: {
          kind: 'prompt-preset.overwrite-and-pin',
          chatId: chatIds[0] ?? '',
          presetId: preset.id,
          text: 'after',
          now: 10,
        },
      }),
    ).rejects.toThrow('ConfigurationLinkOwnerMissing')

    expect(await readBrowserWorkspaceMeta(getDb())).toEqual(beforeWorkspace)
    expect(await getDb().promptPresets.get(preset.id)).toEqual(preset)
    expect(await getDb().chats.get(chatIds[0] ?? '')).toEqual(beforeFirstChat)
    expect(await getDb().chats.get(chatIds.at(-1) ?? '')).toEqual(beforeLastChat)
  })

  it('pages connection reassignment atomically and publishes one identity-only result', async () => {
    const source: ConnectionProfile = {
      id: 'staged-source-profile',
      name: 'Staged source profile',
      kind: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultHeaders: {},
      appTitle: 'natter',
      appUrl: 'http://localhost',
      supportsEndpointsApi: true,
      supportsGenerationApi: true,
      supportsPrivacyScrape: true,
      requestRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    const replacement: ConnectionProfile = {
      ...source,
      id: 'staged-replacement-profile',
      name: 'Staged replacement profile',
    }
    const chatIds = Array.from({ length: 130 }, (_, index) => `staged-profile-chat-${index}`)
    const repository = getBrowserRepository()
    await write(repository, {
      kind: 'configuration.execute',
      input: { kind: 'connection.create', profile: source, now: 1 },
    })
    await write(repository, {
      kind: 'configuration.execute',
      input: { kind: 'connection.create', profile: replacement, now: 1 },
    })
    await putTestChats(
      chatIds.map((id) => ({
        ...sessionChat(id),
        settings: { ...cloneDefaultChatSettings(), profileId: source.id },
      })),
    )
    const workspace = await readBrowserWorkspaceMeta(getDb())

    const execution = await executeBrowserCommandInDatabase(getDb(), workspace, {
      kind: 'configuration.execute',
      input: {
        kind: 'connection.delete',
        profileId: source.id,
        reassignTo: replacement.id,
        now: 10,
      },
    })
    const expectedChatIds = [...chatIds].sort()

    expect(execution.commit.value).toEqual({
      kind: 'connection-deleted',
      profileId: source.id,
      affectedPresetIds: [],
      affectedChatIds: expectedChatIds,
      deletedKeyIds: [],
      fallbackProfileId: replacement.id,
    })
    expect(execution.commit.receipt.chats).toEqual([])
    expect(execution.commit.delta.invalidations).toContainEqual({
      kind: 'chat',
      chatIds: expectedChatIds,
    })
    expect(await getDb().profiles.get(source.id)).toBeUndefined()
    expect(await getDb().chats.get(expectedChatIds.at(-1) ?? '')).toMatchObject({
      settings: { profileId: replacement.id },
      configurationVersion: 1,
    })
  })

  it('publishes exact single and paired setting effects and no effect for replayed no-ops', async () => {
    const repository = getBrowserRepository()
    const setting = {
      kind: 'configuration.execute' as const,
      input: {
        kind: 'global-preference.set' as const,
        key: 'test:exact-setting',
        value: { enabled: true },
        now: 2,
      },
    }

    await expect(write(repository, setting)).resolves.toMatchObject({
      effectScope: 'workspace',
      delta: {
        facts: [],
        invalidations: [{ kind: 'setting', keys: ['test:exact-setting'] }],
      },
    })
    await expect(write(repository, setting)).resolves.toMatchObject({
      effectScope: 'none',
      delta: { facts: [], invalidations: [] },
    })
    await getDb().settings.bulkPut([
      { key: 'global:recent-models', value: ['model-a'] },
      {
        key: 'global:recent-model-recency-v1',
        value: {
          version: 1,
          entries: [{ modelId: 'model-a', usedAt: 3, streamId: 'stream-a' }],
        },
      },
    ])

    const clearRecentModels = {
      kind: 'configuration.execute' as const,
      input: {
        kind: 'recent-model.clear' as const,
        now: 4,
      },
    }
    await expect(write(repository, clearRecentModels)).resolves.toMatchObject({
      effectScope: 'workspace',
      delta: {
        facts: [],
        invalidations: [
          {
            kind: 'setting',
            keys: ['global:recent-model-recency-v1', 'global:recent-models'],
          },
        ],
      },
    })
    await expect(write(repository, clearRecentModels)).resolves.toMatchObject({
      effectScope: 'none',
      delta: {
        facts: [],
        invalidations: [],
      },
    })
  })

  it('publishes exact single-row configuration effects and none for replayed no-ops', async () => {
    const repository = getBrowserRepository()
    const key: KeyRecord = {
      id: 'semantic-key',
      name: 'Semantic key',
      ciphertext: 'ciphertext',
      iv: 'iv',
      salt: 'salt',
      algorithm: 'AES-GCM-256',
      kdf: { name: 'PBKDF2', iterations: 200_000, hash: 'SHA-256' },
      obscuredPreview: '••••',
      materialRevision: 1,
      createdAt: 1,
    }
    await getDb().keys.put(key)

    const touchKey = {
      kind: 'configuration.execute' as const,
      input: { kind: 'key.touch' as const, keyId: key.id, now: 2 },
    }
    await expect(write(repository, touchKey)).resolves.toMatchObject({
      effectScope: 'workspace',
      delta: {
        facts: [],
        invalidations: [{ kind: 'key', keyIds: [key.id], facets: ['usage'] }],
      },
    })
    await expect(write(repository, touchKey)).resolves.toMatchObject({
      effectScope: 'none',
      delta: { facts: [], invalidations: [] },
    })

    const template: SavedTextTemplate = {
      id: 'user:semantic-template',
      name: 'Semantic template',
      config: { ...EMPTY_TEXT_TEMPLATE, template: 'semantic' },
      createdAt: 3,
      updatedAt: 3,
    }
    const createTemplate = {
      kind: 'configuration.execute' as const,
      input: { kind: 'text-template.create' as const, template, now: 3 },
    }
    await expect(write(repository, createTemplate)).resolves.toMatchObject({
      effectScope: 'workspace',
      delta: {
        facts: [],
        invalidations: [{ kind: 'text-template', templateIds: [template.id] }],
      },
    })
    await expect(write(repository, createTemplate)).resolves.toMatchObject({
      effectScope: 'none',
      delta: { facts: [], invalidations: [] },
      value: { kind: 'conflict', reason: 'link-changed' },
    })

    const updateTemplate = {
      kind: 'configuration.execute' as const,
      input: {
        kind: 'text-template.update' as const,
        templateId: template.id,
        patch: { name: 'Renamed template' },
        now: 4,
      },
    }
    await expect(write(repository, updateTemplate)).resolves.toMatchObject({
      effectScope: 'workspace',
      delta: {
        facts: [],
        invalidations: [{ kind: 'text-template', templateIds: [template.id] }],
      },
    })
    await expect(
      write(repository, {
        ...updateTemplate,
        input: { ...updateTemplate.input, now: 5 },
      }),
    ).resolves.toMatchObject({
      effectScope: 'none',
      delta: { facts: [], invalidations: [] },
    })
  })

  it('keeps one commit-delivery wrapper per selected repository target', () => {
    const browser = getBrowserRepository()
    const deliveredBrowser = getWorkspaceRepository()
    expect(deliveredBrowser).not.toBe(browser)
    expect(getWorkspaceRepository()).toBe(deliveredBrowser)
    const override = new Proxy(browser, {})
    __setWorkspaceRepositoryForTests(override)
    const deliveredOverride = getWorkspaceRepository()
    expect(deliveredOverride).not.toBe(override)
    expect(deliveredOverride).not.toBe(deliveredBrowser)
    expect(getWorkspaceRepository()).toBe(deliveredOverride)
    __resetWorkspaceRepositoryForTests()
    const resetBrowser = getWorkspaceRepository()
    expect(resetBrowser).not.toBe(browser)
    expect(resetBrowser).not.toBe(deliveredOverride)
    expect(getWorkspaceRepository()).toBe(resetBrowser)
  })

  it('fences an old browser repository from a replacement workspace session', async () => {
    const publicRepository = getBrowserRepository()
    const oldRepository = __getBrowserWorkspaceSessionRepositoryForTests()
    const oldDatabase = getDb()
    const oldOpen = vi.spyOn(oldDatabase, 'open')

    await restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 2 })
    const replacementRepository = __getBrowserWorkspaceSessionRepositoryForTests()
    await putTestChat(sessionChat('replacement-chat'))
    oldOpen.mockClear()

    expect(getBrowserRepository()).toBe(publicRepository)
    expect(replacementRepository).not.toBe(oldRepository)
    await expect(
      read(oldRepository, { kind: 'chat.get', chatId: 'replacement-chat' }),
    ).rejects.toBeInstanceOf(BrowserWorkspaceSessionClosedError)
    await expect(
      write(oldRepository, {
        kind: 'chat.touch-viewed',
        chatId: 'replacement-chat',
        now: 99,
      }),
    ).rejects.toBeInstanceOf(BrowserWorkspaceSessionClosedError)
    expect(oldOpen).not.toHaveBeenCalled()
    expect(
      (await read(replacementRepository, { kind: 'chat.get', chatId: 'replacement-chat' })).value,
    ).toMatchObject({ lastViewedAt: 1 })
  })

  it('cancels an admitted disposable read and drains it before closing its session', async () => {
    const oldRepository = __getBrowserWorkspaceSessionRepositoryForTests()
    await putTestChat(sessionChat('old-chat'))
    const oldDatabase = getDb()
    const originalGet = oldDatabase.chats.get.bind(oldDatabase.chats)
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let releaseRead: (() => void) | undefined
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    vi.spyOn(oldDatabase.chats, 'get').mockImplementation((async (chatId: string) => {
      markStarted?.()
      await readGate
      return originalGet(chatId)
    }) as typeof oldDatabase.chats.get)

    let readPermit: WorkspaceReadPermit | undefined
    const pendingRead = runWorkspaceRead('repository-query', (permit) => {
      readPermit = permit
      return oldRepository.query(permit, { kind: 'chat.get', chatId: 'old-chat' })
    })
    await started
    let replacementSettled = false
    const replacement = restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 3 }).then(() => {
      replacementSettled = true
    })
    await vi.waitFor(() => {
      expect(readPermit?.signal.aborted).toBe(true)
    })
    expect(replacementSettled).toBe(false)

    releaseRead?.()
    await expect(pendingRead).rejects.toSatisfy(isWorkspaceRuntimeClosedError)
    await replacement
    expect(oldDatabase.isOpen()).toBe(false)
    await expect(
      read(oldRepository, { kind: 'chat.get', chatId: 'old-chat' }),
    ).rejects.toBeInstanceOf(BrowserWorkspaceSessionClosedError)
  })

  it('coalesces shutdown and resumes the public runtime with a fresh session', async () => {
    const publicRepository = getBrowserRepository()
    const oldRepository = __getBrowserWorkspaceSessionRepositoryForTests()
    const oldDatabase = getDb()
    const firstShutdown = shutdownBrowserWorkspace()
    const secondShutdown = shutdownBrowserWorkspace()

    await Promise.all([firstShutdown, secondShutdown])
    expect(oldDatabase.isOpen()).toBe(false)
    expect(() => getDb()).toThrow(BrowserWorkspaceSessionClosedError)
    expect(isExpectedBrowserWorkspaceShutdownError(new BrowserWorkspaceSessionClosedError())).toBe(
      true,
    )
    expect(
      isExpectedBrowserWorkspaceShutdownError(
        Object.assign(new Error('Dexie wrapper'), {
          inner: { cause: new BrowserWorkspaceSessionClosedError() },
        }),
      ),
    ).toBe(true)

    await resumeBrowserWorkspace()
    const replacementDatabase = getDb()
    const replacementRepository = __getBrowserWorkspaceSessionRepositoryForTests()
    expect(replacementDatabase).not.toBe(oldDatabase)
    expect(getBrowserRepository()).toBe(publicRepository)
    expect(replacementRepository).not.toBe(oldRepository)
    await expect(
      read(oldRepository, { kind: 'chat.get', chatId: 'stale-chat' }),
    ).rejects.toBeInstanceOf(BrowserWorkspaceSessionClosedError)
  })

  it('keeps a hidden runtime and its stream active without visibility-driven quiescence', async () => {
    let visibility: DocumentVisibilityState = 'visible'
    const visibilitySpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockImplementation(() => visibility)
    const database = getDb()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let aborted = false
    const generation = runWorkspaceAction('conversation-generation', async (permit) => {
      permit.signal.addEventListener('abort', () => {
        aborted = true
      })
      await gate
    })

    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
    expect(database.isOpen()).toBe(true)
    expect(aborted).toBe(false)

    release()
    await generation
    await Promise.resolve()
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
    expect(getDb()).toBe(database)
    expect(database.isOpen()).toBe(true)
    expect(aborted).toBe(false)

    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
    expect(getDb()).toBe(database)
    visibilitySpy.mockRestore()
  })

  it('opens a quiesced workspace on first demand and admits the operation exactly once', async () => {
    const oldDatabase = getDb()
    await shutdownBrowserWorkspace()
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('QUIESCED')
    expect(oldDatabase.isOpen()).toBe(false)
    let calls = 0

    const admittedWorkspaceId = await runWorkspaceRead('repository-query', (permit) => {
      calls += 1
      return permit.workspaceId
    })

    expect(calls).toBe(1)
    expect(admittedWorkspaceId).toBe(getWorkspaceRuntimeControlSnapshot().workspaceId)
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
    expect(getDb()).not.toBe(oldDatabase)
    expect(getDb().isOpen()).toBe(true)
  })

  it('waits for the owner of a replacement quiesce instead of racing an independent reopen', async () => {
    const snapshot = getWorkspaceRuntimeControlSnapshot()
    const workspaceId = snapshot.workspaceId
    if (!workspaceId) throw new Error('Expected running workspace identity')
    let markQuiesced!: () => void
    const quiesced = new Promise<void>((resolve) => {
      markQuiesced = resolve
    })
    let releaseReplacement!: () => void
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve
    })
    const replacement = (async () => {
      const authority = launchImportExportWorkspaceRuntimeReplacementNow()
      if (!authority) throw new Error('Expected replacement authority')
      await awaitWorkspaceRuntimeQuiesced()
      markQuiesced()
      await replacementGate
      await openBrowserWorkspace()
    })()
    await quiesced
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('QUIESCED')
    let calls = 0

    const waitingRead = runWorkspaceRead('repository-query', (permit) => {
      calls += 1
      return permit.workspaceId
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toBe(0)
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('QUIESCED')
    releaseReplacement()
    await replacement
    await expect(waitingRead).resolves.toBe(workspaceId)
    expect(calls).toBe(1)
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
  })

  it('admits a required replacement through the stable capability while another owner quiesces', async () => {
    let markQuiesced!: () => void
    const quiesced = new Promise<void>((resolve) => {
      markQuiesced = resolve
    })
    let releaseReplacement!: () => void
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve
    })
    const owner = (async () => {
      const authority = launchImportExportWorkspaceRuntimeReplacementNow()
      if (!authority) throw new Error('Expected replacement authority')
      await awaitWorkspaceRuntimeQuiesced()
      markQuiesced()
      await replacementGate
      await openBrowserWorkspace()
    })()
    await quiesced
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('QUIESCED')

    let settled = false
    const restoring = restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 4 }).then((result) => {
      settled = true
      return result
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    releaseReplacement()
    await owner
    await expect(restoring).resolves.toMatchObject({ chatCount: 0 })
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
  })

  it('starts replacement selection outside an ambient Dexie transaction', async () => {
    const db = getDb()
    let replacement: Promise<unknown> | undefined
    let observed: unknown

    await db.transaction('r', db.settings, () => {
      expect(Dexie.currentTransaction).not.toBeNull()
      replacement = runBrowserWorkspaceReplacement(
        () => {
          observed = Dexie.currentTransaction
          return false
        },
        async () => {
          throw new Error('Skipped replacement operation ran')
        },
      )
      void replacement.catch(() => undefined)
    })

    await expect(replacement).rejects.toThrow('BrowserWorkspaceReplacementPreflightSkipped')
    expect(observed).toBeNull()
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
  })

  it('claims an abandoned preparing journal before admitting the next required replacement', async () => {
    const abandoned = await beginBrowserWorkspaceDatabaseReplacement()
    const abandonedManifest = await readBrowserWorkspaceDatabaseManifest()
    const before = getWorkspaceRuntimeControlSnapshot()
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: async <T>(
          _name: string,
          options: { mode: 'shared' | 'exclusive'; ifAvailable?: boolean },
          operation: (lock: Lock | null) => Promise<T> | T,
        ) => operation({ mode: options.mode } as Lock),
      },
    })
    try {
      await expect(restoreWorkspaceBackup(emptyWorkspaceBackup, { now: 5 })).resolves.toMatchObject(
        {
          chatCount: 0,
        },
      )

      const manifest = await readBrowserWorkspaceDatabaseManifest()
      expect(manifest.pending?.nonce).not.toBe(abandoned.nonce)
      expect(manifest.activeDatabaseName).toBe(abandoned.destinationDatabaseName)
      expect(manifest.activationSequence).toBe(abandonedManifest.activationSequence + 1)
      expect(getWorkspaceRuntimeControlSnapshot()).toMatchObject({
        state: 'RUNNING',
        workspaceId: before.workspaceId,
        replacementEpoch: before.replacementEpoch + 1,
      })
      await cleanPendingBrowserWorkspaceDatabase()
    } finally {
      if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  })

  it('carries caller cancellation through a replacement handoff', async () => {
    const chat = sessionChat('replacement-cancellation-chat')
    await putTestChat(chat)
    const before = getWorkspaceRuntimeControlSnapshot()
    const controller = new AbortController()
    const reason = new Error('idle-replacement-caller-cancelled')
    const continuedWithoutCancellation = new Error('replacement-signal-detached')
    let markEntered!: () => void
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const replacement = runBrowserWorkspaceReplacement(
      () => true,
      async (_database, context) => {
        markEntered()
        await gate
        if (!context.signal.aborted) throw new Error('replacement-signal-not-aborted')
        throw continuedWithoutCancellation
      },
      { signal: controller.signal },
    )
    await entered

    controller.abort(reason)
    release()

    await expect(replacement).rejects.toBe(reason)
    expect(getWorkspaceRuntimeControlSnapshot()).toMatchObject({
      state: 'RUNNING',
      workspaceId: before.workspaceId,
      replacementEpoch: before.replacementEpoch,
    })
    await expect(
      read(getBrowserRepository(), { kind: 'chat.get', chatId: chat.id }),
    ).resolves.toMatchObject({
      value: { id: chat.id },
    })
  })

  it('cancels a required replacement while it waits for the selection gate', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    let markQueued!: () => void
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve
    })
    const request = vi.fn(
      (
        _name: string,
        options: LockOptions,
        _callback: (lock: Lock | null) => unknown,
      ): Promise<never> => {
        const signal = options.signal
        if (!signal) throw new Error('Expected selection-gate cancellation signal')
        markQueued()
        return new Promise<never>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason)
            return
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    )
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    const controller = new AbortController()
    const reason = new Error('queued-required-replacement-cancelled')
    const preflight = vi.fn(() => true)
    const operation = vi.fn()

    try {
      const replacement = runBrowserWorkspaceReplacement(preflight, operation, {
        signal: controller.signal,
      })
      await queued
      controller.abort(reason)

      await expect(replacement).rejects.toBe(reason)
      expect(preflight).not.toHaveBeenCalled()
      expect(operation).not.toHaveBeenCalled()
      expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
    } finally {
      if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  })

  it('cancels an if-idle replacement while its producer owns the queued selection', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    let markQueued!: () => void
    const queued = new Promise<void>((resolve) => {
      markQueued = resolve
    })
    const request = vi.fn(
      (
        _name: string,
        _options: LockOptions,
        _callback: (lock: Lock | null) => unknown,
      ): Promise<never> => {
        markQueued()
        return new Promise<never>(() => undefined)
      },
    )
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    const controller = new AbortController()
    const reason = new Error('queued-if-idle-replacement-cancelled')
    const preflight = vi.fn(() => true)
    const operation = vi.fn()

    try {
      const replacement = tryStartBrowserWorkspaceReplacementIfIdle(preflight, operation, {
        signal: controller.signal,
      })
      await queued
      controller.abort(reason)

      await expect(replacement).rejects.toBe(reason)
      expect(preflight).not.toHaveBeenCalled()
      expect(operation).not.toHaveBeenCalled()
      expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')
    } finally {
      if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  })

  it('lets a graceful peer quiesce wait for generation idle without aborting it', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let aborted = false
    const generation = runWorkspaceAction('conversation-generation', async (permit) => {
      permit.signal.addEventListener('abort', () => {
        aborted = true
      })
      await gate
    })
    let quiesced = false
    const graceful = shutdownBrowserWorkspaceWhenIdle().then(() => {
      quiesced = true
    })

    await Promise.resolve()
    expect(quiesced).toBe(false)
    expect(aborted).toBe(false)
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('RUNNING')

    release()
    await generation
    await graceful
    expect(aborted).toBe(false)
    expect(getWorkspaceRuntimeControlSnapshot().state).toBe('QUIESCED')
    await resumeBrowserWorkspace()
  })

  it('routes transcript pages through the one branch.page-structure protocol query', async () => {
    const result = {
      kind: 'stale-path' as const,
      chatId: 'delegated-chat',
      reason: 'structural-version-mismatch' as const,
    }
    const query = vi.fn(async (_permit: unknown, _query: unknown, _options?: unknown) => ({
      workspaceId: 'workspace',
      replacementEpoch: 1,
      value: result,
    }))
    const repository = {
      query,
      execute: vi.fn(),
      replace: vi.fn(),
      subscribeChanges: vi.fn(() => () => undefined),
    } as unknown as WorkspaceRepository
    const adapter = createConversationRepositoryAdapter({
      repository,
      controller: {} as ConversationController,
    })
    const window = {
      branchLength: 0,
      offset: 0,
      limit: 1,
      boundaryParentId: null,
      nodes: [],
    }
    const material = createWorkspaceMessageMaterialCoordinator({
      workspaceId: 'workspace',
      replacementEpoch: 1,
    })

    try {
      await expect(
        adapter.projectionSource.loadTranscriptPage(
          'delegated-chat',
          'delegated-leaf',
          0,
          window,
          material,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ value: { kind: 'stale-selection', material: [] } })
    } finally {
      material.release()
    }
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[1]).toEqual({
      kind: 'branch.page-structure',
      chatId: 'delegated-chat',
      resolvedTipId: 'delegated-leaf',
      structuralVersion: 0,
      window,
    })
  })
})

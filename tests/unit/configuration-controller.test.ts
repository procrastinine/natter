import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneDefaultChatSettings } from '../../src/core/defaults'
import {
  DEFAULT_GLOBAL_PREFERENCES,
  PINNED_MODELS_KEY,
  SIDEBAR_COLLAPSED_KEY,
} from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import {
  DEFAULT_SIDEBAR_SORT_MODE,
  SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
  SIDEBAR_SORT_SETTING_KEY,
} from '../../src/core/sidebar-sort'
import type {
  Chat,
  ChatSettings,
  ConfigurationRequestRevision,
  ConnectionProfile,
  TextTemplateConfig,
} from '../../src/core/types'
import { PersistentStringMap } from '../../src/lib/persistent-string-map'
import {
  type ActiveGenerationConfigurationResolution,
  type ConfigurationProjectionSource,
  configurationController,
} from '../../src/store/configuration-controller'
import {
  type ConfigurationApplicationDependencies,
  createConfigurationApplication,
} from '../../src/store/configuration-domain'
import type {
  ConfigurationDomainCommand,
  ConfigurationDomainExecutionOptions,
  ConfigurationDomainPort,
  ConfigurationDomainResult,
} from '../../src/store/configuration-domain-contract'
import { buildConnectionProfile } from '../../src/store/configuration-domain-contract'
import type { ConversationSnapshot } from '../../src/store/conversation-controller'
import { prepareLocalWorkspaceChange } from '../../src/store/workspace-effect-hub'
import type {
  ConfigurationActiveSelectionProjection,
  ConfigurationSelectionQueryTarget,
  ConfigurationShellProjection,
  WorkspaceDependency,
} from '../../src/store/workspace-protocol'

let epoch = 0

beforeEach(async () => {
  await configurationController.setProjectionSource(null)
  configurationController.reconcileWorkspace({
    workspaceId: 'configuration-controller-publication',
    replacementEpoch: ++epoch,
  })
  configurationController.rememberSeed({ profileId: null, presetId: null, settings: null })
})

afterEach(async () => {
  await configurationController.setProjectionSource(null)
  vi.restoreAllMocks()
})

describe('configuration controller publication', () => {
  it('cannot lose a publication between observation and subscription', async () => {
    const observed = configurationController.getSnapshot()
    configurationController.setSidebarCollapsed(!observed.ui.sidebarCollapsed)

    await configurationController.waitForSnapshotChange(observed)

    expect(configurationController.getSnapshot()).not.toBe(observed)
  })

  it('resolves once for a publication that follows subscription', async () => {
    const observed = configurationController.getSnapshot()
    const changed = configurationController.waitForSnapshotChange(observed)

    configurationController.setSidebarCollapsed(!observed.ui.sidebarCollapsed)

    await changed
    expect(configurationController.getSnapshot()).not.toBe(observed)
  })

  it('releases a pending publication listener when its owner is cancelled', async () => {
    const observed = configurationController.getSnapshot()
    const controller = new AbortController()
    const changed = configurationController.waitForSnapshotChange(observed, controller.signal)

    controller.abort()

    await changed
    expect(configurationController.getSnapshot()).toBe(observed)
  })

  it('accepts rendering preferences into the canonical shell before releasing the intent', async () => {
    await configurationController.setProjectionSource(projectionSource())
    const staged = configurationController.stageRenderingPreferences({
      singleDollarTextMath: true,
    })

    expect(
      configurationController.getSnapshot().frame.shell?.preferences.rendering.singleDollarTextMath,
    ).toBe(true)

    configurationController.acknowledgePendingConfiguration(null, {
      promptFields: [],
      workspaceSettings: [
        {
          key: staged.key,
          revision: staged.revision,
          accepted: { value: staged.value },
        },
      ],
    })

    expect(configurationController.pendingWorkspaceSetting(staged.key)).toBeUndefined()
    expect(
      configurationController.getSnapshot().frame.shell?.preferences.rendering.singleDollarTextMath,
    ).toBe(true)
  })

  it('rolls a rejected rendering preference back to the canonical shell', async () => {
    await configurationController.setProjectionSource(projectionSource())
    const staged = configurationController.stageRenderingPreferences({
      singleDollarTextMath: true,
    })

    configurationController.rejectPendingConfiguration(null, {
      promptFields: [],
      workspaceSettings: [{ key: staged.key, revision: staged.revision }],
    })

    expect(configurationController.pendingWorkspaceSetting(staged.key)).toBeUndefined()
    expect(
      configurationController.getSnapshot().frame.shell?.preferences.rendering.singleDollarTextMath,
    ).toBe(false)
  })

  it('accepts the sidebar sort projection before releasing its command intent', async () => {
    await configurationController.setProjectionSource(projectionSource())
    const staged = configurationController.stageWorkspaceSetting(
      SIDEBAR_SORT_SETTING_KEY,
      'title-asc',
    )

    expect(configurationController.getSnapshot().frame.shell?.preferences.sidebarSortMode).toBe(
      'title-asc',
    )
    configurationController.acknowledgePendingConfiguration(null, {
      promptFields: [],
      workspaceSettings: [
        {
          key: staged.key,
          revision: staged.revision,
          accepted: { value: staged.value },
        },
      ],
    })

    expect(configurationController.pendingWorkspaceSetting(staged.key)).toBeUndefined()
    expect(configurationController.getSnapshot().frame.shell?.preferences.sidebarSortMode).toBe(
      'title-asc',
    )
  })

  it('rolls a rejected folder-collapse projection back without retaining an overlay', async () => {
    await configurationController.setProjectionSource(projectionSource())
    const staged = configurationController.stageSidebarFolderCollapsed('folder-a', true)

    expect(
      configurationController.getSnapshot().frame.shell?.preferences.collapsedFolderIds,
    ).toEqual(['folder-a'])
    configurationController.rejectPendingConfiguration(null, {
      promptFields: [],
      workspaceSettings: [
        {
          key: SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
          revision: staged.revision,
        },
      ],
    })

    expect(configurationController.pendingWorkspaceSetting(staged.key)).toBeUndefined()
    expect(
      configurationController.getSnapshot().frame.shell?.preferences.collapsedFolderIds,
    ).toEqual([])
  })

  it('folds a local setting commit into an older resident read and reloads only for a later effect', async () => {
    const staleShell = deferred<ConfigurationShellProjection>()
    const loadShell = vi
      .fn<ConfigurationProjectionSource['loadShell']>()
      .mockImplementationOnce(() => staleShell.promise)
      .mockImplementationOnce(async () => shell(1))
    const bound = configurationController.setProjectionSource(projectionSource({ loadShell }))
    await settle()
    const result = {
      kind: 'workspace-setting-saved',
      key: SIDEBAR_COLLAPSED_KEY,
      value: true,
      changed: true,
    } as const
    let disposition: 'applied' | 'inactive' | undefined
    const port: ConfigurationDomainPort = {
      async execute<Command extends ConfigurationDomainCommand>(
        _command: Command,
        options?: ConfigurationDomainExecutionOptions<ConfigurationDomainResult<Command['kind']>>,
      ): Promise<ConfigurationDomainResult<Command['kind']>> {
        const committed = result as ConfigurationDomainResult<Command['kind']>
        disposition = options?.localApplication(committed)
        return committed
      },
    }
    const application = createConfigurationApplication({
      port,
      async prepareKey() {
        throw new Error('UnexpectedKeyPreparation')
      },
      async loadProfileSwitchPlan() {
        return undefined
      },
      pendingConfiguration: configurationController,
    })

    await application.execute({
      kind: 'global-preference.set',
      key: SIDEBAR_COLLAPSED_KEY,
      value: true,
      now: 1,
    })
    expect(disposition).toBe('applied')
    expect(loadShell).toHaveBeenCalledTimes(1)

    staleShell.resolve(shell(1))
    await bound
    expect(
      configurationController.getSnapshot().frame.shell?.preferences.global.sidebarCollapsed,
    ).toBe(true)
    expect(loadShell).toHaveBeenCalledTimes(1)

    configurationController.observeWorkspaceEffect(
      prepareLocalWorkspaceChange({
        kind: 'invalidate',
        workspaceId: 'configuration-controller-publication',
        replacementEpoch: epoch,
        dependencies: [{ kind: 'setting', keys: [SIDEBAR_COLLAPSED_KEY] }],
      }).effect,
    )
    await waitForController(
      () =>
        configurationController.getSnapshot().frame.shell?.preferences.global.sidebarCollapsed ===
        false,
    )

    expect(loadShell).toHaveBeenCalledTimes(2)
    expect(
      configurationController.getSnapshot().frame.shell?.preferences.global.sidebarCollapsed,
    ).toBe(false)
  })

  it('seeds only untouched UI fields after an earlier tab intent', async () => {
    const staleShell = deferred<ConfigurationShellProjection>()
    const stored = shell(1)
    Object.assign(stored.preferences.global, {
      sidebarCollapsed: false,
      composerHeight: 500,
      composerNormalManualHeight: 230,
      composerFocusManualHeight: 330,
    })
    configurationController.setSidebarCollapsed(true)
    configurationController.setComposerHeight('fixed', 222)
    configurationController.reconcileWorkspace({
      workspaceId: 'configuration-controller-pre-seed-intent',
      replacementEpoch: ++epoch,
    })
    const bound = configurationController.setProjectionSource(
      projectionSource({ loadShell: vi.fn(() => staleShell.promise) }),
    )
    await settle()

    staleShell.resolve(stored)
    await bound

    expect(configurationController.getSnapshot().ui).toEqual({
      sidebarCollapsed: true,
      composerHeight: 222,
      composerNormalManualHeight: 230,
      composerFocusManualHeight: 330,
    })
  })

  it.each([
    {
      command: {
        kind: 'sidebar-preference.set-sort',
        mode: 'title-asc',
        now: 1,
      } as const,
      result: {
        kind: 'workspace-setting-saved',
        key: SIDEBAR_SORT_SETTING_KEY,
        value: 'title-asc',
      } as const,
      projected: () =>
        configurationController.getSnapshot().frame.shell?.preferences.sidebarSortMode,
      expected: 'title-asc',
    },
    {
      command: {
        kind: 'sidebar-preference.set-folder-collapsed',
        folderId: 'folder-a',
        collapsed: true,
        now: 1,
      } as const,
      result: {
        kind: 'workspace-setting-saved',
        key: SIDEBAR_COLLAPSED_FOLDERS_SETTING_KEY,
        value: ['folder-a'],
      } as const,
      projected: () =>
        configurationController.getSnapshot().frame.shell?.preferences.collapsedFolderIds,
      expected: ['folder-a'],
    },
  ])('stages $command.kind through the standard application command path', async (proof) => {
    await configurationController.setProjectionSource(projectionSource())
    const completion = deferred<never>()
    const port: ConfigurationDomainPort = {
      execute: vi.fn(() => completion.promise),
    }
    const dependencies: ConfigurationApplicationDependencies = {
      port,
      async prepareKey() {
        throw new Error('UnexpectedKeyPreparation')
      },
      async loadProfileSwitchPlan() {
        return undefined
      },
      pendingConfiguration: configurationController,
    }
    const application = createConfigurationApplication(dependencies)

    const operation = application.execute(proof.command)
    expect(port.execute).toHaveBeenCalledTimes(1)
    expect(proof.projected()).toEqual(proof.expected)
    completion.resolve(proof.result as never)
    await operation

    expect(port.execute).toHaveBeenCalledTimes(1)
    expect(proof.projected()).toEqual(proof.expected)
    expect(configurationController.pendingWorkspaceSetting(proof.result.key)).toBeUndefined()
  })

  it('submits a relative setting command exactly once while its result is pending', async () => {
    const completion = deferred<never>()
    const execute = vi.fn(() => completion.promise)
    const application = createConfigurationApplication({
      port: { execute: execute },
      async prepareKey() {
        throw new Error('UnexpectedKeyPreparation')
      },
      async loadProfileSwitchPlan() {
        return undefined
      },
    })
    const command = {
      kind: 'pinned-model.move',
      modelId: 'model-b',
      delta: -1,
      now: 1,
    } as const

    const operation = application.execute(command)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(command, undefined)
    completion.resolve({
      kind: 'workspace-setting-saved',
      key: PINNED_MODELS_KEY,
      value: ['model-b', 'model-a'],
      changed: true,
    } as never)

    await expect(operation).resolves.toMatchObject({
      kind: 'workspace-setting-saved',
      key: PINNED_MODELS_KEY,
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('profile switch admission', () => {
  it('rebases once and returns an explicit conflict when both exact attempts lose', async () => {
    const profile = profileFixture('profile-switch-target')
    const firstPlan = {
      chat: chatFixture('profile-switch-chat', settingsFixture(profile)),
      profile: { kind: profile.kind, baseUrl: profile.baseUrl },
      target: requestRevision(profile.id),
      requestKeyId: null,
    }
    const secondPlan = {
      ...firstPlan,
      chat: {
        ...firstPlan.chat,
        configurationVersion: 7,
      },
      target: {
        ...firstPlan.target,
        requestRevision: 2,
      },
    }
    const execute = vi.fn(() =>
      Promise.resolve({
        kind: 'conflict',
        reason: 'configuration-version',
        currentVersion: 2,
      } as never),
    )
    const loadProfileSwitchPlan = vi
      .fn()
      .mockResolvedValueOnce(firstPlan)
      .mockResolvedValueOnce(secondPlan)
    const application = createConfigurationApplication({
      port: { execute: execute },
      async prepareKey() {
        throw new Error('UnexpectedKeyPreparation')
      },
      loadProfileSwitchPlan,
    })

    await expect(
      application.switchChatProfile({
        chatId: firstPlan.chat.id,
        profileId: profile.id,
        now: 10,
      }),
    ).resolves.toEqual({
      kind: 'conflict',
      reason: 'configuration-version',
      currentVersion: 2,
    })
    expect(loadProfileSwitchPlan).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: 'chat.switch-profile',
        expectedConfigurationVersion: 0,
        target: firstPlan.target,
      }),
    )
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: 'chat.switch-profile',
        expectedConfigurationVersion: 7,
        target: secondPlan.target,
      }),
    )
  })
})

describe('sealed target-qualified generation configuration', () => {
  it.each([
    'selection-first',
    'shell-first',
  ] as const)('publishes connection absence only after the exact selection and shell settle: %s', async (order) => {
    const settings = cloneDefaultChatSettings()
    const shellRead = deferred<ConfigurationShellProjection>()
    const selectionRead = deferred<ConfigurationActiveSelectionProjection>()
    configurationController.rememberSeed({ profileId: null, presetId: null, settings })
    const source = projectionSource({
      loadShell: vi.fn(() => shellRead.promise),
      loadActiveSelection: vi.fn(() => selectionRead.promise),
    })
    const bound = configurationController.setProjectionSource(source)
    await settle()

    expect(resolveNewChat()).toEqual({ capability: 'pending' })

    if (order === 'selection-first') {
      selectionRead.resolve(emptySelection())
      await waitForSelectionStatus('ready')
      expect(resolveNewChat()).toEqual({ capability: 'pending' })
      shellRead.resolve(shell(0))
      await bound
    } else {
      shellRead.resolve(shell(0))
      await bound
      expect(resolveNewChat()).toEqual({ capability: 'pending' })
      selectionRead.resolve(emptySelection())
      await waitForSelectionStatus('ready')
    }

    expect(resolveNewChat()).toEqual({ capability: 'connection-missing' })
  })

  it('does not publish absence from a superseded selection settlement', async () => {
    const selectionA = deferred<ConfigurationActiveSelectionProjection>()
    const selectionB = deferred<ConfigurationActiveSelectionProjection>()
    const settingsA = cloneDefaultChatSettings()
    settingsA.profileId = 'missing-A'
    const settingsB = cloneDefaultChatSettings()
    settingsB.profileId = 'missing-B'
    configurationController.rememberSeed({
      profileId: settingsA.profileId,
      presetId: null,
      settings: settingsA,
    })
    await configurationController.setProjectionSource(
      projectionSource({
        loadShell: vi.fn(async () => shell(0)),
        loadActiveSelection: vi.fn((target: ConfigurationSelectionQueryTarget) =>
          target.profileId === settingsA.profileId ? selectionA.promise : selectionB.promise,
        ),
      }),
    )
    configurationController.rememberSeed({
      profileId: settingsB.profileId,
      presetId: null,
      settings: settingsB,
    })
    await settle()

    selectionA.resolve(emptySelection())
    await settle()
    expect(configurationController.getSnapshot().frame.target).toMatchObject({
      kind: 'new-chat',
      profileId: 'missing-B',
    })
    expect(resolveNewChat()).toEqual({ capability: 'pending' })

    selectionB.resolve(emptySelection())
    await waitForSelectionStatus('ready')
    expect(resolveNewChat()).toEqual({ capability: 'connection-missing' })
  })

  it('authorizes only the exact new-chat, chat-A, or chat-B target', async () => {
    const profile = profileFixture('profile-targets')
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    await installSource(selectionFixture(profile))

    expect(resolveNewChat().capability).toBe('ready')
    expect(resolveChat('chat-A')).toEqual({ capability: 'pending' })
    expect(resolveChat('chat-B')).toEqual({ capability: 'pending' })

    observeChat(chatFixture('chat-A', settings))
    await waitForExactChatSelection('chat-A')
    expect(resolveNewChat()).toEqual({ capability: 'pending' })
    expect(resolveChat('chat-A').capability).toBe('ready')
    expect(resolveChat('chat-B')).toEqual({ capability: 'pending' })

    observeChat(chatFixture('chat-B', settings))
    await waitForExactChatSelection('chat-B')
    expect(resolveNewChat()).toEqual({ capability: 'pending' })
    expect(resolveChat('chat-A')).toEqual({ capability: 'pending' })
    expect(resolveChat('chat-B').capability).toBe('ready')
  })

  it('keeps a selected chat configuration claim exact and route-independent', async () => {
    const profile = profileFixture('profile-selected-route')
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    await installSource(selectionFixture(profile))
    observeChat(chatFixture('chat-A', settings))
    await waitForExactChatSelection('chat-A')

    const claim = configurationController.claimSelectedGenerationConfiguration('chat-A')
    observeChat(chatFixture('chat-B', settings))
    await waitForExactChatSelection('chat-B')

    expect(configurationController.resolveSelectedGenerationConfiguration(claim)).toMatchObject({
      capability: 'ready',
      kind: 'chat',
      chatId: 'chat-A',
      configurationVersion: 0,
    })
    configurationController.cancelSelectedGenerationConfiguration(claim)
  })

  it('keeps optimistic chat settings generation-pending until their durable version is known', async () => {
    const profile = profileFixture('profile-selected-pending')
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    await installSource(selectionFixture(profile))
    observeChat(chatFixture('chat-A', settings))
    await waitForExactChatSelection('chat-A')
    const [intent] = configurationController.stageChatSettingsFields('chat-A', [
      { path: ['textTemplate'], value: 'raw' },
    ])
    if (!intent) throw new Error('SelectedConfigurationIntentMissing')

    expect(resolveChat('chat-A')).toEqual({ capability: 'pending' })
    const claim = configurationController.claimSelectedGenerationConfiguration('chat-A')
    expect(configurationController.resolveSelectedGenerationConfiguration(claim)).toEqual({
      capability: 'pending',
    })

    configurationController.acknowledgePendingConfiguration('chat-A', {
      promptFields: [],
      chatSettingsFields: [{ fieldKey: intent.fieldKey, revision: intent.revision }],
      acceptedChatConfigurationVersion: 1,
    })

    await vi.waitFor(() => {
      expect(configurationController.resolveSelectedGenerationConfiguration(claim)).toMatchObject({
        capability: 'ready',
        kind: 'chat',
        chatId: 'chat-A',
        configurationVersion: 1,
        claim: { settings: { textTemplate: 'raw' } },
      })
    })
    configurationController.cancelSelectedGenerationConfiguration(claim)
  })

  it('fails a selected configuration claim when its exact optimistic command is rejected', async () => {
    const profile = profileFixture('profile-selected-rejected')
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    await installSource(selectionFixture(profile))
    observeChat(chatFixture('chat-A', settings))
    await waitForExactChatSelection('chat-A')
    const [intent] = configurationController.stageChatSettingsFields('chat-A', [
      { path: ['textTemplate'], value: 'raw' },
    ])
    if (!intent) throw new Error('SelectedConfigurationIntentMissing')
    const claim = configurationController.claimSelectedGenerationConfiguration('chat-A')

    configurationController.rejectPendingConfiguration('chat-A', {
      promptFields: [],
      chatSettingsFields: [{ fieldKey: intent.fieldKey, revision: intent.revision }],
    })

    expect(configurationController.resolveSelectedGenerationConfiguration(claim)).toEqual({
      capability: 'failed',
    })
    configurationController.cancelSelectedGenerationConfiguration(claim)
  })

  it('reuses an exact resolution by identity and seals every nested claim value', async () => {
    const profile = profileFixture('profile-immutable')
    profile.defaultHeaders['X-Proof'] = 'original'
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    await installSource(selectionFixture(profile))

    const first = resolveNewChat()
    const second = resolveNewChat()
    expect(first).toBe(second)
    expect(first.capability).toBe('ready')
    if (first.capability !== 'ready') throw new Error('ExpectedReadyConfigurationProof')
    expectDeepFrozen(first)

    profile.defaultHeaders['X-Proof'] = 'mutated'
    settings.model = 'mutated/model'
    expect(first.claim.settings.model).toBe('vendor/model')
    expect(first.claim.profile.defaultHeaders).toEqual({ 'x-proof': 'original' })
  })

  it('retains proof and resolution identity across unrelated UI and inactive-chat changes', async () => {
    const profile = profileFixture('profile-retention')
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    await installSource(selectionFixture(profile))
    observeChat(chatFixture('chat-A', settings))
    await waitForExactChatSelection('chat-A')

    const frame = configurationController.getSnapshot().frame.generation
    const resolution = frame.resolve({ kind: 'chat', chatId: 'chat-A' })
    configurationController.setSidebarCollapsed(
      !configurationController.getSnapshot().ui.sidebarCollapsed,
    )
    expect(configurationController.getSnapshot().frame.generation).toBe(frame)
    expect(resolveChat('chat-A')).toBe(resolution)

    configurationController.stagePromptField('chat-B', 'system', 'inactive prompt')
    expect(configurationController.getSnapshot().frame.generation).toBe(frame)
    expect(resolveChat('chat-A')).toBe(resolution)
  })

  it('reloads a settled selection only for one of its exact dispatch keys', async () => {
    const profile = profileFixture('profile-key-dependency')
    profile.apiKeyRef = 'active-key'
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    const loadActiveSelection = vi.fn(async () =>
      selectionFixture(profile, {
        dispatchKeyRevisions: [{ keyId: 'active-key', materialRevision: 1 }],
      }),
    )
    await configurationController.setProjectionSource(projectionSource({ loadActiveSelection }))
    await waitForSelectionStatus('ready')
    const settledCalls = loadActiveSelection.mock.calls.length

    publishWorkspaceEffect([
      { kind: 'key', keyIds: ['unrelated-key'], facets: ['request-material'] },
    ])
    await settle()
    expect(loadActiveSelection).toHaveBeenCalledTimes(settledCalls)

    publishWorkspaceEffect([{ kind: 'key', keyIds: ['active-key'], facets: ['request-material'] }])
    await waitForController(() => loadActiveSelection.mock.calls.length === settledCalls + 1)
  })

  it('uses a broad key fence only while the active selection is unresolved', async () => {
    const profile = profileFixture('profile-key-pending')
    profile.apiKeyRef = 'pending-key'
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    let first = true
    const loadActiveSelection = vi.fn(
      (_target: ConfigurationSelectionQueryTarget, signal: AbortSignal) => {
        if (!first) {
          return Promise.resolve(
            selectionFixture(profile, {
              dispatchKeyRevisions: [{ keyId: 'pending-key', materialRevision: 1 }],
            }),
          )
        }
        first = false
        return new Promise<ConfigurationActiveSelectionProjection>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    )
    await configurationController.setProjectionSource(projectionSource({ loadActiveSelection }))
    await waitForController(() => loadActiveSelection.mock.calls.length === 1)

    publishWorkspaceEffect([{ kind: 'key', keyIds: ['any-key'], facets: ['request-material'] }])

    await waitForController(() => loadActiveSelection.mock.calls.length === 2)
    await waitForSelectionStatus('ready')
  })

  it.each([
    {
      name: 'selected profile does not match the target settings',
      expected: 'configuration-missing',
      arrange(_profile: ConnectionProfile, settings: ChatSettings) {
        const other = profileFixture('profile-other')
        return { settings, selection: selectionFixture(other) }
      },
    },
    {
      name: 'request revision does not prove the selected profile',
      expected: 'failed',
      arrange(profile: ConnectionProfile, settings: ChatSettings) {
        return {
          settings,
          selection: selectionFixture(profile, {
            requestRevision: requestRevision('profile-other'),
          }),
        }
      },
    },
    {
      name: 'dispatch-key revisions do not match the dispatch profile',
      expected: 'failed',
      arrange(profile: ConnectionProfile, settings: ChatSettings) {
        return {
          settings,
          selection: selectionFixture(profile, {
            dispatchKeyRevisions: [{ keyId: 'unexpected-key', materialRevision: 1 }],
          }),
        }
      },
    },
    {
      name: 'selected saved template does not match the target template',
      expected: 'configuration-missing',
      arrange(profile: ConnectionProfile, settings: ChatSettings) {
        settings.textTemplate = 'saved-target'
        return {
          settings,
          selection: selectionFixture(profile, {
            textTemplate: { templateId: 'saved-other', config: textTemplate('other') },
          }),
        }
      },
    },
  ])('classifies $name as $expected', async ({ arrange, expected }) => {
    const profile = profileFixture('profile-matrix')
    const arranged = arrange(profile, settingsFixture(profile))
    configurationController.rememberSeed({
      profileId: arranged.settings.profileId || null,
      presetId: null,
      settings: arranged.settings,
    })
    await installSource(arranged.selection)

    expect(resolveNewChat()).toEqual({ capability: expected })
  })

  it('classifies an exact selection read failure as failed', async () => {
    const profile = profileFixture('profile-failure')
    const settings = settingsFixture(profile)
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    const source = projectionSource({
      loadActiveSelection: vi.fn(async () => {
        throw new Error('SelectionReadFailed')
      }),
    })
    await configurationController.setProjectionSource(source)
    await waitForSelectionStatus('error')

    expect(resolveNewChat()).toEqual({ capability: 'failed' })
  })

  it('looks up one pending saved template without iterating the pending-template map', async () => {
    const profile = profileFixture('profile-template')
    const settings = settingsFixture(profile)
    settings.textTemplate = 'saved-target'
    configurationController.rememberSeed({ profileId: profile.id, presetId: null, settings })
    await installSource(selectionFixture(profile))

    for (let index = 0; index < 1_024; index += 1) {
      configurationController.stageTextTemplateConfig(
        `unrelated-${index.toString().padStart(4, '0')}`,
        textTemplate(`unrelated-${index}`),
      )
    }
    const iteration = vi.spyOn(PersistentStringMap.prototype, 'entries')
    configurationController.stageTextTemplateConfig('saved-target', textTemplate('selected'))

    expect(iteration).not.toHaveBeenCalled()
    const resolution = resolveNewChat()
    expect(resolution.capability).toBe('ready')
    if (resolution.capability !== 'ready') throw new Error('ExpectedReadyTemplateProof')
    expect(resolution.claim.savedTextTemplate).toEqual({
      templateId: 'saved-target',
      config: textTemplate('selected'),
    })
  })
})

function resolveNewChat(): ActiveGenerationConfigurationResolution {
  return configurationController.getSnapshot().frame.generation.resolve({ kind: 'new-chat' })
}

function resolveChat(chatId: string): ActiveGenerationConfigurationResolution {
  return configurationController.getSnapshot().frame.generation.resolve({ kind: 'chat', chatId })
}

async function installSource(selection: ConfigurationActiveSelectionProjection): Promise<void> {
  await configurationController.setProjectionSource(
    projectionSource({ loadActiveSelection: vi.fn(async () => selection) }),
  )
  await waitForSelectionStatus('ready')
}

function projectionSource(
  overrides: Partial<ConfigurationProjectionSource> = {},
): ConfigurationProjectionSource {
  return {
    loadShell: vi.fn(async () => shell(1)),
    loadGlobalTokenCalibration: vi.fn<ConfigurationProjectionSource['loadGlobalTokenCalibration']>(
      async (_signal) => ({
        version: 1,
        updatedAt: 0,
        byModel: {},
        clearGeneration: 0,
      }),
    ),
    loadTextTemplateCatalog: vi.fn(async () => []),
    loadActiveSelection: vi.fn(async () => emptySelection()),
    loadActiveModel: vi.fn<ConfigurationProjectionSource['loadActiveModel']>(
      async (target, _knownPayloads, _includeModels, _signal) => ({
        kind: 'ready',
        projection: {
          revision: target.requestRevision,
          modelId: target.modelId,
          models: { kind: 'not-requested' },
          endpoints: { kind: 'not-requested' },
          privacy: { kind: 'not-requested' },
        },
      }),
    ),
    ...overrides,
  }
}

function profileFixture(id: string): ConnectionProfile {
  return buildConnectionProfile({
    id,
    name: id,
    kind: 'llama-server',
    baseUrl: `http://127.0.0.1/${id}/v1`,
    now: 1,
  })
}

function settingsFixture(profile: ConnectionProfile): ChatSettings {
  const settings = cloneDefaultChatSettings()
  settings.profileId = profile.id
  settings.model = 'vendor/model'
  return settings
}

function requestRevision(profileId: string): ConfigurationRequestRevision {
  return { profileId, requestRevision: 0, key: { kind: 'missing' } }
}

function selectionFixture(
  profile: ConnectionProfile,
  overrides: Partial<ConfigurationActiveSelectionProjection> = {},
): ConfigurationActiveSelectionProjection {
  return {
    profile,
    preset: null,
    requestRevision: requestRevision(profile.id),
    dispatchKeyRevisions: [],
    promptPresets: [],
    textTemplate: null,
    ...overrides,
  }
}

function emptySelection(): ConfigurationActiveSelectionProjection {
  return {
    profile: null,
    preset: null,
    requestRevision: null,
    dispatchKeyRevisions: [],
    promptPresets: [],
    textTemplate: null,
  }
}

function shell(totalProfileCount: number): ConfigurationShellProjection {
  return {
    preferences: {
      global: structuredClone(DEFAULT_GLOBAL_PREFERENCES),
      rendering: structuredClone(DEFAULT_RENDERING_PREFS),
      sidebarSortMode: DEFAULT_SIDEBAR_SORT_MODE,
      collapsedFolderIds: [],
      imageAllowlist: [],
      samplePromptsDismissed: false,
    },
    totalProfileCount,
  }
}

function chatFixture(id: string, settings: ChatSettings): Chat {
  return {
    id,
    title: id,
    titleStatus: 'manual',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: 1,
    wordCount: 0,
    totalCostUsd: 0,
    metaVersion: 0,
    summaryVersion: 0,
    structuralVersion: 0,
    configurationVersion: 0,
    settings: structuredClone(settings),
    lastUpdatedLeafId: null,
    lastBranchUpdatedAt: 1,
    archived: false,
    pinned: false,
    folderId: null,
    tags: [],
  }
}

function observeChat(chat: Chat): void {
  const fence = configurationController.getSnapshot().workspaceFence
  if (!fence) throw new Error('ConfigurationWorkspaceMissing')
  configurationController.observeConversation({
    workspaceId: fence.workspaceId,
    workspaceEpoch: fence.replacementEpoch,
    activeChatId: chat.id,
    active: { chatId: chat.id, chat } as NonNullable<ConversationSnapshot['active']>,
  })
}

function publishWorkspaceEffect(dependencies: readonly WorkspaceDependency[]): void {
  const fence = configurationController.getSnapshot().workspaceFence
  if (!fence) throw new Error('ConfigurationWorkspaceMissing')
  configurationController.observeWorkspaceEffect(
    prepareLocalWorkspaceChange({ kind: 'invalidate', ...fence, dependencies }).effect,
  )
}

function textTemplate(label: string): TextTemplateConfig {
  return {
    template: `{{ messages }} ${label}`,
    includeSystemPrompt: true,
    userPrefix: 'user:',
    userSuffix: '\n',
    assistantPrefix: 'assistant:',
    assistantSuffix: '\n',
    systemPrefix: 'system:',
    systemSuffix: '\n',
    bos: '',
    stop: ['stop'],
  }
}

function expectDeepFrozen(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return
  seen.add(value)
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child, seen)
}

async function waitForSelectionStatus(status: 'ready' | 'error'): Promise<void> {
  await waitForController(
    () => configurationController.getSnapshot().frame.selection.status === status,
  )
}

async function waitForExactChatSelection(chatId: string): Promise<void> {
  await waitForController(() => {
    const selection = configurationController.getSnapshot().frame.selection
    return (
      selection.status === 'ready' &&
      selection.target.kind === 'chat' &&
      selection.target.chatId === chatId
    )
  })
}

async function waitForController(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 128; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('ConfigurationControllerDidNotSettle')
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

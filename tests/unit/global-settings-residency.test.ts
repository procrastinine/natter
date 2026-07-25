import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_GLOBAL_PREFERENCES,
  THEME_KEY,
  TOKEN_CALIBRATION_MODE_KEY,
} from '../../src/core/global-settings'
import { DEFAULT_RENDERING_PREFS } from '../../src/core/rendering-preferences'
import { DEFAULT_SIDEBAR_SORT_MODE } from '../../src/core/sidebar-sort'
import type { GlobalTokenCalibration } from '../../src/core/types'
import {
  type ConfigurationProjectionSource,
  configurationController,
} from '../../src/store/configuration-controller'
import { prepareLocalWorkspaceChange } from '../../src/store/workspace-effect-hub'
import type {
  ConfigurationActiveSelectionProjection,
  ConfigurationShellProjection,
  WorkspaceDependency,
} from '../../src/store/workspace-protocol'

let replacementEpoch = 0
let releases: Array<() => void> = []

beforeEach(async () => {
  await configurationController.setProjectionSource(null)
  configurationController.rememberSeed({ profileId: null, presetId: null, settings: null })
  configurationController.reconcileWorkspace({
    workspaceId: 'configuration-capability-lifecycle',
    replacementEpoch: ++replacementEpoch,
  })
  releases = []
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await settle()
  await configurationController.setProjectionSource(null)
  vi.restoreAllMocks()
})

describe('configuration capability lifecycle', () => {
  it('settles the eager shell without waiting for target or demand-only projections', async () => {
    const shellRead = deferred<ConfigurationShellProjection>()
    const source = projectionSource({
      loadShell: vi.fn(() => shellRead.promise),
      loadActiveSelection: vi.fn(() => new Promise<never>(() => undefined)),
    })
    let settled = false
    const binding = configurationController.setProjectionSource(source).then(() => {
      settled = true
    })
    await settle()

    expect(settled).toBe(false)
    expect(configurationController.getSnapshot().frame.shell).toBeNull()
    expect(configurationController.getSnapshot().loads.shell.status).toBe('loading')
    expect(source.loadGlobalTokenCalibration).not.toHaveBeenCalled()
    expect(source.loadTextTemplateCatalog).not.toHaveBeenCalled()

    shellRead.resolve(shell(12))
    await binding

    expect(settled).toBe(true)
    expect(
      configurationController.getSnapshot().frame.shell?.preferences.global
        .messageInitialRenderWork,
    ).toBe(12)
    expect(configurationController.getSnapshot().loads.shell.status).toBe('ready')
  })

  it('fences a superseded shell read and retains only the accepted source', async () => {
    const staleRead = deferred<ConfigurationShellProjection>()
    const staleSource = projectionSource({ loadShell: vi.fn(() => staleRead.promise) })
    const staleBinding = configurationController
      .setProjectionSource(staleSource)
      .catch((error: unknown) => error)
    await settle()

    const currentSource = projectionSource({ loadShell: vi.fn(async () => shell(17)) })
    await configurationController.setProjectionSource(currentSource)
    staleRead.resolve(shell(3))
    await settle()

    expect(await staleBinding).toMatchObject({ message: 'ConfigurationProjectionSourceSuperseded' })
    expect(
      configurationController.getSnapshot().frame.shell?.preferences.global
        .messageInitialRenderWork,
    ).toBe(17)
  })

  it('coalesces demand, survives same-turn ownership transfer, and releases cold graphs', async () => {
    const calibrationRead = deferred<GlobalTokenCalibration>()
    const templatesRead = deferred<readonly []>()
    const source = projectionSource({
      loadGlobalTokenCalibration: vi.fn(() => calibrationRead.promise),
      loadTextTemplateCatalog: vi.fn(() => templatesRead.promise),
    })
    await configurationController.setProjectionSource(source)

    const releaseCalibrationA = configurationController.demandGlobalTokenCalibration()
    const releaseCalibrationB = configurationController.demandGlobalTokenCalibration()
    const releaseTemplatesA = configurationController.demandTextTemplateCatalog()
    releaseTemplatesA()
    const releaseTemplatesB = configurationController.demandTextTemplateCatalog()
    releases.push(releaseCalibrationA, releaseCalibrationB, releaseTemplatesB)
    await settle()

    expect(source.loadGlobalTokenCalibration).toHaveBeenCalledOnce()
    expect(source.loadTextTemplateCatalog).toHaveBeenCalledOnce()

    calibrationRead.resolve(emptyCalibration())
    templatesRead.resolve([])
    await settle()
    expect(configurationController.getSnapshot().frame.globalTokenCalibration).not.toBeNull()
    expect(configurationController.getSnapshot().frame.textTemplates).toEqual([])

    releaseCalibrationA()
    releaseCalibrationB()
    releaseTemplatesB()
    await settle()
    expect(configurationController.getSnapshot().frame.globalTokenCalibration).toBeNull()
    expect(configurationController.getSnapshot().frame.textTemplates).toBeNull()
    expect(configurationController.getSnapshot().loads.globalTokenCalibration.status).toBe('idle')
    expect(configurationController.getSnapshot().loads.textTemplates.status).toBe('idle')
  })

  it('routes effects only to their declared capability and batches invalidation publication', async () => {
    const source = projectionSource()
    await configurationController.setProjectionSource(source)
    releases.push(configurationController.demandGlobalTokenCalibration())
    releases.push(configurationController.demandTextTemplateCatalog())
    await settle()

    await expectEffectIsolation(source, [{ kind: 'setting', keys: [THEME_KEY] }], {
      loadShell: 1,
    })
    await expectEffectIsolation(source, [{ kind: 'setting', keys: ['global:token-calibration'] }], {
      loadGlobalTokenCalibration: 1,
    })
    await expectEffectIsolation(source, [{ kind: 'text-template', templateIds: ['unselected'] }], {
      loadTextTemplateCatalog: 1,
    })

    let publications = 0
    const unsubscribe = configurationController.subscribe(() => {
      publications += 1
    })
    const before = callCounts(source)
    publishEffect([{ kind: 'setting', keys: [TOKEN_CALIBRATION_MODE_KEY] }])
    expect(publications).toBe(1)
    unsubscribe()
    await settle()
    expect(callDelta(before, callCounts(source))).toEqual({
      loadShell: 1,
    })

    await expectEffectIsolation(source, [{ kind: 'chat', chatIds: ['unrelated'] }], {})
  })
})

function projectionSource(
  overrides: Partial<ConfigurationProjectionSource> = {},
): ConfigurationProjectionSource & Record<ProjectionLoadName, ReturnType<typeof vi.fn>> {
  return {
    loadShell: vi.fn(async () => shell()),
    loadGlobalTokenCalibration: vi.fn(async () => emptyCalibration()),
    loadTextTemplateCatalog: vi.fn(async () => []),
    loadActiveSelection: vi.fn(async () => emptySelection()),
    loadActiveModel: vi.fn(async () => {
      throw new Error('UnexpectedActiveModelRead')
    }),
    ...overrides,
  } as ConfigurationProjectionSource & Record<ProjectionLoadName, ReturnType<typeof vi.fn>>
}

type ProjectionLoadName =
  | 'loadShell'
  | 'loadGlobalTokenCalibration'
  | 'loadTextTemplateCatalog'
  | 'loadActiveSelection'
  | 'loadActiveModel'

function shell(messageInitialRenderWork = 10): ConfigurationShellProjection {
  return {
    preferences: {
      global: { ...DEFAULT_GLOBAL_PREFERENCES, messageInitialRenderWork },
      rendering: { ...DEFAULT_RENDERING_PREFS },
      sidebarSortMode: DEFAULT_SIDEBAR_SORT_MODE,
      collapsedFolderIds: [],
      imageAllowlist: [],
      samplePromptsDismissed: false,
    },
    totalProfileCount: 0,
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

function emptyCalibration(): GlobalTokenCalibration {
  return { version: 1, updatedAt: 0, byModel: {}, clearGeneration: 0 }
}

async function expectEffectIsolation(
  source: ReturnType<typeof projectionSource>,
  dependencies: readonly WorkspaceDependency[],
  expected: Partial<Record<ProjectionLoadName, number>>,
): Promise<void> {
  const before = callCounts(source)
  publishEffect(dependencies)
  await settle()
  expect(callDelta(before, callCounts(source))).toEqual(expected)
}

function publishEffect(dependencies: readonly WorkspaceDependency[]): void {
  configurationController.observeWorkspaceEffect(
    prepareLocalWorkspaceChange({
      kind: 'invalidate',
      workspaceId: 'configuration-capability-lifecycle',
      replacementEpoch,
      dependencies,
    }).effect,
  )
}

function callCounts(
  source: ReturnType<typeof projectionSource>,
): Record<ProjectionLoadName, number> {
  return {
    loadShell: source.loadShell.mock.calls.length,
    loadGlobalTokenCalibration: source.loadGlobalTokenCalibration.mock.calls.length,
    loadTextTemplateCatalog: source.loadTextTemplateCatalog.mock.calls.length,
    loadActiveSelection: source.loadActiveSelection.mock.calls.length,
    loadActiveModel: source.loadActiveModel.mock.calls.length,
  }
}

function callDelta(
  before: Record<ProjectionLoadName, number>,
  after: Record<ProjectionLoadName, number>,
): Partial<Record<ProjectionLoadName, number>> {
  return Object.fromEntries(
    (Object.keys(before) as ProjectionLoadName[]).flatMap((key) => {
      const delta = after[key] - before[key]
      return delta === 0 ? [] : [[key, delta]]
    }),
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await Promise.resolve()
}

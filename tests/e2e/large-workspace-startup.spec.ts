import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext, CDPSession, Page } from '@playwright/test'
import { chromium, expect, test } from '@playwright/test'
import {
  GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
  GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
  GENERATED_WORKSPACE_SCALES,
} from '../../scripts/generated-workspace-fixture.mjs'
import {
  armDestinationFrameBudgetRecorder,
  assertDestinationFrameBudget,
  comparableDestinationWork,
  type DestinationFrameBudgetSnapshot,
  finishDestinationFrameBudgetRecorder,
  installDestinationFrameBudgetRecorder,
} from './destination-frame-budget-recorder'
import {
  cloneGeneratedWorkspaceBrowserProfile,
  type GeneratedWorkspaceBrowserProfileClone,
  type GeneratedWorkspaceStateName,
  readReusableGeneratedWorkspaceStateManifest,
} from './generated-workspace-state'

const ACTIVE_ROUTE = `/#/chat/${GENERATED_WORKSPACE_ACTIVE_CHAT_ID}/message/${GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID}`
const INITIAL_TRANSCRIPT_FLOOR = 10
const HANG_BOUND_MS = 45_000
const ROUTE_SWITCH_OBSERVATION_MS = 1_500

test.describe.configure({ timeout: 5 * 60_000 })

test('startup work and first interaction stay cardinality-bounded in a 4k-chat workspace', async ({
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('GeneratedWorkspaceBaseUrlMissing')
  const origin = new URL(baseURL).origin
  const manifest = await readReusableGeneratedWorkspaceStateManifest(origin)
  if (!manifest) throw new Error('GeneratedWorkspaceStateCacheMissing')

  const fresh = await profileFreshWorkspace(baseURL)
  const control = await profileCachedWorkspace(baseURL, 'control')
  const large = await profileCachedWorkspace(baseURL, 'large')
  const evidence = {
    fixture: {
      control: {
        stats: manifest.states.control.stats,
        footprint: manifest.states.control.footprint,
        setup: manifest.states.control.setup,
      },
      large: {
        stats: manifest.states.large.stats,
        footprint: manifest.states.large.footprint,
        setup: manifest.states.large.setup,
      },
      chatCardinalityRatio:
        manifest.states.large.stats.chatCount / manifest.states.control.stats.chatCount,
      messageCardinalityRatio:
        manifest.states.large.stats.messageCount / manifest.states.control.stats.messageCount,
    },
    fresh: {
      ...fresh,
      coldStages: startupStageBreakdown(fresh.cold.probe),
      reloadStages: startupStageBreakdown(fresh.reload.probe),
    },
    control,
    large,
    comparisons: startupComparisons(control, large),
  }
  const evidencePath = testInfo.outputPath('large-workspace-startup-profile.json')
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  await testInfo.attach('large-workspace-startup-profile.json', {
    path: evidencePath,
    contentType: 'application/json',
  })

  expect(manifest.states.large.stats.chatCount).toBe(GENERATED_WORKSPACE_SCALES.large.chatCount)
  expect(manifest.states.large.stats.profileCount).toBe(
    GENERATED_WORKSPACE_SCALES.large.profileCount,
  )
  expect(manifest.states.large.stats.messageCount).toBeGreaterThan(20_000)
  expect(
    manifest.states.large.stats.chatCount / manifest.states.control.stats.chatCount,
  ).toBeGreaterThanOrEqual(250)

  assertFreshStartup(fresh)
  assertInteractionAndMilestones(control)
  assertInteractionAndMilestones(large)
  assertNoCanonicalWholeTableReadBeforeRunning('control reload', control.reload.probe)
  assertNoCanonicalWholeTableReadBeforeRunning('large reload', large.reload.probe)

  const controlRunningRequests = control.reload.probe.milestones.coreRunning.idb.total
  const largeRunningRequests = large.reload.probe.milestones.coreRunning.idb.total
  expect(largeRunningRequests).toBeLessThanOrEqual(controlRunningRequests + 100)
  const controlConvergedRequests = control.reload.probe.milestones.backgroundConverged.idb.total
  const largeConvergedRequests = large.reload.probe.milestones.backgroundConverged.idb.total
  expect(largeConvergedRequests).toBeLessThanOrEqual(controlConvergedRequests + 300)

  expect(
    large.browser.atConvergence.dom.nodes / control.browser.atConvergence.dom.nodes,
  ).toBeLessThan(2)
  expect(
    large.browser.atConvergence.heap.usedSize / control.browser.atConvergence.heap.usedSize,
  ).toBeLessThan(2)
  expect(large.probe.resourceCount).toBeLessThanOrEqual(control.probe.resourceCount + 10)
  assertNoCanonicalWholeTableRouteRead('control route switch', control.routeSwitch)
  assertNoCanonicalWholeTableRouteRead('large route switch', large.routeSwitch)
  expect(comparableDestinationWork(large.destinationFrame)).toEqual(
    comparableDestinationWork(control.destinationFrame),
  )
  const controlFirstPaint = destinationMilestoneDuration(
    control.destinationFrame,
    'firstDestinationPaintAt',
  )
  const largeFirstPaint = destinationMilestoneDuration(
    large.destinationFrame,
    'firstDestinationPaintAt',
  )
  const controlComplete = destinationMilestoneDuration(
    control.destinationFrame,
    'configuredWindowCompleteAt',
  )
  const largeComplete = destinationMilestoneDuration(
    large.destinationFrame,
    'configuredWindowCompleteAt',
  )
  expect(largeFirstPaint).toBeLessThanOrEqual(
    Math.max(controlFirstPaint * 2, controlFirstPaint + 100),
  )
  expect(largeComplete).toBeLessThanOrEqual(Math.max(controlComplete * 2, controlComplete + 200))
  const controlLongTaskTotal = control.destinationFrame.longTasks.reduce(
    (sum, task) => sum + task.duration,
    0,
  )
  const largeLongTaskTotal = large.destinationFrame.longTasks.reduce(
    (sum, task) => sum + task.duration,
    0,
  )
  expect(largeLongTaskTotal).toBeLessThanOrEqual(controlLongTaskTotal + 100)
  expect(
    Math.max(0, ...large.destinationFrame.longTasks.map((task) => task.duration)),
  ).toBeLessThanOrEqual(
    Math.max(0, ...control.destinationFrame.longTasks.map((task) => task.duration)) + 50,
  )
  expect(fresh.diagnostics, 'fresh browser diagnostics').toEqual([])
  expect(control.diagnostics, 'control browser diagnostics').toEqual([])
  expect(large.diagnostics, 'large browser diagnostics').toEqual([])
})

interface IdBCountSnapshot {
  readonly total: number
  readonly calls: Readonly<Record<string, number>>
}

interface StartupMilestone {
  readonly at: number
  readonly idb: IdBCountSnapshot
}

interface StartupProbeSnapshot {
  readonly milestones: {
    readonly shellCommitted: StartupMilestone
    readonly gestureDispatched: StartupMilestone
    readonly gestureApplied: StartupMilestone
    readonly databaseSelectionStarted: StartupMilestone
    readonly databaseManifestRead: StartupMilestone
    readonly databaseSelectionConfirmed: StartupMilestone
    readonly schemaPreflightCompleted: StartupMilestone
    readonly databaseOpened: StartupMilestone
    readonly configurationSelectionRead: StartupMilestone
    readonly bootstrapFenceRead: StartupMilestone
    readonly configurationResidentRead: StartupMilestone
    readonly coreRunning: StartupMilestone
    readonly maintenanceStarted: StartupMilestone
    readonly routeChatPointPainted: StartupMilestone
    readonly terminalPainted: StartupMilestone
    readonly backgroundConverged: StartupMilestone
  }
  readonly gesture: {
    readonly clickEvents: number
    readonly beforeSidebar: string | null
    readonly afterSidebar: string | null
    readonly runtimeStateAtDispatch: string | null
    readonly disabledAtDispatch: boolean
  }
  readonly shellCount: number
  readonly shellInertObserved: boolean
  readonly renderedCount: number
  readonly totalCount: number
  readonly resourceCount: number
  readonly longTasks: {
    readonly count: number
    readonly totalDuration: number
    readonly maxDuration: number
  }
  readonly idb: IdBCountSnapshot
}

interface BrowserMetrics {
  readonly heap: {
    readonly usedSize: number
    readonly totalSize: number
    readonly embedderSize: number
    readonly backingStorageSize: number
  }
  readonly dom: {
    readonly documents: number
    readonly nodes: number
    readonly jsEventListeners: number
  }
  readonly performance: Readonly<Record<string, number>>
}

interface StartupEnvironmentMetrics {
  readonly profileBytes: number
  readonly profileFiles: number
  readonly cloneMs: number
  readonly copiedBytes: number
  readonly reflinkFiles: number
  readonly fallbackFiles: number
  readonly browserLaunchMs: number
  readonly browserLaunchToActionableMs: number
}

interface RouteSwitchProfile {
  readonly targetChatId: string
  readonly targetHref: string
  readonly beforeHash: string
  readonly afterHash: string
  readonly clickEvents: number
  readonly interactiveAfterClick: string | null
  readonly hrefAfterClick: string | null
  readonly switched: boolean
  readonly durationMs: number
  readonly idbRequests: number
  readonly idbCalls: Readonly<Record<string, number>>
}

interface ReloadProfile {
  readonly durationMs: number
  readonly probe: StartupProbeSnapshot
  readonly browser: BrowserMetrics
}

interface StartupProfile {
  readonly name: string
  readonly diagnostics: readonly string[]
  readonly environment: StartupEnvironmentMetrics
  readonly probe: StartupProbeSnapshot
  readonly browser: {
    readonly atConvergence: BrowserMetrics
    readonly afterRouteSwitch: BrowserMetrics
  }
  readonly reload: ReloadProfile
  readonly routeSwitch: RouteSwitchProfile
  readonly destinationFrame: DestinationFrameBudgetSnapshot
}

interface FreshStartupProfile {
  readonly diagnostics: readonly string[]
  readonly browserLaunchMs: number
  readonly launchToConvergedMs: number
  readonly cold: {
    readonly probe: StartupProbeSnapshot
    readonly browser: BrowserMetrics
  }
  readonly reload: ReloadProfile
}

async function profileFreshWorkspace(baseURL: string): Promise<FreshStartupProfile> {
  const profilePath = await mkdtemp(join(tmpdir(), 'natter-fresh-startup-'))
  const browserLaunchStartedAt = performance.now()
  let context: BrowserContext | undefined
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      baseURL,
      viewport: { width: 1_280, height: 720 },
    })
    const browserLaunchMs = performance.now() - browserLaunchStartedAt
    const diagnostics = collectUnexpectedDiagnostics(context)
    await installProviderCatalogFixture(context)
    await installStartupProbe(context, { kind: 'empty' })
    const page = context.pages()[0] ?? (await context.newPage())
    const cdp = await context.newCDPSession(page)
    await page.goto(new URL('/#/new', baseURL).href, {
      waitUntil: 'domcontentloaded',
      timeout: HANG_BOUND_MS,
    })
    await waitForStartupConvergence(page)
    const launchToConvergedMs = performance.now() - browserLaunchStartedAt
    const cold = {
      probe: await startupProbeSnapshot(page),
      browser: await readBrowserMetrics(cdp),
    }
    const reload = await profileReload(page, cdp)
    return {
      diagnostics: diagnostics(),
      browserLaunchMs,
      launchToConvergedMs,
      cold,
      reload,
    }
  } finally {
    await context?.close().catch(() => undefined)
    await rm(profilePath, { recursive: true, force: true })
  }
}

async function profileCachedWorkspace(
  baseURL: string,
  name: GeneratedWorkspaceStateName,
): Promise<StartupProfile> {
  const origin = new URL(baseURL).origin
  const manifest = await readReusableGeneratedWorkspaceStateManifest(origin)
  if (!manifest) throw new Error('GeneratedWorkspaceStateCacheMissing')
  const clone = await cloneGeneratedWorkspaceBrowserProfile(name)
  const browserLaunchStartedAt = performance.now()
  let context: BrowserContext | undefined
  try {
    context = await chromium.launchPersistentContext(clone.path, {
      baseURL,
      viewport: { width: 1_280, height: 720 },
    })
    const browserLaunchMs = performance.now() - browserLaunchStartedAt
    const diagnostics = collectUnexpectedDiagnostics(context)
    await installProviderCatalogFixture(context)
    const page = context.pages()[0] ?? (await context.newPage())
    const profile = await profileStartup(
      context,
      page,
      baseURL,
      name,
      clone,
      browserLaunchStartedAt,
      browserLaunchMs,
      manifest.states[name].footprint,
    )
    return { ...profile, diagnostics: diagnostics() }
  } finally {
    await context?.close().catch(() => undefined)
    await clone.release()
  }
}

async function profileStartup(
  context: BrowserContext,
  page: Page,
  baseURL: string,
  name: GeneratedWorkspaceStateName,
  clone: GeneratedWorkspaceBrowserProfileClone,
  browserLaunchStartedAt: number,
  browserLaunchMs: number,
  footprint: { readonly files: number; readonly bytes: number },
): Promise<Omit<StartupProfile, 'diagnostics'>> {
  await installStartupProbe(context)
  await installDestinationFrameBudgetRecorder(context)
  const cdp = await context.newCDPSession(page)
  await page.goto(new URL(ACTIVE_ROUTE, baseURL).href, {
    waitUntil: 'domcontentloaded',
    timeout: HANG_BOUND_MS,
  })
  await page.waitForFunction(
    () =>
      Boolean(
        (
          window as typeof window & {
            __natterStartupScaleProbe?: { snapshot(): StartupProbeSnapshot }
          }
        ).__natterStartupScaleProbe?.snapshot().milestones.gestureApplied,
      ),
    undefined,
    { timeout: HANG_BOUND_MS },
  )
  const browserLaunchToActionableMs = performance.now() - browserLaunchStartedAt
  await waitForStartupConvergence(page)
  const probe = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __natterStartupScaleProbe?: {
          snapshot(): StartupProbeSnapshot
        }
      }
    ).__natterStartupScaleProbe
    if (!state) throw new Error('StartupScaleProbeMissing')
    return state.snapshot()
  })
  const atConvergence = await readBrowserMetrics(cdp)
  const reload = await profileReload(page, cdp)
  const routeSwitch = await measureRouteSwitch(page)
  const destinationFrame = await measureActiveDestinationFrame(page)
  return {
    name,
    environment: {
      profileBytes: footprint.bytes,
      profileFiles: footprint.files,
      cloneMs: clone.cloneMs,
      copiedBytes: clone.copiedBytes,
      reflinkFiles: clone.reflinkFiles,
      fallbackFiles: clone.fallbackFiles,
      browserLaunchMs,
      browserLaunchToActionableMs,
    },
    probe,
    browser: {
      atConvergence,
      afterRouteSwitch: await readBrowserMetrics(cdp),
    },
    reload,
    routeSwitch,
    destinationFrame,
  }
}

async function profileReload(page: Page, cdp: CDPSession): Promise<ReloadProfile> {
  const startedAt = performance.now()
  await page.reload({ waitUntil: 'domcontentloaded', timeout: HANG_BOUND_MS })
  await waitForStartupConvergence(page)
  return {
    durationMs: performance.now() - startedAt,
    probe: await startupProbeSnapshot(page),
    browser: await readBrowserMetrics(cdp),
  }
}

async function waitForStartupConvergence(page: Page): Promise<void> {
  const requiredMilestones = [
    'shellCommitted',
    'gestureApplied',
    'databaseSelectionStarted',
    'databaseManifestRead',
    'databaseSelectionConfirmed',
    'schemaPreflightCompleted',
    'databaseOpened',
    'bootstrapFenceRead',
    'configurationResidentRead',
    'configurationSelectionRead',
    'coreRunning',
    'maintenanceStarted',
    'routeChatPointPainted',
    'terminalPainted',
    'backgroundConverged',
  ] as const satisfies readonly (keyof StartupProbeSnapshot['milestones'])[]
  try {
    await page.waitForFunction(
      (milestoneNames) => {
        const probe = (
          window as typeof window & {
            __natterStartupScaleProbe?: {
              snapshot(): {
                milestones: Partial<StartupProbeSnapshot['milestones']>
              }
            }
          }
        ).__natterStartupScaleProbe
        const milestones = probe?.snapshot().milestones
        return Boolean(milestones && milestoneNames.every((name) => milestones[name]))
      },
      requiredMilestones,
      { timeout: HANG_BOUND_MS },
    )
  } catch (error) {
    const snapshot = await page.evaluate(() => {
      const probe = (
        window as typeof window & {
          __natterStartupScaleProbe?: {
            snapshot(): {
              milestones: Partial<StartupProbeSnapshot['milestones']>
            }
          }
        }
      ).__natterStartupScaleProbe
      return probe?.snapshot() ?? null
    })
    const milestones = snapshot?.milestones ?? {}
    const missing = requiredMilestones.filter((name) => !milestones[name])
    throw new Error(`StartupConvergenceTimeout:${missing.join(',')}:${JSON.stringify(snapshot)}`, {
      cause: error,
    })
  }
}

type StartupProbeTarget = { readonly kind: 'transcript' } | { readonly kind: 'empty' }

async function installStartupProbe(
  context: BrowserContext,
  target: StartupProbeTarget = { kind: 'transcript' },
): Promise<void> {
  await context.addInitScript(
    ({ activeChatId, terminalId, initialTranscriptFloor, targetKind }) => {
      const calls: Record<string, number> = Object.create(null) as Record<string, number>
      let total = 0
      const increment = (key: string) => {
        calls[key] = (calls[key] ?? 0) + 1
        total += 1
      }
      const idbSnapshot = () => ({ total, calls: { ...calls } })
      const state = {
        milestones: {} as Record<string, { at: number; idb: ReturnType<typeof idbSnapshot> }>,
        gesture: {
          clickEvents: 0,
          beforeSidebar: null as string | null,
          afterSidebar: null as string | null,
          runtimeStateAtDispatch: null as string | null,
          disabledAtDispatch: false,
        },
        shellCount: 0,
        shellInertObserved: false,
        renderedCount: 0,
        totalCount: 0,
        longTasks: [] as number[],
        gestureAttempted: false,
        workspacePreflightOpenSuccesses: 0,
        controlManifestReads: 0,
      }
      const mark = (name: string) => {
        if (state.milestones[name]) return
        state.milestones[name] = { at: performance.now(), idb: idbSnapshot() }
      }
      const fullSuffix = (args: unknown[]) =>
        args.length === 0 || args[0] === undefined || args[0] === null ? '.full' : '.bounded'
      const wrap = (
        prototype: object | undefined,
        method: string,
        keyFor: (receiver: unknown, args: unknown[]) => string,
        observe?: (receiver: unknown, args: unknown[], result: unknown) => void,
      ) => {
        if (!prototype) return
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
        if (!descriptor || typeof descriptor.value !== 'function') return
        const original = descriptor.value as (this: unknown, ...args: unknown[]) => unknown
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function (...args: unknown[]): unknown {
            increment(keyFor(this, args))
            const result = Reflect.apply(original, this, args)
            observe?.(this, args, result)
            return result
          },
        })
      }

      wrap(
        IDBFactory.prototype,
        'open',
        (_receiver, args) => `factory.open:${String(args[0])}`,
        (_receiver, args, result) => {
          const databaseName = String(args[0])
          if (databaseName === 'natter-control') mark('databaseSelectionStarted')
          if (!['natter', 'natter-workspace-a', 'natter-workspace-b'].includes(databaseName)) return
          const authoredOpen = args[1] !== undefined
          if (authoredOpen) mark('schemaPreflightCompleted')
          ;(result as IDBOpenDBRequest).addEventListener(
            'success',
            () => {
              if (authoredOpen) {
                mark('databaseOpened')
                return
              }
              state.workspacePreflightOpenSuccesses += 1
              if (state.workspacePreflightOpenSuccesses === 2) mark('schemaPreflightCompleted')
            },
            { once: true },
          )
        },
      )
      wrap(
        IDBFactory.prototype,
        'deleteDatabase',
        (_receiver, args) => `factory.deleteDatabase:${String(args[0])}`,
      )
      wrap(
        IDBDatabase.prototype,
        'transaction',
        (_receiver, args) => {
          const names =
            typeof args[0] === 'string'
              ? [args[0]]
              : Array.from((args[0] as Iterable<string> | undefined) ?? [])
          const mode = typeof args[1] === 'string' ? args[1] : 'readonly'
          return `database.transaction:${names.sort().join(',')}:${mode}`
        },
        (receiver, args, result) => {
          const database = receiver as IDBDatabase
          const names = (
            typeof args[0] === 'string'
              ? [args[0]]
              : Array.from((args[0] as Iterable<string> | undefined) ?? [])
          ).sort()
          const transaction = result as IDBTransaction
          transaction.addEventListener(
            'complete',
            () => {
              if (database.name === 'natter-control' && names.join(',') === 'manifests') {
                state.controlManifestReads += 1
                mark(
                  state.controlManifestReads === 1
                    ? 'databaseManifestRead'
                    : 'databaseSelectionConfirmed',
                )
              }
              if (names.join(',') === 'configurationCatalogAggregates,settings') {
                mark('configurationResidentRead')
              }
              if (
                names.join(',') ===
                'configurationPresetCatalogRows,configurationProfileCatalogRows,configurationPromptPresetCatalogRows,keys,presets,profiles,textTemplates'
              ) {
                mark('configurationSelectionRead')
              }
            },
            { once: true },
          )
        },
      )
      for (const method of [
        'add',
        'put',
        'delete',
        'clear',
        'get',
        'getKey',
        'getAll',
        'getAllKeys',
        'count',
        'openCursor',
        'openKeyCursor',
      ]) {
        wrap(
          IDBObjectStore.prototype,
          method,
          (receiver, args) => {
            const store = receiver as IDBObjectStore
            return `objectStore.${store.name}.${method}${fullSuffix(args)}`
          },
          (receiver, args, result) => {
            if (method !== 'get') return
            const store = receiver as IDBObjectStore
            const key = args[0]
            const milestone =
              store.name === 'workspaceFence' && key === 'global' ? 'bootstrapFenceRead' : null
            if (!milestone) return
            ;(result as IDBRequest).addEventListener('success', () => mark(milestone), {
              once: true,
            })
          },
        )
        wrap(IDBIndex.prototype, method, (receiver, args) => {
          const index = receiver as IDBIndex
          return `index.${index.objectStore.name}.${index.name}.${method}${fullSuffix(args)}`
        })
      }
      for (const method of ['advance', 'continue', 'continuePrimaryKey']) {
        wrap(IDBCursor.prototype, method, (receiver) => {
          const source = (receiver as IDBCursor).source
          const sourceName =
            'objectStore' in source ? `${source.objectStore.name}.${source.name}` : `${source.name}`
          return `cursor.${sourceName}.${method}`
        })
      }

      try {
        new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries()) state.longTasks.push(entry.duration)
        }).observe({ type: 'longtask', buffered: true })
      } catch {
        // Long Task timing is optional; every other milestone remains exact.
      }

      const lockDescriptor =
        typeof LockManager === 'undefined'
          ? undefined
          : Object.getOwnPropertyDescriptor(LockManager.prototype, 'request')
      if (lockDescriptor && typeof lockDescriptor.value === 'function') {
        const request = lockDescriptor.value as (this: LockManager, ...args: unknown[]) => unknown
        Object.defineProperty(LockManager.prototype, 'request', {
          ...lockDescriptor,
          value: function (...args: unknown[]): unknown {
            const name = String(args[0])
            if (!name.includes('storage-maintenance-owner:v1:')) {
              return Reflect.apply(request, this, args)
            }
            const callbackIndex = args.length - 1
            const callback = args[callbackIndex] as (lock: Lock | null) => unknown
            const forwarded = [...args]
            forwarded[callbackIndex] = (lock: Lock | null) => {
              mark('maintenanceStarted')
              return callback(lock)
            }
            return Reflect.apply(request, this, forwarded)
          },
        })
      }

      const inspect = () => {
        const shells = document.querySelectorAll<HTMLElement>('[data-ui="app-shell"]')
        state.shellCount = shells.length
        const shell = shells[0]
        if (!shell) return
        if (shell.hasAttribute('inert')) state.shellInertObserved = true
        mark('shellCommitted')
        if (!state.gestureAttempted) {
          const toggle = shell.querySelector<HTMLButtonElement>('[data-role="sidebar-toggle"]')
          if (toggle) {
            state.gestureAttempted = true
            state.gesture.beforeSidebar = shell.getAttribute('data-sidebar')
            state.gesture.runtimeStateAtDispatch = shell.getAttribute(
              'data-workspace-runtime-state',
            )
            state.gesture.disabledAtDispatch = toggle.disabled
            toggle.addEventListener('click', () => {
              state.gesture.clickEvents += 1
            })
            mark('gestureDispatched')
            toggle.click()
          }
        }
        if (state.gestureAttempted && !state.milestones.gestureApplied) {
          state.gesture.afterSidebar = shell.getAttribute('data-sidebar')
          if (
            state.gesture.afterSidebar !== null &&
            state.gesture.afterSidebar !== state.gesture.beforeSidebar
          ) {
            mark('gestureApplied')
          }
        }
        if (shell.getAttribute('data-workspace-runtime-state') === 'RUNNING') {
          mark('coreRunning')
        }
        const runtimeRunning = shell.getAttribute('data-workspace-runtime-state') === 'RUNNING'
        const targetPainted =
          targetKind === 'empty'
            ? runtimeRunning && Boolean(document.querySelector('[data-ui="empty-state"]'))
            : Boolean(
                document.querySelector(
                  `[data-ui="message"][data-message-id="${CSS.escape(terminalId)}"] [data-ui="message-body"]`,
                ),
              )
        if (targetPainted) {
          mark('terminalPainted')
        }
        const messageList = document.querySelector<HTMLElement>('[data-ui="message-list"]')
        if (
          targetKind === 'empty'
            ? targetPainted && location.hash === '#/new'
            : messageList && location.hash.includes(`/chat/${activeChatId}/`)
        ) {
          mark('routeChatPointPainted')
        }
        state.renderedCount = Number(messageList?.getAttribute('data-rendered-count') ?? 0)
        state.totalCount = Number(messageList?.getAttribute('data-total-count') ?? 0)
        const backgroundConverged =
          targetKind === 'empty'
            ? targetPainted
            : state.renderedCount >= initialTranscriptFloor &&
              state.totalCount >= initialTranscriptFloor &&
              messageList?.getAttribute('data-branch-counts') === 'known'
        if (backgroundConverged) {
          mark('backgroundConverged')
        }
      }
      const observer = new MutationObserver(inspect)
      observer.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          'data-workspace-runtime-state',
          'data-sidebar',
          'data-rendered-count',
          'data-total-count',
          'data-branch-counts',
          'inert',
        ],
      })
      queueMicrotask(inspect)
      ;(
        window as typeof window & {
          __natterStartupScaleProbe?: { snapshot(): StartupProbeSnapshot }
        }
      ).__natterStartupScaleProbe = {
        snapshot() {
          inspect()
          const longTaskTotal = state.longTasks.reduce((sum, value) => sum + value, 0)
          return structuredClone({
            milestones: state.milestones,
            gesture: state.gesture,
            shellCount: state.shellCount,
            shellInertObserved: state.shellInertObserved,
            renderedCount: state.renderedCount,
            totalCount: state.totalCount,
            resourceCount: performance.getEntriesByType('resource').length,
            longTasks: {
              count: state.longTasks.length,
              totalDuration: longTaskTotal,
              maxDuration: Math.max(0, ...state.longTasks),
            },
            idb: idbSnapshot(),
          }) as StartupProbeSnapshot
        },
      }
    },
    {
      activeChatId: GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
      terminalId: GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
      initialTranscriptFloor: INITIAL_TRANSCRIPT_FLOOR,
      targetKind: target.kind,
    },
  )
}

async function readBrowserMetrics(cdp: CDPSession): Promise<BrowserMetrics> {
  await cdp.send('HeapProfiler.collectGarbage')
  const [heap, dom, performanceMetrics] = await Promise.all([
    cdp.send('Runtime.getHeapUsage') as Promise<{
      usedSize: number
      totalSize: number
      embedderHeapUsedSize: number
      backingStorageSize: number
    }>,
    cdp.send('Memory.getDOMCounters') as Promise<{
      documents: number
      nodes: number
      jsEventListeners: number
    }>,
    cdp.send('Performance.getMetrics') as Promise<{
      metrics: Array<{ name: string; value: number }>
    }>,
  ])
  return {
    heap: {
      usedSize: heap.usedSize,
      totalSize: heap.totalSize,
      embedderSize: heap.embedderHeapUsedSize,
      backingStorageSize: heap.backingStorageSize,
    },
    dom,
    performance: Object.fromEntries(
      performanceMetrics.metrics.map((metric) => [metric.name, metric.value]),
    ),
  }
}

async function measureRouteSwitch(page: Page): Promise<RouteSwitchProfile> {
  const shell = page.locator('[data-ui="app-shell"]')
  if ((await shell.getAttribute('data-sidebar')) !== 'expanded') {
    await shell.locator('[data-role="sidebar-toggle"]').click()
    await expect(shell).toHaveAttribute('data-sidebar', 'expanded', { timeout: HANG_BOUND_MS })
  }
  const target = page
    .locator(
      `[data-ui="chat-row-link"][href^="#/chat/"]:not([href^="#/chat/${GENERATED_WORKSPACE_ACTIVE_CHAT_ID}"])`,
    )
    .first()
  await expect(target).toBeVisible({ timeout: HANG_BOUND_MS })
  const targetHref = await target.getAttribute('href')
  const targetChatId = targetHref?.match(/^#\/chat\/([^/]+)/u)?.[1]
  if (!targetChatId || !targetHref) throw new Error('GeneratedWorkspaceRouteSwitchTargetInvalid')
  const before = await startupProbeSnapshot(page)
  const beforeHash = new URL(page.url()).hash
  await target.evaluate((node) => {
    node.addEventListener('click', () => {
      ;(
        window as typeof window & { __natterRouteSwitchClickEvents?: number }
      ).__natterRouteSwitchClickEvents =
        ((window as typeof window & { __natterRouteSwitchClickEvents?: number })
          .__natterRouteSwitchClickEvents ?? 0) + 1
    })
  })
  const startedAt = performance.now()
  await target.click()
  await page
    .waitForFunction(
      (expected) => new URL(location.href).hash.startsWith(expected),
      `#/chat/${targetChatId}/message/`,
      { timeout: ROUTE_SWITCH_OBSERVATION_MS },
    )
    .catch(() => undefined)
  await page.waitForFunction(
    (expectedChatId) => {
      const list = document.querySelector<HTMLElement>('[data-ui="message-list"]')
      return Boolean(
        location.hash.startsWith(`#/chat/${expectedChatId}/message/`) &&
          list &&
          list.getAttribute('data-branch-counts') === 'known' &&
          Number(list.getAttribute('data-rendered-count') ?? 0) > 0 &&
          !list.hasAttribute('data-presentation-only'),
      )
    },
    targetChatId,
    { timeout: HANG_BOUND_MS },
  )
  const clickEvents = await page.evaluate(
    () =>
      (window as typeof window & { __natterRouteSwitchClickEvents?: number })
        .__natterRouteSwitchClickEvents ?? 0,
  )
  const after = await startupProbeSnapshot(page)
  const afterHash = new URL(page.url()).hash
  const row = target.locator('xpath=..')
  return {
    targetChatId,
    targetHref,
    beforeHash,
    afterHash,
    clickEvents,
    interactiveAfterClick: await row.getAttribute('data-interactive'),
    hrefAfterClick: await target.getAttribute('href'),
    switched: afterHash.startsWith(`#/chat/${targetChatId}/message/`),
    durationMs: performance.now() - startedAt,
    idbRequests: after.idb.total - before.idb.total,
    idbCalls: Object.fromEntries(
      Object.entries(after.idb.calls)
        .map(([name, count]) => [name, count - (before.idb.calls[name] ?? 0)] as const)
        .filter(([, count]) => count > 0),
    ),
  }
}

async function measureActiveDestinationFrame(page: Page): Promise<DestinationFrameBudgetSnapshot> {
  const targetHref = `#/chat/${GENERATED_WORKSPACE_ACTIVE_CHAT_ID}`
  const target = page.locator(`[data-ui="chat-row-link"][href="${targetHref}"]`)
  await expect(target).toBeVisible({ timeout: HANG_BOUND_MS })
  await armDestinationFrameBudgetRecorder(page, {
    chatId: GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
    targetHref,
    targetMessageId: GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
    minimumRows: INITIAL_TRANSCRIPT_FLOOR,
  })
  await target.click()
  const snapshot = await finishDestinationFrameBudgetRecorder(page)
  assertDestinationFrameBudget(snapshot, { firstPaintMs: 1_500, completeMs: 5_000 })
  expect(snapshot.publications.map((publication) => publication.renderedCount)).toEqual([
    1,
    INITIAL_TRANSCRIPT_FLOOR,
  ])
  expect(snapshot.publications[0]?.messageIds).toEqual([GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID])
  return snapshot
}

function destinationMilestoneDuration(
  snapshot: DestinationFrameBudgetSnapshot,
  milestone: keyof DestinationFrameBudgetSnapshot['milestones'],
): number {
  const at = snapshot.milestones[milestone]
  if (at === null) throw new Error(`DestinationFrameMilestoneMissing:${milestone}`)
  return at - snapshot.gesture.armedAt
}

async function startupProbeSnapshot(page: Page): Promise<StartupProbeSnapshot> {
  return page.evaluate(() => {
    const probe = (
      window as typeof window & {
        __natterStartupScaleProbe?: { snapshot(): StartupProbeSnapshot }
      }
    ).__natterStartupScaleProbe
    if (!probe) throw new Error('StartupScaleProbeMissing')
    return probe.snapshot()
  })
}

function assertInteractionAndMilestones(profile: StartupProfile): void {
  const { probe } = profile
  assertStartupStageOrder(profile.name, probe)
  assertStartupStageOrder(`${profile.name} reload`, profile.reload.probe)
  expect(probe.shellCount, `${profile.name} shell cardinality`).toBe(1)
  expect(probe.shellInertObserved, `${profile.name} shell inert`).toBe(false)
  expect(probe.gesture.disabledAtDispatch, `${profile.name} first gesture disabled`).toBe(false)
  expect(probe.gesture.clickEvents, `${profile.name} first gesture event count`).toBe(1)
  expect(probe.gesture.beforeSidebar, `${profile.name} initial sidebar state`).not.toBeNull()
  expect(probe.gesture.afterSidebar, `${profile.name} applied sidebar state`).not.toBe(
    probe.gesture.beforeSidebar,
  )
  expect(probe.renderedCount, `${profile.name} passive transcript floor`).toBeGreaterThanOrEqual(
    INITIAL_TRANSCRIPT_FLOOR,
  )
  expect(probe.totalCount, `${profile.name} active branch count`).toBe(96)
  expect(profile.environment.cloneMs, `${profile.name} profile clone hang bound`).toBeLessThan(
    HANG_BOUND_MS,
  )
  expect(
    profile.environment.browserLaunchToActionableMs,
    `${profile.name} launch-to-actionable hang bound`,
  ).toBeLessThan(HANG_BOUND_MS)
  expect(
    profile.environment.reflinkFiles + profile.environment.fallbackFiles,
    `${profile.name} copied profile files`,
  ).toBeGreaterThan(0)
  expect(profile.routeSwitch.durationMs, `${profile.name} route-switch hang bound`).toBeLessThan(
    HANG_BOUND_MS,
  )
  expect(profile.routeSwitch.clickEvents, `${profile.name} route-switch click events`).toBe(1)
  expect(profile.routeSwitch.switched, `${profile.name} route-switch committed`).toBe(true)
  for (const [name, milestone] of Object.entries(probe.milestones)) {
    expect(milestone.at, `${profile.name} ${name} catastrophic hang bound`).toBeLessThan(
      HANG_BOUND_MS,
    )
  }
}

function assertFreshStartup(profile: FreshStartupProfile): void {
  assertStartupStageOrder('fresh', profile.cold.probe)
  assertStartupStageOrder('fresh reload', profile.reload.probe)
  expect(profile.cold.probe.shellCount, 'fresh shell cardinality').toBe(1)
  expect(profile.cold.probe.shellInertObserved, 'fresh shell inert').toBe(false)
  expect(profile.cold.probe.gesture.disabledAtDispatch, 'fresh first gesture disabled').toBe(false)
  expect(profile.cold.probe.gesture.clickEvents, 'fresh first gesture event count').toBe(1)
  expect(profile.launchToConvergedMs, 'fresh launch hang bound').toBeLessThan(HANG_BOUND_MS)
  assertNoCanonicalWholeTableReadBeforeRunning('fresh', profile.cold.probe)
  assertNoCanonicalWholeTableReadBeforeRunning('fresh reload', profile.reload.probe)
}

function assertStartupStageOrder(name: string, probe: StartupProbeSnapshot): void {
  const orderedBranches = [
    ['shellCommitted', 'gestureDispatched', 'gestureApplied'],
    [
      'shellCommitted',
      'databaseSelectionStarted',
      'databaseManifestRead',
      'databaseSelectionConfirmed',
      'schemaPreflightCompleted',
      'databaseOpened',
      'bootstrapFenceRead',
      'coreRunning',
    ],
  ] as const satisfies readonly (readonly (keyof StartupProbeSnapshot['milestones'])[])[]
  for (const ordered of orderedBranches) {
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1]
      const current = ordered[index]
      if (!previous || !current) continue
      expect(
        probe.milestones[current].at,
        `${name} stage order ${previous} -> ${current}`,
      ).toBeGreaterThanOrEqual(probe.milestones[previous].at)
    }
  }
  expect(
    probe.milestones.configurationResidentRead.at,
    `${name} resident configuration after bootstrap fence`,
  ).toBeGreaterThanOrEqual(probe.milestones.bootstrapFenceRead.at)
  expect(
    probe.milestones.configurationSelectionRead.at,
    `${name} configuration selection after resident configuration`,
  ).toBeGreaterThanOrEqual(probe.milestones.configurationResidentRead.at)
  expect(
    probe.milestones.maintenanceStarted.at,
    `${name} maintenance after RUNNING`,
  ).toBeGreaterThanOrEqual(probe.milestones.coreRunning.at)
  expect(
    probe.milestones.routeChatPointPainted.at,
    `${name} route point after RUNNING`,
  ).toBeGreaterThanOrEqual(probe.milestones.coreRunning.at)
  expect(
    probe.milestones.terminalPainted.at,
    `${name} terminal after RUNNING`,
  ).toBeGreaterThanOrEqual(probe.milestones.coreRunning.at)
  expect(
    probe.milestones.backgroundConverged.at,
    `${name} convergence after terminal`,
  ).toBeGreaterThanOrEqual(probe.milestones.terminalPainted.at)
}

function assertNoCanonicalWholeTableReadBeforeRunning(
  name: string,
  probe: StartupProbeSnapshot,
): void {
  const calls = probe.milestones.coreRunning.idb.calls
  const forbidden = Object.entries(calls).filter(
    ([key, count]) =>
      count > 0 &&
      /^objectStore\.(?:chats|messages|messageBodies|profiles|presets)\.(?:getAll|getAllKeys|openCursor|openKeyCursor)\.full$/u.test(
        key,
      ),
  )
  expect(forbidden, `${name} canonical whole-table startup reads`).toEqual([])
}

function assertNoCanonicalWholeTableRouteRead(name: string, routeSwitch: RouteSwitchProfile): void {
  const forbidden = Object.entries(routeSwitch.idbCalls).filter(
    ([key, count]) =>
      count > 0 &&
      /^objectStore\.(?:chats|messages|messageBodies|profiles|presets)\.(?:getAll|getAllKeys|openCursor|openKeyCursor)\.full$/u.test(
        key,
      ),
  )
  expect(forbidden, `${name} canonical whole-table reads`).toEqual([])
}

function startupComparisons(control: StartupProfile, large: StartupProfile) {
  return {
    coldStages: {
      control: startupStageBreakdown(control.probe),
      large: startupStageBreakdown(large.probe),
    },
    steadyReloadStages: {
      control: startupStageBreakdown(control.reload.probe),
      large: startupStageBreakdown(large.reload.probe),
    },
    shellMs: {
      control: control.probe.milestones.shellCommitted.at,
      large: large.probe.milestones.shellCommitted.at,
    },
    gestureMs: {
      control: control.probe.milestones.gestureApplied.at,
      large: large.probe.milestones.gestureApplied.at,
    },
    runningMs: {
      control: control.probe.milestones.coreRunning.at,
      large: large.probe.milestones.coreRunning.at,
    },
    terminalMs: {
      control: control.probe.milestones.terminalPainted.at,
      large: large.probe.milestones.terminalPainted.at,
    },
    convergenceMs: {
      control: control.probe.milestones.backgroundConverged.at,
      large: large.probe.milestones.backgroundConverged.at,
    },
    coldRunningIdbRequests: {
      control: control.probe.milestones.coreRunning.idb.total,
      large: large.probe.milestones.coreRunning.idb.total,
    },
    coldConvergedIdbRequests: {
      control: control.probe.milestones.backgroundConverged.idb.total,
      large: large.probe.milestones.backgroundConverged.idb.total,
    },
    steadyReloadRunningIdbRequests: {
      control: control.reload.probe.milestones.coreRunning.idb.total,
      large: large.reload.probe.milestones.coreRunning.idb.total,
    },
    steadyReloadConvergedIdbRequests: {
      control: control.reload.probe.milestones.backgroundConverged.idb.total,
      large: large.reload.probe.milestones.backgroundConverged.idb.total,
    },
    browserLaunchToActionableMs: {
      control: control.environment.browserLaunchToActionableMs,
      large: large.environment.browserLaunchToActionableMs,
    },
    routeSwitchMs: {
      control: control.routeSwitch.durationMs,
      large: large.routeSwitch.durationMs,
    },
    reloadMs: {
      control: control.reload.durationMs,
      large: large.reload.durationMs,
    },
    cloneMs: { control: control.environment.cloneMs, large: large.environment.cloneMs },
    heapUsedBytes: {
      control: control.browser.atConvergence.heap.usedSize,
      large: large.browser.atConvergence.heap.usedSize,
    },
    domNodes: {
      control: control.browser.atConvergence.dom.nodes,
      large: large.browser.atConvergence.dom.nodes,
    },
  }
}

function startupStageBreakdown(probe: StartupProbeSnapshot) {
  const stage = (
    from: keyof StartupProbeSnapshot['milestones'] | null,
    to: keyof StartupProbeSnapshot['milestones'],
  ) => {
    const start = from === null ? { at: 0, idb: { total: 0 } } : probe.milestones[from]
    const end = probe.milestones[to]
    return {
      elapsedMs: end.at - start.at,
      idbRequests: end.idb.total - start.idb.total,
    }
  }
  return {
    shellCommit: stage(null, 'shellCommitted'),
    firstGestureDispatch: stage('shellCommitted', 'gestureDispatched'),
    firstGestureCommit: stage('gestureDispatched', 'gestureApplied'),
    databaseSelectionStart: stage('shellCommitted', 'databaseSelectionStarted'),
    databaseManifestSelection: stage('databaseSelectionStarted', 'databaseSelectionConfirmed'),
    schemaPreflight: stage('databaseSelectionConfirmed', 'schemaPreflightCompleted'),
    databaseOpenAndUpgrade: stage('schemaPreflightCompleted', 'databaseOpened'),
    bootstrapFence: stage('databaseOpened', 'bootstrapFenceRead'),
    runtimeReady: stage('bootstrapFenceRead', 'coreRunning'),
    residentConfiguration: stage('bootstrapFenceRead', 'configurationResidentRead'),
    configurationSelection: stage('configurationResidentRead', 'configurationSelectionRead'),
    terminalPaint: stage('coreRunning', 'terminalPainted'),
    backgroundFloor: stage('terminalPainted', 'backgroundConverged'),
    maintenanceStartAfterRunning: stage('coreRunning', 'maintenanceStarted'),
  }
}

async function installProviderCatalogFixture(context: BrowserContext): Promise<void> {
  await context.route('https://openrouter.ai/api/v1/models*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        data: [
          {
            id: 'google/gemini-3.5-flash',
            name: 'Gemini 3.5 Flash',
            supported_parameters: ['tools'],
          },
        ],
      }),
    }),
  )
}

function collectUnexpectedDiagnostics(context: BrowserContext): () => string[] {
  const diagnostics: string[] = []
  const attachPage = (page: Page) => {
    page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        diagnostics.push(`${message.type()}:${message.text()}`)
      }
    })
  }
  context.on('page', attachPage)
  for (const page of context.pages()) attachPage(page)
  return () => [...diagnostics]
}

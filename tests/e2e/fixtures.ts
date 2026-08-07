import {
  type Browser,
  type BrowserContext,
  test as base,
  type ConsoleMessage,
  chromium,
  expect,
  type Page,
  type TestInfo,
} from '@playwright/test'
import {
  armUiJourneyInvariantRecorder,
  formatUiJourneyViolations,
  installUiJourneyInvariantRecorder,
  markUiJourneyIntent,
  snapshotUiJourneyInvariants,
  stopUiJourneyInvariantRecorder,
  type UiJourneyIntent,
  type UiJourneyInvariantRecorderConfig,
  type UiJourneyInvariantReport,
} from './ui-journey-invariant-recorder'

export type { CDPSession, Locator, Page } from '@playwright/test'
export { expect }

type RuntimeDiagnosticCategory =
  | 'page-error'
  | 'dexie-promise-zone'
  | 'dexie-transaction'
  | 'react-work-loop'
  | 'react-cross-component-update'
  | 'console-other'

type RuntimeDiagnosticSource = 'console' | 'pageerror'

export interface RuntimeDiagnosticAllowance {
  category: RuntimeDiagnosticCategory | readonly RuntimeDiagnosticCategory[]
  message: string
  detail?: string
}

export interface RuntimeDiagnosticExpectation extends RuntimeDiagnosticAllowance {
  source: RuntimeDiagnosticSource
  level: 'warning' | 'error'
  count: number
}

const firefoxEngineDiagnosticAllowances: readonly RuntimeDiagnosticAllowance[] = [
  {
    category: 'console-other',
    message:
      '^\\[JavaScript Warning: "An IndexedDB transaction that was not yet complete has been aborted due to page navigation\\." \\{file: "http://127\\.0\\.0\\.1:\\d+/(?:assets/[^"]+|node_modules/\\.vite/deps/dexie\\.js[^"]*)" line: \\d+\\}\\]$',
  },
  {
    category: 'console-other',
    message:
      '^\\[JavaScript Warning: "This site appears to use a scroll-linked positioning effect\\. This may not work well with asynchronous panning; see https://firefox-source-docs\\.mozilla\\.org/performance/scroll-linked_effects\\.html for further details and to join the discussion on related tools and features!" \\{file: "http://127\\.0\\.0\\.1:\\d+/#/[^"]+" line: 0\\}\\]$',
  },
]

interface RuntimeDiagnostic {
  category: RuntimeDiagnosticCategory
  source: RuntimeDiagnosticSource
  level: string
  message: string
  stack?: string
  detail?: string
  location?: { url: string; lineNumber: number; columnNumber: number }
  allowed: boolean
}

interface RuntimeDiagnosticFixtures {
  runtimeDiagnosticPolicy: RuntimeDiagnosticPolicy
  runtimeDiagnosticAllowances: RuntimeDiagnosticAllowance[]
  runtimeDiagnosticExpectations: RuntimeDiagnosticExpectation[]
  expectRuntimeDiagnostic: (expectation: RuntimeDiagnosticExpectation) => void
  runtimeDiagnosticGate: undefined
  uiJourney: UiJourneyFixture
}

interface RuntimeDiagnosticPolicy {
  readonly allowances: readonly RuntimeDiagnosticAllowance[]
}

type NativeCdpConnect = (options: {
  endpointURL: string
  noDefaults: true
  artifactsDir: string
}) => Promise<Browser>

interface NativeCdpWorkerFixtures {
  nativeCdpBrowser: Browser
}

const nativeCdpEndpoint = process.env.E2E_NATIVE_CDP_ENDPOINT
const nativeCdpArtifactsDir = process.env.E2E_NATIVE_CDP_ARTIFACTS_DIR
const fixtureBase = nativeCdpEndpoint
  ? base.extend<object, NativeCdpWorkerFixtures>({
      nativeCdpBrowser: [
        async ({ browserName: _browserName }, use) => {
          if (!nativeCdpArtifactsDir) throw new Error('HeadedVisibilityArtifactsDirectoryMissing')
          const connectNative = chromium.connectOverCDP.bind(
            chromium,
          ) as unknown as NativeCdpConnect
          const browser = await connectNative({
            endpointURL: nativeCdpEndpoint,
            noDefaults: true,
            artifactsDir: nativeCdpArtifactsDir,
          })
          const browserSession = await browser.newBrowserCDPSession()
          await browserSession.send('Browser.setDownloadBehavior', {
            behavior: 'allowAndName',
            downloadPath: nativeCdpArtifactsDir,
            eventsEnabled: true,
          })
          try {
            await use(browser)
          } finally {
            await browserSession.detach().catch(() => undefined)
          }
        },
        { scope: 'worker' },
      ],
      context: async ({ nativeCdpBrowser }, use) => {
        const context = nativeCdpBrowser.contexts()[0]
        if (!context) throw new Error('HeadedVisibilityDefaultContextMissing')
        await use(context)
      },
      page: async (
        { context, baseURL }: { context: BrowserContext; baseURL: string | undefined },
        use,
      ) => {
        if (!baseURL) throw new Error('HeadedVisibilityBaseUrlMissing')
        const page = context.pages()[0] ?? (await context.newPage())
        await page.goto(baseURL)
        await use(page)
      },
    })
  : base

export interface UiJourneyFixture {
  start(
    page: Page,
    config: UiJourneyInvariantRecorderConfig,
    label?: string,
  ): Promise<UiJourneyInvariantReport>
  intent(page: Page, intent: UiJourneyIntent): Promise<void>
  checkpoint(page: Page, label?: string): Promise<UiJourneyInvariantReport>
  finish(page: Page, label?: string): Promise<UiJourneyInvariantReport>
}

export function createChatUiJourneyProfile(
  options: { activeSurfaceReady?: boolean; chatHeader?: boolean } = {},
): UiJourneyInvariantRecorderConfig {
  const semanticNodes = [
    ...(options.activeSurfaceReady === false ? [] : [activeSurfaceReadinessNode]),
    ...(options.chatHeader === false
      ? []
      : [
          {
            id: 'branch-tree-toggle',
            selector: '[data-role="chat-branch-tree"]',
            activeWhenSelector:
              '[data-ui="chat-title-bar"][data-chat-id]:not([data-presentation-only])',
            requireInteractive: true,
            resetOnRouteChange: false,
          },
          {
            id: 'chat-download',
            selector: '[data-role="chat-download"]',
            activeWhenSelector:
              '[data-ui="chat-title-bar"][data-chat-id]:not([data-presentation-only])',
            resetOnRouteChange: false,
          },
          {
            id: 'chat-export',
            selector: '[data-role="chat-export"]',
            activeWhenSelector:
              '[data-ui="chat-title-bar"][data-chat-id]:not([data-presentation-only])',
            requireInteractive: true,
            resetOnRouteChange: false,
          },
          {
            id: 'retained-chat-header',
            selector: '[data-ui="chat-title-bar"][data-presentation-only="true"]',
            required: false,
            resetOnRouteChange: false,
          },
          {
            id: 'composer-slot',
            selector: '[data-ui="composer"]',
            activeWhenSelector: '[data-ui="message-list"]',
            requireVisible: false,
            preserveIdentity: false,
            resetOnRouteChange: false,
          },
        ]),
  ]
  return {
    sampleLimit: 320,
    transitionLimit: 240,
    violationLimit: 80,
    shell: {
      selector: '[data-ui="app-shell"]',
      contentSelectors: [
        '[data-ui="empty-state"]',
        '[data-ui="message-list"]',
        '[data-ui="branch-tree-view"]',
      ],
      loadingSelectors: ['[data-ui="surface-loading"]'],
    },
    semanticNodes,
    countSurfaces: [
      {
        id: 'mounted-messages',
        rootSelector: '[data-ui="message-list"]',
        itemSelector: '[data-ui="message"][data-message-id]',
        activeWhenSelector: '[data-ui="message-list"]',
        minimum: 1,
      },
    ],
    transcript: {
      rootSelector: '[data-ui="message-list"]',
      itemSelector: '[data-ui="message"][data-message-id]',
      idAttribute: 'data-message-id',
      maxTrackedItems: 256,
      scrollSelector: '[data-ui="scroll-region"]',
      boundedPrefixEviction: {
        countSurfaceId: 'mounted-messages',
        renderedCountAttribute: 'data-rendered-count',
        totalCountAttribute: 'data-total-count',
      },
      boundedVirtualResidency: {
        renderedCountAttribute: 'data-rendered-count',
        virtualizedAttribute: 'data-virtualized',
      },
    },
  }
}

const activeSurfaceReadinessNode = Object.freeze({
  id: 'active-surface-present',
  selector: '[data-ui="main-pane"]',
  resetOnRouteChange: false,
})

export const test = fixtureBase.extend<RuntimeDiagnosticFixtures>({
  runtimeDiagnosticPolicy: [{ allowances: [] }, { option: true }],
  runtimeDiagnosticAllowances: async ({ runtimeDiagnosticPolicy }, use) => {
    await use([...runtimeDiagnosticPolicy.allowances])
  },
  runtimeDiagnosticExpectations: async ({ context: _context }, use) => {
    await use([])
  },
  expectRuntimeDiagnostic: async ({ runtimeDiagnosticExpectations }, use) => {
    await use((expectation) => runtimeDiagnosticExpectations.push(expectation))
  },
  runtimeDiagnosticGate: [
    async (
      { baseURL, browserName, context, runtimeDiagnosticAllowances, runtimeDiagnosticExpectations },
      use,
      testInfo,
    ) => {
      const diagnostics: RuntimeDiagnostic[] = []
      const classifyDiagnostic = (diagnostic: RuntimeDiagnostic): RuntimeDiagnostic => {
        const application = classifyAllowance(
          diagnostic,
          runtimeDiagnosticAllowances,
          runtimeDiagnosticExpectations,
        )
        return application.allowed || browserName !== 'firefox'
          ? application
          : classifyAllowance(
              application,
              firefoxEngineDiagnosticAllowances,
              runtimeDiagnosticExpectations,
            )
      }
      const pendingConsoleDetails = new Set<Promise<void>>()
      let lifecycleDrainStarted = false
      if (!baseURL) throw new Error('RuntimeDiagnosticBaseUrlMissing')
      const lifecycleDrainUrl = new URL('/__e2e-lifecycle-drain__', baseURL).href
      await context.route('**/__e2e-lifecycle-drain__', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><html data-e2e-lifecycle-drain><title>Closed</title></html>',
        }),
      )
      await context.route('https://debug.invalid/**', (route) =>
        route.fulfill({
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ data: [] }),
        }),
      )
      await context.route('**/_or_scrape/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
            props: {
              pageProps: {
                providers: [
                  {
                    provider_display_name: 'Natter',
                    provider_slug: 'natter',
                    data_policy: {
                      training: false,
                      trainingOpenRouter: false,
                      retainsPrompts: false,
                      canPublish: false,
                      requiresUserIDs: false,
                    },
                  },
                ],
              },
            },
          })}</script>`,
        }),
      )
      await context.route('https://openrouter.ai/api/v1/models*', (route) =>
        route.fulfill({
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({
            data: [
              {
                id: 'anthropic/claude-opus-4.8',
                name: 'Claude Opus 4.8',
                supported_parameters: ['tools'],
              },
            ],
          }),
        }),
      )
      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== 'warning' && message.type() !== 'error') return
        const category = classifyConsoleDiagnostic(message.text())
        const location = message.location()
        const diagnostic: RuntimeDiagnostic = classifyDiagnostic({
          category: category ?? 'console-other',
          source: 'console',
          level: message.type(),
          message: message.text(),
          ...(location.url ? { location } : {}),
          allowed: false,
        })
        diagnostics.push(
          lifecycleDrainStarted && isFixtureLifecycleNavigationWarning(message)
            ? { ...diagnostic, allowed: true }
            : diagnostic,
        )
        const detailTask = inspectConsoleErrorArguments(message).then((detail) => {
          if (!detail) return
          diagnostic.detail = detail
          diagnostic.category =
            classifyConsoleDiagnostic(`${diagnostic.message}\n${detail}`) ?? diagnostic.category
          diagnostic.allowed = classifyDiagnostic(diagnostic).allowed
        })
        pendingConsoleDetails.add(detailTask)
        void detailTask.finally(() => pendingConsoleDetails.delete(detailTask))
      }
      const pageErrorHandlers = new Map<Page, (error: Error) => void>()
      const attachPage = (page: Page) => {
        if (pageErrorHandlers.has(page)) return
        const onPageError = (error: Error) => {
          diagnostics.push(
            classifyDiagnostic({
              category: 'page-error',
              source: 'pageerror',
              level: 'error',
              message: error.message,
              ...(error.stack ? { stack: error.stack } : {}),
              location: { url: safePageUrl(page), lineNumber: 0, columnNumber: 0 },
              allowed: false,
            }),
          )
        }
        pageErrorHandlers.set(page, onPageError)
        page.on('console', onConsole)
        page.on('pageerror', onPageError)
      }
      const detachPage = (page: Page) => {
        const onPageError = pageErrorHandlers.get(page)
        if (!onPageError) return
        pageErrorHandlers.delete(page)
        page.off('console', onConsole)
        page.off('pageerror', onPageError)
      }
      context.on('page', attachPage)
      for (const page of context.pages()) attachPage(page)
      try {
        await use(undefined)
      } finally {
        const keeperPage = nativeCdpEndpoint ? await context.newPage() : undefined
        const pages = context.pages().filter((page) => page !== keeperPage)
        await drainRuntimeTasks(pages)
        lifecycleDrainStarted = true
        await navigatePagesForLifecycleDrain(pages, lifecycleDrainUrl)
        await nextHostTask()
        await Promise.allSettled(
          pages.filter((page) => !page.isClosed()).map((page) => page.close()),
        )
        await nextHostTask()
        await drainPendingConsoleDetails(pendingConsoleDetails)
        context.off('page', attachPage)
        for (const page of [...pageErrorHandlers.keys()]) detachPage(page)
        const expectationResults = evaluateDiagnosticExpectations(
          diagnostics,
          runtimeDiagnosticExpectations,
        )
        await attachDiagnosticEvidence(testInfo, diagnostics, expectationResults)
        const unexpected = diagnostics.filter((diagnostic) => !diagnostic.allowed)
        expect(unexpected, formatUnexpectedDiagnostics(unexpected)).toEqual([])
        const unmetExpectations = expectationResults.filter(
          (result) => result.actualCount !== result.expectation.count,
        )
        expect(unmetExpectations, formatUnmetDiagnosticExpectations(unmetExpectations)).toEqual([])
      }
    },
    { auto: true },
  ],
  uiJourney: async ({ runtimeDiagnosticGate: _runtimeDiagnosticGate }, use, testInfo) => {
    interface Session {
      page: Page
      label: string
      startedAt: number
      report?: UiJourneyInvariantReport
      lifecycleError?: string
    }
    const sessions = new Map<Page, Session>()
    const finish = async (page: Page, label = 'journey-finish') => {
      const session = sessions.get(page)
      if (!session) throw new Error('UiJourneySessionNotStarted')
      if (session.report) return session.report
      const report = await stopUiJourneyInvariantRecorder(page, label)
      session.report = report
      return report
    }
    const fixture: UiJourneyFixture = {
      async start(page, config, label = 'journey-start') {
        if (sessions.has(page)) throw new Error('UiJourneySessionAlreadyStarted')
        await installUiJourneyInvariantRecorder(page, config)
        const session: Session = {
          page,
          label,
          startedAt: performance.now(),
        }
        sessions.set(page, session)
        return armUiJourneyInvariantRecorder(page, label)
      },
      intent: markUiJourneyIntent,
      checkpoint(page, label = 'journey-checkpoint') {
        if (!sessions.has(page)) throw new Error('UiJourneySessionNotStarted')
        return snapshotUiJourneyInvariants(page, label, { completeIntents: true })
      },
      finish,
    }
    try {
      await use(fixture)
    } finally {
      for (const session of sessions.values()) {
        if (session.report) continue
        if (session.page.isClosed()) {
          session.lifecycleError = 'page closed before the journey recorder stopped'
          continue
        }
        try {
          session.report = await finish(session.page)
        } catch (error) {
          session.lifecycleError = error instanceof Error ? error.message : String(error)
        }
      }
      const failures = [...sessions.values()].flatMap((session) => {
        const report = session.report
        if (!report) return [`${session.label}: ${session.lifecycleError ?? 'missing report'}`]
        return [
          ...report.violations.map(
            (violation) =>
              `${session.label}: ${violation.code}/${violation.subject}: ${violation.detail}`,
          ),
          ...(report.droppedSamples === 0
            ? []
            : [`${session.label}: dropped ${report.droppedSamples} samples`]),
          ...(report.droppedTransitions === 0
            ? []
            : [`${session.label}: dropped ${report.droppedTransitions} transitions`]),
          ...(report.droppedViolations === 0
            ? []
            : [`${session.label}: dropped ${report.droppedViolations} violations`]),
        ]
      })
      if (failures.length > 0 || testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('ui-journey-invariants', {
          body: JSON.stringify(
            {
              summary: {
                sessions: sessions.size,
                failures: failures.length,
              },
              sessions: [...sessions.values()].map((session) => ({
                label: session.label,
                durationMs: Math.round(performance.now() - session.startedAt),
                url: safePageUrl(session.page),
                lifecycleError: session.lifecycleError,
                ...(session.report
                  ? {
                      counts: {
                        samples: session.report.samples.length,
                        transitions: session.report.transitions.length,
                        violations: session.report.violations.length,
                        droppedSamples: session.report.droppedSamples,
                        droppedTransitions: session.report.droppedTransitions,
                        droppedViolations: session.report.droppedViolations,
                      },
                      violations: session.report.violations,
                      samples: session.report.samples.slice(-12),
                      transitions: session.report.transitions.slice(-12),
                    }
                  : {}),
              })),
            },
            null,
            2,
          ),
          contentType: 'application/json',
        })
      }
      expect(
        failures,
        failures.length > 0
          ? failures.join('\n')
          : [...sessions.values()]
              .map((session) =>
                session.report ? formatUiJourneyViolations(session.report) : session.lifecycleError,
              )
              .filter(Boolean)
              .join('\n'),
      ).toEqual([])
    }
  },
})

function classifyConsoleDiagnostic(message: string): RuntimeDiagnosticCategory | null {
  if (/(?:\[Unhandled error\]|uncaught exception)/iu.test(message)) return 'page-error'
  if (/(?:An|The above) error occurred in the <[^>]+> component/iu.test(message)) {
    return 'page-error'
  }
  if (
    /targetZone(?:\s+is)?\s+undefined/iu.test(message) ||
    /(?:zone[ -]?stack|promise[ -]?zone).*(?:underflow|mismatch|undefined|empty)/iu.test(message)
  ) {
    return 'dexie-promise-zone'
  }
  if (
    /\b(?:PrematureCommitError|TransactionInactiveError|TransactionCommittedError)\b/u.test(
      message,
    ) ||
    /\btransaction\b.*\b(?:inactive|committed too early|already committed|unexpectedly aborted)\b/iu.test(
      message,
    )
  ) {
    return 'dexie-transaction'
  }
  if (/Should not already be working/iu.test(message)) return 'react-work-loop'
  if (
    /Cannot update (?:a component .* while rendering a different component|during an existing state transition)/iu.test(
      message,
    )
  ) {
    return 'react-cross-component-update'
  }
  return null
}

async function inspectConsoleErrorArguments(message: ConsoleMessage): Promise<string | undefined> {
  const details = await Promise.all(
    message.args().map(async (handle, index) => {
      try {
        const detail = await handle.evaluate((value: unknown) => {
          if (typeof value !== 'object' || value === null) return null
          const record = value as Record<string, unknown>
          const prototype = Object.getPrototypeOf(value) as {
            constructor?: { name?: unknown }
          } | null
          const name =
            typeof record.name === 'string'
              ? record.name
              : typeof prototype?.constructor?.name === 'string'
                ? prototype.constructor.name
                : undefined
          const message = typeof record.message === 'string' ? record.message : undefined
          const stack = typeof record.stack === 'string' ? record.stack : undefined
          const code =
            typeof record.code === 'string' || typeof record.code === 'number'
              ? record.code
              : undefined
          if (!name && !message && !stack && code === undefined) return null
          return { name, message, stack, code }
        })
        if (!detail) return undefined
        const heading = [detail.name, detail.message].filter(Boolean).join(': ')
        const code = detail.code === undefined ? '' : ` code=${detail.code}`
        return `argument ${index + 1}: ${heading || 'Error-like object'}${code}${
          detail.stack ? `\n${detail.stack}` : ''
        }`
      } catch {
        return undefined
      }
    }),
  )
  const present = details.filter((detail): detail is string => detail !== undefined)
  return present.length > 0 ? present.join('\n') : undefined
}

async function drainPendingConsoleDetails(pending: Set<Promise<void>>): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending])
}

function isFixtureLifecycleNavigationWarning(message: ConsoleMessage): boolean {
  if (message.type() !== 'warning') return false
  const location = message.location()
  return (
    /\/node_modules\/\.vite\/deps\/dexie\.js(?:\?|$)/u.test(location.url) &&
    /^\[JavaScript Warning: "An IndexedDB transaction that was not yet complete has been aborted due to page navigation\." \{file: ".*\/node_modules\/\.vite\/deps\/dexie\.js[^"}]*" line: \d+\}\]$/u.test(
      message.text(),
    )
  )
}

function safePageUrl(page: Page): string {
  try {
    return page.url()
  } catch {
    return ''
  }
}

async function drainRuntimeTasks(pages: readonly Page[]): Promise<void> {
  await Promise.allSettled(
    pages.map(async (page) => {
      if (page.isClosed()) return
      try {
        await page.evaluate(async () => {
          for (let turn = 0; turn < 3; turn += 1) {
            await new Promise<void>((resolve) => {
              const channel = new MessageChannel()
              channel.port1.onmessage = () => {
                channel.port1.close()
                channel.port2.close()
                resolve()
              }
              channel.port2.postMessage(undefined)
            })
          }
        })
      } catch (error) {
        if (!page.isClosed()) throw error
      }
    }),
  )
}

async function navigatePagesForLifecycleDrain(
  pages: readonly Page[],
  lifecycleDrainUrl: string,
): Promise<void> {
  const results = await Promise.allSettled(
    pages
      .filter((page) => !page.isClosed())
      .map(async (page) => {
        const arrived = page.locator('[data-e2e-lifecycle-drain]').waitFor({ state: 'attached' })
        await page.evaluate((url) => window.location.replace(url), lifecycleDrainUrl)
        await arrived
        if (page.url() !== lifecycleDrainUrl) throw new Error('RuntimeDiagnosticDrainUrlMismatch')
      }),
  )
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (rejected) throw rejected.reason
}

async function nextHostTask(): Promise<void> {
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      channel.port2.close()
      resolve()
    }
    channel.port2.postMessage(undefined)
  })
}

function classifyAllowance(
  diagnostic: RuntimeDiagnostic,
  allowances: readonly RuntimeDiagnosticAllowance[],
  expectations: readonly RuntimeDiagnosticExpectation[],
): RuntimeDiagnostic {
  return {
    ...diagnostic,
    allowed:
      allowances.some((allowance) => diagnosticMatchesAllowance(diagnostic, allowance)) ||
      expectations.some((expectation) => diagnosticMatchesExpectation(diagnostic, expectation)),
  }
}

function diagnosticMatchesAllowance(
  diagnostic: RuntimeDiagnostic,
  allowance: RuntimeDiagnosticAllowance,
): boolean {
  return (
    (Array.isArray(allowance.category)
      ? allowance.category.includes(diagnostic.category)
      : allowance.category === diagnostic.category) &&
    new RegExp(allowance.message, 'u').test(diagnostic.message) &&
    (allowance.detail === undefined ||
      (diagnostic.detail !== undefined &&
        new RegExp(allowance.detail, 'u').test(diagnostic.detail)))
  )
}

function diagnosticMatchesExpectation(
  diagnostic: RuntimeDiagnostic,
  expectation: RuntimeDiagnosticExpectation,
): boolean {
  return (
    diagnostic.source === expectation.source &&
    diagnostic.level === expectation.level &&
    diagnosticMatchesAllowance(diagnostic, expectation)
  )
}

interface RuntimeDiagnosticExpectationResult {
  expectation: RuntimeDiagnosticExpectation
  actualCount: number
}

function evaluateDiagnosticExpectations(
  diagnostics: readonly RuntimeDiagnostic[],
  expectations: readonly RuntimeDiagnosticExpectation[],
): RuntimeDiagnosticExpectationResult[] {
  return expectations.map((expectation) => ({
    expectation,
    actualCount: diagnostics.filter((diagnostic) =>
      diagnosticMatchesExpectation(diagnostic, expectation),
    ).length,
  }))
}

async function attachDiagnosticEvidence(
  testInfo: TestInfo,
  diagnostics: readonly RuntimeDiagnostic[],
  expectationResults: readonly RuntimeDiagnosticExpectationResult[],
): Promise<void> {
  const payload = {
    summary: {
      total: diagnostics.length,
      unexpected: diagnostics.filter((diagnostic) => !diagnostic.allowed).length,
      allowed: diagnostics.filter((diagnostic) => diagnostic.allowed).length,
      otherConsole: diagnostics.filter((diagnostic) => diagnostic.category === 'console-other')
        .length,
      expected: expectationResults.length,
      unmetExpected: expectationResults.filter(
        (result) => result.actualCount !== result.expectation.count,
      ).length,
    },
    diagnostics,
    expectationResults,
  }
  await testInfo.attach('runtime-diagnostics', {
    body: JSON.stringify(payload, null, 2),
    contentType: 'application/json',
  })
}

function formatUnmetDiagnosticExpectations(
  results: readonly RuntimeDiagnosticExpectationResult[],
): string {
  if (results.length === 0) return 'All expected browser runtime diagnostics were observed.'
  return results
    .map(
      ({ expectation, actualCount }, index) =>
        `${index + 1}. Expected ${expectation.count}, observed ${actualCount}: ` +
        `[${formatDiagnosticCategories(expectation.category)}/${expectation.source}/${expectation.level}] ${expectation.message}`,
    )
    .join('\n')
}

function formatDiagnosticCategories(
  categories: RuntimeDiagnosticCategory | readonly RuntimeDiagnosticCategory[],
): string {
  return typeof categories === 'string' ? categories : categories.join('|')
}

function formatUnexpectedDiagnostics(diagnostics: readonly RuntimeDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No unexpected browser runtime diagnostics.'
  return diagnostics
    .map(
      (diagnostic, index) =>
        `${index + 1}. [${diagnostic.category}/${diagnostic.source}] ${diagnostic.message}`,
    )
    .join('\n')
}

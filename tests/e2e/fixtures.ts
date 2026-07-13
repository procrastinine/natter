import {
  test as base,
  type ConsoleMessage,
  expect,
  type Page,
  type WebSocket as PlaywrightWebSocket,
  type TestInfo,
} from '@playwright/test'

export type { CDPSession, Locator, Page } from '@playwright/test'
export { expect }

type RuntimeDiagnosticCategory =
  | 'page-error'
  | 'dexie-promise-zone'
  | 'dexie-transaction'
  | 'react-work-loop'
  | 'react-cross-component-update'
  | 'console-other'

export interface RuntimeDiagnosticAllowance {
  category: RuntimeDiagnosticCategory
  message: string
}

interface RuntimeDiagnostic {
  category: RuntimeDiagnosticCategory
  source: 'console' | 'pageerror' | 'vite-forward-console'
  level: string
  message: string
  stack?: string
  detail?: string
  location?: { url: string; lineNumber: number; columnNumber: number }
  allowed: boolean
}

interface RuntimeDiagnosticFixtures {
  runtimeDiagnosticAllowances: RuntimeDiagnosticAllowance[]
  runtimeDiagnosticGate: undefined
}

export const test = base.extend<RuntimeDiagnosticFixtures>({
  runtimeDiagnosticAllowances: [[], { option: true }],
  runtimeDiagnosticGate: [
    async ({ context, runtimeDiagnosticAllowances }, use, testInfo) => {
      const diagnostics: RuntimeDiagnostic[] = []
      const pendingConsoleDetails = new Set<Promise<void>>()
      let lifecycleDrainStarted = false
      await context.route('https://debug.invalid/**', (route) =>
        route.fulfill({
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ data: [] }),
        }),
      )
      const onConsole = (message: ConsoleMessage) => {
        if (message.type() !== 'warning' && message.type() !== 'error') return
        const category = classifyConsoleDiagnostic(message.text())
        const location = message.location()
        const diagnostic: RuntimeDiagnostic = classifyAllowance(
          {
            category: category ?? 'console-other',
            source: 'console',
            level: message.type(),
            message: message.text(),
            ...(location.url ? { location } : {}),
            allowed: false,
          },
          runtimeDiagnosticAllowances,
        )
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
          diagnostic.allowed = classifyAllowance(diagnostic, runtimeDiagnosticAllowances).allowed
        })
        pendingConsoleDetails.add(detailTask)
        void detailTask.finally(() => pendingConsoleDetails.delete(detailTask))
      }
      const webSocketHandlers = new Map<
        PlaywrightWebSocket,
        (frame: { payload: string | Buffer }) => void
      >()
      const onWebSocket = (webSocket: PlaywrightWebSocket) => {
        const onFrameSent = (frame: { payload: string | Buffer }) => {
          const error = parseViteForwardedError(frame.payload)
          if (!error) return
          if (error.consoleLog) {
            const matchingConsole = findMatchingConsoleDiagnostic(diagnostics, error.message)
            if (matchingConsole) {
              matchingConsole.detail = error.message
              matchingConsole.category =
                classifyConsoleDiagnostic(error.message) ?? matchingConsole.category
              matchingConsole.allowed = classifyAllowance(
                matchingConsole,
                runtimeDiagnosticAllowances,
              ).allowed
              return
            }
          }
          diagnostics.push(
            classifyAllowance(
              {
                category: classifyConsoleDiagnostic(error.message) ?? 'page-error',
                source: 'vite-forward-console',
                level: 'error',
                message: error.message,
                ...(error.stack ? { stack: error.stack } : {}),
                allowed: false,
              },
              runtimeDiagnosticAllowances,
            ),
          )
        }
        webSocketHandlers.set(webSocket, onFrameSent)
        webSocket.on('framesent', onFrameSent)
      }
      const pageErrorHandlers = new Map<Page, (error: Error) => void>()
      const attachPage = (page: Page) => {
        if (pageErrorHandlers.has(page)) return
        const onPageError = (error: Error) => {
          diagnostics.push(
            classifyAllowance(
              {
                category: 'page-error',
                source: 'pageerror',
                level: 'error',
                message: error.message,
                ...(error.stack ? { stack: error.stack } : {}),
                location: { url: safePageUrl(page), lineNumber: 0, columnNumber: 0 },
                allowed: false,
              },
              runtimeDiagnosticAllowances,
            ),
          )
        }
        pageErrorHandlers.set(page, onPageError)
        page.on('console', onConsole)
        page.on('pageerror', onPageError)
        page.on('websocket', onWebSocket)
      }
      const detachPage = (page: Page) => {
        const onPageError = pageErrorHandlers.get(page)
        if (!onPageError) return
        pageErrorHandlers.delete(page)
        page.off('console', onConsole)
        page.off('pageerror', onPageError)
        page.off('websocket', onWebSocket)
      }
      context.on('page', attachPage)
      for (const page of context.pages()) attachPage(page)
      try {
        await use(undefined)
      } finally {
        const pages = context.pages()
        await drainRuntimeTasks(pages)
        await waitForRuntimeNetworkIdle(pages)
        lifecycleDrainStarted = true
        await navigatePagesForLifecycleDrain(pages)
        await nextHostTask()
        await Promise.allSettled(
          pages.filter((page) => !page.isClosed()).map((page) => page.close()),
        )
        await nextHostTask()
        await drainPendingConsoleDetails(pendingConsoleDetails)
        context.off('page', attachPage)
        for (const page of [...pageErrorHandlers.keys()]) detachPage(page)
        for (const [webSocket, onFrameSent] of webSocketHandlers) {
          webSocket.off('framesent', onFrameSent)
        }
        webSocketHandlers.clear()
        await attachDiagnosticEvidence(testInfo, diagnostics)
        const unexpected = diagnostics.filter((diagnostic) => !diagnostic.allowed)
        expect(unexpected, formatUnexpectedDiagnostics(unexpected)).toEqual([])
      }
    },
    { auto: true },
  ],
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

function parseViteForwardedError(
  payload: string | Buffer,
): { message: string; stack?: string; consoleLog?: boolean } | null {
  try {
    const frame: unknown = JSON.parse(payload.toString())
    if (!isRecord(frame) || frame.type !== 'custom' || frame.event !== 'vite:forward-console') {
      return null
    }
    const forwarded = frame.data
    if (!isRecord(forwarded) || !isRecord(forwarded.data)) return null
    const consoleLog = forwarded.type === 'log' && forwarded.data.level === 'error'
    if (!consoleLog && forwarded.type !== 'error' && forwarded.type !== 'unhandled-rejection') {
      return null
    }
    const message = forwarded.data.message
    if (typeof message !== 'string') return null
    const stack = forwarded.data.stack
    return {
      message,
      ...(typeof stack === 'string' ? { stack } : {}),
      ...(consoleLog ? { consoleLog: true } : {}),
    }
  } catch {
    return null
  }
}

function forwardedLogMatchesConsole(forwarded: string, consoleMessage: string): boolean {
  const base = consoleMessage.replace(/\s+JSHandle@\w+.*$/u, '').trim()
  return base.length > 0 && forwarded.includes(base)
}

function findMatchingConsoleDiagnostic(
  diagnostics: readonly RuntimeDiagnostic[],
  forwarded: string,
): RuntimeDiagnostic | undefined {
  for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
    const diagnostic = diagnostics[index]
    if (
      diagnostic?.source === 'console' &&
      diagnostic.level === 'error' &&
      forwardedLogMatchesConsole(forwarded, diagnostic.message)
    ) {
      return diagnostic
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

async function waitForRuntimeNetworkIdle(pages: readonly Page[]): Promise<void> {
  const results = await Promise.allSettled(
    pages.filter((page) => !page.isClosed()).map((page) => page.waitForLoadState('networkidle')),
  )
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (rejected) throw rejected.reason
}

async function navigatePagesForLifecycleDrain(pages: readonly Page[]): Promise<void> {
  const results = await Promise.allSettled(
    pages.filter((page) => !page.isClosed()).map((page) => page.goto('about:blank')),
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
): RuntimeDiagnostic {
  return {
    ...diagnostic,
    allowed: allowances.some(
      (allowance) =>
        allowance.category === diagnostic.category &&
        new RegExp(allowance.message, 'u').test(diagnostic.message),
    ),
  }
}

async function attachDiagnosticEvidence(
  testInfo: TestInfo,
  diagnostics: readonly RuntimeDiagnostic[],
): Promise<void> {
  const payload = {
    summary: {
      total: diagnostics.length,
      unexpected: diagnostics.filter((diagnostic) => !diagnostic.allowed).length,
      allowed: diagnostics.filter((diagnostic) => diagnostic.allowed).length,
      otherConsole: diagnostics.filter((diagnostic) => diagnostic.category === 'console-other')
        .length,
    },
    diagnostics,
  }
  await testInfo.attach('runtime-diagnostics', {
    body: JSON.stringify(payload, null, 2),
    contentType: 'application/json',
  })
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

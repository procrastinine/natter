import { readdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { cloneGeneratedWorkspaceBrowserProfile } from '../tests/e2e/generated-workspace-state.ts'
import {
  GENERATED_WORKSPACE_ACTIVE_CHAT_ID,
  GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
} from './generated-workspace-fixture.mjs'

const baseURL = process.env.NATTER_PROFILE_BASE_URL ?? 'http://127.0.0.1:4173'
const blockMaintenance = process.env.NATTER_PROFILE_BLOCK_MAINTENANCE === '1'
const compactLongMessages = process.env.NATTER_PROFILE_COMPACT_LONG_MESSAGES === '1'
const captureTrace = process.env.NATTER_PROFILE_TRACE === '1'
const earlyMessageList = process.env.NATTER_PROFILE_EARLY_MESSAGE_LIST === '1'
const messageListAsset = earlyMessageList
  ? (await readdir(new URL('../dist/assets/', import.meta.url))).find((name) =>
      /^MessageList-.*\.js$/u.test(name),
    )
  : undefined
if (earlyMessageList && !messageListAsset) throw new Error('MessageListAssetMissing')
const route = `/#/chat/${GENERATED_WORKSPACE_ACTIVE_CHAT_ID}/message/${GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID}`
const clone = await cloneGeneratedWorkspaceBrowserProfile('large')
let context

try {
  context = await chromium.launchPersistentContext(clone.path, {
    baseURL,
    viewport: { width: 1_280, height: 720 },
  })
  await context.route('https://openrouter.ai/api/v1/models*', (request) =>
    request.fulfill({
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
  await context.addInitScript(
    ({ terminalId, blockMaintenance, messageListAsset }) => {
      const events = []
      const counters = Object.create(null)
      let terminalPaintScheduled = false
      let earlyMessageListStarted = false
      const record = (kind, detail) => {
        counters[kind] = (counters[kind] ?? 0) + 1
        if (events.length < 10_000) {
          events.push({ at: performance.now(), kind, ...(detail === undefined ? {} : { detail }) })
        }
      }
      const summarizeKey = (value) => {
        if (typeof value === 'string' || typeof value === 'number') return String(value)
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      }
      const wrapRequest = (prototype, method) => {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
        if (!descriptor || typeof descriptor.value !== 'function') return
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function (...args) {
            const store = this instanceof IDBObjectStore ? this.name : this.objectStore.name
            const index = this instanceof IDBIndex ? this.name : null
            const relevant = [
              'chats',
              'messages',
              'messageBodies',
              'childLists',
              'childSlotMembers',
              'workspaceFence',
            ].includes(store)
            const requestStartedAt = performance.now()
            const request = Reflect.apply(descriptor.value, this, args)
            if (relevant) {
              const detail = {
                store,
                ...(index ? { index } : {}),
                method,
                key: summarizeKey(args[0]),
              }
              record('idb-request-start', detail)
              request.addEventListener(
                'success',
                () =>
                  record('idb-request-success', {
                    ...detail,
                    duration: performance.now() - requestStartedAt,
                  }),
                { once: true },
              )
              request.addEventListener(
                'error',
                () =>
                  record('idb-request-error', {
                    ...detail,
                    duration: performance.now() - requestStartedAt,
                  }),
                { once: true },
              )
            }
            return request
          },
        })
      }
      if (blockMaintenance && typeof LockManager !== 'undefined') {
        const lockDescriptor = Object.getOwnPropertyDescriptor(LockManager.prototype, 'request')
        if (lockDescriptor && typeof lockDescriptor.value === 'function') {
          Object.defineProperty(LockManager.prototype, 'request', {
            ...lockDescriptor,
            value: function (...args) {
              if (String(args[0]).includes('storage-maintenance-owner:v1:')) {
                record('maintenance-admission-blocked')
                return new Promise(() => {})
              }
              return Reflect.apply(lockDescriptor.value, this, args)
            },
          })
        }
      }
      for (const method of ['get', 'getAll', 'openCursor', 'openKeyCursor']) {
        wrapRequest(IDBObjectStore.prototype, method)
        wrapRequest(IDBIndex.prototype, method)
      }
      const transactionDescriptor = Object.getOwnPropertyDescriptor(
        IDBDatabase.prototype,
        'transaction',
      )
      if (transactionDescriptor && typeof transactionDescriptor.value === 'function') {
        Object.defineProperty(IDBDatabase.prototype, 'transaction', {
          ...transactionDescriptor,
          value: function (...args) {
            const names = (
              typeof args[0] === 'string' ? [args[0]] : Array.from(args[0] ?? [])
            ).sort()
            const startedAt = performance.now()
            const transaction = Reflect.apply(transactionDescriptor.value, this, args)
            const detail = { names, mode: String(args[1] ?? 'readonly') }
            record('idb-transaction-start', detail)
            transaction.addEventListener(
              'complete',
              () =>
                record('idb-transaction-complete', {
                  ...detail,
                  duration: performance.now() - startedAt,
                }),
              { once: true },
            )
            transaction.addEventListener(
              'abort',
              () =>
                record('idb-transaction-abort', {
                  ...detail,
                  duration: performance.now() - startedAt,
                }),
              { once: true },
            )
            return transaction
          },
        })
      }
      try {
        new PerformanceObserver((entries) => {
          for (const entry of entries.getEntries()) {
            record('long-task', { startTime: entry.startTime, duration: entry.duration })
          }
        }).observe({ type: 'longtask', buffered: true })
      } catch {}
      addEventListener('DOMContentLoaded', () => record('dom-content-loaded'), { once: true })
      addEventListener('load', () => record('window-load'), { once: true })
      const inspect = () => {
        const shell = document.querySelector('[data-ui="app-shell"]')
        if (shell) record('shell-observed')
        if (shell && messageListAsset && !earlyMessageListStarted) {
          earlyMessageListStarted = true
          record('early-message-list-start')
          void import(`/assets/${messageListAsset}`).then(
            () => record('early-message-list-ready'),
            (error) => record('early-message-list-error', { message: String(error) }),
          )
        }
        if (shell?.getAttribute('data-workspace-runtime-state') === 'RUNNING') {
          if (!counters['runtime-running']) record('runtime-running')
        }
        const loading = document.querySelector('[data-ui="surface-loading"]')
        if (loading && !counters['conversation-loading']) {
          record('conversation-loading', { text: loading.textContent })
        }
        const list = document.querySelector('[data-ui="message-list"]')
        if (list && !counters['message-list']) {
          record('message-list', {
            renderedCount: list.getAttribute('data-rendered-count'),
            totalCount: list.getAttribute('data-total-count'),
          })
        }
        const terminal = document.querySelector(
          `[data-ui="message"][data-message-id="${CSS.escape(terminalId)}"]`,
        )
        if (terminal && !counters['terminal-article']) record('terminal-article')
        const body = terminal?.querySelector('[data-ui="message-body"]')
        if (body && !counters['terminal-body']) record('terminal-body')
        const markdown = terminal?.querySelector('[data-ui="markdown"]')
        if (markdown && !counters['terminal-markdown']) {
          record('terminal-markdown', { overflow: markdown.getAttribute('data-overflow') })
        }
        if (body && !terminalPaintScheduled) {
          terminalPaintScheduled = true
          requestAnimationFrame(() => {
            record('terminal-next-frame')
            requestAnimationFrame(() => record('terminal-next-painted-frame'))
          })
        }
      }
      const observer = new MutationObserver(inspect)
      observer.observe(document, { subtree: true, childList: true, attributes: true })
      queueMicrotask(inspect)
      window.__natterTerminalWaterfall = {
        snapshot() {
          inspect()
          return structuredClone({
            events,
            counters,
            resources: performance
              .getEntriesByType('resource')
              .filter((entry) => entry.name.includes('/assets/'))
              .map((entry) => ({
                name: entry.name.split('/').at(-1),
                startTime: entry.startTime,
                responseEnd: entry.responseEnd,
                duration: entry.duration,
                transferSize: entry.transferSize,
                decodedBodySize: entry.decodedBodySize,
              })),
            navigation: performance.getEntriesByType('navigation').map((entry) => ({
              domContentLoadedEventEnd: entry.domContentLoadedEventEnd,
              loadEventEnd: entry.loadEventEnd,
              responseEnd: entry.responseEnd,
            })),
          })
        },
      }
    },
    {
      terminalId: GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID,
      blockMaintenance,
      messageListAsset,
    },
  )

  const page = context.pages()[0] ?? (await context.newPage())
  const diagnostics = []
  page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      diagnostics.push(`${message.type()}:${message.text()}`)
    }
  })
  const profile = async (name, navigate) => {
    await navigate()
    await page.waitForSelector(
      `[data-ui="message"][data-message-id="${GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID}"] [data-ui="message-body"]`,
      { timeout: 45_000 },
    )
    await page.waitForFunction(
      () =>
        Boolean(
          window.__natterTerminalWaterfall?.snapshot().counters['terminal-next-painted-frame'],
        ),
      undefined,
      { timeout: 5_000 },
    )
    await page.waitForTimeout(50)
    return {
      name,
      snapshot: await page.evaluate(() => window.__natterTerminalWaterfall.snapshot()),
    }
  }
  const cold = await profile('cold', () =>
    page.goto(new URL(route, baseURL).href, { waitUntil: 'domcontentloaded', timeout: 45_000 }),
  )
  if (compactLongMessages) {
    await page.evaluate(async () => {
      const databases = await indexedDB.databases()
      for (const { name } of databases) {
        if (!name?.startsWith('natter-workspace-')) continue
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name)
          request.addEventListener('success', () => resolve(request.result), { once: true })
          request.addEventListener('error', () => reject(request.error), { once: true })
        })
        if (!database.objectStoreNames.contains('settings')) {
          database.close()
          continue
        }
        await new Promise((resolve, reject) => {
          const transaction = database.transaction(['settings'], 'readwrite')
          transaction.objectStore('settings').put({
            key: 'global:long-message-display-mode',
            value: 'compact',
          })
          transaction.addEventListener('complete', resolve, { once: true })
          transaction.addEventListener('abort', () => reject(transaction.error), { once: true })
        })
        database.close()
      }
    })
  }
  const cdp = captureTrace ? await context.newCDPSession(page) : null
  const traceEvents = []
  if (cdp) {
    cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value))
    await cdp.send('Performance.enable')
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,v8,blink.user_timing,loading,disabled-by-default-v8.compile',
      transferMode: 'ReportEvents',
    })
  }
  const reload = await profile('reload', () =>
    page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }),
  )
  let trace = null
  if (cdp) {
    const completed = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end')
    await completed
    const metrics = await cdp.send('Performance.getMetrics')
    const navigationStart = metrics.metrics.find(
      (metric) => metric.name === 'NavigationStart',
    )?.value
    trace = summarizeTrace(traceEvents, navigationStart)
  }
  console.log(
    JSON.stringify(
      {
        cold: summarize(cold.snapshot),
        reload: summarize(reload.snapshot),
        diagnostics,
        blockMaintenance,
        compactLongMessages,
        earlyMessageList,
        trace,
      },
      null,
      2,
    ),
  )
} finally {
  await context?.close().catch(() => undefined)
  await clone.release()
}

function summarizeTrace(events, navigationStart) {
  const complete = events
    .filter((event) => event.ph === 'X' && typeof event.dur === 'number' && event.dur >= 2_000)
    .map((event) => ({
      name: event.name,
      category: event.cat,
      startTime:
        navigationStart === undefined
          ? null
          : Number((event.ts / 1_000 - navigationStart * 1_000).toFixed(3)),
      duration: Number((event.dur / 1_000).toFixed(3)),
      url:
        typeof event.args?.data?.url === 'string'
          ? event.args.data.url.split('/').at(-1)
          : undefined,
    }))
  const byName = new Map()
  for (const event of complete) {
    const current = byName.get(event.name) ?? { count: 0, totalMs: 0, maxMs: 0 }
    current.count += 1
    current.totalMs += event.duration
    current.maxMs = Math.max(current.maxMs, event.duration)
    byName.set(event.name, current)
  }
  return {
    totals: Object.fromEntries(
      [...byName.entries()].sort((left, right) => right[1].totalMs - left[1].totalMs).slice(0, 30),
    ),
    longest: complete.sort((left, right) => right.duration - left.duration).slice(0, 60),
  }
}

function summarize(snapshot) {
  const first = (kind) => snapshot.events.find((event) => event.kind === kind)?.at ?? null
  const relevantRequests = snapshot.events.filter((event) => event.kind === 'idb-request-success')
  const requestGroups = new Map()
  for (const event of relevantRequests) {
    const key = `${event.detail.store}.${event.detail.method}`
    const current = requestGroups.get(key) ?? []
    current.push(event)
    requestGroups.set(key, current)
  }
  const runningAt = first('runtime-running')
  const bodyAt = first('terminal-body')
  return {
    milestones: Object.fromEntries(
      [
        'dom-content-loaded',
        'window-load',
        'shell-observed',
        'early-message-list-start',
        'early-message-list-ready',
        'runtime-running',
        'conversation-loading',
        'message-list',
        'terminal-article',
        'terminal-body',
        'terminal-markdown',
        'terminal-next-frame',
        'terminal-next-painted-frame',
      ].map((kind) => [kind, first(kind)]),
    ),
    runningToTerminalBodyMs:
      runningAt === null || bodyAt === null ? null : Number((bodyAt - runningAt).toFixed(3)),
    idb: Object.fromEntries(
      [...requestGroups.entries()].map(([key, events]) => {
        const durations = events.map((event) => event.detail.duration).sort((a, b) => a - b)
        return [
          key,
          {
            count: events.length,
            firstSuccessAt: events[0].at,
            lastSuccessAt: events.at(-1).at,
            medianDuration: durations[Math.floor(durations.length / 2)],
            maxDuration: Math.max(...durations),
          },
        ]
      }),
    ),
    terminalRequests: relevantRequests
      .filter(
        (event) =>
          event.detail.key.includes(GENERATED_WORKSPACE_ACTIVE_TERMINAL_ID) ||
          event.detail.store === 'messageBodies',
      )
      .map((event) => ({ at: event.at, ...event.detail })),
    resources: snapshot.resources.filter(
      (resource) =>
        resource.name?.startsWith('MessageList-') ||
        resource.name?.startsWith('ToolEvidenceBlock-') ||
        resource.name?.startsWith('virtual-spacer-') ||
        resource.name?.startsWith('browser-workspace-compaction-') ||
        resource.name?.startsWith('browser-workspace-replacement-runner-'),
    ),
    longTasks: snapshot.events
      .filter((event) => event.kind === 'long-task')
      .map((event) => event.detail),
    totals: snapshot.counters,
  }
}

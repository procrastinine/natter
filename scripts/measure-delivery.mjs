import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const baseline = JSON.parse(readFileSync(join(root, 'scripts/performance-baseline.json'), 'utf8'))
const [kind, target] = process.argv.slice(2)
if (!['preview', 'dev'].includes(kind) || !target) {
  throw new Error('Usage: pnpm perf:delivery <preview|dev> <url>')
}

const budget = baseline.deliveryBudgets.browserMeasurements[kind]
const browser = await chromium.launch({ headless: true })
let report
try {
  const context = await browser.newContext()
  const page = await context.newPage()
  const diagnostics = []
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => diagnostics.push(`page: ${error.message}`))
  page.on('requestfailed', (request) => {
    const failure = request.failure()
    diagnostics.push(
      `request failed: ${request.method()} ${requestPath(request.url())}` +
        (failure ? ` (${failure.errorText})` : ''),
    )
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    diagnostics.push(
      `HTTP ${response.status()}: ${response.request().method()} ${requestPath(response.url())}`,
    )
  })
  const client = await context.newCDPSession(page)
  const startedAt = performance.now()
  await page.goto(target, { waitUntil: 'networkidle' })
  await page.locator('#root > *').first().waitFor()
  const elapsedMs = performance.now() - startedAt
  await client.send('HeapProfiler.enable')
  await client.send('HeapProfiler.collectGarbage')
  const heap = await client.send('Runtime.getHeapUsage')
  const resources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((entry) => {
      const resource = entry
      return {
        name: resource.name,
        transferBytes: resource.transferSize,
        encodedBytes: resource.encodedBodySize,
        decodedBytes: resource.decodedBodySize,
      }
    }),
  )
  const javascript = resources.filter((resource) =>
    /\.(?:js|ts|tsx)(?:$|[?#])/.test(new URL(resource.name).pathname),
  )
  const coldForbiddenRequests = resources
    .map((resource) => new URL(resource.name).pathname)
    .filter((path) =>
      baseline.deliveryBudgets.coldForbiddenPathFragments.some((fragment) =>
        path.includes(fragment),
      ),
    )
  const measurements = {
    resourceCount: resources.length,
    javascriptCount: javascript.length,
    transferBytes: sum(resources, 'transferBytes'),
    encodedBytes: sum(resources, 'encodedBytes'),
    decodedBytes: sum(resources, 'decodedBytes'),
    elapsedMs,
    postGcHeapBytes: heap.usedSize,
  }
  const budgetProblems = Object.entries(budget).flatMap(([field, maximum]) =>
    measurements[field] > maximum
      ? [`${kind} ${field} ${measurements[field]} exceeds budget ${maximum}`]
      : [],
  )
  const hardProblems = []
  if (coldForbiddenRequests.length > 0) {
    hardProblems.push(`cold load fetched lazy features: ${coldForbiddenRequests.join(', ')}`)
  }
  if (diagnostics.length > 0) hardProblems.push(...diagnostics)
  report = {
    schemaVersion: 1,
    kind,
    target,
    measuredAt: new Date().toISOString(),
    budgetRecordedAt: baseline.deliveryBudgets.recordedAt,
    measurements,
    coldForbiddenRequests,
    diagnostics,
    budgetProblems,
    hardProblems,
  }
  await context.close()
} finally {
  await browser.close()
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
if (report.hardProblems.length > 0) process.exitCode = 1

function sum(values, field) {
  return values.reduce((total, value) => total + value[field], 0)
}

function requestPath(value) {
  const url = new URL(value)
  return `${url.origin}${url.pathname}`
}

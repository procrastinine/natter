import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'
import {
  activeWorkspaceDatabaseName,
  assertLoopbackUrl,
  createProviderScenario,
  FAKE_REASONING_SEED,
  FAKE_TEXT_SEED,
  installProfileDurableReasoningObserver,
  monitorScenario,
  navigateToChat,
  openNewChat,
  prepareAdditionalPage,
  repeatedSeedText,
  seedAndRetargetWorkspace,
  startComposerSend,
  startFakeProvider,
  startPreviewServer,
  startRegenerate,
  waitForProviderIdle,
  waitForWorkspaceStreamQuiescence,
} from './profile-stream-harness.mjs'
import { evaluateConcurrentStreamProfile } from './stream-profile-evaluator.mjs'

const DEFAULTS = Object.freeze({
  url: `http://127.0.0.1:${process.env.E2E_PORT ?? '5173'}/`,
  pageCount: 10,
  streamsPerPage: 10,
  contextChars: 100_000,
  targetChars: 100_000,
  reasoningChars: 100_000,
  chunkChars: 128,
  initialDelayMs: 0,
  regenerationCount: 100,
  timeoutMs: 180_000,
  providerUrl: null,
  servePreview: false,
})
const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}
const {
  url,
  pageCount,
  streamsPerPage,
  contextChars,
  targetChars,
  reasoningChars,
  chunkChars,
  initialDelayMs,
  regenerationCount,
  timeoutMs,
  providerUrl,
} = options
const totalStreams = pageCount * streamsPerPage
assertLoopbackUrl(url, 'stress harness')
if (regenerationCount > totalStreams) {
  throw new Error('regenerationCount cannot exceed totalStreams')
}

const preview = options.servePreview ? await startPreviewServer({ appUrl: url, timeoutMs }) : null
let provider
let scenario
let browser
let context
const pages = []
const cdpSessions = []
const consoleProblems = []

try {
  provider = await startFakeProvider({ providerUrl, timeoutMs })
  scenario = await createProviderScenario(provider.origin, generatedConfig(1, 0, 0))
  browser = await chromium.launch({
    headless: true,
    args: ['--enable-precise-memory-info'],
  })
  context = await browser.newContext()

  const firstPage = await createMeasuredPage(0)
  await seedAndRetargetWorkspace(firstPage, {
    appUrl: url,
    providerBaseUrl: scenario.providerBaseUrl,
  })
  await scenario.update(generatedConfig(1, 0, 0))
  await openNewChat(firstPage)
  const seedStarted = performance.now()
  const seedAdmission = await startComposerSend(firstPage, 'concurrency stress seed')
  await waitForProviderIdle(scenario, timeoutMs)
  const [seedState] = await waitForWorkspaceStreamQuiescence(
    firstPage,
    [seedAdmission.assistantMessageId],
    timeoutMs,
  )
  const seed = {
    ...seedAdmission,
    elapsedMs: performance.now() - seedStarted,
    outcome: seedState.status === 'done' ? 'done' : seedState.status,
  }
  for (let index = 1; index < pageCount; index += 1) {
    const page = await createMeasuredPage(index)
    await prepareAdditionalPage(page, { appUrl: url, providerBaseUrl: scenario.providerBaseUrl })
  }
  const baselineHeap = await measureHeap(pages, cdpSessions)

  const previousPhase = await runPhase({
    label: 'previous-turn phase',
    expectedConcurrent: totalStreams,
    config: generatedConfig(contextChars, 0, initialDelayMs),
    start: async (page, pageIndex) => {
      const batch = []
      for (let streamIndex = 0; streamIndex < streamsPerPage; streamIndex += 1) {
        await openNewChat(page)
        batch.push(await startComposerSend(page, `prior turn ${pageIndex}:${streamIndex}`))
      }
      return batch
    },
  })
  const previousBatches = previousPhase.batches
  const previousElapsedMs = previousPhase.elapsedMs
  const afterPreviousHeap = await measureHeap(pages, cdpSessions)
  console.error(`previous-turn phase: ${previousElapsedMs} ms`)

  const currentPhase = await runPhase({
    label: 'current-turn phase',
    expectedConcurrent: totalStreams,
    config: generatedConfig(targetChars, reasoningChars, initialDelayMs),
    start: async (page, pageIndex) => {
      const batch = []
      const previous = previousBatches[pageIndex]
      for (let streamIndex = 0; streamIndex < previous.length; streamIndex += 1) {
        const prior = previous[streamIndex]
        await navigateToChat(page, prior.chatId, prior.assistantMessageId)
        const current = await startComposerSend(page, `next turn ${pageIndex}:${streamIndex}`)
        batch.push({
          ...current,
          previousAssistantMessageId: prior.assistantMessageId,
          previousOutcome: prior.outcome,
        })
      }
      return batch
    },
  })
  const resultBatches = currentPhase.batches
  const results = resultBatches.flat()
  const currentElapsedMs = currentPhase.elapsedMs
  const elapsedMs = previousElapsedMs + currentElapsedMs
  const afterCurrentHeap = await measureHeap(pages, cdpSessions)
  console.error(`current-turn phase: ${currentElapsedMs} ms`)

  let remainingRegenerations = regenerationCount
  const regenerationInputsByPage = resultBatches.map((batch) => {
    const selected = batch.slice(0, remainingRegenerations)
    remainingRegenerations -= selected.length
    return selected.map((result) => ({
      chatId: result.chatId,
      parentUserId: result.userMessageId,
      sourceAssistantId: result.assistantMessageId,
    }))
  })
  const regenerationPhase = await runPhase({
    label: 'regeneration phase',
    expectedConcurrent: regenerationCount,
    config: generatedConfig(targetChars, reasoningChars, initialDelayMs),
    start: async (page, pageIndex) => {
      const batch = []
      for (const input of regenerationInputsByPage[pageIndex]) {
        await navigateToChat(page, input.chatId, input.sourceAssistantId)
        const regenerated = await startRegenerate(page, input.sourceAssistantId)
        batch.push({
          ...regenerated,
          parentUserId: input.parentUserId,
          sourceAssistantId: input.sourceAssistantId,
        })
      }
      return batch
    },
  })
  const regenerationBatches = regenerationPhase.batches
  const regenerations = regenerationBatches.flat()
  const regenerationElapsedMs = regenerationPhase.elapsedMs
  const afterRegenerationHeap =
    regenerations.length > 0 ? await measureHeap(pages, cdpSessions) : afterCurrentHeap
  if (regenerations.length > 0) {
    console.error(`regeneration phase: ${regenerationElapsedMs} ms`)
  }
  const assistantIds = results.map((result) => result.assistantMessageId)
  const userIds = results.map((result) => result.userMessageId)
  const previousAssistantIds = results.map((result) => result.previousAssistantMessageId)
  const chatIds = results.map((result) => result.chatId)

  const beforeReload = await verifyStored(pages[0], {
    assistantIds,
    userIds,
    previousAssistantIds,
    chatIds,
    regenerations,
    expectedContextHash: hashText(repeatedSeedText(FAKE_TEXT_SEED, contextChars)),
    expectedTextHash: hashText(repeatedSeedText(FAKE_TEXT_SEED, targetChars)),
    expectedReasoningHash: hashText(repeatedSeedText(FAKE_REASONING_SEED, reasoningChars)),
    contextChars,
    targetChars,
    reasoningChars,
  })
  const pageStates = await Promise.all(pages.map((page) => collectPageState(page)))

  await withinTimeout(
    Promise.all(pages.map((page) => page.reload({ waitUntil: 'domcontentloaded' }))),
    'reload phase',
    timeoutMs,
  )
  await Promise.all(pages.map((page) => page.locator('#root > *').first().waitFor()))
  const afterReloadHeap = await measureHeap(pages, cdpSessions)
  const afterReload = await verifyStored(pages[0], {
    assistantIds,
    userIds,
    previousAssistantIds,
    chatIds,
    regenerations,
    expectedContextHash: hashText(repeatedSeedText(FAKE_TEXT_SEED, contextChars)),
    expectedTextHash: hashText(repeatedSeedText(FAKE_TEXT_SEED, targetChars)),
    expectedReasoningHash: hashText(repeatedSeedText(FAKE_REASONING_SEED, reasoningChars)),
    contextChars,
    targetChars,
    reasoningChars,
  })

  const failures = []
  if (results.length !== totalStreams)
    failures.push(`result count ${results.length}/${totalStreams}`)
  for (const result of results) {
    if (result.previousOutcome !== 'done') {
      failures.push(
        `${result.previousAssistantMessageId}: previous outcome ${result.previousOutcome}`,
      )
    }
    if (result.outcome !== 'done') {
      failures.push(`${result.assistantMessageId}: outcome ${result.outcome}`)
    }
  }
  for (const regeneration of regenerations) {
    if (regeneration.outcome !== 'done') {
      failures.push(
        `${regeneration.assistantMessageId}: regeneration outcome ${regeneration.outcome}`,
      )
    }
  }
  failures.push(...beforeReload.failures.map((failure) => `before reload: ${failure}`))
  failures.push(...afterReload.failures.map((failure) => `after reload: ${failure}`))
  for (const [index, state] of pageStates.entries()) {
    if (state.streamStore.activeCount !== 0) {
      failures.push(`page ${index}: ${state.streamStore.activeCount} active streams remain`)
    }
    if (state.streamStore.liveSnapshotCount !== 0) {
      failures.push(`page ${index}: ${state.streamStore.liveSnapshotCount} live snapshots remain`)
    }
  }
  for (const [label, phase] of [
    ['previous-turn', previousPhase],
    ['current-turn', currentPhase],
    ['regeneration', regenerationPhase],
  ]) {
    failures.push(...phase.applicationAdmission.failures.map((failure) => `${label}: ${failure}`))
  }
  if (consoleProblems.length > 0) failures.push(`${consoleProblems.length} console problems`)

  const report = {
    schemaVersion: 2,
    measurementModel: 'external-http-ui-v1',
    scenario: {
      pageCount,
      streamsPerPage,
      totalStreams,
      contextChars,
      targetChars,
      reasoningChars,
      chunkChars,
      initialDelayMs,
      regenerationCount,
      timeoutMs,
      providerOwned: provider.owned,
      totalPersistedChars:
        totalStreams * (contextChars + targetChars + reasoningChars) +
        regenerationCount * (targetChars + reasoningChars),
    },
    elapsedMs,
    phaseElapsedMs: {
      previousTurn: previousElapsedMs,
      currentTurn: currentElapsedMs,
      regeneration: regenerationElapsedMs,
    },
    providerPhases: {
      previousTurn: previousPhase.provider,
      currentTurn: currentPhase.provider,
      regeneration: regenerationPhase.provider,
    },
    applicationAdmissionPhases: {
      previousTurn: previousPhase.applicationAdmission,
      currentTurn: currentPhase.applicationAdmission,
      regeneration: regenerationPhase.applicationAdmission,
    },
    seed: {
      chatId: seed.chatId,
      assistantMessageId: seed.assistantMessageId,
      outcome: seed.outcome,
    },
    resultCounts: countBy(results, (result) => result.outcome),
    regenerationResultCounts: countBy(regenerations, (result) => result.outcome),
    heap: {
      baseline: baselineHeap,
      afterPrevious: afterPreviousHeap,
      afterCurrent: afterCurrentHeap,
      afterRegeneration: afterRegenerationHeap,
      afterReload: afterReloadHeap,
    },
    beforeReload,
    afterReload,
    pageStates: pageStates.map((state) => state.streamStore),
    consoleProblems,
    failures,
  }
  const evaluation = evaluateConcurrentStreamProfile(report)
  console.log(JSON.stringify({ ...report, evaluation }, null, 2))
  if (evaluation.status !== 'pass') process.exitCode = 1
} finally {
  await browser?.close()
  await scenario?.dispose().catch(() => undefined)
  await provider?.stop()
  await preview?.stop()
}

async function createMeasuredPage(index) {
  const page = await context.newPage()
  await page.addInitScript(installProfileDurableReasoningObserver)
  page.setDefaultTimeout(timeoutMs)
  page.setDefaultNavigationTimeout(timeoutMs)
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleProblems.push({ page: index, type: message.type(), text: message.text() })
    }
  })
  page.on('pageerror', (error) => {
    consoleProblems.push({ page: index, type: 'pageerror', text: error.message })
  })
  pages.push(page)
  cdpSessions.push(await context.newCDPSession(page))
  return page
}

function generatedConfig(textChars, hiddenReasoningChars, admissionDelayMs) {
  return {
    targetChars: textChars,
    reasoningChars: hiddenReasoningChars,
    chunkChars,
    reasoningChunkChars: chunkChars,
    initialDelayMs: admissionDelayMs,
    delayMs: 0,
  }
}

async function runPhase({ label, expectedConcurrent, config, start }) {
  if (expectedConcurrent === 0) {
    const final = await scenario.update(config)
    return {
      batches: pages.map(() => []),
      elapsedMs: 0,
      expectedConcurrent,
      applicationAdmission: {
        expected: 0,
        observed: 0,
        statuses: {},
        failures: [],
      },
      provider: { maxActiveStreams: 0, samples: 0, final },
    }
  }
  await scenario.update({ ...config, holdUntilReleased: true })
  const monitor = monitorScenario(scenario, 5)
  const startedAt = performance.now()
  let batches
  let admissions
  let applicationAdmission
  try {
    batches = await withinTimeout(
      Promise.all(pages.map((page, pageIndex) => start(page, pageIndex))),
      `${label} admission`,
      timeoutMs,
    )
    admissions = batches.flat()
    applicationAdmission = await readApplicationAdmission(
      pages[0],
      admissions.map((entry) => entry.assistantMessageId),
    )
  } finally {
    await scenario.release().catch(() => undefined)
  }
  await waitForProviderIdle(scenario, timeoutMs)
  const states = await waitForWorkspaceStreamQuiescence(
    pages[0],
    admissions.map((entry) => entry.assistantMessageId),
    timeoutMs,
  )
  const providerEvidence = await monitor.stop()
  const byId = new Map(states.map((state) => [state.id, state]))
  const settledBatches = batches.map((batch) =>
    batch.map((entry) => {
      const state = byId.get(entry.assistantMessageId)
      return {
        ...entry,
        outcome: state?.status === 'done' ? 'done' : (state?.status ?? 'missing'),
      }
    }),
  )
  return {
    batches: settledBatches,
    elapsedMs: performance.now() - startedAt,
    expectedConcurrent,
    applicationAdmission,
    provider: providerEvidence,
  }
}

async function readApplicationAdmission(page, assistantIds) {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, expectedIds }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const transaction = db.transaction('streamLeases', 'readonly')
        const leases = await new Promise((resolve, reject) => {
          const request = transaction.objectStore('streamLeases').getAll()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        await new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve()
          transaction.onerror = () => reject(transaction.error)
          transaction.onabort = () => reject(transaction.error)
        })
        const expected = new Set(expectedIds)
        const owned = leases.filter((lease) => expected.has(lease.targetOwnerKey))
        const statuses = {}
        const observed = new Set()
        const failures = []
        for (const lease of owned) {
          statuses[lease.phase] = (statuses[lease.phase] ?? 0) + 1
          if (lease.targetOwnerKey !== lease.messageId) {
            failures.push(`${lease.messageId}: target owner mismatch`)
          }
          if (lease.phase !== 'reserved' && lease.phase !== 'active') {
            failures.push(`${lease.messageId}: admission phase ${lease.phase}`)
          }
          if (observed.has(lease.messageId)) {
            failures.push(`${lease.messageId}: duplicate admission lease`)
          }
          observed.add(lease.messageId)
        }
        for (const id of expected) {
          if (!observed.has(id)) failures.push(`${id}: missing admission lease`)
        }
        return {
          expected: expected.size,
          observed: observed.size,
          statuses,
          failures,
        }
      } finally {
        db.close()
      }
    },
    { databaseName, expectedIds: assistantIds },
  )
}

async function collectPageState(page) {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(async (databaseName) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const requestResult = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    try {
      const transaction = db.transaction(['messages', 'streamLeases', 'streamChunks'], 'readonly')
      const [messages, leases, chunkCount] = await Promise.all([
        requestResult(transaction.objectStore('messages').getAll()),
        requestResult(transaction.objectStore('streamLeases').getAll()),
        requestResult(transaction.objectStore('streamChunks').count()),
      ])
      const active = messages.filter((message) => message.generation?.status === 'streaming')
      return {
        streamStore: {
          activeCount: active.length,
          activeTargets: active.map((message) => ({
            chatId: message.chatId,
            messageId: message.id,
          })),
          liveSnapshotCount: leases.length,
          liveTextLength: null,
          liveReasoningLength: null,
          streamChunkCount: chunkCount,
          visibleStopButtons: document.querySelectorAll('[data-ui="abort"]').length,
          evidenceSource: 'dom-indexeddb',
        },
      }
    } finally {
      db.close()
    }
  }, databaseName)
}

function parseArgs(args) {
  const parsed = { ...DEFAULTS, help: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--help' || argument === '-h') {
      parsed.help = true
      continue
    }
    if (argument === '--serve-preview') {
      parsed.servePreview = true
      continue
    }
    if (!argument.startsWith('--')) {
      throw new Error(`unexpected positional argument: ${argument}`)
    }

    const equalsIndex = argument.indexOf('=')
    const name = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex)
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1)
    const value = inlineValue ?? args[index + 1]
    if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`${name} requires a value`)
    }
    if (inlineValue === undefined) index += 1

    switch (name) {
      case '--url':
        parsed.url = value
        break
      case '--provider-url':
        parsed.providerUrl = value
        break
      case '--pages':
        parsed.pageCount = integerArg(value, 'pages')
        break
      case '--streams-per-page':
        parsed.streamsPerPage = integerArg(value, 'streams-per-page')
        break
      case '--context-chars':
        parsed.contextChars = integerArg(value, 'context-chars', true)
        break
      case '--target-chars':
        parsed.targetChars = integerArg(value, 'target-chars')
        break
      case '--reasoning-chars':
        parsed.reasoningChars = integerArg(value, 'reasoning-chars', true)
        break
      case '--chunk-chars':
        parsed.chunkChars = integerArg(value, 'chunk-chars')
        break
      case '--initial-delay-ms':
        parsed.initialDelayMs = integerArg(value, 'initial-delay-ms', true)
        break
      case '--regenerations':
        parsed.regenerationCount = integerArg(value, 'regenerations', true)
        break
      case '--timeout-ms':
        parsed.timeoutMs = integerArg(value, 'timeout-ms')
        break
      default:
        throw new Error(`unknown option: ${name}`)
    }
  }
  return parsed
}

function printHelp() {
  console.log(`Usage: pnpm run perf:stream:concurrent -- [options]

Profiles concurrent fake streams through the real generation runner and IndexedDB journal,
then verifies persisted hashes, multi-turn and regeneration branch shape, journal cleanup,
heap use, and post-reload data. The default scenario persists 30M characters before adding
100 regeneration siblings for a 50M-character total.

Options:
  --url <url>                 Loopback app URL (default: ${DEFAULTS.url})
  --provider-url <url>        Reuse an explicit loopback fake-provider origin
  --serve-preview             Start and stop the already-built Vite preview
  --pages <count>             Browser pages (default: ${DEFAULTS.pageCount})
  --streams-per-page <count>  Streams on each page (default: ${DEFAULTS.streamsPerPage})
  --context-chars <count>     Prior assistant text per stream (default: ${DEFAULTS.contextChars})
  --target-chars <count>      Current or regenerated text (default: ${DEFAULTS.targetChars})
  --reasoning-chars <count>   Current or regenerated reasoning (default: ${DEFAULTS.reasoningChars})
  --chunk-chars <count>       Fake provider chunk size (default: ${DEFAULTS.chunkChars})
  --initial-delay-ms <ms>     Reported UI-admission barrier (default: ${DEFAULTS.initialDelayMs})
  --regenerations <count>     Regeneration siblings (default: ${DEFAULTS.regenerationCount})
  --timeout-ms <ms>           Timeout per long-running phase (default: ${DEFAULTS.timeoutMs})
  -h, --help                  Show this help`)
}

async function withinTimeout(promise, label, timeoutMs) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} exceeded the ${timeoutMs} ms timeout`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

function integerArg(raw, name, allowZero = false) {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  return value
}

function countBy(values, keyOf) {
  const counts = {}
  for (const value of values) {
    const key = keyOf(value)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function hashText(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function measureHeap(_pages, sessions) {
  await Promise.all(sessions.map((session) => session.send('HeapProfiler.collectGarbage')))
  const measurements = await Promise.all(
    sessions.map(async (session) => {
      const [heap, dom] = await Promise.all([
        session.send('Runtime.getHeapUsage'),
        session.send('Memory.getDOMCounters'),
      ])
      return { heap, dom }
    }),
  )
  const used = measurements.map((measurement) => measurement.heap.usedSize)
  const total = measurements.map((measurement) => measurement.heap.totalSize)
  return {
    measuredPages: used.length,
    usedBytes: used.reduce((sum, value) => sum + value, 0),
    maxPageUsedBytes: used.length > 0 ? Math.max(...used) : null,
    totalHeapBytes: total.reduce((sum, value) => sum + value, 0),
    documents: measurements.reduce((sum, measurement) => sum + measurement.dom.documents, 0),
    nodes: measurements.reduce((sum, measurement) => sum + measurement.dom.nodes, 0),
    listeners: measurements.reduce((sum, measurement) => sum + measurement.dom.jsEventListeners, 0),
  }
}

async function verifyStored(page, expected) {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, input }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const transaction = db.transaction(
        ['chats', 'messages', 'messageBodies', 'streamLeases', 'streamChunks'],
        'readonly',
      )
      const get = (store, key) =>
        new Promise((resolve, reject) => {
          const request = transaction.objectStore(store).get(key)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const count = (store) =>
        new Promise((resolve, reject) => {
          const request = transaction.objectStore(store).count()
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const countIndex = (store, index, key) =>
        new Promise((resolve, reject) => {
          const request = transaction.objectStore(store).index(index).count(key)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const sha256 = async (text) => {
        const bytes = new TextEncoder().encode(text)
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        return [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
      }
      const durableReasoningText = globalThis.__natterProfileDurableReasoningText
      if (typeof durableReasoningText !== 'function') {
        throw new Error('profile durable reasoning observer is unavailable')
      }
      const rowsPromise = Promise.all(
        input.assistantIds.map(async (assistantId, index) => {
          const previousAssistantId = input.previousAssistantIds[index]
          const userId = input.userIds[index]
          const [header, body, userHeader, previousHeader, previousBody, chat] = await Promise.all([
            get('messages', assistantId),
            get('messageBodies', assistantId),
            get('messages', userId),
            get('messages', previousAssistantId),
            get('messageBodies', previousAssistantId),
            get('chats', input.chatIds[index]),
          ])
          const context =
            previousBody?.content
              ?.filter((item) => item?.type === 'text' || item?.type === 'output_text')
              .map((item) => item.text ?? '')
              .join('') ?? ''
          const text =
            body?.content
              ?.filter((item) => item?.type === 'text' || item?.type === 'output_text')
              .map((item) => item.text ?? '')
              .join('') ?? ''
          const reasoning = durableReasoningText(body)
          return {
            assistantId,
            previousHeaderExists: Boolean(previousHeader),
            previousBodyExists: Boolean(previousBody),
            userHeaderExists: Boolean(userHeader),
            headerExists: Boolean(header),
            bodyExists: Boolean(body),
            chatExists: Boolean(chat),
            bodyVersionsMatch: header?.bodyVersion === body?.bodyVersion,
            previousBodyVersionsMatch: previousHeader?.bodyVersion === previousBody?.bodyVersion,
            multiTurnParentsMatch:
              userHeader?.parentId === previousAssistantId && header?.parentId === userId,
            previousStatus: previousHeader?.generation?.status,
            previousIntegrity: previousHeader?.generation?.integrity,
            status: header?.generation?.status,
            integrity: header?.generation?.integrity,
            contextLength: context.length,
            textLength: text.length,
            reasoningLength: reasoning.length,
            contextHash: await sha256(context),
            textHash: await sha256(text),
            reasoningHash: await sha256(reasoning),
          }
        }),
      )
      const regenerationRowsPromise = Promise.all(
        input.regenerations.map(async (regeneration) => {
          const [header, body, sourceHeader, parentHeader, messageCount] = await Promise.all([
            get('messages', regeneration.assistantMessageId),
            get('messageBodies', regeneration.assistantMessageId),
            get('messages', regeneration.sourceAssistantId),
            get('messages', regeneration.parentUserId),
            countIndex('messages', 'chatId', regeneration.chatId),
          ])
          const text =
            body?.content
              ?.filter((item) => item?.type === 'text' || item?.type === 'output_text')
              .map((item) => item.text ?? '')
              .join('') ?? ''
          const reasoning = durableReasoningText(body)
          return {
            assistantId: regeneration.assistantMessageId,
            headerExists: Boolean(header),
            bodyExists: Boolean(body),
            sourceHeaderExists: Boolean(sourceHeader),
            parentHeaderExists: Boolean(parentHeader),
            bodyVersionsMatch: header?.bodyVersion === body?.bodyVersion,
            branchShapeMatches:
              header?.parentId === regeneration.parentUserId &&
              sourceHeader?.parentId === regeneration.parentUserId &&
              header?.id !== sourceHeader?.id &&
              header?.siblingIndex !== sourceHeader?.siblingIndex,
            parentRole: parentHeader?.role,
            status: header?.generation?.status,
            integrity: header?.generation?.integrity,
            messageCount,
            textLength: text.length,
            reasoningLength: reasoning.length,
            textHash: await sha256(text),
            reasoningHash: await sha256(reasoning),
          }
        }),
      )
      const [rows, regenerationRows] = await Promise.all([rowsPromise, regenerationRowsPromise])
      const [leaseCount, chunkCount] = await Promise.all([
        count('streamLeases'),
        count('streamChunks'),
      ])
      await new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
      db.close()

      const failures = []
      for (const row of rows) {
        if (!row.headerExists) failures.push(`${row.assistantId}: missing header`)
        if (!row.bodyExists) failures.push(`${row.assistantId}: missing body`)
        if (!row.previousHeaderExists) failures.push(`${row.assistantId}: missing previous header`)
        if (!row.previousBodyExists)
          failures.push(`${row.assistantId}: missing previous context body`)
        if (!row.userHeaderExists) failures.push(`${row.assistantId}: missing current user header`)
        if (!row.chatExists) failures.push(`${row.assistantId}: missing chat`)
        if (!row.bodyVersionsMatch)
          failures.push(`${row.assistantId}: header/body version mismatch`)
        if (!row.previousBodyVersionsMatch) {
          failures.push(`${row.assistantId}: previous header/body version mismatch`)
        }
        if (!row.multiTurnParentsMatch)
          failures.push(`${row.assistantId}: broken multi-turn parent chain`)
        if (row.previousStatus !== 'done') {
          failures.push(`${row.assistantId}: previous status ${row.previousStatus}`)
        }
        if (row.previousIntegrity !== 'clean') {
          failures.push(`${row.assistantId}: previous integrity ${row.previousIntegrity}`)
        }
        if (row.status !== 'done') failures.push(`${row.assistantId}: status ${row.status}`)
        if (row.integrity !== 'clean')
          failures.push(`${row.assistantId}: integrity ${row.integrity}`)
        if (row.contextLength !== input.contextChars) {
          failures.push(
            `${row.assistantId}: context length ${row.contextLength}/${input.contextChars}`,
          )
        }
        if (row.textLength !== input.targetChars) {
          failures.push(`${row.assistantId}: text length ${row.textLength}/${input.targetChars}`)
        }
        if (row.reasoningLength !== input.reasoningChars) {
          failures.push(
            `${row.assistantId}: reasoning length ${row.reasoningLength}/${input.reasoningChars}`,
          )
        }
        if (row.textHash !== input.expectedTextHash) failures.push(`${row.assistantId}: text hash`)
        if (row.contextHash !== input.expectedContextHash) {
          failures.push(`${row.assistantId}: context hash`)
        }
        if (row.reasoningHash !== input.expectedReasoningHash) {
          failures.push(`${row.assistantId}: reasoning hash`)
        }
      }
      for (const row of regenerationRows) {
        if (!row.headerExists) failures.push(`${row.assistantId}: missing regeneration header`)
        if (!row.bodyExists) failures.push(`${row.assistantId}: missing regeneration body`)
        if (!row.sourceHeaderExists) failures.push(`${row.assistantId}: missing source sibling`)
        if (!row.parentHeaderExists) failures.push(`${row.assistantId}: missing shared parent`)
        if (!row.bodyVersionsMatch) {
          failures.push(`${row.assistantId}: regeneration header/body version mismatch`)
        }
        if (!row.branchShapeMatches) failures.push(`${row.assistantId}: copied or malformed branch`)
        if (row.parentRole !== 'user')
          failures.push(`${row.assistantId}: parent role ${row.parentRole}`)
        if (row.status !== 'done') failures.push(`${row.assistantId}: status ${row.status}`)
        if (row.integrity !== 'clean')
          failures.push(`${row.assistantId}: integrity ${row.integrity}`)
        if (row.messageCount !== 5) {
          failures.push(`${row.assistantId}: chat message count ${row.messageCount}/5`)
        }
        if (row.textLength !== input.targetChars) {
          failures.push(`${row.assistantId}: text length ${row.textLength}/${input.targetChars}`)
        }
        if (row.reasoningLength !== input.reasoningChars) {
          failures.push(
            `${row.assistantId}: reasoning length ${row.reasoningLength}/${input.reasoningChars}`,
          )
        }
        if (row.textHash !== input.expectedTextHash) failures.push(`${row.assistantId}: text hash`)
        if (row.reasoningHash !== input.expectedReasoningHash) {
          failures.push(`${row.assistantId}: reasoning hash`)
        }
      }
      if (leaseCount !== 0) failures.push(`${leaseCount} stream leases remain`)
      if (chunkCount !== 0) failures.push(`${chunkCount} stream chunks remain`)
      return {
        checkedRows: rows.length,
        leaseCount,
        chunkCount,
        contextBytesChecked: rows.reduce((sum, row) => sum + row.contextLength, 0),
        textBytesChecked: rows.reduce((sum, row) => sum + row.textLength, 0),
        reasoningBytesChecked: rows.reduce((sum, row) => sum + row.reasoningLength, 0),
        regenerationRowsChecked: regenerationRows.length,
        regenerationTextBytesChecked: regenerationRows.reduce(
          (sum, row) => sum + row.textLength,
          0,
        ),
        regenerationReasoningBytesChecked: regenerationRows.reduce(
          (sum, row) => sum + row.reasoningLength,
          0,
        ),
        failures,
      }
    },
    { databaseName, input: expected },
  )
}

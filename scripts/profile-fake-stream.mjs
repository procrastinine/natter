import { chromium } from '@playwright/test'
import {
  activeWorkspaceDatabaseName,
  assertLoopbackUrl,
  createProviderScenario,
  installProfileDurableReasoningObserver,
  monitorScenario,
  navigateToChat,
  openNewChat,
  seedAndRetargetWorkspace,
  startComposerSend,
  startFakeProvider,
  startPreviewServer,
  startRegenerate,
  waitForProviderIdle,
  waitForWorkspaceStreamQuiescence,
} from './profile-stream-harness.mjs'
import { evaluateStreamProfile, streamProfilePhaseLabel } from './stream-profile-evaluator.mjs'

const DEFAULTS = Object.freeze({
  url: `http://127.0.0.1:${process.env.E2E_PORT ?? '5173'}/`,
  regenCount: 5,
  targetChars: 100_000,
  turnCount: 10,
  reloadCount: 2,
  surfaceCycleCount: 3,
  chunkChars: 128,
  timeoutMs: 60_000,
  providerUrl: null,
  servePreview: false,
})
const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}
assertLoopbackUrl(options.url, 'profile-fake-stream')

const preview = options.servePreview
  ? await startPreviewServer({ appUrl: options.url, timeoutMs: options.timeoutMs })
  : null
let provider
let scenario
let browser
let page
let client
let workspaceDatabaseName

try {
  provider = await startFakeProvider({
    providerUrl: options.providerUrl,
    timeoutMs: options.timeoutMs,
  })
  scenario = await createProviderScenario(provider.origin, streamConfig(options, 2, 0, 0))
  browser = await chromium.launch({
    headless: true,
    args: ['--js-flags=--expose-gc'],
  })
  page = await browser.newPage()
  await page.addInitScript(installProfileIdbActivityProbe)
  await page.addInitScript(installProfileDurableReasoningObserver)
  page.setDefaultTimeout(options.timeoutMs)
  page.setDefaultNavigationTimeout(options.timeoutMs)
  client = await page.context().newCDPSession(page)

  await seedAndRetargetWorkspace(page, {
    appUrl: options.url,
    providerBaseUrl: scenario.providerBaseUrl,
  })
  workspaceDatabaseName = await activeWorkspaceDatabaseName(page)
  await waitForProfileIdbIdle()

  const samples = [await heap({ kind: 'fresh' })]
  const turns = []
  await openNewChat(page)
  const firstRun = await runGeneration({
    mode: 'send',
    prompt: 'large turn 1',
    label: 'turn 1',
    config: streamConfig(options, options.targetChars, 0),
  })
  const first = firstRun.result
  turns.push(first)
  samples.push(await heap({ kind: 'turn-settled', ordinal: 1 }))

  for (let index = 1; index < options.turnCount; index += 1) {
    const profiled = index === options.turnCount - 1 && options.targetChars > 100_000
    const turn = await runGeneration({
      mode: 'send',
      prompt: `large turn ${index + 1}`,
      label: `turn ${index + 1}`,
      config: streamConfig(options, options.targetChars, profiled ? 1 : 0),
      ...(profiled
        ? {
            midPhase: { kind: 'turn-active', ordinal: index + 1 },
            minVisibleTextLength: Math.min(options.targetChars, 120_000),
          }
        : {}),
    })
    turns.push(turn.result)
    if (turn.midSample) samples.push(turn.midSample)
    samples.push(await heap({ kind: 'turn-settled', ordinal: index + 1 }))
  }

  const regenerations = []
  let sourceAssistantId = turns.at(-1).assistantMessageId
  for (let index = 0; index < options.regenCount; index += 1) {
    const regeneration = await runGeneration({
      mode: 'regenerate',
      sourceAssistantId,
      label: `regeneration ${index + 1}`,
      config: streamConfig(options, options.targetChars, 0),
    })
    regenerations.push(regeneration.result)
    sourceAssistantId = regeneration.result.assistantMessageId
    samples.push(await heap({ kind: 'regeneration-settled', ordinal: index + 1 }))
  }

  const activeLeafId = sourceAssistantId
  await expandTranscriptDemand()
  const preReleasePhase = { kind: 'pre-release' }
  samples.push(await heap(preReleasePhase))
  const beforeRecycleState = await collectStoreState(first.chatId)
  const storeStates = [profiledStoreState(preReleasePhase, beforeRecycleState)]
  const previousMessageList = await page.locator('[data-ui="message-list"]').elementHandle()
  if (!previousMessageList) throw new Error('cannot recycle a transcript without a message list')
  try {
    await page.evaluate(() => {
      location.hash = '#/'
    })
    await page.waitForFunction((previous) => !previous.isConnected, previousMessageList)
    await navigateToChat(page, first.chatId, activeLeafId)
    await page
      .locator('[data-ui="main-pane"][data-active-surface-ready="true"]')
      .waitFor({ state: 'visible' })
  } finally {
    await previousMessageList.dispose()
  }
  const recycledPhase = { kind: 'recycled' }
  samples.push(await heap(recycledPhase))
  storeStates.push(profiledStoreState(recycledPhase, await collectStoreState(first.chatId)))

  for (let index = 0; index < options.surfaceCycleCount; index += 1) {
    const cycle = index + 1
    await selectConversationSurface('tree')
    const treePhase = { kind: 'surface', surface: 'tree', cycle }
    samples.push(await heap(treePhase))
    storeStates.push(profiledStoreState(treePhase, await collectStoreState(first.chatId)))

    await selectConversationSurface('transcript')
    const transcriptPhase = { kind: 'surface', surface: 'transcript', cycle }
    samples.push(await heap(transcriptPhase))
    storeStates.push(profiledStoreState(transcriptPhase, await collectStoreState(first.chatId)))
  }

  for (let index = 0; index < options.reloadCount; index += 1) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('[data-ui="message-list"]').waitFor({ state: 'visible' })
    await page
      .locator('[data-ui="main-pane"][data-active-surface-ready="true"]')
      .waitFor({ state: 'visible' })
    const reloadPhase = { kind: 'reload', ordinal: index + 1 }
    samples.push(await heap(reloadPhase))
    storeStates.push(profiledStoreState(reloadPhase, await collectStoreState(first.chatId)))
  }

  const failures = []
  for (const result of [...turns, ...regenerations.map((entry) => entry.result ?? entry)]) {
    if (result.outcome !== 'done') failures.push(`${result.assistantMessageId}: ${result.outcome}`)
  }
  const report = {
    schemaVersion: 2,
    measurementModel: 'external-http-ui-v1',
    scenario: {
      regenCount: options.regenCount,
      targetChars: options.targetChars,
      reasoningChars: options.reasoningChars,
      turnCount: options.turnCount,
      reloadCount: options.reloadCount,
      surfaceCycleCount: options.surfaceCycleCount,
      chunkChars: options.chunkChars,
      providerOwned: provider.owned,
      recycleMethod: 'route-away-and-back-plus-transcript-tree-cycles',
    },
    residentHeapCaptureOrder: ['storage-evidence', 'forced-gc', 'heap-and-dom'],
    first: {
      elapsedMs: first.elapsedMs,
      chatId: first.chatId,
      userMessageId: first.userMessageId,
      assistantMessageId: first.assistantMessageId,
    },
    turnElapsedMs: turns.map((turn) => turn.elapsedMs),
    regenElapsedMs: regenerations.map((entry) => entry.elapsedMs),
    samples,
    storeStates,
    failures,
  }
  const evaluation = evaluateStreamProfile(report)
  console.log(JSON.stringify({ ...report, evaluation }, null, 2))
  if (failures.length > 0 || evaluation.status === 'fail') process.exitCode = 1
} finally {
  await browser?.close()
  await scenario?.dispose().catch(() => undefined)
  await provider?.stop()
  await preview?.stop()
}

function streamConfig(
  profileOptions,
  targetChars,
  delayMs,
  reasoningChars = profileOptions.reasoningChars,
) {
  return {
    targetChars,
    reasoningChars,
    chunkChars: profileOptions.chunkChars,
    reasoningChunkChars: profileOptions.chunkChars,
    initialDelayMs: 0,
    delayMs,
  }
}

async function runGeneration({
  mode,
  prompt,
  sourceAssistantId,
  label,
  config,
  midPhase,
  minVisibleTextLength,
}) {
  await scenario.update(config)
  const monitor = monitorScenario(scenario)
  const startedAt = performance.now()
  let admission
  if (mode === 'regenerate') {
    admission = await startRegenerate(page, sourceAssistantId)
  } else {
    admission = await startComposerSend(page, prompt)
  }
  let midSample
  if (midPhase) {
    await page.waitForFunction(
      ({ assistantId, minimum }) => {
        const body = document.querySelector(
          `[data-ui="message"][data-message-id="${assistantId}"] [data-ui="message-body"]`,
        )
        return (body?.textContent?.length ?? 0) >= minimum
      },
      { assistantId: admission.assistantMessageId, minimum: minVisibleTextLength },
    )
    midSample = await heap(midPhase)
  }
  await waitForProviderIdle(scenario, options.timeoutMs)
  const [state] = await waitForWorkspaceStreamQuiescence(
    page,
    [admission.assistantMessageId],
    options.timeoutMs,
  )
  const providerEvidence = await monitor.stop()
  const elapsedMs = performance.now() - startedAt
  const lengths = await readAssistantLengths(admission.assistantMessageId)
  if (lengths.text !== config.targetChars || lengths.reasoning !== config.reasoningChars) {
    throw new Error(
      `${label} persisted text/reasoning ${lengths.text}/${lengths.reasoning}; expected ${config.targetChars}/${config.reasoningChars}`,
    )
  }
  const generationRequests = providerEvidence.final.requests.filter(
    (request) => request.method === 'POST' && request.path === '/chat/completions',
  )
  if (generationRequests.length !== 1) {
    throw new Error(`${label} made ${generationRequests.length} generation requests`)
  }
  const result = {
    ...admission,
    elapsedMs,
    outcome: state.status === 'done' ? 'done' : state.status,
    provider: {
      maxActiveStreams: providerEvidence.maxActiveStreams,
      requestCount: providerEvidence.final.requestCount,
      generationRequestId: generationRequests[0].requestId,
    },
  }
  return midSample ? { result, midSample } : { result }
}

async function heap(phase) {
  await waitForProfileIdbIdle()
  const [browserEvidence, providerEvidence] = await Promise.all([
    collectRuntimeEvidence(),
    scenario.snapshot(),
  ])
  const capture = await captureHeapAndDomAtIdbQuiescence()
  return {
    phase,
    label: streamProfilePhaseLabel(phase),
    usedSize: capture.usage.usedSize,
    totalSize: capture.usage.totalSize,
    dom: capture.dom,
    perf: capture.perf,
    debugState: {
      ...browserEvidence,
      provider: {
        activeStreams: providerEvidence.activeStreams,
        requestCount: providerEvidence.requestCount,
      },
      measurementTransactions: {
        activeBeforeGarbageCollection: capture.beforeGarbageCollection.active,
        activeBeforeCapture: capture.beforeCapture.active,
        activeAfterCapture: capture.afterCapture.active,
        revisionBeforeGarbageCollection: capture.beforeGarbageCollection.revision,
        revisionBeforeCapture: capture.beforeCapture.revision,
        revisionAfterCapture: capture.afterCapture.revision,
        attempts: capture.attempts,
      },
      evidenceSource: 'dom-indexeddb-provider-control',
      unavailableLegacyInternalMetrics: [
        'chatCursorCount',
        'cursorEntryCount',
        'liveSetCount',
        'liveClearCount',
        'maxLiveTextLength',
        'maxLiveReasoningLength',
      ],
    },
  }
}

async function captureHeapAndDomAtIdbQuiescence() {
  const deadline = performance.now() + options.timeoutMs
  for (let attempts = 1; ; attempts += 1) {
    assertProfileDeadline(deadline, 'transaction-quiescent heap capture')
    await waitForProfileIdbIdle(deadline)
    const beforeGarbageCollection = await beforeProfileDeadline(
      profileIdbActivitySnapshot(),
      deadline,
      'transaction activity snapshot before garbage collection',
    )
    if (beforeGarbageCollection.active !== 0) continue
    await beforeProfileDeadline(
      client.send('HeapProfiler.collectGarbage'),
      deadline,
      'forced garbage collection',
    )
    await waitForProfileIdbIdle(deadline)
    const beforeCapture = await beforeProfileDeadline(
      profileIdbActivitySnapshot(),
      deadline,
      'transaction activity snapshot before heap counters',
    )
    if (beforeCapture.active !== 0 || beforeCapture.revision !== beforeGarbageCollection.revision) {
      continue
    }
    const [usage, dom, perf] = await beforeProfileDeadline(
      Promise.all([
        client.send('Runtime.getHeapUsage'),
        client.send('Memory.getDOMCounters'),
        page.evaluate(() => {
          const memory = performance.memory
          return memory
            ? {
                usedJSHeapSize: memory.usedJSHeapSize,
                totalJSHeapSize: memory.totalJSHeapSize,
                jsHeapSizeLimit: memory.jsHeapSizeLimit,
              }
            : {}
        }),
      ]),
      deadline,
      'heap and DOM counter capture',
    )
    const afterCapture = await beforeProfileDeadline(
      profileIdbActivitySnapshot(),
      deadline,
      'transaction activity snapshot after heap counters',
    )
    if (afterCapture.active !== 0 || afterCapture.revision !== beforeGarbageCollection.revision) {
      continue
    }
    return {
      afterCapture,
      attempts,
      beforeCapture,
      beforeGarbageCollection,
      dom,
      perf,
      usage,
    }
  }
}

async function selectConversationSurface(surface) {
  const toggle = page.locator('[data-role="chat-branch-tree"]')
  await toggle.click()
  if (surface === 'tree') {
    await page.locator('[data-ui="branch-tree-view"]').waitFor({ state: 'visible' })
  } else {
    await page.locator('[data-ui="branch-tree-view"]').waitFor({ state: 'hidden' })
    await page.locator('[data-ui="message-list"]').waitFor({ state: 'visible' })
  }
  await page
    .locator('[data-ui="main-pane"][data-active-surface-ready="true"]')
    .waitFor({ state: 'visible' })
}

async function expandTranscriptDemand() {
  const list = page.locator('[data-ui="message-list"]')
  const initial = await list.evaluate((node) => ({
    rendered: Number(node.getAttribute('data-rendered-count') ?? 0),
    total: Number(node.getAttribute('data-total-count') ?? 0),
  }))
  let rendered = initial.rendered
  for (let step = 0; rendered < initial.total; step += 1) {
    if (step > initial.total) throw new Error('transcript demand did not converge')
    const button = page.locator('[data-ui="load-more-messages"]')
    await button.waitFor({ state: 'visible' })
    await button.click()
    const previous = rendered
    await page.waitForFunction(
      ({ previous, total }) => {
        const node = document.querySelector('[data-ui="message-list"]')
        const next = Number(node?.getAttribute('data-rendered-count') ?? 0)
        return next > previous || next === total
      },
      { previous, total: initial.total },
    )
    rendered = await list.evaluate((node) => Number(node.getAttribute('data-rendered-count') ?? 0))
  }
}

function profiledStoreState(phase, state) {
  return {
    phase,
    label: streamProfilePhaseLabel(phase),
    state,
  }
}

async function collectRuntimeEvidence() {
  const databaseName = workspaceDatabaseName
  if (!databaseName) throw new Error('profile workspace database identity is unavailable')
  return page.evaluate(async (databaseName) => {
    const idb = globalThis.__natterProfileIdbActivity
    if (!idb) throw new Error('profile IndexedDB activity probe is unavailable')
    const textLength = (content) =>
      Array.isArray(content)
        ? content.reduce(
            (sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0),
            0,
          )
        : 0
    const durableReasoningText = globalThis.__natterProfileDurableReasoningText
    if (typeof durableReasoningText !== 'function') {
      throw new Error('profile durable reasoning observer is unavailable')
    }
    const db = await idb.openDatabase(databaseName)
    try {
      const transaction = db.transaction(
        ['messages', 'messageBodies', 'streamLeases', 'streamChunks'],
        'readonly',
      )
      const [messages, bodies, leases, chunkCount] = await idb.transactionResult(
        transaction,
        Promise.all([
          idb.requestResult(transaction.objectStore('messages').getAll()),
          idb.requestResult(transaction.objectStore('messageBodies').getAll()),
          idb.requestResult(transaction.objectStore('streamLeases').getAll()),
          idb.requestResult(transaction.objectStore('streamChunks').count()),
        ]),
      )
      const bodyById = new Map(bodies.map((body) => [body.id, body]))
      const active = messages.filter((message) => message.generation?.status === 'streaming')
      const activeChatId = /^#\/chat\/([^/]+)/u.exec(location.hash)?.[1] ?? null
      return {
        chatStore: { chatCursorCount: null, cursorEntryCount: null },
        streamStore: {
          activeCount: active.length,
          activeTargets: active.map((message) => ({
            chatId: message.chatId,
            messageId: message.id,
          })),
          liveSnapshotCount: leases.length,
          liveTextLength: active.reduce(
            (sum, message) => sum + textLength(bodyById.get(message.id)?.content),
            0,
          ),
          liveReasoningLength: active.reduce(
            (sum, message) => sum + durableReasoningText(bodyById.get(message.id)).length,
            0,
          ),
          liveSetCount: null,
          liveClearCount: null,
          maxLiveTextLength: null,
          maxLiveReasoningLength: null,
          streamChunkCount: chunkCount,
        },
        uiStore: { activeChatId },
      }
    } finally {
      db.close()
    }
  }, databaseName)
}

async function collectStoreState(chatId) {
  const databaseName = workspaceDatabaseName
  if (!databaseName) throw new Error('profile workspace database identity is unavailable')
  return page.evaluate(
    async ({ databaseName, id }) => {
      const idb = globalThis.__natterProfileIdbActivity
      if (!idb) throw new Error('profile IndexedDB activity probe is unavailable')
      const list = document.querySelector('[data-ui="message-list"]')
      const tree = document.querySelector('[data-ui="branch-tree-view"]')
      const scrollRegion = document.querySelector('[data-ui="scroll-region"]')
      const isVisible = (node) => Boolean(node && node.getClientRects().length > 0)
      const mountedMessageNodes = [...document.querySelectorAll('[data-ui="message"]')]
      const mountedMessages = mountedMessageNodes.length
      const scrollRegionRect = scrollRegion?.getBoundingClientRect()
      const mountedRows = [...document.querySelectorAll('[data-ui="message-virtual-row"]')].map(
        (node) => {
          const rect = node.getBoundingClientRect()
          return {
            index: Number(node.getAttribute('data-index') ?? -1),
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            intersectsViewport: Boolean(
              scrollRegionRect &&
                rect.bottom > scrollRegionRect.top &&
                rect.top < scrollRegionRect.bottom,
            ),
          }
        },
      )
      const assistantTextLengths = [
        ...document.querySelectorAll(
          '[data-ui="message"][data-role="assistant"] [data-ui="message-body"]',
        ),
      ].map((node) => node.textContent?.length ?? 0)
      const markdownOverflows = [
        ...document.querySelectorAll(
          '[data-ui="message"][data-role="assistant"] [data-ui="markdown"]',
        ),
      ].map((node) => node.getAttribute('data-overflow'))
      const markdownSegments = [
        ...document.querySelectorAll(
          '[data-ui="message"][data-role="assistant"] [data-ui="markdown"]',
        ),
      ].map((node) =>
        [...node.querySelectorAll('[data-ui="markdown-segment"]')].map((segment) => ({
          mode: segment.getAttribute('data-mode'),
          length: Number(segment.getAttribute('data-length') ?? 0),
        })),
      )
      const treePreviewTextChars = [
        ...document.querySelectorAll(
          '[data-ui="branch-tree-node-preview"], [data-ui="branch-tree-preview-text"]',
        ),
      ].reduce((sum, node) => sum + (node.textContent?.length ?? 0), 0)
      const treeInspectorTextChars =
        document.querySelector('[data-ui="branch-tree-inspector-content"]')?.textContent?.length ??
        0
      const db = await idb.openDatabase(databaseName)
      try {
        const transaction = db.transaction(
          ['messages', 'messageBodies', 'streamChunks'],
          'readonly',
        )
        const counts = Object.fromEntries(
          await idb.transactionResult(
            transaction,
            Promise.all(
              ['messages', 'messageBodies', 'streamChunks'].map(async (name) => [
                name,
                await idb.requestResult(transaction.objectStore(name).count()),
              ]),
            ),
          ),
        )
        return {
          chatId: id,
          url: location.href,
          mountedMessages,
          mountedMessageIds: mountedMessageNodes.map((node) =>
            node.getAttribute('data-message-id'),
          ),
          mountedIndices: [...document.querySelectorAll('[data-ui="message-virtual-row"]')].map(
            (node) => Number(node.getAttribute('data-index') ?? -1),
          ),
          mountedRows,
          scrollRegion: scrollRegionRect
            ? {
                top: scrollRegionRect.top,
                bottom: scrollRegionRect.bottom,
                height: scrollRegionRect.height,
                scrollTop: scrollRegion?.scrollTop ?? 0,
                scrollHeight: scrollRegion?.scrollHeight ?? 0,
              }
            : null,
          loadedMessages: Number(list?.getAttribute('data-rendered-count') ?? 0),
          generationContinuityCount: Number(
            list?.getAttribute('data-generation-continuity-count') ?? 0,
          ),
          userScrollRevision: Number(list?.getAttribute('data-user-scroll-revision') ?? 0),
          capturedUserScrollRevision: Number(
            list?.getAttribute('data-generation-captured-user-scroll-revision') ?? -1,
          ),
          layoutAnchorId: list?.getAttribute('data-layout-anchor-id') ?? null,
          historyDemandAnchorId: list?.getAttribute('data-history-demand-anchor-id') ?? null,
          virtualized: list?.getAttribute('data-virtualized') === 'true',
          initialRenderWork: Number(list?.getAttribute('data-initial-render-work') ?? 0),
          totalMessages: Number(list?.getAttribute('data-total-count') ?? 0),
          assistantTextLengths,
          transcriptVisible: isVisible(list),
          treeVisible: isVisible(tree),
          treeNodeCount: document.querySelectorAll('[data-ui="branch-tree-node"]').length,
          treePreviewTextChars,
          treeInspectorTextChars,
          markdownOverflows,
          markdownSegments,
          counts,
        }
      } finally {
        db.close()
      }
    },
    { databaseName, id: chatId },
  )
}

async function readAssistantLengths(messageId) {
  const databaseName = workspaceDatabaseName
  if (!databaseName) throw new Error('profile workspace database identity is unavailable')
  return page.evaluate(
    async ({ databaseName, id }) => {
      const idb = globalThis.__natterProfileIdbActivity
      if (!idb) throw new Error('profile IndexedDB activity probe is unavailable')
      const textLength = (content) =>
        Array.isArray(content)
          ? content.reduce(
              (sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0),
              0,
            )
          : 0
      const durableReasoningText = globalThis.__natterProfileDurableReasoningText
      if (typeof durableReasoningText !== 'function') {
        throw new Error('profile durable reasoning observer is unavailable')
      }
      const db = await idb.openDatabase(databaseName)
      try {
        const transaction = db.transaction('messageBodies', 'readonly')
        const body = await idb.transactionResult(
          transaction,
          idb.requestResult(transaction.objectStore('messageBodies').get(id)),
        )
        return {
          text: textLength(body?.content),
          reasoning: durableReasoningText(body).length,
        }
      } finally {
        db.close()
      }
    },
    { databaseName, id: messageId },
  )
}

async function waitForProfileIdbIdle(deadline = performance.now() + options.timeoutMs) {
  return beforeProfileDeadline(
    page.evaluate(async () => {
      const tracker = globalThis.__natterProfileIdbActivity
      if (!tracker) throw new Error('profile IndexedDB activity probe is unavailable')
      await tracker.whenIdle()
      return tracker.snapshot()
    }),
    deadline,
    'IndexedDB transaction quiescence',
  )
}

async function profileIdbActivitySnapshot() {
  return page.evaluate(() => {
    const tracker = globalThis.__natterProfileIdbActivity
    if (!tracker) throw new Error('profile IndexedDB activity probe is unavailable')
    return tracker.snapshot()
  })
}

function assertProfileDeadline(deadline, label) {
  if (performance.now() >= deadline) throw new Error(`${label} did not converge before timeout`)
}

function beforeProfileDeadline(promise, deadline, label) {
  const remainingMs = deadline - performance.now()
  if (remainingMs <= 0) return Promise.reject(new Error(`${label} did not converge before timeout`))
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} did not converge before timeout`)),
        remainingMs,
      )
    }),
  ]).finally(() => clearTimeout(timer))
}

function installProfileIdbActivityProbe() {
  if (globalThis.__natterProfileIdbActivity) return
  const active = new Set()
  const idleWaiters = new Set()
  let revision = 0
  const publishIdle = () => {
    if (active.size !== 0) return
    for (const resolve of [...idleWaiters]) resolve()
    idleWaiters.clear()
  }
  const openDatabase = (name) =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(name)
      const clear = () => {
        request.onsuccess = null
        request.onerror = null
      }
      request.onsuccess = () => {
        const database = request.result
        clear()
        resolve(database)
      }
      request.onerror = () => {
        const error = request.error
        clear()
        reject(error)
      }
    })
  const requestResult = (request) =>
    new Promise((resolve, reject) => {
      const clear = () => {
        request.onsuccess = null
        request.onerror = null
      }
      request.onsuccess = () => {
        const result = request.result
        clear()
        resolve(result)
      }
      request.onerror = () => {
        const error = request.error
        clear()
        reject(error)
      }
    })
  const transactionResult = async (transaction, result) => {
    const terminal = new Promise((resolve, reject) => {
      const clear = () => {
        transaction.removeEventListener('complete', complete)
        transaction.removeEventListener('abort', abort)
      }
      const complete = () => {
        clear()
        resolve()
      }
      const abort = () => {
        const error = transaction.error
        clear()
        reject(error)
      }
      transaction.addEventListener('complete', complete)
      transaction.addEventListener('abort', abort)
    })
    try {
      const value = await result
      await terminal
      return value
    } catch (error) {
      await terminal.catch(() => undefined)
      throw error
    }
  }
  const tracker = Object.freeze({
    openDatabase,
    requestResult,
    snapshot: () => Object.freeze({ active: active.size, revision }),
    transactionResult,
    whenIdle: () =>
      active.size === 0
        ? Promise.resolve()
        : new Promise((resolve) => {
            idleWaiters.add(resolve)
          }),
  })
  Object.defineProperty(globalThis, '__natterProfileIdbActivity', {
    configurable: false,
    enumerable: false,
    value: tracker,
    writable: false,
  })
  const originalTransaction = IDBDatabase.prototype.transaction
  IDBDatabase.prototype.transaction = function (...args) {
    const transaction = Reflect.apply(originalTransaction, this, args)
    active.add(transaction)
    revision += 1
    let terminal = false
    const settle = () => {
      if (terminal) return
      terminal = true
      transaction.removeEventListener('complete', settle)
      transaction.removeEventListener('abort', settle)
      active.delete(transaction)
      revision += 1
      publishIdle()
    }
    transaction.addEventListener('complete', settle)
    transaction.addEventListener('abort', settle)
    return transaction
  }
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { ...DEFAULTS, help: true }
  const positional = []
  const named = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--serve-preview') {
      named.push([argument, true])
      continue
    }
    if (argument.startsWith('--')) {
      const equals = argument.indexOf('=')
      const name = equals >= 0 ? argument.slice(0, equals) : argument
      const value = equals >= 0 ? argument.slice(equals + 1) : args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
      named.push([name, value])
    } else {
      positional.push(argument)
    }
  }
  if (positional.length > 6) throw new Error('profile-fake-stream accepts at most 6 positionals')
  const parsed = {
    ...DEFAULTS,
    url: positional[0] ?? DEFAULTS.url,
    regenCount: integerArg(positional[1] ?? DEFAULTS.regenCount, 'regenCount', true),
    targetChars: integerArg(positional[2] ?? DEFAULTS.targetChars, 'targetChars'),
    turnCount: integerArg(positional[4] ?? DEFAULTS.turnCount, 'turnCount'),
    reloadCount: integerArg(positional[5] ?? DEFAULTS.reloadCount, 'reloadCount', true),
    help: false,
  }
  parsed.reasoningChars = integerArg(positional[3] ?? parsed.targetChars, 'reasoningChars', true)
  for (const [name, value] of named) {
    switch (name) {
      case '--url':
        parsed.url = value
        break
      case '--provider-url':
        parsed.providerUrl = value
        break
      case '--serve-preview':
        parsed.servePreview = true
        break
      case '--regenerations':
        parsed.regenCount = integerArg(value, 'regenerations', true)
        break
      case '--target-chars':
        parsed.targetChars = integerArg(value, 'target-chars')
        break
      case '--reasoning-chars':
        parsed.reasoningChars = integerArg(value, 'reasoning-chars', true)
        break
      case '--turns':
        parsed.turnCount = integerArg(value, 'turns')
        break
      case '--reloads':
        parsed.reloadCount = integerArg(value, 'reloads', true)
        break
      case '--surface-cycles':
        parsed.surfaceCycleCount = integerArg(value, 'surface-cycles', true)
        break
      case '--chunk-chars':
        parsed.chunkChars = integerArg(value, 'chunk-chars')
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

function integerArg(raw, label, allowZero = false) {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  return value
}

function printHelp() {
  console.log(`Usage: pnpm perf:stream [url] [regens] [text chars] [reasoning chars] [turns] [reloads]
       pnpm perf:stream -- [options]

Profiles the shipped UI and generation path against a separately spawned loopback HTTP provider.

Options:
  --url <url>               Loopback app URL (default: ${DEFAULTS.url})
  --provider-url <url>      Reuse an explicit loopback fake-provider origin
  --serve-preview           Start and stop the already-built Vite preview
  --regenerations <count>   Regeneration siblings (default: ${DEFAULTS.regenCount})
  --target-chars <count>    Assistant text characters (default: ${DEFAULTS.targetChars})
  --reasoning-chars <count> Reasoning characters (default: target chars)
  --turns <count>           Linear turns before regenerations (default: ${DEFAULTS.turnCount})
  --reloads <count>         Reload measurements (default: ${DEFAULTS.reloadCount})
  --surface-cycles <count>  Transcript/tree measurement cycles (default: ${DEFAULTS.surfaceCycleCount})
  --chunk-chars <count>     Provider SSE chunk size (default: ${DEFAULTS.chunkChars})
  --timeout-ms <ms>         Per-operation timeout (default: ${DEFAULTS.timeoutMs})
  -h, --help                Show this help`)
}

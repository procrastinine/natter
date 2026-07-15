import { chromium } from '@playwright/test'
import {
  assertLoopbackUrl,
  createProviderScenario,
  monitorScenario,
  navigateToChat,
  openNewChat,
  seedAndRetargetWorkspace,
  startComposerSend,
  startFakeProvider,
  startRegenerate,
  waitForProviderIdle,
  waitForWorkspaceStreamQuiescence,
} from './profile-stream-harness.mjs'

const DEFAULTS = Object.freeze({
  url: 'http://127.0.0.1:5173/',
  regenCount: 5,
  targetChars: 100_000,
  turnCount: 3,
  reloadCount: 2,
  chunkChars: 128,
  timeoutMs: 60_000,
  providerUrl: null,
})
const options = parseArgs(process.argv.slice(2))
if (options.help) {
  printHelp()
  process.exit(0)
}
assertLoopbackUrl(options.url, 'profile-fake-stream')

const provider = await startFakeProvider({
  providerUrl: options.providerUrl,
  timeoutMs: options.timeoutMs,
})
let scenario
let browser
let page
let client

try {
  scenario = await createProviderScenario(provider.origin, streamConfig(options, 2, 0, 0))
  browser = await chromium.launch({
    headless: true,
    args: ['--js-flags=--expose-gc'],
  })
  page = await browser.newPage()
  page.setDefaultTimeout(options.timeoutMs)
  page.setDefaultNavigationTimeout(options.timeoutMs)
  client = await page.context().newCDPSession(page)

  await seedAndRetargetWorkspace(page, {
    appUrl: options.url,
    providerBaseUrl: scenario.providerBaseUrl,
  })

  const samples = [await heap('fresh')]
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
  samples.push(await heap('after-first'))

  for (let index = 1; index < options.turnCount; index += 1) {
    const profiled = index === options.turnCount - 1 && options.targetChars > 100_000
    const turn = await runGeneration({
      mode: 'send',
      prompt: `large turn ${index + 1}`,
      label: `turn ${index + 1}`,
      config: streamConfig(options, options.targetChars, profiled ? 1 : 0),
      ...(profiled
        ? {
            midLabel: `during-turn-${index + 1}-active-over-100k`,
            minVisibleTextLength: Math.min(options.targetChars, 120_000),
          }
        : {}),
    })
    turns.push(turn.result)
    if (turn.midSample) samples.push(turn.midSample)
    samples.push(await heap(`after-turn-${index + 1}`))
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
    samples.push(await heap(`after-regen-${index + 1}`))
  }

  const activeLeafId = sourceAssistantId
  const beforeRecycleState = await collectStoreState(first.chatId)
  const storeStates = [{ label: 'before-reload', state: beforeRecycleState }]
  const previousMessageList = await page.locator('[data-ui="message-list"]').elementHandle()
  if (!previousMessageList) throw new Error('cannot recycle a transcript without a message list')
  try {
    await page.evaluate(() => {
      location.hash = '#/'
    })
    await page.waitForFunction((previous) => !previous.isConnected, previousMessageList)
    await navigateToChat(page, first.chatId, activeLeafId)
    await page.waitForFunction(
      ({ renderedMessages, assistantTextLengths }) => {
        const list = document.querySelector('[data-ui="message-list"]')
        if (!list || Number(list.getAttribute('data-rendered-count')) !== renderedMessages) {
          return false
        }
        const current = [
          ...document.querySelectorAll(
            '[data-ui="message"][data-role="assistant"] [data-ui="message-body"]',
          ),
        ].map((node) => node.textContent?.length ?? 0)
        return (
          current.length === assistantTextLengths.length &&
          current.every((length, index) => length === assistantTextLengths[index])
        )
      },
      {
        renderedMessages: beforeRecycleState.renderedMessages,
        assistantTextLengths: beforeRecycleState.assistantTextLengths,
      },
    )
  } finally {
    await previousMessageList.dispose()
  }
  samples.push(await heap('after-soft-recycle'))
  storeStates.push({ label: 'after-soft-recycle', state: await collectStoreState(first.chatId) })

  for (let index = 0; index < options.reloadCount; index += 1) {
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('[data-ui="message-list"]').waitFor({ state: 'visible' })
    samples.push(await heap(`after-reload-${index + 1}`))
    storeStates.push({
      label: `after-reload-${index + 1}`,
      state: await collectStoreState(first.chatId),
    })
  }

  const failures = []
  for (const result of [...turns, ...regenerations.map((entry) => entry.result ?? entry)]) {
    if (result.outcome !== 'done') failures.push(`${result.assistantMessageId}: ${result.outcome}`)
  }
  const report = {
    schemaVersion: 1,
    measurementModel: 'external-http-ui-v1',
    scenario: {
      regenCount: options.regenCount,
      targetChars: options.targetChars,
      reasoningChars: options.reasoningChars,
      turnCount: options.turnCount,
      reloadCount: options.reloadCount,
      chunkChars: options.chunkChars,
      providerOwned: provider.owned,
      recycleMethod: 'route-away-and-back',
    },
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
  console.log(JSON.stringify(report, null, 2))
  if (failures.length > 0) process.exitCode = 1
} finally {
  await browser?.close()
  await scenario?.dispose().catch(() => undefined)
  await provider.stop()
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
  midLabel,
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
  if (midLabel) {
    await page.waitForFunction(
      ({ assistantId, minimum }) => {
        const body = document.querySelector(
          `[data-ui="message"][data-message-id="${assistantId}"] [data-ui="message-body"]`,
        )
        return (body?.textContent?.length ?? 0) >= minimum
      },
      { assistantId: admission.assistantMessageId, minimum: minVisibleTextLength },
    )
    midSample = await heap(midLabel)
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

async function heap(label) {
  await client.send('HeapProfiler.collectGarbage')
  const [usage, dom, browserEvidence, providerEvidence] = await Promise.all([
    client.send('Runtime.getHeapUsage'),
    client.send('Memory.getDOMCounters'),
    collectRuntimeEvidence(),
    scenario.snapshot(),
  ])
  const perf = await page.evaluate(() => {
    const memory = performance.memory
    return memory
      ? {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize,
          jsHeapSizeLimit: memory.jsHeapSizeLimit,
        }
      : {}
  })
  return {
    label,
    usedSize: usage.usedSize,
    totalSize: usage.totalSize,
    dom,
    perf,
    debugState: {
      ...browserEvidence,
      provider: {
        activeStreams: providerEvidence.activeStreams,
        requestCount: providerEvidence.requestCount,
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

async function collectRuntimeEvidence() {
  return page.evaluate(async () => {
    const openDatabase = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('natter')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const requestResult = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const textLength = (content) =>
      Array.isArray(content)
        ? content.reduce(
            (sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0),
            0,
          )
        : 0
    const reasoningLength = (details) =>
      Array.isArray(details)
        ? details.reduce((sum, item) => {
            const value = typeof item?.text === 'string' ? item.text : item?.summary
            return sum + (typeof value === 'string' ? value.length : 0)
          }, 0)
        : 0
    const db = await openDatabase()
    try {
      const transaction = db.transaction(
        ['messages', 'messageBodies', 'streamLeases', 'streamChunks'],
        'readonly',
      )
      const [messages, bodies, leases, chunkCount] = await Promise.all([
        requestResult(transaction.objectStore('messages').getAll()),
        requestResult(transaction.objectStore('messageBodies').getAll()),
        requestResult(transaction.objectStore('streamLeases').getAll()),
        requestResult(transaction.objectStore('streamChunks').count()),
      ])
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
            (sum, message) => sum + reasoningLength(bodyById.get(message.id)?.reasoningDetails),
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
  })
}

async function collectStoreState(chatId) {
  return page.evaluate(async (id) => {
    const openDatabase = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('natter')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const requestResult = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const list = document.querySelector('[data-ui="message-list"]')
    const renderedMessages = document.querySelectorAll('[data-ui="message"]').length
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
    const db = await openDatabase()
    try {
      const transaction = db.transaction(['messages', 'messageBodies', 'streamChunks'], 'readonly')
      const counts = Object.fromEntries(
        await Promise.all(
          ['messages', 'messageBodies', 'streamChunks'].map(async (name) => [
            name,
            await requestResult(transaction.objectStore(name).count()),
          ]),
        ),
      )
      return {
        chatId: id,
        url: location.href,
        renderedMessages,
        renderWindow: list?.getAttribute('data-rendered-count'),
        assistantTextLengths,
        markdownOverflows,
        markdownSegments,
        counts,
      }
    } finally {
      db.close()
    }
  }, chatId)
}

async function readAssistantLengths(messageId) {
  return page.evaluate(async (id) => {
    const openDatabase = () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('natter')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const requestResult = (request) =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const textLength = (content) =>
      Array.isArray(content)
        ? content.reduce(
            (sum, item) => sum + (typeof item?.text === 'string' ? item.text.length : 0),
            0,
          )
        : 0
    const reasoningLength = (details) =>
      Array.isArray(details)
        ? details.reduce((sum, item) => {
            const value = typeof item?.text === 'string' ? item.text : item?.summary
            return sum + (typeof value === 'string' ? value.length : 0)
          }, 0)
        : 0
    const db = await openDatabase()
    try {
      const body = await requestResult(
        db.transaction('messageBodies', 'readonly').objectStore('messageBodies').get(id),
      )
      return {
        text: textLength(body?.content),
        reasoning: reasoningLength(body?.reasoningDetails),
      }
    } finally {
      db.close()
    }
  }, messageId)
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { ...DEFAULTS, help: true }
  const positional = []
  const named = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
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
  --regenerations <count>   Regeneration siblings (default: ${DEFAULTS.regenCount})
  --target-chars <count>    Assistant text characters (default: ${DEFAULTS.targetChars})
  --reasoning-chars <count> Reasoning characters (default: target chars)
  --turns <count>           Linear turns before regenerations (default: ${DEFAULTS.turnCount})
  --reloads <count>         Reload measurements (default: ${DEFAULTS.reloadCount})
  --chunk-chars <count>     Provider SSE chunk size (default: ${DEFAULTS.chunkChars})
  --timeout-ms <ms>         Per-operation timeout (default: ${DEFAULTS.timeoutMs})
  -h, --help                Show this help`)
}

import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'

const DEFAULTS = Object.freeze({
  url: 'http://127.0.0.1:5173/',
  pageCount: 10,
  streamsPerPage: 10,
  contextChars: 100_000,
  targetChars: 100_000,
  reasoningChars: 100_000,
  chunkChars: 128,
  regenerationCount: 100,
  timeoutMs: 180_000,
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
  regenerationCount,
  timeoutMs,
} = options
const totalStreams = pageCount * streamsPerPage
const target = new URL(url)
const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer vitae sem sed nulla gravida feugiat. '

if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
  throw new Error('stress harness only accepts a loopback URL')
}
if (regenerationCount > totalStreams) {
  throw new Error('regenerationCount cannot exceed totalStreams')
}

const browser = await chromium.launch({
  headless: true,
  args: ['--enable-precise-memory-info'],
})
const context = await browser.newContext()
const pages = []
const cdpSessions = []
const consoleProblems = []

try {
  for (let index = 0; index < pageCount; index += 1) {
    const page = await context.newPage()
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
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__debugFakeStream), null, {
      timeout: timeoutMs,
    })
    pages.push(page)
    cdpSessions.push(await context.newCDPSession(page))
  }

  const seed = await withinTimeout(
    pages[0].evaluate(async () =>
      window.__debugFakeStream.start({
        targetChars: 1,
        reasoningChars: 0,
        chunkChars: 1,
        reasoningChunkChars: 1,
        delayMs: 0,
        openChat: false,
        prompt: 'concurrency stress seed',
      }),
    ),
    'seed stream',
    timeoutMs,
  )
  const baselineHeap = await measureHeap(pages, cdpSessions)

  const startedAt = Date.now()
  const previousBatches = await withinTimeout(
    Promise.all(
      pages.map((page, pageIndex) =>
        page.evaluate(
          async ({ pageIndex, streamsPerPage, contextChars, chunkChars }) =>
            Promise.all(
              Array.from({ length: streamsPerPage }, (_, streamIndex) =>
                window.__debugFakeStream.start({
                  targetChars: contextChars,
                  reasoningChars: 0,
                  chunkChars,
                  reasoningChunkChars: chunkChars,
                  delayMs: 0,
                  openChat: false,
                  prompt: `prior turn ${pageIndex}:${streamIndex}`,
                }),
              ),
            ),
          { pageIndex, streamsPerPage, contextChars, chunkChars },
        ),
      ),
    ),
    'previous-turn phase',
    timeoutMs,
  )
  const previousElapsedMs = Date.now() - startedAt
  const afterPreviousHeap = await measureHeap(pages, cdpSessions)
  console.error(`previous-turn phase: ${previousElapsedMs} ms`)

  const currentStartedAt = Date.now()
  const resultBatches = await withinTimeout(
    Promise.all(
      pages.map((page, pageIndex) =>
        page.evaluate(
          async ({ pageIndex, previous, targetChars, reasoningChars, chunkChars }) =>
            Promise.all(
              previous.map(async (prior, streamIndex) => {
                const current = await window.__debugFakeStream.start({
                  chatId: prior.chatId,
                  targetChars,
                  reasoningChars,
                  chunkChars,
                  reasoningChunkChars: chunkChars,
                  delayMs: 0,
                  openChat: false,
                  prompt: `next turn ${pageIndex}:${streamIndex}`,
                })
                return {
                  ...current,
                  previousAssistantMessageId: prior.assistantMessageId,
                  previousOutcome: prior.outcome,
                }
              }),
            ),
          {
            pageIndex,
            previous: previousBatches[pageIndex],
            targetChars,
            reasoningChars,
            chunkChars,
          },
        ),
      ),
    ),
    'current-turn phase',
    timeoutMs,
  )
  const results = resultBatches.flat()
  const currentElapsedMs = Date.now() - currentStartedAt
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
  const regenerationStartedAt = Date.now()
  const regenerationBatches = await withinTimeout(
    Promise.all(
      pages.map((page, pageIndex) =>
        page.evaluate(
          async ({ inputs, targetChars, reasoningChars, chunkChars }) =>
            Promise.all(
              inputs.map(async (input) => {
                const regenerated = await window.__debugFakeStream.start({
                  chatId: input.chatId,
                  parentMessageId: input.parentUserId,
                  targetChars,
                  reasoningChars,
                  chunkChars,
                  reasoningChunkChars: chunkChars,
                  delayMs: 0,
                  openChat: false,
                })
                return {
                  ...regenerated,
                  parentUserId: input.parentUserId,
                  sourceAssistantId: input.sourceAssistantId,
                }
              }),
            ),
          { inputs: regenerationInputsByPage[pageIndex], targetChars, reasoningChars, chunkChars },
        ),
      ),
    ),
    'regeneration phase',
    timeoutMs,
  )
  const regenerations = regenerationBatches.flat()
  const regenerationElapsedMs = Date.now() - regenerationStartedAt
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
    expectedContextHash: hashText(loremText(contextChars)),
    expectedTextHash: hashText(loremText(targetChars)),
    expectedReasoningHash: hashText(loremText(reasoningChars)),
    contextChars,
    targetChars,
    reasoningChars,
  })
  const pageStates = await Promise.all(
    pages.map((page) => page.evaluate(() => window.__debugFakeStream.state())),
  )

  await withinTimeout(
    Promise.all(pages.map((page) => page.reload({ waitUntil: 'domcontentloaded' }))),
    'reload phase',
    timeoutMs,
  )
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() => Boolean(window.__debugFakeStream), null, { timeout: timeoutMs }),
    ),
  )
  const afterReloadHeap = await measureHeap(pages, cdpSessions)
  const afterReload = await verifyStored(pages[0], {
    assistantIds,
    userIds,
    previousAssistantIds,
    chatIds,
    regenerations,
    expectedContextHash: hashText(loremText(contextChars)),
    expectedTextHash: hashText(loremText(targetChars)),
    expectedReasoningHash: hashText(loremText(reasoningChars)),
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
    if (result.outcome !== 'done') failures.push(`${result.streamId}: outcome ${result.outcome}`)
  }
  for (const regeneration of regenerations) {
    if (regeneration.outcome !== 'done') {
      failures.push(`${regeneration.streamId}: regeneration outcome ${regeneration.outcome}`)
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
  if (consoleProblems.length > 0) failures.push(`${consoleProblems.length} console problems`)

  const report = {
    schemaVersion: 1,
    scenario: {
      pageCount,
      streamsPerPage,
      totalStreams,
      contextChars,
      targetChars,
      reasoningChars,
      chunkChars,
      regenerationCount,
      timeoutMs,
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
  console.log(JSON.stringify(report, null, 2))
  if (failures.length > 0) process.exitCode = 1
} finally {
  await browser.close()
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
  --pages <count>             Browser pages (default: ${DEFAULTS.pageCount})
  --streams-per-page <count>  Streams on each page (default: ${DEFAULTS.streamsPerPage})
  --context-chars <count>     Prior assistant text per stream (default: ${DEFAULTS.contextChars})
  --target-chars <count>      Current or regenerated text (default: ${DEFAULTS.targetChars})
  --reasoning-chars <count>   Current or regenerated reasoning (default: ${DEFAULTS.reasoningChars})
  --chunk-chars <count>       Fake provider chunk size (default: ${DEFAULTS.chunkChars})
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

function loremText(size) {
  if (size === 0) return ''
  let output = ''
  while (output.length < size) output += LOREM
  return output.slice(0, size)
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
  return page.evaluate(async (input) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('natter')
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
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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
        const reasoning =
          body?.reasoningDetails
            ?.filter((item) => item?.type === 'reasoning.text')
            .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
            .map((item) => item.text ?? '')
            .join('') ?? ''
        return {
          assistantId,
          previousHeaderExists: Boolean(previousHeader),
          previousBodyExists: Boolean(previousBody),
          userHeaderExists: Boolean(userHeader),
          headerExists: Boolean(header),
          bodyExists: Boolean(body),
          chatExists: Boolean(chat),
          nodeVersionsMatch: header?.nodeVersion === body?.nodeVersion,
          previousNodeVersionsMatch: previousHeader?.nodeVersion === previousBody?.nodeVersion,
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
        const reasoning =
          body?.reasoningDetails
            ?.filter((item) => item?.type === 'reasoning.text')
            .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
            .map((item) => item.text ?? '')
            .join('') ?? ''
        return {
          assistantId: regeneration.assistantMessageId,
          headerExists: Boolean(header),
          bodyExists: Boolean(body),
          sourceHeaderExists: Boolean(sourceHeader),
          parentHeaderExists: Boolean(parentHeader),
          nodeVersionsMatch: header?.nodeVersion === body?.nodeVersion,
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
      if (!row.nodeVersionsMatch) failures.push(`${row.assistantId}: header/body version mismatch`)
      if (!row.previousNodeVersionsMatch) {
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
      if (row.integrity !== 'clean') failures.push(`${row.assistantId}: integrity ${row.integrity}`)
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
      if (!row.nodeVersionsMatch) {
        failures.push(`${row.assistantId}: regeneration header/body version mismatch`)
      }
      if (!row.branchShapeMatches) failures.push(`${row.assistantId}: copied or malformed branch`)
      if (row.parentRole !== 'user')
        failures.push(`${row.assistantId}: parent role ${row.parentRole}`)
      if (row.status !== 'done') failures.push(`${row.assistantId}: status ${row.status}`)
      if (row.integrity !== 'clean') failures.push(`${row.assistantId}: integrity ${row.integrity}`)
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
      regenerationTextBytesChecked: regenerationRows.reduce((sum, row) => sum + row.textLength, 0),
      regenerationReasoningBytesChecked: regenerationRows.reduce(
        (sum, row) => sum + row.reasoningLength,
        0,
      ),
      failures,
    }
  }, expected)
}

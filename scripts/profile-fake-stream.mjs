import { chromium } from '@playwright/test'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/'
const regenCount = positiveInteger(process.argv[3] ?? '5', 'regenCount', { allowZero: true })
const targetChars = positiveInteger(process.argv[4] ?? '100000', 'targetChars')
const reasoningChars = positiveInteger(process.argv[5] ?? String(targetChars), 'reasoningChars', {
  allowZero: true,
})
const turnCount = positiveInteger(process.argv[6] ?? '3', 'turnCount')
const reloadCount = positiveInteger(process.argv[7] ?? '2', 'reloadCount', { allowZero: true })
const target = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
  throw new Error('profile-fake-stream only accepts a loopback URL')
}

function positiveInteger(value, label, { allowZero = false } = {}) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  return parsed
}

const browser = await chromium.launch({
  headless: true,
  args: ['--js-flags=--expose-gc'],
})
const page = await browser.newPage()
const client = await page.context().newCDPSession(page)

async function heap(label) {
  await client.send('HeapProfiler.collectGarbage')
  const usage = await client.send('Runtime.getHeapUsage')
  const dom = await client.send('Memory.getDOMCounters')
  const perf = await page.evaluate(() => window.__debugFakeStream?.measure?.() ?? {})
  const debugState = await page.evaluate(() => window.__debugFakeStream?.state?.() ?? {})
  return { label, usedSize: usage.usedSize, totalSize: usage.totalSize, dom, perf, debugState }
}

async function collectStoreState(chatId) {
  return await page.evaluate(
    async ({ chatId }) => {
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
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        const counts = await new Promise((resolve, reject) => {
          const tx = db.transaction(['messages', 'messageBodies', 'streamChunks'], 'readonly')
          const stores = ['messages', 'messageBodies', 'streamChunks']
          const out = {}
          let pending = stores.length
          for (const name of stores) {
            const req = tx.objectStore(name).count()
            req.onsuccess = () => {
              out[name] = req.result
              pending -= 1
              if (pending === 0) resolve(out)
            }
            req.onerror = () => reject(req.error)
          }
        })
        return {
          chatId,
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
    },
    { chatId },
  )
}

async function runFakeStream(options) {
  return await page.evaluate(async (options) => {
    const t0 = performance.now()
    const out = await window.__debugFakeStream.start({
      ...options,
      chunkChars: 128,
      reasoningChunkChars: 128,
      delayMs: 0,
    })
    return { ...out, elapsedMs: performance.now() - t0 }
  }, options)
}

async function runProfiledFakeStream(options, midLabel, minVisibleTextLength) {
  const existingAssistantCount = await page.evaluate(
    () => document.querySelectorAll('[data-ui="message"][data-role="assistant"]').length,
  )
  await page.evaluate((options) => {
    window.__profileActiveResult = null
    window.__profileActiveError = null
    const t0 = performance.now()
    void window.__debugFakeStream
      .start({
        ...options,
        chunkChars: 128,
        reasoningChunkChars: 128,
        delayMs: 1,
      })
      .then(
        (result) => {
          window.__profileActiveResult = { ...result, elapsedMs: performance.now() - t0 }
        },
        (error) => {
          window.__profileActiveError = error instanceof Error ? error.message : String(error)
        },
      )
  }, options)
  await page.waitForFunction(
    ({ existingAssistantCount, minVisibleTextLength }) => {
      const bodies = [
        ...document.querySelectorAll(
          '[data-ui="message"][data-role="assistant"] [data-ui="message-body"]',
        ),
      ]
      if (bodies.length <= existingAssistantCount) return false
      const latest = bodies.at(-1)
      return (latest?.textContent?.length ?? 0) >= minVisibleTextLength
    },
    { existingAssistantCount, minVisibleTextLength },
    { timeout: 60000 },
  )
  const midSample = await heap(midLabel)
  await page.waitForFunction(
    () => Boolean(window.__profileActiveResult || window.__profileActiveError),
    null,
    { timeout: 60000 },
  )
  const result = await page.evaluate(() => {
    if (window.__profileActiveError) throw new Error(window.__profileActiveError)
    return window.__profileActiveResult
  })
  return { result, midSample }
}

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.evaluate(async () => {
  localStorage.clear()
  sessionStorage.clear()
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('natter')
    req.onsuccess = () => resolve(undefined)
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve(undefined)
  })
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => Boolean(window.__debugFakeStream), null, { timeout: 10000 })
await page.evaluate(() => window.__debugFakeStream.resetStats())

const samples = [await heap('fresh')]
const turns = []
const first = await runFakeStream({ targetChars, reasoningChars, prompt: 'large turn 1' })
turns.push(first)
samples.push(await heap('after-first'))
for (let i = 1; i < turnCount; i += 1) {
  const input = {
    chatId: first.chatId,
    targetChars,
    reasoningChars,
    prompt: `large turn ${i + 1}`,
    openChat: false,
  }
  const turn =
    i === turnCount - 1 && targetChars > 100_000
      ? await runProfiledFakeStream(
          input,
          `during-turn-${i + 1}-active-over-100k`,
          Math.min(targetChars, 120_000),
        ).then(({ result, midSample }) => {
          samples.push(midSample)
          return result
        })
      : await runFakeStream(input)
  turns.push(turn)
  samples.push(await heap(`after-turn-${i + 1}`))
}

const regenElapsedMs = []
for (let i = 0; i < regenCount; i += 1) {
  const parentMessageId = turns.at(-1).userMessageId
  const result = await runFakeStream({
    chatId: first.chatId,
    parentMessageId,
    targetChars,
    reasoningChars,
    openChat: false,
  })
  regenElapsedMs.push(result.elapsedMs)
  samples.push(await heap(`after-regen-${i + 1}`))
}

const beforeRecycleState = await collectStoreState(first.chatId)
const storeStates = [{ label: 'before-reload', state: beforeRecycleState }]
const previousMessageList = await page.locator('[data-ui="message-list"]').elementHandle()
if (!previousMessageList) throw new Error('Cannot recycle a transcript without a message list')
try {
  await page.evaluate(() => window.__debugFakeStream.recycleTranscript())
  await page.waitForFunction(
    ({ previousMessageList, renderedMessages, assistantTextLengths }) => {
      if (previousMessageList.isConnected) return false
      if (document.querySelector('[data-ui="message-list-recycling"]')) return false
      const list = document.querySelector('[data-ui="message-list"]')
      if (!list || Number(list.getAttribute('data-rendered-count')) !== renderedMessages)
        return false
      const currentAssistantTextLengths = [
        ...document.querySelectorAll(
          '[data-ui="message"][data-role="assistant"] [data-ui="message-body"]',
        ),
      ].map((node) => node.textContent?.length ?? 0)
      return (
        currentAssistantTextLengths.length === assistantTextLengths.length &&
        currentAssistantTextLengths.every((length, index) => length === assistantTextLengths[index])
      )
    },
    {
      previousMessageList,
      renderedMessages: beforeRecycleState.renderedMessages,
      assistantTextLengths: beforeRecycleState.assistantTextLengths,
    },
    { timeout: 10000 },
  )
} finally {
  await previousMessageList.dispose()
}
samples.push(await heap('after-soft-recycle'))
storeStates.push({ label: 'after-soft-recycle', state: await collectStoreState(first.chatId) })
for (let i = 0; i < reloadCount; i += 1) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => Boolean(window.__debugFakeStream), null, { timeout: 10000 })
  await page.waitForSelector('[data-ui="message-list"]', { timeout: 10000 }).catch(() => undefined)
  samples.push(await heap(`after-reload-${i + 1}`))
  storeStates.push({ label: `after-reload-${i + 1}`, state: await collectStoreState(first.chatId) })
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      scenario: {
        regenCount,
        targetChars,
        reasoningChars,
        turnCount,
        reloadCount,
      },
      first: {
        elapsedMs: first.elapsedMs,
        chatId: first.chatId,
        userMessageId: first.userMessageId,
        assistantMessageId: first.assistantMessageId,
      },
      turnElapsedMs: turns.map((turn) => turn.elapsedMs),
      regenElapsedMs,
      samples,
      storeStates,
    },
    null,
    2,
  ),
)

await browser.close()

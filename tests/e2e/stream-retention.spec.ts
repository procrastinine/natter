import { type CDPSession, expect, type Page, test } from './fixtures'
import { clearIndexedDb } from './helpers'

interface DebugState {
  chatStore: { chatCursorCount: number; cursorEntryCount: number }
  streamStore: { activeCount: number; liveSnapshotCount: number; liveClearCount: number }
}

interface DebugStreamResult {
  chatId: string
  userMessageId: string
}

async function startFakeStream(
  page: Page,
  options: {
    chatId?: string
    parentMessageId?: string
    prompt?: string
    targetChars?: number
    reasoningChars?: number
  } = {},
): Promise<DebugStreamResult> {
  return page.evaluate(async (input) => {
    const api = (
      window as unknown as {
        __debugFakeStream?: {
          start(options: Record<string, unknown>): Promise<DebugStreamResult>
        }
      }
    ).__debugFakeStream
    if (!api) throw new Error('__debugFakeStream is not installed')
    return api.start({
      targetChars: 0,
      reasoningChars: 0,
      chunkChars: 128,
      reasoningChunkChars: 128,
      delayMs: 0,
      openChat: false,
      ...input,
    })
  }, options)
}

async function inspectAndReleaseInstances(
  client: CDPSession,
  expression: string,
  objectGroup: string,
): Promise<void> {
  const prototype = await client.send('Runtime.evaluate', { expression, objectGroup })
  if (!prototype.result.objectId) return
  const queried = await client.send('Runtime.queryObjects', {
    prototypeObjectId: prototype.result.objectId,
    objectGroup,
  })
  if (!queried.objects.objectId) return
  const properties = await client.send('Runtime.getProperties', {
    objectId: queried.objects.objectId,
    ownProperties: true,
  })
  for (const property of properties.result) {
    if (!/^\d+$/u.test(property.name) || !property.value?.objectId) continue
    await client.send('DOMDebugger.getEventListeners', { objectId: property.value.objectId })
  }
}

async function countPrototypeInstances(client: CDPSession, expression: string): Promise<number> {
  const objectGroup = `stream-retention-count-${crypto.randomUUID()}`
  try {
    const prototype = await client.send('Runtime.evaluate', { expression, objectGroup })
    if (!prototype.result.objectId) return 0
    const queried = await client.send('Runtime.queryObjects', {
      prototypeObjectId: prototype.result.objectId,
      objectGroup,
    })
    if (!queried.objects.objectId) return 0
    const length = await client.send('Runtime.callFunctionOn', {
      objectId: queried.objects.objectId,
      functionDeclaration: 'function () { return this.length }',
      returnByValue: true,
    })
    return Number(length.result.value ?? 0)
  } finally {
    await client.send('Runtime.releaseObjectGroup', { objectGroup })
  }
}

async function settleBrowserWrappers(page: Page, client: CDPSession) {
  for (let cycle = 0; cycle < 12; cycle += 1) {
    const objectGroup = `stream-retention-${cycle}`
    await client.send('HeapProfiler.collectGarbage')
    await inspectAndReleaseInstances(client, 'AbortSignal.prototype', objectGroup)
    await inspectAndReleaseInstances(client, 'IDBTransaction.prototype', objectGroup)
    await client.send('Runtime.releaseObjectGroup', { objectGroup })
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }
  await client.send('HeapProfiler.collectGarbage')
  return {
    heap: await client.send('Runtime.getHeapUsage'),
    dom: await client.send('Memory.getDOMCounters'),
  }
}

async function debugState(page: Page): Promise<DebugState> {
  return page.evaluate(() => {
    const api = (
      window as unknown as {
        __debugFakeStream?: { state(): DebugState }
      }
    ).__debugFakeStream
    if (!api) throw new Error('__debugFakeStream is not installed')
    return api.state()
  })
}

test('settled streams release transient wrappers and retain only real branch pins', async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000)
  test.skip(browserName !== 'chromium', 'CDP heap and DOM counters are Chromium-only')
  await clearIndexedDb(page)
  await page.waitForFunction(() =>
    Boolean((window as unknown as { __debugFakeStream?: unknown }).__debugFakeStream),
  )
  const client = await page.context().newCDPSession(page)

  const first = await startFakeStream(page, {
    prompt: 'warmup',
    targetChars: 100_000,
    reasoningChars: 100_000,
  })
  expect((await debugState(page)).streamStore.liveClearCount).toBeLessThanOrEqual(2)
  const baseline = await settleBrowserWrappers(page, client)
  const baselineRangeSets = await countPrototypeInstances(
    client,
    'globalThis[Symbol.for("Dexie")].RangeSet.prototype',
  )
  let latest = first
  for (let index = 0; index < 10; index += 1) {
    latest = await startFakeStream(page, {
      chatId: first.chatId,
      prompt: `linear ${index + 1}`,
      targetChars: 100_000,
      reasoningChars: 100_000,
    })
  }
  expect(await debugState(page)).toMatchObject({
    chatStore: { chatCursorCount: 0, cursorEntryCount: 0 },
    streamStore: { activeCount: 0, liveSnapshotCount: 0 },
  })
  const afterLinear = await settleBrowserWrappers(page, client)
  expect(afterLinear.dom.jsEventListeners).toBeLessThanOrEqual(baseline.dom.jsEventListeners + 12)
  expect(afterLinear.heap.usedSize).toBeLessThanOrEqual(baseline.heap.usedSize + 2_000_000)

  for (let index = 0; index < 10; index += 1) {
    await startFakeStream(page, {
      chatId: first.chatId,
      parentMessageId: latest.userMessageId,
      targetChars: 100_000,
      reasoningChars: 100_000,
    })
  }
  expect(await debugState(page)).toMatchObject({
    chatStore: { chatCursorCount: 1, cursorEntryCount: 1 },
    streamStore: { activeCount: 0, liveSnapshotCount: 0 },
  })
  const afterRegenerate = await settleBrowserWrappers(page, client)
  expect(afterRegenerate.dom.jsEventListeners).toBeLessThanOrEqual(
    baseline.dom.jsEventListeners + 12,
  )
  expect(afterRegenerate.heap.usedSize).toBeLessThanOrEqual(baseline.heap.usedSize + 2_500_000)
  const afterRegenerateRangeSets = await countPrototypeInstances(
    client,
    'globalThis[Symbol.for("Dexie")].RangeSet.prototype',
  )
  expect(afterRegenerateRangeSets).toBeLessThanOrEqual(baselineRangeSets + 512)
})

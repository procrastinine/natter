import {
  createFakeStreamScenario,
  type FakeStreamScenario,
  retargetOnlyProfileToFakeProvider,
} from './fake-stream-provider'
import { type CDPSession, expect, type Page, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  interactiveComposer,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

interface RetentionStorageState {
  assistantCount: number
  latestAssistantId: string | null
  latestContentChars: number
  latestReasoningChars: number
  latestReasoningCarrierCount: number
  latestReasoningSchemaVersion: number | null
  legacyReasoningDetailsPresent: boolean
  latestUserAssistantChildren: number
  latestUserId: string | null
  streamChunkCount: number
  streamLeaseCount: number
  unfinishedAssistantCount: number
  userCount: number
}

const scenarios = new Set<FakeStreamScenario>()

test.afterEach(async () => {
  await Promise.all([...scenarios].map((scenario) => scenario.dispose()))
  scenarios.clear()
})

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

async function readRetentionStorageState(
  page: Page,
  chatId: string,
): Promise<RetentionStorageState> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const read = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      try {
        const transaction = db.transaction(
          ['messages', 'messageBodies', 'streamLeases', 'streamChunks'],
          'readonly',
        )
        const [headers, bodies, leases, chunks] = await Promise.all([
          read(transaction.objectStore('messages').index('chatId').getAll(id)),
          read(transaction.objectStore('messageBodies').getAll()),
          read(transaction.objectStore('streamLeases').getAll()),
          read(transaction.objectStore('streamChunks').getAll()),
        ])
        const messageHeaders = (headers as Array<Record<string, unknown>>).sort(
          (left, right) =>
            Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0) ||
            String(left.id).localeCompare(String(right.id)),
        )
        const users = messageHeaders.filter((row) => row.role === 'user')
        const assistants = messageHeaders.filter((row) => row.role === 'assistant')
        const latestUser = users.at(-1)
        const latestAssistant = assistants.at(-1)
        const body = (bodies as Array<Record<string, unknown>>).find(
          (row) => row.id === latestAssistant?.id,
        )
        const content: unknown[] = Array.isArray(body?.content) ? body.content : []
        const reasoningEnvelope =
          typeof body?.reasoningEnvelope === 'object' && body.reasoningEnvelope !== null
            ? (body.reasoningEnvelope as Record<string, unknown>)
            : null
        const reasoning: unknown[] = Array.isArray(reasoningEnvelope?.visible)
          ? reasoningEnvelope.visible
          : []
        const generationFinished = (row: Record<string, unknown>) => {
          const generation = row.generation
          return (
            typeof generation === 'object' &&
            generation !== null &&
            typeof (generation as { finishedAt?: unknown }).finishedAt === 'number'
          )
        }
        return {
          assistantCount: assistants.length,
          latestAssistantId: typeof latestAssistant?.id === 'string' ? latestAssistant.id : null,
          latestContentChars: content.reduce<number>(
            (total, item) =>
              total +
              (typeof item === 'object' &&
              item !== null &&
              typeof (item as { text?: unknown }).text === 'string'
                ? (item as { text: string }).text.length
                : 0),
            0,
          ),
          latestReasoningChars: reasoning.reduce<number>(
            (total, item) =>
              total +
              (typeof item === 'object' &&
              item !== null &&
              typeof (item as { text?: unknown }).text === 'string'
                ? (item as { text: string }).text.length
                : 0),
            0,
          ),
          latestReasoningCarrierCount: Array.isArray(reasoningEnvelope?.carriers)
            ? reasoningEnvelope.carriers.length
            : 0,
          latestReasoningSchemaVersion:
            typeof reasoningEnvelope?.schemaVersion === 'number'
              ? reasoningEnvelope.schemaVersion
              : null,
          legacyReasoningDetailsPresent: Object.hasOwn(body ?? {}, 'reasoningDetails'),
          latestUserAssistantChildren:
            typeof latestUser?.id === 'string'
              ? assistants.filter((row) => row.parentId === latestUser.id).length
              : 0,
          latestUserId: typeof latestUser?.id === 'string' ? latestUser.id : null,
          streamChunkCount: (chunks as Array<{ chatId?: unknown }>).filter(
            (row) => row.chatId === id,
          ).length,
          streamLeaseCount: (leases as Array<{ chatId?: unknown }>).filter(
            (row) => row.chatId === id,
          ).length,
          unfinishedAssistantCount: assistants.filter((row) => !generationFinished(row)).length,
          userCount: users.length,
        }
      } finally {
        db.close()
      }
    },
    { databaseName, id: chatId },
  )
}

async function waitForDurableBatch(
  page: Page,
  scenario: FakeStreamScenario,
  chatId: string,
  expected: { assistantCount: number; generationCount: number; userCount: number },
): Promise<RetentionStorageState> {
  await expect
    .poll(async () => {
      const state = await readRetentionStorageState(page, chatId)
      return {
        assistantCount: state.assistantCount,
        streamChunkCount: state.streamChunkCount,
        streamLeaseCount: state.streamLeaseCount,
        unfinishedAssistantCount: state.unfinishedAssistantCount,
        userCount: state.userCount,
      }
    })
    .toEqual({
      assistantCount: expected.assistantCount,
      streamChunkCount: 0,
      streamLeaseCount: 0,
      unfinishedAssistantCount: 0,
      userCount: expected.userCount,
    })
  await expect.poll(async () => (await scenario.snapshot()).activeStreams).toBe(0)
  const provider = await scenario.snapshot()
  expect(generationRequestCount(provider)).toBe(expected.generationCount)
  const state = await readRetentionStorageState(page, chatId)
  expect(state.latestContentChars).toBe(100_000)
  expect(state.latestReasoningChars).toBe(100_000)
  expect(state.latestReasoningSchemaVersion).toBe(2)
  expect(state.latestReasoningCarrierCount).toBe(0)
  expect(state.legacyReasoningDetailsPresent).toBe(false)
  return state
}

async function openStoredChat(page: Page, chatId: string): Promise<void> {
  await page.locator(`[data-ui="chat-row-link"][href="#/chat/${chatId}"]`).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain(`#/chat/${chatId}`)
  await expect(interactiveComposer(page)).toBeVisible()
}

async function leaveForBlankChat(page: Page): Promise<void> {
  await page.locator('[data-role="new-chat"]').click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/new')
  await expect(page.locator('[data-ui="message"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
}

async function waitForProviderStream(
  scenario: FakeStreamScenario,
  expectedGenerationCount: number,
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await scenario.snapshot()
      return {
        activeStreams: snapshot.activeStreams,
        generationCount: generationRequestCount(snapshot),
      }
    })
    .toEqual({ activeStreams: 1, generationCount: expectedGenerationCount })
}

function generationRequestCount(
  snapshot: Awaited<ReturnType<FakeStreamScenario['snapshot']>>,
): number {
  return snapshot.requests.filter(
    (request) => request.method === 'POST' && request.path === '/chat/completions',
  ).length
}

async function streamChunkCountForChat(page: Page, chatId: string): Promise<number> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        return await new Promise<number>((resolve, reject) => {
          const request = db
            .transaction('streamChunks', 'readonly')
            .objectStore('streamChunks')
            .getAll()
          request.onsuccess = () =>
            resolve(
              (request.result as Array<{ chatId?: unknown }>).filter((row) => row.chatId === id)
                .length,
            )
          request.onerror = () => reject(request.error)
        })
      } finally {
        db.close()
      }
    },
    { databaseName, id: chatId },
  )
}

async function activeRouteChatId(page: Page): Promise<string> {
  await expect(page).toHaveURL(/#\/chat\/[^/]+\/message\//u)
  return page.evaluate(() => window.location.hash.split('/')[2] ?? '')
}

test('returning to an offscreen paused stream projects its current durable prefix', async ({
  page,
}) => {
  const pausedPrefix = 'prefix received while another chat was active'
  const scenario = await createFakeStreamScenario({ targetChars: 8, chunkChars: 8 })
  scenarios.add(scenario)
  await clearIndexedDb(page)
  await seedFirstRun(page)
  await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)

  await createChatAndOpen(page)
  await sendMessage(page, 'first chat baseline')
  const firstChat = await activeRouteChatId(page)
  await waitForAssistantGenerationFinished(page, firstChat)

  await createChatAndOpen(page)
  await sendMessage(page, 'second chat baseline')
  const secondChat = await activeRouteChatId(page)
  await waitForAssistantGenerationFinished(page, secondChat)
  expect(secondChat).not.toBe(firstChat)

  await scenario.update({
    responses: [
      {
        path: '/chat/completions',
        delayMs: 350,
        sseFrames: [
          {
            data: {
              id: 'offscreen-paused',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { content: pausedPrefix }, finish_reason: null }],
            },
            delayMs: 5_000,
          },
          {
            data: {
              id: 'offscreen-paused',
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            },
          },
          { data: '[DONE]' },
        ],
      },
    ],
  })

  await openStoredChat(page, firstChat)
  await sendMessage(page, 'pause while offscreen')
  await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(1)
  await openStoredChat(page, secondChat)
  await expect.poll(() => streamChunkCountForChat(page, firstChat)).toBeGreaterThan(0)

  await openStoredChat(page, firstChat)
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .last()
      .locator('[data-ui="message-body"]'),
  ).toHaveText(pausedPrefix, { timeout: 2_000 })
  await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(1)

  await waitForAssistantGenerationFinished(page, firstChat)
  await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
})

async function sendDetachedTurn(
  page: Page,
  scenario: FakeStreamScenario,
  input: {
    assistantCount: number
    chatId?: string
    generationCount: number
    prompt: string
    userCount: number
  },
): Promise<{ chatId: string; state: RetentionStorageState }> {
  await scenario.hold()
  if (input.chatId) await openStoredChat(page, input.chatId)
  else await createChatAndOpen(page)
  await sendMessage(page, input.prompt)
  if (!input.chatId) await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(1)
  const chatId = input.chatId ?? (await firstChatId(page))
  expect(chatId).not.toBe('')
  await waitForProviderStream(scenario, input.generationCount)
  await leaveForBlankChat(page)
  await scenario.release()
  return {
    chatId,
    state: await waitForDurableBatch(page, scenario, chatId, input),
  }
}

async function regenerateDetached(
  page: Page,
  scenario: FakeStreamScenario,
  input: {
    assistantCount: number
    chatId: string
    generationCount: number
    userCount: number
  },
): Promise<RetentionStorageState> {
  await scenario.hold()
  await openStoredChat(page, input.chatId)
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(assistant).toBeVisible()
  await assistant.locator('[data-action="regenerate"]').click()
  await waitForProviderStream(scenario, input.generationCount)
  await leaveForBlankChat(page)
  await scenario.release()
  return waitForDurableBatch(page, scenario, input.chatId, input)
}

test('settled detached streams release wrappers without retaining tab branch state', async ({
  page,
  browserName,
}) => {
  test.setTimeout(180_000)
  test.skip(browserName !== 'chromium', 'CDP heap and DOM counters are Chromium-only')
  await clearIndexedDb(page)
  const scenario = await createFakeStreamScenario({
    targetChars: 100_000,
    reasoningChars: 100_000,
    chunkChars: 128,
    initialDelayMs: 250,
    holdUntilReleased: true,
  })
  scenarios.add(scenario)
  await seedFirstRun(page)
  await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
  const client = await page.context().newCDPSession(page)

  const first = await sendDetachedTurn(page, scenario, {
    prompt: 'warmup',
    assistantCount: 1,
    generationCount: 1,
    userCount: 1,
  })
  expect(first.state.latestUserAssistantChildren).toBe(1)
  await sendDetachedTurn(page, scenario, {
    chatId: first.chatId,
    prompt: 'warmup linear navigation',
    assistantCount: 2,
    generationCount: 2,
    userCount: 2,
  })
  const warmRegenerateState = await regenerateDetached(page, scenario, {
    chatId: first.chatId,
    assistantCount: 3,
    generationCount: 3,
    userCount: 2,
  })
  expect(warmRegenerateState.latestUserAssistantChildren).toBe(2)
  const baseline = await settleBrowserWrappers(page, client)
  const baselineRangeSets = await countPrototypeInstances(
    client,
    'globalThis[Symbol.for("Dexie")].RangeSet.prototype',
  )

  let assistantCount = 3
  let generationCount = 3
  let userCount = 2
  let linearState = warmRegenerateState
  for (let index = 0; index < 10; index += 1) {
    assistantCount += 1
    generationCount += 1
    userCount += 1
    const completed = await sendDetachedTurn(page, scenario, {
      chatId: first.chatId,
      prompt: `linear ${index + 1}`,
      assistantCount,
      generationCount,
      userCount,
    })
    linearState = completed.state
  }
  expect(linearState.latestUserAssistantChildren).toBe(1)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/new')
  const afterFirstLinearBatch = await settleBrowserWrappers(page, client)

  for (let index = 0; index < 10; index += 1) {
    assistantCount += 1
    generationCount += 1
    userCount += 1
    const completed = await sendDetachedTurn(page, scenario, {
      chatId: first.chatId,
      prompt: `linear ${index + 11}`,
      assistantCount,
      generationCount,
      userCount,
    })
    linearState = completed.state
  }
  expect(linearState.latestUserAssistantChildren).toBe(1)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/new')
  const afterSecondLinearBatch = await settleBrowserWrappers(page, client)
  expect(afterSecondLinearBatch.dom.jsEventListeners).toBeLessThanOrEqual(
    baseline.dom.jsEventListeners + 12,
  )
  expect(afterSecondLinearBatch.heap.usedSize).toBeLessThanOrEqual(
    afterFirstLinearBatch.heap.usedSize + 2_000_000,
  )

  let regenerateState = linearState
  for (let index = 0; index < 10; index += 1) {
    assistantCount += 1
    generationCount += 1
    regenerateState = await regenerateDetached(page, scenario, {
      chatId: first.chatId,
      assistantCount,
      generationCount,
      userCount,
    })
  }
  expect(regenerateState.latestUserId).toBe(linearState.latestUserId)
  expect(regenerateState.latestUserAssistantChildren).toBe(11)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/new')
  const afterRegenerate = await settleBrowserWrappers(page, client)
  expect(afterRegenerate.dom.jsEventListeners).toBeLessThanOrEqual(
    baseline.dom.jsEventListeners + 12,
  )
  expect(afterRegenerate.heap.usedSize).toBeLessThanOrEqual(
    afterSecondLinearBatch.heap.usedSize + 2_500_000,
  )
  const afterRegenerateRangeSets = await countPrototypeInstances(
    client,
    'globalThis[Symbol.for("Dexie")].RangeSet.prototype',
  )
  expect(afterRegenerateRangeSets).toBeLessThanOrEqual(baselineRangeSets + 512)
})

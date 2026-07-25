import type { Route } from '@playwright/test'
import { createFakeStreamScenario, retargetOnlyProfileToFakeProvider } from './fake-stream-provider'
import { expect, type Page, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  clearIndexedDb,
  seedFirstRun,
  seedLinearChat,
} from './helpers'

const CHAT_ID = 'ownership-admission-chat'
const LIFECYCLE_COUNT = 64
const STREAM_SCENARIO = Object.freeze({
  targetChars: 16,
  chunkChars: 16,
  holdUntilReleased: true,
})

test('an active peer release observer cannot corrupt 64 real stream admissions', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await clearIndexedDb(page)
  const scenario = await createFakeStreamScenario(STREAM_SCENARIO)
  let peer: Page | undefined
  try {
    await seedFirstRun(page)
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    const chatId = await seedLinearChat(page, {
      chatId: CHAT_ID,
      messageCount: 2,
      textPrefix: 'ownership admission baseline',
      title: 'Ownership admission',
    })
    const baselineAssistantId = await page
      .locator('[data-ui="message"][data-role="assistant"]')
      .last()
      .getAttribute('data-message-id')
    if (!baselineAssistantId) throw new Error('Imported baseline assistant is missing its id')
    const baselineHash = `#/chat/${chatId}/message/${baselineAssistantId}`
    await page.goto(`/${baselineHash}`)
    const observerBaseline = page.locator(
      `[data-ui="message"][data-message-id="${baselineAssistantId}"][data-role="assistant"]`,
    )
    await expect(observerBaseline).toBeVisible()
    const observerBaselineUrl = page.url()
    const unexpectedObserverNavigations: string[] = []
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && frame.url() !== observerBaselineUrl) {
        unexpectedObserverNavigations.push(frame.url())
      }
    })
    await expect.poll(() => streamRecoveryCoordinatorLocks(page)).toEqual([])

    peer = await page.context().newPage()
    await peer.goto(`/${baselineHash}`)
    await expect(
      peer.locator(
        `[data-ui="message"][data-message-id="${baselineAssistantId}"][data-role="assistant"]`,
      ),
    ).toBeVisible()

    const completionRequestUrls: string[] = []
    const completionUrl = `${scenario.providerBaseUrl}/chat/completions`
    peer.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === completionUrl) {
        completionRequestUrls.push(request.url())
      }
    })

    let activeAssistantId = baselineAssistantId
    const generatedAssistantIds = new Set<string>()
    const providerCompletionRequests: Array<{ promptChars: number }> = []
    for (let attempt = 0; attempt < LIFECYCLE_COUNT; attempt += 1) {
      await peer
        .locator(`[data-ui="message"][data-message-id="${activeAssistantId}"]`)
        .locator('[data-action="regenerate"]')
        .click()

      await expect.poll(async () => (await streamOwnershipLocks(peer as Page)).held).toHaveLength(1)
      const ownershipLock = (await streamOwnershipLocks(peer)).held[0]
      if (!ownershipLock) throw new Error('Stream ownership lock was not held')
      if (attempt === 0) {
        await expect.poll(() => streamRecoveryCoordinatorLocks(page)).toHaveLength(1)
      }
      const activeLocks = await streamOwnershipLocks(page)
      expect(activeLocks.held).toEqual([ownershipLock])
      expect(activeLocks.pending.length).toBeLessThanOrEqual(1)
      expect(activeLocks.pending.every((name) => name === ownershipLock)).toBe(true)
      await expect(peer.locator('[data-ui="abort"]')).toBeVisible()
      await expect(peer.locator('[data-ui="composer-input"]')).toBeVisible()
      await scenario.release()

      const nextAssistantId = await waitForCompletedAssistantRoute(peer, chatId, activeAssistantId)
      await expect.poll(() => streamOwnershipLocks(page)).toEqual({ held: [], pending: [] })
      expect(generatedAssistantIds.has(nextAssistantId)).toBe(false)
      generatedAssistantIds.add(nextAssistantId)
      activeAssistantId = nextAssistantId
      const providerSnapshot = await scenario.snapshot()
      expect(providerSnapshot.activeStreams).toBe(0)
      const currentRequests = providerSnapshot.requests.filter(
        (request) => request.method === 'POST' && request.path === '/chat/completions',
      )
      expect(currentRequests).toHaveLength(1)
      providerCompletionRequests.push(currentRequests[0] as { promptChars: number })
      if (attempt + 1 < LIFECYCLE_COUNT) await scenario.update(STREAM_SCENARIO)
    }

    expect(generatedAssistantIds.size).toBe(LIFECYCLE_COUNT)
    expect(completionRequestUrls).toHaveLength(LIFECYCLE_COUNT)
    await expect.poll(() => streamOwnershipLocks(page)).toEqual({ held: [], pending: [] })

    expect(providerCompletionRequests).toHaveLength(LIFECYCLE_COUNT)
    expect(new Set(providerCompletionRequests.map((request) => request.promptChars)).size).toBe(1)

    const durable = await readDurableOwnershipState(page, chatId)
    expect(durable.streamLeases).toEqual([])
    expect(durable.streamChunks).toEqual([])
    expect(durable.chat?.lastUpdatedLeafId).toBe(activeAssistantId)
    const users = durable.messages.filter((message) => message.role === 'user')
    const assistants = durable.messages
      .filter((message) => message.role === 'assistant')
      .sort((left, right) => left.siblingIndex - right.siblingIndex)
    expect(users).toHaveLength(1)
    expect(assistants).toHaveLength(LIFECYCLE_COUNT + 1)
    expect(assistants.map((message) => message.siblingIndex)).toEqual(
      Array.from({ length: LIFECYCLE_COUNT + 1 }, (_, index) => index),
    )
    expect(assistants.every((message) => message.parentId === users[0]?.id)).toBe(true)
    for (const generated of assistants.slice(1)) {
      expect(generated.generation?.status).toBe('done')
      expect(typeof generated.generation?.finishedAt).toBe('number')
      expect(generated.generation?.abortReason).toBeUndefined()
    }

    const activeLeaf = peer.locator(`[data-ui="message"][data-message-id="${activeAssistantId}"]`)
    await expect(activeLeaf.locator('[data-ui="branch-count"]')).toHaveText('65 / 65')
    await expect(observerBaseline.locator('[data-ui="branch-count"]')).toHaveText('1 / 65')
    await expect
      .poll(() => peer?.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${activeAssistantId}`)
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(baselineHash)
    expect(unexpectedObserverNavigations).toEqual([])
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${activeAssistantId}"]`),
    ).toHaveCount(0)
  } finally {
    await scenario.release().catch(() => undefined)
    await peer?.close()
    await scenario.dispose()
  }
})

test('a remote Stop request converges and the branch admits the next generation', async ({
  page,
}) => {
  await clearIndexedDb(page)
  const scenario = await createFakeStreamScenario(STREAM_SCENARIO)
  let peer: Page | undefined
  try {
    await seedFirstRun(page)
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    const chatId = await seedLinearChat(page, {
      chatId: 'remote-stop-convergence-chat',
      messageCount: 2,
      textPrefix: 'remote stop baseline',
      title: 'Remote stop convergence',
    })
    const baselineAssistantId = await page
      .locator('[data-ui="message"][data-role="assistant"]')
      .last()
      .getAttribute('data-message-id')
    if (!baselineAssistantId) throw new Error('RemoteStopBaselineAssistantMissing')

    await page
      .locator(`[data-ui="message"][data-message-id="${baselineAssistantId}"]`)
      .locator('[data-action="regenerate"]')
      .click()
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(1)
    await expect(page.locator('[data-ui="abort"]')).toBeVisible()
    const activeHash = await page.evaluate(() => window.location.hash)
    const activeAssistantId = activeHash.split('/message/')[1]
    if (!activeAssistantId) throw new Error('RemoteStopActiveAssistantMissing')

    peer = await page.context().newPage()
    await peer.goto(`/${activeHash}`)
    await expect(peer.locator('[data-ui="abort"]')).toBeVisible()
    await peer.locator('[data-ui="abort"]').click()
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(0)
    await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
    await expect(
      page.locator(
        `[data-ui="message"][data-message-id="${activeAssistantId}"] [data-ui="message-error"][data-role="abort"]`,
      ),
    ).toBeVisible()

    await scenario.update(STREAM_SCENARIO)
    await peer
      .locator(`[data-ui="message"][data-message-id="${activeAssistantId}"]`)
      .locator('[data-action="regenerate"]')
      .click()
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(1)
    await scenario.release()
    const completedAssistantId = await waitForCompletedAssistantRoute(
      peer,
      chatId,
      activeAssistantId,
    )
    expect(completedAssistantId).not.toBe(activeAssistantId)
    await expect.poll(() => streamOwnershipLocks(page)).toEqual({ held: [], pending: [] })
  } finally {
    await scenario.release().catch(() => undefined)
    await peer?.close()
    await scenario.dispose()
  }
})

test('a terminal-decided attempt whose writer disappears stays stoppable and admits the next generation', async ({
  context,
  page,
}) => {
  test.setTimeout(90_000)
  await clearIndexedDb(page)
  const scenario = await createFakeStreamScenario(STREAM_SCENARIO)
  let owner: Page | undefined
  let releaseFinalization: () => Promise<void> = async () => undefined
  let releaseRecoveryRuntime: () => Promise<void> = async () => undefined
  try {
    await seedFirstRun(page)
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    const chatId = await seedLinearChat(page, {
      chatId: 'stranded-terminal-stop-chat',
      messageCount: 2,
      textPrefix: 'stranded terminal baseline',
      title: 'Stranded terminal Stop',
    })
    const baselineAssistantId = await page
      .locator('[data-ui="message"][data-role="assistant"]')
      .last()
      .getAttribute('data-message-id')
    if (!baselineAssistantId) throw new Error('StrandedTerminalBaselineAssistantMissing')

    const recoveryRuntime = await holdRecoveryRuntime(page)
    releaseRecoveryRuntime = recoveryRuntime.release
    owner = await context.newPage()
    await owner.goto(`/#/chat/${chatId}/message/${baselineAssistantId}`)
    await expect(
      owner.locator(`[data-ui="message"][data-message-id="${baselineAssistantId}"]`),
    ).toBeVisible()
    await owner
      .locator(`[data-ui="message"][data-message-id="${baselineAssistantId}"]`)
      .locator('[data-action="regenerate"]')
      .click()
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(1)
    const activeHash = await owner.evaluate(() => window.location.hash)
    const activeAssistantId = activeHash.split('/message/')[1]
    if (!activeAssistantId) throw new Error('StrandedTerminalAssistantMissing')
    const ownershipLock = (await streamOwnershipLocks(owner)).held[0]
    if (!ownershipLock) throw new Error('StrandedTerminalOwnershipLockMissing')

    await page.goto(`/${activeHash}`)
    await expect(page.locator('[data-ui="abort"]')).toBeVisible()
    await recoveryRuntime.waitForRequest()
    releaseFinalization = await holdWebLock(page, `message:${activeAssistantId}`)
    await scenario.release()
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(0)
    await expect
      .poll(() => readLeaseState(page, activeAssistantId))
      .toMatchObject({ phase: 'terminal-decided', stopRequested: false })

    await owner.close()
    owner = undefined
    await expect
      .poll(async () => {
        const locks = await streamOwnershipLocks(page)
        return [...locks.held, ...locks.pending]
      })
      .not.toContain(ownershipLock)
    await expect(page.locator('[data-ui="abort"]')).toBeEnabled()
    await page.locator('[data-ui="abort"]').click()
    await expect
      .poll(() => readLeaseState(page, activeAssistantId))
      .toMatchObject({ phase: 'terminal-decided', stopRequested: true })

    await releaseFinalization()
    releaseFinalization = async () => undefined
    await releaseRecoveryRuntime()
    releaseRecoveryRuntime = async () => undefined
    await expect.poll(() => readLeaseState(page, activeAssistantId)).toBeNull()
    await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)

    await scenario.update(STREAM_SCENARIO)
    await page
      .locator(`[data-ui="message"][data-message-id="${activeAssistantId}"]`)
      .locator('[data-action="regenerate"]')
      .click()
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(1)
    await scenario.release()
    const completedAssistantId = await waitForCompletedAssistantRoute(
      page,
      chatId,
      activeAssistantId,
    )
    expect(completedAssistantId).not.toBe(activeAssistantId)
  } finally {
    await releaseFinalization().catch(() => undefined)
    await releaseRecoveryRuntime().catch(() => undefined)
    await scenario.release().catch(() => undefined)
    await owner?.close()
    await scenario.dispose()
  }
})

async function holdWebLock(page: Page, lockName: string): Promise<() => Promise<void>> {
  const gateId = `web-lock-gate:${Date.now()}:${Math.random()}`
  await page.evaluate(
    ({ gateId, lockName }) =>
      new Promise<void>((ready) => {
        void navigator.locks.request(
          lockName,
          () =>
            new Promise<void>((release) => {
              const scope = window as typeof window & {
                __e2eWebLockGates?: Map<string, () => void>
              }
              scope.__e2eWebLockGates ??= new Map()
              scope.__e2eWebLockGates.set(gateId, release)
              ready()
            }),
        )
      }),
    { gateId, lockName },
  )
  return async () => {
    await page.evaluate((gateId) => {
      const scope = window as typeof window & {
        __e2eWebLockGates?: Map<string, () => void>
      }
      const release = scope.__e2eWebLockGates?.get(gateId)
      if (!release) return
      scope.__e2eWebLockGates?.delete(gateId)
      release()
    }, gateId)
  }
}

async function streamOwnershipLocks(page: Page): Promise<{ held: string[]; pending: string[] }> {
  return page.evaluate(async () => {
    const snapshot = await navigator.locks.query()
    const ownershipNames = (locks: readonly LockInfo[] | undefined) =>
      (locks ?? [])
        .map((lock) => lock.name)
        .filter((name): name is string => name?.startsWith('stream-owner:') === true)
        .sort()
    return {
      held: ownershipNames(snapshot.held),
      pending: ownershipNames(snapshot.pending),
    }
  })
}

async function holdRecoveryRuntime(page: Page): Promise<{
  waitForRequest(): Promise<void>
  release(): Promise<void>
}> {
  const pattern = '**/assets/stream-recovery-*.js'
  let markRequested: () => void = () => undefined
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve
  })
  let open: () => void = () => undefined
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  let requestedRoute = false
  let markComplete: () => void = () => undefined
  const complete = new Promise<void>((resolve) => {
    markComplete = resolve
  })
  const handler = async (route: Route) => {
    requestedRoute = true
    markRequested()
    await opened
    try {
      await route.continue()
    } finally {
      markComplete()
    }
  }
  await page.route(pattern, handler)
  let released = false
  return {
    waitForRequest: () => requested,
    release: async () => {
      if (released) return
      released = true
      open()
      if (requestedRoute) await complete
      await page.unroute(pattern, handler)
    },
  }
}

async function readLeaseState(
  page: Page,
  messageId: string,
): Promise<{ phase: string; stopRequested: boolean } | null> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, messageId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const rows = await new Promise<unknown[]>((resolve, reject) => {
          const request = db
            .transaction('streamLeases', 'readonly')
            .objectStore('streamLeases')
            .getAll()
          request.onsuccess = () => resolve(request.result as unknown[])
          request.onerror = () => reject(request.error)
        })
        const row = rows.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            (candidate as { messageId?: unknown }).messageId === messageId,
        ) as { phase?: unknown; stopControl?: unknown } | undefined
        if (!row) return null
        return {
          phase: String(row.phase),
          stopRequested: row.stopControl !== undefined && row.stopControl !== null,
        }
      } finally {
        db.close()
      }
    },
    { databaseName, messageId },
  )
}

async function streamRecoveryCoordinatorLocks(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const snapshot = await navigator.locks.query()
    return (snapshot.held ?? [])
      .map((lock) => lock.name)
      .filter((name): name is string => name?.startsWith('stream-recovery-coordinator:') === true)
      .sort()
  })
}

async function waitForCompletedAssistantRoute(
  page: Page,
  chatId: string,
  previousAssistantId: string,
): Promise<string> {
  await expect
    .poll(async () => {
      const active = await readActiveRouteMessage(page, chatId)
      return (
        active !== null &&
        active.id !== previousAssistantId &&
        active.role === 'assistant' &&
        active.status === 'done' &&
        typeof active.finishedAt === 'number'
      )
    })
    .toBe(true)
  const active = await readActiveRouteMessage(page, chatId)
  if (!active || active.id === previousAssistantId || active.role !== 'assistant') {
    throw new Error('Regenerate did not select its completed assistant')
  }
  return active.id
}

async function readActiveRouteMessage(
  page: Page,
  chatId: string,
): Promise<{
  id: string
  role: string
  status?: string
  finishedAt?: number
} | null> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, id }) => {
      const prefix = `#/chat/${id}/message/`
      if (!window.location.hash.startsWith(prefix)) return null
      const messageId = window.location.hash.slice(prefix.length)
      if (!messageId) return null
      const db = await openNatterDatabase()
      try {
        const row = await requestResult(
          db.transaction('messages', 'readonly').objectStore('messages').get(messageId),
        )
        if (!isRecord(row)) return null
        const generation = isRecord(row.generation) ? row.generation : undefined
        return {
          id: String(row.id),
          role: String(row.role),
          ...(typeof generation?.status === 'string' ? { status: generation.status } : {}),
          ...(typeof generation?.finishedAt === 'number'
            ? { finishedAt: generation.finishedAt }
            : {}),
        }
      } finally {
        db.close()
      }

      function openNatterDatabase(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(databaseName)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      }

      function requestResult(request: IDBRequest): Promise<unknown> {
        return new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      }

      function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value)
      }
    },
    { databaseName, id: chatId },
  )
}

interface DurableMessageHeader {
  id: string
  parentId: string | null
  siblingIndex: number
  role: string
  generation?: {
    status?: string
    finishedAt?: number
    abortReason?: string
  }
}

interface DurableOwnershipState {
  chat?: { lastUpdatedLeafId?: string }
  messages: DurableMessageHeader[]
  streamLeases: unknown[]
  streamChunks: unknown[]
}

async function readDurableOwnershipState(
  page: Page,
  chatId: string,
): Promise<DurableOwnershipState> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const transaction = db.transaction(
          ['chats', 'messages', 'streamLeases', 'streamChunks'],
          'readonly',
        )
        const result = (request: IDBRequest) =>
          new Promise<unknown>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
        const [chatValue, messagesValue, streamLeasesValue, streamChunksValue] = await Promise.all([
          result(transaction.objectStore('chats').get(id)),
          result(transaction.objectStore('messages').index('chatId').getAll(id)),
          result(transaction.objectStore('streamLeases').getAll()),
          result(transaction.objectStore('streamChunks').getAll()),
        ])
        const isRecord = (value: unknown): value is Record<string, unknown> =>
          typeof value === 'object' && value !== null && !Array.isArray(value)
        const chat = isRecord(chatValue) ? chatValue : undefined
        const messages = Array.isArray(messagesValue) ? messagesValue.filter(isRecord) : []
        const streamLeases = Array.isArray(streamLeasesValue) ? streamLeasesValue : []
        const streamChunks = Array.isArray(streamChunksValue) ? streamChunksValue : []
        return {
          ...(chat
            ? {
                chat: {
                  ...(typeof chat.lastUpdatedLeafId === 'string'
                    ? { lastUpdatedLeafId: chat.lastUpdatedLeafId }
                    : {}),
                },
              }
            : {}),
          messages: messages.map((message) => {
            const generation = isRecord(message.generation) ? message.generation : undefined
            return {
              id: String(message.id),
              parentId: typeof message.parentId === 'string' ? message.parentId : null,
              siblingIndex: Number(message.siblingIndex),
              role: String(message.role),
              ...(generation
                ? {
                    generation: {
                      ...(typeof generation.status === 'string'
                        ? { status: generation.status }
                        : {}),
                      ...(typeof generation.finishedAt === 'number'
                        ? { finishedAt: generation.finishedAt }
                        : {}),
                      ...(typeof generation.abortReason === 'string'
                        ? { abortReason: generation.abortReason }
                        : {}),
                    },
                  }
                : {}),
            }
          }),
          streamLeases,
          streamChunks,
        }
      } finally {
        db.close()
      }
    },
    { databaseName, id: chatId },
  )
}

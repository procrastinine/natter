import { createFakeStreamScenario, retargetOnlyProfileToFakeProvider } from './fake-stream-provider'
import { expect, type Page, test } from './fixtures'
import { clearIndexedDb, seedFirstRun, seedLinearChat } from './helpers'

const CHAT_ID = 'ownership-admission-chat'
const BASELINE_ASSISTANT_ID = 'msg-001'
const LIFECYCLE_COUNT = 64

test('an active peer release observer cannot corrupt 64 real stream admissions', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await clearIndexedDb(page)
  const scenario = await createFakeStreamScenario({
    targetChars: 16,
    chunkChars: 16,
    initialDelayMs: 75,
  })
  let peer: Page | undefined
  try {
    await seedFirstRun(page, { model: 'natter/fake-stream' })
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    const chatId = await seedLinearChat(page, {
      chatId: CHAT_ID,
      messageCount: 2,
      textPrefix: 'ownership admission baseline',
      title: 'Ownership admission',
    })
    const baselineHash = `#/chat/${chatId}/message/${BASELINE_ASSISTANT_ID}`
    await page.goto(`/${baselineHash}`)
    await expect(
      page.locator(
        `[data-ui="message"][data-message-id="${BASELINE_ASSISTANT_ID}"][data-role="assistant"]`,
      ),
    ).toBeVisible()

    peer = await page.context().newPage()
    await peer.goto(`/${baselineHash}`)
    const peerBaseline = peer.locator(
      `[data-ui="message"][data-message-id="${BASELINE_ASSISTANT_ID}"][data-role="assistant"]`,
    )
    await expect(peerBaseline).toBeVisible()
    const peerBaselineUrl = peer.url()
    const unexpectedPeerNavigations: string[] = []
    peer.on('framenavigated', (frame) => {
      if (frame === peer?.mainFrame() && frame.url() !== peerBaselineUrl) {
        unexpectedPeerNavigations.push(frame.url())
      }
    })

    const completionRequestUrls: string[] = []
    const completionUrl = `${scenario.providerBaseUrl}/chat/completions`
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url() === completionUrl) {
        completionRequestUrls.push(request.url())
      }
    })

    let activeAssistantId = BASELINE_ASSISTANT_ID
    const generatedAssistantIds = new Set<string>()
    for (let attempt = 0; attempt < LIFECYCLE_COUNT; attempt += 1) {
      await page
        .locator(`[data-ui="message"][data-message-id="${activeAssistantId}"]`)
        .locator('[data-action="regenerate"]')
        .click()

      await expect
        .poll(() => remoteObserverWaitsForCurrentOwner(peer as Page), {
          intervals: [5, 10, 20],
          timeout: 2_000,
        })
        .toBe(true)
      await expect(page.locator('[data-ui="abort"]')).toBeVisible()
      await expect(page.locator('[data-ui="send"]')).toBeVisible({ timeout: 10_000 })

      const nextAssistantId = await waitForCompletedAssistantRoute(page, chatId, activeAssistantId)
      expect(generatedAssistantIds.has(nextAssistantId)).toBe(false)
      generatedAssistantIds.add(nextAssistantId)
      activeAssistantId = nextAssistantId
    }

    expect(generatedAssistantIds.size).toBe(LIFECYCLE_COUNT)
    expect(completionRequestUrls).toHaveLength(LIFECYCLE_COUNT)
    await expect.poll(() => streamOwnershipLocks(page)).toEqual({ held: [], pending: [] })

    const snapshot = await scenario.snapshot()
    const completionRequests = snapshot.requests.filter(
      (request) => request.method === 'POST' && request.path === '/chat/completions',
    )
    expect(completionRequests).toHaveLength(LIFECYCLE_COUNT)
    expect(new Set(completionRequests.map((request) => request.promptChars)).size).toBe(1)

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

    const activeLeaf = page.locator(`[data-ui="message"][data-message-id="${activeAssistantId}"]`)
    await expect(activeLeaf.locator('[data-ui="branch-count"]')).toHaveText('65 / 65')
    await expect(peerBaseline.locator('[data-ui="branch-count"]')).toHaveText('1 / 65')
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${activeAssistantId}`)
    await expect.poll(() => peer?.evaluate(() => window.location.hash)).toBe(baselineHash)
    expect(unexpectedPeerNavigations).toEqual([])
    await expect(
      peer.locator(`[data-ui="message"][data-message-id="${activeAssistantId}"]`),
    ).toHaveCount(0)
  } finally {
    await peer?.close()
    await scenario.dispose()
  }
})

async function remoteObserverWaitsForCurrentOwner(page: Page): Promise<boolean> {
  const locks = await streamOwnershipLocks(page)
  return locks.held.length === 1 && locks.pending.includes(locks.held[0] as string)
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
  return page.evaluate(async (id) => {
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
        const request = indexedDB.open('natter')
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
  }, chatId)
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
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
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
                    ...(typeof generation.status === 'string' ? { status: generation.status } : {}),
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
  }, chatId)
}

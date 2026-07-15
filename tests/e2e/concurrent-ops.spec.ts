import { expect, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  readMessages,
  seedFirstRun,
  sendMessage,
  startMessageCountRecorder,
  stopMessageCountRecorder,
} from './helpers'

// Phase 7 scope of the §6.11.1 concurrent-ops-during-stream matrix.
// While one tab is streaming, certain ops in another tab/context must NOT
// abort the stream nor corrupt the placeholder, and the stream target must
// remain exclusive.

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('two tabs streaming different chats run in parallel without aborting each other', async ({
  page,
}) => {
  // Tab A: create chat #1, open a slow stream.
  await mockChatCompletions(page, {
    delayMs: 1500,
    body: buildSseBody([{ id: 'a', content: 'tab-a-reply' }, { finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello-A')

  // Tab B — second page in the SAME browser context so IndexedDB is shared
  // (same-origin multi-tab behavior).
  const second = await page.context().newPage()
  await second.goto('/')
  await mockChatCompletions(second, {
    body: buildSseBody([{ id: 'b', content: 'tab-b-reply', finish: 'stop' }]),
  })
  await second.locator('[data-role="new-chat"]').click()
  await second.locator('[data-ui="composer"]').waitFor({ state: 'visible' })
  await second.locator('[data-ui="composer-input"]').fill('hello-B')
  await second.locator('[data-ui="send"]').click()
  await expect(
    second
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('tab-b-reply', { timeout: 5000 })

  // Tab A's slow stream finishes unperturbed — this is the real assertion:
  // tab B's parallel activity does not interrupt tab A's in-flight request.
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('tab-a-reply', { timeout: 5000 })

  // The shared IndexedDB contains at least two distinct chats.
  const chatCount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly')
        const req = tx.objectStore('chats').count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
  expect(chatCount).toBeGreaterThanOrEqual(2)
  await second.close()
})

test('a send that leaves before its first receipt finishes exactly when returning by sidebar', async ({
  page,
}) => {
  let requestCount = 0
  let releaseBackgroundResponse: () => void = () => undefined
  const backgroundResponseGate = new Promise<void>((resolve) => {
    releaseBackgroundResponse = resolve
  })
  let markBackgroundRequestSeen: () => void = () => undefined
  const backgroundRequestSeen = new Promise<void>((resolve) => {
    markBackgroundRequestSeen = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    if (requestCount === 3) {
      markBackgroundRequestSeen()
      await backgroundResponseGate
    }
    const content =
      requestCount === 3 ? 'background answer survived' : `seed answer ${requestCount}`
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `background-receipt-${requestCount}`, content },
        { finish: 'stop' },
      ]),
    })
  })

  await createChatAndOpen(page)
  await sendMessage(page, 'first chat seed')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]'),
  ).toHaveText('seed answer 1')
  const firstChat = await firstChatId(page)

  await createChatAndOpen(page)
  await sendMessage(page, 'second chat seed')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]'),
  ).toHaveText('seed answer 2')
  const secondChat = await firstChatId(page)
  expect(secondChat).not.toBe(firstChat)

  const sidebarLink = (chatId: string) =>
    page.locator(`[data-ui="chat-row-link"][href="#/chat/${chatId}"]`)
  await sidebarLink(firstChat).click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`#/chat/${firstChat}/message/`)

  await page.evaluate(async () => {
    const dbPath = '/src/store/db.ts'
    const { getDb } = (await import(/* @vite-ignore */ dbPath)) as unknown as {
      getDb(): {
        keys: {
          get(key: string): Promise<unknown>
        }
      }
    }
    const table = getDb().keys
    const originalGet = table.get.bind(table)
    let release: () => void = () => undefined
    const gate = {
      entered: false,
      released: false,
      release: () => release(),
    }
    const blocked = new Promise<void>((resolve) => {
      release = () => {
        gate.released = true
        resolve()
      }
    })
    let used = false
    table.get = async (key) => {
      if (!used) {
        used = true
        gate.entered = true
        await blocked
      }
      return originalGet(key)
    }
    ;(
      window as typeof window & {
        __backgroundReceiptKeyGate?: typeof gate
      }
    ).__backgroundReceiptKeyGate = gate
  })

  await page.locator('[data-ui="composer-input"]').fill('finish while another chat is active')
  await page.locator('[data-ui="send"]').click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __backgroundReceiptKeyGate?: { entered: boolean }
            }
          ).__backgroundReceiptKeyGate?.entered ?? false,
      ),
    )
    .toBe(true)
  expect(await readMessages(page, firstChat)).toHaveLength(2)

  await sidebarLink(secondChat).click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`#/chat/${secondChat}/message/`)
  await page.evaluate(() => {
    ;(
      window as typeof window & {
        __backgroundReceiptKeyGate?: { release(): void }
      }
    ).__backgroundReceiptKeyGate?.release()
  })
  await backgroundRequestSeen
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`#/chat/${secondChat}/message/`)

  releaseBackgroundResponse()
  let backgroundAssistantId = ''
  await expect
    .poll(async () => {
      const rows = await readMessages(page, firstChat)
      const assistant = rows.find(
        (row) =>
          row.role === 'assistant' &&
          Array.isArray(row.content) &&
          row.content.some(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              (item as { text?: unknown }).text === 'background answer survived',
          ),
      )
      backgroundAssistantId = typeof assistant?.id === 'string' ? assistant.id : ''
      return backgroundAssistantId
    })
    .not.toBe('')

  await page.evaluate(async (chatId) => {
    const repositoryPath = '/src/store/workspace-repository.ts'
    const { getWorkspaceRepository } = (await import(
      /* @vite-ignore */ repositoryPath
    )) as unknown as {
      getWorkspaceRepository(): {
        listMessageHeaders(id: string, options?: unknown): Promise<unknown>
        getKnownBranchPageSnapshot(
          id: string,
          pathMessageIds: readonly string[],
          page: unknown,
        ): Promise<unknown>
      }
    }
    const repository = getWorkspaceRepository()
    const listMessageHeaders = repository.listMessageHeaders.bind(repository)
    const getKnownBranchPageSnapshot = repository.getKnownBranchPageSnapshot.bind(repository)
    const never = new Promise<never>(() => undefined)
    repository.listMessageHeaders = (id, options) =>
      id === chatId ? never : listMessageHeaders(id, options)
    repository.getKnownBranchPageSnapshot = (id, pathMessageIds, options) =>
      id === chatId ? never : getKnownBranchPageSnapshot(id, pathMessageIds, options)
  }, firstChat)

  await sidebarLink(firstChat).click()
  await expect(
    page.locator(
      `[data-ui="message"][data-message-id="${backgroundAssistantId}"] [data-ui="message-body"]`,
    ),
  ).toHaveText('background answer survived')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/chat/${firstChat}/message/${backgroundAssistantId}`)
  await expect(page.locator('[data-ui="surface-loading"]')).toHaveCount(0)
})

test('two tabs cannot turn simultaneous composer sends into an implicit branch', async ({
  page,
}) => {
  await page.goto('/?debug')
  const initial = await startDebugStream(page, {
    openChat: false,
    prompt: 'baseline',
    targetChars: 8,
    reasoningChars: 0,
    chunkChars: 8,
  })
  const second = await page.context().newPage()
  await second.goto(`/?debug#/chat/${initial.chatId}`)

  const start = (target: typeof page, prompt: string) =>
    startDebugStream(target, {
      chatId: initial.chatId,
      expectedLeafId: initial.assistantMessageId,
      openChat: false,
      prompt,
      targetChars: 256,
      reasoningChars: 0,
      chunkChars: 8,
      delayMs: 50,
    })
  const settled = await Promise.allSettled([
    start(page, 'same-chat A'),
    start(second, 'same-chat B'),
  ])

  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = settled.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  expect(rejected).toHaveLength(1)
  expect(String(rejected[0]?.reason)).toContain('ExpectedLeafChanged')

  const rows = (await readMessages(page, initial.chatId)).filter((row) => row.deleted !== true)
  expect(rows).toHaveLength(4)
  const roots = rows.filter((row) => row.parentId === null)
  expect(roots).toHaveLength(1)
  const childrenByParent = new Map<string, Array<Record<string, unknown>>>()
  for (const row of rows) {
    if (typeof row.parentId !== 'string') continue
    const bucket = childrenByParent.get(row.parentId) ?? []
    bucket.push(row)
    childrenByParent.set(row.parentId, bucket)
  }
  expect([...childrenByParent.values()].every((children) => children.length === 1)).toBe(true)

  const roles: unknown[] = []
  let current = roots[0]
  while (current) {
    roles.push(current.role)
    current = childrenByParent.get(String(current.id))?.[0]
  }
  expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
  await second.close()
})

test('a remote extension then newer sibling keeps each tab on its own branch without flashing', async ({
  context,
  page,
}) => {
  await page.goto('/?debug')
  const initial = await startDebugStream(page, {
    openChat: false,
    prompt: 'tab-local baseline',
    targetChars: 16,
    reasoningChars: 0,
    chunkChars: 16,
  })

  const first = await context.newPage()
  await page.close()
  const second = await context.newPage()
  try {
    await first.goto(`/?debug#/chat/${initial.chatId}`)
    await expect(
      first.locator(`[data-ui="message"][data-message-id="${initial.assistantMessageId}"]`),
    ).toBeVisible()
    await expect
      .poll(() => first.evaluate(() => window.location.hash))
      .toBe(`#/chat/${initial.chatId}/message/${initial.assistantMessageId}`)

    await second.goto(`/?debug#/chat/${initial.chatId}/message/${initial.assistantMessageId}`)
    await expect(
      second.locator(`[data-ui="message"][data-message-id="${initial.assistantMessageId}"]`),
    ).toBeVisible()

    const extension = await startDebugStream(second, {
      chatId: initial.chatId,
      openChat: false,
      prompt: 'shared linear extension',
      targetChars: 24,
      reasoningChars: 0,
      chunkChars: 24,
    })
    await expect(
      first.locator(`[data-ui="message"][data-message-id="${extension.assistantMessageId}"]`),
    ).toBeVisible()
    await expect
      .poll(() => first.evaluate(() => window.location.hash))
      .toBe(`#/chat/${initial.chatId}/message/${extension.assistantMessageId}`)
    await startMessageCountRecorder(first)
    await first.evaluate(() => {
      const win = window as typeof window & {
        __remoteTailSamples?: string[]
        __remoteTailObserver?: MutationObserver
      }
      const sample = () => {
        const rows = document.querySelectorAll(
          '[data-ui="message"][data-role="assistant"][data-message-id]',
        )
        const id =
          rows.length === 0 ? null : rows.item(rows.length - 1).getAttribute('data-message-id')
        if (id) win.__remoteTailSamples?.push(id)
      }
      win.__remoteTailSamples = []
      win.__remoteTailObserver = new MutationObserver(sample)
      win.__remoteTailObserver.observe(document.body, { childList: true, subtree: true })
      sample()
    })
    const newerSibling = await startDebugStream(second, {
      chatId: initial.chatId,
      parentMessageId: extension.userMessageId,
      openChat: false,
      targetChars: 32,
      reasoningChars: 0,
      chunkChars: 32,
    })

    const firstAccepted = first.locator(
      `[data-ui="message"][data-message-id="${extension.assistantMessageId}"]`,
    )
    const secondAccepted = second.locator(
      `[data-ui="message"][data-message-id="${newerSibling.assistantMessageId}"]`,
    )
    await expect(firstAccepted.locator('[data-ui="branch-count"]')).toHaveText('1 / 2')
    await expect(secondAccepted.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')
    await expect(
      first.locator(`[data-ui="message"][data-message-id="${newerSibling.assistantMessageId}"]`),
    ).toHaveCount(0)
    await expect
      .poll(() => first.evaluate(() => window.location.hash))
      .toBe(`#/chat/${initial.chatId}/message/${extension.assistantMessageId}`)
    await expect
      .poll(() => second.evaluate(() => window.location.hash))
      .toBe(`#/chat/${initial.chatId}/message/${newerSibling.assistantMessageId}`)
    const remoteTailSamples = await first.evaluate(() => {
      const win = window as typeof window & {
        __remoteTailSamples?: string[]
        __remoteTailObserver?: MutationObserver
      }
      win.__remoteTailObserver?.disconnect()
      return win.__remoteTailSamples ?? []
    })
    expect(remoteTailSamples).toContain(extension.assistantMessageId)
    expect(remoteTailSamples).not.toContain(newerSibling.assistantMessageId)
    expect(await stopMessageCountRecorder(first)).toEqual({
      anchorRemoved: false,
      listRemoved: false,
      listReplaced: false,
      loadingSeen: false,
      messageCountsIncludeZero: false,
      recyclingSeen: false,
    })
  } finally {
    await Promise.allSettled([first.close(), second.close()])
  }
})

test('simultaneous regenerates keep route, cursor, and counts local to each tab', async ({
  page,
}) => {
  const completionRoute = '**/api/v1/chat/completions'
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'regenerate-baseline', content: 'baseline answer' },
      { finish: 'stop' },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'regenerate in two tabs')
  const baseline = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(baseline.locator('[data-ui="message-body"]')).toHaveText('baseline answer')
  const chatId = await firstChatId(page)
  const baselineId = await baseline.getAttribute('data-message-id')
  if (!baselineId) throw new Error('baseline assistant has no id')
  await page.unroute(completionRoute)

  const second = await page.context().newPage()
  let releaseA!: () => void
  let releaseB!: () => void
  let markRequestedA!: () => void
  let markRequestedB!: () => void
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve
  })
  const gateB = new Promise<void>((resolve) => {
    releaseB = resolve
  })
  const requestedA = new Promise<void>((resolve) => {
    markRequestedA = resolve
  })
  const requestedB = new Promise<void>((resolve) => {
    markRequestedB = resolve
  })
  try {
    await second.goto(`/#/chat/${chatId}/message/${baselineId}`)
    await expect(
      second.locator(`[data-ui="message"][data-message-id="${baselineId}"]`),
    ).toBeVisible()

    await page.route(completionRoute, async (route) => {
      markRequestedA()
      await gateA
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: 'regenerate-a', content: 'answer from tab A' },
          { finish: 'stop' },
        ]),
      })
    })
    await second.route(completionRoute, async (route) => {
      markRequestedB()
      await gateB
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: 'regenerate-b', content: 'answer from tab B' },
          { finish: 'stop' },
        ]),
      })
    })

    await page
      .locator(`[data-ui="message"][data-message-id="${baselineId}"]`)
      .locator('[data-action="regenerate"]')
      .click()
    await requestedA
    const targetA = await readRouteMessageId(page, chatId)

    await second
      .locator(`[data-ui="message"][data-message-id="${baselineId}"]`)
      .locator('[data-action="regenerate"]')
      .click()
    await requestedB
    const targetB = await readRouteMessageId(second, chatId)
    expect(targetB).not.toBe(targetA)

    const branchA = page.locator(`[data-ui="message"][data-message-id="${targetA}"]`)
    const branchB = second.locator(`[data-ui="message"][data-message-id="${targetB}"]`)
    await expect(branchA.locator('[data-ui="branch-count"]')).toHaveText('2 / 3')
    await expect(branchB.locator('[data-ui="branch-count"]')).toHaveText('3 / 3')
    await expect(page.locator(`[data-ui="message"][data-message-id="${targetB}"]`)).toHaveCount(0)
    await expect(second.locator(`[data-ui="message"][data-message-id="${targetA}"]`)).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${targetA}`)
    await expect
      .poll(() => second.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${targetB}`)

    releaseA()
    releaseB()
    await expect(branchA.locator('[data-ui="message-body"]')).toContainText('answer from tab A')
    await expect(branchB.locator('[data-ui="message-body"]')).toContainText('answer from tab B')
    await expect(branchA.locator('[data-ui="branch-count"]')).toHaveText('2 / 3')
    await expect(branchB.locator('[data-ui="branch-count"]')).toHaveText('3 / 3')
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${targetA}`)
    await expect
      .poll(() => second.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${targetB}`)
  } finally {
    releaseA()
    releaseB()
    await second.close()
  }
})

test('bumping lastViewedAt on the active chat from tab B leaves the stream intact', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    delayMs: 1500,
    body: buildSseBody([{ id: 'lv', content: 'viewed-safe' }, { finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'view me')
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  // Chat row materializes on first send, so the lookup happens *after* sending.
  const chatId = await firstChatId(page)

  // Simulate a peer tab bumping lastViewedAt via IDB while the stream is live.
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('chats', 'readwrite')
        const store = tx.objectStore('chats')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
          const row = getReq.result as Record<string, unknown>
          row.lastViewedAt = Date.now()
          store.put(row)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, chatId)

  // Stream still completes and the assistant row finalises.
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('viewed-safe', { timeout: 5000 })
})

test('renaming the chat while streaming does not abort the stream', async ({ page }) => {
  await mockChatCompletions(page, {
    delayMs: 1500,
    body: buildSseBody([{ id: 'rn', content: 'renamed-ok' }, { finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'keep streaming')
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  // Chat row materializes on first send, so the lookup happens *after* sending.
  const chatId = await firstChatId(page)

  // Direct IDB title rename, emulating a peer-tab rename that lands before
  // the stream finishes. (The full inline-title editor arrives in Phase 8.)
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('chats', 'readwrite')
        const store = tx.objectStore('chats')
        const getReq = store.get(id)
        getReq.onsuccess = () => {
          const row = getReq.result as Record<string, unknown>
          row.title = 'Renamed Mid-Stream'
          store.put(row)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, chatId)

  // Assertion: the assistant row still completes with the streamed reply.
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('renamed-ok', { timeout: 5000 })
})

interface DebugStreamResult {
  chatId: string
  userMessageId: string
  assistantMessageId: string
}

async function startDebugStream(
  page: Page,
  options: Record<string, unknown>,
): Promise<DebugStreamResult> {
  await page.waitForFunction(
    () =>
      typeof (window as typeof window & { __debugFakeStream?: unknown }).__debugFakeStream ===
      'object',
  )
  return page.evaluate(async (input) => {
    const api = (
      window as typeof window & {
        __debugFakeStream?: {
          start(options: Record<string, unknown>): Promise<DebugStreamResult>
        }
      }
    ).__debugFakeStream
    if (!api) throw new Error('debug fake stream API unavailable')
    return api.start(input)
  }, options)
}

async function readRouteMessageId(page: Page, chatId: string): Promise<string> {
  const routePrefix = `#/chat/${chatId}/message/`
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toMatch(new RegExp(`^${routePrefix}`))
  const hash = await page.evaluate(() => window.location.hash)
  const messageId = hash.slice(routePrefix.length)
  if (!messageId) throw new Error('active route has no message id')
  return messageId
}

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
    await expect
      .poll(() => readCursorSelection(first, initial.chatId, extension.userMessageId))
      .toBe(extension.assistantMessageId)

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
    await expect
      .poll(() => readCursorSelection(first, initial.chatId, extension.userMessageId))
      .toBe(extension.assistantMessageId)
    await expect
      .poll(() => readCursorSelection(second, initial.chatId, extension.userMessageId))
      .toBe(newerSibling.assistantMessageId)
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

async function readCursorSelection(
  page: Page,
  chatId: string,
  parentId: string,
): Promise<string | null> {
  return page.evaluate(
    async ({ activeChatId, activeParentId }) => {
      const storePath = '/src/store/zustand/chatStore.ts'
      const module = (await import(/* @vite-ignore */ storePath)) as {
        useChatStore: {
          getState(): {
            getCursor(id: string): Record<string, string> | undefined
          }
        }
      }
      return module.useChatStore.getState().getCursor(activeChatId)?.[activeParentId] ?? null
    },
    { activeChatId: chatId, activeParentId: parentId },
  )
}

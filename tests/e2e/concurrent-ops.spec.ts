import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

// Phase 7 scope of the §6.11.1 concurrent-ops-during-stream matrix.
// While one tab is streaming, certain ops in another tab/context must NOT
// abort the stream nor corrupt the placeholder, and the stream target must
// remain exclusive.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
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
  // Chat row materializes on first send, so we look it up *after* sending.
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
  // Chat row materializes on first send, so we look it up *after* sending.
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

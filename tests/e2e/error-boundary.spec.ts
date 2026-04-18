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

// Phase 7 required spec: a deliberate React render crash inside a single
// Message must NOT take down the rest of the chat. The crashed row should
// show a replacement block; other messages + composer remain interactive.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('a single crashed Message renders a replacement; peers remain interactive', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'boundary', content: 'ok-1', finish: 'stop' },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello one')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').first(),
  ).toBeVisible()

  const chatId = await firstChatId(page)
  // Toggle debugCrash=true on the first assistant row. The raw IDB write
  // bypasses Dexie's live-query, so we reload the page to pick up the fresh
  // row and trigger the error boundary on re-render.
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite')
        const store = tx.objectStore('messages')
        const index = store.index('chatId')
        const cursorReq = index.openCursor(id)
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (!cursor) return
          const row = cursor.value as Record<string, unknown>
          if (row.role === 'assistant') {
            row.debugCrash = true
            cursor.update(row)
          }
          cursor.continue()
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, chatId)
  await page.reload()
  // The URL preserves the active chat — no need to manually re-click the row.

  // The crashed row shows the replacement block.
  const crashed = page.locator('[data-ui="message"][data-state="crashed"]')
  await expect(crashed).toBeVisible()
  await expect(crashed.locator('[data-ui="message-crash"]')).toBeVisible()

  // The user row still renders normally.
  await expect(
    page.locator('[data-ui="message"][data-role="user"]').first().locator('[data-ui="message-body"]'),
  ).toHaveText('hello one')

  // Composer still works: queue a second mock, send, see a new assistant row.
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'boundary-2', content: 'ok-2', finish: 'stop' },
    ]),
  })
  await sendMessage(page, 'second')
  // After the crash, the message list still receives + renders new rows.
  // There will be: user "hello one", crashed block, user "second", assistant "ok-2".
  await expect(
    page.locator('[data-ui="message"][data-role="user"]').nth(1).locator('[data-ui="message-body"]'),
  ).toHaveText('second')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').last().locator('[data-ui="message-body"]'),
  ).toHaveText('ok-2')
})

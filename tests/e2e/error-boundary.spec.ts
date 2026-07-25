import { expect, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

test.use({
  runtimeDiagnosticAllowances: [
    {
      category: ['page-error', 'console-other'],
      message:
        "^(?:(?:TypeError: )?Cannot read properties of null \\(reading 'toLocaleString'\\)(?:\\n|$)|The above error occurred in the <MessageInner> component\\.)",
    },
  ],
})

// Phase 7 required spec: a deliberate React render crash inside a single
// Message must NOT take down the rest of the chat. The crashed row should
// show a replacement block; other messages + composer remain interactive.

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('a single crashed Message renders a replacement; peers remain interactive', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'boundary', content: 'ok-1', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello one')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toBeVisible()

  const chatId = await firstChatId(page)
  await waitForAssistantGenerationFinished(page, chatId)
  // Corrupt one header exactly as an out-of-band storage/debugger edit could. The
  // raw IDB write bypasses the repository changefeed, so reload to exercise the
  // real row boundary without adding a test-only branch to production rendering.
  const databaseName = await activeWorkspaceDatabaseName(page)
  await page.evaluate(
    async ({ databaseName, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(databaseName)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('messages', 'readwrite')
          const index = tx.objectStore('messages').index('chatId')
          const cursorReq = index.openCursor(id)
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor) return
            const row = cursor.value as Record<string, unknown>
            if (row.role === 'assistant') {
              const generation = (row.generation as Record<string, unknown> | undefined) ?? {
                model: 'boundary-model',
                status: 'complete',
              }
              const usage =
                typeof generation.usage === 'object' && generation.usage !== null
                  ? generation.usage
                  : {}
              generation.usage = {
                ...usage,
                completion_tokens: null,
              }
              row.generation = generation
              cursor.update(row)
              return
            }
            cursor.continue()
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    },
    { databaseName, id: chatId },
  )
  await page.reload()
  // The URL preserves the active chat — no need to manually re-click the row.

  // The crashed row shows the replacement block.
  const crashed = page.locator('[data-ui="message"][data-state="crashed"]')
  await expect(crashed).toBeVisible()
  await expect(crashed.locator('[data-ui="message-crash"]')).toBeVisible()

  // The user row still renders normally.
  await expect(
    page
      .locator('[data-ui="message"][data-role="user"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('hello one')

  // Composer still works: queue a second mock, send, see a new assistant row.
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'boundary-2', content: 'ok-2', finish: 'stop' }]),
  })
  await sendMessage(page, 'second')
  // After the crash, the message list still receives + renders new rows.
  // There will be: user "hello one", crashed block, user "second", assistant "ok-2".
  await expect(
    page
      .locator('[data-ui="message"][data-role="user"]')
      .nth(1)
      .locator('[data-ui="message-body"]'),
  ).toHaveText('second')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .last()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('ok-2')
})

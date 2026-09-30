import { expect, test } from './fixtures'
import { clearIndexedDb, seedFirstRun } from './helpers'

// The orphan sweep (Shell.tsx → recoverOrphans on mount) rescues any message
// whose `generation.startedAt` is set without `finishedAt` by marking it
// `abortReason: 'tab-close'`. A mid-stream close isn't needed for this spec;
// the test synthesizes an orphan row directly in IDB and reloads.

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('orphan in-flight message is marked tab-close on next mount', async ({ page }) => {
  // Seed one chat so the sidebar + activeChatId selector have something to work with.
  await page.locator('[data-role="new-chat"]').click()
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()

  // Inject an orphan assistant message directly into the messages store.
  const orphanId = 'orphan-01HYZ9V4T9EXAMPLE0000000'

  await page.evaluate(
    async ({ id }) => {
      return globalThis.__natterNativeStorageFixture.active(
        { purpose: 'fault-injection' },
        async (db, request) => {
          const chats = (await request(
            db.transaction('chats', 'readonly').objectStore('chats').getAll(),
          )) as Array<{ id: string }>
          const chatId = chats[0]?.id ?? ''
          const tx = db.transaction(['messages', 'messageBodies'], 'readwrite')
          tx.objectStore('messages').put({
            id,
            chatId,
            parentId: null,
            siblingIndex: 0,
            turnId: `${id}-turn`,
            turnIndex: 0,
            createdAt: 1,
            role: 'assistant',
            origin: 'generated',
            nodeVersion: 0,
            deleted: false,
            generation: {
              id: '',
              model: 'google/gemini-3.1-flash-lite-preview',
              requestedModel: 'google/gemini-3.1-flash-lite-preview',
              apiUsed: 'chat',
              delivery: 'streaming',
              costSource: 'stream',
              startedAt: 100,
            },
          })
          tx.objectStore('messageBodies').put({
            id,
            chatId,
            nodeVersion: 0,
            updatedAt: 100,
            content: [{ type: 'output_text', text: 'partial' }],
          })
        },
      )
    },
    { id: orphanId },
  )

  // Reload so Shell.tsx's useEffect fires recoverOrphans.
  await page.reload()
  // Wait until recoverOrphans commits.
  await page.waitForFunction(
    async ({ id }) => {
      return globalThis.__natterNativeStorageFixture.active(
        { purpose: 'read-only-assertion' },
        async (db, request) => {
          const row = (await request(
            db.transaction('messages', 'readonly').objectStore('messages').get(id),
          )) as { generation?: { abortReason?: string } }
          return row.generation?.abortReason === 'tab-close'
        },
      )
    },
    { id: orphanId },
    { timeout: 5000 },
  )
})

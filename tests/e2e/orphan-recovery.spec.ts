import { expect, test } from '@playwright/test'
import { clearIndexedDb, seedFirstRun } from './helpers'

// The orphan sweep (Shell.tsx → recoverOrphans on mount) rescues any message
// whose `generation.startedAt` is set without `finishedAt` by marking it
// `abortReason: 'tab-close'`. A mid-stream close isn't needed for this spec;
// the test synthesizes an orphan row directly in IDB and reloads.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('orphan in-flight message is marked tab-close on next mount', async ({ page }) => {
  // Seed one chat so the sidebar + activeChatId selector have something to work with.
  await page.locator('[data-role="new-chat"]').click()
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()

  // Inject an orphan assistant message directly into the messages store.
  const orphanId = 'orphan-01HYZ9V4T9EXAMPLE0000000'
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      const chatId = await new Promise<string>((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly')
        const req = tx.objectStore('chats').getAll()
        req.onsuccess = () => resolve((req.result as Array<{ id: string }>)[0]?.id ?? '')
        req.onerror = () => reject(req.error)
      })
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('messages', 'readwrite')
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
          content: [{ type: 'output_text', text: 'partial' }],
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
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, orphanId)

  // Reload so Shell.tsx's useEffect fires recoverOrphans.
  await page.reload()
  // Wait until recoverOrphans commits.
  await page.waitForFunction(
    async (id) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        const row = await new Promise<{ generation?: { abortReason?: string } }>(
          (resolve, reject) => {
            const tx = db.transaction('messages', 'readonly')
            const req = tx.objectStore('messages').get(id)
            req.onsuccess = () => resolve(req.result as { generation?: { abortReason?: string } })
            req.onerror = () => reject(req.error)
          },
        )
        return row?.generation?.abortReason === 'tab-close'
      } finally {
        db.close()
      }
    },
    orphanId,
    { timeout: 5000 },
  )
})

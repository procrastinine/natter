import { expect, test } from './fixtures'
import { clearIndexedDb } from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test.afterEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test('a poisoned local database shows recovery instead of a blank root', async ({ page }) => {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['settings', 'attachments', 'messages'], 'readwrite')
        transaction.objectStore('settings').delete('backfill:attachment-refs-v1')
        transaction.objectStore('attachments').put({ id: 'attachment-poison', refCount: 0 })
        const duplicateRef = {
          refId: 'duplicate-ref',
          attachmentId: 'attachment-poison',
          includeInContext: true,
          messageId: 'message-poison',
          createdAt: 1,
          updatedAt: 1,
        }
        transaction.objectStore('messages').put({
          id: 'message-poison',
          chatId: 'chat-poison',
          createdAt: 1,
          attachmentRefs: [duplicateRef, { ...duplicateRef }],
        })
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
  })

  await page.reload()
  const recovery = page.locator('[data-ui="workspace-bootstrap"]')
  await expect(recovery).toHaveAttribute('data-state', 'failed')
  await expect(recovery.getByRole('heading')).toHaveText('The workspace upgrade did not finish')
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy diagnostics' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset local data' })).toBeHidden()
})

import { expect, test } from '@playwright/test'
import { clearIndexedDb, seedFirstRun } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('oversized stream lane auto-compacts and the avatar cycles compact -> peek -> full', async ({
  page,
}) => {
  const huge = 'abcdefghij'.repeat(2500)
  const chatId = 'oversize-chat'
  await page.evaluate(
    async ({ activeChatId, hugeMessage }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const now = Date.now()
          const userId = 'oversize-user'
          const assistantId = 'oversize-assistant'
          const tx = db.transaction(['presets', 'messages', 'chats', 'settings'], 'readwrite')
          const chats = tx.objectStore('chats')
          const messages = tx.objectStore('messages')
          const presets = tx.objectStore('presets')
          const settings = tx.objectStore('settings')
          settings.put({ key: 'global:long-message-display-mode', value: 'compact' })
          const getPresetsReq = presets.getAll()
          getPresetsReq.onsuccess = () => {
            const preset = getPresetsReq.result?.[0]
            if (!preset?.settings) {
              reject(new Error('missing seed preset'))
              return
            }
            chats.put({
              id: activeChatId,
              title: 'Overflow test',
              titleStatus: 'manual',
              createdAt: now,
              updatedAt: now + 1,
              lastViewedAt: now + 1,
              wordCount: 0,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: preset.settings,
              presetId: preset.id,
              lastUpdatedLeafId: assistantId,
              lastBranchUpdatedAt: now + 1,
              archived: false,
              pinned: false,
              folderId: null,
              tags: [],
            })
            messages.put({
              id: userId,
              chatId: activeChatId,
              parentId: null,
              siblingIndex: 0,
              turnId: 'oversize-turn-user',
              turnIndex: 0,
              createdAt: now,
              role: 'user',
              origin: 'user',
              content: [{ type: 'text', text: 'flood me' }],
              nodeVersion: 0,
              deleted: false,
            })
            messages.put({
              id: assistantId,
              chatId: activeChatId,
              parentId: userId,
              siblingIndex: 0,
              turnId: 'oversize-turn-assistant',
              turnIndex: 0,
              createdAt: now + 1,
              role: 'assistant',
              origin: 'generated',
              content: [{ type: 'output_text', text: hugeMessage }],
              nodeVersion: 0,
              deleted: false,
            })
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    },
    { activeChatId: chatId, hugeMessage: huge },
  )
  await page.goto(`/?overflow=${Date.now()}#/chat/${chatId}`)
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  const avatar = assistant.locator('[data-ui="profile-glyph-button"]').first()
  await expect(assistant).toBeVisible()
  await expect(assistant).toHaveAttribute('data-collapse-mode', 'compact')
  await expect(page.locator('[data-ui="stream-overflow"]')).toHaveCount(0)
  await avatar.click()
  await expect(assistant).toHaveAttribute('data-collapse-mode', 'peek')
  await avatar.click()
  await expect(assistant).toHaveAttribute('data-collapse-mode', 'full')
})

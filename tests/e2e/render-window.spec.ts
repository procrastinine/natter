import { expect, type Page, test } from '@playwright/test'
import { clearIndexedDb, seedFirstRun } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('global settings exposes render-window controls on the Performance tab', async ({ page }) => {
  await page.locator('[data-ui="open-global-settings"]').click()
  await page.getByRole('tab', { name: 'Performance' }).click()

  await expect(page.locator('[data-ui="message-render-window-load-mode"]')).toHaveValue('auto')
  await expect(page.locator('[data-ui="sidebar-render-window-load-mode"]')).toHaveValue('auto')
  await expect(page.getByLabel('Newest messages')).toHaveValue('10')
  await expect(page.getByLabel('First rows')).toHaveValue('50')
})

test('chat transcript mounts only the newest message window and loads older batches manually', async ({
  page,
}) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 24,
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.goto(`/#/chat/${chatId}`)
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)
  await expect(page.locator('[data-ui="message"]').first()).toContainText('window message 14')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-total-count', '24')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
    'data-rendered-count',
    '10',
  )

  await page.locator('[data-ui="load-more-messages"]').click()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(20)
  await expect(page.locator('[data-ui="message"]').first()).toContainText('window message 4')

  await page.locator('[data-ui="load-more-messages"]').click()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(24)
  await expect(page.locator('[data-ui="load-more-messages"]')).toHaveCount(0)
})

test('sidebar mounts only the first row window and loads more rows manually', async ({ page }) => {
  await seedSidebarChats(page, {
    chatCount: 65,
    settings: {
      'global:sidebar-render-window-size': 50,
      'global:sidebar-render-window-load-mode': 'manual',
    },
  })
  await page.goto('/')

  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(50)
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-total-count', '65')
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-rendered-count', '50')

  await page.locator('[data-ui="load-more-sidebar"]').click()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(65)
  await expect(page.locator('[data-ui="load-more-sidebar"]')).toHaveCount(0)
})

async function seedLinearChat(
  page: Page,
  input: {
    messageCount: number
    settings?: Record<string, unknown>
  },
): Promise<string> {
  return page.evaluate(async ({ messageCount, settings }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const now = Date.now()
    const chatId = 'render-window-chat'
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          ['presets', 'settings', 'chats', 'messages', 'messageBodies'],
          'readwrite',
        )
        const presets = tx.objectStore('presets')
        const settingsStore = tx.objectStore('settings')
        const chats = tx.objectStore('chats')
        const messages = tx.objectStore('messages')
        const messageBodies = tx.objectStore('messageBodies')
        const presetsReq = presets.getAll()
        presetsReq.onsuccess = () => {
          const preset = (presetsReq.result as Array<{ id?: string; settings?: unknown }>)[0]
          const chatSettings = structuredClone(preset?.settings ?? {})
          for (const [key, value] of Object.entries(settings ?? {})) {
            settingsStore.put({ key, value })
          }
          const lastMessageId = `msg-${String(messageCount - 1).padStart(3, '0')}`
          chats.put({
            id: chatId,
            title: 'Render window chat',
            titleStatus: 'manual',
            createdAt: now,
            updatedAt: now + messageCount,
            lastViewedAt: now + messageCount,
            wordCount: messageCount * 2,
            totalCostUsd: 0,
            metaVersion: 0,
            summaryVersion: 0,
            settings: chatSettings,
            presetId: preset?.id,
            lastUpdatedLeafId: lastMessageId,
            lastBranchUpdatedAt: now + messageCount,
            archived: false,
            pinned: false,
            folderId: null,
            tags: [],
            previewText: 'window message 0',
          })
          let parentId: string | null = null
          for (let i = 0; i < messageCount; i += 1) {
            const id = `msg-${String(i).padStart(3, '0')}`
            const role = i % 2 === 0 ? 'user' : 'assistant'
            const createdAt = now + i
            messages.put({
              id,
              chatId,
              parentId,
              siblingIndex: 0,
              turnId: `turn-${String(i).padStart(3, '0')}`,
              turnIndex: i,
              createdAt,
              role,
              origin: role === 'user' ? 'user' : 'generated',
              nodeVersion: 0,
              deleted: false,
            })
            messageBodies.put({
              id,
              chatId,
              nodeVersion: 0,
              updatedAt: createdAt,
              content: [{ type: 'text', text: `window message ${i}` }],
            })
            parentId = id
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
    return chatId
  }, input)
}

async function seedSidebarChats(
  page: Page,
  input: {
    chatCount: number
    settings?: Record<string, unknown>
  },
): Promise<void> {
  await page.evaluate(async ({ chatCount, settings }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const now = Date.now()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['presets', 'settings', 'chats'], 'readwrite')
        const presets = tx.objectStore('presets')
        const settingsStore = tx.objectStore('settings')
        const chats = tx.objectStore('chats')
        const presetsReq = presets.getAll()
        presetsReq.onsuccess = () => {
          const preset = (presetsReq.result as Array<{ id?: string; settings?: unknown }>)[0]
          const chatSettings = structuredClone(preset?.settings ?? {})
          for (const [key, value] of Object.entries(settings ?? {})) {
            settingsStore.put({ key, value })
          }
          for (let i = 0; i < chatCount; i += 1) {
            chats.put({
              id: `sidebar-window-chat-${String(i).padStart(3, '0')}`,
              title: `Sidebar window chat ${String(i).padStart(2, '0')}`,
              titleStatus: 'manual',
              createdAt: now - i,
              updatedAt: now - i,
              lastViewedAt: now - i,
              wordCount: 10,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: chatSettings,
              presetId: preset?.id,
              lastUpdatedLeafId: null,
              lastBranchUpdatedAt: now - i,
              archived: false,
              pinned: false,
              folderId: null,
              tags: [],
              previewText: `sidebar preview ${i}`,
            })
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, input)
}

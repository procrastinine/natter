import { expect, type Page, test } from '@playwright/test'
import { buildSseBody, clearIndexedDb, seedFirstRun, seedLinearChat, sendMessage } from './helpers'

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
    chatId: 'render-window-chat',
    title: 'Render window chat',
    textPrefix: 'window message',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
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

test('send and regenerate keep the transcript mounted while the branch window reloads', async ({
  page,
}) => {
  let requestCount = 0
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    await new Promise((resolve) => setTimeout(resolve, 120))
    const text = requestCount === 1 ? 'sent answer' : 'regenerated answer'
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `render-window-${requestCount}`, content: text },
        { finish: 'stop' },
      ]),
    })
  })
  const chatId = await seedLinearChat(page, {
    messageCount: 24,
    chatId: 'render-window-chat',
    title: 'Render window chat',
    textPrefix: 'window message',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)

  await startMessageCountRecorder(page)
  await sendMessage(page, 'new prompt')
  await expect(
    page.locator('[data-ui="message"]').last().locator('[data-ui="message-body"]'),
  ).toContainText('sent answer')
  await expect(await stopMessageCountRecorder(page)).not.toContain(0)

  await startMessageCountRecorder(page)
  await page
    .locator('[data-ui="message"][data-role="assistant"]')
    .last()
    .locator('[data-action="regenerate"]')
    .click()
  await expect(
    page.locator('[data-ui="message"]').last().locator('[data-ui="message-body"]'),
  ).toContainText('regenerated answer')
  await expect(await stopMessageCountRecorder(page)).not.toContain(0)
})

test('switching message variants re-renders the selected branch window', async ({ page }) => {
  const chatId = await seedBranchedChat(page)

  await page.goto(`/#/chat/${chatId}/message/A2`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="message"]').nth(1)).toContainText('branch A user')
  await expect(page.locator('[data-ui="message"]').nth(2)).toContainText('branch A assistant')

  await page
    .locator('[data-ui="message"]')
    .filter({ hasText: 'branch A user' })
    .getByLabel('Next variant')
    .click()

  await expect(page.locator('[data-ui="message"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="message"]').nth(1)).toContainText('branch B user')
  await expect(page.locator('[data-ui="message"]').nth(2)).toContainText('branch B assistant')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-rendered-count', '3')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-total-count', '3')
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
  await page.reload()

  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(50)
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-total-count', '65')
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-rendered-count', '50')

  await page.locator('[data-ui="load-more-sidebar"]').click()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(65)
  await expect(page.locator('[data-ui="load-more-sidebar"]')).toHaveCount(0)
})

async function startMessageCountRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as Window & {
      __messageCountSamples?: number[]
      __stopMessageCountSamples?: () => void
    }
    win.__stopMessageCountSamples?.()
    const samples: number[] = []
    const sample = () => samples.push(document.querySelectorAll('[data-ui="message"]').length)
    const root = document.querySelector('[data-ui="message-list"]')
    const observer = root ? new MutationObserver(sample) : null
    observer?.observe(root as Node, { childList: true, subtree: true })
    sample()
    win.__messageCountSamples = samples
    win.__stopMessageCountSamples = () => observer?.disconnect()
  })
}

async function stopMessageCountRecorder(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const win = window as Window & {
      __messageCountSamples?: number[]
      __stopMessageCountSamples?: () => void
    }
    win.__stopMessageCountSamples?.()
    const samples = win.__messageCountSamples ?? []
    delete win.__messageCountSamples
    delete win.__stopMessageCountSamples
    return samples
  })
}

async function seedBranchedChat(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const now = Date.now()
    const chatId = 'render-window-branch-chat'
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
          settingsStore.put({ key: 'global:message-render-window-size', value: 3 })
          settingsStore.put({ key: 'global:message-render-window-load-mode', value: 'manual' })
          chats.put({
            id: chatId,
            title: 'Render branch window chat',
            titleStatus: 'manual',
            createdAt: now,
            updatedAt: now + 4,
            lastViewedAt: now + 4,
            wordCount: 12,
            totalCostUsd: 0,
            metaVersion: 0,
            summaryVersion: 0,
            settings: chatSettings,
            presetId: preset?.id,
            lastUpdatedLeafId: 'B2',
            lastBranchUpdatedAt: now + 4,
            archived: false,
            pinned: false,
            folderId: null,
            tags: [],
            previewText: 'branch B assistant',
          })
          const rows = [
            {
              id: 'root',
              parentId: null,
              siblingIndex: 0,
              turnIndex: 0,
              role: 'system',
              origin: 'system',
              text: 'root instruction',
            },
            {
              id: 'A1',
              parentId: 'root',
              siblingIndex: 0,
              turnIndex: 1,
              role: 'user',
              origin: 'user',
              text: 'branch A user',
            },
            {
              id: 'A2',
              parentId: 'A1',
              siblingIndex: 0,
              turnIndex: 2,
              role: 'assistant',
              origin: 'generated',
              text: 'branch A assistant',
            },
            {
              id: 'B1',
              parentId: 'root',
              siblingIndex: 1,
              turnIndex: 1,
              role: 'user',
              origin: 'user',
              text: 'branch B user',
            },
            {
              id: 'B2',
              parentId: 'B1',
              siblingIndex: 0,
              turnIndex: 2,
              role: 'assistant',
              origin: 'generated',
              text: 'branch B assistant',
            },
          ] as const
          rows.forEach((row, index) => {
            const createdAt = now + index
            messages.put({
              id: row.id,
              chatId,
              parentId: row.parentId,
              siblingIndex: row.siblingIndex,
              turnId: `turn-${row.id}`,
              turnIndex: row.turnIndex,
              createdAt,
              role: row.role,
              origin: row.origin,
              nodeVersion: 0,
              deleted: false,
            })
            messageBodies.put({
              id: row.id,
              chatId,
              nodeVersion: 0,
              updatedAt: createdAt,
              content:
                row.role === 'assistant'
                  ? [{ type: 'output_text', text: row.text }]
                  : [{ type: 'text', text: row.text }],
            })
          })
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
    return chatId
  })
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

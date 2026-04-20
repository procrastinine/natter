import { expect, test } from '@playwright/test'
import { clearIndexedDb, seedFirstRun } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('mirrored Claude reasoning renders once in the UI and shows reasoning time in message info', async ({
  page,
}) => {
  const chatId = 'reasoning-chat'
  await page.evaluate(async (activeChatId) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const now = Date.now()
        const userId = 'reasoning-user'
        const assistantId = 'reasoning-assistant'
        const tx = db.transaction(['presets', 'messages', 'chats'], 'readwrite')
        const chats = tx.objectStore('chats')
        const messages = tx.objectStore('messages')
        const presets = tx.objectStore('presets')
        const getPresetsReq = presets.getAll()
        getPresetsReq.onsuccess = () => {
          const preset = getPresetsReq.result?.[0]
          if (!preset?.settings) {
            reject(new Error('missing seed preset'))
            return
          }
          chats.put({
            id: activeChatId,
            title: 'Reasoning test',
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
            lastUpdatedLeafId: 'reasoning-assistant',
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
            turnId: 'reasoning-turn-user',
            turnIndex: 0,
            createdAt: now,
            role: 'user',
            origin: 'user',
            content: [{ type: 'text', text: 'prove it' }],
            nodeVersion: 0,
            deleted: false,
          })
          messages.put({
            id: assistantId,
            chatId: activeChatId,
            parentId: userId,
            siblingIndex: 0,
            turnId: 'reasoning-turn-assistant',
            turnIndex: 0,
            createdAt: now + 1,
            role: 'assistant',
            origin: 'generated',
            content: [{ type: 'output_text', text: 'The ratio is Cauchy.' }],
            reasoningDetails: [
              { type: 'reasoning.text', index: 0, text: 'Let' },
              { type: 'reasoning.text', index: 0, text: 'Let me' },
            ],
            nodeVersion: 0,
            deleted: false,
            generation: {
              id: 'gen-reasoning',
              model: 'anthropic/claude-sonnet-4.6',
              requestedModel: 'anthropic/claude-sonnet-4.6',
              apiUsed: 'chat',
              delivery: 'streaming',
              costSource: 'stream',
              startedAt: now,
              reasoningStartedAt: now + 100,
              firstTextAt: now + 1200,
              finishedAt: now + 1600,
            },
          })
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, chatId)
  await page.goto(`/#/chat/${chatId}`)

  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await assistant.locator('[data-ui="reasoning-summary"]').click()
  await expect(assistant.locator('[data-ui="reasoning-section"][data-reasoning-kind="text"]')).toHaveText(
    'Let me',
  )
  await assistant.locator('[data-role="message-action"][data-action="info"]').click()
  await expect(assistant.locator('[data-ui="message-info"]')).toContainText('Reasoning time')
  await expect(assistant.locator('[data-ui="message-info"]')).toContainText('1.10 s before answer')
})

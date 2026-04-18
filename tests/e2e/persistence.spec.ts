import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('reloading a chat preserves user + assistant messages and generation meta', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'gen-persist', content: 'persisted text' },
      { finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello persist')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('persisted text')

  await page.reload()
  // After reload we land on empty state (activeChatId is Zustand, ephemeral).
  await page.locator('[data-ui="chat-row-button"]').first().click()
  const reloadedAssistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(reloadedAssistant.locator('[data-ui="message-body"]')).toHaveText('persisted text')
})

test('multi-turn: second send includes prior turn in request body', async ({ page }) => {
  const bodies: unknown[] = []
  await page.route('**/api/v1/chat/completions', async (route, req) => {
    bodies.push(JSON.parse(req.postData() ?? '{}'))
    const suffix = bodies.length === 1 ? 'first-reply' : 'second-reply'
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([{ id: `g-${bodies.length}`, content: suffix, finish: 'stop' }]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'turn one')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').first().locator('[data-ui="message-body"]'),
  ).toHaveText('first-reply')
  await sendMessage(page, 'turn two')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').nth(1).locator('[data-ui="message-body"]'),
  ).toHaveText('second-reply')
  expect(bodies).toHaveLength(2)
  const secondMessages = (bodies[1] as { messages: Array<{ role: string; content: string }> }).messages
  const roles = secondMessages.map((m) => m.role)
  // First turn's user + assistant are echoed before turn two's user message.
  expect(roles).toEqual(['user', 'assistant', 'user'])
  expect(secondMessages[1]?.content).toBe('first-reply')
  expect(secondMessages[2]?.content).toBe('turn two')
})

test('streaming assistant row commits generation.finishedAt on close', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'bye', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'end')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').first().locator('[data-ui="message-body"]'),
  ).toHaveText('bye')
  const finishedAt = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<number | undefined>((resolve, reject) => {
        const tx = db.transaction('messages', 'readonly')
        const req = tx.objectStore('messages').getAll()
        req.onsuccess = () => {
          const rows = (req.result as Array<{ role: string; generation?: { finishedAt?: number } }>).filter(
            (r) => r.role === 'assistant',
          )
          resolve(rows[0]?.generation?.finishedAt)
        }
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
  expect(typeof finishedAt).toBe('number')
  expect(finishedAt).toBeGreaterThan(0)
})

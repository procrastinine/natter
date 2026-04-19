import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  readMessages,
  seedFirstRun,
  sendMessage,
} from './helpers'

async function getChatRow(page: Page, chatId: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly')
        const req = tx.objectStore('chats').get(id)
        req.onsuccess = () => resolve(req.result as Record<string, unknown>)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }, chatId)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('reloading a chat preserves user + assistant messages and generation meta', async ({
  page,
}) => {
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
  // The URL is the source of truth — reload restores the active chat directly,
  // no manual click needed.
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
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('first-reply')
  await sendMessage(page, 'turn two')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .nth(1)
      .locator('[data-ui="message-body"]'),
  ).toHaveText('second-reply')
  expect(bodies).toHaveLength(2)
  const secondMessages = (bodies[1] as { messages: Array<{ role: string; content: string }> })
    .messages
  const roles = secondMessages.map((m) => m.role)
  // First turn's user + assistant are echoed before turn two's user message.
  expect(roles).toEqual(['user', 'assistant', 'user'])
  expect(secondMessages[1]?.content).toBe('first-reply')
  expect(secondMessages[2]?.content).toBe('turn two')
})

test('chat.lastUpdatedLeafId points at the assistant row after send', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      {
        id: 'g',
        content: 'leaf',
        finish: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0.00002 },
      },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'one')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('leaf')

  const chatId = await firstChatId(page)
  const messages = await readMessages(page, chatId)
  const assistantRow = messages.find((m) => m.role === 'assistant') as { id: string }
  const chat = (await getChatRow(page, chatId)) as { lastUpdatedLeafId: string }
  expect(chat.lastUpdatedLeafId).toBe(assistantRow.id)
})

test('chat.totalCostUsd matches the sum of generation.cost across live rows', async ({ page }) => {
  let turn = 0
  await page.route('**/api/v1/chat/completions', async (route) => {
    turn += 1
    const cost = 0.0003
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `g-${turn}`, content: `reply ${turn}` },
        {
          finish: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost },
        },
      ]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'q1')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').nth(0)).toBeVisible()
  await sendMessage(page, 'q2')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').nth(1)).toBeVisible()

  const chatId = await firstChatId(page)
  const messages = (await readMessages(page, chatId)) as Array<{
    deleted: boolean
    generation?: { cost?: number }
  }>
  const liveSum = messages
    .filter((m) => !m.deleted)
    .reduce((acc, m) => acc + (m.generation?.cost ?? 0), 0)
  const chat = (await getChatRow(page, chatId)) as { totalCostUsd: number }
  expect(chat.totalCostUsd).toBeCloseTo(liveSum, 9)
  // Sanity — two turns at 0.0003 each means totalCostUsd is ≈ 0.0006.
  expect(chat.totalCostUsd).toBeCloseTo(0.0006, 6)
})

test('streaming assistant row commits generation.finishedAt on close', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'bye', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'end')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
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
          const rows = (
            req.result as Array<{ role: string; generation?: { finishedAt?: number } }>
          ).filter((r) => r.role === 'assistant')
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

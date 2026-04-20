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

// Phase 7 abort contract (per `plan/13-delivery.md` phase 7 required e2e):
// clicking the abort button mid-stream persists the placeholder with
// `generation.abortReason === 'user'` and surfaces the "Stream interrupted"
// row. Aborting BEFORE any chunk arrives still persists the placeholder.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('clicking abort mid-stream persists abortReason="user" and shows the interrupted row', async ({
  page,
}) => {
  // Hold the fetch open long enough for us to abort after the first chunk.
  await mockChatCompletions(page, {
    delayMs: 1500,
    body: buildSseBody([{ id: 'abort-mid', content: 'before-abort' }, { finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'slow please')
  // Wait until the abort control appears (stream is owning the placeholder).
  const abort = page.locator('[data-ui="abort"]')
  await expect(abort).toBeVisible()
  await abort.click()
  // The assistant placeholder persists with an abort banner.
  const abortBanner = page
    .locator('[data-ui="message"][data-role="assistant"]')
    .first()
    .locator('[data-ui="message-error"][data-role="abort"]')
  await expect(abortBanner).toBeVisible()
  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const assistant = rows.find((r) => r.role === 'assistant') as {
    generation: { abortReason?: string; finishedAt?: number }
  }
  expect(assistant.generation.abortReason).toBe('user')
  expect(typeof assistant.generation.finishedAt).toBe('number')
})

test('aborting before any chunk arrives still persists the placeholder', async ({ page }) => {
  // Mock a long hang BEFORE any SSE frames: the test aborts before any
  // accumulator text lands.
  await page.route('**/api/v1/chat/completions', async (route) => {
    // 3s so the click below races in first.
    await new Promise((r) => setTimeout(r, 3000))
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSseBody([{ id: 'unreached', content: 'x', finish: 'stop' }]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'cancel this')
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await page.locator('[data-ui="abort"]').click()
  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const assistant = rows.find((r) => r.role === 'assistant') as {
    content: Array<{ type: string; text: string }>
    generation: { abortReason?: string; finishedAt?: number }
  }
  expect(assistant).toBeDefined()
  // Content is empty (no chunks landed) but the row exists.
  expect(assistant.content).toEqual([{ type: 'output_text', text: '' }])
  expect(assistant.generation.abortReason).toBe('user')
  expect(typeof assistant.generation.finishedAt).toBe('number')
})

test('stop also aborts continue-in-place streams on existing assistant messages', async ({
  page,
}) => {
  let requestCount = 0
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    if (requestCount === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([{ id: 'seed', content: 'ready', finish: 'stop' }]),
      })
      return
    }
    await new Promise((r) => setTimeout(r, 1500))
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSseBody([{ id: 'continue', content: ' plus-more', finish: 'stop' }]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant).toContainText('ready')
  await assistant.locator('[data-action="continue"]').click()
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await page.locator('[data-ui="abort"]').click()
  await expect(page.locator('[data-ui="abort"]')).toBeHidden()
  await page.waitForTimeout(1800)
  await expect(assistant).toContainText('ready')
  await expect(assistant).not.toContainText('plus-more')
})

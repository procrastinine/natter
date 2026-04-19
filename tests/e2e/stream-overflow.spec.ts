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

test('oversized stream lane renders with a "show full" disclosure that reveals the complete body', async ({
  page,
}) => {
  // Payload must exceed the 20k threshold in MessageStreamOverflow.
  const huge = 'abcdefghij'.repeat(2500)
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'big-oversize', content: huge, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'flood me')
  const banner = page.locator('[data-ui="stream-overflow"]').first()
  await expect(banner).toBeVisible()
  await expect(banner).toContainText(/characters/i)
  await page.locator('[data-ui="stream-overflow-reveal"]').first().click()
  await expect(banner).toHaveCount(0)
})

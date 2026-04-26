import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

// Scroll-follow vs pinned-scroll (plan/13-delivery.md §13.3.0 Phase 8).

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('streaming text keeps the scroll region in follow state; scrolling up flips to pinned with a Jump chip', async ({
  page,
}) => {
  // Big output so the scroll region actually overflows.
  const huge = Array.from({ length: 200 }, (_, i) => `streamed line ${i}`).join('\n\n')
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'big-1', content: huge, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'fill the viewport')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').first().locator('[data-ui="message-body"]'),
  ).toContainText('streamed line 199')
  const region = page.locator('[data-ui="scroll-region"]')
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', {
    timeout: 5000,
  })

  await region.evaluate((node) => {
    node.scrollTop = Math.max(0, node.scrollTop - 5000)
    node.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned', {
    timeout: 3000,
  })
  const jumpChip = page.locator('[data-ui="jump-to-latest"]')
  await expect(jumpChip).toBeVisible()
  await jumpChip.click()
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', {
    timeout: 3000,
  })
})

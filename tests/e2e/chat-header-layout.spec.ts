import { expect, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test('non-OpenRouter actions stay adjacent when the privacy badge is absent', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'gen-header-layout', content: 'ready', finish: 'stop' }]),
  })
  await page.route('https://api.openai.com/v1/models', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  )
  await seedFirstRun(page)
  await createChatAndOpen(page)
  await sendMessage(page, 'Create a chat for the header layout check')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toContainText('ready')

  await addOpenAiConnection(page)

  const privacySlot = page.locator('[data-ui="desktop-header-privacy"]')
  await expect(privacySlot.locator(':scope > *')).toHaveCount(0)

  const spacing = await page.locator('[data-ui="chat-title-bar"]').evaluate((header) => {
    const tags = header.querySelector<HTMLElement>('[data-role="chat-tags"]')
    const download = header.querySelector<HTMLElement>('[data-role="chat-download"]')
    if (!tags || !download) throw new Error('Chat header actions are missing')
    const tagsRect = tags.getBoundingClientRect()
    const downloadRect = download.getBoundingClientRect()
    return {
      actual: downloadRect.left - tagsRect.right,
      expected: Number.parseFloat(getComputedStyle(header).gap),
    }
  })

  expect(spacing.actual).toBeCloseTo(spacing.expected, 1)
})

async function addOpenAiConnection(page: Page): Promise<void> {
  await page.locator('[data-ui="connection-provider-button"]').click()
  const row = page.locator('[data-ui="connection-row"]')
  await expect(row).toBeVisible()
  if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
  await page.locator('[data-ui="connection-new"]').click()
  await page.locator('[data-ui="connection-setup-kind"]').selectOption('openai-compatible')
  await page.locator('[data-ui="connection-setup-key"]').fill('sk-openai-header-layout-test')
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  await expect(page.locator('[data-ui="connection-provider-button"]')).toHaveAttribute(
    'data-kind',
    'openai-compatible',
  )
}

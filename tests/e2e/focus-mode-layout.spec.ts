import { expect, type Page, test } from './fixtures'
import { clearIndexedDb, seedFirstRun, seedLinearChat } from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await page.evaluate(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  await page.reload()
})

test('focus mode keeps an open chat settings panel visible', async ({ page }) => {
  await startChat(page)

  const shell = page.locator('[data-ui="app-shell"]')
  await page.locator('[data-role="settings-cog"]').click()
  await expect(shell).toHaveAttribute('data-chat-model-panel', 'open')
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()

  const focusModeToggle = page.locator('[data-ui="focus-mode-toggle"]')
  await focusModeToggle.click()

  await expect(shell).toHaveAttribute('data-focus-mode', 'on')
  await expect(shell).toHaveAttribute('data-chat-model-panel', 'open')
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  await expect(page.locator('[data-ui="sidebar"]')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Exit reading mode' })).toBeVisible()

  await focusModeToggle.click()

  await expect(shell).toHaveAttribute('data-focus-mode', 'off')
  await expect(shell).toHaveAttribute('data-chat-model-panel', 'open')
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
})

test('focus composer keeps auto-growing until the user resizes it', async ({ page }) => {
  await startChat(page)
  await page.locator('[data-ui="focus-mode-toggle"]').click()

  const input = page.locator('[data-ui="composer-input"]')
  await expect(input).toHaveCSS('height', '200px')
  await input.fill(Array.from({ length: 12 }, (_, index) => `focus draft ${index}`).join('\n'))

  const metrics = await input.evaluate((node) => ({
    clientHeight: node.clientHeight,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight,
  }))
  expect(metrics.clientHeight).toBeGreaterThan(200)
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1)
  expect(metrics.overflowY).toBe('hidden')
})

test('notice actions and the floating reading control remain independently clickable', async ({
  page,
}) => {
  await startChat(page)
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]')
  const text = await assistant.locator('[data-ui="message-body"]').innerText()
  const focus = page.locator('[data-ui="focus-mode-toggle"]')
  const shell = page.locator('[data-ui="app-shell"]')
  const deletedToast = page.locator('[data-ui="toast"]:has([data-ui="toast-undo"])')
  const deleteAssistant = async () => {
    await assistant.getByRole('button', { name: 'Delete message', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(deletedToast).toBeVisible()
  }

  await deleteAssistant()
  await deletedToast.locator('[data-ui="toast-undo"]').click()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText(text)

  await deleteAssistant()
  await focus.click()
  await expect(shell).toHaveAttribute('data-focus-mode', 'on')
  await expect(deletedToast).toBeVisible()
  await deletedToast.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(deletedToast).toHaveCount(0)
  await expect(shell).toHaveAttribute('data-focus-mode', 'on')
  await focus.click()
  await expect(shell).toHaveAttribute('data-focus-mode', 'off')
})

async function startChat(page: Page): Promise<void> {
  await seedFirstRun(page)
  const chatId = await seedLinearChat(page, {
    chatId: 'focus-layout-chat',
    messageCount: 2,
    textPrefix: 'focus layout message',
    title: 'Focus mode layout check',
  })
  await page.goto(`/#/chat/${chatId}`)
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible()
}

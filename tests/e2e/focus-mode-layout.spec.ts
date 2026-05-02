import { expect, type Page, test } from '@playwright/test'
import { clearIndexedDb } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await page.evaluate(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  await page.reload()
})

test('focus mode keeps an open chat settings panel visible', async ({ page }) => {
  await startDebugChat(page)

  const shell = page.locator('[data-ui="app-shell"]')
  await page.locator('[data-role="settings-cog"]').click()
  await expect(shell).toHaveAttribute('data-chat-model-panel', 'open')
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()

  await page.getByRole('button', { name: 'Enter reading mode' }).click()

  await expect(shell).toHaveAttribute('data-focus-mode', 'on')
  await expect(shell).toHaveAttribute('data-chat-model-panel', 'open')
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  await expect(page.locator('[data-ui="sidebar"]')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Exit reading mode' })).toBeVisible()

  await page.getByRole('button', { name: 'Exit reading mode' }).click()

  await expect(shell).toHaveAttribute('data-focus-mode', 'off')
  await expect(shell).toHaveAttribute('data-chat-model-panel', 'open')
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
})

async function startDebugChat(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (
      window as unknown as {
        __debugFakeStream?: {
          start(options: {
            targetChars: number
            reasoningChars: number
            prompt: string
            openChat: boolean
          }): Promise<unknown>
        }
      }
    ).__debugFakeStream
    if (!api) throw new Error('__debugFakeStream is not installed')
    await api.start({
      targetChars: 24,
      reasoningChars: 0,
      prompt: 'Focus mode layout check',
      openChat: true,
    })
  })
  await page.locator('[data-ui="message"][data-role="assistant"]').waitFor({ state: 'visible' })
}

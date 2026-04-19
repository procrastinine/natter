import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  seedFirstRun,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
  await createChatAndOpen(page)
})

test('send button is disabled when input is empty', async ({ page }) => {
  await expect(page.locator('[data-ui="send"]')).toBeDisabled()
})

test('send button enables on non-empty input', async ({ page }) => {
  await page.locator('[data-ui="composer-input"]').fill('x')
  await expect(page.locator('[data-ui="send"]')).toBeEnabled()
})

test('Enter submits; Shift+Enter inserts a newline', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'ok' }, { finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.click()
  await input.fill('line one')
  await input.press('Shift+Enter')
  await input.type('line two')
  expect(await input.inputValue()).toBe('line one\nline two')
  await input.press('Enter')
  const user = page.locator('[data-ui="message"][data-role="user"]').first()
  await expect(user).toBeVisible()
  await expect(user.locator('[data-ui="message-body"]')).toContainText('line one')
  await expect(user.locator('[data-ui="message-body"]')).toContainText('line two')
})

test('whitespace-only input keeps Send disabled', async ({ page }) => {
  await page.locator('[data-ui="composer-input"]').fill('   ')
  await expect(page.locator('[data-ui="send"]')).toBeDisabled()
  await expect(page.locator('[data-ui="message"][data-role="user"]')).toHaveCount(0)
})

test('input clears after a successful send', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'ok', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('bye')
  await page.locator('[data-ui="send"]').click()
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible()
  expect(await input.inputValue()).toBe('')
})

test('Send is disabled while a stream owns the active placeholder', async ({ page }) => {
  // Hold the fetch open with a 1.5s delay so the stream is unambiguously
  // active when we probe Send.
  await mockChatCompletions(page, {
    delayMs: 1500,
    body: buildSseBody([{ id: 'g', content: 'slow', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('please wait')
  const send = page.locator('[data-ui="send"]')
  await send.click()
  // Send should flip to disabled within the lifetime of the in-flight stream.
  await expect(send).toBeDisabled()
  // And the abort button surfaces while streaming.
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  // After the stream finishes, Send unlocks (once input has text again).
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible({
    timeout: 5000,
  })
  await input.fill('next')
  await expect(send).toBeEnabled()
})

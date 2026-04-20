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

test('the composer swaps Send for Abort while a stream owns the active placeholder', async ({
  page,
}) => {
  // Hold the fetch open so both "mid-stream" assertions land while the
  // stream is still active. The Composer renders *either* Send *or* Abort
  // (not Send-disabled next to Abort), so the test asserts Send is gone
  // and Abort is there — not Send-disabled. An earlier version of this
  // test expected `Send.toBeDisabled()`, which times out under parallel
  // CPU pressure because Playwright polls a locator that no longer exists
  // in the DOM; the UI and the test had drifted.
  await mockChatCompletions(page, {
    delayMs: 3000,
    body: buildSseBody([{ id: 'g', content: 'slow', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('please wait')
  const send = page.locator('[data-ui="send"]')
  await send.click()
  // Mid-stream: Send is swapped out for Abort.
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await expect(send).toHaveCount(0)
  // After the stream finishes, Send comes back and is enabled with new input.
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible({
    timeout: 10_000,
  })
  await input.fill('next')
  await expect(send).toBeEnabled()
})

test('the composer stays editable while streaming but Enter does not send a second turn', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    delayMs: 2000,
    body: buildSseBody([{ id: 'g', content: 'slow', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('first turn')
  await page.locator('[data-ui="send"]').click()
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()

  await input.fill('draft during stream')
  await expect(input).toHaveValue('draft during stream')
  await input.press('Enter')
  await expect(input).toHaveValue('draft during stream')
  await expect(page.locator('[data-ui="message"][data-role="user"]')).toHaveCount(1)

  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible({
    timeout: 10_000,
  })
})

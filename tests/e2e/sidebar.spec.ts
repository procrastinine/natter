import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  createChatAndSend,
  mockChatCompletions,
  seedFirstRun,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'ok', finish: 'stop' }]),
  })
})

test('clicking new-chat navigates to a blank composer without creating a chat row', async ({ page }) => {
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(0)
  await createChatAndOpen(page)
  // Composer is ready, but no chat row yet — rows materialize on first send.
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(0)
})

test('chat rows materialize only on first send (no spam from repeated new-chat clicks)', async ({ page }) => {
  // Three #/new visits with NO send → still zero rows.
  await createChatAndOpen(page)
  await createChatAndOpen(page)
  await createChatAndOpen(page)
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(0)
  // Three send-on-new-chat flows → exactly three rows.
  await createChatAndSend(page, 'one')
  await createChatAndSend(page, 'two')
  await createChatAndSend(page, 'three')
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
})

test('clicking a chat row navigates to it and swaps the main pane', async ({ page }) => {
  await createChatAndSend(page, 'first')
  await createChatAndSend(page, 'second')
  // The newest chat (second) is currently active. Click the older (first) row.
  const rows = page.locator('[data-ui="chat-row-link"]')
  // Wait until both rows are present in the sidebar (newest is on top).
  await expect(rows).toHaveCount(2)
  await rows.nth(1).click()
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
})

test('clicking the brand returns to home (no chat selected)', async ({ page }) => {
  await createChatAndSend(page, 'first')
  await page.locator('[data-ui="brand"]').click()
  // Home shows the launcher (sample prompts) and no chat is active.
  await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(0)
})

test('reload preserves the active chat (URL is the source of truth)', async ({ page }) => {
  await createChatAndSend(page, 'persisted')
  const hashBefore = await page.evaluate(() => window.location.hash)
  expect(hashBefore).toMatch(/^#\/chat\//)
  await page.reload()
  // Same hash, same row marked active.
  const hashAfter = await page.evaluate(() => window.location.hash)
  expect(hashAfter).toBe(hashBefore)
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
})

test('chat-row anchor exposes a real href so middle/Cmd-click can open it in a new tab', async ({ page }) => {
  await createChatAndSend(page, 'inspect href')
  const link = page.locator('[data-ui="chat-row-link"]').first()
  const href = await link.getAttribute('href')
  expect(href).toMatch(/^#\/chat\/[A-Z0-9]{20,}$/i)
})

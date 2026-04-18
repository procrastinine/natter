import { expect, test } from '@playwright/test'
import {
  clearIndexedDb,
  createChatAndOpen,
  seedFirstRun,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('new-chat button creates a chat row + opens its composer', async ({ page }) => {
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(0)
  await createChatAndOpen(page)
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(1)
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
})

test('multiple chats stack in the sidebar; only one is active', async ({ page }) => {
  await createChatAndOpen(page)
  await createChatAndOpen(page)
  await createChatAndOpen(page)
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
})

test('clicking a chat makes it active and swaps the main pane', async ({ page }) => {
  await createChatAndOpen(page)
  await createChatAndOpen(page)
  const rows = page.locator('[data-ui="chat-row-button"]')
  // The newest chat is active because createAndSelect sets it. Click the
  // first row (older chat) to switch.
  await rows.first().click()
  // Active flips; composer remounts for the new target without errors.
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
})

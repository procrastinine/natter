import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  createChatAndSend,
  firstChatId,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

// Inline chat-title editor (plan/10-ui.md §10.3). Pencil opens edit, Enter
// commits via chat-meta: scope, Escape cancels, empty-after-trim is blocked.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
  // Default mock so createChatAndSend has a quick reply to land on.
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'ok', finish: 'stop' }]),
  })
})

test('pencil opens the inline editor; Enter commits and sets titleStatus=manual', async ({
  page,
}) => {
  await createChatAndSend(page, 'establish a chat')
  await page.locator('[data-role="chat-title-edit"]').click()
  const editor = page.locator('[data-ui="chat-title-editor"]')
  await expect(editor).toBeFocused()
  await editor.fill('Branching deep-dive')
  await editor.press('Enter')
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Branching deep-dive')
  const chatId = await firstChatId(page)
  const row = await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly')
        const req = tx.objectStore('chats').get(id)
        req.onsuccess = () => resolve(req.result as Record<string, unknown>)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }, chatId)
  expect(row.title).toBe('Branching deep-dive')
  expect(row.titleStatus).toBe('manual')
})

test('Escape cancels without persisting changes', async ({ page }) => {
  await createChatAndSend(page, 'seed')
  await page.locator('[data-role="chat-title-edit"]').click()
  const editor = page.locator('[data-ui="chat-title-editor"]')
  await editor.fill('should not save')
  await editor.press('Escape')
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Untitled chat')
})

test('empty-after-trim is treated as a silent cancel (no error, editor closes)', async ({
  page,
}) => {
  await createChatAndSend(page, 'seed')
  await page.locator('[data-role="chat-title-edit"]').click()
  const editor = page.locator('[data-ui="chat-title-editor"]')
  await editor.fill('   ')
  await editor.press('Enter')
  // Editor closes silently, no error banner.
  await expect(editor).toHaveCount(0)
  await expect(page.locator('[data-ui="chat-title-error"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Untitled chat')
})

test('committing an unchanged title is a silent no-op (no error banner)', async ({ page }) => {
  await createChatAndSend(page, 'seed')
  // First, set a known title.
  await page.locator('[data-role="chat-title-edit"]').click()
  await page.locator('[data-ui="chat-title-editor"]').fill('Stable title')
  await page.locator('[data-ui="chat-title-editor"]').press('Enter')
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Stable title')
  // Re-open and commit identical text — no error banner should appear.
  await page.locator('[data-role="chat-title-edit"]').click()
  await page.locator('[data-ui="chat-title-editor"]').press('Enter')
  await expect(page.locator('[data-ui="chat-title-error"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Stable title')
})

test('navigating to a different chat cancels any in-progress title edit', async ({ page }) => {
  await createChatAndSend(page, 'first chat')
  await createChatAndSend(page, 'second chat')
  // Open the editor on the active (second) chat.
  await page.locator('[data-role="chat-title-edit"]').click()
  await page.locator('[data-ui="chat-title-editor"]').fill('half-typed title')
  // Click the OTHER chat row in the sidebar.
  const links = page.locator('[data-ui="chat-row-link"]')
  await expect(links).toHaveCount(2)
  await links.nth(1).click()
  // Editor is gone; the now-active chat's title shows unchanged.
  await expect(page.locator('[data-ui="chat-title-editor"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="chat-title-error"]')).toHaveCount(0)
})

test('F2 on the title label enters edit mode (keyboard-only)', async ({ page }) => {
  await createChatAndSend(page, 'seed')
  await page.locator('[data-ui="chat-title-label"]').focus()
  await page.keyboard.press('F2')
  await expect(page.locator('[data-ui="chat-title-editor"]')).toBeFocused()
})

test('title commit bumps updatedAt + metaVersion, leaves branch state untouched, and broadcasts', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'gen-1', content: 'hello', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'establish a branch')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toBeVisible()
  const chatId = await firstChatId(page)
  const before = await readChat(page, chatId)

  await page.locator('[data-role="chat-title-edit"]').click()
  const editor = page.locator('[data-ui="chat-title-editor"]')
  await editor.fill('After send')
  await editor.press('Enter')
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('After send')

  const after = await readChat(page, chatId)
  expect(after.title).toBe('After send')
  expect(after.titleStatus).toBe('manual')
  expect(Number(after.updatedAt)).toBeGreaterThan(Number(before.updatedAt))
  expect(Number(after.metaVersion)).toBeGreaterThanOrEqual(Number(before.metaVersion) + 1)
  // Title edits do NOT move the branch leaf.
  expect(after.lastUpdatedLeafId).toBe(before.lastUpdatedLeafId)
  expect(Number(after.lastBranchUpdatedAt)).toBe(Number(before.lastBranchUpdatedAt))
})

async function readChat(
  page: import('@playwright/test').Page,
  chatId: string,
): Promise<Record<string, unknown>> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly')
        const req = tx.objectStore('chats').get(id)
        req.onsuccess = () => resolve(req.result as Record<string, unknown>)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }, chatId)
}

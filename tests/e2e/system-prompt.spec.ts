import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

// System prompt editing (plan/14-details.md §14.35.5). Edits take effect on
// NEXT send; the current in-flight request isn't rewritten. Bumps updatedAt +
// metaVersion but leaves branch state untouched; exactly one chat-mutated
// broadcast on commit.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('edited system prompt shows up in the NEXT /chat/completions body', async ({ page }) => {
  // Track the wire body of every /chat/completions call.
  const bodies: string[] = []
  await page.route('**/api/v1/chat/completions', async (route, request) => {
    bodies.push(request.postData() ?? '')
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `gen-${bodies.length}`, content: `reply-${bodies.length}`, finish: 'stop' },
      ]),
    })
  })

  await createChatAndOpen(page)
  await sendMessage(page, 'first')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toBeVisible()

  await page.locator('[data-role="settings-cog"]').click()
  // System prompt lives on the Generation tab now; panel opens to Model
  // by default so we have to flip the tab before the textarea mounts.
  await page.locator('[data-ui="settings-tab"][data-tab="generation"]').click()
  const textarea = page.locator('[data-ui="system-prompt-textarea"]')
  await textarea.fill('You are a terse copy editor.')
  // System prompt save is debounced; send the next message after the debounce.
  await page.waitForTimeout(500)
  await page.locator('[data-role="settings-pane-close"]').click()
  await sendMessage(page, 'second')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').nth(1)).toBeVisible()

  expect(bodies.length).toBeGreaterThanOrEqual(2)
  const firstBody = JSON.parse(bodies[0] ?? '{}')
  const secondBody = JSON.parse(bodies[1] ?? '{}')

  // First send had no system prompt.
  const firstSystem = (firstBody.messages ?? []).find((m: { role: string }) => m.role === 'system')
  expect(firstSystem).toBeUndefined()

  // Second send carries the edited system prompt.
  const secondSystem = (secondBody.messages ?? []).find(
    (m: { role: string }) => m.role === 'system',
  )
  expect(secondSystem?.content ?? '').toContain('You are a terse copy editor.')
})

test('committing a system prompt bumps updatedAt + metaVersion and leaves branch state untouched', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'gen-1', content: 'ok', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'warm up')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toBeVisible()
  const chatId = await firstChatId(page)
  const before = await readChat(page, chatId)
  await page.locator('[data-role="settings-cog"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="generation"]').click()
  await page.locator('[data-ui="system-prompt-textarea"]').fill('System edit v1')
  await page.waitForTimeout(500)
  const after = await readChat(page, chatId)
  expect(Number(after.metaVersion)).toBeGreaterThanOrEqual(Number(before.metaVersion) + 1)
  expect(Number(after.updatedAt)).toBeGreaterThan(Number(before.updatedAt))
  // Branch state unchanged.
  expect(after.lastUpdatedLeafId).toBe(before.lastUpdatedLeafId)
  expect(Number(after.lastBranchUpdatedAt)).toBe(Number(before.lastBranchUpdatedAt))
  const settings = after.settings as Record<string, unknown>
  expect(settings.systemPrompt).toBe('System edit v1')
})

test('the one-off toast appears after the first edit and disappears on subsequent edits', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'gen-1', content: 'ok', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'initial')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toBeVisible()
  await page.locator('[data-role="settings-cog"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="generation"]').click()
  await page.locator('[data-ui="system-prompt-textarea"]').fill('First system prompt')
  await expect(page.locator('[data-ui="settings-toast"]')).toBeVisible({
    timeout: 2000,
  })
  await expect(page.locator('[data-ui="settings-toast"]')).toContainText(
    /takes effect on your next send/i,
  )
  // Second edit in the same session shouldn't re-show the toast.
  await page.locator('[data-ui="system-prompt-textarea"]').fill('First system prompt — appended')
  await page.waitForTimeout(500)
  await expect(page.locator('[data-ui="settings-toast"]')).toBeHidden({
    timeout: 5000,
  })
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

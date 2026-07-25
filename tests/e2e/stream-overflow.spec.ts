import { importPortableChatThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { expect, test } from './fixtures'
import { clearIndexedDb, seedFirstRun } from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('oversized stream lane auto-compacts and the avatar cycles compact -> peek -> full', async ({
  page,
}) => {
  const huge = 'abcdefghij'.repeat(2500)
  const chatId = 'oversize-chat'
  const now = Date.now()
  const userId = 'oversize-user'
  const assistantId = 'oversize-assistant'
  const sourceMessages = [
    {
      id: userId,
      chatId,
      parentId: null,
      siblingIndex: 0,
      turnId: 'oversize-turn-user',
      turnIndex: 0,
      createdAt: now,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'flood me' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: assistantId,
      chatId,
      parentId: userId,
      siblingIndex: 0,
      turnId: 'oversize-turn-assistant',
      turnIndex: 0,
      createdAt: now + 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: huge }],
      nodeVersion: 0,
      deleted: false,
    },
  ]
  const imported = await importPortableChatThroughUi(page, {
    sourceChatId: chatId,
    title: 'Overflow test',
    createdAt: now,
    messages: sourceMessages,
    workspaceSettings: { 'global:long-message-display-mode': 'compact' },
  })
  await page.goto(`/?overflow=${Date.now()}#/chat/${imported.chatId}`)
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  const avatar = assistant.locator('[data-ui="profile-glyph-button"]').first()
  await expect(assistant).toBeVisible()
  await expect(assistant).toHaveAttribute('data-collapse-mode', 'compact')
  await expect(page.locator('[data-ui="stream-overflow"]')).toHaveCount(0)
  await avatar.click()
  await expect(assistant).toHaveAttribute('data-collapse-mode', 'peek')
  await avatar.click()
  await expect(assistant).toHaveAttribute('data-collapse-mode', 'full')
})

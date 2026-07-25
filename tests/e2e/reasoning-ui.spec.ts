import { importPortableChatThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { expect, test } from './fixtures'
import { clearIndexedDb, seedFirstRun } from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('canonicalized Claude reasoning renders once in the UI and shows reasoning time in message info', async ({
  page,
}) => {
  const chatId = 'reasoning-chat'
  const now = Date.now()
  const userId = 'reasoning-user'
  const assistantId = 'reasoning-assistant'
  const sourceMessages = [
    {
      id: userId,
      chatId,
      parentId: null,
      siblingIndex: 0,
      turnId: 'reasoning-turn-user',
      turnIndex: 0,
      createdAt: now,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'prove it' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: assistantId,
      chatId,
      parentId: userId,
      siblingIndex: 0,
      turnId: 'reasoning-turn-assistant',
      turnIndex: 0,
      createdAt: now + 1,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'The ratio is Cauchy.' }],
      reasoningDetails: [{ type: 'reasoning.text', index: 0, text: 'Let me' }],
      nodeVersion: 0,
      deleted: false,
      generation: {
        id: 'gen-reasoning',
        model: 'anthropic/claude-sonnet-4.6',
        requestedModel: 'anthropic/claude-sonnet-4.6',
        apiUsed: 'chat',
        delivery: 'streaming',
        costSource: 'stream',
        startedAt: now,
        reasoningStartedAt: now + 100,
        firstTextAt: now + 1200,
        finishedAt: now + 1600,
      },
    },
  ]
  const imported = await importPortableChatThroughUi(page, {
    sourceChatId: chatId,
    title: 'Reasoning test',
    createdAt: now,
    messages: sourceMessages,
  })
  await page.goto(`/#/chat/${imported.chatId}`)

  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await assistant.locator('[data-ui="reasoning-summary"]').click()
  await expect(
    assistant.locator(
      '[data-ui="reasoning-section"][data-reasoning-kind="text"] [data-ui="reasoning-row-body"]',
    ),
  ).toHaveText('Let me')
  await assistant.locator('[data-role="message-action"][data-action="info"]').click()
  await expect(assistant.locator('[data-ui="message-info"]')).toContainText('Reasoning time')
  await expect(assistant.locator('[data-ui="message-info"]')).toContainText('1.10 s before answer')
})

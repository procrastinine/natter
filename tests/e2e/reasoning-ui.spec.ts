import { importPortableChatThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { expect, test } from './fixtures'
import { clearIndexedDb, readMessages, seedFirstRun } from './helpers'

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
      reasoningDetails: [
        { type: 'reasoning.text', index: 0, text: 'Let me' },
        { type: 'reasoning.encrypted', index: 1, data: 'opaque-reasoning' },
      ],
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'web_search_call',
          outputIndex: 0,
          item: {
            id: 'reasoning-provider-output',
            query: 'before',
            encrypted_content: 'sealed-provider-field',
          },
        },
        {
          dialect: 'unknown',
          type: 'obsolete_tool_result',
          outputIndex: 1,
          item: { obsolete: true },
        },
      ],
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
  await assistant.getByRole('button', { name: 'Edit reasoning details' }).click()
  const reasoningEditor = assistant.getByRole('textbox', { name: 'Edit reasoning details' })
  await reasoningEditor.fill('Let me verify the ratio')
  await assistant.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(reasoningEditor).toBeHidden()
  await expect(
    assistant.locator(
      '[data-ui="reasoning-section"][data-reasoning-kind="text"] [data-ui="reasoning-row-body"]',
    ),
  ).toHaveText('Let me verify the ratio')

  await page.reload()
  await assistant.locator('[data-ui="reasoning-summary"]').click()
  await expect(
    assistant.locator(
      '[data-ui="reasoning-section"][data-reasoning-kind="text"] [data-ui="reasoning-row-body"]',
    ),
  ).toHaveText('Let me verify the ratio')

  await assistant.locator('[data-role="message-action"][data-action="edit"]').click()
  const authoring = assistant.locator('[data-ui="inline-editor-reasoning"]')
  await authoring.locator('summary').click()
  await authoring
    .getByRole('combobox', { name: 'Reasoning block type', exact: true })
    .selectOption('summary')
  await authoring.getByRole('textbox', { name: 'Edit summary reasoning' }).fill('Ratio summary')
  await authoring
    .getByRole('button', { name: /Delete (?:opaque|encrypted|redacted) reasoning block/ })
    .click()
  await authoring.getByRole('button', { name: 'Add reasoning block' }).click()
  await authoring
    .getByRole('textbox', { name: 'Edit plaintext reasoning' })
    .fill('User-authored detail')
  await authoring.locator('summary').click()
  const toolAuthoring = assistant.locator('[data-ui="inline-editor-tool-calls"]')
  await toolAuthoring.locator('summary').click()
  await toolAuthoring
    .getByRole('textbox', { name: 'Edit tool call JSON or text' })
    .first()
    .fill('{"id":"reasoning-provider-output","query":"after"}')
  const region = page.locator('[data-ui="scroll-region"]')
  await page.locator('[data-ui="jump-to-latest"]').click()
  await expect
    .poll(() => region.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight))
    .toBeLessThanOrEqual(4)
  await toolAuthoring.getByRole('button', { name: 'Delete tool call' }).nth(1).click()
  await toolAuthoring.getByRole('button', { name: 'Add tool call' }).click()
  await toolAuthoring
    .getByRole('textbox', { name: 'Edit tool call JSON or text' })
    .nth(1)
    .fill('{"authored":true}')
  await toolAuthoring.locator('summary').click()
  await assistant.locator('[data-ui="attachment-hidden-input"]').setInputFiles({
    name: 'assistant-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('assistant-authored attachment'),
  })
  await expect(assistant.getByText('assistant-evidence.txt')).toBeVisible()
  await assistant.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(authoring).toBeHidden()

  await page.reload()
  await assistant.locator('[data-ui="reasoning-summary"]').click()
  await expect(
    assistant.locator(
      '[data-ui="reasoning-section"][data-reasoning-kind="summary"] [data-ui="reasoning-row-body"]',
    ),
  ).toHaveText('Ratio summary')
  await expect(
    assistant.locator(
      '[data-ui="reasoning-section"][data-reasoning-kind="text"] [data-ui="reasoning-row-body"]',
    ),
  ).toHaveText('User-authored detail')
  await expect(
    assistant.locator('[data-ui="reasoning-section"][data-reasoning-kind="encrypted"]'),
  ).toHaveCount(0)
  const stored = (await readMessages(page, imported.chatId)).find(
    (message) => message.role === 'assistant',
  )
  expect(stored?.providerOutputItems).toEqual([
    {
      dialect: 'openai-responses',
      type: 'web_search_call',
      outputIndex: 0,
      edited: true,
      item: {
        id: 'reasoning-provider-output',
        query: 'after',
        encrypted_content: 'sealed-provider-field',
      },
    },
    {
      dialect: 'unknown',
      type: 'manual_tool_call',
      outputIndex: 1,
      edited: true,
      item: { authored: true },
    },
  ])
  expect(stored?.attachmentRefs).toHaveLength(1)
  await assistant.locator('[data-role="message-action"][data-action="info"]').click()
  await expect(assistant.locator('[data-ui="message-info"]')).toContainText('Reasoning time')
  await expect(assistant.locator('[data-ui="message-info"]')).toContainText('1.10 s before answer')
})

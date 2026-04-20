import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

// Phase-8 polish (CLAUDE.md "Main content must be quiet"): the message
// header is now a quiet single-line `Role` label only. Model, timestamp,
// token breakdown, cost, and other factual-record metadata moved into the
// `[data-ui="message-info"]` disclosure that opens via the ⓘ Info button on
// the always-visible action row beneath the message body.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('assistant header shows the role label only; model + tokens + cost live in the ⓘ disclosure', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      {
        id: 'gen-hdr',
        model: 'google/gemini-3.1-flash-lite-preview',
        content: 'hello world',
        usage: {
          prompt_tokens: 12,
          completion_tokens: 42,
          total_tokens: 54,
          cost: 0.00015,
        },
        finish: 'stop',
      },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-role"]')).toHaveText('Assistant')
  // The factual chips are NOT in the header anymore.
  await expect(assistant.locator('[data-ui="message-model"]')).toHaveCount(0)
  await expect(assistant.locator('[data-ui="message-token-count"]')).toHaveCount(0)
  await expect(assistant.locator('[data-ui="message-cost"]')).toHaveCount(0)
  // The header aria-label is just the role.
  await expect(assistant.locator('[data-ui="message-header"]')).toHaveAttribute(
    'aria-label',
    'Assistant',
  )
  // Reveal the info disclosure and verify the full factual record is there.
  await assistant.locator('[data-role="message-action"][data-action="info"]').click()
  const info = assistant.locator('[data-ui="message-info"]')
  await expect(info).toContainText('google/gemini-3.1-flash-lite-preview')
  await expect(info).toContainText('Prompt tokens')
  await expect(info).toContainText('Completion tokens')
  await expect(info).toContainText('42')
  await expect(info).toContainText('Cost')
  // Cost is rendered with 6 decimals and the dollar sign baked in.
  await expect(info).toContainText('$0.000150')
})

test('user messages still get the role label, no model/tokens/cost anywhere', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'gen-u', content: 'hi', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'user message')
  const user = page.locator('[data-ui="message"][data-role="user"]').first()
  await expect(user.locator('[data-ui="message-role"]')).toHaveText('User')
  await expect(user.locator('[data-ui="message-model"]')).toHaveCount(0)
  await expect(user.locator('[data-ui="message-token-count"]')).toHaveCount(0)
  await expect(user.locator('[data-ui="message-cost"]')).toHaveCount(0)
  // Open info — user message still shows the timestamp via the disclosure
  // (no model/tokens/cost, since those are generation-side fields).
  await user.locator('[data-role="message-action"][data-action="info"]').click()
  const info = user.locator('[data-ui="message-info"]')
  await expect(info).toContainText('Created')
  await expect(info).not.toContainText('Model')
  await expect(info).not.toContainText('Cost')
})

import { expect, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  seedFirstRun,
  sendMessage,
} from './helpers'

// Phase 7 required spec: multi-turn. Sending two turns on one chat yields a
// second `/chat/completions` request whose `messages[]` body contains the
// first user + assistant turn verbatim. Asserts the echo reflects prior
// context.

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('second turn inlines the first user + assistant messages', async ({ page }) => {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  let turn = 0
  await page.route('**/api/v1/chat/completions', async (route, req) => {
    turn += 1
    bodies.push(JSON.parse(req.postData() ?? '{}'))
    const reply = turn === 1 ? 'AURORA' : 'BOREALIS'
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `g-${turn}`, content: reply },
        { finish: 'stop', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'first')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('AURORA')
  await sendMessage(page, 'second')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .nth(1)
      .locator('[data-ui="message-body"]'),
  ).toHaveText('BOREALIS')

  expect(bodies).toHaveLength(2)
  const second = bodies[1] as { messages: Array<{ role: string; content: string }> }
  const roles = second.messages.map((m) => m.role)
  expect(roles).toEqual(['user', 'assistant', 'user'])
  expect(second.messages[0]?.content).toBe('first')
  expect(second.messages[1]?.content).toBe('AURORA')
  expect(second.messages[2]?.content).toBe('second')
})

test('three-turn conversation carries the full history', async ({ page }) => {
  const bodies: Array<{ messages: Array<{ role: string; content: string }> }> = []
  let turn = 0
  await page.route('**/api/v1/chat/completions', async (route, req) => {
    turn += 1
    bodies.push(JSON.parse(req.postData() ?? '{}'))
    const reply = ['one', 'two', 'three'][turn - 1] ?? 'done'
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([{ id: `g-${turn}`, content: reply }, { finish: 'stop' }]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'q1')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .nth(0)
      .locator('[data-ui="message-body"]'),
  ).toHaveText('one')
  await sendMessage(page, 'q2')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .nth(1)
      .locator('[data-ui="message-body"]'),
  ).toHaveText('two')
  await sendMessage(page, 'q3')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .nth(2)
      .locator('[data-ui="message-body"]'),
  ).toHaveText('three')
  const third = bodies[2] as { messages: Array<{ role: string; content: string }> }
  expect(third.messages.map((m) => m.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
    'user',
  ])
})

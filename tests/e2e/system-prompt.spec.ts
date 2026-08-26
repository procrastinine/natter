import { expect, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  readChatRow,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

// System prompt edits take effect on the next send; the current in-flight
// request isn't rewritten. A commit bumps updatedAt +
// metaVersion but leaves branch state untouched; exactly one chat-mutated
// broadcast on commit.

test.beforeEach(async ({ page }) => {
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
  await page.locator('[data-ui="settings-tab"][data-tab="prompts"]').click()
  const textarea = page.locator('[data-ui="system-prompt-textarea"]')
  await textarea.fill('You are a terse copy editor.')
  await page.locator('[data-role="settings-pane-close"]').click()
  await sendMessage(page, 'second')
  await expect.poll(() => bodies.length, { timeout: 5000 }).toBeGreaterThanOrEqual(2)
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').nth(1)).toContainText(
    'reply-2',
  )

  expect(bodies.length).toBeGreaterThanOrEqual(2)
  const firstBody = parseCapturedChatBody(bodies[0])
  const secondBody = parseCapturedChatBody(bodies[1])

  // First send had no system prompt.
  const firstSystem = firstBody.messages.find((m) => m.role === 'system')
  expect(firstSystem).toBeUndefined()

  // Second send carries the edited system prompt.
  const secondSystem = secondBody.messages.find((m) => m.role === 'system')
  expect(secondSystem?.content ?? '').toContain('You are a terse copy editor.')
})

function parseCapturedChatBody(raw: string | undefined): {
  messages: Array<{ role: string; content?: unknown }>
} {
  const parsed: unknown = JSON.parse(raw ?? '{}')
  if (!parsed || typeof parsed !== 'object') return { messages: [] }
  const messages = (parsed as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return { messages: [] }
  return {
    messages: messages.filter(
      (message): message is { role: string; content?: unknown } =>
        !!message &&
        typeof message === 'object' &&
        typeof (message as { role?: unknown }).role === 'string',
    ),
  }
}

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
  await waitForAssistantGenerationFinished(page, chatId)
  const before = await readChat(page, chatId)
  await page.locator('[data-role="settings-cog"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="prompts"]').click()
  await page.locator('[data-ui="system-prompt-textarea"]').fill('System edit v1')
  await expectChatSetting(page, chatId, 'systemPrompt', 'System edit v1')
  const after = await readChat(page, chatId)
  expect(Number(after.metaVersion)).toBeGreaterThanOrEqual(Number(before.metaVersion) + 1)
  expect(Number(after.updatedAt)).toBeGreaterThan(Number(before.updatedAt))
  // Branch state unchanged.
  expect(after.lastUpdatedLeafId).toBe(before.lastUpdatedLeafId)
  expect(Number(after.lastBranchUpdatedAt)).toBe(Number(before.lastBranchUpdatedAt))
  const settings = after.settings as Record<string, unknown>
  expect(settings.systemPrompt).toBe('System edit v1')
})

test('debounced system-prompt saves never interrupt the active editor with a notice', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'gen-1', content: 'ok', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'initial')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toBeVisible()
  await page.locator('[data-role="settings-cog"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="prompts"]').click()
  const textarea = page.locator('[data-ui="system-prompt-textarea"]')
  await textarea.fill('First system prompt')
  const chatId = await firstChatId(page)
  await expectChatSetting(page, chatId, 'systemPrompt', 'First system prompt')
  await expect(textarea).toBeFocused()
  await expect(page.locator('[data-ui="settings-toast"]')).toHaveCount(0)
  await textarea.pressSequentially(' — appended')
  await expectChatSetting(page, chatId, 'systemPrompt', 'First system prompt — appended')
  await expect(textarea).toBeFocused()
  await expect(page.locator('[data-ui="settings-toast"]')).toHaveCount(0)
})

test('model discovery cannot move settings tabs under an in-progress gesture', async ({ page }) => {
  let releaseCatalog: () => void = () => undefined
  const catalogGate = new Promise<void>((resolve) => {
    releaseCatalog = resolve
  })
  await page.route('https://openrouter.ai/api/v1/models*', async (route) => {
    await catalogGate
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        data: [
          {
            id: 'anthropic/claude-opus-4.8',
            name: 'Claude Opus 4.8',
            supported_parameters: ['tools'],
          },
        ],
      }),
    })
  })
  try {
    await mockChatCompletions(page, {
      body: buildSseBody([{ id: 'gen-1', content: 'ok', finish: 'stop' }]),
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'initial')
    await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible()
    await page.locator('[data-role="settings-cog"]').click()
    const promptsTab = page.locator('[data-ui="settings-tab"][data-tab="prompts"]')
    const before = await promptsTab.boundingBox()
    if (!before) throw new Error('SettingsPromptsTabMissingBeforeCatalog')

    releaseCatalog()
    await expect(page.locator('[data-ui="notice-banner"]')).toBeVisible()
    const after = await promptsTab.boundingBox()
    if (!after) throw new Error('SettingsPromptsTabMissingAfterCatalog')
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)

    await promptsTab.click()
    await expect(page.locator('[data-ui="settings-panel"]')).toHaveAttribute(
      'data-active-tab',
      'prompts',
    )
    await expect(page.locator('[data-ui="system-prompt-textarea"]')).toBeVisible()
  } finally {
    releaseCatalog()
  }
})

async function expectChatSetting(page: Page, chatId: string, key: string, value: unknown) {
  await expect
    .poll(async () => {
      const chat = await readChat(page, chatId)
      return (chat.settings as Record<string, unknown>)[key]
    })
    .toBe(value)
}

async function readChat(page: Page, chatId: string): Promise<Record<string, unknown>> {
  return readChatRow(page, chatId)
}

import { expect, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  readMessages,
  seedFirstRun,
  sendMessage,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('happy path: streamed SSE renders and persists the final row', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'gen-1', model: 'google/gemini-3.1-flash-lite-preview', content: 'Hello' },
      { content: ' world' },
      {
        finish: 'stop',
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          cost: 0.00001,
        },
      },
    ]),
    headers: { 'x-generation-id': 'gen-1' },
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'say hi')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('Hello world')

  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const assistantRow = rows.find((r) => r.role === 'assistant') as {
    content: Array<{ type: string; text: string }>
    generation: { id: string; cost: number; finishReason: string; usage: { total_tokens: number } }
  }
  expect(assistantRow.content).toEqual([{ type: 'output_text', text: 'Hello world' }])
  expect(assistantRow.generation.id).toBe('gen-1')
  expect(assistantRow.generation.finishReason).toBe('stop')
  expect(assistantRow.generation.usage.total_tokens).toBe(5)
  expect(assistantRow.generation.cost).toBeCloseTo(0.00001)
})

test('delayed stream start keeps the sent turn visible before first bytes arrive', async ({
  page,
}) => {
  let releaseResponse!: () => void
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  let markRequestSeen!: () => void
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markRequestSeen()
    await responseGate
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([{ id: 'gen-delay', content: 'finally started', finish: 'stop' }]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'slow network')
  await requestSeen

  const user = page.locator('[data-ui="message"][data-role="user"]').first()
  await expect(user.locator('[data-ui="message-body"]')).toHaveText('slow network')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toBeVisible()

  const chatId = await firstChatId(page)
  const midRows = await readMessages(page, chatId)
  expect(midRows.map((row) => row.role)).toEqual(['user', 'assistant'])

  releaseResponse()
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('finally started')
})

test('buffered JSON fallback renders the same final content as streaming', async ({ page }) => {
  await mockChatCompletions(page, {
    json: {
      id: 'gen-buf',
      choices: [{ finish_reason: 'stop', message: { content: 'buffered!' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'any')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('buffered!')
})

test('mid-stream error frame surfaces ApiError and preserves partial text', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'gen-mid', content: 'half ' },
      { content: 'an answer' },
      { error: { code: 429, message: 'rate limited' } },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'please')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('half an answer')
  const err = assistant.locator('[data-ui="message-error"][data-role="error"]')
  await expect(err).toBeVisible()
  await expect(err).toContainText(/429/)
  await expect(err).toContainText(/rate limited/)
})

test.describe('HTTP error response diagnostics', () => {
  test.use({
    runtimeDiagnosticAllowances: [
      {
        category: 'console-other',
        message:
          '^Failed to load resource: the server responded with a status of (?:401 \\(Unauthorized\\)|402 \\(Payment Required\\)|503 \\(Service Unavailable\\))$',
      },
    ],
  })

  test('HTTP 401 shows the unauthorized classifier string', async ({ page }) => {
    await mockChatCompletions(page, {
      status: 401,
      json: { error: { code: 401, message: 'Invalid credentials' } },
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'hi')
    const err = page.locator('[data-ui="message-error"][data-role="error"]').first()
    await expect(err).toBeVisible()
    await expect(err).toContainText(/Invalid credentials/)
  })

  test('HTTP 402 payment_required surfaces as error row', async ({ page }) => {
    await mockChatCompletions(page, {
      status: 402,
      json: { error: { code: 402, message: 'insufficient credit' } },
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'hi')
    const err = page.locator('[data-ui="message-error"][data-role="error"]').first()
    await expect(err).toBeVisible()
    await expect(err).toContainText(/insufficient credit/)
  })

  test('HTTP 503 no_provider_available surfaces as error row', async ({ page }) => {
    await mockChatCompletions(page, {
      status: 503,
      json: { error: { code: 503, message: 'no provider free' } },
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'hi')
    const err = page.locator('[data-ui="message-error"][data-role="error"]').first()
    await expect(err).toBeVisible()
    await expect(err).toContainText(/no provider free/)
  })
})

test('network drop mid-stream persists partial text + abortReason=network + Continue affordance', async ({
  page,
}) => {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('Network connection dropped'))
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    }
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'drop this')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  const banner = assistant.locator('[data-ui="message-error"][data-role="abort"]')
  await expect(banner).toBeVisible()
  await expect(banner).toHaveAttribute('data-reason', 'network')
  await expect(banner.locator('[data-ui="message-continue"]')).toBeVisible()

  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const assistantRow = rows.find((r) => r.role === 'assistant') as {
    content: Array<{ type: string; text: string }>
    generation: { abortReason?: string; finishedAt?: number }
  }
  expect(assistantRow.generation.abortReason).toBe('network')
  expect(typeof assistantRow.generation.finishedAt).toBe('number')
})

test.describe('malformed stream diagnostics', () => {
  test.use({
    runtimeDiagnosticAllowances: [
      {
        category: 'console-other',
        message:
          '^chatCompletions: malformed SSE chunk skipped (?:JSHandle@object|\\{eventType: message, characterCount: 10, fingerprint: fnv1a32:d7b44597, error: Object\\})$',
      },
    ],
  })

  test('malformed SSE JSON is skipped; surrounding stream commits cleanly', async ({ page }) => {
    const body = [
      'data: {"id":"g1","choices":[{"delta":{"content":"A"}}]}',
      '',
      'data: {malformed',
      '',
      'data: {"id":"g1","choices":[{"delta":{"content":"B"}}]}',
      '',
      'data: {"id":"g1","choices":[{"delta":{},"finish_reason":"stop"}]}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n')
    await mockChatCompletions(page, { body })
    await createChatAndOpen(page)
    await sendMessage(page, 'x')
    const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
    await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('AB')
  })
})

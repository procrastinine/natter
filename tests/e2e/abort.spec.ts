import { expect, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  readMessages,
  seedFirstRun,
  sendMessage,
} from './helpers'

// Clicking the abort button mid-stream persists the placeholder with
// `generation.abortReason === 'user'` and surfaces the "Stream interrupted"
// row. Aborting BEFORE any chunk arrives still persists the placeholder.

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('clicking abort mid-stream persists abortReason="user" and shows the interrupted row', async ({
  page,
}) => {
  const firstFrame = buildSseBody([{ id: 'abort-mid', content: 'before-abort' }], {
    noDone: true,
  })
  await page.evaluate((frame) => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init)
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(frame))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
  }, firstFrame)
  await createChatAndOpen(page)
  await sendMessage(page, 'slow please')
  const assistantMessage = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistantMessage.locator('[data-ui="message-body"]')).toContainText('before-abort')
  const abort = page.locator('[data-ui="abort"]')
  await expect(abort).toBeVisible()
  await abort.click()
  const abortBanner = assistantMessage.locator('[data-ui="message-error"][data-role="abort"]')
  await expect(abortBanner).toBeVisible()
  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const assistant = rows.find((r) => r.role === 'assistant') as {
    generation: { abortReason?: string; finishedAt?: number }
  }
  expect(assistant.generation.abortReason).toBe('user')
  expect(typeof assistant.generation.finishedAt).toBe('number')
})

test('reloading mid-stream preserves the partial row and recovers it as tab-close', async ({
  page,
}) => {
  const firstFrame = buildSseBody([{ id: 'reload-mid', content: 'before-reload' }], {
    noDone: true,
  })
  await page.evaluate((frame) => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init)
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(frame))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
  }, firstFrame)
  await createChatAndOpen(page)
  await sendMessage(page, 'reload this stream')
  const assistantMessage = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistantMessage.locator('[data-ui="message-body"]')).toContainText('before-reload')
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  const chatId = await firstChatId(page)
  const hashBefore = await page.evaluate(() => window.location.hash)

  await page.reload()

  expect(await page.evaluate(() => window.location.hash)).toBe(hashBefore)
  await expect
    .poll(async () => {
      const assistant = (await readMessages(page, chatId)).find(
        (row) => row.role === 'assistant',
      ) as { generation?: { abortReason?: string } } | undefined
      return assistant?.generation?.abortReason
    })
    .toBe('tab-close')
  const recovered = (await readMessages(page, chatId)).find((row) => row.role === 'assistant')
  expect(recovered?.content).toEqual([{ type: 'output_text', text: 'before-reload' }])
  await expect(
    page.locator('[data-ui="message-error"][data-role="abort"][data-reason="tab-close"]'),
  ).toBeVisible()
})

test('aborting before any chunk arrives still persists the placeholder', async ({ page }) => {
  let markRequestSeen!: () => void
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve
  })
  let releaseResponse!: () => void
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markRequestSeen()
    await responseGate
    await route
      .fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([{ id: 'unreached', content: 'x', finish: 'stop' }]),
      })
      .catch(() => {})
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'cancel this')
  await requestSeen
  const assistantMessage = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistantMessage).toBeVisible()
  const abort = page.locator('[data-ui="abort"]')
  await expect(abort).toBeVisible()
  await abort.click()
  releaseResponse()
  await expect(
    assistantMessage.locator('[data-ui="message-error"][data-role="abort"]'),
  ).toBeVisible()
  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const assistant = rows.find((r) => r.role === 'assistant') as {
    content: Array<{ type: string; text: string }>
    generation: { abortReason?: string; finishedAt?: number }
  }
  expect(assistant).toBeDefined()
  // Content is empty (no chunks landed) but the row exists.
  expect(assistant.content).toEqual([{ type: 'output_text', text: '' }])
  expect(assistant.generation.abortReason).toBe('user')
  expect(typeof assistant.generation.finishedAt).toBe('number')
})

test('stop also aborts continue-in-place streams on existing assistant messages', async ({
  page,
}) => {
  let requestCount = 0
  let markContinuationRequestSeen!: () => void
  const continuationRequestSeen = new Promise<void>((resolve) => {
    markContinuationRequestSeen = resolve
  })
  let releaseContinuationResponse!: () => void
  const continuationResponseGate = new Promise<void>((resolve) => {
    releaseContinuationResponse = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    if (requestCount === 1) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([{ id: 'seed', content: 'ready', finish: 'stop' }]),
      })
      return
    }
    markContinuationRequestSeen()
    await continuationResponseGate
    await route
      .fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([{ id: 'continue', content: ' plus-more', finish: 'stop' }]),
      })
      .catch(() => {})
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant).toContainText('ready')
  const assistantMessageId = await assistant.getAttribute('data-message-id')
  if (!assistantMessageId) throw new Error('Assistant message has no data-message-id')
  await assistant.locator('[data-action="continue"]').click()
  await continuationRequestSeen
  await expect
    .poll(() =>
      page.evaluate(
        (messageId) =>
          (
            window as unknown as {
              __debugFakeStream?: {
                state(): { streamStore: { activeTargets: Array<{ messageId?: string }> } }
              }
            }
          ).__debugFakeStream
            ?.state()
            .streamStore.activeTargets.some((target) => target.messageId === messageId) ?? false,
        assistantMessageId,
      ),
    )
    .toBe(true)
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await page.locator('[data-ui="abort"]').click()
  releaseContinuationResponse()
  await expect(page.locator('[data-ui="abort"]')).toBeHidden()
  await expect(assistant).toContainText('ready')
  await expect(assistant).not.toContainText('plus-more')
})

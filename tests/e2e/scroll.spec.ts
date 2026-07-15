import { createFakeStreamScenario, retargetOnlyProfileToFakeProvider } from './fake-stream-provider'
import { expect, type Locator, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  seedFirstRun,
  seedLinearChat,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

// Scroll-follow versus pinned-scroll behavior.

function chunkFrame(content: string, finish?: string): string {
  return buildSseBody([{ id: 'scroll-stream', content, ...(finish ? { finish } : {}) }], {
    noDone: finish === undefined,
  })
}

async function mockIncrementalChatCompletions(
  page: Page,
  chunks: readonly string[],
  delayMs: number,
): Promise<void> {
  await page.evaluate(
    ({ chunks, delayMs }) => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
        if (!url.includes('/api/v1/chat/completions')) {
          return originalFetch(input, init)
        }
        const encoder = new TextEncoder()
        const body = new ReadableStream({
          async start(controller) {
            for (const chunk of chunks) {
              if (init?.signal?.aborted) {
                controller.error(new DOMException('Aborted', 'AbortError'))
                return
              }
              controller.enqueue(encoder.encode(chunk))
              await new Promise((resolve) => setTimeout(resolve, delayMs))
            }
            controller.close()
          },
        })
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        })
      }
    },
    { chunks, delayMs },
  )
}

async function scrollDistanceFromBottom(region: Locator): Promise<number> {
  return region.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
}

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('streaming text keeps the scroll region in follow state; scrolling up flips to pinned with a Jump chip', async ({
  page,
}) => {
  // Big output so the scroll region actually overflows.
  const huge = Array.from({ length: 200 }, (_, i) => `streamed line ${i}`).join('\n\n')
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'big-1', content: huge, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'fill the viewport')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toContainText('streamed line 199')
  const region = page.locator('[data-ui="scroll-region"]')
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', {
    timeout: 5000,
  })

  await region.hover()
  await page.mouse.wheel(0, -5000)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned', {
    timeout: 3000,
  })
  const jumpChip = page.locator('[data-ui="jump-to-latest"]')
  await expect(jumpChip).toBeVisible()
  await jumpChip.click()
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', {
    timeout: 3000,
  })
})

test('reopening an overflowing chat snaps to the branch leaf instead of preserving the prior scroll offset', async ({
  page,
}) => {
  const huge = Array.from({ length: 180 }, (_, i) => `history line ${i}`).join('\n\n')
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'open-bottom-1', content: huge, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'make a long chat')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toContainText('history line 179')
  const originalHash = await page.evaluate(() => window.location.hash)
  const region = page.locator('[data-ui="scroll-region"]')
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)

  await region.hover()
  await page.mouse.wheel(0, -5000)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned')

  await page.locator('[data-role="new-chat"]').click()
  await page.waitForFunction(() => window.location.hash === '#/new')
  await page.evaluate((hash) => {
    window.location.hash = hash
  }, originalHash)
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', { timeout: 5000 })
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)
  await page.evaluate(() => {
    const content = document.querySelector('[data-ui="scroll-content"]')
    const sentinel = document.querySelector('[data-ui="scroll-sentinel"]')
    if (!content || !sentinel) throw new Error('Scroll content missing')
    const lateBlock = document.createElement('div')
    lateBlock.setAttribute('data-ui', 'late-open-growth')
    lateBlock.style.height = '900px'
    lateBlock.textContent = 'late open growth'
    content.insertBefore(lateBlock, sentinel)
  })
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', { timeout: 3000 })
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)
  await page.waitForTimeout(400)
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 3000 })
    .toBeLessThanOrEqual(4)
})

test('typing in an expanded composer keeps an overflowing transcript at the bottom', async ({
  page,
}) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 24,
    chatId: 'expanded-composer-scroll-chat',
    title: 'Expanded composer scroll chat',
    textPrefix: 'expanded composer message',
    assistantContentType: 'output_text',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)

  const region = page.locator('[data-ui="scroll-region"]')
  const input = page.locator('[data-ui="composer-input"]')
  const resizeHandle = page.locator('[data-ui="composer-resize-handle"]')
  await resizeHandle.focus()
  for (let i = 0; i < 8; i += 1) await resizeHandle.press('Shift+ArrowUp')
  const expandedHeight = await input.evaluate((node) => node.clientHeight)
  expect(expandedHeight).toBeGreaterThan(300)

  await input.click()
  await region.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  await expect
    .poll(() => region.evaluate((node) => node.scrollHeight > node.clientHeight + 20))
    .toBe(true)
  await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(4)
  await expect(region).toHaveAttribute('data-scroll-state', 'follow')

  for (const key of ['x', 'Backspace']) {
    await input.press(key)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    expect(await scrollDistanceFromBottom(region), `after ${key}`).toBeLessThanOrEqual(4)
    expect(await input.evaluate((node) => node.clientHeight)).toBe(expandedHeight)
    await expect(region).toHaveAttribute('data-scroll-state', 'follow')
  }
})

test('browser find-style native scroll can move upward from the open bottom state', async ({
  page,
}) => {
  const huge = Array.from({ length: 180 }, (_, i) => `browser-find-line ${i}`).join('\n\n')
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'find-scroll-1', content: huge, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'make a searchable long chat')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toContainText('browser-find-line 179')
  const chatId = await firstChatId(page)
  await waitForAssistantGenerationFinished(page, chatId)
  const region = page.locator('[data-ui="scroll-region"]')
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)

  // Headless Chromium's `window.find()` does not reliably scroll nested
  // containers; this exercises the same non-wheel native scroll path.
  const browserFindMovement = await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('[data-ui="message-body"] p'),
    ).find((node) => node.textContent.trim() === 'browser-find-line 5')
    if (!region || !target) throw new Error('Browser-find target or scroll region missing')
    const before = region.scrollTop
    target.scrollIntoView({ block: 'nearest' })
    return { before, after: region.scrollTop }
  })
  expect(browserFindMovement.before - browserFindMovement.after).toBeGreaterThan(200)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned', { timeout: 3000 })
  await expect.poll(() => scrollDistanceFromBottom(region), { timeout: 3000 }).toBeGreaterThan(200)
  await page.evaluate(() => {
    const content = document.querySelector('[data-ui="scroll-content"]')
    const sentinel = document.querySelector('[data-ui="scroll-sentinel"]')
    if (!content || !sentinel) throw new Error('Scroll content missing')
    const lateBlock = document.createElement('div')
    lateBlock.setAttribute('data-ui', 'late-find-growth')
    lateBlock.style.height = '900px'
    lateBlock.textContent = 'late browser-find growth'
    content.insertBefore(lateBlock, sentinel)
  })
  await page.waitForTimeout(400)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned', { timeout: 3000 })
  await expect.poll(() => scrollDistanceFromBottom(region), { timeout: 3000 }).toBeGreaterThan(200)
})

test('incremental streams keep following content growth that renders below the ScrollRegion parent', async ({
  page,
}) => {
  const chunks = Array.from({ length: 32 }, (_, i) =>
    chunkFrame(`stream block ${i}\n${'token '.repeat(420)}\n\n`, i === 31 ? 'stop' : undefined),
  )
  await mockIncrementalChatCompletions(page, chunks, 35)
  await createChatAndOpen(page)
  await sendMessage(page, 'stream for a while')

  const region = page.locator('[data-ui="scroll-region"]')
  await expect
    .poll(
      async () => {
        const metrics = await region.evaluate((node) => ({
          distance: node.scrollHeight - node.scrollTop - node.clientHeight,
          overflow: node.scrollHeight > node.clientHeight + 20,
          state: node.getAttribute('data-scroll-state'),
        }))
        return metrics.overflow && metrics.state === 'follow' && metrics.distance <= 4
      },
      { timeout: 7000 },
    )
    .toBe(true)

  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toContainText('stream block 31', { timeout: 10000 })
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', { timeout: 3000 })
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)
  await page.waitForTimeout(600)
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', { timeout: 3000 })
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 3000 })
    .toBeLessThanOrEqual(4)
})

test('incremental streams keep following after a long windowed chat appends a tail', async ({
  page,
}) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 24,
    chatId: 'scroll-window-chat',
    title: 'Scroll window chat',
    textPrefix: 'scroll window message',
    assistantContentType: 'output_text',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const chunks = Array.from({ length: 24 }, (_, i) =>
    chunkFrame(
      `tail stream block ${i}\n${'token '.repeat(320)}\n\n`,
      i === 23 ? 'stop' : undefined,
    ),
  )
  await mockIncrementalChatCompletions(page, chunks, 35)
  const region = page.locator('[data-ui="scroll-region"]')
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)

  await sendMessage(page, 'append a streamed tail')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .last()
      .locator('[data-ui="message-body"]'),
  ).toContainText('tail stream block 23', { timeout: 10000 })
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', { timeout: 3000 })
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)
})

test('incremental regenerate keeps following after a long windowed chat switches the tail sibling', async ({
  page,
}) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 24,
    chatId: 'scroll-window-chat',
    title: 'Scroll window chat',
    textPrefix: 'scroll window message',
    assistantContentType: 'output_text',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const chunks = Array.from({ length: 24 }, (_, i) =>
    chunkFrame(
      `regenerate stream block ${i}\n${'token '.repeat(320)}\n\n`,
      i === 23 ? 'stop' : undefined,
    ),
  )
  await mockIncrementalChatCompletions(page, chunks, 35)
  const region = page.locator('[data-ui="scroll-region"]')
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)

  await page
    .locator('[data-ui="message"][data-role="assistant"]')
    .last()
    .locator('[data-action="regenerate"]')
    .click()
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .last()
      .locator('[data-ui="message-body"]'),
  ).toContainText('regenerate stream block 23', { timeout: 10000 })
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', { timeout: 3000 })
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
    .toBeLessThanOrEqual(4)
})

test("Save & Send from a pinned earlier message follows this tab's new streaming reply", async ({
  page,
}) => {
  const scenario = await createFakeStreamScenario({
    targetChars: 64_000,
    reasoningChars: 0,
    chunkChars: 2_000,
    initialDelayMs: 100,
    delayMs: 80,
  })
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    const chatId = await seedLinearChat(page, {
      messageCount: 24,
      chatId: 'save-send-scroll-chat',
      title: 'Save and send scroll chat',
      textPrefix: 'save and send history',
      assistantContentType: 'output_text',
      settings: {
        'global:message-render-window-size': 10,
        'global:message-render-window-load-mode': 'manual',
      },
    })
    await page.goto(`/#/chat/${chatId}`)
    await page.reload()

    const region = page.locator('[data-ui="scroll-region"]')
    await expect(page.locator('[data-ui="message"]')).toHaveCount(10)
    await region.hover()
    await page.mouse.wheel(0, -5000)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')

    const earlierUser = page.locator('[data-ui="message"][data-role="user"]').first()
    await earlierUser.locator('[data-action="edit"]').click()
    await earlierUser.locator('[data-ui="inline-editor-input"]').fill('edited earlier prompt')
    await earlierUser.locator('[data-role="save-send"]').click()

    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(1)
    await expect(
      page
        .locator('[data-ui="message"][data-role="assistant"]')
        .last()
        .locator('[data-ui="message-body"]'),
    ).toContainText('Lorem ipsum')
    await expect(region).toHaveAttribute('data-scroll-state', 'follow', { timeout: 3000 })
    await expect
      .poll(() => scrollDistanceFromBottom(region), { timeout: 5000 })
      .toBeLessThanOrEqual(4)

    await region.hover()
    await page.mouse.wheel(0, -1000)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
    const pinnedDistance = await scrollDistanceFromBottom(region)
    await expect
      .poll(() => scrollDistanceFromBottom(region), { timeout: 3000 })
      .toBeGreaterThanOrEqual(pinnedDistance)
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
  } finally {
    await scenario.dispose()
  }
})

import { expect, type Locator, type Page, test } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

// Scroll-follow vs pinned-scroll (plan/13-delivery.md §13.3.0 Phase 8).

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
  await page.goto('/')
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
  await page.waitForFunction(
    (hash) => /^#\/chat\//.test(window.location.hash) && window.location.hash !== hash,
    originalHash,
  )
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

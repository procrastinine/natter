import { createFakeStreamScenario, retargetOnlyProfileToFakeProvider } from './fake-stream-provider'
import { createChatUiJourneyProfile, expect, type Locator, type Page, test } from './fixtures'
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
  waitForWorkspaceRunning,
} from './helpers'

// Scroll-follow versus pinned-scroll behavior.

const BOTTOM_SETTLED_DISTANCE_PX = 4

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

async function sampleBottomControlFrames(
  page: Page,
  count: number,
): Promise<readonly { readonly state: string | null; readonly jumpVisible: boolean }[]> {
  return page.evaluate(async (frameCount) => {
    const samples: Array<{ state: string | null; jumpVisible: boolean }> = []
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
      const jump = document.querySelector<HTMLElement>('[data-ui="jump-to-latest"]')
      samples.push({
        state: region?.getAttribute('data-scroll-state') ?? null,
        jumpVisible: jump !== null && jump.getClientRects().length > 0,
      })
    }
    return samples
  }, count)
}

async function firstFullyVisibleMessageId(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluateAll((messages) => {
    const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) return ''
    const regionRect = region.getBoundingClientRect()
    for (const message of messages) {
      const rect = message.getBoundingClientRect()
      if (rect.top >= regionRect.top + 1 && rect.bottom <= regionRect.bottom - 1) {
        return message.getAttribute('data-message-id') ?? ''
      }
    }
    return ''
  })
}

const HEIGHT_PRODUCER_MECHANISMS = [
  'data-page',
  'stream',
  'async-resource',
  'browser-layout',
  'user-control',
] as const

async function exerciseHeightProducerMechanisms(
  page: Page,
  placement: 'tail' | 'prefix',
): Promise<void> {
  await page.evaluate(
    async ({ mechanisms, placement }) => {
      const content = document.querySelector('[data-ui="scroll-content"]')
      const messageList = document.querySelector('[data-ui="message-list"]')
      const sentinel = document.querySelector('[data-ui="scroll-sentinel"]')
      if (!content || !messageList || !sentinel) throw new Error('ScrollHeightProducerHostMissing')
      const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const probes: HTMLElement[] = []
      for (const [index, mechanism] of mechanisms.entries()) {
        const probe = document.createElement('div')
        probe.dataset.scrollHeightProducerMechanism = mechanism
        probe.style.height = '0px'
        probe.style.overflow = 'hidden'
        probe.textContent = mechanism
        if (placement === 'prefix') {
          messageList.insertBefore(probe, messageList.firstChild)
        } else {
          content.insertBefore(probe, sentinel)
        }
        probes.push(probe)
        await nextFrame()
        probe.style.height = `${96 + index * 17}px`
        await nextFrame()
        await nextFrame()
      }
      for (const probe of probes.reverse()) {
        probe.remove()
        await nextFrame()
        await nextFrame()
      }
    },
    { mechanisms: HEIGHT_PRODUCER_MECHANISMS, placement },
  )
}

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('streaming text keeps the scroll region in follow state; scrolling up flips to pinned with a Jump chip', async ({
  page,
  uiJourney,
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
  await uiJourney.start(page, createChatUiJourneyProfile(), 'scroll-follow')

  await region.hover()
  await page.mouse.wheel(0, -5000)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned', {
    timeout: 3000,
  })
  const jumpChip = page.locator('[data-ui="jump-to-latest"]')
  await expect(jumpChip).toBeVisible()
  await uiJourney.intent(page, {
    kind: 'gesture',
    id: 'jump-to-latest',
    targetSelector: '[data-ui="jump-to-latest"]',
    outcome: {
      selector: '[data-ui="scroll-region"]',
      attributes: { 'data-scroll-state': { kind: 'exact', value: 'follow' } },
    },
  })
  await uiJourney.intent(page, {
    kind: 'acquire-bottom',
    id: 'jump-to-latest-bottom',
    scrollSelector: '[data-ui="scroll-region"]',
  })
  await jumpChip.click()
  await expect(region).toHaveAttribute('data-scroll-state', 'follow', {
    timeout: 3000,
  })
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 3000 })
    .toBeLessThanOrEqual(4)
  await uiJourney.checkpoint(page, 'jump-to-latest-finished')
})

test('near-bottom scrolling has one stable Jump state and exact bottom clears it', async ({
  page,
}) => {
  const huge = Array.from({ length: 200 }, (_, i) => `boundary line ${i}`).join('\n\n')
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'bottom-boundary-1', content: huge, finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'exercise the bottom boundary')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toContainText('boundary line 199')
  const region = page.locator('[data-ui="scroll-region"]')
  const jumpChip = page.locator('[data-ui="jump-to-latest"]')
  await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(4)
  await expect(region).toHaveAttribute('data-scroll-state', 'follow')
  await expect(jumpChip).toHaveCount(0)

  await region.hover()
  await page.mouse.wheel(0, -24)
  await expect
    .poll(() => scrollDistanceFromBottom(region))
    .toBeGreaterThan(BOTTOM_SETTLED_DISTANCE_PX)
  await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThan(48)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
  await expect(jumpChip).toBeVisible()

  await page.mouse.wheel(0, 8)
  await page.mouse.wheel(0, -8)
  const nearBottomFrames = await sampleBottomControlFrames(page, 12)
  expect(nearBottomFrames.every((frame) => frame.state === 'pinned' && frame.jumpVisible)).toBe(
    true,
  )

  await page.mouse.wheel(0, 200)
  await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(4)
  await expect(region).toHaveAttribute('data-scroll-state', 'follow')
  await expect(jumpChip).toHaveCount(0)
  const bottomFrames = await sampleBottomControlFrames(page, 12)
  expect(bottomFrames.every((frame) => frame.state === 'follow' && !frame.jumpVisible)).toBe(true)
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
  await page.evaluate(async () => {
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
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

  await region.hover()
  await page.mouse.wheel(0, -5000)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned', { timeout: 3000 })
  const pinnedDistance = await scrollDistanceFromBottom(region)
  await page.evaluate(async () => {
    for (let frame = 0; frame < 12; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
    const content = document.querySelector('[data-ui="scroll-content"]')
    const sentinel = document.querySelector('[data-ui="scroll-sentinel"]')
    if (!content || !sentinel) throw new Error('Scroll content missing')
    const lateBlock = document.createElement('div')
    lateBlock.setAttribute('data-ui', 'late-cancelled-growth')
    lateBlock.style.height = '900px'
    lateBlock.textContent = 'late growth after user cancellation'
    content.insertBefore(lateBlock, sentinel)
  })
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned', { timeout: 3000 })
  await expect
    .poll(() => scrollDistanceFromBottom(region), { timeout: 3000 })
    .toBeGreaterThanOrEqual(pinnedDistance + 800)
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
      'global:message-initial-render-work': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect.poll(() => page.locator('[data-ui="message"]').count()).toBeGreaterThanOrEqual(10)

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

test('an active message edit does not trap transcript scrolling in either direction', async ({
  page,
}) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 39,
    chatId: 'active-edit-scroll-chat',
    title: 'Active edit scroll chat',
    assistantContentType: 'output_text',
    textForIndex: (index) => `active-edit-marker-${index}\n\nbody row ${index}`,
    settings: {
      'global:message-initial-render-work': 39,
      'global:message-render-window-load-mode': 'manual',
    },
  })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(39)

  const region = page.locator('[data-ui="scroll-region"]')
  const geometry = () =>
    page.evaluate(() => {
      const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
      const editor = document.querySelector<HTMLElement>('[data-ui="inline-editor"]')
      if (!region || !editor) throw new Error('Active editor scroll geometry missing')
      const regionRect = region.getBoundingClientRect()
      const editorRect = editor.getBoundingClientRect()
      return {
        regionTop: regionRect.top,
        regionBottom: regionRect.bottom,
        editorTop: editorRect.top,
        editorBottom: editorRect.bottom,
      }
    })

  const wheel = async (deltaY: number) => {
    for (let step = 0; step < 16; step += 1) {
      await page.mouse.wheel(0, deltaY)
    }
  }

  const tailMessage = page
    .locator('[data-ui="message"][data-role="user"]')
    .filter({ hasText: 'active-edit-marker-38' })
  await tailMessage.locator('[data-action="edit"]').click()
  const tailInput = tailMessage.locator('[data-ui="inline-editor-input"]')
  await expect(tailInput).toBeFocused()
  await page.locator('[data-ui="jump-to-latest"]').click()
  await expect(region).toHaveAttribute('data-scroll-state', 'follow')
  await tailInput.hover()
  await page.mouse.wheel(0, -400)
  await expect
    .poll(async () => {
      const current = await geometry()
      return current.editorTop >= current.regionBottom - 1
    })
    .toBe(true)
  await expect(tailInput).toHaveValue(/active-edit-marker-38/u)

  await tailInput.press('Escape')
  await expect(tailMessage.locator('[data-ui="inline-editor"]')).toHaveCount(0)
  await region.hover()
  for (let step = 0; step < 16; step += 1) {
    await page.mouse.wheel(0, -10_000)
    if ((await region.evaluate((node) => node.scrollTop)) <= 1) break
  }
  await expect.poll(() => region.evaluate((node) => node.scrollTop)).toBeLessThanOrEqual(1)

  const rootMessage = page
    .locator('[data-ui="message"][data-role="user"]')
    .filter({ hasText: 'active-edit-marker-0' })
  await rootMessage.locator('[data-action="edit"]').click()
  const rootInput = rootMessage.locator('[data-ui="inline-editor-input"]')
  await expect(rootInput).toBeFocused()
  await rootInput.hover()
  await wheel(400)
  await expect
    .poll(async () => {
      const current = await geometry()
      return current.editorBottom <= current.regionTop + 1
    })
    .toBe(true)
  await expect(rootInput).toHaveValue(/active-edit-marker-0/u)
})

test('incremental streams keep following content growth that renders below the ScrollRegion parent', async ({
  page,
  uiJourney,
}) => {
  const chunks = Array.from({ length: 32 }, (_, i) =>
    chunkFrame(`stream block ${i}\n${'token '.repeat(420)}\n\n`, i === 31 ? 'stop' : undefined),
  )
  await mockIncrementalChatCompletions(page, chunks, 35)
  await createChatAndOpen(page)
  await uiJourney.start(page, createChatUiJourneyProfile(), 'stream-terminal-follow')
  await page.locator('[data-ui="composer-input"]').fill('stream for a while')
  await uiJourney.intent(page, {
    kind: 'gesture',
    id: 'stream-terminal-send',
    targetSelector: '[data-ui="send"]',
    allowsRouteChange: true,
    expectedRoute: { kind: 'prefix', value: '/#/chat/' },
    outcome: { selector: '[data-ui="abort"]', requireInteractive: true },
  })
  await page.locator('[data-ui="send"]').click()
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await uiJourney.checkpoint(page, 'stream-send-owned')
  await uiJourney.intent(page, {
    kind: 'acquire-bottom',
    id: 'stream-terminal-bottom',
    scrollSelector: '[data-ui="scroll-region"]',
  })

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
  await uiJourney.finish(page, 'stream-terminal-renderer-stable')
})

test('all inventoried height-producer mechanisms preserve follow and pinned ownership', async ({
  page,
  uiJourney,
}) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 24,
    chatId: 'scroll-height-producer-chat',
    title: 'Scroll height producer chat',
    textPrefix: 'scroll height producer message',
    assistantContentType: 'output_text',
    settings: {
      'global:message-initial-render-work': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const region = page.locator('[data-ui="scroll-region"]')
  await expect.poll(() => page.locator('[data-ui="message"]').count()).toBeGreaterThanOrEqual(10)
  await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(4)
  await uiJourney.start(page, createChatUiJourneyProfile(), 'height-producer-ownership-matrix')

  await uiJourney.intent(page, {
    kind: 'follow-bottom',
    id: 'height-producers-follow',
    scrollSelector: '[data-ui="scroll-region"]',
  })
  await exerciseHeightProducerMechanisms(page, 'tail')
  await uiJourney.checkpoint(page, 'height-producers-follow-complete')

  await region.hover()
  await page.mouse.wheel(0, -1_200)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
  await uiJourney.intent(page, {
    kind: 'prepend-anchor',
    id: 'height-producers-pinned',
    scrollSelector: '[data-ui="scroll-region"]',
    tolerancePx: 2,
  })
  await exerciseHeightProducerMechanisms(page, 'prefix')
  await uiJourney.checkpoint(page, 'height-producers-pinned-complete')
  await uiJourney.finish(page, 'height-producer-ownership-matrix-complete')
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
      'global:message-initial-render-work': 10,
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
  await expect.poll(() => page.locator('[data-ui="message"]').count()).toBeGreaterThanOrEqual(10)
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
      'global:message-initial-render-work': 10,
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
  await expect.poll(() => page.locator('[data-ui="message"]').count()).toBeGreaterThanOrEqual(10)
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
  uiJourney,
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
        'global:message-initial-render-work': 10,
        'global:message-render-window-load-mode': 'manual',
      },
    })
    await page.goto(`/#/chat/${chatId}`)
    await page.reload()
    await waitForWorkspaceRunning(page)

    const region = page.locator('[data-ui="scroll-region"]')
    await expect.poll(() => page.locator('[data-ui="message"]').count()).toBeGreaterThanOrEqual(10)
    await region.hover()
    await page.mouse.wheel(0, -5000)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')

    let earlierMessageId = ''
    await expect
      .poll(async () => {
        earlierMessageId = await firstFullyVisibleMessageId(
          page,
          '[data-ui="message"][data-role="user"]',
        )
        return earlierMessageId
      })
      .not.toBe('')
    const earlierUser = page.locator(`[data-ui="message"][data-message-id="${earlierMessageId}"]`)
    await earlierUser.locator('[data-action="edit"]').click()
    await earlierUser.locator('[data-ui="inline-editor-input"]').fill('edited earlier prompt')
    await uiJourney.start(page, createChatUiJourneyProfile(), 'save-send-bottom-handoff')
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: 'save-send',
      targetSelector: '[data-role="save-send"]',
      allowsRouteChange: true,
      expectedRoute: { kind: 'prefix', value: `/#/chat/${chatId}/message/` },
      outcome: { selector: '[data-ui="abort"]', requireInteractive: true },
    })
    await uiJourney.intent(page, {
      kind: 'acquire-bottom',
      id: 'save-send-bottom',
      scrollSelector: '[data-ui="scroll-region"]',
      rejectAlignmentSelector: `[data-message-id="${earlierMessageId}"]`,
    })
    await uiJourney.intent(page, {
      kind: 'transcript-replace-after',
      id: 'save-send-suffix',
      messageId: earlierMessageId,
    })
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
    await uiJourney.checkpoint(page, 'save-send-bottom-acquired')

    await region.hover()
    const followDistance = await scrollDistanceFromBottom(region)
    await page.mouse.wheel(0, -400)
    await page.mouse.wheel(0, -400)
    await page.mouse.wheel(0, -400)
    await expect
      .poll(() => scrollDistanceFromBottom(region), { timeout: 3000 })
      .toBeGreaterThan(followDistance + 200)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
    const pinnedDistance = await scrollDistanceFromBottom(region)
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
    await expect
      .poll(() => scrollDistanceFromBottom(region), { timeout: 3000 })
      .toBeGreaterThanOrEqual(pinnedDistance - 4)
    await uiJourney.finish(page, 'save-send-user-owned')
  } finally {
    await scenario.dispose()
  }
})

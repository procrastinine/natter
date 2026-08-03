import { createFakeStreamScenario, retargetOnlyProfileToFakeProvider } from './fake-stream-provider'
import { expect, type Locator, test } from './fixtures'
import {
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  readMessages,
  seedFirstRun,
  seedLinearChat,
  sendMessage,
  startMessageCountRecorder,
  stopMessageCountRecorder,
  waitForAssistantGenerationFinished,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('large streamed turns do not recycle the transcript after completion', async ({ page }) => {
  const scenario = await createFakeStreamScenario({
    targetChars: 32,
    reasoningChars: 0,
    chunkChars: 32,
    delayMs: 0,
  })
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    await createChatAndOpen(page)
    await sendMessage(page, 'small turn')
    await expect(page).toHaveURL(/#\/chat\/[^/]+\/message\//u)
    const chatId = await firstChatId(page)
    expect(chatId).not.toBe('')
    await waitForAssistantGenerationFinished(page, chatId)
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
    await expect(page.locator('[data-ui="message"]')).toHaveCount(2)

    await scenario.update({
      targetChars: 100_100,
      reasoningChars: 0,
      chunkChars: 25_000,
      delayMs: 10,
    })
    await startMessageCountRecorder(page)
    await sendMessage(page, 'large turn')
    await waitForAssistantGenerationFinished(page, chatId, 1)
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
    const snapshot = await scenario.snapshot()
    const generationRequests = snapshot.requests.filter(
      (request) => request.method === 'POST' && request.path === '/chat/completions',
    )
    expect(generationRequests).toHaveLength(1)
    expect(generationRequests[0]?.promptChars).toBeGreaterThan('large turn'.length)

    const assistants = (await readMessages(page, chatId)).filter(
      (row) => row.role === 'assistant' && row.deleted === false,
    )
    expect(messageTextLength(assistants[1])).toBe(100_100)
    await page.waitForTimeout(600)

    expect(await stopMessageCountRecorder(page)).toEqual({
      anchorRemoved: false,
      listRemoved: false,
      listReplaced: false,
      loadingSeen: false,
      messageCountDecreased: false,
      messageCountsIncludeZero: false,
      minimumMessageCount: expect.any(Number),
      minimumBranchControlCount: 0,
    })
  } finally {
    await scenario.dispose()
  }
})

test('ordinary composer send appends user and streaming assistant while keeping the terminal resident', async ({
  page,
}, testInfo) => {
  const scenario = await createFakeStreamScenario({
    targetChars: 160_000,
    reasoningChars: 0,
    chunkChars: 10_000,
    initialDelayMs: 100,
    delayMs: 80,
    holdUntilReleased: true,
  })
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    const chatId = await seedLinearChat(page, {
      messageCount: 8,
      chatId: 'ordinary-send-continuity-chat',
      title: 'Ordinary send continuity chat',
      textPrefix: 'ordinary send history',
      assistantContentType: 'output_text',
      settings: {
        'global:message-initial-render-work': 8,
        'global:message-render-window-load-mode': 'manual',
      },
    })
    await page.goto(`/#/chat/${chatId}`)
    await page.reload()

    const messages = page.locator('[data-ui="message"][data-message-id]')
    await expect(messages).toHaveCount(8)
    const region = page.locator('[data-ui="scroll-region"]')
    await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(4)

    await startMessageCountRecorder(page)
    await sendMessage(page, 'ordinary composer continuity prompt')
    const messageList = page.locator('[data-ui="message-list"]')
    await expect(messageList).toHaveAttribute('data-rendered-count', '10')
    const persistedRows = await readMessages(page, chatId)
    const appendedUserId = persistedRows.at(-2)?.id
    const appendedAssistantId = persistedRows.at(-1)?.id
    if (typeof appendedUserId !== 'string' || typeof appendedAssistantId !== 'string') {
      throw new Error('Appended send rows are missing durable ids')
    }
    const appendedUser = page.locator(`[data-ui="message"][data-message-id="${appendedUserId}"]`)
    const streamedAssistant = page.locator(
      `[data-ui="message"][data-message-id="${appendedAssistantId}"]`,
    )
    await expect(appendedUser).toHaveAttribute('data-role', 'user')
    await expect(appendedUser.locator('[data-ui="message-body"]')).toHaveText(
      'ordinary composer continuity prompt',
    )
    await expect(streamedAssistant).toHaveAttribute('data-role', 'assistant')
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(1)
    await installStreamViewportProbe(page, appendedAssistantId, 'follow')
    await scenario.release()
    await expect
      .poll(() =>
        streamedAssistant
          .locator('[data-ui="message-body"]')
          .evaluate((node) => node.textContent.length),
      )
      .toBeGreaterThan(80_000)
    await expect
      .poll(() => region.evaluate((node) => node.scrollHeight > node.clientHeight + 100))
      .toBe(true)
    await expect(region).toHaveAttribute('data-scroll-state', 'follow')
    await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(4)
    const retainedStreamingPrefix = streamedAssistant
      .locator('[data-ui="markdown-segment"][data-mode="static"]')
      .first()
    await expect(retainedStreamingPrefix).toHaveCount(1)
    const streamingMarkdownRoot = streamedAssistant.locator('[data-ui="markdown"]')
    const transitionMetrics = await stableScrollMetrics(region)
    await streamedAssistant.evaluate((node) => {
      ;(node as HTMLElement & { retainedAcrossFinalization?: true }).retainedAcrossFinalization =
        true
    })
    await streamedAssistant.locator('[data-ui="message-body"]').evaluate((node) => {
      ;(node as HTMLElement & { retainedAcrossFinalization?: true }).retainedAcrossFinalization =
        true
    })
    await streamingMarkdownRoot.evaluate((node) => {
      ;(node as HTMLElement & { retainedAcrossFinalization?: true }).retainedAcrossFinalization =
        true
    })
    await retainedStreamingPrefix.evaluate((node) => {
      ;(node as HTMLElement & { retainedAcrossFinalization?: true }).retainedAcrossFinalization =
        true
    })

    await waitForAssistantGenerationFinished(page, chatId, 4)
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
    const assistants = (await readMessages(page, chatId)).filter(
      (row) => row.role === 'assistant' && row.deleted === false,
    )
    expect(assistants).toHaveLength(5)
    expect(messageTextLength(assistants.at(-1))).toBe(160_000)
    await expect(messageList).toHaveAttribute('data-rendered-count', '10')
    await expect(region).toHaveAttribute('data-scroll-state', 'follow')
    await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(4)
    expect(
      await streamedAssistant.evaluate((node) => {
        const retained = (element: Element | null) =>
          element !== null &&
          'retainedAcrossFinalization' in element &&
          element.retainedAcrossFinalization === true
        return {
          message: retained(node),
          body: retained(node.querySelector('[data-ui="message-body"]')),
          markdown: retained(node.querySelector('[data-ui="markdown"]')),
          frozenPrefix: retained(
            node.querySelector('[data-ui="markdown-segment"][data-mode="static"]'),
          ),
        }
      }),
    ).toEqual({ message: true, body: true, markdown: true, frozenPrefix: true })
    await expect(streamingMarkdownRoot).toHaveAttribute('data-overflow', 'streaming-segmented')
    expect(
      await streamingMarkdownRoot
        .locator('[data-ui="markdown-segment"]')
        .evaluateAll((segments) =>
          segments.every((segment) => segment.getAttribute('data-mode') === 'static'),
        ),
    ).toBe(true)
    const finalizedMetrics = await region.evaluate((node) => ({
      distanceFromBottom: node.scrollHeight - node.scrollTop - node.clientHeight,
      scrollTop: node.scrollTop,
    }))
    expect(
      Math.abs(finalizedMetrics.distanceFromBottom - transitionMetrics.distanceFromBottom),
    ).toBeLessThanOrEqual(4)
    await testInfo.attach('finalization-geometry.json', {
      body: JSON.stringify(
        {
          transitionMetrics,
          finalizedMetrics,
          bottomDistanceDelta: Math.abs(
            finalizedMetrics.distanceFromBottom - transitionMetrics.distanceFromBottom,
          ),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    })
    await testInfo.attach('finalized-transcript.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })

    const continuity = await stopMessageCountRecorder(page)
    expect(continuity).toMatchObject({
      listRemoved: false,
      listReplaced: false,
      loadingSeen: false,
      messageCountDecreased: false,
      messageCountsIncludeZero: false,
    })
    expect(continuity.minimumMessageCount).toBeGreaterThanOrEqual(8)
    const viewportContinuity = await stopStreamViewportProbe(page)
    expect(viewportContinuity.samples).toBeGreaterThan(5)
    expect(viewportContinuity.violations).toEqual([])
  } finally {
    await scenario.dispose()
  }
})

test('physical scrolling inside a growing streamed message preserves the visible text through completion', async ({
  page,
}) => {
  const scenario = await createFakeStreamScenario({
    targetChars: 220_000,
    reasoningChars: 0,
    chunkChars: 5_000,
    initialDelayMs: 100,
    delayMs: 70,
    holdUntilReleased: true,
  })
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    const chatId = await seedLinearChat(page, {
      messageCount: 8,
      chatId: 'pinned-stream-continuity-chat',
      title: 'Pinned stream continuity chat',
      textPrefix: 'pinned stream history',
      assistantContentType: 'output_text',
      settings: {
        'global:message-initial-render-work': 8,
        'global:message-render-window-load-mode': 'manual',
      },
    })
    await page.goto(`/#/chat/${chatId}`)
    await page.reload()

    await sendMessage(page, 'stream viewport continuity prompt')
    await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
      'data-rendered-count',
      '10',
    )
    const persistedRows = await readMessages(page, chatId)
    const assistantId = persistedRows.at(-1)?.id
    if (typeof assistantId !== 'string') throw new Error('Streaming assistant id missing')
    const assistant = page.locator(`[data-ui="message"][data-message-id="${assistantId}"]`)
    await expect(assistant).toHaveAttribute('data-role', 'assistant')
    const region = page.locator('[data-ui="scroll-region"]')
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(1)
    await scenario.release()
    await expect
      .poll(
        () =>
          assistant.locator('[data-ui="message-body"]').evaluate((node) => node.textContent.length),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(90_000)
    await expect(region).toHaveAttribute('data-scroll-state', 'follow')

    await region.hover()
    await page.mouse.wheel(0, -3_200)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
    await waitForAnimationFrames(page, 3)
    await installStreamViewportProbe(page, assistantId, 'pinned')
    await expect.poll(() => streamViewportProbeSampleCount(page)).toBeGreaterThan(0)

    await waitForAssistantGenerationFinished(page, chatId, 4)
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
    await waitForAnimationFrames(page, 4)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
    const viewportContinuity = await stopStreamViewportProbe(page)
    expect(viewportContinuity.samples).toBeGreaterThan(5)
    expect(viewportContinuity.violations).toEqual([])
    expect(viewportContinuity.maximumCharacterDrift).toBeLessThanOrEqual(256)
  } finally {
    await scenario.dispose()
  }
})

function messageTextLength(row: Record<string, unknown> | undefined): number {
  if (!row) throw new Error('Persisted assistant missing')
  if (!Array.isArray(row.content)) return 0
  return (row.content as Array<{ text?: unknown }>).reduce(
    (sum, item) => sum + (typeof item.text === 'string' ? item.text.length : 0),
    0,
  )
}

async function scrollDistanceFromBottom(region: Locator): Promise<number> {
  return region.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)
}

async function stableScrollMetrics(region: Locator): Promise<{
  readonly distanceFromBottom: number
  readonly scrollTop: number
}> {
  return region.evaluate(async (node) => {
    let previous = {
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    }
    let stableFrames = 0
    for (let frame = 0; frame < 120 && stableFrames < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const current = {
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
      }
      stableFrames =
        Math.abs(current.clientHeight - previous.clientHeight) <= 0.5 &&
        Math.abs(current.scrollHeight - previous.scrollHeight) <= 0.5 &&
        Math.abs(current.scrollTop - previous.scrollTop) <= 0.5
          ? stableFrames + 1
          : 0
      previous = current
    }
    if (stableFrames < 3) throw new Error('ScrollMetricsDidNotSettle')
    return {
      distanceFromBottom: node.scrollHeight - node.scrollTop - node.clientHeight,
      scrollTop: node.scrollTop,
    }
  })
}

interface StreamViewportSample {
  readonly characterOffset: number
  readonly messageTop: number
  readonly scrollTop: number
  readonly textLength: number
}

interface StreamViewportProbeReport {
  readonly samples: number
  readonly maximumCharacterDrift: number
  readonly violations: Array<Record<string, unknown>>
}

async function installStreamViewportProbe(
  page: Parameters<typeof waitForAnimationFrames>[0],
  messageId: string,
  mode: 'follow' | 'pinned',
): Promise<void> {
  await page.evaluate(
    ({ messageId: targetMessageId, mode: probeMode }) => {
      const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
      if (!region) throw new Error('StreamViewportProbeSurfaceMissing')
      const readSample = (): StreamViewportSample | null => {
        const message = document.querySelector<HTMLElement>(
          `[data-ui="message"][data-message-id="${CSS.escape(targetMessageId)}"]`,
        )
        const markdown = message?.querySelector<HTMLElement>('[data-ui="markdown"]')
        if (!message || !markdown) return null
        const regionRect = region.getBoundingClientRect()
        const messageRect = message.getBoundingClientRect()
        const markdownRect = markdown.getBoundingClientRect()
        const visibleBlocks = Array.from(
          markdown.querySelectorAll<HTMLElement>('p, li, pre'),
        ).filter((block) => {
          const rect = block.getBoundingClientRect()
          return rect.bottom > regionRect.top && rect.top < regionRect.bottom
        })
        const targetYs = [0.5, 0.35, 0.65].map(
          (ratio) => regionRect.top + regionRect.height * ratio,
        )
        let caret: Range | null = null
        for (const targetY of targetYs) {
          const block =
            visibleBlocks.find((candidate) => {
              const rect = candidate.getBoundingClientRect()
              return rect.top <= targetY && rect.bottom >= targetY
            }) ?? visibleBlocks[0]
          if (!block) continue
          const blockRect = block.getBoundingClientRect()
          const y = Math.min(Math.max(targetY, blockRect.top + 1), blockRect.bottom - 1)
          const left = Math.max(blockRect.left, markdownRect.left, regionRect.left) + 4
          const right = Math.min(blockRect.right, markdownRect.right, regionRect.right) - 4
          const xs = [left + 12, (left + right) / 2, right - 12].filter(
            (x) => Number.isFinite(x) && x >= left && x <= right,
          )
          for (const x of xs) {
            const candidate = document.caretRangeFromPoint?.(x, y) ?? null
            if (candidate && markdown.contains(candidate.startContainer)) {
              caret = candidate
              break
            }
          }
          if (caret) break
        }
        if (!caret) return null
        const segment =
          (caret.startContainer instanceof Element
            ? caret.startContainer
            : caret.startContainer.parentElement
          )?.closest<HTMLElement>('[data-ui="markdown-segment"]') ?? null
        if (!segment || !markdown.contains(segment)) return null
        let priorLength = 0
        for (const candidate of markdown.querySelectorAll<HTMLElement>(
          '[data-ui="markdown-segment"]',
        )) {
          if (candidate === segment) break
          priorLength += Number(candidate.dataset.length ?? '0')
        }
        const prefix = document.createRange()
        prefix.selectNodeContents(segment)
        prefix.setEnd(caret.startContainer, caret.startOffset)
        const textLength = Array.from(
          markdown.querySelectorAll<HTMLElement>('[data-ui="markdown-segment"]'),
        ).reduce((sum, candidate) => sum + Number(candidate.dataset.length ?? '0'), 0)
        return {
          characterOffset: priorLength + prefix.toString().length,
          messageTop: messageRect.top,
          scrollTop: region.scrollTop,
          textLength,
        }
      }
      const probe = {
        active: true,
        baseline: null as StreamViewportSample | null,
        previous: null as StreamViewportSample | null,
        samples: 0,
        maximumCharacterDrift: 0,
        violations: [] as Array<Record<string, unknown>>,
      }
      ;(
        window as typeof window & {
          __streamViewportProbe?: typeof probe
        }
      ).__streamViewportProbe = probe
      const monitor = () => {
        if (!probe.active) return
        const sample = readSample()
        if (sample) {
          probe.samples += 1
          probe.baseline ??= sample
          const drift = Math.abs(sample.characterOffset - probe.baseline.characterOffset)
          probe.maximumCharacterDrift = Math.max(probe.maximumCharacterDrift, drift)
          if (
            probeMode === 'follow' &&
            probe.previous &&
            sample.characterOffset + 256 < probe.previous.characterOffset
          ) {
            probe.violations.push({
              kind: 'follow-moved-backward',
              before: probe.previous,
              after: sample,
            })
          }
          if (probeMode === 'pinned' && drift > 256) {
            probe.violations.push({
              kind: 'pinned-text-drift',
              baseline: probe.baseline,
              current: sample,
            })
          }
          probe.previous = sample
        }
        requestAnimationFrame(monitor)
      }
      requestAnimationFrame(monitor)
    },
    { messageId, mode },
  )
}

async function streamViewportProbeSampleCount(
  page: Parameters<typeof waitForAnimationFrames>[0],
): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __streamViewportProbe?: { samples: number }
        }
      ).__streamViewportProbe?.samples ?? 0,
  )
}

async function stopStreamViewportProbe(
  page: Parameters<typeof waitForAnimationFrames>[0],
): Promise<StreamViewportProbeReport> {
  return page.evaluate(() => {
    const probe = (
      window as typeof window & {
        __streamViewportProbe?: {
          active: boolean
          samples: number
          maximumCharacterDrift: number
          violations: Array<Record<string, unknown>>
        }
      }
    ).__streamViewportProbe
    if (!probe) throw new Error('StreamViewportProbeMissing')
    probe.active = false
    return {
      samples: probe.samples,
      maximumCharacterDrift: probe.maximumCharacterDrift,
      violations: probe.violations,
    }
  })
}

async function waitForAnimationFrames(
  page: import('@playwright/test').Page,
  count: number,
): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, count)
}

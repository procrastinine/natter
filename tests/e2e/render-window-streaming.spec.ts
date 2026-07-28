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

test('ordinary composer send appends user and streaming assistant without replacing the mounted prefix', async ({
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
    const commonPrefixMessageIds = await messages.evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-message-id'))
        .filter((id): id is string => id !== null),
    )
    const region = page.locator('[data-ui="scroll-region"]')
    await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(4)

    await startMessageCountRecorder(page, { commonPrefixMessageIds })
    await sendMessage(page, 'ordinary composer continuity prompt')
    await expect(messages).toHaveCount(10)
    await expect(messages.nth(8)).toHaveAttribute('data-role', 'user')
    await expect(messages.nth(8).locator('[data-ui="message-body"]')).toHaveText(
      'ordinary composer continuity prompt',
    )
    const streamedAssistant = messages.nth(9)
    await expect(streamedAssistant).toHaveAttribute('data-role', 'assistant')
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(1)
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
    const transitionMetrics = await region.evaluate((node) => ({
      distanceFromBottom: node.scrollHeight - node.scrollTop - node.clientHeight,
      scrollTop: node.scrollTop,
    }))
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
    await expect(messages).toHaveCount(10)
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
      commonPrefixDisconnectedIds: [],
      commonPrefixReplacedIds: [],
      listRemoved: false,
      listReplaced: false,
      loadingSeen: false,
      messageCountBelowExpectedCommonPrefix: false,
      messageCountDecreased: false,
      messageCountsIncludeZero: false,
    })
    expect(continuity.minimumMessageCount).toBeGreaterThanOrEqual(commonPrefixMessageIds.length)
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

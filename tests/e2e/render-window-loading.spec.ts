import {
  armDestinationFrameBudgetRecorder,
  assertDestinationFrameBudget,
  finishDestinationFrameBudgetRecorder,
  installDestinationFrameBudgetRecorder,
} from './destination-frame-budget-recorder'
import { createChatUiJourneyProfile, expect, type Locator, type Page, test } from './fixtures'
import { clearIndexedDb, seedFirstRun, seedLinearChat } from './helpers'

const MAX_SELECTION_PATH_HEADER_ROWS_PER_TRANSACTION = 64

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('destination-first transcript loading passively reaches the configured floor for short messages', async ({
  page,
}) => {
  const initialRenderWork = 10
  const viewportHeight = 360
  const textForIndex = (index: number) => `short passive history ${index}`
  const maximumInitialRenderedCount = 12
  await installDestinationFirstProbe(page, initialRenderWork)
  const chatId = await seedLinearChat(page, {
    messageCount: 32,
    chatId: 'render-window-short-passive-chat',
    title: 'Short passive render window chat',
    textForIndex,
    settings: {
      'global:message-initial-render-work': initialRenderWork,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.setViewportSize({ width: 1280, height: viewportHeight })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await assertDestinationFirstPassiveFill(page, {
    destinationText: 'short passive history 31',
    initialRenderWork,
    maximumInitialRenderedCount,
    totalCount: 32,
  })
})

test('one sidebar destination gesture bounds the complete configured transcript window', async ({
  page,
}, testInfo) => {
  const initialRenderWork = 50
  const totalCount = 80
  await installDestinationFrameBudgetRecorder(page)
  const chatId = await seedLinearChat(page, {
    messageCount: totalCount,
    chatId: 'destination-frame-budget-chat',
    title: 'Destination frame budget chat',
    textForIndex: (index) =>
      index % 11 === 0
        ? `${'x'.repeat(200_000)} destination budget huge ${index}`
        : `destination budget short ${index}`,
    settings: {
      'global:message-initial-render-work': initialRenderWork,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(initialRenderWork)
  const terminalMessageId = await page
    .locator('[data-ui="message"][data-message-id]')
    .last()
    .getAttribute('data-message-id')
  if (!terminalMessageId) throw new Error('DestinationFrameBudgetTerminalMissing')
  await page.locator('[data-role="new-chat"]').click()
  await expect(page).toHaveURL(/#\/new$/u)

  const targetHref = `#/chat/${chatId}`
  const target = page.locator(`[data-ui="chat-row-link"][href="${targetHref}"]`)
  await expect(target).toBeVisible()
  await armDestinationFrameBudgetRecorder(page, {
    chatId,
    targetHref,
    targetMessageId: terminalMessageId,
    minimumRows: initialRenderWork,
  })
  await target.click()
  const snapshot = await finishDestinationFrameBudgetRecorder(page)
  assertDestinationFrameBudget(snapshot, { firstPaintMs: 1_500, completeMs: 5_000 })
  await expect(page).toHaveURL(new RegExp(`#/chat/${chatId}/message/${terminalMessageId}$`, 'u'))
  expect(snapshot.publications.map((publication) => publication.renderedCount)).toEqual([
    1,
    initialRenderWork,
  ])
  expect(snapshot.publications[0]?.messageIds).toEqual([terminalMessageId])
  const finalIds = snapshot.publications.at(-1)?.messageIds ?? []
  expect(finalIds).toHaveLength(initialRenderWork)
  expect(new Set(finalIds).size).toBe(finalIds.length)

  const bodyRows = snapshot.requests.flatMap((request) =>
    request.store === 'messageBodies' ? request.targetRows : [],
  )
  expect(bodyRows.map((row) => row.id).sort()).toEqual([...finalIds].sort())
  expect(bodyRows.filter((row) => row.id === terminalMessageId)).toHaveLength(1)
  const bodyReads = new Map<string, number>()
  for (const row of bodyRows) {
    if (row.id) bodyReads.set(row.id, (bodyReads.get(row.id) ?? 0) + 1)
  }
  expect([...bodyReads.values()].every((count) => count === 1)).toBe(true)

  for (const transaction of snapshot.transactions) {
    const requests = snapshot.requests.filter(
      (request) => request.transactionId === transaction.id && request.store === 'messageBodies',
    )
    const rows = requests.flatMap((request) => request.targetRows)
    const uniqueRows = new Map(rows.filter((row) => row.id).map((row) => [row.id as string, row]))
    expect(uniqueRows.size).toBeLessThanOrEqual(16)
    const textBytes = [...uniqueRows.values()].reduce((sum, row) => sum + row.textBytes, 0)
    if (textBytes > 256_000) expect(uniqueRows.size).toBe(1)
  }
  for (const transaction of snapshot.transactions) {
    const structuralRows = snapshot.requests
      .filter((request) => request.transactionId === transaction.id && request.store === 'messages')
      .flatMap((request) => request.targetRows)
    expect(new Set(structuralRows.map((row) => row.id).filter(Boolean)).size).toBeLessThanOrEqual(
      MAX_SELECTION_PATH_HEADER_ROWS_PER_TRANSACTION,
    )
  }
  await testInfo.attach('destination-frame-budget.json', {
    body: JSON.stringify(snapshot, null, 2),
    contentType: 'application/json',
  })
})

test('very long destination paints first, passively fills, and loads older batches manually', async ({
  page,
  uiJourney,
}, testInfo) => {
  const initialRenderWork = 10
  await installDestinationFirstProbe(page, initialRenderWork)
  const totalCount = 96
  const chatId = await seedLinearChat(page, {
    messageCount: totalCount,
    chatId: 'render-window-chat',
    title: 'Render window chat',
    textForIndex: (index) =>
      index === totalCount - 1
        ? `${'x'.repeat(200_000)} very-long destination ${totalCount - 1}`
        : `${'x'.repeat(index % 4 === 0 ? 4_000 : 400)} very-long history ${index}`,
    settings: {
      'global:message-initial-render-work': initialRenderWork,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const initialCount = await assertDestinationFirstPassiveFill(page, {
    destinationText: `very-long destination ${totalCount - 1}`,
    initialRenderWork,
    totalCount,
  })
  expect(initialCount).toBeLessThan(totalCount)

  await pinScrollRegionAtTop(page)
  let renderedCount = initialCount
  const prependDeltas: number[] = []
  while (renderedCount < totalCount) {
    const result = await loadOlderPreservingVisibleAnchor(page, renderedCount)
    renderedCount = result.renderedCount
    prependDeltas.push(result.anchorDelta)
  }
  expect(prependDeltas.length).toBeGreaterThanOrEqual(4)
  expect(Math.max(...prependDeltas)).toBeLessThan(2)
  await expect(page.locator('[data-ui="message"]')).toHaveCount(totalCount)
  await expect(page.locator('[data-ui="load-more-messages"]')).toHaveCount(0)
  const expectedUrl = page.url()
  const messageList = page.locator('[data-ui="message-list"]')
  const terminal = page.locator('[data-ui="message"]').last()
  const terminalMessageId = await terminal.getAttribute('data-message-id')
  if (!terminalMessageId) throw new Error('ResidentWindowTerminalMessageIdMissing')
  await page.locator('[data-ui="jump-to-latest"]').click()
  const scrollRegion = page.locator('[data-ui="scroll-region"]')
  await expect(scrollRegion).toHaveAttribute('data-scroll-state', 'follow')
  await expect.poll(() => scrollDistanceFromBottom(scrollRegion)).toBeLessThanOrEqual(2)
  await messageList.evaluate((element) => {
    ;(element as HTMLElement & { retainedAcrossSurfaceCycles?: true }).retainedAcrossSurfaceCycles =
      true
  })
  await terminal.evaluate((element) => {
    ;(element as HTMLElement & { retainedAcrossSurfaceCycles?: true }).retainedAcrossSurfaceCycles =
      true
  })
  const journeyProfile = createChatUiJourneyProfile()
  const transcriptJourney = journeyProfile.transcript
  if (!transcriptJourney) throw new Error('ResidentWindowTranscriptJourneyMissing')
  await uiJourney.start(
    page,
    {
      ...journeyProfile,
      countSurfaces: [],
      semanticNodes: [
        ...(journeyProfile.semanticNodes ?? []),
        {
          id: 'resident-transcript-list',
          selector: '[data-ui="message-list"]',
          preserveIdentity: true,
          requireVisible: false,
          resetOnRouteChange: false,
        },
        {
          id: 'resident-terminal-message',
          selector: `[data-ui="message"][data-message-id="${terminalMessageId}"]`,
          preserveIdentity: true,
          requireVisible: false,
          attributes: {
            'data-message-id': { kind: 'exact', value: terminalMessageId },
          },
          resetOnRouteChange: false,
        },
      ],
      transcript: {
        ...transcriptJourney,
        preservePrefix: false,
      },
    },
    'resident-transcript-surface-cycles',
  )
  const surfaceCycles: Array<{
    cycle: number
    hiddenRenderedCount: number
    returnedBottomDistance: number
  }> = []
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    await uiJourney.intent(page, {
      kind: 'follow-bottom',
      id: `resident-open-tree-scroll-${cycle}`,
      scrollSelector: '[data-ui="scroll-region"]',
      tolerancePx: 4,
    })
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: `resident-open-tree-${cycle}`,
      targetSelector: '[data-role="chat-branch-tree"]',
      outcome: { selector: '[data-ui="branch-tree-view"]' },
    })
    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
    await expect(messageList).toHaveAttribute('data-presentation-only', 'true')
    await expect(messageList).toHaveAttribute('data-rendered-count', String(initialRenderWork))
    await expect(messageList.locator('[data-ui="message"]')).toHaveCount(initialRenderWork)
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${terminalMessageId}"]`),
    ).toHaveCount(1)
    await uiJourney.checkpoint(page, `resident-tree-${cycle}`)
    await expect(page).toHaveURL(expectedUrl)

    await uiJourney.intent(page, {
      kind: 'acquire-bottom',
      id: `resident-return-scroll-${cycle}`,
      scrollSelector: '[data-ui="scroll-region"]',
      tolerancePx: 4,
    })
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: `resident-return-transcript-${cycle}`,
      targetSelector: '[data-role="chat-branch-tree"]',
      outcome: { selector: '[data-ui="message-list"]' },
    })
    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(messageList).toBeVisible()
    await expect(messageList).not.toHaveAttribute('data-presentation-only', 'true')
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${terminalMessageId}"]`),
    ).toBeVisible()
    expect(
      await messageList.evaluate(
        (element) =>
          (element as HTMLElement & { retainedAcrossSurfaceCycles?: true })
            .retainedAcrossSurfaceCycles === true,
      ),
    ).toBe(true)
    expect(
      await page
        .locator(`[data-ui="message"][data-message-id="${terminalMessageId}"]`)
        .evaluate(
          (element) =>
            (element as HTMLElement & { retainedAcrossSurfaceCycles?: true })
              .retainedAcrossSurfaceCycles === true,
        ),
    ).toBe(true)
    await expect(scrollRegion).toHaveAttribute('data-scroll-state', 'follow')
    await expect.poll(() => scrollDistanceFromBottom(scrollRegion)).toBeLessThanOrEqual(4)
    await uiJourney.checkpoint(page, `resident-transcript-${cycle}`)
    await expect(page).toHaveURL(expectedUrl)
    surfaceCycles.push({
      cycle,
      hiddenRenderedCount: initialRenderWork,
      returnedBottomDistance: await scrollDistanceFromBottom(scrollRegion),
    })
  }
  await uiJourney.finish(page, 'resident-transcript-surface-cycles-finished')
  const passiveProbe = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __destinationFirstProbe?: {
          counts: number[]
          destinationObservedAt: number | null
          floorObservedAt: number | null
        }
      }
    ).__destinationFirstProbe
    return state
      ? {
          counts: state.counts,
          destinationObservedAt: state.destinationObservedAt,
          floorObservedAt: state.floorObservedAt,
        }
      : null
  })
  await testInfo.attach('manual-prepend-geometry.json', {
    body: JSON.stringify({ initialCount, passiveProbe, prependDeltas, surfaceCycles }, null, 2),
    contentType: 'application/json',
  })
  await testInfo.attach('fully-loaded-long-transcript.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
})

test('progressive static handoff preserves bottom follow and a pinned semantic edge', async ({
  page,
}, testInfo) => {
  await installYieldGate(page)
  const paragraph = (index: number) => `progressive paragraph ${index} ${'x'.repeat(180)}`
  const hugeStaticMessage = Array.from({ length: 700 }, (_, index) => paragraph(index)).join('\n\n')
  const chatId = await seedLinearChat(page, {
    messageCount: 4,
    chatId: 'progressive-static-geometry-chat',
    title: 'Progressive static geometry chat',
    textForIndex: (index) =>
      index === 1 ? hugeStaticMessage : `progressive static surrounding message ${index}`,
    assistantContentType: 'output_text',
    settings: {
      'global:message-initial-render-work': 4,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.setViewportSize({ width: 1280, height: 420 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const region = page.locator('[data-ui="scroll-region"]')
  const progressive = page.locator('[data-overflow="progressive-static"]').first()
  await expect(progressive).toBeVisible()
  await expect(region).toHaveAttribute('data-scroll-state', 'follow')
  await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(2)
  const followBefore = await scrollMetrics(region)
  const followMessageId = await progressive.evaluate((element) => {
    const message = element.closest<HTMLElement>('[data-ui="message"][data-message-id]')
    if (!message) throw new Error('ProgressiveStaticFollowMessageMissing')
    ;(
      element as HTMLElement & { retainedAcrossProgressiveHandoff?: true }
    ).retainedAcrossProgressiveHandoff = true
    return message.dataset.messageId
  })
  if (!followMessageId) throw new Error('ProgressiveStaticFollowMessageIdMissing')
  await releaseYieldGate(page)
  await expect(page.locator('[data-overflow="progressive-static"]')).toHaveCount(0)
  await expect(region).toHaveAttribute('data-scroll-state', 'follow')
  await expect.poll(() => scrollDistanceFromBottom(region)).toBeLessThanOrEqual(2)
  const followAfter = await scrollMetrics(region)
  expect(
    await page
      .locator(`[data-ui="message"][data-message-id="${followMessageId}"] [data-ui="markdown"]`)
      .evaluate(
        (element) =>
          (element as HTMLElement & { retainedAcrossProgressiveHandoff?: true })
            .retainedAcrossProgressiveHandoff === true,
      ),
  ).toBe(true)

  await page.reload()
  const pinnedProgressive = page.locator('[data-overflow="progressive-static"]').first()
  await expect(pinnedProgressive).toBeVisible()
  const pinnedBefore = await pinnedProgressive.evaluate((element) => {
    const scrollRegion = element.closest<HTMLElement>('[data-ui="scroll-region"]')
    const message = element.closest<HTMLElement>('[data-ui="message"][data-message-id]')
    if (!scrollRegion || !message) throw new Error('ProgressiveStaticPinnedAnchorMissing')
    const containerRect = scrollRegion.getBoundingClientRect()
    const rootRect = element.getBoundingClientRect()
    const desiredBottom = containerRect.bottom - 80
    scrollRegion.scrollTop += rootRect.bottom - desiredBottom
    ;(
      element as HTMLElement & { retainedAcrossProgressiveHandoff?: true }
    ).retainedAcrossProgressiveHandoff = true
    return {
      messageId: message.getAttribute('data-message-id'),
      rootBottomOffset: element.getBoundingClientRect().bottom - containerRect.bottom,
      scrollTop: scrollRegion.scrollTop,
    }
  })
  expect(pinnedBefore.messageId).not.toBeNull()
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
  await releaseYieldGate(page)
  await expect(page.locator('[data-overflow="progressive-static"]')).toHaveCount(0)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
  const pinnedAfter = await page
    .locator(
      `[data-ui="message"][data-message-id="${pinnedBefore.messageId}"] [data-ui="markdown"]`,
    )
    .evaluate((element) => {
      const scrollRegion = element.closest<HTMLElement>('[data-ui="scroll-region"]')
      const message = element.closest<HTMLElement>('[data-ui="message"][data-message-id]')
      if (!scrollRegion || !message) throw new Error('ProgressiveStaticPinnedResultMissing')
      return {
        messageId: message.getAttribute('data-message-id'),
        retained:
          (element as HTMLElement & { retainedAcrossProgressiveHandoff?: true })
            .retainedAcrossProgressiveHandoff === true,
        rootBottomOffset:
          element.getBoundingClientRect().bottom - scrollRegion.getBoundingClientRect().bottom,
        scrollTop: scrollRegion.scrollTop,
      }
    })
  expect(pinnedAfter.messageId).toBe(pinnedBefore.messageId)
  expect(pinnedAfter.retained).toBe(true)
  expect(Math.abs(pinnedAfter.rootBottomOffset - pinnedBefore.rootBottomOffset)).toBeLessThan(2)
  await testInfo.attach('progressive-static-geometry.json', {
    body: JSON.stringify(
      {
        followBefore,
        followAfter,
        followBottomDistanceDelta: Math.abs(
          followAfter.distanceFromBottom - followBefore.distanceFromBottom,
        ),
        pinnedBefore,
        pinnedAfter,
        pinnedRootBottomDelta: Math.abs(
          pinnedAfter.rootBottomOffset - pinnedBefore.rootBottomOffset,
        ),
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
  await testInfo.attach('progressive-static-pinned.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
})

test('destination-first passive fill and repeated variable-height auto prepends preserve one viewport', async ({
  page,
  uiJourney,
}, testInfo) => {
  const initialRenderWork = 10
  const totalCount = 96
  await installDestinationFirstProbe(page, initialRenderWork)
  const chatId = await seedLinearChat(page, {
    messageCount: totalCount,
    chatId: 'render-window-auto-adjacent-chat',
    title: 'Auto adjacent render window chat',
    textForIndex: (index) =>
      index % 5 === 0
        ? `long history ${index}\n\n${'mixed-height line\n'.repeat(900)}`
        : `short history ${index}`,
    settings: {
      'global:message-initial-render-work': initialRenderWork,
      'global:message-render-window-load-mode': 'auto',
    },
  })

  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const initialCount = await assertDestinationFirstPassiveFill(page, {
    destinationText: `long history ${totalCount - 1}`,
    initialRenderWork,
    totalCount,
  })
  expect(initialCount).toBeLessThan(totalCount)
  const region = page.locator('[data-ui="scroll-region"]')
  const passiveGeometry = await page.evaluate(() => {
    const probe = (
      window as Window & {
        __destinationFirstProbe?: DestinationFirstProbeResult
      }
    ).__destinationFirstProbe
    if (!probe) throw new Error('DestinationFirstProbeMissing')
    return probe.geometry.filter((sample) => sample.scrollState === 'follow')
  })
  expect(passiveGeometry.length).toBeGreaterThan(0)
  expect(
    Math.max(...passiveGeometry.map((sample) => Math.abs(sample.bottomDistance))),
  ).toBeLessThan(3)

  await uiJourney.start(page, createChatUiJourneyProfile(), 'repeated-auto-prepend')
  const counts = [initialCount]
  const anchorDeltas: number[] = []
  let renderedCount = initialCount
  let prependIndex = 0
  while (renderedCount < totalCount) {
    const retainedId = await page
      .locator('[data-ui="message"]')
      .first()
      .getAttribute('data-message-id')
    if (!retainedId) throw new Error('AutoHistoryAnchorMissing')
    const retained = page.locator(`[data-ui="message"][data-message-id="${retainedId}"]`)
    const retainedTop = await retained.evaluate((element) => {
      const scrollRegion = element.closest<HTMLElement>('[data-ui="scroll-region"]')
      if (!scrollRegion) throw new Error('AutoHistoryScrollRegionMissing')
      scrollRegion.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
      scrollRegion.scrollTop = 0
      return element.getBoundingClientRect().top
    })
    await holdUpwardScrollIntentUntilWindowExpands(page, renderedCount)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
    await uiJourney.intent(page, {
      kind: 'prepend-anchor',
      id: `auto-prepend-${prependIndex}`,
      anchorSelector: `[data-ui="message"][data-message-id="${retainedId}"]`,
      scrollSelector: '[data-ui="scroll-region"]',
      tolerancePx: 2,
    })
    await expect
      .poll(() => page.locator('[data-ui="message"]').count())
      .toBeGreaterThan(renderedCount)
    const nextCount = await page.locator('[data-ui="message"]').count()
    await page
      .locator('[data-ui="message"]')
      .first()
      .evaluate(
        (element, height) => {
          const block = document.createElement('div')
          block.dataset.ui = 'arbitrary-history-height'
          block.style.height = `${height}px`
          element.append(block)
        },
        37 + (prependIndex % 5) * 29,
      )
    const journey = await uiJourney.checkpoint(page, `auto-prepend-${prependIndex}-remeasured`)
    expect(journey.violations).toEqual([])
    const anchorDelta = await retained.evaluate(
      (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
      retainedTop,
    )
    expect(anchorDelta).toBeLessThan(2)
    anchorDeltas.push(anchorDelta)
    counts.push(nextCount)
    renderedCount = nextCount
    prependIndex += 1
  }
  expect(anchorDeltas.length).toBeGreaterThanOrEqual(4)
  expect(Math.max(...anchorDeltas)).toBeLessThan(2)
  await expect(page.locator('[data-ui="message"]')).toHaveCount(totalCount)
  await expect(page.locator('[data-ui="load-more-messages"]')).toHaveCount(0)
  const finalJourney = await uiJourney.finish(page, 'repeated-auto-prepend-complete')
  expect(finalJourney.violations).toEqual([])
  await testInfo.attach('automatic-prepend-geometry.json', {
    body: JSON.stringify(
      {
        counts,
        anchorDeltas,
        passiveGeometry,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
})

test('manual prepend retains its viewport anchor across delayed layout above it', async ({
  page,
}, testInfo) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 20,
    chatId: 'render-window-delayed-layout-chat',
    title: 'Delayed layout chat',
    textPrefix: 'delayed layout message',
    settings: {
      'global:message-initial-render-work': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const initialCount = await waitForMessageFloor(page, 10)
  expect(initialCount).toBeLessThan(20)
  await pinScrollRegionAtTop(page)
  const retainedMessage = await firstMessageById(page)
  const retainedTop = await retainedMessage.evaluate(
    (element) => element.getBoundingClientRect().top,
  )

  await page.locator('[data-ui="load-more-messages"]').click()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(20)
  await page.waitForTimeout(250)
  await page
    .locator('[data-ui="message"]')
    .first()
    .evaluate((element) => {
      const delayedBlock = document.createElement('div')
      delayedBlock.dataset.testDelayedLayout = 'true'
      delayedBlock.style.height = '173px'
      element.append(delayedBlock)
    })

  await expect
    .poll(() =>
      retainedMessage.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        retainedTop,
      ),
    )
    .toBeLessThan(2)
  const delayedLayoutDelta = await retainedMessage.evaluate(
    (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
    retainedTop,
  )
  await testInfo.attach('delayed-layout-geometry.json', {
    body: JSON.stringify({ addedHeight: 173, anchorDelta: delayedLayoutDelta }, null, 2),
    contentType: 'application/json',
  })
})

test('user scrolling cancels delayed prepend-anchor corrections', async ({ page }) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 20,
    chatId: 'render-window-user-scroll-chat',
    title: 'User scroll chat',
    textPrefix: 'user scroll message',
    settings: {
      'global:message-initial-render-work': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const initialCount = await waitForMessageFloor(page, 10)
  expect(initialCount).toBeLessThan(20)
  const scrollRegion = await pinScrollRegionAtTop(page)
  const retainedMessage = await firstMessageById(page)
  const retainedTop = await retainedMessage.evaluate(
    (element) => element.getBoundingClientRect().top,
  )

  await page.locator('[data-ui="load-more-messages"]').click()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(20)
  const prependedMessage = page.locator('[data-ui="message"]').first()
  await prependedMessage.evaluate((element) => {
    const firstDelayedBlock = document.createElement('div')
    firstDelayedBlock.style.height = '61px'
    element.append(firstDelayedBlock)
  })
  await expect
    .poll(() =>
      retainedMessage.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        retainedTop,
      ),
    )
    .toBeLessThan(2)

  await scrollRegion.hover()
  const beforeUserScroll = await scrollRegion.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 47)
  await expect
    .poll(() => scrollRegion.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforeUserScroll)
  const userScrollTop = await scrollRegion.evaluate((element) => element.scrollTop)
  await prependedMessage.evaluate((element) => {
    const secondDelayedBlock = document.createElement('div')
    secondDelayedBlock.style.height = '127px'
    element.append(secondDelayedBlock)
  })
  await page.waitForTimeout(100)

  const afterDelayedLayout = await scrollRegion.evaluate((element) => element.scrollTop)
  expect(Math.abs(afterDelayedLayout - userScrollTop)).toBeLessThan(2)
})

async function pinScrollRegionAtTop(page: Page): Promise<Locator> {
  const scrollRegion = page.locator('[data-ui="scroll-region"]')
  await expect
    .poll(() =>
      scrollRegion.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1)
  expect(
    await scrollRegion.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeGreaterThan(0)
  await scrollRegion.dispatchEvent('wheel', { deltaY: -100 })
  await scrollRegion.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(scrollRegion).toHaveAttribute('data-scroll-state', 'pinned')
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeLessThan(1)
  return scrollRegion
}

async function holdUpwardScrollIntentUntilWindowExpands(
  page: Page,
  renderedCount: number,
): Promise<void> {
  await page.evaluate((currentCount) => {
    const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) throw new Error('AutoHistoryScrollRegionMissing')
    let remainingFrames = 600
    const hold = () => {
      if (
        remainingFrames <= 0 ||
        document.querySelectorAll('[data-ui="message"]').length > currentCount
      ) {
        return
      }
      remainingFrames -= 1
      region.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
      requestAnimationFrame(hold)
    }
    hold()
  }, renderedCount)
}

async function waitForMessageFloor(page: Page, minimum: number): Promise<number> {
  const messages = page.locator('[data-ui="message"]')
  await expect.poll(() => messages.count()).toBeGreaterThanOrEqual(minimum)
  return messages.count()
}

async function firstMessageById(page: Page): Promise<Locator> {
  const messageId = await page
    .locator('[data-ui="message"]')
    .first()
    .getAttribute('data-message-id')
  if (!messageId) throw new Error('initial transcript row has no message id')
  return page.locator(`[data-ui="message"][data-message-id="${messageId}"]`)
}

async function loadOlderPreservingVisibleAnchor(
  page: Page,
  previousCount: number,
): Promise<{ anchorDelta: number; renderedCount: number }> {
  const anchor = page.locator('[data-ui="message"][data-message-id]').filter({
    has: page.locator('[data-ui="message-body"]'),
  })
  const visibleAnchor = await anchor.evaluateAll((messages) => {
    const region = messages[0]?.closest<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) throw new Error('VisiblePrependAnchorScrollRegionMissing')
    const rootTop = region.getBoundingClientRect().top
    const element = messages.find((message) => message.getBoundingClientRect().bottom > rootTop)
    const id = element?.getAttribute('data-message-id')
    if (!element || !id) throw new Error('VisiblePrependAnchorMissing')
    ;(element as HTMLElement & { retainedAcrossPrepend?: true }).retainedAcrossPrepend = true
    return { id, top: element.getBoundingClientRect().top }
  })
  const retained = page.locator(`[data-ui="message"][data-message-id="${visibleAnchor.id}"]`)
  await page
    .locator('[data-ui="load-more-messages"]')
    .evaluate((element: HTMLElement) => element.click())
  await expect
    .poll(() => page.locator('[data-ui="message"]').count())
    .toBeGreaterThan(previousCount)
  const renderedCount = await page.locator('[data-ui="message"]').count()
  await expect(retained).toHaveCount(1)
  await expect
    .poll(() =>
      retained.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        visibleAnchor.top,
      ),
    )
    .toBeLessThan(2)
  expect(
    await retained.evaluate(
      (element) =>
        (element as HTMLElement & { retainedAcrossPrepend?: true }).retainedAcrossPrepend === true,
    ),
  ).toBe(true)
  return {
    anchorDelta: await retained.evaluate(
      (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
      visibleAnchor.top,
    ),
    renderedCount,
  }
}

interface DestinationFirstProbeMetrics {
  bottomDistance: number
  scrollState: string | null
  scrollTop: number
}

interface DestinationFirstProbeResult {
  counts: number[]
  destinationMessageId: string | null
  destinationObservedAt: number | null
  destinationStageAt: number | null
  destinationText: string | null
  floorObservedAt: number | null
  identityRetained: boolean
  initialMetrics: DestinationFirstProbeMetrics | null
  geometry: Array<DestinationFirstProbeMetrics & { event: string; at: number; count: number }>
}

async function installDestinationFirstProbe(page: Page, initialRenderWork: number): Promise<void> {
  await page.addInitScript((minimumRows) => {
    const win = window as typeof window & {
      __destinationFirstProbe?: {
        counts: number[]
        destination: Element | null
        destinationMessageId: string | null
        destinationObservedAt: number | null
        destinationStageAt: number | null
        destinationText: string | null
        floorObservedAt: number | null
        initialMetrics: DestinationFirstProbeMetrics | null
        geometry: Array<DestinationFirstProbeMetrics & { event: string; at: number; count: number }>
      }
    }
    const probe = {
      counts: [] as number[],
      destination: null as Element | null,
      destinationMessageId: null as string | null,
      destinationObservedAt: null as number | null,
      destinationStageAt: null as number | null,
      destinationText: null as string | null,
      floorObservedAt: null as number | null,
      initialMetrics: null as DestinationFirstProbeMetrics | null,
      geometry: [] as Array<
        DestinationFirstProbeMetrics & { event: string; at: number; count: number }
      >,
    }
    win.__destinationFirstProbe = probe
    let observedRegion: HTMLElement | null = null
    const captureGeometry = (event: string) => {
      const region = observedRegion
      if (!region || probe.geometry.length >= 120) return
      probe.geometry.push({
        event,
        at: performance.now(),
        count: document.querySelectorAll('[data-ui="message"][data-message-id]').length,
        bottomDistance: region.scrollHeight - region.scrollTop - region.clientHeight,
        scrollState: region.getAttribute('data-scroll-state'),
        scrollTop: region.scrollTop,
      })
    }
    const sample = () => {
      const list = document.querySelector('[data-ui="message-list"]')
      if (!list) return
      const messages = list.querySelectorAll('[data-ui="message"][data-message-id]')
      const count = messages.length
      probe.counts.push(count)
      captureGeometry('mutation')
      if (count >= minimumRows && probe.floorObservedAt === null) {
        probe.floorObservedAt = performance.now()
      }
      if (count !== 1 || probe.destination !== null) return
      const destination = messages.item(0)
      probe.destination = destination
      probe.destinationMessageId = destination.getAttribute('data-message-id')
      probe.destinationObservedAt = performance.now()
      probe.destinationText = destination.textContent
      const region = destination.closest<HTMLElement>('[data-ui="scroll-region"]')
      if (!region) return
      observedRegion = region
      region.addEventListener('scroll', () => captureGeometry('scroll'), { passive: true })
      const resizeObserver = new ResizeObserver(() => captureGeometry('resize'))
      resizeObserver.observe(region.querySelector('[data-ui="scroll-content"]') ?? region)
      probe.destinationStageAt = performance.now()
      probe.initialMetrics = {
        bottomDistance: region.scrollHeight - region.scrollTop - region.clientHeight,
        scrollState: region.getAttribute('data-scroll-state'),
        scrollTop: region.scrollTop,
      }
    }
    new MutationObserver(sample).observe(document, { childList: true, subtree: true })
  }, initialRenderWork)
}

async function assertDestinationFirstPassiveFill(
  page: Page,
  input: {
    destinationText: string
    initialRenderWork: number
    maximumInitialRenderedCount?: number
    totalCount: number
  },
): Promise<number> {
  const renderedCount = await waitForMessageFloor(page, input.initialRenderWork)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

  const probe = await page.evaluate((): DestinationFirstProbeResult => {
    const state = (
      window as typeof window & {
        __destinationFirstProbe?: {
          counts: number[]
          destination: Element | null
          destinationMessageId: string | null
          destinationObservedAt: number | null
          destinationStageAt: number | null
          destinationText: string | null
          floorObservedAt: number | null
          initialMetrics: DestinationFirstProbeMetrics | null
          geometry: Array<
            DestinationFirstProbeMetrics & { event: string; at: number; count: number }
          >
        }
      }
    ).__destinationFirstProbe
    if (!state) throw new Error('DestinationFirstProbeMissing')
    const current = Array.from(
      document.querySelectorAll('[data-ui="message"][data-message-id]'),
    ).find((message) => message.getAttribute('data-message-id') === state.destinationMessageId)
    return {
      counts: state.counts,
      destinationMessageId: state.destinationMessageId,
      destinationObservedAt: state.destinationObservedAt,
      destinationStageAt: state.destinationStageAt,
      destinationText: state.destinationText,
      floorObservedAt: state.floorObservedAt,
      identityRetained: current === state.destination,
      initialMetrics: state.initialMetrics,
      geometry: state.geometry,
    }
  })
  if (probe.destinationStageAt === null) {
    throw new Error(`DestinationFirstStageMissing:${JSON.stringify(probe)}`)
  }
  expect(probe.counts.find((count) => count > 0)).toBe(1)
  expect(probe.destinationObservedAt).not.toBeNull()
  expect(probe.destinationStageAt).not.toBeNull()
  expect(probe.floorObservedAt).not.toBeNull()
  expect(probe.destinationStageAt).toBeLessThan(probe.floorObservedAt as number)
  expect(probe.destinationText).toContain(input.destinationText)
  expect(probe.destinationMessageId).not.toBeNull()
  expect(probe.identityRetained).toBe(true)
  expect(probe.initialMetrics).not.toBeNull()

  const destination = page.locator(
    `[data-ui="message"][data-message-id="${probe.destinationMessageId as string}"]`,
  )
  await expect(destination.locator('[data-ui="message-body"]')).toContainText(input.destinationText)
  const finalMetrics = await destination.evaluate((element): DestinationFirstProbeMetrics => {
    const region = element.closest<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) throw new Error('DestinationScrollRegionMissing')
    return {
      bottomDistance: region.scrollHeight - region.scrollTop - region.clientHeight,
      scrollState: region.getAttribute('data-scroll-state'),
      scrollTop: region.scrollTop,
    }
  })
  expect((probe.initialMetrics as DestinationFirstProbeMetrics).scrollState).toBe('follow')
  expect(
    finalMetrics.scrollState,
    JSON.stringify({
      finalMetrics,
      probe: { ...probe, destinationText: probe.destinationText?.slice(-120) ?? null },
    }),
  ).toBe('follow')
  expect(Math.abs(finalMetrics.bottomDistance)).toBeLessThan(3)
  expect(finalMetrics.scrollTop).toBeGreaterThan(
    (probe.initialMetrics as DestinationFirstProbeMetrics).scrollTop,
  )
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
    'data-total-count',
    String(input.totalCount),
  )
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
    'data-rendered-count',
    String(renderedCount),
  )
  if (input.maximumInitialRenderedCount !== undefined) {
    expect(renderedCount).toBeLessThanOrEqual(input.maximumInitialRenderedCount)
    expect(await page.locator('[data-ui="message"][data-message-id]').count()).toBeLessThanOrEqual(
      input.maximumInitialRenderedCount,
    )
    expect(await page.locator('[data-ui="message-body"]').count()).toBeLessThanOrEqual(
      input.maximumInitialRenderedCount,
    )
  }
  return renderedCount
}

async function installYieldGate(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const callbacks = new Set<() => void>()
    const win = window as typeof window & {
      __releaseYieldGate?: () => void
      scheduler?: { yield?: () => Promise<void> }
    }
    Object.defineProperty(win, 'scheduler', {
      configurable: true,
      value: {
        yield: () =>
          new Promise<void>((resolve) => {
            callbacks.add(resolve)
          }),
      },
    })
    win.__releaseYieldGate = () => {
      const pending = [...callbacks]
      callbacks.clear()
      for (const resolve of pending) resolve()
    }
  })
}

async function releaseYieldGate(page: Page): Promise<void> {
  await page.evaluate(() => {
    const release = (window as typeof window & { __releaseYieldGate?: () => void })
      .__releaseYieldGate
    if (!release) throw new Error('YieldGateMissing')
    release()
  })
}

async function scrollMetrics(region: Locator): Promise<{
  distanceFromBottom: number
  scrollTop: number
  scrollHeight: number
}> {
  return region.evaluate((element) => ({
    distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
  }))
}

async function scrollDistanceFromBottom(region: Locator): Promise<number> {
  return region.evaluate(
    (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
  )
}

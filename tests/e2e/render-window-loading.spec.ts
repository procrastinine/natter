import {
  armDestinationFrameBudgetRecorder,
  assertDestinationFrameBudget,
  assertDestinationPublicationContract,
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

test('cold sidebar passive fill preserves visible text when reading starts before the floor', async ({
  page,
}, testInfo) => {
  const initialRenderWork = 10
  const totalCount = 48
  const destinationText = Array.from(
    { length: 240 },
    (_, index) => `cold sidebar destination paragraph ${index} ${'x'.repeat(72)}`,
  ).join('\n\n')
  const chatId = await seedLinearChat(page, {
    messageCount: totalCount,
    chatId: 'cold-sidebar-continuity-chat',
    title: 'Cold sidebar continuity chat',
    textForIndex: (index) =>
      index === totalCount - 1
        ? destinationText
        : `cold sidebar history ${index} ${'x'.repeat((index % 5) * 140)}`,
    settings: {
      'global:message-initial-render-work': initialRenderWork,
      'global:message-render-window-load-mode': 'auto',
    },
  })

  await page.goto('/#/new')
  await installColdSidebarReadingProbe(page, initialRenderWork)
  await page.setViewportSize({ width: 1280, height: 360 })
  await page.reload()
  await expect(page).toHaveURL(/#\/new$/u)
  const target = page.locator(`[data-ui="chat-row-link"][href="#/chat/${chatId}"]`)
  await expect(target).toBeVisible()
  await target.click()

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __coldSidebarReadingProbe?: { readingStartedAt: number | null }
            }
          ).__coldSidebarReadingProbe?.readingStartedAt ?? null,
      ),
    )
    .not.toBeNull()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __coldSidebarReadingProbe?: { anchor: SemanticTextAnchor | null }
            }
          ).__coldSidebarReadingProbe?.anchor ?? null,
      ),
    )
    .not.toBeNull()
  await expect.poll(() => page.locator('[data-ui="message"]').count()).toBeGreaterThanOrEqual(10)
  const probe = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __coldSidebarReadingProbe?: {
          pointObservedAt: number | null
          readingStartedAt: number | null
          floorObservedAt: number | null
          startAnchor: SemanticTextAnchor | null
          anchor: SemanticTextAnchor | null
          counts: number[]
        }
      }
    ).__coldSidebarReadingProbe
    return {
      pointObservedAt: state?.pointObservedAt ?? null,
      readingStartedAt: state?.readingStartedAt ?? null,
      floorObservedAt: state?.floorObservedAt ?? null,
      startAnchor: state?.startAnchor ?? null,
      anchor: state?.anchor ?? null,
      counts: state?.counts ?? [],
      renderedCount: document.querySelectorAll('[data-ui="message"][data-message-id]').length,
      scrollState: document
        .querySelector('[data-ui="scroll-region"]')
        ?.getAttribute('data-scroll-state'),
    }
  })
  expect(probe.pointObservedAt).not.toBeNull()
  expect(probe.readingStartedAt).not.toBeNull()
  expect(probe.floorObservedAt).not.toBeNull()
  expect(probe.readingStartedAt as number).toBeLessThan(probe.floorObservedAt as number)
  expect(probe.startAnchor).not.toBeNull()
  expect(probe.anchor?.paragraphKey).toContain('cold sidebar destination paragraph')
  expect(
    probe.startAnchor?.paragraphKey !== probe.anchor?.paragraphKey ||
      probe.startAnchor?.characterOffset !== probe.anchor?.characterOffset,
  ).toBe(true)
  expect(probe.scrollState).toBe('pinned')
  if (!probe.anchor) throw new Error('ColdSidebarSemanticAnchorMissing')
  const afterFill = await readSemanticTextAnchor(page, probe.anchor)
  expect(afterFill.messageId).toBe(probe.anchor.messageId)
  expect(afterFill.paragraphKey).toBe(probe.anchor.paragraphKey)
  expect(afterFill.characterOffset).toBe(probe.anchor.characterOffset)
  await testInfo.attach('cold-sidebar-fill-transition.json', {
    body: JSON.stringify({ probe, afterFill }, null, 2),
    contentType: 'application/json',
  })
  expect(Math.abs(afterFill.lineTop - probe.anchor.lineTop)).toBeLessThanOrEqual(2)

  const region = page.locator('[data-ui="scroll-region"]')
  await region.hover()
  await page.mouse.wheel(0, -1)
  await waitForNativeScrollSettle(page)
  const delayedAnchor = await captureVisibleSemanticTextAnchor(page)
  const delayedTextLayout = await page.evaluate((anchor) => {
    const message = document.querySelector<HTMLElement>(
      `[data-ui="message"][data-message-id="${anchor.messageId}"]`,
    )
    const paragraph = Array.from(
      message?.querySelectorAll<HTMLElement>('[data-ui="markdown"] p') ?? [],
    ).find((candidate) => candidate.textContent.startsWith(anchor.paragraphKey))
    const markdown = paragraph?.closest<HTMLElement>('[data-ui="markdown"]')
    if (!paragraph || !markdown) throw new Error('ColdSidebarDelayedAnchorMissing')
    const block = document.createElement('div')
    block.dataset.ui = 'delayed-text-layout'
    block.style.height = '137px'
    markdown.prepend(block)
    return { addedHeight: 137 }
  }, delayedAnchor)
  await expect
    .poll(async () =>
      Math.abs((await readSemanticTextAnchor(page, delayedAnchor)).lineTop - delayedAnchor.lineTop),
    )
    .toBeLessThanOrEqual(2)
  const afterDelayedLayout = await readSemanticTextAnchor(page, delayedAnchor)
  await testInfo.attach('cold-sidebar-passive-fill-continuity.json', {
    body: JSON.stringify(
      { ...probe, afterFill, delayedAnchor, delayedTextLayout, afterDelayedLayout },
      null,
      2,
    ),
    contentType: 'application/json',
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
  assertDestinationPublicationContract(snapshot, { point: 'required' })
  await expect(page).toHaveURL(new RegExp(`#/chat/${chatId}/message/${terminalMessageId}$`, 'u'))
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
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
    'data-rendered-count',
    String(totalCount),
  )
  expect(await page.locator('[data-ui="message"]').count()).toBeLessThan(totalCount)
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
          preserveIdentity: false,
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
  const pinnedMessageId = await pinnedProgressive.evaluate((element) => {
    const message = element.closest<HTMLElement>('[data-ui="message"][data-message-id]')
    if (!message) throw new Error('ProgressiveStaticPinnedAnchorMissing')
    ;(
      element as HTMLElement & { retainedAcrossProgressiveHandoff?: true }
    ).retainedAcrossProgressiveHandoff = true
    return message.getAttribute('data-message-id')
  })
  expect(pinnedMessageId).not.toBeNull()
  await region.hover()
  await page.mouse.wheel(0, -180)
  await waitForNativeScrollSettle(page)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
  const pinnedBefore = await captureVisibleSemanticTextAnchor(page)
  expect(pinnedBefore.messageId).toBe(pinnedMessageId)
  expect(pinnedBefore.paragraphKey).toContain('progressive paragraph')
  await releaseYieldGate(page)
  await expect(page.locator('[data-overflow="progressive-static"]')).toHaveCount(0)
  await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
  const pinnedAfter = await readSemanticTextAnchor(page, pinnedBefore)
  const retained = await page
    .locator(
      `[data-ui="message"][data-message-id="${pinnedBefore.messageId}"] [data-ui="markdown"]`,
    )
    .evaluate(
      (element) =>
        (element as HTMLElement & { retainedAcrossProgressiveHandoff?: true })
          .retainedAcrossProgressiveHandoff === true,
    )
  expect(pinnedAfter.messageId).toBe(pinnedBefore.messageId)
  expect(pinnedAfter.paragraphKey).toBe(pinnedBefore.paragraphKey)
  expect(pinnedAfter.characterOffset).toBe(pinnedBefore.characterOffset)
  expect(retained).toBe(true)
  await testInfo.attach('progressive-static-text-transition.json', {
    body: JSON.stringify({ pinnedBefore, pinnedAfter }, null, 2),
    contentType: 'application/json',
  })
  expect(Math.abs(pinnedAfter.lineTop - pinnedBefore.lineTop)).toBeLessThanOrEqual(2)
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
        pinnedTextDelta: Math.abs(pinnedAfter.lineTop - pinnedBefore.lineTop),
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
  test.setTimeout(120_000)
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

  const journeyProfile = createChatUiJourneyProfile()
  const transcriptJourney = journeyProfile.transcript
  if (!transcriptJourney) throw new Error('AutoPrependTranscriptJourneyMissing')
  const { boundedPrefixEviction: _boundedPrefixEviction, ...virtualTranscriptJourney } =
    transcriptJourney
  await uiJourney.start(
    page,
    {
      ...journeyProfile,
      countSurfaces: [],
      transcript: {
        ...virtualTranscriptJourney,
        preserveMessageIdentity: false,
        preservePrefix: false,
      },
      sampleLimit: 1_200,
      transitionLimit: 1_000,
    },
    'repeated-auto-prepend',
  )
  const counts = [initialCount]
  const anchorDeltas: number[] = []
  let renderedCount = initialCount
  let prependIndex = 0
  while (renderedCount < totalCount) {
    const boundary = await captureLoadedBoundaryAnchor(page, renderedCount)
    const retainedId = boundary.messageId
    const retained = page.locator(`[data-ui="message"][data-message-id="${retainedId}"]`)
    await expect(region).toHaveAttribute('data-scroll-state', 'pinned')
    await uiJourney.intent(page, {
      kind: 'prepend-anchor',
      id: `auto-prepend-${prependIndex}`,
      anchorSelector: '[data-scroll-anchor="history-demand"]',
      scrollSelector: '[data-ui="scroll-region"]',
      tolerancePx: 2,
    })
    await expect.poll(() => loadedMessageCount(page)).toBeGreaterThan(renderedCount)
    await expect(retained).toHaveCount(1)
    const nextCount = await loadedMessageCount(page)
    const prependJourney = await uiJourney.checkpoint(page, `auto-prepend-${prependIndex}-loaded`)
    expect(prependJourney.violations).toEqual([])
    const delayedAnchorSnapshot = await captureVisibleAutoHeightAnchor(page)
    const delayedAnchor = page.locator('[data-e2e-auto-height-anchor="true"]')
    const delayedHeight = 37 + (prependIndex % 5) * 29
    await delayedAnchor.evaluate((element, height) => {
      const message = element.closest<HTMLElement>('[data-ui="message"]')
      if (!message) throw new Error('AutoHistoryAnchorMessageMissing')
      const geometryOwner =
        message.closest<HTMLElement>('[data-ui="message-virtual-row"]') ?? message.parentElement
      if (!geometryOwner) throw new Error('AutoHistoryGeometryOwnerMissing')
      const initialHeight = geometryOwner.getBoundingClientRect().height
      return new Promise<void>((resolve) => {
        const observer = new ResizeObserver((entries) => {
          const entry = entries.find((candidate) => candidate.target === geometryOwner)
          const borderBox = entry?.borderBoxSize[0]?.blockSize
          const nextHeight = borderBox ?? entry?.contentRect.height ?? initialHeight
          if (nextHeight < initialHeight + height - 1) return
          observer.disconnect()
          resolve()
        })
        observer.observe(geometryOwner)
        const block = document.createElement('div')
        block.dataset.ui = 'arbitrary-history-height'
        block.style.height = `${height}px`
        message.parentElement?.insertBefore(block, message)
      })
    }, delayedHeight)
    await page.screenshot()
    const journey = await uiJourney.checkpoint(page, `auto-prepend-${prependIndex}-remeasured`)
    expect(journey.violations).toEqual([])
    const anchorDelta = await delayedAnchor.evaluate(
      (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
      delayedAnchorSnapshot.top,
    )
    expect(anchorDelta).toBeLessThanOrEqual(2)
    anchorDeltas.push(anchorDelta)
    counts.push(nextCount)
    renderedCount = nextCount
    prependIndex += 1
  }
  expect(anchorDeltas.length).toBeGreaterThan(1)
  expect(Math.max(...anchorDeltas)).toBeLessThanOrEqual(2)
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
    'data-rendered-count',
    String(totalCount),
  )
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-virtualized', 'true')
  expect(await page.locator('[data-ui="message"]').count()).toBeLessThan(totalCount)
  expect(await page.locator('[data-ui="message"]').count()).toBeLessThanOrEqual(32)
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

test('physical scrolling across 100k-character turns preserves text and constrained sticky glyphs through every expansion', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000)
  const initialRenderWork = 10
  const totalCount = 48
  const chatId = await seedLinearChat(page, {
    messageCount: totalCount,
    chatId: 'physical-100k-scroll-continuity-chat',
    title: 'Physical 100k scroll continuity chat',
    textForIndex: hundredKilobyteTurn,
    settings: {
      'global:message-initial-render-work': initialRenderWork,
      'global:message-render-window-load-mode': 'auto',
    },
  })

  await page.setViewportSize({ width: 1280, height: 500 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await waitForMessageFloor(page, initialRenderWork)
  await expect
    .poll(() =>
      page
        .locator('[data-ui="message"] [data-ui="markdown"]')
        .evaluateAll((elements) =>
          elements.reduce((total, element) => total + element.textContent.length, 0),
        ),
    )
    .toBeGreaterThanOrEqual(initialRenderWork * 99_000)
  await installNativeScrollContinuityProbe(page)

  const region = page.locator('[data-ui="scroll-region"]')
  await region.hover()
  const beforeExpansionSamples = []
  const settledWheelSamples = []
  for (let index = 0; index < 4; index += 1) {
    const sample = await wheelWithSettledTextContinuity(page, -180)
    settledWheelSamples.push(sample)
    beforeExpansionSamples.push(sample.settled)
  }

  let renderedCount = await loadedMessageCount(page)
  const reasonableSpeedExpansionRuns = []
  while (renderedCount < totalCount) {
    const run = await wheelAtReasonableSpeedUntilExpansion(page)
    reasonableSpeedExpansionRuns.push(run)
    renderedCount = await loadedMessageCount(page)
  }
  expect(renderedCount).toBe(totalCount)
  await expect.poll(() => nativeScrollExpansionCount(page)).toBeGreaterThanOrEqual(3)

  const afterExpansionSamples = []
  for (let index = 0; index < 4; index += 1) {
    const sample = await wheelWithSettledTextContinuity(page, 180)
    settledWheelSamples.push(sample)
    afterExpansionSamples.push(sample.settled)
  }

  const boundaryContinuity = await nativeScrollContinuityResult(page, true)
  await testInfo.attach('native-scroll-boundary-continuity.json', {
    body: JSON.stringify({ reasonableSpeedExpansionRuns, boundaryContinuity }, null, 2),
    contentType: 'application/json',
  })
  expect(boundaryContinuity.frameViolations).toEqual([])

  const glyphViolations: unknown[] = []
  const traversalSamples: unknown[] = []
  await region.evaluate((element) => {
    element.tabIndex = -1
    element.focus({ preventScroll: true })
  })
  await expect(region).toBeFocused()
  const inspectAfterKey = async (key: 'Home' | 'End' | 'PageUp' | 'PageDown') => {
    await page.keyboard.press(key)
    await waitForNativeScrollSettle(page)
    const result = await inspectProfileGlyphGeometry(page)
    traversalSamples.push({ key, ...result.sample })
    glyphViolations.push(...result.violations)
    return result.sample
  }
  const inspectUntilEdge = async (key: 'Home' | 'End', edge: 'atTop' | 'atBottom') => {
    let previousScrollTop: number | null = null
    let stalledGestures = 0
    for (;;) {
      const sample = await inspectAfterKey(key)
      if (sample[edge]) return sample
      stalledGestures =
        previousScrollTop !== null && Math.abs(sample.scrollTop - previousScrollTop) <= 0.5
          ? stalledGestures + 1
          : 0
      if (stalledGestures >= 3) {
        throw new Error(
          `PhysicalScrollEdgeMissing:${key}:${edge}:${JSON.stringify({ previousScrollTop, sample })}`,
        )
      }
      previousScrollTop = sample.scrollTop
    }
  }
  await inspectUntilEdge('Home', 'atTop')
  for (let step = 0; step < 4; step += 1) {
    await inspectAfterKey('PageDown')
  }
  await inspectUntilEdge('End', 'atBottom')
  for (let step = 0; step < 4; step += 1) {
    await inspectAfterKey('PageUp')
  }
  await inspectUntilEdge('Home', 'atTop')

  const continuity = await nativeScrollContinuityResult(page)
  await testInfo.attach('native-scroll-continuity.json', {
    body: JSON.stringify(
      {
        beforeExpansionSamples,
        afterExpansionSamples,
        settledWheelSamples,
        reasonableSpeedExpansionRuns,
        continuity,
        traversalSamples,
        glyphViolations,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
  await testInfo.attach('native-scroll-continuity.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  })
  expect(continuity.transitions.length).toBeGreaterThanOrEqual(3)
  expect(continuity.frameViolations).toEqual([])
  for (const transition of continuity.transitions) {
    expect(transition.before).not.toBeNull()
    expect(transition.after).not.toBeNull()
  }
  expect(glyphViolations).toEqual([])
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
  await expect.poll(() => loadedMessageCount(page)).toBe(20)
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

test('user scrolling rebases delayed prepend correction to the newly visible text', async ({
  page,
}) => {
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
  await expect.poll(() => loadedMessageCount(page)).toBe(20)
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
  const userAnchorTop = await retainedMessage.evaluate(
    (element) => element.getBoundingClientRect().top,
  )
  await prependedMessage.evaluate((element) => {
    const secondDelayedBlock = document.createElement('div')
    secondDelayedBlock.style.height = '127px'
    element.append(secondDelayedBlock)
  })
  await expect
    .poll(() =>
      retainedMessage.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        userAnchorTop,
      ),
    )
    .toBeLessThan(2)
})

interface SemanticTextAnchor {
  readonly messageId: string
  readonly paragraphKey: string
  readonly characterOffset: number
  readonly paragraphTop: number
  readonly lineTop: number
  readonly scrollTop: number
  readonly scrollHeight: number
}

async function captureVisibleSemanticTextAnchor(page: Page): Promise<SemanticTextAnchor> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) throw new Error('SemanticTextAnchorRegionMissing')
    const regionRect = region.getBoundingClientRect()
    const targetY = regionRect.top + regionRect.height * 0.46
    const body = document.querySelector<HTMLElement>('[data-ui="message-body-column"]')
    const x = body
      ? body.getBoundingClientRect().left + body.getBoundingClientRect().width / 2
      : regionRect.left + regionRect.width / 2
    const paragraphs = Array.from(
      region.querySelectorAll<HTMLElement>('[data-ui="message"] [data-ui="markdown"] p'),
    ).filter((paragraph) => {
      const rect = paragraph.getBoundingClientRect()
      return rect.bottom > regionRect.top && rect.top < regionRect.bottom
    })
    const paragraph =
      paragraphs.find((candidate) => {
        const rect = candidate.getBoundingClientRect()
        return rect.top <= targetY && rect.bottom >= targetY
      }) ??
      paragraphs.sort((left, right) => {
        const leftRect = left.getBoundingClientRect()
        const rightRect = right.getBoundingClientRect()
        return (
          Math.abs((leftRect.top + leftRect.bottom) / 2 - targetY) -
          Math.abs((rightRect.top + rightRect.bottom) / 2 - targetY)
        )
      })[0]
    const message = paragraph?.closest<HTMLElement>('[data-ui="message"][data-message-id]')
    const messageId = message?.dataset.messageId
    const paragraphKey = paragraph?.textContent.match(
      /^(?:progressive paragraph|cold sidebar destination paragraph) \d+/u,
    )?.[0]
    if (!paragraph || !messageId || !paragraphKey) {
      throw new Error('SemanticTextAnchorParagraphMissing')
    }
    const paragraphRect = paragraph.getBoundingClientRect()
    const caretY = Math.min(Math.max(targetY, paragraphRect.top + 1), paragraphRect.bottom - 1)
    const caret = document.caretRangeFromPoint(x, caretY)
    let characterOffset = 0
    if (caret && paragraph.contains(caret.startContainer)) {
      const prefix = document.createRange()
      prefix.selectNodeContents(paragraph)
      prefix.setEnd(caret.startContainer, caret.startOffset)
      characterOffset = prefix.toString().length
    }
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let remaining = characterOffset
    let lineTop = paragraphRect.top
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining > length) {
        remaining -= length
        continue
      }
      const start = Math.min(remaining, Math.max(0, length - 1))
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, Math.min(length, start + 1))
      lineTop = range.getClientRects()[0]?.top ?? paragraphRect.top
      break
    }
    return {
      messageId,
      paragraphKey,
      characterOffset,
      paragraphTop: paragraphRect.top,
      lineTop,
      scrollTop: region.scrollTop,
      scrollHeight: region.scrollHeight,
    }
  })
}

async function readSemanticTextAnchor(
  page: Page,
  anchor: SemanticTextAnchor,
): Promise<SemanticTextAnchor> {
  return page.evaluate((target) => {
    const message = document.querySelector<HTMLElement>(
      `[data-ui="message"][data-message-id="${target.messageId}"]`,
    )
    const paragraph = Array.from(
      message?.querySelectorAll<HTMLElement>('[data-ui="markdown"] p') ?? [],
    ).find((candidate) => candidate.textContent.startsWith(target.paragraphKey))
    if (!message || !paragraph) throw new Error('SemanticTextAnchorNoLongerRendered')
    const region = message.closest<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) throw new Error('SemanticTextAnchorRegionNoLongerRendered')
    const paragraphRect = paragraph.getBoundingClientRect()
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
    let remaining = target.characterOffset
    let lineTop = paragraphRect.top
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining > length) {
        remaining -= length
        continue
      }
      const start = Math.min(remaining, Math.max(0, length - 1))
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, Math.min(length, start + 1))
      lineTop = range.getClientRects()[0]?.top ?? paragraphRect.top
      break
    }
    return {
      messageId: target.messageId,
      paragraphKey: target.paragraphKey,
      characterOffset: target.characterOffset,
      paragraphTop: paragraphRect.top,
      lineTop,
      scrollTop: region.scrollTop,
      scrollHeight: region.scrollHeight,
    }
  }, anchor)
}

interface NativeScrollTextSample {
  readonly messageId: string
  readonly paragraphKey: string
  readonly messageOrdinal: number
  readonly paragraphOrdinal: number
  readonly messageCharacterOffset: number
  readonly characterOffset: number
  readonly paragraphTop: number
  readonly paragraphCharacterDensity: number
  readonly scrollTop: number
  readonly renderedCount: number
}

interface NativeScrollExpansionTransition {
  readonly fromCount: number
  readonly toCount: number
  readonly before: NativeScrollTextSample | null
  readonly after: NativeScrollTextSample | null
}

interface NativeScrollContinuityProbe {
  active: boolean
  readonly readSample: () => NativeScrollTextSample | null
  readonly transitions: NativeScrollExpansionTransition[]
  readonly frameViolations: Array<Record<string, unknown>>
}

function hundredKilobyteTurn(messageIndex: number): string {
  const paragraphs = Array.from({ length: 80 }, (_, paragraphIndex) => {
    const marker = `huge-scroll-row-${messageIndex}-paragraph-${paragraphIndex} `
    return `${marker}${'physical boundary continuity token '.repeat(34)}`
  })
  const text = paragraphs.join('\n\n')
  return text.length >= 100_000
    ? text.slice(0, 100_000)
    : `${text}${'x'.repeat(100_000 - text.length)}`
}

async function installNativeScrollContinuityProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    const list = document.querySelector<HTMLElement>('[data-ui="message-list"]')
    if (!region || !list) throw new Error('NativeScrollContinuitySurfaceMissing')
    const renderedCount = () => Number(list.dataset.renderedCount ?? '0')
    const readSample = (): NativeScrollTextSample | null => {
      const regionRect = region.getBoundingClientRect()
      const body = document.querySelector<HTMLElement>('[data-ui="message-body-column"]')
      const x = body
        ? body.getBoundingClientRect().left + body.getBoundingClientRect().width / 2
        : regionRect.left + regionRect.width / 2
      const targetY = regionRect.top + regionRect.height * 0.46
      const visibleParagraphs = Array.from(
        list.querySelectorAll<HTMLElement>('[data-ui="message"] [data-ui="markdown"] p'),
      ).filter((paragraph) => {
        const rect = paragraph.getBoundingClientRect()
        return rect.bottom > regionRect.top && rect.top < regionRect.bottom
      })
      const paragraph =
        visibleParagraphs.find((candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.top <= targetY && rect.bottom >= targetY
        }) ??
        visibleParagraphs.sort((left, right) => {
          const leftRect = left.getBoundingClientRect()
          const rightRect = right.getBoundingClientRect()
          const leftDistance = Math.abs((leftRect.top + leftRect.bottom) / 2 - targetY)
          const rightDistance = Math.abs((rightRect.top + rightRect.bottom) / 2 - targetY)
          return leftDistance - rightDistance
        })[0]
      if (!paragraph) return null
      const message = paragraph.closest<HTMLElement>('[data-ui="message"][data-message-id]')
      const messageId = message?.dataset.messageId
      const paragraphMatch = paragraph.textContent.match(
        /^(?:scroll-row|huge-scroll-row)-(\d+)-paragraph-(\d+)/u,
      )
      const paragraphKey = paragraphMatch?.[0]
      const messageOrdinal = Number(paragraphMatch?.[1])
      const paragraphOrdinal = Number(paragraphMatch?.[2])
      if (
        !messageId ||
        !paragraphKey ||
        !Number.isSafeInteger(messageOrdinal) ||
        !Number.isSafeInteger(paragraphOrdinal)
      ) {
        return null
      }
      const paragraphRect = paragraph.getBoundingClientRect()
      const caretY = Math.min(Math.max(targetY, paragraphRect.top + 1), paragraphRect.bottom - 1)
      const caret = document.caretRangeFromPoint(x, caretY)
      let characterOffset = 0
      let messageCharacterOffset = 0
      if (caret && paragraph.contains(caret.startContainer)) {
        const prefix = document.createRange()
        prefix.selectNodeContents(paragraph)
        prefix.setEnd(caret.startContainer, caret.startOffset)
        characterOffset = prefix.toString().length
        const markdown = paragraph.closest<HTMLElement>('[data-ui="markdown"]')
        if (markdown) {
          const messagePrefix = document.createRange()
          messagePrefix.selectNodeContents(markdown)
          messagePrefix.setEnd(caret.startContainer, caret.startOffset)
          messageCharacterOffset = messagePrefix.toString().length
        }
      }
      return {
        messageId,
        paragraphKey,
        messageOrdinal,
        paragraphOrdinal,
        messageCharacterOffset,
        characterOffset,
        paragraphTop: paragraphRect.top,
        paragraphCharacterDensity:
          paragraphRect.height > 0 ? paragraph.textContent.length / paragraphRect.height : 0,
        scrollTop: region.scrollTop,
        renderedCount: renderedCount(),
      }
    }
    const probe: NativeScrollContinuityProbe & {
      currentCount: number
      beforeExpansion: NativeScrollTextSample | null
    } = {
      active: true,
      readSample,
      transitions: [],
      frameViolations: [],
      currentCount: renderedCount(),
      beforeExpansion: readSample(),
    }
    ;(
      window as typeof window & {
        __nativeScrollContinuityProbe?: NativeScrollContinuityProbe
      }
    ).__nativeScrollContinuityProbe = probe
    let previousFrame = readSample()
    const monitorFrame = () => {
      if (!probe.active) return
      const nextFrame = readSample()
      if (previousFrame && nextFrame) {
        const previousPosition =
          previousFrame.messageOrdinal * 100_000 + previousFrame.messageCharacterOffset
        const nextPosition = nextFrame.messageOrdinal * 100_000 + nextFrame.messageCharacterOffset
        const semanticDelta = nextPosition - previousPosition
        const pixelDelta = nextFrame.scrollTop - previousFrame.scrollTop
        const characterDensity = Math.max(
          previousFrame.paragraphCharacterDensity,
          nextFrame.paragraphCharacterDensity,
        )
        const maximumNativeMovement = Math.abs(pixelDelta) * characterDensity * 2 + 1_024
        const directionReversed =
          Math.abs(semanticDelta) > 1_024 &&
          Math.abs(pixelDelta) > 0.5 &&
          Math.sign(semanticDelta) !== Math.sign(pixelDelta)
        if (directionReversed || Math.abs(semanticDelta) > maximumNativeMovement) {
          probe.frameViolations.push({
            kind: 'semantic-frame-jump',
            pixelDelta,
            semanticDelta,
            maximumNativeMovement,
            before: previousFrame,
            after: nextFrame,
          })
        }
      }
      previousFrame = nextFrame
      requestAnimationFrame(monitorFrame)
    }
    requestAnimationFrame(monitorFrame)
    region.addEventListener(
      'scroll',
      () => {
        if (renderedCount() !== probe.currentCount) return
        const sample = readSample()
        if (sample) probe.beforeExpansion = sample
      },
      { capture: true, passive: true },
    )
    new MutationObserver(() => {
      const nextCount = renderedCount()
      if (nextCount <= probe.currentCount) return
      const fromCount = probe.currentCount
      const before = probe.beforeExpansion
      probe.currentCount = nextCount
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          probe.transitions.push({
            fromCount,
            toCount: nextCount,
            before,
            after: readSample(),
          })
          probe.beforeExpansion = readSample()
        })
      })
    }).observe(list, { attributes: true, attributeFilter: ['data-rendered-count'] })
  })
}

async function nativeScrollTextSample(page: Page): Promise<NativeScrollTextSample | null> {
  return page.evaluate(() => {
    const probe = (
      window as typeof window & {
        __nativeScrollContinuityProbe?: NativeScrollContinuityProbe
      }
    ).__nativeScrollContinuityProbe
    if (!probe) throw new Error('NativeScrollContinuityProbeMissing')
    return probe.readSample()
  })
}

async function wheelWithSettledTextContinuity(
  page: Page,
  deltaY: number,
): Promise<{
  readonly deltaY: number
  readonly immediate: NativeScrollTextSample | null
  readonly settled: NativeScrollTextSample | null
}> {
  await page.mouse.wheel(0, deltaY)
  await waitForNativeScrollSettle(page)
  const immediate = await nativeScrollTextSample(page)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const settled = await nativeScrollTextSample(page)
  expect(immediate).not.toBeNull()
  expect(settled).not.toBeNull()
  expect(settled?.messageId).toBe(immediate?.messageId)
  expect(settled?.paragraphKey).toBe(immediate?.paragraphKey)
  expect(settled?.characterOffset).toBe(immediate?.characterOffset)
  expect(Math.abs((settled?.paragraphTop ?? 0) - (immediate?.paragraphTop ?? 0))).toBeLessThan(2)
  return { deltaY, immediate, settled }
}

async function wheelAtReasonableSpeedUntilExpansion(page: Page): Promise<{
  readonly fromCount: number
  readonly toCount: number
  readonly wheelEvents: number
}> {
  const region = page.locator('[data-ui="scroll-region"]')
  const fromCount = await loadedMessageCount(page)
  let toCount = fromCount
  let wheelEvents = 0
  let stalledBursts = 0
  while (toCount === fromCount) {
    const distanceFromRenderedTop = await region.evaluate((element) => element.scrollTop)
    const deltaY = distanceFromRenderedTop > 2_000 ? -20_000 : -2_000
    const burst = 16
    await Promise.all(Array.from({ length: burst }, () => page.mouse.wheel(0, deltaY)))
    wheelEvents += burst
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    toCount = await loadedMessageCount(page)
    const nextDistanceFromRenderedTop = await region.evaluate((element) => element.scrollTop)
    if (toCount === fromCount && nextDistanceFromRenderedTop <= 1) {
      await expect.poll(() => loadedMessageCount(page)).toBeGreaterThan(fromCount)
      toCount = await loadedMessageCount(page)
      break
    }
    stalledBursts =
      toCount === fromCount && nextDistanceFromRenderedTop >= distanceFromRenderedTop - 0.5
        ? stalledBursts + 1
        : 0
    if (stalledBursts >= 8) break
  }
  if (toCount <= fromCount) {
    const geometry = await region.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      scrollState: element.dataset.scrollState ?? null,
    }))
    throw new Error(
      `ReasonableSpeedExpansionMissing:${JSON.stringify({ fromCount, toCount, wheelEvents, geometry })}`,
    )
  }
  await waitForNativeScrollSettle(page)
  return { fromCount, toCount, wheelEvents }
}

async function waitForNativeScrollSettle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) throw new Error('NativeScrollSettleRegionMissing')
    let previous = region.scrollTop
    let stableFrames = 0
    for (let frame = 0; frame < 120 && stableFrames < 3; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      const current = region.scrollTop
      stableFrames = Math.abs(current - previous) <= 0.5 ? stableFrames + 1 : 0
      previous = current
    }
    if (stableFrames < 3) throw new Error('NativeScrollDidNotSettle')
  })
}

async function nativeScrollExpansionCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __nativeScrollContinuityProbe?: NativeScrollContinuityProbe
        }
      ).__nativeScrollContinuityProbe?.transitions.length ?? 0,
  )
}

async function nativeScrollContinuityResult(
  page: Page,
  stop = false,
): Promise<{
  transitions: NativeScrollExpansionTransition[]
  frameViolations: Array<Record<string, unknown>>
}> {
  return page.evaluate((shouldStop) => {
    const probe = (
      window as typeof window & {
        __nativeScrollContinuityProbe?: NativeScrollContinuityProbe
      }
    ).__nativeScrollContinuityProbe
    if (!probe) throw new Error('NativeScrollContinuityProbeMissing')
    if (shouldStop) probe.active = false
    return { transitions: probe.transitions, frameViolations: probe.frameViolations }
  }, stop)
}

async function inspectProfileGlyphGeometry(page: Page): Promise<{
  sample: {
    readonly scrollTop: number
    readonly atTop: boolean
    readonly atBottom: boolean
    readonly visibleMessageIds: string[]
    readonly visibleGlyphMessageIds: string[]
  }
  violations: Array<Record<string, unknown>>
}> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) throw new Error('ProfileGlyphScrollRegionMissing')
    const regionRect = region.getBoundingClientRect()
    const violations: Array<Record<string, unknown>> = []
    const visibleMessageIds: string[] = []
    const visibleGlyphMessageIds: string[] = []
    const visibleGlyphCenters: Array<{ messageId: string; x: number; y: number }> = []
    for (const message of document.querySelectorAll<HTMLElement>(
      '[data-ui="message"][data-message-id]',
    )) {
      const messageId = message.dataset.messageId ?? 'missing'
      const messageRect = message.getBoundingClientRect()
      const messageVisible =
        messageRect.bottom > regionRect.top && messageRect.top < regionRect.bottom
      if (messageVisible) visibleMessageIds.push(messageId)
      const glyphs = message.querySelectorAll<HTMLElement>(
        ':scope > [data-ui="profile-glyph-button"]',
      )
      if (glyphs.length !== 1) {
        violations.push({ kind: 'glyph-count', messageId, count: glyphs.length })
        continue
      }
      const glyphRect = glyphs[0]?.getBoundingClientRect()
      if (!glyphRect) continue
      const glyphVisible = glyphRect.bottom > regionRect.top && glyphRect.top < regionRect.bottom
      if (glyphVisible) {
        visibleGlyphMessageIds.push(messageId)
        visibleGlyphCenters.push({
          messageId,
          x: (glyphRect.left + glyphRect.right) / 2,
          y: (glyphRect.top + glyphRect.bottom) / 2,
        })
      }
      if (glyphVisible && !messageVisible) {
        violations.push({ kind: 'orphan-visible-glyph', messageId, messageRect, glyphRect })
      }
      if (
        glyphRect.left < messageRect.left - 1 ||
        glyphRect.right > messageRect.right + 1 ||
        glyphRect.top < messageRect.top - 1 ||
        glyphRect.bottom > messageRect.bottom + 1
      ) {
        violations.push({ kind: 'glyph-outside-message', messageId, messageRect, glyphRect })
      }
      const header = message.querySelector<HTMLElement>(':scope [data-ui="message-header"]')
      const headerRect = header?.getBoundingClientRect()
      if (
        messageVisible &&
        headerRect &&
        headerRect.bottom < regionRect.top &&
        messageRect.bottom > regionRect.top + glyphRect.height + 16 &&
        !glyphVisible
      ) {
        violations.push({ kind: 'missing-sticky-glyph', messageId, messageRect, glyphRect })
      }
      if (
        glyphVisible &&
        headerRect &&
        headerRect.bottom < regionRect.top &&
        messageRect.bottom > regionRect.top + glyphRect.height + 16 &&
        (glyphRect.top < regionRect.top - 1 || glyphRect.top > regionRect.top + 48)
      ) {
        violations.push({ kind: 'sticky-glyph-position', messageId, regionRect, glyphRect })
      }
      if (
        glyphVisible &&
        headerRect &&
        headerRect.top >= regionRect.top &&
        headerRect.bottom <= regionRect.bottom
      ) {
        const glyphCenter = (glyphRect.top + glyphRect.bottom) / 2
        const headerCenter = (headerRect.top + headerRect.bottom) / 2
        if (Math.abs(glyphCenter - headerCenter) >= 3) {
          violations.push({
            kind: 'glyph-header-misalignment',
            messageId,
            glyphCenter,
            headerCenter,
          })
        }
      }
    }
    for (let leftIndex = 0; leftIndex < visibleGlyphCenters.length; leftIndex += 1) {
      const left = visibleGlyphCenters[leftIndex]
      if (!left) continue
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < visibleGlyphCenters.length;
        rightIndex += 1
      ) {
        const right = visibleGlyphCenters[rightIndex]
        if (!right) continue
        if (Math.abs(left.x - right.x) < 2 && Math.abs(left.y - right.y) < 2) {
          violations.push({ kind: 'stacked-glyphs', left: left.messageId, right: right.messageId })
        }
      }
    }
    const maximumTop = Math.max(0, region.scrollHeight - region.clientHeight)
    return {
      sample: {
        scrollTop: region.scrollTop,
        atTop: region.scrollTop <= 1,
        atBottom: maximumTop - region.scrollTop <= 1,
        visibleMessageIds,
        visibleGlyphMessageIds,
      },
      violations,
    }
  })
}

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

async function captureLoadedBoundaryAnchor(
  page: Page,
  previousCount: number,
): Promise<{ messageId: string; top: number }> {
  const scrollRegion = page.locator('[data-ui="scroll-region"]')
  const list = page.locator('[data-ui="message-list"]')
  const previousRevision = await list.evaluate((element) =>
    Number(element.getAttribute('data-history-demand-revision') ?? '0'),
  )
  await scrollRegion.hover()
  let revision = previousRevision
  let wheelEvents = 0
  while (
    wheelEvents < 1_200 &&
    revision <= previousRevision &&
    (await loadedMessageCount(page)) <= previousCount
  ) {
    const distanceFromRenderedTop = await scrollRegion.evaluate((element) => element.scrollTop)
    const deltaY = distanceFromRenderedTop > 5_000 ? -4_000 : -320
    const burst = Math.min(4, 1_200 - wheelEvents)
    for (let index = 0; index < burst; index += 1) await page.mouse.wheel(0, deltaY)
    wheelEvents += burst
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    revision = await list.evaluate((element) =>
      Number(element.getAttribute('data-history-demand-revision') ?? '0'),
    )
  }
  await expect(scrollRegion).toHaveAttribute('data-scroll-state', 'pinned')
  if ((await loadedMessageCount(page)) <= previousCount) {
    expect(revision).toBeGreaterThan(previousRevision)
  }
  await expect.poll(() => list.getAttribute('data-history-demand-anchor-id')).not.toBeNull()
  return list.evaluate((element) => {
    const messageId = element.getAttribute('data-history-demand-anchor-id')
    const anchor = element.querySelector<HTMLElement>('[data-scroll-anchor="history-demand"]')
    if (!messageId || !anchor) {
      throw new Error('AutoHistoryBoundaryAnchorMissing')
    }
    return { messageId, top: anchor.getBoundingClientRect().top }
  })
}

async function captureVisibleAutoHeightAnchor(
  page: Page,
): Promise<{ readonly messageId: string; readonly top: number }> {
  return page.evaluate(() => {
    const region = document.querySelector<HTMLElement>('[data-ui="scroll-region"]')
    const content = region?.querySelector<HTMLElement>('[data-ui="scroll-content"]')
    if (!region || !content) throw new Error('AutoHistoryVisibleAnchorRegionMissing')
    for (const previous of content.querySelectorAll<HTMLElement>(
      '[data-e2e-auto-height-anchor="true"]',
    )) {
      previous.removeAttribute('data-e2e-auto-height-anchor')
    }
    const regionRect = region.getBoundingClientRect()
    const x = regionRect.left + regionRect.width / 2
    const candidates = [
      regionRect.top + 1,
      regionRect.top + regionRect.height * 0.46,
      regionRect.bottom - 1,
    ]
    let anchor: HTMLElement | null = null
    for (const y of candidates) {
      const hit = document.elementFromPoint(x, y)
      const message = hit?.closest<HTMLElement>('[data-ui="message"][data-message-id]')
      if (!message || !content.contains(message)) continue
      const element = hit instanceof HTMLElement ? hit : hit?.parentElement
      const block = element?.closest<HTMLElement>(
        'p, li, pre, blockquote, table, figcaption, [data-ui="reasoning-summary"], [data-ui="message-body"]',
      )
      anchor = block && message.contains(block) ? block : message
      break
    }
    if (!anchor) {
      anchor =
        Array.from(
          content.querySelectorAll<HTMLElement>('[data-ui="message"][data-message-id]'),
        ).find((message) => {
          const rect = message.getBoundingClientRect()
          return rect.bottom > regionRect.top && rect.top < regionRect.bottom
        }) ?? null
    }
    const message = anchor?.closest<HTMLElement>('[data-ui="message"][data-message-id]')
    const messageId = message?.dataset.messageId
    if (!anchor || !messageId) throw new Error('AutoHistoryVisibleAnchorMissing')
    anchor.dataset.e2eAutoHeightAnchor = 'true'
    return { messageId, top: anchor.getBoundingClientRect().top }
  })
}

async function waitForMessageFloor(page: Page, minimum: number): Promise<number> {
  await expect.poll(() => loadedMessageCount(page)).toBeGreaterThanOrEqual(minimum)
  return loadedMessageCount(page)
}

async function loadedMessageCount(page: Page): Promise<number> {
  return page.locator('[data-ui="message-list"]').evaluate((element) => {
    const value = Number((element as HTMLElement).dataset.renderedCount)
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('LoadedMessageCountInvalid')
    return value
  })
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
  const visibleAnchor = await page.locator('[data-ui="load-more-messages"]').evaluate((button) => {
    const list = button.closest<HTMLElement>('[data-ui="message-list"]')
    if (!list) throw new Error('VisiblePrependMessageListMissing')
    const region = list.closest<HTMLElement>('[data-ui="scroll-region"]')
    if (!region) throw new Error('VisiblePrependAnchorScrollRegionMissing')
    const regionRect = region.getBoundingClientRect()
    const x = regionRect.left + regionRect.width / 2
    const hit = [regionRect.top + 1, regionRect.top + regionRect.height / 2, regionRect.bottom - 1]
      .map((y) => document.elementFromPoint(x, y))
      .find((candidate) => candidate?.closest('[data-ui="message"]'))
    const message = hit?.closest<HTMLElement>('[data-ui="message"]')
    const textBlock = hit?.closest<HTMLElement>(
      'p, li, pre, blockquote, table, figcaption, [data-ui="reasoning-summary"], [data-ui="message-body"]',
    )
    const anchor = textBlock && message?.contains(textBlock) ? textBlock : message
    const id = message?.getAttribute('data-message-id') ?? null
    if (!anchor || !message || !list.contains(message) || !id) {
      throw new Error('VisiblePrependAnchorMissing')
    }
    for (const previous of list.querySelectorAll<HTMLElement>('[data-e2e-prepend-anchor]')) {
      previous.removeAttribute('data-e2e-prepend-anchor')
    }
    anchor.dataset.e2ePrependAnchor = 'true'
    ;(message as HTMLElement & { retainedAcrossPrepend?: true }).retainedAcrossPrepend = true
    ;(anchor as HTMLElement & { retainedAcrossPrepend?: true }).retainedAcrossPrepend = true
    const result = { id, top: anchor.getBoundingClientRect().top }
    ;(button as HTMLElement).click()
    return result
  })
  const retained = page.locator(`[data-ui="message"][data-message-id="${visibleAnchor.id}"]`)
  const retainedText = page.locator('[data-e2e-prepend-anchor="true"]')
  await expect.poll(() => loadedMessageCount(page)).toBeGreaterThan(previousCount)
  const renderedCount = await loadedMessageCount(page)
  await expect(retained).toHaveCount(1)
  await expect(retainedText).toHaveCount(1)
  await expect
    .poll(() =>
      retainedText.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        visibleAnchor.top,
      ),
    )
    .toBeLessThan(2)
  expect(
    await retainedText.evaluate(
      (element) =>
        (element as HTMLElement & { retainedAcrossPrepend?: true }).retainedAcrossPrepend === true,
    ),
  ).toBe(true)
  return {
    anchorDelta: await retainedText.evaluate(
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
  paintCounts: number[]
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
        paintCounts: number[]
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
      paintCounts: [] as number[],
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
    let paintFrame: number | null = null
    const samplePaint = () => {
      const count = document.querySelectorAll('[data-ui="message"][data-message-id]').length
      if (count > 0 && probe.paintCounts.at(-1) !== count) probe.paintCounts.push(count)
      if (count < minimumRows) paintFrame = requestAnimationFrame(samplePaint)
      else paintFrame = null
    }
    paintFrame = requestAnimationFrame(samplePaint)
    window.addEventListener(
      'pagehide',
      () => {
        if (paintFrame !== null) cancelAnimationFrame(paintFrame)
      },
      { once: true },
    )
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

async function installColdSidebarReadingProbe(
  page: Page,
  initialRenderWork: number,
): Promise<void> {
  await page.exposeBinding(
    '__coldSidebarNativeWheel',
    async (_source, point: { x: number; y: number }) => {
      await page.mouse.move(point.x, point.y)
      await page.mouse.wheel(0, -180)
    },
  )
  await page.addInitScript((minimumRows) => {
    const state = {
      pointObservedAt: null as number | null,
      readingStartedAt: null as number | null,
      floorObservedAt: null as number | null,
      startAnchor: null as SemanticTextAnchor | null,
      anchor: null as SemanticTextAnchor | null,
      counts: [] as number[],
      wheelRequested: false,
    }
    ;(
      window as typeof window & {
        __coldSidebarReadingProbe?: typeof state
      }
    ).__coldSidebarReadingProbe = state
    let observedRegion: HTMLElement | null = null
    let resizeObserver: ResizeObserver | null = null
    const captureSemanticAnchor = (
      region: HTMLElement,
      message: HTMLElement,
    ): SemanticTextAnchor | null => {
      const regionRect = region.getBoundingClientRect()
      const targetY = regionRect.top + regionRect.height * 0.46
      const paragraphs = Array.from(
        message.querySelectorAll<HTMLElement>('[data-ui="markdown"] p'),
      ).filter((paragraph) => {
        const rect = paragraph.getBoundingClientRect()
        return rect.bottom > regionRect.top && rect.top < regionRect.bottom
      })
      const paragraph =
        paragraphs.find((candidate) => {
          const rect = candidate.getBoundingClientRect()
          return rect.top <= targetY && rect.bottom >= targetY
        }) ?? paragraphs[0]
      const messageId = message.dataset.messageId
      const paragraphKey = paragraph?.textContent.match(
        /^cold sidebar destination paragraph \d+/u,
      )?.[0]
      if (!paragraph || !messageId || !paragraphKey) return null
      const body = document.querySelector<HTMLElement>('[data-ui="message-body-column"]')
      const x = body
        ? body.getBoundingClientRect().left + body.getBoundingClientRect().width / 2
        : regionRect.left + regionRect.width / 2
      const paragraphRect = paragraph.getBoundingClientRect()
      const caretY = Math.min(Math.max(targetY, paragraphRect.top + 1), paragraphRect.bottom - 1)
      const caret = document.caretRangeFromPoint(x, caretY)
      let characterOffset = 0
      if (caret && paragraph.contains(caret.startContainer)) {
        const prefix = document.createRange()
        prefix.selectNodeContents(paragraph)
        prefix.setEnd(caret.startContainer, caret.startOffset)
        characterOffset = prefix.toString().length
      }
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      let remaining = characterOffset
      let lineTop = paragraphRect.top
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0
        if (remaining > length) {
          remaining -= length
          continue
        }
        const start = Math.min(remaining, Math.max(0, length - 1))
        const range = document.createRange()
        range.setStart(node, start)
        range.setEnd(node, Math.min(length, start + 1))
        lineTop = range.getClientRects()[0]?.top ?? paragraphRect.top
        break
      }
      return {
        messageId,
        paragraphKey,
        characterOffset,
        paragraphTop: paragraphRect.top,
        lineTop,
        scrollTop: region.scrollTop,
        scrollHeight: region.scrollHeight,
      }
    }
    const sample = () => {
      const messages = document.querySelectorAll<HTMLElement>(
        '[data-ui="message"][data-message-id]',
      )
      const count = messages.length
      if (count > 0 && state.counts.at(-1) !== count) state.counts.push(count)
      if (count >= minimumRows && state.floorObservedAt === null) {
        state.floorObservedAt = performance.now()
      }
      const list = document.querySelector<HTMLElement>(
        '[data-ui="message-list"][data-presentation-kind="point"]',
      )
      if (!list || count !== 1 || state.wheelRequested) return
      state.pointObservedAt ??= performance.now()
      const current = document.querySelectorAll<HTMLElement>('[data-ui="message"][data-message-id]')
      const region = current[0]?.closest<HTMLElement>('[data-ui="scroll-region"]')
      if (!region) return
      if (observedRegion !== region) {
        observedRegion?.removeEventListener('scroll', sample)
        resizeObserver?.disconnect()
        observedRegion = region
        region.addEventListener('scroll', sample, { passive: true })
        resizeObserver = new ResizeObserver(sample)
        resizeObserver.observe(region)
        resizeObserver.observe(region.querySelector('[data-ui="scroll-content"]') ?? region)
      }
      if (region.scrollHeight <= region.clientHeight + 120) return
      if (region.scrollTop <= 0.5) return
      const startAnchor = current[0] ? captureSemanticAnchor(region, current[0]) : null
      if (!startAnchor) return
      state.wheelRequested = true
      state.startAnchor = startAnchor
      let wheelDelivered = false
      const noteWheel = () => {
        wheelDelivered = true
        state.readingStartedAt = performance.now()
      }
      const captureReadingPosition = () => {
        if (!wheelDelivered || state.anchor !== null || !current[0]) return
        state.anchor = captureSemanticAnchor(region, current[0])
        if (!state.anchor) return
        region.removeEventListener('scroll', captureReadingPosition, true)
      }
      region.addEventListener('wheel', noteWheel, { capture: true, once: true, passive: true })
      region.addEventListener('scroll', captureReadingPosition, { capture: true, passive: true })
      const rect = region.getBoundingClientRect()
      const nativeWheel = (
        window as typeof window & {
          __coldSidebarNativeWheel?: (point: { x: number; y: number }) => Promise<void>
        }
      ).__coldSidebarNativeWheel
      if (!nativeWheel) throw new Error('ColdSidebarNativeWheelBindingMissing')
      void nativeWheel({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
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
          paintCounts: number[]
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
      paintCounts: state.paintCounts,
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
  const firstPresentedCount = probe.paintCounts.find((count) => count > 0)
  expect(firstPresentedCount).toBeDefined()
  expect(firstPresentedCount as number).toBeGreaterThanOrEqual(1)
  expect(firstPresentedCount as number).toBeLessThanOrEqual(
    input.maximumInitialRenderedCount ?? input.initialRenderWork,
  )
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

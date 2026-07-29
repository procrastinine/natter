import {
  createFakeStreamScenario,
  type FakeStreamScenarioSnapshot,
  retargetOnlyProfileToFakeProvider,
} from './fake-stream-provider'
import { createChatUiJourneyProfile, expect, type Page, test } from './fixtures'
import {
  clickSidebarToggleWithoutActionabilityWait,
  installReloadStorageAdministrationBlocker,
  releaseReloadStorageAdministrationBlocker,
  reloadStorageAdministrationBlockerState,
  startForegroundGestureRecorder,
} from './foreground-gesture'
import {
  activeWorkspaceDatabaseName,
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  holdIndexedDbStoreGate,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

test.describe.configure({ timeout: 60_000 })

test.beforeEach(async ({ page }) => {
  await mockOpenRouterDiscovery(page)
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('reactive storage survives lifecycle churn, abort, reload, and peer writes exactly', async ({
  page,
  uiJourney,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'reactive-seed', content: 'reactive seed reply', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'reactive seed prompt')
  await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
  const chatId = await firstChatId(page)
  await waitForAssistantGenerationFinished(page, chatId)

  const peer = await page.context().newPage()
  await peer.goto(new URL(`/#/chat/${chatId}`, page.url()).href)
  await expect(peer.locator('[data-ui="chat-title-label"]')).toHaveText('Untitled chat')
  const storageObserver = await page.context().newPage()
  await storageObserver.goto(new URL('/#/storage/chats', page.url()).href)
  await expect(storageObserver.locator('[data-ui="storage-chat-table"]')).toContainText(
    'Untitled chat',
  )
  const configurationObserver = await page.context().newPage()
  await configurationObserver.goto(new URL(`/#/chat/${chatId}`, page.url()).href)
  await configurationObserver.locator('[data-role="settings-cog"]').click()
  await configurationObserver.locator('[data-ui="settings-tab"][data-tab="prompts"]').click()
  const observedSystemPrompt = configurationObserver.locator('[data-ui="system-prompt-textarea"]')
  await expect(observedSystemPrompt).toHaveValue('')

  for (let cycle = 0; cycle < 16; cycle += 1) {
    await page.evaluate(() => {
      window.location.hash = '#/new'
    })
    await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('New chat')
    await page.evaluate((id) => {
      window.location.hash = `#/chat/${id}`
    }, chatId)
    await expect(page.locator('[data-ui="message"]')).toHaveCount(2)
  }

  await drainAuthoritativeWrites(page)
  await page.bringToFront()
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('remote catalog draft remains selected')
  await composer.focus()
  const journeyProfile = createChatUiJourneyProfile()
  await uiJourney.start(
    page,
    {
      ...journeyProfile,
      semanticNodes: [
        ...(journeyProfile.semanticNodes ?? []),
        {
          id: 'composer-draft',
          selector: '[data-ui="composer-input"]',
          properties: { value: { kind: 'stable' } },
          resetOnRouteChange: false,
        },
      ],
    },
    'remote-catalog-configuration-locality',
  )
  await uiJourney.intent(page, {
    kind: 'focus-continuity',
    id: 'remote-catalog-configuration-focus',
    selector: '[data-ui="composer-input"]',
    preserveSelection: true,
  })
  await uiJourney.intent(page, {
    kind: 'follow-bottom',
    id: 'remote-catalog-configuration-scroll',
  })
  await startTitleTransitionRecorder(page)
  const beforePeerTitles = await readReactiveState(page, chatId)
  const peerTitles = ['Peer title 1', 'Peer title 2', 'Peer title 3', 'Peer title 4']
  for (const title of peerTitles) {
    await commitTitle(peer, title)
    await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText(title)
  }
  expect(await stopTitleTransitionRecorder(page)).toEqual(peerTitles)
  await expect(storageObserver.locator('[data-ui="storage-chat-table"]')).toContainText(
    peerTitles.at(-1) ?? '',
  )
  const afterPeerTitles = await readReactiveState(page, chatId)
  expect(afterPeerTitles.metaVersion - beforePeerTitles.metaVersion).toBe(peerTitles.length)
  const beforeRemotePrompt = afterPeerTitles
  await peer.locator('[data-role="settings-cog"]').click()
  await peer.locator('[data-ui="settings-tab"][data-tab="prompts"]').click()
  await peer.locator('[data-ui="system-prompt-textarea"]').fill('Remote locality system prompt')
  await peer.locator('[data-role="settings-pane-close"]').click()
  await expect
    .poll(async () => (await readReactiveState(page, chatId)).systemPrompt)
    .toBe('Remote locality system prompt')
  const afterRemotePrompt = await readReactiveState(page, chatId)
  expect(afterRemotePrompt.metaVersion - beforeRemotePrompt.metaVersion).toBe(1)
  await expect(observedSystemPrompt).toHaveValue('Remote locality system prompt')
  await expect(composer).toHaveValue('remote catalog draft remains selected')
  await uiJourney.finish(page, 'remote-catalog-configuration-published')

  await page.bringToFront()
  await page.locator('[data-role="chat-title-edit"]').click()
  const concurrentTitle = page.locator('[data-ui="chat-title-editor"]')
  await concurrentTitle.fill('Concurrent title')
  const beforeConcurrentWrites = await readReactiveState(page, chatId)
  const releaseConcurrentWriteGate = await holdIndexedDbStoreGate(page, ['chats'])
  try {
    await concurrentTitle.press('Enter')
    await peer.bringToFront()
    await expect(concurrentTitle).toHaveCount(0)
    await peer.locator('[data-role="settings-cog"]').click()
    await peer.locator('[data-ui="settings-tab"][data-tab="prompts"]').click()
    await peer.locator('[data-ui="system-prompt-textarea"]').fill('Concurrent system prompt')
    await peer.locator('[data-role="settings-pane-close"]').click()
  } finally {
    await releaseConcurrentWriteGate()
  }
  await page.bringToFront()
  await expect(concurrentTitle).toHaveCount(0)
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Concurrent title')
  await expect
    .poll(async () => (await readReactiveState(page, chatId)).systemPrompt)
    .toBe('Concurrent system prompt')
  const afterConcurrentWrites = await readReactiveState(page, chatId)
  expect(afterConcurrentWrites.metaVersion - beforeConcurrentWrites.metaVersion).toBe(2)

  await peer.bringToFront()
  await peer.locator('[data-role="chat-title-edit"]').click()
  const reloadTitle = peer.locator('[data-ui="chat-title-editor"]')
  await reloadTitle.fill('Reload winner')
  const beforeReloadWrite = await readReactiveState(peer, chatId)
  await Promise.all([page.reload(), reloadTitle.press('Enter')])
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Reload winner')
  await drainAuthoritativeWrites(page)
  const afterReloadWrite = await readReactiveState(page, chatId)
  expect(afterReloadWrite.metaVersion - beforeReloadWrite.metaVersion).toBe(1)

  await peer.locator('[data-role="chat-title-edit"]').click()
  const unmountedTitle = peer.locator('[data-ui="chat-title-editor"]')
  await unmountedTitle.fill('Published after unmount')
  const beforeUnmountedWrite = await readReactiveState(page, chatId)
  await Promise.all([
    page.evaluate(() => {
      window.location.hash = '#/new'
    }),
    unmountedTitle.press('Enter'),
  ])
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('New chat')
  await expect(page.locator('[data-ui="message-list"]')).toHaveCount(0)
  await page.evaluate((id) => {
    window.location.hash = `#/chat/${id}`
  }, chatId)
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText('Published after unmount')
  const afterUnmountedWrite = await readReactiveState(page, chatId)
  expect(afterUnmountedWrite.metaVersion - beforeUnmountedWrite.metaVersion).toBe(1)

  let markAbortRequestSeen!: () => void
  const abortRequestSeen = new Promise<void>((resolve) => {
    markAbortRequestSeen = resolve
  })
  let releaseAbortResponse!: () => void
  const abortResponseGate = new Promise<void>((resolve) => {
    releaseAbortResponse = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markAbortRequestSeen()
    await abortResponseGate
    await route
      .fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([{ id: 'too-late', content: 'must not persist', finish: 'stop' }]),
      })
      .catch(() => {})
  })
  await page.bringToFront()
  await sendMessage(page, 'abort this reactive stream')
  await abortRequestSeen
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await page.locator('[data-ui="abort"]').click()
  releaseAbortResponse()
  await expect(page.locator('[data-ui="message-error"][data-role="abort"]')).toBeVisible()
  await expect
    .poll(async () => {
      const state = await readReactiveState(page, chatId)
      return { leases: state.streamLeaseCount, chunks: state.streamChunkCount }
    })
    .toEqual({ leases: 0, chunks: 0 })

  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(4)
  await drainAuthoritativeWrites(page)
  const finalState = await readReactiveState(page, chatId)
  expect(finalState.title).toBe('Published after unmount')
  expect(finalState.systemPrompt).toBe('Concurrent system prompt')
  expect(finalState.messages).toHaveLength(4)
  expect(finalState.messages.map((message) => message.role)).toEqual([
    'user',
    'assistant',
    'user',
    'assistant',
  ])
  expect(finalState.messages.at(-1)).toMatchObject({
    role: 'assistant',
    content: [{ type: 'output_text', text: '' }],
    abortReason: 'user',
  })
  expect(finalState.streamLeaseCount).toBe(0)
  expect(finalState.streamChunkCount).toBe(0)
  expect(finalState.metaVersion).toBe(afterUnmountedWrite.metaVersion)
  expect((await readReactiveState(page, chatId)).metaVersion).toBe(finalState.metaVersion)
  await Promise.all([peer.close(), storageObserver.close(), configurationObserver.close()])
})

test('visibility leaves the live workspace attached and the first foreground gesture exact', async ({
  page,
  uiJourney,
}, testInfo) => {
  testInfo.setTimeout(120_000)
  const scenario = await createFakeStreamScenario({
    targetChars: 8_192,
    reasoningChars: 0,
    chunkChars: 512,
    holdUntilReleased: true,
    delayMs: 80,
  })
  let peer: Page | undefined
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    await installIdleHandleProbe(page)
    await page.reload()
    await expect(page.locator('[data-ui="composer"]')).toBeVisible()
    const databaseName = await activeWorkspaceDatabaseName(page)
    await resetIdleHandleProbe(page)

    await createChatAndOpen(page)
    await sendMessage(page, 'keep this hidden stream alive')
    await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(1)
    await expect(page).toHaveURL(/#\/chat\/[^/]+\/message\//)
    const chatId = await page.evaluate(() => window.location.hash.split('/')[2] ?? '')
    peer = await page.context().newPage()
    await peer.goto(new URL('/', page.url()).href)
    await peer.locator(`[data-ui="sidebar"] a[href="#/chat/${chatId}"]`).click()
    await expect(peer.locator('[data-ui="chat-title-label"]')).toHaveText('Untitled chat')
    await expect
      .poll(async () => {
        const snapshot = await scenario.snapshot()
        return {
          activeStreams: snapshot.activeStreams,
          generationRequests: chatCompletionRequestCount(snapshot),
        }
      })
      .toEqual({ activeStreams: 1, generationRequests: 1 })
    await expect(page.locator('[data-ui="abort"]')).toBeVisible()
    await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute(
      'data-workspace-runtime-state',
      'RUNNING',
    )
    await page.bringToFront()
    if (testInfo.project.name === 'chromium-headed-visibility') {
      await requireNativeVisibilityPair(page, peer)
    } else {
      await expect.poll(() => page.evaluate(() => document.visibilityState)).toBe('visible')
    }
    await page.locator('[data-role="settings-cog"]').click()
    await page.locator('[data-ui="settings-tab"][data-tab="context"]').click()
    await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
    await expect(page.locator('[data-ui="settings-panel"]')).toHaveAttribute(
      'data-active-tab',
      'context',
    )
    const pageCursor = await page.evaluate(() => window.location.hash)
    const profile = createChatUiJourneyProfile()
    const shell = profile.shell
    if (!shell) throw new Error('ChatUiJourneyShellMissing')
    await uiJourney.start(
      page,
      {
        ...profile,
        shell: {
          ...shell,
          preserveIdentityAcrossVisibility: true,
        },
        semanticNodes: [
          ...(profile.semanticNodes ?? []),
          {
            id: 'active-transcript',
            selector: '[data-ui="message-list"]',
            preserveIdentity: true,
            preserveAcrossVisibility: true,
            requireVisible: true,
            resetOnRouteChange: false,
          },
          {
            id: 'connection-provider-logo',
            selector: '[data-ui="connection-provider-button"] svg',
            preserveIdentity: true,
            preserveAcrossVisibility: true,
            requireVisible: true,
            resetOnRouteChange: false,
          },
          {
            id: 'profile-glyph',
            selector: '[data-ui="profile-glyph"][data-role]',
            cardinality: 'keyed',
            keyAttribute: 'data-role',
            preserveKeys: true,
            preserveIdentity: true,
            preserveAcrossVisibility: true,
            requireVisible: true,
            resetOnRouteChange: false,
          },
          {
            id: 'chat-settings',
            selector: '[data-ui="chat-model-panel"]',
            preserveIdentity: true,
            preserveAcrossVisibility: true,
            requireVisible: true,
            resetOnRouteChange: false,
          },
          {
            id: 'chat-settings-tab',
            selector: '[data-ui="chat-model-panel"] [data-ui="settings-tab"][data-tab]',
            cardinality: 'keyed',
            keyAttribute: 'data-tab',
            preserveKeys: true,
            preserveIdentity: true,
            preserveAcrossVisibility: true,
            requireVisible: true,
            resetOnRouteChange: false,
          },
          {
            id: 'chat-settings-panel',
            selector: '[data-ui="chat-model-panel"] [data-ui="settings-panel"]',
            preserveIdentity: true,
            preserveAcrossVisibility: true,
            requireVisible: true,
            attributes: {
              'data-active-tab': { kind: 'exact', value: 'context' },
            },
            resetOnRouteChange: false,
          },
          {
            id: 'context-settings-body',
            selector:
              '[data-ui="chat-model-panel"] [data-ui="settings-section"][data-ui-section="context-control"]',
            preserveIdentity: true,
            preserveAcrossVisibility: true,
            requireVisible: true,
            resetOnRouteChange: false,
          },
        ],
      },
      'visibility-resume',
    )
    const baselineHandles = await databaseHandleCounts(page, databaseName)
    await rememberShellIdentity(page)
    await startRuntimeTransitionRecorder(page)

    const themes = ['light', 'dark', 'high-contrast'] as const
    for (const [themeIndex, theme] of themes.entries()) {
      await selectVisualContinuityTheme(page, theme)
      const baselinePaint = await readPaintedSurfaceFingerprints(page)
      const baselinePixels = await readPaintedSurfacePixels(page)
      expect(baselinePaint.theme).toBe(theme)
      await testInfo.attach(`baseline-${theme}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })

      await peer.bringToFront()
      if (testInfo.project.name === 'chromium-headed-visibility') {
        await requireNativeVisibilityPair(peer, page)
      } else {
        test.skip(
          (await page.evaluate(() => document.visibilityState)) !== 'hidden',
          'The attached browser does not expose native background-tab visibility transitions.',
        )
      }
      const initialSidebarState = await startForegroundGestureRecorder(page)
      const nextSidebarState = initialSidebarState === 'expanded' ? 'collapsed' : 'expanded'
      await uiJourney.intent(page, {
        kind: 'gesture',
        id: `first-foreground-sidebar-toggle-${theme}`,
        targetSelector: '[data-role="sidebar-toggle"]',
        expectedDeliveries: 1,
        outcome: {
          selector: '[data-ui="app-shell"]',
          attributes: {
            'data-sidebar': { kind: 'exact', value: nextSidebarState },
          },
        },
      })
      const hiddenTitle = `Remote while hidden ${theme}`
      await commitTitle(peer, hiddenTitle)
      await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText(hiddenTitle)
      expect(await page.evaluate(() => window.location.hash)).toBe(pageCursor)
      const hiddenScenario = await scenario.snapshot()
      expect(hiddenScenario.activeStreams).toBe(1)
      expect(chatCompletionRequestCount(hiddenScenario)).toBe(1)
      await expect(page.locator('[data-ui="abort"]')).toBeVisible()
      expect(await databaseHandleCounts(page, databaseName)).toEqual(baselineHandles)
      expect(await shellIdentityIsStable(page)).toBe(true)

      await page.bringToFront()
      if (testInfo.project.name === 'chromium-headed-visibility') {
        await requireNativeVisibilityPair(page, peer)
      }
      const gesture = await clickSidebarToggleWithoutActionabilityWait(page)
      expect(gesture).toMatchObject({
        clickCount: 1,
        sidebarTransitions: [nextSidebarState],
        shellIdentityStable: true,
        toggleIdentityStable: true,
        hitTargetWasToggle: true,
        openingStillPending: false,
        runtimeState: 'RUNNING',
      })
      if (
        gesture.visibleAt === null ||
        gesture.firstVisibleFrameAt === null ||
        gesture.clickAt === null ||
        gesture.outcomeAt === null
      ) {
        throw new Error('FirstForegroundGestureTimingMissing')
      }
      expect(gesture.clickAt - gesture.visibleAt).toBeLessThanOrEqual(250)
      expect(gesture.outcomeAt - gesture.visibleAt).toBeLessThanOrEqual(250)
      expect(gesture.firstVisibleFrameAt - gesture.visibleAt).toBeLessThanOrEqual(250)

      const foregroundPaint = await readPaintedSurfaceFingerprints(page)
      const foregroundPixels = await readPaintedSurfacePixels(page)
      expect(foregroundPaint).toEqual(baselinePaint)
      const pixelDiffs = await comparePaintedSurfacePixels(page, baselinePixels, foregroundPixels)
      for (const diff of Object.values(pixelDiffs)) {
        expect(diff.dimensionsMatch).toBe(true)
        expect(diff.meanChannelDelta).toBeLessThanOrEqual(2)
        expect(diff.changedPixelRatio).toBeLessThanOrEqual(0.25)
      }
      await testInfo.attach(`first-foreground-${theme}`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      })
      const firstFrame = await uiJourney.checkpoint(page, `first-foreground-frame-${theme}`)
      const firstResumeSample = firstFrame.samples
        .filter((sample) => sample.reasons.includes('visibility-resume'))
        .at(-1)
      expect(firstResumeSample).toBeDefined()
      expect(firstResumeSample?.shell?.visible).toBe(true)
      expect(Object.values(firstResumeSample?.controls ?? {})).not.toContain(null)
      expect(
        Object.values(firstResumeSample?.controls ?? {}).every(
          (control) => control?.visible === true,
        ),
      ).toBe(true)
      const firstResume = await uiJourney.checkpoint(page, `first-foreground-gesture-${themeIndex}`)
      expect(firstResume.violations).toEqual([])
      expect(
        firstResume.samples.some((sample) => sample.reasons.includes('visibility-resume')),
      ).toBe(true)
      expect(await page.evaluate(() => window.location.hash)).toBe(pageCursor)
      const resumedScenario = await scenario.snapshot()
      expect(resumedScenario.activeStreams).toBe(1)
      expect(chatCompletionRequestCount(resumedScenario)).toBe(1)
      expect(await databaseHandleCounts(page, databaseName)).toEqual(baselineHandles)
      if (nextSidebarState === 'collapsed') {
        await page.locator('[data-role="sidebar-toggle"]').click()
        await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute(
          'data-sidebar',
          'expanded',
        )
      }
    }

    await peer.bringToFront()
    await requireNativeVisibilityPair(peer, page)
    await peer.locator('[data-role="new-chat"]').click()
    await expect(peer).toHaveURL(/#\/new$/)
    await expect(peer.locator('[data-ui="chat-title-label"]')).toHaveText('New chat')
    await expect(peer.locator('[data-ui="abort"]')).toHaveCount(0)
    expect(await page.evaluate(() => window.location.hash)).toBe(pageCursor)

    await scenario.release()
    await expect
      .poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams), {
        timeout: 15_000,
      })
      .toBe(0)
    await expect
      .poll(() =>
        page
          .locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]')
          .last()
          .evaluate((node) => node.textContent.length),
      )
      .toBe(8_192)
    await page.bringToFront()
    await requireNativeVisibilityPair(page, peer)
    const finalJourney = await uiJourney.finish(page, 'stream-finished-after-resume')
    expect(finalJourney.violations).toEqual([])
    expect(
      finalJourney.samples.filter((sample) => sample.reasons.includes('visibility-resume')),
    ).toHaveLength(4)
    expect(await stopRuntimeTransitionRecorder(page)).toEqual([])
    expect(await databaseHandleCounts(page, databaseName)).toEqual(baselineHandles)
    expect(await shellIdentityIsStable(page)).toBe(true)
    expect(await page.evaluate(() => window.location.hash)).toBe(pageCursor)
    await expect(peer).toHaveURL(/#\/new$/)
    const finalScenario = await scenario.snapshot()
    expect(finalScenario.activeStreams).toBe(0)
    expect(chatCompletionRequestCount(finalScenario)).toBe(1)
  } finally {
    await peer?.close()
    await scenario.dispose()
  }
})

test('reload during an active stream keeps pure UI controls actionable within bounded latency while opening is pending', async ({
  page,
  uiJourney,
}) => {
  const scenario = await createFakeStreamScenario({
    targetChars: 4_096,
    reasoningChars: 0,
    chunkChars: 512,
    initialDelayMs: 15_000,
    delayMs: 80,
  })
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    await createChatAndOpen(page)
    await sendMessage(page, 'reload while this stream is active')
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(1)
    await expect(page.locator('[data-ui="abort"]')).toBeVisible()
    const hashBefore = await page.evaluate(() => window.location.hash)

    await installSeededReloadConfigurationProbe(page)
    await installReloadStorageAdministrationBlocker(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => {
        const state = (
          window as Window & {
            __reloadStorageAdministrationBlocker?: { acquired: boolean; released: boolean }
          }
        ).__reloadStorageAdministrationBlocker
        return (
          state?.acquired === true &&
          document.querySelector('[data-ui="workspace-bootstrap"][data-state="opening"]') !==
            null &&
          document.querySelector('[data-ui="app-shell"] [data-role="sidebar-toggle"]') !== null
        )
      },
      undefined,
      { timeout: 2_500 },
    )
    expect(await page.evaluate(() => window.location.hash)).toBe(hashBefore)
    await expect(page.locator('[data-ui="app-shell"]')).not.toHaveAttribute('inert', '')

    await uiJourney.start(page, createChatUiJourneyProfile(), 'active-stream-opening')
    const initialSidebarState = await startForegroundGestureRecorder(page)
    const nextSidebarState = initialSidebarState === 'expanded' ? 'collapsed' : 'expanded'
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: 'opening-sidebar-toggle',
      targetSelector: '[data-role="sidebar-toggle"]',
      expectedDeliveries: 1,
      outcome: {
        selector: '[data-ui="app-shell"]',
        attributes: {
          'data-sidebar': { kind: 'exact', value: nextSidebarState },
        },
      },
    })
    const gesture = await clickSidebarToggleWithoutActionabilityWait(page)
    expect(gesture).toMatchObject({
      clickCount: 1,
      sidebarTransitions: [nextSidebarState],
      shellIdentityStable: true,
      toggleIdentityStable: true,
      hitTargetWasToggle: true,
      openingStillPending: true,
      runtimeState: expect.any(String),
    })
    expect(gesture.clickAt).not.toBeNull()
    expect(gesture.outcomeAt).not.toBeNull()
    expect((gesture.outcomeAt as number) - (gesture.clickAt as number)).toBeLessThanOrEqual(50)
    const openingJourney = await uiJourney.checkpoint(page, 'opening-control-outcome')
    expect(openingJourney.violations).toEqual([])
    expect(await reloadStorageAdministrationBlockerState(page)).toEqual({
      acquired: true,
      released: false,
    })
    expect(await seededReloadFalseConnectionSamples(page)).toEqual([])

    await releaseReloadStorageAdministrationBlocker(page)
    await expect(page.locator('[data-ui="workspace-bootstrap"][data-state="opening"]')).toHaveCount(
      0,
    )
    await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute(
      'data-workspace-runtime-state',
      'RUNNING',
    )
    await expect(page.locator('[data-ui="connection-provider-button"]')).toBeVisible()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        }),
    )
    expect(await seededReloadFalseConnectionSamples(page)).toEqual([])
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(0)
  } finally {
    await releaseReloadStorageAdministrationBlocker(page).catch(() => {})
    await scenario.dispose()
  }
})

async function commitTitle(page: Page, title: string): Promise<void> {
  await page.bringToFront()
  await page.locator('[data-role="chat-title-edit"]').click()
  const editor = page.locator('[data-ui="chat-title-editor"]')
  await editor.fill(title)
  await editor.press('Enter')
  await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText(title)
}

function chatCompletionRequestCount(snapshot: FakeStreamScenarioSnapshot): number {
  return snapshot.requests.filter(
    (request) => request.method === 'POST' && request.path === '/chat/completions',
  ).length
}

interface IdleHandleProbe {
  closedDatabaseNames: string[]
  openedDatabaseRequests: Array<{ name: string; version: number | null }>
}

async function installIdleHandleProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe: IdleHandleProbe = {
      closedDatabaseNames: [],
      openedDatabaseRequests: [],
    }
    const open = IDBFactory.prototype.open
    IDBFactory.prototype.open = function openWithProbe(
      name: string,
      version?: number,
    ): IDBOpenDBRequest {
      probe.openedDatabaseRequests.push({ name, version: version ?? null })
      return version === undefined ? open.call(this, name) : open.call(this, name, version)
    }
    const close = IDBDatabase.prototype.close
    IDBDatabase.prototype.close = function closeWithProbe(): void {
      probe.closedDatabaseNames.push(this.name)
      close.call(this)
    }
    ;(
      window as typeof window & {
        __idleHandleProbe?: IdleHandleProbe
      }
    ).__idleHandleProbe = probe
  })
}

async function resetIdleHandleProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (
      window as typeof window & {
        __idleHandleProbe?: IdleHandleProbe
      }
    ).__idleHandleProbe
    if (!probe) throw new Error('IdleHandleProbeMissing')
    probe.closedDatabaseNames.length = 0
    probe.openedDatabaseRequests.length = 0
  })
}

async function databaseHandleCounts(
  page: Page,
  databaseName: string,
): Promise<{ closed: number; opened: number }> {
  return page.evaluate((name) => {
    const probe = (
      window as typeof window & {
        __idleHandleProbe?: IdleHandleProbe
      }
    ).__idleHandleProbe
    if (!probe) throw new Error('IdleHandleProbeMissing')
    return {
      closed: probe.closedDatabaseNames.filter((candidate) => candidate === name).length,
      opened: probe.openedDatabaseRequests.filter((candidate) => candidate.name === name).length,
    }
  }, databaseName)
}

async function rememberShellIdentity(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shell = document.querySelector('[data-ui="app-shell"]')
    if (!shell) throw new Error('AppShellMissing')
    ;(
      window as Window & {
        __rememberedAppShell?: Element
      }
    ).__rememberedAppShell = shell
  })
}

async function shellIdentityIsStable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const win = window as Window & {
      __rememberedAppShell?: Element
    }
    return (
      win.__rememberedAppShell !== undefined &&
      win.__rememberedAppShell === document.querySelector('[data-ui="app-shell"]')
    )
  })
}

interface SeededReloadConfigurationSample {
  source: 'frame' | 'mutation'
  runtimeState: string | null
  emptyConnectionActionCount: number
  providerControlCount: number
  noConnectionReason: string | null
}

async function installSeededReloadConfigurationProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const samples: SeededReloadConfigurationSample[] = []
    const win = window as Window & {
      __seededReloadConfigurationSamples?: SeededReloadConfigurationSample[]
    }
    win.__seededReloadConfigurationSamples = samples
    const capture = (source: SeededReloadConfigurationSample['source']) => {
      const shell = document.querySelector('[data-ui="app-shell"]')
      if (!shell) return
      samples.push({
        source,
        runtimeState: shell.getAttribute('data-workspace-runtime-state'),
        emptyConnectionActionCount: document.querySelectorAll('[data-ui="connection-empty-action"]')
          .length,
        providerControlCount: document.querySelectorAll('[data-ui="connection-provider-button"]')
          .length,
        noConnectionReason:
          document.querySelector('[data-ui="composer-disabled-reason"]')?.textContent ?? null,
      })
    }
    const observer = new MutationObserver(() => capture('mutation'))
    observer.observe(document, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    let frameCount = 0
    const captureFrame = () => {
      capture('frame')
      frameCount += 1
      if (frameCount < 240) requestAnimationFrame(captureFrame)
      else observer.disconnect()
    }
    requestAnimationFrame(captureFrame)
  })
}

async function seededReloadFalseConnectionSamples(
  page: Page,
): Promise<SeededReloadConfigurationSample[]> {
  return page.evaluate(() => {
    const samples = (
      window as Window & {
        __seededReloadConfigurationSamples?: SeededReloadConfigurationSample[]
      }
    ).__seededReloadConfigurationSamples
    if (!samples) throw new Error('SeededReloadConfigurationProbeMissing')
    return samples.filter(
      (sample) =>
        sample.emptyConnectionActionCount > 0 ||
        sample.noConnectionReason?.includes('Add a connection') === true,
    )
  })
}

async function mockOpenRouterDiscovery(page: Page): Promise<void> {
  const modelId = 'google/gemini-3.5-flash'
  const supportedParameters = ['provider', 'temperature', 'max_completion_tokens']
  const architecture = {
    input_modalities: ['text'],
    output_modalities: ['text'],
    tokenizer: 'gemini',
  }
  await page.context().route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: modelId,
            name: modelId,
            context_length: 131_072,
            architecture,
            pricing: { prompt: '0', completion: '0' },
            supported_parameters: supportedParameters,
          },
        ],
      }),
    })
  })
  await page.context().route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: modelId,
          name: modelId,
          context_length: 131_072,
          architecture,
          endpoints: [
            {
              provider_name: 'Natter',
              provider_slug: 'natter',
              supported_parameters: supportedParameters,
              context_length: 131_072,
              max_prompt_tokens: 131_072,
              max_completion_tokens: 4096,
              pricing: { prompt: '0', completion: '0' },
              data_policy: {
                training: false,
                trainingOpenRouter: false,
                retainsPrompts: false,
                canPublish: false,
                requiresUserIDs: false,
              },
            },
          ],
        },
      }),
    })
  })
}

async function selectVisualContinuityTheme(
  page: Page,
  theme: 'light' | 'dark' | 'high-contrast',
): Promise<void> {
  await page.locator('[data-ui="open-global-settings"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="appearance"]').click()
  await page.locator('[data-ui="theme-select"]').selectOption(theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await page.locator('[data-role="global-settings-close"]').click()
  await expect(page.locator('[data-ui="global-settings-modal"]')).toHaveCount(0)
}

async function requireNativeVisibilityPair(foreground: Page, background: Page): Promise<void> {
  await expect
    .poll(async () => ({
      foreground: await foreground.evaluate(() => document.visibilityState),
      background: await background.evaluate(() => document.visibilityState),
    }))
    .toEqual({ foreground: 'visible', background: 'hidden' })
}

async function readPaintedSurfaceFingerprints(page: Page): Promise<{
  theme: string | null
  providerLogo: string
  profileGlyphs: readonly string[]
  activeContextTab: string
  contextBody: {
    markup: string
    display: string
    visibility: string
    opacity: string
    width: number
    height: number
  }
}> {
  return page.evaluate(() => {
    const stableMarkup = (node: Element): string => {
      const clone = node.cloneNode(true) as Element
      for (const candidate of [clone, ...clone.querySelectorAll('[style]')]) {
        if (candidate.getAttribute('style')?.trim() === '') candidate.removeAttribute('style')
      }
      return clone.outerHTML
    }
    const requiredMarkup = (selector: string): string => {
      const node = document.querySelector(selector)
      if (!(node instanceof Element)) throw new Error(`PaintedSurfaceMissing:${selector}`)
      return stableMarkup(node)
    }
    const profileGlyphs = [...document.querySelectorAll('[data-ui="profile-glyph"][data-role]')]
      .filter((node) => ['assistant', 'user'].includes(node.getAttribute('data-role') ?? ''))
      .map((node) => `${node.getAttribute('data-role')}:${node.outerHTML}`)
      .sort()
    if (profileGlyphs.length !== 2) throw new Error('PaintedProfileGlyphCardinalityInvalid')
    const contextBody = document.querySelector(
      '[data-ui="chat-model-panel"] [data-ui="settings-section"][data-ui-section="context-control"]',
    )
    if (!(contextBody instanceof HTMLElement)) throw new Error('PaintedContextBodyMissing')
    const contextStyle = getComputedStyle(contextBody)
    const contextRect = contextBody.getBoundingClientRect()
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      providerLogo: requiredMarkup('[data-ui="connection-provider-button"] svg'),
      profileGlyphs,
      activeContextTab: requiredMarkup(
        '[data-ui="chat-model-panel"] [data-ui="settings-tab"][data-tab="context"][aria-selected="true"]',
      ),
      contextBody: {
        markup: stableMarkup(contextBody),
        display: contextStyle.display,
        visibility: contextStyle.visibility,
        opacity: contextStyle.opacity,
        width: contextRect.width,
        height: contextRect.height,
      },
    }
  })
}

async function readPaintedSurfacePixels(page: Page): Promise<Readonly<Record<string, string>>> {
  const surfaces = [
    ['provider', page.locator('[data-ui="connection-provider-button"] svg')],
    ['user', page.locator('[data-ui="profile-glyph"][data-role="user"]')],
    ['assistant', page.locator('[data-ui="profile-glyph"][data-role="assistant"]')],
    [
      'context-tab',
      page.locator(
        '[data-ui="chat-model-panel"] [data-ui="settings-tab"][data-tab="context"][aria-selected="true"]',
      ),
    ],
    [
      'context-body',
      page.locator(
        '[data-ui="chat-model-panel"] [data-ui="settings-section"][data-ui-section="context-control"]',
      ),
    ],
  ] as const
  const pixels: Record<string, string> = {}
  for (const [id, locator] of surfaces) {
    pixels[id] = (await locator.screenshot()).toString('base64')
  }
  return Object.freeze(pixels)
}

interface PaintedSurfacePixelDiff {
  dimensionsMatch: boolean
  changedPixelRatio: number
  meanChannelDelta: number
}

async function comparePaintedSurfacePixels(
  page: Page,
  baseline: Readonly<Record<string, string>>,
  current: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, PaintedSurfacePixelDiff>>> {
  return page.evaluate(
    async ({ before, after }) => {
      const decode = async (base64: string): Promise<HTMLImageElement> => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        return image
      }
      const capture = (image: HTMLImageElement): ImageData => {
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        if (!context) throw new Error('PaintedSurfacePixelContextMissing')
        context.drawImage(image, 0, 0)
        return context.getImageData(0, 0, canvas.width, canvas.height)
      }
      const result: Record<string, PaintedSurfacePixelDiff> = {}
      for (const [id, beforeBase64] of Object.entries(before)) {
        const afterBase64 = after[id]
        if (!afterBase64) throw new Error(`PaintedSurfacePixelMissing:${id}`)
        const [beforeImage, afterImage] = await Promise.all([
          decode(beforeBase64),
          decode(afterBase64),
        ])
        const dimensionsMatch =
          beforeImage.naturalWidth === afterImage.naturalWidth &&
          beforeImage.naturalHeight === afterImage.naturalHeight
        if (!dimensionsMatch) {
          result[id] = {
            dimensionsMatch: false,
            changedPixelRatio: 1,
            meanChannelDelta: 255,
          }
          continue
        }
        const beforePixels = capture(beforeImage).data
        const afterPixels = capture(afterImage).data
        let changedPixels = 0
        let totalChannelDelta = 0
        for (let offset = 0; offset < beforePixels.length; offset += 4) {
          let pixelDelta = 0
          for (let channel = 0; channel < 4; channel += 1) {
            const delta = Math.abs(
              (beforePixels[offset + channel] as number) -
                (afterPixels[offset + channel] as number),
            )
            pixelDelta = Math.max(pixelDelta, delta)
            totalChannelDelta += delta
          }
          if (pixelDelta > 8) changedPixels += 1
        }
        const pixelCount = beforePixels.length / 4
        result[id] = {
          dimensionsMatch: true,
          changedPixelRatio: changedPixels / pixelCount,
          meanChannelDelta: totalChannelDelta / beforePixels.length,
        }
      }
      return result
    },
    { before: baseline, after: current },
  )
}

async function drainAuthoritativeWrites(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.locks.request('workspace:authoritative', { mode: 'exclusive' }, () => undefined)
  })
}

async function startTitleTransitionRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const label = document.querySelector('[data-ui="chat-title-label"]')
    if (!label) throw new Error('chat title label missing')
    const win = window as Window & {
      __titleTransitions?: string[]
      __titleTransitionObserver?: MutationObserver
    }
    win.__titleTransitions = []
    win.__titleTransitionObserver?.disconnect()
    win.__titleTransitionObserver = new MutationObserver(() => {
      const title = label.textContent
      const transitions = win.__titleTransitions ?? []
      if (transitions.at(-1) !== title) transitions.push(title)
    })
    win.__titleTransitionObserver.observe(label, {
      childList: true,
      characterData: true,
      subtree: true,
    })
  })
}

async function stopTitleTransitionRecorder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as Window & {
      __titleTransitions?: string[]
      __titleTransitionObserver?: MutationObserver
    }
    win.__titleTransitionObserver?.disconnect()
    const transitions = win.__titleTransitions ?? []
    delete win.__titleTransitions
    delete win.__titleTransitionObserver
    return transitions
  })
}

async function startRuntimeTransitionRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shell = document.querySelector('[data-ui="app-shell"]')
    if (!shell) throw new Error('app shell missing')
    const win = window as Window & {
      __runtimeTransitions?: string[]
      __runtimeTransitionObserver?: MutationObserver
    }
    win.__runtimeTransitions = []
    win.__runtimeTransitionObserver?.disconnect()
    win.__runtimeTransitionObserver = new MutationObserver(() => {
      const state = shell.getAttribute('data-workspace-runtime-state')
      const transitions = win.__runtimeTransitions ?? []
      if (state && transitions.at(-1) !== state) transitions.push(state)
    })
    win.__runtimeTransitionObserver.observe(shell, {
      attributes: true,
      attributeFilter: ['data-workspace-runtime-state'],
    })
  })
}

async function stopRuntimeTransitionRecorder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const win = window as Window & {
      __runtimeTransitions?: string[]
      __runtimeTransitionObserver?: MutationObserver
    }
    win.__runtimeTransitionObserver?.disconnect()
    const transitions = win.__runtimeTransitions ?? []
    delete win.__runtimeTransitions
    delete win.__runtimeTransitionObserver
    return transitions
  })
}

async function readReactiveState(
  page: Page,
  chatId: string,
): Promise<{
  title: string
  systemPrompt: string | undefined
  metaVersion: number
  summaryVersion: number
  streamLeaseCount: number
  streamChunkCount: number
  messages: Array<{
    role: string
    content: unknown
    abortReason: string | undefined
  }>
}> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const readRow = (storeName: string, key: IDBValidKey) =>
        new Promise<unknown>((resolve, reject) => {
          const transaction = db.transaction(storeName, 'readonly')
          const request = transaction.objectStore(storeName).get(key)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      const readRows = (storeName: string, indexName: string, key: IDBValidKey | IDBKeyRange) =>
        new Promise<unknown[]>((resolve, reject) => {
          const transaction = db.transaction(storeName, 'readonly')
          const request = transaction.objectStore(storeName).index(indexName).getAll(key)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
      try {
        const [chat, headers, bodies, leases, chunks] = await Promise.all([
          readRow('chats', id),
          readRows('messages', 'chatId', id),
          readRows('messageBodies', 'chatId', id),
          readRows(
            'streamLeases',
            '[chatId+streamId]',
            IDBKeyRange.bound([id, ''], [id, '\uffff']),
          ),
          readRows('streamChunks', 'chatId', id),
        ])
        const chatRow = chat as {
          title: string
          settings?: { systemPrompt?: string }
          metaVersion: number
          summaryVersion: number
        }
        const bodyById = new Map(
          (bodies as Array<{ id: string; content?: unknown }>).map((body) => [body.id, body]),
        )
        type Header = {
          id: string
          parentId: string | null
          role: string
          createdAt: number
          turnIndex: number
          generation?: { abortReason?: string }
        }
        const headerRows = headers as Header[]
        const headerById = new Map(headerRows.map((header) => [header.id, header]))
        const depthById = new Map<string, number>()
        const depth = (header: Header): number => {
          const known = depthById.get(header.id)
          if (known !== undefined) return known
          const parent = header.parentId ? headerById.get(header.parentId) : undefined
          const value: number = parent ? depth(parent) + 1 : 0
          depthById.set(header.id, value)
          return value
        }
        const messages = headerRows
          .sort((left, right) => {
            return (
              depth(left) - depth(right) ||
              left.turnIndex - right.turnIndex ||
              left.createdAt - right.createdAt ||
              left.id.localeCompare(right.id)
            )
          })
          .map((header) => ({
            role: header.role,
            content: bodyById.get(header.id)?.content,
            abortReason: header.generation?.abortReason,
          }))
        return {
          title: chatRow.title,
          systemPrompt: chatRow.settings?.systemPrompt,
          metaVersion: chatRow.metaVersion,
          summaryVersion: chatRow.summaryVersion,
          streamLeaseCount: leases.length,
          streamChunkCount: chunks.length,
          messages,
        }
      } finally {
        db.close()
      }
    },
    { databaseName, id: chatId },
  )
}

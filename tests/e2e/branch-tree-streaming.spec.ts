import {
  createFakeStreamScenario,
  type FakeStreamScenarioSnapshot,
  retargetOnlyProfileToFakeProvider,
} from './fake-stream-provider'
import { createChatUiJourneyProfile, expect, test } from './fixtures'
import {
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  readMessages,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('switching to the tree during a stream does not stop or lose the generation', async ({
  page,
  uiJourney,
}) => {
  const scenario = await createFakeStreamScenario({
    targetChars: 12_000,
    reasoningChars: 12_000,
    chunkChars: 120,
    delayMs: 30,
  })
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    await createChatAndOpen(page)
    await sendMessage(page, 'stream while switching transcript views')
    await expect(page).toHaveURL(/#\/chat\/[^/]+\/message\//u)
    const chatId = await firstChatId(page)
    expect(chatId).not.toBe('')

    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(1)
    const assistant = page.locator('[data-ui="message"][data-role="assistant"]').last()
    await expect(assistant).toBeVisible()
    const streamTargetId = await assistant.getAttribute('data-message-id')
    if (!streamTargetId) throw new Error('Streaming assistant has no message id')
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()

    const expectedUrl = page.url()
    const transcriptScroll = page.locator('[data-ui="scroll-region"]')
    const journeyProfile = createChatUiJourneyProfile()
    await uiJourney.start(
      page,
      {
        ...journeyProfile,
        semanticNodes: [
          ...(journeyProfile.semanticNodes ?? []),
          {
            id: 'retained-transcript-list',
            selector: '[data-ui="message-list"]',
            preserveIdentity: true,
            requireVisible: false,
            resetOnRouteChange: false,
          },
          {
            id: 'retained-terminal-message',
            selector: `[data-ui="message"][data-message-id="${streamTargetId}"]`,
            preserveIdentity: true,
            requireVisible: false,
            attributes: {
              'data-message-id': { kind: 'exact', value: streamTargetId },
            },
            resetOnRouteChange: false,
          },
        ],
      },
      'branch-tree-streaming',
    )
    await expect(transcriptScroll).toHaveAttribute('data-scroll-state', 'follow')
    await expect
      .poll(() =>
        transcriptScroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
      )
      .toBeLessThanOrEqual(4)
    await uiJourney.intent(page, {
      kind: 'follow-bottom',
      id: 'open-tree-first-scroll',
      scrollSelector: '[data-ui="scroll-region"]',
      tolerancePx: 4,
    })
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: 'open-tree-first',
      targetSelector: '[data-role="chat-branch-tree"]',
      outcome: { selector: '[data-ui="branch-tree-view"]' },
    })
    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
    await uiJourney.checkpoint(page, 'tree-open-first')
    await expect(page).toHaveURL(expectedUrl)
    const treeScroll = page.locator('[data-ui="branch-tree-scroll"]')
    const inspectorScroll = page.locator('[data-ui="branch-tree-inspector-scroll"]')
    await expect(treeScroll).toHaveCSS('overflow-x', 'scroll')
    await expect(treeScroll).toHaveCSS('overflow-y', 'scroll')
    await expect(treeScroll).toHaveCSS('scrollbar-gutter', 'stable')
    await expect(inspectorScroll).toHaveCSS('overflow-y', 'scroll')
    await expect(inspectorScroll).toHaveCSS('scrollbar-gutter', 'stable')
    const streamingNode = page.locator(
      `[data-ui="branch-tree-node"][data-message-id="${streamTargetId}"]`,
    )
    await expect(streamingNode).toHaveAttribute('data-current-leaf', 'true')
    await expect(streamingNode).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      streamTargetId,
    )
    await expect
      .poll(() =>
        page
          .locator('[data-ui="branch-tree-inspector"] [data-ui="markdown"]')
          .textContent()
          .then((text) => text?.length ?? 0),
      )
      .toBeGreaterThan(0)
    await expect(page.locator('[data-ui="branch-tree-inspector-stream-status"]')).toHaveText(
      'Streaming response…',
    )
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Edit message' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Delete message' })).toBeDisabled()
    await expect(page.locator('[data-connector-hit][data-stream-busy="true"]')).not.toHaveCount(0)

    await uiJourney.intent(page, {
      kind: 'acquire-bottom',
      id: 'return-to-transcript-first-scroll',
      scrollSelector: '[data-ui="scroll-region"]',
      tolerancePx: 4,
    })
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: 'return-to-transcript-first',
      targetSelector: '[data-role="chat-branch-tree"]',
      outcome: { selector: '[data-ui="message-list"]' },
    })
    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${streamTargetId}"]`),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
    await expect(transcriptScroll).toHaveAttribute('data-scroll-state', 'follow')
    await expect
      .poll(() =>
        transcriptScroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
      )
      .toBeLessThanOrEqual(4)
    await uiJourney.checkpoint(page, 'transcript-return-first')
    await expect(page).toHaveURL(expectedUrl)

    await uiJourney.intent(page, {
      kind: 'follow-bottom',
      id: 'open-tree-second-scroll',
      scrollSelector: '[data-ui="scroll-region"]',
      tolerancePx: 4,
    })
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: 'open-tree-second',
      targetSelector: '[data-role="chat-branch-tree"]',
      outcome: { selector: '[data-ui="branch-tree-view"]' },
    })
    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(streamingNode).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      streamTargetId,
    )
    await expect
      .poll(() =>
        page
          .locator('[data-ui="branch-tree-inspector"] [data-ui="markdown"]')
          .textContent()
          .then((text) => text?.length ?? 0),
      )
      .toBeGreaterThan(0)
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()
    await uiJourney.checkpoint(page, 'tree-open-second')
    await expect(page).toHaveURL(expectedUrl)

    await waitForAssistantGenerationFinished(page, chatId)
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
    expect(generationRequests(await scenario.snapshot())).toHaveLength(1)

    await uiJourney.intent(page, {
      kind: 'acquire-bottom',
      id: 'return-to-transcript-final-scroll',
      scrollSelector: '[data-ui="scroll-region"]',
      tolerancePx: 4,
    })
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: 'return-to-transcript-final',
      targetSelector: '[data-role="chat-branch-tree"]',
      outcome: { selector: '[data-ui="message-list"]' },
    })
    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(page.locator('[data-ui="message-list"]')).toBeVisible()
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${streamTargetId}"]`),
    ).toBeVisible()
    await expect(transcriptScroll).toHaveAttribute('data-scroll-state', 'follow')
    await expect
      .poll(() =>
        transcriptScroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight),
      )
      .toBeLessThanOrEqual(4)
    await uiJourney.checkpoint(page, 'transcript-return-final')
    await expect(page).toHaveURL(expectedUrl)
    const persisted = assistantLengths(await readMessages(page, chatId))
    expect(persisted).toEqual({ text: 12_000, reasoning: 12_000 })
  } finally {
    await scenario.dispose()
  }
})

function generationRequests(snapshot: FakeStreamScenarioSnapshot) {
  return snapshot.requests.filter(
    (request) => request.method === 'POST' && request.path === '/chat/completions',
  )
}

function assistantLengths(rows: Array<Record<string, unknown>>): {
  text: number
  reasoning: number
} {
  const assistant = rows.find((row) => row.role === 'assistant' && row.deleted === false)
  if (!assistant) throw new Error('Persisted assistant missing')
  const content = Array.isArray(assistant.content)
    ? (assistant.content as Array<{ text?: unknown }>)
    : []
  const reasoningEnvelope =
    typeof assistant.reasoningEnvelope === 'object' && assistant.reasoningEnvelope !== null
      ? (assistant.reasoningEnvelope as { visible?: unknown })
      : null
  const visibleReasoning = Array.isArray(reasoningEnvelope?.visible)
    ? (reasoningEnvelope.visible as Array<{ text?: unknown }>)
    : []
  return {
    text: content.reduce(
      (sum, item) => sum + (typeof item.text === 'string' ? item.text.length : 0),
      0,
    ),
    reasoning: visibleReasoning.reduce(
      (sum, item) => sum + (typeof item.text === 'string' ? item.text.length : 0),
      0,
    ),
  }
}

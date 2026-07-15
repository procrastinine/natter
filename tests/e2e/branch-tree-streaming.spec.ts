import {
  createFakeStreamScenario,
  type FakeStreamScenarioSnapshot,
  retargetOnlyProfileToFakeProvider,
} from './fake-stream-provider'
import { expect, test } from './fixtures'
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

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
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

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${streamTargetId}"]`),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()

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

    await waitForAssistantGenerationFinished(page, chatId)
    await expect.poll(() => scenario.snapshot().then((state) => state.activeStreams)).toBe(0)
    expect(generationRequests(await scenario.snapshot())).toHaveLength(1)

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(page.locator('[data-ui="message-list"]')).toBeVisible()
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
  const reasoningDetails = Array.isArray(assistant.reasoningDetails)
    ? (assistant.reasoningDetails as Array<{ text?: unknown; summary?: unknown }>)
    : []
  return {
    text: content.reduce(
      (sum, item) => sum + (typeof item.text === 'string' ? item.text.length : 0),
      0,
    ),
    reasoning: reasoningDetails.reduce((sum, item) => {
      const value = typeof item.text === 'string' ? item.text : item.summary
      return sum + (typeof value === 'string' ? value.length : 0)
    }, 0),
  }
}

import { createFakeStreamScenario, retargetOnlyProfileToFakeProvider } from './fake-stream-provider'
import { expect, test } from './fixtures'
import {
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  readMessages,
  seedFirstRun,
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
      messageCountsIncludeZero: false,
    })
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

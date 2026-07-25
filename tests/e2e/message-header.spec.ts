import { createFakeStreamScenario, retargetOnlyProfileToFakeProvider } from './fake-stream-provider'
import { expect, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  readChatRow,
  readMessages,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

// The message header is a quiet single-line `Role` label. Model, timestamp,
// token breakdown, cost, and other factual-record metadata moved into the
// `[data-ui="message-info"]` disclosure that opens via the ⓘ Info button on
// the always-visible action row beneath the message body.

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('assistant header shows the role label only; model + tokens + cost live in the ⓘ disclosure', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      {
        id: 'gen-hdr',
        model: 'google/gemini-3.1-flash-lite-preview',
        content: 'hello world',
        usage: {
          prompt_tokens: 12,
          completion_tokens: 42,
          total_tokens: 54,
          cost: 0.00015,
        },
        finish: 'stop',
      },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-role"]')).toHaveText('Assistant')
  // The factual chips are NOT in the header anymore.
  await expect(assistant.locator('[data-ui="message-model"]')).toHaveCount(0)
  await expect(assistant.locator('[data-ui="message-token-count"]')).toHaveCount(0)
  await expect(assistant.locator('[data-ui="message-cost"]')).toHaveCount(0)
  // Reveal the info disclosure and verify the full factual record is there.
  await assistant.locator('[data-role="message-action"][data-action="info"]').click()
  const info = assistant.locator('[data-ui="message-info"]')
  await expect(info).toContainText('google/gemini-3.1-flash-lite-preview')
  await expect(info).toContainText('Prompt tokens')
  await expect(info).toContainText('Completion tokens')
  await expect(info).toContainText('42')
  await expect(info).toContainText('Cost')
  // Cost is rendered with 6 decimals and the dollar sign baked in.
  await expect(info).toContainText('$0.000150')
})

test('user messages still get the role label, no model/tokens/cost anywhere', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'gen-u', content: 'hi', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'user message')
  const user = page.locator('[data-ui="message"][data-role="user"]').first()
  await expect(user.locator('[data-ui="message-role"]')).toHaveText('User')
  await expect(user.locator('[data-ui="message-model"]')).toHaveCount(0)
  await expect(user.locator('[data-ui="message-token-count"]')).toHaveCount(0)
  await expect(user.locator('[data-ui="message-cost"]')).toHaveCount(0)
  // Open info — user message still shows the timestamp via the disclosure
  // (no model/tokens/cost, since those are generation-side fields).
  await user.locator('[data-role="message-action"][data-action="info"]').click()
  const info = user.locator('[data-ui="message-info"]')
  await expect(info).toContainText('Created')
  await expect(info).not.toContainText('Model')
  await expect(info).not.toContainText('Cost')
})

test('external fake provider metadata survives streaming, persistence, aggregation, and disclosure', async ({
  page,
}) => {
  const scenario = await createFakeStreamScenario({
    targetChars: 16,
    reasoningChars: 8,
    chunkChars: 8,
    reasoningChunkChars: 4,
    usage: {
      promptTokens: 101,
      completionTokens: 31,
      reasoningTokens: 7,
      cachedTokens: 11,
      cacheCreationInputTokens: 5,
      cost: 0.000654,
      costDetails: {
        upstreamInferenceCost: 0.0006,
        promptCost: 0.0002,
        completionCost: 0.0004,
      },
    },
  })
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    await createChatAndOpen(page)
    await sendMessage(page, 'exercise provider metadata')
    await expect
      .poll(() => new URL(page.url()).hash)
      .toMatch(/^#\/chat\/[^/?#]+(?:\/message\/[^/?#]+)?$/u)
    const chatId = new URL(page.url()).hash.match(/^#\/chat\/([^/?#]+)/u)?.[1]
    if (!chatId) throw new Error('FakeProviderMetadataChatRouteMissing')
    await waitForAssistantGenerationFinished(page, chatId)

    const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
    await assistant.locator('[data-role="message-action"][data-action="info"]').click()
    const info = assistant.locator('[data-ui="message-info"]')
    await expect(info).toContainText('101')
    await expect(info).toContainText('31')
    await expect(info).toContainText('24')
    await expect(info).toContainText('7')
    await expect(info).toContainText('11')
    await expect(info).toContainText('5')
    await expect(info).toContainText('$0.000654')

    const messages = await readMessages(page, chatId)
    const generated = messages.find((row) => row.role === 'assistant') as {
      generation?: { id?: string; cost?: number; usage?: Record<string, unknown> }
    }
    expect(generated.generation).toMatchObject({
      id: expect.stringMatching(/^fake-/u),
      cost: 0.000654,
      usage: {
        prompt_tokens: 101,
        completion_tokens: 31,
        total_tokens: 132,
        prompt_tokens_details: { cached_tokens: 11 },
        completion_tokens_details: { reasoning_tokens: 7 },
        cache_creation_input_tokens: 5,
        cost: 0.000654,
        cost_details: {
          upstream_inference_cost: 0.0006,
          upstream_inference_prompt_cost: 0.0002,
          upstream_inference_completions_cost: 0.0004,
        },
      },
    })
    await expect(readChatRow(page, chatId)).resolves.toMatchObject({ totalCostUsd: 0.000654 })
  } finally {
    await scenario.dispose()
  }
})

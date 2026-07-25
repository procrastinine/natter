import {
  createFakeStreamScenario,
  type FakeStreamScenario,
  retargetOnlyProfileToFakeProvider,
} from './fake-stream-provider'
import { expect, test } from './fixtures'
import { clearIndexedDb, seedFirstRun, sendMessage } from './helpers'

const scenarios = new Set<FakeStreamScenario>()

test.beforeAll(async ({ browser }, testInfo) => {
  if (testInfo.project.name !== 'chromium-dev-parity') return
  const baseURL = testInfo.project.use.baseURL
  if (typeof baseURL !== 'string') throw new Error('DevParityBaseUrlMissing')
  const warmupPage = await browser.newPage()
  try {
    await warmupPage.goto(baseURL)
    await warmupPage.locator('#root > *').first().waitFor()
  } finally {
    await warmupPage.close()
  }
})

test.afterEach(async () => {
  await Promise.all([...scenarios].map((scenario) => scenario.dispose()))
  scenarios.clear()
})

test('public startup, generation, view roundtrip, and reload use one runtime path', async ({
  page,
}) => {
  await clearIndexedDb(page)
  await seedFirstRun(page, { corsProxyUrl: '' })
  const scenario = await createFakeStreamScenario({
    targetChars: 24,
    reasoningChars: 12,
    chunkChars: 8,
    reasoningChunkChars: 4,
    usage: {
      promptTokens: 17,
      completionTokens: 9,
      reasoningTokens: 3,
      cost: 0.000123,
    },
  })
  scenarios.add(scenario)
  await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl, {
    kind: 'openrouter',
    api: 'chat',
    model: 'natter/fake-stream',
  })

  await sendMessage(page, 'dev preview public path')
  await expect(page).toHaveURL(/#\/chat\/[^/]+\/message\//u)
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect
    .poll(
      async () => (await assistant.locator('[data-ui="message-body"]').textContent())?.length ?? 0,
    )
    .toBe(24)
  await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
  await expect(assistant.locator('[data-ui="reasoning-summary"]')).toHaveCount(1)
  await assistant.locator('[data-role="message-action"][data-action="info"]').click()
  await expect(assistant.locator('[data-ui="message-info"]')).toContainText('$0.000123')

  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="message-list"]')).toBeVisible()

  await page.reload()
  const reloadedAssistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect
    .poll(
      async () =>
        (await reloadedAssistant.locator('[data-ui="message-body"]').textContent())?.length ?? 0,
    )
    .toBe(24)
  await expect(reloadedAssistant.locator('[data-ui="reasoning-summary"]')).toHaveCount(1)

  const provider = await scenario.snapshot()
  expect(
    provider.requests.filter(
      (request) => request.method === 'POST' && request.path === '/chat/completions',
    ),
  ).toHaveLength(1)
})

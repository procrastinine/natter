import { transformWorkspaceThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { expect, type Page, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  readMessages,
  seedFirstRun,
  waitForAssistantGenerationFinished,
} from './helpers'

const OR_CHAT_MODEL = 'qwen/qwen3-4b'
const OR_BOTH_CHAT_ROUTES_MODEL = 'openai/gpt-4.1-mini'
const OR_RESPONSES_MODEL = 'openai/gpt-5.4'
const OPENAI_MODEL = 'gpt-5.4-nano'
const GOOGLE_MODEL = 'gemini-3.1-flash-lite-preview'
const LLAMA_MODEL = 'local-qwen3'

type CapturedRequest = {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test('GUI OpenRouter Responses GPT-5.4 xhigh reasoning and Continue stay on the unified planner', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_RESPONSES_MODEL, {
    supportedParameters: ['provider', 'reasoning', 'verbosity', 'max_completion_tokens'],
  })
  await mockOpenRouterResponses(page, requests)

  await seedFirstRun(page, {
    model: OR_RESPONSES_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)

  const apiMode = page.locator('[data-ui-section="api-mode"]')
  if ((await apiMode.count()) > 0) {
    await apiMode.getByRole('button', { name: 'Responses', exact: true }).click()
  }
  await page.getByRole('tab', { name: 'Generation' }).click()
  const reasoning = page.locator('[data-ui-section="reasoning"]')
  await reasoning.getByRole('button', { name: 'effort' }).click()
  await reasoning.getByRole('button', { name: 'xhigh' }).click()
  await expect(reasoning.getByRole('button', { name: 'xhigh' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('Are most CJK characters 1 token in tokenizers?')
  await composer.press('Enter')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText(
    'CJK answer from responses.',
  )

  await assistant.locator('[data-action="continue"]').click()
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText(
    'CJK answer from responses. Continued via responses.',
  )

  expect(requests).toHaveLength(2)
  for (const req of requests) {
    expect(req.url).toBe('https://openrouter.ai/api/v1/responses')
    expect(req.body.model).toBe(OR_RESPONSES_MODEL)
    expect(req.body.input).toBeDefined()
    expect(req.body.messages).toBeUndefined()
    expect(req.body.reasoning).toMatchObject({ effort: 'xhigh', summary: 'auto' })
    expect(req.body.provider).toMatchObject({ data_collection: 'deny' })
  }
  expect(JSON.stringify(requests[1]?.body)).toContain(
    'Now please generate only the continuation of the last message',
  )

  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const storedAssistant = rows.find((row) => row.role === 'assistant') as
    | {
        generation?: { cost?: number; usage?: { cost?: number } }
        reasoningEnvelope?: {
          visible?: Array<{ kind?: unknown; text?: unknown }>
        }
      }
    | undefined
  const summaries =
    storedAssistant?.reasoningEnvelope?.visible?.filter((detail) => detail.kind === 'summary') ?? []
  expect(summaries).toHaveLength(1)
  expect(summaries[0]?.text).toContain('fragment-000 fragment-001 fragment-002')
  expect(summaries[0]?.text).toContain('fragment-119')
  expect(storedAssistant?.generation?.cost).toBe(0.00000825)
  expect(storedAssistant?.generation?.usage?.cost).toBe(0.00000825)

  expectNoConsoleProblems(consoleLines)
})

test('GUI OpenRouter Responses reasoning inclusion toggles never mix prompt-estimate routes', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await mockOpenRouterDiscovery(page, OR_RESPONSES_MODEL, {
    supportedParameters: ['provider', 'reasoning', 'verbosity', 'max_completion_tokens'],
  })

  await seedFirstRun(page, {
    model: OR_RESPONSES_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)

  const apiMode = page.locator('[data-ui-section="api-mode"]')
  if ((await apiMode.count()) > 0) {
    await apiMode.getByRole('button', { name: 'Responses', exact: true }).click()
  }
  await page.getByRole('tab', { name: 'Context' }).click()
  const panel = page.locator('[data-ui="chat-model-panel"]')
  const contextGauge = page.locator('[data-ui="context-gauge"]')
  const encrypted = page.getByRole('checkbox', { name: 'Encrypted reasoning' })
  await expect(contextGauge).toBeVisible()
  await expect(encrypted).toBeVisible()

  for (let index = 0; index < 4; index += 1) {
    await encrypted.click()
    await expect(panel).toBeVisible()
    await expect(contextGauge).toBeVisible()
  }

  expect(pageErrors).toEqual([])
  expectNoConsoleProblems(consoleLines)
})

test('GUI OpenRouter Text completions posts /completions with a selected template', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockOpenRouterTextCompletions(page, requests)

  await seedFirstRun(page, {
    model: OR_CHAT_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)

  const apiMode = page.locator('[data-ui-section="api-mode"]')
  const textMode = apiMode.getByRole('button', { name: 'Text completions', exact: true })
  await textMode.click()
  await expect(textMode).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('tab', { name: 'Generation' }).click()
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('OpenRouter text route check')
  await page.locator('[data-ui="text-template-picker"]').selectOption('raw')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'openrouter text ok',
  )

  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://openrouter.ai/api/v1/completions')
  expect(requests[0]?.body.model).toBe(OR_CHAT_MODEL)
  expect(requests[0]?.body.prompt).toBe('OpenRouter text route check')
  expect(requests[0]?.body.messages).toBeUndefined()
  expect(requests[0]?.body.provider).toMatchObject({ data_collection: 'deny' })
  expectNoConsoleProblems(consoleLines)
})

test('GUI OpenRouter hosted tools serialize for chat routes but not text completions', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const chatRequests: CapturedRequest[] = []
  const textRequests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL, {
    supportedParameters: [
      'provider',
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'temperature',
      'max_completion_tokens',
    ],
  })
  await mockChatCompletionsCapture(page, chatRequests, ['hosted tools ok'], {
    usageByIndex: [
      {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        server_tool_use: { web_search_requests: 1 },
      },
    ],
  })
  await mockOpenRouterTextCompletions(page, textRequests)

  await seedFirstRun(page, {
    model: OR_CHAT_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await page.getByRole('tab', { name: 'Generation' }).click()

  const tools = page.locator('[data-ui-section="hosted-tools"]')
  await expect(tools).toBeVisible()
  const webSearch = tools.getByRole('checkbox', { name: 'Web search' })
  const datetime = tools.getByRole('checkbox', { name: 'Datetime' })
  await expect(webSearch).toBeEnabled()
  await expect(datetime).toBeEnabled()
  await webSearch.click()
  await expect(webSearch).toBeChecked()
  await datetime.click()
  await expect(datetime).toBeChecked()

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('OpenRouter hosted tools route check')
  await composer.press('Enter')
  const hostedAssistant = page
    .locator('[data-ui="message"][data-role="assistant"]')
    .filter({ hasText: 'hosted tools ok' })
  await expect(hostedAssistant).toBeVisible()
  await hostedAssistant.locator('[data-action="info"]').click()
  const hostedInfo = hostedAssistant.locator('[data-ui="message-info"]')
  await expect(hostedInfo).toContainText('Tool calls')
  await expect(hostedInfo).toContainText('web search')

  expect(chatRequests).toHaveLength(1)
  expect(chatRequests[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
  expect(chatRequests[0]?.body.tools).toEqual([
    { type: 'openrouter:web_search' },
    { type: 'openrouter:datetime' },
  ])
  expect(chatRequests[0]?.body.tool_choice).toBeUndefined()
  expect(chatRequests[0]?.body.parallel_tool_calls).toBeUndefined()

  await openSettingsPanel(page)
  await page.getByRole('tab', { name: 'Model' }).click()
  const apiMode = page.locator('[data-ui-section="api-mode"]')
  await apiMode.getByRole('button', { name: 'Text completions', exact: true }).click()
  await page.getByRole('tab', { name: 'Generation' }).click()
  const textTools = page.locator('[data-ui-section="hosted-tools"]')
  await expect(textTools).toHaveCount(0)
  await page.locator('[data-ui="text-template-picker"]').selectOption('raw')

  await composer.fill('OpenRouter text completions omit tools')
  await composer.press('Enter')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .filter({ hasText: 'openrouter text ok' }),
  ).toBeVisible()

  expect(textRequests).toHaveLength(1)
  expect(textRequests[0]?.url).toBe('https://openrouter.ai/api/v1/completions')
  expect(textRequests[0]?.body.tools).toBeUndefined()

  expectNoConsoleProblems(consoleLines)
})

test('GUI OpenRouter Shell is retained but exposed and serialized only on Responses', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const responsesRequests: CapturedRequest[] = []
  const chatRequests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_BOTH_CHAT_ROUTES_MODEL, {
    supportedParameters: ['provider', 'tools', 'tool_choice', 'parallel_tool_calls'],
  })
  await mockOpenRouterResponses(page, responsesRequests)
  await mockChatCompletionsCapture(page, chatRequests, ['hosted chat ok'])

  await seedFirstRun(page, {
    model: OR_BOTH_CHAT_ROUTES_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await page.getByRole('tab', { name: 'Generation' }).click()

  const tools = page.locator('[data-ui-section="hosted-tools"]')
  await expect(tools.getByRole('checkbox', { name: 'Web search' })).toBeVisible()
  await expect(tools.getByRole('checkbox', { name: 'Datetime' })).toBeVisible()
  await expect(tools.getByRole('checkbox', { name: 'Web fetch' })).toBeVisible()
  await expect(tools.getByRole('checkbox', { name: 'Shell' })).toHaveCount(0)
  await expect(tools.getByRole('checkbox', { name: 'Image generation' })).toHaveCount(0)

  await page.getByRole('tab', { name: 'Model' }).click()
  const apiMode = page.locator('[data-ui-section="api-mode"]')
  await apiMode.getByRole('button', { name: 'Responses', exact: true }).click()
  await page.getByRole('tab', { name: 'Generation' }).click()
  for (const label of ['Web search', 'Datetime', 'Web fetch', 'Shell']) {
    const checkbox = tools.getByRole('checkbox', { name: label })
    await expect(checkbox).toBeVisible()
    await checkbox.check()
    await expect(checkbox).toBeChecked()
  }

  await page.reload()
  await openSettingsPanel(page)
  await page.getByRole('tab', { name: 'Generation' }).click()
  await expect(tools.getByRole('checkbox', { name: 'Shell' })).toBeChecked()
  await page.locator('[data-role="settings-cog"]').click()
  await sendAndExpectAssistant(
    page,
    'Inspect the hosted environment.',
    'CJK answer from responses.',
  )

  expect(responsesRequests).toHaveLength(1)
  expect(responsesRequests[0]?.body.tools).toEqual([
    { type: 'openrouter:web_search' },
    { type: 'openrouter:datetime' },
    { type: 'openrouter:web_fetch' },
    { type: 'openrouter:shell' },
  ])

  await openSettingsPanel(page)
  await page.getByRole('tab', { name: 'Model' }).click()
  await apiMode.getByRole('button', { name: 'Chat completions', exact: true }).click()
  await page.getByRole('tab', { name: 'Generation' }).click()
  await expect(tools.getByRole('checkbox', { name: 'Shell' })).toHaveCount(0)
  await page.locator('[data-role="settings-cog"]').click()
  await sendAndExpectAssistant(page, 'Use the ordinary hosted tools.', 'hosted chat ok')

  expect(chatRequests).toHaveLength(1)
  expect(chatRequests[0]?.body.tools).toEqual([
    { type: 'openrouter:web_search' },
    { type: 'openrouter:datetime' },
    { type: 'openrouter:web_fetch' },
  ])
  expectNoConsoleProblems(consoleLines)
})

test('GUI OpenAI direct hosted tools serialize only as Responses tools', async ({ page }) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockOpenAiDirect(page, requests)

  await seedFirstRun(page, {
    model: OR_CHAT_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await addConnectionThroughGui(page, 'openai-compatible', { key: 'sk-openai-test' })
  await selectModelThroughSettings(page, OPENAI_MODEL)
  await page.getByRole('tab', { name: 'Generation' }).click()

  const tools = page.locator('[data-ui-section="hosted-tools"]')
  await expect(tools).toBeVisible()
  await expect(tools.locator('h3')).toContainText('OpenAI tools')
  const webSearch = tools.getByRole('checkbox', { name: 'Web search' })
  const imageGeneration = tools.getByRole('checkbox', { name: 'Image generation' })
  await webSearch.click()
  await imageGeneration.click()
  await expect(webSearch).toBeChecked()
  await expect(imageGeneration).toBeChecked()

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('OpenAI hosted tools route check')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'openai direct tools ok',
  )

  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('https://api.openai.com/v1/responses')
  expect(requests[0]?.headers.authorization).toBe('Bearer sk-openai-test')
  expect(requests[0]?.body.model).toBe(OPENAI_MODEL)
  expect(requests[0]?.body.provider).toBeUndefined()
  expect(requests[0]?.body.messages).toBeUndefined()
  expect(requests[0]?.body.input).toBeDefined()
  expect(requests[0]?.body.tools).toEqual([{ type: 'web_search' }, { type: 'image_generation' }])

  expectNoConsoleProblems(consoleLines)
})

test('GUI edit Save & Send reuses provider planning for the edited branch', async ({ page }) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockChatCompletionsCapture(page, requests, ['original answer', 'edited answer'])

  await seedFirstRun(page, {
    model: OR_CHAT_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  const alphaRow = page.locator('[data-ui="provider-picker-row"]').filter({ hasText: 'Alpha ZDR' })
  await expect(alphaRow).toBeVisible()
  await alphaRow.getByLabel('Move down').click()
  await expect(page.locator('[data-ui="provider-picker-row"]').first()).toContainText(
    'Budget Clean',
  )
  await waitForProviderOrder(page, ['Budget Clean', 'Alpha ZDR', 'Tiny Context'])

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('original user prompt')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'original answer',
  )

  const user = page.locator('[data-ui="message"][data-role="user"]').first()
  await user.locator('[data-action="edit"]').click()
  await user.locator('[data-ui="inline-editor-input"]').fill('edited user prompt')
  await user.locator('[data-role="save-send"]').click()
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').filter({ hasText: 'edited answer' }),
  ).toBeVisible()

  expect(requests).toHaveLength(2)
  const second = requests[1]?.body
  expect(JSON.stringify(second?.messages)).toContain('edited user prompt')
  expect(JSON.stringify(second?.messages)).not.toContain('original user prompt')
  expect(second?.provider).toMatchObject({ data_collection: 'deny' })
  const secondProvider = second?.provider as { order?: string[]; ignore?: string[] } | undefined
  expect(secondProvider?.order).toEqual(['Budget Clean', 'Alpha ZDR'])
  expect(secondProvider?.ignore).toEqual(
    expect.arrayContaining(['Fast Retain', 'Training Host', 'Tiny Context', 'UserID Host']),
  )

  expectNoConsoleProblems(consoleLines)
})

test('GUI manual provider allow updates privacy badge and overrides red tiers', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockChatCompletionsCapture(page, requests, ['manual provider ok'])

  await seedFirstRun(page, {
    model: OR_CHAT_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)

  const headerLock = page.locator('[data-ui="header-privacy-badge"] [data-ui="icon-button"]')
  await expect(headerLock).toHaveAttribute('data-privacy-tier', 'green')

  const fastRetainRow = page
    .locator('[data-ui="provider-picker-row"]')
    .filter({ hasText: 'Fast Retain' })
  await expect(fastRetainRow).toHaveAttribute('data-allowed', 'false')
  await expect(fastRetainRow.locator('[data-ui="provider-picker-lock"]')).toHaveAttribute(
    'data-privacy-tier',
    'yellow',
  )
  await page.getByLabel('Use Fast Retain').click()
  await expect(fastRetainRow).toHaveAttribute('data-allowed', 'true')
  await expect(headerLock).toHaveAttribute('data-privacy-tier', 'yellow')

  const userIdRow = page
    .locator('[data-ui="provider-picker-row"]')
    .filter({ hasText: 'UserID Host' })
  await expect(userIdRow).toHaveAttribute('data-allowed', 'false')
  await expect(userIdRow.locator('[data-ui="provider-picker-lock"]')).toHaveAttribute(
    'data-privacy-tier',
    'orange',
  )
  await page.getByLabel('Use UserID Host').click()
  await expect(userIdRow).toHaveAttribute('data-allowed', 'true')
  await expect(headerLock).toHaveAttribute('data-privacy-tier', 'orange')

  await headerLock.click()
  const popoverFastRetain = page
    .locator('[data-ui="header-privacy-row"]')
    .filter({ hasText: 'Fast Retain' })
  await expect(popoverFastRetain).toHaveAttribute('data-allowed', 'true')
  await expect(popoverFastRetain).toContainText('in use')
  await page.keyboard.press('Escape')

  const trainingRow = page
    .locator('[data-ui="provider-picker-row"]')
    .filter({ hasText: 'Training Host' })
  await expect(trainingRow).toHaveAttribute('data-allowed', 'false')
  await expect(page.getByLabel('Use Training Host')).toBeDisabled()
  await expect(headerLock).toHaveAttribute('data-privacy-tier', 'orange')

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('manual provider override route check')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'manual provider ok',
  )

  expect(requests).toHaveLength(1)
  const provider = requests[0]?.body.provider as { ignore?: string[]; data_collection?: string }
  expect(provider.data_collection).toBe('deny')
  expect(provider.ignore).not.toContain('Fast Retain')
  expect(provider.ignore).not.toContain('UserID Host')
  expect(provider.ignore).toContain('Training Host')

  expectNoConsoleProblems(consoleLines)
})

test('GUI duplicate provider display names stay independently selectable by slug', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, 'anthropic/claude-opus-4.7', {
    endpointsPayload: duplicateAnthropicEndpointsPayload('anthropic/claude-opus-4.7'),
  })
  await mockChatCompletionsCapture(page, requests, ['legacy fixture seed', 'duplicate provider ok'])

  await seedFirstRun(page, {
    model: 'anthropic/claude-opus-4.7',
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await sendAndExpectAssistant(page, 'materialize legacy fixture chat', 'legacy fixture seed')
  await openSettingsPanel(page)
  await seedLegacyProviderPrivacy(page, ['Anthropic'])
  await page.reload()
  await openSettingsPanel(page)

  const anth2 = page
    .locator('[data-ui="provider-picker-row"]')
    .filter({ hasText: 'Anthropic (anthropic/2)' })
  const anth = page
    .locator('[data-ui="provider-picker-row"]')
    .filter({ hasText: 'Anthropic (anthropic)' })
  const bedrock = page
    .locator('[data-ui="provider-picker-row"]')
    .filter({ hasText: 'Amazon Bedrock' })
  await expect(bedrock).toHaveAttribute('data-allowed', 'true')
  await expect(anth2).toHaveAttribute('data-allowed', 'false')
  await expect(anth).toHaveAttribute('data-allowed', 'false')

  await page.getByLabel('Use Anthropic (anthropic)').click()
  await expect(anth).toHaveAttribute('data-allowed', 'true')
  await expect(anth2).toHaveAttribute('data-allowed', 'false')

  await page.getByLabel('Use Anthropic (anthropic/2)').click()
  await expect(anth2).toHaveAttribute('data-allowed', 'true')
  await expect(anth).toHaveAttribute('data-allowed', 'true')

  await page.getByLabel('Use Anthropic (anthropic/2)').click()
  await expect(anth2).toHaveAttribute('data-allowed', 'false')
  await expect(anth).toHaveAttribute('data-allowed', 'true')

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('duplicate provider route check')
  await composer.press('Enter')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .filter({ hasText: 'duplicate provider ok' }),
  ).toBeVisible()
  await waitForAssistantGenerationFinished(page, await firstChatId(page))

  expect(requests).toHaveLength(2)
  const provider = requests[1]?.body.provider as { ignore?: string[]; order?: string[] }
  expect(provider.ignore).toEqual(['anthropic/2'])
  expect(provider.order).toBeUndefined()
  expectNoConsoleProblems(consoleLines)
})

test('GUI provider quantization bulk actions update the selected provider list', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL, {
    endpointsPayload: quantizedDeepSeekEndpointsPayload(OR_CHAT_MODEL),
    policyRows: quantizedDeepSeekPolicyRows(),
  })
  await mockChatCompletionsCapture(page, requests, ['quantization provider ok'])

  await seedFirstRun(page, {
    model: OR_CHAT_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)

  const unknownRow = page.locator('[data-ui="provider-picker-row"]').filter({ hasText: 'DeepSeek' })
  const fp8Row = page.locator('[data-ui="provider-picker-row"]').filter({ hasText: 'StreamLake' })
  const fp4Row = page.locator('[data-ui="provider-picker-row"]').filter({ hasText: 'DeepInfra' })
  await expect(unknownRow).toHaveAttribute('data-allowed', 'true')
  await expect(fp8Row).toHaveAttribute('data-allowed', 'true')
  await expect(fp4Row).toHaveAttribute('data-allowed', 'true')

  await page.getByRole('button', { name: 'Deselect low quant' }).click()
  await expect(unknownRow).toHaveAttribute('data-allowed', 'true')
  await expect(fp8Row).toHaveAttribute('data-allowed', 'true')
  await expect(fp4Row).toHaveAttribute('data-allowed', 'false')

  await page.getByRole('button', { name: 'Deselect unknown quant' }).click()
  await expect(unknownRow).toHaveAttribute('data-allowed', 'false')
  await expect(fp8Row).toHaveAttribute('data-allowed', 'true')
  await expect(fp4Row).toHaveAttribute('data-allowed', 'false')

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('quantization provider route check')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'quantization provider ok',
  )

  expect(requests).toHaveLength(1)
  const provider = requests[0]?.body.provider as { ignore?: string[] }
  expect(provider.ignore).toEqual(expect.arrayContaining(['deepinfra/fp4', 'deepseek']))
  expect(provider.ignore).not.toContain('streamlake/fp8')
  expect(provider).not.toHaveProperty('quantizations')

  expectNoConsoleProblems(consoleLines)
})

test('GUI provider picker wraps long duplicate provider labels inside the settings panel', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL, {
    endpointsPayload: longDuplicateProviderEndpointsPayload(OR_CHAT_MODEL),
    policyRows: longDuplicateProviderPolicyRows(),
  })

  await seedFirstRun(page, { model: OR_CHAT_MODEL, disablePrivacyFilter: false })
  await createChatAndOpen(page)
  await openSettingsPanel(page)

  const longRow = page
    .locator('[data-ui="provider-picker-row"]')
    .filter({ hasText: 'Amazon Bedrock (amazon-bedrock/eu-west-1)' })
  await expect(longRow).toBeVisible()

  const metrics = await longRow.evaluate((row) => {
    const panel = row.closest<HTMLElement>('[data-ui="chat-model-panel"]')
    const name = row.querySelector<HTMLElement>('[data-ui="provider-picker-name"]')
    const actions = row.querySelector<HTMLElement>('[data-ui="provider-picker-row-actions"]')
    if (!panel || !name || !actions) throw new Error('provider row layout nodes missing')
    const rowRect = row.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const nameRect = name.getBoundingClientRect()
    const actionsRect = actions.getBoundingClientRect()
    const style = getComputedStyle(name)
    return {
      actionsLeft: actionsRect.left,
      lineClamp: style.webkitLineClamp,
      lineHeight: Number.parseFloat(style.lineHeight),
      nameHeight: nameRect.height,
      nameRight: nameRect.right,
      panelRight: panelRect.right,
      rowRight: rowRect.right,
    }
  })

  expect(metrics.lineClamp).toBe('2')
  expect(metrics.rowRight).toBeLessThanOrEqual(metrics.panelRight + 1)
  expect(metrics.nameRight).toBeLessThanOrEqual(metrics.actionsLeft - 2)
  expect(metrics.nameHeight).toBeGreaterThan(metrics.lineHeight * 1.5)
  expect(metrics.nameHeight).toBeLessThanOrEqual(metrics.lineHeight * 2 + 2)
  expect(
    consoleLines.filter((line) => line.startsWith('error:') || line.startsWith('warning:')),
  ).toEqual([])
})

test('GUI Google native sends generateContent without OpenRouter provider/privacy wire', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockGoogleModels(page)
  await mockGeminiNative(page, requests)

  await seedFirstRun(page, { model: OR_CHAT_MODEL })
  await createChatAndOpen(page)
  await addConnectionThroughGui(page, 'google', { key: 'sk-google-test', expectedName: 'Google' })
  await selectModelThroughSettings(page, GOOGLE_MODEL)
  await expect(page.locator('[data-ui-section="provider-picker"]')).toHaveCount(0)
  await expect(page.locator('[data-ui-section="privacy-section"]')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Generation' }).click()
  const tools = page.locator('[data-ui-section="hosted-tools"]')
  await expect(tools).toBeVisible()
  await expect(tools.locator('h3')).toContainText('Gemini tools')
  const googleSearch = tools.getByRole('checkbox', { name: 'Google Search' })
  const urlContext = tools.getByRole('checkbox', { name: 'URL context' })
  await googleSearch.click()
  await urlContext.click()
  await expect(googleSearch).toBeChecked()
  await expect(urlContext).toBeChecked()

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('Gemini native route check')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'gemini native ok',
  )

  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:streamGenerateContent?alt=sse',
  )
  expect(requests[0]?.headers['x-goog-api-key']).toBe('sk-google-test')
  expect(requests[0]?.headers.authorization).toBeUndefined()
  expect(requests[0]?.headers['http-referer']).toBeUndefined()
  expect(requests[0]?.headers['x-openrouter-title']).toBeUndefined()
  expect(requests[0]?.body.provider).toBeUndefined()
  expect(requests[0]?.body.contents).toBeDefined()
  expect(requests[0]?.body.tools).toEqual([{ googleSearch: {} }, { urlContext: {} }])

  expectNoConsoleProblems(consoleLines)
})

test('GUI alternating direct providers keep native tool context provider-specific', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const openAiRequests: CapturedRequest[] = []
  const geminiRequests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockOpenAiAlternatingToolContext(page, openAiRequests)
  await mockGoogleModels(page)
  await mockGeminiAlternatingToolContext(page, geminiRequests)

  await seedFirstRun(page, { model: OR_CHAT_MODEL })
  await createChatAndOpen(page)

  await addConnectionThroughGui(page, 'openai-compatible', { key: 'sk-openai-test' })
  await selectModelThroughSettings(page, OPENAI_MODEL)
  await sendAndExpectAssistant(page, 'OpenAI direct tool turn', 'openai searched answer')

  await addConnectionThroughGui(page, 'google', { key: 'sk-google-test', expectedName: 'Google' })
  await selectModelThroughSettings(page, GOOGLE_MODEL)
  await sendAndExpectAssistant(page, 'Gemini sees OpenAI tool evidence', 'gemini code answer')

  await switchConnectionThroughGui(page, 'OpenAI')
  await selectModelThroughSettings(page, OPENAI_MODEL)
  await sendAndExpectAssistant(page, 'OpenAI sees Gemini text fallback', 'openai shell answer')

  await switchConnectionThroughGui(page, 'Google')
  await selectModelThroughSettings(page, GOOGLE_MODEL)
  await sendAndExpectAssistant(
    page,
    'Gemini sees native Gemini and OpenAI text',
    'gemini final answer',
  )

  expect(openAiRequests).toHaveLength(2)
  expect(geminiRequests).toHaveLength(2)

  const firstGeminiWire = JSON.stringify(geminiRequests[0]?.body.contents)
  expect(firstGeminiWire).toContain('<tool_call>')
  expect(firstGeminiWire).toContain('Web search')
  expect(firstGeminiWire).toContain('OpenAI evidence marker')
  expect(firstGeminiWire).not.toContain('"web_search_call"')
  expect(firstGeminiWire).not.toContain('"codeExecutionResult"')

  const secondOpenAiInput = openAiRequests[1]?.body.input as Array<Record<string, unknown>>
  expect(secondOpenAiInput.some((item) => item.type === 'web_search_call')).toBe(true)
  expect(secondOpenAiInput.some((item) => item.type === 'shell_call')).toBe(false)
  const secondOpenAiWire = JSON.stringify(secondOpenAiInput)
  expect(secondOpenAiWire).toContain('<tool_call>')
  expect(secondOpenAiWire).toContain('Code execution')
  expect(secondOpenAiWire).toContain('Gemini code evidence marker')
  expect(secondOpenAiWire).not.toContain('"executableCode"')
  expect(secondOpenAiWire).not.toContain('"codeExecutionResult"')

  const secondGeminiContents = geminiRequests[1]?.body.contents as Array<Record<string, unknown>>
  const secondGeminiWire = JSON.stringify(secondGeminiContents)
  expect(secondGeminiWire).toContain('"executableCode"')
  expect(secondGeminiWire).toContain('"codeExecutionResult"')
  expect(secondGeminiWire).toContain('<tool_call>')
  expect(secondGeminiWire).toContain('Web search')
  expect(secondGeminiWire).toContain('Shell command')
  expect(secondGeminiWire).toContain('OpenAI shell marker')
  expect(secondGeminiWire).not.toContain('"web_search_call"')
  expect(secondGeminiWire).not.toContain('"shell_call"')
  expect(secondGeminiWire).not.toContain('"shell_call_output"')

  const chatId = await firstChatId(page)
  const assistantRows = (await readMessages(page, chatId)).filter((row) => row.role === 'assistant')
  expect(assistantRows).toHaveLength(4)
  expect(
    providerDialects(assistantRows[0] as { providerOutputItems?: Array<{ dialect?: string }> }),
  ).toEqual(['openai-responses'])
  expect(
    providerDialects(assistantRows[1] as { providerOutputItems?: Array<{ dialect?: string }> }),
  ).toEqual(['google-gemini'])
  expect(
    providerDialects(assistantRows[2] as { providerOutputItems?: Array<{ dialect?: string }> }),
  ).toEqual(['openai-responses'])
  expect(
    providerDialects(assistantRows[3] as { providerOutputItems?: Array<{ dialect?: string }> }),
  ).toEqual([])

  const toolBlocks = page.locator(
    '[data-ui="message"][data-role="assistant"] [data-ui="tool-evidence"]',
  )
  await expect(toolBlocks).toHaveCount(3)
  await toolBlocks.first().locator('[data-ui="tool-evidence-summary"]').click()
  await expect(toolBlocks.first()).toContainText('Web search')
  await toolBlocks.nth(1).locator('[data-ui="tool-evidence-summary"]').click()
  await expect(toolBlocks.nth(1)).toContainText('Code execution')
  await toolBlocks.nth(2).locator('[data-ui="tool-evidence-summary"]').click()
  await expect(toolBlocks.nth(2)).toContainText('Shell command')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').last()).not.toContainText(
    'Tool results',
  )
  await expectNoHorizontalOverflow(page)
  expectNoConsoleProblems(consoleLines)
})

test('GUI llama-server text protocol posts /completions prompt through the unified planner', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockLlamaModels(page)
  await mockTextCompletions(page, requests)

  await seedFirstRun(page, { model: OR_CHAT_MODEL })
  await createChatAndOpen(page)
  await addConnectionThroughGui(page, 'llama-server', {
    expectedName: 'llama-server',
    baseUrl: 'http://127.0.0.1:8080/v1',
  })
  await selectModelThroughSettings(page, LLAMA_MODEL)
  const textProtocol = page.getByRole('button', { name: 'Text completion', exact: true })
  await textProtocol.click()
  await expect(textProtocol).toHaveAttribute('aria-pressed', 'true')

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('Local llama text route check')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'llama text ok',
  )

  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe('http://127.0.0.1:8080/v1/completions')
  expect(requests[0]?.headers.authorization).toBeUndefined()
  expect(requests[0]?.body.model).toBe(LLAMA_MODEL)
  expect(requests[0]?.body.prompt).toContain('Local llama text route check')
  expect(requests[0]?.body.messages).toBeUndefined()
  expect(requests[0]?.body.provider).toBeUndefined()

  expectNoConsoleProblems(consoleLines)
})

function captureConsole(page: Page): string[] {
  const lines: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      lines.push(`${msg.type()}: ${msg.text()}`)
    }
  })
  return lines
}

function expectNoConsoleProblems(lines: string[]): void {
  expect(lines.filter((line) => line.startsWith('error:') || line.startsWith('warning:'))).toEqual(
    [],
  )
}

async function openSettingsPanel(page: Page): Promise<void> {
  const panel = page.locator('[data-ui="chat-model-panel"]')
  if ((await panel.count()) === 0) {
    await page.locator('[data-role="settings-cog"]').click()
  }
  await expect(panel).toBeVisible()
}

async function selectModelThroughSettings(page: Page, modelId: string): Promise<void> {
  await openSettingsPanel(page)
  await page.getByRole('tab', { name: 'Model' }).click()
  await page.locator('[data-ui="model-picker-search-input"]').fill(modelId)
  await page.locator('[data-ui="picker-row-pick"]').filter({ hasText: modelId }).first().click()
}

async function addConnectionThroughGui(
  page: Page,
  kind: 'openai-compatible' | 'google' | 'llama-server',
  opts: { key?: string; baseUrl?: string; expectedName?: string },
): Promise<void> {
  await openConnectionDetail(page)
  await page.locator('[data-ui="connection-new"]').click()
  await page.locator('[data-ui="connection-setup-kind"]').selectOption(kind)
  if (opts.baseUrl !== undefined) {
    await page.locator('[data-ui="connection-setup-base-url"]').fill(opts.baseUrl)
  }
  if (opts.key !== undefined) {
    await page.locator('[data-ui="connection-setup-key"]').fill(opts.key)
  }
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  if (opts.expectedName !== undefined) {
    await expect(page.locator('[data-ui="connection-name"]')).toContainText(opts.expectedName)
  }
}

async function switchConnectionThroughGui(page: Page, profileName: string): Promise<void> {
  await openConnectionDetail(page)
  const select = page.locator('[data-ui="connection-profile-select"]')
  const optionLabels = async () => select.locator('option').allTextContents()
  const choosePageControl = async (label: string): Promise<void> => {
    const before = JSON.stringify(await optionLabels())
    await select.selectOption({ label })
    await expect.poll(async () => JSON.stringify(await optionLabels())).not.toBe(before)
  }

  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const labels = await optionLabels()
    if (labels.includes(profileName)) {
      await select.selectOption({ label: profileName })
      await expect(page.locator('[data-ui="connection-name"]')).toContainText(profileName)
      return
    }
    if (!labels.includes('Earlier connections…')) break
    await choosePageControl('Earlier connections…')
  }
  for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
    const labels = await optionLabels()
    if (labels.includes(profileName)) {
      await select.selectOption({ label: profileName })
      await expect(page.locator('[data-ui="connection-name"]')).toContainText(profileName)
      return
    }
    if (!labels.includes('Load more connections…')) break
    await choosePageControl('Load more connections…')
  }
  throw new Error(`connection profile not found through paginated selector: ${profileName}`)
}

async function openConnectionDetail(page: Page): Promise<void> {
  const detailAction = page.locator('[data-ui="connection-new"]')
  if (await detailAction.isVisible()) return
  const row = page.locator('[data-ui="connection-row"]')
  if ((await row.count()) === 0) {
    await page.locator('[data-ui="connection-provider-button"]').click()
    await expect(row).toBeVisible()
  }
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.click()
  }
  await expect(detailAction).toBeVisible()
}

async function sendAndExpectAssistant(page: Page, prompt: string, expected: string): Promise<void> {
  const before = await page.locator('[data-ui="message"][data-role="assistant"]').count()
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill(prompt)
  await composer.press('Enter')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').nth(before)
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText(expected)
  await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
}

function providerDialects(row: { providerOutputItems?: Array<{ dialect?: string }> }): string[] {
  const dialects = (row.providerOutputItems ?? [])
    .map((item) => item.dialect)
    .filter((dialect): dialect is string => typeof dialect === 'string')
  return [...new Set(dialects)]
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-ui="tool-evidence"], [data-ui="tool-evidence-row-value"], [data-ui="tool-evidence-sources"]',
      ),
    )
    return rows
      .map((node) => ({
        ui: node.getAttribute('data-ui'),
        text: node.textContent.slice(0, 80),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }))
      .filter((entry) => entry.scrollWidth > entry.clientWidth + 1)
  })
  expect(overflow).toEqual([])
}

async function waitForProviderOrder(page: Page, expected: string[]): Promise<void> {
  const databaseName = await activeWorkspaceDatabaseName(page)
  await page.waitForFunction(
    async ({ databaseName, order }) => {
      const chatId = window.location.hash.match(/^#\/chat\/([^/?#]+)/)?.[1]
      if (!chatId) return false
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(databaseName)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        return await new Promise<boolean>((resolve, reject) => {
          const tx = db.transaction('chats', 'readonly')
          const req = tx.objectStore('chats').get(chatId)
          req.onsuccess = () => {
            const row = req.result as
              | { settings?: { providerPrefs?: { order?: string[] } } }
              | undefined
            resolve(
              JSON.stringify(row?.settings?.providerPrefs?.order ?? []) === JSON.stringify(order),
            )
          }
          req.onerror = () => reject(req.error)
        })
      } finally {
        db.close()
      }
    },
    { databaseName, order: expected },
  )
}

async function seedLegacyProviderPrivacy(
  page: Page,
  ignoreProviders: string[],
  onlyProviders: string[] = [],
): Promise<void> {
  const chatId = new URL(page.url()).hash.match(/^#\/chat\/([^/?#]+)/)?.[1]
  if (!chatId) throw new Error('missing active chat id')
  await transformWorkspaceThroughUi(page, (backup) => {
    const payload = backup.payload as { chats?: Array<Record<string, unknown>> } | undefined
    const chat = payload?.chats?.find((row) => row.id === chatId)
    if (!chat) throw new Error('active chat missing from workspace backup')
    const settings = chat.settings as
      | { privacy?: Record<string, unknown>; providerPrefs?: unknown }
      | undefined
    if (!settings?.privacy) throw new Error('missing chat settings')
    settings.privacy = {
      ...settings.privacy,
      ignoreProviders,
      onlyProviders,
    }
    delete settings.providerPrefs
  })
}

async function mockOpenRouterDiscovery(
  page: Page,
  modelId: string,
  opts: {
    supportedParameters?: string[]
    endpointsPayload?: Record<string, unknown>
    policyRows?: Array<Record<string, unknown>>
  } = {},
): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(openRouterModelsPayload(modelId, opts.supportedParameters)),
    })
  })
  await page.route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        opts.endpointsPayload ?? openRouterEndpointsPayload(modelId, opts.supportedParameters),
      ),
    })
  })
  await page.route('**/_or_scrape/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { providers: opts.policyRows ?? openRouterProviderPolicyRows() } },
      })}</script>`,
    })
  })
}

async function mockChatCompletionsCapture(
  page: Page,
  requests: CapturedRequest[],
  replies: readonly string[],
  opts: { usageByIndex?: readonly Record<string, unknown>[] } = {},
): Promise<void> {
  await page.route('**/chat/completions', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body, headers: route.request().headers() })
    const idx = requests.length - 1
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': `adv-chat-${idx + 1}` },
      body: buildSseBody([
        {
          id: `adv-chat-${idx + 1}`,
          model: stringField(body, 'model'),
          provider: 'Alpha ZDR',
          content: replies[idx] ?? 'ok',
        },
        {
          finish: 'stop',
          usage: opts.usageByIndex?.[idx] ?? {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        },
      ]),
    })
  })
}

async function mockOpenRouterTextCompletions(
  page: Page,
  requests: CapturedRequest[],
): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/completions', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body, headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': 'adv-text-1' },
      body: [
        `data: ${JSON.stringify({
          id: 'adv-text-1',
          model: body.model,
          provider: 'Alpha ZDR',
          choices: [{ index: 0, text: 'openrouter text ok', finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    })
  })
}

async function mockOpenRouterResponses(page: Page, requests: CapturedRequest[]): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/responses', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body, headers: route.request().headers() })
    const idx = requests.length - 1
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': `adv-resp-${idx + 1}` },
      body:
        idx === 0
          ? buildResponsesSse({
              id: 'adv-resp-1',
              model: stringField(body, 'model'),
              text: 'CJK answer from responses.',
              reasoningFragments: Array.from(
                { length: 120 },
                (_, i) => `fragment-${String(i).padStart(3, '0')} `,
              ),
            })
          : buildResponsesSse({
              id: 'adv-resp-2',
              model: stringField(body, 'model'),
              text: ' Continued via responses.',
              reasoningFragments: [],
            }),
    })
  })
}

async function mockOpenAiDirect(page: Page, requests: CapturedRequest[]): Promise<void> {
  await page.route('https://api.openai.com/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: OPENAI_MODEL, object: 'model', created: 0, owned_by: 'openai' }],
      }),
    })
  })
  await page.route('https://api.openai.com/v1/responses', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body, headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': 'adv-openai-tools-1' },
      body: buildResponsesSse({
        id: 'adv-openai-tools-1',
        model: stringField(body, 'model'),
        text: 'openai direct tools ok',
        reasoningFragments: [],
      }),
    })
  })
}

async function mockOpenAiAlternatingToolContext(
  page: Page,
  requests: CapturedRequest[],
): Promise<void> {
  await page.route('https://api.openai.com/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{ id: OPENAI_MODEL, object: 'model', created: 0, owned_by: 'openai' }],
      }),
    })
  })
  await page.route('https://api.openai.com/v1/responses', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body, headers: route.request().headers() })
    const idx = requests.length - 1
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': `adv-openai-alt-${idx + 1}` },
      body:
        idx === 0
          ? buildResponsesToolSse({
              id: 'adv-openai-alt-1',
              model: stringField(body, 'model'),
              text: 'openai searched answer',
              toolItems: [
                {
                  id: 'ws_openai_alt_1',
                  type: 'web_search_call',
                  status: 'completed',
                  query: 'OpenAI evidence marker',
                  results: [{ url: 'https://example.com/openai-evidence-marker' }],
                },
              ],
            })
          : buildResponsesToolSse({
              id: 'adv-openai-alt-2',
              model: stringField(body, 'model'),
              text: 'openai shell answer',
              toolItems: [
                {
                  id: 'sh_openai_alt_2',
                  type: 'shell_call',
                  status: 'completed',
                  commands: ['printf OpenAI shell marker'],
                  environment: 'linux',
                },
                {
                  id: 'sho_openai_alt_2',
                  type: 'shell_call_output',
                  status: 'completed',
                  stdout: 'OpenAI shell marker',
                  stderr: '',
                  outcome: 'success',
                },
              ],
            }),
    })
  })
}

async function mockGoogleModels(page: Page): Promise<void> {
  await page.route(
    'https://generativelanguage.googleapis.com/v1beta/openai/models**',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{ id: GOOGLE_MODEL, object: 'model', created: 0, owned_by: 'google' }],
        }),
      })
    },
  )
}

async function mockGeminiAlternatingToolContext(
  page: Page,
  requests: CapturedRequest[],
): Promise<void> {
  await page.route('**/models/*:streamGenerateContent?alt=sse', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body, headers: route.request().headers() })
    const idx = requests.length - 1
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-request-id': `gemini-alt-${idx + 1}` },
      body:
        idx === 0
          ? buildGeminiSse([
              {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [
                        {
                          executableCode: {
                            language: 'PYTHON',
                            code: 'print("Gemini code evidence marker")',
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [
                        {
                          codeExecutionResult: {
                            outcome: 'OUTCOME_OK',
                            output: 'Gemini code evidence marker',
                          },
                        },
                        { text: 'gemini code answer' },
                      ],
                    },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 12,
                  candidatesTokenCount: 4,
                  totalTokenCount: 16,
                },
              },
            ])
          : buildGeminiSse([
              {
                candidates: [
                  {
                    content: { role: 'model', parts: [{ text: 'gemini final answer' }] },
                    finishReason: 'STOP',
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 12,
                  candidatesTokenCount: 4,
                  totalTokenCount: 16,
                },
              },
            ]),
    })
  })
}

async function mockGeminiNative(page: Page, requests: CapturedRequest[]): Promise<void> {
  await page.route('**/models/*:streamGenerateContent?alt=sse', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body, headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-request-id': 'gemini-adv-1' },
      body: [
        `data: ${JSON.stringify({
          modelVersion: GOOGLE_MODEL,
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'gemini native ok' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
        })}`,
        '',
        '',
      ].join('\n'),
    })
  })
}

async function mockLlamaModels(page: Page): Promise<void> {
  await page.route('http://127.0.0.1:8080/props', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        chat_template: '{{ messages }}',
        default_generation_settings: { n_predict: 128 },
      }),
    })
  })
  await page.route('http://127.0.0.1:8080/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          {
            id: LLAMA_MODEL,
            object: 'model',
            created: 0,
            owned_by: 'local',
            meta: { n_ctx_train: 8192 },
          },
        ],
      }),
    })
  })
}

async function mockTextCompletions(page: Page, requests: CapturedRequest[]): Promise<void> {
  await page.route('http://127.0.0.1:8080/v1/completions', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body, headers: route.request().headers() })
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': 'llama-text-adv-1' },
      body: [
        `data: ${JSON.stringify({
          id: 'llama-text-adv-1',
          model: body.model,
          choices: [{ index: 0, text: 'llama text ok', finish_reason: 'stop' }],
        })}`,
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
    })
  })
}

function buildResponsesSse(input: {
  id: string
  model: string
  text: string
  reasoningFragments: string[]
}): string {
  const events: Array<Record<string, unknown> & { type: string }> = [
    {
      type: 'response.created',
      response: { id: input.id, model: input.model, status: 'in_progress' },
    },
  ]
  if (input.reasoningFragments.length > 0) {
    events.push({
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: `${input.id}-rs`, type: 'reasoning', encrypted_content: 'gAAA_partial' },
    })
    input.reasoningFragments.forEach((delta) => {
      events.push({
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        item_id: `${input.id}-rs`,
        summary_index: 0,
        delta,
      })
    })
    events.push({
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: `${input.id}-rs`, type: 'reasoning', encrypted_content: 'gAAA_final' },
    })
  }
  events.push(
    {
      type: 'response.output_item.added',
      output_index: 1,
      item: { id: `${input.id}-msg`, type: 'message', role: 'assistant', status: 'in_progress' },
    },
    {
      type: 'response.output_text.delta',
      output_index: 1,
      content_index: 0,
      delta: input.text,
    },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        id: `${input.id}-msg`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: input.text }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: input.id,
        model: input.model,
        status: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          total_tokens: 14,
          cost: 0.00000825,
          cost_details: {
            upstream_inference_cost: 0.00000825,
            upstream_inference_input_cost: 0.000002,
            upstream_inference_output_cost: 0.00000625,
          },
        },
      },
    },
  )
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n')
}

function buildResponsesToolSse(input: {
  id: string
  model: string
  text: string
  toolItems: Array<Record<string, unknown> & { type: string }>
}): string {
  const events: Array<Record<string, unknown> & { type: string }> = [
    {
      type: 'response.created',
      response: { id: input.id, model: input.model, status: 'in_progress' },
    },
  ]
  input.toolItems.forEach((item, index) => {
    events.push(
      {
        type: 'response.output_item.added',
        output_index: index,
        item: { id: item.id, type: item.type, status: 'in_progress' },
      },
      {
        type: 'response.output_item.done',
        output_index: index,
        item,
      },
    )
  })
  const messageIndex = input.toolItems.length
  events.push(
    {
      type: 'response.output_item.added',
      output_index: messageIndex,
      item: { id: `${input.id}-msg`, type: 'message', role: 'assistant', status: 'in_progress' },
    },
    {
      type: 'response.output_text.delta',
      output_index: messageIndex,
      content_index: 0,
      delta: input.text,
    },
    {
      type: 'response.output_item.done',
      output_index: messageIndex,
      item: {
        id: `${input.id}-msg`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: input.text }],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: input.id,
        model: input.model,
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  )
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n')
}

function buildGeminiSse(frames: Array<Record<string, unknown>>): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n')
}

function openRouterModelsPayload(
  modelId: string,
  supportedParameters: string[] = ['provider', 'temperature', 'max_completion_tokens'],
): Record<string, unknown> {
  return {
    data: [
      {
        id: modelId,
        name: modelId,
        context_length: 131_072,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: modelId.includes('gpt') ? 'o200k_base' : 'qwen3',
        },
        pricing: { prompt: '0.00000004', completion: '0.00000008' },
        supported_parameters: supportedParameters,
      },
    ],
  }
}

function openRouterEndpointsPayload(
  modelId: string,
  supportedParameters: string[] = ['provider', 'temperature', 'max_completion_tokens'],
): Record<string, unknown> {
  return {
    data: {
      id: modelId,
      name: modelId,
      context_length: 131_072,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: modelId.includes('gpt') ? 'o200k_base' : 'qwen3',
      },
      endpoints: [
        endpoint('Alpha ZDR', 131_072, supportedParameters),
        endpoint('Budget Clean', 131_072, supportedParameters),
        endpoint('Tiny Context', 1, supportedParameters),
        endpoint('Fast Retain', 131_072, supportedParameters),
        endpoint('Training Host', 131_072, supportedParameters),
        endpoint('UserID Host', 131_072, supportedParameters),
      ],
    },
  }
}

function duplicateAnthropicEndpointsPayload(modelId: string): Record<string, unknown> {
  const supported = ['provider', 'temperature', 'max_completion_tokens']
  return {
    data: {
      id: modelId,
      name: modelId,
      context_length: 131_072,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'claude',
      },
      endpoints: [
        endpoint('Amazon Bedrock', 131_072, supported, {
          tag: 'amazon-bedrock',
          data_policy: policy({}),
        }),
        endpoint('Anthropic', 131_072, supported, {
          tag: 'anthropic/2',
          data_policy: policy({ requiresUserIDs: true }),
        }),
        endpoint('Anthropic', 131_072, supported, {
          tag: 'anthropic',
          data_policy: policy({ requiresUserIDs: true }),
        }),
      ],
    },
  }
}

function longDuplicateProviderEndpointsPayload(modelId: string): Record<string, unknown> {
  const supported = ['provider', 'temperature', 'max_completion_tokens']
  return {
    data: {
      id: modelId,
      name: modelId,
      context_length: 131_072,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'qwen3',
      },
      endpoints: [
        endpoint('Amazon Bedrock', 131_072, supported, {
          tag: 'amazon-bedrock/eu-west-1',
          data_policy: policy({}),
        }),
        endpoint('Amazon Bedrock', 131_072, supported, {
          tag: 'amazon-bedrock/us-east-1',
          data_policy: policy({}),
        }),
        endpoint('Anthropic', 131_072, supported, {
          tag: 'anthropic',
          data_policy: policy({ requiresUserIDs: true }),
        }),
      ],
    },
  }
}

function quantizedDeepSeekEndpointsPayload(modelId: string): Record<string, unknown> {
  const supported = ['provider', 'temperature', 'max_completion_tokens']
  return {
    data: {
      id: modelId,
      name: modelId,
      context_length: 1_048_576,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'deepseek',
      },
      endpoints: [
        endpoint('DeepSeek', 1_048_576, supported, {
          tag: 'deepseek',
          quantization: 'unknown',
          data_policy: policy({}),
        }),
        endpoint('StreamLake', 1_024_000, supported, {
          tag: 'streamlake/fp8',
          quantization: 'fp8',
          data_policy: policy({}),
        }),
        endpoint('DeepInfra', 1_048_576, supported, {
          tag: 'deepinfra/fp4',
          quantization: 'fp4',
          data_policy: policy({}),
        }),
      ],
    },
  }
}

function endpoint(
  provider_name: string,
  context_length: number,
  supported_parameters: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider_name,
    supported_parameters,
    context_length,
    max_prompt_tokens: context_length,
    max_completion_tokens: 4096,
    pricing: { prompt: '0.00000004', completion: '0.00000008' },
    ...overrides,
  }
}

function openRouterPolicies(): Record<string, Record<string, unknown>> {
  return {
    'Alpha ZDR': policy({}),
    'Budget Clean': policy({}),
    'Tiny Context': policy({}),
    'Fast Retain': policy({ retainsPrompts: true, retentionDays: 30 }),
    'Training Host': policy({ training: true }),
    'UserID Host': policy({ requiresUserIDs: true }),
  }
}

function openRouterProviderPolicyRows(): Array<Record<string, unknown>> {
  return Object.entries(openRouterPolicies()).map(([provider_name, data_policy]) => ({
    provider_name,
    data_policy,
  }))
}

function longDuplicateProviderPolicyRows(): Array<Record<string, unknown>> {
  return [
    {
      provider_name: 'Amazon Bedrock',
      provider_slug: 'amazon-bedrock/eu-west-1',
      data_policy: policy({}),
    },
    {
      provider_name: 'Amazon Bedrock',
      provider_slug: 'amazon-bedrock/us-east-1',
      data_policy: policy({}),
    },
    {
      provider_name: 'Anthropic',
      provider_slug: 'anthropic',
      data_policy: policy({ requiresUserIDs: true }),
    },
  ]
}

function quantizedDeepSeekPolicyRows(): Array<Record<string, unknown>> {
  return [
    {
      provider_name: 'DeepSeek',
      provider_slug: 'deepseek',
      data_policy: policy({}),
    },
    {
      provider_name: 'StreamLake',
      provider_slug: 'streamlake/fp8',
      data_policy: policy({}),
    },
    {
      provider_name: 'DeepInfra',
      provider_slug: 'deepinfra/fp4',
      data_policy: policy({}),
    },
  ]
}

function policy(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    training: false,
    trainingOpenRouter: false,
    retainsPrompts: false,
    canPublish: false,
    termsOfServiceURL: '',
    privacyPolicyURL: '',
    ...overrides,
  }
}

function parsePostBody(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

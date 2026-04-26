import { expect, test, type Page } from '@playwright/test'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  readMessages,
  seedFirstRun,
} from './helpers'

const OR_CHAT_MODEL = 'qwen/qwen3-4b'
const OR_RESPONSES_MODEL = 'openai/gpt-5.4'
const GOOGLE_MODEL = 'gemini-3.1-flash-lite-preview'
const LLAMA_MODEL = 'local-qwen3'

type CapturedRequest = {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
}

type PlanEntry = {
  label: string
  payload: Record<string, unknown>
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await page.evaluate(() =>
    (
      window as unknown as { __debugStreams?: { enablePlans(): void } }
    ).__debugStreams?.enablePlans(),
  )
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

  await seedFirstRun(page, { model: OR_RESPONSES_MODEL, disablePrivacyFilter: false })
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
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
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
    | { reasoningDetails?: Array<Record<string, unknown>> }
    | undefined
  const summaries =
    storedAssistant?.reasoningDetails?.filter((detail) => detail.type === 'reasoning.summary') ?? []
  expect(summaries).toHaveLength(1)
  expect(summaries[0]?.summary).toContain('fragment-000 fragment-001 fragment-002')
  expect(summaries[0]?.summary).toContain('fragment-119')

  const plans = await requestPlans(page)
  const sendPlan = findLastPlan(plans, 'send')
  const continuePlan = findLastPlan(plans, 'continue')
  expect(sendPlan.payload.route).toMatchObject({ kind: 'responses' })
  expect(continuePlan.payload.route).toMatchObject({ kind: 'responses' })
  expect(sendPlan.payload.wireShape).toMatchObject({ hasInput: true, hasMessages: false })
  expect(providerSummary(sendPlan).privacy).toMatchObject({ applicable: true })
  expectNoConsoleProblems(consoleLines)
})

test('GUI OpenRouter Text completions posts /completions with a selected template', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockOpenRouterTextCompletions(page, requests)

  await seedFirstRun(page, { model: OR_CHAT_MODEL, disablePrivacyFilter: false })
  await createChatAndOpen(page)
  await openSettingsPanel(page)

  const apiMode = page.locator('[data-ui-section="api-mode"]')
  const textMode = apiMode.getByRole('button', { name: 'Text completions', exact: true })
  await textMode.click()
  await expect(textMode).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('tab', { name: 'Generation' }).click()
  await page.locator('[data-ui="text-template-picker"]').selectOption('raw')
  await page.evaluate(() =>
    (
      window as unknown as {
        __debugStreams?: { clear(): void; clearPlans(): void; enable(): void }
      }
    ).__debugStreams?.enable(),
  )
  await page.evaluate(() =>
    (
      window as unknown as {
        __debugStreams?: { clear(): void; clearPlans(): void; enable(): void }
      }
    ).__debugStreams?.clear(),
  )
  await page.evaluate(() =>
    (
      window as unknown as {
        __debugStreams?: { clear(): void; clearPlans(): void; enable(): void }
      }
    ).__debugStreams?.clearPlans(),
  )

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('OpenRouter text route check')
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
  const streamDump = await page.evaluate(
    () =>
      (
        window as unknown as { __debugStreams?: { disable(): void; last(count?: number): string } }
      ).__debugStreams?.last(20) ?? '',
  )
  expect(streamDump).toContain('[stream-debug]')
  expect(streamDump).toContain('text-completions')
  expect(streamDump).toContain('https://openrouter.ai/api/v1/completions')
  expect(streamDump).toContain('OpenRouter text route check')
  await page.evaluate(() =>
    (
      window as unknown as { __debugStreams?: { disable(): void; last(count?: number): string } }
    ).__debugStreams?.disable(),
  )

  const plans = await requestPlans(page)
  const sendPlan = findLastPlan(plans, 'send')
  expect(sendPlan.payload.profile).toMatchObject({ kind: 'openrouter' })
  expect(sendPlan.payload.route).toMatchObject({ kind: 'text-completions' })
  expect(sendPlan.payload.useTextProtocol).toBe(true)
  expect(sendPlan.payload.request).toMatchObject({
    model: OR_CHAT_MODEL,
    prompt: 'OpenRouter text route check',
    stream: true,
  })
  expect((sendPlan.payload.request as Record<string, unknown>).messages).toBeUndefined()
  expect(sendPlan.payload.wireShape).toMatchObject({
    hasPrompt: true,
    hasMessages: false,
    prompt: { length: 27, preview: 'OpenRouter text route check' },
  })
  expect(providerSummary(sendPlan).privacy).toMatchObject({ applicable: true })
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

  await seedFirstRun(page, { model: OR_CHAT_MODEL, disablePrivacyFilter: false })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await page.getByRole('tab', { name: 'Generation' }).click()

  const tools = page.locator('[data-ui-section="hosted-tools"]')
  await expect(tools).toBeVisible()
  await expect(tools.getByRole('checkbox', { name: 'Web search' })).toBeHidden()
  await tools.locator('summary').click()
  const webSearch = tools.getByRole('checkbox', { name: 'Web search' })
  const datetime = tools.getByRole('checkbox', { name: 'Datetime' })
  await expect(webSearch).toBeEnabled()
  await expect(datetime).toBeEnabled()
  await webSearch.click()
  await expect(webSearch).toBeChecked()
  await datetime.click()
  await expect(datetime).toBeChecked()
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )

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
  await textTools.locator('summary').click()
  await expect(textTools.getByRole('checkbox', { name: 'Web search' })).toBeDisabled()
  await expect(textTools.getByRole('checkbox', { name: 'Datetime' })).toBeDisabled()
  await page.locator('[data-ui="text-template-picker"]').selectOption('raw')
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )

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

  const plans = await requestPlans(page)
  const sendPlan = findLastPlan(plans, 'send')
  expect(sendPlan.payload.profile).toMatchObject({ kind: 'openrouter' })
  expect(sendPlan.payload.route).toMatchObject({ kind: 'text-completions' })
  expect((sendPlan.payload.request as Record<string, unknown>).tools).toBeUndefined()
  expectNoConsoleProblems(consoleLines)
})

test('GUI edit Save & Send reuses provider planning for the edited branch', async ({ page }) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockOpenRouterDiscovery(page, OR_CHAT_MODEL)
  await mockChatCompletionsCapture(page, requests, ['original answer', 'edited answer'])

  await seedFirstRun(page, { model: OR_CHAT_MODEL, disablePrivacyFilter: false })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  const alphaRow = page.locator('[data-ui="provider-picker-row"]').filter({ hasText: 'Alpha ZDR' })
  await expect(alphaRow).toBeVisible()
  await alphaRow.getByLabel('Move down').click()
  await expect(page.locator('[data-ui="provider-picker-row"]').first()).toContainText(
    'Budget Clean',
  )
  await waitForProviderOrder(page, ['Budget Clean', 'Alpha ZDR', 'Tiny Context'])
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )

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
  expect((second?.provider as { order?: string[] }).order?.slice(0, 3)).toEqual([
    'Budget Clean',
    'Alpha ZDR',
    'Tiny Context',
  ])
  expect((second?.provider as { ignore?: string[] }).ignore).toEqual(
    expect.arrayContaining(['Fast Retain', 'Training Host', 'Tiny Context', 'UserID Host']),
  )

  const plans = await requestPlans(page)
  const editPlan = findLastPlan(plans, 'send-from-message')
  const editProvider = providerSummary(editPlan).wire as { order?: string[]; ignore?: string[] }
  expect(editPlan.payload.wireShape).toMatchObject({ hasProvider: true, hasMessages: true })
  expect(editProvider.order?.slice(0, 3)).toEqual(['Budget Clean', 'Alpha ZDR', 'Tiny Context'])
  expect(editProvider.ignore).toEqual(
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

  await seedFirstRun(page, { model: OR_CHAT_MODEL, disablePrivacyFilter: false })
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
  await page.getByLabel('Use Training Host').click()
  await expect(trainingRow).toHaveAttribute('data-allowed', 'true')
  await expect(headerLock).toHaveAttribute('data-privacy-tier', 'red')

  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )
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
  expect(provider.ignore).not.toContain('Training Host')

  const plans = await requestPlans(page)
  const sendPlan = findLastPlan(plans, 'send')
  const plannedProvider = providerSummary(sendPlan).wire as { ignore?: string[] }
  expect(plannedProvider.ignore).not.toContain('Fast Retain')
  expect(plannedProvider.ignore).not.toContain('UserID Host')
  expect(plannedProvider.ignore).not.toContain('Training Host')
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
  await mockChatCompletionsCapture(page, requests, ['duplicate provider ok'])

  await seedFirstRun(page, {
    model: 'anthropic/claude-opus-4.7',
    disablePrivacyFilter: false,
  })
  await createChatAndOpen(page)
  await seedLegacyProviderPrivacy(page, ['Anthropic'])
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

  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('duplicate provider route check')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'duplicate provider ok',
  )

  const provider = requests[0]?.body.provider as { ignore?: string[]; order?: string[] }
  expect(provider.ignore).toEqual(['anthropic/2'])
  expect(provider.order).toBeUndefined()
  const plans = await requestPlans(page)
  const sendPlan = findLastPlan(plans, 'send')
  const plannedProvider = providerSummary(sendPlan).wire as { ignore?: string[]; order?: string[] }
  expect(plannedProvider.ignore).toEqual(['anthropic/2'])
  expect(plannedProvider.order).toBeUndefined()
  expectNoConsoleProblems(consoleLines)
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
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )

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

  const plans = await requestPlans(page)
  const sendPlan = findLastPlan(plans, 'send')
  expect(sendPlan.payload.profile).toMatchObject({ kind: 'google' })
  expect(sendPlan.payload.route).toMatchObject({ kind: 'gemini-generate' })
  expect(providerSummary(sendPlan).wire).toBeNull()
  expect(providerSummary(sendPlan).privacy).toMatchObject({ applicable: false })
  expect(sendPlan.payload.wireShape).toMatchObject({
    hasProvider: false,
    hasSystemInstruction: false,
  })
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
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )

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

  const plans = await requestPlans(page)
  const sendPlan = findLastPlan(plans, 'send')
  expect(sendPlan.payload.profile).toMatchObject({ kind: 'llama-server' })
  expect(sendPlan.payload.useTextProtocol).toBe(true)
  expect(providerSummary(sendPlan).wire).toBeNull()
  expect(providerSummary(sendPlan).privacy).toMatchObject({ applicable: false })
  expect(sendPlan.payload.wireShape).toMatchObject({ hasPrompt: true, hasMessages: false })
  expectNoConsoleProblems(consoleLines)
})

function captureConsole(page: Page): string[] {
  const lines: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('[request-plan]') || msg.type() === 'error' || msg.type() === 'warning') {
      lines.push(`${msg.type()}: ${text}`)
    }
  })
  return lines
}

function expectNoConsoleProblems(lines: string[]): void {
  expect(lines.filter((line) => line.startsWith('error:') || line.startsWith('warning:'))).toEqual(
    [],
  )
  expect(lines.some((line) => line.includes('[request-plan] prepared'))).toBe(true)
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
  kind: 'google' | 'llama-server',
  opts: { key?: string; baseUrl?: string; expectedName: string },
): Promise<void> {
  await page.locator('[data-ui="connection-row"]').click()
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
  await expect(page.locator('[data-ui="connection-name"]')).toContainText(opts.expectedName)
}

async function waitForProviderOrder(page: Page, expected: string[]): Promise<void> {
  await page.waitForFunction(async (order) => {
    const chatId = window.location.hash.match(/^#\/chat\/([^/?#]+)/)?.[1]
    if (!chatId) return false
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
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
  }, expected)
}

async function seedLegacyProviderPrivacy(
  page: Page,
  ignoreProviders: string[],
  onlyProviders: string[] = [],
): Promise<void> {
  await page.evaluate(
    async ({ ignoreProviders, onlyProviders }) => {
      const chatId = window.location.hash.match(/^#\/chat\/([^/?#]+)/)?.[1]
      if (!chatId) throw new Error('missing active chat id')
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('chats', 'readwrite')
          const store = tx.objectStore('chats')
          const req = store.get(chatId)
          req.onsuccess = () => {
            const chat = req.result as
              | { settings?: { privacy?: Record<string, unknown>; providerPrefs?: unknown } }
              | undefined
            if (!chat?.settings?.privacy) {
              reject(new Error('missing chat settings'))
              return
            }
            chat.settings.privacy = {
              ...chat.settings.privacy,
              ignoreProviders,
              onlyProviders,
            }
            delete chat.settings.providerPrefs
            store.put(chat)
          }
          req.onerror = () => reject(req.error)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    },
    { ignoreProviders, onlyProviders },
  )
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
          model: String(body.model ?? ''),
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
              model: String(body.model ?? ''),
              text: 'CJK answer from responses.',
              reasoningFragments: Array.from(
                { length: 120 },
                (_, i) => `fragment-${String(i).padStart(3, '0')} `,
              ),
            })
          : buildResponsesSse({
              id: 'adv-resp-2',
              model: String(body.model ?? ''),
              text: ' Continued via responses.',
              reasoningFragments: [],
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
  const events: Array<Record<string, unknown>> = [
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
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      },
    },
  )
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n')
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

async function requestPlans(page: Page): Promise<PlanEntry[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as { __debugStreams?: { plans(): PlanEntry[] } }
      ).__debugStreams?.plans() ?? [],
  ) as Promise<PlanEntry[]>
}

function findLastPlan(plans: PlanEntry[], source: string): PlanEntry {
  const matches = plans.filter((entry) => entry.payload.source === source)
  expect(matches, `missing request plan for ${source}`).not.toEqual([])
  return matches.at(-1) as PlanEntry
}

function providerSummary(plan: PlanEntry): {
  wire: Record<string, unknown> | null
  contextIgnored: string[]
  privacy: Record<string, unknown>
} {
  return plan.payload.provider as {
    wire: Record<string, unknown> | null
    contextIgnored: string[]
    privacy: Record<string, unknown>
  }
}

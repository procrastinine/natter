import { importPortableChatThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { createChatUiJourneyProfile, expect, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  seedFirstRun,
  seedLinearChat,
} from './helpers'

const OSS_MODEL = 'qwen/qwen3-4b'
const OPENAI_MODEL = 'gpt-4o-mini'
const VIDEO_MODEL = 'google/veo-3.1-lite'
const LONG_OPENROUTER_DRAFT = `GUI OpenRouter route check ${'x'.repeat(2000)}`

type CapturedRequest = {
  url: string
  body: Record<string, unknown>
}

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test('GUI OpenRouter send, Continue, provider overrides, token-cap routing, and preset save stay on the unified planner', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockChatCompletions(page, requests, ['openrouter ok', ' continued'])
  await mockOpenRouterDiscovery(page)

  await seedFirstRun(page, {
    model: OSS_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })

  await createChatAndOpen(page)
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill(LONG_OPENROUTER_DRAFT)
  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui-section="provider-picker"]')).toBeVisible()

  await page.getByRole('tab', { name: 'Context' }).click()
  await expect(page.getByRole('meter', { name: 'Estimated prompt tokens used' })).toContainText('≈')
  await expect(page.locator('[data-ui="context-gauge-breakdown-compact"]')).not.toContainText(
    'draft',
  )
  await page.getByRole('tab', { name: 'Model' }).click()

  await expect(page.getByLabel('Use Tiny Context')).toBeVisible()

  await page.getByRole('radio', { name: 'Throughput' }).click()
  const strict = page.locator('[data-ui="provider-picker-strict"] input')
  await strict.click()
  await expect(strict).toBeChecked()

  const budgetToggle = page.getByLabel('Use Budget Clean')
  await expect(budgetToggle).toBeChecked()
  await budgetToggle.click()
  await expect(budgetToggle).not.toBeChecked()

  await page.locator('[data-ui="preset-breadcrumb-button"]').click()
  await page
    .locator('[data-ui="preset-menu-actions"] [data-ui="field-inline-action"]')
    .first()
    .click()
  await expect(page.locator('[data-ui="preset-breadcrumb-menu"]')).toHaveCount(0)

  await composer.press('Enter')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText('openrouter ok')

  await assistant.locator('[data-action="continue"]').click()
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText(
    'openrouter ok continued',
  )

  expect(requests).toHaveLength(2)
  expect(JSON.stringify(requests[0]?.body.messages)).toContain(LONG_OPENROUTER_DRAFT)
  for (const req of requests) {
    expect(req.url).toContain('/chat/completions')
    expect(req.body.model).toBe(OSS_MODEL)
    const provider = req.body.provider as Record<string, unknown>
    expect(provider).toMatchObject({
      data_collection: 'deny',
      sort: 'throughput',
      require_parameters: true,
    })
    expect(provider.ignore).toEqual(
      expect.arrayContaining([
        'Budget Clean',
        'Fast Retain',
        'Training Host',
        'Tiny Context',
        'UserID Host',
      ]),
    )
  }

  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
})

test('Context resolves the complete long active branch without transcript scrolling', async ({
  page,
}) => {
  await mockOpenRouterDiscovery(page)
  await seedFirstRun(page, {
    model: OSS_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  const chatId = await seedLinearChat(page, {
    messageCount: 160,
    chatId: 'long-context-active-branch',
    title: 'Long context active branch',
    textForIndex: (index) =>
      index === 17
        ? `long context body ${'context unit '.repeat(18_000)}`
        : `short context ${index}`,
    settings: {
      'global:message-initial-render-work': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await expect(page).toHaveURL(new RegExp(`#/chat/${chatId}(?:/message/[^/]+)?$`, 'u'))
  await expect(page.getByText('short context 159', { exact: true })).toBeVisible()
  await page.locator('[data-role="settings-cog"]').click()
  await page.getByRole('tab', { name: 'Context' }).click()

  const meter = page.getByRole('meter', { name: 'Estimated prompt tokens used' })
  await expect(meter).toBeVisible()
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')))
    .toBeGreaterThan(10_000)
})

test('Context reopens from its exact estimate and follows the selected branch', async ({
  page,
}) => {
  await mockOpenRouterDiscovery(page)
  await seedFirstRun(page, {
    model: OSS_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  const fixture = await seedContextBranches(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.branchALeafId}`)
  await expect(page.getByText('context branch A assistant', { exact: true })).toBeVisible()

  await openContextPanel(page)
  const meter = page.getByRole('meter', { name: 'Estimated prompt tokens used' })
  await expect(meter).toBeVisible()
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')))
    .toBeGreaterThan(10_000)
  const exactBranchAEstimate = Number(await meter.getAttribute('aria-valuenow'))

  await page.locator('[data-role="settings-pane-close"]').click()
  await expect(page.locator('[data-ui="chat-model-panel"]')).toHaveCount(0)
  const volatileDraft = `volatile meter-independent draft ${'z'.repeat(20_000)}`
  await page.locator('[data-ui="composer-input"]').fill(volatileDraft)
  await openContextPanel(page)
  await expect(meter).toHaveAttribute('aria-valuenow', String(exactBranchAEstimate))
  await expect(page.getByText('Waiting for prompt estimate…', { exact: true })).toHaveCount(0)

  await page.locator('[data-role="settings-pane-close"]').click()
  await page.locator('[data-ui="composer-input"]').fill('')
  const branchAUser = page
    .locator('[data-ui="message"][data-role="user"]')
    .filter({ hasText: 'context branch A user' })
  await branchAUser.getByLabel('Next variant').click()
  await expect(page.getByText('context branch B assistant', { exact: true })).toBeVisible()

  await openContextPanel(page)
  await expect(meter).toBeVisible()
  await expect
    .poll(async () => Number(await meter.getAttribute('aria-valuenow')))
    .toBeLessThan(exactBranchAEstimate / 10)
  await expect(page.getByText('Waiting for prompt estimate…', { exact: true })).toHaveCount(0)
})

test('GUI OpenAI-compatible send uses Responses and never carries OpenRouter provider/privacy wire', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const responsesRequests: CapturedRequest[] = []
  await mockOpenAiDirect(page, responsesRequests)

  await seedFirstRun(page, { model: OSS_MODEL, disablePrivacyFilter: false })
  await seedLinearChat(page, {
    messageCount: 1,
    chatId: 'openai-direct-routing-chat',
    title: 'OpenAI direct routing chat',
    textPrefix: 'existing public fixture message',
  })
  await addOpenAiConnectionThroughGui(page)

  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui-section="provider-picker"]')).toHaveCount(0)
  await expect(page.locator('[data-ui-section="privacy-section"]')).toHaveCount(0)
  await page.locator('[data-ui="model-picker-search-input"]').fill(OPENAI_MODEL)
  await page
    .locator('[data-ui="picker-row-pick"]')
    .filter({ hasText: OPENAI_MODEL })
    .first()
    .click()

  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('GUI OpenAI direct route check')
  await composer.press('Enter')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toContainText(
    'openai direct ok',
  )

  expect(responsesRequests).toHaveLength(1)
  expect(responsesRequests[0]?.url).toBe('https://api.openai.com/v1/responses')
  expect(responsesRequests[0]?.body.model).toBe(OPENAI_MODEL)
  expect(responsesRequests[0]?.body.provider).toBeUndefined()
  expect(responsesRequests[0]?.body.input).toBeDefined()
  expect(responsesRequests[0]?.body.messages).toBeUndefined()

  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
})

test('GUI OpenRouter video model uses parent /endpoints architecture for UI and send routing', async ({
  page,
  uiJourney,
}) => {
  const consoleLines = captureConsole(page)
  const videoRequests: CapturedRequest[] = []
  const videoDownloads: string[] = []
  let releaseVideoDownloads = () => {}
  const videoDownloadGate = new Promise<void>((resolve) => {
    releaseVideoDownloads = resolve
  })
  await mockOpenRouterDiscovery(page, VIDEO_MODEL)
  await mockOpenRouterVideos(page, videoRequests, videoDownloads, videoDownloadGate)

  await seedFirstRun(page, {
    model: VIDEO_MODEL,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })

  const observerChatId = await seedLinearChat(page, {
    messageCount: 2,
    chatId: 'video-localization-observer',
    title: 'Video localization observer',
  })

  await createChatAndOpen(page)
  const observer = await page.context().newPage()
  await mockOpenRouterVideos(observer, videoRequests, videoDownloads, videoDownloadGate)
  await observer.goto(`/#/chat/${observerChatId}`)
  await expect(observer.locator('[data-ui="app-shell"]')).toHaveAttribute(
    'data-workspace-runtime-state',
    'RUNNING',
  )
  await expect(observer).toHaveURL(new RegExp(`#/chat/${observerChatId}/message/[^/]+$`, 'u'))
  const observerComposerForm = observer.locator(
    'form[data-ui="composer"]:not([data-presentation-only])',
  )
  await expect(observerComposerForm).toBeVisible()
  const observerComposer = observerComposerForm.locator('[data-ui="composer-input"]')
  await observerComposer.fill('local observer draft remains selected')
  await observerComposer.focus()
  const journeyProfile = createChatUiJourneyProfile()
  await uiJourney.start(
    observer,
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
    'remote-generated-output-locality',
  )
  await uiJourney.intent(observer, {
    kind: 'focus-continuity',
    id: 'remote-generated-output-focus',
    selector: '[data-ui="composer-input"]',
    preserveSelection: true,
  })
  await uiJourney.intent(observer, {
    kind: 'follow-bottom',
    id: 'remote-generated-output-scroll',
  })
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('GUI video route check')
  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui-section="api-mode"]')).toHaveCount(0)
  await page.locator('[data-ui="settings-tab"][data-tab="context"]').click()
  await expect(page.locator('[data-ui-section="context-control"]')).toContainText(
    'Video generation does not expose a token context window.',
  )

  const videoMedia = page
    .locator('[data-ui="message"][data-role="assistant"]')
    .first()
    .locator('[data-ui="message-output-media"][data-media="video"]')
  const videoElements = videoMedia.locator('video')
  await composer.press('Enter')
  try {
    await expect(videoMedia).toHaveCount(2)
    expect(
      await videoElements.evaluateAll((nodes) =>
        nodes.map((node) => ({
          src: node.getAttribute('src') ?? '',
          preload: node.getAttribute('preload'),
        })),
      ),
    ).toEqual([
      {
        src: 'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=0',
        preload: 'none',
      },
      {
        src: 'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=1',
        preload: 'none',
      },
    ])

    expect(videoRequests).toHaveLength(1)
    expect(videoRequests[0]?.url).toContain('/videos')
    expect(videoRequests[0]?.body).toMatchObject({
      model: VIDEO_MODEL,
      prompt: 'GUI video route check',
    })
    expect(videoRequests[0]?.body.provider).toMatchObject({ data_collection: 'deny' })
  } finally {
    releaseVideoDownloads()
  }

  const expectedDownloads = [
    'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=0',
    'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=1',
  ]
  await expect.poll(() => [...videoDownloads].sort()).toEqual([...expectedDownloads].sort())
  await expect
    .poll(() =>
      videoElements.evaluateAll((nodes) =>
        nodes.map((node) => (node.getAttribute('src') ?? '').startsWith('blob:')),
      ),
    )
    .toEqual([true, true])

  await expect(observerComposer).toHaveValue('local observer draft remains selected')
  await uiJourney.finish(observer, 'remote-generated-output-localized')
  await observer.close()

  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
})

async function seedContextBranches(page: Page): Promise<{ chatId: string; branchALeafId: string }> {
  const now = Date.now()
  const sourceChatId = 'context-branch-refresh-chat'
  const imported = await importPortableChatThroughUi(page, {
    sourceChatId,
    title: 'Context branch refresh chat',
    createdAt: now,
    updatedAt: now + 5,
    captureMessageIds: true,
    messages: [
      {
        id: 'root',
        chatId: sourceChatId,
        parentId: null,
        siblingIndex: 0,
        turnId: 'turn-root',
        turnIndex: 0,
        createdAt: now,
        role: 'system',
        origin: 'imported',
        content: [{ type: 'text', text: 'context root instruction' }],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'A1',
        chatId: sourceChatId,
        parentId: 'root',
        siblingIndex: 0,
        turnId: 'turn-A1',
        turnIndex: 1,
        createdAt: now + 1,
        role: 'user',
        origin: 'user',
        content: [
          {
            type: 'text',
            text: `context branch A user ${'context unit '.repeat(18_000)}`,
          },
        ],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'A2',
        chatId: sourceChatId,
        parentId: 'A1',
        siblingIndex: 0,
        turnId: 'turn-A2',
        turnIndex: 2,
        createdAt: now + 2,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'context branch A assistant' }],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'B1',
        chatId: sourceChatId,
        parentId: 'root',
        siblingIndex: 1,
        turnId: 'turn-B1',
        turnIndex: 1,
        createdAt: now + 3,
        role: 'user',
        origin: 'user',
        content: [{ type: 'text', text: 'context branch B user' }],
        nodeVersion: 0,
        deleted: false,
      },
      {
        id: 'B2',
        chatId: sourceChatId,
        parentId: 'B1',
        siblingIndex: 0,
        turnId: 'turn-B2',
        turnIndex: 2,
        createdAt: now + 4,
        role: 'assistant',
        origin: 'generated',
        content: [{ type: 'output_text', text: 'context branch B assistant' }],
        nodeVersion: 0,
        deleted: false,
      },
    ],
  })
  const branchALeafId = imported.messageIdMap?.A2
  if (!branchALeafId) throw new Error('Context branch fixture message id missing')
  return { chatId: imported.chatId, branchALeafId }
}

async function openContextPanel(page: Page): Promise<void> {
  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  await page.getByRole('tab', { name: 'Context' }).click()
}

function captureConsole(page: Page): string[] {
  const lines: string[] = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') lines.push(`${msg.type()}: ${msg.text()}`)
  })
  return lines
}

async function mockChatCompletions(
  page: Page,
  requests: CapturedRequest[],
  replies: readonly string[],
): Promise<void> {
  await page.route('**/chat/completions', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body })
    const idx = requests.length - 1
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': `gui-chat-${idx + 1}` },
      body: buildSseBody([
        {
          id: `gui-chat-${idx + 1}`,
          model: stringField(body, 'model'),
          provider: 'Alpha ZDR',
          content: replies[idx] ?? 'ok',
        },
        {
          finish: 'stop',
          usage: {
            prompt_tokens: 12,
            completion_tokens: 2,
            total_tokens: 14,
            cost: 0.000001,
          },
        },
      ]),
    })
  })
}

async function mockOpenAiDirect(page: Page, responsesRequests: CapturedRequest[]): Promise<void> {
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
    responsesRequests.push({ url: route.request().url(), body })
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'x-generation-id': 'gui-resp-1' },
      body: buildResponsesSse('openai direct ok'),
    })
  })
}

async function mockOpenRouterDiscovery(page: Page, modelId: string = OSS_MODEL): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(openRouterModelsPayload(modelId)),
    })
  })
  await page.route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(openRouterEndpointsPayload(modelId)),
    })
  })
  await page.route('**/_or_scrape/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { providers: openRouterProviderPolicyRows(modelId) } },
      })}</script>`,
    })
  })
}

async function mockOpenRouterVideos(
  page: Page,
  requests: CapturedRequest[],
  downloads: string[],
  videoDownloadGate: Promise<void> = Promise.resolve(),
): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/videos/video-gui-1/content**', async (route) => {
    downloads.push(route.request().url())
    await videoDownloadGate
    await route.fulfill({
      status: 200,
      contentType: 'video/mp4',
      body: Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]),
    })
  })
  await page.route('https://openrouter.ai/api/v1/videos', async (route) => {
    const body = parsePostBody(route.request().postData())
    requests.push({ url: route.request().url(), body })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'video-gui-1',
        generation_id: 'video-gui-1',
        polling_url: 'https://openrouter.ai/api/v1/videos/video-gui-1',
        status: 'completed',
        unsigned_urls: [
          'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=0',
          'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=1',
        ],
        usage: { cost: 0.001 },
      }),
    })
  })
}

function buildResponsesSse(text: string): string {
  const events = [
    {
      type: 'response.created',
      response: { id: 'resp_gui', model: OPENAI_MODEL, status: 'in_progress' },
    },
    {
      type: 'response.output_text.delta',
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_gui',
        model: OPENAI_MODEL,
        status: 'completed',
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      },
    },
  ]
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n')
}

function parsePostBody(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function openRouterModelsPayload(modelId: string): Record<string, unknown> {
  if (modelId === VIDEO_MODEL) {
    return {
      data: [
        {
          id: modelId,
          name: 'Veo 3.1 Lite',
          context_length: 0,
          architecture: {
            input_modalities: ['text', 'image'],
            output_modalities: ['video'],
            tokenizer: 'Other',
          },
          pricing: { image: '0.02' },
          supported_parameters: ['max_tokens', 'temperature', 'top_p', 'seed', 'response_format'],
        },
      ],
    }
  }
  return {
    data: [
      {
        id: modelId,
        name: 'Qwen3 4B',
        context_length: 131_072,
        architecture: {
          input_modalities: ['text'],
          output_modalities: ['text'],
          tokenizer: 'qwen3',
        },
        pricing: { prompt: '0.00000004', completion: '0.00000008' },
        supported_parameters: ['temperature', 'max_completion_tokens', 'provider'],
      },
    ],
  }
}

function openRouterEndpointsPayload(modelId: string): Record<string, unknown> {
  if (modelId === VIDEO_MODEL) {
    return {
      data: {
        id: modelId,
        name: 'Veo 3.1 Lite',
        context_length: 0,
        architecture: {
          input_modalities: ['text', 'image'],
          output_modalities: ['video'],
          tokenizer: 'Other',
        },
        endpoints: [
          {
            provider_name: 'Google',
            provider_slug: 'google',
            supported_parameters: ['max_tokens', 'temperature', 'top_p', 'seed'],
            context_length: 0,
            max_prompt_tokens: null,
            max_completion_tokens: null,
            pricing: { image: '0.02' },
          },
        ],
      },
    }
  }
  return {
    data: {
      id: modelId,
      name: 'Qwen3 4B',
      context_length: 131_072,
      architecture: {
        input_modalities: ['text'],
        output_modalities: ['text'],
        tokenizer: 'qwen3',
      },
      endpoints: [
        endpoint('Alpha ZDR', 131_072, 120_000, '0.00000004', '0.00000008'),
        endpoint('Budget Clean', 131_072, 120_000, '0.00000003', '0.00000006'),
        endpoint('Tiny Context', 1, 1, '0.00000002', '0.00000005'),
        endpoint('Fast Retain', 131_072, 120_000, '0.00000005', '0.00000009'),
        endpoint('Training Host', 131_072, 120_000, '0.00000001', '0.00000002'),
        endpoint('UserID Host', 131_072, 120_000, '0.00000004', '0.00000008'),
      ],
    },
  }
}

function endpoint(
  provider_name: string,
  context_length: number,
  max_prompt_tokens: number,
  prompt: string,
  completion: string,
): Record<string, unknown> {
  return {
    provider_name,
    supported_parameters: ['temperature', 'max_completion_tokens'],
    context_length,
    max_prompt_tokens,
    max_completion_tokens: 4096,
    pricing: { prompt, completion },
    quantization: 'bf16',
    uptime_last_30m: 99.9,
    throughput_last_30m: { p50: 120 },
  }
}

function openRouterPolicies(modelId: string = OSS_MODEL): Record<string, Record<string, unknown>> {
  if (modelId === VIDEO_MODEL) {
    return {
      Google: policy({}),
    }
  }
  return {
    'Alpha ZDR': policy({}),
    'Budget Clean': policy({}),
    'Tiny Context': policy({}),
    'Fast Retain': policy({ retainsPrompts: true, retentionDays: 30 }),
    'Training Host': policy({ training: true }),
    'UserID Host': policy({ requiresUserIDs: true }),
  }
}

function openRouterProviderPolicyRows(modelId: string = OSS_MODEL): Array<Record<string, unknown>> {
  return Object.entries(openRouterPolicies(modelId)).map(([provider_name, data_policy]) => ({
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

async function addOpenAiConnectionThroughGui(page: Page): Promise<void> {
  const row = page.locator('[data-ui="connection-row"]')
  if ((await row.count()) === 0) {
    await page.locator('[data-ui="connection-provider-button"]').click()
    await expect(row).toBeVisible()
  }
  if ((await row.getAttribute('aria-expanded')) !== 'true') {
    await row.click()
  }
  await page.locator('[data-ui="connection-new"]').click()
  await page.locator('[data-ui="connection-setup-kind"]').selectOption('openai-compatible')
  await page.locator('[data-ui="connection-setup-key"]').fill('sk-test-openai')
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
}

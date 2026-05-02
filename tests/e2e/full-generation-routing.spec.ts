import { expect, type Page, test } from '@playwright/test'
import { buildSseBody, clearIndexedDb, createChatAndOpen, seedFirstRun } from './helpers'

const OSS_MODEL = 'qwen/qwen3-4b'
const OPENAI_MODEL = 'gpt-4o-mini'
const VIDEO_MODEL = 'google/veo-3.1-lite'
const LONG_OPENROUTER_DRAFT = `GUI OpenRouter route check ${'x'.repeat(2000)}`
const OR_MODELS_QUERY_KEY =
  '{"outputModalities":["audio","file","image","text","video"],"supportedParameters":[]}'
const DIRECT_MODELS_QUERY_KEY = '{"outputModalities":[],"supportedParameters":[]}'

type CapturedRequest = {
  url: string
  body: Record<string, unknown>
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

test('GUI OpenRouter send, Continue, provider overrides, token-cap routing, and preset save stay on the unified planner', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const requests: CapturedRequest[] = []
  await mockChatCompletions(page, requests, ['openrouter ok', ' continued'])
  await mockOpenRouterDiscovery(page)

  await seedFirstRun(page, { model: OSS_MODEL, disablePrivacyFilter: false })
  const profileId = await activeProfileId(page)
  await seedOpenRouterDiscovery(page, profileId, OSS_MODEL)
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )

  await createChatAndOpen(page)
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill(LONG_OPENROUTER_DRAFT)
  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui-section="provider-picker"]')).toBeVisible()

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

  const plans = await requestPlans(page)
  const sendPlan = findPlan(plans, 'send')
  const continuePlan = findPlan(plans, 'continue')
  const sendProvider = providerSummary(sendPlan)
  expect(sendProvider.wire).toMatchObject({
    data_collection: 'deny',
    sort: 'throughput',
    require_parameters: true,
  })
  expect(sendProvider.contextIgnored).toEqual(['Tiny Context'])
  expect(sendProvider.privacy).toMatchObject({
    applicable: true,
    kept: expect.arrayContaining([
      expect.objectContaining({ provider: 'Alpha ZDR' }),
      expect.objectContaining({ provider: 'Budget Clean' }),
      expect.objectContaining({ provider: 'Tiny Context' }),
    ]),
  })
  expect(sendProvider.wire?.ignore).toEqual(
    expect.arrayContaining(['Training Host', 'Fast Retain', 'UserID Host']),
  )
  expect(sendPlan.payload.wireShape).toMatchObject({ hasProvider: true, hasMessages: true })
  expect(continuePlan.payload.route).toMatchObject({ kind: 'chat-completions' })
  expect(providerSummary(continuePlan).contextIgnored).toEqual(['Tiny Context'])
  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
  expect(consoleLines.some((line) => line.includes('[request-plan] prepared'))).toBe(true)
})

test('GUI OpenAI-compatible send uses Responses and never carries OpenRouter provider/privacy wire', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const responsesRequests: CapturedRequest[] = []
  await mockOpenAiDirect(page, responsesRequests)

  await seedFirstRun(page, { model: OSS_MODEL, disablePrivacyFilter: false })
  await createChatAndOpen(page)
  await addOpenAiConnectionThroughGui(page)
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )

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

  const plans = await requestPlans(page)
  const sendPlan = findPlan(plans, 'send')
  expect(sendPlan.payload.profile).toMatchObject({ kind: 'openai-compatible' })
  expect(sendPlan.payload.route).toMatchObject({ kind: 'responses' })
  expect(providerSummary(sendPlan).wire).toBeNull()
  expect(providerSummary(sendPlan).privacy).toMatchObject({
    applicable: false,
    kept: [],
    excluded: [],
  })
  expect(sendPlan.payload.wireShape).toMatchObject({ hasProvider: false, hasInput: true })
  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
})

test('GUI OpenRouter video model uses parent /endpoints architecture for UI and send routing', async ({
  page,
}) => {
  const consoleLines = captureConsole(page)
  const videoRequests: CapturedRequest[] = []
  const videoDownloads: string[] = []
  await mockOpenRouterDiscovery(page, VIDEO_MODEL)
  await mockOpenRouterVideos(page, videoRequests, videoDownloads)

  await seedFirstRun(page, { model: VIDEO_MODEL, disablePrivacyFilter: false })
  const profileId = await activeProfileId(page)
  await seedOpenRouterDiscovery(page, profileId, VIDEO_MODEL)
  await page.evaluate(() =>
    (window as unknown as { __debugStreams?: { clearPlans(): void } }).__debugStreams?.clearPlans(),
  )

  await createChatAndOpen(page)
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('GUI video route check')
  await page.locator('[data-role="settings-cog"]').click()
  await expect(page.locator('[data-ui-section="api-mode"]')).toHaveCount(0)
  await page.locator('[data-ui="settings-tab"][data-tab="context"]').click()
  await expect(page.locator('[data-ui-section="context-control"]')).toContainText(
    'Video generation does not expose a token context window.',
  )

  await composer.press('Enter')
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-output-media"][data-media="video"]'),
  ).toHaveCount(2)

  expect(videoRequests).toHaveLength(1)
  expect(videoRequests[0]?.url).toContain('/videos')
  expect(videoRequests[0]?.body).toMatchObject({
    model: VIDEO_MODEL,
    prompt: 'GUI video route check',
  })
  expect(videoRequests[0]?.body.provider).toMatchObject({ data_collection: 'deny' })
  expect(videoDownloads).toEqual([
    'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=0',
    'https://openrouter.ai/api/v1/videos/video-gui-1/content?index=1',
  ])
  const videoSrcs = await page
    .locator('[data-ui="message-output-media"][data-media="video"] video')
    .evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLVideoElement).currentSrc || node.getAttribute('src') || ''),
    )
  expect(videoSrcs).toHaveLength(2)
  expect(videoSrcs.every((src) => src.startsWith('blob:'))).toBe(true)

  const plans = await requestPlans(page)
  const sendPlan = findPlan(plans, 'send')
  expect(sendPlan.payload.route).toMatchObject({
    kind: 'video-generation',
    transport: 'openrouter-video',
  })
  expect(sendPlan.payload.wireShape).toMatchObject({ hasProvider: true, hasMessages: false })
  expect(providerSummary(sendPlan).privacy).toMatchObject({
    applicable: true,
    kept: [expect.objectContaining({ provider: 'Google' })],
  })
  expect(consoleLines.filter((line) => line.startsWith('error:'))).toEqual([])
})

function captureConsole(page: Page): string[] {
  const lines: string[] = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('[request-plan]') || msg.type() === 'error') {
      lines.push(`${msg.type()}: ${text}`)
    }
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
): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/videos/video-gui-1/content**', async (route) => {
    downloads.push(route.request().url())
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

async function activeProfileId(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<string>((resolve, reject) => {
        const tx = db.transaction('profiles', 'readonly')
        const req = tx.objectStore('profiles').getAll()
        req.onsuccess = () => {
          const rows = (req.result as Array<{ id: string; lastUsedAt?: number }>).sort(
            (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0),
          )
          resolve(rows[0]?.id ?? '')
        }
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
}

async function seedOpenRouterDiscovery(
  page: Page,
  profileId: string,
  modelId: string,
): Promise<void> {
  const modelsPayload = openRouterModelsPayload(modelId)
  const endpointsPayload = openRouterEndpointsPayload(modelId)
  const privacyPayload = { policies: openRouterPolicies(modelId), fetchedAt: Date.now() }
  await page.evaluate(
    async ({
      profileId,
      modelId,
      modelsQueryKey,
      modelsPayload,
      endpointsPayload,
      privacyPayload,
    }) => {
      const now = Date.now()
      const db = await openNatterDb()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['models', 'endpoints', 'privacyPolicies'], 'readwrite')
          tx.objectStore('models').put({
            profileId,
            queryKey: modelsQueryKey,
            fetchedAt: now,
            payload: modelsPayload,
          })
          tx.objectStore('endpoints').put({
            profileId,
            modelId,
            fetchedAt: now,
            payload: endpointsPayload,
          })
          tx.objectStore('privacyPolicies').put({
            profileId,
            modelId,
            fetchedAt: now,
            payload: privacyPayload,
          })
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }

      function openNatterDb(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open('natter')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
      }
    },
    {
      profileId,
      modelId,
      modelsQueryKey: OR_MODELS_QUERY_KEY,
      modelsPayload,
      endpointsPayload,
      privacyPayload,
    },
  )
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
  const profileId = await activeProfileId(page)
  await seedDirectModels(page, profileId)
}

async function seedDirectModels(page: Page, profileId: string): Promise<void> {
  await page.evaluate(
    async ({ profileId, directQueryKey, autoselectQueryKey, modelId }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('models', 'readwrite')
          for (const queryKey of [directQueryKey, autoselectQueryKey]) {
            tx.objectStore('models').put({
              profileId,
              queryKey,
              fetchedAt: Date.now(),
              payload: {
                data: [{ id: modelId, object: 'model', created: 0, owned_by: 'openai' }],
              },
            })
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    },
    {
      profileId,
      directQueryKey: DIRECT_MODELS_QUERY_KEY,
      autoselectQueryKey: OR_MODELS_QUERY_KEY,
      modelId: OPENAI_MODEL,
    },
  )
}

async function requestPlans(page: Page): Promise<PlanEntry[]> {
  return page.evaluate(
    () =>
      (
        window as unknown as { __debugStreams?: { plans(): PlanEntry[] } }
      ).__debugStreams?.plans() ?? [],
  )
}

function findPlan(plans: PlanEntry[], source: string): PlanEntry {
  const plan = plans.find((entry) => entry.payload.source === source)
  expect(plan, `missing request plan for ${source}`).toBeTruthy()
  return plan as PlanEntry
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

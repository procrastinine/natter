import { expect, type Page, test } from './fixtures'
import {
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  readChatRow,
  seedFirstRun,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await mockModelLists(page)
})

test('UI crosswalks Claude between OpenRouter and Anthropic in both directions', async ({
  page,
}) => {
  await seedFirstRun(page, { model: 'anthropic/claude-opus-4.6' })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await expectNoUnavailableBanner(page)

  await addConnectionThroughGui(page, 'anthropic', {
    key: 'sk-ant-test',
    expectedName: 'Anthropic',
  })
  await expectStoredModel(page, 'claude-opus-4.6')
  await expectNoUnavailableBanner(page)

  await switchConnectionThroughGui(page, 'OpenRouter')
  await expectStoredModel(page, 'anthropic/claude-opus-4.6')
  await expectNoUnavailableBanner(page)
})

test('UI crosswalks Gemini between OpenRouter and Google in both directions', async ({ page }) => {
  await seedFirstRun(page, { model: 'google/gemini-3.1-pro-preview' })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await expectNoUnavailableBanner(page)

  await addConnectionThroughGui(page, 'google', {
    key: 'AIza-test',
    expectedName: 'Google',
  })
  await expectStoredModel(page, 'models/gemini-3.1-pro-preview')
  await expectNoUnavailableBanner(page)

  await switchConnectionThroughGui(page, 'OpenRouter')
  await expectStoredModel(page, 'google/gemini-3.1-pro-preview')
  await expectNoUnavailableBanner(page)
})

test('UI crosswalks GPT between OpenRouter and OpenAI in both directions', async ({ page }) => {
  await seedFirstRun(page, { model: 'openai/gpt-5.4' })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await expectNoUnavailableBanner(page)

  await addConnectionThroughGui(page, 'openai-compatible', {
    key: 'sk-test-openai',
    expectedName: 'OpenAI',
  })
  await expectStoredModel(page, 'gpt-5.4')
  await expectNoUnavailableBanner(page)

  await switchConnectionThroughGui(page, 'OpenRouter')
  await expectStoredModel(page, 'openai/gpt-5.4')
  await expectNoUnavailableBanner(page)
})

test('UI does not flash an unavailable warning while clearing a non-equivalent model', async ({
  page,
}) => {
  await seedFirstRun(page, { model: 'openai/gpt-5.4' })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  await expectNoUnavailableBanner(page)

  await startUnavailableWarningRecorder(page)
  await addConnectionThroughGui(page, 'anthropic', {
    key: 'sk-ant-test',
    expectedName: 'Anthropic',
  })
  await expectStoredModel(page, '')
  await expect(page.locator('[data-ui="notice-banner"][data-tone="info"]')).toContainText(
    'Pick a model for',
  )
  await expectNoRecordedUnavailableWarnings(page)
})

test('OpenRouter model switches retain routing and model-row geometry until the new target is ready', async ({
  expectRuntimeDiagnostic,
  page,
}) => {
  expectRuntimeDiagnostic({
    category: 'console-other',
    source: 'console',
    level: 'error',
    message:
      '^Failed to load resource: the server responded with a status of 503 \\(Service Unavailable\\)$',
    count: 1,
  })
  const oldModelId = 'openai/gpt-5.4'
  const newModelId = 'anthropic/claude-opus-4.6'
  const privacyGate = await mockOpenRouterRouting(page, newModelId)
  await seedFirstRun(page, {
    model: oldModelId,
    disablePrivacyFilter: false,
    corsProxyUrl: '/_or_scrape',
  })
  await createChatAndOpen(page)
  await openSettingsPanel(page)

  await expect(page.getByText('Old Model Provider', { exact: true })).toBeVisible()
  await expect(page.locator('[data-ui="picker-row"]').filter({ hasText: newModelId })).toBeVisible()
  const privacyBadge = page.locator('[data-ui="header-privacy-badge"]')
  let recorderStarted = false
  try {
    await startModelSwitchRecorder(page, newModelId)
    recorderStarted = true
    await pickModel(page, newModelId)
    await privacyGate.waitForRequest()
    await expectStoredModel(page, newModelId)
    await expect(page.locator('[data-ui="model-routing-dependent"]')).toHaveAttribute(
      'data-routing-presentation',
      'current',
    )
    const providerSection = page.locator('[data-ui-section="provider-picker"]')
    await expect(providerSection).toHaveAttribute('data-routing-presentation', 'retained')
    await expect(providerSection).toHaveAttribute('inert', '')
    await expect(page.getByText('Old Model Provider', { exact: true })).toHaveCount(1)
    await expect(privacyBadge).toHaveAttribute('data-routing-presentation', 'retained')
    await expect(privacyBadge.locator('[data-ui="icon-button"]')).toBeDisabled()
    expect(await readModelSwitchRecorder(page)).toMatchObject({
      blankRoutingPublications: 0,
      modelOrderChanges: [],
      providerSectionDisconnected: false,
      providerListDisconnected: false,
      privacyBadgeDisconnected: false,
    })

    await privacyGate.fail()
    await expect(providerSection).toHaveAttribute('aria-busy', 'false')
    await expect(providerSection).toHaveAttribute('data-routing-presentation', 'retained')
    await expect(page.getByText('Old Model Provider', { exact: true })).toHaveCount(1)
    const record = await stopModelSwitchRecorder(page)
    recorderStarted = false
    expect(record).toMatchObject({
      blankRoutingPublications: 0,
      modelOrderChanges: [],
      providerSectionDisconnected: false,
      providerListDisconnected: false,
      sameModelRow: true,
      sameProviderSection: true,
      sameProviderList: true,
      privacyBadgeDisconnected: false,
      samePrivacyBadge: true,
    })
    expect(Math.abs(record.modelRowTopDelta)).toBeLessThan(1)
  } finally {
    await privacyGate.fail()
    if (recorderStarted) await stopModelSwitchRecorder(page).catch(() => undefined)
  }
})

test('a failed OpenRouter reload retains stale rows, stays settled across remount, and retries manually', async ({
  expectRuntimeDiagnostic,
  page,
}) => {
  expectRuntimeDiagnostic({
    category: 'console-other',
    source: 'console',
    level: 'error',
    message:
      '^Failed to load resource: the server responded with a status of 503 \\(Service Unavailable\\)$',
    count: 1,
  })
  const staleModelId = 'test/stale-catalog-model'
  const recoveredModelId = 'test/recovered-catalog-model'
  let response: 'initial' | 'failed' | 'recovered' = 'initial'
  let modelRequestCount = 0
  await page.route('https://openrouter.ai/api/v1/models**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/v1/models') {
      await route.fallback()
      return
    }
    modelRequestCount += 1
    if (response === 'failed') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data:
          response === 'initial'
            ? [modelRow(staleModelId)]
            : [modelRow(staleModelId), modelRow(recoveredModelId)],
      }),
    })
  })

  await seedFirstRun(page, { model: staleModelId })
  await createChatAndOpen(page)
  await openSettingsPanel(page)
  const picker = page.locator('[data-ui="model-picker"]')
  const staleRow = picker.locator('[data-ui="picker-row"]').filter({ hasText: staleModelId })
  await expect(staleRow).toBeVisible()
  await expect(picker.getByText('Loading…', { exact: true })).toHaveCount(0)

  await page.evaluate((modelId) => {
    type RecorderWindow = Window & {
      __catalogRefreshRecorder?: {
        observer: MutationObserver
        blankPublications: number
        list: Element
        row: Element
      }
    }
    const picker = document.querySelector('[data-ui="model-picker"]')
    const list = picker?.querySelector('[data-ui="model-picker-list"]')
    const row = [...(picker?.querySelectorAll('[data-ui="picker-row"]') ?? [])].find(
      (candidate) =>
        candidate.querySelector('[data-ui="picker-row-id"]')?.textContent.trim() === modelId,
    )
    if (!picker || !list || !row) throw new Error('CatalogRefreshRecorderTargetMissing')
    const record = {
      observer: null as unknown as MutationObserver,
      blankPublications: 0,
      list,
      row,
    }
    const sample = () => {
      if (
        !record.list.isConnected ||
        !record.row.isConnected ||
        !picker.querySelector('[data-ui="picker-row"]') ||
        picker.textContent.includes('Loading…')
      ) {
        record.blankPublications += 1
      }
    }
    record.observer = new MutationObserver(sample)
    record.observer.observe(picker, { attributes: true, childList: true, subtree: true })
    ;(window as RecorderWindow).__catalogRefreshRecorder = record
    sample()
  }, staleModelId)

  response = 'failed'
  const failedRequest = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/v1/models' && candidate.status() === 503,
  )
  await page.getByRole('button', { name: 'Reload models' }).click()
  await failedRequest
  await expect(picker).toHaveAttribute('aria-busy', 'false')
  await expect(staleRow).toBeVisible()
  await expect(picker.getByText('Loading…', { exact: true })).toHaveCount(0)
  const refreshRecord = await page.evaluate(() => {
    const record = (
      window as Window & {
        __catalogRefreshRecorder?: {
          observer: MutationObserver
          blankPublications: number
          list: Element
          row: Element
        }
      }
    ).__catalogRefreshRecorder
    if (!record) throw new Error('CatalogRefreshRecorderMissing')
    record.observer.disconnect()
    return {
      blankPublications: record.blankPublications,
      sameList: record.list === document.querySelector('[data-ui="model-picker-list"]'),
      sameRow:
        record.row ===
        [...document.querySelectorAll('[data-ui="picker-row"]')].find(
          (candidate) =>
            candidate.querySelector('[data-ui="picker-row-id"]')?.textContent.trim() ===
            'test/stale-catalog-model',
        ),
    }
  })
  expect(refreshRecord).toEqual({ blankPublications: 0, sameList: true, sameRow: true })

  const requestsAfterFailure = modelRequestCount
  await page.locator('[data-role="settings-pane-close"]').click()
  await expect(page.locator('[data-ui="chat-model-panel"]')).toHaveCount(0)
  await openSettingsPanel(page)
  await expect(staleRow).toBeVisible()
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  expect(modelRequestCount).toBe(requestsAfterFailure)

  response = 'recovered'
  const recoveredRequest = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/v1/models' && candidate.status() === 200,
  )
  await page.getByRole('button', { name: 'Reload models' }).click()
  await recoveredRequest
  const recoveredRow = picker
    .locator('[data-ui="picker-row"]')
    .filter({ hasText: recoveredModelId })
  await expect(recoveredRow).toBeVisible()
  await expect(staleRow).toBeVisible()
  await expect(picker).toHaveAttribute('aria-busy', 'false')
  await expect(picker.getByText('Loading…', { exact: true })).toHaveCount(0)
})

async function mockModelLists(page: Page): Promise<void> {
  await page.route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          modelRow('anthropic/claude-opus-4.6'),
          modelRow('google/gemini-3.1-pro-preview'),
          modelRow('openai/gpt-5.4'),
        ],
      }),
    })
  })
  await page.route('https://api.anthropic.com/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: [] }),
    })
  })
  await page.route(
    'https://generativelanguage.googleapis.com/v1beta/openai/models**',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { id: 'models/gemini-3.1-pro-preview', object: 'model', created: 0 },
            { id: 'models/gemini-3.1-flash-lite-preview', object: 'model', created: 0 },
          ],
        }),
      })
    },
  )
  await page.route('https://api.openai.com/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [
          { id: 'gpt-5.4', object: 'model', created: 0 },
          { id: 'gpt-4o', object: 'model', created: 0 },
        ],
      }),
    })
  })
}

async function mockOpenRouterRouting(
  page: Page,
  delayedPrivacyModelId: string,
): Promise<{ waitForRequest(): Promise<void>; fail(): Promise<void> }> {
  let markRequested: () => void = () => undefined
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve
  })
  let releaseFailure: () => void = () => undefined
  const failed = new Promise<void>((resolve) => {
    releaseFailure = resolve
  })
  await page.route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    const path = new URL(route.request().url()).pathname
    const modelId = decodeURIComponent(
      path.slice('/api/v1/models/'.length, path.length - '/endpoints'.length),
    )
    const providerName = modelId === 'openai/gpt-5.4' ? 'Old Model Provider' : 'New Model Provider'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: modelId,
          name: modelId,
          context_length: 200_000,
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
            tokenizer: 'unknown',
          },
          endpoints: [
            {
              provider_name: providerName,
              provider_slug: providerName.toLowerCase().replaceAll(' ', '-'),
              supported_parameters: ['provider', 'max_tokens'],
              context_length: 200_000,
              max_prompt_tokens: 190_000,
              max_completion_tokens: 10_000,
              pricing: { prompt: '0.000001', completion: '0.000002' },
            },
          ],
        },
      }),
    })
  })
  await page.route('**/_or_scrape/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith(`/${delayedPrivacyModelId}/providers`)) {
      markRequested()
      await failed
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'offline' })
      return
    }
    const providerRows = ['Old Model Provider', 'New Model Provider'].map((provider_name) => ({
      provider_name,
      data_policy: {
        training: false,
        trainingOpenRouter: false,
        retainsPrompts: false,
        canPublish: false,
        termsOfServiceURL: '',
        privacyPolicyURL: '',
      },
    }))
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
        props: { pageProps: { providers: providerRows } },
      })}</script>`,
    })
  })
  return {
    waitForRequest: () => requested,
    fail: async () => {
      releaseFailure()
    },
  }
}

async function pickModel(page: Page, modelId: string): Promise<void> {
  await page.locator('[data-ui="picker-row-pick"]').filter({ hasText: modelId }).first().click()
  await expect(page.locator(`[data-ui="picker-row"][data-current="true"]`)).toContainText(modelId)
}

type ModelSwitchRecord = {
  blankRoutingPublications: number
  modelOrderChanges: string[]
  providerSectionDisconnected: boolean
  providerListDisconnected: boolean
  privacyBadgeDisconnected: boolean
  sameModelRow: boolean
  sameProviderSection: boolean
  sameProviderList: boolean
  samePrivacyBadge: boolean
  modelRowTopDelta: number
}

async function startModelSwitchRecorder(page: Page, modelId: string): Promise<void> {
  await page.evaluate((nextModelId) => {
    type Recorder = ModelSwitchRecord & {
      initialModelOrder: string
      initialModelRow: Element
      initialModelRowTop: number
      initialProviderSection: Element
      initialProviderList: Element
      initialPrivacyBadge: Element
      observer: MutationObserver
      summarize: () => ModelSwitchRecord
    }
    type RecorderWindow = Window & { __modelSwitchRecorder?: Recorder }
    const modelRows = () =>
      [...document.querySelectorAll('[data-ui="picker-row"]')]
        .map((row) => row.querySelector('[data-ui="picker-row-id"]')?.textContent.trim() ?? '')
        .join('|')
    const initialModelRow = [...document.querySelectorAll('[data-ui="picker-row"]')].find(
      (row) => row.querySelector('[data-ui="picker-row-id"]')?.textContent.trim() === nextModelId,
    )
    const initialProviderSection = document.querySelector('[data-ui-section="provider-picker"]')
    const initialProviderList = initialProviderSection?.querySelector(
      '[data-ui="provider-picker-list"]',
    )
    const initialPrivacyBadge = document.querySelector('[data-ui="header-privacy-badge"]')
    if (
      !initialModelRow ||
      !initialProviderSection ||
      !initialProviderList ||
      !initialPrivacyBadge
    ) {
      throw new Error('ModelSwitchRecorderTargetMissing')
    }
    const record = {
      blankRoutingPublications: 0,
      modelOrderChanges: [] as string[],
      providerSectionDisconnected: false,
      providerListDisconnected: false,
      privacyBadgeDisconnected: false,
      sameModelRow: true,
      sameProviderSection: true,
      sameProviderList: true,
      samePrivacyBadge: true,
      modelRowTopDelta: 0,
      initialModelOrder: modelRows(),
      initialModelRow,
      initialModelRowTop: initialModelRow.getBoundingClientRect().top,
      initialProviderSection,
      initialProviderList,
      initialPrivacyBadge,
      observer: null as unknown as MutationObserver,
      summarize: null as unknown as () => ModelSwitchRecord,
    }
    const sample = () => {
      const providerSection = document.querySelector('[data-ui-section="provider-picker"]')
      const providerList = providerSection?.querySelector('[data-ui="provider-picker-list"]')
      const order = modelRows()
      if (order !== record.initialModelOrder && !record.modelOrderChanges.includes(order)) {
        record.modelOrderChanges.push(order)
      }
      if (!record.initialProviderSection.isConnected) record.providerSectionDisconnected = true
      if (!record.initialProviderList.isConnected) record.providerListDisconnected = true
      if (!record.initialPrivacyBadge.isConnected) record.privacyBadgeDisconnected = true
      if (
        !providerSection ||
        !providerList ||
        providerList.children.length === 0 ||
        providerSection.textContent.includes('Loading…')
      ) {
        record.blankRoutingPublications += 1
      }
    }
    record.observer = new MutationObserver(sample)
    record.observer.observe(
      document.querySelector('[data-ui="chat-model-panel"]') ?? document.body,
      {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      },
    )
    record.summarize = () => {
      const currentModelRow = document.querySelector('[data-ui="picker-row"][data-current="true"]')
      const currentProviderSection = document.querySelector('[data-ui-section="provider-picker"]')
      const currentProviderList = currentProviderSection?.querySelector(
        '[data-ui="provider-picker-list"]',
      )
      const currentPrivacyBadge = document.querySelector('[data-ui="header-privacy-badge"]')
      return {
        blankRoutingPublications: record.blankRoutingPublications,
        modelOrderChanges: [...record.modelOrderChanges],
        providerSectionDisconnected: record.providerSectionDisconnected,
        providerListDisconnected: record.providerListDisconnected,
        privacyBadgeDisconnected: record.privacyBadgeDisconnected,
        sameModelRow: currentModelRow === record.initialModelRow,
        sameProviderSection: currentProviderSection === record.initialProviderSection,
        sameProviderList: currentProviderList === record.initialProviderList,
        samePrivacyBadge: currentPrivacyBadge === record.initialPrivacyBadge,
        modelRowTopDelta:
          (currentModelRow?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY) -
          record.initialModelRowTop,
      }
    }
    ;(window as RecorderWindow).__modelSwitchRecorder = record
    sample()
  }, modelId)
}

async function readModelSwitchRecorder(page: Page): Promise<ModelSwitchRecord> {
  return page.evaluate(() => {
    const record = (
      window as Window & { __modelSwitchRecorder?: { summarize: () => ModelSwitchRecord } }
    ).__modelSwitchRecorder
    if (!record) throw new Error('ModelSwitchRecorderMissing')
    return record.summarize()
  })
}

async function stopModelSwitchRecorder(page: Page): Promise<ModelSwitchRecord> {
  return page.evaluate(() => {
    const stored = (
      window as Window & {
        __modelSwitchRecorder?: {
          observer: MutationObserver
          summarize: () => ModelSwitchRecord
        }
      }
    ).__modelSwitchRecorder
    if (!stored) throw new Error('ModelSwitchRecorderMissing')
    const record = stored.summarize()
    stored.observer.disconnect()
    delete (
      window as Window & {
        __modelSwitchRecorder?: unknown
      }
    ).__modelSwitchRecorder
    return record
  })
}

function modelRow(id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 200000,
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: id.includes('gpt') ? 'o200k_base' : 'unknown',
    },
    supported_parameters: ['provider', 'max_tokens'],
  }
}

async function openSettingsPanel(page: Page): Promise<void> {
  const panel = page.locator('[data-ui="chat-model-panel"]')
  if ((await panel.count()) === 0) {
    await page.locator('[data-role="settings-cog"]').click()
  }
  await expect(panel).toBeVisible()
  await page.getByRole('tab', { name: 'Model' }).click()
}

async function expectNoUnavailableBanner(page: Page): Promise<void> {
  await openSettingsPanel(page)
  await expect(page.locator('[data-ui="notice-banner"][data-tone="warning"]')).toHaveCount(0)
}

async function startUnavailableWarningRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    type RecorderWindow = Window & {
      __providerCrosswalkWarnings?: string[]
      __providerCrosswalkObserver?: MutationObserver
    }
    const w = window as RecorderWindow
    const warnings: string[] = []
    w.__providerCrosswalkWarnings = warnings
    w.__providerCrosswalkObserver?.disconnect()
    const record = () => {
      for (const el of document.querySelectorAll(
        '[data-ui="notice-banner"][data-tone="warning"]',
      )) {
        const text = el.textContent.trim()
        if (text.includes("isn't served")) warnings.push(text)
      }
    }
    const observer = new MutationObserver(record)
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    w.__providerCrosswalkObserver = observer
    record()
  })
}

async function expectNoRecordedUnavailableWarnings(page: Page): Promise<void> {
  const warnings = await page.evaluate(() => {
    type RecorderWindow = Window & {
      __providerCrosswalkWarnings?: string[]
      __providerCrosswalkObserver?: MutationObserver
    }
    const w = window as RecorderWindow
    w.__providerCrosswalkObserver?.disconnect()
    return w.__providerCrosswalkWarnings ?? []
  })
  expect(warnings).toEqual([])
}

async function addConnectionThroughGui(
  page: Page,
  kind: 'anthropic' | 'google' | 'openai-compatible',
  opts: { key: string; expectedName: string },
): Promise<void> {
  await openConnectionDetail(page)
  await page.locator('[data-ui="connection-new"]').click()
  await page.locator('[data-ui="connection-setup-kind"]').selectOption(kind)
  await page.locator('[data-ui="connection-setup-key"]').fill(opts.key)
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  await expect(page.locator('[data-ui="connection-name"]')).toContainText(opts.expectedName)
}

async function switchConnectionThroughGui(page: Page, profileName: string): Promise<void> {
  await openConnectionDetail(page)
  await page.locator('[data-ui="connection-profile-select"]').selectOption({ label: profileName })
  await expect(page.locator('[data-ui="connection-name"]')).toContainText(profileName)
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

async function expectStoredModel(page: Page, expected: string): Promise<void> {
  await expect
    .poll(async () => {
      const settings = await readLatestChatSettings(page)
      return settings.model
    })
    .toBe(expected)
}

async function readLatestChatSettings(page: Page): Promise<{ model: string; profileId: string }> {
  const chatId = await firstChatId(page)
  const row = (await readChatRow(page, chatId)) as {
    settings?: { model?: string; profileId?: string }
  }
  const settings = row.settings ?? {}
  return { model: settings.model ?? '', profileId: settings.profileId ?? '' }
}

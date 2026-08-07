import { createChatUiJourneyProfile, expect, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  readMessages,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('happy path: streamed SSE renders and persists the final row', async ({ page, uiJourney }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'gen-1', model: 'google/gemini-3.1-flash-lite-preview', content: 'Hello' },
      { content: ' world' },
      {
        finish: 'stop',
        usage: {
          prompt_tokens: 3,
          completion_tokens: 2,
          total_tokens: 5,
          cost: 0.00001,
        },
      },
    ]),
    headers: { 'x-generation-id': 'gen-1' },
  })
  await createChatAndOpen(page)
  await uiJourney.start(page, createChatUiJourneyProfile({ chatHeader: false }), 'send-flow')
  await page.locator('[data-ui="composer-input"]').fill('say hi')
  await expect(page.locator('[data-ui="send"]')).toBeEnabled()
  await uiJourney.intent(page, {
    kind: 'gesture',
    id: 'send-message',
    targetSelector: '[data-ui="send"]',
    expectedRoute: { kind: 'includes', value: '/message/' },
    outcome: { selector: '[data-ui="message"][data-role="assistant"]' },
  })
  await page.locator('[data-ui="send"]').click()
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('Hello world')
  await uiJourney.checkpoint(page, 'assistant-finished')

  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const assistantRow = rows.find((r) => r.role === 'assistant') as {
    content: Array<{ type: string; text: string }>
    generation: { id: string; cost: number; finishReason: string; usage: { total_tokens: number } }
  }
  expect(assistantRow.content).toEqual([{ type: 'output_text', text: 'Hello world' }])
  expect(assistantRow.generation.id).toBe('gen-1')
  expect(assistantRow.generation.finishReason).toBe('stop')
  expect(assistantRow.generation.usage.total_tokens).toBe(5)
  expect(assistantRow.generation.cost).toBeCloseTo(0.00001)
})

test('a second send from a non-root leaf persists through Chromium compound-index ranges', async ({
  page,
}) => {
  let turn = 0
  await page.route('**/api/v1/chat/completions', async (route) => {
    turn += 1
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `compound-range-${turn}`, content: `reply ${turn}`, finish: 'stop' },
      ]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'first turn')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]').first(),
  ).toHaveText('reply 1')

  await sendMessage(page, 'second turn')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]').nth(1),
  ).toHaveText('reply 2')
  const latestAssistant = page.locator('[data-ui="message"][data-role="assistant"]').nth(1)
  await expect(latestAssistant.getByRole('button', { name: 'Regenerate response' })).toBeEnabled()
  const latestUser = page.locator('[data-ui="message"][data-role="user"]').nth(1)
  await latestUser.getByRole('button', { name: 'Edit message' }).click()
  await expect(latestUser.getByRole('button', { name: 'Save & Send' })).toBeEnabled()
  await latestUser.getByRole('button', { name: 'Cancel', exact: true }).click()

  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  expect(rows.map((row) => row.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
})

test.describe('send critical path', () => {
  test('bounds every warm existing-chat preparation phase and provider dispatch', async ({
    page,
  }, testInfo) => {
    let turn = 0
    await page.route('**/api/v1/chat/completions', async (route) => {
      turn += 1
      await route.fulfill({
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: `send-critical-path-${turn}`, content: `reply ${turn}`, finish: 'stop' },
        ]),
      })
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'first turn')
    await expect(
      page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]').first(),
    ).toHaveText('reply 1')
    await waitForAssistantGenerationFinished(page, await firstChatId(page))

    await page.evaluate(() => {
      interface TraceEvent {
        readonly at: number
        readonly kind: string
        readonly detail?: unknown
      }
      interface TraceScope extends Window {
        __sendCriticalPathEvents?: TraceEvent[]
      }
      const scope = window as TraceScope
      const events: TraceEvent[] = []
      scope.__sendCriticalPathEvents = events
      const now = () => performance.timeOrigin + performance.now()
      const record = (kind: string, detail?: unknown) => {
        events.push({ at: now(), kind, ...(detail === undefined ? {} : { detail }) })
      }
      const originalInfo = console.info.bind(console)
      console.info = (...args: unknown[]) => {
        const label = args[0]
        const detail = args[1]
        if (typeof label === 'string' && label.startsWith('[generation-submit]')) {
          record('generation-phase', detail)
        }
        originalInfo(...args)
      }
      const originalFetch = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
        if (url.includes('/api/v1/chat/completions')) record('provider-fetch', url)
        return originalFetch(input, init)
      }
      const lockManager = navigator.locks as
        | (LockManager & { request: (...args: unknown[]) => Promise<unknown> })
        | undefined
      let lockRequestSequence = 0
      record('trace-ready', { webLocks: lockManager !== undefined })
      if (lockManager) {
        const originalLockRequest = lockManager.request.bind(lockManager)
        lockManager.request = (...args: unknown[]) => {
          const name = String(args[0])
          const requestId = ++lockRequestSequence
          const callbackIndex = args.length - 1
          const callback = args[callbackIndex] as (lock: Lock | null) => unknown
          const requestedAt = now()
          args[callbackIndex] = (lock: Lock | null) => {
            record('lock-acquired', {
              name,
              requestId,
              available: lock !== null,
              elapsedMs: now() - requestedAt,
            })
            return callback(lock)
          }
          record('lock-requested', { name, requestId })
          return originalLockRequest(...args)
        }
      }
      document.addEventListener(
        'click',
        (event) => {
          if (event.target instanceof Element && event.target.closest('[data-ui="send"]')) {
            record('send-click')
          }
        },
        { capture: true, once: true },
      )
    })

    await sendMessage(page, 'second turn')
    await expect(
      page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]').nth(1),
    ).toHaveText('reply 2')
    const events = await page.evaluate(() => {
      interface TraceEvent {
        readonly at: number
        readonly kind: string
        readonly detail?: unknown
      }
      return (
        (window as Window & { __sendCriticalPathEvents?: readonly TraceEvent[] })
          .__sendCriticalPathEvents ?? []
      )
    })
    await testInfo.attach('send-critical-path-events.json', {
      body: Buffer.from(JSON.stringify(events, null, 2)),
      contentType: 'application/json',
    })
    const click = events.find((event) => event.kind === 'send-click')
    if (!click) throw new Error('SendCriticalPathClickMissing')
    const providerFetches = events.filter((event) => event.kind === 'provider-fetch')
    expect(providerFetches).toHaveLength(1)
    expect((providerFetches[0]?.at ?? Number.POSITIVE_INFINITY) - click.at).toBeLessThan(750)

    const phaseEvents = events.filter((event) => event.kind === 'generation-phase')
    const phaseDetails = phaseEvents.map((event) => {
      const detail = event.detail as {
        readonly phase?: unknown
        readonly elapsedMs?: unknown
        readonly phaseElapsedMs?: unknown
      }
      if (
        typeof detail.phase !== 'string' ||
        typeof detail.elapsedMs !== 'number' ||
        typeof detail.phaseElapsedMs !== 'number'
      ) {
        throw new Error('SendCriticalPathPhaseInvalid')
      }
      return { ...detail, phase: detail.phase, elapsedMs: detail.elapsedMs }
    })
    expect(phaseDetails.map((detail) => detail.phase)).toEqual([
      'claimed',
      'workspace-requested',
      'workspace-admitted',
      'ownership-requested',
      'repository-requested',
      'local-applied',
      'admitted',
      'settled',
    ])
    for (let index = 1; index < phaseDetails.length; index += 1) {
      expect(phaseDetails[index]?.elapsedMs).toBeGreaterThanOrEqual(
        phaseDetails[index - 1]?.elapsedMs ?? 0,
      )
    }
    const localApplied = phaseDetails.find((detail) => detail.phase === 'local-applied')
    const admitted = phaseDetails.find((detail) => detail.phase === 'admitted')
    expect(localApplied?.elapsedMs).toBeLessThan(400)
    expect(admitted?.elapsedMs).toBeLessThan(450)

    const traceReady = events.find((event) => event.kind === 'trace-ready')?.detail as
      | { readonly webLocks?: unknown }
      | undefined
    if (traceReady?.webLocks === true) {
      const phaseAt = (phase: string) => {
        const at = phaseEvents.find(
          (event) => (event.detail as { readonly phase?: unknown }).phase === phase,
        )?.at
        if (at === undefined) throw new Error(`SendCriticalPathPhaseMissing:${phase}`)
        return at
      }
      const workspaceRequestedAt = phaseAt('workspace-requested')
      const workspaceAdmittedAt = phaseAt('workspace-admitted')
      const ownershipRequestedAt = phaseAt('ownership-requested')
      const repositoryRequestedAt = phaseAt('repository-requested')
      const localAppliedAt = phaseEvents.find(
        (event) => (event.detail as { readonly phase?: unknown }).phase === 'local-applied',
      )?.at
      if (localAppliedAt === undefined) throw new Error('SendCriticalPathLocalAppliedMissing')
      const admissionLockRequests = events.filter(
        (event) =>
          event.kind === 'lock-requested' &&
          event.at >= workspaceRequestedAt &&
          event.at <= workspaceAdmittedAt,
      )
      const ownershipLockRequests = events.filter(
        (event) =>
          event.kind === 'lock-requested' &&
          event.at >= ownershipRequestedAt &&
          event.at <= repositoryRequestedAt,
      )
      const repositoryLockRequests = events.filter(
        (event) =>
          event.kind === 'lock-requested' &&
          event.at >= repositoryRequestedAt &&
          event.at <= localAppliedAt,
      )
      const admissionLockNames = admissionLockRequests.map(
        (event) => (event.detail as { readonly name?: unknown }).name,
      )
      const ownershipLockNames = ownershipLockRequests.map(
        (event) => (event.detail as { readonly name?: unknown }).name,
      )
      const repositoryLockNames = repositoryLockRequests.map(
        (event) => (event.detail as { readonly name?: unknown }).name,
      )
      expect(
        admissionLockNames.filter((name) => name === 'workspace:generation-lifetime'),
      ).toHaveLength(1)
      expect(
        ownershipLockNames.filter((name) => String(name).startsWith('stream-owner:')),
      ).toHaveLength(1)
      expect(repositoryLockNames.filter((name) => name === 'workspace:authoritative')).toHaveLength(
        1,
      )
      expect(
        repositoryLockNames.filter((name) => String(name).startsWith('chat-meta:')),
      ).toHaveLength(1)
      expect(
        repositoryLockNames.filter((name) => String(name).startsWith('message-topology:')),
      ).toHaveLength(1)
      expect(
        repositoryLockNames.filter((name) => String(name).startsWith('message:')),
      ).toHaveLength(1)
      const causalLockRequests = [
        ...admissionLockRequests,
        ...ownershipLockRequests,
        ...repositoryLockRequests,
      ]
      expect(
        causalLockRequests
          .map((event) => (event.detail as { readonly name?: unknown }).name)
          .filter((name) => /^(?:key|preset|profile|setting):/u.test(String(name))),
      ).toEqual([])
      const causalRequestIds = new Set(
        causalLockRequests.map(
          (event) => (event.detail as { readonly requestId?: unknown }).requestId,
        ),
      )
      const acquisitionDurations = events
        .filter(
          (event) =>
            event.kind === 'lock-acquired' &&
            causalRequestIds.has((event.detail as { readonly requestId?: unknown }).requestId),
        )
        .map((event) => (event.detail as { readonly elapsedMs?: unknown }).elapsedMs)
        .filter((value): value is number => typeof value === 'number')
      expect(Math.max(0, ...acquisitionDurations)).toBeLessThan(250)
    }
  })
})

test('delayed stream start keeps the sent turn visible before first bytes arrive', async ({
  page,
}) => {
  let releaseResponse!: () => void
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  let markRequestSeen!: () => void
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markRequestSeen()
    await responseGate
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([{ id: 'gen-delay', content: 'finally started', finish: 'stop' }]),
    })
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'slow network')
  await requestSeen

  const user = page.locator('[data-ui="message"][data-role="user"]').first()
  await expect(user.locator('[data-ui="message-body"]')).toHaveText('slow network')
  await expect(page.locator('[data-ui="message"][data-role="assistant"]').first()).toBeVisible()
  await user.getByRole('button', { name: 'Edit message' }).click()
  await expect(user.getByRole('button', { name: 'Save & Send' })).toBeEnabled()
  await user.getByRole('button', { name: 'Cancel', exact: true }).click()

  const chatId = await firstChatId(page)
  const midRows = await readMessages(page, chatId)
  expect(midRows.map((row) => row.role)).toEqual(['user', 'assistant'])

  releaseResponse()
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('finally started')
})

test('buffered JSON fallback renders the same final content as streaming', async ({ page }) => {
  await mockChatCompletions(page, {
    json: {
      id: 'gen-buf',
      choices: [{ finish_reason: 'stop', message: { content: 'buffered!' } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    },
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'any')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('buffered!')
})

test('mid-stream error frame surfaces ApiError and preserves partial text', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'gen-mid', content: 'half ' },
      { content: 'an answer' },
      { error: { code: 429, message: 'rate limited' } },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'please')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('half an answer')
  const err = assistant.locator('[data-ui="message-error"][data-role="error"]')
  await expect(err).toBeVisible()
  await expect(err).toContainText(/429/)
  await expect(err).toContainText(/rate limited/)
})

test.describe('HTTP error response diagnostics', () => {
  test.use({
    runtimeDiagnosticPolicy: {
      allowances: [
        {
          category: 'console-other',
          message:
            '^Failed to load resource: the server responded with a status of (?:401 \\(Unauthorized\\)|402 \\(Payment Required\\)|503 \\(Service Unavailable\\))$',
        },
      ],
    },
  })

  test('HTTP 401 shows the unauthorized classifier string', async ({ page }) => {
    await mockChatCompletions(page, {
      status: 401,
      json: { error: { code: 401, message: 'Invalid credentials' } },
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'hi')
    const err = page.locator('[data-ui="message-error"][data-role="error"]').first()
    await expect(err).toBeVisible()
    await expect(err).toContainText(/Invalid credentials/)
  })

  test('HTTP 402 payment_required surfaces as error row', async ({ page }) => {
    await mockChatCompletions(page, {
      status: 402,
      json: { error: { code: 402, message: 'insufficient credit' } },
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'hi')
    const err = page.locator('[data-ui="message-error"][data-role="error"]').first()
    await expect(err).toBeVisible()
    await expect(err).toContainText(/insufficient credit/)
  })

  test('HTTP 503 no_provider_available surfaces as error row', async ({ page }) => {
    await mockChatCompletions(page, {
      status: 503,
      json: { error: { code: 503, message: 'no provider free' } },
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'hi')
    const err = page.locator('[data-ui="message-error"][data-role="error"]').first()
    await expect(err).toBeVisible()
    await expect(err).toContainText(/no provider free/)
  })
})

test('network drop mid-stream persists partial text + abortReason=network + Continue affordance', async ({
  page,
}) => {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
      if (!url.includes('/api/v1/chat/completions')) return originalFetch(input, init)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('Network connection dropped'))
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      )
    }
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'drop this')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  const banner = assistant.locator('[data-ui="message-error"][data-role="abort"]')
  await expect(banner).toBeVisible()
  await expect(banner).toHaveAttribute('data-reason', 'network')
  await expect(banner.locator('[data-ui="message-continue"]')).toBeVisible()

  const chatId = await firstChatId(page)
  const rows = await readMessages(page, chatId)
  const assistantRow = rows.find((r) => r.role === 'assistant') as {
    content: Array<{ type: string; text: string }>
    generation: { abortReason?: string; finishedAt?: number }
  }
  expect(assistantRow.generation.abortReason).toBe('network')
  expect(typeof assistantRow.generation.finishedAt).toBe('number')
})

test('malformed SSE JSON records degraded integrity while valid output completes', async ({
  page,
}) => {
  const body = [
    'data: {"id":"g1","choices":[{"delta":{"content":"A"}}]}',
    '',
    'data: {malformed',
    '',
    'data: {"id":"g1","choices":[{"delta":{"content":"B"}}]}',
    '',
    'data: {"id":"g1","choices":[{"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n')
  await mockChatCompletions(page, { body })
  await createChatAndOpen(page)
  await sendMessage(page, 'x')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').first()
  await expect(assistant.locator('[data-ui="message-body"]')).toHaveText('AB')

  const chatId = await firstChatId(page)
  const assistantRow = (await readMessages(page, chatId)).find(
    (row) => row.role === 'assistant',
  ) as {
    generation: {
      status: string
      finishedAt?: number
      abortReason?: string
      error?: unknown
      integrity: string
      integritySummary: {
        count: number
        characterCount: number
        entries: Array<Record<string, unknown>>
      }
    }
  }
  expect(assistantRow.generation.status).toBe('done')
  expect(typeof assistantRow.generation.finishedAt).toBe('number')
  expect(assistantRow.generation.abortReason).toBeUndefined()
  expect(assistantRow.generation.error).toBeUndefined()
  expect(assistantRow.generation.integrity).toBe('degraded')
  expect(assistantRow.generation.integritySummary).toEqual({
    count: 1,
    characterCount: 10,
    entries: [
      {
        category: 'malformed-json-frame',
        adapter: 'chat-completions',
        eventType: 'message',
        count: 1,
        fingerprint: 'fnv1a32:d7b44597',
        characterCount: 10,
      },
    ],
  })
})

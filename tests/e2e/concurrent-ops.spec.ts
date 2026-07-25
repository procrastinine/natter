import type { Route } from '@playwright/test'
import { createChatUiJourneyProfile, expect, type Page, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  holdIndexedDbStoreGate,
  mockChatCompletions,
  readChatRow,
  readMessages,
  seedFirstRun,
  sendMessage,
  startMessageCountRecorder,
  stopMessageCountRecorder,
} from './helpers'

// Phase 7 scope of the §6.11.1 concurrent-ops-during-stream matrix.
// While one tab is streaming, certain ops in another tab/context must NOT
// abort the stream nor corrupt the placeholder, and the stream target must
// remain exclusive.

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('two tabs streaming different chats run in parallel without aborting each other', async ({
  page,
  uiJourney,
}) => {
  // Tab A: create chat #1, open a slow stream.
  await mockChatCompletions(page, {
    delayMs: 1500,
    body: buildSseBody([{ id: 'a', content: 'tab-a-reply' }, { finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'hello-A')
  await expect(page).toHaveURL(/#\/chat\/[^/]+\/message\//u)
  await uiJourney.start(page, createChatUiJourneyProfile(), 'parallel-tab-primary')
  await uiJourney.intent(page, { kind: 'follow-bottom', id: 'parallel-tab-follow' })

  // Tab B — second page in the SAME browser context so IndexedDB is shared
  // (same-origin multi-tab behavior).
  const second = await page.context().newPage()
  await second.goto('/')
  await mockChatCompletions(second, {
    body: buildSseBody([{ id: 'b', content: 'tab-b-reply', finish: 'stop' }]),
  })
  await second.locator('[data-role="new-chat"]').click()
  await second.locator('[data-ui="composer"]').waitFor({ state: 'visible' })
  await second.locator('[data-ui="composer-input"]').fill('hello-B')
  await second.locator('[data-ui="send"]').click()
  await expect(
    second
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('tab-b-reply', { timeout: 5000 })

  // Tab A's slow stream finishes unperturbed — this is the real assertion:
  // tab B's parallel activity does not interrupt tab A's in-flight request.
  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('tab-a-reply', { timeout: 5000 })

  // The shared IndexedDB contains at least two distinct chats.
  const databaseName = await activeWorkspaceDatabaseName(page)
  const chatCount = await page.evaluate(async (databaseName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(databaseName)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<number>((resolve, reject) => {
        const tx = db.transaction('chats', 'readonly')
        const req = tx.objectStore('chats').count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  }, databaseName)
  expect(chatCount).toBeGreaterThanOrEqual(2)
  await uiJourney.checkpoint(page, 'parallel-streams-finished')
  await second.close()
})

test('a send that leaves before its first receipt finishes exactly when returning by sidebar', async ({
  page,
}) => {
  let requestCount = 0
  let releaseBackgroundResponse: () => void = () => undefined
  const backgroundResponseGate = new Promise<void>((resolve) => {
    releaseBackgroundResponse = resolve
  })
  let markBackgroundRequestSeen: () => void = () => undefined
  const backgroundRequestSeen = new Promise<void>((resolve) => {
    markBackgroundRequestSeen = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    if (requestCount === 3) {
      markBackgroundRequestSeen()
      await backgroundResponseGate
    }
    const content =
      requestCount === 3 ? 'background answer survived' : `seed answer ${requestCount}`
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `background-receipt-${requestCount}`, content },
        { finish: 'stop' },
      ]),
    })
  })

  await createChatAndOpen(page)
  await sendMessage(page, 'first chat seed')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]'),
  ).toHaveText('seed answer 1')
  const firstChat = await firstChatId(page)

  await createChatAndOpen(page)
  await sendMessage(page, 'second chat seed')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]'),
  ).toHaveText('seed answer 2')
  const secondChat = await firstChatId(page)
  expect(secondChat).not.toBe(firstChat)

  const sidebarLink = (chatId: string) =>
    page.locator(`[data-ui="chat-row-link"][href="#/chat/${chatId}"]`)
  await sidebarLink(firstChat).click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`#/chat/${firstChat}/message/`)

  await page.locator('[data-ui="composer-input"]').fill('finish while another chat is active')
  await page.evaluate((chatId) => {
    const send = document.querySelector<HTMLButtonElement>('[data-ui="send"]')
    const destination = document.querySelector<HTMLAnchorElement>(
      `[data-ui="chat-row-link"][href="#/chat/${chatId}"]`,
    )
    if (!send || !destination) throw new Error('send or destination control missing')
    // Both events run in one host task, so the send registers its producer but
    // cannot resume past its first await before the destination click navigates.
    send.click()
    destination.click()
  }, secondChat)
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`#/chat/${secondChat}/message/`)
  await backgroundRequestSeen
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`#/chat/${secondChat}/message/`)

  let backgroundAssistantId = ''
  try {
    await expect
      .poll(async () => {
        const rows = await readMessages(page, firstChat)
        const backgroundUser = rows.find(
          (row) =>
            row.role === 'user' &&
            Array.isArray(row.content) &&
            row.content.some(
              (item) =>
                typeof item === 'object' &&
                item !== null &&
                (item as { text?: unknown }).text === 'finish while another chat is active',
            ),
        )
        const assistant = rows.find(
          (row) => row.role === 'assistant' && row.parentId === backgroundUser?.id,
        )
        backgroundAssistantId = typeof assistant?.id === 'string' ? assistant.id : ''
        return {
          rowCount: rows.length,
          assistantId: backgroundAssistantId,
          assistantContent: assistant?.content,
          generationStatus:
            assistant?.generation && typeof assistant.generation === 'object'
              ? (assistant.generation as { status?: unknown }).status
              : undefined,
        }
      })
      .toEqual({
        rowCount: 4,
        assistantId: expect.any(String),
        assistantContent: [],
        generationStatus: 'streaming',
      })
    expect(backgroundAssistantId).not.toBe('')
  } finally {
    releaseBackgroundResponse()
  }
  await expect
    .poll(async () => {
      const rows = await readMessages(page, firstChat)
      const assistant = rows.find(
        (row) =>
          row.role === 'assistant' &&
          Array.isArray(row.content) &&
          row.content.some(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              (item as { text?: unknown }).text === 'background answer survived',
          ),
      )
      const generation =
        assistant?.generation && typeof assistant.generation === 'object'
          ? (assistant.generation as { finishedAt?: unknown; status?: unknown })
          : undefined
      return {
        assistantId: typeof assistant?.id === 'string' ? assistant.id : '',
        finished: typeof generation?.finishedAt === 'number',
        status: generation?.status,
      }
    })
    .toEqual({ assistantId: backgroundAssistantId, finished: true, status: 'done' })
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`#/chat/${secondChat}/message/`)

  const continuity = await page.evaluate(
    async ({ chatId, assistantId, expectedText }) => {
      const main = document.querySelector<HTMLElement>('[data-ui="main-pane"]')
      const destination = document.querySelector<HTMLAnchorElement>(
        `[data-ui="chat-row-link"][href="#/chat/${chatId}"]`,
      )
      if (!main || !destination) throw new Error('main pane or destination control missing')
      const priorMessageIds = new Set(
        Array.from(main.querySelectorAll<HTMLElement>('[data-ui="message"][data-message-id]'))
          .map((message) => message.dataset.messageId)
          .filter((id): id is string => Boolean(id)),
      )
      const result = {
        blankSeen: false,
        loadingSeen: false,
        earlierBranchTailSeen: false,
        targetBodyMismatchSeen: false,
        targetDisappearedAfterSeen: false,
      }
      let targetSeen = false
      let stopped = false
      const targetHash = `#/chat/${chatId}/message/${assistantId}`
      const sample = () => {
        if (!window.location.hash.startsWith(`#/chat/${chatId}`)) return
        const list = main.querySelector<HTMLElement>('[data-ui="message-list"]')
        const messages = Array.from(
          list?.querySelectorAll<HTMLElement>('[data-ui="message"][data-message-id]') ?? [],
        )
        result.blankSeen ||= !list || messages.length === 0
        result.loadingSeen ||= main.querySelector('[data-ui="surface-loading"]') !== null
        const target = messages.find((message) => message.dataset.messageId === assistantId)
        if (target) {
          targetSeen = true
          result.targetBodyMismatchSeen ||=
            target.querySelector('[data-ui="message-body"]')?.textContent !== expectedText
        } else if (targetSeen) {
          result.targetDisappearedAfterSeen = true
        }
        const assistantTail = messages
          .filter((message) => message.dataset.role === 'assistant')
          .at(-1)?.dataset.messageId
        if (assistantTail && assistantTail !== assistantId && !priorMessageIds.has(assistantTail)) {
          result.earlierBranchTailSeen = true
        }
      }
      const observer = new MutationObserver(sample)
      observer.observe(main, { childList: true, subtree: true, characterData: true })
      const sampleFrame = () => {
        sample()
        if (!stopped) requestAnimationFrame(sampleFrame)
      }
      requestAnimationFrame(sampleFrame)
      destination.click()
      try {
        const deadline = performance.now() + 5_000
        let rendered = false
        while (performance.now() < deadline) {
          sample()
          const targetBody = main.querySelector<HTMLElement>(
            `[data-ui="message"][data-message-id="${assistantId}"] [data-ui="message-body"]`,
          )
          if (window.location.hash === targetHash && targetBody?.textContent === expectedText) {
            rendered = true
            break
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }
        if (!rendered) throw new Error('exact background receipt did not render')
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
        sample()
        return result
      } finally {
        stopped = true
        observer.disconnect()
      }
    },
    {
      chatId: firstChat,
      assistantId: backgroundAssistantId,
      expectedText: 'background answer survived',
    },
  )

  expect(continuity).toEqual({
    blankSeen: false,
    loadingSeen: false,
    earlierBranchTailSeen: false,
    targetBodyMismatchSeen: false,
    targetDisappearedAfterSeen: false,
  })
  await expect(
    page.locator(
      `[data-ui="message"][data-message-id="${backgroundAssistantId}"] [data-ui="message-body"]`,
    ),
  ).toHaveText('background answer survived')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/chat/${firstChat}/message/${backgroundAssistantId}`)
  await expect(page.locator('[data-ui="surface-loading"]')).toHaveCount(0)
})

test.describe('same-leaf composer admission', () => {
  test('two tabs cannot turn simultaneous composer sends into an implicit branch', async ({
    page,
  }) => {
    const completionRoute = '**/api/v1/chat/completions'
    await mockChatCompletions(page, {
      body: buildSseBody([
        { id: 'simultaneous-baseline', content: 'baseline answer' },
        { finish: 'stop' },
      ]),
    })
    await createChatAndOpen(page)
    await sendMessage(page, 'baseline')
    const baseline = page.locator('[data-ui="message"][data-role="assistant"]').last()
    await expect(baseline.locator('[data-ui="message-body"]')).toHaveText('baseline answer')
    const chatId = await firstChatId(page)
    const baselineId = await baseline.getAttribute('data-message-id')
    if (!baselineId) throw new Error('baseline assistant has no id')
    await page.unroute(completionRoute)

    const second = await page.context().newPage()
    let releaseResponse!: () => void
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    let requestCount = 0
    const routeCompletion = async (route: Route) => {
      requestCount += 1
      await responseGate
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: 'simultaneous-winner', content: 'accepted answer' },
          { finish: 'stop' },
        ]),
      })
    }
    try {
      await second.goto(`/#/chat/${chatId}/message/${baselineId}`)
      await expect(
        second.locator(`[data-ui="message"][data-message-id="${baselineId}"]`),
      ).toBeVisible()
      await page.route(completionRoute, routeCompletion)
      await second.route(completionRoute, routeCompletion)
      await page.locator('[data-ui="composer-input"]').fill('same-chat A')
      await second.locator('[data-ui="composer-input"]').fill('same-chat B')
      const admissionLockName = `chat-meta:${chatId}`
      await page.evaluate(
        (lockName) =>
          new Promise<void>((ready) => {
            void navigator.locks.request(
              lockName,
              () =>
                new Promise<void>((release) => {
                  ;(
                    window as typeof window & {
                      __releaseE2EAdmissionGate?: () => void
                    }
                  ).__releaseE2EAdmissionGate = release
                  ready()
                }),
            )
          }),
        admissionLockName,
      )

      await Promise.all([
        page.locator('[data-ui="send"]').click(),
        second.locator('[data-ui="send"]').click(),
      ])
      await expect
        .poll(() =>
          page
            .evaluate(async () => {
              const snapshot = await navigator.locks.query()
              return snapshot.pending?.map((entry) => entry.name) ?? []
            })
            .then((names) => names.filter((name) => name === admissionLockName).length),
        )
        .toBe(2)
      await page.evaluate(() => {
        ;(
          window as typeof window & {
            __releaseE2EAdmissionGate?: () => void
          }
        ).__releaseE2EAdmissionGate?.()
      })
      await expect.poll(() => requestCount).toBe(1)
      await expect
        .poll(async () =>
          Promise.all([
            page.locator('[data-ui="composer-input"]').inputValue(),
            second.locator('[data-ui="composer-input"]').inputValue(),
          ]).then((values) => values.filter((value) => value === '').length),
        )
        .toBe(1)
      const composerValues = await Promise.all([
        page.locator('[data-ui="composer-input"]').inputValue(),
        second.locator('[data-ui="composer-input"]').inputValue(),
      ])
      expect(composerValues.filter((value) => value === '')).toHaveLength(1)
      expect(
        composerValues.filter((value) => value === 'same-chat A' || value === 'same-chat B'),
      ).toHaveLength(1)

      releaseResponse()
      const winningPage = composerValues[0] === '' ? page : second
      const losingPage = composerValues[0] === '' ? second : page
      const losingDraft = composerValues[0] === '' ? 'same-chat B' : 'same-chat A'
      await expect(
        winningPage
          .locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]')
          .last(),
      ).toContainText('accepted answer')
      await expect(losingPage.locator('[data-ui="composer-input"]')).toHaveValue(losingDraft)

      await expect
        .poll(async () => (await readMessages(page, chatId)).filter((row) => row.deleted !== true))
        .toHaveLength(4)
      const rows = (await readMessages(page, chatId)).filter((row) => row.deleted !== true)
      const roots = rows.filter((row) => row.parentId === null)
      expect(roots).toHaveLength(1)
      const childrenByParent = new Map<string, Array<Record<string, unknown>>>()
      for (const row of rows) {
        if (typeof row.parentId !== 'string') continue
        const bucket = childrenByParent.get(row.parentId) ?? []
        bucket.push(row)
        childrenByParent.set(row.parentId, bucket)
      }
      expect([...childrenByParent.values()].every((children) => children.length === 1)).toBe(true)

      const roles: unknown[] = []
      let current = roots[0]
      while (current) {
        roles.push(current.role)
        current = childrenByParent.get(String(current.id))?.[0]
      }
      expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    } finally {
      await page.evaluate(() => {
        ;(
          window as typeof window & {
            __releaseE2EAdmissionGate?: () => void
          }
        ).__releaseE2EAdmissionGate?.()
      })
      releaseResponse()
      await second.close()
    }
  })
})

test('one Enter keeps its claimed branch while destination and a remote publication settle', async ({
  page,
  uiJourney,
}) => {
  const completionRoute = '**/api/v1/chat/completions'
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'claimed-destination-baseline', content: 'first variant answer' },
      { finish: 'stop' },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'establish claimed destination')
  const firstVariant = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(firstVariant.locator('[data-ui="message-body"]')).toHaveText('first variant answer')
  const chatId = await firstChatId(page)
  const firstAssistantId = await firstVariant.getAttribute('data-message-id')
  if (!firstAssistantId) throw new Error('first variant assistant has no id')

  await page.unroute(completionRoute)
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'claimed-destination-regenerate', content: 'second variant answer' },
      { finish: 'stop' },
    ]),
  })
  await firstVariant.locator('[data-action="regenerate"]').click()
  const secondVariant = page
    .locator('[data-ui="message"][data-role="assistant"]')
    .filter({ hasText: 'second variant answer' })
  await expect(secondVariant.locator('[data-ui="message-body"]')).toHaveText(
    'second variant answer',
  )
  const secondAssistantId = await secondVariant.getAttribute('data-message-id')
  if (!secondAssistantId) throw new Error('second variant assistant has no id')
  await expect(secondVariant.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')

  const peer = await page.context().newPage()
  let releaseMessages: () => Promise<void> = async () => undefined
  try {
    await peer.goto(`/#/chat/${chatId}/message/${secondAssistantId}`)
    await expect(
      peer.locator(`[data-ui="message"][data-message-id="${secondAssistantId}"]`),
    ).toBeVisible()

    await page.unroute(completionRoute)
    let requestCount = 0
    await page.route(completionRoute, async (route) => {
      requestCount += 1
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: 'claimed-destination-send', content: 'claimed destination answer' },
          { finish: 'stop' },
        ]),
      })
    })
    await uiJourney.start(
      page,
      createChatUiJourneyProfile({ activeSurfaceReady: false }),
      'claimed-send-destination',
    )
    releaseMessages = await holdIndexedDbStoreGate(page, ['messages'])
    const draft = 'send exactly once to the claimed branch'
    const input = page.locator('[data-ui="composer-input"]')
    await input.fill(draft)
    await uiJourney.intent(page, {
      kind: 'gesture',
      id: 'claimed-destination-enter',
      targetSelector: '[data-ui="composer-input"]',
      eventType: 'keydown',
      expectedDeliveries: 1,
      expectedRoute: { kind: 'prefix', value: `/#/chat/${chatId}/message/` },
    })
    await page.evaluate((secondAssistantId) => {
      const first = document.querySelector<HTMLAnchorElement>(
        `[data-ui="message"][data-message-id="${secondAssistantId}"] [data-ui="branch-arrow"][data-role="first"]`,
      )
      const composer = document.querySelector<HTMLTextAreaElement>('[data-ui="composer-input"]')
      if (!first || !composer) throw new Error('branch control or composer missing')
      first.click()
      composer.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    }, secondAssistantId)

    expect(requestCount).toBe(0)
    await expect(input).toHaveValue(draft)
    peer.once('dialog', (dialog) => dialog.accept('Remote during destination settle'))
    await peer.getByLabel('New folder').click()
    await expect(
      page.locator('[data-ui="folder-section"]').filter({
        hasText: 'Remote during destination settle',
      }),
    ).toBeVisible()
    await expect(input).toHaveValue(draft)

    await uiJourney.intent(page, {
      kind: 'route',
      id: 'claimed-destination-send-result',
      expected: { kind: 'prefix', value: `/#/chat/${chatId}/message/` },
    })
    await releaseMessages()
    await expect.poll(() => requestCount).toBe(1)
    await expect(input).toHaveValue('')
    await expect(
      page
        .locator('[data-ui="message"][data-role="assistant"]')
        .filter({ hasText: 'claimed destination answer' }),
    ).toBeVisible()

    const rows = (await readMessages(page, chatId)).filter((row) => row.deleted !== true)
    const submittedUsers = rows.filter(
      (row) =>
        row.role === 'user' &&
        Array.isArray(row.content) &&
        row.content.some(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            (item as { text?: unknown }).text === draft,
        ),
    )
    expect(submittedUsers).toHaveLength(1)
    expect(submittedUsers[0]?.parentId).toBe(firstAssistantId)
    expect(
      rows.filter((row) => row.role === 'assistant' && row.parentId === submittedUsers[0]?.id),
    ).toHaveLength(1)
    await uiJourney.checkpoint(page, 'claimed-send-destination-finished')
  } finally {
    await releaseMessages()
    await peer.close()
  }
})

test('a remote extension then newer sibling keeps each tab on its own branch without flashing', async ({
  page,
  uiJourney,
}) => {
  const completionRoute = '**/api/v1/chat/completions'
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'remote-baseline', content: 'tab-local baseline answer' },
      { finish: 'stop' },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'tab-local baseline')
  const baseline = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(baseline.locator('[data-ui="message-body"]')).toHaveText('tab-local baseline answer')
  const chatId = await firstChatId(page)
  const baselineId = await baseline.getAttribute('data-message-id')
  if (!baselineId) throw new Error('baseline assistant has no id')
  await page.unroute(completionRoute)
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('tab-local draft remains selected')
  await composer.focus()
  const journeyProfile = createChatUiJourneyProfile()
  await uiJourney.start(
    page,
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
    'remote-conversation-locality',
  )
  await uiJourney.intent(page, {
    kind: 'focus-continuity',
    id: 'remote-conversation-focus',
    selector: '[data-ui="composer-input"]',
    preserveSelection: true,
  })
  await uiJourney.intent(page, { kind: 'follow-bottom', id: 'remote-conversation-scroll' })

  const first = page
  const second = await page.context().newPage()
  try {
    await second.goto(`/#/chat/${chatId}/message/${baselineId}`)
    await expect(
      second.locator(`[data-ui="message"][data-message-id="${baselineId}"]`),
    ).toBeVisible()
    await expect
      .poll(() => first.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${baselineId}`)

    await mockChatCompletions(second, {
      body: buildSseBody([
        { id: 'remote-extension', content: 'shared linear extension answer' },
        { finish: 'stop' },
      ]),
    })
    await sendMessage(second, 'shared linear extension')
    const extension = second.locator('[data-ui="message"][data-role="assistant"]').last()
    await expect(extension.locator('[data-ui="message-body"]')).toHaveText(
      'shared linear extension answer',
    )
    const extensionId = await extension.getAttribute('data-message-id')
    if (!extensionId) throw new Error('extension assistant has no id')
    await expect(
      first.locator(`[data-ui="message"][data-message-id="${extensionId}"]`),
    ).toHaveCount(0)
    await expect
      .poll(() => first.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${baselineId}`)
    await expect(
      first.locator(
        `[data-ui="message"][data-message-id="${baselineId}"] [data-ui="branch-count"]`,
      ),
    ).toHaveCount(0)
    await startMessageCountRecorder(first, { commonPrefixMessageIds: [baselineId] })
    await first.evaluate(() => {
      const win = window as typeof window & {
        __remoteTailSamples?: string[]
        __remoteTailObserver?: MutationObserver
      }
      const sample = () => {
        const rows = document.querySelectorAll(
          '[data-ui="message"][data-role="assistant"][data-message-id]',
        )
        const id =
          rows.length === 0 ? null : rows.item(rows.length - 1).getAttribute('data-message-id')
        if (id) win.__remoteTailSamples?.push(id)
      }
      win.__remoteTailSamples = []
      win.__remoteTailObserver = new MutationObserver(sample)
      win.__remoteTailObserver.observe(document.body, { childList: true, subtree: true })
      sample()
    })
    await second.unroute(completionRoute)
    await mockChatCompletions(second, {
      body: buildSseBody([
        { id: 'remote-sibling', content: 'newer sibling answer' },
        { finish: 'stop' },
      ]),
    })
    await extension.locator('[data-action="regenerate"]').click()
    await expect
      .poll(() => second.evaluate(() => window.location.hash))
      .not.toBe(`#/chat/${chatId}/message/${extensionId}`)
    const newerSiblingId = await readRouteMessageId(second, chatId)
    expect(newerSiblingId).not.toBe(extensionId)
    const newerSibling = second.locator(`[data-ui="message"][data-message-id="${newerSiblingId}"]`)
    await expect(newerSibling.locator('[data-ui="message-body"]')).toHaveText(
      'newer sibling answer',
    )
    await expect(
      first.locator(
        `[data-ui="chat-row-link"][href="#/chat/${chatId}"] [data-ui="chat-row-preview"]`,
      ),
    ).toContainText('tab-local baseline')
    await expect
      .poll(() => readChatRow(first, chatId))
      .toMatchObject({
        lastUpdatedLeafId: newerSiblingId,
      })

    const secondAccepted = newerSibling
    await expect(secondAccepted.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')
    await expect(
      first.locator(`[data-ui="message"][data-message-id="${baselineId}"]`),
    ).toBeVisible()
    await expect(
      first.locator(`[data-ui="message"][data-message-id="${extensionId}"]`),
    ).toHaveCount(0)
    await expect(
      first.locator(`[data-ui="message"][data-message-id="${newerSiblingId}"]`),
    ).toHaveCount(0)
    await expect
      .poll(() => first.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${baselineId}`)
    await expect(
      first.locator(
        `[data-ui="message"][data-message-id="${baselineId}"] [data-ui="branch-count"]`,
      ),
    ).toHaveCount(0)
    await expect
      .poll(() => second.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${newerSiblingId}`)
    const remoteTailSamples = await first.evaluate(() => {
      const win = window as typeof window & {
        __remoteTailSamples?: string[]
        __remoteTailObserver?: MutationObserver
      }
      win.__remoteTailObserver?.disconnect()
      return win.__remoteTailSamples ?? []
    })
    expect(remoteTailSamples).toContain(baselineId)
    expect(remoteTailSamples).not.toContain(extensionId)
    expect(remoteTailSamples).not.toContain(newerSiblingId)
    expect(await stopMessageCountRecorder(first)).toEqual({
      anchorRemoved: false,
      listRemoved: false,
      listReplaced: false,
      loadingSeen: false,
      messageCountDecreased: false,
      messageCountsIncludeZero: false,
      minimumMessageCount: expect.any(Number),
      commonPrefixDisconnectedIds: [],
      commonPrefixReplacedIds: [],
      messageCountBelowExpectedCommonPrefix: false,
    })
    await expect(composer).toHaveValue('tab-local draft remains selected')
    await uiJourney.finish(page, 'remote-conversation-published')
  } finally {
    await second.close()
  }
})

test('simultaneous regenerates keep route, cursor, and counts local to each tab', async ({
  page,
}) => {
  const completionRoute = '**/api/v1/chat/completions'
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'regenerate-baseline', content: 'baseline answer' },
      { finish: 'stop' },
    ]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'regenerate in two tabs')
  const baseline = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(baseline.locator('[data-ui="message-body"]')).toHaveText('baseline answer')
  const chatId = await firstChatId(page)
  const baselineId = await baseline.getAttribute('data-message-id')
  if (!baselineId) throw new Error('baseline assistant has no id')
  await page.unroute(completionRoute)

  const second = await page.context().newPage()
  let releaseA!: () => void
  let releaseB!: () => void
  let markRequestedA!: () => void
  let markRequestedB!: () => void
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve
  })
  const gateB = new Promise<void>((resolve) => {
    releaseB = resolve
  })
  const requestedA = new Promise<void>((resolve) => {
    markRequestedA = resolve
  })
  const requestedB = new Promise<void>((resolve) => {
    markRequestedB = resolve
  })
  try {
    await second.goto(`/#/chat/${chatId}/message/${baselineId}`)
    await expect(
      second.locator(`[data-ui="message"][data-message-id="${baselineId}"]`),
    ).toBeVisible()

    await page.route(completionRoute, async (route) => {
      markRequestedA()
      await gateA
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: 'regenerate-a', content: 'answer from tab A' },
          { finish: 'stop' },
        ]),
      })
    })
    await second.route(completionRoute, async (route) => {
      markRequestedB()
      await gateB
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: 'regenerate-b', content: 'answer from tab B' },
          { finish: 'stop' },
        ]),
      })
    })

    await page
      .locator(`[data-ui="message"][data-message-id="${baselineId}"]`)
      .locator('[data-action="regenerate"]')
      .click()
    await requestedA
    const targetA = await readRouteMessageId(page, chatId)

    await second
      .locator(`[data-ui="message"][data-message-id="${baselineId}"]`)
      .locator('[data-action="regenerate"]')
      .click()
    await requestedB
    const targetB = await readRouteMessageId(second, chatId)
    expect(targetB).not.toBe(targetA)

    const branchA = page.locator(`[data-ui="message"][data-message-id="${targetA}"]`)
    const branchB = second.locator(`[data-ui="message"][data-message-id="${targetB}"]`)
    await expect(branchA.locator('[data-ui="branch-count"]')).toHaveText('2 / 3')
    await expect(branchB.locator('[data-ui="branch-count"]')).toHaveText('3 / 3')
    await expect(page.locator(`[data-ui="message"][data-message-id="${targetB}"]`)).toHaveCount(0)
    await expect(second.locator(`[data-ui="message"][data-message-id="${targetA}"]`)).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${targetA}`)
    await expect
      .poll(() => second.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${targetB}`)

    releaseA()
    releaseB()
    await expect(branchA.locator('[data-ui="message-body"]')).toContainText('answer from tab A')
    await expect(branchB.locator('[data-ui="message-body"]')).toContainText('answer from tab B')
    await expect(branchA.locator('[data-ui="branch-count"]')).toHaveText('2 / 3')
    await expect(branchB.locator('[data-ui="branch-count"]')).toHaveText('3 / 3')
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${targetA}`)
    await expect
      .poll(() => second.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${targetB}`)
  } finally {
    releaseA()
    releaseB()
    await second.close()
  }
})

test('bumping lastViewedAt on the active chat from tab B leaves the stream intact', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    delayMs: 1500,
    body: buildSseBody([{ id: 'lv', content: 'viewed-safe' }, { finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'view me')
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  const chatId = await firstChatId(page)

  const peer = await page.context().newPage()
  try {
    await peer.goto(`/#/chat/${chatId}`)
    await expect(peer.locator('[data-ui="chat-title"]')).toBeVisible()
  } finally {
    await peer.close()
  }

  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('viewed-safe', { timeout: 5000 })
})

test('renaming the chat while streaming does not abort the stream', async ({ page }) => {
  await mockChatCompletions(page, {
    delayMs: 1500,
    body: buildSseBody([{ id: 'rn', content: 'renamed-ok' }, { finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'keep streaming')
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  const chatId = await firstChatId(page)

  const peer = await page.context().newPage()
  try {
    await peer.goto(`/#/chat/${chatId}`)
    await peer.locator('[data-role="chat-title-edit"]').click()
    await peer.locator('[data-ui="chat-title-editor"]').fill('Renamed Mid-Stream')
    await peer.locator('[data-ui="chat-title-editor"]').press('Enter')
    await expect(peer.locator('[data-ui="chat-title-label"]')).toHaveText('Renamed Mid-Stream')
  } finally {
    await peer.close()
  }

  await expect(
    page
      .locator('[data-ui="message"][data-role="assistant"]')
      .first()
      .locator('[data-ui="message-body"]'),
  ).toHaveText('renamed-ok', { timeout: 5000 })
})

async function readRouteMessageId(page: Page, chatId: string): Promise<string> {
  const routePrefix = `#/chat/${chatId}/message/`
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toMatch(new RegExp(`^${routePrefix}`))
  const hash = await page.evaluate(() => window.location.hash)
  const messageId = hash.slice(routePrefix.length)
  if (!messageId) throw new Error('active route has no message id')
  return messageId
}

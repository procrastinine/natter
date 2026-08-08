import {
  appendChatCatalogFixturesThroughUi,
  configureWorkspaceThroughUi,
  importPortableChatThroughUi,
} from '../../scripts/workspace-provider-fixture.mjs'
import { expect, type Locator, type Page, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  buildSseBody,
  clearIndexedDb,
  holdIndexedDbStoreGate,
  readMessages,
  seedFirstRun,
  seedLinearChat,
  sendMessage,
  startMessageCountRecorder,
  stopMessageCountRecorder,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('global settings exposes render-window controls on the Performance tab', async ({ page }) => {
  await page.locator('[data-ui="open-global-settings"]').click()
  await page.getByRole('tab', { name: 'Performance' }).click()

  await expect(page.locator('[data-ui="message-render-window-load-mode"]')).toHaveValue('auto')
  await expect(page.locator('[data-ui="sidebar-render-window-load-mode"]')).toHaveValue('auto')
  await expect(page.getByLabel('Initial render work')).toHaveValue('10')
  await expect(page.getByLabel('First rows')).toHaveValue('50')
})

test('opening Appearance settings does not reapply the default chat width', async ({ page }) => {
  await configureWorkspaceThroughUi(page, {
    workspaceSettings: { 'global:chat-max-width': 1280 },
  })
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--message-max-width') === '1280px',
  )
  await page.evaluate(() => {
    const w = window as typeof window & {
      __chatWidthMutations?: string[]
      __chatWidthObserver?: MutationObserver
    }
    w.__chatWidthMutations = []
    w.__chatWidthObserver?.disconnect()
    w.__chatWidthObserver = new MutationObserver(() => {
      w.__chatWidthMutations?.push(
        document.documentElement.style.getPropertyValue('--message-max-width'),
      )
    })
    w.__chatWidthObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })

  await page.locator('[data-ui="open-global-settings"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="appearance"]').click()

  await expect(page.locator('[data-ui="chat-max-width-slider"]')).toHaveValue('1280')
  await page.waitForTimeout(100)
  const mutations = await page.evaluate(() => {
    const w = window as typeof window & {
      __chatWidthMutations?: string[]
      __chatWidthObserver?: MutationObserver
    }
    w.__chatWidthObserver?.disconnect()
    return w.__chatWidthMutations ?? []
  })
  expect(mutations).not.toContain('920px')
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue('--message-max-width')),
    )
    .toBe('1280px')
})

test('send, regenerate, and continue keep the transcript mounted while readiness settles', async ({
  page,
}) => {
  let requestCount = 0
  let releaseSend: () => void = () => undefined
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve
  })
  let markSendRequested: () => void = () => undefined
  const sendRequested = new Promise<void>((resolve) => {
    markSendRequested = resolve
  })
  let releaseRegenerate: () => void = () => undefined
  const regenerateGate = new Promise<void>((resolve) => {
    releaseRegenerate = resolve
  })
  let markRegenerateRequested: () => void = () => undefined
  const regenerateRequested = new Promise<void>((resolve) => {
    markRegenerateRequested = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    if (requestCount === 1) {
      markSendRequested()
      await sendGate
    } else if (requestCount === 2) {
      markRegenerateRequested()
      await regenerateGate
    }
    const text =
      requestCount === 1
        ? 'sent answer'
        : requestCount === 2
          ? 'regenerated answer'
          : 'continued answer'
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `render-window-${requestCount}`, content: text },
        { finish: 'stop' },
      ]),
    })
  })
  const chatId = await seedLinearChat(page, {
    messageCount: 24,
    chatId: 'render-window-chat',
    title: 'Render window chat',
    textPrefix: 'window message',
    settings: {
      'global:message-initial-render-work': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect.poll(() => page.locator('[data-ui="message"]').count()).toBeGreaterThanOrEqual(10)

  await startMessageCountRecorder(page)
  const releaseSendStorage = await holdIndexedDbStoreGate(page, ['messages'])
  try {
    await sendMessage(page, 'new prompt')
    await expect(page.getByRole('button', { name: 'Cancel preparing' })).toBeEnabled()
    await expect(page.locator('[data-ui="message"][data-role="user"]').last()).toContainText(
      'window message 22',
    )
    await expect(page.locator('[data-ui="message-list"]')).not.toHaveAttribute('inert')
    expect(requestCount).toBe(0)
  } finally {
    await releaseSendStorage()
  }
  await sendRequested
  const appendedUser = page.locator('[data-ui="message"][data-role="user"]').last()
  const appendedAssistant = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(appendedUser).toContainText('new prompt')
  await expect(appendedAssistant).toBeVisible()
  const userId = await appendedUser.getAttribute('data-message-id')
  const assistantId = await appendedAssistant.getAttribute('data-message-id')
  if (!userId || !assistantId) throw new Error('Send target has no message id')
  await page.evaluate(
    ({ userId: currentUserId, assistantId: currentAssistantId }) => {
      const win = window as typeof window & {
        __appendedMessageNodes?: Record<string, Element>
      }
      const user = document.querySelector(`[data-ui="message"][data-message-id="${currentUserId}"]`)
      const assistant = document.querySelector(
        `[data-ui="message"][data-message-id="${currentAssistantId}"]`,
      )
      if (!user || !assistant) throw new Error('Appended send rows are not mounted')
      win.__appendedMessageNodes = { user, assistant }
    },
    { userId, assistantId },
  )
  releaseSend()
  await expect(
    page.locator('[data-ui="message"]').last().locator('[data-ui="message-body"]'),
  ).toContainText('sent answer')
  expect(
    await page.evaluate(
      ({ userId, assistantId }) => {
        const win = window as typeof window & {
          __appendedMessageNodes?: Record<string, Element>
        }
        return {
          user:
            document.querySelector(`[data-ui="message"][data-message-id="${userId}"]`) ===
            win.__appendedMessageNodes?.user,
          assistant:
            document.querySelector(`[data-ui="message"][data-message-id="${assistantId}"]`) ===
            win.__appendedMessageNodes?.assistant,
        }
      },
      { userId, assistantId },
    ),
  ).toEqual({ user: true, assistant: true })
  expect(await stopMessageCountRecorder(page)).toEqual({
    anchorRemoved: false,
    listRemoved: false,
    listReplaced: false,
    loadingSeen: false,
    messageCountDecreased: false,
    messageCountsIncludeZero: false,
    minimumBranchControlCount: 0,
    minimumMessageCount: expect.any(Number),
  })

  const previousAssistantId = await page
    .locator('[data-ui="message"][data-role="assistant"]')
    .last()
    .getAttribute('data-message-id')
  if (!previousAssistantId) throw new Error('Regenerate target has no message id')
  await startMessageCountRecorder(page)
  await page.evaluate(() => {
    const win = window as typeof window & {
      __tailAssistantSamples?: string[]
      __tailAssistantObserver?: MutationObserver
    }
    const sample = () => {
      const rows = document.querySelectorAll(
        '[data-ui="message"][data-role="assistant"][data-message-id]',
      )
      const id =
        rows.length === 0 ? null : rows.item(rows.length - 1).getAttribute('data-message-id')
      if (id) win.__tailAssistantSamples?.push(id)
    }
    win.__tailAssistantSamples = []
    win.__tailAssistantObserver = new MutationObserver(sample)
    win.__tailAssistantObserver.observe(document.body, { childList: true, subtree: true })
    sample()
  })
  const releaseRegenerateStorage = await holdIndexedDbStoreGate(page, ['messages'])
  try {
    await page
      .locator('[data-ui="message"][data-role="assistant"]')
      .last()
      .locator('[data-action="regenerate"]')
      .click()
    await expect(page.getByRole('button', { name: 'Cancel preparing' })).toBeEnabled()
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${previousAssistantId}"]`),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${previousAssistantId}`)
    await expect(page.locator('[data-ui="surface-loading"]')).toHaveCount(0)
    await expect(page.locator('[data-ui="message-list"]')).not.toHaveAttribute('inert')
    expect(requestCount).toBe(1)
  } finally {
    await releaseRegenerateStorage()
  }
  await regenerateRequested
  const regeneratedMessage = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect
    .poll(() => regeneratedMessage.getAttribute('data-message-id'))
    .not.toBe(previousAssistantId)
  const activeRegeneratedId = await regeneratedMessage.getAttribute('data-message-id')
  if (!activeRegeneratedId) throw new Error('Regenerate stream has no target message')
  const regeneratedId = activeRegeneratedId
  await page.evaluate((messageId) => {
    const win = window as typeof window & { __regeneratedMessageNode?: Element }
    const message = document.querySelector(`[data-ui="message"][data-message-id="${messageId}"]`)
    if (!message) throw new Error('Regenerated row is not mounted')
    win.__regeneratedMessageNode = message
  }, regeneratedId)
  await expect(
    page.locator(`[data-ui="message"][data-message-id="${regeneratedId}"]`),
  ).toBeVisible()
  await expect(
    page.locator(`[data-ui="message"][data-message-id="${previousAssistantId}"]`),
  ).toHaveCount(0)
  await expect(
    page.locator(
      `[data-ui="message"][data-message-id="${regeneratedId}"] [data-ui="branch-count"]`,
    ),
  ).toHaveText('2 / 2')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/chat/${chatId}/message/${regeneratedId}`)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  const pendingTailSamples = await page.evaluate(() => {
    const win = window as typeof window & { __tailAssistantSamples?: string[] }
    return win.__tailAssistantSamples ?? []
  })
  const firstPendingRegenerated = pendingTailSamples.indexOf(regeneratedId)
  expect(firstPendingRegenerated).toBeGreaterThanOrEqual(0)
  expect(pendingTailSamples.slice(firstPendingRegenerated)).not.toContain(previousAssistantId)
  releaseRegenerate()
  await expect(
    page.locator(
      `[data-ui="message"][data-message-id="${regeneratedId}"] [data-ui="message-body"]`,
    ),
  ).toContainText('regenerated answer')
  expect(
    await page.evaluate((messageId) => {
      const win = window as typeof window & { __regeneratedMessageNode?: Element }
      return (
        document.querySelector(`[data-ui="message"][data-message-id="${messageId}"]`) ===
        win.__regeneratedMessageNode
      )
    }, regeneratedId),
  ).toBe(true)
  await expect(
    page.locator(
      `[data-ui="message"][data-message-id="${regeneratedId}"] [data-ui="branch-count"]`,
    ),
  ).toHaveText('2 / 2')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/chat/${chatId}/message/${regeneratedId}`)
  const tailSamples = await page.evaluate(() => {
    const win = window as typeof window & {
      __tailAssistantSamples?: string[]
      __tailAssistantObserver?: MutationObserver
    }
    win.__tailAssistantObserver?.disconnect()
    return win.__tailAssistantSamples ?? []
  })
  const firstRegenerated = tailSamples.indexOf(regeneratedId)
  expect(firstRegenerated).toBeGreaterThanOrEqual(0)
  expect(tailSamples.slice(firstRegenerated)).not.toContain(previousAssistantId)
  expect(await stopMessageCountRecorder(page)).toEqual({
    anchorRemoved: false,
    listRemoved: false,
    listReplaced: false,
    loadingSeen: false,
    messageCountDecreased: false,
    messageCountsIncludeZero: false,
    minimumBranchControlCount: 0,
    minimumMessageCount: expect.any(Number),
  })
  expect(requestCount).toBe(2)

  const continuedMessage = page.locator(`[data-ui="message"][data-message-id="${regeneratedId}"]`)
  const continueButton = continuedMessage.locator('[data-action="continue"]')
  const releaseContinueStorage = await holdIndexedDbStoreGate(page, ['messages'])
  try {
    await continueButton.click()
    await expect(continueButton).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Cancel preparing' })).toBeEnabled()
    await expect(continuedMessage).toBeVisible()
    await expect(continuedMessage.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${regeneratedId}`)
    expect(requestCount).toBe(2)
  } finally {
    await releaseContinueStorage()
  }
  await expect.poll(() => requestCount).toBe(3)
  await expect(continuedMessage.locator('[data-ui="message-body"]')).toContainText(
    'continued answer',
  )
  await expect(continuedMessage.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/chat/${chatId}/message/${regeneratedId}`)
})

test('trailing-user Reply appends without replacing the mounted transcript prefix', async ({
  page,
}) => {
  await page.route('**/api/v1/chat/completions', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: 'continuity-reply', content: 'reply continuity answer' },
        { finish: 'stop' },
      ]),
    }),
  )
  const chatId = await seedLinearChat(page, {
    messageCount: 5,
    chatId: 'trailing-reply-continuity-chat',
    title: 'Trailing reply continuity chat',
    textPrefix: 'reply continuity message',
    settings: {
      'global:message-initial-render-work': 5,
      'global:message-render-window-load-mode': 'manual',
    },
  })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const messages = page.locator('[data-ui="message"][data-message-id]')
  await expect(messages).toHaveCount(5)
  const commonPrefixMessageIds = await mountedMessageIds(messages)

  await startMessageCountRecorder(page, { commonPrefixMessageIds })
  const reply = page.locator('[data-ui="send"]')
  await expect(reply).toContainText('Reply')
  await reply.click()
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]').last(),
  ).toHaveText('reply continuity answer')

  const continuity = await stopMessageCountRecorder(page)
  expectCommonPrefixContinuity(continuity, commonPrefixMessageIds.length)
  expect(continuity.messageCountDecreased).toBe(false)
  await expect(messages).toHaveCount(6)
})

test('Save & Send preserves common-prefix DOM identity while replacing only the suffix', async ({
  page,
}) => {
  await page.route('**/api/v1/chat/completions', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: 'continuity-save-send', content: 'save-send continuity answer' },
        { finish: 'stop' },
      ]),
    }),
  )
  const chatId = await seedLinearChat(page, {
    messageCount: 8,
    chatId: 'save-send-continuity-chat',
    title: 'Save and send continuity chat',
    textPrefix: 'save-send continuity message',
    settings: {
      'global:message-initial-render-work': 8,
      'global:message-render-window-load-mode': 'manual',
    },
  })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  const messages = page.locator('[data-ui="message"][data-message-id]')
  await expect(messages).toHaveCount(8)
  const initialMessageIds = await mountedMessageIds(messages)
  const commonPrefixMessageIds = initialMessageIds.slice(0, 4)
  const replacedSuffixMessageIds = initialMessageIds.slice(4)
  const editedUser = messages.nth(4)
  await editedUser.locator('[data-action="edit"]').click()
  await editedUser.locator('[data-ui="inline-editor-input"]').fill('save-send replacement user')

  await startMessageCountRecorder(page, { commonPrefixMessageIds })
  await editedUser.locator('[data-role="save-send"]').click()
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]').last(),
  ).toHaveText('save-send continuity answer')

  const continuity = await stopMessageCountRecorder(page)
  expectCommonPrefixContinuity(continuity, commonPrefixMessageIds.length)
  for (const messageId of replacedSuffixMessageIds) {
    await expect(page.locator(`[data-ui="message"][data-message-id="${messageId}"]`)).toHaveCount(0)
  }
  await expect(messages).toHaveCount(6)
  await expect(messages.nth(4).locator('[data-ui="message-body"]')).toHaveText(
    'save-send replacement user',
  )
})

test('branch swipe preserves common-prefix DOM identity without loading or blank frames', async ({
  page,
}) => {
  const fixture = await seedBranchedChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.messageIdMap.A2}`)
  await page.reload()
  const messages = page.locator('[data-ui="message"][data-message-id]')
  await expect(messages).toHaveCount(3)
  const commonPrefixMessageIds = [fixture.messageIdMap.root as string]
  const selectedUserText = await messages.nth(1).textContent()
  const selectedBranchIsA = selectedUserText?.includes('branch A user') === true
  const selectedUser = selectedBranchIsA ? 'branch A user' : 'branch B user'
  const destinationUser = selectedBranchIsA ? 'branch B user' : 'branch A user'
  const destinationAssistant = selectedBranchIsA ? 'branch B assistant' : 'branch A assistant'
  const swipeLabel = selectedBranchIsA ? 'Next variant' : 'First variant'
  const returnLabel = selectedBranchIsA ? 'Previous variant' : 'Last variant'

  await expect(messages.nth(1).locator('[data-ui="branch-controls"]')).toBeVisible()
  await startMessageCountRecorder(page, { commonPrefixMessageIds })
  await messages.filter({ hasText: selectedUser }).getByLabel(swipeLabel).click()
  await expect(messages.nth(1)).toContainText(destinationUser)
  await expect(messages.nth(2)).toContainText(destinationAssistant)
  const destinationPosition = selectedBranchIsA ? '2 / 2' : '1 / 2'
  await expect(messages.nth(1).locator('[data-ui="branch-controls"]')).toContainText(
    destinationPosition,
  )
  await expect(page.locator('[data-ui="message-list"]')).not.toHaveAttribute(
    'data-presentation-only',
  )
  await messages.nth(1).getByLabel(returnLabel).click()
  await expect(messages.nth(1)).toContainText(selectedUser)
  const returnPosition = selectedBranchIsA ? '1 / 2' : '2 / 2'
  await expect(messages.nth(1).locator('[data-ui="branch-controls"]')).toContainText(returnPosition)

  const continuity = await stopMessageCountRecorder(page)
  expectCommonPrefixContinuity(continuity, commonPrefixMessageIds.length)
  expect(continuity.messageCountsIncludeZero).toBe(false)
  expect(continuity.minimumBranchControlCount).toBeGreaterThan(0)
  await expect(messages).toHaveCount(3)
})

test('an edited variant reports deferred navigation and can restore its retained branch', async ({
  page,
}) => {
  const fixture = await seedBranchedChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.messageIdMap.A2}`)
  await page.reload()

  const edited = page.locator(`[data-ui="message"][data-message-id="${fixture.messageIdMap.A1}"]`)
  await edited.getByRole('button', { name: 'Edit message' }).click()
  await edited.locator('[data-ui="inline-editor-input"]').fill('retained branch A draft')
  await edited.getByLabel('Next variant').click()

  await expect(page).toHaveURL(new RegExp(`/message/${fixture.messageIdMap.B2}$`))
  await expect(edited.locator('[data-ui="inline-editor-input"]')).toHaveValue(
    'retained branch A draft',
  )
  const status = page.locator('[data-ui="retained-editor-navigation"]')
  await expect(status).toContainText('keeping this branch visible')
  await expect(status.getByRole('button', { name: 'Return to edited branch' })).toBeEnabled()

  await status.getByRole('button', { name: 'Return to edited branch' }).click()
  await expect(page).toHaveURL(new RegExp(`/message/${fixture.messageIdMap.A2}$`))
  await expect(status).toHaveCount(0)
  await expect(edited.locator('[data-ui="inline-editor-input"]')).toHaveValue(
    'retained branch A draft',
  )
  await expect(page.locator('[data-ui="message-list"]')).not.toHaveAttribute(
    'data-presentation-only',
  )

  await edited.getByLabel('Next variant').click()
  await expect(status).toBeVisible()
  await edited.locator('[data-role="cancel"]').click()
  await expect(status).toHaveCount(0)
  await expect(
    page.locator(`[data-ui="message"][data-message-id="${fixture.messageIdMap.B1}"]`),
  ).toContainText('branch B user')
})

test('a retained later editor does not retain settled Save & Send lifecycle controls', async ({
  page,
}) => {
  let requestCount = 0
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: 'multi-editor-current-lifecycle', content: 'current lifecycle answer' },
        { finish: 'stop' },
      ]),
    })
  })
  const chatId = await seedLinearChat(page, {
    chatId: 'retained-editor-current-lifecycle',
    messageCount: 4,
    textPrefix: 'retained lifecycle row',
  })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()

  const messages = page.locator('[data-ui="message"][data-message-id]')
  await expect(messages).toHaveCount(4)
  const firstUser = messages.nth(0)
  const laterUser = messages.nth(2)
  await laterUser.getByRole('button', { name: 'Edit message' }).click()
  await laterUser.locator('[data-ui="inline-editor-input"]').fill('unsaved later draft')
  await firstUser.getByRole('button', { name: 'Edit message' }).click()
  await firstUser.locator('[data-ui="inline-editor-input"]').fill('earlier replacement')
  await firstUser.locator('[data-role="save-send"]').click()

  await expect.poll(() => requestCount).toBe(1)
  await expect(laterUser.locator('[data-ui="inline-editor-input"]')).toHaveValue(
    'unsaved later draft',
  )
  await expect(page.locator('[data-ui="retained-editor-navigation"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel preparing' })).toHaveCount(0)
  await expect
    .poll(async () => {
      const rows = await readMessages(page, chatId)
      return rows.some((row) =>
        Array.isArray(row.content)
          ? row.content.some(
              (part) =>
                typeof part === 'object' &&
                part !== null &&
                (part as { text?: unknown }).text === 'current lifecycle answer',
            )
          : false,
      )
    })
    .toBe(true)

  await laterUser.locator('[data-role="cancel"]').click()
  await expect(page.locator('[data-ui="retained-editor-navigation"]')).toHaveCount(0)
  await expect(messages).toHaveCount(2)
  await expect(messages.nth(0).locator('[data-ui="message-body"]')).toHaveText(
    'earlier replacement',
  )
  await expect(messages.nth(1).locator('[data-ui="message-body"]')).toHaveText(
    'current lifecycle answer',
  )
  expect(requestCount).toBe(1)
})

test('retained imported rows repeatedly own Save & Send and delete across branch resolution', async ({
  page,
}) => {
  let requestCount = 0
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    const responseNumber = requestCount
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        {
          id: `retained-imported-row-${responseNumber}`,
          content: `retained row answer ${responseNumber}`,
        },
        { finish: 'stop' },
      ]),
    })
  })
  const fixture = await seedBranchedChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.messageIdMap.A2}`)
  await page.reload()

  const messages = page.locator('[data-ui="message"][data-message-id]')
  await expect(messages).toHaveCount(3)
  const retainedUser = page.locator(
    `[data-ui="message"][data-message-id="${fixture.messageIdMap.A1}"]`,
  )
  let replacement = page.locator('[data-ui="message"][data-role="user"]').filter({
    hasText: 'replacement not created',
  })
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) {
      await replacement.getByLabel('First variant').click()
      await expect(retainedUser).toContainText('branch A user')
    }
    await expect(retainedUser.locator('[data-ui="branch-controls"]')).toContainText(
      `1 / ${attempt + 1}`,
    )
    await expect(retainedUser.getByRole('button', { name: 'Edit message' })).toBeEnabled()
    await expect(retainedUser.getByRole('button', { name: 'Delete message' })).toBeEnabled()
    await retainedUser.getByRole('button', { name: 'Edit message' }).click()
    await expect(retainedUser.locator('[data-ui="inline-editor-input"]')).toBeVisible()
    await retainedUser
      .locator('[data-ui="inline-editor-input"]')
      .fill(`retained imported replacement ${attempt}`)
    const releaseMessages = await holdIndexedDbStoreGate(page, ['messages'])
    try {
      await retainedUser.getByLabel('Next variant').click()
      await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
        'data-presentation-only',
        'true',
      )
      await expect(retainedUser.locator('[data-ui="branch-controls"]')).toBeVisible()
      const saveAndSend = retainedUser.getByRole('button', { name: 'Save & Send' })
      await expect(saveAndSend).toBeEnabled()
      await saveAndSend.click()
      await expect(saveAndSend).toBeEnabled()
      await expect(retainedUser.locator('[data-ui="inline-editor"]')).toHaveAttribute(
        'aria-busy',
        'true',
      )
      await expect(retainedUser.locator('[data-ui="inline-editor-generation-error"]')).toHaveCount(
        0,
      )
      expect(requestCount).toBe(attempt - 1)
    } finally {
      await releaseMessages()
    }

    await expect(
      page
        .locator('[data-ui="message"][data-role="assistant"]')
        .filter({ hasText: `retained row answer ${attempt}` }),
    ).toBeVisible()
    expect(requestCount).toBe(attempt)
    replacement = page
      .locator('[data-ui="message"][data-role="user"]')
      .filter({ hasText: `retained imported replacement ${attempt}` })
    await expect(replacement).toBeVisible()
    await expect(replacement.locator('[data-ui="branch-controls"]')).toContainText(
      `${attempt + 2} / ${attempt + 2}`,
    )
  }

  const replacementId = await replacement.getAttribute('data-message-id')
  if (!replacementId) throw new Error('Retained Save & Send replacement has no message id')
  const releaseDeleteStorage = await holdIndexedDbStoreGate(page, ['messages'])
  try {
    await replacement.getByLabel('First variant').click()
    await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
      'data-presentation-only',
      'true',
    )
    await expect(replacement.getByRole('button', { name: 'Delete message' })).toBeEnabled()
    await replacement.getByRole('button', { name: 'Delete message' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    const cancelDelete = replacement.getByRole('button', {
      name: 'Cancel conversation update',
    })
    await expect(cancelDelete).toBeEnabled()
    await cancelDelete.click()
  } finally {
    await releaseDeleteStorage()
  }
  await expect(retainedUser).toContainText('branch A user')
  await expect
    .poll(async () => {
      const row = (await readMessages(page, fixture.chatId)).find(
        (message) => message.id === replacementId,
      )
      return row?.deleted === true
    })
    .toBe(false)
  await retainedUser.getByLabel('Last variant').click()
  await expect(replacement).toBeVisible()
  await expect(replacement.locator('[data-ui="branch-controls"]')).toContainText('5 / 5')
  await replacement.getByRole('button', { name: 'Delete message' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(replacement).toHaveCount(0)

  const databaseName = await activeWorkspaceDatabaseName(page)
  await expect
    .poll(() =>
      page.evaluate(
        async ({ databaseName, replacementId }) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(databaseName)
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          try {
            return await new Promise<boolean>((resolve, reject) => {
              const request = database
                .transaction('messages', 'readonly')
                .objectStore('messages')
                .get(replacementId)
              request.onsuccess = () =>
                resolve((request.result as { deleted?: unknown } | undefined)?.deleted === true)
              request.onerror = () => reject(request.error)
            })
          } finally {
            database.close()
          }
        },
        { databaseName, replacementId },
      ),
    )
    .toBe(true)
})

test('cancelling queued Save & Send preserves the imported edit and releases its owner', async ({
  page,
}) => {
  let requestCount = 0
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: 'cancelled-save-send-retry', content: 'retry completed once' },
        { finish: 'stop' },
      ]),
    })
  })
  const fixture = await seedBranchedChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.messageIdMap.A2}`)
  const importedUser = page.locator(
    `[data-ui="message"][data-message-id="${fixture.messageIdMap.A1}"]`,
  )
  const beforeCount = (await readMessages(page, fixture.chatId)).length

  await importedUser.getByRole('button', { name: 'Edit message' }).click()
  const edit = importedUser.locator('[data-ui="inline-editor-input"]')
  await edit.fill('cancel this queued imported replacement')
  const releaseMessages = await holdIndexedDbStoreGate(page, ['messages'])
  try {
    await importedUser.getByRole('button', { name: 'Save & Send' }).click()
    const cancelPreparing = importedUser.getByRole('button', { name: 'Cancel preparing' })
    await expect(cancelPreparing).toBeEnabled()
    await cancelPreparing.click()
    await expect(edit).toHaveValue('cancel this queued imported replacement')
    await expect(importedUser.locator('[data-ui="inline-editor-generation-error"]')).toContainText(
      'cancelled',
    )
    expect(requestCount).toBe(0)
  } finally {
    await releaseMessages()
  }

  await expect(importedUser.getByRole('button', { name: 'Save & Send' })).toBeEnabled()
  await expect
    .poll(async () => {
      return (await readMessages(page, fixture.chatId)).length
    })
    .toBe(beforeCount)
  await importedUser.getByRole('button', { name: 'Save & Send' }).click()
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"]').filter({
      hasText: 'retry completed once',
    }),
  ).toBeVisible()
  expect(requestCount).toBe(1)
})

test('switching message variants re-renders the selected branch window', async ({ page }) => {
  const fixture = await seedBranchedChat(page)

  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.messageIdMap.A2}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="message"]').nth(1)).toContainText('branch A user')
  await expect(page.locator('[data-ui="message"]').nth(2)).toContainText('branch A assistant')

  await page
    .locator('[data-ui="message"]')
    .filter({ hasText: 'branch A user' })
    .getByLabel('Next variant')
    .click()

  await expect(page.locator('[data-ui="message"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="message"]').nth(1)).toContainText('branch B user')
  await expect(page.locator('[data-ui="message"]').nth(2)).toContainText('branch B assistant')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-rendered-count', '3')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-total-count', '3')
})

test('cached leaves share one live sibling count revision', async ({ context, page }) => {
  const fixture = await seedBranchedChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.messageIdMap.A2}`)
  await expect(page.locator('[data-ui="message"]').last()).toContainText('branch A assistant')

  await page
    .locator('[data-ui="message"]')
    .filter({ hasText: 'branch A user' })
    .getByLabel('Next variant')
    .click()
  await expect(page.locator('[data-ui="message"]').last()).toContainText('branch B assistant')

  const otherTab = await context.newPage()
  try {
    let markRequestSeen: () => void = () => undefined
    const requestSeen = new Promise<void>((resolve) => {
      markRequestSeen = resolve
    })
    await otherTab.route('**/api/v1/chat/completions', async (route) => {
      markRequestSeen()
      await route.fulfill({
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: 'remote-branch', content: 'branch C assistant' },
          { finish: 'stop' },
        ]),
      })
    })
    await otherTab.goto(`/#/chat/${fixture.chatId}/message/${fixture.messageIdMap.B2}`)
    const branchBUser = otherTab
      .locator('[data-ui="message"][data-role="user"]')
      .filter({ hasText: 'branch B user' })
    await branchBUser.locator('[data-action="edit"]').click()
    const editor = otherTab.locator('[data-ui="inline-editor"]')
    await editor.locator('[data-ui="inline-editor-input"]').fill('branch C user')
    await editor.locator('[data-role="save-send"]').click()
    await requestSeen
    await expect(
      otherTab
        .locator('[data-ui="message"][data-role="assistant"]')
        .filter({ hasText: 'branch C assistant' }),
    ).toBeVisible()
    await expect(otherTab.locator('[data-ui="abort"]')).toHaveCount(0)
  } finally {
    await otherTab.close()
  }

  const branchB = page.locator('[data-ui="message"]').filter({ hasText: 'branch B user' })
  await expect(branchB.locator('[data-ui="branch-count"]')).toHaveText('2 / 3')
  await page.evaluate(() => {
    const win = window as typeof window & {
      __branchCountSamples?: string[]
      __branchCountObserver?: MutationObserver
    }
    const sample = () => {
      const text = document.querySelector('[data-ui="branch-count"]')?.textContent.trim()
      if (text) win.__branchCountSamples?.push(text)
    }
    win.__branchCountSamples = []
    win.__branchCountObserver = new MutationObserver(sample)
    win.__branchCountObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    sample()
  })

  await branchB.getByLabel('First variant').click()
  const branchA = page.locator('[data-ui="message"]').filter({ hasText: 'branch A user' })
  await expect(branchA.locator('[data-ui="branch-count"]')).toHaveText('1 / 3')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(branchA.locator('[data-ui="branch-count"]')).toHaveText('1 / 3')
  const samples = await page.evaluate(() => {
    const win = window as typeof window & {
      __branchCountSamples?: string[]
      __branchCountObserver?: MutationObserver
    }
    win.__branchCountObserver?.disconnect()
    return win.__branchCountSamples ?? []
  })
  expect(samples).not.toContain('1 / 2')
})

test('sidebar mounts only the first row window and loads more rows manually', async ({ page }) => {
  await seedSidebarChats(page, {
    chatCount: 65,
    settings: {
      'global:sidebar-render-window-size': 50,
      'global:sidebar-render-window-load-mode': 'manual',
    },
  })
  await page.goto('/')
  await page.reload()

  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(50)
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-total-count', '65')
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-rendered-count', '50')

  await page.locator('[data-ui="load-more-sidebar"]').click()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(65)
  await expect(page.locator('[data-ui="load-more-sidebar"]')).toHaveCount(0)
})

test('sidebar keeps scroll position when auto-load crosses virtualization threshold', async ({
  page,
}) => {
  await seedSidebarChats(page, {
    chatCount: 230,
    settings: {
      'global:sidebar-render-window-size': 75,
      'global:sidebar-render-window-load-mode': 'auto',
    },
  })
  await page.goto('/')
  await page.reload()

  const list = page.locator('[data-ui="chat-list"]')
  await expect(list).toHaveAttribute('data-total-count', '230')
  await expect(list).toHaveAttribute('data-rendered-count', '75')
  await expect(list).toHaveAttribute('data-virtualized', 'true')
  await scrollSidebarToAutoLoadedVirtualRows(page)

  const metrics = await list.evaluate((node) => ({
    mountedCount: node.querySelectorAll('[data-sidebar-row-key]').length,
    renderedCount: Number(node.dataset.renderedCount ?? 0),
    scrollTop: node.scrollTop,
  }))
  expect(metrics.mountedCount).toBeLessThanOrEqual(80)
  expect(metrics.renderedCount).toBeGreaterThan(200)
  expect(metrics.scrollTop).toBeGreaterThan(500)
})

test('a folder larger than one page expands gap-free without stealing the top-first viewport', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  const folderChatCount = 513
  const movedChatId = 'large-folder-drop-source'
  const expectedChatIds = new Set([
    movedChatId,
    ...Array.from(
      { length: folderChatCount },
      (_, index) => `large-folder-chat-${String(index).padStart(3, '0')}`,
    ),
  ])
  await installMessageBodyReadCounter(page)
  await seedLargeFolderRows(page, { folderChatCount, movedChatId })
  await page.goto('/')
  await page.reload()

  const list = page.locator('[data-ui="chat-list"]')
  const folder = page
    .locator('[data-ui="folder-section"]')
    .filter({ hasText: 'Large exact folder' })
  const folderHeader = folder.locator('[data-ui="folder-header"]')
  const folderButton = folder.locator('[data-ui="folder-main"]')
  const source = page.locator(`[data-ui="chat-row"]:has([href="#/chat/${movedChatId}"])`)
  await expect(source).toBeVisible()
  await expect(folderButton).toBeVisible()
  await expect(folderButton).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(0)

  await resetMessageBodyReadCounter(page)
  await startFolderMoveRecorder(page, movedChatId)
  await source.dragTo(folderHeader)
  await expect(folder.locator('[data-ui="folder-count"]')).toHaveText(String(folderChatCount + 1))
  await expect(folderButton).toHaveAttribute('aria-expanded', 'true')
  const movePerformance = await finishFolderMoveRecorder(page)
  await testInfo.attach('folder-move-performance.json', {
    body: Buffer.from(JSON.stringify(movePerformance)),
    contentType: 'application/json',
  })
  expect(movePerformance.elapsedMs).toBeLessThan(1_000)
  if (movePerformance.longTaskSupported) {
    expect(movePerformance.maximumLongTaskMs).toBeLessThanOrEqual(100)
    expect(movePerformance.totalBlockingTimeMs).toBeLessThanOrEqual(100)
  }
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeLessThanOrEqual(2)

  const collected = new Set<string>()
  let maximumMountedRows = 0
  await expect
    .poll(
      async () => {
        const sample = await collectFolderViewportSample(list)
        maximumMountedRows = Math.max(maximumMountedRows, sample.mountedRows)
        expect(sample.duplicateChatIds).toEqual([])
        for (const id of sample.folderChatIds) collected.add(id)
        return collected.size
      },
      { timeout: 20_000, intervals: [0] },
    )
    .toBe(expectedChatIds.size)
  expect([...collected].sort()).toEqual([...expectedChatIds].sort())
  expect(maximumMountedRows).toBeLessThanOrEqual(80)
  expect(await readMessageBodyReadCounter(page)).toEqual({ calls: [], reads: 0 })
})

test('virtualized sidebar bottom tracks mixed folder and tag row heights', async ({ page }) => {
  await seedMixedHeightSidebarRows(page)
  await page.goto('/')
  await page.reload()
  await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute(
    'data-workspace-runtime-state',
    'RUNNING',
    { timeout: 10_000 },
  )

  const list = page.locator('[data-ui="chat-list"]')
  await expect(list).toHaveAttribute('data-virtualized', 'true')
  await expect(page.locator('[data-ui="chat-row-tag"]').first()).toBeVisible()
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(0)

  await assertSidebarBottomHasNoBlankTail(page, 'expanded folder')

  await scrollSidebarUntilText(page, 'Height check folder')
  const folderButton = page
    .locator('[data-ui="folder-section"]')
    .filter({ hasText: 'Height check folder' })
    .locator('[data-ui="folder-main"]')
  await expect(folderButton).toHaveAttribute('aria-expanded', 'true')
  await folderButton.click()
  await expect(folderButton).toHaveAttribute('aria-expanded', 'false')
  await assertSidebarBottomHasNoBlankTail(page, 'collapsed folder')

  await scrollSidebarUntilText(page, 'Height check folder')
  await folderButton.click()
  await expect(folderButton).toHaveAttribute('aria-expanded', 'true')
  await assertSidebarBottomHasNoBlankTail(page, 're-expanded folder')

  const bottomFolderButton = page
    .locator('[data-ui="folder-section"]')
    .filter({ hasText: 'Bottom height folder' })
    .locator('[data-ui="folder-main"]')
  await expect(bottomFolderButton).toBeVisible()
  await expect(bottomFolderButton).toHaveAttribute('aria-expanded', 'true')
  await bottomFolderButton.click()
  await expect(bottomFolderButton).toHaveAttribute('aria-expanded', 'false')
  await assertSidebarBottomHasNoBlankTail(page, 'folder toggled while already at bottom')
})

test('sidebar keeps a loaded row anchored when folders toggle and tag rows grow', async ({
  page,
}) => {
  await seedSidebarScrollMutationFixture(page)
  await page.goto('/')
  await page.reload()

  await loadNextSidebarPage(page)
  await loadNextSidebarPage(page)
  await expect(page.locator('[data-ui="load-more-sidebar"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-virtualized', 'true')
  await scrollSidebarUntilText(page, 'Far folder')

  const farFolder = page.locator('[data-ui="folder-section"]').filter({ hasText: 'Far folder' })
  const farFolderButton = farFolder.locator('[data-ui="folder-main"]')
  await expect(farFolderButton).toBeVisible()
  await alignSidebarRowNearTop(farFolder)

  const beforeExpand = await sidebarRowMetrics(farFolder)
  const expandLatency = await measureAttributeChangeFromPointerDown(
    farFolderButton,
    'aria-expanded',
  )
  expect(expandLatency).toBeLessThan(100)
  await expect(farFolderButton).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(80)
  const afterExpand = await sidebarRowMetrics(farFolder)
  expect(afterExpand.renderedCount).toBeGreaterThan(200)
  expect(afterExpand.scrollTop).toBeGreaterThan(1000)
  expect(Math.abs(afterExpand.top - beforeExpand.top)).toBeLessThan(6)

  const collapseLatency = await measureAttributeChangeFromPointerDown(
    farFolderButton,
    'aria-expanded',
  )
  expect(collapseLatency).toBeLessThan(100)
  await expect(farFolderButton).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(80)
  const afterCollapse = await sidebarRowMetrics(farFolder)
  expect(afterCollapse.renderedCount).toBeGreaterThan(200)
  expect(afterCollapse.scrollTop).toBeGreaterThan(1000)
  expect(Math.abs(afterCollapse.top - beforeExpand.top)).toBeLessThan(6)

  const tagTarget = page.locator('[data-ui="chat-row"]').filter({ hasText: 'Tag target chat' })
  await scrollSidebarUntilText(page, 'Tag target chat')
  await expect(tagTarget).toBeVisible()
  await alignSidebarRowNearTop(tagTarget)
  const beforeTags = await sidebarRowMetrics(tagTarget)

  page.once('dialog', (dialog) => dialog.accept('Alpha, Beta, Gamma'))
  await tagTarget.hover()
  await tagTarget.locator('[data-ui="chat-row-menu-button"]').click()
  await page.locator('[data-ui="chat-row-tags-button"]').click()
  await expect(tagTarget.locator('[data-ui="chat-row-tag"]')).toHaveCount(3)
  await page.waitForTimeout(80)

  const afterTags = await sidebarRowMetrics(tagTarget)
  expect(afterTags.renderedCount).toBeGreaterThan(200)
  expect(afterTags.scrollTop).toBeGreaterThan(1000)
  expect(Math.abs(afterTags.top - beforeTags.top)).toBeLessThan(6)
})

async function assertSidebarBottomHasNoBlankTail(page: Page, label: string): Promise<void> {
  const list = page.locator('[data-ui="chat-list"]')
  await settleSidebarMeasurementsToBottom(list)
  const metrics = await list.evaluate((node) => {
    const listRect = node.getBoundingClientRect()
    const visibleRows = Array.from(
      node.querySelectorAll<HTMLElement>('[data-sidebar-row-key]'),
    ).filter((row) => {
      const rowRect = row.getBoundingClientRect()
      return rowRect.bottom > listRect.top && rowRect.top < listRect.bottom
    })
    const lastVisibleBottom = visibleRows.reduce((bottom, row) => {
      const rowBottom = row.getBoundingClientRect().bottom
      return Math.max(bottom, rowBottom)
    }, listRect.top)
    return {
      blankTail: listRect.bottom - lastVisibleBottom,
      maxScrollTop: Math.max(0, node.scrollHeight - node.clientHeight),
      scrollTop: node.scrollTop,
      visibleRows: visibleRows.length,
    }
  })
  expect(metrics.visibleRows, label).toBeGreaterThan(0)
  expect(metrics.scrollTop, label).toBeGreaterThanOrEqual(metrics.maxScrollTop - 1)
  expect(metrics.blankTail, label).toBeLessThan(12)
}

async function loadNextSidebarPage(page: Page): Promise<void> {
  const list = page.locator('[data-ui="chat-list"]')
  const loadMore = page.locator('[data-ui="load-more-sidebar"]')
  await expect(loadMore).toBeVisible()
  const before = Number((await list.getAttribute('data-rendered-count')) ?? 0)
  await loadMore.click()
  await expect
    .poll(async () => Number((await list.getAttribute('data-rendered-count')) ?? 0))
    .toBeGreaterThan(before)
}

async function scrollSidebarToAutoLoadedVirtualRows(page: Page): Promise<void> {
  const list = page.locator('[data-ui="chat-list"]')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await list.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
    })
    await page.waitForTimeout(120)
    const renderedCount = Number((await list.getAttribute('data-rendered-count')) ?? 0)
    if (renderedCount > 200) return
  }
  throw new Error('Sidebar did not progressively auto-load its virtualized rows')
}

async function alignSidebarRowNearTop(row: Locator): Promise<void> {
  await row.evaluate((node) => {
    const list = node.closest('[data-ui="chat-list"]')
    if (!list) return
    const rowRect = node.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    list.scrollTop += rowRect.top - listRect.top - 72
  })
}

async function scrollSidebarUntilText(page: Page, text: string): Promise<void> {
  const list = page.locator('[data-ui="chat-list"]')
  const matchingRows = page.locator('[data-sidebar-row-key]').filter({ hasText: text })
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await matchingRows.count()) > 0) return
    await list.evaluate((node, attemptIndex) => {
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
      node.scrollTop = Math.min(maxScrollTop, attemptIndex * 520)
    }, attempt)
    await page.waitForTimeout(40)
  }
  throw new Error(`Could not render sidebar row containing ${text}`)
}

async function settleSidebarMeasurementsToBottom(list: Locator): Promise<void> {
  await list.evaluate(async (node) => {
    let target = 0
    for (let step = 0; step < 120; step += 1) {
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
      node.scrollTop = Math.min(maxScrollTop, target)
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      if (target >= maxScrollTop) break
      target += Math.max(180, node.clientHeight * 0.75)
    }
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
}

async function sidebarRowMetrics(row: Locator): Promise<{
  top: number
  scrollTop: number
  renderedCount: number
}> {
  return row.evaluate((node) => {
    const list = node.closest('[data-ui="chat-list"]')
    if (!(list instanceof HTMLElement)) throw new Error('Sidebar list not found')
    const rowRect = node.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    return {
      top: rowRect.top - listRect.top,
      scrollTop: list.scrollTop,
      renderedCount: Number(list.dataset.renderedCount ?? 0),
    }
  })
}

async function measureAttributeChangeFromPointerDown(
  element: Locator,
  attribute: string,
): Promise<number> {
  await element.evaluate((node, attributeName) => {
    const owner = window as typeof window & {
      __sidebarAttributeLatency?: {
        startedAt: number | null
        elapsed: number | null
        observer: MutationObserver
      }
    }
    owner.__sidebarAttributeLatency?.observer.disconnect()
    const measurement = {
      startedAt: null as number | null,
      elapsed: null as number | null,
      observer: new MutationObserver(() => undefined),
    }
    measurement.observer = new MutationObserver(() => {
      if (measurement.startedAt === null) return
      measurement.elapsed = performance.now() - measurement.startedAt
      measurement.observer.disconnect()
    })
    measurement.observer.observe(node, {
      attributes: true,
      attributeFilter: [attributeName],
    })
    node.addEventListener(
      'pointerdown',
      () => {
        measurement.startedAt = performance.now()
      },
      { once: true },
    )
    owner.__sidebarAttributeLatency = measurement
  }, attribute)
  await element.click()
  await expect
    .poll(() =>
      element.page().evaluate(() => {
        const owner = window as typeof window & {
          __sidebarAttributeLatency?: { elapsed: number | null }
        }
        return owner.__sidebarAttributeLatency?.elapsed ?? null
      }),
    )
    .not.toBeNull()
  return element.page().evaluate(() => {
    const owner = window as typeof window & {
      __sidebarAttributeLatency?: { elapsed: number | null }
    }
    const elapsed = owner.__sidebarAttributeLatency?.elapsed
    if (elapsed === null || elapsed === undefined) {
      throw new Error('SidebarAttributeLatencyMissing')
    }
    return elapsed
  })
}

async function seedBranchedChat(
  page: Page,
): Promise<{ chatId: string; messageIdMap: Record<string, string> }> {
  const now = Date.now()
  const chatId = 'render-window-branch-chat'
  const sourceMessages = [
    {
      id: 'root',
      chatId,
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-root',
      turnIndex: 0,
      createdAt: now,
      role: 'system',
      origin: 'imported',
      content: [{ type: 'text', text: 'root instruction' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: 'A1',
      chatId,
      parentId: 'root',
      siblingIndex: 0,
      turnId: 'turn-A1',
      turnIndex: 1,
      createdAt: now + 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'branch A user' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: 'A2',
      chatId,
      parentId: 'A1',
      siblingIndex: 0,
      turnId: 'turn-A2',
      turnIndex: 2,
      createdAt: now + 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'branch A assistant' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: 'B1',
      chatId,
      parentId: 'root',
      siblingIndex: 1,
      turnId: 'turn-B1',
      turnIndex: 1,
      createdAt: now + 3,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'branch B user' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: 'B2',
      chatId,
      parentId: 'B1',
      siblingIndex: 0,
      turnId: 'turn-B2',
      turnIndex: 2,
      createdAt: now + 4,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'branch B assistant' }],
      nodeVersion: 0,
      deleted: false,
    },
  ]
  const imported = await importPortableChatThroughUi(page, {
    sourceChatId: chatId,
    title: 'Render branch window chat',
    createdAt: now,
    messages: sourceMessages,
    workspaceSettings: {
      'global:message-initial-render-work': 3,
      'global:message-render-window-load-mode': 'manual',
    },
    captureMessageIds: true,
  })
  if (!imported.messageIdMap) throw new Error('Branched fixture message ids were not captured')
  return { chatId: imported.chatId, messageIdMap: imported.messageIdMap }
}

async function mountedMessageIds(messages: Locator): Promise<string[]> {
  return messages.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-message-id')).filter((id): id is string => !!id),
  )
}

function expectCommonPrefixContinuity(
  continuity: Awaited<ReturnType<typeof stopMessageCountRecorder>>,
  expectedCommonPrefixCount: number,
): void {
  expect(continuity).toMatchObject({
    commonPrefixDisconnectedIds: [],
    commonPrefixReplacedIds: [],
    listRemoved: false,
    listReplaced: false,
    loadingSeen: false,
    messageCountBelowExpectedCommonPrefix: false,
    messageCountsIncludeZero: false,
  })
  expect(continuity.minimumMessageCount).toBeGreaterThanOrEqual(expectedCommonPrefixCount)
}

async function seedSidebarChats(
  page: Page,
  input: {
    chatCount: number
    settings?: Record<string, unknown>
  },
): Promise<void> {
  const now = Date.now()
  await appendChatCatalogFixturesThroughUi(page, {
    now,
    ...(input.settings === undefined ? {} : { workspaceSettings: input.settings }),
    chats: Array.from({ length: input.chatCount }, (_, index) => ({
      id: `sidebar-window-chat-${String(index).padStart(3, '0')}`,
      title: `Sidebar window chat ${String(index).padStart(2, '0')}`,
      createdAt: now - index,
      updatedAt: now - index,
      lastViewedAt: now - index,
      wordCount: 10,
      previewText: `sidebar preview ${index}`,
    })),
  })
}

async function seedMixedHeightSidebarRows(page: Page): Promise<void> {
  const now = Date.now()
  const tags = [
    { id: 'height-tag-alpha', name: 'Alpha' },
    { id: 'height-tag-beta', name: 'Beta' },
    { id: 'height-tag-gamma', name: 'Gamma' },
    { id: 'height-tag-delta', name: 'Delta' },
  ].map((tag, index) => ({
    ...tag,
    createdAt: now + index,
    updatedAt: now + index,
    lastUsedAt: now + index,
  }))
  const tagIds = tags.map((tag) => tag.id)
  await appendChatCatalogFixturesThroughUi(page, {
    now,
    workspaceSettings: {
      'global:sidebar-render-window-size': 320,
      'global:sidebar-render-window-load-mode': 'manual',
    },
    folders: [
      {
        id: 'height-check-folder',
        name: 'Height check folder',
        createdAt: now - 100,
        updatedAt: now - 100,
        lastUsedAt: now - 100,
      },
      {
        id: 'bottom-height-folder',
        name: 'Bottom height folder',
        createdAt: now - 500,
        updatedAt: now - 500,
        lastUsedAt: now - 500,
      },
    ],
    tags,
    chats: [
      ...Array.from({ length: 210 }, (_, index) => ({
        id: `mixed-height-root-chat-${String(index).padStart(3, '0')}`,
        title: `Mixed height root ${String(index).padStart(3, '0')}`,
        createdAt: now - index,
        updatedAt: now - index,
        lastViewedAt: now - index,
        wordCount: 10,
        tags: index % 4 === 0 ? tagIds : index % 5 === 0 ? [tagIds[0] as string] : [],
        previewText: `mixed root preview ${index}`,
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `mixed-height-folder-chat-${String(index).padStart(3, '0')}`,
        title: `Mixed height folder ${String(index).padStart(3, '0')}`,
        createdAt: now - 90 - index,
        updatedAt: now - 90 - index,
        lastViewedAt: now - 90 - index,
        wordCount: 10,
        folderId: 'height-check-folder',
        tags: index % 3 === 0 ? tagIds.slice(0, 3) : [],
        previewText: `mixed folder preview ${index}`,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `bottom-height-folder-chat-${String(index).padStart(3, '0')}`,
        title: `Bottom height folder chat ${String(index).padStart(3, '0')}`,
        createdAt: now - 500 - index,
        updatedAt: now - 500 - index,
        lastViewedAt: now - 500 - index,
        wordCount: 10,
        folderId: 'bottom-height-folder',
        tags: index % 2 === 0 ? tagIds.slice(0, 2) : [],
        previewText: `bottom height folder preview ${index}`,
      })),
    ],
  })
}

async function seedSidebarScrollMutationFixture(page: Page): Promise<void> {
  const now = Date.now()
  await appendChatCatalogFixturesThroughUi(page, {
    now,
    workspaceSettings: {
      'global:sidebar-render-window-size': 75,
      'global:sidebar-render-window-load-mode': 'manual',
      'sidebar:collapsed-folders': ['far-folder'],
    },
    folders: [
      {
        id: 'far-folder',
        name: 'Far folder',
        createdAt: now + 795,
        updatedAt: now + 795,
        lastUsedAt: now + 795,
      },
    ],
    chats: [
      ...Array.from({ length: 230 }, (_, index) => ({
        id: `sidebar-scroll-chat-${String(index).padStart(3, '0')}`,
        title: index === 210 ? 'Tag target chat' : `Sidebar scroll chat ${String(index)}`,
        createdAt: now + 1000 - index,
        updatedAt: now + 1000 - index,
        lastViewedAt: now + 1000 - index,
        wordCount: 10,
        previewText: `sidebar scroll preview ${index}`,
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `far-folder-chat-${index}`,
        title: `Far folder chat ${index}`,
        createdAt: now + 795 - index,
        updatedAt: now + 795 - index,
        lastViewedAt: now + 795 - index,
        wordCount: 10,
        folderId: 'far-folder',
        previewText: `far folder preview ${index}`,
      })),
    ],
  })
}

async function seedLargeFolderRows(
  page: Page,
  input: { readonly folderChatCount: number; readonly movedChatId: string },
): Promise<void> {
  const now = Date.now()
  await appendChatCatalogFixturesThroughUi(page, {
    now,
    workspaceSettings: {
      'global:sidebar-render-window-size': 75,
      'global:sidebar-render-window-load-mode': 'auto',
      'sidebar:collapsed-folders': ['large-exact-folder'],
    },
    folders: [
      {
        id: 'large-exact-folder',
        name: 'Large exact folder',
        createdAt: now + 10_000,
        updatedAt: now + 10_000,
        lastUsedAt: now + 10_000,
      },
    ],
    chats: [
      {
        id: input.movedChatId,
        title: 'Large folder drop source',
        createdAt: now + 10_001,
        updatedAt: now + 10_001,
        lastViewedAt: now + 10_001,
        wordCount: 10,
        previewText: 'large folder drop source preview',
      },
      ...Array.from({ length: input.folderChatCount }, (_, index) => ({
        id: `large-folder-chat-${String(index).padStart(3, '0')}`,
        title: `Large folder chat ${String(index).padStart(3, '0')}`,
        createdAt: now + 9_999 - index,
        updatedAt: now + 9_999 - index,
        lastViewedAt: now + 9_999 - index,
        wordCount: 10,
        folderId: 'large-exact-folder',
        previewText: `large folder preview ${index}`,
      })),
    ],
  })
}

async function installMessageBodyReadCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type CounterWindow = Window & {
      __messageBodyReadCounter?: {
        calls: string[]
        compactionReads: number
        reads: number
      }
    }
    const counter = { calls: [] as string[], compactionReads: 0, reads: 0 }
    ;(window as CounterWindow).__messageBodyReadCounter = counter
    const wrap = (
      prototype: object,
      storeName: (receiver: IDBObjectStore | IDBIndex) => string,
    ) => {
      for (const method of [
        'get',
        'getKey',
        'getAll',
        'getAllKeys',
        'count',
        'openCursor',
        'openKeyCursor',
      ]) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, method)
        const implementation: unknown = descriptor?.value
        if (!descriptor || typeof implementation !== 'function') continue
        Object.defineProperty(prototype, method, {
          ...descriptor,
          value: function (
            this: IDBObjectStore | IDBIndex,
            ...args: unknown[]
          ): IDBRequest<unknown> {
            if (storeName(this) === 'messageBodies') {
              const call = `${method}\n${new Error().stack ?? ''}`
              if (call.includes('/browser-workspace-compaction-')) counter.compactionReads += 1
              else {
                counter.reads += 1
                if (counter.calls.length < 20) counter.calls.push(call)
              }
            }
            return Reflect.apply(implementation, this, args) as IDBRequest<unknown>
          },
        })
      }
    }
    wrap(IDBObjectStore.prototype, (store) => (store as IDBObjectStore).name)
    wrap(IDBIndex.prototype, (index) => (index as IDBIndex).objectStore.name)
  })
}

async function resetMessageBodyReadCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const counter = (
      window as Window & {
        __messageBodyReadCounter?: {
          calls: string[]
          compactionReads: number
          reads: number
        }
      }
    ).__messageBodyReadCounter
    if (!counter) throw new Error('MessageBodyReadCounterMissing')
    counter.calls.length = 0
    counter.compactionReads = 0
    counter.reads = 0
  })
}

async function readMessageBodyReadCounter(
  page: Page,
): Promise<{ readonly calls: readonly string[]; readonly reads: number }> {
  return page.evaluate(() => {
    const counter = (
      window as Window & {
        __messageBodyReadCounter?: {
          calls: string[]
          compactionReads: number
          reads: number
        }
      }
    ).__messageBodyReadCounter
    if (!counter) throw new Error('MessageBodyReadCounterMissing')
    return { calls: [...counter.calls], reads: counter.reads }
  })
}

async function startFolderMoveRecorder(page: Page, chatId: string): Promise<void> {
  await page.evaluate((id) => {
    type MoveRecord = {
      droppedAt: number | null
      committedAt: number | null
      folderHeader: Element
      longTaskObserver: PerformanceObserver | null
      longTasks: Array<{ startTime: number; duration: number }>
      onDrop: () => void
      observer: MutationObserver
    }
    const folder = [...document.querySelectorAll('[data-ui="folder-section"]')].find((node) =>
      node.textContent.includes('Large exact folder'),
    )
    const folderHeader = folder?.querySelector('[data-ui="folder-header"]')
    if (!folderHeader) throw new Error('FolderMoveRecordTargetMissing')
    const record: MoveRecord = {
      droppedAt: null,
      committedAt: null,
      folderHeader,
      longTaskObserver: null,
      longTasks: [],
      onDrop: () => {
        record.droppedAt ??= performance.now()
      },
      observer: null as unknown as MutationObserver,
    }
    try {
      if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) {
        throw new Error('LongTaskTimingUnsupported')
      }
      record.longTaskObserver = new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries()) {
          record.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
        }
      })
      record.longTaskObserver.observe({ type: 'longtask', buffered: true })
    } catch {
      record.longTaskObserver = null
    }
    folderHeader.addEventListener('drop', record.onDrop, { capture: true })
    const sample = () => {
      const folder = [...document.querySelectorAll('[data-ui="folder-section"]')].find((node) =>
        node.textContent.includes('Large exact folder'),
      )
      const source = document
        .querySelector(`[data-ui="chat-row"] [href="#/chat/${id}"]`)
        ?.closest<HTMLElement>('[data-ui="chat-row"]')
      if (
        record.committedAt === null &&
        (source?.dataset.sidebarDepth === 'folder' ||
          folder?.querySelector('[data-ui="folder-count"]')?.textContent === '514')
      ) {
        record.committedAt = performance.now()
      }
    }
    record.observer = new MutationObserver(sample)
    record.observer.observe(document.querySelector('[data-ui="chat-list"]') ?? document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    ;(window as typeof window & { __folderMoveRecord?: MoveRecord }).__folderMoveRecord = record
    sample()
  }, chatId)
}

async function finishFolderMoveRecorder(page: Page): Promise<{
  readonly elapsedMs: number
  readonly longTaskSupported: boolean
  readonly maximumLongTaskMs: number
  readonly totalBlockingTimeMs: number
}> {
  return page.evaluate(() => {
    const record = (
      window as typeof window & {
        __folderMoveRecord?: {
          droppedAt: number | null
          committedAt: number | null
          folderHeader: Element
          longTaskObserver: PerformanceObserver | null
          longTasks: Array<{ startTime: number; duration: number }>
          onDrop: () => void
          observer: MutationObserver
        }
      }
    ).__folderMoveRecord
    if (!record || record.droppedAt === null || record.committedAt === null) {
      throw new Error('FolderMoveRecordIncomplete')
    }
    const { committedAt, droppedAt } = record
    record.observer.disconnect()
    record.folderHeader.removeEventListener('drop', record.onDrop, { capture: true })
    for (const entry of record.longTaskObserver?.takeRecords() ?? []) {
      record.longTasks.push({ startTime: entry.startTime, duration: entry.duration })
    }
    record.longTaskObserver?.disconnect()
    const relevantLongTasks = record.longTasks.filter(
      (task) => task.startTime < committedAt && task.startTime + task.duration > droppedAt,
    )
    return {
      elapsedMs: committedAt - droppedAt,
      longTaskSupported: record.longTaskObserver !== null,
      maximumLongTaskMs: Math.max(0, ...relevantLongTasks.map((task) => task.duration)),
      totalBlockingTimeMs: relevantLongTasks.reduce(
        (total, task) => total + Math.max(0, task.duration - 50),
        0,
      ),
    }
  })
}

async function collectFolderViewportSample(list: Locator): Promise<{
  readonly folderChatIds: readonly string[]
  readonly duplicateChatIds: readonly string[]
  readonly mountedRows: number
}> {
  return list.evaluate(async (node) => {
    const folderChatIds = [
      ...node.querySelectorAll<HTMLElement>(
        '[data-ui="chat-row"][data-sidebar-depth="folder"] [data-ui="chat-row-link"][href^="#/chat/"]',
      ),
    ]
      .map((link) => link.getAttribute('href')?.slice('#/chat/'.length) ?? '')
      .filter(Boolean)
    const duplicateChatIds = folderChatIds.filter(
      (id, index) => folderChatIds.indexOf(id) !== index,
    )
    const mountedRows = node.querySelectorAll('[data-sidebar-row-key]').length
    const maximum = Math.max(0, node.scrollHeight - node.clientHeight)
    if (node.scrollTop < maximum - 1) {
      node.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: Math.max(1, node.clientHeight * 0.8),
        }),
      )
      node.scrollTop = Math.min(maximum, node.scrollTop + Math.max(1, node.clientHeight * 0.8))
      node.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    return { folderChatIds, duplicateChatIds, mountedRows }
  })
}

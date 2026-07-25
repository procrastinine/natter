import { configureWorkspaceThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { createChatUiJourneyProfile, expect, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  holdIndexedDbStoreGate,
  mockChatCompletions,
  seedFirstRun,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
  await createChatAndOpen(page)
})

test('send button is disabled when input is empty', async ({ page }) => {
  await expect(page.locator('[data-ui="send"]')).toBeDisabled()
})

test('empty composer input does not show a vertical scrollbar', async ({ page }) => {
  const metrics = await page.locator('[data-ui="composer-input"]').evaluate((el) => {
    const node = el as HTMLTextAreaElement
    return {
      overflowY: getComputedStyle(node).overflowY,
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }
  })

  expect(metrics.overflowY).toBe('hidden')
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1)
})

test.describe('retina composer sizing', () => {
  test.use({ deviceScaleFactor: 2 })

  test('first character keeps the automatic one-line composer at the same height', async ({
    context,
    page,
  }) => {
    await configureWorkspaceThroughUi(page, {
      workspaceSettings: { 'global:base-font-size': 18 },
    })
    const freshPage = await context.newPage()
    await freshPage.goto('/#/new')
    const input = freshPage.locator('[data-ui="composer-input"]')
    const resizeHandle = freshPage.locator('[data-ui="composer-resize-handle"]')
    await input.waitFor({ state: 'visible' })
    const settle = () =>
      freshPage.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      )
    const heights = () =>
      input.evaluate((node) => ({
        ariaNow: document
          .querySelector('[data-ui="composer-resize-handle"]')
          ?.getAttribute('aria-valuenow'),
        body: node.closest('[data-ui="composer-body"]')?.getBoundingClientRect().height,
        client: node.clientHeight,
        composer: node.closest('[data-ui="composer"]')?.getBoundingClientRect().height,
        input: node.getBoundingClientRect().height,
        shell: node.parentElement?.getBoundingClientRect().height,
      }))

    await expect.poll(() => input.evaluate((node) => getComputedStyle(node).fontSize)).toBe('18px')
    await input.focus()
    await settle()
    await expect(resizeHandle).toHaveAttribute('data-resize-mode', 'auto')
    const blank = await heights()

    await input.press('x')
    await expect(input).toHaveValue('x')
    await settle()
    const typed = await heights()
    expect(typed).toEqual(blank)

    await input.press('Backspace')
    await expect(input).toHaveValue('')
    await settle()
    expect(await heights()).toEqual(blank)
    await expect(resizeHandle).toHaveAttribute('data-resize-mode', 'auto')
  })
})

test('composer can be resized below its content and scrolls internally', async ({ page }) => {
  const input = page.locator('[data-ui="composer-input"]')
  const oneLineHeight = await input.evaluate((node) => node.clientHeight)
  const draft = Array.from({ length: 7 }, (_, index) => `draft line ${index}`).join('\n')
  await input.fill(draft)
  const grownMetrics = await input.evaluate((node) => ({
    clientHeight: node.clientHeight,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight,
  }))
  expect(grownMetrics.clientHeight).toBeGreaterThan(oneLineHeight)
  expect(grownMetrics.scrollHeight).toBeLessThanOrEqual(grownMetrics.clientHeight + 1)
  expect(grownMetrics.overflowY).toBe('hidden')

  const resizeHandle = page.locator('[data-ui="composer-resize-handle"]')
  await expect(resizeHandle).toHaveAttribute('aria-valuemin', String(oneLineHeight))
  await expect(resizeHandle).toHaveAttribute('data-resize-mode', 'auto')
  const handleBox = await resizeHandle.boundingBox()
  if (!handleBox) throw new Error('Composer resize handle is not visible')
  const handleX = handleBox.x + handleBox.width / 2
  const handleY = handleBox.y + handleBox.height / 2
  await page.mouse.move(handleX, handleY)
  await page.mouse.down()
  await page.mouse.move(handleX, handleY + grownMetrics.clientHeight - oneLineHeight, { steps: 4 })
  await page.mouse.up()

  expect(await input.evaluate((node) => node.clientHeight)).toBe(oneLineHeight)
  await expect(resizeHandle).toHaveAttribute('aria-valuenow', String(oneLineHeight))
  await expect(resizeHandle).toHaveAttribute('data-resize-mode', 'manual')
  await expect(input).toHaveValue(draft)
  const metrics = await input.evaluate((node) => ({
    clientHeight: node.clientHeight,
    overflowY: getComputedStyle(node).overflowY,
    scrollHeight: node.scrollHeight,
  }))
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  expect(metrics.overflowY).toBe('auto')
  await input.evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  expect(await input.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)

  await input.press('x')
  await input.press('Backspace')
  expect(await input.evaluate((node) => node.clientHeight)).toBe(oneLineHeight)
  await expect(input).toHaveCSS('overflow-y', 'auto')

  await resizeHandle.dblclick()
  await expect(resizeHandle).toHaveAttribute('data-resize-mode', 'auto')
  const resetHeight = await input.evaluate((node) => node.clientHeight)
  expect(resetHeight).toBeGreaterThan(oneLineHeight)
  await expect(input).toHaveCSS('overflow-y', 'hidden')

  await input.fill(`${draft}\nnew automatic line`)
  expect(await input.evaluate((node) => node.clientHeight)).toBeGreaterThan(resetHeight)
})

test('composer input overscroll backing matches the input surface', async ({ page }) => {
  const metrics = await page.locator('[data-ui="composer-input"]').evaluate((el) => {
    const input = el as HTMLTextAreaElement
    const shell = input.parentElement
    const inputStyle = getComputedStyle(input)
    const shellStyle = shell ? getComputedStyle(shell) : null
    return {
      inputBackground: inputStyle.backgroundColor,
      shellBackground: shellStyle?.backgroundColor ?? '',
      shellOverflowY: shellStyle?.overflowY ?? '',
      shellUi: shell?.dataset.ui ?? '',
    }
  })

  expect(metrics.shellUi).toBe('composer-input-shell')
  expect(metrics.shellBackground).toBe(metrics.inputBackground)
  expect(metrics.shellOverflowY).toBe('hidden')
})

test('composer sections square off internal corners and match divider strength', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'composer-style-setup', content: 'ok', finish: 'stop' }]),
  })
  await page.locator('[data-ui="composer-input"]').fill('style setup')
  await page.locator('[data-ui="send"]').click()
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible()

  const closedMetrics = await page.locator('[data-ui="composer-body"]').evaluate((el) => {
    const body = el as HTMLElement
    const input = body.querySelector('[data-ui="composer-input"]') as HTMLElement
    const actions = body.querySelector('[data-ui="composer-actions"]') as HTMLElement
    const dividerProbe = document.createElement('span')
    dividerProbe.style.borderLeft = '1px solid var(--color-border-subtle)'
    body.append(dividerProbe)
    const bodyStyle = getComputedStyle(body)
    const inputStyle = getComputedStyle(input)
    const actionsStyle = getComputedStyle(actions)
    const dividerColor = getComputedStyle(dividerProbe).borderLeftColor
    dividerProbe.remove()
    const actionDividers = [
      '[data-ui="composer-attach"]',
      '[data-ui="composer-attach-existing"]',
      '[data-ui="composer-import-at-end"]',
    ].map((selector) => {
      const style = getComputedStyle(body.querySelector(selector) as HTMLElement)
      return {
        color: style.borderLeftColor,
        style: style.borderLeftStyle,
        width: style.borderLeftWidth,
      }
    })
    return {
      bodyTopLeftRadius: bodyStyle.borderTopLeftRadius,
      bodyTopRightRadius: bodyStyle.borderTopRightRadius,
      inputTopLeftRadius: inputStyle.borderTopLeftRadius,
      inputTopRightRadius: inputStyle.borderTopRightRadius,
      inputBottomLeftRadius: inputStyle.borderBottomLeftRadius,
      inputBottomRightRadius: inputStyle.borderBottomRightRadius,
      bodyBorderTopColor: bodyStyle.borderTopColor,
      bodyBorderTopWidth: bodyStyle.borderTopWidth,
      actionsBorderTopColor: actionsStyle.borderTopColor,
      actionsBorderTopWidth: actionsStyle.borderTopWidth,
      actionDividers,
      dividerColor,
    }
  })

  expect(closedMetrics.inputTopLeftRadius).toBe(closedMetrics.bodyTopLeftRadius)
  expect(closedMetrics.inputTopRightRadius).toBe(closedMetrics.bodyTopRightRadius)
  expect(closedMetrics.inputBottomLeftRadius).toBe('0px')
  expect(closedMetrics.inputBottomRightRadius).toBe('0px')
  expect(closedMetrics.actionsBorderTopColor).toBe(closedMetrics.bodyBorderTopColor)
  expect(closedMetrics.actionsBorderTopWidth).toBe(closedMetrics.bodyBorderTopWidth)
  expect(closedMetrics.actionDividers).toEqual([
    { color: closedMetrics.dividerColor, style: 'solid', width: '1px' },
    { color: closedMetrics.dividerColor, style: 'solid', width: '1px' },
    { color: closedMetrics.dividerColor, style: 'solid', width: '1px' },
  ])

  await page.locator('[data-ui="composer-prefill-toggle"]').click()

  const openMetrics = await page.locator('[data-ui="composer-body"]').evaluate((el) => {
    const body = el as HTMLElement
    const prefill = body.querySelector('[data-ui="composer-prefill"]') as HTMLElement
    const actions = body.querySelector('[data-ui="composer-actions"]') as HTMLElement
    const prefillToggle = body.querySelector('[data-ui="composer-prefill-toggle"]') as HTMLElement
    const dividerProbe = document.createElement('span')
    dividerProbe.style.borderLeft = '1px solid var(--color-border-subtle)'
    body.append(dividerProbe)
    const bodyStyle = getComputedStyle(body)
    const prefillStyle = getComputedStyle(prefill)
    const actionsStyle = getComputedStyle(actions)
    const prefillToggleStyle = getComputedStyle(prefillToggle)
    const dividerColor = getComputedStyle(dividerProbe).borderLeftColor
    dividerProbe.remove()
    return {
      prefillTopLeftRadius: prefillStyle.borderTopLeftRadius,
      prefillTopRightRadius: prefillStyle.borderTopRightRadius,
      prefillBorderTopColor: prefillStyle.borderTopColor,
      prefillBorderTopWidth: prefillStyle.borderTopWidth,
      actionsBorderTopColor: actionsStyle.borderTopColor,
      actionsBorderTopWidth: actionsStyle.borderTopWidth,
      bodyBorderTopColor: bodyStyle.borderTopColor,
      bodyBorderTopWidth: bodyStyle.borderTopWidth,
      dividerColor,
      prefillToggleBorderLeftColor: prefillToggleStyle.borderLeftColor,
      prefillToggleBorderLeftStyle: prefillToggleStyle.borderLeftStyle,
      prefillToggleBorderLeftWidth: prefillToggleStyle.borderLeftWidth,
    }
  })

  expect(openMetrics.prefillTopLeftRadius).toBe('0px')
  expect(openMetrics.prefillTopRightRadius).toBe('0px')
  expect(openMetrics.prefillBorderTopColor).toBe(openMetrics.bodyBorderTopColor)
  expect(openMetrics.prefillBorderTopWidth).toBe(openMetrics.bodyBorderTopWidth)
  expect(openMetrics.actionsBorderTopColor).toBe(openMetrics.bodyBorderTopColor)
  expect(openMetrics.actionsBorderTopWidth).toBe(openMetrics.bodyBorderTopWidth)
  expect(openMetrics.prefillToggleBorderLeftColor).toBe(openMetrics.dividerColor)
  expect(openMetrics.prefillToggleBorderLeftStyle).toBe('solid')
  expect(openMetrics.prefillToggleBorderLeftWidth).toBe('1px')
})

test('send button enables on non-empty input', async ({ page }) => {
  await page.locator('[data-ui="composer-input"]').fill('x')
  await expect(page.locator('[data-ui="send"]')).toBeEnabled()
})

test('new-chat draft survives materializing chat settings', async ({ page }) => {
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('draft before opening settings')

  await page.locator('[data-role="settings-cog"]').click()

  await page.waitForFunction(() => window.location.hash.startsWith('#/chat/'))
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  await expect(page.locator('[data-ui="composer-input"]')).toHaveValue(
    'draft before opening settings',
  )
})

test('composer drafts are preserved separately for new and existing chats', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'draft-keying', content: 'ok', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('first turn')
  await page.locator('[data-ui="send"]').click()
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible()

  await input.fill('existing chat unsent draft')
  await page.locator('[data-role="new-chat"]').click()
  await page.waitForFunction(() => window.location.hash === '#/new')
  await page.locator('[data-ui="composer-input"]').fill('new chat unsent draft')

  await page.locator('[data-ui="chat-row-link"]').first().click()
  await expect(page.locator('[data-ui="composer-input"]')).toHaveValue('existing chat unsent draft')

  await page.locator('[data-role="new-chat"]').click()
  await page.waitForFunction(() => window.location.hash === '#/new')
  await expect(page.locator('[data-ui="composer-input"]')).toHaveValue('new chat unsent draft')
})

test('Enter submits; Shift+Enter inserts a newline', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'ok' }, { finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.click()
  await input.fill('line one')
  await input.press('Shift+Enter')
  await input.type('line two')
  expect(await input.inputValue()).toBe('line one\nline two')
  await input.press('Enter')
  const user = page.locator('[data-ui="message"][data-role="user"]').first()
  await expect(user).toBeVisible()
  await expect(user.locator('[data-ui="message-body"]')).toContainText('line one')
  await expect(user.locator('[data-ui="message-body"]')).toContainText('line two')
})

test('whitespace-only input keeps Send disabled', async ({ page }) => {
  await page.locator('[data-ui="composer-input"]').fill('   ')
  await expect(page.locator('[data-ui="send"]')).toBeDisabled()
  await expect(page.locator('[data-ui="message"][data-role="user"]')).toHaveCount(0)
})

test('input clears after a successful send', async ({ page }) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'ok', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('bye')
  await page.locator('[data-ui="send"]').click()
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible()
  expect(await input.inputValue()).toBe('')
})

test('one new-chat Enter waits for configuration and clears only after admission', async ({
  context,
  page,
  uiJourney,
}) => {
  const releaseConfiguration = await holdIndexedDbStoreGate(page, ['profiles'])
  const freshPage = await context.newPage()
  let requestCount = 0
  await freshPage.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: 'pending-configuration-submit', content: 'configured answer' },
        { finish: 'stop' },
      ]),
    })
  })
  try {
    await freshPage.goto('/#/new')
    const input = freshPage.locator('[data-ui="composer-input"]')
    await input.waitFor({ state: 'visible' })
    await uiJourney.start(
      freshPage,
      createChatUiJourneyProfile({ chatHeader: false }),
      'new-chat-configuration-settlement',
    )
    await input.fill('send after configuration settles')
    await uiJourney.intent(freshPage, {
      kind: 'gesture',
      id: 'new-chat-pending-configuration-enter',
      targetSelector: '[data-ui="composer-input"]',
      eventType: 'keydown',
      expectedDeliveries: 1,
      expectedRoute: { kind: 'prefix', value: '/#/chat/' },
    })
    await input.press('Enter')

    expect(requestCount).toBe(0)
    expect(await freshPage.evaluate(() => window.location.hash)).toBe('#/new')
    await expect(input).toHaveValue('send after configuration settles')

    await releaseConfiguration()
    await expect.poll(() => requestCount).toBe(1)
    await expect(freshPage.locator('[data-ui="message"][data-role="user"]')).toHaveCount(1)
    await expect.poll(() => freshPage.evaluate(() => window.location.hash)).toMatch(/^#\/chat\//u)
    await expect(input).toHaveValue('')
    await uiJourney.checkpoint(freshPage, 'new-chat-configuration-admitted')
    await uiJourney.finish(freshPage, 'new-chat-configuration-finished')
  } finally {
    await releaseConfiguration()
    await freshPage.close()
  }
})

test('a successful send stays cleared after leaving and returning to the chat', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'draft-clear', content: 'ok', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('establish the chat')
  await page.locator('[data-ui="send"]').click()
  await page.waitForFunction(() => window.location.hash.startsWith('#/chat/'))
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toHaveCount(1)

  const chatId = page.url().match(/#\/chat\/([^/]+)/)?.[1]
  if (!chatId) throw new Error('Expected an active chat route')
  const storageKey = `natter:composer-draft:${encodeURIComponent(`chat:${chatId}`)}`
  const sentText = 'do not resurrect this sent draft'

  await input.fill(sentText)
  await page.waitForFunction(({ key, value }) => sessionStorage.getItem(key) === value, {
    key: storageKey,
    value: sentText,
  })
  await page.locator('[data-ui="send"]').click()
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toHaveCount(2)
  await expect(input).toHaveValue('')

  await page.locator('[data-role="new-chat"]').click()
  await page.waitForFunction(() => window.location.hash === '#/new')
  await page.locator(`[data-ui="chat-row-link"][href="#/chat/${chatId}"]`).click()
  await expect(input).toHaveValue('')
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
    .toBeNull()
})

test('the composer swaps Send for Abort while a stream owns the active placeholder', async ({
  page,
}) => {
  // Hold the fetch open so both "mid-stream" assertions land while the
  // stream is still active. The Composer renders *either* Send *or* Abort
  // (not Send-disabled next to Abort), so the test asserts Send is gone
  // and Abort is there — not Send-disabled. An earlier version of this
  // test expected `Send.toBeDisabled()`, which times out under parallel
  // CPU pressure because Playwright polls a locator that no longer exists
  // in the DOM; the UI and the test had drifted.
  await mockChatCompletions(page, {
    delayMs: 3000,
    body: buildSseBody([{ id: 'g', content: 'slow', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('please wait')
  const send = page.locator('[data-ui="send"]')
  await send.click()
  // Mid-stream: Send is swapped out for Abort.
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()
  await expect(send).toHaveCount(0)
  // After the stream finishes, Send comes back and is enabled with new input.
  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible({
    timeout: 10_000,
  })
  await input.fill('next')
  await expect(send).toBeEnabled()
})

test('the composer stays editable while streaming but Enter does not send a second turn', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    delayMs: 2000,
    body: buildSseBody([{ id: 'g', content: 'slow', finish: 'stop' }]),
  })
  const input = page.locator('[data-ui="composer-input"]')
  await input.fill('first turn')
  await page.locator('[data-ui="send"]').click()
  await expect(page.locator('[data-ui="abort"]')).toBeVisible()

  await input.fill('draft during stream')
  await expect(input).toHaveValue('draft during stream')
  await input.press('Enter')
  await expect(input).toHaveValue('draft during stream')
  await expect(page.locator('[data-ui="message"][data-role="user"]')).toHaveCount(1)

  await expect(page.locator('[data-ui="message"][data-role="assistant"]')).toBeVisible({
    timeout: 10_000,
  })
})

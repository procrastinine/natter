import { expect, type Locator, type Page, test } from './fixtures'
import { clearIndexedDb, seedFirstRun, seedLinearChat } from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('transcript loading mounts only the newest message window and loads older batches manually', async ({
  page,
}) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 35,
    chatId: 'render-window-chat',
    title: 'Render window chat',
    textPrefix: 'window message',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)
  await expect(page.locator('[data-ui="message"]').first()).toContainText('window message 25')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-total-count', '35')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute(
    'data-rendered-count',
    '10',
  )

  const retainedMessage = page
    .locator('[data-ui="message"]')
    .filter({ hasText: 'window message 25' })
  await pinScrollRegionAtTop(page)
  const retainedTop = await retainedMessage.evaluate((element) => {
    ;(element as HTMLElement & { retainedAcrossPrepend?: boolean }).retainedAcrossPrepend = true
    const markdown = element.querySelector<HTMLElement>('[data-ui="markdown-segment"]')
    if (!markdown) throw new Error('missing markdown segment')
    ;(markdown as HTMLElement & { retainedAcrossPrepend?: boolean }).retainedAcrossPrepend = true
    return element.getBoundingClientRect().top
  })
  await page
    .locator('[data-ui="load-more-messages"]')
    .evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('[data-ui="message"]')).toHaveCount(20)
  await expect(page.locator('[data-ui="message"]').first()).toContainText('window message 15')
  await expect
    .poll(() =>
      retainedMessage.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        retainedTop,
      ),
    )
    .toBeLessThan(2)
  await page.waitForTimeout(100)
  await expect
    .poll(() =>
      retainedMessage.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        retainedTop,
      ),
    )
    .toBeLessThan(2)
  const retainedAfterPrepend = await retainedMessage.evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    messageNodeRetained:
      (element as HTMLElement & { retainedAcrossPrepend?: boolean }).retainedAcrossPrepend === true,
    markdownNodeRetained:
      (
        element.querySelector<HTMLElement>('[data-ui="markdown-segment"]') as HTMLElement & {
          retainedAcrossPrepend?: boolean
        }
      ).retainedAcrossPrepend === true,
  }))
  expect(Math.abs(retainedAfterPrepend.top - retainedTop)).toBeLessThan(2)
  expect(retainedAfterPrepend.messageNodeRetained).toBe(true)
  expect(retainedAfterPrepend.markdownNodeRetained).toBe(true)

  await page.locator('[data-ui="load-more-messages"]').click()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(35)
  await expect(page.locator('[data-ui="load-more-messages"]')).toHaveCount(0)
})

test('manual prepend retains its viewport anchor across delayed layout above it', async ({
  page,
}) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 20,
    chatId: 'render-window-delayed-layout-chat',
    title: 'Delayed layout chat',
    textPrefix: 'delayed layout message',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)
  await pinScrollRegionAtTop(page)
  const retainedMessage = page
    .locator('[data-ui="message"]')
    .filter({ hasText: 'delayed layout message 10' })
  const retainedTop = await retainedMessage.evaluate(
    (element) => element.getBoundingClientRect().top,
  )

  await page.locator('[data-ui="load-more-messages"]').click()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(20)
  await page.waitForTimeout(250)
  await page
    .locator('[data-ui="message"]')
    .first()
    .evaluate((element) => {
      const delayedBlock = document.createElement('div')
      delayedBlock.dataset.testDelayedLayout = 'true'
      delayedBlock.style.height = '173px'
      element.append(delayedBlock)
    })

  await expect
    .poll(() =>
      retainedMessage.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        retainedTop,
      ),
    )
    .toBeLessThan(2)
})

test('user scrolling cancels delayed prepend-anchor corrections', async ({ page }) => {
  const chatId = await seedLinearChat(page, {
    messageCount: 20,
    chatId: 'render-window-user-scroll-chat',
    title: 'User scroll chat',
    textPrefix: 'user scroll message',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.setViewportSize({ width: 1280, height: 360 })
  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)
  const scrollRegion = await pinScrollRegionAtTop(page)
  const retainedMessage = page
    .locator('[data-ui="message"]')
    .filter({ hasText: 'user scroll message 10' })
  const retainedTop = await retainedMessage.evaluate(
    (element) => element.getBoundingClientRect().top,
  )

  await page.locator('[data-ui="load-more-messages"]').click()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(20)
  const prependedMessage = page.locator('[data-ui="message"]').first()
  await prependedMessage.evaluate((element) => {
    const firstDelayedBlock = document.createElement('div')
    firstDelayedBlock.style.height = '61px'
    element.append(firstDelayedBlock)
  })
  await expect
    .poll(() =>
      retainedMessage.evaluate(
        (element, targetTop) => Math.abs(element.getBoundingClientRect().top - targetTop),
        retainedTop,
      ),
    )
    .toBeLessThan(2)

  await scrollRegion.hover()
  const beforeUserScroll = await scrollRegion.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 47)
  await expect
    .poll(() => scrollRegion.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforeUserScroll)
  const userScrollTop = await scrollRegion.evaluate((element) => element.scrollTop)
  await prependedMessage.evaluate((element) => {
    const secondDelayedBlock = document.createElement('div')
    secondDelayedBlock.style.height = '127px'
    element.append(secondDelayedBlock)
  })
  await page.waitForTimeout(100)

  const afterDelayedLayout = await scrollRegion.evaluate((element) => element.scrollTop)
  expect(Math.abs(afterDelayedLayout - userScrollTop)).toBeLessThan(2)
})

async function pinScrollRegionAtTop(page: Page): Promise<Locator> {
  const scrollRegion = page.locator('[data-ui="scroll-region"]')
  await expect
    .poll(() =>
      scrollRegion.evaluate(
        (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1)
  expect(
    await scrollRegion.evaluate((element) => element.scrollHeight - element.clientHeight),
  ).toBeGreaterThan(0)
  await scrollRegion.evaluate((element) => {
    element.scrollTop = 0
  })
  await expect(scrollRegion).toHaveAttribute('data-scroll-state', 'pinned')
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollTop)).toBeLessThan(1)
  return scrollRegion
}

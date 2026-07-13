import { expect, type Locator, type Page, test } from './fixtures'
import { clearIndexedDb } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 })
  await clearIndexedDb(page)
  await page.evaluate(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  await page.reload()
})

test('narrow home shell keeps sidebar and connection controls reachable', async ({ page }) => {
  await expect(page.locator('[data-ui="chat-title-bar"][data-mobile-home="true"]')).toBeVisible()
  await expect(page.locator('[data-role="mobile-sidebar-toggle"]')).toBeVisible()
  await expect(page.locator('[data-role="settings-cog"]')).toBeVisible()
  await expect(page.locator('[data-role="chat-controls-menu"]')).toBeVisible()

  await page.locator('[data-role="mobile-sidebar-toggle"]').click()
  await expect(page.locator('[data-ui="app-shell"]')).toHaveAttribute('data-mobile-sidebar', 'open')
  await page.locator('[data-ui="mobile-panel-scrim"]').click({ position: { x: 382, y: 24 } })

  await page.locator('[data-role="chat-controls-menu"]').click()
  const menu = page.locator('[data-ui="chat-controls-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Add connection' })).toBeVisible()
})

test('narrow storage shell keeps sidebar reachable', async ({ page }) => {
  await page.goto('/#/storage')

  const shell = page.locator('[data-ui="app-shell"]')
  const storageHeader = page.locator('[data-ui="storage-header"]')
  const sidebarToggle = storageHeader.locator('[data-role="mobile-sidebar-toggle"]')
  await expect(storageHeader).toBeVisible()
  await expect(sidebarToggle).toBeVisible()

  await sidebarToggle.click()
  await expect(shell).toHaveAttribute('data-mobile-sidebar', 'open')
  await expect(page.locator('[data-ui="sidebar"]')).toBeVisible()
})

test('narrow chat shell uses overlay sidebars without moving the chat', async ({ page }) => {
  await startDebugChat(page)

  const shell = page.locator('[data-ui="app-shell"]')
  const main = page.locator('[data-ui="main-pane"]')
  await expect(page.locator('[data-role="mobile-sidebar-toggle"]')).toBeVisible()
  await expect(page.locator('[data-role="settings-cog"]')).toBeVisible()
  await expect(page.locator('[data-role="chat-controls-menu"]')).toBeVisible()
  await expect(page.locator('[data-ui="focus-mode-toggle"]')).toHaveCount(0)

  const mainBefore = await box(main)
  await page.locator('[data-role="mobile-sidebar-toggle"]').click()
  await expect(shell).toHaveAttribute('data-mobile-sidebar', 'open')
  await expect(page.locator('[data-ui="mobile-panel-scrim"]')).toBeVisible()
  const sidebar = page.locator('[data-ui="sidebar"]')
  await expect(sidebar).toBeVisible()
  const sidebarOpen = await box(sidebar)
  expect(sidebarOpen.width).toBeGreaterThan(330)
  const mainWithSidebar = await box(main)
  expect(Math.round(mainWithSidebar.x)).toBe(Math.round(mainBefore.x))
  expect(Math.round(mainWithSidebar.width)).toBe(Math.round(mainBefore.width))

  await page.locator('[data-ui="sidebar-search-input"]').focus()
  await expect(page.locator('[data-ui="sidebar-org-toolbar"]')).toHaveAttribute(
    'data-search-expanded',
    'true',
  )
  const sidebarSearchOpen = await box(sidebar)
  expect(Math.abs(sidebarSearchOpen.width - sidebarOpen.width)).toBeLessThan(1)

  await page.locator('[data-ui="mobile-panel-scrim"]').click({ position: { x: 382, y: 24 } })
  await expect(shell).toHaveAttribute('data-mobile-sidebar', 'closed')

  await page.locator('[data-role="settings-cog"]').click()
  await expect(shell).toHaveAttribute('data-chat-model-panel', 'open')
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  const mainWithSettings = await box(main)
  expect(Math.round(mainWithSettings.x)).toBe(Math.round(mainBefore.x))
  expect(Math.round(mainWithSettings.width)).toBe(Math.round(mainBefore.width))
})

test('hamburger menu exposes connection and chat controls on narrow screens', async ({ page }) => {
  await startDebugChat(page)

  await page.locator('[data-role="chat-controls-menu"]').click()
  const menu = page.locator('[data-ui="chat-controls-menu"]')
  await expect(menu).toBeVisible()
  await expect(
    menu.locator('[data-ui="connection-header"][data-variant="mobile-menu"]'),
  ).toBeVisible()
  await expect(menu.locator('[data-ui="connection-provider-button"]')).toHaveCount(0)
  await expect(menu.locator('[data-ui="connection-profile-select"]')).toBeVisible()
  await expect(menu.locator('[data-ui="connection-viewer"]')).toBeVisible()
  await expect(menu.locator('[data-ui="connection-new"]')).toHaveText('+')
  await expect(menu.getByRole('button', { name: 'Rename chat' })).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Tags' })).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Download .txt' })).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Export JSON' })).toBeVisible()
  await expect(menu.getByRole('button', { name: 'Chat info' })).toBeVisible()
})

async function box(locator: Locator) {
  const box = await locator.boundingBox()
  if (!box) throw new Error('Expected visible box')
  return box
}

async function startDebugChat(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const api = (
      window as unknown as {
        __debugFakeStream?: {
          start(options: {
            targetChars: number
            reasoningChars: number
            prompt: string
            openChat: boolean
          }): Promise<unknown>
        }
      }
    ).__debugFakeStream
    if (!api) throw new Error('__debugFakeStream is not installed')
    await api.start({
      targetChars: 24,
      reasoningChars: 0,
      prompt: 'Mobile shell layout check',
      openChat: true,
    })
  })
  await page.locator('[data-ui="message"][data-role="assistant"]').waitFor({ state: 'visible' })
}

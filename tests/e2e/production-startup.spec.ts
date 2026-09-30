import { restoreWorkspaceThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { expect, test } from './fixtures'
import { clearIndexedDb } from './helpers'
import { cloneWorkspaceSeedTemplate } from './workspace-seed'

test('native departure during a cold module load keeps the requested destination', async ({
  page,
  browserName,
  workspaceSeedTemplate,
}) => {
  const backup = cloneWorkspaceSeedTemplate(await workspaceSeedTemplate(), {})
  const preloadDepartures: string[] = []
  const marker = 'preload-departure-observation:'
  page.on('console', (message) => {
    if (message.text().startsWith(marker)) preloadDepartures.push(message.text())
  })
  await page.addInitScript((prefix) => {
    let departing = false
    window.addEventListener('beforeunload', () => {
      departing = true
    })
    window.addEventListener('vite:preloadError', () => {
      console.debug(`${prefix}${departing}`)
    })
  }, marker)
  await page.goto('/#/storage')
  await expect(page.locator('[data-ui="storage-overview"]')).toBeVisible()
  const modulePattern = /\/assets\/browser-configuration-domain-[^/]+\.js$/u
  let releaseModule!: () => void
  const gate = new Promise<void>((resolve) => {
    releaseModule = resolve
  })
  let pendingModule: Promise<void> | undefined
  await page.route(modulePattern, (route) => {
    if (pendingModule) return route.continue()
    pendingModule = gate.then(() => route.continue())
    return pendingModule
  })
  try {
    await Promise.all([page.waitForRequest(modulePattern), restoreWorkspaceThroughUi(page, backup)])
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page).toHaveURL(new URL('/', page.url()).href)
    await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
    expect(
      await page.evaluate(() => sessionStorage.getItem('natter:preload-recovery-build')),
    ).toBeNull()
    if (browserName === 'firefox') expect(preloadDepartures).toEqual([`${marker}true`])
  } finally {
    releaseModule()
    await pendingModule
    await page.unroute(modulePattern)
  }
})

test('production artifact excludes source modules and development tools', async ({
  page,
  request,
}) => {
  const sourceModule = await request.get('/src/main.tsx', {
    headers: { Accept: 'application/javascript' },
  })
  expect(sourceModule.status()).toBe(404)

  await clearIndexedDb(page)
  await page.goto('/')
  await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
  await expect(page.locator('script[type="module"]')).toHaveCount(1)
  expect(
    await page.evaluate(() =>
      ['__debugFakeStream', '__debugRuntime', '__debugScroll', '__debugStreams', '__nuke'].filter(
        (name) => name in window,
      ),
    ),
  ).toEqual([])
})

test('runtime diagnostic teardown drains an opaque about:blank page', async ({ page }) => {
  await page.goto('about:blank')
  await expect(page).toHaveURL('about:blank')
})

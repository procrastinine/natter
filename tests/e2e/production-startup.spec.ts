import { expect, test } from './fixtures'
import { clearIndexedDb } from './helpers'

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

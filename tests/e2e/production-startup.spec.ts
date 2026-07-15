import { expect, test } from './fixtures'
import { clearIndexedDb } from './helpers'

test.skip(process.env.E2E_SERVER_MODE !== 'preview', 'requires the built production artifact')

test('production artifact boots without runtime diagnostics', async ({ page }) => {
  await clearIndexedDb(page)
  await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
  await expect(page.locator('script[type="module"]')).toHaveCount(1)
})

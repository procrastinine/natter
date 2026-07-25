import { expect, test } from './fixtures'
import { clearIndexedDb } from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
})

test('connection manager duplicates and explicitly reassigns before delete', async ({ page }) => {
  await page.locator('[data-ui="connection-add"]').click()
  await page
    .locator('[data-ui="connection-setup-key"]')
    .fill('sk-or-v1-test-manager-0000000000000000000000')
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })

  await page.locator('[data-ui="open-global-settings"]').click()
  await page.getByRole('tab', { name: 'Connections' }).click()
  const manager = page.locator('[data-ui="connection-manager-list"]')
  const source = manager
    .locator('[data-ui="connection-manager-row"]')
    .filter({ has: page.getByText('OpenRouter', { exact: true }) })
  await expect(source).toHaveCount(1)

  await source.getByRole('button', { name: 'Duplicate' }).click()
  const copy = manager
    .locator('[data-ui="connection-manager-row"]')
    .filter({ has: page.getByText('OpenRouter (copy)', { exact: true }) })
  await expect(copy).toBeVisible()

  await source.getByRole('button', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete connection?' })
  await dialog.getByLabel('Replacement connection').selectOption({ label: 'OpenRouter (copy)' })
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

  await expect(source).toHaveCount(0)
  await expect(copy).toBeVisible()
})

import { expect, test } from '@playwright/test'
import { clearIndexedDb } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await page.goto('/')
})

test('app boots without a connection — empty state visible, only Add connection CTA remains', async ({
  page,
}) => {
  // No first-run blocker and no persistent connection header: only the narrow
  // add-connection action remains. The composer is not present yet (no chat).
  await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
  await expect(page.locator('[data-ui="connection-header"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="connection-empty-action"]')).toBeVisible()
  await expect(page.locator('[data-ui="connection-add"]')).toBeVisible()
})

test('opening the connection-setup modal requires a key before the submit enables', async ({
  page,
}) => {
  await page.locator('[data-ui="connection-add"]').click()
  await expect(page.locator('[data-ui="connection-setup-modal"]')).toBeVisible()
  await expect(page.locator('[data-ui="connection-setup-submit"]')).toBeDisabled()
  await page
    .locator('[data-ui="connection-setup-key"]')
    .fill('sk-or-v1-test-0000000000000000000000000000000000')
  await expect(page.locator('[data-ui="connection-setup-submit"]')).toBeEnabled()
})

test('submitting the connection-setup modal seeds a profile + preset and moves editing to the title icon', async ({
  page,
}) => {
  await page.locator('[data-ui="connection-add"]').click()
  await page
    .locator('[data-ui="connection-setup-key"]')
    .fill('sk-or-v1-test-seed-0000000000000000000000000000')
  await page.locator('[data-ui="connection-setup-submit"]').click()
  // Modal closes; the first-run header is removed once a profile exists.
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  await expect(page.locator('[data-ui="connection-header"]')).toHaveCount(0)
  await page.locator('[data-role="new-chat"]').click()
  await expect(page.locator('[data-ui="connection-provider-button"]')).toBeVisible()
  await expect(
    page.locator('[data-ui="connection-provider-button"][data-kind="openrouter"]'),
  ).toBeVisible()
  await page.locator('[data-ui="connection-provider-button"]').click()
  await expect(
    page.locator('[data-ui="connection-header"][data-state="configured"][data-variant="popover"]'),
  ).toBeVisible()
  const counts = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      const out: Record<string, number> = {}
      for (const store of ['keys', 'profiles', 'presets'] as const) {
        out[store] = await new Promise<number>((resolve, reject) => {
          const tx = db.transaction(store, 'readonly')
          const req = tx.objectStore(store).count()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
      }
      return out
    } finally {
      db.close()
    }
  })
  expect(counts).toEqual({ keys: 1, profiles: 1, presets: 1 })
})

test('seeded profile survives a reload and the title icon stays available', async ({ page }) => {
  await page.locator('[data-ui="connection-add"]').click()
  await page
    .locator('[data-ui="connection-setup-key"]')
    .fill('sk-or-v1-test-persist-0000000000000000000000')
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  await expect(page.locator('[data-ui="connection-empty-action"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="connection-header"]')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-ui="connection-header"]')).toHaveCount(0)
  await page.locator('[data-role="new-chat"]').click()
  await expect(page.locator('[data-ui="connection-provider-button"]')).toBeVisible()
  await expect(page.locator('[data-ui="connection-add"]')).toHaveCount(0)
})

test('whitespace-only key keeps submit disabled; trim happens on save', async ({ page }) => {
  await page.locator('[data-ui="connection-add"]').click()
  const key = page.locator('[data-ui="connection-setup-key"]')
  const submit = page.locator('[data-ui="connection-setup-submit"]')
  await key.fill('   \t  ')
  await expect(submit).toBeDisabled()
  await key.fill('  sk-or-v1-test-whitespace-000000000000000000  ')
  await expect(submit).toBeEnabled()
  await submit.click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })
  await expect(page.locator('[data-ui="connection-empty-action"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="connection-header"]')).toHaveCount(0)
  const previews = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const tx = db.transaction('keys', 'readonly')
        const req = tx.objectStore('keys').getAll()
        req.onsuccess = () => {
          const rows = req.result as Array<{ obscuredPreview: string }>
          resolve(rows.map((r) => r.obscuredPreview))
        }
        req.onerror = () => reject(req.error)
      })
    } finally {
      db.close()
    }
  })
  expect(previews).toHaveLength(1)
  // obscurePreview keeps 10-char prefix + 4-char suffix. Trimmed prefix is
  // "sk-or-v1-t"; untrimmed would be "  sk-or-v1".
  expect(previews[0]?.startsWith('sk-or-v1-t')).toBe(true)
  expect(previews[0]?.startsWith('  ')).toBe(false)
})

test('Send button is disabled with a "configure a connection" tooltip when no profile exists', async ({
  page,
}) => {
  // Navigate to #/new to expose the composer without a configured connection.
  await page.locator('[data-role="new-chat"]').click()
  await expect(page.locator('[data-ui="composer-input"]')).toBeVisible()
  await page.locator('[data-ui="composer-input"]').fill('hi')
  const send = page.locator('[data-ui="send"]')
  await expect(send).toBeDisabled()
  await expect(page.locator('[data-ui="composer-disabled-reason"]')).toContainText(
    /Add a connection/,
  )
})

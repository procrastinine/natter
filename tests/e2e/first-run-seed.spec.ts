import { expect, test } from '@playwright/test'
import { clearIndexedDb } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await page.goto('/')
})

test('first-run form is shown when no profile exists', async ({ page }) => {
  await expect(page.locator('[data-ui="first-run-key"]')).toBeVisible()
  await expect(page.locator('[data-ui="first-run-submit"]')).toBeDisabled()
})

test('pasting a key enables submit and seeds a profile + preset', async ({ page }) => {
  await page.locator('[data-ui="first-run-key"]').fill('sk-or-v1-test-0000000000000000000000000000000000')
  const submit = page.locator('[data-ui="first-run-submit"]')
  await expect(submit).toBeEnabled()
  await submit.click()
  await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
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

test('seeded profile and preset survive a reload', async ({ page }) => {
  await page.locator('[data-ui="first-run-key"]').fill('sk-or-v1-test-persist-0000000000000000000000')
  await page.locator('[data-ui="first-run-submit"]').click()
  await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
  await page.reload()
  // First-run form should NOT reappear — seeded profile persisted.
  await expect(page.locator('[data-ui="first-run-key"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
})

test('submit is disabled when the key input is empty', async ({ page }) => {
  const submit = page.locator('[data-ui="first-run-submit"]')
  await expect(submit).toBeDisabled()
  await page.locator('[data-ui="first-run-key"]').fill('not-empty')
  await expect(submit).toBeEnabled()
  await page.locator('[data-ui="first-run-key"]').fill('')
  await expect(submit).toBeDisabled()
})

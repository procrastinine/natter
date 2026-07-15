import { expect, test } from './fixtures'
import { clearIndexedDb, seedFirstRun } from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('full workspace export warns about recoverable credentials before creating a backup', async ({
  page,
}) => {
  await page.goto('/#/storage')
  await page.getByRole('button', { name: 'Export all' }).click()

  const dialog = page.getByRole('dialog', { name: 'Export sensitive workspace backup?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("this browser's install secret")
  await expect(dialog).toContainText('Passphrase-protected keys still require their passphrase')
  await expect(dialog).toContainText('Store the file like a password')
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  await expect(cancel).toBeFocused()
  await cancel.click()
  await expect(dialog).toBeHidden()
})

test('connection deletion is blocked while its seeded preset remains active', async ({ page }) => {
  await page.locator('[data-role="new-chat"]').click()
  await page.locator('[data-ui="connection-provider-button"]').click()
  await page.getByRole('button', { name: 'Delete connection' }).click()

  const dialog = page.getByRole('dialog', { name: 'Delete connection?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('1 non-archived preset and 0 non-archived chats')
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
})

test('composer uses exact zero and one labels before approximating longer drafts', async ({
  page,
}) => {
  await page.locator('[data-role="new-chat"]').click()
  const input = page.locator('[data-ui="composer-input"]')
  const counter = page.locator('[data-ui="token-counter"]')

  await expect(counter).toHaveText('0 draft tokens')
  await input.fill('x')
  await expect(counter).toHaveText('1 draft token')
  await input.fill('count this draft')

  await expect(counter).toHaveText('≈ 4 draft tokens')
  await expect(counter).toHaveAttribute(
    'title',
    /drafts longer than one character are approximate/u,
  )
})

test('new-chat shortcut preserves the browser new-window binding', async ({ page }) => {
  await page.goto('/#/storage')
  const browserShortcut = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'n',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    return { defaultPrevented: event.defaultPrevented, hash: window.location.hash }
  })
  expect(browserShortcut).toEqual({ defaultPrevented: false, hash: '#/storage' })

  const natterShortcutPrevented = await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', {
      key: 'O',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(natterShortcutPrevented).toBe(true)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/new')
})

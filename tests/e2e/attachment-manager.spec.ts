import { createChatUiJourneyProfile, expect, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('remote attachment publication refreshes projections without steering an active chat', async ({
  page,
  uiJourney,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'attachment-locality', content: 'local baseline', finish: 'stop' }]),
  })
  await createChatAndOpen(page)
  await sendMessage(page, 'attachment locality baseline')
  const chatId = await firstChatId(page)
  const composer = page.locator('[data-ui="composer-input"]')
  await composer.fill('local draft remains selected')
  await composer.focus()
  const profile = createChatUiJourneyProfile()
  await uiJourney.start(
    page,
    {
      ...profile,
      semanticNodes: [
        ...(profile.semanticNodes ?? []),
        {
          id: 'composer-draft',
          selector: '[data-ui="composer-input"]',
          properties: { value: { kind: 'stable' } },
          resetOnRouteChange: false,
        },
      ],
    },
    'remote-attachment-locality',
  )
  await uiJourney.intent(page, {
    kind: 'focus-continuity',
    id: 'remote-attachment-focus',
    selector: '[data-ui="composer-input"]',
    preserveSelection: true,
  })
  await uiJourney.intent(page, { kind: 'follow-bottom', id: 'remote-attachment-scroll' })

  const managerPage = await page.context().newPage()
  const overviewPage = await page.context().newPage()
  const producerPage = await page.context().newPage()
  try {
    await managerPage.goto('/#/storage/attachments')
    await expect(managerPage.locator('[data-ui="attachment-manager"]')).toBeVisible()
    await overviewPage.goto('/#/storage')
    const attachmentMetric = overviewPage.locator('[data-ui="storage-panel"]', {
      hasText: 'Attachments',
    })
    await expect(attachmentMetric).toContainText('0 (')
    await producerPage.goto(`/#/chat/${chatId}`)
    await producerPage.locator('[data-ui="attachment-hidden-input"]').setInputFiles({
      name: 'remote-locality.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('remote attachment publication'),
    })
    await expect(
      producerPage.locator('[data-ui="attachment-draft-tray"]').getByText('remote-locality.txt'),
    ).toBeVisible()

    const manager = managerPage.locator('[data-ui="attachment-manager"]')
    await expect(manager.locator('[data-ui="attachment-table"]')).toContainText(
      'remote-locality.txt',
    )
    const search = manager.locator('[data-ui="attachment-search"] input')
    await search.fill('remote-locality')
    await expect(manager.locator('[data-ui="attachment-table"]')).toContainText(
      'remote-locality.txt',
    )
    await manager.getByRole('link', { name: /remote-locality\.txt/u }).click()
    await expect(manager.locator('[data-ui="attachment-details"]')).toContainText(
      'remote-locality.txt',
    )
    await expect(attachmentMetric).toContainText('1 (')
    await producerPage
      .locator('[data-ui="attachment-file-card"]', { hasText: 'remote-locality.txt' })
      .getByLabel('Remove attachment')
      .click()
    await expect(
      producerPage.locator('[data-ui="attachment-draft-tray"]').getByText('remote-locality.txt'),
    ).toHaveCount(0)
    await expect(composer).toHaveValue('local draft remains selected')
    await uiJourney.finish(page, 'remote-attachment-published')
  } finally {
    await Promise.allSettled([managerPage.close(), overviewPage.close(), producerPage.close()])
  }
})

test('attachment manager searches, filters, bulk deletes, and relinks through built UI', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'attachment-manager', content: 'stored', finish: 'stop' }]),
  })
  await page.locator('[data-ui="attachment-hidden-input"]').setInputFiles([
    {
      name: 'source-reference.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('source attachment body'),
    },
    {
      name: 'relink-target.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('replacement attachment body'),
    },
    {
      name: 'delete-orphan.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('bulk deletion attachment body'),
    },
  ])

  const draftTray = page.locator('[data-ui="attachment-draft-tray"]')
  for (const filename of ['source-reference.txt', 'relink-target.txt', 'delete-orphan.txt']) {
    await expect(draftTray.getByText(filename)).toBeVisible()
  }
  await draftTray
    .locator('[data-ui="attachment-file-card"]', { hasText: 'relink-target.txt' })
    .getByLabel('Remove attachment')
    .click()
  await draftTray
    .locator('[data-ui="attachment-file-card"]', { hasText: 'delete-orphan.txt' })
    .getByLabel('Remove attachment')
    .click()

  await sendMessage(page, 'Keep the source attachment referenced.')
  await expect(
    page.locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]'),
  ).toHaveText('stored')

  await page.goto('/#/storage/attachments')
  const manager = page.locator('[data-ui="attachment-manager"]')
  await expect(manager).toBeVisible()
  const search = manager.locator('[data-ui="attachment-search"] input')
  await search.fill('delete-orphan')
  await expect(manager.locator('[data-ui="attachment-table"]')).toContainText('delete-orphan.txt')
  await expect(manager.locator('[data-ui="attachment-table"]')).not.toContainText(
    'source-reference.txt',
  )

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Delete 1 attachment')
    await dialog.accept()
  })
  await manager.getByRole('button', { name: 'Delete all (1)' }).click()
  await expect(manager.locator('[data-ui="attachment-table"]')).not.toContainText(
    'delete-orphan.txt',
  )

  await search.fill('')
  await manager.getByRole('button', { name: 'unreferenced' }).click()
  const table = manager.locator('[data-ui="attachment-table"]')
  await expect(table).toContainText('relink-target.txt')
  await expect(table).not.toContainText('source-reference.txt')
  await manager.getByRole('button', { name: 'All', exact: true }).click()
  await expect(table).toContainText('source-reference.txt')

  await table.getByRole('link', { name: /source-reference\.txt/u }).click()
  const details = manager.locator('[data-ui="attachment-details"]')
  await expect(details).toContainText('source-reference.txt')
  await details.getByLabel('Relink reference').click()
  const picker = page.locator('[data-ui="attachment-picker"]')
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: /relink-target\.txt/u }).click()
  await expect(picker).toBeHidden()
  await expect(details.getByText('No live message or draft refs.')).toBeVisible()

  await table.getByRole('link', { name: /relink-target\.txt/u }).click()
  await expect(details).toContainText('1 message · 0 draft · 1 in context')
})

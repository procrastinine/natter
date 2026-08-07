import { truncate, unlink, writeFile } from 'node:fs/promises'
import { discoverBrowserWorkspaceDatabaseNames } from '../../scripts/audit-storage-ownership-reclamation.mjs'
import { createFakeStreamScenario, retargetOnlyProfileToFakeProvider } from './fake-stream-provider'
import { createChatUiJourneyProfile, expect, type Page, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

const RECOVERED_MODEL = 'test/storage-recovered:free'
const STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES = 64 * 1024 * 1024
const EXPECTED_DEFAULT_PINNED_OPENROUTER_MODELS = [
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-fable-5',
  'openai/gpt-5.6-sol',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash-lite',
  'z-ai/glm-5.2',
  'moonshotai/kimi-k3',
  'google/gemini-3.5-pro',
] as const

interface StorageReclamationProbe {
  beforeBytes: number
  afterWriteBytes: number
  afterUpgradeBytes: number
  afterDeleteBytes: number
  insertedBytes: number
  storesAfterUpgrade: string[]
}

interface WorkspaceControlSnapshot {
  activeDatabaseName: string
  activationSequence: number
  pending: null | {
    nonce: string
    phase: string
    sourceDatabaseName: string
    destinationDatabaseName: string
  }
  activeCompaction: null | WorkspaceCompactionSnapshot
  sourceCompaction: null | WorkspaceCompactionSnapshot
  databaseNames: string[]
}

interface WorkspaceCompactionSnapshot {
  databaseName: string
  knownReclaimableBytes: number
  lastCompactedLiveBytes: number
  requestRevision: number
  attemptedRevision: number
  completedRevision: number
}

const COMPACTION_DEBT_BYTES = 66 * 1024 * 1024
const WORKSPACE_SELECTION_LOCK = 'natter:workspace-slot-selection:v1'
const BROWSER_WORKSPACE_DATABASE_NAMES = discoverBrowserWorkspaceDatabaseNames()

interface BrowserLockHandle {
  readonly id: string
  readonly name: string
}

async function queueBrowserLock(
  page: Page,
  name: string,
  mode: 'shared' | 'exclusive',
): Promise<BrowserLockHandle> {
  const id = crypto.randomUUID()
  await page.evaluate(
    ({ id, mode, name }) => {
      interface BrowserLockRecord {
        acquired: boolean
        failure: string | null
        release(): void
        completion: Promise<void>
      }
      const scope = window as typeof window & {
        __e2eBrowserLocks?: Map<string, BrowserLockRecord>
      }
      const locks = scope.__e2eBrowserLocks ?? new Map<string, BrowserLockRecord>()
      scope.__e2eBrowserLocks = locks
      let releaseHold!: () => void
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve
      })
      const record: BrowserLockRecord = {
        acquired: false,
        failure: null,
        release: releaseHold,
        completion: Promise.resolve(),
      }
      locks.set(id, record)
      record.completion = navigator.locks
        .request(name, { mode }, async (lock) => {
          if (!lock) throw new Error(`BrowserLockUnavailable:${name}`)
          record.acquired = true
          await hold
        })
        .catch((error: unknown) => {
          record.failure = error instanceof Error ? error.message : String(error)
        })
    },
    { id, mode, name },
  )
  return { id, name }
}

async function browserLockState(
  page: Page,
  handle: BrowserLockHandle,
): Promise<{ acquired: boolean; failure: string | null; pending: boolean }> {
  return page.evaluate(async ({ id, name }) => {
    const scope = window as typeof window & {
      __e2eBrowserLocks?: Map<
        string,
        { acquired: boolean; failure: string | null; completion: Promise<void>; release(): void }
      >
    }
    const record = scope.__e2eBrowserLocks?.get(id)
    if (!record) throw new Error(`BrowserLockMissing:${id}`)
    const snapshot = await navigator.locks.query()
    return {
      acquired: record.acquired,
      failure: record.failure,
      pending: snapshot.pending?.some((lock) => lock.name === name) ?? false,
    }
  }, handle)
}

async function releaseBrowserLock(page: Page, handle: BrowserLockHandle): Promise<void> {
  await page.evaluate(async ({ id }) => {
    const scope = window as typeof window & {
      __e2eBrowserLocks?: Map<
        string,
        { acquired: boolean; failure: string | null; completion: Promise<void>; release(): void }
      >
    }
    const record = scope.__e2eBrowserLocks?.get(id)
    if (!record) return
    record.release()
    await record.completion
    scope.__e2eBrowserLocks?.delete(id)
    if (record.failure) throw new Error(record.failure)
  }, handle)
}

function workspaceSlotLock(databaseName: string): string {
  return `natter:workspace-slot:${databaseName}`
}

async function navigatorLockSnapshot(page: Page): Promise<{ held: string[]; pending: string[] }> {
  return page.evaluate(async () => {
    const snapshot = await navigator.locks.query()
    return {
      held: snapshot.held?.flatMap((lock) => (lock.name ? [lock.name] : [])) ?? [],
      pending: snapshot.pending?.flatMap((lock) => (lock.name ? [lock.name] : [])) ?? [],
    }
  })
}

async function expectBranchControlsReady(page: Page, branchId: string): Promise<void> {
  const message = page.locator(`[data-ui="message"][data-message-id="${branchId}"]`)
  await expect(message).toBeVisible()
  const controls = message.locator('[data-ui="branch-controls"]')
  await expect(controls).toBeVisible()
  await expect(controls.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')
  await expect(controls.locator('[data-role="first"]')).toHaveCount(1)
  await expect(controls.locator('[data-role="prev"]')).toHaveCount(1)
  await expect(controls.locator('[data-role="next"]')).toHaveCount(1)
  await expect(controls.locator('[data-role="last"]')).toHaveCount(1)
}

async function readWorkspaceControlSnapshot(
  page: Page,
  sourceDatabaseName?: string,
): Promise<WorkspaceControlSnapshot> {
  return page.evaluate(async (sourceDatabaseName): Promise<WorkspaceControlSnapshot> => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter-control')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const requestValue = <T>(request: IDBRequest<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    try {
      const transaction = database.transaction(['manifests', 'compactionStates'], 'readonly')
      const manifests = transaction.objectStore('manifests')
      const compactionStates = transaction.objectStore('compactionStates')
      type ManifestRow = {
        activeDatabaseName: string
        activationSequence: number
        pending?: WorkspaceControlSnapshot['pending']
      }
      const manifest = await requestValue(
        manifests.get('workspace') as IDBRequest<ManifestRow | null>,
      )
      if (!manifest) throw new Error('StorageCompactionManifestMissing')
      const [activeCompaction, sourceCompaction] = await Promise.all([
        requestValue(
          compactionStates.get(manifest.activeDatabaseName) as IDBRequest<
            WorkspaceCompactionSnapshot | undefined
          >,
        ),
        sourceDatabaseName
          ? requestValue(
              compactionStates.get(sourceDatabaseName) as IDBRequest<
                WorkspaceCompactionSnapshot | undefined
              >,
            )
          : Promise.resolve(undefined),
      ])
      const databaseNames =
        typeof indexedDB.databases === 'function'
          ? (await indexedDB.databases()).flatMap((candidate) =>
              candidate.name === undefined ? [] : [candidate.name],
            )
          : []
      return {
        activeDatabaseName: manifest.activeDatabaseName,
        activationSequence: manifest.activationSequence,
        pending: manifest.pending ?? null,
        activeCompaction: activeCompaction ?? null,
        sourceCompaction: sourceCompaction ?? null,
        databaseNames,
      }
    } finally {
      database.close()
    }
  }, sourceDatabaseName)
}

async function readChatTitleFromDatabase(
  page: Page,
  databaseName: string,
  chatId: string,
): Promise<string | null> {
  return page.evaluate(
    async ({ databaseName, chatId }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        const row = await new Promise<{ title?: unknown } | undefined>((resolve, reject) => {
          const request = database.transaction('chats', 'readonly').objectStore('chats').get(chatId)
          request.onsuccess = () => resolve(request.result as { title?: unknown } | undefined)
          request.onerror = () => reject(request.error)
        })
        return typeof row?.title === 'string' ? row.title : null
      } finally {
        database.close()
      }
    },
    { databaseName, chatId },
  )
}

test('normal use catches up foreground work without repeating the physical copy and preserves two-tab state', async ({
  page,
  uiJourney,
}, testInfo) => {
  testInfo.setTimeout(180_000)
  await clearIndexedDb(page)
  await seedFirstRun(page)
  const firstUploadPath = testInfo.outputPath('compaction-source.bin')
  const replacementUploadPath = testInfo.outputPath('compaction-replacement.bin')
  await Promise.all([writeFile(firstUploadPath, ''), writeFile(replacementUploadPath, '')])
  await Promise.all([
    truncate(firstUploadPath, COMPACTION_DEBT_BYTES),
    truncate(replacementUploadPath, COMPACTION_DEBT_BYTES),
  ])
  const scenario = await createFakeStreamScenario({
    targetChars: 64,
    chunkChars: 64,
    usage: {
      promptTokens: 96,
      completionTokens: 16,
      reasoningTokens: 0,
      cost: 0.0001,
    },
  })
  let peer: Page | undefined
  let manager: Page | undefined
  try {
    await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl)
    await createChatAndOpen(page)
    await sendMessage(page, 'create the compaction branch')
    const firstBranch = page.locator('[data-ui="message"][data-role="assistant"]').last()
    await expect(firstBranch.locator('[data-ui="message-body"]')).toHaveText(/Lorem ipsum/u)
    const firstBranchId = await firstBranch.getAttribute('data-message-id')
    if (!firstBranchId) throw new Error('StorageCompactionFirstBranchMissing')
    const chatId = await firstChatId(page)

    await firstBranch.locator('[data-action="regenerate"]').click()
    const secondBranch = page.locator('[data-ui="message"][data-role="assistant"]').last()
    await expect(secondBranch.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')
    const secondBranchId = await secondBranch.getAttribute('data-message-id')
    if (!secondBranchId || secondBranchId === firstBranchId) {
      throw new Error('StorageCompactionSecondBranchMissing')
    }

    await page.locator('[data-ui="attachment-hidden-input"]').setInputFiles(firstUploadPath)
    const sourceCard = page.locator('[data-ui="attachment-file-card"]', {
      hasText: 'compaction-source.bin',
    })
    await expect(sourceCard).toBeVisible()
    await sourceCard.getByLabel('Remove attachment').click()
    await expect(sourceCard).toHaveCount(0)

    await expect(page).toHaveURL(new RegExp(`#/chat/${chatId}/message/${secondBranchId}$`, 'u'))
    expect(await scenario.snapshot()).toMatchObject({ activeStreams: 0, requestCount: 2 })
    await scenario.update({
      targetChars: 4_096,
      chunkChars: 512,
      delayMs: 30,
      holdUntilReleased: true,
      usage: {
        promptTokens: 96,
        completionTokens: 1_024,
        reasoningTokens: 0,
        cost: 0.001,
      },
    })
    const streamPage = await page.context().newPage()
    peer = streamPage
    await streamPage.goto(`/#/chat/${chatId}/message/${firstBranchId}`)
    await expect(
      streamPage.locator(`[data-ui="message"][data-message-id="${firstBranchId}"]`),
    ).toBeVisible()
    await sendMessage(streamPage, 'hold this branch while compaction debt is created')
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams)).toBe(1)

    const pinnedRoute = `#/chat/${chatId}/message/${secondBranchId}`
    const draft = 'this tab-local draft must survive compaction'
    const composer = page.locator('[data-ui="composer-input"]')
    await composer.fill(draft)
    const journeyProfile = createChatUiJourneyProfile()
    await uiJourney.start(
      page,
      {
        ...journeyProfile,
        semanticNodes: [
          ...(journeyProfile.semanticNodes ?? []),
          {
            id: 'compaction-local-draft',
            selector: '[data-ui="composer-input"]',
            properties: { value: { kind: 'stable' } },
            resetOnRouteChange: false,
          },
        ],
      },
      'storage-compaction-locality',
    )
    await uiJourney.intent(page, { kind: 'follow-bottom', id: 'storage-compaction-scroll' })

    const managerPage = await page.context().newPage()
    manager = managerPage
    await managerPage.goto('/#/storage/attachments')
    const attachmentManager = managerPage.locator('[data-ui="attachment-manager"]')
    await expect(attachmentManager).toBeVisible()
    await attachmentManager.locator('[data-ui="attachment-search"] input').fill('compaction-source')
    await attachmentManager.getByRole('link', { name: /compaction-source\.bin/u }).click()
    const details = attachmentManager.locator('[data-ui="attachment-details"]')
    await expect(details).toContainText('compaction-source.bin')
    const beforeDebtEstimate = await page.evaluate(() => navigator.storage.estimate())
    const chooserPromise = managerPage.waitForEvent('filechooser')
    await details.getByRole('button', { name: 'Replace', exact: true }).click()
    const chooser = await chooserPromise
    await chooser.setFiles(replacementUploadPath)
    await expect(details).toContainText('compaction-replacement.bin')

    await expect
      .poll(() => readWorkspaceControlSnapshot(page), { timeout: 30_000 })
      .toMatchObject({
        activeCompaction: {
          knownReclaimableBytes: expect.any(Number),
          requestRevision: 1,
          attemptedRevision: 1,
          completedRevision: 0,
        },
        pending: {
          phase: 'preparing',
        },
      })
    const before = await readWorkspaceControlSnapshot(page)
    expect(before.activeCompaction?.knownReclaimableBytes ?? 0).toBeGreaterThanOrEqual(
      COMPACTION_DEBT_BYTES,
    )
    expect(await scenario.snapshot()).toMatchObject({ activeStreams: 1, requestCount: 1 })
    const afterDebtEstimate = await page.evaluate(() => navigator.storage.estimate())

    const titleBeforeCatchup = await readChatTitleFromDatabase(
      page,
      before.activeDatabaseName,
      chatId,
    )
    if (titleBeforeCatchup === null) throw new Error('StorageCompactionTitleMissing')
    await page.locator('[data-role="chat-title-edit"]').click()
    const titleEditor = page.locator('[data-ui="chat-title-editor"]')
    await titleEditor.fill('Compaction catch-up stayed interactive')
    await expect
      .poll(() => readWorkspaceControlSnapshot(page), { timeout: 30_000 })
      .toMatchObject({
        activeDatabaseName: before.activeDatabaseName,
        activationSequence: before.activationSequence,
        pending: {
          phase: 'preparing',
          sourceDatabaseName: before.activeDatabaseName,
        },
        activeCompaction: {
          requestRevision: 1,
          attemptedRevision: 1,
          completedRevision: 0,
        },
      })
    const preparing = await readWorkspaceControlSnapshot(page)
    if (!preparing.pending) throw new Error('StorageCompactionPreparingJournalMissing')
    await expect
      .poll(
        () =>
          readChatTitleFromDatabase(page, preparing.pending?.destinationDatabaseName ?? '', chatId),
        { timeout: 60_000 },
      )
      .toBe(titleBeforeCatchup)

    await titleEditor.press('Enter')
    await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText(
      'Compaction catch-up stayed interactive',
    )
    await expect
      .poll(() => readChatTitleFromDatabase(page, before.activeDatabaseName, chatId))
      .toBe('Compaction catch-up stayed interactive')

    const editDraft = 'this inline edit must survive workspace replacement'
    const editedUser = page.locator('[data-ui="message"][data-role="user"]').last()
    await editedUser.getByRole('button', { name: 'Edit message' }).click()
    const inlineEditor = editedUser.locator('[data-ui="inline-editor-input"]')
    await inlineEditor.fill(editDraft)
    await expect(editedUser.getByRole('button', { name: 'Save & Send' })).toBeEnabled()

    await scenario.release()
    await expect
      .poll(() => scenario.snapshot().then((snapshot) => snapshot.activeStreams), {
        timeout: 30_000,
      })
      .toBe(0)

    await expect
      .poll(() => readWorkspaceControlSnapshot(page, before.activeDatabaseName), {
        timeout: 60_000,
      })
      .toMatchObject({
        activationSequence: before.activationSequence + 1,
        pending: null,
        activeCompaction: {
          knownReclaimableBytes: expect.any(Number),
          requestRevision: expect.any(Number),
          attemptedRevision: expect.any(Number),
          completedRevision: expect.any(Number),
        },
      })
    await expect
      .poll(
        () =>
          readWorkspaceControlSnapshot(page, before.activeDatabaseName).then((snapshot) => ({
            databaseNames: snapshot.databaseNames,
            sourceCompaction: snapshot.sourceCompaction,
          })),
        { timeout: 60_000 },
      )
      .toEqual({
        databaseNames: expect.not.arrayContaining([before.activeDatabaseName]),
        sourceCompaction: null,
      })
    const committed = await readWorkspaceControlSnapshot(page, before.activeDatabaseName)
    expect(committed.activeCompaction?.requestRevision).toBeGreaterThanOrEqual(1)
    expect(committed.activeCompaction?.attemptedRevision).toBe(
      committed.activeCompaction?.requestRevision,
    )
    expect(committed.activeCompaction?.completedRevision).toBe(
      committed.activeCompaction?.requestRevision,
    )
    expect(
      committed.activeCompaction?.knownReclaimableBytes ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(STORAGE_COMPACTION_MIN_RECLAIMABLE_BYTES)
    expect(committed.activeDatabaseName).not.toBe(before.activeDatabaseName)
    expect(committed.sourceCompaction).toBeNull()
    expect(committed.databaseNames).not.toContain(before.activeDatabaseName)
    expect(await activeWorkspaceDatabaseName(page)).toBe(committed.activeDatabaseName)

    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(pinnedRoute)
    await expect(composer).toHaveValue(draft)
    await expect(inlineEditor).toBeVisible()
    await expect(inlineEditor).toHaveValue(editDraft)
    await expect(editedUser.getByRole('button', { name: 'Save & Send' })).toBeEnabled()
    await expect(secondBranch.locator('[data-ui="message-body"]')).toHaveText(/Lorem ipsum/u)
    await expect(secondBranch.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')
    await expect
      .poll(() =>
        streamPage
          .locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]')
          .last()
          .evaluate((node) => node.textContent.length),
      )
      .toBe(4_096)

    await uiJourney.intent(page, {
      kind: 'gesture',
      id: 'storage-compaction-save-send',
      targetSelector: '[data-role="save-send"]',
      allowsRouteChange: true,
      expectedRoute: { kind: 'prefix', value: `/#/chat/${chatId}/message/` },
      outcome: {
        selector: '[data-ui="message"][data-role="assistant"] [data-ui="message-body"]',
        requireInteractive: false,
      },
    })
    await editedUser.getByRole('button', { name: 'Save & Send' }).click()
    await expect.poll(() => scenario.snapshot().then((snapshot) => snapshot.requestCount)).toBe(2)
    await expect(
      page
        .locator('[data-ui="message"][data-role="user"] [data-ui="message-body"]')
        .filter({ hasText: editDraft }),
    ).toHaveCount(1)
    await expect
      .poll(() =>
        page
          .locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]')
          .last()
          .evaluate((node) => node.textContent.length),
      )
      .toBe(4_096)
    const saveAndSendRoute = await page.evaluate(() => window.location.hash)
    expect(saveAndSendRoute).toMatch(new RegExp(`^#/chat/${chatId}/message/`, 'u'))
    const journey = await uiJourney.finish(page, 'storage-compaction-committed')
    expect(journey.violations).toEqual([])

    await Promise.all([page.reload(), streamPage.reload()])
    await expect(page.locator('[data-ui="chat-title-label"]')).toHaveText(
      'Compaction catch-up stayed interactive',
    )
    await expect(page.locator('[data-ui="composer-input"]')).toHaveValue(draft)
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(saveAndSendRoute)
    await expect
      .poll(() =>
        streamPage
          .locator('[data-ui="message"][data-role="assistant"] [data-ui="message-body"]')
          .last()
          .evaluate((node) => node.textContent.length),
      )
      .toBe(4_096)

    await testInfo.attach('storage-compaction-browser-state.json', {
      body: JSON.stringify(
        {
          before,
          committed,
          browserEstimate: {
            beforeDebt: beforeDebtEstimate,
            afterDebt: afterDebtEstimate,
            afterCommit: await page.evaluate(() => navigator.storage.estimate()),
          },
          fakeStream: await scenario.snapshot(),
        },
        null,
        2,
      ),
      contentType: 'application/json',
    })
  } finally {
    await Promise.allSettled([peer?.close(), manager?.close(), scenario.dispose()])
    await Promise.allSettled([unlink(firstUploadPath), unlink(replacementUploadPath)])
  }
})

test('durable replacement state recovers crashed owners and serializes competing tabs', async ({
  context,
  page,
}, testInfo) => {
  testInfo.setTimeout(150_000)
  await clearIndexedDb(page)
  await mockChatCompletions(page, {
    body: buildSseBody([
      { id: 'replacement-crash-response', content: 'durable replacement branch' },
      { finish: 'stop' },
    ]),
  })
  await seedFirstRun(page)
  await createChatAndOpen(page)
  await sendMessage(page, 'create durable replacement branches')
  const firstBranch = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(firstBranch.locator('[data-ui="message-body"]')).toHaveText(
    'durable replacement branch',
  )
  await firstBranch.locator('[data-action="regenerate"]').click()
  const secondBranch = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(secondBranch.locator('[data-ui="branch-count"]')).toHaveText('2 / 2')
  const chatId = await firstChatId(page)
  const branchId = await secondBranch.getAttribute('data-message-id')
  if (!branchId) throw new Error('ReplacementCrashBranchMissing')
  const branchRoute = `/#/chat/${chatId}/message/${branchId}`
  const backupPath = testInfo.outputPath('replacement-crash-workspace.json')
  await page.goto('/#/storage')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export all' }).click()
  await page.getByRole('button', { name: 'Export sensitive backup' }).click()
  await (await downloadPromise).saveAs(backupPath)
  await page.goto(branchRoute)
  await expectBranchControlsReady(page, branchId)

  let preactivationInitiator: Page | undefined
  let postactivationInitiator: Page | undefined
  let firstCompetitor: Page | undefined
  let secondCompetitor: Page | undefined
  let sourceBlocker: BrowserLockHandle | undefined
  let destinationBlocker: BrowserLockHandle | undefined
  let selectionBlocker: BrowserLockHandle | undefined
  try {
    preactivationInitiator = await context.newPage()
    await preactivationInitiator.goto('/#/storage')
    await expect(
      preactivationInitiator.locator('[data-ui="storage-workspace-import-input"]'),
    ).toBeAttached()
    const preactivationSource = await readWorkspaceControlSnapshot(page)
    sourceBlocker = await queueBrowserLock(
      page,
      workspaceSlotLock(preactivationSource.activeDatabaseName),
      'shared',
    )
    await expect
      .poll(() => browserLockState(page, sourceBlocker as BrowserLockHandle))
      .toMatchObject({
        acquired: true,
        failure: null,
      })
    preactivationInitiator.once('dialog', (dialog) => dialog.accept())
    await preactivationInitiator
      .locator('[data-ui="storage-workspace-import-input"]')
      .setInputFiles(backupPath)
    await expect
      .poll(() => readWorkspaceControlSnapshot(page))
      .toMatchObject({
        activeDatabaseName: preactivationSource.activeDatabaseName,
        activationSequence: preactivationSource.activationSequence,
        pending: {
          phase: 'preparing',
          sourceDatabaseName: preactivationSource.activeDatabaseName,
        },
      })
    await expect
      .poll(() =>
        browserLockState(page, {
          id: sourceBlocker?.id ?? '',
          name: workspaceSlotLock(preactivationSource.activeDatabaseName),
        }),
      )
      .toMatchObject({ failure: null })
    await expect
      .poll(async () => {
        const snapshot = await navigatorLockSnapshot(page)
        return snapshot.pending.includes(workspaceSlotLock(preactivationSource.activeDatabaseName))
      })
      .toBe(true)
    await preactivationInitiator.close()
    preactivationInitiator = undefined
    await expect
      .poll(() => readWorkspaceControlSnapshot(page), { timeout: 30_000 })
      .toMatchObject({
        activeDatabaseName: preactivationSource.activeDatabaseName,
        activationSequence: preactivationSource.activationSequence,
        pending: null,
      })
    await releaseBrowserLock(page, sourceBlocker)
    sourceBlocker = undefined
    await expectBranchControlsReady(page, branchId)

    const postactivationSource = await readWorkspaceControlSnapshot(page)
    const sourceIndex = BROWSER_WORKSPACE_DATABASE_NAMES.indexOf(
      postactivationSource.activeDatabaseName,
    )
    if (sourceIndex < 0) throw new Error('ReplacementCrashSourceDatabaseInvalid')
    const destinationDatabaseName =
      BROWSER_WORKSPACE_DATABASE_NAMES[(sourceIndex + 1) % BROWSER_WORKSPACE_DATABASE_NAMES.length]
    if (!destinationDatabaseName) throw new Error('ReplacementCrashDestinationDatabaseMissing')
    destinationBlocker = await queueBrowserLock(
      page,
      workspaceSlotLock(destinationDatabaseName),
      'shared',
    )
    await expect
      .poll(() => browserLockState(page, destinationBlocker as BrowserLockHandle))
      .toMatchObject({ acquired: true, failure: null })
    postactivationInitiator = await context.newPage()
    await postactivationInitiator.goto('/#/storage')
    postactivationInitiator.once('dialog', (dialog) => dialog.accept())
    await postactivationInitiator
      .locator('[data-ui="storage-workspace-import-input"]')
      .setInputFiles(backupPath)
    await expect
      .poll(() => readWorkspaceControlSnapshot(page))
      .toMatchObject({
        activeDatabaseName: postactivationSource.activeDatabaseName,
        activationSequence: postactivationSource.activationSequence,
        pending: {
          phase: 'preparing',
          sourceDatabaseName: postactivationSource.activeDatabaseName,
          destinationDatabaseName,
        },
      })
    selectionBlocker = await queueBrowserLock(page, WORKSPACE_SELECTION_LOCK, 'exclusive')
    await expect
      .poll(() => navigatorLockSnapshot(page))
      .toMatchObject({ pending: expect.arrayContaining([WORKSPACE_SELECTION_LOCK]) })
    await releaseBrowserLock(page, destinationBlocker)
    destinationBlocker = undefined
    await expect
      .poll(() => browserLockState(page, selectionBlocker as BrowserLockHandle), {
        timeout: 30_000,
      })
      .toMatchObject({ acquired: true, failure: null })
    await expect
      .poll(() => readWorkspaceControlSnapshot(page))
      .toMatchObject({
        activeDatabaseName: destinationDatabaseName,
        activationSequence: postactivationSource.activationSequence + 1,
      })
    await postactivationInitiator.close()
    postactivationInitiator = undefined
    await releaseBrowserLock(page, selectionBlocker)
    selectionBlocker = undefined
    await expect
      .poll(
        () =>
          readWorkspaceControlSnapshot(page, postactivationSource.activeDatabaseName).then(
            (snapshot) => ({
              activeDatabaseName: snapshot.activeDatabaseName,
              activationSequence: snapshot.activationSequence,
              databaseNames: snapshot.databaseNames,
              pending: snapshot.pending,
            }),
          ),
        { timeout: 30_000 },
      )
      .toEqual({
        activeDatabaseName: destinationDatabaseName,
        activationSequence: postactivationSource.activationSequence + 1,
        databaseNames: expect.not.arrayContaining([postactivationSource.activeDatabaseName]),
        pending: null,
      })
    await expectBranchControlsReady(page, branchId)

    await expect
      .poll(async () => {
        const snapshot = await readWorkspaceControlSnapshot(page)
        return {
          pending: snapshot.pending,
          compactionSettled:
            snapshot.activeCompaction !== null &&
            snapshot.activeCompaction.attemptedRevision ===
              snapshot.activeCompaction.requestRevision &&
            snapshot.activeCompaction.completedRevision ===
              snapshot.activeCompaction.requestRevision,
        }
      })
      .toEqual({
        pending: null,
        compactionSettled: true,
      })
    const beforeCompetition = await readWorkspaceControlSnapshot(page)
    firstCompetitor = await context.newPage()
    secondCompetitor = await context.newPage()
    await Promise.all([firstCompetitor.goto('/#/storage'), secondCompetitor.goto('/#/storage')])
    firstCompetitor.once('dialog', (dialog) => dialog.accept())
    secondCompetitor.once('dialog', (dialog) => dialog.accept())
    await Promise.all([
      firstCompetitor
        .locator('[data-ui="storage-workspace-import-input"]')
        .setInputFiles(backupPath),
      secondCompetitor
        .locator('[data-ui="storage-workspace-import-input"]')
        .setInputFiles(backupPath),
    ])
    await expect
      .poll(() => readWorkspaceControlSnapshot(page), { timeout: 60_000 })
      .toMatchObject({
        activationSequence: beforeCompetition.activationSequence + 2,
        pending: null,
      })
    const competed = await readWorkspaceControlSnapshot(page)
    await expect
      .poll(() =>
        Promise.all([
          activeWorkspaceDatabaseName(page),
          activeWorkspaceDatabaseName(firstCompetitor as Page),
          activeWorkspaceDatabaseName(secondCompetitor as Page),
        ]),
      )
      .toEqual([
        competed.activeDatabaseName,
        competed.activeDatabaseName,
        competed.activeDatabaseName,
      ])
    await expectBranchControlsReady(page, branchId)
  } finally {
    if (selectionBlocker) await releaseBrowserLock(page, selectionBlocker).catch(() => undefined)
    if (destinationBlocker) {
      await releaseBrowserLock(page, destinationBlocker).catch(() => undefined)
    }
    if (sourceBlocker) await releaseBrowserLock(page, sourceBlocker).catch(() => undefined)
    await Promise.allSettled([
      preactivationInitiator?.close(),
      postactivationInitiator?.close(),
      firstCompetitor?.close(),
      secondCompetitor?.close(),
    ])
    await unlink(backupPath).catch(() => undefined)
  }
})

test('records schema cleanup without assuming immediate Chromium quota reclamation', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  const measurement = await page.evaluate(async (): Promise<StorageReclamationProbe> => {
    const dbName = `natter-storage-reclaim-probe-${crypto.randomUUID()}`
    const rowCount = 12
    const rowBytes = 1024 * 1024

    const usage = async (): Promise<number> => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      return (await navigator.storage.estimate()).usage ?? 0
    }
    const open = (version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version)
        request.onupgradeneeded = () => upgrade(request.result)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result)
      })
    const complete = (transaction: IDBTransaction): Promise<void> =>
      new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    const remove = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve()
      })

    const beforeBytes = await usage()
    const first = await open(1, (db) => db.createObjectStore('obsolete', { keyPath: 'id' }))
    const write = first.transaction('obsolete', 'readwrite')
    const store = write.objectStore('obsolete')
    for (let id = 0; id < rowCount; id += 1) {
      const bytes = new Uint8Array(rowBytes)
      for (let offset = 0; offset < bytes.length; offset += 65_536) {
        crypto.getRandomValues(bytes.subarray(offset, Math.min(bytes.length, offset + 65_536)))
      }
      store.put({ id, blob: new Blob([bytes]) })
    }
    await complete(write)
    const afterWriteBytes = await usage()
    first.close()

    const upgraded = await open(2, (db) => {
      db.deleteObjectStore('obsolete')
      db.createObjectStore('current', { keyPath: 'id' })
    })
    const storesAfterUpgrade = [...upgraded.objectStoreNames]
    const afterUpgradeBytes = await usage()
    upgraded.close()
    await remove()
    const afterDeleteBytes = await usage()

    return {
      beforeBytes,
      afterWriteBytes,
      afterUpgradeBytes,
      afterDeleteBytes,
      insertedBytes: rowCount * rowBytes,
      storesAfterUpgrade,
    }
  })

  await testInfo.attach('storage-reclamation-probe.json', {
    body: JSON.stringify(measurement, null, 2),
    contentType: 'application/json',
  })
  expect(measurement.storesAfterUpgrade).toEqual(['current'])
  expect(measurement.afterWriteBytes - measurement.beforeBytes).toBeGreaterThan(
    measurement.insertedBytes / 2,
  )
  expect(measurement.afterUpgradeBytes).toBeGreaterThanOrEqual(measurement.beforeBytes)
  expect(measurement.afterDeleteBytes).toBeGreaterThanOrEqual(measurement.beforeBytes)
})

test('clear all reloads into a fresh workspace that can fetch and select models again', async ({
  context,
  page,
}) => {
  await page.route('https://openrouter.ai/api/v1/models**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [RECOVERED_MODEL, ...EXPECTED_DEFAULT_PINNED_OPENROUTER_MODELS].map((id) => ({
          id,
          name: id === RECOVERED_MODEL ? 'Storage recovered model' : id,
          context_length: 131_072,
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
            tokenizer: 'Other',
          },
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['max_completion_tokens'],
        })),
      }),
    })
  })
  await page.route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: RECOVERED_MODEL,
          name: 'Storage recovered model',
          context_length: 131_072,
          architecture: {
            input_modalities: ['text'],
            output_modalities: ['text'],
            tokenizer: 'Other',
          },
          endpoints: [
            {
              provider_name: 'Fixture provider',
              provider_slug: 'fixture-provider',
              supported_parameters: ['max_completion_tokens'],
              context_length: 131_072,
              max_prompt_tokens: 131_072,
              max_completion_tokens: 4096,
              pricing: { prompt: '0', completion: '0' },
            },
          ],
        },
      }),
    })
  })

  await seedFirstRun(page)
  const namespaceNames = {
    database: 'natter-clear-all-auxiliary',
    cache: 'natter-clear-all-cache',
    opfs: 'natter-clear-all-opfs',
    bucket: 'natter-clear-all-bucket',
    localStorage: 'natter-clear-all-local-probe',
    sessionStorage: 'natter-clear-all-session-probe',
  }
  const seeded = await page.evaluate(async (names) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(names.database, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('rows')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('rows', 'readwrite')
      transaction.objectStore('rows').put('probe', 'probe')
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()

    const cache = await caches.open(names.cache)
    await cache.put('/__natter-clear-all-cache-probe__', new Response('probe'))
    localStorage.setItem(names.localStorage, 'probe')
    sessionStorage.setItem(names.sessionStorage, 'probe')

    const storage = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<{
        getFileHandle(
          name: string,
          options: { create: true },
        ): Promise<{
          createWritable(): Promise<{ write(value: string): Promise<void>; close(): Promise<void> }>
        }>
      }>
    }
    let opfs = false
    if (typeof storage.getDirectory === 'function') {
      const root = await storage.getDirectory()
      const file = await root.getFileHandle(names.opfs, { create: true })
      const writable = await file.createWritable()
      await writable.write('probe')
      await writable.close()
      opfs = true
    }

    const buckets = (
      navigator as Navigator & {
        storageBuckets?: {
          open?: (name: string) => Promise<unknown>
          keys?: () => Promise<readonly string[]>
        }
      }
    ).storageBuckets
    let bucket = false
    if (typeof buckets?.open === 'function' && typeof buckets.keys === 'function') {
      await buckets.open(names.bucket)
      bucket = (await buckets.keys()).includes(names.bucket)
    }

    return {
      database:
        typeof indexedDB.databases === 'function' &&
        (await indexedDB.databases()).some((candidate) => candidate.name === names.database),
      opfs,
      bucket,
    }
  }, namespaceNames)
  expect(seeded.database, 'Chromium must expose and enumerate the auxiliary database').toBe(true)

  const secondPage = await context.newPage()
  await secondPage.goto('/#/new')
  await expect(secondPage.locator('[data-ui="composer"]')).toBeVisible()
  await secondPage.evaluate(
    (key) => sessionStorage.setItem(key, 'probe'),
    namespaceNames.sessionStorage,
  )

  await page.goto('/#/storage')
  await expect(page.locator('[data-ui="storage-overview"]')).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  const reloaded = page.waitForEvent('load')
  const secondReloaded = secondPage.waitForEvent('load')
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await Promise.all([reloaded, secondReloaded])
  await expect(page).toHaveURL(/#\/storage$/u)
  await expect(secondPage).toHaveURL(/#\/new$/u)

  const cleared = await page.evaluate(async (names) => {
    const databases =
      typeof indexedDB.databases === 'function'
        ? (await indexedDB.databases()).flatMap((database) =>
            database.name === undefined ? [] : [database.name],
          )
        : null
    const cacheNames = await caches.keys()
    const storage = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<{ entries(): AsyncIterableIterator<[string, unknown]> }>
    }
    const opfsEntries: string[] = []
    if (typeof storage.getDirectory === 'function') {
      const root = await storage.getDirectory()
      for await (const [name] of root.entries()) opfsEntries.push(name)
    }
    const buckets = (
      navigator as Navigator & {
        storageBuckets?: { keys?: () => Promise<readonly string[]> }
      }
    ).storageBuckets
    return {
      databases,
      cacheNames,
      opfsEntries,
      bucketNames: typeof buckets?.keys === 'function' ? await buckets.keys() : [],
      localProbe: localStorage.getItem(names.localStorage),
      sessionProbe: sessionStorage.getItem(names.sessionStorage),
    }
  }, namespaceNames)
  expect(cleared.databases, 'Chromium must enumerate databases after the wipe').not.toBeNull()
  expect(cleared.databases).not.toContain(namespaceNames.database)
  expect(cleared.cacheNames).not.toContain(namespaceNames.cache)
  expect(cleared.localProbe).toBeNull()
  expect(cleared.sessionProbe).toBeNull()
  if (seeded.opfs) expect(cleared.opfsEntries).not.toContain(namespaceNames.opfs)
  if (seeded.bucket) expect(cleared.bucketNames).not.toContain(namespaceNames.bucket)
  expect(
    await secondPage.evaluate((key) => sessionStorage.getItem(key), namespaceNames.sessionStorage),
  ).toBeNull()
  await expect(secondPage.locator('[data-ui="connection-add"]')).toBeVisible()

  await page.goto('/')
  await expect(page.locator('[data-ui="connection-add"]')).toBeVisible()
  await page.locator('[data-ui="connection-add"]').click()
  await page
    .locator('[data-ui="connection-setup-key"]')
    .fill('sk-or-v1-test-storage-recovery-0000000000000000000000')
  await page.locator('[data-ui="connection-setup-submit"]').click()
  await page.locator('[data-ui="connection-setup-modal"]').waitFor({ state: 'detached' })

  await page.locator('[data-role="new-chat"]').click()
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
  await page.locator('[data-role="settings-cog"]').click()
  await page.getByRole('tab', { name: 'Model' }).click()
  const search = page.locator('[data-ui="model-picker-search-input"]')
  for (const modelId of EXPECTED_DEFAULT_PINNED_OPENROUTER_MODELS) {
    await search.fill(modelId)
    const pinnedRow = page.locator('[data-ui="picker-row"]').filter({ hasText: modelId })
    await expect(pinnedRow).toBeVisible()
    await expect(pinnedRow).toHaveAttribute('data-pinned', 'true')
    await expect(pinnedRow.getByRole('button', { name: 'Unpin model' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  }
  await search.fill(RECOVERED_MODEL)
  const row = page.locator('[data-ui="picker-row"]').filter({ hasText: RECOVERED_MODEL })
  await expect(row).toBeVisible()
  await expect(
    page.locator('[data-ui="model-picker"]').getByText('Loading…', { exact: true }),
  ).toHaveCount(0)
  await row.locator('[data-ui="picker-row-pick"]').click()
  await expect(row).toHaveAttribute('data-current', 'true')
})

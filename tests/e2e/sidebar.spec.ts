import { appendChatCatalogFixturesThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { createChatUiJourneyProfile, expect, type Page, test } from './fixtures'
import {
  clickSidebarToggleWithoutActionabilityWait,
  startForegroundGestureRecorder,
} from './foreground-gesture'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  createChatAndSend,
  firstChatId,
  holdIndexedDbStoreGate,
  mockChatCompletions,
  readMessages,
  seedFirstRun,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
  await mockChatCompletions(page, {
    body: buildSseBody([{ id: 'g', content: 'ok', finish: 'stop' }]),
  })
})

test('clicking new-chat navigates to a blank composer without creating a visible chat row', async ({
  page,
}) => {
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(0)
  await createChatAndOpen(page)
  // Composer is ready, but no visible sidebar row yet — rows surface on first send.
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(0)
})

test('chat rows become visible only on first send (no spam from repeated new-chat clicks)', async ({
  page,
}) => {
  // Three #/new visits with NO send → still zero visible rows.
  await createChatAndOpen(page)
  await createChatAndOpen(page)
  await createChatAndOpen(page)
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(0)
  // Three send-on-new-chat flows → exactly three rows.
  await createChatAndSend(page, 'one')
  await createChatAndSend(page, 'two')
  await createChatAndSend(page, 'three')
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
})

test('clicking a chat row navigates to it and swaps the main pane', async ({ page }) => {
  await createChatAndSend(page, 'first')
  await createChatAndSend(page, 'second')
  // The newest chat (second) is currently active. Click the older (first) row.
  const rows = page.locator('[data-ui="chat-row-link"]')
  // Wait until both rows are present in the sidebar (newest is on top).
  await expect(rows).toHaveCount(2)
  await rows.nth(1).click()
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
  await expect(page.locator('[data-ui="message"][data-role="user"]')).toContainText('first')
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
})

test('sidebar chat switching never exposes null connection, message actions, or privacy frames', async ({
  page,
}) => {
  await createChatAndSend(page, 'first continuity chat')
  await createChatAndSend(page, 'second continuity chat')
  const rows = page.locator('[data-ui="chat-row-link"]')
  await expect(rows).toHaveCount(2)
  await expect(page.locator('[data-ui="connection-provider-button"] svg')).toHaveCount(1)
  await expect(page.locator('[data-ui="header-privacy-badge"]')).toHaveCount(1)
  await expect(page.locator('[data-action="edit"]')).not.toHaveCount(0)

  await page.evaluate(() => {
    const selectors = {
      message: '[data-ui="message"]',
      connection: '[data-ui="connection-provider-button"] svg',
      edit: '[data-action="edit"]',
      fork: '[data-action="fork-chat"]',
      visibility: '[data-action="toggle-visible"]',
      trash: '[data-action="delete-pair"]',
      privacy: '[data-ui="header-privacy-badge"]',
    } as const
    const minimums = Object.fromEntries(
      Object.entries(selectors).map(([key, selector]) => [
        key,
        document.querySelectorAll(selector).length,
      ]),
    ) as Record<keyof typeof selectors, number>
    const sample = () => {
      for (const [key, selector] of Object.entries(selectors) as Array<
        [keyof typeof selectors, string]
      >) {
        minimums[key] = Math.min(minimums[key], document.querySelectorAll(selector).length)
      }
      const messageCount = document.querySelectorAll(selectors.message).length
      for (const key of ['edit', 'fork', 'visibility', 'trash'] as const) {
        const buttons = [...document.querySelectorAll<HTMLButtonElement>(selectors[key])]
        if (
          buttons.length < messageCount ||
          buttons.some((button) => button.disabled || Number(getComputedStyle(button).opacity) < 1)
        ) {
          minimums[key] = 0
        }
      }
    }
    const observer = new MutationObserver(sample)
    observer.observe(document.querySelector('main') ?? document.body, {
      childList: true,
      subtree: true,
    })
    ;(
      window as typeof window & {
        __chatSwitchContinuity?: {
          minimums: typeof minimums
          stop(): typeof minimums
        }
      }
    ).__chatSwitchContinuity = {
      minimums,
      stop: () => {
        sample()
        observer.disconnect()
        return { ...minimums }
      },
    }
  })

  const releaseMessages = await holdIndexedDbStoreGate(page, ['messages'])
  try {
    await rows.nth(1).click()
    await expect(page).toHaveURL(/#\/chat\//)
    await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toContainText(
      'first continuity chat',
    )
  } finally {
    await releaseMessages()
  }
  await expect(page.locator('[data-ui="message"][data-role="user"]')).toContainText(
    'first continuity chat',
  )
  const minimums = await page.evaluate(() => {
    const recorder = (
      window as typeof window & {
        __chatSwitchContinuity?: { stop(): Record<string, number> }
      }
    ).__chatSwitchContinuity
    if (!recorder) throw new Error('ChatSwitchContinuityRecorderMissing')
    return recorder.stop()
  })
  expect(minimums).toEqual({
    message: 1,
    connection: 1,
    edit: 1,
    fork: 1,
    visibility: 1,
    trash: 1,
    privacy: 1,
  })
})

test('clicking the brand returns to home (no chat selected)', async ({ page }) => {
  await createChatAndSend(page, 'first')
  await page.locator('[data-ui="brand"]').click()
  // Home shows the launcher (sample prompts) and no chat is active.
  await expect(page.locator('[data-ui="empty-state"]')).toBeVisible()
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(0)
})

test('reload preserves the active chat (URL is the source of truth)', async ({ page }) => {
  await createChatAndSend(page, 'persisted')
  const chatId = await firstChatId(page)
  const assistant = (await readMessages(page, chatId)).find(
    (message) => message.role === 'assistant',
  )
  if (typeof assistant?.id !== 'string') throw new Error('Expected an assistant message')
  const hashBefore = await page.evaluate(() => window.location.hash)
  expect(hashBefore).toBe(`#/chat/${chatId}/message/${assistant.id}`)
  await page.reload()
  // Same hash, same row marked active.
  const hashAfter = await page.evaluate(() => window.location.hash)
  expect(hashAfter).toBe(hashBefore)
  await expect(page.locator('[data-ui="chat-row"][data-active="true"]')).toHaveCount(1)
  await expect(page.locator('[data-ui="composer"]')).toBeVisible()
})

test('chat-row anchor exposes a real href so middle/Cmd-click can open it in a new tab', async ({
  page,
}) => {
  await createChatAndSend(page, 'inspect href')
  const link = page.locator('[data-ui="chat-row-link"]').first()
  const href = await link.getAttribute('href')
  expect(href).toMatch(/^#\/chat\/[A-Z0-9]{20,}$/i)
})

test('middle-click New chat preserves the source tab and the first foreground gesture', async ({
  context,
  page,
  uiJourney,
}) => {
  await createChatAndSend(page, 'first source chat')
  await createChatAndSend(page, 'second source chat')
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(2)
  const sourceHash = await page.evaluate(() => window.location.hash)

  const popupPromise = context.waitForEvent('page')
  await page.locator('[data-role="new-chat"]').click({ button: 'middle' })
  const popup = await popupPromise
  try {
    await expect(popup).toHaveURL(/#\/new$/)
    await expect(popup.locator('[data-ui="chat-title-label"]')).toHaveText('New chat')
    await expect(popup.locator('[data-ui="composer"]')).toBeVisible()
    await expect(popup.locator('[data-ui="chat-row"]')).toHaveCount(2)
    expect(await page.evaluate(() => window.location.hash)).toBe(sourceHash)

    await uiJourney.start(
      popup,
      createChatUiJourneyProfile({ chatHeader: false }),
      'middle-click-new-chat-activation',
    )
    const initialSidebarState = await startForegroundGestureRecorder(popup)
    const nextSidebarState = initialSidebarState === 'expanded' ? 'collapsed' : 'expanded'
    await uiJourney.intent(popup, {
      kind: 'gesture',
      id: 'background-new-chat-first-sidebar-toggle',
      targetSelector: '[data-role="sidebar-toggle"]',
      expectedDeliveries: 1,
      outcome: {
        selector: '[data-ui="app-shell"]',
        attributes: {
          'data-sidebar': { kind: 'exact', value: nextSidebarState },
        },
      },
    })
    await popup.bringToFront()
    const gesture = await clickSidebarToggleWithoutActionabilityWait(popup)
    expect(gesture).toMatchObject({
      clickCount: 1,
      sidebarTransitions: [nextSidebarState],
      shellIdentityStable: true,
      toggleIdentityStable: true,
      hitTargetWasToggle: true,
      openingStillPending: false,
      runtimeState: 'RUNNING',
    })
    expect(gesture.clickAt).not.toBeNull()
    expect(gesture.outcomeAt).not.toBeNull()
    const report = await uiJourney.finish(popup, 'middle-click-new-chat-first-gesture')
    expect(report.violations).toEqual([])
    await expect(popup).toHaveURL(/#\/new$/)
    await expect(popup.locator('[data-ui="chat-row"]')).toHaveCount(2)
    expect(await page.evaluate(() => window.location.hash)).toBe(sourceHash)
    await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(2)
  } finally {
    await popup.close()
  }
})

test('folder create, rename, move, and delete keep the chat visible through public controls', async ({
  page,
}) => {
  await createChatAndSend(page, 'folder lifecycle')
  page.once('dialog', (dialog) => dialog.accept('Projects'))
  await page.getByLabel('New folder').click()
  let folder = page.locator('[data-ui="folder-section"]').filter({ hasText: 'Projects' })
  await expect(folder).toBeVisible()
  await expect(folder.locator('[data-ui="folder-count"]')).toHaveText('0')

  page.once('dialog', (dialog) => dialog.accept('Renamed projects'))
  await folder.getByLabel('Rename folder Projects').click()
  folder = page.locator('[data-ui="folder-section"]').filter({ hasText: 'Renamed projects' })
  await expect(folder).toBeVisible()

  const chat = page.locator('[data-ui="chat-row"]').filter({ hasText: 'folder lifecycle' })
  await chat.hover()
  await chat.locator('[data-ui="chat-row-menu-button"]').click()
  page.once('dialog', (dialog) => dialog.accept('Renamed projects'))
  await page.locator('[data-ui="chat-row-folder"]').click()
  await expect(folder.locator('[data-ui="folder-count"]')).toHaveText('1')
  await expect(chat).toHaveAttribute('data-sidebar-depth', 'folder')

  await folder.getByLabel('Delete folder Renamed projects').click()
  const dialog = page.getByRole('dialog', { name: 'Delete folder' })
  await expect(dialog.getByText('Delete chats in folder')).toBeVisible()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(folder).toHaveCount(0)
  await expect(chat).toBeVisible()
  await expect(chat).not.toHaveAttribute('data-sidebar-depth', 'folder')
})

test('filtered virtual sidebar preserves its anchor across matching peer additions and removals', async ({
  context,
  page,
}) => {
  const now = Date.now()
  const focusTagId = 'sidebar-focus-tag'
  const focusFolderId = 'sidebar-focus-folder'
  await appendChatCatalogFixturesThroughUi(page, {
    now,
    workspaceSettings: {
      'global:sidebar-render-window-size': 300,
      'global:sidebar-render-window-load-mode': 'manual',
    },
    folders: [
      {
        id: focusFolderId,
        name: 'Focus Folder',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'sidebar-other-folder',
        name: 'Other Folder',
        createdAt: now - 1,
        updatedAt: now - 1,
      },
    ],
    tags: [
      {
        id: focusTagId,
        name: 'Focus',
        createdAt: now,
        updatedAt: now,
        lastUsedAt: now,
      },
    ],
    chats: [
      ...Array.from({ length: 230 }, (_, index) => ({
        id: `sidebar-focus-chat-${String(index).padStart(3, '0')}`,
        title:
          index === 229 ? 'Zulu pinned Focus chat' : `Focus chat ${String(index).padStart(3, '0')}`,
        createdAt: now - index,
        updatedAt: now + index,
        lastViewedAt: now + index,
        wordCount: 100 + index,
        pinned: index === 229,
        folderId: focusFolderId,
        tags: [focusTagId],
        previewText: `focus preview ${index}`,
      })),
      {
        id: 'sidebar-archived-focus-chat',
        title: 'Archived Focus chat',
        createdAt: now - 400,
        updatedAt: now - 400,
        lastViewedAt: now - 400,
        wordCount: 20,
        archived: true,
        folderId: focusFolderId,
        tags: [focusTagId],
        previewText: 'archived focus preview',
      },
      {
        id: 'sidebar-outside-focus-chat',
        title: 'A Focus chat outside',
        createdAt: now - 401,
        updatedAt: now - 401,
        lastViewedAt: now - 401,
        wordCount: 20,
        folderId: focusFolderId,
        previewText: 'outside focus preview',
      },
      {
        id: 'sidebar-wrong-folder-chat',
        title: 'Focus chat wrong folder',
        createdAt: now - 402,
        updatedAt: now - 402,
        lastViewedAt: now - 402,
        wordCount: 20,
        folderId: 'sidebar-other-folder',
        tags: [focusTagId],
        previewText: 'wrong folder focus preview',
      },
    ],
  })
  await page.goto('/')
  await page.reload()

  const list = page.locator('[data-ui="chat-list"]')
  const initialHash = await page.evaluate(() => window.location.hash)
  const taggedRow = page.locator('[data-ui="chat-row"]').filter({
    has: page.locator('[data-ui="chat-row-title"]', { hasText: 'Zulu pinned Focus chat' }),
  })
  await taggedRow.locator('[data-ui="chat-row-tag"]', { hasText: 'Focus' }).click()
  expect(await page.evaluate(() => window.location.hash)).toBe(initialHash)
  await expect(list).toHaveAttribute('data-search-mode', 'true')
  await expect(list).toHaveAttribute('data-total-count', '231')

  const folderHeading = page
    .locator('[data-ui="sidebar-search-filter-heading"]')
    .filter({ hasText: 'Folders' })
  await folderHeading.click()
  const focusFolderFilter = page
    .locator('[data-ui="sidebar-search-filter-group"]')
    .filter({ hasText: 'Folders' })
    .locator('[data-ui="sidebar-search-chip-row"] button')
    .filter({ hasText: 'Focus Folder' })
  await focusFolderFilter.click()
  await expect(focusFolderFilter).toHaveAttribute('data-filter-state', 'include')
  await expect(list).toHaveAttribute('data-total-count', '230')

  await page.locator('[data-ui="sidebar-search-input"]').fill('folder:"Focus Folder" Focus chat')
  await page
    .locator('[data-ui="sidebar-search-filter-toggles"] label')
    .filter({ hasText: 'Title' })
    .locator('input')
    .check()
  await expect(list).toHaveAttribute('data-total-count', '230')
  await page.locator('[data-ui="sidebar-sort-button"]').click()
  await page.getByRole('menuitemradio', { name: 'Title A-Z' }).click()
  await expect(list).toHaveAttribute('data-sort-key', 'title-asc')
  await expect(list).toHaveAttribute('data-virtualized', 'true')
  await expect(page.locator('[data-ui="chat-row-title"]').first()).toHaveText(
    'Zulu pinned Focus chat',
  )
  expect(await page.locator('[data-ui="chat-row"]').count()).toBeLessThan(60)

  await list.evaluate((node) => node.scrollTo({ top: node.scrollHeight * 0.55 }))
  await expect.poll(async () => (await sidebarAnchor(page)).scrollTop).toBeGreaterThan(1_000)
  const anchor = await sidebarAnchor(page)
  expect(anchor.key).not.toBe('')
  await startSidebarContinuityRecorder(page)

  const peer = await context.newPage()
  try {
    await peer.goto('/')
    await setSidebarChatTags(peer, 'A Focus chat outside', 'Focus')
    await expect(list).toHaveAttribute('data-total-count', '231')
    await expectSidebarAnchor(page, anchor)

    await archiveSidebarChat(peer, 'Focus chat 000')
    await expect(list).toHaveAttribute('data-total-count', '230')
    await expectSidebarAnchor(page, anchor)
  } finally {
    await peer.close()
  }
  expect(await stopSidebarContinuityRecorder(page)).toEqual({ emptySeen: false, statusSeen: false })

  await page
    .locator('[data-ui="sidebar-search-filter-toggles"] label')
    .filter({ hasText: 'Archive' })
    .locator('input')
    .check()
  await expect(list).toHaveAttribute('data-total-count', '232')
  await list.evaluate((node) => node.scrollTo({ top: 0 }))
  await expect.poll(async () => (await sidebarAnchor(page)).scrollTop).toBe(0)
  await expect
    .poll(async () =>
      (await page.locator('[data-ui="chat-row-title"]').allTextContents()).slice(0, 4),
    )
    .toEqual([
      'Zulu pinned Focus chat',
      'A Focus chat outside',
      'Archived Focus chat',
      'Focus chat 000',
    ])
})

interface SidebarAnchorSnapshot {
  key: string
  top: number
  scrollTop: number
}

async function sidebarAnchor(page: Page): Promise<SidebarAnchorSnapshot> {
  return page.locator('[data-ui="chat-list"]').evaluate((node) => {
    const root = node as HTMLElement
    const rootRect = root.getBoundingClientRect()
    const visible = Array.from(root.querySelectorAll<HTMLElement>('[data-sidebar-row-key]')).find(
      (row) => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > rootRect.top && rect.top < rootRect.bottom
      },
    )
    return {
      key: visible?.dataset.sidebarRowKey ?? '',
      top: visible ? visible.getBoundingClientRect().top - rootRect.top : 0,
      scrollTop: root.scrollTop,
    }
  })
}

async function expectSidebarAnchor(page: Page, expected: SidebarAnchorSnapshot): Promise<void> {
  await expect.poll(async () => (await sidebarAnchor(page)).key).toBe(expected.key)
  const current = await sidebarAnchor(page)
  expect(Math.abs(current.top - expected.top)).toBeLessThan(8)
  expect(current.scrollTop).toBeGreaterThan(1_000)
}

async function startSidebarContinuityRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-ui="chat-list"]')
    if (!list) throw new Error('Sidebar list missing')
    const state = { emptySeen: false, statusSeen: false }
    const sample = () => {
      if (list.querySelectorAll('[data-ui="chat-row"]').length === 0) state.emptySeen = true
      const text = list.textContent
      if (text.includes('Searching...') || text.includes('No matches')) state.statusSeen = true
    }
    const observer = new MutationObserver(sample)
    observer.observe(list, { childList: true, characterData: true, subtree: true })
    sample()
    ;(
      window as typeof window & {
        __sidebarContinuity?: { observer: MutationObserver; state: typeof state }
      }
    ).__sidebarContinuity = { observer, state }
  })
}

async function stopSidebarContinuityRecorder(
  page: Page,
): Promise<{ emptySeen: boolean; statusSeen: boolean }> {
  return page.evaluate(() => {
    const owner = window as typeof window & {
      __sidebarContinuity?: {
        observer: MutationObserver
        state: { emptySeen: boolean; statusSeen: boolean }
      }
    }
    const record = owner.__sidebarContinuity
    if (!record) throw new Error('Sidebar continuity recorder missing')
    record.observer.disconnect()
    delete owner.__sidebarContinuity
    return record.state
  })
}

async function findSidebarChat(page: Page, title: string) {
  await page.locator('[data-ui="sidebar-search-input"]').fill(`"${title}"`)
  const row = page
    .locator('[data-ui="chat-row"]')
    .filter({ has: page.locator('[data-ui="chat-row-title"]', { hasText: title }) })
  await expect(row).toHaveCount(1)
  await expect(row).toHaveAttribute('data-interactive', 'true')
  return row
}

async function setSidebarChatTags(page: Page, title: string, tags: string): Promise<void> {
  const row = await findSidebarChat(page, title)
  await row.hover()
  await row.locator('[data-ui="chat-row-menu-button"]').click()
  page.once('dialog', (dialog) => dialog.accept(tags))
  await page.locator('[data-ui="chat-row-tags-button"]').click()
  await expect(row.locator('[data-ui="chat-row-tag"]', { hasText: tags })).toBeVisible()
}

async function archiveSidebarChat(page: Page, title: string): Promise<void> {
  const row = await findSidebarChat(page, title)
  await row.hover()
  await row.locator('[data-ui="chat-row-menu-button"]').click()
  await page.locator('[data-ui="chat-row-delete"]').click()
  await expect(row).toHaveCount(0)
}

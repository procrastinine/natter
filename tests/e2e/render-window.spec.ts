import type { Message } from '../../src/core/types'
import { splitMessageForStorage } from '../../src/store/message-storage'
import { expect, type Locator, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  rebuildSidebarProjection,
  seedFirstRun,
  seedLinearChat,
  sendMessage,
  startMessageCountRecorder,
  stopMessageCountRecorder,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('global settings exposes render-window controls on the Performance tab', async ({ page }) => {
  await page.locator('[data-ui="open-global-settings"]').click()
  await page.getByRole('tab', { name: 'Performance' }).click()

  await expect(page.locator('[data-ui="message-render-window-load-mode"]')).toHaveValue('auto')
  await expect(page.locator('[data-ui="sidebar-render-window-load-mode"]')).toHaveValue('auto')
  await expect(page.getByLabel('Newest messages')).toHaveValue('10')
  await expect(page.getByLabel('First rows')).toHaveValue('50')
})

test('opening Appearance settings does not reapply the default chat width', async ({ page }) => {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['settings'], 'readwrite')
        tx.objectStore('settings').put({ key: 'global:chat-max-width', value: 1280 })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  })
  await page.reload()
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue('--message-max-width') === '1280px',
  )
  await page.evaluate(() => {
    const w = window as typeof window & {
      __chatWidthMutations?: string[]
      __chatWidthObserver?: MutationObserver
    }
    w.__chatWidthMutations = []
    w.__chatWidthObserver?.disconnect()
    w.__chatWidthObserver = new MutationObserver(() => {
      w.__chatWidthMutations?.push(
        document.documentElement.style.getPropertyValue('--message-max-width'),
      )
    })
    w.__chatWidthObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style'],
    })
  })

  await page.locator('[data-ui="open-global-settings"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="appearance"]').click()

  await expect(page.locator('[data-ui="chat-max-width-slider"]')).toHaveValue('1280')
  await page.waitForTimeout(100)
  const mutations = await page.evaluate(() => {
    const w = window as typeof window & {
      __chatWidthMutations?: string[]
      __chatWidthObserver?: MutationObserver
    }
    w.__chatWidthObserver?.disconnect()
    return w.__chatWidthMutations ?? []
  })
  expect(mutations).not.toContain('920px')
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue('--message-max-width')),
    )
    .toBe('1280px')
})

test('send and regenerate keep the transcript mounted while the branch window reloads', async ({
  page,
}) => {
  let requestCount = 0
  let releaseRegenerate: () => void = () => undefined
  const regenerateGate = new Promise<void>((resolve) => {
    releaseRegenerate = resolve
  })
  let markRegenerateRequested: () => void = () => undefined
  const regenerateRequested = new Promise<void>((resolve) => {
    markRegenerateRequested = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    requestCount += 1
    if (requestCount === 2) {
      markRegenerateRequested()
      await regenerateGate
    } else {
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    const text = requestCount === 1 ? 'sent answer' : 'regenerated answer'
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: `render-window-${requestCount}`, content: text },
        { finish: 'stop' },
      ]),
    })
  })
  const chatId = await seedLinearChat(page, {
    messageCount: 24,
    chatId: 'render-window-chat',
    title: 'Render window chat',
    textPrefix: 'window message',
    settings: {
      'global:message-render-window-size': 10,
      'global:message-render-window-load-mode': 'manual',
    },
  })

  await page.goto(`/#/chat/${chatId}`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(10)

  await startMessageCountRecorder(page)
  await sendMessage(page, 'new prompt')
  await expect(
    page.locator('[data-ui="message"]').last().locator('[data-ui="message-body"]'),
  ).toContainText('sent answer')
  expect(await stopMessageCountRecorder(page)).toEqual({
    anchorRemoved: false,
    listRemoved: false,
    listReplaced: false,
    loadingSeen: false,
    messageCountsIncludeZero: false,
  })

  const previousAssistantId = await page
    .locator('[data-ui="message"][data-role="assistant"]')
    .last()
    .getAttribute('data-message-id')
  if (!previousAssistantId) throw new Error('Regenerate target has no message id')
  await startMessageCountRecorder(page)
  await page.evaluate(() => {
    const win = window as typeof window & {
      __tailAssistantSamples?: string[]
      __tailAssistantObserver?: MutationObserver
    }
    const sample = () => {
      const rows = document.querySelectorAll(
        '[data-ui="message"][data-role="assistant"][data-message-id]',
      )
      const id =
        rows.length === 0 ? null : rows.item(rows.length - 1).getAttribute('data-message-id')
      if (id) win.__tailAssistantSamples?.push(id)
    }
    win.__tailAssistantSamples = []
    win.__tailAssistantObserver = new MutationObserver(sample)
    win.__tailAssistantObserver.observe(document.body, { childList: true, subtree: true })
    sample()
  })
  await page
    .locator('[data-ui="message"][data-role="assistant"]')
    .last()
    .locator('[data-action="regenerate"]')
    .click()
  let regeneratedId: string
  try {
    await regenerateRequested
    const regeneratedMessage = page.locator('[data-ui="message"][data-role="assistant"]').last()
    await expect
      .poll(() => regeneratedMessage.getAttribute('data-message-id'))
      .not.toBe(previousAssistantId)
    const activeRegeneratedId = await regeneratedMessage.getAttribute('data-message-id')
    if (!activeRegeneratedId) throw new Error('Regenerate stream has no target message')
    regeneratedId = activeRegeneratedId
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${regeneratedId}"]`),
    ).toBeVisible()
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${previousAssistantId}"]`),
    ).toHaveCount(0)
    await expect(
      page.locator(
        `[data-ui="message"][data-message-id="${regeneratedId}"] [data-ui="branch-count"]`,
      ),
    ).toHaveText('2 / 2')
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toBe(`#/chat/${chatId}/message/${regeneratedId}`)
    await expect(page.locator('[data-ui="surface-loading"]')).toHaveCount(0)
    await expect(page.locator('[data-ui="message-list"]')).not.toHaveAttribute('inert')
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )
    const tailSamples = await page.evaluate(() => {
      const win = window as typeof window & { __tailAssistantSamples?: string[] }
      return win.__tailAssistantSamples ?? []
    })
    const firstRegenerated = tailSamples.indexOf(regeneratedId)
    expect(firstRegenerated).toBeGreaterThanOrEqual(0)
    expect(tailSamples.slice(firstRegenerated)).not.toContain(previousAssistantId)
  } finally {
    releaseRegenerate()
  }
  await expect(
    page.locator(
      `[data-ui="message"][data-message-id="${regeneratedId}"] [data-ui="message-body"]`,
    ),
  ).toContainText('regenerated answer')
  await expect(
    page.locator(
      `[data-ui="message"][data-message-id="${regeneratedId}"] [data-ui="branch-count"]`,
    ),
  ).toHaveText('2 / 2')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/chat/${chatId}/message/${regeneratedId}`)
  const tailSamples = await page.evaluate(() => {
    const win = window as typeof window & {
      __tailAssistantSamples?: string[]
      __tailAssistantObserver?: MutationObserver
    }
    win.__tailAssistantObserver?.disconnect()
    return win.__tailAssistantSamples ?? []
  })
  const firstRegenerated = tailSamples.indexOf(regeneratedId)
  expect(firstRegenerated).toBeGreaterThanOrEqual(0)
  expect(tailSamples.slice(firstRegenerated)).not.toContain(previousAssistantId)
  expect(await stopMessageCountRecorder(page)).toEqual({
    anchorRemoved: false,
    listRemoved: false,
    listReplaced: false,
    loadingSeen: false,
    messageCountsIncludeZero: false,
  })
})

test('switching message variants re-renders the selected branch window', async ({ page }) => {
  const chatId = await seedBranchedChat(page)
  await rebuildSidebarProjection(page)

  await page.goto(`/#/chat/${chatId}/message/A2`)
  await page.reload()
  await expect(page.locator('[data-ui="message"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="message"]').nth(1)).toContainText('branch A user')
  await expect(page.locator('[data-ui="message"]').nth(2)).toContainText('branch A assistant')

  await page
    .locator('[data-ui="message"]')
    .filter({ hasText: 'branch A user' })
    .getByLabel('Next variant')
    .click()

  await expect(page.locator('[data-ui="message"]')).toHaveCount(3)
  await expect(page.locator('[data-ui="message"]').nth(1)).toContainText('branch B user')
  await expect(page.locator('[data-ui="message"]').nth(2)).toContainText('branch B assistant')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-rendered-count', '3')
  await expect(page.locator('[data-ui="message-list"]')).toHaveAttribute('data-total-count', '3')
})

test('cached leaves share one live sibling count revision', async ({ context, page }) => {
  const chatId = await seedBranchedChat(page)
  await rebuildSidebarProjection(page)
  await page.goto(`/#/chat/${chatId}/message/A2`)
  await expect(page.locator('[data-ui="message"]').last()).toContainText('branch A assistant')

  await page
    .locator('[data-ui="message"]')
    .filter({ hasText: 'branch A user' })
    .getByLabel('Next variant')
    .click()
  await expect(page.locator('[data-ui="message"]').last()).toContainText('branch B assistant')

  const otherTab = await context.newPage()
  try {
    let markRequestSeen: () => void = () => undefined
    const requestSeen = new Promise<void>((resolve) => {
      markRequestSeen = resolve
    })
    await otherTab.route('**/api/v1/chat/completions', async (route) => {
      markRequestSeen()
      await route.fulfill({
        contentType: 'text/event-stream',
        body: buildSseBody([
          { id: 'remote-branch', content: 'branch C assistant' },
          { finish: 'stop' },
        ]),
      })
    })
    await otherTab.goto(`/#/chat/${chatId}/message/B2`)
    const branchBUser = otherTab
      .locator('[data-ui="message"][data-role="user"]')
      .filter({ hasText: 'branch B user' })
    await branchBUser.locator('[data-action="edit"]').click()
    const editor = otherTab.locator('[data-ui="inline-editor"]')
    await editor.locator('[data-ui="inline-editor-input"]').fill('branch C user')
    await editor.locator('[data-role="save-send"]').click()
    await requestSeen
    await expect(
      otherTab
        .locator('[data-ui="message"][data-role="assistant"]')
        .filter({ hasText: 'branch C assistant' }),
    ).toBeVisible()
    await expect(otherTab.locator('[data-ui="abort"]')).toHaveCount(0)
  } finally {
    await otherTab.close()
  }

  const branchB = page.locator('[data-ui="message"]').filter({ hasText: 'branch B user' })
  await expect(branchB.locator('[data-ui="branch-count"]')).toHaveText('2 / 3')
  await page.evaluate(() => {
    const win = window as typeof window & {
      __branchCountSamples?: string[]
      __branchCountObserver?: MutationObserver
    }
    const sample = () => {
      const text = document.querySelector('[data-ui="branch-count"]')?.textContent.trim()
      if (text) win.__branchCountSamples?.push(text)
    }
    win.__branchCountSamples = []
    win.__branchCountObserver = new MutationObserver(sample)
    win.__branchCountObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    sample()
  })

  await branchB.getByLabel('First variant').click()
  const branchA = page.locator('[data-ui="message"]').filter({ hasText: 'branch A user' })
  await expect(branchA.locator('[data-ui="branch-count"]')).toHaveText('1 / 3')
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await expect(branchA.locator('[data-ui="branch-count"]')).toHaveText('1 / 3')
  const samples = await page.evaluate(() => {
    const win = window as typeof window & {
      __branchCountSamples?: string[]
      __branchCountObserver?: MutationObserver
    }
    win.__branchCountObserver?.disconnect()
    return win.__branchCountSamples ?? []
  })
  expect(samples).not.toContain('1 / 2')
})

test('sidebar mounts only the first row window and loads more rows manually', async ({ page }) => {
  await seedSidebarChats(page, {
    chatCount: 65,
    settings: {
      'global:sidebar-render-window-size': 50,
      'global:sidebar-render-window-load-mode': 'manual',
    },
  })
  await rebuildSidebarProjection(page)
  await page.goto('/')
  await page.reload()

  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(50)
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-total-count', '65')
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-rendered-count', '50')

  await page.locator('[data-ui="load-more-sidebar"]').click()
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(65)
  await expect(page.locator('[data-ui="load-more-sidebar"]')).toHaveCount(0)
})

test('sidebar keeps scroll position when auto-load crosses virtualization threshold', async ({
  page,
}) => {
  await seedSidebarChats(page, {
    chatCount: 230,
    settings: {
      'global:sidebar-render-window-size': 75,
      'global:sidebar-render-window-load-mode': 'auto',
    },
  })
  await rebuildSidebarProjection(page)
  await page.goto('/')
  await page.reload()

  const list = page.locator('[data-ui="chat-list"]')
  await expect(list).not.toHaveAttribute('data-virtualized', 'true')
  await scrollSidebarToAutoLoadedVirtualRows(page)

  const metrics = await list.evaluate((node) => ({
    renderedCount: Number(node.dataset.renderedCount ?? 0),
    scrollTop: node.scrollTop,
  }))
  expect(metrics.renderedCount).toBeGreaterThan(200)
  expect(metrics.scrollTop).toBeGreaterThan(500)
})

test('virtualized sidebar bottom tracks mixed folder and tag row heights', async ({ page }) => {
  await seedMixedHeightSidebarRows(page)
  await rebuildSidebarProjection(page)
  await page.goto('/')
  await page.reload()

  const list = page.locator('[data-ui="chat-list"]')
  await expect(list).toHaveAttribute('data-virtualized', 'true')
  await expect(page.locator('[data-ui="chat-row-tag"]').first()).toBeVisible()

  await assertSidebarBottomHasNoBlankTail(page, 'expanded folder')

  await scrollSidebarUntilText(page, 'Height check folder')
  const folderButton = page
    .locator('[data-ui="folder-section"]')
    .filter({ hasText: 'Height check folder' })
    .locator('[data-ui="folder-main"]')
  await expect(folderButton).toHaveAttribute('aria-expanded', 'true')
  await folderButton.click()
  await expect(folderButton).toHaveAttribute('aria-expanded', 'false')
  await assertSidebarBottomHasNoBlankTail(page, 'collapsed folder')

  await scrollSidebarUntilText(page, 'Height check folder')
  await folderButton.click()
  await expect(folderButton).toHaveAttribute('aria-expanded', 'true')
  await assertSidebarBottomHasNoBlankTail(page, 're-expanded folder')
})

test('sidebar keeps a loaded row anchored when folders toggle and tag rows grow', async ({
  page,
}) => {
  await seedSidebarScrollMutationFixture(page)
  await rebuildSidebarProjection(page)
  await page.goto('/')
  await page.reload()

  await page.locator('[data-ui="load-more-sidebar"]').click()
  await page.locator('[data-ui="load-more-sidebar"]').click()
  await page.locator('[data-ui="load-more-sidebar"]').click()
  await expect(page.locator('[data-ui="chat-list"]')).toHaveAttribute('data-virtualized', 'true')
  await scrollSidebarUntilText(page, 'Far folder')

  const farFolder = page.locator('[data-ui="folder-section"]').filter({ hasText: 'Far folder' })
  const farFolderButton = farFolder.locator('[data-ui="folder-main"]')
  await expect(farFolderButton).toBeVisible()
  await alignSidebarRowNearTop(farFolder)

  const beforeExpand = await sidebarRowMetrics(farFolder)
  await farFolderButton.click()
  await expect(farFolderButton).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(80)
  const afterExpand = await sidebarRowMetrics(farFolder)
  expect(afterExpand.renderedCount).toBeGreaterThan(200)
  expect(afterExpand.scrollTop).toBeGreaterThan(1000)
  expect(Math.abs(afterExpand.top - beforeExpand.top)).toBeLessThan(6)

  await farFolderButton.click()
  await expect(farFolderButton).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(80)
  const afterCollapse = await sidebarRowMetrics(farFolder)
  expect(afterCollapse.renderedCount).toBeGreaterThan(200)
  expect(afterCollapse.scrollTop).toBeGreaterThan(1000)
  expect(Math.abs(afterCollapse.top - beforeExpand.top)).toBeLessThan(6)

  const tagTarget = page.locator('[data-ui="chat-row"]').filter({ hasText: 'Tag target chat' })
  await scrollSidebarUntilText(page, 'Tag target chat')
  await expect(tagTarget).toBeVisible()
  await alignSidebarRowNearTop(tagTarget)
  const beforeTags = await sidebarRowMetrics(tagTarget)

  page.once('dialog', (dialog) => dialog.accept('Alpha, Beta, Gamma'))
  await tagTarget.hover()
  await tagTarget.locator('[data-ui="chat-row-menu-button"]').click()
  await page.locator('[data-ui="chat-row-tags-button"]').click()
  await expect(tagTarget.locator('[data-ui="chat-row-tag"]')).toHaveCount(3)
  await page.waitForTimeout(80)

  const afterTags = await sidebarRowMetrics(tagTarget)
  expect(afterTags.renderedCount).toBeGreaterThan(200)
  expect(afterTags.scrollTop).toBeGreaterThan(1000)
  expect(Math.abs(afterTags.top - beforeTags.top)).toBeLessThan(6)
})

async function assertSidebarBottomHasNoBlankTail(page: Page, label: string): Promise<void> {
  const list = page.locator('[data-ui="chat-list"]')
  await settleSidebarMeasurementsToBottom(list)
  const metrics = await list.evaluate((node) => {
    const listRect = node.getBoundingClientRect()
    const visibleRows = Array.from(
      node.querySelectorAll<HTMLElement>('[data-sidebar-row-key]'),
    ).filter((row) => {
      const rowRect = row.getBoundingClientRect()
      return rowRect.bottom > listRect.top && rowRect.top < listRect.bottom
    })
    const lastVisibleBottom = visibleRows.reduce((bottom, row) => {
      const rowBottom = row.getBoundingClientRect().bottom
      return Math.max(bottom, rowBottom)
    }, listRect.top)
    return {
      blankTail: listRect.bottom - lastVisibleBottom,
      maxScrollTop: Math.max(0, node.scrollHeight - node.clientHeight),
      scrollTop: node.scrollTop,
      visibleRows: visibleRows.length,
    }
  })
  expect(metrics.visibleRows, label).toBeGreaterThan(0)
  expect(metrics.scrollTop, label).toBeGreaterThanOrEqual(metrics.maxScrollTop - 1)
  expect(metrics.blankTail, label).toBeLessThan(12)
}

async function scrollSidebarToAutoLoadedVirtualRows(page: Page): Promise<void> {
  const list = page.locator('[data-ui="chat-list"]')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await list.evaluate((node) => {
      node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
    })
    await page.waitForTimeout(120)
    if ((await list.getAttribute('data-virtualized')) === 'true') return
  }
  throw new Error('Sidebar did not auto-load into virtualized mode')
}

async function alignSidebarRowNearTop(row: Locator): Promise<void> {
  await row.evaluate((node) => {
    const list = node.closest('[data-ui="chat-list"]')
    if (!list) return
    const rowRect = node.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    list.scrollTop += rowRect.top - listRect.top - 72
  })
}

async function scrollSidebarUntilText(page: Page, text: string): Promise<void> {
  const list = page.locator('[data-ui="chat-list"]')
  const matchingRows = page.locator('[data-sidebar-row-key]').filter({ hasText: text })
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await matchingRows.count()) > 0) return
    await list.evaluate((node, attemptIndex) => {
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
      node.scrollTop = Math.min(maxScrollTop, attemptIndex * 520)
    }, attempt)
    await page.waitForTimeout(40)
  }
  throw new Error(`Could not render sidebar row containing ${text}`)
}

async function settleSidebarMeasurementsToBottom(list: Locator): Promise<void> {
  await list.evaluate(async (node) => {
    let target = 0
    for (let step = 0; step < 120; step += 1) {
      const maxScrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
      node.scrollTop = Math.min(maxScrollTop, target)
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      if (target >= maxScrollTop) break
      target += Math.max(180, node.clientHeight * 0.75)
    }
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
}

async function sidebarRowMetrics(row: Locator): Promise<{
  top: number
  scrollTop: number
  renderedCount: number
}> {
  return row.evaluate((node) => {
    const list = node.closest('[data-ui="chat-list"]')
    if (!(list instanceof HTMLElement)) throw new Error('Sidebar list not found')
    const rowRect = node.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    return {
      top: rowRect.top - listRect.top,
      scrollTop: list.scrollTop,
      renderedCount: Number(list.dataset.renderedCount ?? 0),
    }
  })
}

async function seedBranchedChat(page: Page): Promise<string> {
  const now = Date.now()
  const chatId = 'render-window-branch-chat'
  const sourceMessages: Message[] = [
    {
      id: 'root',
      chatId,
      parentId: null,
      siblingIndex: 0,
      turnId: 'turn-root',
      turnIndex: 0,
      createdAt: now,
      role: 'system',
      origin: 'imported',
      content: [{ type: 'text', text: 'root instruction' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: 'A1',
      chatId,
      parentId: 'root',
      siblingIndex: 0,
      turnId: 'turn-A1',
      turnIndex: 1,
      createdAt: now + 1,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'branch A user' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: 'A2',
      chatId,
      parentId: 'A1',
      siblingIndex: 0,
      turnId: 'turn-A2',
      turnIndex: 2,
      createdAt: now + 2,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'branch A assistant' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: 'B1',
      chatId,
      parentId: 'root',
      siblingIndex: 1,
      turnId: 'turn-B1',
      turnIndex: 1,
      createdAt: now + 3,
      role: 'user',
      origin: 'user',
      content: [{ type: 'text', text: 'branch B user' }],
      nodeVersion: 0,
      deleted: false,
    },
    {
      id: 'B2',
      chatId,
      parentId: 'B1',
      siblingIndex: 0,
      turnId: 'turn-B2',
      turnIndex: 2,
      createdAt: now + 4,
      role: 'assistant',
      origin: 'generated',
      content: [{ type: 'output_text', text: 'branch B assistant' }],
      nodeVersion: 0,
      deleted: false,
    },
  ]
  const storedRows = sourceMessages.map((message) => splitMessageForStorage(message))
  const wordCount = storedRows.reduce((total, stored) => total + stored.header.bodyWordCount, 0)

  await page.evaluate(
    async (seed) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('natter')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            ['presets', 'settings', 'chats', 'messages', 'messageBodies'],
            'readwrite',
          )
          const presets = tx.objectStore('presets')
          const settingsStore = tx.objectStore('settings')
          const chats = tx.objectStore('chats')
          const messages = tx.objectStore('messages')
          const messageBodies = tx.objectStore('messageBodies')
          const presetsReq = presets.getAll()
          presetsReq.onsuccess = () => {
            const preset = (presetsReq.result as Array<{ id?: string; settings?: unknown }>)[0]
            const chatSettings = structuredClone(preset?.settings ?? {})
            settingsStore.put({ key: 'global:message-render-window-size', value: 3 })
            settingsStore.put({ key: 'global:message-render-window-load-mode', value: 'manual' })
            chats.put({
              id: seed.chatId,
              title: 'Render branch window chat',
              titleStatus: 'manual',
              createdAt: seed.now,
              updatedAt: seed.now + 4,
              lastViewedAt: seed.now + 4,
              wordCount: seed.wordCount,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: chatSettings,
              presetId: preset?.id,
              lastUpdatedLeafId: 'B2',
              lastBranchUpdatedAt: seed.now + 4,
              archived: false,
              pinned: false,
              folderId: null,
              tags: [],
              previewText: 'branch A user',
            })
            for (const stored of seed.storedRows) {
              messages.put(stored.header)
              messageBodies.put(stored.body)
            }
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    },
    { chatId, now, storedRows, wordCount },
  )
  return chatId
}

async function seedSidebarChats(
  page: Page,
  input: {
    chatCount: number
    settings?: Record<string, unknown>
  },
): Promise<void> {
  await page.evaluate(async ({ chatCount, settings }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const now = Date.now()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['presets', 'settings', 'chats'], 'readwrite')
        const presets = tx.objectStore('presets')
        const settingsStore = tx.objectStore('settings')
        const chats = tx.objectStore('chats')
        const presetsReq = presets.getAll()
        presetsReq.onsuccess = () => {
          const preset = (presetsReq.result as Array<{ id?: string; settings?: unknown }>)[0]
          const chatSettings = structuredClone(preset?.settings ?? {})
          for (const [key, value] of Object.entries(settings ?? {})) {
            settingsStore.put({ key, value })
          }
          for (let i = 0; i < chatCount; i += 1) {
            chats.put({
              id: `sidebar-window-chat-${String(i).padStart(3, '0')}`,
              title: `Sidebar window chat ${String(i).padStart(2, '0')}`,
              titleStatus: 'manual',
              createdAt: now - i,
              updatedAt: now - i,
              lastViewedAt: now - i,
              wordCount: 10,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: chatSettings,
              presetId: preset?.id,
              lastUpdatedLeafId: null,
              lastBranchUpdatedAt: now - i,
              archived: false,
              pinned: false,
              folderId: null,
              tags: [],
              previewText: `sidebar preview ${i}`,
            })
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }, input)
}

async function seedMixedHeightSidebarRows(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const now = Date.now()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['presets', 'settings', 'folders', 'tags', 'chats'], 'readwrite')
        const presets = tx.objectStore('presets')
        const settingsStore = tx.objectStore('settings')
        const folders = tx.objectStore('folders')
        const tags = tx.objectStore('tags')
        const chats = tx.objectStore('chats')
        const presetsReq = presets.getAll()
        presetsReq.onsuccess = () => {
          const preset = (presetsReq.result as Array<{ id?: string; settings?: unknown }>)[0]
          const chatSettings = structuredClone(preset?.settings ?? {})
          settingsStore.put({ key: 'global:sidebar-render-window-size', value: 320 })
          settingsStore.put({ key: 'global:sidebar-render-window-load-mode', value: 'manual' })
          folders.put({
            id: 'height-check-folder',
            name: 'Height check folder',
            sortIndex: 0,
            createdAt: now - 100,
            updatedAt: now - 100,
            lastUsedAt: now - 100,
          })
          const tagRows = [
            { id: 'height-tag-alpha', name: 'Alpha' },
            { id: 'height-tag-beta', name: 'Beta' },
            { id: 'height-tag-gamma', name: 'Gamma' },
            { id: 'height-tag-delta', name: 'Delta' },
          ]
          for (const [index, tag] of tagRows.entries()) {
            tags.put({
              id: tag.id,
              name: tag.name,
              nameLower: tag.name.toLowerCase(),
              createdAt: now + index,
              updatedAt: now + index,
              lastUsedAt: now + index,
            })
          }
          const tagIds = tagRows.map((tag) => tag.id)
          for (let i = 0; i < 210; i += 1) {
            chats.put({
              id: `mixed-height-root-chat-${String(i).padStart(3, '0')}`,
              title: `Mixed height root ${String(i).padStart(3, '0')}`,
              titleStatus: 'manual',
              createdAt: now - i,
              updatedAt: now - i,
              lastViewedAt: now - i,
              wordCount: 10,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: structuredClone(chatSettings),
              presetId: preset?.id,
              lastUpdatedLeafId: null,
              lastBranchUpdatedAt: now - i,
              archived: false,
              pinned: false,
              folderId: null,
              tags: i % 4 === 0 ? tagIds : i % 5 === 0 ? [tagIds[0]] : [],
              previewText: `mixed root preview ${i}`,
            })
          }
          for (let i = 0; i < 40; i += 1) {
            chats.put({
              id: `mixed-height-folder-chat-${String(i).padStart(3, '0')}`,
              title: `Mixed height folder ${String(i).padStart(3, '0')}`,
              titleStatus: 'manual',
              createdAt: now - 90 - i,
              updatedAt: now - 90 - i,
              lastViewedAt: now - 90 - i,
              wordCount: 10,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: structuredClone(chatSettings),
              presetId: preset?.id,
              lastUpdatedLeafId: null,
              lastBranchUpdatedAt: now - 90 - i,
              archived: false,
              pinned: false,
              folderId: 'height-check-folder',
              tags: i % 3 === 0 ? tagIds.slice(0, 3) : [],
              previewText: `mixed folder preview ${i}`,
            })
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  })
}

async function seedSidebarScrollMutationFixture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('natter')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const now = Date.now()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['presets', 'settings', 'folders', 'chats'], 'readwrite')
        const presets = tx.objectStore('presets')
        const settingsStore = tx.objectStore('settings')
        const folders = tx.objectStore('folders')
        const chats = tx.objectStore('chats')
        const presetsReq = presets.getAll()
        presetsReq.onsuccess = () => {
          const preset = (presetsReq.result as Array<{ id?: string; settings?: unknown }>)[0]
          const chatSettings = structuredClone(preset?.settings ?? {})
          settingsStore.put({ key: 'global:sidebar-render-window-size', value: 75 })
          settingsStore.put({ key: 'global:sidebar-render-window-load-mode', value: 'manual' })
          settingsStore.put({ key: 'sidebar:collapsed-folders', value: ['far-folder'] })
          folders.put({
            id: 'far-folder',
            name: 'Far folder',
            sortIndex: 0,
            createdAt: now + 795,
            updatedAt: now + 795,
            lastUsedAt: now + 795,
          })
          for (let i = 0; i < 230; i += 1) {
            chats.put({
              id: `sidebar-scroll-chat-${String(i).padStart(3, '0')}`,
              title: i === 210 ? 'Tag target chat' : `Sidebar scroll chat ${String(i)}`,
              titleStatus: 'manual',
              createdAt: now + 1000 - i,
              updatedAt: now + 1000 - i,
              lastViewedAt: now + 1000 - i,
              wordCount: 10,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: structuredClone(chatSettings),
              presetId: preset?.id,
              lastUpdatedLeafId: null,
              lastBranchUpdatedAt: now + 1000 - i,
              archived: false,
              pinned: false,
              folderId: null,
              tags: [],
              previewText: `sidebar scroll preview ${i}`,
            })
          }
          for (let i = 0; i < 6; i += 1) {
            chats.put({
              id: `far-folder-chat-${i}`,
              title: `Far folder chat ${i}`,
              titleStatus: 'manual',
              createdAt: now + 795 - i,
              updatedAt: now + 795 - i,
              lastViewedAt: now + 795 - i,
              wordCount: 10,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: structuredClone(chatSettings),
              presetId: preset?.id,
              lastUpdatedLeafId: null,
              lastBranchUpdatedAt: now + 795 - i,
              archived: false,
              pinned: false,
              folderId: 'far-folder',
              tags: [],
              previewText: `far folder preview ${i}`,
            })
          }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  })
}

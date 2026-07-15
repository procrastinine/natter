import type { Message } from '../../src/core/types'
import {
  previewTextFromStoredProjection,
  splitMessageForStorage,
} from '../../src/store/message-storage'
import { expect, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  readMessages,
  rebuildSidebarProjection,
  seedFirstRun,
  sendMessage,
} from './helpers'

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('middle-click opens the newest descendant branch in a background tab', async ({
  context,
  page,
}) => {
  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/A2`)
  await page.locator('[data-role="chat-branch-tree"]').click()

  const popupPromise = context.waitForEvent('page')
  await page.locator('[data-ui="branch-tree-node"][data-message-id="root"]').click({
    button: 'middle',
  })
  const popup = await popupPromise

  await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/message/A2')
  await expect(popup).toHaveURL(/\/message\/B2/)
  await expect(popup.locator('[data-ui="message-list"]')).toContainText('branch B assistant')
  await expect(popup.locator('[data-ui="message-list"]')).not.toContainText('branch A assistant')
})

test('tree view replaces the transcript, searches all branches, and changes the active branch', async ({
  page,
}) => {
  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/B2`)
  await expect(page.locator('[data-ui="message-list"]')).toContainText('branch B assistant')

  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
  await expect(page.locator('[data-ui="message-list"]')).not.toBeVisible()
  await expect(page.locator('[data-ui="composer"]')).not.toBeVisible()
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(5)
  await expect(page.locator('[data-ui="tree-density-toggle"]')).toBeVisible()
  await expect(page.locator('[data-ui="focus-mode-toggle"]')).toHaveCount(0)
  await expect(page.locator('[data-ui="branch-tree-node-icon"][data-role="user"]')).toHaveCount(2)
  await expect(
    page.locator('[data-ui="branch-tree-node-icon"][data-role="assistant"]'),
  ).toHaveCount(2)

  const densityToggle = page.locator('[data-ui="tree-density-toggle"]')
  const geometryNode = page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]')
  const compactBefore = await geometryNode.boundingBox()
  await densityToggle.click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).toHaveAttribute(
    'data-expanded',
    'true',
  )
  const expandedBox = await geometryNode.boundingBox()
  expect(expandedBox?.width ?? 0).toBeGreaterThan((compactBefore?.width ?? 0) * 4)
  await expect(geometryNode.locator('[data-ui="branch-tree-node-preview"]')).toContainText(
    'branch A',
  )
  const expandedLineWidths = await page
    .locator('[data-ui="branch-tree-node-preview"] tspan')
    .evaluateAll((lines) =>
      lines.map((line) => (line as SVGTextContentElement).getComputedTextLength()),
    )
  expect(Math.max(...expandedLineWidths)).toBeLessThanOrEqual(212.5)

  await page.locator('[data-ui="open-global-settings"]').click()
  await page.locator('[data-ui="settings-tab"][data-tab="appearance"]').click()
  await page.locator('[data-ui="font-family-select"]').selectOption('monospace')
  await page.locator('[data-role="global-settings-close"]').click()
  await expect
    .poll(() =>
      geometryNode
        .locator('[data-ui="branch-tree-node-preview"] tspan')
        .evaluateAll((lines) =>
          Math.max(...lines.map((line) => (line as SVGTextContentElement).getComputedTextLength())),
        ),
    )
    .toBeLessThanOrEqual(212.5)
  await page.getByRole('button', { name: 'Contract tree nodes' }).click()
  const compactAfter = await geometryNode.boundingBox()
  expect(Math.abs((compactAfter?.width ?? 0) - (compactBefore?.width ?? 0))).toBeLessThan(1)
  expect(Math.abs((compactAfter?.height ?? 0) - (compactBefore?.height ?? 0))).toBeLessThan(1)

  await geometryNode.hover()
  await expect(page.locator('[data-ui="branch-tree-preview"]')).toBeVisible()
  const previewSurface = await page
    .locator('[data-ui="branch-tree-preview-surface"]')
    .evaluate((element) => {
      const style = getComputedStyle(element)
      const canvas = element.closest('svg')?.parentElement
      return {
        opacity: Number(style.opacity),
        fillOpacity: Number(style.fillOpacity),
        width: element.getBoundingClientRect().width,
        canvasWidth: canvas?.clientWidth ?? 0,
        lineWidths: [...(element.parentElement?.querySelectorAll('tspan') ?? [])].map((line) =>
          (line as SVGTextContentElement).getComputedTextLength(),
        ),
      }
    })
  expect(previewSurface.opacity).toBe(1)
  expect(previewSurface.fillOpacity).toBe(1)
  expect(previewSurface.width).toBeLessThanOrEqual(previewSurface.canvasWidth - 15)
  expect(Math.max(...previewSurface.lineWidths)).toBeLessThanOrEqual(previewSurface.width - 31.5)
  expect(Math.max(...previewSurface.lineWidths)).toBeGreaterThan((previewSurface.width - 32) * 0.65)
  await page.mouse.move(1, 1)

  const canvasPane = page.locator('[data-ui="branch-tree-canvas-pane"]')
  const rightInset = async () => {
    const [paneBox, toggleBox] = await Promise.all([
      canvasPane.boundingBox(),
      densityToggle.boundingBox(),
    ])
    if (!paneBox || !toggleBox) throw new Error('Tree density control has no browser geometry')
    return paneBox.x + paneBox.width - (toggleBox.x + toggleBox.width)
  }
  const densityInsetBeforePanel = await rightInset()
  await page.locator('[data-role="settings-cog"]').first().click()
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  const densityInsetWithPanel = await rightInset()
  expect(Math.abs(densityInsetWithPanel - densityInsetBeforePanel)).toBeLessThan(2)
  await page.locator('[data-role="settings-pane-close"]').click()

  const search = page.getByRole('searchbox', { name: 'Search messages in this chat' })
  await search.fill('branch A')
  await expect(page.locator('[data-search-match="true"]')).toHaveCount(2)
  await expect(page.getByText('1 / 2')).toBeVisible()
  const searchGeometry = await page.locator('[data-ui="branch-tree-search"]').evaluate((outer) => {
    const input = outer.querySelector<HTMLInputElement>('[data-ui="branch-tree-search-input"]')
    const toolbar = outer.parentElement
    if (!input || !toolbar) throw new Error('Tree search geometry unavailable')
    const inputStyle = getComputedStyle(input)
    const outerStyle = getComputedStyle(outer)
    return {
      toolbarWidth: toolbar.getBoundingClientRect().width,
      outerWidth: outer.getBoundingClientRect().width,
      inputWidth: input.getBoundingClientRect().width,
      inputOutline: inputStyle.outlineStyle,
      inputShadow: inputStyle.boxShadow,
      outerShadow: outerStyle.boxShadow,
    }
  })
  expect(searchGeometry.outerWidth).toBeGreaterThan(searchGeometry.toolbarWidth - 40)
  expect(searchGeometry.inputWidth).toBeGreaterThan(searchGeometry.outerWidth * 0.5)
  expect(searchGeometry.inputOutline).toBe('none')
  expect(searchGeometry.inputShadow).toBe('none')
  expect(searchGeometry.outerShadow).not.toBe('none')
  await page.getByRole('button', { name: 'Next matching message' }).click()
  await expect(page.locator('[data-current-match="true"]')).toHaveAttribute('data-message-id', 'A2')
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    'A2',
  )
  await expect(page.locator('[data-ui="branch-tree-inspector-search-status"]')).toHaveText('1 / 3')
  await expect(
    page.locator('[data-ui="branch-tree-inspector"] [data-ui="markdown"] pre code span').first(),
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => {
        const texts: string[] = []
        for (const name of [
          'branch-tree-inspector-search-match',
          'branch-tree-inspector-search-current',
        ]) {
          const highlight = CSS.highlights.get(name)
          if (!highlight) continue
          for (const range of highlight) {
            if (!(range instanceof Range)) throw new Error('expected DOM range highlight')
            texts.push(range.toString())
          }
        }
        return texts.sort()
      }),
    )
    .toEqual(['branch A', 'branch A', 'branch A'])
  await page.getByRole('button', { name: 'Next occurrence in message' }).click()
  await expect(page.locator('[data-ui="branch-tree-inspector-search-status"]')).toHaveText('2 / 3')
  await page.getByRole('button', { name: 'Previous occurrence in message' }).click()
  await expect(page.locator('[data-ui="branch-tree-inspector-search-status"]')).toHaveText('1 / 3')

  await page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]').click()
  await expect(page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]')).toHaveAttribute(
    'data-selected',
    'true',
  )
  await expect(page.locator('[data-ui="branch-tree-node"][data-message-id="B2"]')).toHaveAttribute(
    'data-current-leaf',
    'true',
  )
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/message/B2')

  const inspectorBefore = await page.locator('[data-ui="branch-tree-inspector"]').boundingBox()
  await page.getByRole('separator', { name: 'Resize message details' }).focus()
  await page.keyboard.press('ArrowLeft')
  const inspectorAfter = await page.locator('[data-ui="branch-tree-inspector"]').boundingBox()
  expect(inspectorAfter?.width ?? 0).toBeGreaterThan(inspectorBefore?.width ?? 0)

  await page.getByRole('button', { name: 'Open this branch' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/message/A2')
  await page.locator('[data-ui="branch-tree-scroll"]').click({ position: { x: 8, y: 8 } })
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/message/A2')
  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).not.toBeVisible()
  await expect(page.locator('[data-ui="message-list"]')).toContainText('branch A assistant')
  await expect(page.locator('[data-ui="message-list"]')).not.toContainText('branch B assistant')
})

test('switching views preserves the active branch and retained tree workspace state', async ({
  page,
}) => {
  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/B2`)
  await expect(page.locator('[data-ui="message-list"]')).toContainText('branch B assistant')

  const treeToggle = page.locator('[data-role="chat-branch-tree"]')
  await treeToggle.click()
  const tree = page.locator('[data-ui="branch-tree-view"]')
  const search = page.getByRole('searchbox', { name: 'Search messages in this chat' })
  const inspectedNode = page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]')
  const currentLeaf = page.locator('[data-ui="branch-tree-node"][data-message-id="B2"]')
  const inspector = page.locator('[data-ui="branch-tree-inspector"]')

  await search.fill('branch A')
  await inspectedNode.click()
  await expect(inspectedNode).toHaveAttribute('data-selected', 'true')
  await expect(currentLeaf).toHaveAttribute('data-current-leaf', 'true')
  await expect(inspector).toHaveAttribute('data-message-id', 'A2')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/message/B2')

  await page.getByRole('separator', { name: 'Resize message details' }).focus()
  await page.keyboard.press('ArrowLeft')
  const inspectorWidth = (await inspector.boundingBox())?.width
  if (!inspectorWidth) throw new Error('Inspector has no browser geometry')

  await treeToggle.click()
  await expect(tree).not.toBeVisible()
  await expect(page.locator('[data-ui="message-list"]')).toBeVisible()
  await expect(page.locator('[data-ui="message-list"]')).toContainText('branch B assistant')
  await expect(page.locator('[data-ui="message-list"]')).not.toContainText('branch A assistant')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/message/B2')

  await treeToggle.click()
  await expect(tree).toBeVisible()
  await expect(search).toHaveValue('branch A')
  await expect(page.locator('[data-search-match="true"]')).toHaveCount(2)
  await expect(inspectedNode).toHaveAttribute('data-selected', 'true')
  await expect(currentLeaf).toHaveAttribute('data-current-leaf', 'true')
  await expect(inspector).toHaveAttribute('data-message-id', 'A2')
  await expect
    .poll(async () => (await inspector.boundingBox())?.width ?? 0)
    .toBeCloseTo(inspectorWidth, 0)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/message/B2')
})

test('tree inspector stays bounded across viewport sizes and drag panning preserves it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 900 })
  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/B2`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  const canvas = page.locator('[data-ui="branch-tree-scroll"]')
  const scrollBeforeSelection = await canvas.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }))
  await page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]').click()
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    'A2',
  )
  await expect
    .poll(() =>
      canvas.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop })),
    )
    .toEqual(scrollBeforeSelection)
  const wideInspector = await page.locator('[data-ui="branch-tree-inspector"]').boundingBox()
  expect(wideInspector?.width ?? 0).toBeLessThanOrEqual(961)

  const workspace = page.locator('[data-ui="branch-tree-workspace"]')
  const separator = page.getByRole('separator', { name: 'Resize message details' })
  const readSplitGeometry = () =>
    workspace.evaluate((element) => {
      const inspector = element.querySelector<HTMLElement>('[data-ui="branch-tree-inspector"]')
      const separator = element.querySelector<HTMLElement>('[data-ui="branch-tree-separator"]')
      if (!inspector || !separator) throw new Error('Inspector split geometry unavailable')
      return {
        workspaceWidth: element.clientWidth,
        inspectorWidth: inspector.getBoundingClientRect().width,
        minPercent: Number(separator.getAttribute('aria-valuemin')),
        nowPercent: Number(separator.getAttribute('aria-valuenow')),
        maxPercent: Number(separator.getAttribute('aria-valuemax')),
      }
    })
  const dragSeparatorBy = async (deltaX: number, verticalFraction: number) => {
    const box = await separator.boundingBox()
    if (!box) throw new Error('Inspector separator has no browser geometry')
    const startX = box.x + box.width / 2
    const startY = box.y + box.height * verticalFraction
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await expect(workspace).toHaveAttribute('data-resizing', 'true')
    await page.mouse.move(startX + deltaX, startY, { steps: 5 })
    await page.mouse.up()
    await expect(workspace).not.toHaveAttribute('data-resizing')
  }

  const [workspaceBox, separatorBox, separatorStyle] = await Promise.all([
    workspace.boundingBox(),
    separator.boundingBox(),
    separator.evaluate((element) => {
      const style = getComputedStyle(element)
      const marker = getComputedStyle(element, '::after')
      return {
        background: style.backgroundColor,
        borderTopWidth: style.borderTopWidth,
        markerBackground: marker.backgroundColor,
      }
    }),
  ])
  if (!workspaceBox || !separatorBox) throw new Error('Inspector boundary geometry unavailable')
  expect(Math.abs(separatorBox.y - workspaceBox.y)).toBeLessThan(1)
  expect(Math.abs(separatorBox.height - workspaceBox.height)).toBeLessThan(1)
  expect(separatorStyle.borderTopWidth).toBe('0px')
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(separatorStyle.background)
  expect(['rgba(0, 0, 0, 0)', 'transparent']).toContain(separatorStyle.markerBackground)
  const expectBoundedInspector = async () => {
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toBeVisible()
    const geometry = await readSplitGeometry()
    const roundingTolerance = geometry.workspaceWidth / 100 + 2
    expect(geometry.nowPercent).toBeGreaterThanOrEqual(geometry.minPercent)
    expect(geometry.nowPercent).toBeLessThanOrEqual(geometry.maxPercent)
    expect(geometry.inspectorWidth).toBeGreaterThanOrEqual(
      (geometry.workspaceWidth * geometry.minPercent) / 100 - roundingTolerance,
    )
    expect(geometry.inspectorWidth).toBeLessThanOrEqual(
      (geometry.workspaceWidth * geometry.maxPercent) / 100 + roundingTolerance,
    )
    return geometry
  }

  const beforePointerResize = await expectBoundedInspector()
  await dragSeparatorBy(180, 0.1)
  await expect
    .poll(() => readSplitGeometry().then((geometry) => geometry.inspectorWidth))
    .toBeLessThan(beforePointerResize.inspectorWidth - 100)
  const afterRightDrag = await expectBoundedInspector()

  await dragSeparatorBy(-120, 0.9)
  await expect
    .poll(() => readSplitGeometry().then((geometry) => geometry.inspectorWidth))
    .toBeGreaterThan(afterRightDrag.inspectorWidth + 60)
  await expectBoundedInspector()

  await dragSeparatorBy(-400, 0.5)
  await expect
    .poll(() => readSplitGeometry().then((geometry) => geometry.inspectorWidth))
    .toBeGreaterThan(720)
  await expectBoundedInspector()

  await page.locator('[data-role="settings-cog"]').first().click()
  await expect(page.locator('[data-ui="chat-model-panel"]')).toBeVisible()
  const splitWithSettings = await page
    .locator('[data-ui="branch-tree-workspace"]')
    .evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
  expect(splitWithSettings.scrollWidth).toBeLessThanOrEqual(splitWithSettings.clientWidth + 1)
  await page.locator('[data-role="settings-pane-close"]').click()

  await page.setViewportSize({ width: 390, height: 600 })
  await expect
    .poll(() => workspace.evaluate((element) => element.clientWidth))
    .toBeLessThanOrEqual(390)
  const narrowGeometry = await workspace.evaluate((element) => {
    const inspector = element.querySelector<HTMLElement>('[data-ui="branch-tree-inspector"]')
    const separator = element.querySelector<HTMLElement>('[data-ui="branch-tree-separator"]')
    if (!inspector || !separator) throw new Error('Inspector split geometry unavailable')
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      inspectorPercent: Math.round(
        (inspector.getBoundingClientRect().width / element.clientWidth) * 100,
      ),
      min: Number(separator.getAttribute('aria-valuemin')),
      now: Number(separator.getAttribute('aria-valuenow')),
      max: Number(separator.getAttribute('aria-valuemax')),
    }
  })
  expect(narrowGeometry.scrollWidth).toBeLessThanOrEqual(narrowGeometry.clientWidth + 1)
  expect(narrowGeometry.min).toBeLessThanOrEqual(narrowGeometry.now)
  expect(narrowGeometry.now).toBeLessThanOrEqual(narrowGeometry.max)
  expect(Math.abs(narrowGeometry.now - narrowGeometry.inspectorPercent)).toBeLessThanOrEqual(1)

  await page.getByRole('button', { name: 'Expand tree nodes' }).click()

  await expect(canvas).not.toHaveAttribute('data-panning')
  const overflow = await canvas.evaluate((element) => ({
    horizontal: element.scrollWidth - element.clientWidth,
    vertical: element.scrollHeight - element.clientHeight,
  }))
  expect(overflow.horizontal).toBeGreaterThan(20)
  expect(overflow.vertical).toBeGreaterThan(20)
  await canvas.evaluate((element) => {
    element.scrollLeft = 0
    element.scrollTop = 0
  })

  const box = await canvas.boundingBox()
  if (!box) throw new Error('Tree canvas has no browser geometry')
  await page.mouse.move(box.x + 30, box.y + 30)
  await page.mouse.down()
  await page.mouse.move(box.x + 6, box.y + 6, { steps: 4 })
  await expect(canvas).toHaveAttribute('data-panning', 'true')
  await page.mouse.up()
  await expect(canvas).not.toHaveAttribute('data-panning')
  await expect.poll(() => canvas.evaluate((element) => element.scrollLeft)).toBeGreaterThan(20)
  await expect.poll(() => canvas.evaluate((element) => element.scrollTop)).toBeGreaterThan(20)
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    'A2',
  )
})

test('shared and child connector targets remain distinct and shared insertion moves all children', async ({
  page,
}) => {
  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/B2`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
  await expect(page.locator('[data-ui="edit-tree-toolbar"]')).toHaveCount(0)
  await expect(page.locator('[data-connector-hit]')).not.toHaveCount(0)
  await expect(page.locator('[data-connector-hit][data-parent-id="root"]')).toHaveCount(3)
  await expect(page.locator('[data-connector-hit][data-parent-id="A1"]')).toHaveCount(1)
  await expect(page.locator('[data-connector-hit][data-child-id="A2"]')).toHaveCount(0)

  await page
    .locator(
      '[data-connector-hit="child-leg"][data-child-id="A1"][aria-label="Insert before this child only"]',
    )
    .click()
  await expect(page.locator('[data-ui="import-modal-slot"]')).toContainText('before this message')
  await page.locator('[data-role="import-modal-close"]').click()

  await page
    .locator(
      '[data-connector-hit="shared-trunk"][data-parent-id="root"][aria-label="Insert after this parent before all of its children"]',
    )
    .click()
  await expect(page.locator('[data-ui="import-modal-slot"]')).toContainText(
    'before all of its children',
  )
  await page.locator('[data-ui="import-modal-text"]').fill('shared inserted node')
  await page.getByRole('button', { name: 'Import', exact: true }).click()

  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)
  const topology = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const tx = db.transaction(['messages'], 'readonly')
        const request = tx.objectStore('messages').getAll()
        request.onsuccess = () =>
          resolve(
            (request.result as Array<Record<string, unknown>>).filter(
              (row) => row.chatId === 'branch-tree-chat',
            ),
          )
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  })
  const inserted = topology.find((row) => row.origin === 'imported')
  expect(inserted?.parentId).toBe('root')
  expect(topology.find((row) => row.id === 'A1')?.parentId).toBe(inserted?.id)
  expect(topology.find((row) => row.id === 'B1')?.parentId).toBe(inserted?.id)
  if (typeof inserted?.id !== 'string') throw new Error('Inserted node missing')

  await expect(page.locator('[data-role="chat-edit-tree"]')).toBeDisabled()
  await expect(page.locator('[data-role="chat-branch-tree"]')).toHaveAttribute(
    'data-state',
    'active',
  )
  await page.locator(`[data-ui="branch-tree-node"][data-message-id="${inserted.id}"]`).click()
  await page.getByRole('button', { name: 'Edit message' }).click()
  await page
    .locator('[data-ui="branch-tree-inspector"] [data-ui="inline-editor-input"]')
    .fill('edited tree node')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('[data-ui="branch-tree-inspector-content"]')).toContainText(
    'edited tree node',
  )
  await page.getByRole('button', { name: 'Delete message' }).click()
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(5)
  await expect(page.locator('[data-ui="toast-text"]')).toHaveText('Deleted message.')
  await page.locator('[data-ui="toast-undo"]').click()
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)
})

test('every leaf exposes an append target that inserts a child after it', async ({ page }) => {
  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/B2`)
  await page.locator('[data-role="chat-branch-tree"]').click()

  const leafTargets = page.getByRole('button', { name: 'Add message after this leaf' })
  await expect(leafTargets).toHaveCount(2)
  await page.locator('[data-connector-hit="leaf-append"][data-parent-id="A2"]').click()
  await expect(page.locator('[data-ui="import-modal"]')).toBeVisible()
  await page.locator('[data-ui="import-modal-text"]').fill('child appended after A2')
  await page.getByRole('button', { name: 'Import', exact: true }).click()

  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)
  await expect(leafTargets).toHaveCount(2)
  const inserted = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const tx = db.transaction(['messages'], 'readonly')
        const request = tx.objectStore('messages').getAll()
        request.onsuccess = () =>
          resolve(
            (request.result as Array<Record<string, unknown>>).find(
              (row) => row.chatId === 'branch-tree-chat' && row.origin === 'imported',
            ),
          )
        request.onerror = () => reject(request.error)
      })
    } finally {
      db.close()
    }
  })
  expect(inserted?.parentId).toBe('A2')
  expect(inserted?.role).toBe('user')
  expect(typeof inserted?.id).toBe('string')
  const insertedId = String(inserted?.id)
  await expect(
    page.locator(`[data-connector-hit="leaf-append"][data-parent-id="${insertedId}"]`),
  ).toBeVisible()
  await expect(
    page.locator(`[data-ui="branch-tree-node"][data-message-id="${insertedId}"]`),
  ).toHaveAttribute('data-current-leaf', 'true')
  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="message-list"]')).toContainText('child appended after A2')
})

test('tree inspector exposes generation, fork, context, reasoning, and tool actions', async ({
  page,
}) => {
  await mockChatCompletions(page, {
    body: buildSseBody([
      {
        id: 'tree-action-generation',
        model: 'google/gemini-3.1-flash-lite-preview:free',
        content: ' continued from tree',
      },
      { finish: 'stop' },
    ]),
  })
  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/B2`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  await page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]').click()

  await expect(page.getByRole('button', { name: 'Regenerate response' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Continue from here' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Branch this chat from here' })).toBeEnabled()

  const hideContext = page.getByRole('button', { name: 'Hide from context (never send to model)' })
  await hideContext.click()
  await expect(page.getByRole('button', { name: 'Show in context (send to model)' })).toBeVisible()
  await expect(page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]')).toHaveAttribute(
    'data-hidden-from-context',
    'true',
  )
  await expect(
    page.locator(
      '[data-ui="branch-tree-node"][data-message-id="A2"] [data-ui="branch-tree-node-visibility"]',
    ),
  ).toBeVisible()
  await expect.poll(() => readStoredMessageHidden(page, 'A2')).toBe(true)

  await page.locator('[data-ui="branch-tree-inspector"] [data-ui="reasoning-summary"]').click()
  await page.getByRole('button', { name: 'Hide this reasoning block' }).click()
  await expect(page.getByRole('button', { name: 'Unhide this reasoning block' })).toBeVisible()

  await page.locator('[data-ui="branch-tree-inspector"] [data-ui="tool-evidence-summary"]').click()
  await page.getByRole('button', { name: 'Hide tool call' }).click()
  await expect(page.getByRole('button', { name: 'Unhide tool call' })).toBeVisible()

  await page.getByRole('button', { name: 'Show in context (send to model)' }).click()
  await expect(
    page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]'),
  ).not.toHaveAttribute('data-hidden-from-context')
  await page.getByRole('button', { name: 'Unhide this reasoning block' }).click()
  await page.getByRole('button', { name: 'Unhide tool call' }).click()

  await page.getByRole('button', { name: 'Continue from here' }).click()
  await expect.poll(() => readStoredMessageText(page, 'A2')).toContain('continued from tree')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/message/A2')
  await expect(page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]')).toHaveAttribute(
    'data-current-leaf',
    'true',
  )

  await page.getByRole('button', { name: 'Regenerate response' }).click()
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)
  await expect.poll(() => readRegeneratedSiblingText(page)).toContain('continued from tree')
  await expect.poll(() => page.evaluate(() => window.location.hash)).not.toContain('/message/B2')
  const regeneratedLeaf = page.locator('[data-ui="branch-tree-node"][data-current-leaf="true"]')
  await expect(regeneratedLeaf).toHaveAttribute('data-selected', 'true')
  const regeneratedLeafId = await regeneratedLeaf.getAttribute('data-message-id')
  if (!regeneratedLeafId) throw new Error('Regenerated leaf has no message id')
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    regeneratedLeafId,
  )

  page.once('dialog', (dialog) => void dialog.accept('Tree action fork'))
  await page.getByRole('button', { name: 'Branch this chat from here' }).click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).not.toBeVisible()
  await expect(page.locator('[data-ui="message-list"]')).toContainText('continued from tree')
  await expect(page.locator('[data-ui="chat-title"]')).toContainText('Tree action fork')
})

test('Save & Send from an off-branch tree node hands its live stream to the transcript', async ({
  page,
}) => {
  let releaseResponse: () => void = () => undefined
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  let markRequestSeen: () => void = () => undefined
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markRequestSeen()
    await responseGate
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        {
          id: 'tree-save-send-generation',
          model: 'google/gemini-3.1-flash-lite-preview:free',
          content: ' reply streamed after leaving the tree',
        },
        { finish: 'stop' },
      ]),
    })
  })

  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/B2`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  await page.locator('[data-ui="branch-tree-node"][data-message-id="A1"]').click()
  await page.getByRole('button', { name: 'Edit message' }).click()
  await page
    .locator('[data-ui="branch-tree-inspector"] [data-ui="inline-editor-input"]')
    .fill('edited prompt sent from the tree')

  let streamTargetId: string | null
  try {
    await page.getByRole('button', { name: 'Save & Send' }).click()
    await requestSeen
    const streamingLeaf = page.locator(
      '[data-ui="branch-tree-node"][data-current-leaf="true"][data-selected="true"]',
    )
    await expect(streamingLeaf).toHaveCount(1)
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()
    streamTargetId = await streamingLeaf.getAttribute('data-message-id')
    if (!streamTargetId) throw new Error('Tree Save & Send has no active target')

    await expect(streamingLeaf).toHaveAttribute('data-current-leaf', 'true')
    await expect(streamingLeaf).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      streamTargetId,
    )

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(page.locator('[data-ui="message-list"]')).toContainText(
      'edited prompt sent from the tree',
    )
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${streamTargetId}"]`),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  } finally {
    releaseResponse()
  }

  await expect(page.locator('[data-ui="message-list"]')).toContainText(
    'reply streamed after leaving the tree',
  )
  await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
  if (!streamTargetId) throw new Error('Tree Save & Send lost its target id')
  await waitForMessageGenerationFinished(page, streamTargetId)
})

test('tree inspector keeps header controls live and guards body actions during a target stream', async ({
  page,
}) => {
  let releaseResponse: () => void = () => undefined
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  let markRequestSeen: () => void = () => undefined
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markRequestSeen()
    await responseGate
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        {
          id: 'tree-visibility-generation',
          model: 'google/gemini-3.1-flash-lite-preview:free',
          content: ' guarded continuation',
        },
        { finish: 'stop' },
      ]),
    })
  })

  const chatId = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${chatId}/message/B2`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  await page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]').click()

  try {
    await page.getByRole('button', { name: 'Continue from here' }).click()
    await requestSeen
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()

    await expect(
      page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]'),
    ).toHaveAttribute('data-current-leaf', 'true')
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      'A2',
    )

    await page.locator('[data-ui="branch-tree-inspector"] [data-ui="reasoning-summary"]').click()
    await page
      .locator('[data-ui="branch-tree-inspector"] [data-ui="tool-evidence-summary"]')
      .click()
    await expect(page.getByRole('button', { name: 'Hide this reasoning block' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Hide tool call' })).toBeDisabled()

    await page.getByRole('button', { name: 'Hide from context (never send to model)' }).click()
    await expect(
      page.getByRole('button', { name: 'Show in context (send to model)' }),
    ).toBeVisible()
    await expect.poll(() => readStoredMessageHidden(page, 'A2')).toBe(true)

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(page.locator('[data-ui="message"][data-message-id="A2"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(
      page.locator('[data-ui="branch-tree-node"][data-message-id="A2"]'),
    ).toHaveAttribute('data-selected', 'true')
    await expect(page.getByRole('button', { name: 'Hide this reasoning block' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Hide tool call' })).toBeDisabled()
  } finally {
    releaseResponse()
  }

  await expect(page.locator('[data-ui="branch-tree-stop"]')).toHaveCount(0)
  await expect.poll(() => readStoredMessageText(page, 'A2')).toContain('guarded continuation')
  await waitForMessageGenerationFinished(page, 'A2')
  await expect(page.getByRole('button', { name: 'Hide this reasoning block' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Hide tool call' })).toBeEnabled()
})

test('tree shows and follows a pending response before the first byte arrives', async ({
  page,
}) => {
  let releaseResponse: () => void = () => undefined
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  let markRequestSeen: () => void = () => undefined
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markRequestSeen()
    await responseGate
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        {
          id: 'tree-delayed-generation',
          model: 'google/gemini-3.1-flash-lite-preview:free',
          content: 'response released after tree waiting state',
        },
        { finish: 'stop' },
      ]),
    })
  })

  await createChatAndOpen(page)
  await sendMessage(page, 'wait before replying')
  await requestSeen
  const pendingMessage = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(pendingMessage).toBeVisible()
  const streamTargetId = await pendingMessage.getAttribute('data-message-id')
  if (!streamTargetId) throw new Error('Pending response has no target message')
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()

  try {
    await page.locator('[data-role="chat-branch-tree"]').click()
    const pendingNode = page.locator(
      `[data-ui="branch-tree-node"][data-message-id="${streamTargetId}"]`,
    )
    await expect(pendingNode).toHaveAttribute('data-current-leaf', 'true')
    await expect(pendingNode).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      streamTargetId,
    )
    await expect(page.locator('[data-ui="branch-tree-inspector-stream-status"]')).toHaveText(
      'Waiting for response…',
    )
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(
      page.locator(`[data-ui="message"][data-message-id="${streamTargetId}"]`),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(pendingNode).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      streamTargetId,
    )
    await expect(page.locator('[data-ui="branch-tree-inspector-stream-status"]')).toHaveText(
      'Waiting for response…',
    )
    releaseResponse()
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toHaveCount(0)
    await expect(page.locator('[data-ui="branch-tree-inspector"] [data-ui="markdown"]')).toHaveText(
      'response released after tree waiting state',
    )
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      streamTargetId,
    )

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(
      page.locator(
        `[data-ui="message"][data-message-id="${streamTargetId}"] [data-ui="message-body"]`,
      ),
    ).toHaveText('response released after tree waiting state')
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain(`/message/${streamTargetId}`)
    await waitForMessageGenerationFinished(page, streamTargetId)
  } finally {
    releaseResponse()
  }
})

async function seedBranchTreeChat(page: Page): Promise<string> {
  const now = Date.now()
  const chatId = 'branch-tree-chat'
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
      content: [
        {
          type: 'output_text',
          text: 'branch A assistant, with branch A repeated for inspector navigation\n\n```ts\nconst label = "branch A"\n```',
        },
      ],
      reasoningDetails: [
        {
          type: 'reasoning.text',
          text: 'Tree inspector reasoning detail.',
          format: 'anthropic-claude-v1',
        },
      ],
      providerOutputItems: [
        {
          dialect: 'openai-responses',
          type: 'web_search_call',
          outputIndex: 0,
          item: {
            type: 'web_search_call',
            id: 'tree-search-1',
            status: 'completed',
            action: { type: 'search', query: 'tree inspector action parity' },
          },
        },
      ],
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
  const storedMessages = sourceMessages.map((message) => splitMessageForStorage(message))
  const wordCount = storedMessages.reduce((total, stored) => total + stored.header.bodyWordCount, 0)
  const previewText = previewTextFromStoredProjection(
    storedMessages.find((stored) => stored.header.id === 'A1')?.header.textPreview ?? '',
  )

  await page.evaluate(
    async (seed) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('natter')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(['presets', 'chats', 'messages', 'messageBodies'], 'readwrite')
          const presets = tx.objectStore('presets')
          const chats = tx.objectStore('chats')
          const messages = tx.objectStore('messages')
          const messageBodies = tx.objectStore('messageBodies')
          const presetsRequest = presets.getAll()
          presetsRequest.onsuccess = () => {
            const preset = (
              presetsRequest.result as Array<{ id?: string; settings?: Record<string, unknown> }>
            )[0]
            if (!preset?.id || !preset.settings) {
              reject(new Error('missing seed preset'))
              return
            }
            chats.put({
              id: seed.chatId,
              title: 'Branch tree chat',
              titleStatus: 'manual',
              createdAt: seed.now,
              updatedAt: seed.now + seed.storedMessages.length - 1,
              lastViewedAt: seed.now + seed.storedMessages.length - 1,
              wordCount: seed.wordCount,
              totalCostUsd: 0,
              metaVersion: 0,
              summaryVersion: 0,
              settings: structuredClone(preset.settings),
              presetId: preset.id,
              lastUpdatedLeafId: 'B2',
              lastBranchUpdatedAt: seed.now + seed.storedMessages.length - 1,
              archived: false,
              pinned: false,
              folderId: null,
              tags: [],
              previewText: seed.previewText,
            })
            for (const stored of seed.storedMessages) {
              messages.put(stored.header)
              messageBodies.put(stored.body)
            }
          }
          presetsRequest.onerror = () => reject(presetsRequest.error)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } finally {
        db.close()
      }
    },
    { chatId, now, previewText, storedMessages, wordCount },
  )
  await rebuildSidebarProjection(page)
  return chatId
}

async function readStoredMessageText(page: Page, messageId: string): Promise<string> {
  const message = await readStoredMessage(page, messageId)
  return ((message?.content ?? []) as Array<{ text?: string }>)
    .map((item) => item.text ?? '')
    .join('')
}

async function readStoredMessageHidden(page: Page, messageId: string): Promise<boolean> {
  return (await readStoredMessage(page, messageId))?.hiddenFromContext === true
}

async function readRegeneratedSiblingText(page: Page): Promise<string> {
  const messages = await readMessages(page, 'branch-tree-chat')
  const regenerated = messages.find((message) => message.parentId === 'A1' && message.id !== 'A2')
  return ((regenerated?.content ?? []) as Array<{ text?: string }>)
    .map((item) => item.text ?? '')
    .join('')
}

async function waitForMessageGenerationFinished(page: Page, messageId: string): Promise<void> {
  await expect
    .poll(async () => {
      const message = await readStoredMessage(page, messageId)
      const generation = message?.generation as { finishedAt?: unknown } | undefined
      const continuationAttempts = message?.continuationAttempts as
        | Array<{ finishedAt?: unknown }>
        | undefined
      return (
        typeof generation?.finishedAt === 'number' ||
        continuationAttempts?.some((attempt) => typeof attempt.finishedAt === 'number') === true
      )
    })
    .toBe(true)
}

async function readStoredMessage(
  page: Page,
  messageId: string,
): Promise<Record<string, unknown> | undefined> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const tx = db.transaction(['messages', 'messageBodies'], 'readonly')
        const headerRequest = tx.objectStore('messages').get(id)
        headerRequest.onsuccess = () => {
          const header = headerRequest.result as Record<string, unknown> | undefined
          if (!header) {
            resolve(undefined)
            return
          }
          const bodyRequest = tx.objectStore('messageBodies').get(id)
          bodyRequest.onsuccess = () => {
            const body = bodyRequest.result as Record<string, unknown> | undefined
            resolve(body ? { ...header, ...body, nodeVersion: header.nodeVersion } : header)
          }
          bodyRequest.onerror = () => reject(bodyRequest.error)
        }
        headerRequest.onerror = () => reject(headerRequest.error)
      })
    } finally {
      db.close()
    }
  }, messageId)
}

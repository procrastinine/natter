import { expect, type Page, test } from './fixtures'
import {
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  mockChatCompletions,
  seedFirstRun,
  sendMessage,
} from './helpers'

interface BranchTreeStoredMessage {
  id: string
  parentId: string | null
  content?: ReadonlyArray<{ type?: string; text?: string }>
}

interface BranchTreeRepository {
  runMutation(
    scopes: readonly unknown[],
    mutation: (context: {
      putMessage(message: Record<string, unknown>): Promise<void>
    }) => Promise<void>,
  ): Promise<void>
  getMessage(messageId: string): Promise<BranchTreeStoredMessage | undefined>
  getMessageHeader(messageId: string): Promise<{ hiddenFromContext?: boolean } | undefined>
  listMessages(chatId: string): Promise<BranchTreeStoredMessage[]>
}

interface BranchTreeRepositoryModule {
  getWorkspaceRepository(): BranchTreeRepository
}

interface BranchTreeChatModule {
  createChat(input: { id: string; title: string; settings: unknown; now: number }): Promise<unknown>
}

interface BranchTreeDefaultsModule {
  cloneDefaultChatSettings(): unknown
}

interface BranchTreePresetsModule {
  listPresets(): Promise<Array<{ settings?: unknown }>>
}

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
  await page.route('**/api/v1/chat/completions', async (route) => {
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

  try {
    await page.getByRole('button', { name: 'Save & Send' }).click()
    const streamTargetId = await page
      .waitForFunction(
        () =>
          (
            window as unknown as {
              __debugFakeStream?: {
                state(): { streamStore: { activeTargets: Array<{ messageId?: string }> } }
              }
            }
          ).__debugFakeStream?.state().streamStore.activeTargets[0]?.messageId ?? null,
      )
      .then((handle) => handle.jsonValue())
    if (!streamTargetId) throw new Error('Tree Save & Send has no active target')

    const streamingLeaf = page.locator(
      `[data-ui="branch-tree-node"][data-message-id="${streamTargetId}"]`,
    )
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

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __debugFakeStream?: { state(): { streamStore: { activeCount: number } } }
            }
          ).__debugFakeStream?.state().streamStore.activeCount,
      ),
    )
    .toBe(0)
  await expect(page.locator('[data-ui="message-list"]')).toContainText(
    'reply streamed after leaving the tree',
  )
})

test('tree inspector keeps header controls live and guards body actions during a target stream', async ({
  page,
}) => {
  let releaseResponse: () => void = () => undefined
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
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
    await expect
      .poll(() =>
        page.evaluate(() =>
          Object.values(
            (
              window as unknown as {
                __debugFakeStream?: {
                  state(): {
                    streamStore: {
                      activeTargets: Array<{ messageId?: string }>
                    }
                  }
                }
              }
            ).__debugFakeStream?.state().streamStore.activeTargets ?? [],
          ).some((target) => target.messageId === 'A2'),
        ),
      )
      .toBe(true)

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

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __debugFakeStream?: { state(): { streamStore: { activeCount: number } } }
            }
          ).__debugFakeStream?.state().streamStore.activeCount,
      ),
    )
    .toBe(0)
  await expect(page.getByRole('button', { name: 'Hide this reasoning block' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Hide tool call' })).toBeEnabled()
})

test('switching to the tree during a stream does not stop or lose the generation', async ({
  page,
}) => {
  const resultPromise = page.evaluate(() => {
    const api = (
      window as unknown as {
        __debugFakeStream?: {
          start(options: Record<string, unknown>): Promise<{ chatId: string }>
        }
      }
    ).__debugFakeStream
    if (!api) throw new Error('debug fake stream unavailable')
    return api
      .start({
        targetChars: 12_000,
        reasoningChars: 12_000,
        chunkChars: 120,
        delayMs: 30,
      })
      .then((result) => result.chatId)
  })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __debugFakeStream?: { state(): { streamStore: { activeCount: number } } }
            }
          ).__debugFakeStream?.state().streamStore.activeCount,
      ),
    )
    .toBe(1)
  const streamTargetId = await page
    .waitForFunction(
      () =>
        (
          window as unknown as {
            __debugFakeStream?: {
              state(): { streamStore: { activeTargets: Array<{ messageId?: string }> } }
            }
          }
        ).__debugFakeStream
          ?.state()
          .streamStore.activeTargets.find((target) => target.messageId)?.messageId ?? null,
    )
    .then((handle) => handle.jsonValue())
  if (!streamTargetId) throw new Error('Active fake stream has no target message')
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
  const streamingNode = page.locator(
    `[data-ui="branch-tree-node"][data-message-id="${streamTargetId}"]`,
  )
  await expect(streamingNode).toHaveAttribute('data-current-leaf', 'true')
  await expect(streamingNode).toHaveAttribute('data-selected', 'true')
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    streamTargetId,
  )
  await expect
    .poll(() =>
      page
        .locator('[data-ui="branch-tree-inspector"] [data-ui="markdown"]')
        .textContent()
        .then((text) => text?.length ?? 0),
    )
    .toBeGreaterThan(0)
  await expect(page.locator('[data-ui="branch-tree-inspector-stream-status"]')).toHaveText(
    'Streaming response…',
  )
  await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit message' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Delete message' })).toBeDisabled()
  await expect(page.locator('[data-connector-hit][data-stream-busy="true"]')).not.toHaveCount(0)

  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(
    page.locator(`[data-ui="message"][data-message-id="${streamTargetId}"]`),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()

  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(streamingNode).toHaveAttribute('data-selected', 'true')
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    streamTargetId,
  )
  await expect
    .poll(() =>
      page
        .locator('[data-ui="branch-tree-inspector"] [data-ui="markdown"]')
        .textContent()
        .then((text) => text?.length ?? 0),
    )
    .toBeGreaterThan(0)
  await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()

  const chatId = await resultPromise
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __debugFakeStream?: { state(): { streamStore: { activeCount: number } } }
            }
          ).__debugFakeStream?.state().streamStore.activeCount,
      ),
    )
    .toBe(0)

  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="message-list"]')).toBeVisible()
  const persisted = await readAssistantLengths(page, chatId)
  expect(persisted).toEqual({ text: 12_000, reasoning: 12_000 })
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
  const streamTargetId = await page
    .waitForFunction(
      () =>
        (
          window as unknown as {
            __debugFakeStream?: {
              state(): { streamStore: { activeTargets: Array<{ messageId?: string }> } }
            }
          }
        ).__debugFakeStream
          ?.state()
          .streamStore.activeTargets.find((target) => target.messageId)?.messageId ?? null,
    )
    .then((handle) => handle.jsonValue())
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
    await page.locator('[data-ui="branch-tree-stop"]').click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __debugFakeStream?: { state(): { streamStore: { activeCount: number } } }
              }
            ).__debugFakeStream?.state().streamStore.activeCount,
        ),
      )
      .toBe(0)
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toHaveCount(0)
    await expect(page.locator('[data-ui="branch-tree-inspector-stream-status"]')).toContainText(
      'Cancelled — partial response kept above.',
    )
  } finally {
    releaseResponse()
  }
})

async function seedBranchTreeChat(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const chatsPath = '/src/store/chats.ts'
    const defaultsPath = '/src/core/defaults.ts'
    const presetsPath = '/src/store/presets.ts'
    const repositoryPath = '/src/store/workspace-repository.ts'
    const [chatModule, defaultsModule, presetsModule, repositoryModule] = (await Promise.all([
      import(/* @vite-ignore */ chatsPath),
      import(/* @vite-ignore */ defaultsPath),
      import(/* @vite-ignore */ presetsPath),
      import(/* @vite-ignore */ repositoryPath),
    ])) as unknown as [
      BranchTreeChatModule,
      BranchTreeDefaultsModule,
      BranchTreePresetsModule,
      BranchTreeRepositoryModule,
    ]
    const now = Date.now()
    const chatId = 'branch-tree-chat'
    const preset = (await presetsModule.listPresets())[0]
    await chatModule.createChat({
      id: chatId,
      title: 'Branch tree chat',
      settings: preset?.settings ?? defaultsModule.cloneDefaultChatSettings(),
      now,
    })
    const rows = [
      ['root', null, 0, 'system', 'system', 'root instruction'],
      ['A1', 'root', 0, 'user', 'user', 'branch A user'],
      [
        'A2',
        'A1',
        0,
        'assistant',
        'generated',
        'branch A assistant, with branch A repeated for inspector navigation\n\n```ts\nconst label = "branch A"\n```',
      ],
      ['B1', 'root', 1, 'user', 'user', 'branch B user'],
      ['B2', 'B1', 0, 'assistant', 'generated', 'branch B assistant'],
    ] as const
    const repository = repositoryModule.getWorkspaceRepository()
    await repository.runMutation(
      [
        { kind: 'chat-meta', chatId },
        ...rows.map(([id]) => ({ kind: 'message' as const, messageId: id })),
        ...rows.map(([, parentId]) => ({ kind: 'children' as const, chatId, parentId })),
      ],
      async (context: { putMessage(message: Record<string, unknown>): Promise<void> }) => {
        for (let index = 0; index < rows.length; index += 1) {
          const [id, parentId, siblingIndex, role, origin, text] = rows[
            index
          ] as (typeof rows)[number]
          const createdAt = now + index
          await context.putMessage({
            id,
            chatId,
            parentId,
            siblingIndex,
            turnId: `turn-${id}`,
            turnIndex: parentId === null ? 0 : parentId === 'root' ? 1 : 2,
            createdAt,
            role,
            origin,
            content:
              role === 'assistant' ? [{ type: 'output_text', text }] : [{ type: 'text', text }],
            ...(id === 'A2'
              ? {
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
                }
              : {}),
            nodeVersion: 0,
            deleted: false,
          })
        }
      },
    )
    return chatId
  })
}

async function readAssistantLengths(
  page: Page,
  chatId: string,
): Promise<{ text: number; reasoning: number }> {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('natter')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['messages', 'messageBodies'], 'readonly')
        const headers = tx.objectStore('messages').getAll()
        headers.onsuccess = () => {
          const assistant = (headers.result as Array<Record<string, unknown>>).find(
            (row) => row.chatId === id && row.role === 'assistant' && row.deleted === false,
          )
          if (!assistant || typeof assistant.id !== 'string') {
            reject(new Error('assistant missing'))
            return
          }
          const body = tx.objectStore('messageBodies').get(assistant.id)
          body.onsuccess = () => {
            const value = body.result as {
              content?: Array<{ type?: string; text?: string }>
              reasoningDetails?: Array<{ type?: string; text?: string; summary?: string }>
            }
            resolve({
              text: (value.content ?? []).reduce((sum, item) => sum + (item.text?.length ?? 0), 0),
              reasoning: (value.reasoningDetails ?? []).reduce(
                (sum, item) => sum + (item.text?.length ?? item.summary?.length ?? 0),
                0,
              ),
            })
          }
          body.onerror = () => reject(body.error)
        }
        headers.onerror = () => reject(headers.error)
      })
    } finally {
      db.close()
    }
  }, chatId)
}

async function readStoredMessageText(page: Page, messageId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const repositoryPath = '/src/store/workspace-repository.ts'
    const repositoryModule = (await import(
      /* @vite-ignore */ repositoryPath
    )) as unknown as BranchTreeRepositoryModule
    const message = await repositoryModule.getWorkspaceRepository().getMessage(id)
    return (message?.content ?? [])
      .map((item: { type?: string; text?: string }) => item.text ?? '')
      .join('')
  }, messageId)
}

async function readStoredMessageHidden(page: Page, messageId: string): Promise<boolean> {
  return page.evaluate(async (id) => {
    const repositoryPath = '/src/store/workspace-repository.ts'
    const repositoryModule = (await import(
      /* @vite-ignore */ repositoryPath
    )) as unknown as BranchTreeRepositoryModule
    return (
      (await repositoryModule.getWorkspaceRepository().getMessageHeader(id))?.hiddenFromContext ===
      true
    )
  }, messageId)
}

async function readRegeneratedSiblingText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const repositoryPath = '/src/store/workspace-repository.ts'
    const repositoryModule = (await import(
      /* @vite-ignore */ repositoryPath
    )) as unknown as BranchTreeRepositoryModule
    const messages = await repositoryModule
      .getWorkspaceRepository()
      .listMessages('branch-tree-chat')
    const regenerated = messages.find(
      (message: { id: string; parentId: string | null }) =>
        message.parentId === 'A1' && message.id !== 'A2',
    )
    return (regenerated?.content ?? [])
      .map((item: { type?: string; text?: string }) => item.text ?? '')
      .join('')
  })
}

import { readFileSync } from 'node:fs'
import { importPortableChatThroughUi } from '../../scripts/workspace-provider-fixture.mjs'
import { expect, type Page, test } from './fixtures'
import {
  activeWorkspaceDatabaseName,
  buildSseBody,
  clearIndexedDb,
  createChatAndOpen,
  holdIndexedDbStoreGate,
  mockChatCompletions,
  readMessages,
  seedFirstRun,
  sendMessage,
} from './helpers'

interface BranchTreeFixture {
  readonly chatId: string
  readonly root: string
  readonly A1: string
  readonly A2: string
  readonly B1: string
  readonly B2: string
  readonly extraA: readonly string[]
}

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await seedFirstRun(page)
})

test('branching from an intermediate transcript node settles one durable fork', async ({
  page,
}) => {
  const fixture = await seedBranchTreeChat(page, { extraBranchRows: 66 })
  const targetId = fixture.extraA[63]
  const tipId = fixture.extraA[65]
  if (!targetId || !tipId) throw new Error('IntermediateForkFixtureMissing')
  await page.goto(`/#/chat/${fixture.chatId}/message/${tipId}`)
  const activeDatabaseBefore = await activeWorkspaceDatabaseName(page)
  const intermediate = page.locator(`[data-ui="message"][data-message-id="${targetId}"]`)
  await expect(intermediate).toContainText('large imported branch assistant 63')
  await expect(
    intermediate.getByRole('button', { name: 'Branch this chat from here' }),
  ).toBeEnabled()

  page.once('dialog', (dialog) => void dialog.accept('Intermediate durable fork'))
  await intermediate.getByRole('button', { name: 'Branch this chat from here' }).click()

  await expect(page.locator('[data-ui="chat-title"]')).toContainText('Intermediate durable fork', {
    timeout: 15_000,
  })
  await expect(page.locator('[data-ui="toast"]').filter({ hasText: 'Forked to' })).toHaveCount(1)
  const forkChatId = await page.evaluate(() => {
    const match = window.location.hash.match(/^#\/chat\/([^/]+)/u)
    return match?.[1] ?? null
  })
  expect(forkChatId).not.toBeNull()
  expect(forkChatId).not.toBe(fixture.chatId)
  if (!forkChatId) throw new Error('IntermediateForkRouteMissing')

  const sourceRows = await readMessages(page, fixture.chatId)
  const forkRows = await readMessages(page, forkChatId)
  expect(sourceRows).toHaveLength(71)
  expect(forkRows).toHaveLength(67)
  const forkText = forkRows.map((message) =>
    ((message.content ?? []) as Array<{ text?: string }>).map((item) => item.text ?? '').join(''),
  )
  expect(forkText.slice(0, 3)).toEqual([
    'root instruction',
    'branch A user',
    expect.stringContaining('branch A assistant'),
  ])
  expect(forkText.at(-1)).toBe('large imported branch assistant 63')
  expect(forkRows[0]?.parentId).toBeNull()
  expect(forkRows[1]?.parentId).toBe(forkRows[0]?.id)
  expect(forkRows.some((message) => sourceRows.some((source) => source.id === message.id))).toBe(
    false,
  )
  expect(await activeWorkspaceDatabaseName(page)).toBe(activeDatabaseBefore)
  const mountedMessages = page.locator('[data-ui="message"]')
  await expect(mountedMessages.last()).toContainText('large imported branch assistant 63')
  expect(await mountedMessages.count()).toBeLessThanOrEqual(50)
  await expect(
    page.locator('[data-ui="message"]').last().getByRole('button', { name: 'Edit message' }),
  ).toBeEnabled()
})

test('content-free structure exporter reports the active chat without message payloads', async ({
  page,
}) => {
  const fixture = await seedBranchTreeChat(page, { extraBranchRows: 66 })
  const tipId = fixture.extraA.at(-1)
  if (!tipId) throw new Error('StructureExporterFixtureMissing')
  await page.goto(`/#/chat/${fixture.chatId}/message/${tipId}`)
  const source = readFileSync(
    new URL('../../scripts/export-chat-structure.js', import.meta.url),
    'utf8',
  )
  const downloadPromise = page.waitForEvent('download')

  await page.addScriptTag({ content: source })

  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  const exported = Buffer.concat(chunks).toString('utf8')
  const report = JSON.parse(exported) as {
    chat: Record<string, unknown>
    messages: Array<Record<string, unknown>>
    summary: { messageCount: number; maximumDepth: number }
    diagnostics: { missingParents: unknown[]; cyclicMessageIds: unknown[] }
  }

  expect(download.suggestedFilename()).toContain(fixture.chatId)
  expect(report.summary).toMatchObject({ messageCount: 71, maximumDepth: 68 })
  expect(report.diagnostics).toMatchObject({ missingParents: [], cyclicMessageIds: [] })
  expect(report.chat).not.toHaveProperty('title')
  expect(report.messages).toHaveLength(71)
  for (const message of report.messages) {
    expect(message).not.toHaveProperty('content')
    expect(message).not.toHaveProperty('reasoningDetails')
    expect(message).not.toHaveProperty('providerOutputItems')
  }
  expect(exported).not.toContain('root instruction')
  expect(exported).not.toContain('Tree inspector reasoning detail.')
  expect(exported).not.toContain('large imported branch assistant 65')
})

test('middle-click opens the newest descendant branch in a background tab', async ({
  context,
  page,
}) => {
  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.A2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()

  const popupPromise = context.waitForEvent('page')
  await page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.root}"]`).click({
    button: 'middle',
  })
  const popup = await popupPromise

  await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`/message/${fixture.A2}`)
  await expect(popup).toHaveURL(new RegExp(`/message/${fixture.B2}$`, 'u'))
  await expect(popup.locator('[data-ui="message-list"]')).toContainText('branch B assistant')
  await expect(popup.locator('[data-ui="message-list"]')).not.toContainText('branch A assistant')
})

test('tree view replaces the transcript, searches all branches, and changes the active branch', async ({
  page,
}) => {
  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
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
  const geometryNode = page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.A2}"]`)
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
  await expect(page.locator('[data-current-match="true"]')).toHaveAttribute(
    'data-message-id',
    fixture.A2,
  )
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    fixture.A2,
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

  const branchANode = page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.A2}"]`)
  const branchBNode = page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.B2}"]`)
  await branchANode.click()
  await expect(branchANode).toHaveAttribute('data-selected', 'true')
  await expect(branchBNode).toHaveAttribute('data-current-leaf', 'true')
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`/message/${fixture.B2}`)

  const inspectorBefore = await page.locator('[data-ui="branch-tree-inspector"]').boundingBox()
  await page.getByRole('separator', { name: 'Resize message details' }).focus()
  await page.keyboard.press('ArrowLeft')
  const inspectorAfter = await page.locator('[data-ui="branch-tree-inspector"]').boundingBox()
  expect(inspectorAfter?.width ?? 0).toBeGreaterThan(inspectorBefore?.width ?? 0)

  await page.getByRole('button', { name: 'Open this branch' }).click()
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`/message/${fixture.A2}`)
  await page.locator('[data-ui="branch-tree-scroll"]').click({ position: { x: 8, y: 8 } })
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`/message/${fixture.A2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).not.toBeVisible()
  await expect(page.locator('[data-ui="message-list"]')).toContainText('branch A assistant')
  await expect(page.locator('[data-ui="message-list"]')).not.toContainText('branch B assistant')
})

test('switching views preserves the active branch and retained tree workspace state', async ({
  page,
}) => {
  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await expect(page.locator('[data-ui="message-list"]')).toContainText('branch B assistant')

  const treeToggle = page.locator('[data-role="chat-branch-tree"]')
  await treeToggle.click()
  const tree = page.locator('[data-ui="branch-tree-view"]')
  const search = page.locator('[data-ui="branch-tree-search-input"]')
  const inspectedNode = page.locator(
    `[data-ui="branch-tree-node"][data-message-id="${fixture.A2}"]`,
  )
  const currentLeaf = page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.B2}"]`)
  const inspector = page.locator('[data-ui="branch-tree-inspector"]')
  const inspectorBody = page.locator('[data-ui="branch-tree-inspector-content"]')
  const treeNodes = page.locator('[data-ui="branch-tree-node"]')
  const nodePreviews = page.locator('[data-ui="branch-tree-node-preview"]')
  const treeRoot = await tree.elementHandle()
  if (!treeRoot) throw new Error('Tree root is not mounted')

  await expect(tree).toBeVisible()
  await page.locator('[data-ui="tree-density-toggle"]').click()
  await expect(tree).toHaveAttribute('data-expanded', 'true')
  await expect(treeNodes).toHaveCount(5)
  await expect(nodePreviews).toHaveCount(5)

  await search.fill('branch A')
  await inspectedNode.click()
  await expect(inspectedNode).toHaveAttribute('data-selected', 'true')
  await expect(currentLeaf).toHaveAttribute('data-current-leaf', 'true')
  await expect(inspector).toHaveAttribute('data-message-id', fixture.A2)
  await expect(inspectorBody).toContainText('branch A assistant')
  const inspectorRoot = await inspector.elementHandle()
  if (!inspectorRoot) throw new Error('Inspector root is not mounted')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`/message/${fixture.B2}`)

  await page.getByRole('separator', { name: 'Resize message details' }).focus()
  await page.keyboard.press('ArrowLeft')
  const inspectorWidth = (await inspector.boundingBox())?.width
  if (!inspectorWidth) throw new Error('Inspector has no browser geometry')

  await treeToggle.click()
  await expect(tree).not.toBeVisible()
  await expect(page.locator('[data-ui="message-list"]')).toBeVisible()
  await expect(page.locator('[data-ui="message-list"]')).toContainText('branch B assistant')
  await expect(page.locator('[data-ui="message-list"]')).not.toContainText('branch A assistant')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`/message/${fixture.B2}`)
  expect(await tree.evaluate((element, retainedRoot) => element === retainedRoot, treeRoot)).toBe(
    true,
  )
  await expect(search).toHaveValue('branch A')
  await expect(tree).toHaveAttribute('data-expanded', 'true')
  await expect(treeNodes).toHaveCount(0)
  await expect(nodePreviews).toHaveCount(0)
  expect(
    await inspector.evaluate((element, retainedRoot) => element === retainedRoot, inspectorRoot),
  ).toBe(true)
  await expect(inspectorBody).toContainText('branch A assistant')
  await expect(tree).toHaveAttribute('data-presentation-only', 'true')

  await treeToggle.click()
  await expect(tree).toBeVisible()
  expect(await tree.evaluate((element, retainedRoot) => element === retainedRoot, treeRoot)).toBe(
    true,
  )
  expect(
    await inspector.evaluate((element, retainedRoot) => element === retainedRoot, inspectorRoot),
  ).toBe(true)
  await expect(treeNodes).toHaveCount(5)
  await expect(nodePreviews).toHaveCount(5)
  await expect(search).toHaveValue('branch A')
  await expect(page.locator('[data-search-match="true"]')).toHaveCount(2)
  await expect(inspectedNode).toHaveAttribute('data-selected', 'true')
  await expect(currentLeaf).toHaveAttribute('data-current-leaf', 'true')
  await expect(inspector).toHaveAttribute('data-message-id', fixture.A2)
  await expect(inspectorBody).toContainText('branch A assistant')
  await expect
    .poll(async () => (await inspector.boundingBox())?.width ?? 0)
    .toBeCloseTo(inspectorWidth, 0)
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`/message/${fixture.B2}`)
})

test('tree inspector stays bounded across viewport sizes and drag panning preserves it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2560, height: 900 })
  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  const canvas = page.locator('[data-ui="branch-tree-scroll"]')
  const scrollBeforeSelection = await canvas.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }))
  await page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.A2}"]`).click()
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    fixture.A2,
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
    fixture.A2,
  )
})

test('shared and child connector targets remain distinct and shared insertion moves all children', async ({
  page,
}) => {
  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  await expect(page.locator('[data-ui="branch-tree-view"]')).toBeVisible()
  await expect(page.locator('[data-ui="edit-tree-toolbar"]')).toHaveCount(0)
  await expect(page.locator('[data-connector-hit]')).not.toHaveCount(0)
  await expect(page.locator(`[data-connector-hit][data-parent-id="${fixture.root}"]`)).toHaveCount(
    3,
  )
  await expect(page.locator(`[data-connector-hit][data-parent-id="${fixture.A1}"]`)).toHaveCount(1)
  await expect(page.locator(`[data-connector-hit][data-child-id="${fixture.A2}"]`)).toHaveCount(0)

  await page
    .locator(
      `[data-connector-hit="child-leg"][data-child-id="${fixture.A1}"][aria-label="Insert before this child only"]`,
    )
    .click()
  await expect(page.locator('[data-ui="import-modal-slot"]')).toContainText('before this message')
  await page.locator('[data-role="import-modal-close"]').click()

  await page
    .locator(
      `[data-connector-hit="shared-trunk"][data-parent-id="${fixture.root}"][aria-label="Insert after this parent before all of its children"]`,
    )
    .click()
  await expect(page.locator('[data-ui="import-modal-slot"]')).toContainText(
    'before all of its children',
  )
  await page.locator('[data-ui="import-modal-text"]').fill('shared inserted node')
  await page.getByRole('button', { name: 'Import', exact: true }).click()

  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)
  const databaseName = await activeWorkspaceDatabaseName(page)
  const topology = await page.evaluate(
    async ({ chatId, databaseName }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
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
                (row) => row.chatId === chatId,
              ),
            )
          request.onerror = () => reject(request.error)
        })
      } finally {
        db.close()
      }
    },
    { chatId: fixture.chatId, databaseName },
  )
  const sourceIds = new Set([fixture.root, fixture.A1, fixture.A2, fixture.B1, fixture.B2])
  const inserted = topology.find((row) => typeof row.id === 'string' && !sourceIds.has(row.id))
  expect(inserted?.parentId).toBe(fixture.root)
  expect(topology.find((row) => row.id === fixture.A1)?.parentId).toBe(inserted?.id)
  expect(topology.find((row) => row.id === fixture.B1)?.parentId).toBe(inserted?.id)
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
  const releaseDelete = await holdIndexedDbStoreGate(page, ['messages'])
  const deleteMessage = page.getByRole('button', { name: 'Delete message' })
  try {
    await deleteMessage.click()
    const cancelDelete = page.getByRole('button', { name: 'Cancel conversation update' })
    await expect(cancelDelete).toBeEnabled()
    await expect(page.locator('[data-ui="branch-tree-view"]')).not.toHaveAttribute(
      'aria-busy',
      'true',
    )
    await expect(page.locator('[data-ui="branch-tree-search-input"]')).toBeEnabled()
    await expect(
      page.locator('[data-ui="toast"]').filter({
        hasText: 'Conversation update is already in progress.',
      }),
    ).toHaveCount(0)
    await cancelDelete.click()
  } finally {
    await releaseDelete()
  }
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)
  await expect(
    page.locator('[data-ui="toast"]').filter({ hasText: 'Deleted message.' }),
  ).toHaveCount(0)
  await expect(deleteMessage).toBeEnabled()
  await deleteMessage.click()
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(5)
  const deletedToast = page.locator('[data-ui="toast"]').filter({ hasText: 'Deleted message.' })
  await expect(deletedToast.locator('[data-ui="toast-text"]')).toHaveText('Deleted message.')
  await deletedToast.locator('[data-ui="toast-undo"]').click()
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)

  await page.locator(`[data-ui="branch-tree-node"][data-message-id="${inserted.id}"]`).click()
  await expect(deleteMessage).toBeEnabled()
  await deleteMessage.click()
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(5)
  await expect(
    page.locator('[data-ui="toast"]').filter({
      hasText: 'Conversation update is already in progress.',
    }),
  ).toHaveCount(0)
})

test('every leaf exposes an append target that inserts a child after it', async ({ page }) => {
  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()

  const leafTargets = page.getByRole('button', { name: 'Add message after this leaf' })
  await expect(leafTargets).toHaveCount(2)
  await page.locator(`[data-connector-hit="leaf-append"][data-parent-id="${fixture.A2}"]`).click()
  await expect(page.locator('[data-ui="import-modal"]')).toBeVisible()
  await page.locator('[data-ui="import-modal-text"]').fill('child appended after A2')
  await page.getByRole('button', { name: 'Import', exact: true }).click()

  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)
  await expect(leafTargets).toHaveCount(2)
  const databaseName = await activeWorkspaceDatabaseName(page)
  const inserted = await page.evaluate(
    async ({ chatId, databaseName, sourceIds }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
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
                (row) =>
                  row.chatId === chatId &&
                  typeof row.id === 'string' &&
                  !sourceIds.includes(row.id),
              ),
            )
          request.onerror = () => reject(request.error)
        })
      } finally {
        db.close()
      }
    },
    {
      chatId: fixture.chatId,
      databaseName,
      sourceIds: [fixture.root, fixture.A1, fixture.A2, fixture.B1, fixture.B2],
    },
  )
  expect(inserted?.parentId).toBe(fixture.A2)
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

test('trash deletes an existing imported intermediate node and durably splices its child', async ({
  page,
}) => {
  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()

  await page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.A1}"]`).click()
  await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
    'data-message-id',
    fixture.A1,
  )
  await page.getByRole('button', { name: 'Delete message' }).click()

  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(4)
  await expect
    .poll(async () => {
      const [deleted, child] = await Promise.all([
        readStoredMessage(page, fixture.A1),
        readStoredMessage(page, fixture.A2),
      ])
      return {
        deleted: deleted?.deleted,
        childParentId: child?.parentId,
      }
    })
    .toEqual({
      deleted: true,
      childParentId: fixture.root,
    })
  await expect(
    page.locator('[data-ui="toast"]').filter({ hasText: 'Deleted message.' }),
  ).toBeVisible()
})

test('large imported trash commits directly while an unrelated generation continues', async ({
  page,
}) => {
  let releaseResponse!: () => void
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve
  })
  let markRequestSeen!: () => void
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve
  })
  await page.route('**/api/v1/chat/completions', async (route) => {
    markRequestSeen()
    await responseGate
    await route.fulfill({
      contentType: 'text/event-stream',
      body: buildSseBody([
        { id: 'staged-delete-blocker', content: 'unrelated generation completed' },
        { finish: 'stop' },
      ]),
    })
  })
  const fixture = await seedBranchTreeChat(page, { extraBranchRows: 66 })
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await sendMessage(page, 'hold generation while staged delete waits')
  await requestSeen
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()

  try {
    await page.locator('[data-role="chat-branch-tree"]').click()
    await page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.A1}"]`).click()
    const deleteMessage = page.getByRole('button', { name: 'Delete message' })
    await expect(deleteMessage).toBeEnabled()
    await deleteMessage.click()

    await expect(page.getByRole('button', { name: 'Cancel conversation update' })).toHaveCount(0)
    await expect(
      page.locator('[data-ui="toast"]').filter({ hasText: 'WorkspaceRuntimeReplacementBlocked' }),
    ).toHaveCount(0)
    await expect
      .poll(async () => {
        const [deleted, child] = await Promise.all([
          readStoredMessage(page, fixture.A1),
          readStoredMessage(page, fixture.A2),
        ])
        return {
          deleted: deleted?.deleted,
          childParentId: child?.parentId,
        }
      })
      .toEqual({
        deleted: true,
        childParentId: fixture.root,
      })
    await expect(page.getByRole('button', { name: 'Stop generating' })).toBeVisible()
    await expect(
      page.locator('[data-ui="toast"]').filter({ hasText: 'Deleted message.' }),
    ).toBeVisible()
  } finally {
    releaseResponse()
  }
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
  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  const branchANode = page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.A2}"]`)
  await branchANode.click()

  await expect(page.getByRole('button', { name: 'Regenerate response' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Continue from here' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Branch this chat from here' })).toBeEnabled()

  const hideContext = page.getByRole('button', { name: 'Hide from context (never send to model)' })
  await hideContext.click()
  await expect(page.getByRole('button', { name: 'Show in context (send to model)' })).toBeVisible()
  await expect(branchANode).toHaveAttribute('data-hidden-from-context', 'true')
  await expect(
    page.locator(
      `[data-ui="branch-tree-node"][data-message-id="${fixture.A2}"] [data-ui="branch-tree-node-visibility"]`,
    ),
  ).toBeVisible()
  await expect.poll(() => readStoredMessageHidden(page, fixture.A2)).toBe(true)

  await page.locator('[data-ui="branch-tree-inspector"] [data-ui="reasoning-summary"]').click()
  await page.getByRole('button', { name: 'Hide this reasoning block' }).click()
  await expect(page.getByRole('button', { name: 'Unhide this reasoning block' })).toBeVisible()

  await page.locator('[data-ui="branch-tree-inspector"] [data-ui="tool-evidence-summary"]').click()
  await page.getByRole('button', { name: 'Hide tool call' }).first().click()
  await expect(page.getByRole('button', { name: 'Unhide tool call' })).toBeVisible()

  await page.getByRole('button', { name: 'Show in context (send to model)' }).click()
  await expect(branchANode).not.toHaveAttribute('data-hidden-from-context')
  await page.getByRole('button', { name: 'Unhide this reasoning block' }).click()
  await page.getByRole('button', { name: 'Unhide tool call' }).click()

  const inspector = page.locator('[data-ui="branch-tree-inspector"]')
  await inspector.getByRole('button', { name: 'Edit reasoning details' }).click()
  await inspector
    .getByRole('textbox', { name: 'Edit reasoning details' })
    .fill('Corrected tree inspector reasoning.')
  await inspector.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(
    inspector.locator(
      '[data-ui="reasoning-section"][data-reasoning-kind="text"] [data-ui="reasoning-row-body"]',
    ),
  ).toHaveText('Corrected tree inspector reasoning.')
  await expect
    .poll(() => readStoredReasoningText(page, fixture.A2))
    .toBe('Corrected tree inspector reasoning.')

  await inspector.getByRole('button', { name: 'Edit message' }).click()
  const reasoningAuthoring = inspector.locator('[data-ui="inline-editor-reasoning"]')
  await reasoningAuthoring.locator('summary').click()
  await reasoningAuthoring
    .getByRole('combobox', { name: 'Reasoning block type', exact: true })
    .selectOption('summary')
  await reasoningAuthoring.getByRole('button', { name: 'Add reasoning block' }).click()
  await reasoningAuthoring
    .getByRole('textbox', { name: 'Edit plaintext reasoning' })
    .fill('Additional tree detail.')
  const toolAuthoring = inspector.locator('[data-ui="inline-editor-tool-calls"]')
  await toolAuthoring.locator('summary').click()
  await toolAuthoring
    .getByRole('textbox', { name: 'Edit tool call JSON or text' })
    .first()
    .fill(
      '{"type":"web_search_call","id":"tree-search-1","status":"completed","action":{"type":"search","query":"edited tree query"}}',
    )
  await toolAuthoring.getByRole('button', { name: 'Delete tool call' }).nth(1).click()
  await toolAuthoring.getByRole('button', { name: 'Add tool call' }).click()
  await toolAuthoring
    .getByRole('textbox', { name: 'Edit tool call JSON or text' })
    .nth(1)
    .fill('{"treeAuthored":true}')
  await inspector.locator('[data-ui="attachment-hidden-input"]').setInputFiles({
    name: 'tree-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('tree-authored attachment'),
  })
  await expect(inspector.getByText('tree-evidence.txt')).toBeVisible()
  await inspector.getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(async () => {
      const stored = await readStoredMessage(page, fixture.A2)
      const envelope = stored?.reasoningEnvelope as
        | { visible?: Array<{ kind?: string; text?: string }> }
        | undefined
      return envelope?.visible?.map((part) => `${part.kind}:${part.text}`)
    })
    .toEqual(['summary:Corrected tree inspector reasoning.', 'text:Additional tree detail.'])
  await expect
    .poll(async () => {
      const stored = await readStoredMessage(page, fixture.A2)
      return stored?.providerOutputItems as Array<{ type?: string; item?: unknown }> | undefined
    })
    .toEqual([
      expect.objectContaining({
        type: 'web_search_call',
        edited: true,
        item: expect.objectContaining({ action: { type: 'search', query: 'edited tree query' } }),
      }),
      expect.objectContaining({
        type: 'manual_tool_call',
        edited: true,
        item: { treeAuthored: true },
      }),
    ])
  await expect
    .poll(async () => {
      const stored = await readStoredMessage(page, fixture.A2)
      return Array.isArray(stored?.attachmentRefs) ? stored.attachmentRefs.length : 0
    })
    .toBe(1)

  await page.getByRole('button', { name: 'Continue from here' }).click()
  await expect.poll(() => readStoredMessageText(page, fixture.A2)).toContain('continued from tree')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toContain(`/message/${fixture.B2}`)
  await expect(branchANode).toHaveAttribute('data-selected', 'true')
  await expect(branchANode).not.toHaveAttribute('data-current-leaf')

  await page.getByRole('button', { name: 'Regenerate response' }).click()
  await expect(page.locator('[data-ui="branch-tree-node"]')).toHaveCount(6)
  await expect
    .poll(() => readRegeneratedSiblingText(page, fixture.chatId, fixture.A1, fixture.A2))
    .toContain('continued from tree')
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .not.toContain(`/message/${fixture.B2}`)
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

  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  await page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.A1}"]`).click()
  await page.getByRole('button', { name: 'Edit message' }).click()
  await page
    .locator('[data-ui="branch-tree-inspector"] [data-ui="inline-editor-input"]')
    .fill('edited prompt sent from the tree')
  const inspector = page.locator('[data-ui="branch-tree-inspector"]')
  await inspector.locator('[data-ui="attachment-hidden-input"]').setInputFiles({
    name: 'tree-save-send-evidence.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('tree Save & Send attachment'),
  })
  await expect(inspector.getByText('tree-save-send-evidence.txt')).toBeVisible()
  const saveAndSend = page.getByRole('button', { name: 'Save & Send' })
  await expect(saveAndSend).toBeEnabled()

  let streamTargetId: string | null
  try {
    await saveAndSend.click()
    await requestSeen
    await expect
      .poll(async () => {
        const messages = await readMessages(page, fixture.chatId)
        const editedVariant = messages.find(
          (message) =>
            message.role === 'user' &&
            ((message.content ?? []) as Array<{ text?: string }>)
              .map((item) => item.text ?? '')
              .join('') === 'edited prompt sent from the tree',
        )
        return Array.isArray(editedVariant?.attachmentRefs)
          ? editedVariant.attachmentRefs.length
          : 0
      })
      .toBe(1)
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

  const fixture = await seedBranchTreeChat(page)
  await page.goto(`/#/chat/${fixture.chatId}/message/${fixture.B2}`)
  await page.locator('[data-role="chat-branch-tree"]').click()
  const branchANode = page.locator(`[data-ui="branch-tree-node"][data-message-id="${fixture.A2}"]`)
  await branchANode.click()

  try {
    await page.getByRole('button', { name: 'Continue from here' }).click()
    await requestSeen
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()

    await expect(branchANode).toHaveAttribute('data-selected', 'true')
    await expect(branchANode).not.toHaveAttribute('data-current-leaf')
    await expect(page.locator('[data-ui="branch-tree-inspector"]')).toHaveAttribute(
      'data-message-id',
      fixture.A2,
    )

    await page.locator('[data-ui="branch-tree-inspector"] [data-ui="reasoning-summary"]').click()
    await page
      .locator('[data-ui="branch-tree-inspector"] [data-ui="tool-evidence-summary"]')
      .click()
    await expect(page.getByRole('button', { name: 'Hide this reasoning block' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Hide tool call' }).first()).toBeDisabled()

    await page.getByRole('button', { name: 'Hide from context (never send to model)' }).click()
    await expect(
      page.getByRole('button', { name: 'Show in context (send to model)' }),
    ).toBeVisible()
    await expect.poll(() => readStoredMessageHidden(page, fixture.A2)).toBe(true)

    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(page.locator(`[data-ui="message"][data-message-id="${fixture.B2}"]`)).toBeVisible()
    await expect(page.locator(`[data-ui="message"][data-message-id="${fixture.A2}"]`)).toHaveCount(
      0,
    )
    await expect(page.getByRole('button', { name: 'Stop generating' })).toHaveCount(0)
    await page.locator('[data-role="chat-branch-tree"]').click()
    await expect(branchANode).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('[data-ui="branch-tree-stop"]')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Hide this reasoning block' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Hide tool call' }).first()).toBeDisabled()
  } finally {
    releaseResponse()
  }

  await expect(page.locator('[data-ui="branch-tree-stop"]')).toHaveCount(0)
  await expect.poll(() => readStoredMessageText(page, fixture.A2)).toContain('guarded continuation')
  await waitForMessageGenerationFinished(page, fixture.A2)
  await expect(page.getByRole('button', { name: 'Hide this reasoning block' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Hide tool call' }).first()).toBeEnabled()
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

async function seedBranchTreeChat(
  page: Page,
  options: { readonly extraBranchRows?: number } = {},
): Promise<BranchTreeFixture> {
  const now = Date.now()
  const chatId = 'branch-tree-chat'
  const modelId = 'google/gemini-3.1-flash-lite-preview:free'
  await page.route('https://openrouter.ai/api/v1/models/**/endpoints', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          id: modelId,
          name: modelId,
          context_length: 131_072,
          architecture: {
            tokenizer: 'Gemini',
            input_modalities: ['text'],
            output_modalities: ['text'],
          },
          endpoints: [
            {
              provider_name: 'Natter Test Provider',
              provider_slug: 'natter-test-provider',
              supported_parameters: ['reasoning'],
              context_length: 131_072,
              max_prompt_tokens: 131_072,
              max_completion_tokens: 4096,
              pricing: { prompt: '0', completion: '0' },
              data_policy: {
                training: false,
                trainingOpenRouter: false,
                retainsPrompts: false,
                canPublish: false,
                requiresUserIDs: false,
              },
            },
          ],
        },
      }),
    })
  })
  const sourceMessages: Array<Record<string, unknown>> = [
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
        {
          dialect: 'unknown',
          type: 'obsolete_tree_tool',
          outputIndex: 1,
          item: { obsolete: true },
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
  let parentId = 'A2'
  for (let index = 0; index < (options.extraBranchRows ?? 0); index += 1) {
    const id = `A-extra-${index}`
    const role = index % 2 === 0 ? 'user' : 'assistant'
    sourceMessages.push({
      id,
      chatId,
      parentId,
      siblingIndex: 0,
      turnId: `turn-${id}`,
      turnIndex: index + 3,
      createdAt: now + index + 5,
      role,
      origin: role === 'user' ? 'user' : 'imported',
      content: [
        role === 'user'
          ? { type: 'text', text: `large imported branch user ${index}` }
          : { type: 'output_text', text: `large imported branch assistant ${index}` },
      ],
      nodeVersion: 0,
      deleted: false,
    })
    parentId = id
  }
  const imported = await importPortableChatThroughUi(page, {
    sourceChatId: chatId,
    title: 'Branch tree chat',
    createdAt: now,
    messages: sourceMessages,
    settings: {
      api: 'chat',
      model: modelId,
    },
    captureMessageIds: true,
  })
  if (!imported.messageIdMap) throw new Error('Branch tree fixture message ids were not captured')
  const id = (sourceId: string): string => {
    const importedId = imported.messageIdMap?.[sourceId]
    if (!importedId) throw new Error(`Branch tree fixture message id missing: ${sourceId}`)
    return importedId
  }
  return {
    chatId: imported.chatId,
    root: id('root'),
    A1: id('A1'),
    A2: id('A2'),
    B1: id('B1'),
    B2: id('B2'),
    extraA: Array.from({ length: options.extraBranchRows ?? 0 }, (_, index) =>
      id(`A-extra-${index}`),
    ),
  }
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

async function readStoredReasoningText(page: Page, messageId: string): Promise<string | undefined> {
  const message = await readStoredMessage(page, messageId)
  const envelope = message?.reasoningEnvelope as { visible?: Array<{ text?: string }> } | undefined
  return envelope?.visible?.[0]?.text
}

async function readRegeneratedSiblingText(
  page: Page,
  chatId: string,
  parentId: string,
  originalId: string,
): Promise<string> {
  const messages = await readMessages(page, chatId)
  const regenerated = messages.find(
    (message) => message.parentId === parentId && message.id !== originalId,
  )
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
  const databaseName = await activeWorkspaceDatabaseName(page)
  return page.evaluate(
    async ({ databaseName, id }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName)
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
    },
    { databaseName, id: messageId },
  )
}

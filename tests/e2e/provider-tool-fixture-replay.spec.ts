import { readFileSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { clearIndexedDb, readMessages } from './helpers'

const PROBE_DIR = new URL(
  '../../../plan/direct-provider-server-tools-probes/latest/',
  import.meta.url,
)

interface ProbeRecord {
  response?: { ok?: boolean; body?: Record<string, unknown> }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await clearIndexedDb(page)
  await page.evaluate(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  await page.reload()
})

test('debug fake stream replays OpenAI Responses hosted-tool fixtures through the UI', async ({
  page,
}) => {
  await replayProviderFixture(page, {
    id: 'openai-web-search',
    expectedText: 'platform.openai.com',
    expectedToolTypes: ['web_search_call'],
    expectedInfoLabels: ['web search'],
    expectedPayloadText: 'platform.openai.com/api/docs',
  })
  await replayProviderFixture(page, {
    id: 'openai-code-interpreter',
    expectedText: '55',
    expectedToolTypes: ['code_interpreter_call'],
    expectedInfoLabels: ['code interpreter'],
    expectedPayloadText: '"logs": "55"',
  })
  await replayProviderFixture(page, {
    id: 'openai-shell',
    expectedText: 'natter-shape-probe.',
    expectedToolTypes: ['shell_call', 'shell_call_output'],
    expectedInfoLabels: ['shell', 'shell output'],
    expectedPayloadText: '"stdout": "natter-shape-probe."',
  })
})

test('debug fake stream replays Google native tool fixtures through the UI', async ({ page }) => {
  await replayProviderFixture(page, {
    id: 'google-code-execution',
    expectedText: '55',
    expectedToolTypes: ['google:code_execution'],
    expectedInfoLabels: ['code execution'],
    expectedPayloadText: 'OUTCOME_OK',
  })
})

test('debug fake stream replays Anthropic Messages hosted-tool fixtures through the UI', async ({
  page,
}) => {
  await replayProviderFixture(page, {
    id: 'anthropic-web-search',
    expectedText: 'platform.openai.com',
    expectedToolTypes: ['server_tool_use', 'web_search_tool_result'],
    expectedInfoLabels: ['server tool use', 'web search result'],
    expectedPayloadText: 'platform.openai.com',
  })
  await replayProviderFixture(page, {
    id: 'anthropic-web-fetch',
    expectedText: 'example.com',
    expectedToolTypes: ['server_tool_use', 'web_fetch_tool_result'],
    expectedInfoLabels: ['server tool use', 'web fetch result'],
    expectedPayloadText: 'Example Domain',
  })
  await replayProviderFixture(page, {
    id: 'anthropic-code-execution',
    expectedText: '55',
    expectedToolTypes: ['server_tool_use', 'bash_code_execution_tool_result'],
    expectedInfoLabels: ['server tool use', 'code execution result'],
    expectedPayloadText: '"stdout": "55\\n"',
  })
  await replayProviderFixture(page, {
    id: 'anthropic-advisor',
    expectedText: '2+2 equals 4',
    expectedToolTypes: ['server_tool_use', 'advisor_tool_result'],
    expectedInfoLabels: ['server tool use', 'advisor result'],
    expectedPayloadText: 'advisor_result',
  })
})

test('tool evidence supports per-item visibility and edit/create in the inline editor', async ({
  page,
}) => {
  const result = await startProviderFixture(page, 'openai-shell')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').last()
  const evidence = assistant.locator('[data-ui="tool-evidence"]')
  await evidence.locator('[data-ui="tool-evidence-summary"]').click()

  const firstHide = evidence.locator('[data-ui="tool-evidence-hide"]').first()
  await firstHide.click()
  await expect(evidence.locator('[data-ui="tool-evidence-section"]').first()).toHaveAttribute(
    'data-hidden',
    'true',
  )
  let rows = await readMessages(page, result.chatId)
  let storedAssistant = rows.filter((row) => row.role === 'assistant').at(-1) as
    | { providerOutputItems?: Array<{ hidden?: boolean; edited?: boolean; item?: unknown }> }
    | undefined
  expect(storedAssistant?.providerOutputItems?.[0]?.hidden).toBe(true)

  await firstHide.click()
  await expect(evidence.locator('[data-ui="tool-evidence-section"]').first()).not.toHaveAttribute(
    'data-hidden',
    'true',
  )
  await assistant.locator('[data-action="edit"]').click()
  await assistant.locator('[data-ui="inline-editor-tool-calls"] summary').click()
  await assistant
    .locator('[data-ui="inline-editor-tool-call-input"]')
    .first()
    .fill('{"type":"shell_call","commands":["echo edited-marker"]}')
  await assistant.locator('[data-ui="inline-editor-tool-call-add-button"]').click()
  await assistant.locator('[aria-label="Tool call type"]').last().fill('manual_tool_call')
  await assistant
    .locator('[data-ui="inline-editor-tool-call-input"]')
    .last()
    .fill('{"note":"created-marker"}')
  await assistant.locator('[data-role="save"]').click()

  await expect(evidence).toContainText('edited')
  rows = await readMessages(page, result.chatId)
  storedAssistant = rows.filter((row) => row.role === 'assistant').at(-1)
  expect(storedAssistant?.providerOutputItems?.[0]?.hidden).toBeUndefined()
  expect(storedAssistant?.providerOutputItems?.[0]?.edited).toBe(true)
  expect(JSON.stringify(storedAssistant?.providerOutputItems?.[0]?.item)).toContain('edited-marker')
  expect(storedAssistant?.providerOutputItems?.at(-1)?.edited).toBe(true)
  expect(JSON.stringify(storedAssistant?.providerOutputItems?.at(-1)?.item)).toContain(
    'created-marker',
  )
})

test('tool evidence keeps long stdout horizontally scrollable in narrow layouts', async ({
  page,
}) => {
  await startProviderFixture(page, 'openai-shell')
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await assistant.locator('[data-action="edit"]').click()
  await assistant.locator('[data-ui="inline-editor-tool-calls"] summary').click()
  const longStdout = `LONG_STDOUT_${'x'.repeat(180)}`
  await assistant
    .locator('[data-ui="inline-editor-tool-call-input"]')
    .nth(1)
    .fill(JSON.stringify({ type: 'shell_call_output', stdout: longStdout }))
  await assistant.locator('[data-role="save"]').click()

  await page.setViewportSize({ width: 760, height: 840 })
  const evidence = assistant.locator('[data-ui="tool-evidence"]')
  if (!(await evidence.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await evidence.locator('[data-ui="tool-evidence-summary"]').click()
  }
  await expect(assistant).toHaveCSS('content-visibility', 'visible')

  const stdout = evidence
    .locator('[data-ui="tool-evidence-row-value"]')
    .filter({ hasText: 'LONG_STDOUT_' })
    .first()
  await expect(stdout).toBeVisible()
  const metrics = await stdout.evaluate((node) => {
    const styles = window.getComputedStyle(node)
    const lineHeight = Number.parseFloat(styles.lineHeight)
    const rect = node.getBoundingClientRect()
    return {
      height: rect.height,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      lineHeight: Number.isFinite(lineHeight) ? lineHeight : 0,
      whiteSpace: styles.whiteSpace,
      overflowWrap: styles.overflowWrap,
    }
  })
  expect(metrics.whiteSpace).toBe('pre')
  expect(metrics.overflowWrap).toBe('normal')
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
  expect(metrics.height).toBeLessThanOrEqual(Math.max(40, metrics.lineHeight * 2.2))
})

async function replayProviderFixture(
  page: Page,
  input: {
    id: string
    expectedText: string
    expectedToolTypes: string[]
    expectedInfoLabels: string[]
    expectedPayloadText: string
  },
): Promise<void> {
  const result = await startProviderFixture(page, input.id)

  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText(input.expectedText)
  const evidence = assistant.locator('[data-ui="tool-evidence"]')
  await expect(evidence.locator('[data-ui="tool-evidence-summary"]')).toContainText('Tool results')
  await evidence.locator('[data-ui="tool-evidence-summary"]').click()
  for (const label of input.expectedInfoLabels) {
    await expect(evidence).toContainText(new RegExp(escapeRegExp(label), 'i'))
  }
  await expect(evidence).toContainText(input.expectedPayloadText)

  await assistant.locator('[data-action="info"]').click()
  const info = assistant.locator('[data-ui="message-info"]')
  await expect(info).toContainText('Tool calls')
  for (const label of input.expectedInfoLabels) await expect(info).toContainText(label)
  for (const details of await info.locator('[data-ui="tool-call"]').all())
    await details.evaluate((node) => {
      ;(node as HTMLDetailsElement).open = true
    })
  await expect(info).toContainText(input.expectedPayloadText)

  const rows = await readMessages(page, result.chatId)
  const storedAssistant = rows.filter((row) => row.role === 'assistant').at(-1) as
    | { generation?: { serverTools?: Array<{ type?: string }> } }
    | undefined
  const toolTypes = storedAssistant?.generation?.serverTools?.map((tool) => tool.type) ?? []
  for (const type of input.expectedToolTypes) expect(toolTypes).toContain(type)
}

async function startProviderFixture(page: Page, id: string): Promise<{ chatId: string }> {
  const body = loadProbeBody(id)
  return page.evaluate(
    async ({ body, id }) => {
      const api = (
        window as unknown as {
          __debugFakeStream?: {
            start(options: {
              targetChars: number
              reasoningChars: number
              prompt: string
              providerFixtureChunks: unknown[]
            }): Promise<{ chatId: string }>
          }
        }
      ).__debugFakeStream
      if (!api) throw new Error('__debugFakeStream is not installed')
      return api.start({
        targetChars: 0,
        reasoningChars: 0,
        prompt: `Replay ${id} fixture.`,
        providerFixtureChunks: [
          { type: 'buffered_result', result: body, generationId: body.id ?? body.responseId ?? id },
        ],
      })
    },
    { body, id },
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function loadProbeBody(id: string): Record<string, unknown> {
  const record = JSON.parse(readFileSync(new URL(`${id}.json`, PROBE_DIR), 'utf8')) as ProbeRecord
  expect(record.response?.ok, `${id} live probe should have succeeded`).toBe(true)
  expect(record.response?.body, `${id} live probe should have a JSON response body`).toBeDefined()
  return record.response?.body ?? {}
}

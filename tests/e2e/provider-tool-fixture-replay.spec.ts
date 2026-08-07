import { existsSync, readFileSync } from 'node:fs'
import {
  createFakeStreamScenario,
  type FakeProviderProfileTarget,
  type FakeStreamScenario,
  retargetOnlyProfileToFakeProvider,
} from './fake-stream-provider'
import { expect, type Page, test } from './fixtures'
import {
  clearIndexedDb,
  createChatAndOpen,
  firstChatId,
  readMessages,
  seedFirstRun,
  sendMessage,
  waitForAssistantGenerationFinished,
} from './helpers'

test.describe.configure({ timeout: 60_000 })

const PROBE_DIR = new URL(
  '../../../plan/direct-provider-server-tools-probes/latest/',
  import.meta.url,
)

interface ProbeRecord {
  response?: { ok?: boolean; body?: Record<string, unknown> }
}

const COMPACT_PROBE_BODIES: Record<string, Record<string, unknown>> = {
  'openai-web-search': {
    id: 'resp_web',
    status: 'completed',
    output: [
      {
        id: 'web_1',
        type: 'web_search_call',
        status: 'completed',
        action: {
          type: 'search',
          query: 'OpenAI API docs',
          sources: [{ type: 'url', url: 'https://platform.openai.com/api/docs' }],
        },
      },
      {
        id: 'msg_web',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'platform.openai.com' }],
      },
    ],
  },
  'openai-code-interpreter': {
    id: 'resp_code',
    status: 'completed',
    output: [
      {
        id: 'code_1',
        type: 'code_interpreter_call',
        status: 'completed',
        code: 'sum(i*i for i in range(6))',
        outputs: [{ type: 'logs', logs: '55' }],
      },
      {
        id: 'msg_code',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: '55' }],
      },
    ],
  },
  'openai-shell': {
    id: 'resp_shell',
    status: 'completed',
    output: [
      {
        id: 'shell_1',
        type: 'shell_call',
        status: 'completed',
        call_id: 'call_shell',
        action: { commands: ['printf natter-shape-probe.'] },
      },
      {
        id: 'shell_output_1',
        type: 'shell_call_output',
        status: 'completed',
        call_id: 'call_shell',
        output: [
          { outcome: { type: 'exit', exit_code: 0 }, stderr: '', stdout: 'natter-shape-probe.' },
        ],
      },
      {
        id: 'msg_shell',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'natter-shape-probe.' }],
      },
    ],
  },
  'google-code-execution': {
    responseId: 'gemini_code',
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { executableCode: { language: 'PYTHON', code: 'print(55)' } },
            { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '55\n' } },
            { text: '55' },
          ],
        },
        finishReason: 'STOP',
      },
    ],
  },
  'anthropic-web-search': {
    id: 'msg_web_search',
    type: 'message',
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'server_tool_use',
        id: 'server_web',
        name: 'web_search',
        input: { query: 'OpenAI API docs' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'server_web',
        content: [
          {
            type: 'web_search_result',
            title: 'OpenAI API documentation',
            url: 'https://platform.openai.com/api/docs',
          },
        ],
      },
      { type: 'text', text: 'platform.openai.com' },
    ],
  },
  'anthropic-web-fetch': {
    id: 'msg_web_fetch',
    type: 'message',
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'server_tool_use',
        id: 'server_fetch',
        name: 'web_fetch',
        input: { url: 'https://example.com' },
      },
      {
        type: 'web_fetch_tool_result',
        tool_use_id: 'server_fetch',
        content: {
          type: 'web_fetch_result',
          url: 'https://example.com',
          content: { type: 'document', title: 'Example Domain' },
        },
      },
      { type: 'text', text: 'example.com' },
    ],
  },
  'anthropic-code-execution': {
    id: 'msg_code_execution',
    type: 'message',
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [
      {
        type: 'server_tool_use',
        id: 'server_code',
        name: 'bash_code_execution',
        input: { command: 'printf 55' },
      },
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'server_code',
        content: { type: 'bash_code_execution_result', stdout: '55\n', stderr: '', return_code: 0 },
      },
      { type: 'text', text: '55' },
    ],
  },
  'anthropic-advisor': {
    id: 'msg_advisor',
    type: 'message',
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', id: 'server_advisor', name: 'advisor', input: {} },
      {
        type: 'advisor_tool_result',
        tool_use_id: 'server_advisor',
        content: { type: 'advisor_result', text: '2+2 equals 4' },
      },
      { type: 'text', text: '2+2 equals 4' },
    ],
  },
}

const scenarios = new Set<FakeStreamScenario>()

interface ProviderFixtureExpectation {
  id: string
  expectedText: string
  expectedToolTypes: string[]
  expectedInfoLabels: string[]
  expectedPayloadText: string
}

test.beforeEach(async ({ page }) => {
  await clearIndexedDb(page)
  await page.evaluate(() => {
    window.sessionStorage.clear()
    window.localStorage.clear()
  })
  await page.reload()
})

test.afterEach(async () => {
  await Promise.all([...scenarios].map((scenario) => scenario.dispose()))
  scenarios.clear()
})

test('OpenAI Responses hosted-tool fixtures cross the provider boundary into the UI', async ({
  page,
}) => {
  await replayProviderFixtures(page, [
    {
      id: 'openai-web-search',
      expectedText: 'platform.openai.com',
      expectedToolTypes: ['web_search_call'],
      expectedInfoLabels: ['web search'],
      expectedPayloadText: 'platform.openai.com/api/docs',
    },
    {
      id: 'openai-code-interpreter',
      expectedText: '55',
      expectedToolTypes: ['code_interpreter_call'],
      expectedInfoLabels: ['code interpreter'],
      expectedPayloadText: '"logs": "55"',
    },
    {
      id: 'openai-shell',
      expectedText: 'natter-shape-probe.',
      expectedToolTypes: ['shell_call', 'shell_call_output'],
      expectedInfoLabels: ['shell', 'shell output'],
      expectedPayloadText: '"stdout": "natter-shape-probe."',
    },
  ])
})

test('Google native tool fixtures cross the provider boundary into the UI', async ({ page }) => {
  await replayProviderFixtures(page, [
    {
      id: 'google-code-execution',
      expectedText: '55',
      expectedToolTypes: ['google:code_execution'],
      expectedInfoLabels: ['code execution'],
      expectedPayloadText: 'OUTCOME_OK',
    },
  ])
})

test('Anthropic Messages hosted-tool fixtures cross the provider boundary into the UI', async ({
  page,
}) => {
  await replayProviderFixtures(page, [
    {
      id: 'anthropic-web-search',
      expectedText: 'platform.openai.com',
      expectedToolTypes: ['server_tool_use', 'web_search_tool_result'],
      expectedInfoLabels: ['server tool use', 'web search result'],
      expectedPayloadText: 'platform.openai.com',
    },
    {
      id: 'anthropic-web-fetch',
      expectedText: 'example.com',
      expectedToolTypes: ['server_tool_use', 'web_fetch_tool_result'],
      expectedInfoLabels: ['server tool use', 'web fetch result'],
      expectedPayloadText: 'Example Domain',
    },
    {
      id: 'anthropic-code-execution',
      expectedText: '55',
      expectedToolTypes: ['server_tool_use', 'bash_code_execution_tool_result'],
      expectedInfoLabels: ['server tool use', 'code execution result'],
      expectedPayloadText: '"stdout": "55\\n"',
    },
    {
      id: 'anthropic-advisor',
      expectedText: '2+2 equals 4',
      expectedToolTypes: ['server_tool_use', 'advisor_tool_result'],
      expectedInfoLabels: ['server tool use', 'advisor result'],
      expectedPayloadText: 'advisor_result',
    },
  ])
})

test('tool evidence supports per-item visibility and assistant Edit authors provider output', async ({
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
  rows = await readMessages(page, result.chatId)
  storedAssistant = rows.filter((row) => row.role === 'assistant').at(-1)
  expect(storedAssistant?.providerOutputItems?.[0]?.hidden).toBeUndefined()
  const providerOutputBeforeEdit = structuredClone(storedAssistant?.providerOutputItems)
  await assistant.locator('[data-action="edit"]').click()
  const toolAuthoring = assistant.locator('[data-ui="inline-editor-tool-calls"]')
  await expect(toolAuthoring).toHaveCount(1)
  await toolAuthoring.locator('summary').click()
  await toolAuthoring
    .getByRole('textbox', { name: 'Edit tool call JSON or text' })
    .first()
    .fill('{"editedFromProviderFixture":true}')
  await assistant.locator('[data-ui="inline-editor-input"]').fill('provider-output edit')
  await assistant.locator('[data-role="save"]').click()

  await expect(assistant.locator('[data-ui="message-body"]')).toContainText('provider-output edit')
  rows = await readMessages(page, result.chatId)
  storedAssistant = rows.filter((row) => row.role === 'assistant').at(-1)
  expect(storedAssistant?.providerOutputItems?.[0]).toEqual({
    ...providerOutputBeforeEdit?.[0],
    edited: true,
    item: { editedFromProviderFixture: true },
  })
  expect(storedAssistant?.providerOutputItems?.slice(1)).toEqual(providerOutputBeforeEdit?.slice(1))
})

test('tool evidence keeps long stdout horizontally scrollable in narrow layouts', async ({
  page,
}) => {
  const longStdout = `LONG_STDOUT_${'x'.repeat(180)}`
  const body = loadProbeBody('openai-shell')
  const shellOutput = (body.output as Array<Record<string, unknown>>).find(
    (item) => item.type === 'shell_call_output',
  )
  const outputRows = shellOutput?.output as Array<Record<string, unknown>> | undefined
  if (!outputRows?.[0]) throw new Error('OpenAI shell fixture output missing')
  outputRows[0].stdout = longStdout
  await startProviderFixture(page, 'openai-shell', body)
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').last()

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

async function replayProviderFixtures(
  page: Page,
  inputs: ProviderFixtureExpectation[],
): Promise<void> {
  const transports = inputs.map((input) => fixtureTransport(input.id))
  const transport = transports[0]
  if (!transport) return
  for (const candidate of transports) expect(candidate).toEqual(transport)
  const scenario = await createFakeStreamScenario({
    responses: inputs.map((input) => ({
      method: 'POST',
      path: transport.path,
      json: loadProbeBody(input.id),
    })),
  })
  scenarios.add(scenario)
  await clearIndexedDb(page)
  await seedFirstRun(page, { model: transport.profile.model })
  await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl, transport.profile)
  await scenario.snapshot()

  for (const [index, input] of inputs.entries()) {
    await createChatAndOpen(page)
    await sendMessage(page, `Replay ${input.id} fixture.`)
    await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(index + 1)
    const chatId = await firstChatId(page)
    expect(chatId).not.toBe('')
    await waitForAssistantGenerationFinished(page, chatId)
    await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
    await expect.poll(async () => (await scenario.snapshot()).activeStreams).toBe(0)
    const snapshot = await scenario.snapshot()
    expect(
      snapshot.requests.filter(
        (request) => request.method === 'POST' && request.path === transport.path,
      ),
    ).toHaveLength(index + 1)
    await assertProviderFixture(page, input, chatId)
  }
}

async function assertProviderFixture(
  page: Page,
  input: ProviderFixtureExpectation,
  chatId: string,
): Promise<void> {
  const assistant = page.locator('[data-ui="message"][data-role="assistant"]').last()
  await expect(assistant.locator('[data-ui="message-body"]')).toContainText(input.expectedText)
  const evidence = assistant.locator('[data-ui="tool-evidence"]')
  await expect(evidence.locator('[data-ui="tool-evidence-summary"]')).toContainText('Tool results')
  await evidence.locator('[data-ui="tool-evidence-summary"]').click()
  for (const label of input.expectedInfoLabels) {
    await expect(evidence).toContainText(new RegExp(escapeRegExp(label), 'i'))
  }
  for (const raw of await evidence.locator('[data-ui="tool-evidence-raw"]').all()) {
    await raw.locator('summary').click()
  }
  await expect(evidence).toContainText(input.expectedPayloadText)

  await assistant.locator('[data-action="info"]').click()
  const info = assistant.locator('[data-ui="message-info"]')
  await expect(info).toContainText('Tool calls')
  for (const label of input.expectedInfoLabels) await expect(info).toContainText(label)
  await expect(info.locator('[data-ui="tool-call"]').first()).toBeVisible()

  const rows = await readMessages(page, chatId)
  const storedAssistant = rows.filter((row) => row.role === 'assistant').at(-1) as
    | { generation?: { serverTools?: Array<{ type?: string }> } }
    | undefined
  const toolTypes = storedAssistant?.generation?.serverTools?.map((tool) => tool.type) ?? []
  for (const type of input.expectedToolTypes) expect(toolTypes).toContain(type)
}

async function startProviderFixture(
  page: Page,
  id: string,
  body = loadProbeBody(id),
): Promise<{ chatId: string }> {
  const transport = fixtureTransport(id)
  const scenario = await createFakeStreamScenario({
    responses: [{ method: 'POST', path: transport.path, json: body }],
  })
  scenarios.add(scenario)
  await clearIndexedDb(page)
  await seedFirstRun(page, { model: transport.profile.model })
  await retargetOnlyProfileToFakeProvider(page, scenario.providerBaseUrl, transport.profile)
  await scenario.snapshot()
  await createChatAndOpen(page)
  await sendMessage(page, `Replay ${id} fixture.`)
  await expect(page.locator('[data-ui="chat-row"]')).toHaveCount(1)
  const chatId = await firstChatId(page)
  expect(chatId).not.toBe('')
  await waitForAssistantGenerationFinished(page, chatId)
  await expect(page.locator('[data-ui="abort"]')).toHaveCount(0)
  await expect.poll(async () => (await scenario.snapshot()).activeStreams).toBe(0)
  const snapshot = await scenario.snapshot()
  expect(
    snapshot.requests.filter(
      (request) => request.method === 'POST' && request.path === transport.path,
    ),
  ).toHaveLength(1)
  return { chatId }
}

function fixtureTransport(id: string): {
  path: string
  profile: Required<Pick<FakeProviderProfileTarget, 'kind' | 'api' | 'model'>>
} {
  if (id.startsWith('openai-')) {
    return {
      path: '/responses',
      profile: {
        kind: 'openai-compatible',
        api: 'responses',
        model: 'openai/gpt-5.4',
      },
    }
  }
  if (id.startsWith('google-')) {
    return {
      path: '/models/gemini-3.1-flash-lite-preview:streamGenerateContent',
      profile: {
        kind: 'google',
        api: 'gemini-native',
        model: 'google/gemini-3.1-flash-lite-preview',
      },
    }
  }
  if (id.startsWith('anthropic-')) {
    return {
      path: '/messages',
      profile: {
        kind: 'anthropic',
        api: 'anthropic-messages',
        model: 'anthropic/claude-sonnet-4.6',
      },
    }
  }
  throw new Error(`unknown provider fixture transport: ${id}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function loadProbeBody(id: string): Record<string, unknown> {
  const localPath = new URL(`${id}.json`, PROBE_DIR)
  if (process.env.NATTER_COMPACT_FIXTURES !== '1' && existsSync(localPath)) {
    const record = JSON.parse(readFileSync(localPath, 'utf8')) as ProbeRecord
    expect(record.response?.ok, `${id} live probe should have succeeded`).toBe(true)
    expect(record.response?.body, `${id} live probe should have a JSON response body`).toBeDefined()
    return record.response?.body ?? {}
  }
  const compact = COMPACT_PROBE_BODIES[id]
  if (!compact) throw new Error(`unknown compact provider fixture: ${id}`)
  return structuredClone(compact)
}

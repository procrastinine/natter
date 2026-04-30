import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const outDir = resolve(repoRoot, 'plan', 'direct-provider-server-tools-probes', 'latest')
const keysPath = resolve(repoRoot, 'keys.json')

const onlyCaseIds = new Set(process.argv.slice(2))
const cases = []
const previousCasesById = new Map()

function keys() {
  try {
    return JSON.parse(readFileSync(keysPath, 'utf8'))
  } catch {
    return {}
  }
}

async function main() {
  await mkdir(outDir, { recursive: true })
  if (onlyCaseIds.size > 0) readPreviousManifest()
  const keyMap = keys()
  await runOpenAiCases(keyMap.openai)
  await runGoogleCases(keyMap.google)
  await runAnthropicCases(keyMap.anthropic)
  await runContextCases(keyMap)
  const manifestCases =
    onlyCaseIds.size > 0 ? [...previousCasesById.values(), ...cases] : [...cases]
  await writeJson('manifest.json', {
    generatedAt: new Date().toISOString(),
    note: 'Raw cheap provider-hosted tool probes. Request headers and API keys are intentionally omitted.',
    cases: manifestCases,
  })
  console.log(`wrote ${cases.length} probe records to ${outDir}`)
}

async function runOpenAiCases(apiKey) {
  const model = 'gpt-5.4-nano'
  if (shouldRun('openai-web-search')) {
    await runOpenAi(apiKey, 'openai-web-search', {
      model,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Use web search. In one short sentence, name the official OpenAI API docs domain.',
            },
          ],
        },
      ],
      tools: [{ type: 'web_search', search_context_size: 'low' }],
      tool_choice: 'auto',
      max_output_tokens: 120,
      store: false,
      include: ['web_search_call.action.sources'],
    })
  }

  if (shouldRun('openai-code-interpreter')) {
    await runOpenAi(apiKey, 'openai-code-interpreter', {
      model,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Use code interpreter to compute sum(i*i for i in range(6)). Reply with only the number.',
            },
          ],
        },
      ],
      tools: [{ type: 'code_interpreter', container: { type: 'auto' } }],
      tool_choice: 'auto',
      max_output_tokens: 120,
      store: false,
      include: ['code_interpreter_call.outputs'],
    })
  }

  if (shouldRun('openai-shell')) {
    await runOpenAi(apiKey, 'openai-shell', {
      model,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Use shell to run: printf natter-shape-probe. Reply with the exact output.',
            },
          ],
        },
      ],
      tools: [
        {
          type: 'shell',
          environment: { type: 'container_auto', network_policy: { type: 'disabled' } },
        },
      ],
      tool_choice: 'auto',
      max_output_tokens: 120,
      store: false,
    })
  }

  if (shouldRun('openai-image-generation')) {
    previousCasesById.delete('openai-image-generation')
    cases.push({
      id: 'openai-image-generation',
      provider: 'openai',
      status: 'skipped',
      reason: 'Skipped intentionally to keep this probe pass cheap; image tool output is already covered by existing generated-media materialization tests.',
    })
  }
}

async function runGoogleCases(apiKey) {
  const model = 'gemini-3.1-flash-lite-preview'
  if (shouldRun('google-search')) {
    await runGoogle(apiKey, 'google-search', model, {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Use Google Search. In one short sentence, name the official OpenAI API docs domain.',
            },
          ],
        },
      ],
      tools: [{ googleSearch: {} }],
      generationConfig: { maxOutputTokens: 120 },
    })
  }

  if (shouldRun('google-url-context')) {
    await runGoogle(apiKey, 'google-url-context', model, {
      contents: [
        {
          role: 'user',
          parts: [{ text: 'Use URL context to summarize https://example.com in one sentence.' }],
        },
      ],
      tools: [{ urlContext: {} }],
      generationConfig: { maxOutputTokens: 120 },
    })
  }

  if (shouldRun('google-code-execution')) {
    await runGoogle(apiKey, 'google-code-execution', model, {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: 'Use code execution to compute sum(i*i for i in range(6)). Reply with only the number.',
            },
          ],
        },
      ],
      tools: [{ codeExecution: {} }],
      generationConfig: { maxOutputTokens: 120 },
    })
  }
}

async function runAnthropicCases(apiKey) {
  const model = 'claude-haiku-4-5'
  if (shouldRun('anthropic-basic-messages')) {
    await runAnthropic(apiKey, 'anthropic-basic-messages', {
      model,
      max_tokens: 40,
      messages: [
        {
          role: 'user',
          content: 'Reply with exactly: natter-anthropic-ok',
        },
      ],
    })
  }

  if (shouldRun('anthropic-web-search')) {
    await runAnthropic(apiKey, 'anthropic-web-search', {
      model,
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content:
            'Use web search. In one short sentence, name the official OpenAI API docs domain.',
        },
      ],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    })
  }

  if (shouldRun('anthropic-web-fetch')) {
    await runAnthropic(apiKey, 'anthropic-web-fetch', {
      model,
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: 'Use web fetch to read https://example.com. Reply with the page domain only.',
        },
      ],
      tools: [
        {
          type: 'web_fetch_20250910',
          name: 'web_fetch',
          max_uses: 1,
          citations: { enabled: true },
          max_content_tokens: 2000,
        },
      ],
    })
  }

  if (shouldRun('anthropic-code-execution')) {
    await runAnthropic(apiKey, 'anthropic-code-execution', {
      model: 'claude-sonnet-4-5',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content:
            'Use code execution to compute sum(i*i for i in range(6)). Reply with only the number.',
        },
      ],
      tools: [{ type: 'code_execution_20250825', name: 'code_execution' }],
    })
  }

  if (shouldRun('anthropic-advisor')) {
    await runAnthropic(apiKey, 'anthropic-advisor', {
      model: 'claude-sonnet-4-6',
      max_tokens: 120,
      messages: [
        {
          role: 'user',
          content: 'Use the advisor tool. In one short sentence, say whether 2+2 equals 4.',
        },
      ],
      tools: [{ type: 'advisor_20260301', name: 'advisor', model: 'claude-opus-4-7' }],
    })
  }
}

async function runContextCases(keyMap) {
  const openAiModel = 'gpt-5.4-nano'
  const googleModel = 'gemini-3.1-flash-lite-preview'
  const openAiCode = savedBody('openai-code-interpreter')
  const openAiShell = savedBody('openai-shell')
  const googleCode = savedBody('google-code-execution')
  const anthropicSearch = savedBody('anthropic-web-search')

  if (shouldRun('openai-code-interpreter-context-native')) {
    await runOpenAi(keyMap.openai, 'openai-code-interpreter-context-native', {
      model: openAiModel,
      input: [
        ...(openAiCode?.output ?? []),
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Using only the previous code interpreter call result in this conversation, reply with just the logged number.',
            },
          ],
        },
      ],
      max_output_tokens: 80,
      store: false,
    })
  }

  if (shouldRun('openai-code-interpreter-context-edited-native')) {
    const editedOutput = editedOpenAiNativeOutput(openAiCode)
    if (!editedOutput) {
      await recordSkipped(
        'openai-code-interpreter-context-edited-native',
        'openai',
        'openai-code-interpreter output missing',
      )
    } else {
      await runOpenAi(keyMap.openai, 'openai-code-interpreter-context-edited-native', {
        model: openAiModel,
        input: [
          ...editedOutput,
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'Using only the previous edited code interpreter call result in this conversation, reply with just the logged number.',
              },
            ],
          },
        ],
        max_output_tokens: 80,
        store: false,
      })
    }
  }

  if (shouldRun('openai-code-interpreter-context-edited-text')) {
    await runOpenAi(keyMap.openai, 'openai-code-interpreter-context-edited-text', {
      model: openAiModel,
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: `55\n\n${openAiCodeTextFallback(openAiCode, { edited: true })}`,
            },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Using only the edited tool_call block above, reply with just the code interpreter output number.',
            },
          ],
        },
      ],
      max_output_tokens: 80,
      store: false,
    })
  }

  if (shouldRun('openai-shell-context-native')) {
    await runOpenAi(keyMap.openai, 'openai-shell-context-native', {
      model: openAiModel,
      input: [
        ...(openAiShell?.output ?? []),
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Using only the previous shell output in this conversation, reply with the exact stdout.',
            },
          ],
        },
      ],
      max_output_tokens: 80,
      store: false,
    })
  }

  if (shouldRun('google-code-execution-context-native')) {
    await runGoogle(keyMap.google, 'google-code-execution-context-native', googleModel, {
      contents: [
        ...(googleCode?.candidates?.[0]?.content
          ? [
              {
                role: 'model',
                parts: googleCode.candidates[0].content.parts,
              },
            ]
          : []),
        {
          role: 'user',
          parts: [
            {
              text: 'Using only the previous code execution result in this conversation, reply with just the number.',
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 80 },
    })
  }

  if (shouldRun('openai-google-code-context-text')) {
    await runOpenAi(keyMap.openai, 'openai-google-code-context-text', {
      model: openAiModel,
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: `55\n\n${googleCodeTextFallback(googleCode)}`,
            },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Using only the tool evidence above, reply with just the code execution output number.',
            },
          ],
        },
      ],
      max_output_tokens: 80,
      store: false,
    })
  }

  if (shouldRun('google-openai-shell-context-text')) {
    await runGoogle(keyMap.google, 'google-openai-shell-context-text', googleModel, {
      contents: [
        {
          role: 'model',
          parts: [{ text: `natter-shape-probe.\n\n${openAiShellTextFallback(openAiShell)}` }],
        },
        {
          role: 'user',
          parts: [
            {
              text: 'Using only the tool evidence above, reply with the exact shell stdout.',
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 80 },
    })
  }

  if (shouldRun('anthropic-web-search-context-native')) {
    const record = savedRecord('anthropic-web-search')
    const response = record?.response?.body
    const previousUser = record?.request?.messages?.[0]
    if (!Array.isArray(response?.content) || !previousUser) {
      await recordSkipped(
        'anthropic-web-search-context-native',
        'anthropic',
        'anthropic-web-search output missing',
      )
    } else {
      await runAnthropic(keyMap.anthropic, 'anthropic-web-search-context-native', {
        model: 'claude-haiku-4-5',
        max_tokens: 80,
        messages: [
          previousUser,
          { role: 'assistant', content: response.content },
          {
            role: 'user',
            content:
              'Using only the previous web search result in this conversation, reply with just the official docs domain.',
          },
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      })
    }
  }

  if (shouldRun('anthropic-openai-code-context-text')) {
    await runAnthropic(keyMap.anthropic, 'anthropic-openai-code-context-text', {
      model: 'claude-haiku-4-5',
      max_tokens: 80,
      messages: [
        { role: 'user', content: 'The previous assistant tool evidence follows.' },
        {
          role: 'assistant',
          content: `55\n\n${openAiCodeTextFallback(openAiCode)}`,
        },
        {
          role: 'user',
          content:
            'Using only the tool_call block above, reply with just the code interpreter output number.',
        },
      ],
    })
  }

  if (shouldRun('anthropic-google-code-context-text')) {
    await runAnthropic(keyMap.anthropic, 'anthropic-google-code-context-text', {
      model: 'claude-haiku-4-5',
      max_tokens: 80,
      messages: [
        { role: 'user', content: 'The previous assistant tool evidence follows.' },
        {
          role: 'assistant',
          content: `55\n\n${googleCodeTextFallback(googleCode)}`,
        },
        {
          role: 'user',
          content:
            'Using only the tool_call block above, reply with just the code execution output number.',
        },
      ],
    })
  }

  if (shouldRun('openai-anthropic-web-context-text')) {
    await runOpenAi(keyMap.openai, 'openai-anthropic-web-context-text', {
      model: openAiModel,
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: anthropicWebTextFallback(anthropicSearch),
            },
          ],
        },
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Using only the Anthropic tool evidence above, reply with just the official docs domain.',
            },
          ],
        },
      ],
      max_output_tokens: 80,
      store: false,
    })
  }

  if (shouldRun('google-anthropic-web-context-text')) {
    await runGoogle(keyMap.google, 'google-anthropic-web-context-text', googleModel, {
      contents: [
        {
          role: 'model',
          parts: [{ text: anthropicWebTextFallback(anthropicSearch) }],
        },
        {
          role: 'user',
          parts: [
            {
              text: 'Using only the Anthropic tool evidence above, reply with just the official docs domain.',
            },
          ],
        },
      ],
      generationConfig: { maxOutputTokens: 80 },
    })
  }
}

async function runOpenAi(apiKey, id, requestBody) {
  if (!apiKey) {
    await recordSkipped(id, 'openai', 'keys.json missing openai')
    return
  }
  await runJsonCase({
    id,
    provider: 'openai',
    url: 'https://api.openai.com/v1/responses',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    requestBody,
    summarize: summarizeOpenAi,
  })
}

async function runGoogle(apiKey, id, model, requestBody) {
  if (!apiKey) {
    await recordSkipped(id, 'google', 'keys.json missing google')
    return
  }
  await runJsonCase({
    id,
    provider: 'google',
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    requestBody,
    summarize: summarizeGoogle,
  })
}

async function runAnthropic(apiKey, id, requestBody) {
  if (!apiKey) {
    await recordSkipped(id, 'anthropic', 'keys.json missing anthropic')
    return
  }
  await runJsonCase({
    id,
    provider: 'anthropic',
    url: 'https://api.anthropic.com/v1/messages',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      ...(anthropicBetaHeader(requestBody)
        ? { 'anthropic-beta': anthropicBetaHeader(requestBody) }
        : {}),
      'Content-Type': 'application/json',
    },
    requestBody,
    summarize: summarizeAnthropic,
  })
}

async function runJsonCase({ id, provider, url, headers, requestBody, summarize }) {
  const startedAt = new Date().toISOString()
  const response = await postJson(url, headers, requestBody)
  const record = {
    id,
    provider,
    startedAt,
    completedAt: new Date().toISOString(),
    request: redactRequest(requestBody),
    response,
    summary: summarize(response.body),
  }
  await writeJson(`${id}.json`, record)
  previousCasesById.delete(id)
  cases.push({
    id,
    provider,
    status: response.ok ? 'ok' : 'error',
    httpStatus: response.status,
    file: `${id}.json`,
    summary: record.summary,
  })
}

async function recordSkipped(id, provider, reason) {
  const record = { id, provider, status: 'skipped', reason }
  await writeJson(`${id}.json`, record)
  previousCasesById.delete(id)
  cases.push({ ...record, file: `${id}.json` })
}

function shouldRun(id) {
  return onlyCaseIds.size === 0 || onlyCaseIds.has(id)
}

function readPreviousManifest() {
  try {
    const manifest = JSON.parse(readFileSync(resolve(outDir, 'manifest.json'), 'utf8'))
    for (const entry of manifest.cases ?? []) {
      if (entry && typeof entry.id === 'string') previousCasesById.set(entry.id, entry)
    }
  } catch {}
}

function savedBody(id) {
  try {
    const record = JSON.parse(readFileSync(resolve(outDir, `${id}.json`), 'utf8'))
    return record.response?.body
  } catch {
    return undefined
  }
}

function savedRecord(id) {
  try {
    return JSON.parse(readFileSync(resolve(outDir, `${id}.json`), 'utf8'))
  } catch {
    return undefined
  }
}

function anthropicBetaHeader(requestBody) {
  const betas = new Set()
  for (const tool of requestBody?.tools ?? []) {
    if (tool?.type === 'web_fetch_20250910') betas.add('web-fetch-2025-09-10')
    if (tool?.type === 'code_execution_20250825') betas.add('code-execution-2025-08-25')
    if (tool?.type === 'advisor_20260301') betas.add('advisor-tool-2026-03-01')
  }
  return betas.size > 0 ? [...betas].join(',') : undefined
}

async function postJson(url, headers, body) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: selectedHeaders(response.headers),
      body: parseBody(text),
    }
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : String(error),
      headers: {},
      body: { error: error instanceof Error ? error.message : String(error) },
    }
  } finally {
    clearTimeout(timeout)
  }
}

function selectedHeaders(headers) {
  const out = {}
  for (const key of [
    'content-type',
    'openai-organization',
    'openai-processing-ms',
    'request-id',
    'x-request-id',
    'anthropic-request-id',
  ]) {
    const value = headers.get(key)
    if (value) out[key] = value
  }
  return out
}

function parseBody(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { rawText: text }
  }
}

function redactRequest(body) {
  return JSON.parse(JSON.stringify(body))
}

async function writeJson(name, value) {
  await writeFile(resolve(outDir, name), `${JSON.stringify(value, null, 2)}\n`)
}

function summarizeOpenAi(body) {
  if (body?.error) return { error: body.error }
  const output = Array.isArray(body?.output) ? body.output : []
  return {
    outputTypes: output.map((item) => item?.type).filter(Boolean),
    toolItems: output
      .filter((item) => typeof item?.type === 'string' && item.type.endsWith('_call'))
      .map((item) => ({
        type: item.type,
        id: item.id,
        status: item.status,
        keys: Object.keys(item).sort(),
      })),
    messageTextPreview: extractOpenAiText(output).slice(0, 240),
    textContainsExpected:
      /55|natter-shape-probe/u.test(extractOpenAiText(output)) ||
      /platform\.openai\.com/u.test(extractOpenAiText(output)),
    usage: body?.usage,
  }
}

function summarizeGoogle(body) {
  if (body?.error) return { error: body.error }
  const candidate = body?.candidates?.[0]
  const parts = candidate?.content?.parts ?? []
  const topKeys = Object.keys(body ?? {}).sort()
  return {
    topKeys,
    finishReason: candidate?.finishReason,
    metadataKeys: topKeys.filter((key) => key.endsWith('Metadata')),
    partKinds: parts.map((part) => Object.keys(part).filter((key) => key !== 'thoughtSignature')),
    textPreview: parts
      .filter((part) => typeof part.text === 'string' && part.thought !== true)
      .map((part) => part.text)
      .join('')
      .slice(0, 240),
    textContainsExpected:
      /55|natter-shape-probe/u.test(
        parts
          .filter((part) => typeof part.text === 'string' && part.thought !== true)
          .map((part) => part.text)
          .join(''),
      ) || /platform\.openai\.com/u.test(JSON.stringify(body)),
    usage: body?.usageMetadata,
  }
}

function summarizeAnthropic(body) {
  if (body?.error) return { error: body.error }
  const content = Array.isArray(body?.content) ? body.content : []
  return {
    stopReason: body?.stop_reason,
    contentTypes: content.map((item) => item?.type).filter(Boolean),
    toolItems: content
      .filter((item) => typeof item?.type === 'string' && item.type.includes('tool'))
      .map((item) => ({ type: item.type, id: item.id, name: item.name, keys: Object.keys(item) })),
    textPreview: content
      .filter((item) => typeof item.text === 'string')
      .map((item) => item.text)
      .join('')
      .slice(0, 240),
    textContainsExpected:
      /55|natter-anthropic-ok|example\.com|2\+2 equals 4/u.test(
        content
          .filter((item) => typeof item.text === 'string')
          .map((item) => item.text)
          .join(''),
      ) || /platform\.openai\.com/u.test(JSON.stringify(body)),
    usage: body?.usage,
  }
}

function extractOpenAiText(output) {
  let text = ''
  for (const item of output) {
    for (const content of item?.content ?? []) {
      if (typeof content?.text === 'string') text += content.text
    }
  }
  return text
}

function googleCodeTextFallback(body) {
  const parts = body?.candidates?.[0]?.content?.parts ?? []
  const rows = ['<tool_call>', 'Tool: Code execution', 'Dialect: google-gemini', 'Type: google:code_execution']
  for (const part of parts) {
    if (part.executableCode) rows.push(`Code: ${part.executableCode.code ?? ''}`)
    if (part.codeExecutionResult) {
      rows.push(`Outcome: ${part.codeExecutionResult.outcome ?? ''}`)
      rows.push(`Output: ${part.codeExecutionResult.output ?? ''}`)
    }
  }
  rows.push('</tool_call>')
  return rows.join('\n')
}

function openAiShellTextFallback(body) {
  const output = body?.output ?? []
  const rows = ['<tool_call>', 'Tool: Shell output', 'Dialect: openai-responses', 'Type: shell_call_output']
  for (const item of output) {
    if (item.type !== 'shell_call_output') continue
    for (const row of item.output ?? []) {
      rows.push(`Stdout: ${row.stdout ?? ''}`)
      if (row.stderr) rows.push(`Stderr: ${row.stderr}`)
      if (row.outcome) rows.push(`Outcome: ${JSON.stringify(row.outcome)}`)
    }
  }
  rows.push('</tool_call>')
  return rows.join('\n')
}

function openAiCodeTextFallback(body, opts = {}) {
  const output = body?.output ?? []
  const rows = [
    '<tool_call>',
    'Tool: Code interpreter',
    'Dialect: openai-responses',
    'Type: code_interpreter_call',
  ]
  if (opts.edited) rows.push('Edited: true')
  for (const item of output) {
    if (item.type !== 'code_interpreter_call') continue
    if (item.code) rows.push(`Code: ${item.code}`)
    for (const row of item.outputs ?? []) {
      if (row.logs) rows.push(`Logs: ${row.logs}`)
      if (row.text) rows.push(`Text: ${row.text}`)
      if (row.output) rows.push(`Output: ${row.output}`)
    }
  }
  rows.push('</tool_call>')
  return rows.join('\n')
}

function anthropicWebTextFallback(body) {
  const content = Array.isArray(body?.content) ? body.content : []
  const rows = [
    '<tool_call>',
    'Tool: Anthropic web search',
    'Dialect: anthropic-claude',
    'Type: server_tool_use/web_search_tool_result',
  ]
  for (const item of content) {
    if (item?.type === 'server_tool_use') {
      rows.push(`Name: ${item.name ?? ''}`)
      rows.push(`Input: ${JSON.stringify(item.input ?? {})}`)
    }
    if (item?.type === 'web_search_tool_result') {
      rows.push(`Content: ${JSON.stringify(item.content ?? item).slice(0, 4000)}`)
    }
    if (typeof item?.text === 'string') rows.push(`Text: ${item.text}`)
  }
  rows.push('</tool_call>')
  return rows.join('\n')
}

function editedOpenAiNativeOutput(body) {
  const output = body?.output
  if (!Array.isArray(output)) return null
  const cloned = JSON.parse(JSON.stringify(output))
  const item = cloned.find((entry) => entry?.type === 'code_interpreter_call')
  if (!item) return null
  item.natter_edited_marker = true
  return cloned
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

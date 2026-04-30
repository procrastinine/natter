import type { GenerationServerToolCall, Message, ProviderOutputItem } from './types'

export type ProviderToolContextTarget =
  | 'openai-responses'
  | 'openrouter-responses'
  | 'google-gemini'
  | 'anthropic-claude'
  | 'text'

export interface ToolEvidenceSection {
  key: string
  itemIndex: number
  label: string
  badge?: string | undefined
  dialect: ProviderOutputItem['dialect']
  hidden: boolean
  edited: boolean
  rows: Array<{ label: string; value: string }>
  sources?: string[] | undefined
  raw?: unknown
}

type ToolEvidenceSectionBase = Omit<
  ToolEvidenceSection,
  'itemIndex' | 'dialect' | 'hidden' | 'edited'
>

export interface ProviderToolContextOptions {
  includeToolCalls?: boolean | undefined
}

const OPENAI_RESPONSES_CONTEXT_TYPES = new Set([
  'web_search_call',
  'file_search_call',
  'image_generation_call',
  'code_interpreter_call',
  'shell_call',
  'shell_call_output',
  'computer_call',
  'mcp_tool_call',
  'mcp_call',
])

export function providerOutputItemsForMessage(message: Message): ProviderOutputItem[] {
  return structuredClone(message.providerOutputItems ?? [])
}

export function providerOutputItemsFromServerTools(
  tools: readonly GenerationServerToolCall[],
): ProviderOutputItem[] {
  const out: ProviderOutputItem[] = []
  for (const [index, tool] of tools.entries()) {
    const item = providerOutputItemFromServerTool(tool, index)
    if (item) out.push(item)
  }
  return out
}

export function providerOutputItemFromResponsesItem(
  item: unknown,
  outputIndex?: number,
): ProviderOutputItem | null {
  if (!item || typeof item !== 'object') return null
  const type = (item as { type?: unknown }).type
  if (typeof type !== 'string' || !isProviderToolOutputType(type)) return null
  return {
    dialect: dialectForResponsesItemType(type),
    type,
    ...(outputIndex !== undefined ? { outputIndex } : {}),
    item: structuredClone(item),
  }
}

export function providerOutputItemFromGeminiPart(
  type: string,
  part: unknown,
  outputIndex?: number,
): ProviderOutputItem | null {
  if (!part || typeof part !== 'object') return null
  return {
    dialect: 'google-gemini',
    type,
    ...(outputIndex !== undefined ? { outputIndex } : {}),
    item: structuredClone(part),
  }
}

export function nativeResponsesToolItemsForMessage(
  message: Message,
  target: Extract<ProviderToolContextTarget, 'openai-responses' | 'openrouter-responses'>,
  opts: ProviderToolContextOptions = {},
): unknown[] {
  return providerOutputItemsForMessage(message)
    .filter((item) => isNativeProviderOutputForContext(item, target, opts))
    .map((item) => nativeContextItem(item))
}

export function nativeGeminiToolPartsForMessage(
  message: Message,
  opts: ProviderToolContextOptions = {},
): unknown[] {
  return providerOutputItemsForMessage(message)
    .filter((item) => isNativeProviderOutputForContext(item, 'google-gemini', opts))
    .map((item) => nativeContextItem(item))
}

export function nativeAnthropicToolBlocksForMessage(
  message: Message,
  opts: ProviderToolContextOptions = {},
): unknown[] {
  return providerOutputItemsForMessage(message)
    .filter((item) => isNativeProviderOutputForContext(item, 'anthropic-claude', opts))
    .map((item) => nativeContextItem(item))
}

export function unsupportedToolContextTextForMessage(
  message: Message,
  target: ProviderToolContextTarget,
  opts: ProviderToolContextOptions = {},
): string | null {
  const unsupported = providerOutputItemsForMessage(message).filter(
    (item) =>
      shouldIncludeProviderOutputItem(item, opts) &&
      !isNativeProviderOutputForContext(item, target, opts),
  )
  if (unsupported.length === 0) return null
  return renderProviderOutputItemsAsText(unsupported)
}

export function toolEvidenceSectionsForMessage(message: Message): ToolEvidenceSection[] {
  const items = providerOutputItemsForMessage(message)
  const sections: ToolEvidenceSection[] = []
  for (const [index, item] of items.entries()) {
    for (const section of sectionsFromProviderOutputItem(item, index)) {
      sections.push({
        ...section,
        itemIndex: index,
        dialect: item.dialect,
        hidden: item.hidden === true,
        edited: item.edited === true,
      })
    }
  }
  return sections
}

export function providerOutputItemsIncludedInContext(
  message: Message,
  opts: ProviderToolContextOptions = {},
): ProviderOutputItem[] {
  return providerOutputItemsForMessage(message).filter((item) =>
    shouldIncludeProviderOutputItem(item, opts),
  )
}

export function renderProviderOutputItemsAsText(items: readonly ProviderOutputItem[]): string {
  const blocks: string[] = []
  for (const [index, item] of items.entries()) {
    if (item.hidden === true) continue
    for (const section of sectionsFromProviderOutputItem(item, index)) {
      const lines = ['<tool_call>']
      lines.push(`Tool: ${section.label}`)
      lines.push(`Dialect: ${item.dialect}`)
      lines.push(`Type: ${item.type}`)
      if (section.badge) lines.push(`Status: ${section.badge}`)
      if (item.edited === true) lines.push('Edited: true')
      for (const row of section.rows) {
        if (row.value.length === 0) continue
        lines.push(`${row.label}: ${row.value}`)
      }
      if (section.sources && section.sources.length > 0) {
        lines.push('Sources:')
        for (const source of section.sources.slice(0, 12)) lines.push(`- ${source}`)
      }
      lines.push('</tool_call>')
      blocks.push(lines.join('\n'))
    }
  }
  return blocks.join('\n\n').slice(0, 12_000)
}

export function shouldIncludeProviderOutputItem(
  item: ProviderOutputItem,
  opts: ProviderToolContextOptions = {},
): boolean {
  return opts.includeToolCalls !== false && item.hidden !== true
}

export function isNativeProviderOutputForContext(
  item: ProviderOutputItem,
  target: ProviderToolContextTarget,
  opts: ProviderToolContextOptions = {},
): boolean {
  return (
    shouldIncludeProviderOutputItem(item, opts) &&
    shouldReplayProviderOutputNative(item, target) &&
    isNativeProviderOutput(item, target)
  )
}

function shouldReplayProviderOutputNative(
  item: ProviderOutputItem,
  target: ProviderToolContextTarget,
): boolean {
  if (target === 'openrouter-responses') return false
  if (item.edited !== true) return true
  return (
    target === 'openai-responses' ||
    target === 'google-gemini' ||
    target === 'anthropic-claude'
  )
}

function nativeContextItem(item: ProviderOutputItem): unknown {
  const cloned = structuredClone(item.item)
  if (item.edited === true && item.dialect === 'google-gemini') {
    return stripGeminiThoughtSignature(cloned)
  }
  return cloned
}

function stripGeminiThoughtSignature(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map(stripGeminiThoughtSignature)
  }
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'thoughtSignature') continue
    out[key] = stripGeminiThoughtSignature(child)
  }
  return out
}

export function isNativeProviderOutput(
  item: ProviderOutputItem,
  target: ProviderToolContextTarget,
): boolean {
  if (target === 'openai-responses') {
    return (
      item.dialect === 'openai-responses' &&
      OPENAI_RESPONSES_CONTEXT_TYPES.has(item.type) &&
      !item.type.startsWith('openrouter:')
    )
  }
  if (target === 'openrouter-responses') {
    return item.dialect === 'openrouter-responses' && item.type.startsWith('openrouter:')
  }
  if (target === 'google-gemini') return item.dialect === 'google-gemini'
  if (target === 'anthropic-claude') return item.dialect === 'anthropic-claude'
  return false
}

function providerOutputItemFromServerTool(
  tool: GenerationServerToolCall,
  fallbackIndex: number,
): ProviderOutputItem | null {
  if (tool.output === undefined) return null
  if (tool.source === 'responses-output') {
    return providerOutputItemFromResponsesItem(tool.output, tool.outputIndex ?? fallbackIndex)
  }
  if (tool.type.startsWith('google:')) {
    return providerOutputItemFromGeminiPart(
      tool.type,
      normalizeGoogleProviderOutput(tool.type, tool.output),
      tool.outputIndex ?? fallbackIndex,
    )
  }
  if (tool.type.startsWith('anthropic:') || isAnthropicToolType(tool.type)) {
    return {
      dialect: 'anthropic-claude',
      type: tool.type,
      ...(tool.outputIndex !== undefined ? { outputIndex: tool.outputIndex } : {}),
      item: structuredClone(tool.output),
    }
  }
  return null
}

function normalizeGoogleProviderOutput(type: string, output: unknown): unknown {
  if (!output || typeof output !== 'object') return output
  if ('executableCode' in output || 'codeExecutionResult' in output) return structuredClone(output)
  if (type === 'google:code_execution') {
    if ('language' in output || 'code' in output) return { executableCode: structuredClone(output) }
    if ('outcome' in output || 'output' in output) {
      return { codeExecutionResult: structuredClone(output) }
    }
  }
  return structuredClone(output)
}

function sectionsFromProviderOutputItem(
  item: ProviderOutputItem,
  index: number,
): ToolEvidenceSectionBase[] {
  const raw = item.item
  const type = item.type
  if (type === 'web_search_call' || type === 'openrouter:web_search') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Web search',
        badge: statusOf(raw),
        rows: rowsFromRecord(raw, ['query', 'queries']),
        sources: sourceUrls(raw),
        raw,
      },
    ]
  }
  if (type === 'code_interpreter_call') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Code interpreter',
        badge: statusOf(raw),
        rows: [
          ...rowsFromRecord(raw, ['code', 'container_id']),
          ...rowsFromOutputs(raw, ['logs', 'text', 'output']),
        ],
        raw,
      },
    ]
  }
  if (type === 'shell_call') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Shell command',
        badge: statusOf(raw),
        rows: rowsFromRecord(raw, ['commands', 'environment']),
        raw,
      },
    ]
  }
  if (type === 'shell_call_output') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Shell output',
        badge: statusOf(raw),
        rows: rowsFromOutputs(raw, ['stdout', 'stderr', 'outcome']),
        raw,
      },
    ]
  }
  if (type === 'google:code_execution') {
    const hasExecutableCode = hasOwnObject(raw, 'executableCode')
    const hasCodeExecutionResult = hasOwnObject(raw, 'codeExecutionResult')
    return [
      {
        key: `${type}:${index}`,
        label: hasCodeExecutionResult
          ? 'Code execution result'
          : hasExecutableCode
            ? 'Code execution input'
            : 'Code execution',
        rows: hasCodeExecutionResult
          ? rowsFromRecord(raw, ['outcome', 'output'])
          : hasExecutableCode
            ? rowsFromRecord(raw, ['language', 'code'])
            : rowsFromRecord(raw, ['executableCode', 'codeExecutionResult']),
        raw,
      },
    ]
  }
  if (type === 'google:google_search') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Google Search',
        sources: sourceUrls(raw),
        rows: rowsFromRecord(raw, ['webSearchQueries', 'searchEntryPoint', 'groundingChunks']),
        raw,
      },
    ]
  }
  if (type === 'google:url_context') {
    return [
      {
        key: `${type}:${index}`,
        label: 'URL context',
        sources: sourceUrls(raw),
        rows: rowsFromRecord(raw, ['urlMetadata', 'urlContextMetadata']),
        raw,
      },
    ]
  }
  if (
    type === 'server_tool_use' ||
    type === 'web_search_tool_result' ||
    type === 'web_fetch_tool_result' ||
    type === 'code_execution_tool_result' ||
    type === 'bash_code_execution_tool_result' ||
    type === 'text_editor_code_execution_tool_result' ||
    type === 'advisor_tool_result'
  ) {
    const label =
      type === 'server_tool_use'
        ? 'Server tool use'
        : type === 'web_search_tool_result'
          ? 'Web search result'
          : type === 'web_fetch_tool_result'
            ? 'Web fetch result'
            : type === 'advisor_tool_result'
              ? 'Advisor result'
              : 'Code execution result'
    return [
      {
        key: `${type}:${index}`,
        label,
        rows: rowsFromRecord(raw, ['name', 'input', 'content', 'tool_use_id', 'stdout', 'stderr']),
        sources: sourceUrls(raw),
        raw,
      },
    ]
  }
  return [
    {
      key: `${type}:${index}`,
      label: labelForToolType(type),
      badge: statusOf(raw),
      rows: [{ label: 'Result', value: compactJson(raw) }],
      raw,
    },
  ]
}

function rowsFromRecord(
  raw: unknown,
  keys: readonly string[],
): Array<{ label: string; value: string }> {
  if (!raw || typeof raw !== 'object') return []
  const rows: Array<{ label: string; value: string }> = []
  for (const key of keys) {
    const value = getPath(raw, key)
    if (value === undefined) continue
    rows.push({ label: humanLabel(key), value: displayValue(value) })
  }
  return rows
}

function hasOwnObject(raw: unknown, key: string): boolean {
  return Boolean(raw && typeof raw === 'object' && key in raw)
}

function rowsFromOutputs(
  raw: unknown,
  keys: readonly string[],
): Array<{ label: string; value: string }> {
  const values = flattenObjects(raw)
  const rows: Array<{ label: string; value: string }> = []
  for (const key of keys) {
    const found = values.map((value) => getPath(value, key)).filter((value) => value !== undefined)
    if (found.length === 0) continue
    const rendered = [
      ...new Set(found.map(displayValue).filter((value) => value.trim().length > 0)),
    ]
    if (rendered.length === 0) continue
    rows.push({ label: humanLabel(key), value: rendered.join('\n') })
  }
  return rows
}

function sourceUrls(raw: unknown): string[] {
  const out: string[] = []
  collectUrls(raw, out)
  return [...new Set(out)].slice(0, 24)
}

function collectUrls(value: unknown, out: string[]): void {
  if (!value || out.length >= 24) return
  if (typeof value === 'string') {
    if (/^https?:\/\//iu.test(value)) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, out)
    return
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'encrypted_content') continue
      collectUrls(child, out)
    }
  }
}

function flattenObjects(value: unknown): unknown[] {
  if (!value || typeof value !== 'object') return []
  const out: unknown[] = [value]
  if (Array.isArray(value)) {
    for (const item of value) out.push(...flattenObjects(item))
  } else {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'encrypted_content') continue
      if (child && typeof child === 'object') out.push(...flattenObjects(child))
    }
  }
  return out
}

function getPath(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  if (key in value) return (value as Record<string, unknown>)[key]
  for (const child of Object.values(value)) {
    const nested = getPath(child, key)
    if (nested !== undefined) return nested
  }
  return undefined
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return trimLong(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return compactJson(value)
}

function compactJson(value: unknown): string {
  return trimLong(JSON.stringify(redactNoisyFields(value), null, 2) ?? '')
}

function redactNoisyFields(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactNoisyFields)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'encrypted_content') {
      out[key] = '[encrypted]'
    } else {
      out[key] = redactNoisyFields(child)
    }
  }
  return out
}

function trimLong(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}\n...` : value
}

function statusOf(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const status = (raw as { status?: unknown }).status
  return typeof status === 'string' ? status : undefined
}

function labelForToolType(type: string): string {
  if (type === 'openrouter:web_fetch') return 'Web fetch'
  if (type === 'openrouter:datetime') return 'Datetime'
  if (type === 'image_generation_call') return 'Image generation'
  if (type === 'file_search_call') return 'File search'
  if (type === 'mcp_tool_call' || type === 'mcp_call') return 'Remote MCP'
  if (type === 'google:google_maps') return 'Google Maps'
  return humanLabel(type)
}

function humanLabel(value: string): string {
  return value
    .replace(/^google:/u, '')
    .replace(/^openrouter:/u, '')
    .replace(/_/gu, ' ')
    .replace(/\b\w/gu, (ch) => ch.toUpperCase())
}

function isProviderToolOutputType(type: string): boolean {
  return (
    OPENAI_RESPONSES_CONTEXT_TYPES.has(type) ||
    type.startsWith('openrouter:') ||
    type === 'server_tool_use' ||
    type.endsWith('_tool_result')
  )
}

function dialectForResponsesItemType(type: string): ProviderOutputItem['dialect'] {
  if (type.startsWith('openrouter:')) return 'openrouter-responses'
  if (type === 'server_tool_use' || type.endsWith('_tool_result')) return 'anthropic-claude'
  if (OPENAI_RESPONSES_CONTEXT_TYPES.has(type)) return 'openai-responses'
  return 'unknown'
}

function isAnthropicToolType(type: string): boolean {
  return type === 'server_tool_use' || type.endsWith('_tool_result')
}

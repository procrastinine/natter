import type { AppliedMessageView } from './continuation-content'
import type { ProviderOutputDialect, ProviderOutputItem, ProviderOutputMemberRef } from './types'

export type ProviderToolContextTarget =
  | 'openai-responses'
  | 'google-gemini'
  | 'anthropic-claude'
  | 'text'

export type AttemptProviderOutputContract =
  | Readonly<{
      captureDialect: null
      replay: Readonly<{ kind: 'text' }>
    }>
  | Readonly<{
      captureDialect: 'openai-responses'
      replay: Readonly<{ kind: 'native'; target: 'openai-responses' }>
    }>
  | Readonly<{
      captureDialect: 'openrouter-responses'
      replay: Readonly<{ kind: 'text' }>
    }>
  | Readonly<{
      captureDialect: 'google-gemini'
      replay: Readonly<{ kind: 'native'; target: 'google-gemini' }>
    }>
  | Readonly<{
      captureDialect: 'anthropic-claude'
      replay: Readonly<{ kind: 'native'; target: 'anthropic-claude' }>
    }>

export const TEXT_PROVIDER_OUTPUT_CONTRACT = Object.freeze({
  captureDialect: null,
  replay: Object.freeze({ kind: 'text' }),
}) satisfies AttemptProviderOutputContract

export const OPENAI_RESPONSES_PROVIDER_OUTPUT_CONTRACT = Object.freeze({
  captureDialect: 'openai-responses' as const,
  replay: Object.freeze({ kind: 'native', target: 'openai-responses' }),
}) satisfies AttemptProviderOutputContract

export const OPENROUTER_RESPONSES_PROVIDER_OUTPUT_CONTRACT = Object.freeze({
  captureDialect: 'openrouter-responses' as const,
  replay: Object.freeze({ kind: 'text' }),
}) satisfies AttemptProviderOutputContract

export const GOOGLE_PROVIDER_OUTPUT_CONTRACT = Object.freeze({
  captureDialect: 'google-gemini' as const,
  replay: Object.freeze({ kind: 'native', target: 'google-gemini' }),
}) satisfies AttemptProviderOutputContract

export const ANTHROPIC_PROVIDER_OUTPUT_CONTRACT = Object.freeze({
  captureDialect: 'anthropic-claude' as const,
  replay: Object.freeze({ kind: 'native', target: 'anthropic-claude' }),
}) satisfies AttemptProviderOutputContract

export interface ProviderOutputContextProjection {
  readonly target: ProviderToolContextTarget
  readonly native: readonly ProviderOutputItem[]
  readonly fallback: readonly ProviderOutputItem[]
}

interface ToolEvidenceSection {
  key: string
  itemIndex: number
  member: ProviderOutputMemberRef
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
  'itemIndex' | 'member' | 'dialect' | 'hidden' | 'edited'
>

interface ProviderToolContextOptions {
  includeToolCalls?: boolean | undefined
}

interface ToolEvidenceWindow {
  start?: number | undefined
  limit?: number | undefined
}

interface EvidenceScan {
  readonly valuesByKey: ReadonlyMap<string, readonly unknown[]>
  readonly sources: readonly string[]
}

const TOOL_EVIDENCE_SCAN_MAX_NODES = 2_048
const TOOL_EVIDENCE_SCAN_MAX_DEPTH = 32
const TOOL_EVIDENCE_VALUES_PER_KEY = 8
const TOOL_EVIDENCE_PREVIEW_CHARS = 2_000
const TOOL_EVIDENCE_CONTEXT_MAX_CHARS = 12_000
const TOOL_EVIDENCE_KEYS: ReadonlySet<string> = new Set([
  'query',
  'queries',
  'code',
  'container_id',
  'logs',
  'text',
  'output',
  'commands',
  'environment',
  'stdout',
  'stderr',
  'outcome',
  'executableCode',
  'codeExecutionResult',
  'language',
  'webSearchQueries',
  'searchEntryPoint',
  'groundingChunks',
  'urlMetadata',
  'urlContextMetadata',
  'name',
  'input',
  'content',
  'tool_use_id',
  'status',
])

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

const KNOWN_PROVIDER_TOOL_OUTPUT_TYPES = new Set([
  ...OPENAI_RESPONSES_CONTEXT_TYPES,
  'google:google_search',
  'google:url_context',
  'google:code_execution',
  'google:google_maps',
  'openrouter:datetime',
  'openrouter:web_fetch',
  'openrouter:web_search',
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'advisor_tool_result',
])

export function isKnownProviderToolOutputType(type: string): boolean {
  return KNOWN_PROVIDER_TOOL_OUTPUT_TYPES.has(type)
}

const PROVIDER_OUTPUT_DIALECTS: ReadonlySet<ProviderOutputDialect> = new Set([
  'openai-responses',
  'openrouter-responses',
  'google-gemini',
  'anthropic-claude',
  'unknown',
])

export function isProviderOutputDialect(value: unknown): value is ProviderOutputDialect {
  return typeof value === 'string' && PROVIDER_OUTPUT_DIALECTS.has(value as ProviderOutputDialect)
}

export function providerOutputItemFromResponsesItem(
  item: unknown,
  dialect: Extract<ProviderOutputDialect, 'openai-responses' | 'openrouter-responses'>,
  outputIndex?: number,
): ProviderOutputItem | null {
  if (!item || typeof item !== 'object') return null
  const type = (item as { type?: unknown }).type
  if (typeof type !== 'string' || isCanonicalResponsesConversationItem(type)) return null
  return {
    dialect,
    type,
    ...(outputIndex !== undefined ? { outputIndex } : {}),
    item: structuredClone(item),
  }
}

export function isResponsesProviderOutputItem(item: unknown): boolean {
  if (!item || typeof item !== 'object') return false
  const type = (item as { type?: unknown }).type
  return typeof type === 'string' && !isCanonicalResponsesConversationItem(type)
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
    item: stripGeminiThoughtSignature(part),
  }
}

export function projectProviderOutputForContext(
  view: AppliedMessageView,
  contract: AttemptProviderOutputContract,
  opts: ProviderToolContextOptions = {},
): ProviderOutputContextProjection {
  const target = contract.replay.kind === 'native' ? contract.replay.target : 'text'
  const native: ProviderOutputItem[] = []
  const fallback: ProviderOutputItem[] = []
  for (const attempt of view.attempts) {
    for (const item of attempt.providerOutputItems ?? []) {
      if (!shouldIncludeProviderOutputItem(item, opts)) continue
      if (isNativeProviderOutputForContext(item, target, opts)) native.push(item)
      else fallback.push(item)
    }
  }
  return Object.freeze({
    target,
    native: Object.freeze(native),
    fallback: Object.freeze(fallback),
  })
}

export function materializeNativeProviderOutput(
  projection: ProviderOutputContextProjection,
): unknown[] {
  return projection.native.map((item) => nativeContextItem(item))
}

export function renderProviderOutputContextFallback(
  projection: ProviderOutputContextProjection,
): string | null {
  if (projection.fallback.length === 0) return null
  const blocks: string[] = ['<tool_evidence>']
  for (const [index, item] of projection.fallback.entries()) {
    for (const section of sectionsFromProviderOutputItem(item, index)) {
      blocks.push('<tool_call>')
      blocks.push(`Tool: ${section.label}`)
      blocks.push(`Dialect: ${item.dialect}`)
      blocks.push(`Type: ${item.type}`)
      if (section.badge) blocks.push(`Status: ${section.badge}`)
      if (item.edited === true) blocks.push('Edited: true')
      for (const row of section.rows) {
        if (row.value.length > 0) blocks.push(`${row.label}: ${row.value}`)
      }
      if (section.sources && section.sources.length > 0) {
        blocks.push('Sources:')
        for (const source of section.sources.slice(0, 12)) blocks.push(`- ${source}`)
      }
      blocks.push('</tool_call>')
    }
  }
  blocks.push('</tool_evidence>')
  return blocks.join('\n').slice(0, TOOL_EVIDENCE_CONTEXT_MAX_CHARS)
}

export function estimateNativeProviderOutputCharacters(
  projection: ProviderOutputContextProjection,
): number {
  let total = 0
  for (const item of projection.native) {
    total += JSON.stringify(item.item).length
  }
  return total
}

export function toolEvidenceSectionsForMessage(
  view: AppliedMessageView,
  window: ToolEvidenceWindow = {},
): ToolEvidenceSection[] {
  const start = Math.max(0, Math.trunc(window.start ?? 0))
  const limit = Math.max(0, Math.trunc(window.limit ?? view.providerOutputCount))
  const end = Math.min(view.providerOutputCount, start + limit)
  const sections: ToolEvidenceSection[] = []
  let index = 0
  for (const attempt of view.attempts) {
    for (
      let itemIndex = 0;
      itemIndex < (attempt.providerOutputItems?.length ?? 0);
      itemIndex += 1
    ) {
      const item = attempt.providerOutputItems?.[itemIndex]
      if (!item) continue
      if (index >= start && index < end) {
        for (const section of sectionsFromProviderOutputItem(item, index)) {
          sections.push({
            ...section,
            itemIndex: index,
            member: { owner: attempt.owner, itemIndex },
            dialect: item.dialect,
            hidden: item.hidden === true,
            edited: item.edited === true,
          })
        }
      }
      index += 1
      if (index >= end) return sections
    }
  }
  return sections
}

export function formatProviderOutputValuePreview(
  value: unknown,
  maxCharacters = TOOL_EVIDENCE_PREVIEW_CHARS,
): string {
  const limit = Math.max(1, Math.trunc(maxCharacters))
  let output = ''
  let nodes = 0
  const state = { truncated: false }
  const seen = new WeakSet<object>()

  const write = (text: string): void => {
    if (output.length >= limit) {
      state.truncated = true
      return
    }
    const remaining = limit - output.length
    if (text.length <= remaining) output += text
    else {
      output += text.slice(0, remaining)
      state.truncated = true
    }
  }

  const writeQuoted = (text: string): void => {
    write('"')
    for (let index = 0; index < text.length && output.length < limit; index += 1) {
      const character = text[index] ?? ''
      if (character === '"' || character === '\\') write(`\\${character}`)
      else if (character === '\n') write('\\n')
      else if (character === '\r') write('\\r')
      else if (character === '\t') write('\\t')
      else write(character)
    }
    if (output.length < limit) write('"')
    else state.truncated = true
  }

  const visit = (current: unknown, depth: number): void => {
    if (output.length >= limit) {
      state.truncated = true
      return
    }
    if (current === null) {
      write('null')
      return
    }
    if (typeof current === 'string') {
      writeQuoted(current)
      return
    }
    if (typeof current === 'number' || typeof current === 'boolean') {
      write(String(current))
      return
    }
    if (typeof current === 'bigint') {
      writeQuoted(String(current))
      return
    }
    if (typeof current === 'undefined') {
      writeQuoted('[undefined]')
      return
    }
    if (typeof current === 'symbol') {
      writeQuoted(current.description ? `[symbol:${current.description}]` : '[symbol]')
      return
    }
    if (typeof current === 'function') {
      writeQuoted(current.name ? `[function:${current.name}]` : '[function]')
      return
    }
    nodes += 1
    if (depth >= TOOL_EVIDENCE_SCAN_MAX_DEPTH || nodes > TOOL_EVIDENCE_SCAN_MAX_NODES) {
      writeQuoted('[truncated]')
      state.truncated = true
      return
    }
    if (seen.has(current)) {
      writeQuoted('[circular]')
      return
    }
    seen.add(current)
    if (Array.isArray(current)) {
      write('[')
      for (let index = 0; index < current.length && output.length < limit; index += 1) {
        if (index > 0) write(', ')
        visit(current[index], depth + 1)
      }
      if (output.length < limit) write(']')
      else state.truncated = true
      return
    }
    write('{')
    let emitted = 0
    for (const key in current) {
      if (output.length >= limit) break
      if (!Object.hasOwn(current, key)) continue
      const child = (current as Record<string, unknown>)[key]
      if (emitted > 0) write(', ')
      writeQuoted(key)
      write(': ')
      if (key === 'encrypted_content') writeQuoted('[encrypted]')
      else visit(child, depth + 1)
      emitted += 1
    }
    if (output.length < limit) write('}')
    else state.truncated = true
  }

  visit(value, 0)
  if (!state.truncated) return output
  if (output.length >= limit) return `${output.slice(0, Math.max(0, limit - 1))}…`
  return `${output}…`
}

function shouldIncludeProviderOutputItem(
  item: ProviderOutputItem,
  opts: ProviderToolContextOptions = {},
): boolean {
  return opts.includeToolCalls !== false && item.hidden !== true
}

function isNativeProviderOutputForContext(
  item: ProviderOutputItem,
  target: ProviderToolContextTarget,
  opts: ProviderToolContextOptions = {},
): boolean {
  return shouldIncludeProviderOutputItem(item, opts) && isNativeProviderOutput(item, target)
}

function nativeContextItem(item: ProviderOutputItem): unknown {
  const cloned = structuredClone(item.item)
  if (item.dialect === 'google-gemini') {
    return stripGeminiThoughtSignature(cloned)
  }
  return cloned
}

export function stripGeminiThoughtSignature(value: unknown): unknown {
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

function isNativeProviderOutput(
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
  if (target === 'google-gemini') return item.dialect === 'google-gemini'
  if (target === 'anthropic-claude') return item.dialect === 'anthropic-claude'
  return false
}

function sectionsFromProviderOutputItem(
  item: ProviderOutputItem,
  index: number,
): ToolEvidenceSectionBase[] {
  const raw = item.item
  const type = item.type
  const scan = scanEvidence(raw)
  if (type === 'web_search_call' || type === 'openrouter:web_search') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Web search',
        badge: firstString(scan, 'status'),
        rows: rowsFromScan(scan, ['query', 'queries']),
        sources: [...scan.sources],
        raw,
      },
    ]
  }
  if (type === 'code_interpreter_call') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Code interpreter',
        badge: firstString(scan, 'status'),
        rows: [
          ...rowsFromScan(scan, ['code', 'container_id']),
          ...rowsFromScan(scan, ['logs', 'text', 'output'], true),
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
        badge: firstString(scan, 'status'),
        rows: rowsFromScan(scan, ['commands', 'environment']),
        raw,
      },
    ]
  }
  if (type === 'shell_call_output') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Shell output',
        badge: firstString(scan, 'status'),
        rows: rowsFromScan(scan, ['stdout', 'stderr', 'outcome'], true),
        raw,
      },
    ]
  }
  if (type === 'google:code_execution') {
    const hasExecutableCode = scan.valuesByKey.has('executableCode')
    const hasCodeExecutionResult = scan.valuesByKey.has('codeExecutionResult')
    return [
      {
        key: `${type}:${index}`,
        label: hasCodeExecutionResult
          ? 'Code execution result'
          : hasExecutableCode
            ? 'Code execution input'
            : 'Code execution',
        rows: hasCodeExecutionResult
          ? rowsFromScan(scan, ['outcome', 'output'])
          : hasExecutableCode
            ? rowsFromScan(scan, ['language', 'code'])
            : rowsFromScan(scan, ['executableCode', 'codeExecutionResult']),
        raw,
      },
    ]
  }
  if (type === 'google:google_search') {
    return [
      {
        key: `${type}:${index}`,
        label: 'Google Search',
        sources: [...scan.sources],
        rows: rowsFromScan(scan, ['webSearchQueries', 'searchEntryPoint', 'groundingChunks']),
        raw,
      },
    ]
  }
  if (type === 'google:url_context') {
    return [
      {
        key: `${type}:${index}`,
        label: 'URL context',
        sources: [...scan.sources],
        rows: rowsFromScan(scan, ['urlMetadata', 'urlContextMetadata']),
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
        rows: rowsFromScan(scan, ['name', 'input', 'content', 'tool_use_id', 'stdout', 'stderr']),
        sources: [...scan.sources],
        raw,
      },
    ]
  }
  return [
    {
      key: `${type}:${index}`,
      label: labelForToolType(type),
      badge: firstString(scan, 'status'),
      rows: [{ label: 'Result', value: formatProviderOutputValuePreview(raw) }],
      raw,
    },
  ]
}

function rowsFromScan(
  scan: EvidenceScan,
  keys: readonly string[],
  collectAll = false,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = []
  for (const key of keys) {
    const values = scan.valuesByKey.get(key)
    if (!values || values.length === 0) continue
    if (!collectAll) {
      rows.push({ label: humanLabel(key), value: displayValue(values[0]) })
      continue
    }
    const rendered = [
      ...new Set(values.map(displayValue).filter((value) => value.trim().length > 0)),
    ]
    if (rendered.length > 0) {
      rows.push({ label: humanLabel(key), value: rendered.join('\n') })
    }
  }
  return rows
}

function scanEvidence(value: unknown): EvidenceScan {
  const valuesByKey = new Map<string, unknown[]>()
  const sources: string[] = []
  const sourceSet = new Set<string>()
  const seen = new WeakSet<object>()
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length > 0 && nodes < TOOL_EVIDENCE_SCAN_MAX_NODES) {
    const current = stack.pop()
    if (!current) break
    const child = current.value
    if (typeof child === 'string') {
      if (/^https?:\/\//iu.test(child) && sources.length < 24 && !sourceSet.has(child)) {
        sourceSet.add(child)
        sources.push(child)
      }
      continue
    }
    if (!child || typeof child !== 'object') continue
    if (seen.has(child)) continue
    seen.add(child)
    nodes += 1
    if (current.depth >= TOOL_EVIDENCE_SCAN_MAX_DEPTH) continue
    if (Array.isArray(child)) {
      const remaining = TOOL_EVIDENCE_SCAN_MAX_NODES - nodes - stack.length
      const boundedLength = Math.min(child.length, Math.max(0, remaining))
      for (let index = boundedLength - 1; index >= 0; index -= 1) {
        stack.push({ value: child[index], depth: current.depth + 1 })
      }
      continue
    }
    const keys: string[] = []
    const remaining = TOOL_EVIDENCE_SCAN_MAX_NODES - nodes - stack.length
    for (const key in child) {
      if (keys.length >= remaining) break
      if (Object.hasOwn(child, key)) keys.push(key)
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]
      if (key === undefined) continue
      const nested = (child as Record<string, unknown>)[key]
      if (key === 'encrypted_content') continue
      if (TOOL_EVIDENCE_KEYS.has(key)) {
        const values = valuesByKey.get(key)
        if (values) {
          if (values.length < TOOL_EVIDENCE_VALUES_PER_KEY) values.push(nested)
        } else {
          valuesByKey.set(key, [nested])
        }
      }
      stack.push({ value: nested, depth: current.depth + 1 })
    }
  }
  return { valuesByKey, sources }
}

function firstString(scan: EvidenceScan, key: string): string | undefined {
  const value = scan.valuesByKey.get(key)?.[0]
  return typeof value === 'string' ? value : undefined
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return trimLong(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return formatProviderOutputValuePreview(value)
}

function trimLong(value: string): string {
  return value.length > 2_000 ? `${value.slice(0, 2_000)}\n...` : value
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

function isCanonicalResponsesConversationItem(type: string): boolean {
  return (
    type === 'message' ||
    type === 'reasoning' ||
    type === 'function_call' ||
    type === 'function_call_output'
  )
}

export function providerOutputItemIdentity(
  record: ProviderOutputItem,
  fallbackOrdinal: number,
): string {
  if (record.captureId !== undefined) {
    return `capture:${record.dialect}:${record.type}:${record.captureId}`
  }
  const rawItem = record.item
  const item =
    rawItem !== null && typeof rawItem === 'object'
      ? (rawItem as {
          id?: unknown
          call_id?: unknown
          executableCode?: { id?: unknown }
          codeExecutionResult?: { id?: unknown }
        })
      : undefined
  if (typeof item?.id === 'string') return `id:${item.id}`
  if (typeof item?.call_id === 'string') return `call:${record.type}:${item.call_id}`
  if (typeof item?.executableCode?.id === 'string') {
    return `gemini-code:${item.executableCode.id}:exec`
  }
  if (typeof item?.codeExecutionResult?.id === 'string') {
    return `gemini-code:${item.codeExecutionResult.id}:result`
  }
  if (record.outputIndex !== undefined) {
    return `idx:${record.outputIndex}:${record.dialect}:${record.type}`
  }
  return `ordinal:${fallbackOrdinal}:${record.dialect}:${record.type}`
}

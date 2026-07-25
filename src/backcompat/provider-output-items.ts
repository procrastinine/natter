import type Dexie from 'dexie'
import type { Table } from 'dexie'
import { sameValue } from '../lib/same-value'
import type { SettingsRow } from '../store/db-rows'
import { forEachTableBatch } from './batched-table'
import type {
  GenerationServerToolCallV1,
  ProviderOutputDialectV1,
  ProviderOutputItemV1,
} from './generation-stream-events-v1'
import { runOnceBackfill } from './run-once'

const PROVIDER_OUTPUT_ITEMS_BACKFILL_KEY = 'backfill:provider-output-items-v1'

interface LegacyGenerationServerToolOutput {
  index: number
  output: unknown
}

export type LegacyGenerationServerToolCall = GenerationServerToolCallV1 & {
  output?: unknown
}

type LegacyGenerationMeta = Record<string, unknown> & {
  serverTools?: LegacyGenerationServerToolCall[]
}

export interface LegacyMessageHeaderRow extends Record<string, unknown> {
  id: string
  chatId: string
  bodyVersion: number
  nodeVersion: number
  requestContextVersion: number
  generation?: LegacyGenerationMeta
  contextRouteFacts?: unknown
}

export interface LegacyMessageBodyRow extends Record<string, unknown> {
  id: string
  chatId: string
  bodyVersion: number
  updatedAt: number
  content?: unknown
  providerOutputItems?: ProviderOutputItemV1[]
  generationServerToolOutputs?: LegacyGenerationServerToolOutput[]
}

export interface LegacyMessageTextPreviewRow {
  id: string
  chatId: string
  bodyVersion: number
  text: string
}

interface LegacyMessageContextRouteFacts {
  readonly reasoningCarriers: readonly unknown[]
  readonly hasOpenAiResponsesProviderOutput: boolean
  readonly [key: string]: unknown
}

const MESSAGE_TEXT_PREVIEW_MAX_CHARS_V82 = 1_024
const WHITESPACE_V82 = /\s/

export function providerOutputItemsBackfillMarker(): SettingsRow {
  return { key: PROVIDER_OUTPUT_ITEMS_BACKFILL_KEY, value: 4 }
}

export async function migrateProviderOutputItemRows(db: Dexie): Promise<void> {
  await runOnceBackfill(db, {
    marker: providerOutputItemsBackfillMarker(),
    tables: ['messages', 'messageBodies', 'messagePreviews'],
    run: async (tx) => {
      const messages = tx.table<LegacyMessageHeaderRow, string>('messages')
      const messageBodies = tx.table<LegacyMessageBodyRow, string>('messageBodies')
      const messagePreviews = tx.table<LegacyMessageTextPreviewRow, string>('messagePreviews')
      await migrateProviderOutputItemRowsInTables(messages, messageBodies, messagePreviews)
    },
  })
}

export async function migrateProviderOutputItemRowsInTables(
  messages: Table<LegacyMessageHeaderRow, string>,
  messageBodies: Table<LegacyMessageBodyRow, string>,
  messagePreviews?: Table<LegacyMessageTextPreviewRow, string>,
): Promise<void> {
  await forEachTableBatch(messageBodies, async (bodies) => {
    const headers = await messages.bulkGet(bodies.map((body) => body.id))
    const changedHeaders: LegacyMessageHeaderRow[] = []
    const changedBodies: LegacyMessageBodyRow[] = []
    const changedPreviews: LegacyMessageTextPreviewRow[] = []
    for (const [index, body] of bodies.entries()) {
      const storedHeader = headers[index]
      if (!storedHeader) continue
      const normalized = normalizeProviderOutputOwnershipRowsV82(storedHeader, body)
      if (normalized.bodyChanged) changedBodies.push(normalized.body)
      if (normalized.headerChanged) changedHeaders.push(normalized.header)
      if (messagePreviews && normalized.preview) changedPreviews.push(normalized.preview)
    }
    if (changedHeaders.length > 0) await messages.bulkPut(changedHeaders)
    if (changedBodies.length > 0) await messageBodies.bulkPut(changedBodies)
    if (changedPreviews.length > 0) await messagePreviews?.bulkPut(changedPreviews)
  })
}

export interface ProviderOutputOwnershipNormalizationV82 {
  readonly header: LegacyMessageHeaderRow
  readonly body: LegacyMessageBodyRow
  readonly preview?: LegacyMessageTextPreviewRow
  readonly headerChanged: boolean
  readonly bodyChanged: boolean
}

export function normalizeProviderOutputOwnershipRowsV82(
  storedHeader: LegacyMessageHeaderRow,
  storedBody: LegacyMessageBodyRow,
): ProviderOutputOwnershipNormalizationV82 {
  const legacyGeneration = generationWithStoredOutputs(storedHeader.generation, storedBody)
  const providerOutputItems = mergeLegacyProviderOutputItems(
    storedBody.providerOutputItems,
    providerOutputItemsFromLegacyServerTools(legacyGeneration?.serverTools ?? []),
  )
  const providerOutputChanged = !sameValue(storedBody.providerOutputItems, providerOutputItems)
  const bodyChanged = providerOutputChanged || storedBody.generationServerToolOutputs !== undefined
  let nextBody = storedBody
  if (bodyChanged) {
    nextBody = { ...storedBody }
    if (providerOutputItems !== undefined) nextBody.providerOutputItems = providerOutputItems
    else delete nextBody.providerOutputItems
    delete nextBody.generationServerToolOutputs
  }

  let nextHeader = stripLegacyServerToolOutputs(storedHeader)
  const nextFacts = projectProviderOutputRouteFactV82(
    storedHeader.contextRouteFacts,
    providerOutputItems,
  )
  const headerMetadataChanged =
    !sameValue(storedHeader.generation, nextHeader.generation) ||
    !sameValue(storedHeader.contextRouteFacts, nextFacts)
  if ((providerOutputChanged || headerMetadataChanged) && nextHeader === storedHeader) {
    nextHeader = { ...storedHeader }
  }
  if (providerOutputChanged) {
    const bodyVersion = Math.max(nextHeader.bodyVersion, nextBody.bodyVersion) + 1
    nextHeader = {
      ...nextHeader,
      nodeVersion: nextHeader.nodeVersion + 1,
      requestContextVersion: nextHeader.nodeVersion + 1,
      bodyVersion,
    }
    nextBody = { ...nextBody, bodyVersion }
  }
  const headerChanged = headerMetadataChanged || providerOutputChanged
  if (headerChanged) nextHeader = { ...nextHeader, contextRouteFacts: nextFacts }
  return {
    header: nextHeader,
    body: nextBody,
    ...(providerOutputChanged
      ? {
          preview: {
            id: nextHeader.id,
            chatId: nextHeader.chatId,
            bodyVersion: nextHeader.bodyVersion,
            text: previewTextFromLegacyContentV82(nextBody.content),
          },
        }
      : {}),
    headerChanged,
    bodyChanged,
  }
}

function generationWithStoredOutputs(
  generation: LegacyGenerationMeta | undefined,
  body: LegacyMessageBodyRow,
): LegacyGenerationMeta | undefined {
  if (!generation || !body.generationServerToolOutputs) return generation
  const next: LegacyGenerationMeta = structuredClone(generation)
  for (const entry of body.generationServerToolOutputs) {
    const tool = next.serverTools?.[entry.index]
    if (tool) tool.output = structuredClone(entry.output)
  }
  return next
}

export function providerOutputItemsFromLegacyServerTools(
  tools: readonly LegacyGenerationServerToolCall[],
): ProviderOutputItemV1[] {
  const out: ProviderOutputItemV1[] = []
  for (const [index, tool] of tools.entries()) {
    const item = providerOutputItemFromLegacyServerTool(tool, index)
    if (item) out.push(item)
  }
  return out
}

function providerOutputItemFromLegacyServerTool(
  tool: LegacyGenerationServerToolCall,
  fallbackIndex: number,
): ProviderOutputItemV1 | null {
  if (tool.output === undefined) return null
  if (tool.source === 'responses-output') {
    const dialect = legacyDialectForResponsesItemType(tool.type)
    if (dialect === 'anthropic-claude') {
      return {
        dialect,
        type: tool.type,
        outputIndex: tool.outputIndex ?? fallbackIndex,
        item: structuredClone(tool.output),
      }
    }
    return providerOutputItemFromResponsesItemV82(
      tool.output,
      dialect,
      tool.outputIndex ?? fallbackIndex,
    )
  }
  if (tool.type.startsWith('google:')) {
    return providerOutputItemFromGeminiPartV82(
      tool.type,
      normalizeLegacyGoogleProviderOutput(tool.type, tool.output),
      tool.outputIndex ?? fallbackIndex,
    )
  }
  if (tool.type.startsWith('anthropic:') || isLegacyAnthropicToolType(tool.type)) {
    return {
      dialect: 'anthropic-claude',
      type: tool.type,
      ...(tool.outputIndex !== undefined ? { outputIndex: tool.outputIndex } : {}),
      item: structuredClone(tool.output),
    }
  }
  return null
}

export function mergeLegacyProviderOutputItems(
  existing: ProviderOutputItemV1[] | undefined,
  migrated: readonly ProviderOutputItemV1[],
): ProviderOutputItemV1[] | undefined {
  const canonicalExisting = stripLegacyGeminiReasoningCarriers(existing)
  if (!canonicalExisting && migrated.length === 0) return undefined
  if (migrated.length === 0) return canonicalExisting
  const merged = canonicalExisting ? [...canonicalExisting] : []
  const identities = new Set(
    merged.map((item, index) => providerOutputItemIdentityV82(item, index)),
  )
  let changed = false
  for (const item of migrated) {
    const identity = providerOutputItemIdentityV82(item, merged.length)
    if (identities.has(identity)) continue
    identities.add(identity)
    merged.push(structuredClone(item))
    changed = true
  }
  return changed ? merged : canonicalExisting
}

function stripLegacyGeminiReasoningCarriers(
  items: ProviderOutputItemV1[] | undefined,
): ProviderOutputItemV1[] | undefined {
  if (!items) return undefined
  const state = { changed: false }
  const canonical = items.map((item) => {
    if (item.dialect !== 'google-gemini') return item
    const stripped = stripGeminiThoughtSignatureV82(item.item)
    if (sameValue(stripped, item.item)) return item
    state.changed = true
    return { ...item, item: stripped }
  })
  return state.changed ? canonical : items
}

function stripLegacyServerToolOutputs(header: LegacyMessageHeaderRow): LegacyMessageHeaderRow {
  const tools = header.generation?.serverTools
  if (!tools?.some((tool) => Object.hasOwn(tool, 'output'))) {
    return header
  }
  const next: LegacyMessageHeaderRow = structuredClone(header)
  for (const tool of next.generation?.serverTools ?? []) {
    delete tool.output
  }
  return next
}

function normalizeLegacyGoogleProviderOutput(type: string, output: unknown): unknown {
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

function legacyDialectForResponsesItemType(
  type: string,
): Extract<
  ProviderOutputDialectV1,
  'openai-responses' | 'openrouter-responses' | 'anthropic-claude'
> {
  if (type.startsWith('openrouter:')) return 'openrouter-responses'
  if (isLegacyAnthropicToolType(type)) return 'anthropic-claude'
  return 'openai-responses'
}

function isLegacyAnthropicToolType(type: string): boolean {
  return type === 'server_tool_use' || type.endsWith('_tool_result')
}

function projectProviderOutputRouteFactV82(
  value: unknown,
  providerOutputItems: readonly ProviderOutputItemV1[] | undefined,
): LegacyMessageContextRouteFacts {
  const stored = record(value)
  const reasoningCarriers = Array.isArray(stored?.reasoningCarriers)
    ? stored.reasoningCarriers
    : Object.freeze([])
  const hasOpenAiResponsesProviderOutput = (providerOutputItems ?? []).some(
    (item) => item.hidden !== true && item.dialect === 'openai-responses',
  )
  if (
    stored &&
    stored.reasoningCarriers === reasoningCarriers &&
    stored.hasOpenAiResponsesProviderOutput === hasOpenAiResponsesProviderOutput
  ) {
    return isProviderOutputRouteFacts(value)
      ? value
      : { reasoningCarriers, hasOpenAiResponsesProviderOutput }
  }
  return {
    ...stored,
    reasoningCarriers,
    hasOpenAiResponsesProviderOutput,
  }
}

function providerOutputItemFromResponsesItemV82(
  item: unknown,
  dialect: Extract<ProviderOutputDialectV1, 'openai-responses' | 'openrouter-responses'>,
  outputIndex?: number,
): ProviderOutputItemV1 | null {
  const row = record(item)
  const type = row?.type
  if (typeof type !== 'string' || isCanonicalResponsesConversationItemV82(type)) return null
  return {
    dialect,
    type,
    ...(outputIndex !== undefined ? { outputIndex } : {}),
    item: structuredClone(item),
  }
}

function providerOutputItemFromGeminiPartV82(
  type: string,
  part: unknown,
  outputIndex?: number,
): ProviderOutputItemV1 | null {
  if (!record(part)) return null
  return {
    dialect: 'google-gemini',
    type,
    ...(outputIndex !== undefined ? { outputIndex } : {}),
    item: stripGeminiThoughtSignatureV82(part),
  }
}

function providerOutputItemIdentityV82(
  item: ProviderOutputItemV1,
  fallbackOrdinal: number,
): string {
  if (item.captureId !== undefined) return `capture:${item.dialect}:${item.captureId}`
  const payload = record(item.item)
  if (typeof payload?.id === 'string') return `id:${payload.id}`
  if (typeof payload?.call_id === 'string') return `call:${item.type}:${payload.call_id}`
  const executableCode = record(payload?.executableCode)
  if (typeof executableCode?.id === 'string') return `gemini-code:${executableCode.id}:exec`
  const codeExecutionResult = record(payload?.codeExecutionResult)
  if (typeof codeExecutionResult?.id === 'string') {
    return `gemini-code:${codeExecutionResult.id}:result`
  }
  if (item.outputIndex !== undefined) {
    return `idx:${item.outputIndex}:${item.dialect}:${item.type}`
  }
  return `ordinal:${fallbackOrdinal}:${item.dialect}:${item.type}`
}

function stripGeminiThoughtSignatureV82(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(stripGeminiThoughtSignatureV82)
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'thoughtSignature') out[key] = stripGeminiThoughtSignatureV82(child)
  }
  return out
}

function isCanonicalResponsesConversationItemV82(type: string): boolean {
  return (
    type === 'message' ||
    type === 'reasoning' ||
    type === 'function_call' ||
    type === 'function_call_output'
  )
}

function previewTextFromLegacyContentV82(content: unknown): string {
  const prefix: string[] = []
  let normalizedLength = 0
  let pendingSpace = false
  for (const candidate of Array.isArray(content) ? content : []) {
    const item = record(candidate)
    if (
      !item ||
      (item.type !== 'text' && item.type !== 'output_text') ||
      typeof item.text !== 'string'
    ) {
      continue
    }
    for (const character of item.text) {
      if (WHITESPACE_V82.test(character)) {
        pendingSpace = normalizedLength > 0
        continue
      }
      if (pendingSpace) {
        normalizedLength += 1
        if (prefix.length < MESSAGE_TEXT_PREVIEW_MAX_CHARS_V82) prefix.push(' ')
        pendingSpace = false
      }
      normalizedLength += 1
      if (prefix.length < MESSAGE_TEXT_PREVIEW_MAX_CHARS_V82) prefix.push(character)
      if (normalizedLength > MESSAGE_TEXT_PREVIEW_MAX_CHARS_V82) {
        return `${prefix.slice(0, MESSAGE_TEXT_PREVIEW_MAX_CHARS_V82 - 1).join('')}…`
      }
    }
  }
  return prefix.join('')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function isProviderOutputRouteFacts(value: unknown): value is LegacyMessageContextRouteFacts {
  const row = record(value)
  return (
    row !== undefined &&
    Array.isArray(row.reasoningCarriers) &&
    typeof row.hasOpenAiResponsesProviderOutput === 'boolean'
  )
}

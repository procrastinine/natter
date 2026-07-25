import { sameValue } from '../lib/same-value'
import type { ProviderOutputItemV1, ReasoningFormatV1 } from './generation-stream-events-v1'
import type { ReasoningDetailV1 } from './reasoning-envelope-v1'

type MessagePhase = 'commentary' | 'final_answer'
type ProviderOutputItem = ProviderOutputItemV1
type ReasoningDetail = ReasoningDetailV1
type ReasoningFormat = ReasoningFormatV1
const REASONING_FORMATS_V80: ReadonlySet<ReasoningFormat> = new Set([
  'unknown',
  'openai-responses-v1',
  'azure-openai-responses-v1',
  'xai-responses-v1',
  'anthropic-claude-v1',
  'google-gemini-v1',
])

function reasoningDetailPayload(detail: ReasoningDetail): string {
  if (detail.type === 'reasoning.text') return detail.text ?? ''
  if (detail.type === 'reasoning.summary') return detail.summary
  return detail.data
}

function providerReasoningDetailId(input: {
  type: ReasoningDetail['type']
  providerItemId?: string
  providerOutputIndex?: number
  providerSummaryIndex?: number
}): string {
  const owner = input.providerItemId ?? String(input.providerOutputIndex ?? 'default')
  if (input.type === 'reasoning.summary') {
    return `summary#${owner}#${input.providerSummaryIndex ?? 0}`
  }
  return `${input.type === 'reasoning.text' ? 'text' : 'encrypted'}#${owner}`
}

function normalizeIncomingReasoningDetail(
  detail: ReasoningDetail,
  targetFormat: Exclude<ReasoningFormat, 'unknown'> | null,
): ReasoningDetail {
  const rawFormat = (detail as { format?: unknown }).format
  const format = isReasoningFormat(rawFormat) ? rawFormat : (targetFormat ?? 'unknown')
  const stamped = rawFormat === format ? detail : { ...detail, format }
  if (
    stamped.type === 'reasoning.text' &&
    stamped.format === 'google-gemini-v1' &&
    !stamped.signature
  ) {
    const { text, ...rest } = stamped
    return { ...rest, type: 'reasoning.summary', summary: text ?? '' }
  }
  return stamped
}

type LegacyReasoningDetail =
  | ReasoningDetail
  | ({
      type: 'reasoning.encrypted'
      format?: ReasoningFormat
      data: string
    } & ReasoningDetailMetadata)
  | ({
      type: 'reasoning.text'
      format?: ReasoningFormat
      text?: string
      signature: string
    } & ReasoningDetailMetadata)

interface ReasoningDetailMetadata {
  id?: string
  index?: number
  hidden?: boolean
}

export interface LegacyReasoningCarrierFields {
  phase?: MessagePhase
  providerOutputItems?: ProviderOutputItem[]
  reasoningDetails?: LegacyReasoningDetail[]
  responsesEchoItem?: Record<string, unknown>
}

export interface LegacyReasoningGenerationIdentity {
  apiUsed?:
    | 'chat'
    | 'responses'
    | 'gemini-native'
    | 'anthropic-messages'
    | 'completion'
    | 'video-generation'
    | undefined
  model?: string | undefined
  requestedModel?: string | undefined
}

export function normalizeLegacyReasoningCarrierFields(
  body: LegacyReasoningCarrierFields,
  generation: LegacyReasoningGenerationIdentity | undefined,
): boolean {
  let changed = false
  const details = normalizeLegacyReasoningDetails(body.reasoningDetails, generation)
  if (details.changed) {
    if (details.value) body.reasoningDetails = details.value
    else delete body.reasoningDetails
    changed = true
  }

  const echo = body.responsesEchoItem
  if (echo) {
    const migrated = reasoningDetailsFromLegacyResponsesItem(echo, generation)
    if (migrated.length > 0) {
      body.reasoningDetails = appendLegacyReasoningDetails(
        body.reasoningDetails as readonly ReasoningDetail[] | undefined,
        migrated,
      )
    }
    const providerItem = providerOutputItemFromResponsesItem(echo, legacyResponsesDialect(echo))
    if (providerItem) {
      body.providerOutputItems = appendProviderOutputItem(body.providerOutputItems, providerItem)
    }
    if (body.phase === undefined && isMessagePhase(echo.phase)) body.phase = echo.phase
    delete body.responsesEchoItem
    changed = true
  }
  return changed
}

function normalizeLegacyReasoningDetails(
  value: readonly LegacyReasoningDetail[] | undefined,
  generation: LegacyReasoningGenerationIdentity | undefined,
): { readonly value: ReasoningDetail[] | undefined; readonly changed: boolean } {
  if (!value) return { value, changed: false }
  let changed = false
  const normalized = value.map((detail) => {
    const signed =
      detail.type === 'reasoning.text' &&
      typeof detail.signature === 'string' &&
      detail.signature.length > 0
    const target = inferLegacyReasoningFormat(generation, signed)
    const rawFormat = (detail as { format?: unknown }).format
    if (!isReasoningFormat(rawFormat)) changed = true
    const canonical = {
      ...detail,
      format: isReasoningFormat(rawFormat) ? rawFormat : target,
    } as ReasoningDetail
    const normalizedDetail = normalizeIncomingReasoningDetail(
      canonical,
      isKnownReasoningFormat(target) ? target : null,
    )
    const withProviderIdentity = normalizeLegacyProviderIdentity(normalizedDetail)
    if (withProviderIdentity !== canonical) changed = true
    return withProviderIdentity
  })
  return { value: normalized, changed }
}

function reasoningDetailsFromLegacyResponsesItem(
  item: Record<string, unknown>,
  generation: LegacyReasoningGenerationIdentity | undefined,
): ReasoningDetail[] {
  if (item.type !== 'reasoning') return []
  const format = inferLegacyReasoningFormat(generation)
  const providerOutputIndex =
    typeof item.output_index === 'number' && Number.isInteger(item.output_index)
      ? item.output_index
      : 0
  const providerItemId = typeof item.id === 'string' ? item.id : undefined
  const details: ReasoningDetail[] = []
  if (typeof item.encrypted_content === 'string') {
    details.push({
      type: 'reasoning.encrypted',
      format,
      data: item.encrypted_content,
      id: providerReasoningDetailId({
        type: 'reasoning.encrypted',
        ...(providerItemId ? { providerItemId } : {}),
        providerOutputIndex,
      }),
      index: providerOutputIndex,
      ...(providerItemId ? { providerItemId } : {}),
      providerOutputIndex,
    })
  }
  if (Array.isArray(item.summary)) {
    for (const [index, entry] of item.summary.entries()) {
      if (!entry || typeof entry !== 'object') continue
      const text = (entry as { text?: unknown }).text
      if (typeof text !== 'string') continue
      details.push({
        type: 'reasoning.summary',
        format,
        summary: text,
        id: providerReasoningDetailId({
          type: 'reasoning.summary',
          ...(providerItemId ? { providerItemId } : {}),
          providerOutputIndex,
          providerSummaryIndex: index,
        }),
        index: providerOutputIndex,
        ...(providerItemId ? { providerItemId } : {}),
        providerOutputIndex,
        providerSummaryIndex: index,
      })
    }
  }
  return details
}

function normalizeLegacyProviderIdentity(detail: ReasoningDetail): ReasoningDetail {
  if (
    detail.format !== 'openai-responses-v1' &&
    detail.format !== 'azure-openai-responses-v1' &&
    detail.format !== 'xai-responses-v1'
  ) {
    return detail
  }
  const parsed = parseLegacyReasoningDetailId(detail)
  const providerItemId = detail.providerItemId ?? parsed.providerItemId
  const providerOutputIndex =
    detail.providerOutputIndex ?? parsed.providerOutputIndex ?? detail.index ?? 0
  const providerSummaryIndex =
    detail.type === 'reasoning.summary'
      ? (detail.providerSummaryIndex ?? parsed.providerSummaryIndex ?? 0)
      : undefined
  const id = providerReasoningDetailId({
    type: detail.type,
    ...(providerItemId ? { providerItemId } : {}),
    providerOutputIndex,
    ...(providerSummaryIndex !== undefined ? { providerSummaryIndex } : {}),
  })
  const normalized: ReasoningDetail = {
    ...detail,
    id,
    ...(providerItemId ? { providerItemId } : {}),
    providerOutputIndex,
    ...(providerSummaryIndex !== undefined ? { providerSummaryIndex } : {}),
  }
  return sameValue(normalized, detail) ? detail : normalized
}

function parseLegacyReasoningDetailId(detail: ReasoningDetail): {
  providerItemId?: string
  providerOutputIndex?: number
  providerSummaryIndex?: number
} {
  const id = detail.id
  if (!id) return {}
  const scalar = /^(?:encrypted|text)#(.+)$/u.exec(id)
  if (scalar) return legacyReasoningOwner(scalar[1] as string)
  const summary = /^summary#(.+?)(?:#(\d+))?$/u.exec(id)
  if (!summary) return { providerItemId: id }
  const owner = summary[1] as string
  const explicitSummary = summary[2] === undefined ? undefined : Number(summary[2])
  const parsedOwner = legacyReasoningOwner(owner)
  if (explicitSummary !== undefined) {
    return { ...parsedOwner, providerSummaryIndex: explicitSummary }
  }
  const numericOwner = parseLegacyIndex(owner)
  if (numericOwner === undefined) return { ...parsedOwner, providerSummaryIndex: 0 }
  return detail.index === numericOwner
    ? { providerOutputIndex: numericOwner, providerSummaryIndex: 0 }
    : {
        ...(detail.index !== undefined ? { providerOutputIndex: detail.index } : {}),
        providerSummaryIndex: numericOwner,
      }
}

function legacyReasoningOwner(owner: string): {
  providerItemId?: string
  providerOutputIndex?: number
} {
  if (owner === 'default') return {}
  const outputIndex = parseLegacyIndex(owner)
  return outputIndex === undefined
    ? { providerItemId: owner }
    : { providerOutputIndex: outputIndex }
}

function parseLegacyIndex(value: string): number | undefined {
  if (!/^\d+$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function appendLegacyReasoningDetails(
  existing: readonly ReasoningDetail[] | undefined,
  incoming: readonly ReasoningDetail[],
): ReasoningDetail[] {
  const result = [...(existing ?? [])]
  const identities = new Set(result.map(reasoningDetailMigrationIdentity))
  for (const detail of incoming) {
    const identity = reasoningDetailMigrationIdentity(detail)
    if (identities.has(identity)) continue
    identities.add(identity)
    result.push(detail)
  }
  return result
}

function reasoningDetailMigrationIdentity(detail: ReasoningDetail): string {
  const payload = reasoningDetailPayload(detail)
  let hash = 0x811c9dc5
  for (let index = 0; index < payload.length; index += 1) {
    hash = Math.imul(hash ^ payload.charCodeAt(index), 0x01000193)
  }
  return [
    detail.type,
    detail.format,
    detail.providerItemId ?? '',
    detail.providerOutputIndex ?? detail.index ?? '',
    detail.providerSummaryIndex ?? '',
    payload.length,
    hash >>> 0,
  ].join(':')
}

function appendProviderOutputItem(
  existing: readonly ProviderOutputItem[] | undefined,
  item: ProviderOutputItem,
): ProviderOutputItem[] {
  const itemIdentity = providerOutputItemIdentity(item, existing?.length ?? 0)
  for (const [index, candidate] of (existing ?? []).entries()) {
    if (providerOutputItemIdentity(candidate, index) === itemIdentity) return [...(existing ?? [])]
  }
  return [...(existing ?? []), item]
}

export function inferLegacyReasoningFormat(
  generation: LegacyReasoningGenerationIdentity | undefined,
  signed = false,
): ReasoningFormat {
  if (signed) return 'anthropic-claude-v1'
  if (generation?.apiUsed === 'gemini-native') return 'google-gemini-v1'
  if (generation?.apiUsed === 'anthropic-messages') return 'anthropic-claude-v1'
  const model = generation?.requestedModel ?? generation?.model ?? ''
  if (/^(?:x-ai\/)?grok|^xai\//iu.test(model)) return 'xai-responses-v1'
  const inferred = legacyReasoningPreservationFormatV80(model)
  if (inferred && inferred !== 'unknown') return inferred
  if (generation?.apiUsed === 'responses') return 'openai-responses-v1'
  return 'unknown'
}

function legacyReasoningPreservationFormatV80(modelId: string): ReasoningFormat | undefined {
  const normalized = legacyCompatModelSlug(modelId)
  if (legacyClaudeReasoningModel(normalized)) return 'anthropic-claude-v1'
  if (/^gemini-(?:2[.:]5|3(?:[.:]\d+)?)(?:$|-)/u.test(normalized)) {
    return 'google-gemini-v1'
  }
  if (/^grok-(?:4[.:](?:1|20))(?:$|-)/u.test(normalized)) return 'xai-responses-v1'
  if (/^gpt-5(?:$|[.:-])/u.test(normalized)) return 'openai-responses-v1'
  if (/^(?:o1(?:$|-)|o3(?:$|-)|o4-mini(?:$|-))/u.test(normalized)) {
    if (normalized === 'o1-mini' || normalized.startsWith('o1-mini-')) return undefined
    return 'openai-responses-v1'
  }
  return undefined
}

function legacyCompatModelSlug(modelId: string): string {
  const withoutVariant = modelId
    .trim()
    .toLowerCase()
    .replace(/:(?:free|extended)$/u, '')
  const slash = withoutVariant.lastIndexOf('/')
  return (slash < 0 ? withoutVariant : withoutVariant.slice(slash + 1)).replace(
    /^(?:models\/)+/u,
    '',
  )
}

function legacyClaudeReasoningModel(normalized: string): boolean {
  const familyFirst = /^claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:[.:-](\d+))?(?:-|$)/u.exec(
    normalized,
  )
  const versionFirst = /^claude-(\d+)(?:[.:-](\d+))?-(?:opus|sonnet|haiku|fable)(?:-|$)/u.exec(
    normalized,
  )
  const match = familyFirst ?? versionFirst
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 3 || (major === 3 && minor >= 7)
}

function isReasoningFormat(value: unknown): value is ReasoningFormat {
  return typeof value === 'string' && REASONING_FORMATS_V80.has(value as ReasoningFormat)
}

function isKnownReasoningFormat(value: unknown): value is Exclude<ReasoningFormat, 'unknown'> {
  return isReasoningFormat(value) && value !== 'unknown'
}

function providerOutputItemFromResponsesItem(
  item: unknown,
  dialect: 'openai-responses' | 'openrouter-responses',
): ProviderOutputItem | null {
  if (!isRecord(item)) return null
  const type = item.type
  if (
    typeof type !== 'string' ||
    type === 'message' ||
    type === 'reasoning' ||
    type === 'function_call' ||
    type === 'function_call_output'
  ) {
    return null
  }
  return { dialect, type, item: structuredClone(item) }
}

function providerOutputItemIdentity(record: ProviderOutputItem, fallbackOrdinal: number): string {
  if (record.captureId !== undefined) return `capture:${record.dialect}:${record.captureId}`
  const item = isRecord(record.item) ? record.item : undefined
  if (typeof item?.id === 'string') return `id:${item.id}`
  if (typeof item?.call_id === 'string') return `call:${record.type}:${item.call_id}`
  const executableCode = isRecord(item?.executableCode) ? item.executableCode : undefined
  if (typeof executableCode?.id === 'string') return `gemini-code:${executableCode.id}:exec`
  const codeExecutionResult = isRecord(item?.codeExecutionResult)
    ? item.codeExecutionResult
    : undefined
  if (typeof codeExecutionResult?.id === 'string') {
    return `gemini-code:${codeExecutionResult.id}:result`
  }
  if (record.outputIndex !== undefined) {
    return `idx:${record.outputIndex}:${record.dialect}:${record.type}`
  }
  return `ordinal:${fallbackOrdinal}:${record.dialect}:${record.type}`
}

function legacyResponsesDialect(
  item: Record<string, unknown>,
): 'openai-responses' | 'openrouter-responses' {
  return typeof item.type === 'string' && item.type.startsWith('openrouter:')
    ? 'openrouter-responses'
    : 'openai-responses'
}

function isMessagePhase(value: unknown): value is MessagePhase {
  return value === 'commentary' || value === 'final_answer'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

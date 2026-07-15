import type { ConnectionProfile } from '../core/types'
import { isSensitiveDiagnosticKey } from './diagnostic-redaction'

const MAX_STRING_CHARS = 360
const STRING_TAIL_CHARS = 96
const MAX_ARRAY_ITEMS = 8
const MAX_OBJECT_KEYS = 16
const MAX_DEPTH = 5

export interface StreamDebugTrace {
  id: string
  adapter: string
  startedAt: number
}

export interface StreamDebugEntry {
  label: string
  payload: unknown
}

export interface RequestPlanDebugEvent {
  label: string
  payload: unknown
  request?: unknown
}

let seq = 0
let streamDebugSink: ((entry: StreamDebugEntry) => void) | undefined
let requestPlanDebugSink: ((entry: RequestPlanDebugEvent) => void) | undefined

function nextTraceId(adapter: string): string {
  seq += 1
  return `${adapter}-${Date.now().toString(36)}-${seq.toString(36)}`
}

export function setStreamDebugSink(sink: ((entry: StreamDebugEntry) => void) | undefined): void {
  streamDebugSink = sink
}

export function setRequestPlanDebugSink(
  sink: ((entry: RequestPlanDebugEvent) => void) | undefined,
): void {
  requestPlanDebugSink = sink
}

export function streamDebugEnabled(profile?: Pick<ConnectionProfile, 'debugRequests'>): boolean {
  return profile?.debugRequests === true || streamDebugSink !== undefined
}

export function snapshotStreamDebugRequest(
  profile: Pick<ConnectionProfile, 'debugRequests'>,
  request: unknown,
): unknown {
  return streamDebugEnabled(profile) ? sanitize(request, 1) : null
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (isSensitiveDiagnosticKey(k)) {
      out[k] = '<redacted>'
    } else {
      out[k] = v
    }
  }
  return out
}

function elapsedMs(trace: StreamDebugTrace): number {
  return Date.now() - trace.startedAt
}

function compactString(value: string): string {
  if (value.length <= MAX_STRING_CHARS) return value
  const head = value.slice(0, MAX_STRING_CHARS - STRING_TAIL_CHARS - 20)
  const tail = value.slice(-STRING_TAIL_CHARS)
  return `${head} …<${value.length} chars>… ${tail}`
}

function compactTextLike(value: unknown): { length: number; preview: string } | undefined {
  if (typeof value !== 'string') return undefined
  return { length: value.length, preview: compactString(value) }
}

function compactReasoningDetail(detail: unknown): unknown {
  if (!detail || typeof detail !== 'object') return sanitize(detail)
  const value = detail as Record<string, unknown>
  const base: Record<string, unknown> = {}
  if (typeof value.type === 'string') base.type = value.type
  if (typeof value.id === 'string') base.id = value.id
  if (typeof value.index === 'number') base.index = value.index
  if (typeof value.format === 'string') base.format = value.format
  const textLike = compactTextLike(value.text)
  if (textLike) base.text = textLike
  const summaryLike = compactTextLike(value.summary)
  if (summaryLike) base.summary = summaryLike
  const dataLike = compactTextLike(value.data)
  if (dataLike) base.data = dataLike
  const signatureLike = compactTextLike(value.signature)
  if (signatureLike) base.signature = signatureLike
  return base
}

function compactContentItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') return sanitize(item)
  const value = item as Record<string, unknown>
  const base: Record<string, unknown> = {}
  if (typeof value.type === 'string') base.type = value.type
  const textLike = compactTextLike(value.text)
  if (textLike) base.text = textLike
  return base
}

function compactReasoningEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object') return sanitize(event)
  const value = event as Record<string, unknown>
  const base: Record<string, unknown> = {
    lane: value.lane,
    chunkId: value.chunkId,
    itemId: value.itemId,
    outputIndex: value.outputIndex,
    summaryIndex: value.summaryIndex,
  }
  const textDelta = compactTextLike(value.textDelta)
  if (textDelta) base.textDelta = textDelta
  const summaryDelta = compactTextLike(value.summaryDelta)
  if (summaryDelta) base.summaryDelta = summaryDelta
  const encryptedDelta = compactTextLike(value.encryptedDelta)
  if (encryptedDelta) base.encryptedDelta = encryptedDelta
  if (Array.isArray(value.details)) {
    base.details = value.details.slice(0, MAX_ARRAY_ITEMS).map(compactReasoningDetail)
    if (value.details.length > MAX_ARRAY_ITEMS) base.detailsTruncated = value.details.length
  }
  return base
}

function compactReasoningList(list: unknown): unknown {
  if (!Array.isArray(list)) return sanitize(list)
  return {
    count: list.length,
    items: list.slice(0, MAX_ARRAY_ITEMS).map(compactReasoningDetail),
    ...(list.length > MAX_ARRAY_ITEMS ? { truncated: list.length - MAX_ARRAY_ITEMS } : {}),
  }
}

function compactMessagePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return sanitize(payload)
  const value = payload as Record<string, unknown>
  const base: Record<string, unknown> = {}
  if (typeof value.messageId === 'string') base.messageId = value.messageId
  if (typeof value.outcome === 'string') base.outcome = value.outcome
  if (Array.isArray(value.content)) {
    base.content = value.content.slice(0, MAX_ARRAY_ITEMS).map(compactContentItem)
  }
  if (Array.isArray(value.reasoningDetails)) {
    base.reasoningDetails = compactReasoningList(value.reasoningDetails)
  }
  if (value.generation && typeof value.generation === 'object') {
    base.generation = sanitize(value.generation)
  }
  return base
}

function compactSsePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return sanitize(payload)
  const value = payload as Record<string, unknown>
  const base: Record<string, unknown> = {}
  if (typeof value.event === 'string') base.event = value.event
  const dataLike = compactTextLike(value.data)
  if (dataLike) base.data = dataLike
  return base
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return compactString(value)
  if (typeof value !== 'object') return value
  if (depth >= MAX_DEPTH) {
    if (Array.isArray(value)) return `[Array(${value.length})]`
    return '[Object]'
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[+${value.length - MAX_ARRAY_ITEMS} more]`)
    }
    return items
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const out: Record<string, unknown> = {}
  for (const [key, entry] of entries.slice(0, MAX_OBJECT_KEYS)) {
    out[key] = isSensitiveDiagnosticKey(key) ? '<redacted>' : sanitize(entry, depth + 1)
  }
  if (entries.length > MAX_OBJECT_KEYS) {
    out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS
  }
  return out
}

function summarizePayload(stage: string, payload: unknown): unknown {
  switch (stage) {
    case 'reasoning.apply':
      if (!payload || typeof payload !== 'object') return sanitize(payload)
      return {
        event: compactReasoningEvent((payload as { event?: unknown }).event),
        reasoningList: compactReasoningList((payload as { reasoningList?: unknown }).reasoningList),
      }
    case 'message.flush':
    case 'message.finalize':
      return compactMessagePayload(payload)
    case 'sse.raw':
      return compactSsePayload(payload)
    case 'sse.parsed':
    case 'buffered_result':
    case 'once.result':
    case 'request':
    case 'send.open':
      return sanitize(payload)
    default:
      return sanitize(payload)
  }
}

function emitDebug(label: string, stage: string, payload?: unknown): void {
  const summarized = summarizePayload(stage, payload)
  streamDebugSink?.({ label, payload: summarized })
  console.debug(label, summarized)
}

export function logRequestPlanDebug(label: string, payload?: unknown): void {
  if (!requestPlanDebugSink) return
  const { request, summary } = summarizeRequestPlan(payload)
  const fullLabel = `[request-plan] ${label}`
  requestPlanDebugSink({
    label: fullLabel,
    payload: summary,
    ...(request === undefined ? {} : { request }),
  })
  console.debug(fullLabel, summary)
}

function summarizeRequestPlan(payload: unknown): { request?: unknown; summary: unknown } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { summary: sanitize(payload) }
  }
  const { request, ...metadata } = payload as Record<string, unknown>
  return {
    ...(request === undefined ? {} : { request }),
    summary: sanitize(metadata),
  }
}

export function startStreamDebug(args: {
  adapter: string
  profile: ConnectionProfile
  url: string
  request: unknown
  headers: Record<string, string>
}): StreamDebugTrace | null {
  if (!streamDebugEnabled(args.profile)) return null
  const trace: StreamDebugTrace = {
    id: nextTraceId(args.adapter),
    adapter: args.adapter,
    startedAt: Date.now(),
  }
  emitDebug(`[stream-debug][${trace.id}] request`, 'request', {
    adapter: args.adapter,
    profile: {
      id: args.profile.id,
      name: args.profile.name,
      kind: args.profile.kind,
      baseUrl: args.profile.baseUrl,
      debugRequests: args.profile.debugRequests === true,
    },
    url: args.url,
    headers: redactHeaders(args.headers),
    request: args.request,
  })
  return trace
}

export function logStreamDebug(
  scope: StreamDebugTrace | string | null | undefined,
  stage: string,
  payload?: unknown,
): void {
  if (scope === null || scope === undefined) {
    if (!streamDebugSink) return
    emitDebug(`[stream-debug][global] ${stage}`, stage, payload)
    return
  }
  if (typeof scope === 'string') {
    if (!streamDebugSink) return
    emitDebug(`[stream-debug][${scope}] ${stage}`, stage, payload)
    return
  }
  emitDebug(`[stream-debug][${scope.id}] +${elapsedMs(scope)}ms ${stage}`, stage, payload)
}

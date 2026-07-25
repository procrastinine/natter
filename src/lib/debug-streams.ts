import { isReasoningEnvelope, projectReasoningPresentation } from '../core/reasoning-envelope'
import type {
  ConnectionProfile,
  OpaqueReasoningCarrierDescriptor,
  ReasoningVisiblePart,
} from '../core/types'
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

export type DebugPayload = unknown

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

export function requestPlanDebugEnabled(): boolean {
  return requestPlanDebugSink !== undefined
}

export function streamDebugEnabled(profile?: Pick<ConnectionProfile, 'debugRequests'>): boolean {
  return profile?.debugRequests === true || streamDebugSink !== undefined
}

export function snapshotStreamDebugRequest(
  profile: Pick<ConnectionProfile, 'debugRequests'>,
  request: DebugPayload,
): unknown {
  return streamDebugEnabled(profile) ? sanitize(resolvePayload(request), 1) : null
}

function resolvePayload(payload: DebugPayload): unknown {
  return typeof payload === 'function' ? (payload as () => unknown)() : payload
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

function compactContentItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') return sanitize(item)
  const value = item as Record<string, unknown>
  const base: Record<string, unknown> = {}
  if (typeof value.type === 'string') base.type = value.type
  const textLike = compactTextLike(value.text)
  if (textLike) base.text = textLike
  return base
}

function compactReasoningEnvelope(value: unknown): unknown {
  if (!isReasoningEnvelope(value)) return { invalid: true }
  const presentation = projectReasoningPresentation({
    kind: 'durable',
    owner: { kind: 'generation' },
    envelope: value,
  })
  const items: unknown[] = []
  const pushVisible = (
    entry: (typeof presentation.text)[number],
    kind: ReasoningVisiblePart['kind'],
  ) => {
    if (items.length >= MAX_ARRAY_ITEMS) return
    items.push({
      lane: kind,
      id: entry.part.id,
      format: entry.part.format,
      value: compactTextLike(entry.text),
      ...(entry.part.hidden === true ? { hidden: true } : {}),
    })
  }
  const pushCarrier = (
    entry: (typeof presentation.opaque)[number],
    role: 'opaque' | 'authentication',
  ) => {
    if (items.length >= MAX_ARRAY_ITEMS) return
    items.push({
      lane: role,
      id: entry.carrier.id,
      kind: entry.carrier.kind,
      format: entry.carrier.format,
      valueLength: entry.valueLength,
      ...carrierBindingSummary(entry.carrier),
      ...(entry.carrier.hidden === true ? { hidden: true } : {}),
    })
  }
  for (const entry of presentation.text) pushVisible(entry, 'text')
  for (const entry of presentation.summary) pushVisible(entry, 'summary')
  for (const entry of presentation.opaque) pushCarrier(entry, 'opaque')
  for (const entry of presentation.authentication) pushCarrier(entry, 'authentication')
  const memberCount =
    presentation.text.length +
    presentation.summary.length +
    presentation.opaque.length +
    presentation.authentication.length
  return {
    kind: presentation.kind,
    counts: {
      text: presentation.text.length,
      summary: presentation.summary.length,
      opaque: presentation.opaque.length,
      authentication: presentation.authentication.length,
    },
    lengths: {
      text: presentation.textCharCount,
      summary: presentation.summaryCharCount,
      opaque: presentation.opaqueCarrierBytes,
      authentication: presentation.authenticationCarrierBytes,
    },
    items,
    ...(memberCount > items.length ? { truncated: memberCount - items.length } : {}),
  }
}

function carrierBindingSummary(
  carrier: OpaqueReasoningCarrierDescriptor,
): Record<string, string | true> {
  if (carrier.kind !== 'anthropic-signature' && carrier.kind !== 'gemini-thought-signature') {
    return {}
  }
  return carrier.bindsVisiblePartId
    ? { bindsVisiblePartId: carrier.bindsVisiblePartId }
    : { unbound: true }
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
  if (value.reasoningEnvelope !== undefined) {
    base.reasoningEnvelope = compactReasoningEnvelope(value.reasoningEnvelope)
  }
  if (Array.isArray(value.reasoningAttempts)) {
    base.reasoningAttempts = value.reasoningAttempts
      .slice(0, MAX_ARRAY_ITEMS)
      .map(compactReasoningAttempt)
    if (value.reasoningAttempts.length > MAX_ARRAY_ITEMS) {
      base.reasoningAttemptsTruncated = value.reasoningAttempts.length - MAX_ARRAY_ITEMS
    }
  }
  if (value.generation && typeof value.generation === 'object') {
    base.generation = sanitize(value.generation)
  }
  return base
}

function compactReasoningAttempt(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sanitize(value)
  const attempt = value as Record<string, unknown>
  return {
    owner: sanitize(attempt.owner),
    visibility: sanitize(attempt.visibility),
    ...(attempt.reasoningEnvelope === undefined
      ? {}
      : { reasoningEnvelope: compactReasoningEnvelope(attempt.reasoningEnvelope) }),
  }
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
    case 'message.finalize':
      return compactMessagePayload(payload)
    case 'frame-raw':
      return compactSsePayload(payload)
    case 'frame':
    case 'frame-invalid':
    case 'buffered-result':
    case 'poll':
    case 'response-head':
    case 'terminal':
    case 'error':
    case 'request':
      return sanitize(payload)
    default:
      return sanitize(payload)
  }
}

function emitDebug(label: string, stage: string, payload?: DebugPayload): void {
  const summarized = summarizePayload(stage, resolvePayload(payload))
  streamDebugSink?.({ label, payload: summarized })
  console.debug(label, summarized)
}

export function logRequestPlanDebug(label: string, payload?: DebugPayload): void {
  if (!requestPlanDebugSink) return
  const { request, summary } = summarizeRequestPlan(resolvePayload(payload))
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
  diagnosticId?: string
  profile: ConnectionProfile
  url: string
  request: DebugPayload
  headers: Record<string, string>
  attemptIndex?: number
}): StreamDebugTrace | null {
  if (!streamDebugEnabled(args.profile)) return null
  const trace: StreamDebugTrace = {
    id: args.diagnosticId ?? nextTraceId(args.adapter),
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
    attemptIndex: args.attemptIndex ?? 0,
    headers: redactHeaders(args.headers),
    request: resolvePayload(args.request),
  })
  return trace
}

export function logStreamDebugRequestAttempt(
  trace: StreamDebugTrace,
  args: {
    url: string
    headers: Record<string, string>
    attemptIndex: number
    phase?: 'dispatch' | 'poll'
  },
): void {
  emitDebug(`[stream-debug][${trace.id}] request`, 'request', {
    adapter: trace.adapter,
    url: args.url,
    attemptIndex: args.attemptIndex,
    ...(args.phase ? { phase: args.phase } : {}),
    headers: redactHeaders(args.headers),
  })
}

export function logStreamDebug(
  scope: StreamDebugTrace | string | null | undefined,
  stage: string,
  payload?: DebugPayload,
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

export function logStreamDebugError(
  trace: StreamDebugTrace,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  logStreamDebug(trace, 'error', {
    ...(context ?? {}),
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error),
  })
}

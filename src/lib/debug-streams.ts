import type { ConnectionProfile } from '../core/types'

const STORAGE_KEY = 'natter.debug.streams'
const PLAN_STORAGE_KEY = 'natter.debug.request_plans'
const DEBUG_API_VERSION = 'request-plan-full-request-v1'
const MAX_BUFFER_ENTRIES = 2000
const MAX_PLAN_ENTRIES = 200
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

interface StreamDebugEntry {
  label: string
  payload: unknown
}

interface RequestPlanDebugEntry {
  label: string
  payload: unknown
}

interface StreamDebugApi {
  version(): string
  enable(): void
  disable(): void
  status(): { enabled: boolean; entries: number }
  clear(): void
  dump(): string
  last(count?: number): string
  copy(): Promise<string>
  enablePlans(): void
  disablePlans(): void
  planStatus(): { enabled: boolean; entries: number }
  clearPlans(): void
  dumpPlans(): string
  lastPlans(count?: number): string
  copyPlans(): Promise<string>
  plans(): RequestPlanDebugEntry[]
  lastPlan(): RequestPlanDebugEntry | null
  lastRequest(): unknown | null
}

let seq = 0
const entryBuffer: StreamDebugEntry[] = []
const planBuffer: RequestPlanDebugEntry[] = []

function nextTraceId(adapter: string): string {
  seq += 1
  return `${adapter}-${Date.now().toString(36)}-${seq.toString(36)}`
}

function globalDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function requestPlanDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(PLAN_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function streamDebugEnabled(
  profile?: Pick<ConnectionProfile, 'debugRequests'> | undefined,
): boolean {
  return profile?.debugRequests === true || globalDebugEnabled()
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (/^authorization$/i.test(k) || /^x-goog-api-key$/i.test(k)) {
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

function pushEntry(label: string, payload: unknown): void {
  entryBuffer.push({ label, payload })
  if (entryBuffer.length > MAX_BUFFER_ENTRIES) {
    entryBuffer.splice(0, entryBuffer.length - MAX_BUFFER_ENTRIES)
  }
}

function pushPlanEntry(label: string, payload: unknown): void {
  planBuffer.push({ label, payload: cloneDebugPayload(payload) })
  if (planBuffer.length > MAX_PLAN_ENTRIES) {
    planBuffer.splice(0, planBuffer.length - MAX_PLAN_ENTRIES)
  }
}

function cloneDebugPayload(payload: unknown): unknown {
  try {
    return structuredClone(payload)
  } catch {
    try {
      return JSON.parse(JSON.stringify(payload)) as unknown
    } catch {
      return payload
    }
  }
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
    out[key] = sanitize(entry, depth + 1)
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

function formatEntry(label: string, payload: unknown): string {
  if (payload === undefined) return label
  return `${label} ${JSON.stringify(payload)}`
}

function emitDebug(label: string, stage: string, payload?: unknown): void {
  const summarized = summarizePayload(stage, payload)
  pushEntry(label, summarized)
  // eslint-disable-next-line no-console
  console.debug(label, summarized)
}

export function logRequestPlanDebug(label: string, payload?: unknown): void {
  if (!requestPlanDebugEnabled()) return
  const summarized = sanitize(payload)
  const fullLabel = `[request-plan] ${label}`
  pushPlanEntry(fullLabel, payload)
  // eslint-disable-next-line no-console
  console.debug(fullLabel, summarized)
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
    if (!globalDebugEnabled()) return
    emitDebug(`[stream-debug][global] ${stage}`, stage, payload)
    return
  }
  if (typeof scope === 'string') {
    if (!globalDebugEnabled()) return
    emitDebug(`[stream-debug][${scope}] ${stage}`, stage, payload)
    return
  }
  emitDebug(`[stream-debug][${scope.id}] +${elapsedMs(scope)}ms ${stage}`, stage, payload)
}

async function copyDumpText(text: string): Promise<string> {
  try {
    if (
      typeof document !== 'undefined' &&
      typeof document.hasFocus === 'function' &&
      !document.hasFocus()
    ) {
      throw new DOMException('Document is not focused.', 'NotAllowedError')
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    }
  } catch (err) {
    if (typeof window !== 'undefined') {
      ;(window as unknown as { __debugStreamsLastCopyText?: string }).__debugStreamsLastCopyText =
        text
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[debug] clipboard copy unavailable; returning dump text and storing it on window.__debugStreamsLastCopyText',
      err,
    )
  }
  return text
}

function bufferDump(entries: readonly StreamDebugEntry[]): string {
  return entries.map((entry) => formatEntry(entry.label, entry.payload)).join('\n')
}

function planDump(entries: readonly RequestPlanDebugEntry[]): string {
  return entries.map((entry) => formatEntry(entry.label, entry.payload)).join('\n')
}

export function installDebugStreams(): void {
  if (typeof window === 'undefined') return
  const api: StreamDebugApi = {
    version() {
      return DEBUG_API_VERSION
    },
    enable() {
      window.localStorage.setItem(STORAGE_KEY, '1')
      entryBuffer.splice(0, entryBuffer.length)
      // eslint-disable-next-line no-console
      console.info('[debug] stream logging enabled and buffer reset')
    },
    disable() {
      window.localStorage.removeItem(STORAGE_KEY)
      // eslint-disable-next-line no-console
      console.info('[debug] stream logging disabled')
    },
    status() {
      return { enabled: globalDebugEnabled(), entries: entryBuffer.length }
    },
    clear() {
      entryBuffer.splice(0, entryBuffer.length)
      // eslint-disable-next-line no-console
      console.info('[debug] stream log buffer cleared')
    },
    dump() {
      return bufferDump(entryBuffer)
    },
    last(count = 100) {
      return bufferDump(entryBuffer.slice(-count))
    },
    async copy() {
      return copyDumpText(bufferDump(entryBuffer))
    },
    enablePlans() {
      window.localStorage.setItem(PLAN_STORAGE_KEY, '1')
      planBuffer.splice(0, planBuffer.length)
      // eslint-disable-next-line no-console
      console.info('[debug] compact request-plan logging enabled and buffer reset')
    },
    disablePlans() {
      window.localStorage.removeItem(PLAN_STORAGE_KEY)
      // eslint-disable-next-line no-console
      console.info('[debug] compact request-plan logging disabled')
    },
    planStatus() {
      return { enabled: requestPlanDebugEnabled(), entries: planBuffer.length }
    },
    clearPlans() {
      planBuffer.splice(0, planBuffer.length)
      // eslint-disable-next-line no-console
      console.info('[debug] compact request-plan buffer cleared')
    },
    dumpPlans() {
      return planDump(planBuffer)
    },
    lastPlans(count = 20) {
      return planDump(planBuffer.slice(-count))
    },
    async copyPlans() {
      return copyDumpText(planDump(planBuffer))
    },
    plans() {
      return planBuffer.map((entry) => ({
        label: entry.label,
        payload: structuredClone(entry.payload),
      }))
    },
    lastPlan() {
      const entry = planBuffer.at(-1)
      if (!entry) return null
      return {
        label: entry.label,
        payload: cloneDebugPayload(entry.payload),
      }
    },
    lastRequest() {
      for (let index = planBuffer.length - 1; index >= 0; index -= 1) {
        const entry = planBuffer[index]
        const request = requestFromPlanPayload(entry?.payload)
        if (request !== undefined) return cloneDebugPayload(request)
      }
      return null
    },
  }
  ;(window as unknown as { __debugStreams: StreamDebugApi }).__debugStreams = api
  // eslint-disable-next-line no-console
  console.info(
    '%c[debug] window.__debugStreams.enable() — compact stream logging with buffer helpers (`dump()`, `last()`, `copy()`, `clear()`). Use `enablePlans()` for one-line request-plan logs.',
    'color:#888;font-style:italic',
  )
}

function requestFromPlanPayload(payload: unknown): unknown | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  return (payload as { request?: unknown }).request
}

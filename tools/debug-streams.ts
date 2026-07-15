import {
  type RequestPlanDebugEvent,
  type StreamDebugEntry,
  setRequestPlanDebugSink,
  setStreamDebugSink,
} from '../src/lib/debug-streams'
import {
  BoundedDebugBuffer,
  decodeDebugPayload,
  dumpDebugEntries,
  encodeDebugEntry,
  encodeJson,
} from './debug-buffer'

const STORAGE_KEY = 'natter.debug.streams'
const PLAN_STORAGE_KEY = 'natter.debug.request_plans'
const DEBUG_API_VERSION = 'request-plan-bounded-v2'
const MAX_BUFFER_ENTRIES = 2000
const MAX_BUFFER_BYTES = 4 * 1024 * 1024
const MAX_STREAM_ENTRY_BYTES = 64 * 1024
const MAX_PLAN_ENTRIES = 200
const MAX_PLAN_BUFFER_BYTES = 512 * 1024
const MAX_PLAN_ENTRY_BYTES = 16 * 1024
const MAX_LATEST_REQUEST_BYTES = 1024 * 1024

interface RequestPlanDebugEntry {
  label: string
  payload: unknown
}

type LatestRequestCapture =
  | { state: 'available'; bytes: number; maximumBytes: number }
  | { state: 'over-byte-cap' | 'unserializable'; maximumBytes: number }
  | { state: 'none'; maximumBytes: number }

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
  planStatus(): {
    enabled: boolean
    entries: number
    latestRequest: LatestRequestCapture
  }
  clearPlans(): void
  dumpPlans(): string
  lastPlans(count?: number): string
  copyPlans(): Promise<string>
  plans(): RequestPlanDebugEntry[]
  lastPlan(): RequestPlanDebugEntry | null
  lastRequest(): unknown
}

const entryBuffer = new BoundedDebugBuffer(MAX_BUFFER_ENTRIES, MAX_BUFFER_BYTES)
const planBuffer = new BoundedDebugBuffer(MAX_PLAN_ENTRIES, MAX_PLAN_BUFFER_BYTES)
let latestRequest: Uint8Array | null = null
let latestRequestCapture: LatestRequestCapture = {
  state: 'none',
  maximumBytes: MAX_LATEST_REQUEST_BYTES,
}

export function installDebugStreams(): void {
  if (typeof window === 'undefined') return

  const captureStream = (entry: StreamDebugEntry) => {
    if (!storageEnabled(STORAGE_KEY)) {
      setStreamDebugSink(undefined)
      return
    }
    entryBuffer.push(encodeDebugEntry(entry.label, entry.payload, MAX_STREAM_ENTRY_BYTES))
  }
  const capturePlan = (entry: RequestPlanDebugEvent) => {
    if (!storageEnabled(PLAN_STORAGE_KEY)) {
      setRequestPlanDebugSink(undefined)
      return
    }
    captureLatestRequest(entry.request)
    const payload = attachRequestCapture(entry.payload, latestRequestCapture)
    planBuffer.push(encodeDebugEntry(entry.label, payload, MAX_PLAN_ENTRY_BYTES))
  }
  const syncSinks = () => {
    setStreamDebugSink(storageEnabled(STORAGE_KEY) ? captureStream : undefined)
    setRequestPlanDebugSink(storageEnabled(PLAN_STORAGE_KEY) ? capturePlan : undefined)
  }
  syncSinks()

  const api: StreamDebugApi = {
    version: () => DEBUG_API_VERSION,
    enable() {
      window.localStorage.setItem(STORAGE_KEY, '1')
      clearStreamCapture()
      syncSinks()
      console.info('[debug] stream logging enabled and buffer reset')
    },
    disable() {
      window.localStorage.removeItem(STORAGE_KEY)
      syncSinks()
      clearStreamCapture()
      console.info('[debug] stream logging disabled')
    },
    status: () => ({ enabled: storageEnabled(STORAGE_KEY), entries: entryBuffer.length }),
    clear() {
      clearStreamCapture()
      console.info('[debug] stream log buffer cleared')
    },
    dump: () => dumpDebugEntries(entryBuffer.entries()),
    last: (count = 100) => dumpDebugEntries(entryBuffer.last(count)),
    copy: () => copyDumpText(dumpDebugEntries(entryBuffer.entries())),
    enablePlans() {
      window.localStorage.setItem(PLAN_STORAGE_KEY, '1')
      clearPlanCapture()
      syncSinks()
      console.info('[debug] compact request-plan logging enabled and buffer reset')
    },
    disablePlans() {
      window.localStorage.removeItem(PLAN_STORAGE_KEY)
      syncSinks()
      clearPlanCapture()
      console.info('[debug] compact request-plan logging disabled')
    },
    planStatus: () => ({
      enabled: storageEnabled(PLAN_STORAGE_KEY),
      entries: planBuffer.length,
      latestRequest: { ...latestRequestCapture },
    }),
    clearPlans() {
      clearPlanCapture()
      console.info('[debug] compact request-plan buffer cleared')
    },
    dumpPlans: () => dumpDebugEntries(planBuffer.entries()),
    lastPlans: (count = 20) => dumpDebugEntries(planBuffer.last(count)),
    copyPlans: () => copyDumpText(dumpDebugEntries(planBuffer.entries())),
    plans: () => planBuffer.entries().map(publicEntry),
    lastPlan() {
      const entry = planBuffer.lastEntry()
      return entry ? publicEntry(entry) : null
    },
    lastRequest() {
      return latestRequest ? decodeDebugPayload(latestRequest) : null
    },
  }
  ;(window as unknown as { __debugStreams: StreamDebugApi }).__debugStreams = api
  console.info(
    '%c[debug] window.__debugStreams.enable() — compact stream logging with buffer helpers (`dump()`, `last()`, `copy()`, `clear()`). Use `enablePlans()` for one-line request-plan logs.',
    'color:#888;font-style:italic',
  )
}

function storageEnabled(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function clearStreamCapture(): void {
  entryBuffer.clear()
  clearCopyFallback()
}

function clearPlanCapture(): void {
  planBuffer.clear()
  latestRequest = null
  latestRequestCapture = { state: 'none', maximumBytes: MAX_LATEST_REQUEST_BYTES }
  clearCopyFallback()
}

function captureLatestRequest(request: unknown): void {
  latestRequest = null
  if (request === undefined) {
    latestRequestCapture = { state: 'none', maximumBytes: MAX_LATEST_REQUEST_BYTES }
    return
  }
  const encoded = encodeJson(request, MAX_LATEST_REQUEST_BYTES)
  latestRequest = encoded.payload
  latestRequestCapture = encoded.payload
    ? {
        state: 'available',
        bytes: encoded.payload.byteLength,
        maximumBytes: MAX_LATEST_REQUEST_BYTES,
      }
    : { state: encoded.reason, maximumBytes: MAX_LATEST_REQUEST_BYTES }
}

function attachRequestCapture(payload: unknown, capture: LatestRequestCapture): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), requestCapture: capture }
  }
  return { summary: payload, requestCapture: capture }
}

function publicEntry(entry: { label: string; payload: Uint8Array }): RequestPlanDebugEntry {
  return { label: entry.label, payload: decodeDebugPayload(entry.payload) }
}

function clearCopyFallback(): void {
  delete (window as unknown as { __debugStreamsLastCopyText?: string }).__debugStreamsLastCopyText
}

async function copyDumpText(text: string): Promise<string> {
  clearCopyFallback()
  try {
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
      throw new DOMException('Document is not focused.', 'NotAllowedError')
    }
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  } catch (error) {
    ;(window as unknown as { __debugStreamsLastCopyText?: string }).__debugStreamsLastCopyText =
      text
    console.warn(
      '[debug] clipboard copy unavailable; returning dump text and storing it on window.__debugStreamsLastCopyText',
      error,
    )
  }
  return text
}

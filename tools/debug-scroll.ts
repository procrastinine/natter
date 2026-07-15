import { setScrollDebugSink } from '../src/lib/debug-scroll'
import {
  BoundedDebugBuffer,
  decodeDebugPayload,
  dumpDebugEntries,
  encodeDebugEntry,
} from './debug-buffer'

const STORAGE_KEY = 'natter.debug.scroll'
const MAX_BUFFER_ENTRIES = 1000
const MAX_BUFFER_BYTES = 1024 * 1024
const MAX_ENTRY_BYTES = 16 * 1024

interface ScrollDebugEntry {
  label: string
  payload: unknown
}

interface ScrollDebugApi {
  enable(): void
  disable(): void
  status(): { enabled: boolean; entries: number }
  clear(): void
  dump(): string
  last(count?: number): string
  copy(): Promise<string>
  entries(): ScrollDebugEntry[]
}

const buffer = new BoundedDebugBuffer(MAX_BUFFER_ENTRIES, MAX_BUFFER_BYTES)

export function installDebugScroll(): void {
  if (typeof window === 'undefined') return

  const capture = (event: string, payload: unknown) => {
    if (!enabled()) {
      setScrollDebugSink(undefined)
      return
    }
    const label = `[scroll-debug] ${event}`
    const entry = encodeDebugEntry(label, payload, MAX_ENTRY_BYTES)
    buffer.push(entry)
    console.debug(label, decodeDebugPayload(entry.payload))
  }
  const syncSink = () => setScrollDebugSink(enabled() ? capture : undefined)
  syncSink()

  const api: ScrollDebugApi = {
    enable() {
      window.localStorage.setItem(STORAGE_KEY, '1')
      clearCapture()
      syncSink()
      console.info('[debug] scroll logging enabled and buffer reset')
    },
    disable() {
      window.localStorage.removeItem(STORAGE_KEY)
      syncSink()
      clearCapture()
      console.info('[debug] scroll logging disabled')
    },
    status: () => ({ enabled: enabled(), entries: buffer.length }),
    clear() {
      clearCapture()
      console.info('[debug] scroll log buffer cleared')
    },
    dump: () => dumpDebugEntries(buffer.entries()),
    last: (count = 100) => dumpDebugEntries(buffer.last(count)),
    copy: () => copyText(dumpDebugEntries(buffer.entries())),
    entries: () =>
      buffer.entries().map((entry) => ({
        label: entry.label,
        payload: decodeDebugPayload(entry.payload),
      })),
  }
  ;(window as unknown as { __debugScroll: ScrollDebugApi }).__debugScroll = api
  console.info(
    '%c[debug] window.__debugScroll.enable() — scroll-region event logging with buffer helpers (`dump()`, `last()`, `copy()`, `clear()`).',
    'color:#888;font-style:italic',
  )
}

function enabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function clearCapture(): void {
  buffer.clear()
  delete (window as unknown as { __debugScrollLastCopyText?: string }).__debugScrollLastCopyText
}

async function copyText(text: string): Promise<string> {
  delete (window as unknown as { __debugScrollLastCopyText?: string }).__debugScrollLastCopyText
  try {
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
      throw new DOMException('Document is not focused.', 'NotAllowedError')
    }
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  } catch (error) {
    ;(window as unknown as { __debugScrollLastCopyText?: string }).__debugScrollLastCopyText = text
    console.warn(
      '[debug] scroll clipboard copy unavailable; returning dump text and storing it on window.__debugScrollLastCopyText',
      error,
    )
  }
  return text
}

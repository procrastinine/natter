const STORAGE_KEY = 'natter.debug.scroll'
const MAX_BUFFER_ENTRIES = 1000

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

const buffer: ScrollDebugEntry[] = []

function enabled(): boolean {
  if (!import.meta.env.DEV) return false
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function push(label: string, payload: unknown): void {
  buffer.push({ label, payload })
  if (buffer.length > MAX_BUFFER_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_BUFFER_ENTRIES)
  }
}

function formatEntry(entry: ScrollDebugEntry): string {
  return `${entry.label} ${JSON.stringify(entry.payload)}`
}

function dumpEntries(entries: readonly ScrollDebugEntry[]): string {
  return entries.map(formatEntry).join('\n')
}

async function copyText(text: string): Promise<string> {
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
      ;(window as unknown as { __debugScrollLastCopyText?: string }).__debugScrollLastCopyText =
        text
    }
    console.warn(
      '[debug] scroll clipboard copy unavailable; returning dump text and storing it on window.__debugScrollLastCopyText',
      err,
    )
  }
  return text
}

export function logScrollDebug(event: string, payload?: unknown): void {
  if (!enabled()) return
  const label = `[scroll-debug] ${event}`
  push(label, payload ?? null)
  console.debug(label, payload ?? null)
}

export function installDebugScroll(): void {
  if (!import.meta.env.DEV) return
  if (typeof window === 'undefined') return
  const api: ScrollDebugApi = {
    enable() {
      window.localStorage.setItem(STORAGE_KEY, '1')
      buffer.splice(0, buffer.length)
      console.info('[debug] scroll logging enabled and buffer reset')
    },
    disable() {
      window.localStorage.removeItem(STORAGE_KEY)
      console.info('[debug] scroll logging disabled')
    },
    status() {
      return { enabled: enabled(), entries: buffer.length }
    },
    clear() {
      buffer.splice(0, buffer.length)
      console.info('[debug] scroll log buffer cleared')
    },
    dump() {
      return dumpEntries(buffer)
    },
    last(count = 100) {
      return dumpEntries(buffer.slice(-count))
    },
    async copy() {
      return copyText(dumpEntries(buffer))
    },
    entries() {
      return buffer.map((entry) => ({
        label: entry.label,
        payload: structuredClone(entry.payload),
      }))
    },
  }
  ;(window as unknown as { __debugScroll: ScrollDebugApi }).__debugScroll = api
  console.info(
    '%c[debug] window.__debugScroll.enable() — scroll-region event logging with buffer helpers (`dump()`, `last()`, `copy()`, `clear()`).',
    'color:#888;font-style:italic',
  )
}

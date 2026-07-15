export type ScrollDebugSink = (event: string, payload: unknown) => void

let debugSink: ScrollDebugSink | undefined

export function setScrollDebugSink(sink: ScrollDebugSink | undefined): void {
  debugSink = sink
}

export function hasScrollDebugSink(): boolean {
  return debugSink !== undefined
}

export function logScrollDebug(event: string, payload?: unknown): void {
  debugSink?.(event, payload ?? null)
}

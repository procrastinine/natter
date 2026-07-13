export interface CallOpts {
  signal?: AbortSignal
  overrideHeaders?: Record<string, string>
  retry?: { attempts: number; backoffMs: number }
  timeoutMs?: number
}

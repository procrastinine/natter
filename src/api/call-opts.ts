export interface CallOpts {
  diagnosticId?: string
  signal?: AbortSignal
  overrideHeaders?: Record<string, string>
  timeoutMs?: number
}

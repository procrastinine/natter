export interface BrowserCommandFanoutBudget {
  readonly maxReadRequestRows: number
  readonly maxReadRequestBytes: number
  readonly maxWriteRows: number
  readonly maxWriteBytes: number
}

export const BROWSER_COMMAND_DIRECT_FANOUT_BUDGET: BrowserCommandFanoutBudget = Object.freeze({
  maxReadRequestRows: 64,
  maxReadRequestBytes: 1024 * 1024,
  maxWriteRows: 64,
  maxWriteBytes: 1024 * 1024,
})

export class BrowserCommandFanoutBudgetExceededError extends Error {
  readonly dimension: 'read-request-rows' | 'read-request-bytes' | 'write-rows' | 'write-bytes'
  readonly observed: number
  readonly limit: number
  readonly tableName: string | undefined
  readonly operation: string | undefined

  constructor(
    dimension: 'read-request-rows' | 'read-request-bytes' | 'write-rows' | 'write-bytes',
    observed: number,
    limit: number,
    context?: { readonly tableName: string; readonly operation: string },
  ) {
    super(`BrowserCommandFanoutBudgetExceeded:${dimension}:${observed}:${limit}`)
    this.name = 'BrowserCommandFanoutBudgetExceededError'
    this.dimension = dimension
    this.observed = observed
    this.limit = limit
    this.tableName = context?.tableName
    this.operation = context?.operation
  }
}

export function isBrowserCommandFanoutBudgetExceededError(
  error: unknown,
): error is BrowserCommandFanoutBudgetExceededError {
  if (error instanceof BrowserCommandFanoutBudgetExceededError) return true
  if (error instanceof AggregateError) {
    return error.errors.some(isBrowserCommandFanoutBudgetExceededError)
  }
  return (
    error instanceof Error &&
    error.cause !== undefined &&
    isBrowserCommandFanoutBudgetExceededError(error.cause)
  )
}

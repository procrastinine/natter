import type { Table, Transaction } from 'dexie'

export async function readBulkGetPages<Row, Key>(
  table: Table<Row, Key>,
  keys: readonly Key[],
  options: {
    readonly signal?: AbortSignal
    readonly maxRows?: number
  } = {},
): Promise<Array<Row | undefined>> {
  const rows: Array<Row | undefined> = []
  const maxRows = options.maxRows ?? 256
  for (let offset = 0; offset < keys.length; offset += maxRows) {
    options.signal?.throwIfAborted()
    rows.push(...(await table.bulkGet(keys.slice(offset, offset + maxRows))))
    options.signal?.throwIfAborted()
  }
  return rows
}

export function bindReadonlyTransactionAbort(
  transaction: Transaction,
  signal: AbortSignal | undefined,
  message: string,
): () => void {
  if (!signal) return () => undefined
  const abort = () => abortIndexedDbTransactionAtCancellationBoundary(transaction)
  if (signal.aborted) {
    abort()
    throw new DOMException(message, 'AbortError')
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}

export function abortIndexedDbTransactionAtCancellationBoundary(transaction: Transaction): void {
  if (!transaction.active) return
  try {
    transaction.abort()
  } catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error
  }
}

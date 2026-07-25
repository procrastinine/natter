import Dexie from 'dexie'
import { estimateStoredValueBytes } from './storage-size-estimate'

export interface BoundedIdbCursorEntry<Row> {
  readonly key: IDBValidKey
  readonly primaryKey: IDBValidKey
  readonly value: Row
  readonly estimatedBytes: number
}

export interface BoundedIdbCursorPage<Row> {
  readonly entries: readonly BoundedIdbCursorEntry<Row>[]
  readonly estimatedBytes: number
}

export interface BoundedIdbKeyedPairEntry<Left, Right> {
  readonly key: IDBValidKey
  readonly left?: BoundedIdbCursorEntry<Left>
  readonly right?: BoundedIdbCursorEntry<Right>
  readonly estimatedBytes: number
}

export interface BoundedIdbKeyedPairPage<Left, Right> {
  readonly entries: readonly BoundedIdbKeyedPairEntry<Left, Right>[]
  readonly estimatedBytes: number
}

export interface IdbCursorSource {
  openCursor(
    query?: IDBValidKey | IDBKeyRange | null,
    direction?: IDBCursorDirection,
  ): IDBRequest<IDBCursorWithValue | null>
}

export interface BoundedIdbCursorReader<Row> {
  next(): Promise<BoundedIdbCursorEntry<Row> | undefined>
}

interface BoundedIdbCursorOptions<Row> {
  readonly maxRows: number
  readonly maxBytes: number
  readonly query?: IDBValidKey | IDBKeyRange | null
  readonly direction?: IDBCursorDirection
  readonly operation: string
  readonly estimateBytes?: (value: Row) => number
  readonly onPageVisited?: (page: BoundedIdbCursorPage<Row>) => void
  readonly onFinalPageVisited?: () => void
}

export interface BoundedBatchWriter<Row> {
  add(row: Row): Promise<void>
  flush(): Promise<void>
}

export function createBoundedBatchWriter<Row>(options: {
  readonly maxRows: number
  readonly maxBytes: number
  readonly operation: string
  readonly write: (rows: readonly Row[]) => Promise<void>
  readonly estimateBytes?: (value: Row) => number
}): BoundedBatchWriter<Row> {
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows <= 0) {
    throw new Error(`BoundedBatchWriterMaxRowsInvalid:${options.operation}`)
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`BoundedBatchWriterMaxBytesInvalid:${options.operation}`)
  }
  const estimate = options.estimateBytes ?? estimateStoredValueBytes
  let rows: Row[] = []
  let estimatedBytes = 0
  const flush = async (): Promise<void> => {
    if (rows.length === 0) return
    const page = rows
    rows = []
    estimatedBytes = 0
    await options.write(page)
  }
  return {
    add: async (row) => {
      const rowBytes = estimate(row)
      if (!Number.isSafeInteger(rowBytes) || rowBytes < 0) {
        throw new Error(`BoundedBatchWriterEstimateInvalid:${options.operation}`)
      }
      if (
        rows.length > 0 &&
        (rows.length >= options.maxRows || estimatedBytes + rowBytes > options.maxBytes)
      ) {
        await flush()
      }
      rows.push(row)
      estimatedBytes = Math.min(Number.MAX_SAFE_INTEGER, estimatedBytes + rowBytes)
      if (rows.length >= options.maxRows || estimatedBytes >= options.maxBytes) await flush()
    },
    flush,
  }
}

export async function forEachBoundedIdbCursorPage<Row>(
  source: IdbCursorSource,
  options: BoundedIdbCursorOptions<Row>,
  visit: (page: BoundedIdbCursorPage<Row>) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows <= 0) {
    throw new Error(`BoundedIdbCursorMaxRowsInvalid:${options.operation}`)
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`BoundedIdbCursorMaxBytesInvalid:${options.operation}`)
  }
  const estimate = options.estimateBytes ?? estimateStoredValueBytes
  const reader = openBoundedIdbCursorReader<Row>(
    source.openCursor(options.query ?? null, options.direction ?? 'next'),
    options.operation,
    estimate,
  )
  await forEachBoundedIdbCursorReaderPage(reader, options, visit)
}

export async function forEachBoundedIdbCursorReaderPage<Row>(
  reader: BoundedIdbCursorReader<Row>,
  options: Pick<
    BoundedIdbCursorOptions<Row>,
    'maxRows' | 'maxBytes' | 'operation' | 'onPageVisited' | 'onFinalPageVisited'
  >,
  visit: (page: BoundedIdbCursorPage<Row>) => Promise<void>,
  initial?: Promise<BoundedIdbCursorEntry<Row> | undefined>,
): Promise<void> {
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows <= 0) {
    throw new Error(`BoundedIdbCursorMaxRowsInvalid:${options.operation}`)
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`BoundedIdbCursorMaxBytesInvalid:${options.operation}`)
  }
  let current = await (initial ?? reader.next())
  if (!current) {
    options.onFinalPageVisited?.()
    return
  }
  while (current) {
    const entries: BoundedIdbCursorEntry<Row>[] = []
    let estimatedBytes = 0
    while (current && entries.length < options.maxRows) {
      if (entries.length > 0 && estimatedBytes + current.estimatedBytes > options.maxBytes) {
        break
      }
      entries.push(current)
      estimatedBytes = Math.min(Number.MAX_SAFE_INTEGER, estimatedBytes + current.estimatedBytes)
      current = await reader.next()
    }
    const page = { entries, estimatedBytes }
    await visit(page)
    options.onPageVisited?.(page)
    if (!current) options.onFinalPageVisited?.()
  }
}

export async function forEachBoundedIdbKeyedPairPage<Left, Right>(
  leftStore: IDBObjectStore,
  rightStore: IDBObjectStore,
  options: {
    readonly maxRows: number
    readonly maxBytes: number
    readonly operation: string
    readonly estimateLeftBytes?: (value: Left) => number
    readonly estimateRightBytes?: (value: Right) => number
    readonly onPageVisited?: (page: BoundedIdbKeyedPairPage<Left, Right>) => void
  },
  visit: (page: BoundedIdbKeyedPairPage<Left, Right>) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(options.maxRows) || options.maxRows <= 0) {
    throw new Error(`BoundedIdbKeyedPairMaxRowsInvalid:${options.operation}`)
  }
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new Error(`BoundedIdbKeyedPairMaxBytesInvalid:${options.operation}`)
  }
  const leftReader = openBoundedIdbCursorReader<Left>(
    leftStore.openCursor(),
    `${options.operation}:left`,
    options.estimateLeftBytes ?? estimateStoredValueBytes,
  )
  const rightReader = openBoundedIdbCursorReader<Right>(
    rightStore.openCursor(),
    `${options.operation}:right`,
    options.estimateRightBytes ?? estimateStoredValueBytes,
  )
  let left = await leftReader.next()
  let right = await rightReader.next()
  while (left || right) {
    const entries: BoundedIdbKeyedPairEntry<Left, Right>[] = []
    let estimatedBytes = 0
    while ((left || right) && entries.length < options.maxRows) {
      const order = left && right ? indexedDB.cmp(left.primaryKey, right.primaryKey) : left ? -1 : 1
      const entryLeft = order <= 0 ? left : undefined
      const entryRight = order >= 0 ? right : undefined
      const key = entryLeft?.primaryKey ?? entryRight?.primaryKey
      if (key === undefined) throw new Error(`BoundedIdbKeyedPairKeyMissing:${options.operation}`)
      const entryBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        (entryLeft?.estimatedBytes ?? 0) + (entryRight?.estimatedBytes ?? 0),
      )
      if (entries.length > 0 && estimatedBytes + entryBytes > options.maxBytes) break
      entries.push({
        key,
        ...(entryLeft ? { left: entryLeft } : {}),
        ...(entryRight ? { right: entryRight } : {}),
        estimatedBytes: entryBytes,
      })
      estimatedBytes = Math.min(Number.MAX_SAFE_INTEGER, estimatedBytes + entryBytes)
      if (order <= 0) left = await leftReader.next()
      if (order >= 0) right = await rightReader.next()
    }
    const page = { entries, estimatedBytes }
    await visit(page)
    options.onPageVisited?.(page)
  }
}

export function openBoundedIdbCursorReader<Row>(
  request: IDBRequest<IDBCursorWithValue | null>,
  operation: string,
  estimate: (value: Row) => number = estimateStoredValueBytes,
): BoundedIdbCursorReader<Row> {
  let current: IDBCursorWithValue | null = null
  let started = false
  let finished = false
  return {
    next: () =>
      new Dexie.Promise((resolve, reject) => {
        if (finished) {
          resolve(undefined)
          return
        }
        request.onerror = () =>
          reject(request.error ?? new Error(`BoundedIdbCursorFailed:${operation}`))
        request.onsuccess = () => {
          try {
            current = request.result
            if (!current) {
              finished = true
              resolve(undefined)
              return
            }
            const value = current.value as Row
            const estimatedBytes = estimate(value)
            if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes < 0) {
              finished = true
              reject(new Error(`BoundedIdbCursorEstimateInvalid:${operation}`))
              return
            }
            resolve({
              key: current.key,
              primaryKey: current.primaryKey,
              value,
              estimatedBytes,
            })
          } catch (error) {
            finished = true
            reject(
              error instanceof Error
                ? error
                : new Error(`BoundedIdbCursorReadFailed:${operation}`, { cause: error }),
            )
          }
        }
        if (started) {
          if (!current) {
            reject(new Error(`BoundedIdbCursorStateInvalid:${operation}`))
            return
          }
          current.continue()
        } else {
          started = true
        }
      }),
  }
}

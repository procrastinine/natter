import {
  type CanonicalStreamJournalFrameRow,
  estimateStreamJournalV83FrameStorageBytes,
} from './stream-journal-codec'

const ESTIMATED_ROW_OVERHEAD_BYTES = 128

export function estimateStreamJournalFrameStorageBytes(
  row: CanonicalStreamJournalFrameRow,
): number {
  return estimateStreamJournalV83FrameStorageBytes(row)
}

export function estimateMessageBodyProjectionStorageBytes(header: {
  readonly bodyTextCharCount: number
  readonly bodyRenderCost: number
}): number {
  return saturatingSum([
    ESTIMATED_ROW_OVERHEAD_BYTES,
    2 * Math.max(0, header.bodyTextCharCount),
    2 * 120 * Math.max(1, header.bodyRenderCost),
  ])
}

export function estimateAttachmentPayloadProjectionStorageBytes(header: {
  readonly sizeBytes?: number
  readonly textCharCount?: number
}): number {
  return saturatingSum([
    ESTIMATED_ROW_OVERHEAD_BYTES,
    Math.max(0, header.sizeBytes ?? 0),
    2 * Math.max(0, header.textCharCount ?? 0),
  ])
}

export function estimateDeletedCompactRowsStorageBytes(rowCount: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, rowCount) * ESTIMATED_ROW_OVERHEAD_BYTES)
}

export function estimateStoredValueBytes(root: unknown): number {
  const stack: unknown[] = [root]
  const seen = new Set<object>()
  let bytes = 0
  while (stack.length > 0) {
    const value = stack.pop()
    if (value === null || value === undefined) {
      bytes += 4
    } else if (typeof value === 'string') {
      bytes += 2 * value.length
    } else if (typeof value === 'number' || typeof value === 'bigint') {
      bytes += 8
    } else if (typeof value === 'boolean') {
      bytes += 4
    } else if (typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      if (typeof Blob !== 'undefined' && value instanceof Blob) {
        bytes += value.size
      } else if (ArrayBuffer.isView(value)) {
        bytes += value.byteLength
      } else if (value instanceof ArrayBuffer) {
        bytes += value.byteLength
      } else if (Array.isArray(value)) {
        bytes += 16 + value.length * 8
        for (let index = value.length - 1; index >= 0; index -= 1) stack.push(value[index])
      } else {
        bytes += 32
        for (const [key, nested] of Object.entries(value)) {
          bytes += 2 * key.length + 8
          stack.push(nested)
        }
      }
    }
  }
  return bytes
}

function saturatingSum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total = Math.min(Number.MAX_SAFE_INTEGER, total + value)
  return total
}

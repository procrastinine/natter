import type { Transaction } from 'dexie'
import type { MessageHeaderRow } from '../store/message-storage'
import type { StreamChunkRow, StreamLeaseRow } from '../store/repository'
import { readBrowserWorkspaceMetaFromTransaction } from '../store/workspace-meta'
import { forEachTableBatch } from './batched-table'

type LeaseTargetHeader = Pick<MessageHeaderRow, 'generation' | 'nodeVersion'>

function classifyLegacyStreamLeaseAttempt(
  lease: StreamLeaseRow,
  header: LeaseTargetHeader | undefined,
): StreamLeaseRow {
  if (lease.attemptKind !== undefined) return structuredClone(lease)

  const next = structuredClone(lease)
  if (header?.generation && header.generation.finishedAt === undefined) {
    next.attemptKind = 'generation'
    return next
  }

  next.attemptKind = 'continuation'
  if (header && Number.isSafeInteger(header.nodeVersion) && header.nodeVersion >= 0) {
    next.baseNodeVersion = header.nodeVersion
  }
  return next
}

export async function migrateStreamLeaseAttempts(tx: Transaction): Promise<void> {
  const leases = tx.table<StreamLeaseRow, string>('streamLeases')
  const messages = tx.table<MessageHeaderRow, string>('messages')
  const replacementEpoch = (await readBrowserWorkspaceMetaFromTransaction(tx)).replacementEpoch
  const fencesByStreamId = new Map<string, { fenceToken: string; replacementEpoch: number }>()
  await forEachTableBatch(leases, async (rows) => {
    const messageIds = [
      ...new Set(
        rows.flatMap((lease) =>
          lease.attemptKind === undefined && lease.messageId ? [lease.messageId] : [],
        ),
      ),
    ]
    const headersById = new Map<string, MessageHeaderRow>()
    for (const header of await messages.bulkGet(messageIds)) {
      if (header) headersById.set(header.id, header)
    }
    const normalizedLeases = rows.map((lease) => {
      const classified =
        lease.attemptKind === undefined
          ? classifyLegacyStreamLeaseAttempt(
              lease,
              lease.messageId ? headersById.get(lease.messageId) : undefined,
            )
          : structuredClone(lease)
      const storedReplacementEpoch = nonNegativeSafeInteger(classified.replacementEpoch)
      return {
        ...classified,
        fenceToken:
          typeof classified.fenceToken === 'string'
            ? classified.fenceToken
            : `legacy:${classified.streamId}`,
        replacementEpoch: storedReplacementEpoch ?? replacementEpoch,
      }
    })
    if (normalizedLeases.length > 0) await leases.bulkPut(normalizedLeases)
    for (const lease of normalizedLeases) {
      fencesByStreamId.set(lease.streamId, {
        fenceToken: lease.fenceToken,
        replacementEpoch: lease.replacementEpoch,
      })
    }
  })
  await tx
    .table<StreamChunkRow, string>('streamChunks')
    .toCollection()
    .modify((chunk) => {
      const leaseFence = fencesByStreamId.get(chunk.streamId)
      const storedReplacementEpoch = nonNegativeSafeInteger(chunk.replacementEpoch)
      chunk.fenceToken =
        typeof chunk.fenceToken === 'string'
          ? chunk.fenceToken
          : (leaseFence?.fenceToken ?? `legacy:${chunk.streamId}`)
      chunk.replacementEpoch =
        storedReplacementEpoch ?? leaseFence?.replacementEpoch ?? replacementEpoch
    })
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

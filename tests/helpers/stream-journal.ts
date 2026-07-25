import type { Transaction } from 'dexie'
import type { CanonicalStreamEventV2 } from '../../src/core/generation-stream-events'
import type { ChatId, MessageId } from '../../src/core/types'
import { runBrowserCommandTransaction } from '../../src/store/browser-command-mutation-journal'
import type { NatterDb } from '../../src/store/db'
import {
  persistStreamEventV2,
  requirePersistedStreamEventV2,
} from '../../src/store/persisted-stream-event'
import {
  assertPhysicalTransactionTablesDeclared,
  bindFencedTransaction,
  type CapabilityTables,
  type FencedTransaction,
  physicalTransactionPlan,
} from '../../src/store/physical-storage-tables'
import {
  requireStreamLeaseRow,
  type StreamLeaseRow,
  type StreamWriteFence,
  streamLeaseHasWriteFence,
} from '../../src/store/repository'
import { registerPhysicalMutationTransaction } from '../../src/store/storage-compaction-state'
import { estimateStreamJournalFrameStorageBytes } from '../../src/store/storage-size-estimate'
import type { StreamJournalFrameAppendPort } from '../../src/store/stream-chunk-writer'
import {
  type CanonicalStreamJournalFrameBatch,
  type CanonicalStreamJournalFrameRow,
  canonicalStreamJournalFrameBatch,
  createStreamJournalFrameCursor,
  requireCanonicalStreamJournalFrame,
  type StreamJournalDecodedEntry,
  StreamJournalFrameDecoder,
  type StreamJournalSemanticEntry,
  type StreamJournalStableIdentity,
} from '../../src/store/stream-journal-codec'
import { STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY } from '../../src/store/stream-journal-storage'
import { streamWriteFenceForLease } from '../../src/store/stream-leases'
import { getWorkspaceRepository } from '../../src/store/workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from '../../src/store/workspace-runtime'

const TEST_STREAM_JOURNAL_PLAN = physicalTransactionPlan(
  STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY,
)

export type TestStreamJournalTransaction = FencedTransaction<
  CapabilityTables<typeof STREAM_JOURNAL_MUTATION_TRANSACTION_CAPABILITY>
>

export interface TestSemanticJournalRow extends StreamJournalDecodedEntry {
  readonly id: string
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly seq: number
  readonly replacementEpoch: number
  readonly admissionSequence: number
}

export async function encodeTestStreamJournalEntries(input: {
  readonly streamId: string
  readonly chatId: ChatId
  readonly messageId: MessageId
  readonly fence: StreamWriteFence
  readonly entries: readonly StreamJournalSemanticEntry[]
  readonly startPhysicalSeq?: number
  readonly startLogicalSeq?: number
}): Promise<readonly CanonicalStreamJournalFrameRow[]> {
  const cursor = createStreamJournalFrameCursor(input)
  const frames: CanonicalStreamJournalFrameRow[] = []
  for (;;) {
    const frame = await cursor.current()
    if (!frame) return Object.freeze(frames)
    frames.push(frame)
    cursor.acknowledge(frame)
  }
}

export async function decodeTestStreamJournalFrames(
  frames: readonly CanonicalStreamJournalFrameRow[],
  expected?: StreamJournalStableIdentity,
): Promise<readonly StreamJournalDecodedEntry[]> {
  if (frames.length === 0) return []
  const decoder = new StreamJournalFrameDecoder(expected)
  const entries: StreamJournalDecodedEntry[] = []
  for (const value of frames) {
    const entry = await decoder.accept(requireCanonicalStreamJournalFrame(value))
    if (entry) entries.push(entry)
  }
  decoder.finish({
    allowTruncatedTail: true,
    expectedFinalPhysicalSeq: frames.at(-1)?.seq ?? -1,
  })
  return entries
}

export async function readTestStreamJournalFrames(
  streamId: string,
): Promise<readonly CanonicalStreamJournalFrameRow[]> {
  return runWorkspaceRead('repository-query', async (permit) => {
    const frames: CanonicalStreamJournalFrameRow[] = []
    let afterSeq = -1
    for (;;) {
      const page = (
        await getWorkspaceRepository().query(
          permit,
          {
            kind: 'stream.journal-frame-page',
            streamId,
            afterSeq,
            throughSeq: Number.MAX_SAFE_INTEGER,
          },
          { signal: permit.signal },
        )
      ).value
      frames.push(...page.frames)
      if (page.done) return Object.freeze(frames)
      if (page.nextAfterSeq <= afterSeq) {
        throw new Error(`StreamJournalPageMadeNoProgress:${streamId}`)
      }
      afterSeq = page.nextAfterSeq
    }
  })
}

export async function appendTestStreamJournalEvents(
  lease: StreamLeaseRow,
  events: readonly CanonicalStreamEventV2[],
): Promise<void> {
  if (!streamLeaseHasWriteFence(lease)) throw new Error('ExpectedFencedTestLease')
  const frames = await encodeTestStreamJournalEntries({
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    fence: streamWriteFenceForLease(lease),
    entries: events.map((event, index) => ({
      createdAt: lease.startedAt + index + 1,
      event: persistStreamEventV2(event),
    })),
  })
  await runWorkspaceAction('stream-recovery', (permit) =>
    getWorkspaceRepository().execute(permit, {
      kind: 'stream.append-journal-frames',
      frames,
    }),
  )
}

export async function seedTestStreamJournalEvents(
  db: NatterDb,
  lease: StreamLeaseRow,
  events: readonly CanonicalStreamEventV2[],
): Promise<void> {
  if (!streamLeaseHasWriteFence(lease)) throw new Error('ExpectedFencedTestLease')
  const frames = await encodeTestStreamJournalEntries({
    streamId: lease.streamId,
    chatId: lease.chatId,
    messageId: lease.messageId,
    fence: streamWriteFenceForLease(lease),
    entries: events.map((event, index) => ({
      createdAt: lease.startedAt + index + 1,
      event: persistStreamEventV2(event),
    })),
  })
  await runTestStreamJournalTransaction(db, async (tx) => {
    const leases = tx.table<StreamLeaseRow, string>('streamLeases')
    const stored = await leases.get(lease.streamId)
    if (!stored || !streamLeaseHasWriteFence(stored)) {
      throw new Error('ExpectedStoredFencedTestLease')
    }
    const journalStorageBytes = frames.reduce(
      (total, frame) => total + estimateStreamJournalFrameStorageBytes(frame),
      0,
    )
    const next = requireStreamLeaseRow({
      ...stored,
      journalMaxSeq: frames.at(-1)?.seq ?? -1,
      journalStorageBytes,
    })
    await Promise.all([
      leases.put(next),
      tx.table<CanonicalStreamJournalFrameRow, string>('streamChunks').bulkPut(frames),
    ])
  })
}

export function createLogicalStreamJournalAppendAdapter(input: {
  readonly append: (rows: readonly TestSemanticJournalRow[]) => Promise<void>
  readonly physicalBatches?: CanonicalStreamJournalFrameRow[][]
}): StreamJournalFrameAppendPort {
  const committedByStream = new Map<string, CanonicalStreamJournalFrameRow[]>()
  return {
    async appendStreamJournalFrames(_permit, batch): Promise<void> {
      const first = batch[0]
      if (!first) throw new Error('TestStreamJournalBatchEmpty')
      const prior = committedByStream.get(first.streamId) ?? []
      const incoming = [...batch]
      if (incoming.every((frame) => frame.frameKind === 'inline')) {
        const rows = incoming.map((frame) => ({
          logicalSeq: frame.logicalSeq,
          terminalPhysicalSeq: frame.seq,
          createdAt: frame.createdAt,
          event: structuredClone(requirePersistedStreamEventV2(frame.event).event),
          id: `${frame.streamId}:${frame.logicalSeq}`,
          streamId: frame.streamId,
          chatId: frame.chatId,
          messageId: frame.messageId,
          seq: frame.logicalSeq,
          replacementEpoch: frame.replacementEpoch,
          admissionSequence: frame.admissionSequence,
        }))
        await input.append(rows)
        committedByStream.set(first.streamId, [...prior, ...incoming])
        input.physicalBatches?.push([...batch])
        return
      }
      const expected = {
        streamId: first.streamId,
        chatId: first.chatId,
        messageId: first.messageId,
        replacementEpoch: first.replacementEpoch,
        admissionSequence: first.admissionSequence,
      }
      const [priorEntries, combinedEntries] = await Promise.all([
        decodeTestStreamJournalFrames(prior, expected),
        decodeTestStreamJournalFrames([...prior, ...incoming], expected),
      ])
      const rows = combinedEntries.slice(priorEntries.length).map((entry) => ({
        ...entry,
        event: structuredClone(requirePersistedStreamEventV2(entry.event).event),
        id: `${first.streamId}:${entry.logicalSeq}`,
        streamId: first.streamId,
        chatId: first.chatId,
        messageId: first.messageId,
        seq: entry.logicalSeq,
        replacementEpoch: first.replacementEpoch,
        admissionSequence: first.admissionSequence,
      }))
      await input.append(rows)
      committedByStream.set(first.streamId, [...prior, ...incoming])
      input.physicalBatches?.push([...batch])
    },
  }
}

export function canonicalTestStreamJournalBatch(
  frames: readonly CanonicalStreamJournalFrameRow[],
): CanonicalStreamJournalFrameBatch {
  return canonicalStreamJournalFrameBatch(frames)
}

export async function runTestStreamJournalTransaction<Result>(
  db: NatterDb,
  operation: (tx: TestStreamJournalTransaction) => Promise<Result> | Result,
): Promise<Result> {
  return db.transaction(
    'rw',
    TEST_STREAM_JOURNAL_PLAN.tableNames.map((tableName) => db.table(tableName)),
    async (raw: Transaction) => {
      registerPhysicalMutationTransaction(raw)
      const committed = await runBrowserCommandTransaction(raw, (tracked) =>
        operation(bindFencedTransaction(tracked, TEST_STREAM_JOURNAL_PLAN)),
      )
      assertPhysicalTransactionTablesDeclared(TEST_STREAM_JOURNAL_PLAN, committed.facts.tableNames)
      return committed.value
    },
  )
}

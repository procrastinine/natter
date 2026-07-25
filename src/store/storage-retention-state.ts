import type { AttachmentId, ChatId } from '../core/types'

export interface AttachmentReapCursor {
  readonly unreferencedAt: number
  readonly attachmentId: AttachmentId
}

export interface TerminalStreamJournalCursor {
  readonly terminalRetentionAt: number
  readonly streamId: string
}

export interface TemporaryChatCursor {
  readonly retentionAt: number
  readonly chatId: ChatId
}

export const STORAGE_RETENTION_TASKS = Object.freeze([
  'attachment-reap',
  'terminal-stream-prune',
  'empty-draft-prune',
] as const)

export type StorageRetentionTask = (typeof STORAGE_RETENTION_TASKS)[number]

interface StorageRetentionCursorByTask {
  readonly 'attachment-reap': AttachmentReapCursor
  readonly 'terminal-stream-prune': TerminalStreamJournalCursor
  readonly 'empty-draft-prune': TemporaryChatCursor
}

export type StorageRetentionCursor<Task extends StorageRetentionTask> =
  StorageRetentionCursorByTask[Task]

interface StorageRetentionStateBase<Task extends StorageRetentionTask> {
  readonly task: Task
  readonly formatVersion: 1
  readonly revision: number
}

export type StorageRetentionStateRowFor<Task extends StorageRetentionTask> =
  | (StorageRetentionStateBase<Task> & {
      readonly phase: 'idle'
      readonly earliestDeferredAt?: number
    })
  | (StorageRetentionStateBase<Task> & {
      readonly phase: 'active'
      readonly cycleNow: number
      readonly cutoff: number
      readonly cursor?: StorageRetentionCursor<Task>
    })

export type StorageRetentionStateRow = {
  [Task in StorageRetentionTask]: StorageRetentionStateRowFor<Task>
}[StorageRetentionTask]

export interface StorageRetentionCycle<Task extends StorageRetentionTask> {
  readonly task: Task
  readonly expectedRevision: number
  readonly cycleNow: number
  readonly cutoff: number
  readonly cursor?: StorageRetentionCursor<Task>
}

export function freshStorageRetentionStateRows(): readonly StorageRetentionStateRow[] {
  return [
    freshStorageRetentionStateRow('attachment-reap'),
    freshStorageRetentionStateRow('terminal-stream-prune'),
    freshStorageRetentionStateRow('empty-draft-prune'),
  ]
}

export function freshStorageRetentionStateRow<Task extends StorageRetentionTask>(
  task: Task,
): StorageRetentionStateRowFor<Task> {
  return { task, formatVersion: 1, phase: 'idle', revision: 0 }
}

export async function readStorageRetentionState<Task extends StorageRetentionTask>(
  source: {
    table<Row, Key>(name: string): { get(key: Key): Promise<Row | undefined> }
  },
  task: Task,
): Promise<StorageRetentionStateRowFor<Task>> {
  const row: unknown = await source
    .table<unknown, StorageRetentionTask>('storageRetentionState')
    .get(task)
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`StorageRetentionStateMissing:${task}`)
  }
  const candidate = row as Record<string, unknown>
  if (candidate.formatVersion !== 1 || candidate.task !== task) {
    throw new Error(`StorageRetentionStateInvalid:${task}`)
  }
  return row as StorageRetentionStateRowFor<Task>
}

export function storageRetentionCycle<Task extends StorageRetentionTask>(
  row: StorageRetentionStateRowFor<Task>,
  now: number,
  maxAgeMs: number,
): StorageRetentionCycle<Task> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('StorageRetentionNowInvalid')
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) {
    throw new Error('StorageRetentionMaxAgeInvalid')
  }
  if (row.phase === 'active') {
    return {
      task: row.task,
      expectedRevision: row.revision,
      cycleNow: row.cycleNow,
      cutoff: row.cutoff,
      ...(row.cursor === undefined ? {} : { cursor: structuredClone(row.cursor) }),
    }
  }
  return {
    task: row.task,
    expectedRevision: row.revision,
    cycleNow: now,
    cutoff: Math.max(0, now - maxAgeMs),
  }
}

export function advanceStorageRetentionState<Task extends StorageRetentionTask>(
  cycle: StorageRetentionCycle<Task>,
  outcome:
    | {
        readonly done: false
        readonly cursor?: StorageRetentionCursor<Task>
      }
    | {
        readonly done: true
        readonly earliestDeferredAt?: number
      },
): StorageRetentionStateRowFor<Task> {
  const revision = nextStorageRetentionRevision(cycle.expectedRevision)
  if (outcome.done) {
    return {
      task: cycle.task,
      formatVersion: 1,
      phase: 'idle',
      revision,
      ...(outcome.earliestDeferredAt === undefined
        ? {}
        : { earliestDeferredAt: outcome.earliestDeferredAt }),
    }
  }
  return {
    task: cycle.task,
    formatVersion: 1,
    phase: 'active',
    revision,
    cycleNow: cycle.cycleNow,
    cutoff: cycle.cutoff,
    ...(outcome.cursor === undefined ? {} : { cursor: structuredClone(outcome.cursor) }),
  }
}

export function assertStorageRetentionCycleCurrent<Task extends StorageRetentionTask>(
  row: StorageRetentionStateRowFor<Task>,
  cycle: StorageRetentionCycle<Task>,
): void {
  if (row.task !== cycle.task || row.revision !== cycle.expectedRevision) {
    throw new Error(`StorageRetentionStateChanged:${cycle.task}`)
  }
}

export function nextStorageRetentionRevision(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('StorageRetentionRevisionInvalid')
  }
  return revision === Number.MAX_SAFE_INTEGER ? 0 : revision + 1
}

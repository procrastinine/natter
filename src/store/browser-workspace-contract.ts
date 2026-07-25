import type { BrowserWorkspaceReplacementStorageBaseline } from './browser-workspace-database-control'
import type { NatterDb } from './db'
import type { LockGrant } from './locks'

export interface BrowserWorkspaceSnapshot {
  workspaceId: string
  replacementEpoch: number
}

export interface BrowserWorkspacePreparedReplacement<T> {
  workspace: BrowserWorkspaceSnapshot
  storageBaseline: BrowserWorkspaceReplacementStorageBaseline
  value: T
}

export type BrowserWorkspaceReplacementCommit<T> = BrowserWorkspacePreparedReplacement<T>

export type BrowserWorkspaceReplacementAtomicity = 'in-place-atomic' | 'slotted-staging'

export type BrowserWorkspaceReplacementMutationGrant = LockGrant & {
  readonly atomicity: BrowserWorkspaceReplacementAtomicity
}

export interface BrowserWorkspaceReplacementContext {
  readonly sourceDatabaseName: string
  readonly destinationDatabaseName: string
  readonly atomicity: BrowserWorkspaceReplacementAtomicity
  readonly signal: AbortSignal
  readonly preactivationCheckpoint: () => void
  readonly withSourceDatabase: <T>(operation: (source: NatterDb) => Promise<T>) => Promise<T>
  readonly mutate: <T>(
    operation: (grant: BrowserWorkspaceReplacementMutationGrant) => Promise<T>,
  ) => Promise<T>
}

export type BrowserWorkspaceReplacementOperation<T> = (
  db: NatterDb,
  context: BrowserWorkspaceReplacementContext,
) => Promise<BrowserWorkspacePreparedReplacement<T>>

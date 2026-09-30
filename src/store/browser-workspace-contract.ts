import type { Transaction } from 'dexie'
import type { BrowserWorkspaceReplacementStorageBaseline } from './browser-workspace-database-control'
import type { BrowserWorkspaceOpenTarget } from './browser-workspace-open-contract'
import type { NatterDb } from './db'
import type { LockGrant } from './locks'

export interface BrowserWorkspaceSnapshot {
  workspaceId: string
  replacementEpoch: number
}

export type BrowserWorkspaceReplacementRuntimeRequest =
  | { readonly kind: 'reopen'; readonly target: BrowserWorkspaceOpenTarget }
  | { readonly kind: 'observe-cancellation' }

export type BrowserWorkspaceReplacementReopenOutcome =
  | { readonly kind: 'ready'; readonly workspace: BrowserWorkspaceSnapshot }
  | { readonly kind: 'cancelled-closed'; readonly reason: unknown }

export interface BrowserWorkspacePreparedReplacement<T> {
  workspace: BrowserWorkspaceSnapshot
  storageBaseline: BrowserWorkspaceReplacementStorageBaseline
  publication?: 'replace' | 'deferred'
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

export interface BrowserWorkspaceOnlineReplacementContext {
  readonly sourceDatabaseName: string
  readonly destinationDatabaseName: string
  readonly signal: AbortSignal
  readonly preactivationCheckpoint: () => void
  readonly awaitForegroundIdle: () => Promise<void>
  readonly foregroundInterruptionSignal: () => AbortSignal
  readonly withSourceDatabase: <T>(operation: (source: NatterDb) => Promise<T>) => Promise<T>
  readonly runDestinationTransaction: <T>(
    tableNames: readonly string[],
    operation: (transaction: Transaction) => Promise<T> | T,
  ) => Promise<T>
}

export interface BrowserWorkspaceOnlineReplacementOperation<Prepared, T> {
  prepare(
    this: void,
    db: NatterDb,
    context: BrowserWorkspaceOnlineReplacementContext,
  ): Promise<Prepared>
  refresh(
    db: NatterDb,
    context: BrowserWorkspaceOnlineReplacementContext,
    prepared: Prepared,
  ): Promise<void>
  abandon(sourceDatabaseName: string): Promise<void>
  tryCommit(
    db: NatterDb,
    context: BrowserWorkspaceReplacementContext,
    prepared: Prepared,
  ): Promise<
    | { readonly kind: 'resume-online' }
    | { readonly kind: 'prepared'; readonly replacement: BrowserWorkspacePreparedReplacement<T> }
  >
}

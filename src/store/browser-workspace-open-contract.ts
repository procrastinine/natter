import type { BrowserWorkspaceDatabaseName } from '../lib/origin-storage-names'

export type BrowserWorkspaceMigrationPhase =
  | 'inactive-copy'
  | 'inactive-activation'
  | 'completion-markers-reset'
  | 'singletons'
  | 'configuration-and-chats'
  | 'messages-and-attachments'
  | 'streams'
  | 'derived-state'
  | 'completion-markers-write'

export interface BrowserWorkspaceMigrationProgress {
  readonly phase: BrowserWorkspaceMigrationPhase
  readonly operation: string
  readonly processedRows: number
  readonly processedBytes: number
}

export type BrowserWorkspaceOpenProgress =
  | {
      readonly kind: 'storage-administration'
    }
  | {
      readonly kind: 'database-selection'
      readonly operation:
        | 'read-active-slot'
        | 'wait-for-open-connections'
        | 'acquire-active-slot'
        | 'confirm-active-slot'
        | 'retry-changed-slot'
      readonly databaseName?: BrowserWorkspaceDatabaseName
    }
  | {
      readonly kind: 'schema-preflight'
      readonly databaseName: BrowserWorkspaceDatabaseName
    }
  | {
      readonly kind: 'database-open'
      readonly databaseName: BrowserWorkspaceDatabaseName
      readonly fromVersion?: number
      readonly targetVersion: number
    }
  | ({
      readonly kind: 'database-upgrade'
      readonly databaseName: BrowserWorkspaceDatabaseName
      readonly fromVersion?: number
      readonly targetVersion: number
    } & BrowserWorkspaceMigrationProgress)
  | {
      readonly kind: 'workspace-metadata'
      readonly databaseName: BrowserWorkspaceDatabaseName
    }
  | {
      readonly kind: 'runtime-resources'
      readonly operation: 'reconcile' | 'activate' | 'settle'
    }

export interface BrowserWorkspaceOpenOptions {
  onBlocked?: (event: IDBVersionChangeEvent) => void
  onProgress?: (progress: BrowserWorkspaceOpenProgress) => void
}

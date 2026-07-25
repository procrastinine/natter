import type { BrowserWorkspaceMigrationProgress } from '../store/browser-workspace-open-contract'

export interface WaveAStorageEpochMigrationCapabilitiesV94 {
  readonly observedAt: number
  readonly recordObsoleteBytes: (byteLength: number) => void
  readonly compactionControlTransferPrepared?: boolean
  readonly reportProgress?: (progress: BrowserWorkspaceMigrationProgress) => void
}

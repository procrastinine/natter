import type { BrowserWorkspaceReplacementCommit } from './browser-workspace-contract'

export {
  boundedMaintenanceLimit,
  MAX_STORAGE_MAINTENANCE_BATCH,
} from './storage-maintenance-bounds'

export interface BrowserWorkspaceReplacementHandoff<T> {
  readonly completion: Promise<BrowserWorkspaceReplacementCommit<T>>
}

export type BrowserWorkspaceReplacementStart<T> =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'cleanup-required' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'handoff'; readonly handoff: BrowserWorkspaceReplacementHandoff<T> }

export interface BrowserWorkspaceCompactionResult {
  readonly copiedRows: number
  readonly estimatedLiveBytes: number
}

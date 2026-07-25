import type { BrowserWorkspaceReplacementCommit } from './browser-workspace-contract'

export const MAX_STORAGE_MAINTENANCE_BATCH = 128

export function boundedMaintenanceLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('StorageMaintenanceLimitInvalid')
  }
  return Math.min(value, MAX_STORAGE_MAINTENANCE_BATCH)
}

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

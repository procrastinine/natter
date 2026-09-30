import type { BrowserWorkspaceReplacementOutcome } from './browser-workspace-replacement-transition'

export type BrowserWorkspaceReplacementTerminalOutcome<T> = Exclude<
  BrowserWorkspaceReplacementOutcome<T>,
  { readonly kind: 'online-ready' }
>

export {
  boundedMaintenanceLimit,
  MAX_STORAGE_MAINTENANCE_BATCH,
} from './storage-maintenance-bounds'

export interface BrowserWorkspaceReplacementHandoff<T> {
  readonly completion: Promise<BrowserWorkspaceReplacementTerminalOutcome<T>>
}

export type BrowserWorkspaceReplacementStart<T> =
  | { readonly kind: 'blocked' }
  | { readonly kind: 'cleanup-required' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'cancelled'; readonly reason: unknown }
  | { readonly kind: 'handoff'; readonly handoff: BrowserWorkspaceReplacementHandoff<T> }

export interface BrowserWorkspaceCompactionResult {
  readonly copiedRows: number
  readonly estimatedLiveBytes: number
}

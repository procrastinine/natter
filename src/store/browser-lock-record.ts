export const BROWSER_WRITER_LOCK_NAME = 'workspace-writer'

export interface BrowserLockRow {
  name: string
  ownerClientId: string | null
  leaseId: string | null
  fencingToken: number
  acquiredAt: number
  heartbeatAt: number
  expiresAt: number
}

export function emptyBrowserWriterLockRow(): BrowserLockRow {
  return {
    name: BROWSER_WRITER_LOCK_NAME,
    ownerClientId: null,
    leaseId: null,
    fencingToken: 0,
    acquiredAt: 0,
    heartbeatAt: 0,
    expiresAt: 0,
  }
}

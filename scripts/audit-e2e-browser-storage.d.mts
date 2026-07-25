export type E2eStoragePurpose =
  | 'fault-injection'
  | 'read-only-assertion'
  | 'reset'
  | 'legacy-fixture'
  | 'physical-reclamation'

export interface E2eBrowserStorageSite {
  id: string
  path: string
  owner: string
  api: string
  access: string
  operation: string
  mode: string | null
  store: string | null
  line: number
  column: number
  occurrence: number
  cleanupEffects?: string[]
}

export interface E2eBrowserStorageAuditResult {
  ok: boolean
  schemaVersion: unknown
  discoveredSiteCount: number
  allowedSiteCount: number
  uniqueAllowedSiteCount: number
  accessCounts: Record<string, number>
  apiCounts: Record<string, number>
  operationCounts: Record<string, number>
  cleanupEvidenceSiteCount: number
  readwriteTransactionCount: number
  missingSiteIds: string[]
  staleSiteIds: string[]
  duplicateSiteIds: Array<{ id: string; count: number }>
  unpairedOpenSiteIds: string[]
  sites: E2eBrowserStorageSite[]
  violations: Array<{ code: string; detail: string; siteId?: string }>
}

export const DEFAULT_E2E_STORAGE_INVENTORY_PATH: string
export const E2E_STORAGE_PURPOSES: E2eStoragePurpose[]

export function discoverE2eBrowserStorageSites(rootDirectory?: string): E2eBrowserStorageSite[]

export function discoverE2eCleanupEvidenceSites(
  rootDirectory?: string,
): E2eBrowserStorageSite[]

export function validateE2eBrowserStorageInventory(
  inventory: unknown,
  discoveredSites: E2eBrowserStorageSite[],
  cleanupEvidenceSites?: E2eBrowserStorageSite[],
): E2eBrowserStorageAuditResult

export function auditE2eBrowserStorage(
  rootDirectory?: string,
  inventoryPath?: string,
): E2eBrowserStorageAuditResult

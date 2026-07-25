export interface CachedModelsRow {
  profileId: string
  profileRevision: string
  queryKey: string
  fetchedAt: number
  payload: unknown
}

export interface CachedModelsStorageRow {
  profileId: string
  profileRevision: string
  queryKey: string
  fetchedAt: number
  payloadId: string
  payloadByteLength: number
}

export interface CachedEndpointsRow {
  profileId: string
  profileRevision: string
  modelId: string
  fetchedAt: number
  payload: unknown
}

export interface CachedEndpointsStorageRow {
  profileId: string
  profileRevision: string
  modelId: string
  fetchedAt: number
  payloadId: string
  payloadByteLength: number
}

export interface CachedPrivacyPolicyRow {
  profileId: string
  profileRevision: string
  modelId: string
  fetchedAt: number
  payload: unknown
}

export interface CachedPrivacyPolicyStorageRow {
  profileId: string
  profileRevision: string
  modelId: string
  fetchedAt: number
  payloadId: string
  payloadByteLength: number
}

export interface DiscoveryPayloadStorageRow {
  id: string
  canonicalJson: string
  byteLength: number
}

export interface DiscoveryPayloadMetadataStorageRow {
  id: string
  byteLength: number
  referenceCount: number
  lastReferencedAt: number
}

type DiscoveryCacheStorageTableName = 'models' | 'endpoints' | 'privacyPolicies'

export interface DiscoveryCacheAuditStorageRow {
  phase: DiscoveryCacheStorageTableName | 'metadata' | 'payloads'
  afterKey?: string | [string, string]
  headerCounts: Record<DiscoveryCacheStorageTableName, number>
  payloadCount: number
  payloadByteLength: number
}

export interface DiscoveryCacheStateStorageRow {
  id: 'global'
  formatVersion: 1
  valid: boolean
  headerCounts: Record<DiscoveryCacheStorageTableName, number>
  payloadCount: number
  payloadByteLength: number
  audit?: DiscoveryCacheAuditStorageRow
}

export interface SettingsRow {
  key: string
  value: unknown
}

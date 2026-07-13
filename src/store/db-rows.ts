export interface CachedModelsRow {
  profileId: string
  queryKey: string
  fetchedAt: number
  payload: unknown
}

export interface CachedEndpointsRow {
  profileId: string
  modelId: string
  fetchedAt: number
  payload: unknown
}

export interface CachedPrivacyPolicyRow {
  profileId: string
  modelId: string
  fetchedAt: number
  payload: unknown
}

export interface CachedProvidersRow {
  profileId: string
  fetchedAt: number
  payload: unknown
}

export interface SettingsRow {
  key: string
  value: unknown
}

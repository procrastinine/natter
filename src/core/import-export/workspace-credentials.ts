import { connectionDispatchFallbackKeyRefs } from '../connection-dispatch-proof'
import type { ConnectionProfile, KeyId, KeyRecord } from '../types'
import type { WorkspaceBackupPayload } from './schema'

const INSTALL_SECRET_SETTING_KEY = 'install-secret'

export function normalizeWorkspaceCredentialReferences(
  payload: WorkspaceBackupPayload,
): WorkspaceBackupPayload {
  const usableKeyIds = usableWorkspaceKeyIds(payload.keys, payload.settings)
  let profiles: ConnectionProfile[] | undefined
  for (let index = 0; index < payload.profiles.length; index += 1) {
    const current = payload.profiles[index] as ConnectionProfile
    const next = normalizeProfileCredentialReferences(current, usableKeyIds)
    if (profiles) profiles.push(next)
    else if (next !== current) profiles = [...payload.profiles.slice(0, index), next]
  }
  return profiles ? { ...payload, profiles } : payload
}

function usableWorkspaceKeyIds(
  keys: readonly KeyRecord[],
  settings: WorkspaceBackupPayload['settings'],
): ReadonlySet<KeyId> {
  const installSecret = settings.find((row) => row.key === INSTALL_SECRET_SETTING_KEY)?.value
  const hasInstallSecret = typeof installSecret === 'string' && installSecret.length > 0
  const usable = new Set<KeyId>()
  for (const key of keys) {
    if (key.passphraseHint !== undefined || hasInstallSecret) usable.add(key.id)
  }
  return usable
}

function normalizeProfileCredentialReferences(
  profile: ConnectionProfile,
  usableKeyIds: ReadonlySet<KeyId>,
): ConnectionProfile {
  const primary = usableReference(profile.apiKeyRef, usableKeyIds)
  const management = usableReference(profile.managementApiKeyRef, usableKeyIds)
  const filteredFallback = profile.apiKeyFallbackRefs?.filter((keyId) => usableKeyIds.has(keyId))
  const normalizedFallbackValues = connectionDispatchFallbackKeyRefs({
    ...(primary ? { apiKeyRef: primary } : {}),
    ...(filteredFallback ? { apiKeyFallbackRefs: filteredFallback } : {}),
  })
  const normalizedFallback =
    normalizedFallbackValues.length > 0 ? normalizedFallbackValues : undefined
  if (
    primary === profile.apiKeyRef &&
    management === profile.managementApiKeyRef &&
    sameOptionalStrings(normalizedFallback, profile.apiKeyFallbackRefs)
  ) {
    return profile
  }
  const next = { ...profile }
  if (primary === undefined) delete next.apiKeyRef
  else next.apiKeyRef = primary
  if (management === undefined) delete next.managementApiKeyRef
  else next.managementApiKeyRef = management
  if (normalizedFallback === undefined) delete next.apiKeyFallbackRefs
  else next.apiKeyFallbackRefs = normalizedFallback
  return next
}

function usableReference(
  keyId: KeyId | undefined,
  usableKeyIds: ReadonlySet<KeyId>,
): KeyId | undefined {
  return keyId !== undefined && usableKeyIds.has(keyId) ? keyId : undefined
}

function sameOptionalStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.length === right.length && left.every((value, index) => value === right[index])
}

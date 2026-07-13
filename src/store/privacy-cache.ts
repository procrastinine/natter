// Scraped `data_policy` rows are keyed by `(profileId, modelId)` because the
// scrape target is the per-model providers page; the providers directory is a
// single cache row per profile.

import type { ConnectionProfile, ProfileId } from '../core/types'
import { onEvent, postEvent } from './broadcast'
import { type CachedPrivacyPolicyRow, type CachedProvidersRow, getDb } from './db'
import { withNamedLock } from './locks'
import { readBrowserWorkspaceMeta, readBrowserWorkspaceMetaFromTransaction } from './workspace-meta'

export type { CachedPrivacyPolicyRow } from './db'

export const PRIVACY_POLICY_TTL_MS = 24 * 60 * 60 * 1000
export const EMPTY_PRIVACY_POLICY_RETRY_MS = 5 * 60 * 1000

export async function getCachedPrivacyPolicy(
  profileId: ProfileId,
  modelId: string,
): Promise<CachedPrivacyPolicyRow | undefined> {
  return getDb().privacyPolicies.get([profileId, modelId])
}

export async function putCachedPrivacyPolicy(
  profileId: ProfileId,
  modelId: string,
  payload: unknown,
  fetchedAt: number = Date.now(),
): Promise<void> {
  await getDb().privacyPolicies.put({ profileId, modelId, fetchedAt, payload })
  postEvent({ kind: 'privacy-refreshed', profileId, modelId })
}

export async function clearPrivacyPoliciesForProfile(profileId: ProfileId): Promise<void> {
  const db = getDb()
  await db.privacyPolicies.where('profileId').equals(profileId).delete()
}

export async function getCachedProviders(
  profileId: ProfileId,
): Promise<CachedProvidersRow | undefined> {
  return getDb().providers.get(profileId)
}

export async function putCachedProviders(
  profileId: ProfileId,
  payload: unknown,
  fetchedAt: number = Date.now(),
): Promise<void> {
  await getDb().providers.put({ profileId, fetchedAt, payload })
}

export async function clearProvidersForProfile(profileId: ProfileId): Promise<void> {
  const db = getDb()
  await db.providers.delete(profileId)
}

// In-memory in-flight dedup for privacy scrapes. Same rationale as
// `dedupedEndpointsFetch` in `models-cache.ts`: two sibling components
// (header badge + provider picker) opening at the same time would
// otherwise fire two scrapes against the same (profile, model). The
// Map shares one Promise inside a tab. Cross-tab callers can fetch in
// parallel, then the short commit lock preserves a freshly committed result.
const privacyInFlight = new Map<string, Promise<void>>()
let workspaceEpoch = 0
let unsubscribe: (() => void) | null = null

function ensureWorkspaceListener(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => {
    if (event.kind === 'workspace-replaced') {
      workspaceEpoch += 1
      privacyInFlight.clear()
    } else if (event.kind === 'workspace-invalidated') {
      privacyInFlight.clear()
    }
  })
}

export interface DedupedPrivacyFetchOptions {
  force?: boolean
  isCachedFresh?: (row: CachedPrivacyPolicyRow | undefined) => boolean
}

function privacyCacheKey(profileId: ProfileId, modelId: string): string {
  return `${profileId}\u0000${modelId}`
}

function privacyLockName(profileId: ProfileId, modelId: string): string {
  return `privacy-policy:${profileId}:${modelId}`
}

export function dedupedPrivacyFetch(
  profileId: ProfileId,
  modelId: string,
  fetchPayload: () => Promise<unknown>,
  opts: DedupedPrivacyFetchOptions = {},
): Promise<void> {
  ensureWorkspaceListener()
  const key = privacyCacheKey(profileId, modelId)
  const existing = privacyInFlight.get(key)
  if (existing) return existing
  const promise = (async () => {
    const epoch = workspaceEpoch
    const replacementEpoch = (await readBrowserWorkspaceMeta(getDb())).replacementEpoch
    const profileFingerprint = fingerprint(await getDb().profiles.get(profileId))
    if (!opts.force && opts.isCachedFresh?.(await getCachedPrivacyPolicy(profileId, modelId))) {
      return
    }
    const payload = await fetchPayload()
    if (epoch !== workspaceEpoch) return
    const committed = await withNamedLock(privacyLockName(profileId, modelId), async (grant) => {
      const db = getDb()
      return grant.runTransaction(
        db,
        [db.privacyPolicies, db.profiles, db.settings],
        async (tx) => {
          const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
          if (meta.replacementEpoch !== replacementEpoch) return false
          const currentProfile = await tx
            .table<ConnectionProfile, ProfileId>('profiles')
            .get(profileId)
          if (fingerprint(currentProfile) !== profileFingerprint) return false
          const table = tx.table<CachedPrivacyPolicyRow, [string, string]>('privacyPolicies')
          const cached = await table.get([profileId, modelId])
          if (!opts.force && opts.isCachedFresh?.(cached)) return false
          await table.put({
            profileId,
            modelId,
            fetchedAt: Date.now(),
            payload,
          })
          return true
        },
      )
    })
    if (committed) {
      postEvent({ kind: 'privacy-refreshed', profileId, modelId })
    }
  })()
  privacyInFlight.set(key, promise)
  const clear = () => {
    if (privacyInFlight.get(key) === promise) privacyInFlight.delete(key)
  }
  void promise.then(clear, clear)
  return promise
}

// Test-only reset — wipes the in-flight map so a fresh test can observe
// its own dedup behavior without contamination from an earlier case.
export function __resetPrivacyInFlightForTests(): void {
  privacyInFlight.clear()
  workspaceEpoch = 0
  unsubscribe?.()
  unsubscribe = null
}

function fingerprint(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

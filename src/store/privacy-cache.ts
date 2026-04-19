// Cached scraped privacy data + `/providers` directory. See
// `plan/03-storage.md §3.12` and `plan/09-privacy.md §9.6`.
//
// Scraped `data_policy` rows are keyed by `(profileId, modelId)` because the
// scrape target is the per-model providers page; the providers directory is a
// single cache row per profile.

import type { ProfileId } from '../core/types'
import { postEvent } from './broadcast'
import { type CachedPrivacyPolicyRow, type CachedProvidersRow, getDb } from './db'

export const PRIVACY_POLICY_TTL_MS = 24 * 60 * 60 * 1000
export const PROVIDERS_TTL_MS = 24 * 60 * 60 * 1000

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

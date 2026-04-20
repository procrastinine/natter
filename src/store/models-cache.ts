// Cached `/models` and `/endpoints` results. See `plan/03-storage.md §3.12` and
// `plan/07-discovery.md §7.4`.
//
// The cache key for `/models` is the normalized query signature so equivalent
// filters share a row. Endpoints are keyed by `(profileId, modelId)`. Every
// row carries `fetchedAt` for TTL checks; the caller decides the TTL since
// different surfaces tolerate different staleness.

import { modelsCacheKey } from '../core/cache-keys'
import type { ModelsQuery, ProfileId } from '../core/types'
import { postEvent } from './broadcast'
import { type CachedEndpointsRow, type CachedModelsRow, getDb } from './db'

export const MODELS_TTL_MS = 60 * 60 * 1000
export const ENDPOINTS_TTL_MS = 5 * 60 * 1000

export function isFresh(fetchedAt: number, ttlMs: number, now: number = Date.now()): boolean {
  return now - fetchedAt < ttlMs
}

export async function getCachedModels(
  profileId: ProfileId,
  query: ModelsQuery,
): Promise<CachedModelsRow | undefined> {
  const queryKey = modelsCacheKey(query)
  return getDb().models.get([profileId, queryKey])
}

export async function putCachedModels(
  profileId: ProfileId,
  query: ModelsQuery,
  payload: unknown,
  fetchedAt: number = Date.now(),
): Promise<void> {
  const queryKey = modelsCacheKey(query)
  await getDb().models.put({ profileId, queryKey, fetchedAt, payload })
  postEvent({ kind: 'models-refreshed', profileId })
}

export async function clearModelsCacheForProfile(profileId: ProfileId): Promise<void> {
  const db = getDb()
  await db.models.where('profileId').equals(profileId).delete()
  postEvent({ kind: 'models-refreshed', profileId })
}

export async function clearCachedModels(
  profileId: ProfileId,
  query: ModelsQuery,
): Promise<void> {
  const queryKey = modelsCacheKey(query)
  await getDb().models.delete([profileId, queryKey])
  postEvent({ kind: 'models-refreshed', profileId })
}

export async function getCachedEndpoints(
  profileId: ProfileId,
  modelId: string,
): Promise<CachedEndpointsRow | undefined> {
  return getDb().endpoints.get([profileId, modelId])
}

export async function putCachedEndpoints(
  profileId: ProfileId,
  modelId: string,
  payload: unknown,
  fetchedAt: number = Date.now(),
): Promise<void> {
  await getDb().endpoints.put({ profileId, modelId, fetchedAt, payload })
}

export async function clearEndpointsCacheForProfile(profileId: ProfileId): Promise<void> {
  const db = getDb()
  await db.endpoints.where('profileId').equals(profileId).delete()
}

// In-memory in-flight maps. Two sibling components mounting at the same
// time (e.g. Shell + ChatModelPanel both opening against the same chat)
// each run their own refresh effect when the cache is cold; without
// dedup the browser fires two identical requests that both land in
// `putCachedEndpoints`/`putCachedModels`. The Map makes concurrent
// callers share one Promise. Single-tab only — it is not a substitute
// for a Web Lock across tabs, but the Dexie live-query already serializes
// visible writes cross-tab (both tabs' fetches land in the same cache
// row; the losing tab's row is a harmless overwrite).
const modelsInFlight = new Map<string, Promise<void>>()
const endpointsInFlight = new Map<string, Promise<void>>()

export function dedupedModelsFetch(
  profileId: ProfileId,
  query: ModelsQuery,
  fetchPayload: () => Promise<unknown>,
): Promise<void> {
  const key = `${profileId}\u0000${modelsCacheKey(query)}`
  const existing = modelsInFlight.get(key)
  if (existing) return existing
  const promise = (async () => {
    try {
      const payload = await fetchPayload()
      await putCachedModels(profileId, query, payload)
    } finally {
      modelsInFlight.delete(key)
    }
  })()
  modelsInFlight.set(key, promise)
  return promise
}

export function dedupedEndpointsFetch(
  profileId: ProfileId,
  modelId: string,
  fetchPayload: () => Promise<unknown>,
): Promise<void> {
  const key = `${profileId}\u0000${modelId}`
  const existing = endpointsInFlight.get(key)
  if (existing) return existing
  const promise = (async () => {
    try {
      const payload = await fetchPayload()
      await putCachedEndpoints(profileId, modelId, payload)
    } finally {
      endpointsInFlight.delete(key)
    }
  })()
  endpointsInFlight.set(key, promise)
  return promise
}

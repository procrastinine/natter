// The cache key for `/models` is the normalized query signature so equivalent
// filters share a row. Endpoints are keyed by `(profileId, modelId)`. Every
// row carries `fetchedAt` for TTL checks; the caller decides the TTL since
// different surfaces tolerate different staleness.

import { modelsCacheKey } from '../core/cache-keys'
import type { ConnectionProfile, ModelsQuery, ProfileId } from '../core/types'
import { onEvent, postEvent } from './broadcast'
import { type CachedEndpointsRow, type CachedModelsRow, getDb } from './db'
import { withNamedLock } from './locks'
import { readBrowserWorkspaceMeta, readBrowserWorkspaceMetaFromTransaction } from './workspace-meta'

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

export async function clearCachedModels(profileId: ProfileId, query: ModelsQuery): Promise<void> {
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
// for a Web Lock across tabs (both tabs' fetches can land in the same cache
// row; the losing tab's row is a harmless overwrite).
const modelsInFlight = new Map<string, Promise<void>>()
const endpointsInFlight = new Map<string, Promise<void>>()
let workspaceEpoch = 0
let unsubscribe: (() => void) | null = null

function ensureWorkspaceListener(): void {
  if (unsubscribe) return
  unsubscribe = onEvent((event) => {
    if (event.kind === 'workspace-replaced') {
      workspaceEpoch += 1
      modelsInFlight.clear()
      endpointsInFlight.clear()
    } else if (event.kind === 'workspace-invalidated') {
      modelsInFlight.clear()
      endpointsInFlight.clear()
    }
  })
}

export function dedupedModelsFetch(
  profileId: ProfileId,
  query: ModelsQuery,
  fetchPayload: () => Promise<unknown>,
): Promise<void> {
  ensureWorkspaceListener()
  const key = `${profileId}\u0000${modelsCacheKey(query)}`
  const existing = modelsInFlight.get(key)
  if (existing) return existing
  const promise = (async () => {
    const epoch = workspaceEpoch
    const replacementEpoch = await currentReplacementEpoch()
    const profileFingerprint = await currentProfileFingerprint(profileId)
    const payload = await fetchPayload()
    if (epoch !== workspaceEpoch) return
    const queryKey = modelsCacheKey(query)
    const committed = await commitCacheIfWorkspaceUnchanged({
      tableName: 'models',
      lockName: `models-cache:${profileId}:${queryKey}`,
      profileId,
      profileFingerprint,
      replacementEpoch,
      row: { profileId, queryKey, fetchedAt: Date.now(), payload },
    })
    if (committed) postEvent({ kind: 'models-refreshed', profileId })
  })()
  modelsInFlight.set(key, promise)
  const clear = () => {
    if (modelsInFlight.get(key) === promise) modelsInFlight.delete(key)
  }
  void promise.then(clear, clear)
  return promise
}

export function dedupedEndpointsFetch(
  profileId: ProfileId,
  modelId: string,
  fetchPayload: () => Promise<unknown>,
): Promise<void> {
  ensureWorkspaceListener()
  const key = `${profileId}\u0000${modelId}`
  const existing = endpointsInFlight.get(key)
  if (existing) return existing
  const promise = (async () => {
    const epoch = workspaceEpoch
    const replacementEpoch = await currentReplacementEpoch()
    const profileFingerprint = await currentProfileFingerprint(profileId)
    const payload = await fetchPayload()
    if (epoch !== workspaceEpoch) return
    await commitCacheIfWorkspaceUnchanged({
      tableName: 'endpoints',
      lockName: `endpoints-cache:${profileId}:${modelId}`,
      profileId,
      profileFingerprint,
      replacementEpoch,
      row: { profileId, modelId, fetchedAt: Date.now(), payload },
    })
  })()
  endpointsInFlight.set(key, promise)
  const clear = () => {
    if (endpointsInFlight.get(key) === promise) endpointsInFlight.delete(key)
  }
  void promise.then(clear, clear)
  return promise
}

async function commitCacheIfWorkspaceUnchanged(input: {
  tableName: 'models' | 'endpoints'
  lockName: string
  profileId: ProfileId
  profileFingerprint: string | null
  replacementEpoch: number
  row: CachedModelsRow | CachedEndpointsRow
}): Promise<boolean> {
  return withNamedLock(input.lockName, async (grant) => {
    const db = getDb()
    return grant.runTransaction(
      db,
      [db.table(input.tableName), db.profiles, db.settings],
      async (tx) => {
        const meta = await readBrowserWorkspaceMetaFromTransaction(tx)
        if (meta.replacementEpoch !== input.replacementEpoch) return false
        const current = await tx
          .table<ConnectionProfile, ProfileId>('profiles')
          .get(input.profileId)
        if (fingerprint(current) !== input.profileFingerprint) return false
        await tx.table(input.tableName).put(input.row)
        return true
      },
    )
  })
}

async function currentReplacementEpoch(): Promise<number> {
  return (await readBrowserWorkspaceMeta(getDb())).replacementEpoch
}

async function currentProfileFingerprint(profileId: ProfileId): Promise<string | null> {
  return fingerprint(await getDb().profiles.get(profileId))
}

function fingerprint(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value)
}

export function __resetModelsInFlightForTests(): void {
  modelsInFlight.clear()
  endpointsInFlight.clear()
  workspaceEpoch = 0
  unsubscribe?.()
  unsubscribe = null
}

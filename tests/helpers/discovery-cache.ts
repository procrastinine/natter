import Dexie from 'dexie'
import { normalizeModelsResponse } from '../../src/api/providers'
import { modelsCacheKey } from '../../src/core/cache-keys'
import type { ModelsQuery, ProfileId } from '../../src/core/types'
import { getDb } from '../../src/store/db'
import { clearDiscoveryCacheProfileRows } from '../../src/store/discovery-cache-storage'
import {
  type ConnectionDiscoverySnapshot,
  connectionDiscoveryRevisionKey,
  type WorkspaceWriteAuthority,
} from '../../src/store/workspace-protocol'
import { getWorkspaceRepository } from '../../src/store/workspace-repository'
import { runWorkspaceAction } from '../../src/store/workspace-runtime'

export function putCachedModels(
  profileId: ProfileId,
  query: ModelsQuery,
  payload: unknown,
  fetchedAt = Date.now(),
): Promise<void> {
  return withDiscoverySnapshot(profileId, async (snapshot, permit) => {
    await getWorkspaceRepository().execute(permit, {
      kind: 'discovery.models.put',
      row: {
        profileId,
        profileRevision: connectionDiscoveryRevisionKey(snapshot.revision),
        queryKey: modelsCacheKey(query),
        fetchedAt,
        payload,
      },
      modelIds: normalizeModelsResponse(payload).map((model) => model.id),
      guard: { expectedProfileRevision: snapshot.revision },
    })
  })
}

export function putCachedEndpoints(
  profileId: ProfileId,
  modelId: string,
  payload: unknown,
  fetchedAt = Date.now(),
): Promise<void> {
  return withDiscoverySnapshot(profileId, async (snapshot, permit) => {
    await getWorkspaceRepository().execute(permit, {
      kind: 'discovery.endpoints.put',
      row: {
        profileId,
        profileRevision: connectionDiscoveryRevisionKey(snapshot.revision),
        modelId,
        fetchedAt,
        payload,
      },
      guard: { expectedProfileRevision: snapshot.revision },
    })
  })
}

export function putCachedPrivacyPolicy(
  profileId: ProfileId,
  modelId: string,
  payload: unknown,
  fetchedAt = Date.now(),
): Promise<void> {
  return withDiscoverySnapshot(profileId, async (snapshot, permit) => {
    await getWorkspaceRepository().execute(permit, {
      kind: 'discovery.privacy.put',
      row: {
        profileId,
        profileRevision: connectionDiscoveryRevisionKey(snapshot.revision),
        modelId,
        fetchedAt,
        payload,
      },
      guard: { expectedProfileRevision: snapshot.revision },
    })
  })
}

export function clearModelsCacheForProfile(profileId: ProfileId): Promise<void> {
  return clearDiscoveryCacheForTest('models', profileId)
}

export function clearEndpointsCacheForProfile(profileId: ProfileId): Promise<void> {
  return clearDiscoveryCacheForTest('endpoints', profileId)
}

export function clearPrivacyPoliciesForProfile(profileId: ProfileId): Promise<void> {
  return clearDiscoveryCacheForTest('privacyPolicies', profileId)
}

async function clearDiscoveryCacheForTest(
  tableName: 'models' | 'endpoints' | 'privacyPolicies',
  profileId: ProfileId,
): Promise<void> {
  const db = getDb()
  await db.transaction(
    'rw',
    [
      db.discoveryCacheState,
      db.discoveryPayloadMetadata,
      db.discoveryPayloads,
      db.endpoints,
      db.models,
      db.privacyPolicies,
    ],
    async () => {
      const tx = Dexie.currentTransaction
      await clearDiscoveryCacheProfileRows(tx, [tableName], profileId)
    },
  )
}

async function withDiscoverySnapshot(
  profileId: ProfileId,
  write: (snapshot: ConnectionDiscoverySnapshot, permit: WorkspaceWriteAuthority) => Promise<void>,
): Promise<void> {
  await runWorkspaceAction('maintenance', async (permit) => {
    const snapshot = (
      await getWorkspaceRepository().query(permit, {
        kind: 'configuration.discovery-snapshot',
        profileId,
      })
    ).value
    if (!snapshot) throw new Error(`DiscoveryProfileMissing:${profileId}`)
    await write(snapshot, permit)
  })
}

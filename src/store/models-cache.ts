// The cache key for `/models` is the normalized query signature so equivalent
// filters share a row. Endpoints are keyed by `(profileId, modelId)`. Every
// row carries `fetchedAt` for TTL checks; the caller decides the TTL since
// different surfaces tolerate different staleness.

import { modelsCacheKey } from '../core/cache-keys'
import type { ModelsQuery, ProfileId } from '../core/types'
import type { CachedEndpointsRow, CachedModelsRow } from './db-rows'
import type { WorkspaceReadAuthority, WorkspaceWriteAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceAction, runWorkspaceRead } from './workspace-runtime'

export async function getCachedModels(
  profileId: ProfileId,
  query: ModelsQuery,
  permit?: WorkspaceReadAuthority,
): Promise<CachedModelsRow | undefined> {
  const read = (authority: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(authority, {
        kind: 'discovery.models',
        profileId,
        queryKey: modelsCacheKey(query),
      })
      .then((result) => result.value)
  return permit ? read(permit) : runWorkspaceRead('repository-query', read)
}

export async function clearCachedModels(
  profileId: ProfileId,
  query: ModelsQuery,
  permit?: WorkspaceWriteAuthority,
): Promise<void> {
  const clear = (authority: WorkspaceWriteAuthority) =>
    getWorkspaceRepository().execute(authority, {
      kind: 'discovery.models.delete',
      profileId,
      queryKey: modelsCacheKey(query),
    })
  await (permit ? clear(permit) : runWorkspaceAction('cache-refresh', clear))
}

export async function getCachedEndpoints(
  profileId: ProfileId,
  modelId: string,
  permit?: WorkspaceReadAuthority,
): Promise<CachedEndpointsRow | undefined> {
  const read = (authority: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(authority, { kind: 'discovery.endpoints', profileId, modelId })
      .then((result) => result.value)
  return permit ? read(permit) : runWorkspaceRead('repository-query', read)
}

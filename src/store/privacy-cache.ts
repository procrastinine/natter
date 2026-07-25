// Scraped `data_policy` rows are keyed by `(profileId, modelId)` because the
// scrape target is the per-model providers page.

import type { ProfileId } from '../core/types'
import type { CachedPrivacyPolicyRow } from './db-rows'
import type { WorkspaceReadAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export type { CachedPrivacyPolicyRow } from './db-rows'

export async function getCachedPrivacyPolicy(
  profileId: ProfileId,
  modelId: string,
  permit?: WorkspaceReadAuthority,
): Promise<CachedPrivacyPolicyRow | undefined> {
  const read = (authority: WorkspaceReadAuthority) =>
    readCachedPrivacyPolicy(profileId, modelId, authority)
  return permit ? read(permit) : runWorkspaceRead('repository-query', read)
}

function readCachedPrivacyPolicy(
  profileId: ProfileId,
  modelId: string,
  permit: WorkspaceReadAuthority,
): Promise<CachedPrivacyPolicyRow | undefined> {
  return getWorkspaceRepository()
    .query(permit, { kind: 'discovery.privacy', profileId, modelId })
    .then((result) => result.value)
}

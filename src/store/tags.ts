import type { ChatTag, TagId } from '../core/types'
import type { WorkspaceReadAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export async function getTags(
  tagIds: readonly TagId[],
  authority?: WorkspaceReadAuthority,
): Promise<readonly ChatTag[]> {
  if (tagIds.length === 0) return Object.freeze([])
  const uniqueIds = [...new Set(tagIds)]
  const read = (permit: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'tag.get-many', tagIds: uniqueIds }, { signal: permit.signal })
      .then((envelope) =>
        Object.freeze(envelope.value.filter((tag): tag is ChatTag => tag !== undefined)),
      )
  return authority ? read(authority) : runWorkspaceRead('repository-query', read)
}

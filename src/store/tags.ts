import type { ChatTag } from '../core/types'
import type { WorkspaceReadAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export async function listTags(authority?: WorkspaceReadAuthority): Promise<ChatTag[]> {
  const read = (permit: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'tag.list' })
      .then((envelope) => envelope.value)
  return authority ? read(authority) : runWorkspaceRead('repository-query', read)
}

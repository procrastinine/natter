// Used for app-wide preferences that aren't worth a dedicated table: theme
// preference, "don't show this again" dismissals, the onboarding state, etc.
// Every write broadcasts `settings-mutated { key }` so other tabs can reload.

import type { WorkspaceReadAuthority } from './workspace-protocol'
import { getWorkspaceRepository } from './workspace-repository'
import { runWorkspaceRead } from './workspace-runtime'

export async function getSetting<T>(
  key: string,
  authority?: WorkspaceReadAuthority,
): Promise<T | undefined> {
  const read = (permit: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'setting.get', key })
      .then((envelope) => envelope.value as T | undefined)
  return authority ? read(authority) : runWorkspaceRead('repository-query', read)
}

export function getSettings(
  keys: readonly string[],
  authority?: WorkspaceReadAuthority,
): Promise<ReadonlyMap<string, unknown>> {
  const read = (permit: WorkspaceReadAuthority) =>
    getWorkspaceRepository()
      .query(permit, { kind: 'setting.get-many', keys })
      .then((envelope) => new Map(Object.entries(envelope.value)))
  return authority ? read(authority) : runWorkspaceRead('repository-query', read)
}

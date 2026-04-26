import { getBrowserRepository } from './browser-repo'
import type { WorkspaceRepository } from './repository'

let override: WorkspaceRepository | null = null

export function getWorkspaceRepository(): WorkspaceRepository {
  return override ?? getBrowserRepository()
}

export function __setWorkspaceRepositoryForTests(repo: WorkspaceRepository | null): void {
  override = repo
}

export function __resetWorkspaceRepositoryForTests(): void {
  override = null
}
